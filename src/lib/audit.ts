// The audit trail and the period seal — evidence of what was decided, and a window closed.
//
// Why this exists: the review that opened R3 asks, of a bookkeeping app, two things a shop
// cannot answer from the documents alone. *Who changed what, and when* — and *can a closed
// period still be edited?* A tax file that cannot answer the first is unauditable; a set of
// books that lets a March invoice be re-typed after the year has been filed is not a ledger,
// it is a draft. This register keeps the trail (append-only) and lets the shop put a seal on a
// period that has ended (a deliberate lock the write paths refuse).
//
// It rides on localStorage (ADR-013) as `taxflow:audit:<orgId>` at version 1, alongside the
// other judgement registers, and it joins the vault in the same round it is created (Rule 31).
// Like the cost centres, the projects and the day book, **it moves no money** — a seal is a
// window, an event is a sentence; the money stays in the documents, and this file only records
// decisions about them. Since R3-21 a seal may also carry `snapshot`: a **photograph** of numbers
// some other register printed on the day the window closed. That does not bend the rule above —
// the snapshot owns no money, it repeats what a reading already computed, `ledger.ts` reads none
// of it, and a seal without one is a seal that simply never had its picture taken.
//
// The three decisions that make it trustworthy rather than decorative:
//
//  * **The trail is append-only, and it proves it.** Every event carries a monotonic `seq`
//    counting from 1. `verifyChain` walks the log and names any gap, duplicate or out-of-order
//    number — the shape a hand-edit leaves behind. It is a checksum, not a signature: it shows a
//    row was touched, it cannot say who. The page prints "the trail is unbroken", never a security
//    claim stronger than that.
//  * **A period is sealed only once it has ended, and releasing is not deleting.** `sealPeriod`
//    refuses a window whose last day is today or later — you cannot seal a month you are still in
//    and call it history — and refuses one that overlaps a seal already standing. `releaseSeal`
//    never removes the row: it stamps `released_at` and a `release_reason`, and the seal stays
//    visible as a released seal. A silent unlock is exactly what an auditor looks for, so an
//    empty reason is refused rather than guessed at.
//  * **The seal is enforced where it is wired, and the refusal is logged.** `sealGuard` is the
//    one question a document write path asks: does this date fall inside a standing seal? It
//    answers with the register's own sentence, so no page has to invent one. `askSeal` is that
//    question *plus* the trail — it asks, and when the answer is yes it appends a `refused` event
//    before returning, so an attempt to edit a closed period is itself on the record even though
//    nothing was changed. `requireOpenSeal` is the throwing form the shared money writers use
//    (`create-invoice.ts`, `create-bill.ts`, `creditnote.ts`), which means a sealed window stops a
//    POS sale, a recurring catch-up bill and an offline replay as surely as it stops the invoice
//    form — the door is on the writer, not on the page that happens to host it. Which paths
//    consult the seal is printed on the page, because a lock that quietly covers only some doors
//    is worse than one that says which doors it covers.

const KEY_AUDIT = 'taxflow:audit:'
const AUDIT_VERSION = 1

// ── the shape ─────────────────────────────────────────────────────────────────

export type SealKind = 'month' | 'year'

/**
 * The photograph a seal may carry — the figures one close reading printed on the day the window
 * fell (R3-21, ADR-055). **Its key names are `period-close.ts`'s `CloseMoney` / `CloseCounts`
 * names verbatim**, because the snapshot is drawn by spreading those objects, not by restating a
 * field list a second register could forget to update. This file computes nothing: a seal with a
 * snapshot is a seal whose shop was looking at the period's own reading when it closed it, and a
 * seal without one never had its picture taken. `ledger.ts` reads none of it.
 */
export interface SealSnapshot {
  /** The month the reading actually looked at — the engine refuses to let a picture caption a different window. */
  month: string
  /** The day the reading was taken — printed, because a photograph is dated or it is nothing. */
  taken_on: string
  /** The reading's own verdict word ('ready' · 'unfinished' · …), kept so a later reader knows what kind of close was photographed. */
  state: string
  headline: string
  money: {
    loaded: boolean
    revenue: number
    purchases: number
    expenses: number
    netProfit: number
    received: number
    paid: number
    outstanding: number
    journalEntries: number
    journalLegs: number
    journalTouched: number
  }
  counts: {
    invoices: number
    cancelledInvoices: number
    bills: number
    expenses: number
    postedEntries: number
    draftEntries: number
    unconvertedPapers: number
  }
  /** What the reading said was still moving, in the reading's own words. */
  findings: { key: string; label: string; count: number; amount: number }[]
  /** Registers the photograph itself was taken without — a picture of a partial book says so. */
  unread: string[]
}

