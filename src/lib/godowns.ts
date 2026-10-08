// Multi-godown — which place each lot stands in, and moving stock between them.
//
// Rides on localStorage (ADR-013) for the same reason the batch register does:
// which godown a lot is sitting in is owner bookkeeping, and nothing in the
// statutory paper says so. The `warehouses` table has been in the schema since
// the MVP and has never been queried — its columns are not knowable from the
// app, and fixing that is Phase 14 dashboard work. So the registry lives here.
//
// Two decisions carry the honesty of the model:
//  * **Unplaced is not nowhere.** Every lot carries a `godown_id`, and a lot that
//    predates this feature (or was never placed) reads as the *Main godown* — the
//    seeded place that always exists and can never be archived. Nothing is
//    orphaned, and no migration is needed for stock already on the register.
//  * **A transfer is a split, not a shipment.** Moving part of a lot from A to B
//    takes those units off A's lot (a signed `transfer` movement) and opens a
//    lot at B carrying the *same identity* — same batch number, same mfg and
//    expiry, same cost — because "each receipt is its own lot" is already the
//    register's rule, and two places must not share one row's quantity.
//
// What v1 deliberately does NOT claim: `products.current_stock` is one org-wide
// number with no per-godown column, so the shelf-count page keeps reporting the
// whole business. Per-godown figures cover *registered lots* and say so.

import {
  loadMoves, newId, newMove, saveMoves, statusOf, todayISO, upsertBatch,
  type Batch, type BatchMove, type BatchView,
} from '@/lib/batches'

const KEY_GODOWNS = 'taxflow:godowns:'

/** The place that always exists: every unplaced lot reads as sitting here. */
export const GODOWN_MAIN = 'main'

export interface Godown {
  id: string
  name: string
  /** Short code as the business writes it — "MH-01", "Godown 2". */
  code: string
  address: string
  contact: string
  notes: string
  archived: boolean
  created_at: string
}

export function mainGodown(): Godown {
  return { id: GODOWN_MAIN, name: 'Main godown', code: '', address: '', contact: '', notes: '', archived: false, created_at: '' }
}

export function isMain(id: string): boolean {
  return !id || id === GODOWN_MAIN
}

export function newGodown(name = ''): Godown {
  return {
    id: newId(),
    name,
    code: '',
    address: '',
    contact: '',
    notes: '',
    archived: false,
    created_at: new Date().toISOString(),
  }
}

// ── Storage ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Tolerant parse — a hand-edited or half-written key must not crash a page. */
function parseGodowns(raw: string | null): Godown[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((v: unknown) => {
        if (!v || typeof v !== 'object') return null
        const o = v as Record<string, unknown>
        if (typeof o.id !== 'string' || !o.id) return null
        return {
          id: o.id,
          name: str(o.name),
          code: str(o.code),
          address: str(o.address),
          contact: str(o.contact),
          notes: str(o.notes),
          archived: o.archived === true,
          created_at: str(o.created_at),
        } satisfies Godown
      })
      // An id-less or name-less row is not a place — drop it rather than show it.
      .filter((g): g is Godown => g !== null && g.name.trim() !== '')
  } catch {
    return []
  }
}

/**
 * The Main godown is virtual until someone edits it: a stored row with that id
 * overrides the seed, so it can be renamed but never removed. Main always leads
 * the list — it is where unplaced stock lives.
 */
export function loadGodowns(orgId: string): Godown[] {
  if (typeof window === 'undefined' || !orgId) return [mainGodown()]
  let stored: Godown[] = []
  try {
    stored = parseGodowns(window.localStorage.getItem(KEY_GODOWNS + orgId))
  } catch {
    stored = []
  }
  const override = stored.find(g => g.id === GODOWN_MAIN)
  const rest = stored.filter(g => g.id !== GODOWN_MAIN)
  // `archived: false` is forced after the merge: Main can be renamed, never closed,
  // because unplaced lots have to resolve somewhere even in a hand-edited store.
  return [override ? { ...mainGodown(), ...override, archived: false } : mainGodown(), ...rest]
}

/** Persists every row, including an edited Main — the seed is never stored as-is. */
export function saveGodowns(orgId: string, godowns: Godown[]): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_GODOWNS + orgId, JSON.stringify(godowns))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

export function upsertGodown(orgId: string, godown: Godown): Godown[] {
  const list = loadGodowns(orgId)
  const clean: Godown = { ...godown, name: godown.name.trim(), code: godown.code.trim() }
  const idx = list.findIndex(g => g.id === clean.id)
  const next = idx >= 0 ? list.map((g, i) => (i === idx ? clean : g)) : [...list, clean]
  saveGodowns(orgId, reorder(next))
  return reorder(next)
}

/** Main first, then active places by name, then archived ones. */
export function reorder(list: Godown[]): Godown[] {
  return [...list].sort((a, b) => {
    if (a.id === GODOWN_MAIN) return -1
    if (b.id === GODOWN_MAIN) return 1
    if (a.archived !== b.archived) return a.archived ? 1 : -1
    return a.name.localeCompare(b.name)
  })
}

