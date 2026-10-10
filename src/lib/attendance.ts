// The day book — attendance the shop *keeps*, as opposed to the sheet it merely reads.
//
// R2-32 gave the salary register a pasted attendance sheet: it classified the columns, took exactly
// one figure out of the table per person — the lost days — and threw the sheet away. That is honest
// and it is thin. A shop that keeps attendance on a wall, in a notebook or in an Excel page ruled
// with dates across the top has been keeping *days*, not a number, and the round after the reader
// is the round that stores them.
//
// So the register now holds a list of marks (one per employee per day, in the same
// `taxflow:payroll:<orgId>` envelope, additive under version 1 — an envelope without the list parses
// back with an empty book and says so). Six rules hold it together:
//
//  * **A mark is kept; a salary is not.** The book stores `P`, `A`, `H` and nothing about money.
//    The rupee still has exactly one home: `lop_days` on the month row is the only lost-day figure
//    the salary walk reads. Pulling from the book pushes candidates through the same
//    `validateInput()` door the month form uses — an absent day that was never pulled costs nobody
//    anything, which is the correct behaviour, not a gap.
//  * **An unwritten day is not an absent day.** The grid prints how many days are unwritten;
//    unwritten is counted nowhere. Where the shop has named its weekly off, the grid also says how
//    many unwritten days fall on it — information about what is still blank, never a deduction.
//  * **Half is half, neutral is neutral.** `0.5` counts as half a lost day; a holiday or paid leave
//    counts as nothing at all. The book records what was written, not what was assumed.
//  * **A mark for a day nobody was on the rolls is refused at the write** with the joining or
//    leaving window printed beside it — the same rule the month form runs on, one round earlier.
//  * **A deleted person's days go with them.** The envelope parse applies to marks exactly the rule
//    it applies to month rows: half a roster is worse than none, and a ghost with an attendance
//    history is worse than a ghost.
//  * **The pasted sheet still has a door.** R2-32's summary reading (a `Present` or `LOP` column,
//    one figure a person) is untouched. A *day-grid* sheet can now also land as marks, and the shop
//    chooses which — a summary paste remains available because most sheets are summaries.
//
// What this deliberately does not become: no device or biometric feed (that is a contract with a
// machine, not a reading of a sheet), no overtime or wage-per-day ledger for contract labour, no
// per-day pay computation, and no payroll attendance *report* that recomputes the salary a second
// time from these marks. The month row owns the money; the book owns the evidence.

import { todayISO } from '@/lib/batches'
import { round2 } from '@/lib/costcentres'
import {
  canonicalMark, currentMonth, daysInMonthKey, isDate, isMonth, markMeaning,
  monthEnd, monthLabel, monthStart, mutatePayroll, newInput, parseDayMarks, rosterFor, loadPayroll,
  stampAttendanceNote, validateInput,
  type AttendancePlan, type DayMark, type DayMarkSource, type Employee, type PayInput,
  type PayrollStore,
} from '@/lib/payroll'

/** The register's own string guard, re-declared here so this file never trusts an untyped cell. */
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** What a written mark means for the month's lost-day count. */
export type MarkMeans = 'present' | 'loss' | 'neutral'

/**
 * The marks the grid offers, in tap order. This list is a *convenience*: the book stores any mark
 * the register's own lookup can read, so a sheet that writes `LL` or `NLW` lands as itself rather
 * than being re-spelled into something the shop never wrote.
 */
export const DAY_BOOK_MARKS: { mark: string; label: string; means: MarkMeans }[] = [
  { mark: '', label: 'unwritten', means: 'neutral' },
  { mark: 'P', label: 'present', means: 'present' },
  { mark: 'A', label: 'absent', means: 'loss' },
  { mark: 'H', label: 'holiday', means: 'neutral' },
  { mark: 'W', label: 'weekly off', means: 'neutral' },
  { mark: 'PL', label: 'paid leave', means: 'neutral' },
  { mark: 'SL', label: 'sick leave, full pay', means: 'neutral' },
  { mark: '0.5', label: 'half day lost', means: 'loss' },
]

/** The weekday a date falls on, in the shop's own calendar. Exported for the setting's own picker. */
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function weekdayOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return WEEKDAYS[new Date(y, m - 1, d).getDay()] ?? ''
}

