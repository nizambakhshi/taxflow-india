'use client'

// The filings register — what was told to the department, period by period, and what is being done
// about the paper that missed the window.
//
// The calendar at /gst/calendar answers "what is due". The workpaper at /gst/gstr9 answers "what did
// the year say, against what the books hold". Neither answers the two questions a department actually
// asks: *when did each period go in, was it late, what did it state* — and *what happened to the
// invoice GSTR-1 missed*. This page is where those two answers live.
//
// The engine (src/lib/filings.ts) owns the model: one row per form per tax period, a snapshotted due
// date with its provenance, a late-fee estimate built from the slab that applies to this shop, an
// amendment board that reads each correction against the window still able to carry it, and the two
// bars rule 59(6) can already be read from these rows. Everything lives in this browser under
// `taxflow:filings:<orgId>` (ADR-013), and joins the vault the same round it was created (Rule 31).
//
// Five boundaries are printed on the screen rather than left to be assumed:
//
//  * **A row is a transcript, not a posting.** The figures are what the return stated. Nothing in
//    `ledger.ts` reads this register — correcting a filed return does not move the balance sheet by a
//    rupee; that is what a journal entry at /journal is for, and the two stay deliberately apart.
//  * **The due date is copied, then audited.** Each row keeps the date it was written against and why
//    the shop replaced it. On top of that the engine re-derives the date from the rule text, and every
//    disagreement between the app's calendar and the rule is printed as drift (Rule 29) — the findings
//    card is the first thing on this page.
//  * **Judgement sits beside the number, never inside it.** The late-fee estimate prints the
//    notification that decided the ceiling and section 50's interest as separate sentences (Rule 33),
//    against what the shop says it actually paid.
//  * **This register does not speak to the portal.** No GSP feed, no ARN verification — a reference is
//    stored exactly as written and the page says so. It files nothing and pays nothing, so a row here
//    cannot discharge the liability on /gst/gstr3b.
//  * **The seal is read, not asked.** A filing record moves no rupee on the statements, so R3-1's door
//    is not a door on this register — it shows a sealed period as closed paper and offers "seal this
//    period" through /audit's own `sealPeriod`. Every status change does write one line to that trail.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import { INDIAN_STATES } from '@/lib/constants'
import { monthlyBooks, headsOf, type Heads, type OutwardDoc } from '@/lib/gstr9'
import { generateEvents } from '@/lib/compliance'
import { fyLabel, fyStartYear } from '@/lib/targets'
import { loadAudit, todayISO } from '@/lib/audit'
import {
  AMENDMENT_CSV_HEADERS, AMENDMENT_KINDS, AMENDMENT_META, AMENDMENT_STATUS_META, CADENCES, CADENCE_META,
  BOUNDARY, DEFAULT_FILINGS_SETTINGS, FILINGS_CSV_HEADERS, FILINGS_VERSION, FORMS, FORM_META,
  NOT_TRACKED, STATE_META, URGENCY_META, VARIANCE_CSV_HEADERS, VARIANCE_META,
  addAmendment, amendmentBoard, amendmentCsvRows, calendarObjections, calendarTicks, consequencesFor,
  crossCheck, daysLate, declaredVsBooks, deleteAmendment, deleteFiling, estimateLateFee, exposureOf,
  filingsCsvRows, loadFilings, openAmendmentsFor, periodFyStart, periodLabel, pickDue, STATUS_META,
  profileFor, qrmpCategory, recordFiling, registerRows, registerStats, saveFilingsSettings,
  sealFilingsPeriod, untrackedRows, varianceCsvRows, windowsFor,
  type Amendment, type AmendmentDraft, type AmendmentKind, type AmendmentStatus, type BoardRow,
  type Cadence, type FilingDraft, type FilingForm, type FilingStatus, type FilingsSettings,
  type FilingsStore, type RegisterRow, type VarianceRow,
} from '@/lib/filings'
import {
  Badge, Button, Card, EmptyState, PageHeader, SearchInput, SectionTitle, Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

type Tab = 'returns' | 'amendments' | 'variance'

const TABS: { value: Tab; label: string }[] = [
  { value: 'returns', label: 'Returns — the history' },
  { value: 'amendments', label: 'Amendments — the windows' },
  { value: 'variance', label: 'Return vs books' },
]

const inr2 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 })
const money = (v: number) => {
  const n = Number.isFinite(v) ? v : 0
  return n < 0 ? `− ${inr2.format(-n)}` : inr2.format(n)
}
/** A signed rupee says its own direction in words — never a bare minus the reader decodes (Rule 28). */
const signed = (v: number) => `${v < 0 ? 'reduces ' : 'adds '}${money(Math.abs(v))}`
const pctOrEmpty = (v: number) => (v > 0 ? money(v) : '—')

const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** A `**bold**` sentence from the engine's own boundary list, split for rendering. */
function rich(text: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
    part.startsWith('**') && part.endsWith('**')
      ? <strong key={i}>{part.slice(2, -2)}</strong>
      : <span key={i}>{part}</span>
  ))
}

function emptyComposer(form: FilingForm = 'gstr3b', year = ''): Composer {
  return {
    form, pYear: year, pMonth: '', pQuarter: '', status: 'filed',
    due: '', dueReason: '', filedOn: '', reference: '',
    taxable: '', igst: '', cgst: '', sgst: '', cess: '',
    taxPaidOn: '', lateFeePaid: '', interestPaid: '', unpaidIntimation: '',
    notes: '', actor: '',
  }
}

function emptyAmendComposer(period = '', kind: AmendmentKind = 'invoice_omitted', today = ''): AmendComposer {
  return {
    period, kind, docRef: '', party: '', effect: 'add', taxable: '', tax: '',
    foundOn: today, status: 'open', carriedIn: '', notes: '',
  }
}

/** What the composer holds while it is being typed: rupees stay strings, the engine never sees them. */
interface Composer {
  id?: string
  form: FilingForm
  pYear: string
  pMonth: string
  pQuarter: string
  status: FilingStatus
  due: string
  dueReason: string
  filedOn: string
  reference: string
  taxable: string
  igst: string
  cgst: string
  sgst: string
  cess: string
  taxPaidOn: string
  lateFeePaid: string
  interestPaid: string
  unpaidIntimation: string
  notes: string
  actor: string
}

interface AmendComposer {
  id?: string
  period: string
  kind: AmendmentKind
  docRef: string
  party: string
  effect: 'add' | 'reduce'
  taxable: string
  tax: string
  foundOn: string
  status: AmendmentStatus
  carriedIn: string
  notes: string
}

/** The period a composer is describing, from whichever picker that form's cadence allows. */
function derivePeriod(c: Composer): string {
  const kinds = FORM_META[c.form].cadence
  if (!c.pYear) return ''
  if (kinds.includes('month') && c.pMonth) return `${c.pYear}-${c.pMonth}`
  if (kinds.includes('quarter') && c.pQuarter) return `${c.pYear}-Q${c.pQuarter}`
  if (kinds.includes('quarter')) return ''
  if (kinds.includes('year')) return c.pYear
  return ''
}

function composerToDraft(c: Composer, period: string): FilingDraft {
  return {
    id: c.id, form: c.form, period, status: c.status,
    due: c.due || undefined, due_reason: c.dueReason || undefined,
    filed_on: c.filedOn || undefined, reference: c.reference || undefined,
    taxable: c.taxable || 0, igst: c.igst || 0, cgst: c.cgst || 0, sgst: c.sgst || 0, cess: c.cess || 0,
    tax_paid_on: c.taxPaidOn || undefined,
    late_fee_paid: c.lateFeePaid || 0, interest_paid: c.interestPaid || 0,
    unpaid_intimation: c.unpaidIntimation || 0,
    notes: c.notes || undefined, actor: c.actor || undefined,
  }
}

export default function FilingsPage() {
  return (
    <Suspense fallback={<div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Opening the register…</div>}>
      <FilingsPageInner />
    </Suspense>
  )
}

