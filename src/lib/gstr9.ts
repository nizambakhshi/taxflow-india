/**
 * GSTR-9 / GSTR-9C annual return workpaper.
 *
 * The annual return is where a GST file stops being a calculation and starts
 * being an audit: the CA reconciles three different views of the same year
 * (books, GSTR-1, GSTR-3B) and has to explain every difference. This library
 * derives two of those views from the rows already in the database and takes
 * the third (what was actually filed on the portal) as a local declaration —
 * so nothing needs a schema change and every figure is traceable to a document.
 *
 * Table numbering follows the current GSTR-9 schema; the live portal form
 * governs, and due dates / thresholds have been moved by notification more than
 * once, so `eligibility()` always returns the rule it applied.
 */

import { fyLabel, fyMonths, monthOf } from '@/lib/targets'

/* ── money primitives ───────────────────────────────────────────────────── */

/** One tax period expressed the way every GSTR-9 row wants it. */
export interface Heads {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  tax: number
}

export const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function emptyHeads(): Heads {
  return { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, tax: 0 }
}

export function headsOf(
  taxable: number | string,
  igst: number | string,
  cgst: number | string,
  sgst: number | string,
  cess: number | string = 0,
): Heads {
  const t = { taxable: round2(num(taxable)), igst: round2(num(igst)), cgst: round2(num(cgst)), sgst: round2(num(sgst)), cess: round2(num(cess)) }
  return { ...t, tax: round2(t.igst + t.cgst + t.sgst + t.cess) }
}

export function addHeads(a: Heads, b: Heads): Heads {
  return {
    taxable: round2(a.taxable + b.taxable),
    igst: round2(a.igst + b.igst),
    cgst: round2(a.cgst + b.cgst),
    sgst: round2(a.sgst + b.sgst),
    cess: round2(a.cess + b.cess),
    tax: round2(a.tax + b.tax),
  }
}

export function sumHeads(rows: Heads[]): Heads {
  return rows.reduce(addHeads, emptyHeads())
}

/** Signed so a credit note lowers the head it belongs to instead of adding to it. */
function scale(h: Heads, sign: number): Heads {
  return {
    taxable: round2(h.taxable * sign), igst: round2(h.igst * sign),
    cgst: round2(h.cgst * sign), sgst: round2(h.sgst * sign),
    cess: round2(h.cess * sign), tax: round2(h.tax * sign),
  }
}

/* ── documents the workpaper reads ──────────────────────────────────────── */

/** Outward: sales invoices and the credit notes issued against them. */
export interface OutwardDoc {
  id: string
  number: string
  date: string | null
  kind: 'invoice' | 'credit_note'
  party: string | null
  gstin: string | null
  placeOfSupply?: string | null
  supplyType?: string | null
  taxable: number | string
  igst: number | string
  cgst: number | string
  sgst: number | string
  cess?: number | string | null
  total: number | string
}

/** Inward: purchase bills, expenses and debit notes raised against purchases. */
export interface InwardDoc {
  id: string
  number: string
  date: string | null
  party: string | null
  gstin: string | null
  itcEligible: boolean
  reverseCharge?: boolean
  taxable: number | string
  igst: number | string
  cgst: number | string
  sgst: number | string
  cess?: number | string | null
  total: number | string
  /** Balance still unpaid, when the source tracks it. */
  balanceDue?: number | string | null
  source: 'bill' | 'expense' | 'debit_note'
}

/* ── statutory constants ────────────────────────────────────────────────── */

/** B2C (Large) is a per-invoice test on inter-state supplies. */
export const B2C_LARGE_INVOICE_VALUE = 250_000
/** Section 16(4): ITC on an invoice unpaid for 180 days from its date must be reversed. */
export const ITC_PAYMENT_DEADLINE_DAYS = 180
/** Aggregate turnover at or below which the annual return stands exempted. */
export const ANNUAL_RETURN_EXEMPT_TURNOVER = 2_00_00_000
/** Above this the accounts get audited (s.44) and GSTR-9C applies. */
export const AUDIT_TURNOVER = 5_00_00_000
/** ₹1 per head: round-off on a consolidated monthly figure, not a real difference. */
export const RECON_TOLERANCE = 1

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

/* ── Table 4 — outward supplies ─────────────────────────────────────────── */

export type OutwardKey = 'b2b' | 'b2cl' | 'b2c' | 'zero' | 'nil' | 'non_gst'

