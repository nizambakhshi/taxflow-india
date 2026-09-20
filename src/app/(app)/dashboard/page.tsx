'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import Link from 'next/link'

function getMonthRange(monthsBack = 0) {
  const d = new Date()
  const year = d.getFullYear()
  const month = d.getMonth() - monthsBack
  const start = new Date(year, month, 1)
  const end = new Date(year, month + 1, 0)
  return {
    start: start.toISOString().split('T')[0],
    end: end.toISOString().split('T')[0],
    label: start.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  }
}

export default function DashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgName, setOrgName] = useState('')
  const [orgId, setOrgId] = useState('')

  const [metrics, setMetrics] = useState({
    totalSales: 0, totalPurchases: 0,
    totalExpenses: 0, gstCollected: 0,
    itcAvailable: 0, netGSTPayable: 0,
    totalReceivable: 0, totalPayable: 0,
    overdueReceivable: 0, paidThisMonth: 0,
    invoiceCount: 0, customerCount: 0,
  })

  const [recentInvoices, setRecentInvoices] = useState<any[]>([])
  const [gstReturns, setGstReturns] = useState<any[]>([])
  const [monthlySales, setMonthlySales] = useState<any[]>([])

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
    const { start, end } = getMonthRange(0)

    // This month invoices
    const { data: invoices } = await supabase
      .from('invoices')
      .select('*')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('invoice_date', start)
      .lte('invoice_date', end)

    // This month bills
    const { data: bills } = await supabase
      .from('purchase_bills')
      .select('*')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('bill_date', start)
      .lte('bill_date', end)

    // This month expenses
    const { data: expenses } = await supabase
      .from('expenses')
      .select('*')
      .eq('organization_id', oid)
      .gte('expense_date', start)
      .lte('expense_date', end)

    // Outstanding receivables
    const { data: unpaidInvoices } = await supabase
      .from('invoices')
      .select('balance_due, invoice_date, due_date')
      .eq('organization_id', oid)
      .in('payment_status', ['unpaid', 'partial'])
      .neq('status', 'cancelled')

    // Outstanding payables
    const { data: unpaidBills } = await supabase
      .from('purchase_bills')
      .select('balance_due')
      .eq('organization_id', oid)
      .in('payment_status', ['unpaid', 'partial'])
      .neq('status', 'cancelled')

    // Customer count
    const { count: customerCount } = await supabase
      .from('customers')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', oid)
      .eq('is_active', true)

    // Recent invoices
    const { data: recent } = await supabase
      .from('invoices')
      .select('*')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(5)

    // GST return status
    const period = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`
    const { data: returns } = await supabase
      .from('gst_return_periods')
      .select('*')
      .eq('organization_id', oid)
      .eq('period', period)

    // Last 6 months sales for mini chart
    const salesByMonth = await Promise.all(
      Array.from({ length: 6 }, (_, i) => {
        const { start, end, label } = getMonthRange(5 - i)
        return supabase
          .from('invoices')
          .select('grand_total')
          .eq('organization_id', oid)
          .neq('status', 'cancelled')
          .gte('invoice_date', start)
          .lte('invoice_date', end)
          .then(({ data }) => ({
            label,
            total: (data || []).reduce((s, i) => s + Number(i.grand_total), 0)
          }))
      })
    )

    const invList = invoices || []
    const billList = bills || []
    const expList = expenses || []
    const unpaidInvList = unpaidInvoices || []
    const unpaidBillList = unpaidBills || []

    const totalSales = invList.reduce((s, i) => s + Number(i.grand_total), 0)
    const totalPurchases = billList.reduce((s, b) => s + Number(b.grand_total), 0)
    const totalExpenses = expList.reduce((s, e) => s + Number(e.amount), 0)
    const gstCollected = invList.reduce((s, i) => s + Number(i.total_tax), 0)
    const itcAvailable = billList
      .filter(b => b.itc_eligible)
      .reduce((s, b) => s + Number(b.total_tax), 0)
    const netGSTPayable = Math.max(0, gstCollected - itcAvailable)
    const totalReceivable = unpaidInvList.reduce((s, i) => s + Number(i.balance_due), 0)
    const totalPayable = unpaidBillList.reduce((s, b) => s + Number(b.balance_due), 0)
    const overdueReceivable = unpaidInvList
      .filter(i => {
        const due = i.due_date || i.invoice_date
        return new Date(due) < new Date()
      })
      .reduce((s, i) => s + Number(i.balance_due), 0)

    setMetrics({
      totalSales, totalPurchases, totalExpenses,
      gstCollected, itcAvailable, netGSTPayable,
      totalReceivable, totalPayable, overdueReceivable,
      paidThisMonth: 0,
      invoiceCount: invList.length,
      customerCount: customerCount || 0,
    })

    setRecentInvoices(recent || [])
    setMonthlySales(salesByMonth)

    // Build return status
    const returnTypes = [
      { type: 'GSTR1', label: 'GSTR-1', href: '/gst/gstr1' },
      { type: 'GSTR3B', label: 'GSTR-3B', href: '/gst/gstr3b' },
    ]
    const returnList = returnTypes.map(rt => {
      const existing = (returns || []).find(r => r.return_type === rt.type)
      return { ...rt, status: existing?.status || 'not_started' }
    })
    setGstReturns(returnList)
  }

  const statusConfig: Record<string, { label: string; bg: string; color: string }> = {
    not_started: { label: 'Not Started', bg: '#f1f5f9', color: '#64748b' },
    draft: { label: 'Draft', bg: '#fef9c3', color: '#854d0e' },
    ready: { label: 'Ready', bg: '#eff6ff', color: '#1d4ed8' },
    filed: { label: 'Filed ✓', bg: '#f0fdf4', color: '#166534' },
  }

  // Mini bar chart
  const maxSales = Math.max(...monthlySales.map(m => m.total), 1)

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>
      Loading dashboard...
    </div>
  )

  const now = new Date()
  const monthLabel = now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  return (
    <div style={{ padding: '2rem', maxWidth: '1200px' }}>
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
          Dashboard
        </h1>
        <p style={{ fontSize: '14px', color: '#64748b' }}>
          {orgName} · {monthLabel}
        </p>
      </div>

      {/* Top metrics */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: '1rem', marginBottom: '1.5rem'
      }}>
        {[
          {
            label: 'Total Sales', value: metrics.totalSales,
            sub: `${metrics.invoiceCount} invoices this month`,
            color: '#2563eb', icon: '📈'
          },
          {
            label: 'Total Purchases', value: metrics.totalPurchases,
            sub: 'Bills this month',
            color: '#7c3aed', icon: '🛒'
          },
          {
            label: 'Total Expenses', value: metrics.totalExpenses,
            sub: 'Business expenses',
            color: '#0891b2', icon: '💸'
          },
        ].map(card => (
          <div key={card.label} style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.25rem',
            borderTop: `3px solid ${card.color}`
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>
                  {card.label}
                </div>
                <div style={{ fontSize: '22px', fontWeight: '700', color: '#1e293b' }}>
                  ₹{formatINR(card.value)}
                </div>
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                  {card.sub}
                </div>
              </div>
              <div style={{ fontSize: '24px' }}>{card.icon}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* GST Summary */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{
            fontSize: '13px', fontWeight: '600', color: '#374151',
            marginBottom: '1rem'
          }}>
            GST Summary — {monthLabel}
          </div>
          {[
            { label: 'GST Collected (Output)', value: metrics.gstCollected, color: '#dc2626' },
            { label: 'ITC Available (Input)', value: metrics.itcAvailable, color: '#059669' },
            { label: 'Net GST Payable', value: metrics.netGSTPayable, color: '#d97706', bold: true },
          ].map(row => (
            <div key={row.label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '8px 0', fontSize: '13px',
              borderBottom: '1px solid #f8fafc'
            }}>
              <span style={{ color: '#64748b' }}>{row.label}</span>
              <span style={{
                fontWeight: row.bold ? '700' : '500',
                color: row.color
              }}>
                ₹{formatINR(row.value)}
              </span>
            </div>
          ))}
          <Link href="/gst" style={{
            display: 'block', marginTop: '12px', textAlign: 'center' as const,
            fontSize: '12px', color: '#2563eb', textDecoration: 'none'
          }}>
            View GST Dashboard →
          </Link>
        </div>

        {/* Receivables & Payables */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{
            fontSize: '13px', fontWeight: '600', color: '#374151',
            marginBottom: '1rem'
          }}>
            Outstanding
          </div>
          {[
            { label: 'Total Receivable', value: metrics.totalReceivable, color: '#2563eb' },
            { label: 'Overdue Receivable', value: metrics.overdueReceivable, color: '#dc2626' },
            { label: 'Total Payable', value: metrics.totalPayable, color: '#7c3aed', bold: true },
          ].map(row => (
            <div key={row.label} style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '8px 0', fontSize: '13px',
              borderBottom: '1px solid #f8fafc'
            }}>
              <span style={{ color: '#64748b' }}>{row.label}</span>
              <span style={{
                fontWeight: row.bold ? '700' : '500',
                color: row.color
              }}>
                ₹{formatINR(row.value)}
              </span>
            </div>
          ))}
          <Link href="/payments" style={{
            display: 'block', marginTop: '12px', textAlign: 'center' as const,
            fontSize: '12px', color: '#2563eb', textDecoration: 'none'
          }}>
            View Payments →
          </Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* Sales trend — mini bar chart */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{
            fontSize: '13px', fontWeight: '600', color: '#374151',
            marginBottom: '1rem'
          }}>
            Sales — Last 6 Months
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '80px' }}>
            {monthlySales.map((m, i) => (
              <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: '4px' }}>
                <div style={{ fontSize: '10px', color: '#64748b' }}>
                  {m.total > 0 ? `₹${Math.round(m.total / 1000)}k` : ''}
                </div>
                <div style={{
                  width: '100%',
                  height: `${Math.max(4, (m.total / maxSales) * 60)}px`,
                  background: i === monthlySales.length - 1 ? '#2563eb' : '#bfdbfe',
                  borderRadius: '4px 4px 0 0',
                  transition: 'height 0.3s'
                }} />
                <div style={{ fontSize: '9px', color: '#94a3b8', textAlign: 'center' as const }}>
                  {m.label.split(' ')[0]}
                </div>
              </div>
            ))}
          </div>
          <Link href="/reports" style={{
            display: 'block', marginTop: '12px', textAlign: 'center' as const,
            fontSize: '12px', color: '#2563eb', textDecoration: 'none'
          }}>
            View Reports →
          </Link>
        </div>

        {/* GST Return Status */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{
            fontSize: '13px', fontWeight: '600', color: '#374151',
            marginBottom: '1rem'
          }}>
            GST Returns — {monthLabel}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '10px' }}>
            {gstReturns.map(ret => {
              const sc = statusConfig[ret.status] || statusConfig.not_started
              return (
                <div key={ret.type} style={{
                  display: 'flex', justifyContent: 'space-between',
                  alignItems: 'center', padding: '10px 12px',
                  border: '1px solid #f1f5f9', borderRadius: '8px'
                }}>
                  <div>
                    <div style={{ fontWeight: '600', fontSize: '13px', color: '#1e293b' }}>
                      {ret.label}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{
                      fontSize: '11px', padding: '3px 10px',
                      borderRadius: '99px', fontWeight: '600',
                      background: sc.bg, color: sc.color
                    }}>
                      {sc.label}
                    </span>
                    <Link href={ret.href} style={{
                      fontSize: '12px', color: '#2563eb',
                      textDecoration: 'none', fontWeight: '500'
                    }}>
                      View →
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
          <Link href="/gst" style={{
            display: 'block', marginTop: '12px', textAlign: 'center' as const,
            fontSize: '12px', color: '#2563eb', textDecoration: 'none'
          }}>
            GST Dashboard →
          </Link>
        </div>
      </div>

      {/* Recent invoices */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.25rem'
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', marginBottom: '1rem'
        }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151' }}>
            Recent Invoices
          </div>
          <Link href="/invoices" style={{
            fontSize: '12px', color: '#2563eb', textDecoration: 'none'
          }}>
            View all →
          </Link>
        </div>

        {recentInvoices.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '1.5rem', color: '#94a3b8', fontSize: '13px' }}>
            No invoices yet —{' '}
            <Link href="/invoices/new" style={{ color: '#2563eb' }}>
              Create your first invoice
            </Link>
          </div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr',
              gap: '12px', padding: '8px 12px',
              fontSize: '11px', fontWeight: '600', color: '#94a3b8',
              borderBottom: '1px solid #f1f5f9'
            }}>
              <span>Invoice</span>
              <span>Customer</span>
              <span>Date</span>
              <span>Amount</span>
              <span>Status</span>
            </div>
            {recentInvoices.map(inv => (
              <Link key={inv.id} href={`/invoices/${inv.id}`} style={{ textDecoration: 'none' }}>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr',
                  gap: '12px', padding: '10px 12px',
                  borderBottom: '1px solid #f8fafc',
                  fontSize: '13px', cursor: 'pointer',
                  alignItems: 'center'
                }}>
                  <span style={{ fontWeight: '600', color: '#2563eb' }}>
                    {inv.invoice_number}
                  </span>
                  <span style={{ color: '#1e293b' }}>{inv.customer_name}</span>
                  <span style={{ color: '#64748b' }}>
                    {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                  </span>
                  <span style={{ fontWeight: '500' }}>
                    ₹{formatINR(inv.grand_total)}
                  </span>
                  <span>
                    <span style={{
                      fontSize: '11px', padding: '2px 8px',
                      borderRadius: '99px',
                      background:
                        inv.payment_status === 'paid' ? '#f0fdf4' :
                        inv.payment_status === 'partial' ? '#fef9c3' : '#fef2f2',
                      color:
                        inv.payment_status === 'paid' ? '#166534' :
                        inv.payment_status === 'partial' ? '#854d0e' : '#dc2626'
                    }}>
                      {inv.payment_status}
                    </span>
                  </span>
                </div>
              </Link>
            ))}
          </>
        )}
      </div>
    </div>
  )
}