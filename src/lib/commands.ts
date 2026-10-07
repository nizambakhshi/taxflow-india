// Command palette: what ⌘K can reach, how a query ranks it, and what the user
// last went to. Pure functions only — no React, no Supabase — so the ranking can
// be asserted without a browser.
//
// Three decisions worth writing down:
//  * Matching is AND over whitespace tokens, not a fuzzy subsequence. "inv 42"
//    has to find INV-0042 and must NOT find a customer called "42 Sunrise
//    Traders"; every token matching somewhere is what makes that work.
//  * Only invoices have a detail route, so every other record links to its own
//    list page with ?q= pre-filled. A row that dumped the user on an unfiltered
//    list would read as broken.
//  * Recents live in localStorage (the app has no server-side user preferences),
//    and are re-validated on load: a stale href from an old build must not offer
//    a 404.

import { validateGSTIN } from '@/lib/constants'
import { formatCompactINR, formatDateIN } from '@/lib/format'
import { NAV_ITEMS } from '@/lib/nav'

export type CommandKind = 'recent' | 'action' | 'page' | 'record'

export type EntityKind =
  | 'invoice'
  | 'purchase_bill'
  | 'credit_note'
  | 'debit_note'
  | 'quotation'
  | 'customer'
  | 'vendor'
  | 'product'

export interface Command {
  id: string
  kind: CommandKind
  entity?: EntityKind
  label: string
  sublabel?: string
  href: string
  icon: string
  badge?: string
  keywords?: string
}

export interface CommandGroup {
  title: string
  kind: CommandKind
  /** Which entity a Records group holds, so the UI can show it a loader. */
  entity?: EntityKind
  items: Command[]
  moreLabel?: string
  moreHref?: string
}

export type EntityRow = Record<string, string | number | null | undefined>

export const RECENTS_CAP = 8
export const RECORDS_PER_GROUP = 8
export const PAGES_CAP = 14

export const GROUP_ORDER: CommandKind[] = ['recent', 'action', 'page', 'record']

const GROUP_TITLES: Record<CommandKind, string> = {
  recent: 'Recent',
  action: 'Actions',
  page: 'Pages',
  record: 'Records',
}

/** Records are grouped per entity, most business-used first. */
export const RECORD_ORDER: EntityKind[] = [
  'invoice',
  'customer',
  'vendor',
  'product',
  'purchase_bill',
  'credit_note',
  'debit_note',
  'quotation',
]

interface EntitySpec {
  table: string
  columns: string
  orColumns: string[]
  /** Single ordering column: PostgREST takes one .order() per call. */
  order: string
  orderAsc: boolean
  /** Documents are soft-deleted with status='cancelled'; masters with is_active. */
  life: 'document' | 'active'
  numberField?: string
  partyField?: string
  dateField?: string
  amountField?: string
  refField?: string
}

export const ENTITY_SPECS: Record<EntityKind, EntitySpec> = {
  invoice: {
    table: 'invoices',
    columns: 'id, invoice_number, customer_name, invoice_date, grand_total, status',
    orColumns: ['invoice_number', 'customer_name'],
    order: 'invoice_date', orderAsc: false,
    life: 'document',
    numberField: 'invoice_number',
    partyField: 'customer_name',
    dateField: 'invoice_date',
    amountField: 'grand_total',
  },
  customer: {
    table: 'customers',
    columns: 'id, name, business_name, gstin, phone, city',
    orColumns: ['name', 'business_name', 'gstin'],
    order: 'name', orderAsc: true,
    life: 'active',
  },
  vendor: {
    table: 'vendors',
    columns: 'id, name, business_name, gstin, city',
    orColumns: ['name', 'business_name', 'gstin'],
    order: 'name', orderAsc: true,
    life: 'active',
  },
  product: {
    table: 'products',
    columns: 'id, name, sku, hsn_sac, unit, selling_price',
    orColumns: ['name', 'sku', 'hsn_sac'],
    order: 'name', orderAsc: true,
    life: 'active',
    amountField: 'selling_price',
  },
  purchase_bill: {
    table: 'purchase_bills',
    columns: 'id, bill_number, vendor_name, bill_date, grand_total',
    orColumns: ['bill_number', 'vendor_name'],
    order: 'bill_date', orderAsc: false,
    life: 'document',
    numberField: 'bill_number',
    partyField: 'vendor_name',
    dateField: 'bill_date',
    amountField: 'grand_total',
  },
  credit_note: {
    table: 'credit_notes',
    columns: 'id, credit_note_number, customer_name, credit_note_date, grand_total, invoice_number',
    orColumns: ['credit_note_number', 'customer_name'],
    order: 'credit_note_date', orderAsc: false,
    life: 'document',
    numberField: 'credit_note_number',
    partyField: 'customer_name',
    dateField: 'credit_note_date',
    amountField: 'grand_total',
    refField: 'invoice_number',
  },
  debit_note: {
    table: 'debit_notes',
    columns: 'id, debit_note_number, vendor_name, debit_note_date, grand_total, bill_number',
    orColumns: ['debit_note_number', 'vendor_name'],
    order: 'debit_note_date', orderAsc: false,
    life: 'document',
    numberField: 'debit_note_number',
    partyField: 'vendor_name',
    dateField: 'debit_note_date',
    amountField: 'grand_total',
    refField: 'bill_number',
  },
  quotation: {
    table: 'quotations',
    columns: 'id, quotation_number, customer_name, quotation_date, grand_total, status',
    orColumns: ['quotation_number', 'customer_name'],
    order: 'quotation_date', orderAsc: false,
    life: 'document',
    numberField: 'quotation_number',
    partyField: 'customer_name',
    dateField: 'quotation_date',
    amountField: 'grand_total',
  },
}