export function validateGodown(godown: Godown, all: Godown[]): string[] {
  const problems: string[] = []
  const name = godown.name.trim()
  if (!name) problems.push('Give the place a name')
  const clash = all.some(g => g.id !== godown.id && g.name.trim().toLowerCase() === name.toLowerCase())
  if (clash) problems.push(`A place called “${name}” already exists`)
  return problems
}

/**
 * Archive, never delete — a movement or a transferred-in lot may still point
 * here, and history must keep resolving to a named place. Refused while live
 * lots stand in it, because those units would lose their home.
 */
export function archiveGodown(orgId: string, id: string, liveAtPlace: number): Godown[] | string {
  if (id === GODOWN_MAIN) return 'The Main godown cannot be archived — unplaced lots are read as standing there.'
  if (liveAtPlace > 0) return `${liveAtPlace} lot${liveAtPlace === 1 ? '' : 's'} still hold${liveAtPlace === 1 ? 's' : ''} stock here — move them out or write them off first.`
  const list = loadGodowns(orgId)
  const next = list.map(g => (g.id === id ? { ...g, archived: true } : g))
  saveGodowns(orgId, reorder(next))
  return reorder(next)
}

export function unarchiveGodown(orgId: string, id: string): Godown[] {
  const next = loadGodowns(orgId).map(g => (g.id === id ? { ...g, archived: false } : g))
  saveGodowns(orgId, reorder(next))
  return reorder(next)
}

// ── Placement ────────────────────────────────────────────────────────────────

/** Which place a lot reads as standing in. Empty or unknown ids land at Main. */
export function godownOf(batch: Pick<Batch, 'godown_id'>, godowns: Godown[]): Godown {
  const hit = godowns.find(g => g.id === batch.godown_id)
  if (hit) return hit
  return godowns.find(g => g.id === GODOWN_MAIN) || mainGodown()
}

export function godownById(godowns: Godown[], id: string): Godown {
  return godowns.find(g => g.id === id) || godowns.find(g => g.id === GODOWN_MAIN) || mainGodown()
}

/**
 * The predicate `allocateFefo` takes to draw from one place only. Built here so
 * the batch engine never has to know what a godown is.
 */
export function lotFilter(godowns: Godown[], id: string): (b: Batch) => boolean {
  return b => godownOf(b, godowns).id === id
}

export interface GodownStock {
  godown: Godown
  lots: number
  liveLots: number
  items: number
  unitsLeft: number
  valueLeft: number
  /** Live lots past expiry. */
  expired: number
  /** Live lots expiring within the critical window. */
  critical: number
  /** Lots reading here only because they were never placed. */
  unplaced: number
}

/** Per-place figures derived from the lot register — nothing is stored twice. */
export function godownStock(godowns: Godown[], views: BatchView[], today: string): GodownStock[] {
  return godowns.map(godown => {
    const mine = views.filter(v => godownOf(v, godowns).id === godown.id)
    const live = mine.filter(v => v.left > 0)
    return {
      godown,
      lots: mine.length,
      liveLots: live.length,
      items: new Set(live.map(v => v.product_id || v.product_name)).size,
      unitsLeft: Math.round(live.reduce((s, v) => s + v.left, 0) * 1000) / 1000,
      valueLeft: Math.round(live.reduce((s, v) => s + v.value, 0) * 100) / 100,
      expired: live.filter(v => statusOf(v.expiry_date, today).status === 'expired').length,
      critical: live.filter(v => statusOf(v.expiry_date, today).status === 'critical').length,
      unplaced: mine.filter(v => isMain(godown.id) && !v.godown_id).length,
    }
  })
}

/** Live lots at one place, FEFO-ordered — the picker inside the transfer modal. */
export function lotsAt(views: BatchView[], godowns: Godown[], id: string): BatchView[] {
  return views.filter(v => v.left > 0 && godownOf(v, godowns).id === id)
}

// ── Transfers ────────────────────────────────────────────────────────────────

export interface TransferInput {
  /** The lot units leave — its own `godown_id` is the source of truth. */
  batch: Batch
  qty: number
  /** Destination place id. */
  toId: string
  date: string
  /** Vehicle / e-way bill / note ref, optional. */
  ref: string
  note: string
}

export interface TransferPlan {
  /** Signed-negative movement on the source lot. */
  out: BatchMove
  /** The new lot at the destination, carrying the source's identity. */
  lot: Batch
  /** What the source keeps afterwards. */
  sourceLeft: number
}

export function planTransfer(input: TransferInput, views: BatchView[], godowns: Godown[]): TransferPlan {
  const from = godownOf(input.batch, godowns)
  const to = godownById(godowns, input.toId)
  const view = views.find(v => v.id === input.batch.id)
  const left = view ? view.left : input.batch.qty
  const date = input.date || todayISO()
  const ref = input.ref.trim() || `TFR-${date.replace(/-/g, '')}`
  const lot: Batch = {
    ...input.batch,
    id: newId(),
    // The transferred quantity is this lot's whole receipt at the new place.
    qty: input.qty,
    godown_id: to.id,
    received_date: date,
    notes: [
      `Transferred in from ${from.name} (${input.batch.batch_no || 'lot'}) on ${date}`,
      input.note.trim(),
    ].filter(Boolean).join(' — '),
    created_at: new Date().toISOString(),
  }
  return {
    out: newMove(input.batch.id, -input.qty, date, 'transfer', ref, `→ ${to.name}`),
    lot,
    sourceLeft: Math.round((left - input.qty) * 1000) / 1000,
  }
}

