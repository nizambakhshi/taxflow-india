// Job work — goods that leave and must come back, and the ITC-04 statement about them.
//
// This lives on localStorage (ADR-013) for the same reason the batch, serial and godown
// registers do: the schema has no `job_work` table, and the statutory paper that *does*
// exist — the delivery challan under rule 55 — carries no field for "must return by".
// What is statutory stays statutory: a job-work movement travels on a real challan from
// the /challans register, and a delivery made from the job worker's own place is a real
// supply that belongs on /invoices. This module keeps the third thing the law asks for:
// a dated account of what went out, what came back, and what never did.
//
// Four decisions carry the model:
//  * **The clock is section 143, and rule 45 is the penalty for running it out.** Inputs
//    may stay out for the stipulated period up to one year; capital goods up to three
//    years (the proviso to s.143(1) as made operational by rule 45). A lot may carry its
//    own *stipulated* period — what the challan or the job card actually says — but never
//    a longer one than the statute allows, so `validateLot` caps it rather than trusting it.
//  * **Moulds, dies, tooling and templates have no return period.** They are reported on
//    ITC-04 and are not required to come back, so their deadline is `null` and they can
//    never be "overdue". A model that charged them interest would be wrong in the loud
//    direction, so the category is a first-class option instead of a note.
//  * **Deemed supply is dated the day the goods went out** (rule 45: goods not received
//    back within the stipulated period "shall be deemed to have been supplied" on the date
//    of sending). So the exposure is never "today" — it reaches backwards, which is why the
//    view prints `deemed_on` as the send date and why a *late* return counts just as much
//    as a quantity still standing out: the deeming happened when the deadline passed, and
//    the goods coming home on day 400 does not undo it.
//  * **There is deliberately no "written off" disposition.** Goods that never come back are
//    deemed supplied on the day they were sent — which is exactly what leaving them
//    outstanding reports. A second way to say the same thing would only let the two drift.
//
// What v1 deliberately does NOT claim: the tax on a deemed supply is not settled by this
// register. The figure it prints is `indicative_tax` — the outstanding value at the goods'
// own rate — and it is labelled indicative wherever it appears, because whether tax falls
// on the value of the goods or on the job-work service is a call for the officer and the CA,
// not something a client-side workpaper should present as a challan amount. Nothing here
// posts tax, and nothing here receipts money: /payments stays the only writer of money.

import { addMonthsISO, daysBetween, parseISO } from '@/lib/recurring'
import { newId, todayISO } from '@/lib/batches'
import { plural } from '@/lib/format'

export { todayISO }

const KEY_JOBWORK = 'taxflow:jobwork:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const JW_VERSION = 1

/** Inside this many days of the section 143 period, a lot is worth looking at. */
export const APPROACHING_DAYS = 30

/** Aggregate turnover above which the ITC-04 statement is half-yearly rather than annual. */
export const ITC04_TURNOVER_LIMIT = 50000000

/** A movement is a fraction of a unit (kilograms of fabric), so quantities keep three. */
const Q = 1000
const EPSILON = 0.0005

// ── What the goods are ───────────────────────────────────────────────────────

export type GoodsCategory = 'input' | 'capital_goods' | 'moulds_tools'

export const CATEGORY_ORDER: GoodsCategory[] = ['input', 'capital_goods', 'moulds_tools']

export const CATEGORY_META: Record<GoodsCategory, {
  label: string
  short: string
  /** Months the goods may lawfully stay out. `null` = section 143 fixes no return period. */
  statutory_months: number | null
  statutory_label: string
  basis: string
}> = {
  input: {
    label: 'Inputs',
    short: 'Input',
    statutory_months: 12,
    statutory_label: '1 year',
    basis: 'Section 143(1)(a) proviso with rule 45(1): inputs sent for job work must be received back within the period stated in the challan, not exceeding one year from the date of sending.',
  },
  capital_goods: {
    label: 'Capital goods',
    short: 'Capital',
    statutory_months: 36,
    statutory_label: '3 years',
    basis: 'Section 143 with rule 45: capital goods sent for job work are allowed three years from the date of sending before the deeming in rule 45 bites.',
  },
  moulds_tools: {
    label: 'Moulds, dies, tools and templates',
    short: 'Tooling',
    statutory_months: null,
    statutory_label: 'No return period',
    basis: 'Moulds, dies, tools and templates sent to the job worker for use in the job work are reported on ITC-04 but are not required to be brought back, so no deadline runs on them.',
  },
}

// ── What happened to the goods ───────────────────────────────────────────────

export type DispositionKind = 'returned' | 'direct_delivery' | 'alternate_worker'

export const DISPOSITION_META: Record<DispositionKind, {
  label: string
  short: string
  /** Which half of the ITC-04 statement the row feeds. */
  grid: string
  note: string
}> = {
  returned: {
    label: 'Received back at my place',
    short: 'Returned',
    grid: 'ITC-04 — goods received back from the job worker',
    note: 'The goods came home. A return dated after the section 143 period still counts as a late return — the deeming under rule 45 already happened.',
  },
  direct_delivery: {
    label: 'Delivered from the job worker straight to a customer',
    short: 'Direct delivery',
    grid: 'ITC-04 — supply made from the job worker’s place of business',
    note: 'Rule 45(1)/(4): the principal may ask the job worker to deliver direct to a recipient. That leg is a supply by the principal — it needs an invoice on /invoices; this row only feeds the statement.',
  },
  alternate_worker: {
    label: 'Moved on to another job worker',
    short: 'To another worker',
    grid: 'ITC-04 — goods sent directly to another job worker',
    note: 'Rule 45(2): goods can go from the principal’s place straight to a second job worker, and the move must be intimated. The clock does not restart — the deadline stays the original one.',
  },
}

export const DISPOSITION_ORDER: DispositionKind[] = ['returned', 'direct_delivery', 'alternate_worker']

// ── Where the lot stands ─────────────────────────────────────────────────────

export type JobStatus = 'settled' | 'no_deadline' | 'within' | 'approaching' | 'returned_late' | 'overdue'

export const STATUS_LABEL: Record<JobStatus, string> = {
  settled: 'Closed',
  no_deadline: 'No period to run',
  within: 'Inside time',
  approaching: 'Due soon',
  returned_late: 'Back, but late',
  overdue: 'Period run out',
}

export const STATUS_TONE: Record<JobStatus, 'green' | 'grey' | 'blue' | 'amber' | 'red'> = {
  settled: 'green',
  no_deadline: 'grey',
  within: 'blue',
  approaching: 'amber',
  returned_late: 'amber',
  overdue: 'red',
}

// ── Stored shapes ────────────────────────────────────────────────────────────

export interface JobWorker {
  id: string
  name: string
  /** May be blank — an unregistered job worker is legal below their own service threshold. */
  gstin: string
  address: string
  state: string
  contact: string
  notes: string
  archived: boolean
  created_at: string
}

