'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { INDIAN_STATES, validateGSTIN } from '@/lib/constants'

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

type Vendor = {
  id: string
  name: string
  business_name: string
  gstin: string
  city: string
  state: string
  phone: string
  email: string
  is_active: boolean
}

export default function VendorsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [vendors, setVendors] = useState<Vendor[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '', business_name: '', gstin: '', pan: '',
    address_line1: '', address_line2: '', city: '',
    state: '', state_code: '', pincode: '',
    phone: '', email: '', payment_terms: '30', notes: '',
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
      await fetchVendors(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function fetchVendors(oid: string) {
    const { data } = await supabase
      .from('vendors')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    setVendors(data || [])
  }

  function resetForm() {
    setForm({
      name: '', business_name: '', gstin: '', pan: '',
      address_line1: '', address_line2: '', city: '',
      state: '', state_code: '', pincode: '',
      phone: '', email: '', payment_terms: '30', notes: '',
    })
    setEditingId(null)
    setError('')
  }

  function handleEdit(vendor: any) {
    setForm({
      name: vendor.name || '',
      business_name: vendor.business_name || '',
      gstin: vendor.gstin || '',
      pan: vendor.pan || '',
      address_line1: vendor.address_line1 || '',
      address_line2: vendor.address_line2 || '',
      city: vendor.city || '',
      state: vendor.state || '',
      state_code: vendor.state_code || '',
      pincode: vendor.pincode || '',
      phone: vendor.phone || '',
      email: vendor.email || '',
      payment_terms: String(vendor.payment_terms || 30),
      notes: vendor.notes || '',
    })
    setEditingId(vendor.id)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    if (form.gstin && !validateGSTIN(form.gstin)) {
      setError('Invalid GSTIN format.')
      setSaving(false)
      return
    }

    const payload = {
      organization_id: orgId,
      name: form.name,
      business_name: form.business_name,
      gstin: form.gstin.toUpperCase(),
      pan: form.pan.toUpperCase(),
      address_line1: form.address_line1,
      address_line2: form.address_line2,
      city: form.city,
      state: form.state,
      state_code: form.state_code,
      pincode: form.pincode,
      phone: form.phone,
      email: form.email,
      payment_terms: parseInt(form.payment_terms),
      notes: form.notes,
    }

    let err
    if (editingId) {
      const { error } = await supabase.from('vendors').update(payload).eq('id', editingId)
      err = error
    } else {
      const { error } = await supabase.from('vendors').insert(payload)
      err = error
    }

    if (err) { setError(err.message) }
    else {
      await fetchVendors(orgId)
      setShowForm(false)
      resetForm()
    }
    setSaving(false)
  }

  async function toggleActive(vendor: Vendor) {
    const next = !vendor.is_active
    if (!confirm(`${next ? 'Reactivate' : 'Deactivate'} ${vendor.name}? Inactive vendors are hidden from the bill form.`)) return
    await supabase.from('vendors').update({ is_active: next }).eq('id', vendor.id)
    setVendors(prev => prev.map(v => (v.id === vendor.id ? { ...v, is_active: next } : v)))
  }

  const filtered = vendors.filter(v =>
    v.name?.toLowerCase().includes(search.toLowerCase()) ||
    v.business_name?.toLowerCase().includes(search.toLowerCase()) ||
    v.gstin?.toLowerCase().includes(search.toLowerCase()) ||
    v.phone?.includes(search)
  )

  if (loading) return <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>

  return (
    <div className="page-container" style={{ maxWidth: '1100px' }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>Vendors</h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>{vendors.length} vendor{vendors.length !== 1 ? 's' : ''}</p>
        </div>
        <button onClick={() => { resetForm(); setShowForm(true) }} style={{
          padding: '9px 18px', background: '#2563eb', color: 'white',
          border: 'none', borderRadius: '8px', fontSize: '14px',
          fontWeight: '600', cursor: 'pointer'
        }}>
          + Add Vendor
        </button>
      </div>

      <input style={{ ...inputStyle, marginBottom: '1rem', maxWidth: '400px' }}
        placeholder="Search vendors..." value={search}
        onChange={e => setSearch(e.target.value)} />

      {filtered.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '3rem', textAlign: 'center', color: '#94a3b8'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '1rem' }}>🏭</div>
          <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px', color: '#64748b' }}>No vendors yet</div>
          <div style={{ fontSize: '13px' }}>Add vendors to track your purchases and ITC</div>
        </div>
      ) : (
        <div className="responsive-table table-frame" style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', overflow: 'hidden' }}>
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '2fr 2fr 1.5fr 1fr 160px',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Name</span><span>GSTIN</span><span>Phone / Email</span>
            <span>Status</span><span>Actions</span>
          </div>
          {filtered.map((vendor) => (
            <div key={vendor.id} className="table-row" style={{
              display: 'grid', gridTemplateColumns: '2fr 2fr 1.5fr 1fr 160px',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center', fontSize: '13px'
            }}>
              <div data-label="Name">
                <div style={{ fontWeight: '500', color: '#1e293b' }}>{vendor.name}</div>
                {vendor.business_name && <div style={{ fontSize: '12px', color: '#64748b' }}>{vendor.business_name}</div>}
              </div>
              <div data-label="GSTIN" style={{ fontFamily: 'monospace', fontSize: '12px', color: '#374151' }}>{vendor.gstin || '—'}</div>
              <div data-label="Phone / Email">
                <div style={{ color: '#374151' }}>{vendor.phone || '—'}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{vendor.email || ''}</div>
              </div>
              <div data-label="Status">
                <span style={{
                  fontSize: '11px', padding: '2px 8px', borderRadius: '99px',
                  background: vendor.is_active ? '#f0fdf4' : '#f8fafc',
                  color: vendor.is_active ? '#166534' : '#94a3b8'
                }}>
                  {vendor.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div data-label="Actions" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                <button onClick={() => handleEdit(vendor)} style={{
                  padding: '4px 10px', background: '#f1f5f9',
                  border: '1px solid #e2e8f0', borderRadius: '6px',
                  fontSize: '12px', cursor: 'pointer', color: '#374151'
                }}>Edit</button>
                <button onClick={() => toggleActive(vendor)} style={{
                  padding: '4px 10px', background: 'white',
                  border: '1px solid #e2e8f0', borderRadius: '6px',
                  fontSize: '12px', cursor: 'pointer', color: '#64748b'
                }}>{vendor.is_active ? 'Deactivate' : 'Reactivate'}</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 100, padding: '1rem'
        }}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px', padding: '2rem',
            width: '100%', maxWidth: '620px', maxHeight: '90vh', overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                {editingId ? 'Edit Vendor' : 'Add Vendor'}
              </h2>
              <button onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}>✕</button>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Vendor Name *</label>
                  <input style={inputStyle} value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    placeholder="Supplier name" required />
                </div>
                <div>
                  <label style={labelStyle}>Business Name</label>
                  <input style={inputStyle} value={form.business_name}
                    onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))}
                    placeholder="Company name" />
                </div>
              </div>

              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>GSTIN</label>
                  <input style={inputStyle} value={form.gstin}
                    onChange={e => setForm(p => ({ ...p, gstin: e.target.value.toUpperCase() }))}
                    placeholder="27AABCU9603R1ZX" maxLength={15} />
                </div>
                <div>
                  <label style={labelStyle}>PAN</label>
                  <input style={inputStyle} value={form.pan}
                    onChange={e => setForm(p => ({ ...p, pan: e.target.value.toUpperCase() }))}
                    placeholder="AABCU9603R" maxLength={10} />
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={labelStyle}>Address</label>
                <input style={inputStyle} value={form.address_line1}
                  onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))}
                  placeholder="Street / Building" />
              </div>

              <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>City</label>
                  <input style={inputStyle} value={form.city}
                    onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                    placeholder="Mumbai" />
                </div>
                <div>
                  <label style={labelStyle}>State</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.state_code}
                    onChange={e => {
                      const s = INDIAN_STATES.find(x => x.value === e.target.value)
                      setForm(p => ({ ...p, state_code: e.target.value, state: s?.label || '' }))
                    }}>
                    <option value="">Select...</option>
                    {INDIAN_STATES.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Pincode</label>
                  <input style={inputStyle} value={form.pincode}
                    onChange={e => setForm(p => ({ ...p, pincode: e.target.value }))}
                    placeholder="400001" maxLength={6} />
                </div>
              </div>

              <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.5rem' }}>
                <div>
                  <label style={labelStyle}>Phone</label>
                  <input style={inputStyle} value={form.phone}
                    onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
                    placeholder="+91 98765 43210" />
                </div>
                <div>
                  <label style={labelStyle}>Email</label>
                  <input style={inputStyle} type="email" value={form.email}
                    onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                    placeholder="vendor@company.com" />
                </div>
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
                  {saving ? 'Saving...' : editingId ? 'Update Vendor' : 'Add Vendor'}
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