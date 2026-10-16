// Projects & time — the work the books can see, and the hours they cannot.
//
// An invoice records a sale. It does not record the eleven days a technician spent on a
// site, the four hours a consultant billed inside a package price, or the fact that a
// service was *delivered* three weeks before anybody raised a paper on it. That last gap is
// not a management nicety: for services, rule 47 gives thirty days from the date of supply
// to issue the invoice (CBIC, Handbook on Invoicing under GST, 17-06-2025, §2.1.2), so work
// that sits unbilled is a supply whose paperwork is already running late — a liability the
// books have not noticed. Every timekeeping tool that exists prices the hours; almost none
// of them say which ones are now a statutory question.
//
// So this register lives on localStorage (ADR-013, `taxflow:projects:<orgId>`) because the
// schema has no project table and no hours table, and it holds *measurements*, not money —
// which is the whole design decision, and the reason nothing here can rot:
//
//  * **A rupee figure is only ever read from the books, never stored here.** A document is
//    attached to a project by its own id, number and date; the amounts are re-read from the
//    invoices and bills every time the page opens (`bookDocs` is the cost centre register's
//    reader, so cancelled rows are skipped, credit notes arrive signed, and `itc_eligible`
//    is honoured — already tested there). Amend the bill tomorrow and the project's cost
//    changes with it.
//  * **An hour is only ever a measurement.** `value = hours × rate`, and the rate is looked
//    up per entry with the project's own rate behind it. When neither is recorded the hours
//    count as hours and contribute **no rupees** — and the page says "N hours have no rate
//    recorded" rather than inventing a rate. An unpriced hour is a gap, not a zero.
//  * **A costed hour names whose hour it was.** An entry may carry an `employee_id` — a
//    person picked from the payroll register — and then its hours are *costed* at that
//    person's own employer cost for the entry's own month: `costHours()` joins the entries
//    against the `HourCost` rows the payroll register computes, and this module re-derives
//    no rupee (it imports no payroll code; the rows arrive as data, the same way the books
//    do). An entry with a typed name only stays priced, never costed, and is counted as
//    such — never guessed onto a person. A linked person the register cannot price for that
//    month is printed with the register's own reason: a refusal, not a zero.
//  * **A day can be drawn from the payroll register's day book — one deliberate step.** The book
//    keeps attendance marks; the draw is where the shop says *those marked days were this job's*.
//    One proposed row per day the book marks as worked, at the person's own hours a day, ticked by
//    hand, each written through `validateEntry()` like any row typed on the page. The book is
//    never written from here; a day it does not mark as worked is never proposed (only named), and
//    a day already on the register — linked, or typing the same name — is named too, not doubled.
//  * **The labour value is not revenue, and the cost never rewrites contribution.** On a
//    time & material job the hours are what will be billed; on a fixed-price job the package
//    is what is billed and the hour value is only a check on the price you agreed. The
//    register's own figure stays `revenue − spend`, labelled contribution; the costed hour
//    is a **reading beside it** (`contribution − labour_cost`, labelled *after named hours*
//    and marked *partial* while linked hours remain unstated) — never absorbed silently,
//    because if the same wages were also attached here as a bill, subtracting them twice
//    would invent a loss. A "profit" that charged your own time at your own billing rate
//    would be double counting with extra steps; a cost is not a rate, and the page keeps
//    them apart.
//  * **A project is not a legal person either.** Nothing on this page reaches a return. The
//    one place the register becomes a statutory question is unbilled work past the rule 47
//    window, and there it is printed as *a date, a rule, and a link to the workpaper that
//    would carry it* — `/gst/gstr3b` and `/gst/calendar` — never as a tax figure. The
//    window is a constant with a citation, not a verdict: a notification may widen it for
//    your class of supplier, and only gst.gov.in settles what applies to you.
//  * **"Billed" is a reference, not a receipt.** Marking hours billed here writes an invoice
//    number into the entry; it does not create the invoice (`/invoices` does that) and does
//    not take the money (`/payments` is the only writer of money). An entry that names a
//    reference no invoice in the books carries is flagged as unmatched rather than believed.
//  * **A tag survives the document, and says so when the document does not.** Delete the
//    bill and the tag stays on the register as an orphan row contributing no rupees — the
//    same rule the cost-centre register follows, for the same reason: a quiet disappearance
//    is worse than an ugly row.
//
// What v1 deliberately does NOT claim: the costed hour is a *reading*, not a posting — no
// wage rupee is stored here and none is journaled anywhere, so the figure is partial by
// construction and the page says which hours it could not state. It does not schedule or
// raise an invoice — the unbilled work is grouped, priced and handed to `/invoices/new` as
// text, never written from here. It does not read a project's customer from the `customers`
// table by id: the client name travels on the project, because matching a free-text master
// to a stored id is a schema conversation (ADR-013), and a wrong link is worse than a typed
// name.

import { newId, todayISO } from '@/lib/batches'
import { addDaysISO, daysBetween } from '@/lib/recurring'
import { DOC_KIND_META, bookDocs, round2 } from '@/lib/costcentres'
import type { BookDoc, BookInput, DocKind } from '@/lib/costcentres'
import { plural } from '@/lib/format'

const KEY_PROJECTS = 'taxflow:projects:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const PROJECTS_VERSION = 1

/**
 * Rule 47 (CGST Rules) read with section 31(2): the tax invoice for a supply of services is
 * due within thirty days of the date of supply. CBIC's *Handbook on Invoicing under GST*
 * (17-06-2025), §2.1.2, states it in those words. Notifications have widened the window for
 * classes of supplier; the register cannot know which applies, so the number is a named
 * constant the page cites rather than a verdict it hands down.
 */
export const SERVICE_INVOICE_DAYS = 30

/** Inside the last week of the window the page stops calling it "open" and starts calling it due. */
export const DUE_SOON_DAYS = 7

/** An entry is a day of somebody's life. Twenty-five hours is a typo, and a typo is blockable. */
export const MAX_HOURS_PER_ENTRY = 24

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ── the register ──────────────────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'on_hold' | 'completed' | 'archived'
export type BillingMode = 'time_material' | 'fixed_price' | 'internal'

export interface StatusMeta {
  label: string
  tone: 'green' | 'amber' | 'blue' | 'grey'
  note: string
}

export const STATUS_META: Record<ProjectStatus, StatusMeta> = {
  active: { label: 'Running', tone: 'green', note: 'Time can be logged against it.' },
  on_hold: { label: 'On hold', tone: 'amber', note: 'Parked — unbilled work still ages while it sits.' },
  completed: { label: 'Completed', tone: 'blue', note: 'Work is done. Anything still unbilled is still owed paperwork.' },
  archived: { label: 'Archived', tone: 'grey', note: 'Kept for the record; nothing new attaches to it.' },
}

export const PROJECT_STATUSES = (Object.keys(STATUS_META) as ProjectStatus[]).map(value => ({
  value,
  label: STATUS_META[value].label,
}))

