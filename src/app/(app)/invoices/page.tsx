'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { Badge, Button, EmptyState, PageHeader, SearchInput, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

interface InvoiceRow {
  id: string
  invoice_number: string
  customer_name: string | null
  customer_gstin: string | null
  invoice_date: string | null
  due_date: string | null
  supply_type: string | null
  taxable_amount: number | string | null
  grand_total: number | string | null
  amount_paid: number | string | null
  balance_due: number | string | null
  status: string | null
  payment_status: string | null
}

const STATUS_TONE: Record<string, 'grey' | 'blue' | 'red'> = {
  draft: 'grey', sent: 'blue', cancelled: 'red',
}
const PAYMENT_TONE: Record<string, 'green' | 'amber' | 'red'> = {
  paid: 'green', partial: 'amber', unpaid: 'red',
}

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number | string | null | undefined) => inr.format(num(v))

const VIEWS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'unpaid', label: 'To collect' },
  { value: 'cancelled', label: 'Cancelled' },
]

function InvoicesPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const [invoices, setInvoices] = useState<InvoiceRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [view, setView] = useState('all')
  const [search, setSearch] = useSearchDeepLink()

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

      const { data, error: loadError } = await supabase
        .from('invoices')
        .select('id, invoice_number, customer_name, customer_gstin, invoice_date, due_date, supply_type, taxable_amount, grand_total, amount_paid, balance_due, status, payment_status')
        .eq('organization_id', membership.organization_id)
        .order('invoice_date', { ascending: false })
        .order('created_at', { ascending: false })

      if (loadError) setError(loadError.message)
      setInvoices((data as InvoiceRow[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  const summary = useMemo(() => {
    const live = invoices.filter(i => i.status !== 'cancelled')
    const drafts = invoices.filter(i => i.status === 'draft')
    const outstanding = live
      .filter(i => i.payment_status !== 'paid')
      .reduce((sum, i) => sum + num(i.balance_due), 0)
    return {
      billed: live.reduce((sum, i) => sum + num(i.grand_total), 0),
      outstanding,
      drafts: drafts.length,
      open: live.filter(i => i.payment_status !== 'paid').length,
    }
  }, [invoices])

  const visible = useMemo(() => invoices.filter(i => {
    if (view === 'draft' || view === 'sent' || view === 'cancelled') {
      if (i.status !== view) return false
    } else if (view === 'unpaid') {
      if (i.status === 'cancelled' || i.payment_status === 'paid') return false
    }
    return matchesAny(search, [i.invoice_number, i.customer_name, i.customer_gstin])
  }), [invoices, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your invoices…</div>
  }

  return (
    <div className="page-container iv" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Sales"
        title="Invoices"
        subtitle={`${invoices.length} invoice${invoices.length === 1 ? '' : 's'} in this account. Every document opens for print, PDF and reminders.`}
        actions={
          <Button size="sm" icon="plus" onClick={() => router.push('/invoices/new')}>New invoice</Button>
        }
      />

      {error && (
        <div className="iv-alert iv-alert-red"><Icon name="alert" size={14} />{error}</div>
      )}

      <div className="iv-stats">
        <StatCard label="Billed" value={money(summary.billed)} sub="excluding cancelled" icon="invoice" tone="blue" delay={0} />
        <StatCard label="To collect" value={money(summary.outstanding)} sub={`${plural(summary.open, 'invoice')} not fully paid`} icon="swap" tone="amber" delay={40} href="/payments" />
        <StatCard label="Draft" value={String(summary.drafts)} sub="not issued yet" icon="clipboard" tone="grey" delay={80} />
        <StatCard label="Documents" value={String(invoices.length)} sub="in this browser's organisation" icon="book" tone="cyan" delay={120} />
      </div>

      <div className="iv-toolbar">
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Invoice number, customer or GSTIN…"
          ariaLabel="Search invoices"
          style={{ flex: '1 1 240px', maxWidth: 360 }}
        />
        <span className="iv-count">{visible.length} of {invoices.length} shown</span>
      </div>

      {visible.length === 0 ? (
        <div className="iv-panel">
          <EmptyState
            icon={invoices.length ? 'search' : 'invoice'}
            title={invoices.length
              ? (search ? `Nothing matches “${search}”`
                : view === 'all' ? 'No invoices in this slice'
                : `No ${(VIEWS.find(v => v.value === view)?.label || view).toLowerCase()} invoices`)
              : 'No invoices yet'}
            message={invoices.length
              ? 'Clear the search or pick another filter to see the rest.'
              : 'The first GST invoice you raise appears here with its collection status.'}
            action={!invoices.length ? (
              <Button size="sm" icon="plus" onClick={() => router.push('/invoices/new')}>Create invoice</Button>
            ) : undefined}
          />
        </div>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header iv-row iv-head">
              <span data-label="Invoice">Invoice</span>
              <span data-label="Customer">Customer</span>
              <span data-label="Date">Date</span>
              <span className="iv-right" data-label="Amount">Amount</span>
              <span data-label="Status">Status</span>
              <span className="iv-right" data-label="Payment">Payment</span>
            </div>
            {visible.map(inv => (
              <div key={inv.id} className={`table-row iv-row ${inv.status === 'cancelled' ? 'iv-dim' : ''}`}
                onClick={() => router.push(`/invoices/${inv.id}`)}>
                <span data-label="Invoice" className="iv-number">{inv.invoice_number}</span>

                <span data-label="Customer" className="iv-party">
                  <span className="iv-party-name">{inv.customer_name || '—'}</span>
                  <span className="iv-party-sub">{inv.customer_gstin || (inv.supply_type === 'b2c' ? 'B2C · walk-in' : (inv.supply_type || '').toUpperCase())}</span>
                </span>

                <span data-label="Date" className="iv-date">
                  {inv.invoice_date ? formatDateIN(inv.invoice_date) : '—'}
                  {inv.payment_status !== 'paid' && inv.due_date && (
                    <em className="iv-due">due {formatDateIN(inv.due_date)}</em>
                  )}
                </span>

                <span className="iv-right iv-amount">
                  <span data-label="Amount" className="tf-num">{money(inv.grand_total)}</span>
                  <span className="iv-party-sub">taxable {money(inv.taxable_amount)}</span>
                </span>

                <span data-label="Status">
                  <Badge tone={STATUS_TONE[inv.status ?? 'draft'] ?? 'grey'} dot={false}>
                    {inv.status === 'draft' ? 'Draft' : inv.status === 'sent' ? 'Sent' : inv.status === 'cancelled' ? 'Cancelled' : (inv.status || '').toUpperCase()}
                  </Badge>
                </span>

                <span className="iv-right" data-label="Payment">
                  <Badge tone={PAYMENT_TONE[inv.payment_status ?? 'unpaid'] ?? 'red'} dot={false}>
                    {inv.payment_status === 'paid' ? 'Paid' : inv.payment_status === 'partial' ? 'Part paid' : 'Unpaid'}
                  </Badge>
                  {inv.payment_status !== 'paid' && inv.status !== 'cancelled' && (
                    <div className="iv-party-sub">{money(inv.balance_due)} due</div>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="iv-foot">
        <span>Amounts are shown in whole rupees; a document always carries its paise.</span>
        <span>Cancelled invoices stay in the list — they never disappear from a statutory record.</span>
      </div>

      <style>{`
        .iv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .iv-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .iv-alert-red { background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }

        .iv-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .iv-count { font-size: 11.5px; color: var(--faint); margin-left: auto; }
        .iv-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-lg); }

        .iv-row { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.5fr) 104px minmax(0, 0.95fr) 92px minmax(0, 0.95fr);
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; cursor: pointer; }
        .iv-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px; font-weight: 650;
          color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; cursor: default; }
        .iv-row:hover { background: var(--surface-2); }
        .iv-right { text-align: right; }
        .iv-number { font-weight: 650; color: var(--brand-dark); }
        .iv-party { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .iv-party-name { color: var(--ink); overflow-wrap: anywhere; }
        .iv-party-sub { font-size: 11px; color: var(--faint); }
        .iv-date { display: flex; flex-direction: column; gap: 2px; color: var(--ink-2); font-weight: 600; }
        .iv-due { font-style: normal; font-size: 10.5px; font-weight: 500; color: var(--amber); }
        .iv-amount { display: flex; flex-direction: column; gap: 2px; }
        .iv-amount .tf-num { font-weight: 650; color: var(--ink); }
        .iv-dim { opacity: 0.55; }

        .iv-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--faint); margin-top: 10px; }

        @media (max-width: 1100px) { .iv-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .iv-row { grid-template-columns: 1fr; gap: 6px; padding: 13px 14px; }
          .iv-head { display: none; }
          .iv-right { text-align: left; }
          .iv-amount { flex-direction: row; gap: 10px; align-items: baseline; justify-content: space-between; }
          .iv-count { margin-left: 0; }
        }
      `}</style>
    </div>
  )
}

export default function InvoicesPage() {
  return (
    <Suspense fallback={<div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>}>
      <InvoicesPageInner />
    </Suspense>
  )
}
