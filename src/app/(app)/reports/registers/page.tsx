'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import { formatINR, getFinancialYear } from '@/lib/gst-engine'
import { formatCompactINR, formatDateIN } from '@/lib/format'
import {
  b2bRegister, daysUntil, hsnSummary, loadEwbLog, partyWiseSales, removeEwbEntry,
  stateWiseSales, toCsv, totalsOf, upsertEwbEntry,
  type EwbEntry, type RegInvoice, type RegItem,
} from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

const DAY = 86400000

type Tab = 'party' | 'hsn' | 'b2b' | 'state' | 'ewb'

const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'party', label: 'Party-wise sales', icon: 'users' },
  { value: 'hsn', label: 'HSN / SAC summary', icon: 'box' },
  { value: 'b2b', label: 'B2B register', icon: 'file-check' },
  { value: 'state', label: 'State-wise', icon: 'landmark' },
  { value: 'ewb', label: 'E-way bill register', icon: 'cart' },
]

function iso(d: Date) { return d.toISOString().slice(0, 10) }

function presetRange(preset: string): { from: string; to: string } {
  const today = new Date()
  const to = iso(today)
  if (preset === '30d') return { from: iso(new Date(today.getTime() - 30 * DAY)), to }
  if (preset === 'month') return { from: iso(new Date(today.getFullYear(), today.getMonth(), 1)), to }
  if (preset === 'quarter') return { from: iso(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1)), to }
  if (preset === 'all') return { from: '', to: '' }
  const startYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1
  return { from: `${startYear}-04-01`, to: `${startYear + 1}-03-31` }
}

/** Supabase `in()` filters get slow and unreliable past a few hundred ids. */
function batches(ids: string[], size = 500): string[][] {
  const out: string[][] = []
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size))
  return out
}

async function fetchItems(client: any, table: string, foreignKey: string, ids: string[]): Promise<RegItem[]> {
  const cols = `${foreignKey} as invoice_id, item_name, hsn_sac, quantity, unit, taxable_value, gst_rate, cgst_amount, sgst_amount, igst_amount, cess_amount`
  const groups = batches(ids)
  if (!groups.length) return []
  const results = await Promise.all(groups.map(batch =>
    client.from(table).select(cols).in(foreignKey, batch)
  ))
  return results.flatMap(res => (res.data || []) as RegItem[])
}

interface Col {
  key: string
  label: string
  width?: string
  align?: 'left' | 'right'
  sort?: (row: any) => number | string
  render: (row: any) => ReactNode
  csv: (row: any) => string | number
}

