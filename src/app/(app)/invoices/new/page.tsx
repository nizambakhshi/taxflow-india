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
import { GST_RATES } from '@/lib/gst-rates'
import { queueOfflineInvoice, isNetworkError } from '@/lib/outbox'
import { createInvoice } from '@/lib/create-invoice'
import { askSeal } from '@/lib/audit'
import {
  loadSetup, resolveSeries, composeNumber, activeBranches, stampBranchNote,
  type Branch,
} from '@/lib/setup'
import { Button, Card, PageHeader, SectionTitle } from '@/components/ui'
import SealNotice from '@/components/SealNotice'
import Icon from '@/components/Icons'

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

  // R3-2 — issuing branch. '' means the primary registration on file (the values
  // loaded from Supabase); picking a branch swaps the seller block to the branch's
  // GSTIN/state/address and stamps the notes with [branch CODE].
  const [branches, setBranches] = useState<Branch[]>([])
  const [branchCode, setBranchCode] = useState('')
  const [homeSeller, setHomeSeller] = useState({ name: '', gstin: '', state: '', address: '' })

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
      const orgAddressStr = [org?.address_line1, org?.city].filter(Boolean).join(', ')
      setOrgName(org?.name || '')
      setOrgStateCode(org?.state_code || '')
      setOrgAddress(orgAddressStr)

      // Get primary GSTIN
      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('gstin, state_code')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      const homeState = gstReg?.state_code || org?.state_code || ''
      if (gstReg) setOrgGstin(gstReg.gstin)

      // Mirror of the primary seller — selecting a branch overrides the four
      // displayed fields, and picking "Head office" restores these.
      setHomeSeller({
        name: org?.name || '',
        gstin: gstReg?.gstin || '',
        state: homeState,
        address: orgAddressStr,
      })
      if (homeState) setOrgStateCode(homeState)

      // R3-2 — the branch register and the number's *shape*. The counter stays
      // in invoice_sequences (the row still counts); the series register here
      // dresses that count into a number. The save path in create-invoice.ts
      // composes with the same format, so this preview is the number it writes.
      const setup = loadSetup(membership.organization_id)
      setBranches(activeBranches(setup))
      const fmt = resolveSeries(setup, 'invoice')
      const fy = getFinancialYear()
      const { data: seq } = await supabase
        .from('invoice_sequences')
        .select('*')
        .eq('organization_id', membership.organization_id)
        .eq('financial_year', fy)
        .single()

      setInvoiceNumber(composeNumber(fmt, seq ? seq.last_number + 1 : 1, fy))

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

  // R3-2 — issuing branch. Swaps the printed seller to the branch's own GSTIN /
  // state / address (which re-runs the place-of-supply → GST-type effect), and
  // restores the primary registration when the head office is picked again.
  function handleBranchChange(code: string) {
    setBranchCode(code)
    const b = code ? branches.find(x => x.code.toUpperCase() === code.toUpperCase()) : null
    if (!b) {
      setOrgName(homeSeller.name)
      setOrgGstin(homeSeller.gstin)
      setOrgStateCode(homeSeller.state)
      setOrgAddress(homeSeller.address)
      return
    }
    setOrgName(b.name)
    setOrgGstin(b.gstin)
    setOrgStateCode(b.state_code)
    setOrgAddress([b.address, b.city].filter(Boolean).join(', '))
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

    // The seal, asked here as well as inside `createInvoice`: the writer is the door, but this
    // page can save the shop a round trip — and a form that says "sealed" before the button is
    // pressed reads better than one that throws after. `askSeal` both asks and logs the attempt,
    // so the edit that never happened is still on the append-only trail.
    const stop = askSeal(orgId, {
      date: invoiceDate,
      target: 'invoice',
      ref: 'draft',
      actor: orgName || undefined,
    })
    if (stop) {
      setError(stop.why)
      return
    }

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
      // R3-2 — the branch stamp rides in the notes (invoices has no branch column;
      // the durable record stays the document + this tag). '' clears the stamp.
      notes: stampBranchNote(notes, branchCode),
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
      const { invoiceId } = await createInvoice(supabase, orgId, invoiceFields, itemsPayload)
      router.push(`/invoices/${invoiceId}`)
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
    <div className="page-container ni" style={{ maxWidth: 1100 }}>
      <button className="ni-back" onClick={() => router.push('/invoices')}>
        ← Back to invoices
      </button>

      <PageHeader
        eyebrow="Sales"
        title="New tax invoice"
        subtitle="Numbered when you save — drafts stay editable from the list."
        actions={
          <>
            <Button variant="ghost" onClick={() => handleSave('draft')} disabled={saving}>
              Save draft
            </Button>
            <Button onClick={() => handleSave('sent')} disabled={saving}>
              {saving ? 'Saving…' : 'Save invoice'}
            </Button>
          </>
        }
      />

      {error && (
        <div className="ni-alert" role="alert">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          {error}
        </div>
      )}

      <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* Seller details */}
        <Card>
          <SectionTitle icon="building">From (seller)</SectionTitle>
          <div className="ni-seller-name">{orgName}</div>
          {orgGstin && <div className="ni-seller-line ni-mono">GSTIN: {orgGstin}</div>}
          {orgAddress && <div className="ni-seller-line">{orgAddress}</div>}
          {branches.length > 0 && (
            <div className="ni-field" style={{ marginTop: 10 }}>
              <span>Issuing branch</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={branchCode}
                onChange={e => handleBranchChange(e.target.value)}>
                <option value="">Head office — primary registration</option>
                {branches.map(b => (
                  <option key={b.id} value={b.code}>
                    {b.code} — {b.name}{b.is_head ? ' (head)' : ''}
                  </option>
                ))}
              </select>
              <div className="ni-seller-line" style={{ marginTop: 6 }}>
                {branchCode
                  ? `Issued under ${branchCode} — its GSTIN and state print on the invoice, and the notes carry [branch ${branchCode}].`
                  : 'Add GST registrations and branches on the Business page to issue from them.'}
              </div>
            </div>
          )}
        </Card>

        {/* Invoice details */}
        <Card>
          <SectionTitle icon="invoice">Invoice details</SectionTitle>
          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="ni-field">
              <span>Invoice number</span>
              <input className="tf-input ni-lock" value={invoiceNumber} readOnly />
            </div>
            <div className="ni-field">
              <span>Invoice date *</span>
              <input className="tf-input" type="date" value={invoiceDate}
                onChange={e => setInvoiceDate(e.target.value)} required />
              <SealNotice orgId={orgId} date={invoiceDate} />
            </div>
            <div className="ni-field">
              <span>Due date</span>
              <input className="tf-input" type="date" value={dueDate}
                onChange={e => setDueDate(e.target.value)} />
            </div>
            <div className="ni-field">
              <span>Supply type</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={supplyType}
                onChange={e => setSupplyType(e.target.value)}>
                <option value="b2b">B2B</option>
                <option value="b2c">B2C</option>
                <option value="export">Export</option>
                <option value="sez">SEZ</option>
              </select>
            </div>
          </div>
        </Card>
      </div>

      {/* Customer selection */}
      <Card style={{ marginBottom: '1rem' }}>
        <SectionTitle icon="users">Bill to (customer)</SectionTitle>
        <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
          <div className="ni-field">
            <span>Select customer *</span>
            <select className="tf-input" style={{ cursor: 'pointer' }} value={customerId}
              onChange={e => handleCustomerChange(e.target.value)}>
              <option value="">Select customer...</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.business_name ? ` — ${c.business_name}` : ''}</option>
              ))}
            </select>
          </div>
          <div className="ni-field">
            <span>Customer GSTIN</span>
            <input className="tf-input ni-lock ni-mono"
              value={customerGstin} readOnly placeholder="Auto-filled" />
          </div>
          <div className="ni-field">
            <span>Place of supply *</span>
            <select className="tf-input" style={{ cursor: 'pointer' }} value={placeOfSupply}
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
          <div className={`ni-note ${gstType === 'cgst_sgst' ? 'is-local' : 'is-inter'}`}>
            <Icon name="check" size={13} strokeWidth={2.6} />
            {gstType === 'cgst_sgst'
              ? 'Same state — CGST + SGST will be applied'
              : 'Interstate / Export — IGST will be applied'}
          </div>
        )}

        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" id="rc" checked={isReverseCharge}
            onChange={e => setIsReverseCharge(e.target.checked)} />
          <label htmlFor="rc" style={{ fontSize: 13, color: 'var(--ink-2)', cursor: 'pointer' }}>
            Reverse charge applicable
          </label>
        </div>
      </Card>

      {/* Line Items */}
      <Card style={{ marginBottom: '1rem' }}>
        <SectionTitle icon="book">Line items</SectionTitle>

        {/* Column headers */}
        <div className="line-items-head ni-head" style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px',
          gap: 6, marginBottom: 6
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
          <div key={index} style={{ marginBottom: 8 }}>
            <div className="line-item-row" style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 0.8fr 1fr 0.7fr 0.7fr 1fr 36px',
              gap: 6, alignItems: 'center'
            }}>
              {/* Item name / product select */}
              <div className="li-full" data-label="Item *">
                <select
                  className="tf-input"
                  style={{ marginBottom: 4, cursor: 'pointer' }}
                  value={item.product_id}
                  onChange={e => handleProductSelect(index, e.target.value)}
                >
                  <option value="">Select product...</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <input className="tf-input" value={item.item_name}
                  onChange={e => updateLineItem(index, 'item_name', e.target.value)}
                  placeholder="Or type item name" />
              </div>

              <div data-label="HSN/SAC">
                <input className="tf-input" value={item.hsn_sac}
                  onChange={e => updateLineItem(index, 'hsn_sac', e.target.value)}
                  placeholder="HSN/SAC" />
              </div>

              <div data-label="Qty *">
                <input className="tf-input" type="number" value={item.quantity}
                  onChange={e => updateLineItem(index, 'quantity', e.target.value)}
                  min="0" step="0.001" />
              </div>

              <div data-label="Rate (₹) *">
                <input className="tf-input" type="number" value={item.rate}
                  onChange={e => updateLineItem(index, 'rate', e.target.value)}
                  placeholder="0.00" min="0" step="0.01" />
              </div>

              <div data-label="Disc %">
                <input className="tf-input" type="number" value={item.discount_percent}
                  onChange={e => updateLineItem(index, 'discount_percent', e.target.value)}
                  min="0" max="100" step="0.01" />
              </div>

              <div data-label="GST %">
                <select className="tf-input" style={{ cursor: 'pointer' }} value={item.gst_rate}
                  onChange={e => updateLineItem(index, 'gst_rate', e.target.value)}>
                  {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                </select>
              </div>

              {/* Calculated total */}
              <div data-label="Amount" className="ni-amount">
                {item.calculated ? `₹${formatINR(item.calculated.total_amount)}` : '—'}
              </div>

              <div className="li-full" style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button
                  variant="danger"
                  size="sm"
                  icon="x"
                  disabled={lineItems.length === 1}
                  onClick={() => removeLine(index)}
                  style={{ width: 32, height: 32, padding: 0 }}
                  title="Remove line"
                >{' '}</Button>
              </div>
            </div>

            {/* Tax breakdown for this line */}
            {item.calculated && (
              <div className="ni-break">
                <span>Taxable: ₹{formatINR(item.calculated.taxable_value)}</span>
                {item.calculated.cgst_amount > 0 && <span>CGST {item.calculated.cgst_rate}%: ₹{formatINR(item.calculated.cgst_amount)}</span>}
                {item.calculated.sgst_amount > 0 && <span>SGST {item.calculated.sgst_rate}%: ₹{formatINR(item.calculated.sgst_amount)}</span>}
                {item.calculated.igst_amount > 0 && <span>IGST {item.calculated.igst_rate}%: ₹{formatINR(item.calculated.igst_amount)}</span>}
                {item.calculated.cess_amount > 0 && <span>Cess: ₹{formatINR(item.calculated.cess_amount)}</span>}
              </div>
            )}
          </div>
        ))}

        <div style={{ marginTop: 8 }}>
          <Button variant="ghost" size="sm" icon="plus" onClick={addLine}>
            Add line item
          </Button>
        </div>
      </Card>

      <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
        {/* Notes & Terms */}
        <Card>
          <SectionTitle icon="chat">Notes &amp; terms</SectionTitle>
          <div className="ni-field" style={{ marginBottom: 10 }}>
            <span>Notes (visible on invoice)</span>
            <textarea className="tf-input ni-area"
              value={notes} onChange={e => setNotes(e.target.value)}
              placeholder="Thank you for your business..." />
          </div>
          <div className="ni-field">
            <span>Terms &amp; conditions</span>
            <textarea className="tf-input ni-area"
              value={terms} onChange={e => setTerms(e.target.value)}
              placeholder="Payment due within 30 days..." />
          </div>
        </Card>

        {/* Totals */}
        {totals && (
          <Card>
            <SectionTitle icon="scale">Invoice summary</SectionTitle>
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
              <div key={row.label} className="ni-tot-row">
                <span className="is-label">{row.label}</span>
                <span className={`tf-num ${row.value < 0 ? 'is-neg' : 'is-val'}`}>
                  ₹{formatINR(Math.abs(row.value))}
                </span>
              </div>
            ))}
            <div className="ni-tot-grand">
              <span>Grand Total</span>
              <span className="tf-num amt">₹{formatINR(totals.grand_total)}</span>
            </div>
            <div className="ni-words">
              {numberToWords(totals.grand_total)}
            </div>
          </Card>
        )}
      </div>

      {/* Save buttons */}
      <div className="btn-group" style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <Button variant="ghost" onClick={() => router.push('/invoices')}>Cancel</Button>
        <Button variant="ghost" onClick={() => handleSave('draft')} disabled={saving}>Save as draft</Button>
        <Button icon={saving ? undefined : 'check'} onClick={() => handleSave('sent')} disabled={saving}>
          {saving ? 'Saving…' : 'Save invoice'}
        </Button>
      </div>

      <style>{`
        .ni-back {
          background: none; border: none; padding: 0; margin-bottom: 10px;
          color: var(--brand); font-size: 12.5px; font-weight: 600; cursor: pointer;
        }
        .ni-back:hover { text-decoration: underline; }

        .ni-alert {
          display: flex; align-items: center; gap: 8px;
          font-size: 12.5px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px;
          background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red);
        }
        .ni-alert svg { flex-shrink: 0; }

        .ni-field { display: flex; flex-direction: column; gap: 4px; }
        .ni-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ni-lock { background: var(--surface-2); font-weight: 600; }
        .ni-mono { font-family: var(--mono); }
        .ni-area { height: 70px; resize: vertical; }

        .ni-seller-name { font-weight: 650; font-size: 15px; color: var(--ink); }
        .ni-seller-line { font-size: 12px; color: var(--muted); margin-top: 2px; }

        .ni-note {
          margin-top: 10px; padding: 8px 12px; border-radius: 8px; font-size: 12px;
          display: flex; align-items: center; gap: 6px;
        }
        .ni-note.is-local {
          background: var(--green-soft);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white);
          color: var(--green);
        }
        .ni-note.is-inter {
          background: var(--brand-soft);
          border: 1px solid color-mix(in srgb, var(--brand) 22%, white);
          color: var(--brand-dark);
        }

        .ni-head { font-size: 11px; font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.04em; }

        .ni-amount {
          padding: 8px 10px; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 13px; font-weight: 500; color: var(--ink);
          text-align: right;
        }

        .ni-break {
          font-size: 11px; color: var(--muted); margin-top: 3px;
          padding-left: 4px; display: flex; gap: 16px; flex-wrap: wrap;
        }

        .ni-tot-row {
          display: flex; justify-content: space-between; padding: 5px 0;
          font-size: 13px; border-bottom: 1px solid var(--line-soft);
        }
        .ni-tot-row .is-label { color: var(--muted); }
        .ni-tot-row .is-val { color: var(--ink); font-weight: 500; }
        .ni-tot-row .is-neg { color: var(--red); font-weight: 500; }

        .ni-tot-grand {
          display: flex; justify-content: space-between; padding: 10px 0 4px;
          font-size: 15px; font-weight: 700; color: var(--ink); margin-top: 4px;
        }
        .ni-tot-grand .amt { color: var(--brand); }

        .ni-words { font-size: 11px; color: var(--faint); margin-top: 6px; font-style: italic; }
      `}</style>
    </div>
  )
}
