// =============================================
// THE TALLY BRIDGE — a shop's Tally XML read into our books, and our books
// written back as Tally import XML. (R2-22 B1)
//
// Tally is where Indian bookkeeping already lives: the competitor scan has seven
// products naming a Tally bridge, and a business with five years of vouchers in
// TallyPrime will not retype them. So this file does the awkward half of that
// promise in the browser: read a Tally export, decide what each object *is* here,
// and show a plan. Writing is the same bridge run backwards — Tally's documented
// import format, from rows our own books already hold.
//
// Four decisions carry the honesty of it:
//
//  * **A file is evidence, not instruction.** Every rupee on the plan comes from a
//    tagged value in the XML, or from arithmetic on tagged values that is *labelled*
//    as arithmetic ("derived from ₹tax ÷ ₹taxable"). Where the file disagrees with
//    itself — the ledger lines do not sum to the printed total, a voucher does not
//    balance to zero — the disagreement is reported and the file's own lines win,
//    because the lines are what the shop billed.
//  * **Our numbers stay ours.** A Tally voucher number is not an invoice number:
//    `invoices.invoice_number` comes from `invoice_sequences` and reads
//    `INV-<FY>-NNNN`, and the Tally reference travels in `notes` so the two books
//    can always be tied back to each other. Same for a purchase bill, whose
//    `bill_number` is the vendor's own.
//  * **A document whose inputs cannot be resolved is blocked, not guessed.** No
//    party is invented, no product is created implicitly by a line, no tax rate is
//    spread across lines the file cannot attribute it to. Blocking says which name
//    is missing and why, which is also the fix.
//  * **Import does not touch money, and does not reach a return.** A receipt
//    ledger inside a voucher is reported as ₹X already collected and left for
//    `/payments` — the one writer of money — and a cost centre or a Tally group
//    that is not a counterparty is skipped with the reason, never silently
//    converted into a customer.
//
// What v1 deliberately does NOT claim: credit/debit notes, receipts, payments,
// journals and delivery challans in the file are listed as skipped, because their
// write paths live on other pages; a service voucher with only ledger entries and
// no line at all blocks rather than inventing a line; and the file's Tally company
// state is not read — the organisation's own primary GSTIN supplies it.
// =============================================

import { INDIAN_STATES } from '@/lib/constants'
import {
  calculateInvoiceTotals, calculateLineItem, determineGSTType,
  type GSTType, type LineItemResult,
} from '@/lib/gst-engine'
import { GST_RATES } from '@/lib/gst-rates'

// ── a tolerant XML reader ─────────────────────────────────────────────────────
//
// Tally's own writer is not the only producer of these files: exports, integration
// dumps and hand-edited requests differ in case, in whether a value sits in an
// attribute or a child tag, and in whether the file ends where the last tag closes.
// So this is a scanner, not a validating parser — it reads what is there, and says
// plainly what it could not read. Node has no DOMParser, and the browser's would
// refuse the half-closed files this has to survive.

export interface XmlNode {
  name: string
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

export interface XmlIssue { at: number; message: string }

export interface XmlDoc {
  roots: XmlNode[]
  issues: XmlIssue[]
  /** True when the reader stopped early — a cut-off file reads as partial data. */
  truncated: boolean
}

/** A file this big is not a Tally export; it is a dump of everything. Stop, say so. */
const MAX_NODES = 400_000

/**
 * BOM, UTF-16 read as bytes, CRLF. A Tally export opened on Windows and pasted
 * through a reader that assumed latin1 arrives full of NUL characters — stripping
 * them is the difference between 400 vouchers and 0.
 */
export function normaliseXml(raw: string): string {
  let s = String(raw ?? '')
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  if (s.includes('\u0000')) s = s.replace(/\u0000/g, '')
  return s.replace(/\r\n?/g, '\n')
}

export function decodeXml(s: string): string {
  return String(s ?? '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x10000 ? String.fromCharCode(code) : whole
    }
    switch (body.toLowerCase()) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos': return "'"
      case 'nbsp': return ' '
      default: return whole
    }
  })
}

/** Tag and attribute names, folded: `UDF:HSN_Code_under_GSTN_UG` and `hsn_codeundergstnug` meet here. */
export function normTagName(name: string): string {
  return String(name ?? '').toLowerCase().replace(/^udf:/, '').replace(/[^a-z0-9]/g, '')
}

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([^\s=<>"'`/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"'`=]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const value = m[3] ?? m[4] ?? m[5] ?? ''
    attrs[decodeXml(m[1])] = decodeXml(value)
  }
  return attrs
}

/** The `>` that ends a tag, ignoring any `>` inside a quoted attribute value. */
function findTagEnd(src: string, from: number): number {
  let quote: string | null = null
  for (let i = from + 1; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return -1
}

export function parseXml(xml: string): XmlDoc {
  const src = normaliseXml(xml)
  const roots: XmlNode[] = []
  const stack: XmlNode[] = []
  const issues: XmlIssue[] = []
  let truncated = false
  let i = 0
  let nodes = 0

  function closeTag(name: string, at: number): void {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k].name === name) {
        stack.length = k
        return
      }
    }
    // A closer for something never opened: a stray </REPORTNAME> in a hand-edited
    // request. Noted, and the reader carries on — half a file beats none of it.
    issues.push({ at, message: `A </${name}> closes nothing that is open` })
  }

  function pushText(chunk: string): void {
    if (!chunk || !chunk.trim()) return
    const target = stack.length ? stack[stack.length - 1] : null
    if (!target) return
    const clean = decodeXml(chunk).trim()
    target.text = target.text ? `${target.text} ${clean}` : clean
  }

  while (i < src.length) {
    const lt = src.indexOf('<', i)
    if (lt === -1) {
      pushText(src.slice(i))
      break
    }
    if (lt > i) pushText(src.slice(i, lt))

    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      if (end === -1) {
        issues.push({ at: lt, message: 'A comment opens and is never closed' })
        truncated = true
        break
      }
      i = end + 3
      continue
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt)
      if (end === -1) {
        issues.push({ at: lt, message: 'A CDATA block opens and is never closed' })
        truncated = true
        break
      }
      pushText(src.slice(lt + 9, end))
      i = end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      // Processing instruction or DOCTYPE — not data.
      const end = src.indexOf('>', lt)
      i = end === -1 ? src.length : end + 1
      continue
    }

    const gt = findTagEnd(src, lt)
    if (gt === -1) {
      issues.push({ at: lt, message: 'A tag opens and the file ends inside it' })
      truncated = true
      break
    }
    const inner = src.slice(lt + 1, gt).trim()
    i = gt + 1

    if (inner.startsWith('/')) {
      closeTag(inner.slice(1).trim(), lt)
      continue
    }
    if (nodes >= MAX_NODES) {
      issues.push({ at: lt, message: `Stopped after ${MAX_NODES.toLocaleString('en-IN')} nodes — this looks like a whole-company dump, not a voucher export` })
      truncated = true
      break
    }
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(inner.replace(/\/\s*$/, ''))
    if (!m) {
      issues.push({ at: lt, message: 'A <> pair carries no tag name' })
      continue
    }
    const node: XmlNode = { name: m[1], attrs: parseAttrs(m[2] || ''), children: [], text: '' }
    const parent = stack.length ? stack[stack.length - 1] : null
    if (parent) parent.children.push(node)
    else roots.push(node)
    nodes++
    if (!inner.endsWith('/')) stack.push(node)
  }

  if (stack.length && !truncated) {
    issues.push({
      at: -1,
      message: `${stack.length} tag${stack.length === 1 ? '' : 's'} left open at the end — the file was cut off mid-object`,
    })
    truncated = true
  }
  return { roots, issues, truncated }
}

// ── reading values out of that tree ───────────────────────────────────────────

/** An attribute, folded-name matched. '' when absent. */
export function xmlAttr(node: XmlNode | null, name: string): string {
  if (!node) return ''
  const want = normTagName(name)
  for (const key of Object.keys(node.attrs)) {
    if (normTagName(key) === want) return node.attrs[key].trim()
  }
  return ''
}

export function xmlChild(node: XmlNode | null, name: string): XmlNode | null {
  if (!node) return null
  const want = normTagName(name)
  for (const c of node.children) if (normTagName(c.name) === want) return c
  return null
}

export function xmlChildren(node: XmlNode | null, name: string): XmlNode[] {
  if (!node) return []
  const want = normTagName(name)
  return node.children.filter(c => normTagName(c.name) === want)
}

/** Children whose folded name *contains* `part` — `<ALLINVENTORYENTRIES.LIST>` and
 *  `<INVENTORYENTRIES.LIST>` are the same list under two names. */
export function xmlChildrenLike(node: XmlNode | null, part: string): XmlNode[] {
  if (!node) return []
  const want = normTagName(part)
  return node.children.filter(c => normTagName(c.name).includes(want))
}

/** The value of a node: its own text, or the first nested leaf's text when the
 *  wrapper carries nothing (`<OPENINGBALANCE><AMOUNT>1500</AMOUNT></OPENINGBALANCE>`). */
function leafText(node: XmlNode | null): string {
  if (!node) return ''
  if (node.text) return node.text
  for (const c of node.children) {
    const t = leafText(c)
    if (t) return t
  }
  return ''
}

/** Attribute first, then child — Tally puts the object's own name in an attribute on
 *  export (`<LEDGER NAME="Cash">`) and in a child on import (`<NAME>Cash</NAME>`). */
export function xmlValue(node: XmlNode | null, ...names: string[]): string {
  if (!node) return ''
  for (const name of names) {
    const a = xmlAttr(node, name)
    if (a) return a
  }
  for (const name of names) {
    const child = xmlChild(node, name)
    const t = leafText(child)
    if (t) return t
  }
  return ''
}

/** Loose read: any attribute or child whose folded name passes `test`. This is how a
 *  UDF written as `HSN_Code_under_GSTN_UG` is still found as an HSN. */
export function xmlValueLike(node: XmlNode | null, test: (folded: string) => boolean): string {
  if (!node) return ''
  for (const key of Object.keys(node.attrs)) {
    if (test(normTagName(key))) {
      const v = node.attrs[key].trim()
      if (v) return v
    }
  }
  for (const c of node.children) {
    if (test(normTagName(c.name))) {
      const t = leafText(c)
      if (t) return t
    }
  }
  return ''
}

export function xmlValueAny(node: XmlNode | null, groups: string[][]): string {
  for (const group of groups) {
    const v = xmlValue(node, ...group)
    if (v) return v
  }
  return ''
}

/**
 * A Tally amount as written: `1,200.00`, `15000.00/nos`, `₹2,000`, `1,500.00 Cr`,
 * `(300.00)`. Cr is a credit — negative here, because this library keeps the sign
 * Tally's own export uses (deemed-positive/debit is negative).
 */
export function tallyNumber(raw: string | number | null | undefined): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0
  let s = String(raw ?? '').trim()
  if (!s) return 0
  let sign = 1
  const tail = /\b(cr|credit|dr|debit)\b\s*$/i.exec(s)
  if (tail) {
    if (/^cr/i.test(tail[1])) sign = -1
    s = s.slice(0, tail.index)
  }
  s = s.split('/')[0]
  s = s.replace(/₹|rs\.?|inr/gi, '')
  const paren = /^\s*\((.*)\)\s*$/.exec(s)
  if (paren) {
    sign = -sign
    s = paren[1]
  }
  s = s.replace(/[, ]/g, '')
  if (!s || s === '-') return 0
  const n = Number(s)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * sign * 100) / 100
}

/** `5%` / `5.00%` / `5` — a percent field, where Tally sometimes writes the unit and
 *  sometimes does not. A bare number is already a percent, never a fraction. */
export function tallyPercent(raw: string | number | null | undefined): number {
  const s = String(raw ?? '').trim()
  if (!s) return 0
  if (s.includes('%')) return Math.abs(tallyNumber(s.replace('%', '')))
  // `10.00/nos` on a discount tag is an amount, not a percent.
  if (s.includes('/')) return 0
  return Math.abs(tallyNumber(s))
}

/** True when the value carries an explicit `%`. */
export function tallyIsPercent(raw: string): boolean {
  return String(raw ?? '').includes('%')
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function isoOk(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return ''
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return ''
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Every date shape Tally has ever emitted, into ISO `yyyy-mm-dd`:
 * `20160401` (the wire format), `01-Apr-2016` (the readable one), `2016-04-01`,
 * `2016/04/01`, `01-04-2016`. Anything else is ''.
 */
export function tallyDate(raw: string | null | undefined): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (/^\d{8}$/.test(s)) return isoOk(+s.slice(0, 4), +s.slice(4, 6), +s.slice(6, 8))
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (iso) return isoOk(+iso[1], +iso[2], +iso[3])
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(s)
  if (slash) return isoOk(+slash[1], +slash[2], +slash[3])
  const dmy = /^(\d{1,2})[\s/-]([a-zA-Z]{3,})[\s/-](\d{2,4})$/.exec(s)
  if (dmy) {
    const month = MONTHS[dmy[2].slice(0, 3).toLowerCase()]
    if (!month) return ''
    let year = +dmy[3]
    if (year < 100) year += year < 60 ? 2000 : 1900
    return isoOk(year, month, +dmy[1])
  }
  const numeric = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s)
  if (numeric) {
    let year = +numeric[3]
    if (year < 100) year += year < 60 ? 2000 : 1900
    // Tally writes day-first: `01-04-2016` is 1 April, not January's 4th.
    if (+numeric[1] > 12 && +numeric[2] <= 12) return isoOk(year, +numeric[2], +numeric[1])
    if (+numeric[1] <= 12 && +numeric[2] > 12) return isoOk(year, +numeric[1], +numeric[2])
    return isoOk(year, +numeric[2], +numeric[1])
  }
  return ''
}

/** ISO → the 8-digit form Tally's import expects. '' stays '' — no invented date. */
export function toTallyDate(iso: string | null | undefined): string {
  const s = String(iso ?? '').trim()
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return ''
  return s.slice(0, 10).replace(/-/g, '')
}

// ── a state, from whatever the file says ──────────────────────────────────────

const STATE_ALIASES: Record<string, string> = {
  jammuandkashmir: '01',
  jammu: '01',
  nationalcapitalterritory: '07',
  nct: '07',
  uttarakhand: '05',
  uttaranchal: '05',
  'andhra pradesh new': '37',
  andhrapradeshnew: '37',
  dadranagarhavelianddamananddiu: '26',
  damananddiu: '25',
  pondicherry: '34',
}

/**
 * Tally state names are free text typed by whoever set up the company, so this folds
 * case, punctuation and the two spellings of "and", and accepts a 2-digit code as
 * already being one. '' means the file does not say — never a guess.
 */
