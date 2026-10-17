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
import { Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatRow } from '@/components/ui'
import Icon from '@/components/Icons'
import { plural } from '@/lib/format'

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
const PAY_MODE_OPTIONS = PAY_MODES.map(m => ({ value: m, label: m }))

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
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the counter…</div>
  }

  const totalLines = priced.reduce((s, l) => s + l.quantity, 0)

  return (
    <div className="page-container pos" style={{ maxWidth: 1200 }}>
      <PageHeader
        eyebrow="Sales"
        title="Counter sale"
        subtitle="Scan a barcode or tap a product. The sale creates a normal GST tax invoice."
      />

      {receipt && (
        <div className={`pos-receipt ${receipt.queued ? 'is-queued' : 'is-done'}`}>
          <div>
            <div className="pos-receipt-title">
              {receipt.queued ? 'Saved offline' : 'Sale completed'} — {receipt.invoiceNumber}
            </div>
            <div className="pos-receipt-sub">
              ₹{formatINR(receipt.grandTotal)} · {paymentMode}
              {receipt.queued && ' · syncs when you are back online'}
            </div>
          </div>
          <div className="tf-row" style={{ gap: 8 }}>
            {receipt.invoiceId && (
              <Button size="sm" variant="ghost" onClick={() => router.push(`/invoices/${receipt.invoiceId}`)}>Print invoice</Button>
            )}
            <Button size="sm" icon="plus" onClick={() => setReceipt(null)}>New sale</Button>
          </div>
        </div>
      )}

      <div className="pos-grid">
        {/* ── Left: scanning + catalogue ── */}
        <div>
          <Card style={{ marginBottom: '1rem' }}>
            <form onSubmit={e => {
              e.preventDefault()
              if (!barcode.trim()) return
              handleCode(barcode)
              setBarcode('')
            }}>
              <label className="pos-label" htmlFor="pos-barcode">Barcode / product code</label>
              <div className="tf-row" style={{ gap: 8 }}>
                <input
                  id="pos-barcode"
                  ref={barcodeRef}
                  autoFocus
                  value={barcode}
                  onChange={e => setBarcode(e.target.value)}
                  placeholder="Scan with a USB scanner or type the code"
                  className="tf-input pos-mono"
                  style={{ flex: 1, minWidth: 0 }}
                />
                <Button type="submit">Add</Button>
              </div>
            </form>

            {scanReady && (
              <Button
                variant={scanOpen ? 'subtle' : 'ghost'}
                size="sm"
                icon="scan"
                onClick={() => setScanOpen(v => !v)}
                style={{ marginTop: 10 }}
              >
                {scanOpen ? 'Hide camera scanner' : 'Scan with camera'}
              </Button>
            )}

            {scanOpen && (
              <BarcodeScanner onScan={onCameraScan} onClose={() => setScanOpen(false)} />
            )}

            {notice && (
              <div className={`pos-notice ${notice.tone === 'ok' ? 'is-ok' : 'is-error'}`}>
                <Icon name={notice.tone === 'ok' ? 'check' : 'alert'} size={14} />
                {notice.text}
              </div>
            )}

            {!scanReady && (
              <p className="pos-hint" style={{ marginTop: 10 }}>
                Camera scanning needs Chrome, Edge or Android browser. USB scanners and typing work everywhere.
              </p>
            )}
          </Card>

          <Card>
            <SectionTitle
              icon="box"
              action={<SearchInput value={search} onChange={setSearch} placeholder="Name, SKU, HSN…" ariaLabel="Search products" style={{ maxWidth: 220 }} />}
            >
              Products
            </SectionTitle>
            {missingBarcodeCount > 0 && (
              <p className="pos-hint" style={{ marginBottom: 10 }}>
                {plural(missingBarcodeCount, 'product')} still {missingBarcodeCount === 1 ? 'needs' : 'need'} a barcode —{' '}
                <a href="/products" className="pos-link">add SKUs</a> to scan them.
              </p>
            )}
            {visibleProducts.length === 0 ? (
              <EmptyState
                icon="search"
                title="No products match"
                message="Try a different name, SKU or HSN — or add the item to the catalogue first."
                action={<Button size="sm" variant="subtle" href="/products" icon="plus">Add items</Button>}
              />
            ) : (
              <div className="pos-products">
                {visibleProducts.map(p => (
                  <button
                    key={p.id}
                    className="pos-tile"
                    onClick={() => { addProduct(p); setNotice({ tone: 'ok', text: `Added ${p.name}` }) }}
                  >
                    <span className="pos-tile-name">{p.name}</span>
                    <span className="pos-tile-price tf-num">₹{formatINR(Number(p.selling_price) || 0)}</span>
                    <span className="pos-tile-sub">
                      GST {p.gst_rate}%{normalizeBarcode(p.sku || '') ? ` · ${p.sku}` : ' · no barcode'}
                      {p.track_inventory ? ` · stock ${p.current_stock}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Card>
        </div>

        {/* ── Right: cart ── */}
        <div className="pos-cart">
          <Card>
            <SectionTitle icon="cart">
              Cart {totalLines > 0 && <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({totalLines})</span>}
            </SectionTitle>

            {priced.length === 0 ? (
              <EmptyState icon="cart" title="Cart is empty" message="Scan a barcode or tap a product to start the sale." />
            ) : (
              <div className="pos-lines">
                {priced.map(line => (
                  <div key={line.product_id} className="pos-line">
                    <div className="pos-line-main">
                      <div className="pos-line-name">{line.item_name}</div>
                      <div className="pos-line-sub">₹{formatINR(line.rate)} × {line.quantity} = ₹{formatINR(line.calculated.total_amount)}</div>
                    </div>
                    <div className="tf-row" style={{ gap: 4 }}>
                      <button className="pos-step" aria-label={`Reduce ${line.item_name}`} onClick={() => changeQuantity(line.product_id, line.quantity - 1)}>−</button>
                      <span className="pos-qty tf-num">{line.quantity}</span>
                      <button className="pos-step" aria-label={`Add one more ${line.item_name}`} onClick={() => changeQuantity(line.product_id, line.quantity + 1)}>+</button>
                    </div>
                    <input
                      type="number"
                      className="tf-input pos-rate"
                      value={line.rate}
                      aria-label={`Rate for ${line.item_name}`}
                      onChange={e => changeRate(line.product_id, parseFloat(e.target.value) || 0)}
                    />
                    <button className="pos-x" aria-label={`Remove ${line.item_name}`} onClick={() => changeQuantity(line.product_id, 0)}>×</button>
                  </div>
                ))}
              </div>
            )}

            <label className="pos-label" htmlFor="pos-customer">Customer</label>
            <select
              id="pos-customer"
              value={customerId}
              onChange={e => setCustomerId(e.target.value)}
              className="tf-input"
              style={{ marginBottom: 12 }}
            >
              <option value="">Walk-in cash sale</option>
              {customers.map(c => (
                <option key={c.id} value={c.id}>{c.name}{c.gstin ? ` — ${c.gstin}` : ''}</option>
              ))}
            </select>

            <label className="pos-label">Payment</label>
            <div style={{ marginBottom: 14 }}>
              <Segmented
                options={PAY_MODE_OPTIONS}
                value={paymentMode}
                onChange={v => setPaymentMode(v as (typeof PAY_MODES)[number])}
              />
            </div>

            {totals && (
              <div className="pos-totals">
                <StatRow label="Taxable" value={`₹ ${formatINR(totals.taxable_amount)}`} />
                {gstType === 'igst'
                  ? <StatRow label="IGST" value={`₹ ${formatINR(totals.igst_amount)}`} tone="cyan" />
                  : <>
                      <StatRow label="CGST" value={`₹ ${formatINR(totals.cgst_amount)}`} tone="violet" />
                      <StatRow label="SGST" value={`₹ ${formatINR(totals.sgst_amount)}`} tone="violet" />
                    </>}
                {totals.cess_amount > 0 && <StatRow label="Cess" value={`₹ ${formatINR(totals.cess_amount)}`} />}
                {totals.round_off !== 0 && <StatRow label="Round off" value={`₹ ${formatINR(totals.round_off)}`} />}
                <div className="pos-total tf-row-between">
                  <span>Total</span>
                  <span className="tf-num">₹ {formatINR(totals.grand_total)}</span>
                </div>
              </div>
            )}

            {formError && (
              <div className="pos-notice is-error" style={{ marginTop: 12 }}>
                <Icon name="alert" size={14} />
                {formError}
              </div>
            )}

            <Button
              onClick={handleCharge}
              disabled={saving || priced.length === 0}
              icon={saving ? undefined : 'check'}
              style={{ width: '100%', marginTop: 14 }}
            >
              {saving ? 'Creating invoice…' : totals ? `Charge ₹ ${formatINR(totals.grand_total)}` : 'Charge'}
            </Button>
          </Card>
        </div>
      </div>

      <style>{`
        .pos-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 1rem; align-items: start; }
        .pos-products { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
        .pos-cart { position: sticky; top: 1rem; }

        .pos-label { display: block; font-size: 12px; font-weight: 550; color: var(--ink-2); margin-bottom: 4px; }
        .pos-mono { font-family: var(--mono); letter-spacing: 0.03em; }
        .pos-hint { font-size: 11px; color: var(--faint); }
        .pos-link { color: var(--brand); }

        .pos-tile { text-align: left; padding: 10px 12px; background: var(--surface);
          border: 1px solid var(--line); border-radius: var(--radius-sm); cursor: pointer;
          display: flex; flex-direction: column; gap: 3px; font-family: inherit; }
        .pos-tile:hover { border-color: var(--brand); box-shadow: var(--shadow-xs); }
        .pos-tile-name { font-size: 13px; font-weight: 550; color: var(--ink); }
        .pos-tile-price { font-size: 12px; font-weight: 650; color: var(--brand); }
        .pos-tile-sub { font-size: 11px; color: var(--faint); }

        .pos-lines { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
        .pos-line { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
          background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          flex-wrap: wrap; }
        .pos-line-main { flex: 1 1 140px; min-width: 0; }
        .pos-line-name { font-size: 13px; font-weight: 550; color: var(--ink);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pos-line-sub { font-size: 11px; color: var(--faint); }
        .pos-step { width: 26px; height: 26px; border-radius: 6px; border: 1px solid var(--line);
          background: var(--surface); color: var(--ink-2); font-size: 14px; cursor: pointer; line-height: 1; }
        .pos-step:hover { border-color: var(--brand); color: var(--brand); }
        .pos-qty { font-size: 13px; min-width: 22px; text-align: center; color: var(--ink); }
        .pos-rate { width: 84px; text-align: right; }
        .pos-x { background: none; border: none; color: var(--faint); cursor: pointer; font-size: 15px; padding: 4px; }
        .pos-x:hover { color: var(--red); }

        .pos-totals { border-top: 1px solid var(--line); padding-top: 4px; }
        .pos-totals > .tf-row-between:nth-last-child(2) { border-bottom: none; }
        .pos-total { padding-top: 10px; margin-top: 4px; border-top: 1px solid var(--line);
          font-size: 15px; font-weight: 700; color: var(--ink); }

        .pos-notice { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 550;
          border-radius: var(--radius-sm); padding: 8px 10px; margin-top: 10px; }
        .pos-notice svg { flex-shrink: 0; }
        .pos-notice.is-ok { background: var(--green-soft); color: #15803d; }
        .pos-notice.is-error { background: var(--red-soft); color: #b91c1c; }

        .pos-receipt { display: flex; justify-content: space-between; align-items: center; gap: 12px;
          flex-wrap: wrap; padding: 14px 16px; border-radius: var(--radius); margin-bottom: 1rem; border: 1px solid; }
        .pos-receipt.is-done { background: var(--green-soft); border-color: #bbf7d0; }
        .pos-receipt.is-queued { background: var(--amber-soft); border-color: #fed7aa; }
        .pos-receipt-title { font-size: 14px; font-weight: 650; }
        .pos-receipt.is-done .pos-receipt-title { color: #15803d; }
        .pos-receipt.is-queued .pos-receipt-title { color: #b45309; }
        .pos-receipt-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }

        @media (max-width: 900px) {
          .pos-grid { grid-template-columns: 1fr; }
          .pos-cart { position: static; }
        }
      `}</style>
    </div>
  )
}
