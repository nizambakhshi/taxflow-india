// Delivery challans and orders — the documents around the invoice.
//
// They ride on localStorage (ADR-013): the schema is hand-managed in the
// Supabase dashboard and no `delivery_challans` / `sales_orders` tables exist.
// A challan is a movement document that travels with the goods; the invoice or
// bill it converts into is the durable, statutory record — conversion writes
// through the shared create paths, so the real sequence, the GST engine and
// the stock RPC all behave exactly as they do for a typed document.
//
// Numbering is a high-water mark per kind per financial year, stored next to
// the documents. A number is allocated when a document is first saved and is
// never reused — deleting a draft does not free its number, which is the
// honest behaviour for a statutory series.

import {
  calculateInvoiceTotals,
  calculateLineItem,
  type InvoiceTotals,
  type LineItemResult,
} from '@/lib/gst-engine'
import { stateNameFor } from '@/lib/einvoice'

export type FlowKind = 'challan' | 'sales_order' | 'purchase_order'

export type FlowStatus = 'draft' | 'active' | 'closed' | 'converted' | 'cancelled'

export type GstType = 'cgst_sgst' | 'igst'

export interface FlowLine {
  product_id: string | null
  item_name: string
  hsn_sac: string
  quantity: number
  unit: string
  rate: number
  discount_percent: number
  gst_rate: number
  cess_rate: number
}

export interface FlowDoc {
  id: string
  kind: FlowKind
  number: string
  doc_date: string
  due_date: string
  party_id: string | null
  party_name: string
  party_gstin: string
  party_address: string
  party_state: string
  place_of_supply: string
  supply_type: string
  /** Movement reason — challans only, see CHALLAN_REASONS. */
  reason: string
  vehicle_number: string
  transporter: string
  eway_bill_number: string
  lines: FlowLine[]
  status: FlowStatus
  notes: string
  created_at: string
  converted_to_id: string | null
  converted_to_number: string | null
  converted_at: string | null
}

/** docs + the per-kind, per-FY numbering high-water marks (`challan:2026-27` → 3). */
export interface FlowStore {
  docs: FlowDoc[]
  seq: Record<string, number>
}

// ── Kind metadata ────────────────────────────────────────────────────────────

export const KIND_META: Record<FlowKind, {
  prefix: string
  label: string
  plural: string
  listHref: string
  statusLabels: Record<FlowStatus, string>
}> = {
  challan: {
    prefix: 'DC',
    label: 'Delivery challan',
    plural: 'Delivery challans',
    listHref: '/challans',
    statusLabels: {
      draft: 'Draft', active: 'In transit', closed: 'Delivered',
      converted: 'Invoiced', cancelled: 'Cancelled',
    },
  },
  sales_order: {
    prefix: 'SO',
    label: 'Sales order',
    plural: 'Sales orders',
    listHref: '/sales-orders',
    statusLabels: {
      draft: 'Draft', active: 'Confirmed', closed: 'Fulfilled',
      converted: 'Invoiced', cancelled: 'Cancelled',
    },
  },
  purchase_order: {
    prefix: 'PO',
    label: 'Purchase order',
    plural: 'Purchase orders',
    listHref: '/purchase-orders',
    statusLabels: {
      draft: 'Draft', active: 'Placed', closed: 'Received',
      converted: 'Billed', cancelled: 'Cancelled',
    },
  },
}

export const ORDER_KINDS: FlowKind[] = ['challan', 'sales_order', 'purchase_order']

export const CHALLAN_REASONS: { value: string; label: string; note?: string }[] = [
  { value: 'approval', label: 'Supply on approval (sale or return)', note: 'Rule 55(4): sent to an agent on approval — treated as a supply if not returned within 6 months of delivery.' },
  { value: 'job-work', label: 'Job work' },
  { value: 'stock-transfer', label: 'Stock transfer (branch / agent)' },
  { value: 'repair', label: 'Repair or testing (returnable)' },
  { value: 'exhibition', label: 'Exhibition or demo' },
  { value: 'liquid-gas', label: 'Liquid gas (other than household LPG)' },
  { value: 'other', label: 'Other (say why in notes)' },
]

export function reasonLabel(value: string): string {
  return CHALLAN_REASONS.find(r => r.value === value)?.label ?? value
}

// ── Storage ──────────────────────────────────────────────────────────────────

