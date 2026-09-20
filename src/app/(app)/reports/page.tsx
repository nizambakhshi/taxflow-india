'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

function getDateRange(type: string) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()

  switch (type) {
    case 'this_month':
      return {
        start: new Date(year, month, 1).toISOString().split('T')[0],
        end: new Date(year, month + 1, 0).toISOString().split('T')[0],
        label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
      }
    case 'last_month':
      return {
        start: new Date(year, month - 1, 1).toISOString().split('T')[0],
        end: new Date(year, month, 0).toISOString().split('T')[0],
        label: new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
      }
    case 'this_quarter': {
      const q = Math.floor(month / 3)
      return {
        start: new Date(year, q * 3, 1).toISOString().split('T')[0],
        end: new Date(year, q * 3 + 3, 0).toISOString().split('T')[0],
        label: `Q${q + 1} ${year}`
      }
    }
    case 'this_fy': {
      const fyStart = month >= 3 ? year : year - 1
      return {
        start: `${fyStart}-04-01`,
        end: `${fyStart + 1}-03-31`,
        label: `FY ${fyStart}-${String(fyStart + 1).slice(2)}`
      }
    }
    default:
      return {
        start: new Date(year, month, 1).toISOString().split('T')[0],
        end: new Date(year, month + 1, 0).toISOString().split('T')[0],
        label: 'This Month'
      }
  }
}

