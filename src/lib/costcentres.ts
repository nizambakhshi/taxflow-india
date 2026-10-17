// Cost centres — the dimension the statutory paper does not carry.
//
// A GST invoice has twenty-nine statutory columns and none of them is "which part of my
// business earned this". Every billing tool that advertises cost centres keeps them in its
// own ledger and prints them in its own reports; the Indian paper never sees them. So this
// register lives on localStorage (ADR-013, `taxflow:ccentres:<orgId>`) and holds *tags*, not
// money — which is the whole design decision, and the reason the numbers here cannot drift
// away from the books:
//
//  * **An allocation stores a share, never a rupee amount.** The rupees are re-read from the
//    invoice or bill every time the page opens. Change the bill at /bills tomorrow and the
//    centre's contribution changes with it; nothing here has to be re-entered, because nothing
//    here was ever entered.
//  * **A document is split, not moved.** Shares are percentages that must total 100 or less,
//    and whatever is left over is *unallocated* — printed as its own row, in rupees, on every
//    view. Σ(parts) + unallocated = the document, by construction: the parts are computed from
//    the share and the remainder is computed by subtraction, so the reconciliation cannot lose
//    a paisa to rounding.
//  * **A cost centre is not a legal person.** Nothing on this page reaches a return. The one
//    place a split of the business becomes a statutory question is a branch in another state
//    without its own GSTIN (rule 41A territory) or inputs used partly for something else
//    (rules 42/43, which the GSTR-9 workpaper already handles) — so those show up as a flag
//    with a link, never as a tax figure invented here.
//  * **The tag survives the document, and says so when the document does not.** An allocation
//    keeps the number and date it was made against; if that row is later deleted from the
//    books, the sheet stays on the register as an orphan rather than vanishing quietly.

import { newId, todayISO } from '@/lib/batches'
import { INDIAN_STATES, validateGSTIN } from '@/lib/constants'
import { plural } from '@/lib/format'

const KEY_CC = 'taxflow:ccentres:'
/** Today's shape. A stored envelope with a different version is read as empty, not guessed at. */
const CC_VERSION = 1

/** Shares are per cents of one document; 100.0001% is a mistake, not a rounding artefact. */
const PCT_EPSILON = 0.005

export function round2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

// ── the register ──────────────────────────────────────────────────────────────

export type CentreKind = 'cost_centre' | 'department' | 'project' | 'branch'

export interface KindMeta {
  label: string
  /** What choosing this kind actually means, in the user's terms. */
  note: string
  /** Whether the kind is a statutory question as well as a management one. */
  statutory: boolean
}

export const KIND_META: Record<CentreKind, KindMeta> = {
  cost_centre: {
    label: 'Cost centre',
    note: 'A place, a line or a unit you want costs and revenue split by.',
    statutory: false,
  },
  department: {
    label: 'Department',
    note: 'An internal team whose spending you want to see on its own.',
    statutory: false,
  },
  project: {
    label: 'Project / job',
    note: 'A piece of work with a start and an end — its own contribution, not the year’s.',
    statutory: false,
  },
  branch: {
    label: 'Branch / office',
    note: 'A place of business. If it is in another state and has no GSTIN of its own, rule 41A becomes a question to check.',
    statutory: true,
  },
}

export const CENTRE_KINDS = (Object.keys(KIND_META) as CentreKind[]).map(value => ({
  value,
  label: KIND_META[value].label,
  note: KIND_META[value].note,
}))

export function isCentreKind(v: unknown): v is CentreKind {
  return v === 'cost_centre' || v === 'department' || v === 'project' || v === 'branch'
}

export interface CostCentre {
  id: string
  name: string
  /** Short code as the business writes it — "CC-01", "MH-North". */
  code: string
  kind: CentreKind
  /** State code from INDIAN_STATES ('' = not recorded). */
  state: string
  /** Its own GSTIN, when the place is separately registered. */
  gstin: string
  notes: string
  archived: boolean
  created_at: string
}

