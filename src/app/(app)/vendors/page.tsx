'use client'

import { Suspense, useMemo, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { INDIAN_STATES, validateGSTIN } from '@/lib/constants'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard, useDialog } from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'

type Vendor = {
  id: string
  name: string
  business_name: string | null
  gstin: string | null
  pan: string | null
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

const emptyForm = () => ({
  name: '', business_name: '', gstin: '', pan: '',
  address_line1: '', address_line2: '', city: '',
  state: '', state_code: '', pincode: '',
  phone: '', email: '', payment_terms: '30', notes: '',
})

const VIEWS = [
  { value: 'all', label: 'All', noun: 'matching' },
  { value: 'active', label: 'Active', noun: 'active' },
  { value: 'inactive', label: 'Inactive', noun: 'inactive' },
  { value: 'unidentified', label: 'No identifier', noun: 'unidentified' },
]

const hasId = (v: Vendor) => Boolean(v.gstin?.trim() || v.pan?.trim())

function VendorsPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [vendors, setVendors] = useState<Vendor[]>([])
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

  async function fetchVendors(oid: string) {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('organization_id', oid)
      .order('created_at', { ascending: false })
    if (error) setLoadError(error.message)
    setVendors((data as Vendor[]) || [])
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
      await fetchVendors(membership.organization_id)
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setForm(emptyForm())
    setEditingId(null)
    setError('')
  }

  function handleEdit(vendor: Vendor) {
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
      payment_terms: String(vendor.payment_terms ?? 30),
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

  const summary = useMemo(() => {
    const visible = vendors.filter(v => {
      if (view === 'active' && !v.is_active) return false
      if (view === 'inactive' && v.is_active) return false
      if (view === 'unidentified' && hasId(v)) return false
      return matchesAny(search, [v.name, v.business_name, v.gstin, v.pan, v.phone, v.city])
    })
    return {
      visible,
      active: vendors.filter(v => v.is_active).length,
      identified: vendors.filter(hasId).length,
      unidentified: vendors.filter(v => !hasId(v)).length,
    }
  }, [vendors, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your vendors…</div>
  }

  return (
    <div className="page-container vd" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Purchases"
        title="Vendors"
        subtitle="The suppliers behind every input bill. Their GSTIN decides whether your credit is claimable and their PAN decides what TDS costs you."
        actions={<Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add vendor</Button>}
      />

      {loadError && (
        <div className="vd-alert"><Icon name="alert" size={14} />{loadError}</div>
      )}

      <div className="vd-stats">
        <StatCard label="Vendors" value={String(vendors.length)}
          sub={`${summary.visible.length} shown`} icon="factory" tone="blue" />
        <StatCard label="Active" value={String(summary.active)} sub="available on the bill form" icon="check" tone="green" delay={40} />
        <StatCard label="Identified" value={String(summary.identified)} sub="PAN or GSTIN on record" icon="file-check" tone="violet" delay={80} />
        <StatCard label="No identifier" value={String(summary.unidentified)}
          sub={summary.unidentified ? 'withholding falls to the no-PAN rate' : 'every vendor is identifiable'}
          icon="alert" tone={summary.unidentified ? 'amber' : 'grey'} delay={120} />
      </div>

      <div className="vd-toolbar">
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Name, GSTIN, PAN or phone…"
          ariaLabel="Search vendors"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {summary.visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={vendors.length ? 'search' : 'factory'}
            title={vendors.length
              ? (search ? `No vendor matches “${search}”` : `No ${VIEWS.find(x => x.value === view)?.noun} vendors`)
              : 'No vendors yet'}
            message={vendors.length
              ? 'Clear the search or pick another filter to see the whole vendor list.'
              : 'Add the suppliers you buy from — bills, ITC and TDS all hang off this list.'}
            action={!vendors.length ? (
              <Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add vendor</Button>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header vd-row vd-head">
              <span data-label="Name">Vendor</span>
              <span data-label="GSTIN">GSTIN</span>
              <span data-label="PAN">PAN</span>
              <span data-label="Contact">Phone / city</span>
              <span className="vd-right" data-label="Status">Status</span>
              <span className="vd-right" data-label="Actions">Actions</span>
            </div>
            {summary.visible.map((vendor) => (
              <div key={vendor.id} className={`table-row vd-row ${vendor.is_active ? '' : 'vd-dim'}`}>
                <span data-label="Name" className="vd-name">
                  <span className="vd-name-main">{vendor.name}</span>
                  {vendor.business_name && <span className="vd-sub">{vendor.business_name}</span>}
                </span>

                <span data-label="GSTIN" className={vendor.gstin ? 'vd-mono' : 'vd-sub'}>{vendor.gstin || '—'}</span>

                <span data-label="PAN" className={vendor.pan ? 'vd-mono' : 'vd-sub'}>{vendor.pan || '—'}</span>

                <span data-label="Contact" className="vd-contact">
                  <span>{vendor.phone || '—'}</span>
                  {(vendor.city || vendor.state) && (
                    <span className="vd-sub">{[vendor.city, vendor.state].filter(Boolean).join(' · ')}</span>
                  )}
                </span>

                <span className="vd-right" data-label="Status">
                  {vendor.is_active
                    ? <Badge tone="green">Active</Badge>
                    : <Badge tone="grey">Inactive</Badge>}
                  {!hasId(vendor) && <div className="vd-flag">No identifier</div>}
                </span>

                <span className="vd-right vd-actions" data-label="Actions">
                  <Button size="sm" variant="subtle" onClick={() => handleEdit(vendor)}>Edit</Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(vendor)}>
                    {vendor.is_active ? 'Deactivate' : 'Reactivate'}
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {vendors.length > 0 && (
        <div className="vd-foot">
          <span>Shown: {summary.visible.length} of {vendors.length}</span>
          <span>An inactive vendor stays on every past bill — deactivating only hides it from new entries.</span>
        </div>
      )}

      {showForm && (
        <div ref={formDialog} className="vd-scrim" role="dialog" aria-modal="true" aria-label={editingId ? 'Edit vendor' : 'Add vendor'}>
          <div className="vd-modal">
            <div className="vd-modal-head">
              <h2>{editingId ? 'Edit vendor' : 'Add vendor'}</h2>
              <button type="button" className="vd-close" onClick={() => { setShowForm(false); resetForm() }} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="vd-form">
              <div className="vd-grid">
                <label className="vd-field">
                  <span>Vendor name *</span>
                  <input className="tf-input" value={form.name} placeholder="Supplier name" required
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))} />
                </label>
                <label className="vd-field">
                  <span>Business name</span>
                  <input className="tf-input" value={form.business_name} placeholder="Registered company name"
                    onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))} />
                </label>
              </div>

              <div className="vd-grid">
                <label className="vd-field">
                  <span>GSTIN</span>
                  <input className="tf-input vd-mono-input" value={form.gstin} placeholder="27AABCU9603R1ZX" maxLength={15}
                    onChange={e => setForm(p => ({ ...p, gstin: e.target.value.toUpperCase() }))} />
                </label>
                <label className="vd-field">
                  <span>PAN</span>
                  <input className="tf-input vd-mono-input" value={form.pan} placeholder="AABCU9603R" maxLength={10}
                    onChange={e => setForm(p => ({ ...p, pan: e.target.value.toUpperCase() }))} />
                </label>
              </div>

              <label className="vd-field">
                <span>Address</span>
                <input className="tf-input" value={form.address_line1} placeholder="Street / building"
                  onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))} />
              </label>

              <div className="vd-grid-3">
                <label className="vd-field">
                  <span>City</span>
                  <input className="tf-input" value={form.city} placeholder="Mumbai"
                    onChange={e => setForm(p => ({ ...p, city: e.target.value }))} />
                </label>
                <label className="vd-field">
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
                <label className="vd-field">
                  <span>Pincode</span>
                  <input className="tf-input" value={form.pincode} placeholder="400001" maxLength={6}
                    onChange={e => setForm(p => ({ ...p, pincode: e.target.value }))} />
                </label>
              </div>

              <div className="vd-grid">
                <label className="vd-field">
                  <span>Phone</span>
                  <input className="tf-input" value={form.phone} placeholder="+91 98765 43210"
                    onChange={e => setForm(p => ({ ...p, phone: e.target.value }))} />
                </label>
                <label className="vd-field">
                  <span>Email</span>
                  <input className="tf-input" type="email" value={form.email} placeholder="vendor@company.com"
                    onChange={e => setForm(p => ({ ...p, email: e.target.value }))} />
                </label>
              </div>

              {!form.gstin.trim() && !form.pan.trim() && (
                <div className="vd-note">
                  <Icon name="alert" size={14} />
                  <span>Without a PAN or GSTIN, TDS on this supplier is deducted at the higher no-PAN rate.</span>
                </div>
              )}

              {error && <div className="vd-alert"><Icon name="alert" size={14} />{error}</div>}

              <div className="vd-save">
                <Button variant="ghost" onClick={() => { setShowForm(false); resetForm() }}>Cancel</Button>
                <Button type="submit" disabled={saving} icon={saving ? undefined : 'check'}>
                  {saving ? 'Saving…' : editingId ? 'Update vendor' : 'Add vendor'}
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      <style>{`
        .vd-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .vd-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 10px; background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red); }
        .vd-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }

        .vd-row { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1.1fr) 96px minmax(0, 1fr) 116px 176px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .vd-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .vd-right { text-align: right; }
        .vd-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .vd-name-main { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .vd-sub { font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .vd-mono { font-family: var(--mono); font-size: 11.5px; color: var(--ink-2); overflow-wrap: anywhere; }
        .vd-contact { display: flex; flex-direction: column; gap: 2px; color: var(--ink-2); min-width: 0; }
        .vd-dim { opacity: 0.62; }
        .vd-flag { font-size: 10.5px; color: var(--amber); margin-top: 3px; }
        .vd-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }

        .vd-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .vd-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .vd-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 640px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .vd-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .vd-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .vd-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .vd-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .vd-form { display: flex; flex-direction: column; gap: 12px; }
        .vd-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .vd-grid-3 { display: grid; grid-template-columns: 1fr 1.3fr 0.8fr; gap: 12px; }
        .vd-field { display: flex; flex-direction: column; gap: 4px; }
        .vd-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .vd-mono-input { font-family: var(--mono); letter-spacing: 0.03em; }
        .vd-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--ink-2);
          background: var(--amber-soft); border-radius: var(--radius-sm); padding: 10px 12px; }
        .vd-note svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }
        .vd-form > .vd-save { display: flex; gap: 10px; justify-content: flex-end; margin-top: 2px; }

        @media (max-width: 1100px) { .vd-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .vd-row { grid-template-columns: 1fr; gap: 6px; }
          .vd-head { display: none; }
          .vd-right { text-align: left; }
          .vd-actions { justify-content: flex-start; }
          .vd-stats { grid-template-columns: 1fr 1fr; }
          .vd-grid, .vd-grid-3 { grid-template-columns: 1fr; }
          .vd-modal { padding: 1.1rem 1.15rem; }
          .vd-scrim { align-items: flex-end; padding: 0; }
          .vd-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .vd-form > .vd-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function VendorsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <VendorsPageInner />
    </Suspense>
  )
}
