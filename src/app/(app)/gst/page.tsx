'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import Link from 'next/link'

function getLastNMonths(n: number) {
  const months = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const label = d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    months.push({ period: `${year}-${month}`, label, year, month: d.getMonth() + 1 })
  }
  return months
}

function getFinancialYear(date = new Date()) {
  const month = date.getMonth()
  const year = date.getFullYear()
  return month >= 3 ? `${year}-${String(year + 1).slice(2)}` : `${year - 1}-${String(year).slice(2)}`
}

export default function GSTDashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  // GST summary data
  const [summary, setSummary] = useState({
    totalSales: 0,
    taxableSales: 0,
    cgstCollected: 0,
    sgstCollected: 0,
    igstCollected: 0,
    totalOutputTax: 0,
    totalPurchases: 0,
    itcCGST: 0,
    itcSGST: 0,
    itcIGST: 0,
    totalITC: 0,
    netPayable: 0,
  })

  const [returnStatus, setReturnStatus] = useState<any[]>([])
  const months = getLastNMonths(6)

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

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      if (gstReg) setOrgStateCode(gstReg.state_code || '')

      await loadPeriodData(membership.organization_id, selectedPeriod)
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (orgId) loadPeriodData(orgId, selectedPeriod)
  }, [selectedPeriod, orgId])

  async function loadPeriodData(oid: string, period: string) {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    // Sales in period
    const { data: invoices } = await supabase
      .from('invoices')
      .select('*')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('invoice_date', startDate)
      .lte('invoice_date', endDate)

    // Purchases in period
    const { data: bills } = await supabase
      .from('purchase_bills')
      .select('*')
      .eq('organization_id', oid)
      .eq('itc_eligible', true)
      .neq('status', 'cancelled')
      .gte('bill_date', startDate)
      .lte('bill_date', endDate)

    const invList = invoices || []
    const billList = bills || []

    const totalSales = invList.reduce((s, i) => s + Number(i.grand_total), 0)
    const taxableSales = invList.reduce((s, i) => s + Number(i.taxable_amount), 0)
    const cgstCollected = invList.reduce((s, i) => s + Number(i.cgst_amount), 0)
    const sgstCollected = invList.reduce((s, i) => s + Number(i.sgst_amount), 0)
    const igstCollected = invList.reduce((s, i) => s + Number(i.igst_amount), 0)
    const totalOutputTax = cgstCollected + sgstCollected + igstCollected

    const itcCGST = billList.reduce((s, b) => s + Number(b.cgst_amount), 0)
    const itcSGST = billList.reduce((s, b) => s + Number(b.sgst_amount), 0)
    const itcIGST = billList.reduce((s, b) => s + Number(b.igst_amount), 0)
    const totalITC = itcCGST + itcSGST + itcIGST
    const netPayable = Math.max(0, totalOutputTax - totalITC)
    const totalPurchases = billList.reduce((s, b) => s + Number(b.grand_total), 0)

    setSummary({
      totalSales, taxableSales,
      cgstCollected, sgstCollected, igstCollected, totalOutputTax,
      totalPurchases, itcCGST, itcSGST, itcIGST,
      totalITC, netPayable,
    })

    // Return status for this period
    const fy = getFinancialYear(new Date(parseInt(year), parseInt(month) - 1, 1))
    const { data: returns } = await supabase
      .from('gst_return_periods')
      .select('*')
      .eq('organization_id', oid)
      .eq('period', period)

    // Build return status list
    const returnTypes = [
      { type: 'GSTR1', label: 'GSTR-1', desc: 'Outward supplies', due: `11 ${new Date(parseInt(year), parseInt(month), 0).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}` },
      { type: 'GSTR3B', label: 'GSTR-3B', desc: 'Summary return', due: `20 ${new Date(parseInt(year), parseInt(month), 0).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })}` },
    ]

    const statusList = returnTypes.map(rt => {
      const existing = returns?.find(r => r.return_type === rt.type)
      return {
        ...rt,
        status: existing?.status || 'not_started',
        id: existing?.id || null,
        netPayable: existing?.net_payable || 0,
      }
    })

    setReturnStatus(statusList)
  }

  async function updateReturnStatus(returnType: string, status: string) {
    const fy = getFinancialYear()
    const existing = returnStatus.find(r => r.type === returnType)

    if (existing?.id) {
      await supabase
        .from('gst_return_periods')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('gst_return_periods')
        .insert({
          organization_id: orgId,
          return_type: returnType,
          financial_year: fy,
          period_type: 'monthly',
          period: selectedPeriod,
          status,
          tax_liability: summary.totalOutputTax,
          itc_claimed: summary.totalITC,
          net_payable: summary.netPayable,
        })
    }

    await loadPeriodData(orgId, selectedPeriod)
  }

  const statusConfig: Record<string, { label: string; bg: string; color: string }> = {
    not_started: { label: 'Not Started', bg: '#f1f5f9', color: '#64748b' },
    draft: { label: 'Draft', bg: '#fef9c3', color: '#854d0e' },
    ready: { label: 'Ready to File', bg: '#eff6ff', color: '#1d4ed8' },
    filed: { label: 'Filed', bg: '#f0fdf4', color: '#166534' },
  }

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            GST Dashboard
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            Tax summary and return filing status
          </p>
        </div>

        {/* Period selector */}
        <select
          style={{
            padding: '8px 14px', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '14px', cursor: 'pointer',
            background: 'white', color: '#1e293b', outline: 'none'
          }}
          value={selectedPeriod}
          onChange={e => setSelectedPeriod(e.target.value)}
        >
          {months.map(m => (
            <option key={m.period} value={m.period}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Output tax summary */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem'
      }}>
        <div style={{
          fontSize: '12px', fontWeight: '700', color: '#94a3b8',
          marginBottom: '1rem', textTransform: 'uppercase' as const,
          letterSpacing: '0.05em'
        }}>
          Output Tax (Sales)
        </div>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem'
        }}>
          {[
            { label: 'Total Sales', value: summary.totalSales, color: '#2563eb' },
            { label: 'Taxable Value', value: summary.taxableSales, color: '#374151' },
            { label: 'CGST Collected', value: summary.cgstCollected, color: '#7c3aed' },
            { label: 'SGST Collected', value: summary.sgstCollected, color: '#7c3aed' },
            { label: 'IGST Collected', value: summary.igstCollected, color: '#0891b2' },
          ].map(card => (
            <div key={card.label}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                {card.label}
              </div>
              <div style={{
                fontSize: '16px', fontWeight: '600',
                color: card.value > 0 ? card.color : '#94a3b8'
              }}>
                ₹{formatINR(card.value)}
              </div>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: '1rem', paddingTop: '1rem',
          borderTop: '1px solid #f1f5f9',
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontSize: '13px', color: '#64748b' }}>
            Total Output Tax
          </span>
          <span style={{ fontSize: '18px', fontWeight: '700', color: '#1e293b' }}>
            ₹{formatINR(summary.totalOutputTax)}
          </span>
        </div>
      </div>

      {/* ITC summary */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem'
      }}>
        <div style={{
          fontSize: '12px', fontWeight: '700', color: '#94a3b8',
          marginBottom: '1rem', textTransform: 'uppercase' as const,
          letterSpacing: '0.05em'
        }}>
          Input Tax Credit (Purchases)
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
          {[
            { label: 'Total Purchases', value: summary.totalPurchases, color: '#374151' },
            { label: 'CGST ITC', value: summary.itcCGST, color: '#059669' },
            { label: 'SGST ITC', value: summary.itcSGST, color: '#059669' },
            { label: 'IGST ITC', value: summary.itcIGST, color: '#059669' },
          ].map(card => (
            <div key={card.label}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                {card.label}
              </div>
              <div style={{
                fontSize: '16px', fontWeight: '600',
                color: card.value > 0 ? card.color : '#94a3b8'
              }}>
                ₹{formatINR(card.value)}
              </div>
            </div>
          ))}
        </div>
        <div style={{
          marginTop: '1rem', paddingTop: '1rem',
          borderTop: '1px solid #f1f5f9',
          display: 'flex', justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <span style={{ fontSize: '13px', color: '#64748b' }}>
            Total ITC Available
          </span>
          <span style={{ fontSize: '18px', fontWeight: '700', color: '#059669' }}>
            ₹{formatINR(summary.totalITC)}
          </span>
        </div>
      </div>

      {/* Net payable */}
      <div style={{
        background: summary.netPayable > 0 ? '#fef2f2' : '#f0fdf4',
        border: `1px solid ${summary.netPayable > 0 ? '#fecaca' : '#bbf7d0'}`,
        borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem'
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center'
        }}>
          <div>
            <div style={{
              fontSize: '14px', fontWeight: '600',
              color: summary.netPayable > 0 ? '#dc2626' : '#166534',
              marginBottom: '4px'
            }}>
              {summary.netPayable > 0 ? '⚠️ Net GST Payable' : '✅ No GST Payable'}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              Output Tax ₹{formatINR(summary.totalOutputTax)} − ITC ₹{formatINR(summary.totalITC)}
            </div>
          </div>
          <div style={{
            fontSize: '28px', fontWeight: '700',
            color: summary.netPayable > 0 ? '#dc2626' : '#166534'
          }}>
            ₹{formatINR(summary.netPayable)}
          </div>
        </div>
      </div>

      {/* Return filing status */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.5rem', marginBottom: '1.5rem'
      }}>
        <div style={{
          fontSize: '12px', fontWeight: '700', color: '#94a3b8',
          marginBottom: '1rem', textTransform: 'uppercase' as const,
          letterSpacing: '0.05em'
        }}>
          Return Filing Status — {months.find(m => m.period === selectedPeriod)?.label}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '12px' }}>
          {returnStatus.map(ret => {
            const sc = statusConfig[ret.status] || statusConfig.not_started
            return (
              <div key={ret.type} style={{
                display: 'flex', alignItems: 'center',
                justifyContent: 'space-between',
                padding: '1rem 1.25rem',
                border: '1px solid #e2e8f0',
                borderRadius: '10px', background: '#fafafa'
              }}>
                <div>
                  <div style={{ fontWeight: '600', fontSize: '14px', color: '#1e293b' }}>
                    {ret.label}
                  </div>
                  <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                    {ret.desc} · Due: {ret.due}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <span style={{
                    fontSize: '11px', padding: '3px 10px',
                    borderRadius: '99px', fontWeight: '600',
                    background: sc.bg, color: sc.color
                  }}>
                    {sc.label}
                  </span>

                  {/* Status update dropdown */}
                  <select
                    style={{
                      padding: '5px 10px', border: '1px solid #e2e8f0',
                      borderRadius: '6px', fontSize: '12px',
                      cursor: 'pointer', background: 'white', color: '#374151'
                    }}
                    value={ret.status}
                    onChange={e => updateReturnStatus(ret.type, e.target.value)}
                  >
                    <option value="not_started">Not Started</option>
                    <option value="draft">Draft</option>
                    <option value="ready">Ready to File</option>
                    <option value="filed">Filed</option>
                  </select>

                  {/* View report link */}
                  <Link
                    href={ret.type === 'GSTR1' ? '/gst/gstr1' : '/gst/gstr3b'}
                    style={{
                      padding: '5px 14px', background: '#2563eb',
                      color: 'white', borderRadius: '6px',
                      fontSize: '12px', fontWeight: '500',
                      textDecoration: 'none'
                    }}
                  >
                    View →
                  </Link>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Quick links */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem'
      }}>
        <Link href="/gst/gstr1" style={{ textDecoration: 'none' }}>
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.25rem', cursor: 'pointer'
          }}>
            <div style={{ fontWeight: '600', fontSize: '15px', color: '#1e293b', marginBottom: '4px' }}>
              📤 GSTR-1 Report
            </div>
            <div style={{ fontSize: '13px', color: '#64748b' }}>
              View outward supplies broken down by B2B, B2C, exports and HSN summary
            </div>
          </div>
        </Link>
        <Link href="/gst/gstr3b" style={{ textDecoration: 'none' }}>
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.25rem', cursor: 'pointer'
          }}>
            <div style={{ fontWeight: '600', fontSize: '15px', color: '#1e293b', marginBottom: '4px' }}>
              📑 GSTR-3B Report
            </div>
            <div style={{ fontSize: '13px', color: '#64748b' }}>
              View summary return with tax liability, ITC and net GST payable
            </div>
          </div>
        </Link>
      </div>
    </div>
  )
}