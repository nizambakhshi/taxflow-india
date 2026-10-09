// Exports — the paper that makes an export zero-rated, and the two clocks that run on it.
//
// The books already know an export happened: `supply_type` is `export` or `sez`, `determineGSTType`
// forces IGST to zero and the tax-excluded figure flows into GSTR-1 and GSTR-3B. What the books
// do **not** know is the rest — which shipping bill carried the goods, out of which port, to which
// country, under which Letter of Undertaking, whether the rupees have actually landed, and how
// many days are left to say that they have. That is the difference between a zero-rated supply and
// a *lawfully* zero-rated one: section 16 of the IGST Act zeroes the tax, and the LUT under
// Notification 44/2017-Central Tax (Rate) is what makes it zero-rated **without** paying it first.
// Every one of those facts lives outside this database, and none of them has a column, so the
// register lives on localStorage (ADR-013, `taxflow:exports:<orgId>`) beside the batch, serial,
// godown, FX and job-work registers, for the same reason they do.
//
// Five decisions carry the model:
//  * **The register stores dates and references, never a rupee it can re-read.** The FOB value, the
//    IGST paid, and the balance the customer still owes are read off the invoice every time the page
//    opens (`ExportBookInvoice`, joined by invoice number — the same key /fx uses, because the bank
//    quotes the number, not a uuid). Amending the invoice moves the export file's exposure with it.
//    The only money this file owns is the *realisation*: what the bank actually credited, which is
//    not in any table — and even that is taken from /fx first, when the deal is on the FX book.
//  * **One rupee, one home.** An invoice with an FX entry is receipted there; this register shows
//    those rupees and does not add its own on top. When both sides hold figures that disagree, the
//    view prints `sources_diverge` and names both amounts rather than summing them into a number
//    that never existed. /payments remains the only writer of invoice payments.
//  * **The realisation window is a dated rule, not a constant.** How long export proceeds may take
//    to reach India is FEMA territory, and it has moved four times in a year: nine months under the
//    Master Direction, fifteen from the November 2025 amendment, back to nine between June and
//    September 2026, and fifteen again (eighteen for rupee-denominated trade) from 1 October 2026.
//    So the period is chosen by the **date of export** from `REALISATION_BANDS`, each band carrying
//    its instrument, its link, and — where the sources disagree about the very day a rule changed —
//    a `disputed` range the page prints as a question. A file may override the window, and the
//    override is labelled as an override wherever it shows.
//  * **Two clocks, and they do not measure the same thing.** The FEMA clock asks whether the money
//    arrived; the GST clock (section 54(1), two years from the relevant date) asks whether a refund
//    of IGST *paid* was claimed in time. A LUT export has no IGST to refund, so its refund state is
//    `nothing_to_claim` — and the register says that rather than showing a deadline for a claim that
//    cannot exist. Whether unutilised ITC may be claimed instead is a rule 89 question for the CA,
//    not something a screen settles.
//  * **The missing paper is the product.** `unregisteredExports()` reads the books for export and
//    SEZ invoices that have no file here — the same "unplaced is not nowhere" rule the godown
//    register runs on — and `paper_missing` names, per consignment, which document is not recorded.
//    A register that only lists what you typed would tell you nothing you did not already know.
//
// What v1 deliberately does NOT claim: it does not file anything, and it does not compute a refund
// amount — the IGST figure is the invoice's own, and the claim is a reference to an RFD-1 raised on
// the portal. It has no customs-side validation: a shipping bill number is checked for shape, not
// against ICEGATE. Credit notes that reduce an export invoice are not netted here (the workpapers in
// /gst/gstr9 do that), and a shipping bill carrying several invoices is modelled as one file per
// invoice with the same number, which is exactly how the refund claim is filed.

import { addMonthsISO, daysBetween, parseISO } from '@/lib/recurring'
import { newId, todayISO } from '@/lib/batches'
import { round2 } from '@/lib/fx'

export { todayISO, round2 }

const KEY_EXPORTS = 'taxflow:exports:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const EXP_VERSION = 1

/** Inside this many days of the realisation window, a consignment is worth looking at. */
export const APPROACHING_DAYS = 45

/** Past due by more than a year, AD banks may restrict future exports to advance / LC only. */
export const RESTRICTED_AFTER_DAYS = 365

/** Section 54(1): a refund claim must be filed within two years of the relevant date. */
export const REFUND_WINDOW_MONTHS = 24

/** A refund window inside this many days is printed as closing. */
export const REFUND_CLOSING_DAYS = 90

const MAX_REALISATIONS = 200
const MAX_FILES = 4000

// ── The realisation window, as a dated rule ────────────────────────────────────

export interface RealisationBand {
  /** Inclusive first export date this band governs. */
  from: string
  /** Months from the date of export to realise and retain the proceeds in India. */
  months: number
  /** Months when the contract is denominated and settled in Indian rupees. `null` = no carve-out. */
  rupee_months: number | null
  /** The instrument, cited the way it would be quoted to a bank. */
  source: string
  url: string
  note: string
  /** A stretch of dates where the sources disagree about which instrument was in force. */
  disputed?: { from: string; to: string; instead_months: number; why: string }
}

/**
 * The period within which export proceeds must be realised and retained in India, as it has stood
 * on each date of export. The bands are ordered and the match is the last one whose `from` is on or
 * before the export date. Verify against rbi.org.in before relying on one — this is a cited table,
 * not a legal opinion, and where two secondary sources disagree the disagreement is kept visible
 * rather than averaged away.
 */
export const REALISATION_BANDS: RealisationBand[] = [
  {
    from: '1900-01-01',
    months: 9,
    rupee_months: null,
    source: 'Master Direction FEMA.23(R)/(E)/2015-16/RB, Regulation 9 (export of goods and services)',
    url: 'https://www.rbi.org.in/commonman/english/scripts/Notification.aspx?Id=851',
    note: 'Nine months from the date of export, extendable by the AD bank on a documented request.',
  },
  {
    from: '2025-11-13',
    months: 15,
    rupee_months: 18,
    source: 'FEMA 23(R)/(7)/2025-RB dated 13-11-2025 (amendment to the export period)',
    url: 'https://www.rbi.org.in/commonman/english/scripts/Notification.aspx?Id=851',
    note: 'Widened to fifteen months from the date of export — eighteen for rupee-denominated export contracts.',
    disputed: {
      from: '2025-11-13',
      to: '2025-11-13',
      instead_months: 9,
      why: 'The notification is dated 13-11-2025 and the sources split on whether it took effect that day or the next.',
    },
  },
  {
    from: '2026-06-05',
    months: 9,
    rupee_months: null,
    source: 'FEMA 23(R)/(8)/2026-RB dated 05-06-2026 (Export of Goods and Services) (First Amendment) Regulations, 2026',
    url: 'https://www.rbi.org.in/commonman/english/scripts/Notification.aspx?Id=851',
    note: 'Regulation 9 pulled back to nine months for consignments dispatched in this window.',
  },
  {
    from: '2026-10-01',
    months: 15,
    rupee_months: 18,
    source: 'FEMA 23(R)/(1)/2026-RB dated 22-09-2026, effective 01-10-2026',
    url: 'https://rbi.org.in/',
    note: 'Fifteen months again — eighteen where the export contract is in Indian rupees.',
  },
]

/**
 * How long goods may stay undispatched against an export advance, as it has stood on each date of
 * receipt. The same November 2025 instrument that widened the realisation window widened this one.
 */
export const ADVANCE_BANDS: RealisationBand[] = [
  {
    from: '1900-01-01',
    months: 12,
    rupee_months: null,
    source: 'Master Direction FEMA.23(R)/(E)/2015-16/RB, para on advance payments against exports',
    url: 'https://www.rbi.org.in/commonman/english/scripts/Notification.aspx?Id=851',
    note: 'Goods had to be shipped within twelve months of receiving the advance.',
  },
  {
    from: '2025-11-13',
    months: 36,
    rupee_months: null,
    source: 'FEMA 23(R)/(7)/2025-RB dated 13-11-2025',
    url: 'https://www.rbi.org.in/commonman/english/scripts/Notification.aspx?Id=851',
    note: 'Dispatch against an advance allowed up to thirty-six months from the date of receipt.',
    disputed: {
      from: '2025-11-13',
      to: '2025-11-13',
      instead_months: 12,
      why: 'Same one-day split as the realisation window.',
    },
  },
]