/** Goods sent out to a job worker — the row ITC-04 reports as "sent". */
export interface JobLot {
  id: string
  sent_date: string
  /** Registered worker id; blank when the worker was only ever named on the challan. */
  worker_id: string
  /** The name as the movement paper has it — always present, registered or not. */
  worker_name: string
  item_name: string
  hsn_sac: string
  qty: number
  unit: string
  /** Value at cost, as the challan declares it. ITC-04 asks for value, not price. */
  value: number
  category: GoodsCategory
  /** The rate the *goods* carry — used only for the indicative figure on a deemed supply. */
  gst_rate: number
  /** Rule 55 movement document that travelled with the goods. */
  challan_number: string
  challan_date: string
  /** Section 143 period the challan stipulates, in months. 0 = use the statutory period. */
  stipulated_months: number
  /** /challans document id, when the movement was raised as a delivery challan in the app. */
  challan_ref: string
  eway_bill_number: string
  vehicle_number: string
  notes: string
  created_at: string
}

/** One event against a lot: some of it came home, went to a customer, or moved on. */
export interface JobDisposition {
  id: string
  lot_id: string
  kind: DispositionKind
  date: string
  qty: number
  /** Recipient for a direct delivery, the second worker for an onward move, blank for a return. */
  party_name: string
  party_gstin: string
  /** Challan / e-way bill / invoice number the goods moved or were billed under. */
  ref: string
  note: string
  created_at: string
}

export interface JobSettings {
  /** Owner's aggregate turnover for the year the statement is being prepared for, in ₹ crore.
   *  0 = not declared, and the page then says the cadence is being assumed from the books. */
  turnover_cr: number
  notes: string
}

export interface JobStore {
  version: number
  updatedAt: string
  orgId: string
  workers: JobWorker[]
  lots: JobLot[]
  dispositions: JobDisposition[]
  settings: JobSettings
}

export function emptyJob(orgId = ''): JobStore {
  return {
    version: JW_VERSION,
    updatedAt: todayISO(),
    orgId,
    workers: [],
    lots: [],
    dispositions: [],
    settings: { turnover_cr: 0, notes: '' },
  }
}

export function newWorker(name = ''): JobWorker {
  return { id: newId(), name, gstin: '', address: '', state: '', contact: '', notes: '', archived: false, created_at: new Date().toISOString() }
}

export function newLot(sentDate: string): JobLot {
  return {
    id: newId(),
    sent_date: sentDate || todayISO(),
    worker_id: '',
    worker_name: '',
    item_name: '',
    hsn_sac: '',
    qty: 1,
    unit: 'NOS',
    value: 0,
    category: 'input',
    gst_rate: 18,
    challan_number: '',
    challan_date: '',
    stipulated_months: 0,
    challan_ref: '',
    eway_bill_number: '',
    vehicle_number: '',
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newDisposition(lotId: string, kind: DispositionKind): JobDisposition {
  return {
    id: newId(),
    lot_id: lotId,
    kind,
    date: todayISO(),
    qty: 0,
    party_name: '',
    party_gstin: '',
    ref: '',
    note: '',
    created_at: new Date().toISOString(),
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function round3(v: number): number {
  return Math.round((Number(v) || 0) * Q) / Q
}

function round2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

/** A real calendar day, not twelve digits with dashes in them. */
function isDate(v: unknown): v is string {
  return parseISO(str(v)) !== null
}

/**
 * A GSTIN is 15 characters: 2 state digits, the 10-character PAN, an entity check code,
 * the letter Z (a placeholder until the portal issues site codes) and a checksum. The Z is
 * enforced because a job worker's GSTIN is transcribed off their paperwork, and a mistyped
 * Z is the commonest slip — ITC-04 will not accept the row either way.
 */
export function normaliseGstin(raw: string): string {
  return str(raw).toUpperCase().replace(/[^0-9A-Z]/g, '').trim()
}

export function isGstin(raw: string): boolean {
  const g = normaliseGstin(raw)
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)
}

function categoryOf(v: unknown): GoodsCategory {
  const c = str(v) as GoodsCategory
  return CATEGORY_META[c] ? c : 'input'
}

function dispositionKindOf(v: unknown): DispositionKind {
  const k = str(v) as DispositionKind
  return DISPOSITION_META[k] ? k : 'returned'
}

function parseWorker(raw: unknown): JobWorker | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = str(o.name).trim()
  if (!name) return null
  return {
    id: str(o.id) || newId(),
    name,
    gstin: normaliseGstin(str(o.gstin)),
    address: str(o.address),
    state: str(o.state),
    contact: str(o.contact),
    notes: str(o.notes),
    archived: o.archived === true,
    created_at: str(o.created_at) || new Date().toISOString(),
  }
}

function parseLot(raw: unknown): JobLot | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const item = str(o.item_name).trim()
  // An item-less or undated movement is not a movement: nothing can be derived from it.
  if (!item || !isDate(o.sent_date)) return null
  const qty = round3(num(o.qty))
  if (qty <= 0) return null
  return {
    id: str(o.id) || newId(),
    sent_date: o.sent_date as string,
    worker_id: str(o.worker_id),
    worker_name: str(o.worker_name).trim(),
    item_name: item,
    hsn_sac: str(o.hsn_sac).trim().replace(/\D/g, '') || str(o.hsn_sac).trim(),
    qty,
    unit: str(o.unit) || 'NOS',
    value: round2(Math.max(0, num(o.value))),
    category: categoryOf(o.category),
    gst_rate: Math.max(0, num(o.gst_rate)),
    challan_number: str(o.challan_number).trim(),
    challan_date: isDate(o.challan_date) ? (o.challan_date as string) : '',
    stipulated_months: Math.max(0, Math.round(num(o.stipulated_months))),
    challan_ref: str(o.challan_ref),
    eway_bill_number: str(o.eway_bill_number).trim(),
    vehicle_number: str(o.vehicle_number).trim(),
    notes: str(o.notes),
    created_at: str(o.created_at) || todayISO(),
  }
}

function parseDisposition(raw: unknown): JobDisposition | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const lotId = str(o.lot_id)
  const qty = round3(num(o.qty))
  if (!lotId || qty <= 0 || !isDate(o.date)) return null
  return {
    id: str(o.id) || newId(),
    lot_id: lotId,
    kind: dispositionKindOf(o.kind),
    date: o.date as string,
    qty,
    party_name: str(o.party_name).trim(),
    party_gstin: normaliseGstin(str(o.party_gstin)),
    ref: str(o.ref).trim(),
    note: str(o.note),
    created_at: str(o.created_at) || todayISO(),
  }
}

export function parseJob(raw: string | null): JobStore {
  if (!raw) return emptyJob()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyJob()
  }
  if (!parsed || typeof parsed !== 'object') return emptyJob()
  const s = parsed as Record<string, unknown>
  if (s.version !== JW_VERSION) return emptyJob(str(s.orgId))
  const workers = Array.isArray(s.workers) ? s.workers.map(parseWorker).filter((w): w is JobWorker => w !== null) : []
  const lots = Array.isArray(s.lots) ? s.lots.map(parseLot).filter((l): l is JobLot => l !== null) : []
  const rawDispositions = Array.isArray(s.dispositions)
    ? s.dispositions.map(parseDisposition).filter((d): d is JobDisposition => d !== null)
    : []
  // A disposition pointing at a lot that is not on the register cannot be shown to anyone.
  const live = new Set(lots.map(l => l.id))
  const settings = s.settings && typeof s.settings === 'object' ? s.settings as Record<string, unknown> : {}
  return {
    version: JW_VERSION,
    updatedAt: str(s.updatedAt) || todayISO(),
    orgId: str(s.orgId),
    workers,
    lots,
    dispositions: rawDispositions.filter(d => live.has(d.lot_id)),
    settings: {
      turnover_cr: Math.max(0, num(settings.turnover_cr)),
      notes: str(settings.notes),
    },
  }
}

