// The journal — money the documents cannot carry, named instead of counted as a plug.
//
// Why this exists: the review that opened R3 names *accounting depth* as missing — "a proper
// double-entry journal, opening balances, journal adjustments and bank reconciliation controls".
// The first half of that sentence was answered in pieces (R3-2 gave the opening day a date and
// three gated lines), but the app still had no answer for the rupee that is real, lawful and has
// no paper: depreciation on the machine, a bank charge pulled straight from the statement, the
// owner taking money out of the till, a provision for a GST demand the notice has raised but the
// bill has not. On `/accounting` every one of those lands in **"Capital account (derived)"** — a
// balancing figure the engine invents so the sheet ties, and the shop can see how big its ignorance
// is but never what it is made of. This register is how that figure gets a name: the shop writes a
// **journal entry**, the statements read it, and the money moves out of the plug into a line the
// shop itself called.
//
// It rides on localStorage (ADR-013) as `taxflow:journal:<orgId>` at version 1, joins the vault in
// the same round it is created (Rule 31), and unlike its neighbours it **does hold rupees** — but
// only as *named movements*, never as a posted general ledger. There is no chart of accounts, no
// trial balance, no journal in the statutory sense, and no return reads a row from here.
//
// The four decisions that make it trustworthy rather than decorative:
//
//  * **An entry balances, or it is not an entry.** `validateLegs` sums both sides in paise and
//    refuses a rupee of difference. A draft may be unbalanced — a shop is allowed to type the
//    debit tonight and find the credit tomorrow — but `postEntry` refuses it, so nothing that is
//    not a whole entry can ever reach a statement. And because the fold is double-entry, a
//    *balanced* journal provably leaves `balancingReserve` exactly where it was (ΔAssets = ΔLiab.
//    + ΔCapital + ΔRetained, by construction). That is the round's real claim: the journal cannot
//    break the balance sheet, and it cannot fix it either — it can only name what the plug was
//    counting.
//  * **A posted entry is reversed, never edited or deleted.** `writeEntry` refuses to change a
//    posted row and `deleteEntry` refuses to remove one; `reverseEntry` writes a mirror — every
//    leg re-summoned from the original, its side flipped, its head and rupee unchanged, its note
//    saying which entry it answers — and links both rows. The books keep both, the fold nets them
//    to nothing, and an auditor sees the correction instead of a vanished entry. Same doctrine as
//    a run that has been sold on (R2-29) and a seal that is released rather than deleted (R3-1).
//  * **The seal is the second door.** `postEntry`, `reverseEntry` and the draft write all ask
//    `askSeal` for the entry's own date. A date inside a standing seal is refused *before any leg
//    is checked*, and the ask itself appends a `refused` event — so a closed period cannot be
//    journalled into, and the attempt to try is on the trail. R3-5 put the same door onto the
//    shared document writers, which means the journal and the money documents now refuse a sealed
//    date in the register's own words; `/audit` prints which paths are covered by it.
//  * **A head that has been used is closed, not deleted.** Heads are the shop's own names — not a
//    statutory chart — and each declares *which line of the statements it moves* (`slot`), so no
//    rupee can be filed under an undeclared place. While any leg references a head, deleting it is
//    refused, because the entry that carries the rupee still has to read.
//
// What v1 deliberately does NOT do: it is not a general ledger — there is no account code, no
// parent/child chart, no running balance per head beyond what `headBalance` reads on demand, and
// nothing here can be posted to another journal. It files nothing: a GST liability leg moves the
// balance sheet only, and never touches GSTR-1, 3B or 9. It settles nothing: a journal cannot pay a
// bill, reduce an invoice's `balance_due`, or stand in for a row in `/payments`. And it does not
// reach the bank — the review's *reconciliation controls* half stays where it already lives, on
// `/bank`, which matches statements to documents and has no interest in a journal row.

import { askSeal } from '@/lib/audit'
import {
  DEFAULT_SERIES, composeNumber, loadSetup, resolveSeries, seqKeyFor, seriesHistory, usedNumber, usedNumberAnyYear,
  type SeriesFormat, type SeriesKind,
} from '@/lib/setup'

/** The business register owns the *shape* of a number; this register owns its own count (Rule 39).
 *  Read through `setup.ts` so the two can never disagree about what a journal number looks like. */
function loadSetupFor(orgId: string) {
  return loadSetup(orgId)
}

const KEY_JOURNAL = 'taxflow:journal:'
export const JOURNAL_VERSION = 1
/** The series kind this register dresses its numbers from — the sixth shape on /business. */
export const JOURNAL_SERIES_KIND: SeriesKind = 'journal'

// ── where a head's rupee lands ────────────────────────────────────────────────
//
// A head is not free text on a money field: it declares which line of the derived statements its
// movement moves, and the engine owns that list. `natural` is the side the line *grows* on —
// assets and expenses grow on a debit, liabilities, capital and income on a credit — and it is the
// only place the sign convention lives, so a fold cannot get an income leg backwards.

export type StatementSlot =
  | 'revenue' | 'purchases' | 'expense'
  | 'receivables' | 'inventory' | 'cash' | 'bank' | 'fixedAssets' | 'otherAsset'
  | 'payables' | 'outstandingExpenses' | 'gstLiability' | 'loans' | 'otherLiability'
  | 'capital'

export type HeadGroup = 'asset' | 'liability' | 'capital' | 'income' | 'expense'

export interface SlotMeta {
  label: string
  group: HeadGroup
  natural: 'debit' | 'credit'
  /** Which statement the line belongs to. `pl` is the period view, `bs` is the position view. */
  where: 'pl' | 'bs'
  /** The BalanceSheet field this slot folds into, for the page that prints the sub-line. */
  onto: string
}

export const SLOTS: StatementSlot[] = [
  'revenue', 'purchases', 'expense',
  'receivables', 'inventory', 'cash', 'bank', 'fixedAssets', 'otherAsset',
  'payables', 'outstandingExpenses', 'gstLiability', 'loans', 'otherLiability',
  'capital',
]