function FilingsPageInner() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const searchParams = useSearchParams()

  const today = useMemo(() => todayISO(), [])
  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [shopGstin, setShopGstin] = useState('')
  const [shopState, setShopState] = useState('')

  const [store, setStore] = useState<FilingsStore>({
    version: FILINGS_VERSION, orgId: '', updatedAt: '',
    settings: { ...DEFAULT_FILINGS_SETTINGS }, filings: [], amendments: [],
  })
  const [auditVersion, setAuditVersion] = useState(0)
  // The workpaper's own figures: the outward documents of the year, read the way /gst/gstr9 reads them.
  const [docs, setDocs] = useState<OutwardDoc[]>([])

  const [fyStart, setFyStart] = useState(() => fyStartYear(new Date()))
  const [tab, setTab] = useState<Tab>('returns')
  const [search, setSearch] = useSearchDeepLink()
  const [onlyAttention, setOnlyAttention] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({})

  const [composer, setComposer] = useState<Composer | null>(null)
  const [composerErrors, setComposerErrors] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const [amend, setAmend] = useState<AmendComposer | null>(null)
  const [amendErrors, setAmendErrors] = useState<string[]>([])
  const [focusPeriod, setFocusPeriod] = useState('')

  const [removing, setRemoving] = useState<{ row: RegisterRow; mode: 'withdraw' | 'delete'; reason: string } | null>(null)

  /* ── load: the shop, the register, the year's documents ── */

  useEffect(() => {
    async function boot() {
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
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')
      setStore(loadFilings(oid))

      const { data: reg } = await supabase
        .from('gst_registrations')
        .select('gstin, state_code')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      setShopGstin(reg?.gstin || '')
      setShopState(reg?.state_code || '')

      const t = searchParams.get('tab')
      if (t === 'returns' || t === 'amendments' || t === 'variance') setTab(t)
      const p = searchParams.get('period')
      if (p) setFocusPeriod(p)
      // The palette's two entry points: a row to record, or the card that names the shop's cadence.
      // Both open over the loaded register, so the deep link arrives at a page that already knows the
      // year — an empty composer would print a due date with nothing beside it.
      if (searchParams.get('new') === '1') openComposer()
      if (searchParams.get('settings') === '1') setSettingsOpen(true)

      await loadYear(oid, fyStart)
      setLoading(false)
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadYear(oid: string, year: number) {
    const [invRes, cnRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, customer_gstin, place_of_supply, supply_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('invoice_date', `${year}-04-01`).lte('invoice_date', `${year + 1}-03-31`).limit(5000),
      supabase.from('credit_notes')
        .select('id, credit_note_number, credit_note_date, customer_name, customer_gstin, place_of_supply, supply_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, grand_total')
        .eq('organization_id', oid).neq('status', 'cancelled')
        .gte('credit_note_date', `${year}-04-01`).lte('credit_note_date', `${year + 1}-03-31`).limit(2000),
    ])
    const rows = [
      ...((invRes.data || []) as Record<string, unknown>[]).map(r => toDoc(r, 'invoice', 'invoice_number', 'invoice_date', 'customer_name', 'customer_gstin')),
      ...((cnRes.data || []) as Record<string, unknown>[]).map(r => toDoc(r, 'credit_note', 'credit_note_number', 'credit_note_date', 'customer_name', 'customer_gstin')),
    ]
    setDocs(rows)
  }

  function changeFy(next: number) {
    setFyStart(next)
    setNotice(null)
    loadYear(orgId, next)
  }

  /* ── derived: the whole workpaper, computed the way the engine means it to be ── */

  const settings = store.settings
  const events = useMemo(
    // The calendar's own rows for this year and cadence — the register copies a date from them, then
    // checks them against the rule text.
    () => generateForYear(fyStart, settings),
    [fyStart, settings],
  )
  // Both are read off another register's key, so they are re-read when `auditVersion` moves — a seal
  // written from this page has to change the badge on the row it closes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const audit = useMemo(() => (orgId ? loadAudit(orgId) : null), [orgId, auditVersion])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statuses = useMemo(() => (orgId ? calendarTicks(orgId) : {}), [orgId, auditVersion])

  const rows = useMemo(
    () => registerRows(store, { fyStart, today, events, audit }),
    [store, fyStart, today, events, audit],
  )
  const board = useMemo(
    () => amendmentBoard(store, { today, knownDocs: docs.map(d => d.number) }),
    [store, today, docs],
  )
  const stats = useMemo(() => registerStats(rows, board), [rows, board])
  const exposure = useMemo(() => exposureOf(rows), [rows])
  const untracked = useMemo(() => untrackedRows(fyStart, settings, events), [fyStart, settings, events])
  const objections = useMemo(() => calendarObjections(fyStart, settings, events), [fyStart, settings, events])
  const checks = useMemo(() => crossCheck(rows, statuses), [rows, statuses])

  const booksByMonth = useMemo(() => {
    const map: Record<string, Heads> = {}
    for (const b of monthlyBooks(docs, [], fyStart)) map[b.month] = b.outward
    return map
  }, [docs, fyStart])
  const variance = useMemo(
    () => declaredVsBooks(store, booksByMonth, fyStart, settings),
    [store, booksByMonth, fyStart, settings],
  )

  const listed = useMemo(() => rows.filter(r => (
    (!onlyAttention || needsAttention(r))
    && matchesAny(search, [
      FORM_META[r.form].label, r.periodLabel, r.due, STATE_META[r.state].label, r.dueNote, r.drift,
      r.record?.filed_on, r.record?.reference, r.record?.notes, r.record?.actor,
    ])
  )), [rows, search, onlyAttention])
  const listedBoard = useMemo(() => board.filter(b => matchesAny(search, [
    periodLabel(b.amendment.period), AMENDMENT_META[b.amendment.kind].label, b.amendment.doc_ref,
    b.amendment.party, b.amendment.carried_in, b.amendment.notes, b.amendment.actor,
    AMENDMENT_STATUS_META[b.amendment.status].label, URGENCY_META[b.urgency].label,
  ])), [board, search])
  const listedVariance = useMemo(() => variance.filter(v => matchesAny(search, [
    FORM_META[v.form].label, v.periodLabel, VARIANCE_META[v.status].label, ...v.heads,
  ])), [variance, search])

  // The period whose three clocks are printed at the top of the amendments tab.
  const focus = useMemo(() => {
    if (focusPeriod) return focusPeriod
    const open = board.find(b => b.amendment.status === 'open')
    if (open) return open.amendment.period
    const month = rows.filter(r => r.periodKind === 'month').slice(-1)[0]
    return month?.period ?? ''
  }, [focusPeriod, board, rows])
  const focusWindows = useMemo(() => (focus ? windowsFor(store, focus, today) : null), [focus, store, today])

  /* ── actions ── */

  function say(msg: string, bad = false) {
    setNotice({ msg, bad })
  }

  function openComposer(row?: RegisterRow, asNew = false) {
    if (row && !asNew && row.record) {
      const r = row.record
      const y = r.period.slice(0, 4)
      setComposer({
        id: r.id, form: r.form, pYear: y,
        pMonth: r.period_kind === 'month' ? r.period.slice(5, 7) : '',
        pQuarter: r.period_kind === 'quarter' ? r.period.slice(6) : '',
        status: r.status, due: r.due, dueReason: r.due_reason, filedOn: r.filed_on, reference: r.reference,
        taxable: r.heads.taxable ? String(r.heads.taxable) : '', igst: r.heads.igst ? String(r.heads.igst) : '',
        cgst: r.heads.cgst ? String(r.heads.cgst) : '', sgst: r.heads.sgst ? String(r.heads.sgst) : '',
        cess: r.heads.cess ? String(r.heads.cess) : '',
        taxPaidOn: r.tax_paid_on, lateFeePaid: r.late_fee_paid ? String(r.late_fee_paid) : '',
        interestPaid: r.interest_paid ? String(r.interest_paid) : '',
        unpaidIntimation: r.unpaid_intimation ? String(r.unpaid_intimation) : '',
        notes: r.notes, actor: r.actor || settings.actor,
      })
    } else {
      const form = row?.form ?? 'gstr3b'
      const period = row?.period ?? ''
      setComposer({
        ...emptyComposer(form, period.slice(0, 4) || String(fyStart)),
        pMonth: period.length === 7 ? period.slice(5, 7) : '',
        pQuarter: period.includes('-Q') ? period.slice(6) : '',
        actor: settings.actor,
      })
    }
    setComposerErrors([])
    setSaving(false)
  }

  function saveComposer() {
    if (!composer || !orgId) return
    const period = derivePeriod(composer)
    const payload = composerToDraft(composer, period)
    setSaving(true)
    const result = recordFiling(orgId, payload, today, events)
    if (!result.ok) {
      setComposerErrors(result.problems)
      setSaving(false)
      return
    }
    setStore(result.store)
    setAuditVersion(v => v + 1)
    setComposer(null)
    setComposerErrors([])
    setSaving(false)
    say(result.trail
      ? `${result.trail} The line went to the audit trail at /audit.`
      : `${FORM_META[result.record!.form].label} for ${periodLabel(result.record!.period)} updated.`)
  }

  function openAmend(period = '', kind: AmendmentKind = 'invoice_omitted') {
    setAmend({ ...emptyAmendComposer(period || focus, kind), foundOn: today })
    setAmendErrors([])
    if (period) setFocusPeriod(period)
  }

  function saveAmend() {
    if (!amend || !orgId) return
    const draft: AmendmentDraft = {
      id: amend.id, period: amend.period, kind: amend.kind,
      doc_ref: amend.docRef, party: amend.party, effect: amend.effect,
      taxable: amend.taxable || 0, tax: amend.tax || 0,
      found_on: amend.foundOn || undefined, status: amend.status,
      carried_in: amend.carriedIn, notes: amend.notes, actor: settings.actor,
    }
    const result = addAmendment(orgId, draft, today)
    if (!result.ok) { setAmendErrors(result.problems); return }
    setStore(result.store)
    setAuditVersion(v => v + 1)
    setAmend(null)
    setAmendErrors([])
    say(`Amendment on ${periodLabel(result.amendment!.period)} is on the board. Its window is computed from the returns already recorded.`)
  }

  function markAmend(a: Amendment, status: AmendmentStatus) {
    if (!orgId) return
    const draft: AmendmentDraft = {
      id: a.id, period: a.period, kind: a.kind, doc_ref: a.doc_ref, party: a.party,
      effect: a.effect, taxable: a.taxable, tax: a.tax, found_on: a.found_on, status,
      carried_in: a.carried_in, notes: a.notes, actor: a.actor,
    }
    if (status === 'carried' && !a.carried_in.trim()) {
      // The engine asks which return carried it; the page routes the question to the composer instead
      // of guessing a return the shop never named.
      openAmend(a.period, a.kind)
      setAmend(c => (c ? { ...c, id: a.id, status: 'carried' } : c))
      setAmendErrors(['Say which return carried it — the GSTR-1A, the Table 9A of a GSTR-9, or the 3B that finally took the credit.'])
      return
    }
    const result = addAmendment(orgId, draft, today)
    if (!result.ok) { setAmendErrors(result.problems); setAmend({ ...emptyAmendComposer(a.period, a.kind, today), id: a.id, status }); return }
    setStore(result.store)
    setAuditVersion(v => v + 1)
    say(`Amendment on ${periodLabel(a.period)} marked ${AMENDMENT_STATUS_META[status].label.toLowerCase()}.`)
  }

  function removeAmend(a: Amendment) {
    if (!orgId) return
    const result = deleteAmendment(orgId, a.id)
    if (!result.ok) { say(result.why, true); return }
    setStore(result.store)
    say(result.why || `Amendment on ${periodLabel(a.period)} removed from the board.`)
  }

  async function runRemoval() {
    if (!removing || !orgId) return
    const row = removing.row
    const reason = removing.reason.trim()
    if (removing.mode === 'withdraw') {
      const r = row.record
      if (!r) return
      const result = recordFiling(orgId, {
        form: r.form, period: r.period, status: 'not_filed',
        due: r.due || undefined, due_reason: r.due_reason || undefined,
        taxable: r.heads.taxable, igst: r.heads.igst, cgst: r.heads.cgst, sgst: r.heads.sgst, cess: r.heads.cess,
        notes: reason || 'set back to not filed', actor: r.actor,
      }, today, events)
      if (!result.ok) { say(result.problems[0] ?? 'The row could not be withdrawn.', true); return }
      setStore(result.store)
      setAuditVersion(v => v + 1)
      setRemoving(null)
      say(result.trail || `${FORM_META[r.form].label} for ${periodLabel(r.period)} is back to not filed.`)
      return
    }
    const id = row.record?.id
    if (!id) { say('There is no row of this period on the register to remove.', true); return }
    const result = deleteFiling(orgId, id, reason)
    if (!result.ok) { say(result.why, true); return }
    setStore(result.store)
    setAuditVersion(v => v + 1)
    setRemoving(null)
    say(result.trail || `${FORM_META[row.form].label} for ${periodLabel(row.period)} removed from the register.`)
  }

  function sealRow(row: RegisterRow) {
    if (!orgId) return
    const result = sealFilingsPeriod(orgId, row.period, `Sealed from the filings register after ${FORM_META[row.form].label} for ${periodLabel(row.period)} was settled.`, settings.actor, today)
    setAuditVersion(v => v + 1)
    if (!result.result.ok) say(result.result.why, true)
    else say(`${result.label} is sealed at /audit. Nothing that moves a rupee may be dated inside it.`)
  }

  function patchSettings(patch: Partial<FilingsSettings>) {
    if (!orgId) return
    setStore(saveFilingsSettings(orgId, patch))
  }

  function useRegistration() {
    if (!shopGstin) { say('This device has no primary GSTIN on file — the state cannot be read from a registration that is not here.', true); return }
    patchSettings({ gstin: shopGstin, stateCode: shopState })
    say(`Registration taken from gst_registrations: ${shopGstin}${shopState ? ` (state ${shopState})` : ''}. Rule 61(1)(ii)'s category is now checked automatically.`)
  }

  function exportTab() {
    if (tab === 'returns') {
      download(`Filings-${fyLabel(fyStart)}.csv`, toCsv(FILINGS_CSV_HEADERS, filingsCsvRows(rows)))
      return
    }
    if (tab === 'amendments') {
      download(`Amendments-${fyLabel(fyStart)}.csv`, toCsv(AMENDMENT_CSV_HEADERS, amendmentCsvRows(board)))
      return
    }
    download(`Declared-vs-books-${fyLabel(fyStart)}.csv`, toCsv(VARIANCE_CSV_HEADERS, varianceCsvRows(variance)))
  }

  /* ── render ── */

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Opening the register…</div>
  }

  const findings = [
    { n: stats.blocked, label: 'row(s) the chain shuts', detail: 'rule 59(6) — the previous period is not in, or an 88C(1) intimation stands unpaid', bad: true },
    { n: stats.overdue, label: 'return(s) past their date', detail: 'measured against the date each row carries', bad: true },
    { n: stats.late, label: 'filed late', detail: 'filed after the date the row was written against', bad: false },
    { n: stats.drift, label: 'row(s) where the calendar and the rule disagree', detail: 'the app\'s own date against the date the rule text states', bad: true },
    { n: checks.length, label: 'tick(s) the two lists do not agree about', detail: '/gst/calendar and this register, on the same return', bad: true },
    { n: stats.lapsedAmendments, label: 'amendment(s) with no window left', detail: 'section 16(4), the proviso to rule 59(1), or the annual return', bad: true },
    { n: board.filter(b => b.dangling).length, label: 'amendment(s) naming a document the books do not hold', detail: 'matched against this year\'s invoices and credit notes', bad: false },
    { n: objections.length, label: 'objection(s) to what the calendar asks', detail: 'where the rules say something different for this shop', bad: false },
  ].filter(f => f.n > 0)

  return (
    <div className="page-container fg">
      <PageHeader
        eyebrow="Filing history & amendment tracking"
        title={orgName || 'Filings register'}
        subtitle={
          <>
            One row per return per tax period — the date it was due and where that date came from, what the
            return stated, what a delay costs under the slab that applies, and what is being done about the
            paper that missed the window.
            {' '}<Badge tone={fyStart === fyStartYear(new Date()) ? 'amber' : 'green'} dot={false}>
              {fyStart === fyStartYear(new Date()) ? 'year still running' : 'year closed'}
            </Badge>
          </>
        }
        actions={
          <>
            <select className="fg-select" value={fyStart} onChange={e => changeFy(Number(e.target.value))} aria-label="Financial year">
              {yearOptions().map(y => <option key={y} value={y}>{fyLabel(y)}</option>)}
            </select>
            <Button variant="ghost" size="sm" icon={settingsOpen ? 'x' : 'settings'} onClick={() => setSettingsOpen(v => !v)}>
              {settingsOpen ? 'Close' : 'Cadence & slabs'}
            </Button>
            <Button variant="primary" size="sm" icon="plus" onClick={() => openComposer(undefined, true)}>Record a return</Button>
          </>
        }
      />

      {notice && (
        <div className={`fg-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} />
          <span>{notice.msg}</span>
          <button type="button" className="fg-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss the notice"><Icon name="x" size={13} /></button>
        </div>
      )}

      {settingsOpen && (
        <Card pad={false} className="fg-card">
          <div className="fg-set-head">
            <SectionTitle icon="settings">How this register reads the rules</SectionTitle>
            <p className="fg-set-blurb">
              Nothing below changes a row. It changes which date the rule states, which late-fee ceiling
              applies, and which return the year is reconciled against.
            </p>
          </div>
          <div className="fg-fields">
            <label className="fg-field">
              <span>Filing cadence</span>
              <Segmented
                value={settings.cadence}
                onChange={v => patchSettings({ cadence: v as Cadence })}
                options={CADENCES.map(c => ({ value: c, label: CADENCE_META[c].label }))}
              />
              <small>{CADENCE_META[settings.cadence].why}</small>
            </label>
            <label className="fg-field">
              <span>Principal place of business — two digits of the GSTIN</span>
              <select className="fg-select" value={settings.stateCode} onChange={e => patchSettings({ stateCode: e.target.value })}>
                <option value="">Not stated</option>
                {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
              </select>
              <small>
                {settings.cadence !== 'qrmp'
                  ? 'Only a QRMP filer is split by state: rule 61(1)(ii) puts the summary return on the twenty-second or twenty-fourth day by the state.'
                  : (() => {
                    const cat = qrmpCategory(settings.stateCode)
                    return cat
                      ? `${cat.state} sits in the ${cat.day === 22 ? 'twenty-second' : 'twenty-fourth'} day row — ${cat.cited}.`
                      : 'Without a state the register cannot say which of rule 61(1)(ii)\'s two days applies, so those rows print as unchecked rather than guessed.'
                  })()}
              </small>
              {shopGstin && !settings.stateCode && (
                <Button variant="subtle" size="sm" icon="target" onClick={useRegistration}>
                  {`Take the shop's registration (${shopGstin})`}
                </Button>
              )}
            </label>
            <label className="fg-field">
              <span>Turnover of the preceding financial year</span>
              <input className="fg-input" type="number" min={0} step={100000} value={settings.precedingFyTurnover || ''}
                placeholder="₹ of the last completed year"
                onChange={e => patchSettings({ precedingFyTurnover: Math.max(0, Number(e.target.value) || 0) })} />
              <small>The key Notifications No. 19 and 20/2021-Central Tax, dated 01.06.2021 cut the GSTR-1 and 3B ceiling by — ₹2,000 up to ₹1.5 crore, ₹5,000 up to ₹5 crore, ₹10,000 above it.</small>
            </label>
            <label className="fg-field">
              <span>Turnover in this State or Union territory</span>
              <input className="fg-input" type="number" min={0} step={100000} value={settings.stateTurnover || ''}
                placeholder="₹ in this State/UT"
                onChange={e => patchSettings({ stateTurnover: Math.max(0, Number(e.target.value) || 0) })} />
              <small>The key for GSTR-9&apos;s own table under Notification No. 07/2023-Central Tax, dated 31.03.2023: the ceiling is a percentage of this figure, not a flat ₹.</small>
            </label>
            <label className="fg-field">
              <span>Who writes these rows</span>
              <input className="fg-input" type="text" value={settings.actor} placeholder="A name the trail can attribute"
                onChange={e => patchSettings({ actor: e.target.value })} />
              <small>Carried onto each row and each audit line as the actor.</small>
            </label>
            <label className="fg-field fg-field-check">
              <span>Does the year need an audit?</span>
              <label className="fg-checkbox">
                <input type="checkbox" checked={settings.taxAudit} onChange={e => patchSettings({ taxAudit: e.target.checked })} />
                Turnover above ₹5 crore — GSTR-9C goes with the annual return
              </label>
              <small>section 35(5) with rule 80. The register prints the reminder on a GSTR-9 row; the certificate itself is not this app&apos;s to hold.</small>
            </label>
          </div>
          <p className="fg-set-foot">
            Saved on this device under <code>taxflow:filings:{orgId.slice(0, 8)}…</code>{store.updatedAt ? ` · last written ${new Date(store.updatedAt).toLocaleString('en-IN')}` : ''}
          </p>
        </Card>
      )}

      {findings.length > 0 && (
        <Card pad={false} className="fg-card">
          <SectionTitle icon="alert">What this register is finding — printed, not corrected</SectionTitle>
          <ul className="fg-findings">
            {findings.map(f => (
              <li key={f.label} className={f.bad ? 'is-bad' : ''}>
                <strong>{f.n}</strong>
                <span>{f.label} — {f.detail}</span>
              </li>
            ))}
          </ul>
          <p className="fg-finding-foot">
            Every one of these is printed as the rules state it. Nothing here silently re-dates a row, clears a
            tick, or drops an amendment whose window has shut.
          </p>
        </Card>
      )}

      <div className="fg-stats">
        <StatCard label="Rows on the register" value={String(store.filings.length)} sub={`${stats.total} expected this year, ${stats.open} still open`} icon="file-check" tone="blue" />
        <StatCard label="Filed on time" value={String(stats.filed - stats.late)} sub={`${stats.nil} of them nil, ${stats.late} late`} icon="check" tone="green" />
        <StatCard label="Open amendments" value={String(stats.openAmendments)} sub={`${stats.lapsedAmendments} already lapsed`} icon="undo" tone="amber" />
        <StatCard label="At risk on this year" value={money(exposure.total)} sub={`${exposure.periods} period(s) past their date — see the breakdown below`} icon="wallet" tone={exposure.total > 0 ? 'red' : 'grey'} />
      </div>

      <div className="fg-toolbar">
        <Segmented value={tab} onChange={v => setTab(v as Tab)} options={TABS.map(t => ({ value: t.value, label: t.label }))} />
        <SearchInput value={search} onChange={setSearch} placeholder="Form, period, ARN, note…" ariaLabel="Search the register" />
        <div className="fg-tools">
          <label className="fg-opt">
            <input type="checkbox" checked={onlyAttention} onChange={e => setOnlyAttention(e.target.checked)} />
            Needs attention only
          </label>
          <Button variant="ghost" size="sm" icon="download" onClick={exportTab}>Export this tab</Button>
        </div>
      </div>

      {tab === 'returns' && (
        <>
          {checks.length > 0 && (
            <Card pad={false} className="fg-card">
              <SectionTitle icon="compare">The two lists disagree</SectionTitle>
              <ul className="fg-checks">
                {checks.map(c => (
                  <li key={c.eventId}>
                    <strong>{c.label}</strong>
                    <span>{c.note}</span>
                    <Link href="/gst/calendar">Open the calendar</Link>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {objections.length > 0 && (
            <Card pad={false} className="fg-card">
              <SectionTitle icon="scale">Where the calendar asks something the rules do not</SectionTitle>
              <ul className="fg-objs">
                {objections.map(o => (
                  <li key={o.title}>
                    <Badge tone={o.severity === 'warn' ? 'amber' : 'blue'}>{URGENCY_LABEL[o.severity]}</Badge>
                    <div>
                      <strong>{o.title}</strong>
                      <p>{o.why}</p>
                      <small>{o.citation}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="fg-grid">
            <div className="fg-panel">
              <div className="fg-head fg-row">
                <span>Return</span><span>Period</span><span>Due, and where that date came from</span>
                <span>State</span><span>As the return stated</span><span>If it ran late</span><span />
              </div>
              {listed.length === 0 ? (
                <EmptyState
                  icon="file-check"
                  title={rows.length ? 'Nothing matches what you typed' : 'No rows for this year'}
                  message={rows.length
                    ? 'Clear the search, or switch the attention filter off.'
                    : 'The register builds its rows from the cadence above. Choose a year, or record a return the calendar does not expect.'}
                  action={<Button variant="ghost" size="sm" icon="plus" onClick={() => openComposer(undefined, true)}>Record a return</Button>}
                />
              ) : (
                <div className="fg-rows">
                  {listed.map(r => (
                    <FilingRow
                      key={r.key}
                      row={r}
                      open={!!openRows[r.key]}
                      onToggle={() => setOpenRows(o => ({ ...o, [r.key]: !o[r.key] }))}
                      onEdit={() => openComposer(r, !!r.record)}
                      onNew={() => openComposer(r, true)}
                      onRemove={() => setRemoving({ row: r, mode: r.record ? 'withdraw' : 'delete', reason: '' })}
                      onAmend={() => openAmend(r.period)}
                      onSeal={() => sealRow(r)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="fg-side">
              {untracked.length > 0 && (
                <Card pad={false}>
                  <SectionTitle icon="calendar">GST paper the calendar carries that this register does not</SectionTitle>
                  <ul className="fg-untracked">
                    {untracked.map(u => (
                      <li key={`${u.form}${u.due}`}>
                        <strong>{u.form}</strong>
                        <span>{u.title} · {formatDateIN(u.due)}</span>
                        <p>{u.why}</p>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}

              <Card pad={false}>
                <SectionTitle icon="wallet">What is at risk, and on what</SectionTitle>
                <div className="fg-exposure">
                  <StatRow label="Late fee still owed across the year" value={pctOrEmpty(exposure.fee)} tone={exposure.fee > 0 ? 'red' : 'grey'} strong />
                  <StatRow label="Interest under section 50" value={pctOrEmpty(exposure.interest)} tone={exposure.interest > 0 ? 'amber' : 'grey'} />
                  <StatRow label="Periods past their date" value={String(exposure.periods)} />
                  <StatRow label="Rows already sealed" value={String(stats.sealed)} tone={stats.sealed > 0 ? 'green' : 'grey'} />
                </div>
                <p className="fg-side-note">
                  Each figure is the slab that applies to this shop, and every one of them carries its own
                  sentence naming the notification or the section it came from. Paid amounts are subtracted,
                  not merged: a row says what the rule estimates and what you wrote you paid.
                </p>
              </Card>

              <Card pad={false}>
                <SectionTitle icon="book">What this register is not</SectionTitle>
                <ul className="fg-not">
                  {NOT_TRACKED.map(t => (
                    <li key={t.title}>
                      <strong>{t.title}</strong>
                      <p>{t.why}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </div>

          <Card pad={false} className="fg-card">
            <SectionTitle icon="shield">The rules this register keeps</SectionTitle>
            <ul className="fg-boundary">
              {BOUNDARY.map(b => <li key={b}>{rich(b)}</li>)}
            </ul>
            <div className="fg-links">
              <Link href="/gst/calendar">Compliance calendar — what is due</Link>
              <Link href="/gst/gstr9">GSTR-9 / 9C workpaper — the year against the books</Link>
              <Link href="/audit">Audit trail & period seals</Link>
              <Link href="/journal">Manual journal — the register that does move a rupee</Link>
              <Link href="/vault">Books vault — this register backs up as one key</Link>
            </div>
          </Card>
        </>
      )}

      {tab === 'amendments' && (
        <>
          {focus && focusWindows && (
            <Card pad={false} className="fg-card">
              <div className="fg-clock-head">
                <SectionTitle icon="clock">The three clocks, for {periodLabel(focus)}</SectionTitle>
                <div className="fg-clock-pick">
                  <select className="fg-select" value={focus} onChange={e => setFocusPeriod(e.target.value)} aria-label="Period whose windows are printed">
                    {periodChoices(rows).map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
                  </select>
                  <Button variant="ghost" size="sm" icon="undo" onClick={() => openAmend(focus)}>Log an amendment</Button>
                </div>
              </div>
              <div className="fg-clocks">
                <ClockCard title="GSTR-1A" w={focusWindows.gstr1a} note="opens after the period's GSTR-1, shuts when its GSTR-3B goes in" />
                <ClockCard title="Table 9A of the annual return" w={focusWindows.table9a} note="stays open until GSTR-9 for the year is furnished" />
                <ClockCard title="The recipient's credit" w={focusWindows.itc} note="section 16(4) — 30 November after the year, or the annual return, whichever is earlier" />
              </div>
            </Card>
          )}

          <div className="fg-grid">
            <div className="fg-panel">
              <div className="fg-head fg-amend-head">
                <span>Period</span><span>What was missed</span><span>Document</span><span>Effect</span>
                <span>Window</span><span>Status</span><span />
              </div>
              {listedBoard.length === 0 ? (
                <EmptyState
                  icon="undo"
                  title={board.length ? 'Nothing matches what you typed' : 'No amendments on the board'}
                  message={board.length
                    ? 'Clear the search to see the whole board.'
                    : 'An amendment is a piece of paper the return as filed did not carry — an invoice GSTR-1 missed, a note never reported, credit found late. Each one is dated against the window that can still take it.'}
                  action={<Button variant="ghost" size="sm" icon="plus" onClick={() => openAmend()}>Log an amendment</Button>}
                />
              ) : (
                <div className="fg-rows">
                  {listedBoard.map(b => (
                    <AmendRow
                      key={b.amendment.id}
                      board={b}
                      open={!!openRows[`a:${b.amendment.id}`]}
                      onToggle={() => setOpenRows(o => ({ ...o, [`a:${b.amendment.id}`]: !o[`a:${b.amendment.id}`] }))}
                      onEdit={() => { setAmend({ ...amendComposerFrom(b.amendment) }); setAmendErrors([]) }}
                      onCarry={() => markAmend(b.amendment, 'carried')}
                      onLapse={() => markAmend(b.amendment, 'lapsed')}
                      onReopen={() => markAmend(b.amendment, 'open')}
                      onDelete={() => removeAmend(b.amendment)}
                    />
                  ))}
                </div>
              )}
              <div className="fg-addbar">
                <Button variant="ghost" size="sm" icon="plus" onClick={() => openAmend()}>Log an amendment</Button>
                <p className="fg-addbar-hint">
                  The board keeps a correction whose windows have all shut and prints it as lapsed — a
                  correction nobody can make is a finding, not a task.
                </p>
              </div>
            </div>

            <div className="fg-side">
              <Card pad={false}>
                <SectionTitle icon="list">The routes a correction actually takes</SectionTitle>
                <ul className="fg-kinds">
                  {AMENDMENT_KINDS.map(k => (
                    <li key={k}>
                      <strong>{AMENDMENT_META[k].label}</strong>
                      <p>{AMENDMENT_META[k].where}</p>
                      <small>{AMENDMENT_META[k].basis}</small>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card pad={false}>
                <SectionTitle icon="scan">Dangling documents</SectionTitle>
                {board.filter(b => b.dangling).length === 0 ? (
                  <p className="fg-side-note">
                    {docs.length
                      ? `Every amendment names a document found among this year's ${docs.length} outward paper(s) on this device.`
                      : 'No outward documents are loaded for this year, so the board cannot say whether an amendment names a real document. It still prints the reference exactly as written.'}
                  </p>
                ) : (
                  <ul className="fg-dangling">
                    {board.filter(b => b.dangling).map(b => (
                      <li key={b.amendment.id}>
                        <strong>{b.amendment.doc_ref}</strong>
                        <span>{periodLabel(b.amendment.period)} · {AMENDMENT_META[b.amendment.kind].label} · {signed(b.amendment.effect === 'reduce' ? -b.amendment.taxable : b.amendment.taxable)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="fg-side-note">
                  Matched against the invoices and credit notes this device holds for FY {fyLabel(fyStart)}.
                  A reference found on nothing is printed as such, never dropped — this register never talks to
                  the portal, so it cannot know what the department holds.
                </p>
              </Card>
            </div>
          </div>
        </>
      )}

      {tab === 'variance' && (
        <div className="fg-grid">
          <div className="fg-panel">
            <div className="fg-head fg-var-head">
              <span>Return</span><span>Period</span><span>What it stated</span><span>What the books hold</span>
              <span>Difference</span><span>Result</span>
            </div>
            {listedVariance.length === 0 ? (
              <EmptyState
                icon="compare"
                title={variance.length ? 'Nothing matches what you typed' : 'Nothing to compare yet'}
                message={variance.length
                  ? 'Clear the search.'
                  : `A comparison needs a row recorded as filed with figures, and this device's outward documents for FY ${fyLabel(fyStart)}. The books side is read from invoices and credit notes, exactly the way /gst/gstr9 reads them.`}
                action={<Button variant="ghost" size="sm" icon="plus" onClick={() => openComposer(undefined, true)}>Record a return</Button>}
              />
            ) : (
              <div className="fg-rows">
                {listedVariance.map(v => <VarianceRowView key={`${v.form}${v.period}`} v={v} />)}
              </div>
            )}
          </div>
          <div className="fg-side">
            <Card pad={false}>
              <SectionTitle icon="scale">How a difference is decided</SectionTitle>
              <p className="fg-side-note">
                Books minus what the return stated, head by head, inside the ₹1 tolerance the 9C reconciliation
                itself uses. A taxable difference means the return said less than the shop&apos;s own documents hold —
                the direction matters, so it is written in words, not as a sign.
              </p>
              <p className="fg-side-note">
                Quarters are compared against the three months they cover; a year against its twelve. Where the
                books hold nothing for a period, the row says so instead of calling it a variance.
              </p>
              <div className="fg-links fg-links-stack">
                <Link href="/gst/gstr9">GSTR-9 / 9C — the year drawn the same way</Link>
                <Link href="/gst/filings?tab=amendments">The amendment board — where a difference becomes paper</Link>
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ── the return composer ── */}
      {composer && (
        <ComposerForm
          composer={composer}
          setComposer={setComposer}
          errors={composerErrors}
          saving={saving}
          settings={settings}
          store={store}
          period={derivePeriod(composer)}
          today={today}
          onSave={saveComposer}
          onClose={() => { setComposer(null); setComposerErrors([]) }}
        />
      )}

      {/* ── the amendment composer ── */}
      {amend && (
        <AmendForm
          amend={amend}
          setAmend={setAmend}
          errors={amendErrors}
          store={store}
          today={today}
          knownCount={docs.length}
          onSave={saveAmend}
          onClose={() => { setAmend(null); setAmendErrors([]) }}
        />
      )}

      {/* ── withdrawal / removal ── */}
      {removing && (
        <div className="fg-scrim" role="dialog" aria-modal="true" aria-label="Remove a row from the register" onClick={() => setRemoving(null)}>
          <div className="fg-modal" onClick={e => e.stopPropagation()}>
            <div className="fg-modal-head">
              <h3>{FORM_META[removing.row.form].label} · {periodLabel(removing.row.period)}</h3>
              <button type="button" className="fg-notice-x" onClick={() => setRemoving(null)} aria-label="Close"><Icon name="x" size={14} /></button>
            </div>
            <p className="fg-modal-blurb">
              A row that was recorded as filed is a record of what the shop said to the department. It can be
              withdrawn — put back to not filed, with the reason on the audit trail — or removed outright.
              Removing one that amendments still point at is refused, because a correction belonging to no
              return is not a record.
            </p>
            {openAmendmentsFor(store, removing.row.period).length > 0 && (
              <div className="fg-warn">
                <Icon name="alert" size={14} />
                {openAmendmentsFor(store, removing.row.period).length} open amendment(s) name {periodLabel(removing.row.period)}.
                Close or re-date them first — {removing.mode === 'delete' ? 'this removal will be refused until they are.' : 'withdrawing the row leaves them answering nothing.'}
              </div>
            )}
            <label className="fg-field">
              <span>Why the row is being withdrawn or removed</span>
              <textarea className="fg-textarea" rows={3} value={removing.reason} placeholder="The ARN was wrong; the return went in for a different period; the portal voided it…"
                onChange={e => setRemoving(r => (r ? { ...r, reason: e.target.value } : r))} />
              <small>It goes to the audit trail at /audit as the reason, and the trail cannot be edited afterwards.</small>
            </label>
            <div className="fg-modal-foot">
              <span className="fg-mode">
                {removing.mode === 'withdraw' ? 'Set back to not filed' : 'Remove the row'} — the reason goes to /audit either way.
              </span>
              <Button variant="ghost" size="sm" onClick={() => setRemoving(null)}>Leave it alone</Button>
              <Button
                variant="subtle"
                size="sm"
                icon="undo"
                disabled={!removing.row.record || removing.row.record.status === 'not_filed'}
                onClick={() => setRemoving(r => (r ? { ...r, mode: 'withdraw' } : r))}
              >
                Set back to not filed
              </Button>
              <Button
                variant="danger"
                size="sm"
                icon="x"
                disabled={!removing.row.record}
                onClick={() => setRemoving(r => (r ? { ...r, mode: 'delete' } : r))}
              >
                Remove the row
              </Button>
              <Button
                variant={removing.mode === 'delete' ? 'danger' : 'primary'}
                size="sm"
                icon="check"
                disabled={!removing.row.record}
                onClick={runRemoval}
              >
                {removing.mode === 'delete' ? 'Confirm removal' : 'Confirm withdrawal'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .fg { display: flex; flex-direction: column; gap: 14px; }
        .fg-card { margin-top: 2px; }
        .fg-select, .fg-input, .fg-textarea {
          font: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface);
          border: 1px solid var(--line); border-radius: 9px; padding: 7px 9px;
        }
        .fg-textarea { width: 100%; resize: vertical; }
        .fg-input { min-width: 0; }
        .fg-notice { display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border-radius: 11px;
          background: var(--green-soft); color: var(--green); font-size: 12.5px; line-height: 1.55; }
        .fg-notice.is-bad { background: var(--red-soft); color: var(--red); }
        .fg-notice-x { margin-left: auto; background: none; border: 0; cursor: pointer; color: inherit; padding: 2px; }

        .fg-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
        .fg-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
        .fg-tools { display: flex; align-items: center; gap: 12px; margin-left: auto; flex-wrap: wrap; }
        .fg-opt { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; color: var(--ink-2); }
        .fg-opt input { accent-color: var(--brand); }

        .fg-findings { list-style: none; margin: 8px 0 0; padding: 0; display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 16px; }
        .fg-findings li { display: flex; gap: 9px; align-items: baseline; font-size: 12px; color: var(--ink-2); line-height: 1.55; }
        .fg-findings li strong { font-size: 14px; min-width: 20px; color: var(--amber); font-variant-numeric: tabular-nums; }
        .fg-findings li.is-bad strong { color: var(--red); }
        .fg-finding-foot { margin: 12px 0 0; padding-top: 10px; border-top: 1px solid var(--line);
          font-size: 11.5px; color: var(--muted); line-height: 1.6; }

        .fg-checks, .fg-objs, .fg-untracked, .fg-not, .fg-kinds, .fg-dangling, .fg-boundary {
          list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
        .fg-checks li { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--ink-2); line-height: 1.55;
          padding-bottom: 9px; border-bottom: 1px dashed var(--line); }
        .fg-checks li:last-child { border-bottom: 0; padding-bottom: 0; }
        .fg-checks strong { color: var(--ink); font-size: 12.5px; }
        .fg-checks a { color: var(--brand); font-size: 11.5px; text-decoration: none; }
        .fg-objs li { display: flex; gap: 10px; align-items: flex-start; }
        .fg-objs strong { display: block; font-size: 12.5px; color: var(--ink); }
        .fg-objs p { margin: 3px 0 0; font-size: 12px; color: var(--ink-2); line-height: 1.55; }
        .fg-objs small { display: block; margin-top: 4px; font-size: 11px; color: var(--faint); font-style: italic; }
        .fg-untracked strong { font-size: 12.5px; color: var(--ink); }
        .fg-untracked span { display: block; font-size: 11.5px; color: var(--muted); }
        .fg-untracked p { margin: 3px 0 0; font-size: 11.5px; color: var(--ink-2); line-height: 1.55; }
        .fg-not strong { display: block; font-size: 12.5px; color: var(--ink); }
        .fg-not p { margin: 3px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.55; }
        .fg-kinds strong { display: block; font-size: 12.5px; color: var(--ink); }
        .fg-kinds p { margin: 2px 0 0; font-size: 11.5px; color: var(--ink-2); }
        .fg-kinds small { display: block; margin-top: 3px; font-size: 10.5px; color: var(--faint); font-style: italic; }
        .fg-dangling li { display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
        .fg-dangling strong { color: var(--red); font-variant-numeric: tabular-nums; }
        .fg-dangling span { color: var(--muted); font-size: 11.5px; }
        .fg-boundary li { font-size: 12px; color: var(--ink-2); line-height: 1.65; }
        .fg-boundary strong { color: var(--ink); }

        .fg-grid { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 14px; align-items: start; }
        .fg-panel { border: 1px solid var(--line); border-radius: 14px; background: var(--surface); overflow: hidden; }
        .fg-side { display: flex; flex-direction: column; gap: 14px; }
        .fg-side-note { margin: 10px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
        .fg-exposure { display: flex; flex-direction: column; gap: 2px; }

        .fg-head, .fg-row { display: grid; grid-template-columns: 118px 118px minmax(0, 1.4fr) 132px minmax(0, 1fr) minmax(0, 1fr) 190px;
          gap: 10px; align-items: center; padding: 9px 14px; }
        .fg-head { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint); background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .fg-amend-head { grid-template-columns: 108px minmax(0, 1.25fr) minmax(0, .95fr) 132px minmax(0, 1fr) 122px 170px; }
        .fg-var-head { grid-template-columns: 108px 118px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.05fr) 130px; }
        .fg-rows { display: flex; flex-direction: column; }
        .fg-row { border-bottom: 1px solid var(--line); }
        .fg-row:last-child { border-bottom: 0; }
        .fg-row.is-blocked { background: var(--red-soft); }
        .fg-row.is-record { background: var(--surface-2); }

        .fg-form { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
        .fg-form strong { font-size: 13px; color: var(--ink); }
        .fg-form small { display: block; font-size: 10.5px; color: var(--faint); }
        .fg-period { font-size: 12.5px; color: var(--ink-2); }
        .fg-due { font-size: 12.5px; color: var(--ink); }
        .fg-due small { display: block; font-size: 10.5px; color: var(--faint); line-height: 1.5; margin-top: 2px; }
        .fg-due .is-drift { color: var(--amber); }
        .fg-stated { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 1.55; }
        .fg-cost { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 1.55; }
        .fg-cost strong { color: var(--red); }
        .fg-actions { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
        .fg-toggle { display: inline-flex; align-items: center; justify-content: center; width: 20px; height: 20px;
          border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--muted); cursor: pointer; padding: 0; }

        .fg-detail { padding: 4px 14px 16px; display: flex; flex-direction: column; gap: 12px;
          background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .fg-detail-block { border: 1px solid var(--line); border-radius: 11px; background: var(--surface); padding: 10px 12px; }
        .fg-detail-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .fg-detail p { margin: 6px 0 0; font-size: 12px; color: var(--ink-2); line-height: 1.6; }
        .fg-detail .is-cite { font-size: 11px; color: var(--faint); font-style: italic; }
        .fg-heads { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; margin-top: 8px; }
        .fg-heads div span { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--faint); }
        .fg-heads div strong { display: block; font-size: 12.5px; color: var(--ink); font-variant-numeric: tabular-nums; }
        .fg-costs { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
        .fg-costs li { list-style: none; font-size: 11.5px; color: var(--ink-2); line-height: 1.55;
          padding-left: 14px; position: relative; }
        .fg-costs li::before { content: ''; position: absolute; left: 0; top: 7px; width: 6px; height: 6px;
          border-radius: 999px; background: var(--amber); }
        .fg-costs ul { margin: 0; padding: 0; }
        .fg-cons { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
        .fg-cons-item { border-left: 3px solid var(--amber); padding: 7px 10px; background: var(--surface-2); border-radius: 0 9px 9px 0; }
        .fg-cons-item.is-block { border-left-color: var(--red); }
        .fg-cons-item.is-info { border-left-color: var(--brand); }
        .fg-cons-item strong { display: block; font-size: 12px; color: var(--ink); }
        .fg-cons-item p { margin: 3px 0 0; font-size: 11.5px; color: var(--ink-2); }
        .fg-cons-item a { font-size: 11px; color: var(--brand); text-decoration: none; }
        .fg-history { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; }
        .fg-history li { list-style: none; font-size: 11px; color: var(--muted); display: flex; gap: 8px; }
        .fg-history time { color: var(--faint); font-variant-numeric: tabular-nums; min-width: 78px; }

        .fg-clocks { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 10px; }
        .fg-clock { border: 1px solid var(--line); border-radius: 12px; padding: 11px 12px; background: var(--surface-2); }
        .fg-clock.is-open { border-color: var(--brand); }
        .fg-clock.is-gov { border-color: var(--violet); box-shadow: inset 0 0 0 1px var(--violet); }
        .fg-clock.is-shut { opacity: 0.86; }
        .fg-clock h4 { margin: 0; font-size: 12.5px; color: var(--ink); display: flex; align-items: center; gap: 6px; }
        .fg-clock .left { font-size: 19px; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; margin-top: 6px; }
        .fg-clock p { margin: 4px 0 0; font-size: 11.5px; color: var(--ink-2); line-height: 1.55; }
        .fg-clock small { display: block; margin-top: 6px; font-size: 10.5px; color: var(--faint); font-style: italic; line-height: 1.5; }
        .fg-clock-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
        .fg-clock-pick { display: flex; align-items: center; gap: 8px; }

        .fg-amend { display: grid; grid-template-columns: 108px minmax(0, 1.25fr) minmax(0, .95fr) 132px minmax(0, 1fr) 122px 170px;
          gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
        .fg-amend.is-lapsed { background: var(--surface-2); }
        .fg-amend.is-act { background: var(--red-soft); }
        .fg-doc { font-size: 12.5px; color: var(--ink); font-variant-numeric: tabular-nums; }
        .fg-doc small { display: block; font-size: 11px; color: var(--faint); }
        .fg-doc .is-dangling { color: var(--red); }
        .fg-effect { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 1.5; }
        .fg-window { font-size: 11.5px; color: var(--ink-2); line-height: 1.5; }
        .fg-window small { display: block; color: var(--faint); font-size: 10.5px; }
        .fg-addbar { display: flex; align-items: center; gap: 12px; padding: 11px 14px; flex-wrap: wrap; }
        .fg-addbar-hint { margin: 0; font-size: 11.5px; color: var(--faint); line-height: 1.55; flex: 1; min-width: 220px; }

        .fg-var { display: grid; grid-template-columns: 108px 118px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.05fr) 130px;
          gap: 10px; align-items: center; padding: 10px 14px; border-bottom: 1px solid var(--line); }
        .fg-var:last-child { border-bottom: 0; }
        .fg-figure { font-size: 12px; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.55; }
        .fg-figure small { display: block; font-size: 10.5px; color: var(--faint); }
        .fg-diff { font-size: 12px; color: var(--ink-2); font-variant-numeric: tabular-nums; line-height: 1.55; }
        .fg-diff.is-var { color: var(--red); }

        .fg-links { display: flex; gap: 14px; flex-wrap: wrap; margin-top: 12px; padding-top: 11px; border-top: 1px solid var(--line); }
        .fg-links a { font-size: 11.5px; color: var(--brand); text-decoration: none; }
        .fg-links-stack { flex-direction: column; gap: 8px; }

        .fg-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 20px; z-index: 60; }
        .fg-modal { background: var(--surface); border-radius: 14px; width: 100%; max-width: 720px;
          max-height: 90vh; overflow: auto; padding: 1.2rem 1.3rem; display: flex; flex-direction: column; gap: 12px;
          box-shadow: var(--shadow-lg); }
        .fg-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .fg-modal-head h3 { margin: 0; font-size: 15px; color: var(--ink); }
        .fg-modal-blurb { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.6; }
        .fg-modal-foot { display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
        .fg-mode { margin-right: auto; font-size: 11px; color: var(--faint); }
        .fg-warn { display: flex; gap: 8px; align-items: flex-start; font-size: 11.5px; color: var(--red);
          background: var(--red-soft); border-radius: 10px; padding: 9px 11px; line-height: 1.55; }

        .fg-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 12px 14px; }
        .fg-set-head { padding: 12px 14px 0; }
        .fg-set-blurb { margin: 6px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
        .fg-set-foot { padding: 0 14px 12px; margin: 0; font-size: 11px; color: var(--faint); }
        .fg-field { display: flex; flex-direction: column; gap: 5px; }
        .fg-field > span { font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .fg-field > small { font-size: 11px; color: var(--muted); line-height: 1.55; }
        .fg-field-check { justify-content: flex-start; }
        .fg-checkbox { display: flex; align-items: flex-start; gap: 8px; font-size: 12px; color: var(--ink-2); line-height: 1.55; }
        .fg-checkbox input { accent-color: var(--brand); margin-top: 3px; }
        .fg-pieces { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

        .fg-provenance { border: 1px solid var(--line); border-radius: 11px; background: var(--surface-2); padding: 10px 12px; }
        .fg-provenance strong { font-size: 12.5px; color: var(--ink); font-variant-numeric: tabular-nums; }
        .fg-provenance p { margin: 4px 0 0; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
        .fg-problems { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .fg-problems li { font-size: 11.5px; color: var(--red); background: var(--red-soft);
          border-radius: 9px; padding: 8px 10px; line-height: 1.55; }
        .fg-issues { display: flex; flex-direction: column; gap: 6px; }

        @media (max-width: 1180px) {
          .fg-stats { grid-template-columns: 1fr 1fr; }
          .fg-grid { grid-template-columns: 1fr; }
          .fg-head, .fg-row { grid-template-columns: 108px 104px minmax(0, 1.3fr) 120px minmax(0, 1fr) 168px; }
          .fg-head > span:last-child, .fg-row > .fg-actions { grid-column: 1 / -1; }
          .fg-amend, .fg-amend-head { grid-template-columns: 104px minmax(0, 1.2fr) minmax(0, 1fr) 120px minmax(0, 1fr) 150px; }
          .fg-amend > .fg-actions { grid-column: 1 / -1; }
        }
        @media (max-width: 1040px) {
          .fg-clocks { grid-template-columns: 1fr; }
          .fg-fields { grid-template-columns: 1fr; }
          .fg-var, .fg-var-head { grid-template-columns: 104px 112px minmax(0, 1fr) minmax(0, 1fr); }
          .fg-var > div:last-child, .fg-var-head > span:last-child { grid-column: 1 / -1; }
          .fg-heads { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        }
        @media (max-width: 768px) {
          .fg-stats { grid-template-columns: 1fr; }
          .fg-findings { grid-template-columns: 1fr; }
          .fg-tools { margin-left: 0; width: 100%; }
          .fg-head { display: none; }
          .fg-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 4px 10px; padding: 11px 12px; }
          .fg-actions { grid-column: 1 / -1; justify-content: flex-start; }
          .fg-amend-head { display: none; }
          .fg-amend { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
          .fg-var-head { display: none; }
          .fg-var { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
          .fg-modal { max-width: none; padding: 1rem 1rem 1.1rem; }
          .fg-scrim { align-items: flex-end; padding: 0; }
          .fg-modal { border-radius: 16px 16px 0 0; max-height: 94vh; }
          .fg-modal-foot { flex-direction: column-reverse; }
          .fg-modal-foot .tf-btn { width: 100%; justify-content: center; }
        }
      `}</style>
    </div>
  )
}

/* ── small pieces ──────────────────────────────────────────────────────────── */

/** A history line names a status; anything the engine did not mean stays exactly as it was written. */
function statusWord(v: string): string {
  const hit = (STATUS_META as Record<string, { label: string }>)[v]
  return hit ? hit.label : v
}

/** A row deserves the attention filter: shut by the chain, past its date, late, drifting, or about to be due. */
function needsAttention(r: RegisterRow): boolean {
  return r.blocked || r.state === 'overdue' || r.state === 'late' || r.state === 'due_soon'
    || r.state === 'due_today' || !!r.drift || r.amendments > 0 || r.consequences.length > 0
}

/** Severity words for the objection badges, kept beside the tone rather than merged into it. */
const URGENCY_LABEL: Record<'block' | 'warn' | 'info', string> = {
  block: 'Blocks', warn: 'Watch', info: 'Note',
}

function yearOptions(): number[] {
  const now = fyStartYear(new Date())
  return [now, now - 1, now - 2, now - 3]
}

/** The periods worth picking for the clock strip: every period the grid holds, newest last. */
function periodChoices(rows: RegisterRow[]): string[] {
  const seen: string[] = []
  for (const r of rows) if (!seen.includes(r.period)) seen.push(r.period)
  return seen.slice(0, 48)
}

/** The calendar for this year and cadence — the engine's own composition, called once. */
function generateForYear(fyStart: number, settings: FilingsSettings) {
  return generateEvents(fyStart, profileFor(settings))
}

/** A row of the shop's own outward paper, dressed the way /gst/gstr9 dresses it. */
function toDoc(
  r: Record<string, unknown>,
  kind: 'invoice' | 'credit_note',
  numberKey: string, dateKey: string, partyKey: string, gstinKey: string,
): OutwardDoc {
  return {
    id: String(r.id ?? ''),
    number: String(r[numberKey] ?? ''),
    date: (r[dateKey] as string) ?? null,
    kind,
    party: (r[partyKey] as string) ?? null,
    gstin: (r[gstinKey] as string) ?? null,
    placeOfSupply: (r.place_of_supply as string) ?? null,
    supplyType: (r.supply_type as string) ?? null,
    taxable: (r.taxable_amount as number) ?? 0,
    igst: (r.igst_amount as number) ?? 0,
    cgst: (r.cgst_amount as number) ?? 0,
    sgst: (r.sgst_amount as number) ?? 0,
    cess: (r.cess_amount as number) ?? 0,
    total: (r.grand_total as number) ?? 0,
  }
}

function amendComposerFrom(a: Amendment): AmendComposer {
  return {
    id: a.id, period: a.period, kind: a.kind, docRef: a.doc_ref, party: a.party, effect: a.effect,
    taxable: a.taxable ? String(a.taxable) : '', tax: a.tax ? String(a.tax) : '',
    foundOn: a.found_on, status: a.status, carriedIn: a.carried_in, notes: a.notes,
  }
}

/* ── the returns grid ──────────────────────────────────────────────────────── */

function FilingRow({
  row, open, onToggle, onEdit, onNew, onRemove, onAmend, onSeal,
}: {
  row: RegisterRow
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onNew: () => void
  onRemove: () => void
  onAmend: () => void
  onSeal: () => void
}) {
  const meta = FORM_META[row.form]
  const state = STATE_META[row.state]
  const rec = row.record
  const heads = rec?.heads
  const fee = row.fee

  return (
    <>
      <div className={`fg-row ${row.blocked ? 'is-blocked' : ''} ${!rec ? 'is-record' : ''}`}>
        <div className="fg-form">
          <button type="button" className="fg-toggle" onClick={onToggle} aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the detail of ${meta.label} for ${row.periodLabel}`}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          <div>
            <strong>{meta.label}</strong>
            <small>{meta.optional ? 'optional' : meta.section}</small>
          </div>
        </div>
        <div className="fg-period">{row.periodLabel}</div>
        <div className="fg-due">
          {row.due ? formatDateIN(row.due) : 'no date stated'}
          <small>
            {row.dueSource}
            {row.drift ? <span className="is-drift"> · {row.drift}</span> : ''}
          </small>
          {row.seal.sealed && <small>sealed · {row.seal.label}</small>}
        </div>
        <div className="fg-actions" style={{ flexWrap: 'wrap' }}>
          <Badge tone={state.tone}>{state.label}</Badge>
          {row.days > 0 && !rec && <span className="fg-period">{row.days} day(s) past</span>}
        </div>
        <div className="fg-stated">
          {heads
            ? <>
              {money(heads.taxable)}
              <small> tax {money(heads.tax)}{rec?.status === 'nil' ? ' · nil' : ''}</small>
            </>
            : <span style={{ color: 'var(--faint)' }}>nothing recorded</span>}
        </div>
        <div className="fg-cost">
          {fee.days > 0
            ? <>
              <strong>{money(fee.total)}</strong>
              <small style={{ display: 'block', fontSize: 10.5, color: 'var(--faint)' }}>
                fee {money(fee.fee)}{fee.capped ? ' (capped)' : ''} · interest {money(fee.interest)}
              </small>
            </>
            : '—'}
        </div>
        <div className="fg-actions">
          {rec
            ? <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Correct</Button>
            : <Button variant="ghost" size="sm" icon="plus" onClick={onNew}>Record</Button>}
          {rec && rec.status !== 'not_filed' && (
            <Button variant="ghost" size="sm" icon="undo" onClick={onRemove}>Withdraw</Button>
          )}
          {rec && <Button variant="ghost" size="sm" icon="x" onClick={onRemove}>Remove</Button>}
        </div>
      </div>

      {open && (
        <div className="fg-detail">
          <div className="fg-detail-block">
            <div className="fg-detail-title">The date this row is measured against</div>
            <p>
              {row.due
                ? `${formatDateIN(row.due)} — ${row.dueSource === 'stated on the row'
                  ? 'the date this row carries, copied when it was written and kept even if the calendar moved'
                  : row.dueSource === 'the app calendar'
                    ? 'copied from /gst/calendar when the row was written'
                    : row.dueSource === 'cited from the rule'
                      ? 'derived from the rule text, because the calendar had no row for this period'
                      : 'not dated'}`
                : 'No date on this row, so nothing here is late and nothing here is on time.'}
            </p>
            {row.dueNote && <p className="is-cite">{row.dueNote}</p>}
            {row.drift && <p className="is-cite">{row.drift}</p>}
            <p className="is-cite">{meta.rule} · {meta.what}</p>
          </div>

          <div className="fg-detail-block">
            <div className="fg-detail-title">What the return stated</div>
            {heads ? (
              <div className="fg-heads">
                {([['Taxable', heads.taxable], ['IGST', heads.igst], ['CGST', heads.cgst],
                  ['SGST', heads.sgst], ['Cess', heads.cess], ['Tax', heads.tax]] as [string, number][])
                  .map(([label, v]) => (
                    <div key={label}><span>{label}</span><strong>{money(v)}</strong></div>
                  ))}
              </div>
            ) : <p>Nothing recorded for this period yet.</p>}
            {rec && (
              <>
                <p>
                  {rec.status === 'not_filed' ? 'Not filed.' : `Filed on ${formatDateIN(rec.filed_on)}.`}
                  {rec.reference ? ` Reference ${rec.reference} — stored exactly as written and never checked against the portal.` : ' No reference recorded.'}
                  {rec.tax_paid_on ? ` Tax paid on ${formatDateIN(rec.tax_paid_on)}.` : ' The date the tax was paid is not stated, so interest is estimated to today.'}
                  {rec.actor ? ` Written by ${rec.actor}.` : ''}
                </p>
                {rec.unpaid_intimation > 0 && (
                  <p>₹{rec.unpaid_intimation.toLocaleString('en-IN')} intimated under rule 88C(1) and recorded unpaid here — rule 59(6)(d) keeps the next GSTR-1 shut on that figure.</p>
                )}
                {(rec.late_fee_paid > 0 || rec.interest_paid > 0) && (
                  <p>Recorded as paid: late fee {money(rec.late_fee_paid)}, interest {money(rec.interest_paid)}. The estimate below is the rule&apos;s figure, printed beside these, not merged into them.</p>
                )}
                {rec.notes && <p>{rec.notes}</p>}
                {rec.history.length > 0 && (
                  <ul className="fg-history">
                    {rec.history.slice(-6).map((h, i) => (
                      <li key={`${h.at}${i}`}>
                        <time>{h.at.slice(0, 10)}</time>
                        <span>{h.action}{h.from ? ` from ${statusWord(h.from)}` : ''} to {statusWord(h.to)}{h.actor ? ` · ${h.actor}` : ''}{h.note ? ` — ${h.note}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>

          {fee.days > 0 && (
            <div className="fg-detail-block">
              <div className="fg-detail-title">What the delay costs, and which table says so</div>
              <div className="fg-costs">
                <ul>
                  {fee.prints.map(p => <li key={p}>{p}</li>)}
                  <li>{fee.basis}</li>
                  {fee.interestDays > 0 && <li>{fee.interestBasis}</li>}
                </ul>
              </div>
              {rec && (fee.fee > rec.late_fee_paid || fee.interest > rec.interest_paid) && (
                <p className="is-cite">
                  The rule&apos;s figure is above; this row says {money(rec.late_fee_paid + rec.interest_paid)} was paid.
                  The gap is printed as a gap — the register does not decide which of the two the department will accept.
                </p>
              )}
            </div>
          )}

          <div className="fg-detail-block">
            <div className="fg-detail-title">What the rules do about this row</div>
            {row.consequences.length === 0 ? (
              <p>
                {row.blocked
                  ? 'The chain shuts this row.'
                  : 'Nothing on the register triggers a bar or a reminder for this row. Rule 59(6) and 88C(1) read only what is recorded here, so an absence of findings is an absence of rows, not a clean bill.'}
              </p>
            ) : (
              <div className="fg-cons">
                {row.consequences.map(c => (
                  <div key={c.code} className={`fg-cons-item ${c.severity === 'block' ? 'is-block' : c.severity === 'info' ? 'is-info' : ''}`}>
                    <Badge tone={c.severity === 'block' ? 'red' : c.severity === 'warn' ? 'amber' : 'blue'}>{URGENCY_LABEL[c.severity]}</Badge>
                    <strong>{c.title}</strong>
                    <p>{c.why}</p>
                    <p className="is-cite">{c.citation}</p>
                    <Link href={c.href}>Open {c.href}</Link>
                  </div>
                ))}
              </div>
            )}
            {row.window && (
              <p className="is-cite">
                The GSTR-1A door for {row.periodLabel}: {row.window.open ? `still open${row.window.closesOn ? ` until ${formatDateIN(row.window.closesOn)}` : ''}` : `shut — ${row.window.why}`}
              </p>
            )}
            <div className="fg-actions" style={{ marginTop: 10 }}>
              <Button variant="ghost" size="sm" icon="undo" onClick={onAmend}>Log an amendment for {row.periodLabel}</Button>
              {!row.seal.sealed && (
                <Button variant="subtle" size="sm" icon="lock" onClick={onSeal}>Seal {row.periodLabel}</Button>
              )}
              {row.seal.sealed && (
                <Link className="fg-period" href="/audit">{row.seal.label} is sealed — release it at /audit</Link>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ── the amendment board ───────────────────────────────────────────────────── */

function AmendRow({
  board, open, onToggle, onEdit, onCarry, onLapse, onReopen, onDelete,
}: {
  board: BoardRow
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onCarry: () => void
  onLapse: () => void
  onReopen: () => void
  onDelete: () => void
}) {
  const a = board.amendment
  const meta = AMENDMENT_META[a.kind]
  const status = AMENDMENT_STATUS_META[a.status]
  const urgency = URGENCY_META[board.urgency]

  return (
    <>
      <div className={`fg-amend ${board.urgency === 'act_now' ? 'is-act' : ''} ${board.urgency === 'lapsed' ? 'is-lapsed' : ''}`}>
        <div className="fg-period">{periodLabel(a.period)}</div>
        <div className="fg-form">
          <button type="button" className="fg-toggle" onClick={onToggle} aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the window detail for ${a.doc_ref || 'this amendment'}`}>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
          <div>
            <strong style={{ fontSize: 12.5 }}>{meta.label}</strong>
            <small>{meta.where}</small>
          </div>
        </div>
        <div className={`fg-doc ${board.dangling ? 'is-dangling' : ''}`}>
          {a.doc_ref || 'no document named'}
          <small>{a.party || 'party not named'}{board.dangling ? ' · not found in this year\'s books' : ''}</small>
        </div>
        <div className="fg-effect">
          {signed(a.effect === 'reduce' ? -a.taxable : a.taxable)}
          <small style={{ display: 'block', color: 'var(--faint)', fontSize: 10.5 }}>tax {money(a.tax)}</small>
        </div>
        <div className="fg-window">
          {board.closesOn ? formatDateIN(board.closesOn) : 'no date on this clock'}
          <small>
            {board.urgency === 'lapsed' ? 'shut' : board.left <= 0 ? 'shutting' : `${board.left} day(s) left`}
          </small>
        </div>
        <div className="fg-actions">
          <Badge tone={status.tone}>{status.label}</Badge>
          {board.urgency !== 'done' && <Badge tone={urgency.tone}>{urgency.label}</Badge>}
        </div>
        <div className="fg-actions">
          {a.status !== 'carried' && <Button variant="ghost" size="sm" icon="check" onClick={onCarry}>Carried</Button>}
          {a.status === 'open' && <Button variant="ghost" size="sm" icon="clock" onClick={onLapse}>Lapsed</Button>}
          {a.status !== 'open' && <Button variant="ghost" size="sm" icon="undo" onClick={onReopen}>Re-open</Button>}
          <Button variant="ghost" size="sm" icon="edit" onClick={onEdit}>Edit</Button>
          <Button variant="ghost" size="sm" icon="x" onClick={onDelete}>Delete</Button>
        </div>
      </div>
      {open && (
        <div className="fg-detail">
          <div className="fg-detail-block">
            <div className="fg-detail-title">The clock that governs this correction</div>
            <p>{board.clock}</p>
            <p>{board.why}</p>
            {board.dangling && (
              <p className="is-cite">
                {a.doc_ref || 'This reference'} is not among this year&apos;s invoices or credit notes on this device.
                Printed as it stands: the register never drops a document it cannot find, and never checks one
                against the portal.
              </p>
            )}
          </div>
          {board.windows && (
            <div className="fg-clocks">
              <ClockCard title="GSTR-1A" w={board.windows.gstr1a} note="the proviso to rule 59(1)"
                highlight={meta.clock === 'gstr1a'} />
              <ClockCard title="Table 9A of the annual return" w={board.windows.table9a} note="the annual return for the year"
                highlight={meta.clock === 'table9a'} />
              <ClockCard title="The recipient's credit" w={board.windows.itc} note="section 16(4)"
                highlight={meta.clock === 'itc'} />
            </div>
          )}
          {a.notes && <div className="fg-detail-block"><div className="fg-detail-title">Notes</div><p>{a.notes}</p></div>}
          <div className="fg-detail-block">
            <div className="fg-detail-title">Written</div>
            <p>
              Found on {formatDateIN(a.found_on)} · logged {a.created_at.slice(0, 10)}
              {a.actor ? ` by ${a.actor}` : ''}{a.updated_at !== a.created_at ? ` · last changed ${a.updated_at.slice(0, 10)}` : ''}.
              {a.carried_in ? ` Carried through ${a.carried_in}.` : ''}
            </p>
          </div>
        </div>
      )}
    </>
  )
}

function ClockCard({
  title, w, note, highlight = false,
}: {
  title: string
  w: { open: boolean; closesOn: string; left: number; why: string; citation: string } | undefined
  note: string
  highlight?: boolean
}) {
  if (!w) return null
  return (
    <div className={`fg-clock ${w.open ? 'is-open' : 'is-shut'} ${highlight ? 'is-gov' : ''}`}>
      <h4>
        <Icon name={w.open ? 'unlock' : 'lock'} size={13} />
        {title}
        <Badge tone={w.open ? (w.left <= 7 ? 'red' : w.left <= 30 ? 'amber' : 'blue') : 'grey'}>
          {w.open ? 'Open' : 'Shut'}
        </Badge>
      </h4>
      <div className="left">{w.left > 0 ? `${w.left} day(s)` : w.open ? 'shutting' : 'closed'}</div>
      <p>{w.why}</p>
      <small>{note} — {w.citation}</small>
    </div>
  )
}

/* ── declared vs books ─────────────────────────────────────────────────────── */

function VarianceRowView({ v }: { v: VarianceRow }) {
  const meta = VARIANCE_META[v.status]
  return (
    <div className="fg-var">
      <div className="fg-form"><div><strong>{FORM_META[v.form].label}</strong><small>{FORM_META[v.form].section}</small></div></div>
      <div className="fg-period">{v.periodLabel}</div>
      <div className="fg-figure">
        {v.stated ? money(v.stated.taxable) : '—'}
        <small>{v.stated ? `tax ${money(v.stated.tax)}` : 'no figures on the row'}</small>
      </div>
      <div className="fg-figure">
        {v.books ? money(v.books.taxable) : '—'}
        <small>{v.books ? `tax ${money(v.books.tax)}` : 'no documents for this device'}</small>
      </div>
      <div className={`fg-diff ${v.status === 'variance' ? 'is-var' : ''}`}>
        {v.books && v.stated
          ? <>
            {signed(v.diff.taxable)} of taxable value
            <small style={{ display: 'block', color: 'var(--faint)', fontSize: 10.5 }}>{signed(v.diff.tax)} of tax</small>
          </>
          : <span style={{ color: 'var(--faint)' }}>nothing to compare</span>}
      </div>
      <div className="fg-actions">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        {v.heads.length > 0 && <small style={{ fontSize: 10.5, color: 'var(--faint)' }}>{v.heads.join(', ')}</small>}
      </div>
    </div>
  )
}

/* ── the composers ─────────────────────────────────────────────────────────── */

function ComposerForm({
  composer, setComposer, errors, saving, settings, store, period, today, onSave, onClose,
}: {
  composer: Composer
  setComposer: (next: Composer) => void
  errors: string[]
  saving: boolean
  settings: FilingsSettings
  store: FilingsStore
  period: string
  today: string
  onSave: () => void
  onClose: () => void
}) {
  const meta = FORM_META[composer.form]
  const kinds = meta.cadence
  const existing = period
    ? store.filings.find(f => f.form === composer.form && f.period === period) ?? null
    : null

  const payload = composerToDraft(composer, period)
  const heads = headsOf(
    Number(composer.taxable) || 0, Number(composer.igst) || 0, Number(composer.cgst) || 0,
    Number(composer.sgst) || 0, Number(composer.cess) || 0,
  )
  const dueChoice = period ? pickDue(payload, existing, settings, period, generateForYear(periodFyStart(period), settings)) : null
  const dueDate = dueChoice?.date ?? ''
  const filed = composer.status !== 'not_filed'
  const days = dueDate ? (filed ? daysLate(dueDate, composer.filedOn || today) : daysLate(dueDate, today)) : 0
  const fee = estimateLateFee({
    form: composer.form, days, nil: composer.status === 'nil', tax: heads.tax, due: dueDate,
    paidOn: composer.taxPaidOn || composer.filedOn || undefined, today,
    precedingFyTurnover: settings.precedingFyTurnover, stateTurnover: settings.stateTurnover,
    lateFeePaid: Number(composer.lateFeePaid) || 0, interestPaid: Number(composer.interestPaid) || 0,
  })
  const consequences = period ? consequencesFor(store, composer.form, period, today) : []
  const windows = period ? windowsFor(store, period, today) : null

  const set = (patch: Partial<Composer>) => setComposer({ ...composer, ...patch })

  return (
    <div className="fg-scrim" role="dialog" aria-modal="true" aria-label="Record a return" onClick={onClose}>
      <div className="fg-modal" onClick={e => e.stopPropagation()}>
        <div className="fg-modal-head">
          <h3>{existing ? `Correct ${meta.label} for ${periodLabel(period)}` : `Record ${meta.label}`}</h3>
          <button type="button" className="fg-notice-x" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <p className="fg-modal-blurb">{meta.what} These figures are a transcript of what the return stated; nothing here posts to the ledger or pays the department.</p>

        <div className="fg-fields">
          <label className="fg-field">
            <span>Which return</span>
            <select className="fg-select" value={composer.form} onChange={e => set({ form: e.target.value as FilingForm })}>
              {FORMS.map(f => <option key={f} value={f}>{FORM_META[f].label} — {FORM_META[f].what.slice(0, 46)}…</option>)}
            </select>
            <small>{meta.rule}; {meta.cadence.map(k => k === 'month' ? 'monthly' : k === 'quarter' ? 'quarterly' : 'yearly').join(' / ')}.</small>
          </label>

          <label className="fg-field">
            <span>For which tax period</span>
            <div className="fg-pieces">
              <input className="fg-input" style={{ width: 90 }} type="number" min={2000} max={2100} step={1}
                value={composer.pYear} placeholder="2026" aria-label="Year the period starts in"
                onChange={e => set({ pYear: e.target.value })} />
              {kinds.includes('month') && (
                <select className="fg-select" value={composer.pMonth} onChange={e => set({ pMonth: e.target.value })} aria-label="Month">
                  <option value="">Month</option>
                  {MONTHS.map((m, i) => <option key={m} value={m}>{MONTH_NAMES[i]}</option>)}
                </select>
              )}
              {kinds.includes('quarter') && (
                <select className="fg-select" value={composer.pQuarter} onChange={e => set({ pQuarter: e.target.value })} aria-label="Quarter">
                  <option value="">Quarter</option>
                  {[1, 2, 3, 4].map(q => <option key={q} value={q}>Q{q}</option>)}
                </select>
              )}
              {kinds.includes('year') && <span className="fg-period">the financial year starting {composer.pYear || '—'}</span>}
            </div>
            <small>{period ? `This row will be dated ${periodLabel(period)}.` : 'Name the period — a return with no tax period is not a record.'}</small>
          </label>

          <label className="fg-field">
            <span>Status</span>
            <Segmented
              value={composer.status}
              onChange={v => set({ status: v as FilingStatus })}
              options={[{ value: 'filed', label: 'Filed' }, { value: 'nil', label: 'Nil' }, { value: 'not_filed', label: 'Not filed' }]}
            />
            <small>A nil return states no tax. Marking a row not filed withdraws what was recorded and writes that to the audit trail.</small>
          </label>

          {filed && (
            <>
              <label className="fg-field">
                <span>Filed on</span>
                <input className="fg-input" type="date" value={composer.filedOn} max={today} onChange={e => set({ filedOn: e.target.value })} />
                <small>The day the portal took it, not the day it was thought about.</small>
              </label>
              <label className="fg-field">
                <span>Reference / ARN as written</span>
                <input className="fg-input" type="text" value={composer.reference} placeholder="AB1234567890123XY"
                  onChange={e => set({ reference: e.target.value })} />
                <small>Stored exactly as typed, never verified. No spaces.</small>
              </label>
            </>
          )}

          <label className="fg-field">
            <span>The date it was due, and why it changed</span>
            <div className="fg-pieces">
              <input className="fg-input" style={{ width: 150 }} type="date" value={composer.due} onChange={e => set({ due: e.target.value })} />
              <input className="fg-input" type="text" value={composer.dueReason} placeholder="Reason for a date the calendar did not state"
                onChange={e => set({ dueReason: e.target.value })} />
            </div>
            {dueChoice && (
              <small>
                {dueChoice.date
                  ? `Left empty, this row is measured against ${formatDateIN(dueChoice.date)} — ${dueChoice.provenance}${dueChoice.note ? ` (${dueChoice.note})` : ''}.`
                  : 'Neither this row nor the calendar nor the rule gives a date for the period. It will print as undated rather than guessed.'}
              </small>
            )}
          </label>

          {composer.form === 'gstr3b' && (
            <label className="fg-field">
              <span>An intimation under rule 88C(1) still unpaid</span>
              <input className="fg-input" type="number" min={0} step={1} value={composer.unpaidIntimation}
                placeholder="₹0" onChange={e => set({ unpaidIntimation: e.target.value })} />
              <small>While this stands unpaid, rule 59(6)(d) keeps the next GSTR-1 shut. It is read off this row, so it has to be honest.</small>
            </label>
          )}
        </div>

        {filed && (
          <div className="fg-fields" style={{ borderTop: '1px solid var(--line)' }}>
            {([['taxable', 'Taxable value'], ['igst', 'IGST'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['cess', 'Cess']] as [keyof Composer, string][])
              .map(([key, label]) => (
                <label className="fg-field" key={key}>
                  <span>{label}</span>
                  <input className="fg-input" type="number" min={0} step={0.01}
                    value={String(composer[key] ?? '')} placeholder="₹0.00"
                    onChange={e => set({ [key]: e.target.value } as Partial<Composer>)} />
                </label>
              ))}
            <div className="fg-field">
              <span>Tax the return stated</span>
              <div className="fg-provenance"><strong>{money(heads.tax)}</strong><p>IGST + CGST + SGST + cess, exactly as the four boxes above are typed.</p></div>
            </div>
          </div>
        )}

        {filed && (
          <div className="fg-fields" style={{ borderTop: '1px solid var(--line)' }}>
            <label className="fg-field">
              <span>The day the tax was paid</span>
              <input className="fg-input" type="date" value={composer.taxPaidOn} max={today} onChange={e => set({ taxPaidOn: e.target.value })} />
              <small>Section 50 interest runs from the due date to this day. Without it the estimate runs to today and says so.</small>
            </label>
            <label className="fg-field">
              <span>Late fee actually paid</span>
              <input className="fg-input" type="number" min={0} step={1} value={composer.lateFeePaid} placeholder="₹0"
                onChange={e => set({ lateFeePaid: e.target.value })} />
            </label>
            <label className="fg-field">
              <span>Interest actually paid</span>
              <input className="fg-input" type="number" min={0} step={1} value={composer.interestPaid} placeholder="₹0"
                onChange={e => set({ interestPaid: e.target.value })} />
            </label>
            <div className="fg-field" style={{ gridColumn: '1 / -1' }}>
              <span>What the delay costs under the table that applies</span>
              <div className="fg-provenance">
                <strong>{money(fee.total)}</strong>
                <ul className="fg-costs" style={{ marginTop: 6 }}>
                  {fee.prints.length
                    ? fee.prints.map(p => <li key={p}>{p}</li>)
                    : <li>On this date the row is not late, so no fee is being estimated. Nothing is silently assumed about a period that has not run.</li>}
                  <li>{fee.basis}</li>
                </ul>
                <p>The figures above stay beside this sentence, never merged into them.</p>
              </div>
            </div>
          </div>
        )}

        <div className="fg-fields" style={{ borderTop: '1px solid var(--line)' }}>
          <label className="fg-field" style={{ gridColumn: '1 / -1' }}>
            <span>Notes — what a reader later needs to know</span>
            <textarea className="fg-textarea" rows={2} value={composer.notes} placeholder="Filed with a deviation, the portal error number, a demand the row answers…"
              onChange={e => set({ notes: e.target.value })} />
          </label>
          <label className="fg-field">
            <span>Written by</span>
            <input className="fg-input" type="text" value={composer.actor} placeholder={settings.actor || 'A name the trail can attribute'}
              onChange={e => set({ actor: e.target.value })} />
          </label>
          <label className="fg-field">
            <span>As it stands today</span>
            <div className="fg-provenance">
              <strong>{period ? periodLabel(period) : 'No period yet'}</strong>
              <p>{STATUS_META[composer.status].label} · due {dueDate ? formatDateIN(dueDate) : '—'} · {dueChoice?.provenance ?? 'not yet measured'}.</p>
            </div>
          </label>
        </div>

        {consequences.length > 0 && (
          <div className="fg-issues">
            {consequences.map(c => (
              <div key={c.code} className={`fg-cons-item ${c.severity === 'block' ? 'is-block' : c.severity === 'info' ? 'is-info' : ''}`}>
                <strong>{c.title}</strong>
                <p>{c.why}</p>
                <p className="is-cite">{c.citation}</p>
              </div>
            ))}
          </div>
        )}
        {windows && composer.form === 'gstr1a' && !windows.gstr1a.open && (
          <div className="fg-warn"><Icon name="alert" size={14} />{windows.gstr1a.why}</div>
        )}
        {errors.length > 0 && (
          <ul className="fg-problems">{errors.map(p => <li key={p}>{p}</li>)}</ul>
        )}

        <div className="fg-modal-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon="check" disabled={!period || saving} onClick={onSave}>
            {existing ? 'Save the correction' : 'Record this return'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function AmendForm({
  amend, setAmend, errors, store, today, knownCount, onSave, onClose,
}: {
  amend: AmendComposer
  setAmend: (next: AmendComposer) => void
  errors: string[]
  store: FilingsStore
  today: string
  knownCount: number
  onSave: () => void
  onClose: () => void
}) {
  const meta = AMENDMENT_META[amend.kind]
  const windows = amend.period ? windowsFor(store, amend.period, today) : null
  const governing = windows ? (meta.clock === 'gstr1a' ? windows.gstr1a : meta.clock === 'table9a' ? windows.table9a : windows.itc) : null
  const set = (patch: Partial<AmendComposer>) => setAmend({ ...amend, ...patch })

  const periodChoicesLocal: string[] = []
  for (const f of store.filings) if (!periodChoicesLocal.includes(f.period)) periodChoicesLocal.push(f.period)
  for (const a of store.amendments) if (!periodChoicesLocal.includes(a.period)) periodChoicesLocal.push(a.period)
  if (amend.period && !periodChoicesLocal.includes(amend.period)) periodChoicesLocal.unshift(amend.period)

  return (
    <div className="fg-scrim" role="dialog" aria-modal="true" aria-label="Log an amendment" onClick={onClose}>
      <div className="fg-modal" onClick={e => e.stopPropagation()}>
        <div className="fg-modal-head">
          <h3>{amend.id ? 'Change the correction' : 'Log a correction'}</h3>
          <button type="button" className="fg-notice-x" onClick={onClose} aria-label="Close"><Icon name="x" size={14} /></button>
        </div>
        <p className="fg-modal-blurb">
          A correction is only worth recording while a window can still carry it. The engine reads the three
          clocks against the returns already on the register and prints the result — a correction with no
          window left stays on the board as lapsed, never as a task.
        </p>

        <div className="fg-fields">
          <label className="fg-field">
            <span>Which tax period is being corrected</span>
            <div className="fg-pieces">
              <select className="fg-select" value={amend.period} onChange={e => set({ period: e.target.value })} aria-label="Period corrected">
                <option value="">Choose a period</option>
                {periodChoicesLocal.map(p => <option key={p} value={p}>{periodLabel(p)}</option>)}
              </select>
              <input className="fg-input" style={{ width: 110 }} type="number" min={2000} max={2100}
                placeholder="or year" aria-label="Year of a period not listed"
                onChange={e => {
                  const y = e.target.value
                  const guess = y.length === 4 ? `${y}-01` : ''
                  set({ period: guess })
                }} />
            </div>
            <small>The list holds the periods this register already knows. A correction of a period nothing was filed for is still allowed — that is what Table 9A is for.</small>
          </label>
          <label className="fg-field">
            <span>What was missed</span>
            <select className="fg-select" value={amend.kind} onChange={e => set({ kind: e.target.value as AmendmentKind })}>
              {AMENDMENT_KINDS.map(k => <option key={k} value={k}>{AMENDMENT_META[k].label}</option>)}
            </select>
            <small>{meta.basis}</small>
          </label>
          <label className="fg-field">
            <span>Document, note or credit reference</span>
            <input className="fg-input" type="text" value={amend.docRef} placeholder="INV-2026-0142, or BIL/TC-07/2026-27"
              onChange={e => set({ docRef: e.target.value })} />
            <small>
              Printed exactly as written. {knownCount > 0
                ? `Matched against ${knownCount} outward document(s) of this year on this device — a reference found on nothing is printed as such.`
                : 'No outward documents are loaded for this year, so nothing can be matched.'}
            </small>
          </label>
          <label className="fg-field">
            <span>Party</span>
            <input className="fg-input" type="text" value={amend.party} placeholder="The customer or supplier the paper belongs to"
              onChange={e => set({ party: e.target.value })} />
          </label>
          <label className="fg-field">
            <span>Its effect on the period</span>
            <Segmented value={amend.effect} onChange={v => set({ effect: v as 'add' | 'reduce' })}
              options={[{ value: 'add', label: 'Adds' }, { value: 'reduce', label: 'Reduces' }]} />
          </label>
          <label className="fg-field">
            <span>Taxable value · tax</span>
            <div className="fg-pieces">
              <input className="fg-input" style={{ width: 130 }} type="number" min={0} step={0.01} value={amend.taxable} placeholder="₹ taxable"
                onChange={e => set({ taxable: e.target.value })} />
              <input className="fg-input" style={{ width: 130 }} type="number" min={0} step={0.01} value={amend.tax} placeholder="₹ tax"
                onChange={e => set({ tax: e.target.value })} />
            </div>
            <small>One of the two at least — a correction with no value and no tax is a note, not an amendment.</small>
          </label>
          <label className="fg-field">
            <span>The day it was found</span>
            <input className="fg-input" type="date" value={amend.foundOn} max={today} onChange={e => set({ foundOn: e.target.value })} />
            <small>Not the day the period ended — the day the shop noticed.</small>
          </label>
          <label className="fg-field">
            <span>Status</span>
            <Segmented value={amend.status} onChange={v => set({ status: v as AmendmentStatus })}
              options={[{ value: 'open', label: 'Open' }, { value: 'carried', label: 'Carried' }, { value: 'lapsed', label: 'Lapsed' }]} />
          </label>
          {amend.status === 'carried' && (
            <label className="fg-field">
              <span>Carried through</span>
              <input className="fg-input" type="text" value={amend.carriedIn} placeholder="GSTR-1A for Mar 2026, Table 9A of FY 2025-26, the 3B for Apr 2026"
                onChange={e => set({ carriedIn: e.target.value })} />
              <small>Which return actually took it. The engine asks for this and the trail records it.</small>
            </label>
          )}
          <label className="fg-field" style={{ gridColumn: '1 / -1' }}>
            <span>Notes</span>
            <textarea className="fg-textarea" rows={2} value={amend.notes} placeholder="Why it was missed, what the department has since been told…"
              onChange={e => set({ notes: e.target.value })} />
          </label>
        </div>

        {windows && governing && (
          <div className="fg-provenance">
            <strong>{governing.open ? `${governing.left} day(s) on the ${meta.clock === 'gstr1a' ? 'GSTR-1A' : meta.clock === 'table9a' ? 'Table 9A' : 'ITC'} clock` : 'This window has shut'}</strong>
            <p>{governing.why}</p>
            <p className="is-cite">{governing.citation}</p>
          </div>
        )}
        {amendErrorsShown(errors)}

        <div className="fg-modal-foot">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon="check" disabled={!amend.period} onClick={onSave}>
            {amend.id ? 'Save the change' : 'Put it on the board'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function amendErrorsShown(errors: string[]) {
  if (!errors.length) return null
  return <ul className="fg-problems">{errors.map(p => <li key={p}>{p}</li>)}</ul>
}
