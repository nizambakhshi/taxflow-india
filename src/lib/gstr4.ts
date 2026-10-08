/**
 * GSTR-4 / CMP-08 composition-scheme workpaper.
 *
 * A composition dealer is not a small regular dealer: they charge a flat slab
 * of tax on their own bills, take no input tax credit at all, and in place of
 * that credit pay a fixed 2.5% of everything they bought (proviso to
 * s.17(5)(a)). Most software gets this wrong in one of two directions — either
 * it computes ITC the dealer cannot claim, or it quietly lets a composition
 * bill raise an inter-state supply that voids the scheme itself.
 *
 * So the workpaper answers four questions: is the scheme still allowed this
 * year, what was charged quarter by quarter against what CMP-08 paid, what the
 * 2.5% debit comes to, and which documents put the option at risk. Live
 * documents give the first three; the CMP-08 amounts actually deposited and
 * the value of stock transferred in are owner-declared and kept in
 * localStorage — never invented. Rates and thresholds move by notification, so
 * every function returns the rule it applied alongside the number.
 */

import { fyLabel, fyMonths, monthOf } from '@/lib/targets'
import {
  emptyHeads, headsOf, num, round2, sumHeads,
  type Heads,
} from '@/lib/gstr9'

/* ── shapes read from the database ──────────────────────────────────────── */

export interface CompDoc {
  id: string
  number: string
  date: string | null
  kind: 'invoice' | 'credit_note'
  /** `tax_invoice` or `bill_of_supply` — a composition dealer issues the latter. */
  invoiceType?: string | null
  party: string | null
  gstin: string | null
  placeOfSupply?: string | null
  supplyType?: string | null
  reverseCharge?: boolean
  taxable: number | string
  igst: number | string
  cgst: number | string
  sgst: number | string
  cess?: number | string | null
  total: number | string
}

/** One line of an outward document, only as far as the scheme test needs it. */
export interface CompItem {
  docId: string
  hsnSac: string | null
  taxable: number | string
}

/** Inward supply: purchase bill or expense. The 2.5% debit is computed on these. */
export interface CompInward {
  id: string
  number: string
  date: string | null
  party: string | null
  gstin: string | null
  taxable: number | string
  tax: number | string
  reverseCharge?: boolean
  source: 'bill' | 'expense'
}

/* ── statutory constants ────────────────────────────────────────────────── */

/**
 * Proviso to s.17(5)(a): in lieu of ITC, a composition taxable person pays this
 * share of the value of inward supplies. Notification 10/2017 cut it from 5%.
 */
export const DEEMED_ITC_PCT = 2.5

export const LIMIT_GOODS = 1_50_00_000
export const LIMIT_SERVICES = 50_00_000
/** Notification 17/2020 lower slabs for ten states. */
export const LIMIT_GOODS_SPECIAL = 75_00_000
export const LIMIT_SERVICES_SPECIAL = 25_00_000
export const SPECIAL_CATEGORY_STATES = ['02', '05', '11', '12', '13', '14', '15', '16', '17', '18']

/** A service provider under composition may also sell goods within this share. */
export const GOODS_SHARE_FOR_SERVICE_PROVIDER = 0.1
export const GOODS_SHARE_CAP = 50_00_000

/** CMP-08 is paid quarterly, by the 18th of the month after the quarter ends. */
export const CMP08_DUE_DAY = 18

/** Slabs a composition bill can legitimately carry: trader/manufacturer and
 *  services 1%, restaurant 0.5%, and the notified petroleum slabs for some states. */
export const COMPOSITION_RATES = [1, 0.5, 5, 6]

/** ₹1 per head: a consolidated quarterly figure rounds, a real difference does not. */
export const RECON_TOLERANCE = 1

