import { computeAgeing } from '@/lib/reports'
import { formatDateIN } from '@/lib/format'

export type PartyKind = 'customer' | 'vendor'

export interface Party {
  id: string
  name: string
  kind: PartyKind
  gstin?: string | null
  phone?: string | null
  email?: string | null
}

export type DocType = 'invoice' | 'credit_note' | 'debit_note' | 'bill' | 'payment'

export interface LedgerDoc {
  date: string
  partyName: string
  type: DocType
  /** What the line is called on the statement. */
  particulars: string
  docNumber: string
  /** Positive = the party owes us more. */
  debit: number
  /** Positive = the party owes us less (or we pay them). */
  credit: number
  /** Outstanding on the underlying document, for ageing. */
  balanceDue?: number
  dueDate?: string | null
  href?: string
}

export interface PartySummary {
  party: Party
  docs: LedgerDoc[]
  balance: number
  totalDebit: number
  totalCredit: number
  activityCount: number
  lastActivity: string | null
  overdue: number
  oldestDays: number
}

export interface StatementRow extends LedgerDoc {
  debitAmount: number
  creditAmount: number
  running: number
}

const norm = (s?: string | null) => (s || '').trim().toLowerCase()

/**
 * Payments are stored against a party *name*, not a party id, so documents are
 * grouped by id when present and by normalised "kind|name" otherwise. That key
 * is what links a payment back to its ledger.
 */
export function partyKey(kind: PartyKind, id?: string | null, name?: string | null) {
  return id ? `${kind}#${id}` : `${kind}@${norm(name)}`
}

export function buildLedger(input: {
  invoices: any[]
  bills: any[]
  creditNotes: any[]
  debitNotes: any[]
  payments: any[]
  customers: any[]
  vendors: any[]
  /** Ids of documents cancelled after payments may have been recorded. */
  voidedInvoiceIds?: string[]
  voidedBillIds?: string[]
}): Map<string, LedgerDoc[]> {
  const { invoices, bills, creditNotes, debitNotes, payments, customers, vendors } = input
  const voided = new Set([...(input.voidedInvoiceIds || []), ...(input.voidedBillIds || [])])

  const customerById = new Map(customers.map(c => [c.id, c]))
  const vendorById = new Map(vendors.map(v => [v.id, v]))
  const invoiceById = new Map(invoices.map(i => [i.id, i]))
  const billById = new Map(bills.map(b => [b.id, b]))

  const nameKeyFor = (kind: PartyKind, id: string | null | undefined, name: string | null | undefined) => {
    const master = kind === 'customer' ? customerById.get(id || '') : vendorById.get(id || '')
    return partyKey(kind, id, name || (master as any)?.name)
  }

  const out = new Map<string, LedgerDoc[]>()
  const push = (key: string, doc: LedgerDoc) => {
    const list = out.get(key)
    if (list) list.push(doc)
    else out.set(key, [doc])
  }

  for (const inv of invoices) {
    const name = inv.customer_name || customerById.get(inv.customer_id)?.name || 'Cash customer'
    push(nameKeyFor('customer', inv.customer_id, inv.customer_name), {
      date: inv.invoice_date,
      partyName: name,
      type: 'invoice',
      particulars: 'Sales invoice',
      docNumber: inv.invoice_number,
      debit: Number(inv.grand_total || 0),
      credit: 0,
      balanceDue: Number(inv.balance_due || 0),
      dueDate: inv.due_date || null,
      href: `/invoices/${inv.id}`,
    })
  }

  for (const cn of creditNotes) {
    if (cn.status === 'cancelled') continue
    push(nameKeyFor('customer', cn.customer_id, cn.customer_name), {
      date: cn.credit_note_date,
      partyName: cn.customer_name || customerById.get(cn.customer_id)?.name || 'Customer',
      type: 'credit_note',
      particulars: `Credit note${cn.reason ? ` — ${cn.reason}` : ''}`,
      docNumber: cn.credit_note_number,
      debit: 0,
      credit: Number(cn.grand_total || 0),
      href: '/credit-notes',
    })
  }

  for (const bill of bills) {
    push(nameKeyFor('vendor', bill.vendor_id, bill.vendor_name), {
      date: bill.bill_date,
      partyName: bill.vendor_name || vendorById.get(bill.vendor_id)?.name || 'Vendor',
      type: 'bill',
      particulars: 'Purchase bill',
      docNumber: bill.bill_number,
      debit: 0,
      credit: Number(bill.grand_total || 0),
      balanceDue: Number(bill.balance_due || 0),
      dueDate: bill.due_date || null,
      href: '/bills',
    })
  }

  for (const dn of debitNotes) {
    if (dn.status === 'cancelled') continue
    push(nameKeyFor('vendor', dn.vendor_id, dn.vendor_name), {
      date: dn.debit_note_date,
      partyName: dn.vendor_name || vendorById.get(dn.vendor_id)?.name || 'Vendor',
      type: 'debit_note',
      particulars: `Debit note${dn.reason ? ` — ${dn.reason}` : ''}`,
      docNumber: dn.debit_note_number,
      debit: Number(dn.grand_total || 0),
      credit: 0,
      href: '/debit-notes',
    })
  }

  for (const p of payments) {
    // A payment against a cancelled document is not a settlement — skip it so
    // the party is not shown as overpaid.
    if ((p.invoice_id && voided.has(p.invoice_id)) || (p.bill_id && voided.has(p.bill_id))) continue
    if (p.invoice_id && !invoiceById.get(p.invoice_id) && !p.bill_id) continue
    const inv = p.invoice_id ? invoiceById.get(p.invoice_id) : null
    const bill = p.bill_id ? billById.get(p.bill_id) : null
    const kind: PartyKind = inv ? 'customer' : bill ? 'vendor' : p.party_type === 'vendor' ? 'vendor' : 'customer'
    const id = inv?.customer_id ?? bill?.vendor_id ?? null
    const amount = Number(p.amount || 0)
    push(nameKeyFor(kind, id, p.party_name), {
      date: p.payment_date,
      partyName:
        (kind === 'customer' ? inv?.customer_name : bill?.vendor_name) ||
        p.party_name || 'Party',
      type: 'payment',
      particulars: `${kind === 'customer' ? 'Payment received' : 'Payment made'}${p.payment_mode ? ` · ${p.payment_mode}` : ''}${p.notes === 'Counter sale' ? ' · counter sale' : ''}`,
      docNumber: p.reference_number || (inv?.invoice_number ?? bill?.bill_number ?? '—'),
      debit: kind === 'vendor' ? amount : 0,
      credit: kind === 'customer' ? amount : 0,
      href: '/payments',
    })
  }

  return out
}

