'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'

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

  const movementConfig: Record<string, { label: string; color: string; bg: string }> = {
    opening: { label: 'Opening', color: '#1d4ed8', bg: '#eff6ff' },
    purchase: { label: 'Purchase', color: '#059669', bg: '#f0fdf4' },
    sale: { label: 'Sale', color: '#dc2626', bg: '#fef2f2' },
    adjustment_in: { label: 'Adj In', color: '#059669', bg: '#f0fdf4' },
    adjustment_out: { label: 'Adj Out', color: '#dc2626', bg: '#fef2f2' },
    sale_return: { label: 'Return', color: '#059669', bg: '#f0fdf4' },
    purchase_return: { label: 'Return', color: '#dc2626', bg: '#fef2f2' },
  }

  const filteredMovements = movements.filter(m =>
    movementProduct === 'all' || m.product_id === movementProduct
  )

  const tabStyle = (key: string) => ({
    padding: '8px 20px', background: 'none', border: 'none',
    cursor: 'pointer' as const, fontSize: '13px',
    fontWeight: activeTab === key ? '600' : '400',
    color: activeTab === key ? '#2563eb' : '#64748b',
    borderBottom: activeTab === key ? '2px solid #2563eb' : '2px solid transparent',
    marginBottom: '-1px'
  })

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Inventory
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {products.length} tracked product{products.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => router.push('/products')}
          style={{
            padding: '9px 18px', background: '#f1f5f9',
            color: '#374151', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '13px', cursor: 'pointer'
          }}
        >
          ⚙️ Manage Products
        </button>
      </div>

      {/* Summary cards */}
      <div className="metric-grid" style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '1rem', marginBottom: '1.5rem'
      }}>
        {[
          {
            label: 'Total Products Tracked',
            value: products.length, isCount: true, color: '#2563eb'
          },
          {
            label: 'Stock Value (Selling Price)',
            value: totalStockValue, color: '#059669'
          },
          {
            label: 'Low Stock Items',
            value: lowStockCount, isCount: true,
            color: lowStockCount > 0 ? '#d97706' : '#059669'
          },
          {
            label: 'Out of Stock',
            value: outOfStockCount, isCount: true,
            color: outOfStockCount > 0 ? '#dc2626' : '#059669'
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
            <div style={{ fontSize: '20px', fontWeight: '600', color: card.color }}>
              {card.isCount ? card.value : `₹${formatINR(card.value as number)}`}
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="tab-bar" style={{ borderBottom: '1px solid #e2e8f0', marginBottom: '1rem', display: 'flex' }}>
        <button style={tabStyle('stock')} onClick={() => setActiveTab('stock')}>
          📦 Stock Levels
        </button>
        <button style={tabStyle('movements')} onClick={() => setActiveTab('movements')}>
          📋 Stock Movements ({movements.length})
        </button>
      </div>

      {/* STOCK LEVELS TAB */}
      {activeTab === 'stock' && (
        <>
          {/* Filters */}
          <div className="toolbar" style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
            <input
              style={{ ...inputStyle, maxWidth: '280px' }}
              placeholder="Search products..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {[
              { key: 'all', label: `All (${products.length})` },
              { key: 'low', label: `Low Stock (${lowStockCount})` },
              { key: 'out', label: `Out of Stock (${outOfStockCount})` },
            ].map(f => (
              <button key={f.key} onClick={() => setFilter(f.key)} style={{
                padding: '8px 14px',
                background: filter === f.key ? '#2563eb' : 'white',
                color: filter === f.key ? 'white' : '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px',
                fontSize: '12px', cursor: 'pointer', fontWeight: '500'
              }}>
                {f.label}
              </button>
            ))}
          </div>

          {products.length === 0 ? (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '3rem',
              textAlign: 'center', color: '#94a3b8'
            }}>
              <div style={{ fontSize: '36px', marginBottom: '1rem' }}>📦</div>
              <div style={{ fontSize: '16px', fontWeight: '500', color: '#64748b', marginBottom: '8px' }}>
                No products with inventory tracking
              </div>
              <div style={{ fontSize: '13px', marginBottom: '1.5rem' }}>
                Go to Products and enable "Track inventory" on goods you want to track
              </div>
              <button
                onClick={() => router.push('/products')}
                style={{
                  padding: '10px 20px', background: '#2563eb',
                  color: 'white', border: 'none', borderRadius: '8px',
                  fontSize: '13px', cursor: 'pointer', fontWeight: '600'
                }}
              >
                Go to Products →
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '2rem',
              textAlign: 'center', color: '#94a3b8', fontSize: '14px'
            }}>
              No products match your filter
            </div>
          ) : (
            <div className="responsive-table table-frame" style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 1fr 120px',
                gap: '12px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '12px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Product</span>
                <span>Unit</span>
                <span>Current Stock</span>
                <span>Min Stock</span>
                <span>Stock Value</span>
                <span>Status</span>
                <span>Actions</span>
              </div>

              {filtered.map(product => {
                const isLow = product.current_stock <= product.minimum_stock
                  && product.current_stock > 0
                const isOut = product.current_stock <= 0
                const stockValue = product.current_stock * product.selling_price

                return (
                  <div key={product.id} className="table-row" style={{
                    display: 'grid',
                    gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 1fr 120px',
                    gap: '12px', padding: '12px 16px',
                    borderBottom: '1px solid #f1f5f9',
                    alignItems: 'center', fontSize: '13px',
                    background: isOut ? '#fff5f5' : isLow ? '#fffbeb' : 'white'
                  }}>
                    <div data-label="Product">
                      <div style={{ fontWeight: '500', color: '#1e293b' }}>
                        {product.name}
                      </div>
                      {product.sku && (
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                          SKU: {product.sku}
                        </div>
                      )}
                      {product.hsn_sac && (
                        <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                          HSN: {product.hsn_sac}
                        </div>
                      )}
                    </div>
                    <div data-label="Unit" style={{ color: '#64748b' }}>{product.unit}</div>
                    <div data-label="Current Stock" style={{
                      fontWeight: '700', fontSize: '15px',
                      color: isOut ? '#dc2626' : isLow ? '#d97706' : '#059669'
                    }}>
                      {Number(product.current_stock).toFixed(2)}
                    </div>
                    <div data-label="Min Stock" style={{ color: '#64748b' }}>
                      {Number(product.minimum_stock).toFixed(2)}
                    </div>
                    <div data-label="Stock Value" style={{ fontWeight: '500', color: '#374151' }}>
                      ₹{formatINR(stockValue)}
                    </div>
                    <div data-label="Status">
                      {isOut ? (
                        <span style={{
                          fontSize: '11px', padding: '3px 8px',
                          borderRadius: '99px', background: '#fef2f2',
                          color: '#dc2626', fontWeight: '600'
                        }}>Out of Stock</span>
                      ) : isLow ? (
                        <span style={{
                          fontSize: '11px', padding: '3px 8px',
                          borderRadius: '99px', background: '#fef9c3',
                          color: '#854d0e', fontWeight: '600'
                        }}>Low Stock</span>
                      ) : (
                        <span style={{
                          fontSize: '11px', padding: '3px 8px',
                          borderRadius: '99px', background: '#f0fdf4',
                          color: '#166534', fontWeight: '600'
                        }}>In Stock</span>
                      )}
                    </div>
                    <div data-label="Actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      <button
                        onClick={() => {
                          setSelectedProduct(product)
                          setAdjustType('in')
                          setAdjustQty('')
                          setAdjustNotes('')
                          setAdjustError('')
                          setShowAdjustForm(true)
                        }}
                        style={{
                          padding: '4px 10px', background: '#f0fdf4',
                          border: '1px solid #bbf7d0', borderRadius: '6px',
                          fontSize: '11px', cursor: 'pointer',
                          color: '#166534', fontWeight: '500'
                        }}
                      >+ Add</button>
                      <button
                        onClick={() => {
                          setSelectedProduct(product)
                          setAdjustType('out')
                          setAdjustQty('')
                          setAdjustNotes('')
                          setAdjustError('')
                          setShowAdjustForm(true)
                        }}
                        style={{
                          padding: '4px 10px', background: '#fef2f2',
                          border: '1px solid #fecaca', borderRadius: '6px',
                          fontSize: '11px', cursor: 'pointer',
                          color: '#dc2626', fontWeight: '500'
                        }}
                      >− Remove</button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* MOVEMENTS TAB */}
      {activeTab === 'movements' && (
        <>
          <div className="toolbar" style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
            <select
              style={{ ...inputStyle, maxWidth: '280px', cursor: 'pointer' }}
              value={movementProduct}
              onChange={e => setMovementProduct(e.target.value)}
            >
              <option value="all">All Products</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {filteredMovements.length === 0 ? (
            <div style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', padding: '3rem',
              textAlign: 'center', color: '#94a3b8'
            }}>
              <div style={{ fontSize: '32px', marginBottom: '1rem' }}>📋</div>
              <div style={{ fontSize: '15px', fontWeight: '500', color: '#64748b' }}>
                No stock movements yet
              </div>
              <div style={{ fontSize: '13px', marginTop: '6px' }}>
                Stock movements will appear here when you create invoices,
                record purchases, or make manual adjustments
              </div>
            </div>
          ) : (
            <div className="responsive-table table-frame" style={{
              background: 'white', border: '1px solid #e2e8f0',
              borderRadius: '12px', overflow: 'hidden'
            }}>
              <div className="table-header" style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1.5fr',
                gap: '12px', padding: '10px 16px', background: '#f8fafc',
                fontSize: '12px', fontWeight: '600', color: '#64748b',
                borderBottom: '1px solid #e2e8f0'
              }}>
                <span>Date</span>
                <span>Product</span>
                <span>Type</span>
                <span>Qty Change</span>
                <span>Balance</span>
                <span>Reference</span>
              </div>

              {filteredMovements.map(m => {
                const mc = movementConfig[m.movement_type] || {
                  label: m.movement_type, color: '#374151', bg: '#f1f5f9'
                }
                const product = m.products as any
                return (
                  <div key={m.id} className="table-row" style={{
                    display: 'grid',
                    gridTemplateColumns: '1.5fr 2fr 1fr 1fr 1fr 1.5fr',
                    gap: '12px', padding: '11px 16px',
                    borderBottom: '1px solid #f1f5f9',
                    alignItems: 'center', fontSize: '13px'
                  }}>
                    <div data-label="Date" style={{ color: '#64748b' }}>
                      {new Date(m.created_at).toLocaleDateString('en-IN', {
                        day: '2-digit', month: 'short', year: 'numeric'
                      })}
                      <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                        {new Date(m.created_at).toLocaleTimeString('en-IN', {
                          hour: '2-digit', minute: '2-digit'
                        })}
                      </div>
                    </div>
                    <div data-label="Product" style={{ fontWeight: '500', color: '#1e293b' }}>
                      {product?.name || '—'}
                      <div style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '400' }}>
                        {product?.unit || ''}
                      </div>
                    </div>
                    <div data-label="Type">
                      <span style={{
                        fontSize: '11px', padding: '2px 8px',
                        borderRadius: '99px', fontWeight: '600',
                        background: mc.bg, color: mc.color
                      }}>
                        {mc.label}
                      </span>
                    </div>
                    <div data-label="Qty Change" style={{
                      fontWeight: '600', fontSize: '14px',
                      color: Number(m.quantity) > 0 ? '#059669' : '#dc2626'
                    }}>
                      {Number(m.quantity) > 0 ? '+' : ''}{Number(m.quantity).toFixed(2)}
                    </div>
                    <div data-label="Balance" style={{ fontWeight: '500', color: '#374151' }}>
                      {Number(m.balance_after).toFixed(2)}
                    </div>
                    <div data-label="Reference" style={{ color: '#64748b', fontSize: '12px' }}>
                      {m.reference_number || m.notes || '—'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Adjustment Modal */}
      {showAdjustForm && selectedProduct && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 100, padding: '1rem'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px',
            padding: '2rem', width: '100%', maxWidth: '440px'
          }}>
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              alignItems: 'center', marginBottom: '1.5rem'
            }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                Stock Adjustment
              </h2>
              <button
                onClick={() => { setShowAdjustForm(false); setSelectedProduct(null) }}
                style={{
                  background: 'none', border: 'none',
                  fontSize: '20px', cursor: 'pointer', color: '#94a3b8'
                }}
              >✕</button>
            </div>

            {/* Product info */}
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: '8px', padding: '12px 14px', marginBottom: '1.5rem'
            }}>
              <div style={{ fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
                {selectedProduct.name}
              </div>
              <div style={{ fontSize: '13px', color: '#64748b' }}>
                Current stock:{' '}
                <strong style={{ color: '#1e293b' }}>
                  {Number(selectedProduct.current_stock).toFixed(2)} {selectedProduct.unit}
                </strong>
              </div>
            </div>

            {/* Type toggle */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
              <button
                onClick={() => setAdjustType('in')}
                style={{
                  flex: 1, padding: '10px',
                  background: adjustType === 'in' ? '#f0fdf4' : '#f8fafc',
                  color: adjustType === 'in' ? '#166534' : '#64748b',
                  border: `1px solid ${adjustType === 'in' ? '#bbf7d0' : '#e2e8f0'}`,
                  borderRadius: '8px', fontSize: '14px',
                  cursor: 'pointer', fontWeight: '600'
                }}
              >
                + Add Stock
              </button>
              <button
                onClick={() => setAdjustType('out')}
                style={{
                  flex: 1, padding: '10px',
                  background: adjustType === 'out' ? '#fef2f2' : '#f8fafc',
                  color: adjustType === 'out' ? '#dc2626' : '#64748b',
                  border: `1px solid ${adjustType === 'out' ? '#fecaca' : '#e2e8f0'}`,
                  borderRadius: '8px', fontSize: '14px',
                  cursor: 'pointer', fontWeight: '600'
                }}
              >
                − Remove Stock
              </button>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label style={labelStyle}>
                Quantity ({selectedProduct.unit}) *
              </label>
              <input
                style={inputStyle}
                type="number"
                value={adjustQty}
                onChange={e => setAdjustQty(e.target.value)}
                placeholder="0"
                min="0"
                step="0.001"
                autoFocus
              />
              {adjustType === 'out' && (
                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                  Max: {Number(selectedProduct.current_stock).toFixed(2)} {selectedProduct.unit}
                </div>
              )}
            </div>

            <div style={{ marginBottom: '1.5rem' }}>
              <label style={labelStyle}>Reason / Notes</label>
              <input
                style={inputStyle}
                value={adjustNotes}
                onChange={e => setAdjustNotes(e.target.value)}
                placeholder="e.g. Stock count correction, damaged goods..."
              />
            </div>

            {/* Preview */}
            {adjustQty && parseFloat(adjustQty) > 0 && (
              <div style={{
                background: adjustType === 'in' ? '#f0fdf4' : '#fef2f2',
                border: `1px solid ${adjustType === 'in' ? '#bbf7d0' : '#fecaca'}`,
                borderRadius: '8px', padding: '10px 14px', marginBottom: '1rem',
                fontSize: '13px',
                color: adjustType === 'in' ? '#166534' : '#dc2626'
              }}>
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
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca',
                color: '#dc2626', padding: '10px 12px',
                borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
              }}>{adjustError}</div>
            )}

            <div className="btn-group" style={{ display: 'flex', gap: '12px' }}>
              <button
                onClick={handleAdjustment}
                disabled={adjusting}
                style={{
                  flex: 1, padding: '11px',
                  background: adjusting ? '#93c5fd' :
                    adjustType === 'in' ? '#059669' : '#dc2626',
                  color: 'white', border: 'none',
                  borderRadius: '8px', fontSize: '14px',
                  fontWeight: '600',
                  cursor: adjusting ? 'not-allowed' : 'pointer'
                }}
              >
                {adjusting ? 'Saving...' :
                  adjustType === 'in' ? '+ Add Stock' : '− Remove Stock'}
              </button>
              <button
                onClick={() => { setShowAdjustForm(false); setSelectedProduct(null) }}
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