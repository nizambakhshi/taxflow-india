'use client'

// Payroll — what a month of salary costs, what the department takes out of it, and by when.
//
// The engine (src/lib/payroll.ts) owns the model. This page stores exactly two things: what each
// person is structured at, and the four numbers a month adds or removes — lost days, arrears, a
// bonus, a recovery. Every rupee you see beside those is computed on load, so nothing here can go
// stale between a rule changing and the register being re-run.
//
// Four boundaries are printed on the screen rather than left to the reader:
//
//  * Absence prints a dash, zero prints a claim. A person whose professional tax was never
//    recorded deducts nothing and claims nothing — the row is blank with a flag beside it. A
//    person whose state charges nothing shows `0`, which is a fact the owner typed.
//  * Tax is walked, not looked up. Section 192 read with rules 31-33 has the employer estimate the
//    year, price it, and take the balance in instalments over the months left on the rolls. This
//    page re-walks April forward on every load, which is why twelve instalments add up to the
//    year's tax to the paisa instead of drifting from it.
//  * Nothing here pays anyone. The provident-fund challan is made on the EPFO portal, the ESI
//    return on ESIC's, the salary tax against a 281 challan on the income-tax portal. The register
//    computes what each is made of and when it falls due; the money leaves through those portals.
//  * A senior citizen is not priced. The higher exemption bands are not in the tables this file was
//    built from, so the tax row prints a dash and the reason rather than the general schedule
//    applied to somebody it does not apply to.

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { useSearchDeepLink } from '@/lib/deep-link-search'
import { download } from '@/lib/party-ledger'
import { toCsv } from '@/lib/registers'
import { formatINR } from '@/lib/gst-engine'
import { formatDateIN } from '@/lib/format'
import { INDIAN_STATES } from '@/lib/constants'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, Segmented, StatCard, StatRow } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  AGE_BANDS, AGE_META, ANNUAL_CSV_HEADERS, ATTENDANCE_MARKS, COMPONENT_LABELS, DEFAULT_SETTINGS, DUE_DAYS, ESI_BANDS,
  PF_MODES, PF_MODE_META, PF_WAGE_CEILINGS, PAYROLL_CSV_HEADERS, PAYROLL_RULES, PT_ANNUAL_CAP,
  STATUTORY_CSV_HEADERS, WAGE_CODE_50, annualCsvRows, annualSheets, applyAttendance, attendanceBasis,
  attendanceTemplate, blendedHourCost, costPerHourFor, currentMonth, daysInMonthKey, deleteEmployee, deleteInput,
  emptyPayroll, fyMonths, fyStartOfMonth, loadPayroll, missingHeads, monthLabel, monthRegister, monthsWithData, newEmployee,
  newInput, offRosterWhy, openMonth, payrollCsvRows, payslipOf, pfCeilingOn, planAttendance, rosterFor,
  saveSettings, setActiveEmployee, statutoryCsvRows, statutoryDues, summariseRegister, upsertEmployee,
  upsertInput, validateEmployee, validateInput,
  type AttendanceApplyResult, type AttendancePlan,
  type Employee, type Flag, type PayInput, type PayrollSettings, type PayrollStore,
  type Payslip, type RegisterSummary, type Roster,
} from '@/lib/payroll'

type Tab = 'people' | 'month' | 'dues' | 'annual' | 'cost'

const TABS: { value: string; label: string }[] = [
  { value: 'people', label: 'People' },
  { value: 'month', label: 'Month run' },
  { value: 'dues', label: 'Statutory dues' },
  { value: 'annual', label: 'Annual sheet' },
  { value: 'cost', label: 'Cost of an hour' },
]

const DASH = '—'

/** A rupee, or a dash when there is no rupee to claim. Never a silent ₹0. */
function money(v: number | null | undefined): string {
  if (v === null || v === undefined) return DASH
  return `₹${formatINR(v)}`
}

/** The same, for a figure that is only meaningful when the slip itself is computable. */
function moneyOn(slip: Payslip | null, v: number): string {
  return slip && !slip.computable ? DASH : money(v)
}

/** Days, hours, months — a count is not money and does not want a ₹ in front of it. */
function count(v: number, unit: string): string {
  return `${v.toLocaleString('en-IN')} ${unit}${Math.abs(v) === 1 ? '' : 's'}`
}

function structureTotal(e: Employee): number {
  return COMPONENT_LABELS.reduce((t, c) => t + (Number(e.components[c.key]) || 0), 0)
}

const TONE_CLASS: Record<Flag['tone'], string> = { red: 'is-red', amber: 'is-amber', grey: 'is-grey' }

function stateLabel(code: string): string {
  if (!code) return 'state not set'
  return INDIAN_STATES.find(s => s.value === code)?.label || `state ${code}`
}

function fyLabel(start: number): string {
  return `FY ${start}-${String(start + 1).slice(2)}`
}

// ── the page ──────────────────────────────────────────────────────────────────

function PayrollPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [store, setStore] = useState<PayrollStore>(() => emptyPayroll(''))

  const [tab, setTab] = useState<Tab>('people')
  const [month, setMonth] = useState(currentMonth())
  const [search, setSearch] = useSearchDeepLink()
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [editor, setEditor] = useState<Employee | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [openSlip, setOpenSlip] = useState('')
  const [rowForm, setRowForm] = useState<{ input: PayInput; employee: Employee | null } | null>(null)

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

      const oid = membership.organization_id
      const next = loadPayroll(oid)
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')
      setStore(next)

      const inboundTab = searchParams.get('tab')
      if (inboundTab && TABS.some(t => t.value === inboundTab)) setTab(inboundTab as Tab)
      const inboundMonth = searchParams.get('month')
      if (inboundMonth && /^\d{4}-\d{2}$/.test(inboundMonth)) setMonth(inboundMonth)
      const latest = monthsWithData(next)[0]
      if (!inboundMonth && latest && !next.employees.some(e => offRosterWhy(e, currentMonth()) === '')) setMonth(latest)
      if (searchParams.get('new') === '1') setEditor(newEmployee())
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function flash(msg: string) { setNotice({ msg, bad: false }) }
  function warn(msg: string) { setNotice({ msg, bad: true }) }

  function changeTab(next: string) {
    setTab(next as Tab)
    setOpenSlip('')
    router.replace(`/payroll?tab=${next}&month=${month}`, { scroll: false })
  }
  function changeMonth(next: string) {
    setMonth(next)
    setOpenSlip('')
    router.replace(`/payroll?tab=${tab}&month=${next}`, { scroll: false })
  }

  // ── writes, all of them through the register's own doors ────────────────────

  function commitEmployee(next: Employee) {
    const blocked = validateEmployee(next).filter(i => i.level === 'block')
    if (blocked.length) { warn(blocked[0].message); return }
    const isNew = !store.employees.some(e => e.id === next.id)
    setStore(upsertEmployee(orgId, next))
    setEditor(null)
    flash(isNew
      ? `${next.name} is on the payroll. Their salary is now ${money(structureTotal(next))} a month — nothing else about them is stored.`
      : `${next.name} updated. Every month that was already run re-reads the new structure.`)
  }

  function toggleActive(e: Employee) {
    setStore(setActiveEmployee(orgId, e.id, !e.active))
    flash(`${e.name} is ${e.active ? 'off the rolls — no month will be run for them' : 'back on the rolls'}.`)
  }

  function removeEmployee(id: string) {
    const target = store.employees.find(e => e.id === id)
    if (!target) return
    if (!window.confirm(`Remove ${target.name} and every month row typed for them? The register keeps no history of a removed card.`)) return
    const result = deleteEmployee(orgId, id)
    if (!result.ok) { warn(result.error); return }
    setStore(result.store)
    flash(`${target.name} is off the register.`)
  }

  function openTheMonth() {
    const result = openMonth(orgId, month)
    setStore(result.store)
    flash(result.created === 0
      ? `${monthLabel(month)} was already open — every person on the rolls already has a row for it.`
      : `${monthLabel(month)} is open. ${result.created} row${result.created === 1 ? '' : 's'} waiting for lost days, arrears and bonuses.`)
  }

  function commitRow(next: PayInput) {
    const employee = store.employees.find(e => e.id === next.employee_id) || null
    const blocked = validateInput(next, employee, next.month).filter(i => i.level === 'block')
    if (blocked.length) { warn(blocked[0].message); return }
    setStore(upsertInput(orgId, next))
    setRowForm(null)
    const warnings = validateInput(next, employee, next.month).filter(i => i.level === 'warn')
    flash(warnings.length
      ? `Saved, with a finding: ${warnings[0].message}`
      : `${employee ? employee.name : 'The row'} · ${monthLabel(next.month)} recorded.`)
  }

  function dropRow(inputId: string) {
    setStore(deleteInput(orgId, inputId))
    flash('The month row is gone. That person is now paid at their structure with no exceptions.')
  }

  function commitSettings(next: PayrollSettings) {
    setStore(saveSettings(orgId, next))
    flash('Settings saved. Every slip on this page re-reads them — nothing is cached.')
  }

  /**
   * The sheet's only door. It writes through `applyAttendance`, which re-runs the register's own
   * validation inside the write, so a preview that went stale between reading and clicking loses the
   * row with its reason printed rather than corrupting the month.
   */
  function applySheet(p: AttendancePlan): AttendanceApplyResult {
    const result = applyAttendance(orgId, month, p)
    setStore(result.store)
    if (result.written === 0) {
      warn(result.skipped[0]?.reason || 'Nothing on that sheet could be written to the register.')
    } else {
      flash(`${result.written} month row${result.written === 1 ? ' carries' : 's now carry'} ${monthLabel(month)}’s attendance — lost days and the sentence saying where they came from, nothing else.`
        + (result.unchanged ? ` ${result.unchanged} already agreed with the sheet.` : '')
        + (result.skipped.length ? ` ${result.skipped.length} person${result.skipped.length === 1 ? '' : 's'} were left out: ${result.skipped[0].reason}` : ''))
    }
    return result
  }

  // ── the month the page is looking at ───────────────────────────────────────

  const fy = fyStartOfMonth(month)
  const slips = useMemo(() => monthRegister(store, month), [store, month])
  const summary = useMemo(() => summariseRegister(slips), [slips])
  const roster = useMemo(() => rosterFor(store, month), [store, month])
  const months = useMemo(() => fyMonths(fy), [fy])
  const hasData = store.employees.length > 0

  const monthlyStructure = useMemo(() => store.employees
    .filter(e => e.active)
    .reduce((t, e) => t + structureTotal(e), 0), [store.employees])

  return (
    <div className="page-container" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`Salary register${orgName ? ` · ${orgName}` : ''}`}
        title="Payroll"
        subtitle={hasData
          ? `${roster.on.length} on the rolls in ${monthLabel(month)} · gross ${money(summary.gross)} · paid out ${money(summary.net)} · the business spends ${money(summary.employer_cost)}`
          : 'A salary register kept in this browser. Names, structures and the exceptions a month takes — every rupee around them computed, none stored.'}
        actions={hasData ? (
          <>
            <Button variant="primary" icon="plus" onClick={() => setEditor(newEmployee())}>Add a person</Button>
            <Button icon="calendar" onClick={openTheMonth}>Open {monthLabel(month)}</Button>
          </>
        ) : (
          <Button variant="primary" icon="plus" onClick={() => setEditor(newEmployee())}>Add the first person</Button>
        )}
        right={
          <div className="tf-row" style={{ gap: 8 }}>
            <label className="pr-pick">
              <span>Month</span>
              <select value={month} onChange={e => changeMonth(e.target.value)} aria-label="Month">
                {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
            <div className="tf-row" style={{ gap: 4 }}>
              <button type="button" className="pr-step" onClick={() => changeMonth(months[0])} title={`A year earlier — ${fyLabel(fy - 1)}`}>
                <Icon name="chevron-down" size={15} style={{ transform: 'rotate(90deg)' }} />
              </button>
              <button type="button" className="pr-step" onClick={() => changeMonth(months[11])} title={`A year later — ${fyLabel(fy + 1)}`}>
                <Icon name="chevron-down" size={15} style={{ transform: 'rotate(-90deg)' }} />
              </button>
            </div>
          </div>
        }
      />

      {notice && (
        <div className={`pr-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={15} />
          <span>{notice.msg}</span>
          <button type="button" className="pr-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="x" size={15} /></button>
        </div>
      )}

      <div style={{ marginBottom: '1rem' }}>
        <Segmented options={TABS} value={tab} onChange={changeTab} />
      </div>

      {!hasData && tab !== 'people' && (
        <Card style={{ marginBottom: '1rem' }}>
          <EmptyState
            icon="users"
            title="No salary cards yet"
            message="Every tab on this page is computed from the people on the register. Nothing is stored beside them, so with nobody on it there is nothing to run."
            action={<Button variant="primary" icon="plus" onClick={() => { setEditor(newEmployee()); setTab('people') }}>Add the first person</Button>}
          />
        </Card>
      )}

      {tab === 'people' && (
        <Card pad={false} style={{ marginBottom: '1rem' }}>
          <div className="pr-pad">
            <div className="tf-row-between tf-wrap" style={{ gap: 12, marginBottom: 12 }}>
              <SearchInput value={search} onChange={setSearch} placeholder="Name, code, role or state" ariaLabel="Search the salary register" style={{ minWidth: 240 }} />
              <div className="tf-row tf-wrap" style={{ gap: 8 }}>
                <Badge tone="grey">{count(roster.on.length, 'head') } on the rolls in {monthLabel(month)}</Badge>
                {roster.off.length > 0 && <Badge tone="amber">{roster.off.length} not in this month</Badge>}
                <Button size="sm" icon="settings" onClick={() => setShowSettings(s => !s)}>How the shop computes</Button>
              </div>
            </div>

            {showSettings && <SettingsPanel settings={store.settings} onSave={commitSettings} />}

            {store.employees.length === 0 ? (
              <EmptyState
                icon="users"
                title="Nobody on the payroll yet"
                message="A salary card is a structure and a window: what the person is paid in the six monthly components, when they joined, and whether they are still on the rolls."
                action={<Button variant="primary" icon="plus" onClick={() => setEditor(newEmployee())}>Add the first person</Button>}
              />
            ) : (
              <>
                <div className="pr-scroll">
                  <div className="pr-cols">
                    <div className="pr-head">Person</div>
                    <div className="pr-head pr-num">Basic + DA</div>
                    <div className="pr-head pr-num">Allowances</div>
                    <div className="pr-head pr-num">Monthly</div>
                    <div className="pr-head">PF</div>
                    <div className="pr-head pr-num">Prof. tax</div>
                    <div className="pr-head pr-num">Hours a day</div>
                    <div className="pr-head">On the rolls</div>
                    <div className="pr-head"></div>
                  </div>
                  {filteredEmployees(store.employees, search).map(e => (
                    <EmployeeRow key={e.id} employee={e} month={month} settings={store.settings}
                      onEdit={() => setEditor(e)} onToggle={() => toggleActive(e)} onRemove={() => removeEmployee(e.id)} />
                  ))}
                  {filteredEmployees(store.employees, search).length === 0 && (
                    <p className="pr-hint" style={{ padding: '14px 12px' }}>Nothing on the register matches “{search}”.</p>
                  )}
                </div>
                <p className="pr-hint" style={{ padding: '10px 12px 0' }}>
                  The six components are the whole of what is stored about a person besides their window and their flags.
                  Provident fund sits on basic + dearness allowance at the ceiling in force for the month —
                  {`₹${PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1].ceiling.toLocaleString('en-IN')}`} from {PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1].from} onward, per {PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1].cite.split(' (')[0]}.
                </p>
              </>
            )}
          </div>
        </Card>
      )}

      {tab === 'month' && (
        <MonthTab store={store} month={month} slips={slips} summary={summary} roster={roster}
          onOpenSlip={setOpenSlip} openSlip={openSlip} onApplySheet={applySheet}
          onEditRow={(employee) => setRowForm({ input: store.inputs.find(i => i.employee_id === employee.id && i.month === month) || newInput(employee.id, month), employee })}
          onDropRow={dropRow} />
      )}

      {tab === 'dues' && <DuesTab store={store} fy={fy} month={month} />}
      {tab === 'annual' && <AnnualTab store={store} fy={fy} />}
      {tab === 'cost' && <CostTab store={store} month={month} />}

      {hasData && <RulesPanel monthlyStructure={monthlyStructure} heads={store.employees.filter(e => e.active).length} />}

      <p className="pr-disclaimer">
        Rates, ceilings and dates carry the instrument that states them, shown in the panel above with the date each was
        fetched. Professional tax is a state subject and the wage definition under the labour codes is still being settled
        by EPFO offices, so both are printed as questions rather than answers. Confirm against the official notice before
        paying anything, and have your auditor read the year before you file it.
      </p>

      {editor && (
        <EmployeeEditor draft={editor} month={month} existing={store.employees}
          onSave={commitEmployee} onClose={() => setEditor(null)} />
      )}
      {rowForm && (
        <RowEditor draft={rowForm.input} employee={rowForm.employee}
          onSave={commitRow} onClose={() => setRowForm(null)}
          onDelete={store.inputs.some(i => i.id === rowForm.input.id) ? () => { dropRow(rowForm.input.id); setRowForm(null) } : undefined} />
      )}

      {/* Plain <style>, not styled-jsx: these pr- classes are rendered by the tab components
          below this one, and a jsx-scoped sheet would not reach them. */}
      <style>{`
        .pr-pad { padding: 14px; }
        .pr-notice { display: flex; align-items: flex-start; gap: 9px; background: var(--green-soft); color: var(--green);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 12px; padding: 10px 12px;
          margin-bottom: 1rem; font-size: 12.5px; line-height: 1.5; }
        .pr-notice.is-bad { background: var(--red-soft); color: var(--red); border-color: color-mix(in srgb, var(--red) 22%, white); }
        .pr-notice svg { flex-shrink: 0; margin-top: 2px; }
        .pr-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; min-height: 0; opacity: .7; }
        .pr-notice-x:hover { opacity: 1; }

        .pr-pick { display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--faint);
          text-transform: uppercase; letter-spacing: .05em; font-weight: 700; }
        .pr-pick select { font-family: inherit; font-size: 12.5px; text-transform: none; letter-spacing: 0; }
        .pr-step { width: 30px; height: 30px; display: grid; place-items: center; border: 1px solid var(--line);
          background: var(--surface); color: var(--muted); border-radius: 9px; cursor: pointer; }
        .pr-step:hover { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 40%, white); }

        .pr-scroll { overflow-x: auto; }
        .pr-cols, .pr-tr { display: grid; gap: 10px; align-items: center; min-width: 940px;
          grid-template-columns: minmax(160px, 1.5fr) 96px 96px 104px minmax(120px, 1fr) 84px 74px minmax(150px, 1fr) 96px; }
        .pr-cols.mn, .pr-tr.mn { min-width: 1040px;
          grid-template-columns: minmax(150px, 1.5fr) 92px 78px 100px 84px 76px 84px 96px 110px 110px 44px; }
        .pr-cols.an, .pr-tr.an { min-width: 1080px;
          grid-template-columns: minmax(150px, 1.4fr) 66px 104px 92px 84px 104px 96px 100px 124px 110px 44px; }
        .pr-cols.cs, .pr-tr.cs { min-width: 720px;
          grid-template-columns: minmax(150px, 1.4fr) 96px 96px 120px 120px; }
        .pr-head { padding: 9px 4px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em;
          text-transform: uppercase; color: var(--faint); border-bottom: 1px solid var(--line); }
        .pr-tr { padding: 11px 4px; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; color: var(--ink-2); }
        .pr-tr.mn, .pr-tr.an { cursor: pointer; }
        .pr-tr:hover { background: color-mix(in srgb, var(--brand) 4%, transparent); }
        .pr-tr.is-off { opacity: .6; }
        .pr-tr:last-child { border-bottom: none; }
        .pr-num { text-align: right; font-variant-numeric: tabular-nums; }
        .pr-name { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .pr-name b { font-size: 13px; color: var(--ink); font-weight: 700; }
        .pr-name span { font-size: 11px; color: var(--faint); }
        .pr-dash { color: var(--faint); }
        .pr-faint { color: var(--faint); font-style: normal; font-size: 11px; }
        .pr-strong { color: var(--ink); font-weight: 650; }

        .pr-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .pr-finding { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; border-radius: 9px; padding: 7px 9px; align-items: flex-start; }
        .pr-finding svg { flex-shrink: 0; margin-top: 2px; }
        .pr-finding.is-red { background: var(--red-soft); color: var(--red); }
        .pr-finding.is-amber { background: var(--amber-soft); color: var(--amber); }
        .pr-finding.is-grey { background: var(--slate-soft); color: var(--muted); }

        .pr-hint { font-size: 11.5px; color: var(--faint); line-height: 1.55; margin: 0; }
        .pr-note { font-size: 12px; color: var(--muted); line-height: 1.55; margin: 0; }
        .pr-disclaimer { font-size: 11.5px; color: var(--faint); margin-top: 1.25rem; max-width: 780px; line-height: 1.6; }

        .pr-rules-toggle { display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; min-height: 0;
          background: none; border: none; padding: 2px 0; cursor: pointer; font-family: inherit;
          font-size: 12.5px; font-weight: 700; color: var(--ink); }
        .pr-rules-toggle:hover { color: var(--brand); }
        .pr-rules-toggle svg { flex-shrink: 0; color: var(--brand); }

        .pr-rules { display: grid; gap: 8px; margin-top: 1rem; }
        .pr-rule { display: flex; gap: 9px; font-size: 11.5px; line-height: 1.55; color: var(--ink-2);
          background: var(--surface); border: 1px solid var(--line); border-radius: 11px; padding: 9px 11px; }
        .pr-rule svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .pr-rule b { color: var(--ink); font-weight: 700; }

        .pr-walk { background: var(--slate-soft); border-radius: 11px; padding: 12px 14px; margin: 2px 0 8px; }
        .pr-walk-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; margin-bottom: 12px; }
        .pr-walk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; }
        .pr-leg { font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
        .pr-strong-leg { color: var(--ink); font-weight: 650; }
        .pr-tds-leg { color: var(--ink); font-weight: 700; border-top: 1px solid var(--line); margin-top: 4px; padding-top: 6px; }

        .pr-misses { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 8px; }

        .pr-dues { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; }
        .pr-due { display: flex; flex-direction: column; gap: 5px; background: var(--surface); border: 1px solid var(--line);
          border-radius: 12px; padding: 11px 13px; }
        .pr-due-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
        .pr-due-title { font-size: 13px; font-weight: 700; color: var(--ink); display: flex; flex-direction: column; gap: 1px; }
        .pr-due-title em { font-size: 10.5px; font-style: normal; font-weight: 600; color: var(--faint); letter-spacing: .03em; text-transform: uppercase; }
        .pr-due-amt { font-size: 15px; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }
        .pr-due-due { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--amber); font-weight: 600; }
        .pr-due-link { margin-left: auto; color: var(--brand); font-size: 11px; text-decoration: none; }
        .pr-cite { font-size: 10.5px; color: var(--faint); line-height: 1.45; margin: 0; }

        .pr-year-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; }
        .pr-year-cell { display: flex; flex-direction: column; gap: 2px; background: var(--slate-soft); border-radius: 10px; padding: 9px 11px; }
        .pr-year-cell b { font-size: 12.5px; color: var(--ink); }
        .pr-year-cell span { font-size: 11px; color: var(--muted); line-height: 1.4; }
        .pr-year-cell em { font-size: 12.5px; font-style: normal; font-weight: 700; color: var(--brand); font-variant-numeric: tabular-nums; }

        .pr-modal { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: grid; place-items: center;
          padding: 18px; z-index: 60; overflow-y: auto; }
        .pr-modal-card { background: var(--surface); border-radius: 16px; border: 1px solid var(--line);
          box-shadow: var(--shadow-lg); width: min(760px, 100%); max-height: min(88vh, 900px); overflow-y: auto; }
        .pr-modal-head { display: flex; align-items: flex-start; gap: 10px; padding: 15px 16px 0; }
        .pr-modal-head h2 { margin: 0; font-size: 15px; color: var(--ink); }
        .pr-modal-head p { margin: 3px 0 0; font-size: 11.5px; color: var(--faint); line-height: 1.5; }
        .pr-modal-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 12px 16px 16px;
          border-top: 1px solid var(--line-soft); margin-top: 14px; }
        .pr-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 11px; padding: 14px 16px 0; }
        .pr-field { display: flex; flex-direction: column; gap: 4px; }
        .pr-field label { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .pr-field input, .pr-field select, .pr-field textarea { font-family: inherit; font-size: 12.5px; }
        .pr-field span { font-size: 10.5px; color: var(--faint); line-height: 1.45; }
        .pr-section { padding: 14px 16px 0; }
        .pr-section-title { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); margin: 0 0 8px; }

        .pr-strip { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 1rem; }
        .pr-miss { display: flex; gap: 9px; align-items: flex-start; font-size: 12px; color: var(--muted);
          background: var(--slate-soft); border-radius: 11px; padding: 9px 11px; line-height: 1.5; }
        .pr-miss svg { flex-shrink: 0; margin-top: 1px; }

        /* ── the attendance sheet: paste, preview, apply ─────────────────────── */
        .pa-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; }
        .pa-help { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0 0 8px; }
        .pa-help b { color: var(--ink); font-weight: 650; }
        .pa-text { width: 100%; min-height: 176px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11.5px; line-height: 1.5; color: var(--ink-2); background: var(--surface-2);
          border: 1px solid var(--line); border-radius: 11px; padding: 10px 11px; resize: vertical; }
        .pa-text:focus { outline: none; border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); background: var(--surface); }
        .pa-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .pa-hint { font-size: 11px; color: var(--faint); line-height: 1.55; margin: 8px 0 0; }
        .pa-note { font-size: 12px; color: var(--muted); line-height: 1.55; margin: 10px 0 0; }
        .pa-what { background: var(--slate-soft); border-radius: 12px; padding: 12px 13px; }
        .pa-title { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); margin: 0 0 7px; }
        .pa-title + .pa-help, .pa-title + .pa-points { margin-bottom: 12px; }
        .pa-points { list-style: disc; margin: 0 0 10px; padding-left: 17px; display: flex; flex-direction: column; gap: 6px;
          font-size: 11.5px; line-height: 1.55; color: var(--ink-2); }
        .pa-points b { color: var(--ink); font-weight: 650; }
        .pa-marks { display: flex; flex-wrap: wrap; gap: 5px; margin: 0 0 12px; }
        .pa-mark { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
          border-radius: 7px; padding: 3px 7px; border: 1px solid var(--line); background: var(--surface); color: var(--muted); }
        .pa-mark-present { color: var(--green); background: var(--green-soft); border-color: color-mix(in srgb, var(--green) 24%, white); }
        .pa-mark-loss { color: var(--red); background: var(--red-soft); border-color: color-mix(in srgb, var(--red) 24%, white); }
        .pa-mark-neutral { color: var(--muted); }

        .pa-plan { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 13px; }
        .pa-plan-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; justify-content: space-between; }
        .pa-sub { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); margin: 14px 0 7px; }
        .pa-rows { display: flex; flex-direction: column; gap: 6px; margin-top: 11px; }
        .pa-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; background: var(--surface-2);
          border: 1px solid var(--line); border-radius: 11px; padding: 8px 11px; font-size: 12px; color: var(--ink-2); }
        .pa-row.is-same { background: var(--slate-soft); border-color: var(--line-soft); }
        .pa-row .pr-name { flex: 1 1 180px; min-width: 0; }
        .pa-fig { flex: 1 1 150px; font-size: 11.5px; color: var(--muted); }
        .pa-lop { display: flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; color: var(--ink);
          font-weight: 600; background: var(--surface); border: 1px solid var(--line); border-radius: 9px; padding: 4px 9px; }
        .pa-lop b { color: var(--brand); font-weight: 700; }
        .pa-lop svg { color: var(--faint); }
        .pa-over { font-size: 10.5px; color: var(--amber); background: var(--amber-soft); border-radius: 8px; padding: 3px 8px; }
        .pa-apply { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; margin-top: 14px;
          border-top: 1px solid var(--line-soft); padding-top: 12px; }
        .pa-apply .pa-hint { margin: 0; flex: 1 1 240px; }

        .pa-block { margin-top: 14px; border-top: 1px solid var(--line); padding-top: 13px; background: var(--red-soft);
          border-radius: 12px; padding: 12px 13px; }
        .pa-block-head { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--red); margin-bottom: 8px; }
        .pa-block-head b { font-weight: 700; }
        .pa-block .pa-points { color: var(--red); margin-bottom: 4px; }
        .pa-block .pa-hint { color: var(--red); }

        .pa-applied { display: flex; flex-wrap: wrap; gap: 9px; align-items: center; background: var(--green-soft);
          color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 12px;
          padding: 10px 12px; margin-bottom: 1rem; font-size: 12.5px; line-height: 1.5; }
        .pa-applied svg { flex-shrink: 0; }
        .pa-links { display: flex; flex-wrap: wrap; gap: 6px; }
        .pa-link { font-family: inherit; font-size: 11.5px; font-weight: 600; color: var(--green); background: var(--surface);
          border: 1px solid color-mix(in srgb, var(--green) 28%, white); border-radius: 9px; padding: 4px 9px; cursor: pointer;
          min-height: 0; }
        .pa-link:hover { color: var(--brand); border-color: color-mix(in srgb, var(--brand) 40%, white); }
        .pa-link-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; min-height: 0; opacity: .7; }
        .pa-link-x:hover { opacity: 1; }

        /* The paste pane and its advice are one column until there is genuinely room for two —
           the same break the bank import screen uses. */
        @media (max-width: 1100px) {
          .pa-grid { grid-template-columns: minmax(0, 1fr); }
        }
      `}</style>
    </div>
  )
}

/** Names, codes, roles and states — the plain filter the register needs. */
function filteredEmployees(all: Employee[], q: string): Employee[] {
  const needle = q.trim().toLowerCase()
  const list = needle
    ? all.filter(e => `${e.name} ${e.code} ${e.role} ${e.state_code}`.toLowerCase().includes(needle))
    : all
  return [...list].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name))
}

// ── one row of the salary cards ───────────────────────────────────────────────

function EmployeeRow({ employee, month, settings, onEdit, onToggle, onRemove }: {
  employee: Employee
  month: string
  settings: PayrollSettings
  onEdit: () => void
  onToggle: () => void
  onRemove: () => void
}) {
  const total = structureTotal(employee)
  const allowances = COMPONENT_LABELS.filter(c => !c.in_pf).reduce((t, c) => t + (Number(employee.components[c.key]) || 0), 0)
  const why = offRosterWhy(employee, month)
  const findings = validateEmployee(employee).filter(i => i.level === 'warn')
  const pf = PF_MODE_META[employee.pf_mode]
  const ceiling = pfCeilingOn(`${month}-28`)
  const slip = payslipOf(employee, [], month, settings)

  return (
    <div className={`pr-tr ${why ? 'is-off' : ''}`}>
      <div className="pr-name">
        <b>{employee.name || DASH}{employee.active ? '' : ' · inactive'}</b>
        <span>{employee.code || 'no code'}{employee.role ? ` · ${employee.role}` : ''} · {stateLabel(employee.state_code)}</span>
      </div>
      <div className="pr-num">{total > 0 ? money(slip.pf.wages) : <span className="pr-dash">{DASH}</span>}</div>
      <div className="pr-num">{money(allowances)}</div>
      <div className="pr-num pr-strong">{total > 0 ? money(total) : <span className="pr-dash">{DASH}</span>}</div>
      <div>
        {employee.pf_mode === 'out'
          ? <span title={pf.note}>{pf.label}</span>
          : <span title={`${pf.note}${employee.pf_mode === 'actual' && slip.pf.above_ceiling > 0 ? ` · ${money(slip.pf.above_ceiling)} above the ceiling` : ''}`}>
            {pf.label}{employee.pf_mode === 'ceiling' ? ` · ceiling ₹${ceiling.ceiling.toLocaleString('en-IN')}` : ''}
          </span>}
      </div>
      <div className="pr-num">{employee.pt_monthly === null
        ? <span className="pr-dash" title="Not recorded — nothing is deducted and nothing is claimed">{DASH}</span>
        : money(employee.pt_monthly)}</div>
      <div className="pr-num">{employee.hours_per_day > 0 ? employee.hours_per_day : DASH}</div>
      <div>
        {why
          ? <span title={why}>{why}</span>
          : <span>{employee.join_date ? `since ${formatDateIN(employee.join_date)}` : 'no joining date'}{employee.leave_date ? ` → ${formatDateIN(employee.leave_date)}` : ''}</span>}
      </div>
      <div className="tf-row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        {findings.length > 0 && <Badge tone="amber" dot={false}>{findings.length}</Badge>}
        <button type="button" className="pr-step" onClick={onEdit} title={`Edit ${employee.name || 'this card'}`} aria-label={`Edit ${employee.name || 'this card'}`}><Icon name="edit" size={14} /></button>
        <button type="button" className="pr-step" onClick={onToggle} title={employee.active ? 'Take off the rolls' : 'Put back on the rolls'} aria-label={employee.active ? 'Deactivate' : 'Activate'}>
          <Icon name={employee.active ? 'pause' : 'play'} size={14} />
        </button>
        <button type="button" className="pr-step" onClick={onRemove} title="Remove from the register" aria-label="Remove"><Icon name="x" size={14} /></button>
      </div>
    </div>
  )
}

// ── the settings the shop decides, not the Act ────────────────────────────────

function SettingsPanel({ settings, onSave }: { settings: PayrollSettings; onSave: (s: PayrollSettings) => void }) {
  const [draft, setDraft] = useState<PayrollSettings>(settings)
  const epsMoved = draft.eps_pension_ceiling !== DEFAULT_SETTINGS.eps_pension_ceiling

  return (
    <Card style={{ marginBottom: 12, background: 'var(--slate-soft)' }}>
      <div className="pr-fields" style={{ padding: 0 }}>
        <div className="pr-field">
          <label htmlFor="pr-wd">Lost-day divisor</label>
          <select id="pr-wd" value={draft.working_days} onChange={e => setDraft({ ...draft, working_days: e.target.value as PayrollSettings['working_days'] })}>
            <option value="calendar">Calendar days of the month</option>
            <option value="convention_26">26 days, the shop convention</option>
          </select>
          <span>The plain reading divides a month by its own length; 26 is the convention many establishments use. It changes every net figure in the month, so it is stated rather than assumed.</span>
        </div>
        <div className="pr-field">
          <label htmlFor="pr-eps">EPS pensionable ceiling</label>
          <input id="pr-eps" type="number" min={0} step={1000} value={draft.eps_pension_ceiling}
            onChange={e => setDraft({ ...draft, eps_pension_ceiling: Number(e.target.value) || 0 })} />
          <span>{epsMoved
            ? `₹${draft.eps_pension_ceiling.toLocaleString('en-IN')} a month, on your instruction. No document fetched for this register says whether the Pension Scheme ceiling moved with the wage ceiling on 17-09-2026 — the figure used is printed on every slip.`
            : `₹${draft.eps_pension_ceiling.toLocaleString('en-IN')} a month, the number the scheme has carried. Whether it rose with the ₹${PF_WAGE_CEILINGS[PF_WAGE_CEILINGS.length - 1].ceiling.toLocaleString('en-IN')} wage ceiling is not settled by any document fetched for this file, so the register asks instead of assuming.`}</span>
        </div>
        <div className="pr-field">
          <label htmlFor="pr-esi">ESIC registration</label>
          <select id="pr-esi" value={draft.esi_registered ? 'yes' : 'no'}
            onChange={e => setDraft({ ...draft, esi_registered: e.target.value === 'yes' })}>
            <option value="yes">Registered — employees under ₹{ESI_BANDS[0].wage_limit.toLocaleString('en-IN')} are covered</option>
            <option value="no">Not registered — no employee is covered</option>
          </select>
          <span>{draft.esi_registered ? ESI_BANDS[0].cite : 'With the establishment unregistered the register prints no ESI at all, and says why, instead of a ₹0 line for a scheme nobody is in.'}</span>
        </div>
        <div className="pr-field">
          <label htmlFor="pr-pay">Pay day</label>
          <input id="pr-pay" type="date" value={draft.pay_day} onChange={e => setDraft({ ...draft, pay_day: e.target.value })} />
          <span>The day the shop transfers salaries. Left empty, the month run simply says it is not recorded.</span>
        </div>
      </div>
      <div className="tf-row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <Button size="sm" variant="primary" icon="check" onClick={() => onSave(draft)}>Save how the shop computes</Button>
        <Button size="sm" variant="ghost" onClick={() => setDraft(DEFAULT_SETTINGS)}>Back to the defaults</Button>
        <span className="pr-hint">These four choices are the only settings the register holds. Statutory rates are not here — they live in the rules panel below with the instrument that states them.</span>
      </div>
    </Card>
  )
}

// ── the card: a structure, a window, and the flags that go with them ──────────

function EmployeeEditor({ draft, month, existing, onSave, onClose }: {
  draft: Employee
  month: string
  existing: Employee[]
  onSave: (e: Employee) => void
  onClose: () => void
}) {
  const [form, setForm] = useState<Employee>(draft)
  const findings = validateEmployee(form)
  const blockers = findings.filter(f => f.level === 'block')
  const warnings = findings.filter(f => f.level === 'warn')
  const total = structureTotal(form)
  const ceiling = pfCeilingOn(monthEndKey(month))
  const set = <K extends keyof Employee>(key: K, value: Employee[K]) => setForm(f => ({ ...f, [key]: value }))
  const setComponent = (key: keyof Employee['components'], value: number) =>
    setForm(f => ({ ...f, components: { ...f.components, [key]: value } }))
  const dupe = existing.some(e => e.code.trim() && e.code === form.code && e.id !== form.id)

  return (
    <div className="pr-modal" role="dialog" aria-modal="true" aria-label="Salary card">
      <div className="pr-modal-card">
        <div className="pr-modal-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{draft.name ? `Salary card — ${draft.name}` : 'A new salary card'}</h2>
            <p>Two things are stored here: the monthly structure and the window the person is on the rolls. Tax, provident fund, insurance and take-home are computed from these every time the page loads.</p>
          </div>
          <button type="button" className="pr-notice-x" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="pr-fields">
          <div className="pr-field">
            <label htmlFor="pr-name">Name</label>
            <input id="pr-name" value={form.name} onChange={e => set('name', e.target.value)} placeholder="As the payslip should print it" />
          </div>
          <div className="pr-field">
            <label htmlFor="pr-code">Payroll code</label>
            <input id="pr-code" value={form.code} onChange={e => set('code', e.target.value)} placeholder="E-07" />
            {dupe && <span style={{ color: 'var(--amber)' }}>Another card already uses this code.</span>}
          </div>
          <div className="pr-field">
            <label htmlFor="pr-role">Role</label>
            <input id="pr-role" value={form.role} onChange={e => set('role', e.target.value)} placeholder="What they do" />
          </div>
          <div className="pr-field">
            <label htmlFor="pr-state">Where the work is done</label>
            <select id="pr-state" value={form.state_code} onChange={e => set('state_code', e.target.value)}>
              <option value="">Not set</option>
              {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.value} · {s.label}</option>)}
            </select>
            <span>Professional tax is a state subject, so this is the field that decides whether a dash or a figure belongs on the slip.</span>
          </div>
          <div className="pr-field">
            <label htmlFor="pr-pan">PAN</label>
            <input id="pr-pan" value={form.pan} onChange={e => set('pan', e.target.value.toUpperCase())} placeholder="ABCDE1234F" maxLength={10} />
          </div>
          <div className="pr-field">
            <label htmlFor="pr-uan">UAN</label>
            <input id="pr-uan" value={form.uan} onChange={e => set('uan', e.target.value.replace(/\D/g, ''))} placeholder="The EPFO member number" />
          </div>
          <div className="pr-field">
            <label htmlFor="pr-esino">ESI number</label>
            <input id="pr-esino" value={form.esi_no} onChange={e => set('esi_no', e.target.value.replace(/\D/g, ''))} placeholder="17 digits" />
          </div>
          <div className="pr-field">
            <label htmlFor="pr-age">Age band</label>
            <select id="pr-age" value={form.age_band} onChange={e => set('age_band', e.target.value as Employee['age_band'])}>
              {AGE_BANDS.map(b => <option key={b.value} value={b.value}>{b.label}</option>)}
            </select>
            <span style={AGE_META[form.age_band].modelled ? undefined : { color: 'var(--amber)' }}>{AGE_META[form.age_band].note}</span>
          </div>
        </div>

        <div className="pr-section">
          <p className="pr-section-title">The monthly structure</p>
          <div className="pr-fields" style={{ padding: 0 }}>
            {COMPONENT_LABELS.map(c => (
              <div className="pr-field" key={c.key}>
                <label htmlFor={`pr-c-${c.key}`}>{c.label}</label>
                <input id={`pr-c-${c.key}`} type="number" min={0} step={1000} value={form.components[c.key]}
                  onChange={e => setComponent(c.key, Number(e.target.value) || 0)} />
                <span>{c.in_pf ? 'Carries provident fund — it is wages for that purpose.' : 'Outside the provident-fund base.'}{c.in_esi ? ' Inside ESI wages.' : ''}</span>
              </div>
            ))}
          </div>
          <div className="tf-row-between tf-wrap" style={{ gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
            <Badge tone={total > 0 ? 'blue' : 'amber'} dot={false}>
              {total > 0 ? `${money(total)} a month at this structure` : 'Nothing recorded — the slip will print a dash, not ₹0'}
            </Badge>
            <span className="pr-hint">Basic + dearness allowance is {money(form.components.basic + form.components.da)}, against a {monthLabel(month)} ceiling of ₹{ceiling.ceiling.toLocaleString('en-IN')}.</span>
          </div>
        </div>

        <div className="pr-section">
          <p className="pr-section-title">The window, and what the shop decides</p>
          <div className="pr-fields" style={{ padding: 0 }}>
            <div className="pr-field">
              <label htmlFor="pr-join">Joined on</label>
              <input id="pr-join" type="date" value={form.join_date} onChange={e => set('join_date', e.target.value)} />
              <span>Months ending before this date are not run for them, and the register says so rather than printing a salary of nothing.</span>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-leave">Left on</label>
              <input id="pr-leave" type="date" value={form.leave_date} onChange={e => set('leave_date', e.target.value)} />
              <span>Empty means still on the rolls.</span>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-pf">Provident fund</label>
              <select id="pr-pf" value={form.pf_mode} onChange={e => set('pf_mode', e.target.value as Employee['pf_mode'])}>
                {PF_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <span>{PF_MODE_META[form.pf_mode].note}</span>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-pt">Professional tax, a month</label>
              <input id="pr-pt" type="number" min={0} step={50}
                value={form.pt_monthly === null ? '' : form.pt_monthly}
                onChange={e => set('pt_monthly', e.target.value === '' ? null : Number(e.target.value))}
                placeholder="Blank = the state has not been asked" />
              <span>Leave it blank if nobody has said what your state charges — then nothing is deducted and nothing is claimed. A `0` is a claim: your state charges nothing. Section 16(iii) caps what comes off the year at ₹{PT_ANNUAL_CAP.toLocaleString('en-IN')} however much is paid.</span>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-hours">Hours a day</label>
              <input id="pr-hours" type="number" min={0} step={0.5} value={form.hours_per_day}
                onChange={e => set('hours_per_day', Number(e.target.value) || 0)} />
              <span>Only used to divide a day of employer cost into an hour, which is what this register’s Cost tab does. `/projects` still prices an hour at what you would bill it — folding a costed hour into a job is a separate decision, not an automatic one.</span>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-active">On the rolls</label>
              <select id="pr-active" value={form.active ? 'yes' : 'no'} onChange={e => set('active', e.target.value === 'yes')}>
                <option value="yes">Active — months are run for them</option>
                <option value="no">Inactive — no month is run</option>
              </select>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-disabled">Disability</label>
              <select id="pr-disabled" value={form.disabled ? 'yes' : 'no'} onChange={e => set('disabled', e.target.value === 'yes')}>
                <option value="no">Not recorded</option>
                <option value="yes">A person with a disability — the higher EPF employee share may apply</option>
              </select>
            </div>
            <div className="pr-field">
              <label htmlFor="pr-notes">Notes</label>
              <textarea id="pr-notes" value={form.notes} onChange={e => set('notes', e.target.value)} rows={2} placeholder="Anything the next person to run this month should know" />
            </div>
          </div>
        </div>

        {findings.length > 0 && (
          <div className="pr-section">
            <p className="pr-section-title">What the register says about this card</p>
            <ul className="pr-findings">
              {findings.map(f => (
                <li key={`${f.field}-${f.message}`} className={`pr-finding ${f.level === 'block' ? 'is-red' : 'is-amber'}`}>
                  <Icon name={f.level === 'block' ? 'alert' : 'compare'} size={14} />
                  <span><b>{f.field}</b> — {f.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pr-modal-foot">
          <Button variant="primary" icon="check" onClick={() => onSave(form)} disabled={blockers.length > 0}>
            {blockers.length > 0 ? 'Fix the red findings first' : `Save the card${total > 0 ? ` at ${money(total)} a month` : ''}`}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {warnings.length > 0 && !blockers.length && (
            <span className="pr-hint">{warnings.length} finding{warnings.length === 1 ? '' : 's'} will be saved with the card and printed on the slips.</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** The last day of a YYYY-MM month, for a ceiling that is chosen by date. */
function monthEndKey(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${month}-${String(daysInMonthKey(`${y}-${String(m).padStart(2, '0')}`)).padStart(2, '0')}`
}

