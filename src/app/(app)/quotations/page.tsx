'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  determineGSTType, calculateLineItem,
  calculateInvoiceTotals, getFinancialYear,
  formatINR, numberToWords, type LineItemResult
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'

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
  discount_percent: string
  gst_rate: string
  cess_rate: string
  calculated: LineItemResult | null
}

const emptyLine = (): LineItem => ({
  product_id: '', item_name: '', hsn_sac: '',
  quantity: '1', unit: 'NOS', rate: '',
  discount_percent: '0', gst_rate: '18', cess_rate: '0',
  calculated: null,
})

const STATUS_CONFIG: Record<string, { label: string; bg: string; color: string; desc: string }> = {
  draft:     { label: 'Draft',     bg: '#f1f5f9', color: '#64748b', desc: 'Not yet sent to customer' },
  sent:      { label: 'Sent',      bg: '#eff6ff', color: '#1d4ed8', desc: 'Shared with customer, awaiting response' },
  accepted:  { label: 'Accepted',  bg: '#f0fdf4', color: '#166534', desc: 'Customer agreed — ready to convert' },
  rejected:  { label: 'Rejected',  bg: '#fef2f2', color: '#dc2626', desc: 'Customer declined' },
  converted: { label: 'Converted', bg: '#fef9c3', color: '#854d0e', desc: 'Invoice created from this quotation' },
}