export interface BillingMeta {
  label: string
  /** What choosing this mode actually means for the money and the clock. */
  note: string
  /** Whether work on this job can ever be late paperwork. */
  windowed: boolean
}

export const BILLING_META: Record<BillingMode, BillingMeta> = {
  time_material: {
    label: 'Time & material',
    note: 'The hours are what gets billed — every unbilled day is a clock running.',
    windowed: true,
  },
  fixed_price: {
    label: 'Fixed price',
    note: 'The package is what gets billed. The hour value is a check on the price, not money owed.',
    windowed: true,
  },
  internal: {
    label: 'Internal work',
    note: 'No recipient, so no supply and no invoice — nothing logged here can be overdue.',
    windowed: false,
  },
}

export const BILLING_MODES = (Object.keys(BILLING_META) as BillingMode[]).map(value => ({
  value,
  label: BILLING_META[value].label,
  note: BILLING_META[value].note,
}))

export interface Project {
  id: string
  name: string
  /** The business's own reference — "PRJ-118", "Andheri fit-out". */
  code: string
  /** Typed, not joined: matching a master by id is a schema conversation (ADR-013). */
  client_name: string
  status: ProjectStatus
  billing: BillingMode
  start_date: string
  /** Planned end; '' = open-ended. */
  target_date: string
  /** Default ₹/hour for entries on this project. 0 = not recorded. */
  hourly_rate: number
  /** Planned spend, in rupees. 0 = no budget set. */
  budget_value: number
  notes: string
  archived: boolean
  created_at: string
}

export interface TimeEntry {
  id: string
  project_id: string
  /** The day the work was actually done — this is the date of supply the window runs from. */
  date: string
  person: string
  /**
   * The payroll-register person these hours belonged to, when the shop says so. `''` = a typed
   * name only: the hour is priced at its rate and never costed. The id is kept even if the
   * person later leaves the register — an entry keeps its link and the register's own reason
   * is printed, because a quiet unlink is worse than an ugly row.
   */
  employee_id: string
  hours: number
  /** ₹/hour for this entry. 0 = use the project's rate. */
  rate: number
  note: string
  /** The invoice number that carries these hours. '' = not billed yet. */
  billed_ref: string
  created_at: string
}

export interface ProjectTag {
  id: string
  project_id: string
  kind: DocKind
  doc_id: string
  doc_number: string
  doc_date: string
  created_at: string
}

export interface ProjectStore {
  version: number
  updatedAt: string
  orgId: string
  projects: Project[]
  entries: TimeEntry[]
  tags: ProjectTag[]
}

export function emptyProjects(orgId = ''): ProjectStore {
  return { version: PROJECTS_VERSION, updatedAt: todayISO(), orgId, projects: [], entries: [], tags: [] }
}

export function newProject(status: ProjectStatus = 'active'): Project {
  return {
    id: newId(),
    name: '',
    code: '',
    client_name: '',
    status,
    billing: 'time_material',
    start_date: todayISO(),
    target_date: '',
    hourly_rate: 0,
    budget_value: 0,
    notes: '',
    archived: false,
    created_at: new Date().toISOString(),
  }
}

export function newEntry(projectId: string, date = todayISO()): TimeEntry {
  return {
    id: newId(),
    project_id: projectId,
    date,
    person: '',
    employee_id: '',
    hours: 1,
    rate: 0,
    note: '',
    billed_ref: '',
    created_at: new Date().toISOString(),
  }
}

// ── parsing and storage ───────────────────────────────────────────────────────

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(y: number, m: number): number {
  if (m !== 2) return MONTH_DAYS[m - 1]
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28
}

/** A real calendar day, not twelve digits with dashes in them. */
export function isDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false
  const [y, m, d] = v.split('-').map(Number)
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function isStatus(v: unknown): v is ProjectStatus {
  return v === 'active' || v === 'on_hold' || v === 'completed' || v === 'archived'
}

function isBilling(v: unknown): v is BillingMode {
  return v === 'time_material' || v === 'fixed_price' || v === 'internal'
}

export function isDocKind(v: unknown): v is DocKind {
  return v === 'invoice' || v === 'credit_note' || v === 'debit_note' || v === 'bill' || v === 'expense'
}

/** Anything stored as a status other than these four is read as active, not guessed at. */
function parseProject(raw: unknown): Project | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  const id = str(p.id)
  if (!id) return null
  return {
    id,
    name: str(p.name),
    code: str(p.code),
    client_name: str(p.client_name),
    status: isStatus(p.status) ? p.status : 'active',
    billing: isBilling(p.billing) ? p.billing : 'time_material',
    start_date: isDate(p.start_date) ? p.start_date : todayISO(),
    target_date: isDate(p.target_date) ? p.target_date : '',
    hourly_rate: Math.max(0, num(p.hourly_rate)),
    budget_value: Math.max(0, num(p.budget_value)),
    notes: str(p.notes),
    archived: p.archived === true,
    created_at: str(p.created_at) || new Date().toISOString(),
  }
}

function parseEntry(raw: unknown): TimeEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const id = str(e.id)
  // An entry without a project or a genuine day is not a measurement of anything.
  if (!id || !str(e.project_id) || !isDate(e.date)) return null
  const hours = num(e.hours)
  if (!(hours > 0)) return null
  return {
    id,
    project_id: str(e.project_id),
    date: e.date,
    person: str(e.person),
    employee_id: str(e.employee_id),
    hours: round2(hours),
    rate: Math.max(0, num(e.rate)),
    note: str(e.note),
    billed_ref: str(e.billed_ref).trim(),
    created_at: str(e.created_at) || new Date().toISOString(),
  }
}

function parseTag(raw: unknown): ProjectTag | null {
  if (!raw || typeof raw !== 'object') return null
  const t = raw as Record<string, unknown>
  const id = str(t.id)
  if (!id || !str(t.project_id) || !str(t.doc_id) || !isDocKind(t.kind)) return null
  return {
    id,
    project_id: str(t.project_id),
    kind: t.kind,
    doc_id: str(t.doc_id),
    doc_number: str(t.doc_number),
    doc_date: str(t.doc_date),
    created_at: str(t.created_at) || new Date().toISOString(),
  }
}

export function parseProjects(raw: string | null): ProjectStore {
  if (!raw) return emptyProjects()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyProjects()
  }
  if (!parsed || typeof parsed !== 'object') return emptyProjects()
  const s = parsed as Record<string, unknown>
  const orgId = str(s.orgId)
  if (s.version !== PROJECTS_VERSION) return emptyProjects(orgId)
  const projects = Array.isArray(s.projects) ? s.projects.map(parseProject).filter((x): x is Project => x !== null) : []
  const entries = Array.isArray(s.entries) ? s.entries.map(parseEntry).filter((x): x is TimeEntry => x !== null) : []
  const tags = Array.isArray(s.tags) ? s.tags.map(parseTag).filter((x): x is ProjectTag => x !== null) : []
  return {
    version: PROJECTS_VERSION,
    updatedAt: str(s.updatedAt) || todayISO(),
    orgId,
    projects,
    // A stored row pointing at a project that is not in the envelope is dropped: it cannot be
    // shown, cannot be validated, and half a register is worse than an empty one.
    entries: entries.filter(e => projects.some(p => p.id === e.project_id)),
    tags: tags.filter(t => projects.some(p => p.id === t.project_id)),
  }
}

