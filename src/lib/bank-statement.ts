/* Bank statements in, receipts matched out — R2-10.
 *
 * A statement is pasted or dropped in and parsed here in the tab, then matched
 * against open documents and payments already recorded. Nothing is written to
 * the database: this is a workpaper that says what each bank line most likely
 * is, and the confirmed lines are recorded on the Payments page. */

import { invoiceNoCandidates } from './gstr2b'

export type Direction = 'credit' | 'debit'
export type Tier = 'exact' | 'likely' | 'possible'
export type DocKind = 'invoice' | 'bill' | 'payment'

/* ── statements ─────────────────────────────────────────────────────────── */

export interface StatementTxn {
  id: string
  date: string           // ISO yyyy-mm-dd, '' when the cell could not be read
  narration: string
  reference: string
  amount: number         // always positive; direction carries the sign
  direction: Direction
  balance: number | null
}

export interface ParseIssue { line: number; text: string; reason: string }

export interface ParseResult {
  txns: StatementTxn[]
  issues: ParseIssue[]
  delimiter: string
  columns: string[]
  /** Read from the rows themselves, not the preamble — banks disagree on headers. */
  from: string
  to: string
  closingBalance: number | null
}

const DELIMITERS = [',', '\t', ';', '|']
const MAX_ROWS = 4000

/** Quoted-cell aware split. Indian statements quote descriptions that contain
 *  the delimiter, so a naive split() shreds them. */
export function splitRow(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === delim) { out.push(cur.trim()); cur = '' }
    else cur += ch
  }
  out.push(cur.trim())
  return out
}

function mostFrequent(nums: number[]): number {
  const counts = new Map<number, number>()
  let best = 0
  let bestCount = 0
  for (const n of nums) {
    const c = (counts.get(n) || 0) + 1
    counts.set(n, c)
    if (c > bestCount || (c === bestCount && n > best)) { best = n; bestCount = c }
  }
  return best
}

/** Pick the delimiter whose cell count is both wide and consistent across the
 *  first lines — a tab-separated paste from Excel beats the commas in "1,200". */
export function detectDelimiter(lines: string[]): string {
  const sample = lines.slice(0, 25)
  let best = ','
  let bestScore = 0
  for (const d of DELIMITERS) {
    const widths = sample.map(l => splitRow(l, d).length).filter(n => n > 1)
    if (widths.length < 2) continue
    const mode = mostFrequent(widths)
    const score = (mode - 1) * widths.filter(n => n === mode).length
    if (score > bestScore) { bestScore = score; best = d }
  }
  return best
}

/* ── cells ──────────────────────────────────────────────────────────────── */

