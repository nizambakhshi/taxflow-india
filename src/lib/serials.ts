// Serial numbers — one row per physical unit, and the story of where it went.
//
// Rides on localStorage (ADR-013): the schema is hand-managed in the Supabase
// dashboard, and a serial is owner bookkeeping the statutory documents do not
// carry — an invoice line records a quantity, never *which* unit left. So the
// register follows the documents, on the same terms as the batch register:
//  * A serial is an identity, not a quantity. The same number never appears
//    twice; a return puts the unit back on the shelf (Return → Restock reuses
//    the row) instead of forking its history into a second one.
//  * Status is derived from the latest recorded event, never stored. The
//    register is a log — corrections are new events (Restock after Return),
//    not edits of the past.
//  * Warranty is derived too: sale date + warranty months, recomputed from
//    the latest sale. Nothing about the claims window is hand-kept.
// Unlike batches there is no automatic consumption hook: FEFO can name a lot,
// but only the seller knows which physical unit left, so units attach to an
// invoice through the Issue action instead of the invoice guessing.

const KEY_UNITS = 'taxflow:serials:'
const KEY_EVENTS = 'taxflow:serialevents:'

export interface SerialUnit {
  id: string
  /** products.id when the unit is booked against a listed item. */
  product_id: string | null
  product_name: string
  sku: string
  /** Our key for the unit — usually the number printed on the box or IMEI. */
  serial_no: string
  /** The vendor's own serial when it differs from ours; '' otherwise. */
  vendor_serial: string
  /** Landed cost of this unit; 0 = unknown. */
  cost: number
  vendor: string
  /** The purchase bill / GRN it arrived under, as printed on the source. */
  bill_ref: string
  received_date: string
  /** Warranty length in months counted from the sale date; 0 = none. */
  warranty_months: number
  notes: string
  created_at: string
}

export type SerialEventKind = 'received' | 'sold' | 'returned' | 'restocked' | 'scrapped'

/** The unit's log. The last entry recorded defines the current status. */
export interface SerialEvent {
  id: string
  serial_id: string
  date: string
  kind: SerialEventKind
  /** Invoice number for sales; free text otherwise. */
  doc_ref: string
  /** Buyer for sales, returned-by for returns. */
  party: string
  note: string
  created_at: string
}

export type SerialStatus = 'in_stock' | 'sold' | 'returned' | 'scrapped'

export interface SerialView extends SerialUnit {
  status: SerialStatus
  /** Date of the latest recorded event; '' when the store lost the log. */
  last_date: string
  /** The latest sale, kept even after a return — it is the unit's history. */
  sold_date: string
  sold_to: string
  sold_ref: string
  /** sale date + warranty months; '' when never sold or warranty 0. */
  warranty_till: string
  /** Days from today to warranty_till; null when there is no warranty date. */
  warranty_days: number | null
}

export const SERIAL_STATUS_LABEL: Record<SerialStatus, string> = {
  in_stock: 'In stock',
  sold: 'Sold',
  returned: 'Returned',
  scrapped: 'Scrapped',
}

