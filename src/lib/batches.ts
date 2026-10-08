// Batch & expiry register — the lots received, what has left them, and what is
// about to go bad.
//
// Rides on localStorage (ADR-013): the schema is hand-managed in the Supabase
// dashboard, and a batch is owner bookkeeping the statutory documents do not
// carry — an invoice records quantities, never lot numbers. So the register
// follows the documents instead of the other way round:
//  * Every receipt is its own lot. The same batch number legitimately arrives
//    again later, so lots are rows, not merges.
//  * Consumption is FEFO — first expiry, first out. Dated lots sort by expiry;
//    undated lots (hardware, apparel) queue behind the dated ones by receipt.
//  * Sales billed in the app draw lots down through recordSale(), called from
//    the single invoice write path; everything else is adjusted by hand.
// A lot still counts for the whole day printed on it — it is expired the day
// after that date (daysLeft < 0), which is how an "Exp 08/2026" pack is read.

const KEY_BATCHES = 'taxflow:batches:'
const KEY_MOVES = 'taxflow:batchmoves:'

export const EXPIRY_CRITICAL_DAYS = 30
export const EXPIRY_SOON_DAYS = 90

export interface Batch {
  id: string
  /** products.id when the lot was booked against a listed item — the link that makes FEFO automatic. */
  product_id: string | null
  product_name: string
  sku: string
  unit: string
  batch_no: string
  /** '' when unknown. */
  mfg_date: string
  /** '' when the item does not perish. */
  expiry_date: string
  /** Received quantity, as booked. */
  qty: number
  /** Landed cost per unit; 0 = unknown. */
  cost: number
  vendor: string
  /** The purchase bill / GRN this lot arrived under, as printed on the source document. */
  bill_ref: string
  received_date: string
  notes: string
  created_at: string
}

/** Signed: negative leaves the lot (sale, damage), positive returns to it. */
export interface BatchMove {
  id: string
  batch_id: string
  date: string
  qty: number
  kind: 'sale' | 'adjust'
  /** Invoice number for 'sale' moves; free text for manual adjustments. */
  doc_ref: string
  note: string
  created_at: string
}

export type BatchStatus = 'expired' | 'critical' | 'soon' | 'ok' | 'no_expiry'

export interface BatchView extends Batch {
  /** Units that left the lot. */
  out: number
  /** Units returned to the lot. */
  back: number
  /** qty + back − out; can run negative only if a lot was edited badly, never by the UI. */
  left: number
  /** left × cost. */
  value: number
  /** Days from today to the expiry date; null when the lot has no expiry. */
  daysLeft: number | null
  status: BatchStatus
}

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  expired: 'Expired',
  critical: `≤ ${EXPIRY_CRITICAL_DAYS} days`,
  soon: `≤ ${EXPIRY_SOON_DAYS} days`,
  ok: 'OK',
  no_expiry: 'No expiry',
}

