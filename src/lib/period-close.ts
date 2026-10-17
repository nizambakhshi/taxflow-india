// The period close — what a window still holds, read before the seal falls and after it.
//
// Why this exists: `/audit` has always answered *is this window closed* and *who tried to edit it
// after it was*, and never the question the shop is actually asking at month end — **what is still
// moving in there**. The seal itself refuses a period that has not ended (`sealPeriod`, audit.ts:361)
// but once the month is sealable nothing in the app tells the owner that four journal drafts are
// dated inside it, that a challan raised on the 28th has never been billed, or that the return for
// it is still transcribed as `not_filed`. So a shop seals a half-finished month, and the first thing
// the seal does is refuse its own unfinished paper.
//
// This library is a **reading with no door of its own** — the R3-17 shape, applied to the calendar
// rather than the shelf. It imports no store loader, writes no `localStorage`, asks no seal, moves no
// seal, appends no event: the page hands it the rows it fetched and the stores it loaded, and the
// engine folds them against one window. That is a deliberate Rule 54 discipline: `/audit` owns the
// seals and the trail, `writeEntry` owns the journal's paper, and a close reading borrows none of
// their doors because it opens nothing. It answers, and stops.
//
// What it prints, for one month:
//
//   * **the money the window holds**, through `ledger.ts`'s own `computeProfitLoss` over the window
//     and the journal rows `journal.ts` already folds — a month in progress and a month long closed
//     read through the same two derivations the statements use, so a close can never disagree with
//     `/accounting` about what a period earned;
//   * **the paper inside it that is not finished**: journal drafts dated there, delivery challans and
//     orders dated there that have never been converted — the things a seal would stop the shop from
//     completing *in that period*;
//   * **what the returns register says about it**: every filing row whose period covers the month —
//     the month's own row, the quarter it sits in, the year above both — read, never re-derived
//     (Rule 41: the filings register reads the seal and guards no door, so closing a month does not
//     stop its return being transcribed, and the sentence says so);
//   * **what the trail already holds about it**: refusals whose document date falls in the window, and
//     the seal or release whose own label covers it — the only part of this reading that is evidence
//     rather than arithmetic;
//   * and a **state**, with a sentence: `not-loaded` when the page has no rows to read (an absence of
//     evidence is never evidence of absence — Rule 27), `in-progress` while today is still inside the
//     window, `nothing-here`, `unfinished`, `ready`, and the seal's own `sealed` / `released` beside it.
//
// What this library deliberately is NOT:
//
//   * **Not a ledger, and never was the photograph either — though since R3-21 it can be handed to
//     one.** Nothing here *decides* to store a period's figures: `sealSnapshotOf` copies a reading
//     into the shape a seal may carry, and the seal that closes the window is the paper that keeps it.
//     A window sealed before that, or sealed from the Seals tab where no reading was open, has no
//     photograph — and its figures stay *today's* reading of it, which is the sentence the card prints
//     rather than one it smooths over.
//   * **Not a closer.** The act of sealing stays `sealPeriod`'s, on `/audit`'s seal dialog, under the
//     note and the date check that already govern it. This reading may be used *before* that dialog
//     and is never used instead of it.
//   * **Not a filing.** No return is stated, no window is reported, no portal is reached (Rules 41/43).
//     A `not_filed` row here is that register's own status printed with its own label, not a claim
//     about what is owed.
//   * **Not a valuation of the future.** A payment dated after the window settles a receivable raised
//     inside it without touching that window's paper; so the outstanding figure is labelled *as the
//     books read it today*, and the finding list stays about writes *dated* inside the period.
//
// All rupees sum through `journal.ts`'s `paise()` where this file adds money itself, and the
// statement figures come straight out of `computeProfitLoss` — the window's arithmetic is the
// statements' arithmetic, not a second implementation of it.

import {
  activeSeals, EVENT_META, fyStartOf, monthLabel, todayISO,
  type AuditEvent, type AuditStore, type PeriodSeal, type SealSnapshot,
} from '@/lib/audit'
import { quarterOfMonth, periodLabel, type FilingForm, type FilingRecord, type FilingStatus } from '@/lib/filings'
import { canConvert, docValue, KIND_META, type FlowDoc } from '@/lib/orderflow'
import {
  computeProfitLoss, type LedgerBill, type LedgerExpense, type LedgerInvoice, type LedgerPayment,
} from '@/lib/ledger'
import { drafts, journalRows, paise, rowsInWindow, type JournalStore } from '@/lib/journal'
import { plural, pluralNoun } from '@/lib/format'