export function stateCodeFromName(raw: string | null | undefined): string {
  const folded = normTagName(String(raw ?? ''))
  if (!folded) return ''
  if (/^\d{2}$/.test(folded) && INDIAN_STATES.some(s => s.value === folded)) return folded
  for (const s of INDIAN_STATES) {
    if (normTagName(s.label) === folded) return s.value
  }
  const alias = Object.keys(STATE_ALIASES).find(k => normTagName(k) === folded)
  if (alias) return STATE_ALIASES[alias]
  // "Maharashtra-Mumbai" and a name carrying the district: prefix match, one way only.
  const starts = INDIAN_STATES.filter(s => folded.startsWith(normTagName(s.label)))
  return starts.length === 1 ? starts[0].value : ''
}

export function stateNameFromCode(code: string): string {
  return INDIAN_STATES.find(s => s.value === code)?.label || ''
}

// ── the Tally objects we care about ───────────────────────────────────────────

export type PartyRole = 'customer' | 'vendor' | 'other'

export interface TallyLedger {
  name: string
  /** The group it sits under — Sundry Debtors, Sundry Creditors, Bank Account… */
  group: string
  role: PartyRole
  gstin: string
  pan: string
  stateName: string
  stateCode: string
  phone: string
  email: string
  address: string
  /** Signed as Tally writes it: negative is a debit balance (money owed to us). */
  opening: number
  /** How the role was worked out, so the plan can say it out loud. */
  roleHow: string
  sourceIndex: number
}

export interface TallyStockItem {
  name: string
  unit: string
  hsn: string
  /** 'goods' or 'service' — SAC codes start 99, and that is the only test the file allows. */
  itemType: 'goods' | 'service'
  sellingRate: number | null
  purchaseRate: number | null
  gstRate: number | null
  cessRate: number | null
  openingQty: number
  openingValue: number
  sourceIndex: number
}

export interface TallyEntry {
  ledger: string
  /** As read, sign included. */
  amount: number
  absolute: number
  deemedPositive: boolean
  isParty: boolean
  group: string
  /** What this line is to the voucher: the party, a tax, money in, the goods value, or unclear. */
  kind: EntryKind
  taxFamily: TaxFamily
  rate: number | null
}

export type EntryKind = 'party' | 'tax' | 'money' | 'value' | 'other'
export type TaxFamily = 'cgst' | 'sgst' | 'igst' | 'cess' | 'none'

export interface TallyLine {
  item: string
  qty: number
  rate: number
  /** Gross before discount, from the file where the file gives it. */
  gross: number
  discount: number
  /** The same discount as a percent, which is what our tax engine restates it from. */
  discountPercent: number
  /** The assessable value: the file's own if present, else qty × rate − discount. */
  taxable: number
  taxableFrom: 'file' | 'derived'
  discountHow: 'percent' | 'amount' | 'none'
  tax: number | null
  taxRate: number | null
  /** The line's own side of the entry: a sale credits the goods, a purchase debits them. */
  deemedPositive: boolean
  hsn: string
  unit: string
}

export type VoucherProblemKey =
  | 'negative-qty' | 'no-lines' | 'no-party' | 'no-date' | 'other-kind' | 'other-ledger'

/** A problem the reader found, keyed so the plan can decide what to do about it:
 *  a key that blocks a document, one that is only worth a warning, and the two the
 *  plan states in its own longer words. */
export interface VoucherProblem { key: VoucherProblemKey; text: string }

export type VoucherKind = 'sales' | 'purchase' | 'other'

export interface TallyVoucher {
  /** The type as the file names it — "Sales", "Purchase (Local)", "Credit Note". */
  voucherType: string
  kind: VoucherKind
  number: string
  date: string
  /** How the date was read — the tag it came from. */
  dateFrom: string
  reference: string
  party: string
  /** How the party was found: its own tag, the flagged entry, or the debtor line. */
  partyHow: string
  /** Only true when the file itself says the recipient pays the tax. */
  reverseCharge: boolean
  entries: TallyEntry[]
  lines: TallyLine[]
  tax: { cgst: number; sgst: number; igst: number; cess: number }
  /** Non-tax, non-party, non-money ledgers: the rupees that have nowhere to go here. */
  otherLedgers: { ledger: string; amount: number }[]
  /** Cash / bank lines: money already received or paid, which import must not write. */
  moneyLedgers: { ledger: string; amount: number }[]
  statedTotal: number | null
  /** Σ of every signed value in the voucher. A whole voucher reads as 0. */
  balance: number
  problems: VoucherProblem[]
  sourceIndex: number
}

export interface TallyCompany {
  name: string
  stateName: string
  gstin: string
  financialYear: string
}

export interface SkippedObject {
  tag: string
  name: string
  reason: string
}

export interface TallyDump {
  /** 'export' holds data (what the user should paste), 'request' asks for it. */
  envelope: 'export' | 'request' | 'unknown'
  company: TallyCompany | null
  ledgers: TallyLedger[]
  stockItems: TallyStockItem[]
  vouchers: TallyVoucher[]
  skipped: SkippedObject[]
  issues: XmlIssue[]
  /** Every object tag seen, tally'd by folded name — the honest "what was in there". */
  objectTags: Record<string, number>
  parsedNodes: number
}

const OBJECT_LIKE_TAGS = new Set([
  'ledger', 'stockitem', 'voucher', 'company', 'group', 'tallygroup', 'category',
  'tallycategory', 'unit', 'vouchertype', 'costcategory', 'currency', 'state',
  'gstrates', 'hsnmaster', 'sacmaster', 'modeofdelivery', 'shippingsterms', 'location',
])

/** Groups that mean "this ledger is a counterparty", folded and matched by containment
 *  because Tally has shipped "Sundry Debtors" and businesses rename it "Parties". */
function roleOfGroup(group: string): { role: PartyRole; how: string } {
  const g = normTagName(group)
  if (!g) return { role: 'other', how: 'no group on the ledger' }
  if (g.includes('sundrydebtor') || g === 'debtors' || g.includes('receivable')) {
    return { role: 'customer', how: `group “${group}”` }
  }
  if (g.includes('sundrycreditor') || g === 'creditors' || g.includes('payable')) {
    return { role: 'vendor', how: `group “${group}”` }
  }
  return { role: 'other', how: `group “${group}” is not a counterparty` }
}

const TAX_FAMILIES: { family: TaxFamily; test: (g: string) => boolean }[] = [
  { family: 'igst', test: g => g.includes('igst') || g.includes('integratedtax') },
  { family: 'cgst', test: g => g.includes('cgst') || g.includes('centraltax') },
  { family: 'sgst', test: g => g.includes('sgst') || g.includes('statetax') || g.includes('utgst') },
  { family: 'cess', test: g => g.includes('cess') },
]

/** Order matters: "IGST" must not be read as a state tax by a looser test. */
export function taxFamilyOf(ledgerName: string): TaxFamily {
  const g = normTagName(ledgerName)
  if (!g) return 'none'
  for (const entry of TAX_FAMILIES) if (entry.test(g)) return entry.family
  return 'none'
}

/** The slab a tax ledger name states — `Output CGST @9%` → 9, `IGST 18` → 18. */
export function taxRateFromName(ledgerName: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*%?/.exec(String(ledgerName ?? ''))
  if (!m) return null
  const n = tallyNumber(m[1])
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return n
}

/** A half-rate (CGST 9) is a full slab of 18; an IGST 18 is already full. */
export function fullRateFor(family: TaxFamily, halfOrFull: number): number {
  return family === 'cgst' || family === 'sgst' ? halfOrFull * 2 : halfOrFull
}

const MONEY_WORDS = [
  'cash', 'bank', 'contra', 'pos', 'card', 'upi', 'imps', 'neft', 'rtgs', 'cheque',
  'check', 'wallet', 'paypal', 'hdfc', 'icici', 'axis', 'sbi', 'kotak', 'yes', 'idfc',
  'loan', 'deposit', 'pettycash',
]

function isMoneyLedger(name: string, group: string): boolean {
  const n = normTagName(name)
  const g = normTagName(group)
  if (g.includes('bankaccount') || g.includes('cash') || g.includes('loans') || g.includes('deposit')) return true
  return MONEY_WORDS.some(w => n.includes(w))
}

/** The ledger line that *is* the value of the goods — account-mode exports write the
 *  stock total against Sales or Purchase, which the inventory lines already state.
 *  Deliberately narrow: an expense ledger ("Freight Charges", "Discount Allowed") is
 *  not the goods value, and a document has nowhere to put it, so it must not vanish
 *  in here — it is reported as an unplaceable ledger instead. */
function isValueLedger(group: string, name: string): boolean {
  const g = normTagName(group)
  const n = normTagName(name)
  return g.includes('sales') || g.includes('purchase') || g.includes('directincome') ||
    g.includes('indirectincome') || g.includes('costofgoods') ||
    n === 'sales' || n === 'purchase'
}

/** `Round Off` is the one ledger line our own totals recompute from the same lines, so
 *  it is absorbed rather than reported; nothing else gets that treatment. */
function isRoundOffLedger(name: string): boolean {
  const n = normTagName(name)
  return n === 'roundoff' || n === 'roundingoff' || n === 'rounding'
}

// ── the reader ────────────────────────────────────────────────────────────────

function flatten(node: XmlNode, out: XmlNode[], insideVoucher = false): void {
  // A nested element of a voucher is an entry, not a master — a `<STOCKITEM>` inside
  // `<ALLINVENTORYENTRIES.LIST>` names a line, it does not define the product twice.
  const isVoucher = normTagName(node.name) === 'voucher'
  out.push(node)
  for (const c of node.children) flatten(c, out, insideVoucher || isVoucher)
}

/**
 * A ledger's opening balance, in both shapes Tally has written it: a signed number on
 * the tag (`-1200000.00`, debit), or a wrapper holding `<NAME>Dr</NAME>` beside an
 * `<AMOUNT>`. Negative is the debit side — money owed to the business.
 */
function openingOf(node: XmlNode): number {
  const names = ['openingbalance', 'openbalamount', 'openingbal', 'obal', 'openingbalanceamount', 'openingdr', 'closingbalance']
  for (const name of names) {
    const child = xmlChild(node, name)
    const plain = xmlAttr(node, name) || (child && !child.children.length ? child.text : '')
    if (plain.trim()) return tallyNumber(plain)
    if (child && child.children.length) {
      const amt = xmlValue(child, 'amount', 'dramount', 'cramount')
      if (amt) {
        const side = xmlValue(child, 'name', 'baldrctype', 'drorcr')
        const n = Math.abs(tallyNumber(amt))
        return /cr/i.test(side) ? n : -n
      }
    }
  }
  return 0
}