export default function QuotationsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [quotations, setQuotations] = useState<any[]>([])
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [showView, setShowView] = useState(false)
  const [selectedQuotation, setSelectedQuotation] = useState<any>(null)
  const [selectedItems, setSelectedItems] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [converting, setConverting] = useState(false)
  const [error, setError] = useState('')
  const [customers, setCustomers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])

  // Form state
  const [customerId, setCustomerId] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerGstin, setCustomerGstin] = useState('')
  const [customerAddress, setCustomerAddress] = useState('')
  const [customerStateCode, setCustomerStateCode] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [placeOfSupplyName, setPlaceOfSupplyName] = useState('')
  const [supplyType, setSupplyType] = useState('b2b')
  const [quotationDate, setQuotationDate] = useState(new Date().toISOString().split('T')[0])
  const [validUntil, setValidUntil] = useState('')
  const [notes, setNotes] = useState('')
  const [terms, setTerms] = useState('')
  const [lineItems, setLineItems] = useState<LineItem[]>([emptyLine()])
  const [totals, setTotals] = useState<any>(null)
  const [gstType, setGstType] = useState<'cgst_sgst' | 'igst'>('cgst_sgst')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name, state_code)')
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

      await fetchAll(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function fetchAll(oid: string) {
    const [{ data: qData }, { data: cData }, { data: pData }] = await Promise.all([
      supabase.from('quotations').select('*').eq('organization_id', oid).order('created_at', { ascending: false }),
      supabase.from('customers').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
      supabase.from('products').select('*').eq('organization_id', oid).eq('is_active', true).order('name'),
    ])
    setQuotations(qData || [])
    setCustomers(cData || [])
    setProducts(pData || [])
  }

  // Recalculate GST live
  useEffect(() => {
    if (!orgStateCode || !placeOfSupply) return
    const gt = determineGSTType(orgStateCode, placeOfSupply, supplyType)
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
    const validItems = calculated.map(i => i.calculated).filter(Boolean) as LineItemResult[]
    setTotals(validItems.length > 0 ? calculateInvoiceTotals(validItems) : null)
  }, [
    orgStateCode, placeOfSupply, supplyType,
    JSON.stringify(lineItems.map(i => ({ q: i.quantity, r: i.rate, d: i.discount_percent, g: i.gst_rate })))
  ])

  function handleCustomerChange(id: string) {
    const c = customers.find(x => x.id === id)
    if (!c) return
    setCustomerId(id)
    setCustomerName(c.name)
    setCustomerGstin(c.gstin || '')
    setCustomerStateCode(c.state_code || '')
    setCustomerAddress([c.address_line1, c.city, c.state].filter(Boolean).join(', '))
    setSupplyType(c.customer_type || 'b2b')
    if (c.state_code) {
      setPlaceOfSupply(c.state_code)
      const s = INDIAN_STATES.find(x => x.value === c.state_code)
      setPlaceOfSupplyName(s?.label || '')
    }
  }

  function handleProductSelect(index: number, productId: string) {
    const p = products.find(x => x.id === productId)
    if (!p) return
    const u = [...lineItems]
    u[index] = { ...u[index], product_id: productId, item_name: p.name, hsn_sac: p.hsn_sac || '', unit: p.unit || 'NOS', rate: String(p.selling_price || ''), gst_rate: String(p.gst_rate || 18), cess_rate: String(p.cess_rate || 0) }
    setLineItems(u)
  }

  function updateLine(index: number, field: string, value: string) {
    const u = [...lineItems]
    u[index] = { ...u[index], [field]: value }
    setLineItems(u)
  }

  function resetForm() {
    setCustomerId(''); setCustomerName(''); setCustomerGstin('')
    setCustomerAddress(''); setCustomerStateCode('')
    setPlaceOfSupply(''); setPlaceOfSupplyName('')
    setSupplyType('b2b'); setNotes(''); setTerms('')
    setLineItems([emptyLine()]); setTotals(null); setError('')
    setQuotationDate(new Date().toISOString().split('T')[0])
    setValidUntil('')
  }

  async function handleSave() {
    if (!customerId) { setError('Please select a customer'); return }
    if (!placeOfSupply) { setError('Please select place of supply'); return }
    const validItems = lineItems.filter(i => i.item_name && parseFloat(i.rate) > 0)
    if (validItems.length === 0) { setError('Please add at least one line item'); return }
    if (!totals) { setError('Please complete line items'); return }

    setSaving(true)
    setError('')
    try {
      const fy = getFinancialYear()
      let { data: seq } = await supabase.from('quotation_sequences').select('*').eq('organization_id', orgId).eq('financial_year', fy).single()
      let nextNumber = 1
      if (seq) {
        nextNumber = seq.last_number + 1
        await supabase.from('quotation_sequences').update({ last_number: nextNumber }).eq('id', seq.id)
      } else {
        await supabase.from('quotation_sequences').insert({ organization_id: orgId, prefix: 'QT', financial_year: fy, last_number: 1 })
      }
      const finalNumber = `QT-${fy}-${String(nextNumber).padStart(4, '0')}`

      const { data: q, error: qErr } = await supabase.from('quotations').insert({
        organization_id: orgId,
        quotation_number: finalNumber,
        quotation_date: quotationDate,
        valid_until: validUntil || null,
        status: 'draft',
        customer_id: customerId,
        customer_name: customerName,
        customer_gstin: customerGstin,
        customer_address: customerAddress,
        customer_state: placeOfSupplyName,
        customer_state_code: customerStateCode,
        place_of_supply: placeOfSupply,
        place_of_supply_name: placeOfSupplyName,
        supply_type: supplyType,
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
        notes, terms,
      }).select().single()
      if (qErr) throw qErr

      await supabase.from('quotation_items').insert(
        validItems.map((item, idx) => ({
          quotation_id: q.id, organization_id: orgId,
          product_id: item.product_id || null,
          item_name: item.item_name, hsn_sac: item.hsn_sac,
          quantity: parseFloat(item.quantity), unit: item.unit,
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
          sort_order: idx,
        }))
      )

      await fetchAll(orgId)
      setShowForm(false)
      resetForm()
    } catch (err: any) {
      setError(err.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function openView(quotation: any) {
    setSelectedQuotation(quotation)
    const { data: items } = await supabase
      .from('quotation_items')
      .select('*')
      .eq('quotation_id', quotation.id)
      .order('sort_order')
    setSelectedItems(items || [])
    setShowView(true)
  }

  async function updateStatus(id: string, status: string) {
    await supabase.from('quotations').update({ status }).eq('id', id)
    setQuotations(prev => prev.map(q => q.id === id ? { ...q, status } : q))
    setSelectedQuotation((p: any) => p?.id === id ? { ...p, status } : p)
  }

  async function convertToInvoice(quotation: any) {
    if (quotation.status !== 'accepted') {
      alert('Please mark the quotation as Accepted before converting to invoice.')
      return
    }
    if (!confirm(`Convert ${quotation.quotation_number} to an invoice?`)) return
    setConverting(true)
    try {
      const { data: items } = await supabase.from('quotation_items').select('*').eq('quotation_id', quotation.id).order('sort_order')

      const fy = getFinancialYear()
      let { data: seq } = await supabase.from('invoice_sequences').select('*').eq('organization_id', orgId).eq('financial_year', fy).single()
      let nextNumber = 1
      if (seq) {
        nextNumber = seq.last_number + 1
        await supabase.from('invoice_sequences').update({ last_number: nextNumber }).eq('id', seq.id)
      } else {
        await supabase.from('invoice_sequences').insert({ organization_id: orgId, prefix: 'INV', financial_year: fy, last_number: 1 })
      }
      const invoiceNumber = `INV-${fy}-${String(nextNumber).padStart(4, '0')}`

      const { data: invoice, error: invErr } = await supabase.from('invoices').insert({
        organization_id: orgId,
        invoice_number: invoiceNumber,
        invoice_type: 'tax_invoice',
        invoice_date: new Date().toISOString().split('T')[0],
        customer_id: quotation.customer_id,
        customer_name: quotation.customer_name,
        customer_gstin: quotation.customer_gstin,
        customer_address: quotation.customer_address,
        customer_state: quotation.customer_state,
        customer_state_code: quotation.customer_state_code,
        place_of_supply: quotation.place_of_supply,
        place_of_supply_name: quotation.place_of_supply_name,
        supply_type: quotation.supply_type,
        subtotal: quotation.subtotal,
        discount_amount: quotation.discount_amount,
        taxable_amount: quotation.taxable_amount,
        cgst_amount: quotation.cgst_amount,
        sgst_amount: quotation.sgst_amount,
        igst_amount: quotation.igst_amount,
        cess_amount: quotation.cess_amount,
        total_tax: quotation.total_tax,
        round_off: quotation.round_off,
        grand_total: quotation.grand_total,
        amount_paid: 0,
        balance_due: quotation.grand_total,
        payment_status: 'unpaid',
        status: 'sent',
        notes: quotation.notes,
        terms: quotation.terms,
      }).select().single()
      if (invErr) throw invErr

      await supabase.from('invoice_items').insert(
        (items || []).map((item: any, idx: number) => ({
          invoice_id: invoice.id, organization_id: orgId,
          product_id: item.product_id,
          item_name: item.item_name, hsn_sac: item.hsn_sac,
          quantity: item.quantity, unit: item.unit, rate: item.rate,
          discount_percent: item.discount_percent,
          discount_amount: item.discount_amount,
          taxable_value: item.taxable_value,
          gst_rate: item.gst_rate,
          cgst_rate: item.cgst_rate, sgst_rate: item.sgst_rate, igst_rate: item.igst_rate,
          cgst_amount: item.cgst_amount, sgst_amount: item.sgst_amount, igst_amount: item.igst_amount,
          cess_rate: item.cess_rate, cess_amount: item.cess_amount,
          total_amount: item.total_amount, sort_order: idx,
        }))
      )

      await supabase.from('quotations').update({
        status: 'converted',
        converted_to_invoice_id: invoice.id,
        converted_at: new Date().toISOString(),
      }).eq('id', quotation.id)

      await fetchAll(orgId)
      setShowView(false)
      router.push(`/invoices/${invoice.id}`)
    } catch (err: any) {
      alert('Conversion failed: ' + err.message)
    } finally {
      setConverting(false)
    }
  }

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>Quotations</h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>{quotations.length} quotation{quotations.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true) }} style={{
          padding: '9px 18px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer'
        }}>+ New Quotation</button>
      </div>

      {/* Status guide */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '1.5rem', flexWrap: 'wrap' as const }}>
        {Object.entries(STATUS_CONFIG).map(([key, sc]) => (
          <div key={key} style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '4px 10px', background: sc.bg,
            borderRadius: '99px', fontSize: '11px'
          }}>
            <span style={{ fontWeight: '600', color: sc.color }}>{sc.label}</span>
            <span style={{ color: '#94a3b8' }}>—</span>
            <span style={{ color: '#64748b' }}>{sc.desc}</span>
          </div>
        ))}
      </div>

      {/* List */}
      {quotations.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '40px', marginBottom: '1rem' }}>📋</div>
          <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>No quotations yet</div>
          <div style={{ fontSize: '13px', marginBottom: '1.5rem' }}>Create a quotation → mark as Accepted → convert to Invoice</div>
          <button onClick={() => { resetForm(); setShowForm(true) }} style={{
            padding: '10px 20px', background: '#2563eb', color: 'white',
            border: 'none', borderRadius: '8px', fontSize: '13px',
            fontWeight: '600', cursor: 'pointer'
          }}>Create Quotation</button>
        </div>
      ) : (
        <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div style={{
            display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Quotation No.</span><span>Customer</span>
            <span>Date</span><span>Valid Until</span>
            <span>Amount</span><span>Status</span>
          </div>
          {quotations.map(q => {
            const sc = STATUS_CONFIG[q.status] || STATUS_CONFIG.draft
            return (
              <div key={q.id} onClick={() => openView(q)} style={{
                display: 'grid', gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1fr',
                gap: '12px', padding: '12px 16px',
                borderBottom: '1px solid #f1f5f9',
                alignItems: 'center', fontSize: '13px', cursor: 'pointer'
              }}>
                <div style={{ fontWeight: '600', color: '#2563eb' }}>{q.quotation_number}</div>
                <div style={{ color: '#1e293b' }}>{q.customer_name}</div>
                <div style={{ color: '#64748b' }}>{new Date(q.quotation_date).toLocaleDateString('en-IN')}</div>
                <div style={{ color: '#64748b' }}>{q.valid_until ? new Date(q.valid_until).toLocaleDateString('en-IN') : '—'}</div>
                <div style={{ fontWeight: '500' }}>₹{formatINR(q.grand_total)}</div>
                <div>
                  <span style={{
                    fontSize: '11px', padding: '3px 10px', borderRadius: '99px',
                    fontWeight: '600', background: sc.bg, color: sc.color
                  }}>{sc.label}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* ── VIEW / MANAGE QUOTATION MODAL ── */}
      {showView && selectedQuotation && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          zIndex: 100, padding: '2rem 1rem', overflowY: 'auto'
        }}>
          <div style={{ background: 'white', borderRadius: '16px', width: '100%', maxWidth: '800px', overflow: 'hidden' }}>

            {/* Modal header */}
            <div style={{
              padding: '1rem 1.5rem', borderBottom: '1px solid #e2e8f0',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center'
            }}>
              <div>
                <div style={{ fontWeight: '700', fontSize: '16px', color: '#1e293b' }}>
                  {selectedQuotation.quotation_number}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  {selectedQuotation.customer_name} · ₹{formatINR(selectedQuotation.grand_total)}
                </div>
              </div>
              <button onClick={() => { setShowView(false); setSelectedQuotation(null) }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            {/* Status workflow strip */}
            <div style={{
              padding: '12px 1.5rem', background: '#f8fafc',
              borderBottom: '1px solid #e2e8f0'
            }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
                Quotation Workflow
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' as const }}>

                {/* Step 1 — Mark as Sent */}
                {selectedQuotation.status === 'draft' && (
                  <button onClick={() => updateStatus(selectedQuotation.id, 'sent')} style={{
                    padding: '7px 14px', background: '#eff6ff', color: '#1d4ed8',
                    border: '1px solid #bfdbfe', borderRadius: '6px',
                    fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                  }}>
                    📤 Mark as Sent to Customer
                  </button>
                )}

                {/* Step 2 — Mark Accepted or Rejected */}
                {selectedQuotation.status === 'sent' && (
                  <>
                    <button onClick={() => updateStatus(selectedQuotation.id, 'accepted')} style={{
                      padding: '7px 14px', background: '#f0fdf4', color: '#166534',
                      border: '1px solid #bbf7d0', borderRadius: '6px',
                      fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                    }}>
                      ✓ Customer Accepted
                    </button>
                    <button onClick={() => updateStatus(selectedQuotation.id, 'rejected')} style={{
                      padding: '7px 14px', background: '#fef2f2', color: '#dc2626',
                      border: '1px solid #fecaca', borderRadius: '6px',
                      fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                    }}>
                      ✗ Customer Rejected
                    </button>
                  </>
                )}

                {/* Step 3 — Convert to Invoice */}
                {selectedQuotation.status === 'accepted' && (
                  <button onClick={() => convertToInvoice(selectedQuotation)} disabled={converting} style={{
                    padding: '7px 16px', background: '#059669', color: 'white',
                    border: 'none', borderRadius: '6px',
                    fontSize: '12px', fontWeight: '700',
                    cursor: converting ? 'not-allowed' : 'pointer'
                  }}>
                    {converting ? 'Creating Invoice...' : '🧾 Convert to Invoice'}
                  </button>
                )}

                {/* Already converted */}
                {selectedQuotation.status === 'converted' && selectedQuotation.converted_to_invoice_id && (
                  <button onClick={() => { setShowView(false); router.push(`/invoices/${selectedQuotation.converted_to_invoice_id}`) }} style={{
                    padding: '7px 14px', background: '#fef9c3', color: '#854d0e',
                    border: '1px solid #fde68a', borderRadius: '6px',
                    fontSize: '12px', fontWeight: '600', cursor: 'pointer'
                  }}>
                    View Invoice →
                  </button>
                )}

                {/* Rejected — allow resetting to draft */}
                {selectedQuotation.status === 'rejected' && (
                  <button onClick={() => updateStatus(selectedQuotation.id, 'draft')} style={{
                    padding: '7px 14px', background: '#f1f5f9', color: '#64748b',
                    border: '1px solid #e2e8f0', borderRadius: '6px',
                    fontSize: '12px', cursor: 'pointer'
                  }}>
                    ↩ Reset to Draft
                  </button>
                )}

                {/* Current status badge */}
                <div style={{ marginLeft: 'auto' }}>
                  <span style={{
                    fontSize: '11px', padding: '4px 12px', borderRadius: '99px',
                    fontWeight: '700',
                    background: STATUS_CONFIG[selectedQuotation.status]?.bg,
                    color: STATUS_CONFIG[selectedQuotation.status]?.color,
                  }}>
                    {STATUS_CONFIG[selectedQuotation.status]?.label}
                  </span>
                </div>
              </div>

              {/* Workflow hint */}
              <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '8px' }}>
                {STATUS_CONFIG[selectedQuotation.status]?.desc}
                {selectedQuotation.status === 'draft' && ' → Send it to your customer, then mark as Sent.'}
                {selectedQuotation.status === 'sent' && ' → Once customer responds, mark accordingly.'}
                {selectedQuotation.status === 'accepted' && ' → Click Convert to Invoice to create a GST invoice.'}
              </div>
            </div>

            {/* Quotation document */}
            <div style={{ padding: '1.5rem', fontSize: '12px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <div>
                  <div style={{ fontSize: '20px', fontWeight: '700', color: '#2563eb' }}>QUOTATION</div>
                </div>
                <div style={{ textAlign: 'right' as const }}>
                  <div style={{ fontWeight: '700', fontSize: '15px' }}>{selectedQuotation.quotation_number}</div>
                  <div style={{ color: '#64748b' }}>Date: {new Date(selectedQuotation.quotation_date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                  {selectedQuotation.valid_until && (
                    <div style={{ color: '#dc2626', fontSize: '11px' }}>
                      Valid until: {new Date(selectedQuotation.valid_until).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <div style={{ fontSize: '10px', fontWeight: '700', color: '#94a3b8', marginBottom: '4px', textTransform: 'uppercase' as const }}>Bill To</div>
                <div style={{ fontWeight: '600' }}>{selectedQuotation.customer_name}</div>
                {selectedQuotation.customer_gstin && <div style={{ color: '#374151', fontFamily: 'monospace' }}>GSTIN: {selectedQuotation.customer_gstin}</div>}
                {selectedQuotation.customer_address && <div style={{ color: '#64748b' }}>{selectedQuotation.customer_address}</div>}
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '1rem' }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['#', 'Item', 'HSN/SAC', 'Qty', 'Rate', 'Taxable', 'Tax', 'Total'].map(h => (
                      <th key={h} style={{
                        padding: '6px 8px', border: '1px solid #e2e8f0',
                        fontSize: '11px', fontWeight: '600', color: '#374151',
                        textAlign: ['Rate', 'Taxable', 'Tax', 'Total'].includes(h) ? 'right' as const : 'left' as const
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {selectedItems.map((item, idx) => (
                    <tr key={item.id} style={{ background: idx % 2 === 0 ? 'white' : '#fafafa' }}>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px' }}>{idx + 1}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', fontWeight: '500' }}>{item.item_name}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', fontFamily: 'monospace' }}>{item.hsn_sac || '—'}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px' }}>{item.quantity} {item.unit}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', textAlign: 'right' as const }}>₹{formatINR(item.rate)}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', textAlign: 'right' as const }}>₹{formatINR(item.taxable_value)}</td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', textAlign: 'right' as const }}>
                        {Number(item.cgst_amount) > 0
                          ? `₹${formatINR(Number(item.cgst_amount) + Number(item.sgst_amount))}`
                          : `₹${formatINR(item.igst_amount)}`}
                      </td>
                      <td style={{ padding: '6px 8px', border: '1px solid #e2e8f0', fontSize: '11px', textAlign: 'right' as const, fontWeight: '600' }}>₹{formatINR(item.total_amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                <div style={{ width: '260px' }}>
                  {[
                    { label: 'Taxable Amount', value: selectedQuotation.taxable_amount, show: true },
                    { label: 'CGST', value: selectedQuotation.cgst_amount, show: Number(selectedQuotation.cgst_amount) > 0 },
                    { label: 'SGST', value: selectedQuotation.sgst_amount, show: Number(selectedQuotation.sgst_amount) > 0 },
                    { label: 'IGST', value: selectedQuotation.igst_amount, show: Number(selectedQuotation.igst_amount) > 0 },
                  ].filter(r => r.show).map((row: any) => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '12px', borderBottom: '1px solid #f1f5f9', color: '#64748b' }}>
                      <span>{row.label}</span><span>₹{formatINR(row.value)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', fontSize: '15px', fontWeight: '700', borderTop: '2px solid #1e293b', marginTop: '4px', color: '#1e293b' }}>
                    <span>Grand Total</span>
                    <span style={{ color: '#2563eb' }}>₹{formatINR(selectedQuotation.grand_total)}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: '#94a3b8', fontStyle: 'italic' }}>
                    {numberToWords(Number(selectedQuotation.grand_total))}
                  </div>
                </div>
              </div>

              {selectedQuotation.notes && <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '4px' }}><strong>Notes:</strong> {selectedQuotation.notes}</div>}
              {selectedQuotation.terms && <div style={{ fontSize: '12px', color: '#64748b' }}><strong>Terms:</strong> {selectedQuotation.terms}</div>}
            </div>
          </div>
        </div>
      )}

      {/* ── CREATE FORM MODAL ── */}
      {showForm && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
          zIndex: 100, padding: '2rem 1rem', overflowY: 'auto'
        }}>
          <div style={{ background: 'white', borderRadius: '16px', padding: '2rem', width: '100%', maxWidth: '900px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>New Quotation</h2>
              <button onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Customer *</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={customerId} onChange={e => handleCustomerChange(e.target.value)}>
                  <option value="">Select customer...</option>
                  {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Quotation Date *</label>
                <input style={inputStyle} type="date" value={quotationDate} onChange={e => setQuotationDate(e.target.value)} />
              </div>
              <div>
                <label style={labelStyle}>Valid Until</label>
                <input style={inputStyle} type="date" value={validUntil} onChange={e => setValidUntil(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
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
              <div>
                <label style={labelStyle}>Supply Type</label>
                <select style={{ ...inputStyle, cursor: 'pointer' }} value={supplyType} onChange={e => setSupplyType(e.target.value)}>
                  <option value="b2b">B2B</option>
                  <option value="b2c">B2C</option>
                  <option value="export">Export</option>
                  <option value="sez">SEZ</option>
                </select>
              </div>
            </div>

            {placeOfSupply && orgStateCode && (
              <div style={{
                padding: '8px 12px', borderRadius: '6px', marginBottom: '1rem',
                background: gstType === 'cgst_sgst' ? '#f0fdf4' : '#eff6ff',
                border: `1px solid ${gstType === 'cgst_sgst' ? '#bbf7d0' : '#bfdbfe'}`,
                fontSize: '12px', color: gstType === 'cgst_sgst' ? '#166534' : '#1d4ed8',
              }}>
                {gstType === 'cgst_sgst' ? '✓ Same state — CGST + SGST' : '✓ Interstate — IGST'}
              </div>
            )}

            {/* Line items */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', marginBottom: '1rem' }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#374151', marginBottom: '8px' }}>Line Items</div>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 0.6fr 1fr 32px', gap: '6px', marginBottom: '6px', fontSize: '11px', fontWeight: '600', color: '#94a3b8' }}>
                <span>Item</span><span>HSN/SAC</span><span>Qty</span><span>Rate</span><span>Disc%</span><span>GST%</span><span>Amount</span><span></span>
              </div>

              {lineItems.map((item, index) => (
                <div key={index} style={{ marginBottom: '8px' }}>
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 0.7fr 1fr 0.6fr 0.6fr 1fr 32px', gap: '6px', alignItems: 'center' }}>
                    <div>
                      <select style={{ ...inputStyle, marginBottom: '4px', cursor: 'pointer', fontSize: '12px' }} value={item.product_id} onChange={e => handleProductSelect(index, e.target.value)}>
                        <option value="">Select product...</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input style={{ ...inputStyle, fontSize: '12px' }} value={item.item_name} onChange={e => updateLine(index, 'item_name', e.target.value)} placeholder="Item name" />
                    </div>
                    <input style={{ ...inputStyle, fontSize: '12px' }} value={item.hsn_sac} onChange={e => updateLine(index, 'hsn_sac', e.target.value)} placeholder="HSN/SAC" />
                    <input style={{ ...inputStyle, fontSize: '12px' }} type="number" value={item.quantity} onChange={e => updateLine(index, 'quantity', e.target.value)} min="0" />
                    <input style={{ ...inputStyle, fontSize: '12px' }} type="number" value={item.rate} onChange={e => updateLine(index, 'rate', e.target.value)} placeholder="0.00" min="0" />
                    <input style={{ ...inputStyle, fontSize: '12px' }} type="number" value={item.discount_percent} onChange={e => updateLine(index, 'discount_percent', e.target.value)} min="0" max="100" />
                    <select style={{ ...inputStyle, fontSize: '12px', cursor: 'pointer' }} value={item.gst_rate} onChange={e => updateLine(index, 'gst_rate', e.target.value)}>
                      {[0, 5, 12, 18, 28].map(r => <option key={r} value={r}>{r}%</option>)}
                    </select>
                    <div style={{ padding: '8px 10px', background: 'white', border: '1px solid #e2e8f0', borderRadius: '6px', fontSize: '12px', fontWeight: '500', textAlign: 'right' as const }}>
                      {item.calculated ? `₹${formatINR(item.calculated.total_amount)}` : '—'}
                    </div>
                    <button onClick={() => setLineItems(lineItems.filter((_, i) => i !== index))} disabled={lineItems.length === 1}
                      style={{ width: '28px', height: '28px', border: '1px solid #fecaca', background: '#fef2f2', borderRadius: '6px', cursor: 'pointer', color: '#dc2626', fontSize: '14px', opacity: lineItems.length === 1 ? 0.4 : 1 }}>×</button>
                  </div>
                  {item.calculated && (
                    <div style={{ fontSize: '11px', color: '#64748b', marginTop: '2px', paddingLeft: '4px', display: 'flex', gap: '12px' }}>
                      <span>Taxable: ₹{formatINR(item.calculated.taxable_value)}</span>
                      {item.calculated.cgst_amount > 0 && <span>CGST {item.calculated.cgst_rate}%: ₹{formatINR(item.calculated.cgst_amount)}</span>}
                      {item.calculated.sgst_amount > 0 && <span>SGST {item.calculated.sgst_rate}%: ₹{formatINR(item.calculated.sgst_amount)}</span>}
                      {item.calculated.igst_amount > 0 && <span>IGST {item.calculated.igst_rate}%: ₹{formatINR(item.calculated.igst_amount)}</span>}
                    </div>
                  )}
                </div>
              ))}
              <button onClick={() => setLineItems([...lineItems, emptyLine()])} style={{ marginTop: '6px', padding: '7px 14px', background: 'white', border: '1px dashed #cbd5e1', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', color: '#2563eb', fontWeight: '500' }}>+ Add Line</button>
            </div>

            {/* Totals */}
            {totals && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '1rem', width: '280px' }}>
                  {[
                    { label: 'Taxable Amount', value: totals.taxable_amount, show: true },
                    { label: 'CGST', value: totals.cgst_amount, show: totals.cgst_amount > 0 },
                    { label: 'SGST', value: totals.sgst_amount, show: totals.sgst_amount > 0 },
                    { label: 'IGST', value: totals.igst_amount, show: totals.igst_amount > 0 },
                  ].filter(r => r.show).map(row => (
                    <div key={row.label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: '13px', borderBottom: '1px solid #e2e8f0', color: '#64748b' }}>
                      <span>{row.label}</span><span>₹{formatINR(row.value)}</span>
                    </div>
                  ))}
                  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0 0', fontSize: '15px', fontWeight: '700', color: '#1e293b' }}>
                    <span>Grand Total</span>
                    <span style={{ color: '#2563eb' }}>₹{formatINR(totals.grand_total)}</span>
                  </div>
                </div>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={labelStyle}>Notes</label>
                <textarea style={{ ...inputStyle, height: '60px', resize: 'vertical' as const }} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Notes for customer..." />
              </div>
              <div>
                <label style={labelStyle}>Terms & Conditions</label>
                <textarea style={{ ...inputStyle, height: '60px', resize: 'vertical' as const }} value={terms} onChange={e => setTerms(e.target.value)} placeholder="Payment terms, validity..." />
              </div>
            </div>

            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', padding: '10px 12px', borderRadius: '8px', fontSize: '13px', marginBottom: '1rem' }}>{error}</div>
            )}

            <div style={{ display: 'flex', gap: '12px' }}>
              <button onClick={handleSave} disabled={saving} style={{
                flex: 1, padding: '11px', background: saving ? '#93c5fd' : '#2563eb',
                color: 'white', border: 'none', borderRadius: '8px', fontSize: '14px',
                fontWeight: '600', cursor: saving ? 'not-allowed' : 'pointer'
              }}>{saving ? 'Saving...' : 'Save Quotation'}</button>
              <button onClick={() => { setShowForm(false); resetForm() }} style={{ padding: '11px 20px', background: 'white', color: '#374151', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}