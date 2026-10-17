'use client'

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural, pluralNoun } from '@/lib/format'
import { daysUntil } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { fyLabel, fyStartYear, monthShort } from '@/lib/targets'
import {
  ANNUAL_RETURN_EXEMPT_TURNOVER, AUDIT_TURNOVER, ITC_PAYMENT_DEADLINE_DAYS,
  cautions, csvFromRows, eligibility, emptyFy, exemptSupplies, itcTable, itcUnpaid, loadFy, monthlyBooks,
  num, outwardSupplies, rcmSupplies, reconSummary, reconcile9C, saveFy, sumHeads,
  workpaperRows,
  type Dues, type FyState, type Heads, type InwardDoc, type OutwardDoc,
} from '@/lib/gstr9'
import { Badge, Button, Card, EmptyState, PageHeader, SectionTitle, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'outward' | 'itc' | 'recon' | 'dues'

const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'outward', label: 'Table 4 · Outward supplies', icon: 'invoice' },
  { value: 'itc', label: 'Table 5 · Input tax credit', icon: 'cart' },
  { value: 'recon', label: '9C · Books vs 3B', icon: 'compare' },
  { value: 'dues', label: 'Table 8/9 · Dues & payments', icon: 'wallet' },
]

/** A return is filed in whole rupees, and so is this workpaper. */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (v: number) => {
  const n = Math.round(Number(v) || 0)
  return n < 0 ? `−₹${inr.format(-n)}` : `₹${inr.format(n)}`
}

const CAUTION_TONE: Record<string, { fg: string; bg: string; icon: string }> = {
  red: { fg: 'var(--red)', bg: 'var(--red-soft)', icon: 'alert' },
  amber: { fg: 'var(--amber)', bg: 'var(--amber-soft)', icon: 'alert' },
  info: { fg: 'var(--brand)', bg: 'var(--brand-soft)', icon: 'trend' },
}

