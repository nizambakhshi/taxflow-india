// Multi-currency — the currency layer that sits *beside* the books, not inside them.
//
// It lives on localStorage (ADR-013) because `invoices` has no currency or exchange-rate
// column and none is being asked for until the Phase 14 schema window. What the GST law
// actually needs stays in Postgres and stays in rupees: Rule 45 of the CGST Rules values a
// foreign-currency supply in INR at the rate notified for that date — in practice the RBI
// reference rate on the invoice date (for exports, the FEDI rate for drawing bills of
// export). So the tax, the HSN summary, GSTR-1 and every workpaper keep reading the rupee
// figures exactly as they do today. This module owns the other half of the truth: which
// currency the deal was struck in, what rate converted it, and what the money was worth
// when it landed.
//
// Four decisions are load-bearing:
//  * **A rate is a dated record with a source.** `taxflow:fx:<orgId>` keeps one row per
//    currency per day, stamped `manual` (typed from the RBI notification or the bank card)
//    or `feed` (a published reference table pulled in from the browser). The stamp is the
//    point: a rate that came from an ECB-style reference table is not the Rule 45 rate, and
//    nothing here pretends otherwise. `rateFor()` returns `null` rather than inventing a
//    number, so an entry with no rate for its date shows up as work to do, not as a guess.
//  * **Entries join to the books by invoice number.** The number is the key a human reads on
//    the paper, the thing the bank's remittance advice quotes, and the one column that is
//    stable across every route an invoice can arrive through. A matched entry cross-checks
//    the rupee value recorded here against the invoice's own `grand_total`; an unmatched one
//    says so instead of quietly rolling up.
//  * **Three rupee numbers, never averaged into one.** The rate you used, the rate the books
//    imply (`grand_total ÷ foreign value`), and today's rate. Realised gain/loss is measured
//    against the rate used, exposure against today's rate, and a gap between used and implied
//    is shown as a discrepancy to resolve — not silently corrected.
//  * **Receiving money here does not receive it in the books.** A receipt records what the
//    bank actually credited in rupees; the ledger entry still belongs on /payments (the same
//    one-writer rule /bank follows). When an FX entry looks settled while the invoice still
//    shows a balance, the view reports the outstanding rupees rather than assuming either
//    side is wrong.

import { newId, todayISO } from '@/lib/batches'
import { plural } from '@/lib/format'

export { todayISO }

const KEY_FX = 'taxflow:fx:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const FX_VERSION = 1

/** A rate older than this is worth a second look before it revalues an exposure. */
export const RATE_STALE_AFTER_DAYS = 7

/** Rupee amounts round to the paisa; the books do the same, so the cross-check is fair. */
const EPSILON = 0.5

export interface FxCurrency {
  code: string
  name: string
  symbol: string
  /** JPY and KRW are invoiced in whole units; a "1,234.56 JPY" line is not a real thing. */
  digits: number
  /** In the one-key ECB-style reference feed, which is not every currency we trade in. */
  in_reference_feed: boolean
}

/**
 * The currencies an Indian exporter or importer is likely to be paid in, plus the rupee —
 * which is the book currency, so it never appears in a rate row or an entry.
 */
export const CURRENCIES: FxCurrency[] = [
  { code: 'USD', name: 'US Dollar', symbol: '$', digits: 2, in_reference_feed: true },
  { code: 'EUR', name: 'Euro', symbol: '€', digits: 2, in_reference_feed: true },
  { code: 'GBP', name: 'Pound Sterling', symbol: '£', digits: 2, in_reference_feed: true },
  { code: 'AED', name: 'UAE Dirham', symbol: 'AED', digits: 2, in_reference_feed: false },
  { code: 'SAR', name: 'Saudi Riyal', symbol: 'SAR', digits: 2, in_reference_feed: false },
  { code: 'KWD', name: 'Kuwaiti Dinar', symbol: 'KWD', digits: 3, in_reference_feed: false },
  { code: 'QAR', name: 'Qatari Riyal', symbol: 'QAR', digits: 2, in_reference_feed: false },
  { code: 'OMR', name: 'Omani Rial', symbol: 'OMR', digits: 3, in_reference_feed: false },
  { code: 'SGD', name: 'Singapore Dollar', symbol: 'S$', digits: 2, in_reference_feed: true },
  { code: 'MYR', name: 'Malaysian Ringgit', symbol: 'RM', digits: 2, in_reference_feed: true },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$', digits: 2, in_reference_feed: true },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$', digits: 2, in_reference_feed: true },
  { code: 'CHF', name: 'Swiss Franc', symbol: 'Fr', digits: 2, in_reference_feed: true },
  { code: 'CNY', name: 'Chinese Yuan', symbol: '¥', digits: 2, in_reference_feed: true },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥', digits: 0, in_reference_feed: true },
  { code: 'HKD', name: 'Hong Kong Dollar', symbol: 'HK$', digits: 2, in_reference_feed: true },
  { code: 'KRW', name: 'South Korean Won', symbol: '₩', digits: 0, in_reference_feed: true },
  { code: 'THB', name: 'Thai Baht', symbol: '฿', digits: 2, in_reference_feed: true },
  { code: 'ZAR', name: 'South African Rand', symbol: 'R', digits: 2, in_reference_feed: true },
  { code: 'TRY', name: 'Turkish Lira', symbol: '₺', digits: 2, in_reference_feed: true },
  { code: 'NZD', name: 'New Zealand Dollar', symbol: 'NZ$', digits: 2, in_reference_feed: true },
  { code: 'INR', name: 'Indian Rupee', symbol: '₹', digits: 2, in_reference_feed: false },
]