export const SLOT_META: Record<StatementSlot, SlotMeta> = {
  revenue: { label: 'Revenue', group: 'income', natural: 'credit', where: 'pl', onto: 'revenue' },
  purchases: { label: 'Purchases', group: 'expense', natural: 'debit', where: 'pl', onto: 'purchases' },
  expense: { label: 'An expense (by its own name)', group: 'expense', natural: 'debit', where: 'pl', onto: 'expensesByCategory' },
  receivables: { label: 'Sundry debtors', group: 'asset', natural: 'debit', where: 'bs', onto: 'receivables' },
  inventory: { label: 'Stock on hand', group: 'asset', natural: 'debit', where: 'bs', onto: 'inventory' },
  cash: { label: 'Cash in hand', group: 'asset', natural: 'debit', where: 'bs', onto: 'cash' },
  bank: { label: 'Cash at bank', group: 'asset', natural: 'debit', where: 'bs', onto: 'bank' },
  fixedAssets: { label: 'Fixed assets', group: 'asset', natural: 'debit', where: 'bs', onto: 'fixedAssets' },
  otherAsset: { label: 'Any other asset', group: 'asset', natural: 'debit', where: 'bs', onto: 'otherAssets' },
  payables: { label: 'Sundry creditors', group: 'liability', natural: 'credit', where: 'bs', onto: 'payables' },
  outstandingExpenses: { label: 'Outstanding expenses', group: 'liability', natural: 'credit', where: 'bs', onto: 'outstandingExpenses' },
  gstLiability: { label: 'GST payable', group: 'liability', natural: 'credit', where: 'bs', onto: 'gstLiability' },
  loans: { label: 'Loans', group: 'liability', natural: 'credit', where: 'bs', onto: 'loans' },
  otherLiability: { label: 'Any other liability', group: 'liability', natural: 'credit', where: 'bs', onto: 'otherLiabilities' },
  capital: { label: "Owner's capital", group: 'capital', natural: 'credit', where: 'bs', onto: 'journalCapital' },
}

export const GROUP_LABEL: Record<HeadGroup, string> = {
  asset: 'Assets', liability: 'Liabilities', capital: "Owner's funds", income: 'Income', expense: 'Expenses',
}

/** Heads grouped the way the picker shows them — one select per group, no free-text category. */
export const SLOTS_BY_GROUP: HeadGroup[] = ['asset', 'liability', 'capital', 'income', 'expense']

export function slotsInGroup(group: HeadGroup): StatementSlot[] {
  return SLOTS.filter(s => SLOT_META[s].group === group)
}

// ── the shape ─────────────────────────────────────────────────────────────────

export interface JournalHead {
  id: string
  name: string
  slot: StatementSlot
  /** A closed head stops being offered to new entries; entries already carrying it still read. */
  active: boolean
  notes: string
  created_at: string
  updated_at: string
}

export type LegSide = 'debit' | 'credit'
export const LEG_SIDES: LegSide[] = ['debit', 'credit']

export interface JournalLeg {
  id: string
  head_id: string
  side: LegSide
  /** Rupees, always positive — the side carries the direction, never the sign (Rule 28). */
  amount: number
  note: string
}

export type EntryStatus = 'draft' | 'posted' | 'reversed'

export interface JournalEntry {
  id: string
  /** '' until it is posted. A draft has no number, so deleting one cannot punch a hole in a
   *  series an auditor reads — the count is taken at the moment the entry becomes paper. */
  number: string
  date: string
  narration: string
  /** What the shop is being asked for when the entry is quoted back: a voucher no., a notice, a statement line. */
  reference: string
  legs: JournalLeg[]
  status: EntryStatus
  posted_at: string
  /** The reversal that answers this entry, when one stands. */
  reversed_by: string
  /** The entry this one reverses. */
  reverses: string
  actor: string
  created_at: string
  updated_at: string
}

export interface JournalStore {
  version: number
  updatedAt: string
  orgId: string
  heads: JournalHead[]
  entries: JournalEntry[]
  /** The count each series slot has reached, keyed the way the order registers key theirs. */
  seq: Record<string, number>
}

/** The six movements a shop asks for most, offered as a starting chart — nothing is seeded silently. */
export const STARTER_HEADS: { name: string; slot: StatementSlot; notes: string }[] = [
  { name: 'Depreciation', slot: 'expense', notes: 'Straight-line or a rate the CA names — the entry carries the maths, the register does not compute it.' },
  { name: 'Bank charges', slot: 'expense', notes: 'The line a statement shows and no bill was raised for.' },
  { name: 'Drawings', slot: 'capital', notes: 'Money the owner took out of the till — not a salary, which is a payroll row.' },
  { name: 'Loan received', slot: 'loans', notes: 'Cash that arrived without a purchase bill behind it.' },
  { name: 'Provision — GST demand', slot: 'gstLiability', notes: 'A liability a notice has raised and a bill has not. Moves the balance sheet only; no return reads it.' },
  { name: 'Stock shrinkage', slot: 'expense', notes: 'The count coming up short of the card — the inventory line goes down by the same rupee.' },
]

// ── small helpers, local so this register owes nothing to another ─────────────

function nowStamp(): string {
  return new Date().toISOString()
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const isDate = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback
}

/** Rupees to paise. Every sum in this file goes through it, so a float tail cannot decide whether
 *  an entry balances. */
export function paise(rupees: number): number {
  return Math.round((Number.isFinite(rupees) ? rupees : 0) * 100)
}

const inr = (p: number): number => p / 100

/** The Indian financial year an entry date falls in — the label the number wears. */
export function fyLabelOf(date: string): string {
  if (!isDate(date)) return ''
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  const start = m >= 4 ? y : y - 1
  return `${start}-${String(start + 1).slice(2)}`
}

// ── read / write ──────────────────────────────────────────────────────────────

function emptyStore(orgId = ''): JournalStore {
  return { version: JOURNAL_VERSION, updatedAt: '', orgId, heads: [], entries: [], seq: {} }
}

function parseSlot(v: unknown): StatementSlot {
  const s = str(v) as StatementSlot
  return SLOTS.includes(s) ? s : 'otherAsset'
}