const OUTWARD_META: Record<OutwardKey, { label: string; code: string; hint: string }> = {
  b2b: { label: 'Taxable outward supplies to registered persons', code: '4.A(a) · B2B', hint: 'Customer GSTIN on the document' },
  b2cl: { label: 'Inter-state B2C where the invoice exceeds ₹2.5 lakh', code: '4.A(b) · B2C Large', hint: 'Value of taxable outward supplies made through e-commerce is reported separately' },
  b2c: { label: 'Other taxable outward supplies to unregistered persons', code: '4.A(c) · B2C', hint: 'Consolidated in GSTR-1 by rate and place of supply' },
  zero: { label: 'Zero-rated supplies (export / SEZ)', code: '4.A(d) · Zero rated', hint: 'ZP without LUT is taxable in the value column; supply_type marks these documents' },
  nil: { label: 'Nil-rated and wholly exempted outward supplies', code: '4.A(e) · Nil / exempt', hint: 'No GST charged, but the value still counts towards aggregate turnover' },
  non_gst: { label: 'Non-GST outward supplies', code: '4.A(f) · Non-GST', hint: 'Alcohol, petroleum products and other out-of-scope supplies — not tracked in invoices' },
}

const ORDER: OutwardKey[] = ['b2b', 'b2cl', 'b2c', 'zero', 'nil', 'non_gst']

function hasGstin(gstin: string | null | undefined): boolean {
  return GSTIN_SHAPE.test((gstin || '').trim().toUpperCase())
}

/**
 * Precedence matters: an exempt B2B invoice belongs in the nil/exempt row of the
 * annual return even though it was reported in B2B in GSTR-1, and exports are
 * zero-rated rather than B2C.
 */
export function classifyOutward(doc: OutwardDoc): OutwardKey {
  const h = headsOf(doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess ?? 0)
  const type = (doc.supplyType || '').toLowerCase()
  if (type === 'non_gst') return 'non_gst'
  if (h.tax <= 1) return 'nil'
  if (type === 'export' || type === 'sez') return 'zero'
  if (hasGstin(doc.gstin)) return 'b2b'
  if (h.igst > 0 && num(doc.total) > B2C_LARGE_INVOICE_VALUE) return 'b2cl'
  return 'b2c'
}

export interface OutwardRow {
  key: OutwardKey
  code: string
  label: string
  hint: string
  count: number
  heads: Heads
}

export function outwardSupplies(docs: OutwardDoc[]): OutwardRow[] {
  const map = new Map<OutwardKey, { count: number; heads: Heads }>()
  for (const doc of docs) {
    const key = classifyOutward(doc)
    const sign = doc.kind === 'credit_note' ? -1 : 1
    const entry = map.get(key) || { count: 0, heads: emptyHeads() }
    entry.heads = addHeads(entry.heads, scale(headsOf(doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess ?? 0), sign))
    // A credit note adjusts a supply that was already counted; it is not a new one.
    entry.count += sign > 0 ? 1 : 0
    map.set(key, entry)
  }
  return ORDER.filter(k => map.has(k)).map(k => ({
    key: k,
    code: OUTWARD_META[k].code,
    label: OUTWARD_META[k].label,
    hint: OUTWARD_META[k].hint,
    count: map.get(k)!.count,
    heads: map.get(k)!.heads,
  }))
}

/* ── Table 4.B — inward supplies liable to reverse charge ───────────────── */

export interface RcmRow {
  key: string
  label: string
  count: number
  heads: Heads
}

/**
 * Only bills flagged as reverse-charge appear here. The tax on these is paid by
 * the recipient, so it is *not* in Table 4.A even though the same document does
 * generate ITC for a regular taxpayer.
 */
export function rcmSupplies(inward: InwardDoc[]): RcmRow[] {
  const rc = inward.filter(d => d.reverseCharge)
  const buckets: { key: string; label: string; rows: InwardDoc[] }[] = [
    { key: 'unreg_inputs', label: 'From unregistered suppliers (inputs and input services)', rows: rc.filter(d => !hasGstin(d.gstin) && d.source !== 'expense') },
    { key: 'reg', label: 'From registered suppliers under notified reverse charge', rows: rc.filter(d => hasGstin(d.gstin)) },
    { key: 'unreg_services', label: 'Input services from unregistered suppliers', rows: rc.filter(d => d.source === 'expense' && !hasGstin(d.gstin)) },
  ]
  return buckets
    .map(b => ({
      key: b.key,
      label: b.label,
      count: b.rows.length,
      heads: sumHeads(b.rows.map(d => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0))),
    }))
    .filter(r => r.count > 0 || r.heads.taxable !== 0)
}

/* ── Table 5 — input tax credit ─────────────────────────────────────────── */

