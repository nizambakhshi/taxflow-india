/* TDS and 194Q workpaper — R2-11.
 *
 * A business that buys goods or services usually has to withhold a slice of the
 * payment as tax, deposit it against the supplier's PAN, and report it quarterly.
 * Incumbent software either ignores this (billing apps) or needs the whole
 * accounting suite and a paid bank feed (the ERPs). Here it is derived from the
 * purchase bills already in the books.
 *
 * What this is honest about:
 * - It is a workpaper. Nothing is deducted, deposited or filed. It says which
 *   section a bill probably falls under, what the withholding comes to once the
 *   threshold is crossed, when the money was due, and what the delay costs.
 * - The rate table below is the owner's starting opinion, not certified law. The
 *   Income Tax Act, 2025 renumbered these provisions with effect from 1 April 2026
 *   (194Q is now cited as section 393(1)), the familiar 194-series labels are kept
 *   because that is what TRACES, challans and every CA still use. Every rate, limit
 *   and note is printed on the page so it can be checked line by line; what you
 *   choose is which section each supplier falls under.
 * - Whether a bill is goods, a service or a contract is not in the data — a purchase
 *   bill has no expense category — so the supplier is tagged once and a single bill
 *   can override that. Untagged value is reported as untagged, never guessed at.
 */

import { fyLabel, fyMonths, monthLabel, monthOf } from '@/lib/targets'

/* ── sections ───────────────────────────────────────────────────────────── */

export type SectionId =
  | 'NONE' | '194C' | '194H' | '194I_LAND' | '194I_PLANT' | '194J_PRO' | '194J_TECH'
  | '194Q' | '194M' | '194A' | '194R'

export type ThresholdMode = 'whole' | 'excess'

export interface Section {
  id: SectionId
  label: string
  /** What kind of spend this is, shown next to the tag so the choice is not a guess. */
  covers: string
  /** Percent of the base. For 194C this is the non-individual payer rate. */
  rate: number
  /** Applied when the payer is an individual or HUF, if it differs. */
  individualRate?: number
  /** Percent when the supplier gave no PAN. */
  noPanRate: number
  /** Aggregate per supplier per FY, in rupees, below which nothing is withheld. */
  threshold: number
  /** A single bill above this is taxable whatever the aggregate says (194C). */
  singleBillLimit?: number
  /**
   * 'whole' — the bill that crosses the limit is taxed in full, and so is every
   *   later bill (the position taken for contracts, rent, fees and commission).
   * 'excess' — only the amount above the limit (what 194Q and 194M explicitly say).
   */
  mode: ThresholdMode
  /** Deposit form this section is reported on. */
  form: '26Q' | '24Q'
  note: string
}

export const SECTIONS: Section[] = [
  {
    id: '194C', label: '194C · Contract', covers: 'work, construction, transport, service contracts',
    rate: 2, individualRate: 1, noPanRate: 20, threshold: 1_00_000, singleBillLimit: 30_000,
    mode: 'whole', form: '26Q',
    note: 'A single bill over ₹30,000, or a supplier crossing ₹1,00,000 in the year, brings the contract within the section. Individual and HUF payers withhold at 1%, and from FY 2025-26 their aggregate limit is ₹50,00,000.',
  },
  {
    id: '194H', label: '194H · Commission', covers: 'commission or brokerage',
    rate: 5, noPanRate: 20, threshold: 20_000, mode: 'whole', form: '26Q',
    note: 'Any commission or brokerage paid in the year, on the whole amount once ₹20,000 is crossed.',
  },
  {
    id: '194I_LAND', label: '194I · Rent, land or building', covers: 'godown, shop, office, machinery premises rent',
    rate: 2, noPanRate: 20, threshold: 2_40_000, mode: 'whole', form: '26Q',
    note: 'Rent for land, building or both, on the amount above ₹2,40,000 paid or credited in the year.',
  },
  {
    id: '194I_PLANT', label: '194I · Rent, plant or machinery', covers: 'equipment and vehicle hire',
    rate: 1, noPanRate: 20, threshold: 2_40_000, mode: 'whole', form: '26Q',
    note: 'Higher threshold, lower rate — machinery hire is easy to miss on a freight or equipment bill.',
  },
  {
    id: '194J_PRO', label: '194J · Professional fees', covers: 'doctor, CA, lawyer, consultant, auditor',
    rate: 10, noPanRate: 10, threshold: 50_000, mode: 'whole', form: '26Q',
    note: 'Professional or medical fees above ₹50,000 in the year. The engineer and technical services rate is 2%.',
  },
  {
    id: '194J_TECH', label: '194J · Technical services', covers: 'engineering, consultancy with technical know-how',
    rate: 2, noPanRate: 10, threshold: 50_000, mode: 'whole', form: '26Q',
    note: 'Fees for technical services, including management and technical consultancy, at 2%.',
  },
  {
    id: '194Q', label: '194Q · Purchase of goods', covers: 'trading stock, raw material, spares',
    rate: 0.1, noPanRate: 2, threshold: 50_00_000, mode: 'excess', form: '26Q',
    note: 'Buying goods from one supplier beyond ₹50,00,000 in the year, GST excluded. Only the amount above the limit is withheld, at 0.1% (2% with no PAN), and only if that sum is not already under 194C, 194H, 194J or 194R, or covered by TCS under 206C(1H). Since 1 April 2026 the Income Tax Act, 2025 cites this as section 393(1).',
  },
  {
    id: '194M', label: '194M · Contract or e-commerce (individual/HUF)', covers: 'a proprietor paying a contractor or a platform',
    rate: 5, noPanRate: 5, threshold: 50_00_000, mode: 'whole', form: '26Q',
    note: 'For a payer who is an individual or HUF not liable to audit: contracts, joint venture and e-commerce above ₹50,00,000 at 5%.',
  },
  {
    id: '194A', label: '194A · Interest', covers: 'interest other than securities',
    rate: 10, noPanRate: 20, threshold: 10_000, mode: 'whole', form: '26Q',
    note: 'Interest paid to a supplier or lender, most often on a loan from a director. The limit is ₹50,000 for senior citizens.',
  },
  {
    id: '194R', label: '194R · Perquisites or benefits', covers: 'free travel, gifts, benefits to a dealer or agent',
    rate: 10, noPanRate: 10, threshold: 50_000, mode: 'whole', form: '26Q',
    note: 'The value of any benefit or perquisite, whether converted to money, above ₹50,000 in the year.',
  },
  {
    id: 'NONE', label: 'No TDS', covers: 'nothing to withhold on this supplier',
    rate: 0, noPanRate: 0, threshold: Infinity, mode: 'whole', form: '26Q',
    note: 'For a registered supplier who is not liable to deduct, a small bill, or a payment the section does not reach. Say so here instead of leaving the supplier untagged.',
  },
]

