// Recurring invoices — a bill template on a calendar.
//
// It rides on localStorage (ADR-013) for the same reason orders and challans do:
// there is no `recurring_schedules` table, and the schema is hand-managed in the
// Supabase dashboard until the Phase 14 window. What IS real is the output: every
// invoice a schedule produces goes through the shared `createInvoice()` write path,
// so it takes a genuine `INV-<FY>-NNNN` number, splits tax through the GST engine,
// moves stock and draws FEFO lots exactly like a typed invoice.
//
// The one honest limitation shapes the whole model: **nothing runs while the app is
// closed.** There is no server worker to fire a bill on the 1st. So a schedule does
// not "auto-send" — it *accrues*. The due date is never stored; it is derived from
// the rule and today, which means a missed March invoice is still sitting there in
// April, and generating it dates the invoice on its own scheduled day. That matters
// for GST: `createInvoice` reads the financial year off `invoice_date`, so a March
// bill generated in April lands in the FY it belonged to instead of contaminating
// the current period.
//
// Three more decisions worth writing down:
//  * **Occurrences are addressed by date, not by a counter.** The nth occurrence is
//    computed from the anchor every time (`Jan 31 → Feb 28 → Mar 31`, never
//    `Feb 28 → Mar 28`), and a generated invoice is recorded against that date.
//    Bill one date twice and the second is refused — a schedule cannot double-bill
//    a period it has already billed.
//  * **The template is copied in, not referenced.** A schedule keeps its own lines,
//    so deleting the order it was built from cannot blindside a live schedule, and
//    editing the schedule cannot rewrite a document that already went out.
//  * **A schedule that has billed cannot be deleted.** Like the serial register:
//    the invoice exists in the books, so the thing that produced it stays on the
//    record. Pause it instead.

import {
  calculateInvoiceTotals, calculateLineItem, determineGSTType,
  type InvoiceTotals, type LineItemResult,
} from '@/lib/gst-engine'
import { stateNameFor } from '@/lib/einvoice'
import { newId, todayISO } from '@/lib/batches'
import { isUsableLine, lineToItemFields, type FlowDoc, type FlowLine } from '@/lib/orderflow'

export { todayISO }

const KEY_RECURRING = 'taxflow:rec:'

/** A schedule never enumerates more than this; the UI says so rather than imply "none". */
export const MAX_OCCURRENCES = 500
/** How far the calendar is projected past today when looking for due dates. */
export const HORIZON_DAYS = 400

export type Frequency = 'daily' | 'weekly' | 'fortnightly' | 'monthly' | 'quarterly' | 'half-yearly' | 'yearly'
export type EndMode = 'never' | 'count' | 'date'
export type ScheduleStatus = 'active' | 'paused'
/** Derived from the rule and today — never stored. */
export type ScheduleState = 'due' | 'upcoming' | 'paused' | 'completed'

export interface FrequencySpec {
  value: Frequency
  label: string
  /** Month-based cadences keep the anchor's day of month; day-based ones just add. */
  months: number
  days: number
  /** "Every month" reads better than "every 1 months" in the cadence line. */
  one: string
  many: string
}

export const FREQUENCIES: FrequencySpec[] = [
  { value: 'daily', label: 'Daily', months: 0, days: 1, one: 'day', many: 'days' },
  { value: 'weekly', label: 'Weekly', months: 0, days: 7, one: 'week', many: 'weeks' },
  { value: 'fortnightly', label: 'Fortnightly', months: 0, days: 14, one: 'fortnight', many: 'fortnights' },
  { value: 'monthly', label: 'Monthly', months: 1, days: 0, one: 'month', many: 'months' },
  { value: 'quarterly', label: 'Quarterly', months: 3, days: 0, one: 'quarter', many: 'quarters' },
  { value: 'half-yearly', label: 'Every 6 months', months: 6, days: 0, one: 'half-year', many: 'half-years' },
  { value: 'yearly', label: 'Yearly', months: 12, days: 0, one: 'year', many: 'years' },
]

export const END_MODES: { value: EndMode; label: string }[] = [
  { value: 'never', label: 'Keeps repeating' },
  { value: 'count', label: 'Stop after a number of invoices' },
  { value: 'date', label: 'Stop after a date' },
]

export const STATE_LABEL: Record<ScheduleState, string> = {
  due: 'Due', upcoming: 'Upcoming', paused: 'Paused', completed: 'Completed',
}