export interface ItcRow {
  key: string
  label: string
  count: number
  heads: Heads
  /** Documents behind the row, for the drill-down. */
  docs: InwardDoc[]
}

export interface ItcAtRisk {
  doc: InwardDoc
  days: number
  heads: Heads
  /** ₹ of the invoice still outstanding. */
  unpaid: number
}

const DAY = 86_400_000

function daysBetween(from: string | null, to: Date): number {
  if (!from) return 0
  const t = new Date(from).getTime()
  if (Number.isNaN(t)) return 0
  return Math.floor((to.getTime() - t) / DAY)
}

/**
 * Section 16(4): the credit taken on a document unpaid for 180 days from its
 * date has to be reversed in the following month, and comes back only when the
 * money is actually paid. Purchase bills carry amount_paid / balance_due, so
 * this is derivable straight from the books.
 */
export function itcUnpaid(inward: InwardDoc[], asOf: Date = new Date()): { atRisk: ItcAtRisk[]; recredited: ItcRow[] } {
  const atRisk: ItcAtRisk[] = []
  const recredited: InwardDoc[] = []
  for (const doc of inward) {
    if (doc.source === 'debit_note' || !doc.itcEligible) continue
    const days = daysBetween(doc.date, asOf)
    if (days < ITC_PAYMENT_DEADLINE_DAYS) continue
    const unpaid = num(doc.balanceDue)
    const heads = itcHeadsOf(doc)
    if (unpaid > 1) atRisk.push({ doc, days, heads, unpaid })
    else recredited.push(doc)
  }
  atRisk.sort((a, b) => b.heads.tax - a.heads.tax || b.days - a.days)
  return {
    atRisk,
    recredited: [{
      key: 'recredited',
      label: 'Credit re-availed on invoices paid after the 180-day reversal',
      count: recredited.length,
      heads: sumHeads(recredited.map(d => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0))),
      docs: recredited,
    }],
  }
}

export interface ItcTable {
  available: ItcRow[]
  reversed: ItcRow[]
  ineligible: ItcRow[]
  availableTotal: Heads
  reversedTotal: Heads
  ineligibleTotal: Heads
  netHeads: Heads
}

export interface ItcInput {
  /** Rule 42/43 reversals for mixed used — attributable only from the accounts, not the invoices. */
  rule4243?: Heads
  /** Any other reversal the taxpayer wants to declare. */
  otherReversal?: Heads
  /** Debit notes raised on suppliers reduce the credit taken on that purchase. */
  debitNotes?: InwardDoc[]
  asOf?: Date
}

/**
 * Expenses store one `gst_amount` with no CGST/SGST split, so a services expense
 * is credited as half-and-half — the same convention /gst/gstr3b and the ledger
 * already use.
 */
function expenseHeads(doc: InwardDoc): Heads {
  const split = num(doc.igst) + num(doc.cgst) + num(doc.sgst)
  if (split > 0) return headsOf(doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess ?? 0)
  const total = num(doc.total) - num(doc.taxable)
  const tax = total > 1 ? round2(total) : num(doc.cess ?? 0)
  const half = round2(tax / 2)
  return { taxable: round2(num(doc.taxable)), igst: 0, cgst: half, sgst: half, cess: 0, tax: round2(half * 2) }
}

/** Credit taken on one inward document, in the shape Table 5 wants. */
function itcHeadsOf(doc: InwardDoc): Heads {
  return doc.source === 'expense' ? expenseHeads(doc) : headsOf(doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess ?? 0)
}