/** A window the shop has closed. `released_at` null means it stands. */
export interface PeriodSeal {
  id: string
  kind: SealKind
  /** 'YYYY-MM' for a month seal; the FY start year for a year seal (label carries '2025-26'). */
  period: string
  /** Inclusive ISO window. */
  from: string
  to: string
  /** Human label: 'September 2026', or 'FY 2025-26'. */
  label: string
  note: string
  sealed_at: string
  sealed_by: string
  released_at: string | null
  release_reason: string
  /** The period's figures as the close reading held them when the seal fell. Null is not a zero. */
  snapshot: SealSnapshot | null
  /** A snapshot rode the row but this register could not read it — printed as unread, never folded into `null`. */
  snapshot_unreadable: boolean
}

export type AuditKind = 'sealed' | 'released' | 'refused' | 'note'

/** One line of the trail. `seq` counts from 1; a gap is a hand-edit. */
export interface AuditEvent {
  id: string
  seq: number
  at: string
  kind: AuditKind
  /** The document date or period the event is about. */
  date: string
  /** What was touched — 'invoice', 'period', 'seal' — a label, never a foreign key we enforce. */
  target: string
  /** The document number or the period label. */
  ref: string
  actor: string
  note: string
}

export interface AuditStore {
  version: number
  updatedAt: string
  orgId: string
  seals: PeriodSeal[]
  events: AuditEvent[]
}

export const EVENT_META: Record<AuditKind, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  sealed: { label: 'Period sealed', tone: 'green' },
  released: { label: 'Seal released', tone: 'amber' },
  refused: { label: 'Write refused', tone: 'red' },
  note: { label: 'Note', tone: 'grey' },
}

// ── small date helpers, local so this register owes nothing to another ─────────

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function nowStamp(): string {
  return new Date().toISOString()
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))

const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}$/.test(v)

function iso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

export function monthLabel(month: string): string {
  if (!isMonth(month)) return month
  const [y, m] = month.split('-').map(Number)
  if (m < 1 || m > 12) return month
  return `${MONTHS[m - 1]} ${y}`
}

function monthRange(month: string): { from: string; to: string } | null {
  if (!isMonth(month)) return null
  const [y, m] = month.split('-').map(Number)
  if (m < 1 || m > 12) return null
  return { from: iso(y, m, 1), to: iso(y, m, daysInMonth(y, m)) }
}

/** The Indian financial year a date falls in: April–March. */
export function fyStartOf(date: string): number | null {
  if (!isDate(date)) return null
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  if (!Number.isFinite(y) || m < 1 || m > 12) return null
  return m >= 4 ? y : y - 1
}

export function fyLabel(startYear: number): string {
  return `${startYear}-${String(startYear + 1).slice(2)}`
}

function fyRange(startYear: number): { from: string; to: string } | null {
  if (!Number.isFinite(startYear) || startYear < 1990 || startYear > 2200) return null
  return { from: iso(startYear, 4, 1), to: iso(startYear + 1, 3, 31) }
}

/** 'YYYY-MM' → 'YYYY-MM-DD'. */
export function monthOf(date: string): string {
  return isDate(date) ? date.slice(0, 7) : ''
}

// ── the store ─────────────────────────────────────────────────────────────────