export function sectionOf(id: SectionId): Section {
  const s = SECTIONS.find(x => x.id === id)
  return s ?? SECTIONS[SECTIONS.length - 1]
}

/** What an individual/HUF payer sees: 194C drops to 1% and its limit rises. */
export function effectiveRate(s: Section, payerType: PayerType): number {
  if (s.id === '194C' && payerType === 'individual') return s.individualRate ?? s.rate
  return s.rate
}

export function effectiveThreshold(s: Section, payerType: PayerType): number {
  if (s.id === '194C' && payerType === 'individual') return 50_00_000
  return s.threshold
}

export function noPanRateOf(s: Section): number {
  return s.noPanRate
}

/* ── the two kinds of money this reads ──────────────────────────────────── */

export interface TdsBill {
  id: string
  billNumber: string
  /** 'YYYY-MM-DD' — the date the cost was booked. */
  billDate: string
  vendorId: string
  vendorName: string
  gstin: string
  /** Taxable value, GST excluded. This is the base TDS is charged on. */
  taxable: number
  /** GST charged separately on the bill, if the supplier itemised it. */
  gst: number
  grandTotal: number
  balanceDue: number
}

export interface TdsPayment {
  billId: string
  /** 'YYYY-MM-DD' */
  date: string
  amount: number
}

export interface TdsVendor {
  id: string
  name: string
  pan: string
  gstin: string
}

/* ── stored opinions ────────────────────────────────────────────────────── */

export type PayerType = 'individual' | 'business'

export interface Challan {
  bsr: string
  challanNumber: string
  /** 'YYYY-MM-DD' the deposit was actually made. */
  depositDate: string
  /** Amount paid in; may differ from what the workpaper says was due. */
  amount: number
}

/**
 * The day the shop says a quarter's statement went in — a transcript, not proof. The portal is
 * elsewhere, exactly as it is for the GST filings' *challan the department holds*: what this row
 * keeps is the shop's own day, and the page prints whose date it is reading.
 */
export interface StatementFiling {
  /** 'YYYY-MM-DD' the statement went in, as the shop states it. */
  filedOn: string
  /** The acknowledgement number the shop writes down — printed beside the date, never parsed. */
  reference: string
}

export interface TdsState {
  version: number
  updatedAt: string
  payerType: PayerType
  /** section id by supplier key — a supplier is normally one kind of spend. */
  vendorSection: Record<string, SectionId>
  /** section id by bill id — a supplier who is also a landlord. */
  billSection: Record<string, SectionId>
  /** deposits recorded against a month, keyed 'YYYY-MM'. */
  challans: Record<string, Challan>
  /**
   * A quarter's statement filing, keyed by that quarter's due date ('YYYY-MM-DD') because the
   * due date is the one string that names a quarter without a fiscal year's arithmetic.
   * R3-25's field: a register written before this round loads with none, and its quarters read
   * to today exactly as they read the round before — the same field-added-by-reading shape as
   * `paid_on` on the filings register (R3-24) and the seal's photograph (R3-21).
   */
  statementFilings: Record<string, StatementFiling>
}

