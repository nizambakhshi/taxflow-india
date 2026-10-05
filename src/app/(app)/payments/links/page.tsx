'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  buildUpiDeepLink, buildWhatsAppLink, renderReminder,
  loadUpiSettings, saveUpiSettings, validateVpa,
  DEFAULT_REMINDER_TEMPLATES, PLACEHOLDER_HELP,
  type UpiSettings,
} from '@/lib/payments'

const inputStyle = {
  width: '100%', padding: '9px 11px',
  border: '1px solid #d1d5db', borderRadius: '8px',
  fontSize: '13px', outline: 'none', color: '#1e293b', background: 'white',
}
const labelStyle = {
  display: 'block' as const, fontSize: '12px',
  fontWeight: '500' as const, color: '#374151', marginBottom: '4px',
}

interface Row {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  phone: string
  amountDue: number
  dueDate: string
  overdue: boolean
}

export default function PaymentLinksPage() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')

  const [settings, setSettings] = useState<UpiSettings>({
    vpa: '', payeeName: '', templateKey: 'standard',
  })
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)

  // Reminder modal
  const [reminderFor, setReminderFor] = useState<Row | null>(null)
  const [reminderText, setReminderText] = useState('')
  const [reminderPayLink, setReminderPayLink] = useState('')
  const [reminderError, setReminderError] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      const org = membership.organizations as any
      const name = org?.name || ''
      setOrgId(membership.organization_id)
      setOrgName(name)

      const loaded = loadUpiSettings(membership.organization_id)
      // Default the payee name to the business name on first use.
      if (!loaded.payeeName) loaded.payeeName = name
      setSettings(loaded)
      // First-time users need to enter their VPA before links work.
      setShowSettings(validateVpa(loaded.vpa) !== null)

      await loadInvoices(membership.organization_id)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadInvoices(oid: string) {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, customer_id, customer_name, balance_due, due_date, invoice_date')
      .eq('organization_id', oid)
      .in('payment_status', ['unpaid', 'partial'])
      .neq('status', 'cancelled')
      .order('due_date', { ascending: true })

    const custIds = Array.from(new Set((invoices || []).map(i => i.customer_id).filter(Boolean)))
    let phoneById: Record<string, string> = {}
    if (custIds.length) {
      const { data: customers } = await supabase
        .from('customers')
        .select('id, phone')
        .in('id', custIds)
      phoneById = Object.fromEntries((customers || []).map(c => [c.id, c.phone || '']))
    }

    const today = new Date(); today.setHours(0, 0, 0, 0)
    const mapped: Row[] = (invoices || []).map(inv => {
      const due = inv.due_date || inv.invoice_date
      const overdue = due ? new Date(due) < today : false
      return {
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        customerName: inv.customer_name || 'Customer',
        phone: phoneById[inv.customer_id] || '',
        amountDue: Number(inv.balance_due) || 0,
        dueDate: due || '',
        overdue,
      }
    })
    setRows(mapped)
  }

  function persist(next: UpiSettings) {
    setSettings(next)
    setSettingsSaved(false)
  }
  function saveSettings() {
    saveUpiSettings(orgId, settings)
    setSettingsSaved(true)
    setTimeout(() => setSettingsSaved(false), 2000)
  }

  function payLinkFor(row: Row): { link: string; error: string | null } {
    return buildUpiDeepLink({
      vpa: settings.vpa,
      payeeName: settings.payeeName || orgName,
      amount: row.amountDue,
      transactionRef: row.invoiceNumber,
      note: `Invoice ${row.invoiceNumber}`,
    })
  }

  function openReminder(row: Row) {
    const { link, error } = payLinkFor(row)
    if (error) {
      setReminderError('')
      setShowSettings(true)
      setReminderFor(null)
      alert(`Set a valid UPI ID first — ${error}`)
      return
    }
    const tpl = DEFAULT_REMINDER_TEMPLATES.find(t => t.key === settings.templateKey)
      || DEFAULT_REMINDER_TEMPLATES[1]
    const text = renderReminder(tpl.body, {
      customer: row.customerName,
      businessName: orgName,
      invoiceNumber: row.invoiceNumber,
      amount: formatINR(row.amountDue),
      dueDate: row.dueDate ? new Date(row.dueDate).toLocaleDateString('en-IN') : '—',
      payLink: link,
    })
    setReminderPayLink(link)
    setReminderText(text)
    setReminderError('')
    setReminderFor(row)
  }

  function swapTemplate(key: string) {
    const tpl = DEFAULT_REMINDER_TEMPLATES.find(t => t.key === key)
    if (!tpl || !reminderFor) return
    persist({ ...settings, templateKey: key })
    setReminderText(renderReminder(tpl.body, {
      customer: reminderFor.customerName,
      businessName: orgName,
      invoiceNumber: reminderFor.invoiceNumber,
      amount: formatINR(reminderFor.amountDue),
      dueDate: reminderFor.dueDate ? new Date(reminderFor.dueDate).toLocaleDateString('en-IN') : '—',
      payLink: reminderPayLink,
    }))
  }

  async function copyText(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      setTimeout(() => setCopied(''), 1500)
    } catch { /* clipboard blocked — user can select manually */ }
  }

  function sendWhatsApp() {
    if (!reminderFor) return
    const { link, error } = buildWhatsAppLink(reminderFor.phone, reminderText)
    if (error) { setReminderError(error); return }
    window.open(link, '_blank', 'noopener,noreferrer')
  }

  const ready = useMemo(() => validateVpa(settings.vpa) === null, [settings.vpa])

  const filtered = rows.filter(r =>
    !search ||
    r.invoiceNumber.toLowerCase().includes(search.toLowerCase()) ||
    r.customerName.toLowerCase().includes(search.toLowerCase())
  )

  const overdueCount = rows.filter(r => r.overdue).length

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  return (
    <div className="page-container" style={{ maxWidth: '1200px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginBottom: '1rem', gap: '10px',
      }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b', marginBottom: '2px' }}>
            Payment Links & Reminders
          </h1>
          <p style={{ fontSize: '13px', color: '#64748b' }}>
            {rows.length} open · {overdueCount} overdue
          </p>
        </div>
        <button onClick={() => setShowSettings(s => !s)} style={{
          padding: '9px 16px', background: ready ? 'white' : '#2563eb',
          color: ready ? '#374151' : 'white',
          border: '1px solid ' + (ready ? '#e2e8f0' : '#2563eb'),
          borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
        }}>
          {ready ? '⚙️ UPI Settings' : '🔗 Set up UPI ID'}
        </button>
      </div>

      {/* UPI settings panel */}
      {showSettings && (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.25rem', marginBottom: '1.25rem',
        }}>
          <div style={{ fontSize: '13px', fontWeight: '600', color: '#374151', marginBottom: '12px' }}>
            Your UPI receiving details
          </div>
          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>UPI ID / VPA</label>
              <input style={inputStyle} placeholder="business@okhdfcbank"
                value={settings.vpa} onChange={e => persist({ ...settings, vpa: e.target.value })} />
            </div>
            <div>
              <label style={labelStyle}>Payee name (shown to customer)</label>
              <input style={inputStyle} placeholder={orgName}
                value={settings.payeeName} onChange={e => persist({ ...settings, payeeName: e.target.value })} />
            </div>
          </div>
          <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
            <div>
              <label style={labelStyle}>Default reminder tone</label>
              <select style={inputStyle} value={settings.templateKey}
                onChange={e => persist({ ...settings, templateKey: e.target.value })}>
                {DEFAULT_REMINDER_TEMPLATES.map(t => (
                  <option key={t.key} value={t.key}>{t.label}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
              <button onClick={saveSettings} style={{
                padding: '9px 16px', background: '#2563eb', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
              }}>
                {settingsSaved ? 'Saved ✓' : 'Save settings'}
              </button>
            </div>
          </div>
          <p style={{ fontSize: '11px', color: '#94a3b8' }}>
            Stored only in this browser for your organization. The UPI link opens the customer’s
            any UPI app (GPay / PhonePe / Paytm) with the amount pre-filled. Nothing is charged here.
          </p>
        </div>
      )}

      {/* Missing VPA warning */}
      {!ready && (
        <div style={{
          background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '10px',
          padding: '12px 14px', marginBottom: '1rem', fontSize: '13px', color: '#991b1b',
        }}>
          Add your UPI ID to start generating payment links.
        </div>
      )}

      {/* Search */}
      <div style={{ marginBottom: '1rem' }}>
        <input style={{ ...inputStyle, maxWidth: '360px' }}
          placeholder="Search invoice or customer..."
          value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '3rem', textAlign: 'center',
        }}>
          <div style={{ fontSize: '40px', marginBottom: '0.75rem' }}>💳</div>
          <div style={{ fontSize: '15px', fontWeight: '500', color: '#64748b' }}>
            No open invoices to chase
          </div>
        </div>
      ) : (
        <div className="responsive-table table-frame">
          <div className="table-header" style={{
            display: 'grid', gridTemplateColumns: '1.6fr 2fr 1fr 1fr 1.6fr',
            gap: '12px', padding: '10px 16px', background: '#f8fafc',
            fontSize: '12px', fontWeight: '600', color: '#64748b',
            borderBottom: '1px solid #e2e8f0',
          }}>
            <span>Invoice</span><span>Customer</span><span>Amount</span>
            <span>Due</span><span>Actions</span>
          </div>
          {filtered.map(r => (
            <div key={r.invoiceId} className="table-row" style={{
              display: 'grid', gridTemplateColumns: '1.6fr 2fr 1fr 1fr 1.6fr',
              gap: '12px', padding: '12px 16px',
              borderBottom: '1px solid #f1f5f9', alignItems: 'center', fontSize: '13px',
            }}>
              <div data-label="Invoice" style={{ fontWeight: '600', color: '#2563eb' }}>{r.invoiceNumber}</div>
              <div data-label="Customer">
                <div style={{ color: '#1e293b' }}>{r.customerName}</div>
                <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                  {r.phone ? r.phone : 'no phone on file'}
                </div>
              </div>
              <div data-label="Amount" style={{ fontWeight: '600' }}>₹{formatINR(r.amountDue)}</div>
              <div data-label="Due">
                <span style={{ color: r.overdue ? '#dc2626' : '#64748b' }}>
                  {r.dueDate ? new Date(r.dueDate).toLocaleDateString('en-IN') : '—'}
                </span>
                {r.overdue && (
                  <span style={{
                    marginLeft: '6px', fontSize: '10px', padding: '1px 6px',
                    borderRadius: '99px', background: '#fef2f2', color: '#dc2626', fontWeight: '600',
                  }}>overdue</span>
                )}
              </div>
              <div data-label="Actions">
                <div className="btn-group" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  <button onClick={() => openReminder(r)} disabled={!ready} style={{
                    padding: '6px 12px', background: ready ? '#2563eb' : '#e2e8f0',
                    color: ready ? 'white' : '#94a3b8', border: 'none', borderRadius: '6px',
                    fontSize: '12px', fontWeight: '600', cursor: ready ? 'pointer' : 'not-allowed',
                    width: '100%',
                  }}>
                    💬 Remind
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '1rem' }}>
        {PLACEHOLDER_HELP}
      </p>

      {/* Reminder modal */}
      {reminderFor && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '1rem', zIndex: 50,
        }} onClick={() => setReminderFor(null)}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px', width: '100%', maxWidth: '600px',
            maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <div style={{ fontSize: '16px', fontWeight: '700', color: '#1e293b' }}>
                  Payment reminder
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                  {reminderFor.invoiceNumber} · ₹{formatINR(reminderFor.amountDue)} · {reminderFor.customerName}
                </div>
              </div>
              <button onClick={() => setReminderFor(null)} style={{
                background: 'none', border: 'none', fontSize: '20px', color: '#94a3b8', cursor: 'pointer',
              }}>×</button>
            </div>

            {/* Template picker */}
            <div style={{ display: 'flex', gap: '6px', marginBottom: '12px' }} className="tab-bar">
              {DEFAULT_REMINDER_TEMPLATES.map(t => (
                <button key={t.key} onClick={() => swapTemplate(t.key)} style={{
                  padding: '5px 12px', whiteSpace: 'nowrap', borderRadius: '99px', fontSize: '12px', cursor: 'pointer',
                  background: settings.templateKey === t.key ? '#2563eb' : 'white',
                  color: settings.templateKey === t.key ? 'white' : '#374151',
                  border: '1px solid #e2e8f0', fontWeight: '500',
                }}>{t.label}</button>
              ))}
            </div>

            {/* Pay link */}
            <label style={labelStyle}>UPI payment link</label>
            <div style={{
              display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '12px',
            }}>
              <input readOnly value={reminderPayLink} style={{ ...inputStyle, color: '#475569', background: '#f8fafc' }} />
              <button onClick={() => copyText('paylink', reminderPayLink)} style={{
                padding: '9px 14px', background: '#0f172a', color: 'white', border: 'none',
                borderRadius: '8px', fontSize: '12px', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap',
              }}>{copied === 'paylink' ? 'Copied ✓' : 'Copy'}</button>
            </div>

            {/* Message */}
            <label style={labelStyle}>Message ({PLACEHOLDER_HELP})</label>
            <textarea value={reminderText} onChange={e => setReminderText(e.target.value)}
              rows={7} style={{
                ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5,
              }} />

            {reminderError && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px',
                padding: '10px 12px', marginTop: '10px', fontSize: '12px', color: '#991b1b',
              }}>{reminderError}</div>
            )}

            {!reminderFor.phone && (
              <div style={{
                background: '#fef9c3', border: '1px solid #fde68a', borderRadius: '8px',
                padding: '10px 12px', marginTop: '10px', fontSize: '12px', color: '#854d0e',
              }}>No phone number on file for this customer — you can still copy the link below.</div>
            )}

            {/* Actions */}
            <div className="btn-group" style={{ display: 'flex', gap: '8px', marginTop: '1rem', flexWrap: 'wrap' }}>
              <button onClick={sendWhatsApp} disabled={!reminderFor.phone} style={{
                flex: '1 1 160px', padding: '11px 16px',
                background: reminderFor.phone ? '#25D366' : '#e2e8f0',
                color: reminderFor.phone ? 'white' : '#94a3b8', border: 'none',
                borderRadius: '8px', fontSize: '14px', fontWeight: '600',
                cursor: reminderFor.phone ? 'pointer' : 'not-allowed',
              }}>
                💬 Open WhatsApp
              </button>
              <button onClick={() => copyText('msg', reminderText)} style={{
                padding: '11px 16px', background: 'white', color: '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px',
                fontWeight: '600', cursor: 'pointer',
              }}>{copied === 'msg' ? 'Copied ✓' : 'Copy message'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
