'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'
import { useRouter } from 'next/navigation'
import {
  DEFAULT_PROFILE, estimateLateCharge, generateEvents, googleCalendarUrl,
  loadStatuses, saveStatuses, toIcs, type ComplianceEvent, type Profile, type StatusMap,
} from '@/lib/compliance'
import { download } from '@/lib/party-ledger'
import { itc04Cadence, itc04Periods, loadJob } from '@/lib/jobwork'
import { isExportDoc, loadExp, todayISO, watchRows, type ExportBookInvoice, type FxDealLite, type WatchRow } from '@/lib/exports'
import { loadFx } from '@/lib/fx'
import { addMonths, loadPayroll, payrollEvents, type PayEvent } from '@/lib/payroll'
import { formatINR } from '@/lib/gst-engine'
import { formatCompactINR, formatDateIN } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, Segmented, StatRow } from '@/components/ui'
import Icon from '@/components/Icons'

const DAY = 86400000
const PROFILE_KEY = 'taxflow:compliance-profile:'

const CATEGORY_META: Record<string, { label: string; tone: 'blue' | 'violet' | 'cyan' | 'amber' | 'grey' }> = {
  gst: { label: 'GST', tone: 'blue' },
  tds: { label: 'TDS', tone: 'violet' },
  'income-tax': { label: 'Income tax', tone: 'cyan' },
  payroll: { label: 'Payroll', tone: 'amber' },
  other: { label: 'Other', tone: 'grey' },
}

function currentFyStart(d = new Date()) {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
}

/**
 * ITC-04 belongs on the calendar only for a business that actually sends goods out for job
 * work, and here the honest signal is the register itself: movements recorded ⇒ statements owed.
 * The register is localStorage (ADR-013) and the half-yearly/annual pair comes from the declared
 * turnover, so these dates are the same maths the workpaper prints rather than a tick-box.
 */
function jobWorkEvents(orgId: string, fy: number): ComplianceEvent[] {
  if (!orgId) return []
  const job = loadJob(orgId)
  if (job.lots.length === 0) return []
  const cadence = itc04Cadence(job.settings.turnover_cr)
  return itc04Periods(fy, job.settings.turnover_cr).map(p => ({
    id: `${fy}-itc04-${p.label}`,
    title: `Job-work statement — ${p.label}`,
    form: 'ITC-04',
    category: 'gst' as const,
    due: p.due,
    period: `for ${p.label}`,
    description: `${cadence.label} statement of goods sent to job workers and what came back. ${cadence.basis}`,
    href: '/gst/job-work',
    penalty: { interestPct: 18, note: 'No late fee on the statement itself — the exposure is the deemed supply under rule 45, on which 18% interest runs with the tax.' },
  }))
}

/**
 * The export register owns its dates: next year's undertaking, each consignment's realisation
 * window, each refund limitation, each advance still waiting to be shipped. The calendar calls
 * `watchRows()` instead of recomputing any of them, so the two screens cannot disagree — and a
 * file that is settled or shipped stops appearing here without anyone clearing a checkbox.
 *
 * The ₹-per-day estimator stays silent on these rows on purpose. A missing LUT is not a late
 * filing, it is a supply that becomes taxable; a missed realisation window is FEMA, not GST. Each
 * row therefore carries a note that says what waiting actually costs instead of a number.
 */
const EXPORT_KIND_NOTE: Record<WatchRow['kind'], string> = {
  lut: 'Nothing is charged for a late LUT — an export without one in force simply becomes taxable, so IGST has to be paid on the invoice and refunded afterwards.',
  realisation: 'A FEMA matter, not a GST default, so no late fee is computed here. Past the window the AD bank can hold further exports until the contravention is condoned.',
  refund: 'The department charges nothing for waiting — the two years in section 54(1) run out and the IGST paid on the invoice stays where it is.',
  advance: 'Goods taken against an advance have to leave India inside the window. A late dispatch goes to the AD bank for condonation with the shipping bill as proof.',
}