export const TDS_VERSION = 1
const STATE_KEY = 'taxflow:tds:'

export function emptyTds(): TdsState {
  return { version: TDS_VERSION, updatedAt: '', payerType: 'business', vendorSection: {}, billSection: {}, challans: {}, statementFilings: {} }
}

/** Bills may be typed without picking a supplier row, so fall back to the name. */
export function vendorKey(bill: Pick<TdsBill, 'vendorId' | 'vendorName'>): string {
  return bill.vendorId || `name:${bill.vendorName.trim().toLowerCase()}`
}

export function loadTds(orgId: string): TdsState {
  const base = emptyTds()
  try {
    const raw = localStorage.getItem(STATE_KEY + orgId)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<TdsState>
    return {
      version: TDS_VERSION,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      payerType: parsed.payerType === 'individual' ? 'individual' : 'business',
      vendorSection: asMap(parsed.vendorSection),
      billSection: asMap(parsed.billSection),
      challans: asChallans(parsed.challans),
      statementFilings: asStatementFilings(parsed.statementFilings),
    }
  } catch {
    return base
  }
}

function asMap(v: unknown): Record<string, SectionId> {
  const out: Record<string, SectionId> = {}
  if (!v || typeof v !== 'object') return out
  const known = new Set<string>(SECTIONS.map(s => s.id))
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string' && known.has(val)) out[k] = val as SectionId
  }
  return out
}

function asChallans(v: unknown): Record<string, Challan> {
  const out: Record<string, Challan> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const c = val as Partial<Challan>
    if (!c || typeof c.depositDate !== 'string') continue
    out[k] = {
      bsr: typeof c.bsr === 'string' ? c.bsr : '',
      challanNumber: typeof c.challanNumber === 'string' ? c.challanNumber : '',
      depositDate: c.depositDate,
      amount: Number(c.amount) || 0,
    }
  }
  return out
}

/**
 * A filing row is kept only where its date is a date. A damaged entry is *unreadable*, not a
 * clock stopped on a string that is no day: the quarter falls back to reading to today and
 * prints its ceiling, rather than printing a fee measured to "soon" (Rule 27).
 */
function asStatementFilings(v: unknown): Record<string, StatementFiling> {
  const out: Record<string, StatementFiling> = {}
  if (!v || typeof v !== 'object') return out
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const f = val as Partial<StatementFiling>
    if (!f || typeof f.filedOn !== 'string' || !parseDate(f.filedOn)) continue
    out[k] = { filedOn: f.filedOn, reference: typeof f.reference === 'string' ? f.reference : '' }
  }
  return out
}

export function saveTds(orgId: string, state: TdsState): TdsState {
  const stamped = { ...state, updatedAt: new Date().toISOString() }
  try {
    localStorage.setItem(STATE_KEY + orgId, JSON.stringify(stamped))
  } catch {
    // A full quota must not break the screen; the workpaper is reconstructible.
  }
  return stamped
}

export function setVendorSection(state: TdsState, key: string, section: SectionId): TdsState {
  const next = { ...state.vendorSection }
  if (section === 'NONE') next[key] = 'NONE'
  else next[key] = section
  return { ...state, vendorSection: next }
}

export function setBillSection(state: TdsState, billId: string, section: SectionId): TdsState {
  const next = { ...state.billSection }
  if (section === 'NONE') delete next[billId]
  else next[billId] = section
  return { ...state, billSection: next }
}

export function setChallan(state: TdsState, month: string, challan: Challan | null): TdsState {
  const next = { ...state.challans }
  if (!challan || !challan.depositDate) delete next[month]
  else next[month] = challan
  return { ...state, challans: next }
}

/**
 * A statement with no filing date is not a filing: the empty string the composer sends when the
 * shop takes the day back clears the row, and the quarter's clock runs to today again. An entry
 * is saved only when its day parses — the read guard and the write guard say the same thing.
 */
export function setStatementFiling(state: TdsState, due: string, filing: StatementFiling | null): TdsState {
  const next = { ...state.statementFilings }
  if (!filing || !filing.filedOn || !parseDate(filing.filedOn)) delete next[due]
  else next[due] = { filedOn: filing.filedOn, reference: filing.reference.trim() }
  return { ...state, statementFilings: next }
}

/**
 * What the composer refuses, in sentences. The portal is still invisible — a filing here is the
 * shop's word and the page says so — but the date must at least be a date, must not be a day that
 * has not arrived, and cannot precede the quarter it reports, because the statement describes days
 * that must have happened first.
 */