export function loadProjects(orgId: string): ProjectStore {
  if (typeof window === 'undefined' || !orgId) return emptyProjects()
  try {
    const store = parseProjects(window.localStorage.getItem(KEY_PROJECTS + orgId))
    return { ...store, orgId }
  } catch {
    return emptyProjects(orgId)
  }
}

export function saveProjects(orgId: string, store: ProjectStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_PROJECTS + orgId,
      JSON.stringify({ ...store, orgId, version: PROJECTS_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: ProjectStore) => ProjectStore): ProjectStore {
  const next = fn(loadProjects(orgId))
  saveProjects(orgId, next)
  return next
}

// ── writing to the register ───────────────────────────────────────────────────

export function upsertProject(orgId: string, project: Project): ProjectStore {
  return mutate(orgId, s => ({
    ...s,
    projects: s.projects.some(p => p.id === project.id)
      ? s.projects.map(p => (p.id === project.id ? project : p))
      : [...s.projects, project],
  }))
}

export function setProjectStatus(orgId: string, id: string, status: ProjectStatus): ProjectStore {
  return mutate(orgId, s => ({
    ...s,
    projects: s.projects.map(p => (p.id === id ? { ...p, status, archived: status === 'archived' } : p)),
  }))
}

export type DeleteResult = { ok: true; store: ProjectStore } | { ok: false; error: string }

/**
 * A project carrying hours or documents is not deletable — its numbers would vanish from
 * every register that read them. It archives instead, which keeps the record and stops the
 * list filling up. Same rule the cost-centre register enforces.
 */
export function deleteProject(orgId: string, id: string): DeleteResult {
  const s = loadProjects(orgId)
  const entries = s.entries.filter(e => e.project_id === id).length
  const tags = s.tags.filter(t => t.project_id === id).length
  if (entries || tags) {
    return {
      ok: false,
      error: `This project still carries ${entries} time ${entries === 1 ? 'entry' : 'entries'} and ${tags} attached ${tags === 1 ? 'document' : 'documents'}. Archive it instead — the record stays, the list does not.`,
    }
  }
  return { ok: true, store: mutate(orgId, n => ({ ...n, projects: n.projects.filter(p => p.id !== id) })) }
}

export function upsertEntry(orgId: string, entry: TimeEntry): ProjectStore {
  return mutate(orgId, s => ({
    ...s,
    entries: s.entries.some(e => e.id === entry.id)
      ? s.entries.map(e => (e.id === entry.id ? entry : e))
      : [...s.entries, entry],
  }))
}

/**
 * The draw's write path: one mutate for a whole month of drawn days, so a page cannot half-draw a
 * person — either the batch lands or (validation having blocked it before the call) nothing does.
 */
export function upsertEntries(orgId: string, list: TimeEntry[]): ProjectStore {
  if (!list.length) return loadProjects(orgId)
  return mutate(orgId, s => {
    const ids = new Set(list.map(e => e.id))
    const kept = s.entries.filter(e => !ids.has(e.id))
    return { ...s, entries: [...kept, ...list] }
  })
}

export function deleteEntry(orgId: string, id: string): ProjectStore {
  return mutate(orgId, s => ({ ...s, entries: s.entries.filter(e => e.id !== id) }))
}

/**
 * The only thing "billed" does: stamp an invoice number onto the hours it covers. It does not
 * create that invoice and it does not take the money — `/invoices` writes the paper and
 * `/payments` writes the cash.
 */
export function markBilled(orgId: string, ids: string[], invoiceNumber: string): ProjectStore {
  const ref = invoiceNumber.trim()
  return mutate(orgId, s => ({
    ...s,
    entries: s.entries.map(e => (ids.includes(e.id) ? { ...e, billed_ref: ref } : e)),
  }))
}

export function markUnbilled(orgId: string, ids: string[]): ProjectStore {
  return mutate(orgId, s => ({
    ...s,
    entries: s.entries.map(e => (ids.includes(e.id) ? { ...e, billed_ref: '' } : e)),
  }))
}

export function addTag(orgId: string, projectId: string, doc: BookDoc): ProjectStore {
  return mutate(orgId, s => {
    if (s.tags.some(t => t.project_id === projectId && t.doc_id === doc.id)) return s
    return {
      ...s,
      tags: [
        ...s.tags,
        {
          id: newId(),
          project_id: projectId,
          kind: doc.kind,
          doc_id: doc.id,
          doc_number: doc.number,
          doc_date: doc.date,
          created_at: new Date().toISOString(),
        },
      ],
    }
  })
}

export function bulkTag(orgId: string, projectId: string, docs: BookDoc[]): ProjectStore {
  return mutate(orgId, s => {
    const have = new Set(s.tags.filter(t => t.project_id === projectId).map(t => t.doc_id))
    const fresh: ProjectTag[] = docs
      .filter(d => d?.id && !have.has(d.id))
      .map(d => ({
        id: newId(),
        project_id: projectId,
        kind: d.kind,
        doc_id: d.id,
        doc_number: d.number,
        doc_date: d.date,
        created_at: new Date().toISOString(),
      }))
    return { ...s, tags: [...s.tags, ...fresh] }
  })
}

export function removeTag(orgId: string, tagId: string): ProjectStore {
  return mutate(orgId, s => ({ ...s, tags: s.tags.filter(t => t.id !== tagId) }))
}

// ── the money side: read, never stored ────────────────────────────────────────

/** The four numbers a project can be given, straight out of the books. */
export function docsFor(input: BookInput): BookDoc[] {
  return bookDocs(input)
}

export interface TagRow {
  tag: ProjectTag
  /** null when the document is no longer in the books — an orphan, printed as one. */
  doc: BookDoc | null
  outward: boolean
}

export function tagRows(tags: ProjectTag[], docs: BookDoc[]): TagRow[] {
  const byId = new Map(docs.map(d => [d.id, d]))
  return tags
    .map(tag => {
      const doc = byId.get(tag.doc_id) || null
      return { tag, doc, outward: doc ? DOC_KIND_META[doc.kind].side === 'outward' : tag.kind !== 'bill' && tag.kind !== 'expense' }
    })
    .sort((a, b) => {
      const da = a.doc?.date || a.tag.doc_date
      const db = b.doc?.date || b.tag.doc_date
      return da === db ? (a.doc?.number || a.tag.doc_number).localeCompare(b.doc?.number || b.tag.doc_number) : da < db ? 1 : -1
    })
}

// ── the clock: rule 47 and the work that runs past it ─────────────────────────

/** Does this kind of job ever produce a document that is late? Internal work does not. */
export function invoiceWindow(billing: BillingMode): number | null {
  // A mode this build does not know falls to the *loud* side: an unknown job is assumed to
  // owe an invoice, because silencing a statutory clock on a parse failure is how a deadline
  // gets missed.
  return BILLING_META[billing]?.windowed === false ? null : SERVICE_INVOICE_DAYS
}

export function invoiceDue(supplyDate: string, days: number): string {
  return addDaysISO(supplyDate, days)
}

/** 'YYYY-MM' for a real day; '' otherwise, so a bad row cannot make a fake period. */
export function periodOf(iso: string): string {
  return isDate(iso) ? iso.slice(0, 7) : ''
}

export function periodLabel(period: string): string {
  if (!/^\d{4}-\d{2}$/.test(period)) return ''
  const [y, m] = period.split('-').map(Number)
  // Digits shaped like a period are not a period: '2026-13' would print "undefined 2026".
  if (!y || m < 1 || m > 12) return ''
  return `${MONTHS[m - 1]} ${y}`
}

export type WatchState = 'no_window' | 'open' | 'due_soon' | 'overdue'

export const WATCH_META: Record<WatchState, { label: string; tone: 'grey' | 'green' | 'amber' | 'red' }> = {
  no_window: { label: 'Not billable', tone: 'grey' },
  open: { label: 'Inside the window', tone: 'green' },
  due_soon: { label: 'Due shortly', tone: 'amber' },
  overdue: { label: 'Past the window', tone: 'red' },
}

/** One month's unbilled work on one project, as a single row of the "to bill" register. */
export interface UnbilledGroup {
  key: string
  project_id: string
  project: string
  client: string
  billing: BillingMode
  period: string
  period_label: string
  /** The oldest unbilled supply day inside this period — what the clock runs from. */
  earliest: string
  due_date: string
  window: number | null
  days_left: number | null
  days_over: number
  state: WatchState
  entries: TimeEntry[]
  hours: number
  value: number
  /** Hours with no rate on the entry or the project — counted, never priced. */
  unpriced_hours: number
}

export function rateOf(entry: TimeEntry, project: Project): number {
  return entry.rate > 0 ? entry.rate : project.hourly_rate
}

export function entryValue(entry: TimeEntry, project: Project): number {
  const rate = rateOf(entry, project)
  return rate > 0 ? round2(entry.hours * rate) : 0
}

// ── the costed hour: what the payroll register says it cost ───────────────────

/**
 * One person, one month, priced by the payroll register — a structural subset of payroll's own
 * `HourCost`, so the page hands those rows straight in and this module imports no payroll code.
 * `cost_per_hour: null` is a refusal carrying its reason; a row existing does not mean a rupee.
 */
export interface HourCostRow {
  employee_id: string
  name: string
  month: string
  cost_per_hour: number | null
  /** What the figure is made of. '' when there is no figure. */
  basis: string
  /** Why there is no figure. '' when there is one. */
  why: string
}

/** What one logged day cost the shop — or why that cannot be stated. */
export interface EntryCost {
  entry_id: string
  /** Whether the entry names a person on the payroll register at all. */
  linked: boolean
  /** The register's name for the person; the typed name when there is no link to resolve. */
  name: string
  /** Rupees, or null with `why` — never a zero standing in for "cannot say". */
  cost: number | null
  basis: string
  why: string
}

/**
 * Join entries to the payroll register's hour costs by (person, month of the entry). Pure
 * arithmetic over rows that already exist: this module re-derives no wage, and an entry the
 * register cannot price keeps a null cost and the register's own sentence for why.
 */
export function costHours(entries: TimeEntry[], costs: HourCostRow[]): Map<string, EntryCost> {
  const byKey = new Map(costs.map(c => [`${c.employee_id}:${c.month}`, c]))
  const out = new Map<string, EntryCost>()
  for (const e of entries) {
    if (!e.employee_id) {
      out.set(e.id, {
        entry_id: e.id,
        linked: false,
        name: e.person,
        cost: null,
        basis: '',
        why: 'No person named from the payroll register — a typed name is not a wage link, so this hour is priced only.',
      })
      continue
    }
    const row = byKey.get(`${e.employee_id}:${periodOf(e.date)}`)
    if (!row || row.cost_per_hour === null) {
      out.set(e.id, {
        entry_id: e.id,
        linked: true,
        name: row?.name || e.person || 'Person no longer on the register',
        cost: null,
        basis: '',
        why: row?.why || 'The payroll register has no figure for this month.',
      })
      continue
    }
    out.set(e.id, {
      entry_id: e.id,
      linked: true,
      name: row.name || e.person,
      cost: round2(e.hours * row.cost_per_hour),
      basis: row.basis,
      why: '',
    })
  }
  return out
}

// ── the drawn day: hours a job takes out of the payroll day book ──────────────

/**
 * One day of the payroll register's day book, handed over **as data** — the same seam the costed
 * hour uses. The page reads the book (a mark, its label, what part of the day it holds) and this
 * module proposes timesheet rows; neither register imports the other.
 */
export interface BookWorkDay {
  date: string
  /** The mark the book keeps, for the drawn row's provenance note. */
  mark: string
  /** The register's label for the mark. */
  label: string
  /** What part of the day the mark says was worked: a whole one, half of it, or none. */
  fraction: 1 | 0.5 | 0
  /** When fraction is 0: the register's own sentence saying why nothing is drawn. */
  why: string
}

export interface DrawnDay {
  date: string
  mark: string
  label: string
  /** Hours this day draws under the person's own hours a day — 0 when it draws none. */
  hours: number
  /** True when the draw ticks this day for the shop: worked, inside the window, nothing on the books yet. */
  proposed: boolean
  /** A day the shop can tick. A day the book says was not worked cannot be ticked — log it by hand. */
  tickable: boolean
  /** '' while proposed; otherwise the sentence that says why the draw left the day alone. */
  why: string
}

export interface HoursDraw {
  employee_id: string
  person: string
  month: string
  project_id: string
  /** The person's hours a day, as the payroll register states them; 0 when it does not. */
  hours_per_day: number
  /** Every day the book ruled for this person, in date order — kept, not only the usable ones. */
  days: DrawnDay[]
  proposed_days: number
  proposed_hours: number
  /** Hours already on this project for this person in the month — linked or typed. */
  logged_hours: number
  findings: string[]
  /** '' when the draw can run; otherwise why the whole month draws nothing. */
  refuse: string
}

/**
 * Turn a person's day-book marks into timesheet rows. The book is evidence of attendance, not a
 * timesheet: this is the one deliberate step where the shop says *these marked days, on this job*.
 * Nothing is written here — the page writes what the shop ticks, each row through `validateEntry()`
 * — and a day the book does not mark as worked is never proposed, only named. A day already on the
 * books is named too: a typed name on the same day is a link to fix, not hours to double.
 */
export function drawHours(
  days: BookWorkDay[],
  who: { employee_id: string; person: string; hours_per_day: number },
  project: Project,
  projects: Project[],
  entries: TimeEntry[],
  month: string,
  today = todayISO(),
): HoursDraw {
  const person = who.person.trim()
  const hoursPerDay = Number(who.hours_per_day)
  const base: HoursDraw = {
    employee_id: who.employee_id, person, month, project_id: project.id,
    hours_per_day: hoursPerDay > 0 && hoursPerDay <= 24 ? hoursPerDay : 0,
    days: [], proposed_days: 0, proposed_hours: 0, logged_hours: 0, findings: [], refuse: '',
  }
  if (!who.employee_id) return { ...base, refuse: 'Pick the person whose days these are — a draw reads one person’s book.' }
  if (!person) return { ...base, refuse: 'The payroll register has no name to stamp on the drawn days.' }
  if (!(hoursPerDay > 0) || hoursPerDay > 24) {
    return { ...base, refuse: `${person} has no hours a day on the payroll register, so a marked day cannot be turned into hours. Set it at /payroll, then draw.` }
  }
  const monthDays = days.filter(d => periodOf(d.date) === month)
  if (!monthDays.length) {
    return { ...base, refuse: `No day of this person’s book falls in ${periodLabel(month) || month} — there is no page to draw from.` }
  }
  if (!monthDays.some(d => d.mark.trim())) {
    return { ...base, refuse: `The day book holds no mark for ${person} in ${periodLabel(month)}. An unwritten book draws nothing — mark the days at /payroll, or log hours by hand.` }
  }

  // "This person", as both registers can say it: a row that names them on the register, or a row
  // that types the same name. The two count for the day so a draw cannot write what a hand row said.
  const sameName = (e: TimeEntry) => !e.employee_id && e.person.trim().toLowerCase() === person.toLowerCase()
  const mine = entries.filter(e => e.employee_id === who.employee_id || sameName(e))
  const loggedHours = round2(mine.filter(e => e.project_id === project.id && periodOf(e.date) === month).reduce((a, e) => a + e.hours, 0))
  const start = isDate(project.start_date) ? project.start_date : ''

  let proposedDays = 0
  let proposedHours = 0
  const rows: DrawnDay[] = []
  for (const d of [...monthDays].sort((a, b) => a.date.localeCompare(b.date))) {
    const row: DrawnDay = { date: d.date, mark: d.mark, label: d.label, hours: 0, proposed: false, tickable: false, why: '' }
    if (!isDate(d.date)) { row.why = 'Not a real calendar day — nothing is drawn from it.'; rows.push(row); continue }
    if (d.date > today) { row.why = 'The day has not happened yet.'; rows.push(row); continue }
    if (start && d.date < start) { row.why = `${d.date} falls before this project started (${start}).`; rows.push(row); continue }
    const here = mine.find(e => e.project_id === project.id && e.date === d.date)
    if (here) {
      row.hours = here.hours
      row.why = here.employee_id === who.employee_id
        ? `Already on this project — ${here.hours} h logged on this day.`
        : `A row on this day types “${here.person}” without a register link — edit that row and pick the person instead of drawing a second.`
      rows.push(row); continue
    }
    if (d.fraction <= 0) { row.why = d.why || 'The book marks nothing worked on this day.'; rows.push(row); continue }
    row.hours = round2(d.fraction * hoursPerDay)
    row.tickable = true
    const elsewhere = mine.filter(e => e.project_id !== project.id && e.date === d.date)
    if (elsewhere.length) {
      const total = round2(elsewhere.reduce((a, e) => a + e.hours, 0))
      const names = [...new Set(elsewhere.map(e => projects.find(p => p.id === e.project_id)?.name || 'another project'))].join(', ')
      row.why = `This day already carries ${total} h on ${names}. Tick it only if the day’s work was really split — two full days on one date will both count.`
    } else {
      row.proposed = true
      proposedDays++
      proposedHours = round2(proposedHours + row.hours)
    }
    rows.push(row)
  }

  const findings: string[] = []
  if (proposedDays === 0) {
    const drawable = rows.filter(r => r.tickable).length
    findings.push(drawable
      ? `Nothing new is proposed — every day the book marks as worked either sits on the register already or carries hours elsewhere. ${plural(drawable, 'day')} can still be ticked by hand.`
      : `Nothing is drawn from ${periodLabel(month)}: no day the book marks as worked falls inside this project’s window.`)
  }
  if (loggedHours > 0) findings.push(`${loggedHours} h from ${person} already sit on this project in ${periodLabel(month)}.`)

  return { ...base, days: rows, proposed_days: proposedDays, proposed_hours: proposedHours, logged_hours: loggedHours, findings }
}

/**
 * Unbilled hours, grouped per project per calendar month of supply, because that is the shape
 * the invoice takes: a month of consulting goes out as one paper, and a day of it is already
 * a liability question. Grouping by period rather than by entry keeps the register readable;
 * the entries themselves ride along so the drill-down needs no second pass.
 */
export function unbilledGroups(
  projects: Project[],
  entries: TimeEntry[],
  today: string,
  projectId?: string,
): UnbilledGroup[] {
  const out: UnbilledGroup[] = []
  for (const p of projects) {
    if (projectId && p.id !== projectId) continue
    const window = invoiceWindow(p.billing)
    const byPeriod = new Map<string, TimeEntry[]>()
    for (const e of entries) {
      if (e.project_id !== p.id || e.billed_ref) continue
      if (!isDate(e.date)) continue
      const period = periodOf(e.date)
      if (!period) continue
      const list = byPeriod.get(period)
      if (list) list.push(e)
      else byPeriod.set(period, [e])
    }
    for (const [period, list] of byPeriod) {
      const dates = list.map(e => e.date).sort()
      const earliest = dates[0]
      const hours = round2(list.reduce((t, e) => t + e.hours, 0))
      let value = 0
      let unpriced = 0
      for (const e of list) {
        const v = entryValue(e, p)
        if (v > 0) value += v
        else unpriced += e.hours
      }
      let state: WatchState = 'no_window'
      let due_date = ''
      let days_left: number | null = null
      let days_over = 0
      if (window !== null) {
        due_date = invoiceDue(earliest, window)
        days_left = daysBetween(today, due_date)
        if (days_left === null) days_left = 0
        if (days_left < 0) {
          state = 'overdue'
          days_over = -days_left
        } else if (days_left <= DUE_SOON_DAYS) {
          state = 'due_soon'
        } else {
          state = 'open'
        }
      }
      out.push({
        key: `${p.id}:${period}`,
        project_id: p.id,
        project: p.name || p.code || 'Untitled project',
        client: p.client_name,
        billing: p.billing,
        period,
        period_label: periodLabel(period),
        earliest,
        due_date,
        window,
        days_left,
        days_over,
        state,
        entries: [...list].sort((a, b) => (a.date === b.date ? a.person.localeCompare(b.person) : a.date < b.date ? -1 : 1)),
        hours,
        value: round2(value),
        unpriced_hours: round2(unpriced),
      })
    }
  }
  // Worst first: past-the-window groups, then by how far they have run, then by value.
  const rank: Record<WatchState, number> = { overdue: 0, due_soon: 1, open: 2, no_window: 3 }
  return out.sort(
    (a, b) =>
      rank[a.state] - rank[b.state] ||
      b.days_over - a.days_over ||
      b.value - a.value ||
      a.project.localeCompare(b.project) ||
      a.period.localeCompare(b.period),
  )
}

/**
 * The sentence the page prints. It names the rule and hands over the date; it does not
 * announce a tax amount, because a workpaper that cannot see your filings has no business
 * doing that.
 */
export function watchSentence(g: UnbilledGroup): string {
  if (g.state === 'no_window') {
    return `${g.hours} h of internal work — no recipient, so no invoice and nothing due.`
  }
  const money = g.value > 0 ? `${g.value} worth of work` : `${g.hours} h of work with no rate recorded`
  if (g.state === 'overdue') {
    return `Supplied from ${g.earliest}; the invoice was due ${g.due_date} (rule 47, ${g.window} days) — ${g.days_over} days past. ${money} is still unbilled.`
  }
  if (g.state === 'due_soon') {
    return `Supplied from ${g.earliest}; the invoice is due ${g.due_date} — ${g.days_left} days left. ${money} is still unbilled.`
  }
  return `Supplied from ${g.earliest}; the invoice would be due ${g.due_date}. ${money} is still unbilled.`
}

// ── the view ──────────────────────────────────────────────────────────────────

export interface Finding {
  tone: 'red' | 'amber' | 'grey'
  text: string
  href?: string
  link?: string
}

export interface ProjectView {
  project: Project
  entry_count: number
  hours: number
  unbilled_hours: number
  /** What the hours would fetch at the recorded rates. Not revenue — see the header. */
  labour_value: number
  unbilled_value: number
  unpriced_hours: number
  /** What the hours named to payroll people cost the shop — a reading from that register. */
  labour_cost: number
  /** Hours inside `labour_cost`. */
  costed_hours: number
  /** Linked hours the payroll register could not price for their own month. */
  uncosted_hours: number
  /** Hours carrying a typed name only — no payroll link, so no cost is read for them. */
  unlinked_hours: number
  /** contribution − labour_cost, marked partial on the page while hours remain unstated. */
  after_labour: number
  revenue: number
  cost: number
  contribution: number
  itc: number
  doc_count: number
  orphans: number
  groups: UnbilledGroup[]
  overdue: UnbilledGroup[]
  at_risk: number
  days_since_last: number | null
  budget_used_pct: number | null
  over_budget: boolean
  /** An entry that names an invoice number the books do not have. */
  unmatched_refs: string[]
  findings: Finding[]
}

function byId<T extends { id: string }>(list: T[]): Map<string, T> {
  return new Map(list.map(x => [x.id, x]))
}

export function projectView(
  project: Project,
  entries: TimeEntry[],
  tags: ProjectTag[],
  docs: BookDoc[],
  today: string,
  costs: HourCostRow[] = [],
): ProjectView {
  const mine = entries.filter(e => e.project_id === project.id)
  const mineTags = tags.filter(t => t.project_id === project.id)
  const rows = tagRows(mineTags, docs)

  let revenue = 0
  let cost = 0
  let itc = 0
  let orphans = 0
  for (const r of rows) {
    if (!r.doc) {
      orphans++
      continue
    }
    if (r.outward) revenue += r.doc.taxable
    else {
      cost += r.doc.taxable
      itc += r.doc.itc
    }
  }

  const costMap = costHours(mine, costs)
  let hours = 0
  let unbilledHours = 0
  let labour = 0
  let unbilledValue = 0
  let unpriced = 0
  let labourCost = 0
  let costedHours = 0
  let uncostedHours = 0
  let unlinkedHours = 0
  const uncostedWhys: string[] = []
  const invoiceNumbers = new Set(docs.filter(d => d.kind === 'invoice').map(d => d.number))
  const unmatched = new Set<string>()
  for (const e of mine) {
    hours += e.hours
    const v = entryValue(e, project)
    const priced = rateOf(e, project) > 0
    if (priced) labour += v
    else unpriced += e.hours
    if (e.billed_ref) {
      if (invoiceNumbers.size && !invoiceNumbers.has(e.billed_ref)) unmatched.add(e.billed_ref)
    } else {
      unbilledHours += e.hours
      if (priced) unbilledValue += v
    }
    const c = costMap.get(e.id)
    if (c && c.cost !== null) {
      labourCost += c.cost
      costedHours += e.hours
    } else if (c && c.linked) {
      uncostedHours += e.hours
      if (c.why) uncostedWhys.push(c.why)
    } else {
      unlinkedHours += e.hours
    }
  }

  const groups = unbilledGroups([project], mine, today)
  const overdue = groups.filter(g => g.state === 'overdue')
  const atRisk = round2(overdue.reduce((t, g) => t + g.value, 0))
  const last = mine.map(e => e.date).sort().pop() || ''
  const days_since_last = last ? daysBetween(today, last) : null

  const contribution = round2(revenue - cost)
  const labour_cost = round2(labourCost)
  const after_labour = round2(contribution - labour_cost)
  const budget_used_pct = project.budget_value > 0 ? Math.round((cost / project.budget_value) * 100) : null

  const findings: Finding[] = []
  if (overdue.length) {
    findings.push({
      tone: 'red',
      text: `${overdue.length} ${overdue.length === 1 ? 'month is' : 'months are'} past the rule 47 window — ${round2(atRisk)} of work unbilled, the oldest supplied on ${overdue.map(g => g.earliest).sort()[0]}.`,
      link: 'GSTR-3B workpaper',
      href: '/gst/gstr3b',
    })
  }
  if (unpriced > 0) {
    findings.push({
      tone: 'grey',
      text: `${round2(unpriced)} h have no rate recorded, on the entry or on the project — they count as hours and contribute no rupees. Nothing has been assumed for them.`,
    })
  }
  if (uncostedHours > 0) {
    findings.push({
      tone: 'amber',
      text: `${round2(uncostedHours)} h are named to a person the payroll register could not price for that month${uncostedWhys[0] ? ` — ${uncostedWhys[0]}` : ''} The cost figures state only what the register could compute; nothing has been assumed for the rest.`,
      link: 'Payroll',
      href: '/payroll',
    })
  }
  if (unlinkedHours > 0 && (costedHours > 0 || uncostedHours > 0)) {
    findings.push({
      tone: 'grey',
      text: `${round2(unlinkedHours)} h carry a typed name only, so no cost is read for them — pick the person from the payroll register and those hours are costed too.`,
    })
  }
  if (unmatched.size) {
    findings.push({
      tone: 'amber',
      text: `${unmatched.size} ${unmatched.size === 1 ? 'invoice reference names an invoice that is not in your books' : 'invoice references name invoices that are not in your books'} (${[...unmatched].slice(0, 3).join(', ')}${unmatched.size > 3 ? ', …' : ''}). Marking hours billed here does not create the invoice — /invoices does.`,
      link: 'Invoices',
      href: '/invoices',
    })
  }
  if (project.billing === 'fixed_price' && labour > 0 && revenue > 0 && labour > revenue * 1.2) {
    findings.push({
      tone: 'amber',
      text: `The hours logged would fetch ${round2(labour)} at your recorded rates against ${round2(revenue)} billed — a fixed-price job priced below the time it is taking. The rupees still come from the invoice, not from this figure.`,
    })
  }
  if (orphans) {
    findings.push({
      tone: 'grey',
      text: `${orphans} attached ${orphans === 1 ? 'document is' : 'documents are'} no longer in the books. The rows survive as orphans and contribute no rupees.`,
    })
  }
  if (budget_used_pct !== null && budget_used_pct > 100) {
    findings.push({
      tone: 'amber',
      text: `Spend on this project is ${budget_used_pct}% of the ${round2(project.budget_value)} budget set here.`,
    })
  }

  return {
    project,
    entry_count: mine.length,
    hours: round2(hours),
    unbilled_hours: round2(unbilledHours),
    labour_value: round2(labour),
    unbilled_value: round2(unbilledValue),
    unpriced_hours: round2(unpriced),
    labour_cost,
    costed_hours: round2(costedHours),
    uncosted_hours: round2(uncostedHours),
    unlinked_hours: round2(unlinkedHours),
    after_labour,
    revenue: round2(revenue),
    cost: round2(cost),
    contribution,
    itc: round2(itc),
    doc_count: rows.filter(r => r.doc).length,
    orphans,
    groups,
    overdue,
    at_risk: atRisk,
    days_since_last: days_since_last === null ? null : -days_since_last,
    budget_used_pct,
    over_budget: budget_used_pct !== null && budget_used_pct > 100,
    unmatched_refs: [...unmatched].sort(),
    findings,
  }
}

export function projectViews(store: ProjectStore, docs: BookDoc[], today: string, costs: HourCostRow[] = []): ProjectView[] {
  const projIds = new Set(store.projects.map(p => p.id))
  const entries = store.entries.filter(e => projIds.has(e.project_id))
  const tags = store.tags.filter(t => projIds.has(t.project_id))
  return store.projects.map(p => projectView(p, entries, tags, docs, today, costs))
}

const STATUS_RANK: Record<ProjectStatus, number> = { active: 0, on_hold: 1, completed: 2, archived: 3 }

/** Running jobs first, the ones with late paperwork above the rest, then by name. */
export function sortViews(views: ProjectView[]): ProjectView[] {
  return [...views].sort(
    (a, b) =>
      STATUS_RANK[a.project.status] - STATUS_RANK[b.project.status] ||
      b.overdue.length - a.overdue.length ||
      b.at_risk - a.at_risk ||
      b.contribution - a.contribution ||
      a.project.name.localeCompare(b.project.name),
  )
}

export interface ProjectSummary {
  projects: number
  active: number
  entries: number
  hours: number
  labour_value: number
  labour_cost: number
  costed_hours: number
  uncosted_hours: number
  unlinked_hours: number
  after_labour: number
  unbilled_hours: number
  unbilled_value: number
  at_risk: number
  overdue_groups: number
  revenue: number
  cost: number
  contribution: number
  orphans: number
  unpriced_hours: number
  checked: number
}

export function summarise(views: ProjectView[]): ProjectSummary {
  const s: ProjectSummary = {
    projects: views.length,
    active: views.filter(v => v.project.status === 'active' || v.project.status === 'on_hold').length,
    entries: 0,
    hours: 0,
    labour_value: 0,
    labour_cost: 0,
    costed_hours: 0,
    uncosted_hours: 0,
    unlinked_hours: 0,
    after_labour: 0,
    unbilled_hours: 0,
    unbilled_value: 0,
    at_risk: 0,
    overdue_groups: 0,
    revenue: 0,
    cost: 0,
    contribution: 0,
    orphans: 0,
    unpriced_hours: 0,
    checked: 0,
  }
  for (const v of views) {
    s.entries += v.entry_count
    s.hours = round2(s.hours + v.hours)
    s.labour_value = round2(s.labour_value + v.labour_value)
    s.labour_cost = round2(s.labour_cost + v.labour_cost)
    s.costed_hours = round2(s.costed_hours + v.costed_hours)
    s.uncosted_hours = round2(s.uncosted_hours + v.uncosted_hours)
    s.unlinked_hours = round2(s.unlinked_hours + v.unlinked_hours)
    s.after_labour = round2(s.after_labour + v.after_labour)
    s.unbilled_hours = round2(s.unbilled_hours + v.unbilled_hours)
    s.unbilled_value = round2(s.unbilled_value + v.unbilled_value)
    s.at_risk = round2(s.at_risk + v.at_risk)
    s.overdue_groups += v.overdue.length
    s.revenue = round2(s.revenue + v.revenue)
    s.cost = round2(s.cost + v.cost)
    s.contribution = round2(s.contribution + v.contribution)
    s.orphans += v.orphans
    s.unpriced_hours = round2(s.unpriced_hours + v.unpriced_hours)
    s.checked += v.findings.length
  }
  return s
}

// ── validation ────────────────────────────────────────────────────────────────

export function validateProject(p: Project, all: Project[]): string[] {
  const errs: string[] = []
  if (!p.name.trim()) errs.push('A project needs a name — "Untitled" cannot be found again.')
  if (!isDate(p.start_date)) errs.push('The start date is not a real day.')
  if (p.target_date && !isDate(p.target_date)) errs.push('The planned end date is not a real day.')
  if (p.target_date && isDate(p.start_date) && p.target_date < p.start_date) {
    errs.push('The planned end date falls before the project started.')
  }
  if (p.hourly_rate < 0) errs.push('A rate cannot be negative.')
  if (p.hourly_rate > 10_00_000) errs.push('A rate above ₹10,00,000 an hour is a typo, not a rate.')
  if (p.budget_value < 0) errs.push('A budget cannot be negative.')
  const code = p.code.trim().toUpperCase()
  if (code && all.some(o => o.id !== p.id && o.code.trim().toUpperCase() === code)) {
    errs.push(`Another project already uses the code ${p.code.trim()}. Two registers with one reference cannot be told apart.`)
  }
  if (p.archived && p.status !== 'archived') errs.push('This row is both archived and live; pick one.')
  return errs
}

export function validateEntry(e: TimeEntry, projects: Project[], today: string): string[] {
  const errs: string[] = []
  const project = projects.find(p => p.id === e.project_id)
  if (!project) errs.push('Pick the project these hours belong to.')
  if (!isDate(e.date)) errs.push('The day the work was done is not a real date.')
  if (project && isDate(e.date) && project.start_date && e.date < project.start_date) {
    errs.push(`${e.date} falls before this project started (${project.start_date}).`)
  }
  if (isDate(e.date) && e.date > today) errs.push('Work cannot be logged for a day that has not happened yet.')
  if (!(e.hours > 0)) errs.push('Hours must be more than zero — nothing was done in zero hours.')
  if (e.hours > MAX_HOURS_PER_ENTRY) errs.push(`${e.hours} h in one day is more than a day holds. Log it as separate days or separate people.`)
  if (e.rate < 0) errs.push('A rate cannot be negative.')
  if (e.rate > 10_00_000) errs.push('A rate above ₹10,00,000 an hour is a typo, not a rate.')
  if (!e.person.trim()) errs.push('Say whose hours these are — an unnamed row of hours cannot be checked.')
  // An internal project whose hours carry a rate is a transfer-pricing question, not a data
  // error: this register does not know whether the charge is arm's length, so it neither
  // blocks the entry nor quietly pretends the value is nothing. The view prints the hours,
  // the rate and the rupees, and `/gst/gstr9` is where a related-party supply gets settled.
  return errs
}

// ── series for the page ───────────────────────────────────────────────────────

export interface MonthBucket {
  period: string
  label: string
  hours: number
  value: number
  billed: number
}

/** Hours per calendar month, oldest first, for the bar strip on the page. */
export function monthlySeries(entries: TimeEntry[], projects: Project[], months = 6): MonthBucket[] {
  const rate = byId(projects)
  const buckets = new Map<string, MonthBucket>()
  for (const e of entries) {
    const period = periodOf(e.date)
    if (!period) continue
    const p = rate.get(e.project_id)
    const value = p ? entryValue(e, p) : 0
    let b = buckets.get(period)
    if (!b) {
      b = { period, label: periodLabel(period), hours: 0, value: 0, billed: 0 }
      buckets.set(period, b)
    }
    b.hours = round2(b.hours + e.hours)
    b.value = round2(b.value + value)
    if (e.billed_ref) b.billed = round2(b.billed + value)
  }
  const all = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period))
  return months > 0 ? all.slice(-months) : all
}

