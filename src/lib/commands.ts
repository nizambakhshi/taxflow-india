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
import { docValue, loadStore } from '@/lib/orderflow'

export type CommandKind = 'recent' | 'action' | 'page' | 'record'

/** Entities backed by Supabase tables (async search) — everything else is local. */
export type RecordEntity =
  | 'invoice'
  | 'purchase_bill'
  | 'credit_note'
  | 'debit_note'
  | 'quotation'
  | 'customer'
  | 'vendor'
  | 'product'

/** Order-flow documents live in localStorage (ADR-013) — searched synchronously. */
export type OrderEntity = 'challan' | 'sales_order' | 'purchase_order'

export type EntityKind = RecordEntity | OrderEntity

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
export const SUPABASE_RECORD_ORDER: RecordEntity[] = [
  'invoice',
  'customer',
  'vendor',
  'product',
  'purchase_bill',
  'credit_note',
  'debit_note',
  'quotation',
]

export const ORDER_ENTITIES: OrderEntity[] = ['challan', 'sales_order', 'purchase_order']

/** Display order for record groups — local order documents sit after the rest. */
export const RECORD_ORDER: EntityKind[] = [...SUPABASE_RECORD_ORDER, ...ORDER_ENTITIES]

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

export const ENTITY_SPECS: Record<RecordEntity, EntitySpec> = {
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
  challan: { group: 'Challans', badge: 'Challan', icon: 'truck', home: '/challans' },
  sales_order: { group: 'Sales orders', badge: 'Sales order', icon: 'bag', home: '/sales-orders' },
  purchase_order: { group: 'Purchase orders', badge: 'Purchase order', icon: 'clipboard-check', home: '/purchase-orders' },
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

/** A user pastes a GSTIN with spaces and case; matching should not care. Splitting
 *  on every non-alphanumeric also lets "INV-2024-001" match the label's words. */
function queryTokens(q: string): string[] {
  return q.split(/[^a-z0-9]+/).filter(Boolean)
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

export function orFilter(entity: RecordEntity, q: string): string | null {
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
 * Prefixes whose children are known routes — only entities with a detail page.
 * Matching every parent loosely would let a stale '/gst/annual' recent — a route
 * that 404s — look valid, which is the whole thing this check exists to prevent.
 */
const DYNAMIC_CHILD_PREFIXES = ['/invoices/', '/challans/', '/sales-orders/', '/purchase-orders/']

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
      id: 'action:new-recurring',
      kind: 'action',
      label: 'New recurring invoice',
      sublabel: 'Set up a retainer, rent or AMC',
      href: '/recurring?new=1',
      icon: 'repeat',
      badge: 'Action',
      keywords: 'create add recurring invoice schedule subscription retainer rent amc monthly periodic auto',
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
    {
      id: 'action:new-challan',
      kind: 'action',
      label: 'New challan',
      sublabel: 'Dispatch goods before invoicing',
      href: '/challans?new=1',
      icon: 'truck',
      badge: 'Action',
      keywords: 'create add challan delivery dispatch goods movement',
    },
    {
      id: 'action:new-sales-order',
      kind: 'action',
      label: 'New sales order',
      sublabel: 'Book a customer order',
      href: '/sales-orders?new=1',
      icon: 'bag',
      badge: 'Action',
      keywords: 'create add sales order customer booking so',
    },
    {
      id: 'action:new-purchase-order',
      kind: 'action',
      label: 'New purchase order',
      sublabel: 'Commit a supplier order',
      href: '/purchase-orders?new=1',
      icon: 'clipboard-check',
      badge: 'Action',
      keywords: 'create add purchase order supplier vendor po',
    },
    {
      id: 'action:new-batch',
      kind: 'action',
      label: 'Add batch',
      sublabel: 'Register a lot with its expiry',
      href: '/inventory/batches?new=1',
      icon: 'clock',
      badge: 'Action',
      keywords: 'create add batch lot expiry stock receive inventory',
    },
    {
      id: 'action:new-godown',
      kind: 'action',
      label: 'Add godown',
      sublabel: 'Register a place stock is kept in',
      href: '/inventory/godowns?new=1',
      icon: 'warehouse',
      badge: 'Action',
      keywords: 'create add godown warehouse place location stock inventory transfer move',
    },
    {
      id: 'action:new-serial',
      kind: 'action',
      label: 'Add serial numbers',
      sublabel: 'Register units by their serials',
      href: '/inventory/serials?new=1',
      icon: 'hash',
      badge: 'Action',
      keywords: 'create add serial number imei unit register inventory warranty',
    },
    {
      id: 'action:new-fx-deal',
      kind: 'action',
      label: 'New foreign-currency deal',
      sublabel: 'Value an invoice in its own currency',
      href: '/fx?new=1',
      icon: 'globe',
      badge: 'Action',
      keywords: 'create add foreign currency multi currency usd dollar euro pound dirham riyal exchange rate conversion firc realisation export',
    },
    {
      id: 'action:new-job-work',
      kind: 'action',
      label: 'Record job-work movement',
      sublabel: 'Goods sent out for job work',
      href: '/gst/job-work?new=1',
      icon: 'factory',
      badge: 'Action',
      keywords: 'create add job work itc04 itc-04 sent to job worker processing inputs capital goods moulds dies tools rule 45 section 143 bring back deemed supply challan',
    },
    {
      id: 'action:new-export-file',
      kind: 'action',
      label: 'Record export file',
      sublabel: 'A consignment that left India',
      href: '/gst/exports?new=1',
      icon: 'ship',
      badge: 'Action',
      keywords: 'create add export overseas foreign buyer shipping bill lut letter of undertaking rfd-11 rfd-1 zero rated igst refund realisation firc e-brc fema proceeds window advance grace period',
    },
    {
      id: 'action:new-cost-centre',
      kind: 'action',
      label: 'New cost centre',
      sublabel: 'Split a bill or invoice across centres',
      href: '/cost-centres?new=1',
      icon: 'layers',
      badge: 'Action',
      keywords: 'create add cost centre department project branch allocation split revenue expense contribution management account margin tag document part of business',
    },
    {
      id: 'action:new-project',
      kind: 'action',
      label: 'New project',
      sublabel: 'A job to keep hours and documents beside',
      href: '/projects?new=1',
      icon: 'briefcase',
      badge: 'Action',
      keywords: 'create add project job work order site fitout retainer internal build client billing time material fixed price internal non billable register start date target budget',
    },
    {
      id: 'action:log-hour',
      kind: 'action',
      label: 'Log an hour',
      sublabel: 'Put time on the register against a project',
      href: '/projects?log=1',
      icon: 'clock',
      badge: 'Action',
      keywords: 'log time hours timesheet attendance effort man days manpower rate per hour billing rate unbilled paste invoice line who did it person entry',
    },
    {
      id: 'action:unbilled-work',
      kind: 'action',
      label: 'Open the unbilled register',
      sublabel: 'Delivered work with no invoice, by month and due date',
      href: '/projects?view=tobill',
      icon: 'invoice',
      badge: 'Action',
      keywords: 'unbilled not invoiced pending work rule 47 30 days invoice due date overdue late window compliance time material billable hours value lapse forgotten invoice raise',
    },
    {
      id: 'action:new-employee',
      kind: 'action',
      label: 'Add a person to the payroll',
      sublabel: 'A salary structure, an age band and a provident fund choice',
      href: '/payroll?tab=people&new=1',
      icon: 'users',
      badge: 'Action',
      keywords: 'create add employee staff payroll salary structure basic da allowances hra transport medical age band senior citizen below 60 provident fund pf eps edli esi professional tax state joining date leaving date hours per day person head monthly active inactive register',
    },
    {
      id: 'action:payroll-month',
      kind: 'action',
      label: 'Run this month\'s salary',
      sublabel: 'Open the month, walk section 192, read the register',
      href: '/payroll?tab=month',
      icon: 'wallet',
      badge: 'Action',
      keywords: 'payroll run month salary register payslip slip tds 192 tax walk instalment advance lost period deduction lop arrears bonus recovery net pay employer cost gross open month attendance row divisor standard days calendar days attendance sheet paste import lop absent present day grid supervisor roster mark',
    },
    {
      id: 'action:payroll-dues',
      kind: 'action',
      label: 'Open the statutory dues',
      sublabel: 'PF, ESI, salary tax and professional tax, with their dates',
      href: '/payroll?tab=dues',
      icon: 'file-check',
      badge: 'Action',
      keywords: 'statutory dues pf esi epfo esic challan 281 deposit due date 15th 7th professional tax state form 16 traces nothing due heads missing csv download salary tax employer contribution ecr return period',
    },
    {
      id: 'action:payroll-annual',
      kind: 'action',
      label: 'Open the annual salary sheet',
      sublabel: 'One row a person, shaped like Form 16 Part B',
      href: '/payroll?tab=annual',
      icon: 'clipboard',
      badge: 'Action',
      keywords: 'annual form 16 part b salary payable standard deduction 75000 section 16 ia professional tax 16 iii cap 2500 rebate 87a surcharge marginal relief cess taxable income tds deducted difference year tax employee wise csv sheet workpaper',
    },
    {
      id: 'action:payslip',
      kind: 'action',
      label: 'Print a payslip',
      sublabel: 'One person, one month, as the sheet they keep',
      href: '/payroll/payslip?mode=single',
      icon: 'printer',
      badge: 'Action',
      keywords: 'payslip pay slip salary certificate employee copy a4 print pdf net payable words allowances basic da hra conveyance medical deductions provident fund esi professional tax tax on signature letterhead sheet paper month slip',
    },
    {
      id: 'action:payslip-month',
      kind: 'action',
      label: 'Print the month’s payslips',
      sublabel: 'Every slip on the rolls, one sheet a person in one PDF',
      href: '/payroll/payslip?mode=month',
      icon: 'printer',
      badge: 'Action',
      keywords: 'payslip batch all employees month pack pdf bulk salary sheets together everyone month run payroll disbursement list totals refused inactive join leave pack set',
    },
    {
      id: 'action:payslip-letterhead',
      kind: 'action',
      label: 'Write the payslip letterhead',
      sublabel: 'Employer name, address, PF establishment code, ESIC code, PAN, GSTIN, signatory',
      href: '/payroll/payslip?letterhead=1',
      icon: 'edit',
      badge: 'Action',
      keywords: 'letterhead employer name address city pincode state phone email pan gstin pf establishment code epfo esic esi code place signatory authorised signatory header branding fills blank gap dash codes',
    },
    {
      id: 'action:new-recipe',
      kind: 'action',
      label: 'New recipe',
      sublabel: 'Write down what a finished good is made of',
      href: '/inventory/recipes?new=1',
      icon: 'recipe',
      badge: 'Action',
      keywords: 'create add recipe bom bill of materials manufacturing production make formula components parts wastage sub assembly gift box sweet shop assembler job card register what goes into',
    },
    {
      id: 'action:new-build',
      kind: 'action',
      label: 'Record a build',
      sublabel: 'Draw the components, put the finished units on the shelf',
      href: '/inventory/recipes?build=1',
      icon: 'play',
      badge: 'Action',
      keywords: 'record build production run manufacture job number material consumption stock movements draw components wastage variance plan can make today shortfall shelf units finished good',
    },
    {
      id: 'action:tally-import',
      kind: 'action',
      label: 'Read a Tally export',
      sublabel: 'Turn a .xml file into a plan of rows',
      href: '/tally',
      icon: 'tally',
      badge: 'Action',
      keywords: 'tally tallyprime tally.erp import xml data file migrate migration ledger voucher sundry debtors creditors stock item company books another software erp bring in log history already imported',
    },
    {
      id: 'action:tally-export',
      kind: 'action',
      label: 'Send my books to Tally',
      sublabel: 'Write chosen invoices and bills as Tally XML',
      href: '/tally?view=export',
      icon: 'tally',
      badge: 'Action',
      keywords: 'tally tallyprime export xml data file send handover migrate migration erp masters ledgers stock items vouchers create alter download',
    },
    {
      id: 'action:tally-sample',
      kind: 'action',
      label: 'Try the Tally bridge on a sample',
      sublabel: 'A ready-made file, planned but not written',
      href: '/tally?sample=1',
      icon: 'zap',
      badge: 'Action',
      keywords: 'tally sample demo example try test bridge import xml plan practice learn what it does',
    },
    {
      id: 'action:vault-backup',
      kind: 'action',
      label: 'Back up my books',
      sublabel: 'Write every device-side register into one vault file',
      href: '/vault?tab=backup',
      icon: 'shield',
      badge: 'Action',
      keywords: 'backup back up vault safe copy download file json registers portable save protect browser wipe clear cache change laptop device new computer handover ca accountant transfer migrate restore point batches serials godowns lut workpapers targets splits settings export data my books are safe',
    },
    {
      id: 'action:vault-restore',
      kind: 'action',
      label: 'Restore from a vault file',
      sublabel: 'Put registers back through the pages that own them',
      href: '/vault?tab=restore',
      icon: 'undo',
      badge: 'Action',
      keywords: 'restore put back recover vault file json upload pick import another device new laptop browser wiped lost data undo replace registers batches serials godowns lut workpapers targets splits settings checksum damaged truncated plan',
    },
  ]
}

export function handleFor(entity: RecordEntity, row: EntityRow): string {
  const spec = ENTITY_SPECS[entity]
  return entity === 'invoice' || spec.numberField
    ? text(row[spec.numberField ?? ''])
    : text(row.name)
}

export function recordHref(entity: RecordEntity, row: EntityRow): string {
  const home = ENTITY_META[entity].home
  if (entity === 'invoice') return `${home}/${text(row.id)}`
  return `${home}?q=${encodeURIComponent(handleFor(entity, row))}`
}

export function toCommand(entity: RecordEntity, row: EntityRow): Command | null {
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
 * Order-flow documents live in localStorage (ADR-013), so their live search is
 * synchronous — no round-trip, no debounce, no loader row. Returned as plain
 * record commands so the same ranker and grouping apply as everywhere else.
 * Every kind has a detail route, so the href opens the document itself.
 */
export function orderRecordCommands(orgId: string, query: string): Command[] {
  const q = normalizeQuery(query)
  if (!q || !orgId || typeof window === 'undefined') return []
  const out: Command[] = []
  for (const kind of ORDER_ENTITIES) {
    const meta = ENTITY_META[kind]
    for (const doc of loadStore(kind, orgId).docs) {
      if (doc.status === 'cancelled') continue
      const value = docValue(doc)
      out.push({
        id: `record:${kind}:${doc.id}`,
        kind: 'record',
        entity: kind,
        label: doc.number,
        sublabel: [doc.party_name, formatDateIN(doc.doc_date), formatCompactINR(value)].filter(Boolean).join(' · '),
        href: `${meta.home}/${doc.id}`,
        icon: meta.icon,
        badge: meta.badge,
        keywords: [doc.number, doc.party_name, doc.party_gstin, doc.status,
          doc.converted_to_number ?? '', inrDigits(value), String(value)]
          .filter(Boolean).join(' ').toLowerCase(),
      })
    }
  }
  return out
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