const KEY_PREFIX: Record<FlowKind, string> = {
  challan: 'taxflow:challan:',
  sales_order: 'taxflow:sorder:',
  purchase_order: 'taxflow:porder:',
}

export function storeKey(kind: FlowKind, orgId: string): string {
  return KEY_PREFIX[kind] + orgId
}

export function emptyStore(): FlowStore {
  return { docs: [], seq: {} }
}

/** Tolerant parse — a hand-edited or half-written key must not crash a page. */
export function parseStore(raw: string | null): FlowStore {
  if (!raw) return emptyStore()
  try {
    const parsed = JSON.parse(raw) as Partial<FlowStore>
    const docs = Array.isArray(parsed.docs) ? parsed.docs.filter(d => d && typeof d === 'object') : []
    const seq = parsed.seq && typeof parsed.seq === 'object' ? parsed.seq : {}
    return { docs: docs as FlowDoc[], seq: seq as Record<string, number> }
  } catch {
    return emptyStore()
  }
}

export function loadStore(kind: FlowKind, orgId: string): FlowStore {
  if (typeof window === 'undefined') return emptyStore()
  return parseStore(window.localStorage.getItem(storeKey(kind, orgId)))
}

export function saveStore(kind: FlowKind, orgId: string, store: FlowStore): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(storeKey(kind, orgId), JSON.stringify(store))
}

/** Every kind's documents together, newest first — for registers and search. */
export function loadAllDocs(orgId: string): FlowDoc[] {
  return sortDocs(ORDER_KINDS.flatMap(k => loadStore(k, orgId).docs))
}

// ── Numbering ────────────────────────────────────────────────────────────────

function seqKey(kind: FlowKind, fy: string): string {
  return `${kind}:${fy}`
}