export function newCentre(kind: CentreKind = 'cost_centre'): CostCentre {
  return {
    id: newId(),
    name: '',
    code: '',
    kind,
    state: '',
    gstin: '',
    notes: '',
    archived: false,
    created_at: new Date().toISOString(),
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

function normaliseGstin(raw: unknown): string {
  return str(raw).toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function stateLabel(code: string): string {
  if (!code) return ''
  return INDIAN_STATES.find(s => s.value === code)?.label || ''
}

// ── what can be tagged ────────────────────────────────────────────────────────

export type DocKind = 'invoice' | 'credit_note' | 'debit_note' | 'bill' | 'expense'

export interface DocKindMeta {
  label: string
  /** outward = money the business earned; inward = money it spent. */
  side: 'outward' | 'inward'
  /** How the party column should be labelled. */
  party: string
}

export const DOC_KIND_META: Record<DocKind, DocKindMeta> = {
  invoice: { label: 'Invoice', side: 'outward', party: 'Customer' },
  credit_note: { label: 'Credit note', side: 'outward', party: 'Customer' },
  debit_note: { label: 'Debit note', side: 'outward', party: 'Customer' },
  bill: { label: 'Purchase bill', side: 'inward', party: 'Vendor' },
  expense: { label: 'Expense', side: 'inward', party: 'Vendor' },
}

export const DOC_KINDS = (Object.keys(DOC_KIND_META) as DocKind[]).map(value => ({
  value,
  label: DOC_KIND_META[value].label,
}))

export function isDocKind(v: unknown): v is DocKind {
  return v === 'invoice' || v === 'credit_note' || v === 'debit_note' || v === 'bill' || v === 'expense'
}

/** A document reduced to the four numbers a centre can be given a share of. */
export interface BookDoc {
  kind: DocKind
  id: string
  number: string
  date: string
  party: string
  /** Taxable value, already signed — a credit note is negative revenue. */
  taxable: number
  tax: number
  total: number
  /** Input tax credit the business may claim: purchase side only. */
  itc: number
}

// The shapes the routes actually read out of Postgres. Kept structural so a page can pass
// whatever it selected without casting.

export interface RawInvoice {
  id: string
  invoice_number?: string | null
  invoice_date?: string | null
  customer_name?: string | null
  status?: string | null
  taxable_amount?: number | string | null
  total_tax?: number | string | null
  grand_total?: number | string | null
}

export interface RawNote {
  id: string
  credit_note_number?: string | null
  debit_note_number?: string | null
  credit_note_date?: string | null
  debit_note_date?: string | null
  customer_name?: string | null
  vendor_name?: string | null
  status?: string | null
  taxable_amount?: number | string | null
  total_tax?: number | string | null
  grand_total?: number | string | null
}

export interface RawBill {
  id: string
  bill_number?: string | null
  bill_date?: string | null
  vendor_name?: string | null
  status?: string | null
  taxable_amount?: number | string | null
  total_tax?: number | string | null
  grand_total?: number | string | null
  itc_eligible?: boolean | null
}

export interface RawExpense {
  id: string
  bill_number?: string | null
  expense_date?: string | null
  category?: string | null
  vendor_name?: string | null
  amount?: number | string | null
  taxable_amount?: number | string | null
  gst_amount?: number | string | null
  itc_eligible?: boolean | null
}

export interface BookInput {
  invoices?: RawInvoice[]
  credit_notes?: RawNote[]
  debit_notes?: RawNote[]
  bills?: RawBill[]
  expenses?: RawExpense[]
}

/** An expense is booked at its invoice value; the taxable split is what the GST row says. */
function expenseTaxable(e: RawExpense): number {
  const taxable = num(e.taxable_amount)
  if (taxable > 0) return taxable
  return round2(num(e.amount) - num(e.gst_amount))
}

function cancelled(status: unknown): boolean {
  return str(status).toLowerCase() === 'cancelled'
}

/**
 * Every document the register can hang a share on, newest first.
 * A cancelled invoice or bill carries no rupees for anybody, so it is not offered at all.
 * Credit notes arrive signed: they reduce the centre's revenue rather than being a cost.
 */
export function bookDocs(input: BookInput): BookDoc[] {
  const docs: BookDoc[] = []

  for (const i of input.invoices || []) {
    if (!i?.id || cancelled(i.status)) continue
    const taxable = num(i.taxable_amount)
    const tax = num(i.total_tax)
    docs.push({
      kind: 'invoice',
      id: i.id,
      number: str(i.invoice_number),
      date: str(i.invoice_date).slice(0, 10),
      party: str(i.customer_name),
      taxable,
      tax,
      total: num(i.grand_total),
      itc: 0,
    })
  }

  for (const c of input.credit_notes || []) {
    if (!c?.id || cancelled(c.status)) continue
    const taxable = num(c.taxable_amount)
    const tax = num(c.total_tax)
    docs.push({
      kind: 'credit_note',
      id: c.id,
      number: str(c.credit_note_number),
      date: str(c.credit_note_date).slice(0, 10),
      party: str(c.customer_name || c.vendor_name),
      taxable: -Math.abs(taxable),
      tax: -Math.abs(tax),
      total: -Math.abs(num(c.grand_total)),
      itc: 0,
    })
  }

  for (const d of input.debit_notes || []) {
    if (!d?.id || cancelled(d.status)) continue
    docs.push({
      kind: 'debit_note',
      id: d.id,
      number: str(d.debit_note_number),
      date: str(d.debit_note_date).slice(0, 10),
      party: str(d.customer_name || d.vendor_name),
      taxable: num(d.taxable_amount),
      tax: num(d.total_tax),
      total: num(d.grand_total),
      itc: 0,
    })
  }

  for (const b of input.bills || []) {
    if (!b?.id || cancelled(b.status)) continue
    const tax = num(b.total_tax)
    docs.push({
      kind: 'bill',
      id: b.id,
      number: str(b.bill_number),
      date: str(b.bill_date).slice(0, 10),
      party: str(b.vendor_name),
      taxable: num(b.taxable_amount),
      tax,
      total: num(b.grand_total),
      itc: b.itc_eligible === false ? 0 : tax,
    })
  }

  for (const e of input.expenses || []) {
    if (!e?.id) continue
    const gst = num(e.gst_amount)
    docs.push({
      kind: 'expense',
      id: e.id,
      // An expense often has no bill number; its category is what identifies it on the page.
      number: str(e.bill_number),
      date: str(e.expense_date).slice(0, 10),
      party: str(e.vendor_name || e.category),
      taxable: expenseTaxable(e),
      tax: gst,
      total: num(e.amount),
      itc: e.itc_eligible === false ? 0 : gst,
    })
  }

  return docs.sort((a, b) => (a.date === b.date ? a.number.localeCompare(b.number) : a.date > b.date ? -1 : 1))
}

// ── allocations ───────────────────────────────────────────────────────────────

/** One centre's share of one document, in per cent. */
export interface Part {
  centre_id: string
  share: number
}

export interface Allocation {
  id: string
  doc_kind: DocKind
  doc_id: string
  /** Kept so an orphaned tag still names what it was made against. */
  doc_number: string
  doc_date: string
  parts: Part[]
  note: string
  created_at: string
}

export const docKey = (kind: DocKind, id: string) => `${kind}:${id}`

export function newAllocation(kind: DocKind, id: string, number = '', date = ''): Allocation {
  return {
    id: docKey(kind, id),
    doc_kind: kind,
    doc_id: id,
    doc_number: number,
    doc_date: date,
    parts: [],
    note: '',
    created_at: new Date().toISOString(),
  }
}

function parsePart(v: unknown): Part | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const centre_id = str(o.centre_id)
  if (!centre_id) return null
  const share = num(o.share)
  if (!(share > 0)) return null
  return { centre_id, share: round2(share) }
}

function parseAllocation(v: unknown): Allocation | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const kind = o.doc_kind
  const doc_id = str(o.doc_id)
  if (!isDocKind(kind) || !doc_id) return null
  const parts = (Array.isArray(o.parts) ? o.parts : [])
    .map(parsePart)
    .filter((p): p is Part => p !== null)
  // A sheet with no parts is not an allocation — it is an unassigned document.
  if (parts.length === 0) return null
  return {
    id: docKey(kind, doc_id),
    doc_kind: kind,
    doc_id,
    doc_number: str(o.doc_number),
    doc_date: str(o.doc_date).slice(0, 10),
    // The same centre twice would double its share; keep the first write.
    parts: dedupeParts(parts),
    note: str(o.note),
    created_at: str(o.created_at) || todayISO(),
  }
}

function dedupeParts(parts: Part[]): Part[] {
  const seen = new Map<string, Part>()
  for (const p of parts) if (!seen.has(p.centre_id)) seen.set(p.centre_id, p)
  return [...seen.values()]
}

export interface CCSettings {
  /** The state the business is registered in — what makes a branch "another state". */
  home_state: string
}

export interface CCStore {
  version: number
  updatedAt: string
  orgId: string
  centres: CostCentre[]
  allocations: Allocation[]
  settings: CCSettings
}

export function emptyCC(orgId = ''): CCStore {
  return { version: CC_VERSION, updatedAt: todayISO(), orgId, centres: [], allocations: [], settings: { home_state: '' } }
}

function parseCentre(v: unknown): CostCentre | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id) return null
  const name = str(o.name)
  // A centre with no name cannot be shown or tagged against — drop the row, do not invent one.
  if (!name.trim()) return null
  return {
    id: o.id,
    name,
    code: str(o.code),
    kind: isCentreKind(o.kind) ? o.kind : 'cost_centre',
    state: str(o.state),
    gstin: normaliseGstin(o.gstin),
    notes: str(o.notes),
    archived: o.archived === true,
    created_at: str(o.created_at),
  }
}