export function itcTable(inward: InwardDoc[], input: ItcInput = {}): ItcTable {
  const asOf = input.asOf ?? new Date()
  const eligible = inward.filter(d => d.itcEligible && d.source !== 'debit_note')
  const blocked = inward.filter(d => d.itcEligible === false)

  const goods = eligible.filter(d => d.source === 'bill')
  const services = eligible.filter(d => d.source === 'expense')

  const { atRisk } = itcUnpaid(inward, asOf)
  const debitNotes = (input.debitNotes ?? []).filter(d => d.itcEligible !== false)

  const available: ItcRow[] = [
    {
      key: 'inputs', label: 'Inputs and input services from registered suppliers (inward supply documents)',
      count: goods.length, heads: sumHeads(goods.map(d => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0))), docs: goods,
    },
    {
      key: 'services', label: 'Credit on expenses booked with GST (services)',
      count: services.length, heads: sumHeads(services.map(itcHeadsOf)), docs: services,
    },
  ].filter(r => r.count > 0)

  const reversed: ItcRow[] = [
    {
      key: 'unpaid',
      label: `ITC on purchases unpaid after ${ITC_PAYMENT_DEADLINE_DAYS} days — reversal under section 16(4)`,
      count: atRisk.length,
      heads: sumHeads(atRisk.map(r => r.heads)),
      docs: atRisk.map(r => r.doc),
    },
    {
      key: 'debit_notes',
      label: 'Debit notes raised on suppliers — credit attributable to the reduction',
      count: debitNotes.length,
      heads: sumHeads(debitNotes.map(d => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0))),
      docs: debitNotes,
    },
    {
      key: 'rule4243', label: 'Rule 42/43 reversal (credit attributable to exempt supplies)',
      count: 0, heads: input.rule4243 ?? emptyHeads(), docs: [],
    },
    { key: 'other', label: 'Other reversals declared with the return', count: 0, heads: input.otherReversal ?? emptyHeads(), docs: [] },
  ].filter(r => r.heads.tax !== 0 || r.count > 0)

  const ineligible: ItcRow[] = [
    {
      key: 'blocked', label: 'Block credit — documents marked not eligible (section 17(5))',
      count: blocked.length,
      heads: sumHeads(blocked.map(itcHeadsOf)),
      docs: blocked,
    },
    {
      key: 'no_gstin', label: 'Credit claimed on documents with no supplier GSTIN (portal will not give it in 2B)',
      count: eligible.filter(d => !hasGstin(d.gstin)).length,
      heads: sumHeads(eligible.filter(d => !hasGstin(d.gstin)).map(itcHeadsOf)),
      docs: eligible.filter(d => !hasGstin(d.gstin)),
    },
  ].filter(r => r.count > 0)

  const availableTotal = sumHeads(available.map(r => r.heads))
  const reversedTotal = sumHeads(reversed.map(r => r.heads))
  const ineligibleTotal = sumHeads(ineligible.map(r => r.heads))
  const netHeads: Heads = {
    taxable: availableTotal.taxable,
    igst: round2(availableTotal.igst - reversedTotal.igst - ineligibleTotal.igst),
    cgst: round2(availableTotal.cgst - reversedTotal.cgst - ineligibleTotal.cgst),
    sgst: round2(availableTotal.sgst - reversedTotal.sgst - ineligibleTotal.sgst),
    cess: round2(availableTotal.cess - reversedTotal.cess - ineligibleTotal.cess),
    tax: round2(availableTotal.tax - reversedTotal.tax - ineligibleTotal.tax),
  }

  return { available, reversed, ineligible, availableTotal, reversedTotal, ineligibleTotal, netHeads }
}

/** Rows that mention the 180-day reversal also want the document list. */
export function atRiskTotal(list: ItcAtRisk[]): Heads {
  return sumHeads(list.map(r => r.heads))
}

/* ── Table 6 — nil / exempt / non-GST ───────────────────────────────────── */

export interface ExemptRow {
  key: OutwardKey
  label: string
  /** Nil-rated is taxable at a nil rate; exempt supplies are outside the charge. */
  heads: Heads
  count: number
}

export function exemptSupplies(docs: OutwardDoc[]): ExemptRow[] {
  const rows = outwardSupplies(docs).filter(r => r.key === 'nil' || r.key === 'non_gst' || r.key === 'zero')
  return rows.map(r => ({ key: r.key, label: r.key === 'zero' ? 'Zero-rated outward supplies' : r.key === 'nil' ? 'Nil-rated and exempted supplies' : 'Non-GST supplies', heads: r.heads, count: r.count }))
}

/* ── Table 3A / 3B and the 9C reconciliation ────────────────────────────── */

export interface MonthBooks {
  month: string
  outward: Heads
  inward: Heads
  netTax: Heads
}

/** Twelve FY months, April first, so a sparse year still prints a full grid. */
export function monthsOf(fyStart: number): string[] {
  return fyMonths(fyStart)
}

/**
 * One pass per document into its FY month. Outward rows are signed (credit notes
 * subtract); inward rows are the credit actually taken.
 */