function parseHead(raw: unknown): JournalHead | null {
  if (!raw || typeof raw !== 'object') return null
  const h = raw as Record<string, unknown>
  const id = str(h.id)
  const name = str(h.name).trim()
  if (!id || !name) return null
  return {
    id,
    name,
    slot: parseSlot(h.slot),
    active: h.active === false ? false : true,
    notes: str(h.notes),
    created_at: str(h.created_at),
    updated_at: str(h.updated_at),
  }
}

function parseLeg(raw: unknown): JournalLeg | null {
  if (!raw || typeof raw !== 'object') return null
  const l = raw as Record<string, unknown>
  const id = str(l.id)
  const headId = str(l.head_id)
  if (!id || !headId) return null
  const side: LegSide = l.side === 'credit' ? 'credit' : 'debit'
  return { id, head_id: headId, side, amount: num(l.amount), note: str(l.note) }
}

function parseEntry(raw: unknown): JournalEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const id = str(e.id)
  if (!id) return null
  const status: EntryStatus = e.status === 'posted' || e.status === 'reversed' ? e.status : 'draft'
  const legs = Array.isArray(e.legs)
    ? e.legs.map(parseLeg).filter((x): x is JournalLeg => x !== null)
    : []
  // An entry with no legs carries no money and names no line: it is a damaged row, not a draft.
  // A draft always has its two legs because `writeEntry` refuses a shape without them.
  if (legs.length === 0) return null
  return {
    id,
    number: str(e.number),
    date: isDate(e.date) ? e.date : '',
    narration: str(e.narration),
    reference: str(e.reference),
    legs,
    status,
    posted_at: str(e.posted_at),
    reversed_by: str(e.reversed_by),
    reverses: str(e.reverses),
    actor: str(e.actor),
    created_at: str(e.created_at),
    updated_at: str(e.updated_at),
  }
}

function parseSeq(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    const n = num(raw, NaN)
    if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n)
  }
  return out
}

export function parseJournal(raw: string | null, orgId = ''): JournalStore {
  if (!raw) return emptyStore(orgId)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return emptyStore(orgId)
    // A wrong-version file reads as empty rather than half-understood: the same guard every
    // register in this app carries, because a silent partial read looks like a lost book.
    if (parsed.version !== JOURNAL_VERSION) return emptyStore(str(parsed.orgId) || orgId)
    const heads = Array.isArray(parsed.heads)
      ? parsed.heads.map(parseHead).filter((x): x is JournalHead => x !== null)
      : []
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(parseEntry).filter((x): x is JournalEntry => x !== null)
      : []
    return {
      version: JOURNAL_VERSION,
      updatedAt: str(parsed.updatedAt),
      orgId: str(parsed.orgId) || orgId,
      // A hand-edited duplicate id keeps the first row — two heads with one id would let one leg
      // mean two different lines of the statements.
      heads: heads.filter((h, i) => heads.findIndex(x => x.id === h.id) === i),
      entries: entries
        .filter((e, i) => entries.findIndex(x => x.id === e.id) === i)
        .sort((a, b) => (a.date || '').localeCompare(b.date || '')),
      seq: parseSeq(parsed.seq),
    }
  } catch {
    return emptyStore(orgId)
  }
}

export function loadJournal(orgId: string): JournalStore {
  if (typeof window === 'undefined' || !orgId) return emptyStore()
  try {
    const store = parseJournal(window.localStorage.getItem(KEY_JOURNAL + orgId), orgId)
    return { ...store, orgId }
  } catch {
    return emptyStore(orgId)
  }
}

export function saveJournal(orgId: string, store: JournalStore): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.setItem(
      KEY_JOURNAL + orgId,
      JSON.stringify({ ...store, orgId, version: JOURNAL_VERSION, updatedAt: nowStamp() }),
    )
  } catch {
    /* private mode or a full quota must not break the screen */
  }
}

function write(orgId: string, next: Omit<JournalStore, 'version' | 'updatedAt'>): JournalStore {
  const store: JournalStore = { ...next, version: JOURNAL_VERSION, updatedAt: nowStamp() }
  saveJournal(orgId, store)
  return store
}

// ── heads: the shop's own names ───────────────────────────────────────────────

export function newHead(slot: StatementSlot = 'expense', name = ''): JournalHead {
  const at = nowStamp()
  return { id: newId(), name, slot, active: true, notes: '', created_at: at, updated_at: at }
}

export function headById(store: JournalStore, id: string): JournalHead | undefined {
  return store.heads.find(h => h.id === id)
}

/** Every leg in the register that names this head — the answer `deleteHead` refuses on. */
export function headUsage(store: JournalStore, headId: string): { entries: number; paise: number } {
  let entries = 0
  let p = 0
  for (const e of store.entries) {
    const legs = e.legs.filter(l => l.head_id === headId)
    if (legs.length === 0) continue
    entries += 1
    p += legs.reduce((s, l) => s + paise(l.amount), 0)
  }
  return { entries, paise: p }
}

/** Every rule a head must satisfy before it may carry a rupee. */
export function validateHead(head: JournalHead, heads: JournalHead[]): string[] {
  const problems: string[] = []
  const name = head.name.trim()
  if (!name) problems.push('Say what the head is called — the statement line prints this name.')
  else if (name.length > 40) problems.push('Keep the name to forty characters — it prints beside a figure, not under it.')
  else if (heads.some(h => h.id !== head.id && h.name.trim().toLowerCase() === name.toLowerCase())) {
    problems.push(`${name} is already on the register — one name, one head, or the statements cannot say which one moved.`)
  }
  if (!SLOTS.includes(head.slot)) {
    problems.push('The head must name which line of the statements it moves — an undeclared place cannot hold a rupee.')
  }
  return problems
}

