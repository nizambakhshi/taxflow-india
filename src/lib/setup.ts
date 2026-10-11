// Business setup — where the shop operates, and what its papers are called.
//
// Why this exists: the review that opened R3 names *business setup* as a missing area —
// "multiple GST registrations, branches, financial years and configurable document series".
// Today the app answers both with one hard-coded shape: every document is issued by the one
// primary registration, and every number is `INV-2026-27-0001` — the prefix, the padding and
// the financial-year segment are welded into the code. A shop with a second branch in another
// state cannot print its papers, and a shop whose GST practitioner insists on `A/26/7` cannot
// comply. This register keeps both answers the shop's own.
//
// It rides on localStorage (ADR-013) as `taxflow:setup:<orgId>` at version 1, joins the vault
// in the same round it is created (Rule 31), and holds **no rupee and no statutory standing**:
// a branch is the shop's own paper about where it operates — the durable GST record is the
// government's, and the primary registration still lives in `gst_registrations`. The register
// is what the *document header* prints and what the *number* is shaped from.
//
// The four decisions that make it trustworthy rather than decorative:
//
//  * **A number is shaped, never invented.** The counter stays with the register that owns it
//    (`invoice_sequences` in Supabase, the order-flow stores in the browser); this file only
//    answers *what shape the next integer wears*. A prefix change mid-year is therefore safe:
//    old documents keep the numbers they were born with, and the high-water parse reads every
//    shape the kind has worn (`usedNumber` tries the live format, then the default one).
//  * **A series that can collide is refused, not warned.** Two kinds resolving to the same
//    prefix would issue the same number twice (the counters are independent), so
//    `validateSeries` refuses a collision by name. A prefix must also be printable: letters,
//    digits and inner dashes only, no spaces, no trailing dash, at most eight characters.
//  * **A branch is a full registration or nothing.** Its GSTIN is shape-validated, unique on
//    the register, and its state code must be the two digits the GSTIN itself starts with —
//    a branch claiming Tamil papers with a Karnataka prefix is refused, because place of
//    supply and the CGST/SGST split are both derived from that pair.
//  * **A used name is deactivated, not deleted.** Once a document has been stamped with a
//    branch code (`stampBranchNote` puts `[branch CODE]` at the front of the invoice notes),
//    deleting the branch would leave the paper naming a registration that no longer exists —
//    the same doctrine that makes a recipe with runs on the log un-deletable. Deactivate is
//    the honest exit; delete is offered only for a name no document carries.

const KEY_SETUP = 'taxflow:setup:'
export const SETUP_VERSION = 1

// ── the shape ─────────────────────────────────────────────────────────────────

export type SeriesKind = 'invoice' | 'quotation' | 'challan' | 'sales_order' | 'purchase_order'

export const SERIES_KINDS: SeriesKind[] = ['invoice', 'quotation', 'challan', 'sales_order', 'purchase_order']

/** The three dials of a document number: what it starts with, how wide the count is, and
 *  whether the financial year sits inside it (Rule: every Indian series resets each April). */
export interface SeriesFormat {
  prefix: string
  pad: number
  include_fy: boolean
}

export interface SeriesRow extends SeriesFormat {
  kind: SeriesKind
  updated_at: string
}

/** One place the shop operates under its own registration. `is_head` marks the row that
 *  mirrors the office the statutory pages sign with. */
export interface Branch {
  id: string
  code: string
  name: string
  gstin: string
  /** The two digits the GSTIN starts with — kept as its own field so the split check has both sides. */
  state_code: string
  address: string
  city: string
  phone: string
  is_head: boolean
  active: boolean
  notes: string
  created_at: string
  updated_at: string
}

export interface SetupStore {
  version: number
  updatedAt: string
  orgId: string
  branches: Branch[]
  series: SeriesRow[]
}

/** The shapes every kind was born with — the formats the code used before this register
 *  existed, and the fallback the page shows as *the default*. */