/**
 * The marks that fall on the establishment's weekly off, for a whole month. Derived from the shop's
 * own setting and used for one thing only: counting what is still blank. It never turns an unwritten
 * day into a lost day, and a shop that never recorded its weekly off gets a sentence saying so
 * instead of a number.
 */
export function weeklyOffDays(month: string, weeklyOff: string): string[] {
  if (!isMonth(month) || !WEEKDAYS.includes(weeklyOff)) return []
  const days = daysInMonthKey(month)
  const out: string[] = []
  for (let i = 1; i <= days; i++) if (weekdayOf(`${month}-${String(i).padStart(2, '0')}`) === weeklyOff) out.push(String(i))
  return out
}

/** What a written mark means for work a job's hours can be drawn from. */
export interface MarkWork {
  /** What part of a day the mark says was worked: a whole one, half of it, or none. */
  fraction: 1 | 0.5 | 0
  /** The register's own label for the mark — 'present', 'half day lost', 'absent'… */
  label: string
  /** '' while the mark holds work; otherwise the sentence that says why nothing is drawn from it. */
  why: string
}

/**
 * The day book's own reading of one mark, for the timesheet draw: what part of the day was worked
 * and, when none was, the register's sentence for why. The same lookup the grid counts with — the
 * half day is a half, and a shop's own spelling (`LL`, `NLW`) is read as itself. An unwritten day
 * is not a day worked, and this reading will not invent one.
 */
export function markWork(mark: string): MarkWork {
  const trimmed = str(mark).trim()
  if (!trimmed) {
    return { fraction: 0, label: 'unwritten', why: 'Unwritten — an unwritten day is not a day worked, and the draw will not invent one.' }
  }
  const canonical = canonicalMark(trimmed)
  if (!canonical) {
    return { fraction: 0, label: trimmed, why: `“${trimmed}” is a mark the register cannot read, so no hours are drawn from it.` }
  }
  const means = markMeaning(canonical)
  const label = DAY_BOOK_MARKS.find(m => m.mark === canonical)?.label
    || (means === 'present' ? 'present' : means === 'loss' ? 'a lost day' : 'paid, not worked')
  if (canonical === '0.5') return { fraction: 0.5, label, why: '' }
  if (means === 'present') return { fraction: 1, label, why: '' }
  if (means === 'loss') {
    return { fraction: 0, label, why: 'A lost day — the register reads it as no work, so nothing is drawn from it.' }
  }
  if (means === 'neutral') {
    return { fraction: 0, label, why: 'Paid, not worked — a holiday, weekly off or leave holds no hours for a job.' }
  }
  return { fraction: 0, label, why: 'The register cannot read this mark, so nothing is drawn from it.' }
}

export interface DayBookCell {
  date: string
  day: number
  weekday: string
  weekly_off: boolean
  past: boolean
  /** False on a day before the joining date or after the leaving date — ruled, but not this person's. */
  on_roll: boolean
  /** The mark the shop wrote, or `''` when the day is unwritten. */
  mark: string
  means: MarkMeans | null
  source: DayMarkSource | ''
  note: string
  written: boolean
}

export interface DayBookRow {
  employee: Employee
  cells: DayBookCell[]
  present_days: number
  loss_days: number
  neutral_days: number
  written_days: number
  /** Days in the month the person was on the rolls — what a written day could at most fill. */
  on_roll_days: number
  /** The month row's own figure, for the disagreement the grid prints. */
  month_lop_days: number | null
  /** Marks the book holds for days this person was not on the rolls — kept, and named. */
  outside_rolls: { date: string; mark: string }[]
}

export interface DayBook {
  month: string
  /** False for a whole envelope written before the day book existed, or a month nobody has marked. */
  kept_any: boolean
  /** The one sentence every count on this page rests on. */
  doctrine: string
  weekly_off: string
  columns: { day: number; date: string; weekday: string; weekly_off: boolean; past: boolean }[]
  rows: DayBookRow[]
  /** Names on the rolls with nothing written for them — the sheet that forgot a line, in book form. */
  unmarked_people: string[]
  findings: string[]
  footer: {
    people: number
    cells_expected: number
    cells_written: number
    unwritten_days: number
    unwritten_on_weekly_off: number
    loss_days_total: number
    people_with_loss: number
  }
}

/**
 * The month as the shop sees it: every person on the rolls, every day of the month, each cell the
 * mark that was written or a blank that was not. Nothing in here stores a rupee or a salary; the
 * `loss_days` figures are the *evidence* a month row could be pulled to, and pulling is a separate,
 * deliberate click that goes through the month form's own validation.
 */