/**
 * The payroll register states its own deadlines, in the shape the calendar reads. A PayEvent carries
 * an amount and a source note where a calendar row wants a category and a penalty, so the rupee
 * figure moves into the hint and the register's own citation takes the note's place. No date is
 * invented here: a row the register leaves undated reaches the calendar undated.
 */
function payToEvent(p: PayEvent): ComplianceEvent {
  return {
    id: p.id,
    title: p.title,
    form: p.form,
    // Salary TDS is an income-tax deadline, but the register that proves it is the payroll one, so
    // it wears the payroll category rather than borrowing a GST late-fee rule.
    category: 'payroll',
    due: p.due,
    period: p.period,
    description: p.description,
    amountHint: p.amount > 0 ? `${formatINR(p.amount)} to deposit` : undefined,
    href: p.href,
    penalty: { note: p.note },
  }
}

/**
 * Deadlines this business's salary books can prove. A year with no payroll rows gets none of these —
 * the register decides they exist, which is why no profile tick-box is needed to switch them on.
 */
function payrollDueEvents(orgId: string, fy: number): ComplianceEvent[] {
  if (!orgId) return []
  return payrollEvents(loadPayroll(orgId), fy).map(payToEvent)
}

function watchToEvent(r: WatchRow): ComplianceEvent {
  return {
    id: r.id,
    title: r.label,
    form: r.form,
    // LUT and refund are GST filings; the money-in rows are FEMA and belong to the bank, not the
    // GST portal, so they sit under "Other" rather than borrowing a GST late-fee rule.
    category: r.kind === 'lut' || r.kind === 'refund' ? 'gst' : 'other',
    due: r.date,
    period: r.party || 'Export register',
    description: r.detail,
    href: r.href,
    penalty: { note: EXPORT_KIND_NOTE[r.kind] },
  }
}

/**
 * A business with no export paperwork has nothing to watch here, so the register has to say so
 * before any row is built — otherwise every calendar would suddenly grow an RFD-11 deadline.
 */
function exportEvents(orgId: string, books: ExportBookInvoice[], fy: number): ComplianceEvent[] {
  if (!orgId) return []
  const store = loadExp(orgId)
  if (store.files.length === 0 && store.luts.length === 0) return []
  const deals: FxDealLite[] = loadFx(orgId).entries.map(e => ({
    invoice_number: e.invoice_number,
    currency: e.currency,
    foreign_value: e.foreign_value,
    booked_inr: e.booked_inr,
    receipts: e.receipts.map(r => ({ date: r.date, foreign: r.foreign, inr: r.inr, reference: r.reference })),
  }))
  const from = `${fy}-04-01`
  const to = `${fy + 1}-03-31`
  return watchRows(store, books, deals, todayISO())
    .filter(r => r.date >= from && r.date <= to)
    .map(watchToEvent)
}

