'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

export default function GSTR1Page() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [b2bInvoices, setB2bInvoices] = useState<any[]>([])
  const [b2cInvoices, setB2cInvoices] = useState<any[]>([])
  const [exportInvoices, setExportInvoices] = useState<any[]>([])
  const [hsnSummary, setHsnSummary] = useState<any[]>([])
  const [totals, setTotals] = useState({
    totalTaxable: 0, totalCGST: 0,
    totalSGST: 0, totalIGST: 0, totalTax: 0, grandTotal: 0
  })

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1)
    return {
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
    }
  })

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
      await loadData(membership.organization_id, selectedPeriod)
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (orgId) loadData(orgId, selectedPeriod)
  }, [selectedPeriod, orgId])

  async function loadData(oid: string, period: string) {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    const { data: invoices } = await supabase
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('invoice_date', startDate)
      .lte('invoice_date', endDate)
      .order('invoice_date')

    const allInvoices = invoices || []

    setB2bInvoices(allInvoices.filter(i => i.supply_type === 'b2b'))
    setB2cInvoices(allInvoices.filter(i => i.supply_type === 'b2c'))
    setExportInvoices(allInvoices.filter(i =>
      i.supply_type === 'export' || i.supply_type === 'sez'
    ))

    // HSN Summary
    const hsnMap: Record<string, any> = {}
    allInvoices.forEach(inv => {
      (inv.invoice_items || []).forEach((item: any) => {
        const hsn = item.hsn_sac || 'UNSPECIFIED'
        if (!hsnMap[hsn]) {
          hsnMap[hsn] = {
            hsn, description: item.item_name,
            uom: item.unit || 'NOS',
            totalQty: 0, totalValue: 0,
            taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0
          }
        }
        hsnMap[hsn].totalQty += Number(item.quantity)
        hsnMap[hsn].totalValue += Number(item.total_amount)
        hsnMap[hsn].taxableValue += Number(item.taxable_value)
        hsnMap[hsn].igst += Number(item.igst_amount)
        hsnMap[hsn].cgst += Number(item.cgst_amount)
        hsnMap[hsn].sgst += Number(item.sgst_amount)
        hsnMap[hsn].cess += Number(item.cess_amount)
      })
    })

    setHsnSummary(Object.values(hsnMap))

    setTotals({
      totalTaxable: allInvoices.reduce((s, i) => s + Number(i.taxable_amount), 0),
      totalCGST: allInvoices.reduce((s, i) => s + Number(i.cgst_amount), 0),
      totalSGST: allInvoices.reduce((s, i) => s + Number(i.sgst_amount), 0),
      totalIGST: allInvoices.reduce((s, i) => s + Number(i.igst_amount), 0),
      totalTax: allInvoices.reduce((s, i) => s + Number(i.total_tax), 0),
      grandTotal: allInvoices.reduce((s, i) => s + Number(i.grand_total), 0),
    })
  }

  function exportCSV() {
    const rows = [
      ['GSTR-1 Report', selectedPeriod],
      [],
      ['B2B INVOICES'],
      ['Invoice No', 'Date', 'Customer', 'GSTIN', 'Place of Supply',
       'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total'],
      ...b2bInvoices.map(i => [
        i.invoice_number,
        new Date(i.invoice_date).toLocaleDateString('en-IN'),
        i.customer_name, i.customer_gstin || '',
        i.place_of_supply_name,
        i.taxable_amount, i.cgst_amount,
        i.sgst_amount, i.igst_amount, i.grand_total
      ]),
      [],
      ['B2C INVOICES'],
      ['Invoice No', 'Date', 'Customer', 'Place of Supply',
       'Taxable Value', 'CGST', 'SGST', 'IGST', 'Total'],
      ...b2cInvoices.map(i => [
        i.invoice_number,
        new Date(i.invoice_date).toLocaleDateString('en-IN'),
        i.customer_name, i.place_of_supply_name,
        i.taxable_amount, i.cgst_amount,
        i.sgst_amount, i.igst_amount, i.grand_total
      ]),
      [],
      ['HSN SUMMARY'],
      ['HSN/SAC', 'Description', 'UOM', 'Total Qty',
       'Total Value', 'Taxable Value', 'IGST', 'CGST', 'SGST'],
      ...hsnSummary.map(h => [
        h.hsn, h.description, h.uom,
        h.totalQty, h.totalValue, h.taxableValue,
        h.igst, h.cgst, h.sgst
      ]),
    ]

    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `GSTR1-${selectedPeriod}.csv`
    a.click()
  }

  const [activeTab, setActiveTab] = useState('b2b')

  const tabStyle = (key: string) => ({
    padding: '8px 16px', background: 'none',
    border: 'none', cursor: 'pointer' as const,
    fontSize: '13px', fontWeight: activeTab === key ? '600' : '400',
    color: activeTab === key ? '#2563eb' : '#64748b',
    borderBottom: activeTab === key
      ? '2px solid #2563eb' : '2px solid transparent',
    marginBottom: '-1px'
  })

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            GSTR-1
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            Outward supplies — Details of sales for GST return
          </p>
        </div>
        <div className="toolbar" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
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
          <button onClick={exportCSV} style={{
            padding: '8px 16px', background: '#f1f5f9',
            color: '#374151', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
          }}>
            ↓ Export CSV
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="metric-grid" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '1rem', marginBottom: '1.5rem'
      }}>
        {[
          { label: 'Total Invoices', value: b2bInvoices.length + b2cInvoices.length + exportInvoices.length, isCount: true },
          { label: 'Taxable Value', value: totals.totalTaxable },
          { label: 'Total Tax', value: totals.totalTax },
          { label: 'Grand Total', value: totals.grandTotal },
        ].map(card => (
          <div key={card.label} style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1rem'
          }}>
            <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
              {card.label}
            </div>
            <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
              {card.isCount
                ? card.value
                : `₹${formatINR(card.value as number)}`}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{
        borderBottom: '1px solid #e2e8f0', marginBottom: '1rem',
        display: 'flex', gap: '4px'
      }}>
        <button style={tabStyle('b2b')} onClick={() => setActiveTab('b2b')}>
          B2B ({b2bInvoices.length})
        </button>
        <button style={tabStyle('b2c')} onClick={() => setActiveTab('b2c')}>
          B2C ({b2cInvoices.length})
        </button>
        <button style={tabStyle('export')} onClick={() => setActiveTab('export')}>
          Exports/SEZ ({exportInvoices.length})
        </button>
        <button style={tabStyle('hsn')} onClick={() => setActiveTab('hsn')}>
          HSN Summary ({hsnSummary.length})
        </button>
      </div>

      {/* B2B */}
      {activeTab === 'b2b' && (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          {b2bInvoices.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No B2B invoices for this period
            </div>
          ) : (
            <>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1.5fr 1.5fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '11px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Invoice No.</span>
                <span>Date</span>
                <span>Customer</span>
                <span>GSTIN</span>
                <span className="hide-mobile">Place</span>
                <span>Taxable</span>
                <span className="hide-mobile">Tax</span>
                <span>Total</span>
              </div>
              {b2bInvoices.map(inv => (
                <div key={inv.id} className="table-row" style={{
                  display: 'grid',
                  gridTemplateColumns: '1.2fr 1fr 1.5fr 1.5fr 1fr 1fr 1fr 1fr',
                  gap: '8px', padding: '10px 16px',
                  borderBottom: '1px solid #f1f5f9',
                  fontSize: '12px', alignItems: 'center'
                }}>
                  <span data-label="Invoice No." style={{ fontWeight: '600', color: '#2563eb' }}>
                    {inv.invoice_number}
                  </span>
                  <span data-label="Date" style={{ color: '#64748b' }}>
                    {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                  </span>
                  <span data-label="Customer" style={{ color: '#1e293b' }}>{inv.customer_name}</span>
                  <span data-label="GSTIN" style={{
                    fontFamily: 'monospace', fontSize: '11px', color: '#374151'
                  }}>
                    {inv.customer_gstin || '—'}
                  </span>
                  <span data-label="Place" className="hide-mobile" style={{ color: '#64748b' }}>{inv.place_of_supply}</span>
                  <span data-label="Taxable">₹{formatINR(inv.taxable_amount)}</span>
                  <span className="hide-mobile">₹{formatINR(inv.total_tax)}</span>
                  <span data-label="Total" style={{ fontWeight: '600' }}>₹{formatINR(inv.grand_total)}</span>
                </div>
              ))}
              {/* Totals row */}
              <div className="table-row" style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1fr 1.5fr 1.5fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '10px 16px',
                background: '#f8fafc', fontSize: '12px',
                fontWeight: '700', color: '#1e293b',
                borderTop: '2px solid #e2e8f0'
              }}>
                <span>Total</span>
                <span></span><span></span><span></span><span></span>
                <span data-label="Taxable">₹{formatINR(b2bInvoices.reduce((s, i) => s + Number(i.taxable_amount), 0))}</span>
                <span className="hide-mobile">₹{formatINR(b2bInvoices.reduce((s, i) => s + Number(i.total_tax), 0))}</span>
                <span data-label="Total">₹{formatINR(b2bInvoices.reduce((s, i) => s + Number(i.grand_total), 0))}</span>
              </div>
            </>
          )}
        </div>
      )}

      {/* B2C */}
      {activeTab === 'b2c' && (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          {b2cInvoices.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No B2C invoices for this period
            </div>
          ) : (
            <>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr 2fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '11px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Invoice No.</span>
                <span>Date</span>
                <span>Customer</span>
                <span>Place</span>
                <span>Taxable</span>
                <span className="hide-mobile">Tax</span>
                <span>Total</span>
              </div>
              {b2cInvoices.map(inv => (
                <div key={inv.id} className="table-row" style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 1fr 2fr 1fr 1fr 1fr 1fr',
                  gap: '8px', padding: '10px 16px',
                  borderBottom: '1px solid #f1f5f9',
                  fontSize: '12px', alignItems: 'center'
                }}>
                  <span data-label="Invoice No." style={{ fontWeight: '600', color: '#2563eb' }}>
                    {inv.invoice_number}
                  </span>
                  <span data-label="Date" style={{ color: '#64748b' }}>
                    {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                  </span>
                  <span data-label="Customer">{inv.customer_name}</span>
                  <span data-label="Place" style={{ color: '#64748b' }}>{inv.place_of_supply}</span>
                  <span data-label="Taxable">₹{formatINR(inv.taxable_amount)}</span>
                  <span className="hide-mobile">₹{formatINR(inv.total_tax)}</span>
                  <span data-label="Total" style={{ fontWeight: '600' }}>₹{formatINR(inv.grand_total)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Exports */}
      {activeTab === 'export' && (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          {exportInvoices.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No export or SEZ invoices for this period
            </div>
          ) : (
            <>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1fr 2fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '11px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Invoice No.</span>
                <span>Date</span>
                <span>Customer</span>
                <span>Type</span>
                <span>Taxable</span>
                <span>IGST</span>
                <span>Total</span>
              </div>
              {exportInvoices.map(inv => (
                <div key={inv.id} className="table-row" style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 1fr 2fr 1fr 1fr 1fr 1fr',
                  gap: '8px', padding: '10px 16px',
                  borderBottom: '1px solid #f1f5f9',
                  fontSize: '12px', alignItems: 'center'
                }}>
                  <span data-label="Invoice No." style={{ fontWeight: '600', color: '#2563eb' }}>
                    {inv.invoice_number}
                  </span>
                  <span data-label="Date" style={{ color: '#64748b' }}>
                    {new Date(inv.invoice_date).toLocaleDateString('en-IN')}
                  </span>
                  <span data-label="Customer">{inv.customer_name}</span>
                  <span data-label="Type">
                    <span style={{
                      fontSize: '11px', padding: '2px 6px',
                      borderRadius: '99px', background: '#eff6ff',
                      color: '#1d4ed8', textTransform: 'uppercase' as const
                    }}>
                      {inv.supply_type}
                    </span>
                  </span>
                  <span data-label="Taxable">₹{formatINR(inv.taxable_amount)}</span>
                  <span data-label="IGST">₹{formatINR(inv.igst_amount)}</span>
                  <span data-label="Total" style={{ fontWeight: '600' }}>₹{formatINR(inv.grand_total)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* HSN Summary */}
      {activeTab === 'hsn' && (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          {hsnSummary.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '14px' }}>
              No HSN data for this period
            </div>
          ) : (
            <>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr 1fr 1fr 1fr',
                gap: '8px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '11px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>HSN/SAC</span>
                <span>Description</span>
                <span className="hide-mobile">UOM</span>
                <span>Qty</span>
                <span>Taxable Value</span>
                <span>IGST</span>
                <span>CGST</span>
                <span>SGST</span>
              </div>
              {hsnSummary.map(h => (
                <div key={h.hsn} className="table-row" style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr 1fr 1fr 1fr',
                  gap: '8px', padding: '10px 16px',
                  borderBottom: '1px solid #f1f5f9',
                  fontSize: '12px', alignItems: 'center'
                }}>
                  <span data-label="HSN/SAC" style={{ fontFamily: 'monospace', fontWeight: '600' }}>
                    {h.hsn}
                  </span>
                  <span data-label="Description" style={{ color: '#374151' }}>{h.description}</span>
                  <span data-label="UOM" className="hide-mobile" style={{ color: '#64748b' }}>{h.uom}</span>
                  <span data-label="Qty">{Number(h.totalQty).toFixed(2)}</span>
                  <span data-label="Taxable Value">₹{formatINR(h.taxableValue)}</span>
                  <span data-label="IGST">₹{formatINR(h.igst)}</span>
                  <span data-label="CGST">₹{formatINR(h.cgst)}</span>
                  <span data-label="SGST">₹{formatINR(h.sgst)}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Important note */}
      <div style={{
        marginTop: '1.5rem', padding: '12px 16px',
        background: '#fef9c3', border: '1px solid #fde68a',
        borderRadius: '8px', fontSize: '12px', color: '#854d0e'
      }}>
        ⚠️ <strong>Important:</strong> This report is prepared from your books of accounts.
        Always verify figures against the official GST portal before filing.
        GST return schemas may change — verify the current GSTR-1 format at gstn.gov.in
        before using this data for actual filing.
      </div>
    </div>
  )
}