/** Chapters a composition dealer may never deal in, whatever their turnover. */
export const EXCLUDED_GOODS: { prefix: string; label: string }[] = [
  { prefix: '2203', label: 'Alcohol for human consumption' },
  { prefix: '2204', label: 'Wine' },
  { prefix: '2205', label: 'Vermouth and flavoured wine' },
  { prefix: '2206', label: 'Other fermented beverages' },
  { prefix: '2207', label: 'Un-denatured industrial alcohol' },
  { prefix: '2401', label: 'Unmanufactured tobacco' },
  { prefix: '2402', label: 'Cigarettes and cigar IPs' },
  { prefix: '2403', label: 'Tobacco substitutes and pan masala' },
  { prefix: '2709', label: 'Petroleum crude oil' },
  { prefix: '2710', label: 'Motor spirit, diesel and lubricants' },
  { prefix: '3801', label: 'Graphite, including scintillating graphite' },
  { prefix: '8523', label: 'Blank optical and semiconductor media' },
]

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/

const signOf = (d: CompDoc) => (d.kind === 'credit_note' ? -1 : 1)
const headsOfDoc = (d: CompDoc) => headsOf(d.taxable, d.igst, d.cgst, d.sgst, d.cess ?? 0)
const scaled = (d: CompDoc): Heads => {
  const sign = signOf(d)
  const h = headsOfDoc(d)
  return {
    taxable: round2(h.taxable * sign), igst: round2(h.igst * sign), cgst: round2(h.cgst * sign),
    sgst: round2(h.sgst * sign), cess: round2(h.cess * sign), tax: round2(h.tax * sign),
  }
}
const hasGstin = (v: string | null | undefined) => GSTIN_SHAPE.test((v || '').trim().toUpperCase())
const stateOfPos = (pos: string | null | undefined) => (pos || '').trim().slice(0, 2)
const trim = (v: string | null | undefined) => (v || '').trim().toUpperCase()

/** Non-GST supplies are outside aggregate turnover and outside CMP-08 entirely. */
const isNonGst = (d: CompDoc) => (d.supplyType || '').toLowerCase() === 'non_gst'

/** SAC codes are the six-digit 99-series; anything else with a code is goods. */
export function isServiceCode(hsnSac: string | null | undefined): boolean {
  const code = trim(hsnSac)
  return code.length >= 6 && code.startsWith('99')
}
export function isGoodsCode(hsnSac: string | null | undefined): boolean {
  const code = trim(hsnSac)
  return code.length >= 4 && !isServiceCode(code)
}
export function excludedChapter(hsnSac: string | null | undefined): string | null {
  const code = trim(hsnSac)
  if (code.length < 4) return null
  const hit = EXCLUDED_GOODS.find(g => code.startsWith(g.prefix))
  return hit ? hit.label : null
}

/* ── FY quarters ────────────────────────────────────────────────────────── */

export const QUARTER_KEYS = ['Q1', 'Q2', 'Q3', 'Q4']
const QUARTER_LABELS: Record<string, string> = {
  Q1: 'Q1 · Apr–Jun', Q2: 'Q2 · Jul–Sep', Q3: 'Q3 · Oct–Dec', Q4: 'Q4 · Jan–Mar',
}

/** Which FY quarter a `YYYY-MM` month belongs to, or null if it is not this year. */
export function quarterOf(month: string, fyStart: number): string | null {
  const index = fyMonths(fyStart).indexOf(month)
  if (index < 0) return null
  return QUARTER_KEYS[Math.floor(index / 3)]
}

function fyMonthIndex(fyStart: number, index: number) {
  const m = (index + 3) % 12
  const y = fyStart + (index + 3 >= 12 ? 1 : 0)
  return { y, m: m + 1 }
}

/** CMP-08 for a quarter falls on the 18th of the following month. */
export function cmp08Due(fyStart: number, quarterIndex: number): string {
  const next = fyMonthIndex(fyStart, quarterIndex * 3 + 3)
  return `${next.y}-${String(next.m).padStart(2, '0')}-${String(CMP08_DUE_DAY).padStart(2, '0')}`
}

/** The annual statement for the year that ends in `fyStart + 1`. */
export function gstr4Due(fyStart: number): string {
  return `${fyStart + 1}-04-30`
}

/* ── 1. turnover, split the way the slab test needs it ───────────────────── */

