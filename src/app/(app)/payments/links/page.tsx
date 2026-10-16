'use client'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { formatDateIN } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  buildUpiDeepLink, buildWhatsAppLink, renderReminder,
  loadUpiSettings, saveUpiSettings, validateVpa,
  DEFAULT_REMINDER_TEMPLATES, PLACEHOLDER_HELP,
  type UpiSettings,
} from '@/lib/payments'

interface Row {
  invoiceId: string
  invoiceNumber: string
  customerName: string
  phone: string
  amountDue: number
  dueDate: string
  overdue: boolean
  draft: boolean
}

const VIEWS = [
  { value: 'all', label: 'Open', noun: 'open' },
  { value: 'overdue', label: 'Overdue', noun: 'overdue' },
  { value: 'nophone', label: 'No phone', noun: 'without a phone number' },
]

const TEMPLATE_OPTIONS = DEFAULT_REMINDER_TEMPLATES.map(t => ({ value: t.key, label: t.label }))

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number | string | null | undefined) => inr0.format(num(v))

function PaymentLinksPageInner() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useSearchDeepLink()
  const [view, setView] = useState('all')

  const [settings, setSettings] = useState<UpiSettings>({
    vpa: '', payeeName: '', templateKey: 'standard',
  })
  const [showSettings, setShowSettings] = useState(false)
  const [settingsSaved, setSettingsSaved] = useState(false)
  const [notice, setNotice] = useState('')

  // Reminder modal
  const [reminderFor, setReminderFor] = useState<Row | null>(null)
  const [reminderText, setReminderText] = useState('')
  const [reminderPayLink, setReminderPayLink] = useState('')
  const [reminderError, setReminderError] = useState('')
  const [copied, setCopied] = useState('')

  async function loadInvoices(oid: string) {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id, invoice_number, customer_id, customer_name, balance_due, due_date, invoice_date, status')
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
        draft: inv.status === 'draft',
      }
    })
    setRows(mapped)
  }

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
      const name = ((membership.organizations as { name?: string } | null)?.name) || ''
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

  function persist(next: UpiSettings) {
    setSettings(next)
    setSettingsSaved(false)
    setNotice('')
  }
  function saveSettings() {
    const problem = validateVpa(settings.vpa)
    if (problem) { setNotice(problem); setShowSettings(true); return }
    saveUpiSettings(orgId, settings)
    setNotice('')
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
      setShowSettings(true)
      setNotice(`A payment link needs a valid UPI ID first — ${error}`)
      return
    }
    setReminderFor(row)
    setReminderPayLink(link)
    setReminderText(reminderBody(row, settings.templateKey, link))
    setReminderError('')
  }

  function reminderBody(row: Row, templateKey: string, payLink: string): string {
    const tpl = DEFAULT_REMINDER_TEMPLATES.find(t => t.key === templateKey)
      || DEFAULT_REMINDER_TEMPLATES[1]
    return renderReminder(tpl.body, {
      customer: row.customerName,
      businessName: orgName,
      invoiceNumber: row.invoiceNumber,
      amount: formatINR(row.amountDue),
      dueDate: row.dueDate ? new Date(row.dueDate).toLocaleDateString('en-IN') : '—',
      payLink,
    })
  }

  function swapTemplate(key: string) {
    if (!reminderFor) { persist({ ...settings, templateKey: key }); return }
    const { link } = payLinkFor(reminderFor)
    persist({ ...settings, templateKey: key })
    setReminderText(reminderBody(reminderFor, key, link))
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

  const vpaProblem = validateVpa(settings.vpa)
  const ready = vpaProblem === null

  const summary = useMemo(() => ({
    open: rows.length,
    toCollect: rows.reduce((s, r) => s + r.amountDue, 0),
    overdue: rows.filter(r => r.overdue),
    noPhone: rows.filter(r => !r.phone),
    drafts: rows.filter(r => r.draft).length,
  }), [rows])

  const visible = useMemo(() => rows.filter(r => {
    if (view === 'overdue' && !r.overdue) return false
    if (view === 'nophone' && r.phone) return false
    return matchesAny(search, [r.invoiceNumber, r.customerName, r.phone])
  }), [rows, view, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the invoices you can chase…</div>
  }

  return (
    <div className="page-container pl" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Money"
        title="Payment links & reminders"
        subtitle="Every open invoice turns into a UPI deep link and a message you can send on WhatsApp. Nothing is charged here — the link just opens the customer's UPI app with the amount filled in."
        actions={(
          <Button size="sm" variant={ready ? 'subtle' : 'primary'}
            icon={ready ? 'settings' : 'link'}
            onClick={() => setShowSettings(s => !s)}>
            {ready ? 'UPI settings' : 'Set up UPI ID'}
          </Button>
        )}
      />

      <div className="pl-stats">
        <StatCard label="Open invoices" value={String(summary.open)}
          sub={summary.drafts ? `${summary.drafts} still in draft` : 'all issued'}
          icon="invoice" tone="blue" delay={0} />
        <StatCard label="To collect" value={money(summary.toCollect)}
          sub="across every unpaid invoice" icon="wallet" tone="cyan" delay={40} />
        <StatCard label="Overdue" value={money(summary.overdue.reduce((s, r) => s + r.amountDue, 0))}
          sub={`${summary.overdue.length} past the due date`}
          icon="clock" tone={summary.overdue.length ? 'red' : 'grey'} delay={80} />
        <StatCard label="No phone" value={String(summary.noPhone.length)}
          sub={summary.noPhone.length ? 'a reminder cannot be sent on WhatsApp' : 'every customer is reachable'}
          icon="chat" tone={summary.noPhone.length ? 'amber' : 'grey'} delay={120} />
      </div>

      {showSettings && (
        <Card className="pl-panel">
          <div className="pl-panel-title">Your UPI receiving details</div>
          <div className="pl-grid">
            <label className="pl-field">
              <span>UPI ID / VPA</span>
              <input className="tf-input" placeholder="business@okhdfcbank" value={settings.vpa}
                onChange={e => persist({ ...settings, vpa: e.target.value })} />
              {settings.vpa.trim() && vpaProblem && <span className="pl-field-error">{vpaProblem}</span>}
            </label>
            <label className="pl-field">
              <span>Payee name (shown to the customer)</span>
              <input className="tf-input" placeholder={orgName} value={settings.payeeName}
                onChange={e => persist({ ...settings, payeeName: e.target.value })} />
            </label>
          </div>
          <div className="pl-grid">
            <label className="pl-field">
              <span>Default reminder tone</span>
              <select className="tf-input" value={settings.templateKey}
                onChange={e => persist({ ...settings, templateKey: e.target.value })}>
                {DEFAULT_REMINDER_TEMPLATES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
            <div className="pl-field pl-save-cell">
              <Button onClick={saveSettings} icon={settingsSaved ? 'check' : undefined}>
                {settingsSaved ? 'Saved' : 'Save settings'}
              </Button>
            </div>
          </div>
          <p className="pl-hint">
            Saved in this browser for your organisation only — it never leaves the device except inside
            the link you choose to send.
          </p>
        </Card>
      )}

      {!ready && (
        <div className="pl-alert pl-alert-amber"><Icon name="alert" size={14} />
          Add your UPI ID to start generating payment links.
        </div>
      )}

      {notice && (
        <div className="pl-alert"><Icon name="alert" size={14} />{notice}</div>
      )}

      <div className="pl-toolbar">
        <Segmented options={VIEWS} value={view} onChange={setView} />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Invoice number, customer or phone…"
          ariaLabel="Search open invoices"
          style={{ flex: '1 1 240px', maxWidth: 340, marginLeft: 'auto' }}
        />
      </div>

      {visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={rows.length ? 'search' : 'check'}
            title={rows.length
              ? (search ? `No invoice matches “${search}”` : `No ${VIEWS.find(v => v.value === view)?.noun} invoices`)
              : 'Nothing to chase'}
            message={rows.length
              ? 'Clear the search or pick another filter to see every open invoice.'
              : 'Every invoice in this account is paid, so there is no reminder to send.'}
            action={!rows.length ? <Button size="sm" variant="subtle" href="/invoices">Open invoices</Button> : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header pl-row pl-head">
              <span data-label="Invoice">Invoice</span>
              <span data-label="Customer">Customer</span>
              <span className="pl-right" data-label="Amount">Balance</span>
              <span data-label="Due">Due</span>
              <span className="pl-right" data-label="Action">Action</span>
            </div>
            {visible.map(r => (
              <div key={r.invoiceId} className={`table-row pl-row ${r.draft ? 'pl-dim' : ''}`}>
                <span data-label="Invoice" className="pl-doc-cell">
                  <span className="pl-doc-number">{r.invoiceNumber}</span>
                  {r.draft && <Badge tone="grey" dot={false}>Draft</Badge>}
                </span>
                <span data-label="Customer" className="pl-party">
                  <span>{r.customerName}</span>
                  <span className={r.phone ? 'pl-sub' : 'pl-flag'}>{r.phone || 'no phone on file'}</span>
                </span>
                <span className="pl-right pl-amount" data-label="Amount">{money(r.amountDue)}</span>
                <span data-label="Due">
                  <span className={r.overdue ? 'pl-due-overdue' : 'pl-sub'}>
                    {formatDateIN(r.dueDate)}
                  </span>
                  {r.overdue && <div className="pl-flag">Overdue</div>}
                </span>
                <span className="pl-right" data-label="Action">
                  <Button size="sm" icon="chat" onClick={() => openReminder(r)} disabled={!ready}>
                    Remind
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="pl-foot">
        <span>Shown: {visible.length} of {rows.length}</span>
        {summary.drafts > 0 && <span>Draft invoices are listed for the link, but a reminder before the invoice is issued asks for money you have not billed yet.</span>}
        <span>{PLACEHOLDER_HELP}</span>
      </div>

      {reminderFor && (
        <div className="pl-scrim" role="dialog" aria-modal="true" aria-label={`Payment reminder for ${reminderFor.invoiceNumber}`}
          onClick={() => setReminderFor(null)}>
          <div className="pl-modal" onClick={e => e.stopPropagation()}>
            <div className="pl-modal-head">
              <div>
                <h2>Payment reminder</h2>
                <p>{reminderFor.invoiceNumber} · {money(reminderFor.amountDue)} · {reminderFor.customerName}</p>
              </div>
              <button type="button" className="pl-close" onClick={() => setReminderFor(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <Segmented options={TEMPLATE_OPTIONS} value={settings.templateKey} onChange={swapTemplate} />

            <label className="pl-field">
              <span>UPI payment link</span>
              <div className="pl-link-row">
                <input className="tf-input pl-link" readOnly value={reminderPayLink} />
                <Button size="sm" variant="subtle" onClick={() => copyText('paylink', reminderPayLink)}
                  icon={copied === 'paylink' ? 'check' : 'clipboard'}>
                  {copied === 'paylink' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            </label>

            <label className="pl-field">
              <span>Message</span>
              <textarea className="tf-input pl-text" rows={7} value={reminderText}
                onChange={e => setReminderText(e.target.value)} />
              <span className="pl-hint">{PLACEHOLDER_HELP}</span>
            </label>

            {reminderError && (
              <div className="pl-alert"><Icon name="alert" size={14} />{reminderError}</div>
            )}

            {!reminderFor.phone && (
              <div className="pl-alert pl-alert-amber"><Icon name="alert" size={14} />
                No phone number on file for this customer — copy the link and send it yourself.
              </div>
            )}

            <div className="pl-save">
              <Button variant="ghost" onClick={() => copyText('msg', reminderText)}
                icon={copied === 'msg' ? 'check' : 'clipboard'}>
                {copied === 'msg' ? 'Message copied' : 'Copy message'}
              </Button>
              <Button onClick={sendWhatsApp} disabled={!reminderFor.phone} icon="chat">
                Open WhatsApp
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .pl-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .pl-panel { margin-bottom: 1rem; display: flex; flex-direction: column; gap: 12px; }
        .pl-panel-title { font-size: 13px; font-weight: 650; color: var(--ink); }
        .pl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: start; }
        .pl-field { display: flex; flex-direction: column; gap: 4px; }
        .pl-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .pl-field-error { font-size: 11.5px; color: var(--red); }
        .pl-save-cell { justify-content: flex-end; align-self: end; }
        .pl-hint { font-size: 11px; color: var(--faint); line-height: 1.5; }
        .pl-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px;
          padding: 10px 12px; margin-bottom: 10px; background: var(--red-soft); color: var(--red);
          border-left: 3px solid var(--red); }
        .pl-alert-amber { background: var(--amber-soft); color: var(--amber); border-left-color: var(--amber); }

        .pl-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .pl-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) 116px minmax(0, 0.9fr) 132px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .pl-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px;
          font-weight: 650; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .pl-right { text-align: right; }
        .pl-doc-cell { display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .pl-doc-number { color: var(--ink); font-weight: 600; overflow-wrap: anywhere; }
        .pl-party { display: flex; flex-direction: column; gap: 2px; color: var(--ink); min-width: 0; }
        .pl-sub { font-size: 11px; color: var(--faint); }
        .pl-flag { font-size: 10.5px; color: var(--amber); margin-top: 2px; }
        .pl-amount { color: var(--ink); font-weight: 650; }
        .pl-due-overdue { font-size: 12px; color: var(--red); font-weight: 600; }
        .pl-dim { opacity: 0.72; }

        .pl-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .pl-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .pl-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
        .pl-modal-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; width: 100%; }
        .pl-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .pl-modal-head p { font-size: 12px; color: var(--muted); margin-top: 2px; }
        .pl-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; }
        .pl-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .pl-modal .pl-field { width: 100%; }
        .pl-link-row { display: flex; gap: 8px; align-items: flex-start; }
        .pl-link { flex: 1; min-width: 0; color: var(--ink-2); background: var(--surface-2);
          font-family: var(--mono); font-size: 11.5px; word-break: break-all; }
        .pl-link-row .pl-field { flex: 1; }
        .pl-text { resize: vertical; line-height: 1.55; font-family: inherit; font-size: 13px; }
        .pl-modal .pl-alert { width: 100%; margin-bottom: 0; }
        .pl-save { display: flex; gap: 10px; justify-content: flex-end; width: 100%; }

        @media (max-width: 1100px) { .pl-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .pl-row { grid-template-columns: 1fr; gap: 6px; }
          .pl-head { display: none; }
          .pl-right { text-align: left; }
          .pl-stats { grid-template-columns: 1fr 1fr; }
          .pl-grid { grid-template-columns: 1fr; }
          .pl-modal { padding: 1.1rem 1.15rem; }
          .pl-scrim { align-items: flex-end; padding: 0; }
          .pl-scrim .pl-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .pl-link-row { flex-direction: column; }
          .pl-save { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}

export default function PaymentLinksPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <PaymentLinksPageInner />
    </Suspense>
  )
}