/** The single door for one head. Validates, then upserts; writes nothing on a problem. */
export function writeHead(
  orgId: string,
  head: JournalHead,
): { ok: true; store: JournalStore } | { ok: false; problems: string[] } {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadJournal(orgId)
  const clean: JournalHead = {
    ...head,
    name: head.name.trim(),
    notes: head.notes.trim(),
    updated_at: nowStamp(),
  }
  const problems = validateHead(clean, store.heads)
  if (problems.length > 0) return { ok: false, problems }
  const exists = store.heads.some(h => h.id === clean.id)
  if (!exists) clean.created_at = nowStamp()
  const others = store.heads.filter(h => h.id !== clean.id)
  write(orgId, { orgId, heads: [...others, clean], entries: store.entries, seq: store.seq })
  return { ok: true, store: loadJournal(orgId) }
}

/** Offer the starting chart. One deliberate click adds the six; a name already on the register is left alone. */
export function addStarterHeads(orgId: string): { ok: true; store: JournalStore; added: string[] } {
  const store = loadJournal(orgId)
  const added: string[] = []
  const heads = store.heads.slice()
  for (const seed of STARTER_HEADS) {
    if (heads.some(h => h.name.trim().toLowerCase() === seed.name.toLowerCase())) continue
    const at = nowStamp()
    heads.push({ id: newId(), name: seed.name, slot: seed.slot, active: true, notes: seed.notes, created_at: at, updated_at: at })
    added.push(seed.name)
  }
  if (added.length === 0) return { ok: true, store, added }
  return { ok: true, store: write(orgId, { orgId, heads, entries: store.entries, seq: store.seq }), added }
}

export function setHeadActive(orgId: string, id: string, active: boolean): { ok: true; store: JournalStore } | { ok: false; problem: string } {
  const store = loadJournal(orgId)
  const target = store.heads.find(h => h.id === id)
  if (!target) return { ok: false, problem: 'That head is not on the register.' }
  const heads = store.heads.map(h => (h.id === id ? { ...h, active, updated_at: nowStamp() } : h))
  return { ok: true, store: write(orgId, { orgId, heads, entries: store.entries, seq: store.seq }) }
}

/**
 * Delete a head — only while no leg names it. Once an entry carries the rupee the name is
 * history: close the head and the entry still reads. `usage` is counted here, from the register
 * itself, so the refusal cannot be talked around by a modal that has not re-read the books.
 */
export function deleteHead(orgId: string, id: string): { ok: true; store: JournalStore } | { ok: false; problems: string[] } {
  const store = loadJournal(orgId)
  const target = store.heads.find(h => h.id === id)
  if (!target) return { ok: false, problems: ['That head is not on the register.'] }
  const used = headUsage(store, id)
  if (used.entries > 0) {
    return {
      ok: false,
      problems: [
        `${used.entries} ${used.entries === 1 ? 'entry carries' : 'entries carry'} money on ${target.name}`
        + ` (${inr(used.paise).toLocaleString('en-IN')}) — deleting the name would leave those rows naming a line that no longer exists. Close the head instead.`,
      ],
    }
  }
  return { ok: true, store: write(orgId, { orgId, heads: store.heads.filter(h => h.id !== id), entries: store.entries, seq: store.seq }) }
}

// ── the entry: legs, sums, and what balance means ─────────────────────────────

export function newLeg(headId = '', side: LegSide = 'debit'): JournalLeg {
  return { id: newId(), head_id: headId, side, amount: 0, note: '' }
}

export function newEntry(date = todayISO()): JournalEntry {
  const at = nowStamp()
  return {
    id: newId(), number: '', date, narration: '', reference: '',
    legs: [newLeg(), newLeg()], status: 'draft',
    posted_at: '', reversed_by: '', reverses: '', actor: '',
    created_at: at, updated_at: at,
  }
}

export interface EntryTotals {
  debit: number
  credit: number
  /** Paise on each side, so the comparison is exact and a float tail cannot decide it. */
  debitPaise: number
  creditPaise: number
  difference: number
  balanced: boolean
  lines: number
}

export function totals(legs: JournalLeg[]): EntryTotals {
  const debitPaise = legs.filter(l => l.side === 'debit').reduce((s, l) => s + paise(l.amount), 0)
  const creditPaise = legs.filter(l => l.side === 'credit').reduce((s, l) => s + paise(l.amount), 0)
  return {
    debit: inr(debitPaise),
    credit: inr(creditPaise),
    debitPaise,
    creditPaise,
    difference: inr(debitPaise - creditPaise),
    balanced: debitPaise === creditPaise,
    lines: legs.length,
  }
}

/** A head is only a place to put money if the register still has it. */
export function unresolvableLegs(legs: JournalLeg[], store: JournalStore): JournalHead[] {
  const missing: JournalHead[] = []
  const seen = new Set<string>()
  for (const l of legs) {
    if (headById(store, l.head_id)) continue
    if (seen.has(l.head_id)) continue
    seen.add(l.head_id)
    missing.push({ id: l.head_id, name: '(no such head)', slot: 'otherAsset', active: false, notes: '', created_at: '', updated_at: '' })
  }
  return missing
}

/** The names an entry moves — printed beside the row so a journal reads as a sentence, not a total. */
export function entryHeadNames(legs: JournalLeg[], store: JournalStore): string[] {
  const out: string[] = []
  for (const l of legs) {
    const h = headById(store, l.head_id)
    const name = h ? h.name : '—'
    if (!out.includes(name)) out.push(name)
  }
  return out
}

export interface LegProblem {
  /** The leg's index in the array, so the page can put the sentence under the row that caused it. */
  index: number
  problem: string
}

/**
 * Every rule the legs must satisfy. `posting` tightens it to what a statement may read: an
 * unbalanced entry is a draft, but it is never a posting. Two legs are asked for even of a draft —
 * one leg is not an unfinished entry, it is a mistake about what a journal is.
 */