function readLedger(node: XmlNode, sourceIndex: number): TallyLedger {
  const name = xmlValue(node, 'name', 'ledgername', 'ledgernameorig', 'securityname')
  const group = xmlValue(node, 'parent', 'gdname', 'groupname', 'ledgerparent', 'under', 'majorgroupname', 'parentname')
  const gstinRaw = xmlValueLike(node, n => n === 'gstin' || n.includes('gstin') || n === 'gstn' || n === 'gstnumber')
  const gstin = String(gstinRaw || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  const pan = String(xmlValueLike(node, n => n === 'pan' || n === 'pannumber' || n === 'pangstin') || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
  const stateName = xmlValue(node, 'statename', 'state', 'stateofbusiness', 'stationstate') ||
    xmlValueLike(node, n => n === 'statename' || n === 'state')
  const phone = xmlValue(node, 'phone', 'mobileno', 'phonenumber', 'no', 'telno', 'contact') ||
    xmlValueLike(node, n => n.includes('phone') || n.includes('mobile') || n === 'tel')
  const email = xmlValue(node, 'email', 'emailid', 'mailid') ||
    xmlValueLike(node, n => n.includes('email') || n.includes('mail'))

  const addressLines = node.children
    .filter(c => normTagName(c.name).startsWith('address'))
    .map(c => leafText(c) || c.text)
    .filter(Boolean)
  const address = addressLines.length
    ? addressLines.join(', ')
    : xmlValue(node, 'address', 'addr1', 'address1', 'shippingaddress', 'postaladdress')

  const opening = openingOf(node)
  const { role, how } = roleOfGroup(group)

  return {
    name: name.trim(),
    group: group.trim(),
    role,
    gstin,
    pan,
    stateName: stateName.trim(),
    stateCode: stateCodeFromName(stateName) || stateCodeFromName(gstin.slice(0, 2)),
    phone: phone.trim(),
    email: email.trim(),
    address,
    opening,
    roleHow: how,
    sourceIndex,
  }
}

function readStockItem(node: XmlNode, sourceIndex: number): TallyStockItem {
  const name = xmlValue(node, 'name', 'stockitemname', 'productname')
  const unit = xmlValue(node, 'baseunits', 'baseunit', 'unit', 'unitname', 'uom', 'naturalname')
  const hsnRaw = xmlValueLike(node, n => n.includes('hsn') || n.includes('sac'))
  const hsn = String(hsnRaw || '').replace(/[^0-9A-Za-z]/g, '')
  const sellingRaw = xmlValueAny(node, [['stdsalesrate'], ['salesrate'], ['sellingrate'], ['rate'], ['stdratesales']])
  const purchaseRaw = xmlValueAny(node, [['stdpurchaserate'], ['stdpurchrate'], ['purchaserate'], ['actualcostrate'], ['costrate'], ['effectivecostrate']])
  const gstRaw = xmlValueLike(node, n => (n.includes('gst') && (n.includes('rate') || n.includes('per') || n === 'gst')) || n === 'setrateofgst' || n === 'gstrate')
  const cessRaw = xmlValueLike(node, n => n.includes('cess') && (n.includes('rate') || n.includes('per')))
  const qtyRaw = xmlValueAny(node, [['openingbalanceqty'], ['openingqty'], ['openingbalqty'], ['actualbatchqty'], ['opbalqty'], ['openingbalanceamountqty']])
  const valueRaw = xmlValueAny(node, [['openingbalanceamount'], ['openingbalancevalue'], ['opbalamount'], ['openingbalvalue']])

  const gstRate = gstRaw ? tallyPercent(gstRaw) : null
  const cessRate = cessRaw ? tallyPercent(cessRaw) : null
  // A SAC (99…) is a service; an HSN is goods. With neither, goods is the safer read
  // and the plan says the item arrived without one, so a service can be re-typed.
  const itemType: 'goods' | 'service' = hsn.startsWith('99') ? 'service' : 'goods'

  return {
    name: name.trim(),
    unit: unit.trim(),
    hsn,
    itemType,
    sellingRate: sellingRaw ? tallyNumber(sellingRaw) : null,
    purchaseRate: purchaseRaw ? tallyNumber(purchaseRaw) : null,
    gstRate: gstRate !== null && gstRate > 0 ? gstRate : null,
    cessRate: cessRate !== null && cessRate > 0 ? cessRate : null,
    openingQty: tallyNumber(qtyRaw),
    openingValue: tallyNumber(valueRaw),
    sourceIndex,
  }
}

function readVoucher(node: XmlNode, sourceIndex: number, ledgerIndex: Map<string, TallyLedger>): TallyVoucher {
  const voucherType = xmlValue(node, 'vouchertypename', 'vchtype', 'typename', 'vouchertype', 'majorminortypenames')
  const typeNorm = normTagName(voucherType)
  // A *Sales Order* is not a sale. Orders are promises, and they travel on the order
  // registers of this app until they are billed, so the word 'order' in the type name
  // wins over the 'sales' or 'purchase' that sits in front of it.
  const isOrderType = typeNorm.includes('order')
  const kind: VoucherKind = isOrderType
    ? 'other'
    : typeNorm.includes('sales') || typeNorm === 'invoice'
      ? 'sales'
      : typeNorm.includes('purchase') || typeNorm.includes('billpurchase')
        ? 'purchase'
        : 'other'

  const number = xmlValue(node, 'vouchernumber', 'number', 'docnumber', 'documentnumber', 'tagvalue', 'vouchercode')
  const dateTags: [string, string][] = [
    ['date', 'date'],
    ['effectivedate', 'effective date'],
    ['dateofdocument', 'date of document'],
    ['posteddate', 'posted date'],
    ['createdate', 'create date'],
  ]
  let date = ''
  let dateFrom = ''
  for (const [tag, label] of dateTags) {
    const raw = xmlValue(node, tag)
    if (!raw) continue
    const parsed = tallyDate(raw)
    if (parsed) {
      date = parsed
      dateFrom = label
      break
    }
  }

  const entries: TallyEntry[] = []
  for (const listNode of xmlChildrenLike(node, 'ledgerentries')) {
    const ledger = xmlValue(listNode, 'ledgername', 'name', 'ledger', 'compactedledgername')
    if (!ledger) continue
    const rawAmount = xmlValue(listNode, 'amount', 'dramount', 'cramount', 'value')
    const amount = tallyNumber(rawAmount)
    // Tally flags the debit side; a file that only carries `BalDrCrType = Cr` says the
    // same thing in the older words. Either way it is information, never arithmetic.
    const deemed = xmlValue(listNode, 'isdeemedpositive')
    const drCr = xmlValue(listNode, 'baldrctype', 'drorcr')
    const deemedPositive = deemed ? !/^no/i.test(deemed) : !/^\s*cr/i.test(drCr)
    const known = ledgerIndex.get(normTagName(ledger))
    const group = known?.group || xmlValue(listNode, 'parent', 'gdname')
    const family = taxFamilyOf(ledger)
    const nameRate = taxRateFromName(ledger)
    const isParty = /yes/i.test(xmlValue(listNode, 'ispartyledger')) || known?.role === 'customer' || known?.role === 'vendor'

    let entryKind: EntryKind = 'other'
    if (family !== 'none') entryKind = 'tax'
    else if (isParty) entryKind = 'party'
    else if (isMoneyLedger(ledger, group)) entryKind = 'money'
    else if (isValueLedger(group, ledger)) entryKind = 'value'

    entries.push({
      ledger: ledger.trim(),
      amount,
      absolute: Math.abs(amount),
      deemedPositive,
      isParty,
      group,
      kind: entryKind,
      taxFamily: family,
      // A CGST @9 line is a 18% slab; IGST @18 is already one.
      rate: family !== 'none' && nameRate !== null ? fullRateFor(family, nameRate) : null,
    })
  }

  const lines: TallyLine[] = []
  for (const listNode of xmlChildrenLike(node, 'inventoryentries')) {
    const item = xmlValue(listNode, 'stockitemname', 'name', 'productname', 'compactedledgername')
    if (!item) continue
    const qtyRaw = xmlValueAny(listNode, [['actualqty'], ['billedqty'], ['qty'], ['quantity'], ['inwardqty'], ['outwardqty']])
    const qty = tallyNumber(qtyRaw)
    const rateRaw = xmlValueAny(listNode, [['rate'], ['stdrate'], ['unitrate'], ['costrate'], ['actualrate']])
    const rate = tallyNumber(rateRaw)
    const discRaw = xmlValue(listNode, 'discount', 'discamount', 'discountamount')
    const discountIsPercent = discRaw.includes('%')
    const assessableRaw = xmlValueLike(listNode, n => n.includes('assessable') || n === 'taxablevalue' || n === 'paidvalue' || n === 'value')
    const lineTaxRaw = xmlValueLike(listNode, n => (n.includes('gst') && n.includes('amount')) || n === 'taxamount' || n.includes('taxesonvalue'))
    const lineRateRaw = xmlValueLike(listNode, n => (n.includes('gst') && n.includes('per')) || n === 'taxpercent' || n.includes('gstrate'))
    const known = ledgerIndex.get(normTagName(item))
    void known // the line's own master is a stock item, not a ledger — buildPlan looks it up there

    // The line's side: Tally flags a sale's goods as deemed-positive No (a credit, the
    // value leaving) and a purchase's stock as Yes (a debit, the value arriving). A file
    // that omits the flag on a voucher type we know gets the side that type always has.
    const lineDeemed = xmlValue(listNode, 'isdeemedpositive')
    const deemedPositive = lineDeemed ? !/^no/i.test(lineDeemed) : kind === 'purchase'

    const gross = Math.abs(qty * rate)
    // A discount tag is either a percent ("5.00%") or an amount ("10.00"). Reading a
    // percent as an amount would take ₹5 off a ₹5,00,000 line and call it a day.
    const discountPercent = discountIsPercent ? tallyPercent(discRaw) : gross > 0 ? round2(Math.abs(tallyNumber(discRaw)) / gross * 100) : 0
    const discount = discountIsPercent
      ? round2(gross * tallyPercent(discRaw) / 100)
      : Math.abs(tallyNumber(discRaw))
    const derivedTaxable = round2(gross - discount)
    const fromFile = assessableRaw ? Math.abs(tallyNumber(assessableRaw)) : 0
    const taxable = fromFile > 0 ? fromFile : derivedTaxable

    lines.push({
      item: item.trim(),
      qty,
      rate: Math.abs(rate),
      gross: round2(gross),
      discount,
      discountPercent,
      taxable,
      taxableFrom: fromFile > 0 ? 'file' : 'derived',
      discountHow: !discRaw || tallyPercent(discRaw) === 0 ? 'none' : discountIsPercent ? 'percent' : 'amount',
      tax: lineTaxRaw ? Math.abs(tallyNumber(lineTaxRaw)) : null,
      taxRate: lineRateRaw ? tallyPercent(lineRateRaw) : null,
      deemedPositive,
      hsn: xmlValueLike(listNode, n => n.includes('hsn') || n.includes('sac')).replace(/[^0-9A-Za-z]/g, ''),
      unit: xmlValue(listNode, 'unit', 'baseunits', 'uom'),
    })
  }

  const tax = { cgst: 0, sgst: 0, igst: 0, cess: 0 }
  const otherLedgers: { ledger: string; amount: number }[] = []
  const moneyLedgers: { ledger: string; amount: number }[] = []
  const problems: VoucherProblem[] = []

  let partyEntries = 0
  for (const entry of entries) {
    if (entry.kind === 'tax' && entry.taxFamily !== 'none') tax[entry.taxFamily] = round2(tax[entry.taxFamily] + entry.absolute)
    else if (entry.kind === 'money') moneyLedgers.push({ ledger: entry.ledger, amount: entry.absolute })
    else if (entry.kind === 'other' && !isRoundOffLedger(entry.ledger)) {
      otherLedgers.push({ ledger: entry.ledger, amount: entry.absolute })
    }
    if (entry.isParty && entry.kind !== 'tax') partyEntries++
  }

  const partyRaw = xmlValue(node, 'partyledgername', 'partyname', 'partyledger', 'accountname')
  let party = partyRaw.trim()
  let partyHow = party ? 'the voucher’s own party tag' : ''
  if (!party) {
    const flagged = entries.find(e => e.isParty && e.kind !== 'tax')
    if (flagged) {
      party = flagged.ledger
      partyHow = 'the entry flagged as the party ledger'
    }
  }
  if (!party && partyEntries === 0) partyHow = 'no party in the file'

  const statedRaw = xmlValueAny(node, [
    ['total'], ['grandtotal'], ['grosstotal'], ['invoicevalue'], ['documentamount'], ['basicordervalue'],
  ])
  const statedTotal = statedRaw ? tallyNumber(statedRaw) : null

  // Σ of signed values. A ledger entry is signed as the file writes it; a stock line is
  // the value of the goods, on the side the voucher put it — so a whole voucher, sale or
  // purchase alike, reads as zero. Anything else is a file that stopped mid-object.
  let balance = 0
  for (const entry of entries) balance += entry.amount
  for (const line of lines) balance += line.deemedPositive ? -line.taxable : line.taxable
  balance = round2(balance)

  if (lines.some(l => l.qty < 0)) {
    problems.push({ key: 'negative-qty', text: 'A line carries a negative quantity — this voucher reverses stock, it does not sell it' })
  }
  if (!lines.length) {
    problems.push({ key: 'no-lines', text: 'No stock or service lines in the file — only ledger entries, and an invoice has to print lines' })
  }
  if (!party) problems.push({ key: 'no-party', text: 'No party ledger on the voucher — whose invoice is it?' })
  if (!date) problems.push({ key: 'no-date', text: 'No readable date — the financial year it books into cannot be determined' })
  if (kind === 'other') {
    problems.push({ key: 'other-kind', text: `A “${voucherType || 'unnamed'}” voucher is not a sale or a purchase; v1 imports those two and this one stays in Tally` })
  }
  if (otherLedgers.length) {
    problems.push({
      key: 'other-ledger',
      text: `${otherLedgers.map(o => `“${o.ledger}” ₹${o.amount.toLocaleString('en-IN')}`).join(', ')} — neither a tax, a line item, nor money, and a tax invoice has nowhere to put ${otherLedgers.length === 1 ? 'it' : 'them'}`,
    })
  }

  return {
    voucherType: voucherType.trim(),
    kind,
    number: number.trim(),
    date,
    dateFrom,
    reference: xmlValue(node, 'reference', 'referencenumber', 'narration').trim(),
    party,
    partyHow,
    reverseCharge: /yes|^true|1$/i.test(xmlValue(node, 'isreversecharge', 'reversecharge', 'isreversechargeapplicable')),
    entries,
    lines,
    tax,
    otherLedgers,
    moneyLedgers,
    statedTotal,
    balance,
    problems,
    sourceIndex,
  }
}

/** Is this pasted file a Tally *request* (asking Tally for data) rather than the data? */
function envelopeKind(roots: XmlNode[]): 'export' | 'request' | 'unknown' {
  const text: string[] = []
  const collect = (n: XmlNode, depth: number) => {
    if (depth > 4) return
    if (normTagName(n.name).includes('tallyrequest') || normTagName(n.name).includes('dtype') || normTagName(n.name).includes('reportname')) {
      // The values are folded too: Tally writes `<TALLYREQUEST>Export Data</TALLYREQUEST>`
      // with the capital the screen shows, and a case-sensitive read of it would call
      // every real export an unknown file.
      text.push(normTagName(n.name), normTagName(leafText(n)))
      for (const c of n.children) text.push(normTagName(leafText(c)))
    }
    for (const c of n.children) collect(c, depth + 1)
  }
  for (const r of roots) collect(r, 0)
  const joined = text.join(' ')
  if (joined.includes('importdata') || joined.includes('updatedata')) return 'request'
  if (joined.includes('export') || joined.includes('databrowse') || joined.includes('vouchers') || joined.includes('ledger')) return 'export'
  return 'unknown'
}

export function readTally(xml: string): TallyDump {
  const doc = parseXml(xml)
  const flat: XmlNode[] = []
  for (const root of doc.roots) flatten(root, flat)

  const ledgers: TallyLedger[] = []
  const stockItems: TallyStockItem[] = []
  const vouchers: TallyVoucher[] = []
  const skipped: SkippedObject[] = []
  const objectTags: Record<string, number> = {}
  let company: TallyCompany | null = null

  const seenLedger = new Map<string, number>()
  const seenItem = new Map<string, number>()

  // Masters first pass: the ledger index is needed to group a voucher's entries.
  const ledgerIndex = new Map<string, TallyLedger>()
  const masterNodes: { node: XmlNode; tag: string; index: number }[] = []
  flat.forEach((node, index) => {
    const tag = normTagName(node.name)
    if (tag === 'ledger' || tag === 'stockitem' || tag === 'voucher' || tag === 'company') {
      objectTags[node.name] = (objectTags[node.name] || 0) + 1
    }
    if (tag === 'ledger' || tag === 'stockitem') masterNodes.push({ node, tag, index })
  })

  for (const { node, tag, index } of masterNodes) {
    if (tag === 'ledger') {
      const ledger = readLedger(node, index)
      if (!ledger.name) {
        skipped.push({ tag: node.name, name: '', reason: 'A ledger with no name on it — there is nothing to match a document to' })
        continue
      }
      const key = normTagName(ledger.name)
      if (seenLedger.has(key)) {
        skipped.push({ tag: node.name, name: ledger.name, reason: `Already read earlier in this file (ledger objects repeat when a dump includes both the master and the voucher that used it)` })
        continue
      }
      seenLedger.set(key, ledgers.length)
      ledgers.push(ledger)
      ledgerIndex.set(key, ledger)
    } else {
      const item = readStockItem(node, index)
      if (!item.name) {
        skipped.push({ tag: node.name, name: '', reason: 'A stock item with no name — Tally would not have accepted it either' })
        continue
      }
      const key = normTagName(item.name)
      if (seenItem.has(key)) {
        skipped.push({ tag: node.name, name: item.name, reason: 'Already read earlier in this file' })
        continue
      }
      seenItem.set(key, stockItems.length)
      stockItems.push(item)
    }
  }

  flat.forEach((node, index) => {
    const tag = normTagName(node.name)
    if (tag === 'voucher') {
      vouchers.push(readVoucher(node, index, ledgerIndex))
      return
    }
    if (tag === 'company') {
      const name = xmlValue(node, 'name', 'companyname', 'dbname')
      const gstin = xmlValueLike(node, n => n.includes('gstin'))
      const stateName = xmlValue(node, 'statename', 'state')
      company = {
        name: name.trim(),
        stateName: stateName.trim(),
        gstin: String(gstin || '').toUpperCase().replace(/[^0-9A-Z]/g, ''),
        financialYear: xmlValue(node, 'fyearfromto', 'financialyear', 'fyfromto').trim(),
      }
      return
    }
    if (OBJECT_LIKE_TAGS.has(tag) && tag !== 'ledger' && tag !== 'stockitem') {
      const name = xmlValue(node, 'name', 'typename', 'unitname', 'symbol')
      skipped.push({
        tag: node.name,
        name: name.trim(),
        reason: tag === 'vouchertype'
          ? 'A voucher type is Tally’s setting, not a document — the vouchers under it are what get read'
          : tag === 'unit'
            ? 'A unit of measure: it travels on the stock item that uses it'
            : `A ${tag === 'group' || tag === 'tallygroup' ? 'group' : tag === 'category' || tag === 'tallycategory' ? 'category' : tag} is how Tally files its own register — it is not a customer, a product, an invoice or a bill`,
      })
    }
  })

  const issues = [...doc.issues]
  if (!ledgers.length && !stockItems.length && !vouchers.length) {
    issues.push({
      at: -1,
      message: envelopeKind(doc.roots) === 'request'
        ? 'This is a Tally *request* file — it asks Tally for data. In TallyPrime: Export → Data → (the report) → XML, and paste or drop what comes out.'
        : 'No Tally objects in here — a ledger, a stock item or a voucher is what this reads.',
    })
  }

  return {
    envelope: envelopeKind(doc.roots),
    company,
    ledgers,
    stockItems,
    vouchers,
    skipped,
    issues,
    objectTags,
    parsedNodes: doc.roots.length ? flat.length : 0,
  }
}

// ── the plan: what the file means here ────────────────────────────────────────
//
// The dump is Tally's words; the plan is ours. Every row says which of our tables
// it would land in, whether the file supports that, and — when it does not — the
// name that is missing. Four states, no fifth: `ready` writes, `blocked` is a
// document whose inputs are not there yet (import the masters and it becomes
// ready), `already` means the register has this row, and `skipped` says the object
// is not something this app holds.

export type PlanTarget = 'customer' | 'vendor' | 'product' | 'invoice' | 'purchase_bill' | 'other'
export type PlanStatus = 'ready' | 'blocked' | 'skipped' | 'already'

export const TARGET_LABEL: Record<PlanTarget, string> = {
  customer: 'Customer',
  vendor: 'Vendor',
  product: 'Product',
  invoice: 'Sales invoice',
  purchase_bill: 'Purchase bill',
  other: 'Not imported',
}

export const STATUS_LABEL: Record<PlanStatus, string> = {
  ready: 'Ready',
  blocked: 'Blocked',
  skipped: 'Skipped',
  already: 'Already on file',
}

export interface PlanRequirement {
  key: string
  what: string
}

export interface PlanItem {
  key: string
  target: PlanTarget
  status: PlanStatus
  /** The name or number a human would recognise. */
  title: string
  /** One line of context: the group, the unit, the party and date. */
  subtitle: string
  /** The row the write path receives, field for field. */
  fields: Record<string, unknown>
  lines: Record<string, unknown>[]
  reasons: string[]
  /** How a number was arrived at — derivation is always labelled. */
  derived: string[]
  /** Read this before filing: a disagreement inside the file, or a rule it cannot show. */
  flags: string[]
  /** Masters this document needs; `expandSelection` pulls them in. */
  requires: PlanRequirement[]
  /** The id of the row already on the register, when `status === 'already'`. */
  matchedId: string
  /** The Tally identifier carried through, so the two books tie back. */
  tallyRef: string
  rupees: number
  sourceIndex: number
}

export interface ExistingParty {
  id: string
  name: string
  gstin?: string | null
  state_code?: string | null
  phone?: string | null
}

export interface ExistingProduct {
  id: string
  name: string
  hsn_sac?: string | null
  sku?: string | null
  unit?: string | null
}

export interface ExistingDocument {
  id: string
  number?: string | null
  notes?: string | null
  date?: string | null
  party_name?: string | null
  grand_total?: number | null
}

export interface Existing {
  customers?: ExistingParty[]
  vendors?: ExistingParty[]
  products?: ExistingProduct[]
  invoices?: ExistingDocument[]
  bills?: ExistingDocument[]
}

export interface OrgIdentity {
  /** State code of the org's primary GSTIN — place of supply needs it. */
  stateCode: string
  gstin?: string
  name?: string
}

export interface PlanSummary {
  objects: number
  ledgers: number
  stockItems: number
  vouchers: number
  ready: number
  blocked: number
  skipped: number
  already: number
  /** Rows carrying at least one "look at this" — the file disagreed with itself somewhere. */
  attention: number
  /** Count and ₹ per target, ready only — what "Import" would actually write. */
  byTarget: Record<PlanTarget, { count: number; rupees: number }>
  /** Earliest and latest document date in the file, for the header line. */
  from: string
  to: string
}

export interface ImportPlan {
  items: PlanItem[]
  summary: PlanSummary
}

export function planKey(target: PlanTarget, nameOrId: string): string {
  return `${target}:${normTagName(nameOrId)}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function findParty(existing: ExistingParty[], name: string, gstin: string): ExistingParty | null {
  const want = normTagName(name)
  if (!want) return null
  const byName = existing.find(p => normTagName(p.name) === want)
  if (byName) return byName
  if (gstin) {
    const byGstin = existing.find(p => (p.gstin || '').toUpperCase() === gstin.toUpperCase())
    if (byGstin) return byGstin
  }
  return null
}

function findProduct(existing: ExistingProduct[], name: string, hsn: string, unit: string): ExistingProduct | null {
  const want = normTagName(name)
  if (!want) return null
  const byName = existing.find(p => normTagName(p.name) === want)
  if (byName) return byName
  if (hsn) {
    const byHsn = existing.find(p => (p.hsn_sac || '').replace(/[^0-9A-Za-z]/g, '') === hsn)
    if (byHsn) return byHsn
  }
  if (unit) {
    const bySku = existing.find(p => p.sku && normTagName(p.sku) === want)
    if (bySku) return bySku
  }
  return null
}

/**
 * A Tally party ledger is only a customer or a vendor to us when its *group* says so.
 * Everything else — Cash, Sales, Duties & Taxes, a branch's current account — is a
 * line in the shop's books, not a counterparty, and the reason says which group it was.
 */
function partyItem(ledger: TallyLedger, target: PlanTarget, existing: ExistingParty[]): PlanItem {
  const isCustomer = target === 'customer'
  const derived: string[] = [`Read as ${ledger.roleHow}`]
  const flags: string[] = []
  const reasons: string[] = []

  const gstin = ledger.gstin
  if (gstin && gstin.length === 15 && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)) {
    flags.push(`“${gstin}” is not a valid GSTIN shape — 2 state digits, a 10-character PAN, an entity check code, Z and a checksum`)
  }
  if (gstin && ledger.stateCode && gstin.slice(0, 2) !== ledger.stateCode) {
    flags.push(`The GSTIN says state ${gstin.slice(0, 2)} and the state on the ledger says ${ledger.stateName} (${ledger.stateCode}) — the invoice will use the GSTIN’s state as the place of supply`)
  }
  if (!gstin) flags.push('No GSTIN on this ledger in Tally — the party lands as unregistered (B2C)')

  if (ledger.stateName && !ledger.stateCode) {
    flags.push(`“${ledger.stateName}” is not a state on the GST list, so the party is stored with no state code and each document settles its own place of supply`)
  } else if (!ledger.stateCode) {
    // Our own state is *not* written into the party: a walk-in counter's state is
    // unknown, not Maharashtra-by-default. The place of supply is a property of the
    // supply, so it is decided — and labelled — on the document row instead.
    flags.push('No state on this ledger in Tally — the party is stored without one, and the place of supply is decided on each document')
  } else if (!ledger.stateName) {
    derived.push('The state name is taken from the GSTIN’s first two digits, which the GST format makes the state code')
  }

  const fields: Record<string, unknown> = {
    name: ledger.name,
    business_name: ledger.name,
    gstin,
    pan: ledger.pan,
    address_line1: ledger.address,
    address_line2: '',
    city: '',
    state: ledger.stateName || stateNameFromCode(ledger.stateCode),
    state_code: ledger.stateCode || '',
    pincode: '',
    phone: ledger.phone,
    email: ledger.email,
    payment_terms: 0,
    notes: `From Tally ledger${ledger.group ? ` under ${ledger.group}` : ''}`,
  }
  if (isCustomer) fields.customer_type = gstin ? 'b2b' : 'b2c'
  derived.push(
    gstin
      ? 'Registered under GST (the file carries a GSTIN), so the invoice type it takes is B2B'
      : 'Unregistered in the file, so the invoice type it takes is B2C',
  )
  if (!ledger.address && !ledger.phone && !ledger.email) {
    derived.push('An address, phone or email belongs on a tax invoice; this ledger has none of them')
  }

  const match = findParty(existing, ledger.name, gstin)
  if (match) {
    reasons.push(`A ${isCustomer ? 'customer' : 'vendor'} named “${match.name}”${match.gstin ? ` with this GSTIN or name` : ''} is already on the register — nothing new to write`)
  }

  return {
    key: planKey(target, ledger.name),
    target,
    status: match ? 'already' : 'ready',
    title: ledger.name,
    subtitle: ledger.group ? `Tally group: ${ledger.group}` : 'No group in the file',
    fields,
    lines: [],
    reasons,
    derived,
    flags,
    requires: [],
    matchedId: match?.id || '',
    tallyRef: ledger.name,
    rupees: Math.abs(ledger.opening),
    sourceIndex: ledger.sourceIndex,
  }
}

/**
 * A stock item becomes a product with the tax it was sold at. Tally stores the rate of
 * GST on the item or on the ledger it taxed into; whichever the file shows is what is
 * written, and the plan says which.
 */
function productItem(item: TallyStockItem, existing: ExistingProduct[]): PlanItem {
  const derived: string[] = []
  const flags: string[] = []
  const reasons: string[] = []

  if (!item.hsn) {
    flags.push('No HSN or SAC in the file — a tax invoice has to print one, so fill it in on the product after importing')
  }
  if (item.gstRate === null) {
    derived.push('No rate of tax on the item — it lands at 0% and is edited on the product page if that is wrong')
  } else {
    const slab = GST_RATES.find(r => Math.abs(r - item.gstRate!) < 0.005)
    if (slab === undefined) flags.push(`${item.gstRate}% is not a rate on the current GST table (0 / 5 / 18 / 40, with 0.25, 3, 12 and 28 kept for older documents)`)
    derived.push(`Rate of tax read off the stock item${item.cessRate ? `, plus a ${item.cessRate}% cess` : ''}`)
  }

  const track = item.itemType === 'goods'
  if (item.openingQty !== 0 && !track) {
    flags.push(`A quantity of ${item.openingQty} sits against this service line — services do not carry stock`)
  }
  derived.push(
    item.hsn.startsWith('99')
      ? 'A SAC (99…) is a service'
      : item.hsn
        ? 'An HSN is goods, so stock is tracked'
        : 'Neither HSN nor SAC: read as goods, the safer of the two for stock',
  )

  const fields: Record<string, unknown> = {
    name: item.name,
    description: '',
    sku: '',
    type: item.itemType,
    hsn_sac: item.hsn,
    unit: item.unit || 'NOS',
    purchase_price: item.purchaseRate ?? 0,
    selling_price: item.sellingRate ?? 0,
    gst_rate: item.gstRate ?? 0,
    cess_rate: item.cessRate ?? 0,
    track_inventory: track,
    opening_stock: track ? item.openingQty : 0,
    minimum_stock: 0,
  }
  if (item.itemType === 'goods' && item.unit) derived.push(`Stock counted in “${item.unit}”`)

  const match = findProduct(existing, item.name, item.hsn, '')
  if (match) reasons.push(`A product named “${match.name}” is already on the register — the vouchers in this file will be matched to it, not to a new row`)

  return {
    key: planKey('product', item.name),
    target: 'product',
    status: match ? 'already' : 'ready',
    title: item.name,
    subtitle: [item.hsn ? `HSN/SAC ${item.hsn}` : '', item.unit ? `in ${item.unit}` : '', item.gstRate ? `${item.gstRate}% GST` : ''].filter(Boolean).join(' · ') || 'No HSN, unit or rate in the file',
    fields,
    lines: [],
    reasons,
    derived,
    flags,
    requires: [],
    matchedId: match?.id || '',
    tallyRef: item.name,
    rupees: Math.abs(item.openingValue),
    sourceIndex: item.sourceIndex,
  }
}

interface RateResolution {
  gstType: GSTType
  /** One rate for every line, or per-line rates the file itself stated. */
  docRate: number
  perLine: (number | null)[]
  derived: string[]
  flags: string[]
  blocked: string[]
}

/**
 * Tally keeps tax in *ledger lines* named for the slab; our invoice keeps it per line.
 * This resolves one rate (or a per-line list) from what the file actually shows, and
 * reports a disagreement instead of smoothing it over.
 */
function resolveRates(v: TallyVoucher, taxable: number): RateResolution {
  const derived: string[] = []
  const flags: string[] = []
  const blocked: string[] = []
  const tax = v.tax
  const taxWithoutCess = round2(tax.cgst + tax.sgst + tax.igst)
  const cess = tax.cess

  // The file's own tax split is the strongest statement of what was charged: a voucher
  // with CGST and SGST was a same-state supply whatever the two states later turn out to be.
  const gstType: GSTType = (tax.cgst > 0 || tax.sgst > 0) && tax.igst === 0
    ? 'cgst_sgst'
    : tax.igst > 0
      ? 'igst'
      : 'cgst_sgst'

  if (tax.igst > 0 && (tax.cgst > 0 || tax.sgst > 0)) {
    flags.push(`The file carries both IGST (₹${tax.igst.toLocaleString('en-IN')}) and CGST/SGST in one voucher — a supply is either intra- or inter-state, not both`)
  }

  const perLineRates = v.lines.map(l => l.taxRate)
  const everyLineStatesRate = perLineRates.every(r => r !== null) && v.lines.length > 0
  const nameRates = [...new Set(v.entries.filter(e => e.kind === 'tax' && e.rate !== null).map(e => e.rate as number))]

  let docRate = 0
  let perLine: (number | null)[] = perLineRates.map(() => null)

  if (taxWithoutCess === 0 && cess === 0) {
    derived.push('No tax ledgers in the voucher — it reads as an exempt supply, or a bill whose tax Tally filed elsewhere')
    return { gstType: 'cgst_sgst', docRate: 0, perLine: perLineRates.map(() => 0), derived, flags, blocked }
  }

  if (taxWithoutCess === 0 && cess > 0) {
    // Cess rides on the line that carries it, never on the voucher's GST rate: charging
    // the cess rate as GST would tax the goods twice over.
    derived.push('Only cess is taxed in the file, so the GST rate of these lines is 0 and the cess rides on the line that states it')
    return { gstType: 'cgst_sgst', docRate: 0, perLine: perLineRates.map(() => 0), derived, flags, blocked }
  }

  if (everyLineStatesRate && perLineRates.some(r => (r ?? 0) > 0)) {
    perLine = perLineRates
    docRate = round2((taxWithoutCess / Math.max(taxable, 0.01)) * 100)
    derived.push('Each line carries its own rate of tax in the file, so the split is taken line by line')
  } else if (nameRates.length === 1) {
    docRate = nameRates[0]
    derived.push(`The rate of tax comes from the tax ledger name (${v.entries.find(e => e.kind === 'tax')?.ledger})`)
  } else if (nameRates.length > 1) {
    blocked.push(`Two rates of tax in one voucher (${nameRates.map(r => `${r}%`).join(' and ')}), and the file does not say which line carries which`)
    docRate = nameRates[0]
  } else {
    const implied = taxable > 0 ? round2((taxWithoutCess / taxable) * 100) : 0
    const slab = GST_RATES.find(r => Math.abs(r - implied) < 0.05)
    docRate = slab ?? implied
    derived.push(
      slab !== undefined
        ? `Derived from ₹${taxWithoutCess.toLocaleString('en-IN')} of tax on ₹${taxable.toLocaleString('en-IN')} — ${implied}%, which rounds to the ${slab}% slab`
        : `Derived from ₹${taxWithoutCess.toLocaleString('en-IN')} of tax on ₹${taxable.toLocaleString('en-IN')} — ${implied}%`,
    )
    if (slab === undefined && implied > 0) {
      flags.push(`${implied}% is not a rate on the current GST table; the line will carry the rate as read`)
    }
  }

  const expected = round2((taxable * docRate) / 100)
  if (taxable > 0 && Math.abs(expected - taxWithoutCess) > 1) {
    flags.push(`At ${docRate}% these lines come to ₹${expected.toLocaleString('en-IN')} of tax; the file’s tax ledgers hold ₹${taxWithoutCess.toLocaleString('en-IN')}. The lines win — that is what the shop billed.`)
  }

  return { gstType, docRate, perLine, derived, flags, blocked }
}

/**
 * One voucher → one document row, or a reason it cannot be one.
 *
 * `parties` / `products` are the plan's own master rows, so a document in the same
 * file can depend on a customer the file also introduces; `existing` is what the app
 * already has. A name that is in neither is the block.
 */
function documentItem(
  v: TallyVoucher,
  org: OrgIdentity,
  parties: Map<string, PlanItem>,
  products: Map<string, PlanItem>,
  stockIndex: Map<string, TallyStockItem>,
  existing: Existing,
): PlanItem {
  const isSale = v.kind === 'sales'
  const target: PlanTarget = isSale ? 'invoice' : 'purchase_bill'
  const reasons: string[] = []
  const derived: string[] = []
  const flags: string[] = []
  const requires: PlanRequirement[] = []
  const tallyRef = [v.voucherType, v.number && `#${v.number}`].filter(Boolean).join(' ')

  if (v.date) derived.push(`Date read from ${v.dateFrom || 'the voucher'} — it books into the ${v.date.slice(0, 4)}–${Number(v.date.slice(0, 4)) + 1} financial year if the month says so`)
  derived.push('The Tally voucher number travels in the notes of the document; our own invoice and bill numbers come from this app’s sequence')

  // ── the party ──
  let party: PlanItem | null = null
  let matched = ''
  if (v.party) {
    party = parties.get(planKey(isSale ? 'customer' : 'vendor', v.party)) || null
    const existingMatch = findParty(isSale ? existing.customers || [] : existing.vendors || [], v.party, party?.fields.gstin as string || '')
    if (existingMatch) matched = existingMatch.id
    if (!party && !matched) {
      // A counterparty may be in the file under the *other* role's group (a firm that
      // both sells to and buys from us). Say so rather than assume.
      const other = parties.get(planKey(isSale ? 'vendor' : 'customer', v.party))
      if (other) reasons.push(`“${v.party}” is on the file as the other kind of party — ${isSale ? 'customers' : 'vendors'} come from ${isSale ? 'Sundry Debtors' : 'Sundry Creditors'}`)
      else reasons.push(`“${v.party}” is neither in this file as a ${isSale ? 'customer' : 'vendor'} nor on the ${isSale ? 'customer' : 'vendor'} register — add the ${isSale ? 'customer' : 'vendor'} (or import the masters in this file) and this document unblocks`)
    }
    if (party) requires.push({ key: party.key, what: `${party.title} as a ${isSale ? 'customer' : 'vendor'}` })
  } else {
    reasons.push(v.partyHow === 'no party in the file'
      ? `The voucher names no party ledger, and none of its ${v.entries.length} entries is flagged as one — whose ${isSale ? 'invoice' : 'bill'} is this?`
      : `The party could not be found on this voucher (${v.partyHow})`)
  }

  const gstinOfParty = (party?.fields.gstin as string) || ''
  const stateOfParty = (party?.fields.state_code as string) || ''

  let placeOfSupply = ''
  if (gstinOfParty && gstinOfParty.length === 15) placeOfSupply = gstinOfParty.slice(0, 2)
  else if (stateOfParty) placeOfSupply = stateOfParty
  else if (org.stateCode) {
    placeOfSupply = org.stateCode
    flags.push(`No state on the party in the file, so the place of supply is taken as this business’s own state (${org.stateCode}) — right for a counterparty served from the same place, wrong for one that is not`)
  } else {
    reasons.push('Neither the party’s GSTIN nor its state gives a place of supply, and this organisation has no primary GSTIN state to fall back on — set it in Settings')
  }
  if (placeOfSupply) derived.push(`Place of supply ${placeOfSupply}${stateNameFromCode(placeOfSupply) ? ` (${stateNameFromCode(placeOfSupply)})` : ''}`)

  // ── the lines ──
  const missingItems: string[] = []
  const linePlan: { line: TallyLine; productKey: string; matchedId: string }[] = []
  for (const line of v.lines) {
    const product = products.get(planKey('product', line.item))
    const existingProduct = findProduct(existing.products || [], line.item, line.hsn || '', '')
    if (!product && !existingProduct) missingItems.push(line.item)
    else if (product) requires.push({ key: product.key, what: `${product.title} as a product` })
    linePlan.push({ line, productKey: product ? product.key : '', matchedId: existingProduct?.id || '' })
  }
  if (missingItems.length) {
    const shown = missingItems.slice(0, 3).map(n => `“${n}”`).join(', ')
    reasons.push(`${missingItems.length === 1 ? `${shown} is` : `${shown}${missingItems.length > 3 ? ` and ${missingItems.length - 3} more` : ' are'}`} neither a stock item in this file nor a product on the register — a line has to name something`)
  }
  if (!v.lines.length) {
    reasons.push(`The voucher carries ${v.entries.length} ledger entr${v.entries.length === 1 ? 'y' : 'ies'} and no stock or service line — the file shows money moving, not what was sold. ${isSale ? 'An invoice has to print at least one line.' : 'A bill has to show what was bought.'}`)
  }

  // The reader's own findings, routed by what they mean here: no date or a reversed
  // quantity blocks the document, a ledger with nowhere to go is a warning to read
  // before filing. `no-lines` and `no-party` are said better above, in the words of
  // the page, and `other-kind` never reaches this function at all.
  for (const problem of v.problems) {
    if (problem.key === 'no-date' || problem.key === 'negative-qty') reasons.push(problem.text)
    else if (problem.key === 'other-ledger') flags.push(problem.text)
  }

  // ── the money ──
  const taxableFromLines = round2(v.lines.reduce((s, l) => s + l.taxable, 0))
  const rates = resolveRates(v, taxableFromLines)
  derived.push(...rates.derived)
  flags.push(...rates.flags)
  reasons.push(...rates.blocked)

  if (Math.abs(v.balance) > 0.05) {
    flags.push(`The voucher’s own lines do not balance to zero (off by ₹${Math.abs(v.balance).toLocaleString('en-IN')}) — a file cut off mid-voucher, or an amount this reader could not parse`)
  }

  // Our engine takes a discount as a percent and a rate per line; the file gives either.
  // Every conversion here is arithmetic on the file's numbers, and the plan says which.
  const computed: LineItemResult[] = []
  const itemsPayload: Record<string, unknown>[] = []
  let amountDiscounts = 0
  // A cess rate belongs on the line. The stock item states one; where it does not, a
  // single cess ledger in the voucher states it for the whole supply — the file's own
  // words. Two different cess rates in one voucher are not attributable, so none is used.
  const cessLedgerRates = [...new Set(v.entries
    .filter(e => e.taxFamily === 'cess' && e.rate !== null)
    .map(e => e.rate as number))]
  const fileCessRate = cessLedgerRates.length === 1 ? cessLedgerRates[0] : 0
  let cessCameFromLedger = false
  v.lines.forEach((line, idx) => {
    const stock = stockIndex.get(normTagName(line.item))
    const perItemRate = rates.perLine[idx]
    const gst_rate = perItemRate !== null && perItemRate > 0 ? perItemRate : rates.docRate
    const stockCess = stock?.cessRate ?? 0
    const cess_rate = v.tax.cess > 0 ? (stockCess || fileCessRate) : 0
    if (v.tax.cess > 0 && !stockCess && fileCessRate) cessCameFromLedger = true
    if (v.tax.cess > 0 && stockCess && fileCessRate && stockCess !== fileCessRate) {
      flags.push(`Line ${idx + 1} (${line.item}): the stock item states a ${stockCess}% cess and this voucher’s cess ledger states ${fileCessRate}% — the item’s own rate is used`)
    }
    if (line.discountHow === 'amount') amountDiscounts++
    const result = calculateLineItem(
      {
        quantity: Math.abs(line.qty),
        rate: line.rate,
        discount_percent: line.discountPercent,
        gst_rate,
        cess_rate,
      },
      rates.gstType,
    )
    computed.push(result)
    const resolved = linePlan[idx]
    itemsPayload.push({
      product_id: resolved?.matchedId ? resolved.matchedId : null,
      item_name: line.item,
      hsn_sac: line.hsn || stock?.hsn || '',
      quantity: Math.abs(line.qty),
      unit: line.unit || stock?.unit || 'NOS',
      rate: line.rate,
      discount_percent: line.discountPercent,
      discount_amount: result.discount_amount,
      taxable_value: result.taxable_value,
      gst_rate,
      cgst_rate: result.cgst_rate,
      sgst_rate: result.sgst_rate,
      igst_rate: result.igst_rate,
      cgst_amount: result.cgst_amount,
      sgst_amount: result.sgst_amount,
      igst_amount: result.igst_amount,
      cess_rate,
      cess_amount: result.cess_amount,
      total_amount: result.total_amount,
      ...(isSale ? {} : { itc_eligible: true }),
    })
    if (Math.abs(result.taxable_value - line.taxable) > 0.05) {
      flags.push(`Line ${idx + 1} (${line.item}): the file’s assessable value is ₹${line.taxable.toLocaleString('en-IN')} and these quantity and rate figures come to ₹${result.taxable_value.toLocaleString('en-IN')} — the quantity and rate win, because that is what was billed`)
    }
  })

  if (amountDiscounts) {
    derived.push(`${amountDiscounts} line${amountDiscounts === 1 ? '' : 's'} state${amountDiscounts === 1 ? 's' : ''} a discount in rupees; it is carried as the percent of that line the rupees work out to, because a tax invoice restates one number, not two`)
  }
  if (cessCameFromLedger) {
    derived.push(`The cess rate comes from this voucher’s cess ledger (${fileCessRate}%), because the stock item states none`)
  }
  if (v.tax.cess > 0 && computed.every(c => c.cess_amount === 0)) {
    reasons.push(`₹${v.tax.cess.toLocaleString('en-IN')} of cess sits in the file’s ledgers and no line states a cess rate — the invoice would drop it, which is not an import`)
  }

  const totals = calculateInvoiceTotals(computed)

  if (v.statedTotal !== null && Math.abs(v.statedTotal - totals.grand_total) > 1) {
    flags.push(`The voucher prints a total of ₹${Math.abs(v.statedTotal).toLocaleString('en-IN')}; these lines come to ₹${totals.grand_total.toLocaleString('en-IN')}. The lines win — a printed total is a summary of them, not a price of its own.`)
  }

  // The supply's shape: what the file's tax split proves, checked against the states.
  const supplyType = gstinOfParty && gstinOfParty.length === 15 ? 'b2b' : 'b2c'
  if (placeOfSupply && org.stateCode) {
    const fromStates = determineGSTType(org.stateCode, placeOfSupply, supplyType)
    if (fromStates !== rates.gstType && taxableFromLines > 0 && (v.tax.cgst + v.tax.sgst + v.tax.igst) > 0) {
      flags.push(
        fromStates === 'igst'
          ? `The file split the tax into CGST and SGST, but ${org.stateCode} → ${placeOfSupply} is an inter-state supply. The tax is carried as the file charged it; check which is right before this reaches a return.`
          : `The file charged IGST, but ${org.stateCode} → ${placeOfSupply} reads as a same-state supply. The tax is carried as the file charged it; check which is right before this reaches a return.`,
      )
    }
  }

  const tallyNote = `Tally ${tallyRef || 'voucher'}${v.reference ? ` · ref ${v.reference}` : ''}`
  const existingDocs = isSale ? existing.invoices || [] : existing.bills || []
  const already = existingDocs.find(d => (d.notes || '').toLowerCase().includes(tallyNote.toLowerCase()))
  if (already) reasons.push(`A document with this Tally reference is already in the register (${already.number || already.id}) — importing again would raise a second one`)
  const lookalike = existingDocs.find(d =>
    d.date === v.date &&
    Math.abs((d.grand_total ?? -1) - totals.grand_total) < 0.01 &&
    normTagName(d.party_name || '') === normTagName(v.party))
  if (lookalike && !already) flags.push(`The register already holds ${lookalike.number || lookalike.id} for the same party, date and total — importing adds a second document, not a correction`)

  const fields: Record<string, unknown> = isSale
    ? {
      invoice_type: 'tax_invoice',
      invoice_date: v.date,
      due_date: null,
      customer_id: matched || null,
      customer_name: v.party,
      customer_gstin: gstinOfParty,
      customer_address: (party?.fields.address_line1 as string) || '',
      customer_state: stateNameFromCode(placeOfSupply),
      customer_state_code: placeOfSupply,
      place_of_supply: placeOfSupply,
      place_of_supply_name: stateNameFromCode(placeOfSupply),
      supply_type: supplyType,
      is_reverse_charge: v.reverseCharge,
      ...totals,
      amount_paid: 0,
      balance_due: totals.grand_total,
      payment_status: 'unpaid',
      notes: tallyNote,
      terms: '',
      status: 'sent',
    }
    : {
      bill_number: v.reference || v.number || `${v.party} ${v.date}`,
      bill_date: v.date,
      due_date: null,
      vendor_id: matched || null,
      vendor_name: v.party,
      vendor_gstin: gstinOfParty,
      vendor_state_code: placeOfSupply,
      place_of_supply: placeOfSupply,
      place_of_supply_name: stateNameFromCode(placeOfSupply),
      is_reverse_charge: v.reverseCharge,
      ...totals,
      itc_eligible: true,
      amount_paid: 0,
      balance_due: totals.grand_total,
      payment_status: 'unpaid',
      notes: tallyNote,
      status: 'active',
    }

  if (!v.reference && !v.number) derived.push('The file gives neither a voucher number nor a reference for the bill number — the party and date stand in for it')
  else if (isSale) derived.push('Our own invoice number comes from this app’s sequence; the Tally one travels in the notes')
  else derived.push(`The bill is numbered from ${v.reference ? 'the vendor’s own bill number on the voucher' : 'the Tally voucher number'}`)

  if (v.moneyLedgers.length) {
    const received = round2(v.moneyLedgers.reduce((s, m) => s + m.amount, 0))
    if (received > 0) flags.push(`${isSale ? '₹' + received.toLocaleString('en-IN') + ' was received' : '₹' + received.toLocaleString('en-IN') + ' was paid'} against this voucher in Tally (${v.moneyLedgers.map(m => m.ledger).join(', ')}). Money is recorded on /payments, and an import does not write it — the document lands as unpaid.`)
  }

  if (!reasons.length) derived.push(`The document ${isSale ? 'will be raised' : 'will be booked'} at ₹${totals.grand_total.toLocaleString('en-IN')} from ${v.lines.length} line${v.lines.length === 1 ? '' : 's'}`)

  const partyLine = v.party || 'no party'
  return {
    key: planKey(target, `${partyLine}|${v.date}|${v.number}|${v.sourceIndex}`),
    target,
    status: already ? 'already' : reasons.length ? 'blocked' : 'ready',
    title: isSale ? `${v.party || 'Unnamed party'} · ${totals.grand_total.toLocaleString('en-IN')}` : `${v.party || 'Unnamed vendor'} · ${totals.grand_total.toLocaleString('en-IN')}`,
    subtitle: `${v.voucherType || (isSale ? 'Sales' : 'Purchase')}${v.number ? ` #${v.number}` : ''} · ${v.date || 'no date'} · ${v.lines.length} line${v.lines.length === 1 ? '' : 's'}`,
    fields,
    lines: itemsPayload,
    reasons,
    derived,
    flags,
    requires,
    matchedId: already?.id || '',
    tallyRef: tallyRef,
    rupees: totals.grand_total,
    sourceIndex: v.sourceIndex,
  }
}

/** A voucher that is not a sale or a purchase is shown, named, and left alone. */
function skippedDocumentItem(v: TallyVoucher): PlanItem {
  const type = v.voucherType || 'unnamed'
  const amount = v.statedTotal !== null ? Math.abs(v.statedTotal) : round2(v.entries.reduce((s, e) => s + (e.kind === 'party' || e.kind === 'money' ? 0 : e.absolute), 0))
  let reason = `A “${type}” voucher is not a sale or a purchase. v1 imports those two documents; this one stays in Tally.`
  if (/receipt|payment/i.test(type)) reason = `A “${type}” voucher is money ${/receipt/i.test(type) ? 'in' : 'out'} of ₹${amount.toLocaleString('en-IN')}. Payments are the only writer of money here, and an import does not make one — record it on /payments.`
  else if (/credit note|debit note/i.test(type)) reason = `A “${type}” voucher reverses ₹${amount.toLocaleString('en-IN')} against an earlier document. Credit and debit notes are raised on their own pages against the invoice they belong to, which an import cannot point at.`
  else if (/journal/i.test(type)) reason = `A “${type}” voucher moves amounts between ledgers, not goods or services to a party — there is no invoice underneath it.`
  else if (/delivery|challan/i.test(type)) reason = `A “${type}” voucher moves stock without a sale. Delivery challans are raised on /challans.`
  else if (/sales order|purchase order/i.test(type)) reason = `A “${type}” voucher is an order, not a document. Orders live on the order registers until they are billed.`
  return {
    key: planKey('other', `voucher|${v.sourceIndex}`),
    target: 'other',
    status: 'skipped',
    title: `${type}${v.number ? ` #${v.number}` : ''}`,
    subtitle: `${v.party ? `for ${v.party} · ` : ''}${v.date || 'no date'}${amount ? ` · ₹${amount.toLocaleString('en-IN')}` : ''}`,
    fields: {},
    lines: [],
    reasons: [reason],
    derived: [],
    flags: [],
    requires: [],
    matchedId: '',
    tallyRef: `${type} ${v.number}`.trim(),
    rupees: amount,
    sourceIndex: v.sourceIndex,
  }
}

/** A ledger that is not a counterparty: the shop's own books, not somebody's account. */
function nonPartyItem(ledger: TallyLedger): PlanItem {
  const group = ledger.group || 'no group'
  const reason = ledger.group
    ? `${ledger.roleHow}. It is money, tax, or the value of goods — real in Tally, and not a party this app can import as a customer or a vendor`
    : 'No group on the ledger. A customer and a supplier look identical until the group says which, so this reads as neither'
  const flags: string[] = []
  if (ledger.gstin && ledger.group) flags.push(`It carries a GSTIN, which a ${group.toLowerCase()} normally would not — if this is really a counterparty, give it the group Sundry Debtors or Sundry Creditors in Tally and export again`)
  if (!ledger.group) flags.push('Set the group in Tally (Export → Masters → Ledger) and this row becomes a customer or a vendor on the next read')
  return {
    key: planKey('other', `ledger:${ledger.name}`),
    target: 'other',
    status: 'skipped',
    title: ledger.name,
    subtitle: `Tally group: ${group}${ledger.gstin ? ` · GSTIN ${ledger.gstin}` : ''}`,
    fields: {},
    lines: [],
    reasons: [reason],
    derived: ledger.opening ? [`Opening balance in Tally: ₹${Math.abs(ledger.opening).toLocaleString('en-IN')} ${ledger.opening < 0 ? 'on the debit side' : 'on the credit side'}`] : [],
    flags,
    requires: [],
    matchedId: '',
    tallyRef: ledger.name,
    rupees: Math.abs(ledger.opening),
    sourceIndex: ledger.sourceIndex,
  }
}

function skippedRawItem(s: SkippedObject, index: number): PlanItem {
  return {
    key: planKey('other', `${s.tag}:${s.name}:${index}`),
    target: 'other',
    status: 'skipped',
    title: s.name || `An unnamed ${s.tag.toLowerCase()}`,
    subtitle: `Tally object: ${s.tag}`,
    fields: {},
    lines: [],
    reasons: [s.reason],
    derived: [],
    flags: [],
    requires: [],
    matchedId: '',
    tallyRef: s.name,
    rupees: 0,
    sourceIndex: 0,
  }
}

const TARGET_ORDER: Record<PlanTarget, number> = {
  product: 0,
  customer: 1,
  vendor: 2,
  invoice: 3,
  purchase_bill: 4,
  other: 5,
}

/**
 * The file, mapped. Masters are read before documents on purpose: a voucher in the
 * same export as its party can depend on a customer the file also introduces, and the
 * page writes in the order this returns.
 */
export function buildPlan(dump: TallyDump, existing: Existing = {}, org: OrgIdentity = { stateCode: '' }): ImportPlan {
  const items: PlanItem[] = []
  const stockIndex = new Map<string, TallyStockItem>()
  for (const item of dump.stockItems) stockIndex.set(normTagName(item.name), item)

  const parties = new Map<string, PlanItem>()
  const products = new Map<string, PlanItem>()

  for (const ledger of dump.ledgers) {
    if (ledger.role === 'other') {
      items.push(nonPartyItem(ledger))
      continue
    }
    const target: PlanTarget = ledger.role === 'customer' ? 'customer' : 'vendor'
    const item = partyItem(
      ledger,
      target,
      target === 'customer' ? existing.customers || [] : existing.vendors || [],
    )
    parties.set(item.key, item)
    items.push(item)
  }

  for (const stockItem of dump.stockItems) {
    const item = productItem(stockItem, existing.products || [])
    products.set(item.key, item)
    items.push(item)
  }

  for (const v of dump.vouchers) {
    if (v.kind === 'other') {
      items.push(skippedDocumentItem(v))
      continue
    }
    items.push(documentItem(v, org, parties, products, stockIndex, existing))
  }

  dump.skipped.forEach((s, index) => items.push(skippedRawItem(s, index)))

  items.sort((a, b) => TARGET_ORDER[a.target] - TARGET_ORDER[b.target] || a.sourceIndex - b.sourceIndex)

  const dated = items.filter(i => (i.target === 'invoice' || i.target === 'purchase_bill') && typeof i.fields.invoice_date === 'string' && i.fields.invoice_date)
  const billDated = items.filter(i => i.target === 'purchase_bill' && typeof i.fields.bill_date === 'string' && i.fields.bill_date)
  const dates = [...dated.map(i => i.fields.invoice_date as string), ...billDated.map(i => i.fields.bill_date as string)].sort()

  const byTarget = {} as Record<PlanTarget, { count: number; rupees: number }>
  for (const target of Object.keys(TARGET_ORDER) as PlanTarget[]) byTarget[target] = { count: 0, rupees: 0 }

  let ready = 0
  let blocked = 0
  let skipped = 0
  let already = 0
  let attention = 0
  for (const item of items) {
    if (item.status === 'ready') {
      ready++
      byTarget[item.target].count++
      byTarget[item.target].rupees = round2(byTarget[item.target].rupees + item.rupees)
    } else if (item.status === 'blocked') blocked++
    else if (item.status === 'already') already++
    else skipped++
    if (item.flags.length) attention++
  }

  return {
    items,
    summary: {
      objects: dump.ledgers.length + dump.stockItems.length + dump.vouchers.length + dump.skipped.length,
      ledgers: dump.ledgers.length,
      stockItems: dump.stockItems.length,
      vouchers: dump.vouchers.length,
      ready,
      blocked,
      skipped,
      already,
      attention,
      from: dates[0] || '',
      to: dates[dates.length - 1] || '',
      byTarget,
    },
  }
}

/**
 * Selecting a document pulls in the masters it needs, because a bill for a vendor
 * that is not on the register is not a bill. Only `ready` rows are pulled — the
 * dependency is stated, never silently invented at write time.
 */
export function expandSelection(plan: ImportPlan, keys: Iterable<string>): Set<string> {
  const byKey = new Map(plan.items.map(i => [i.key, i]))
  const out = new Set<string>()
  const add = (key: string): void => {
    if (out.has(key)) return
    const item = byKey.get(key)
    if (!item) return
    out.add(key)
    if (item.status !== 'blocked' && item.status !== 'ready') return
    for (const req of item.requires) {
      const dep = byKey.get(req.key)
      if (dep && dep.status === 'ready') add(dep.key)
    }
  }
  for (const key of keys) add(key)
  return out
}

/** The order rows are written in: masters before the documents that name them. */
export function writeOrder(plan: ImportPlan, keys: Set<string>): PlanItem[] {
  return plan.items.filter(i => keys.has(i.key) && i.status === 'ready')
}

export const PLAN_CSV_HEADERS = [
  'Tally object', 'Becomes', 'Status', 'Name', 'Detail', 'Rupees',
  'Why not', 'How it was worked out', 'Look at this', 'Needs first',
]

export function planCsvRows(plan: ImportPlan): (string | number)[][] {
  return plan.items.map(item => [
    item.tallyRef,
    TARGET_LABEL[item.target],
    STATUS_LABEL[item.status],
    item.title,
    item.subtitle,
    item.rupees,
    item.reasons.join(' · '),
    item.derived.join(' · '),
    item.flags.join(' · '),
    item.requires.map(r => r.what).join(' · '),
  ])
}

// ── the other direction: our books, as Tally import XML ───────────────────────
//
// Tally's import format is a list of objects with `Action`, each carrying the fields
// Tally's own screens carry. This writes exactly that, from rows this app already
// holds: a customer becomes a ledger under Sundry Debtors, a product becomes a stock
// item, an invoice becomes a Sales voucher whose inventory lines add up to the taxable
// value and whose tax ledgers are the split the invoice actually charged.
//
// Two rules keep the round trip honest:
//  * **Nothing is written that the row does not hold.** No HSN is invented for a
//    product that has none, no standard rate is assumed, no state is guessed — the tag
//    is left out and Tally asks the accountant, which is what it would do with any
//    import.
//  * **The tax split follows the lines, and the document's own totals check it.**
//    Per-rate ledgers (`Output CGST @9%`, `@3%`) are how Tally files tax, so they are
//    how this writes it; if their sum is more than a rupee away from the invoice's
//    `cgst_amount`, that disagreement travels in a comment at the top of the file
//    rather than being smoothed away.

export type TallyAction = 'Create' | 'Alter'

export function escapeXml(s: string | number | null | undefined): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** A rupee amount in the form Tally reads: two decimals, no separators, no symbol. */
function tallyAmount(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  return (Number.isFinite(v) ? v : 0).toFixed(2)
}

function tag(name: string, value: string | number | null | undefined, indent = '    '): string {
  const text = String(value ?? '')
  if (!text.trim()) return ''
  return `${indent}<${name}>${escapeXml(text)}</${name}>`
}

export interface TallyLedgerSeed {
  name: string
  /** Tally group: Sundry Debtors, Sundry Creditors, Indirect Taxes, Duties & Taxes… */
  group: string
  gstin?: string
  stateName?: string
  pan?: string
  phone?: string
  email?: string
  address?: string
  /** Signed the way this library reads Tally: a debit balance (money owed to us) is negative. */
  opening?: number
}

export function tallyLedgerXml(seed: TallyLedgerSeed, action: TallyAction = 'Create'): string {
  const opening = seed.opening ?? 0
  const body = [
    tag('NAME', seed.name, '      '),
    tag('PARENT', seed.group, '      '),
    seed.gstin ? tag('GSTIN', seed.gstin, '      ') : '',
    seed.pan ? tag('PAN', seed.pan, '      ') : '',
    seed.stateName ? tag('STATENAME', seed.stateName, '      ') : '',
    seed.address ? tag('ADDRESS', seed.address.split('\n')[0], '      ') : '',
    seed.phone ? tag('PHONE', seed.phone, '      ') : '',
    seed.email ? tag('EMAIL', seed.email, '      ') : '',
    // Tally's own opening-balance shape: the amount, then which side it sits on.
    opening !== 0 ? `      <OPENINGDR>\n        <NAME>${opening < 0 ? 'Dr' : 'Cr'}</NAME>\n        <AMOUNT>${escapeXml(tallyAmount(Math.abs(opening)))}</AMOUNT>\n      </OPENINGDR>` : '',
  ].filter(Boolean).join('\n')
  return `    <LEDGER Action="${action}">\n${body}\n    </LEDGER>`
}

export interface TallyStockSeed {
  name: string
  unit?: string
  hsn?: string
  gstRate?: number | null
  cessRate?: number | null
  selling?: number | null
  purchase?: number | null
  openingQty?: number
  /** 'goods' or 'service' — Tally's own split, and a service unit is not a countable one. */
  itemType?: 'goods' | 'service'
}

export function tallyStockItemXml(seed: TallyStockSeed, action: TallyAction = 'Create'): string {
  const body = [
    tag('NAME', seed.name, '      '),
    tag('BASEUNITS', seed.unit || (seed.itemType === 'service' ? 'Service' : 'NOS'), '      '),
    // The HSN/SAC and GST-rate tags are written exactly as a Tally *export* names them,
    // so a file that leaves here can come back here. A build that ignores a tag loses
    // only the rate — the vouchers still carry the amounts.
    seed.hsn ? tag('HSN_CODEunderGSTN_UG', seed.hsn, '      ') : '',
    seed.itemType === 'service' ? tag('GSTApplicable', 'Applicable', '      ') : '',
    seed.gstRate != null && seed.gstRate > 0 ? tag('SetRateofGST', String(seed.gstRate), '      ') : '',
    seed.cessRate != null && seed.cessRate > 0 ? tag('SetRateofCess', String(seed.cessRate), '      ') : '',
    seed.purchase != null ? tag('STDPURCHRATE', tallyAmount(seed.purchase), '      ') : '',
    seed.selling != null ? tag('STDSALESRATE', tallyAmount(seed.selling), '      ') : '',
    seed.openingQty ? tag('OPENINGBALQTY', tallyAmount(seed.openingQty), '      ') : '',
  ].filter(Boolean).join('\n')
  return `    <STOCKITEM Action="${action}">\n${body}\n    </STOCKITEM>`
}

/** `Output CGST @9%` for a sale, `Input IGST @18%` for a bill — Tally's naming for tax. */
export function taxLedgerName(kind: 'output' | 'input', family: TaxFamily, rate: number): string {
  const side = kind === 'output' ? 'Output' : 'Input'
  const label = family === 'cgst' ? 'CGST' : family === 'sgst' ? 'SGST' : family === 'igst' ? 'IGST' : 'Cess'
  const half = family === 'cgst' || family === 'sgst' ? rate / 2 : rate
  // A rate name is a label, not a measurement: `@0.125%` says what the slab is, while
  // the two decimals a currency would use (`0.13`) quietly renames the ledger.
  const text = String(Math.round(half * 10000) / 10000)
  return `${side} ${label} @${text}%`
}

export interface TallyVoucherLine {
  item: string
  qty: number
  rate: number
  /** The assessable value; qty × rate is used when it is absent. */
  taxable?: number
  gstRate?: number
  cessRate?: number
  unit?: string
  hsn?: string
}

export interface TallyVoucherSeed {
  type: 'Sales' | 'Purchase'
  /** ISO yyyy-mm-dd; converted to Tally's 8-digit form here. */
  date: string
  number: string
  party: string
  reference?: string
  lines: TallyVoucherLine[]
  /** Which ledgers the tax goes to: a same-state supply splits, an inter-state one does not. */
  taxSplit?: 'intra' | 'inter'
  roundOff?: number
}

/**
 * One voucher, in Tally's Invoice-mode shape: inventory lines first, then the tax
 * ledgers by rate, then the party line that balances it.
 *
 * A sale and a purchase are the same arithmetic seen from opposite sides, and Tally
 * files them that way: a sale *credits* its goods and its output tax and *debits* the
 * customer; a purchase *debits* its goods and its input tax and *credits* the supplier.
 * `deem` is the flag each side asks for and `signed` puts the rupees on that side, so a
 * file written here is a file Tally reads as the voucher type it names — and a file this
 * reader takes back as the same document.
 */
export function tallyVoucherXml(seed: TallyVoucherSeed, action: TallyAction = 'Create'): string {
  const kind = seed.type === 'Sales' ? 'output' : 'input'
  const isPurchase = kind === 'input'
  const deem = isPurchase ? 'Yes' : 'No'
  /** The goods-and-tax side of this voucher type: a credit for a sale, a debit for a bill. */
  const signed = (n: number): string => tallyAmount(isPurchase ? -Math.abs(n) : Math.abs(n))
  const split = seed.taxSplit === 'inter' ? 'inter' : 'intra'
  const date = toTallyDate(seed.date)
  const head = [
    date ? `      <DATE>${date}</DATE>` : '',
    tag('VOUCHERTYPENAME', seed.type, '      '),
    tag('VOUCHERNUMBER', seed.number, '      '),
    tag('PARTYLEDGERNAME', seed.party, '      '),
    seed.reference ? tag('REFERENCE', seed.reference, '      ') : '',
    date ? `      <EFFECTIVEDATE>${date}</EFFECTIVEDATE>` : '',
  ].filter(Boolean).join('\n')

  let taxableTotal = 0
  // Tax is filed per slab in Tally (`Output CGST @9%`, `@3%`), so the base is accumulated
  // by rate, and each rate's ledgers are written from that base.
  const basesByRate = new Map<number, number>()
  const cessByRate = new Map<number, number>()
  const lineBlocks = seed.lines.map(line => {
    const taxable = round2(line.taxable ?? line.qty * line.rate)
    taxableTotal = round2(taxableTotal + taxable)
    const rate = line.gstRate ?? 0
    const cess = line.cessRate ?? 0
    if (rate > 0) basesByRate.set(rate, round2((basesByRate.get(rate) || 0) + taxable))
    if (cess > 0) cessByRate.set(cess, round2((cessByRate.get(cess) || 0) + taxable))
    const body = [
      tag('STOCKITEMNAME', line.item, '        '),
      `        <ISDEEMEDPOSITIVE>${deem}</ISDEEMEDPOSITIVE>`,
      tag('ACTUALQTY', tallyAmount(line.qty), '        '),
      tag('BILLEDQTY', tallyAmount(line.qty), '        '),
      tag('RATE', tallyAmount(line.rate), '        '),
      tag('AMOUNT', signed(taxable), '        '),
      // The line repeats the HSN and the unit the master would carry, so a file built
      // with `includeMasters: false` still says what was billed and under which code.
      tag('HSN_CODEunderGSTN_UG', line.hsn, '        '),
      tag('UNIT', line.unit, '        '),
    ].join('\n')
    return `      <ALLINVENTORYENTRIES.LIST>\n${body}\n      </ALLINVENTORYENTRIES.LIST>`
  })

  const entryBlocks: string[] = []
  let taxTotal = 0
  const addTaxEntry = (family: TaxFamily, rate: number, base: number): void => {
    const half = family === 'cgst' || family === 'sgst' ? rate / 2 : rate
    const amount = round2(base * half / 100)
    if (amount <= 0) return
    taxTotal = round2(taxTotal + amount)
    entryBlocks.push([
      '      <ALLLEDGERENTRIES.LIST>',
      `        <LEDGERNAME>${escapeXml(taxLedgerName(kind, family, rate))}</LEDGERNAME>`,
      `        <ISDEEMEDPOSITIVE>${deem}</ISDEEMEDPOSITIVE>`,
      `        <AMOUNT>${signed(amount)}</AMOUNT>`,
      '      </ALLLEDGERENTRIES.LIST>',
    ].join('\n'))
  }
  for (const [rate, base] of basesByRate) {
    if (split === 'inter') addTaxEntry('igst', rate, base)
    else {
      addTaxEntry('cgst', rate, base)
      addTaxEntry('sgst', rate, base)
    }
  }
  for (const [rate, base] of cessByRate) addTaxEntry('cess', rate, base)

  const roundOff = round2(seed.roundOff ?? 0)
  // The party line is the voucher seen from the other side: the customer owes the whole
  // of it on a sale (a debit), the supplier is owed it on a bill (a credit).
  const balancing = round2(taxableTotal + taxTotal + roundOff)
  entryBlocks.push([
    '      <ALLLEDGERENTRIES.LIST>',
    `        <LEDGERNAME>${escapeXml(seed.party)}</LEDGERNAME>`,
    `        <ISDEEMEDPOSITIVE>${isPurchase ? 'No' : 'Yes'}</ISDEEMEDPOSITIVE>`,
    '        <ISPARTYLEDGER>Yes</ISPARTYLEDGER>',
    `        <AMOUNT>${tallyAmount(isPurchase ? balancing : -balancing)}</AMOUNT>`,
    '      </ALLLEDGERENTRIES.LIST>',
  ].join('\n'))
  if (roundOff !== 0) {
    entryBlocks.push([
      '      <ALLLEDGERENTRIES.LIST>',
      '        <LEDGERNAME>Round Off</LEDGERNAME>',
      `        <ISDEEMEDPOSITIVE>${deem}</ISDEEMEDPOSITIVE>`,
      `        <AMOUNT>${signed(roundOff)}</AMOUNT>`,
      '      </ALLLEDGERENTRIES.LIST>',
    ].join('\n'))
  }

  return [
    `    <VOUCHER Action="${action}">`,
    head,
    ...lineBlocks,
    ...entryBlocks,
    '    </VOUCHER>',
  ].join('\n')
}

export function tallyEnvelope(body: string[], company?: string): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Import Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <DATA>',
    '    <IMPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>Vouchers</REPORTNAME>',
  ]
  if (company) lines.push(`        <STATICVARIABLES><SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY></STATICVARIABLES>`)
  lines.push(
    '      </REQUESTDESC>',
    '      <REQUESTDATA>',
    '        <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    ...body,
    '        </TALLYMESSAGE>',
    '      </REQUESTDATA>',
    '    </IMPORTDATA>',
    '  </DATA>',
    '</ENVELOPE>',
    '',
  )
  return lines.join('\n')
}