export function loadJob(orgId: string): JobStore {
  if (typeof window === 'undefined' || !orgId) return emptyJob()
  try {
    return { ...parseJob(window.localStorage.getItem(KEY_JOBWORK + orgId)), orgId }
  } catch {
    return emptyJob(orgId)
  }
}

export function saveJob(orgId: string, store: JobStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_JOBWORK + orgId,
      JSON.stringify({ ...store, orgId, version: JW_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: JobStore) => JobStore): JobStore {
  const next = fn(loadJob(orgId))
  saveJob(orgId, next)
  return next
}

/** Sorts lots oldest send first, then by item — the order a statement reads in. */
export function sortLots(lots: JobLot[]): JobLot[] {
  return [...lots].sort((a, b) => (a.sent_date !== b.sent_date ? (a.sent_date < b.sent_date ? -1 : 1) : a.item_name.localeCompare(b.item_name)))
}

/** Dispositions of one lot, oldest first — the order the value split is walked in. */
export function linesOf(dispositions: JobDisposition[], lotId: string): JobDisposition[] {
  return dispositions
    .filter(d => d.lot_id === lotId)
    .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.created_at < b.created_at ? -1 : 1))
}

// ── Workers ──────────────────────────────────────────────────────────────────

export function validateWorker(worker: JobWorker, all: JobWorker[]): string[] {
  const problems: string[] = []
  const name = worker.name.trim()
  if (!name) problems.push('Give the job worker a name')
  if (all.some(w => w.id !== worker.id && w.name.trim().toLowerCase() === name.toLowerCase())) {
    problems.push(`A job worker called “${name}” is already on the register`)
  }
  if (worker.gstin.trim() && !isGstin(worker.gstin)) {
    problems.push(`“${worker.gstin}” is not a 15-character GSTIN — 2 state digits, a 10-character PAN, an entity check code, the letter Z and a checksum`)
  }
  return problems
}

export function upsertWorker(orgId: string, worker: JobWorker): { ok: boolean; error: string; store: JobStore } {
  const store = loadJob(orgId)
  const problems = validateWorker(worker, store.workers)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: JobWorker = { ...worker, name: worker.name.trim(), gstin: normaliseGstin(worker.gstin) }
  const next: JobStore = {
    ...store,
    workers: store.workers.some(w => w.id === clean.id)
      ? store.workers.map(w => (w.id === clean.id ? clean : w))
      : [...store.workers, clean],
  }
  saveJob(orgId, next)
  return { ok: true, error: '', store: next }
}

/**
 * Archive rather than delete — a movement already on the register names this worker, and
 * history must keep resolving to a person. Refused while goods are still out with them.
 */
export function archiveWorker(orgId: string, id: string): { ok: boolean; error: string; store: JobStore } {
  const store = loadJob(orgId)
  const open = store.lots.filter(l => l.worker_id === id).length
  if (open > 0) {
    return { ok: false, error: `Remove or close ${plural(open, 'movement')} against this job worker first — their history names them`, store }
  }
  const next = { ...store, workers: store.workers.map(w => (w.id === id ? { ...w, archived: true } : w)) }
  saveJob(orgId, next)
  return { ok: true, error: '', store: next }
}

export function workerById(workers: JobWorker[], id: string): JobWorker | null {
  return workers.find(w => w.id === id) || null
}

// ── Movements ────────────────────────────────────────────────────────────────

/** The section 143 period that actually runs on this lot: the challan's own, capped. */
export function periodMonths(lot: JobLot): number | null {
  const statutory = CATEGORY_META[lot.category].statutory_months
  if (statutory === null) return null
  const stipulated = lot.stipulated_months > 0 ? Math.min(lot.stipulated_months, statutory) : statutory
  return stipulated
}

/** The day the goods must be back by — `null` for tooling, which has no return period. */
export function deadlineOf(lot: JobLot): string | null {
  const months = periodMonths(lot)
  if (months === null) return null
  return addMonthsISO(lot.sent_date, months)
}

export function unitValue(lot: JobLot): number {
  return lot.qty > 0 ? lot.value / lot.qty : 0
}

export function validateLot(lot: JobLot, store: JobStore): string[] {
  const problems: string[] = []
  if (!lot.item_name.trim()) problems.push('Name the item that went out')
  if (!isDate(lot.sent_date)) problems.push('Give the date the goods went out')
  if (!(lot.qty > 0)) problems.push('Give the quantity that left — a movement of zero units is not a movement')
  if (lot.value < 0) problems.push('The value cannot be negative — enter it at cost, or zero if the challan carries no value')
  if (!lot.worker_id && !lot.worker_name.trim()) problems.push('Choose the job worker, or name the one the goods went to')
  if (!lot.challan_number.trim()) problems.push('A job-work movement needs the challan number that travelled with the goods (rule 55)')
  if (!isDate(lot.challan_date)) problems.push('The challan needs its date too')
  if (isDate(lot.challan_date) && isDate(lot.sent_date) && lot.challan_date > lot.sent_date) {
    problems.push(`The challan is dated ${lot.challan_date}, after the goods went out on ${lot.sent_date}`)
  }
  const cap = CATEGORY_META[lot.category].statutory_months
  if (lot.stipulated_months < 0) problems.push('A stipulated period cannot be negative')
  if (cap !== null && lot.stipulated_months > cap) {
    problems.push(`Section 143 allows ${CATEGORY_META[lot.category].statutory_label} out for ${CATEGORY_META[lot.category].label.toLowerCase()} — a challan cannot stipulate longer`)
  }
  // Editing the quantity down under what has already come back would turn the register's
  // outstanding column negative, and a negative return is not a thing.
  const alreadyMoved = store.dispositions.filter(d => d.lot_id === lot.id).reduce((s, d) => s + d.qty, 0)
  if (lot.qty + EPSILON < alreadyMoved) {
    problems.push(`${alreadyMoved} ${lot.unit} have already moved against this challan — the quantity sent cannot be smaller than that until those movements are removed`)
  }
  // The same challan carrying the same item to the same worker on the same day is how a
  // double entry looks from the inside, and a doubled quantity doubles an exposure.
  const twin = store.lots.some(l => l.id !== lot.id
    && l.challan_number.trim().toLowerCase() === lot.challan_number.trim().toLowerCase()
    && l.challan_number.trim() !== ''
    && l.item_name.trim().toLowerCase() === lot.item_name.trim().toLowerCase()
    && l.sent_date === lot.sent_date
    && (l.worker_id === lot.worker_id || (l.worker_name.trim().toLowerCase() === lot.worker_name.trim().toLowerCase() && lot.worker_name.trim() !== '')))
  if (twin) problems.push(`Challan ${lot.challan_number} already carries ${lot.item_name} to this job worker on ${lot.sent_date} — check it is not entered twice`)
  return problems
}