function normHeader(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

type Role = 'date' | 'narration' | 'reference' | 'credit' | 'debit' | 'amount' | 'balance' | 'indicator'

/* Checked in this order: "Dr. Amount" must never land on `amount`, and
 * "Value Date" must never land on `value`. */
const ALIASES: Record<Role, string[]> = {
  date: ['date', 'txn date', 'transaction date', 'trans date', 'value date', 'val date', 'posting date', 'entry date', 'dated', 'date of transaction', 'txndate'],
  indicator: ['dr cr', 'd c', 'dr or cr', 'debit credit', 'withdrawal deposit', 'type', 'flag', 'txn type', 'transaction type'],
  credit: ['credit', 'cr', 'cr amount', 'amount cr', 'cr amt', 'credit amount', 'deposit', 'deposits', 'pay in', 'payin', 'credits'],
  debit: ['debit', 'dr', 'dr amount', 'amount dr', 'dr amt', 'debit amount', 'withdrawal', 'withdrawl', 'withdrawal amt', 'paid out', 'debits'],
  balance: ['balance', 'closing balance', 'running balance', 'balance amt', 'amt balance', 'balance amount', 'op cbalance', 'opening closing balance'],
  reference: ['ref', 'ref no', 'reference', 'reference no', 'utr', 'utr no', 'chq no', 'cheque no', 'cheque number', 'instrument id', 'txn id', 'tran id', 'uwi', 'doc no', 'document no', 'payment reference', 'chq ref no', 'narration ref'],
  amount: ['amount', 'txn amount', 'transaction amount', 'amt', 'rs', 'inr', 'amount rs', 'value'],
  narration: ['narration', 'description', 'particulars', 'details', 'transaction details', 'remarks', 'desc', 'narration description', 'particulars description', 'transaction narration'],
}

const ROLE_ORDER: Role[] = ['date', 'indicator', 'credit', 'debit', 'balance', 'reference', 'amount', 'narration']

function roleOf(cell: string): Role | null {
  const h = normHeader(cell)
  if (!h) return null
  for (const role of ROLE_ORDER) {
    if (ALIASES[role].includes(h)) return role
  }
  for (const role of ROLE_ORDER) {
    if (ALIASES[role].some(a => a.length > 3 && h.includes(a))) return role
  }
  return null
}

interface Layout { columns: string[]; roles: Partial<Record<Role, number>>; headerLine: number }

function findHeader(lines: string[], delim: string): Layout | null {
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const cells = splitRow(lines[i], delim)
    if (cells.length < 3) continue
    const roles: Partial<Record<Role, number>> = {}
    cells.forEach((c, idx) => {
      const r = roleOf(c)
      if (r && roles[r] === undefined) roles[r] = idx
    })
    const hasMoney = roles.credit !== undefined || roles.debit !== undefined || roles.amount !== undefined
    if (roles.date !== undefined && (hasMoney || roles.narration !== undefined)) {
      return { columns: cells, roles, headerLine: i }
    }
  }
  return null
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

function iso(y: number, m: number, d: number): string {
  if (m < 1 || m > 12 || d < 1 || d > 31) return ''
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function yearOf(raw: string): number {
  const y = raw.length <= 2 ? (Number(raw) < 70 ? 2000 + Number(raw) : 1900 + Number(raw)) : Number(raw)
  return Number.isFinite(y) ? y : 0
}

/** dd-mm-yyyy, yyyy-mm-dd, 1-Jan-26, "Jan 5, 2026", spreadsheet serials and
 *  time suffixes — every Indian bank export uses a different one. */
export function parseDateCell(raw: string): string {
  const s = (raw || '').trim()
  if (!s) return ''
  const datePart = s.split(/\s+/)[0].replace(/[,]/g, '')

  const serial = /^(\d{5})(\.\d+)?$/.exec(s)
  if (serial) {
    // Excel day number, epoch 1899-12-30.
    const d = new Date(Date.UTC(1899, 11, 30) + Number(serial[1]) * 86400000)
    return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
  }

  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(datePart)
  if (ymd) return iso(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]))

  const num = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(datePart)
  if (num) {
    const a = Number(num[1]); const b = Number(num[2]); const y = yearOf(num[3])
    // A US export sneaks mm-dd in; the day is the only one over 12.
    if (a <= 12 && b > 12) return iso(y, a, b)
    return iso(y, b, a)
  }

  const named = /^(\d{1,2})[-\s]?([A-Za-z]{3,})[-\s,]?(\d{2,4})$/.exec(s.replace(/\s+/g, ' '))
  if (named) {
    const m = MONTHS[named[2].slice(0, 3).toLowerCase()]
    if (m) return iso(yearOf(named[3]), m, Number(named[1]))
  }

  const front = /^([A-Za-z]{3,})\.?[-\s]?(\d{1,2}),?[-\s]?(\d{2,4})$/.exec(s.replace(/\s+/g, ' '))
  if (front) {
    const m = MONTHS[front[1].slice(0, 3).toLowerCase()]
    if (m) return iso(yearOf(front[3]), m, Number(front[2]))
  }
  return ''
}

export interface AmountCell { value: number; direction: Direction | null }