// ── the panel every rupee on this page traces back to ─────────────────────────

function RulesPanel({ monthlyStructure, heads }: { monthlyStructure: number; heads: number }) {
  const [open, setOpen] = useState(false)
  return (
    <Card style={{ marginTop: '1.25rem' }}>
      <button type="button" onClick={() => setOpen(o => !o)} className="pr-rules-toggle" aria-expanded={open}>
        <Icon name="doc-check" size={15} />
        <span>Rules this page used</span>
        <span className="pr-hint">{PAYROLL_RULES.length} of them, each with the instrument and the date it was fetched</span>
        <Icon name="chevron-down" size={15} style={{ transform: open ? 'rotate(180deg)' : 'none', marginLeft: 'auto' }} />
      </button>
      {open && (
        <>
          <div className="pr-rules">
            {PAYROLL_RULES.map(r => (
              <div className="pr-rule" key={r.head}>
                <Icon name="file-check" size={14} />
                <span><b>{r.head}.</b> {r.body}</span>
              </div>
            ))}
            <div className="pr-rule">
              <Icon name="shield" size={14} />
              <span><b>Nothing monetary is stored.</b> The register holds {heads} salary card{heads === 1 ? '' : 's'} and the exceptions a month typed;
                the {money(monthlyStructure)} a month of structures on it is turned into gross, provident fund, insurance, tax and take-home on every load.
                It travels in the browser and backs up through the <Link href="/vault" style={{ color: 'var(--brand)' }}>Books Vault</Link>.</span>
            </div>
          </div>
          <p className="pr-hint" style={{ marginTop: 10 }}>
            Deposit dates: {DUE_DAYS.pf_esi}rd for provident fund and ESI, {DUE_DAYS.tds}th for tax on salary, and 15 June for the certificate — {DUE_DAYS.cite.split('.')[0]}.
            The labour codes changed what counts as wages on {WAGE_CODE_50.from}; this register watches that and does not apply it to a provident-fund base, as {WAGE_CODE_50.cite.split(' (')[0]} states.
          </p>
        </>
      )}
    </Card>
  )
}