export function dayBook(store: PayrollStore, month: string, today = todayISO()): DayBook {
  if (!isMonth(month)) {
    return {
      month, kept_any: false, doctrine: '', weekly_off: store.settings.weekly_off,
      columns: [], rows: [], unmarked_people: [], findings: ['A month is YYYY-MM — the book cannot rule a page for a month it cannot name.'],
      footer: { people: 0, cells_expected: 0, cells_written: 0, unwritten_days: 0, unwritten_on_weekly_off: 0, loss_days_total: 0, people_with_loss: 0 },
    }
  }
  const roster = rosterFor(store, month)
  const inputsByEmp = new Map(store.inputs.filter(i => i.month === month).map(i => [i.employee_id, i]))
  const byEmpDay = new Map<string, DayMark>()
  for (const m of store.attendance) byEmpDay.set(`${m.employee_id}|${m.date}`, m)
  const days = daysInMonthKey(month)
  const weeklyOff = WEEKDAYS.includes(store.settings.weekly_off) ? store.settings.weekly_off : ''
  const thisMonth = currentMonth(today)

  const columns = Array.from({ length: days }, (_, i) => {
    const day = i + 1
    const date = `${month}-${String(day).padStart(2, '0')}`
    return { day, date, weekday: weekdayOf(date), weekly_off: !!weeklyOff && weekdayOf(date) === weeklyOff, past: month < thisMonth || (month === thisMonth && date <= today) }
  })

  const rows: DayBookRow[] = roster.on.map(e => {
    const start = e.join_date && e.join_date > monthStart(month) ? e.join_date : monthStart(month)
    const end = e.leave_date && e.leave_date < monthEnd(month) ? e.leave_date : monthEnd(month)
    let onRoll = 0
    const cells: DayBookCell[] = columns.map(c => {
      const onRocks = c.date >= start && c.date <= end
      if (onRocks) onRoll++
      const m = byEmpDay.get(`${e.id}|${c.date}`)
      const mark = m ? m.mark : ''
      return {
        date: c.date, day: c.day, weekday: c.weekday, weekly_off: c.weekly_off, past: c.past,
        on_roll: onRocks,
        mark, means: mark ? markMeaning(mark) : null,
        source: m ? m.source : '', note: m ? m.note : '', written: !!m,
      }
    })
    // A mark only counts on a day the person was actually on the rolls. A day written outside the
    // window is odd data, not attendance: it is kept and named below, never added to a tally.
    const inPage = cells.filter(c => c.on_roll)
    const row: DayBookRow = {
      employee: e, cells,
      present_days: inPage.filter(c => c.means === 'present').length,
      loss_days: round2(inPage.reduce((a, c) => a + (c.means === 'loss' ? (c.mark === '0.5' ? 0.5 : 1) : 0), 0)),
      neutral_days: inPage.filter(c => c.means === 'neutral').length,
      written_days: inPage.filter(c => c.written).length,
      on_roll_days: onRoll,
      month_lop_days: inputsByEmp.get(e.id)?.lop_days ?? null,
      outside_rolls: [],
    }
    return row
  })

  // A mark for a day the person was not on the rolls is kept (nothing is silently dropped) but it
  // lives outside the ruled page, so the book lists it instead of pretending it was never written.
  const onRolls = new Map(rows.map(r => [r.employee.id, r]))
  const offNames = new Map(roster.off.map(o => [o.employee.id, `${o.employee.name} — ${o.why}`]))
  const outside: string[] = []
  for (const m of store.attendance) {
    const row = onRolls.get(m.employee_id)
    if (row) {
      if (m.date < monthStart(month) || m.date > monthEnd(month)) continue
      const cell = row.cells.find(c => c.day === Number(m.date.slice(8)))
      if (!cell || !cell.on_roll) {
        row.outside_rolls.push({ date: m.date, mark: m.mark })
        outside.push(`${row.employee.name}: ${m.date} marked ${m.mark}, a day they were not on the rolls. Kept, named, and counted nowhere.`)
      }
      continue
    }
    if (offNames.has(m.employee_id)) {
      if (m.date < monthStart(month) || m.date > monthEnd(month)) continue
      outside.push(`${offNames.get(m.employee_id)}: a mark (${m.mark}) kept for ${m.date}`)
    }
  }

  const findings = [...outside]
  for (const r of rows) {
    if (r.loss_days > 0 && r.month_lop_days !== null && r.month_lop_days !== r.loss_days) {
      findings.push(`${r.employee.name}: the book says ${r.loss_days} lost day(s), the month row says ${r.month_lop_days}. The month row is what the salary uses — pull the book, or correct it by hand.`)
    }
    for (const c of r.cells) {
      if (c.on_roll && c.written && c.weekly_off && markMeaning(c.mark) === 'loss') {
        findings.push(`${r.employee.name}: ${c.date} is a ${c.weekday}, the shop's weekly off, and it is marked ${c.mark}. The count reads what was written.`)
      }
    }
  }
  const keptAny = store.attendance.length > 0
  if (!keptAny) findings.unshift('This register has no day book yet. Nothing here is inferred: the month rows keep whatever they hold until the shop writes days or pulls them.')
  const unmarked = rows.filter(r => r.written_days === 0).map(r => r.employee.name)

  const cellsWritten = rows.reduce((a, r) => a + r.written_days, 0)
  const cellsExpected = rows.reduce((a, r) => a + r.on_roll_days, 0)
  // Only a day the person was on the rolls for, only a day that has already happened. A blank on a
  // future Tuesday or before somebody joined is not a missing mark, so it is never named as one.
  const unwrittenOnOff = rows.reduce((a, r) => a + r.cells.filter(c => c.on_roll && !c.written && c.weekly_off && c.past).length, 0)
  const unwritten = rows.reduce((a, r) => a + Math.max(0, r.on_roll_days - r.written_days), 0)

  return {
    month,
    kept_any: keptAny,
    doctrine: 'Unwritten days are not absent days. The book counts only what the shop wrote.',
    weekly_off: weeklyOff,
    columns, rows, unmarked_people: unmarked, findings,
    footer: {
      people: rows.length,
      cells_expected: cellsExpected,
      cells_written: cellsWritten,
      unwritten_days: unwritten,
      unwritten_on_weekly_off: unwrittenOnOff,
      loss_days_total: round2(rows.reduce((a, r) => a + r.loss_days, 0)),
      people_with_loss: rows.filter(r => r.loss_days > 0).length,
    },
  }
}