export function monthlyBooks(docs: OutwardDoc[], inward: InwardDoc[], fyStart: number): MonthBooks[] {
  const keys = fyMonths(fyStart)
  const byMonth = new Map<string, MonthBooks>(keys.map(m => [m, { month: m, outward: emptyHeads(), inward: emptyHeads(), netTax: emptyHeads() }]))

  const put = (date: string | null): MonthBooks | undefined => {
    const m = monthOf(date)
    return m ? byMonth.get(m) : undefined
  }

  for (const doc of docs) {
    const row = put(doc.date)
    if (!row) continue
    const sign = doc.kind === 'credit_note' ? -1 : 1
    row.outward = addHeads(row.outward, scale(headsOf(doc.taxable, doc.igst, doc.cgst, doc.sgst, doc.cess ?? 0), sign))
  }
  for (const doc of inward) {
    const row = put(doc.date)
    if (!row || !doc.itcEligible) continue
    row.inward = addHeads(row.inward, itcHeadsOf(doc))
  }
  for (const row of byMonth.values()) {
    row.netTax = {
      taxable: row.outward.taxable,
      igst: round2(row.outward.igst - row.inward.igst),
      cgst: round2(row.outward.cgst - row.inward.cgst),
      sgst: round2(row.outward.sgst - row.inward.sgst),
      cess: round2(row.outward.cess - row.inward.cess),
      tax: round2(row.outward.tax - row.inward.tax),
    }
  }
  return keys.map(m => byMonth.get(m)!)
}

/** What was filed on the portal, month by month — declared locally, never invented. */
export interface FiledMonth {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  /** Free text the CA can leave for a month that does not tie. */
  note?: string
}

export function filedHeads(f: FiledMonth | undefined): Heads | null {
  if (!f) return null
  const heads = headsOf(f.taxable, f.igst, f.cgst, f.sgst, f.cess)
  return { ...heads, tax: heads.tax }
}

export type ReconStatus = 'unset' | 'matched' | 'variance'

export interface ReconRow {
  month: string
  books: Heads
  filed: Heads | null
  /** books − filed, so a positive number means the return under-reported the books. */
  diff: Heads
  status: ReconStatus
  heads: string[]
  note?: string
}

export function reconcile9C(books: MonthBooks[], filed: Record<string, FiledMonth>): ReconRow[] {
  return books.map(b => {
    const f = filedHeads(filed[b.month])
    if (!f) return { month: b.month, books: b.outward, filed: null, diff: emptyHeads(), status: 'unset' as ReconStatus, heads: [] }
    const diff: Heads = {
      taxable: round2(b.outward.taxable - f.taxable),
      igst: round2(b.outward.igst - f.igst),
      cgst: round2(b.outward.cgst - f.cgst),
      sgst: round2(b.outward.sgst - f.sgst),
      cess: round2(b.outward.cess - f.cess),
      tax: round2(b.outward.tax - f.tax),
    }
    const heads: string[] = []
    if (Math.abs(diff.taxable) > RECON_TOLERANCE) heads.push('Taxable value')
    for (const head of ['igst', 'cgst', 'sgst', 'cess'] as const) {
      if (Math.abs(diff[head]) > RECON_TOLERANCE) heads.push(head.toUpperCase())
    }
    const entry = filed[b.month]
    return {
      month: b.month, books: b.outward, filed: f, diff,
      status: heads.length ? ('variance' as ReconStatus) : ('matched' as ReconStatus),
      heads,
      note: entry?.note,
    }
  })
}

export interface ReconSummary {
  rows: ReconRow[]
  /** All twelve months — the turnover as per books of accounts. */
  booksTotal: Heads
  /** Only the months that were actually declared, so the two sides stay comparable. */
  booksDeclaredTotal: Heads
  filedTotal: Heads
  diffTotal: Heads
  monthsDeclared: number
  monthsVariance: number
  /** Books turnover minus filed turnover — the number GSTR-9C Part A asks to explain. */
  turnoverDiff: number
}

export function reconSummary(rows: ReconRow[]): ReconSummary {
  const declared = rows.filter(r => r.filed)
  return {
    rows,
    booksTotal: sumHeads(rows.map(r => r.books)),
    booksDeclaredTotal: sumHeads(declared.map(r => r.books)),
    filedTotal: sumHeads(declared.map(r => r.filed!)),
    diffTotal: sumHeads(declared.map(r => r.diff)),
    monthsDeclared: declared.length,
    monthsVariance: rows.filter(r => r.status === 'variance').length,
    turnoverDiff: round2(sumHeads(declared.map(r => r.diff)).taxable),
  }
}

/* ── eligibility ────────────────────────────────────────────────────────── */

export interface EligibilityInput {
  /** Aggregate turnover for the FY, GST excluded, net of credit notes. */
  turnover: number
  registrationType?: string | null
  /** Regular taxpayers with an interstate component are worth flagging for the QRMP rule. */
  itcClaimed?: number
}