// ── small date helpers, local so this reading owes nothing to another register ──
// (The house precedent is `audit.ts`'s own header: a window is arithmetic, and a library that
//  re-declares three lines cannot drift out of step with a shared one it has no reason to import.
//  The one thing taken rather than re-typed is *today's date* — that is a fact about the device,
//  and `/audit` already owns the reading of it.)

const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

function monthRange(month: string): { from: string; to: string } | null {
  if (!isMonth(month)) return null
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  if (m < 1 || m > 12) return null
  return { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) }
}

const inWindow = (date: string | null | undefined, from: string, to: string): boolean =>
  isDate(date) && (date as string) >= from && (date as string) <= to

// ── the window ────────────────────────────────────────────────────────────────

export interface CloseWindow {
  month: string
  label: string
  from: string
  to: string
  /** The day this reading was taken — printed, because a close reading is a live fold, not a photograph. */
  today: string
  /** The window has fully ended — the only case a seal can close (audit.ts:391 refuses the rest). */
  ended: boolean
  /** The first day this window could be sealed: the day after its last day. */
  sealableFrom: string
  fyStart: number
}

/**
 * The window a close is read against, or `null` for a period this reading cannot name. A month seal
 * is what `sealPeriod` offers and what `/audit`'s picker prints, so a month key is the only shape
 * asked for here; a period that does not parse is refused rather than guessed at.
 */
export function closeWindowOf(month: string, today: string = todayISO()): CloseWindow | null {
  const range = monthRange(month)
  if (!range) return null
  const y = Number(month.slice(0, 4))
  const m = Number(month.slice(5, 7))
  return {
    month,
    label: monthLabel(month),
    from: range.from,
    to: range.to,
    today,
    ended: range.to < today,
    // the day after the last day, spelled out because "sealable" without a date is a mood, not a fact
    sealableFrom: m === 12 ? iso(y + 1, 1, 1) : iso(y, m + 1, 1),
    fyStart: fyStartOf(range.from) ?? (m >= 4 ? y : y - 1),
  }
}

// ── the two independent answers ───────────────────────────────────────────────

/** What the seal says about the window. Nothing about whether the window is finished. */
export type SealView = 'open' | 'sealed' | 'released'

/** What the window's own paper says about whether a close is complete. Nothing about the seal. */
export type CloseState = 'not-loaded' | 'in-progress' | 'nothing-here' | 'unfinished' | 'ready'

export const CLOSE_STATE_META: Record<CloseState, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  'not-loaded': { label: 'Not read', tone: 'grey' },
  'in-progress': { label: 'Month in progress', tone: 'blue' },
  'nothing-here': { label: 'Nothing in this period', tone: 'grey' },
  unfinished: { label: 'Still moving', tone: 'amber' },
  ready: { label: 'Ready to close', tone: 'green' },
}

export const SEAL_VIEW_META: Record<SealView, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  open: { label: 'Not sealed', tone: 'grey' },
  sealed: { label: 'Sealed', tone: 'green' },
  released: { label: 'Seal released', tone: 'amber' },
}

export interface CloseFinding {
  key: string
  label: string
  /** The sentence the page prints under the label — written here so the engine owns the words. */
  detail: string
  count: number
  /** The rupees the finding carries, or 0 when the finding is about rows that hold no money. */
  amount: number
  href: string
}

export interface CloseMoney {
  /** False when the page has no document rows to read — a `0` here would be a verdict on an empty fetch. */
  loaded: boolean
  revenue: number
  purchases: number
  expenses: number
  netProfit: number
  /** Money that left or entered the till with a date inside the window. */
  received: number
  paid: number
  /** Still owed on paper *raised* in this window, as the books read it today. */
  outstanding: number
  /** What the journal folded into the statements over this window, counted from its own rows. */
  journalEntries: number
  journalLegs: number
  journalTouched: number
}