export function frequencyOf(value: string): FrequencySpec {
  return FREQUENCIES.find(f => f.value === value) || FREQUENCIES[3]
}

/** One invoice's worth of the schedule — raised through the real invoice path. */
export interface Occurrence {
  /** The scheduled date this bill was raised for — also its invoice date. */
  date: string
  invoice_id: string
  invoice_number: string
  total: number
  at: string
  /** Raised while offline: queued in the outbox, so it has no real number yet. */
  queued?: boolean
}

export interface Schedule {
  id: string
  name: string
  party_id: string | null
  party_name: string
  party_gstin: string
  party_address: string
  party_state: string
  place_of_supply: string
  supply_type: string
  lines: FlowLine[]
  frequency: Frequency
  /** Every period is a multiple of this, counted from the anchor. */
  interval: number
  anchor_date: string
  end_mode: EndMode
  end_count: number
  end_date: string
  /** Payment terms — the generated invoice's due date is the schedule date + this. */
  due_in_days: number
  notes: string
  terms: string
  status: ScheduleStatus
  created_at: string
  occurrences: Occurrence[]
}

// ── Date maths ───────────────────────────────────────────────────────────────
// All on YYYY-MM-DD strings through Date.UTC, so a timezone cannot shift a bill
// by a day and quietly move an invoice into another financial year.

const pad2 = (n: number) => String(n).padStart(2, '0')

export function parseISO(iso: string): { y: number; m: number; d: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim())
  if (!m) return null
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3])
  // A day beyond the month is not a date, whatever the string looks like — a
  // schedule anchored on "2026-02-30" would otherwise roll into March on its own.
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  return { y, m: mo, d }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function addDaysISO(iso: string, days: number): string {
  const p = parseISO(iso)
  if (!p) return iso
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d) + days * 86400000)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

/** Month arithmetic clamped to the target month's length — the anchor day never drifts. */
export function addMonthsISO(iso: string, months: number): string {
  const p = parseISO(iso)
  if (!p) return iso
  const total = p.m - 1 + months
  const y = p.y + Math.floor(total / 12)
  const m = ((total % 12) + 12) % 12 + 1
  return `${y}-${pad2(m)}-${pad2(Math.min(p.d, daysInMonth(y, m)))}`
}

export function daysBetween(from: string, to: string): number | null {
  const a = parseISO(from), b = parseISO(to)
  if (!a || !b) return null
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000)
}

// ── Storage ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
function numOr(v: unknown, dflt: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : dflt
}

/** A stored line is only as trustworthy as its name. */
function parseLine(v: unknown): FlowLine | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const item_name = str(o.item_name).trim()
  if (!item_name) return null
  return {
    product_id: typeof o.product_id === 'string' && o.product_id ? o.product_id : null,
    item_name,
    hsn_sac: str(o.hsn_sac),
    quantity: numOr(o.quantity, 0),
    unit: str(o.unit) || 'NOS',
    rate: numOr(o.rate, 0),
    discount_percent: numOr(o.discount_percent, 0),
    gst_rate: numOr(o.gst_rate, 0),
    cess_rate: numOr(o.cess_rate, 0),
  }
}

function parseOccurrence(v: unknown): Occurrence | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const date = str(o.date)
  const invoice_number = str(o.invoice_number)
  // No readable date means we cannot tell which period it covered; no number means
  // nothing was written. Either way the row is not evidence of a bill.
  if (!parseISO(date) || !invoice_number) return null
  return {
    date,
    invoice_id: str(o.invoice_id),
    invoice_number,
    total: numOr(o.total, 0),
    at: str(o.at),
    queued: o.queued === true,
  }
}

