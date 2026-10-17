'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { download } from '@/lib/party-ledger'
import { toCsv } from '@/lib/registers'
import { fyLabel, fyStartYear } from '@/lib/targets'
import {
  SAMPLE_TDS_NOTE, SECTIONS, TDS_CSV_HEADERS, TDS_DEPOSIT_CSV_HEADERS, TDS_STATEMENT_CSV_HEADERS,
  TDS_STATEMENT_FEE_CITATION, TDS_STATEMENT_FEE_PER_DAY, TDS_STATEMENT_PENALTY_CITATION,
  buildWorkpaper, effectiveRate, emptyTds, loadTds, noPanRateOf, saveTds, sectionOf, setBillSection,
  setChallan, setStatementFiling, setVendorSection, tdsBase, tdsCsvRows, tdsDepositCsvRows,
  tdsStatementCsvRows, validateStatementFiling, vendorKey,
  type Challan, type DeductionRow, type PayerType, type SectionId, type StatementFiling, type TdsBill,
  type TdsPayment, type TdsState, type TdsVendor,
} from '@/lib/tds'
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'workpaper' | 'deposits' | 'suppliers' | 'statements'

const TABS: { value: Tab; label: string; icon: string }[] = [
  { value: 'workpaper', label: 'Deductee workpaper', icon: 'clipboard' },
  { value: 'deposits', label: 'Deposits & interest', icon: 'wallet' },
  { value: 'suppliers', label: 'Supplier sections', icon: 'factory' },
  { value: 'statements', label: '26Q statements', icon: 'file-check' },
]

/** A challan is filled in whole rupees, and so is the workpaper. */
const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const money = (v: number) => {
  const n = Math.round(Number(v) || 0)
  return n < 0 ? `−₹${inr.format(-n)}` : `₹${inr.format(n)}`
}
const lakh = (v: number) => `₹${inr.format(Math.round(v))}`

const STATUS_TONE: Record<string, { tone: 'grey' | 'green' | 'amber' | 'red' | 'blue'; label: string }> = {
  'not-yet-due': { tone: 'grey', label: 'Not due yet' },
  pending: { tone: 'red', label: 'Due, not deposited' },
  deposited: { tone: 'green', label: 'Deposited on time' },
  late: { tone: 'amber', label: 'Deposited late' },
  short: { tone: 'red', label: 'Deposited short' },
}

const SECTION_OPTIONS = SECTIONS.map(s => ({ value: s.id, label: s.label }))