const BY_CODE = new Map(CURRENCIES.map(c => [c.code, c]))

export function currencyOf(code: string): FxCurrency | null {
  return BY_CODE.get((code || '').toUpperCase().trim()) || null
}

/** The picker never offers the book currency — converting rupees into rupees is a no-op row. */
export const TRADABLE_CURRENCIES = CURRENCIES.filter(c => c.code !== 'INR')

export function round2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

/** 96.78 per dollar → ₹96.78; a whole rupee grid reads with paise, a foreign value does not. */
export function inr(v: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format(round2(v))
}

/** Foreign amounts in their own currency, honouring `digits` (JPY has no subunit). */
export function foreign(value: number, code: string): string {
  const c = currencyOf(code)
  if (!c) return `${round2(value)} ${code || ''}`.trim()
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: c.code,
      minimumFractionDigits: c.digits, maximumFractionDigits: c.digits,
    }).format(value)
  } catch {
    return `${value.toFixed(c.digits)} ${c.code}`
  }
}

/** A rate is always ₹ per one unit of the foreign currency — one direction, no ambiguity. */
export function rateLabel(rate: number, code: string): string {
  const n = Number(rate)
  const decimals = Number.isFinite(n) ? (String(n).split('.')[1] || '').length : 2
  return `₹${(Number.isFinite(n) ? n : 0).toFixed(Math.min(4, Math.max(2, decimals)))} = 1 ${code}`
}

// ── stored shapes ─────────────────────────────────────────────────────────────

export type RateSource = 'manual' | 'feed'

export interface FxRate {
  code: string
  /** Rupees per one unit of `code`. */
  rate: number
  /** YYYY-MM-DD the rate applies to — never the day it was typed. */
  as_of: string
  source: RateSource
  note: string
}

export interface FxReceipt {
  id: string
  date: string
  /** Foreign currency actually received. */
  foreign: number
  /** Rupees the bank actually credited, after realisation charges. */
  inr: number
  reference: string
}

export interface FxEntry {
  id: string
  /** The join to the books — the number printed on the document. */
  invoice_number: string
  invoice_date: string
  party_name: string
  currency: string
  /** Contract value in the foreign currency. */
  foreign_value: number
  /** The Rule 45 rate the rupee figure was written at. */
  booked_rate: number
  /** The rupee value sitting in the books for this invoice. */
  booked_inr: number
  notes: string
  receipts: FxReceipt[]
  created_at: string
}

export interface FxStore {
  version: number
  updatedAt: string
  orgId: string
  rates: FxRate[]
  entries: FxEntry[]
}

export function emptyFx(orgId = ''): FxStore {
  return { version: FX_VERSION, updatedAt: todayISO(), orgId, rates: [], entries: [] }
}

/** The invoice fields an entry needs, read from whatever route the invoice arrived by. */
export interface FxBookInvoice {
  invoice_number: string
  invoice_date: string
  customer_name: string
  grand_total: number
  balance_due: number
  status?: string
  payment_status?: string
}

// ── storage ───────────────────────────────────────────────────────────────────

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(y: number, m: number): number {
  if (m !== 2) return DAYS_IN_MONTH[m - 1]
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  return leap ? 29 : 28
}

/**
 * A real calendar day, not just twelve digits with dashes: a rate recorded for
 * "2026-13-01" would sort after every genuine day and then quietly revalue a year.
 */