export function parseCC(raw: string | null): CCStore {
  if (!raw) return emptyCC()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return emptyCC()
  }
  if (!parsed || typeof parsed !== 'object') return emptyCC()
  const s = parsed as Record<string, unknown>
  if (s.version !== CC_VERSION) return emptyCC(str(s.orgId))
  const centres = Array.isArray(s.centres) ? s.centres.map(parseCentre).filter((c): c is CostCentre => c !== null) : []
  const allocations = Array.isArray(s.allocations)
    ? s.allocations.map(parseAllocation).filter((a): a is Allocation => a !== null)
    : []
  const settings = (s.settings && typeof s.settings === 'object' ? s.settings : {}) as Record<string, unknown>
  return {
    version: CC_VERSION,
    updatedAt: str(s.updatedAt) || todayISO(),
    orgId: str(s.orgId),
    centres,
    // One row per document, whatever the store held.
    allocations: [...new Map(allocations.map(a => [a.id, a])).values()],
    settings: { home_state: str(settings.home_state) },
  }
}

export function loadCC(orgId: string): CCStore {
  if (typeof window === 'undefined' || !orgId) return emptyCC()
  try {
    const store = parseCC(window.localStorage.getItem(KEY_CC + orgId))
    return { ...store, orgId }
  } catch {
    return emptyCC(orgId)
  }
}