export default function Gstr9Page() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [gstin, setGstin] = useState('')
  const [registrationType, setRegistrationType] = useState('regular')
  const [stateCode, setStateCode] = useState('')

  // Work on the year that has actually closed; the running one is still filling up.
  const [fyStart, setFyStart] = useState(() => fyStartYear(new Date()) - 1)

  const [docs, setDocs] = useState<OutwardDoc[]>([])
  const [inward, setInward] = useState<InwardDoc[]>([])
  const [debitNotes, setDebitNotes] = useState<InwardDoc[]>([])
  const [state, setState] = useState<FyState>(emptyFy())
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [tab, setTab] = useState<Tab>('outward')
  const [savedAt, setSavedAt] = useState('')
  const [error, setError] = useState('')

  /* FY the workpaper covers, and the documents inside it. */
  const fyRange = useMemo(() => {
    const inProgress = fyStart === fyStartYear(new Date()) && new Date() < new Date(`${fyStart + 1}-04-01`)
    return {
      from: `${fyStart}-04-01`,
      to: `${fyStart + 1}-03-31`,
      inProgress,
      // 180 days are counted to the year end, or to today for a running year.
      asOf: inProgress ? new Date() : new Date(`${fyStart + 1}-03-31T00:00:00`),
      due: `${fyStart + 1}-12-31`,
    }
  }, [fyStart])

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

      const { data: reg } = await supabase
        .from('gst_registrations').select('gstin, state_code, registration_type')
        .eq('organization_id', oid).eq('is_primary', true).single()
      setGstin(reg?.gstin || '')
      setStateCode(reg?.state_code || '')
      setRegistrationType(reg?.registration_type || 'regular')

      setState(loadFy(oid, fyStart))
      await loadYear(oid, { from: `${fyStart}-04-01`, to: `${fyStart + 1}-03-31` })
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadYear(oid: string, range: { from: string; to: string }) {
    const [invRes, cnRes, dnRes, billRes, expRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, customer_gstin, place_of_supply, supply_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('invoice_date', range.from).lte('invoice_date', range.to).limit(5000),
      supabase.from('credit_notes')
        .select('id, credit_note_number, credit_note_date, customer_name, customer_gstin, place_of_supply, supply_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('credit_note_date', range.from).lte('credit_note_date', range.to).limit(2000),
      supabase.from('debit_notes')
        .select('id, debit_note_number, debit_note_date, bill_id, vendor_name, vendor_gstin, taxable_amount, cgst_amount, sgst_amount, igst_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('debit_note_date', range.from).lte('debit_note_date', range.to).limit(2000),
      supabase.from('purchase_bills')
        .select('id, bill_number, bill_date, vendor_name, vendor_gstin, itc_eligible, is_reverse_charge, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total, balance_due')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('bill_date', range.from).lte('bill_date', range.to).limit(5000),
      supabase.from('expenses')
        .select('id, bill_number, expense_date, vendor_name, vendor_gstin, itc_eligible, category, taxable_amount, amount, gst_amount')
        .eq('organization_id', oid)
        .gte('expense_date', range.from).lte('expense_date', range.to).limit(5000),
    ])

    setError(invRes.error ? `Could not read the year: ${invRes.error.message}` : '')

    const invoices = ((invRes.data || []) as any[]).map(r => toOutward(r, 'invoice'))
    const creditNotes = ((cnRes.data || []) as any[]).map(r => toOutward(r, 'credit_note'))
    const bills = ((billRes.data || []) as any[]).map(toBill)
    const eligibleById = new Map(bills.map(b => [b.id, b.itcEligible]))

    setDocs([...invoices, ...creditNotes])
    setInward([...bills, ...((expRes.data || []) as any[]).map(toExpense)])
    setDebitNotes(((dnRes.data || []) as any[]).map(r => toDebitNote(r, eligibleById)))
  }

  /* ── derived workpaper ── */

  const books = useMemo(() => monthlyBooks(docs, inward, fyStart), [docs, inward, fyStart])
  const outward = useMemo(() => outwardSupplies(docs), [docs])
  const rcm = useMemo(() => rcmSupplies(inward), [inward])
  const exempt = useMemo(() => exemptSupplies(docs), [docs])
  const { atRisk, recredited } = useMemo(() => itcUnpaid(inward, fyRange.asOf), [inward, fyRange.asOf])
  const recreditedRow = recredited[0]
  const itc = useMemo(() => itcTable(inward, {
    asOf: fyRange.asOf, debitNotes,
    rule4243: state.reversals.rule4243, otherReversal: state.reversals.other,
  }), [inward, debitNotes, state.reversals, fyRange.asOf])
  const recon = useMemo(() => reconSummary(reconcile9C(books, state.months)), [books, state.months])

  const turnover = booksTaxable(docs)
  const el = useMemo(() => eligibility({ turnover, registrationType, itcClaimed: itc.availableTotal.tax }), [turnover, registrationType, itc.availableTotal.tax])
  const alerts = useMemo(() => cautions({ docs, inward, itc, atRisk, recon, eligibility: el, stateCode }), [docs, inward, itc, atRisk, recon, el, stateCode])

  const dueIn = daysUntil(fyRange.due)

  /* ── state editing ── */

  const commit = useCallback((next: FyState) => {
    setState(next)
    if (orgId) {
      const stamped = saveFy(orgId, fyStart, next)
      setSavedAt(new Date(stamped.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
    }
  }, [orgId, fyStart])

  function setFiled(month: string, key: 'taxable' | 'igst' | 'cgst' | 'sgst' | 'cess', raw: string) {
    setDraft(d => ({ ...d, [`${month}:${key}`]: raw }))
    const current = state.months[month] ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
    commit({ ...state, months: { ...state.months, [month]: { ...current, [key]: Number(raw) || 0 } } })
  }

  function setNote(month: string, note: string) {
    const current = state.months[month] ?? { taxable: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 }
    commit({ ...state, months: { ...state.months, [month]: { ...current, note } } })
  }

  function setDue(key: keyof Dues, raw: string) {
    commit({ ...state, dues: { ...state.dues, [key]: Number(raw) || 0 } })
  }

  function setReversal(which: 'rule4243' | 'other', key: 'igst' | 'cgst' | 'sgst' | 'cess', raw: string) {
    const head = state.reversals[which]
    commit({ ...state, reversals: { ...state.reversals, [which]: { ...head, [key]: Number(raw) || 0 } } })
  }

  /** Fills the filed columns with the books, so a taxpayer who has not imported the
   *  portal figures can still see the shape of the reconciliation. */
  function copyBooksIntoFiled() {
    const months: FyState['months'] = {}
    for (const b of books) months[b.month] = { taxable: b.outward.taxable, igst: b.outward.igst, cgst: b.outward.cgst, sgst: b.outward.sgst, cess: b.outward.cess }
    commit({ ...state, months })
    setDraft({})
  }

  function clearFiled() {
    commit({ ...state, months: {} })
    setDraft({})
  }

  function changeFy(next: number) {
    setFyStart(next)
    setDraft({})
    setState(loadFy(orgId, next))
    loadYear(orgId, { from: `${next}-04-01`, to: `${next + 1}-03-31` })
  }

  function exportWorkpaper() {
    const rows = workpaperRows({ orgName, gstin, fyStart, eligibility: el, outward, rcm, itc, recon, atRisk, dues: state.dues })
    download(`GSTR9-9C-${fyLabel(fyStart)}.csv`, csvFromRows(rows))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the year…</div>
  }

  return (
    <div className="page-container g9">
      <PageHeader
        eyebrow="Annual compliance workpaper"
        title={`GSTR-9 / 9C — ${fyLabel(fyStart)}`}
        subtitle={
          <>
            Outward and inward supplies, credit and the reconciliation of your books against what was filed.
            {' '}{fyRange.inProgress
              ? <Badge tone="amber" dot={false}>year still running</Badge>
              : <Badge tone="green" dot={false}>year closed</Badge>}
          </>
        }
        actions={
          <>
            <select className="g9-select" value={fyStart} onChange={e => changeFy(Number(e.target.value))} aria-label="Financial year">
              {yearOptions().map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
            <Button variant="subtle" size="sm" icon="download" onClick={exportWorkpaper}>Export workpaper</Button>
            <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>Print</Button>
          </>
        }
      />

      {error && (
        <Card style={{ marginBottom: '0.9rem', borderColor: 'var(--red)' }}>
          <span style={{ color: 'var(--red)', fontSize: 13 }}>{error}</span>
        </Card>
      )}

      {/* Applicability */}
      <Card style={{ marginBottom: '0.9rem' }}>
        <div className="g9-elig">
          <div>
            <div className="tf-row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
              <Badge tone={el.required ? 'blue' : 'grey'}>{el.form}</Badge>
              {el.needs9C && <Badge tone="violet" dot={false}>audit under s.44</Badge>}
              {el.eInvoice && <Badge tone="cyan" dot={false}>e-invoice applicable</Badge>}
              {!el.required && <Badge tone="green" dot={false}>no annual return due</Badge>}
            </div>
            <div style={{ fontSize: 15, fontWeight: 680, color: 'var(--ink)', marginBottom: 5 }}>{el.headline}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>{el.reason}</div>
            <div className="tf-row" style={{ gap: 6, marginTop: 10, fontSize: 12, color: 'var(--faint)' }}>
              <Icon name="calendar" size={13} />
              Due {formatDateIN(fyRange.due)}
              {dueIn > 0 && <span>· {dueIn} days left</span>}
              {dueIn < 0 && <span style={{ color: 'var(--red)' }}>· {Math.abs(dueIn)} days past the usual due date</span>}
              <Link href="/gst/calendar" style={{ color: 'var(--brand)', textDecoration: 'none', fontWeight: 600, marginLeft: 4 }}>
                Compliance calendar →
              </Link>
            </div>
          </div>
          <ul className="g9-points">
            {el.points.map(p => <li key={p}>{p}</li>)}
            <li>Composition, casual and non-resident registrations, ISD and TCS collectors are outside section 44.</li>
          </ul>
        </div>
      </Card>

      {/* KPIs */}
      <div className="g9-stats">
        <StatCard label="Aggregate outward turnover" value={turnover} icon="invoice" tone="blue"
          sub={`Table 4.A, GST excluded · ${docs.filter(d => d.kind === 'invoice').length} documents`} />
        <StatCard label="Output tax on outward supplies" value={sumHeads(outward.map(o => o.heads)).tax} icon="percent" tone="violet"
          sub="CGST + SGST + IGST + Cess, after credit notes" delay={60} />
        <StatCard label="ITC claimed in the year" value={itc.availableTotal.tax} icon="cart" tone="green"
          sub={`Net of reversals and block credit: ${money(itc.netHeads.tax)}`} delay={120} />
        <StatCard label={`Credit past ${ITC_PAYMENT_DEADLINE_DAYS} days unpaid`} value={sumHeads(atRisk.map(r => r.heads)).tax}
          icon="alert" tone={atRisk.length ? 'red' : 'grey'}
          sub={atRisk.length ? `${plural(atRisk.length, 'supplier invoice')} — s.16(4) reversal` : 'Nothing outstanding past the deadline'}
          delay={180} />
        <StatCard label="Books vs filed GSTR-3B" value={recon.monthsDeclared ? Math.abs(recon.turnoverDiff) : 0}
          icon="compare" tone={recon.monthsVariance ? 'amber' : 'grey'}
          sub={recon.monthsDeclared
            ? `${recon.monthsDeclared} of 12 months declared · ${plural(recon.monthsVariance, 'variance')}`
            : 'No filed figures entered yet'}
          delay={240} />
      </div>

      {/* Cautions */}
      {alerts.length > 0 && (
        <Card className="no-print" style={{ marginBottom: '0.9rem' }}>
          <SectionTitle icon="alert">What a reviewer would flag on this file</SectionTitle>
          <div className="g9-alerts">
            {alerts.map(a => {
              const tone = CAUTION_TONE[a.level]
              return (
                <div key={a.id} className="g9-alert" style={{ ...({ '--a-bg': tone.bg, '--a-fg': tone.fg } as CSSProperties) }}>
                  <Icon name={tone.icon} size={15} style={{ color: tone.fg, marginTop: 2, flexShrink: 0 }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 620, color: 'var(--ink)' }}>{a.title}</div>
                    <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2, lineHeight: 1.5 }}>
                      {a.detail}
                      {a.href && (
                        <Link className="g9-alert-link no-print" href={`${a.href}?q=`}>
                          open {a.href.replace('/', '')}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* Tabs */}
      <Card pad={false} className="g9-panel">
        <div className="tab-bar no-print g9-tabs">
          {TABS.map(t => (
            <button key={t.value} type="button" className={`g9-tab ${tab === t.value ? 'is-on' : ''}`} onClick={() => setTab(t.value)}>
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'outward' && (
          <div className="g9-body">
            <Headline
              title="Table 4.A — Outward supplies as per books"
              note="Credit notes are netted inside the row they belong to, so this is the turnover the annual return starts from."
            />
            <MoneyTable
              rows={outward.map(r => ({
                label: (
                  <span className="tf-col" style={{ gap: 2, alignItems: 'flex-start' }}>
                    <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', color: 'var(--brand)' }}>{r.code}</span>
                    <span style={{ color: 'var(--ink-2)' }}>{r.label}</span>
                  </span>
                ),
                heads: r.heads, count: r.count,
              }))}
              totals={sumHeads(outward.map(o => o.heads))}
              empty="No outward documents fall in this financial year."
            />

            <Headline
              title="Table 4.B — Inward supplies liable to reverse charge"
              note="Tax on these is paid by you, not the supplier, so it never appears in Table 4.A. Imports (IMPG / IMPS) have to be added from the portal — the books do not carry a bill of entry."
            />
            {rcm.length === 0 ? (
              <EmptyState icon="cart" title="Nothing flagged as reverse charge"
                message="Set the reverse-charge switch on a purchase bill when you pay the tax yourself — those supplies must be declared in the annual return even though no supplier charged GST." />
            ) : (
              <MoneyTable
                rows={rcm.map(r => ({ label: r.label, heads: r.heads, count: r.count }))}
                totals={sumHeads(rcm.map(r => r.heads))}
              />
            )}

            <Headline
              title="Table 6 — Nil-rated, exempt and zero-rated supplies"
              note="Nothing here carries tax, but every rupee of it counts towards aggregate turnover and therefore towards the audit and annual return limits."
            />
            <MoneyTable
              rows={exempt.map(r => ({ label: r.label, heads: r.heads, count: r.count }))}
              totals={sumHeads(exempt.map(r => r.heads))}
              empty="No nil-rated, exempt or zero-rated supplies in the year."
            />

            <div className="g9-foot-note">
              Turnover above <b>{money(ANNUAL_RETURN_EXEMPT_TURNOVER)}</b> brings the annual return in and above{' '}
              <b>{money(AUDIT_TURNOVER)}</b> the reconciliation statement too. Thresholds move by notification — the
              panel above records the rule this page applied.
            </div>
          </div>
        )}

        {tab === 'itc' && (
          <div className="g9-body">
            <Headline
              title="Table 5.A — Credit available"
              note="Purchase bills give the split directly. Expenses carry a single GST amount, so they are credited as half CGST and half SGST."
            />
            <MoneyTable
              rows={itc.available.map(r => ({ label: r.label, heads: r.heads, count: r.count }))}
              totals={itc.availableTotal}
              empty="No purchase bills or expenses with GST in this year."
            />

            <Headline
              title="Table 5.B — Credit reversed or attributed"
              note={`Section 16(4) takes the credit back when a supplier is not paid within ${ITC_PAYMENT_DEADLINE_DAYS} days of the invoice date, and gives it back in the month payment lands.`}
            />
            <MoneyTable
              rows={itc.reversed.map(r => ({ label: r.label, heads: r.heads, count: r.count }))}
              totals={itc.reversedTotal}
              empty="Nothing reversed so far — the watchlist below is what to watch next."
            />

            {recreditedRow && recreditedRow.count > 0 && (
              <div className="g9-reavail">
                <Icon name="check" size={14} />
                <span>
                  <b>{recreditedRow.count}</b> {pluralNoun(recreditedRow.count, 'invoice')} paid after the reversal, credit taken
                  back in the month of payment — {money(recreditedRow.heads.tax)}. It is added to 5.A, not netted here.
                </span>
              </div>
            )}

            {atRisk.length > 0 && (
              <div className="g9-watch">
                <div className="g9-watch-head">
                  <Icon name="clock" size={14} />
                  <span>Section 16(4) watchlist · {plural(atRisk.length, 'document')}</span>
                  <Link href="/bills?q=" className="g9-watch-link">open purchase bills →</Link>
                </div>
                {atRisk.slice(0, 12).map(r => (
                  <div key={r.doc.id} className="g9-watch-row">
                    <span className="g9-watch-doc">{r.doc.number}</span>
                    <span className="g9-watch-party">{r.doc.party || '—'}</span>
                    <span className="g9-watch-days">{r.days} days</span>
                    <span className="g9-watch-amt">{money(r.unpaid)} due</span>
                    <span className="g9-watch-tax">{money(r.heads.tax)}</span>
                  </div>
                ))}
                {atRisk.length > 12 && (
                  <div className="g9-watch-more">and {atRisk.length - 12} more in the export</div>
                )}
              </div>
            )}

            <Headline
              title="Table 5.C — Credit not eligible"
              note="Documents you marked as not eligible are block credit under section 17(5). Anything claimed without a supplier GSTIN will not appear in GSTR-2B either."
            />
            <MoneyTable
              rows={itc.ineligible.map(r => ({ label: r.label, heads: r.heads, count: r.count }))}
              totals={itc.ineligibleTotal}
              empty="No block credit — every document in the year is marked eligible."
            />

            <div className="g9-net">
              <div>
                <div className="g9-net-label">Net credit carried to the annual return</div>
                <div className="g9-net-sub">
                  Available {money(itc.availableTotal.tax)} − reversed {money(itc.reversedTotal.tax)} − ineligible {money(itc.ineligibleTotal.tax)}
                </div>
              </div>
              <div className="g9-net-value">{money(itc.netHeads.tax)}</div>
            </div>

            <Headline
              title="Reversals the books cannot see"
              note="Rule 42/43 apportionment needs the exempt-to-taxable ratio from the accounts, so it is declared here rather than derived."
            />
            <div className="g9-reversal">
              {(['rule4243', 'other'] as const).map(which => (
                <div key={which} className="g9-reversal-row">
                  <span className="g9-reversal-label">
                    {which === 'rule4243' ? 'Rule 42 / 43 — mixed use' : 'Other reversals'}
                  </span>
                  {(['igst', 'cgst', 'sgst', 'cess'] as const).map(key => (
                    <label key={key} className="g9-field">
                      <span>{key.toUpperCase()}</span>
                      <input className="g9-input tf-num" inputMode="decimal"
                        value={state.reversals[which][key] || ''}
                        onChange={e => setReversal(which, key, e.target.value)}
                        aria-label={`${which} ${key}`} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'recon' && (
          <div className="g9-body">
            <Headline
              title="GSTR-9C — books against the returns actually filed"
              note="Type the Table 6.1 figures from each GSTR-3B on the portal. The difference column is what the reconciliation statement has to explain."
            />
            <div className="g9-filings-hint no-print">
              Already transcribed? The{' '}
              <Link href="/gst/filings">filings register</Link> keeps each filed GSTR-3B with the taxable and tax
              figures that return states, period by period — that page&apos;s variance tab compares the same two sides,
              from the same documents this workpaper reads. Type figures here for the year 9C must file; record them
              there for the history of what went in.
            </div>
            <div className="g9-tools no-print">
              <Button size="sm" variant="subtle" icon="swap" onClick={copyBooksIntoFiled}>Copy books figures</Button>
              <Button size="sm" variant="ghost" icon="x" onClick={clearFiled}>Clear declared figures</Button>
              <span className="g9-saved">
                {savedAt ? `Saved locally at ${savedAt}` : 'Nothing saved yet for this year'}
                {' '}· {recon.monthsDeclared} of 12 months declared
              </span>
            </div>

            <div className="table-scroll">
              <div className="g9-grid">
                <div className="g9-cols g9-head" style={{ gridTemplateColumns: reconGrid }}>
                  <span>Month</span>
                  <span className="is-right">Books taxable</span>
                  <span className="is-right">Books tax</span>
                  <span className="is-right">Filed taxable</span>
                  <span className="is-right">Filed IGST</span>
                  <span className="is-right">Filed CGST</span>
                  <span className="is-right">Filed SGST</span>
                  <span className="is-right">Diff taxable</span>
                  <span>Status</span>
                  <span>Explanation</span>
                </div>

                {recon.rows.map(r => {
                  const b = books.find(x => x.month === r.month)!
                  return (
                    <div key={r.month} className={`g9-cols g9-row ${r.status === 'variance' ? 'is-variance' : ''}`}>
                      <span className="g9-month" data-label="Month">{monthShort(r.month)} {r.month.slice(0, 4)}</span>

                      <span className="is-right tf-num" data-label="Books taxable">{money(b.outward.taxable)}</span>
                      <span className="is-right tf-num" data-label="Books tax">{money(b.outward.tax)}</span>

                      {(['taxable', 'igst', 'cgst', 'sgst'] as const).map(key => (
                        <label key={key} className="g9-cell-input" data-label={`Filed ${key.toUpperCase()}`}>
                          <input
                            className="g9-input tf-num"
                            inputMode="decimal"
                            value={draftFor(draft, r.month, key, r.filed ? r.filed[key] : (state.months[r.month]?.[key] ?? 0))}
                            onChange={e => setFiled(r.month, key, e.target.value)}
                            aria-label={`${formatDateIN(`${r.month}-01`)} filed ${key}`}
                          />
                        </label>
                      ))}

                      <span className="is-right tf-num" data-label="Diff taxable"
                        style={{ color: r.status === 'variance' ? 'var(--red)' : 'var(--faint)', fontWeight: r.status === 'variance' ? 680 : 500 }}>
                        {r.status === 'unset' ? '—' : money(r.diff.taxable)}
                      </span>

                      <span data-label="Status">
                        {r.status === 'matched' && <Badge tone="green">ties</Badge>}
                        {r.status === 'variance' && <Badge tone="red">differs: {r.heads.join(' · ')}</Badge>}
                        {r.status === 'unset' && <Badge tone="grey" dot={false}>not declared</Badge>}
                      </span>

                      <label className="g9-cell-input" data-label="Explanation">
                        <input className="g9-note no-print" placeholder="reason for the difference"
                          value={state.months[r.month]?.note ?? ''}
                          onChange={e => setNote(r.month, e.target.value)}
                          aria-label={`${monthShort(r.month)} ${r.month.slice(0, 4)} explanation`} />
                      </label>
                    </div>
                  )
                })}

                <div className="g9-cols g9-foot" style={{ gridTemplateColumns: reconGrid }}>
                  <span>FY totals</span>
                  <span className="is-right tf-num" data-label="Books taxable">{money(recon.booksTotal.taxable)}</span>
                  <span className="is-right tf-num" data-label="Books tax">{money(recon.booksTotal.tax)}</span>
                  <span className="is-right tf-num" data-label="Filed taxable">{recon.monthsDeclared ? money(recon.filedTotal.taxable) : '—'}</span>
                  <span className="is-right tf-num" data-label="Filed IGST">{recon.monthsDeclared ? money(recon.filedTotal.igst) : '—'}</span>
                  <span className="is-right tf-num" data-label="Filed CGST">{recon.monthsDeclared ? money(recon.filedTotal.cgst) : '—'}</span>
                  <span className="is-right tf-num" data-label="Filed SGST">{recon.monthsDeclared ? money(recon.filedTotal.sgst) : '—'}</span>
                  <span className="is-right tf-num" data-label="Diff taxable" style={{ color: Math.abs(recon.turnoverDiff) > 1 ? 'var(--red)' : 'var(--green)', fontWeight: 700 }}>
                    {recon.monthsDeclared ? money(recon.turnoverDiff) : '—'}
                  </span>
                  <span data-label="Declared months">{recon.monthsDeclared} of 12</span>
                  <span />
                </div>
              </div>
            </div>

            <div className="g9-foot-note">
              Totals compare the {recon.monthsDeclared} months you declared; undeclared months are excluded so the two
              sides stay comparable. {money(recon.booksTotal.taxable)} is the full-year turnover as per books of accounts.
            </div>
          </div>
        )}

        {tab === 'dues' && (
          <div className="g9-body">
            <Headline
              title="Table 8 / 9 — dues, payments and refunds"
              note="The GST portal owns these numbers — cash ledger and interest computations are not in the books — so they are declared here and travel with the export."
            />
            <div className="g9-dues">
              {DUE_FIELDS.map(f => (
                <label key={f.key} className="g9-dues-field">
                  <span className="g9-dues-label">{f.label}</span>
                  <input className="g9-input tf-num" inputMode="decimal"
                    value={state.dues[f.key] || ''}
                    onChange={e => setDue(f.key, e.target.value)}
                    placeholder="0" aria-label={f.label} />
                  <span className="g9-dues-hint">{f.hint}</span>
                </label>
              ))}
            </div>

            <Headline title="Turnover this page worked from" note="So the two sides of the file can be tied without opening the registers again." />
            <div className="g9-links">
              <Link className="g9-link" href="/reports/registers?q=">
                <Icon name="chart" size={15} /> Statutory registers — party-wise, HSN/SAC, B2B, state-wise
              </Link>
              <Link className="g9-link" href="/gst/reconciliation?q=">
                <Icon name="compare" size={15} /> GSTR-2B reconciliation for the credit claimed here
              </Link>
              <Link className="g9-link" href="/accounting">
                <Icon name="book" size={15} /> P&amp;L and balance sheet for the audited figures
              </Link>
              <Link className="g9-link" href="/gst/einvoice">
                <Icon name="file-check" size={15} /> E-invoice / e-way bill — mandatory above ₹5 crore
              </Link>
            </div>

            <div className="g9-foot-note">
              Prepared from the rows in this workspace on {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}.
              The return is filed on gst.gov.in; every table here is derived from documents you can open and check.
            </div>
          </div>
        )}
      </Card>

      <style>{`
        .g9-stats { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin-bottom: 0.9rem; }
        .g9-elig { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 18px; }
        .g9-points { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 6px; }
        .g9-points li { font-size: 12px; color: var(--muted); line-height: 1.5; }
        .g9-alerts { display: flex; flex-direction: column; gap: 8px; }
        .g9-alert { display: flex; gap: 9px; padding: 10px 12px; border-radius: 10px; background: var(--a-bg); border-left: 3px solid var(--a-fg); }
        .g9-alert-link { display: inline-block; margin-left: 6px; color: var(--brand); font-weight: 600; font-size: 12px; text-decoration: none; }
        .g9-panel { overflow: hidden; }
        .g9-tabs { border-bottom: 1px solid var(--line); padding: 6px 10px 0; background: var(--surface-2); }
        .g9-tab {
          display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
          font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--muted);
          background: transparent; border: none; border-bottom: 2px solid transparent;
          padding: 9px 11px; cursor: pointer; min-height: 0;
        }
        .g9-tab.is-on { color: var(--brand); border-bottom-color: var(--brand); }
        .g9-body { padding: 1.1rem 1.15rem 1.3rem; }
        .g9-section-head { margin: 0 0 10px; }
        .g9-body > .g9-section-head + *, .g9-body > .table-scroll, .g9-body > .g9-blank, .g9-body > .g9-watch { margin-bottom: 1.4rem; }
        .g9-body > .g9-section-head:not(:first-child) { margin-top: 1.5rem; }
        .g9-head-line { font-size: 13.5px; font-weight: 700; color: var(--ink); margin-bottom: 3px; }
        .g9-head-note { font-size: 12px; color: var(--faint); line-height: 1.55; max-width: 820px; }
        .g9-blank {
          padding: 16px 14px; border: 1px dashed var(--line); border-radius: 11px;
          font-size: 12.5px; color: var(--faint); background: var(--surface-2);
        }
        .mt-grid { min-width: 900px; }
        .mt-cols { display: grid; align-items: center; gap: 12px; padding: 9px 1rem; border-bottom: 1px solid var(--line-soft); font-size: 12px; color: var(--ink-2); }
        .mt-cols > .is-right { text-align: right; white-space: nowrap; }
        .mt-cols > .mt-label { font-size: 12.5px; color: var(--ink-2); min-width: 0; }
        .mt-head { background: var(--surface-2); border-bottom: 1px solid var(--line); font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        .mt-row:hover { background: #f9fbfe; }
        .mt-foot { background: var(--surface-2); border-bottom: none; font-weight: 700; color: var(--ink); }
        .g9-grid { min-width: 1060px; }
        .g9-cols { display: grid; grid-template-columns: 1.5fr repeat(8, minmax(0, 1fr)) 1.6fr; align-items: center; gap: 10px; padding: 9px 1rem; border-bottom: 1px solid var(--line-soft); }
        .g9-head { background: var(--surface-2); font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        .g9-row:hover { background: #f9fbfe; }
        .g9-row.is-variance { background: var(--red-soft); }
        .g9-row.is-variance:hover { background: #fee7e7; }
        .g9-month { font-size: 12.5px; font-weight: 650; color: var(--ink-2); white-space: nowrap; }
        .g9-cols > .is-right { text-align: right; font-size: 12.5px; color: var(--ink-2); }
        .g9-foot { background: var(--surface-2); font-weight: 700; font-size: 12.5px; color: var(--ink); }
        .g9-input {
          font-family: inherit; font-size: 12.5px; color: var(--ink); width: 100%; min-width: 0;
          border: 1px solid var(--line); border-radius: 7px; background: var(--surface);
          padding: 6px 8px; text-align: right; min-height: 0;
        }
        .g9-input:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); }
        .g9-cell-input { display: block; min-width: 0; }
        .g9-note {
          font-family: inherit; font-size: 12px; color: var(--ink-2); width: 100%; min-width: 0;
          border: 1px dashed var(--line); border-radius: 7px; background: transparent; padding: 6px 8px; min-height: 0;
        }
        .g9-note:focus { outline: none; border-color: var(--brand); border-style: solid; box-shadow: 0 0 0 3px var(--brand-ring); }
        .g9-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; }
        .g9-saved { font-size: 11.5px; color: var(--faint); }
        .g9-filings-hint { font-size: 12px; color: var(--muted); line-height: 1.6; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; margin-bottom: 12px; }
        .g9-filings-hint a { color: var(--brand); font-weight: 600; text-decoration: none; }
        .g9-filings-hint a:hover { text-decoration: underline; }
        .g9-select {
          font-family: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface);
          border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; min-height: 0; cursor: pointer;
        }
        .g9-net {
          display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
          margin: 1.2rem 0 1.4rem; padding: 13px 15px; border-radius: 12px;
          background: var(--slate-soft); border: 1px solid var(--line);
        }
        .g9-net-label { font-size: 13px; font-weight: 700; color: var(--ink); }
        .g9-net-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
        .g9-net-value { font-size: 21px; font-weight: 750; color: var(--green); font-variant-numeric: tabular-nums; }
        .g9-watch { border: 1px solid var(--line); border-radius: 12px; overflow: hidden; margin: 4px 0 1.4rem; }
        .g9-watch-head {
          display: flex; align-items: center; gap: 8px; padding: 9px 12px;
          background: var(--amber-soft); color: var(--amber); font-size: 12px; font-weight: 700;
          border-bottom: 1px solid var(--line);
        }
        .g9-watch-link { margin-left: auto; font-size: 11.5px; font-weight: 600; color: var(--brand); text-decoration: none; }
        .g9-watch-row { display: grid; grid-template-columns: 1.1fr 2fr .8fr 1.1fr 1fr; gap: 10px; padding: 8px 12px; font-size: 12px; color: var(--ink-2); border-bottom: 1px solid var(--line-soft); }
        .g9-watch-row:last-of-type { border-bottom: none; }
        .g9-watch-doc { font-weight: 620; color: var(--ink); }
        .g9-watch-party { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .g9-watch-days, .g9-watch-amt { color: var(--muted); }
        .g9-watch-tax { text-align: right; font-variant-numeric: tabular-nums; color: var(--red); font-weight: 600; }
        .g9-watch-more { padding: 7px 12px; font-size: 11.5px; color: var(--faint); background: var(--surface-2); }
        .g9-reavail {
          display: flex; align-items: flex-start; gap: 8px; margin: -0.7rem 0 1.4rem; padding: 10px 12px;
          border-radius: 10px; background: var(--green-soft); color: var(--ink-2); font-size: 12px; line-height: 1.55;
        }
        .g9-reavail b { color: var(--ink); }
        .g9-reavail svg { color: var(--green); flex-shrink: 0; margin-top: 2px; }
        .g9-reversal { display: flex; flex-direction: column; gap: 9px; }
        .g9-reversal-row { display: grid; grid-template-columns: 1.4fr repeat(4, minmax(0, 1fr)); gap: 10px; align-items: center; }
        .g9-reversal-label { font-size: 12.5px; color: var(--ink-2); font-weight: 600; }
        .g9-field { display: flex; align-items: center; gap: 7px; min-width: 0; }
        .g9-field span { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; color: var(--faint); width: 34px; flex-shrink: 0; }
        .g9-dues { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 1.4rem; }
        .g9-dues-field { display: flex; flex-direction: column; gap: 5px; padding: 11px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface); }
        .g9-dues-label { font-size: 12px; font-weight: 650; color: var(--ink-2); }
        .g9-dues-hint { font-size: 11px; color: var(--faint); line-height: 1.45; }
        .g9-dues-field .g9-input { text-align: left; font-size: 14px; font-weight: 650; }
        .g9-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 1.2rem; }
        .g9-link {
          display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px;
          border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
          font-size: 12.5px; text-decoration: none; transition: border-color .12s ease, background .12s ease;
        }
        .g9-link:hover { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }
        .g9-foot-note { font-size: 11.5px; color: var(--faint); line-height: 1.6; margin-top: 4px; }
        .g9-foot-note b { color: var(--muted); }

        @media (max-width: 1200px) {
          .g9-stats { grid-template-columns: repeat(3, minmax(0, 1fr)); }
          .g9-elig { grid-template-columns: 1fr; gap: 12px; }
        }
        @media (max-width: 768px) {
          .g9-stats { grid-template-columns: 1fr 1fr; }
          .g9-body { padding: 0.9rem 0.8rem 1.1rem; }
          .g9-tabs { padding: 4px 6px 0; }
          .g9-grid { min-width: 0; }
          .g9-head { display: none !important; }
          .g9-cols { grid-template-columns: 1fr !important; gap: 6px; padding: 12px 13px; }
          .g9-row { border: 1px solid var(--line); border-radius: 12px; margin-bottom: 10px; background: var(--surface); }
          .g9-cols > span, .g9-cols > label { display: flex; align-items: center; justify-content: space-between; gap: 10px; text-align: right; font-size: 12.5px; }
          .g9-cols > span::before, .g9-cols > label::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: .05em; text-align: left; flex: 1;
          }
          .g9-cell-input input, .g9-note { flex: 0 0 55%; }
          .g9-note { border-style: solid; background: var(--surface-2); }
          .g9-foot { border-radius: 12px; }
          .mt-grid { min-width: 0; }
          .mt-head { display: none !important; }
          .mt-cols { grid-template-columns: 1fr !important; gap: 6px; padding: 12px 13px; }
          .mt-row { border: 1px solid var(--line); border-radius: 12px; margin-bottom: 10px; background: var(--surface); }
          .mt-cols > span.is-right { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; text-align: right; min-width: 0; white-space: normal; }
          .mt-cols > span::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: .05em; text-align: left; flex: 1;
          }
          /* One figure per line — rupee amounts have no break point, so two columns overflow. */
          .mt-row { grid-template-columns: 1fr !important; }
          .mt-foot { border-radius: 12px; background: var(--surface-2); grid-template-columns: 1fr !important; }
          .mt-cols > .mt-label { display: block; text-align: left; font-size: 13px; font-weight: 700; color: var(--ink); line-height: 1.35; }
          .mt-cols > .mt-label::before { content: none; }
          .g9-watch-row { grid-template-columns: 1fr 1fr; gap: 4px 10px; }
          .g9-watch-party { order: 3; grid-column: 1 / -1; }
          .g9-reversal-row { grid-template-columns: 1fr 1fr; }
          .g9-reversal-label { grid-column: 1 / -1; }
          .g9-dues, .g9-links { grid-template-columns: 1fr; }
        }
        @media print {
          .g9-tabs, .g9-tools, .g9-select, .no-print { display: none !important; }
          .g9-stats { grid-template-columns: repeat(3, 1fr); }
          .g9-grid { min-width: 0; }
          .g9-body { padding: 0; }
        }
      `}</style>
    </div>
  )
}

/* ── helpers ────────────────────────────────────────────────────────────── */

const reconGrid = '1.3fr 1fr 1fr 1fr 1fr 1fr 1fr 1fr 1.1fr 1.5fr'

const DUE_FIELDS: { key: 'taxPaidCash' | 'preDeposit' | 'interestPaid' | 'penaltyPaid' | 'lateFeePaid' | 'refundDue' | 'demandOutstanding'; label: string; hint: string }[] = [
  { key: 'taxPaidCash', label: 'Tax paid in cash', hint: 'Cash ledger debits for the year, all heads' },
  { key: 'preDeposit', label: 'Pre-deposit', hint: 'Deposited before filing an appeal' },
  { key: 'interestPaid', label: 'Interest paid', hint: 'Section 50 interest, self-assessed or demanded' },
  { key: 'penaltyPaid', label: 'Penalty and fine', hint: 'Adjudicated amounts actually paid' },
  { key: 'lateFeePaid', label: 'Late fee', hint: 'For belated monthly and quarterly returns' },
  { key: 'refundDue', label: 'Refund due', hint: 'Claimed with the annual return' },
  { key: 'demandOutstanding', label: 'Demand outstanding', hint: 'Unpaid as on the date of filing' },
]

function yearOptions(): number[] {
  const now = fyStartYear(new Date())
  return [now, now - 1, now - 2, now - 3]
}

function draftFor(draft: Record<string, string>, month: string, key: string, value: number): string {
  const d = draft[`${month}:${key}`]
  if (d !== undefined) return d
  return value ? String(value) : ''
}

/** Turnover the annual return starts from: every outward document, GST excluded. */
function booksTaxable(docs: OutwardDoc[]): number {
  return Math.round(docs.reduce((s, d) => s + (d.kind === 'credit_note' ? -1 : 1) * num(d.taxable), 0) * 100) / 100
}

function toOutward(r: any, kind: 'invoice' | 'credit_note'): OutwardDoc {
  return {
    id: r.id,
    number: kind === 'invoice' ? r.invoice_number : r.credit_note_number,
    date: kind === 'invoice' ? r.invoice_date : r.credit_note_date,
    kind,
    party: r.customer_name,
    gstin: r.customer_gstin,
    placeOfSupply: r.place_of_supply,
    supplyType: r.supply_type,
    taxable: r.taxable_amount,
    igst: r.igst_amount,
    cgst: r.cgst_amount,
    sgst: r.sgst_amount,
    cess: r.cess_amount ?? 0,
    total: r.grand_total,
  }
}

function toBill(r: any): InwardDoc {
  return {
    id: r.id, number: r.bill_number, date: r.bill_date, party: r.vendor_name, gstin: r.vendor_gstin,
    itcEligible: r.itc_eligible !== false, reverseCharge: !!r.is_reverse_charge,
    taxable: r.taxable_amount, igst: r.igst_amount, cgst: r.cgst_amount, sgst: r.sgst_amount,
    cess: r.cess_amount ?? 0, total: r.grand_total, balanceDue: r.balance_due ?? 0, source: 'bill',
  }
}

/** Expenses carry one GST amount, so `total − taxable` is the credit. */
function toExpense(r: any): InwardDoc {
  const gst = num(r.gst_amount ?? (num(r.amount) - num(r.taxable_amount)))
  return {
    id: r.id, number: r.bill_number || r.category || 'Expense', date: r.expense_date,
    party: r.vendor_name, gstin: r.vendor_gstin, itcEligible: r.itc_eligible !== false,
    reverseCharge: false, taxable: num(r.taxable_amount) || num(r.amount) - gst,
    igst: 0, cgst: 0, sgst: 0, cess: 0, total: num(r.amount) || gst, balanceDue: null, source: 'expense',
  }
}

/** A debit note raised on a supplier reduces the credit taken on that purchase. */
function toDebitNote(r: any, eligibleById: Map<string, boolean>): InwardDoc {
  return {
    id: r.id, number: r.debit_note_number, date: r.debit_note_date, party: r.vendor_name, gstin: r.vendor_gstin,
    itcEligible: r.bill_id ? (eligibleById.get(r.bill_id) ?? true) : true,
    reverseCharge: false, taxable: r.taxable_amount, igst: r.igst_amount, cgst: r.cgst_amount,
    sgst: r.sgst_amount, cess: 0, total: r.grand_total, balanceDue: null, source: 'debit_note',
  }
}

/* ── small presentational pieces ── */

function Headline({ title, note }: { title: string; note: string }) {
  return (
    <div className="g9-section-head">
      <div className="g9-head-line">{title}</div>
      <div className="g9-head-note">{note}</div>
    </div>
  )
}

/** Every GSTR-9 section prints the same tax heads, so one layout serves them all. */
const HEAD_COLS: { key: keyof Heads | 'count'; label: string; width: string }[] = [
  { key: 'count', label: 'Docs', width: '.55fr' },
  { key: 'taxable', label: 'Taxable value', width: '1.25fr' },
  { key: 'igst', label: 'IGST', width: '.95fr' },
  { key: 'cgst', label: 'CGST', width: '.95fr' },
  { key: 'sgst', label: 'SGST', width: '.95fr' },
  { key: 'cess', label: 'Cess', width: '.8fr' },
  { key: 'tax', label: 'Total tax', width: '1.15fr' },
]

function MoneyTable({ rows, totals, empty }: {
  rows: { label: ReactNode; heads: Heads; count: number }[]
  totals: Heads
  empty?: string
}) {
  const grid = `2.4fr ${HEAD_COLS.map(c => c.width).join(' ')}`
  const docCount = rows.reduce((a, r) => a + (r.count || 0), 0)
  if (!rows.length && empty) {
    return <div className="g9-blank">{empty}</div>
  }
  return (
    <div className="table-scroll">
      <div className="mt-grid">
        <div className="mt-cols mt-head" style={{ gridTemplateColumns: grid }}>
          <span>Description</span>
          {HEAD_COLS.map(c => <span key={c.label} className="is-right">{c.label}</span>)}
        </div>
        {rows.map((r, i) => (
          <div key={i} className="mt-cols mt-row" style={{ gridTemplateColumns: grid }}>
            <span className="mt-label" data-label="Description">{r.label}</span>
            {HEAD_COLS.map(c => (
              <span key={c.label} className="is-right tf-num" data-label={c.label}>
                {c.key === 'count' ? (r.count || '—') : money(r.heads[c.key])}
              </span>
            ))}
          </div>
        ))}
        <div className="mt-cols mt-foot" style={{ gridTemplateColumns: grid }}>
          <span className="mt-label">Section total</span>
          {HEAD_COLS.map(c => (
            <span key={c.label} className="is-right tf-num" data-label={c.label}>
              {c.key === 'count' ? (docCount || '—') : money(totals[c.key])}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