function parseSchedule(v: unknown): Schedule | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const spec = FREQUENCIES.find(f => f.value === str(o.frequency))
  const endMode = str(o.end_mode) as EndMode
  const anchor = str(o.anchor_date)
  const endDate = str(o.end_date)
  return {
    id: o.id,
    name: str(o.name).trim(),
    party_id: typeof o.party_id === 'string' && o.party_id ? o.party_id : null,
    party_name: str(o.party_name),
    party_gstin: str(o.party_gstin),
    party_address: str(o.party_address),
    party_state: str(o.party_state),
    place_of_supply: str(o.place_of_supply),
    supply_type: str(o.supply_type) || 'b2b',
    lines: Array.isArray(o.lines) ? o.lines.map(parseLine).filter((l): l is FlowLine => l !== null) : [],
    frequency: spec ? spec.value : 'monthly',
    interval: Math.max(1, Math.round(numOr(o.interval, 1))),
    anchor_date: parseISO(anchor) ? anchor : '',
    end_mode: END_MODES.some(e => e.value === endMode) ? endMode : 'never',
    end_count: Math.max(0, Math.floor(numOr(o.end_count, 0))),
    end_date: parseISO(endDate) ? endDate : '',
    due_in_days: Math.max(0, Math.round(numOr(o.due_in_days, 0))),
    notes: str(o.notes),
    terms: str(o.terms),
    status: str(o.status) === 'paused' ? 'paused' : 'active',
    created_at: str(o.created_at),
    occurrences: Array.isArray(o.occurrences)
      ? o.occurrences.map(parseOccurrence).filter((x): x is Occurrence => x !== null).sort((a, b) => a.date.localeCompare(b.date))
      : [],
  }
}

/** Tolerant parse — a hand-edited or half-written key must not crash a page. */
export function parseSchedules(raw: string | null): Schedule[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(parseSchedule)
      // A row without a name is not a schedule anyone can read back.
      .filter((s): s is Schedule => s !== null && s.name !== '')
  } catch {
    return []
  }
}

export function loadSchedules(orgId: string): Schedule[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseSchedules(window.localStorage.getItem(KEY_RECURRING + orgId))
  } catch {
    return []
  }
}