export interface CloseCounts {
  invoices: number
  cancelledInvoices: number
  bills: number
  expenses: number
  postedEntries: number
  draftEntries: number
  unconvertedPapers: number
}

export interface CloseReturnRow {
  form: FilingForm
  period: string
  label: string
  status: FilingStatus
  due: string
  filedOn: string
  statedTax: number
  /** How this row touches the month: its own period, the quarter it sits in, or the year above both. */
  touches: 'month' | 'quarter' | 'year'
}

export interface CloseTrail {
  /** Events whose own document date falls inside the window — a refusal to edit this period is here. */
  about: AuditEvent[]
  /** The sealed / released rows that name this window's covering seal, whatever day the act happened. */
  acts: AuditEvent[]
  refused: number
}

export interface CloseReading {
  window: CloseWindow
  seal: { view: SealView; seal: PeriodSeal | null }
  state: CloseState
  headline: string
  why: string
  /** Registers the page could not read for this window, by name. An empty list means everything was. */
  unread: string[]
  money: CloseMoney
  counts: CloseCounts
  findings: CloseFinding[]
  returns: CloseReturnRow[]
  trail: CloseTrail
  boundaries: string[]
}

export interface CloseInput {
  month: string
  /** Injectable so the reading is deterministic in a test and against the device in a page. */
  today?: string
  /** `null` while the page's fetch has not answered — printed as ignorance, never as an empty month. */
  documents: {
    invoices: LedgerInvoice[]
    bills: LedgerBill[]
    expenses: LedgerExpense[]
    payments: LedgerPayment[]
  } | null
  journal: JournalStore | null
  flow: FlowDoc[] | null
  filings: FilingRecord[] | null
  audit: AuditStore
}

// ── the reading ───────────────────────────────────────────────────────────────

const money = (p: number): number => p / 100

/** Two or four register names, read as English rather than as a joined array. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * The close reading for one month, or `null` for a period this reading cannot name.
 *
 * Read-only and deterministic: the same rows handed to the same window give the same answer, and
 * nothing here writes, seals, posts, files or reaches a return.
 */