export interface DayMarkResult {
  ok: boolean
  /** Why nothing was written. Printed beside the cell, and the reason the store was untouched. */
  why: string
  store: PayrollStore | null
  mark: DayMark | null
}

/** A mark's own note, kept short: the cell is a day, not a place for an essay. */
function markNote(note: string): string {
  return note.trim().slice(0, 120)
}

/**
 * The only door a mark has. A day the person was not on the rolls, a mark the register cannot read,
 * a date outside the month, or an empty month all produce a refusal and a store that did not change
 * — the book never fixes a bad write by guessing what the shop meant.
 */
export function markDay(
  orgId: string,
  employeeId: string,
  date: string,
  mark: string,
  source: DayMarkSource = 'hand',
  note = '',
  today = todayISO(),
): DayMarkResult {
  const store = loadPayroll(orgId)
  if (!isMonth(date.slice(0, 7))) return { ok: false, why: 'That date is not a month-day the book can rule.', store: null, mark: null }
  const employee = store.employees.find(e => e.id === employeeId)
  if (!employee) return { ok: false, why: 'This day would be kept for a person who is not in the register.', store: null, mark: null }
  if (!isDate(date)) return { ok: false, why: 'That is not a real calendar day.', store: null, mark: null }
  if (date > today) {
    return { ok: false, why: `${date} has not happened yet. The book keeps days that were worked, not days that are planned — the month run already refuses a future month, and a day is no different.`, store: null, mark: null }
  }

  const trimmed = str(mark).trim()
  // An empty mark is a *clear*: it is the one write that removes rather than adds, and it is legal
  // for any day, inside or outside the rolls — a mistake should be erasable, not permanent.
  if (!trimmed) {
    const next = mutatePayroll(orgId, s => ({ ...s, attendance: s.attendance.filter(m => !(m.employee_id === employeeId && m.date === date)) }))
    return { ok: true, why: '', store: next, mark: null }
  }
  const canonical = canonicalMark(trimmed)
  if (!canonical) {
    return { ok: false, why: `"${trimmed}" is not a mark this register can read. The book keeps the shop's own spellings — but only the ones it knows what to count with.`, store: null, mark: null }
  }
  if (employee.join_date && date < employee.join_date) {
    return { ok: false, why: `${employee.name} joined on ${employee.join_date}, so ${date} is before they were on the rolls.`, store: null, mark: null }
  }
  if (employee.leave_date && date > employee.leave_date) {
    return { ok: false, why: `${employee.name} left on ${employee.leave_date}, so ${date} is after they went.`, store: null, mark: null }
  }
  if (!employee.active) {
    return { ok: false, why: `${employee.name} is marked inactive — no day is kept for a person no month is run for.`, store: null, mark: null }
  }
  const entry: DayMark = {
    employee_id: employeeId, date, mark: canonical, source,
    note: markNote(note), written_at: new Date().toISOString(),
  }
  const next = mutatePayroll(orgId, s => ({
    ...s,
    attendance: [...s.attendance.filter(m => !(m.employee_id === employeeId && m.date === date)), entry],
  }))
  return { ok: true, why: '', store: next, mark: entry }
}

