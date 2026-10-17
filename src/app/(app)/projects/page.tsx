'use client'

// Projects & time — what the work cost in hours, what it earned in rupees, and which of it
// is already late paperwork.
//
// The engine (src/lib/projects.ts) owns the model: a register of projects kept in this browser,
// hours logged against them, and whole documents attached by id. Every rupee the page prints on
// the money side is re-read from the invoices and bills on each load, exactly as the cost-centre
// register does it — this page stores measurements, never amounts.
//
// Three boundaries are printed on the screen rather than left to the reader:
//
//  * This page does not raise an invoice and does not take money. Unbilled work is grouped,
//    priced and handed over as a line you can paste at /invoices/new; the invoice itself goes
//    through the write path that gives it a real sequence number. Marking hours "billed" records
//    that you raised one somewhere — it does not raise it. /payments remains the only writer of money.
//  * The hours are priced, not billed — and the named ones are costed. An hour carries the rate it
//    would be billed at; that figure sits beside contribution, never inside it. When the row names
//    a person from the payroll register, this page reads what their hour cost in the entry's own
//    month (src/lib/payroll.ts computes it; the rows are handed across as data) and prints the
//    reading "after named hours" — marked partial while linked or typed-only hours remain unpriced.
//    The register's own revenue-minus-spend is never rewritten, and no wage rupee is stored here.
//  * The thirty-day window is rule 47 as CBIC states it in the Invoicing Handbook (§2.1.2,
//    17-06-2025). Notifications have widened it for classes of supplier. This page names the rule
//    and prints the date; only gst.gov.in settles what applies to you.

import { Suspense, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { bookDocs, type BookDoc } from '@/lib/costcentres'
import {formatDateIN, plural, pluralNoun} from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  BILLING_META, type BillingMode, costHours, drawHours, DUE_SOON_DAYS, ENTRY_CSV_HEADERS, entryCsvRows,
  invoiceLineText, invoiceWindow, loadProjects, monthlySeries, newEntry, newProject, personSeries,
  periodOf, PROJECT_CSV_HEADERS, projectCsvRows, type Project, PROJECT_STATUSES, projectViews,
  rateOf, removeTag, setProjectStatus, summarise, sortViews, STATUS_META, SERVICE_INVOICE_DAYS,
  unbilledCsvRows, unbilledGroups, UNBILLED_CSV_HEADERS, upsertEntries, upsertEntry, upsertProject,
  markBilled, markUnbilled, deleteProject, deleteEntry, bulkTag,
  validateEntry, validateProject, WATCH_META, watchSentence,
  type BookWorkDay, type HourCostRow, type HoursDraw, type MonthBucket, type ProjectStore, type ProjectView,
  type TimeEntry, type UnbilledGroup,
} from '@/lib/projects'
import { costPerHourFor, employeeById, isMonth, loadPayroll, monthLabel, offRosterWhy, type PayrollStore } from '@/lib/payroll'
import { dayBook, markWork } from '@/lib/attendance'
import {
  Badge, BarChart, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, Segmented, StatCard, StatRow,
  useDialog,
} from '@/components/ui'
import Icon from '@/components/Icons'

// ── the shape of the screen ───────────────────────────────────────────────────

type Tab = 'projects' | 'timesheet' | 'tobill' | 'documents'
type Period = 'this_fy' | 'last_fy' | 'all'
type StatusFilter = 'all' | 'running' | 'quiet'

const TABS: { value: Tab; label: string }[] = [
  { value: 'projects', label: 'Projects' },
  { value: 'timesheet', label: 'Timesheet' },
  { value: 'tobill', label: 'To bill' },
  { value: 'documents', label: 'Documents' },
]

const PERIODS: { value: Period; label: string }[] = [
  { value: 'this_fy', label: 'This FY' },
  { value: 'last_fy', label: 'Last FY' },
  { value: 'all', label: 'All time' },
]

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'Everything' },
  { value: 'running', label: 'Work logged' },
  { value: 'quiet', label: 'Nothing logged' },
]

/** The financial year today falls in — April rolls it, so 2026-03-31 is still FY 2025-26. */
function fyStart(d = new Date()): number {
  return d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
}

const fyLabel = (start: number) => `${start}-${String(start + 1).slice(2)}`