export function closeReading(input: CloseInput): CloseReading | null {
  const today = (input.today && isDate(input.today) ? input.today : todayISO())
  const win = closeWindowOf(input.month, today)
  if (!win) return null

  const { from, to } = win
  const docs = input.documents
  const journal = input.journal
  const flow = input.flow
  const filings = input.filings

  // ── the seal's answer first, because it is a fact about the window, not a figure in it
  const covering = coveringSeal(input.audit, win)
  const sealView: SealView = covering
    ? (covering.released_at !== null ? 'released' : 'sealed')
    : 'open'

  // ── money: the statements' own derivations, over this window
  const jrows = journal ? rowsInWindow(journalRows(journal), { start: from, end: to }) : []
  const pl = docs
    ? computeProfitLoss(docs.invoices, docs.bills, docs.expenses, from, to, jrows)
    : null

  let receivedP = 0
  let paidP = 0
  let outstandingP = 0
  let invoiceCount = 0
  let cancelledCount = 0
  let billCount = 0
  let expenseCount = 0
  if (docs) {
    for (const i of docs.invoices) {
      if (!inWindow(i.invoice_date, from, to)) continue
      if (i.status === 'cancelled') { cancelledCount++; continue }
      invoiceCount++
      outstandingP += paise(Number(i.balance_due) || 0)
    }
    for (const b of docs.bills) if (inWindow(b.bill_date, from, to) && b.status !== 'cancelled') billCount++
    for (const e of docs.expenses) if (inWindow(e.expense_date, from, to)) expenseCount++
    for (const p of docs.payments) {
      if (!inWindow(p.payment_date, from, to)) continue
      const a = paise(Number(p.amount) || 0)
      if (p.payment_type === 'received') receivedP += a
      else if (p.payment_type === 'made') paidP += a
    }
  }

  const moneyFold: CloseMoney = {
    loaded: !!docs,
    revenue: pl?.revenue ?? 0,
    purchases: pl?.purchases ?? 0,
    expenses: pl?.totalExpenses ?? 0,
    netProfit: pl?.netProfit ?? 0,
    received: money(receivedP),
    paid: money(paidP),
    outstanding: money(outstandingP),
    journalEntries: pl?.journal.entries ?? 0,
    journalLegs: pl?.journal.legs ?? 0,
    journalTouched: pl?.journal.touched ?? 0,
  }

  const counts: CloseCounts = {
    invoices: invoiceCount,
    cancelledInvoices: cancelledCount,
    bills: billCount,
    expenses: expenseCount,
    postedEntries: new Set(jrows.map(r => r.entry_id)).size,
    draftEntries: journal ? drafts(journal).filter(e => inWindow(e.date, from, to)).length : 0,
    unconvertedPapers: flow ? flow.filter(d => inWindow(d.doc_date, from, to) && canConvert(d)).length : 0,
  }

  // ── findings: the paper a seal would stop the shop from finishing *in this period*
  const findings: CloseFinding[] = []

  if (counts.draftEntries > 0) {
    findings.push({
      key: 'journal-drafts',
      label: `${counts.draftEntries} journal ${counts.draftEntries === 1 ? 'draft is' : 'drafts are'} dated here`,
      detail:
        'A draft carries no number until it is posted. Once this period is sealed, posting one dated ' +
        `${win.label} is refused at the journal's own door — post it first, or re-date it into an open period.`,
      count: counts.draftEntries,
      amount: 0,
      href: '/journal',
    })
  }

  if (flow && counts.unconvertedPapers > 0) {
    const open = flow.filter(d => inWindow(d.doc_date, from, to) && canConvert(d))
    let valueP = 0
    for (const d of open) valueP += paise(docValue(d))
    const kinds = [...new Set(open.map(d => d.kind))]
    const kindWords = kinds.map(k => KIND_META[k].label.toLowerCase()).join(' and ')
    findings.push({
      key: 'unconverted-papers',
      label: `${open.length} ${open.length === 1 ? 'paper dated here has' : 'papers dated here have'} never been billed`,
      detail:
        `Converting a ${kindWords} dated ${win.label} raises its invoice with today's date, so the seal does not ` +
        'stop the conversion — but it does stop the document being edited afterwards, and a conversion dated in an ' +
        'open period reads against that one.',
      count: open.length,
      amount: money(valueP),
      href: KIND_META[kinds[0]].listHref,
    })
  }

  const unfiled = (filings ?? []).filter(r =>
    (r.status === 'not_filed') && touchesMonth(r.period, win))
  if (unfiled.length > 0) {
    findings.push({
      key: 'returns-unfiled',
      label: `${unfiled.length} ${unfiled.length === 1 ? 'return covering this period is' : 'returns covering this period are'} transcribed as not filed`,
      detail:
        'The filings register reads the seal and guards no door (Rule 41), so sealing ' +
        `${win.label} does not stop one of these being written up later. It stops the paper behind it: an invoice ` +
        'dated here cannot be corrected to answer a return transcribed after the close.',
      count: unfiled.length,
      amount: 0,
      href: '/gst/filings',
    })
  }

  // ── returns: every row whose period covers this month, read with its own status
  const returns: CloseReturnRow[] = (filings ?? [])
    .filter(r => touchesMonth(r.period, win))
    .map(r => ({
      form: r.form,
      period: r.period,
      label: periodLabel(r.period),
      status: r.status,
      due: r.due,
      filedOn: r.filed_on,
      statedTax: r.heads.tax,
      touches: touchKind(r.period, win),
    }))
    .sort((a, b) => (a.touches === b.touches ? a.form.localeCompare(b.form) : TOUCH_ORDER[a.touches] - TOUCH_ORDER[b.touches]))

  // ── trail: what this window is already on the record for
  const label = covering?.label ?? win.label
  const about = input.audit.events.filter(e =>
    (e.kind === 'refused' && inWindow(e.date, from, to)) ||
    (e.kind === 'note' && inWindow(e.date, from, to)))
  const acts = input.audit.events.filter(e =>
    (e.kind === 'sealed' || e.kind === 'released') && e.ref === label)
  const trail: CloseTrail = {
    about,
    acts,
    refused: about.filter(e => e.kind === 'refused').length,
  }

  // ── what the page could not read, named rather than counted as zero
  const unread: string[] = []
  if (!docs) unread.push('the documents')
  if (!journal) unread.push('the journal')
  if (!flow) unread.push('the order registers')
  if (!filings) unread.push('the filings register')

  // ── the state, and the sentence that goes with it
  const hasAnyRow =
    invoiceCount + cancelledCount + billCount + expenseCount +
    counts.postedEntries + counts.draftEntries + counts.unconvertedPapers + returns.length + trail.about.length > 0

  let state: CloseState
  if (!docs) state = 'not-loaded'
  else if (!win.ended) state = 'in-progress'
  else if (findings.length > 0) state = 'unfinished'
  else if (!hasAnyRow) state = 'nothing-here'
  else state = 'ready'

  const { headline, why } = verdict(state, sealView, win, findings, counts, trail, covering, unread)

  return {
    window: win,
    seal: { view: sealView, seal: covering },
    state,
    headline,
    why,
    unread,
    money: moneyFold,
    counts,
    findings,
    returns,
    trail,
    boundaries: [...CLOSE_BOUNDARIES],
  }
}

