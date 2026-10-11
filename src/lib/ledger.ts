// Lightweight double-entry derivation engine.
// Instead of a full chart-of-accounts ledger (which would need new DB tables),
// we derive a P&L and a Balance Sheet from the existing sales / purchase /
// expense / payment / product documents. The balance sheet is made to balance
// by construction: Owner's Funds = Total Assets − Total Liabilities, decomposed
// into Opening capital + Retained earnings + a transparent balancing reserve.
// All functions are pure — they take plain row arrays and return numbers.

type Num = number | string | null | undefined

function num(x: Num): number {
  const n = typeof x === 'string' ? parseFloat(x) : x
  return n == null || isNaN(n) ? 0 : Number(n)
}

// Dates are ISO 'yyyy-mm-dd' strings, so lexical comparison is valid.
function within(date: string | null, start: string, end: string): boolean {
  if (!date) return false
  return date >= start && date <= end
}
function onOrBefore(date: string | null, end: string): boolean {
  if (!date) return false
  return date <= end
}

export interface LedgerInvoice {
  status: string
  invoice_date: string | null
  taxable_amount: Num
  total_tax: Num
  balance_due: Num
}

export interface LedgerBill {
  status: string
  bill_date: string | null
  taxable_amount: Num
  total_tax: Num
  itc_eligible: boolean | null
  balance_due: Num
}

export interface LedgerExpense {
  expense_date: string | null
  amount: Num
  gst_amount: Num
  taxable_amount: Num
  itc_eligible: boolean | null
  payment_status: string | null
  category?: string | null
}

export interface LedgerPayment {
  payment_type: string // 'received' | 'made'
  amount: Num
  payment_date: string | null
}

export interface LedgerProduct {
  type: string | null
  track_inventory: boolean | null
  current_stock: Num
  purchase_price: Num
}

// ── the journal, folded in ────────────────────────────────────────────────────
//
// `journal.ts` keeps its own row shape; this engine imports nothing (Rule 23), so the same eight
// fields are re-declared here rather than shared. A page hands one array to both derivations, so
// the P&L and the balance sheet cannot read different judgements.
//
// The fold is a *renaming*, not a correction. Each row already carries the sign the statement line
// grows on, so a journal figure is added to its own line and nowhere else: revenue joins revenue, a
// capital leg joins the capital line the plug is measured against. Because every entry that posts
// here was balanced on the way in, the derived balancing reserve does not move — it shrinks only by
// whatever the journal dared to name as capital. The proof of that is read off the register by
// `plugProof()` in `journal.ts`, not asserted here.
export interface LedgerJournalRow {
  entry_id: string
  number: string
  date: string
  label: string
  /** The statement line the head belongs to. An unknown name moves nothing — it is not guessed. */
  slot: string
  /** Signed rupees on that line. */
  signed: number
  narration: string
  actor: string
}

/** The lines a journal may move, and which of the two derivations reads each one. */
const JOURNAL_SLOTS = [
  'revenue', 'purchases', 'expense',
  'receivables', 'inventory', 'cash', 'bank', 'fixedAssets', 'otherAsset',
  'payables', 'outstandingExpenses', 'gstLiability', 'loans', 'otherLiability', 'capital',
] as const
export type JournalSlot = (typeof JOURNAL_SLOTS)[number]

function isJournalSlot(name: string): name is JournalSlot {
  return (JOURNAL_SLOTS as readonly string[]).includes(name)
}

/** Rupee arithmetic in paisa — a fold must not arrive at 0.30000000000000004. */
function toPaise(x: number): number {
  return Math.round((Number.isFinite(x) ? x : 0) * 100)
}
function toRupees(p: number): number {
  return p / 100
}

export interface JournalFold {
  /** Only the lines that moved. A slot the journal left alone is absent, not zero-printed. */
  bySlot: Partial<Record<JournalSlot, number>>
  /** Expense lines the journal raised, under the head's own name — the same names a category takes. */
  expenseLines: { label: string; amount: number }[]
  /** Distinct entries behind the figures, and how many legs carried them. */
  entries: number
  legs: number
  /** How many statement lines the fold leaves *changed*. Zero with a non-zero `legs` means the rows
   *  answered each other — a reversed pair, or two heads on the same line — and the honest footnote
   *  is that nothing moved, not a count of legs. */
  touched: number
}

const NO_JOURNAL: JournalFold = { bySlot: {}, expenseLines: [], entries: 0, legs: 0, touched: 0 }