export function validateLegs(legs: JournalLeg[], store: JournalStore, posting: boolean): LegProblem[] {
  const problems: LegProblem[] = []
  // Two legs are asked for even of a draft — but the shortness is reported *beside* whatever else
  // is wrong, not instead of it, so a half-typed draft shows every hole the page has to fill.
  if (legs.length < 2) {
    problems.push({ index: -1, problem: 'A journal entry is at least two legs — one side to take the rupee, one to give it.' })
  }
  legs.forEach((l, i) => {
    const head = headById(store, l.head_id)
    if (!l.head_id) {
      // The composer's blank row, not a mistake: a leg is typed head-first, so this sentence is a
      // prompt rather than a refusal of something the shop wrote.
      problems.push({ index: i, problem: 'This leg has no head yet — choose the statement line it moves, or name one first.' })
    } else if (!head) {
      problems.push({ index: i, problem: 'This leg names a head that is not on the register — pick one, or give it a name first.' })
    } else if (posting && !head.active) {
      problems.push({ index: i, problem: `${head.name} is closed — a closed head is not offered a new rupee. Reopen it or move the leg.` })
    }
    if (!Number.isFinite(l.amount) || l.amount <= 0) {
      problems.push({ index: i, problem: 'A leg of ₹0 says nothing — put the rupee on it, or take the leg off.' })
    } else if (paise(l.amount) <= 0) {
      problems.push({ index: i, problem: 'A leg has to reach a paisa — this one rounds to nothing.' })
    }
    if (l.side !== 'debit' && l.side !== 'credit') {
      problems.push({ index: i, problem: 'A leg is either a debit or a credit — there is no third side.' })
    }
  })
  // One head on both sides of the same entry nets to nothing and hides a typing mistake.
  const sideOfHead = new Map<string, LegSide>()
  const bothSides: string[] = []
  legs.forEach(l => {
    const had = sideOfHead.get(l.head_id)
    if (had && had !== l.side && !bothSides.includes(l.head_id)) bothSides.push(l.head_id)
    if (!sideOfHead.has(l.head_id)) sideOfHead.set(l.head_id, l.side)
  })
  for (const id of bothSides) {
    const h = headById(store, id)
    problems.push({
      index: legs.findIndex(l => l.head_id === id),
      problem: `${h ? h.name : 'This head'} is debited and credited in the same entry — a leg that cancels itself is a mistake, not a journal.`,
    })
  }
  if (posting) {
    const t = totals(legs)
    if (!t.balanced) {
      problems.push({
        index: -1,
        problem:
          `An entry is posted only when it balances — debits ${inr(t.debitPaise).toLocaleString('en-IN')}, ` +
          `credits ${inr(t.creditPaise).toLocaleString('en-IN')}, out by ${inr(Math.abs(t.debitPaise - t.creditPaise)).toLocaleString('en-IN')}.`,
      })
    }
  }
  return problems
}

export function validateEntry(entry: JournalEntry, store: JournalStore, posting: boolean): LegProblem[] {
  const problems: LegProblem[] = []
  if (!isDate(entry.date)) {
    problems.push({ index: -1, problem: 'The entry needs a date this device can read — a rupee cannot be filed in an unknown month.' })
  } else if (entry.date > todayISO()) {
    problems.push({ index: -1, problem: `${entry.date} is in the future — a journal records what has happened, not what is planned. Keep it as a draft until the day arrives.` })
  }
  problems.push(...validateLegs(entry.legs, store, posting))
  if (posting && entry.narration.trim() === '') {
    problems.push({ index: -1, problem: 'Say what the entry is for — the narration is the only reason a statement line will ever move.' })
  }
  return problems
}

// ── the seal, asked before anything is checked ────────────────────────────────

export interface SealStop {
  sealed: true
  why: string
}

/**
 * The register's own door onto R3-1's seal. The date is asked *before* the legs, because a closed
 * period is a statement about the whole window, not about the row being typed — and the attempt is
 * put on the trail, so an edit that never happened is still evidence.
 */
function stopForSeal(orgId: string, date: string, ref: string, actor: string): SealStop | null {
  const guard = askSeal(orgId, {
    date,
    target: 'journal',
    ref: ref || 'entry',
    actor: actor || undefined,
  })
  return guard ? { sealed: true, why: guard.why } : null
}

// ── the number: dressed here, counted nowhere else ────────────────────────────

function maxUsed(store: JournalStore, fmt: SeriesFormat, fy: string): number {
  const worn = seriesHistory(fmt, JOURNAL_SERIES_KIND)
  let max = 0
  for (const e of store.entries) {
    if (!e.number) continue
    if (fmt.include_fy) {
      const n = usedNumber(worn, fy, e.number)
      if (n !== null) max = Math.max(max, n)
    } else {
      for (const h of worn) {
        const n = usedNumberAnyYear(h.prefix, e.number)
        if (n !== null) max = Math.max(max, n)
      }
    }
  }
  return max
}

/** The next count for the FY the entry's *own* date falls in, in the shape the shop asked for. */
function takeNumber(store: JournalStore, date: string, fmt: SeriesFormat): { number: string; seq: Record<string, number> } {
  const fy = fyLabelOf(date)
  const key = seqKeyFor(JOURNAL_SERIES_KIND, fy, fmt)
  const last = Math.max(store.seq[key] ?? 0, maxUsed(store, fmt, fy))
  const next = last + 1
  return { number: composeNumber(fmt, next, fy), seq: { ...store.seq, [key]: next } }
}

/** What the next posted entry will be called, without taking the number. */
export function peekNumber(store: JournalStore, date: string, orgId: string): string {
  if (!isDate(date)) return ''
  const fmt = orgId ? resolveSeries(loadSetupFor(orgId), JOURNAL_SERIES_KIND) : DEFAULT_SERIES[JOURNAL_SERIES_KIND]
  const fy = fyLabelOf(date)
  const key = seqKeyFor(JOURNAL_SERIES_KIND, fy, fmt)
  return composeNumber(fmt, Math.max(store.seq[key] ?? 0, maxUsed(store, fmt, fy)) + 1, fy)
}

// ── the writes ────────────────────────────────────────────────────────────────

export type EntryResult =
  | { ok: true; store: JournalStore; entry: JournalEntry }
  | { ok: false; problems: string[]; sealed?: boolean; why?: string }

function problemsOf(list: LegProblem[]): string[] {
  return list.map(p => p.problem)
}