export function validateStatementFiling(periodTo: string, filedOn: string, today: string): string[] {
  const problems: string[] = []
  if (!filedOn) return problems
  const d = parseDate(filedOn)
  if (!d) {
    problems.push('The day this statement was filed must be a date.')
    return problems
  }
  if (today && filedOn > today) {
    problems.push(`A statement cannot have gone in on ${filedOn} — that day has not come yet.`)
  }
  if (periodTo && filedOn < periodTo) {
    problems.push(`The quarter this statement reports closes on ${periodTo}; a filing dated ${filedOn} would describe days that had not happened.`)
  }
  return problems
}

/* ── the workpaper ──────────────────────────────────────────────────────── */

export interface DeductionRow {
  billId: string
  billNumber: string
  billDate: string
  vendorKey: string
  vendorName: string
  pan: string
  /** Why the withholding was skipped: an untagged supplier or a section below its limit. */
  section: SectionId
  sectionLabel: string
  /** The bill value TDS is charged on: taxable where GST is itemised, else the total. */
  base: number
  /** The part of this bill the tax is charged on (whole bill, or the slice above the limit). */
  chargeable: number
  rate: number
  tax: number
  /** The earlier of credit and payment drives both the threshold order and the due date. */
  eventDate: string
  eventLabel: string
  /** 'YYYY-MM' the withholding belongs to. */
  month: string
  depositDue: string
  /** Cumulative value for this supplier in this section, in the year, before this bill. */
  priorValue: number
  note: string
}

export interface MonthDue {
  month: string
  label: string
  tax: number
  due: string
  rows: number
  challan: Challan | null
  status: 'not-yet-due' | 'pending' | 'deposited' | 'late' | 'short'
  /** Months or part months past the due date, counted as the section counts them. */
  monthsLate: number
  interest: number
  /** What the deposit was short by, when the challan covers less than the workpaper says. */
  shortfall: number
}

export interface VendorSummary {
  key: string
  name: string
  pan: string
  panSource: 'pan' | 'gstin' | 'none'
  section: SectionId
  bills: number
  /** Value billed in the year, on the TDS base. */
  value: number
  chargeable: number
  tax: number
  threshold: number
  /** Rupees still available before the section bites. */
  headroom: number
  /** Only for 194Q/194M-style limits: the month the supplier is expected to cross. */
  projectedCrossMonth: string | null
  tagged: boolean
}

export interface TdsWorkpaper {
  fyLabel: string
  rows: DeductionRow[]
  months: MonthDue[]
  vendors: VendorSummary[]
  totals: {
    bills: number
    value: number
    /** Value of bills whose supplier has no section chosen yet. */
    untaggedValue: number
    untaggedBills: number
    chargeable: number
    tax: number
    deposited: number
    toDeposit: number
    overdue: number
    interest: number
    statementFee: number
    /**
     * The part of `statementFee` that is a ceiling — quarters past their due date with no filing
     * day on them, read to today. The rest is exact, measured to a date the register holds; an
     * empty year of statements, or a fully dated one, prints this as zero and no sentence.
     */
    statementFeeCeiling: number
  }
  /** The four quarterly 26Q dates and what a late filing costs at each. */
  statements: QuarterlyStatement[]
}

export interface QuarterlyStatement {
  label: string
  quarter: string
  due: string
  periodFrom: string
  periodTo: string
  tax: number
  /**
   * Days from the due date to the day the register holds, or to today while a fee clock runs.
   * A filing day after the due date is counted even when no tax was withheld: the lateness is a
   * fact of the transcript, while the fee below is the narrower reading that needs tax.
   */
  daysLate: number
  fee: number
  /** The day the shop says this statement went in — the register's only stop date. */
  filedOn: string
  /** The acknowledgement the row holds beside that day; printed, never parsed. */
  reference: string
  /** True when the days and the fee were measured to a date this register holds. */
  stopped: boolean
  /** True when the quarter is late with no filing day on it: the fee is a ceiling, and says so. */
  ceiling: boolean
  /**
   * True when the fee has reached the cap the law puts on it — the tax involved —
   * so another late day adds nothing. A ceiling can be bounded; the page must not call it growing.
   */
  capped: boolean
  /** ₹200 a day under section 427 (234E of the 1961 Act) while the clock runs; the labelled nil once it stops or reaches the cap (Rule 27). */
  perDay: number
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '')
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * A deduction on this bill is payable against the 7th of the following month;
 * March's deductions have until the last working day of April, which the rules
 * draw at the 30th.
 */
export function depositDue(month: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(month)
  if (!m) return ''
  const year = Number(m[1])
  const mon = Number(m[2])
  if (mon === 3) return `${year}-04-30`
  const next = new Date(year, mon, 1)
  return ymd(new Date(next.getFullYear(), next.getMonth(), 7))
}

function monthsLate(from: string, to: string): number {
  const a = parseDate(from)
  const b = parseDate(to)
  if (!a || !b || b <= a) return 0
  // "for every month or part of a month" — a day over counts as a month.
  const whole = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth())
  const anniversary = new Date(a.getFullYear(), a.getMonth() + whole, a.getDate())
  return b > anniversary ? whole + 1 : whole
}