export const ENTITY_META: Record<EntityKind, { group: string; badge: string; icon: string; home: string }> = {
  invoice: { group: 'Invoices', badge: 'Invoice', icon: 'invoice', home: '/invoices' },
  customer: { group: 'Customers', badge: 'Customer', icon: 'users', home: '/customers' },
  vendor: { group: 'Vendors', badge: 'Vendor', icon: 'factory', home: '/vendors' },
  product: { group: 'Products', badge: 'Product', icon: 'box', home: '/products' },
  purchase_bill: { group: 'Purchase bills', badge: 'Bill', icon: 'cart', home: '/bills' },
  credit_note: { group: 'Credit notes', badge: 'Credit note', icon: 'credit-note', home: '/credit-notes' },
  debit_note: { group: 'Debit notes', badge: 'Debit note', icon: 'debit-note', home: '/debit-notes' },
  quotation: { group: 'Quotations', badge: 'Quotation', icon: 'clipboard', home: '/quotations' },
}

export const ENTITY_GROUPS = RECORD_ORDER.map(e => ENTITY_META[e].group)

const text = (v: unknown): string => String(v ?? '').trim()
const num = (v: unknown): number => Number(v ?? 0) || 0

/** ₹123456 → "1,23,456" so typing the printed amount finds the document. */
function inrDigits(n: number): string {
  return n.toLocaleString('en-IN')
}

