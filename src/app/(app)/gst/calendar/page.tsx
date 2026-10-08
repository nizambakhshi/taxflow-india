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

  const events = useMemo(
    () => [...generateEvents(fy, profile), ...jobWorkEvents(orgId, fy)].sort((a, b) => a.due.localeCompare(b.due)),
    [fy, profile, orgId],
  )

  const today = new Date()
  const withStatus = events.map(e => ({
    ...e,
    filed: !!statuses[e.id],
    daysLeft: Math.ceil((new Date(e.due).getTime() - today.getTime()) / DAY),
  }))

  const overdue = withStatus.filter(e => !e.filed && e.daysLeft < 0)
  const dueSoon = withStatus.filter(e => !e.filed && e.daysLeft >= 0 && e.daysLeft <= 7)
  const filedCount = withStatus.filter(e => e.filed).length
  const next = [...withStatus].filter(e => !e.filed).sort((a, b) => a.due.localeCompare(b.due))[0]

  const months = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>()
    for (const e of events) {
      const key = e.due.slice(0, 7)
      const label = new Date(e.due).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' })
      map.set(key, { label, count: (map.get(key)?.count || 0) + 1 })
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [events])

  const shown = monthFilter === 'all' ? withStatus : withStatus.filter(e => e.due.startsWith(monthFilter))

  function toggleFiled(event: ComplianceEvent) {
    if (!orgId) return
    const nextStatuses = { ...statuses }
    if (nextStatuses[event.id]) delete nextStatuses[event.id]
    else nextStatuses[event.id] = { doneOn: new Date().toISOString().slice(0, 10) }
    setStatuses(nextStatuses)
    saveStatuses(orgId, nextStatuses)
  }

  function exportIcs() {
    download(`taxflow-compliance-FY${fy}-${String(fy + 1).slice(2)}.ics`, toIcs(events, orgName || 'my business'))
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
                      {e.period} · due {formatDateIN(e.due)} — {e.description}
                    </div>
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
                    <a href={googleCalendarUrl(e, orgName || 'business')} target="_blank" rel="noreferrer" className="tf-btn tf-btn-ghost tf-btn-sm">
                      <Icon name="calendar" size={13} /> Google
                    </a>
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