/** PAN from the supplier record, else the ten characters of a GSTIN that are the PAN. */
export function panOf(vendor: Pick<TdsVendor, 'pan' | 'gstin'> | undefined, gstinOnBill: string): { pan: string; source: 'pan' | 'gstin' | 'none' } {
  const pan = (vendor?.pan || '').trim().toUpperCase()
  if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) return { pan, source: 'pan' }
  const fromGstin = (vendor?.gstin || gstinOnBill || '').trim().toUpperCase()
  if (/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]/.test(fromGstin)) return { pan: fromGstin.slice(2, 12), source: 'gstin' }
  return { pan: '', source: 'none' }
}

/** The value TDS is charged on. GST carved out of the base when it is shown apart. */
export function tdsBase(bill: TdsBill): number {
  const taxable = Math.max(0, bill.taxable)
  if (taxable > 0 && bill.gst > 0) return roundRupee(taxable)
  return roundRupee(bill.grandTotal || bill.taxable + bill.gst)
}

function roundRupee(n: number): number {
  return Math.round(n)
}

/**
 * The whole workpaper. `bills` must already be narrowed to the financial year and
 * to active documents; `payments` are the receipts made against those bills.
 */
export function buildWorkpaper(
  bills: TdsBill[],
  payments: TdsPayment[],
  vendors: TdsVendor[],
  state: TdsState,
  fyStart: number,
  asOf: Date = new Date(),
): TdsWorkpaper {
  const vendorById = new Map(vendors.map(v => [v.id, v] as const))
  const monthsOfFy = fyMonths(fyStart)
  const paidByBill = new Map<string, TdsPayment[]>()
  for (const p of payments) {
    if (!p.billId) continue
    const list = paidByBill.get(p.billId) || []
    list.push(p)
    paidByBill.set(p.billId, list)
  }

  const usable = bills
    .filter(b => monthsOfFy.includes(monthOf(b.billDate)))
    .map(b => ({
      bill: b,
      base: tdsBase(b),
      section: state.billSection[b.id] || state.vendorSection[vendorKey(b)] || null,
    }))
    .filter(x => x.base > 0)

  // Section, then supplier, then the order the year happened in.
  const ordered = [...usable].sort((a, b) => {
    const sa = a.section || '', sb = b.section || ''
    if (sa !== sb) return sa < sb ? -1 : 1
    const va = vendorKey(a.bill), vb = vendorKey(b.bill)
    if (va !== vb) return va < vb ? -1 : 1
    return a.bill.billDate < b.bill.billDate ? -1 : a.bill.billDate > b.bill.billDate ? 1 : 0
  })

  const running = new Map<string, { value: number; crossed: boolean }>()
  const rows: DeductionRow[] = []
  const perVendor = new Map<string, { value: number; chargeable: number; tax: number; bills: number; section: SectionId; untagged: number; untaggedBills: number; chosen: boolean }>()

  for (const item of ordered) {
    const { bill, base } = item
    const key = vendorKey(bill)
    const sectionId = item.section
    const pan = panOf(vendorById.get(bill.vendorId), bill.gstin)
    const agg = perVendor.get(key) || { value: 0, chargeable: 0, tax: 0, bills: 0, section: 'NONE' as SectionId, untagged: 0, untaggedBills: 0, chosen: false }
    agg.value += base
    agg.bills += 1
    if (sectionId) { agg.section = sectionId; agg.chosen = true } else { agg.untagged += base; agg.untaggedBills += 1 }
    perVendor.set(key, agg)

    if (!sectionId) continue
    const section = sectionOf(sectionId)
    if (sectionId === 'NONE') continue

    const runKey = `${key}|${sectionId}`
    const prior = running.get(runKey) || { value: 0, crossed: false }
    const threshold = effectiveThreshold(section, state.payerType)
    const rate = (pan.source === 'none' && section.id !== '194M') ? noPanRateOf(section) : effectiveRate(section, state.payerType)

    // The earlier of credit and payment: a bill paid before it was entered is
    // taxable from the payment date.
    const pays = (paidByBill.get(bill.id) || []).filter(p => p.date && p.amount > 0)
    const earliestPay = pays.length ? pays.map(p => p.date).sort()[0] : ''
    const viaPayment = !!earliestPay && earliestPay < bill.billDate
    const eventDate = viaPayment ? earliestPay : bill.billDate
    const month = monthOf(eventDate) || monthOf(bill.billDate)

    let chargeable = 0
    let note = ''
    if (section.mode === 'excess') {
      const after = prior.value + base
      chargeable = after > threshold ? Math.max(base - Math.max(0, threshold - prior.value), 0) : 0
      if (chargeable > 0 && prior.value < threshold) {
        note = `₹${(threshold - prior.value).toLocaleString('en-IN')} of this bill is still below the ₹${threshold.toLocaleString('en-IN')} limit`
      }
    } else {
      const single = section.singleBillLimit && base > section.singleBillLimit
      const crossed = prior.crossed || prior.value + base > threshold
      if (single || crossed) {
        chargeable = base
        note = single && prior.value + base <= threshold
          ? `single bill above ₹${(section.singleBillLimit || 0).toLocaleString('en-IN')}`
          : prior.crossed ? 'limit already crossed for this supplier' : 'limit crossed by this bill'
      } else {
        note = `₹${(threshold - prior.value - base).toLocaleString('en-IN')} below the annual limit`
      }
    }

    running.set(runKey, { value: prior.value + base, crossed: prior.crossed || chargeable > 0 })
    agg.chargeable += chargeable

    const tax = chargeable > 0 ? roundRupee(chargeable * rate / 100) : 0
    agg.tax += tax
    if (tax <= 0) continue

    rows.push({
      billId: bill.id,
      billNumber: bill.billNumber,
      billDate: bill.billDate,
      vendorKey: key,
      vendorName: bill.vendorName,
      pan: pan.pan,
      section: sectionId,
      sectionLabel: section.label,
      base,
      chargeable,
      rate,
      tax,
      eventDate,
      eventLabel: viaPayment ? 'paid before it was booked — payment date governs' : 'credited on the bill date',
      month,
      depositDue: depositDue(month),
      priorValue: prior.value,
      note,
    })
  }

  /* monthly deposits */
  const byMonth = new Map<string, { tax: number; rows: number }>()
  for (const r of rows) {
    const m = byMonth.get(r.month) || { tax: 0, rows: 0 }
    m.tax += r.tax
    m.rows += 1
    byMonth.set(r.month, m)
  }
  const months: MonthDue[] = fyMonths(fyStart).filter(m => byMonth.has(m)).map(m => {
    const entry = byMonth.get(m)!
    const challan = state.challans[m] || null
    const due = depositDue(m)
    const dueDate = parseDate(due)
    const notYetDue = !!dueDate && dueDate > asOf
    const lateMonths = challan
      ? monthsLate(due, challan.depositDate)
      : notYetDue ? 0 : monthsLate(due, ymd(asOf))
    const shortfall = challan ? Math.max(entry.tax - challan.amount, 0) : entry.tax
    let status: MonthDue['status'] = 'pending'
    if (challan && shortfall > 1) status = 'short'
    else if (challan && lateMonths === 0) status = 'deposited'
    else if (challan) status = 'late'
    else if (notYetDue) status = 'not-yet-due'
    else status = 'pending'
    // 1.5% a month once tax was withheld but not paid in; 1% where it was never
    // deducted at all is reported separately, because the workpaper has only
    // said it should have been.
    const interest = challan
      ? roundRupee((challan.amount || entry.tax) * 0.015 * lateMonths)
      : status === 'pending' ? roundRupee(entry.tax * 0.01 * lateMonths) : 0
    return {
      month: m,
      label: monthLabel(m),
      tax: entry.tax,
      due,
      rows: entry.rows,
      challan,
      status,
      monthsLate: challan ? lateMonths : notYetDue ? 0 : lateMonths,
      interest,
      shortfall: status === 'short' ? shortfall : 0,
    }
  })

  const vendorsOut: VendorSummary[] = [...perVendor.entries()].map(([key, v]) => {
    const vendor = vendorById.get(key)
    const bill = bills.find(b => vendorKey(b) === key)
    const pan = panOf(vendor, bill?.gstin || '')
    const section = sectionOf(v.section)
    const threshold = effectiveThreshold(section, state.payerType)
    return {
      key,
      name: vendor?.name || bill?.vendorName || key.replace(/^name:/, ''),
      pan: pan.pan,
      panSource: pan.source,
      section: v.section,
      bills: v.bills,
      value: v.value,
      chargeable: v.chargeable,
      tax: v.tax,
      threshold: Number.isFinite(threshold) ? threshold : 0,
      headroom: Number.isFinite(threshold) ? Math.max(threshold - v.value, 0) : 0,
      projectedCrossMonth: projectCross(v.value, threshold, fyStart, bills.filter(b => vendorKey(b) === key).map(b => b.billDate)),
      tagged: v.chosen,
    }
  }).sort((a, b) => b.tax - a.tax || b.value - a.value)

  const totalTax = rows.reduce((s, r) => s + r.tax, 0)
  const deposited = months.reduce((s, m) => s + (m.challan ? m.challan.amount : 0), 0)
  const overdue = months.filter(m => m.status === 'pending' && m.monthsLate > 0).reduce((s, m) => s + m.tax, 0)
  const interest = months.reduce((s, m) => s + m.interest, 0)
  const statements = quarterlyStatements(fyStart, rows, asOf, state)

  return {
    fyLabel: fyLabel(fyStart),
    rows,
    months,
    vendors: vendorsOut,
    totals: {
      bills: usable.length,
      value: usable.reduce((s, x) => s + x.base, 0),
      untaggedValue: [...perVendor.values()].reduce((s, v) => s + v.untagged, 0),
      untaggedBills: usable.filter(x => !x.section).length,
      chargeable: rows.reduce((s, r) => s + r.chargeable, 0),
      tax: totalTax,
      deposited,
      toDeposit: Math.max(totalTax - deposited, 0),
      overdue,
      interest,
      statementFee: statements.reduce((s, q) => s + q.fee, 0),
      statementFeeCeiling: statements.reduce((s, q) => s + (q.ceiling ? q.fee : 0), 0),
    },
    statements,
  }
}

