'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { SearchInput } from '@/components/ui'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  determineGSTType, calculateLineItem,
  calculateInvoiceTotals,
  formatINR, type LineItemResult
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'
import { createDebitNote } from '@/lib/creditnote'
import SealNotice from '@/components/SealNotice'
import { plural } from '@/lib/format'

const inputStyle = {
  width: '100%', padding: '8px 10px',
  border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', outline: 'none', color: '#1e293b', background: 'white',
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
  gst_rate: string
  calculated: LineItemResult | null
}

const emptyLine = (): LineItem => ({
  product_id: '', item_name: '', hsn_sac: '',
  quantity: '1', unit: 'NOS', rate: '',
  gst_rate: '18', calculated: null,
})

const DEBIT_REASONS = [
  { value: 'purchase_return', label: 'Purchase Return' },
  { value: 'price_correction', label: 'Price Correction' },
  { value: 'defective_goods', label: 'Defective Goods Returned' },
  { value: 'short_supply', label: 'Short Supply' },
  { value: 'other', label: 'Other' },
]

function DebitNotesPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [debitNotes, setDebitNotes] = useState<any[]>([])
  const [search, setSearch] = useSearchDeepLink()
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [vendors, setVendors] = useState<any[]>([])
  const [bills, setBills] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])

  // Form state
  const [vendorId, setVendorId] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [vendorGstin, setVendorGstin] = useState('')
  const [vendorStateCode, setVendorStateCode] = useState('')
  const [billId, setBillId] = useState('')
  const [billNumber, setBillNumber] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [placeOfSupplyName, setPlaceOfSupplyName] = useState('')
  const [reason, setReason] = useState('purchase_return')
  const [debitDate, setDebitDate] = useState(new Date().toISOString().split('T')[0])
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

      const [{ data: dnData }, { data: vendorData }, { data: billData }, { data: prodData }] = await Promise.all([
        supabase.from('debit_notes').select('*').eq('organization_id', membership.organization_id).order('created_at', { ascending: false }),
        supabase.from('vendors').select('*').eq('organization_id', membership.organization_id).eq('is_active', true).order('name'),
        supabase.from('purchase_bills').select('id, bill_number, vendor_name, vendor_id, place_of_supply, place_of_supply_name, vendor_state_code, vendor_gstin').eq('organization_id', membership.organization_id).neq('status', 'cancelled').order('bill_date', { ascending: false }),
        supabase.from('products').select('*').eq('organization_id', membership.organization_id).eq('is_active', true).order('name'),
      ])

      setDebitNotes(dnData || [])
      setVendors(vendorData || [])
      setBills(billData || [])
      setProducts(prodData || [])
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!orgStateCode || !placeOfSupply) return
    const gt = determineGSTType(orgStateCode, placeOfSupply, 'b2b')
    setGstType(gt)

    const calculated = lineItems.map(item => {
      const qty = parseFloat(item.quantity) || 0
      const rate = parseFloat(item.rate) || 0
      if (!qty || !rate) return { ...item, calculated: null }
      const result = calculateLineItem({ quantity: qty, rate, gst_rate: parseFloat(item.gst_rate) || 0 }, gt)
      return { ...item, calculated: result }
    })
    setLineItems(calculated)

    const validItems = calculated.map(i => i.calculated).filter(Boolean) as LineItemResult[]
    setTotals(validItems.length > 0 ? calculateInvoiceTotals(validItems) : null)
  }, [
    orgStateCode, placeOfSupply,
    JSON.stringify(lineItems.map(i => ({ q: i.quantity, r: i.rate, g: i.gst_rate })))
  ])

  function handleBillSelect(id: string) {
    const bill = bills.find(b => b.id === id)
    if (!bill) return
    setBillId(id)
    setBillNumber(bill.bill_number)
    setVendorId(bill.vendor_id || '')
    setVendorName(bill.vendor_name)
    setVendorGstin(bill.vendor_gstin || '')
    setVendorStateCode(bill.vendor_state_code || '')
    setPlaceOfSupply(bill.place_of_supply || '')
    setPlaceOfSupplyName(bill.place_of_supply_name || '')
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
    }
    setLineItems(updated)
  }

  function resetForm() {
    setVendorId(''); setVendorName(''); setVendorGstin('')
    setVendorStateCode(''); setBillId(''); setBillNumber('')
    setPlaceOfSupply(''); setPlaceOfSupplyName('')
    setReason('purchase_return'); setNotes('')
    setLineItems([emptyLine()]); setTotals(null); setError('')
    setDebitDate(new Date().toISOString().split('T')[0])
  }

  async function handleSave() {
    if (!vendorName) { setError('Please select a bill or enter vendor details'); return }
    if (!placeOfSupply) { setError('Please select place of supply'); return }
    const validItems = lineItems.filter(i => i.item_name && parseFloat(i.rate) > 0)
    if (validItems.length === 0) { setError('Please add at least one line item'); return }
    if (!totals) { setError('Please complete line items'); return }

    setSaving(true)
    setError('')

    try {
      await createDebitNote(supabase, orgId, {
        debit_note_date: debitDate,
        status: 'active',
        bill_id: billId || null,
        bill_number: billNumber || null,
        vendor_id: vendorId || null,
        vendor_name: vendorName,
        vendor_gstin: vendorGstin,
        vendor_state_code: vendorStateCode,
        reason,
        subtotal: totals.subtotal,
        taxable_amount: totals.taxable_amount,
        cgst_amount: totals.cgst_amount,
        sgst_amount: totals.sgst_amount,
        igst_amount: totals.igst_amount,
        total_tax: totals.total_tax,
        grand_total: totals.grand_total,
        notes,
      }, validItems.map(item => ({
        product_id: item.product_id || null,
        item_name: item.item_name,
        hsn_sac: item.hsn_sac,
        quantity: parseFloat(item.quantity),
        unit: item.unit,
        rate: parseFloat(item.rate),
        taxable_value: item.calculated?.taxable_value || 0,
        gst_rate: parseFloat(item.gst_rate),
        cgst_rate: item.calculated?.cgst_rate || 0,
        sgst_rate: item.calculated?.sgst_rate || 0,
        igst_rate: item.calculated?.igst_rate || 0,
        cgst_amount: item.calculated?.cgst_amount || 0,
        sgst_amount: item.calculated?.sgst_amount || 0,
        igst_amount: item.calculated?.igst_amount || 0,
        total_amount: item.calculated?.total_amount || 0,
      })))

      const { data: updated } = await supabase
        .from('debit_notes')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
      setDebitNotes(updated || [])
      setShowForm(false)
      resetForm()
    } catch (err: any) {
      setError(err.message || 'Failed to save debit note')
    } finally {
      setSaving(false)
    }
  }

  const visible = debitNotes.filter(x => matchesAny(search, [x.debit_note_number, x.vendor_name]))

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>Debit Notes</h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {plural(debitNotes.length, 'debit note')}
          </p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true) }} style={{
          padding: '9px 18px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer'
        }}>+ New Debit Note</button>
      </div>

      {/* Info box */}
      <div style={{
        background: '#fef9c3', border: '1px solid #fde68a',
        borderRadius: '8px', padding: '10px 14px',
        fontSize: '13px', color: '#854d0e', marginBottom: '1.5rem'
      }}>
        ℹ️ <strong>Debit Notes</strong> are issued to vendors when returning purchases or when a vendor has overcharged you. They reduce your purchase liability.
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Debit note number or vendor…"
        ariaLabel="Search debit notes"
        style={{ maxWidth: 380, marginBottom: '1.25rem' }}
      />

      {/* List */}
      {debitNotes.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '40px', marginBottom: '1rem' }}>📄</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>No debit notes yet</div>
          <div style={{ fontSize: '13px' }}>Issue debit notes for purchase returns or vendor corrections</div>
        </div>
      ) : !visible.length ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '2.5rem', textAlign: 'center', color: '#94a3b8', fontSize: '13px'
        }}>
          No debit note matches “{search}”
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr 1fr 1fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Debit Note No.</span><span>Vendor</span>
            <span>Date</span><span>Against Bill</span>
            <span>Reason</span><span>Amount</span>
          </div>
          {visible.map(dn => (
            <div key={dn.id} className="table-row" style={{
              display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr 1fr 1fr',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Debit Note No." style={{ fontWeight: '600', color: '#d97706' }}>{dn.debit_note_number}</div>
              <div data-label="Vendor" style={{ color: '#1e293b' }}>{dn.vendor_name}</div>
              <div data-label="Date" style={{ color: '#64748b' }}>{new Date(dn.debit_note_date).toLocaleDateString('en-IN')}</div>
              <div data-label="Against Bill" style={{ color: '#64748b', fontSize: '12px' }}>{dn.bill_number || '—'}</div>
              <div data-label="Reason">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: '#fef9c3', color: '#854d0e'
                }}>
                  {DEBIT_REASONS.find(r => r.value === dn.reason)?.label || dn.reason || '—'}
                </span>
              </div>
              <div data-label="Amount" style={{ fontWeight: '600', color: '#d97706' }}>₹{formatINR(dn.grand_total)}</div>
            </div>
          ))}
        </div>
      )}

      {/* CREATE FORM MODAL */}
      {showForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          zIndex: 100, padding: '2rem 1rem', overflowY: 'auto'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px',
            padding: '2rem', width: '100%', maxWidth: '820px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>New Debit Note</h2>
              <button onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            {/* Against bill */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                Against Purchase Bill (optional — select to auto-fill vendor details)
              </div>
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={billId}
                onChange={e => handleBillSelect(e.target.value)}>
                <option value="">Select bill... (or fill manually below)</option>
                {bills.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.bill_number} — {b.vendor_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Debit Note Date *</label>
                <input style={inputStyle} type="date" value={debitDate}
                  onChange={e => setDebitDate(e.target.value)} />
                <SealNotice orgId={orgId} date={debitDate} />
              </div>
              <div>
                <label style={labelStyle}>Reason *</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={reason}
                  onChange={e => setReason(e.target.value)}>
                  {DEBIT_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Place of Supply *</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={placeOfSupply}
                  onChange={e => {
                    setPlaceOfSupply(e.target.value)
                    const s = INDIAN_STATES.find(x => x.value === e.target.value)
                    setPlaceOfSupplyName(s?.label || '')
                  }}>
                  <option value="">Select state...</option>
                  {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
                </select>
              </div>
            </div>

            {!billId && (
              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Vendor Name *</label>
                  <input style={inputStyle} value={vendorName}
                    onChange={e => setVendorName(e.target.value)}
                    placeholder="Vendor name" />
                </div>
                <div>
                  <label style={labelStyle}>Vendor GSTIN</label>
                  <input style={inputStyle} value={vendorGstin}
                    onChange={e => setVendorGstin(e.target.value.toUpperCase())}
                    placeholder="GSTIN (optional)" maxLength={15} />
                </div>
              </div>
            )}

            {billId && vendorName && (
              <div style={{
                background: '#fef9c3', border: '1px solid #fde68a',
                borderRadius: '8px', padding: '10px 12px', marginBottom: '1rem',
                fontSize: '13px', color: '#854d0e'
              }}>
                ✓ Vendor: <strong>{vendorName}</strong>
                {vendorGstin && <span> · GSTIN: {vendorGstin}</span>}
              </div>
            )}

            {placeOfSupply && orgStateCode && (
              <div style={{
                padding: '8px 12px', borderRadius: '6px', marginBottom: '1rem',
                background: gstType === 'cgst_sgst' ? '#f0fdf4' : '#eff6ff',
                border: `1px solid ${gstType === 'cgst_sgst' ? '#bbf7d0' : '#bfdbfe'}`,
                fontSize: '12px',
                color: gstType === 'cgst_sgst' ? '#166534' : '#1d4ed8',
              }}>
                {gstType === 'cgst_sgst' ? '✓ Same state — CGST + SGST' : '✓ Interstate — IGST'}
              </div>
            )}

            {/* Line items */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>Items Being Returned</div>
              <div className="line-items-head" style={{
                display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 1fr 32px',
                gap: '6px', marginBottom: '6px',
                fontSize: '11px', fontWeight: '600', color: '#94a3b8'
              }}>
                <span>Item</span><span>HSN/SAC</span><span>Qty</span>
                <span>Rate</span><span>GST%</span><span>Amount</span><span></span>
              </div>

              {lineItems.map((item, index) => (
                <div key={index} style={{ marginBottom: '8px' }}>
                  <div className="line-item-row" style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 1fr 32px',
                    gap: '6px', alignItems: 'center'
                  }}>
                    <div className="li-full" data-label="Item">
                      <select style={{ ...inputStyle, marginBottom: '4px', cursor: 'pointer', fontSize: '12px' }}
                        value={item.product_id}
                        onChange={e => handleProductSelect(index, e.target.value)}>
                        <option value="">Select product...</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input style={{ ...inputStyle, fontSize: '12px' }} value={item.item_name}
                        onChange={e => { const u = [...lineItems]; u[index] = { ...u[index], item_name: e.target.value }; setLineItems(u) }}
                        placeholder="Item name" />
                    </div>
                    <div data-label="HSN/SAC">
                      <input style={{ ...inputStyle, fontSize: '12px' }} value={item.hsn_sac}
                        onChange={e => { const u = [...lineItems]; u[index] = { ...u[index], hsn_sac: e.target.value }; setLineItems(u) }}
                        placeholder="HSN/SAC" />
                    </div>
                    <div data-label="Qty">
                      <input style={{ ...inputStyle, fontSize: '12px' }} type="number" value={item.quantity}
                        onChange={e => { const u = [...lineItems]; u[index] = { ...u[index], quantity: e.target.value }; setLineItems(u) }}
                        min="0" />
                    </div>
                    <div data-label="Rate (₹)">
                      <input style={{ ...inputStyle, fontSize: '12px' }} type="number" value={item.rate}
                        onChange={e => { const u = [...lineItems]; u[index] = { ...u[index], rate: e.target.value }; setLineItems(u) }}
                        placeholder="0.00" min="0" />
                    </div>
                    <div data-label="GST %">
                      <select style={{ ...inputStyle, fontSize: '12px', cursor: 'pointer' }} value={item.gst_rate}
                        onChange={e => { const u = [...lineItems]; u[index] = { ...u[index], gst_rate: e.target.value }; setLineItems(u) }}>
                        {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                      </select>
                    </div>
                    <div data-label="Amount" style={{
                      padding: '8px 10px', background: 'white',
                      border: '1px solid #e2e8f0', borderRadius: '6px',
                      fontSize: '12px', fontWeight: '500', textAlign: 'right' as const
                    }}>
                      {item.calculated ? `₹${formatINR(item.calculated.total_amount)}` : '—'}
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
                </div>
              ))}

              <button onClick={() => setLineItems([...lineItems, emptyLine()])} style={{
                marginTop: '6px', padding: '7px 14px',
                background: 'white', border: '1px dashed #cbd5e1',
                borderRadius: '6px', fontSize: '12px',
                cursor: 'pointer', color: '#2563eb', fontWeight: '500'
              }}>+ Add Line</button>
            </div>

            {/* Totals */}
            {totals && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                <div style={{ background: '#fef9c3', border: '1px solid #fde68a', borderRadius: '8px', padding: '1rem', width: '280px' }}>
                  {[
                    { label: 'Taxable Amount', value: totals.taxable_amount, show: true },
                    { label: 'CGST', value: totals.cgst_amount, show: totals.cgst_amount > 0 },
                    { label: 'SGST', value: totals.sgst_amount, show: totals.sgst_amount > 0 },
                    { label: 'IGST', value: totals.igst_amount, show: totals.igst_amount > 0 },
                  ].filter(r => r.show).map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid #fde68a', color: '#64748b' }}>
                      <span>{row.label}</span>
                      <span>₹{formatINR(row.value)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: '15px', fontWeight: '700', color: '#d97706' }}>
                    <span>Debit Amount</span>
                    <span>₹{formatINR(totals.grand_total)}</span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Notes</label>
              <input style={inputStyle} value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Reason details or additional notes" />
            </div>

            {error && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca',
                color: '#dc2626', padding: '10px 12px',
                borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
              }}>{error}</div>
            )}

            <div className="btn-group" style={{ display: 'flex', gap: '12px' }}>
              <button onClick={handleSave} disabled={saving} style={{
                flex: 1, padding: '11px',
                background: saving ? '#93c5fd' : '#2563eb',
                color: 'white', border: 'none', borderRadius: '8px',
                fontSize: '14px', fontWeight: '600',
                cursor: saving ? 'not-allowed' : 'pointer'
              }}>
                {saving ? 'Saving...' : 'Save Debit Note'}
              </button>
              <button onClick={() => { setShowForm(false); resetForm() }} style={{
                padding: '11px 20px', background: 'white', color: '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px',
                fontSize: '14px', cursor: 'pointer'
              }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default function DebitNotesPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p></div>}>
      <DebitNotesPageInner />
    </Suspense>
  )
}