function maxUsedInDocs(store: FlowStore, kind: FlowKind, fy: string): number {
  const re = new RegExp(`^${KIND_META[kind].prefix}-${fy}-(\\d+)$`)
  let max = 0
  for (const d of store.docs) {
    if (d.kind !== kind) continue
    const m = re.exec(d.number)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return max
}

/** The number a new document will get — for the form preview, allocates nothing. */
export function peekNumber(store: FlowStore, kind: FlowKind, fy: string): string {
  const last = Math.max(store.seq[seqKey(kind, fy)] ?? 0, maxUsedInDocs(store, kind, fy))
  return `${KIND_META[kind].prefix}-${fy}-${String(last + 1).padStart(4, '0')}`
}

/**
 * Allocate the next number and return the store that records it. The caller
 * saves the returned store — the high-water mark only moves forward.
 */
export function takeNumber(store: FlowStore, kind: FlowKind, fy: string): { number: string; store: FlowStore } {
  const key = seqKey(kind, fy)
  const last = Math.max(store.seq[key] ?? 0, maxUsedInDocs(store, kind, fy))
  const next = last + 1
  return {
    number: `${KIND_META[kind].prefix}-${fy}-${String(next).padStart(4, '0')}`,
    store: { ...store, seq: { ...store.seq, [key]: next } },
  }
}

/**
 * Raise a saved draft through the register's own numbering.
 *
 * A planning page — the recipe board's shopping list, a shortage found at the counter — builds the
 * document it wants, hands it here, and writes the store it gets back. The number is *taken*, never
 * typed: two drafts raised on the same day get two numbers, and neither gets the one the other
 * already holds. `raiseDrafts` folds a list over one store so a board that sends four vendors four
 * orders makes one write, and every number inside it is still unique.
 */
export function appendDraft(
  kind: FlowKind,
  store: FlowStore,
  fy: string,
  doc: FlowDoc,
): { doc: FlowDoc; store: FlowStore } {
  const taken = takeNumber(store, kind, fy)
  const numbered: FlowDoc = { ...doc, kind, number: taken.number, status: 'draft' }
  return { doc: numbered, store: { ...taken.store, docs: [...taken.store.docs, numbered] } }
}

export function raiseDrafts(
  kind: FlowKind,
  store: FlowStore,
  fy: string,
  docs: FlowDoc[],
): { docs: FlowDoc[]; store: FlowStore } {
  const raised: FlowDoc[] = []
  let next = store
  for (const doc of docs) {
    const step = appendDraft(kind, next, fy, doc)
    next = step.store
    raised.push(step.doc)
  }
  return { docs: raised, store: next }
}

// ── Totals ───────────────────────────────────────────────────────────────────

export interface FlowTotals {
  results: LineItemResult[]
  totals: InvoiceTotals | null
}

/** Usable line = something to move: a name, a positive quantity, a rate ≥ 0. */
export function isUsableLine(line: FlowLine): boolean {
  return Boolean(line.item_name?.trim()) && Number(line.quantity) > 0 && Number(line.rate) >= 0
}

export function computeTotals(lines: FlowLine[], gstType: GstType): FlowTotals {
  const results = lines.filter(isUsableLine).map(line => calculateLineItem(
    {
      quantity: Number(line.quantity),
      rate: Number(line.rate),
      discount_percent: Number(line.discount_percent) || 0,
      gst_rate: Number(line.gst_rate) || 0,
      cess_rate: Number(line.cess_rate) || 0,
    },
    gstType,
  ))
  return { results, totals: results.length ? calculateInvoiceTotals(results) : null }
}

// ── Status flow ──────────────────────────────────────────────────────────────

const ADVANCE: Record<FlowKind, Partial<Record<FlowStatus, { to: FlowStatus; label: string }>>> = {
  challan: { draft: { to: 'active', label: 'Mark dispatched' }, active: { to: 'closed', label: 'Mark delivered' } },
  sales_order: { draft: { to: 'active', label: 'Confirm order' }, active: { to: 'closed', label: 'Mark fulfilled' } },
  purchase_order: { draft: { to: 'active', label: 'Mark placed' }, active: { to: 'closed', label: 'Mark received' } },
}

export function nextStatus(kind: FlowKind, status: FlowStatus): { to: FlowStatus; label: string } | null {
  return ADVANCE[kind][status] ?? null
}

export function canConvert(doc: FlowDoc): boolean {
  return doc.status === 'active' || doc.status === 'closed'
}

export function canCancel(doc: FlowDoc): boolean {
  return doc.status === 'draft' || doc.status === 'active' || doc.status === 'closed'
}

// ── Validation ───────────────────────────────────────────────────────────────

export function validateDoc(doc: Pick<FlowDoc, 'party_name' | 'place_of_supply' | 'lines' | 'reason' | 'kind'>): string[] {
  const errors: string[] = []
  if (!doc.party_name.trim()) errors.push('Choose or enter the party')
  if (!doc.place_of_supply) errors.push('Select the place of supply')
  if (doc.kind === 'challan' && !doc.reason) errors.push('Pick the reason for movement')
  if (!doc.lines.some(isUsableLine)) errors.push('Add at least one line with a name, quantity and rate')
  return errors
}

// ── Conversion ───────────────────────────────────────────────────────────────

/** Map a stored line + its engine result into the canonical invoice_items row. */
export function lineToItemFields(line: FlowLine, result: LineItemResult): Record<string, unknown> {
  return {
    product_id: line.product_id,
    item_name: line.item_name,
    hsn_sac: line.hsn_sac,
    quantity: Number(line.quantity),
    unit: line.unit,
    rate: Number(line.rate),
    discount_percent: Number(line.discount_percent) || 0,
    discount_amount: result.discount_amount,
    taxable_value: result.taxable_value,
    gst_rate: Number(line.gst_rate) || 0,
    cgst_rate: result.cgst_rate,
    sgst_rate: result.sgst_rate,
    igst_rate: result.igst_rate,
    cgst_amount: result.cgst_amount,
    sgst_amount: result.sgst_amount,
    igst_amount: result.igst_amount,
    cess_rate: Number(line.cess_rate) || 0,
    cess_amount: result.cess_amount,
    total_amount: result.total_amount,
  }
}

/**
 * The invoice header + items for createInvoice() when a document is converted.
 * Totals come from the same computeTotals() the screen showed, so the invoice
 * cannot disagree with the document it came from.
 */
export function buildInvoicePayload(
  doc: FlowDoc,
  computed: FlowTotals,
  invoiceDate: string,
): { invoiceFields: Record<string, unknown>; items: Record<string, unknown>[] } {
  const t = computed.totals
  if (!t) throw new Error('Nothing to invoice — the document has no usable lines')
  const items = doc.lines.filter(isUsableLine).map((line, idx) => lineToItemFields(line, computed.results[idx]))
  return {
    invoiceFields: {
      invoice_type: 'tax_invoice',
      invoice_date: invoiceDate,
      due_date: null,
      customer_id: doc.party_id,
      customer_name: doc.party_name,
      customer_gstin: doc.party_gstin,
      customer_address: doc.party_address,
      customer_state: stateNameFor(doc.party_state),
      customer_state_code: doc.party_state,
      place_of_supply: doc.place_of_supply,
      place_of_supply_name: stateNameFor(doc.place_of_supply),
      supply_type: doc.supply_type,
      is_reverse_charge: false,
      subtotal: t.subtotal,
      discount_amount: t.discount_amount,
      taxable_amount: t.taxable_amount,
      cgst_amount: t.cgst_amount,
      sgst_amount: t.sgst_amount,
      igst_amount: t.igst_amount,
      cess_amount: t.cess_amount,
      total_tax: t.total_tax,
      round_off: t.round_off,
      grand_total: t.grand_total,
      amount_paid: 0,
      balance_due: t.grand_total,
      payment_status: 'unpaid',
      notes: doc.notes,
      terms: '',
      status: 'sent',
    },
    items: items.map(item => ({ ...item })),
  }
}

/**
 * The bill header + items for createPurchaseBill() when a purchase order is
 * billed. The bill number is the vendor's, not ours — it is what GSTR-2B will
 * match against — so it is passed in rather than invented.
 */
export function buildBillPayload(
  doc: FlowDoc,
  computed: FlowTotals,
  billNumber: string,
  billDate: string,
): { billFields: Record<string, unknown>; items: Record<string, unknown>[] } {
  const t = computed.totals
  if (!t) throw new Error('Nothing to bill — the document has no usable lines')
  if (!billNumber.trim()) throw new Error("Record the vendor's bill number first")
  const items = doc.lines.filter(isUsableLine).map((line, idx) => ({
    ...lineToItemFields(line, computed.results[idx]),
    itc_eligible: true,
  }))
  return {
    billFields: {
      bill_number: billNumber.trim(),
      bill_date: billDate,
      due_date: doc.due_date || null,
      vendor_id: doc.party_id,
      vendor_name: doc.party_name,
      vendor_gstin: doc.party_gstin,
      vendor_state_code: doc.party_state,
      place_of_supply: doc.place_of_supply,
      place_of_supply_name: stateNameFor(doc.place_of_supply),
      is_reverse_charge: false,
      subtotal: t.subtotal,
      discount_amount: t.discount_amount,
      taxable_amount: t.taxable_amount,
      cgst_amount: t.cgst_amount,
      sgst_amount: t.sgst_amount,
      igst_amount: t.igst_amount,
      cess_amount: t.cess_amount,
      total_tax: t.total_tax,
      round_off: t.round_off,
      grand_total: t.grand_total,
      itc_eligible: true,
      amount_paid: 0,
      balance_due: t.grand_total,
      payment_status: 'unpaid',
      notes: doc.notes,
      status: 'active',
    },
    items,
  }
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

export function newDoc(kind: FlowKind, number: string, docDate: string): FlowDoc {
  return {
    id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind,
    number,
    doc_date: docDate,
    due_date: '',
    party_id: null,
    party_name: '',
    party_gstin: '',
    party_address: '',
    party_state: '',
    place_of_supply: '',
    supply_type: 'b2b',
    reason: kind === 'challan' ? 'approval' : '',
    vehicle_number: '',
    transporter: '',
    eway_bill_number: '',
    lines: [],
    status: 'draft',
    notes: '',
    created_at: new Date().toISOString(),
    converted_to_id: null,
    converted_to_number: null,
    converted_at: null,
  }
}

export function emptyLine(defaultGstRate = 18): FlowLine {
  return {
    product_id: null,
    item_name: '',
    hsn_sac: '',
    quantity: 1,
    unit: 'NOS',
    rate: 0,
    discount_percent: 0,
    gst_rate: defaultGstRate,
    cess_rate: 0,
  }
}

/** Newest first for the lists; stable on equal dates via created_at. */
export function sortDocs(docs: FlowDoc[]): FlowDoc[] {
  return [...docs].sort((a, b) => {
    if (a.doc_date !== b.doc_date) return a.doc_date < b.doc_date ? 1 : -1
    return a.created_at < b.created_at ? 1 : -1
  })
}

/** Sum of the taxable value across a document's usable lines. */
export function docValue(doc: FlowDoc): number {
  return computeTotals(doc.lines, 'cgst_sgst').totals?.taxable_amount ?? 0
}
