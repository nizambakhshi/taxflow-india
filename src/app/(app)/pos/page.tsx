'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  calculateInvoiceTotals,
  calculateLineItem,
  determineGSTType,
  formatINR,
  type LineItemResult
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import {
  cameraScanSupported,
  findProductByBarcode,
  normalizeBarcode,
  validateBarcode,
} from '@/lib/barcode'
import BarcodeScanner from '@/components/BarcodeScanner'
import { createInvoice } from '@/lib/create-invoice'
import { queueOfflineInvoice, isNetworkError } from '@/lib/outbox'

type Product = {
  id: string
  name: string
  sku: string | null
  hsn_sac: string | null
  unit: string | null
  type: string
  selling_price: number
  gst_rate: number
  cess_rate: number
  track_inventory: boolean
  current_stock: number
}

type Customer = {
  id: string
  name: string
  gstin: string | null
  state: string | null
  state_code: string | null
}

type CartLine = {
  product_id: string
  item_name: string
  hsn_sac: string
  unit: string
  quantity: number
  rate: number
  gst_rate: number
  cess_rate: number
}

type Notice = { tone: 'ok' | 'error'; text: string } | null
type Receipt = { invoiceNumber: string; invoiceId: string; grandTotal: number; queued: boolean }

const PAY_MODES = ['Cash', 'UPI', 'Card', 'Pending'] as const

const inputStyle = {
  width: '100%', padding: '8px 10px',
  border: '1px solid #d1d5db', borderRadius: '6px',
  fontSize: '13px', outline: 'none', color: '#1e293b', background: 'white',
}

function stateName(code: string) {
  return INDIAN_STATES.find(s => s.value === code)?.label || ''
}

