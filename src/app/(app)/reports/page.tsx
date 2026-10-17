'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { Button, Card, PageHeader, SectionTitle, Segmented, StatCard } from '@/components/ui'
import { plural } from '@/lib/format'

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

const PERIOD_OPTIONS = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_fy', label: 'This financial year' },
]

const REPORT_OPTIONS = [
  { value: 'sales', label: 'Sales' },
  { value: 'purchase', label: 'Purchases' },
  { value: 'gst', label: 'GST summary' },
  { value: 'profit', label: 'Profit' },
]

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
    const { label } = getDateRange(period)
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

  const { label } = getDateRange(period)

  if (loading) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
      Crunching the numbers…
    </div>
  )

  return (
    <div className="page-container rp" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Insights"
        title="Reports"
        subtitle={label}
        actions={
          <div className="tf-row tf-wrap" style={{ gap: 8 }}>
            <Segmented options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
            <Button variant="ghost" icon="download" onClick={exportCurrentReport}>
              Export CSV
            </Button>
          </div>
        }
      />

      <div style={{ marginBottom: '1rem' }}>
        <Segmented options={REPORT_OPTIONS} value={activeReport} onChange={setActiveReport} />
      </div>

      {/* SALES REPORT */}
      {activeReport === 'sales' && (
        <>
          <div className="rp-stats">
            <StatCard label="Total sales" value={salesData.total} icon="trend" tone="blue"
              sub={`${plural(salesData.invoiceCount, 'invoice')}`} />
            <StatCard label="Taxable value" value={salesData.taxable} icon="scale" tone="blue"
              sub="GST excluded" delay={40} />
            <StatCard label="Tax collected" value={salesData.tax} icon="percent" tone="amber"
              sub="CGST + SGST + IGST" delay={80} />
            <StatCard label="Invoices" value={String(salesData.invoiceCount)} icon="invoice" tone="green"
              sub="in this period" delay={120} />
          </div>

          <div className="rp-split">
            <Card pad={false}>
              <div className="rp-card-head">
                <SectionTitle icon="users">Sales by customer</SectionTitle>
              </div>
              {salesData.byCustomer.length === 0 ? (
                <div className="rp-none">No sales in this period</div>
              ) : salesData.byCustomer.slice(0, 8).map((c: any) => (
                <div key={c.name} className="rp-line">
                  <div style={{ minWidth: 0 }}>
                    <div className="rp-line-name">{c.name}</div>
                    <div className="rp-line-sub">{plural(c.count, 'invoice')}</div>
                  </div>
                  <div className="rp-line-amt tf-num">₹{formatINR(c.total)}</div>
                </div>
              ))}
            </Card>

            <Card pad={false}>
              <div className="rp-card-head">
                <SectionTitle icon="box">Sales by product</SectionTitle>
              </div>
              {salesData.byProduct.length === 0 ? (
                <div className="rp-none">No sales in this period</div>
              ) : salesData.byProduct.slice(0, 8).map((p: any) => (
                <div key={p.name} className="rp-line">
                  <div style={{ minWidth: 0 }}>
                    <div className="rp-line-name">{p.name}</div>
                    <div className="rp-line-sub">Qty: {Number(p.qty).toFixed(2)}</div>
                  </div>
                  <div className="rp-line-amt tf-num">₹{formatINR(p.total)}</div>
                </div>
              ))}
            </Card>
          </div>

          {salesData.byState.length > 0 && (
            <Card pad={false} style={{ marginTop: '1rem' }}>
              <div className="rp-card-head">
                <SectionTitle icon="landmark">Sales by state (place of supply)</SectionTitle>
              </div>
              <div className="rp-states">
                {salesData.byState.map((s: any) => (
                  <div key={s.name} className="rp-state">
                    <span className="rp-state-name">{s.name}</span>
                    <span className="rp-state-amt tf-num">₹{formatINR(s.total)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {/* PURCHASE REPORT */}
      {activeReport === 'purchase' && (
        <>
          <div className="rp-stats rp-stats-3">
            <StatCard label="Total purchases" value={purchaseData.total} icon="cart" tone="blue"
              sub={`${plural(purchaseData.billCount, 'bill')}`} />
            <StatCard label="ITC available" value={purchaseData.itc} icon="check" tone="green"
              sub="from eligible bills" delay={40} />
            <StatCard label="Bills" value={String(purchaseData.billCount)} icon="invoice" tone="blue"
              sub="in this period" delay={80} />
          </div>

          <div className="table-frame">
            <div className="rp-rows">
              <div className="rp-eyebrow" style={{ marginBottom: 10 }}>Purchases by vendor</div>
              {purchaseData.byVendor.length === 0 ? (
                <div className="rp-none">No purchase data for this period</div>
              ) : (
                <div className="responsive-table">
                  <div className="table-header rp-row rp-row-v rp-row-head">
                    <span>Vendor</span>
                    <span className="rp-right">Bills</span>
                    <span className="rp-right">Total</span>
                    <span className="rp-right">ITC</span>
                  </div>
                  {purchaseData.byVendor.map((v: any) => (
                    <div key={v.name} className="table-row rp-row rp-row-v">
                      <span data-label="Vendor" className="rp-strong">{v.name}</span>
                      <span data-label="Bills" className="rp-muted rp-right tf-num">{v.count}</span>
                      <span data-label="Total" className="rp-num rp-right tf-num">₹{formatINR(v.total)}</span>
                      <span data-label="ITC" className="rp-itc rp-right tf-num">₹{formatINR(v.itc)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* GST SUMMARY REPORT */}
      {activeReport === 'gst' && (
        <div className="table-frame">
          <div className="rp-rows">
            <div className="rp-eyebrow" style={{ marginBottom: 10 }}>GST summary — {label}</div>
            <div className="responsive-table">
              <div className="table-header rp-row rp-row-g rp-row-head">
                <span>Category</span>
                <span className="rp-right">CGST</span>
                <span className="rp-right">SGST</span>
                <span className="rp-right">IGST</span>
                <span className="rp-right">Total</span>
              </div>

              {[
                {
                  label: 'Output tax (sales)', cls: 'is-output',
                  cgst: gstData.outputCGST, sgst: gstData.outputSGST,
                  igst: gstData.outputIGST,
                  total: gstData.outputCGST + gstData.outputSGST + gstData.outputIGST,
                },
                {
                  label: 'Input tax credit (ITC)', cls: 'is-itc',
                  cgst: gstData.itcCGST, sgst: gstData.itcSGST,
                  igst: gstData.itcIGST,
                  total: gstData.itcCGST + gstData.itcSGST + gstData.itcIGST,
                },
                {
                  label: 'Net GST payable', cls: 'is-net',
                  cgst: gstData.netCGST, sgst: gstData.netSGST,
                  igst: gstData.netIGST, total: gstData.netTotal,
                },
              ].map(row => (
                <div key={row.label} className={`table-row rp-row rp-row-g ${row.cls}`}>
                  <span data-label="Category" className="rp-strong">{row.label}</span>
                  <span data-label="CGST" className="rp-right rp-amt tf-num">₹{formatINR(row.cgst)}</span>
                  <span data-label="SGST" className="rp-right rp-amt tf-num">₹{formatINR(row.sgst)}</span>
                  <span data-label="IGST" className="rp-right rp-amt tf-num">₹{formatINR(row.igst)}</span>
                  <span data-label="Total" className="rp-right rp-amt rp-total tf-num">₹{formatINR(row.total)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* PROFIT OVERVIEW */}
      {activeReport === 'profit' && (
        <>
          <div className="table-frame" style={{ marginBottom: '1rem' }}>
            <div className="rp-rows">
              <div className="rp-eyebrow" style={{ marginBottom: 10 }}>Profit &amp; loss overview — {label}</div>
              <p className="rp-note">
                Note: Based on taxable values (excluding GST). This is an indicative overview,
                not a formal P&L statement. Consult your accountant for certified accounts.
              </p>

              {[
                { label: 'Revenue (Sales — Taxable Value)', value: profitData.revenue, sign: '+', pos: true },
                { label: 'Cost of Purchases', value: profitData.purchases, sign: '−', pos: false },
                { label: 'Gross Profit', value: profitData.grossProfit, pos: profitData.grossProfit >= 0, isTotal: true },
                { label: 'Expenses', value: profitData.expenses, sign: '−', pos: false },
                { label: 'Net Profit / (Loss)', value: profitData.netProfit, pos: profitData.netProfit >= 0, isTotal: true },
              ].map(row => (
                <div key={row.label} className={`rp-pl-row${row.isTotal ? ' is-total' : ''}`}>
                  <span className="rp-pl-label">{row.label}</span>
                  <span className={`rp-pl-val tf-num ${row.pos ? 'is-pos' : 'is-neg'}`}>
                    {row.sign && `${row.sign} `}₹{formatINR(Math.abs(row.value))}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="rp-stats rp-stats-3">
            <StatCard label="Revenue" value={profitData.revenue} icon="trend" tone="blue"
              sub="taxable value, GST excluded" />
            <StatCard label="Total costs" value={profitData.purchases + profitData.expenses} icon="cart" tone="red"
              sub="purchases + expenses" delay={40} />
            <StatCard
              label="Net profit margin"
              value={`${profitData.revenue > 0 ? Math.round((profitData.netProfit / profitData.revenue) * 100) : 0}%`}
              icon="percent"
              tone={profitData.netProfit >= 0 ? 'green' : 'red'}
              sub={profitData.netProfit >= 0 ? 'in profit' : 'running a loss'}
              delay={80}
            />
          </div>
        </>
      )}

      <style>{`
        .rp-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .rp-stats-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }

        .rp-split { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        .rp-card-head { padding: 1.15rem 1.5rem 0; }
        .rp-none { padding: 2rem 1.5rem; text-align: center; color: var(--faint); font-size: 13px; }

        .rp-line { display: flex; justify-content: space-between; align-items: center; gap: 12px;
          padding: 10px 1.5rem; border-top: 1px solid var(--line-soft); }
        .rp-line-name { color: var(--ink); font-weight: 550; font-size: 13px; overflow-wrap: anywhere; }
        .rp-line-sub { font-size: 11px; color: var(--faint); margin-top: 2px; }
        .rp-line-amt { font-weight: 650; color: var(--brand); font-size: 13px; white-space: nowrap; }

        .rp-states { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px;
          background: var(--line-soft); border-top: 1px solid var(--line-soft); }
        .rp-state { background: var(--surface); display: flex; justify-content: space-between; gap: 10px;
          padding: 10px 16px; font-size: 12.5px; }
        .rp-state-name { color: var(--ink-2); overflow-wrap: anywhere; }
        .rp-state-amt { font-weight: 650; color: var(--ink); white-space: nowrap; }

        .rp-rows { padding: 1.5rem; }
        .rp-eyebrow { font-size: 11px; font-weight: 650; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .rp-note { font-size: 12px; color: var(--muted); font-style: italic; margin: 0 0 1rem; line-height: 1.55; }

        .rp-row { display: grid; gap: 8px; align-items: center; padding: 9px 0;
          border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
        .rp-row-v { grid-template-columns: minmax(0, 2fr) 70px minmax(0, 1fr) minmax(0, 1fr); }
        .rp-row-g { grid-template-columns: minmax(0, 1.6fr) repeat(4, minmax(0, 1fr)); }
        .rp-row:last-child { border-bottom: none; }
        .rp-row-head { font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .rp-right { text-align: right; }
        .rp-strong { color: var(--ink); font-weight: 550; overflow-wrap: anywhere; }
        .rp-muted { color: var(--muted); }
        .rp-num { color: var(--ink); }
        .rp-itc { color: var(--green); }
        .rp-amt { font-size: 13px; }
        .rp-total { font-weight: 700; font-size: 13.5px; }
        .rp-row.is-output .rp-amt { color: var(--red); }
        .rp-row.is-itc .rp-amt { color: var(--green); }
        .rp-row.is-net .rp-amt { color: var(--amber); }
        .rp-row.is-net { background: var(--amber-soft); font-weight: 650; }

        .rp-pl-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
          padding: 10px 0; border-top: 1px solid var(--line-soft); }
        .rp-pl-row.is-total { border-top: 2px solid var(--line); margin-top: 8px; padding: 14px 0; }
        .rp-pl-label { font-size: 13.5px; color: var(--ink-2); }
        .rp-pl-row.is-total .rp-pl-label { font-weight: 650; color: var(--ink); }
        .rp-pl-val { font-size: 15px; font-weight: 700; white-space: nowrap; }
        .rp-pl-val.is-pos { color: var(--green); }
        .rp-pl-val.is-neg { color: var(--red); }

        @media (max-width: 1024px) {
          .rp-stats, .rp-stats-3 { grid-template-columns: 1fr 1fr; }
          .rp-states { grid-template-columns: 1fr 1fr; }
        }
        @media (max-width: 768px) {
          .rp-split { grid-template-columns: 1fr; }
          .rp-stats, .rp-stats-3 { grid-template-columns: 1fr 1fr; }
          .rp-states { grid-template-columns: 1fr; }
          .rp-right { text-align: left; }
        }
      `}</style>
    </div>
  )
}