export interface PersonBucket {
  person: string
  hours: number
  value: number
  entries: number
}

export function personSeries(entries: TimeEntry[], projects: Project[]): PersonBucket[] {
  const rate = byId(projects)
  const map = new Map<string, PersonBucket>()
  for (const e of entries) {
    const key = e.person.trim() || 'Unnamed'
    const p = rate.get(e.project_id)
    const value = p ? entryValue(e, p) : 0
    let b = map.get(key)
    if (!b) {
      b = { person: key, hours: 0, value: 0, entries: 0 }
      map.set(key, b)
    }
    b.hours = round2(b.hours + e.hours)
    b.value = round2(b.value + value)
    b.entries++
  }
  return [...map.values()].sort((a, b) => b.hours - a.hours || a.person.localeCompare(b.person))
}

// ── text for the invoice this work becomes ────────────────────────────────────

/**
 * What one month of unbilled work reads like as an invoice line. Handed over as text on
 * purpose: the invoice is raised on /invoices/new, through the write path that gives it a real
 * sequence number and moves stock. This page has no business writing that document.
 */
export function invoiceLineText(g: UnbilledGroup, project?: Project): string {
  const desc = project?.name || g.project
  const parts = [`${desc} — ${g.period_label}`]
  if (g.client) parts.push(`for ${g.client}`)
  parts.push(`${g.hours} h`)
  const rate = g.hours > 0 ? round2(g.value / g.hours) : 0
  if (g.value > 0 && rate > 0) parts.push(`@ ${rate}/h = ${g.value}`)
  else parts.push(`— no rate recorded, value not stated`)
  return parts.join(' ')
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const PROJECT_CSV_HEADERS = [
  'Code',
  'Project',
  'Client',
  'Status',
  'Billing',
  'Entries',
  'Hours',
  'Hour value',
  'Named hours cost',
  'Unbilled hours',
  'Unbilled value',
  'Billed revenue (taxable)',
  'Spend (taxable)',
  'Contribution',
  'Documents',
  'Orphans',
  'Months past the window',
  'Oldest unbilled supply',
  'Start',
  'Planned end',
]

export function projectCsvRows(views: ProjectView[]): (string | number)[][] {
  return views.map(v => {
    const g = [...v.groups].sort((a, b) => a.earliest.localeCompare(b.earliest))
    return [
      v.project.code,
      v.project.name,
      v.project.client_name,
      STATUS_META[v.project.status].label,
      BILLING_META[v.project.billing].label,
      v.entry_count,
      v.hours,
      v.labour_value,
      v.labour_cost,
      v.unbilled_hours,
      v.unbilled_value,
      v.revenue,
      v.cost,
      v.contribution,
      v.doc_count,
      v.orphans,
      v.overdue.length,
      g.length ? g[0].earliest : '',
      v.project.start_date,
      v.project.target_date,
    ]
  })
}

export const ENTRY_CSV_HEADERS = ['Date', 'Project', 'Client', 'Person', 'Hours', 'Rate', 'Value', 'Cost', 'Cost basis', 'Billed invoice', 'Window state', 'Invoice due', 'Note']

export function entryCsvRows(store: ProjectStore, today: string, costs: HourCostRow[] = []): (string | number)[][] {
  const projects = byId(store.projects)
  const groups = new Map(unbilledGroups(store.projects, store.entries, today).map(g => [g.key, g]))
  const costMap = costHours(store.entries, costs)
  return [...store.entries]
    .sort((a, b) => (a.date === b.date ? a.person.localeCompare(b.person) : a.date < b.date ? -1 : 1))
    .map(e => {
      const p = projects.get(e.project_id)
      const g = p && !e.billed_ref ? groups.get(`${p.id}:${periodOf(e.date)}`) : undefined
      const c = costMap.get(e.id)
      return [
        e.date,
        p?.name || '',
        p?.client_name || '',
        e.person,
        e.hours,
        p ? rateOf(e, p) : e.rate,
        p ? entryValue(e, p) : 0,
        c && c.cost !== null ? c.cost : '',
        c && c.cost !== null ? c.basis : c && c.linked ? c.why : '',
        e.billed_ref,
        g ? WATCH_META[g.state].label : e.billed_ref ? 'Billed' : '',
        g ? g.due_date : '',
        e.note,
      ]
    })
}

export const UNBILLED_CSV_HEADERS = ['Project', 'Client', 'Billing', 'Period', 'Hours', 'Value', 'Oldest supply', 'Window (days)', 'Invoice due', 'Days left', 'State']

export function unbilledCsvRows(groups: UnbilledGroup[]): (string | number)[][] {
  return groups.map(g => [
    g.project,
    g.client,
    BILLING_META[g.billing].label,
    g.period_label,
    g.hours,
    g.value,
    g.earliest,
    g.window ?? '',
    g.due_date,
    g.days_left ?? '',
    WATCH_META[g.state].label,
  ])
}