export interface ExportParty {
  name: string
  gstin?: string | null
  state_name?: string | null
  state_code?: string | null
  phone?: string | null
  email?: string | null
  address?: string | null
}

export interface ExportItemRow {
  item_name: string
  hsn_sac?: string | null
  quantity: number
  unit?: string | null
  rate: number
  taxable_value?: number | null
  gst_rate?: number | null
  cess_rate?: number | null
}

export interface ExportDocument {
  /** Our number — the one from `invoice_sequences`. Tally receives it as the voucher number. */
  number: string
  date: string
  party?: ExportParty | null
  /** The other book's number, if there is one: a vendor's bill number, or a Tally reference. */
  reference?: string | null
  taxable_amount?: number | null
  cgst_amount?: number | null
  sgst_amount?: number | null
  igst_amount?: number | null
  cess_amount?: number | null
  round_off?: number | null
  grand_total?: number | null
  items: ExportItemRow[]
}

export interface ExportProduct {
  name: string
  unit?: string | null
  hsn_sac?: string | null
  gst_rate?: number | null
  cess_rate?: number | null
  selling_price?: number | null
  purchase_price?: number | null
  opening_stock?: number | null
  type?: 'goods' | 'service'
}

export interface ExportData {
  customers?: ExportParty[]
  vendors?: ExportParty[]
  products?: ExportProduct[]
  invoices?: ExportDocument[]
  bills?: ExportDocument[]
}