export interface TurnoverSplit {
  goods: number
  services: number
  unknown: number
  /** What the slab test is applied to: GST-borne supplies, exempted included. */
  slabTurnover: number
  /** Non-GST supplies, reported separately because aggregate turnover excludes them. */
  nonGst: number
  documents: number
}

/**
 * A document's taxable value is shared between goods and services in the
 * proportion of its lines. A document with no priced lines, or lines with no
 * HSN/SAC, lands in `unknown` rather than being guessed into a slab.
 */
export function splitTurnover(docs: CompDoc[], items: CompItem[]): TurnoverSplit {
  const byDoc = new Map<string, { goods: number; services: number; total: number }>()
  for (const it of items) {
    const entry = byDoc.get(it.docId) || { goods: 0, services: 0, total: 0 }
    const value = num(it.taxable)
    entry.total += value
    if (isServiceCode(it.hsnSac)) entry.services += value
    else if (isGoodsCode(it.hsnSac)) entry.goods += value
    byDoc.set(it.docId, entry)
  }

  let goods = 0, services = 0, unknown = 0, nonGst = 0
  for (const doc of docs) {
    const taxable = num(doc.taxable) * signOf(doc)
    if (isNonGst(doc)) {
      nonGst += Math.abs(taxable)
      continue
    }
    const lines = byDoc.get(doc.id)
    if (!lines || lines.total <= 0 || lines.goods + lines.services <= 0) {
      unknown += taxable
      continue
    }
    // Share the document value by line weight, so a document whose lines carry no
    // code (or are missing) puts exactly the remaining part into `unknown`.
    const share = (value: number) => taxable * (value / lines.total)
    goods += share(lines.goods)
    services += share(lines.services)
    unknown += share(lines.total - lines.goods - lines.services)
  }

  const result: TurnoverSplit = {
    goods: round2(goods), services: round2(services), unknown: round2(unknown),
    slabTurnover: round2(goods + services + unknown), nonGst: round2(nonGst), documents: docs.length,
  }
  return result
}

/**
 * Nil-rated and exempted outward supplies: no slab tax is charged on them, but
 * aggregate turnover still counts them, so the slab test sees them. Non-GST
 * supplies are held out — they are reported on their own line.
 */
export function exemptTurnover(docs: CompDoc[]): number {
  return round2(docs.reduce((s, d) => {
    if (isNonGst(d)) return s
    if (headsOfDoc(d).tax > 1) return s
    return s + signOf(d) * num(d.taxable)
  }, 0))
}

/* ── 2. eligibility for the scheme ──────────────────────────────────────── */

export interface Eligibility {
  withinLimits: boolean
  category: 'special' | 'general'
  limits: { goods: number; services: number }
  headline: string
  reason: string
  points: string[]
  /** Turnover still available under the binding slab. Negative once exceeded. */
  headroom: number
  /** Crossed, or within a tenth of the slab — the exit has to be planned. */
  exitRisk: boolean
  /** A service provider whose goods leg has outgrown the 10% allowance. */
  goodsShareBreach: boolean
}