export default function TdsPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [gstin, setGstin] = useState('')
  const [error, setError] = useState('')

  // Withholding is a live obligation: the year being worked on is the running one.
  const [fyStart, setFyStart] = useState(() => fyStartYear(new Date()))
  const [asOf] = useState(() => new Date())

  const [bills, setBills] = useState<TdsBill[]>([])
  const [payments, setPayments] = useState<TdsPayment[]>([])
  const [vendors, setVendors] = useState<TdsVendor[]>([])
  const [state, setState] = useState<TdsState>(emptyTds())
  const [tab, setTab] = useState<Tab>('workpaper')
  const [savedAt, setSavedAt] = useState('')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [stmtProblems, setStmtProblems] = useState<Record<string, string[]>>({})
  const [openVendors, setOpenVendors] = useState<Record<string, boolean>>({})
  const [showRates, setShowRates] = useState(false)

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      const org = membership.organizations as unknown as { name?: string } | null
      setOrgId(oid)
      setOrgName(org?.name || '')

      const { data: reg } = await supabase
        .from('gst_registrations').select('gstin').eq('organization_id', oid).eq('is_primary', true).single()
      setGstin(reg?.gstin || '')

      setState(loadTds(oid))
      await loadYear(oid, fyStart)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadYear(oid: string, year: number) {
    const from = `${year}-04-01`
    const to = `${year + 1}-03-31`
    const [billRes, payRes, vendorRes] = await Promise.all([
      supabase.from('purchase_bills')
        .select('id, bill_number, bill_date, vendor_id, vendor_name, vendor_gstin, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total, balance_due')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('bill_date', from).lte('bill_date', to).limit(5000),
      supabase.from('payments')
        .select('bill_id, payment_date, amount')
        .eq('organization_id', oid).eq('payment_type', 'made').not('bill_id', 'is', null)
        .gte('payment_date', from).lte('payment_date', `${year + 1}-04-30`).limit(5000),
      supabase.from('vendors').select('id, name, pan, gstin')
        .eq('organization_id', oid).eq('is_active', true).limit(2000),
    ])

    setError(billRes.error ? `Could not read the purchase bills: ${billRes.error.message}` : '')
    setBills((billRes.data || []).map(toBill))
    setPayments((payRes.data || []).map(r => ({ billId: r.bill_id, date: r.payment_date, amount: Number(r.amount) || 0 })))
    setVendors((vendorRes.data || []).map(r => ({
      id: r.id, name: r.name || '', pan: r.pan || '', gstin: r.gstin || '',
    })))
  }

  const wp = useMemo(
    () => buildWorkpaper(bills, payments, vendors, state, fyStart, asOf),
    [bills, payments, vendors, state, fyStart, asOf],
  )

  const billsByKey = useMemo(() => {
    const map = new Map<string, TdsBill[]>()
    for (const b of bills) {
      const k = vendorKey(b)
      const list = map.get(k) || []
      list.push(b)
      map.set(k, list)
    }
    return map
  }, [bills])

  /** The workpaper reads section by section, which is how a reviewer checks it. */
  const grouped = useMemo(() => {
    const out: { section: SectionId; rows: DeductionRow[]; tax: number; chargeable: number }[] = []
    for (const r of wp.rows) {
      let g = out.find(x => x.section === r.section)
      if (!g) { g = { section: r.section, rows: [], tax: 0, chargeable: 0 }; out.push(g) }
      g.rows.push(r)
      g.tax += r.tax
      g.chargeable += r.chargeable
    }
    return out
  }, [wp])

  const nextDeposit = wp.months.find(m => m.status === 'pending') || wp.months.find(m => m.status === 'not-yet-due')
  const untaggedCount = wp.totals.untaggedBills
  const interestAtStake = wp.totals.interest + wp.totals.statementFee
  /** The register's own day, so a filing dated tomorrow is refused against the same clock the fee reads. */
  const todayISO = isoDay(asOf)

  const commit = useCallback((next: TdsState) => {
    setState(next)
    if (orgId) {
      const stamped = saveTds(orgId, next)
      setSavedAt(new Date(stamped.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
    }
  }, [orgId])

  function tagVendor(key: string, section: SectionId) {
    commit(setVendorSection(state, key, section))
  }

  function overrideBill(billId: string, section: SectionId | '') {
    commit(setBillSection(state, billId, section || 'NONE'))
  }

  function setChallanField(month: string, field: keyof Challan, raw: string) {
    const nextDraft = { ...draft, [`${month}:${field}`]: raw }
    setDraft(nextDraft)
    const stored = state.challans[month]
    const challan: Challan = {
      bsr: nextDraft[`${month}:bsr`] ?? stored?.bsr ?? '',
      challanNumber: nextDraft[`${month}:challanNumber`] ?? stored?.challanNumber ?? '',
      depositDate: nextDraft[`${month}:depositDate`] ?? stored?.depositDate ?? '',
      amount: nextDraft[`${month}:amount`] !== undefined ? Number(nextDraft[`${month}:amount`]) || 0 : stored?.amount ?? 0,
    }
    // Without a deposit date there is no deposit: the amount stays on screen as a
    // draft, and an undated challan is never saved as one.
    commit(setChallan(state, month, challan.depositDate ? challan : null))
  }

  /**
   * A quarter's filing day is a transcript, so it is held to the same two rules the engine reads by:
   * it cannot predate the quarter's close and it cannot be a day that has not come. A refused day is
   * never saved — the sentence stays beside the field and the quarter keeps reading to today.
   */
  function setStatementField(q: { due: string; periodTo: string }, field: keyof StatementFiling, raw: string) {
    const nextDraft = { ...draft, [`${q.due}:${field}`]: raw }
    setDraft(nextDraft)
    const stored = state.statementFilings[q.due]
    const filing: StatementFiling = {
      filedOn: nextDraft[`${q.due}:filedOn`] ?? stored?.filedOn ?? '',
      reference: nextDraft[`${q.due}:reference`] ?? stored?.reference ?? '',
    }
    const problems = validateStatementFiling(q.periodTo, filing.filedOn, todayISO)
    if (problems.length) {
      setStmtProblems(p => ({ ...p, [q.due]: problems }))
      return
    }
    setStmtProblems(p => {
      const next = { ...p }
      delete next[q.due]
      return next
    })
    // An empty day clears the row whole, exactly as an undated challan is not a deposit.
    commit(setStatementFiling(state, q.due, filing.filedOn ? filing : null))
  }

  function changeFy(year: number) {
    setFyStart(year)
    setDraft({})
    setState(loadTds(orgId))
    loadYear(orgId, year)
  }

  function exportDeductee() {
    download(`TDS-deductee-workpaper-${fyLabel(fyStart)}.csv`, toCsv(TDS_CSV_HEADERS, tdsCsvRows(wp)))
  }

  function exportDeposits() {
    download(`TDS-deposit-sheet-${fyLabel(fyStart)}.csv`, toCsv(TDS_DEPOSIT_CSV_HEADERS, tdsDepositCsvRows(wp)))
  }

  function exportStatements() {
    download(`TDS-26Q-statements-${fyLabel(fyStart)}.csv`, toCsv(TDS_STATEMENT_CSV_HEADERS, tdsStatementCsvRows(wp)))
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Reading the purchase bills…</div>
  }

  const valueRead = wp.totals.value

  return (
    <div className="page-container tds">
      <PageHeader
        eyebrow="Withholding workpaper"
        title={`TDS & 194Q — ${fyLabel(fyStart)}`}
        subtitle={
          <>
            Which purchase bills attract tax deduction, how much, when it was due and what the delay costs.
            {' '}<Badge tone="blue" dot={false}>workpaper only — nothing is filed</Badge>
          </>
        }
        actions={
          <>
            <select className="td-select" value={fyStart} onChange={e => changeFy(Number(e.target.value))} aria-label="Financial year">
              {yearOptions().map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
            <Button variant="subtle" size="sm" icon="download" onClick={exportDeductee}>Deductee sheet</Button>
            <Button variant="ghost" size="sm" icon="download" onClick={exportDeposits}>Deposit sheet</Button>
            <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>Print</Button>
          </>
        }
      />

      {error && (
        <Card style={{ marginBottom: '0.9rem', borderColor: 'var(--red)' }}>
          <span style={{ color: 'var(--red)', fontSize: 13 }}>{error}</span>
        </Card>
      )}

      <div className="td-stats">
        <StatCard label="Purchase value read" value={valueRead} icon="cart" tone="blue"
          sub={`${wp.totals.bills} bills in ${fyLabel(fyStart)}, GST excluded where itemised`} />
        <StatCard label="Tax to deduct" value={wp.totals.tax} icon="percent" tone="violet"
          sub={`${plural(wp.rows.length, 'bill')} over their limit · ${lakh(wp.totals.chargeable)} chargeable`} delay={60} />
        <StatCard label="Deposited against challan" value={wp.totals.deposited} icon="wallet" tone="green"
          sub={`${wp.months.filter(m => m.challan).length} of ${wp.months.length} deduction months paid in`} delay={120} />
        <StatCard label="Still to deposit" value={wp.totals.toDeposit}
          icon="alert" tone={wp.totals.overdue > 0 ? 'red' : 'grey'}
          sub={wp.totals.overdue > 0 ? `${lakh(wp.totals.overdue)} of it already past the due date` : 'Nothing outstanding'} delay={180} />
        <StatCard label="Interest & late fee at stake" value={interestAtStake} icon="clock"
          tone={interestAtStake > 0 ? 'amber' : 'grey'}
          sub={wp.totals.statementFeeCeiling > 0
            ? `1.5% a month on the deposit · the 26Q fee includes ${money(wp.totals.statementFeeCeiling)} read only to today`
            : `1.5% a month on the deposit, ${money(TDS_STATEMENT_FEE_PER_DAY)} a day on a late 26Q`} delay={240} />
        <StatCard label="Value with no section chosen" value={wp.totals.untaggedValue} icon="factory"
          tone={untaggedCount ? 'amber' : 'grey'}
          sub={untaggedCount ? `${plural(untaggedCount, 'bill')} — tag the supplier to include them` : 'Every supplier is tagged'}
          delay={300} />
      </div>

      <Card style={{ marginBottom: '0.9rem' }}>
        <div className="td-intro">
          <div>
            <div className="td-intro-title">What this does, and what it deliberately does not</div>
            <ul className="td-intro-list">
              <li>It reads your purchase bills and the payments made against them. It never writes to them — no bill is modified, no challan is filed.</li>
              <li>A purchase bill has no expense category, so the section is a decision you make once per supplier, with a per-bill override for the supplier who is also your landlord.</li>
              <li>Tax is charged on the earlier of the bill being entered and the payment being made, which is why a month can move.</li>
              <li>Goods, rent and professional fees are all in the same bills table, so nothing here is guessed at. Untagged value stays untagged and is shown above.</li>
            </ul>
          </div>
          <div className="td-intro-side">
            <div className="td-field-label">Who is paying</div>
            <Segmented value={state.payerType} onChange={v => commit({ ...state, payerType: v as PayerType })}
              options={[{ value: 'business', label: 'Business' }, { value: 'individual', label: 'Individual / HUF' }]} />
            <div className="td-field-hint">
              {state.payerType === 'individual'
                ? '194C drops to 1% and the annual limit rises to ₹5,00,00,000. 194M becomes the section for large contracts.'
                : '194C is 2% for a contractor and the aggregate limit is ₹1,00,000 per supplier.'}
            </div>
            <div className="td-payer-id">
              <Icon name="building" size={13} />
              <span>{orgName || 'This organisation'}{gstin ? ` · GSTIN ${gstin}` : ''}</span>
            </div>
            <div className="td-field-hint">
              Deposits and statements are made against your TAN, which lives on the challan counterfoil and not in these
              books — so it is carried on the challan columns below, never invented here.
            </div>
            <button type="button" className="td-toggle" onClick={() => setShowRates(s => !s)}>
              <Icon name={showRates ? 'x' : 'book'} size={13} />
              {showRates ? 'Hide the rate table' : 'Show the rate table used here'}
            </button>
          </div>
        </div>

        {showRates && (
          <div className="td-rates">
            {SECTIONS.map(s => (
              <div key={s.id} className="td-rate">
                <div className="td-rate-head">
                  <span className="td-rate-label">{s.label}</span>
                  <span className="td-rate-figures">
                    {s.id === 'NONE' ? 'no withholding'
                      : `${effectiveRate(s, state.payerType)}% · no PAN ${noPanRateOf(s)}% · limit ${s.threshold === Infinity ? '—' : lakh(s.threshold)}`}
                  </span>
                </div>
                <div className="td-rate-covers">{s.covers}</div>
                <div className="td-rate-note">{s.note}</div>
              </div>
            ))}
            <div className="td-rates-foot">
              Rates as this page applies them. The Income Tax Act, 2025 renumbers these sections from 1 April 2026 —
              the 194-series labels are kept because that is what TRACES and your CA use. Confirm each figure before filing.
            </div>
          </div>
        )}
      </Card>

      {untaggedCount > 0 && (
        <div className="td-gap" onClick={() => setTab('suppliers')}>
          <Icon name="alert" size={15} />
          <span>
            <b>{lakh(wp.totals.untaggedValue)}</b> across {plural(untaggedCount, 'bill')} with no
            section chosen, so no withholding is reported on them. Pick a section for each supplier on the{' '}
            <b>Supplier sections</b> tab.
          </span>
        </div>
      )}

      <Card pad={false} className="td-panel">
        <div className="tab-bar no-print td-tabs">
          {TABS.map(t => (
            <button key={t.value} type="button" className={`td-tab ${tab === t.value ? 'is-on' : ''}`} onClick={() => setTab(t.value)}>
              <Icon name={t.icon} size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'workpaper' && (
          <div className="td-body">
            <Headline
              title="Every bill the workpaper says tax should come off"
              note="Grouped by section, in the order the year happened. Chargeable is the part of the bill tax is applied to — the whole bill for contracts and rent, only the slice above the limit for 194Q."
            />
            {grouped.length === 0 ? (
              <EmptyState icon="clipboard"
                title={!valueRead ? 'No purchase bills in this year'
                  : untaggedCount ? 'No supplier is tagged yet' : 'Nothing crosses a limit yet'}
                message={!valueRead
                  ? 'Add purchase bills and this page will read the withholding out of them.'
                  : untaggedCount
                    ? `${lakh(wp.totals.untaggedValue)} of bills are waiting for a section on the Supplier sections tab. Nothing is reported here until you choose one.`
                    : 'Every tagged supplier is still below their section limit. The supplier tab shows the headroom left on each one.'}
                action={!valueRead ? <Button size="sm" variant="subtle" icon="cart" href="/bills">Open purchase bills</Button> : undefined} />
            ) : (
              <div className="table-scroll">
                <div className="td-grid">
                  <div className="td-cols td-head" style={{ gridTemplateColumns: ROWS_GRID }}>
                    {ROWS_COLS.map(c => <span key={c} className={c === 'Bill' ? '' : 'is-right'}>{c}</span>)}
                  </div>
                  {grouped.map(g => {
                    const s = sectionOf(g.section)
                    return (
                      <div key={g.section}>
                        <div className="td-band">
                          <span className="td-band-label">{s.label}</span>
                          <span className="td-band-covers">{s.covers}</span>
                          <span className="td-band-count tf-num">{plural(g.rows.length, 'bill')}</span>
                          <span className="td-band-tax tf-num">{money(g.chargeable)} chargeable</span>
                          <span className="td-band-total tf-num">{money(g.tax)}</span>
                        </div>
                        {g.rows.map(r => (
                          <div key={r.billId} className="td-cols td-row" style={{ gridTemplateColumns: ROWS_GRID }}>
                            <span className="td-doc" data-label="Bill">
                              <b>{r.billNumber}</b>
                              <em>{formatDateIN(r.billDate)} · {r.eventLabel}</em>
                            </span>
                            <span className="td-party" data-label="Deductee">
                              {r.vendorName || '—'}
                              <em className="td-pan">{r.pan || 'PAN not on file'}</em>
                            </span>
                            <span className="is-right tf-num" data-label="Base">{money(r.base)}</span>
                            <span className="is-right tf-num" data-label="Chargeable">{money(r.chargeable)}</span>
                            <span className="is-right tf-num" data-label="Rate">{r.rate}%</span>
                            <span className="is-right td-tax tf-num" data-label="TDS">{money(r.tax)}</span>
                            <span className="is-right" data-label="Deposit">
                              <span className="td-due-month">{r.month}</span>
                              <em className="td-due-date">by {formatDateIN(r.depositDue)}</em>
                            </span>
                            <span className="td-why" data-label="Why">{r.note}</span>
                          </div>
                        ))}
                      </div>
                    )
                  })}
                  <div className="td-cols td-foot" style={{ gridTemplateColumns: ROWS_GRID }}>
                    <span className="td-doc">Total</span>
                    <span />
                    <span className="is-right tf-num">{money(bills.reduce((s, b) => s + b.taxable, 0))}</span>
                    <span className="is-right tf-num">{money(wp.totals.chargeable)}</span>
                    <span />
                    <span className="is-right td-tax tf-num">{money(wp.totals.tax)}</span>
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            )}
            <div className="td-foot-note">
              {nextDeposit && <>Next deposit: <b>{money(nextDeposit.tax)}</b> for {nextDeposit.label}, due {formatDateIN(nextDeposit.due)}.{' '}</>}
              Import and export documents (IGST on IMS) and salary TDS under 194(1) are outside this workpaper —
              the first lives on the portal, the second in the payroll.
            </div>
          </div>
        )}

        {tab === 'deposits' && (
          <div className="td-body">
            <Headline
              title="Month by month, what was due and what was paid in"
              note="Fill a challan from the bank challan you already deposited: BSR code, challan serial, date and amount. Interest is then estimated the way section 201(1A) counts it — a month or part of a month."
            />
            <div className="td-tools no-print">
              <span className="td-saved">
                {savedAt ? `Saved on this device at ${savedAt}` : 'Nothing saved yet'}
                {' '}· {wp.months.filter(m => m.challan).length} of {wp.months.length} months recorded
              </span>
              <Button size="sm" variant="ghost" icon="download" onClick={exportDeposits}>Deposit sheet CSV</Button>
            </div>

            {wp.months.length === 0 ? (
              <EmptyState icon="wallet" title="No deductions to deposit for this year"
                message="Once a supplier is tagged and crosses their limit, the month the tax belongs to appears here with its due date." />
            ) : (
              <div className="td-deps">
                {wp.months.map(m => {
                  const st = STATUS_TONE[m.status]
                  const c = m.challan
                  return (
                    <div key={m.month} className={`td-dep is-${m.status}`}>
                      <div className="td-dep-head">
                        <div>
                          <div className="td-dep-month">{m.label}</div>
                          <div className="td-dep-sub">
                            {plural(m.rows, 'bill')} · due {formatDateIN(m.due)}
                          </div>
                        </div>
                        <div className="td-dep-right">
                          <div className="td-dep-tax">{money(m.tax)}</div>
                          <Badge tone={st.tone}>{st.label}</Badge>
                        </div>
                      </div>

                      <div className="td-dep-form">
                        <label className="td-in">
                          <span>Deposited ₹</span>
                          <input className="tf-input tf-num" inputMode="decimal"
                            value={draftFor(draft, m.month, 'amount', c?.amount)}
                            onChange={e => setChallanField(m.month, 'amount', e.target.value)}
                            aria-label={`${m.label} amount deposited`} />
                        </label>
                        <label className="td-in">
                          <span>Deposit date</span>
                          <input className="tf-input" type="date"
                            value={textFor(draft, m.month, 'depositDate', c?.depositDate)}
                            onChange={e => setChallanField(m.month, 'depositDate', e.target.value)}
                            aria-label={`${m.label} deposit date`} />
                        </label>
                        <label className="td-in">
                          <span>BSR code</span>
                          <input className="tf-input tf-num" inputMode="numeric" maxLength={7} placeholder="7 digits"
                            value={textFor(draft, m.month, 'bsr', c?.bsr)}
                            onChange={e => setChallanField(m.month, 'bsr', e.target.value)}
                            aria-label={`${m.label} BSR code`} />
                        </label>
                        <label className="td-in">
                          <span>Challan number</span>
                          <input className="tf-input tf-num" inputMode="numeric" maxLength={10} placeholder="counterfoil"
                            value={textFor(draft, m.month, 'challanNumber', c?.challanNumber)}
                            onChange={e => setChallanField(m.month, 'challanNumber', e.target.value)}
                            aria-label={`${m.label} challan number`} />
                        </label>
                      </div>

                      {!c && Number(draft[`${m.month}:amount`] || 0) > 0 && (
                        <div className="td-dep-hint">
                          The amount is held until you add the deposit date — a challan without a date is not a deposit.
                        </div>
                      )}

                      <div className="td-dep-foot">
                        {m.status === 'pending' && (
                          <span className="td-dep-warn">
                            {m.monthsLate === 0
                              ? 'Falls due today and nothing is paid in yet.'
                              : `Not deposited, ${plural(m.monthsLate, 'month')} past the due date — interest at 1% a month where tax was never deducted: ${money(m.interest)}`}
                          </span>
                        )}
                        {m.status === 'not-yet-due' && <span className="td-dep-ok">Deposit falls due {formatDateIN(m.due)}.</span>}
                        {(m.status === 'late' || m.status === 'short') && (
                          <span className="td-dep-warn">
                            {m.shortfall > 0
                              ? `${money(m.shortfall)} short of what the workpaper says was due · `
                              : `${plural(m.monthsLate, 'month')} late · `}
                            interest at 1.5% a month: {money(m.interest)}
                          </span>
                        )}
                        {m.status === 'deposited' && (
                          <span className="td-dep-ok">
                            Paid in on {formatDateIN(c!.depositDate)}{c!.challanNumber ? ` · challan ${c!.challanNumber}` : ''}.
                          </span>
                        )}
                        {c && (
                          <button type="button" className="td-clear" onClick={() => {
                            commit(setChallan(state, m.month, null))
                            setDraft(d => {
                              const next = { ...d }
                              for (const k of ['amount', 'depositDate', 'bsr', 'challanNumber']) delete next[`${m.month}:${k}`]
                              return next
                            })
                          }}>
                            <Icon name="x" size={12} /> Clear this challan
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <div className="td-foot-note">
              March deductions have until 30 April, every other month until the 7th of the one after it.
              Interest runs from the due date to the date of deduction and payment respectively — the figure here is an
              estimate to plan against, not the demand.
            </div>
          </div>
        )}

        {tab === 'suppliers' && (
          <div className="td-body">
            <Headline
              title="One section per supplier, one override per bill"
              note="A supplier is normally one kind of spend, so tagging them once covers every bill. Open a supplier to change a single bill — the freight bill from a trader who also rents you a godown."
            />
            <div className="td-tools no-print">
              <span className="td-saved">{plural(wp.vendors.length, 'supplier')} with bills in {fyLabel(fyStart)}</span>
            </div>

            {wp.vendors.length === 0 ? (
              <EmptyState icon="factory" title="No suppliers billed you in this year"
                message="Purchase bills are the input for this page. Add one and the supplier will show up here to be tagged." />
            ) : (
              <div className="table-scroll">
                <div className="td-grid">
                  <div className="td-cols td-head" style={{ gridTemplateColumns: VENDOR_GRID }}>
                    {VENDOR_COLS.map(c => <span key={c} className={c === 'Supplier' ? '' : 'is-right'}>{c}</span>)}
                  </div>
                  {wp.vendors.map(v => {
                    const s = sectionOf(v.section)
                    const open = openVendors[v.key]
                    const list = billsByKey.get(v.key) || []
                    return (
                      <div key={v.key}>
                        <div className={`td-cols td-row td-vrow ${v.tagged ? '' : 'is-untagged'}`} style={{ gridTemplateColumns: VENDOR_GRID }}>
                          <span className="td-party" data-label="Supplier">
                            <button type="button" className="td-vname" onClick={() => setOpenVendors(o => ({ ...o, [v.key]: !o[v.key] }))}>
                              <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
                              {v.name || '—'}
                            </button>
                            <em className="td-pan">
                              {v.pan ? `PAN ${v.pan}${v.panSource === 'gstin' ? ' · from GSTIN' : ''}` : 'no PAN on file'}
                              {' '}· {plural(list.length, 'bill')}
                            </em>
                          </span>
                          <span className="td-sec" data-label="Section">
                            <select className="td-select td-select-sm" value={v.tagged ? v.section : ''}
                              onChange={e => tagVendor(v.key, (e.target.value || 'NONE') as SectionId)}
                              aria-label={`Section for ${v.name}`}>
                              <option value="" disabled>Choose a section…</option>
                              {SECTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>
                          </span>
                          <span className="is-right tf-num" data-label="Value">{money(v.value)}</span>
                          <span className="is-right tf-num" data-label="TDS so far">{money(v.tax)}</span>
                          <span className="is-right td-watch" data-label="Limit">
                            {!v.tagged
                              ? <span className="td-need">Section not chosen</span>
                              : v.section === 'NONE'
                                ? <span className="td-done">Nothing to withhold</span>
                                : v.tax > 0
                                  ? <span className="td-over">Over the limit</span>
                                  : v.projectedCrossMonth
                                    ? <span className="td-soon">Crosses by {v.projectedCrossMonth}</span>
                                    : <span>{lakh(v.headroom)} of room left</span>}
                          </span>
                        </div>

                        {open && (
                          <div className="td-bills">
                            {v.tagged && (
                              <div className="td-bills-hint">
                                {s.note}
                                {v.projectedCrossMonth ? ` At the run rate so far, the limit is crossed by ${v.projectedCrossMonth}.` : ''}
                              </div>
                            )}
                            {list.map(b => (
                              <div key={b.id} className="td-bill">
                                <span className="td-bill-doc">{b.billNumber}</span>
                                <span className="td-bill-date">{formatDateIN(b.billDate)}</span>
                                <span className="td-bill-base tf-num">{money(tdsBase(b))}</span>
                                <select className="td-select td-select-sm"
                                  value={state.billSection[b.id] || ''}
                                  onChange={e => overrideBill(b.id, e.target.value as SectionId | '')}
                                  aria-label={`Section override for bill ${b.billNumber}`}>
                                  <option value="">Follow the supplier tag</option>
                                  {SECTIONS.filter(x => x.id !== 'NONE').map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                                </select>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="td-foot-note">
              A supplier with no PAN in the vendor record has the PAN read out of their GSTIN when the bill carries one;
              where neither exists the section&apos;s no-PAN rate applies — for 194C that is 20%, which is why the field matters.
              Fill it on <Link href="/vendors" className="td-inline-link">the vendor record</Link>.
            </div>
          </div>
        )}

        {tab === 'statements' && (
          <div className="td-body">
            <Headline
              title="Form 138 / 140 (24Q / 26Q), quarter by quarter"
              note="The statement itself is filed on the income-tax portal, so this page cannot confirm a filing. Record the day the shop says it went in and the late-statement fee stops there — a transcript, not proof. A quarter with no filing day keeps reading to today, and its fee is printed as a ceiling."
            />
            <div className="td-tools no-print">
              <span className="td-saved">
                {savedAt ? `Saved on this device at ${savedAt}` : 'Nothing saved yet'}
                {' '}· {wp.statements.filter(q => q.filedOn).length} of {wp.statements.length} quarters have a filing day
              </span>
              <Button size="sm" variant="ghost" icon="download" onClick={exportStatements}>Statement sheet CSV</Button>
            </div>

            <div className="td-stmts">
              {wp.statements.map(q => {
                // The engine filters a day it cannot read; the field shows the reading, not the store.
                const shownDate = textFor(draft, q.due, 'filedOn', q.filedOn)
                const shownRef = textFor(draft, q.due, 'reference', q.reference)
                const badge = q.ceiling
                  ? { tone: 'red' as const, label: 'Ceiling — no filing day' }
                  : q.stopped
                    ? { tone: 'amber' as const, label: 'Filed late — clock stopped' }
                    : q.filedOn
                      ? { tone: 'green' as const, label: 'Filed on time' }
                      : q.due > todayISO
                        ? { tone: 'grey' as const, label: 'Not due yet' }
                        : { tone: 'grey' as const, label: 'No filing day' }
                return (
                  <div key={q.quarter} className={`td-stmt ${q.ceiling ? 'is-ceiling' : q.stopped ? 'is-late' : q.filedOn ? 'is-filed' : ''}`}>
                    <div className="td-dep-head">
                      <div>
                        <div className="td-dep-month">{q.quarter} · {q.label}</div>
                        <div className="td-dep-sub">
                          {formatDateIN(q.periodFrom)} to {formatDateIN(q.periodTo)} · due {formatDateIN(q.due)}
                        </div>
                      </div>
                      <div className="td-dep-right">
                        <div className="td-dep-tax">{money(q.tax)}</div>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </div>
                    </div>

                    <div className="td-stmt-figures">
                      <span>
                        <em>Days late</em>
                        <b className="tf-num">{q.daysLate || '—'}</b>
                      </span>
                      <span>
                        <em>Late fee · 427</em>
                        <b className="tf-num">{q.fee ? money(q.fee) : '—'}</b>
                      </span>
                      <span>
                        <em>Per day</em>
                        <b className="tf-num">
                          {q.ceiling
                            ? q.capped ? '₹0, at the cap' : `${money(TDS_STATEMENT_FEE_PER_DAY)}, still running`
                            : q.stopped ? '₹0, stopped' : '—'}
                        </b>
                      </span>
                    </div>

                    <div className="td-dep-form td-stmt-form">
                      <label className="td-in">
                        <span>Statement filed on</span>
                        <input className="tf-input" type="date" max={todayISO}
                          value={shownDate}
                          onChange={e => setStatementField(q, 'filedOn', e.target.value)}
                          aria-label={`${q.quarter} ${q.label} statement filing date`} />
                      </label>
                      <label className="td-in">
                        <span>Acknowledgement</span>
                        <input className="tf-input" maxLength={20} placeholder="portal acknowledgement"
                          value={shownRef}
                          onChange={e => setStatementField(q, 'reference', e.target.value)}
                          aria-label={`${q.quarter} ${q.label} statement acknowledgement`} />
                      </label>
                    </div>

                    {!shownDate && shownRef.trim() !== '' && (
                      <div className="td-dep-hint">
                        The acknowledgement is held until a filing day is added — a reference alone does not stop the clock.
                      </div>
                    )}

                    {stmtProblems[q.due] && (
                      <div className="td-dep-hint">
                        {stmtProblems[q.due].map(msg => <div key={msg}>{msg}</div>)}
                      </div>
                    )}

                    <div className="td-dep-foot">
                      <span className={q.ceiling || q.stopped ? 'td-dep-warn' : 'td-dep-ok'}>
                        {q.ceiling
                          ? q.capped
                            ? `No filing day is recorded, but the fee has reached ${money(q.fee)} — the tax for the quarter — so another late day adds nothing.`
                            : `No filing day is recorded, so the clock still runs: ${money(q.fee)} to ${formatDateIN(todayISO)}, and it keeps growing.`
                          : q.stopped
                            ? `The register holds ${formatDateIN(q.filedOn)}: ${plural(q.daysLate, 'day')} late, ${money(q.fee)}.`
                            : q.filedOn
                              ? `Filed ${formatDateIN(q.filedOn)}, on or before the due date — nothing is at stake.`
                              : q.tax > 0 && q.due > todayISO
                                ? `The statement falls due ${formatDateIN(q.due)}; nothing has run yet.`
                                : 'Nothing was withheld in this quarter, so the fee reads nil.'}
                      </span>
                      {q.filedOn && (
                        <button type="button" className="td-clear" onClick={() => {
                          commit(setStatementFiling(state, q.due, null))
                          setDraft(d => {
                            const next = { ...d }
                            for (const k of ['filedOn', 'reference']) delete next[`${q.due}:${k}`]
                            return next
                          })
                          setStmtProblems(p => {
                            const next = { ...p }
                            delete next[q.due]
                            return next
                          })
                        }}>
                          <Icon name="x" size={12} /> Clear this filing
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            <div className="td-stmt-total">
              <span>{fyLabel(fyStart)} · tax across the four quarters</span>
              <b className="tf-num">{money(wp.totals.tax)}</b>
              <span>Fee at stake</span>
              <b className="tf-num">{money(wp.totals.statementFee)}</b>
              {wp.totals.statementFeeCeiling > 0 && (
                <em>
                  {money(wp.totals.statementFeeCeiling)} of that fee is a ceiling —{' '}
                  {plural(wp.statements.filter(q => q.ceiling).length, 'quarter')} with no filing day.
                </em>
              )}
            </div>

            <div className="td-links">
              <Link className="td-link" href="/gst/calendar">
                <Icon name="calendar" size={14} /> Compliance calendar — the TDS due dates live there
              </Link>
              <Link className="td-link" href="/gst/gstr9">
                <Icon name="file-check" size={14} /> GSTR-9 / 9C annual workpaper
              </Link>
              <Link className="td-link" href="/reports/registers">
                <Icon name="clipboard" size={14} /> Statutory registers for the same year
              </Link>
              <Link className="td-link" href="/bank">
                <Icon name="landmark" size={14} /> Match the payments that settled these bills
              </Link>
            </div>

            <div className="td-foot-note">
              {money(TDS_STATEMENT_FEE_PER_DAY)} a day under {TDS_STATEMENT_FEE_CITATION} for a late statement,
              capped at the tax involved. A separate penalty of ₹10,000 to ₹1,00,000 under{' '}
              {TDS_STATEMENT_PENALTY_CITATION} can follow a late or incorrect statement — it is a penalty the
              officer decides, not a daily charge, so this page does not accrue it. The 2025 Act calls this
              statement Form 140; the familiar 26Q name is kept. The day recorded above is the shop&apos;s own
              transcript — the portal is still invisible, so a quarter with no day on it is printed as a
              ceiling, never as the final demand.
              {' '}{SAMPLE_TDS_NOTE}
            </div>
          </div>
        )}
      </Card>

      <style jsx>{`
        .td-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 0.95rem; }
        .td-intro { display: grid; grid-template-columns: 1.7fr 1fr; gap: 20px; align-items: start; }
        .td-intro-title { font-size: 13.5px; font-weight: 680; color: var(--ink); margin-bottom: 8px; }
        .td-intro-list { margin: 0; padding-left: 17px; font-size: 12.5px; color: var(--muted); line-height: 1.62; }
        .td-intro-list li { margin-bottom: 5px; }
        .td-intro-side { display: flex; flex-direction: column; gap: 9px; }
        .td-field-label { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        .td-field-hint { font-size: 11.5px; color: var(--faint); line-height: 1.55; }
        .td-payer-id {
          display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 9px;
          background: var(--surface-2); border: 1px solid var(--line); font-size: 12px; font-weight: 620; color: var(--ink-2);
        }
        .td-payer-id svg { color: var(--brand); flex-shrink: 0; }
        .td-toggle {
          display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 7px 11px;
          border: 1px solid var(--line); border-radius: 9px; background: var(--surface-2); color: var(--ink-2);
          font-size: 12px; font-weight: 600; cursor: pointer;
        }
        .td-toggle:hover { border-color: var(--brand); color: var(--brand); }
        .td-rates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--line); }
        .td-rate { padding: 11px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); }
        .td-rate-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
        .td-rate-label { font-size: 12.5px; font-weight: 700; color: var(--ink); }
        .td-rate-figures { font-size: 11.5px; font-weight: 620; color: var(--brand); font-variant-numeric: tabular-nums; }
        .td-rate-covers { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
        .td-rate-note { font-size: 11.5px; color: var(--faint); line-height: 1.55; margin-top: 6px; }
        .td-rates-foot { grid-column: 1 / -1; font-size: 11.5px; color: var(--faint); line-height: 1.6; }
        .td-gap {
          display: flex; align-items: flex-start; gap: 9px; margin-bottom: 0.9rem; padding: 12px 14px; cursor: pointer;
          border-radius: 12px; border: 1px solid rgba(240, 138, 0, .4); background: var(--amber-soft);
          font-size: 12.5px; color: var(--ink-2); line-height: 1.55;
        }
        .td-gap svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }
        .td-gap b { color: var(--ink); }
        .td-panel { margin-bottom: 1rem; }
        .td-tabs { padding: 4px 6px 0; }
        .td-tab {
          display: inline-flex; align-items: center; gap: 7px; padding: 9px 13px; border: none; background: none;
          border-bottom: 2px solid transparent; color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer;
          white-space: nowrap;
        }
        .td-tab:hover { color: var(--ink-2); }
        .td-tab.is-on { color: var(--brand); border-bottom-color: var(--brand); }
        .td-body { padding: 1.15rem 1.1rem 1.3rem; }
        .td-section-head { margin-bottom: 12px; }
        .td-head-line { font-size: 13.5px; font-weight: 680; color: var(--ink); margin-bottom: 3px; }
        .td-head-note { font-size: 12px; color: var(--muted); line-height: 1.58; max-width: 900px; }
        .td-tools { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: -4px 0 14px; }
        .td-saved { font-size: 11.5px; color: var(--faint); }
        .td-grid { min-width: 880px; }
        .td-cols { display: grid; gap: 10px; align-items: center; padding: 10px 12px; }
        .td-head {
          background: var(--surface-2); border-bottom: 1px solid var(--line);
          font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint);
        }
        .td-head span:last-child, .td-cols .is-right { text-align: right; }
        .td-row { border-bottom: 1px solid var(--line); font-size: 12.5px; color: var(--ink-2); }
        .td-row:nth-child(odd) { background: rgba(255,255,255,0.015); }
        .td-band {
          display: grid; grid-template-columns: 1.3fr 1.6fr .9fr .9fr .8fr; gap: 10px; align-items: center;
          padding: 8px 12px; background: var(--brand-soft); border-bottom: 1px solid var(--line);
        }
        .td-band-label { font-size: 11.5px; font-weight: 740; color: var(--brand); }
        .td-band-covers { font-size: 11px; color: var(--muted); }
        .td-band-count, .td-band-tax { font-size: 11px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
        .td-band-total { font-size: 12px; font-weight: 700; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }
        .td-doc b { display: block; font-size: 12.5px; font-weight: 650; color: var(--ink); }
        .td-doc em, .td-party em { display: block; font-style: normal; font-size: 11px; color: var(--faint); margin-top: 2px; }
        .td-party { min-width: 0; }
        .td-pan { color: var(--faint); letter-spacing: .02em; }
        .td-tax { font-weight: 700; color: var(--ink); }
        .td-due-month { display: block; font-size: 12px; font-weight: 640; color: var(--ink-2); font-variant-numeric: tabular-nums; }
        .td-due-date { display: block; font-style: normal; font-size: 11px; color: var(--faint); }
        .td-why { font-size: 11.5px; color: var(--muted); line-height: 1.45; }
        .td-foot { border-top: 1px solid var(--line); background: var(--surface-2); font-size: 12.5px; font-weight: 700; color: var(--ink); }
        .td-foot-note { font-size: 11.5px; color: var(--faint); line-height: 1.62; margin-top: 14px; }
        .td-foot-note b { color: var(--muted); }
        .td-inline-link { color: var(--brand); text-decoration: none; font-weight: 600; }

        .td-deps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .td-dep { border: 1px solid var(--line); border-radius: 13px; padding: 13px 14px; background: var(--surface); }
        .td-dep.is-pending { border-color: rgba(231, 76, 60, .45); }
        .td-dep.is-late, .td-dep.is-short { border-color: rgba(240, 138, 0, .45); }
        .td-dep.is-deposited { border-color: rgba(39, 174, 96, .4); }
        .td-dep-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
        .td-dep-month { font-size: 13.5px; font-weight: 700; color: var(--ink); }
        .td-dep-sub { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
        .td-dep-right { text-align: right; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .td-dep-tax { font-size: 16px; font-weight: 720; color: var(--ink); font-variant-numeric: tabular-nums; }
        .td-dep-form { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; margin-top: 12px; }
        .td-in { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .td-in span { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .td-in input { width: 100%; font-size: 12.5px; padding: 7px 9px; }
        .td-dep-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 11px; }
        .td-dep-hint { font-size: 11.5px; color: var(--amber); margin-top: 8px; line-height: 1.5; }
        .td-dep-warn { font-size: 11.5px; color: var(--red); line-height: 1.5; }
        .td-dep-ok { font-size: 11.5px; color: var(--green); line-height: 1.5; }
        .td-clear {
          display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px; border: 1px solid var(--line);
          border-radius: 8px; background: none; color: var(--faint); font-size: 11.5px; cursor: pointer;
        }
        .td-clear:hover { color: var(--red); border-color: var(--red); }

        .td-stmts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
        .td-stmt { border: 1px solid var(--line); border-radius: 13px; padding: 13px 14px; background: var(--surface); }
        .td-stmt.is-ceiling { border-color: rgba(231, 76, 60, .45); }
        .td-stmt.is-late { border-color: rgba(240, 138, 0, .45); }
        .td-stmt.is-filed { border-color: rgba(39, 174, 96, .4); }
        .td-stmt-figures {
          display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 9px; margin-top: 11px;
          padding: 9px 10px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line);
        }
        .td-stmt-figures span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .td-stmt-figures em {
          font-style: normal; font-size: 10.5px; font-weight: 700; letter-spacing: .05em;
          text-transform: uppercase; color: var(--faint);
        }
        .td-stmt-figures b { font-size: 12.5px; font-weight: 680; color: var(--ink); }
        .td-stmt-form { grid-template-columns: 1fr 1.2fr; }
        .td-stmt-total {
          display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-top: 14px;
          padding: 11px 13px; border: 1px solid var(--line); border-radius: 11px;
          background: var(--surface-2); font-size: 12px; color: var(--muted);
        }
        .td-stmt-total b { color: var(--ink); font-variant-numeric: tabular-nums; }
        .td-stmt-total em { font-style: normal; flex-basis: 100%; color: var(--amber); }

        .td-vrow.is-untagged { background: var(--amber-soft); }
        .td-vname {
          display: inline-flex; align-items: center; gap: 6px; padding: 0; border: none; background: none;
          color: var(--ink); font-size: 12.5px; font-weight: 650; cursor: pointer; text-align: left;
        }
        .td-vname:hover { color: var(--brand); }
        .td-sec select { width: 100%; }
        .td-select {
          padding: 7px 10px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface);
          color: var(--ink-2); font-size: 12.5px; cursor: pointer;
        }
        .td-select-sm { padding: 5px 8px; font-size: 11.5px; }
        .td-watch { font-size: 11.5px; color: var(--muted); }
        .td-over { color: var(--green); font-weight: 640; }
        .td-soon { color: var(--amber); font-weight: 640; }
        .td-need { color: var(--amber); font-weight: 640; }
        .td-done { color: var(--faint); }
        .td-bills { padding: 4px 12px 12px 12px; background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .td-bills-hint { font-size: 11.5px; color: var(--muted); line-height: 1.55; padding: 8px 0 10px; }
        .td-bill { display: grid; grid-template-columns: 1.1fr .9fr .8fr 1.5fr; gap: 10px; align-items: center; padding: 6px 0; border-top: 1px dashed var(--line); }
        .td-bill-doc { font-size: 12px; font-weight: 620; color: var(--ink-2); }
        .td-bill-date { font-size: 11.5px; color: var(--faint); }
        .td-bill-base { font-size: 12px; color: var(--muted); text-align: right; font-variant-numeric: tabular-nums; }
        .td-bill select { width: 100%; }
        .td-links { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 16px 0 4px; }
        .td-link {
          display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px;
          border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
          font-size: 12.5px; text-decoration: none; transition: border-color .12s ease, background .12s ease;
        }
        .td-link:hover { border-color: var(--brand); background: var(--brand-soft); color: var(--brand); }

        @media (max-width: 1200px) {
          .td-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .td-intro { grid-template-columns: 1fr; gap: 14px; }
          .td-rates { grid-template-columns: 1fr; }
        }
        @media (max-width: 900px) {
          .td-deps { grid-template-columns: 1fr; }
          .td-stmts { grid-template-columns: 1fr; }
        }
        @media (max-width: 768px) {
          .td-stats { grid-template-columns: 1fr; }
          .td-body { padding: 0.9rem 0.8rem 1.1rem; }
          .td-tabs { padding: 4px 4px 0; overflow-x: auto; }
          .td-grid { min-width: 0; }
          .td-head { display: none !important; }
          .td-cols { grid-template-columns: 1fr !important; gap: 6px; padding: 12px 13px; }
          .td-row { border: 1px solid var(--line); border-radius: 12px; margin-bottom: 10px; background: var(--surface); }
          .td-cols > span { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; text-align: right; min-width: 0; white-space: normal; }
          .td-cols > span::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: .05em; text-align: left; flex: 1;
          }
          .td-band { grid-template-columns: 1fr; gap: 3px; }
          .td-band-count, .td-band-tax, .td-band-total { text-align: left; }
          .td-dep-form { grid-template-columns: 1fr 1fr; }
          .td-stmt-form { grid-template-columns: 1fr; }
          .td-bill { grid-template-columns: 1fr; gap: 4px; }
          .td-bill-base { text-align: left; }
          .td-links { grid-template-columns: 1fr; }
        }
        @media print {
          .td-tabs, .td-tools, .td-select, .td-toggle, .td-dep-form, .td-stmt-form, .td-clear, .td-links, .no-print { display: none !important; }
          .td-stats { grid-template-columns: repeat(3, 1fr); }
          .td-grid { min-width: 0; }
          .td-body { padding: 0; }
        }
      `}</style>
    </div>
  )
}

/* ── layout ─────────────────────────────────────────────────────────────── */

const ROWS_COLS = ['Bill', 'Deductee', 'Base value', 'Chargeable', 'Rate', 'TDS', 'Deposit', 'Why this bill']
const ROWS_GRID = '1.25fr 1.35fr .85fr .9fr .5fr .8fr 1fr 1.5fr'

const VENDOR_COLS = ['Supplier', 'Section', 'Value in the year', 'TDS so far', 'Against the limit']
const VENDOR_GRID = '1.5fr 1.4fr .95fr .9fr 1.15fr'

function yearOptions(): number[] {
  const now = fyStartYear(new Date())
  return [now, now - 1, now - 2, now - 3]
}

/** The page's own day, in the same 'YYYY-MM-DD' shape the register stores. */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function draftFor(draft: Record<string, string>, month: string, field: string, value: number | undefined): string {
  const d = draft[`${month}:${field}`]
  if (d !== undefined) return d
  return value ? String(value) : ''
}

/** Challan and statement text fields keep whatever was typed, even before the row has a date. */
function textFor(draft: Record<string, string>, month: string, field: string, value: string | undefined): string {
  const d = draft[`${month}:${field}`]
  return d !== undefined ? d : value ?? ''
}

/** The columns this workpaper reads off a purchase bill row. */
interface BillRow {
  id: string
  bill_number?: string | null
  bill_date?: string | null
  vendor_id?: string | null
  vendor_name?: string | null
  vendor_gstin?: string | null
  taxable_amount?: number | null
  cgst_amount?: number | null
  sgst_amount?: number | null
  igst_amount?: number | null
  cess_amount?: number | null
  grand_total?: number | null
  balance_due?: number | null
}

function toBill(r: BillRow): TdsBill {
  const gst = [r.cgst_amount, r.sgst_amount, r.igst_amount, r.cess_amount]
    .reduce((s: number, k) => s + (Number(k) || 0), 0)
  return {
    id: r.id,
    billNumber: r.bill_number || '',
    billDate: r.bill_date || '',
    vendorId: r.vendor_id || '',
    vendorName: r.vendor_name || '',
    gstin: r.vendor_gstin || '',
    taxable: Number(r.taxable_amount) || 0,
    gst,
    grandTotal: Number(r.grand_total) || 0,
    balanceDue: Number(r.balance_due) || 0,
  }
}

/* ── small presentational pieces ── */

function Headline({ title, note }: { title: string; note: string }) {
  return (
    <div className="td-section-head">
      <div className="td-head-line">{title}</div>
      <div className="td-head-note">{note}</div>
    </div>
  )
}