export interface ExportOptions {
  /** The company name Tally is open on; Tally refuses an import without it. */
  company?: string
  /** `Create` adds; `Alter` updates what is already there. Nothing else is claimed. */
  action?: TallyAction
  /** Masters are written by default so the vouchers find their ledgers. */
  includeMasters?: boolean
}

function partySeed(party: ExportParty | null | undefined, group: string): TallyLedgerSeed | null {
  const name = (party?.name || '').trim()
  if (!name) return null
  return {
    name,
    group,
    gstin: party?.gstin || undefined,
    stateName: party?.state_name || undefined,
    phone: party?.phone || undefined,
    email: party?.email || undefined,
    address: party?.address || undefined,
  }
}

/** The rupees the writer is about to hand over, counted before the file is made. */
export function exportSummary(data: ExportData): {
  ledgers: number
  stockItems: number
  vouchers: number
  rupees: number
} {
  const parties = new Set<string>()
  for (const p of data.customers || []) if (p.name.trim()) parties.add(`d:${normTagName(p.name)}`)
  for (const p of data.vendors || []) if (p.name.trim()) parties.add(`c:${normTagName(p.name)}`)
  for (const d of data.invoices || []) if (d.party?.name?.trim()) parties.add(`d:${normTagName(d.party.name)}`)
  for (const d of data.bills || []) if (d.party?.name?.trim()) parties.add(`c:${normTagName(d.party.name)}`)

  const items = new Set<string>()
  for (const p of data.products || []) if (p.name.trim()) items.add(normTagName(p.name))
  for (const d of [...(data.invoices || []), ...(data.bills || [])]) {
    for (const line of d.items) if (line.item_name.trim()) items.add(normTagName(line.item_name))
  }

  const vouchers = (data.invoices || []).length + (data.bills || []).length
  const rupees = round2(
    [...(data.invoices || []), ...(data.bills || [])]
      .reduce((s, d) => s + tallyNumber(String(d.grand_total ?? 0)), 0),
  )
  return { ledgers: parties.size, stockItems: items.size, vouchers, rupees }
}