/** ₹1,200.00 · 1200.00 Cr · (1,200) · -1200 · Rs. 1,200/- · 1,200.00- */
export function parseAmountCell(raw: string): AmountCell | null {
  // The trailing /- on an Indian instrument is a filler, not a sign.
  let s = (raw || '').trim().replace(/\/-/g, '')
  if (!s) return null

  let direction: Direction | null = null
  const trail = /\b(dr|cr)\.?$/i.exec(s)
  if (trail) {
    direction = trail[1].toLowerCase() === 'dr' ? 'debit' : 'credit'
    s = s.slice(0, s.length - trail[0].length)
  } else {
    const lead = /^(dr|cr)\.?\s*/i.exec(s)
    if (lead) {
      direction = lead[1].toLowerCase() === 'dr' ? 'debit' : 'credit'
      s = s.slice(lead[0].length)
    }
  }

  const trimmed = s.trim()
  const negative = /^\(.*\)$/.test(trimmed) || /^[-−]/.test(trimmed) || /-$/.test(trimmed)
  if (negative) s = s.replace(/[()]/g, '')

  const cleaned = s.replace(/[₹]|rs\.?|inr|[,\s]/gi, '').replace(/[^\d.]/g, '')
  const value = Number(cleaned)
  if (!Number.isFinite(value) || value === 0) return null
  if (negative && !direction) direction = 'debit'
  return { value, direction }
}

function cleanReference(s: string): string {
  return (s || '').replace(/\s+/g, '').replace(/[^A-Za-z0-9]/g, '')
}

/** Content-derived so the same line reads the same id on every re-import and a
 *  confirmation survives the month being pasted again. */
function txnIdOf(t: Omit<StatementTxn, 'id'>): string {
  const cents = Math.round(t.amount * 100)
  const key = cleanReference(t.reference).toUpperCase()
  const tail = key || t.narration.toLowerCase().replace(/\s+/g, ' ').trim()
  return `${t.date}|${cents}|${t.direction}|${tail}`
}

/** Two identical lines with no reference are two real receipts, so they get an
 *  occurrence suffix; identical lines *with* a UTR are one row exported twice. */
function keyedTxn(t: Omit<StatementTxn, 'id'>, seen: Map<string, number>): StatementTxn | null {
  const base = txnIdOf(t)
  if (cleanReference(t.reference).length >= 6 && seen.has(base)) return null
  const n = (seen.get(base) || 0) + 1
  seen.set(base, n)
  return { ...t, id: n > 1 ? `${base}#${n}` : base }
}

/** Credits and debits arrive four ways: separate Dr./Cr. columns, a signed
 *  amount column, an amount column with a Dr/Cr indicator, or a bare amount
 *  that only the running balance can give a sign to. */
function readMoney(
  row: string[],
  roles: Partial<Record<Role, number>>,
  narration: string,
  prevBalance: number | null,
): { amount: number; direction: Direction } | null {
  const cell = (idx: number | undefined) => (idx === undefined ? null : parseAmountCell(row[idx] || ''))

  const credit = cell(roles.credit)
  const debit = cell(roles.debit)
  if (credit || debit) {
    if (credit && (!debit || credit.value >= debit.value)) return { amount: credit.value, direction: 'credit' }
    if (debit) return { amount: debit.value, direction: 'debit' }
  }

  const amount = cell(roles.amount)
  if (!amount) return null
  let direction: Direction | null = amount.direction

  if (!direction && roles.indicator !== undefined) {
    const flag = normHeader(row[roles.indicator] || '')
    if (flag) direction = flag.startsWith('d') || flag.includes('withdraw') ? 'debit' : 'credit'
  }
  if (!direction && roles.balance !== undefined) {
    const balance = cell(roles.balance)
    if (balance && prevBalance !== null) direction = balance.value >= prevBalance ? 'credit' : 'debit'
  }
  if (!direction) {
    // Last resort is the narration, which most banks stuff the flag into anyway.
    direction = /\b(dr|debit|withdrawal|paid)\b/i.test(narration) ? 'debit' : 'credit'
  }
  return { amount: amount.value, direction }
}