/**
 * April-to-March run rate, so a supplier on their way to a limit is visible before
 * the bill that crosses it. Only meaningful for the big aggregate limits.
 */
function projectCross(value: number, threshold: number, fyStart: number, billDates: string[]): string | null {
  if (!Number.isFinite(threshold) || threshold <= 0 || value >= threshold || billDates.length < 2) return null
  const months = fyMonths(fyStart)
  const used = billDates.map(monthOf).filter(Boolean)
  const distinct = new Set(used)
  if (distinct.size < 2) return null
  // Average over the months that actually carried bills, not the whole year.
  const perMonth = value / distinct.size
  if (perMonth <= 0) return null
  const monthsToCross = Math.ceil((threshold - value) / perMonth)
  const startIdx = Math.max(...[...distinct].map(m => months.indexOf(m)))
  const target = startIdx + monthsToCross
  if (target > 11) return null
  return monthLabel(months[target])
}

const QUARTERS: { label: string; quarter: string; from: string; to: string; due: string }[] = [
  { label: 'Apr–Jun', quarter: 'Q1', from: '04-01', to: '06-30', due: '07-31' },
  { label: 'Jul–Sep', quarter: 'Q2', from: '07-01', to: '09-30', due: '10-31' },
  { label: 'Oct–Dec', quarter: 'Q3', from: '10-01', to: '12-31', due: '01-31' },
  { label: 'Jan–Mar', quarter: 'Q4', from: '01-01', to: '03-31', due: '05-31' },
]

