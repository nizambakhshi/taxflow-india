import { plural, pluralNoun } from '@/lib/format'
// Reorder planning: how much of each stocked product to buy, and when to buy it.
//
// Three domain decisions worth writing down:
//  * Demand is measured from invoice line quantities over a trailing window,
//    with credit-note lines subtracted. A return is not a sale, and counting
//    one would inflate the next purchase order.
//  * The reorder point is demand-during-lead-time plus safety stock, and the
//    order lifts stock to demand over (lead + cover) days plus that same
//    safety. That is the classic (s, S) policy — two numbers, both explainable.
//  * products.minimum_stock already exists, so it is treated as the owner's own
//    opinion about the level: when it is set we honour it and say so, when it is
//    zero we fall back to the computed point and label it as a suggestion.

export interface ReorderSettings {
  windowDays: number
  leadDays: number
  coverDays: number
  safetyFactor: number
  leadByProduct: Record<string, number>
}

export const DEFAULT_SETTINGS: ReorderSettings = {
  windowDays: 90,
  leadDays: 7,
  coverDays: 21,
  safetyFactor: 0.5,
  leadByProduct: {},
}

const SETTINGS_KEY = 'taxflow:reorder:'

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export function loadSettings(orgId: string): ReorderSettings {
  if (typeof window === 'undefined' || !orgId) return { ...DEFAULT_SETTINGS }
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY + orgId)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<ReorderSettings>
    return {
      windowDays: clampInt(parsed.windowDays, 7, 730, DEFAULT_SETTINGS.windowDays),
      leadDays: clampInt(parsed.leadDays, 0, 180, DEFAULT_SETTINGS.leadDays),
      coverDays: clampInt(parsed.coverDays, 0, 365, DEFAULT_SETTINGS.coverDays),
      safetyFactor: clampNum(parsed.safetyFactor, 0, 3, DEFAULT_SETTINGS.safetyFactor),
      leadByProduct: parsed.leadByProduct && typeof parsed.leadByProduct === 'object'
        ? Object.fromEntries(Object.entries(parsed.leadByProduct).map(([k, v]) => [k, clampInt(v, 0, 180, 0)]))
        : {},
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(orgId: string, settings: ReorderSettings): ReorderSettings {
  if (typeof window === 'undefined') return settings
  try {
    window.localStorage.setItem(SETTINGS_KEY + orgId, JSON.stringify(settings))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
  return settings
}

export interface ProductRow {
  id: string
  name: string
  sku?: string | null
  unit?: string | null
  track_inventory?: boolean | null
  current_stock?: number | null
  minimum_stock?: number | null
  purchase_price?: number | null
  selling_price?: number | null
}

/** Signed: credit-note lines arrive already negated. */
export interface DemandLine {
  productId: string
  quantity: number
}

export interface SupplyLine {
  productId: string
  quantity: number
  rate?: number | null
  date?: string | null
  vendorId?: string | null
  vendorName?: string | null
}

export type ReorderStatus = 'out-of-stock' | 'critical' | 'reorder' | 'watch' | 'ok' | 'overstock' | 'idle'

export interface ReorderRow {
  productId: string
  name: string
  sku: string
  unit: string
  onHand: number
  sold: number
  received: number
  daily: number
  daysOfCover: number | null
  leadDays: number
  safetyStock: number
  computedPoint: number
  ownerLevel: number
  reorderPoint: number
  targetStock: number
  usingOwnerLevel: boolean
  orderQty: number
  unitCost: number
  costEstimate: number
  stockValue: number
  lastVendor: string
  lastSupplyDate: string
  status: ReorderStatus
  reason: string
}

/** Units counted whole; anything measured is kept to two decimals. */
const MEASURED_UNITS = new Set([
  'kg', 'kgs', 'gm', 'gms', 'g', 'ml', 'ltr', 'ltrs', 'l', 'litre', 'litres',
  'meter', 'meters', 'm', 'cm', 'sqm', 'sq ft', 'feet', 'ft', 'kw', 'kwh',
  'bottle', 'carton', 'bag', 'ream', 'tonne', 'tons', 'hour', 'hrs',
])

export function roundQty(qty: number, unit: string): number {
  if (!Number.isFinite(qty) || qty <= 0) return 0
  const u = (unit || '').trim().toLowerCase()
  // Unknown units are assumed countable — most Indian stock is sold in pieces.
  if (u && MEASURED_UNITS.has(u)) return Math.round(qty * 100) / 100
  return Math.ceil(qty)
}

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function sumBy<T>(rows: T[], keyOf: (r: T) => string, valueOf: (r: T) => number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows) {
    const k = keyOf(row)
    if (!k) continue
    out[k] = (out[k] || 0) + valueOf(row)
  }
  return out
}

/** Most recent line wins — that is the rate and supplier a buyer would call. */
function latestBy<T extends { date?: string | null }>(rows: T[], keyOf: (r: T) => string): Record<string, T> {
  const out: Record<string, T> = {}
  for (const row of rows) {
    const k = keyOf(row)
    if (!k) continue
    const seen = out[k]
    if (!seen || (row.date || '') >= (seen.date || '')) out[k] = row
  }
  return out
}

export function buildRows(
  products: ProductRow[],
  demand: DemandLine[],
  supply: SupplyLine[],
  settings: ReorderSettings = DEFAULT_SETTINGS,
): ReorderRow[] {
  const sold = sumBy(demand, d => d.productId, d => d.quantity)
  const received = sumBy(supply, s => s.productId, s => s.quantity)
  const lastSupply = latestBy(supply, s => s.productId)
  const windowDays = Math.max(1, settings.windowDays)

  const rows: ReorderRow[] = []
  for (const p of products) {
    if (!p.track_inventory) continue

    const unit = (p.unit || '').trim()
    const onHand = num(p.current_stock)
    const net = num(sold[p.id])
    const daily = Math.max(0, net) / windowDays
    const leadDays = settings.leadByProduct[p.id] ?? settings.leadDays
    const safetyStock = roundQty(daily * leadDays * settings.safetyFactor, unit)
    const computedPoint = roundQty(daily * leadDays + safetyStock, unit)
    const ownerLevel = roundQty(num(p.minimum_stock), unit)
    const usingOwnerLevel = ownerLevel > 0
    const reorderPoint = usingOwnerLevel ? ownerLevel : computedPoint
    const targetStock = roundQty(daily * (leadDays + settings.coverDays) + safetyStock, unit)
    const last = lastSupply[p.id]
    const unitCost = num(last?.rate) || num(p.purchase_price)
    const toTarget = roundQty(Math.max(0, targetStock - onHand), unit)
    const daysOfCover = daily > 0 ? Math.round((onHand / daily) * 10) / 10 : null

    let status: ReorderStatus
    let reason: string
    if (daily <= 0) {
      if (onHand <= 0) {
        status = 'idle'
        reason = `No sales in the last ${plural(windowDays, 'day')} and nothing in stock — nothing to plan.`
      } else {
        status = 'idle'
        reason = `Sold nothing in ${plural(windowDays, 'day')} with ${fmtQty(onHand, unit)} on the shelf — this is dead stock, not a reorder.`
      }
    } else if (onHand <= 0) {
      status = 'out-of-stock'
      reason = `Stock is gone and it moves ${fmtQty(daily, unit)} a day — order ${fmtQty(toTarget, unit)} to get back to target.`
    } else if (daysOfCover !== null && daysOfCover <= leadDays) {
      status = 'critical'
      reason = `${daysOfCover} ${pluralNoun(daysOfCover, 'day')} of cover left against a ${leadDays}-day lead time — it will run out before a fresh order lands.`
    } else if (onHand <= reorderPoint) {
      status = 'reorder'
      reason = `At or below the ${fmtQty(reorderPoint, unit)} reorder point — order now to reach ${fmtQty(targetStock, unit)}.`
    } else if (onHand <= reorderPoint * 1.25) {
      status = 'watch'
      reason = `Within a quarter of the reorder point — worth ordering with the next supplier call.`
    } else if (daysOfCover !== null && daysOfCover > (leadDays + settings.coverDays) * 3) {
      status = 'overstock'
      reason = `${daysOfCover} ${pluralNoun(daysOfCover, 'day')} of cover is ${Math.round(daysOfCover / (leadDays + settings.coverDays))}x the target — buy nothing and let it drain.`
    } else {
      status = 'ok'
      reason = `Healthy: ${daysOfCover ?? '—'} days of cover against a ${leadDays + settings.coverDays}-day target.`
    }

    // Sitting between the reorder point and the target is not a reason to buy —
    // an (s, S) policy only lifts stock once it has reached s.
    const orderQty = status === 'out-of-stock' || status === 'critical' || status === 'reorder' || status === 'watch'
      ? toTarget
      : 0

    rows.push({
      productId: p.id,
      name: p.name,
      sku: p.sku || '',
      unit,
      onHand,
      sold: net,
      received: roundQty(received[p.id] || 0, unit),
      daily: Math.round(daily * 100) / 100,
      daysOfCover,
      leadDays,
      safetyStock,
      computedPoint,
      ownerLevel,
      reorderPoint,
      targetStock,
      usingOwnerLevel,
      orderQty,
      unitCost,
      costEstimate: Math.round(orderQty * unitCost * 100) / 100,
      stockValue: Math.round(onHand * unitCost * 100) / 100,
      lastVendor: last?.vendorName || '',
      lastSupplyDate: (last?.date || '').slice(0, 10),
      status,
      reason,
    })
  }

  const rank: Record<ReorderStatus, number> = {
    'out-of-stock': 0, critical: 1, reorder: 2, watch: 3, overstock: 4, idle: 5, ok: 6,
  }
  return rows.sort((a, b) =>
    rank[a.status] - rank[b.status]
    || b.costEstimate - a.costEstimate
    || a.name.localeCompare(b.name)
  )
}

export function fmtQty(n: number, unit: string): string {
  const v = Number.isInteger(n) ? n.toLocaleString('en-IN') : n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
  return `${v}${unit ? ` ${unit}` : ''}`
}

export interface ReorderSummary {
  tracked: number
  needsOrder: number
  unitsToBuy: number
  spend: number
  stockAtRisk: number
  deadStockCount: number
  deadStockValue: number
  overstockCount: number
  overstockValue: number
  daysCoverMedian: number | null
  shelfValue: number
}

export function summarise(rows: ReorderRow[]): ReorderSummary {
  const needs = rows.filter(r => r.orderQty > 0 && r.status !== 'idle')
  const dead = rows.filter(r => r.status === 'idle' && r.onHand > 0)
  const over = rows.filter(r => r.status === 'overstock')
  const covers = rows.filter(r => r.daysOfCover !== null).map(r => r.daysOfCover as number).sort((a, b) => a - b)
  const mid = covers.length ? covers[Math.floor((covers.length - 1) / 2)] : null
  return {
    tracked: rows.length,
    needsOrder: needs.length,
    unitsToBuy: Math.round(needs.reduce((s, r) => s + r.orderQty, 0) * 100) / 100,
    spend: Math.round(needs.reduce((s, r) => s + r.costEstimate, 0) * 100) / 100,
    stockAtRisk: rows.filter(r => r.status === 'out-of-stock' || r.status === 'critical').length,
    deadStockCount: dead.length,
    deadStockValue: Math.round(dead.reduce((s, r) => s + r.stockValue, 0) * 100) / 100,
    overstockCount: over.length,
    overstockValue: Math.round(over.reduce((s, r) => s + r.stockValue, 0) * 100) / 100,
    daysCoverMedian: mid,
    shelfValue: Math.round(rows.reduce((s, r) => s + r.stockValue, 0) * 100) / 100,
  }
}

export interface PurchaseOrderGroup {
  vendor: string
  rows: ReorderRow[]
  units: number
  value: number
}

/** Groups what needs buying by the supplier each product last came from. */
export function groupBySupplier(rows: ReorderRow[]): PurchaseOrderGroup[] {
  const map = new Map<string, PurchaseOrderGroup>()
  for (const r of rows) {
    if (r.orderQty <= 0 || r.status === 'idle') continue
    const vendor = r.lastVendor || 'New supplier'
    const key = vendor.toLowerCase()
    let group = map.get(key)
    if (!group) {
      group = { vendor, rows: [], units: 0, value: 0 }
      map.set(key, group)
    }
    group.rows.push(r)
    group.units = Math.round((group.units + r.orderQty) * 100) / 100
    group.value = Math.round((group.value + r.costEstimate) * 100) / 100
  }
  return [...map.values()].sort((a, b) => b.value - a.value || a.vendor.localeCompare(b.vendor))
}

export const PO_CSV_HEADERS = ['Supplier', 'Item', 'SKU', 'Unit', 'On hand', 'Sold in window', 'Order qty', 'Rate', 'Value']

export const PLAN_CSV_HEADERS = ['Item', 'SKU', 'Unit', 'On hand', 'Sold in window', 'Per day', 'Days of cover', 'Reorder point', 'Order qty', 'Rate', 'Est. value', 'Status']

export function planCsvRows(rows: ReorderRow[]): (string | number)[][] {
  return rows.map(r => [
    r.name, r.sku, r.unit, r.onHand, r.sold, r.daily,
    r.daysOfCover ?? '', r.reorderPoint, r.orderQty, r.unitCost, r.costEstimate, STATUS_LABEL[r.status],
  ])
}

export function poCsvRows(groups: PurchaseOrderGroup[]): (string | number)[][] {
  return groups.flatMap(g => g.rows.map(r => [
    g.vendor, r.name, r.sku, r.unit, r.onHand, r.sold, r.orderQty, r.unitCost, r.costEstimate,
  ]))
}

/** Plain text a buyer can paste into WhatsApp — the way small orders actually move. */
export function orderText(groups: PurchaseOrderGroup[], windowDays: number): string {
  return groups.map(g => {
    const lines = g.rows.map(r => `• ${fmtQty(r.orderQty, r.unit)} — ${r.name}${r.sku ? ` (${r.sku})` : ''}`)
    return `${g.vendor}\n${lines.join('\n')}\nEst. value ₹${Math.round(g.value).toLocaleString('en-IN')} · ${plural(g.rows.length, 'item')}`
  }).join('\n\n') + `\n\n(based on the last ${plural(windowDays, 'day')} of sales)`
}

export const STATUS_LABEL: Record<ReorderStatus, string> = {
  'out-of-stock': 'Out of stock',
  critical: 'Critical',
  reorder: 'Reorder now',
  watch: 'Watch',
  ok: 'Healthy',
  overstock: 'Overstocked',
  idle: 'No movement',
}

export const STATUS_TONE: Record<ReorderStatus, 'red' | 'amber' | 'green' | 'grey' | 'blue' | 'violet'> = {
  'out-of-stock': 'red',
  critical: 'red',
  reorder: 'amber',
  watch: 'blue',
  ok: 'green',
  overstock: 'violet',
  idle: 'grey',
}

/** Suggested reorder level for a product whose minimum_stock is unset or stale. */
export function levelSuggestion(row: ReorderRow): number | null {
  if (row.daily <= 0 || row.computedPoint <= 0) return null
  if (row.usingOwnerLevel && Math.abs(row.computedPoint - row.ownerLevel) < 0.005) return null
  return row.computedPoint
}