// ── the seal covering a window, standing first ────────────────────────────────

/**
 * The seal that answers for this window: a *standing* one whose days overlap it, else a released one
 * whose days overlapped it — printed as released, never as though it still closed anything. Newest
 * act wins, the way `sealForDate` lets a later lock win a date.
 */
function coveringSeal(store: AuditStore, win: CloseWindow): PeriodSeal | null {
  const touches = (s: PeriodSeal) => s.from <= win.to && win.from <= s.to
  const standing = activeSeals(store).filter(touches)
  if (standing.length > 0) return newest(standing, s => s.sealed_at)
  const released = store.seals.filter(x => x.released_at !== null && touches(x))
  if (released.length === 0) return null
  return newest(released, s => s.released_at || '')
}

function newest<T>(list: T[], key: (t: T) => string): T {
  let best = list[0]
  for (const x of list) if (key(x) > key(best)) best = x
  return best
}

// ── which periods cover a month ───────────────────────────────────────────────

const TOUCH_ORDER: Record<CloseReturnRow['touches'], number> = { month: 0, quarter: 1, year: 2 }

function touchKind(period: string, win: CloseWindow): CloseReturnRow['touches'] {
  if (period === win.month) return 'month'
  const [y, m] = win.month.split('-').map(Number)
  const q = quarterOfMonth(y, m)
  if (period === `${q.fy}-Q${q.q}`) return 'quarter'
  return 'year'
}

/** Does a filing row's period cover this month — its own month, the quarter it sits in, or the year? */
function touchesMonth(period: string, win: CloseWindow): boolean {
  const p = (period ?? '').trim()
  if (p === win.month) return true
  const [y, m] = win.month.split('-').map(Number)
  const q = quarterOfMonth(y, m)
  if (p === `${q.fy}-Q${q.q}`) return true
  return /^\d{4}$/.test(p) && Number(p) === win.fyStart
}

// ── the verdict ───────────────────────────────────────────────────────────────

/**
 * One headline and one paragraph for the two answers, kept separate on purpose: a period can be
 * **sealed and unfinished** — that is what sealing a moving month produces — and the reading says both
 * rather than letting one word swallow the other.
 */