export default function PosPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])

  const [cart, setCart] = useState<CartLine[]>([])
  const [barcode, setBarcode] = useState('')
  const [notice, setNotice] = useState<Notice>(null)
  const [search, setSearch] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [paymentMode, setPaymentMode] = useState<(typeof PAY_MODES)[number]>('Cash')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const [scanOpen, setScanOpen] = useState(false)
  const [scanReady] = useState(() => cameraScanSupported())
  const barcodeRef = useRef<HTMLInputElement | null>(null)

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
      const oid = membership.organization_id
      const org = membership.organizations as any

      const [{ data: gstReg }, { data: prods }, { data: custs }] = await Promise.all([
        supabase.from('gst_registrations')
          .select('gstin, state_code').eq('organization_id', oid).eq('is_primary', true).single(),
        supabase.from('products').select('*')
          .eq('organization_id', oid).eq('is_active', true).order('name'),
        supabase.from('customers').select('id, name, gstin, state, state_code')
          .eq('organization_id', oid).eq('is_active', true).order('name'),
      ])

      setOrgId(oid)
      setOrgStateCode(gstReg?.state_code || org?.state_code || '')
      setProducts((prods || []) as Product[])
      setCustomers((custs || []) as Customer[])
      setLoading(false)
    }
    load()
  }, [])

  const customer = customerId ? customers.find(c => c.id === customerId) || null : null
  const placeOfSupply = customer?.state_code || orgStateCode
  const supplyType = customer?.gstin ? 'b2b' : 'b2c'
  const gstType = determineGSTType(orgStateCode, placeOfSupply, supplyType)

  const priced = useMemo(() => cart.map(line => ({
    ...line,
    calculated: calculateLineItem({
      quantity: line.quantity,
      rate: line.rate,
      gst_rate: line.gst_rate,
      cess_rate: line.cess_rate,
    }, gstType) as LineItemResult
  })), [cart, gstType])

  const totals = useMemo(
    () => priced.length ? calculateInvoiceTotals(priced.map(p => p.calculated)) : null,
    [priced]
  )

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(p =>
      p.name?.toLowerCase().includes(q) ||
      p.sku?.toLowerCase().includes(q) ||
      p.hsn_sac?.toLowerCase().includes(q)
    )
  }, [products, search])

  const missingBarcodeCount = products.filter(p => !normalizeBarcode(p.sku || '')).length

  function addProduct(product: Product) {
    setCart(prev => {
      const idx = prev.findIndex(l => l.product_id === product.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], quantity: next[idx].quantity + 1 }
        return next
      }
      return [...prev, {
        product_id: product.id,
        item_name: product.name,
        hsn_sac: product.hsn_sac || '',
        unit: product.unit || 'NOS',
        quantity: 1,
        rate: Number(product.selling_price) || 0,
        gst_rate: Number(product.gst_rate) || 0,
        cess_rate: Number(product.cess_rate) || 0,
      }]
    })
    barcodeRef.current?.focus()
  }

  function handleCode(code: string) {
    const value = normalizeBarcode(code)
    const check = validateBarcode(value)
    if (!check.valid) {
      setNotice({ tone: 'error', text: `${check.message} — "${value}"` })
      return
    }
    const product = findProductByBarcode(products, value)
    if (!product) {
      setNotice({ tone: 'error', text: `No product uses ${value}. Add it under Products with that SKU / barcode.` })
      return
    }
    addProduct(product)
    setNotice({ tone: 'ok', text: `Added ${product.name} — ${check.message}` })
  }

  // Stable handler so turning on the camera does not restart on every keystroke
  const handleCodeRef = useRef(handleCode)
  handleCodeRef.current = handleCode
  const onCameraScan = useCallback((code: string) => {
    handleCodeRef.current(code)
    setScanOpen(false)
  }, [])

  function changeQuantity(productId: string, quantity: number) {
    setCart(prev => prev
      .map(l => l.product_id === productId ? { ...l, quantity } : l)
      .filter(l => l.quantity > 0))
  }

  function changeRate(productId: string, rate: number) {
    setCart(prev => prev.map(l => l.product_id === productId ? { ...l, rate } : l))
  }

  async function ensureCashCustomer(): Promise<Customer> {
    const existing = customers.find(c => (c.name || '').toLowerCase() === 'cash sale')
    if (existing) return existing
    const { data, error } = await supabase
      .from('customers')
      .insert({
        organization_id: orgId,
        name: 'Cash Sale',
        customer_type: 'b2c',
        state: stateName(orgStateCode),
        state_code: orgStateCode,
      })
      .select('id, name, gstin, state, state_code')
      .single()
    if (error) throw error
    setCustomers(prev => [...prev, data])
    return data as Customer
  }

  async function handleCharge() {
    if (!priced.length || !totals) { setFormError('Add at least one item'); return }
    if (!orgStateCode) { setFormError('Set your business state code in Settings first'); return }

    setSaving(true)
    setFormError('')

    try {
      const party = customer || await ensureCashCustomer()
      const partyPlaceOfSupply = party.state_code || orgStateCode
      const partySupplyType = party.gstin ? 'b2b' : 'b2c'
      const paidAmount = paymentMode === 'Pending' ? 0 : totals.grand_total

      const invoiceFields = {
        invoice_type: 'tax_invoice',
        invoice_date: new Date().toISOString().split('T')[0],
        due_date: null,
        customer_id: party.id,
        customer_name: party.name,
        customer_gstin: party.gstin || '',
        customer_address: party.state || '',
        customer_state: stateName(partyPlaceOfSupply),
        customer_state_code: partyPlaceOfSupply,
        place_of_supply: partyPlaceOfSupply,
        place_of_supply_name: stateName(partyPlaceOfSupply),
        supply_type: partySupplyType,
        is_reverse_charge: false,
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
        amount_paid: paidAmount,
        balance_due: totals.grand_total - paidAmount,
        payment_status: paidAmount > 0 ? 'paid' : 'unpaid',
        notes: 'Counter sale',
        terms: '',
        status: 'sent',
      }

      const items = priced.map(line => ({
        product_id: line.product_id,
        item_name: line.item_name,
        hsn_sac: line.hsn_sac,
        quantity: line.quantity,
        unit: line.unit,
        rate: line.rate,
        discount_percent: 0,
        discount_amount: line.calculated.discount_amount,
        taxable_value: line.calculated.taxable_value,
        gst_rate: line.gst_rate,
        cgst_rate: line.calculated.cgst_rate,
        sgst_rate: line.calculated.sgst_rate,
        igst_rate: line.calculated.igst_rate,
        cgst_amount: line.calculated.cgst_amount,
        sgst_amount: line.calculated.sgst_amount,
        igst_amount: line.calculated.igst_amount,
        cess_rate: line.cess_rate,
        cess_amount: line.calculated.cess_amount,
        total_amount: line.calculated.total_amount,
      }))

      // No connection: the sale is queued and the payment record is added at sync time
      if (!navigator.onLine) {
        const entry = queueOfflineInvoice(orgId, invoiceFields, items)
        finishSale({ invoiceNumber: entry.tempNumber, invoiceId: '', grandTotal: totals.grand_total, queued: true })
        return
      }

      const { invoiceId, invoiceNumber } = await createInvoice(supabase, orgId, invoiceFields, items)

      if (paidAmount > 0) {
        await supabase.from('payments').insert({
          organization_id: orgId,
          payment_date: invoiceFields.invoice_date,
          payment_type: 'received',
          payment_mode: paymentMode,
          invoice_id: invoiceId,
          bill_id: null,
          party_name: party.name,
          party_type: 'customer',
          amount: paidAmount,
          reference_number: '',
          notes: 'Counter sale',
        })
      }

      finishSale({ invoiceNumber, invoiceId, grandTotal: totals.grand_total, queued: false })
    } catch (err: any) {
      const message = err?.message || 'Could not complete the sale'
      if (isNetworkError(message)) {
        setFormError('Connection dropped — retry once you are back online.')
      } else {
        setFormError(message)
      }
    } finally {
      setSaving(false)
    }
  }

  function finishSale(nextReceipt: Receipt) {
    setCart([])
    setBarcode('')
    setSearch('')
    setNotice(null)
    setReceipt(nextReceipt)
  }

  if (loading) {
    return <div className="page-container"><p style={{ color: '#64748b', fontSize: '13px' }}>Loading…</p></div>
  }

  const totalLines = priced.reduce((s, l) => s + l.quantity, 0)

  return (
    <div className="page-container" style={{ maxWidth: '1200px' }}>
      <div className="page-header" style={{ marginBottom: '1.25rem' }}>
        <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b' }}>Counter Sale</h1>
        <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
          Scan a barcode or tap a product. The sale creates a normal GST tax invoice.
        </p>
      </div>

      {receipt && (
        <div style={{
          padding: '16px 18px', borderRadius: '10px', marginBottom: '1rem',
          background: receipt.queued ? '#fff7ed' : '#f0fdf4',
          border: `1px solid ${receipt.queued ? '#fed7aa' : '#bbf7d0'}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          gap: '12px', flexWrap: 'wrap'
        }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: '600', color: receipt.queued ? '#9a3412' : '#166534' }}>
              {receipt.queued ? 'Saved offline' : 'Sale completed'} — {receipt.invoiceNumber}
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
              ₹{formatINR(receipt.grandTotal)} · {paymentMode}
              {receipt.queued && ' · syncs when you are back online'}
            </div>
          </div>
          <div className="btn-group" style={{ display: 'flex', gap: '8px' }}>
            {receipt.invoiceId && (
              <button onClick={() => router.push(`/invoices/${receipt.invoiceId}`)} style={{
                padding: '8px 14px', background: 'white', color: '#2563eb',
                border: '1px solid #bfdbfe', borderRadius: '7px', fontSize: '12px',
                fontWeight: '500', cursor: 'pointer'
              }}>Print invoice</button>
            )}
            <button onClick={() => setReceipt(null)} style={{
              padding: '8px 14px', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: '7px', fontSize: '12px',
              fontWeight: '600', cursor: 'pointer'
            }}>New sale</button>
          </div>
        </div>
      )}

      <div className="pos-grid">
        {/* ── Left: scanning + catalogue ── */}
        <div>
          <div style={{
            background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px',
            padding: '16px', marginBottom: '1rem'
          }}>
            <form onSubmit={e => {
              e.preventDefault()
              if (!barcode.trim()) return
              handleCode(barcode)
              setBarcode('')
            }}>
              <label style={{ fontSize: '12px', fontWeight: '500', color: '#374151', display: 'block', marginBottom: '4px' }}>
                Barcode / product code
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  ref={barcodeRef}
                  autoFocus
                  value={barcode}
                  onChange={e => setBarcode(e.target.value)}
                  placeholder="Scan with a USB scanner or type the code"
                  style={{ ...inputStyle, fontFamily: 'monospace' }}
                />
                <button type="submit" style={{
                  padding: '8px 16px', background: '#2563eb', color: 'white',
                  border: 'none', borderRadius: '6px', fontSize: '13px', fontWeight: '600',
                  cursor: 'pointer', whiteSpace: 'nowrap'
                }}>Add</button>
              </div>
            </form>

            {scanReady && (
              <button
                onClick={() => setScanOpen(v => !v)}
                style={{
                  marginTop: '10px', padding: '8px 14px',
                  background: scanOpen ? 'white' : '#0f172a',
                  color: scanOpen ? '#374151' : 'white',
                  border: `1px solid ${scanOpen ? '#e2e8f0' : '#0f172a'}`,
                  borderRadius: '7px', fontSize: '12px', fontWeight: '500', cursor: 'pointer'
                }}
              >
                {scanOpen ? 'Hide camera scanner' : 'Scan with camera'}
              </button>
            )}

            {scanOpen && (
              <BarcodeScanner onScan={onCameraScan} onClose={() => setScanOpen(false)} />
            )}

            {notice && (
              <div style={{
                marginTop: '10px', fontSize: '12px', fontWeight: '500',
                color: notice.tone === 'ok' ? '#166534' : '#991b1b',
                background: notice.tone === 'ok' ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${notice.tone === 'ok' ? '#bbf7d0' : '#fecaca'}`,
                borderRadius: '7px', padding: '8px 10px'
              }}>
                {notice.text}
              </div>
            )}

            {!scanReady && (
              <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '10px' }}>
                Camera scanning needs Chrome, Edge or Android browser. USB scanners and typing work everywhere.
              </p>
            )}
          </div>

          <div style={{
            background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
              <h2 style={{ fontSize: '14px', fontWeight: '600', color: '#1e293b' }}>Products</h2>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, SKU, HSN"
                style={{ ...inputStyle, maxWidth: '220px' }}
              />
            </div>
            {missingBarcodeCount > 0 && (
              <p style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '10px' }}>
                {missingBarcodeCount} product{missingBarcodeCount === 1 ? '' : 's'} still need a barcode —{' '}
                <a href="/products" style={{ color: '#2563eb' }}>add SKUs</a> to scan them.
              </p>
            )}
            <div className="pos-products">
              {visibleProducts.length === 0 ? (
                <p style={{ fontSize: '13px', color: '#64748b' }}>
                  No products match. Add them under Products first.
                </p>
              ) : visibleProducts.map(p => (
                <button
                  key={p.id}
                  onClick={() => { addProduct(p); setNotice({ tone: 'ok', text: `Added ${p.name}` }) }}
                  style={{
                    textAlign: 'left', padding: '10px 12px', background: 'white',
                    border: '1px solid #e2e8f0', borderRadius: '9px', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', gap: '3px'
                  }}
                >
                  <span style={{ fontSize: '13px', fontWeight: '500', color: '#1e293b' }}>{p.name}</span>
                  <span style={{ fontSize: '12px', color: '#2563eb', fontWeight: '600' }}>
                    ₹{formatINR(Number(p.selling_price) || 0)}
                  </span>
                  <span style={{ fontSize: '11px', color: '#94a3b8' }}>
                    GST {p.gst_rate}%{normalizeBarcode(p.sku || '') ? ` · ${p.sku}` : ' · no barcode'}
                    {p.track_inventory ? ` · stock ${p.current_stock}` : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* ── Right: cart ── */}
        <div className="pos-cart">
          <div style={{
            background: 'white', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '16px'
          }}>
            <h2 style={{ fontSize: '14px', fontWeight: '600', color: '#1e293b', marginBottom: '12px' }}>
              Cart {totalLines > 0 && <span style={{ color: '#64748b', fontWeight: '400' }}>({totalLines})</span>}
            </h2>

            {priced.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#64748b' }}>Nothing added yet.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '14px' }}>
                {priced.map(line => (
                  <div key={line.product_id} style={{
                    display: 'flex', alignItems: 'center', gap: '8px',
                    padding: '8px 10px', background: '#f8fafc',
                    border: '1px solid #e2e8f0', borderRadius: '8px', flexWrap: 'wrap'
                  }}>
                    <div style={{ flex: '1 1 140px', minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: '500', color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {line.item_name}
                      </div>
                      <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                        ₹{formatINR(line.rate)} × {line.quantity} = ₹{formatINR(line.calculated.total_amount)}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <button onClick={() => changeQuantity(line.product_id, line.quantity - 1)} style={stepBtn}>−</button>
                      <span style={{ fontSize: '13px', minWidth: '22px', textAlign: 'center', color: '#1e293b' }}>{line.quantity}</span>
                      <button onClick={() => changeQuantity(line.product_id, line.quantity + 1)} style={stepBtn}>+</button>
                    </div>
                    <input
                      type="number"
                      value={line.rate}
                      onChange={e => changeRate(line.product_id, parseFloat(e.target.value) || 0)}
                      style={{ ...inputStyle, width: '84px', textAlign: 'right' }}
                    />
                    <button onClick={() => changeQuantity(line.product_id, 0)} style={{
                      background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '15px'
                    }}>×</button>
                  </div>
                ))}
              </div>
            )}

            <label style={{ fontSize: '12px', fontWeight: '500', color: '#374151', display: 'block', marginBottom: '4px' }}>
              Customer
            </label>
            <select
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
              style={{ ...inputStyle, marginBottom: '12px' }}
            >
              <option value="">Walk-in cash sale</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` — ${c.gstin}` : ''}</option>
              ))}
            </select>

            <label style={{ fontSize: '12px', fontWeight: '500', color: '#374151', display: 'block', marginBottom: '4px' }}>
              Payment
            </label>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
              {PAY_MODES.map(mode => (
                <button
                  key={mode}
                  onClick={() => setPaymentMode(mode)}
                  style={{
                    padding: '7px 14px', borderRadius: '999px', fontSize: '12px', fontWeight: '500', cursor: 'pointer',
                    background: paymentMode === mode ? '#2563eb' : 'white',
                    color: paymentMode === mode ? 'white' : '#374151',
                    border: `1px solid ${paymentMode === mode ? '#2563eb' : '#e2e8f0'}`
                  }}
                >
                  {mode}
                </button>
              ))}
            </div>

            {totals && (
              <div style={{
                borderTop: '1px solid #e2e8f0', paddingTop: '12px',
                display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '13px'
              }}>
                <Row label="Taxable" value={`₹ ${formatINR(totals.taxable_amount)}`} />
                {gstType === 'igst'
                  ? <Row label="IGST" value={`₹ ${formatINR(totals.igst_amount)}`} />
                  : <>
                      <Row label="CGST" value={`₹ ${formatINR(totals.cgst_amount)}`} />
                      <Row label="SGST" value={`₹ ${formatINR(totals.sgst_amount)}`} />
                    </>}
                {totals.cess_amount > 0 && <Row label="Cess" value={`₹ ${formatINR(totals.cess_amount)}`} />}
                {totals.round_off !== 0 && <Row label="Round off" value={`₹ ${formatINR(totals.round_off)}`} />}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', paddingTop: '8px',
                  borderTop: '1px solid #e2e8f0', marginTop: '4px',
                  fontSize: '15px', fontWeight: '600', color: '#1e293b'
                }}>
                  <span>Total</span>
                  <span>₹ {formatINR(totals.grand_total)}</span>
                </div>
              </div>
            )}

            {formError && (
              <div style={{
                marginTop: '12px', fontSize: '12px', fontWeight: '500', color: '#991b1b',
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '7px', padding: '8px 10px'
              }}>
                {formError}
              </div>
            )}

            <button
              onClick={handleCharge}
              disabled={saving || priced.length === 0}
              style={{
                width: '100%', marginTop: '14px', padding: '12px',
                background: '#2563eb', color: 'white', border: 'none', borderRadius: '8px',
                fontSize: '14px', fontWeight: '600',
                cursor: saving || priced.length === 0 ? 'not-allowed' : 'pointer',
                opacity: saving || priced.length === 0 ? 0.5 : 1
              }}
            >
              {saving ? 'Creating invoice…' : totals ? `Charge ₹ ${formatINR(totals.grand_total)}` : 'Charge'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .pos-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 1rem; align-items: start; }
        .pos-products { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .pos-cart { position: sticky; top: 1rem; }
        @media (max-width: 900px) {
          .pos-grid { grid-template-columns: 1fr; }
          .pos-cart { position: static; }
        }
      `}</style>
    </div>
  )
}

const stepBtn = {
  width: '26px', height: '26px', borderRadius: '6px',
  border: '1px solid #e2e8f0', background: 'white',
  color: '#374151', fontSize: '14px', cursor: 'pointer', lineHeight: '1',
} as const

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#475569' }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  )
}
