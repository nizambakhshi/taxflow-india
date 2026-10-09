'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { Button, Card, PageHeader, SectionTitle, Segmented } from '@/components/ui'
import Icon from '@/components/Icons'

const TAB_OPTIONS = [
  { value: 'company', label: 'Company' },
  { value: 'logo', label: 'Logo' },
  { value: 'invoice', label: 'Invoice' },
  { value: 'bank', label: 'Bank details' },
]

export default function SettingsPage() {
  const supabase = createClient()
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [orgId, setOrgId] = useState('')
  const [activeTab, setActiveTab] = useState('company')
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [logoPreview, setLogoPreview] = useState<string>('')

  const [form, setForm] = useState({
    name: '', trade_name: '', pan: '', business_type: '',
    phone: '', email: '', website: '',
    address_line1: '', address_line2: '',
    city: '', state: '', state_code: '', pincode: '',
    logo_url: '',
    invoice_prefix: 'INV',
    invoice_footer: 'Thank You For Your Business!',
    invoice_declaration: '',
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
          logo_url: org.logo_url || '',
          invoice_prefix: org.invoice_prefix || 'INV',
          invoice_footer: org.invoice_footer || 'Thank You For Your Business!',
          invoice_declaration: org.invoice_declaration || '',
          bank_name: org.bank_name || '',
          bank_branch: org.bank_branch || '',
          bank_account_number: org.bank_account_number || '',
          bank_ifsc: org.bank_ifsc || '',
          bank_upi_id: org.bank_upi_id || '',
        })
        if (org.logo_url) setLogoPreview(org.logo_url)
      }
      setLoading(false)
    }
    load()
  }, [])

  async function handleLogoUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    if (file.size > 2 * 1024 * 1024) {
      alert('Logo must be under 2MB')
      return
    }

    setUploadingLogo(true)
    try {
      const ext = file.name.split('.').pop()
      const fileName = `${orgId}-logo.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('logos')
        .upload(fileName, file, { upsert: true })

      if (uploadError) throw uploadError

      const { data: urlData } = supabase.storage
        .from('logos')
        .getPublicUrl(fileName)

      const logoUrl = urlData.publicUrl
      setLogoPreview(logoUrl)
      setForm(p => ({ ...p, logo_url: logoUrl }))

      // Save immediately
      await supabase
        .from('organizations')
        .update({ logo_url: logoUrl })
        .eq('id', orgId)

      alert('Logo uploaded successfully!')
    } catch (err: any) {
      alert('Logo upload failed: ' + err.message)
    } finally {
      setUploadingLogo(false)
    }
  }

  async function handleRemoveLogo() {
    setLogoPreview('')
    setForm(p => ({ ...p, logo_url: '' }))
    await supabase
      .from('organizations')
      .update({ logo_url: '' })
      .eq('id', orgId)
  }

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
          logo_url: form.logo_url,
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

  if (loading) return (
    <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
      Loading your business profile…
    </div>
  )

  return (
    <div className="page-container st" style={{ maxWidth: 860 }}>
      <PageHeader
        eyebrow="Workspace"
        title="Settings"
        subtitle="Manage your business profile and invoice settings"
        actions={
          <Button
            onClick={handleSave}
            disabled={saving}
            icon={saved ? 'check' : undefined}
          >
            {saved ? 'Saved' : saving ? 'Saving…' : 'Save changes'}
          </Button>
        }
      />

      <div style={{ marginBottom: '1rem' }}>
        <Segmented options={TAB_OPTIONS} value={activeTab} onChange={setActiveTab} />
      </div>

      {/* COMPANY TAB */}
      {activeTab === 'company' && (
        <>
        <Card>
          <SectionTitle icon="building">Company information</SectionTitle>
          <p className="st-sub">This appears on all your invoices and documents</p>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <label className="st-field">
              <span>Legal business name *</span>
              <input className="tf-input" value={form.name}
                onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                placeholder="ABC Traders Pvt Ltd" />
            </label>
            <label className="st-field">
              <span>Trade name</span>
              <input className="tf-input" value={form.trade_name}
                onChange={e => setForm(p => ({ ...p, trade_name: e.target.value }))}
                placeholder="ABC Traders" />
            </label>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <label className="st-field">
              <span>PAN</span>
              <input className="tf-input" value={form.pan}
                onChange={e => setForm(p => ({ ...p, pan: e.target.value.toUpperCase() }))}
                placeholder="AABCU9603R" maxLength={10} />
            </label>
            <label className="st-field">
              <span>Business type</span>
              <select className="tf-input" style={{ cursor: 'pointer' }} value={form.business_type}
                onChange={e => setForm(p => ({ ...p, business_type: e.target.value }))}>
                <option value="">Select type...</option>
                {['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'OPC', 'Other'].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>Address line 1</span>
              <input className="tf-input" value={form.address_line1}
                onChange={e => setForm(p => ({ ...p, address_line1: e.target.value }))}
                placeholder="Shop No / Building / Street" />
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>Address line 2</span>
              <input className="tf-input" value={form.address_line2}
                onChange={e => setForm(p => ({ ...p, address_line2: e.target.value }))}
                placeholder="Area / Locality" />
            </label>
          </div>

          <div className="form-grid-3" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
            <label className="st-field">
              <span>City</span>
              <input className="tf-input" value={form.city}
                onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                placeholder="Mumbai" />
            </label>
            <label className="st-field">
              <span>State</span>
              <input className="tf-input" value={form.state}
                onChange={e => setForm(p => ({ ...p, state: e.target.value }))}
                placeholder="Maharashtra" />
            </label>
            <label className="st-field">
              <span>Pincode</span>
              <input className="tf-input" value={form.pincode}
                onChange={e => setForm(p => ({ ...p, pincode: e.target.value }))}
                placeholder="400001" maxLength={6} />
            </label>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label className="st-field">
              <span>Phone</span>
              <input className="tf-input" value={form.phone}
                onChange={e => setForm(p => ({ ...p, phone: e.target.value }))}
                placeholder="+91 98765 43210" />
            </label>
            <label className="st-field">
              <span>Email</span>
              <input className="tf-input" value={form.email}
                onChange={e => setForm(p => ({ ...p, email: e.target.value }))}
                placeholder="accounts@business.com" />
            </label>
          </div>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <SectionTitle icon="tally">Your books and Tally</SectionTitle>
          <p className="st-sub">
            The <Link href="/tally">Tally bridge</Link> works in both directions. A Tally export is read into a plan —
            one row per ledger, stock item and voucher, each saying what it becomes here and which name it is missing —
            and only the rows you pick are written. Chosen invoices and bills go the other way as the XML TallyPrime
            imports, keeping these invoice numbers so the two books tie back.
          </p>
          <p className="st-sub">
            An import never writes money: a receipt inside a voucher is reported and the document lands unpaid, because
            <Link href="/payments" style={{ color: 'var(--brand)', textDecoration: 'none', margin: '0 3px' }}>/payments</Link>
            stays the only writer of money here.
          </p>
        </Card>

        <Card style={{ marginTop: 12 }}>
          <SectionTitle icon="shield">Your registers and this browser</SectionTitle>
          <p className="st-sub">
            Invoices, bills, customers and products are rows in the database and come back with the login. The registers
            — batches, serial numbers, godowns, LUTs, cost-centre splits, job-work lots, workpaper figures, targets,
            reorder lead times, this page&apos;s own settings — are kept on the device (ADR-013), which is what lets them
            work offline and what makes them vulnerable to a cleared browser or a new laptop.
          </p>
          <p className="st-sub">
            <Link href="/vault" style={{ color: 'var(--brand)', textDecoration: 'none', margin: '0 3px' }}>The books vault</Link>
            writes all of them into one readable file and puts them back through the pages that own them, so a restore is
            proved by what those pages can read rather than by a write that returned no error.
          </p>
        </Card>
        </>
      )}

      {/* LOGO TAB */}
      {activeTab === 'logo' && (
        <Card>
          <SectionTitle icon="upload">Company logo</SectionTitle>
          <p className="st-sub">Your logo appears on all invoices, quotations and documents. PNG or JPG, max 2MB.</p>

          {/* Current logo */}
          {logoPreview ? (
            <div className="st-logo-box">
              <img src={logoPreview} alt="Company logo" className="st-logo-img" />
              <div>
                <div className="st-logo-status">
                  Logo uploaded <Icon name="check" size={14} />
                </div>
                <div className="st-logo-hint">This logo will appear on your invoices</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <Button size="sm" onClick={() => fileInputRef.current?.click()}>
                    Change logo
                  </Button>
                  <Button size="sm" variant="danger" onClick={handleRemoveLogo}>
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="st-drop" onClick={() => fileInputRef.current?.click()}>
              <span className="st-drop-chip"><Icon name="upload" size={22} /></span>
              <div className="st-drop-title">Click to upload your logo</div>
              <div className="st-drop-sub">PNG, JPG or SVG — max 2MB — recommended 200×200px</div>
              {uploadingLogo && <div className="st-uploading">Uploading…</div>}
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/jpg,image/svg+xml"
            onChange={handleLogoUpload}
            style={{ display: 'none' }}
          />

          {/* Preview how it looks on invoice */}
          <div className="st-tip">
            <Icon name="sparkles" size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              <strong>Tip:</strong> Use a white or transparent background logo for best results on
              invoices. Recommended size: 200×80px (landscape).
            </span>
          </div>
        </Card>
      )}

      {/* INVOICE TAB */}
      {activeTab === 'invoice' && (
        <Card>
          <SectionTitle icon="invoice">Invoice settings</SectionTitle>
          <p className="st-sub">Customize how your invoices look and are numbered</p>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>Invoice number prefix</span>
              <input className="tf-input" style={{ maxWidth: 200 }}
                value={form.invoice_prefix}
                onChange={e => setForm(p => ({ ...p, invoice_prefix: e.target.value.toUpperCase() }))}
                placeholder="INV" maxLength={10} />
            </label>
            <p className="st-hint">
              Your invoices will be numbered:{' '}
              <strong>{form.invoice_prefix || 'INV'}-2026-27-0001</strong>
            </p>
            <p className="st-warn">
              <Icon name="alert" size={13} /> Changing this only affects new invoices.
            </p>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>Invoice footer message</span>
              <input className="tf-input"
                value={form.invoice_footer}
                onChange={e => setForm(p => ({ ...p, invoice_footer: e.target.value }))}
                placeholder="Thank You For Your Business!" />
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>Declaration / terms (shown on invoice)</span>
              <textarea
                className="tf-input"
                style={{ minHeight: 100, resize: 'vertical' }}
                value={form.invoice_declaration}
                onChange={e => setForm(p => ({ ...p, invoice_declaration: e.target.value }))}
                placeholder={`1. Subject to local jurisdiction.\n2. Terms & conditions subject to trade policy.\n3. E. & O.E.`}
              />
            </label>
          </div>

          {/* Preview */}
          <div className="st-preview">
            <div className="st-preview-label">Preview</div>
            <div className="st-preview-body">
              {form.invoice_declaration
                ? form.invoice_declaration.split('\n').map((line, i) => (
                    <div key={i}>{line}</div>
                  ))
                : <div style={{ color: 'var(--faint)' }}>No declaration set</div>
              }
              <div className="st-preview-foot">{form.invoice_footer}</div>
            </div>
          </div>
        </Card>
      )}

      {/* BANK TAB */}
      {activeTab === 'bank' && (
        <Card>
          <SectionTitle icon="landmark">Bank details</SectionTitle>
          <p className="st-sub">These appear on your invoices so customers can make payments</p>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <label className="st-field">
              <span>Bank name</span>
              <input className="tf-input" value={form.bank_name}
                onChange={e => setForm(p => ({ ...p, bank_name: e.target.value }))}
                placeholder="State Bank of India" />
            </label>
            <label className="st-field">
              <span>Branch</span>
              <input className="tf-input" value={form.bank_branch}
                onChange={e => setForm(p => ({ ...p, bank_branch: e.target.value }))}
                placeholder="Mumbai Main Branch" />
            </label>
          </div>

          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <label className="st-field">
              <span>Account number</span>
              <input className="tf-input" value={form.bank_account_number}
                onChange={e => setForm(p => ({ ...p, bank_account_number: e.target.value }))}
                placeholder="20412XXXX05" />
            </label>
            <label className="st-field">
              <span>IFSC code</span>
              <input className="tf-input" value={form.bank_ifsc}
                onChange={e => setForm(p => ({ ...p, bank_ifsc: e.target.value.toUpperCase() }))}
                placeholder="SBIN0003XXXX" />
            </label>
          </div>

          <div style={{ marginBottom: 12 }}>
            <label className="st-field">
              <span>UPI ID</span>
              <input className="tf-input" value={form.bank_upi_id}
                onChange={e => setForm(p => ({ ...p, bank_upi_id: e.target.value }))}
                placeholder="yourid@upi" />
            </label>
          </div>

          {(form.bank_name || form.bank_account_number) && (
            <div className="st-preview">
              <div className="st-preview-label">Preview on invoice</div>
              <div className="st-preview-body">
                <div style={{ fontWeight: 600, marginBottom: 6 }}>Our Bank Details</div>
                {form.bank_name && <div>Bank Name: <strong>{form.bank_name}</strong></div>}
                {form.bank_branch && <div>Branch: <strong>{form.bank_branch}</strong></div>}
                {form.bank_account_number && <div>Account No: <strong>{form.bank_account_number}</strong></div>}
                {form.bank_ifsc && <div>IFSC Code: <strong>{form.bank_ifsc}</strong></div>}
                {form.bank_upi_id && <div>UPI ID: <strong>{form.bank_upi_id}</strong></div>}
              </div>
            </div>
          )}
        </Card>
      )}

      <style>{`
        .st-sub { font-size: 13px; color: var(--muted); margin: -4px 0 1.25rem; }
        .st-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .st-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .st-hint { font-size: 12px; color: var(--muted); margin: 6px 0 0; }
        .st-warn { display: flex; align-items: center; gap: 6px; font-size: 12px;
          color: var(--red); margin: 4px 0 0; }

        .st-logo-box { background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius); padding: 1.25rem; display: flex; align-items: center;
          gap: 1.25rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
        .st-logo-img { width: 120px; height: 80px; object-fit: contain; border-radius: var(--radius-sm);
          border: 1px solid var(--line); background: white; padding: 8px; }
        .st-logo-status { display: flex; align-items: center; gap: 6px; font-weight: 600;
          color: var(--ink); margin-bottom: 4px; }
        .st-logo-status svg { color: var(--green); }
        .st-logo-hint { font-size: 12.5px; color: var(--muted); margin-bottom: 12px; }

        .st-drop { border: 2px dashed var(--line); border-radius: var(--radius); padding: 2.5rem 1rem;
          text-align: center; cursor: pointer; margin-bottom: 1.25rem; background: var(--surface-2);
          transition: border-color 0.15s, background 0.15s; }
        .st-drop:hover { border-color: var(--brand); background: var(--brand-soft); }
        .st-drop-chip { display: inline-flex; align-items: center; justify-content: center;
          width: 46px; height: 46px; border-radius: 999px; background: var(--slate-soft);
          color: var(--faint); margin-bottom: 12px; }
        .st-drop-title { font-weight: 600; color: var(--ink-2); margin-bottom: 4px; }
        .st-drop-sub { font-size: 12.5px; color: var(--muted); }
        .st-uploading { margin-top: 1rem; color: var(--brand); font-size: 13px; }

        .st-tip { display: flex; gap: 8px; background: var(--cyan-soft); color: var(--cyan);
          border-radius: var(--radius-sm); padding: 10px 14px; font-size: 12px; line-height: 1.5; }

        .st-preview { background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius-sm); padding: 1rem; }
        .st-preview-label { font-size: 11px; font-weight: 700; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 8px; }
        .st-preview-body { font-size: 12.5px; color: var(--ink-2); }
        .st-preview-foot { margin-top: 8px; text-align: center; font-style: italic; color: var(--muted); }

        @media (max-width: 768px) {
          .st-logo-box { gap: 1rem; }
        }
      `}</style>
    </div>
  )
}