function emptyFold(): JournalFold {
  return { bySlot: {}, expenseLines: [], entries: 0, legs: 0, touched: 0 }
}

/** Sum the rows the statement is allowed to read, per slot and per expense head. */
function foldRows(rows: LedgerJournalRow[] | undefined, inside: (date: string) => boolean): JournalFold {
  if (!rows || rows.length === 0) return { ...NO_JOURNAL }
  const paise = new Map<string, number>()
  const expenses = new Map<string, number>()
  const entries = new Set<string>()
  let legs = 0
  for (const r of rows) {
    if (!r || !isJournalSlot(r.slot) || !inside(r.date)) continue
    legs += 1
    entries.add(r.entry_id)
    const value = toPaise(num(r.signed))
    paise.set(r.slot, (paise.get(r.slot) ?? 0) + value)
    if (r.slot === 'expense') {
      const name = (r.label || 'Journal').trim() || 'Journal'
      expenses.set(name, (expenses.get(name) ?? 0) + value)
    }
  }
  const fold = emptyFold()
  for (const [slot, p] of paise) {
    if (p !== 0) fold.bySlot[slot as JournalSlot] = toRupees(p)
  }
  for (const [label, p] of expenses) {
    if (p !== 0) fold.expenseLines.push({ label, amount: toRupees(p) })
  }
  fold.expenseLines.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
  fold.entries = entries.size
  fold.legs = legs
  // A line counts as moved when the fold leaves a *printed* figure behind. The expense slot is read
  // through its named sub-lines, so it is counted there rather than twice over.
  fold.touched = Object.keys(fold.bySlot).filter(slot => slot !== 'expense').length + fold.expenseLines.length
  return fold
}

function onTheStatement(day: string, start: string, end: string): boolean {
  return within(day || null, start, end)
}

/** What one named line of the statements the journal moved — absent means untouched. */
function jSlot(fold: JournalFold, slot: JournalSlot): number {
  return fold.bySlot[slot] ?? 0
}

export interface OpeningBalances {
  cash: number
  /** Money the shop opened with in a bank account — kept apart from petty cash at hand. */
  bank: number
  /** Money customers owed the day the books were picked up. These are invoices from before the books began. */
  receivables: number
  /** Money the shop owed vendors the day the books were picked up. */
  payables: number
  fixedAssets: number
  loans: number
  capital: number
  /** The day these figures were true — printed on the balance sheet, never guessed. */
  as_of: string
}

const EMPTY_OPENING: OpeningBalances = {
  cash: 0, bank: 0, receivables: 0, payables: 0,
  fixedAssets: 0, loans: 0, capital: 0, as_of: '',
}

// ── Profit & Loss ────────────────────────────────────────
export interface ProfitLoss {
  revenue: number
  purchases: number
  grossProfit: number
  expensesByCategory: { label: string; amount: number }[]
  totalExpenses: number
  netProfit: number
  /** What the manual journal contributed to this statement — the fold, kept beside the paper, not inside it. */
  journal: JournalFold
}

// Expense is booked net of GST (the GST portion is a liability / ITC, not cost).
function expenseNet(e: LedgerExpense): number {
  const taxable = num(e.taxable_amount)
  if (taxable > 0) return taxable
  return num(e.amount) - num(e.gst_amount)
}

export function computeProfitLoss(
  invoices: LedgerInvoice[],
  bills: LedgerBill[],
  expenses: LedgerExpense[],
  start: string,
  end: string,
  journal?: LedgerJournalRow[],
): ProfitLoss {
  let revenue = 0
  for (const i of invoices) {
    if (i.status !== 'cancelled' && within(i.invoice_date, start, end)) revenue += num(i.taxable_amount)
  }

  let purchases = 0
  for (const b of bills) {
    if (b.status !== 'cancelled' && within(b.bill_date, start, end)) purchases += num(b.taxable_amount)
  }

  const byCategory: Record<string, number> = {}
  let totalExpenses = 0
  for (const e of expenses) {
    if (!within(e.expense_date, start, end)) continue
    const net = expenseNet(e)
    totalExpenses += net
    const cat = (e.category || 'Other').trim() || 'Other'
    byCategory[cat] = (byCategory[cat] || 0) + net
  }

  // The journal reads the same rows the balance sheet reads, over the same window. A head called
  // `Depreciation` joins the category of that name — a journal does not raise a fifth kind of cost,
  // it names a cost the paper never carried. A credit on an expense line *reduces* it: the signed
  // movement is already the statement's own direction, so no second sign is applied here (Rule 28).
  const fold = foldRows(journal, day => onTheStatement(day, start, end))
  revenue += jSlot(fold, 'revenue')
  purchases += jSlot(fold, 'purchases')
  for (const line of fold.expenseLines) {
    byCategory[line.label] = (byCategory[line.label] || 0) + line.amount
    totalExpenses += line.amount
  }

  const expensesByCategory = Object.entries(byCategory)
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount)

  const grossProfit = revenue - purchases
  const netProfit = grossProfit - totalExpenses

  return { revenue, purchases, grossProfit, expensesByCategory, totalExpenses, netProfit, journal: fold }
}

