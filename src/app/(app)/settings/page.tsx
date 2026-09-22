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
  color: '#374151', marginBottom: '6px',
}

const sectionTitle = (title: string, subtitle: string) => (
  <div style={{ marginBottom: '1.5rem' }}>
    <h2 style={{ fontSize: '16px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
      {title}
    </h2>
    <p style={{ fontSize: '13px', color: '#64748b' }}>{subtitle}</p>
  </div>
)

export default function SettingsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [orgId, setOrgId] = useState('')
  const [activeTab, setActiveTab] = useState('company')

  const [form, setForm] = useState({
    // Company
    name: '', trade_name: '', pan: '', business_type: '',
    phone: '', email: '', website: '',
    address_line1: '', address_line2: '',
    city: '', state: '', state_code: '', pincode: '',
    // Invoice settings
    invoice_prefix: 'INV',
    invoice_footer: 'Thank You For Your Business!',
    invoice_declaration: '',
    // Bank details
    bank_name: '', bank_branch: '',
    bank_account_number: '', bank_ifsc: '', bank_upi_id: '',
  })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(*)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)

      const org = membership.organizations as any
      if (org) {
        setForm({
          name: org.name || '',
          trade_name: org.trade_name || '',
          pan: org.pan || '',
          business_type: org.business_type || '',
          phone: org.phone || '',
          email: org.email || '',
          website: org.website || '',
          address_line1: org.address_line1 || '',
          address_line2: org.address_line2 || '',
          city: org.city || '',
          state: org.state || '',
          state_code: org.state_code || '',
          pincode: org.pincode || '',
          invoice_prefix: org.invoice_prefix || 'INV',
          invoice_footer: org.invoice_footer || 'Thank You For Your Business!',
          invoice_declaration: org.invoice_declaration || '',
          bank_name: org.bank_name || '',
          bank_branch: org.bank_branch || '',
          bank_account_number: org.bank_account_number || '',
          bank_ifsc: org.bank_ifsc || '',
          bank_upi_id: org.bank_upi_id || '',
        })
      }
      setLoading(false)
    }
    load()
  }, [])

  async function handleSave() {
    setSaving(true)
    setSaved(false)

    try {
      const { error } = await supabase
        .from('organizations')
        .update({
          name: form.name,
          trade_name: form.trade_name,
          pan: form.pan,
          business_type: form.business_type,
          phone: form.phone,
          email: form.email,
          website: form.website,
          address_line1: form.address_line1,
          address_line2: form.address_line2,
          city: form.city,
          state: form.state,
          state_code: form.state_code,
          pincode: form.pincode,
          invoice_prefix: form.invoice_prefix,
          invoice_footer: form.invoice_footer,
          invoice_declaration: form.invoice_declaration,
          bank_name: form.bank_name,
          bank_branch: form.bank_branch,
          bank_account_number: form.bank_account_number,
          bank_ifsc: form.bank_ifsc,
          bank_upi_id: form.bank_upi_id,
          updated_at: new Date().toISOString(),
        })
        .eq('id', orgId)

      if (error) throw error
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      alert('Failed to save: ' + err.message)
    } finally {
      setSaving(false)
    }
  }

  const tabStyle = (key: string) => ({
    padding: '9px 20px', background: 'none', border: 'none',
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
    <div style={{ padding: '2rem', maxWidth: '800px' }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1.5rem'
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            Settings
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            Manage your business profile and invoice settings
          </p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '9px 24px',
            background: saved ? '#059669' : saving ? '#93c5fd' : '#2563eb',
            color: 'white', border: 'none', borderRadius: '8px',
            fontSize: '14px', fontWeight: '600',
            cursor: saving ? 'not-allowed' : 'pointer',
            transition: 'background 0.2s'
          }}
        >
          {saved ? '✓ Saved!' : saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: '1px solid #e2e8f0', marginBottom: '1.5rem', display: 'flex', gap: '4px' }}>
        <button style={tabStyle('company')} onClick={() => setActiveTab('company')}>
          🏢 Company
        </button>
        <button style={tabStyle('invoice')} onClick={() => setActiveTab('invoice')}>
          🧾 Invoice
        </button>
        <button style={tabStyle('bank')} onClick={() => setActiveTab('bank')}>
          🏦 Bank Details
        </button>
      </div>

      {/* COMPANY TAB */}
      {activeTab === 'company' && (
        <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
          {sectionTitle('Company Information', 'This appears on all your invoices and documents')}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={labelStyle}>Legal Business Name *</label>
              <input style={inputStyle} value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="ABC Traders Pvt Ltd" />
            </div>
            <div>
              <label style={labelStyle}>Trade Name</label>
              <input style={inputStyle} value={form.trade_name}
                onChange={e => setForm(p => ({ ...p, trade_name: e.target.value }))}
                placeholder="ABC Traders (if different)" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={labelStyle}>PAN</label>
              <input style={inputStyle} value={form.pan}
                onChange={e => setForm(p => ({ ...p, pan: e.target.value.toUpperCase() }))}
                placeholder="AABCU9603R" maxLength={10} />
            </div>
            <div>
              <label style={labelStyle}>Business Type</label>
              <select style={{ ...inputStyle, cursor: 'pointer' }} value={form.business_type}
                onChange={e => setForm(p => ({ ...p, business_type: e.target.value }))}>
                <option value="">Select type...</option>
                {['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'OPC', 'Other'].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Address Line 1</label>
            <input style={inputStyle} value={form.address_line1}
              onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))}
              placeholder="Shop No / Building / Street" />
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Address Line 2</label>
            <input style={inputStyle} value={form.address_line2}
              onChange={e => setForm(p => ({ ...p, address_line2: e.target.value }))}
              placeholder="Area / Locality" />
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
              <input style={inputStyle} value={form.state}
                onChange={e => setForm(p => ({ ...p, state: e.target.value }))}
                placeholder="Maharashtra" />
            </div>
            <div>
              <label style={labelStyle}>Pincode</label>
              <input style={inputStyle} value={form.pincode}
                onChange={e => setForm(p => ({ ...p, pincode: e.target.value }))}
                placeholder="400001" maxLength={6} />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div>
              <label style={labelStyle}>Phone</label>
              <input style={inputStyle} value={form.phone}
                onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
                placeholder="+91 98765 43210" />
            </div>
            <div>
              <label style={labelStyle}>Email</label>
              <input style={inputStyle} value={form.email}
                onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                placeholder="accounts@business.com" />
            </div>
          </div>
        </div>
      )}

      {/* INVOICE TAB */}
      {activeTab === 'invoice' && (
        <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
          {sectionTitle('Invoice Settings', 'Customize how your invoices look and are numbered')}

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Invoice Number Prefix</label>
            <input style={{ ...inputStyle, maxWidth: '200px' }}
              value={form.invoice_prefix}
              onChange={e => setForm(p => ({ ...p, invoice_prefix: e.target.value.toUpperCase() }))}
              placeholder="INV" maxLength={10} />
            <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
              Your invoices will be numbered: <strong>{form.invoice_prefix || 'INV'}-2026-27-0001</strong>
            </p>
            <p style={{ fontSize: '12px', color: '#dc2626', marginTop: '4px' }}>
              ⚠️ Changing this prefix only affects new invoices. Existing invoices keep their numbers.
            </p>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Invoice Footer Message</label>
            <input style={inputStyle}
              value={form.invoice_footer}
              onChange={e => setForm(p => ({ ...p, invoice_footer: e.target.value }))}
              placeholder="Thank You For Your Business!" />
            <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
              Shown at the bottom of every invoice
            </p>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>Declaration / Terms (shown on invoice)</label>
            <textarea
              style={{ ...inputStyle, height: '100px', resize: 'vertical' as const }}
              value={form.invoice_declaration}
              onChange={e => setForm(p => ({ ...p, invoice_declaration: e.target.value }))}
              placeholder={`1. Subject to local jurisdiction.\n2. Terms & conditions are subject to our trade policy.\n3. E. & O.E.`}
            />
            <p style={{ fontSize: '12px', color: '#64748b', marginTop: '6px' }}>
              Legal declarations shown at the bottom of your invoices
            </p>
          </div>

          {/* Preview */}
          <div style={{
            background: '#f8fafc', border: '1px solid #e2e8f0',
            borderRadius: '8px', padding: '1rem', marginTop: '1rem'
          }}>
            <div style={{ fontSize: '12px', fontWeight: '600', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' as const }}>
              Preview
            </div>
            <div style={{ fontSize: '13px', color: '#374151' }}>
              <div style={{ fontWeight: '600', marginBottom: '4px' }}>Declaration</div>
              {form.invoice_declaration
                ? form.invoice_declaration.split('\n').map((line, i) => (
                    <div key={i}>{line}</div>
                  ))
                : <div style={{ color: '#94a3b8' }}>No declaration set</div>
              }
              <div style={{ marginTop: '12px', textAlign: 'center' as const, fontStyle: 'italic', color: '#64748b' }}>
                {form.invoice_footer}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* BANK TAB */}
      {activeTab === 'bank' && (
        <div style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '1.5rem' }}>
          {sectionTitle('Bank Details', 'These appear on your invoices so customers can make payments')}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={labelStyle}>Bank Name</label>
              <input style={inputStyle} value={form.bank_name}
                onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))}
                placeholder="State Bank of India" />
            </div>
            <div>
              <label style={labelStyle}>Branch</label>
              <input style={inputStyle} value={form.bank_branch}
                onChange={e => setForm(p => ({ ...p, bank_branch: e.target.value }))}
                placeholder="Mumbai Main Branch" />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={labelStyle}>Account Number</label>
              <input style={inputStyle} value={form.bank_account_number}
                onChange={e => setForm(p => ({ ...p, bank_account_number: e.target.value }))}
                placeholder="20412XXXX05" />
            </div>
            <div>
              <label style={labelStyle}>IFSC Code</label>
              <input style={inputStyle} value={form.bank_ifsc}
                onChange={e => setForm(p => ({ ...p, bank_ifsc: e.target.value.toUpperCase() }))}
                placeholder="SBIN0003XXXX" />
            </div>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={labelStyle}>UPI ID</label>
            <input style={inputStyle} value={form.bank_upi_id}
              onChange={e => setForm(p => ({ ...p, bank_upi_id: e.target.value }))}
              placeholder="yourid@upi" />
          </div>

          {/* Bank details preview */}
          {(form.bank_name || form.bank_account_number) && (
            <div style={{
              background: '#f8fafc', border: '1px solid #e2e8f0',
              borderRadius: '8px', padding: '1rem', marginTop: '1rem'
            }}>
              <div style={{ fontSize: '12px', fontWeight: '600', color: '#94a3b8', marginBottom: '8px', textTransform: 'uppercase' as const }}>
                Preview on invoice
              </div>
              <div style={{ fontSize: '13px', color: '#374151' }}>
                <div style={{ fontWeight: '600', marginBottom: '6px' }}>Our Bank Details</div>
                {form.bank_name && <div>Bank Name: <strong>{form.bank_name}</strong></div>}
                {form.bank_branch && <div>Branch: <strong>{form.bank_branch}</strong></div>}
                {form.bank_account_number && <div>Account No: <strong>{form.bank_account_number}</strong></div>}
                {form.bank_ifsc && <div>IFSC Code: <strong>{form.bank_ifsc}</strong></div>}
                {form.bank_upi_id && <div>UPI ID: <strong>{form.bank_upi_id}</strong></div>}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}