export const SERIAL_STATUS_TONE: Record<SerialStatus, 'red' | 'amber' | 'blue' | 'green' | 'grey'> = {
  in_stock: 'blue',
  sold: 'green',
  returned: 'amber',
  scrapped: 'grey',
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

/** ISO date + n months, day clamped to the shorter month; '' on bad input. */
export function addMonths(iso: string, months: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m || !Number.isFinite(months) || months <= 0) return ''
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return ''
  const base = new Date(Date.UTC(y, mo - 1 + months, 1))
  const lastDay = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate()
  const day = Math.min(d, lastDay)
  return `${base.getUTCFullYear()}-${String(base.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Status from the latest recorded event; received and restocked both mean on the shelf. */
export function statusOf(last: SerialEvent | undefined): SerialStatus {
  if (!last) return 'in_stock'
  if (last.kind === 'sold') return 'sold'
  if (last.kind === 'returned') return 'returned'
  if (last.kind === 'scrapped') return 'scrapped'
  return 'in_stock'
}

/** The moves each status allows — the register's state machine. */
const NEXT: Record<SerialStatus, SerialEventKind[]> = {
  in_stock: ['sold', 'scrapped'],
  sold: ['returned'],
  returned: ['restocked', 'scrapped'],
  scrapped: [],
}

export function canMove(status: SerialStatus, kind: SerialEventKind): boolean {
  return NEXT[status].includes(kind)
}

// ── Storage ──────────────────────────────────────────────────────────────────

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const EVENT_KINDS: SerialEventKind[] = ['received', 'sold', 'returned', 'restocked', 'scrapped']

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

export function loadUnits(orgId: string): SerialUnit[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseList<SerialUnit>(window.localStorage.getItem(KEY_UNITS + orgId), raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
      return {
        id: raw.id,
        product_id: typeof raw.product_id === 'string' && raw.product_id ? raw.product_id : null,
        product_name: String(raw.product_name ?? ''),
        sku: String(raw.sku ?? ''),
        serial_no: String(raw.serial_no ?? ''),
        vendor_serial: String(raw.vendor_serial ?? ''),
        cost: num(raw.cost),
        vendor: String(raw.vendor ?? ''),
        bill_ref: String(raw.bill_ref ?? ''),
        received_date: String(raw.received_date ?? ''),
        warranty_months: num(raw.warranty_months),
        notes: String(raw.notes ?? ''),
        created_at: String(raw.created_at ?? ''),
      }
    })
  } catch {
    return []
  }
}

export function saveUnits(orgId: string, units: SerialUnit[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_UNITS + orgId, JSON.stringify(units))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

export function loadEvents(orgId: string): SerialEvent[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseList<SerialEvent>(window.localStorage.getItem(KEY_EVENTS + orgId), raw => {
      if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
      const kind = EVENT_KINDS.includes(raw.kind as SerialEventKind) ? raw.kind as SerialEventKind : 'received'
      return {
        id: raw.id,
        serial_id: String(raw.serial_id ?? ''),
        date: String(raw.date ?? ''),
        kind,
        doc_ref: String(raw.doc_ref ?? ''),
        party: String(raw.party ?? ''),
        note: String(raw.note ?? ''),
        created_at: String(raw.created_at ?? ''),
      }
    })
  } catch {
    return []
  }
}

export function saveEvents(orgId: string, events: SerialEvent[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_EVENTS + orgId, JSON.stringify(events))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

// ── Construction ─────────────────────────────────────────────────────────────

export function newUnit(receivedDate = todayISO()): SerialUnit {
  return {
    id: newId(),
    product_id: null,
    product_name: '',
    sku: '',
    serial_no: '',
    vendor_serial: '',
    cost: 0,
    vendor: '',
    bill_ref: '',
    received_date: receivedDate,
    warranty_months: 0,
    notes: '',
    created_at: new Date().toISOString(),
  }
}

export function newEvent(
  serialId: string,
  kind: SerialEventKind,
  date: string,
  docRef = '',
  party = '',
  note = '',
): SerialEvent {
  return {
    id: newId(),
    serial_id: serialId,
    date,
    kind,
    doc_ref: docRef,
    party,
    note,
    created_at: new Date().toISOString(),
  }
}

export interface ReceiveCommon {
  received_date: string
  cost: number
  vendor: string
  bill_ref: string
  warranty_months: number
  notes: string
}

/**
 * Books a batch of serial numbers against one product in a single write: the
 * units and their arrival events together, so a unit can never exist without
 * its birth in the log.
 */
export function receiveUnits(
  orgId: string,
  product: { id: string; name: string; sku?: string | null },
  serials: string[],
  common: ReceiveCommon,
): SerialUnit[] {
  if (typeof window === 'undefined' || !orgId) return []
  const clean = serials.map(s => s.trim()).filter(Boolean)
  if (clean.length === 0) return []
  const units = clean.map(serial => {
    const u = newUnit(common.received_date || todayISO())
    u.product_id = product.id
    u.product_name = product.name
    u.sku = product.sku || ''
    u.serial_no = serial
    u.cost = num(common.cost)
    u.vendor = common.vendor
    u.bill_ref = common.bill_ref
    u.warranty_months = Math.max(0, num(common.warranty_months))
    u.notes = common.notes
    return u
  })
  const nextUnits = [...loadUnits(orgId), ...units]
  const nextEvents = [...loadEvents(orgId), ...units.map(u => newEvent(u.id, 'received', u.received_date))]
  saveUnits(orgId, nextUnits)
  saveEvents(orgId, nextEvents)
  return units
}

/** Insert or replace one unit; returns the next store contents. */
export function upsertUnit(orgId: string, unit: SerialUnit): SerialUnit[] {
  const units = loadUnits(orgId)
  const idx = units.findIndex(u => u.id === unit.id)
  const next = idx >= 0 ? units.map(u => (u.id === unit.id ? unit : u)) : [...units, unit]
  saveUnits(orgId, next)
  return next
}

/** True when the unit has left the shelf at least once — its identity is on record. */
export function hasHistory(events: SerialEvent[], id: string): boolean {
  return events.some(e => e.serial_id === id && e.kind !== 'received')
}

/**
 * Removes a unit along with its log — but only a unit that never moved.
 * Once a sale exists, the row is a record of who had the unit; scrapping is
 * the honest exit, deletion would erase the trace.
 */
export function deleteUnit(orgId: string, id: string): { units: SerialUnit[]; events: SerialEvent[] } | null {
  const events = loadEvents(orgId)
  if (hasHistory(events, id)) return null
  const units = loadUnits(orgId).filter(u => u.id !== id)
  const nextEvents = events.filter(e => e.serial_id !== id)
  saveUnits(orgId, units)
  saveEvents(orgId, nextEvents)
  return { units, events: nextEvents }
}

export function appendEvents(orgId: string, events: SerialEvent[]): SerialEvent[] {
  const next = [...loadEvents(orgId), ...events]
  saveEvents(orgId, next)
  return next
}

/** The single-event convenience the page's actions use. */
export function recordEvent(
  orgId: string,
  unitId: string,
  kind: SerialEventKind,
  date: string,
  docRef = '',
  party = '',
  note = '',
): SerialEvent[] {
  return appendEvents(orgId, [newEvent(unitId, kind, date, docRef, party, note)])
}

// ── Views ────────────────────────────────────────────────────────────────────

function lastOf(events: SerialEvent[], id: string, kind?: SerialEventKind): SerialEvent | undefined {
  let found: SerialEvent | undefined
  for (const e of events) {
    if (e.serial_id === id && (!kind || e.kind === kind)) found = e
  }
  return found
}

export function viewOf(unit: SerialUnit, events: SerialEvent[], today: string): SerialView {
  const last = lastOf(events, unit.id)
  const sold = lastOf(events, unit.id, 'sold')
  const soldDate = sold?.date ?? ''
  const warrantyTill = sold && unit.warranty_months > 0 ? addMonths(soldDate, unit.warranty_months) : ''
  return {
    ...unit,
    status: statusOf(last),
    last_date: last?.date ?? '',
    sold_date: soldDate,
    sold_to: sold?.party ?? '',
    sold_ref: sold?.doc_ref ?? '',
    warranty_till: warrantyTill,
    warranty_days: warrantyTill ? daysBetween(today, warrantyTill) : null,
  }
}

const TIER: Record<SerialStatus, number> = { in_stock: 0, returned: 1, sold: 2, scrapped: 3 }

/** Stock first for the shelf, decisions next, history last — newest history on top. */
export function sortViews(views: SerialView[]): SerialView[] {
  return [...views].sort((a, b) => {
    const tier = TIER[a.status] - TIER[b.status]
    if (tier) return tier
    if (a.status === 'in_stock' || a.status === 'returned') {
      // oldest first — the unit longest on the shelf (or awaiting a decision)
      if (a.last_date !== b.last_date) return a.last_date < b.last_date ? -1 : 1
      if (a.received_date !== b.received_date) return a.received_date < b.received_date ? -1 : 1
    } else {
      // sold / scrapped — newest event first
      if (a.last_date !== b.last_date) return a.last_date < b.last_date ? 1 : -1
    }
    return a.serial_no.localeCompare(b.serial_no) || a.id.localeCompare(b.id)
  })
}

export function serialViews(units: SerialUnit[], events: SerialEvent[], today: string): SerialView[] {
  return sortViews(units.map(u => viewOf(u, events, today)))
}

// ── Validation, summary, export ──────────────────────────────────────────────

/** Serials that collide with the register or repeat within the list; deduped. */
export function duplicateSerials(pending: string[], units: SerialUnit[], excludeId?: string): string[] {
  const seen = new Set<string>()
  const collisions: string[] = []
  const inRegister = new Set(
    units.filter(u => u.id !== excludeId).map(u => u.serial_no.trim().toLowerCase()).filter(Boolean),
  )
  for (const raw of pending) {
    const s = raw.trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (inRegister.has(key) || seen.has(key)) {
      if (!collisions.includes(s)) collisions.push(s)
    }
    seen.add(key)
  }
  return collisions
}

export function validateUnit(unit: SerialUnit, units: SerialUnit[], events: SerialEvent[]): string[] {
  const problems: string[] = []
  if (!unit.product_id) problems.push('Pick a listed item — a serial attaches to a product')
  const serial = unit.serial_no.trim()
  if (!serial) problems.push('Give the unit its serial number')
  else if (duplicateSerials([serial], units, unit.id).length > 0) {
    const twin = units.find(u => u.id !== unit.id && u.serial_no.trim().toLowerCase() === serial.toLowerCase())
    problems.push(`Serial ${serial} is already in the register${twin ? ` against ${twin.product_name || 'another item'}` : ''} — one unit, one row, forever`)
  }
  if (!unit.received_date) problems.push('Receipt date is required')
  if (num(unit.cost) < 0) problems.push('Cost cannot be negative')
  if (num(unit.warranty_months) < 0) problems.push('Warranty months cannot be negative')
  // Identity freezes once the unit has moved — only a unit that never left can
  // be re-pointed at another product.
  const stored = units.find(u => u.id === unit.id)
  if (stored && hasHistory(events, unit.id)) {
    if (unit.product_id !== stored.product_id) {
      problems.push('This unit has sold history — its item cannot be changed anymore')
    }
  }
  return problems
}

export interface SerialSummary {
  units: number
  inStock: number
  inStockValue: number
  sold: number
  returned: number
  scrapped: number
  /** Sold units whose warranty window is still open today. */
  onWarranty: number
}

export function summarise(views: SerialView[]): SerialSummary {
  const of = (s: SerialStatus) => views.filter(v => v.status === s)
  const inStock = of('in_stock')
  const sold = of('sold')
  const returned = of('returned')
  const scrapped = of('scrapped')
  return {
    units: views.length,
    inStock: inStock.length,
    inStockValue: Math.round(inStock.reduce((s, v) => s + v.cost, 0) * 100) / 100,
    sold: sold.length,
    returned: returned.length,
    scrapped: scrapped.length,
    onWarranty: sold.filter(v => v.warranty_days !== null && v.warranty_days >= 0).length,
  }
}

export const SERIAL_CSV_HEADERS = [
  'Item', 'SKU', 'Serial no.', 'Vendor serial', 'Status', 'Received', 'Vendor', 'Bill ref',
  'Unit cost', 'Sold on', 'Sold to', 'Invoice', 'Warranty till', 'Notes',
]

export function serialCsvRows(views: SerialView[]): (string | number)[][] {
  return views.map(v => [
    v.product_name, v.sku, v.serial_no, v.vendor_serial, SERIAL_STATUS_LABEL[v.status],
    v.received_date, v.vendor, v.bill_ref, v.cost, v.sold_date, v.sold_to, v.sold_ref,
    v.warranty_till, v.notes,
  ])
}
