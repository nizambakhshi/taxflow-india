'use client'

// Payslip — the sheet the register was always going to end up as.
//
// The salary register (src/lib/payroll.ts) computes a month and the month run shows it as a table on
// a screen. An employee does not want a row in somebody else's table: they want one sheet with their
// name on it, their allowance lines, what came off, what is payable, and a signature. This page is
// that sheet — and it is *only* that sheet. Every rupee on it is laid out by src/lib/payslip.ts from
// the engine's own reading of the month, so a slip can never disagree with the register it came from.
//
// Four things this page refuses to do:
//
//  * **It stores no figures.** The only thing typed here is the letterhead — the employer's name,
//    address, and the four codes a salary document is expected to carry. The rupees are recomputed on
//    every load, exactly as the register does.
//  * **It does not invent a code.** When the letterhead is blank the slip still prints, and prints a
//    dash beside each missing identifier with the sentence naming it. A statutory-looking document
//    carrying a made-up establishment code is worse than one carrying a dash.
//  * **It prints no figures it cannot compute.** A month the register refuses — nobody is paid a
//    salary of nothing — produces a sheet that says there is nothing to certify, with the engine's
//    reason on it. The deduction and employer blocks are not laid out at all.
//  * **The exceptions stay on this side of the paper.** The flags the register raises, the letterhead
//    gaps and the dashes it cannot name are printed beside the document, in a strip that does not
//    travel with it. An employee's copy carries its own facts; the owner reads the rest here first.
//
// Print and PDF are the same document: `#payslip-capture` is padded so its padding becomes the A4
// margin, and the whole month packs into one PDF with a sheet per person (src/lib/pdf-export.ts).

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { downloadElementAsPdf, downloadElementsAsPdf } from '@/lib/pdf-export'
import { Badge, Button, Card, EmptyState, PageHeader, Segmented } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  LETTERHEAD_IDENTIFIERS, currentMonth, emptyPayroll, fyMonths, fyStartOfMonth, letterheadIsEmpty, loadPayroll,
  monthLabel, monthsWithData, offRosterWhy, rosterFor, saveLetterhead,
  type Letterhead, type PayrollStore,
} from '@/lib/payroll'
import {
  inr, letterheadOf, monthPack, payslipFilename, payslipFor, periodWindow,
  LETTERHEAD_ORDER,
  type PackRefusal, type PayslipDoc, type PayslipPack, type SlipField, type SlipLine,
} from '@/lib/payslip'

type Mode = 'single' | 'month'

const MODES: { value: string; label: string }[] = [
  { value: 'single', label: 'One slip' },
  { value: 'month', label: 'The whole month' },
]

/** The employee-side identifiers a department would tie a slip to. Dashes here are worth a strip. */
const CARRIED_IDS = ['UAN', 'ESIC insurance number', 'PAN']

const BADGE_TONE = { red: 'red', amber: 'amber', grey: 'grey' } as const

const DASH = '—'

// ── the page ──────────────────────────────────────────────────────────────────

function PayslipPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [store, setStore] = useState<PayrollStore>(() => emptyPayroll(''))
  const [ready, setReady] = useState(false)
  const [month, setMonth] = useState(currentMonth())
  const [employeeId, setEmployeeId] = useState('')
  const [mode, setMode] = useState<Mode>('month')
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [showLetterhead, setShowLetterhead] = useState(false)
  const [downloading, setDownloading] = useState(false)

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

      const inboundMonth = searchParams.get('m')
      const inboundEmployee = searchParams.get('e')
      const inboundMode = searchParams.get('mode')

      if (inboundEmployee) {
        setEmployeeId(inboundEmployee)
        setMode('single')
      } else if (inboundMode === 'single' || inboundMode === 'month') {
        setMode(inboundMode)
      }

      if (inboundMonth && /^\d{4}-\d{2}$/.test(inboundMonth)) {
        setMonth(inboundMonth)
      } else {
        // Land on a month the shop has actually run, unless somebody is still on the rolls this month.
        const latest = monthsWithData(next)[0]
        if (latest && !next.employees.some(e => offRosterWhy(e, currentMonth()) === '')) setMonth(latest)
      }

      if (searchParams.get('letterhead') === '1') setShowLetterhead(true)
      setReady(true)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function flash(msg: string) { setNotice({ msg, bad: false }) }
  function warn(msg: string) { setNotice({ msg, bad: true }) }

  const roster = useMemo(() => rosterFor(store, month), [store, month])
  const months = useMemo(() => fyMonths(fyStartOfMonth(month)), [month])

  // In one-slip mode with no person in the URL, the first name on this month's rolls is the subject.
  const who = mode === 'single' ? (employeeId || roster.on[0]?.id || '') : ''
  const single = useMemo(
    () => (ready && mode === 'single' && who ? payslipFor(store, who, month, orgName) : null),
    [ready, mode, who, store, month, orgName],
  )
  const pack = useMemo(
    () => (ready && mode === 'month' ? monthPack(store, month, orgName) : null),
    [ready, mode, store, month, orgName],
  )

  const doc: PayslipDoc | null = single?.doc || null

  function goTo(nextMode: Mode, nextEmployee: string, nextMonth: string) {
    const e = nextMode === 'single' ? nextEmployee : ''
    setMode(nextMode)
    setEmployeeId(e)
    setMonth(nextMonth)
    const q = nextMode === 'single'
      ? `?e=${encodeURIComponent(e)}&m=${nextMonth}`
      : `?m=${nextMonth}&mode=month`
    router.replace(`/payroll/payslip${q}`, { scroll: false })
  }

  function changeMonth(next: string) {
    goTo(mode, mode === 'single' ? who : '', next)
  }
  function changePerson(next: string) {
    goTo('single', next, month)
  }
  function changeMode(next: string) {
    goTo(next as Mode, next === 'single' ? who : '', month)
  }

  const sheetIds = useMemo(() => (pack ? pack.docs.map((_, i) => `payslip-sheet-${i}`) : []), [pack])

  async function toPdf() {
    if (mode === 'month') {
      if (!pack || !pack.docs.length) { warn('Nothing in this month prints a slip yet — the letterhead or the salary cards need filling first.'); return }
      setDownloading(true)
      try {
        await downloadElementsAsPdf(sheetIds, `Payslips-${month}.pdf`)
        flash(`${pack.docs.length} slip${pack.docs.length === 1 ? '' : 's'} written into one A4 PDF, a sheet to a person.`)
      } catch (err) {
        console.error('PDF error:', err)
        alert('PDF download failed. Please print instead.')
      } finally {
        setDownloading(false)
      }
      return
    }
    if (!doc) return
    setDownloading(true)
    try {
      await downloadElementAsPdf('payslip-capture', payslipFilename(doc))
      flash(`${doc.employee_name} — ${doc.period_label} saved as ${payslipFilename(doc)}.`)
    } catch (err) {
      console.error('PDF error:', err)
      alert('PDF download failed. Please print instead.')
    } finally {
      setDownloading(false)
    }
  }

  function commitLetterhead(next: Letterhead) {
    setStore(saveLetterhead(orgId, next))
    setShowLetterhead(false)
    const missing = LETTERHEAD_IDENTIFIERS.filter(i => !next[i.key].trim()).length
    flash(missing
      ? `Letterhead saved. ${missing} of the four statutory codes ${missing === 1 ? 'is' : 'are'} still blank — the slips will print a dash and name it.`
      : 'Letterhead saved. Every slip now prints under the employer’s own name and codes.')
  }

  const lh = letterheadOf(store)
  const noPeople = ready && store.employees.length === 0

  const headerSubtitle = mode === 'month'
    ? (pack
      ? `${pack.docs.length} slip${pack.docs.length === 1 ? '' : 's'} for ${monthLabel(month)} · net payable ${inr(pack.totals.net_pay)} · the month costs ${inr(pack.totals.employer_cost)} all in`
      : `${monthLabel(month)} — every slip of the month, one sheet a person`)
    : (doc
      ? doc.printable
        ? `${doc.employee_name}${doc.code ? ` · ${doc.code}` : ''} · ${doc.period_label} · net payable ${inr(doc.net_pay)}`
        // A refused month has no net to state — the header says so instead of printing ₹0.00.
        : `${doc.employee_name}${doc.code ? ` · ${doc.code}` : ''} · ${doc.period_label} — the sheet carries no figures, only the reason`
      : single?.error || 'Choose a person and a month')

  // Paper only exists where there are figures: a refused month is readable on screen, not signable.
  const canPrint = mode === 'month'
    ? (pack?.docs.length ?? 0) > 0
    : !!doc?.printable
  const printWhy = mode === 'month'
    ? (pack?.docs.length ? '' : 'Nobody in this month has a slip to print yet.')
    : (doc?.printable ? '' : doc ? 'The register cannot compute this month, so there are no figures to sign.' : 'Choose a person with a computable month.')

  return (
    <div className="page-container" style={{ maxWidth: 1180 }}>
      <div className="no-print">
        <PageHeader
          eyebrow={`Payslip${orgName ? ` · ${orgName}` : ''}`}
          title="Payslip"
          subtitle={headerSubtitle}
          actions={<>
            <Button icon="printer" onClick={() => window.print()} disabled={!canPrint} title={printWhy}>Print</Button>
            <Button variant="primary" icon="download" onClick={toPdf} disabled={downloading || !canPrint} title={printWhy}>
              {downloading ? 'Writing PDF…' : mode === 'month' ? 'Download the month (PDF)' : 'Download PDF'}
            </Button>
          </>}
          right={
            <label className="ps-pick">
              <span>Month</span>
              <select className="ps-select" value={month} onChange={e => changeMonth(e.target.value)} aria-label="Month">
                {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
              </select>
            </label>
          }
        />

        <div className="ps-tools">
          <Segmented options={MODES} value={mode} onChange={changeMode} />
          {mode === 'single' && roster.on.length + roster.off.length > 0 && (
            <label className="ps-pick">
              <span>Person</span>
              <select className="ps-select" value={who} onChange={e => changePerson(e.target.value)} aria-label="Whose slip">
                {roster.on.length > 0 && (
                  <optgroup label={`On the rolls in ${monthLabel(month)}`}>
                    {roster.on.map(e => <option key={e.id} value={e.id}>{e.name}{e.code ? ` · ${e.code}` : ''}</option>)}
                  </optgroup>
                )}
                {roster.off.length > 0 && (
                  <optgroup label="Off the rolls">
                    {roster.off.map(o => <option key={o.employee.id} value={o.employee.id}>{o.employee.name}</option>)}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          <Button variant="ghost" size="sm" icon="edit" onClick={() => setShowLetterhead(true)}>Letterhead</Button>
          <Link href={`/payroll?tab=month&month=${month}`} className="ps-link">Month run</Link>
          <Link href="/payroll?tab=people" className="ps-link">Salary cards</Link>
        </div>

        {notice && (
          <div className={`ps-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
            <Icon name={notice.bad ? 'alert' : 'check'} size={15} />
            <span>{notice.msg}</span>
            <button type="button" className="ps-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss"><Icon name="x" size={15} /></button>
          </div>
        )}
      </div>

      {noPeople ? (
        <Card className="no-print">
          <EmptyState
            icon="users"
            title="Nobody on the payroll yet"
            message="A payslip is the paper a salary card turns into. Write the structure first — the six monthly components, the window, the provident-fund choice — and this page has a document to lay out."
            action={<Button variant="primary" icon="plus" href="/payroll?tab=people&new=1">Add a person</Button>}
          />
        </Card>
      ) : mode === 'month' ? (
        pack && <MonthView pack={pack} sheetIds={sheetIds} onLetterhead={() => setShowLetterhead(true)} />
      ) : single && !single.doc ? (
        <div className="no-print">
          <Card>
            <EmptyState
              icon="file-check"
              title="This month has no salary to certify"
              message={single.error}
              action={<Button variant="ghost" icon="users" href={`/payroll?tab=month&month=${month}`}>Open the month run</Button>}
            />
          </Card>
        </div>
      ) : doc ? (
        <SingleView doc={doc} onLetterhead={() => setShowLetterhead(true)} />
      ) : (
        <Card className="no-print"><p className="ps-hint">Pick a person to see their slip.</p></Card>
      )}

      {/* The letterhead editor floats over whichever view is open, so paper and codes never compete. */}
      {showLetterhead && (
        <LetterheadEditor initial={lh} onSave={commitLetterhead} onClose={() => setShowLetterhead(false)} />
      )}

      {/* Plain <style>, not styled-jsx: the sheet components below live in this file but the
          document must also survive the browser's own print pass. */}
      <style>{`
        .ps-tools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 1rem; }
        .ps-pick { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 650;
          letter-spacing: .04em; text-transform: uppercase; color: var(--faint); }
        .ps-select { font-family: inherit; font-size: 12.5px; text-transform: none; letter-spacing: 0;
          font-weight: 500; color: var(--ink-2); background: var(--surface); border: 1px solid var(--line);
          border-radius: 9px; padding: 7px 9px; max-width: 240px; }
        .ps-link { font-size: 12.5px; font-weight: 600; color: var(--brand); text-decoration: none; }
        .ps-link:hover { text-decoration: underline; }
        .ps-notice { display: flex; align-items: flex-start; gap: 9px; background: var(--green-soft); color: var(--green);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white); border-radius: 12px; padding: 10px 12px;
          margin-bottom: 1rem; font-size: 12.5px; line-height: 1.5; }
        .ps-notice.is-bad { background: var(--red-soft); color: var(--red); border-color: color-mix(in srgb, var(--red) 22%, white); }
        .ps-notice svg { flex-shrink: 0; margin-top: 2px; }
        .ps-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; min-height: 0; opacity: .7; }
        .ps-hint { font-size: 11.5px; color: var(--muted); line-height: 1.55; }

        /* ── the strip that stays on this side of the paper ── */
        .ps-brief { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ps-brief-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--amber);
          border-radius: 12px; padding: 11px 13px; }
        .ps-brief-card.is-ok { border-left-color: var(--green); }
        .ps-brief-card.is-flat { border-left-color: var(--line); }
        .ps-brief-title { display: flex; align-items: center; gap: 7px; font-size: 10.5px; font-weight: 700;
          letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); margin-bottom: 7px; }
        .ps-brief-list { list-style: none; display: flex; flex-direction: column; gap: 5px; }
        .ps-brief-list li { font-size: 11.5px; line-height: 1.5; color: var(--muted); }
        .ps-brief-list li strong { color: var(--ink-2); font-weight: 650; }
        .ps-brief-act { margin-top: 9px; }

        /* ── the month pack ── */
        .ps-pack-head { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          flex-wrap: wrap; margin-bottom: .8rem; }
        .ps-pack-figs { display: flex; gap: 16px; flex-wrap: wrap; }
        .ps-fig { display: flex; flex-direction: column; gap: 2px; }
        .ps-fig span:first-child { font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
        .ps-fig span:last-child { font-size: 15px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
        .ps-refused { display: flex; flex-direction: column; gap: 6px; margin: .2rem 0 1.1rem; }
        .ps-refused-item { display: flex; gap: 8px; align-items: flex-start; font-size: 11.5px; line-height: 1.5;
          color: var(--muted); background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; padding: 8px 11px; }
        .ps-refused-item svg { flex-shrink: 0; margin-top: 1px; color: var(--amber); }
        .ps-refused-item strong { color: var(--ink-2); font-weight: 650; }
        .ps-ask { background: none; border: none; padding: 0; font-family: inherit; font-size: inherit;
          color: var(--brand); font-weight: 650; cursor: pointer; text-decoration: underline; min-height: 0; }
        .ps-pack-note { font-size: 11.5px; color: var(--muted); line-height: 1.55; margin-bottom: 1rem; }

        /* ── the sheet ── */
        .ps-scroll { overflow-x: auto; }
        .ps-capture { background: var(--surface); padding: 22px; max-width: 794px; margin: 0 auto 18px; }
        .ps-sheet { border: 1px solid var(--line); padding: 24px 26px 20px; font-size: 11px; color: var(--ink);
          line-height: 1.45; font-variant-numeric: tabular-nums; }
        .ps-multi .ps-capture { border-top: 1px dashed var(--line); }

        .ps-lh { text-align: center; padding-bottom: 10px; border-bottom: 2px solid var(--ink); }
        .ps-lh-name { font-size: 17px; font-weight: 700; letter-spacing: .02em; }
        .ps-lh-name.is-empty { color: var(--faint); font-style: italic; font-weight: 600; }
        .ps-lh-addr { font-size: 10.5px; color: var(--ink-2); margin-top: 2px; }
        .ps-lh-contact { font-size: 10px; color: var(--muted); margin-top: 3px; }
        .ps-lh-note { font-size: 9.5px; color: var(--amber); margin-top: 3px; font-style: italic; }
        .ps-ids { display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; margin-top: 7px; }
        .ps-id { font-size: 9.5px; color: var(--muted); }
        .ps-id strong { color: var(--ink-2); font-weight: 650; }
        .ps-id.is-blank strong { color: var(--faint); }

        .ps-band { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          margin-top: 12px; }
        .ps-band-title { font-size: 12px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
        .ps-band-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 9.5px; color: var(--muted); }
        .ps-seq { font-size: 9px; color: var(--faint); }

        .ps-month-line { display: flex; gap: 14px; flex-wrap: wrap; font-size: 9.5px; color: var(--muted);
          background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 8px; padding: 6px 9px; margin-top: 8px; }
        .ps-prov { color: var(--ink-2); font-style: italic; flex: 1 1 100%; }

        .ps-who { display: grid; grid-template-columns: repeat(auto-fit, minmax(148px, 1fr)); gap: 6px 14px; margin-top: 12px; }
        .ps-f { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .ps-f-label { font-size: 8.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .ps-f-value { font-size: 11px; color: var(--ink); }
        .ps-f-value.is-blank { color: var(--faint); }

        .ps-money { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 14px; }
        .ps-col { min-width: 0; }
        .ps-col-head { display: flex; justify-content: space-between; gap: 8px; font-size: 9px; font-weight: 700;
          letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2);
          background: var(--slate-soft); border: 1px solid var(--line); padding: 5px 8px; }
        .ps-line { display: flex; justify-content: space-between; gap: 10px; padding: 5px 8px;
          border: 1px solid var(--line-soft); border-top: none; }
        .ps-line-main { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
        .ps-line-label { font-size: 10.5px; color: var(--ink); }
        .ps-line-basis { font-size: 8.5px; color: var(--faint); line-height: 1.4; }
        .ps-line-dash { font-size: 8.5px; color: var(--muted); font-style: italic; line-height: 1.45; }
        .ps-line-amt { font-size: 10.5px; font-weight: 600; white-space: nowrap; }
        .ps-line-amt.is-blank { color: var(--faint); font-weight: 500; }
        .ps-col-total { display: flex; justify-content: space-between; gap: 10px; padding: 6px 8px; margin-top: 3px;
          border-top: 1.5px solid var(--ink); font-size: 11px; font-weight: 700; }

        .ps-net { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap;
          background: var(--ink); color: white; border-radius: 8px; padding: 9px 12px; margin-top: 13px; }
        .ps-net-label { font-size: 9px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; opacity: .8; }
        .ps-net-amt { font-size: 17px; font-weight: 700; }
        .ps-net-right { text-align: right; min-width: 0; }
        .ps-net-words { font-size: 9.5px; font-style: italic; opacity: .9; }
        .ps-net-day { font-size: 9px; opacity: .75; margin-top: 2px; }

        .ps-emp { margin-top: 14px; border: 1px dashed var(--line); border-radius: 8px; padding: 9px 11px; background: var(--surface-2); }
        .ps-emp-head { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 9px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
        .ps-emp-sub { font-size: 8.5px; color: var(--faint); font-weight: 500; letter-spacing: 0; text-transform: none; margin-top: 2px; }
        .ps-emp-legs { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 3px 14px; margin-top: 7px; }
        .ps-emp-leg { display: flex; justify-content: space-between; gap: 8px; font-size: 9.5px; color: var(--ink-2); }
        .ps-emp-total { display: flex; justify-content: space-between; gap: 10px; margin-top: 7px; padding-top: 6px;
          border-top: 1px solid var(--line); font-size: 10.5px; font-weight: 700; }

        .ps-refuse { display: flex; gap: 9px; align-items: flex-start; margin-top: 14px; padding: 10px 12px;
          background: var(--red-soft); border: 1px solid color-mix(in srgb, var(--red) 25%, white); border-radius: 8px; }
        .ps-refuse svg { flex-shrink: 0; margin-top: 1px; color: var(--red); }
        .ps-refuse p { font-size: 10px; color: var(--red); line-height: 1.5; }
        .ps-refuse strong { display: block; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; margin-bottom: 3px; }

        .ps-fine { margin-top: 15px; }
        .ps-fine-title { font-size: 8.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); margin-bottom: 4px; }
        .ps-foot { list-style: decimal; padding-left: 15px; display: flex; flex-direction: column; gap: 3px; }
        .ps-foot li { font-size: 8.5px; color: var(--muted); line-height: 1.5; }
        .ps-bounds { list-style: none; display: flex; flex-direction: column; gap: 3px; }
        .ps-bounds li { font-size: 8.5px; color: var(--muted); line-height: 1.5; }

        .ps-sign { display: flex; justify-content: space-between; align-items: flex-end; gap: 14px; margin-top: 18px; }
        .ps-sign-place { font-size: 9.5px; color: var(--muted); }
        .ps-sign-right { text-align: center; min-width: 170px; }
        .ps-sign-for { font-size: 9.5px; color: var(--muted); margin-bottom: 20px; }
        .ps-sign-rule { border-top: 1px solid var(--ink); margin-bottom: 3px; }
        .ps-sign-name { font-size: 10px; font-weight: 650; }
        .ps-sign-role { font-size: 8.5px; color: var(--faint); }

        /* ── the letterhead editor ── */
        .ps-modal { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: grid; place-items: center;
          z-index: 120; padding: 16px; }
        .ps-modal-card { background: var(--surface); border: 1px solid var(--line); border-radius: 16px;
          width: min(760px, 100%); max-height: 92vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .ps-modal-head { display: flex; align-items: flex-start; gap: 10px; padding: 15px 16px 0; }
        .ps-modal-head h2 { margin: 0; font-size: 15px; color: var(--ink); }
        .ps-modal-head p { margin: 3px 0 0; font-size: 11.5px; color: var(--faint); line-height: 1.5; }
        .ps-modal-x { margin-left: auto; background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px; min-height: 0; }
        .ps-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 11px; padding: 14px 16px 0; }
        .ps-field { display: flex; flex-direction: column; gap: 4px; }
        .ps-field label { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); }
        .ps-field span { font-size: 10.5px; color: var(--faint); line-height: 1.45; }
        .ps-codes { margin: 14px 16px 0; background: var(--amber-soft); border: 1px solid color-mix(in srgb, var(--amber) 25%, white);
          border-radius: 12px; padding: 11px 13px; }
        .ps-codes-title { font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--amber); margin-bottom: 6px; }
        .ps-codes ul { list-style: none; display: flex; flex-direction: column; gap: 6px; }
        .ps-codes li { font-size: 11.5px; line-height: 1.5; color: var(--ink-2); }
        .ps-codes li strong { font-weight: 650; }
        .ps-modal-foot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 14px 16px 16px; }
        .ps-modal-hint { font-size: 11px; color: var(--faint); line-height: 1.5; flex: 1 1 220px; }

        @media (max-width: 720px) {
          .ps-money { grid-template-columns: 1fr; }
          .ps-capture { padding: 12px; }
          .ps-sheet { padding: 16px 14px 14px; }
          .ps-tools { gap: 8px; }
        }

        @media print {
          body { margin: 0 !important; background: white !important; }
          .no-print, .ps-modal, .ps-brief, .ps-pack-head, .ps-pack-note, .ps-refused, .ps-tools { display: none !important; }
          .page-container { padding: 0 !important; max-width: none !important; }
          .ps-scroll { overflow: visible !important; }
          .ps-capture { padding: 0 !important; margin: 0 !important; max-width: none !important; background: white !important; }
          .ps-sheet { border: none !important; padding: 0 !important; font-size: 10px !important; }
          .ps-multi .ps-capture { border-top: none !important; break-after: page; page-break-after: always; }
          .ps-multi .ps-capture:last-child { break-after: auto; page-break-after: auto; }
          @page { size: A4 portrait; margin: 15mm; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        }
      `}</style>
    </div>
  )
}

// ── one person's month ────────────────────────────────────────────────────────

function SingleView({ doc, onLetterhead }: {
  doc: PayslipDoc
  onLetterhead: () => void
}) {
  return (
    <>
      <Brief doc={doc} onLetterhead={onLetterhead} />
      <div className="ps-scroll">
        <Sheet doc={doc} captureId="payslip-capture" />
      </div>
    </>
  )
}

/**
 * The strip that does not travel with the paper: what the slip could not name, the month's own
 * exceptions, and the letterhead gaps. Reading it is the owner's job before handing the sheet over.
 */
function Brief({ doc, onLetterhead }: { doc: PayslipDoc; onLetterhead: () => void }) {
  const gaps = doc.identifiers.filter(f => !f.recorded)
  const carried = doc.employee_fields.filter(f => !f.recorded && CARRIED_IDS.includes(f.label))
  const unclaimed = doc.deductions.filter(l => l.amount === null)

  if (!gaps.length && !carried.length && !doc.flags.length && doc.name_from === 'letterhead' && !unclaimed.length) {
    return (
      <div className="ps-brief no-print">
        <div className="ps-brief-card is-ok">
          <div className="ps-brief-title"><Icon name="check" size={14} />Nothing stands between this slip and the employee</div>
          <ul className="ps-brief-list">
            <li>The letterhead is written, the identifiers a department would match are on the card, and the month raised no exception. <strong>Hand it over.</strong></li>
          </ul>
        </div>
      </div>
    )
  }

  return (
    <div className="ps-brief no-print">
      {(gaps.length > 0 || doc.name_from !== 'letterhead') && (
        <div className="ps-brief-card">
          <div className="ps-brief-title"><Icon name="alert" size={14} />The paper cannot name</div>
          <ul className="ps-brief-list">
            {doc.name_from === 'nothing' && <li><strong>No employer name.</strong> Neither a letterhead nor a workspace name — the sheet prints without an issuer.</li>}
            {doc.name_from === 'workspace' && <li>It prints under <strong>{doc.employer_name}</strong>, the workspace name. The payslip letterhead is its own.</li>}
            {gaps.map(f => <li key={f.label}><strong>{f.label}</strong> is blank — {f.why}</li>)}
          </ul>
          <div className="ps-brief-act"><Button size="sm" variant="ghost" icon="edit" onClick={onLetterhead}>Write the letterhead</Button></div>
        </div>
      )}

      {carried.length > 0 && (
        <div className="ps-brief-card">
          <div className="ps-brief-title"><Icon name="hash" size={14} />Missing from the salary card</div>
          <ul className="ps-brief-list">
            {carried.map(f => <li key={f.label}><strong>{f.label}</strong> — {f.why}</li>)}
          </ul>
        </div>
      )}

      {unclaimed.length > 0 && (
        <div className="ps-brief-card is-flat">
          <div className="ps-brief-title"><Icon name="compare" size={14} />Lines that print a dash</div>
          <ul className="ps-brief-list">
            {unclaimed.map(l => <li key={l.key}><strong>{l.label}</strong> — {l.dash}</li>)}
          </ul>
        </div>
      )}

      {doc.flags.length > 0 && (
        <div className="ps-brief-card">
          <div className="ps-brief-title"><Icon name="shield" size={14} />What the month flagged</div>
          <ul className="ps-brief-list">
            {doc.flags.map((f, i) => (
              <li key={`${f.field}-${i}`}><Badge tone={BADGE_TONE[f.tone]}>{f.field}</Badge> {f.text}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── the document itself ───────────────────────────────────────────────────────

function Sheet({ doc, captureId, seq }: { doc: PayslipDoc; captureId?: string; seq?: { n: number; of: number } }) {
  return (
    <div id={captureId} className="ps-capture">
      <article className="ps-sheet">
        <header className="ps-lh">
          {doc.employer_name
            ? <div className="ps-lh-name">{doc.employer_name}</div>
            : <div className="ps-lh-name is-empty">No employer name on the letterhead</div>}
          {doc.name_from === 'workspace' && (
            <div className="ps-lh-note">Issued under the workspace name — the payslip letterhead has not been written.</div>
          )}
          {doc.address_lines.map((line, i) => <div className="ps-lh-addr" key={i}>{line}</div>)}
          {doc.contact.some(c => c.recorded) && (
            <div className="ps-lh-contact">{doc.contact.filter(c => c.recorded).map(c => `${c.label} ${c.value}`).join('  ·  ')}</div>
          )}
          <div className="ps-ids">
            {doc.identifiers.map(f => (
              <span key={f.label} className={`ps-id ${f.recorded ? '' : 'is-blank'}`}>
                {f.label}: <strong>{f.recorded ? f.value : DASH}</strong>
              </span>
            ))}
          </div>
        </header>

        <div className="ps-band">
          <div className="ps-band-title">Payslip{doc.code ? ` — ${doc.code}` : ''}</div>
          <div className="ps-band-meta">
            <span>{doc.employee_name}{doc.role ? ` · ${doc.role}` : ''}</span>
            <span>{doc.period_label} · {doc.fy_label}</span>
            <span>{periodWindow(doc.month)}</span>
            <span>Computed {formatDateIN(doc.computed_on)}</span>
            {seq && <span className="ps-seq">Sheet {seq.n} of {seq.of}</span>}
          </div>
        </div>

        <div className="ps-month-line">
          <span>{doc.days_in_month} days in the month</span>
          <span>Salary divided on {doc.divisor_label}</span>
          <span>Loss of pay: {doc.lop_days === 0 ? 'none' : `${doc.lop_days} day${doc.lop_days === 1 ? '' : 's'}`}</span>
          {doc.attendance_from && <span className="ps-prov">{doc.attendance_from}</span>}
        </div>

        <div className="ps-who">
          {doc.employee_fields.map(f => <PersonField key={f.label} f={f} />)}
        </div>

        {doc.printable ? (
          <>
            <div className="ps-money">
              <MoneyColumn head="Earnings" lines={doc.earnings} totalLabel="Gross earnings" total={doc.earnings_total} />
              <MoneyColumn head="Deductions" lines={doc.deductions} totalLabel="Total deductions" total={doc.deduction_total} />
            </div>

            <div className="ps-net">
              <div>
                <div className="ps-net-label">Net payable</div>
                <div className="ps-net-amt">{inr(doc.net_pay)}</div>
              </div>
              <div className="ps-net-right">
                <div className="ps-net-words">{doc.net_words}</div>
                <div className="ps-net-day">{doc.pay_day_line}</div>
              </div>
            </div>

            {doc.employer_legs.length > 0 && (
              <div className="ps-emp">
                <div className="ps-emp-head">
                  <span>What the employer pays besides this salary</span>
                  <span>{inr(doc.employer_legs_total)}</span>
                </div>
                <div className="ps-emp-sub">Nothing here was taken off the net payable above — it is the employer’s own cost of keeping the person on the rolls.</div>
                <div className="ps-emp-legs">
                  {doc.employer_legs.map(l => (
                    <div className="ps-emp-leg" key={l.key}><span>{l.label}</span><span>{inr(l.amount)}</span></div>
                  ))}
                </div>
                <div className="ps-emp-total">
                  <span>The month, all in — this salary plus the legs above</span>
                  <span>{inr(doc.employer_cost)}</span>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="ps-refuse">
            <Icon name="alert" size={16} />
            <p>
              <strong>No figures to certify</strong>
              {doc.refuse_why || 'The register cannot compute this month, so no salary figure is stated on this sheet.'}
            </p>
          </div>
        )}

        <div className="ps-fine">
          <div className="ps-fine-title">The month, as the register read it</div>
          <ol className="ps-foot">
            {doc.footnotes.map((n, i) => <li key={i}>{n}</li>)}
          </ol>
        </div>

        <div className="ps-fine">
          <div className="ps-fine-title">What this document is</div>
          <ul className="ps-bounds">
            {doc.boundaries.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        </div>

        <footer className="ps-sign">
          <div className="ps-sign-place">Place: {doc.place || DASH}</div>
          <div className="ps-sign-right">
            <div className="ps-sign-for">For {doc.employer_name || 'the employer'}</div>
            <div className="ps-sign-rule" />
            <div className="ps-sign-name">{doc.signatory || DASH}</div>
            {doc.signatory_role && <div className="ps-sign-role">{doc.signatory_role}</div>}
          </div>
        </footer>
      </article>
    </div>
  )
}

function PersonField({ f }: { f: SlipField }) {
  return (
    <div className="ps-f">
      <div className="ps-f-label">{f.label}</div>
      <div className={`ps-f-value ${f.recorded ? '' : 'is-blank'}`}>{f.recorded ? f.value : DASH}</div>
    </div>
  )
}

/**
 * One column of the slip. A line whose amount is `null` prints a dash and the sentence naming the
 * absence — a dashed professional tax is not a claim of ₹0, and the paper has to say so.
 */
function MoneyColumn({ head, lines, totalLabel, total }: {
  head: string
  lines: SlipLine[]
  totalLabel: string
  total: number
}) {
  return (
    <div className="ps-col">
      <div className="ps-col-head"><span>{head}</span><span>Amount</span></div>
      {lines.length === 0 && (
        <div className="ps-line">
          <div className="ps-line-main"><div className="ps-line-basis">Nothing in this column for the month.</div></div>
        </div>
      )}
      {lines.map(l => (
        <div className="ps-line" key={l.key}>
          <div className="ps-line-main">
            <div className="ps-line-label">{l.label}</div>
            {l.amount === null ? <div className="ps-line-dash">{l.dash}</div> : (l.basis ? <div className="ps-line-basis">{l.basis}</div> : null)}
          </div>
          <div className={`ps-line-amt ${l.amount === null ? 'is-blank' : ''}`}>{inr(l.amount)}</div>
        </div>
      ))}
      <div className="ps-col-total"><span>{totalLabel}</span><span>{inr(total)}</span></div>
    </div>
  )
}

// ── the whole month, one sheet a person ───────────────────────────────────────

function MonthView({ pack, sheetIds, onLetterhead }: {
  pack: PayslipPack
  sheetIds: string[]
  onLetterhead: () => void
}) {
  return (
    <>
      <div className="ps-pack-head no-print">
        <div className="ps-pack-figs">
          <div className="ps-fig"><span>Slips</span><span>{pack.totals.employees}</span></div>
          <div className="ps-fig"><span>Gross earnings</span><span>{inr(pack.totals.gross)}</span></div>
          <div className="ps-fig"><span>Deductions</span><span>{inr(pack.totals.deductions)}</span></div>
          <div className="ps-fig"><span>Net payable</span><span>{inr(pack.totals.net_pay)}</span></div>
          <div className="ps-fig"><span>The month costs</span><span>{inr(pack.totals.employer_cost)}</span></div>
        </div>
        {pack.partial && <Badge tone="amber">{pack.refused.length} get no paper</Badge>}
      </div>

      {pack.docs.length === 0 ? (
        <Card className="no-print">
          <EmptyState
            icon="file-check"
            title={`Nothing in ${pack.period_label} prints a slip`}
            message="A slip needs a salary structure on the card and a month the register can compute. What is missing is listed under the totals."
            action={<Button variant="primary" icon="users" href="/payroll?tab=people">Open the salary cards</Button>}
          />
        </Card>
      ) : (
        <p className="ps-pack-note no-print">
          {pack.docs.length} sheet{pack.docs.length === 1 ? '' : 's'} below, in the order the register runs the month —
          the costliest first. Print or download the set; each person starts on a fresh A4 page.
          {pack.partial && ' Everybody listed underneath it gets no paper this month, so this is not the complete set.'}
        </p>
      )}

      {pack.refused.length > 0 && (
        <div className="ps-refused no-print">
          {pack.refused.map((r: PackRefusal) => (
            <div className="ps-refused-item" key={r.employee_id}>
              <Icon name="alert" size={14} />
              <span><strong>{r.name}</strong> — {r.why}</span>
            </div>
          ))}
        </div>
      )}

      {letterheadGapsInPack(pack) && (
        <div className="ps-refused no-print">
          <div className="ps-refused-item">
            <Icon name="edit" size={14} />
            <span>
              <strong>The letterhead has no codes</strong> — every sheet prints a dash in their place, and the gap is the same on all of them.{' '}
              <button type="button" className="ps-ask" onClick={onLetterhead}>Write the letterhead once</button> and every slip in the month changes with it.
            </span>
          </div>
        </div>
      )}

      <div className="ps-scroll ps-multi">
        {pack.docs.map((doc, i) => (
          <Sheet key={doc.employee_id} doc={doc} captureId={sheetIds[i]} seq={{ n: i + 1, of: pack.docs.length }} />
        ))}
      </div>
    </>
  )
}

/** Does the pack need the letterhead? One sheet's gaps are every sheet's gaps. */
function letterheadGapsInPack(pack: PayslipPack): boolean {
  return pack.docs.some(d => d.letterhead_gaps.length > 0 || d.name_from !== 'letterhead')
}

// ── the letterhead ────────────────────────────────────────────────────────────

function LetterheadEditor({ initial, onSave, onClose }: {
  initial: Letterhead
  onSave: (l: Letterhead) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState<Letterhead>({ ...initial })
  const blank = letterheadIsEmpty(draft)
  const set = (key: keyof Letterhead, value: string) => setDraft(d => ({ ...d, [key]: value }))

  return (
    <div className="ps-modal" role="dialog" aria-modal="true" aria-label="Payslip letterhead">
      <div className="ps-modal-card">
        <div className="ps-modal-head">
          <div>
            <h2>Payslip letterhead</h2>
            <p>The name, address and codes a slip prints under. Nothing here moves a rupee — it is the paper the register writes its figures onto.</p>
          </div>
          <button type="button" className="ps-modal-x" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
        </div>

        <div className="ps-codes">
          <div className="ps-codes-title">The four codes a salary document is asked to carry</div>
          <ul>
            {LETTERHEAD_IDENTIFIERS.map(i => (
              <li key={i.key}>
                <strong>{i.label}</strong> — {i.why}
                {draft[i.key].trim() ? ` Recorded: ${draft[i.key].trim()}` : ' This register does not have one, and will not make one up.'}
              </li>
            ))}
          </ul>
        </div>

        <div className="ps-fields">
          {LETTERHEAD_ORDER.map(f => (
            <div className="ps-field" key={f.key}>
              <label htmlFor={`lh-${f.key}`}>{f.label}</label>
              <input
                id={`lh-${f.key}`}
                className="tf-input"
                type="text"
                value={draft[f.key]}
                onChange={e => set(f.key, e.target.value)}
                placeholder={f.hint ? '' : f.label}
                autoComplete="off"
              />
              {f.hint && <span>{f.hint}</span>}
            </div>
          ))}
        </div>

        <div className="ps-modal-foot">
          <Button variant="ghost" onClick={onClose}>Do not save</Button>
          <Button icon="check" onClick={() => onSave(draft)}>{blank ? 'Save it blank' : 'Save the letterhead'}</Button>
          <span className="ps-modal-hint">
            {blank
              ? 'A blank letterhead is allowed: the slip prints under the workspace name, dashes where a code belongs, and names every gap beside the document.'
              : 'Saved in this browser with the register. Every slip already on screen re-reads it on the next load.'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ── wrapper ───────────────────────────────────────────────────────────────────

export default function PayslipPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <PayslipPageInner />
    </Suspense>
  )
}