export function eligibility(split: TurnoverSplit, stateCode: string | null | undefined): Eligibility {
  const code = stateOfPos(stateCode)
  const category = SPECIAL_CATEGORY_STATES.includes(code) ? 'special' : 'general'
  const limits = category === 'special'
    ? { goods: LIMIT_GOODS_SPECIAL, services: LIMIT_SERVICES_SPECIAL }
    : { goods: LIMIT_GOODS, services: LIMIT_SERVICES }

  const goodsOver = split.goods > limits.goods
  const servicesOver = split.services > limits.services
  const exceeded = goodsOver || servicesOver
  // The slab with the least room left is the one the dealer has to watch.
  const goodsUsed = split.goods / limits.goods
  const servicesUsed = split.services / limits.services
  const binding = goodsUsed >= servicesUsed ? 'goods' : 'services'
  const headroom = round2(binding === 'goods' ? limits.goods - split.goods : limits.services - split.services)

  const points: string[] = [
    `Taxable goods supplies: ₹${Math.round(split.goods)} against the ₹${limits.goods} limit.`,
    `Taxable services supplies: ₹${Math.round(split.services)} against the ₹${limits.services} limit.`,
    category === 'special'
      ? `State code ${code || '—'} is one of the ten lower-slab states (Notification 17/2020).`
      : 'General limits apply (₹1.5 crore goods, ₹50 lakh services).',
  ]
  if (split.unknown > 0) {
    points.push(`₹${Math.round(split.unknown)} of turnover has no goods/service signal on its lines, so it is tested against both limits — fill the HSN/SAC to settle it.`)
  }

  const isServiceProvider = split.services > 0 && split.services >= split.goods
  const shareCap = round2(Math.min(split.slabTurnover * GOODS_SHARE_FOR_SERVICE_PROVIDER, GOODS_SHARE_CAP))
  const goodsShareBreach = isServiceProvider && split.goods > shareCap
  if (goodsShareBreach) {
    points.push(`A service provider under composition may sell goods up to 10% of turnover (₹${Math.round(shareCap)} here) — your goods supplies are ₹${Math.round(split.goods)}.`)
  }

  const headline = exceeded
    ? 'Turnover has crossed the composition limit — the option must be surrendered'
    : headroom < Math.min(limits.goods, limits.services) * 0.1
      ? 'Within the limit, but close enough that an exit needs planning'
      : 'Within the composition limits for the year'
  const reason = exceeded
    ? `${goodsOver ? 'Goods' : 'Services'} supplies of ₹${Math.round(goodsOver ? split.goods : split.services)} exceed the ₹${goodsOver ? limits.goods : limits.services} slab for ${category} states.`
    : `Aggregate taxable turnover ₹${Math.round(split.slabTurnover)} tested against the ${category} slabs. A rule moved by notification governs; re-check the slab you enrolled under.`

  return {
    withinLimits: !exceeded, category, limits, headline, reason, points,
    headroom, exitRisk: exceeded || headroom < Math.min(limits.goods, limits.services) * 0.1,
    goodsShareBreach,
  }
}

/* ── 3. quarterly liability against what CMP-08 paid ─────────────────────── */

export interface DeclaredQuarter {
  taxable: number
  igst: number
  cgst: number
  sgst: number
  /** Free text for a quarter that does not tie. */
  note?: string
}

export interface QuarterRow {
  key: string
  label: string
  months: string[]
  due: string
  count: number
  heads: Heads
  /** Tax ÷ taxable for the quarter, so a wrong slab shows up as an odd number. */
  impliedPct: number
  declared: DeclaredQuarter | null
  diff: Heads
  status: 'unset' | 'matched' | 'variance'
  headsDiffering: string[]
}

export function quarterlyLiability(docs: CompDoc[], fyStart: number, declared: Record<string, DeclaredQuarter>): QuarterRow[] {
  const months = fyMonths(fyStart)
  return QUARTER_KEYS.map((key, qi) => {
    const qMonths = months.slice(qi * 3, qi * 3 + 3)
    const inQuarter = docs.filter(d => {
      if (isNonGst(d)) return false
      const m = monthOf(d.date)
      return m ? qMonths.includes(m) : false
    })
    const heads = sumHeads(inQuarter.map(scaled))
    const count = inQuarter.filter(d => d.kind === 'invoice').length
    const impliedPct = heads.taxable > 0 ? round2((heads.tax / heads.taxable) * 100) : 0

    const entry = declared[key]
    if (!entry) {
      return {
        key, label: QUARTER_LABELS[key], months: qMonths, due: cmp08Due(fyStart, qi),
        count, heads, impliedPct, declared: null, diff: emptyHeads(), status: 'unset' as const, headsDiffering: [],
      }
    }
    const filed = headsOf(entry.taxable, entry.igst, entry.cgst, entry.sgst, 0)
    const diff: Heads = {
      taxable: round2(heads.taxable - filed.taxable), igst: round2(heads.igst - filed.igst),
      cgst: round2(heads.cgst - filed.cgst), sgst: round2(heads.sgst - filed.sgst),
      cess: round2(heads.cess - filed.cess), tax: round2(heads.tax - filed.tax),
    }
    const headsDiffering: string[] = []
    if (Math.abs(diff.taxable) > RECON_TOLERANCE) headsDiffering.push('Taxable value')
    for (const h of ['igst', 'cgst', 'sgst'] as const) {
      if (Math.abs(diff[h]) > RECON_TOLERANCE) headsDiffering.push(h.toUpperCase())
    }
    return {
      key, label: QUARTER_LABELS[key], months: qMonths, due: cmp08Due(fyStart, qi),
      count, heads, impliedPct, declared: entry, diff,
      status: headsDiffering.length ? ('variance' as const) : ('matched' as const),
      headsDiffering,
    }
  })
}