export function parseStatement(text: string): ParseResult {
  const rawLines = (text || '').replace(/\r\n?/g, '\n').split('\n')
  const lines = rawLines.filter(l => l.trim())
  const issues: ParseIssue[] = []
  if (!lines.length) throw new Error('The statement is empty.')

  const delimiter = detectDelimiter(lines)
  const header = findHeader(lines, delimiter)
  if (!header) {
    throw new Error('Could not find a header row. A statement needs a date column plus an amount, or Dr./Cr. columns.')
  }

  const { roles } = header
  const narrationIdx = roles.narration ?? -1
  const dateIdx = roles.date ?? 0

  const txns: StatementTxn[] = []
  const seen = new Map<string, number>()
  let skippedNoAmount = 0
  let skippedNoDate = 0
  let prevBalance: number | null = null

  for (let i = header.headerLine + 1; i < lines.length; i++) {
    const cells = splitRow(lines[i], delimiter)
    if (cells.every(c => !c)) continue

    // A description containing commas arrives as extra cells; fold them back
    // into the narration instead of shifting every column after it.
    let row = cells
    const extra = cells.length - header.columns.length
    if (extra > 0) {
      const target = narrationIdx >= 0 ? narrationIdx : header.columns.length - 1
      const take = extra + 1
      row = [...cells]
      const merged = row.slice(target, target + take).join(' ')
      row.splice(target, take, merged)
    }

    const dateCell = row[dateIdx] || ''
    const date = parseDateCell(dateCell)
    const narration = (narrationIdx >= 0 ? row[narrationIdx] : '').replace(/\s+/g, ' ').trim()
    const balanceCell = roles.balance !== undefined ? parseAmountCell(row[roles.balance] || '') : null

    const money = readMoney(row, roles, narration, prevBalance)
    if (!money) { skippedNoAmount++; continue }
    if (!date) { skippedNoDate++; continue }

    const txn = keyedTxn({
      date,
      narration,
      reference: roles.reference !== undefined ? (row[roles.reference] || '') : '',
      amount: Math.round(money.amount * 100) / 100,
      direction: money.direction,
      balance: balanceCell ? Math.round(balanceCell.value * 100) / 100 : null,
    }, seen)
    if (!txn) { issues.push({ line: i + 1, text: lines[i].slice(0, 90), reason: 'duplicate reference' }); continue }
    txns.push(txn)
    if (balanceCell) prevBalance = balanceCell.value
    if (txns.length >= MAX_ROWS) {
      issues.push({ line: i + 1, text: '', reason: `stopped at ${MAX_ROWS} rows` })
      break
    }
  }

  if (!txns.length) {
    throw new Error(
      skippedNoAmount && skippedNoAmount > skippedNoDate
        ? 'The header was read but no row carried an amount. Check that the amount column is mapped.'
        : 'No dated rows found below the header.'
    )
  }

  if (skippedNoAmount) issues.push({ line: header.headerLine + 2, text: `${skippedNoAmount} row(s) skipped`, reason: 'no amount' })
  if (skippedNoDate) issues.push({ line: header.headerLine + 2, text: `${skippedNoDate} row(s) skipped`, reason: 'no readable date' })

  const dates = txns.map(t => t.date).filter(Boolean).sort()
  return {
    txns,
    issues,
    delimiter,
    columns: header.columns,
    from: dates[0] || '',
    to: dates[dates.length - 1] || '',
    closingBalance: txns[txns.length - 1]?.balance ?? null,
  }
}

/** A paste-ready sample, shown on the import screen so a first-time user can
 *  see the shape the parser reads before uploading anything. The balances in it
 *  move exactly as the withdrawals and deposits say they should. */
export const SAMPLE_STATEMENT = [
  'Date,Narration,Chq/Ref No.,Withdrawal Amt.,Deposit Amt.,Closing Balance',
  '01-04-2026,"NEFT-DR-SWIFT-SHREYA TRADERS PVT LTD-INV-2026-27-0004",02260400112233,,145600.00,945600.00',
  '03-04-2026,"UPI-9007-SHARMA ASSOCIATES-SELLER PAYMENT",91420300221345,18990.00,,926610.00',
  '05-04-2026,"CHQ NO 447102 PAID-MAHASURI TEXTILES",447102,62400.00,,864210.00',
  '07-04-2026,"GST PAYED CHALLAN-CBBE-TAXPAY-GOVL OF INDIA",CBBE12042600077,74210.00,,790000.00',
  '09-04-2026,"SAV INT QTR-ICICI BANK LTD",,,1840.00,791840.00',
  '11-04-2026,"IMPS-CREDIT-ANAND INFRA PVT LTD-INV-2026-27-0011",44810900448,,75000.00,866840.00',
].join('\n')

