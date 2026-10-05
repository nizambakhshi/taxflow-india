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

export interface OpeningBalances {
  cash: number
  fixedAssets: number
  loans: number
  capital: number
}

const EMPTY_OPENING: OpeningBalances = { cash: 0, fixedAssets: 0, loans: 0, capital: 0 }

// ── Profit & Loss ────────────────────────────────────────
export interface ProfitLoss {
  revenue: number
  purchases: number
  grossProfit: number
  expensesByCategory: { label: string; amount: number }[]
  totalExpenses: number
  netProfit: number
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

  const expensesByCategory = Object.entries(byCategory)
    .map(([label, amount]) => ({ label, amount }))
    .sort((a, b) => b.amount - a.amount)

  const grossProfit = revenue - purchases
  const netProfit = grossProfit - totalExpenses

  return { revenue, purchases, grossProfit, expensesByCategory, totalExpenses, netProfit }
}

// ── Balance Sheet ────────────────────────────────────────
export interface BalanceSheet {
  asOf: string
  receivables: number
  inventory: number
  cash: number
  fixedAssets: number
  totalAssets: number
  payables: number
  outstandingExpenses: number
  gstLiability: number
  loans: number
  totalLiabilities: number
  ownersFunds: number
  openingCapital: number
  retainedEarnings: number
  balancingReserve: number
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
}

export function computeBalanceSheet(input: BalanceSheetInput, asOf: string): BalanceSheet {
  const { invoices, bills, expenses, payments, products } = input
  const opening = input.opening || EMPTY_OPENING

  // Assets
  let receivables = 0
  for (const i of invoices) {
    if (i.status !== 'cancelled' && onOrBefore(i.invoice_date, asOf)) receivables += num(i.balance_due)
  }

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
  const cash = opening.cash + cashIn - cashOut - expensesPaid
  const fixedAssets = opening.fixedAssets

  const totalAssets = receivables + inventory + cash + fixedAssets

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

  const gstLiability = Math.max(0, outputTax - inputTax)
  const payables = billPayables
  const outstandingExpenses = expensesOutstanding
  const loans = opening.loans

  const totalLiabilities = payables + outstandingExpenses + gstLiability + loans

  // Owner's funds = assets − liabilities (balances by construction)
  const ownersFunds = totalAssets - totalLiabilities
  const retainedEarnings = input.cumulativeNetProfit
  const balancingReserve = ownersFunds - opening.capital - retainedEarnings

  return {
    asOf,
    receivables, inventory, cash, fixedAssets, totalAssets,
    payables, outstandingExpenses, gstLiability, loans, totalLiabilities,
    ownersFunds,
    openingCapital: opening.capital,
    retainedEarnings,
    balancingReserve,
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