export function normalizeQuery(q: string): string {
  return String(q ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

/** A user pastes a GSTIN with spaces and case; matching should not care. */
function queryTokens(q: string): string[] {
  return q.split(' ').map(t => t.replace(/[^a-z0-9]/g, '')).filter(Boolean)
}

export function looksLikeGSTIN(q: string): boolean {
  const v = text(q).toUpperCase().replace(/\s+/g, '')
  if (!v || v.length > 15) return false
  if (v.length === 15) return validateGSTIN(v)
  // Mid-typing: two-digit state code then letters is enough to treat it as one.
  return v.length >= 7 && /^[0-9]{2}[A-Z]{3,}/.test(v)
}

/** PostgREST splits .or() on commas and reads parens/colons as syntax. */
export function sanitizeForOr(q: string): string {
  return normalizeQuery(q).replace(/[,%*():]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function orFilter(entity: EntityKind, q: string): string | null {
  const clean = sanitizeForOr(q)
  if (!clean) return null
  const like = `%${clean}%`
  return ENTITY_SPECS[entity].orColumns.map(c => `${c}.ilike.${like}`).join(',')
}

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
}

/**
 * One token's best hit across the row's fields. Weighted so a document number or
 * page name beats the same letters appearing in a party's address.
 */
function tokenScore(tok: string, cmd: Command): number {
  const label = cmd.label.toLowerCase()
  const labelWords = words(label)
  const kwWords = words(cmd.keywords ?? '')

  let best = 0
  if (label === tok) best = 640
  else if (label.startsWith(tok)) best = 560
  if (labelWords.includes(tok)) best = Math.max(best, 500)
  else if (labelWords.some(w => w.startsWith(tok))) best = Math.max(best, 450)
  if (label.includes(tok)) best = Math.max(best, 330)

  if (kwWords.includes(tok)) best = Math.max(best, 300)
  else if (kwWords.some(w => w.startsWith(tok))) best = Math.max(best, 240)
  else if ((cmd.keywords ?? '').toLowerCase().includes(tok)) best = Math.max(best, 170)

  if (best === 0 && (cmd.sublabel ?? '').toLowerCase().includes(tok)) best = 80
  return best
}

export function scoreCommand(query: string, cmd: Command): number {
  const q = normalizeQuery(query)
  if (!q) return 0
  const toks = queryTokens(q)
  if (!toks.length) return 0

  let total = 0
  for (const tok of toks) {
    const hit = tokenScore(tok, cmd)
    if (hit === 0) return 0
    total += hit
  }

  // Whole-phrase presence outranks the same words scattered across a long label.
  const label = cmd.label.toLowerCase()
  if (label === q) total += 900
  else if (label.startsWith(q)) total += 380
  else if (label.includes(q)) total += 160

  if (looksLikeGSTIN(q) && words(cmd.keywords ?? '').some(w => w.startsWith(q.replace(/\s+/g, '')))) {
    total += 700
  }
  return total
}

export function rankCommands(query: string, cmds: Command[]): Command[] {
  const q = normalizeQuery(query)
  if (!q) return [...cmds]
  const scored = cmds
    .map(cmd => ({ cmd, score: scoreCommand(q, cmd) }))
    .filter(x => x.score > 0)
  scored.sort((a, b) => b.score - a.score)
  return scored.map(x => x.cmd)
}

const PAGE_HREFS: string[] = NAV_ITEMS.flatMap(s => s.items.map(i => i.href))

/**
 * Invoices are the only entity with a detail route, so they are the only prefix
 * whose children count as known. Matching every parent loosely would let a stale
 * '/gst/gstr9' recent — a route that 404s — look valid, which is the whole thing
 * this check exists to prevent.
 */
const DYNAMIC_CHILD_PREFIXES = ['/invoices/']

/**
 * A destination must still exist: recents are replayed from localStorage, and an
 * entry saved before a route was renamed would otherwise offer a 404.
 */
export function isKnownHref(href: string): boolean {
  const path = String(href ?? '').split('?')[0].split('#')[0]
  if (!path) return false
  if (PAGE_HREFS.includes(path)) return true
  if (buildActionCommands().some(a => a.href === path)) return true
  return DYNAMIC_CHILD_PREFIXES.some(p => path.startsWith(p))
}

export function buildPageCommands(): Command[] {
  return NAV_ITEMS.flatMap(section =>
    section.items.map(item => ({
      id: `page:${item.href}`,
      kind: 'page' as CommandKind,
      label: item.label,
      sublabel: section.section,
      href: item.href,
      icon: item.icon,
      badge: 'Page',
      keywords: `${section.section} ${item.label}`.toLowerCase(),
    }))
  )
}

export function buildActionCommands(): Command[] {
  return [
    {
      id: 'action:new-invoice',
      kind: 'action',
      label: 'New invoice',
      sublabel: 'Raise a tax invoice',
      href: '/invoices/new',
      icon: 'plus',
      badge: 'Action',
      keywords: 'create add invoice sale bill new',
    },
    {
      id: 'action:counter-sale',
      kind: 'action',
      label: 'Counter sale',
      sublabel: 'Bill a walk-in customer',
      href: '/pos',
      icon: 'pos',
      badge: 'Action',
      keywords: 'create new pos shop counter retail sale',
    },
  ]
}

export function handleFor(entity: EntityKind, row: EntityRow): string {
  const spec = ENTITY_SPECS[entity]
  return entity === 'invoice' || spec.numberField
    ? text(row[spec.numberField ?? ''])
    : text(row.name)
}

export function recordHref(entity: EntityKind, row: EntityRow): string {
  const home = ENTITY_META[entity].home
  if (entity === 'invoice') return `${home}/${text(row.id)}`
  return `${home}?q=${encodeURIComponent(handleFor(entity, row))}`
}

export function toCommand(entity: EntityKind, row: EntityRow): Command | null {
  const spec = ENTITY_SPECS[entity]
  const id = text(row.id)
  if (!id) return null
  const meta = ENTITY_META[entity]

  if (spec.life === 'document') {
    const number = text(row[spec.numberField ?? ''])
    const party = text(row[spec.partyField ?? ''])
    if (!number) return null
    const amount = num(row[spec.amountField ?? ''])
    const bits = [party, formatDateIN(text(row[spec.dateField ?? ''])), formatCompactINR(amount)]
    if (spec.refField && text(row[spec.refField])) bits.push(`vs ${text(row[spec.refField])}`)
    return {
      id: `record:${entity}:${id}`,
      kind: 'record',
      entity,
      label: number,
      sublabel: bits.filter(Boolean).join(' · '),
      href: recordHref(entity, row),
      icon: meta.icon,
      badge: meta.badge,
      keywords: [number, party, text(row.status), spec.dateField ? text(row[spec.dateField]) : '',
        inrDigits(amount), String(amount)].filter(Boolean).join(' ').toLowerCase(),
    }
  }

  if (entity === 'product') {
    const name = text(row.name)
    if (!name) return null
    const sku = text(row.sku)
    const hsn = text(row.hsn_sac)
    const price = num(row.selling_price)
    return {
      id: `record:product:${id}`,
      kind: 'record',
      entity,
      label: name,
      sublabel: [sku && `SKU ${sku}`, hsn && `HSN ${hsn}`, price ? formatCompactINR(price) : ''].filter(Boolean).join(' · ') || undefined,
      href: recordHref('product', row),
      icon: 'box',
      badge: 'Product',
      keywords: [name, sku, hsn, text(row.unit), inrDigits(price)].filter(Boolean).join(' ').toLowerCase(),
    }
  }

  const name = text(row.name)
  if (!name) return null
  const biz = text(row.business_name)
  const gstin = text(row.gstin).toUpperCase()
  const phone = text(row.phone)
  const city = text(row.city)
  return {
    id: `record:${entity}:${id}`,
    kind: 'record',
    entity,
    label: name,
    sublabel: [gstin, biz && biz !== name ? biz : city, phone].filter(Boolean).join(' · ') || undefined,
    href: recordHref(entity, row),
    icon: meta.icon,
    badge: meta.badge,
    keywords: [name, biz, gstin, phone, city].filter(Boolean).join(' ').toLowerCase(),
  }
}

/**
 * One row per destination. A document that is both a recent and a live hit would
 * otherwise render twice, and the two rows would claim the same listbox option id.
 */
export function groupBySection(ranked: Command[]): CommandGroup[] {
  const groups: CommandGroup[] = []
  const seen = new Set<string>()

  function take(items: Command[], cap: number): Command[] {
    const out: Command[] = []
    for (const c of items) {
      if (seen.has(c.href)) continue
      seen.add(c.href)
      out.push(c)
      if (out.length === cap) break
    }
    return out
  }

  const recent = take(ranked.filter(c => c.kind === 'recent'), RECENTS_CAP)
  if (recent.length) groups.push({ title: GROUP_TITLES.recent, kind: 'recent', items: recent })

  const actions = take(ranked.filter(c => c.kind === 'action'), Infinity)
  if (actions.length) groups.push({ title: GROUP_TITLES.action, kind: 'action', items: actions })

  const pages = take(ranked.filter(c => c.kind === 'page'), PAGES_CAP)
  if (pages.length) groups.push({ title: GROUP_TITLES.page, kind: 'page', items: pages })

  for (const entity of RECORD_ORDER) {
    const items = take(ranked.filter(c => c.entity === entity && c.kind === 'record'), RECORDS_PER_GROUP)
    if (!items.length) continue
    groups.push({
      title: ENTITY_META[entity].group,
      kind: 'record',
      entity,
      items,
      moreLabel: `More in ${ENTITY_META[entity].group.toLowerCase()}`,
      moreHref: ENTITY_META[entity].home,
    })
  }
  return groups
}

export function flattenVisible(groups: CommandGroup[]): Command[] {
  return groups.flatMap(g => g.items)
}

export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0
  return Math.min(Math.max(0, i), len - 1)
}

/** Arrow keys stop at the ends rather than wrapping — users expect a wall. */
export function nextIndex(i: number, len: number, delta: number): number {
  return clampIndex(i + delta, len)
}

export function isActiveHref(pathname: string, href: string): boolean {
  if (pathname === href) return true
  // The dashboard is a landing page, not a parent of everything under it.
  return href !== '/dashboard' && pathname.startsWith(href + '/')
}

const RECENTS_KEY = 'taxflow:palette-recents:'

export function recentsKey(orgId: string): string {
  return RECENTS_KEY + orgId
}

function isCommand(v: unknown): v is Command {
  const c = v as Command
  return !!c && typeof c.label === 'string' && typeof c.href === 'string' && isKnownHref(c.href)
}

/**
 * Recents are replayed as "recent" whatever they originally were, so the group
 * order stays honest and a renamed feature cannot strand an old badge.
 */
export function loadRecents(orgId: string): Command[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    const raw = window.localStorage.getItem(recentsKey(orgId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(isCommand)
      .map(c => ({ ...c, kind: 'recent' as CommandKind, id: `recent:${c.href}` }))
      .slice(0, RECENTS_CAP)
  } catch {
    return []
  }
}

export function pushRecent(orgId: string, cmd: Command): Command[] {
  if (typeof window === 'undefined' || !orgId || !cmd?.href) return loadRecents(orgId)
  const entry: Command = { ...cmd, kind: 'recent', id: `recent:${cmd.href}` }
  const rest = loadRecents(orgId).filter(c => c.href !== cmd.href)
  const next = [entry, ...rest].slice(0, RECENTS_CAP)
  try {
    window.localStorage.setItem(recentsKey(orgId), JSON.stringify(next))
  } catch {
    /* private mode or a full quota must not break the palette */
  }
  return next
}