export interface Eligibility {
  form: string
  required: boolean
  headline: string
  reason: string
  /** Table numbering to follow, and the reconciliation statement. */
  needs9C: boolean
  /** Turnover above ₹5 crore also pulls in e-invoice (IRN) generation. */
  eInvoice: boolean
  points: string[]
}

const NON_ANNUAL_TYPES = new Set(['composition', 'casual', 'non_resident', 'isd', 'tcs', 'tds', 'uin'])

export function eligibility({ turnover, registrationType, itcClaimed }: EligibilityInput): Eligibility {
  const type = (registrationType || 'regular').toLowerCase()
  const points: string[] = []

  if (NON_ANNUAL_TYPES.has(type)) {
    points.push('Composition, casual, non-resident, ISD, TDS/TCS and UIN holders file their own period statements instead of GSTR-9.')
    return {
      form: 'GSTR-9 not applicable', required: false,
      headline: 'Annual return under section 44 does not apply to this registration',
      reason: `Registration type recorded in the setup is “${type}”.`,
      needs9C: false, eInvoice: false, points,
    }
  }

  const needs9 = turnover > ANNUAL_RETURN_EXEMPT_TURNOVER
  const needs9C = turnover > AUDIT_TURNOVER
  points.push(`Aggregate turnover taken from the books: ₹${Math.round(turnover)}.`)
  points.push(`Exemption limit for the annual return: ₹${ANNUAL_RETURN_EXEMPT_TURNOVER} (relief for small taxpayers — confirm it still covers the year you are looking at).`)
  points.push(`Audit and reconciliation limit under section 44: ₹${AUDIT_TURNOVER}.`)
  if (needs9C) points.push('Turnover above ₹5 crore also makes invoice registration (IRN / e-invoice) compulsory for the year.')
  if (itcClaimed && !needs9) points.push('Credit claimed above zero still means the monthly returns have to reconcile, even when the annual return is exempt.')

  return {
    form: needs9C ? 'GSTR-9 + GSTR-9C' : needs9 ? 'GSTR-9' : 'None for this year',
    required: needs9,
    headline: needs9C
      ? 'Annual return and the reconciliation statement are both in scope'
      : needs9
        ? 'Annual return GSTR-9 applies'
        : 'Below the turnover limit — annual return stands exempt',
    reason: `Turnover ₹${Math.round(turnover)} against the ₹${ANNUAL_RETURN_EXEMPT_TURNOVER} exemption limit and the ₹${AUDIT_TURNOVER} audit limit.`,
    needs9C, eInvoice: needs9C, points,
  }
}

/* ── cautions ───────────────────────────────────────────────────────────── */

export type CautionLevel = 'red' | 'amber' | 'info'

export interface Caution {
  id: string
  level: CautionLevel
  title: string
  detail: string
  href?: string
}

export interface CautionInput {
  docs: OutwardDoc[]
  inward: InwardDoc[]
  itc: ItcTable
  atRisk: ItcAtRisk[]
  recon: ReconSummary
  eligibility: Eligibility
  stateCode?: string
}

/**
 * Alerts a CA would raise on this file. Every one of them comes from the books,
 * so the panel has to stay empty when the data is clean.
 */