function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function parseRate(raw: unknown): FxRate | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const code = typeof r.code === 'string' ? r.code.toUpperCase().trim() : ''
  if (!currencyOf(code) || code === 'INR') return null
  if (!isDate(r.as_of)) return null
  const rate = num(r.rate)
  if (rate <= 0) return null
  return {
    code,
    rate,
    as_of: r.as_of,
    source: r.source === 'feed' ? 'feed' : 'manual',
    note: typeof r.note === 'string' ? r.note : '',
  }
}

function parseReceipt(raw: unknown): FxReceipt | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const foreignAmt = num(r.foreign)
  if (foreignAmt <= 0 || !isDate(r.date)) return null
  return {
    id: typeof r.id === 'string' && r.id ? r.id : newId(),
    date: r.date,
    foreign: foreignAmt,
    inr: num(r.inr),
    reference: typeof r.reference === 'string' ? r.reference : '',
  }
}

function parseEntry(raw: unknown): FxEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const number = typeof e.invoice_number === 'string' ? e.invoice_number.trim() : ''
  const code = typeof e.currency === 'string' ? e.currency.toUpperCase().trim() : ''
  // An entry needs a document to hang on and a currency to hang it in.
  if (!number || !currencyOf(code) || code === 'INR') return null
  if (!isDate(e.invoice_date)) return null
  const foreignValue = num(e.foreign_value)
  const bookedRate = num(e.booked_rate)
  if (foreignValue <= 0 || bookedRate <= 0) return null
  const receipts = Array.isArray(e.receipts)
    ? e.receipts.map(parseReceipt).filter((x): x is FxReceipt => x !== null)
    : []
  return {
    id: typeof e.id === 'string' && e.id ? e.id : newId(),
    invoice_number: number,
    invoice_date: e.invoice_date,
    party_name: typeof e.party_name === 'string' ? e.party_name : '',
    currency: code,
    foreign_value: foreignValue,
    booked_rate: bookedRate,
    booked_inr: num(e.booked_inr),
    notes: typeof e.notes === 'string' ? e.notes : '',
    receipts,
    created_at: typeof e.created_at === 'string' ? e.created_at : todayISO(),
  }
}

export function parseFx(raw: string | null): FxStore {
  if (!raw) return emptyFx()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyFx()
  }
  if (!parsed || typeof parsed !== 'object') return emptyFx()
  const s = parsed as Record<string, unknown>
  if (s.version !== FX_VERSION) return emptyFx(typeof s.orgId === 'string' ? s.orgId : '')
  const rates = Array.isArray(s.rates) ? s.rates.map(parseRate).filter((x): x is FxRate => x !== null) : []
  const entries = Array.isArray(s.entries)
    ? s.entries.map(parseEntry).filter((x): x is FxEntry => x !== null)
    : []
  return {
    version: FX_VERSION,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : todayISO(),
    orgId: typeof s.orgId === 'string' ? s.orgId : '',
    rates: dedupeRates(rates),
    entries,
  }
}

/** One rate per currency per day; the later write wins, so a corrected feed beats a typo. */
export function dedupeRates(rates: FxRate[]): FxRate[] {
  const seen = new Map<string, FxRate>()
  for (const r of rates) seen.set(`${r.code}:${r.as_of}`, r)
  return [...seen.values()].sort((a, b) => (a.as_of === b.as_of ? a.code.localeCompare(b.code) : a.as_of < b.as_of ? 1 : -1))
}

export function loadFx(orgId: string): FxStore {
  if (typeof window === 'undefined' || !orgId) return emptyFx()
  try {
    const store = parseFx(window.localStorage.getItem(KEY_FX + orgId))
    return { ...store, orgId }
  } catch {
    return emptyFx(orgId)
  }
}