/**
 * Our rows, as a file TallyPrime accepts. The tax ledger names are generated from the
 * rates the documents carry, and those ledgers are written too — a voucher naming
 * `Output IGST @18%` into a company that has no such ledger is the classic failed import.
 */
export function exportTallyXml(data: ExportData, opts: ExportOptions = {}): string {
  const action = opts.action || 'Create'
  const includeMasters = opts.includeMasters !== false
  const body: string[] = []
  const notes: string[] = []

  const ledgerSeen = new Set<string>()
  const addLedger = (seed: TallyLedgerSeed | null): void => {
    if (!seed) return
    const key = `${seed.group}|${normTagName(seed.name)}`
    if (ledgerSeen.has(key)) return
    ledgerSeen.add(key)
    body.push(tallyLedgerXml(seed, action))
  }

  const itemSeen = new Set<string>()
  const addItem = (seed: TallyStockSeed | null): void => {
    if (!seed || !seed.name.trim()) return
    const key = normTagName(seed.name)
    if (itemSeen.has(key)) return
    itemSeen.add(key)
    body.push(tallyStockItemXml(seed, action))
  }

  if (includeMasters) {
    for (const p of data.customers || []) addLedger(partySeed(p, 'Sundry Debtors'))
    for (const p of data.vendors || []) addLedger(partySeed(p, 'Sundry Creditors'))
    for (const p of data.products || []) {
      addItem({
        name: p.name,
        unit: p.unit || undefined,
        hsn: p.hsn_sac || undefined,
        gstRate: p.gst_rate ?? null,
        cessRate: p.cess_rate ?? null,
        selling: p.selling_price ?? null,
        purchase: p.purchase_price ?? null,
        openingQty: p.opening_stock ?? 0,
        itemType: p.type,
      })
    }
  }

  const taxLedgers = new Set<string>()
  const addTaxLedger = (name: string): void => {
    // `includeMasters: false` means the accountant says Tally already has its ledgers —
    // so the file writes vouchers only, tax ones included.
    if (!includeMasters) return
    if (taxLedgers.has(name)) return
    taxLedgers.add(name)
    body.push(tallyLedgerXml({ name, group: 'Indirect Taxes' }, action))
  }

  const voucherDocs: { doc: ExportDocument; type: 'Sales' | 'Purchase' }[] = [
    ...(data.invoices || []).map(doc => ({ doc, type: 'Sales' as const })),
    ...(data.bills || []).map(doc => ({ doc, type: 'Purchase' as const })),
  ]

  for (const { doc, type } of voucherDocs) {
    if (includeMasters) addLedger(partySeed(doc.party || null, type === 'Sales' ? 'Sundry Debtors' : 'Sundry Creditors'))
    const lines: TallyVoucherLine[] = doc.items.map(line => {
      if (includeMasters) {
        addItem({
          name: line.item_name,
          unit: line.unit || undefined,
          hsn: line.hsn_sac || undefined,
          gstRate: line.gst_rate ?? null,
        })
      }
      return {
        item: line.item_name,
        qty: Math.abs(line.quantity || 0),
        rate: Math.abs(line.rate || 0),
        taxable: line.taxable_value ?? undefined,
        gstRate: line.gst_rate ?? 0,
        cessRate: line.cess_rate ?? 0,
        unit: line.unit || undefined,
        hsn: line.hsn_sac || undefined,
      }
    })

    // Tax ledger names for every rate this voucher carries, on the side it charged.
    const kind = type === 'Sales' ? 'output' : 'input'
    const rates = new Set<number>()
    for (const line of lines) if ((line.gstRate ?? 0) > 0) rates.add(line.gstRate as number)
    const igstOnly = round2(doc.igst_amount ?? 0) > 0 && round2((doc.cgst_amount ?? 0) + (doc.sgst_amount ?? 0)) === 0
    for (const rate of rates) {
      if (igstOnly) addTaxLedger(taxLedgerName(kind, 'igst', rate))
      else if (rate > 0) {
        addTaxLedger(taxLedgerName(kind, 'cgst', rate))
        addTaxLedger(taxLedgerName(kind, 'sgst', rate))
      }
    }
    const cessRates = new Set<number>()
    for (const line of lines) if ((line.cessRate ?? 0) > 0) cessRates.add(line.cessRate as number)
    for (const rate of cessRates) addTaxLedger(taxLedgerName(kind, 'cess', rate))
    if (includeMasters && round2(doc.round_off ?? 0) !== 0) addLedger({ name: 'Round Off', group: 'Indirect Taxes' })

    const taxableFromLines = round2(lines.reduce((s, l) => s + (l.taxable ?? round2(l.qty * l.rate)), 0))
    const statedTaxable = round2(doc.taxable_amount ?? 0)
    if (statedTaxable && Math.abs(statedTaxable - taxableFromLines) > 1) {
      notes.push(`${type} ${doc.number}: the document’s taxable total is ₹${statedTaxable.toLocaleString('en-IN')} and its lines come to ₹${taxableFromLines.toLocaleString('en-IN')}; the lines are what Tally will receive.`)
    }
    const docTax = round2((doc.cgst_amount ?? 0) + (doc.sgst_amount ?? 0) + (doc.igst_amount ?? 0))
    // Only the taxed base is compared: a document with an exempt line alongside a 12%
    // line would otherwise read as a tax disagreement it does not have.
    const taxedBase = round2(lines.filter(l => (l.gstRate ?? 0) > 0).reduce((s, l) => s + (l.taxable ?? round2(l.qty * l.rate)), 0))
    const linesTax = round2([...rates].reduce((s, rate) => s + taxedBase * rate / 100, 0))
    if (docTax && rates.size === 1 && Math.abs(docTax - linesTax) > 1) {
      notes.push(`${type} ${doc.number}: the document holds ₹${docTax.toLocaleString('en-IN')} of tax, and ${[...rates].map(r => `${r}%`).join(' + ')} on these lines comes to ₹${linesTax.toLocaleString('en-IN')}.`)
    }

    body.push(tallyVoucherXml({
      type,
      date: doc.date,
      number: doc.number,
      party: doc.party?.name || '',
      reference: doc.reference || undefined,
      lines,
      taxSplit: igstOnly ? 'inter' : 'intra',
      roundOff: doc.round_off ?? 0,
    }, action))
  }

  const header = notes.length
    ? `<!-- TaxFlow export for Tally\n${notes.map(n => `     - ${n.replace(/--/g, '- -')}`).join('\n')}\n  -->\n`
    : '<!-- TaxFlow export for Tally -->\n'
  return header + tallyEnvelope(body, opts.company)
}

