'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import BarcodeScanner from '@/components/BarcodeScanner'
import { cameraScanSupported, validateBarcode } from '@/lib/barcode'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { GST_RATES } from '@/lib/gst-rates'

const UNITS = ['NOS', 'KGS', 'MTR', 'LTR', 'SQF', 'HRS', 'DYS', 'PCS', 'BOX', 'PKT', 'SET', 'PAI']

const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (v: number | string | null | undefined) => `₹${whole.format(Number(v ?? 0) || 0)}`

type Product = {
  id: string
  name: string
  description: string | null
  type: string
  sku: string | null
  hsn_sac: string | null
  unit: string
  purchase_price: number | string
  selling_price: number | string
  gst_rate: number | string
  cess_rate: number | string
  is_active: boolean
  track_inventory: boolean
  current_stock: number | string
  opening_stock: number | string
  minimum_stock: number | string
}

const emptyForm = () => ({
  name: '', description: '', sku: '',
  type: 'goods', hsn_sac: '', unit: 'NOS',
  purchase_price: '', selling_price: '',
  gst_rate: '18', cess_rate: '0',
  track_inventory: false,
  opening_stock: '0', minimum_stock: '0',
})

const VIEWS = [
  { value: 'all', label: 'All', noun: 'matching' },
  { value: 'goods', label: 'Goods', noun: 'goods' },
  { value: 'service', label: 'Services', noun: 'service' },
]

/** An item only runs short once it is being tracked and has an alert level. */
const isLow = (p: Product) =>
  p.track_inventory && Number(p.minimum_stock) > 0 && Number(p.current_stock) <= Number(p.minimum_stock)

function ProductsPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [products, setProducts] = useState<Product[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [scanSku, setScanSku] = useState(false)

  const [form, setForm] = useState(emptyForm())

  async function fetchProducts(oid: string) {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    if (error) setLoadError(error.message)
    setProducts((data as Product[]) || [])
  }

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
      await fetchProducts(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setForm(emptyForm())
    setEditingId(null)
    setError('')
    setScanSku(false)
  }

  function handleEdit(product: Product) {
    setForm({
      name: product.name || '',
      description: product.description || '',
      sku: product.sku || '',
      type: product.type || 'goods',
      hsn_sac: product.hsn_sac || '',
      unit: product.unit || 'NOS',
      purchase_price: String(product.purchase_price ?? ''),
      selling_price: String(product.selling_price ?? ''),
      gst_rate: String(product.gst_rate || 18),
      cess_rate: String(product.cess_rate || 0),
      track_inventory: product.track_inventory || false,
      opening_stock: String(product.opening_stock ?? 0),
      minimum_stock: String(product.minimum_stock ?? 0),
    })
    setEditingId(product.id)
    setShowForm(true)
    setScanSku(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const payload = {
      organization_id: orgId,
      name: form.name,
      description: form.description,
      sku: form.sku,
      type: form.type,
      hsn_sac: form.hsn_sac,
      unit: form.unit,
      purchase_price: parseFloat(form.purchase_price) || 0,
      selling_price: parseFloat(form.selling_price) || 0,
      gst_rate: parseFloat(form.gst_rate) || 0,
      cess_rate: parseFloat(form.cess_rate) || 0,
      track_inventory: form.track_inventory,
      opening_stock: parseFloat(form.opening_stock) || 0,
      minimum_stock: parseFloat(form.minimum_stock) || 0,
    }

    // current_stock only gets seeded on creation. Every later change comes from
    // a stock movement (sale, purchase, adjustment), so writing the opening
    // balance back here would erase all of them on an unrelated edit.
    let err
    if (editingId) {
      const { error } = await supabase.from('products').update(payload).eq('id', editingId)
      err = error
    } else {
      const { error } = await supabase
        .from('products')
        .insert({ ...payload, current_stock: payload.opening_stock })
      err = error
    }

    if (err) { setError(err.message) }
    else {
      await fetchProducts(orgId)
      setShowForm(false)
      resetForm()
    }
    setSaving(false)
  }

  const summary = useMemo(() => {
    const visible = products.filter(p => {
      if (view !== 'all' && p.type !== view) return false
      return matchesAny(search, [p.name, p.sku, p.hsn_sac, p.description])
    })
    return {
      visible,
      goods: products.filter(p => p.type === 'goods').length,
      services: products.filter(p => p.type === 'service').length,
      noHsn: products.filter(p => !p.hsn_sac?.trim()).length,
      low: products.filter(isLow).length,
    }
  }, [products, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your catalogue…</div>
  }

  return (
    <div className="page-container pr" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Sales"
        title="Products & services"
        subtitle="The catalogue every invoice line is drawn from — HSN or SAC, unit and rate are decided once here instead of per bill."
        actions={<Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add item</Button>}
      />

      {loadError && (
        <div className="pr-alert"><Icon name="alert" size={14} />{loadError}</div>
      )}

      <div className="pr-stats">
        <StatCard label="Items" value={String(products.length)}
          sub={`${summary.visible.length} shown`} icon="store" tone="blue" />
        <StatCard label="Goods" value={String(summary.goods)} sub="carry an HSN code" icon="box" tone="violet" delay={40} />
        <StatCard label="Services" value={String(summary.services)} sub="carry a SAC code" icon="zap" tone="cyan" delay={80} />
        <StatCard label="No HSN / SAC" value={String(summary.noHsn)}
          sub={summary.noHsn ? 'GSTR-1 needs a code on every line' : 'every line item is coded'}
          icon="alert" tone={summary.noHsn ? 'amber' : 'grey'} delay={120} />
      </div>

      <div className="pr-toolbar">
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Name, SKU or HSN…"
          ariaLabel="Search products"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {summary.visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={products.length ? 'search' : 'box'}
            title={products.length
              ? (search ? `Nothing matches “${search}”` : `No ${VIEWS.find(x => x.value === view)?.noun} items`)
              : 'No products yet'}
            message={products.length
              ? 'Try a different name, SKU or HSN, or switch the type filter back to All.'
              : 'Add the goods and services you sell — each one carries its own HSN/SAC, rate and stock rules.'}
            action={!products.length ? (
              <Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add item</Button>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header pr-row pr-head">
              <span data-label="Name">Item</span>
              <span data-label="Code">HSN / SAC</span>
              <span className="pr-right" data-label="Price">Selling price</span>
              <span className="pr-right" data-label="GST">GST</span>
              <span data-label="Stock">Stock</span>
              <span className="pr-right" data-label="Actions">Actions</span>
            </div>
            {summary.visible.map((product) => (
              <div key={product.id} className="table-row pr-row">
                <span data-label="Name" className="pr-name">
                  <span className="pr-name-main">{product.name}</span>
                  <span className="pr-sub">
                    {product.unit}
                    {product.sku ? ` · ${product.sku}` : ''}
                    {Number(product.purchase_price) > 0 && Number(product.selling_price) > 0
                      ? ` · cost ${money(Number(product.purchase_price))}` : ''}
                  </span>
                </span>

                <span data-label="Code" className={product.hsn_sac ? 'pr-mono' : 'pr-sub'}>
                  {product.hsn_sac || 'Not set'}
                </span>

                <span className="pr-right" data-label="Price">
                  <span className="tf-num pr-price">{money(product.selling_price)}</span>
                  {Number(product.cess_rate) > 0 && <div className="pr-sub">+ {Number(product.cess_rate)}% cess</div>}
                </span>

                <span className="pr-right" data-label="GST">
                  <Badge tone={Number(product.gst_rate) === 0 ? 'grey' : 'blue'} dot={false}>
                    {Number(product.gst_rate)}%
                  </Badge>
                </span>

                <span data-label="Stock">
                  {product.track_inventory ? (
                    <>
                      <span className="tf-num pr-stock">{whole.format(Number(product.current_stock) || 0)}</span>
                      {' '}{isLow(product)
                        ? <Badge tone="red" dot={false}>Below minimum</Badge>
                        : <span className="pr-sub">{Number(product.minimum_stock) > 0 ? `of ${Number(product.minimum_stock)} alert` : 'in stock'}</span>}
                    </>
                  ) : <span className="pr-sub">Not tracked</span>}
                </span>

                <span className="pr-right pr-actions" data-label="Actions">
                  <Button size="sm" variant="subtle" onClick={() => handleEdit(product)}>Edit</Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {products.length > 0 && (
        <div className="pr-foot">
          <span>Shown: {summary.visible.length} of {products.length}{summary.low ? ` · ${summary.low} below minimum` : ''}</span>
          <span>Changing a price here does not change invoices already raised — the line keeps its own snapshot.</span>
        </div>
      )}

      {showForm && (
        <div className="pr-scrim" role="dialog" aria-modal="true" aria-label={editingId ? 'Edit item' : 'Add item'}>
          <div className="pr-modal">
            <div className="pr-modal-head">
              <h2>{editingId ? 'Edit item' : 'Add product or service'}</h2>
              <button type="button" className="pr-close" onClick={() => { setShowForm(false); resetForm() }} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="pr-form">
              <Segmented
                options={[{ value: 'goods', label: 'Goods' }, { value: 'service', label: 'Service' }]}
                value={form.type}
                onChange={t => setForm(p => ({ ...p, type: t }))}
              />

              <div className="pr-grid-wide">
                <label className="pr-field">
                  <span>Name *</span>
                  <input className="tf-input" value={form.name} placeholder="Product or service name" required
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </label>
                <label className="pr-field">
                  <span>SKU / barcode</span>
                  <div className="pr-sku">
                    <input className="tf-input" value={form.sku} placeholder="Barcode or internal code"
                      onChange={e => setForm(p => ({ ...p, sku: e.target.value }))} />
                    {cameraScanSupported() && (
                      <Button variant={scanSku ? 'primary' : 'ghost'} size="sm" icon="scan"
                        onClick={() => setScanSku(v => !v)}>
                        {scanSku ? 'Stop' : 'Scan'}
                      </Button>
                    )}
                  </div>
                  {scanSku && (
                    <BarcodeScanner
                      label="Scan the product barcode to fill this field"
                      onScan={code => { setForm(p => ({ ...p, sku: code })); setScanSku(false) }}
                      onClose={() => setScanSku(false)}
                    />
                  )}
                  {(() => {
                    // Short values are clearly internal codes, so only validate real barcode-shaped input
                    if (form.sku.length < 6) return null
                    const check = validateBarcode(form.sku)
                    if (check.valid) return null
                    return (
                      <span className="pr-sku-error">
                        {check.message} — counter scanning will reject this code.
                      </span>
                    )
                  })()}
                </label>
              </div>

              <div className="pr-grid">
                <label className="pr-field">
                  <span>{form.type === 'goods' ? 'HSN code' : 'SAC code'}</span>
                  <input className="tf-input pr-mono-input" value={form.hsn_sac}
                    placeholder={form.type === 'goods' ? '1234' : '998314'}
                    onChange={e => setForm(p => ({ ...p, hsn_sac: e.target.value }))} />
                </label>
                <label className="pr-field">
                  <span>Unit of measurement</span>
                  <select className="tf-input" value={form.unit}
                    onChange={e => setForm(p => ({ ...p, unit: e.target.value }))}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </label>
              </div>

              <div className="pr-grid-3">
                <label className="pr-field">
                  <span>Purchase price (₹)</span>
                  <input className="tf-input" type="number" value={form.purchase_price} placeholder="0.00" min="0" step="0.01"
                    onChange={e => setForm(p => ({ ...p, purchase_price: e.target.value }))} />
                </label>
                <label className="pr-field">
                  <span>Selling price (₹) *</span>
                  <input className="tf-input" type="number" value={form.selling_price} placeholder="0.00" min="0" step="0.01" required
                    onChange={e => setForm(p => ({ ...p, selling_price: e.target.value }))} />
                </label>
                <label className="pr-field">
                  <span>GST rate *</span>
                  <select className="tf-input" value={form.gst_rate}
                    onChange={e => setForm(p => ({ ...p, gst_rate: e.target.value }))}>
                    {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                </label>
              </div>

              {form.type === 'goods' && (
                <div className="pr-stock-box">
                  <label className="pr-check">
                    <input type="checkbox" checked={form.track_inventory}
                      onChange={e => setForm(p => ({ ...p, track_inventory: e.target.checked }))} />
                    <span>Track inventory for this product</span>
                  </label>
                  {form.track_inventory && (
                    <div className="pr-grid">
                      <label className="pr-field">
                        <span>Opening stock</span>
                        <input className="tf-input" type="number" value={form.opening_stock} min="0"
                          onChange={e => setForm(p => ({ ...p, opening_stock: e.target.value }))} />
                      </label>
                      <label className="pr-field">
                        <span>Minimum stock alert</span>
                        <input className="tf-input" type="number" value={form.minimum_stock} min="0"
                          onChange={e => setForm(p => ({ ...p, minimum_stock: e.target.value }))} />
                      </label>
                    </div>
                  )}
                </div>
              )}

              <label className="pr-field">
                <span>Description</span>
                <textarea className="tf-input pr-textarea" value={form.description} placeholder="Optional description"
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
              </label>

              {!form.hsn_sac.trim() && (
                <div className="pr-note">
                  <Icon name="alert" size={14} />
                  <span>{form.type === 'goods' ? 'HSN' : 'SAC'} decides the tax rate on this line and appears in GSTR-1 — leave it blank and the filed table will show it as missing.</span>
                </div>
              )}

              {error && <div className="pr-alert"><Icon name="alert" size={14} />{error}</div>}

              <div className="pr-save">
                <Button variant="ghost" onClick={() => { setShowForm(false); resetForm() }}>Cancel</Button>
                <Button type="submit" disabled={saving} icon={saving ? undefined : 'check'}>
                  {saving ? 'Saving…' : editingId ? 'Update item' : 'Add item'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .pr-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .pr-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 10px; background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red); }
        .pr-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .pr-row { display: grid; grid-template-columns: minmax(0, 1.5fr) 104px minmax(0, 1fr) 66px minmax(0, 1fr) 88px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .pr-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .pr-right { text-align: right; }
        .pr-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .pr-name-main { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .pr-sub { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .pr-mono { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); }
        .pr-price { font-weight: 650; color: var(--ink); }
        .pr-stock { font-weight: 650; color: var(--ink); }
        .pr-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

        .pr-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .pr-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .pr-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 660px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .pr-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .pr-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .pr-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .pr-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .pr-form { display: flex; flex-direction: column; gap: 12px; }
        .pr-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .pr-grid-3 { display: grid; grid-template-columns: 1fr 1fr 0.8fr; gap: 12px; }
        .pr-grid-wide { display: grid; grid-template-columns: 1.6fr 1fr; gap: 12px; }
        .pr-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .pr-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .pr-textarea { min-height: 60px; resize: vertical; }
        .pr-mono-input { font-family: var(--mono); letter-spacing: 0.03em; }
        .pr-sku { display: flex; gap: 6px; align-items: flex-start; }
        .pr-sku-error { font-size: 11px; color: var(--red); }
        .pr-stock-box { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          padding: 12px; display: flex; flex-direction: column; gap: 12px; }
        .pr-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 550;
          color: var(--ink-2); cursor: pointer; }
        .pr-check input { accent-color: var(--brand); }
        .pr-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--ink-2);
          background: var(--amber-soft); border-radius: var(--radius-sm); padding: 10px 12px; }
        .pr-note svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }
        .pr-save { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }

        @media (max-width: 1100px) { .pr-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .pr-row { grid-template-columns: 1fr; gap: 6px; }
          .pr-head { display: none; }
          .pr-right { text-align: left; }
          .pr-actions { justify-content: flex-start; }
          .pr-stats { grid-template-columns: 1fr 1fr; }
          .pr-grid, .pr-grid-3, .pr-grid-wide { grid-template-columns: 1fr; }
          .pr-modal { padding: 1.1rem 1.15rem; }
          .pr-scrim { align-items: flex-end; padding: 0; }
          .pr-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .pr-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <ProductsPageInner />
    </Suspense>
  )
}