function inPeriod(date: string, period: Period, base: number): boolean {
  if (period === 'all') return true
  if (!date) return true
  const start = period === 'this_fy' ? base : base - 1
  return date >= `${start}-04-01` && date < `${start + 1}-04-01`
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
function money(n: number): string {
  const v = Math.round((Number(n) || 0) * 100) / 100
  return `₹${Math.abs(v) >= 1000 ? inr0.format(v) : inr.format(v)}`
}
/** Hours get at most two decimals and no thousands separators — "12.5 h" reads, "12,12.5 h" does not. */
function hours(h: number): string {
  const v = Math.round((Number(h) || 0) * 100) / 100
  return `${v} h`
}

const today = () => new Date().toISOString().slice(0, 10)

// ── modal state ───────────────────────────────────────────────────────────────

interface EditorState { project: Project; isNew: boolean }
interface EntryState { entry: TimeEntry; isNew: boolean; hoursText: string; rateText: string }
/** The draw: whose days, on which project, from which month — `ticks` null means "the draw's own proposal". */
interface DrawState { project_id: string; employee_id: string; month: string; ticks: string[] | null }

function toEntry(s: EntryState): TimeEntry {
  return {
    ...s.entry,
    hours: Number(s.hoursText) || 0,
    rate: Number(s.rateText) || 0,
  }
}

function ProjectsPageInner() {
  const supabase = createClient()
  const router = useRouter()
  const searchParams = useSearchParams()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)

  const [books, setBooks] = useState({
    invoices: [] as Record<string, unknown>[],
    credit_notes: [] as Record<string, unknown>[],
    debit_notes: [] as Record<string, unknown>[],
    bills: [] as Record<string, unknown>[],
    expenses: [] as Record<string, unknown>[],
  })
  const [store, setStore] = useState<ProjectStore>(() => ({ version: 1, updatedAt: '', orgId: '', projects: [], entries: [], tags: [] }))

  const [search, setSearch] = useSearchDeepLink()
  const [tab, setTab] = useState<Tab>('projects')
  const [period, setPeriod] = useState<Period>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [projectFilter, setProjectFilter] = useState('all')
  const [openProject, setOpenProject] = useState('')
  const [openGroup, setOpenGroup] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [notice, setNotice] = useState<{ msg: string; bad: boolean } | null>(null)
  const [error, setError] = useState('')

  const [editor, setEditor] = useState<EditorState | null>(null)
  const [editorError, setEditorError] = useState('')
  const [entryForm, setEntryForm] = useState<EntryState | null>(null)
  const [entryError, setEntryError] = useState('')
  const [billFor, setBillFor] = useState<{ ids: string[]; ref: string } | null>(null)
  const [attachFor, setAttachFor] = useState<string>('')
  const [drawForm, setDrawForm] = useState<DrawState | null>(null)
  const [drawError, setDrawError] = useState('')

  const editorDialog = useDialog(() => setEditor(null))
  const entryDialog = useDialog(() => setEntryForm(null))
  const billDialog = useDialog(() => setBillFor(null))
  const drawDialog = useDialog(() => setDrawForm(null))

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
      setOrgId(oid)
      setOrgName((membership.organizations as { name?: string } | null)?.name || '')

      const [invRes, cnRes, dnRes, billRes, expRes] = await Promise.all([
        supabase.from('invoices')
          .select('id, invoice_number, invoice_date, customer_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(5000),
        supabase.from('credit_notes')
          .select('id, credit_note_number, credit_note_date, customer_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(2000),
        supabase.from('debit_notes')
          .select('id, debit_note_number, debit_note_date, vendor_name, status, taxable_amount, total_tax, grand_total')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(2000),
        supabase.from('purchase_bills')
          .select('id, bill_number, bill_date, vendor_name, status, taxable_amount, total_tax, grand_total, itc_eligible')
          .eq('organization_id', oid).neq('status', 'cancelled').limit(5000),
        supabase.from('expenses')
          .select('id, bill_number, expense_date, category, vendor_name, amount, gst_amount, taxable_amount, itc_eligible')
          .eq('organization_id', oid).limit(5000),
      ])
      setError(invRes.error ? `Could not read the books: ${invRes.error.message}` : '')

      setBooks({
        invoices: invRes.data || [],
        credit_notes: cnRes.data || [],
        debit_notes: dnRes.data || [],
        bills: billRes.data || [],
        expenses: expRes.data || [],
      })
      const reg = loadProjects(oid)
      setStore(reg)

      // ?new=1 — the palette's "New project" action lands here with the editor open.
      if (searchParams.get('new') === '1') openEditor(newProject(), true)
      const view = searchParams.get('view')
      if (view === 'tobill' || view === 'timesheet' || view === 'documents') setTab(view as Tab)
      // ?log=1 — "Log an hour" lands with the entry modal open on the newest live project, and
      // with the project editor when there is no project to log against yet.
      if (searchParams.get('log') === '1') {
        const first = reg.projects.filter(p => !p.archived).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0]
        if (first) { setTab('timesheet'); openEntry(first.id) } else openEditor(newProject(), true)
      }
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── derived: the books, then the register read against them ────────────────

  const docs = useMemo(() => bookDocs({
    // The reader lives in the cost-centre library and is shared deliberately: one place decides
    // that a cancelled row carries no rupees and a credit note is negative revenue.
    invoices: books.invoices as never,
    credit_notes: books.credit_notes as never,
    debit_notes: books.debit_notes as never,
    bills: books.bills as never,
    expenses: books.expenses as never,
  }), [books])

  const day = useMemo(() => today(), [])
  const base = fyStart()

  // The payroll register, read the same way this one is: from this browser, on load. It is the
  // only place the wage arithmetic lives — this page asks it for (person, month) rows and stores
  // none of the rupees it answers with. An empty register is a fact, not an error: every hour
  // then reads as uncosted, loudly, and the findings point back to /payroll.
  const payroll = useMemo<PayrollStore | null>(() => (orgId ? loadPayroll(orgId) : null), [orgId])

  /** Every (person, month) this register's entries ask about — priced by payroll, or refused with its words. */
  const costs = useMemo<HourCostRow[]>(() => {
    if (!payroll) return []
    const wanted = new Map<string, { employee_id: string; month: string }>()
    for (const e of store.entries) {
      if (!e.employee_id) continue
      const month = periodOf(e.date)
      wanted.set(`${e.employee_id}:${month}`, { employee_id: e.employee_id, month })
    }
    const people = employeeById(payroll.employees)
    const rows: HourCostRow[] = []
    for (const w of wanted.values()) {
      const priced = costPerHourFor(payroll, w.month).find(c => c.employee_id === w.employee_id)
      if (priced) { rows.push(priced); continue }
      // The register kept this person off that month's roster (or never heard of them). Its own
      // sentence says why; the row refuses either way — a guessed wage is the one thing this must not print.
      const person = people.get(w.employee_id)
      rows.push({
        employee_id: w.employee_id, name: person?.name || '', month: w.month,
        cost_per_hour: null, basis: '',
        why: person ? (offRosterWhy(person, w.month) || 'The payroll register has no figure for this month.') : 'Not on the payroll register.',
      })
    }
    return rows
  }, [payroll, store.entries])

  /** The register's answer for every stored row: a rupee, or a refusal carrying its reason. */
  const costMap = useMemo(() => costHours(store.entries, costs), [store.entries, costs])

  /** The people the entry modal offers; the register's own order, by name. */
  const payrollPeople = useMemo(
    () => (payroll ? [...payroll.employees].sort((a, b) => a.name.localeCompare(b.name)) : []),
    [payroll],
  )

  // The day book, read as data the same way the payroll figures above are: this page reads the
  // register's kept marks, `drawHours()` proposes rows, and the page writes only what the shop
  // ticks. Nothing here writes into the book.
  const draw = useMemo<{ result: HoursDraw | null; off: string }>(() => {
    if (!drawForm || !payroll || !drawForm.employee_id) return { result: null, off: '' }
    const project = store.projects.find(p => p.id === drawForm.project_id)
    if (!project || !isMonth(drawForm.month)) return { result: null, off: '' }
    const person = payroll.employees.find(e => e.id === drawForm.employee_id)
    if (!person) return { result: null, off: '' }
    const book = dayBook(payroll, drawForm.month, day)
    const row = book.rows.find(r => r.employee.id === person.id)
    // A person the month's roster does not carry has no page — the register's own sentence says why.
    if (!row) {
      return { result: null, off: offRosterWhy(person, drawForm.month) || `${person.name} has no page in ${monthLabel(drawForm.month)} — the book rules no day for them.` }
    }
    const work: BookWorkDay[] = row.cells.filter(c => c.on_roll).map(c => {
      const w = markWork(c.mark)
      return { date: c.date, mark: c.mark, label: w.label, fraction: w.fraction, why: w.why }
    })
    return {
      off: '',
      result: drawHours(
        work,
        { employee_id: person.id, person: person.name, hours_per_day: person.hours_per_day },
        project, store.projects, store.entries, drawForm.month, day,
      ),
    }
  }, [drawForm, payroll, store.projects, store.entries, day])

  /** The ticked set. Null in the form means the draw's own proposal; a toggle materialises the list. */
  const drawTicks = useMemo(() => {
    if (!draw.result) return new Set<string>()
    return new Set(drawForm?.ticks ?? draw.result.days.filter(d => d.proposed).map(d => d.date))
  }, [drawForm, draw.result])

  const drawTicked = useMemo(
    () => (draw.result ? draw.result.days.filter(d => d.tickable && drawTicks.has(d.date)) : []),
    [draw, drawTicks],
  )
  const drawTickedHours = Math.round(drawTicked.reduce((t, d) => t + d.hours, 0) * 100) / 100

  const views = useMemo(() => sortViews(projectViews(store, docs, day, costs)), [store, docs, day, costs])
  const sum = useMemo(() => summarise(views), [views])

  const allGroups = useMemo(
    () => unbilledGroups(store.projects, store.entries, day),
    [store, day],
  )

  const liveProjects = useMemo(() => views.filter(v => !v.project.archived), [views])

  const visibleViews = useMemo(() => {
    return views.filter(v => {
      if (statusFilter === 'running' && v.entry_count === 0) return false
      if (statusFilter === 'quiet' && v.entry_count > 0) return false
      return matchesAny(search, [v.project.name, v.project.code, v.project.client_name, v.project.notes, BILLING_META[v.project.billing].label])
    })
  }, [views, search, statusFilter])

  /** Entries inside the chosen financial year, newest day first. */
  const periodEntries = useMemo(
    () => store.entries.filter(e => inPeriod(e.date, period, base)),
    [store.entries, period, base],
  )

  const sheetEntries = useMemo(() => {
    const list = periodEntries.filter(e => {
      if (projectFilter !== 'all' && e.project_id !== projectFilter) return false
      return matchesAny(search, [
        e.person, e.note, e.billed_ref,
        store.projects.find(p => p.id === e.project_id)?.name || '',
        store.projects.find(p => p.id === e.project_id)?.code || '',
      ])
    })
    return [...list].sort((a, b) => (a.date === b.date ? a.person.localeCompare(b.person) : a.date < b.date ? 1 : -1))
  }, [periodEntries, projectFilter, search, store.projects])

  /** The named-hours cost inside the rows in view — the strip states it only when the register could. */
  const inViewCost = useMemo(() => {
    let cost = 0
    for (const e of sheetEntries) {
      const c = costMap.get(e.id)
      if (c && c.cost !== null) cost += c.cost
    }
    return Math.round(cost * 100) / 100
  }, [sheetEntries, costMap])

  const groupRows = useMemo(() => {
    const scoped = new Set(periodEntries.map(e => e.id))
    return allGroups.filter(g => {
      if (!g.entries.some(e => scoped.has(e.id))) return false
      if (projectFilter !== 'all' && g.project_id !== projectFilter) return false
      return matchesAny(search, [g.project, g.client, g.period_label])
    })
  }, [allGroups, periodEntries, projectFilter, search])

  const groupedByProject = useMemo(() => {
    const map = new Map<string, UnbilledGroup[]>()
    for (const g of allGroups) {
      const list = map.get(g.project_id)
      if (list) list.push(g)
      else map.set(g.project_id, [g])
    }
    return map
  }, [allGroups])

  const attachedIds = useMemo(() => new Set(store.tags.map(t => t.doc_id)), [store.tags])
  const openDocs = useMemo(
    () => docs.filter(d => inPeriod(d.date, period, base) && (projectFilter === 'all' || store.tags.some(t => t.doc_id === d.id && t.project_id === projectFilter))),
    [docs, period, base, projectFilter, store.tags],
  )
  const unattached = useMemo(() => openDocs.filter(d => !attachedIds.has(d.id)), [openDocs, attachedIds])

  const invoiceNumbers = useMemo(
    () => [...new Set(docs.filter(d => d.kind === 'invoice').map(d => d.number))].sort(),
    [docs],
  )

  const series = useMemo(() => monthlySeries(periodEntries, store.projects, 6), [periodEntries, store.projects])
  const people = useMemo(() => personSeries(periodEntries, store.projects), [periodEntries, store.projects])

  // ── actions ─────────────────────────────────────────────────────────────────

  function flash(message: string) { setNotice({ msg: message, bad: false }) }
  function warn(message: string) { setNotice({ msg: message, bad: true }) }

  function openEditor(project: Project, isNew: boolean) {
    setEditor({ project, isNew })
    setEditorError('')
  }

  function patchEditor(patch: Partial<Project>) {
    setEditor(e => (e ? { ...e, project: { ...e.project, ...patch } } : e))
  }

  function saveProject() {
    if (!editor) return
    const errs = validateProject(editor.project, store.projects)
    if (errs.length) { setEditorError(errs[0]); return }
    const next = upsertProject(orgId, editor.project)
    setStore(next)
    setEditor(null)
    flash(editor.isNew ? `${editor.project.name} added to the register.` : `${editor.project.name} updated.`)
  }

  function openEntry(projectId: string, entry?: TimeEntry) {
    const project = projectId || liveProjects[0]?.project.id || editor?.project.id || ''
    const row = entry || newEntry(project, today())
    setEntryForm({ entry: { ...row, project_id: entry ? row.project_id : (projectId || row.project_id) }, isNew: !entry, hoursText: String(row.hours), rateText: row.rate > 0 ? String(row.rate) : '' })
    setEntryError('')
  }

  function patchEntry(patch: Partial<EntryState>) {
    setEntryForm(f => (f ? { ...f, ...patch, entry: patch.entry ? { ...f.entry, ...patch.entry } : f.entry } : f))
  }

  function saveEntry() {
    if (!entryForm) return
    const draft = toEntry(entryForm)
    const errs = validateEntry(draft, store.projects, today())
    if (errs.length) { setEntryError(errs[0]); return }
    const next = upsertEntry(orgId, draft)
    setStore(next)
    setEntryForm(null)
    flash(entryForm.isNew ? `${hours(draft.hours)} logged on ${formatDateIN(draft.date)}.` : 'The day was updated.')
  }

  function removeEntry(e: TimeEntry) {
    setStore(deleteEntry(orgId, e.id))
    flash(`${hours(e.hours)} removed from the register.`)
  }

  // ── the draw ────────────────────────────────────────────────────────────────

  function openDraw(projectId: string) {
    setDrawForm({
      project_id: projectId || (projectFilter !== 'all' ? projectFilter : '') || liveProjects[0]?.project.id || '',
      employee_id: '',
      month: day.slice(0, 7),
      ticks: null,
    })
    setDrawError('')
  }

  /** Any change of project, person or month re-proposes: back to the draw's own ticks. */
  function pickDraw(patch: Partial<DrawState>) {
    setDrawForm(f => (f ? { ...f, ...patch, ticks: null } : f))
    setDrawError('')
  }

  function toggleDrawDay(date: string) {
    if (!drawForm || !draw.result) return
    const current = new Set(drawForm.ticks ?? draw.result.days.filter(d => d.proposed).map(d => d.date))
    if (current.has(date)) current.delete(date)
    else current.add(date)
    setDrawForm({ ...drawForm, ticks: [...current].sort() })
  }

  function applyDraw() {
    if (!drawForm || !draw.result) return
    const project = store.projects.find(p => p.id === drawForm.project_id)
    if (!project) return
    if (!drawTicked.length) { setDrawError('Tick at least one day — a draw with no day on it writes nothing.'); return }
    const rows: TimeEntry[] = []
    const refused: string[] = []
    for (const d of drawTicked) {
      const row: TimeEntry = {
        ...newEntry(project.id, d.date),
        person: draw.result.person,
        employee_id: draw.result.employee_id,
        hours: d.hours,
        note: `Drawn from the day book — ${d.date} marked ${d.mark}${d.label ? ` (${d.label})` : ''}.`,
      }
      // Every drawn day passes the register's own validator, like any hand-typed row — a draw
      // cannot write an entry the form would have refused.
      const errs = validateEntry(row, store.projects, day)
      if (errs.length) { refused.push(`${formatDateIN(d.date)}: ${errs[0]}`); continue }
      rows.push(row)
    }
    if (!rows.length) { setDrawError(refused.join(' ') || 'Nothing on the draw could be written.'); return }
    setStore(upsertEntries(orgId, rows))
    setDrawForm(null)
    const total = Math.round(rows.reduce((t, e) => t + e.hours, 0) * 100) / 100
    flash(`${plural(rows.length, 'day')} — ${hours(total)} — drawn onto ${project.name || project.code} from the day book${refused.length ? `. ${refused.length} refused: ${refused[0]}` : '.'}`)
  }

  function changeStatus(v: ProjectView, status: Project['status']) {
    setStore(setProjectStatus(orgId, v.project.id, status))
    flash(`${v.project.name} is now ${STATUS_META[status].label.toLowerCase()}.`)
  }

  function removeProject(v: ProjectView) {
    const res = deleteProject(orgId, v.project.id)
    if (!res.ok) { warn(res.error); return }
    setStore(res.store)
    flash(`${v.project.name} deleted — it carried no hours and no documents.`)
  }

  function applyBilled() {
    if (!billFor) return
    const ref = billFor.ref.trim()
    if (!ref) { warn('Type the invoice number these hours went onto. A blank reference would put them back on the unbilled register.'); return }
    const next = markBilled(orgId, billFor.ids, ref)
    setStore(next)
    setBillFor(null)
    setPicked([])
    const known = invoiceNumbers.includes(ref)
    flash(`${billFor.ids.length} ${pluralNoun(billFor.ids.length, 'row')} now ${billFor.ids.length === 1 ? 'points' : 'point'} at ${ref}${known ? '' : ' — no invoice by that number is in your books yet, so the register will flag it until you raise one at /invoices'}.`)
  }

  function unbilledNow(ids: string[]) {
    const next = markUnbilled(orgId, ids)
    setStore(next)
    setPicked([])
    flash(`${ids.length} ${ids.length === 1 ? 'row is' : 'rows are'} back on the unbilled register.`)
  }

  function attach(projectId: string, list: BookDoc[]) {
    if (!list.length) return
    const next = bulkTag(orgId, projectId, list)
    setStore(next)
    setPicked([])
    flash(`${plural(list.length, 'document')} attached to ${store.projects.find(p => p.id === projectId)?.name || 'the project'}. The rupees are read from the books, not copied here.`)
  }

  function forget(docId: string) {
    const tag = store.tags.find(t => t.doc_id === docId)
    if (!tag) return
    setStore(removeTag(orgId, tag.id))
    flash('Detached. The document is untouched in the books.')
  }

  async function copyLine(g: UnbilledGroup) {
    const project = store.projects.find(p => p.id === g.project_id)
    const text = invoiceLineText(g, project)
    try {
      await navigator.clipboard.writeText(text)
      flash('Copied. Paste it as the line at /invoices/new — the invoice is raised there, through the write path that gives it a real number.')
    } catch {
      warn(`The clipboard is not available in this browser. The line reads: ${text}`)
    }
  }

  // ── exports ─────────────────────────────────────────────────────────────────

  function exportRegister() {
    download('projects.csv', toCsv(PROJECT_CSV_HEADERS, projectCsvRows(visibleViews)))
  }
  function exportTimesheet() {
    download('timesheet.csv', toCsv(ENTRY_CSV_HEADERS, entryCsvRows({ ...store, entries: sheetEntries }, day, costs)))
  }
  function exportUnbilled() {
    download('unbilled-work.csv', toCsv(UNBILLED_CSV_HEADERS, unbilledCsvRows(groupRows)))
  }

  // ── the screen ──────────────────────────────────────────────────────────────

  const noBooks = !loading && docs.length === 0
  const lateGroups = allGroups.filter(g => g.state === 'overdue')
  const dueGroups = allGroups.filter(g => g.state === 'due_soon')
  const attention = views.filter(v => v.findings.length)
  const maxRevenue = Math.max(1, ...views.map(v => Math.abs(v.revenue)))
  const maxCost = Math.max(1, ...views.map(v => Math.abs(v.cost)))

  if (loading) {
    return <div className="page-container pj"><p className="pj-load">Reading your books and this browser’s project register…</p></div>
  }

  return (
    <div className="page-container pj" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`${orgName.toUpperCase() || 'TAXFLOW'} · ${period === 'all' ? 'ALL TIME' : `FY ${fyLabel(period === 'this_fy' ? base : base - 1)}`}`}
        title="Projects & time"
        subtitle="Hours logged against a job, the documents it earned, and the months of work that still have no invoice on them. Rupees come out of your books on every load — this register stores measurements, never amounts."
        actions={
          <>
            <Button variant="ghost" size="sm" icon="download" onClick={exportRegister} disabled={visibleViews.length === 0}>Register CSV</Button>
            <Button variant="ghost" size="sm" icon="download" onClick={exportTimesheet} disabled={sheetEntries.length === 0}>Timesheet CSV</Button>
            <Button icon="plus" onClick={() => openEditor(newProject(), true)}>New project</Button>
          </>
        }
      />

      <div className="pj-stats">
        <StatCard
          label="Hours on the register" value={hours(sum.hours)}
          sub={`${plural(sum.entries, 'logged day')} · ${money(sum.labour_value)} at your recorded rates`}
          icon="clock" tone="blue" delay={0}
        />
        <StatCard
          label="Work not yet billed" value={money(sum.unbilled_value)}
          sub={sum.unbilled_hours > 0 ? `${hours(sum.unbilled_hours)} across ${plural(allGroups.length, 'project-month')}` : 'every logged hour is on an invoice'}
          icon={sum.unbilled_hours > 0 ? 'invoice' : 'check'} tone={sum.unbilled_hours > 0 ? 'amber' : 'green'} delay={40}
        />
        <StatCard
          label={`Past the ${SERVICE_INVOICE_DAYS}-day window`} value={String(lateGroups.length)}
          sub={lateGroups.length
            ? `${money(sum.at_risk)} of work, the oldest supplied ${lateGroups.map(g => g.earliest).sort()[0]}`
            : dueGroups.length ? `${plural(dueGroups.length, 'month')} due within ${DUE_SOON_DAYS} days` : 'nothing is late paperwork'}
          icon={lateGroups.length ? 'alert' : 'shield'} tone={lateGroups.length ? 'red' : dueGroups.length ? 'amber' : 'green'} delay={80}
        />
        <StatCard
          label="Contribution from the books" value={money(sum.contribution)}
          sub={`${money(sum.revenue)} billed · ${money(sum.cost)} spent · ${plural(liveProjects.length, 'live project')}${sum.unpriced_hours > 0 ? ` · ${hours(sum.unpriced_hours)} unpriced` : ''}${sum.costed_hours > 0 ? ` · after named hours ${money(sum.after_labour)}${sum.costed_hours < sum.hours ? ', partial' : ''}` : ''}`}
          icon="scale" tone={sum.contribution >= 0 ? 'violet' : 'red'} delay={120}
        />
      </div>

      <div className="pj-toolbar">
        <Segmented options={TABS} value={tab} onChange={v => { setTab(v as Tab); setPicked([]) }} />
        {tab === 'projects' && (
          <Segmented options={STATUS_FILTERS} value={statusFilter} onChange={v => setStatusFilter(v as StatusFilter)} />
        )}
        {(tab === 'timesheet' || tab === 'tobill' || tab === 'documents') && (
          <label className="pj-select">
            <span>Project</span>
            <select className="tf-input" value={projectFilter} onChange={e => setProjectFilter(e.target.value)}>
              <option value="all">All projects</option>
              {store.projects.map(p => <option key={p.id} value={p.id}>{p.name || p.code || 'Untitled'}</option>)}
            </select>
          </label>
        )}
        <select className="tf-input pj-period" value={period} onChange={e => setPeriod(e.target.value as Period)} aria-label="Period">
          {PERIODS.map(p => <option key={p.value} value={p.value}>{p.value === 'all' ? 'All time' : `${p.label} · FY ${fyLabel(p.value === 'this_fy' ? base : base - 1)}`}</option>)}
        </select>
        <SearchInput value={search} onChange={setSearch} placeholder="Project, code, client or person…"
          ariaLabel="Search projects" style={{ flex: '1 1 200px', maxWidth: 300, marginLeft: 'auto' }} />
      </div>

      {notice && (
        <div className={`pj-notice ${notice.bad ? 'is-bad' : ''}`} role="status">
          <Icon name={notice.bad ? 'alert' : 'check'} size={14} strokeWidth={notice.bad ? 2.2 : 2.4} />
          <span>{notice.msg}</span>
          <button type="button" className="pj-notice-x" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="x" size={13} />
          </button>
        </div>
      )}

      {error && (
        <div className="pj-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{error}</div>
      )}

      {noBooks && (
        <div className="pj-note">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            Your books have no invoice or bill to attach yet, so every rupee column below is empty — hours still count, because they are measured here
            rather than read. Start at <Link href="/invoices">invoices</Link> or <Link href="/bills">bills</Link> and this page will price the job against them.
          </span>
        </div>
      )}

      {lateGroups.length > 0 && tab !== 'tobill' && (
        <div className="pj-note is-hot">
          <Icon name="alert" size={14} strokeWidth={2.2} />
          <span>
            <strong>{lateGroups.length} project-month{lateGroups.length === 1 ? ' is' : 's are'} past the rule 47 window</strong> — {money(sum.at_risk)} of delivered work with no invoice on it.
            {' '}<button type="button" className="pj-inline" onClick={() => setTab('tobill')}>Open the unbilled register</button>.
          </span>
        </div>
      )}

      {attention.length > 0 && tab === 'projects' && (
        <div className="pj-note">
          <Icon name="shield" size={13} strokeWidth={2.2} />
          <span>
            {attention.length} project{attention.length === 1 ? ' has' : 's have'} something to check —{' '}
            {attention.map((v, i) => (
              <span key={v.project.id}>
                <button type="button" className="pj-inline" onClick={() => setOpenProject(v.project.id)}>
                  {v.project.name || v.project.code || 'Untitled'}
                </button>
                {i < attention.length - 1 ? ', ' : '. '}
              </span>
            ))}
            Each prints its reason on the card, and none of them is a tax figure — this page names the document owed and the date it was owed by;
            the amount is your return’s business at <Link href="/gst/gstr3b">GSTR-3B</Link>.
          </span>
        </div>
      )}

      {/* ── Projects ─────────────────────────────────────────────────────────── */}
      {tab === 'projects' && (
        visibleViews.length === 0 ? (
          <Card>
            <EmptyState
              icon="clipboard"
              title={store.projects.length ? 'No project in this search' : 'No project yet'}
              message={store.projects.length
                ? 'Clear the search to see the whole register.'
                : 'A project is any piece of work you want hours and rupees attached to — a site fit-out, an audit, a retainer, an internal build. Nothing is charged until you log an hour or attach a document.'}
              action={!store.projects.length
                ? <Button size="sm" icon="plus" onClick={() => openEditor(newProject(), true)}>New project</Button>
                : undefined}
            />
          </Card>
        ) : (
          <div className="pj-grid">
            {visibleViews.map(v => {
              const p = v.project
              const open = openProject === p.id
              const groups = groupedByProject.get(p.id) || []
              const mine = store.entries.filter(e => e.project_id === p.id)
              const mySeries = monthlySeries(mine, store.projects, 6)
              const rate = p.hourly_rate > 0 ? `${money(p.hourly_rate)} / h` : 'no default rate'
              return (
                <div key={p.id} className={`pj-card ${p.archived ? 'is-archived' : ''} ${v.findings.length ? 'is-flagged' : ''}`}>
                  <div className="pj-card-head">
                    <div className="pj-card-title">
                      <span className="pj-card-name"><Icon name="clipboard" size={15} />{p.name || p.code || 'Untitled project'}</span>
                      <span className="pj-card-sub">
                        {p.code ? `${p.code} · ` : ''}{BILLING_META[p.billing].label}{p.client_name ? ` · ${p.client_name}` : ''}
                      </span>
                    </div>
                    <div className="pj-card-badges">
                      <Badge tone={STATUS_META[p.status].tone}>{STATUS_META[p.status].label}</Badge>
                      {groups.some(g => g.state === 'overdue') && <Badge tone="red">{groups.filter(g => g.state === 'overdue').length} late</Badge>}
                      {invoiceWindow(p.billing) === null && <Badge tone="grey" dot={false}>Not billable</Badge>}
                    </div>
                  </div>

                  <div className="pj-bars">
                    <div className="pj-bar-row">
                      <span className="pj-bar-label">Billed</span>
                      <ProgressBar value={Math.abs(v.revenue) / maxRevenue * 100} color="var(--brand)" height={6} />
                      <span className="pj-bar-num">{money(v.revenue)}</span>
                    </div>
                    <div className="pj-bar-row">
                      <span className="pj-bar-label">Spend</span>
                      <ProgressBar value={Math.abs(v.cost) / maxCost * 100} color="var(--cyan)" height={6} />
                      <span className="pj-bar-num">{money(v.cost)}</span>
                    </div>
                  </div>

                  <div className="pj-card-stats">
                    <StatRow label="Hours logged" value={hours(v.hours)} />
                    <StatRow label={`Hour value (${rate})`} value={money(v.labour_value)} />
                    {v.costed_hours > 0 && <StatRow label="Cost of named hours" value={money(v.labour_cost)} />}
                    <StatRow label="Unbilled" tone={v.unbilled_value > 0 ? 'amber' : undefined} value={v.unbilled_value ? `${money(v.unbilled_value)} · ${hours(v.unbilled_hours)}` : '—'} />
                    <StatRow label="Documents attached" value={v.doc_count ? `${v.doc_count}${v.orphans ? ` (+${v.orphans} orphan)` : ''}` : '—'} />
                    <StatRow label="Contribution" tone={v.contribution >= 0 ? 'green' : 'red'} value={money(v.contribution)} strong />
                    {v.costed_hours > 0 && (
                      <StatRow label="After named hours" tone={v.after_labour >= 0 ? undefined : 'red'} strong
                        value={<>{money(v.after_labour)}{v.costed_hours < v.hours ? <span className="pj-muted"> · partial</span> : null}</>} />
                    )}
                  </div>

                  {v.findings.length > 0 && (
                    <ul className="pj-findings">
                      {v.findings.map((f, i) => (
                        <li key={i} className={`pj-finding is-${f.tone}`}>
                          <Icon name={f.tone === 'red' ? 'alert' : f.tone === 'amber' ? 'clock' : 'compare'} size={13} />
                          <span>{f.text}{f.href && <>&nbsp;<Link href={f.href}>{f.link}</Link></>}</span>
                        </li>
                      ))}
                    </ul>
                  )}

                  <div className="pj-card-actions">
                    <Button size="sm" icon="plus" onClick={() => openEntry(p.id)} disabled={p.archived}>Log time</Button>
                    <Button size="sm" variant="ghost" icon="edit" onClick={() => openEditor(p, false)}>Edit</Button>
                    <Button size="sm" variant="ghost" icon="tag" onClick={() => { setAttachFor(p.id); setTab('documents') }}>Attach</Button>
                    <Button size="sm" variant="subtle" onClick={() => setOpenProject(open ? '' : p.id)}>
                      {open ? 'Hide detail' : 'Detail'}
                    </Button>
                  </div>

                  {open && (
                    <div className="pj-detail">
                      <div className="pj-detail-block">
                        <p className="pj-detail-title">Hours by month</p>
                        {mySeries.length ? (
                          <BarChart data={mySeries.map((s: MonthBucket) => ({ label: s.label, value: s.hours, sublabel: `${money(s.value)}` }))} height={92} color="var(--brand)" format={v => `${v} h`} />
                        ) : <p className="pj-muted">Nothing logged on this project yet.</p>}
                      </div>
                      <div className="pj-detail-block">
                        <p className="pj-detail-title">Unbilled work</p>
                        {groups.length ? (
                          <ul className="pj-mini">
                            {groups.map(g => (
                              <li key={g.key}>
                                <span>{g.period_label}</span>
                                <span className="pj-mini-num">{hours(g.hours)}</span>
                                <span className="pj-mini-num">{money(g.value)}</span>
                                <Badge tone={WATCH_META[g.state].tone} dot={false}>{WATCH_META[g.state].label}</Badge>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="pj-muted">Every logged hour is on an invoice reference.</p>}
                      </div>
                      <div className="pj-detail-rows">
                        <StatRow label="Started" value={p.start_date ? formatDateIN(p.start_date) : '—'} />
                        <StatRow label="Planned end" value={p.target_date ? formatDateIN(p.target_date) : 'open-ended'} />
                        {p.budget_value > 0 && <StatRow label="Budget used" tone={v.over_budget ? 'red' : undefined} value={v.budget_used_pct === null ? '—' : `${v.budget_used_pct}% of ${money(p.budget_value)}`} />}
                        <StatRow label="Last hour logged" value={v.days_since_last === null ? 'never' : v.days_since_last <= 1 ? 'yesterday or today' : `${v.days_since_last} days ago`} />
                        {v.unmatched_refs.length > 0 && <StatRow label="References with no invoice" tone="amber" value={v.unmatched_refs.join(', ')} />}
                        {p.notes && <StatRow label="Notes" value={p.notes} />}
                      </div>
                      <div className="pj-detail-actions">
                        {p.status !== 'archived' && (
                          <select className="tf-input" value={p.status} onChange={e => changeStatus(v, e.target.value as Project['status'])} aria-label="Project status">
                            {PROJECT_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                          </select>
                        )}
                        <Button size="sm" variant="ghost" icon="download" onClick={() => download(`${(p.code || p.name || 'project').replace(/\W+/g, '-')}-hours.csv`, toCsv(ENTRY_CSV_HEADERS, entryCsvRows({ ...store, entries: mine }, day, costs)))} disabled={!mine.length}>Hours CSV</Button>
                        <Button size="sm" variant="danger" icon="x" onClick={() => removeProject(v)}>Delete</Button>
                      </div>
                      <p className="pj-hint">{STATUS_META[p.status].note} {BILLING_META[p.billing].note}</p>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      )}

      {/* ── Timesheet ────────────────────────────────────────────────────────── */}
      {tab === 'timesheet' && (
        <>
          {sheetEntries.length === 0 ? (
            <Card>
              <EmptyState
                icon="clock"
                title={store.entries.length ? 'No hour in this window' : 'No time logged yet'}
                message={store.entries.length
                  ? 'Widen the period, clear the search, or pick another project.'
                  : 'An entry is a day, a person, and how long they were on the job. The rate is what the hour is billed at — leave it blank to inherit the project’s.'}
                action={liveProjects.length ? (
                  <div className="pj-empty-actions">
                    <Button size="sm" icon="plus" onClick={() => openEntry(projectFilter !== 'all' ? projectFilter : '')}>Log time</Button>
                    <Button size="sm" variant="ghost" icon="book" onClick={() => openDraw(projectFilter !== 'all' ? projectFilter : '')}>Draw from the day book</Button>
                  </div>
                ) : undefined}
              />
            </Card>
          ) : (
            <>
              <div className="pj-bulk">
                <label className="pj-check-all">
                  <input type="checkbox" checked={picked.length > 0 && picked.length === sheetEntries.length}
                    onChange={e => setPicked(e.target.checked ? sheetEntries.map(x => x.id) : [])} />
                  <span>Select all in view</span>
                </label>
                <strong className="pj-bulk-count">{picked.length ? `${picked.length} selected · ${hours(sheetEntries.filter(e => picked.includes(e.id)).reduce((t, e) => t + e.hours, 0))}` : `${plural(sheetEntries.length, 'row')}`}</strong>
                <span className="pj-bulk-total">{money(periodEntries.reduce((t, e) => {
                  const p = store.projects.find(x => x.id === e.project_id)
                  return t + (p ? e.hours * rateOf(e, p) : 0)
                }, 0))} of hours in view{inViewCost > 0 ? ` · ${money(inViewCost)} named-hour cost` : ''}</span>
                {picked.length > 0 && <Button size="sm" icon="invoice" onClick={() => setBillFor({ ids: picked, ref: '' })}>Mark billed</Button>}
                {picked.length > 0 && <Button size="sm" variant="ghost" icon="undo" onClick={() => unbilledNow(picked)}>Un-bill</Button>}
                <Button size="sm" variant="subtle" icon="plus" onClick={() => openEntry(projectFilter !== 'all' ? projectFilter : '')}>Log time</Button>
                <Button size="sm" variant="ghost" icon="book" onClick={() => openDraw(projectFilter !== 'all' ? projectFilter : '')}>Draw from the day book</Button>
              </div>

              <div className="table-frame">
                <div className="table-scroll">
                  <div className="pj-head pj-cols">
                    <span className="pj-lead">Day / project</span>
                    <span>Who</span>
                    <span className="is-right">Hours</span>
                    <span className="is-right">Rate</span>
                    <span className="is-right">Value</span>
                    <span className="is-right">Cost</span>
                    <span>Billed on</span>
                    <span>Window</span>
                    <span className="is-right">Actions</span>
                  </div>
                  {sheetEntries.map(e => {
                    const p = store.projects.find(x => x.id === e.project_id)
                    if (!p) return null
                    const v = rateOf(e, p)
                    const val = v > 0 ? Math.round(e.hours * v * 100) / 100 : 0
                    const c = costMap.get(e.id)
                    const g = !e.billed_ref ? allGroups.find(x => x.key === `${p.id}:${e.date.slice(0, 7)}`) : undefined
                    const w = g ? WATCH_META[g.state] : e.billed_ref ? { label: 'Billed', tone: 'green' as const } : { label: '—', tone: 'grey' as const }
                    const checked = picked.includes(e.id)
                    return (
                      <div key={e.id} className={`pj-tr pj-cols ${checked ? 'is-picked' : ''}`}>
                        <span className="pj-lead" data-label="Day">
                          <input type="checkbox" checked={checked} onChange={ev => setPicked(ev.target.checked ? [...picked, e.id] : picked.filter(x => x !== e.id))} aria-label={`Select ${e.date}`} />
                          <span className="pj-day">
                            <strong>{formatDateIN(e.date)}</strong>
                            <em>{p.name || p.code}{p.client_name ? ` · ${p.client_name}` : ''}</em>
                          </span>
                        </span>
                        <span data-label="Who">{c?.name || e.person || '—'}{e.note ? <em className="pj-noteline">{e.note}</em> : null}</span>
                        <span className="is-right pj-num" data-label="Hours">{hours(e.hours)}</span>
                        <span className="is-right pj-num" data-label="Rate">{v > 0 ? money(v) : 'none'}</span>
                        <span className="is-right pj-num" data-label="Value">{v > 0 ? money(val) : '—'}</span>
                        <span className="is-right pj-num" data-label="Cost">{c && c.cost !== null
                          ? money(c.cost)
                          : <span className="pj-muted" title={c?.why || undefined}>{c?.linked ? 'no figure' : '—'}</span>}</span>
                        <span data-label="Billed on">{e.billed_ref
                          ? <Link href={`/invoices?q=${encodeURIComponent(e.billed_ref)}`}>{e.billed_ref}</Link>
                          : <span className="pj-muted">unbilled</span>}</span>
                        <span data-label="Window"><Badge tone={w.tone} dot={false}>{w.label}</Badge>{g && g.state !== 'no_window' && (
                          <em className="pj-due">{g.state === 'overdue' ? `${g.days_over} d past ${g.due_date}` : `${g.due_date}`}</em>
                        )}</span>
                        <span className="is-right pj-row-actions" data-label="Actions">
                          <button type="button" className="pj-act" onClick={() => openEntry(p.id, e)} aria-label={`Edit ${e.date}`}>Edit</button>
                          <button type="button" className="pj-act is-bad" onClick={() => removeEntry(e)} aria-label={`Delete ${e.date}`}>Delete</button>
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="pj-strip">
                {people.length > 0 && (
                  <Card pad>
                    <p className="pj-detail-title">Hours by person, in view</p>
                    <ul className="pj-mini">
                      {people.slice(0, 8).map(x => (
                        <li key={x.person}>
                          <span>{x.person}</span>
                          <span className="pj-mini-num">{hours(x.hours)}</span>
                          <span className="pj-mini-num">{money(x.value)}</span>
                          <span className="pj-muted">{plural(x.entries, 'row')}</span>
                        </li>
                      ))}
                    </ul>
                  </Card>
                )}
                {series.length > 0 && (
                  <Card pad>
                    <p className="pj-detail-title">The register by month</p>
                    <BarChart data={series.map(s => ({ label: s.label, value: s.hours, sublabel: money(s.value) }))} height={92} color="var(--violet)" format={v => `${v} h`} />
                    <p className="pj-hint">{money(series.reduce((t, s) => t + s.billed, 0))} of the {money(series.reduce((t, s) => t + s.value, 0))} priced above already sits on an invoice reference.</p>
                  </Card>
                )}
              </div>
            </>
          )}
        </>
      )}

      {/* ── To bill ──────────────────────────────────────────────────────────── */}
      {tab === 'tobill' && (
        <>
          <div className="pj-note">
            <Icon name="book" size={14} />
            <span>
              One row is one project’s unbilled work inside one calendar month, because that is the shape the invoice takes.
              The clock runs from the <em>oldest supply day</em> in the row: rule 47 gives {SERVICE_INVOICE_DAYS} days from the date of supply to issue the invoice for services.
              Nothing here raises it — copy the line to <Link href="/invoices/new">/invoices/new</Link>.
            </span>
          </div>

          {groupRows.length === 0 ? (
            <Card>
              <EmptyState
                icon="check"
                title={store.entries.length ? 'Nothing sits unbilled' : 'No hours to bill'}
                message={store.entries.length
                  ? 'Every logged hour in this window carries an invoice reference. That reference is a note that you raised the paper elsewhere — this page does not raise it.'
                  : 'Log hours on the Timesheet tab and the months that have no invoice on them appear here.'}
              />
            </Card>
          ) : (
            <>
              <div className="pj-bulk">
                <strong className="pj-bulk-count">{plural(groupRows.length, 'project-month')}</strong>
                <span className="pj-bulk-total">{money(groupRows.reduce((t, g) => t + g.value, 0))} unbilled · {hours(groupRows.reduce((t, g) => t + g.hours, 0))} · {groupRows.filter(g => g.state === 'overdue').length} past the window</span>
                <Button size="sm" variant="ghost" icon="download" onClick={exportUnbilled}>Unbilled CSV</Button>
              </div>
              <div className="table-frame">
                <div className="table-scroll">
                  <div className="pj2-head pj2-cols">
                    <span className="pj-lead">Project / month</span>
                    <span className="is-right">Hours</span>
                    <span className="is-right">Value</span>
                    <span>Oldest supply</span>
                    <span>Invoice due</span>
                    <span>State</span>
                    <span className="is-right">Actions</span>
                  </div>
                  {groupRows.map(g => {
                    const open = openGroup === g.key
                    const p = store.projects.find(x => x.id === g.project_id)
                    const w = WATCH_META[g.state]
                    return (
                      <div key={g.key} className={`pj2-wrap ${g.state === 'overdue' ? 'is-hot' : ''}`}>
                        <div className="pj2-tr pj2-cols">
                          <span className="pj-lead" data-label="Project">
                            <strong>{g.project}</strong>
                            <em>{g.period_label}{g.client ? ` · ${g.client}` : ''} · {BILLING_META[g.billing].label}</em>
                          </span>
                          <span className="is-right pj-num" data-label="Hours">{hours(g.hours)}</span>
                          <span className="is-right pj-num" data-label="Value">{g.value > 0 ? money(g.value) : '—'}</span>
                          <span data-label="Oldest supply">{formatDateIN(g.earliest)}</span>
                          <span data-label="Invoice due">{g.due_date ? formatDateIN(g.due_date) : 'no invoice due'}</span>
                          <span data-label="State">
                            <Badge tone={w.tone} dot={false}>{w.label}</Badge>
                            {g.state === 'overdue' && <em className="pj-due">{g.days_over} days past</em>}
                            {g.state === 'due_soon' && <em className="pj-due">{g.days_left} days left</em>}
                          </span>
                          <span className="is-right pj-row-actions" data-label="Actions">
                            <button type="button" className="pj-act" onClick={() => setOpenGroup(open ? '' : g.key)}>{open ? 'Hide' : 'Rows'}</button>
                            <button type="button" className="pj-act" onClick={() => copyLine(g)}>Copy line</button>
                            {g.entries.length > 0 && <button type="button" className="pj-act" onClick={() => { setPicked(g.entries.map(e => e.id)); setTab('timesheet'); flash(`${plural(g.entries.length, 'row')} from ${g.period_label} selected — Mark billed stamps them with the invoice you raise.`) }}>Select rows</button>}
                          </span>
                        </div>
                        {open && (
                          <div className="pj2-detail">
                            <p className={`pj2-said is-${w.tone}`}><Icon name="clock" size={13} />{watchSentence(g)}</p>
                            {g.unpriced_hours > 0 && (
                              <p className="pj2-said is-flat"><Icon name="compare" size={13} />{hours(g.unpriced_hours)} of this month have no rate recorded anywhere, so no rupee figure is stated for them.</p>
                            )}
                            <ul className="pj2-rows">
                              {g.entries.map(e => {
                                const v = p ? rateOf(e, p) : 0
                                return (
                                  <li key={e.id}>
                                    <span>{formatDateIN(e.date)}</span>
                                    <span>{e.person}</span>
                                    <span className="pj-mini-num">{hours(e.hours)}</span>
                                    <span className="pj-mini-num">{v > 0 ? money(v) : 'no rate'}</span>
                                    <span className="pj-mini-num">{v > 0 ? money(Math.round(e.hours * v * 100) / 100) : '—'}</span>
                                  </li>
                                )
                              })}
                            </ul>
                            <div className="pj2-actions">
                              <Button size="sm" variant="ghost" icon="arrow-right" href="/invoices/new">Raise the invoice at /invoices</Button>
                              {p && <Button size="sm" variant="subtle" icon="edit" onClick={() => openEntry(p.id, { ...newEntry(p.id, g.earliest), person: g.entries[0]?.person || '' })}>Add a day to this month</Button>}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ── Documents ────────────────────────────────────────────────────────── */}
      {tab === 'documents' && (
        <>
          {store.projects.length === 0 ? (
            <Card>
              <EmptyState icon="clipboard" title="No project to attach to"
                message="A project is what the document belongs to. Add one and the whole book becomes attachable."
                action={<Button size="sm" icon="plus" onClick={() => openEditor(newProject(), true)}>New project</Button>} />
            </Card>
          ) : (
            <>
              <div className="pj-bulk">
                <label className="pj-select">
                  <span>Attach to</span>
                  <select className="tf-input" value={attachFor} onChange={e => setAttachFor(e.target.value)}>
                    <option value="">Choose a project…</option>
                    {liveProjects.map(v => <option key={v.project.id} value={v.project.id}>{v.project.name || v.project.code}</option>)}
                  </select>
                </label>
                <strong className="pj-bulk-count">{picked.length ? `${picked.length} selected` : `${plural(unattached.length, 'document')} not on any project`}</strong>
                {picked.length > 0 && attachFor && (
                  <Button size="sm" icon="tag" onClick={() => attach(attachFor, openDocs.filter(d => picked.includes(d.id)))}>Attach {picked.length}</Button>
                )}
                {attachFor && (
                  <Button size="sm" variant="ghost" onClick={() => {
                    const list = openDocs.filter(d => !attachedIds.has(d.id))
                    if (!list.length) { flash('Nothing left to attach in this window.'); return }
                    attach(attachFor, list)
                  }}>Attach everything unattached</Button>
                )}
                <span className="pj-bulk-total">{money(openDocs.filter(d => d.kind === 'invoice').reduce((t, d) => t + d.taxable, 0))} billed in view</span>
              </div>

              <div className="table-frame">
                <div className="table-scroll">
                  <div className="pj3-head pj3-cols">
                    <span className="pj-lead">Document</span>
                    <span>Party</span>
                    <span className="is-right">Taxable</span>
                    <span className="is-right">Tax</span>
                    <span>Project</span>
                    <span className="is-right">Actions</span>
                  </div>
                  {openDocs.map(d => {
                    const tags = store.tags.filter(t => t.doc_id === d.id)
                    const checked = picked.includes(d.id)
                    return (
                      <div key={`${d.kind}-${d.id}`} className={`pj3-tr pj3-cols ${!tags.length ? 'is-plain' : ''}`}>
                        <span className="pj-lead" data-label="Document">
                          <input type="checkbox" checked={checked} onChange={ev => setPicked(ev.target.checked ? [...picked, d.id] : picked.filter(x => x !== d.id))} aria-label={`Select ${d.number}`} />
                          <span className="pj-day">
                            <strong>{d.number || '(no number)'}</strong>
                            <em>{formatDateIN(d.date)} · {d.kind === 'expense' ? 'Expense' : d.kind.replace('_', ' ')}</em>
                          </span>
                        </span>
                        <span data-label="Party">{d.party || '—'}</span>
                        <span className="is-right pj-num" data-label="Taxable">{money(d.taxable)}</span>
                        <span className="is-right pj-num" data-label="Tax">{money(d.tax)}</span>
                        <span data-label="Project">
                          {tags.length
                            ? tags.map(t => <Badge key={t.id} tone="blue" dot={false}>{store.projects.find(p => p.id === t.project_id)?.name || 'gone'}<button type="button" className="pj-x" onClick={() => forget(t.doc_id)} aria-label="Detach">×</button></Badge>)
                            : <span className="pj-muted">not attached</span>}
                        </span>
                        <span className="is-right pj-row-actions" data-label="Actions">
                          {attachFor && !tags.some(t => t.project_id === attachFor) && (
                            <button type="button" className="pj-act" onClick={() => attach(attachFor, [d])}>Attach</button>
                          )}
                          {tags.length > 0 && <button type="button" className="pj-act is-bad" onClick={() => tags.forEach(t => setStore(removeTag(orgId, t.id)))}>Forget</button>}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {store.tags.some(t => !docs.some(d => d.id === t.doc_id)) && (
                <Card>
                  <p className="pj-detail-title">Orphans — attached, then deleted from the books</p>
                  <ul className="pj-mini">
                    {store.tags.filter(t => !docs.some(d => d.id === t.doc_id)).map(t => (
                      <li key={t.id}>
                        <span>{t.doc_number || t.doc_id}</span>
                        <span className="pj-muted">{store.projects.find(p => p.id === t.project_id)?.name || 'project gone'}</span>
                        <span className="pj-mini-num">{formatDateIN(t.doc_date)}</span>
                        <Badge tone="grey" dot={false}>No rupees</Badge>
                        <button type="button" className="pj-act is-bad" onClick={() => forget(t.doc_id)}>Forget</button>
                      </li>
                    ))}
                  </ul>
                  <p className="pj-hint">These rows survive on purpose. A tag that vanished when its bill was deleted would silently change a project’s contribution, and a stale row you can see is cheaper than a number you cannot explain.</p>
                </Card>
              )}
            </>
          )}
        </>
      )}

      {/* ── the two boundaries ───────────────────────────────────────────────── */}
      <div className="pj-bounds">
        <div className="pj-bound">
          <Icon name="invoice" size={14} />
          <p><strong>This page measures work; it does not bill it.</strong> Unbilled hours are grouped, priced and offered as a line to copy — the invoice is raised at <Link href="/invoices/new">/invoices/new</Link>, through the path that gives it a real sequence number and moves stock. Marking hours billed here records that you raised the paper somewhere else; it does not raise it. Money arrives through <Link href="/payments">/payments</Link>, which remains the only writer of money.</p>
        </div>
        <div className="pj-bound">
          <Icon name="scale" size={14} />
          <p><strong>The hours are priced; the named ones are also costed.</strong> An hour carries the rate you would bill it at, and that figure never enters contribution — subtracting your own billing rate from your own revenue would be double counting. When a row names a person from the <Link href="/payroll">payroll register</Link>, the section reads what their hour cost in the entry’s own month and prints <em>after named hours</em> beside contribution — a reading, marked <em>partial</em> while linked or typed-only hours remain unpriced, and never folded into the register’s own number. No wage rupee is stored or posted here — and where the same wages are also attached as a bill, the two readings overlap. Read them together, do not add them.</p>
        </div>
        <div className="pj-bound">
          <Icon name="layers" size={14} />
          <p><strong>A project collects documents; a cost centre splits them.</strong> <Link href="/cost-centres">Cost centres</Link> store a percentage of one invoice or bill and read the rupees back from it.
            This register attaches whole documents by id and adds the thing a centre cannot express — the hours, and the months of delivered work still waiting for paper. A centre whose kind reads “Project / job”
            is still only a split; it never learns how long the job took.</p>
        </div>
        <div className="pj-bound">
          <Icon name="book" size={14} />
          <p><strong>The {SERVICE_INVOICE_DAYS}-day window is rule 47, cited not settled.</strong> CBIC’s Handbook on Invoicing under GST (17-06-2025, §2.1.2) states it for services; notifications have widened it for classes of supplier. A late row here is a date, a rule and a link to <Link href="/gst/gstr3b">the 3B workpaper</Link> — never a tax figure. Verify at gst.gov.in before you rely on any of it.</p>
        </div>
      </div>

      <div className="pj-foot">
        <span>
          {plural(store.projects.length, 'project')} · {plural(store.entries.length, 'hour row')} ·{' '}
          {plural(store.tags.length, 'document tag')} · stored in this browser under taxflow:projects
        </span>
        <span className="pj-foot-links">
          <Link href="/cost-centres">Cost centres →</Link>
          <Link href="/ledger">Party ledger →</Link>
          <Link href="/accounting">Financial statements →</Link>
          <Link href="/reports">Reports →</Link>
        </span>
      </div>

      {/* ── modals ───────────────────────────────────────────────────────────── */}
      {editor && (
        <div className="pj-scrim" role="dialog" aria-modal="true" aria-label={editor.isNew ? 'New project' : 'Edit project'} ref={editorDialog} onClick={() => setEditor(null)}>
          <div className="pj-modal" onClick={e => e.stopPropagation()}>
            <div className="pj-modal-head">
              <h2>{editor.isNew ? 'New project' : editor.project.name || 'Edit project'}</h2>
              <button type="button" className="pj-notice-x" onClick={() => setEditor(null)} aria-label="Close"><Icon name="x" size={15} /></button>
            </div>

            {(editorError || editor.project.billing === 'internal') && (
              <div className={editorError ? 'pj-alert' : 'pj-basis'} role={editorError ? 'alert' : undefined}>
                <Icon name={editorError ? 'alert' : 'book'} size={14} strokeWidth={editorError ? 2.2 : 1.7} />
                <span>{editorError || BILLING_META.internal.note}</span>
              </div>
            )}

            <div className="pj-fields">
              <label className="pj-field"><span>Name</span>
                <input className="tf-input" value={editor.project.name} onChange={e => patchEditor({ name: e.target.value })} placeholder="Andheri fit-out, FY26 audit…" />
              </label>
              <label className="pj-field"><span>Code</span>
                <input className="tf-input" value={editor.project.code} onChange={e => patchEditor({ code: e.target.value })} placeholder="PRJ-118" />
              </label>
              <label className="pj-field"><span>Client</span>
                <input className="tf-input" value={editor.project.client_name} onChange={e => patchEditor({ client_name: e.target.value })} placeholder="Typed — not joined to a master" />
                <span className="pj-hint">Typed, not looked up: attaching a project to a customer id would need a schema change, and a wrong link is worse than a name.</span>
              </label>
              <label className="pj-field"><span>How it is billed</span>
                <select className="tf-input" value={editor.project.billing} onChange={e => patchEditor({ billing: e.target.value as BillingMode })}>
                  {(Object.keys(BILLING_META) as BillingMode[]).map(b => <option key={b} value={b}>{BILLING_META[b].label}</option>)}
                </select>
                <span className="pj-hint">{BILLING_META[editor.project.billing].note}</span>
              </label>
              <label className="pj-field"><span>Status</span>
                <select className="tf-input" value={editor.project.status} onChange={e => patchEditor({ status: e.target.value as Project['status'], archived: e.target.value === 'archived' })}>
                  {PROJECT_STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <label className="pj-field"><span>Started</span>
                <input className="tf-input" type="date" value={editor.project.start_date} onChange={e => patchEditor({ start_date: e.target.value })} />
              </label>
              <label className="pj-field"><span>Planned end</span>
                <input className="tf-input" type="date" value={editor.project.target_date} onChange={e => patchEditor({ target_date: e.target.value })} />
              </label>
              <label className="pj-field"><span>Default rate ₹/hour</span>
                <input className="tf-input" type="number" min="0" step="1" value={editor.project.hourly_rate || ''} onChange={e => patchEditor({ hourly_rate: Number(e.target.value) || 0 })} placeholder="0 = never recorded" />
                <span className="pj-hint">A day with no rate of its own inherits this. With neither, the hours count and no rupee figure is invented.</span>
              </label>
              <label className="pj-field"><span>Budget ₹ (spend, optional)</span>
                <input className="tf-input" type="number" min="0" step="1" value={editor.project.budget_value || ''} onChange={e => patchEditor({ budget_value: Number(e.target.value) || 0 })} placeholder="0 = no budget set" />
              </label>
              <label className="pj-field pj-field-wide"><span>Notes</span>
                <textarea className="tf-input" rows={2} value={editor.project.notes} onChange={e => patchEditor({ notes: e.target.value })} placeholder="What this job is, who signs it off, what it excludes…" />
              </label>
            </div>

            <div className="pj-save">
              <Button variant="ghost" onClick={() => setEditor(null)}>Cancel</Button>
              <Button icon="check" onClick={saveProject}>{editor.isNew ? 'Add project' : 'Save'}</Button>
            </div>
          </div>
        </div>
      )}

      {entryForm && (
        <div className="pj-scrim" role="dialog" aria-modal="true" aria-label="Log time" ref={entryDialog} onClick={() => setEntryForm(null)}>
          <div className="pj-modal pj-modal-sm" onClick={e => e.stopPropagation()}>
            <div className="pj-modal-head">
              <h2>{entryForm.isNew ? 'Log time' : 'Edit the day'}</h2>
              <button type="button" className="pj-notice-x" onClick={() => setEntryForm(null)} aria-label="Close"><Icon name="x" size={15} /></button>
            </div>
            {entryError && (
              <div className="pj-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{entryError}</div>
            )}
            <div className="pj-fields">
              <label className="pj-field pj-field-wide"><span>Project</span>
                <select className="tf-input" value={entryForm.entry.project_id} onChange={e => patchEntry({ entry: { ...entryForm.entry, project_id: e.target.value } })}>
                  <option value="">Choose a project…</option>
                  {liveProjects.map(v => <option key={v.project.id} value={v.project.id}>{v.project.name || v.project.code}{v.project.client_name ? ` · ${v.project.client_name}` : ''}</option>)}
                </select>
              </label>
              <label className="pj-field"><span>Day the work was done</span>
                <input className="tf-input" type="date" value={entryForm.entry.date} max={today()} onChange={e => patchEntry({ entry: { ...entryForm.entry, date: e.target.value } })} />
                <span className="pj-hint">This is the date of supply the {SERVICE_INVOICE_DAYS}-day window runs from.</span>
              </label>
              <div className="pj-field"><span>Who did it</span>
                <select className="tf-input" aria-label="Who did it — person from the payroll register"
                  value={entryForm.entry.employee_id}
                  onChange={e => {
                    const id = e.target.value
                    const person = id && payroll ? employeeById(payroll.employees).get(id) : undefined
                    patchEntry({ entry: { ...entryForm.entry, employee_id: id, person: person ? person.name : entryForm.entry.person } })
                  }}>
                  <option value="">Typed name only — never costed</option>
                  {entryForm.entry.employee_id && !payrollPeople.some(p => p.id === entryForm.entry.employee_id) && (
                    <option value={entryForm.entry.employee_id}>Person no longer on the register</option>
                  )}
                  {payrollPeople.map(p => <option key={p.id} value={p.id}>{p.name || p.code || 'Unnamed'}{p.code ? ` · ${p.code}` : ''}</option>)}
                </select>
                <input className="tf-input" aria-label="Who did it — typed name" value={entryForm.entry.person} onChange={e => patchEntry({ entry: { ...entryForm.entry, person: e.target.value } })} placeholder="…or type the name as it should print" />
                <span className="pj-hint">{(() => {
                  const id = entryForm.entry.employee_id
                  if (!id) return 'Priced at the row’s rate; not costed. Only a person picked from the payroll register carries a wage reading — a typed name is not a link.'
                  const person = payroll ? employeeById(payroll.employees).get(id) : undefined
                  if (!payroll || !person) return 'This person is not on the payroll register in this browser, so no cost can be read for the row.'
                  const month = periodOf(entryForm.entry.date)
                  const priced = costPerHourFor(payroll, month).find(c => c.employee_id === id)
                  if (priced && priced.cost_per_hour === null) return priced.why
                  if (priced && priced.cost_per_hour !== null) {
                    const h = Number(entryForm.hoursText) || 0
                    return h > 0
                      ? `${monthLabel(month)}: this person’s hour cost ${money(priced.cost_per_hour)} — this row would read ${money(h * priced.cost_per_hour)} at cost.`
                      : `${monthLabel(month)}: ${priced.basis}`
                  }
                  return offRosterWhy(person, month) || 'The payroll register has no figure for this month.'
                })()}</span>
              </div>
              <label className="pj-field"><span>Hours</span>
                <input className="tf-input" type="number" min="0" step="0.25" value={entryForm.hoursText} onChange={e => patchEntry({ hoursText: e.target.value })} />
              </label>
              <label className="pj-field"><span>Rate ₹/hour</span>
                <input className="tf-input" type="number" min="0" step="1" value={entryForm.rateText} onChange={e => patchEntry({ rateText: e.target.value })} placeholder="inherit the project rate" />
                <span className="pj-hint">{(() => {
                  const p = store.projects.find(x => x.id === entryForm.entry.project_id)
                  if (!p) return 'Pick a project to see its default rate.'
                  const r = p.hourly_rate > 0 ? p.hourly_rate : 0
                  return r > 0 ? `Blank uses the project’s ${money(r)} — this row is worth ${money((Number(entryForm.hoursText) || 0) * r)}.` : 'No rate is recorded on this project, so these hours carry no rupee figure.'
                })()}</span>
              </label>
              <label className="pj-field"><span>Billed on (invoice number, optional)</span>
                <input className="tf-input" list="pj-invoices" value={entryForm.entry.billed_ref} onChange={e => patchEntry({ entry: { ...entryForm.entry, billed_ref: e.target.value } })} placeholder="leave blank while unbilled" />
                <datalist id="pj-invoices">{invoiceNumbers.map(n => <option key={n} value={n} />)}</datalist>
              </label>
              <label className="pj-field pj-field-wide"><span>Note</span>
                <input className="tf-input" value={entryForm.entry.note} onChange={e => patchEntry({ entry: { ...entryForm.entry, note: e.target.value } })} placeholder="What the day actually did…" />
              </label>
            </div>
            <div className="pj-save">
              <Button variant="ghost" onClick={() => setEntryForm(null)}>Cancel</Button>
              <Button icon="check" onClick={saveEntry}>{entryForm.isNew ? 'Log it' : 'Save'}</Button>
            </div>
          </div>
        </div>
      )}

      {billFor && (
        <div className="pj-scrim" role="dialog" aria-modal="true" aria-label="Mark billed" ref={billDialog} onClick={() => setBillFor(null)}>
          <div className="pj-modal pj-modal-sm" onClick={e => e.stopPropagation()}>
            <div className="pj-modal-head">
              <h2>Which invoice carries these hours?</h2>
              <button type="button" className="pj-notice-x" onClick={() => setBillFor(null)} aria-label="Close"><Icon name="x" size={15} /></button>
            </div>
            <div className="pj-basis">
              <Icon name="book" size={14} />
              <span>
                This stamps {plural(billFor.ids.length, 'row')} with a reference. It does not create the invoice and it does not take the money —
                raise the paper at <Link href="/invoices/new">/invoices/new</Link> and receipt it at <Link href="/payments">/payments</Link>.
              </span>
            </div>
            <label className="pj-field pj-field-wide"><span>Invoice number</span>
              <input className="tf-input" list="pj-invoices2" value={billFor.ref} onChange={e => setBillFor({ ...billFor, ref: e.target.value })} placeholder="INV-0142" autoFocus />
              <datalist id="pj-invoices2">{invoiceNumbers.map(n => <option key={n} value={n} />)}</datalist>
              <span className="pj-hint">Blank puts the rows back on the unbilled register.</span>
            </label>
            {billFor.ref.trim() && !invoiceNumbers.includes(billFor.ref.trim()) && (
              <div className="pj-note is-hot">
                <Icon name="alert" size={14} strokeWidth={2.2} />
                <span>No invoice numbered <strong>{billFor.ref.trim()}</strong> is in your books. You can still stamp it — the register will carry it as an unmatched reference until the invoice exists.</span>
              </div>
            )}
            <div className="pj-save">
              <Button variant="ghost" onClick={() => setBillFor(null)}>Cancel</Button>
              <Button icon="check" onClick={applyBilled}>Stamp {plural(billFor.ids.length, 'row')}</Button>
            </div>
          </div>
        </div>
      )}

      {drawForm && (
        <div className="pj-scrim" role="dialog" aria-modal="true" aria-label="Draw hours from the day book" ref={drawDialog} onClick={() => setDrawForm(null)}>
          <div className="pj-modal" onClick={e => e.stopPropagation()}>
            <div className="pj-modal-head">
              <h2>Draw hours from the day book</h2>
              <button type="button" className="pj-notice-x" onClick={() => setDrawForm(null)} aria-label="Close"><Icon name="x" size={15} /></button>
            </div>
            {drawError && (
              <div className="pj-alert" role="alert"><Icon name="alert" size={14} strokeWidth={2.2} />{drawError}</div>
            )}
            {payrollPeople.length === 0 ? (
              <div className="pj-basis">
                <Icon name="book" size={14} />
                <span>
                  The payroll register has no people in this browser yet. The draw reads its roster and its
                  kept days — add the first person at <Link href="/payroll">/payroll</Link>, mark their days in the
                  day book, then draw from here.
                </span>
              </div>
            ) : (
              <>
                <div className="pj-fields">
                  <label className="pj-field"><span>Project</span>
                    <select className="tf-input" value={drawForm.project_id} onChange={e => pickDraw({ project_id: e.target.value })}>
                      <option value="">Choose a project…</option>
                      {liveProjects.map(v => <option key={v.project.id} value={v.project.id}>{v.project.name || v.project.code}{v.project.client_name ? ` · ${v.project.client_name}` : ''}</option>)}
                    </select>
                  </label>
                  <label className="pj-field"><span>Whose days</span>
                    <select className="tf-input" value={drawForm.employee_id} onChange={e => pickDraw({ employee_id: e.target.value })}>
                      <option value="">Pick the person on the payroll register…</option>
                      {payrollPeople.map(p => <option key={p.id} value={p.id}>{p.name || p.code || 'Unnamed'}{p.code ? ` · ${p.code}` : ''}{p.hours_per_day ? ` — ${p.hours_per_day} h/day` : ''}</option>)}
                    </select>
                  </label>
                  <label className="pj-field"><span>The month the book kept</span>
                    <input className="tf-input" type="month" value={drawForm.month} max={day.slice(0, 7)} onChange={e => pickDraw({ month: e.target.value })} />
                    <span className="pj-hint">The book keeps days that happened; a day not yet lived has no mark to draw.</span>
                  </label>
                </div>
                {!drawForm.project_id || !drawForm.employee_id ? (
                  <div className="pj-basis">
                    <Icon name="book" size={14} />
                    <span>
                      Pick a project, a person and a month. The draw proposes one timesheet day for every day the
                      book marks as worked, at that person’s own hours a day — you tick what really belongs to the
                      job, and every ticked day is written through the same rules as a row typed by hand.
                    </span>
                  </div>
                ) : draw.off ? (
                  <div className="pj-note is-hot">
                    <Icon name="alert" size={14} strokeWidth={2.2} />
                    <span>
                      {draw.off}{' '}
                      <Link href={`/payroll?tab=daybook&month=${isMonth(drawForm.month) ? drawForm.month : ''}`}>Open the day book</Link> to see their page.
                    </span>
                  </div>
                ) : draw.result?.refuse ? (
                  <div className="pj-note is-hot">
                    <Icon name="alert" size={14} strokeWidth={2.2} />
                    <span>
                      {draw.result.refuse}{' '}
                      {isMonth(drawForm.month) && (
                        <Link href={`/payroll?tab=daybook&month=${drawForm.month}`}>Mark the days in the day book</Link>
                      )}
                    </span>
                  </div>
                ) : draw.result ? (
                  <>
                    <div className="pj-draw-sum">
                      <span><strong>{draw.result.proposed_days}</strong> proposed — <strong>{hours(draw.result.proposed_hours)}</strong></span>
                      <span className="pj-muted">{monthLabel(drawForm.month)} · {draw.result.hours_per_day} h a day at the register</span>
                      {draw.result.logged_hours > 0 && <span className="pj-muted">{hours(draw.result.logged_hours)} already on this project this month</span>}
                    </div>
                    <ul className="pj-draw-list">
                      {draw.result.days.map(d => {
                        const on = d.tickable && drawTicks.has(d.date)
                        return (
                          <li key={d.date} className={`pj-draw-row${on ? ' is-on' : ''}${d.tickable ? '' : ' is-fixed'}`}>
                            {d.tickable
                              ? <input type="checkbox" checked={on} onChange={() => toggleDrawDay(d.date)} aria-label={`Draw ${d.date}`} />
                              : <span className="pj-draw-dot" aria-hidden="true">·</span>}
                            <span className="pj-draw-day">{formatDateIN(d.date)}</span>
                            <span className={`pj-draw-mark${d.hours > 0 ? ' is-work' : ''}`}>
                              <strong>{d.mark || '—'}</strong><em>{d.label}</em>
                            </span>
                            <span className="pj-draw-hr">{d.hours > 0 ? hours(d.hours) : '—'}</span>
                            {d.why && <span className="pj-draw-why">{d.why}</span>}
                          </li>
                        )
                      })}
                    </ul>
                    {draw.result.findings.length > 0 && (
                      <ul className="pj-draw-findings">
                        {draw.result.findings.map((f, i) => <li key={i}>{f}</li>)}
                      </ul>
                    )}
                    <p className="pj-hint">
                      The draw reads the book; it never writes to it. Every ticked day lands with the person linked,
                      so its cost is read from the payroll register like any named hour — and the marks are evidence,
                      not a timesheet: a day the book does not mark as worked is named, never ticked for you.
                    </p>
                  </>
                ) : null}
              </>
            )}
            <div className="pj-save">
              <Button variant="ghost" onClick={() => setDrawForm(null)}>Cancel</Button>
              <Button icon="check" disabled={!draw.result || !!draw.result.refuse || drawTicked.length === 0} onClick={applyDraw}>
                {drawTicked.length ? `Draw ${plural(drawTicked.length, 'day')} — ${hours(drawTickedHours)}` : 'Draw the days'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .pj-load { color: var(--muted); font-size: 13px; }

        .pj-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 4px 0 14px; }
        .pj-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .pj-select { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
        .pj-select select { min-width: 150px; cursor: pointer; }
        .pj-period { width: auto; min-width: 150px; cursor: pointer; }

        .pj-notice, .pj-alert, .pj-note { display: flex; align-items: flex-start; gap: 8px; border-radius: 12px;
          padding: 10px 12px; font-size: 12.5px; line-height: 1.55; margin-bottom: 12px; }
        .pj-notice { background: var(--green-soft); color: var(--green); border: 1px solid color-mix(in srgb, var(--green) 22%, white); }
        .pj-notice.is-bad { background: var(--red-soft); color: var(--red); border-color: color-mix(in srgb, var(--red) 22%, white); }
        .pj-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; padding: 2px; min-height: 0; opacity: .7; }
        .pj-notice-x:hover { opacity: 1; }
        .pj-alert { background: var(--red-soft); color: var(--red); border: 1px solid color-mix(in srgb, var(--red) 22%, white); }
        .pj-note { background: var(--brand-soft); color: var(--ink-2); border: 1px solid color-mix(in srgb, var(--brand) 22%, white); }
        .pj-note.is-hot { background: var(--amber-soft); color: var(--amber); border-color: color-mix(in srgb, var(--amber) 25%, white); }
        .pj-note a { color: var(--brand); }
        .pj-note.is-hot a, .pj-note.is-hot strong { color: inherit; }
        .pj-note em { font-style: normal; font-weight: 650; }
        .pj-inline { background: none; border: none; color: var(--brand); cursor: pointer; font-size: inherit; padding: 0; text-decoration: underline; min-height: 0; }

        .pj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 14px; }
        .pj-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px;
          box-shadow: var(--shadow-xs); display: flex; flex-direction: column; gap: 11px; }
        .pj-card.is-flagged { border-color: color-mix(in srgb, var(--amber) 55%, white); }
        .pj-card.is-archived { opacity: .72; }
        .pj-card-head { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
        .pj-card-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .pj-card-name { font-size: 14.5px; font-weight: 700; color: var(--ink); display: flex; align-items: center; gap: 7px; }
        .pj-card-name svg { color: var(--brand); flex-shrink: 0; }
        .pj-card-sub { font-size: 11.5px; color: var(--muted); }
        .pj-card-badges { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }

        .pj-bars { display: flex; flex-direction: column; gap: 7px; }
        .pj-bar-row { display: grid; grid-template-columns: 62px minmax(0, 1fr) 86px; gap: 9px; align-items: center; }
        .pj-bar-label { font-size: 11px; color: var(--faint); text-transform: uppercase; letter-spacing: .04em; font-weight: 700; }
        .pj-bar-num { font-size: 12px; font-weight: 650; color: var(--ink); text-align: right; font-variant-numeric: tabular-nums; }

        .pj-card-stats { display: flex; flex-direction: column; gap: 2px; border-top: 1px solid var(--line-soft); padding-top: 9px; }
        .pj-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .pj-finding { display: flex; gap: 7px; font-size: 12px; line-height: 1.5; border-radius: 9px; padding: 7px 9px; align-items: flex-start; }
        .pj-finding svg { flex-shrink: 0; margin-top: 2px; }
        .pj-finding.is-red { background: var(--red-soft); color: var(--red); }
        .pj-finding.is-amber { background: var(--amber-soft); color: var(--amber); }
        .pj-finding.is-grey { background: var(--slate-soft); color: var(--muted); }

        .pj-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: auto; }
        .pj-detail { border-top: 1px solid var(--line-soft); padding-top: 11px; display: flex; flex-direction: column; gap: 11px; }
        .pj-detail-block { display: flex; flex-direction: column; gap: 7px; }
        .pj-detail-rows { display: flex; flex-direction: column; gap: 2px; }
        .pj-detail-title { font-size: 11px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--faint); margin: 0; }
        .pj-detail-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
        .pj-detail-actions select { flex: 1 1 150px; cursor: pointer; }
        .pj-mini { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
        .pj-mini li { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--ink-2); }
        .pj-mini-num { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink); }
        .pj-muted { color: var(--faint); font-size: 11.5px; }
        .pj-hint { font-size: 11px; color: var(--faint); line-height: 1.5; margin: 0; }

        .pj-bulk { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--surface);
          border: 1px solid var(--line); border-radius: var(--radius); padding: 9px 12px; margin-bottom: 12px; }
        .pj-bulk-count { font-size: 12.5px; color: var(--ink); font-variant-numeric: tabular-nums; }
        .pj-bulk-total { margin-left: auto; font-size: 12.5px; font-weight: 650; color: var(--brand); font-variant-numeric: tabular-nums; }
        .pj-check-all { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); cursor: pointer; }

        .pj-cols { display: grid; grid-template-columns: minmax(150px, 1.5fr) minmax(110px, 1fr) 76px 86px 92px 86px minmax(110px, 1fr) minmax(120px, 1fr) 108px; gap: 10px; align-items: center; }
        .pj-head { padding: 9px 12px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); border-bottom: 1px solid var(--line); min-width: 980px; }
        .pj-tr { padding: 9px 12px; border-bottom: 1px solid var(--line-soft); min-width: 980px; }
        .pj-tr:last-child { border-bottom: none; }
        .pj-tr.is-picked { background: var(--brand-soft); }
        .pj-lead { display: flex; align-items: center; gap: 8px; min-width: 0; }
        .pj-day { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .pj-day strong { font-size: 12.5px; color: var(--ink); }
        .pj-day em { font-style: normal; font-size: 11px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .pj-cols span { font-size: 12.5px; color: var(--ink-2); min-width: 0; }
        .pj-cols .is-right { text-align: right; white-space: nowrap; }
        .pj-num { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--ink); }
        .pj-noteline { display: block; font-style: normal; font-size: 11px; color: var(--faint); overflow: hidden; text-overflow: ellipsis; }
        .pj-due { display: block; font-style: normal; font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
        .pj-row-actions { display: flex; gap: 6px; justify-content: flex-end; }
        .pj-act { background: none; border: 1px solid var(--line); border-radius: 7px; color: var(--brand); cursor: pointer;
          font-size: 11.5px; padding: 3px 8px; min-height: 0; }
        .pj-act:hover { background: var(--brand-soft); }
        .pj-act.is-bad { color: var(--red); }
        .pj-act.is-bad:hover { background: var(--red-soft); }

        .pj2-cols { grid-template-columns: minmax(180px, 1.6fr) 78px 96px 104px 108px minmax(150px, 1fr) 150px; gap: 10px; }
        .pj2-head { padding: 9px 12px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); border-bottom: 1px solid var(--line); min-width: 860px; }
        .pj2-wrap { border-bottom: 1px solid var(--line-soft); }
        .pj2-wrap:last-child { border-bottom: none; }
        .pj2-wrap.is-hot { background: color-mix(in srgb, var(--amber) 5%, white); }
        .pj2-tr { display: grid; grid-template-columns: subgrid; padding: 10px 12px; min-width: 860px; }
        .pj2-cols span { font-size: 12.5px; color: var(--ink-2); }
        .pj2-lead strong { display: block; font-size: 12.5px; color: var(--ink); }
        .pj2-lead em { font-style: normal; font-size: 11px; color: var(--muted); }
        .pj2-detail { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 9px; }
        .pj2-said { display: flex; gap: 7px; align-items: flex-start; font-size: 12px; line-height: 1.55; color: var(--ink-2);
          background: var(--surface-2); border-left: 3px solid var(--faint); border-radius: 8px; padding: 8px 11px; margin: 0; }
        .pj2-said svg { flex-shrink: 0; margin-top: 2px; }
        .pj2-said.is-green { color: var(--green); background: var(--green-soft); border-left-color: var(--green); }
        .pj2-said.is-amber { color: var(--amber); background: var(--amber-soft); border-left-color: var(--amber); }
        .pj2-said.is-red { color: var(--red); background: var(--red-soft); border-left-color: var(--red); }
        .pj2-said.is-grey, .pj2-said.is-flat { color: var(--muted); background: var(--slate-soft); border-left-color: var(--faint); }
        .pj2-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px;
          background: var(--surface-2); border-radius: 9px; padding: 9px 11px; }
        .pj2-rows li { display: flex; gap: 10px; align-items: center; font-size: 12px; color: var(--ink-2); }
        .pj2-actions { display: flex; gap: 8px; flex-wrap: wrap; }

        .pj3-cols { grid-template-columns: minmax(150px, 1.2fr) minmax(130px, 1fr) 100px 92px minmax(160px, 1fr) 130px; gap: 10px; }
        .pj3-head { padding: 9px 12px; font-size: 10.5px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase;
          color: var(--faint); border-bottom: 1px solid var(--line); min-width: 780px; }
        .pj3-tr { padding: 9px 12px; border-bottom: 1px solid var(--line-soft); min-width: 780px; }
        .pj3-tr:last-child { border-bottom: none; }
        .pj3-cols span { font-size: 12.5px; color: var(--ink-2); }
        .pj3-tr.is-plain .pj-lead strong { color: var(--muted); }

        .pj-strip { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }

        .pj-bounds { display: grid; grid-template-columns: 1fr; gap: 10px; margin: 18px 0 8px; }
        .pj-bound { display: flex; gap: 9px; align-items: flex-start; background: var(--surface-2); border: 1px solid var(--line-soft);
          border-radius: var(--radius); padding: 11px 13px; }
        .pj-bound svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .pj-bound p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--muted); }
        .pj-bound strong { color: var(--ink-2); }

        .pj-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap;
          font-size: 11.5px; color: var(--faint); margin-top: 16px; }
        .pj-foot-links { display: flex; gap: 12px; flex-wrap: wrap; }
        .pj-foot-links a { color: var(--brand); text-decoration: none; }

        .pj-scrim { position: fixed; inset: 0; background: rgba(15,23,42,.45); display: flex; align-items: center;
          justify-content: center; padding: 16px; z-index: 60; }
        .pj-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem; width: 100%;
          max-width: 620px; max-height: 90vh; overflow: auto; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 12px; }
        .pj-modal-sm { max-width: 480px; }
        .pj-modal-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
        .pj-modal-head h2 { margin: 0; font-size: 16px; font-weight: 700; color: var(--ink); }
        .pj-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; }
        .pj-field { display: flex; flex-direction: column; gap: 5px; }
        .pj-field > span { font-size: 12px; font-weight: 600; color: var(--ink-2); }
        .pj-field-wide { grid-column: 1 / -1; }
        .pj-field textarea { resize: vertical; font-family: inherit; }
        .pj-field select.tf-input { cursor: pointer; }
        .pj-basis { display: flex; align-items: flex-start; gap: 7px; font-size: 11.5px; color: var(--muted);
          background: var(--surface); border-left: 3px solid var(--brand); border-radius: 8px; padding: 8px 11px; line-height: 1.55; }
        .pj-basis svg { flex-shrink: 0; margin-top: 2px; color: var(--brand); }
        .pj-save { display: flex; gap: 10px; justify-content: flex-end; }
        .pj-x { background: none; border: none; color: inherit; cursor: pointer; margin-left: 5px; padding: 0 1px; min-height: 0; opacity: .6; }
        .pj-x:hover { opacity: 1; }

        .pj-empty-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
        .pj-draw-sum { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; margin: 0 2px; font-size: 12.5px; color: var(--ink-2); }
        .pj-draw-list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 12px; overflow-y: auto; max-height: 320px; }
        .pj-draw-row { display: grid; grid-template-columns: 26px 112px minmax(0, 1fr) 60px; align-items: center;
          column-gap: 10px; row-gap: 2px; padding: 8px 11px; border-bottom: 1px solid var(--line); font-size: 12.5px; }
        .pj-draw-row:last-child { border-bottom: none; }
        .pj-draw-row.is-on { background: var(--brand-soft); }
        .pj-draw-row.is-fixed { color: var(--muted); }
        .pj-draw-row input[type="checkbox"] { accent-color: var(--brand); width: 14px; height: 14px; margin: 0; }
        .pj-draw-dot { color: var(--faint); text-align: center; }
        .pj-draw-day { font-variant-numeric: tabular-nums; }
        .pj-draw-mark { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
        .pj-draw-mark strong { font-weight: 650; }
        .pj-draw-mark em { font-style: normal; color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .pj-draw-mark.is-work em { color: var(--green); }
        .pj-draw-hr { font-variant-numeric: tabular-nums; text-align: right; color: var(--ink-2); }
        .pj-draw-why { grid-column: 2 / -1; color: var(--muted); font-size: 11.5px; line-height: 1.5; }
        .pj-draw-findings { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--muted); }
        .pj-draw-findings li { display: flex; gap: 7px; }
        .pj-draw-findings li::before { content: '·'; color: var(--brand); }
        @media (max-width: 620px) {
          .pj-draw-row { grid-template-columns: 24px 96px minmax(0, 1fr) 52px; column-gap: 8px; }
          .pj-draw-mark em { display: none; }
        }

        @media (max-width: 1100px) { .pj-stats { grid-template-columns: 1fr 1fr; } .pj-strip { grid-template-columns: 1fr; } }
        @media (max-width: 768px) {
          .pj-stats { grid-template-columns: 1fr 1fr; }
          .pj-grid { grid-template-columns: 1fr; }
          .pj-fields { grid-template-columns: 1fr; }
          .pj-head, .pj2-head, .pj3-head { display: none; }
          .pj-cols, .pj2-cols, .pj3-cols { grid-template-columns: 1fr; min-width: 0; }
          .pj-tr, .pj2-tr, .pj3-tr { min-width: 0; }
          .pj-cols > span, .pj2-cols > span, .pj3-cols > span { font-size: 12.5px; }
          .pj-cols > span.is-right, .pj2-cols > span.is-right, .pj3-cols > span.is-right {
            display: flex; align-items: baseline; justify-content: space-between; gap: 10px; text-align: left; white-space: normal;
          }
          .pj-cols > span:not(.pj-lead)::before, .pj2-cols > span:not(.pj-lead)::before, .pj3-cols > span:not(.pj-lead)::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
            text-transform: uppercase; color: var(--faint);
          }
          .pj-lead::before { content: none; }
          /* grid-recipe rows need their own card on a phone — .table-frame goes borderless here by design */
          .pj-tr, .pj2-wrap, .pj3-tr {
            border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface);
            margin: 0 0 10px; padding: 11px 12px; display: grid; gap: 7px;
          }
          .pj2-tr { border: none; border-radius: 0; background: none; margin: 0; padding: 0 0 7px; }
          .pj2-wrap { gap: 0; }
          .pj2-wrap:last-child, .pj3-tr:last-child, .pj-tr:last-child { margin-bottom: 0; }
          .pj-row-actions { justify-content: flex-start; flex-wrap: wrap; }
          .pj-bulk-total { margin-left: 0; }
          .pj-scrim { align-items: flex-end; padding: 0; }
          .pj-scrim .pj-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 94vh; padding: 1.1rem 1.15rem; }
          .pj-save { flex-direction: column-reverse; }
          .pj-bar-row { grid-template-columns: 58px minmax(0, 1fr) 78px; }
        }
      `}</style>
    </div>
  )
}

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <ProjectsPageInner />
    </Suspense>
  )
}