/**
 * Save a draft — the only way an entry's legs may change. A posted or reversed row is refused:
 * `reverseEntry` is the exit, not an edit. A future date is allowed as a draft (the shop can type
 * ahead) but the write still refuses a date inside a standing seal, because a draft dated there
 * becomes a posting dated there.
 */
export function writeEntry(orgId: string, entry: JournalEntry, actor = ''): EntryResult {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadJournal(orgId)
  const existing = store.entries.find(e => e.id === entry.id)
  if (existing && existing.status !== 'draft') {
    return {
      ok: false,
      problems: [
        `${existing.number || 'This entry'} is already posted — a posted journal is not edited, it is reversed. ` +
        `Record a fresh entry against it and the register will keep both.`,
      ],
    }
  }
  const stop = stopForSeal(orgId, entry.date, entry.number, actor)
  if (stop) return { ok: false, problems: [stop.why], sealed: true, why: stop.why }

  const clean: JournalEntry = {
    ...entry,
    date: isDate(entry.date) ? entry.date : '',
    narration: entry.narration.trim(),
    reference: entry.reference.trim(),
    actor: actor || entry.actor,
    legs: entry.legs.map(l => ({
      id: l.id || newId(),
      head_id: l.head_id,
      side: l.side === 'credit' ? 'credit' : 'debit',
      amount: Number.isFinite(l.amount) && l.amount > 0 ? l.amount : 0,
      note: l.note.trim(),
    })),
    updated_at: nowStamp(),
  }
  // A draft must still be a *shape*: two named legs, real amounts. What it need not be is balanced.
  const problems = problemsOf(validateLegs(clean.legs, store, false))
  const badDate = !isDate(clean.date) ? ['The entry needs a date this device can read.'] : []
  if (problems.length > 0 || badDate.length > 0) return { ok: false, problems: [...badDate, ...problems] }

  const others = store.entries.filter(e => e.id !== clean.id)
  const next = write(orgId, { orgId, heads: store.heads, entries: [...others, clean], seq: store.seq })
  return { ok: true, store: next, entry: clean }
}

/**
 * Post an entry: the seal is asked, the legs are re-checked against the *live* register (a head may
 * have closed or a leg may name a head deleted since the draft was typed), the number is taken, and
 * the row becomes paper. Nothing is written on a refusal.
 */
export function postEntry(orgId: string, entryId: string, actor = ''): EntryResult {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadJournal(orgId)
  const entry = store.entries.find(e => e.id === entryId)
  if (!entry) return { ok: false, problems: ['That entry is not in this register.'] }
  if (entry.status !== 'draft') {
    return { ok: false, problems: [`${entry.number || 'This entry'} is already posted — a draft is posted once.`] }
  }
  const stop = stopForSeal(orgId, entry.date, entry.number, actor)
  if (stop) return { ok: false, problems: [stop.why], sealed: true, why: stop.why }

  const problems = validateEntry(entry, store, true)
  if (problems.length > 0) return { ok: false, problems: problemsOf(problems) }

  const fmt = resolveSeries(loadSetupFor(orgId), JOURNAL_SERIES_KIND)
  const taken = entry.number
    ? { number: entry.number, seq: store.seq }
    : takeNumber(store, entry.date, fmt)
  const posted: JournalEntry = {
    ...entry,
    number: taken.number,
    status: 'posted',
    posted_at: nowStamp(),
    actor: actor || entry.actor,
    updated_at: nowStamp(),
  }
  const next = write(orgId, {
    orgId,
    heads: store.heads,
    entries: store.entries.map(e => (e.id === posted.id ? posted : e)),
    seq: taken.seq,
  })
  return { ok: true, store: next, entry: posted }
}

/**
 * Answer a posted entry with its mirror. The original is kept and marked `reversed`; the reversal
 * carries the same heads and rupees with every side flipped, and the two net to nothing in the
 * fold. A reason is required — an unexplained reversal is the same silent unlock a seal refuses.
 */
export function reverseEntry(
  orgId: string,
  entryId: string,
  reason: string,
  date: string,
  actor = '',
): EntryResult {
  if (typeof window === 'undefined' || !orgId) return { ok: false, problems: ['No workspace is open.'] }
  const store = loadJournal(orgId)
  const entry = store.entries.find(e => e.id === entryId)
  if (!entry) return { ok: false, problems: ['That entry is not in this register.'] }
  if (entry.status === 'draft') {
    return { ok: false, problems: ['A draft is not posted yet — delete it instead of reversing it.'] }
  }
  if (entry.status === 'reversed') {
    return { ok: false, problems: [`${entry.number} was already reversed — one entry is answered once.`] }
  }
  const why = reason.trim()
  if (!why) {
    return { ok: false, problems: ['Say why the entry is being reversed — an unexplained reversal is what an auditor looks for.'] }
  }
  if (!isDate(date)) return { ok: false, problems: ['The reversal needs a date this device can read.'] }
  if (date > todayISO()) return { ok: false, problems: [`A reversal dated ${date} has not happened yet.`] }
  const stop = stopForSeal(orgId, date, entry.number, actor)
  if (stop) return { ok: false, problems: [stop.why], sealed: true, why: stop.why }

  const mirror: JournalEntry = {
    id: newId(),
    number: '',
    date,
    narration: `Reversal of ${entry.number || 'an unposted entry'} — ${why}`,
    reference: entry.reference,
    // Every leg re-summoned from the original with its side flipped: the head and the rupee are
    // never retyped, so a reversal cannot drift from what it answers.
    legs: entry.legs.map(l => ({ ...l, id: newId(), side: l.side === 'debit' ? 'credit' : 'debit' })),
    status: 'posted',
    posted_at: nowStamp(),
    reversed_by: '',
    reverses: entry.id,
    actor: actor || '',
    created_at: nowStamp(),
    updated_at: nowStamp(),
  }
  const fmt = resolveSeries(loadSetupFor(orgId), JOURNAL_SERIES_KIND)
  // The count is taken from the register as it stands — the mirror has no number yet, so it cannot
  // count against itself.
  const taken = takeNumber(store, date, fmt)
  mirror.number = taken.number
  const next = write(orgId, {
    orgId,
    heads: store.heads,
    // The original is kept and marked answered; the mirror is appended beside it. Both fold, and
    // the pair nets to nothing.
    entries: store.entries
      .map(e => (e.id === entry.id ? { ...e, status: 'reversed' as EntryStatus, reversed_by: mirror.id, updated_at: nowStamp() } : e))
      .concat(mirror)
      .sort((a, b) => (a.date || '').localeCompare(b.date || '')),
    seq: taken.seq,
  })
  return { ok: true, store: next, entry: mirror }
}

