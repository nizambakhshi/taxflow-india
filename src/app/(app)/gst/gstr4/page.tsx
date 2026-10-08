/**
 * GSTR-4 / CMP-08 composition workpaper.
 *
 * The scheme is the one place where "less tax" and "less paperwork" do not go
 * together: the dealer charges a flat slab, takes no credit at all, pays 2.5% of
 * everything bought instead, and can lose the option on a single inter-state
 * bill. So the page leads with eligibility, then the four CMP-08 quarters, then
 * the debit, then the documents that put the option at risk.
 *
 * Everything from the books is derived; the CMP-08 amounts deposited and the
 * value of stock transferred in are declared here and kept in localStorage.
 */

'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { csvFromRows } from '@/lib/gstr9'
import { download } from '@/lib/party-ledger'
import { fyLabel, fyStartYear } from '@/lib/targets'
import {
  COMPOSITION_RATES, DEEMED_ITC_PCT, buildWorkpaper, emptyFy, gstr4Due, loadFy,
  saveFy, workpaperRows,
  type CompDoc, type CompInward, type CompItem, type DeclaredQuarter, type FyState,
} from '@/lib/gstr4'
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'overview' | 'cmp08' | 'debit' | 'risks'

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Turnover & eligibility' },
  { value: 'cmp08', label: 'CMP-08 quarters' },
  { value: 'debit', label: `Deemed debit ${DEEMED_ITC_PCT}%` },
  { value: 'risks', label: 'Scheme risks' },
]

/** A return is filed in whole rupees, and so is this workpaper. */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (v: number) => {
  const n = Math.round(Number(v) || 0)
  return n < 0 ? `−₹${inr.format(-n)}` : `₹${inr.format(n)}`
}

interface Column {
  label: string
  width?: string
  amount?: boolean
  lead?: boolean
  render: (row: Record<string, unknown>) => ReactNode
}

