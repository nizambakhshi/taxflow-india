'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard, type Tone } from '@/components/ui'
import Icon from '@/components/Icons'
import { plural } from '@/lib/format'

type Product = {
  id: string
  name: string
  sku: string
  hsn_sac: string
  unit: string
  current_stock: number
  minimum_stock: number
  selling_price: number
  track_inventory: boolean
  last_stock_update: string
}

type Movement = {
  id: string
  movement_type: string
  quantity: number
  balance_after: number
  reference_type: string
  reference_number: string
  notes: string
  created_at: string
}

const MOVEMENT_CONFIG: Record<string, { label: string; tone: Tone }> = {
  opening: { label: 'Opening', tone: 'blue' },
  purchase: { label: 'Purchase', tone: 'green' },
  sale: { label: 'Sale', tone: 'red' },
  adjustment_in: { label: 'Adj in', tone: 'green' },
  adjustment_out: { label: 'Adj out', tone: 'red' },
  sale_return: { label: 'Return', tone: 'green' },
  purchase_return: { label: 'Return', tone: 'red' },
}

const TAB_OPTIONS = [
  { value: 'stock', label: 'Stock levels' },
  { value: 'movements', label: 'Stock movements' },
]

export default function InventoryPage() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [userId, setUserId] = useState('')
  const [loading, setLoading] = useState(true)
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [activeTab, setActiveTab] = useState<'stock' | 'movements'>('stock')

  // Adjustment form
  const [showAdjustForm, setShowAdjustForm] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [adjustType, setAdjustType] = useState<'in' | 'out'>('in')
  const [adjustQty, setAdjustQty] = useState('')
  const [adjustNotes, setAdjustNotes] = useState('')
  const [adjusting, setAdjusting] = useState(false)
  const [adjustError, setAdjustError] = useState('')

  // Movements
  const [movements, setMovements] = useState<any[]>([])
  const [movementProduct, setMovementProduct] = useState('all')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUserId(user.id)

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)

      await loadProducts(membership.organization_id)
      await loadMovements(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function loadProducts(oid: string) {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('organization_id', oid)
      .eq('track_inventory', true)
      .eq('is_active', true)
      .order('name')

    setProducts(data || [])
  }

  async function loadMovements(oid: string) {
    const { data } = await supabase
      .from('stock_movements')
      .select('*, products(name, unit)')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
      .limit(100)

    setMovements(data || [])
  }

  async function handleAdjustment() {
    if (!selectedProduct) return
    const qty = parseFloat(adjustQty)
    if (!qty || qty <= 0) {
      setAdjustError('Please enter a valid quantity')
      return
    }
    if (adjustType === 'out' && qty > selectedProduct.current_stock) {
      setAdjustError(`Cannot remove more than current stock (${selectedProduct.current_stock} ${selectedProduct.unit})`)
      return
    }

    setAdjusting(true)
    setAdjustError('')

    try {
      const finalQty = adjustType === 'in' ? qty : -qty
      const movementType = adjustType === 'in' ? 'adjustment_in' : 'adjustment_out'

      await supabase.rpc('record_stock_movement', {
        p_organization_id: orgId,
        p_product_id: selectedProduct.id,
        p_movement_type: movementType,
        p_quantity: finalQty,
        p_reference_type: 'manual',
        p_reference_id: null,
        p_reference_number: null,
        p_notes: adjustNotes || `Manual ${adjustType === 'in' ? 'stock addition' : 'stock removal'}`,
        p_created_by: userId,
      })

      await loadProducts(orgId)
      await loadMovements(orgId)
      setShowAdjustForm(false)
      setSelectedProduct(null)
      setAdjustQty('')
      setAdjustNotes('')
    } catch (err: any) {
      setAdjustError(err.message || 'Failed to adjust stock')
    } finally {
      setAdjusting(false)
    }
  }

  async function handleSetOpeningStock(product: Product) {
    setSelectedProduct(product)
    setAdjustType('in')
    setAdjustQty(String(product.current_stock || ''))
    setAdjustNotes('Opening stock entry')
    setShowAdjustForm(true)
  }

  const filtered = products
    .filter(p => {
      if (filter === 'low') return p.current_stock <= p.minimum_stock
      if (filter === 'out') return p.current_stock <= 0
      return true
    })
    .filter(p =>
      p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.sku?.toLowerCase().includes(search.toLowerCase()) ||
      p.hsn_sac?.toLowerCase().includes(search.toLowerCase())
    )

  const lowStockCount = products.filter(p => p.current_stock <= p.minimum_stock && p.current_stock > 0).length
  const outOfStockCount = products.filter(p => p.current_stock <= 0).length
  const totalStockValue = products.reduce((s, p) => s + (p.current_stock * p.selling_price), 0)

  const filteredMovements = movements.filter(m =>
    movementProduct === 'all' || m.product_id === movementProduct
  )

  const filterOptions = [
    { value: 'all', label: `All (${products.length})` },
    { value: 'low', label: `Low (${lowStockCount})` },
    { value: 'out', label: `Out (${outOfStockCount})` },
  ]

  if (loading) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the stock ledger…</div>
  )

  return (
    <div className="page-container inv" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Masters"
        title="Inventory"
        subtitle={`${plural(products.length, 'tracked product')} — stock moves only through recorded movements, never by editing a product.`}
        actions={<Button variant="ghost" icon="settings" href="/products">Manage products</Button>}
      />

      {/* Summary cards */}
      <div className="inv-stats">
        <StatCard label="Products tracked" value={String(products.length)}
          sub="goods with stock counting on" icon="box" tone="blue" />
        <StatCard label="Stock value" value={totalStockValue}
          sub="at selling price" icon="scale" tone="green" delay={40} />
        <StatCard label="Low stock" value={String(lowStockCount)}
          sub={lowStockCount ? 'at or below the minimum' : 'every item above its minimum'}
          icon="alert" tone={lowStockCount > 0 ? 'amber' : 'green'} delay={80} />
        <StatCard label="Out of stock" value={String(outOfStockCount)}
          sub={outOfStockCount ? 'zero or below — reorder now' : 'nothing has run out'}
          icon="cart" tone={outOfStockCount > 0 ? 'red' : 'green'} delay={120} />
      </div>

      {/* Tabs */}
      <div style={{ marginBottom: '1rem' }}>
        <Segmented
          options={TAB_OPTIONS.map(t => t.value === 'movements' ? { ...t, label: `${t.label} (${movements.length})` } : t)}
          value={activeTab}
          onChange={v => setActiveTab(v as 'stock' | 'movements')}
        />
      </div>

      {/* STOCK LEVELS TAB */}
      {activeTab === 'stock' && (
        <>
          {/* Filters */}
          <div className="inv-toolbar">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Name, SKU or HSN…"
              ariaLabel="Search stock"
              style={{ flex: '1 1 240px', maxWidth: 300 }}
            />
            <div style={{ marginLeft: 'auto' }}>
              <Segmented options={filterOptions} value={filter} onChange={setFilter} />
            </div>
          </div>

          {products.length === 0 ? (
            <Card>
              <EmptyState
                icon="box"
                title="No products with inventory tracking"
                message="Go to Products and switch on “Track inventory” for the goods you want counted — every invoice and purchase then moves the stock for you."
                action={<Button size="sm" icon="plus" href="/products">Go to products</Button>}
              />
            </Card>
          ) : filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon="search"
                title="No products match this filter"
                message="Clear the search or switch the filter back to All."
              />
            </Card>
          ) : (
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header inv-row inv-head">
                  <span>Product</span>
                  <span>Unit</span>
                  <span className="inv-right">Current stock</span>
                  <span className="inv-right">Min stock</span>
                  <span className="inv-right">Stock value</span>
                  <span>Status</span>
                  <span>Actions</span>
                </div>

                {filtered.map(product => {
                  const isLow = product.current_stock <= product.minimum_stock
                    && product.current_stock > 0
                  const isOut = product.current_stock <= 0
                  const stockValue = product.current_stock * product.selling_price

                  return (
                    <div key={product.id} className={`table-row inv-row ${isOut ? 'is-out' : isLow ? 'is-low' : ''}`}>
                      <div data-label="Product" className="inv-name">
                        <span className="inv-name-main">{product.name}</span>
                        {product.sku && <span className="inv-sub">SKU: {product.sku}</span>}
                        {product.hsn_sac && <span className="inv-sub">HSN: {product.hsn_sac}</span>}
                      </div>
                      <div data-label="Unit" className="inv-sub" style={{ fontSize: 12.5 }}>{product.unit}</div>
                      <div data-label="Current stock" className="inv-right">
                        <span className="inv-cur tf-num" style={{ color: isOut ? 'var(--red)' : isLow ? 'var(--amber)' : 'var(--green)' }}>
                          {Number(product.current_stock).toFixed(2)}
                        </span>
                      </div>
                      <div data-label="Min stock" className="inv-right">
                        <span className="tf-num" style={{ color: 'var(--muted)' }}>{Number(product.minimum_stock).toFixed(2)}</span>
                      </div>
                      <div data-label="Stock value" className="inv-right">
                        <span className="tf-num" style={{ fontWeight: 550, color: 'var(--ink-2)' }}>₹{formatINR(stockValue)}</span>
                      </div>
                      <div data-label="Status">
                        {isOut ? (
                          <Badge tone="red">Out of stock</Badge>
                        ) : isLow ? (
                          <Badge tone="amber">Low stock</Badge>
                        ) : (
                          <Badge tone="green">In stock</Badge>
                        )}
                      </div>
                      <div data-label="Actions" className="inv-actions">
                        <Button size="sm" variant="subtle" onClick={() => {
                          setSelectedProduct(product)
                          setAdjustType('in')
                          setAdjustQty('')
                          setAdjustNotes('')
                          setAdjustError('')
                          setShowAdjustForm(true)
                        }}>+ Add</Button>
                        <Button size="sm" variant="danger" onClick={() => {
                          setSelectedProduct(product)
                          setAdjustType('out')
                          setAdjustQty('')
                          setAdjustNotes('')
                          setAdjustError('')
                          setShowAdjustForm(true)
                        }}>− Remove</Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* MOVEMENTS TAB */}
      {activeTab === 'movements' && (
        <>
          <div className="inv-toolbar">
            <select
              className="tf-input"
              style={{ maxWidth: 300, cursor: 'pointer' }}
              value={movementProduct}
              onChange={e => setMovementProduct(e.target.value)}
              aria-label="Filter movements by product"
            >
              <option value="all">All products</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {filteredMovements.length === 0 ? (
            <Card>
              <EmptyState
                icon="clipboard"
                title="No stock movements yet"
                message="Every invoice, purchase and manual adjustment lands here as a dated movement with the balance it left behind."
              />
            </Card>
          ) : (
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header inv-row2 inv-head">
                  <span>Date</span>
                  <span>Product</span>
                  <span>Type</span>
                  <span className="inv-right">Qty change</span>
                  <span className="inv-right">Balance</span>
                  <span>Reference</span>
                </div>

                {filteredMovements.map(m => {
                  const mc = MOVEMENT_CONFIG[m.movement_type] || { label: m.movement_type, tone: 'grey' as Tone }
                  const product = m.products as any
                  return (
                    <div key={m.id} className="table-row inv-row2">
                      <div data-label="Date" className="inv-sub" style={{ fontSize: 12.5 }}>
                        {new Date(m.created_at).toLocaleDateString('en-IN', {
                          day: '2-digit', month: 'short', year: 'numeric'
                        })}
                        <div>{new Date(m.created_at).toLocaleTimeString('en-IN', {
                          hour: '2-digit', minute: '2-digit'
                        })}</div>
                      </div>
                      <div data-label="Product" className="inv-name">
                        <span className="inv-name-main">{product?.name || '—'}</span>
                        {product?.unit && <span className="inv-sub">{product.unit}</span>}
                      </div>
                      <div data-label="Type">
                        <Badge tone={mc.tone}>{mc.label}</Badge>
                      </div>
                      <div data-label="Qty change" className="inv-right">
                        <span className="tf-num inv-qty" style={{ color: Number(m.quantity) > 0 ? 'var(--green)' : 'var(--red)' }}>
                          {Number(m.quantity) > 0 ? '+' : ''}{Number(m.quantity).toFixed(2)}
                        </span>
                      </div>
                      <div data-label="Balance" className="inv-right">
                        <span className="tf-num" style={{ fontWeight: 550, color: 'var(--ink-2)' }}>
                          {Number(m.balance_after).toFixed(2)}
                        </span>
                      </div>
                      <div data-label="Reference" className="inv-sub" style={{ fontSize: 12.5 }}>
                        {m.reference_number || m.notes || '—'}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}

      {/* Adjustment Modal */}
      {showAdjustForm && selectedProduct && (
        <div className="inv-scrim">
          <div className="inv-modal">
            <div className="inv-modal-head">
              <h2>Stock adjustment</h2>
              <button className="inv-close" aria-label="Close" onClick={() => { setShowAdjustForm(false); setSelectedProduct(null) }}>
                <Icon name="x" size={16} />
              </button>
            </div>

            {/* Product info */}
            <div className="inv-info">
              <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                {selectedProduct.name}
              </div>
              <div className="inv-sub" style={{ fontSize: 13 }}>
                Current stock:{' '}
                <strong style={{ color: 'var(--ink)' }}>
                  {Number(selectedProduct.current_stock).toFixed(2)} {selectedProduct.unit}
                </strong>
              </div>
            </div>

            {/* Type toggle */}
            <div style={{ marginBottom: '1rem' }}>
              <Segmented
                options={[
                  { value: 'in', label: '+ Add stock' },
                  { value: 'out', label: '− Remove stock' },
                ]}
                value={adjustType}
                onChange={v => setAdjustType(v as 'in' | 'out')}
              />
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label className="inv-label" htmlFor="inv-qty">
                Quantity ({selectedProduct.unit}) *
              </label>
              <input
                id="inv-qty"
                className="tf-input"
                type="number"
                value={adjustQty}
                onChange={e => setAdjustQty(e.target.value)}
                placeholder="0"
                min="0"
                step="0.001"
                autoFocus
              />
              {adjustType === 'out' && (
                <div className="inv-hint">
                  Max: {Number(selectedProduct.current_stock).toFixed(2)} {selectedProduct.unit}
                </div>
              )}
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label className="inv-label" htmlFor="inv-notes">Reason / notes</label>
              <input
                id="inv-notes"
                className="tf-input"
                value={adjustNotes}
                onChange={e => setAdjustNotes(e.target.value)}
                placeholder="e.g. Stock count correction, damaged goods…"
              />
            </div>

            {/* Preview */}
            {adjustQty && parseFloat(adjustQty) > 0 && (
              <div className={`inv-preview ${adjustType === 'in' ? 'is-in' : 'is-out'}`}>
                Stock will change from{' '}
                <strong>{Number(selectedProduct.current_stock).toFixed(2)}</strong>
                {' → '}
                <strong>
                  {(Number(selectedProduct.current_stock) +
                    (adjustType === 'in' ? 1 : -1) * parseFloat(adjustQty)).toFixed(2)}
                </strong>
                {' '}{selectedProduct.unit}
              </div>
            )}

            {adjustError && (
              <div className="inv-preview is-out">{adjustError}</div>
            )}

            <div className="inv-save">
              <Button
                variant={adjustType === 'in' ? 'primary' : 'danger'}
                disabled={adjusting}
                onClick={handleAdjustment}
                style={{ flex: 1 }}
              >
                {adjusting ? 'Saving…' : adjustType === 'in' ? 'Add stock' : 'Remove stock'}
              </Button>
              <Button
                variant="ghost"
                onClick={() => { setShowAdjustForm(false); setSelectedProduct(null) }}
              >Cancel</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .inv-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .inv-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .inv-row { display: grid; grid-template-columns: minmax(0, 2.5fr) 70px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) 118px 170px;
          gap: 12px; align-items: center; padding: 11px 16px; font-size: 12.5px; }
        .inv-row2 { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 2fr) 92px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.5fr);
          gap: 12px; align-items: center; padding: 11px 16px; font-size: 12.5px; }
        .inv-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .inv-right { text-align: right; }
        .inv-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .inv-name-main { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .inv-sub { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .inv-cur { font-weight: 700; font-size: 14px; }
        .inv-qty { font-weight: 650; font-size: 13.5px; }
        .inv-actions { display: flex; gap: 6px; flex-wrap: wrap; }
        .inv-row.is-out { background: var(--red-soft); }
        .inv-row.is-low { background: var(--amber-soft); }

        .inv-label { display: block; font-size: 12px; font-weight: 550; color: var(--ink-2); margin-bottom: 4px; }
        .inv-hint { font-size: 11px; color: var(--faint); margin-top: 4px; }

        .inv-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .inv-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 460px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .inv-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.25rem; }
        .inv-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .inv-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .inv-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .inv-info { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          padding: 12px 14px; margin-bottom: 1.25rem; }

        .inv-preview { border-radius: var(--radius-sm); padding: 10px 14px; margin-bottom: 1rem; font-size: 13px; }
        .inv-preview.is-in { background: var(--green-soft); border: 1px solid #bbf7d0; color: #15803d; }
        .inv-preview.is-out { background: var(--red-soft); border: 1px solid #fecaca; color: #b91c1c; }

        .inv-save { display: flex; gap: 10px; }

        @media (max-width: 1100px) { .inv-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .inv-stats { grid-template-columns: 1fr 1fr; }
          .inv-right { text-align: left; }
          .inv-actions { justify-content: flex-start; }
          .inv-scrim { align-items: flex-end; padding: 0; }
          .inv-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .inv-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}