/** A name for the download that says what is in it. */
export function tallyExportFileName(kind: 'invoices' | 'bills' | 'masters' | 'all', count: number, fy = ''): string {
  const stamp = fy ? `-${fy.replace('-', '')}` : ''
  return `taxflow-tally-${kind}${stamp}-${count}.xml`
}

// ── a file to try the bridge on ───────────────────────────────────────────────
//
// Not a fixture for tests (those have their own, sharper ones) but what the page
// offers when someone wants to see what a plan looks like before their own export
// is in hand. It is a real-shaped TallyPrime *Export Data* envelope with six objects
// and five vouchers, chosen so that one page visit shows all four row states:
// a ready sale, a ready inter-state bill, an invoice blocked on a stock item the
// file never describes, a ledger and a payment voucher that are correctly skipped,
// and a sale whose ₹5,000 receipt import must not write.

export const SAMPLE_TALLY_DUMP = `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
 <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
 <DATA>
  <TALLYMESSAGE xmlns:UDF="TallyUDF">
   <COMPANY>
    <NAME>Sample Co</NAME>
    <GSTIN>27AABCB1234F1Z5</GSTIN>
    <STATENAME>Maharashtra</STATENAME>
    <FYEARFROMTO>1-Apr-2025 to 31-Mar-2026</FYEARFROMTO>
   </COMPANY>
   <LEDGER>
    <NAME>Alpha Traders</NAME>
    <PARENT>Sundry Debtors</PARENT>
    <GSTIN>27AAACE1234F1ZP</GSTIN>
    <PAN>AAACE1234F</PAN>
    <STATENAME>Maharashtra</STATENAME>
    <ADDRESS>12 Marine Lines, Mumbai 400001</ADDRESS>
    <PHONE>9820012345</PHONE>
    <EMAIL>books@alphatraders.example</EMAIL>
    <OPENINGBALANCE>-14160.00</OPENINGBALANCE>
   </LEDGER>
   <LEDGER>
    <NAME>Beta Steels</NAME>
    <PARENT>Sundry Creditors</PARENT>
    <GSTIN>07AAACF9999A1Z5</GSTIN>
    <STATENAME>Delhi</STATENAME>
    <ADDRESS>Rohini Delhi 110085</ADDRESS>
   </LEDGER>
   <LEDGER>
    <NAME>Cash in Hand</NAME>
    <PARENT>Cash-in-Hand</PARENT>
   </LEDGER>
   <STOCKITEM>
    <NAME>Steel Flange 50mm</NAME>
    <BASEUNITS>NOS</BASEUNITS>
    <HSN_CODEunderGSTN_UG>73079900</HSN_CODEunderGSTN_UG>
    <STDSALESRATE>1200.00</STDSALESRATE>
    <STDPURCHRATE>900.00</STDPURCHRATE>
    <SetRateofGST>18.00%</SetRateofGST>
    <OPENINGBALANCEQTY>40.00</OPENINGBALANCEQTY>
   </STOCKITEM>
   <STOCKITEM>
    <NAME>Site Supervision</NAME>
    <BASEUNITS>Service</BASEUNITS>
    <UDF:HSN_Code_under_GSTN_UG>998314</UDF:HSN_Code_under_GSTN_UG>
    <SetRateofGST>18</SetRateofGST>
   </STOCKITEM>
   <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20250401</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>V-101</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Alpha Traders</PARTYLEDGERNAME>
    <REFERENCE>PO-118</REFERENCE>
    <TOTAL>14160.00</TOTAL>
    <ALLINVENTORYENTRIES.LIST>
     <STOCKITEMNAME>Steel Flange 50mm</STOCKITEMNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
     <ACTUALQTY>10.00</ACTUALQTY><BILLEDQTY>10.00</BILLEDQTY>
     <RATE>1200.00</RATE><AMOUNT>12000.00</AMOUNT>
     <HSN_CODEunderGSTN_UG>73079900</HSN_CODEunderGSTN_UG>
    </ALLINVENTORYENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output CGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1080.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output SGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1080.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Alpha Traders</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-14160.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Purchase (Inter-State)" ACTION="Create">
    <DATE>20250412</DATE>
    <VOUCHERTYPENAME>Purchase (Inter-State)</VOUCHERTYPENAME>
    <VOUCHERNUMBER>V-201</VOUCHERNUMBER>
    <REFERENCE>BS-3391</REFERENCE>
    <TOTAL>26550.00</TOTAL>
    <ALLINVENTORYENTRIES.LIST>
     <STOCKITEMNAME>Steel Flange 50mm</STOCKITEMNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
     <ACTUALQTY>25.00</ACTUALQTY><BILLEDQTY>25.00</BILLEDQTY>
     <RATE>900.00</RATE><AMOUNT>-22500.00</AMOUNT>
     <HSN_CODEunderGSTN_UG>73079900</HSN_CODEunderGSTN_UG>
    </ALLINVENTORYENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Input IGST @18%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-4050.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Beta Steels</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>26550.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20250418</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>V-102</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Alpha Traders</PARTYLEDGERNAME>
    <TOTAL>2832.00</TOTAL>
    <ALLINVENTORYENTRIES.LIST>
     <STOCKITEMNAME>Cement Bag 50kg</STOCKITEMNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
     <ACTUALQTY>6.00</ACTUALQTY><BILLEDQTY>6.00</BILLEDQTY>
     <RATE>400.00</RATE><AMOUNT>2400.00</AMOUNT>
    </ALLINVENTORYENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output CGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>216.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output SGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>216.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Alpha Traders</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-2832.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Sales" ACTION="Create">
    <DATE>20250420</DATE>
    <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
    <VOUCHERNUMBER>V-103</VOUCHERNUMBER>
    <PARTYLEDGERNAME>Alpha Traders</PARTYLEDGERNAME>
    <TOTAL>14160.00</TOTAL>
    <ALLINVENTORYENTRIES.LIST>
     <STOCKITEMNAME>Site Supervision</STOCKITEMNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
     <ACTUALQTY>8.00</ACTUALQTY><BILLEDQTY>8.00</BILLEDQTY>
     <RATE>1500.00</RATE><AMOUNT>12000.00</AMOUNT>
    </ALLINVENTORYENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output CGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1080.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Output SGST @9%</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>1080.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Cash in Hand</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-5000.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Alpha Traders</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes</ISPARTYLEDGER>
     <AMOUNT>-9160.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
   <VOUCHER VCHTYPE="Payment" ACTION="Create">
    <DATE>20250422</DATE>
    <VOUCHERTYPENAME>Payment</VOUCHERTYPENAME>
    <VOUCHERNUMBER>P-301</VOUCHERNUMBER>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Professional Fees</LEDGERNAME>
     <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>1500.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
    <ALLLEDGERENTRIES.LIST>
     <LEDGERNAME>Cash in Hand</LEDGERNAME>
     <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>-1500.00</AMOUNT>
    </ALLLEDGERENTRIES.LIST>
   </VOUCHER>
  </TALLYMESSAGE>
 </DATA>
</ENVELOPE>`