/** The band in force on a given date, or `null` for an empty/invalid date. */
export function bandOn(bands: RealisationBand[], date: string): RealisationBand | null {
  const d = parseISO(date)
  if (!d) return null
  const iso = `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  let hit: RealisationBand | null = null
  for (const b of bands) if (b.from <= iso) hit = b
  return hit
}

/** Does this date fall in a stretch where the instruments are read two ways? */
function disputeOf(band: RealisationBand, iso: string) {
  const d = band.disputed
  if (!d || !(d.from <= iso && iso <= d.to)) return null
  return { instead_months: d.instead_months, why: d.why }
}

function windowFrom(band: RealisationBand, iso: string, rupee: boolean, override: number, rupeeAllowed: boolean): WindowInfo {
  const statutory = rupee && rupeeAllowed && band.rupee_months !== null ? band.rupee_months : band.months
  const dispute = disputeOf(band, iso)
  return {
    months: override > 0 ? override : statutory,
    source: band.source,
    url: band.url,
    note: band.note,
    band_from: band.from,
    rupee_channel: !!(rupee && rupeeAllowed && band.rupee_months !== null),
    overridden: override > 0,
    disputed: !!dispute,
    alternative_months: dispute ? dispute.instead_months : null,
    dispute: dispute ? dispute.why : '',
  }
}

export interface WindowInfo {
  months: number
  /** Which instrument fixed that number on this date. */
  source: string
  url: string
  note: string
  band_from: string
  /** The rupee-denominated carve-out applies to this file. */
  rupee_channel: boolean
  /** True when a per-file override replaced the band table. */
  overridden: boolean
  /** True when the export date falls in a stretch the sources disagree about. */
  disputed: boolean
  /** The other figure the sources allow for the same date, when they disagree. */
  alternative_months: number | null
  dispute: string
}

/**
 * The realisation window for one consignment: the band in force on its date of export, the rupee
 * carve-out where the contract is settled in rupees, a per-file override that wins but is labelled,
 * and the disputed-day flag that turns a confident date into a printed question.
 */
export function realisationWindow(
  exportDate: string,
  opts: { rupee?: boolean; overrideMonths?: number } = {},
): WindowInfo | null {
  const band = bandOn(REALISATION_BANDS, exportDate)
  if (!band) return null
  return windowFrom(band, exportDate, !!opts.rupee, Math.trunc(Number(opts.overrideMonths) || 0), true)
}

/** The same question for an advance: how long after receiving it must the goods be dispatched. */
export function advanceWindow(advanceDate: string, overrideMonths = 0): WindowInfo | null {
  const band = bandOn(ADVANCE_BANDS, advanceDate)
  if (!band) return null
  return windowFrom(band, advanceDate, false, Math.trunc(Number(overrideMonths) || 0), false)
}

// ── How the supply was made zero-rated ─────────────────────────────────────────

export type ZeroRatingRoute = 'lut' | 'igst_paid' | 'sez' | 'unknown'

export const ROUTE_META: Record<ZeroRatingRoute, {
  label: string
  short: string
  /** Whether IGST stands paid on the invoice and therefore refundable. */
  tax_paid: boolean
  basis: string
}> = {
  lut: {
    label: 'Export under LUT — no tax paid',
    short: 'LUT',
    tax_paid: false,
    basis: 'Section 16(1)(a) IGST Act with Notification 44/2017-Central Tax (Rate) as amended: a LUT filed in Form GST RFD-11 makes the supply zero-rated without paying IGST first.',
  },
  igst_paid: {
    label: 'Export with payment of IGST, refund claimed',
    short: 'IGST paid',
    tax_paid: true,
    basis: 'Section 16(1)(b) with rule 96 of the CGST Rules: IGST is paid and refunded against the shipping bill and the evidence of realisation.',
  },
  sez: {
    label: 'Supply to a Special Economic Zone',
    short: 'SEZ',
    tax_paid: true,
    basis: 'Section 16 with rule 48: a supply to a SEZ/STU is treated as export on payment of tax, or without tax against a sanctioned undertaking from the zone operator.',
  },
  unknown: {
    label: 'Route not recorded',
    short: 'Not recorded',
    tax_paid: false,
    basis: 'The invoice is flagged as an export but the register does not know whether tax was paid — that decides which clock runs, so it is the first field worth filling in.',
  },
}

export const ROUTE_ORDER: ZeroRatingRoute[] = ['lut', 'igst_paid', 'sez', 'unknown']

export type ConsignKind = 'goods' | 'service'

export const KIND_META: Record<ConsignKind, { label: string; basis: string; paper: string }> = {
  goods: {
    label: 'Goods',
    basis: 'The date of export is the date the goods cross the frontier / leave on the conveyance — in practice the shipping bill date.',
    paper: 'A shipping bill filed through ICEGATE is the document the customs side produces; the invoice travels with it.',
  },
  service: {
    label: 'Service',
    basis: 'For an export of services there is no shipping bill. Rule 96 wants the invoice, the payment in convertible rupees, and a letter/contract establishing the foreign recipient.',
    paper: 'No shipping bill exists for a service export — the port and destination fields stay blank and the invoice is the paper.',
  },
}

export const KIND_ORDER: ConsignKind[] = ['goods', 'service']

// ── Where the file stands ──────────────────────────────────────────────────────

export type TimeState = 'no_date' | 'within' | 'approaching' | 'overdue' | 'settled' | 'settled_late' | 'restricted'

export const TIME_LABEL: Record<TimeState, string> = {
  no_date: 'Date of export unknown',
  within: 'Inside the window',
  approaching: 'Window closing',
  overdue: 'Window run out',
  settled: 'Realised in full',
  settled_late: 'Realised, but late',
  restricted: 'Past due over a year',
}

export const TIME_TONE: Record<TimeState, 'green' | 'grey' | 'blue' | 'amber' | 'red'> = {
  no_date: 'grey',
  within: 'blue',
  approaching: 'amber',
  overdue: 'red',
  settled: 'green',
  settled_late: 'amber',
  restricted: 'red',
}

export type MoneyState = 'no_book' | 'nothing' | 'partial' | 'full' | 'excess'

export const MONEY_LABEL: Record<MoneyState, string> = {
  no_book: 'Not in the books',
  nothing: 'Nothing realised',
  partial: 'Partly realised',
  full: 'Whole value in',
  excess: 'More than the invoice',
}

export type RefundState =
  | 'nothing_to_claim'
  | 'unclaimed'
  | 'closing'
  | 'lapsed'
  | 'filed'
  | 'granted'
  | 'rejected'
  | 'no_book'

export const REFUND_LABEL: Record<RefundState, string> = {
  nothing_to_claim: 'No tax paid to refund',
  unclaimed: 'Refund not yet claimed',
  closing: 'Claim window closing',
  lapsed: 'Claim window closed',
  filed: 'Claim filed',
  granted: 'Refund granted',
  rejected: 'Claim rejected',
  no_book: 'Invoice not in the books',
}

export const REFUND_TONE: Record<RefundState, 'green' | 'grey' | 'blue' | 'amber' | 'red'> = {
  nothing_to_claim: 'grey',
  unclaimed: 'blue',
  closing: 'amber',
  lapsed: 'red',
  filed: 'blue',
  granted: 'green',
  rejected: 'red',
  no_book: 'grey',
}

/** Which side of the register holds the rupees already received for this invoice. */
export type RealisationSource = 'fx' | 'here' | 'none'

export type RefundClaimStatus = 'none' | 'filed' | 'granted' | 'rejected'

export const CLAIM_META: Record<RefundClaimStatus, { label: string; note: string }> = {
  none: { label: 'No claim yet', note: 'Nothing has been filed on the portal against this consignment.' },
  filed: { label: 'RFD-1 filed', note: 'An application exists — keep its ARN here so the two papers reconcile.' },
  granted: { label: 'Refund granted', note: 'Sanctioned on the portal; the credit itself is a bank event and belongs on /payments.' },
  rejected: { label: 'Refund rejected', note: 'ASMT-10 or a rejection order exists. The two-year window does not restart.' },
}

export const CLAIM_ORDER: RefundClaimStatus[] = ['none', 'filed', 'granted', 'rejected']

// ── Convenience lists, not statutory tables ────────────────────────────────────

/**
 * Sea and air ports whose code is printed on a shipping bill. The code field is what customs uses,
 * so it is offered as a picker — but the field accepts anything, because the correct answer is the
 * code on your own shipping bill, and a wrong-but-plausible code list is worse than a typed one.
 */
export const INDIAN_PORTS = [
  { code: 'INNSA', name: 'Nhava Sheva (JNPT), Maharashtra' },
  { code: 'INMUM', name: 'Mumbai (BJNS / Bhavnge), Maharashtra' },
  { code: 'INMAA', name: 'Chennai (Minjur), Tamil Nadu' },
  { code: 'INIXM', name: 'Cochin, Kerala' },
  { code: 'INTNX', name: 'Tuticorin, Tamil Nadu' },
  { code: 'INHAL', name: 'Haldia, West Bengal' },
  { code: 'INVDK', name: 'Vizag (Waltair), Andhra Pradesh' },
  { code: 'INMUN', name: 'Mormugao (Goa)', },
  { code: 'INDEL', name: 'Indira Gandhi Airport, Delhi' },
  { code: 'INBOM', name: 'Chhatrapati Shivaji Maharaj Airport, Mumbai' },
  { code: 'INBLR', name: 'Kempegowda Airport, Bengaluru' },
  { code: 'INCCU', name: 'Netaji Subhas Airport, Kolkata' },
  { code: 'INHYI', name: 'Rajiv Gandhi Airport, Hyderabad' },
  { code: 'INCJB', name: 'Chennai Airport, Tamil Nadu' },
  { code: 'INFCA', name: 'Pune (FLG Airport / Bhosari DPE), Maharashtra' },
  { code: 'INSAH', name: 'Surat, Gujarat' },
  { code: 'INPPT', name: 'Paradip, Odisha' },
  { code: 'INKNK', name: 'Krishnapatnam, Andhra Pradesh' },
  { code: 'INDRX', name: 'Delhi — ICD Tughlakabad' },
  { code: 'INMSD', name: 'Moradabad — ICD' },
]

/** The paper's destination. A shortlist for typing speed; the field takes any country. */
export const EXPORT_DESTINATIONS = [
  'United States of America', 'United Arab Emirates', 'Saudi Arabia', 'United Kingdom',
  'Germany', 'Netherlands', 'Singapore', 'Bangladesh', 'Sri Lanka', 'Australia',
  'Canada', 'France', 'Italy', 'Spain', 'South Africa', 'Brazil', 'Mexico',
  'Japan', 'China', 'South Korea', 'Malaysia', 'Indonesia', 'Thailand', 'Vietnam',
  'Oman', 'Qatar', 'Kuwait', 'Bahrain', 'Egypt', 'Nigeria', 'Kenya', 'New Zealand',
]

export const TRANSPORT_MODES = ['sea', 'air', 'land', 'rail', 'postal_express', 'unknown']

export const MODE_LABEL: Record<string, string> = {
  sea: 'Sea',
  air: 'Air',
  land: 'Land',
  rail: 'Rail',
  postal_express: 'Postal / express courier',
  unknown: 'Not recorded',
}

// ── Stored shapes ──────────────────────────────────────────────────────────────

/** One Letter of Undertaking, filed in Form GST RFD-11 for one registration for one financial year. */
export interface LutRecord {
  id: string
  /** The 15-digit GSTIN the undertaking was filed under — a LUT belongs to a registration, not a company. */
  gstin: string
  /** '2026-27' style label, derived from `from_date` when blank. */
  financial_year: string
  from_date: string
  to_date: string
  /** The RFD-11A / acknowledgement number the portal returns. */
  reference: string
  /** The day it was actually filed — some circles read coverage as starting here, not at 1 April. */
  filed_date: string
  notes: string
  archived: boolean
  created_at: string
}

/** Rupees the bank actually credited against this consignment, as recorded on this register. */
export interface Realisation {
  id: string
  date: string
  inr: number
  /** FRC / e-BRC / UTR — whatever the bank's advice quotes. */
  reference: string
  note: string
  created_at: string
}

export interface RefundClaim {
  status: RefundClaimStatus
  /** The RFD-1 ARN raised on the portal. This register never files it. */
  claim_ref: string
  claim_date: string
  /** Grant / rejection order reference. */
  order_ref: string
  notes: string
}

export interface ExportFile {
  id: string
  /** The join to the books — the number printed on the invoice, same key /fx uses. */
  invoice_number: string
  /** 'goods' or 'service'. Decides whether a shipping bill is expected at all. */
  kind: ConsignKind
  /** Date of export. Blank means the view falls back to the shipping bill, then the invoice date. */
  export_date: string
  shipping_bill_number: string
  shipping_bill_date: string
  port_code: string
  port_name: string
  destination: string
  mode: string
  route: ZeroRatingRoute
  /** The LUT this consignment travelled under, if any. */
  lut_id: string
  /** The registration that shipped it, when it is not the org's home GSTIN. */
  gstin: string
  /** Invoice value in foreign terms / the contract currency, read from /fx — never stored. */
  currency_override: string
  /** Rupee-denominated export contract (the rupee trade channel) — changes the window. */
  rupee_contract: boolean
  /** Months. 0 = use the band in force on the date of export. Anything else is a labelled override. */
  window_months: number
  /** Advance received before dispatch. Blank = no advance recorded against this consignment. */
  advance_date: string
  /** Months against `advance_date`. 0 = band table. */
  advance_months: number
  realisations: Realisation[]
  refund: RefundClaim
  notes: string
  created_at: string
}

export interface ExpSettings {
  /** The org's own GSTIN, so a LUT list can be matched without typing it on every file. */
  home_gstin: string
  notes: string
}

export interface ExpStore {
  version: number
  updatedAt: string
  orgId: string
  luts: LutRecord[]
  files: ExportFile[]
  settings: ExpSettings
}

export function emptyExp(orgId = ''): ExpStore {
  return {
    version: EXP_VERSION,
    updatedAt: todayISO(),
    orgId,
    luts: [],
    files: [],
    settings: { home_gstin: '', notes: '' },
  }
}

export function newLut(fromDate = ''): LutRecord {
  const anchor = fromDate || todayISO()
  return {
    id: newId(),
    gstin: '',
    financial_year: fyOf(anchor),
    from_date: fyStart(anchor),
    to_date: fyEnd(anchor),
    reference: '',
    filed_date: '',
    notes: '',
    archived: false,
    created_at: new Date().toISOString(),
  }
}

export function newFile(invoiceNumber = ''): ExportFile {
  return {
    id: newId(),
    invoice_number: invoiceNumber,
    kind: 'goods',
    export_date: '',
    shipping_bill_number: '',
    shipping_bill_date: '',
    port_code: '',
    port_name: '',
    destination: '',
    mode: 'unknown',
    route: 'unknown',
    lut_id: '',
    gstin: '',
    currency_override: '',
    rupee_contract: false,
    window_months: 0,
    advance_date: '',
    advance_months: 0,
    realisations: [],
    refund: { status: 'none', claim_ref: '', claim_date: '', order_ref: '', notes: '' },
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newRealisation(inr = 0): Realisation {
  return { id: newId(), date: todayISO(), inr: Number(inr) || 0, reference: '', note: '', created_at: new Date().toISOString() }
}

/** Seed a file from a book invoice so the join is never mistyped. */
export function fileFromInvoice(inv: ExportBookInvoice, today = todayISO()): ExportFile {
  const f = newFile(inv.invoice_number)
  f.kind = inv.kind_hint || 'goods'
  f.export_date = inv.invoice_date
  f.notes = `Raised on ${today} from invoice ${inv.invoice_number}`
  return f
}

// ── Dates, FYs and the LUT calendar ───────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** A real calendar day, not twelve digits with dashes in them. */
function isDate(v: unknown): v is string {
  return parseISO(str(v)) !== null
}

function iso(d: { y: number; m: number; d: number }): string {
  return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
}

/** Indian financial year label for a date — '2026-27' for anything from 1 April 2026. */
export function fyOf(date: string): string {
  const d = parseISO(date)
  if (!d) return ''
  const y = d.m >= 4 ? d.y : d.y - 1
  return `${y}-${String(y + 1).slice(2)}`
}

export function fyStart(date: string): string {
  const d = parseISO(date)
  if (!d) return ''
  return iso({ y: d.m >= 4 ? d.y : d.y - 1, m: 4, d: 1 })
}

export function fyEnd(date: string): string {
  const d = parseISO(date)
  if (!d) return ''
  return iso({ y: d.m >= 4 ? d.y + 1 : d.y, m: 3, d: 31 })
}

/** The last day to file the LUT for the year the given date sits in. */
export function lutRenewalDeadline(date: string): string {
  const d = parseISO(date)
  if (!d) return ''
  // A date in Jan-Mar belongs to the FY that closes on 31 March of the same calendar year.
  return d.m >= 4 ? iso({ y: d.y + 1, m: 3, d: 31 }) : iso({ y: d.y, m: 3, d: 31 })
}

/** The FY the *next* LUT must cover, and the day it is due — the row the calendar shows. */
export function nextLutWindow(today: string): { financial_year: string; deadline: string; from_date: string; to_date: string } | null {
  const d = parseISO(today)
  if (!d) return null
  const startYear = d.m >= 4 ? d.y + 1 : d.y
  const fy = `${startYear}-${String(startYear + 1).slice(2)}`
  return {
    financial_year: fy,
    deadline: iso({ y: startYear, m: 3, d: 31 }),
    from_date: iso({ y: startYear, m: 4, d: 1 }),
    to_date: iso({ y: startYear + 1, m: 3, d: 31 }),
  }
}

// ── Storage ────────────────────────────────────────────────────────────────────

function readLut(v: unknown): LutRecord | null {
  const o = (v || {}) as Record<string, unknown>
  if (!o || typeof o !== 'object' || typeof o.id !== 'string') return null
  const from = isDate(o.from_date) ? o.from_date : ''
  const to = isDate(o.to_date) ? o.to_date : ''
  return {
    id: o.id,
    gstin: str(o.gstin).toUpperCase().replace(/[^0-9A-Z]/g, ''),
    financial_year: str(o.financial_year) || (from ? fyOf(from) : ''),
    from_date: from,
    to_date: to || (from ? fyEnd(from) : ''),
    reference: str(o.reference),
    filed_date: isDate(o.filed_date) ? o.filed_date : '',
    notes: str(o.notes),
    archived: !!o.archived,
    created_at: str(o.created_at) || new Date().toISOString(),
  }
}

function readRealisation(v: unknown): Realisation | null {
  const o = (v || {}) as Record<string, unknown>
  if (!o || typeof o.id !== 'string' || !isDate(o.date)) return null
  return {
    id: o.id,
    date: o.date,
    inr: round2(num(o.inr)),
    reference: str(o.reference),
    note: str(o.note),
    created_at: str(o.created_at) || new Date().toISOString(),
  }
}

function readFile(v: unknown): ExportFile | null {
  const o = (v || {}) as Record<string, unknown>
  if (!o || typeof o.id !== 'string') return null
  const invoice = str(o.invoice_number).trim()
  if (!invoice) return null
  const kind: ConsignKind = o.kind === 'service' ? 'service' : 'goods'
  const route = (ROUTE_ORDER as string[]).includes(str(o.route)) ? (o.route as ZeroRatingRoute) : 'unknown'
  const claim = (o.refund || {}) as Record<string, unknown>
  const status = (CLAIM_ORDER as string[]).includes(str(claim.status)) ? (claim.status as RefundClaimStatus) : 'none'
  return {
    id: o.id,
    invoice_number: invoice,
    kind,
    export_date: isDate(o.export_date) ? o.export_date : '',
    shipping_bill_number: str(o.shipping_bill_number).trim(),
    shipping_bill_date: isDate(o.shipping_bill_date) ? o.shipping_bill_date : '',
    port_code: str(o.port_code).toUpperCase().trim(),
    port_name: str(o.port_name).trim(),
    destination: str(o.destination).trim(),
    mode: (TRANSPORT_MODES as string[]).includes(str(o.mode)) ? str(o.mode) : 'unknown',
    route,
    lut_id: str(o.lut_id),
    gstin: str(o.gstin).toUpperCase().replace(/[^0-9A-Z]/g, ''),
    currency_override: str(o.currency_override).toUpperCase().trim(),
    rupee_contract: !!o.rupee_contract,
    window_months: Math.max(0, Math.trunc(num(o.window_months))),
    advance_date: isDate(o.advance_date) ? o.advance_date : '',
    advance_months: Math.max(0, Math.trunc(num(o.advance_months))),
    realisations: (Array.isArray(o.realisations) ? o.realisations : [])
      .map(readRealisation)
      .filter((r): r is Realisation => !!r)
      .slice(0, MAX_REALISATIONS),
    refund: {
      status,
      claim_ref: str(claim.claim_ref).trim(),
      claim_date: isDate(claim.claim_date) ? claim.claim_date : '',
      order_ref: str(claim.order_ref).trim(),
      notes: str(claim.notes),
    },
    notes: str(o.notes),
    created_at: str(o.created_at) || new Date().toISOString(),
  }
}

export function parseExp(raw: string | null): ExpStore {
  if (!raw) return emptyExp()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyExp()
  }
  const o = (parsed || {}) as Record<string, unknown>
  if (!o || typeof o !== 'object' || num(o.version) !== EXP_VERSION) {
    return emptyExp(str(o.orgId))
  }
  const settings = (o.settings || {}) as Record<string, unknown>
  const store: ExpStore = {
    version: EXP_VERSION,
    updatedAt: str(o.updatedAt) || todayISO(),
    orgId: str(o.orgId),
    luts: (Array.isArray(o.luts) ? o.luts : []).map(readLut).filter((l): l is LutRecord => !!l),
    files: (Array.isArray(o.files) ? o.files : []).map(readFile).filter((f): f is ExportFile => !!f),
    settings: {
      home_gstin: str(settings.home_gstin).toUpperCase().replace(/[^0-9A-Z]/g, ''),
      notes: str(settings.notes),
    },
  }
  return store
}

export function loadExp(orgId: string): ExpStore {
  if (typeof window === 'undefined') return emptyExp(orgId)
  try {
    const store = parseExp(window.localStorage.getItem(KEY_EXPORTS + orgId))
    if (!store.orgId) store.orgId = orgId
    return store
  } catch {
    return emptyExp(orgId)
  }
}

export function saveExp(orgId: string, store: ExpStore): void {
  if (typeof window === 'undefined') return
  const next: ExpStore = { ...store, orgId, updatedAt: todayISO() }
  try {
    window.localStorage.setItem(KEY_EXPORTS + orgId, JSON.stringify(next))
  } catch {
    /* quota — the register is a workpaper, the invoice is already safe in the books */
  }
}

// ── The books, and the FX ledger beside them ───────────────────────────────────

/** What the page selects from `invoices` — the rupee half of every row on this register. */
export interface ExportBookInvoice {
  id?: string
  invoice_number: string
  invoice_date: string
  customer_name?: string | null
  customer_gstin?: string | null
  supply_type?: string | null
  place_of_supply?: string | null
  taxable_amount?: number | string | null
  igst_amount?: number | string | null
  total_tax?: number | string | null
  grand_total?: number | string | null
  balance_due?: number | string | null
  status?: string | null
  /** Set by the page when the line items say the supply is a service (SAC 9xxxxx). */
  kind_hint?: ConsignKind | null
}

/** True for the two supply types `determineGSTType` forces to IGST-zero. */
export function isExportDoc(inv: ExportBookInvoice): boolean {
  const t = str(inv.supply_type).toLowerCase()
  return t === 'export' || t === 'sez'
}

/** The invoice fields the FX register keeps for a deal, narrowed to what this join needs. */
export interface FxDealLite {
  invoice_number: string
  currency: string
  foreign_value: number | string
  booked_inr: number | string
  receipts: { date: string; foreign?: number | string; inr: number | string; reference?: string }[]
}

export interface FxRealisation {
  has_deal: boolean
  currency: string
  foreign_value: number
  /**
   * Foreign currency still expected. `null` when the FX receipts record only rupees — subtracting a
   * rupee credit from a foreign contract value would be a made-up number, so it is left unknown.
   */
  outstanding_foreign: number | null
  /** True when the receipts carry no foreign amounts at all. */
  foreign_unmeasured: boolean
  booked_inr: number
  realised_inr: number
  last_receipt: string
  references: string[]
}

const NO_FX: FxRealisation = {
  has_deal: false, currency: '', foreign_value: 0, outstanding_foreign: null, foreign_unmeasured: true,
  booked_inr: 0, realised_inr: 0, last_receipt: '', references: [],
}

/** Sum the /fx receipts for one invoice number. Rupees are never invented from the foreign side. */
export function fxRealisation(deals: FxDealLite[], invoiceNumber: string): FxRealisation {
  const key = str(invoiceNumber).trim()
  const dealsHere = deals.filter(d => str(d.invoice_number).trim() === key)
  if (!dealsHere.length) return { ...NO_FX }
  let foreign = 0
  let foreignIn = 0
  let inr = 0
  let booked = 0
  let last = ''
  let sawForeign = false
  const refs: string[] = []
  const cur = new Set<string>()
  for (const d of dealsHere) {
    foreign += num(d.foreign_value)
    booked += num(d.booked_inr)
    if (d.currency) cur.add(str(d.currency).toUpperCase())
    for (const r of d.receipts || []) {
      inr += num(r.inr)
      const f = num(r.foreign)
      if (f > 0) { sawForeign = true; foreignIn += f }
      if (r.date && r.date > last) last = r.date
      const ref = str(r.reference).trim()
      if (ref) refs.push(ref)
    }
  }
  return {
    has_deal: true,
    currency: cur.size === 1 ? [...cur][0] : [...cur].join(' / '),
    foreign_value: round2(foreign),
    outstanding_foreign: sawForeign ? round2(Math.max(0, foreign - foreignIn)) : null,
    foreign_unmeasured: !sawForeign,
    booked_inr: round2(booked),
    realised_inr: round2(inr),
    last_receipt: last,
    references: refs,
  }
}

// ── Validation and writes ──────────────────────────────────────────────────────

/** A shipping bill number as customs writes it: 13 digits (year + 8 + check), sometimes with letters. */
export function isShippingBillNo(raw: string): boolean {
  const s = str(raw).replace(/[^0-9A-Za-z]/g, '')
  return /^\d{10,14}$/.test(s)
}

export function validateLut(lut: LutRecord, all: LutRecord[]): string[] {
  const e: string[] = []
  if (!isDate(lut.from_date)) e.push('A LUT needs the first date it covers — normally 1 April of the year.')
  if (!isDate(lut.to_date)) e.push('A LUT needs the last date it covers — normally 31 March.')
  if (isDate(lut.from_date) && isDate(lut.to_date) && lut.to_date < lut.from_date) {
    e.push('The LUT ends before it starts.')
  }
  if (isDate(lut.filed_date) && lut.filed_date > lut.to_date) {
    e.push('A LUT cannot be filed after the year it covers has closed.')
  }
  if (lut.gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(lut.gstin)) {
    e.push('The GSTIN on the LUT is not 15 characters — a LUT belongs to a registration, so it has to be exact.')
  }
  const dup = all.some(o => o.id !== lut.id && !o.archived && o.from_date === lut.from_date && o.to_date === lut.to_date
    && (o.gstin || '') === (lut.gstin || ''))
  if (dup) e.push('That registration already has a LUT for these dates.')
  return e
}

export function upsertLut(orgId: string, lut: LutRecord): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  const errors = validateLut(lut, store.luts)
  if (errors.length) return { ok: false, error: errors[0], store }
  const idx = store.luts.findIndex(l => l.id === lut.id)
  const clean: LutRecord = { ...lut, financial_year: lut.financial_year || fyOf(lut.from_date) }
  if (idx >= 0) store.luts[idx] = clean
  else store.luts.unshift(clean)
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

/** A LUT with consignment rows hanging on it is never deleted — it is archived, and the rows say so. */
export function deleteLut(orgId: string, id: string): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  const used = store.files.filter(f => f.lut_id === id)
  if (used.length) {
    return {
      ok: false,
      error: `${used.length} export ${used.length === 1 ? 'file names' : 'files name'} this LUT. Archive it instead — the paper still covered those consignments.`,
      store,
    }
  }
  store.luts = store.luts.filter(l => l.id !== id)
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

export function archiveLut(orgId: string, id: string, archived = true): ExpStore {
  const store = loadExp(orgId)
  store.luts = store.luts.map(l => (l.id === id ? { ...l, archived } : l))
  saveExp(orgId, store)
  return store
}

export function validateFile(file: ExportFile, store: ExpStore, books: ExportBookInvoice[], today = todayISO()): string[] {
  const e: string[] = []
  if (!file.invoice_number.trim()) e.push('An export file has to name the invoice it belongs to — that is the join.')
  if (!(KIND_ORDER as string[]).includes(file.kind)) e.push('Say whether this is a supply of goods or of services.')
  if (!(ROUTE_ORDER as string[]).includes(file.route)) e.push('Pick how the supply was made zero-rated.')

  for (const [label, d] of [['Date of export', file.export_date], ['Shipping bill date', file.shipping_bill_date], ['Advance received', file.advance_date]] as const) {
    if (d && !isDate(d)) e.push(`${label} is not a real calendar day.`)
    if (d && isDate(d) && d > today) e.push(`${label} is in the future — the goods have not left yet.`)
  }

  const book = books.find(b => str(b.invoice_number).trim() === file.invoice_number.trim())
  if (book && isDate(book.invoice_date) && isDate(file.shipping_bill_date) && file.shipping_bill_date < book.invoice_date) {
    // A shipping bill is filed *against* an invoice that already exists; the reverse order means one
    // of the two dates is wrong, and a wrong date silently moves the whole FEMA window.
    e.push(`The shipping bill (${file.shipping_bill_date}) predates invoice ${book.invoice_number} (${book.invoice_date}). The invoice is filed first, then the bill.`)
  }
  if (file.kind === 'goods' && book && isDate(book.invoice_date) && isDate(file.export_date) && file.export_date < book.invoice_date) {
    // Rule 47 wants the invoice raised on or before the day the goods are removed. A date of export
    // that predates the invoice is therefore either a typo or an invoice raised late — and it moves
    // the whole FEMA window, so it is refused here rather than smoothed over.
    e.push(`The date of export (${file.export_date}) is before invoice ${book.invoice_number} (${book.invoice_date}). Rule 47 wants the invoice on or before the day the goods leave — check which of the two dates is wrong.`)
  }
  if (file.kind === 'goods' && file.shipping_bill_number && !isShippingBillNo(file.shipping_bill_number)) {
    e.push('A shipping bill number is the 10-14 digit number ICEGATE returns — check it against the bill.')
  }
  if (file.kind === 'service' && file.shipping_bill_number) {
    e.push('A service export has no shipping bill. Leave the number blank and keep the invoice as the paper.')
  }
  if (file.route === 'lut' && file.lut_id) {
    const lut = store.luts.find(l => l.id === file.lut_id)
    if (!lut) e.push('The LUT named here is not on this register.')
    else if (isDate(file.export_date) && !(lut.from_date <= file.export_date && file.export_date <= lut.to_date)) {
      e.push(`The LUT you named covers ${lut.from_date} to ${lut.to_date}, not ${file.export_date}. Naming a LUT is saying it covered the shipment.`)
    }
  }
  if (file.window_months < 0 || file.window_months > 60) {
    e.push('An overridden window has to sit between 1 and 60 months, or 0 to use the cited band.')
  }
  if (file.advance_months < 0 || file.advance_months > 120) {
    e.push('An overridden advance window has to sit between 1 and 120 months, or 0 to use the cited band.')
  }
  if (file.advance_date && !file.export_date && !file.shipping_bill_date && !book) {
    e.push('An advance needs a dispatch date: fill in the date of export or the shipping bill, or link the invoice.')
  }
  if (isDate(file.advance_date) && isDate(file.export_date) && file.export_date < file.advance_date) {
    e.push('The goods left before the advance was received — at least one of those two dates is wrong.')
  }

  const seen = new Set<string>()
  for (const r of file.realisations) {
    if (!isDate(r.date)) e.push('A realisation needs a real date — the day the bank credited it.')
    else if (r.date > today) e.push('A realisation cannot be dated in the future.')
    if (!(r.inr > 0)) e.push('Every realisation needs a rupee amount above zero.')
    if (seen.has(r.id)) e.push('Two realisations on this file share an id.')
    seen.add(r.id)
  }
  if (file.realisations.length > MAX_REALISATIONS) e.push(`A file may carry up to ${MAX_REALISATIONS} realisations.`)

  const claim = file.refund
  if (!(CLAIM_ORDER as string[]).includes(claim.status)) e.push('Pick the state of the refund claim.')
  if (claim.status !== 'none' && !claim.claim_ref.trim()) {
    e.push('A claim that has been filed needs its RFD-1 ARN — the register keeps the reference, never the filing.')
  }
  if (isDate(claim.claim_date) && claim.claim_date > today) e.push('A refund claim cannot be dated in the future.')
  const rel = relevantDate(file, books)
  if (isDate(claim.claim_date) && rel && claim.claim_date < rel) {
    e.push(`The claim (${claim.claim_date}) predates the relevant date (${rel}) — the window had not opened yet.`)
  }
  const outer = isDate(rel) ? addMonthsISO(rel, REFUND_WINDOW_MONTHS) : ''
  if (outer && isDate(claim.claim_date) && claim.claim_date > outer) {
    e.push(`Section 54(1) allows ${REFUND_WINDOW_MONTHS} months from the relevant date (${rel}); ${claim.claim_date} is outside it. Record the claim as rejected rather than dating it past the window.`)
  }
  if ((claim.status === 'granted' || claim.status === 'rejected') && !claim.order_ref.trim()) {
    e.push('A granted or rejected claim needs the order reference — that is the number you would quote on a follow-up.')
  }
  return e
}

/**
 * The date the section 54(1) refund clock starts on. For goods that is the date of export — the
 * goods crossing the frontier / leaving on the conveyance; for services the earlier of the invoice
 * and the payment, and the invoice date is the figure this register can see. Cited, not adjudicated:
 * the relevant-date table in s.54(1) has its own nuances per class of supply.
 */
export function relevantDate(file: ExportFile, books: ExportBookInvoice[] = []): string {
  if (file.kind === 'goods') {
    if (isDate(file.export_date)) return file.export_date
    if (isDate(file.shipping_bill_date)) return file.shipping_bill_date
  }
  const book = books.find(b => str(b.invoice_number).trim() === file.invoice_number.trim())
  if (book && isDate(book.invoice_date)) return book.invoice_date
  if (isDate(file.export_date)) return file.export_date
  if (isDate(file.shipping_bill_date)) return file.shipping_bill_date
  return ''
}

/** The date the FEMA clock runs from, and which date it fell back on. */
export function exportDateOf(file: ExportFile, books: ExportBookInvoice[]): { date: string; from: 'file' | 'shipping_bill' | 'invoice' | 'none' } {
  if (isDate(file.export_date)) return { date: file.export_date, from: 'file' }
  if (isDate(file.shipping_bill_date)) return { date: file.shipping_bill_date, from: 'shipping_bill' }
  const book = books.find(b => str(b.invoice_number).trim() === file.invoice_number.trim())
  if (book && isDate(book.invoice_date)) return { date: book.invoice_date, from: 'invoice' }
  return { date: '', from: 'none' }
}

export function recordFile(orgId: string, file: ExportFile, books: ExportBookInvoice[] = []): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  const errors = validateFile(file, store, books)
  if (errors.length) return { ok: false, error: errors[0], store }
  const idx = store.files.findIndex(f => f.id === file.id)
  if (idx >= 0) store.files[idx] = file
  else {
    if (store.files.length >= MAX_FILES) return { ok: false, error: `This register holds ${MAX_FILES} files; clear archived years before adding more.`, store }
    store.files.unshift(file)
  }
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

/**
 * Deleting a file is allowed — it is a register of paper, not a ledger — but the rupees recorded on
 * it go with it, so the caller is expected to have said so. The invoice itself is untouched.
 */
export function deleteFile(orgId: string, id: string): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  store.files = store.files.filter(f => f.id !== id)
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

export function addRealisation(orgId: string, fileId: string, r: Realisation): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  const file = store.files.find(f => f.id === fileId)
  if (!file) return { ok: false, error: 'That export file is not on this register.', store }
  if (!isDate(r.date)) return { ok: false, error: 'A realisation needs the date the bank credited the rupees.', store }
  if (!(r.inr > 0)) return { ok: false, error: 'A realisation needs a rupee amount above zero.', store }
  const today = todayISO()
  if (r.date > today) return { ok: false, error: 'A realisation cannot be dated in the future.', store }
  if (file.realisations.length >= MAX_REALISATIONS) return { ok: false, error: `A file may carry up to ${MAX_REALISATIONS} realisations.`, store }
  file.realisations = [...file.realisations, { ...r, id: r.id || newId(), inr: round2(r.inr), created_at: r.created_at || new Date().toISOString() }]
    .sort((a, b) => a.date.localeCompare(b.date))
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

export function removeRealisation(orgId: string, fileId: string, realisationId: string): ExpStore {
  const store = loadExp(orgId)
  store.files = store.files.map(f => (f.id === fileId
    ? { ...f, realisations: f.realisations.filter(r => r.id !== realisationId) }
    : f))
  saveExp(orgId, store)
  return store
}

export function setRefund(
  orgId: string,
  fileId: string,
  claim: RefundClaim,
  books: ExportBookInvoice[] = [],
): { ok: boolean; error: string; store: ExpStore } {
  const store = loadExp(orgId)
  const file = store.files.find(f => f.id === fileId)
  if (!file) return { ok: false, error: 'That export file is not on this register.', store }
  const patched = { ...file, refund: claim }
  const errors = validateFile(patched, store, books)
  if (errors.length) return { ok: false, error: errors[0], store }
  file.refund = claim
  saveExp(orgId, store)
  return { ok: true, error: '', store }
}

export function setHomeGstin(orgId: string, gstin: string): ExpStore {
  const store = loadExp(orgId)
  store.settings.home_gstin = str(gstin).toUpperCase().replace(/[^0-9A-Z]/g, '')
  saveExp(orgId, store)
  return store
}

// ── Which LUT covers a date ────────────────────────────────────────────────────

/** The LUT in force for a registration on a date. `gstin` blank falls back to the register's home GSTIN. */
export function lutFor(luts: LutRecord[], date: string, gstin = '', home = ''): LutRecord | null {
  if (!isDate(date)) return null
  const who = str(gstin) || str(home)
  const live = luts.filter(l => !l.archived)
  const exact = live.filter(l => (who ? l.gstin === who : true))
  const pool = exact.length ? exact : live
  return pool.find(l => l.from_date && l.to_date && l.from_date <= date && date <= l.to_date) || null
}

// ── The view ───────────────────────────────────────────────────────────────────

export interface PaperGap {
  label: string
  /** What the document is called on the paper that has to exist. */
  document: string
  why: string
}

export interface RefundView {
  state: RefundState
  label: string
  /** The section 54(1) outer date, and how far off it is. */
  deadline: string
  days_left: number | null
  relevant_date: string
  /** The rupee figure the invoice itself says was paid — re-read, never stored. */
  igst_paid: number
  basis: string
}

export interface AdvanceView {
  received: string
  due_date: string
  days_left: number | null
  window: WindowInfo
  dispatched: boolean
  late: boolean
}

export interface ExportView {
  file: ExportFile
  book: ExportBookInvoice | null
  unmatched: boolean
  party: string
  kind: ConsignKind
  route: ZeroRatingRoute
  export_date: string
  date_from: 'file' | 'shipping_bill' | 'invoice' | 'none'
  lut: LutRecord | null
  /** The file names a LUT and it covers the date. */
  lut_named: boolean
  /** The route claims a LUT but no covering undertaking is on the register. */
  lut_gap: boolean
  /** A LUT exists but was filed after the shipment left — coverage of that stretch is a live reading. */
  filed_late: boolean
  window: WindowInfo | null
  due_date: string | null
  days_to_due: number | null
  past_due_days: number
  restricted: boolean
  fx: FxRealisation
  realised_fx: number
  realised_here: number
  /** The rupees counted — from one home only, never the sum of both. */
  realised: number
  realisation_source: RealisationSource
  sources_diverge: boolean
  invoice_value: number
  taxable_value: number
  igst_paid: number
  ledger_balance: number | null
  outstanding: number
  received_pct: number
  money_state: MoneyState
  time_state: TimeState
  paper_missing: PaperGap[]
  refund: RefundView
  advance: AdvanceView | null
  needs_attention: boolean
  attention: string[]
}

const EPS = 0.5

function moneyState(value: number, realised: number, unmatched: boolean): MoneyState {
  if (unmatched) return 'no_book'
  if (value <= 0) return realised > 0 ? 'excess' : 'no_book'
  if (realised <= 0) return 'nothing'
  if (realised > value + EPS) return 'excess'
  if (realised >= value - EPS) return 'full'
  return 'partial'
}

function timeState(
  due: string | null,
  today: string,
  money: MoneyState,
  lastMoneyDate: string,
): TimeState {
  if (!due) return 'no_date'
  const d = daysBetween(today, due)
  if (d === null) return 'no_date'
  if (money === 'full' || money === 'excess') {
    // Lateness is proved by the day the money actually landed, never by the day the register is read.
    // A consignment that paid up on time stays "settled" for the rest of its life, and a settled one
    // with no receipt date cannot be called late on suspicion alone.
    if (!lastMoneyDate) return 'settled'
    return lastMoneyDate > due ? 'settled_late' : 'settled'
  }
  if (d < 0 && -d > RESTRICTED_AFTER_DAYS) return 'restricted'
  if (d < 0) return 'overdue'
  if (d <= APPROACHING_DAYS) return 'approaching'
  return 'within'
}

function refundView(file: ExportFile, rel: string, igst: number, unmatched: boolean, today: string): RefundView {
  // A refund is a refund of tax that was actually paid, so the invoice's own IGST figure is the authority:
  // a SEZ supply cleared without paying IGST has nothing to claim, whatever the route claims. When there is
  // no invoice to read the row answers `no_book` below — the register will not run a clock on a guess.
  const paid = igst > 0
  const basis = 'Section 54(1): a refund claim has to be filed within two years of the relevant date. For goods the register takes the date of export; for services, the invoice date.'
  const claim = file.refund
  const deadline = rel ? addMonthsISO(rel, REFUND_WINDOW_MONTHS) : ''
  const days = deadline ? daysBetween(today, deadline) : null

  if (claim.status === 'granted') return { state: 'granted', label: REFUND_LABEL.granted, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  if (claim.status === 'rejected') return { state: 'rejected', label: REFUND_LABEL.rejected, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  if (claim.status === 'filed') return { state: 'filed', label: REFUND_LABEL.filed, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  if (unmatched) return { state: 'no_book', label: REFUND_LABEL.no_book, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  if (!paid) {
    return {
      state: 'nothing_to_claim',
      label: REFUND_LABEL.nothing_to_claim,
      deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis,
    }
  }
  if (!rel) return { state: 'unclaimed', label: REFUND_LABEL.unclaimed, deadline: '', days_left: null, relevant_date: '', igst_paid: igst, basis }
  if (days !== null && days < 0) return { state: 'lapsed', label: REFUND_LABEL.lapsed, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  if (days !== null && days <= REFUND_CLOSING_DAYS) return { state: 'closing', label: REFUND_LABEL.closing, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
  return { state: 'unclaimed', label: REFUND_LABEL.unclaimed, deadline, days_left: days, relevant_date: rel, igst_paid: igst, basis }
}

function advanceViewOf(file: ExportFile, today: string = todayISO()): AdvanceView | null {
  if (!isDate(file.advance_date)) return null
  const window = advanceWindow(file.advance_date, file.advance_months)
  if (!window) return null
  const due = addMonthsISO(file.advance_date, window.months)
  const exportDate = file.export_date || file.shipping_bill_date
  // Late either way: the goods went out after the window, or they have still not gone out and the
  // window has closed. A dispatch that never happened is the louder of the two.
  const late = exportDate ? exportDate > due : due < today
  return {
    received: file.advance_date,
    due_date: due,
    days_left: daysBetween(today, due),
    window,
    dispatched: !!exportDate,
    late,
  }
}

/**
 * The documents the law expects behind this consignment, and which of them this register has seen.
 * This is the answer the page leads with: not what you recorded, but what you have not.
 */
export function paperGaps(file: ExportFile, view: {
  kind: ConsignKind
  book: ExportBookInvoice | null
  lut: LutRecord | null
  lutGap: boolean
  hasRealisation: boolean
  hasFx: boolean
}): PaperGap[] {
  const gaps: PaperGap[] = []
  if (file.route === 'unknown') {
    gaps.push({
      label: 'How the supply was made zero-rated',
      document: 'The LUT acknowledgement, or the invoice showing IGST paid',
      why: 'Whether IGST was paid decides whether there is a refund to claim at all — the register cannot run the right clock without it.',
    })
  }
  if (file.kind === 'goods' && !file.shipping_bill_number) {
    gaps.push({
      label: 'Shipping bill number',
      document: 'Shipping bill filed through ICEGATE',
      why: 'The refund claim, the customs side of the audit and the date of export all hang on this number.',
    })
  }
  if (file.kind === 'goods' && !file.shipping_bill_date) {
    gaps.push({
      label: 'Shipping bill date',
      document: 'Shipping bill',
      why: 'Where the date of export is not recorded, this is the date the FEMA window starts on.',
    })
  }
  if (file.kind === 'goods' && !file.port_code && !file.port_name) {
    gaps.push({
      label: 'Port / ICD of lading',
      document: 'Shipping bill, and the e-way bill that carried the goods there',
      why: 'Customs records the place of exit; GSTR-1 export rows are checked against it.',
    })
  }
  if (!file.destination) {
    gaps.push({
      label: 'Country of destination',
      document: 'Shipping bill / the foreign recipient contract',
      why: 'Zero-rating depends on the supply leaving India to a recipient outside India.',
    })
  }
  if (file.route === 'lut' && view.lutGap) {
    gaps.push({
      label: 'Letter of Undertaking',
      document: 'Form GST RFD-11 acknowledgement (RFD-11A) for the financial year',
      why: 'Without a LUT in force for the year the goods left, the supply is not zero-rated without payment — IGST becomes payable and refundable under rule 96.',
    })
  }
  if (file.route === 'igst_paid' && file.refund.status === 'none') {
    gaps.push({
      label: 'Refund claim',
      document: 'Form GST RFD-1 with the shipping bill and realisation evidence',
      why: 'Tax paid on a zero-rated supply is recoverable, but only inside the section 54(1) two-year window.',
    })
  }
  if (!view.hasRealisation && !view.hasFx) {
    gaps.push({
      label: 'Evidence of realisation',
      document: 'FIRC / e-BRC, or the bank credit advice',
      why: 'Rule 96 wants proof the proceeds reached India in convertible rupees; under FEMA the same evidence is what closes the window.',
    })
  }
  return gaps
}

export function buildView(
  file: ExportFile,
  store: ExpStore,
  books: ExportBookInvoice[],
  deals: FxDealLite[],
  today: string = todayISO(),
): ExportView {
  const key = str(file.invoice_number).trim()
  const book = books.find(b => str(b.invoice_number).trim() === key) || null
  const unmatched = !book
  const { date: expDate, from: dateFrom } = exportDateOf(file, books)
  const fx = fxRealisation(deals, key)
  const here = round2(file.realisations.reduce((s, r) => s + num(r.inr), 0))
  const realisedFx = fx.has_deal ? fx.realised_inr : 0
  // One home for the rupees: when the FX book holds the deal, its receipts are the figure of record.
  const source: RealisationSource = fx.has_deal ? 'fx' : here > 0 ? 'here' : 'none'
  const realised = fx.has_deal ? realisedFx : here
  const sources_diverge = fx.has_deal && here > 0 && Math.abs(realisedFx - here) > EPS
  const value = book ? round2(num(book.grand_total)) : 0
  const taxable = book ? round2(num(book.taxable_amount)) : 0
  const igst = book ? round2(num(book.igst_amount)) : 0
  const ledgerBalance = book && book.balance_due !== undefined && book.balance_due !== null
    ? round2(num(book.balance_due))
    : null

  const window = expDate ? realisationWindow(expDate, { rupee: file.rupee_contract, overrideMonths: file.window_months }) : null
  const due = expDate && window ? addMonthsISO(expDate, window.months) : null
  const days = due ? daysBetween(today, due) : null
  const pastDueDays = days !== null && days < 0 ? -days : 0

  const home = store.settings.home_gstin
  const who = file.gstin || home
  const lut = file.lut_id ? (store.luts.find(l => l.id === file.lut_id) || null) : lutFor(store.luts, expDate, who, home)
  const lut_named = !!file.lut_id && !!lut
  // An archived undertaking is the trader saying the paper is no longer live. A file that still rests on
  // one has to answer for it, so the gap stays open — the row keeps the LUT for the reference it prints.
  const lut_gap = file.route === 'lut' && (!lut || lut.archived)
  const filed_late = !!lut && !!lut.filed_date && !!expDate && lut.filed_date > expDate

  const money = moneyState(value, realised, unmatched)
  // The day the last counted rupee landed, from whichever home the counted rupees came from.
  const lastMoneyDate = source === 'fx'
    ? str(fx.last_receipt)
    : file.realisations.reduce((max, r) => (r.date > max ? r.date : max), '')
  const time = timeState(due, today, money, lastMoneyDate)
  const rel = relevantDate(file, books)
  const refund = refundView(file, rel, igst, unmatched, today)
  const advance = advanceViewOf(file, today)

  const view = { kind: file.kind, book, lut, lutGap: lut_gap, hasRealisation: file.realisations.length > 0, hasFx: fx.has_deal }
  const paper_missing = paperGaps(file, view)

  const attention: string[] = []
  if (unmatched) attention.push(`No invoice numbered ${key} in the books — the figures here are the paper's, not the ledger's.`)
  if (lut_gap) attention.push('Exported on a LUT this register cannot match to the date of export.')
  if (filed_late && lut) attention.push(`The LUT was filed on ${lut.filed_date}, after the goods left — check whether it covered the shipment from 1 April or from filing.`)
  if (time === 'restricted') attention.push(`Proceeds are ${pastDueDays} days late — the AD bank may restrict future exports to advance payment or an irrevocable LC.`)
  if (time === 'overdue') attention.push(`Realisation window ran out ${pastDueDays} days ago.`)
  if (time === 'settled_late') {
    const lateBy = daysBetween(due ?? today, lastMoneyDate)
    attention.push(`Money arrived ${lateBy === null || lateBy < 0 ? '' : `${lateBy} days `}after the window closed.`)
  }
  if (sources_diverge) attention.push('The FX ledger and this file both hold realisations, and they disagree — one rupee, counted once.')
  if (money === 'excess' && !unmatched) attention.push('Rupees realised exceed the invoice value: check for a duplicate or a claim that belongs to another consignment.')
  if (refund.state === 'lapsed') attention.push('The section 54(1) two-year window on this refund has closed.')
  if (refund.state === 'closing') attention.push('The refund window closes inside 90 days.')
  if (advance?.late) {
    const shipped = file.export_date || file.shipping_bill_date
    const lateBy = shipped ? daysBetween(advance.due_date, shipped) : daysBetween(advance.due_date, today)
    const tail = lateBy === null ? '' : ` ${lateBy} day${lateBy === 1 ? '' : 's'} past it.`
    attention.push(shipped
      ? `Goods against the advance of ${advance.received} left on ${shipped}, after the dispatch window closed on ${advance.due_date}.${tail}`
      : `An advance was received on ${advance.received} and nothing has been dispatched: the ${advance.window.months}-month window closed on ${advance.due_date}.${tail}`)
  }
  if (ledgerBalance !== null && ledgerBalance > 0 && (money === 'full' || money === 'excess')) {
    attention.push(`Realisation says the money is in; the ledger still shows ₹${Math.round(ledgerBalance).toLocaleString('en-IN')} outstanding — /payments is the only writer of that figure.`)
  }
  if (paper_missing.length && !attention.length) {
    attention.push(`Missing paper: ${paper_missing.map(g => g.label).join(', ')}.`)
  }

  return {
    file,
    book,
    unmatched,
    party: book ? str(book.customer_name) : '',
    kind: file.kind,
    route: file.route,
    export_date: expDate,
    date_from: dateFrom,
    lut,
    lut_named,
    lut_gap,
    filed_late,
    window,
    due_date: due,
    days_to_due: days,
    past_due_days: pastDueDays,
    restricted: time === 'restricted',
    fx,
    realised_fx: realisedFx,
    realised_here: here,
    realised,
    realisation_source: source,
    sources_diverge,
    invoice_value: value,
    taxable_value: taxable,
    igst_paid: igst,
    ledger_balance: ledgerBalance,
    outstanding: (money === 'full' || money === 'excess')
      ? 0 // a paisa-tolerant match is reported as nothing owing — a settled row cannot also be short
      : round2(Math.max(0, value - realised)),
    received_pct: value > 0 ? Math.min(999, Math.round((realised / value) * 100)) : 0,
    money_state: money,
    time_state: time,
    paper_missing,
    refund,
    advance,
    needs_attention: attention.length > 0,
    attention,
  }
}

export function exportViews(
  store: ExpStore,
  books: ExportBookInvoice[] = [],
  deals: FxDealLite[] = [],
  today: string = todayISO(),
): ExportView[] {
  return store.files.map(f => buildView(f, store, books, deals, today))
}

export type ExportSort = 'export_date' | 'due' | 'value' | 'outstanding' | 'attention' | 'invoice'

export const SORTS: { value: ExportSort; label: string }[] = [
  { value: 'export_date', label: 'Date of export' },
  { value: 'due', label: 'Days to the window' },
  { value: 'value', label: 'Invoice value' },
  { value: 'outstanding', label: 'Still to realise' },
  { value: 'attention', label: 'Most urgent' },
  { value: 'invoice', label: 'Invoice number' },
]

const ATTENTION_RANK: Record<TimeState, number> = {
  restricted: 0, overdue: 1, settled_late: 2, approaching: 3, no_date: 4, within: 5, settled: 6,
}

export function sortViews(list: ExportView[], sort: ExportSort): ExportView[] {
  const out = [...list]
  if (sort === 'export_date') out.sort((a, b) => b.export_date.localeCompare(a.export_date) || a.file.invoice_number.localeCompare(b.file.invoice_number))
  else if (sort === 'due') out.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))
  else if (sort === 'value') out.sort((a, b) => b.invoice_value - a.invoice_value)
  else if (sort === 'outstanding') out.sort((a, b) => b.outstanding - a.outstanding)
  else if (sort === 'invoice') out.sort((a, b) => a.file.invoice_number.localeCompare(b.file.invoice_number))
  else {
    out.sort((a, b) => {
      const rank = ATTENTION_RANK[a.time_state] - ATTENTION_RANK[b.time_state]
      if (rank) return rank
      const paper = b.paper_missing.length - a.paper_missing.length
      if (paper) return paper
      return b.outstanding - a.outstanding
    })
  }
  return out
}

// ── The books' own exports, and which of them have no paper here ───────────────

/**
 * Export and SEZ invoices in the books that this register has never heard of. The godown register's
 * rule, applied to paperwork: an unrecorded export is not a non-export, and the return is going to
 * be filed from the invoice whether the shipping bill is written down here or not.
 */
export function unregisteredExports(books: ExportBookInvoice[], files: ExportFile[]): ExportBookInvoice[] {
  const known = new Set(files.map(f => str(f.invoice_number).trim()))
  return books.filter(b => isExportDoc(b) && !known.has(str(b.invoice_number).trim()))
}

// ── Summary and rollups ────────────────────────────────────────────────────────

export interface CountryRollup {
  destination: string
  files: number
  value: number
  outstanding: number
  overdue: number
}

export interface ExportSummary {
  files: number
  /** Export invoices in the books with no file on this register. */
  unpapered: number
  value: number
  igst_paid: number
  igst_claimable: number
  realised: number
  outstanding: number
  within: number
  approaching: number
  overdue: number
  restricted: number
  settled_late: number
  no_date: number
  lut_gap: number
  filed_late: number
  paper_short: number
  refunds_open: number
  refunds_closing: number
  refunds_lapsed: number
  refunds_filed: number
  unmatched: number
  divergent: number
  ledger_clash: number
  advance_late: number
  needs_attention: number
  by_country: CountryRollup[]
  by_fy: { financial_year: string; files: number; value: number; outstanding: number }[]
}

export function summarise(views: ExportView[], unpapered: number = 0): ExportSummary {
  const s: ExportSummary = {
    files: views.length, unpapered,
    value: 0, igst_paid: 0, igst_claimable: 0, realised: 0, outstanding: 0,
    within: 0, approaching: 0, overdue: 0, restricted: 0, settled_late: 0, no_date: 0,
    lut_gap: 0, filed_late: 0, paper_short: 0,
    refunds_open: 0, refunds_closing: 0, refunds_lapsed: 0, refunds_filed: 0,
    unmatched: 0, divergent: 0, ledger_clash: 0, advance_late: 0, needs_attention: 0,
    by_country: [], by_fy: [],
  }
  const countries = new Map<string, CountryRollup>()
  const fys = new Map<string, { files: number; value: number; outstanding: number }>()

  for (const v of views) {
    s.value += v.invoice_value
    s.igst_paid += v.igst_paid
    s.realised += v.realised
    s.outstanding += v.outstanding
    if (v.refund.state === 'unclaimed' || v.refund.state === 'closing') s.igst_claimable += v.igst_paid
    switch (v.time_state) {
      case 'within': s.within++; break
      case 'approaching': s.approaching++; break
      case 'overdue': s.overdue++; break
      case 'restricted': s.restricted++; break
      case 'settled_late': s.settled_late++; break
      case 'no_date': s.no_date++; break
      default: break
    }
    if (v.lut_gap) s.lut_gap++
    if (v.filed_late) s.filed_late++
    if (v.paper_missing.length) s.paper_short++
    if (v.unmatched) s.unmatched++
    if (v.sources_diverge) s.divergent++
    if (v.ledger_balance !== null && v.ledger_balance > 0 && (v.money_state === 'full' || v.money_state === 'excess')) s.ledger_clash++
    if (v.advance?.late) s.advance_late++
    if (v.needs_attention) s.needs_attention++
    if (v.refund.state === 'unclaimed') s.refunds_open++
    if (v.refund.state === 'closing') s.refunds_closing++
    if (v.refund.state === 'lapsed') s.refunds_lapsed++
    if (v.refund.state === 'filed' || v.refund.state === 'granted') s.refunds_filed++

    const key = v.file.destination || '(not recorded)'
    const c = countries.get(key) || { destination: key, files: 0, value: 0, outstanding: 0, overdue: 0 }
    c.files++
    c.value += v.invoice_value
    c.outstanding += v.outstanding
    if (v.time_state === 'overdue' || v.time_state === 'restricted') c.overdue++
    countries.set(key, c)

    const fy = v.export_date ? fyOf(v.export_date) : '(no date)'
    const f = fys.get(fy) || { files: 0, value: 0, outstanding: 0 }
    f.files++
    f.value += v.invoice_value
    f.outstanding += v.outstanding
    fys.set(fy, f)
  }

  s.value = round2(s.value)
  s.igst_paid = round2(s.igst_paid)
  s.igst_claimable = round2(s.igst_claimable)
  s.realised = round2(s.realised)
  s.outstanding = round2(s.outstanding)
  s.by_country = [...countries.values()].sort((a, b) => b.value - a.value)
  s.by_fy = [...fys.entries()]
    .map(([financial_year, v]) => ({ financial_year, ...v, value: round2(v.value), outstanding: round2(v.outstanding) }))
    .sort((a, b) => b.financial_year.localeCompare(a.financial_year))
  return s
}

// ── The watch list, which is also what feeds the compliance calendar ───────────

export interface WatchRow {
  id: string
  date: string
  /** How late the row is allowed to get before it turns red. */
  label: string
  form: string
  kind: 'lut' | 'realisation' | 'refund' | 'advance'
  party: string
  ref: string
  tone: 'green' | 'grey' | 'blue' | 'amber' | 'red'
  detail: string
  href: string
}

/**
 * Every date on this register that a human has to act on: next year's LUT, each consignment's
 * realisation window, each refund window, and each advance waiting to be dispatched.
 * The calendar page reads this rather than inventing its own dates, so the two can never disagree.
 */
export function watchRows(
  store: ExpStore,
  books: ExportBookInvoice[] = [],
  deals: FxDealLite[] = [],
  today: string = todayISO(),
): WatchRow[] {
  const rows: WatchRow[] = []
  const views = exportViews(store, books, deals, today)

  const next = nextLutWindow(today)
  if (next) {
    const home = store.settings.home_gstin
    const has = store.luts.some(l => !l.archived && l.from_date === next.from_date && (!home || !l.gstin || l.gstin === home))
    rows.push({
      id: `lut-${next.financial_year}`,
      date: next.deadline,
      label: has ? `LUT for ${next.financial_year} is on file` : `File the LUT for ${next.financial_year}`,
      form: 'GST RFD-11',
      kind: 'lut',
      party: home,
      ref: has ? (store.luts.find(l => l.from_date === next.from_date)?.reference || '') : '',
      tone: has ? 'green' : 'amber',
      detail: has
        ? 'A LUT covers 1 April to 31 March, and each registration needs its own.'
        : 'A zero-rated export without a LUT in force means IGST is payable first and refunded later.',
      href: '/gst/exports',
    })
  }

  for (const v of views) {
    if (v.due_date && v.money_state !== 'full' && v.money_state !== 'excess') {
      const d = daysBetween(today, v.due_date)
      const late = d !== null && d < 0
      rows.push({
        id: `real-${v.file.id}`,
        date: v.due_date,
        label: `${v.file.invoice_number} — export proceeds due${v.party ? ` (${v.party})` : ''}`,
        form: 'FIRA / e-BRC',
        kind: 'realisation',
        party: v.party,
        ref: v.file.shipping_bill_number,
        tone: late ? 'red' : d !== null && d <= APPROACHING_DAYS ? 'amber' : 'blue',
        detail: late
          ? `Out ${v.window ? v.window.months : '?'} months after the export on ${v.export_date}. ${v.window?.source || ''}`
          : `${v.window ? v.window.months : '?'} months from the date of export. ${v.window?.source || ''}`,
        href: '/gst/exports',
      })
    }
    if (v.refund.deadline && (v.refund.state === 'unclaimed' || v.refund.state === 'closing')) {
      const d = daysBetween(today, v.refund.deadline)
      rows.push({
        id: `refund-${v.file.id}`,
        date: v.refund.deadline,
        label: `Refund of IGST on ${v.file.invoice_number}`,
        form: 'GST RFD-1',
        kind: 'refund',
        party: v.party,
        ref: v.file.shipping_bill_number,
        tone: d !== null && d < 0 ? 'red' : d !== null && d <= REFUND_CLOSING_DAYS ? 'amber' : 'blue',
        detail: `Two years from the relevant date ${v.refund.relevant_date}; ₹${Math.round(v.igst_paid).toLocaleString('en-IN')} of IGST stands paid on the invoice.`,
        href: '/gst/exports',
      })
    }
    if (v.advance && (!v.advance.dispatched || v.advance.late)) {
      const d = v.advance.days_left
      // Undispatched: the deadline is ahead and the row says "ship". Already dispatched outside the
      // window: the breach is closed but not settled — the AD bank still has to be asked to condone it,
      // so the date stays on the calendar rather than being quietly dropped from it.
      rows.push({
        id: `advance-${v.file.id}`,
        date: v.advance.due_date,
        label: v.advance.dispatched
          ? `Condone the late dispatch against the advance on ${v.file.invoice_number}`
          : `Dispatch goods against the advance on ${v.file.invoice_number}`,
        form: 'Shipping bill',
        kind: 'advance',
        party: v.party,
        ref: v.file.shipping_bill_number,
        tone: d !== null && d < 0 ? 'red' : d !== null && d <= APPROACHING_DAYS ? 'amber' : 'blue',
        detail: v.advance.dispatched
          ? `Advance received ${v.advance.received}; goods left ${v.export_date}; the ${v.advance.window.months}-month dispatch window closed on ${v.advance.due_date}. ${v.advance.window.source}`
          : `Advance received ${v.advance.received}; ${v.advance.window.months} months allowed to ship. ${v.advance.window.source}`,
        href: '/gst/exports',
      })
    }
  }

  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

// ── CSV ────────────────────────────────────────────────────────────────────────

export const EXPORT_REGISTER_CSV_HEADERS = [
  'Invoice', 'Invoice date', 'Party', 'Kind', 'Route', 'Date of export', 'Date taken from',
  'Shipping bill no.', 'Shipping bill date', 'Port code', 'Port', 'Destination', 'Mode',
  'LUT FY', 'LUT ref', 'Window months', 'Window basis', 'Override', 'Disputed window',
  'Proceeds due', 'Days to due', 'Invoice value', 'Realised', 'Realisation from', 'Outstanding',
  'Money state', 'Time state', 'Missing paper', 'Refund state', 'Refund deadline', 'Notes',
]

export function registerCsvRows(views: ExportView[]): (string | number)[][] {
  return views.map(v => [
    v.file.invoice_number,
    v.book ? str(v.book.invoice_date) : '',
    v.party,
    KIND_META[v.kind].label,
    ROUTE_META[v.route].short,
    v.export_date,
    v.date_from === 'none' ? 'not recorded' : v.date_from,
    v.file.shipping_bill_number,
    v.file.shipping_bill_date,
    v.file.port_code,
    v.file.port_name,
    v.file.destination,
    MODE_LABEL[v.file.mode] || v.file.mode,
    v.lut ? v.lut.financial_year : '',
    v.lut ? v.lut.reference : '',
    v.window ? v.window.months : '',
    v.window ? v.window.source : 'no date of export',
    v.window?.overridden ? 'overridden on the file' : '',
    v.window?.disputed ? `sources differ — could be ${v.window.alternative_months} months: ${v.window.dispute}` : '',
    v.due_date || '',
    v.days_to_due === null ? '' : v.days_to_due,
    v.invoice_value,
    v.realised,
    v.realisation_source === 'fx' ? '/fx ledger' : v.realisation_source === 'here' ? 'recorded here' : 'nothing received',
    v.outstanding,
    MONEY_LABEL[v.money_state],
    TIME_LABEL[v.time_state],
    v.paper_missing.map(g => g.label).join('; '),
    v.refund.label,
    v.refund.deadline,
    v.file.notes,
  ])
}

/** The list the GSTR-1 export rows are transcribed from. */
export const SHIPPING_BILL_CSV_HEADERS = [
  'Invoice', 'Invoice date', 'Taxable value', 'IGST paid', 'Shipping bill no.', 'Shipping bill date',
  'Port code', 'Destination', 'Kind', 'Route', 'LUT no.', 'LUT FY', 'Party', 'Party GSTIN',
]

export function shippingBillCsvRows(views: ExportView[]): (string | number)[][] {
  return views.map(v => [
    v.file.invoice_number,
    v.book ? str(v.book.invoice_date) : '',
    v.taxable_value,
    v.igst_paid,
    v.file.shipping_bill_number,
    v.file.shipping_bill_date,
    v.file.port_code,
    v.file.destination,
    KIND_META[v.kind].label,
    ROUTE_META[v.route].short,
    v.lut ? v.lut.reference : '',
    v.lut ? v.lut.financial_year : '',
    v.party,
    v.book ? str(v.book.customer_gstin) : '',
  ])
}

/** The realisation statement a bank or a FIRC file asks for — one row per receipt, one per file. */
export const REALISATION_CSV_HEADERS = [
  'Invoice', 'Date of export', 'Proceeds due', 'Party', 'Shipping bill no.', 'Currency',
  'Foreign value', 'FX rupees booked', 'Realised (FX ledger)', 'Realised (recorded here)',
  'Counted', 'Receipt date', 'Receipt reference', 'FIRC/e-BRC note',
]

export function realisationCsvRows(views: ExportView[]): (string | number)[][] {
  const rows: (string | number)[][] = []
  for (const v of views) {
    const head: (string | number)[] = [
      v.file.invoice_number, v.export_date, v.due_date || '', v.party, v.file.shipping_bill_number,
      v.fx.currency, v.fx.foreign_value, v.fx.booked_inr, v.realised_fx, v.realised_here, v.realised, '', '',
      v.file.notes || '',
    ]
    if (!v.file.realisations.length) { rows.push(head); continue }
    for (const r of v.file.realisations) {
      rows.push(head.slice(0, 11).concat([r.date, r.reference, r.note || v.file.notes || '']))
    }
  }
  return rows
}

/** Deadlines only — the sheet a filing calendar is built from. */
export const WATCH_CSV_HEADERS = ['Date', 'What is due', 'Form / paper', 'Kind', 'Party', 'Invoice or bill', 'State', 'Basis']

export function watchCsvRows(rows: WatchRow[]): (string | number)[][] {
  return rows.map(r => [r.date, r.label, r.form, r.kind, r.party, r.ref, r.tone, r.detail])
}

export const LUT_CSV_HEADERS = ['Financial year', 'GSTIN', 'Valid from', 'Valid to', 'RFD-11A reference', 'Filed on', 'Status', 'Note']

export function lutCsvRows(luts: LutRecord[]): (string | number)[][] {
  return luts.map(l => [
    l.financial_year || fyOf(l.from_date), l.gstin, l.from_date, l.to_date, l.reference,
    l.filed_date, l.archived ? 'archived' : 'live', l.notes,
  ])
}
