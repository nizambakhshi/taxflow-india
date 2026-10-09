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
import { createCreditNote } from '@/lib/creditnote'

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

const CREDIT_REASONS = [
  { value: 'sales_return', label: 'Sales Return' },
  { value: 'price_correction', label: 'Price Correction' },
  { value: 'discount', label: 'Post-sale Discount' },
  { value: 'defective_goods', label: 'Defective Goods' },
  { value: 'other', label: 'Other' },
]

function CreditNotesPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [creditNotes, setCreditNotes] = useState<any[]>([])
  const [search, setSearch] = useSearchDeepLink()
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [customers, setCustomers] = useState<any[]>([])
  const [invoices, setInvoices] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])

  // Form state
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerGstin, setCustomerGstin] = useState('')
  const [customerStateCode, setCustomerStateCode] = useState('')
  const [invoiceId, setInvoiceId] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [placeOfSupplyName, setPlaceOfSupplyName] = useState('')
  const [supplyType, setSupplyType] = useState('b2b')
  const [reason, setReason] = useState('sales_return')
  const [creditDate, setCreditDate] = useState(new Date().toISOString().split('T')[0])
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

      const [{ data: cnData }, { data: custData }, { data: invData }, { data: prodData }] = await Promise.all([
        supabase.from('credit_notes').select('*').eq('organization_id', membership.organization_id).order('created_at', { ascending: false }),
        supabase.from('customers').select('*').eq('organization_id', membership.organization_id).eq('is_active', true).order('name'),
        supabase.from('invoices').select('id, invoice_number, customer_name, customer_id, place_of_supply, place_of_supply_name, supply_type, customer_state_code, customer_gstin').eq('organization_id', membership.organization_id).neq('status', 'cancelled').order('invoice_date', { ascending: false }),
        supabase.from('products').select('*').eq('organization_id', membership.organization_id).eq('is_active', true).order('name'),
      ])

      setCreditNotes(cnData || [])
      setCustomers(custData || [])
      setInvoices(invData || [])
      setProducts(prodData || [])
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (!orgStateCode || !placeOfSupply) return
    const gt = determineGSTType(orgStateCode, placeOfSupply, supplyType)
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
    orgStateCode, placeOfSupply, supplyType,
    JSON.stringify(lineItems.map(i => ({ q: i.quantity, r: i.rate, g: i.gst_rate })))
  ])

  function handleInvoiceSelect(id: string) {
    const inv = invoices.find(i => i.id === id)
    if (!inv) return
    setInvoiceId(id)
    setInvoiceNumber(inv.invoice_number)
    setCustomerId(inv.customer_id || '')
    setCustomerName(inv.customer_name)
    setCustomerGstin(inv.customer_gstin || '')
    setCustomerStateCode(inv.customer_state_code || '')
    setPlaceOfSupply(inv.place_of_supply || '')
    setPlaceOfSupplyName(inv.place_of_supply_name || '')
    setSupplyType(inv.supply_type || 'b2b')
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
      rate: String(product.selling_price || ''),
      gst_rate: String(product.gst_rate || 18),
    }
    setLineItems(updated)
  }

  function resetForm() {
    setCustomerId(''); setCustomerName(''); setCustomerGstin('')
    setCustomerStateCode(''); setInvoiceId(''); setInvoiceNumber('')
    setPlaceOfSupply(''); setPlaceOfSupplyName('')
    setSupplyType('b2b'); setReason('sales_return'); setNotes('')
    setLineItems([emptyLine()]); setTotals(null); setError('')
    setCreditDate(new Date().toISOString().split('T')[0])
  }

  async function handleSave() {
    if (!customerName) { setError('Please select an invoice or enter customer details'); return }
    if (!placeOfSupply) { setError('Please select place of supply'); return }
    const validItems = lineItems.filter(i => i.item_name && parseFloat(i.rate) > 0)
    if (validItems.length === 0) { setError('Please add at least one line item'); return }
    if (!totals) { setError('Please complete line items'); return }

    setSaving(true)
    setError('')

    try {
      await createCreditNote(supabase, orgId, {
        credit_note_date: creditDate,
        status: 'active',
        invoice_id: invoiceId || null,
        invoice_number: invoiceNumber || null,
        customer_id: customerId || null,
        customer_name: customerName,
        customer_gstin: customerGstin,
        customer_state_code: customerStateCode,
        place_of_supply: placeOfSupply,
        place_of_supply_name: placeOfSupplyName,
        supply_type: supplyType,
        reason,
        subtotal: totals.subtotal,
        taxable_amount: totals.taxable_amount,
        cgst_amount: totals.cgst_amount,
        sgst_amount: totals.sgst_amount,
        igst_amount: totals.igst_amount,
        cess_amount: totals.cess_amount,
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
        .from('credit_notes')
        .select('*')
        .eq('organization_id', orgId)
        .order('created_at', { ascending: false })
      setCreditNotes(updated || [])
      setShowForm(false)
      resetForm()
    } catch (err: any) {
      setError(err.message || 'Failed to save credit note')
    } finally {
      setSaving(false)
    }
  }

  const visible = creditNotes.filter(x => matchesAny(search, [x.credit_note_number, x.customer_name]))

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>Credit Notes</h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {creditNotes.length} credit note{creditNotes.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true) }} style={{
          padding: '9px 18px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer'
        }}>+ New Credit Note</button>
      </div>

      {/* Info box */}
      <div style={{
        background: '#eff6ff', border: '1px solid #bfdbfe',
        borderRadius: '8px', padding: '10px 14px',
        fontSize: '13px', color: '#1d4ed8', marginBottom: '1.5rem'
      }}>
        ℹ️ <strong>Credit Notes</strong> are issued when you need to reduce an invoice amount — for returns, corrections or discounts after the original invoice. They appear in GSTR-1 under CDN (Credit/Debit Notes).
      </div>

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder="Credit note number or customer…"
        ariaLabel="Search credit notes"
        style={{ maxWidth: 380, marginBottom: '1.25rem' }}
      />

      {/* List */}
      {creditNotes.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '40px', marginBottom: '1rem' }}>📝</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>No credit notes yet</div>
          <div style={{ fontSize: '13px' }}>Issue credit notes for sales returns or invoice corrections</div>
        </div>
      ) : !visible.length ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '2.5rem', textAlign: 'center', color: '#94a3b8', fontSize: '13px'
        }}>
          No credit note matches “{search}”
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr 1fr 1fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Credit Note No.</span><span>Customer</span>
            <span>Date</span><span>Against Invoice</span>
            <span>Reason</span><span>Amount</span>
          </div>
          {visible.map(cn => (
            <div key={cn.id} className="table-row" style={{
              display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1.5fr 1fr 1fr',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Credit Note No." style={{ fontWeight: '600', color: '#7c3aed' }}>{cn.credit_note_number}</div>
              <div data-label="Customer" style={{ color: '#1e293b' }}>{cn.customer_name}</div>
              <div data-label="Date" style={{ color: '#64748b' }}>{new Date(cn.credit_note_date).toLocaleDateString('en-IN')}</div>
              <div data-label="Against Invoice" style={{ color: '#64748b', fontSize: '12px' }}>{cn.invoice_number || '—'}</div>
              <div data-label="Reason">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: '#f1f5f9', color: '#374151'
                }}>
                  {CREDIT_REASONS.find(r => r.value === cn.reason)?.label || cn.reason || '—'}
                </span>
              </div>
              <div data-label="Amount" style={{ fontWeight: '600', color: '#dc2626' }}>₹{formatINR(cn.grand_total)}</div>
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
            padding: '2rem', width: '100%', maxWidth: '820px', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>New Credit Note</h2>
              <button onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            {/* Against invoice */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                Against Invoice (optional — select to auto-fill customer details)
              </div>
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={invoiceId}
                onChange={e => handleInvoiceSelect(e.target.value)}>
                <option value="">Select invoice... (or fill manually below)</option>
                {invoices.map(inv => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoice_number} — {inv.customer_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Credit Note Date *</label>
                <input style={inputStyle} type="date" value={creditDate}
                  onChange={e => setCreditDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Reason *</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={reason}
                  onChange={e => setReason(e.target.value)}>
                  {CREDIT_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
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

            {/* Customer name (manual if no invoice selected) */}
            {!invoiceId && (
              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Customer Name *</label>
                  <input style={inputStyle} value={customerName}
                    onChange={e => setCustomerName(e.target.value)}
                    placeholder="Customer name" />
                </div>
                <div>
                  <label style={labelStyle}>Customer GSTIN</label>
                  <input style={inputStyle} value={customerGstin}
                    onChange={e => setCustomerGstin(e.target.value.toUpperCase())}
                    placeholder="GSTIN (optional)" maxLength={15} />
                </div>
              </div>
            )}

            {invoiceId && customerName && (
              <div style={{
                background: '#f0fdf4', border: '1px solid #bbf7d0',
                borderRadius: '8px', padding: '10px 12px', marginBottom: '1rem',
                fontSize: '13px', color: '#166534'
              }}>
                ✓ Customer: <strong>{customerName}</strong>
                {customerGstin && <span> · GSTIN: {customerGstin}</span>}
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
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>Items Being Returned / Credited</div>
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
                    <div data-label="Rate">
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
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px', padding: '1rem', width: '280px' }}>
                  {[
                    { label: 'Taxable Amount', value: totals.taxable_amount, show: true },
                    { label: 'CGST', value: totals.cgst_amount, show: totals.cgst_amount > 0 },
                    { label: 'SGST', value: totals.sgst_amount, show: totals.sgst_amount > 0 },
                    { label: 'IGST', value: totals.igst_amount, show: totals.igst_amount > 0 },
                  ].filter(r => r.show).map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid #fecaca', color: '#64748b' }}>
                      <span>{row.label}</span>
                      <span>₹{formatINR(row.value)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: '15px', fontWeight: '700', color: '#dc2626' }}>
                    <span>Credit Amount</span>
                    <span>₹{formatINR(totals.grand_total)}</span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>Notes</label>
              <input style={inputStyle} value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Reason details or any additional notes" />
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
                {saving ? 'Saving...' : 'Save Credit Note'}
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

export default function CreditNotesPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: '#64748b', fontSize: 13 }}>Loading…</p></div>}>
      <CreditNotesPageInner />
    </Suspense>
  )
}