function Grid({ columns, rows, empty }: { columns: Column[]; rows: Record<string, unknown>[]; empty: string }) {
  const grid = columns.map(c => c.width ?? '1fr').join(' ')
  if (!rows.length) return <div className="g4-clear">{empty}</div>
  return (
    <div className="table-scroll">
      <div className="responsive-table">
        <div className="g4-cols g4-head" style={{ gridTemplateColumns: grid }}>
          {columns.map(c => <span key={c.label} className={c.amount ? 'is-right' : undefined}>{c.label}</span>)}
        </div>
        {rows.map((row, i) => (
          <div key={i} className="g4-cols g4-row tf-tr" style={{ gridTemplateColumns: grid }}>
            {columns.map(c => (
              <span key={c.label} data-label={c.lead ? '' : c.label}
                className={`g4-td ${c.amount ? 'is-right' : ''} ${c.lead ? 'is-lead' : ''}`}>
                {c.render(row)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Gstr4Page() {
  const router = useRouter()
  const supabase = createClient()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [gstin, setGstin] = useState('')
  const [stateCode, setStateCode] = useState('')
  const [registrationType, setRegistrationType] = useState('regular')

  const [fyStart, setFyStart] = useState(() => fyStartYear(new Date()))
  const [asOf] = useState(() => new Date())
  const [docs, setDocs] = useState<CompDoc[]>([])
  const [items, setItems] = useState<CompItem[]>([])
  const [inward, setInward] = useState<CompInward[]>([])
  const [state, setState] = useState<FyState>(emptyFy())
  const [tab, setTab] = useState<Tab>('overview')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

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
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')

      const { data: reg } = await supabase
        .from('gst_registrations').select('gstin, state_code, registration_type')
        .eq('organization_id', oid).eq('is_primary', true).single()
      setGstin(reg?.gstin || '')
      setStateCode(reg?.state_code || '')
      setRegistrationType(reg?.registration_type || 'regular')

      setState(loadFy(oid, fyStart))
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // One period of documents. Changing the year re-reads them, the declaration and the grid.
  useEffect(() => {
    if (!orgId) return
    let stale = false
    async function run() {
      const from = `${fyStart}-04-01`
      const to = `${fyStart + 1}-03-31`
      const [invRes, cnRes, billRes, expRes] = await Promise.all([
        supabase.from('invoices')
          .select('id, invoice_number, invoice_date, invoice_type, customer_name, customer_gstin, place_of_supply, supply_type, is_reverse_charge, taxable_amount, igst_amount, cgst_amount, sgst_amount, cess_amount, grand_total')
          .eq('organization_id', orgId).neq('status', 'cancelled')
          .gte('invoice_date', from).lte('invoice_date', to).limit(5000),
        supabase.from('credit_notes')
          .select('id, credit_note_number, credit_note_date, customer_name, customer_gstin, place_of_supply, supply_type, taxable_amount, igst_amount, cgst_amount, sgst_amount, cess_amount, grand_total')
          .eq('organization_id', orgId).neq('status', 'cancelled')
          .gte('credit_note_date', from).lte('credit_note_date', to).limit(2000),
        supabase.from('purchase_bills')
          .select('id, bill_number, bill_date, vendor_name, vendor_gstin, is_reverse_charge, taxable_amount, igst_amount, cgst_amount, sgst_amount, cess_amount')
          .eq('organization_id', orgId).neq('status', 'cancelled')
          .gte('bill_date', from).lte('bill_date', to).limit(5000),
        supabase.from('expenses')
          .select('id, bill_number, expense_date, vendor_name, vendor_gstin, gst_amount, taxable_amount')
          .eq('organization_id', orgId)
          .gte('expense_date', from).lte('expense_date', to).limit(5000),
      ])
      if (stale) return
      // A different year carries a different declaration, so it is re-read here too.
      setState(loadFy(orgId, fyStart))
      setError(invRes.error ? `Could not read the year: ${invRes.error.message}` : '')

      const invoices: CompDoc[] = ((invRes.data || []) as Record<string, unknown>[]).map(r => ({
        id: String(r.id), number: String(r.invoice_number || ''), date: (r.invoice_date as string) ?? null,
        kind: 'invoice' as const, invoiceType: (r.invoice_type as string) ?? null,
        party: (r.customer_name as string) ?? null, gstin: (r.customer_gstin as string) ?? null,
        placeOfSupply: (r.place_of_supply as string) ?? null, supplyType: (r.supply_type as string) ?? null,
        reverseCharge: !!r.is_reverse_charge,
        taxable: Number(r.taxable_amount || 0), igst: Number(r.igst_amount || 0),
        cgst: Number(r.cgst_amount || 0), sgst: Number(r.sgst_amount || 0), cess: Number(r.cess_amount || 0),
        total: Number(r.grand_total || 0),
      }))
      const creditNotes: CompDoc[] = ((cnRes.data || []) as Record<string, unknown>[]).map(r => ({
        id: String(r.id), number: String(r.credit_note_number || ''), date: (r.credit_note_date as string) ?? null,
        kind: 'credit_note' as const, invoiceType: null,
        party: (r.customer_name as string) ?? null, gstin: (r.customer_gstin as string) ?? null,
        placeOfSupply: (r.place_of_supply as string) ?? null, supplyType: (r.supply_type as string) ?? null,
        taxable: Number(r.taxable_amount || 0), igst: Number(r.igst_amount || 0),
        cgst: Number(r.cgst_amount || 0), sgst: Number(r.sgst_amount || 0), cess: Number(r.cess_amount || 0),
        total: Number(r.grand_total || 0),
      }))
      const all = [...invoices, ...creditNotes]
      setDocs(all)

      const bills: CompInward[] = ((billRes.data || []) as Record<string, unknown>[]).map(r => ({
        id: String(r.id), number: String(r.bill_number || ''), date: (r.bill_date as string) ?? null,
        party: (r.vendor_name as string) ?? null, gstin: (r.vendor_gstin as string) ?? null,
        taxable: Number(r.taxable_amount || 0),
        tax: Number(r.igst_amount || 0) + Number(r.cgst_amount || 0) + Number(r.sgst_amount || 0) + Number(r.cess_amount || 0),
        reverseCharge: !!r.is_reverse_charge, source: 'bill' as const,
      }))
      const expenses: CompInward[] = ((expRes.data || []) as Record<string, unknown>[]).map(r => ({
        id: String(r.id), number: String(r.bill_number || ''), date: (r.expense_date as string) ?? null,
        party: (r.vendor_name as string) ?? null, gstin: (r.vendor_gstin as string) ?? null,
        taxable: Number(r.taxable_amount || 0), tax: Number(r.gst_amount || 0), source: 'expense' as const,
      }))
      setInward([...bills, ...expenses])

      // Lines carry the HSN/SAC that decides goods versus services. Chunked at 500
      // ids because Supabase rejects an unbounded `in=(…)`.
      const ids = all.map(d => d.id)
      const fetched: CompItem[] = []
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await supabase.from('invoice_items')
          .select('invoice_id, hsn_sac, taxable_value')
          .in('invoice_id', ids.slice(i, i + 500)).limit(5000)
        for (const r of ((data || []) as Record<string, unknown>[])) {
          fetched.push({ docId: String(r.invoice_id), hsnSac: (r.hsn_sac as string) ?? null, taxable: Number(r.taxable_value || 0) })
        }
      }
      for (let i = 0; i < ids.length; i += 500) {
        const { data } = await supabase.from('credit_note_items')
          .select('credit_note_id, hsn_sac, taxable_value')
          .in('credit_note_id', ids.slice(i, i + 500)).limit(5000)
        for (const r of ((data || []) as Record<string, unknown>[])) {
          fetched.push({ docId: String(r.credit_note_id), hsnSac: (r.hsn_sac as string) ?? null, taxable: Number(r.taxable_value || 0) })
        }
      }
      if (!stale) setItems(fetched)
    }
    run()
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, fyStart])

  const wp = useMemo(() => buildWorkpaper({ fyStart, stateCode, docs, items, inward, state }),
    [fyStart, stateCode, docs, items, inward, state])

  const riskCount = wp.risks.filter(r => r.level === 'error').length
  const declaredCount = wp.declaredQuarters
  const dueInDays = Math.round((new Date(gstr4Due(fyStart)).getTime() - asOf.getTime()) / 86400000)

  const years = useMemo(() => {
    const now = fyStartYear(new Date())
    return [now, now - 1, now - 2]
  }, [])

  function commit(next: FyState) {
    setState(orgId ? saveFy(orgId, fyStart, next) : next)
  }

  function declareQuarter(key: string, patch: Partial<DeclaredQuarter>) {
    const current = state.quarters[key] || { taxable: 0, igst: 0, cgst: 0, sgst: 0 }
    const merged = { ...current, ...patch }
    const blank = !merged.taxable && !merged.igst && !merged.cgst && !merged.sgst
    const quarters = { ...state.quarters }
    if (blank) delete quarters[key]
    else quarters[key] = merged
    commit({ ...state, quarters })
  }

  function exportWorkpaper() {
    download(`GSTR4-CMP08-${fyLabel(fyStart)}.csv`, csvFromRows(workpaperRows({ orgName, gstin, fyStart, wp })))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the composition year…</div>
  }

  const empty = docs.length === 0 && inward.length === 0

  return (
    <div className="page-container g4" style={{ maxWidth: 1120 }}>
      <PageHeader
        eyebrow="GST compliance"
        title="GSTR-4 · composition workpaper"
        subtitle={`Flat-slab tax you charged, the ${DEEMED_ITC_PCT}% debit in place of credit, and what CMP-08 paid. Annual statement due ${gstr4Due(fyStart)}${dueInDays > 0 ? ` (${dueInDays} days)` : ''}.`}
        actions={
          <Button variant="subtle" size="sm" icon="download" onClick={exportWorkpaper}
            disabled={empty}>Download workpaper CSV</Button>
        }
        right={
          <select className="tf-input" value={fyStart} onChange={e => setFyStart(Number(e.target.value))}
            aria-label="Financial year">
            {years.map(y => <option key={y} value={y}>FY {fyLabel(y)}</option>)}
          </select>
        }
      />

      {error && (
        <div className="g4-alert is-error">
          <Icon name="alert" size={15} />
          <span>{error}</span>
        </div>
      )}
      {registrationType !== 'composition' && (
        <div className="g4-alert is-warn">
          <Icon name="alert" size={15} />
          <span>This GSTIN is recorded as <strong>{registrationType}</strong>, not composition. The workpaper
            still computes, but the slab tests and the barred-supply checks below only describe a composition dealer.
            Change it on <Link href="/setup" className="g4-link">setup</Link>.</span>
        </div>
      )}

      {empty ? (
        <Card>
          <EmptyState icon="invoice" title="Nothing to reconcile for this year"
            message="No bills of supply, credit notes or purchases were found in the selected financial year."
            action={<Button variant="subtle" size="sm" icon="calendar" href="/gst/calendar">Open the filing calendar</Button>} />
        </Card>
      ) : (
        <>
          <div className="g4-metrics">
            <StatCard label="Aggregate taxable turnover" value={wp.split.slabTurnover}
              sub={`${wp.split.documents} documents, GST excluded`} icon="chart" tone="blue" />
            <StatCard label="Tax charged on outward supplies" value={wp.liability.tax}
              sub={`Implied ${wp.quarters.find(q => q.impliedPct)?.impliedPct ?? 0}% across the year`} icon="invoice" tone="violet" />
            <StatCard label={`Deemed debit at ${DEEMED_ITC_PCT}%`} value={wp.deemed.debit}
              sub={`On ${money(wp.deemed.base)} of purchases and services`} icon="percent" tone="amber" />
            <StatCard label="Payable in cash for the year" value={wp.payableInCash}
              sub="Outward tax plus the debit — no credit ledger to offset it" icon="wallet" tone="red" />
          </div>

          <div className="g4-tabs">
            <Segmented value={tab} onChange={v => setTab(v as Tab)} options={TABS} />
            <span className="g4-tabs-note">
              {declaredCount ? `${declaredCount} of 4 quarters declared` : 'Nothing declared yet'}
              {riskCount ? ` · ${riskCount} finding${riskCount > 1 ? 's' : ''} that bar the scheme` : ''}
              {state.updatedAt ? ` · saved ${new Date(state.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}
            </span>
          </div>

          {tab === 'overview' && (
            <>
              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: wp.eligibility.withinLimits ? 'var(--green)' : 'var(--red)' }} />
                    <h2>{wp.eligibility.headline}</h2>
                  </div>
                  <p>{wp.eligibility.reason}</p>
                  <ul className="g4-points">
                    {wp.eligibility.points.map(p => <li key={p}>{p}</li>)}
                  </ul>
                  <div className="g4-headroom">
                    <Badge tone={wp.eligibility.exitRisk ? 'amber' : 'green'} dot={false}>
                      {wp.eligibility.exitRisk ? 'Plan the exit' : 'Room left'}
                    </Badge>
                    <span>{wp.eligibility.headroom >= 0
                      ? `${money(wp.eligibility.headroom)} of headroom under the binding slab`
                      : `${money(-wp.eligibility.headroom)} over the slab that governs`}</span>
                  </div>
                </div>
              </Card>

              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: 'var(--brand)' }} />
                    <h2>Turnover the slab test is applied to</h2>
                  </div>
                  <p>Goods and services are read off the HSN/SAC on each line — a SAC in the 99-series is a service.
                    Turnover is measured after credit notes, and non-GST supplies sit outside the limit entirely.</p>
                </div>
                <Grid
                  columns={[
                    { label: 'Head', width: '2fr', lead: true, render: r => <strong>{String(r.head)}</strong> },
                    { label: 'Value', width: '1.2fr', amount: true, render: r => money(Number(r.value)) },
                    { label: 'Counts towards the limit', width: '1.4fr', render: r => <span>{String(r.counts)}</span> },
                  ]}
                  rows={[
                    { head: 'Taxable supplies of goods', value: wp.split.goods, counts: `Yes — tested against ${money(wp.eligibility.limits.goods)}` },
                    { head: 'Taxable supplies of services', value: wp.split.services, counts: `Yes — tested against ${money(wp.eligibility.limits.services)}` },
                    { head: 'Turnover with no HSN/SAC on its lines', value: wp.split.unknown, counts: 'Tested against both limits' },
                    { head: 'Non-GST supplies', value: wp.split.nonGst, counts: 'No — outside GST altogether' },
                    { head: 'Nil-rated and exempted supplies', value: wp.exempt, counts: 'Yes — exempt supplies still count' },
                  ]}
                  empty="No outward documents in this year."
                />
              </Card>
            </>
          )}

          {tab === 'cmp08' && (
            <>
              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: 'var(--violet)' }} />
                    <h2>Books against what CMP-08 deposited</h2>
                  </div>
                  <p>A composition dealer files CMP-08 for the quarter by the 18th of the following month.
                    Fill what you actually paid; the difference is what the annual statement has to explain.</p>
                </div>
                <Grid
                  columns={[
                    { label: 'Quarter', width: '1.5fr', lead: true, render: r => (
                      <span className="g4-lead"><strong>{String(r.label)}</strong><em>{String(r.months)}</em></span>) },
                    { label: 'Documents', width: '0.8fr', amount: true, render: r => String(r.count) },
                    { label: 'Books taxable', width: '1.2fr', amount: true, render: r => money(Number(r.taxable)) },
                    { label: 'Books tax', width: '1fr', amount: true, render: r => money(Number(r.tax)) },
                    { label: 'Rate on the bills', width: '1fr', amount: true, render: r => `${String(r.pct)}%` },
                    { label: 'Due', width: '1fr', render: r => <span>{String(r.due)}</span> },
                    { label: 'Status', width: '1.2fr', render: r => <Badge tone={r.status === 'matched' ? 'green' : r.status === 'variance' ? 'amber' : 'grey'} dot={false}>{String(r.statusLabel)}</Badge> },
                  ]}
                  rows={wp.quarters.map(q => ({
                    label: q.label, months: q.months.join(' – '), count: q.count,
                    taxable: q.heads.taxable, tax: q.heads.tax, pct: q.impliedPct, due: q.due,
                    status: q.status, statusLabel: q.status === 'matched' ? 'Ties'
                      : q.status === 'variance' ? `${q.headsDiffering.join(' / ')} differ` : 'Not declared',
                  }))}
                  empty="No quarter in this year."
                />
              </Card>

              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: 'var(--cyan)' }} />
                    <h2>What you deposited in CMP-08</h2>
                  </div>
                  <p>Declared here, stored on this device — the portal holds the authoritative figures, so
                    leave a quarter blank until you have its challan.</p>
                </div>
                <div className="g4-declare">
                  {wp.quarters.map(q => (
                    <div key={q.key} className="g4-declare-row">
                      <span className="g4-declare-label">{q.label}</span>
                      {(['taxable', 'igst', 'cgst', 'sgst'] as const).map(field => (
                        <label key={field} className="g4-declare-field">
                          <span>{field === 'taxable' ? 'Taxable' : field.toUpperCase()}</span>
                          <input className="tf-input" type="number" min={0} step="0.01"
                            value={q.declared?.[field] ?? ''}
                            placeholder="0"
                            onChange={e => declareQuarter(q.key, { [field]: Number(e.target.value) || 0 } as Partial<DeclaredQuarter>)} />
                        </label>
                      ))}
                      <span className="g4-declare-diff">
                        {q.status === 'unset' ? '—' : `${q.diff.tax >= 0 ? '+' : '−'}${money(Math.abs(q.diff.tax))}`}
                      </span>
                    </div>
                  ))}
                  <div className="g4-declare-foot">
                    <span>Tax as per books {money(wp.liability.tax)} · declared {money(wp.declaredTotal.tax)} ·
                      difference {money(wp.diffTotal.tax)}</span>
                  </div>
                </div>
              </Card>
            </>
          )}

          {tab === 'debit' && (
            <>
              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: 'var(--amber)' }} />
                    <h2>{DEEMED_ITC_PCT}% of everything bought, in place of credit</h2>
                  </div>
                  <p>A composition taxable person takes no input tax credit. The proviso to section 17(5)(a)
                    replaces it with a flat {DEEMED_ITC_PCT}% of the value of inward supplies, payable in cash.</p>
                </div>
                <Grid
                  columns={[
                    { label: 'Head', width: '2.4fr', lead: true, render: r => <strong>{String(r.label)}</strong> },
                    { label: 'Documents', width: '0.9fr', amount: true, render: r => String(r.count) },
                    { label: 'Value of supplies', width: '1.3fr', amount: true, render: r => money(Number(r.base)) },
                    { label: 'Debit payable', width: '1.2fr', amount: true, render: r => money(Number(r.debit)) },
                    { label: 'Credit you gave up', width: '1.3fr', amount: true, render: r => money(Number(r.forgone)) },
                  ]}
                  rows={[...wp.deemed.buckets.map(b => ({
                    label: b.label, count: b.count, base: b.base, debit: b.debit, forgone: b.creditForgone,
                  })), {
                    label: 'Total', count: wp.deemed.buckets.reduce((s, b) => s + b.count, 0),
                    base: wp.deemed.base, debit: wp.deemed.debit, forgone: wp.deemed.creditForgone,
                  }]}
                  empty="No purchases or expenses in this year."
                />
                <div className="g4-stock">
                  <label className="g4-stock-field">
                    <span>Value of stock transferred in from another GSTIN of the same PAN</span>
                    <input className="tf-input" type="number" min={0} step="0.01" value={state.stockTransferValue || ''}
                      placeholder="0" onChange={e => commit({ ...state, stockTransferValue: Number(e.target.value) || 0 })} />
                  </label>
                  <Button variant="subtle" size="sm" icon="check" onClick={() => commit(state)}>Keep it</Button>
                </div>
              </Card>

              {wp.deemed.rcmExcluded.count > 0 && (
                <div className="g4-alert is-info">
                  <Icon name="percent" size={15} />
                  <span>{wp.deemed.rcmExcluded.count} inward supply(ies) on which you already paid tax under reverse
                    charge ({money(wp.deemed.rcmExcluded.base)} of value, {money(wp.deemed.rcmExcluded.taxPaid)} of tax)
                    are kept out of the {DEEMED_ITC_PCT}% base — charging both would bill the same supply twice.</span>
                </div>
              )}

              <div className="g4-note-box">
                <Icon name="book" size={15} />
                <span>This debit is paid in cash. A composition dealer has no electronic credit ledger, so nothing
                  here can be offset — the payment is a challan, not a set-off.</span>
              </div>
            </>
          )}

          {tab === 'risks' && (
            <>
              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: wp.risks.length ? 'var(--red)' : 'var(--green)' }} />
                    <h2>{wp.risks.length ? `${wp.risks.length} document finding${wp.risks.length > 1 ? 's' : ''}` : 'No barred supply found'}</h2>
                  </div>
                  <p>One inter-state outward bill, one export, one chapter outside the scheme — any of these ends
                    the composition option from the day it happened, not from the year end.</p>
                </div>
                <Grid
                  columns={[
                    { label: 'Finding', width: '2.4fr', lead: true, render: r => (
                      <span className="g4-lead"><strong>{String(r.title)}</strong><em>{String(r.detail)}</em></span>) },
                    { label: 'Documents', width: '0.9fr', amount: true, render: r => String(r.count) },
                    { label: 'Value', width: '1.2fr', amount: true, render: r => money(Number(r.amount)) },
                    { label: 'Severity', width: '1fr', render: r => <Badge tone={r.level === 'error' ? 'red' : 'amber'} dot={false}>{String(r.levelLabel)}</Badge> },
                  ]}
                  rows={wp.risks.map(r => ({
                    title: r.title, detail: `${r.detail}${r.numbers.length ? ` — ${r.numbers.join(', ')}` : ''}`,
                    count: r.count, amount: r.amount, level: r.level, levelLabel: r.level === 'error' ? 'Bars the scheme' : 'Check the paperwork',
                  }))}
                  empty="Every outward document in this year stays inside the scheme."
                />
              </Card>

              <Card pad={false} className="g4-card">
                <div className="g4-card-head">
                  <div className="g4-sect">
                    <span className="g4-chip" style={{ background: 'var(--muted)' }} />
                    <h2>Bills whose rate is not a composition slab</h2>
                  </div>
                  <p>Permitted slabs: {COMPOSITION_RATES.map(r => `${r}%`).join(' · ')}. A bill of supply showing
                    12% or 18% carries tax you are not liable for, and the buyer cannot claim it.</p>
                </div>
                <Grid
                  columns={[
                    { label: 'Document', width: '1.6fr', lead: true, render: r => (
                      <span className="g4-lead"><strong>{String(r.number)}</strong><em>{String(r.date || '')}</em></span>) },
                    { label: 'Taxable', width: '1.2fr', amount: true, render: r => money(Number(r.taxable)) },
                    { label: 'Tax charged', width: '1.2fr', amount: true, render: r => money(Number(r.tax)) },
                    { label: 'Rate on the bill', width: '1.2fr', amount: true, render: r => `${String(r.pct)}%` },
                    { label: 'Closest slab', width: '1.2fr', render: r => <span>{r.nearest === null ? 'none — regular-dealer rate' : `${String(r.nearest)}%`}</span> },
                  ]}
                  rows={wp.anomalies.map(a => ({ ...a, nearest: a.nearest }))}
                  empty="Every bill of supply sits on a permitted slab."
                />
              </Card>

              <div className="g4-foot">
                Eligibility, slab rates and the deemed debit are set by the principal rules and move by notification.
                This workpaper shows the rule it applied next to every figure; the portal form governs what you file.
                Payment deadlines and challans live on <Link href="/gst/calendar" className="g4-link">the filing calendar</Link>.
              </div>
            </>
          )}
        </>
      )}

      <style>{`
        .g4-card { margin-bottom: 1rem; }
        .g4-card-head { padding: 1.1rem 1.3rem 0.15rem; }
        .g4-card-head p { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0.6rem 0 0; max-width: 96ch; }
        .g4-sect { display: flex; align-items: center; gap: 9px; }
        .g4-sect h2 { font-size: 13.5px; font-weight: 700; color: var(--ink); margin: 0; }
        .g4-chip { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }
        .g4-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .g4-tabs { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
        .g4-tabs-note { font-size: 11.5px; color: var(--faint); }
        .g4-points { margin: 0.7rem 0 0; padding-left: 1.1rem; font-size: 12.5px; color: var(--ink-2); line-height: 1.85; }
        .g4-headroom { display: flex; align-items: center; gap: 9px; margin-top: 0.8rem; font-size: 12.5px; color: var(--muted); }
        .g4-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 10px; padding: 11px 1.3rem; align-items: center; }
        .g4-head {
          background: var(--surface-2); font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em;
          text-transform: uppercase; color: var(--faint);
        }
        .g4-head .is-right, .g4-td.is-right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .g4-row { border-bottom: 1px solid var(--line-soft); font-size: 12.5px; color: var(--ink-2); }
        .g4-row:last-child { border-bottom: none; }
        .g4-lead strong { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink); }
        .g4-lead em { display: block; font-style: normal; font-size: 11px; color: var(--muted); margin-top: 2px; }
        .g4-clear { padding: 1rem 1.3rem 1.15rem; font-size: 12.5px; color: var(--faint); }
        .g4-alert {
          display: flex; gap: 9px; align-items: flex-start; padding: 11px 14px; border-radius: var(--radius-sm);
          font-size: 12.5px; line-height: 1.65; margin-bottom: 1rem;
        }
        .g4-alert.is-error { background: var(--red-soft); color: #b91c1c; }
        .g4-alert.is-warn { background: var(--amber-soft); color: #b45309; }
        .g4-alert.is-info { background: var(--cyan-soft); color: #0e7490; }
        .g4-alert svg { flex-shrink: 0; margin-top: 2px; }
        .g4-declare { padding: 0.9rem 1.3rem 1.1rem; }
        .g4-declare-row {
          display: grid; grid-template-columns: 1.6fr repeat(4, minmax(0, 1fr)) 1.1fr; gap: 10px;
          align-items: end; padding: 9px 0; border-bottom: 1px solid var(--line-soft);
        }
        .g4-declare-label { font-size: 12.5px; font-weight: 600; color: var(--ink); }
        .g4-declare-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .g4-declare-field > span { font-size: 10.5px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--faint); }
        .g4-declare-diff { font-size: 12px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
        .g4-declare-foot { padding-top: 10px; font-size: 12px; color: var(--muted); }
        .g4-stock { display: flex; align-items: end; gap: 12px; padding: 0.9rem 1.3rem 1.15rem; flex-wrap: wrap; }
        .g4-stock-field { display: flex; flex-direction: column; gap: 5px; flex: 1; min-width: 240px; }
        .g4-stock-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .g4-note-box {
          display: flex; gap: 9px; align-items: flex-start; padding: 12px 14px; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: var(--radius-sm); font-size: 12.5px; color: var(--muted); line-height: 1.65;
        }
        .g4-note-box svg { flex-shrink: 0; margin-top: 2px; color: var(--faint); }
        .g4-link { color: var(--brand); font-weight: 600; text-decoration: none; margin-left: 4px; }
        .g4-foot { font-size: 11.5px; color: var(--faint); line-height: 1.7; margin-top: 14px; }
        @media (max-width: 768px) {
          .g4-metrics { grid-template-columns: 1fr 1fr; }
          .g4-cols { grid-template-columns: 1fr !important; gap: 5px; padding: 12px 1rem; }
          /* .table-frame goes transparent on mobile, so each row has to card itself. */
          .g4-row {
            border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
            margin: 0 0 10px;
          }
          .g4-row:last-child { margin-bottom: 0; }
          .g4-head { display: none !important; }
          .g4-td {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            text-align: left; white-space: normal;
          }
          .g4-td.is-right { white-space: normal; }
          .g4-td.is-lead { display: block; }
          .g4-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0;
          }
          .g4-td.is-lead::before { content: none; }
          .g4-declare-row { grid-template-columns: 1fr 1fr; }
          .g4-declare-label { grid-column: 1 / -1; }
          .g4-declare-diff { text-align: left; }
        }
      `}</style>
    </div>
  )
}