/** Clear a whole person-month — the eraser for a sheet that was ruled for the wrong month. */
export function clearMonthMarks(orgId: string, employeeId: string, month: string): { ok: boolean; cleared: number; store: PayrollStore } {
  if (!isMonth(month)) return { ok: false, cleared: 0, store: loadPayroll(orgId) }
  let cleared = 0
  const store = mutatePayroll(orgId, s => {
    const before = s.attendance.length
    const after = s.attendance.filter(m => !(m.employee_id === employeeId && m.date.slice(0, 7) === month))
    cleared = before - after.length
    return { ...s, attendance: after }
  })
  return { ok: true, cleared, store }
}

export interface SheetBridge {
  marks: DayMark[]
  people: number
  /** Per person, the days the sheet actually ruled for them — what the book would gain. */
  per_person: { employee_id: string; name: string; days: number }[]
  notes: string[]
  refusals: string[]
}

/**
 * The pasted sheet's other future. A day-grid sheet (dates across the top, P / A / H in the cells)
 * can land as *marks* rather than as one figure; a summary sheet has no days to keep and says so,
 * pointing back at the lost-days reader that was built for it.
 */
export function marksFromPlan(plan: AttendancePlan, month: string, today = todayISO()): SheetBridge {
  const refusals: string[] = []
  const notes: string[] = []
  if (!isMonth(month) || plan.month !== month) {
    return { marks: [], people: 0, per_person: [], notes, refusals: ['That preview was read against a different month, and a day book is ruled by date.'] }
  }
  if (plan.blockers.length) {
    return { marks: [], people: 0, per_person: [], notes, refusals: [plan.blockers[0]] }
  }
  if (!plan.grid) {
    notes.push('This sheet counts days instead of naming them — it has a Present or LOP column, no dates across the top. Its one lost-day figure still goes to the month run; there is nothing here for the book to keep.')
    return { marks: [], people: 0, per_person: [], notes, refusals: [] }
  }
  // A row the sheet reader refused never reaches `plan.matches`, so the bridge cannot see the mark it
  // disliked — which is exactly why the refusals travel across. They are split by their own `kind`,
  // never by their sentence: a line the reader could not *place* (a stranger, a shared code, an
  // unreadable mark) stops the page, because a book that silently omitted a person would look
  // complete. A line that simply carries no marks (`blank`) is the sheet agreeing with the book's own
  // doctrine, so it is noted and skipped — a supervisor who marks only the absents is the common case.
  const skipped: string[] = []
  for (const r of plan.refusals) {
    if (r.kind === 'blank') { skipped.push(r.text); continue }
    refusals.push(`${r.reason} (sheet line ${r.line})`)
  }
  const dayCols = plan.columns.filter(c => c.role === 'day' && c.day)
  const daysInMonth = daysInMonthKey(month)
  const marks: DayMark[] = []
  const per = new Map<string, { name: string; days: number }>()
  const stampedAt = new Date().toISOString()
  for (const m of plan.matches) {
    for (const col of dayCols) {
      const raw = (m.cells[col.index] ?? '').trim()
      if (!raw) continue
      const canonical = canonicalMark(raw)
      if (!canonical) {
        refusals.push(`${m.name}: "${raw}" on day ${col.day} is a mark this register cannot read.`)
        continue
      }
      const day = col.day as number
      if (day < 1 || day > daysInMonth) {
        refusals.push(`${m.name}: day ${day} does not exist in ${monthLabel(month)}.`)
        continue
      }
      const date = `${month}-${String(day).padStart(2, '0')}`
      if (date > today) {
        refusals.push(`${m.name}: ${date} has not happened yet. A day book keeps days that were worked, not days that are planned.`)
        continue
      }
      marks.push({ employee_id: m.employee_id, date, mark: canonical, source: 'sheet', note: '', written_at: stampedAt })
    }
    const count = dayCols.filter(c => (m.cells[c.index] ?? '').trim()).length
    if (count > 0) per.set(m.employee_id, { name: m.name, days: count })
  }
  // One entry per person-day: the last reading wins, the way the envelope parses it back.
  const dedup = new Map<string, DayMark>()
  for (const m of marks) dedup.set(`${m.employee_id}|${m.date}`, m)
  const kept = [...dedup.values()]
  notes.push(`${kept.length} day mark${kept.length === 1 ? '' : 's'} for ${per.size} ${per.size === 1 ? 'person' : 'people'}. The marks are what the sheet wrote — a day it left blank stays blank.`)
  if (skipped.length) {
    notes.push(`${skipped.length} row${skipped.length === 1 ? '' : 's'} on the sheet carr${skipped.length === 1 ? 'ies' : 'y'} no mark at all. The book leaves ${skipped.length === 1 ? 'that person' : 'those people'} exactly as they stand — a blank row is not a month of presents, and it is not a refusal either.`)
  }
  return { marks: kept, people: per.size, per_person: [...per.entries()].map(([employee_id, v]) => ({ employee_id, name: v.name, days: v.days })), notes, refusals }
}

