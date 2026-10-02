'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'

const inputStyle = {
  width: '100%', padding: '9px 12px',
  border: '1px solid #d1d5db', borderRadius: '8px',
  fontSize: '14px', outline: 'none',
  color: '#1e293b', background: 'white',
}

const labelStyle = {
  display: 'block' as const,
  fontSize: '13px', fontWeight: '500' as const,
  color: '#374151', marginBottom: '5px',
}

const UNITS = ['NOS', 'KGS', 'MTR', 'LTR', 'SQF', 'HRS', 'DYS', 'PCS', 'BOX', 'PKT', 'SET', 'PAI']
const GST_RATES = [0, 5, 12, 18, 28]

type Product = {
  id: string
  name: string
  type: string
  hsn_sac: string
  unit: string
  selling_price: number
  gst_rate: number
  is_active: boolean
  track_inventory: boolean
  current_stock: number
}

export default function ProductsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [products, setProducts] = useState<Product[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [filterType, setFilterType] = useState('all')

  const [form, setForm] = useState({
    name: '', description: '', sku: '',
    type: 'goods', hsn_sac: '', unit: 'NOS',
    purchase_price: '', selling_price: '',
    gst_rate: '18', cess_rate: '0',
    track_inventory: false,
    opening_stock: '0', minimum_stock: '0',
  })

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

  async function fetchProducts(oid: string) {
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    setProducts(data || [])
  }

  function resetForm() {
    setForm({
      name: '', description: '', sku: '',
      type: 'goods', hsn_sac: '', unit: 'NOS',
      purchase_price: '', selling_price: '',
      gst_rate: '18', cess_rate: '0',
      track_inventory: false,
      opening_stock: '0', minimum_stock: '0',
    })
    setEditingId(null)
    setError('')
  }

  function handleEdit(product: any) {
    setForm({
      name: product.name || '',
      description: product.description || '',
      sku: product.sku || '',
      type: product.type || 'goods',
      hsn_sac: product.hsn_sac || '',
      unit: product.unit || 'NOS',
      purchase_price: String(product.purchase_price || ''),
      selling_price: String(product.selling_price || ''),
      gst_rate: String(product.gst_rate || 18),
      cess_rate: String(product.cess_rate || 0),
      track_inventory: product.track_inventory || false,
      opening_stock: String(product.opening_stock || 0),
      minimum_stock: String(product.minimum_stock || 0),
    })
    setEditingId(product.id)
    setShowForm(true)
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
      current_stock: parseFloat(form.opening_stock) || 0,
      minimum_stock: parseFloat(form.minimum_stock) || 0,
    }

    let err
    if (editingId) {
      const { error } = await supabase.from('products').update(payload).eq('id', editingId)
      err = error
    } else {
      const { error } = await supabase.from('products').insert(payload)
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

  const filtered = products
    .filter(p => filterType === 'all' || p.type === filterType)
    .filter(p =>
      p.name?.toLowerCase().includes(search.toLowerCase()) ||
      p.hsn_sac?.toLowerCase().includes(search.toLowerCase())
    )

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Products & Services
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {products.length} item{products.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true) }} style={{
          padding: '9px 18px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer'
        }}>
          + Add Product
        </button>
      </div>

      {/* Filters */}
      <div className="toolbar" style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
        <input style={{ ...inputStyle, maxWidth: '300px' }}
          placeholder="Search products..." value={search}
          onChange={e => setSearch(e.target.value)} />
        {['all', 'goods', 'service'].map(t => (
          <button key={t} onClick={() => setFilterType(t)} style={{
            padding: '9px 16px',
            background: filterType === t ? '#2563eb' : 'white',
            color: filterType === t ? 'white' : '#374151',
            border: '1px solid #e2e8f0', borderRadius: '8px',
            fontSize: '13px', cursor: 'pointer', fontWeight: '500',
            textTransform: 'capitalize' as const
          }}>
            {t === 'all' ? 'All' : t === 'goods' ? '📦 Goods' : '⚙️ Services'}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '1rem' }}>📦</div>
          <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px', color: '#64748b' }}>
            No products yet
          </div>
          <div style={{ fontSize: '13px' }}>Add products or services to include them in invoices</div>
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 80px',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Name</span><span>HSN/SAC</span>
            <span>Selling Price</span><span>GST Rate</span>
            <span>Type</span><span>Actions</span>
          </div>
          {filtered.map((product) => (
            <div key={product.id} className="table-row" style={{
              display: 'grid', gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 80px',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Name">
                <div style={{ fontWeight: '500', color: '#1e293b' }}>{product.name}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>
                  {product.unit}
                  {product.track_inventory && ` · Stock: ${product.current_stock}`}
                </div>
              </div>
              <div data-label="HSN/SAC" style={{ fontFamily: 'monospace', fontSize: '12px', color: '#374151' }}>
                {product.hsn_sac || '—'}
              </div>
              <div data-label="Selling Price" style={{ fontWeight: '500', color: '#1e293b' }}>
                ₹{Number(product.selling_price).toLocaleString('en-IN')}
              </div>
              <div data-label="GST Rate">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: '#eff6ff', color: '#1d4ed8', fontWeight: '600'
                }}>
                  {product.gst_rate}%
                </span>
              </div>
              <div data-label="Type">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: product.type === 'goods' ? '#fef9c3' : '#f0fdf4',
                  color: product.type === 'goods' ? '#854d0e' : '#166534'
                }}>
                  {product.type === 'goods' ? '📦 Goods' : '⚙️ Service'}
                </span>
              </div>
              <div data-label="Actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => handleEdit(product)} style={{
                  padding: '4px 10px', background: '#f1f5f9',
                  border: '1px solid #e2e8f0', borderRadius: '6px',
                  fontSize: '12px', cursor: 'pointer', color: '#374151'
                }}>Edit</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Form Modal */}
      {showForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, padding: '1rem'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px', padding: '2rem',
            width: '100%', maxWidth: '640px', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                {editingId ? 'Edit Product' : 'Add Product / Service'}
              </h2>
              <button onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            <form onSubmit={handleSubmit}>
              {/* Type toggle */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
                {['goods', 'service'].map(t => (
                  <button key={t} type="button"
                    onClick={() => setForm(p => ({ ...p, type: t }))}
                    style={{
                      flex: 1, padding: '10px',
                      background: form.type === t ? '#2563eb' : '#f1f5f9',
                      color: form.type === t ? 'white' : '#374151',
                      border: '1px solid #e2e8f0', borderRadius: '8px',
                      fontSize: '14px', cursor: 'pointer', fontWeight: '500'
                    }}>
                    {t === 'goods' ? '📦 Goods' : '⚙️ Service'}
                  </button>
                ))}
              </div>

              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Name *</label>
                  <input style={inputStyle} value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    placeholder="Product or service name" required />
                </div>
                <div>
                  <label style={labelStyle}>SKU / Code</label>
                  <input style={inputStyle} value={form.sku}
                    onChange={e => setForm(p => ({ ...p, sku: e.target.value }))}
                    placeholder="SKU001" />
                </div>
              </div>

              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>{form.type === 'goods' ? 'HSN Code' : 'SAC Code'}</label>
                  <input style={inputStyle} value={form.hsn_sac}
                    onChange={e => setForm(p => ({ ...p, hsn_sac: e.target.value }))}
                    placeholder={form.type === 'goods' ? '1234' : '998314'} />
                </div>
                <div>
                  <label style={labelStyle}>Unit</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.unit}
                    onChange={e => setForm(p => ({ ...p, unit: e.target.value }))}>
                    {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
                  </select>
                </div>
              </div>

              <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Purchase Price (₹)</label>
                  <input style={inputStyle} type="number" value={form.purchase_price}
                    onChange={e => setForm(p => ({ ...p, purchase_price: e.target.value }))}
                    placeholder="0.00" min="0" step="0.01" />
                </div>
                <div>
                  <label style={labelStyle}>Selling Price (₹) *</label>
                  <input style={inputStyle} type="number" value={form.selling_price}
                    onChange={e => setForm(p => ({ ...p, selling_price: e.target.value }))}
                    placeholder="0.00" min="0" step="0.01" required />
                </div>
                <div>
                  <label style={labelStyle}>GST Rate *</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.gst_rate}
                    onChange={e => setForm(p => ({ ...p, gst_rate: e.target.value }))}>
                    {GST_RATES.map(r => <option key={r} value={r}>{r}%</option>)}
                  </select>
                </div>
              </div>

              {form.type === 'goods' && (
                <div style={{
                  background: '#f8fafc', border: '1px solid #e2e8f0',
                  borderRadius: '8px', padding: '1rem', marginBottom: '1rem'
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '12px' }}>
                    <input type="checkbox" checked={form.track_inventory}
                      onChange={e => setForm(p => ({ ...p, track_inventory: e.target.checked }))} />
                    <span style={{ fontSize: '13px', fontWeight: '500', color: '#374151' }}>
                      Track inventory for this product
                    </span>
                  </label>
                  {form.track_inventory && (
                    <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                      <div>
                        <label style={labelStyle}>Opening Stock</label>
                        <input style={inputStyle} type="number" value={form.opening_stock}
                          onChange={e => setForm(p => ({ ...p, opening_stock: e.target.value }))}
                          min="0" />
                      </div>
                      <div>
                        <label style={labelStyle}>Minimum Stock Alert</label>
                        <input style={inputStyle} type="number" value={form.minimum_stock}
                          onChange={e => setForm(p => ({ ...p, minimum_stock: e.target.value }))}
                          min="0" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={labelStyle}>Description</label>
                <textarea style={{ ...inputStyle, height: '60px', resize: 'vertical' as const }}
                  value={form.description}
                  onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                  placeholder="Optional description" />
              </div>

              {error && (
                <div style={{
                  background: '#fef2f2', border: '1px solid #fecaca',
                  color: '#dc2626', padding: '10px 12px',
                  borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
                }}>{error}</div>
              )}

              <div className="btn-group" style={{ display: 'flex', gap: '12px' }}>
                <button type="submit" disabled={saving} style={{
                  flex: 1, padding: '11px',
                  background: saving ? '#93c5fd' : '#2563eb',
                  color: 'white', border: 'none', borderRadius: '8px',
                  fontSize: '14px', fontWeight: '600',
                  cursor: saving ? 'not-allowed' : 'pointer'
                }}>
                  {saving ? 'Saving...' : editingId ? 'Update' : 'Add Product'}
                </button>
                <button type="button" onClick={() => { setShowForm(false); resetForm() }} style={{
                  padding: '11px 20px', background: 'white', color: '#374151',
                  border: '1px solid #e2e8f0', borderRadius: '8px',
                  fontSize: '14px', cursor: 'pointer'
                }}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}