function verdict(
  state: CloseState,
  view: SealView,
  win: CloseWindow,
  findings: CloseFinding[],
  counts: CloseCounts,
  trail: CloseTrail,
  seal: PeriodSeal | null,
  unread: string[],
): { headline: string; why: string } {
  const sealedSentence = view === 'sealed' && seal
    ? `It is closed — ${seal.sealed_by ? `${seal.sealed_by} sealed ` : 'this device sealed '}${seal.label} on ` +
      `${(seal.sealed_at || '').slice(0, 10)}${seal.note ? `, with the note "${seal.note}"` : ' with no note'}.`
    : view === 'released' && seal
      ? `Its seal was lifted — ${seal.sealed_by ? `${seal.sealed_by} closed ${seal.label} on ` : `${seal.label} was closed on `}` +
        `${(seal.sealed_at || '').slice(0, 10)}, released ${seal.released_at ? seal.released_at.slice(0, 10) : 'later'}` +
        `${seal.release_reason ? `, because "${seal.release_reason}"` : ', with no reason recorded'}. Any dated write there is allowed again.`
      : ''

  if (state === 'not-loaded') {
    return {
      headline: `${win.label} is not read yet`,
      why:
        'This page has no document rows for this period yet, so it prints no figure and no verdict — ' +
        'an empty fetch is not an empty month. Reload, and the fold reads the paper it was given.',
    }
  }

  if (state === 'in-progress') {
    return {
      headline: `${win.label} is still open — today falls inside it`,
      why:
        `A period can only be closed once its last day has passed: ${win.label} runs to ${win.to}, and today is ` +
        `${win.today} — so what follows is a running reading, not a close. It could be sealed from ${win.sealableFrom}.` +
        (findings.length ? ` ${plural(findings.length, 'thing')} in it would still move.` : ''),
    }
  }

  const unfinished = findings.length > 0
  const body = unfinished
    ? `${findings.length} ${findings.length === 1 ? 'thing inside it is' : 'things inside it are'} not finished: ${findings.map(f => f.label).join('; ')}.`
    : state === 'nothing-here'
      ? 'Nothing is dated inside it on this device — no document, no posting, no return row, no event. A month with no paper in it is a finding, not a clean close: check that the shop is not simply reading a period it has not used.'
      : `The period holds ${plural(counts.invoices, 'invoice')}, ${plural(counts.bills, 'purchase bill')}, ${plural(counts.expenses, 'expense')} and ${plural(counts.postedEntries, 'journal posting')}, and nothing dated inside it is left draft or unbilled.`

  const refusedSentence = trail.refused > 0
    ? ` ${trail.refused} write${trail.refused === 1 ? ' has' : 's have'} been refused against paper dated in this period — the trail holds the detail.`
    : view === 'sealed' ? ' Nothing has tried to edit paper dated here since.' : ''

  // Rule 27, printed: a register the page could not read is named, not silently folded into a zero.
  // (`state` is already narrowed here — `not-loaded` and `in-progress` returned above.)
  const unreadSentence = unread.length > 0
    ? ` Read without ${list(unread)}, so nothing here counts against ${unread.length === 1 ? 'it' : 'them'} — a zero is an absence of evidence, not a clean period.`
    : ''

  const headline = view === 'sealed'
    ? (unfinished ? `Closed, with ${findings.length} ${pluralNoun(findings.length, 'thing')} still moving inside` : `Closed — ${win.label} stands sealed`)
    : unfinished ? `${win.label} is not ready to close` :
      state === 'nothing-here' ? `${win.label} holds no paper` : `${win.label} is ready to close`

  return {
    headline,
    why: `${sealedSentence}${sealedSentence ? ' ' : ''}${body}${refusedSentence}${unreadSentence}`,
  }
}

// ── the photograph a seal keeps, and the drift read off it (R3-21) ─────────────

/**
 * Draw this reading into the shape a seal carries. **The two objects are spread, not restated** —
 * `CloseMoney` and `CloseCounts` keep their own key names, so a field added to the reading cannot
 * quietly go missing from the picture, and this file never re-computes a rupee to draw it (Rule 56).
 * A snapshot of a window whose documents were never fetched is still legal: it stores `loaded:
 * false`, and the comparison the next function makes refuses to set an absence beside a figure.
 */
export function sealSnapshotOf(r: CloseReading): SealSnapshot {
  return {
    month: r.window.month,
    taken_on: r.window.today,
    state: r.state,
    headline: r.headline,
    money: { ...r.money },
    counts: { ...r.counts },
    findings: r.findings.map(f => ({ key: f.key, label: f.label, count: f.count, amount: f.amount })),
    unread: [...r.unread],
  }
}

export interface CloseDriftLine {
  key: string
  label: string
  /** What the photograph held the day the seal fell. */
  sealed: number
  /** What the same derivation prints today. */
  now: number
  delta: number
  kind: 'money' | 'paper'
}

export interface CloseDriftFinding {
  key: string
  label: string
  sealed: number
  now: number
}