/** Delete a draft. A posted row cannot be deleted — that is `reverseEntry`'s job. */
export function deleteEntry(orgId: string, entryId: string): { ok: true; store: JournalStore } | { ok: false; problems: string[] } {
  const store = loadJournal(orgId)
  const entry = store.entries.find(e => e.id === entryId)
  if (!entry) return { ok: false, problems: ['That entry is not in this register.'] }
  if (entry.status !== 'draft') {
    return {
      ok: false,
      problems: [
        `${entry.number} is posted${entry.status === 'reversed' ? ' and reversed' : ''} — it is history, not a draft. ` +
        `A delete would leave a number with no entry, so reverse it instead.`,
      ],
    }
  }
  return { ok: true, store: write(orgId, { orgId, heads: store.heads, entries: store.entries.filter(e => e.id !== entryId), seq: store.seq }) }
}

// ── the fold: what the statements read ────────────────────────────────────────
//
// `ledger.ts` declares its own row shapes and imports nothing, so the journal hands it plain rows
// already resolved to a line and a signed movement. The sign convention lives in one place
// (`SLOT_META.natural`): a leg on the side the line grows on is a positive movement, a leg on the
// other side is a negative one. An expense is debit-natural and *increases* the expense line — the
// P&L subtracts the line, so the profit effect is arithmetic the engine already does, never a
// second sign applied here.

export interface JournalRow {
  entry_id: string
  number: string
  date: string
  /** The head's own name — printed, so a statement can say which head moved the line. */
  label: string
  slot: StatementSlot
  /** Signed rupees on that statement line. */
  signed: number
  narration: string
  actor: string
}

/** Only posted entries fold, and a reversed pair folds too — it nets to nothing and stays visible. */
export function foldableEntries(store: JournalStore): JournalEntry[] {
  return store.entries.filter(e => e.status !== 'draft')
}

export function journalRows(store: JournalStore): JournalRow[] {
  const out: JournalRow[] = []
  for (const e of foldableEntries(store)) {
    for (const l of e.legs) {
      const head = headById(store, l.head_id)
      if (!head) continue
      const natural = SLOT_META[head.slot].natural
      out.push({
        entry_id: e.id,
        number: e.number,
        date: e.date,
        label: head.name,
        slot: head.slot,
        signed: l.side === natural ? l.amount : -l.amount,
        narration: e.narration,
        actor: e.actor,
      })
    }
  }
  return out.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.number.localeCompare(b.number))
}

export type JournalWindow = { start: string; end: string }

/** Rows inside a window — what a statement is allowed to read. */
export function rowsInWindow(rows: JournalRow[], win: JournalWindow): JournalRow[] {
  return rows.filter(r => !!r.date && r.date >= win.start && r.date <= win.end)
}

export interface SlotMovement {
  slot: StatementSlot
  label: string
  signed: number
}

/** Per-slot totals, zero-free: a line that did not move is not printed. */
export function movements(rows: JournalRow[]): SlotMovement[] {
  const bySlot = new Map<StatementSlot, number>()
  for (const r of rows) bySlot.set(r.slot, (bySlot.get(r.slot) ?? 0) + paise(r.signed))
  return SLOTS
    .filter(s => (bySlot.get(s) ?? 0) !== 0)
    .map(s => ({ slot: s, label: SLOT_META[s].label, signed: inr(bySlot.get(s) ?? 0) }))
}

/** The P&L expense lines a journal adds, by head name — the fold's own category list. */
export function expenseLines(rows: JournalRow[]): { label: string; amount: number }[] {
  const by = new Map<string, number>()
  for (const r of rows) if (r.slot === 'expense') by.set(r.label, (by.get(r.label) ?? 0) + paise(r.signed))
  return [...by.entries()]
    .map(([label, p]) => ({ label, amount: inr(p) }))
    .filter(x => x.amount !== 0)
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
}

/** What one slot moved, rupees — the sub-line the balance sheet prints beside a document figure. */
export function slotTotal(rows: JournalRow[], slot: StatementSlot): number {
  return inr(rows.reduce((s, r) => (r.slot === slot ? s + paise(r.signed) : s), 0))
}

/** The named money on a head — the register's own trial-balance answer, and a debit-natural read. */
export function headBalance(store: JournalStore, headId: string, upTo = ''): { signed: number; entries: number } {
  const head = headById(store, headId)
  if (!head) return { signed: 0, entries: 0 }
  let p = 0
  let entries = 0
  const natural = SLOT_META[head.slot].natural
  for (const e of foldableEntries(store)) {
    if (upTo && e.date > upTo) continue
    const legs = e.legs.filter(l => l.head_id === headId)
    if (legs.length === 0) continue
    entries += 1
    for (const l of legs) p += l.side === natural ? paise(l.amount) : -paise(l.amount)
  }
  return { signed: inr(p), entries }
}

// ── the invariant the page prints ─────────────────────────────────────────────
//
// Balance is not a nicety here: it is *why* a journal can move a figure from the derived capital
// line to a named one without moving the derived line at all.
//
// Write the plug out: `balancingReserve = (assets − liabilities) − capital − retained`, where
// `retained` is the P&L's own net profit. Take the difference a journal entry makes to each piece —
// an asset slot moves by (its debits − its credits), a liability or capital slot by (credits −
// debits), `retained` by revenue (credits − debits) less expenses and purchases (debits − credits).
// Substituted, every sign flips back: **Δplug = Σ all debits − Σ all credits.** A balanced entry
// therefore changes the derived capital line by exactly nothing, whatever it debits and whatever it
// credits. That is the round's claim in one line, and `plugProof` reads it off the rows the
// statements are actually holding, so the page prints the arithmetic instead of asserting it.