export function saveSchedules(orgId: string, schedules: Schedule[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_RECURRING + orgId, JSON.stringify(schedules))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

/** Stored order: active first, then by name. Display order is `sortViews`. */
export function sortSchedules(list: Schedule[]): Schedule[] {
  return [...list].sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export function upsertSchedule(orgId: string, schedule: Schedule): Schedule[] {
  const list = loadSchedules(orgId)
  const clean: Schedule = { ...schedule, name: schedule.name.trim(), party_name: schedule.party_name.trim() }
  const idx = list.findIndex(s => s.id === clean.id)
  const next = idx >= 0 ? list.map((s, i) => (i === idx ? clean : s)) : [...list, clean]
  saveSchedules(orgId, next)
  return next
}

/** Refused once the schedule has written a bill — the books remember it even if we do not. */
export function deleteSchedule(orgId: string, id: string): { ok: true; schedules: Schedule[] } | { ok: false; error: string } {
  const list = loadSchedules(orgId)
  const found = list.find(s => s.id === id)
  if (!found) return { ok: false, error: 'That schedule is no longer on the register' }
  if (found.occurrences.length > 0) {
    return {
      ok: false,
      error: `${found.name} has raised ${found.occurrences.length} invoice${found.occurrences.length === 1 ? '' : 's'}. Those bills `
        + 'are in your books, so the schedule that produced them stays on the record — pause it instead.',
    }
  }
  const next = list.filter(s => s.id !== id)
  saveSchedules(orgId, next)
  return { ok: true, schedules: next }
}

export function setStatus(orgId: string, id: string, status: ScheduleStatus): Schedule[] {
  const next = loadSchedules(orgId).map(s => (s.id === id ? { ...s, status } : s))
  saveSchedules(orgId, next)
  return next
}

export function emptySchedule(): Schedule {
  return {
    id: newId(),
    name: '',
    party_id: null,
    party_name: '',
    party_gstin: '',
    party_address: '',
    party_state: '',
    place_of_supply: '',
    supply_type: 'b2b',
    lines: [],
    frequency: 'monthly',
    interval: 1,
    anchor_date: todayISO(),
    end_mode: 'never',
    end_count: 12,
    end_date: '',
    due_in_days: 30,
    notes: '',
    terms: '',
    status: 'active',
    created_at: new Date().toISOString(),
    occurrences: [],
  }
}

/** Seed a schedule from an order or challan: the party and the lines carry over. */
export function scheduleFromDoc(doc: FlowDoc, name: string): Schedule {
  return {
    ...emptySchedule(),
    name,
    party_id: doc.party_id,
    party_name: doc.party_name,
    party_gstin: doc.party_gstin,
    party_address: doc.party_address,
    party_state: doc.party_state,
    place_of_supply: doc.place_of_supply,
    supply_type: doc.supply_type,
    lines: doc.lines.filter(isUsableLine).map(l => ({ ...l })),
    notes: doc.notes,
  }
}

// ── The calendar ─────────────────────────────────────────────────────────────

/** The nth occurrence, always measured from the anchor so a clamped February cannot shift March. */
export function occurrenceDate(s: Schedule, index: number): string {
  const f = frequencyOf(s.frequency)
  const i = Math.max(0, Math.floor(index))
  if (f.months) return addMonthsISO(s.anchor_date, i * f.months * s.interval)
  return addDaysISO(s.anchor_date, i * f.days * s.interval)
}

/** Which occurrence number a date is (0-based); -1 when the calendar never produces it. */
export function occurrenceIndex(s: Schedule, date: string): number {
  const a = parseISO(s.anchor_date)
  const b = parseISO(date)
  if (!a || !b || date < s.anchor_date) return -1
  const f = frequencyOf(s.frequency)
  if (f.months) {
    const step = f.months * s.interval
    const months = (b.y - a.y) * 12 + (b.m - a.m)
    const candidate = Math.floor(months / step)
    // A clamped day lets neighbouring indices read the same month — check both sides.
    for (let i = Math.max(0, candidate - 1); i <= candidate + 1; i++) {
      if (occurrenceDate(s, i) === date) return i
    }
    return -1
  }
  const days = daysBetween(s.anchor_date, date)
  if (days === null) return -1
  const step = f.days * s.interval
  return days % step === 0 ? days / step : -1
}

export interface Calendar {
  dates: string[]
  /** The cap was reached before the rule ran out — say so rather than imply "none". */
  truncated: boolean
}

/**
 * Occurrence dates from the anchor up to the horizon, cut short by the end rule.
 * The anchor is always included, even a far-future one, so a schedule started for
 * next year still reports a next date instead of looking finished.
 */
export function buildCalendar(s: Schedule, today: string): Calendar {
  const dates: string[] = []
  if (!parseISO(s.anchor_date) || !s.lines.some(isUsableLine)) return { dates, truncated: false }
  const horizon = addDaysISO(today, HORIZON_DAYS)
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const d = occurrenceDate(s, i)
    if (!parseISO(d)) break
    if (s.end_mode === 'date' && s.end_date && d > s.end_date) break
    if (i > 0 && d > horizon) break
    dates.push(d)
    if (s.end_mode === 'count' && s.end_count > 0 && dates.length >= s.end_count) break
  }
  return { dates, truncated: dates.length === MAX_OCCURRENCES }
}

/** When the rule itself runs out, independent of the viewing horizon. */
export function ruleEndsOn(s: Schedule): string | null {
  if (!parseISO(s.anchor_date)) return null
  if (s.end_mode === 'count' && s.end_count >= 1) {
    return occurrenceDate(s, Math.min(s.end_count, MAX_OCCURRENCES) - 1)
  }
  if (s.end_mode === 'date' && parseISO(s.end_date)) {
    if (s.end_date < s.anchor_date) return null
    let last = ''
    for (let i = 0; i < MAX_OCCURRENCES; i++) {
      const d = occurrenceDate(s, i)
      if (!parseISO(d) || d > s.end_date) break
      last = d
    }
    return last || null
  }
  return null
}

/** Dates the rule says should have been billed already and have not been. */
export function dueDates(s: Schedule, today: string): string[] {
  const done = new Set(s.occurrences.map(o => o.date))
  return buildCalendar(s, today).dates.filter(d => d <= today && !done.has(d))
}

export function nextDate(s: Schedule, today: string): string | null {
  const done = new Set(s.occurrences.map(o => o.date))
  return buildCalendar(s, today).dates.find(d => !done.has(d)) ?? null
}

/** A period can only be billed once. */
export function alreadyRaised(s: Schedule, date: string): Occurrence | null {
  return s.occurrences.find(o => o.date === date) ?? null
}

/** The bill for the newest period — occurrences are addressed by date, not by click order. */
export function latestOccurrence(s: Schedule): Occurrence | null {
  if (!s.occurrences.length) return null
  return s.occurrences.reduce((a, b) => (b.date > a.date ? b : a))
}

// ── The derived view ─────────────────────────────────────────────────────────

export interface ScheduleView {
  s: Schedule
  /** Cadence as a sentence: "Every 2 months · on the 31st". */
  cadence: string
  perOccurrence: number
  taxable: number
  gstType: 'cgst_sgst' | 'igst'
  due: string[]
  /** Due dates strictly before today — the catch-up pile. */
  missed: number
  next: string | null
  /** Days from today to `next`; negative when the next date is in the past. */
  daysToNext: number | null
  raised: number
  raisedValue: number
  last: Occurrence | null
  /** The date the rule runs out, when it runs out at all. */
  endsOn: string | null
  openEnded: boolean
  truncated: boolean
  progress: number | null
  state: ScheduleState
  /** What is missing before this schedule can bill anything. */
  problems: string[]
}

function ordinal(n: number): string {
  if (n >= 11 && n <= 13) return 'th'
  return n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
}

export function cadenceLine(s: Schedule): string {
  const f = frequencyOf(s.frequency)
  const unit = s.interval === 1 ? f.one : f.many
  const every = s.interval === 1 ? 'Every' : `Every ${s.interval}`
  const day = parseISO(s.anchor_date)?.d
  const suffix = f.months && day ? ` · on the ${day}${ordinal(day)}` : ''
  return `${every} ${unit}${suffix}`
}

function stateOf(s: Schedule, due: string[], next: string | null): ScheduleState {
  if (s.status === 'paused') return 'paused'
  if (due.length > 0) return 'due'
  // Exhausted: the rule ends and nothing is left pending. Requiring at least one
  // bill keeps a broken schedule (no lines, no party) from reading as "completed".
  const exhausted = s.end_mode !== 'never' && next === null && s.occurrences.length > 0
  return exhausted ? 'completed' : 'upcoming'
}

/** Totals recomputed from the template every time — so a rate change flows through. */
export function scheduleTotals(s: Schedule, orgStateCode: string): {
  gstType: 'cgst_sgst' | 'igst'
  results: LineItemResult[]
  totals: InvoiceTotals | null
} {
  const gstType = determineGSTType(orgStateCode, s.place_of_supply, s.supply_type)
  const lines = s.lines.filter(isUsableLine)
  const results = lines.map(line => calculateLineItem({
    quantity: Number(line.quantity),
    rate: Number(line.rate),
    discount_percent: Number(line.discount_percent) || 0,
    gst_rate: Number(line.gst_rate) || 0,
    cess_rate: Number(line.cess_rate) || 0,
  }, gstType))
  return { gstType, results, totals: results.length ? calculateInvoiceTotals(results) : null }
}

export function scheduleView(s: Schedule, orgStateCode: string, today: string): ScheduleView {
  const cal = buildCalendar(s, today)
  const done = new Set(s.occurrences.map(o => o.date))
  const due = cal.dates.filter(d => d <= today && !done.has(d))
  const next = cal.dates.find(d => !done.has(d)) ?? null
  const { gstType, totals } = scheduleTotals(s, orgStateCode)
  // The latest *period*, not the last click: storage can hand us rows in any
  // order (a catch-up run bills December before it bills January).
  const last = latestOccurrence(s)
  return {
    s,
    cadence: cadenceLine(s),
    perOccurrence: totals?.grand_total ?? 0,
    taxable: totals?.taxable_amount ?? 0,
    gstType,
    due,
    missed: due.filter(d => d < today).length,
    next,
    daysToNext: next ? daysBetween(today, next) : null,
    raised: s.occurrences.length,
    raisedValue: Math.round(s.occurrences.reduce((sum, o) => sum + (Number(o.total) || 0), 0) * 100) / 100,
    last,
    endsOn: ruleEndsOn(s),
    openEnded: s.end_mode === 'never',
    truncated: cal.truncated,
    progress: s.end_mode === 'count' && s.end_count > 0
      ? Math.min(1, s.occurrences.length / s.end_count)
      : null,
    state: stateOf(s, due, next),
    problems: validateSchedule(s),
  }
}

export function scheduleViews(list: Schedule[], orgStateCode: string, today: string): ScheduleView[] {
  return list.map(s => scheduleView(s, orgStateCode, today))
}

/** What the register should show first: overdue work, then the calendar, then the rest. */
export function sortViews(views: ScheduleView[]): ScheduleView[] {
  const rank: Record<ScheduleState, number> = { due: 0, upcoming: 1, paused: 2, completed: 3 }
  return [...views].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state]
    if (a.state === 'due') return a.due[0].localeCompare(b.due[0])
    if (a.state === 'upcoming') return String(a.next ?? '9999').localeCompare(String(b.next ?? '9999'))
    return a.s.name.localeCompare(b.s.name)
  })
}

