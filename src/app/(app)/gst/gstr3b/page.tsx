'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

export default function GSTR3BPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [data, setData] = useState({
    // 3.1 Outward supplies
    b2bTaxable: 0, b2bTax: 0,
    b2cTaxable: 0, b2cTax: 0,
    exportTaxable: 0, exportTax: 0,
    nilRatedTaxable: 0,
    totalOutwardTaxable: 0, totalOutwardTax: 0,

    // CGST/SGST/IGST breakdown
    outwardCGST: 0, outwardSGST: 0, outwardIGST: 0,

    // 4. ITC
    itcCGST: 0, itcSGST: 0, itcIGST: 0, totalITC: 0,

    // 6. Net payable
    cgstPayable: 0, sgstPayable: 0, igstPayable: 0, totalPayable: 0,
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
      .select('*')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('invoice_date', startDate)
      .lte('invoice_date', endDate)

    const { data: bills } = await supabase
      .from('purchase_bills')
      .select('*')
      .eq('organization_id', oid)
      .eq('itc_eligible', true)
      .neq('status', 'cancelled')
      .gte('bill_date', startDate)
      .lte('bill_date', endDate)

    const { data: expenses } = await supabase
      .from('expenses')
      .select('*')
      .eq('organization_id', oid)
      .eq('itc_eligible', true)
      .gte('expense_date', startDate)
      .lte('expense_date', endDate)

    const invList = invoices || []
    const billList = bills || []
    const expList = expenses || []

    const b2b = invList.filter(i => i.supply_type === 'b2b')
    const b2c = invList.filter(i => i.supply_type === 'b2c')
    const exports_ = invList.filter(i =>
      i.supply_type === 'export' || i.supply_type === 'sez'
    )

    const b2bTaxable = b2b.reduce((s, i) => s + Number(i.taxable_amount), 0)
    const b2bTax = b2b.reduce((s, i) => s + Number(i.total_tax), 0)
    const b2cTaxable = b2c.reduce((s, i) => s + Number(i.taxable_amount), 0)
    const b2cTax = b2c.reduce((s, i) => s + Number(i.total_tax), 0)
    const exportTaxable = exports_.reduce((s, i) => s + Number(i.taxable_amount), 0)
    const exportTax = exports_.reduce((s, i) => s + Number(i.total_tax), 0)

    const outwardCGST = invList.reduce((s, i) => s + Number(i.cgst_amount), 0)
    const outwardSGST = invList.reduce((s, i) => s + Number(i.sgst_amount), 0)
    const outwardIGST = invList.reduce((s, i) => s + Number(i.igst_amount), 0)
    const totalOutwardTax = outwardCGST + outwardSGST + outwardIGST

    const itcCGST = billList.reduce((s, b) => s + Number(b.cgst_amount), 0)
      + expList.reduce((s, e) => s + (Number(e.gst_amount) / 2), 0)
    const itcSGST = billList.reduce((s, b) => s + Number(b.sgst_amount), 0)
      + expList.reduce((s, e) => s + (Number(e.gst_amount) / 2), 0)
    const itcIGST = billList.reduce((s, b) => s + Number(b.igst_amount), 0)
    const totalITC = itcCGST + itcSGST + itcIGST

    const cgstPayable = Math.max(0, outwardCGST - itcCGST)
    const sgstPayable = Math.max(0, outwardSGST - itcSGST)
    const igstPayable = Math.max(0, outwardIGST - itcIGST)
    const totalPayable = cgstPayable + sgstPayable + igstPayable

    setData({
      b2bTaxable, b2bTax, b2cTaxable, b2cTax,
      exportTaxable, exportTax, nilRatedTaxable: 0,
      totalOutwardTaxable: b2bTaxable + b2cTaxable + exportTaxable,
      totalOutwardTax,
      outwardCGST, outwardSGST, outwardIGST,
      itcCGST, itcSGST, itcIGST, totalITC,
      cgstPayable, sgstPayable, igstPayable, totalPayable,
    })
  }

  function exportCSV() {
    const rows = [
      ['GSTR-3B Summary', selectedPeriod],
      [],
      ['3.1 OUTWARD SUPPLIES'],
      ['Nature', 'Taxable Value', 'Tax'],
      ['B2B Supplies', data.b2bTaxable, data.b2bTax],
      ['B2C Supplies', data.b2cTaxable, data.b2cTax],
      ['Export/SEZ', data.exportTaxable, data.exportTax],
      ['Total', data.totalOutwardTaxable, data.totalOutwardTax],
      [],
      ['TAX BREAKUP - OUTPUT'],
      ['CGST', data.outwardCGST],
      ['SGST', data.outwardSGST],
      ['IGST', data.outwardIGST],
      [],
      ['4. INPUT TAX CREDIT'],
      ['CGST ITC', data.itcCGST],
      ['SGST ITC', data.itcSGST],
      ['IGST ITC', data.itcIGST],
      ['Total ITC', data.totalITC],
      [],
      ['6. NET TAX PAYABLE'],
      ['CGST Payable', data.cgstPayable],
      ['SGST Payable', data.sgstPayable],
      ['IGST Payable', data.igstPayable],
      ['Total Payable', data.totalPayable],
    ]
    const csv = rows.map(r => r.join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `GSTR3B-${selectedPeriod}.csv`
    a.click()
  }

  const sectionStyle = {
    background: 'white', border: '1px solid #e2e8f0',
    borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem'
  }

  const sectionTitle = (num: string, title: string) => (
    <div style={{
      fontSize: '13px', fontWeight: '700', color: '#374151',
      marginBottom: '1rem', paddingBottom: '8px',
      borderBottom: '1px solid #f1f5f9'
    }}>
      <span style={{
        background: '#2563eb', color: 'white',
        padding: '2px 8px', borderRadius: '4px',
        marginRight: '8px', fontSize: '12px'
      }}>{num}</span>
      {title}
    </div>
  )

  const row = (label: string, value: number, bold = false, highlight = false) => (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: '8px 0', fontSize: '13px',
      borderBottom: '1px solid #f8fafc',
      background: highlight ? '#fffbeb' : 'transparent',
      fontWeight: bold ? '700' : '400'
    }}>
      <span style={{ color: bold ? '#1e293b' : '#374151' }}>{label}</span>
      <span style={{ color: highlight ? '#dc2626' : bold ? '#1e293b' : '#374151' }}>
        ₹{formatINR(value)}
      </span>
    </div>
  )

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ padding: '2rem', maxWidth: '800px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            GSTR-3B
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            Monthly summary return — tax liability and ITC
          </p>
        </div>
        <div className="toolbar" style={{ display: 'flex', gap: '8px' }}>
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

      {/* 3.1 Outward supplies */}
      <div className="responsive-table" style={sectionStyle}>
        {sectionTitle('3.1', 'Details of Outward Supplies and Inward Supplies liable to Reverse Charge')}
        <div className="table-header" style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: '8px', padding: '8px 0',
          fontSize: '12px', fontWeight: '600', color: '#94a3b8',
          borderBottom: '1px solid #f1f5f9', marginBottom: '4px'
        }}>
          <span>Nature of Supplies</span>
          <span style={{ textAlign: 'right' as const }}>Taxable Value</span>
          <span style={{ textAlign: 'right' as const }}>IGST</span>
          <span style={{ textAlign: 'right' as const }}>CGST</span>
          <span style={{ textAlign: 'right' as const }}>SGST/UTGST</span>
        </div>

        {[
          {
            label: '(a) Outward taxable supplies (other than zero rated, nil & exempted)',
            taxable: data.b2bTaxable + data.b2cTaxable,
            igst: data.outwardIGST,
            cgst: data.outwardCGST,
            sgst: data.outwardSGST
          },
          {
            label: '(b) Outward taxable supplies (zero rated)',
            taxable: data.exportTaxable,
            igst: data.exportTax,
            cgst: 0, sgst: 0
          },
          {
            label: '(c) Other outward supplies (Nil rated, exempted)',
            taxable: data.nilRatedTaxable,
            igst: 0, cgst: 0, sgst: 0
          },
        ].map((r, i) => (
          <div key={i} className="table-row" style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
            gap: '8px', padding: '8px 0',
            fontSize: '12px', borderBottom: '1px solid #f8fafc'
          }}>
            <span data-label="Nature of Supplies" style={{ color: '#374151' }}>{r.label}</span>
            <span data-label="Taxable Value" style={{ textAlign: 'right' as const }}>₹{formatINR(r.taxable)}</span>
            <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.igst)}</span>
            <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.cgst)}</span>
            <span data-label="SGST/UTGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.sgst)}</span>
          </div>
        ))}

        <div className="table-row" style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: '8px', padding: '10px 0 0',
          fontSize: '13px', fontWeight: '700', color: '#1e293b'
        }}>
          <span>Total</span>
          <span data-label="Taxable Value" style={{ textAlign: 'right' as const }}>₹{formatINR(data.totalOutwardTaxable)}</span>
          <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.outwardIGST)}</span>
          <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.outwardCGST)}</span>
          <span data-label="SGST/UTGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.outwardSGST)}</span>
        </div>
      </div>

      {/* Section 4 — ITC */}
      <div className="responsive-table" style={sectionStyle}>
        {sectionTitle('4', 'Eligible ITC')}
        <div className="table-header" style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: '8px', padding: '8px 0',
          fontSize: '12px', fontWeight: '600', color: '#94a3b8',
          borderBottom: '1px solid #f1f5f9', marginBottom: '4px'
        }}>
          <span>Details</span>
          <span style={{ textAlign: 'right' as const }}>IGST</span>
          <span style={{ textAlign: 'right' as const }}>CGST</span>
          <span style={{ textAlign: 'right' as const }}>SGST/UTGST</span>
        </div>
        <div className="table-row" style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: '8px', padding: '8px 0',
          fontSize: '12px', borderBottom: '1px solid #f8fafc'
        }}>
          <span data-label="Details" style={{ color: '#374151' }}>(A) ITC Available — Inputs (Purchases)</span>
          <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcIGST)}</span>
          <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcCGST)}</span>
          <span data-label="SGST/UTGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcSGST)}</span>
        </div>
        <div className="table-row" style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: '8px', padding: '10px 0 0',
          fontSize: '13px', fontWeight: '700', color: '#059669'
        }}>
          <span>Total ITC Available</span>
          <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcIGST)}</span>
          <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcCGST)}</span>
          <span data-label="SGST/UTGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.itcSGST)}</span>
        </div>
      </div>

      {/* Section 6 — Net payable */}
      <div className="responsive-table" style={sectionStyle}>
        {sectionTitle('6.1', 'Payment of Tax')}
        <div className="table-header" style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: '8px', padding: '8px 0',
          fontSize: '12px', fontWeight: '600', color: '#94a3b8',
          borderBottom: '1px solid #f1f5f9', marginBottom: '4px'
        }}>
          <span>Description</span>
          <span style={{ textAlign: 'right' as const }}>IGST</span>
          <span style={{ textAlign: 'right' as const }}>CGST</span>
          <span style={{ textAlign: 'right' as const }}>SGST</span>
          <span style={{ textAlign: 'right' as const }}>Total</span>
        </div>

        {[
          {
            label: 'Tax payable',
            igst: data.outwardIGST, cgst: data.outwardCGST,
            sgst: data.outwardSGST, total: data.totalOutwardTax
          },
          {
            label: 'ITC to be used',
            igst: data.itcIGST, cgst: data.itcCGST,
            sgst: data.itcSGST, total: data.totalITC
          },
        ].map((r, i) => (
          <div key={i} className="table-row" style={{
            display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
            gap: '8px', padding: '8px 0',
            fontSize: '12px', borderBottom: '1px solid #f8fafc'
          }}>
            <span data-label="Description" style={{ color: '#374151' }}>{r.label}</span>
            <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.igst)}</span>
            <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.cgst)}</span>
            <span data-label="SGST" style={{ textAlign: 'right' as const }}>₹{formatINR(r.sgst)}</span>
            <span data-label="Total" style={{ textAlign: 'right' as const, fontWeight: '600' }}>
              ₹{formatINR(r.total)}
            </span>
          </div>
        ))}

        <div className="table-row" style={{
          display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: '8px', padding: '12px 0 0',
          fontSize: '14px', fontWeight: '700',
          color: data.totalPayable > 0 ? '#dc2626' : '#166534',
          borderTop: '2px solid #e2e8f0', marginTop: '8px'
        }}>
          <span>Net Tax Payable (Cash)</span>
          <span data-label="IGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.igstPayable)}</span>
          <span data-label="CGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.cgstPayable)}</span>
          <span data-label="SGST" style={{ textAlign: 'right' as const }}>₹{formatINR(data.sgstPayable)}</span>
          <span data-label="Total" style={{ textAlign: 'right' as const }}>₹{formatINR(data.totalPayable)}</span>
        </div>
      </div>

      {/* Warning */}
      <div style={{
        padding: '12px 16px',
        background: '#fef9c3', border: '1px solid #fde68a',
        borderRadius: '8px', fontSize: '12px', color: '#854d0e'
      }}>
        ⚠️ <strong>Important:</strong> This is a summary prepared from your books.
        The actual GSTR-3B filing must be done on the GST portal (gstn.gov.in).
        Verify all figures before filing. ITC eligibility depends on conditions
        under Section 16 of the CGST Act — consult your CA for final figures.
      </div>
    </div>
  )
}