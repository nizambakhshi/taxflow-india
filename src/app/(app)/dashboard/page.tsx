'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR, getFinancialYear } from '@/lib/gst-engine'
import { computeAgeing } from '@/lib/reports'
import { changePct, formatDateIN, formatCompactINR } from '@/lib/format'
import {
  BarChart, Badge, Button, Card, EmptyState, PageHeader, ProgressBar,
  SectionTitle, StatCard, StatRow, StackedBar,
} from '@/components/ui'
import Icon from '@/components/Icons'
import Link from 'next/link'

function monthRange(monthsBack = 0) {
  const d = new Date()
  const start = new Date(d.getFullYear(), d.getMonth() - monthsBack, 1)
  const end = new Date(d.getFullYear(), d.getMonth() - monthsBack + 1, 0)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    label: start.toLocaleDateString('en-IN', { month: 'short' }),
    fullLabel: start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }),
  }
}

/** Statutory monthly due dates: GSTR-1 on the 11th, GSTR-3B on the 20th of the following month. */
function returnDueDate(monthsBack: number, day: number) {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth() - monthsBack, day)
}

interface Metrics {
  totalSales: number; prevSales: number
  totalPurchases: number; prevPurchases: number
  totalExpenses: number; prevExpenses: number
  gstCollected: number; itcAvailable: number; netGSTPayable: number
  collected: number
  totalReceivable: number; totalPayable: number
  overdueReceivable: number
  invoiceCount: number; customerCount: number
}

const ZERO: Metrics = {
  totalSales: 0, prevSales: 0, totalPurchases: 0, prevPurchases: 0,
  totalExpenses: 0, prevExpenses: 0, gstCollected: 0, itcAvailable: 0,
  netGSTPayable: 0, collected: 0, totalReceivable: 0, totalPayable: 0,
  overdueReceivable: 0, invoiceCount: 0, customerCount: 0,
}