/** Every party that appears in the ledger, plus the masters we know about. */
export function summariseParties(
  ledger: Map<string, LedgerDoc[]>,
  input: { customers: any[]; vendors: any[] },
  asOf: Date = new Date(),
): PartySummary[] {
  const known = new Map<string, Party>()
  for (const c of input.customers) known.set(partyKey('customer', c.id, c.name), toParty(c, 'customer'))
  for (const v of input.vendors) known.set(partyKey('vendor', v.id, v.name), toParty(v, 'vendor'))

  const summaries: PartySummary[] = []
  for (const [key, docs] of ledger) {
    const sorted = [...docs].sort((a, b) => a.date.localeCompare(b.date))
    const balance = sorted.reduce((s, d) => s + d.debit - d.credit, 0)
    const [kind] = key.split(/[#@]/)

    const receivables = sorted.filter(d => (d.balanceDue || 0) > 0 && kind === 'customer')
      .map(d => ({ amount: d.balanceDue || 0, due: d.dueDate, issued: d.date }))
    const payables = sorted.filter(d => (d.balanceDue || 0) > 0 && kind === 'vendor')
      .map(d => ({ amount: d.balanceDue || 0, due: d.dueDate, issued: d.date }))
    const ageing = computeAgeing(kind === 'customer' ? receivables : payables, asOf)

    const overdueDocs = sorted.filter(d => {
      if (!(d.balanceDue || 0) || !d.dueDate) return false
      return new Date(d.dueDate) < asOf
    })

    summaries.push({
      party: known.get(key) ?? {
        id: key,
        name: sorted[0]?.partyName || 'Unnamed party',
        kind: kind as PartyKind,
      },
      docs: sorted,
      balance,
      totalDebit: sorted.reduce((s, d) => s + d.debit, 0),
      totalCredit: sorted.reduce((s, d) => s + d.credit, 0),
      activityCount: sorted.length,
      lastActivity: sorted.length ? sorted[sorted.length - 1].date : null,
      overdue: ageing.overdue,
      oldestDays: overdueDocs.length
        ? Math.max(...overdueDocs.map(d => Math.floor((asOf.getTime() - new Date(d.dueDate!).getTime()) / 86400000)))
        : 0,
    })
  }

  return summaries.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance))
}

function toParty(row: any, kind: PartyKind): Party {
  return {
    id: row.id,
    name: row.name,
    kind,
    gstin: row.gstin || null,
    phone: row.phone || null,
    email: row.email || null,
  }
}

export interface Statement {
  opening: number
  rows: StatementRow[]
  totalDebit: number
  totalCredit: number
  closing: number
}

/** Running-balance statement for one party between two dates (inclusive). */
export function buildStatement(docs: LedgerDoc[], from?: string, to?: string): Statement {
  const before = docs.filter(d => (from ? d.date < from : false))
  const inRange = docs.filter(d => (!from || d.date >= from) && (!to || d.date <= to))

  const opening = before.reduce((s, d) => s + d.debit - d.credit, 0)
  let running = opening
  const rows = inRange.map(d => {
    running = running + d.debit - d.credit
    return { ...d, debitAmount: d.debit, creditAmount: d.credit, running }
  })

  return {
    opening,
    rows,
    totalDebit: inRange.reduce((s, d) => s + d.debit, 0),
    totalCredit: inRange.reduce((s, d) => s + d.credit, 0),
    closing: running,
  }
}

/** Excel-openable statement; Indian numbers are quoted so ₹ and commas survive. */
export function statementToCsv(
  party: Party,
  statement: Statement,
  meta: { from?: string; to?: string; business: string; gstin?: string },
): string {
  const q = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const money = (v: number) => v.toFixed(2)
  const lines = [
    q(`Statement of Account — ${party.name}`),
    q(`Business,${meta.business}`),
    q(`GSTIN,${meta.gstin || ''}`),
    q(`Period,${meta.from || 'start'} to ${meta.to || 'today'}`),
    '',
    ['Date', 'Particulars', 'Document', 'Debit', 'Credit', 'Balance'].map(q).join(','),
    q(`${meta.from ? formatDateIN(meta.from) : 'Opening'},Opening balance,,${money(Math.max(0, statement.opening))},${money(Math.max(0, -statement.opening))},${money(statement.opening)}`),
    ...statement.rows.map(r =>
      [formatDateIN(r.date), r.particulars, r.docNumber, money(r.debitAmount), money(r.creditAmount), money(r.running)]
        .map(q).join(',')),
    '',
    q(`Total,,,${money(statement.totalDebit)},${money(statement.totalCredit)},${money(statement.closing)}`),
  ]
  return lines.join('\n')
}

export function download(filename: string, csv: string) {
  const blob = new Blob([`${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