// ── Balance Sheet ────────────────────────────────────────
export interface BalanceSheet {
  asOf: string
  receivables: number
  /** The opening receivable the books were picked up with — inside `receivables`, shown so the page can name it. */
  openingReceivables: number
  inventory: number
  cash: number
  /** Money opened in a bank: nothing flows into or out of this line; payments move `cash`. */
  bank: number
  fixedAssets: number
  /** Assets only a journal has ever named — a provision written back, a deposit paid, a loan made. */
  otherAssets: number
  totalAssets: number
  payables: number
  /** The opening payable the books started with — inside `payables`, shown so the page can name it. */
  openingPayables: number
  outstandingExpenses: number
  gstLiability: number
  loans: number
  /** Liabilities only a journal has ever named — a GST demand raised, a provision carried. */
  otherLiabilities: number
  totalLiabilities: number
  ownersFunds: number
  openingCapital: number
  retainedEarnings: number
  /** Capital a journal stated outright — subtracted from the plug, so the plug stays the unexplained remainder. */
  journalCapital: number
  balancingReserve: number
  /** The journal's own contribution to this sheet, per statement line, beside the figures rather than buried in them. */
  journal: JournalFold
  isBalanced: boolean
}

export interface BalanceSheetInput {
  invoices: LedgerInvoice[]
  bills: LedgerBill[]
  expenses: LedgerExpense[]
  payments: LedgerPayment[]
  products: LedgerProduct[]
  opening: OpeningBalances
  cumulativeNetProfit: number
  /** The same rows the P&L was given, up to `asOf`. Nothing here recomputes them. */
  journal?: LedgerJournalRow[]
}