export default function DashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgName, setOrgName] = useState('')
  const [orgId, setOrgId] = useState('')

  const [metrics, setMetrics] = useState<Metrics>(ZERO)
  const [recentInvoices, setRecentInvoices] = useState<any[]>([])
  const [gstReturns, setGstReturns] = useState<any[]>([])
  const [monthlySales, setMonthlySales] = useState<{ label: string; value: number }[]>([])
  const [arAgeing, setArAgeing] = useState(computeAgeing([]))
  const [apAgeing, setApAgeing] = useState(computeAgeing([]))

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }

      const org = membership.organizations as any
      setOrgName(org?.name || '')
      setOrgId(membership.organization_id)

      await loadDashboard(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function loadDashboard(oid: string) {
    const thisMonth = monthRange(0)
    const lastMonth = monthRange(1)

    const [inv, bill, exp, prevInv, prevBill, prevExp, unpaidInv, unpaidBills, recent, payments] =
      await Promise.all([
        supabase.from('invoices').select('*')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .gte('invoice_date', thisMonth.start).lte('invoice_date', thisMonth.end),
        supabase.from('purchase_bills').select('*')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .gte('bill_date', thisMonth.start).lte('bill_date', thisMonth.end),
        supabase.from('expenses').select('amount')
          .eq('organization_id', oid)
          .gte('expense_date', thisMonth.start).lte('expense_date', thisMonth.end),
        supabase.from('invoices').select('grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .gte('invoice_date', lastMonth.start).lte('invoice_date', lastMonth.end),
        supabase.from('purchase_bills').select('grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .gte('bill_date', lastMonth.start).lte('bill_date', lastMonth.end),
        supabase.from('expenses').select('amount')
          .eq('organization_id', oid)
          .gte('expense_date', lastMonth.start).lte('expense_date', lastMonth.end),
        supabase.from('invoices')
          .select('id, balance_due, invoice_date, due_date, customer_name')
          .eq('organization_id', oid)
          .in('payment_status', ['unpaid', 'partial']).neq('status', 'cancelled'),
        supabase.from('purchase_bills')
          .select('id, balance_due, bill_date, due_date, vendor_name')
          .eq('organization_id', oid)
          .in('payment_status', ['unpaid', 'partial']).neq('status', 'cancelled'),
        supabase.from('invoices').select('*')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .order('created_at', { ascending: false }).limit(6),
        supabase.from('payments').select('amount, payment_type, payment_date')
          .eq('organization_id', oid)
          .gte('payment_date', thisMonth.start).lte('payment_date', thisMonth.end),
      ])

    const { count: customerCount } = await supabase
      .from('customers').select('*', { count: 'exact', head: true })
      .eq('organization_id', oid).eq('is_active', true)

    const invList = inv.data || []
    const billList = bill.data || []

    const sum = (rows: any[] | null, key = 'grand_total') =>
      (rows || []).reduce((s, r) => s + Number(r[key] || 0), 0)

    const totalSales = sum(invList)
    const totalPurchases = sum(billList)
    const totalExpenses = sum(exp.data, 'amount')
    const gstCollected = sum(invList, 'total_tax')
    const itcAvailable = sum(billList.filter(b => b.itc_eligible), 'total_tax')
    const unpaidInvList = unpaidInv.data || []

    setMetrics({
      totalSales,
      prevSales: sum(prevInv.data),
      totalPurchases,
      prevPurchases: sum(prevBill.data),
      totalExpenses,
      prevExpenses: sum(prevExp.data, 'amount'),
      gstCollected,
      itcAvailable,
      netGSTPayable: Math.max(0, gstCollected - itcAvailable),
      collected: (payments.data || []).filter(p => p.payment_type === 'received').reduce((s, p) => s + Number(p.amount), 0),
      totalReceivable: sum(unpaidInvList, 'balance_due'),
      totalPayable: sum(unpaidBills.data, 'balance_due'),
      overdueReceivable: sum(
        unpaidInvList.filter(i => new Date(i.due_date || i.invoice_date) < new Date()),
        'balance_due'
      ),
      invoiceCount: invList.length,
      customerCount: customerCount || 0,
    })

    setArAgeing(computeAgeing(unpaidInvList.map(i => ({
      amount: Number(i.balance_due), due: i.due_date, issued: i.invoice_date,
    }))))
    setApAgeing(computeAgeing((unpaidBills.data || []).map(b => ({
      amount: Number(b.balance_due), due: b.due_date, issued: b.bill_date,
    }))))

    setRecentInvoices(recent.data || [])

    const salesByMonth = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const m = monthRange(5 - i)
        return supabase.from('invoices').select('grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled')
          .gte('invoice_date', m.start).lte('invoice_date', m.end)
          .then(({ data }) => ({ label: m.label, value: sum(data) }))
      })
    )
    setMonthlySales(salesByMonth)

    const filingPeriod = `${lastMonth.start.slice(0, 7)}`
    const { data: returns } = await supabase
      .from('gst_return_periods').select('*')
      .eq('organization_id', oid).eq('period', filingPeriod)

    setGstReturns([
      { type: 'GSTR1', label: 'GSTR-1', desc: 'Outward supplies', href: '/gst/gstr1', due: returnDueDate(0, 11), status: returns?.find(r => r.return_type === 'GSTR1')?.status || 'not_started' },
      { type: 'GSTR3B', label: 'GSTR-3B', desc: 'Summary + payment', href: '/gst/gstr3b', due: returnDueDate(0, 20), status: returns?.find(r => r.return_type === 'GSTR3B')?.status || 'not_started' },
    ])
  }

  if (loading) return <DashboardSkeleton />

  const monthLabel = monthRange(0).fullLabel
  const fy = getFinancialYear()
  const maxSales = Math.max(...monthlySales.map(m => m.value), 1)
  const salesDelta = changePct(metrics.totalSales, metrics.prevSales)
  const purchDelta = changePct(metrics.totalPurchases, metrics.prevPurchases)
  const expDelta = changePct(metrics.totalExpenses, metrics.prevExpenses)

  const quickActions = [
    { label: 'Counter sale', href: '/pos', icon: 'pos' },
    { label: 'Scan a bill', href: '/ai/scan-bill', icon: 'scan' },
    { label: 'Ask my books', href: '/ai/ask', icon: 'chat' },
    { label: 'Payment link', href: '/payments/links', icon: 'link' },
  ]

  return (
    <div className="page-container" style={{ maxWidth: 1240 }}>
      <PageHeader
        eyebrow={`Financial year ${fy}`}
        title={orgName || 'Your business'}
        subtitle={`${monthLabel} · ${metrics.invoiceCount} invoices · ${metrics.customerCount} active customers`}
        actions={<Button href="/invoices/new" icon="plus">New invoice</Button>}
        right={<Button href="/reports" variant="ghost" icon="chart" style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.25)' }}>Reports</Button>}
      />

      {/* Quick actions */}
      <div className="tf-row tf-wrap" style={{ marginBottom: '1.1rem', gap: 8 }}>
        {quickActions.map(a => (
          <Link key={a.href} href={a.href} className="tf-btn tf-btn-ghost tf-btn-sm" style={{ background: 'var(--surface)' }}>
            <Icon name={a.icon} size={14} /> {a.label}
          </Link>
        ))}
      </div>

      {/* KPI row */}
      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="Total sales" value={metrics.totalSales} icon="trend" tone="blue"
          sub={`Gross billed in ${monthRange(0).label}`} delta={salesDelta} delay={0} />
        <StatCard label="Purchases" value={metrics.totalPurchases} icon="cart" tone="violet"
          sub="Bills recorded" delta={purchDelta} delay={60} />
        <StatCard label="Expenses" value={metrics.totalExpenses} icon="wallet" tone="cyan"
          sub="Overheads" delta={expDelta} delay={120} />
        <StatCard label="Net GST payable" value={metrics.netGSTPayable} icon="landmark" tone="amber"
          sub={`Collected ${formatCompactINR(metrics.gstCollected)} · ITC ${formatCompactINR(metrics.itcAvailable)}`}
          href="/gst" delay={180} delta={null} />
      </div>

      {/* Sales trend + cash */}
      <div className="tf-g-2" style={{ marginBottom: '1rem' }}>
        <Card>
          <SectionTitle icon="chart" action={<Link href="/reports" className="tf-stat-sub" style={{ color: 'var(--brand)', textDecoration: 'none' }}>All reports →</Link>}>
            Sales — last 6 months
          </SectionTitle>
          <BarChart data={monthlySales} height={160} />
          <div className="tf-row-between" style={{ marginTop: 14, fontSize: 12, color: 'var(--muted)' }}>
            <span>Peak {formatCompactINR(maxSales)}</span>
            <span>Avg {formatCompactINR(monthlySales.reduce((s, m) => s + m.value, 0) / Math.max(monthlySales.length, 1))}/mo</span>
            <span style={{ color: 'var(--ink)', fontWeight: 600 }}>6-mo total {formatCompactINR(monthlySales.reduce((s, m) => s + m.value, 0))}</span>
          </div>
        </Card>

        <Card>
          <SectionTitle icon="swap" action={<Link href="/payments" style={{ color: 'var(--brand)', fontSize: 12, textDecoration: 'none' }}>Manage →</Link>}>
            Cash &amp; outstanding
          </SectionTitle>
          <StatRow label="Collected this month" value={`₹${formatINR(metrics.collected)}`} tone="green" />
          <StatRow label="To receive" value={`₹${formatINR(metrics.totalReceivable)}`} tone="blue" />
          <StatRow label="Of which overdue" value={`₹${formatINR(metrics.overdueReceivable)}`} tone="red" />
          <StatRow label="To pay" value={`₹${formatINR(metrics.totalPayable)}`} tone="amber" strong />
          <div style={{ marginTop: 14 }}>
            <div className="tf-eyebrow" style={{ marginBottom: 6 }}>Receivable ageing</div>
            <StackedBar segments={arAgeing.buckets.map(b => ({ label: b.label, value: b.amount, color: b.color }))} />
            <div className="tf-row tf-wrap" style={{ gap: 10, marginTop: 9, fontSize: 11, color: 'var(--muted)' }}>
              {arAgeing.buckets.filter(b => b.amount > 0).map(b => (
                <span key={b.label} className="tf-row" style={{ gap: 5 }}>
                  <i style={{ width: 8, height: 8, borderRadius: 99, background: b.color, display: 'inline-block' }} />
                  {b.label} · {formatCompactINR(b.amount)}
                </span>
              ))}
              {arAgeing.total === 0 && <span>Nothing outstanding.</span>}
            </div>
          </div>
        </Card>
      </div>

      {/* Compliance + payables */}
      <div className="tf-g-2" style={{ marginBottom: '1rem' }}>
        <Card>
          <SectionTitle icon="calendar" action={<Link href="/gst" style={{ color: 'var(--brand)', fontSize: 12, textDecoration: 'none' }}>GST →</Link>}>
            Returns due this month
          </SectionTitle>
          <div className="tf-col" style={{ gap: 10 }}>
            {gstReturns.map(r => {
              const days = Math.ceil((r.due.getTime() - Date.now()) / 86400000)
              const filed = r.status === 'filed'
              const tone = filed ? 'green' : days < 0 ? 'red' : days <= 5 ? 'amber' : 'grey'
              return (
                <div key={r.type} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '11px 13px', border: '1px solid var(--line-soft)',
                  borderRadius: 12, background: 'var(--surface-2)',
                }}>
                  <span className="tf-chip" style={{ width: 32, height: 32 }}>
                    <Icon name="file-check" size={16} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 650, fontSize: 13, color: 'var(--ink)' }}>{r.label}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.desc} · due {formatDateIN(r.due.toISOString())}</div>
                  </div>
                  <Badge tone={filed ? 'green' : tone}>
                    {filed ? 'Filed' : days < 0 ? `${Math.abs(days)}d overdue` : `${days}d left`}
                  </Badge>
                  <Link href={r.href} className="tf-btn tf-btn-ghost tf-btn-sm">Open</Link>
                </div>
              )
            })}
          </div>
        </Card>

        <Card>
          <SectionTitle icon="invoice" action={<Link href="/invoices" style={{ color: 'var(--brand)', fontSize: 12, textDecoration: 'none' }}>All invoices →</Link>}>
            Latest invoices
          </SectionTitle>
          {recentInvoices.length === 0 ? (
            <EmptyState icon="invoice" title="No invoices yet"
              message="Create your first GST invoice — numbers, GST split and stock all update automatically."
              action={<Button href="/invoices/new" icon="plus" size="sm">New invoice</Button>} />
          ) : (
            <div className="tf-col" style={{ gap: 2 }}>
              {recentInvoices.map(inv => (
                <Link key={inv.id} href={`/invoices/${inv.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="tf-row-between tf-tr" style={{
                    padding: '9px 10px', borderRadius: 9, borderBottom: '1px solid var(--line-soft)',
                  }}>
                    <div className="tf-row" style={{ gap: 10, minWidth: 0 }}>
                      <span className="tf-chip" style={{ width: 30, height: 30 }}><Icon name="invoice" size={14} /></span>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 650, color: 'var(--brand-dark)' }}>{inv.invoice_number}</div>
                        <div style={{
                          fontSize: 11.5, color: 'var(--muted)',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260,
                        }}>
                          {inv.customer_name} · {formatDateIN(inv.invoice_date)}
                        </div>
                      </div>
                    </div>
                    <div className="tf-row" style={{ gap: 9 }}>
                      <span className="tf-num" style={{ fontSize: 13, fontWeight: 650 }}>₹{formatINR(inv.grand_total)}</span>
                      <Badge tone={inv.payment_status === 'paid' ? 'green' : inv.payment_status === 'partial' ? 'amber' : 'red'} dot={false}>
                        {inv.payment_status}
                      </Badge>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {apAgeing.buckets.some(b => b.amount > 0) && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--line-soft)' }}>
              <div className="tf-eyebrow" style={{ marginBottom: 6 }}>Payable ageing</div>
              <StackedBar segments={apAgeing.buckets.map(b => ({ label: b.label, value: b.amount, color: b.color }))} />
            </div>
          )}
        </Card>
      </div>

      <DashboardTrends metrics={metrics} />
    </div>
  )
}

function DashboardTrends({ metrics }: { metrics: Metrics }) {
  const rows = [
    { label: 'Sales growth', value: changePct(metrics.totalSales, metrics.prevSales) },
    { label: 'Purchase growth', value: changePct(metrics.totalPurchases, metrics.prevPurchases) },
    { label: 'Expense ratio', value: metrics.totalSales ? (metrics.totalExpenses / metrics.totalSales) * 100 : null, suffix: '%' },
  ]
  return (
    <Card>
      <SectionTitle icon="percent">This month at a glance</SectionTitle>
      <div className="tf-g-3">
        {rows.map(r => (
          <div key={r.label}>
            <div className="tf-row-between" style={{ marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.label}</span>
              <span className="tf-num" style={{ fontSize: 13, fontWeight: 650 }}>
                {r.value === null ? '—' : `${r.value.toFixed(1)}${r.suffix ?? (r.value > 0 ? '% ↑' : '%')}`}
              </span>
            </div>
            <ProgressBar
              value={r.value === null ? 0 : Math.min(Math.abs(r.value), 100)}
              color={r.label === 'Expense ratio' ? 'var(--amber)' : 'var(--green)'}
            />
          </div>
        ))}
      </div>
    </Card>
  )
}

function DashboardSkeleton() {
  return (
    <div className="page-container" style={{ maxWidth: 1240 }}>
      <div style={{ height: 84, borderRadius: 16, background: 'linear-gradient(115deg,#dbe6f7,#eef2f9)', marginBottom: '1rem' }} />
      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        {[0, 1, 2, 3].map(i => (
          <div key={i} style={{ height: 96, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)' }} />
        ))}
      </div>
      <div className="tf-g-2">
        {[0, 1].map(i => (
          <div key={i} style={{ height: 240, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)' }} />
        ))}
      </div>
      <p style={{ color: 'var(--faint)', fontSize: 12, marginTop: 12 }}>Loading dashboard…</p>
    </div>
  )
}