/**
 * The late-statement fee is section 427 of the Income-tax Act, 2025 — section 234E of the
 * 1961 Act it replaced: ₹200 a day, capped at the tax deductible for the quarter. Section
 * 271H (section 461 of the 2025 Act) is a different thing: a ₹10,000–₹1,00,000 penalty the
 * officer decides, not a daily charge, so no clock on this page accrues it. The compliance
 * calendar reads this one constant, so the two registers cannot cite two fees again.
 */
export const TDS_STATEMENT_FEE_PER_DAY = 200
export const TDS_STATEMENT_FEE_CITATION =
  'section 427 of the Income-tax Act, 2025 (section 234E of the 1961 Act)'
export const TDS_STATEMENT_PENALTY_CITATION =
  'section 461 of the Income-tax Act, 2025 (section 271H of the 1961 Act)'

/**
 * 26Q is filed quarterly. A late statement costs ₹200 a day under section 427 (section 234E),
 * capped at the tax involved. Section 271H (section 461 of the 2025 Act) is a separate,
 * discretionary penalty — never a per-day charge, so it is printed as a range and not accrued.
 *
 * R3-25's amendment, borrowed whole from the filings register's rule 88B(2) shape (R3-24):
 * a clock reads to the date the register holds, or it does not stop. Where the shop has said
 * which day the statement went in, the days and the fee run to that day and stop — filed before
 * the due date, the fee is a nil that is a reading, not a missing one. Where it has not, the
 * days run to today and the fee is labelled a ceiling. The portal itself is still invisible;
 * what changed is that the register no longer has to pretend it is still the day before filing.
 */