export const DEFAULT_SERIES: Record<SeriesKind, SeriesFormat> = {
  invoice: { prefix: 'INV', pad: 4, include_fy: true },
  quotation: { prefix: 'QT', pad: 4, include_fy: true },
  challan: { prefix: 'DC', pad: 4, include_fy: true },
  sales_order: { prefix: 'SO', pad: 4, include_fy: true },
  purchase_order: { prefix: 'PO', pad: 4, include_fy: true },
}

export const SERIES_KIND_LABEL: Record<SeriesKind, { label: string; plural: string; href: string }> = {
  invoice: { label: 'Tax invoice', plural: 'Tax invoices', href: '/invoices' },
  quotation: { label: 'Quotation', plural: 'Quotations', href: '/quotations' },
  challan: { label: 'Delivery challan', plural: 'Delivery challans', href: '/challans' },
  sales_order: { label: 'Sales order', plural: 'Sales orders', href: '/sales-orders' },
  purchase_order: { label: 'Purchase order', plural: 'Purchase orders', href: '/purchase-orders' },
}

// ── small helpers, local so this register owes nothing to another ─────────────

function nowStamp(): string {
  return new Date().toISOString()
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Same 15-character shape the e-invoice builder checks — checksum digits are not verified
 *  anywhere in this app without a GSP, and pretending otherwise would be a stronger claim
 *  than the register can make. */
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function int(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : fallback
}

// ── read / write ──────────────────────────────────────────────────────────────

function emptyStore(orgId = ''): SetupStore {
  return { version: SETUP_VERSION, updatedAt: '', orgId, branches: [], series: [] }
}

function parseBranch(raw: Record<string, unknown>): Branch | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    code: str(raw.code).trim().toUpperCase(),
    name: str(raw.name).trim(),
    gstin: str(raw.gstin).trim().toUpperCase(),
    state_code: str(raw.state_code).trim(),
    address: str(raw.address).trim(),
    city: str(raw.city).trim(),
    phone: str(raw.phone).trim(),
    is_head: bool(raw.is_head),
    active: bool(raw.active, true),
    notes: str(raw.notes),
    created_at: str(raw.created_at),
    updated_at: str(raw.updated_at),
  }
}

function parseSeriesRow(raw: Record<string, unknown>): SeriesRow | null {
  if (!raw || typeof raw !== 'object') return null
  const kind = str(raw.kind) as SeriesKind
  if (!SERIES_KINDS.includes(kind)) return null
  return {
    kind,
    prefix: str(raw.prefix).trim().toUpperCase(),
    pad: int(raw.pad, 4),
    include_fy: bool(raw.include_fy, true),
    updated_at: str(raw.updated_at),
  }
}

function parseSetup(raw: string | null, orgId: string): SetupStore {
  if (!raw) return emptyStore(orgId)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return emptyStore(orgId)
    if (parsed.version !== SETUP_VERSION) return emptyStore(orgId)
    const branches = Array.isArray(parsed.branches)
      ? parsed.branches
          .map(b => (b && typeof b === 'object' ? parseBranch(b as Record<string, unknown>) : null))
          .filter((b): b is Branch => b !== null)
      : []
    const series = Array.isArray(parsed.series)
      ? parsed.series
          .map(r => (r && typeof r === 'object' ? parseSeriesRow(r as Record<string, unknown>) : null))
          // one row per kind — a hand-edited duplicate keeps the first
          .filter((r, i, all) => r !== null && all.findIndex(x => x?.kind === r!.kind) === i)
          .map(r => r as SeriesRow)
      : []
    return {
      version: SETUP_VERSION,
      updatedAt: str(parsed.updatedAt),
      orgId: str(parsed.orgId) || orgId,
      branches,
      series,
    }
  } catch {
    return emptyStore(orgId)
  }
}

export function loadSetup(orgId: string): SetupStore {
  if (typeof window === 'undefined' || !orgId) return emptyStore()
  return parseSetup(window.localStorage.getItem(KEY_SETUP + orgId), orgId)
}