function emptyAudit(orgId = ''): AuditStore {
  return { version: AUDIT_VERSION, updatedAt: todayISO(), orgId, seals: [], events: [] }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Read a seal's photograph back, or say it is not there. A snapshot the register cannot read is
 * **not** folded into "no snapshot": the row keeps `snapshot_unreadable`, because a period whose
 * picture is damaged and a period that was never photographed are different sentences (Rule 27 —
 * an unread thing prints as unread, never as an empty one).
 */
function parseSnapshot(v: unknown): { snapshot: SealSnapshot | null; unreadable: boolean } {
  if (!v || typeof v !== 'object') return { snapshot: null, unreadable: false }
  const s = v as Record<string, unknown>
  const m = (s.money && typeof s.money === 'object' ? s.money : null) as Record<string, unknown> | null
  const c = (s.counts && typeof s.counts === 'object' ? s.counts : null) as Record<string, unknown> | null
  if (!m || !c) return { snapshot: null, unreadable: true }
  if (typeof s.taken_on !== 'string' || !Array.isArray(s.findings) || !Array.isArray(s.unread)) {
    return { snapshot: null, unreadable: true }
  }
  const money: Record<string, number | boolean> = {}
  for (const k of ['revenue', 'purchases', 'expenses', 'netProfit', 'received', 'paid', 'outstanding',
    'journalEntries', 'journalLegs', 'journalTouched'] as const) {
    const n = num(m[k])
    if (n === null) return { snapshot: null, unreadable: true }
    money[k] = n
  }
  if (typeof m.loaded !== 'boolean') return { snapshot: null, unreadable: true }
  money.loaded = m.loaded
  const counts: Record<string, number> = {}
  for (const k of ['invoices', 'cancelledInvoices', 'bills', 'expenses', 'postedEntries', 'draftEntries',
    'unconvertedPapers'] as const) {
    const n = num(c[k])
    if (n === null) return { snapshot: null, unreadable: true }
    counts[k] = n
  }
  const findings: SealSnapshot['findings'] = []
  for (const f of s.findings as unknown[]) {
    if (!f || typeof f !== 'object') return { snapshot: null, unreadable: true }
    const x = f as Record<string, unknown>
    const count = num(x.count)
    const amount = num(x.amount)
    if (typeof x.key !== 'string' || typeof x.label !== 'string' || count === null || amount === null) {
      return { snapshot: null, unreadable: true }
    }
    findings.push({ key: x.key, label: x.label, count, amount })
  }
  if (typeof s.month !== 'string' || typeof s.state !== 'string' || typeof s.headline !== 'string') {
    return { snapshot: null, unreadable: true }
  }
  return {
    snapshot: {
      month: s.month,
      taken_on: s.taken_on,
      state: s.state,
      headline: s.headline,
      money: money as unknown as SealSnapshot['money'],
      counts: counts as unknown as SealSnapshot['counts'],
      findings,
      unread: (s.unread as unknown[]).filter((u): u is string => typeof u === 'string'),
    },
    unreadable: false,
  }
}

function parseSeal(v: unknown): PeriodSeal | null {
  if (!v || typeof v !== 'object') return null
  const s = v as Record<string, unknown>
  const id = typeof s.id === 'string' ? s.id : ''
  const kind = s.kind === 'year' ? 'year' : s.kind === 'month' ? 'month' : null
  if (!id || !kind || !isDate(s.from) || !isDate(s.to)) return null
  const photo = parseSnapshot(s.snapshot)
  // A photograph this register cannot read is dropped from the figures but keeps its `unreadable`
  // stamp through a save — so the seal never degrades into "this window was never photographed".
  return {
    id,
    kind,
    period: typeof s.period === 'string' ? s.period : '',
    from: s.from,
    to: s.to,
    label: typeof s.label === 'string' ? s.label : '',
    note: typeof s.note === 'string' ? s.note : '',
    sealed_at: typeof s.sealed_at === 'string' ? s.sealed_at : '',
    sealed_by: typeof s.sealed_by === 'string' ? s.sealed_by : '',
    released_at: typeof s.released_at === 'string' ? s.released_at : null,
    release_reason: typeof s.release_reason === 'string' ? s.release_reason : '',
    snapshot: photo.snapshot,
    // The stamp is read off the row as well as recomputed. A damaged photograph has no figures left
    // to parse, so `parseSnapshot` answers `{ null, false }` the second time this file is read — and
    // without the row's own flag a damaged picture would quietly decay into "never photographed"
    // (Rule 27: an unread thing keeps saying it was unread).
    snapshot_unreadable: photo.unreadable || s.snapshot_unreadable === true,
  }
}

function parseEvent(v: unknown): AuditEvent | null {
  if (!v || typeof v !== 'object') return null
  const e = v as Record<string, unknown>
  const id = typeof e.id === 'string' ? e.id : ''
  const seq = typeof e.seq === 'number' && Number.isFinite(e.seq) ? e.seq : 0
  const kind: AuditKind =
    e.kind === 'released' || e.kind === 'refused' || e.kind === 'note' ? e.kind : 'sealed'
  if (!id || seq <= 0) return null
  return {
    id,
    seq,
    at: typeof e.at === 'string' ? e.at : '',
    kind,
    date: typeof e.date === 'string' ? e.date : '',
    target: typeof e.target === 'string' ? e.target : '',
    ref: typeof e.ref === 'string' ? e.ref : '',
    actor: typeof e.actor === 'string' ? e.actor : '',
    note: typeof e.note === 'string' ? e.note : '',
  }
}

export function parseAudit(raw: string | null): AuditStore {
  if (!raw) return emptyAudit()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyAudit()
  }
  if (!parsed || typeof parsed !== 'object') return emptyAudit()
  const s = parsed as Record<string, unknown>
  const orgId = typeof s.orgId === 'string' ? s.orgId : ''
  if (s.version !== AUDIT_VERSION) return emptyAudit(orgId)
  const seals = Array.isArray(s.seals) ? s.seals.map(parseSeal).filter((x): x is PeriodSeal => x !== null) : []
  const events = Array.isArray(s.events) ? s.events.map(parseEvent).filter((x): x is AuditEvent => x !== null) : []
  return {
    version: AUDIT_VERSION,
    updatedAt: typeof s.updatedAt === 'string' ? s.updatedAt : todayISO(),
    orgId,
    seals,
    // The trail is read in sequence order so the newest number is last; a hand-edit that
    // re-sorted the array is still caught by verifyChain, which reads the numbers, not the order.
    events: events.slice().sort((a, b) => a.seq - b.seq),
  }
}