/* ── 4. rate sanity on the individual bill ──────────────────────────────── */

export interface RateAnomaly {
  number: string
  date: string | null
  taxable: number
  tax: number
  pct: number
  /** The slab this rate sits on, or null when it looks like a regular-dealer rate. */
  nearest: number | null
}

/**
 * A composition bill should imply 0.5%, 1%, 5% or 6% overall. Anything else is
 * a regular-dealer rate left on a bill of supply, and the tax is not due at all.
 */
export function rateAnomalies(docs: CompDoc[]): RateAnomaly[] {
  const out: RateAnomaly[] = []
  for (const d of docs) {
    if (d.kind !== 'invoice') continue
    const h = headsOfDoc(d)
    if (h.taxable <= 0) continue
    const pct = round2((h.tax / h.taxable) * 100)
    if (pct === 0) continue
    const nearest = COMPOSITION_RATES.reduce((best, r) =>
      Math.abs(r - pct) < Math.abs(best - pct) ? r : best, COMPOSITION_RATES[0])
    if (Math.abs(nearest - pct) > 0.05) {
      // 12% or 18% is not "6% done badly" — it is a different scheme, so say so.
      const slab = Math.abs(nearest - pct) <= 1 ? nearest : null
      out.push({ number: d.number, date: d.date, taxable: round2(h.taxable), tax: round2(h.tax), pct, nearest: slab })
    }
  }
  return out
}

/* ── 5. documents that put the scheme at risk ───────────────────────────── */

export type RiskLevel = 'error' | 'warn'

export interface RiskRow {
  key: string
  level: RiskLevel
  title: string
  detail: string
  count: number
  amount: number
  numbers: string[]
}