export function saveSetup(orgId: string, store: SetupStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(KEY_SETUP + orgId, JSON.stringify({ ...store, version: SETUP_VERSION }))
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

/** The tidy write every mutation funnels through — the stamp and the version are the engine's. */
function write(orgId: string, next: Omit<SetupStore, 'version' | 'updatedAt'>): SetupStore {
  const store: SetupStore = { ...next, version: SETUP_VERSION, updatedAt: nowStamp() }
  saveSetup(orgId, store)
  return store
}

// ── series: the shape of a number ─────────────────────────────────────────────

/** The live format for a kind — the shop's row if it has one, the default it was born with if not. */
export function resolveSeries(store: SetupStore, kind: SeriesKind): SeriesFormat {
  const row = store.series.find(s => s.kind === kind)
  return row ? { prefix: row.prefix, pad: row.pad, include_fy: row.include_fy } : { ...DEFAULT_SERIES[kind] }
}

export function isOverridden(store: SetupStore, kind: SeriesKind): boolean {
  return store.series.some(s => s.kind === kind)
}

/** Put the next integer into the shape this kind wears. `n` is counted, never guessed. */
export function composeNumber(fmt: SeriesFormat, n: number, fy: string): string {
  const digits = String(Math.max(0, Math.floor(n))).padStart(Math.max(1, fmt.pad), '0')
  return fmt.include_fy ? `${fmt.prefix}-${fy}-${digits}` : `${fmt.prefix}-${digits}`
}

/** The counter slot a format lives in: financial-year formats reset each April,
 *  running formats keep one count for the life of the series. */
export function seqKeyFor(kind: SeriesKind, fy: string, fmt?: SeriesFormat): string {
  if (!fmt || fmt.include_fy) return `${kind}:${fy}`
  return `${kind}:all`
}

/**
 * Read the count back out of a number. A kind may have worn more than one shape in its life
 * (the shop changed its prefix mid-year), so the caller hands in every shape it has worn and
 * the first match wins. A number that is not of this family returns null — the high-water walk
 * simply passes it by.
 */
export function usedNumber(formats: SeriesFormat[], fy: string, number: string): number | null {
  for (const fmt of formats) {
    const re = fmt.include_fy
      ? new RegExp(`^${esc(fmt.prefix)}-${esc(fy)}-(\\d+)$`)
      : new RegExp(`^${esc(fmt.prefix)}-(\\d+)$`)
    const m = re.exec(number.trim())
    if (m) return parseInt(m[1], 10)
  }
  return null
}

/** The trailing count of any number wearing this prefix, year segment or not — the wide
 *  net a *running* series casts: when the shop drops the year from its numbers, the last
 *  count of the year-shaped family still stands, so the running series never re-issues one. */
export function usedNumberAnyYear(prefix: string, number: string): number | null {
  const m = new RegExp(`^${esc(prefix.trim().toUpperCase())}-(?:\\d{4}-\\d{2}-)?(\\d+)$`).exec(number.trim())
  return m ? parseInt(m[1], 10) : null
}

/** Every shape this kind has worn: the live format first, the birth format if it differs —
 *  so numbers made before a change still count against the high-water mark. */
export function seriesHistory(fmt: SeriesFormat, kind: SeriesKind): SeriesFormat[] {
  const born = DEFAULT_SERIES[kind]
  const same = born.prefix === fmt.prefix && born.pad === fmt.pad && born.include_fy === fmt.include_fy
  return same ? [born] : [fmt, born]
}

export function newSeriesRow(kind: SeriesKind): SeriesRow {
  return { kind, ...DEFAULT_SERIES[kind], updated_at: '' }
}

/** Every rule a series row must satisfy before it may shape a document's number. */
export function validateSeries(row: SeriesRow, store: SetupStore): string[] {
  const problems: string[] = []
  const prefix = row.prefix.trim().toUpperCase()
  if (!prefix) problems.push('Say what the number should start with — a series needs a prefix.')
  else if (!/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/.test(prefix)) {
    problems.push('A prefix carries letters, digits and inner dashes only — no spaces, no leading or trailing dash.')
  } else if (prefix.length > 8) problems.push('Keep the prefix to eight characters — it prints on every page.')
  if (!Number.isFinite(row.pad) || row.pad < 1 || row.pad > 8) {
    problems.push('The count is 1 to 8 digits wide — pad it with zeroes inside that range.')
  }
  // A collision is refused because the counters are per kind: two kinds sharing a prefix
  // would each happily issue TAX-2026-27-0001 and the shop would not find out until a customer
  // held both papers.
  const clash = store.series.find(s => s.kind !== row.kind && s.prefix.toUpperCase() === prefix)
  if (prefix && clash) {
    problems.push(`${prefix} already numbers ${SERIES_KIND_LABEL[clash.kind].plural.toLowerCase()} — two series with one prefix would issue the same number twice.`)
  }
  return problems
}

/** Save or overrule a kind's format. Refuses through `validateSeries`; writes nothing on a problem. */
export function writeSeries(
  orgId: string,
  row: SeriesRow,
): { ok: true; store: SetupStore } | { ok: false; problems: string[] } {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadSetup(orgId)
  const clean: SeriesRow = {
    ...row,
    prefix: row.prefix.trim().toUpperCase(),
    pad: Math.floor(row.pad),
    updated_at: nowStamp(),
  }
  const problems = validateSeries(clean, store)
  if (problems.length > 0) return { ok: false, problems }
  const others = store.series.filter(s => s.kind !== clean.kind)
  write(orgId, { orgId, branches: store.branches, series: [...others, clean] })
  return { ok: true, store: loadSetup(orgId) }
}

/** Hand a kind back to the shape it was born with. */
export function clearSeries(orgId: string, kind: SeriesKind): SetupStore {
  const store = loadSetup(orgId)
  const next = { ...store, series: store.series.filter(s => s.kind !== kind) }
  return write(orgId, { orgId, branches: next.branches, series: next.series })
}

// ── branches: where the shop operates ─────────────────────────────────────────

export function newBranch(): Branch {
  const at = nowStamp()
  return {
    id: newId(),
    code: '',
    name: '',
    gstin: '',
    state_code: '',
    address: '',
    city: '',
    phone: '',
    is_head: false,
    active: true,
    notes: '',
    created_at: at,
    updated_at: at,
  }
}

/** Every rule a branch must satisfy before it may sign a document. */
export function validateBranch(b: Branch, branches: Branch[]): string[] {
  const problems: string[] = []
  const code = b.code.trim().toUpperCase()
  const gstin = b.gstin.trim().toUpperCase()
  if (!code) problems.push('Give the branch a short code — it is what a document stamps.')
  else if (!/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/.test(code) || code.length > 8) {
    problems.push('A branch code carries letters, digits and inner dashes only, up to eight characters.')
  } else if (branches.some(x => x.id !== b.id && x.code.toUpperCase() === code)) {
    problems.push(`Code ${code} is already on the register — one code, one branch.`)
  }
  if (!b.name.trim()) problems.push('Say what the branch is called — the header prints this name.')
  if (!gstin) problems.push('A branch is a registration: it needs its own GSTIN.')
  else if (!GSTIN_RE.test(gstin)) problems.push(`${gstin} is not a 15-character GSTIN shape — check it against the certificate.`)
  else if (branches.some(x => x.id !== b.id && x.gstin.toUpperCase() === gstin)) {
    problems.push(`${gstin} already belongs to another branch — one registration, one place.`)
  }
  // The pair that every tax split derives from has to agree with itself.
  const st = b.state_code.trim()
  if (st && gstin && st !== gstin.slice(0, 2)) {
    problems.push(`The GSTIN starts with ${gstin.slice(0, 2)} — a Tamil registration cannot carry a ${st} branch. Place of supply and the CGST/SGST split read this pair.`)
  }
  if (!st && gstin) problems.push('The state code is missing — it should be the first two digits of the GSTIN.')
  return problems
}

/** The single door for one branch. Validates, then upserts; refuses and writes nothing on a problem. */
export function writeBranch(
  orgId: string,
  branch: Branch,
): { ok: true; store: SetupStore } | { ok: false; problems: string[] } {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadSetup(orgId)
  const gstin = branch.gstin.trim().toUpperCase()
  const clean: Branch = {
    ...branch,
    code: branch.code.trim().toUpperCase(),
    name: branch.name.trim(),
    gstin,
    // the page auto-fills from the GSTIN; the engine keeps the two honest even from a raw write
    state_code: (branch.state_code.trim() || gstin.slice(0, 2)),
    address: branch.address.trim(),
    city: branch.city.trim(),
    phone: branch.phone.trim(),
    updated_at: nowStamp(),
  }
  const problems = validateBranch(clean, store.branches)
  if (problems.length > 0) return { ok: false, problems }
  const exists = store.branches.some(b => b.id === clean.id)
  if (!exists) clean.created_at = nowStamp()
  // exactly one head: promoting this row demotes every other, in the same write
  const branches = store.branches
    .filter(b => b.id !== clean.id)
    .map(b => (clean.is_head && b.is_head ? { ...b, is_head: false } : b))
  write(orgId, { orgId, branches: [...branches, clean], series: store.series })
  return { ok: true, store: loadSetup(orgId) }
}

export function headBranch(store: SetupStore): Branch | undefined {
  return store.branches.find(b => b.is_head)
}

export function activeBranches(store: SetupStore): Branch[] {
  return store.branches.filter(b => b.active)
}

export function branchByCode(store: SetupStore, code: string): Branch | undefined {
  const want = code.trim().toUpperCase()
  return store.branches.find(b => b.code.toUpperCase() === want)
}

/** Hand the head over in one deliberate act — two heads would make the header ask which office signed. */
export function setHead(orgId: string, id: string): { ok: true; store: SetupStore } | { ok: false; problem: string } {
  const store = loadSetup(orgId)
  const target = store.branches.find(b => b.id === id)
  if (!target) return { ok: false, problem: 'That branch is not on the register.' }
  if (!target.active) return { ok: false, problem: 'A closed branch cannot be the head — open it first.' }
  const branches = store.branches.map(b => ({ ...b, is_head: b.id === id }))
  write(orgId, { orgId, branches, series: store.series })
  return { ok: true, store: loadSetup(orgId) }
}

/**
 * Delete a branch — only while no document carries its name. Once papers are stamped with the
 * code the row is history: deactivate it, and the papers keep resolving to the place they were
 * issued from. `referenced` is computed by the page from the invoice notes, not trusted from the modal.
 */
export function deleteBranch(
  orgId: string,
  id: string,
  referenced: boolean,
): { ok: true; store: SetupStore } | { ok: false; problems: string[] } {
  const store = loadSetup(orgId)
  const target = store.branches.find(b => b.id === id)
  if (!target) return { ok: false, problems: ['That branch is not on the register.'] }
  const problems: string[] = []
  if (target.is_head) problems.push('This is the head office — hand the head over first, or the header loses the signature it prints by default.')
  if (referenced) problems.push(`Documents are stamped with ${target.code} — closing the name would leave that paper naming a branch that no longer exists. Deactivate it instead.`)
  if (problems.length > 0) return { ok: false, problems }
  write(orgId, { orgId, branches: store.branches.filter(b => b.id !== id), series: store.series })
  return { ok: true, store: loadSetup(orgId) }
}

/** Open or close a branch. A closed branch stops being offered to new documents; its old
 *  documents still resolve to it — history does not go out of business. */
export function setBranchActive(orgId: string, id: string, active: boolean): { ok: true; store: SetupStore } | { ok: false; problem: string } {
  const store = loadSetup(orgId)
  const target = store.branches.find(b => b.id === id)
  if (!target) return { ok: false, problem: 'That branch is not on the register.' }
  if (!active && target.is_head) return { ok: false, problem: 'The head office cannot be closed while it is the head — hand the head over first.' }
  const branches = store.branches.map(b => (b.id === id ? { ...b, active, updated_at: nowStamp() } : b))
  write(orgId, { orgId, branches, series: store.series })
  return { ok: true, store: loadSetup(orgId) }
}

// ── the stamp a document carries ──────────────────────────────────────────────
//
// A branch is chosen at the counter; the invoice row has no branch column (the schema is
// hand-managed), so the choice travels the way the Tally reference and the attendance tag do:
// a bracketed sentence at the front of the notes. It is replaced, never stacked, and text the
// shop typed after the em dash survives a re-stamp.

const BRANCH_TAG_RE = /^\[branch ([^\]]+)\]\s*/