export function loadAudit(orgId: string): AuditStore {
  if (typeof window === 'undefined' || !orgId) return emptyAudit()
  try {
    const store = parseAudit(window.localStorage.getItem(KEY_AUDIT + orgId))
    return { ...store, orgId }
  } catch {
    return emptyAudit(orgId)
  }
}

export function saveAudit(orgId: string, store: AuditStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_AUDIT + orgId,
      JSON.stringify({ ...store, orgId, version: AUDIT_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: AuditStore) => AuditStore): AuditStore {
  const next = fn(loadAudit(orgId))
  saveAudit(orgId, next)
  return next
}

// ── appending the trail (the only writer of events) ────────────────────────────

function nextSeq(events: AuditEvent[]): number {
  return events.reduce((m, e) => (e.seq > m ? e.seq : m), 0) + 1
}

/** The one door for an event. Every writer below calls it; nothing else touches `events`. */
function append(
  store: AuditStore,
  kind: AuditKind,
  date: string,
  target: string,
  ref: string,
  actor: string,
  note: string,
): AuditEvent[] {
  const ev: AuditEvent = {
    id: newId(),
    seq: nextSeq(store.events),
    at: nowStamp(),
    kind,
    date,
    target,
    ref,
    actor: actor || 'this device',
    note,
  }
  return [...store.events, ev]
}

// ── reading the seals ─────────────────────────────────────────────────────────

export function activeSeals(store: AuditStore): PeriodSeal[] {
  return store.seals.filter(s => s.released_at === null)
}

/** The standing seal a date falls inside, newest-sealed first so a later lock wins the sentence. */
export function sealForDate(store: AuditStore, date: string): PeriodSeal | null {
  if (!isDate(date)) return null
  for (const s of activeSeals(store)) {
    if (date >= s.from && date <= s.to) return s
  }
  return null
}

export function isSealed(store: AuditStore, date: string): boolean {
  return sealForDate(store, date) !== null
}

/** Whether any date in [from,to] is covered by a standing seal — the "does this touch the seal" test. */
export function overlapsActiveSeal(
  store: AuditStore,
  from: string,
  to: string,
  exceptId?: string,
): PeriodSeal | null {
  if (!isDate(from) || !isDate(to)) return null
  for (const s of activeSeals(store)) {
    if (exceptId && s.id === exceptId) continue
    if (from <= s.to && to >= s.from) return s
  }
  return null
}

// ── sealing ───────────────────────────────────────────────────────────────────

export interface SealResult {
  ok: boolean
  store: AuditStore
  why: string
}

function refused(store: AuditStore, why: string): SealResult {
  return { ok: false, store, why }
}

export interface SealSpec {
  kind: SealKind
  /** 'YYYY-MM' for a month seal. */
  month?: string
  /** FY start year for a year seal (2025 ⇒ FY 2025-26). */
  year?: number
  note?: string
  actor?: string
  /**
   * The window's figures as a close reading held them at the moment of sealing, drawn by the page
   * that was looking at them (`period-close.ts`'s `sealSnapshotOf`). Optional by design: a seal
   * put on a period from the Seals tab has read nothing, and this register will not photograph a
   * window it has not looked at.
   */
  snapshot?: SealSnapshot | null
}

/**
 * Close a period that has fully ended. The window is refused before anything writes: an
 * unparseable period, a window that has not ended yet, or one that overlaps a seal standing.
 */
export function sealPeriod(orgId: string, spec: SealSpec, today: string = todayISO()): SealResult {
  const store = loadAudit(orgId)
  if (!isDate(today)) return refused(store, 'This device cannot read today\'s date — nothing can be sealed against it.')

  let range: { from: string; to: string } | null
  let period = ''
  let label = ''
  if (spec.kind === 'month') {
    range = monthRange(spec.month ?? '')
    period = spec.month ?? ''
    label = monthLabel(spec.month ?? '')
  } else {
    range = fyRange(Number(spec.year))
    period = spec.year != null ? String(spec.year) : ''
    label = spec.year != null ? `FY ${fyLabel(Number(spec.year))}` : ''
  }
  if (!range) return refused(store, 'The period is not a shape this register can close — pick a month, or a financial year by its first year.')

  if (range.to >= today) {
    return refused(
      store,
      `A period is sealed only once it has ended — ${label} runs to ${range.to}, and today is ${today}. The last day has not passed.`,
    )
  }

  const clash = overlapsActiveSeal(store, range.from, range.to)
  if (clash) {
    return refused(
      store,
      `${label} overlaps a seal already standing on ${clash.label}. Release that seal first, or seal a period that does not cross it.`,
    )
  }

  // A photograph is allowed only for the window it was taken of. The page that seals from the close
  // tab holds a reading of one month; handing it to a year seal, or to a month the shop just picked
  // out of the picker, would caption a figure with the wrong period.
  if (spec.snapshot) {
    if (spec.kind !== 'month') {
      return refused(
        store,
        `${label} would be sealed with a close reading of ${spec.snapshot.month || 'another window'} carried onto it. A photograph of one month cannot caption a year — seal the month, or seal the year with no picture.`,
      )
    }
    if (spec.snapshot.month !== period) {
      return refused(
        store,
        `The reading this dialog holds is of ${spec.snapshot.month}, and ${label} is ${period}. A figure must not be sealed under a period it did not read.`,
      )
    }
  }

  const seal: PeriodSeal = {
    id: newId(),
    kind: spec.kind,
    period,
    from: range.from,
    to: range.to,
    label,
    note: (spec.note ?? '').trim(),
    sealed_at: nowStamp(),
    sealed_by: (spec.actor ?? '').trim(),
    released_at: null,
    release_reason: '',
    snapshot: spec.snapshot ?? null,
    snapshot_unreadable: false,
  }
  const note = `${seal.sealed_by ? seal.sealed_by + ' sealed ' : 'Sealed '}${label}` +
    (seal.note ? ` — ${seal.note}` : '') +
    (seal.snapshot ? ` · the period's figures were kept as they stood on ${seal.snapshot.taken_on}` : '')
  const next = mutate(orgId, s => ({
    ...s,
    seals: [...s.seals, seal],
    events: append(s, 'sealed', today, 'period', label, seal.sealed_by, note),
  }))
  return { ok: true, store: next, why: '' }
}

export interface ReleaseResult {
  ok: boolean
  store: AuditStore
  why: string
}

/**
 * Lift a seal — keeping it on the record. The row is not deleted; it gains a `released_at` and a
 * reason, and shows as a released seal forever. No reason, no release.
 */
export function releaseSeal(
  orgId: string,
  sealId: string,
  reason: string,
  today: string = todayISO(),
  actor: string = '',
): ReleaseResult {
  const store = loadAudit(orgId)
  const seal = store.seals.find(s => s.id === sealId)
  if (!seal) return { ok: false, store, why: 'That seal is not in this register — it may have come from another device or an older file.' }
  if (seal.released_at !== null) {
    return { ok: false, store, why: `${seal.label} was already released — a seal lifted once is not lifted again.` }
  }
  const why = reason.trim()
  if (!why) {
    return {
      ok: false,
      store,
      why: 'Releasing a seal without a reason is a silent unlock — say why the period is being reopened.',
    }
  }
  const next = mutate(orgId, s => ({
    ...s,
    seals: s.seals.map(x =>
      x.id === sealId ? { ...x, released_at: nowStamp(), release_reason: why } : x,
    ),
    events: append(
      s,
      'released',
      today,
      'seal',
      seal.label,
      actor,
      `${actor ? actor + ' released ' : 'Released '}${seal.label} — ${why}`,
    ),
  }))
  return { ok: true, store: next, why: '' }
}

// ── the write-path door ────────────────────────────────────────────────────────

export interface SealGuard {
  sealed: boolean
  label: string
  why: string
}

/**
 * The one question a document write path asks before it saves: does this date fall inside a
 * standing seal? Returns the register's own sentence so the page never has to invent one.
 */
export function sealGuard(orgId: string, date: string): SealGuard {
  const store = loadAudit(orgId)
  const seal = sealForDate(store, date)
  if (!seal) return { sealed: false, label: '', why: '' }
  return {
    sealed: true,
    label: seal.label,
    why:
      `${isDate(date) ? date : 'This date'} falls inside a sealed period — ${seal.label}, closed ` +
      `${seal.sealed_by ? `by ${seal.sealed_by} on ` : 'on '}${(seal.sealed_at || '').slice(0, 10)}. ` +
      `Release the seal at /audit before editing a document dated there.`,
  }
}

/** The page calls this when a seal stopped a save, so the attempt itself is on the record. */
export function recordRefusal(
  orgId: string,
  input: { date: string; target: string; ref: string; actor?: string; guard: SealGuard },
): AuditStore {
  // Article-aware so the trail reads as prose, not a template: "an invoice", "a bill".
  const target = input.target || 'document'
  const article = /^[aeiou]/i.test(target) ? 'an' : 'a'
  const note =
    `Refused ${article} ${target} write dated ${input.date || '—'} — ` +
    `${input.guard.label || 'a sealed period'} is closed.` +
    (input.ref ? ` (${input.ref})` : '')
  return mutate(orgId, s => ({
    ...s,
    events: append(s, 'refused', input.date, input.target, input.ref, input.actor ?? '', note),
  }))
}

/**
 * Ask the seal, and if it answers "sealed" put the attempt on the trail before handing the
 * sentence back. Returns null when the date is free, so the caller's happy path stays one line.
 * The journal uses this form because it wants to *report* the stop, not throw through it.
 */
export function askSeal(
  orgId: string,
  input: { date: string; target: string; ref?: string; actor?: string },
): SealGuard | null {
  const guard = sealGuard(orgId, input.date)
  if (!guard.sealed) return null
  recordRefusal(orgId, {
    date: input.date,
    target: input.target,
    ref: input.ref ?? '',
    actor: input.actor,
    guard,
  })
  return guard
}

/**
 * The seal as an exception. A shared money writer has no banner to draw and no screen of its
 * own — it is called by a page, by the POS, by the recurring catch-up and by the offline replay.
 * So it refuses by throwing the register's own sentence, and whichever of those callers is
 * nearest the user prints it. `name` is stable so a caller can tell a sealed stop from any other
 * failure (the outbox keeps both as a queued `error`, but only a sealed one names the period).
 */
export class SealedWriteError extends Error {
  readonly sealed = true
  readonly date: string
  readonly target: string
  readonly ref: string
  readonly label: string
  constructor(guard: SealGuard, input: { date: string; target: string; ref?: string }) {
    super(guard.why)
    this.name = 'SealedWriteError'
    this.date = input.date
    this.target = input.target
    this.ref = input.ref ?? ''
    this.label = guard.label
  }
}

/**
 * The door on the writer: `createInvoice`, `createPurchaseBill` and `createNote` call this before
 * they take a sequence number, so a sealed window cannot be half-written and left behind. A date
 * that is not a real calendar day cannot fall inside a window, so it passes — the writer's own
 * validation owns that case, not the seal.
 */
export function requireOpenSeal(
  orgId: string,
  input: { date: string; target: string; ref?: string; actor?: string },
): void {
  const guard = askSeal(orgId, input)
  if (guard) throw new SealedWriteError(guard, input)
}

/** A plain line on the trail that changed no seal and wrote no document. */
export function recordNote(orgId: string, text: string, actor = ''): AuditStore {
  const clean = text.trim()
  return mutate(orgId, s => ({
    ...s,
    events: clean ? append(s, 'note', todayISO(), 'note', '', actor, clean) : s.events,
  }))
}

// ── integrity ──────────────────────────────────────────────────────────────────

export interface ChainVerdict {
  ok: boolean
  count: number
  /** Sequence numbers that break the 1..n run: missing, duplicated or out of place. */
  broken: number[]
}

/**
 * Walk the trail by number, not by order. A log that runs 1,2,3,5 skipped a row; one that runs
 * 1,2,2,4 re-used one. Either way the trail was touched, and the register says so.
 */
export function verifyChain(store: AuditStore): ChainVerdict {
  const events = store.events
  const seen = new Set<number>()
  const broken: number[] = []
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e.seq !== i + 1 || seen.has(e.seq)) broken.push(e.seq)
    seen.add(e.seq)
  }
  return { ok: broken.length === 0, count: events.length, broken }
}