export function recordLot(orgId: string, lot: JobLot): { ok: boolean; error: string; store: JobStore } {
  const store = loadJob(orgId)
  const problems = validateLot(lot, store)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: JobLot = {
    ...lot,
    item_name: lot.item_name.trim(),
    worker_name: resolveWorkerName(lot, store),
    hsn_sac: lot.hsn_sac.trim(),
    challan_number: lot.challan_number.trim(),
    qty: round3(lot.qty),
    value: round2(lot.value),
  }
  const next: JobStore = {
    ...store,
    lots: store.lots.some(l => l.id === clean.id) ? store.lots.map(l => (l.id === clean.id ? clean : l)) : [...store.lots, clean],
  }
  saveJob(orgId, next)
  return { ok: true, error: '', store: next }
}

/** The worker's name as registered, if the lot picked one — a rename must not fork history. */
function resolveWorkerName(lot: JobLot, store: JobStore): string {
  const registered = workerById(store.workers, lot.worker_id)
  if (registered) return registered.name
  return lot.worker_name.trim() || 'Job worker (not on the register)'
}

/**
 * A lot with dispositions against it is history. Deleting it would leave returns pointing
 * at nothing, so they have to come off first — same stance the serial register takes.
 */
export function deleteLot(orgId: string, id: string): { ok: boolean; error: string; store: JobStore } {
  const store = loadJob(orgId)
  const attached = store.dispositions.filter(d => d.lot_id === id).length
  if (attached > 0) {
    return { ok: false, error: `${plural(attached, 'movement')} recorded against this challan — remove those first`, store }
  }
  const next = { ...store, lots: store.lots.filter(l => l.id !== id) }
  saveJob(orgId, next)
  return { ok: true, error: '', store: next }
}

// ── Dispositions ─────────────────────────────────────────────────────────────

export function outstandingOf(lot: JobLot, dispositions: JobDisposition[]): number {
  const out = dispositions.filter(d => d.lot_id === lot.id).reduce((s, d) => s - d.qty, lot.qty)
  return round3(out)
}

export function validateDisposition(
  disposition: JobDisposition,
  lot: JobLot,
  dispositions: JobDisposition[],
): string[] {
  const problems: string[] = []
  const lines = dispositions.filter(d => d.lot_id === lot.id && d.id !== disposition.id)
  const outstanding = round3(lot.qty - lines.reduce((s, d) => s + d.qty, 0))
  if (!(disposition.qty > 0)) problems.push('Give the quantity this movement covers')
  if (!isDate(disposition.date)) problems.push('Give the date the goods moved')
  if (isDate(disposition.date) && disposition.date < lot.sent_date) {
    problems.push(`The goods went out on ${lot.sent_date} — a movement dated ${disposition.date} is before that`)
  }
  if (disposition.qty > outstanding + EPSILON) {
    problems.push(`Only ${outstanding} ${lot.unit} of challan ${lot.challan_number || lot.item_name} is still out — a movement back cannot exceed what went`)
  }
  if (disposition.kind === 'direct_delivery' && !disposition.party_name.trim()) {
    problems.push('Name the customer the goods were delivered to — ITC-04 records who received them')
  }
  if (disposition.kind === 'alternate_worker' && !disposition.party_name.trim()) {
    problems.push('Name the job worker the goods moved on to — rule 45 wants that intimation recorded')
  }
  if (disposition.party_gstin && !isGstin(disposition.party_gstin)) {
    problems.push(`“${disposition.party_gstin}” is not a 15-character GSTIN`)
  }
  return problems
}

export function addDisposition(orgId: string, disposition: JobDisposition): { ok: boolean; error: string; store: JobStore } {
  const store = loadJob(orgId)
  const lot = store.lots.find(l => l.id === disposition.lot_id)
  if (!lot) return { ok: false, error: 'That movement is no longer on the register', store }
  const problems = validateDisposition(disposition, lot, store.dispositions)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: JobDisposition = {
    ...disposition,
    qty: round3(disposition.qty),
    party_name: disposition.party_name.trim(),
    party_gstin: normaliseGstin(disposition.party_gstin),
    ref: disposition.ref.trim(),
  }
  const next: JobStore = {
    ...store,
    dispositions: store.dispositions.some(d => d.id === clean.id)
      ? store.dispositions.map(d => (d.id === clean.id ? clean : d))
      : [...store.dispositions, clean],
  }
  saveJob(orgId, next)
  return { ok: true, error: '', store: next }
}