export interface PlugProof {
  /** Σ every leg read back to its debit side, rupees. */
  debits: number
  /** Σ every leg read back to its credit side, rupees. */
  credits: number
  /** The difference — and exactly how far the derived plug moved, because every slot contributes
   *  (its debits − its credits) to that figure. Zero means the journal renamed money; a non-zero
   *  is a hand-edit, the same finding a `seq` gap is on the audit trail. */
  residual: number
  ok: boolean
  entries: number
  legs: number
}

export function plugProof(rows: JournalRow[]): PlugProof {
  let debitP = 0
  let creditP = 0
  const entryIds = new Set<string>()
  let legs = 0
  for (const r of rows) {
    entryIds.add(r.entry_id)
    legs += 1
    // Read the movement back to its side: a positive signed movement on a debit-natural line came
    // from a debit, and on a credit-natural line from a credit.
    const natural = SLOT_META[r.slot].natural
    if (natural === 'debit') {
      if (r.signed >= 0) debitP += paise(r.signed)
      else creditP += paise(-r.signed)
    } else {
      if (r.signed >= 0) creditP += paise(r.signed)
      else debitP += paise(-r.signed)
    }
  }
  return {
    debits: inr(debitP),
    credits: inr(creditP),
    residual: inr(debitP - creditP),
    ok: debitP === creditP,
    entries: entryIds.size,
    legs,
  }
}

// ── summaries for the page ────────────────────────────────────────────────────

/** Postings still standing — numbered, folded, and not answered by a reversal of their own. */
export function livePostings(store: JournalStore): JournalEntry[] {
  return store.entries.filter(e => e.status === 'posted' && !e.reverses)
}

export interface JournalStats {
  heads: number
  openHeads: number
  /** Postings standing: neither a draft nor one half of a reversed pair. */
  posted: number
  drafts: number
  reversed: number
  rupeesThisFY: number
  /** Numbered rows that do not balance. Zero by construction — a non-zero is a hand-edit, which is
   *  the same finding a `seq` gap is on the audit trail, and the page prints it when it happens. */
  unbalanced: number
  /** Legs naming a head the register no longer holds. */
  dangling: number
  lastPosted: string
}

export function journalStats(store: JournalStore, fyStart: string, fyEnd: string): JournalStats {
  const live = livePostings(store)
  const inFy = live.filter(e => e.date >= fyStart && e.date <= fyEnd)
  // "Rupees this FY" counts the debit side of the postings that stand — an entry moves a figure
  // twice, once in and once out, and a shop reading the card wants the money that moved, not double
  // that. A reversed pair is excluded because it moved nothing.
  const rupees = inFy.reduce((s, e) => s + totals(e.legs).debitPaise, 0)
  const numbered = store.entries.filter(e => e.status !== 'draft')
  return {
    heads: store.heads.length,
    openHeads: store.heads.filter(h => h.active).length,
    posted: live.length,
    drafts: store.entries.filter(e => e.status === 'draft').length,
    reversed: store.entries.filter(e => e.status === 'reversed').length,
    rupeesThisFY: inr(rupees),
    unbalanced: numbered.filter(e => !totals(e.legs).balanced).length,
    dangling: danglingLegCount(store),
    lastPosted: live.reduce((m, e) => ((e.posted_at || '') > m ? e.posted_at || '' : m), ''),
  }
}

/** Newest first — the register reads like a day book, not a queue. */
export function newestFirst(store: JournalStore): JournalEntry[] {
  return store.entries
    .slice()
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.created_at.localeCompare(a.created_at))
}

export function drafts(store: JournalStore): JournalEntry[] {
  return store.entries.filter(e => e.status === 'draft')
}

/** Entries dated before the day the books were picked up — printed as a finding, never corrected. */
export function beforeTheBooksOpened(store: JournalStore, asOf: string): JournalEntry[] {
  if (!isDate(asOf)) return []
  return store.entries.filter(e => e.status !== 'draft' && isDate(e.date) && e.date < asOf)
}

/** Heads an entry names that the register no longer holds — the reason a leg can be unpostable. */
export function danglingLegCount(store: JournalStore): number {
  let n = 0
  for (const e of store.entries) for (const l of e.legs) if (!headById(store, l.head_id)) n += 1
  return n
}

export const STATUS_META: Record<EntryStatus, { label: string; tone: 'blue' | 'green' | 'red' | 'amber' | 'grey' }> = {
  draft: { label: 'Draft', tone: 'grey' },
  posted: { label: 'Posted', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'amber' },
}

// ── CSV ───────────────────────────────────────────────────────────────────────

export const JOURNAL_CSV_HEADERS = [
  'Number', 'Date', 'Status', 'Narration', 'Reference', 'Head', 'Moves', 'Debit', 'Credit', 'By', 'Reverses',
]

export function journalCsvRows(store: JournalStore): (string | number)[][] {
  const out: (string | number)[][] = []
  for (const e of newestFirst(store)) {
    const rev = e.reverses ? store.entries.find(x => x.id === e.reverses) : undefined
    for (const l of e.legs) {
      const head = headById(store, l.head_id)
      out.push([
        e.number || '—', e.date || '—', STATUS_META[e.status].label, e.narration, e.reference,
        head ? head.name : '— missing head', head ? SLOT_META[head.slot].label : '—',
        l.side === 'debit' ? l.amount : '', l.side === 'credit' ? l.amount : '',
        e.actor, rev ? rev.number : '',
      ])
    }
  }
  return out
}

export const HEADS_CSV_HEADERS = ['Head', 'Moves', 'Group', 'Entries', 'Balance', 'Status', 'Notes']

export function headsCsvRows(store: JournalStore): (string | number)[][] {
  return store.heads.map(h => {
    const b = headBalance(store, h.id)
    return [h.name, SLOT_META[h.slot].label, GROUP_LABEL[SLOT_META[h.slot].group], b.entries, b.signed, h.active ? 'open' : 'closed', h.notes]
  })
}
