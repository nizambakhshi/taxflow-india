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
import {
  Badge, Button, Card, EmptyState, PageHeader, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'
import Link from 'next/link'

const DAY = 86400000

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
      setOrgName((membership.organizations as any)?.name || '')

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
                  <Button variant="ghost" size="sm" icon="download" onClick={exportCsv}>CSV</Button>
                  <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>Print</Button>
                  <Button variant="primary" size="sm" icon="chat" href="/payments/links">Remind</Button>
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