/** Dispositions are the register's own keying — a mis-read line can be corrected. */
export function deleteDisposition(orgId: string, id: string): JobStore {
  return mutate(orgId, store => ({ ...store, dispositions: store.dispositions.filter(d => d.id !== id) }))
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The owner's aggregate turnover for the year the statement covers, in ₹ crore. It decides
 * nothing about the movements — only whether the statement is half-yearly or annual — so it
 * is asked for as a declared figure rather than derived from books that may be incomplete.
 */
export function setTurnoverCr(orgId: string, turnoverCr: number): JobStore {
  const value = round2(Math.max(0, num(turnoverCr)))
  return mutate(orgId, store => ({ ...store, settings: { ...store.settings, turnover_cr: value } }))
}

// ── The view: everything derived, nothing stored twice ───────────────────────

export interface JobLine {
  disposition: JobDisposition
  /** Rupees this line carries — the lot's value shared pro-rata, remainder on the last line. */
  value: number
  /** False when the goods came back after the section 143 day; null when there is no day. */
  within: boolean | null
}

export interface JobView {
  lot: JobLot
  worker: JobWorker | null
  /** Name the movement actually went to — registered worker or the name on the challan. */
  worker_name: string
  worker_gstin: string
  lines: JobLine[]
  unit_value: number
  period_months: number | null
  deadline: string | null
  sent_qty: number
  sent_value: number
  returned_qty: number
  returned_value: number
  /** Split of the returns by whether the period had run out when they landed. */
  returned_within_qty: number
  returned_after_qty: number
  direct_qty: number
  direct_value: number
  alternate_qty: number
  alternate_value: number
  outstanding_qty: number
  outstanding_value: number
  days_out: number | null
  days_to_deadline: number | null
  status: JobStatus
  status_label: string
  /** Units the rule 45 deeming catches: still out past the day, plus anything that came back late. */
  deemed_qty: number
  deemed_value: number
  /** The date the law treats those units as supplied — the day they went out. */
  deemed_on: string | null
  indicative_tax: number
  /** Latest movement date, for the "last seen" column. */
  last_move_date: string | null
  problems: string[]
}

/**
 * The lot's value shared across its lines pro-rata, with the rounding remainder pushed onto
 * the last line — so three returns of 1 from a ₹100/3-unit lot read 33.33, 33.33, 33.34 and
 * the register closes on the challan value instead of a paisa short of it.
 */
export function splitValues(lot: JobLot, lines: JobDisposition[]): number[] {
  const per = unitValue(lot)
  const values = lines.map(l => round2(l.qty * per))
  const total = round3(lines.reduce((s, l) => s + l.qty, 0))
  if (lines.length && Math.abs(total - lot.qty) < EPSILON) {
    const before = values.slice(0, -1).reduce((s, v) => s + v, 0)
    values[values.length - 1] = round2(lot.value - before)
  }
  return values
}

export function jobView(
  lot: JobLot,
  store: Pick<JobStore, 'workers' | 'dispositions'>,
  today: string = todayISO(),
): JobView {
  const sorted = linesOf(store.dispositions, lot.id)
  const values = splitValues(lot, sorted)
  const worker = workerById(store.workers, lot.worker_id)
  const deadline = deadlineOf(lot)
  const per = unitValue(lot)

  let returnedQty = 0, returnedValue = 0, returnedWithin = 0, returnedAfter = 0
  let directQty = 0, directValue = 0, alternateQty = 0, alternateValue = 0
  let lateValue = 0, lateQty = 0

  const lines: JobLine[] = sorted.map((d, i) => {
    const value = values[i]
    const within = deadline === null ? null : d.date <= deadline
    if (d.kind === 'returned') {
      returnedQty = round3(returnedQty + d.qty)
      returnedValue = round2(returnedValue + value)
      if (within === false) { returnedAfter = round3(returnedAfter + d.qty); lateQty = round3(lateQty + d.qty); lateValue = round2(lateValue + value) }
      else { returnedWithin = round3(returnedWithin + d.qty) }
    } else if (d.kind === 'direct_delivery') {
      directQty = round3(directQty + d.qty)
      directValue = round2(directValue + value)
    } else {
      alternateQty = round3(alternateQty + d.qty)
      alternateValue = round2(alternateValue + value)
    }
    return { disposition: d, value, within }
  })

  const outstandingQty = round3(lot.qty - returnedQty - directQty - alternateQty)
  // Once every unit is accounted for, the outstanding rupees are zero by construction —
  // the value was split across the lines, so re-multiplying a rounded unit rate would drift.
  const outstandingValue = outstandingQty <= EPSILON ? 0 : round2(lot.value - returnedValue - directValue - alternateValue)

  const daysOut = outstandingQty > EPSILON ? daysBetween(lot.sent_date, today) : null
  const lastMove = lines.length ? lines[lines.length - 1].disposition.date : null
  const daysToDeadline = deadline === null ? null : daysBetween(today, deadline)

  // The deeming catches what is still out past the day *and* what came back after it.
  const deemedOutstanding = deadline !== null && outstandingQty > EPSILON && daysToDeadline !== null && daysToDeadline < 0
  const deemedQty = round3((deemedOutstanding ? outstandingQty : 0) + lateQty)
  const deemedValue = round2((deemedOutstanding ? outstandingValue : 0) + lateValue)

  let status: JobStatus
  if (deadline === null) status = outstandingQty > EPSILON ? 'no_deadline' : 'settled'
  else if (deemedOutstanding) status = 'overdue'
  else if (outstandingQty <= EPSILON) status = lateQty > EPSILON ? 'returned_late' : 'settled'
  else if (daysToDeadline !== null && daysToDeadline <= APPROACHING_DAYS) status = 'approaching'
  else status = 'within'

  const problems: string[] = []
  if (!lot.hsn_sac.trim()) {
    problems.push('No HSN/SAC on this movement — ITC-04 is prepared HSN-wise, so it will fall under the blank code')
  }
  if (lot.category === 'moulds_tools' && lot.stipulated_months > 0) {
    problems.push(`${lot.stipulated_months} months was written on this tooling movement — section 143 fixes no return period for moulds and dies, so nothing here is ever overdue`)
  }
  if (!worker) {
    if (lot.worker_id) {
      problems.push('This movement points at a job worker who is no longer on the register — add them back so the statement carries their GSTIN')
    } else if (lot.worker_name.trim()) {
      problems.push(`${lot.worker_name} is named on the movement but not on the job-worker register — add them so the statement carries their GSTIN`)
    }
  }
  if (lot.challan_date && lot.sent_date && lot.challan_date > lot.sent_date) {
    problems.push(`The challan is dated ${lot.challan_date}, after the goods went out on ${lot.sent_date}`)
  }
  if (status === 'overdue' && deadline && daysToDeadline !== null) {
    problems.push(`${outstandingQty} ${lot.unit} still out since ${deadline} — rule 45 deems them supplied on ${lot.sent_date} (${plural(Math.abs(daysToDeadline), 'day')} past the period)`)
  }
  if (lateQty > EPSILON) {
    problems.push(`${lateQty} ${lot.unit} came back after ${deadline} — the deeming under rule 45 already happened on ${lot.sent_date}, so bringing the goods home does not undo it`)
  }
  const unbilledDirect = lines.filter(l => l.disposition.kind === 'direct_delivery' && !l.disposition.ref.trim())
  if (unbilledDirect.length) {
    problems.push('A delivery made from the job worker’s place is your supply — raise it on /invoices so GSTR-1 sees it')
  }

  return {
    lot,
    worker,
    worker_name: worker ? worker.name : (lot.worker_name.trim() || 'Job worker (not on the register)'),
    worker_gstin: worker ? worker.gstin : '',
    lines,
    unit_value: per,
    period_months: periodMonths(lot),
    deadline,
    sent_qty: lot.qty,
    sent_value: lot.value,
    returned_qty: returnedQty,
    returned_value: returnedValue,
    returned_within_qty: returnedWithin,
    returned_after_qty: returnedAfter,
    direct_qty: directQty,
    direct_value: directValue,
    alternate_qty: alternateQty,
    alternate_value: alternateValue,
    outstanding_qty: outstandingQty,
    outstanding_value: outstandingValue,
    days_out: daysOut === null && lastMove ? daysBetween(lot.sent_date, lastMove) : daysOut,
    days_to_deadline: daysToDeadline,
    status,
    status_label: STATUS_LABEL[status],
    deemed_qty: deemedQty,
    deemed_value: deemedValue,
    deemed_on: deemedQty > EPSILON ? lot.sent_date : null,
    indicative_tax: round2(deemedValue * (lot.gst_rate / 100)),
    last_move_date: lastMove,
    problems,
  }
}

/** Every lot on the register, viewed as of `today`. */
export function jobViews(store: JobStore, today: string = todayISO()): JobView[] {
  return sortLots(store.lots).map(lot => jobView(lot, store, today))
}

/**
 * Order the way a person triages: anything with a rule 45 exposure first, then the lots
 * closest to running their period out, then everything settled by send date.
 */
export function sortJobViews(views: JobView[]): JobView[] {
  const rank: Record<JobStatus, number> = { overdue: 0, approaching: 1, returned_late: 2, within: 3, no_deadline: 4, settled: 5 }
  return [...views].sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status]
    if (a.status === 'settled' || a.status === 'no_deadline') return a.lot.sent_date < b.lot.sent_date ? 1 : -1
    const ad = a.deadline || '9999-12-31'
    const bd = b.deadline || '9999-12-31'
    if (ad !== bd) return ad < bd ? -1 : 1
    return a.lot.sent_date < b.lot.sent_date ? -1 : 1
  })
}

// ── Summary ──────────────────────────────────────────────────────────────────

export interface CategoryRollup {
  category: GoodsCategory
  label: string
  lots: number
  sent_qty: number
  outstanding_qty: number
  outstanding_value: number
  deemed_qty: number
  deemed_value: number
}

export interface JobSummary {
  lots: number
  openLots: number
  settledLots: number
  workers: number
  /** Movements with no line against them at all — the goods have not been heard of yet. */
  untouched: number
  sent_qty: number
  sent_value: number
  outstanding_qty: number
  outstanding_value: number
  returned_qty: number
  returned_value: number
  direct_qty: number
  direct_value: number
  alternate_qty: number
  alternate_value: number
  approaching: number
  overdue: number
  returned_late: number
  deemed_qty: number
  deemed_value: number
  indicative_tax: number
  /** Longest stretch goods have been out without a deadline passing. */
  oldest_open_days: number
  by_category: CategoryRollup[]
}