export function schemeRisks(docs: CompDoc[], items: CompItem[], stateCode: string | null | undefined): RiskRow[] {
  const home = stateOfPos(stateCode)
  const rows: RiskRow[] = []
  const push = (row: Omit<RiskRow, 'numbers'> & { numbers: string[] }) => rows.push(row)

  const interState = docs.filter(d => {
    const pos = stateOfPos(d.placeOfSupply)
    return pos && pos !== '99' && home && pos !== home
  })
  if (interState.length) {
    push({
      key: 'inter_state', level: 'error',
      title: 'Inter-state outward supply', count: interState.length,
      amount: round2(sumHeads(interState.map(scaled)).taxable),
      detail: 'A composition dealer may not make inter-state taxable supplies. Stock transfer to another GSTIN of the same PAN is the notified exception, and it carries the 2.5% debit.',
      numbers: interState.slice(0, 6).map(d => d.number),
    })
  }

  const exports = docs.filter(d => ['export', 'sez'].includes((d.supplyType || '').toLowerCase()))
  if (exports.length) {
    push({
      key: 'export', level: 'error',
      title: 'Export or SEZ supply', count: exports.length,
      amount: round2(sumHeads(exports.map(scaled)).taxable),
      detail: 'Zero-rated supplies take you out of the composition scheme — a dealer paying tax at a flat slab cannot claim a refund or a LUT export.',
      numbers: exports.slice(0, 6).map(d => d.number),
    })
  }

  const taxInvoices = docs.filter(d => d.kind === 'invoice' && (d.invoiceType || '').toLowerCase() === 'tax_invoice')
  if (taxInvoices.length) {
    push({
      key: 'document_type', level: 'warn',
      title: 'Raised as a tax invoice, not a bill of supply', count: taxInvoices.length,
      amount: round2(sumHeads(taxInvoices.map(scaled)).taxable),
      detail: 'Section 9(3) of the Composition rules: a composition taxable person issues a bill of supply, and it must carry the words “composition taxable person, not eligible to collect tax on supplies”.',
      numbers: taxInvoices.slice(0, 6).map(d => d.number),
    })
  }

  const byDoc = new Map<string, CompDoc>()
  for (const d of docs) byDoc.set(d.id, d)
  const banned = new Map<string, { amount: number; numbers: string[] }>()
  for (const it of items) {
    const label = excludedChapter(it.hsnSac)
    if (!label) continue
    const doc = byDoc.get(it.docId)
    if (!doc) continue
    const entry = banned.get(label) || { amount: 0, numbers: [] }
    entry.amount += num(it.taxable) * signOf(doc)
    if (!entry.numbers.includes(doc.number)) entry.numbers.push(doc.number)
    banned.set(label, entry)
  }
  for (const [label, entry] of [...banned.entries()].sort((a, b) => b[1].amount - a[1].amount)) {
    push({
      key: `excluded_${label}`, level: 'error',
      title: `Goods not permitted under composition — ${label}`, count: entry.numbers.length,
      amount: round2(entry.amount),
      detail: 'These chapters are outside the scheme entirely. The value also sits outside GST, so it is not part of aggregate turnover for the slab test.',
      numbers: entry.numbers.slice(0, 6),
    })
  }

  const rcOutward = docs.filter(d => d.kind === 'invoice' && d.reverseCharge)
  if (rcOutward.length) {
    push({
      key: 'rcm_outward', level: 'warn',
      title: 'Outward supply marked as reverse charge', count: rcOutward.length,
      amount: round2(sumHeads(rcOutward.map(scaled)).taxable),
      detail: 'A composition dealer collects tax at a flat slab from a registered supplier, not from anyone else. An outward bill flagged reverse charge is a regular-dealer field left on the document.',
      numbers: rcOutward.slice(0, 6).map(d => d.number),
    })
  }

  return rows
}

/* ── 6. the 2.5% debit that replaces ITC ────────────────────────────────── */

export interface DeemedBucket {
  key: string
  label: string
  count: number
  base: number
  debit: number
  /** The credit a regular dealer would have taken instead. */
  creditForgone: number
}

export interface DeemedResult {
  buckets: DeemedBucket[]
  base: number
  debit: number
  creditForgone: number
  rcmExcluded: { count: number; base: number; taxPaid: number }
  pct: number
}

/**
 * The flat debit is charged on the value of inward supplies. Inward supplies on
 * which the dealer already paid tax under reverse charge are kept out of the
 * base — charging both would bill the same supply twice.
 */
export function deemedReversal(inward: CompInward[], stockTransferValue = 0): DeemedResult {
  const normal = inward.filter(d => !d.reverseCharge)
  const rcm = inward.filter(d => d.reverseCharge)

  const registered = normal.filter(d => hasGstin(d.gstin))
  const unregistered = normal.filter(d => !hasGstin(d.gstin))

  const bucket = (key: string, label: string, rows: { taxable: number | string; tax: number | string }[], baseOverride?: number): DeemedBucket => {
    const base = baseOverride ?? round2(rows.reduce((s, r) => s + num(r.taxable), 0))
    return {
      key, label, count: rows.length, base,
      debit: round2(base * DEEMED_ITC_PCT / 100),
      creditForgone: round2(rows.reduce((s, r) => s + num(r.tax), 0)),
    }
  }

  const buckets = [
    bucket('registered', 'Purchases and services from registered suppliers', registered),
    bucket('unregistered', 'Purchases and services from unregistered suppliers', unregistered),
  ]
  if (stockTransferValue > 0) {
    buckets.push({
      key: 'stock', label: 'Stock transferred in from another GSTIN of the same PAN',
      count: 0, base: round2(stockTransferValue),
      debit: round2(stockTransferValue * DEEMED_ITC_PCT / 100), creditForgone: 0,
    })
  }

  return {
    buckets: buckets.filter(b => b.base !== 0),
    base: round2(buckets.reduce((s, b) => s + b.base, 0)),
    debit: round2(buckets.reduce((s, b) => s + b.debit, 0)),
    creditForgone: round2(buckets.reduce((s, b) => s + b.creditForgone, 0)),
    rcmExcluded: {
      count: rcm.length,
      base: round2(rcm.reduce((s, d) => s + num(d.taxable), 0)),
      taxPaid: round2(rcm.reduce((s, d) => s + num(d.tax), 0)),
    },
    pct: DEEMED_ITC_PCT,
  }
}