export function computeBalanceSheet(input: BalanceSheetInput, asOf: string): BalanceSheet {
  const { invoices, bills, expenses, payments, products } = input
  const opening = input.opening || EMPTY_OPENING
  // A journal row stands on its own day and needs no opening date behind it — the seal and the
  // register already decided it may exist. So it is read by the entry's date alone, while the
  // opening figures below stay gated on their own `as_of`.
  const fold = foldRows(input.journal, day => onOrBefore(day || null, asOf))

  // Assets
  let receivables = 0
  for (const i of invoices) {
    if (i.status !== 'cancelled' && onOrBefore(i.invoice_date, asOf)) receivables += num(i.balance_due)
  }
  // What the books were picked up owing is a receivable too — but only once the day those
  // figures were struck has actually arrived. A balance sheet drawn before the books opened
  // shows the documents it has, not an opening it was not yet standing on. The honest limit,
  // printed beside the figure: a payment recorded later grows `cash` but cannot reduce this
  // line — the engine will not guess which pre-books paper it settled. A settlement that wants
  // to move both sides is an invoice with a number, not an opening figure.
  const openingStood = !opening.as_of || opening.as_of <= asOf
  const openingReceivables = openingStood ? num(opening.receivables) : 0
  const openingPayables = openingStood ? num(opening.payables) : 0
  receivables += openingReceivables

  let inventory = 0
  for (const p of products) {
    if (p.track_inventory && p.type === 'goods') inventory += num(p.current_stock) * num(p.purchase_price)
  }

  let cashIn = 0, cashOut = 0
  for (const p of payments) {
    if (!onOrBefore(p.payment_date, asOf)) continue
    if (p.payment_type === 'received') cashIn += num(p.amount)
    else if (p.payment_type === 'made') cashOut += num(p.amount)
  }
  // Expenses already paid in cash/bank reduce funds even if not in payments table.
  let expensesPaid = 0, expensesOutstanding = 0
  for (const e of expenses) {
    if (!onOrBefore(e.expense_date, asOf)) continue
    if (e.payment_status === 'paid') expensesPaid += num(e.amount)
    else expensesOutstanding += num(e.amount)
  }
  const cash = opening.cash + cashIn - cashOut - expensesPaid + jSlot(fold, 'cash')
  const bank = (openingStood ? num(opening.bank) : 0) + jSlot(fold, 'bank')
  const fixedAssets = opening.fixedAssets + jSlot(fold, 'fixedAssets')
  // A line the documents never carried gets its own name on the sheet rather than being folded into
  // a figure the shop cannot trace. `otherAssets` is only ever the journal's own named heads.
  const otherAssets = jSlot(fold, 'otherAsset')
  receivables += jSlot(fold, 'receivables')
  inventory += jSlot(fold, 'inventory')

  const totalAssets = receivables + inventory + cash + bank + fixedAssets + otherAssets

  // Liabilities
  let billPayables = 0
  let outputTax = 0
  let inputTax = 0
  for (const b of bills) {
    if (b.status === 'cancelled') continue
    if (onOrBefore(b.bill_date, asOf)) {
      billPayables += num(b.balance_due)
      if (b.itc_eligible) inputTax += num(b.total_tax)
    }
  }
  for (const i of invoices) {
    if (i.status !== 'cancelled' && onOrBefore(i.invoice_date, asOf)) outputTax += num(i.total_tax)
  }
  for (const e of expenses) {
    if (onOrBefore(e.expense_date, asOf) && e.itc_eligible) inputTax += num(e.gst_amount)
  }

  // The GST line is the documents' own arithmetic, floor at zero, because output tax the shop has
  // collected is owed whether or not input credit covers it. A journal posting against it is added
  // *after* that floor — it is the shop's stated figure (a demand raised, a credit reversed), not a
  // credit to be netted away by the engine's guess.
  const gstLiability = Math.max(0, outputTax - inputTax) + jSlot(fold, 'gstLiability')
  const payables = billPayables + openingPayables + jSlot(fold, 'payables')
  const outstandingExpenses = expensesOutstanding + jSlot(fold, 'outstandingExpenses')
  const loans = opening.loans + jSlot(fold, 'loans')
  const otherLiabilities = jSlot(fold, 'otherLiability')

  const totalLiabilities = payables + outstandingExpenses + gstLiability + loans + otherLiabilities

  // Owner's funds = assets − liabilities (balances by construction)
  const ownersFunds = totalAssets - totalLiabilities
  const retainedEarnings = input.cumulativeNetProfit
  // A journal that names capital — drawings, a partner's contribution, a loan taken as capital —
  // is read as the capital it claims to be, so the derived plug gives that room way. Every other
  // leg lands on both sides of this subtraction at once, which is why a balanced journal cannot
  // move the plug: see the round's proof in `journal.ts` `plugProof()`.
  const journalCapital = jSlot(fold, 'capital')
  const balancingReserve = ownersFunds - opening.capital - retainedEarnings - journalCapital

  return {
    asOf,
    receivables, openingReceivables, inventory, cash, bank, fixedAssets, otherAssets, totalAssets,
    payables, openingPayables, outstandingExpenses, gstLiability, loans, otherLiabilities, totalLiabilities,
    ownersFunds,
    openingCapital: opening.capital,
    retainedEarnings,
    journalCapital,
    balancingReserve,
    journal: fold,
    isBalanced: true,
  }
}

// ── Opening balances (localStorage, per org) ─────────────
const OPENING_PREFIX = 'taxflow:opening:'

export function loadOpeningBalances(orgId: string): OpeningBalances {
  const fallback = { ...EMPTY_OPENING }
  if (typeof window === 'undefined' || !orgId) return fallback
  try {
    const raw = localStorage.getItem(OPENING_PREFIX + orgId)
    if (!raw) return fallback
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

export function saveOpeningBalances(orgId: string, ob: OpeningBalances): void {
  if (typeof window === 'undefined' || !orgId) return
  try {
    localStorage.setItem(OPENING_PREFIX + orgId, JSON.stringify(ob))
  } catch {
    /* non-critical */
  }
}

export function currentFY(): { start: string; end: string; label: string } {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  const fyStart = month >= 3 ? year : year - 1
  return {
    start: `${fyStart}-04-01`,
    end: `${fyStart + 1}-03-31`,
    label: `FY ${fyStart}-${String(fyStart + 1).slice(2)}`,
  }
}