/**
 * Everything the human needs to be told before a transfer is written. Returns
 * the plan when the move is legal, or the reason it is not.
 */
export function validateTransfer(
  input: TransferInput,
  views: BatchView[],
  godowns: Godown[],
): { ok: true; plan: TransferPlan } | { ok: false; error: string } {
  const qty = Number(input.qty)
  const view = views.find(v => v.id === input.batch.id)
  // An unselected picker row (no id) or an anonymous lot is a human asking to move
  // nothing; a lot with an id the register no longer has is a different answer.
  if (!input.batch.id || (!input.batch.batch_no.trim() && !input.batch.product_name.trim())) {
    return { ok: false, error: 'Pick a registered lot to move' }
  }
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, error: 'Quantity must be more than zero' }
  if (!input.toId) return { ok: false, error: 'Pick the place the stock is going to' }
  const from = godownOf(input.batch, godowns)
  if (from.id === input.toId) return { ok: false, error: 'The stock is already in that godown' }
  const to = godowns.find(g => g.id === input.toId)
  if (to?.archived) return { ok: false, error: `${to.name} is archived — open it again before moving stock in` }
  if (!view) return { ok: false, error: 'That lot is no longer on the register' }
  if (view.left <= 0) return { ok: false, error: `Lot ${view.batch_no || view.product_name} has nothing left to move` }
  if (qty > view.left) {
    return { ok: false, error: `Only ${view.left} ${view.unit || 'units'} left in lot ${view.batch_no || view.product_name}` }
  }
  return { ok: true, plan: planTransfer({ ...input, qty }, views, godowns) }
}

/**
 * Writes both legs — the movement off the source lot and the new lot at the
 * destination — in one pass so a half-saved transfer cannot exist.
 */
export function recordTransfer(
  orgId: string,
  input: TransferInput,
  views: BatchView[],
  godowns: Godown[],
): { ok: true; batches: Batch[]; moves: BatchMove[]; plan: TransferPlan } | { ok: false; error: string } {
  if (typeof window === 'undefined' || !orgId) return { ok: false, error: 'No organisation loaded' }
  const checked = validateTransfer(input, views, godowns)
  if (!checked.ok) return checked
  // upsertBatch replaces when the id exists and appends when it does not — a
  // transferred-in lot is always new, so this is one save for the whole leg in.
  const batches = upsertBatch(orgId, checked.plan.lot)
  const moves = [...loadMoves(orgId), checked.plan.out]
  saveMoves(orgId, moves)
  return { ok: true, batches, moves, plan: checked.plan }
}

// ── History + export ─────────────────────────────────────────────────────────

export interface TransferRow {
  date: string
  ref: string
  product: string
  batch_no: string
  qty: number
  unit: string
  from: string
  to: string
}

/** The transfer log, read back out of the movements — never stored separately. */
export function transferHistory(moves: BatchMove[], batches: Batch[], godowns: Godown[]): TransferRow[] {
  const byId = new Map(batches.map(b => [b.id, b]))
  return moves
    .filter(m => m.kind === 'transfer' && m.qty < 0)
    .map(m => {
      const batch = byId.get(m.batch_id)
      const from = batch ? godownOf(batch, godowns).name : 'Unknown place'
      // The destination was written into the movement note when it happened.
      const to = m.note.startsWith('→ ') ? m.note.slice(2) : 'Unknown place'
      return {
        date: m.date,
        ref: m.doc_ref,
        product: batch?.product_name || 'Unknown item',
        batch_no: batch?.batch_no || '—',
        qty: -m.qty,
        unit: batch?.unit || '',
        from,
        to,
      }
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export const GODOWN_CSV_HEADERS = [
  'Godown', 'Code', 'Status', 'Lots', 'Live lots', 'Items', 'Units left', 'Value left',
  'Expired lots', 'Expiring soon', 'Never placed',
]

export function godownCsvRows(stock: GodownStock[]): (string | number)[][] {
  return stock.map(s => [
    s.godown.name, s.godown.code, s.godown.archived ? 'Archived' : 'Active',
    s.lots, s.liveLots, s.items, s.unitsLeft, s.valueLeft,
    s.expired, s.critical, s.unplaced,
  ])
}

export const TRANSFER_CSV_HEADERS = ['Date', 'Ref', 'Item', 'Batch no.', 'Qty', 'Unit', 'From', 'To']

export function transferCsvRows(rows: TransferRow[]): (string | number)[][] {
  return rows.map(r => [r.date, r.ref, r.product, r.batch_no, r.qty, r.unit, r.from, r.to])
}