export function cautions(input: CautionInput): Caution[] {
  const out: Caution[] = []
  const { docs, inward, itc, atRisk, recon } = input

  const noGstinB2b = docs.filter(d => d.kind === 'invoice' && !hasGstin(d.gstin) && num(d.taxable) > 0 && headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0).tax > 1)
  const taxableNoGstin = sumHeads(noGstinB2b.map(d => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0)))
  if (noGstinB2b.length) {
    out.push({
      id: 'outward-no-gstin', level: 'amber',
      title: `${noGstinB2b.length} taxable invoice${noGstinB2b.length > 1 ? 's' : ''} report as B2C because the customer GSTIN is missing`,
      detail: `₹${Math.round(taxableNoGstin.taxable)} sits in Table 4.A(c) instead of 4.A(a). Consolidated B2C is harder to defend at assessment time.`,
      href: '/invoices',
    })
  }

  const creditNotes = docs.filter(d => d.kind === 'credit_note')
  if (creditNotes.length) {
    out.push({
      id: 'credit-notes', level: 'info',
      title: `${creditNotes.length} credit note${creditNotes.length > 1 ? 's' : ''} net against outward turnover`,
      detail: `Table 4.A shows the year after these reductions; the portal wants them in the debit/credit note annexure as well.`,
      href: '/credit-notes',
    })
  }

  if (atRisk.length) {
    out.push({
      id: 'itc-180', level: 'red',
      title: `₹${Math.round(atRiskTotal(atRisk).tax)} of credit is on ${atRisk.length} invoice${atRisk.length > 1 ? 's' : ''} unpaid beyond ${ITC_PAYMENT_DEADLINE_DAYS} days`,
      detail: 'Section 16(4) requires this reversal in the month after the deadline and allows it back only when payment is made.',
      href: '/bills',
    })
  }

  const expensesNoGstin = inward.filter(d => d.source === 'expense' && d.itcEligible && !(d.gstin || '').trim())
  if (expensesNoGstin.length) {
    out.push({
      id: 'expense-no-gstin', level: 'amber',
      title: `Credit taken on ${expensesNoGstin.length} expense${expensesNoGstin.length > 1 ? 's' : ''} with no supplier GSTIN`,
      detail: 'These will not appear in GSTR-2B, so the credit is at risk of a demand.',
      href: '/expenses',
    })
  }

  if (itc.ineligibleTotal.tax > 0) {
    out.push({
      id: 'itc-ineligible', level: 'amber',
      title: `₹${Math.round(itc.ineligibleTotal.tax)} of credit marked ineligible inside the books`,
      detail: 'Report it in Table 5.C so the ITC claimed in 3B and the annual return agree.',
    })
  }

  if (recon.monthsDeclared < 12) {
    out.push({
      id: 'recon-incomplete', level: 'info',
      title: `${12 - recon.monthsDeclared} of 12 months have no filed GSTR-3B figures`,
      detail: 'The reconciliation compares the books with what was actually filed — key those numbers in before the workpaper goes to the CA.',
    })
  } else if (recon.monthsVariance) {
    out.push({
      id: 'recon-variance', level: 'red',
      title: `${recon.monthsVariance} month${recon.monthsVariance > 1 ? 's' : ''} do not tie between the books and GSTR-3B`,
      detail: `Net difference on taxable value is ₹${Math.round(recon.turnoverDiff)}. Each variance needs a reason in the reconciliation statement.`,
    })
  }

  if (!input.eligibility.required) {
    out.push({
      id: 'exempt', level: 'info',
      title: 'Turnover for this year is below the annual return limit',
      detail: 'The workpaper is still useful as an audit file, but no GSTR-9 is due on the strength of these figures.',
    })
  }

  return out
}

/* ── local state (no schema change) ─────────────────────────────────────── */

const STATE_KEY = 'taxflow:gstr9:'

export interface Dues {
  /** Table 8/9 — amounts paid and outstanding cannot be derived from customer receipts. */
  taxPaidCash: number
  preDeposit: number
  interestPaid: number
  penaltyPaid: number
  lateFeePaid: number
  refundDue: number
  demandOutstanding: number
}

export interface FyState {
  version: 1
  months: Record<string, FiledMonth>
  dues: Dues
  reversals: { rule4243: Heads; other: Heads }
  updatedAt: string
}

export function emptyDues(): Dues {
  return { taxPaidCash: 0, preDeposit: 0, interestPaid: 0, penaltyPaid: 0, lateFeePaid: 0, refundDue: 0, demandOutstanding: 0 }
}

export function emptyFy(): FyState {
  return { version: 1, months: {}, dues: emptyDues(), reversals: { rule4243: emptyHeads(), other: emptyHeads() }, updatedAt: '' }
}

type Store = Record<string, FyState>