/* ── books to match against ─────────────────────────────────────────────── */

export interface OpenDoc {
  id: string
  kind: 'invoice' | 'bill'
  number: string
  party: string
  date: string
  total: number
  due: number
}

export interface BookPayment {
  id: string
  ref: string
  party: string
  date: string
  amount: number
  type: 'received' | 'made'
  docNumber: string
  docId: string | null
}

export interface Books {
  docs: OpenDoc[]
  payments: BookPayment[]
}

export interface MatchOptions {
  /** Statements round to paise, books to the rupee. */
  tolerance?: number
}

export interface Candidate {
  kind: DocKind
  docId: string
  number: string
  party: string
  date: string
  /** The figure in the books the line was compared against. */
  compared: number
  basis: string
  score: number
  tier: Tier
  reasons: string[]
}

/* Weights sum to a 100-point scale so a tier reads the same way on every row:
 * amount 40, document number 30, party 18, date 12. */
const TIER_EXACT = 80
const TIER_LIKELY = 58
const TIER_POSSIBLE = 40

const STOPWORDS = new Set(['pvt', 'ltd', 'llp', 'inc', 'and', 'the', 'for', 'with', 'from', 'this', 'that', 'sales', 'salesm', 'transaction'])

function tokens(s: string): Set<string> {
  return new Set(
    (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ')
      .filter(w => w.length >= 3 && !STOPWORDS.has(w)),
  )
}

function partyScore(txnText: string, party: string): { score: number; hit: boolean } {
  const hay = tokens(txnText)
  const need = tokens(party)
  if (!need.size) return { score: 0, hit: false }
  let overlap = 0
  for (const t of need) if (hay.has(t)) overlap++
  if (!overlap) return { score: 0, hit: false }
  const ratio = overlap / need.size
  return { score: ratio >= 0.6 ? 18 : ratio >= 0.34 ? 12 : 6, hit: true }
}

function dayDiff(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 9999
  return Math.round((b - a) / 86400000)
}

function dateScore(diff: number): number {
  const d = Math.abs(diff)
  if (d <= 7) return 12
  if (d <= 30) return 9
  if (d <= 90) return 6
  if (d <= 180) return 3
  return 0
}

function inr(value: number): string {
  return `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function amountScore(value: number, target: number, tolerance: number): { score: number; basis: string } {
  if (target <= 0) return { score: 0, basis: '' }
  const diff = Math.abs(value - target)
  if (diff <= tolerance) return { score: 40, basis: 'exact amount' }
  if (diff / target <= 0.01) return { score: 32, basis: 'amount within 1%' }
  if (diff / target <= 0.05) return { score: 20, basis: 'amount within 5%' }
  if (value < target && value / target >= 0.2) return { score: 14, basis: 'part payment' }
  return { score: 0, basis: '' }
}

export function tierOf(score: number): Tier {
  if (score >= TIER_EXACT) return 'exact'
  if (score >= TIER_LIKELY) return 'likely'
  return 'possible'
}

function numberHit(txn: StatementTxn, number: string): boolean {
  const hay = cleanReference(`${txn.narration} ${txn.reference}`).toUpperCase()
  if (!hay) return false
  return invoiceNoCandidates(number)
    .map(c => c.replace(/[^A-Z0-9]/g, ''))
    .some(c => c.length >= 5 && hay.includes(c))
}

function refHit(txn: StatementTxn, ref: string): boolean {
  const a = cleanReference(txn.reference).toUpperCase()
  const b = cleanReference(ref).toUpperCase()
  return a.length >= 6 && b.length >= 6 && (a === b || a.includes(b) || b.includes(a))
}

function matchDoc(txn: StatementTxn, doc: OpenDoc, tolerance: number): Candidate | null {
  const wants: 'invoice' | 'bill' = txn.direction === 'credit' ? 'invoice' : 'bill'
  if (doc.kind !== wants) return null

  const text = `${txn.narration} ${txn.reference}`
  const reasons: string[] = []
  let score = 0

  // Balance due is the honest target; a paid-in-full line matches the total.
  const due = amountScore(txn.amount, doc.due, tolerance)
  const total = amountScore(txn.amount, doc.total, tolerance)
  const amount = due.score >= total.score ? due : total
  if (amount.score) {
    score += amount.score
    reasons.push(`${amount.basis} of ${inr(amount === due ? doc.due : doc.total)}`)
  }

  if (numberHit(txn, doc.number)) { score += 30; reasons.push(`carries the document number ${doc.number}`) }

  const party = partyScore(text, doc.party)
  if (party.score) { score += party.score; reasons.push(`narration names ${doc.party}`) }

  const diff = dayDiff(doc.date, txn.date)
  if (diff >= 0) {
    const s = dateScore(diff)
    if (s) { score += s; reasons.push(`${diff} day(s) after the document`) }
  } else if (Math.abs(diff) <= 7 && party.hit) {
    score += 3; reasons.push('paid shortly before the document')
  }

  if (score < TIER_POSSIBLE) return null
  return {
    kind: doc.kind,
    docId: doc.id,
    number: doc.number,
    party: doc.party,
    date: doc.date,
    compared: amount === due ? doc.due : doc.total,
    basis: amount === due ? 'balance due' : 'document total',
    score: Math.min(100, Math.round(score)),
    tier: tierOf(score),
    reasons,
  }
}

function matchPayment(txn: StatementTxn, pay: BookPayment, tolerance: number): Candidate | null {
  const wants = txn.direction === 'credit' ? 'received' : 'made'
  if (pay.type !== wants) return null

  const reasons: string[] = []
  let score = 0
  const ref = refHit(txn, pay.ref)
  if (ref) { score += 45; reasons.push(`reference ${pay.ref} is already recorded`) }

  const amount = amountScore(txn.amount, pay.amount, tolerance)
  if (amount.score) {
    // A recorded payment is confirmed by the reference alone; the amount only adds.
    score += ref ? Math.min(amount.score, 30) : amount.score
    reasons.push(`${amount.basis} of ${inr(pay.amount)}`)
  }

  const party = partyScore(`${txn.narration} ${txn.reference}`, pay.party)
  if (party.score) { score += ref ? Math.min(party.score, 12) : party.score; reasons.push(`narration names ${pay.party}`) }

  const days = dayDiff(pay.date, txn.date)
  const s = dateScore(days)
  if (s) { score += ref ? Math.min(s, 8) : s; reasons.push(`${Math.abs(days)} day(s) from the recorded payment`) }

  // Only a reference hit, or an unambiguous amount+party+date agreement, is
  // worth claiming "this is already in your books". Without the reference the
  // three signals top out at 70, so the tier gate would reject every one.
  if (!ref && !(amount.score >= 32 && party.hit && Math.abs(days) <= 45)) return null

  return {
    kind: 'payment',
    docId: pay.docId || pay.id,
    number: pay.docNumber || pay.ref || 'recorded payment',
    party: pay.party,
    date: pay.date,
    compared: pay.amount,
    basis: 'recorded payment',
    score: Math.min(100, Math.round(score)),
    tier: tierOf(score),
    reasons,
  }
}

/** Ranked candidates for one bank line, best first. */
export function matchTxn(txn: StatementTxn, books: Books, opts: MatchOptions = {}): Candidate[] {
  const tolerance = opts.tolerance ?? 1
  const out: Candidate[] = []
  for (const doc of books.docs) {
    const c = matchDoc(txn, doc, tolerance)
    if (c) out.push(c)
  }
  for (const pay of books.payments) {
    const c = matchPayment(txn, pay, tolerance)
    if (c) out.push(c)
  }
  out.sort((a, b) => b.score - a.score)
  return out.slice(0, 3)
}

/* ── review rows ────────────────────────────────────────────────────────── */

export type RowStatus = 'confirmed' | 'suggested' | 'review' | 'ignored'

export interface MatchRow {
  txn: StatementTxn
  candidates: Candidate[]
  /** Confirmed by the user, otherwise the best candidate. */
  chosen: Candidate | null
  status: RowStatus
}

export function buildRows(txns: StatementTxn[], books: Books, decisions: Record<string, Decision>, opts: MatchOptions = {}): MatchRow[] {
  return txns.map(txn => {
    const candidates = matchTxn(txn, books, opts)
    const decision = decisions[txn.id]
    if (decision?.status === 'ignored') {
      return { txn, candidates, chosen: null, status: 'ignored' }
    }
    if (decision?.status === 'confirmed') {
      const chosen = decision.candidate || candidates[0] || null
      return { txn, candidates, chosen, status: 'confirmed' }
    }
    const best = candidates[0] || null
    return { txn, candidates, chosen: best, status: best && best.tier !== 'possible' ? 'suggested' : 'review' }
  })
}

const DEBIT_KEYWORDS: [RegExp, string][] = [
  [/\b(gst|taxpay|challan|itc|tds|income tax|incometax)\b/i, 'GST or income-tax payment'],
  [/\b(salary|sal\.|payroll|stipend|wages)\b/i, 'Salary or wages'],
  [/\b(emi|loan|nag)\b/i, 'Loan or EMI debit'],
  [/\b(rent|lease|electricity|power|water|internet|broadband|telephone|insurance|maintenance)\b/i, 'Business expense'],
  [/\b(charge|charges|fee|commission|penalty|ast|annual a\/c)\b/i, 'Bank charge or penalty'],
  [/\b(transfer|fwd|fund)\b/i, 'Internal transfer'],
]

const CREDIT_KEYWORDS: [RegExp, string][] = [
  [/\b(int\.?\s?paid|interest credited|sav int|savings interest)\b/i, 'Interest received'],
  [/\b(refund|rebate|cashback|cash back)\b/i, 'Refund or rebate'],
  [/\b(fd|maturity|dividend|profit)\b/i, 'Investment income'],
  [/\b(loan|disburs)\b/i, 'Loan disbursement'],
]

/** What an unexplained line probably is, so the review screen is not a blank list. */
export function advisory(txn: StatementTxn): string {
  const list = txn.direction === 'credit' ? CREDIT_KEYWORDS : DEBIT_KEYWORDS
  for (const [re, label] of list) if (re.test(txn.narration)) return label
  return txn.direction === 'credit'
    ? 'Receipt with no open invoice — advance, a cash sale, or a refund'
    : 'Payment with no open bill — an expense, a transfer, or a statutory payment'
}

export interface Summary {
  rows: number
  credits: number
  debits: number
  creditValue: number
  debitValue: number
  confirmed: number
  suggested: number
  review: number
  ignored: number
  inBooks: number
  matchedValue: number
  reviewValue: number
}

export function summarise(rows: MatchRow[]): Summary {
  const s: Summary = {
    rows: rows.length, credits: 0, debits: 0, creditValue: 0, debitValue: 0,
    confirmed: 0, suggested: 0, review: 0, ignored: 0, inBooks: 0, matchedValue: 0, reviewValue: 0,
  }
  for (const r of rows) {
    if (r.txn.direction === 'credit') { s.credits++; s.creditValue += r.txn.amount } else { s.debits++; s.debitValue += r.txn.amount }
    s[r.status]++
    if (r.chosen?.kind === 'payment') s.inBooks++
    if (r.status === 'confirmed' || r.status === 'suggested') s.matchedValue += r.txn.amount
    if (r.status === 'review') s.reviewValue += r.txn.amount
  }
  return s
}

/* ── local state (no schema change) ─────────────────────────────────────── */

export const BANK_VERSION = 1

export interface Statement {
  id: string
  name: string
  fileName: string
  source: 'paste' | 'file'
  importedAt: string
  from: string
  to: string
  delimiter: string
  columns: string[]
  closingBalance: number | null
  txns: StatementTxn[]
}

export interface Decision {
  status: 'confirmed' | 'ignored'
  at: string
  /** The document the user picked. Kept whole so a confirmation does not depend
   *  on that document still being open the next time the statement is read. */
  candidate?: Candidate
}

export interface BankState {
  version: number
  updatedAt: string
  statements: Statement[]
  decisions: Record<string, Decision>
}

const STATE_KEY = 'taxflow:bank:'
const MAX_STATEMENTS = 10

export function emptyBank(): BankState {
  return { version: BANK_VERSION, updatedAt: '', statements: [], decisions: {} }
}

export function loadBank(orgId: string): BankState {
  if (typeof window === 'undefined' || !orgId) return emptyBank()
  try {
    const raw = window.localStorage.getItem(STATE_KEY + orgId)
    if (!raw) return emptyBank()
    const parsed = JSON.parse(raw) as Partial<BankState>
    return {
      version: BANK_VERSION,
      updatedAt: parsed.updatedAt || '',
      statements: Array.isArray(parsed.statements) ? parsed.statements : [],
      decisions: parsed.decisions && typeof parsed.decisions === 'object' ? parsed.decisions : {},
    }
  } catch {
    return emptyBank()
  }
}

export function saveBank(orgId: string, state: BankState): BankState {
  const stamped: BankState = { ...state, updatedAt: new Date().toISOString() }
  try {
    window.localStorage.setItem(STATE_KEY + orgId, JSON.stringify(stamped))
  } catch {
    // A long statement can outgrow the quota; the review stays for this session.
  }
  return stamped
}

/** Keep decisions only for lines that are still on screen, and the last few
 *  statements — a year of monthly exports would outgrow localStorage. */
export function addStatement(state: BankState, statement: Statement): BankState {
  const statements = [statement, ...state.statements.filter(s => s.id !== statement.id)].slice(0, MAX_STATEMENTS)
  const live = new Set(statements.flatMap(s => s.txns.map(t => t.id)))
  const decisions: Record<string, Decision> = {}
  for (const [id, d] of Object.entries(state.decisions)) if (live.has(id)) decisions[id] = d
  return { ...state, statements, decisions }
}

export function dropStatement(state: BankState, id: string): BankState {
  const statements = state.statements.filter(s => s.id !== id)
  const live = new Set(statements.flatMap(s => s.txns.map(t => t.id)))
  const decisions: Record<string, Decision> = {}
  for (const [txnId, d] of Object.entries(state.decisions)) if (live.has(txnId)) decisions[txnId] = d
  return { ...state, statements, decisions }
}

export function setDecision(state: BankState, txnId: string, decision: Decision | null): BankState {
  const decisions = { ...state.decisions }
  if (decision) decisions[txnId] = decision
  else delete decisions[txnId]
  return { ...state, decisions }
}

export function clearDecisions(state: BankState): BankState {
  return { ...state, decisions: {} }
}

/** Flattened across statements, newest import first. ids are content-derived,
 *  so re-importing a month does not count the same receipt twice. */
export function allTxns(state: BankState): StatementTxn[] {
  const seen = new Set<string>()
  const out: StatementTxn[] = []
  for (const s of state.statements) {
    for (const t of s.txns) {
      if (seen.has(t.id)) continue
      seen.add(t.id)
      out.push(t)
    }
  }
  return out
}

/* ── export ─────────────────────────────────────────────────────────────── */

export const MATCH_CSV_HEADERS = [
  'Date', 'Direction', 'Amount', 'Narration', 'Reference', 'Balance',
  'Status', 'Confidence', 'Matched document', 'Party', 'Document date',
  'Compared value', 'Score', 'Why', 'Advice',
]

export function matchCsvRows(rows: MatchRow[]): (string | number)[][] {
  return rows.map(r => [
    r.txn.date,
    r.txn.direction === 'credit' ? 'Credit' : 'Debit',
    r.txn.amount.toFixed(2),
    r.txn.narration,
    r.txn.reference,
    r.txn.balance === null ? '' : r.txn.balance.toFixed(2),
    r.status,
    r.chosen ? r.chosen.tier : '',
    r.chosen ? `${r.chosen.kind} ${r.chosen.number}` : '',
    r.chosen?.party || '',
    r.chosen?.date || '',
    r.chosen ? r.chosen.compared.toFixed(2) : '',
    r.chosen ? r.chosen.score : '',
    r.chosen ? r.chosen.reasons.join('; ') : '',
    r.status === 'review' || r.status === 'ignored' ? advisory(r.txn) : '',
  ])
}