export default function ReportsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [period, setPeriod] = useState('this_month')
  const [activeReport, setActiveReport] = useState('sales')

  const [salesData, setSalesData] = useState<any>({
    total: 0, taxable: 0, tax: 0,
    invoiceCount: 0, byCustomer: [], byProduct: [], byState: []
  })
  const [purchaseData, setPurchaseData] = useState<any>({
    total: 0, taxable: 0, itc: 0,
    billCount: 0, byVendor: []
  })
  const [gstData, setGstData] = useState<any>({
    outputCGST: 0, outputSGST: 0, outputIGST: 0,
    itcCGST: 0, itcSGST: 0, itcIGST: 0,
    netCGST: 0, netSGST: 0, netIGST: 0, netTotal: 0
  })
  const [profitData, setProfitData] = useState<any>({
    revenue: 0, purchases: 0, expenses: 0,
    grossProfit: 0, netProfit: 0
  })

  useEffect(() => {
    async function init() {
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
      await loadAll(membership.organization_id, period)
      setLoading(false)
    }
    init()
  }, [])

  useEffect(() => {
    if (orgId) loadAll(orgId, period)
  }, [period, orgId])

  async function loadAll(oid: string, p: string) {
    const { start, end } = getDateRange(p)

    const [invRes, billRes, expRes] = await Promise.all([
      supabase.from('invoices').select('*, invoice_items(*)')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .gte('invoice_date', start)
        .lte('invoice_date', end),
      supabase.from('purchase_bills').select('*')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .gte('bill_date', start)
        .lte('bill_date', end),
      supabase.from('expenses').select('*')
        .eq('organization_id', oid)
        .gte('expense_date', start)
        .lte('expense_date', end),
    ])

    const invList = invRes.data || []
    const billList = billRes.data || []
    const expList = expRes.data || []

    // Sales data
    const byCustomer: Record<string, any> = {}
    invList.forEach(inv => {
      const key = inv.customer_name
      if (!byCustomer[key]) byCustomer[key] = { name: key, total: 0, count: 0 }
      byCustomer[key].total += Number(inv.grand_total)
      byCustomer[key].count += 1
    })

    const byProduct: Record<string, any> = {}
    invList.forEach(inv => {
      (inv.invoice_items || []).forEach((item: any) => {
        const key = item.item_name
        if (!byProduct[key]) byProduct[key] = { name: key, qty: 0, total: 0 }
        byProduct[key].qty += Number(item.quantity)
        byProduct[key].total += Number(item.total_amount)
      })
    })

    const byState: Record<string, any> = {}
    invList.forEach(inv => {
      const key = inv.place_of_supply_name || inv.place_of_supply
      if (!byState[key]) byState[key] = { name: key, total: 0, count: 0 }
      byState[key].total += Number(inv.grand_total)
      byState[key].count += 1
    })

    setSalesData({
      total: invList.reduce((s, i) => s + Number(i.grand_total), 0),
      taxable: invList.reduce((s, i) => s + Number(i.taxable_amount), 0),
      tax: invList.reduce((s, i) => s + Number(i.total_tax), 0),
      invoiceCount: invList.length,
      byCustomer: Object.values(byCustomer).sort((a: any, b: any) => b.total - a.total),
      byProduct: Object.values(byProduct).sort((a: any, b: any) => b.total - a.total),
      byState: Object.values(byState).sort((a: any, b: any) => b.total - a.total),
    })

    // Purchase data
    const byVendor: Record<string, any> = {}
    billList.forEach(bill => {
      const key = bill.vendor_name
      if (!byVendor[key]) byVendor[key] = { name: key, total: 0, itc: 0, count: 0 }
      byVendor[key].total += Number(bill.grand_total)
      byVendor[key].itc += bill.itc_eligible ? Number(bill.total_tax) : 0
      byVendor[key].count += 1
    })

    setPurchaseData({
      total: billList.reduce((s, b) => s + Number(b.grand_total), 0),
      taxable: billList.reduce((s, b) => s + Number(b.taxable_amount), 0),
      itc: billList.filter(b => b.itc_eligible).reduce((s, b) => s + Number(b.total_tax), 0),
      billCount: billList.length,
      byVendor: Object.values(byVendor).sort((a: any, b: any) => b.total - a.total),
    })

    // GST data
    const outputCGST = invList.reduce((s, i) => s + Number(i.cgst_amount), 0)
    const outputSGST = invList.reduce((s, i) => s + Number(i.sgst_amount), 0)
    const outputIGST = invList.reduce((s, i) => s + Number(i.igst_amount), 0)
    const itcCGST = billList.filter(b => b.itc_eligible).reduce((s, b) => s + Number(b.cgst_amount), 0)
    const itcSGST = billList.filter(b => b.itc_eligible).reduce((s, b) => s + Number(b.sgst_amount), 0)
    const itcIGST = billList.filter(b => b.itc_eligible).reduce((s, b) => s + Number(b.igst_amount), 0)

    setGstData({
      outputCGST, outputSGST, outputIGST,
      itcCGST, itcSGST, itcIGST,
      netCGST: Math.max(0, outputCGST - itcCGST),
      netSGST: Math.max(0, outputSGST - itcSGST),
      netIGST: Math.max(0, outputIGST - itcIGST),
      netTotal: Math.max(0, (outputCGST + outputSGST + outputIGST) - (itcCGST + itcSGST + itcIGST)),
    })

    // Profit overview
    const revenue = invList.reduce((s, i) => s + Number(i.taxable_amount), 0)
    const purchases = billList.reduce((s, b) => s + Number(b.taxable_amount), 0)
    const expenses = expList.reduce((s, e) => s + Number(e.taxable_amount || e.amount), 0)
    const grossProfit = revenue - purchases
    const netProfit = grossProfit - expenses

    setProfitData({ revenue, purchases, expenses, grossProfit, netProfit })
  }

  function exportCurrentReport() {
    const { start, end, label } = getDateRange(period)
    let rows: any[] = []

    if (activeReport === 'sales') {
      rows = [
        [`Sales Report — ${label}`],
        [],
        ['SUMMARY'],
        ['Total Sales', salesData.total],
        ['Taxable Value', salesData.taxable],
        ['Total Tax', salesData.tax],
        ['Invoice Count', salesData.invoiceCount],
        [],
        ['BY CUSTOMER'],
        ['Customer', 'Total Sales', 'Invoice Count'],
        ...salesData.byCustomer.map((c: any) => [c.name, c.total, c.count]),
        [],
        ['BY PRODUCT'],
        ['Product', 'Qty', 'Total Sales'],
        ...salesData.byProduct.map((p: any) => [p.name, p.qty, p.total]),
      ]
    } else if (activeReport === 'purchase') {
      rows = [
        [`Purchase Report — ${label}`],
        [],
        ['SUMMARY'],
        ['Total Purchases', purchaseData.total],
        ['ITC Available', purchaseData.itc],
        ['Bill Count', purchaseData.billCount],
        [],
        ['BY VENDOR'],
        ['Vendor', 'Total', 'ITC', 'Bills'],
        ...purchaseData.byVendor.map((v: any) => [v.name, v.total, v.itc, v.count]),
      ]
    } else if (activeReport === 'gst') {
      rows = [
        [`GST Summary — ${label}`],
        [],
        ['', 'CGST', 'SGST', 'IGST'],
        ['Output Tax', gstData.outputCGST, gstData.outputSGST, gstData.outputIGST],
        ['ITC', gstData.itcCGST, gstData.itcSGST, gstData.itcIGST],
        ['Net Payable', gstData.netCGST, gstData.netSGST, gstData.netIGST],
        ['Total Payable', '', '', gstData.netTotal],
      ]
    }

    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeReport}-report-${period}.csv`
    a.click()
  }

  const tabStyle = (key: string) => ({
    padding: '8px 18px', background: 'none', border: 'none',
    cursor: 'pointer' as const, fontSize: '13px',
    fontWeight: activeReport === key ? '600' : '400',
    color: activeReport === key ? '#2563eb' : '#64748b',
    borderBottom: activeReport === key ? '2px solid #2563eb' : '2px solid transparent',
    marginBottom: '-1px'
  })

  const { label } = getDateRange(period)

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
            Reports
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>{label}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <select
            style={{
              padding: '8px 14px', border: '1px solid #e2e8f0',
              borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
              background: 'white', color: '#1e293b', outline: 'none'
            }}
            value={period}
            onChange={e => setPeriod(e.target.value)}
          >
            <option value="this_month">This Month</option>
            <option value="last_month">Last Month</option>
            <option value="this_quarter">This Quarter</option>
            <option value="this_fy">This Financial Year</option>
          </select>
          <button onClick={exportCurrentReport} style={{
            padding: '8px 16px', background: '#f1f5f9',
            color: '#374151', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
          }}>
            ↓ Export CSV
          </button>
        </div>
      </div>

      {/* Report tabs */}
      <div style={{
        borderBottom: '1px solid #e2e8f0',
        marginBottom: '1.5rem', display: 'flex', gap: '4px'
      }}>
        <button style={tabStyle('sales')} onClick={() => setActiveReport('sales')}>
          📈 Sales
        </button>
        <button style={tabStyle('purchase')} onClick={() => setActiveReport('purchase')}>
          🛒 Purchases
        </button>
        <button style={tabStyle('gst')} onClick={() => setActiveReport('gst')}>
          🏛️ GST Summary
        </button>
        <button style={tabStyle('profit')} onClick={() => setActiveReport('profit')}>
          💰 Profit Overview
        </button>
      </div>

      {/* SALES REPORT */}
      {activeReport === 'sales' && (
        <div>
          {/* Summary cards */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '1rem', marginBottom: '1.5rem'
          }}>
            {[
              { label: 'Total Sales', value: salesData.total },
              { label: 'Taxable Value', value: salesData.taxable },
              { label: 'Tax Collected', value: salesData.tax },
              { label: 'Invoices', value: salesData.invoiceCount, isCount: true },
            ].map(card => (
              <div key={card.label} style={{
                background: 'white', border: '1px solid #e2e8f0',
                borderRadius: '12px', padding: '1rem'
              }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                  {card.label}
                </div>
                <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                  {card.isCount ? card.value : `₹${formatINR(card.value as number)}`}
                </div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {/* By Customer */}
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div style={{
                padding: '12px 16px', fontWeight: '600', fontSize: '13px',
                color: '#374151', borderBottom: '1px solid #f1f5f9'
              }}>
                Sales by Customer
              </div>
              {salesData.byCustomer.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center' as const, color: '#94a3b8', fontSize: '13px' }}>
                  No data
                </div>
              ) : salesData.byCustomer.slice(0, 8).map((c: any) => (
                <div key={c.name} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '10px 16px', borderBottom: '1px solid #f8fafc',
                  fontSize: '13px', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ color: '#1e293b', fontWeight: '500' }}>{c.name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                      {c.count} invoice{c.count !== 1 ? 's' : ''}
                    </div>
                  </div>
                  <div style={{ fontWeight: '600', color: '#2563eb' }}>
                    ₹{formatINR(c.total)}
                  </div>
                </div>
              ))}
            </div>

            {/* By Product */}
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div style={{
                padding: '12px 16px', fontWeight: '600', fontSize: '13px',
                color: '#374151', borderBottom: '1px solid #f1f5f9'
              }}>
                Sales by Product
              </div>
              {salesData.byProduct.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center' as const, color: '#94a3b8', fontSize: '13px' }}>
                  No data
                </div>
              ) : salesData.byProduct.slice(0, 8).map((p: any) => (
                <div key={p.name} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '10px 16px', borderBottom: '1px solid #f8fafc',
                  fontSize: '13px', alignItems: 'center'
                }}>
                  <div>
                    <div style={{ color: '#1e293b', fontWeight: '500' }}>{p.name}</div>
                    <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                      Qty: {Number(p.qty).toFixed(2)}
                    </div>
                  </div>
                  <div style={{ fontWeight: '600', color: '#2563eb' }}>
                    ₹{formatINR(p.total)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* By State */}
          {salesData.byState.length > 0 && (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden', marginTop: '1rem'
            }}>
              <div style={{
                padding: '12px 16px', fontWeight: '600', fontSize: '13px',
                color: '#374151', borderBottom: '1px solid #f1f5f9'
              }}>
                Sales by State (Place of Supply)
              </div>
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0'
              }}>
                {salesData.byState.map((s: any, i: number) => (
                  <div key={s.name} style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '10px 16px',
                    borderBottom: '1px solid #f8fafc',
                    borderRight: i % 3 !== 2 ? '1px solid #f8fafc' : 'none',
                    fontSize: '13px'
                  }}>
                    <span style={{ color: '#374151' }}>{s.name}</span>
                    <span style={{ fontWeight: '600', color: '#1e293b' }}>
                      ₹{formatINR(s.total)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* PURCHASE REPORT */}
      {activeReport === 'purchase' && (
        <div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1rem', marginBottom: '1.5rem'
          }}>
            {[
              { label: 'Total Purchases', value: purchaseData.total },
              { label: 'ITC Available', value: purchaseData.itc },
              { label: 'Bills', value: purchaseData.billCount, isCount: true },
            ].map(card => (
              <div key={card.label} style={{
                background: 'white', border: '1px solid #e2e8f0',
                borderRadius: '12px', padding: '1rem'
              }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                  {card.label}
                </div>
                <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                  {card.isCount ? card.value : `₹${formatINR(card.value as number)}`}
                </div>
              </div>
            ))}
          </div>

          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', overflow: 'hidden'
          }}>
            <div style={{
              padding: '12px 16px', fontWeight: '600', fontSize: '13px',
              color: '#374151', borderBottom: '1px solid #f1f5f9'
            }}>
              Purchases by Vendor
            </div>
            {purchaseData.byVendor.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center' as const, color: '#94a3b8', fontSize: '13px' }}>
                No purchase data for this period
              </div>
            ) : (
              <>
                <div style={{
                  display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                  gap: '12px', padding: '8px 16px',
                  fontSize: '11px', fontWeight: '600', color: '#94a3b8',
                  borderBottom: '1px solid #f1f5f9'
                }}>
                  <span>Vendor</span>
                  <span>Bills</span>
                  <span>Total</span>
                  <span>ITC</span>
                </div>
                {purchaseData.byVendor.map((v: any) => (
                  <div key={v.name} style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                    gap: '12px', padding: '10px 16px',
                    borderBottom: '1px solid #f8fafc', fontSize: '13px'
                  }}>
                    <span style={{ fontWeight: '500', color: '#1e293b' }}>{v.name}</span>
                    <span style={{ color: '#64748b' }}>{v.count}</span>
                    <span style={{ fontWeight: '600' }}>₹{formatINR(v.total)}</span>
                    <span style={{ color: '#059669', fontWeight: '500' }}>
                      ₹{formatINR(v.itc)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {/* GST SUMMARY REPORT */}
      {activeReport === 'gst' && (
        <div>
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', overflow: 'hidden', marginBottom: '1rem'
          }}>
            <div style={{
              padding: '12px 16px', fontWeight: '600', fontSize: '13px',
              color: '#374151', borderBottom: '1px solid #f1f5f9'
            }}>
              GST Summary — {label}
            </div>
            <div style={{
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
              gap: '8px', padding: '10px 16px',
              fontSize: '12px', fontWeight: '600', color: '#94a3b8',
              borderBottom: '1px solid #f1f5f9'
            }}>
              <span>Category</span>
              <span style={{ textAlign: 'right' as const }}>CGST</span>
              <span style={{ textAlign: 'right' as const }}>SGST</span>
              <span style={{ textAlign: 'right' as const }}>IGST</span>
              <span style={{ textAlign: 'right' as const }}>Total</span>
            </div>

            {[
              {
                label: 'Output Tax (Sales)', bold: false,
                cgst: gstData.outputCGST, sgst: gstData.outputSGST,
                igst: gstData.outputIGST,
                total: gstData.outputCGST + gstData.outputSGST + gstData.outputIGST,
                color: '#dc2626'
              },
              {
                label: 'Input Tax Credit (ITC)', bold: false,
                cgst: gstData.itcCGST, sgst: gstData.itcSGST,
                igst: gstData.itcIGST,
                total: gstData.itcCGST + gstData.itcSGST + gstData.itcIGST,
                color: '#059669'
              },
              {
                label: 'Net GST Payable', bold: true,
                cgst: gstData.netCGST, sgst: gstData.netSGST,
                igst: gstData.netIGST, total: gstData.netTotal,
                color: '#d97706'
              },
            ].map(row => (
              <div key={row.label} style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '12px 16px',
                borderBottom: '1px solid #f8fafc',
                fontWeight: row.bold ? '700' : '400',
                background: row.bold ? '#fffbeb' : 'white'
              }}>
                <span style={{ color: '#374151', fontSize: '13px' }}>{row.label}</span>
                <span style={{ textAlign: 'right' as const, fontSize: '13px', color: row.color }}>
                  ₹{formatINR(row.cgst)}
                </span>
                <span style={{ textAlign: 'right' as const, fontSize: '13px', color: row.color }}>
                  ₹{formatINR(row.sgst)}
                </span>
                <span style={{ textAlign: 'right' as const, fontSize: '13px', color: row.color }}>
                  ₹{formatINR(row.igst)}
                </span>
                <span style={{ textAlign: 'right' as const, fontSize: '14px', fontWeight: '700', color: row.color }}>
                  ₹{formatINR(row.total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PROFIT OVERVIEW */}
      {activeReport === 'profit' && (
        <div>
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem'
          }}>
            <div style={{
              fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '1rem'
            }}>
              Profit & Loss Overview — {label}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '1rem', fontStyle: 'italic' }}>
              Note: Based on taxable values (excluding GST). This is an indicative overview,
              not a formal P&L statement. Consult your accountant for certified accounts.
            </div>

            {[
              { label: 'Revenue (Sales — Taxable Value)', value: profitData.revenue, color: '#059669', sign: '+' },
              { label: 'Cost of Purchases', value: profitData.purchases, color: '#dc2626', sign: '−' },
              { label: 'Gross Profit', value: profitData.grossProfit, color: profitData.grossProfit >= 0 ? '#059669' : '#dc2626', bold: true, border: true },
              { label: 'Expenses', value: profitData.expenses, color: '#dc2626', sign: '−' },
              { label: 'Net Profit / (Loss)', value: profitData.netProfit, color: profitData.netProfit >= 0 ? '#059669' : '#dc2626', bold: true, border: true },
            ].map(row => (
              <div key={row.label} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: row.border ? '14px 0' : '10px 0',
                borderTop: row.border ? '2px solid #e2e8f0' : '1px solid #f8fafc',
                marginTop: row.border ? '8px' : '0'
              }}>
                <span style={{
                  fontSize: '14px', fontWeight: row.bold ? '700' : '400',
                  color: row.bold ? '#1e293b' : '#374151'
                }}>
                  {row.label}
                </span>
                <span style={{
                  fontSize: '16px', fontWeight: '700', color: row.color
                }}>
                  {row.sign && `${row.sign} `}₹{formatINR(Math.abs(row.value))}
                </span>
              </div>
            ))}
          </div>

          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '1rem'
          }}>
            {[
              { label: 'Revenue', value: profitData.revenue, color: '#2563eb' },
              { label: 'Total Costs', value: profitData.purchases + profitData.expenses, color: '#dc2626' },
              {
                label: 'Net Profit Margin',
                value: profitData.revenue > 0
                  ? Math.round((profitData.netProfit / profitData.revenue) * 100)
                  : 0,
                isPercent: true,
                color: profitData.netProfit >= 0 ? '#059669' : '#dc2626'
              },
            ].map(card => (
              <div key={card.label} style={{
                background: 'white', border: '1px solid #e2e8f0',
                borderRadius: '12px', padding: '1.25rem',
                borderTop: `3px solid ${card.color}`
              }}>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>
                  {card.label}
                </div>
                <div style={{ fontSize: '22px', fontWeight: '700', color: card.color }}>
                  {(card as any).isPercent
                    ? `${card.value}%`
                    : `₹${formatINR(card.value as number)}`}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}