/* ── 7. the whole workpaper ─────────────────────────────────────────────── */

export interface WorkpaperInput {
  fyStart: number
  /** Two-digit state code from the primary GSTIN. */
  stateCode: string | null | undefined
  docs: CompDoc[]
  items: CompItem[]
  inward: CompInward[]
  state: FyState
}

export interface Workpaper {
  split: TurnoverSplit
  eligibility: Eligibility
  quarters: QuarterRow[]
  /** Nil-rated and exempted outward value — inside turnover, outside the tax. */
  exempt: number
  /** Tax charged on outward supplies for the year. */
  liability: Heads
  anomalies: RateAnomaly[]
  risks: RiskRow[]
  deemed: DeemedResult
  declaredQuarters: number
  declaredTotal: Heads
  diffTotal: Heads
  quartersVariance: number
  /** Outward tax plus the flat debit — all of it payable in cash. */
  payableInCash: number
}

export function buildWorkpaper({ fyStart, stateCode, docs, items, inward, state }: WorkpaperInput): Workpaper {
  const split = splitTurnover(docs, items)
  // Non-GST supplies are reported separately: they carry no slab tax, so they
  // belong neither in the yearly liability nor in a CMP-08 quarter.
  const charged = docs.filter(d => !isNonGst(d))
  const quarters = quarterlyLiability(charged, fyStart, state.quarters)
  const liability = sumHeads(charged.map(scaled))
  const declaredRows = quarters.filter(q => q.declared)
  const deemed = deemedReversal(inward, state.stockTransferValue)
  return {
    split,
    eligibility: eligibility(split, stateCode),
    quarters,
    exempt: exemptTurnover(docs),
    liability,
    anomalies: rateAnomalies(docs),
    risks: schemeRisks(docs, items, stateCode),
    deemed,
    declaredQuarters: declaredRows.length,
    declaredTotal: sumHeads(declaredRows.map(q => headsOf(q.declared!.taxable, q.declared!.igst, q.declared!.cgst, q.declared!.sgst, 0))),
    diffTotal: sumHeads(declaredRows.map(q => q.diff)),
    quartersVariance: quarters.filter(q => q.status === 'variance').length,
    payableInCash: round2(liability.tax + deemed.debit),
  }
}

/* ── local state (no schema change) ─────────────────────────────────────── */

const STATE_KEY = 'taxflow:gstr4:'

export interface FyState {
  version: 1
  /** CMP-08 figures as deposited, per quarter — declared, never derived. */
  quarters: Record<string, DeclaredQuarter>
  /** Value of stock transferred in from other GSTINs of the same PAN. */
  stockTransferValue: number
  updatedAt: string
}

export function emptyFy(): FyState {
  return { version: 1, quarters: {}, stockTransferValue: 0, updatedAt: '' }
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
  return Object.keys(state.quarters).length > 0
}

/* ── export ─────────────────────────────────────────────────────────────── */