export function saveFx(orgId: string, store: FxStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_FX + orgId,
      JSON.stringify({ ...store, orgId, version: FX_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: FxStore) => FxStore): FxStore {
  const next = fn(loadFx(orgId))
  saveFx(orgId, next)
  return next
}

// ── the rate ledger ───────────────────────────────────────────────────────────

export interface RateLookup {
  rate: number
  as_of: string
  source: RateSource
  /** The rate is not from the entry's own day — say so wherever it is shown. */
  carried: boolean
  age_days: number
}

const DAY = 86400000

function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(`${fromISO}T12:00:00Z`)
  const b = Date.parse(`${toISO}T12:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.round((b - a) / DAY)
}

/**
 * The newest recorded rate for `code` on or before `date`. ISO dates sort as strings, so
 * this is a filter, not a parse. `null` is the honest answer when nothing has been recorded
 * — the alternative is a rupee figure nobody signed off.
 */
export function rateFor(rates: FxRate[], code: string, date: string): RateLookup | null {
  const key = (code || '').toUpperCase()
  if (!key || key === 'INR' || !isDate(date)) return null
  const candidates = rates
    .filter(r => r.code === key && r.as_of <= date)
    .sort((a, b) => (a.as_of < b.as_of ? 1 : -1))
  const hit = candidates[0]
  if (!hit) return null
  return {
    rate: hit.rate,
    as_of: hit.as_of,
    source: hit.source,
    carried: hit.as_of !== date,
    age_days: daysBetween(hit.as_of, date),
  }
}

export function latestRate(rates: FxRate[], code: string): RateLookup | null {
  return rateFor(rates, code, '9999-12-31')
}

/** Newest row per currency, for the rate table and the revaluation line. */
export function currentRates(store: FxStore): FxRate[] {
  const seen = new Map<string, FxRate>()
  for (const r of [...store.rates].sort((a, b) => (a.as_of < b.as_of ? 1 : -1))) {
    if (!seen.has(r.code)) seen.set(r.code, r)
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
}

export function validateRate(rate: FxRate, existing: FxRate[]): string[] {
  const problems: string[] = []
  const c = currencyOf(rate.code)
  if (!c) problems.push('Unknown currency code')
  else if (c.code === 'INR') problems.push('The rupee is the book currency — there is no rate to record for it')
  if (!isDate(rate.as_of)) problems.push('The rate needs the day it applies to (YYYY-MM-DD)')
  if (!(rate.rate > 0)) problems.push('A rate is a positive number of rupees per one unit')
  // An inverted quote is the commonest way a rate goes wrong, and a swing check misses it:
  // 0.012 against ₹83 is 99.98% *below* the last row, never "more than a doubling". So the
  // test is the ratio between the two, whichever way round the mistake sits.
  const prev = latestRate(existing, rate.code)
  if (prev && prev.rate > 0 && rate.rate > 0) {
    const ratio = Math.max(rate.rate, prev.rate) / Math.min(rate.rate, prev.rate)
    if (ratio > 2) {
      problems.push(`${c?.code || rate.code} was ${rateLabel(prev.rate, c?.code || rate.code)} on ${prev.as_of} — ${rate.rate.toFixed(4)} is nowhere near it. Check the rate is rupees per one unit, not units per rupee.`)
    }
  }
  return problems
}

/** Upsert by (code, as_of) — re-recording a day corrects it rather than stacking a second row. */
export function setRate(orgId: string, rate: FxRate): { ok: boolean; error: string; store: FxStore } {
  const store = loadFx(orgId)
  const problems = validateRate(rate, store.rates)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: FxRate = {
    ...rate,
    code: rate.code.toUpperCase(),
    // Four places: a rate is quoted to the paisa and a JPY row needs the digits beyond it.
    rate: Math.round(rate.rate * 10000) / 10000,
    as_of: rate.as_of,
    source: rate.source === 'feed' ? 'feed' : 'manual',
    note: (rate.note || '').trim(),
  }
  const rest = store.rates.filter(r => !(r.code === clean.code && r.as_of === clean.as_of))
  const next: FxStore = { ...store, rates: dedupeRates([...rest, clean]) }
  saveFx(orgId, next)
  return { ok: true, error: '', store: next }
}

export function deleteRate(orgId: string, code: string, asOf: string): FxStore {
  return mutate(orgId, store => ({
    ...store,
    rates: store.rates.filter(r => !(r.code === code.toUpperCase() && r.as_of === asOf)),
  }))
}

// ── entries and receipts ──────────────────────────────────────────────────────

export function emptyEntry(): FxEntry {
  return {
    id: newId(),
    invoice_number: '',
    invoice_date: todayISO(),
    party_name: '',
    currency: 'USD',
    foreign_value: 0,
    booked_rate: 0,
    booked_inr: 0,
    notes: '',
    receipts: [],
    created_at: todayISO(),
  }
}

/** Start an entry from a real invoice so the rupee side cannot drift from the books. */
export function entryFromInvoice(inv: FxBookInvoice, currency: string, foreignValue: number): FxEntry {
  const e = emptyEntry()
  const value = round2(foreignValue)
  return {
    ...e,
    invoice_number: inv.invoice_number,
    invoice_date: inv.invoice_date || todayISO(),
    party_name: inv.customer_name || '',
    currency: (currency || 'USD').toUpperCase(),
    foreign_value: value,
    // The books already carry a rupee figure, so the rate that produced it is a fact:
    // grand_total ÷ foreign value. A manual rate is then an opinion about that fact.
    booked_rate: value > 0 ? Math.round((inv.grand_total / value) * 10000) / 10000 : 0,
    booked_inr: round2(inv.grand_total),
  }
}

export function validateEntry(entry: FxEntry): string[] {
  const problems: string[] = []
  if (!entry.invoice_number.trim()) problems.push('Which invoice is this? The number printed on the document')
  if (!isDate(entry.invoice_date)) problems.push('The invoice date must be a real date (YYYY-MM-DD)')
  const c = currencyOf(entry.currency)
  if (!c) problems.push('Unknown currency')
  else if (c.code === 'INR') problems.push('A rupee invoice needs no currency entry')
  if (!(entry.foreign_value > 0)) problems.push('The foreign contract value must be more than zero')
  if (!(entry.booked_rate > 0)) problems.push('The rate used must be a positive number of rupees per one unit')
  if (entry.booked_inr < 0) problems.push('The rupee value cannot be negative')
  return problems
}

export function upsertEntry(orgId: string, entry: FxEntry): { ok: boolean; error: string; store: FxStore } {
  const problems = validateEntry(entry)
  if (problems.length) return { ok: false, error: problems[0], store: loadFx(orgId) }
  const store = loadFx(orgId)
  const clean: FxEntry = {
    ...entry,
    invoice_number: entry.invoice_number.trim().toUpperCase(),
    party_name: entry.party_name.trim(),
    currency: entry.currency.toUpperCase(),
    foreign_value: round2(entry.foreign_value),
    booked_rate: Math.round(entry.booked_rate * 10000) / 10000,
    booked_inr: round2(entry.booked_inr),
    notes: entry.notes.trim(),
  }
  const clash = store.entries.find(e => e.id !== clean.id && e.invoice_number === clean.invoice_number)
  if (clash) return { ok: false, error: `${clean.invoice_number} already has a currency entry`, store }
  const idx = store.entries.findIndex(e => e.id === clean.id)
  const entries = idx >= 0 ? store.entries.map((e, i) => (i === idx ? clean : e)) : [...store.entries, clean]
  const next = { ...store, entries }
  saveFx(orgId, next)
  return { ok: true, error: '', store: next }
}

/** Deleting an entry deletes its realisations, so the money trail goes only by consent. */
export function deleteEntry(orgId: string, id: string): { ok: boolean; error: string; store: FxStore } {
  const store = loadFx(orgId)
  const found = store.entries.find(e => e.id === id)
  if (!found) return { ok: false, error: 'That entry is not on the register', store }
  if (found.receipts.length) {
    return { ok: false, error: 'Realisations are recorded against this entry — remove them first', store }
  }
  const next = { ...store, entries: store.entries.filter(e => e.id !== id) }
  saveFx(orgId, next)
  return { ok: true, error: '', store: next }
}

export function validateReceipt(entry: FxEntry, receipt: FxReceipt): string[] {
  const problems: string[] = []
  if (!isDate(receipt.date)) problems.push('The receipt needs the day the money landed')
  if (!(receipt.foreign > 0)) problems.push('The foreign amount received must be more than zero')
  if (!(receipt.inr > 0)) problems.push('Enter the rupees the bank actually credited — realisation charges come off before it lands')
  const already = entry.receipts.reduce((s, r) => s + r.foreign, 0)
  if (round2(already + receipt.foreign) > round2(entry.foreign_value)) {
    problems.push(`${foreign(already + receipt.foreign, entry.currency)} is more than the ${foreign(entry.foreign_value, entry.currency)} invoiced`)
  }
  return problems
}

export function addReceipt(orgId: string, entryId: string, receipt: FxReceipt): { ok: boolean; error: string; store: FxStore } {
  const store = loadFx(orgId)
  const entry = store.entries.find(e => e.id === entryId)
  if (!entry) return { ok: false, error: 'That entry is not on the register', store }
  const problems = validateReceipt(entry, receipt)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: FxReceipt = {
    ...receipt,
    id: receipt.id || newId(),
    foreign: round2(receipt.foreign),
    inr: round2(receipt.inr),
    reference: receipt.reference.trim(),
  }
  const next = {
    ...store,
    entries: store.entries.map(e => (e.id === entryId ? { ...e, receipts: [...e.receipts, clean] } : e)),
  }
  saveFx(orgId, next)
  return { ok: true, error: '', store: next }
}

export function removeReceipt(orgId: string, entryId: string, receiptId: string): FxStore {
  return mutate(orgId, store => ({
    ...store,
    entries: store.entries.map(e => (
      e.id === entryId ? { ...e, receipts: e.receipts.filter(r => r.id !== receiptId) } : e
    )),
  }))
}

// ── derived exposure ──────────────────────────────────────────────────────────

export type FxSettlement = 'open' | 'partial' | 'settled' | 'overpaid'

export interface FxView {
  entry: FxEntry
  currency: FxCurrency | null
  book: FxBookInvoice | null
  matched: boolean
  received_foreign: number
  outstanding_foreign: number
  received_inr: number
  /** Rupees still owed at the rate the invoice was written at. */
  booked_outstanding_inr: number
  /** The same rupees at the newest recorded rate — what the exposure is worth today. */
  revalued_outstanding_inr: number | null
  today_rate: RateLookup | null
  unrealised: number | null
  realised: number
  /** grand_total ÷ foreign value — what the books say the rate was. */
  implied_rate: number | null
  /** The rate used no longer reproduces the rupee figure in the books. */
  rate_gap: number | null
  settlement: FxSettlement
  due_days: number | null
  /** Advice the owner has to act on; the numbers themselves are never changed here. */
  problems: string[]
}

function numberKey(v: string | null | undefined): string {
  return (v || '').trim().toUpperCase()
}

/**
 * One entry + the books + the rate ledger = what this deal is worth, in both currencies,
 * with every disagreement listed instead of resolved by fiat.
 */
export function fxView(
  entry: FxEntry,
  opts: { rates: FxRate[]; books?: FxBookInvoice[]; today?: string },
): FxView {
  const today = opts.today || todayISO()
  const currency = currencyOf(entry.currency)
  const book = (opts.books || []).find(b => numberKey(b.invoice_number) === numberKey(entry.invoice_number)) || null

  const receivedForeign = round2(entry.receipts.reduce((s, r) => s + r.foreign, 0))
  const receivedInr = round2(entry.receipts.reduce((s, r) => s + r.inr, 0))
  const outstandingForeign = round2(entry.foreign_value - receivedForeign)
  const bookedOutstanding = round2(outstandingForeign * entry.booked_rate)

  // Always look the rate up, even when nothing is outstanding: the register shows one rate
  // per currency and a settled row should not blind the rollup to it.
  const todayRate = rateFor(opts.rates, entry.currency, today)
  const revalued = todayRate ? round2(outstandingForeign * todayRate.rate) : null
  const unrealised = revalued === null ? null : round2(revalued - bookedOutstanding)

  // Realised: what the bank credited, against what the invoice was written at.
  const realised = round2(entry.receipts.reduce((s, r) => s + (r.inr - r.foreign * entry.booked_rate), 0))

  const implied = entry.foreign_value > 0 && entry.booked_inr > 0
    ? Math.round((entry.booked_inr / entry.foreign_value) * 10000) / 10000
    : null
  const rateGap = implied === null || entry.booked_inr <= 0 ? null : round2(entry.booked_rate - implied)

  const settlement: FxSettlement = outstandingForeign <= -EPSILON
    ? 'overpaid'
    : outstandingForeign <= EPSILON
      ? 'settled'
      : receivedForeign > EPSILON ? 'partial' : 'open'

  const dueDays = book?.invoice_date ? daysBetween(book.invoice_date, today) : null

  const problems: string[] = []
  if (!book) problems.push('No invoice in the books carries this number — the rupee side here is unreconciled')
  else if (entry.booked_inr > 0 && Math.abs(entry.booked_inr - book.grand_total) > EPSILON) {
    problems.push(`${inr(entry.booked_inr)} recorded here vs ${inr(book.grand_total)} on the invoice`)
  }
  if (book && settlement === 'settled' && round2(book.balance_due) > EPSILON) {
    problems.push(`Realisation looks complete but the books still show ${inr(book.balance_due)} due — record the receipt on /payments`)
  }
  if (settlement === 'overpaid') problems.push('Received more than invoiced — check the remittance advice')
  if (todayRate && todayRate.age_days > RATE_STALE_AFTER_DAYS) {
    problems.push(`Revalued on a ${currency?.code || entry.currency} rate from ${todayRate.as_of} — ${plural(todayRate.age_days, 'day')} old`)
  } else if (!todayRate && outstandingForeign > EPSILON) {
    problems.push(`No ${entry.currency} rate recorded up to ${today}, so the exposure cannot be revalued`)
  }

  return {
    entry,
    currency,
    book,
    matched: book !== null,
    received_foreign: receivedForeign,
    outstanding_foreign: outstandingForeign,
    received_inr: receivedInr,
    booked_outstanding_inr: bookedOutstanding,
    revalued_outstanding_inr: revalued,
    today_rate: todayRate,
    unrealised,
    realised,
    implied_rate: implied,
    rate_gap: rateGap === 0 ? null : rateGap,
    settlement,
    due_days: dueDays,
    problems,
  }
}

export const SETTLEMENT_LABEL: Record<FxSettlement, string> = {
  open: 'Not received', partial: 'Part received', settled: 'Fully received', overpaid: 'Over-received',
}

/** The whole register, derived at read time — the store keeps no rupee totals of its own. */
export function fxViews(store: FxStore, books: FxBookInvoice[] = [], today?: string): FxView[] {
  return sortViews(store.entries.map(e => fxView(e, { rates: store.rates, books, today })))
}

/** Every recorded day for one currency, newest first — the rate table's drilldown. */
export function rateHistory(rates: FxRate[], code: string): FxRate[] {
  return rates
    .filter(r => r.code === code.toUpperCase())
    .sort((a, b) => (a.as_of < b.as_of ? 1 : a.as_of > b.as_of ? -1 : 0))
}

/** Unsettled and unreconciled first — the rows that need a decision lead the register. */
export function sortViews(views: FxView[]): FxView[] {
  const rank = (v: FxView): number => {
    if (v.settlement === 'overpaid') return 0
    if (!v.matched) return 1
    if (v.settlement === 'open' || v.settlement === 'partial') return 2
    return 3
  }
  return [...views].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    if (a.entry.invoice_date !== b.entry.invoice_date) return a.entry.invoice_date < b.entry.invoice_date ? -1 : 1
    return a.entry.invoice_number.localeCompare(b.entry.invoice_number)
  })
}

export interface FxCurrencyRollup {
  code: string
  currency: FxCurrency | null
  count: number
  outstanding_foreign: number
  booked_inr: number
  revalued_inr: number | null
  unrealised: number | null
  rate: RateLookup | null
}

export interface FxSummary {
  views: FxView[]
  by_currency: FxCurrencyRollup[]
  open_count: number
  unmatched_count: number
  outstanding_inr: number
  exposure_inr: number
  /** Exposure that is only an opinion because the rate is stale or missing. */
  unvalued_inr: number
  unrealised: number
  realised: number
  problems: number
}

export function fxSummary(views: FxView[]): FxSummary {
  const map = new Map<string, FxCurrencyRollup>()
  // How many rows of a currency actually had a rate to revalue them with. A rollup whose
  // every row was unmatched to a rate must report `null`, not ₹0 — zero reads as "no
  // exposure" and would understate exactly the currencies the owner needs to worry about.
  const valued = new Map<string, number>()
  let outstandingInr = 0, exposureInr = 0, unvaluedInr = 0, unrealised = 0, realised = 0, problems = 0
  let openCount = 0, unmatched = 0

  for (const v of views) {
    const code = v.entry.currency
    if (!map.has(code)) {
      map.set(code, {
        code, currency: v.currency, count: 0,
        outstanding_foreign: 0, booked_inr: 0, revalued_inr: 0, unrealised: 0, rate: v.today_rate,
      })
      valued.set(code, 0)
    }
    const row = map.get(code)!
    row.count += 1
    row.outstanding_foreign = round2(row.outstanding_foreign + v.outstanding_foreign)
    row.booked_inr = round2(row.booked_inr + v.booked_outstanding_inr)
    row.revalued_inr = round2((row.revalued_inr || 0) + (v.revalued_outstanding_inr ?? 0))
    row.unrealised = round2((row.unrealised || 0) + (v.unrealised || 0))
    if (v.revalued_outstanding_inr !== null) valued.set(code, (valued.get(code) || 0) + 1)
    // The newest rate seen for the currency wins the label; every row of one currency shares it.
    if (v.today_rate && (!row.rate || v.today_rate.as_of > row.rate.as_of)) row.rate = v.today_rate

    outstandingInr = round2(outstandingInr + v.booked_outstanding_inr)
    exposureInr = round2(exposureInr + (v.revalued_outstanding_inr ?? v.booked_outstanding_inr))
    if (v.revalued_outstanding_inr === null) unvaluedInr = round2(unvaluedInr + v.booked_outstanding_inr)
    else unrealised = round2(unrealised + (v.unrealised || 0))
    realised = round2(realised + v.realised)
    problems += v.problems.length
    if (v.settlement === 'open' || v.settlement === 'partial') openCount += 1
    if (!v.matched) unmatched += 1
  }

  for (const row of map.values()) {
    if (!valued.get(row.code)) { row.revalued_inr = null; row.unrealised = null }
  }

  return {
    views,
    by_currency: [...map.values()].sort((a, b) => b.booked_inr - a.booked_inr),
    open_count: openCount,
    unmatched_count: unmatched,
    outstanding_inr: outstandingInr,
    exposure_inr: exposureInr,
    unvalued_inr: unvaluedInr,
    unrealised,
    realised,
    problems,
  }
}

// ── the reference feed (pure parsing; the page does the fetching) ──────────────

/**
 * One request per currency, asked as `base=<code>&symbols=INR`, because the response is then
 * already rupees per unit. Asking the other way round costs precision: a published
 * 0.01038 USD per INR inverts to ₹96.34, while the same table says ₹96.78 per USD.
 */
export function feedUrl(code: string, date?: string): string {
  const c = (code || '').toUpperCase()
  const path = isDate(date) ? `/v1/${date}` : '/v1/latest'
  return `https://api.frankfurter.dev${path}?base=${c}&symbols=INR`
}

export interface FeedResult {
  code: string
  rate: number
  as_of: string
  /** The feed's own words when it refused, so the page can show a reason per currency. */
  error: string
}

/** Accepts the parsed JSON of one feed response and returns the rupee rate, or a refusal. */
export function parseFeedRates(payload: unknown, code: string, asOf: string): FeedResult {
  const c = (code || '').toUpperCase()
  const fail = (error: string): FeedResult => ({ code: c, rate: 0, as_of: asOf, error })
  if (!payload || typeof payload !== 'object') return fail('The feed returned nothing readable')
  const p = payload as Record<string, unknown>
  if (p.base && String(p.base).toUpperCase() !== c) return fail(`The feed answered for ${p.base}, not ${c}`)
  const rates = p.rates as Record<string, unknown> | undefined
  if (!rates || typeof rates !== 'object') return fail('No rates in the response')
  const value = Number((rates as Record<string, unknown>).INR)
  if (!Number.isFinite(value) || value <= 0) return fail(`No INR rate for ${c} in this feed`)
  return { code: c, rate: Math.round(value * 10000) / 10000, as_of: isDate(p.date) ? String(p.date) : asOf, error: '' }
}

/**
 * Turn feed results into rate rows. A currency the reference table does not publish
 * (the Gulf dinars and riyals, among others) is returned as `missing`, never as zero —
 * a zero rate would silently value a receivable at nothing.
 */
export function ratesFromFeed(results: FeedResult[], store: FxStore): { rates: FxRate[]; missing: string[] } {
  const rates: FxRate[] = []
  const missing: string[] = []
  for (const r of results) {
    if (r.error || !(r.rate > 0)) { missing.push(r.code); continue }
    rates.push({
      code: r.code,
      rate: r.rate,
      as_of: r.as_of,
      source: 'feed',
      note: 'ECB reference rate via frankfurter.dev — indicative, not the Rule 45 notification',
    })
  }
  return { rates: dedupeRates([...store.rates, ...rates]), missing }
}

// ── export ────────────────────────────────────────────────────────────────────

export const FX_CSV_HEADERS = [
  'Invoice', 'Invoice date', 'Customer', 'Currency', 'Foreign value', 'Rate used',
  'Rupee value', 'Received (foreign)', 'Received (₹)', 'Outstanding (foreign)',
  'Outstanding at rate used (₹)', 'Outstanding today (₹)', 'Unrealised ₹', 'Realised ₹',
  'Status', 'Matches an invoice', 'Notes',
]

export function fxRows(views: FxView[]): (string | number)[][] {
  return views.map(v => [
    v.entry.invoice_number,
    v.entry.invoice_date,
    v.book?.customer_name || v.entry.party_name || '',
    v.entry.currency,
    v.entry.foreign_value,
    v.entry.booked_rate,
    v.entry.booked_inr,
    v.received_foreign,
    v.received_inr,
    v.outstanding_foreign,
    v.booked_outstanding_inr,
    v.revalued_outstanding_inr ?? '',
    v.unrealised ?? '',
    v.realised,
    SETTLEMENT_LABEL[v.settlement],
    v.matched ? 'yes' : 'no',
    v.entry.notes,
  ])
}

export const RATE_CSV_HEADERS = ['Currency', 'Rate (₹ per unit)', 'Applies to', 'Source', 'Note']

export function rateRows(rates: FxRate[]): (string | number)[][] {
  return [...rates]
    .sort((a, b) => (a.as_of === b.as_of ? a.code.localeCompare(b.code) : a.as_of < b.as_of ? -1 : 1))
    .map(r => [r.code, r.rate, r.as_of, r.source, r.note])
}