export interface CloseDrift {
  /** The photograph itself — the page prints its date, its verdict and its own words. */
  snapshot: SealSnapshot
  lines: CloseDriftLine[]
  /** What was unfinished then, beside what is unfinished now — matched by finding key. */
  findings: CloseDriftFinding[]
  /**
   * Sentences for the pairs this comparison refuses to make. A figure beside an absence is not a
   * delta, and a photograph taken with a register unread cannot be blamed on the register that
   * moved (Rule 27 again: an unread thing prints as unread, never as zero).
   */
  withheld: string[]
  /** True when at least one comparable line moved. */
  moved: boolean
  /** The registers the *photograph* was taken without. */
  photo_unread: string[]
}

const MONEY_LINES = [
  ['revenue', 'Revenue billed'],
  ['purchases', 'Purchases'],
  ['expenses', 'Expenses'],
  ['netProfit', 'Net for the window'],
  ['received', 'Received in the window'],
  ['paid', 'Paid in the window'],
  ['outstanding', 'Still outstanding'],
] as const

const PAPER_LINES = [
  ['invoices', 'Invoices dated here'],
  ['cancelledInvoices', 'Cancelled invoices'],
  ['bills', 'Bills dated here'],
  ['expenses', 'Expenses dated here'],
  ['postedEntries', 'Posted journal entries'],
  ['draftEntries', 'Draft journal entries'],
  ['unconvertedPapers', 'Papers never converted'],
] as const

/**
 * Set the seal's photograph beside today's reading of the same window. Returns `null` when there is
 * nothing to compare — an open period, a seal that carried no picture, or a seal whose picture this
 * register could not read (the last of those is the page's own sentence to print, not this one's
 * silence).
 */
export function closeDrift(r: CloseReading): CloseDrift | null {
  const seal: PeriodSeal | null = r.seal.seal
  if (!seal || !seal.snapshot) return null
  const snap = seal.snapshot
  // A picture of a different window would be a caption error, not a comparison. The seal engine
  // refuses to store one; reading a hand-edited file is not a licence to print one either.
  if (snap.month && snap.month !== r.window.month) return null

  const lines: CloseDriftLine[] = []
  const withheld: string[] = []

  const moneyComparable = snap.money.loaded && r.money.loaded
  if (moneyComparable) {
    for (const [k, label] of MONEY_LINES) {
      const sealed = snap.money[k]
      const now = r.money[k]
      lines.push({ key: `money:${k}`, label, sealed, now, delta: now - sealed, kind: 'money' })
    }
  } else if (snap.money.loaded && !r.money.loaded) {
    withheld.push('The seal\'s photograph has rupees in it and today\'s reading does not — this page has no document rows for the window loaded right now, so the money lines are not comparable, and a blank is being kept rather than drawn as ₹0.')
  } else if (!snap.money.loaded && r.money.loaded) {
    withheld.push('The seal was put on this window before its documents were read — the photograph holds no money figure, so there is nothing on the sealed side to set today\'s against.')
  } else {
    withheld.push('Neither the photograph nor today\'s reading holds a document figure for this window, so no money line is drawn.')
  }

  for (const [k, label] of PAPER_LINES) {
    const sealed = snap.counts[k]
    const now = r.counts[k]
    lines.push({ key: `paper:${k}`, label, sealed, now, delta: now - sealed, kind: 'paper' })
  }

  // Findings are matched by their own key, so a finding that has gone prints as it went rather than
  // as a number the two columns never named.
  const keys: string[] = []
  for (const f of snap.findings) if (!keys.includes(f.key)) keys.push(f.key)
  for (const f of r.findings) if (!keys.includes(f.key)) keys.push(f.key)
  const findings = keys.map(key => {
    const was = snap.findings.find(f => f.key === key)
    const is = r.findings.find(f => f.key === key)
    const label = is?.label ?? was?.label ?? key
    return { key, label, sealed: was?.count ?? 0, now: is?.count ?? 0 }
  })

  if (snap.unread.length > 0) {
    withheld.push(`The photograph itself was taken without ${snap.unread.join(', ')} — those figures are a picture of a partial book, and a difference in them is not proof that the shop moved.`)
  }

  return {
    snapshot: snap,
    lines,
    findings,
    withheld,
    moved: lines.some(l => l.delta !== 0),
    photo_unread: snap.unread,
  }
}

// ── the boundaries this reading prints rather than smooths over ───────────────