/** Write the bridge's marks through the register's one door. A refusal list of any length writes nothing. */
export function writeSheetMarks(orgId: string, bridge: SheetBridge): { ok: boolean; written: number; store: PayrollStore } {
  if (bridge.refusals.length) return { ok: false, written: 0, store: loadPayroll(orgId) }
  if (!bridge.marks.length) return { ok: true, written: 0, store: loadPayroll(orgId) }
  let written = 0
  const store = mutatePayroll(orgId, s => {
    const next = [...s.attendance]
    for (const m of bridge.marks) {
      const at = next.findIndex(x => x.employee_id === m.employee_id && x.date === m.date)
      if (at >= 0) next.splice(at, 1)
      next.push(m)
    }
    written = bridge.marks.length
    return { ...s, attendance: next }
  })
  return { ok: true, written, store }
}

export interface BookPullResult {
  ok: boolean
  written: number
  unchanged: number
  /** People the book has no days for. Their month rows keep whatever they already held. */
  untouched: number
  refused: { name: string; reason: string }[]
  store: PayrollStore
}

/**
 * Pull the month's lost days out of the day book. This is not a second computation of anything: it
 * reads the marks, counts them the way the grid shows them, and pushes each candidate row through
 * the same `validateInput()` the month form runs — so the book cannot smuggle past the month's
 * length, the joining window or the future-month rules. The provenance sentence it stamps is the
 * register's own attendance tag, so a payslip can say *where* the month's number came from:
 * a pasted sheet, this book, or the owner's typing.
 */