function quarterlyStatements(fyStart: number, rows: DeductionRow[], asOf: Date, state: TdsState): QuarterlyStatement[] {
  return QUARTERS.map(q => {
    const year = Number(q.from.slice(0, 2)) >= 4 ? fyStart : fyStart + 1
    // A quarter due in January or May is due in the calendar year after it opened:
    // Q3 of 2026-27 closes 31 Dec 26 and is due 31 Jan 27, Q4 closes 31 Mar 27 and is
    // due 31 May 27.
    const dueYear = Number(q.due.slice(0, 2)) >= 4 ? year : year + 1
    const due = `${dueYear}-${q.due}`
    const periodTo = `${year}-${q.to}`
    const tax = rows.filter(r => r.month >= `${year}-${q.from.slice(0, 2)}` && r.month <= `${year}-${q.to.slice(0, 2)}`).reduce((s, r) => s + r.tax, 0)
    const dueDate = parseDate(due)!
    const filing = state.statementFilings[due] ?? null
    // A day that has not arrived cannot stop a clock, and neither can one before the quarter it
    // reports had closed — the composer refuses both, and a hand-edited store falls back to reading
    // to today rather than measuring to a day this quarter cannot have been filed on.
    const filedOn = filing && parseDate(filing.filedOn) && filing.filedOn <= ymd(asOf) && filing.filedOn >= periodTo
      ? filing.filedOn
      : ''
    const stop = filedOn ? parseDate(filedOn)! : asOf
    // The fee clock needs tax to run on — section 427 charges a share of the tax withheld, so a
    // quarter with nothing withheld has no fee. A filing day is a transcript on its own, though:
    // 15 August is after 31 July whether or not tax was withheld, and the row must not call it on
    // time. Reading both from one flag made a nil quarter filed late print "Filed on time" — the
    // defect the composer showed the first time it was typed into live (R3-27).
    const late = tax > 0 && dueDate < stop
    const filedAfterDue = Boolean(filedOn) && dueDate < stop
    const daysLate = (late || filedAfterDue) ? Math.ceil((stop.getTime() - dueDate.getTime()) / 86400000) : 0
    // 427(2) caps the fee at the tax deductible for the quarter. There is no second ceiling in
    // the section; the ₹5,00,000 this line used to carry was not the statute's.
    const cap = tax
    // At the cap a further day adds nothing — the fee has stopped growing even though no filing
    // day stops the clock. The two states are different and the page prints them differently.
    const capped = late && daysLate * TDS_STATEMENT_FEE_PER_DAY >= cap
    const stopped = late && Boolean(filedOn)
    return {
      label: q.label,
      quarter: q.quarter,
      due,
      periodFrom: `${year}-${q.from}`,
      periodTo,
      tax,
      daysLate,
      fee: late ? Math.min(daysLate * TDS_STATEMENT_FEE_PER_DAY, cap) : 0,
      filedOn,
      reference: filing?.reference || '',
      stopped,
      ceiling: late && !filedOn,
      capped,
      perDay: late && !filedOn && !capped ? TDS_STATEMENT_FEE_PER_DAY : 0,
    }
  })
}

/* ── export ─────────────────────────────────────────────────────────────── */

export const TDS_CSV_HEADERS = [
  'Deductee PAN', 'Deductee', 'Section', 'Bill number', 'Bill date', 'Base value',
  'Chargeable', 'Rate %', 'TDS', 'Deduction month', 'Deposit due', 'Deposit date',
  'BSR', 'Challan number', 'Deposit amount',
]

export function tdsCsvRows(wp: TdsWorkpaper): (string | number)[][] {
  return wp.rows.map(r => {
    const m = wp.months.find(x => x.month === r.month)
    const c = m?.challan
    return [
      r.pan || 'PAN NOT GIVEN', r.vendorName, r.section, r.billNumber, r.billDate,
      r.base, r.chargeable, r.rate, r.tax, r.month, r.depositDue,
      c?.depositDate || '', c?.bsr || '', c?.challanNumber || '', c?.amount ?? '',
    ]
  })
}

/** A month-by-month deposit sheet, which is what a challan counter wants. */
export const TDS_DEPOSIT_CSV_HEADERS = ['Month', 'TDS to deposit', 'Due date', 'Status', 'Deposited', 'Deposit date', 'BSR', 'Challan', 'Months late', 'Interest estimate']

export function tdsDepositCsvRows(wp: TdsWorkpaper): (string | number)[][] {
  return wp.months.map(m => [
    m.label, m.tax, m.due, m.status, m.challan ? m.challan.amount : '', m.challan?.depositDate || '',
    m.challan?.bsr || '', m.challan?.challanNumber || '', m.monthsLate, m.interest,
  ])
}

/**
 * The four 26Q rows as the register reads them now. `Fee basis` says in words whether the fee is
 * measured to a held date or is a ceiling to today — a sheet a CA reads in a different week must
 * not present today's last calculation as the filed fact.
 */
export const TDS_STATEMENT_CSV_HEADERS = [
  'Quarter', 'Label', 'Period from', 'Period to', 'Due date', 'Tax in the quarter',
  'Days late', 'Fee', 'Fee basis', 'Filed on', 'Acknowledgement',
]

export function tdsStatementCsvRows(wp: TdsWorkpaper): (string | number)[][] {
  return wp.statements.map(q => [
    q.quarter, q.label, q.periodFrom, q.periodTo, q.due, q.tax, q.daysLate, q.fee,
    q.stopped
      ? 'measured to the day this register holds'
      : q.capped
        ? 'ceiling — no filing day, at the cap'
        : q.ceiling
          ? 'ceiling — no filing day, read to today'
          : q.filedOn && q.daysLate > 0
            ? 'filed after the due date — nothing was withheld'
            : 'nothing at stake',
    q.filedOn || '', q.reference || '',
  ])
}

/* ── sample data for the empty screen ───────────────────────────────────── */

export const SAMPLE_TDS_NOTE = 'Tags, rates and challans on this page are an opinion to check with your CA, not a filing.'
