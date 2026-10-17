'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { INDIAN_STATES, validateGSTIN } from '@/lib/constants'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard, useDialog } from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'

type Customer = {
  id: string
  name: string
  business_name: string | null
  gstin: string | null
  pan: string | null
  customer_type: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  state_code: string | null
  pincode: string | null
  phone: string | null
  email: string | null
  payment_terms: number | null
  notes: string | null
  is_active: boolean
}

const TYPE_LABEL: Record<string, string> = {
  b2b: 'B2B', b2c: 'B2C', export: 'Export', sez: 'SEZ',
}

const TYPE_TONE: Record<string, 'blue' | 'green' | 'violet' | 'cyan'> = {
  b2b: 'blue', b2c: 'green', export: 'violet', sez: 'cyan',
}

const VIEWS = [
  { value: 'all', label: 'All', noun: 'matching' },
  { value: 'active', label: 'Active', noun: 'active' },
  { value: 'b2b', label: 'B2B', noun: 'B2B' },
  { value: 'b2c', label: 'B2C', noun: 'B2C' },
]

const emptyForm = () => ({
  name: '', business_name: '', gstin: '', pan: '',
  customer_type: 'b2b', address_line1: '', address_line2: '',
  city: '', state: '', state_code: '', pincode: '',
  phone: '', email: '', payment_terms: '30', notes: '',
})

function CustomersPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [customers, setCustomers] = useState<Customer[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const formDialog = useDialog(() => { setShowForm(false); resetForm() })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState('all')
  const [editingId, setEditingId] = useState<string | null>(null)

  const [form, setForm] = useState(emptyForm())

  async function fetchCustomers(oid: string) {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    if (error) setLoadError(error.message)
    setCustomers((data as Customer[]) || [])
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
      await fetchCustomers(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setForm(emptyForm())
    setEditingId(null)
    setError('')
  }

  function handleEdit(customer: Customer) {
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
      payment_terms: String(customer.payment_terms ?? 30),
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
      const { error } = await supabase.from('customers').update(payload).eq('id', editingId)
      err = error
    } else {
      const { error } = await supabase.from('customers').insert(payload)
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

  async function toggleActive(customer: Customer) {
    const next = !customer.is_active
    if (!confirm(`${next ? 'Reactivate' : 'Deactivate'} ${customer.name}? Inactive customers are hidden from the invoice form.`)) return
    await supabase.from('customers').update({ is_active: next }).eq('id', customer.id)
    setCustomers(prev => prev.map(c => (c.id === customer.id ? { ...c, is_active: next } : c)))
  }

  const summary = useMemo(() => {
    const visible = customers.filter(c => {
      if (view === 'active' && !c.is_active) return false
      if (view === 'b2b' && c.customer_type !== 'b2b') return false
      if (view === 'b2c' && c.customer_type !== 'b2c') return false
      return matchesAny(search, [c.name, c.business_name, c.gstin, c.phone, c.email])
    })
    return {
      visible,
      active: customers.filter(c => c.is_active).length,
      b2b: customers.filter(c => c.customer_type === 'b2b').length,
      b2bNoGstin: customers.filter(c => c.customer_type === 'b2b' && !c.gstin?.trim()).length,
    }
  }, [customers, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your customers…</div>
  }

  return (
    <div className="page-container cu" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Sales"
        title="Customers"
        subtitle="Who you sell to decides the GST you charge: their GSTIN makes them B2B, their state decides CGST+SGST versus IGST."
        actions={<Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add customer</Button>}
      />

      {loadError && (
        <div className="cu-alert"><Icon name="alert" size={14} />{loadError}</div>
      )}

      <div className="cu-stats">
        <StatCard label="Customers" value={String(customers.length)}
          sub={`${summary.visible.length} shown`} icon="users" tone="blue" />
        <StatCard label="Active" value={String(summary.active)} sub="available on the invoice form" icon="check" tone="green" delay={40} />
        <StatCard label="B2B" value={String(summary.b2b)} sub="registered, credit-claiming buyers" icon="building" tone="violet" delay={80} />
        <StatCard label="B2B without GSTIN" value={String(summary.b2bNoGstin)}
          sub={summary.b2bNoGstin ? 'their input credit will be blocked' : 'every B2B party is identified'}
          icon="alert" tone={summary.b2bNoGstin ? 'amber' : 'grey'} delay={120} />
      </div>

      <div className="cu-toolbar">
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Name, GSTIN, phone or email…"
          ariaLabel="Search customers"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {summary.visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={customers.length ? 'search' : 'users'}
            title={customers.length
              ? (search ? `No customer matches “${search}”` : `No ${VIEWS.find(x => x.value === view)?.noun} customers`)
              : 'No customers yet'}
            message={customers.length
              ? 'Clear the search or pick another filter to see the whole party list.'
              : 'Add your first customer to start creating invoices.'}
            action={!customers.length ? (
              <Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add customer</Button>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header cu-row cu-head">
              <span data-label="Name">Customer</span>
              <span data-label="GSTIN">GSTIN</span>
              <span data-label="Type">Type</span>
              <span data-label="Contact">Phone / city</span>
              <span className="cu-right" data-label="Status">Status</span>
              <span className="cu-right" data-label="Actions">Actions</span>
            </div>
            {summary.visible.map((customer) => (
              <div key={customer.id} className={`table-row cu-row ${customer.is_active ? '' : 'cu-dim'}`}>
                <span data-label="Name" className="cu-name">
                  <span className="cu-name-main">{customer.name}</span>
                  {customer.business_name && <span className="cu-sub">{customer.business_name}</span>}
                </span>

                <span data-label="GSTIN" className={customer.gstin ? 'cu-mono' : 'cu-sub'}>{customer.gstin || '—'}</span>

                <span data-label="Type">
                  <Badge tone={TYPE_TONE[customer.customer_type || ''] || 'grey'} dot={false}>
                    {TYPE_LABEL[customer.customer_type || ''] || '—'}
                  </Badge>
                </span>

                <span data-label="Contact" className="cu-contact">
                  <span>{customer.phone || customer.email || '—'}</span>
                  {(customer.city || customer.state) && (
                    <span className="cu-sub">{[customer.city, customer.state].filter(Boolean).join(' · ')}</span>
                  )}
                </span>

                <span className="cu-right" data-label="Status">
                  {customer.is_active
                    ? <Badge tone="green">Active</Badge>
                    : <Badge tone="grey">Inactive</Badge>}
                  {customer.customer_type === 'b2b' && !customer.gstin?.trim() && (
                    <div className="cu-flag">No GSTIN</div>
                  )}
                </span>

                <span className="cu-right cu-actions" data-label="Actions">
                  <Button size="sm" variant="subtle" onClick={() => handleEdit(customer)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(customer)}>
                    {customer.is_active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {customers.length > 0 && (
        <div className="cu-foot">
          <span>Shown: {summary.visible.length} of {customers.length}</span>
          <span>Every invoice carries a snapshot of the party details, so editing here never rewrites a bill already sent.</span>
        </div>
      )}

      {showForm && (
        <div ref={formDialog} className="cu-scrim" role="dialog" aria-modal="true" aria-label={editingId ? 'Edit customer' : 'Add customer'}>
          <div className="cu-modal">
            <div className="cu-modal-head">
              <h2>{editingId ? 'Edit customer' : 'Add customer'}</h2>
              <button type="button" className="cu-close" onClick={() => { setShowForm(false); resetForm() }} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="cu-form">
              <div className="cu-grid">
                <label className="cu-field">
                  <span>Contact name *</span>
                  <input className="tf-input" value={form.name} placeholder="Rajesh Kumar" required
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </label>
                <label className="cu-field">
                  <span>Business name</span>
                  <input className="tf-input" value={form.business_name} placeholder="XYZ Enterprises"
                    onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))} />
                </label>
              </div>

              <div className="cu-grid">
                <label className="cu-field">
                  <span>GSTIN</span>
                  <input className="tf-input cu-mono-input" value={form.gstin} placeholder="27AABCU9603R1ZX" maxLength={15}
                    onChange={e => setForm(p => ({ ...p, gstin: e.target.value.toUpperCase() }))} />
                </label>
                <label className="cu-field">
                  <span>PAN</span>
                  <input className="tf-input cu-mono-input" value={form.pan} placeholder="AABCU9603R" maxLength={10}
                    onChange={e => setForm(p => ({ ...p, pan: e.target.value.toUpperCase() }))} />
                </label>
              </div>

              <div className="cu-grid">
                <label className="cu-field">
                  <span>Customer type *</span>
                  <select className="tf-input" value={form.customer_type}
                    onChange={e => setForm(p => ({ ...p, customer_type: e.target.value }))}>
                    <option value="b2b">B2B (registered business)</option>
                    <option value="b2c">B2C (individual / unregistered)</option>
                    <option value="export">Export</option>
                    <option value="sez">SEZ</option>
                  </select>
                </label>
                <label className="cu-field">
                  <span>Payment terms (days)</span>
                  <input className="tf-input" type="number" value={form.payment_terms} placeholder="30" min="0"
                    onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))} />
                </label>
              </div>

              <label className="cu-field">
                <span>Address</span>
                <input className="tf-input" value={form.address_line1} placeholder="Building / street"
                  onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))} />
              </label>

              <div className="cu-grid-3">
                <label className="cu-field">
                  <span>City</span>
                  <input className="tf-input" value={form.city} placeholder="Mumbai"
                    onChange={e => setForm(p => ({ ...p, city: e.target.value }))} />
                </label>
                <label className="cu-field">
                  <span>State</span>
                  <select className="tf-input" value={form.state_code}
                    onChange={e => {
                      const s = INDIAN_STATES.find(x => x.value === e.target.value)
                      setForm(p => ({ ...p, state_code: e.target.value, state: s?.label || '' }))
                    }}>
                    <option value="">Select…</option>
                    {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                <label className="cu-field">
                  <span>Pincode</span>
                  <input className="tf-input" value={form.pincode} placeholder="400001" maxLength={6}
                    onChange={e => setForm(p => ({ ...p, pincode: e.target.value }))} />
                </label>
              </div>

              <div className="cu-grid">
                <label className="cu-field">
                  <span>Phone</span>
                  <input className="tf-input" value={form.phone} placeholder="+91 98765 43210"
                    onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
                </label>
                <label className="cu-field">
                  <span>Email</span>
                  <input className="tf-input" type="email" value={form.email} placeholder="contact@xyz.com"
                    onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
                </label>
              </div>

              <label className="cu-field">
                <span>Notes</span>
                <textarea className="tf-input cu-textarea" value={form.notes} placeholder="Any additional notes…"
                  onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
              </label>

              {form.customer_type === 'b2b' && !form.gstin.trim() && (
                <div className="cu-note">
                  <Icon name="alert" size={14} />
                  <span>A B2B buyer with no GSTIN gets a bill they cannot claim credit on — add the GSTIN or mark them B2C.</span>
                </div>
              )}

              {error && <div className="cu-alert"><Icon name="alert" size={14} />{error}</div>}

              <div className="cu-save">
                <Button variant="ghost" onClick={() => { setShowForm(false); resetForm() }}>Cancel</Button>
                <Button type="submit" disabled={saving} icon={saving ? undefined : 'check'}>
                  {saving ? 'Saving…' : editingId ? 'Update customer' : 'Add customer'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .cu-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .cu-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 10px; background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red); }
        .cu-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .cu-row { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1.1fr) 78px minmax(0, 1fr) 116px 176px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .cu-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .cu-right { text-align: right; }
        .cu-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .cu-name-main { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .cu-sub { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .cu-mono { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); overflow-wrap: anywhere; }
        .cu-contact { display: flex; flex-direction: column; gap: 2px; color: var(--ink-2); min-width: 0; }
        .cu-dim { opacity: 0.62; }
        .cu-flag { font-size: 10.5px; color: var(--amber); margin-top: 3px; }
        .cu-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

        .cu-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .cu-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .cu-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 640px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .cu-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .cu-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .cu-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .cu-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .cu-form { display: flex; flex-direction: column; gap: 12px; }
        .cu-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .cu-grid-3 { display: grid; grid-template-columns: 1fr 1.3fr 0.8fr; gap: 12px; }
        .cu-field { display: flex; flex-direction: column; gap: 4px; }
        .cu-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .cu-textarea { min-height: 60px; resize: vertical; }
        .cu-mono-input { font-family: var(--mono); letter-spacing: 0.03em; }
        .cu-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--ink-2);
          background: var(--amber-soft); border-radius: var(--radius-sm); padding: 10px 12px; }
        .cu-note svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }
        .cu-save { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }

        @media (max-width: 1100px) { .cu-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .cu-row { grid-template-columns: 1fr; gap: 6px; }
          .cu-head { display: none; }
          .cu-right { text-align: left; }
          .cu-actions { justify-content: flex-start; }
          .cu-stats { grid-template-columns: 1fr 1fr; }
          .cu-grid, .cu-grid-3 { grid-template-columns: 1fr; }
          .cu-modal { padding: 1.1rem 1.15rem; }
          .cu-scrim { align-items: flex-end; padding: 0; }
          .cu-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .cu-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function CustomersPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <CustomersPageInner />
    </Suspense>
  )
}
