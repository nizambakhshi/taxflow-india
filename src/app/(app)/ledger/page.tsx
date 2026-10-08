'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR, getFinancialYear } from '@/lib/gst-engine'
import {
  buildLedger, buildStatement, download, statementToCsv, summariseParties,
  type PartySummary,
} from '@/lib/party-ledger'
import { changePct, formatDateIN, formatCompactINR } from '@/lib/format'
import { buildPortalPayload, encodePortal, portalUrl } from '@/lib/portal'
import { buildWhatsAppLink, loadUpiSettings, validateVpa } from '@/lib/payments'
import {
  Badge, Button, Card, EmptyState, PageHeader, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'
import Link from 'next/link'

const DAY = 86400000

type ShareState =
  | { stage: 'busy' }
  | { stage: 'error'; message: string }
  | { stage: 'ready'; url: string; closing: number; openCount: number; hasUpi: boolean; dropped: number }

function iso(d: Date) { return d.toISOString().split('T')[0] }

function presetRange(preset: string): { from: string; to: string } {
  const today = new Date()
  const to = iso(today)
  if (preset === '30d') return { from: iso(new Date(today.getTime() - 30 * DAY)), to }
  if (preset === 'quarter') return { from: iso(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)), to }
  if (preset === 'all') return { from: '', to: '' }
  // Financial year (April–March)
  const startYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` }
}

export default function LedgerPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [orgGstin, setOrgGstin] = useState('')
  const [parties, setParties] = useState<PartySummary[]>([])

  const [selectedKey, setSelectedKey] = useState('')
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState('all')
  const [preset, setPreset] = useState('fy')
  const [range, setRange] = useState(() => presetRange('fy'))
  const [share, setShare] = useState<ShareState | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')

      const [inv, bills, cn, dn, pay, voidInv, voidBills, cust, vend, reg] = await Promise.all([
        supabase.from('invoices').select('*').eq('organization_id', oid).neq('status', 'cancelled'),
        supabase.from('purchase_bills').select('*').eq('organization_id', oid).neq('status', 'cancelled'),
        supabase.from('credit_notes').select('*').eq('organization_id', oid),
        supabase.from('debit_notes').select('*').eq('organization_id', oid),
        supabase.from('payments').select('*').eq('organization_id', oid),
        supabase.from('invoices').select('id').eq('organization_id', oid).eq('status', 'cancelled'),
        supabase.from('purchase_bills').select('id').eq('organization_id', oid).eq('status', 'cancelled'),
        supabase.from('customers').select('*').eq('organization_id', oid),
        supabase.from('vendors').select('*').eq('organization_id', oid),
        supabase.from('gst_registrations').select('gstin').eq('organization_id', oid).eq('is_primary', true).single(),
      ])

      setOrgGstin(reg.data?.gstin || '')
      const ledger = buildLedger({
        invoices: inv.data || [], bills: bills.data || [],
        creditNotes: cn.data || [], debitNotes: dn.data || [],
        payments: pay.data || [], customers: cust.data || [], vendors: vend.data || [],
        voidedInvoiceIds: (voidInv.data || []).map(r => r.id),
        voidedBillIds: (voidBills.data || []).map(r => r.id),
      })
      const summaries = summariseParties(ledger, { customers: cust.data || [], vendors: vend.data || [] })
      setParties(summaries)
      setSelectedKey(prev => prev || summaries[0]?.party.id || '')
      setLoading(false)
    }
    load()
  }, [])

  const visible = useMemo(() => parties.filter(p => {
    if (kindFilter === 'outstanding') {
      if (Math.abs(p.balance) < 1) return false
    } else if (kindFilter !== 'all' && p.party.kind !== kindFilter) {
      return false
    }
    if (search && !`${p.party.name} ${p.party.gstin || ''}`.toLowerCase().includes(search.toLowerCase())) return false
    return true
  }), [parties, kindFilter, search])

  const selected = parties.find(p => p.party.id === selectedKey) || null
  const statement = useMemo(
    () => (selected ? buildStatement(selected.docs, range.from || undefined, range.to || undefined) : null),
    [selected, range],
  )

  if (loading) {
    return (
      <div className="page-container" style={{ maxWidth: 1320 }}>
        <div style={{ height: 84, borderRadius: 16, background: 'linear-gradient(115deg,#dbe6f7,#eef2f9)', marginBottom: '1rem' }} />
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1rem' }}>
          {[0, 1].map(i => (
            <div key={i} style={{ height: 420, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)' }} />
          ))}
        </div>
      </div>
    )
  }

  const receivable = parties.filter(p => p.balance > 0).reduce((s, p) => s + p.balance, 0)
  const payable = parties.filter(p => p.balance < 0).reduce((s, p) => s - p.balance, 0)

  function exportCsv() {
    if (!selected || !statement) return
    download(
      `statement-${selected.party.name.replace(/\W+/g, '-').toLowerCase()}-${range.from || 'all'}.csv`,
      statementToCsv(selected.party, statement, { from: range.from, to: range.to, business: orgName, gstin: orgGstin }),
    )
  }

  async function openShare() {
    if (!selected || !statement) return
    setCopied(false)
    setShare({ stage: 'busy' })
    try {
      const s = loadUpiSettings(orgId)
      const upi = s.vpa.trim() && !validateVpa(s.vpa)
        ? { vpa: s.vpa.trim(), payeeName: (s.payeeName || orgName).trim() }
        : null
      const payload = buildPortalPayload({
        businessName: orgName,
        businessGstin: orgGstin,
        upi,
        party: { name: selected.party.name, kind: selected.party.kind, gstin: selected.party.gstin },
        statement,
        from: range.from,
        to: range.to,
      })
      const token = await encodePortal(payload)
      setShare({
        stage: 'ready',
        url: portalUrl(token, window.location.origin),
        closing: payload.totals.closing,
        openCount: payload.rows.filter(r => r.type === 'invoice' && r.due > 0).length,
        hasUpi: Boolean(upi),
        dropped: payload.dropped,
      })
    } catch {
      setShare({ stage: 'error', message: 'Could not build the share link — please try again.' })
    }
  }

  async function copyShareUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard blocked — the input below is selectable by hand */
    }
  }

  const shareWa = share?.stage === 'ready' && selected?.party.phone
    ? buildWhatsAppLink(
        selected.party.phone,
        `Hi ${selected.party.name}, here is your account statement from ${orgName || 'us'} — ₹${formatINR(Math.abs(share.closing))} ${share.closing > 0 ? 'outstanding' : share.closing < 0 ? 'in credit' : 'settled'}. View it here: ${share.url}`,
      )
    : null

  return (
    <div className="page-container" style={{ maxWidth: 1320 }}>
      <PageHeader
        eyebrow={`Financial year ${getFinancialYear()}`}
        title="Account ledger"
        subtitle={`${parties.length} parties · ${formatCompactINR(receivable)} to receive · ${formatCompactINR(payable)} to pay`}
        actions={<Button href="/payments" variant="ghost" icon="swap" style={{ background: 'rgba(255,255,255,.12)', color: 'white', borderColor: 'rgba(255,255,255,.25)' }}>Payments</Button>}
      />

      <div className="ledger-grid">
        {/* ── Party list ── */}
        <Card pad={false} className="ledger-list no-print-scroll">
          <div style={{ padding: '0.85rem', borderBottom: '1px solid var(--line-soft)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 2 }}>
            <div style={{ position: 'relative' }}>
              <span style={{ position: 'absolute', left: 10, top: 9, color: 'var(--faint)' }}>
                <Icon name="search" size={15} />
              </span>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search party or GSTIN"
                style={{
                  width: '100%', padding: '8px 10px 8px 32px', fontSize: 13,
                  border: '1px solid var(--line)', borderRadius: 10, outline: 'none',
                  background: 'var(--surface-2)', color: 'var(--ink)', fontFamily: 'inherit',
                }}
              />
            </div>
            <div className="tab-bar" style={{ marginTop: 9 }}>
              <Segmented
                value={kindFilter}
                onChange={setKindFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'customer', label: 'Customers' },
                  { value: 'vendor', label: 'Vendors' },
                  { value: 'outstanding', label: 'Outstanding' },
                ]}
              />
            </div>
          </div>

          <div className="ledger-scroll">
            {visible.length === 0 ? (
              <EmptyState icon="users" title="No parties match" message="Try a different search or filter." />
            ) : visible.map(p => {
              const active = p.party.id === selectedKey
              const owed = p.balance > 0
              return (
                <button key={p.party.id} onClick={() => setSelectedKey(p.party.id)} className={`party-row ${active ? 'is-active' : ''}`}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: 13, fontWeight: active ? 650 : 550, color: 'var(--ink)',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {p.party.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                      {p.party.kind === 'customer' ? 'Customer' : 'Vendor'} · {p.activityCount} entries
                      {p.lastActivity ? ` · last ${formatDateIN(p.lastActivity)}` : ''}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="tf-num" style={{ fontSize: 13, fontWeight: 650, color: owed ? 'var(--green)' : p.balance < 0 ? 'var(--red)' : 'var(--muted)' }}>
                      {formatCompactINR(Math.abs(p.balance))}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--faint)' }}>{owed ? 'to receive' : p.balance < 0 ? 'to pay' : 'settled'}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </Card>

        {/* ── Statement ─ */}
        {!selected || !statement ? (
          <Card><EmptyState icon="book" title="Pick a party" message="Select a customer or vendor to see their statement of accounts." /></Card>
        ) : (
          <div className="tf-col" style={{ gap: '1rem' }}>
            <Card>
              <div className="tf-row-between tf-wrap" style={{ gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="tf-row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{selected.party.name}</span>
                    <Badge tone={selected.party.kind === 'customer' ? 'blue' : 'violet'} dot={false}>
                      {selected.party.kind}
                    </Badge>
                    {selected.overdue > 0 && <Badge tone="red">{formatCompactINR(selected.overdue)} overdue</Badge>}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
                    {selected.party.gstin ? <span style={{ fontFamily: 'monospace' }}>{selected.party.gstin} · </span> : null}
                    {selected.party.phone || 'no phone on file'}
                    {selected.party.email ? ` · ${selected.party.email}` : ''}
                  </div>
                </div>
                <div className="tf-row tf-wrap no-print" style={{ gap: 8 }}>
                  {selected.party.kind === 'customer' && (
                    <Button variant="primary" size="sm" icon="link" onClick={openShare} disabled={share?.stage === 'busy'}>
                      Portal link
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" icon="download" onClick={exportCsv}>CSV</Button>
                  <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>Print</Button>
                  <Button variant={selected.party.kind === 'customer' ? 'ghost' : 'primary'} size="sm" icon="chat" href="/payments/links">Remind</Button>
                </div>
              </div>

              <hr className="tf-divider" />

              <div className="tf-row-between tf-wrap" style={{ gap: 12 }}>
                <Segmented
                  value={preset}
                  onChange={k => { setPreset(k); setRange(presetRange(k)) }}
                  options={[
                    { value: 'fy', label: `FY ${getFinancialYear()}` },
                    { value: 'quarter', label: 'This quarter' },
                    { value: '30d', label: 'Last 30 days' },
                    { value: 'all', label: 'All' },
                  ]}
                />
                <div className="tf-row no-print" style={{ gap: 8, fontSize: 12, color: 'var(--muted)' }}>
                  <input type="date" value={range.from} onChange={e => { setPreset('custom'); setRange(r => ({ ...r, from: e.target.value })) }} className="date-input" />
                  <span>to</span>
                  <input type="date" value={range.to} onChange={e => { setPreset('custom'); setRange(r => ({ ...r, to: e.target.value })) }} className="date-input" />
                </div>
              </div>
            </Card>

            <div className="tf-g-4">
              <StatCard label="Opening balance" value={`₹${formatINR(Math.abs(statement.opening))}`} tone={statement.opening < 0 ? 'red' : 'blue'}
                sub={statement.opening < 0 ? 'payable brought forward' : 'receivable brought forward'} icon="book" />
              <StatCard label="Debit (owes more)" value={`₹${formatINR(statement.totalDebit)}`} tone="violet" sub="Invoices raised, bills returned" icon="arrow-up" />
              <StatCard label="Credit (settles)" value={`₹${formatINR(statement.totalCredit)}`} tone="cyan" sub="Payments received, notes issued" icon="arrow-down" />
              <StatCard
                label="Closing balance" value={`₹${formatINR(Math.abs(statement.closing))}`}
                tone={statement.closing > 0 ? 'green' : statement.closing < 0 ? 'red' : 'grey'}
                sub={statement.closing > 0 ? 'to receive' : statement.closing < 0 ? 'to pay' : 'fully settled'}
                icon="check" delta={changePct(Math.abs(statement.closing), Math.abs(statement.opening)) ?? undefined} deltaSuffix="vs opening"
              />
            </div>

            <Card pad={false}>
              <div className="responsive-table">
                <div className="table-header ledger-cols tf-th" style={{ display: 'grid' }}>
                  <span>Date</span><span>Particulars</span><span>Document</span>
                  <span style={{ textAlign: 'right' }}>Debit</span>
                  <span style={{ textAlign: 'right' }}>Credit</span>
                  <span style={{ textAlign: 'right' }}>Balance</span>
                </div>

                <div className="table-row ledger-cols tf-td" style={{ display: 'grid', background: 'var(--surface-2)' }}>
                  <span data-label="Date">{range.from ? formatDateIN(range.from) : 'Opening'}</span>
                  <span data-label="Particulars"><b>Opening balance</b></span>
                  <span data-label="Document">—</span>
                  <span data-label="Debit" style={{ textAlign: 'right' }}>{statement.opening > 0 ? `₹${formatINR(statement.opening)}` : '—'}</span>
                  <span data-label="Credit" style={{ textAlign: 'right' }}>{statement.opening < 0 ? `₹${formatINR(-statement.opening)}` : '—'}</span>
                  <span data-label="Balance" style={{ textAlign: 'right', fontWeight: 650 }}>₹{formatINR(statement.opening)}</span>
                </div>

                {statement.rows.map((r, i) => (
                  <div key={`${r.docNumber}-${i}`} className="table-row ledger-cols tf-td tf-tr" style={{ display: 'grid' }}>
                    <span data-label="Date">{formatDateIN(r.date)}</span>
                    <span data-label="Particulars">
                      <span className="tf-row" style={{ gap: 7 }}>
                        <i style={{ width: 6, height: 6, borderRadius: 99, background: DOC_COLOR[r.type], display: 'inline-block' }} />
                        {r.particulars}
                      </span>
                    </span>
                    <span data-label="Document">
                      {r.href && r.type !== 'bill'
                        ? <Link href={r.href} style={{ color: 'var(--brand)', textDecoration: 'none' }}>{r.docNumber}</Link>
                        : <span style={{ color: 'var(--muted)' }}>{r.docNumber}</span>}
                    </span>
                    <span data-label="Debit" style={{ textAlign: 'right' }}>{r.debitAmount ? `₹${formatINR(r.debitAmount)}` : '—'}</span>
                    <span data-label="Credit" style={{ textAlign: 'right' }}>{r.creditAmount ? `₹${formatINR(r.creditAmount)}` : '—'}</span>
                    <span data-label="Balance" style={{ textAlign: 'right', fontWeight: 600 }}>₹{formatINR(r.running)}</span>
                  </div>
                ))}

                {statement.rows.length === 0 && (
                  <EmptyState icon="calendar" title="No activity in this period"
                    message="Try widening the date range — the opening balance above still applies." />
                )}

                <div className="table-row ledger-cols tf-td" style={{
                  display: 'grid', background: 'var(--surface-2)', fontWeight: 700, color: 'var(--ink)',
                }}>
                  <span data-label="Date">—</span>
                  <span data-label="Particulars">Period total</span>
                  <span data-label="Document">{statement.rows.length} entries</span>
                  <span data-label="Debit" style={{ textAlign: 'right' }}>₹{formatINR(statement.totalDebit)}</span>
                  <span data-label="Credit" style={{ textAlign: 'right' }}>₹{formatINR(statement.totalCredit)}</span>
                  <span data-label="Balance" style={{ textAlign: 'right' }}>₹{formatINR(statement.closing)}</span>
                </div>
              </div>
            </Card>

            <Card>
              <div className="tf-g-2">
                <div>
                  <div className="tf-eyebrow" style={{ marginBottom: 8 }}>Position</div>
                  <StatRow label="Documents in range" value={statement.rows.length} />
                  <StatRow label="Oldest overdue" value={selected.oldestDays ? `${selected.oldestDays} days` : '—'} tone={selected.oldestDays > 60 ? 'red' : 'grey'} />
                  <StatRow label="Last activity" value={selected.lastActivity ? formatDateIN(selected.lastActivity) : '—'} />
                </div>
                <div>
                  <div className="tf-eyebrow" style={{ marginBottom: 8 }}>Statement totals</div>
                  <StatRow label="Billed to party" value={`₹${formatINR(selected.totalDebit)}`} tone="violet" />
                  <StatRow label="Settled / credited" value={`₹${formatINR(selected.totalCredit)}`} tone="cyan" />
                  <StatRow label="All-time balance" value={`₹${formatINR(Math.abs(selected.balance))}`} strong tone={selected.balance > 0 ? 'green' : 'red'} />
                </div>
              </div>
            </Card>
          </div>
        )}
      </div>

      {/* ── Share statement (portal link) ── */}
      {share && (
        <div
          className="pt-share-scrim no-print" role="dialog" aria-modal="true" aria-label="Share statement"
          onClick={e => { if (e.target === e.currentTarget) setShare(null) }}
        >
          <div className="pt-share-modal">
            <div className="pt-share-head">
              <div>
                <h2>Share statement</h2>
                <p>
                  A customer-facing copy of this statement, opened from a link — no sign-in
                  for {selected?.party.name ?? 'the party'} and nothing stored on any server.
                </p>
              </div>
              <button type="button" className="pt-share-close" onClick={() => setShare(null)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            {share.stage === 'busy' && (
              <div className="pt-share-busy" aria-busy="true">
                <div className="pt-share-bar" style={{ width: '62%' }} />
                <div className="pt-share-bar" style={{ width: '88%' }} />
              </div>
            )}

            {share.stage === 'error' && (
              <div className="pt-share-alert" role="alert">
                <Icon name="alert" size={14} strokeWidth={2.2} />{share.message}
              </div>
            )}

            {share.stage === 'ready' && (
              <>
                <div className="pt-share-stats">
                  <span>
                    <b>₹{formatINR(Math.abs(share.closing))}</b>{' '}
                    {share.closing > 0 ? 'outstanding' : share.closing < 0 ? 'in credit' : 'settled'}
                  </span>
                  <span>·</span>
                  <span>{share.openCount} open {share.openCount === 1 ? 'invoice' : 'invoices'}</span>
                  {share.dropped > 0 && (<><span>·</span><span>{share.dropped} older entries folded in</span></>)}
                </div>

                <label className="pt-share-field">
                  <span>Statement link</span>
                  <div className="pt-share-linkrow">
                    <input
                      readOnly
                      className="pt-share-input"
                      value={share.url}
                      onFocus={e => e.target.select()}
                      aria-label="Statement link"
                    />
                    <Button variant="primary" size="sm" icon={copied ? 'check' : 'clipboard'} onClick={() => copyShareUrl(share.url)}>
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                  </div>
                </label>

                {!share.hasUpi && (
                  <div className="pt-share-hint">
                    No UPI ID configured — the statement will open without pay buttons.
                    Add one on the Payments → links page and share again to include them.
                  </div>
                )}

                <div className="pt-share-actions">
                  {shareWa?.link ? (
                    <a className="tf-btn tf-btn-primary tf-btn-sm" href={shareWa.link} target="_blank" rel="noreferrer">
                      <Icon name="chat" size={13} strokeWidth={2} /> WhatsApp
                    </a>
                  ) : null}
                  <a className="tf-btn tf-btn-ghost tf-btn-sm" href={share.url} target="_blank" rel="noreferrer">
                    <Icon name="link" size={13} strokeWidth={2} /> Open preview
                  </a>
                </div>

                <p className="pt-share-note">
                  The whole statement rides inside the link itself — up to 120 entries; older
                  ones fold into the opening balance. Send it however you like; there is nothing
                  to revoke, because nothing was kept.
                  {!shareWa?.link ? ' No phone on file for WhatsApp — copy the link instead.' : ''}                </p>
              </>
            )}
          </div>
        </div>
      )}

      <style>{`
        .ledger-grid { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 1rem; align-items: start; }
        .ledger-list { overflow: hidden; max-height: calc(100vh - 120px); display: flex; flex-direction: column; }
        .ledger-scroll { overflow-y: auto; }
        .party-row {
          display: flex; align-items: center; gap: 10px; width: 100%;
          padding: 11px 14px; background: none; cursor: pointer; text-align: left;
          border: none; border-bottom: 1px solid var(--line-soft); border-left: 3px solid transparent;
          font-family: inherit; transition: background .12s ease;
        }
        .party-row:hover { background: var(--surface-2); }
        .party-row.is-active { background: var(--brand-soft); border-left-color: var(--brand); }
        .ledger-cols { grid-template-columns: 92px minmax(150px,1.6fr) minmax(110px,1fr) 1fr 1fr 1.1fr; gap: 12px; align-items: center; }
        .date-input {
          font-family: inherit; font-size: 12px; padding: 6px 8px;
          border: 1px solid var(--line); border-radius: 8px; background: var(--surface); color: var(--ink-2);
        }
        /* ── share-statement modal ── */
        .pt-share-scrim {
          position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45);
          display: flex; align-items: center; justify-content: center;
          z-index: 70; padding: 1rem;
        }
        .pt-share-modal {
          background: var(--surface); border-radius: var(--radius-lg);
          padding: 1.4rem 1.5rem; width: 100%; max-width: 560px;
          max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px;
        }
        .pt-share-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
        .pt-share-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .pt-share-head p { font-size: 12px; color: var(--muted); margin-top: 2px; max-width: 430px; line-height: 1.5; }
        .pt-share-close {
          background: none; border: none; color: var(--faint); cursor: pointer;
          padding: 4px; border-radius: 6px; flex-shrink: 0;
        }
        .pt-share-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .pt-share-busy { display: flex; flex-direction: column; gap: 8px; padding: 4px 0; }
        .pt-share-bar {
          height: 12px; border-radius: 6px;
          background: linear-gradient(90deg, var(--bg-elevated), #f3f6fb, var(--bg-elevated));
          background-size: 200% 100%; animation: pt-share-shimmer 1.4s ease infinite;
        }
        @keyframes pt-share-shimmer {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }
        .pt-share-alert {
          display: flex; align-items: center; gap: 8px; font-size: 12.5px;
          color: var(--red); background: var(--red-soft); border-radius: 10px; padding: 9px 12px;
        }
        .pt-share-stats {
          display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline;
          font-size: 12.5px; color: var(--ink-2);
          background: var(--surface-2); border: 1px solid var(--line);
          border-radius: 10px; padding: 9px 12px;
        }
        .pt-share-field { display: flex; flex-direction: column; gap: 4px; }
        .pt-share-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .pt-share-linkrow { display: flex; gap: 8px; }
        .pt-share-input {
          flex: 1; min-width: 0; font-family: ui-monospace, monospace; font-size: 12px;
          padding: 9px 10px; border: 1px solid var(--line); border-radius: 9px;
          background: var(--surface-2); color: var(--ink-2); outline: none;
        }
        .pt-share-hint {
          font-size: 12px; color: var(--amber); background: var(--amber-soft);
          border: 1px solid color-mix(in srgb, var(--amber) 22%, white);
          border-radius: 9px; padding: 8px 10px;
        }
        .pt-share-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .pt-share-note { font-size: 11.5px; color: var(--faint); line-height: 1.55; }
        @media (max-width: 640px) {
          .pt-share-scrim { align-items: flex-end; padding: 0; }
          .pt-share-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; padding: 1.1rem 1.15rem; }
          .pt-share-linkrow { flex-direction: column; }
        }
        @media (max-width: 1024px) {
          .ledger-grid { grid-template-columns: minmax(0, 1fr); }
          .ledger-list { max-height: 340px; }
        }
        @media (max-width: 768px) {
          .ledger-cols { grid-template-columns: 1fr; gap: 4px; }
          .ledger-cols > span { display: flex; justify-content: space-between; }
          .ledger-cols > span::before {
            content: attr(data-label); font-size: 11px; font-weight: 600;
            color: var(--faint); text-transform: uppercase; letter-spacing: .05em;
          }
          .table-header.ledger-cols { display: none !important; }
          .table-row.ledger-cols { display: block !important; border-bottom: 1px solid var(--line); padding: 12px 14px; }
          .table-row.ledger-cols > span { padding: 2px 0; }
        }
        @media print {
          .no-print, .ledger-list { display: none !important; }
          .ledger-grid { grid-template-columns: 1fr !important; }
          .page-container { padding: 0 !important; }
          .tf-pagehead { display: none !important; }
          .tf-card { break-inside: avoid; box-shadow: none !important; }
        }
      `}</style>
    </div>
  )
}

const DOC_COLOR: Record<string, string> = {
  invoice: '#2563eb',
  credit_note: '#dc2626',
  debit_note: '#d97706',
  bill: '#7c3aed',
  payment: '#059669',
}