export interface Rollup {
  active: number
  paused: number
  dueCount: number
  dueValue: number
  raised: number
  raisedValue: number
  /** ≈ what the workable active schedules bill in a month, across all cadences. */
  runRate: number
  completed: number
}

/** How many months one period covers, for the run-rate figure. */
function monthsPerPeriod(s: Schedule): number {
  const f = frequencyOf(s.frequency)
  if (f.months) return f.months * s.interval
  return (f.days * s.interval) / 30.44
}

export function rollup(views: ScheduleView[]): Rollup {
  let dueCount = 0, dueValue = 0, runRate = 0
  for (const v of views) {
    if (v.state === 'due') { dueCount += v.due.length; dueValue += v.due.length * v.perOccurrence }
    if (v.s.status === 'active' && v.state !== 'completed' && v.problems.length === 0) {
      const m = monthsPerPeriod(v.s)
      if (m > 0) runRate += v.perOccurrence / m
    }
  }
  return {
    active: views.filter(v => v.s.status === 'active').length,
    paused: views.filter(v => v.s.status === 'paused').length,
    dueCount,
    dueValue: Math.round(dueValue * 100) / 100,
    raised: views.reduce((sum, v) => sum + v.raised, 0),
    raisedValue: Math.round(views.reduce((sum, v) => sum + v.raisedValue, 0) * 100) / 100,
    runRate: Math.round(runRate * 100) / 100,
    completed: views.filter(v => v.state === 'completed').length,
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateSchedule(s: Schedule): string[] {
  const problems: string[] = []
  if (!s.name.trim()) problems.push('Give the schedule a name')
  if (!s.party_name.trim()) problems.push('Choose the customer this bills')
  if (!s.place_of_supply) problems.push('Select the place of supply')
  if (!parseISO(s.anchor_date)) problems.push('Give the first invoice date')
  if (!Number.isInteger(s.interval) || s.interval < 1 || s.interval > 365) problems.push('Repeat every 1–365 periods')
  if (!s.lines.some(isUsableLine)) problems.push('Add at least one line with a name, quantity and rate')
  if (s.end_mode === 'count' && (!Number.isFinite(s.end_count) || s.end_count < 1)) problems.push('Set how many invoices to raise')
  if (s.end_mode === 'date') {
    if (!parseISO(s.end_date)) problems.push('Set the date it stops')
    else if (parseISO(s.anchor_date) && s.end_date < s.anchor_date) problems.push('The stop date falls before the first invoice date')
  }
  if (!Number.isFinite(s.due_in_days) || s.due_in_days < 0 || s.due_in_days > 365) problems.push('Payment terms must be 0–365 days')
  return problems
}

// ── Generating ───────────────────────────────────────────────────────────────

/**
 * The invoice header + items `createInvoice()` needs, dated on the occurrence's own
 * day. The figures come from the same `scheduleTotals()` the card showed, so a
 * generated bill can never disagree with the schedule it came from.
 */
export function buildSchedulePayload(
  s: Schedule,
  orgStateCode: string,
  invoiceDate: string,
): { invoiceFields: Record<string, unknown>; items: Record<string, unknown>[] } {
  const { results, totals } = scheduleTotals(s, orgStateCode)
  if (!totals) throw new Error('Nothing to bill — the schedule has no usable lines')
  const lines = s.lines.filter(isUsableLine)
  const items = lines.map((line, idx) => lineToItemFields(line, results[idx]))

  const seq = occurrenceIndex(s, invoiceDate)
  const trail = seq >= 0
    ? `invoice ${seq + 1}${s.end_mode === 'count' ? ` of ${s.end_count}` : ''}`
    : 'scheduled bill'
  const due = s.due_in_days > 0 ? addDaysISO(invoiceDate, s.due_in_days) : ''

  return {
    invoiceFields: {
      invoice_type: 'tax_invoice',
      invoice_date: invoiceDate,
      due_date: due || null,
      customer_id: s.party_id,
      customer_name: s.party_name,
      customer_gstin: s.party_gstin,
      customer_address: s.party_address,
      customer_state: stateNameFor(s.party_state),
      customer_state_code: s.party_state,
      place_of_supply: s.place_of_supply,
      place_of_supply_name: stateNameFor(s.place_of_supply),
      supply_type: s.supply_type,
      is_reverse_charge: false,
      subtotal: totals.subtotal,
      discount_amount: totals.discount_amount,
      taxable_amount: totals.taxable_amount,
      cgst_amount: totals.cgst_amount,
      sgst_amount: totals.sgst_amount,
      igst_amount: totals.igst_amount,
      cess_amount: totals.cess_amount,
      total_tax: totals.total_tax,
      round_off: totals.round_off,
      grand_total: totals.grand_total,
      amount_paid: 0,
      balance_due: totals.grand_total,
      payment_status: 'unpaid',
      // The paper says where it came from — a recurring bill reads as one, not as
      // a mystery invoice the owner has to reconstruct from memory.
      notes: [s.notes.trim(), `Recurring — ${s.name} (${trail})`].filter(Boolean).join(' — '),
      terms: s.terms,
      status: 'sent',
    },
    items: items.map(item => ({ ...item })),
  }
}

export interface RecordInput {
  date: string
  invoice_id: string
  invoice_number: string
  total: number
  queued?: boolean
}

/**
 * Marks one period as billed. Refuses a date the calendar does not produce and one
 * already billed — the second is the whole point of deriving dates instead of
 * storing a counter.
 */
export function recordOccurrence(
  orgId: string,
  id: string,
  input: RecordInput,
  today: string,
): { ok: true; schedules: Schedule[]; occurrence: Occurrence } | { ok: false; error: string } {
  const list = loadSchedules(orgId)
  const s = list.find(x => x.id === id)
  if (!s) return { ok: false, error: 'That schedule is no longer on the register' }
  if (!parseISO(input.date)) return { ok: false, error: 'The bill needs a date' }
  const dup = alreadyRaised(s, input.date)
  if (dup) return { ok: false, error: `${input.date} was already billed as ${dup.invoice_number}` }
  if (occurrenceIndex(s, input.date) < 0) {
    return { ok: false, error: `${input.date} is not a date this schedule produces` }
  }
  if (!buildCalendar(s, today).dates.includes(input.date)) {
    return { ok: false, error: `${input.date} falls outside the schedule's end rule` }
  }

  const occurrence: Occurrence = {
    date: input.date,
    invoice_id: input.invoice_id,
    invoice_number: input.invoice_number,
    total: Math.round((Number(input.total) || 0) * 100) / 100,
    at: new Date().toISOString(),
    queued: input.queued === true,
  }
  // Sorted by date, so `last` is the latest period rather than the latest click.
  const occurrences = [...s.occurrences, occurrence].sort((a, b) => a.date.localeCompare(b.date))
  const next = list.map(x => (x.id === id ? { ...x, occurrences } : x))
  saveSchedules(orgId, next)
  return { ok: true, schedules: next, occurrence }
}

// ── Export ───────────────────────────────────────────────────────────────────

export const RECURRING_CSV_HEADERS = [
  'Schedule', 'Customer', 'GSTIN', 'Cadence', 'First invoice', 'Ends', 'Status',
  'Per invoice', 'Raised', 'Value raised', 'Due now', 'Next due', 'Last invoice', 'Lines',
]

export function recurringCsvRows(views: ScheduleView[]): (string | number)[][] {
  return views.map(v => [
    v.s.name, v.s.party_name, v.s.party_gstin, v.cadence, v.s.anchor_date,
    v.endsOn || 'Open-ended', STATE_LABEL[v.state],
    v.perOccurrence, v.raised, v.raisedValue, v.due.length, v.next || '—',
    v.last?.invoice_number || '—', v.s.lines.filter(isUsableLine).length,
  ])
}

/** One schedule's billing trail. */
export const OCCURRENCE_CSV_HEADERS = ['Scheduled date', 'Invoice', 'Amount', 'Raised on', 'Queued']

export function occurrenceCsvRows(s: Schedule): (string | number)[][] {
  return [...s.occurrences]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(o => [o.date, o.invoice_number, o.total, o.at ? o.at.slice(0, 10) : '', o.queued ? 'outbox' : ''])
}