// ── the month run ─────────────────────────────────────────────────────────────

function MonthTab({ store, month, slips, summary, roster, openSlip, onOpenSlip, onEditRow, onDropRow, onApplySheet }: {
  store: PayrollStore
  month: string
  slips: Payslip[]
  summary: RegisterSummary
  roster: Roster
  openSlip: string
  onOpenSlip: (id: string) => void
  onEditRow: (employee: Employee) => void
  onDropRow: (inputId: string) => void
  onApplySheet: (plan: AttendancePlan) => AttendanceApplyResult
}) {
  const employeeById = useMemo(() => new Map(store.employees.map(e => [e.id, e])), [store.employees])
  const computable = slips.filter(s => s.computable)

  // The sheet is read on screen and applied on click: two separate states, so a preview is always
  // something the shop looked at before it touched anybody's salary.
  const [sheetOpen, setSheetOpen] = useState(false)
  const [text, setText] = useState('')
  const [plan, setPlan] = useState<AttendancePlan | null>(null)
  const [applied, setApplied] = useState<{ result: AttendanceApplyResult; plan: AttendancePlan } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const basis = useMemo(() => attendanceBasis(store, month), [store, month])

  // A preview belongs to the month it was read against. Move the month and it goes — checked while
  // rendering rather than from an effect, so the stale sheet is never painted for a frame.
  const [sheetMonth, setSheetMonth] = useState(month)
  if (sheetMonth !== month) {
    setSheetMonth(month)
    setPlan(null)
    setApplied(null)
    setText('')
  }

  function readSheet() {
    setApplied(null)
    setPlan(planAttendance(store, month, text))
  }
  function takeFile(f?: File) {
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => { setText(String(reader.result || '')); setPlan(null); setApplied(null) }
    reader.readAsText(f)
  }
  function applyPlan() {
    if (!plan) return
    const result = onApplySheet(plan)
    if (result.written > 0) {
      setApplied({ result, plan })
      setPlan(null)
      setText('')
    } else {
      setApplied(null)
    }
  }

  return (
    <>
      <div className="pr-strip">
        <StatCard label="Gross this month" value={summary.gross} sub={`${summary.heads} on the rolls`} icon="wallet" tone="blue" />
        <StatCard label="Paid out" value={summary.net} sub="after every deduction" icon="check" tone="green" />
        <StatCard label="Business spends" value={summary.employer_cost} sub="gross plus the employer's own legs" icon="compare" tone="violet" />
        <StatCard label="Tax on salary" value={summary.tds} sub={`${summary.no_tax} with no computable figure`} icon="file-check" tone="amber" />
      </div>

      {sheetOpen && (
        <Card style={{ marginBottom: '1rem' }}>
          <p className="pr-section-title">The shop’s attendance sheet, read into {monthLabel(month)}</p>
          <div className="pa-grid">
            <div>
              <p className="pa-help">
                Paste the table your supervisor keeps — a selection from Excel, a CSV, a plain-text export. The register
                reads one figure out of it: <b>lost days</b>. Nothing else on a month row moves, and the sheet itself is
                never stored.
              </p>
              <textarea
                className="pa-text"
                value={text}
                onChange={e => { setText(e.target.value); setPlan(null); setApplied(null) }}
                spellCheck={false}
                aria-label={`Attendance sheet for ${monthLabel(month)}`}
                placeholder={'Code,Name,Present\nE-07,Shabbir Ahmed,26\nE-11,Lakshmi N,24/26'}
              />
              <div className="pa-actions">
                <Button size="sm" icon="file-check" onClick={readSheet} disabled={!text.trim()}>
                  {plan ? 'Read it again' : 'Read the sheet'}
                </Button>
                <Button size="sm" variant="subtle" icon="upload" onClick={() => fileRef.current?.click()}>Choose a file</Button>
                <Button size="sm" variant="ghost" icon="users" disabled={roster.on.length === 0}
                  onClick={() => { setText(attendanceTemplate(store, month)); setPlan(null); setApplied(null) }}>
                  Rule it with this month’s roster
                </Button>
                <Button size="sm" variant="ghost" icon="download" disabled={roster.on.length === 0}
                  onClick={() => download(`attendance-${month}.csv`, attendanceTemplate(store, month))}>
                  Blank sheet
                </Button>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" hidden aria-hidden
                  onChange={e => takeFile(e.target.files?.[0])} />
              </div>
              <p className="pa-hint">
                The blank sheet is this month’s roster, already ruled with the register’s own codes — fill it on paper,
                paste it back here, and every line matches on a code you never retyped.
              </p>
            </div>

            <div className="pa-what">
              <div className="pa-title">What it reads</div>
              <ul className="pa-points">
                <li><b>A column headed Present</b> is subtracted from the month’s basis. {basis.why}</li>
                <li><b>A column headed LOP, Loss, Absent or Short</b> is taken exactly as it stands.</li>
                <li><b>A day grid</b> — one column per date — counts the days marked lost; holidays and paid leave are marked but cost nothing.</li>
                <li><b>A code first, then a name</b>, then one unique piece of a name. Two people sharing a code, or a name, are refused rather than chosen between.</li>
              </ul>
              <div className="pa-marks" aria-hidden>
                {ATTENDANCE_MARKS.map(m => (
                  <span key={m.mark} className={`pa-mark pa-mark-${m.means}`} title={`${m.mark} — ${m.reads}`}>{m.mark}</span>
                ))}
              </div>
              <div className="pa-title">What it will not do</div>
              <p className="pa-help">
                A number no header names is refused instead of guessed at, because days present and days lost are
                opposite figures. A person the sheet never mentions keeps the lost days they had. Arrears, bonuses and
                recoveries are never touched — a sheet says nothing about money. Nothing at all is written until you
                click Apply on the preview.
              </p>
            </div>
          </div>

          {plan && <SheetPlan plan={plan} onCancel={() => setPlan(null)} onApply={applyPlan} />}
        </Card>
      )}

      {applied && applied.result.written > 0 && (
        <div className="pa-applied" role="status">
          <Icon name="check" size={14} />
          <span>
            {applied.result.written} month row{applied.result.written === 1 ? ' carries' : 's now carry'} {monthLabel(month)}’s
            attendance. Every slip below re-computed on it — gross, provident fund, insurance, tax and take-home.
          </span>
          <div className="pa-links">
            {applied.plan.matches.map(m => (
              <button key={m.employee_id} type="button" className="pa-link" onClick={() => onOpenSlip(m.employee_id)}>
                {m.name}
              </button>
            ))}
          </div>
          <button type="button" className="pa-link-x" onClick={() => setApplied(null)} aria-label="Dismiss the receipt">
            <Icon name="x" size={14} />
          </button>
        </div>
      )}

      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div className="pr-pad" style={{ paddingBottom: 0 }}>
          <div className="tf-row-between tf-wrap" style={{ gap: 10 }}>
            <p className="pr-note">
              {roster.on.length} row{roster.on.length === 1 ? '' : 's'} for {monthLabel(month)}.
              {roster.off.length > 0 && ` ${roster.off.length} person${roster.off.length === 1 ? ' is' : 's are'} not in it below.`}
              {' '}A slip you have not opened still pays the structure — an attendance row only records the exceptions to it.
            </p>
            <div className="tf-row tf-wrap" style={{ gap: 8 }}>
              <Button size="sm" variant={sheetOpen ? 'primary' : 'ghost'} icon="upload" onClick={() => setSheetOpen(o => !o)}>
                {sheetOpen ? 'Close the sheet' : 'Read an attendance sheet'}
              </Button>
              <Button size="sm" variant="ghost" icon="download" disabled={slips.length === 0}
                onClick={() => download(`payroll-${month}.csv`, toCsv(PAYROLL_CSV_HEADERS, payrollCsvRows(slips)))}>
                Register CSV
              </Button>
            </div>
          </div>
        </div>

        {slips.length === 0 ? (
          <div className="pr-pad"><EmptyState icon="calendar" title={`Nobody to run for ${monthLabel(month)}`}
            message="The roster for this month is empty — everyone is either marked inactive, or their employment window does not reach it." /></div>
        ) : (
          <div className="pr-scroll">
            <div className="pr-cols mn">
              <div className="pr-head">Person</div>
              <div className="pr-head">Days basis</div>
              <div className="pr-head pr-num">Lost</div>
              <div className="pr-head pr-num">Gross</div>
              <div className="pr-head pr-num">PF</div>
              <div className="pr-head pr-num">ESI</div>
              <div className="pr-head pr-num">Prof. tax</div>
              <div className="pr-head pr-num">TDS</div>
              <div className="pr-head pr-num">Net pay</div>
              <div className="pr-head pr-num">Spends</div>
              <div className="pr-head"></div>
            </div>
            {slips.map(s => {
              const employee = employeeById.get(s.employee_id) || null
              const open = openSlip === s.employee_id
              return (
                <div key={s.employee_id}>
                  <div className={`pr-tr mn ${s.computable ? '' : 'is-off'}`} onClick={() => onOpenSlip(open ? '' : s.employee_id)} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenSlip(open ? '' : s.employee_id) } }}>
                    <div className="pr-name">
                      <b>{s.name || DASH}</b>
                      <span>{s.code || 'no code'}{s.role ? ` · ${s.role}` : ''}</span>
                    </div>
                    <div>{s.divisor_label}</div>
                    <div className="pr-num">{s.lop_days > 0 ? count(s.lop_days, 'day') : <span className="pr-dash">{DASH}</span>}</div>
                    <div className="pr-num pr-strong">{moneyOn(s, s.gross)}</div>
                    <div className="pr-num">{moneyOn(s, s.pf.employee)}</div>
                    <div className="pr-num">{s.esi.covered ? moneyOn(s, s.esi.employee) : <span className="pr-dash" title={s.esi.why}>{DASH}</span>}</div>
                    <div className="pr-num">{s.pt === null
                      ? <span className="pr-dash" title="Not recorded — nothing is deducted, nothing is claimed">{DASH}</span>
                      : moneyOn(s, s.pt)}</div>
                    <div className="pr-num">{s.tax.applicable ? moneyOn(s, s.tds) : <span className="pr-dash" title={s.tax.reason}>{DASH}</span>}</div>
                    <div className="pr-num pr-strong">{moneyOn(s, s.net_pay)}</div>
                    <div className="pr-num">{moneyOn(s, s.employer_cost)}</div>
                    <div className="tf-row" style={{ gap: 5, justifyContent: 'flex-end' }}>
                      {s.flags.length > 0 && <Badge tone={s.flags.some(f => f.tone === 'red') ? 'red' : 'amber'} dot={false}>{s.flags.length}</Badge>}
                      <Icon name="chevron-down" size={14} style={{ color: 'var(--faint)', transform: open ? 'rotate(180deg)' : 'none' }} />
                    </div>
                  </div>
                  {open && (
                    <SlipDetail slip={s} employee={employee} month={month}
                      onEdit={employee ? () => onEditRow(employee) : undefined}
                      onDelete={s.input ? () => onDropRow(s.input!.id) : undefined} />
                  )}
                </div>
              )
            })}
          </div>
        )}

        {roster.off.length > 0 && (
          <div className="pr-pad">
            <p className="pr-section-title">Not in {monthLabel(month)}</p>
            <div className="pr-misses">
              {roster.off.map(o => (
                <div className="pr-miss" key={o.employee.id}>
                  <Icon name="pause" size={14} />
                  <span><b style={{ color: 'var(--ink)' }}>{o.employee.name || 'A card with no name'}</b> — {o.why}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      {computable.length > 0 && (
        <Card style={{ marginBottom: '1rem' }}>
          <p className="pr-section-title">What this month owes the shelves</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <StatRow label={`Provident fund — ${summary.in_pf} in the scheme`} value={summary.pf_employee + summary.pf_employer} tone="blue" />
            <StatRow label={`Employee State Insurance — ${summary.in_esi} covered`} value={summary.esi_employee + summary.esi_employer} tone="cyan" />
            <StatRow label={`Tax on salary (section 192)`} value={summary.tds} tone="amber" />
            <StatRow label={`Professional tax${summary.pt_unset > 0 ? ` — ${summary.pt_unset} head${summary.pt_unset === 1 ? '' : 's'} unrecorded` : ''}`}
              value={summary.pt} tone="grey" />
          </div>
          <p className="pr-hint" style={{ marginTop: 10 }}>
            Every one of these is deposited on its own portal — EPFO for provident fund, ESIC for insurance, the income-tax
            portal on a 281 challan for salary tax, the state for professional tax. The register computes them and nothing here moves money.
          </p>
        </Card>
      )}
    </>
  )
}

/**
 * The preview a sheet gets before it gets a salary: which lines matched, whose lost days move from
 * what to what, which lines are refused with the reason and the line number, and which people on the
 * rolls the sheet never mentioned. The Apply button is the only write in this panel.
 */
function SheetPlan({ plan, onCancel, onApply }: {
  plan: AttendancePlan
  onCancel: () => void
  onApply: () => void
}) {
  if (plan.blockers.length > 0) {
    return (
      <div className="pa-block">
        <div className="pa-block-head">
          <Icon name="alert" size={15} />
          <b>The sheet is refused before anything is written</b>
        </div>
        <ul className="pa-points">
          {plan.blockers.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
        <p className="pa-hint">Not one month row changed. Correct the sheet, or the month on this screen, and read it again.</p>
      </div>
    )
  }

  const changed = plan.matches.filter(m => m.changed)
  const loose = plan.matches.filter(m => m.matched_on === 'approximate')
  const missing = plan.findings.filter(f => f.employee_id)
  const readings = plan.findings.filter(f => !f.employee_id)

  return (
    <div className="pa-plan">
      <div className="pa-plan-head">
        <div className="tf-row tf-wrap" style={{ gap: 7 }}>
          <Badge tone={changed.length > 0 ? 'blue' : 'grey'} dot={false}>{changed.length} to change</Badge>
          {plan.unchanged > 0 && <Badge tone="grey" dot={false}>{plan.unchanged} already agree</Badge>}
          {loose.length > 0 && <Badge tone="amber" dot={false}>{loose.length} matched loosely</Badge>}
          {plan.refusals.length > 0 && <Badge tone="red" dot={false}>{plan.refusals.length} refused</Badge>}
          {missing.length > 0 && <Badge tone="amber" dot={false}>{missing.length} not named</Badge>}
        </div>
        <span className="pa-hint">
          {plan.rows_read} line{plan.rows_read === 1 ? '' : 's'} read, split on {plan.delimiter === '\t' ? 'tabs' : `“${plan.delimiter}”`}
          {' '}· {plan.grid ? 'a day grid' : 'one row per person'} · {plan.basis.days}-day basis
        </span>
      </div>

      {plan.matches.length === 0 && (
        <p className="pa-note">Nothing matched, so nothing would be written. The refusals say what the register could not read.</p>
      )}

      {plan.matches.length > 0 && (
        <div className="pa-rows">
          {plan.matches.map(m => (
            <div className={`pa-row ${m.changed ? '' : 'is-same'}`} key={`${m.line}-${m.employee_id}`}>
              <div className="pr-name">
                <b>{m.name}</b>
                <span>
                  {m.code || 'no code'} · line {m.line}
                  {m.matched_on === 'approximate' ? ' · matched on part of the name' : m.matched_on === 'name' ? ' · matched on the name' : ''}
                </span>
              </div>
              <div className="pa-fig">{m.read}</div>
              <div className="pa-lop">
                {m.before === null
                  ? <span>a new row, {count(m.lop_days, 'day')} lost</span>
                  : m.changed
                    ? <span>{count(m.before, 'day')} <Icon name="swap" size={11} /> <b>{count(m.lop_days, 'day')}</b></span>
                    : <span>stays at {count(m.lop_days, 'day')}</span>}
              </div>
              {m.overflow && <span className="pa-over" title="The sheet counts more days present than the month has — taken as a full month, never as a payment.">more days than the month</span>}
            </div>
          ))}
        </div>
      )}

      {plan.refusals.length > 0 && (
        <>
          <p className="pa-sub">Lines the register will not write</p>
          <ul className="pr-findings">
            {plan.refusals.map((r, i) => (
              <li className="pr-finding is-red" key={`r-${i}`}>
                <Icon name="alert" size={14} />
                <span><b style={{ color: 'var(--ink)' }}>Line {r.line}</b> · {r.text}<br />{r.reason}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {readings.length > 0 && (
        <ul className="pr-findings">
          {readings.map((f, i) => (
            <li className="pr-finding is-grey" key={`c-${i}`}>
              <Icon name="compare" size={14} />
              <span>{f.message}</span>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && (
        <>
          <p className="pa-sub">On the rolls, and not on the sheet</p>
          <div className="pr-misses">
            {missing.map(f => (
              <div className="pr-miss" key={f.employee_id}>
                <Icon name="users" size={14} />
                <span>{f.message}</span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="pa-apply">
        <Button variant="primary" size="sm" icon="check" onClick={onApply} disabled={plan.matches.length === 0}>
          Apply {plan.matches.length} row{plan.matches.length === 1 ? '' : 's'}
        </Button>
        <Button variant="ghost" size="sm" icon="x" onClick={onCancel}>Do not apply</Button>
        <span className="pa-hint">
          Lost days and the sentence saying where they came from — arrears, bonuses, recoveries and every other month
          stay exactly as they are.
        </span>
      </div>
    </div>
  )
}

/** The whole of one slip: components, provident-fund and insurance readings, the tax walk, and the row's own exceptions. */
function SlipDetail({ slip, employee, month, onEdit, onDelete }: {
  slip: Payslip
  employee: Employee | null
  month: string
  onEdit?: () => void
  onDelete?: () => void
}) {
  return (
    <div className="pr-walk">
      <div className="pr-walk-head">
        <div className="tf-row tf-wrap" style={{ gap: 8 }}>
          <Button size="sm" icon="edit" onClick={onEdit} disabled={!onEdit}>{slip.input ? 'Edit this month' : 'Add a month row'}</Button>
          {slip.input && onDelete && <Button size="sm" variant="ghost" icon="x" onClick={onDelete}>Remove the row</Button>}
        </div>
        <span className="pr-hint">
          {slip.input
            ? `Row typed for ${monthLabel(month)}: ${slip.input.lop_days} lost, ${money(slip.input.arrears)} arrears, ${money(slip.input.bonus)} bonus, ${money(slip.input.recovery)} recovery.${slip.input.note ? ` “${slip.input.note}”` : ''}`
            : `No attendance row for ${monthLabel(month)} — this slip pays the card's structure with nothing taken out or added.`}
        </span>
      </div>

      <div className="pr-walk-grid">
        <div>
          <p className="pr-section-title">Components</p>
          {slip.components.length === 0
            ? <p className="pr-hint">{slip.why_not}</p>
            : slip.components.map(c => (
              <div className="pr-leg" key={c.key}>
                <span>{c.label}{c.in_pf ? ' · PF' : ''}{c.in_esi ? ' · ESI' : ''}</span>
                <span className="pr-num">{moneyOn(slip, c.paid)}{Math.abs(c.paid - c.monthly) > 0.5 ? <em className="pr-faint"> / {money(c.monthly)}</em> : ''}</span>
              </div>
            ))}
        </div>

        <div>
          <p className="pr-section-title">Provident fund</p>
          {slip.pf.in_scheme
            ? <>
              <div className="pr-leg"><span>Wages (basic + DA)</span><span className="pr-num">{money(slip.pf.wages)}</span></div>
              <div className="pr-leg"><span>Base used · ceiling</span><span className="pr-num">{money(slip.pf.used)} / ₹{slip.pf.ceiling.toLocaleString('en-IN')}</span></div>
              <div className="pr-leg"><span>Employee 12%</span><span className="pr-num">{money(slip.pf.employee)}</span></div>
              <div className="pr-leg"><span>Employer EPF + EPS + EDLI + admin</span><span className="pr-num">{money(slip.pf.employer_total)}</span></div>
              {slip.pf.above_ceiling > 0 && <p className="pr-hint">₹{Math.round(slip.pf.above_ceiling).toLocaleString('en-IN')} of basic sits above the ceiling and carries nothing.</p>}
            </>
            : <p className="pr-hint">{slip.pf.why}</p>}
          <p className="pr-section-title" style={{ marginTop: 10 }}>Insurance</p>
          {slip.esi.covered
            ? <>
              <div className="pr-leg"><span>Gross wages · limit</span><span className="pr-num">{money(slip.esi.wages)} / ₹{slip.esi.limit.toLocaleString('en-IN')}</span></div>
              <div className="pr-leg"><span>Employee 0.75% / employer 3.25%</span><span className="pr-num">{money(slip.esi.employee)} / {money(slip.esi.employer)}</span></div>
            </>
            : <p className="pr-hint">{slip.esi.why}</p>}
        </div>

        <div>
          <p className="pr-section-title">Tax on salary</p>
          {slip.tax.applicable ? <TaxWalk tax={slip.tax} month={month} />
            : <p className="pr-hint">{slip.tax.reason}</p>}
        </div>
      </div>

      {slip.flags.length > 0 && (
        <ul className="pr-findings" style={{ marginTop: 10 }}>
          {slip.flags.map(f => (
            <li key={`${f.field}-${f.text}`} className={`pr-finding ${TONE_CLASS[f.tone]}`}>
              <Icon name={f.tone === 'red' ? 'alert' : 'compare'} size={14} />
              <span>{f.text}</span>
            </li>
          ))}
        </ul>
      )}
      {employee && employee.notes && <p className="pr-note" style={{ marginTop: 8 }}>Card note — {employee.notes}</p>}
    </div>
  )
}

/** Section 192 read with rules 31-33: the estimate, the year's tax, and this month's instalment. */
function TaxWalk({ tax, month }: { tax: Payslip['tax']; month: string }) {
  return (
    <>
      <div className="pr-leg"><span>Estimated for the year</span><span className="pr-num">{money(tax.income_estimate)}</span></div>
      <div className="pr-leg"><span>Standard deduction 16(ia)</span><span className="pr-num">− {money(tax.standard_deduction)}</span></div>
      {tax.pt_deduction > 0 && <div className="pr-leg"><span>Professional tax 16(iii)</span><span className="pr-num">− {money(tax.pt_deduction)}</span></div>}
      <div className="pr-leg pr-strong-leg"><span>Taxable income</span><span className="pr-num">{money(tax.taxable_income)}</span></div>
      {tax.slabs.map(s => (
        <div className="pr-leg" key={s.band}>
          <span className="pr-faint">{s.band} @ {s.pct}%</span>
          <span className="pr-num pr-faint">{money(s.tax)}</span>
        </div>
      ))}
      <div className="pr-leg"><span>Tax before rebate</span><span className="pr-num">{money(tax.tax_before_rebate)}</span></div>
      {tax.rebate > 0 && <div className="pr-leg"><span>Rebate 87A</span><span className="pr-num">− {money(tax.rebate)}</span></div>}
      {tax.rebate_relief > 0 && <div className="pr-leg"><span>Marginal relief at the rebate cliff</span><span className="pr-num">− {money(tax.rebate_relief)}</span></div>}
      {tax.surcharge > 0 && <div className="pr-leg"><span>Surcharge</span><span className="pr-num">{money(tax.surcharge)}{tax.surcharge_relief > 0 ? ` (relieved ${money(tax.surcharge_relief)})` : ''}</span></div>}
      {tax.cess > 0 && <div className="pr-leg"><span>Cess 4%</span><span className="pr-num">{money(tax.cess)}</span></div>}
      <div className="pr-leg pr-strong-leg"><span>The year’s tax</span><span className="pr-num">{money(tax.annual_tax)}</span></div>
      <div className="pr-leg"><span>Already walked off before {monthLabel(month)}</span><span className="pr-num">{money(tax.deducted_to_date)}</span></div>
      <div className="pr-leg"><span>Months still on the rolls</span><span className="pr-num">{tax.months_remaining}</span></div>
      <div className="pr-leg pr-tds-leg"><span>This month’s TDS</span><span className="pr-num">{money(tax.tds)}</span></div>
      <p className="pr-hint" style={{ marginTop: 6 }}>{tax.regime_note}</p>
    </>
  )
}

// ── statutory dues ────────────────────────────────────────────────────────────

function DuesTab({ store, fy, month }: { store: PayrollStore; fy: number; month: string }) {
  const lines = useMemo(() => statutoryDues(store, month), [store, month])
  const misses = useMemo(() => missingHeads(store, month), [store, month])
  const year = useMemo(() => fyMonths(fy).filter(m => store.inputs.some(i => i.month === m)), [fy, store.inputs])

  return (
    <>
      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div className="pr-pad">
          <div className="tf-row-between tf-wrap" style={{ gap: 10, marginBottom: 12 }}>
            <div>
              <p className="pr-section-title" style={{ marginBottom: 2 }}>The challans {monthLabel(month)} produces</p>
              <p className="pr-hint">A head with nothing in it is not a deadline, so it is absent here rather than shown as ₹0 —
                and the misses below say exactly which are absent and why.</p>
            </div>
            <Button size="sm" variant="ghost" icon="download" disabled={year.length === 0 && lines.length === 0}
              onClick={() => download(`statutory-dues-${fy}.csv`, toCsv(STATUTORY_CSV_HEADERS, statutoryCsvRows(store, year.length ? year : [month])))}>
              Dues CSV
            </Button>
          </div>

          {lines.length === 0 ? (
            <EmptyState icon="file-check" title={`${monthLabel(month)} files nothing`}
              message="No head this month carries a rupee to deposit — nobody is in the scheme, everyone falls under the rebate, or professional tax was never set. The rows below state each of those as a fact." />
          ) : (
            <div className="pr-dues">
              {lines.map(l => (
                <div className="pr-due" key={l.key}>
                  <div className="pr-due-head">
                    <span className="pr-due-title">{l.label}<em>{l.form}</em></span>
                    <span className="pr-due-amt">{money(l.amount)}</span>
                  </div>
                  <div className="pr-due-due">
                    {l.due
                      ? <><Icon name="calendar" size={13} /> Deposit by {formatDateIN(l.due)}</>
                      : <><Icon name="alert" size={13} /> Due on the state’s own date — no national date to print</>}
                    {l.href !== '/payroll' && <Link href={l.href} className="pr-due-link">open {l.href}</Link>}
                  </div>
                  <p className="pr-hint">{l.basis}</p>
                  <p className="pr-note">{l.note}</p>
                  <p className="pr-cite">{l.cite}</p>
                </div>
              ))}
            </div>
          )}

          {misses.length > 0 && (
            <div className="pr-misses" style={{ marginTop: 12 }}>
              {misses.map(m => (
                <div className="pr-miss" key={m.key}>
                  <Icon name="check" size={14} />
                  <span><b style={{ color: 'var(--ink)' }}>{m.label}</b> — Nothing due. {m.why}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {year.length > 0 && (
        <Card style={{ marginBottom: '1rem' }}>
          <p className="pr-section-title">Every month of {fyLabel(fy)} the register can prove</p>
          <div className="pr-year-grid">
            {year.map(m => {
              const ls = statutoryDues(store, m)
              const total = ls.reduce((a, l) => a + l.amount, 0)
              return (
                <div className="pr-year-cell" key={m}>
                  <b>{monthLabel(m)}</b>
                  <span>{ls.length ? ls.map(l => l.label).join(', ') : 'nothing deposited'}</span>
                  <em>{total > 0 ? money(total) : DASH}</em>
                </div>
              )
            })}
          </div>
          <p className="pr-hint" style={{ marginTop: 10 }}>
            These months feed the compliance calendar with their own deposit dates and rupee figures, replacing the monthly
            guesses — a professional-tax row stays undated there too, because only the state knows that date.
          </p>
        </Card>
      )}
    </>
  )
}

// ── the annual sheet: Form-16 shaped, and labelled as not Form 16 ─────────────

function AnnualTab({ store, fy }: { store: PayrollStore; fy: number }) {
  const [openRow, setOpenRow] = useState('')
  const sheets = useMemo(() => annualSheets(store, fy), [store, fy])

  return (
    <Card pad={false} style={{ marginBottom: '1rem' }}>
      <div className="pr-pad" style={{ paddingBottom: 0 }}>
        <div className="tf-row-between tf-wrap" style={{ gap: 10 }}>
          <p className="pr-note">The year {fyLabel(fy)} as the employee’s return will see it — salary, the deductions this register
            holds, and the tax it walked. Part A of a real Form 16 is generated from challans the department accepted, which live
            on TRACES and not in a browser; this sheet is shaped like the certificate and is not the certificate.</p>
          <Button size="sm" variant="ghost" icon="download" disabled={sheets.length === 0}
            onClick={() => download(`annual-${fy}.csv`, toCsv(ANNUAL_CSV_HEADERS, annualCsvRows(sheets)))}>Annual CSV</Button>
        </div>
      </div>

      {sheets.length === 0 ? (
        <div className="pr-pad"><EmptyState icon="clipboard" title={`Nobody worked in ${fyLabel(fy)}`}
          message="No card on the register has an employment window that reaches a month of this year, so there is no sheet to draw." /></div>
      ) : (
        <div className="pr-scroll">
          <div className="pr-cols an">
            <div className="pr-head">Person</div>
            <div className="pr-head pr-num">Months</div>
            <div className="pr-head pr-num">Gross</div>
            <div className="pr-head pr-num">16(ia)</div>
            <div className="pr-head pr-num">16(iii)</div>
            <div className="pr-head pr-num">Taxable</div>
            <div className="pr-head pr-num">Year tax</div>
            <div className="pr-head pr-num">TDS taken</div>
            <div className="pr-head pr-num">Difference</div>
            <div className="pr-head pr-num">Employer cost</div>
            <div className="pr-head"></div>
          </div>
          {sheets.map(s => {
            const open = openRow === s.employee_id
            const short = s.difference < -0.5
            return (
              <div key={s.employee_id}>
                <div className={`pr-tr an ${s.tax_modelled ? '' : 'is-off'}`} role="button" tabIndex={0} onClick={() => setOpenRow(open ? '' : s.employee_id)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenRow(open ? '' : s.employee_id) } }}>
                  <div className="pr-name"><b>{s.name || DASH}</b><span>{s.code || 'no code'}</span></div>
                  <div className="pr-num">{s.months_worked}</div>
                  <div className="pr-num">{money(s.gross_salary)}</div>
                  <div className="pr-num">{s.tax_modelled ? `− ${money(s.standard_deduction)}` : DASH}</div>
                  <div className="pr-num">{s.tax_modelled ? (s.pt_deduction > 0 ? `− ${money(s.pt_deduction)}` : '− 0') : DASH}</div>
                  <div className="pr-num">{s.tax_modelled ? money(s.taxable_income) : DASH}</div>
                  <div className="pr-num">{s.tax_modelled ? money(s.tax_payable) : <span className="pr-dash" title={s.why_not}>{DASH}</span>}</div>
                  <div className="pr-num">{s.tax_modelled ? money(s.tds_deducted) : DASH}</div>
                  <div className="pr-num" style={{ color: short ? 'var(--red)' : Math.abs(s.difference) > 0.5 ? 'var(--amber)' : undefined }}>
                    {s.tax_modelled ? (Math.abs(s.difference) < 0.5 ? 'matched' : `${short ? 'short ' : 'excess '}${money(Math.abs(Math.round(s.difference)))}`) : DASH}
                  </div>
                  <div className="pr-num">{money(s.employer_cost)}</div>
                  <div className="tf-row" style={{ gap: 5, justifyContent: 'flex-end' }}>
                    {s.flags.length > 0 && <Badge tone={s.flags.some(f => f.tone === 'red') ? 'red' : 'amber'} dot={false}>{s.flags.length}</Badge>}
                    <Icon name="chevron-down" size={14} style={{ color: 'var(--faint)', transform: open ? 'rotate(180deg)' : 'none' }} />
                  </div>
                </div>
                {open && (
                  <div className="pr-walk">
                    {s.flags.length > 0 && (
                      <ul className="pr-findings">
                        {s.flags.map(f => (
                          <li key={`${f.field}-${f.text}`} className={`pr-finding ${TONE_CLASS[f.tone]}`}>
                            <Icon name={f.tone === 'red' ? 'alert' : 'compare'} size={14} /><span>{f.text}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {s.tax_modelled && (
                      <div className="pr-walk-grid">
                        <div className="pr-leg"><span>Tax before rebate</span><span className="pr-num">{money(s.tax_before_rebate)}</span></div>
                        <div className="pr-leg"><span>Rebate 87A</span><span className="pr-num">− {money(s.rebate)}</span></div>
                        <div className="pr-leg"><span>Surcharge</span><span className="pr-num">{money(s.surcharge)}</span></div>
                        <div className="pr-leg"><span>Cess</span><span className="pr-num">{money(s.cess)}</span></div>
                      </div>
                    )}
                    <p className="pr-hint" style={{ marginTop: 8 }}>
                      {s.tax_modelled
                        ? `Professional tax actually recorded across the year is ${money(s.pt_recorded)}; section 16(iii) lets ${money(s.pt_deduction)} off the income.`
                        : s.why_not}
                    </p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {sheets.length > 0 && (
        <p className="pr-hint" style={{ padding: '0 14px 14px' }}>
          Where the monthly instalments and the year’s computed figure disagree, this sheet prints the disagreement instead of
          smoothing it — that gap is exactly what the employee settles in their own return, and a shortfall after a mid-year
          change is the employer’s default, not theirs.
        </p>
      )}
    </Card>
  )
}

// ── the cost of an hour ───────────────────────────────────────────────────────

function CostTab({ store, month }: { store: PayrollStore; month: string }) {
  const slips = useMemo(() => monthRegister(store, month), [store, month])
  const costs = useMemo(() => costPerHourFor(store, month), [store, month])
  const blended = useMemo(() => blendedHourCost(slips), [slips])

  return (
    <>
      <div className="pr-strip">
        <StatCard label="Blended hour" value={blended.per_hour === null ? DASH : blended.per_hour} sub="employer cost ÷ paid hours" icon="compare" tone="violet" />
        <StatCard label="Paid hours this month" value={blended.paid_hours.toLocaleString('en-IN')} sub="days worked × the shop's hours" icon="clock" tone="cyan" />
      </div>

      <Card pad={false} style={{ marginBottom: '1rem' }}>
        <div className="pr-pad" style={{ paddingBottom: 0 }}>
          <p className="pr-note">The rupee an hour of each person’s time actually cost the business: the month’s employer cost — gross
            plus the employer’s own provident-fund and insurance legs — divided by the days that were paid for and the hours the shop works.
            It is not subtracted from a project automatically: the hours logged on a job were not necessarily these people’s, and the register
            that knows who worked is <Link href="/projects" style={{ color: 'var(--brand)' }}>Projects &amp; Time</Link>.</p>
        </div>

        {costs.length === 0 ? (
          <div className="pr-pad"><EmptyState icon="wallet" title={`Nobody to price for ${monthLabel(month)}`}
            message="The roster for this month is empty, so there is no employer cost to divide into hours." /></div>
        ) : (
          <div className="pr-scroll">
            <div className="pr-cols cs">
              <div className="pr-head">Person</div>
              <div className="pr-head pr-num">Paid days</div>
              <div className="pr-head pr-num">Hours a day</div>
              <div className="pr-head pr-num">Cost a day</div>
              <div className="pr-head pr-num">Cost an hour</div>
            </div>
            {costs.map(c => (
              <div key={c.employee_id}>
                <div className={`pr-tr cs ${c.cost_per_hour === null ? 'is-off' : ''}`}>
                  <div className="pr-name"><b>{c.name || DASH}</b><span>{c.month}</span></div>
                  <div className="pr-num">{c.paid_days}</div>
                  <div className="pr-num">{c.hours_per_day > 0 ? c.hours_per_day : DASH}</div>
                  <div className="pr-num">{money(c.cost_per_day)}</div>
                  <div className="pr-num pr-strong">{money(c.cost_per_hour)}</div>
                </div>
                <p className="pr-cite" style={{ padding: '0 4px 10px' }}>{c.why === '' ? c.basis : c.why}</p>
              </div>
            ))}
          </div>
        )}
        {blended.why && <div className="pr-pad"><p className="pr-hint">{blended.why}</p></div>}
      </Card>
    </>
  )
}

// ── the month row: the four exceptions a person's month takes ─────────────────

function RowEditor({ draft, employee, onSave, onClose, onDelete }: {
  draft: PayInput
  employee: Employee | null
  onSave: (i: PayInput) => void
  onClose: () => void
  onDelete?: () => void
}) {
  const [form, setForm] = useState<PayInput>(draft)
  const findings = validateInput(form, employee, form.month)
  const blockers = findings.filter(f => f.level === 'block')
  const set = <K extends keyof PayInput>(key: K, value: PayInput[K]) => setForm(f => ({ ...f, [key]: value }))

  const num = (label: string, key: 'lop_days' | 'arrears' | 'bonus' | 'recovery', hint: string) => (
    <div className="pr-field">
      <label htmlFor={`pr-${key}`}>{label}</label>
      <input id={`pr-${key}`} type="number" min={0} step={key === 'lop_days' ? 0.5 : 100}
        value={form[key]} onChange={e => set(key, Number(e.target.value) || 0)} />
      <span>{hint}</span>
    </div>
  )

  return (
    <div className="pr-modal" role="dialog" aria-modal="true" aria-label="Month row">
      <div className="pr-modal-card" style={{ width: 'min(620px, 100%)' }}>
        <div className="pr-modal-head">
          <div style={{ minWidth: 0, flex: 1 }}>
            <h2>{employee ? employee.name || 'A card with no name' : 'A month row'}</h2>
            <p>For {monthLabel(form.month)}{employee ? ` at ${money(structureTotal(employee))} a month` : ''}. These four numbers are the
              whole of what a month stores — lost days, arrears, a bonus, a recovery. Gross, provident fund, tax and take-home recompute from them.</p>
          </div>
          <button type="button" className="pr-notice-x" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="pr-fields">
          {num('Lost days', 'lop_days', 'Unpaid absence. Divided by the day basis the shop uses; it reduces every component.')}
          {num('Arrears', 'arrears', 'Salary owed for an earlier period, paid now. It is wages, so it carries tax.')}
          {num('Bonus', 'bonus', 'A one-off payment on top of the structure — taxable, and inside ESI wages.')}
          {num('Recovery', 'recovery', 'Anything taken from this month’s pay that is not a statutory deduction — a house loan, an advance.')}
          <div className="pr-field" style={{ gridColumn: '1 / -1' }}>
            <label htmlFor="pr-note">Note</label>
            <input id="pr-note" value={form.note} onChange={e => set('note', e.target.value)} placeholder="Why the month is unusual" />
          </div>
        </div>

        {findings.length > 0 && (
          <div className="pr-section">
            <ul className="pr-findings">
              {findings.map(f => (
                <li key={`${f.field}-${f.message}`} className={`pr-finding ${f.level === 'block' ? 'is-red' : 'is-amber'}`}>
                  <Icon name={f.level === 'block' ? 'alert' : 'compare'} size={14} />
                  <span><b>{f.field}</b> — {f.message}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="pr-modal-foot">
          <Button variant="primary" icon="check" disabled={blockers.length > 0} onClick={() => onSave(form)}>
            {blockers.length > 0 ? 'Fix the red findings first' : 'Record this month'}
          </Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          {onDelete && <Button variant="danger" icon="x" onClick={() => { onDelete(); onClose() }}>Remove the row</Button>}
        </div>
      </div>
    </div>
  )
}

export default function PayrollPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <PayrollPageInner />
    </Suspense>
  )
}