/** The whole workpaper as one ragged CSV — what a CA pastes into their file. */
export function workpaperRows(args: {
  orgName: string
  gstin: string
  fyStart: number
  wp: Workpaper
}): (string | number)[][] {
  const { orgName, gstin, fyStart, wp } = args
  const head = (h: Heads) => [h.taxable, h.igst, h.cgst, h.sgst, h.cess, h.tax]
  const rows: (string | number)[][] = [
    ['GSTR-4 / CMP-08 composition workpaper'],
    ['Business', orgName],
    ['GSTIN', gstin || '—'],
    ['Financial year', fyLabel(fyStart)],
    ['Prepared', new Date().toLocaleString('en-IN')],
    ['Annual statement due', gstr4Due(fyStart)],
    ['Scheme eligibility', wp.eligibility.headline],
    ['Basis', wp.eligibility.reason],
    ...wp.eligibility.points.map(p => ['', p]),
    [],
    ['Table 1(A) — Taxable outward supplies and tax charged'],
    ['Taxable (goods)', 'Taxable (services)', 'Taxable (no HSN/SAC)', 'Non-GST (outside turnover)', 'Nil-rated & exempted', ...head(wp.liability)],
    [wp.split.goods, wp.split.services, wp.split.unknown, wp.split.nonGst, wp.exempt, ...head(wp.liability)],
    [],
    ['CMP-08 — quarterly liability against tax deposited'],
    ['Quarter', 'Months', 'Due', 'Documents', 'Books taxable', 'Books IGST', 'Books CGST', 'Books SGST', 'Books tax', 'Implied rate %', 'Declared taxable', 'Declared tax', 'Difference taxable', 'Status', 'Heads differing', 'Note'],
  ]

  for (const q of wp.quarters) {
    rows.push([
      q.key, q.months.join(' / '), q.due, q.count,
      q.heads.taxable, q.heads.igst, q.heads.cgst, q.heads.sgst, q.heads.tax, q.impliedPct,
      q.declared?.taxable ?? '', q.declared ? round2(num(q.declared.igst) + num(q.declared.cgst) + num(q.declared.sgst)) : '',
      q.status === 'unset' ? '' : q.diff.taxable, q.status, q.headsDiffering.join(' / '), q.declared?.note ?? '',
    ])
  }

  rows.push([], ['Bills of supply whose rate is not a composition slab'])
  rows.push(['Document', 'Date', 'Taxable', 'Tax', 'Rate on the bill %', 'Composition slab it matches'])
  if (!wp.anomalies.length) rows.push(['None', '', '', '', '', ''])
  for (const a of wp.anomalies) rows.push([a.number, a.date ?? '', a.taxable, a.tax, a.pct, a.nearest ?? 'none — looks like a regular-dealer rate'])

  rows.push([], ['Documents that put the composition option at risk'])
  rows.push(['Level', 'Finding', 'Documents', 'Value', 'Detail'])
  if (!wp.risks.length) rows.push(['clear', 'No barred supply found in the year', 0, 0, ''])
  for (const r of wp.risks) rows.push([r.level, r.title, r.count, r.amount, r.detail])

  rows.push([], [`Table 1(C)/(D) — deemed debit of ${wp.deemed.pct}% in lieu of ITC`])
  rows.push(['Head', 'Documents', 'Value of inward supplies', 'Debit payable in cash', 'ITC forgone'])
  for (const b of wp.deemed.buckets) rows.push([b.label, b.count, b.base, b.debit, b.creditForgone])
  rows.push(['Total', '', wp.deemed.base, wp.deemed.debit, wp.deemed.creditForgone])
  rows.push(['Excluded: inward supplies on which tax was paid under reverse charge',
    wp.deemed.rcmExcluded.count, wp.deemed.rcmExcluded.base, 0, wp.deemed.rcmExcluded.taxPaid])

  rows.push([], ['Payment summary'])
  rows.push(['Tax charged on outward supplies', wp.liability.tax])
  rows.push([`Deemed ITC debit at ${wp.deemed.pct}%`, wp.deemed.debit])
  rows.push(['Total payable in cash', wp.payableInCash], [])
  rows.push(['Figures are derived from the books. CMP-08 and GSTR-4 are filed on gst.gov.in — reconcile before signing.'])
  return rows
}
