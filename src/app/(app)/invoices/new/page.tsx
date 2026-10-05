'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  determineGSTType,
  calculateLineItem,
  calculateInvoiceTotals,
  getFinancialYear,
  formatINR,
  numberToWords,
  type LineItemResult
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { queueOfflineInvoice, isNetworkError } from '@/lib/outbox'

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
  calculated: LineItemResult | null
}

const emptyLine = (): LineItem => ({
  product_id: '',
  item_name: '',
  hsn_sac: '',
  quantity: '1',
  unit: 'NOS',
  rate: '',
  discount_percent: '0',
  gst_rate: '18',
  cess_rate: '0',
  calculated: null,
})

export default function NewInvoicePage() {
  const supabase = createClient()
  const router = useRouter()

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [orgName, setOrgName] = useState('')
  const [orgGstin, setOrgGstin] = useState('')
  const [orgAddress, setOrgAddress] = useState('')
  const [invoiceNumber, setInvoiceNumber] = useState('')

  // Master data
  const [customers, setCustomers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])

  // Invoice header
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerGstin, setCustomerGstin] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [customerStateCode, setCustomerStateCode] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [placeOfSupplyName, setPlaceOfSupplyName] = useState('')
  const [supplyType, setSupplyType] = useState('b2b')
  const [isReverseCharge, setIsReverseCharge] = useState(false)
  const [invoiceDate, setInvoiceDate] = useState(
    new Date().toISOString().split('T')[0]
  )
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')

  // Line items
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()])

  // Calculated totals
  const [totals, setTotals] = useState<any>(null)
  const [gstType, setGstType] = useState<'cgst_sgst' | 'igst'>('cgst_sgst')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name, address_line1, city, state_code)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }

      const org = membership.organizations as any
      setOrgId(membership.organization_id)
      setOrgName(org?.name || '')
      setOrgStateCode(org?.state_code || '')
      setOrgAddress([org?.address_line1, org?.city].filter(Boolean).join(', '))

      // Get primary GSTIN
      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('gstin, state_code')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      if (gstReg) {
        setOrgGstin(gstReg.gstin)
        setOrgStateCode(gstReg.state_code || org?.state_code || '')
      }

      // Generate invoice number
      const fy = getFinancialYear()
      const { data: seq } = await supabase
        .from('invoice_sequences')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('financial_year', fy)
        .single()

      if (seq) {
        const next = seq.last_number + 1
        setInvoiceNumber(`${seq.prefix}-${fy}-${String(next).padStart(4, '0')}`)
      } else {
        setInvoiceNumber(`INV-${fy}-0001`)
      }

      // Load customers and products
      const { data: custs } = await supabase
        .from('customers')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      const { data: prods } = await supabase
        .from('products')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      setCustomers(custs || [])
      setProducts(prods || [])
    }
    load()
  }, [])

  // Recalculate whenever line items or supply details change
  useEffect(() => {
    if (!orgStateCode || !placeOfSupply) return

    const gt = determineGSTType(orgStateCode, placeOfSupply, supplyType)
    setGstType(gt)

    const calculated = lineItems.map(item => {
      const qty = parseFloat(item.quantity) || 0
      const rate = parseFloat(item.rate) || 0
      const disc = parseFloat(item.discount_percent) || 0
      const gst = parseFloat(item.gst_rate) || 0
      const cess = parseFloat(item.cess_rate) || 0

      if (!rate || !qty) return { ...item, calculated: null }

      const result = calculateLineItem(
        { quantity: qty, rate, discount_percent: disc, gst_rate: gst, cess_rate: cess },
        gt
      )
      return { ...item, calculated: result }
    })

    setLineItems(calculated)

    const validItems = calculated
      .map(i => i.calculated)
      .filter(Boolean) as LineItemResult[]

    if (validItems.length > 0) {
      setTotals(calculateInvoiceTotals(validItems))
    } else {
      setTotals(null)
    }
  }, [
    orgStateCode, placeOfSupply, supplyType,
    JSON.stringify(lineItems.map(i => ({
      q: i.quantity, r: i.rate, d: i.discount_percent,
      g: i.gst_rate, c: i.cess_rate
    })))
  ])

  function handleCustomerChange(id: string) {
    const customer = customers.find(c => c.id === id)
    if (!customer) {
      setCustomerId('')
      setCustomerName('')
      setCustomerGstin('')
      setCustomerStateCode('')
      setPlaceOfSupply('')
      return
    }
    setCustomerId(id)
    setCustomerName(customer.name)
    setCustomerGstin(customer.gstin || '')
    setCustomerStateCode(customer.state_code || '')
    setCustomerAddress([customer.address_line1, customer.city, customer.state].filter(Boolean).join(', '))
    setSupplyType(customer.customer_type || 'b2b')

    // Place of supply defaults to customer state
    if (customer.state_code) {
      setPlaceOfSupply(customer.state_code)
      const state = INDIAN_STATES.find(s => s.value === customer.state_code)
      setPlaceOfSupplyName(state?.label || '')
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
      rate: String(product.selling_price || ''),
      gst_rate: String(product.gst_rate || 18),
      cess_rate: String(product.cess_rate || 0),
    }
    setLineItems(updated)
  }

  function updateLineItem(index: number, field: string, value: string) {
    const updated = [...lineItems]
    updated[index] = { ...updated[index], [field]: value }
    setLineItems(updated)
  }

  function addLine() {
    setLineItems([...lineItems, emptyLine()])
  }

  function removeLine(index: number) {
    if (lineItems.length === 1) return
    setLineItems(lineItems.filter((_, i) => i !== index))
  }

  async function handleSave(status: 'draft' | 'sent') {
    if (!customerId) { setError('Please select a customer'); return }
    if (!placeOfSupply) { setError('Please select place of supply'); return }

    const validItems = lineItems.filter(i =>
      i.item_name && parseFloat(i.rate) > 0 && parseFloat(i.quantity) > 0
    )
    if (validItems.length === 0) {
      setError('Please add at least one line item with name, quantity and rate')
      return
    }
    if (!totals) { setError('Please complete line items'); return }

    setSaving(true)
    setError('')

    // Full invoice payload without invoice_number — used by both the online and offline paths
    const invoiceFields = {
      invoice_type: 'tax_invoice',
      invoice_date: invoiceDate,
      due_date: dueDate || null,
      customer_id: customerId,
      customer_name: customerName,
      customer_gstin: customerGstin,
      customer_address: customerAddress,
      customer_state: placeOfSupplyName,
      customer_state_code: customerStateCode,
      place_of_supply: placeOfSupply,
      place_of_supply_name: placeOfSupplyName,
      supply_type: supplyType,
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
      amount_paid: 0,
      balance_due: totals.grand_total,
      payment_status: 'unpaid',
      notes,
      terms,
      status,
    }

    const itemsPayload = validItems.map(item => ({
      organization_id: orgId,
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
    }))

    // Offline: queue for sync instead of failing
    if (!navigator.onLine) {
      queueOfflineInvoice(orgId, invoiceFields, itemsPayload)
      router.push('/offline?queued=1')
      return
    }

    try {
      const fy = getFinancialYear()

      // Get or create sequence
      let { data: seq } = await supabase
        .from('invoice_sequences')
        .select('*')
        .eq('organization_id', orgId)
        .eq('financial_year', fy)
        .single()

      let nextNumber = 1
      if (seq) {
        nextNumber = seq.last_number + 1
        await supabase
          .from('invoice_sequences')
          .update({ last_number: nextNumber })
          .eq('id', seq.id)
      } else {
        await supabase
          .from('invoice_sequences')
          .insert({ organization_id: orgId, prefix: 'INV', financial_year: fy, last_number: 1 })
        nextNumber = 1
      }

      const finalInvoiceNumber = `INV-${fy}-${String(nextNumber).padStart(4, '0')}`

      // Save invoice
      const { data: invoice, error: invError } = await supabase
        .from('invoices')
        .insert({
          organization_id: orgId,
          invoice_number: finalInvoiceNumber,
          ...invoiceFields,
        })
        .select()
        .single()

      if (invError) throw invError

      // Save line items
      const itemsToInsert = itemsPayload.map((item, idx) => ({
        ...item,
        invoice_id: invoice.id,
        sort_order: idx,
      }))

           const { error: itemsError } = await supabase
        .from('invoice_items')
        .insert(itemsToInsert)

      if (itemsError) throw itemsError

      // Update stock for tracked products
      for (const item of validItems) {
        if (!item.product_id) continue

        const { data: product } = await supabase
          .from('products')
          .select('track_inventory, current_stock')
          .eq('id', item.product_id)
          .single()

        if (product?.track_inventory) {
          await supabase.rpc('record_stock_movement', {
            p_organization_id: orgId,
            p_product_id: item.product_id,
            p_movement_type: 'sale',
            p_quantity: -(parseFloat(item.quantity)),
            p_reference_type: 'invoice',
            p_reference_id: invoice.id,
            p_reference_number: finalInvoiceNumber,
            p_notes: `Sale — ${finalInvoiceNumber}`,
            p_created_by: (await supabase.auth.getUser()).data.user?.id,
          })
        }
      }
      
      router.push(`/invoices/${invoice.id}`)
    } catch (err: any) {
      const message = err?.message || 'Failed to save invoice'
      // Connection dropped mid-save — queue instead of losing the invoice
      if (isNetworkError(message)) {
        queueOfflineInvoice(orgId, invoiceFields, itemsPayload)
        router.push('/offline?queued=1')
        return
      }
      setError(message)
      setSaving(false)
    }
  }

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      {/* Header */}
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <button onClick={() => router.push('/invoices')} style={{
            background: 'none', border: 'none', color: '#2563eb',
            fontSize: '13px', cursor: 'pointer', marginBottom: '4px',
            padding: 0
          }}>← Back to Invoices</button>
          <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b' }}>New Tax Invoice</h1>
        </div>
        <div className="btn-group" style={{ display: 'flex', gap: '8px' }}>
          <button onClick={() => handleSave('draft')} disabled={saving} style={{
            padding: '9px 18px', background: 'white', color: '#374151',
            border: '1px solid #e2e8f0', borderRadius: '8px',
            fontSize: '14px', fontWeight: '500', cursor: 'pointer'
          }}>
            Save Draft
          </button>
          <button onClick={() => handleSave('sent')} disabled={saving} style={{
            padding: '9px 18px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px',
            fontSize: '14px', fontWeight: '600', cursor: 'pointer'
          }}>
            {saving ? 'Saving...' : 'Save Invoice'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626',
          padding: '10px 14px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
        }}>{error}</div>
      )}

      <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* Seller details */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' as const }}>
            From (Seller)
          </div>
          <div style={{ fontWeight: '600', fontSize: '15px', color: '#1e293b' }}>{orgName}</div>
          {orgGstin && <div style={{ fontSize: '12px', color: '#64748b', fontFamily: 'monospace', marginTop: '2px' }}>GSTIN: {orgGstin}</div>}
          {orgAddress && <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>{orgAddress}</div>}
        </div>

        {/* Invoice details */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' as const }}>
            Invoice Details
          </div>
          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <div>
              <label style={labelStyle}>Invoice Number</label>
              <input style={{ ...inputStyle, background: '#f8fafc', fontWeight: '600' }}
                value={invoiceNumber} readOnly />
            </div>
            <div>
              <label style={labelStyle}>Invoice Date *</label>
              <input style={inputStyle} type="date" value={invoiceDate}
                onChange={e => setInvoiceDate(e.target.value)} required />
            </div>
            <div>
              <label style={labelStyle}>Due Date</label>
              <input style={inputStyle} type="date" value={dueDate}
                onChange={e => setDueDate(e.target.value)} />
            </div>
            <div>
              <label style={labelStyle}>Supply Type</label>
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={supplyType}
                onChange={e => setSupplyType(e.target.value)}>
                <option value="b2b">B2B</option>
                <option value="b2c">B2C</option>
                <option value="export">Export</option>
                <option value="sez">SEZ</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* Customer selection */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.25rem', marginBottom: '1rem'
      }}>
        <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '10px', textTransform: 'uppercase' as const }}>
          Bill To (Customer)
        </div>
        <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '10px' }}>
          <div>
            <label style={labelStyle}>Select Customer *</label>
            <select style={{ ...inputStyle, cursor: 'pointer' }} value={customerId}
              onChange={e => handleCustomerChange(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.business_name ? ` — ${c.business_name}` : ''}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={labelStyle}>Customer GSTIN</label>
            <input style={{ ...inputStyle, fontFamily: 'monospace', background: '#f8fafc' }}
              value={customerGstin} readOnly placeholder="Auto-filled" />
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
              {INDIAN_STATES.map(s => (
                <option key={s.value} value={s.value}>{s.value} — {s.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* GST type indicator */}
        {placeOfSupply && orgStateCode && (
          <div style={{
            marginTop: '10px', padding: '8px 12px', borderRadius: '6px',
            background: gstType === 'cgst_sgst' ? '#f0fdf4' : '#eff6ff',
            border: `1px solid ${gstType === 'cgst_sgst' ? '#bbf7d0' : '#bfdbfe'}`,
            fontSize: '12px',
            color: gstType === 'cgst_sgst' ? '#166534' : '#1d4ed8',
          }}>
            {gstType === 'cgst_sgst'
              ? '✓ Same state — CGST + SGST will be applied'
              : '✓ Interstate / Export — IGST will be applied'}
          </div>
        )}

        <div style={{ marginTop: '10px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="checkbox" id="rc" checked={isReverseCharge}
            onChange={e => setIsReverseCharge(e.target.checked)} />
          <label htmlFor="rc" style={{ fontSize: '13px', color: '#374151', cursor: 'pointer' }}>
            Reverse Charge applicable
          </label>
        </div>
      </div>

      {/* Line Items */}
      <div style={{
        background: 'white', border: '1px solid #e2e8f0',
        borderRadius: '12px', padding: '1.25rem', marginBottom: '1rem'
      }}>
        <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '12px', textTransform: 'uppercase' as const }}>
          Line Items
        </div>

        {/* Column headers */}
        <div className="line-items-head" style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px',
          gap: '6px', marginBottom: '6px',
          fontSize: '11px', fontWeight: '600', color: '#94a3b8'
        }}>
          <span>Item *</span>
          <span>HSN/SAC</span>
          <span>Qty *</span>
          <span>Rate (₹) *</span>
          <span>Disc %</span>
          <span>GST %</span>
          <span>Amount</span>
          <span></span>
        </div>

        {lineItems.map((item, index) => (
          <div key={index} style={{ marginBottom: '8px' }}>
            <div className="line-item-row" style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px',
              gap: '6px', alignItems: 'center'
            }}>
              {/* Item name / product select */}
              <div className="li-full" data-label="Item *">
                <select
                  style={{ ...inputStyle, marginBottom: '4px', cursor: 'pointer' }}
                  value={item.product_id}
                  onChange={e => handleProductSelect(index, e.target.value)}
                >
                  <option value="">Select product...</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <input style={inputStyle} value={item.item_name}
                  onChange={e => updateLineItem(index, 'item_name', e.target.value)}
                  placeholder="Or type item name" />
              </div>

              <div data-label="HSN/SAC">
                <input style={inputStyle} value={item.hsn_sac}
                  onChange={e => updateLineItem(index, 'hsn_sac', e.target.value)}
                  placeholder="HSN/SAC" />
              </div>

              <div data-label="Qty *">
                <input style={inputStyle} type="number" value={item.quantity}
                  onChange={e => updateLineItem(index, 'quantity', e.target.value)}
                  min="0" step="0.001" />
              </div>

              <div data-label="Rate (₹) *">
                <input style={inputStyle} type="number" value={item.rate}
                  onChange={e => updateLineItem(index, 'rate', e.target.value)}
                  placeholder="0.00" min="0" step="0.01" />
              </div>

              <div data-label="Disc %">
                <input style={inputStyle} type="number" value={item.discount_percent}
                  onChange={e => updateLineItem(index, 'discount_percent', e.target.value)}
                  min="0" max="100" step="0.01" />
              </div>

              <div data-label="GST %">
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={item.gst_rate}
                  onChange={e => updateLineItem(index, 'gst_rate', e.target.value)}>
                  {[0, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
              </div>

              {/* Calculated total */}
              <div data-label="Amount" style={{
                padding: '8px 10px', background: '#f8fafc',
                border: '1px solid #e2e8f0', borderRadius: '6px',
                fontSize: '13px', fontWeight: '500', color: '#1e293b',
                textAlign: 'right' as const
              }}>
                {item.calculated ? `₹${formatINR(item.calculated.total_amount)}` : '—'}
              </div>

              <div className="li-full" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => removeLine(index)} style={{
                  width: '32px', height: '32px', border: '1px solid #fecaca',
                  background: '#fef2f2', borderRadius: '6px',
                  cursor: lineItems.length === 1 ? 'not-allowed' : 'pointer',
                  color: '#dc2626', fontSize: '16px',
                  opacity: lineItems.length === 1 ? 0.4 : 1
                }}>×</button>
              </div>
            </div>

            {/* Tax breakdown for this line */}
            {item.calculated && (
              <div style={{
                fontSize: '11px', color: '#64748b', marginTop: '3px',
                paddingLeft: '4px', display: 'flex', gap: '16px'
              }}>
                <span>Taxable: ₹{formatINR(item.calculated.taxable_value)}</span>
                {item.calculated.cgst_amount > 0 && <span>CGST {item.calculated.cgst_rate}%: ₹{formatINR(item.calculated.cgst_amount)}</span>}
                {item.calculated.sgst_amount > 0 && <span>SGST {item.calculated.sgst_rate}%: ₹{formatINR(item.calculated.sgst_amount)}</span>}
                {item.calculated.igst_amount > 0 && <span>IGST {item.calculated.igst_rate}%: ₹{formatINR(item.calculated.igst_amount)}</span>}
                {item.calculated.cess_amount > 0 && <span>Cess: ₹{formatINR(item.calculated.cess_amount)}</span>}
              </div>
            )}
          </div>
        ))}

        <button onClick={addLine} style={{
          marginTop: '8px', padding: '8px 16px',
          background: '#f8fafc', border: '1px dashed #cbd5e1',
          borderRadius: '6px', fontSize: '13px', cursor: 'pointer',
          color: '#2563eb', fontWeight: '500'
        }}>
          + Add Line Item
        </button>
      </div>

      <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* Notes & Terms */}
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem'
        }}>
          <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '10px', textTransform: 'uppercase' as const }}>
            Notes & Terms
          </div>
          <div style={{ marginBottom: '10px' }}>
            <label style={labelStyle}>Notes (visible on invoice)</label>
            <textarea style={{ ...inputStyle, height: '70px', resize: 'vertical' as const }}
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Thank you for your business..." />
          </div>
          <div>
            <label style={labelStyle}>Terms & Conditions</label>
            <textarea style={{ ...inputStyle, height: '70px', resize: 'vertical' as const }}
              value={terms} onChange={e => setTerms(e.target.value)}
              placeholder="Payment due within 30 days..." />
          </div>
        </div>

        {/* Totals */}
        {totals && (
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.25rem'
          }}>
            <div style={{ fontSize: '11px', fontWeight: '600', color: '#94a3b8', marginBottom: '10px', textTransform: 'uppercase' as const }}>
              Invoice Summary
            </div>
            {[
              { label: 'Subtotal', value: totals.subtotal },
              totals.discount_amount > 0 ? { label: 'Discount', value: -totals.discount_amount } : null,
              { label: 'Taxable Amount', value: totals.taxable_amount },
              totals.cgst_amount > 0 ? { label: 'CGST', value: totals.cgst_amount } : null,
              totals.sgst_amount > 0 ? { label: 'SGST', value: totals.sgst_amount } : null,
              totals.igst_amount > 0 ? { label: 'IGST', value: totals.igst_amount } : null,
              totals.cess_amount > 0 ? { label: 'Cess', value: totals.cess_amount } : null,
              totals.round_off !== 0 ? { label: 'Round Off', value: totals.round_off } : null,
            ].filter(Boolean).map((row: any) => (
              <div key={row.label} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '5px 0', fontSize: '13px',
                borderBottom: '1px solid #f1f5f9'
              }}>
                <span style={{ color: '#64748b' }}>{row.label}</span>
                <span style={{ color: row.value < 0 ? '#dc2626' : '#1e293b', fontWeight: '500' }}>
                  ₹{formatINR(Math.abs(row.value))}
                </span>
              </div>
            ))}
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              padding: '10px 0 4px', fontSize: '15px', fontWeight: '700',
              color: '#1e293b', marginTop: '4px'
            }}>
              <span>Grand Total</span>
              <span style={{ color: '#2563eb' }}>₹{formatINR(totals.grand_total)}</span>
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '6px', fontStyle: 'italic' }}>
              {numberToWords(totals.grand_total)}
            </div>
          </div>
        )}
      </div>

      {/* Save buttons */}
      <div className="btn-group" style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end' }}>
        <button onClick={() => router.push('/invoices')} style={{
          padding: '10px 20px', background: 'white', color: '#374151',
          border: '1px solid #e2e8f0', borderRadius: '8px',
          fontSize: '14px', cursor: 'pointer'
        }}>Cancel</button>
        <button onClick={() => handleSave('draft')} disabled={saving} style={{
          padding: '10px 20px', background: 'white', color: '#374151',
          border: '1px solid #e2e8f0', borderRadius: '8px',
          fontSize: '14px', fontWeight: '500', cursor: 'pointer'
        }}>Save as Draft</button>
        <button onClick={() => handleSave('sent')} disabled={saving} style={{
          padding: '10px 24px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px',
          fontSize: '14px', fontWeight: '600', cursor: 'pointer'
        }}>
          {saving ? 'Saving...' : '✓ Save Invoice'}
        </button>
      </div>
    </div>
  )
}