export const BATCH_STATUS_TONE: Record<BatchStatus, 'red' | 'amber' | 'blue' | 'green' | 'grey'> = {
  expired: 'red',
  critical: 'amber',
  soon: 'blue',
  ok: 'green',
  no_expiry: 'grey',
}

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Whole days from one ISO date to another; null when either is unreadable. */
export function daysBetween(fromISO: string, toISO: string): number | null {
  const a = Date.parse(`${fromISO}T00:00:00Z`)
  const b = Date.parse(`${toISO}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / 86400000)
}

export function statusOf(expiryDate: string, today: string): { status: BatchStatus; daysLeft: number | null } {
  if (!expiryDate) return { status: 'no_expiry', daysLeft: null }
  const daysLeft = daysBetween(today, expiryDate)
  if (daysLeft === null) return { status: 'no_expiry', daysLeft: null }
  if (daysLeft < 0) return { status: 'expired', daysLeft }
  if (daysLeft <= EXPIRY_CRITICAL_DAYS) return { status: 'critical', daysLeft }
  if (daysLeft <= EXPIRY_SOON_DAYS) return { status: 'soon', daysLeft }
  return { status: 'ok', daysLeft }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Tolerant parse — a hand-edited or half-written key must not crash a page. */
function parseList<T>(raw: string | null, shape: (v: Record<string, unknown>) => T | null): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map(v => (v && typeof v === 'object' ? shape(v as Record<string, unknown>) : null))
      .filter((x): x is T => x !== null)
  } catch {
    return []
  }
}

export function loadBatches(orgId: string): Batch[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseList<Batch>(window.localStorage.getItem(KEY_BATCHES + orgId), raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
      return {
        id: raw.id,
        product_id: typeof raw.product_id === 'string' && raw.product_id ? raw.product_id : null,
        product_name: String(raw.product_name ?? ''),
        sku: String(raw.sku ?? ''),
        unit: String(raw.unit ?? ''),
        batch_no: String(raw.batch_no ?? ''),
        mfg_date: String(raw.mfg_date ?? ''),
        expiry_date: String(raw.expiry_date ?? ''),
        qty: num(raw.qty),
        cost: num(raw.cost),
        vendor: String(raw.vendor ?? ''),
        bill_ref: String(raw.bill_ref ?? ''),
        received_date: String(raw.received_date ?? ''),
        notes: String(raw.notes ?? ''),
        created_at: String(raw.created_at ?? ''),
      }
    })
  } catch {
    return []
  }
}

export function saveBatches(orgId: string, batches: Batch[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_BATCHES + orgId, JSON.stringify(batches))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

export function loadMoves(orgId: string): BatchMove[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseList<BatchMove>(window.localStorage.getItem(KEY_MOVES + orgId), raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
      return {
        id: raw.id,
        batch_id: String(raw.batch_id ?? ''),
        date: String(raw.date ?? ''),
        qty: num(raw.qty),
        kind: raw.kind === 'sale' ? 'sale' : 'adjust',
        doc_ref: String(raw.doc_ref ?? ''),
        note: String(raw.note ?? ''),
        created_at: String(raw.created_at ?? ''),
      }
    })
  } catch {
    return []
  }
}

export function saveMoves(orgId: string, moves: BatchMove[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_MOVES + orgId, JSON.stringify(moves))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

export function newBatch(receivedDate = todayISO()): Batch {
  return {
    id: newId(),
    product_id: null,
    product_name: '',
    sku: '',
    unit: '',
    batch_no: '',
    mfg_date: '',
    expiry_date: '',
    qty: 0,
    cost: 0,
    vendor: '',
    bill_ref: '',
    received_date: receivedDate,
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newMove(batchId: string, qty: number, date: string, kind: BatchMove['kind'], docRef = '', note = ''): BatchMove {
  return { id: newId(), batch_id: batchId, date, qty, kind, doc_ref: docRef, note, created_at: new Date().toISOString() }
}

/** Insert or replace one lot; returns the next store contents. */
export function upsertBatch(orgId: string, batch: Batch): Batch[] {
  const batches = loadBatches(orgId)
  const idx = batches.findIndex(b => b.id === batch.id)
  const next = idx >= 0
    ? batches.map(b => (b.id === batch.id ? batch : b))
    : [...batches, batch]
  saveBatches(orgId, next)
  return next
}

/** Removes a lot along with its movements — an orphaned move has nothing to point at. */
export function deleteBatch(orgId: string, id: string): { batches: Batch[]; moves: BatchMove[] } {
  const batches = loadBatches(orgId).filter(b => b.id !== id)
  const moves = loadMoves(orgId).filter(m => m.batch_id !== id)
  saveBatches(orgId, batches)
  saveMoves(orgId, moves)
  return { batches, moves }
}

export function appendMoves(orgId: string, moves: BatchMove[]): BatchMove[] {
  const next = [...loadMoves(orgId), ...moves]
  saveMoves(orgId, next)
  return next
}

// ── Views ────────────────────────────────────────────────────────────────────

function netByBatch(moves: BatchMove[]): Map<string, { out: number; back: number }> {
  const map = new Map<string, { out: number; back: number }>()
  for (const m of moves) {
    if (!m.batch_id) continue
    const entry = map.get(m.batch_id) || { out: 0, back: 0 }
    if (m.qty < 0) entry.out += -m.qty
    else entry.back += m.qty
    map.set(m.batch_id, entry)
  }
  return map
}

export function viewOf(batch: Batch, net: { out: number; back: number }, today: string): BatchView {
  const left = Math.round((batch.qty + net.back - net.out) * 1000) / 1000
  const { status, daysLeft } = statusOf(batch.expiry_date, today)
  return {
    ...batch,
    out: Math.round(net.out * 1000) / 1000,
    back: Math.round(net.back * 1000) / 1000,
    left,
    value: Math.round(left * batch.cost * 100) / 100,
    daysLeft,
    status,
  }
}

/** FEFO: first expiry, first out — dated lots by expiry, then undated by receipt age. */
function fefoCompare(a: Batch, b: Batch): number {
  const aDated = Boolean(a.expiry_date)
  const bDated = Boolean(b.expiry_date)
  if (aDated !== bDated) return aDated ? -1 : 1
  if (aDated && a.expiry_date !== b.expiry_date) return a.expiry_date < b.expiry_date ? -1 : 1
  if (a.received_date !== b.received_date) return a.received_date < b.received_date ? -1 : 1
  return a.batch_no.localeCompare(b.batch_no) || a.id.localeCompare(b.id)
}

/** Live lots in FEFO order first; sold-out lots sink to the bottom, newest receipt first. */
export function sortViews(views: BatchView[]): BatchView[] {
  const live = views.filter(v => v.left > 0).sort(fefoCompare)
  const done = views.filter(v => v.left <= 0).sort((a, b) =>
    (a.received_date < b.received_date ? 1 : a.received_date > b.received_date ? -1 : 0) || fefoCompare(a, b))
  return [...live, ...done]
}

export function batchViews(batches: Batch[], moves: BatchMove[], today: string): BatchView[] {
  const net = netByBatch(moves)
  return sortViews(batches.map(b => viewOf(b, net.get(b.id) || { out: 0, back: 0 }, today)))
}

export function viewOfOne(batch: Batch, moves: BatchMove[], today: string): BatchView {
  const net = netByBatch(moves)
  return viewOf(batch, net.get(batch.id) || { out: 0, back: 0 }, today)
}

// ── FEFO allocation ──────────────────────────────────────────────────────────

export interface FefoPick {
  batch: Batch
  take: number
}

export interface Allocation {
  picks: FefoPick[]
  /** Quantity across the product's lots that is actually available. */
  covered: number
  /** Asked for minus covered. */
  shortfall: number
}

/**
 * Splits a demand of `qty` across a product's lots, first expiry first out.
 * Deliberately draws from expired lots too when they come first: if the units
 * physically left the shelf, that is the lot they left from — the register's
 * job is to record it, and the page flags that it happened.
 */
export function allocateFefo(
  batches: Batch[],
  moves: BatchMove[],
  productId: string,
  qty: number,
): Allocation {
  const wanted = Number(qty)
  if (!productId || !Number.isFinite(wanted) || wanted <= 0) return { picks: [], covered: 0, shortfall: 0 }
  const net = netByBatch(moves)
  const candidates = batches
    .filter(b => b.product_id === productId)
    .map(b => {
      const entry = net.get(b.id) || { out: 0, back: 0 }
      return { batch: b, left: Math.round((b.qty + entry.back - entry.out) * 1000) / 1000 }
    })
    .filter(x => x.left > 0)
    .sort((a, b) => fefoCompare(a.batch, b.batch))

  const picks: FefoPick[] = []
  let remaining = wanted
  for (const c of candidates) {
    if (remaining <= 0) break
    const take = Math.min(remaining, c.left)
    if (take <= 0) continue
    picks.push({ batch: c.batch, take: Math.round(take * 1000) / 1000 })
    remaining = Math.round((remaining - take) * 1000) / 1000
  }
  const covered = Math.round((wanted - remaining) * 1000) / 1000
  return { picks, covered, shortfall: Math.max(0, Math.round(remaining * 1000) / 1000) }
}

// ── The sales hook ───────────────────────────────────────────────────────────

export interface SaleLine {
  product_id: string | null
  quantity: number
}

export interface SaleResult {
  moves: BatchMove[]
  /** Product ids the invoice drew from, for a quick log line. */
  products: string[]
  uncovered: { productId: string; quantity: number }[]
}

/**
 * Called from the single invoice write path after the invoice is committed.
 * Never throws and never returns a failure — the register is bookkeeping the
 * sale does not depend on, so a missing batch (or a broken store) must not
 * surface as a save error. Lines are allocated against a running move list so
 * two lines of the same product cannot draw the same units twice.
 */
export function recordSale(
  orgId: string,
  lines: SaleLine[],
  docRef: string,
  date: string,
): SaleResult | null {
  try {
    if (typeof window === 'undefined' || !orgId) return null
    const batches = loadBatches(orgId)
    if (batches.length === 0) return null

    const tracked = new Set(batches.map(b => b.product_id).filter((id): id is string => Boolean(id)))
    let working = loadMoves(orgId)
    const fresh: BatchMove[] = []
    const products: string[] = []
    const uncovered: { productId: string; quantity: number }[] = []

    for (const line of lines) {
      const pid = line.product_id
      const qty = Number(line.quantity)
      if (!pid || !tracked.has(pid) || !Number.isFinite(qty) || qty <= 0) continue
      const alloc = allocateFefo(batches, working, pid, qty)
      for (const pick of alloc.picks) {
        const move = newMove(pick.batch.id, -pick.take, date, 'sale', docRef)
        fresh.push(move)
        working = [...working, move]
      }
      if (alloc.picks.length) products.push(pid)
      if (alloc.shortfall > 0) uncovered.push({ productId: pid, quantity: alloc.shortfall })
    }

    if (fresh.length === 0) return null
    saveMoves(orgId, working)
    return { moves: fresh, products, uncovered }
  } catch {
    return null
  }
}

// ── Validation, summary, export ──────────────────────────────────────────────

export function validateBatch(batch: Batch, batches: Batch[], moves: BatchMove[]): string[] {
  const problems: string[] = []
  const qty = Number(batch.qty)
  if (!batch.product_id) problems.push('Pick a listed item — a batch attaches to a product')
  if (!batch.batch_no.trim()) problems.push('Give the lot a batch number')
  if (!Number.isFinite(qty) || qty <= 0) problems.push('Received quantity must be more than zero')
  if (batch.mfg_date && batch.expiry_date && batch.expiry_date < batch.mfg_date) {
    problems.push('Expiry cannot fall before manufacture')
  }
  if (batch.received_date && batch.expiry_date && batch.expiry_date < batch.received_date) {
    problems.push('Expiry cannot fall before the receipt date')
  }
  if (!batch.received_date) problems.push('Receipt date is required')

  // Editing the received count below what has already left would leave a
  // negative shelf — the same trap products.current_stock was caught in once.
  const existing = batches.find(b => b.id === batch.id)
  if (existing) {
    let out = 0
    let back = 0
    for (const m of moves) {
      if (m.batch_id !== batch.id) continue
      if (m.qty < 0) out += -m.qty
      else back += m.qty
    }
    const floor = Math.max(0, Math.round((out - back) * 1000) / 1000)
    if (Number.isFinite(qty) && qty < floor) {
      problems.push(`${out} units have left this lot${back ? ` (${back} returned)` : ''} — the received count cannot go below ${floor}`)
    }
  }
  return problems
}

export interface BatchSummary {
  lots: number
  live: number
  items: number
  unitsLeft: number
  valueLeft: number
  expired: { count: number; value: number }
  d30: { count: number; value: number }
  d90: { count: number; value: number }
  noExpiry: { count: number; value: number }
  consumed: number
}

export function summarise(views: BatchView[]): BatchSummary {
  const live = views.filter(v => v.left > 0)
  const bucket = (status: BatchStatus) => {
    const rows = live.filter(v => v.status === status)
    return {
      count: rows.length,
      value: Math.round(rows.reduce((s, v) => s + v.value, 0) * 100) / 100,
    }
  }
  return {
    lots: views.length,
    live: live.length,
    items: new Set(live.map(v => v.product_id || v.product_name)).size,
    unitsLeft: Math.round(live.reduce((s, v) => s + v.left, 0) * 1000) / 1000,
    valueLeft: Math.round(live.reduce((s, v) => s + v.value, 0) * 100) / 100,
    expired: bucket('expired'),
    d30: bucket('critical'),
    d90: bucket('soon'),
    noExpiry: bucket('no_expiry'),
    consumed: views.length - live.length,
  }
}

export const BATCH_CSV_HEADERS = [
  'Item', 'SKU', 'Batch no.', 'Mfg date', 'Expiry', 'Days left', 'Status',
  'Received', 'Qty in', 'Qty out', 'Qty back', 'Left', 'Unit', 'Unit cost', 'Value left',
  'Vendor', 'Bill ref', 'Notes',
]

export function batchCsvRows(views: BatchView[]): (string | number)[][] {
  return views.map(v => [
    v.product_name, v.sku, v.batch_no, v.mfg_date, v.expiry_date,
    v.daysLeft ?? '', BATCH_STATUS_LABEL[v.status],
    v.received_date, v.qty, v.out, v.back, v.left, v.unit, v.cost, v.value,
    v.vendor, v.bill_ref, v.notes,
  ])
}
