'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { formatDateIN } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard } from '@/components/ui'
import SealNotice from '@/components/SealNotice'
import { askSeal } from '@/lib/audit'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'

type InvoiceRow = {
  id: string
  invoice_number: string
  customer_id: string | null
  customer_name: string
  grand_total: number | string
  balance_due: number | string
  amount_paid: number | string
  invoice_date: string
  due_date: string | null
  status: string | null
  payment_status: string | null
  organization_id: string
}

type BillRow = {
  id: string
  bill_number: string
  vendor_id: string | null
  vendor_name: string
  grand_total: number | string
  balance_due: number | string
  amount_paid: number | string
  bill_date: string
  due_date: string | null
  organization_id: string
}

type PaymentRow = {
  id: string
  invoice_id: string | null
  bill_id: string | null
  party_name: string | null
  party_type: 'customer' | 'vendor'
  amount: number | string
  payment_date: string
  payment_mode: string | null
  payment_type: 'received' | 'made'
  reference_number: string | null
  notes: string | null
}

type Document = InvoiceRow | BillRow

/** One shape for both sides of the money, so receivables and payables share a table. */
type Outstanding = {
  kind: 'invoice' | 'bill'
  id: string
  docNumber: string
  party: string
  issued: string
  due: string | null
  total: number
  balance: number
  draft: boolean
  doc: Document
}

const TABS = [
  { value: 'receivables', label: 'To receive' },
  { value: 'payables', label: 'To pay' },
  { value: 'history', label: 'Recorded' },
]

const MODES = ['Bank Transfer', 'Cash', 'UPI', 'Credit Card', 'Debit Card', 'Cheque']

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number | string | null | undefined) => inr0.format(num(v))

/** Days past the due date; documents without one are measured from their own date. */
function daysPastDue(dueDate: string | null, issued: string): number {
  const target = new Date(dueDate || issued)
  target.setHours(0, 0, 0, 0)
  return Math.floor((Date.now() - target.getTime()) / 86400000)
}

function ageBadge(daysPastDue: number): { label: string; tone: 'green' | 'amber' | 'red' } {
  if (daysPastDue <= 0) return { label: 'Not due', tone: 'green' }
  if (daysPastDue <= 30) return { label: `${daysPastDue}d overdue`, tone: 'amber' }
  if (daysPastDue <= 60) return { label: `${daysPastDue}d overdue`, tone: 'amber' }
  return { label: `${daysPastDue}d overdue`, tone: 'red' }
}

const asReceivable = (r: InvoiceRow): Outstanding => ({
  kind: 'invoice', id: r.id, docNumber: r.invoice_number, party: r.customer_name,
  issued: r.invoice_date, due: r.due_date ?? null, total: num(r.grand_total),
  balance: num(r.balance_due), draft: r.status === 'draft', doc: r,
})

const asPayable = (r: BillRow): Outstanding => ({
  kind: 'bill', id: r.id, docNumber: r.bill_number, party: r.vendor_name,
  issued: r.bill_date, due: r.due_date ?? null, total: num(r.grand_total),
  balance: num(r.balance_due), draft: false, doc: r,
})

function isThisMonth(value: string): boolean {
  const d = new Date(value)
  const now = new Date()
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
}

function PaymentsPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [bills, setBills] = useState<BillRow[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [docNumbers, setDocNumbers] = useState<Record<string, string>>({})
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [tab, setTab] = useState('receivables')
  const [search, setSearch] = useSearchDeepLink()

  // Payment form
  const [showPaymentForm, setShowPaymentForm] = useState(false)
  const [selectedInvoice, setSelectedInvoice] = useState<InvoiceRow | null>(null)
  const [selectedBill, setSelectedBill] = useState<BillRow | null>(null)
  const [paymentAmount, setPaymentAmount] = useState('')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [paymentMode, setPaymentMode] = useState('Bank Transfer')
  const [referenceNumber, setReferenceNumber] = useState('')
  const [paymentNotes, setPaymentNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)

      await loadData(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function loadData(oid: string) {
    const [invResult, billResult, payResult] = await Promise.all([
      supabase
        .from('invoices')
        .select('id, invoice_number, customer_id, customer_name, grand_total, balance_due, amount_paid, invoice_date, due_date, status, payment_status, organization_id')
        .eq('organization_id', oid)
        .in('payment_status', ['unpaid', 'partial'])
        .neq('status', 'cancelled')
        .order('due_date', { ascending: true }),
      supabase
        .from('purchase_bills')
        .select('id, bill_number, vendor_id, vendor_name, grand_total, balance_due, amount_paid, bill_date, due_date, organization_id')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .in('payment_status', ['unpaid', 'partial'])
        .order('due_date', { ascending: true }),
      supabase
        .from('payments')
        .select('*')
        .eq('organization_id', oid)
        .order('payment_date', { ascending: false })
        .limit(500),
    ])

    if (invResult.error || billResult.error || payResult.error) {
      setLoadError(invResult.error?.message ?? billResult.error?.message ?? payResult.error?.message ?? '')
    }

    const invData = (invResult.data as InvoiceRow[]) || []
    const billData = (billResult.data as BillRow[]) || []
    const payData = (payResult.data as PaymentRow[]) || []

    setInvoices(invData)
    setBills(billData)
    setPayments(payData)
    setDocNumbers(await fetchDocumentNumbers(oid, payData))
  }

  /**
   * The two lists above only hold unpaid documents, so a payment that already
   * settled an invoice needs its number looked up by id — chunked because
   * Supabase rejects an oversized `in=(…)`.
   */
  async function fetchDocumentNumbers(oid: string, rows: PaymentRow[]): Promise<Record<string, string>> {
    const invoiceIds = [...new Set(rows.map(p => p.invoice_id).filter(Boolean))] as string[]
    const billIds = [...new Set(rows.map(p => p.bill_id).filter(Boolean))] as string[]

    const gather = async (
      table: 'invoices' | 'purchase_bills',
      column: 'invoice_number' | 'bill_number',
      ids: string[],
    ) => {
      const out: Record<string, string> = {}
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await supabase
          .from(table)
          .select(`id, ${column}`)
          .eq('organization_id', oid)
          .in('id', ids.slice(i, i + 500))
        for (const row of (data || []) as ({ id: string } & Record<string, unknown>)[]) {
          out[row.id] = String(row[column] ?? '')
        }
      }
      return out
    }

    const [invNumbers, billNumbers] = await Promise.all([
      gather('invoices', 'invoice_number', invoiceIds),
      gather('purchase_bills', 'bill_number', billIds),
    ])
    return { ...invNumbers, ...billNumbers }
  }

  function openPaymentForm(invoice?: InvoiceRow, bill?: BillRow) {
    setSelectedInvoice(invoice || null)
    setSelectedBill(bill || null)
    setPaymentAmount(
      invoice ? String(invoice.balance_due) :
      bill ? String(bill.balance_due) : ''
    )
    setPaymentDate(new Date().toISOString().split('T')[0])
    setPaymentMode('Bank Transfer')
    setReferenceNumber('')
    setPaymentNotes('')
    setError('')
    setShowPaymentForm(true)
  }

  async function handleRecordPayment() {
    const amount = parseFloat(paymentAmount)
    if (!amount || amount <= 0) {
      setError('Please enter a valid amount')
      return
    }

    const maxAmount = num(selectedInvoice?.balance_due ?? selectedBill?.balance_due ?? 0)

    if (amount > maxAmount) {
      setError(`Amount cannot exceed balance due of ₹${formatINR(maxAmount)}`)
      return
    }

    // A payment is money on a date, so the seal is asked for that date. It is deliberately *not*
    // asked for the date of the document being settled: collecting a March invoice in October is
    // trading, not re-typing history — the invoice itself is untouched, and a seal that stopped a
    // shop from recording a real receipt would be a lock on the till, not on the books.
    const stop = askSeal(orgId, {
      date: paymentDate,
      target: 'payment',
      ref: (selectedInvoice?.invoice_number ?? selectedBill?.bill_number ?? referenceNumber) as string,
    })
    if (stop) {
      setError(stop.why)
      return
    }

    setSaving(true)
    setError('')

    try {
      // Record payment
      await supabase.from('payments').insert({
        organization_id: orgId,
        payment_date: paymentDate,
        payment_type: selectedInvoice ? 'received' : 'made',
        payment_mode: paymentMode,
        invoice_id: selectedInvoice?.id || null,
        bill_id: selectedBill?.id || null,
        party_name: selectedInvoice?.customer_name || selectedBill?.vendor_name,
        party_type: selectedInvoice ? 'customer' : 'vendor',
        amount,
        reference_number: referenceNumber,
        notes: paymentNotes,
      })

      // Update invoice or bill
      if (selectedInvoice) {
        const newPaid = Number(selectedInvoice.amount_paid) + amount
        const newBalance = Number(selectedInvoice.grand_total) - newPaid
        const newStatus = newBalance <= 0 ? 'paid' : 'partial'

        await supabase
          .from('invoices')
          .update({
            amount_paid: newPaid,
            balance_due: Math.max(0, newBalance),
            payment_status: newStatus,
          })
          .eq('id', selectedInvoice.id)
      }

      if (selectedBill) {
        const newPaid = Number(selectedBill.amount_paid) + amount
        const newBalance = Number(selectedBill.grand_total) - newPaid
        const newStatus = newBalance <= 0 ? 'paid' : 'partial'

        await supabase
          .from('purchase_bills')
          .update({
            amount_paid: newPaid,
            balance_due: Math.max(0, newBalance),
            payment_status: newStatus,
          })
          .eq('id', selectedBill.id)
      }

      await loadData(orgId)
      setShowPaymentForm(false)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to record payment')
    } finally {
      setSaving(false)
    }
  }

  const receivables = useMemo(() => invoices.map(asReceivable), [invoices])
  const payables = useMemo(() => bills.map(asPayable), [bills])

  const summary = useMemo(() => {
    const overdue = receivables.filter(r => daysPastDue(r.due, r.issued) > 0)
    return {
      toReceive: receivables.reduce((s, r) => s + r.balance, 0),
      toPay: payables.reduce((s, r) => s + r.balance, 0),
      overdue: overdue.reduce((s, r) => s + r.balance, 0),
      overdueCount: overdue.length,
      drafts: receivables.filter(r => r.draft).length,
      collectedThisMonth: payments
        .filter(p => p.payment_type === 'received' && isThisMonth(p.payment_date))
        .reduce((s, p) => s + num(p.amount), 0),
      unlinked: payments.filter(p => !p.invoice_id && !p.bill_id).length,
    }
  }, [payments, receivables, payables])

  const visibleOutstanding = useMemo(() => {
    const rows = tab === 'payables' ? payables : receivables
    return rows.filter(r => matchesAny(search, [r.docNumber, r.party]))
  }, [tab, receivables, payables, search])

  const visiblePayments = useMemo(
    () => payments.filter(p => matchesAny(search, [
      p.party_name,
      p.reference_number,
      p.payment_mode,
      p.notes,
      docNumbers[p.invoice_id ?? ''] || docNumbers[p.bill_id ?? ''],
    ])),
    [payments, search, docNumbers]
  )

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading what you owe and what is owed to you…</div>
  }

  const docBox = selectedInvoice || selectedBill

  return (
    <div className="page-container pm" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Money"
        title="Payments"
        subtitle="Money in and out, recorded against the document it settles. A payment here is what moves an invoice from unpaid to paid."
      />

      {loadError && (
        <div className="pm-alert"><Icon name="alert" size={14} />{loadError}</div>
      )}

      <div className="pm-stats">
        <StatCard label="To receive" value={money(summary.toReceive)}
          sub={`${receivables.length} invoice${receivables.length === 1 ? '' : 's'} outstanding`}
          icon="arrow-down" tone="blue" delay={0} />
        <StatCard label="Overdue" value={money(summary.overdue)}
          sub={summary.overdueCount ? `${summary.overdueCount} past the due date` : 'nothing past its due date'}
          icon="clock" tone={summary.overdueCount ? 'red' : 'grey'} delay={40} />
        <StatCard label="To pay" value={money(summary.toPay)}
          sub={`${payables.length} bill${payables.length === 1 ? '' : 's'} outstanding`}
          icon="arrow-up" tone="violet" delay={80} />
        <StatCard label="Not tied to a document" value={String(summary.unlinked)}
          sub={summary.unlinked ? 'cash in or out with no invoice or bill behind it' : `every payment settles a document · ${money(summary.collectedThisMonth)} collected this month`}
          icon="link" tone={summary.unlinked ? 'amber' : 'green'} delay={120} />
      </div>

      <div className="pm-toolbar">
        <Segmented options={TABS} value={tab} onChange={setTab} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={tab === 'history' ? 'Party, document, reference or mode…' : 'Document number or party…'}
          ariaLabel="Search payments"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {tab !== 'history' && (
        visibleOutstanding.length === 0 ? (
          (tab === 'payables' ? payables : receivables).length === 0 ? (
            <Card>
              <EmptyState
                icon="check"
                title={tab === 'receivables' ? 'Nothing to collect' : 'Nothing to pay'}
                message={tab === 'receivables'
                  ? 'Every invoice in this account is fully paid.'
                  : 'Every purchase bill in this account is fully paid.'}
                action={<Button size="sm" variant="subtle" href={tab === 'receivables' ? '/invoices' : '/bills'}>
                  {tab === 'receivables' ? 'Open invoices' : 'Open bills'}
                </Button>}
              />
            </Card>
          ) : (
            <Card>
              <EmptyState
                icon="search"
                title={`No document matches “${search}”`}
                message="Clear the search to see everything outstanding again."
                action={<Button size="sm" variant="subtle" onClick={() => setSearch('')}>Clear search</Button>}
              />
            </Card>
          )
        ) : (
          <div className="table-frame">
            <div className="responsive-table">
              <div className="table-header pm-row pm-head">
                <span data-label="Document">Document</span>
                <span data-label="Party">{tab === 'receivables' ? 'Customer' : 'Vendor'}</span>
                <span data-label="Due">Due</span>
                <span className="pm-right" data-label="Total">Total</span>
                <span className="pm-right" data-label="Balance">Balance due</span>
                <span data-label="Age">Age</span>
                <span className="pm-right" data-label="Action">Action</span>
              </div>
              {visibleOutstanding.map(row => {
                const age = ageBadge(daysPastDue(row.due, row.issued))
                return (
                  <div key={row.id} className={`table-row pm-row ${row.draft ? 'pm-dim' : ''}`}>
                    <span data-label="Document" className="pm-doc-cell">
                      <span className="pm-doc-number">{row.docNumber}</span>
                      {row.draft && <Badge tone="grey" dot={false}>Draft</Badge>}
                    </span>
                    <span data-label="Party" className="pm-party">{row.party}</span>
                    <span data-label="Due" className="pm-sub">{dueLabel(row)}</span>
                    <span className="pm-right" data-label="Total">{money(row.total)}</span>
                    <span className="pm-right pm-balance" data-label="Balance">{money(row.balance)}</span>
                    <span data-label="Age"><Badge tone={age.tone} dot={false}>{age.label}</Badge></span>
                    <span className="pm-right" data-label="Action">
                      <Button size="sm" onClick={() => row.kind === 'invoice'
                        ? openPaymentForm(row.doc as InvoiceRow)
                        : openPaymentForm(undefined, row.doc as BillRow)}>
                        Record payment
                      </Button>
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      )}

      {tab === 'history' && (
        visiblePayments.length === 0 ? (
          <Card>
            <EmptyState
              icon="clock"
              title={payments.length ? `No payment matches “${search}”` : 'No payments recorded yet'}
              message={payments.length
                ? 'Clear the search to see the whole payment history.'
                : 'Record a payment against an outstanding invoice or bill and it appears here.'}
              action={!payments.length ? (
                <Button size="sm" variant="subtle" onClick={() => setTab('receivables')}>See what to collect</Button>
              ) : undefined}
            />
          </Card>
        ) : (
          <div className="table-frame">
            <div className="responsive-table">
              <div className="table-header pm-row pm-row-history pm-head">
                <span data-label="Date">Date</span>
                <span data-label="Party">Party</span>
                <span data-label="Document">Settles</span>
                <span data-label="Mode">Mode</span>
                <span data-label="Type">Type</span>
                <span className="pm-right" data-label="Amount">Amount</span>
              </div>
              {visiblePayments.map(p => {
                const number = p.invoice_id ? docNumbers[p.invoice_id] : p.bill_id ? docNumbers[p.bill_id] : undefined
                return (
                  <div key={p.id} className="table-row pm-row pm-row-history">
                    <span data-label="Date" className="pm-sub">{formatDateIN(p.payment_date)}</span>
                    <span data-label="Party" className="pm-party">{p.party_name || '—'}</span>
                    <span data-label="Document" className={number ? 'pm-mono' : 'pm-flag'}>
                      {number || 'No document'}
                    </span>
                    <span data-label="Mode" className="pm-sub">{p.payment_mode || '—'}</span>
                    <span data-label="Type">
                      <Badge tone={p.payment_type === 'received' ? 'green' : 'violet'} dot={false}>
                        {p.payment_type === 'received' ? 'Received' : 'Made'}
                      </Badge>
                    </span>
                    <span className="pm-right pm-amount" data-label="Amount">{money(p.amount)}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )
      )}

      <div className="pm-foot">
        {tab !== 'history' && (
          <span>Shown: {visibleOutstanding.length} of {(tab === 'payables' ? payables : receivables).length}</span>
        )}
        {tab === 'receivables' && summary.drafts > 0 && (
          <span>{summary.drafts} of these {summary.drafts === 1 ? 'is a draft' : 'are drafts'} — collecting against a draft settles a document you have not issued yet.</span>
        )}
        {tab === 'history' && <span>Showing the last {Math.min(payments.length, 500)} payments.</span>}
        <span>A payment recorded here updates the balance on the document it is attached to; the invoice and bill lists stay the record of what is owed.</span>
      </div>

      {showPaymentForm && docBox && (
        <div className="pm-scrim" role="dialog" aria-modal="true" aria-label="Record payment">
          <div className="pm-modal">
            <div className="pm-modal-head">
              <h2>Record payment</h2>
              <button type="button" className="pm-close" onClick={() => setShowPaymentForm(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="pm-doc">
              <div className="pm-doc-title">
                <strong>{selectedInvoice ? `Invoice ${selectedInvoice.invoice_number}` : `Bill ${(selectedBill as BillRow).bill_number}`}</strong>
                <span>{selectedInvoice?.customer_name || (selectedBill as BillRow)?.vendor_name}</span>
              </div>
              <div className="pm-doc-figures">
                <span>Total <strong>{money(docBox.grand_total)}</strong></span>
                <span>Already paid <strong>{money(docBox.amount_paid)}</strong></span>
                <span className="pm-doc-balance">Balance <strong>{money(docBox.balance_due)}</strong></span>
              </div>
            </div>

            <div className="pm-grid">
              <label className="pm-field">
                <span>Payment date *</span>
                <input className="tf-input" type="date" value={paymentDate} onChange={e => setPaymentDate(e.target.value)} />
              </label>
              <label className="pm-field">
                <span>Amount (₹) *</span>
                <input className="tf-input" type="number" value={paymentAmount} min="0" step="0.01"
                  onChange={e => setPaymentAmount(e.target.value)} />
              </label>
            </div>
            <SealNotice orgId={orgId} date={paymentDate} />

            <div className="pm-grid">
              <label className="pm-field">
                <span>Payment mode</span>
                <select className="tf-input" value={paymentMode} onChange={e => setPaymentMode(e.target.value)}>
                  {MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="pm-field">
                <span>Reference no.</span>
                <input className="tf-input pm-mono-input" value={referenceNumber} placeholder="UTR / cheque / UPI ref"
                  onChange={e => setReferenceNumber(e.target.value)} />
              </label>
            </div>

            <label className="pm-field">
              <span>Notes</span>
              <input className="tf-input" value={paymentNotes} placeholder="Optional notes"
                onChange={e => setPaymentNotes(e.target.value)} />
            </label>

            {error && <div className="pm-alert"><Icon name="alert" size={14} />{error}</div>}

            <div className="pm-save">
              <Button variant="ghost" onClick={() => setShowPaymentForm(false)}>Cancel</Button>
              <Button onClick={handleRecordPayment} disabled={saving} icon={saving ? undefined : 'check'}>
                {saving ? 'Saving…' : 'Record payment'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .pm-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .pm-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .pm-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 10px; background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red); }

        .pm-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) 96px minmax(0, 0.8fr) minmax(0, 0.9fr) 92px 132px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .pm-row-history { grid-template-columns: 104px minmax(0, 1.4fr) minmax(0, 1fr) 108px 96px minmax(0, 0.8fr); }
        .pm-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .pm-right { text-align: right; }
        .pm-doc-cell { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .pm-doc-number { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .pm-party { color: var(--ink); overflow-wrap: anywhere; }
        .pm-sub { color: var(--muted); font-size: 12px; }
        .pm-mono { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--ink-2); overflow-wrap: anywhere; }
        .pm-balance { color: var(--red); font-weight: 650; }
        .pm-amount { color: var(--ink); font-weight: 650; }
        .pm-flag { font-size: 11.5px; color: var(--amber); }
        .pm-dim { opacity: 0.72; }

        .pm-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .pm-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .pm-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .pm-modal-head { display: flex; align-items: center; justify-content: space-between; }
        .pm-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .pm-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .pm-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .pm-doc { background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: var(--radius-sm);
          padding: 11px 13px; }
        .pm-doc-title { display: flex; flex-direction: column; gap: 2px; font-size: 13px; color: var(--ink-2); margin-bottom: 8px; }
        .pm-doc-title strong { color: var(--ink); }
        .pm-doc-figures { display: flex; gap: 16px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); }
        .pm-doc-figures strong { color: var(--ink-2); font-weight: 600; }
        .pm-doc-balance strong { color: var(--red); }
        .pm-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .pm-field { display: flex; flex-direction: column; gap: 4px; }
        .pm-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .pm-mono-input { font-family: ui-monospace, Menlo, monospace; letter-spacing: 0.03em; }
        .pm-save { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }

        @media (max-width: 1100px) { .pm-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .pm-row { grid-template-columns: 1fr; gap: 6px; }
          .pm-head { display: none; }
          .pm-right { text-align: left; }
          .pm-stats { grid-template-columns: 1fr 1fr; }
          .pm-grid { grid-template-columns: 1fr; }
          .pm-modal { padding: 1.1rem 1.15rem; }
          .pm-scrim { align-items: flex-end; padding: 0; }
          .pm-scrim .pm-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .pm-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

/** The due column says what it is: the due date, or the document date when there is none. */
function dueLabel(row: Outstanding): string {
  if (!row.due) return `${formatDateIN(row.issued)} · no due date`
  return formatDateIN(row.due)
}

export default function PaymentsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <PaymentsPageInner />
    </Suspense>
  )
}