// ── what this browser has already imported ────────────────────────────────────
//
// The log is deliberately thin: which file, when, how many rows, and the note that
// says which documents carried a Tally reference. ADR-013 — this is owner bookkeeping
// about an import, so it lives in localStorage beside the batch and serial registers,
// and it is not a second copy of the books.

const KEY_TALLY_LOG = 'taxflow:tally:'

export interface TallyImportRecord {
  id: string
  at: string
  org_id: string
  file: string
  customers: number
  vendors: number
  products: number
  invoices: number
  bills: number
  skipped: number
  note: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function countOf(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0
}

function parseLog(raw: string | null): TallyImportRecord[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((v): TallyImportRecord | null => {
        if (!v || typeof v !== 'object') return null
        const o = v as Record<string, unknown>
        if (!str(o.id)) return null
        return {
          id: str(o.id),
          at: str(o.at),
          org_id: str(o.org_id),
          file: str(o.file),
          customers: countOf(o.customers),
          vendors: countOf(o.vendors),
          products: countOf(o.products),
          invoices: countOf(o.invoices),
          bills: countOf(o.bills),
          skipped: countOf(o.skipped),
          note: str(o.note),
        }
      })
      .filter((r): r is TallyImportRecord => r !== null)
  } catch {
    return []
  }
}

export function loadTallyImports(orgId: string): TallyImportRecord[] {
  if (typeof window === 'undefined' || !orgId) return []
  try {
    return parseLog(window.localStorage.getItem(KEY_TALLY_LOG + orgId))
  } catch {
    return []
  }
}

export function recordTallyImport(
  orgId: string,
  entry: Omit<TallyImportRecord, 'id' | 'at' | 'org_id'> & { id?: string; at?: string },
): TallyImportRecord[] {
  const record: TallyImportRecord = {
    id: entry.id || (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}`),
    at: entry.at || new Date().toISOString(),
    org_id: orgId,
    file: entry.file,
    customers: entry.customers,
    vendors: entry.vendors,
    products: entry.products,
    invoices: entry.invoices,
    bills: entry.bills,
    skipped: entry.skipped,
    note: entry.note,
  }
  const next = [record, ...loadTallyImports(orgId)].slice(0, 50)
  try {
    window.localStorage.setItem(KEY_TALLY_LOG + orgId, JSON.stringify(next))
  } catch {
    /* a full quota must not read as a failed import — the rows are already written */
  }
  return next
}

export function clearTallyImports(orgId: string): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    window.localStorage.removeItem(KEY_TALLY_LOG + orgId)
  } catch {
    /* nothing to clear */
  }
}
