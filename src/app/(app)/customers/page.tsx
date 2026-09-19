'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { INDIAN_STATES, validateGSTIN } from '@/lib/constants'

const inputStyle = {
  width: '100%',
  padding: '9px 12px',
  border: '1px solid #d1d5db',
  borderRadius: '8px',
  fontSize: '14px',
  outline: 'none',
  color: '#1e293b',
  background: 'white',
}

const labelStyle = {
  display: 'block' as const,
  fontSize: '13px',
  fontWeight: '500' as const,
  color: '#374151',
  marginBottom: '5px',
}

type Customer = {
  id: string
  name: string
  business_name: string
  gstin: string
  customer_type: string
  city: string
  state: string
  phone: string
  email: string
  is_active: boolean
}

export default function CustomersPage() {
  const supabase = createClient()
  const router = useRouter()

  const [customers, setCustomers] = useState<Customer[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)

  const [form, setForm] = useState({
    name: '',
    business_name: '',
    gstin: '',
    pan: '',
    customer_type: 'b2b',
    address_line1: '',
    address_line2: '',
    city: '',
    state: '',
    state_code: '',
    pincode: '',
    phone: '',
    email: '',
    payment_terms: '30',
    notes: '',
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
      await fetchCustomers(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  async function fetchCustomers(oid: string) {
    const { data } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    setCustomers(data || [])
  }

  function resetForm() {
    setForm({
      name: '', business_name: '', gstin: '', pan: '',
      customer_type: 'b2b', address_line1: '', address_line2: '',
      city: '', state: '', state_code: '', pincode: '',
      phone: '', email: '', payment_terms: '30', notes: '',
    })
    setEditingId(null)
    setError('')
  }

  function handleEdit(customer: any) {
    setForm({
      name: customer.name || '',
      business_name: customer.business_name || '',
      gstin: customer.gstin || '',
      pan: customer.pan || '',
      customer_type: customer.customer_type || 'b2b',
      address_line1: customer.address_line1 || '',
      address_line2: customer.address_line2 || '',
      city: customer.city || '',
      state: customer.state || '',
      state_code: customer.state_code || '',
      pincode: customer.pincode || '',
      phone: customer.phone || '',
      email: customer.email || '',
      payment_terms: String(customer.payment_terms || 30),
      notes: customer.notes || '',
    })
    setEditingId(customer.id)
    setShowForm(true)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    if (form.gstin && !validateGSTIN(form.gstin)) {
      setError('Invalid GSTIN format. Please check and re-enter.')
      setSaving(false)
      return
    }

    const payload = {
      organization_id: orgId,
      name: form.name,
      business_name: form.business_name,
      gstin: form.gstin.toUpperCase(),
      pan: form.pan.toUpperCase(),
      customer_type: form.customer_type,
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
      const { error } = await supabase
        .from('customers')
        .update(payload)
        .eq('id', editingId)
      err = error
    } else {
      const { error } = await supabase
        .from('customers')
        .insert(payload)
      err = error
    }

    if (err) {
      setError(err.message)
    } else {
      await fetchCustomers(orgId)
      setShowForm(false)
      resetForm()
    }
    setSaving(false)
  }

  async function toggleActive(id: string, current: boolean) {
    await supabase
      .from('customers')
      .update({ is_active: !current })
      .eq('id', id)
    await fetchCustomers(orgId)
  }

  const filtered = customers.filter(c =>
    c.name?.toLowerCase().includes(search.toLowerCase()) ||
    c.business_name?.toLowerCase().includes(search.toLowerCase()) ||
    c.gstin?.toLowerCase().includes(search.toLowerCase()) ||
    c.phone?.includes(search) ||
    c.email?.toLowerCase().includes(search.toLowerCase())
  )

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div style={{ padding: '2rem', maxWidth: '1100px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Customers
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            {customers.length} customer{customers.length !== 1 ? 's' : ''}
          </p>
        </div>
        <button
          onClick={() => { resetForm(); setShowForm(true) }}
          style={{
            padding: '9px 18px',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '14px',
            fontWeight: '600',
            cursor: 'pointer'
          }}
        >
          + Add Customer
        </button>
      </div>

      {/* Search */}
      <input
        style={{ ...inputStyle, marginBottom: '1rem', maxWidth: '400px' }}
        placeholder="Search by name, GSTIN, phone, email..."
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {/* Customer list */}
      {filtered.length === 0 ? (
        <div style={{
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: '12px',
          padding: '3rem',
          textAlign: 'center',
          color: '#94a3b8'
        }}>
          <div style={{ fontSize: '32px', marginBottom: '1rem' }}>👥</div>
          <div style={{ fontSize: '16px', fontWeight: '500', marginBottom: '8px', color: '#64748b' }}>
            No customers yet
          </div>
          <div style={{ fontSize: '13px' }}>
            Add your first customer to start creating invoices
          </div>
        </div>
      ) : (
        <div style={{
          background: 'white',
          border: '1px solid #e2e8f0',
          borderRadius: '12px',
          overflow: 'hidden'
        }}>
          {/* Table header */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr 80px',
            gap: '12px',
            padding: '10px 16px',
            background: '#f8fafc',
            fontSize: '12px',
            fontWeight: '600',
            color: '#64748b',
            borderBottom: '1px solid #e2e8f0'
          }}>
            <span>Name</span>
            <span>GSTIN</span>
            <span>Phone / Email</span>
            <span>Type</span>
            <span>Status</span>
            <span>Actions</span>
          </div>

          {filtered.map((customer) => (
            <div key={customer.id} style={{
              display: 'grid',
              gridTemplateColumns: '2fr 2fr 1.5fr 1fr 1fr 80px',
              gap: '12px',
              padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9',
              alignItems: 'center',
              fontSize: '13px'
            }}>
              <div>
                <div style={{ fontWeight: '500', color: '#1e293b' }}>{customer.name}</div>
                {customer.business_name && (
                  <div style={{ fontSize: '12px', color: '#64748b' }}>{customer.business_name}</div>
                )}
              </div>
              <div style={{ fontFamily: 'monospace', fontSize: '12px', color: '#374151' }}>
                {customer.gstin || '—'}
              </div>
              <div>
                <div style={{ color: '#374151' }}>{customer.phone || '—'}</div>
                <div style={{ fontSize: '12px', color: '#64748b' }}>{customer.email || ''}</div>
              </div>
              <div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '99px',
                  background: customer.customer_type === 'b2b' ? '#eff6ff' : '#f0fdf4',
                  color: customer.customer_type === 'b2b' ? '#1d4ed8' : '#166534',
                  textTransform: 'uppercase' as const,
                  fontWeight: '600'
                }}>
                  {customer.customer_type}
                </span>
              </div>
              <div>
                <span style={{
                  fontSize: '11px',
                  padding: '2px 8px',
                  borderRadius: '99px',
                  background: customer.is_active ? '#f0fdf4' : '#f8fafc',
                  color: customer.is_active ? '#166534' : '#94a3b8'
                }}>
                  {customer.is_active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => handleEdit(customer)}
                  style={{
                    padding: '4px 10px',
                    background: '#f1f5f9',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    fontSize: '12px',
                    cursor: 'pointer',
                    color: '#374151'
                  }}
                >
                  Edit
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit Form Modal */}
      {showForm && (
        <div style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 100,
          padding: '1rem'
        }}>
          <div style={{
            background: 'white',
            borderRadius: '16px',
            padding: '2rem',
            width: '100%',
            maxWidth: '620px',
            maxHeight: '90vh',
            overflowY: 'auto'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '600', color: '#1e293b' }}>
                {editingId ? 'Edit Customer' : 'Add Customer'}
              </h2>
              <button
                onClick={() => { setShowForm(false); resetForm() }}
                style={{ background: 'none', border: 'none', fontSize: '20px', cursor: 'pointer', color: '#94a3b8' }}
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Contact Name *</label>
                  <input style={inputStyle} value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    placeholder="Rajesh Kumar" required />
                </div>
                <div>
                  <label style={labelStyle}>Business Name</label>
                  <input style={inputStyle} value={form.business_name}
                    onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))}
                    placeholder="XYZ Enterprises" />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
                <div>
                  <label style={labelStyle}>Customer Type *</label>
                  <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.customer_type}
                    onChange={e => setForm(p => ({ ...p, customer_type: e.target.value }))}>
                    <option value="b2b">B2B (Registered Business)</option>
                    <option value="b2c">B2C (Individual / Unregistered)</option>
                    <option value="export">Export</option>
                    <option value="sez">SEZ</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Payment Terms (days)</label>
                  <input style={inputStyle} type="number" value={form.payment_terms}
                    onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))}
                    placeholder="30" min="0" />
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <label style={labelStyle}>Address Line 1</label>
                <input style={inputStyle} value={form.address_line1}
                  onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))}
                  placeholder="Building / Street" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
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
                    placeholder="contact@xyz.com" />
                </div>
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={labelStyle}>Notes</label>
                <textarea style={{ ...inputStyle, height: '70px', resize: 'vertical' as const }}
                  value={form.notes}
                  onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
                  placeholder="Any additional notes..." />
              </div>

              {error && (
                <div style={{
                  background: '#fef2f2', border: '1px solid #fecaca',
                  color: '#dc2626', padding: '10px 12px',
                  borderRadius: '8px', fontSize: '13px', marginBottom: '1rem'
                }}>
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', gap: '12px' }}>
                <button type="submit" disabled={saving} style={{
                  flex: 1, padding: '11px',
                  background: saving ? '#93c5fd' : '#2563eb',
                  color: 'white', border: 'none',
                  borderRadius: '8px', fontSize: '14px',
                  fontWeight: '600', cursor: saving ? 'not-allowed' : 'pointer'
                }}>
                  {saving ? 'Saving...' : editingId ? 'Update Customer' : 'Add Customer'}
                </button>
                <button type="button"
                  onClick={() => { setShowForm(false); resetForm() }}
                  style={{
                    padding: '11px 20px', background: 'white',
                    color: '#374151', border: '1px solid #e2e8f0',
                    borderRadius: '8px', fontSize: '14px', cursor: 'pointer'
                  }}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}