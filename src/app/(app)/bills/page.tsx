'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { SearchInput } from '@/components/ui'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  determineGSTType,
  calculateLineItem,
  calculateInvoiceTotals,
  formatINR,
  type LineItemResult
} from '@/lib/gst-engine'
import { createPurchaseBill } from '@/lib/create-bill'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'

const inputStyle = {
  width: '100%', padding: '8px 10px',
  border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', outline: 'none',
  color: '#1e293b', background: 'white',
}

const labelStyle = {
  display: 'block' as const,
  fontSize: '12px', fontWeight: '500' as const,
  color: '#374151', marginBottom: '4px',
}

type LineItem = {
  product_id: string
  item_name: string
  hsn_sac: string
  quantity: string
  unit: string
  rate: string
  discount_percent: string
  gst_rate: string
  cess_rate: string
  itc_eligible: boolean
  calculated: LineItemResult | null
}

const emptyLine = (): LineItem => ({
  product_id: '', item_name: '', hsn_sac: '',
  quantity: '1', unit: 'NOS', rate: '',
  discount_percent: '0', gst_rate: '18', cess_rate: '0',
  itc_eligible: true, calculated: null,
})

function BillsPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [bills, setBills] = useState<any[]>([])
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vendors, setVendors] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [search, setSearch] = useSearchDeepLink()

  // Form state
  const [vendorId, setVendorId] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [vendorGstin, setVendorGstin] = useState('')
  const [vendorStateCode, setVendorStateCode] = useState('')
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [placeOfSupplyName, setPlaceOfSupplyName] = useState('')
  const [isReverseCharge, setIsReverseCharge] = useState(false)
  const [itcEligible, setItcEligible] = useState(true)
  const [notes, setNotes] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()])
  const [totals, setTotals] = useState<any>(null)
  const [gstType, setGstType] = useState<'cgst_sgst' | 'igst'>('cgst_sgst')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(state_code)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)

      const org = membership.organizations as any
      setOrgStateCode(org?.state_code || '')

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      if (gstReg?.state_code) setOrgStateCode(gstReg.state_code)

      const { data: billsData } = await supabase
        .from('purchase_bills')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .order('created_at', { ascending: false })

      setBills(billsData || [])

      const { data: vendorsData } = await supabase
        .from('vendors')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      const { data: productsData } = await supabase
        .from('products')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      setVendors(vendorsData || [])
      setProducts(productsData || [])
      setLoading(false)
    }
    load()
  }, [])

  // Recalculate GST on line item changes
  useEffect(() => {
    if (!orgStateCode || !placeOfSupply) return

    const gt = determineGSTType(orgStateCode, placeOfSupply, 'b2b')
    setGstType(gt)

    const calculated = lineItems.map(item => {
      const qty = parseFloat(item.quantity) || 0
      const rate = parseFloat(item.rate) || 0
      if (!qty || !rate) return { ...item, calculated: null }

      const result = calculateLineItem({
        quantity: qty, rate,
        discount_percent: parseFloat(item.discount_percent) || 0,
        gst_rate: parseFloat(item.gst_rate) || 0,
        cess_rate: parseFloat(item.cess_rate) || 0,
      }, gt)
      return { ...item, calculated: result }
    })

    setLineItems(calculated)

    const validItems = calculated
      .map(i => i.calculated)
      .filter(Boolean) as LineItemResult[]

    setTotals(validItems.length > 0 ? calculateInvoiceTotals(validItems) : null)
  }, [
    orgStateCode, placeOfSupply,
    JSON.stringify(lineItems.map(i => ({
      q: i.quantity, r: i.rate,
      d: i.discount_percent, g: i.gst_rate
    })))
  ])

  function handleVendorChange(id: string) {
    const vendor = vendors.find(v => v.id === id)
    if (!vendor) return
    setVendorId(id)
    setVendorName(vendor.name)
    setVendorGstin(vendor.gstin || '')
    setVendorStateCode(vendor.state_code || '')
    if (vendor.state_code) {
      setPlaceOfSupply(vendor.state_code)
      const s = INDIAN_STATES.find(x => x.value === vendor.state_code)
      setPlaceOfSupplyName(s?.label || '')
    }
  }

  function handleProductSelect(index: number, productId: string) {
    const product = products.find(p => p.id === productId)
    if (!product) return
    const updated = [...lineItems]
    updated[index] = {
      ...updated[index],
      product_id: productId,
      item_name: product.name,
      hsn_sac: product.hsn_sac || '',
      unit: product.unit || 'NOS',
      rate: String(product.purchase_price || product.selling_price || ''),
      gst_rate: String(product.gst_rate || 18),
      cess_rate: String(product.cess_rate || 0),
    }
    setLineItems(updated)
  }

  function updateLine(index: number, field: string, value: any) {
    const updated = [...lineItems]
    updated[index] = { ...updated[index], [field]: value }
    setLineItems(updated)
  }

  function resetForm() {
    setVendorId(''); setVendorName(''); setVendorGstin('')
    setVendorStateCode(''); setBillNumber(''); setDueDate('')
    setPlaceOfSupply(''); setPlaceOfSupplyName('')
    setIsReverseCharge(false); setItcEligible(true); setNotes('')
    setLineItems([emptyLine()]); setTotals(null); setError('')
    setBillDate(new Date().toISOString().split('T')[0])
  }

  async function handleSave() {
    if (!vendorId) { setError('Please select a vendor'); return }
    if (!billNumber) { setError('Please enter vendor bill number'); return }
    if (!placeOfSupply) { setError('Please select place of supply'); return }

    const validItems = lineItems.filter(i =>
      i.item_name && parseFloat(i.rate) > 0 && parseFloat(i.quantity) > 0
    )
    if (validItems.length === 0) {
      setError('Please add at least one line item')
      return
    }
    if (!totals) { setError('Please complete line items'); return }

    setSaving(true)
    setError('')

    try {
      await createPurchaseBill(supabase, orgId, {
        bill_number: billNumber,
        bill_date: billDate,
        due_date: dueDate || null,
        vendor_id: vendorId,
        vendor_name: vendorName,
        vendor_gstin: vendorGstin,
        vendor_state_code: vendorStateCode,
        place_of_supply: placeOfSupply,
        place_of_supply_name: placeOfSupplyName,
        is_reverse_charge: isReverseCharge,
        subtotal: totals.subtotal,
        discount_amount: totals.discount_amount,
        taxable_amount: totals.taxable_amount,
        cgst_amount: totals.cgst_amount,
        sgst_amount: totals.sgst_amount,
        igst_amount: totals.igst_amount,
        cess_amount: totals.cess_amount,
        total_tax: totals.total_tax,
        round_off: totals.round_off,
        grand_total: totals.grand_total,
        itc_eligible: itcEligible,
        amount_paid: 0,
        balance_due: totals.grand_total,
        payment_status: 'unpaid',
        notes,
        status: 'active',
      }, validItems.map(item => ({
        product_id: item.product_id || null,
        item_name: item.item_name,
        hsn_sac: item.hsn_sac,
        quantity: parseFloat(item.quantity),
        unit: item.unit,
        rate: parseFloat(item.rate),
        discount_percent: parseFloat(item.discount_percent) || 0,
        discount_amount: item.calculated?.discount_amount || 0,
        taxable_value: item.calculated?.taxable_value || 0,
        gst_rate: parseFloat(item.gst_rate),
        cgst_rate: item.calculated?.cgst_rate || 0,
        sgst_rate: item.calculated?.sgst_rate || 0,
        igst_rate: item.calculated?.igst_rate || 0,
        cgst_amount: item.calculated?.cgst_amount || 0,
        sgst_amount: item.calculated?.sgst_amount || 0,
        igst_amount: item.calculated?.igst_amount || 0,
        cess_rate: parseFloat(item.cess_rate) || 0,
        cess_amount: item.calculated?.cess_amount || 0,
        total_amount: item.calculated?.total_amount || 0,
        itc_eligible: item.itc_eligible,
      })))

      const { data: updatedBills } = await supabase
        .from('purchase_bills')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })

      setBills(updatedBills || [])
      setShowForm(false)
      resetForm()
    } catch (err: any) {
      setError(err.message || 'Failed to save bill')
    } finally {
      setSaving(false)
    }
  }

  async function markBillPaid(bill: any) {
    await supabase
      .from('purchase_bills')
      .update({
        payment_status: 'paid',
        amount_paid: bill.grand_total,
        balance_due: 0
      })
      .eq('id', bill.id)

    setBills(prev => prev.map(b =>
      b.id === bill.id
        ? { ...b, payment_status: 'paid', amount_paid: bill.grand_total, balance_due: 0 }
        : b
    ))
  }

  async function cancelBill(bill: any) {
    if (!confirm(`Cancel bill ${bill.bill_number}? It will be excluded from reports, GSTR-3B and ITC.`)) return
    await supabase
      .from('purchase_bills')
      .update({ status: 'cancelled' })
      .eq('id', bill.id)

    setBills(prev => prev.map(b =>
      b.id === bill.id ? { ...b, status: 'cancelled' } : b
    ))
  }

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  const activeBills = bills.filter(b => b.status !== 'cancelled')
  const visibleBills = bills.filter(b => matchesAny(search, [b.bill_number, b.vendor_name]))

  return (
    <div className="page-container" style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Purchase Bills
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {activeBills.length} bill{activeBills.length !== 1 ? 's' : ''}
            {bills.length !== activeBills.length && ` · ${bills.length - activeBills.length} cancelled`}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          style={{
            padding: '9px 18px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '14px',
            fontWeight: '600', cursor: 'pointer'
          }}
        >
          + Add Bill
        </button>
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Bill number or vendor…"
        ariaLabel="Search purchase bills"
        style={{ maxWidth: 380, marginBottom: '1.25rem' }}
      />

      {/* ITC Summary card */}
      {bills.length > 0 && (
        <div className="metric-grid" style={{
          display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '1rem', marginBottom: '1.5rem'
        }}>
          {[
            {
              label: 'Total Purchases',
              value: activeBills.reduce((s, b) => s + Number(b.grand_total), 0),
              color: '#2563eb'
            },
            {
              label: 'Total GST Paid',
              value: activeBills.reduce((s, b) => s + Number(b.total_tax), 0),
              color: '#7c3aed'
            },
            {
              label: 'ITC Available',
              value: activeBills
                .filter(b => b.itc_eligible)
                .reduce((s, b) => s + Number(b.total_tax), 0),
              color: '#059669'
            },
            {
              label: 'Amount Payable',
              value: activeBills.reduce((s, b) => s + Number(b.balance_due), 0),
              color: '#dc2626'
            },
          ].map(card => (
            <div key={card.label} style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '1rem',
              borderTop: `3px solid ${card.color}`
            }}>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}>
                {card.label}
              </div>
              <div style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                ₹{formatINR(card.value)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bills list */}
      {bills.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '3rem',
          textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '36px', marginBottom: '1rem' }}>🛒</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>
            No purchase bills yet
          </div>
          <div style={{ fontSize: '13px' }}>
            Add vendor bills to track purchases and claim ITC
          </div>
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', overflow: 'hidden'
        }}>
          <div className="table-header" style={{
            display: 'grid',
            gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 160px',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Bill No.</span>
            <span>Vendor</span>
            <span>Date</span>
            <span>Amount</span>
            <span>ITC</span>
            <span>Status</span>
            <span>Action</span>
          </div>

          {visibleBills.map(bill => (
            <div key={bill.id} className="table-row" style={{
              display: 'grid',
              gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr 160px',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Bill No." style={{ fontWeight: '600', color: '#374151' }}>
                {bill.bill_number}
              </div>
              <div data-label="Vendor" style={{ color: '#1e293b' }}>{bill.vendor_name}</div>
              <div data-label="Date" style={{ color: '#64748b' }}>
                {new Date(bill.bill_date).toLocaleDateString('en-IN')}
              </div>
              <div data-label="Amount" style={{ fontWeight: '500' }}>
                ₹{formatINR(bill.grand_total)}
              </div>
              <div data-label="ITC">
                <span style={{
                  fontSize: '11px', padding: '2px 8px',
                  borderRadius: '99px',
                  background: bill.itc_eligible ? '#f0fdf4' : '#f8fafc',
                  color: bill.itc_eligible ? '#166534' : '#94a3b8'
                }}>
                  {bill.itc_eligible
                    ? `✓ ₹${formatINR(bill.total_tax)}`
                    : 'Not eligible'}
                </span>
              </div>
              <div data-label="Status">
                <span style={{
                  fontSize: '11px', padding: '2px 8px',
                  borderRadius: '99px',
                  background: bill.status === 'cancelled' ? '#f8fafc'
                    : bill.payment_status === 'paid' ? '#f0fdf4' : '#fef2f2',
                  color: bill.status === 'cancelled' ? '#94a3b8'
                    : bill.payment_status === 'paid' ? '#166534' : '#dc2626'
                }}>
                  {bill.status === 'cancelled' ? 'cancelled' : bill.payment_status}
                </span>
              </div>
              <div data-label="Action" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {bill.status !== 'cancelled' && (
                  <>
                    {bill.payment_status !== 'paid' && (
                      <button
                        onClick={() => markBillPaid(bill)}
                        style={{
                          padding: '4px 10px', background: '#f0fdf4',
                          border: '1px solid #bbf7d0', borderRadius: '6px',
                          fontSize: '11px', cursor: 'pointer', color: '#166534',
                          fontWeight: '500'
                        }}
                      >
                        Mark Paid
                      </button>
                    )}
                    <button
                      onClick={() => cancelBill(bill)}
                      style={{
                        padding: '4px 10px', background: 'white',
                        border: '1px solid #e2e8f0', borderRadius: '6px',
                        fontSize: '11px', cursor: 'pointer', color: '#64748b',
                        fontWeight: '500'
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          {!visibleBills.length && (
            <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '13px' }}>
              No bill matches “{search}”
            </div>
          )}
        </div>
      )}

      {/* Add Bill Form Modal */}
      {showForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start',
          justifyContent: 'center', zIndex: 100,
          padding: '2rem 1rem', overflowY: 'auto'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px',
            padding: '2rem', width: '100%', maxWidth: '820px',
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '1.5rem'
            }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                Add Purchase Bill
              </h2>
              <button
                onClick={() => { setShowForm(false); resetForm() }}
                style={{
                  background: 'none', border: 'none',
                  fontSize: '20px', cursor: 'pointer', color: '#94a3b8'
                }}
              >✕</button>
            </div>

            {/* Vendor & Bill details */}
            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Vendor *</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={vendorId}
                  onChange={e => handleVendorChange(e.target.value)}
                >
                  <option value="">Select vendor...</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Vendor GSTIN</label>
                <input
                  style={{ ...inputStyle, background: '#f8fafc', fontFamily: 'monospace' }}
                  value={vendorGstin} readOnly placeholder="Auto-filled" />
              </div>
            </div>

            <div className="form-grid-3" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Vendor Bill Number *</label>
                <input
                  style={inputStyle}
                  value={billNumber}
                  onChange={e => setBillNumber(e.target.value)}
                  placeholder="Bill/Invoice no. from vendor" />
              </div>
              <div>
                <label style={labelStyle}>Bill Date *</label>
                <input
                  style={inputStyle} type="date"
                  value={billDate}
                  onChange={e => setBillDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Due Date</label>
                <input
                  style={inputStyle} type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)} />
              </div>
            </div>

            <div className="form-grid-2" style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr',
              gap: '1rem', marginBottom: '1rem'
            }}>
              <div>
                <label style={labelStyle}>Place of Supply *</label>
                <select
                  style={{ ...inputStyle, cursor: 'pointer' }}
                  value={placeOfSupply}
                  onChange={e => {
                    setPlaceOfSupply(e.target.value)
                    const s = INDIAN_STATES.find(x => x.value === e.target.value)
                    setPlaceOfSupplyName(s?.label || '')
                  }}
                >
                  <option value="">Select state...</option>
                  {INDIAN_STATES.map(s => (
                    <option key={s.value} value={s.value}>
                      {s.value} — {s.label}
                    </option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: '8px', justifyContent: 'flex-end' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={isReverseCharge}
                    onChange={e => setIsReverseCharge(e.target.checked)} />
                  <span style={{ fontSize: '13px', color: '#374151' }}>Reverse Charge</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={itcEligible}
                    onChange={e => setItcEligible(e.target.checked)} />
                  <span style={{ fontSize: '13px', color: '#374151' }}>ITC Eligible</span>
                </label>
              </div>
            </div>

            {/* GST type indicator */}
            {placeOfSupply && orgStateCode && (
              <div style={{
                padding: '8px 12px', borderRadius: '6px', marginBottom: '1rem',
                background: gstType === 'cgst_sgst' ? '#f0fdf4' : '#eff6ff',
                border: `1px solid ${gstType === 'cgst_sgst' ? '#bbf7d0' : '#bfdbfe'}`,
                fontSize: '12px',
                color: gstType === 'cgst_sgst' ? '#166534' : '#1d4ed8',
              }}>
                {gstType === 'cgst_sgst'
                  ? '✓ Same state — CGST + SGST'
                  : '✓ Interstate — IGST'}
              </div>
            )}

            {/* Line items */}
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: '8px', padding: '1rem', marginBottom: '1rem'
            }}>
              <div style={{
                fontSize: '12px', fontWeight: '600', color: '#374151',
                marginBottom: '10px'
              }}>
                Line Items
              </div>

              <div className="line-items-head" style={{
                display: 'grid',
                gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 0.6fr 1fr 32px',
                gap: '6px', marginBottom: '6px',
                fontSize: '11px', fontWeight: '600', color: '#94a3b8'
              }}>
                <span>Item</span><span>HSN/SAC</span><span>Qty</span>
                <span>Rate</span><span>Disc%</span><span>GST%</span>
                <span>Amount</span><span></span>
              </div>

              {lineItems.map((item, index) => (
                <div key={index} style={{ marginBottom: '8px' }}>
                  <div className="line-item-row" style={{
                    display: 'grid',
                    gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 0.6fr 1fr 32px',
                    gap: '6px', alignItems: 'center'
                  }}>
                    <div className="li-full" data-label="Item">
                      <select
                        style={{ ...inputStyle, marginBottom: '4px', cursor: 'pointer', fontSize: '12px' }}
                        value={item.product_id}
                        onChange={e => handleProductSelect(index, e.target.value)}
                      >
                        <option value="">Select product...</option>
                        {products.map(p => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                      <input
                        style={{ ...inputStyle, fontSize: '12px' }}
                        value={item.item_name}
                        onChange={e => updateLine(index, 'item_name', e.target.value)}
                        placeholder="Item name" />
                    </div>
                    <div data-label="HSN/SAC">
                      <input style={{ ...inputStyle, fontSize: '12px' }}
                        value={item.hsn_sac}
                        onChange={e => updateLine(index, 'hsn_sac', e.target.value)}
                        placeholder="HSN/SAC" />
                    </div>
                    <div data-label="Qty">
                      <input style={{ ...inputStyle, fontSize: '12px' }}
                        type="number" value={item.quantity}
                        onChange={e => updateLine(index, 'quantity', e.target.value)}
                        min="0" step="0.001" />
                    </div>
                    <div data-label="Rate (₹)">
                      <input style={{ ...inputStyle, fontSize: '12px' }}
                        type="number" value={item.rate}
                        onChange={e => updateLine(index, 'rate', e.target.value)}
                        placeholder="0.00" min="0" step="0.01" />
                    </div>
                    <div data-label="Disc %">
                      <input style={{ ...inputStyle, fontSize: '12px' }}
                        type="number" value={item.discount_percent}
                        onChange={e => updateLine(index, 'discount_percent', e.target.value)}
                        min="0" max="100" />
                    </div>
                    <div data-label="GST %">
                      <select style={{ ...inputStyle, fontSize: '12px', cursor: 'pointer' }}
                        value={item.gst_rate}
                        onChange={e => updateLine(index, 'gst_rate', e.target.value)}>
                        {GST_RATES.map(r => (
                          <option key={r} value={r}>{r}%</option>
                        ))}
                      </select>
                    </div>
                    <div data-label="Amount" style={{
                      padding: '8px 10px', background: 'white',
                      border: '1px solid #e2e8f0', borderRadius: '6px',
                      fontSize: '12px', fontWeight: '500', color: '#1e293b',
                      textAlign: 'right' as const
                    }}>
                      {item.calculated
                        ? `₹${formatINR(item.calculated.total_amount)}`
                        : '—'}
                    </div>
                    <div className="li-full" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <button
                        onClick={() => setLineItems(lineItems.filter((_, i) => i !== index))}
                        disabled={lineItems.length === 1}
                        style={{
                          width: '28px', height: '28px',
                          border: '1px solid #fecaca', background: '#fef2f2',
                          borderRadius: '6px', cursor: 'pointer',
                          color: '#dc2626', fontSize: '14px',
                          opacity: lineItems.length === 1 ? 0.4 : 1
                        }}
                      >×</button>
                    </div>
                  </div>
                  {item.calculated && (
                    <div style={{
                      fontSize: '11px', color: '#64748b',
                      marginTop: '2px', paddingLeft: '4px',
                      display: 'flex', gap: '12px'
                    }}>
                      <span>Taxable: ₹{formatINR(item.calculated.taxable_value)}</span>
                      {item.calculated.cgst_amount > 0 && (
                        <span>CGST {item.calculated.cgst_rate}%: ₹{formatINR(item.calculated.cgst_amount)}</span>
                      )}
                      {item.calculated.sgst_amount > 0 && (
                        <span>SGST {item.calculated.sgst_rate}%: ₹{formatINR(item.calculated.sgst_amount)}</span>
                      )}
                      {item.calculated.igst_amount > 0 && (
                        <span>IGST {item.calculated.igst_rate}%: ₹{formatINR(item.calculated.igst_amount)}</span>
                      )}
                    </div>
                  )}
                </div>
              ))}

              <button
                onClick={() => setLineItems([...lineItems, emptyLine()])}
                style={{
                  marginTop: '6px', padding: '7px 14px',
                  background: 'white', border: '1px dashed #cbd5e1',
                  borderRadius: '6px', fontSize: '12px',
                  cursor: 'pointer', color: '#2563eb', fontWeight: '500'
                }}
              >
                + Add Line
              </button>
            </div>

            {/* Totals */}
            {totals && (
              <div style={{
                display: 'flex', justifyContent: 'flex-end',
                marginBottom: '1rem'
              }}>
                <div style={{
                  background: '#f8fafc', border: '1px solid #e2e8f0',
                  borderRadius: '8px', padding: '1rem', width: '280px'
                }}>
                  {[
                    { label: 'Taxable Amount', value: totals.taxable_amount, show: true },
                    { label: 'CGST', value: totals.cgst_amount, show: totals.cgst_amount > 0 },
                    { label: 'SGST', value: totals.sgst_amount, show: totals.sgst_amount > 0 },
                    { label: 'IGST', value: totals.igst_amount, show: totals.igst_amount > 0 },
                    { label: 'Round Off', value: totals.round_off, show: totals.round_off !== 0 },
                  ].filter(r => r.show).map(row => (
                    <div key={row.label} style={{
                      display: 'flex', justifyContent: 'space-between',
                      padding: '4px 0', fontSize: '13px',
                      borderBottom: '1px solid #e2e8f0', color: '#64748b'
                    }}>
                      <span>{row.label}</span>
                      <span>₹{formatINR(Math.abs(row.value))}</span>
                    </div>
                  ))}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between',
                    padding: '8px 0 0', fontSize: '15px',
                    fontWeight: '700', color: '#1e293b'
                  }}>
                    <span>Grand Total</span>
                    <span style={{ color: '#2563eb' }}>
                      ₹{formatINR(totals.grand_total)}
                    </span>
                  </div>
                  {itcEligible && (
                    <div style={{
                      marginTop: '8px', padding: '6px 10px',
                      background: '#f0fdf4', border: '1px solid #bbf7d0',
                      borderRadius: '6px', fontSize: '12px', color: '#166534'
                    }}>
                      ✓ ITC Available: ₹{formatINR(totals.total_tax)}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Notes</label>
              <textarea
                style={{ ...inputStyle, height: '60px', resize: 'vertical' as const }}
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Any notes..." />
            </div>

            {error && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca',
                color: '#dc2626', padding: '10px 12px',
                borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
              }}>{error}</div>
            )}

            <div className="btn-group" style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  flex: 1, padding: '11px',
                  background: saving ? '#93c5fd' : '#2563eb',
                  color: 'white', border: 'none',
                  borderRadius: '8px', fontSize: '14px',
                  fontWeight: '600',
                  cursor: saving ? 'not-allowed' : 'pointer'
                }}
              >
                {saving ? 'Saving...' : 'Save Purchase Bill'}
              </button>
              <button
                onClick={() => { setShowForm(false); resetForm() }}
                style={{
                  padding: '11px 20px', background: 'white',
                  color: '#374151', border: '1px solid #e2e8f0',
                  borderRadius: '8px', fontSize: '14px', cursor: 'pointer'
                }}
              >Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function BillsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p></div>}>
      <BillsPageInner />
    </Suspense>
  )
}