export default function RegistersPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [tab, setTab] = useState<Tab>('party')
  const [preset, setPreset] = useState('fy')
  const [range, setRange] = useState(() => presetRange('fy'))
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null)
  const [truncated, setTruncated] = useState(false)

  const [docs, setDocs] = useState<RegInvoice[]>([])
  const [items, setItems] = useState<RegItem[]>([])
  const [ewbLog, setEwbLog] = useState<EwbEntry[]>([])
  const [ewbForm, setEwbForm] = useState({ invoiceId: '', ewbNo: '', validityEnd: '', vehicleNumber: '', transportMode: 'Road', distanceKm: '' })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName((membership.organizations as any)?.name || '')
      setEwbLog(loadEwbLog(oid))
      await loadRange(oid, presetRange('fy'))
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadRange(oid: string, r: { from: string; to: string }) {
    const [invRes, cnRes] = await Promise.all([
      withDates(supabase.from('invoices')
        .select('id, invoice_number, invoice_date, customer_id, customer_name, customer_gstin, place_of_supply, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled'), r, 'invoice_date')
        .order('invoice_date', { ascending: false }).limit(2000),
      withDates(supabase.from('credit_notes')
        .select('id, credit_note_number, credit_note_date, customer_id, customer_name, customer_gstin, place_of_supply, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled'), r, 'credit_note_date')
        .limit(1000),
    ])

    const invoices = (invRes.data || []) as RegInvoice[]
    const creditNotes: RegInvoice[] = ((cnRes.data || []) as any[]).map(cn => ({
      id: cn.id,
      invoice_number: cn.credit_note_number,
      invoice_date: cn.credit_note_date,
      customer_id: cn.customer_id ?? null,
      customer_name: cn.customer_name,
      customer_gstin: cn.customer_gstin,
      place_of_supply: cn.place_of_supply,
      taxable_amount: cn.taxable_amount,
      cgst_amount: cn.cgst_amount,
      sgst_amount: cn.sgst_amount,
      igst_amount: cn.igst_amount,
      cess_amount: cn.cess_amount,
      grand_total: cn.grand_total,
      document_type: 'credit_note' as const,
    }))

    setTruncated((invRes.data || []).length >= 2000)
    setDocs([...invoices, ...creditNotes])

    const [invItems, cnItems] = await Promise.all([
      fetchItems(supabase, 'invoice_items', 'invoice_id', invoices.map(i => i.id)),
      fetchItems(supabase, 'credit_note_items', 'credit_note_id', creditNotes.map(c => c.id)),
    ])
    setItems([...invItems, ...cnItems])
  }

  function applyPreset(k: string) {
    const r = presetRange(k)
    setPreset(k); setRange(r); setSort(null)
    if (orgId) loadRange(orgId, r)
  }

  function applyCustom(which: 'from' | 'to', value: string) {
    const r = { ...range, [which]: value }
    setPreset('custom'); setRange(r)
    if (orgId) loadRange(orgId, r)
  }

  const filteredDocs = useMemo(() => {
    if (!search.trim()) return docs
    const q = search.trim().toLowerCase()
    return docs.filter(d =>
      (d.customer_name || '').toLowerCase().includes(q) ||
      d.invoice_number.toLowerCase().includes(q) ||
      (d.customer_gstin || '').toLowerCase().includes(q)
    )
  }, [docs, search])

  const visibleDocIds = useMemo(() => new Set(filteredDocs.map(d => d.id)), [filteredDocs])
  const visibleItems = useMemo(() => items.filter(it => visibleDocIds.has(it.invoice_id)), [items, visibleDocIds])

  const partyRows = useMemo(() => partyWiseSales(filteredDocs), [filteredDocs])
  const hsnRows = useMemo(() => hsnSummary(visibleItems, filteredDocs), [visibleItems, filteredDocs])
  const b2bRows = useMemo(() => b2bRegister(filteredDocs), [filteredDocs])
  const stateRows = useMemo(() => stateWiseSales(filteredDocs), [filteredDocs])

  const filteredEwb = useMemo(() => {
    if (!search.trim()) return ewbLog
    const q = search.trim().toLowerCase()
    return ewbLog.filter(e =>
      e.invoiceNumber.toLowerCase().includes(q) || e.party.toLowerCase().includes(q) ||
      e.ewbNo.includes(q) || (e.vehicleNumber || '').toLowerCase().includes(q)
    )
  }, [ewbLog, search])

  const grand = totalsOf(partyRows)
  const creditNoteValue = docs.filter(d => d.document_type === 'credit_note')
    .reduce((s, d) => s + Number(d.taxable_amount || 0), 0)

  function deleteEwb(invoiceId: string) { setEwbLog(removeEwbEntry(orgId, invoiceId)) }

  const columns = useMemo(
    () => buildColumns(tab, id => docs.find(d => d.id === id), deleteEwb),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab, docs, orgId]
  )

  const rows: any[] = tab === 'party' ? partyRows
    : tab === 'hsn' ? hsnRows
    : tab === 'b2b' ? b2bRows
    : tab === 'state' ? stateRows
    : filteredEwb

  const sortedRows = useMemo(() => {
    if (!sort) return rows
    const col = columns.find(c => c.key === sort.key)
    if (!col?.sort) return rows
    return [...rows].sort((a, b) => {
      const av = col.sort!(a), bv = col.sort!(b)
      if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv)) * sort.dir
      return (Number(av) - Number(bv)) * sort.dir
    })
  }, [rows, columns, sort])

  const totals = tab === 'party' || tab === 'b2b' || tab === 'state' || tab === 'hsn'
    ? totalsOf(sortedRows.map(r => ({ ...r, cess: r.cess ?? 0, total: r.total ?? r.taxable + r.tax })))
    : null

  function exportCsv() {
    const name = `taxflow-${tab}-register-${range.from || 'all'}-${range.to || 'all'}.csv`
    download(name, toCsv(columns.map(c => c.label), sortedRows.map(r => columns.map(c => c.csv(r)))))
  }

  function saveEwb() {
    const inv = docs.find(d => d.id === ewbForm.invoiceId)
    if (!inv || ewbForm.ewbNo.trim().length < 12 || !ewbForm.validityEnd || !orgId) return
    const entry: EwbEntry = {
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      party: inv.customer_name || 'Unnamed',
      ewbNo: ewbForm.ewbNo.trim(),
      validityEnd: ewbForm.validityEnd,
      vehicleNumber: ewbForm.vehicleNumber.trim().toUpperCase(),
      transportMode: ewbForm.transportMode,
      distanceKm: ewbForm.distanceKm,
      goodsValue: Number(inv.taxable_amount) || 0,
      source: 'manual',
      createdAt: new Date().toISOString(),
    }
    setEwbLog(upsertEwbEntry(orgId, entry))
    setEwbForm({ invoiceId: '', ewbNo: '', validityEnd: '', vehicleNumber: '', transportMode: 'Road', distanceKm: '' })
  }

  const grid = columns.map(c => c.width ?? '1fr').join(' ')

  if (loading) {
    return (
      <div className="page-container" style={{ maxWidth: 1240 }}>
        <div style={{ height: 84, borderRadius: 16, background: 'linear-gradient(115deg,#dbe6f7,#eef2f9)' }} />
        <div style={{ height: 260, borderRadius: 16, background: 'var(--surface)', border: '1px solid var(--line)', marginTop: '1rem' }} />
      </div>
    )
  }

  return (
    <div className="page-container" style={{ maxWidth: 1240 }}>
      <PageHeader
        eyebrow={`${orgName} · ${range.from ? `${formatDateIN(range.from)} → ${formatDateIN(range.to)}` : 'All time'}`}
        title="Statutory registers"
        subtitle={`${docs.length} documents · ${items.length} line items read from your books`}
        actions={
          <>
            <Button variant="subtle" icon="download" onClick={exportCsv} title="Export every row you can see, not just this screen">CSV</Button>
            <Button variant="ghost" icon="printer" onClick={() => window.print()}>Print</Button>
          </>
        }
        right={
          <Segmented
            value={preset}
            onChange={applyPreset}
            options={[
              { value: 'fy', label: `FY ${getFinancialYear()}` },
              { value: 'quarter', label: 'Quarter' },
              { value: 'month', label: 'Month' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
      />

      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="Taxable value" value={formatCompactINR(grand.taxable)} sub={`${docs.length} documents`} icon="invoice" tone="blue" />
        <StatCard label="GST charged" value={formatCompactINR(grand.cgst + grand.sgst + grand.igst + grand.cess)}
          sub={`Inter-state ${formatCompactINR(grand.igst)}`} icon="percent" tone="violet" />
        <StatCard label="Invoice value" value={formatCompactINR(grand.total)} sub="Taxable plus tax" icon="wallet" tone="cyan" />
        <StatCard label="Credit notes" value={formatCompactINR(creditNoteValue)} sub="Already netted off above" icon="credit-note" tone="amber" />
      </div>

      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div className="tf-row-between tf-wrap" style={{ padding: '0.8rem 1rem', gap: 12 }}>
          <div className="tab-bar" style={{ flex: 1, minWidth: 0 }}>
            {TABS.map(t => (
              <button key={t.value} onClick={() => { setTab(t.value); setSort(null) }}
                className={`reg-tab ${tab === t.value ? 'is-on' : ''}`}>
                <Icon name={t.icon} size={14} /> {t.label}
              </button>
            ))}
          </div>
          <div className="tf-row no-print" style={{ gap: 8 }}>
            <div style={{ position: 'relative' }}>
              <Icon name="search" size={14} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--faint)' }} />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter" className="reg-search" />
            </div>
            <input type="date" value={range.from} onChange={e => applyCustom('from', e.target.value)} className="reg-date" aria-label="From date" />
            <input type="date" value={range.to} onChange={e => applyCustom('to', e.target.value)} className="reg-date" aria-label="To date" />
          </div>
        </div>

        {tab === 'ewb' && (
          <div className="tf-row tf-wrap no-print" style={{ gap: 8, padding: '0.75rem 1rem', borderTop: '1px dashed var(--line)', borderBottom: '1px solid var(--line-soft)' }}>
            <select value={ewbForm.invoiceId} onChange={e => setEwbForm(f => ({ ...f, invoiceId: e.target.value }))} className="reg-select" style={{ maxWidth: 240 }}>
              <option value="">Invoice…</option>
              {docs.filter(d => d.document_type !== 'credit_note').map(d => (
                <option key={d.id} value={d.id}>{d.invoice_number} — {d.customer_name}</option>
              ))}
            </select>
            <input value={ewbForm.ewbNo} onChange={e => setEwbForm(f => ({ ...f, ewbNo: e.target.value.replace(/\D/g, '').slice(0, 12) }))}
              placeholder="EWB no." className="reg-input" style={{ width: 140 }} inputMode="numeric" />
            <input type="date" value={ewbForm.validityEnd} onChange={e => setEwbForm(f => ({ ...f, validityEnd: e.target.value }))} className="reg-date" />
            <input value={ewbForm.vehicleNumber} onChange={e => setEwbForm(f => ({ ...f, vehicleNumber: e.target.value }))}
              placeholder="Vehicle no." className="reg-input" style={{ width: 120 }} />
            <select value={ewbForm.transportMode} onChange={e => setEwbForm(f => ({ ...f, transportMode: e.target.value }))} className="reg-select">
              {['Road', 'Rail', 'Air', 'Ship'].map(m => <option key={m}>{m}</option>)}
            </select>
            <input value={ewbForm.distanceKm} onChange={e => setEwbForm(f => ({ ...f, distanceKm: e.target.value }))}
              placeholder="Km" className="reg-input" style={{ width: 68 }} inputMode="numeric" />
            <Button size="sm" icon="plus" onClick={saveEwb} title="Needs an invoice, a 12-digit EWB number and its validity date">Save entry</Button>
          </div>
        )}

        {sortedRows.length === 0 ? (
          <EmptyState
            icon={tab === 'ewb' ? 'cart' : 'chart'}
            title={tab === 'ewb' ? 'No e-way bills logged' : 'Nothing in this period'}
            message={tab === 'ewb'
              ? 'Record the EWB number from the GST portal against each dispatch — lapsed validity is the most common reason goods get detained at a check post.'
              : 'Widen the date range, or clear the filter above.'}
          />
        ) : (
          <div className="table-scroll">
            <div className="reg-grid">
              <div className="reg-cols reg-head" style={{ gridTemplateColumns: grid }}>
                {columns.map(c => (
                  <button key={c.key} type="button"
                    className={`reg-th ${c.align === 'right' ? 'is-right' : ''} ${sort?.key === c.key ? 'is-sorted' : ''}`}
                    disabled={!c.sort}
                    onClick={() => setSort(s => ({ key: c.key, dir: s?.key === c.key && s.dir === 1 ? -1 : 1 }))}>
                    {c.label}
                    {c.sort && <Icon name={sort?.key === c.key && sort.dir === -1 ? 'arrow-down' : 'arrow-up'} size={11} />}
                  </button>
                ))}
              </div>

              {sortedRows.map((row, i) => (
                <div key={row.key || row.invoiceId || row.hsn || row.code || i}
                  className="reg-cols reg-row tf-tr" style={{ gridTemplateColumns: grid }}>
                  {columns.map(c => (
                    <span key={c.key} data-label={c.label || ' '} className={`reg-td ${c.align === 'right' ? 'is-right' : ''}`}>
                      {c.render(row)}
                    </span>
                  ))}
                </div>
              ))}

              {totals && (
                <div className="reg-cols reg-foot" style={{ gridTemplateColumns: grid }}>
                  {columns.map(c => <span key={c.key} data-label={c.label}>{footCell(c.key, totals, tab)}</span>)}
                </div>
              )}
            </div>
          </div>
        )}

        {truncated && (
          <div style={{ padding: '0.7rem 1rem', fontSize: 12, color: 'var(--amber)', background: 'var(--amber-soft)', borderTop: '1px solid #fde68a' }}>
            Over 2,000 documents matched — figures cover the newest 2,000 only. Narrow the period for a complete register.
          </div>
        )}
      </Card>

      <div className="tf-row tf-wrap" style={{ gap: 12, fontSize: 12, color: 'var(--muted)' }}>
        <span>Cancelled documents are excluded.</span>
        <Link href="/gst/gstr1" style={{ color: 'var(--brand)', textDecoration: 'none' }}>GSTR-1 summary →</Link>
        <Link href="/reports" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Business reports →</Link>
        <Link href="/ledger" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Party statements →</Link>
      </div>

      <style>{`
        .reg-tab {
          display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
          font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--muted);
          background: transparent; border: none; border-bottom: 2px solid transparent;
          padding: 8px 10px; cursor: pointer; min-height: 0;
        }
        .reg-tab.is-on { color: var(--brand); border-bottom-color: var(--brand); }
        .reg-search, .reg-date, .reg-select, .reg-input {
          font-family: inherit; font-size: 12.5px; color: var(--ink);
          border: 1px solid var(--line); border-radius: 8px; background: var(--surface);
          padding: 8px 10px; min-height: 0;
        }
        .reg-search { padding-left: 29px; width: 150px; }
        .reg-search:focus, .reg-date:focus, .reg-select:focus, .reg-input:focus {
          outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring);
        }
        .reg-grid { min-width: 760px; }
        .reg-cols {
          display: grid; align-items: center; gap: 12px;
          padding: 10px 1rem; border-bottom: 1px solid var(--line-soft);
        }
        .reg-head { background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .reg-th {
          display: inline-flex; align-items: center; gap: 4px; justify-content: flex-start;
          font-family: inherit; font-size: 10.5px; font-weight: 700; letter-spacing: .06em;
          text-transform: uppercase; color: var(--faint);
          background: none; border: none; cursor: pointer; padding: 0; min-height: 0;
        }
        .reg-th:disabled { cursor: default; }
        .reg-th.is-right { justify-content: flex-end; }
        .reg-th.is-sorted { color: var(--brand); }
        .reg-row:hover { background: #f9fbfe; }
        .reg-td { font-size: 13px; color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .reg-td.is-right { text-align: right; }
        .reg-foot { background: var(--surface-2); font-weight: 700; color: var(--ink); font-size: 13px; }
        .reg-del {
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; min-height: 0; border-radius: 7px; cursor: pointer;
          border: 1px solid var(--line); background: var(--surface); color: var(--faint);
        }
        .reg-del:hover { color: var(--red); border-color: #fecaca; background: var(--red-soft); }
        @media (max-width: 768px) {
          .reg-grid { min-width: 0; }
          .reg-head { display: none !important; }
          .reg-cols { grid-template-columns: 1fr !important; gap: 5px; padding: 12px 14px; }
          .reg-row { border: 1px solid var(--line); border-radius: 12px; margin: 0 0.6rem 10px; background: var(--surface); }
          .reg-td { display: flex; justify-content: space-between; align-items: center; gap: 12px; text-align: right; white-space: normal; }
          .reg-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: .05em; text-align: left;
          }
          .reg-foot { border-radius: 12px; margin-bottom: 0.6rem; }
        }
        @media print {
          .no-print, .tf-pagehead { display: none !important; }
          .reg-head { background: #f1f5f9; }
          .reg-grid { min-width: 0; }
        }
      `}</style>
    </div>
  )
}

function money(v: number) {
  return `₹${formatINR(v)}`
}

function trimNum(n: number) {
  return n % 1 === 0 ? formatINR(n) : n.toFixed(2)
}

function buildColumns(tab: Tab, findDoc: (id: string) => RegInvoice | undefined, onDeleteEwb: (invoiceId: string) => void): Col[] {
  if (tab === 'party') return [
    {
      key: 'party', label: 'Party', width: '2fr', sort: r => r.party.toLowerCase(),
      csv: r => r.party,
      render: (r: any) => (
        <span className="tf-row" style={{ gap: 8, minWidth: 0 }}>
          <span style={{ fontWeight: 620, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.party}</span>
          <Badge tone={r.isB2B ? 'blue' : 'grey'} dot={false}>{r.isB2B ? 'B2B' : 'B2C'}</Badge>
        </span>
      ),
    },
    { key: 'gstin', label: 'GSTIN', width: '1.3fr', sort: r => r.gstin, csv: r => r.gstin, render: (r: any) => <span className="tf-num" style={{ color: r.gstin ? 'var(--ink-2)' : 'var(--faint)' }}>{r.gstin || 'Unregistered'}</span> },
    { key: 'invoiceCount', label: 'Docs', width: '0.5fr', align: 'right', sort: r => r.invoiceCount, csv: r => r.invoiceCount, render: (r: any) => <span className="tf-num">{r.invoiceCount}</span> },
    { key: 'taxable', label: 'Taxable', width: '1fr', align: 'right', sort: r => r.taxable, csv: r => r.taxable, render: (r: any) => <span className="tf-num" style={{ fontWeight: 620 }}>{money(r.taxable)}</span> },
    { key: 'cgst', label: 'CGST + SGST', width: '1fr', align: 'right', sort: r => r.cgst + r.sgst, csv: r => Math.round((r.cgst + r.sgst) * 100) / 100, render: (r: any) => <span className="tf-num">{money(r.cgst + r.sgst)}</span> },
    { key: 'igst', label: 'IGST', width: '.9fr', align: 'right', sort: r => r.igst, csv: r => r.igst, render: (r: any) => <span className="tf-num">{money(r.igst)}</span> },
    { key: 'total', label: 'Total', width: '1fr', align: 'right', sort: r => r.total, csv: r => r.total, render: (r: any) => <span className="tf-num" style={{ fontWeight: 700 }}>{money(r.total)}</span> },
  ]

  if (tab === 'hsn') return [
    {
      key: 'hsn', label: 'HSN / SAC', width: '.9fr', sort: r => r.hsn, csv: r => r.hsn,
      render: (r: any) => (
        <span className="tf-row" style={{ gap: 7 }}>
          <span className="tf-num" style={{ fontWeight: 650, color: 'var(--ink)' }}>{r.hsn}</span>
          {r.exempt && <Badge tone="green" dot={false}>exempt</Badge>}
        </span>
      ),
    },
    { key: 'descriptions', label: 'Description', width: '2fr', sort: r => r.descriptions[0] || '', csv: r => r.descriptions.join(' | '), render: (r: any) => <span style={{ color: 'var(--ink-2)' }}>{r.descriptions.join(', ')}</span> },
    { key: 'units', label: 'Unit', width: '.7fr', sort: r => r.units.join('/'), csv: r => r.units.join('/'), render: (r: any) => <span style={{ color: 'var(--muted)' }}>{r.units.join(' / ')}</span> },
    { key: 'quantity', label: 'Qty', width: '.8fr', align: 'right', sort: r => r.quantity, csv: r => r.quantity, render: (r: any) => <span className="tf-num">{r.quantity ? trimNum(r.quantity) : '—'}</span> },
    { key: 'rates', label: 'GST %', width: '.8fr', align: 'right', sort: r => r.rates[0] || 0, csv: r => r.rates.join('/'), render: (r: any) => <span className="tf-num">{r.rates.length ? r.rates.map((x: number) => `${x}%`).join(' / ') : '—'}</span> },
    { key: 'taxable', label: 'Taxable', width: '1fr', align: 'right', sort: r => r.taxable, csv: r => r.taxable, render: (r: any) => <span className="tf-num" style={{ fontWeight: 620 }}>{money(r.taxable)}</span> },
    { key: 'tax', label: 'Tax', width: '1fr', align: 'right', sort: r => r.tax, csv: r => r.tax, render: (r: any) => <span className="tf-num">{money(r.tax)}</span> },
  ]

  if (tab === 'b2b') return [
    {
      key: 'invoiceNumber', label: 'Document', width: '1fr', sort: r => r.invoiceNumber, csv: r => r.invoiceNumber,
      render: (r: any) => (
        <span className="tf-col" style={{ gap: 2, alignItems: 'flex-start' }}>
          {r.documentType === 'credit_note'
            ? <span style={{ color: 'var(--amber)', fontWeight: 620 }}>{r.invoiceNumber}</span>
            : <Link href={`/invoices/${r.invoiceId}`} style={{ color: 'var(--brand)', fontWeight: 620, textDecoration: 'none' }}>{r.invoiceNumber}</Link>}
          <span style={{ fontSize: 11, color: 'var(--faint)' }}>{formatDateIN(r.invoiceDate)}</span>
        </span>
      ),
    },
    { key: 'party', label: 'Recipient', width: '1.6fr', sort: r => r.party.toLowerCase(), csv: r => r.party, render: (r: any) => <span style={{ fontWeight: 600, color: 'var(--ink)' }}>{r.party}</span> },
    { key: 'gstin', label: 'GSTIN', width: '1.3fr', sort: r => r.gstin, csv: r => r.gstin, render: (r: any) => <span className="tf-num">{r.gstin}</span> },
    { key: 'placeOfSupply', label: 'Place of supply', width: '1.2fr', sort: r => r.placeOfSupply, csv: r => `${r.placeOfSupply} ${r.stateName}`, render: (r: any) => <span style={{ color: 'var(--muted)' }}>{r.placeOfSupply} · {r.stateName}</span> },
    { key: 'taxable', label: 'Taxable', width: '1fr', align: 'right', sort: r => r.taxable, csv: r => r.taxable, render: (r: any) => <span className="tf-num" style={{ fontWeight: 620 }}>{money(r.taxable)}</span> },
    { key: 'tax', label: 'Tax', width: '1fr', align: 'right', sort: r => r.cgst + r.sgst + r.igst, csv: r => Math.round((r.cgst + r.sgst + r.igst + r.cess) * 100) / 100, render: (r: any) => <span className="tf-num" style={{ color: r.taxable < 0 ? 'var(--red)' : 'var(--muted)' }}>{money(r.cgst + r.sgst + r.igst + r.cess)}</span> },
    { key: 'total', label: 'Invoice value', width: '1fr', align: 'right', sort: r => r.total, csv: r => r.total, render: (r: any) => <span className="tf-num" style={{ fontWeight: 700, color: r.total < 0 ? 'var(--red)' : 'var(--ink)' }}>{money(r.total)}</span> },
  ]

  if (tab === 'state') return [
    { key: 'code', label: 'Code', width: '.6fr', sort: r => r.code, csv: r => r.code, render: (r: any) => <span className="tf-num" style={{ color: 'var(--muted)' }}>{r.code}</span> },
    { key: 'state', label: 'State / UT', width: '2fr', sort: r => r.state, csv: r => r.state, render: (r: any) => <span style={{ fontWeight: 620, color: 'var(--ink)' }}>{r.state}</span> },
    { key: 'invoiceCount', label: 'Docs', width: '.5fr', align: 'right', sort: r => r.invoiceCount, csv: r => r.invoiceCount, render: (r: any) => <span className="tf-num">{r.invoiceCount}</span> },
    { key: 'taxable', label: 'Taxable', width: '1.1fr', align: 'right', sort: r => r.taxable, csv: r => r.taxable, render: (r: any) => <span className="tf-num" style={{ fontWeight: 620 }}>{money(r.taxable)}</span> },
    { key: 'cgst', label: 'CGST', width: '.9fr', align: 'right', sort: r => r.cgst, csv: r => r.cgst, render: (r: any) => <span className="tf-num">{money(r.cgst)}</span> },
    { key: 'sgst', label: 'SGST', width: '.9fr', align: 'right', sort: r => r.sgst, csv: r => r.sgst, render: (r: any) => <span className="tf-num">{money(r.sgst)}</span> },
    { key: 'igst', label: 'IGST', width: '.9fr', align: 'right', sort: r => r.igst, csv: r => r.igst, render: (r: any) => <span className="tf-num">{money(r.igst)}</span> },
    { key: 'total', label: 'Total', width: '1.1fr', align: 'right', sort: r => r.total, csv: r => r.total, render: (r: any) => <span className="tf-num" style={{ fontWeight: 700 }}>{money(r.total)}</span> },
  ]

  return [
    {
      key: 'invoiceNumber', label: 'Invoice', width: '1fr', sort: r => r.invoiceNumber, csv: r => r.invoiceNumber,
      render: (r: any) => findDoc(r.invoiceId)
        ? <Link href={`/invoices/${r.invoiceId}`} style={{ color: 'var(--brand)', fontWeight: 620, textDecoration: 'none' }}>{r.invoiceNumber}</Link>
        : <span style={{ fontWeight: 620 }}>{r.invoiceNumber}</span>,
    },
    { key: 'party', label: 'Consignee', width: '1.5fr', sort: r => r.party.toLowerCase(), csv: r => r.party, render: (r: any) => <span style={{ color: 'var(--ink)' }}>{r.party}</span> },
    { key: 'ewbNo', label: 'EWB number', width: '1.2fr', sort: r => r.ewbNo, csv: r => r.ewbNo, render: (r: any) => <span className="tf-num" style={{ fontWeight: 600 }}>{r.ewbNo}</span> },
    {
      key: 'validityEnd', label: 'Validity', width: '1.2fr', sort: r => r.validityEnd, csv: r => r.validityEnd,
      render: (r: any) => {
        const left = daysUntil(r.validityEnd)
        return (
          <span className="tf-row" style={{ gap: 7, justifyContent: 'flex-start' }}>
            <span className="tf-num" style={{ color: 'var(--muted)' }}>{formatDateIN(r.validityEnd)}</span>
            {left < 0 ? <Badge tone="red" dot={false}>expired</Badge>
              : left <= 1 ? <Badge tone="amber" dot={false}>{left}d left</Badge> : null}
          </span>
        )
      },
    },
    { key: 'vehicleNumber', label: 'Vehicle', width: '.9fr', sort: r => r.vehicleNumber || '', csv: r => r.vehicleNumber || '', render: (r: any) => <span className="tf-num" style={{ color: r.vehicleNumber ? 'var(--ink-2)' : 'var(--faint)' }}>{r.vehicleNumber || '—'}</span> },
    { key: 'transportMode', label: 'Mode', width: '.7fr', sort: r => r.transportMode || '', csv: r => r.transportMode || 'Road', render: (r: any) => <span style={{ color: 'var(--muted)' }}>{r.transportMode || 'Road'}</span> },
    { key: 'goodsValue', label: 'Value', width: '.9fr', align: 'right', sort: r => r.goodsValue || 0, csv: r => r.goodsValue || 0, render: (r: any) => <span className="tf-num">{r.goodsValue ? money(Number(r.goodsValue)) : '—'}</span> },
    {
      key: 'action', label: '', width: '.4fr', align: 'right',
      csv: () => '',
      render: (r: any) => (
        <button type="button" className="reg-del no-print" title="Remove entry" onClick={() => onDeleteEwb(r.invoiceId)}>
          <Icon name="x" size={13} />
        </button>
      ),
    },
  ]
}

function footCell(key: string, totals: any, tab: Tab) {
  if (['party', 'state', 'invoiceNumber', 'hsn', 'descriptions'].includes(key)) return 'Register total'
  const map: Record<string, number> = {
    taxable: totals.taxable, cgst: totals.cgst, sgst: totals.sgst,
    igst: totals.igst, total: totals.total, tax: totals.cgst + totals.sgst + totals.igst + totals.cess,
  }
  return key in map ? money(map[key]) : ''
}

function withDates(query: any, r: { from: string; to: string }, column: string) {
  return r.from ? query.gte(column, r.from).lte(column, r.to || '9999-12-31') : query
}