export default function ComplianceCalendarPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE)
  const [statuses, setStatuses] = useState<StatusMap>({})
  const [fy, setFy] = useState(currentFyStart())
  const [monthFilter, setMonthFilter] = useState<string>('all')
  /** Export invoices from the books — the rupee half of the watch list the register also reads. */
  const [expBooks, setExpBooks] = useState<ExportBookInvoice[]>([])

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
      setStatuses(loadStatuses(oid))
      try {
        const saved = localStorage.getItem(PROFILE_KEY + oid)
        if (saved) setProfile({ ...DEFAULT_PROFILE, ...JSON.parse(saved) })
      } catch { /* fall back to defaults */ }

      // The export watch list is invoices plus paperwork, so the calendar reads the same book rows
      // the register does — same columns, same 800-row cap — rather than a summary that could drift.
      const { data: bookRows } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, customer_gstin, supply_type, place_of_supply, taxable_amount, igst_amount, total_tax, grand_total, balance_due, status')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .order('invoice_date', { ascending: false })
        .limit(800)
      setExpBooks(((bookRows || []) as unknown as ExportBookInvoice[]).filter(isExportDoc))

      const now = new Date()
      setMonthFilter(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
      setLoading(false)
    }
    load()
  }, [])

  function updateProfile(next: Profile) {
    setProfile(next)
    if (orgId) {
      try { localStorage.setItem(PROFILE_KEY + orgId, JSON.stringify(next)) } catch { /* non-critical */ }
    }
  }

  /** What the salary books prove this year — a proved month retires that month's guess. */
  const payRows = useMemo(() => payrollDueEvents(orgId, fy), [orgId, fy])

  const events = useMemo(() => {
    /**
     * The profile tick-box guesses a monthly PF and professional-tax deadline for all twelve months.
     * Where the payroll register actually files that head for that month — an ECR row here, a state
     * PT row there — the register's own date and rupee figure retire the guess instead of appearing
     * beside it twice. A month the books have not been run for keeps its guess: a tick-box is better
     * than a silence about something the owner said they owe.
     *
     * A guessed row's id names the month the deposit falls in, one month after the salary it covers,
     * so the comparison steps back before asking the register.
     */
    const proved = new Set(payRows.map(r => r.id))
    const guessed = generateEvents(fy, profile).filter(e => {
      const head = e.id.match(/-(pf|pt)-(\d{4})-(\d{2})$/)
      if (!head) return true
      const salaryMonth = addMonths(`${head[2]}-${head[3]}`, -1)
      return !proved.has(`${fy}-pay-${head[1]}-${salaryMonth}`)
    })
    return [...guessed, ...jobWorkEvents(orgId, fy), ...exportEvents(orgId, expBooks, fy), ...payRows]
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'))
  }, [fy, profile, orgId, expBooks, payRows])

  const today = new Date()
  const withStatus = events.map(e => ({
    ...e,
    filed: !!statuses[e.id],
    // A row the register leaves undated — a state professional-tax deadline — counts as NaN days
    // away on purpose: it is neither overdue nor due soon, because nothing here knows when it is.
    daysLeft: Math.ceil((new Date(e.due).getTime() - today.getTime()) / DAY),
  }))

  const overdue = withStatus.filter(e => !e.filed && e.daysLeft < 0)
  const dueSoon = withStatus.filter(e => !e.filed && e.daysLeft >= 0 && e.daysLeft <= 7)
  const filedCount = withStatus.filter(e => e.filed).length
  const next = [...withStatus].filter(e => !e.filed && e.due).sort((a, b) => a.due.localeCompare(b.due))[0]

  const months = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>()
    for (const e of events) {
      /** State dues have no national date, so they get a rail of their own rather than an "Invalid Date". */
      if (!e.due) {
        map.set('undated', { label: 'State dates', count: (map.get('undated')?.count || 0) + 1 })
        continue
      }
      const key = e.due.slice(0, 7)
      const label = new Date(e.due).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      map.set(key, { label, count: (map.get(key)?.count || 0) + 1 })
    }
    const dated = [...map.entries()].filter(([k]) => k !== 'undated').sort((a, b) => a[0].localeCompare(b[0]))
    const undated = map.get('undated')
    return undated ? [...dated, ['undated', undated] as [string, { label: string; count: number }]] : dated
  }, [events])

  const shown = monthFilter === 'all'
    ? withStatus
    : monthFilter === 'undated'
      ? withStatus.filter(e => !e.due)
      : withStatus.filter(e => e.due.startsWith(monthFilter))

  function toggleFiled(event: ComplianceEvent) {
    if (!orgId) return
    const nextStatuses = { ...statuses }
    if (nextStatuses[event.id]) delete nextStatuses[event.id]
    else nextStatuses[event.id] = { doneOn: new Date().toISOString().slice(0, 10) }
    setStatuses(nextStatuses)
    saveStatuses(orgId, nextStatuses)
  }

  function exportIcs() {
    /** An .ics event needs a start date, so undated state dues stay off the file rather than landing
     * on a guessed day — the calendar shows them, Google's cannot. */
    download(`taxflow-compliance-FY${fy}-${String(fy + 1).slice(2)}.ics`,
      toIcs(events.filter(e => e.due), orgName || 'my business'))
  }

  if (loading) {
    return (
      <div className="page-container" style={{ maxWidth: 1180 }}>
        <div style={{ height: 84, borderRadius: 16, background: 'linear-gradient(115deg,#dbe6f7,#eef2f9)' }} />
      </div>
    )
  }

  return (
    <div className="page-container" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`Financial year ${fy}-${String(fy + 1).slice(2)}`}
        title="Compliance calendar"
        subtitle={`${events.length} deadlines · ${filedCount} filed · ${overdue.length} overdue`}
        actions={<Button onClick={exportIcs} icon="download">Add FY to calendar</Button>}
        right={<Segmented
          value={String(fy)}
          onChange={v => setFy(Number(v))}
          options={[currentFyStart() - 1, currentFyStart(), currentFyStart() + 1].map(y => ({
            value: String(y), label: `FY ${y}-${String(y + 1).slice(2)}`,
          }))}
        />}
      />

      {/* Profile */}
      <Card style={{ marginBottom: '1rem' }}>
        <div className="tf-row-between tf-wrap" style={{ gap: 14 }}>
          <div>
            <div className="tf-eyebrow" style={{ marginBottom: 7 }}>How this business files</div>
            <Segmented
              value={profile.filing}
              onChange={v => updateProfile({ ...profile, filing: v as Profile['filing'] })}
              options={[
                { value: 'monthly', label: 'Monthly GSTR-1' },
                { value: 'qrmp', label: 'QRMP (quarterly)' },
                { value: 'composition', label: 'Composition' },
              ]}
            />
          </div>
          <div className="tf-row tf-wrap" style={{ gap: 8 }}>
            {([
              ['deductsTds', 'Deducts TDS'],
              ['employees', 'Has employees (PF/ESI)'],
              ['taxAudit', 'Tax audit applicable'],
              ['professionalTax', 'Professional tax'],
            ] as [keyof Profile, string][]).map(([key, label]) => (
              <button key={key} onClick={() => updateProfile({ ...profile, [key]: !profile[key] })}
                className={`toggle-chip ${profile[key] ? 'is-on' : ''}`}>
                <Icon name={profile[key] ? 'check' : 'plus'} size={12} strokeWidth={2.6} />
                {label}
              </button>
            ))}
          </div>
        </div>
        {payRows.length > 0 && (
          <p style={{ fontSize: 11.5, color: 'var(--faint)', margin: '11px 0 0', maxWidth: 720, lineHeight: 1.5 }}>
            {payRows.length} {payRows.length === 1 ? 'deadline' : 'deadlines'} this year {payRows.length === 1 ? 'is' : 'are'}
            proved from the payroll register — its own PF, ESI, salary-tax and Form 16 rows, with the deposit date and the
            rupee figure the books carry. Those rows replace the monthly guesses the tick-boxes above would otherwise make,
            and a professional-tax row stays undated because only the state knows that date.
          </p>
        )}
      </Card>

      {/* Summary */}
      <div className="tf-g-3" style={{ marginBottom: '1rem' }}>
        <Card style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {next ? <CountdownRing days={next.daysLeft} /> : <Icon name="check" size={34} style={{ color: 'var(--green)' }} />}
          <div style={{ minWidth: 0 }}>
            <div className="tf-eyebrow">Next deadline</div>
            {next ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 700, marginTop: 3 }}>{next.form} · {next.title}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{next.period} · due {formatDateIN(next.due)}</div>
                {next.href && <Link href={next.href} className="tf-stat-sub" style={{ color: 'var(--brand)', textDecoration: 'none' }}>Prepare now →</Link>}
              </>
            ) : <div style={{ fontSize: 14, fontWeight: 600, marginTop: 4 }}>Everything is filed.</div>}
          </div>
        </Card>

        <Card>
          <div className="tf-eyebrow" style={{ marginBottom: 8 }}>This week</div>
          <StatRow label="Due within 7 days" value={dueSoon.length} tone={dueSoon.length ? 'amber' : 'grey'} />
          <StatRow label="Overdue" value={overdue.length} tone={overdue.length ? 'red' : 'green'} />
          <StatRow label="Filed" value={`${filedCount} / ${events.length}`} tone="green" strong />
        </Card>

        <Card>
          <div className="tf-eyebrow" style={{ marginBottom: 8 }}>Cost of slipping</div>
          <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', color: overdue.length ? 'var(--red)' : 'var(--ink)' }}>
            {formatCompactINR(overdue.reduce((s, e) => s + estimateLateCharge(e, Math.abs(e.daysLeft), 0).fee, 0))}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
            Accumulated late fees on {overdue.length} overdue filing{overdue.length === 1 ? '' : 's'} — interest is extra.
          </div>
        </Card>
      </div>

      {/* Month rail */}
      <div className="tab-bar" style={{ marginBottom: '1rem' }}>
        <button className={`month-pill ${monthFilter === 'all' ? 'is-on' : ''}`} onClick={() => setMonthFilter('all')}>
          Full year <span>{events.length}</span>
        </button>
        {months.map(([key, m]) => (
          <button key={key} className={`month-pill ${monthFilter === key ? 'is-on' : ''}`} onClick={() => setMonthFilter(key)}>
            {m.label} <span>{m.count}</span>
          </button>
        ))}
      </div>

      {/* Events */}
      <div className="tf-col" style={{ gap: 10 }}>
        {shown.length === 0 && <Card><EmptyState icon="calendar" title="Nothing due" message="No filings fall in this month." /></Card>}
        {shown.map(e => {
          const meta = CATEGORY_META[e.category]
          const lateDays = e.daysLeft < 0 ? Math.abs(e.daysLeft) : 0
          const charge = lateDays ? estimateLateCharge(e, lateDays, 0) : null
          return (
            <Card key={e.id} style={{ padding: '1rem 1.15rem' }} className="tf-rise">
              <div className="tf-row-between tf-wrap" style={{ gap: 14 }}>
                <div className="tf-row" style={{ gap: 12, minWidth: 0 }}>
                  <button className={`done-box ${e.filed ? 'is-done' : ''}`} onClick={() => toggleFiled(e)}
                    title={e.filed ? 'Mark as not filed' : 'Mark as filed'}>
                    {e.filed && <Icon name="check" size={13} strokeWidth={3} />}
                  </button>
                  <div style={{ minWidth: 0 }}>
                    <div className="tf-row tf-wrap" style={{ gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 650, color: e.filed ? 'var(--faint)' : 'var(--ink)', textDecoration: e.filed ? 'line-through' : 'none' }}>
                        {e.form}
                      </span>
                      <Badge tone={meta.tone} dot={false}>{meta.label}</Badge>
                      {!e.filed && (e.daysLeft < 0
                        ? <Badge tone="red">{Math.abs(e.daysLeft)} days overdue</Badge>
                        : e.daysLeft <= 7 ? <Badge tone="amber">due in {e.daysLeft}d</Badge> : null)}
                      {e.filed && <Badge tone="green">filed {formatDateIN(statuses[e.id]?.doneOn || e.due)}</Badge>}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 3 }}>{e.title}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                      {e.period} · {e.due ? `due ${formatDateIN(e.due)}` : 'due on the state’s own date'} — {e.description}
                    </div>
                    {e.amountHint && (
                      <div className="tf-num" style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 650, marginTop: 3 }}>
                        {e.amountHint}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ minWidth: 190 }}>
                  {charge && charge.total > 0 && (
                    <div style={{
                      fontSize: 12, color: 'var(--red)', background: 'var(--red-soft)',
                      border: '1px solid #fecaca', borderRadius: 10, padding: '7px 10px', marginBottom: 8,
                    }}>
                      ≈ ₹{formatINR(charge.fee)} late fee{charge.interest ? ` + ₹${formatINR(charge.interest)} interest` : ''} so far
                    </div>
                  )}
                  <div style={{ fontSize: 11.5, color: 'var(--faint)', lineHeight: 1.5 }}>{e.penalty.note}</div>
                  <div className="tf-row" style={{ gap: 8, marginTop: 8 }}>
                    {e.due && (
                      <a href={googleCalendarUrl(e, orgName || 'business')} target="_blank" rel="noreferrer" className="tf-btn tf-btn-ghost tf-btn-sm">
                        <Icon name="calendar" size={13} /> Google
                      </a>
                    )}
                    {e.href && <Link href={e.href} className="tf-btn tf-btn-ghost tf-btn-sm"><Icon name="arrow-right" size={13} /> Prepare</Link>}
                  </div>
                </div>
              </div>
            </Card>
          )
        })}
      </div>

      <p style={{ fontSize: 11.5, color: 'var(--faint)', marginTop: '1.25rem', maxWidth: 760 }}>
        Dates follow the standard monthly and quarterly due dates under the CGST Act and the Income Tax Act.
        CBIC and CBDT notifications sometimes move them, and late-fee caps depend on your turnover and GSTIN count —
        confirm anything you are about to pay against the official notice.
      </p>

      <style>{`
        .toggle-chip {
          display: inline-flex; align-items: center; gap: 6px;
          font-family: inherit; font-size: 12px; font-weight: 600;
          padding: 7px 12px; border-radius: 99px; cursor: pointer;
          border: 1px solid var(--line); background: var(--surface); color: var(--muted);
          transition: all .15s ease;
        }
        .toggle-chip.is-on { background: var(--brand-soft); border-color: #bfdbfe; color: var(--brand-dark); }
        .month-pill {
          display: inline-flex; align-items: center; gap: 7px;
          font-family: inherit; font-size: 12px; font-weight: 600;
          padding: 8px 13px; border-radius: 99px; cursor: pointer; white-space: nowrap;
          border: 1px solid var(--line); background: var(--surface); color: var(--ink-2);
        }
        .month-pill span { font-size: 10.5px; color: var(--faint); background: var(--slate-soft); padding: 1px 6px; border-radius: 99px; }
        .month-pill.is-on { background: var(--ink); border-color: var(--ink); color: white; }
        .month-pill.is-on span { background: rgba(255,255,255,.18); color: rgba(255,255,255,.85); }
        .done-box {
          width: 22px; height: 22px; border-radius: 7px; cursor: pointer;
          border: 1.5px solid var(--line); background: var(--surface);
          display: flex; align-items: center; justify-content: center; color: white;
          flex-shrink: 0; padding: 0; min-height: 0;
        }
        .done-box.is-done { background: var(--green); border-color: var(--green); }
        @media (prefers-reduced-motion: reduce) { .tf-rise { animation: none !important; } }
      `}</style>
    </div>
  )
}

function CountdownRing({ days }: { days: number }) {
  const horizon = 30
  const pct = Math.max(0, Math.min(1, days / horizon))
  const r = 26, c = 2 * Math.PI * r
  const color = days < 0 ? 'var(--red)' : days <= 7 ? 'var(--amber)' : 'var(--brand)'
  return (
    <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
      <svg width="64" height="64" viewBox="0 0 64 64">
        <circle cx="32" cy="32" r={r} fill="none" stroke="var(--line-soft)" strokeWidth="6" />
        <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 32 32)"
          style={{ transition: 'stroke-dashoffset .6s cubic-bezier(.22,1,.36,1)' }} />
      </svg>
      <div style={{
        position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', lineHeight: 1,
      }}>
        <span className="tf-num" style={{ fontSize: 16, fontWeight: 750, color }}>{days < 0 ? `−${-days}` : days}</span>
        <span style={{ fontSize: 8, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '.04em' }}>days</span>
      </div>
    </div>
  )
}