export function jobSummary(views: JobView[], workers: JobWorker[]): JobSummary {
  const open = views.filter(v => v.outstanding_qty > EPSILON)
  const byCategory: CategoryRollup[] = CATEGORY_ORDER.map(category => {
    const mine = views.filter(v => v.lot.category === category)
    return {
      category,
      label: CATEGORY_META[category].label,
      lots: mine.length,
      sent_qty: round3(mine.reduce((s, v) => s + v.sent_qty, 0)),
      outstanding_qty: round3(mine.reduce((s, v) => s + v.outstanding_qty, 0)),
      outstanding_value: round2(mine.reduce((s, v) => s + v.outstanding_value, 0)),
      deemed_qty: round3(mine.reduce((s, v) => s + v.deemed_qty, 0)),
      deemed_value: round2(mine.reduce((s, v) => s + v.deemed_value, 0)),
    }
  })
  return {
    lots: views.length,
    openLots: open.length,
    settledLots: views.length - open.length,
    workers: workers.filter(w => !w.archived).length,
    untouched: views.filter(v => v.lines.length === 0).length,
    sent_qty: round3(views.reduce((s, v) => s + v.sent_qty, 0)),
    sent_value: round2(views.reduce((s, v) => s + v.sent_value, 0)),
    outstanding_qty: round3(open.reduce((s, v) => s + v.outstanding_qty, 0)),
    outstanding_value: round2(open.reduce((s, v) => s + v.outstanding_value, 0)),
    returned_qty: round3(views.reduce((s, v) => s + v.returned_qty, 0)),
    returned_value: round2(views.reduce((s, v) => s + v.returned_value, 0)),
    direct_qty: round3(views.reduce((s, v) => s + v.direct_qty, 0)),
    direct_value: round2(views.reduce((s, v) => s + v.direct_value, 0)),
    alternate_qty: round3(views.reduce((s, v) => s + v.alternate_qty, 0)),
    alternate_value: round2(views.reduce((s, v) => s + v.alternate_value, 0)),
    approaching: views.filter(v => v.status === 'approaching').length,
    overdue: views.filter(v => v.status === 'overdue').length,
    returned_late: views.filter(v => v.status === 'returned_late').length,
    deemed_qty: round3(views.reduce((s, v) => s + v.deemed_qty, 0)),
    deemed_value: round2(views.reduce((s, v) => s + v.deemed_value, 0)),
    indicative_tax: round2(views.reduce((s, v) => s + v.indicative_tax, 0)),
    oldest_open_days: open.reduce((m, v) => Math.max(m, v.days_out ?? 0), 0),
    by_category: byCategory.filter(c => c.lots > 0),
  }
}

// ── The ITC-04 statement ─────────────────────────────────────────────────────

export interface Itc04Period {
  key: string
  /** "Q2 Apr–Jun 2026" / "Half-year Apr–Sep 2026" / "FY 2026-27". */
  label: string
  start: string
  end: string
  due: string
  cadence: 'half-yearly' | 'annual'
  /** Days left to file on `today`; negative once the 25th has passed. */
  days_left: number | null
}

/**
 * The filing rhythm the statement runs on. Above ₹5 crore aggregate turnover it is
 * half-yearly — April–September by 25 October, October–March by 25 April — which is the
 * cadence that replaced the original quarterly one from 1 October 2021. At or below the
 * limit a registered person gives an annual statement from FY 2022-23, by 25 April.
 */
export function itc04Periods(fyStart: number, turnoverCr: number): Itc04Period[] {
  const halfYearly = turnoverCr * 10000000 > ITC04_TURNOVER_LIMIT
  const nextYear = fyStart + 1
  if (!halfYearly) {
    return [period(fyStart, fyStart, 4, 1, nextYear, 3, 31, nextYear, 4, 25, 'annual', `FY ${fyStart}-${String(nextYear).slice(2)}`)]
  }
  return [
    period(fyStart, fyStart, 4, 1, fyStart, 9, 30, fyStart, 10, 25, 'half-yearly', `Apr–Sep ${fyStart}`),
    period(fyStart, fyStart, 10, 1, nextYear, 3, 31, nextYear, 4, 25, 'half-yearly', `Oct–Mar ${fyStart}-${String(nextYear).slice(2)}`),
  ]
}

function period(
  fy: number,
  sy: number, sm: number, sd: number,
  ey: number, em: number, ed: number,
  dy: number, dm: number, dd: number,
  cadence: 'half-yearly' | 'annual',
  label: string,
): Itc04Period {
  const pad = (n: number) => String(n).padStart(2, '0')
  const start = `${sy}-${pad(sm)}-${pad(sd)}`
  const end = `${ey}-${pad(em)}-${pad(ed)}`
  const due = `${dy}-${pad(dm)}-${pad(dd)}`
  return { key: `itc04:${fy}:${label}`, label, start, end, due, cadence, days_left: null }
}

/**
 * The period that is due next — the latest one that has already closed, even if its 25th
 * has gone past (a missed statement is still the statement to make). Looks back one FY so
 * that an April filing for the year just ended resolves.
 */
export function periodToReport(today: string, turnoverCr: number): Itc04Period | null {
  const p = parseISO(today)
  if (!p) return null
  const fyStart = p.m >= 4 ? p.y : p.y - 1
  const candidates = [...itc04Periods(fyStart, turnoverCr), ...itc04Periods(fyStart - 1, turnoverCr)]
    .filter(c => c.end <= today)
    .sort((a, b) => (a.end < b.end ? 1 : -1))
  const hit = candidates[0]
  if (!hit) return null
  return { ...hit, days_left: daysBetween(today, hit.due) }
}

/** Human answer to "do I file this half-yearly or once a year", with the reason printed. */
export function itc04Cadence(turnoverCr: number): { cadence: 'half-yearly' | 'annual'; label: string; basis: string } {
  const above = turnoverCr * 10000000 > ITC04_TURNOVER_LIMIT
  return above
    ? {
      cadence: 'half-yearly',
      label: 'Half-yearly',
      basis: `Aggregate turnover ₹${turnoverCr} crore is above the ₹5 crore limit, so the statement covers Apr–Sep by 25 October and Oct–Mar by 25 April.`,
    }
    : {
      cadence: 'annual',
      label: 'Annual',
      basis: `Aggregate turnover ₹${turnoverCr || 'not declared'} crore is at or below the ₹5 crore limit, so one statement for the year is due by 25 April after the year closes.`,
    }
}

export interface Itc04DetailRow {
  date: string
  /** Challan number for a send, the line's own ref (invoice / challan) for a movement back. */
  ref: string
  eway_bill_number: string
  hsn_sac: string
  item_name: string
  unit: string
  category: GoodsCategory
  qty: number
  value: number
  party: string
  party_gstin: string
  /** Only on the received-back grid: whether the period had run out when the goods landed. */
  within: boolean | null
  lot_id: string
}

export interface Itc04HsnRow {
  hsn_sac: string
  item_name: string
  unit: string
  categories: string
  sent_qty: number
  sent_value: number
  returned_qty: number
  returned_value: number
  direct_qty: number
  direct_value: number
  alternate_qty: number
  alternate_value: number
  /** As at the period close, over every lot sent before then — not just this period's rows. */
  outstanding_qty: number
  outstanding_value: number
}