export const CLOSE_BOUNDARIES: string[] = [
  'A seal closed from *this* tab keeps a photograph — the figures this reading printed the day the window fell, stored on the seal and compared against today below. A seal that fell before that, or one put on from the Seals tab where no reading was open, keeps none: where no photograph stands, the rupees above are today\'s reading of the period and may have moved since the seal fell.',
  'Nothing on this page closes anything. The act of sealing stays the seal dialog\'s, under its own rule that a period is sealed only once its last day has passed, and under the note the shop leaves with it.',
  'The filings register reads the seal and guards no door (Rule 41): a return covering this period can still be transcribed after the close — what the close stops is the paper behind it.',
  'A payment or a note dated after this window settles what this window raised without touching it, so the outstanding figure is read as the books hold it today, not as it stood on the last day of the period.',
  'The seal is asked by this app\'s writers. A row changed directly in the database, or by a client that never imports them, appears in no refusal here and is not stopped by any seal (the same boundary the seals page prints).',
  'A close reading is not a return, a filing or an accounting standard. It says what the shop\'s own registers hold for one month, and reaches nothing outside them.',
]

// ── export ────────────────────────────────────────────────────────────────────

export const CLOSE_CSV_HEADERS = [
  'kind', 'period', 'label', 'item', 'count', 'amount', 'detail', 'reference',
]

/**
 * One flat table, five kinds of row: the summary, each finding, each figure the seal photographed (when
 * the seal carries one), each return the register holds for the period, and each event the trail holds
 * about it. A shop taking this to a CA gets the reading, the picture the seal kept, and the window each
 * was read in, in the same file.
 */
export function closeCsvRows(r: CloseReading): (string | number)[][] {
  const rows: (string | number)[][] = [[
    'summary', r.window.month, r.window.label, CLOSE_STATE_META[r.state].label,
    r.counts.invoices + r.counts.bills + r.counts.expenses + r.counts.postedEntries,
    r.money.revenue,
    `${r.headline} — ${r.why}`,
    SEAL_VIEW_META[r.seal.view].label,
  ]]
  for (const f of r.findings) {
    rows.push(['finding', r.window.month, r.window.label, f.label, f.count, f.amount, f.detail, f.href])
  }
  // The photograph, when the seal carries one: the same lines the card prints, in the same file, so a
  // CA comparing this month to a file taken at the time does not have to ask whether it moved.
  const drift = closeDrift(r)
  if (drift) {
    for (const l of drift.lines) {
      rows.push(['sealed_figure', r.window.month, r.window.label, l.label, 1, l.now,
        `as sealed ${drift.snapshot.taken_on}: ${l.sealed} · moved ${l.delta}`, `photograph taken ${drift.snapshot.taken_on}`])
    }
  }
  for (const t of r.returns) {
    rows.push(['return', r.window.month, r.window.label, `${t.form} · ${t.label}`, 1, t.statedTax,
      `${t.status} · due ${t.due || '—'} · filed ${t.filedOn || '—'} · covers the ${t.touches}`, `/gst/filings?q=${t.period}`])
  }
  for (const e of [...r.trail.about, ...r.trail.acts]) {
    rows.push(['trail', r.window.month, r.window.label, EVENT_META[e.kind].label, 1, 0, e.note,
      `#${e.seq} ${e.date} ${e.target} ${e.actor}`])
  }
  return rows
}

/** The month a close defaults to: the most recent one that has fully ended. A close is asked of a
 *  period the shop can still act on, not of the one still running. */
export function defaultCloseMonth(today: string = todayISO()): string {
  const y = Number(today.slice(0, 4))
  const m = Number(today.slice(5, 7))
  if (!Number.isFinite(y) || !Number.isFinite(m)) return today.slice(0, 7)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

/** The month picker's rows for one financial year, sealability and all, in the register's own words. */
export function closeMonthOptions(
  startYear: number,
  today: string = todayISO(),
): { month: string; label: string; ended: boolean }[] {
  const out: { month: string; label: string; ended: boolean }[] = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(startYear, 3 + i, 1))
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const win = closeWindowOf(month, today)
    if (win) out.push({ month, label: win.label, ended: win.ended })
  }
  return out
}