export function pullMonthFromBook(orgId: string, month: string, today = todayISO()): BookPullResult {
  const store0 = loadPayroll(orgId)
  if (!isMonth(month)) return { ok: false, written: 0, unchanged: 0, untouched: 0, refused: [{ name: 'the whole month', reason: 'A month is YYYY-MM.' }], store: store0 }
  const book = dayBook(store0, month, today)
  if (!book.rows.length) return { ok: false, written: 0, unchanged: 0, untouched: 0, refused: [{ name: 'the whole month', reason: `${monthLabel(month)} has nobody on the rolls, so there is no book to pull.` }], store: store0 }
  if (!book.footer.cells_written) {
    return {
      ok: false, written: 0, unchanged: 0, untouched: book.rows.length,
      refused: [{ name: 'the whole month', reason: 'The day book has no marks for this month. An empty book is not a month of absents — nothing is pulled, and nothing is deducted.' }],
      store: store0,
    }
  }
  const refused: BookPullResult['refused'] = []
  let unchanged = 0
  let written = 0
  let untouched = 0
  const store = mutatePayroll(orgId, s => {
    let inputs = s.inputs
    for (const r of book.rows) {
      // A person the book never wrote is *left alone*, not zeroed: an unwritten day is not an absent
      // day, so a blank page cannot be read as a month of full attendance and cut nobody's pay.
      if (r.written_days === 0) { untouched++; continue }
      const employee = s.employees.find(e => e.id === r.employee.id) || null
      const current = inputs.find(i => i.employee_id === r.employee.id && i.month === month) || null
      const candidate: PayInput = current ? { ...current, lop_days: r.loss_days } : { ...newInput(r.employee.id, month), lop_days: r.loss_days }
      const blocked = validateInput(candidate, employee, month, today).find(x => x.level === 'block')
      if (blocked) { refused.push({ name: r.employee.name, reason: blocked.message }); continue }
      const detail = `day book, ${monthLabel(month)}: ${r.written_days} of ${r.on_roll_days} day(s) marked`
      // The register's own stamper: the tag is replaced rather than stacked, so two provenances can
      // never sit on one month row, and any hand text after the em dash survives.
      const stamped = current
        ? { ...current, lop_days: r.loss_days, note: stampAttendanceNote(current.note, month, detail) }
        : { ...candidate, note: stampAttendanceNote('', month, detail) }
      inputs = inputs.some(i => i.id === stamped.id) ? inputs.map(i => (i.id === stamped.id ? stamped : i)) : [...inputs, stamped]
      if (current && current.lop_days === r.loss_days) unchanged++
      else written++
    }
    return { ...s, inputs }
  })
  return { ok: refused.length === 0, written, unchanged, untouched, refused, store }
}

/** The month's ruled page, the book's own marks in it: printable, and pasteable back a year later. */
export function dayBookCsv(book: DayBook): string {
  if (!isMonth(book.month)) return ''
  const head = ['Code', 'Name', ...book.columns.map(c => `${c.day} ${c.weekday.slice(0, 3)}`)]
  const q = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
  const lines = [head.join(',')]
  for (const r of book.rows) {
    lines.push([q(r.employee.code || ''), q(r.employee.name), ...r.cells.map(c => q(c.mark))].join(','))
  }
  if (book.findings.length) lines.push('', `Findings: ${book.findings.join('; ')}`)
  lines.push('', `Unwritten days are not absent days. ${book.footer.cells_written} of ${book.footer.cells_expected} day(s) written for ${monthLabel(book.month)}.`)
  return lines.join('\n')
}

/** Convenience for callers that only have a store: the label the CSV line needs. */
export function dayBookLabel(month: string): string {
  return monthLabel(month)
}

/** Read a day book back out of raw envelope JSON — the vault and the tests use this, not a parser of their own. */
export function dayMarksFromEnvelope(raw: unknown): DayMark[] {
  let value = raw
  // The vault hands over what localStorage holds: a string. Parsing is attempted, never trusted —
  // an envelope that is not JSON is simply a book with no marks in it.
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const o = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const marks = parseDayMarks(o.attendance)
  const employees = Array.isArray(o.employees) ? o.employees as { id?: unknown }[] : []
  const ids = new Set(employees.map(e => str(e?.id)).filter(Boolean))
  return marks.filter(m => ids.has(m.employee_id))
}

/** Re-exported so a page can print the legend without importing two files for one table. */
export const MARK_LEGEND = DAY_BOOK_MARKS.filter(m => m.mark !== '')

/** The tap order the grid cycles through, re-exported beside the legend it belongs with. */
export { DAY_MARK_CYCLE } from '@/lib/payroll'

/** A short human line for the grid's footer, phrased the way the register phrases everything else. */
export function dayBookSentence(book: DayBook): string {
  if (!isMonth(book.month)) return 'Pick a month to rule the page.'
  if (!book.rows.length) return `${monthLabel(book.month)} has nobody on the rolls — the book has no page for it.`
  if (!book.footer.cells_written) {
    return `${monthLabel(book.month)}: ${book.footer.people} ${book.footer.people === 1 ? 'person' : 'people'} on the rolls, no day written yet. An unwritten day is not an absent day.`
  }
  return `${monthLabel(book.month)}: ${book.footer.cells_written} of ${book.footer.cells_expected} day(s) written; ${book.footer.people_with_loss} ${book.footer.people_with_loss === 1 ? 'person' : 'people'} with lost days, ${book.footer.loss_days_total} lost day(s) counted. ${book.footer.unwritten_days} day(s) unwritten — counted nowhere.`
}