export interface Itc04Statement {
  period: Itc04Period
  sent: Itc04DetailRow[]
  received: Itc04DetailRow[]
  direct: Itc04DetailRow[]
  alternate: Itc04DetailRow[]
  hsn: Itc04HsnRow[]
  totals: {
    sent_qty: number
    sent_value: number
    received_qty: number
    received_value: number
    direct_qty: number
    direct_value: number
    alternate_qty: number
    alternate_value: number
    outstanding_qty: number
    outstanding_value: number
    /** Deemed-supply exposure on everything still out past its period as at today. */
    deemed_qty: number
    deemed_value: number
    indicative_tax: number
  }
  /** Lots sent in the period with no HSN — the statement cannot place them on a code. */
  rows_without_hsn: number
  /** Goods still out with an unregistered worker — the statement names them without a GSTIN. */
  rows_without_gstin: number
}

const inPeriod = (date: string, p: Itc04Period): boolean => date >= p.start && date <= p.end

export function itc04Statement(views: JobView[], period: Itc04Period, today: string = todayISO()): Itc04Statement {
  const sent: Itc04DetailRow[] = []
  const received: Itc04DetailRow[] = []
  const direct: Itc04DetailRow[] = []
  const alternate: Itc04DetailRow[] = []

  for (const v of views) {
    if (inPeriod(v.lot.sent_date, period)) {
      sent.push({
        date: v.lot.sent_date,
        ref: v.lot.challan_number,
        eway_bill_number: v.lot.eway_bill_number,
        hsn_sac: v.lot.hsn_sac,
        item_name: v.lot.item_name,
        unit: v.lot.unit,
        category: v.lot.category,
        qty: v.sent_qty,
        value: v.sent_value,
        party: v.worker_name,
        party_gstin: v.worker_gstin,
        within: null,
        lot_id: v.lot.id,
      })
    }
    for (const line of v.lines) {
      if (!inPeriod(line.disposition.date, period)) continue
      const row: Itc04DetailRow = {
        date: line.disposition.date,
        ref: line.disposition.ref || v.lot.challan_number,
        eway_bill_number: '',
        hsn_sac: v.lot.hsn_sac,
        item_name: v.lot.item_name,
        unit: v.lot.unit,
        category: v.lot.category,
        qty: line.disposition.qty,
        value: line.value,
        party: line.disposition.party_name || (line.disposition.kind === 'returned' ? v.worker_name : '—'),
        party_gstin: line.disposition.party_gstin || (line.disposition.kind === 'returned' ? v.worker_gstin : ''),
        within: line.within,
        lot_id: v.lot.id,
      }
      if (line.disposition.kind === 'returned') received.push(row)
      else if (line.disposition.kind === 'direct_delivery') direct.push(row)
      else alternate.push(row)
    }
  }

  // HSN summary. Sent/received/direct/alternate are this period's movements; the
  // outstanding column is the position as at the period close across every lot sent before it,
  // so a lot sent last year still shows its units as unreturned here.
  const byKey = new Map<string, Itc04HsnRow>()
  const nameSets = new Map<string, Set<string>>()
  const catSets = new Map<string, Set<string>>()
  const touch = (row: Itc04DetailRow): Itc04HsnRow => {
    const key = `${row.hsn_sac}|${row.unit.toUpperCase()}`
    let hit = byKey.get(key)
    if (!hit) {
      hit = {
        hsn_sac: row.hsn_sac,
        item_name: row.item_name,
        unit: row.unit,
        categories: '',
        sent_qty: 0, sent_value: 0,
        returned_qty: 0, returned_value: 0,
        direct_qty: 0, direct_value: 0,
        alternate_qty: 0, alternate_value: 0,
        outstanding_qty: 0, outstanding_value: 0,
      }
      byKey.set(key, hit)
      nameSets.set(key, new Set())
      catSets.set(key, new Set())
    }
    nameSets.get(key)?.add(row.item_name)
    catSets.get(key)?.add(CATEGORY_META[row.category].short)
    return hit
  }
  for (const row of sent) { const h = touch(row); h.sent_qty = round3(h.sent_qty + row.qty); h.sent_value = round2(h.sent_value + row.value) }
  for (const row of received) { const h = touch(row); h.returned_qty = round3(h.returned_qty + row.qty); h.returned_value = round2(h.returned_value + row.value) }
  for (const row of direct) { const h = touch(row); h.direct_qty = round3(h.direct_qty + row.qty); h.direct_value = round2(h.direct_value + row.value) }
  for (const row of alternate) { const h = touch(row); h.alternate_qty = round3(h.alternate_qty + row.qty); h.alternate_value = round2(h.alternate_value + row.value) }

  for (const v of views) {
    if (v.lot.sent_date > period.end) continue
    const key = `${v.lot.hsn_sac}|${v.lot.unit.toUpperCase()}`
    // A lot sent in an earlier period has no row inside this one, but its unreturned units
    // are still part of this statement's outstanding position — so the group is opened
    // from the lot itself rather than skipped for want of a row.
    const hit = byKey.get(key) || touch({
      date: v.lot.sent_date,
      ref: v.lot.challan_number,
      eway_bill_number: '',
      hsn_sac: v.lot.hsn_sac,
      item_name: v.lot.item_name,
      unit: v.lot.unit,
      category: v.lot.category,
      qty: 0,
      value: 0,
      party: v.worker_name,
      party_gstin: v.worker_gstin,
      within: null,
      lot_id: v.lot.id,
    })
    const returnedByThen = v.lines.filter(l => l.disposition.kind === 'returned' && l.disposition.date <= period.end).reduce((s, l) => s + l.disposition.qty, 0)
    const directByThen = v.lines.filter(l => l.disposition.kind === 'direct_delivery' && l.disposition.date <= period.end).reduce((s, l) => s + l.disposition.qty, 0)
    const altByThen = v.lines.filter(l => l.disposition.kind === 'alternate_worker' && l.disposition.date <= period.end).reduce((s, l) => s + l.disposition.qty, 0)
    const stillOut = round3(v.lot.qty - returnedByThen - directByThen - altByThen)
    if (stillOut > EPSILON) {
      hit.outstanding_qty = round3(hit.outstanding_qty + stillOut)
      hit.outstanding_value = round2(hit.outstanding_value + stillOut * unitValue(v.lot))
    }
    catSets.get(key)?.add(CATEGORY_META[v.lot.category].short)
  }

  const hsn = [...byKey.values()].map(row => {
    const key = `${row.hsn_sac}|${row.unit.toUpperCase()}`
    const names = [...(nameSets.get(key) || [])]
    const cats = [...(catSets.get(key) || [])]
    return {
      ...row,
      item_name: names.length <= 2 ? names.join(', ') : `${names[0]} +${names.length - 1} more`,
      categories: cats.join(' · '),
    }
  }).sort((a, b) => (a.hsn_sac === b.hsn_sac ? a.item_name.localeCompare(b.item_name) : a.hsn_sac < b.hsn_sac ? -1 : 1))

  const sum = (rows: Itc04DetailRow[], k: 'qty' | 'value'): number => rows.reduce((s, r) => s + r[k], 0)

  return {
    // The picker hands over a bare period; the statement stamps how far the filing day is,
    // because the page shows the countdown beside the grid it came from.
    period: { ...period, days_left: daysBetween(today, period.due) },
    sent: sent.sort((a, b) => (a.date < b.date ? -1 : 1)),
    received: received.sort((a, b) => (a.date < b.date ? -1 : 1)),
    direct: direct.sort((a, b) => (a.date < b.date ? -1 : 1)),
    alternate: alternate.sort((a, b) => (a.date < b.date ? -1 : 1)),
    hsn,
    totals: {
      sent_qty: round3(sum(sent, 'qty')),
      sent_value: round2(sum(sent, 'value')),
      received_qty: round3(sum(received, 'qty')),
      received_value: round2(sum(received, 'value')),
      direct_qty: round3(sum(direct, 'qty')),
      direct_value: round2(sum(direct, 'value')),
      alternate_qty: round3(sum(alternate, 'qty')),
      alternate_value: round2(sum(alternate, 'value')),
      outstanding_qty: round3(hsn.reduce((s, r) => s + r.outstanding_qty, 0)),
      outstanding_value: round2(hsn.reduce((s, r) => s + r.outstanding_value, 0)),
      deemed_qty: round3(views.reduce((s, v) => s + v.deemed_qty, 0)),
      deemed_value: round2(views.reduce((s, v) => s + v.deemed_value, 0)),
      indicative_tax: round2(views.reduce((s, v) => s + v.indicative_tax, 0)),
    },
    rows_without_hsn: sent.filter(r => !r.hsn_sac.trim()).length,
    rows_without_gstin: sent.filter(r => !r.party_gstin).length,
  }
}