export function saveCC(orgId: string, store: CCStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_CC + orgId,
      JSON.stringify({ ...store, orgId, version: CC_VERSION, updatedAt: todayISO() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function mutate(orgId: string, fn: (store: CCStore) => CCStore): CCStore {
  const next = fn(loadCC(orgId))
  saveCC(orgId, next)
  return next
}

// ── centres ───────────────────────────────────────────────────────────────────

/**
 * Hard refusals only — things that would corrupt the register. A disagreement between the
 * state typed here and the state a GSTIN begins with is *not* one of them: that is a finding
 * for the card to print, not a wall to save behind.
 */
export function validateCentre(centre: CostCentre, centres: CostCentre[]): string[] {
  const problems: string[] = []
  const name = centre.name.trim()
  if (!name) problems.push('A centre needs a name — it is the label every split is read against')
  const gstin = normaliseGstin(centre.gstin)
  if (gstin && !validateGSTIN(gstin)) {
    problems.push(`“${gstin}” is not a 15-character GSTIN — 2 state digits, a 10-character PAN, an entity check code, the letter Z and a checksum`)
  }
  if (centre.state && !INDIAN_STATES.some(s => s.value === centre.state)) {
    problems.push(`“${centre.state}” is not a state code on the GST list`)
  }
  if (!isCentreKind(centre.kind)) problems.push('Pick what kind of centre this is')

  const clash = centres.find(c => c.id !== centre.id && !c.archived && c.name.trim().toLowerCase() === name.toLowerCase())
  if (clash && name) problems.push(`A centre named “${clash.name}” already exists — give this one a different name or edit that one`)
  const code = centre.code.trim()
  if (code) {
    const dupe = centres.find(c => c.id !== centre.id && !c.archived && c.code.trim().toLowerCase() === code.toLowerCase())
    if (dupe) problems.push(`Code “${dupe.code}” is already on ${dupe.name} — a code identifies one place, not two`)
  }
  return problems
}

export function upsertCentre(orgId: string, centre: CostCentre): { ok: boolean; error: string; store: CCStore } {
  const store = loadCC(orgId)
  const problems = validateCentre(centre, store.centres)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: CostCentre = {
    ...centre,
    name: centre.name.trim(),
    code: centre.code.trim(),
    gstin: normaliseGstin(centre.gstin),
  }
  const exists = store.centres.some(c => c.id === clean.id)
  return {
    ok: true,
    error: '',
    store: mutate(orgId, s => ({
      ...s,
      centres: exists ? s.centres.map(c => (c.id === clean.id ? clean : c)) : [...s.centres, clean],
    })),
  }
}

/**
 * Archiving is the honest exit: the centre stops appearing in the picker, and its past shares
 * keep counting. A new tag against an archived centre is refused by `validateAllocation`.
 */
export function archiveCentre(orgId: string, id: string, archived = true): CCStore {
  return mutate(orgId, s => ({
    ...s,
    centres: s.centres.map(c => (c.id === id ? { ...c, archived } : c)),
  }))
}

/** Deleting is refused while any document still carries a share to it (serial-register precedent). */
export function deleteCentre(orgId: string, id: string): { ok: boolean; error: string; store: CCStore } {
  const store = loadCC(orgId)
  const used = store.allocations.filter(a => a.parts.some(p => p.centre_id === id)).length
  if (used > 0) {
    return {
      ok: false,
      error: `${plural(used, 'document')} still carr${used === 1 ? 'ies' : 'y'} a share to this centre — archive it instead, or reassign those documents first`,
      store,
    }
  }
  return { ok: true, error: '', store: mutate(orgId, s => ({ ...s, centres: s.centres.filter(c => c.id !== id) })) }
}

// ── allocations ───────────────────────────────────────────────────────────────

export function totalShare(parts: Part[]): number {
  return round2(parts.reduce((sum, p) => sum + num(p.share), 0))
}

/**
 * Hard refusals for a split. The over-100 case is the one a human hits: two centres at 60%
 * means a rupee is counted twice, and a report that quietly allows it is worse than no report.
 */
export function validateAllocation(alloc: Allocation, centres: CostCentre[]): string[] {
  const problems: string[] = []
  if (!alloc.doc_id) problems.push('Pick the document to split')
  if (!isDocKind(alloc.doc_kind)) problems.push('The kind of document is not known')
  if (!alloc.parts.length) problems.push('Name at least one centre and the share it carries')

  const ids = alloc.parts.map(p => p.centre_id)
  if (new Set(ids).size !== ids.length) problems.push('The same centre is listed twice — give it one row with the whole share')

  for (const p of alloc.parts) {
    const centre = centres.find(c => c.id === p.centre_id)
    if (!centre) {
      problems.push(`A share is tagged to a centre that is no longer on the register (${p.centre_id})`)
      continue
    }
    if (centre.archived) problems.push(`${centre.name} is archived — new shares cannot be tagged to it, reactivate it or choose another`)
    if (!(p.share > 0)) problems.push(`${centre.name}: a share must be more than 0%`)
    if (p.share > 100) problems.push(`${centre.name}: a share cannot be more than 100% of one document`)
  }

  const total = totalShare(alloc.parts)
  if (total > 100 + PCT_EPSILON) {
    problems.push(`The shares add up to ${total}% — one document cannot be split past 100%`)
  }
  // A credit note is negative revenue: the same shares simply move backwards with it, which is
  // the point — a centre that was given 60% of the sale also carries 60% of the reversal.
  return problems
}

export interface AllocationWrite {
  ok: boolean
  error: string
  store: CCStore
}

/**
 * Write a document's whole sheet at once. An empty part list means "unassign it", which is a
 * legitimate save rather than an error — the register should not keep a row that says nothing.
 */
export function setAllocation(orgId: string, alloc: Allocation, centres?: CostCentre[]): AllocationWrite {
  const store = loadCC(orgId)
  const known = centres || store.centres
  if (!alloc.parts.length) {
    return {
      ok: true,
      error: '',
      store: mutate(orgId, s => ({ ...s, allocations: s.allocations.filter(a => a.id !== alloc.id) })),
    }
  }
  const problems = validateAllocation(alloc, known)
  if (problems.length) return { ok: false, error: problems[0], store }
  const clean: Allocation = {
    ...alloc,
    id: docKey(alloc.doc_kind, alloc.doc_id),
    doc_number: alloc.doc_number.trim(),
    parts: dedupeParts(alloc.parts).map(p => ({ centre_id: p.centre_id, share: round2(p.share) })),
  }
  return {
    ok: true,
    error: '',
    store: mutate(orgId, s => ({
      ...s,
      allocations: [...s.allocations.filter(a => a.id !== clean.id), clean],
    })),
  }
}

export function removeAllocation(orgId: string, key: string): CCStore {
  return mutate(orgId, s => ({ ...s, allocations: s.allocations.filter(a => a.id !== key) }))
}

export interface BulkResult {
  assigned: number
  /** Documents already carrying a split, left exactly as they were. */
  skipped: number
  store: CCStore
}

/**
 * Tag a pile of unassigned documents in one go. Deliberately refuses to overwrite a sheet that
 * already splits a document: a bulk action that silently flattens someone's 60/40 is not a
 * bulk action, it is data loss. Pass `docs` so each new row keeps the number and date it was
 * made against — that is what lets the tag still say what it meant if the document goes.
 */
export function bulkAssign(orgId: string, centreId: string, keys: string[], share = 100, docs: BookDoc[] = []): BulkResult {
  const store = loadCC(orgId)
  const centre = store.centres.find(c => c.id === centreId)
  if (!centre || centre.archived || !(share > 0) || share > 100) {
    return { assigned: 0, skipped: keys.length, store }
  }
  const docByKey = new Map(docs.map(d => [docKey(d.kind, d.id), d]))
  const byId = new Map(store.allocations.map(a => [a.id, a]))
  let assigned = 0
  let skipped = 0
  for (const key of keys) {
    const existing = byId.get(key)
    if (existing && existing.parts.length) { skipped++; continue }
    const sep = key.indexOf(':')
    const kind = key.slice(0, sep)
    const id = key.slice(sep + 1)
    if (!isDocKind(kind) || !id) { skipped++; continue }
    const doc = docByKey.get(key)
    const row: Allocation = {
      ...(existing || newAllocation(kind, id, doc?.number || '', doc?.date || '')),
      doc_kind: kind,
      doc_id: id,
      doc_number: doc?.number ?? (existing?.doc_number || ''),
      doc_date: doc?.date ?? (existing?.doc_date || ''),
      parts: [{ centre_id: centreId, share: round2(share) }],
    }
    byId.set(key, row)
    assigned++
  }
  const allocations = [...byId.values()].sort((a, b) => (a.doc_date === b.doc_date ? a.doc_number.localeCompare(b.doc_number) : a.doc_date > b.doc_date ? -1 : 1))
  const store2 = mutate(orgId, s => ({ ...s, allocations }))
  return { assigned, skipped, store: store2 }
}

// ── derived views ─────────────────────────────────────────────────────────────

export interface PartLine {
  centre_id: string
  centre: CostCentre | null
  name: string
  share: number
  taxable: number
  tax: number
  total: number
  itc: number
}

/** One document, its split, and the remainder nobody has claimed. */
export interface DocSheet {
  key: string
  kind: DocKind
  doc: BookDoc
  /** True when the tag outlived the document it was made against. */
  orphan: boolean
  parts: PartLine[]
  allocated_pct: number
  /** 100 − allocated; on a credit note the rupees below run the same way as the note does. */
  unallocated_pct: number
  unallocated: { taxable: number; tax: number; total: number; itc: number }
  total_share: number
  max_share: number
  side: 'outward' | 'inward'
  problems: string[]
}

export interface SheetInput {
  docs: BookDoc[]
  allocations: Allocation[]
  centres: CostCentre[]
}

export function sheets({ docs, allocations, centres }: SheetInput): DocSheet[] {
  const byDoc = new Map(allocations.map(a => [a.id, a]))
  const centreById = new Map(centres.map(c => [c.id, c]))
  const out: DocSheet[] = []
  const seen = new Set<string>()

  for (const doc of docs) {
    const key = docKey(doc.kind, doc.id)
    seen.add(key)
    const alloc = byDoc.get(key)
    out.push(buildSheet(key, doc, alloc || null, centreById, false))
  }

  // A tag whose document is gone stays on the register — as itself, with zero rupees beside it.
  for (const alloc of allocations) {
    if (seen.has(alloc.id)) continue
    const synthetic: BookDoc = {
      kind: alloc.doc_kind,
      id: alloc.doc_id,
      number: alloc.doc_number,
      date: alloc.doc_date,
      party: '',
      taxable: 0,
      tax: 0,
      total: 0,
      itc: 0,
    }
    out.push(buildSheet(alloc.id, synthetic, alloc, centreById, true))
  }

  return out.sort((a, b) => (a.doc.date === b.doc.date ? a.doc.number.localeCompare(b.doc.number) : a.doc.date > b.doc.date ? -1 : 1))
}

function buildSheet(key: string, doc: BookDoc, alloc: Allocation | null, centreById: Map<string, CostCentre>, orphan: boolean): DocSheet {
  const parts: PartLine[] = (alloc?.parts || []).map(p => {
    const centre = centreById.get(p.centre_id) || null
    const share = num(p.share)
    return {
      centre_id: p.centre_id,
      centre,
      name: centre?.name || 'a centre no longer on the register',
      share,
      taxable: round2(doc.taxable * share / 100),
      tax: round2(doc.tax * share / 100),
      total: round2(doc.total * share / 100),
      itc: round2(doc.itc * share / 100),
    }
  })
  const allocated_pct = totalShare(parts)
  const unallocated_pct = round2(100 - allocated_pct)
  // The remainder comes from subtraction, never from 100−allocated × value: that is what makes
  // Σ(parts) + unallocated equal the document to the paisa however the shares round.
  const unallocated = {
    taxable: round2(doc.taxable - parts.reduce((s, p) => s + p.taxable, 0)),
    tax: round2(doc.tax - parts.reduce((s, p) => s + p.tax, 0)),
    total: round2(doc.total - parts.reduce((s, p) => s + p.total, 0)),
    itc: round2(doc.itc - parts.reduce((s, p) => s + p.itc, 0)),
  }

  const problems: string[] = []
  if (orphan) {
    problems.push(`No ${DOC_KIND_META[doc.kind].label.toLowerCase()} with this number is in the books any more — ${allocated_pct}% of it is still tagged here, so the split is unverified`)
  }
  if (parts.some(p => !p.centre)) {
    problems.push('A share on this document points at a centre that has been deleted from the register')
  }
  if (parts.some(p => p.centre?.archived)) {
    problems.push('A share sits on an archived centre — its rupees still count, which is usually not what an archive was meant to do')
  }
  if (allocated_pct > 100 + PCT_EPSILON) {
    problems.push(`The shares add up to ${allocated_pct}% — more than the document is worth`)
  }

  return {
    key,
    kind: doc.kind,
    doc,
    orphan,
    parts,
    allocated_pct,
    unallocated_pct,
    unallocated,
    total_share: allocated_pct,
    max_share: parts.reduce((m, p) => Math.max(m, p.share), 0),
    side: DOC_KIND_META[doc.kind].side,
    problems,
  }
}

/** Documents with no centre at all, newest first — the work list the page puts in front of you. */
export function unassigned(sheets: DocSheet[], side?: 'outward' | 'inward'): DocSheet[] {
  return sheets.filter(s => !s.orphan && s.parts.length === 0 && (!side || s.side === side))
}

export interface CentreView {
  centre: CostCentre
  docs: number
  revenue: number
  tax_collected: number
  cost: number
  itc: number
  contribution: number
  /** Against the whole business, allocated or not — so a centre can never show 100% of a total that grew. */
  share_of_revenue: number
  share_of_cost: number
  largest: { total: number; label: string } | null
  problems: string[]
}

export function centreViews(list: CostCentre[], sheetList: DocSheet[], homeState = ''): CentreView[] {
  const totals = rollupTotals(sheetList)
  return list.map(centre => {
    let revenue = 0
    let tax_collected = 0
    let cost = 0
    let itc = 0
    let docs = 0
    let largest: { total: number; label: string } | null = null

    for (const sheet of sheetList) {
      const mine = sheet.parts.filter(p => p.centre_id === centre.id)
      if (!mine.length) continue
      docs++
      const taxable = round2(mine.reduce((s, p) => s + p.taxable, 0))
      const tax = round2(mine.reduce((s, p) => s + p.tax, 0))
      const total = round2(mine.reduce((s, p) => s + p.total, 0))
      const credit = round2(mine.reduce((s, p) => s + p.itc, 0))
      if (sheet.side === 'outward') {
        revenue = round2(revenue + taxable)
        tax_collected = round2(tax_collected + tax)
      } else {
        cost = round2(cost + taxable)
        itc = round2(itc + credit)
      }
      const magnitude = Math.abs(total)
      if (!largest || magnitude > Math.abs(largest.total)) {
        largest = { total, label: sheet.doc.number || DOC_KIND_META[sheet.kind].label }
      }
    }

    const problems: string[] = []
    if (centre.kind === 'branch' && centre.state && !centre.gstin) {
      // Two situations that look identical on this register are not the same question at all: a
      // branch in the state the business is already registered in moves goods intra-state, which
      // rule 41A says nothing about, while a branch in *another* state with no GSTIN of its own is
      // squarely rule 41A territory. The home state is what separates them, so it is asked for —
      // and when it is not on record the page says "if", not "is". No accusation on a guess.
      if (homeState && centre.state !== homeState) {
        problems.push(`A branch in ${stateLabel(centre.state) || centre.state} while the business is registered in ${stateLabel(homeState) || homeState}, with no GSTIN of its own: sending goods or inputs there is rule 41A territory, and registration in that state may be required — the reversal belongs on the return, not on this page (see /gst/gstr9)`)
      } else if (!homeState) {
        problems.push('A branch with no GSTIN of its own and no registration on this page to compare it with. If stock or inputs move to it from another state, rule 41A becomes a question to check — the reversal belongs on the return, not on this page (see /gst/gstr9)')
      }
    }
    if (centre.gstin && centre.state && centre.gstin.slice(0, 2) !== centre.state) {
      problems.push(`This centre’s GSTIN begins ${centre.gstin.slice(0, 2)} (${stateLabel(centre.gstin.slice(0, 2)) || 'an unknown state'}), but the state recorded here is ${stateLabel(centre.state) || centre.state} — one of the two is mistyped`)
    }
    if (centre.archived && docs > 0) {
      problems.push(`Archived, yet ${plural(docs, 'document')} still carr${docs === 1 ? 'ies' : 'y'} a share to it`)
    }

    return {
      centre,
      docs,
      revenue,
      tax_collected,
      cost,
      itc,
      contribution: round2(revenue - cost),
      share_of_revenue: totals.revenue > 0 ? round2(revenue * 100 / totals.revenue) : 0,
      share_of_cost: totals.cost > 0 ? round2(cost * 100 / totals.cost) : 0,
      largest,
      problems,
    }
  })
}

export interface RollupTotals {
  revenue: number
  tax_out: number
  cost: number
  itc: number
}

/** The books as the register can see them — allocated and unallocated together. */
export function rollupTotals(sheetList: DocSheet[]): RollupTotals {
  const live = sheetList.filter(s => !s.orphan)
  return {
    revenue: round2(live.reduce((s, x) => s + (x.side === 'outward' ? x.doc.taxable : 0), 0)),
    tax_out: round2(live.reduce((s, x) => s + (x.side === 'outward' ? x.doc.tax : 0), 0)),
    cost: round2(live.reduce((s, x) => s + (x.side === 'inward' ? x.doc.taxable : 0), 0)),
    itc: round2(live.reduce((s, x) => s + (x.side === 'inward' ? x.doc.itc : 0), 0)),
  }
}

export interface CCSummary {
  centres: number
  active: number
  archived: number
  docs: number
  tagged: number
  orphans: number
  attention: number
  revenue_total: number
  revenue_allocated: number
  cost_total: number
  cost_allocated: number
  itc_total: number
  itc_allocated: number
  /** Rupees of spending no centre has been given a share of — the number a spreadsheet loses. */
  unallocated_cost: number
  unallocated_revenue: number
  cost_coverage_pct: number
  revenue_coverage_pct: number
  top: CentreView | null
}

export function summarise(list: CostCentre[], sheetList: DocSheet[], homeState = ''): CCSummary {
  const totals = rollupTotals(sheetList)
  const live = sheetList.filter(s => !s.orphan)
  const costAllocated = round2(live.reduce((s, x) => x.side === 'inward'
    ? s + x.parts.reduce((t, p) => t + p.taxable, 0)
    : s, 0))
  const revenueAllocated = round2(live.reduce((s, x) => x.side === 'outward'
    ? s + x.parts.reduce((t, p) => t + p.taxable, 0)
    : s, 0))
  const itcAllocated = round2(live.reduce((s, x) => x.side === 'inward'
    ? s + x.parts.reduce((t, p) => t + p.itc, 0)
    : s, 0))
  const views = centreViews(list, sheetList, homeState)
  const attention = views.filter(v => v.problems.length).length
    + sheetList.filter(s => s.problems.length && !s.orphan).length

  const pct = (part: number, whole: number) => (whole > 0 ? round2(Math.abs(part) * 100 / Math.abs(whole)) : 0)

  return {
    centres: list.length,
    active: list.filter(c => !c.archived).length,
    archived: list.filter(c => c.archived).length,
    docs: live.length,
    tagged: live.filter(s => s.parts.length).length,
    orphans: sheetList.filter(s => s.orphan).length,
    attention,
    revenue_total: totals.revenue,
    revenue_allocated: revenueAllocated,
    cost_total: totals.cost,
    cost_allocated: costAllocated,
    itc_total: totals.itc,
    itc_allocated: itcAllocated,
    unallocated_cost: round2(totals.cost - costAllocated),
    unallocated_revenue: round2(totals.revenue - revenueAllocated),
    cost_coverage_pct: pct(costAllocated, totals.cost),
    revenue_coverage_pct: pct(revenueAllocated, totals.revenue),
    top: views.filter(v => !v.centre.archived).sort((a, b) => b.contribution - a.contribution)[0] || null,
  }
}

// ── ordering ──────────────────────────────────────────────────────────────────

export type CentreSort = 'contribution' | 'cost' | 'revenue' | 'docs' | 'name'

export const CENTRE_SORTS: { value: CentreSort; label: string }[] = [
  { value: 'contribution', label: 'Contribution' },
  { value: 'cost', label: 'Cost carried' },
  { value: 'revenue', label: 'Revenue' },
  { value: 'docs', label: 'Documents' },
  { value: 'name', label: 'Name' },
]

export function sortCentreViews(views: CentreView[], sort: CentreSort): CentreView[] {
  const copy = [...views]
  return copy.sort((a, b) => {
    // An archived centre always sits below a live one, whatever the column.
    if (a.centre.archived !== b.centre.archived) return a.centre.archived ? 1 : -1
    switch (sort) {
      case 'name': return a.centre.name.localeCompare(b.centre.name)
      case 'cost': return b.cost - a.cost
      case 'revenue': return b.revenue - a.revenue
      case 'docs': return b.docs - a.docs || b.cost - a.cost
      case 'contribution':
      default: return b.contribution - a.contribution || b.cost - a.cost
    }
  })
}

/** How the page sorts its document lists: biggest rupees first, so the work starts where the money is. */
export function sortSheets(list: DocSheet[]): DocSheet[] {
  return [...list].sort((a, b) => Math.abs(b.doc.total) - Math.abs(a.doc.total))
}

// ── export ────────────────────────────────────────────────────────────────────

export const CENTRE_CSV_HEADERS = [
  'Centre', 'Code', 'Kind', 'State', 'Own GSTIN', 'Documents', 'Revenue (taxable)',
  'Tax collected', 'Cost (taxable)', 'ITC tagged', 'Contribution', '% of revenue', '% of cost', 'Notes to check',
]

export function centreCsvRows(views: CentreView[]): (string | number)[][] {
  return views.map(v => [
    v.centre.name,
    v.centre.code,
    KIND_META[v.centre.kind].label,
    stateLabel(v.centre.state) || v.centre.state,
    v.centre.gstin,
    v.docs,
    v.revenue,
    v.tax_collected,
    v.cost,
    v.itc,
    v.contribution,
    v.share_of_revenue,
    v.share_of_cost,
    v.problems.join(' · '),
  ])
}

export const ALLOC_CSV_HEADERS = [
  'Kind', 'Document', 'Date', 'Party', 'Taxable', 'Tax', 'Total',
  'Allocated %', 'Unallocated %', 'Split', 'Status',
]

export function allocationCsvRows(list: DocSheet[]): (string | number)[][] {
  return list.map(s => [
    DOC_KIND_META[s.kind].label,
    s.doc.number,
    s.doc.date,
    s.doc.party,
    s.doc.taxable,
    s.doc.tax,
    s.doc.total,
    s.allocated_pct,
    s.unallocated_pct,
    // One cell the way a human reads a split: "North 60% · Depot 40%".
    s.parts.map(p => `${p.name} ${p.share}%`).join(' · '),
    s.orphan ? 'document no longer in the books' : s.parts.length ? 'split' : 'unassigned',
  ])
}

/** The per-centre detail sheet: one row per (document, centre) share. */
export const SHARE_CSV_HEADERS = ['Centre', 'Document', 'Kind', 'Date', 'Party', 'Share %', 'Taxable tagged', 'Tax tagged', 'Total tagged', 'ITC tagged']

export function shareCsvRows(list: DocSheet[], centreId: string): (string | number)[][] {
  return list
    .filter(s => s.parts.some(p => p.centre_id === centreId))
    .flatMap(s => {
      const p = s.parts.find(x => x.centre_id === centreId)
      if (!p) return []
      return [[
        p.name,
        s.doc.number,
        DOC_KIND_META[s.kind].label,
        s.doc.date,
        s.doc.party,
        p.share,
        p.taxable,
        p.tax,
        p.total,
        p.itc,
      ] as (string | number)[]]
    })
}