/** Read the code a document was issued under — '' when the paper carries no stamp. */
export function branchCodeOf(notes: string): string {
  const m = BRANCH_TAG_RE.exec(notes || '')
  return m ? m[1].trim().toUpperCase() : ''
}

/** The shop's own words with the stamp taken off — what the notes field shows after the picker. */
export function untaggedNotes(notes: string): string {
  return (notes || '').replace(BRANCH_TAG_RE, '').trim()
}

/**
 * Write the stamp. code '' clears it (back to the head office); a tag already present is
 * replaced, so re-saving a document on another branch never stacks two signatures.
 */
export function stampBranchNote(notes: string, code: string): string {
  const body = untaggedNotes(notes)
  const clean = code.trim().toUpperCase()
  if (!clean) return body
  return body ? `[branch ${clean}] ${body}` : `[branch ${clean}]`
}

// ── one-line answers the pages print ──────────────────────────────────────────

/** What the next number of a kind will look like, without counting it. */
export function seriesExample(store: SetupStore, kind: SeriesKind, fy: string, n = 1): string {
  return composeNumber(resolveSeries(store, kind), n, fy)
}

/** The register's own sentence about a kind — printed beside the format editor. */
export function seriesSentence(store: SetupStore, kind: SeriesKind, fy: string): string {
  const fmt = resolveSeries(store, kind)
  const shape = fmt.include_fy
    ? `${fmt.prefix}‑‹FY›‑‹count›`
    : `${fmt.prefix}‑‹count›`
  const reset = fmt.include_fy
    ? `Resets each April — next up in ${fy}: ${seriesExample(store, kind, fy)}`
    : 'One running count — no year inside the number'
  return `Shape ${shape}, ${fmt.pad} digits. ${reset}.`
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const BRANCH_CSV_HEADERS = [
  'Code', 'Name', 'GSTIN', 'State code', 'Address', 'City', 'Phone', 'Head office', 'Status', 'Notes',
]

export function branchCsvRows(branches: Branch[]): (string | number)[][] {
  return branches.map(b => [
    b.code, b.name, b.gstin, b.state_code, b.address, b.city, b.phone,
    b.is_head ? 'yes' : '', b.active ? 'open' : 'closed', b.notes,
  ])
}

export const SERIES_CSV_HEADERS = ['Document kind', 'Prefix', 'Digits', 'Year inside number', 'Next example', 'Source']

export function seriesCsvRows(store: SetupStore, fy: string): (string | number)[][] {
  return SERIES_KINDS.map(k => {
    const fmt = resolveSeries(store, k)
    return [
      SERIES_KIND_LABEL[k].plural, fmt.prefix, fmt.pad, fmt.include_fy ? 'yes' : 'no',
      composeNumber(fmt, 1, fy), isOverridden(store, k) ? 'shop' : 'default',
    ]
  })
}