/** Every period worth offering in a picker: this FY and the one before. */
export function itc04PeriodChoices(today: string, turnoverCr: number): Itc04Period[] {
  const p = parseISO(today)
  if (!p) return []
  const fyStart = p.m >= 4 ? p.y : p.y - 1
  return [...itc04Periods(fyStart - 1, turnoverCr), ...itc04Periods(fyStart, turnoverCr)].reverse()
}

// ── CSV ──────────────────────────────────────────────────────────────────────

export const JOB_REGISTER_CSV_HEADERS = [
  'Sent date', 'Challan no.', 'Challan date', 'E-way bill', 'Item', 'HSN/SAC', 'Goods', 'Qty', 'Unit', 'Value',
  'Job worker', 'GSTIN', 'Period', 'Due back by', 'Days out', 'Returned', 'Direct delivery', 'To another worker',
  'Outstanding', 'Outstanding value', 'Status', 'Deemed qty', 'Deemed value', 'Deemed on', 'Notes',
]

export function jobRegisterCsvRows(views: JobView[]): (string | number)[][] {
  return views.map(v => [
    v.lot.sent_date, v.lot.challan_number, v.lot.challan_date, v.lot.eway_bill_number,
    v.lot.item_name, v.lot.hsn_sac, CATEGORY_META[v.lot.category].label, v.sent_qty, v.lot.unit, v.sent_value,
    v.worker_name, v.worker_gstin,
    v.period_months === null ? CATEGORY_META[v.lot.category].statutory_label : `${v.period_months} months`,
    v.deadline || '—', v.days_out ?? '—',
    v.returned_qty, v.direct_qty, v.alternate_qty, v.outstanding_qty, v.outstanding_value,
    v.status_label, v.deemed_qty || '', v.deemed_value || '', v.deemed_on || '', v.lot.notes,
  ])
}

export const ITC04_GRID_CSV_HEADERS = ['Grid', 'Date', 'Doc ref', 'E-way bill', 'HSN/SAC', 'Item', 'Goods', 'Qty', 'Unit', 'Value', 'Party', 'Party GSTIN', 'Within period']

export function itc04GridCsvRows(s: Itc04Statement): (string | number)[][] {
  const gridName = { sent: 'A — sent to job worker', received: 'B — received back', direct: 'C — delivered from job worker', alternate: 'D — sent to another job worker' } as const
  const rows = (list: Itc04DetailRow[], grid: keyof typeof gridName) => list.map(r => [
    gridName[grid], r.date, r.ref, r.eway_bill_number, r.hsn_sac, r.item_name, CATEGORY_META[r.category].label,
    r.qty, r.unit, r.value, r.party, r.party_gstin,
    r.within === null ? '' : r.within ? 'Yes' : 'No',
  ])
  return [
    ...rows(s.sent, 'sent'),
    ...rows(s.received, 'received'),
    ...rows(s.direct, 'direct'),
    ...rows(s.alternate, 'alternate'),
  ]
}

export const ITC04_HSN_CSV_HEADERS = ['HSN/SAC', 'Item', 'Unit', 'Goods', 'Sent qty', 'Sent value', 'Received qty', 'Received value', 'Direct qty', 'Direct value', 'To 2nd worker qty', 'To 2nd worker value', 'Outstanding at period end qty', 'Outstanding value']

export function itc04HsnCsvRows(s: Itc04Statement): (string | number)[][] {
  return s.hsn.map(r => [
    r.hsn_sac || '(no HSN recorded)', r.item_name, r.unit, r.categories,
    r.sent_qty, r.sent_value, r.returned_qty, r.returned_value,
    r.direct_qty, r.direct_value, r.alternate_qty, r.alternate_value,
    r.outstanding_qty, r.outstanding_value,
  ])
}

/** The lines a job worker would recognise — one row per movement of goods. */
export const JOB_MOVEMENT_CSV_HEADERS = ['Date', 'Lot', 'Challan no.', 'Item', 'Kind', 'Qty', 'Unit', 'Value', 'Party', 'Ref', 'Within period', 'Note']

export function jobMovementCsvRows(views: JobView[]): (string | number)[][] {
  return views.flatMap(v => v.lines.map(l => [
    l.disposition.date, v.lot.challan_number || v.lot.item_name, v.lot.challan_number, v.lot.item_name,
    DISPOSITION_META[l.disposition.kind].short, l.disposition.qty, v.lot.unit, l.value,
    l.disposition.party_name || v.worker_name, l.disposition.ref,
    l.within === null ? '' : l.within ? 'Yes' : 'No', l.disposition.note,
  ])).sort((a, b) => (String(a[0]) < String(b[0]) ? 1 : -1))
}

// ── Reuse of the challan register ────────────────────────────────────────────

/** The delivery-challan fields a job-work movement borrows, kept to what rule 55 needs. */
export interface ChallanRef {
  id: string
  number: string
  doc_date: string
  party_name: string
  party_gstin: string
  eway_bill_number: string
  vehicle_number: string
}

/**
 * Copy a /challans document onto a movement so the challan number and date are the
 * document's own — the statement then agrees with the paper that travelled with the goods.
 */
export function applyChallan(lot: JobLot, ch: ChallanRef): JobLot {
  return {
    ...lot,
    challan_ref: ch.id,
    challan_number: ch.number,
    challan_date: ch.doc_date,
    sent_date: lot.sent_date || ch.doc_date,
    worker_name: lot.worker_name || ch.party_name,
    eway_bill_number: lot.eway_bill_number || ch.eway_bill_number,
    vehicle_number: lot.vehicle_number || ch.vehicle_number,
  }
}