function readStore(oid: string): Store {
  try {
    const raw = localStorage.getItem(STATE_KEY + oid)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

/** FYs are keyed by label so an old entry survives a change of selector. */
export function loadFy(oid: string, fyStart: number): FyState {
  if (!oid) return emptyFy()
  return readStore(oid)[fyLabel(fyStart)] ?? emptyFy()
}

export function saveFy(oid: string, fyStart: number, state: FyState): FyState {
  const stamped: FyState = { ...state, updatedAt: new Date().toISOString() }
  try {
    const store = readStore(oid)
    store[fyLabel(fyStart)] = stamped
    localStorage.setItem(STATE_KEY + oid, JSON.stringify(store))
  } catch { /* private mode — the workpaper stays in memory */ }
  return stamped
}

export function isDeclared(state: FyState): boolean {
  return Object.keys(state.months).length > 0
}

/* ── export ─────────────────────────────────────────────────────────────── */

const HEAD_COLUMNS = ['Taxable', 'IGST', 'CGST', 'SGST', 'Cess', 'Total tax']

/** The workpaper is ragged — every section has its own shape — so it prints
 *  without a single header row. */
export function csvFromRows(rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return rows.map(r => r.map(esc).join(',')).join('\r\n')
}

/** The whole workpaper as one CSV — what a CA pastes into their own file. */
export function workpaperRows(args: {
  orgName: string
  gstin: string
  fyStart: number
  eligibility: Eligibility
  outward: OutwardRow[]
  rcm: RcmRow[]
  itc: ItcTable
  recon: ReconSummary
  atRisk: ItcAtRisk[]
  dues: Dues
}): (string | number)[][] {
  const { orgName, gstin, fyStart, eligibility: el, outward, rcm, itc, recon, atRisk, dues } = args
  const rows: (string | number)[][] = [
    ['GSTR-9 / 9C workpaper'],
    ['Business', orgName],
    ['GSTIN', gstin || '—'],
    ['Financial year', fyLabel(fyStart)],
    ['Prepared', new Date().toLocaleString('en-IN')],
    ['Applicability', el.form],
    ['Basis', el.reason],
    [],
    ['Table 4 — Outward supplies (books, after credit notes)'],
    ['Code', 'Description', 'Documents', ...HEAD_COLUMNS],
  ]

  const headCells = (h: Heads) => [h.taxable, h.igst, h.cgst, h.sgst, h.cess, h.tax]
  for (const r of outward) rows.push([r.code, r.label, r.count, ...headCells(r.heads)])
  rows.push(['', 'Total outward', '', ...headCells(sumHeads(outward.map(o => o.heads)))], [])

  rows.push(['Table 4.B — Inward supplies liable to reverse charge'], ['Description', 'Documents', ...HEAD_COLUMNS])
  if (!rcm.length) rows.push(['None flagged in the books', 0, 0, 0, 0, 0, 0])
  for (const r of rcm) rows.push([r.label, r.count, ...headCells(r.heads)])
  rows.push([])

  rows.push(['Table 5 — Input tax credit'], ['Section', 'Description', 'Documents', ...HEAD_COLUMNS])
  for (const [section, list] of [['5.A Available', itc.available], ['5.B Reversed / attributed', itc.reversed], ['5.C Ineligible', itc.ineligible]] as const) {
    if (!list.length) rows.push([section, 'Nothing in this head', 0, ...headCells(emptyHeads())])
    for (const r of list) rows.push([section, r.label, r.count, ...headCells(r.heads)])
  }
  rows.push(['', 'Net credit after reversals and block credits', '', ...headCells(itc.netHeads)], [])

  rows.push(['Section 16(4) watchlist — purchases unpaid beyond 180 days'], ['Document', 'Date', 'Party', 'Days outstanding', 'Amount unpaid', 'IGST', 'CGST', 'SGST'])
  if (!atRisk.length) rows.push(['No exposure', '', '', '', 0, 0, 0, 0])
  for (const r of atRisk) {
    rows.push([r.doc.number, r.doc.date ?? '', r.doc.party ?? '', r.days, round2(r.unpaid), r.heads.igst, r.heads.cgst, r.heads.sgst])
  }
  rows.push([])

  rows.push(['GSTR-9C reconciliation — books against GSTR-3B as filed'], ['Month', ...HEAD_COLUMNS, 'Filed taxable', 'Filed IGST', 'Filed CGST', 'Filed SGST', 'Difference taxable', 'Status', 'Heads differing', 'Note'])
  for (const r of recon.rows) {
    rows.push([
      r.month, ...headCells(r.books),
      r.filed?.taxable ?? '', r.filed?.igst ?? '', r.filed?.cgst ?? '', r.filed?.sgst ?? '',
      r.status === 'unset' ? '' : r.diff.taxable,
      r.status, r.heads.join(' / '), r.note ?? '',
    ])
  }
  rows.push(['Totals as per books', ...headCells(recon.booksTotal)], ['Totals as filed', ...headCells(recon.filedTotal)], ['Difference', ...headCells(recon.diffTotal)], [])

  rows.push(['Table 8 / 9 — dues and payments (declare from the portal)'])
  rows.push(['Tax paid in cash', round2(dues.taxPaidCash)])
  rows.push(['Pre-deposit', round2(dues.preDeposit)])
  rows.push(['Interest paid', round2(dues.interestPaid)])
  rows.push(['Penalty and fine', round2(dues.penaltyPaid)])
  rows.push(['Late fee', round2(dues.lateFeePaid)])
  rows.push(['Refund due', round2(dues.refundDue)])
  rows.push(['Demand outstanding', round2(dues.demandOutstanding)], [])
  rows.push(['Figures are derived from the books. The return is filed on gst.gov.in — reconcile before signing.'])
  return rows
}