// ── summaries for the page ─────────────────────────────────────────────────────

export interface TrailStats {
  active: number
  released: number
  events: number
  refused: number
  lastEventAt: string
}

export function trailStats(store: AuditStore): TrailStats {
  return {
    active: activeSeals(store).length,
    released: store.seals.filter(s => s.released_at !== null).length,
    events: store.events.length,
    refused: store.events.filter(e => e.kind === 'refused').length,
    lastEventAt: store.events.length ? store.events[store.events.length - 1].at : '',
  }
}

/** Months of a financial year, April first — the picker's rows. */
export function fyMonths(startYear: number): string[] {
  const out: string[] = []
  for (let i = 0; i < 12; i++) {
    const d = new Date(Date.UTC(startYear, 3 + i, 1))
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`)
  }
  return out
}

/**
 * Which months of a year a shop can seal today: the ones already ended. `sealable` is true only
 * when the whole month lies before `today`; a month in progress or in the future is not offered.
 */
export function monthSealability(
  startYear: number,
  today: string = todayISO(),
): { month: string; label: string; sealable: boolean }[] {
  return fyMonths(startYear).map(month => {
    const range = monthRange(month)
    return {
      month,
      label: monthLabel(month),
      sealable: !!range && range.to < today,
    }
  })
}

// ── export ────────────────────────────────────────────────────────────────────

export const TRAIL_CSV_HEADERS = [
  'seq', 'when', 'kind', 'period_or_date', 'target', 'reference', 'actor', 'detail',
]

export function trailCsvRows(store: AuditStore): (string | number)[][] {
  return store.events.map(e => [
    e.seq, e.at, EVENT_META[e.kind].label, e.date, e.target, e.ref, e.actor, e.note,
  ])
}

export const SEAL_CSV_HEADERS = [
  'kind', 'period', 'label', 'from', 'to', 'status', 'sealed_on', 'sealed_by', 'note', 'released_on', 'release_reason',
  'photo_taken_on', 'photo_revenue', 'photo_net_profit', 'photo_findings', 'photo_unread',
]

export function sealCsvRows(store: AuditStore): (string | number)[][] {
  return store.seals.map(s => [
    s.kind, s.period, s.label, s.from, s.to,
    s.released_at ? 'released' : 'sealed',
    (s.sealed_at || '').slice(0, 10), s.sealed_by, s.note,
    s.released_at ? s.released_at.slice(0, 10) : '', s.release_reason,
    // A seal with no photograph leaves these blank — a blank is not a zero, and the CA reading the
    // file should be able to tell the two apart. The same discipline holds inside a photograph that
    // was taken before its documents were read: it says `not photographed`, never a ₹0 (Rule 27).
    s.snapshot ? s.snapshot.taken_on : s.snapshot_unreadable ? 'unreadable' : '',
    s.snapshot ? (s.snapshot.money.loaded ? s.snapshot.money.revenue : 'not photographed') : '',
    s.snapshot ? (s.snapshot.money.loaded ? s.snapshot.money.netProfit : 'not photographed') : '',
    s.snapshot ? s.snapshot.findings.length : '',
    s.snapshot ? s.snapshot.unread.join(' ') : '',
  ])
}
