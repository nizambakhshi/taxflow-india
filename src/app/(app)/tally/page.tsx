'use client'

/* Tally import & export — the bridge, both directions. (R2-22 B2)
 *
 * This tab is a workbench, not a button. A Tally export is read into a *plan*: one row
 * per object the file describes, each row stating what it becomes here, how its money
 * was worked out, and — where the file cannot answer — exactly which name is missing.
 * Nothing is written until a row is picked, and picking a document pulls in the masters
 * it names rather than inventing them.
 *
 * The other direction is the same bridge run backwards: our own invoices and bills,
 * with the party and product rows they name, written as the import XML TallyPrime reads.
 *
 * Three rules the page keeps out loud, because they are what makes the bridge trustworthy:
 *  * **The file is evidence.** Rates, states and totals come from tagged values or from
 *    labelled arithmetic on them. A disagreement inside the file is shown on the row, and
 *    the file's own lines win.
 *  * **Our numbers stay ours.** An imported invoice takes its number from this app's
 *    sequence; the Tally voucher number rides in its notes so the two books tie back.
 *  * **Money is not imported.** A receipt inside a voucher is reported and left for
 *    /payments, the only writer of money here.
 *
 * A journal or challan voucher (R3-8) lands as a *draft*, which keeps all three rules at
 * once: the draft burns no number here (the journal register takes its number at posting,
 * the challan series at raising), the seal is asked before it is written, and a human
 * posts or confirms it.
 *
 * The parsing, the plan and the XML writer all live in src/lib/tally.ts; this file is
 * only the desk the accountant works at. */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import { getFinancialYear } from '@/lib/gst-engine'
import { createInvoice } from '@/lib/create-invoice'
import { createPurchaseBill } from '@/lib/create-bill'
import { createCreditNote, createDebitNote } from '@/lib/creditnote'
import { loadJournal, newEntry, newLeg, writeEntry, type JournalLeg, type LegSide } from '@/lib/journal'
import { appendDraft, loadStore, newDoc, saveStore, type FlowDoc, type FlowLine } from '@/lib/orderflow'
import { loadSetup, resolveSeries } from '@/lib/setup'
import { matchesAny, useSearchDeepLink } from '@/lib/deep-link-search'
import {
  PLAN_CSV_HEADERS, SAMPLE_TALLY_DUMP, STATUS_LABEL, TARGET_LABEL,
  buildPlan, clearTallyImports, expandSelection, exportSummary, exportTallyXml, loadTallyImports,
  planCsvRows, planKey, readTally, recordTallyImport, tallyExportFileName, writeOrder,
  type Existing, type ExportData, type ExportDocument, type ImportPlan, type OrgIdentity,
  type PlanItem, type PlanStatus, type PlanTarget, type TallyAction, type TallyDump,
  type TallyImportRecord,
} from '@/lib/tally'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput, SectionTitle,
  Segmented, StatCard, StatRow,
} from '@/components/ui'
import Icon from '@/components/Icons'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const money = (n: number) => `₹${inr.format(Number(n) || 0)}`

type View = 'plan' | 'export' | 'log'

const GROUPS: PlanTarget[] = ['product', 'customer', 'vendor', 'invoice', 'purchase_bill', 'credit_note', 'debit_note', 'journal_draft', 'challan_draft', 'other']
const GROUP_ICON: Record<PlanTarget, string> = {
  product: 'box', customer: 'users', vendor: 'factory', invoice: 'invoice',
  purchase_bill: 'cart', credit_note: 'credit-note', debit_note: 'debit-note',
  journal_draft: 'journal', challan_draft: 'truck', other: 'x',
}
const STATUS_TONE: Record<PlanStatus, 'green' | 'red' | 'blue' | 'grey'> = {
  ready: 'green', blocked: 'red', already: 'blue', skipped: 'grey',
}
const STATUS_FILTERS = [
  { value: 'all', label: 'Every row' },
  { value: 'ready', label: 'Ready' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'already', label: 'Already here' },
  { value: 'skipped', label: 'Not imported' },
]

/** What the page reads from the register before planning a file. */
interface PartyRow { id: string; name: string; gstin: string | null; state_code: string | null; phone: string | null }
interface ProductRow { id: string; name: string; hsn_sac: string | null; sku: string | null; unit: string | null }
interface DocRow { id: string; number: string | null; date: string | null; party_name: string | null; grand_total: number | null; notes: string | null }

/** The columns a Tally voucher needs, which is a wider set than the register lists show. */
interface ExportInvoiceRow {
  id: string; invoice_number: string; invoice_date: string; customer_name: string | null
  customer_gstin: string | null; customer_state: string | null; customer_state_code: string | null
  notes: string | null; taxable_amount: number | null; cgst_amount: number | null
  sgst_amount: number | null; igst_amount: number | null; cess_amount: number | null
  round_off: number | null; grand_total: number | null
}
interface ExportBillRow {
  id: string; bill_number: string; bill_date: string; vendor_name: string | null
  vendor_gstin: string | null; vendor_state_code: string | null
  notes: string | null; taxable_amount: number | null; cgst_amount: number | null
  sgst_amount: number | null; igst_amount: number | null; cess_amount: number | null
  round_off: number | null; grand_total: number | null
}
interface ExportMasterRow {
  id: string; name: string; gstin: string | null; state: string | null; state_code: string | null
  phone: string | null; email: string | null; address_line1: string | null; city: string | null; pincode: string | null
}
interface ExportProductRow {
  id: string; name: string; unit: string | null; hsn_sac: string | null; gst_rate: number | null
  cess_rate: number | null; selling_price: number | null; purchase_price: number | null
  current_stock: number | null; track_inventory: boolean | null; type: string | null
}
interface ItemRow {
  id: string; doc_id: string; item_name: string; hsn_sac: string | null; quantity: number; unit: string | null
  rate: number; taxable_value: number | null; gst_rate: number | null; cess_rate: number | null
}

/** What the line tables return: an item row wearing whichever foreign key that table uses. */
type RawItemRow = Record<string, string | number | boolean | null> & { id: string }

function toItemRow(row: RawItemRow, docId: string): ItemRow {
  const num = (v: unknown) => (v == null || v === '' ? null : Number(v))
  return {
    id: row.id,
    doc_id: docId,
    item_name: String(row.item_name || ''),
    hsn_sac: row.hsn_sac == null ? null : String(row.hsn_sac),
    quantity: num(row.quantity) ?? 0,
    unit: row.unit == null ? null : String(row.unit),
    rate: num(row.rate) ?? 0,
    taxable_value: num(row.taxable_value),
    gst_rate: num(row.gst_rate),
    cess_rate: num(row.cess_rate),
  }
}

/** One line of the outcome list: what a row became, or why it did not. */
interface WriteResult {
  key: string
  target: PlanTarget
  title: string
  ok: boolean
  detail: string
  href: string
}

const DOC_ITEM_COLS = 'id, invoice_id, item_name, hsn_sac, quantity, unit, rate, taxable_value, gst_rate, cess_rate'

/** `Tally Sales #V-101 · ref PO-118` → `V-101`, so a document that came from Tally goes back with its own number. */
function tallyReference(notes: string | null): string {
  return /Tally\s+[^#]*#([^\s·]+)/.exec(notes || '')?.[1] || ''
}

/** A BOM belongs on a spreadsheet; Tally reads this file as plain UTF-8 XML. */
function saveXml(filename: string, xml: string): void {
  const url = URL.createObjectURL(new Blob([xml], { type: 'application/xml;charset=utf-8;' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** `.in()` with a thousand ids is a query string nobody should send; the ids go in slices. */
async function fetchIn<T>(ids: string[], run: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += 150) out.push(...await run(ids.slice(i, i + 150)))
  return out
}

function TallyPageInner() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const searchParams = useSearchParams()
  const fileRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [org, setOrg] = useState<OrgIdentity>({ stateCode: '' })
  const [existing, setExisting] = useState<Existing>({})

  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const [view, setView] = useState<View>('plan')
  const [fileText, setFileText] = useState('')
  // The box and the plan are separate on purpose: pasting is not an instruction to plan,
  // and editing the box after planning must not quietly rebuild the rows underneath a tick.
  const [plannedText, setPlannedText] = useState('')
  const [fileName, setFileName] = useState('')
  const [dragging, setDragging] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState('all')
  const [group, setGroup] = useState('all')
  const [search, setSearch] = useSearchDeepLink()

  const [importing, setImporting] = useState(false)
  const [results, setResults] = useState<WriteResult[] | null>(null)
  const [log, setLog] = useState<TallyImportRecord[]>([])

  // The other direction: our books, waiting to be handed over.
  const [exportLoaded, setExportLoaded] = useState(false)
  const deskBusy = useRef(false)
  const [exportInvoices, setExportInvoices] = useState<ExportInvoiceRow[]>([])
  const [exportBills, setExportBills] = useState<ExportBillRow[]>([])
  const [exportMasters, setExportMasters] = useState<{ customers: ExportMasterRow[]; vendors: ExportMasterRow[]; products: ExportProductRow[] }>({ customers: [], vendors: [], products: [] })
  const [pickedInv, setPickedInv] = useState<Set<string>>(new Set())
  const [pickedBills, setPickedBills] = useState<Set<string>>(new Set())
  const [docTab, setDocTab] = useState('invoices')
  const [period, setPeriod] = useState('this-fy')
  const [items, setItems] = useState<Map<string, ItemRow[]>>(new Map())
  const [company, setCompany] = useState('')
  const [action, setAction] = useState<TallyAction>('Create')
  const [includeMasters, setIncludeMasters] = useState(true)
  const [exportError, setExportError] = useState('')
  const [exportNote, setExportNote] = useState('')

  /** The names and numbers an import must not duplicate. */
  const readRegister = useCallback(async (oid: string): Promise<Existing> => {
    const [cust, vend, prod, inv, bills, cns, dns] = await Promise.all([
      supabase.from('customers').select('id, name, gstin, state_code, phone')
        .eq('organization_id', oid).eq('is_active', true).limit(5000),
      supabase.from('vendors').select('id, name, gstin, state_code, phone')
        .eq('organization_id', oid).eq('is_active', true).limit(5000),
      supabase.from('products').select('id, name, hsn_sac, sku, unit')
        .eq('organization_id', oid).eq('is_active', true).limit(5000),
      supabase.from('invoices').select('id, invoice_number, invoice_date, customer_name, grand_total, notes')
        .eq('organization_id', oid).order('invoice_date', { ascending: false }).limit(2000),
      supabase.from('purchase_bills').select('id, bill_number, bill_date, vendor_name, grand_total, notes')
        .eq('organization_id', oid).order('bill_date', { ascending: false }).limit(2000),
      supabase.from('credit_notes').select('id, credit_note_number, credit_note_date, customer_name, grand_total, notes')
        .eq('organization_id', oid).order('credit_note_date', { ascending: false }).limit(2000),
      supabase.from('debit_notes').select('id, debit_note_number, debit_note_date, vendor_name, grand_total, notes')
        .eq('organization_id', oid).order('debit_note_date', { ascending: false }).limit(2000),
    ])
    setError(cust.error || vend.error || prod.error || inv.error || bills.error || cns.error || dns.error
      ? 'Could not read the register, so nothing here can be matched against what you already have.'
      : '')

    const asParty = (rows: PartyRow[] | null) => (rows || []).map(r => ({ id: r.id, name: r.name, gstin: r.gstin, state_code: r.state_code, phone: r.phone }))
    const asDoc = (rows: { id: string; number: string | null; date: string | null; party_name: string | null; grand_total: number | null; notes: string | null }[]): DocRow[] =>
      (rows || []).map(r => ({ id: r.id, number: r.number, date: r.date, party_name: r.party_name, grand_total: r.grand_total ? Number(r.grand_total) : 0, notes: r.notes }))

    return {
      customers: asParty((cust.data || []) as PartyRow[]),
      vendors: asParty((vend.data || []) as PartyRow[]),
      products: ((prod.data || []) as ProductRow[]).map(p => ({ id: p.id, name: p.name, hsn_sac: p.hsn_sac, sku: p.sku, unit: p.unit })),
      invoices: asDoc((inv.data || []).map(r => ({
        id: r.id, number: r.invoice_number, date: r.invoice_date, party_name: r.customer_name,
        grand_total: Number(r.grand_total) || 0, notes: r.notes,
      }))),
      bills: asDoc((bills.data || []).map(r => ({
        id: r.id, number: r.bill_number, date: r.bill_date, party_name: r.vendor_name,
        grand_total: Number(r.grand_total) || 0, notes: r.notes,
      }))),
      creditNotes: asDoc((cns.data || []).map(r => ({
        id: r.id, number: r.credit_note_number, date: r.credit_note_date, party_name: r.customer_name,
        grand_total: Number(r.grand_total) || 0, notes: r.notes,
      }))),
      debitNotes: asDoc((dns.data || []).map(r => ({
        id: r.id, number: r.debit_note_number, date: r.debit_note_date, party_name: r.vendor_name,
        grand_total: Number(r.grand_total) || 0, notes: r.notes,
      }))),
      // The two device-side registers a draft row is matched against: the bridge plans a
      // journal leg only onto a head that already stands, and a challan only against the
      // challans this browser already holds. Both reads are localStorage, not Supabase.
      ...(() => {
        const j = loadJournal(oid)
        const ch = loadStore('challan', oid)
        return {
          journalHeads: j.heads.map(h => ({ id: h.id, name: h.name, active: h.active })),
          journalEntries: j.entries.map(e => ({
            id: e.id, number: e.number || null, date: e.date, party_name: null,
            notes: [e.narration, e.reference].filter(Boolean).join(' · '),
            grand_total: e.legs.reduce((s, l) => s + (l.side === 'debit' ? l.amount : 0), 0),
          })),
          challans: ch.docs.map(d => ({
            id: d.id, number: d.number || null, date: d.doc_date, party_name: d.party_name,
            grand_total: null, notes: d.notes,
          })),
        }
      })(),
    }
  }, [supabase])

  /* ── boot ── */

  useEffect(() => {
    async function boot() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id, organizations(name)')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      const name = (membership.organizations as { name?: string } | null)?.name || ''
      setOrgId(oid)
      setCompany(name)
      setLog(loadTallyImports(oid))

      // The place of supply of an unregistered counterparty is this business's own state,
      // so the primary GSTIN has to be read before a plan can be honest about a row.
      const { data: reg } = await supabase
        .from('gst_registrations').select('gstin, state_code')
        .eq('organization_id', oid).eq('is_primary', true).single()
      setOrg({ stateCode: reg?.state_code || '', gstin: reg?.gstin || '', name })

      setExisting(await readRegister(oid))
      setLoading(false)

      // ?view=export — the palette's "Send my books to Tally" action lands on that desk.
      const want = searchParams.get('view')
      if (want === 'export' || want === 'log') setView(want)
      if (searchParams.get('sample') === '1') {
        setFileText(SAMPLE_TALLY_DUMP)
        setPlannedText(SAMPLE_TALLY_DUMP)
        setFileName('sample-tally-export.xml')
        setView('plan')
      }
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── the plan ── */

  const read = useMemo<{ dump: TallyDump | null; error: string }>(() => {
    const text = plannedText.trim()
    if (!text) return { dump: null, error: '' }
    try {
      return { dump: readTally(text), error: '' }
    } catch (e) {
      return { dump: null, error: `This file could not be read at all: ${(e as Error).message}` }
    }
  }, [plannedText])
  const dump = read.dump
  const readError = read.error

  const plan: ImportPlan | null = useMemo(
    () => (dump ? buildPlan(dump, existing, org) : null),
    [dump, existing, org],
  )

  const visible = useMemo(() => {
    if (!plan) return [] as PlanItem[]
    const q = search.trim().toLowerCase()
    return plan.items.filter(i => {
      if (status !== 'all' && i.status !== status) return false
      if (group !== 'all' && i.target !== group) return false
      if (q && !matchesAny(q, [i.title, i.subtitle, i.tallyRef, i.reasons.join(' '), i.flags.join(' '), i.derived.join(' ')])) return false
      return true
    })
  }, [plan, status, group, search])

  /** The rows the visible slice can actually be written, and the rupees they are worth. */
  const writeSet = useMemo<PlanItem[]>(
    () => (plan ? writeOrder(plan, expandSelection(plan, picked)) : []),
    [plan, picked],
  )
  const writeDocs = useMemo(() => writeSet.filter(i => i.target === 'invoice' || i.target === 'purchase_bill' || i.target === 'credit_note' || i.target === 'debit_note'), [writeSet])
  // A draft is neither a document nor a master: it books no rupee and adds no name to a
  // master register — it is a proposal on a register the shop already keeps.
  const writeDrafts = useMemo(() => writeSet.filter(i => i.target === 'journal_draft' || i.target === 'challan_draft'), [writeSet])
  const writeMasters = writeSet.length - writeDocs.length - writeDrafts.length
  const writeRupees = useMemo(() => writeDocs.reduce((s, i) => s + i.rupees, 0), [writeDocs])

  const counts = useMemo(() => {
    const byStatus: Record<string, number> = { all: plan?.items.length || 0, ready: 0, blocked: 0, already: 0, skipped: 0 }
    const byGroup: Record<string, number> = { all: plan?.items.length || 0 }
    for (const item of plan?.items || []) {
      byStatus[item.status]++
      byGroup[item.target] = (byGroup[item.target] || 0) + 1
    }
    return { byStatus, byGroup }
  }, [plan])

  const groups = useMemo(() => GROUPS
    .map(target => ({ target, rows: visible.filter(i => i.target === target) }))
    .filter(g => g.rows.length), [visible])

  /* ── choosing ── */

  const togglePick = (key: string) => setPicked(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const toggleOpen = (key: string) => setOpen(prev => {
    const next = new Set(prev)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })

  const pickAllReady = () => {
    if (!plan) return
    const next = new Set(picked)
    for (const item of plan.items) if (item.status === 'ready') next.add(item.key)
    setPicked(next)
  }

  const pickGroupReady = (target: PlanTarget) => {
    if (!plan) return
    const next = new Set(picked)
    for (const item of plan.items) if (item.target === target && item.status === 'ready') next.add(item.key)
    setPicked(next)
  }

  /* ── loading a file ── */

  /** Put a file on the desk and clear every judgement made about the last one. */
  function loadText(text: string, name: string) {
    setFileText(text)
    setPlannedText(text)
    setFileName(name)
    setPicked(new Set())
    setOpen(new Set())
    setResults(null)
    setFlash('')
    setStatus('all')
    setGroup('all')
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    loadText(await file.text(), file.name)
    if (fileRef.current) fileRef.current.value = ''
  }

  function exportPlanCsv() {
    if (!plan) return
    download(`tally-plan-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(PLAN_CSV_HEADERS, planCsvRows(plan)))
  }

  /* ── writing the plan into the books ── */

  async function runImport() {
    if (!plan || !writeSet.length) return
    setImporting(true)
    setError('')
    setFlash('')

    // A row that is created here has its id kept, because the document that names it
    // is written next and its foreign key has to be real.
    const made = new Map<string, string>()
    const broken = new Map<string, string>()
    const out: WriteResult[] = []
    const tally = { customer: 0, vendor: 0, product: 0, invoice: 0, purchase_bill: 0, credit_note: 0, debit_note: 0, journal_draft: 0, challan_draft: 0 }

    for (const item of writeSet) {
      const waitingOn = item.requires.find(r => broken.has(r.key))
      if (waitingOn) {
        broken.set(item.key, `the ${item.target === 'invoice' ? 'invoice' : item.target === 'purchase_bill' ? 'bill' : 'row'} it belongs to`)
        out.push({ key: item.key, target: item.target, title: item.title, ok: false, detail: `Left unwritten — ${waitingOn.what} could not be created`, href: '' })
        continue
      }

      try {
        if (item.target === 'customer' || item.target === 'vendor') {
          const table = item.target === 'customer' ? 'customers' : 'vendors'
          const { data, error: err } = await supabase
            .from(table).insert({ ...item.fields, organization_id: orgId }).select('id').single()
          if (err) throw new Error(err.message)
          made.set(item.key, String(data.id))
          tally[item.target]++
          out.push({
            key: item.key, target: item.target, title: item.title, ok: true,
            detail: `Added to the ${item.target} register`,
            href: `/${item.target}?q=${encodeURIComponent(String(item.fields.name || ''))}`,
          })
        } else if (item.target === 'product') {
          const stock = item.fields.track_inventory ? Number(item.fields.opening_stock) || 0 : 0
          const { data, error: err } = await supabase
            .from('products')
            .insert({ ...item.fields, organization_id: orgId, current_stock: stock })
            .select('id').single()
          if (err) throw new Error(err.message)
          made.set(item.key, String(data.id))
          tally.product++
          out.push({
            key: item.key, target: 'product', title: item.title, ok: true,
            detail: stock ? `Added, opening stock ${stock}` : 'Added to the product register',
            href: `/products?q=${encodeURIComponent(String(item.fields.name || ''))}`,
          })
        } else if (item.target === 'invoice' || item.target === 'purchase_bill') {
          const isSale = item.target === 'invoice'
          const fields: Record<string, unknown> = { ...item.fields }
          const idField = isSale ? 'customer_id' : 'vendor_id'
          if (!fields[idField]) {
            const req = item.requires.find(r => r.key.startsWith(`${isSale ? 'customer' : 'vendor'}:`))
            const id = req ? made.get(req.key) : ''
            if (id) fields[idField] = id
          }
          const lines = item.lines.map(line => {
            if (line.product_id) return line
            const id = made.get(planKey('product', String(line.item_name || '')))
            return id ? { ...line, product_id: id } : line
          })

          if (isSale) {
            const { invoiceId, invoiceNumber } = await createInvoice(supabase, orgId, fields, lines)
            made.set(item.key, invoiceId)
            tally.invoice++
            out.push({ key: item.key, target: 'invoice', title: item.title, ok: true, detail: `Raised as ${invoiceNumber}`, href: `/invoices/${invoiceId}` })
          } else {
            const { billId, billNumber } = await createPurchaseBill(supabase, orgId, fields, lines)
            made.set(item.key, billId)
            tally.purchase_bill++
            out.push({ key: item.key, target: 'purchase_bill', title: item.title, ok: true, detail: `Booked as ${billNumber}`, href: `/bills?q=${encodeURIComponent(billNumber)}` })
          }
        } else if (item.target === 'credit_note' || item.target === 'debit_note') {
          const isCredit = item.target === 'credit_note'
          const fields: Record<string, unknown> = { ...item.fields }
          const partyField = isCredit ? 'customer_id' : 'vendor_id'
          if (!fields[partyField]) {
            const req = item.requires.find(r => r.key.startsWith(`${isCredit ? 'customer' : 'vendor'}:`))
            const id = req ? made.get(req.key) : ''
            if (id) fields[partyField] = id
          }
          const originalField = isCredit ? 'invoice_id' : 'bill_id'
          if (!fields[originalField]) {
            // The note may reverse a document raised earlier in this same import —
            // its plan key is in `requires`, and `made` holds the id by now.
            const req = item.requires.find(r => r.key.startsWith(`${isCredit ? 'invoice' : 'purchase_bill'}:`))
            const id = req ? made.get(req.key) : ''
            if (id) fields[originalField] = id
          }
          const lines = item.lines.map(line => {
            if (line.product_id) return line
            const id = made.get(planKey('product', String(line.item_name || '')))
            return id ? { ...line, product_id: id } : line
          })

          const { noteNumber } = isCredit
            ? await createCreditNote(supabase, orgId, fields, lines)
            : await createDebitNote(supabase, orgId, fields, lines)
          if (isCredit) tally.credit_note++
          else tally.debit_note++
          out.push({
            key: item.key, target: item.target, title: item.title, ok: true,
            detail: `Raised as ${noteNumber}`,
            href: `/${isCredit ? 'credit' : 'debit'}-notes?q=${encodeURIComponent(noteNumber)}`,
          })
        } else if (item.target === 'journal_draft') {
          // The journal register's own door: writeEntry asks the period seal even for a
          // draft, and a draft burns no number — the number is taken at posting. A sealed
          // month therefore refuses here exactly as it refuses a typed entry.
          const legs: JournalLeg[] = item.lines.map(l => ({
            ...newLeg(String(l.head_id || ''), (l.side === 'credit' ? 'credit' : 'debit') as LegSide),
            amount: Number(l.amount) || 0,
            note: String(l.note || ''),
          }))
          const entry = {
            ...newEntry(String(item.fields.date || '')),
            date: String(item.fields.date || ''),
            narration: String(item.fields.narration || ''),
            reference: String(item.fields.reference || ''),
            legs,
            status: 'draft' as const,
          }
          const res = writeEntry(orgId, entry, org.name || '')
          if (!res.ok) throw new Error(res.problems.join(' · '))
          made.set(item.key, res.entry.id)
          tally.journal_draft++
          out.push({
            key: item.key, target: 'journal_draft', title: item.title, ok: true,
            detail: `Drafted on the journal register — post it there to give it a number`,
            href: `/journal?q=${encodeURIComponent(entry.narration)}`,
          })
        } else if (item.target === 'challan_draft') {
          // R2-30's pattern: the draft lands through the register's own appendDraft, so its
          // number comes from the challan series' high-water mark, in the shop's own shape.
          const fields: Record<string, unknown> = { ...item.fields }
          if (!fields.party_id) {
            const req = item.requires.find(r => r.key.startsWith('customer:') || r.key.startsWith('vendor:'))
            const id = req ? made.get(req.key) : ''
            if (id) fields.party_id = id
          }
          const lines = item.lines.map(line => {
            if (line.product_id) return line
            const id = made.get(planKey('product', String(line.item_name || '')))
            return id ? { ...line, product_id: id } : line
          })
          const docDate = String(fields.doc_date || '')
          const doc = { ...newDoc('challan', '', docDate), ...fields, lines: lines as unknown as FlowLine[] } as FlowDoc
          const fmt = resolveSeries(loadSetup(orgId), 'challan')
          const raised = appendDraft('challan', loadStore('challan', orgId), getFinancialYear(new Date(`${docDate}T00:00:00`)), doc, fmt)
          saveStore('challan', orgId, raised.store)
          made.set(item.key, raised.doc.id)
          tally.challan_draft++
          out.push({
            key: item.key, target: 'challan_draft', title: item.title, ok: true,
            detail: `Drafted as ${raised.doc.number} — set its movement reason and confirm on /challans`,
            href: `/challans?q=${encodeURIComponent(raised.doc.number)}`,
          })
        }
      } catch (e) {
        broken.set(item.key, (e as Error).message)
        out.push({ key: item.key, target: item.target, title: item.title, ok: false, detail: (e as Error).message, href: '' })
      }
    }

    const failed = out.filter(r => !r.ok).length
    const flagged = [...writeDocs, ...writeDrafts].filter(d => d.flags.length).length
    setResults(out)
    setPicked(new Set())

    // The register moved underneath the plan, so the plan is rebuilt from the same file:
    // rows that were written flip to "Already here" instead of being importable twice.
    setExisting(await readRegister(orgId))
    const stamped = recordTallyImport(orgId, {
      file: fileName || 'Pasted text',
      customers: tally.customer,
      vendors: tally.vendor,
      products: tally.product,
      invoices: tally.invoice,
      bills: tally.purchase_bill,
      credit_notes: tally.credit_note,
      debit_notes: tally.debit_note,
      journal_drafts: tally.journal_draft,
      challan_drafts: tally.challan_draft,
      skipped: plan.summary.skipped,
      note: `${plural(tally.invoice + tally.purchase_bill + tally.credit_note + tally.debit_note, 'document')}, ${plural(tally.customer + tally.vendor + tally.product, 'master')}`
        + (tally.journal_draft + tally.challan_draft ? `, ${plural(tally.journal_draft + tally.challan_draft, 'draft')} awaiting a human` : '')
        + (flagged ? ` · ${flagged} carried a look-at-this` : '')
        + (failed ? ` · ${failed} failed` : ''),
    })
    setLog(stamped)
    setFlash(failed
      ? `${plural(out.length - failed, 'row')} written, ${failed} failed — the file is still here, so the rest can go after a fix.`
      : `${plural(tally.invoice + tally.purchase_bill + tally.credit_note + tally.debit_note, 'document')} and ${plural(tally.customer + tally.vendor + tally.product, 'master')} written from this file${tally.journal_draft + tally.challan_draft ? `, ${plural(tally.journal_draft + tally.challan_draft, 'draft')} raised for a human to post or confirm` : ''}.`)
    setImporting(false)
  }

  /* ── the other direction ── */

  async function loadExportDesk() {
    // Await first: the reads happen, and only then does this desk state what it found.
    const [invRes, billRes, custRes, vendRes, prodRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, invoice_date, customer_name, customer_gstin, customer_state, customer_state_code, notes, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, round_off, grand_total')
        .eq('organization_id', orgId).neq('status', 'cancelled').order('invoice_date', { ascending: false }).limit(2000),
      supabase.from('purchase_bills')
        .select('id, bill_number, bill_date, vendor_name, vendor_gstin, vendor_state_code, notes, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, round_off, grand_total')
        .eq('organization_id', orgId).neq('status', 'cancelled').order('bill_date', { ascending: false }).limit(2000),
      supabase.from('customers')
        .select('id, name, gstin, state, state_code, phone, email, address_line1, city, pincode')
        .eq('organization_id', orgId).eq('is_active', true).limit(3000),
      supabase.from('vendors')
        .select('id, name, gstin, state, state_code, phone, email, address_line1, city, pincode')
        .eq('organization_id', orgId).eq('is_active', true).limit(3000),
      supabase.from('products')
        .select('id, name, unit, hsn_sac, gst_rate, cess_rate, selling_price, purchase_price, current_stock, track_inventory, type')
        .eq('organization_id', orgId).eq('is_active', true).limit(3000),
    ])
    setExportError(invRes.error || billRes.error
      ? `Could not read the documents: ${(invRes.error || billRes.error)?.message}`
      : '')
    setExportInvoices((invRes.data || []) as ExportInvoiceRow[])
    setExportBills((billRes.data || []) as ExportBillRow[])
    setExportMasters({
      customers: (custRes.data || []) as ExportMasterRow[],
      vendors: (vendRes.data || []) as ExportMasterRow[],
      products: (prodRes.data || []) as ExportProductRow[],
    })
    setExportLoaded(true)
  }

  useEffect(() => {
    if (view !== 'export' || exportLoaded || !orgId || deskBusy.current) return
    deskBusy.current = true
    void loadExportDesk()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, orgId, exportLoaded])

  /** The lines of the documents that are picked — the file needs them, and nothing else does. */
  useEffect(() => {
    const invIds = [...pickedInv].filter(id => !items.has(`i:${id}`))
    const billIds = [...pickedBills].filter(id => !items.has(`b:${id}`))
    if (!invIds.length && !billIds.length) return
    let cancelled = false
    void (async () => {
      // A document with no lines still has to be marked as read, or the desk would wait forever.
      const found = new Map<string, ItemRow[]>()
      for (const id of invIds) found.set(`i:${id}`, [])
      for (const id of billIds) found.set(`b:${id}`, [])

      const grab = async (table: string, fk: string, ids: string[]) => {
        if (!ids.length) return
        const cols = DOC_ITEM_COLS.replace('invoice_id', fk)
        const rows = await fetchIn(ids, async slice => {
          const { data } = await supabase.from(table).select(cols).in(fk, slice).order('sort_order')
          return (data || []) as unknown as RawItemRow[]
        })
        for (const row of rows) {
          const key = `${fk === 'invoice_id' ? 'i' : 'b'}:${String(row[fk])}`
          const list = found.get(key)
          if (list) list.push(toItemRow(row, String(row[fk])))
        }
      }
      await grab('invoice_items', 'invoice_id', invIds)
      await grab('purchase_bill_items', 'bill_id', billIds)
      if (cancelled) return
      setItems(prev => {
        const next = new Map(prev)
        for (const [key, list] of found) next.set(key, list)
        return next
      })
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedInv, pickedBills])

  const exportData = useMemo<ExportData>(() => {
    const party = (p: { name: string | null; gstin: string | null; state: string | null; state_code: string | null; phone: string | null; email: string | null; address_line1: string | null; city: string | null; pincode: string | null }) => ({
      name: p.name || '',
      gstin: p.gstin || '',
      state_name: p.state || '',
      state_code: p.state_code || '',
      phone: p.phone || '',
      email: p.email || '',
      address: [p.address_line1, [p.city, p.pincode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    })
    const linesOf = (key: string) => (items.get(key) || []).map(line => ({
      item_name: line.item_name,
      hsn_sac: line.hsn_sac || '',
      quantity: Number(line.quantity) || 0,
      unit: line.unit || '',
      rate: Number(line.rate) || 0,
      taxable_value: line.taxable_value == null ? undefined : Number(line.taxable_value),
      gst_rate: line.gst_rate == null ? undefined : Number(line.gst_rate),
      cess_rate: line.cess_rate == null ? undefined : Number(line.cess_rate),
    }))

    const invoices: ExportDocument[] = exportInvoices
      .filter(r => pickedInv.has(r.id))
      .map(r => ({
        number: r.invoice_number,
        date: r.invoice_date,
        reference: tallyReference(r.notes),
        party: {
          name: r.customer_name || '',
          gstin: r.customer_gstin || '',
          state_name: r.customer_state || '',
          state_code: r.customer_state_code || '',
        },
        taxable_amount: r.taxable_amount,
        cgst_amount: r.cgst_amount,
        sgst_amount: r.sgst_amount,
        igst_amount: r.igst_amount,
        cess_amount: r.cess_amount,
        round_off: r.round_off,
        grand_total: r.grand_total,
        items: linesOf(`i:${r.id}`),
      }))
    const bills: ExportDocument[] = exportBills
      .filter(r => pickedBills.has(r.id))
      .map(r => ({
        // A bill's number is the vendor's own, so Tally receives it twice on purpose:
        // once as the voucher number and once in the reference field it screens.
        number: r.bill_number,
        date: r.bill_date,
        reference: tallyReference(r.notes) || r.bill_number,
        party: {
          name: r.vendor_name || '',
          gstin: r.vendor_gstin || '',
          state_code: r.vendor_state_code || '',
        },
        taxable_amount: r.taxable_amount,
        cgst_amount: r.cgst_amount,
        sgst_amount: r.sgst_amount,
        igst_amount: r.igst_amount,
        cess_amount: r.cess_amount,
        round_off: r.round_off,
        grand_total: r.grand_total,
        items: linesOf(`b:${r.id}`),
      }))

    return {
      invoices,
      bills,
      customers: includeMasters ? exportMasters.customers.map(party) : [],
      vendors: includeMasters ? exportMasters.vendors.map(party) : [],
      products: includeMasters ? exportMasters.products.map(p => ({
        name: p.name,
        unit: p.unit || '',
        hsn_sac: p.hsn_sac || '',
        gst_rate: p.gst_rate == null ? null : Number(p.gst_rate),
        cess_rate: p.cess_rate == null ? null : Number(p.cess_rate),
        selling_price: p.selling_price == null ? null : Number(p.selling_price),
        purchase_price: p.purchase_price == null ? null : Number(p.purchase_price),
        // Tally's opening balance is this app's live stock, not the figure typed years ago.
        opening_stock: p.track_inventory ? Number(p.current_stock) || 0 : 0,
        type: p.type === 'service' ? 'service' as const : 'goods' as const,
      })) : [],
    }
  }, [exportInvoices, exportBills, exportMasters, pickedInv, pickedBills, items, includeMasters])

  const preview = useMemo(() => exportSummary(exportData), [exportData])

  const fyStart = useMemo(() => {
    const now = new Date()
    return now.getMonth() >= 3 ? `${now.getFullYear()}-04-01` : `${now.getFullYear() - 1}-04-01`
  }, [])
  // The desk defaults to the running financial year because that is the one a filing cares
  // about; "All years" is one press away for a migration.
  const inPeriod = useCallback((date: string) => (
    period === 'all' || (date >= fyStart && date <= `${Number(fyStart.slice(0, 4)) + 1}-03-31`)
  ), [period, fyStart])

  const shownInvoices = useMemo(() => exportInvoices
    .filter(r => inPeriod(r.invoice_date))
    .filter(r => matchesAny(search, [r.invoice_number, r.customer_name, r.notes])), [exportInvoices, inPeriod, search])
  const shownBills = useMemo(() => exportBills
    .filter(r => inPeriod(r.bill_date))
    .filter(r => matchesAny(search, [r.bill_number, r.vendor_name, r.notes])), [exportBills, inPeriod, search])

  /** A picked document whose lines have not landed yet — the file cannot be written without them. */
  const linesPending = useMemo(
    () => [...pickedInv].some(id => !items.has(`i:${id}`)) || [...pickedBills].some(id => !items.has(`b:${id}`)),
    [pickedInv, pickedBills, items],
  )

  function makeXml() {
    setExportError('')
    setExportNote('')
    if (!exportData.invoices?.length && !exportData.bills?.length) {
      setExportError('Pick at least one document. Masters alone are a file with no vouchers in it.')
      return
    }
    if (linesPending) {
      setExportError('The line items of the picked documents are still arriving — one moment and it is ready.')
      return
    }
    if (!company.trim()) {
      setExportError('Tally refuses an import that does not name the company it is open on. Type that name.')
      return
    }
    const name = tallyExportFileName('all', preview.vouchers, getFinancialYear())
    saveXml(name, exportTallyXml(exportData, { company: company.trim(), action, includeMasters }))
    setExportNote(
      `${name} · ${plural(preview.vouchers, 'voucher')}, ${plural(preview.ledgers, 'ledger')}, ${plural(preview.stockItems, 'stock item')}, ${money(preview.rupees)} `
      + `· written ${action === 'Create' ? 'as new objects' : 'as updates to objects Tally already has'}${includeMasters ? ' with their masters' : ' as vouchers only'}.`,
    )
  }

  /* ── the import log ── */

  function clearLog() {
    if (!window.confirm('Forget which files this browser has imported? The books are untouched — only the log goes.')) return
    clearTallyImports(orgId)
    setLog([])
    setFlash('The import log is empty.')
  }

  /* ── render ── */

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Opening the Tally bridge…</div>
  }

  const hasFile = !!dump && !!plan

  return (
    <div className="page-container tb">
      <PageHeader
        eyebrow="The Tally bridge"
        title="Tally import and export"
        subtitle={
          <>
            Drop in a Tally export and every object becomes a row with a reason attached; pick the rows and
            they are written. Or pick your own invoices and bills and take a file TallyPrime will import.
          </>
        }
        actions={
          <Segmented
            value={view}
            onChange={v => setView(v as View)}
            options={[
              { value: 'plan', label: hasFile ? `Plan ${plan?.items.length || 0}` : 'Read a file' },
              { value: 'export', label: 'Send to Tally' },
              { value: 'log', label: `Import log ${log.length}` },
            ]}
          />
        }
      />

      {error && <div className="tb-alert tb-alert-red"><Icon name="alert" size={14} />{error}</div>}
      {flash && <div className="tb-alert tb-alert-green"><Icon name="check" size={14} />{flash}</div>}

      {/* ─────────────────────────── the plan ─────────────────────────── */}
      {view === 'plan' && (
        <>
          {!hasFile && (
            <div className={`tb-dropwrap ${dragging ? 'tb-drag' : ''}`}
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={e => {
                e.preventDefault()
                setDragging(false)
                void handleFile(e.dataTransfer.files?.[0])
              }}
            >
              <Card className="tb-drop">
              <div className="tb-load">
                <div className="tb-load-main">
                  <SectionTitle icon="upload">Put the Tally file here</SectionTitle>
                  <p className="tb-help">
                    TallyPrime → <em>Export</em> → <em>Data (xml)</em> → masters and/or vouchers, then drop the
                    <em> .xml</em> here or paste its rows. Nothing is written yet: the file becomes a plan of rows,
                    and the plan says for each one what it becomes and why.
                  </p>
                  <textarea
                    className="tb-textarea"
                    value={fileText}
                    onChange={e => setFileText(e.target.value)}
                    spellCheck={false}
                    placeholder={'<?xml version="1.0" encoding="UTF-8"?>\n<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>…'}
                    aria-label="Tally export XML"
                  />
                  <div className="tb-load-actions">
                    <Button size="sm" icon="file-check" onClick={() => loadText(fileText, fileName || 'Pasted text')}
                      disabled={!fileText.trim() || fileText === plannedText}>
                      Read what I pasted
                    </Button>
                    <Button size="sm" variant="subtle" icon="upload" onClick={() => fileRef.current?.click()}>
                      Choose a .xml file
                    </Button>
                    <Button size="sm" variant="ghost" icon="zap" onClick={() => loadText(SAMPLE_TALLY_DUMP, 'sample-tally-export.xml')}>
                      Try it on a sample file
                    </Button>
                    <input ref={fileRef} type="file" accept=".xml,.txt" hidden aria-hidden
                      onChange={e => void handleFile(e.target.files?.[0])} />
                  </div>
                  {readError && <div className="tb-alert tb-alert-red"><Icon name="alert" size={14} />{readError}</div>}
                  {!dump && !readError && !!fileText.trim() && (
                    <p className="tb-help tb-wait">The file is in the box — press <strong>Read what I pasted</strong> to turn it into a plan.</p>
                  )}
                </div>

                <div className="tb-load-side">
                  <div className="tb-shape">What the reader takes on faith</div>
                  <ul className="tb-points">
                    <li><strong>Groups decide the role.</strong> Sundry Debtors is a customer, Sundry Creditors a vendor; anything else is skipped with the reason, never guessed into a party.</li>
                    <li><strong>Tax comes from ledger names.</strong> <em>Output CGST @9%</em> is an 18% slab on a same-state supply; the rate is labelled wherever it had to be worked out.</li>
                    <li><strong>Both sides of a voucher are read.</strong> A sale and a purchase differ only in which side the party sits on, so the reader checks the balance before it trusts a total.</li>
                    <li><strong>Where the file disagrees with itself</strong> — printed total against line totals, IGST against two states — the row says so and the lines win.</li>
                  </ul>
                  <div className="tb-shape">What this will not do</div>
                  <ul className="tb-points">
                    <li><strong>No money.</strong> A receipt inside a voucher is reported, and the document lands unpaid; money is recorded on <Link href="/payments">/payments</Link>.</li>
                    <li><strong>No invented names.</strong> A voucher for a party or an item that neither the file nor the register has is blocked, and says which name is missing.</li>
                    <li><strong>No second copy.</strong> A document whose Tally reference is already in the register reads as already here.</li>
                    <li><strong>No return.</strong> An import writes books, not GSTR-1: check the flagged rows before a filing.</li>
                  </ul>
                  <div className="tb-shape">Also on this desk</div>
                  <p className="tb-help">
                    <strong>Send to Tally</strong> writes our invoices, bills and masters as the import XML — with our
                    invoice numbers, so the two books stay tied.
                  </p>
                </div>
              </div>
              </Card>
            </div>
          )}

          {hasFile && plan && (
            <>
              <div className="tb-stats">
                <StatCard label="Objects read" value={String(plan.summary.objects)}
                  sub={`${plan.summary.ledgers} ledgers · ${plan.summary.stockItems} items · ${plan.summary.vouchers} vouchers`}
                  icon="book" tone="blue" />
                <StatCard label="Ready to write" value={String(plan.summary.ready)}
                  sub={`${plural(plan.summary.byTarget.invoice.count + plan.summary.byTarget.purchase_bill.count + plan.summary.byTarget.credit_note.count + plan.summary.byTarget.debit_note.count, 'document')} · ${money(plan.summary.byTarget.invoice.rupees + plan.summary.byTarget.purchase_bill.rupees + plan.summary.byTarget.credit_note.rupees + plan.summary.byTarget.debit_note.rupees)}`}
                  icon="check" tone="green" />
                <StatCard label="Blocked" value={String(plan.summary.blocked)}
                  sub="the file never named what they need" icon="alert" tone="red" />
                <StatCard label="Needs your eye" value={String(plan.summary.attention)}
                  sub={plan.summary.from ? `file covers ${formatDateIN(plan.summary.from)} – ${formatDateIN(plan.summary.to)}` : 'a disagreement inside the file'}
                  icon="scan" tone="amber" />
              </div>

              <div className="tb-filebar">
                <span className="tb-filename"><Icon name="file-check" size={13} />{fileName || 'Pasted text'}</span>
                <span className="tb-fmeta">{plural(plan.items.length, 'row')} · {plural(dump?.parsedNodes || 0, 'tag')} read</span>
                {dump && dump.envelope === 'request' && (
                  <Badge tone="amber" dot={false}>this looks like a Tally <em>request</em>, not an export</Badge>
                )}
                {!!dump?.issues.length && <Badge tone="amber" dot={false}>{plural(dump.issues.length, 'reader note')}</Badge>}
                <span className="tb-filer">
                  <button type="button" className="tb-link" onClick={() => loadText('', '')}>
                    <Icon name="x" size={12} /> Put another file
                  </button>
                  <button type="button" className="tb-link" onClick={() => void readRegister(orgId).then(setExisting)}>
                    <Icon name="swap" size={12} /> Re-read the register
                  </button>
                  <button type="button" className="tb-link" onClick={exportPlanCsv}>
                    <Icon name="download" size={12} /> Plan as CSV
                  </button>
                </span>
              </div>

              {!!dump?.issues.length && (
                <Card className="tb-issues">
                  <SectionTitle icon="alert">What the reader could not make of the file</SectionTitle>
                  <ul className="tb-points">
                    {dump.issues.slice(0, 8).map((issue, i) => (
                      <li key={`iss-${i}`}><strong>Tag {issue.at}</strong> — {issue.message}</li>
                    ))}
                    {dump.issues.length > 8 && <li>… {plural(dump.issues.length - 8, 'more note')} in the CSV.</li>}
                  </ul>
                </Card>
              )}

              <div className="tb-toolbar">
                <Segmented value={status} onChange={setStatus}
                  options={STATUS_FILTERS.map(f => ({
                    value: f.value,
                    label: f.value === 'all' ? `All ${counts.byStatus.all}` : `${f.label.split(' ')[0]} ${counts.byStatus[f.value] || 0}`,
                  }))} />
                <div className="tb-chips">
                  <button type="button" className={`tb-chip ${group === 'all' ? 'tb-chip-on' : ''}`} onClick={() => setGroup('all')}>
                    Every kind {counts.byGroup.all}
                  </button>
                  {GROUPS.filter(g => counts.byGroup[g]).map(g => (
                    <button key={g} type="button" className={`tb-chip ${group === g ? 'tb-chip-on' : ''}`} onClick={() => setGroup(group === g ? 'all' : g)}>
                      {TARGET_LABEL[g]} {counts.byGroup[g]}
                    </button>
                  ))}
                </div>
                <SearchInput value={search} onChange={setSearch} ariaLabel="Search plan rows"
                  placeholder="Party, item, voucher number…" style={{ minWidth: 180, flex: 1, maxWidth: 300 }} />
              </div>

              <Card pad={false} className="tb-bar">
                <div className="tb-bar-main">
                  <div className="tb-bar-line">
                    <strong>{writeSet.length}</strong> {writeSet.length === 1 ? 'row' : 'rows'} will be written
                    <span className="tb-dot">·</span>
                    {plural(writeDocs.length, 'document')} worth <strong className="tb-num">{money(writeRupees)}</strong>
                    <span className="tb-dot">·</span>
                    {plural(writeMasters, 'master')} first
                    {!!writeDrafts.length && (
                      <>
                        <span className="tb-dot">·</span>
                        {plural(writeDrafts.length, 'draft')} — posted or confirmed by a human, not by this import
                      </>
                    )}
                    {picked.size > writeSet.length && (
                      <em className="tb-faint"> — {plural(picked.size - writeSet.length, 'picked row')} not ready and left out of this import</em>
                    )}
                  </div>
                  <ProgressBar value={writeSet.length} max={Math.max(plan.summary.ready, 1)}
                    color="var(--green)" height={6} />
                </div>
                <div className="tb-bar-side">
                  <button type="button" className="tb-link" onClick={pickAllReady}>Pick every ready row</button>
                  {!!picked.size && <button type="button" className="tb-link tb-danger" onClick={() => setPicked(new Set())}>Clear {picked.size}</button>}
                  <Button size="sm" icon={importing ? 'clock' : 'upload'} onClick={() => void runImport()}
                    disabled={!writeSet.length || importing}>
                    {importing ? 'Writing…' : `Import ${plural(writeSet.length, 'row')}`}
                  </Button>
                </div>
              </Card>

              {!visible.length ? (
                <Card><EmptyState icon="search" title="Nothing in this slice"
                  message="No row matches this status, kind and search together." /></Card>
              ) : groups.map(g => (
                <div key={g.target} className="tb-block">
                  <div className="tb-block-head">
                    <span className="tb-block-title">
                      <Icon name={GROUP_ICON[g.target]} size={14} />
                      {TARGET_LABEL[g.target]}
                      <em className="tb-block-count">{g.rows.length}</em>
                    </span>
                    <button type="button" className="tb-link" onClick={() => pickGroupReady(g.target)}>
                      Pick the ready ones
                    </button>
                  </div>
                  <div className="table-frame">
                    <div className="responsive-table">
                      <div className="table-header tb-row tb-head">
                        <span data-label="Write">
                          <input type="checkbox" aria-label={`Pick every ready ${TARGET_LABEL[g.target]} row`}
                            checked={g.rows.every(r => r.status !== 'ready' || picked.has(r.key)) && g.rows.some(r => r.status === 'ready')}
                            onChange={e => {
                              const next = new Set(picked)
                              for (const row of g.rows) {
                                if (row.status !== 'ready') continue
                                if (e.target.checked) next.add(row.key)
                                else next.delete(row.key)
                              }
                              setPicked(next)
                            }} />
                        </span>
                        <span data-label="Row">{g.target === 'other' ? 'Stays in Tally' : 'Becomes'}</span>
                        <span data-label="Tally">In the file</span>
                        <span data-label="Rupees" className="tb-right">{g.target === 'other' ? 'Value' : 'Rupees'}</span>
                        <span data-label="" className="tb-right">Detail</span>
                      </div>
                      {g.rows.map(item => <PlanRow key={item.key} item={item} plan={plan}
                        picked={picked.has(item.key)} open={open.has(item.key)}
                        onPick={() => togglePick(item.key)} onOpen={() => toggleOpen(item.key)} />)}
                    </div>
                  </div>
                </div>
              ))}

              {!!dump?.issues.length && (
                <p className="tb-foot-note">The reader kept {plural(dump.objectTags && Object.keys(dump.objectTags).length, 'kind')} of object in this file; only ledgers, stock items and vouchers are planned, and the rest are listed above as they arrived.</p>
              )}
            </>
          )}

          {results && (
            <Card className="tb-results">
              <SectionTitle icon="check"
                action={<button type="button" className="tb-link" onClick={() => setResults(null)}>Close</button>}>
                What this import wrote
              </SectionTitle>
              <div className="tb-results-list">
                {results.map(r => (
                  <div key={r.key} className={`tb-result ${r.ok ? '' : 'tb-result-bad'}`}>
                    <Icon name={r.ok ? 'check' : 'alert'} size={14} />
                    <span className="tb-result-main">
                      <span className="tb-result-title">{r.title}</span>
                      <span className="tb-result-detail">{r.detail}</span>
                    </span>
                    {r.href && (r.href.startsWith('/')
                      ? <Link className="tb-link" href={r.href}>Open</Link>
                      : <span className="tb-faint">{r.href}</span>)}
                  </div>
                ))}
              </div>
              <p className="tb-foot-note">
                The same file is still planned below, now matched against what was written — a row that landed reads as
                <em> Already here</em>, so a second press cannot raise a second invoice. Money is on <Link href="/payments">/payments</Link>.
              </p>
            </Card>
          )}
        </>
      )}

      {/* ─────────────────────────── the other direction ─────────────────────────── */}
      {view === 'export' && (
        <>
          {!exportLoaded && (
            <div className="tb-loading">Reading your documents and masters…</div>
          )}
          {exportLoaded && (
            <>
              <div className="tb-stats">
                <StatCard label="On this desk" value={String(exportInvoices.length + exportBills.length)}
                  sub={`${plural(exportInvoices.length, 'invoice')} · ${plural(exportBills.length, 'bill')}`} icon="book" tone="blue" />
                <StatCard label="Picked" value={String(preview.vouchers)}
                  sub={`${money(preview.rupees)} of vouchers`} icon="check" tone="green" />
                <StatCard label="Ledgers to write" value={String(preview.ledgers)}
                  sub={includeMasters ? 'parties from your register' : 'vouchers only'} icon="users" tone="violet" />
                <StatCard label="Stock items" value={String(preview.stockItems)}
                  sub="one per goods or service named" icon="box" tone="cyan" />
              </div>

              <div className="tb-export">
                <Card pad={false} className="tb-pick">
                  <div className="tb-pick-head">
                    <Segmented value={docTab} onChange={setDocTab} options={[
                      { value: 'invoices', label: `Invoices ${shownInvoices.length}` },
                      { value: 'bills', label: `Bills ${shownBills.length}` },
                    ]} />
                    <Segmented value={period} onChange={setPeriod} options={[
                      { value: 'this-fy', label: 'This FY' },
                      { value: 'all', label: 'All years' },
                    ]} />
                    {(() => {
                      const rows = docTab === 'invoices' ? shownInvoices : shownBills
                      // A slice with no rows has nothing to bulk-pick; the control would only read "Pick these 0".
                      if (rows.length === 0) return null
                      const all = rows.every(r => (docTab === 'invoices' ? pickedInv : pickedBills).has(r.id))
                      return (
                        <button type="button" className="tb-link" onClick={() => {
                          const next = new Set(docTab === 'invoices' ? pickedInv : pickedBills)
                          for (const row of rows) {
                            if (all) next.delete(row.id)
                            else next.add(row.id)
                          }
                          if (docTab === 'invoices') setPickedInv(next)
                          else setPickedBills(next)
                        }}>
                          {all ? `Leave out these ${rows.length}` : `Pick these ${rows.length}`}
                        </button>
                      )
                    })()}
                  </div>
                  <SearchInput value={search} onChange={setSearch} ariaLabel="Search documents"
                    placeholder="Number, party, note…" style={{ margin: '0 14px 10px', maxWidth: 320 }} />
                  <div className="table-frame">
                    <div className="responsive-table">
                      <div className="table-header tb-xrow tb-xhead">
                        <span data-label="Write"><span aria-hidden>✓</span></span>
                        <span data-label="Document">Document</span>
                        <span data-label="Party">Party</span>
                        <span data-label="Money" className="tb-right">Rupees</span>
                        <span data-label="Lines" className="tb-right">Lines</span>
                      </div>
                      {docTab === 'invoices' && shownInvoices.map(r => (
                        <ExportRow key={r.id} checked={pickedInv.has(r.id)}
                          onToggle={() => setPickedInv(prev => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n })}
                          number={r.invoice_number} date={r.invoice_date} party={r.customer_name || '—'}
                          rupees={Number(r.grand_total) || 0} lines={items.get(`i:${r.id}`)?.length ?? null}
                          note={tallyReference(r.notes)} />
                      ))}
                      {docTab === 'bills' && shownBills.map(r => (
                        <ExportRow key={r.id} checked={pickedBills.has(r.id)}
                          onToggle={() => setPickedBills(prev => { const n = new Set(prev); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); return n })}
                          number={r.bill_number} date={r.bill_date} party={r.vendor_name || '—'}
                          rupees={Number(r.grand_total) || 0} lines={items.get(`b:${r.id}`)?.length ?? null}
                          note="" />
                      ))}
                      {!(docTab === 'invoices' ? shownInvoices : shownBills).length && (
                        <EmptyState icon="search" title="Nothing in this slice" message="Widen the year or clear the search." />
                      )}
                    </div>
                  </div>
                </Card>

                <Card className="tb-side">
                  <SectionTitle icon="download">The file Tally will receive</SectionTitle>
                  <label className="tb-field">
                    <span>Company name in Tally</span>
                    <input value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. D&V Software"
                      aria-label="The company Tally is open on" />
                    <em>Tally matches the import against the company that is open on its screen.</em>
                  </label>
                  <div className="tb-field">
                    <span>Action on every object</span>
                    <Segmented value={action} onChange={v => setAction(v as TallyAction)} options={[
                      { value: 'Create', label: 'Create' },
                      { value: 'Alter', label: 'Alter' },
                    ]} />
                    <em>Create adds; Alter updates the ledger or voucher of that name. Nothing else is claimed.</em>
                  </div>
                  <label className="tb-check">
                    <input type="checkbox" checked={includeMasters} onChange={e => setIncludeMasters(e.target.checked)} />
                    <span>Write the masters too</span>
                  </label>
                  <p className="tb-help">
                    Off, the file is vouchers only — for a Tally that already keeps its own ledgers and stock items.
                    On, every party, product and tax ledger a voucher names is written beside it, because a voucher
                    naming <em>Output IGST @18%</em> into a company without that ledger is the classic failed import.
                  </p>

                  <div className="tb-tally">
                    <StatRow label="Vouchers" value={preview.vouchers} />
                    <StatRow label="Ledgers" value={preview.ledgers} tone={includeMasters ? 'violet' : 'grey'} />
                    <StatRow label="Stock items" value={preview.stockItems} tone={includeMasters ? 'violet' : 'grey'} />
                    <StatRow label="Rupees in the file" value={money(preview.rupees)} strong />
                  </div>

                  {exportError && <div className="tb-alert tb-alert-red"><Icon name="alert" size={14} />{exportError}</div>}
                  {exportNote && <div className="tb-alert tb-alert-green"><Icon name="check" size={14} />{exportNote}</div>}

                  <Button icon="download" onClick={makeXml} disabled={!preview.vouchers || linesPending}
                    title={linesPending ? 'Line items are still arriving' : undefined}>
                    {linesPending ? 'Reading the lines…' : `Write ${plural(preview.vouchers, 'voucher')} to XML`}
                  </Button>
                  <p className="tb-help tb-after">
                    {tallyExportFileName('all', preview.vouchers, getFinancialYear())} in your Downloads, then in TallyPrime:
                    <em> Import → Masters / Vouchers (through a data file)</em>. Where a document’s own totals and its lines
                    disagree, the file says so in a comment at the top and hands the lines over.
                  </p>
                  <div className="tb-side-links">
                    <Link href="/invoices">Invoices</Link><span className="tb-faint">·</span>
                    <Link href="/bills">Bills</Link><span className="tb-faint">·</span>
                    <Link href="/customers">Customers</Link><span className="tb-faint">·</span>
                    <Link href="/products">Products</Link>
                  </div>
                </Card>
              </div>
            </>
          )}
        </>
      )}

      {/* ─────────────────────────── the log ─────────────────────────── */}
      {view === 'log' && (
        <>
          <div className="tb-toolbar">
            <span className="tb-help">
              {log.length ? `${plural(log.length, 'import')} this browser has run for this business.` : 'The log is local to this browser: which file, when, and what it wrote.'}
            </span>
            {!!log.length && <Button size="sm" variant="ghost" icon="undo" onClick={clearLog}>Forget the log</Button>}
          </div>
          {!log.length ? (
            <Card>
              <EmptyState icon="upload" title="No import recorded here"
                message="Reading a Tally file and importing the ready rows leaves its account of itself here."
                action={<Button size="sm" icon="zap" onClick={() => setView('plan')}>Read a file</Button>} />
            </Card>
          ) : (
            <div className="tb-history">
              {log.map(r => (
                <Card key={r.id} className="tb-hist">
                  <div className="tb-hist-main">
                    <div className="tb-hist-name">{r.file}</div>
                    <div className="tb-hist-sub">{new Date(r.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {r.note}</div>
                    <div className="tb-cols">
                      {!!r.invoices && <span className="tb-chip-2">{plural(r.invoices, 'invoice')}</span>}
                      {!!r.bills && <span className="tb-chip-2">{plural(r.bills, 'bill')}</span>}
                      {!!r.credit_notes && <span className="tb-chip-2">{plural(r.credit_notes, 'credit note')}</span>}
                      {!!r.debit_notes && <span className="tb-chip-2">{plural(r.debit_notes, 'debit note')}</span>}
                      {!!r.journal_drafts && <span className="tb-chip-2">{plural(r.journal_drafts, 'journal draft')}</span>}
                      {!!r.challan_drafts && <span className="tb-chip-2">{plural(r.challan_drafts, 'challan draft')}</span>}
                      {!!r.customers && <span className="tb-chip-2">{plural(r.customers, 'customer')}</span>}
                      {!!r.vendors && <span className="tb-chip-2">{plural(r.vendors, 'vendor')}</span>}
                      {!!r.products && <span className="tb-chip-2">{plural(r.products, 'product')}</span>}
                      {!!r.skipped && <span className="tb-chip-2">{plural(r.skipped, 'object')} left alone</span>}
                    </div>
                  </div>
                  <div className="tb-hist-side">
                    <Badge tone="blue" dot={false}>written here</Badge>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <style>{`
        .tb-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 0.85rem; }

        .tb-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .tb-alert-red { background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .tb-alert-green { background: var(--green-soft); color: var(--green); border-left: 3px solid var(--green); }

        .tb-drop { transition: border-color .15s ease, box-shadow .15s ease; }
        .tb-drag .tf-card { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-soft); }
        .tb-load { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr); gap: 24px; }
        .tb-load-main { display: flex; flex-direction: column; min-width: 0; }
        .tb-textarea { width: 100%; min-height: 180px; margin-top: 10px; font-family: var(--mono);
          font-size: 11.5px; line-height: 1.55; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius-sm); padding: 10px 11px; outline: none; resize: vertical; }
        .tb-textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); background: var(--surface); }
        .tb-load-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; align-items: center; }
        .tb-wait { margin-top: 10px; }
        .tb-help { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0 0 10px; }
        .tb-help strong, .tb-help em { color: var(--ink-2); font-style: normal; font-weight: 650; }
        .tb-load-side { display: flex; flex-direction: column; gap: 4px; }
        .tb-shape { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin: 8px 0; }
        .tb-points { margin: 0 0 10px; padding-left: 16px; display: flex; flex-direction: column; gap: 7px; }
        .tb-points li { font-size: 12px; color: var(--muted); line-height: 1.55; }
        .tb-points strong { color: var(--ink-2); font-weight: 650; }
        .tb-points em { font-style: normal; color: var(--ink-2); font-family: var(--mono); font-size: 11px; }

        .tb-filebar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--muted);
          background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 10px; padding: 9px 13px; margin-bottom: 12px; }
        .tb-filename { display: inline-flex; align-items: center; gap: 6px; font-weight: 650; color: var(--ink); }
        .tb-fmeta { color: var(--faint); }
        .tb-filer { margin-left: auto; display: flex; gap: 12px; flex-wrap: wrap; }

        .tb-issues { margin-bottom: 12px; }

        .tb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .tb-chips { display: flex; gap: 5px; flex-wrap: wrap; }
        .tb-chip { font: inherit; font-size: 11.5px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line);
          border-radius: 99px; padding: 4px 11px; cursor: pointer; }
        .tb-chip:hover { color: var(--ink); border-color: var(--brand); }
        .tb-chip-on { background: var(--brand-soft); color: var(--brand); border-color: var(--brand); font-weight: 650; }

        .tb-bar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px;
          border: 1px solid var(--line); box-shadow: var(--shadow-xs); }
        .tb-bar-main { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 9px; padding: 12px 14px; }
        .tb-bar-line { font-size: 12.5px; color: var(--ink-2); display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
        .tb-bar-line strong { color: var(--ink); font-weight: 700; }
        .tb-bar-side { display: flex; flex-direction: column; align-items: flex-end; gap: 7px; padding: 12px 14px 12px 0; }
        .tb-dot { color: var(--faint); }
        .tb-num { font-variant-numeric: tabular-nums; }

        .tb-block { margin-bottom: 16px; }
        .tb-block-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
        .tb-block-title { display: inline-flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 700;
          letter-spacing: 0.05em; text-transform: uppercase; color: var(--ink-2); }
        .tb-block-count { font-style: normal; font-size: 11px; color: var(--faint); background: var(--surface-2);
          border-radius: 99px; padding: 1px 8px; }

        .tb-row { display: grid; grid-template-columns: 30px minmax(0, 1.7fr) minmax(0, 1.05fr) 104px 74px; gap: 12px;
          align-items: center; padding: 10px 14px; font-size: 12.5px; border-bottom: 1px solid var(--line-soft); }
        .tb-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px; font-weight: 650;
          color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .tb-right { text-align: right; }
        .tb-row input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--brand); cursor: pointer; }
        .tb-row:disabled { opacity: .4; cursor: not-allowed; }

        .tb-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .tb-open { display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 12.5px; color: var(--ink);
          background: none; border: none; cursor: pointer; padding: 0; text-align: left; font-weight: 650; min-width: 0; }
        .tb-open:hover { color: var(--brand); }
        .tb-sub { font-size: 11.5px; color: var(--muted); font-weight: 450; overflow-wrap: anywhere; }
        .tb-ref { font-family: var(--mono); font-size: 11px; color: var(--faint); overflow-wrap: anywhere; }
        .tb-rupees { font-variant-numeric: tabular-nums; font-weight: 650; color: var(--ink-2); }
        .tb-flags { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--amber); justify-content: flex-end; }
        .tb-dim { opacity: .62; }
        .tb-on { background: var(--green-soft); }

        .tb-detail { padding: 4px 14px 16px 56px; display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
          gap: 18px; border-bottom: 1px solid var(--line-soft); background: var(--surface-2); }
        .tb-notes { display: flex; flex-direction: column; gap: 8px; }
        .tb-note { display: flex; gap: 8px; font-size: 12px; line-height: 1.5; }
        .tb-note svg { flex: none; margin-top: 2px; }
        .tb-bad { color: var(--red); }
        .tb-warn { color: var(--amber); }
        .tb-plain { color: var(--muted); }
        .tb-label { font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin-bottom: 2px; }
        .tb-money { min-width: 0; }
        .tb-tally .tb-money-row { display: flex; justify-content: space-between; font-size: 12.5px; padding: 7px 0; border-bottom: 1px solid var(--line-soft); }
        .tb-lines { margin-top: 10px; overflow: hidden; border: 1px solid var(--line); border-radius: 8px; }
        .tb-lines-head, .tb-lines-row { display: grid; grid-template-columns: minmax(0, 1.6fr) 78px 52px 74px 74px 82px; gap: 8px;
          padding: 7px 10px; font-size: 11.5px; }
        .tb-lines-head { background: var(--slate-soft); color: var(--faint); font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; }
        .tb-lines-row { border-top: 1px solid var(--line-soft); color: var(--ink-2); }
        .tb-lines-draft .tb-lines-head, .tb-lines-draft .tb-lines-row { grid-template-columns: minmax(0, 1.6fr) 130px 92px; }
        .tb-fields { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px; }
        .tb-field-chip { font-size: 10.5px; color: var(--muted); background: var(--surface); border: 1px solid var(--line);
          border-radius: 99px; padding: 2px 9px; }
        .tb-field-chip strong { color: var(--ink-2); font-weight: 650; }
        .tb-needs { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; }
        .tb-need { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--brand); }

        .tb-results { margin-top: 16px; }
        .tb-results-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
        .tb-result { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 9px; align-items: center;
          background: var(--surface-2); border: 1px solid var(--line-soft); border-radius: 10px; padding: 9px 11px; font-size: 12px; }
        .tb-result-bad { border-color: var(--red); background: var(--red-soft); }
        .tb-result-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .tb-result-title { font-weight: 650; color: var(--ink); overflow-wrap: anywhere; }
        .tb-result-detail { color: var(--muted); overflow-wrap: anywhere; }

        .tb-foot-note { font-size: 11.5px; color: var(--faint); line-height: 1.55; margin: 12px 0 0; }
        .tb-foot-note em { font-style: normal; color: var(--ink-2); }
        .tb-faint { color: var(--faint); }
        .tb-link { font: inherit; font-size: 11.5px; color: var(--brand); background: none; border: none; cursor: pointer;
          display: inline-flex; align-items: center; gap: 4px; padding: 0; text-decoration: none; }
        .tb-link:hover { text-decoration: underline; }
        .tb-danger { color: var(--red); }
        .tb-loading { font-size: 12.5px; color: var(--muted); padding: 18px 2px; }

        .tb-export { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 16px; align-items: start; }
        .tb-pick-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 14px 10px; }
        .tb-xrow { display: grid; grid-template-columns: 34px minmax(0, 1fr) minmax(0, 1fr) 104px 60px; gap: 10px;
          align-items: center; padding: 9px 14px; font-size: 12.5px; border-bottom: 1px solid var(--line-soft); }
        .tb-xhead { background: var(--surface-2); font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .tb-xrow input[type="checkbox"] { width: 15px; height: 15px; accent-color: var(--brand); cursor: pointer; }
        .tb-xnum { font-weight: 650; color: var(--ink); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .tb-xdate { font-size: 11px; color: var(--faint); font-weight: 450; }
        .tb-xparty { color: var(--muted); overflow-wrap: anywhere; }
        .tb-xlines { color: var(--faint); font-size: 11.5px; }

        .tb-side { display: flex; flex-direction: column; gap: 4px; }
        .tb-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 12px; }
        .tb-field > span { font-size: 11px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--faint); }
        .tb-field input { font: inherit; font-size: 12.5px; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
          border-radius: 8px; padding: 8px 10px; outline: none; }
        .tb-field input:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); background: var(--surface); }
        .tb-field em { font-size: 11px; color: var(--faint); font-style: normal; line-height: 1.5; }
        .tb-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--ink-2); margin-bottom: 8px; cursor: pointer; }
        .tb-check input { width: 15px; height: 15px; accent-color: var(--brand); }
        .tb-tally { margin: 8px 0 12px; }
        .tb-after { margin-top: 10px; }
        .tb-side-links { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11.5px; margin-top: 6px; }

        .tb-history { display: flex; flex-direction: column; gap: 10px; }
        .tb-hist { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center; }
        .tb-hist-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .tb-hist-name { font-size: 13px; font-weight: 650; color: var(--ink); }
        .tb-hist-sub { font-size: 11.5px; color: var(--muted); }
        .tb-hist-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .tb-cols { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
        .tb-chip-2 { font-size: 10.5px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line-soft);
          border-radius: 99px; padding: 1px 8px; }

        @media (max-width: 1100px) {
          .tb-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .tb-export { grid-template-columns: minmax(0, 1fr); }
          .tb-detail { grid-template-columns: minmax(0, 1fr); gap: 14px; padding-left: 44px; }
        }
        @media (max-width: 768px) {
          .tb-load { grid-template-columns: minmax(0, 1fr); gap: 18px; }
          .tb-bar { flex-direction: column; align-items: stretch; }
          .tb-bar-side { flex-direction: row; justify-content: space-between; padding: 0 14px 12px; align-items: center; }
          .tb-row { grid-template-columns: 26px minmax(0, 1fr) 90px; }
          .tb-row .tb-ref-cell, .tb-row .tb-detail-cell { display: none; }
          .tb-detail { padding-left: 14px; }
          .tb-lines-head, .tb-lines-row { grid-template-columns: minmax(0, 1.4fr) 60px 70px 78px; }
          .tb-lines-head span:nth-child(3), .tb-lines-row span:nth-child(3),
          .tb-lines-head span:nth-child(4), .tb-lines-row span:nth-child(4) { display: none; }
          .tb-lines-draft .tb-lines-head, .tb-lines-draft .tb-lines-row { grid-template-columns: minmax(0, 1.4fr) 78px 92px; }
          .tb-lines-draft .tb-lines-head span:nth-child(3), .tb-lines-draft .tb-lines-row span:nth-child(3) { display: inline; }
          .tb-xrow { grid-template-columns: 30px minmax(0, 1fr) 96px; }
          .tb-xrow .tb-xparty-cell, .tb-xrow .tb-xlines-cell { display: none; }
          .tb-filer { margin-left: 0; }
        }
      `}</style>
    </div>
  )
}

/** One row of the plan, and the reasons under it when it is open. */
function PlanRow({
  item, plan, picked, open, onPick, onOpen,
}: {
  item: PlanItem
  plan: ImportPlan
  picked: boolean
  open: boolean
  onPick: () => void
  onOpen: () => void
}) {
  const isDoc = item.target === 'invoice' || item.target === 'purchase_bill'
  const fields = item.fields as Record<string, unknown>
  const rupees = item.rupees

  return (
    <>
      <div className={`table-row tb-row ${picked ? 'tb-on' : ''} ${item.status === 'skipped' ? 'tb-dim' : ''}`}>
        <span data-label="Write">
          <input type="checkbox" checked={picked} disabled={item.status !== 'ready'}
            aria-label={`Write ${item.title}`} onChange={onPick} />
        </span>
        <span data-label="Row" className="tb-main">
          <button type="button" className="tb-open" onClick={onOpen} aria-expanded={open}>
            <Badge tone={STATUS_TONE[item.status]} dot={false}>{STATUS_LABEL[item.status]}</Badge>
            {item.title}
            {(item.reasons.length || item.flags.length) && <Icon name="chevron-down" size={12} />}
          </button>
          <span className="tb-sub">{item.subtitle}</span>
        </span>
        <span data-label="Tally" className="tb-ref-cell"><span className="tb-ref">{item.tallyRef || '—'}</span></span>
        <span data-label="Rupees" className="tb-right tb-num tb-rupees">{rupees ? inr.format(rupees) : '—'}</span>
        <span data-label="Detail" className="tb-right tb-detail-cell">
          {item.flags.length
            ? <span className="tb-flags"><Icon name="alert" size={11} />{item.flags.length}</span>
            : item.reasons.length
              ? <span className="tb-flags" style={{ color: 'var(--red)' }}><Icon name="x" size={11} />{item.reasons.length}</span>
              : <span className="tb-faint">{open ? 'close' : '—'}</span>}
        </span>
      </div>

      {open && (
        <div className="tb-detail">
          <div className="tb-notes">
            {!!item.reasons.length && (
              <>
                <div className="tb-label">Why it cannot be written</div>
                {item.reasons.map((r, i) => <Note key={`r${i}`} kind="bad" text={r} />)}
              </>
            )}
            {!!item.flags.length && (
              <>
                <div className="tb-label">Read this before you file</div>
                {item.flags.map((f, i) => <Note key={`f${i}`} kind="warn" text={f} />)}
              </>
            )}
            {!!item.derived.length && (
              <>
                <div className="tb-label">How it was worked out</div>
                {item.derived.map((d, i) => <Note key={`d${i}`} kind="plain" text={d} />)}
              </>
            )}
            {!!item.requires.length && (
              <div className="tb-needs">
                <div className="tb-label">Written after</div>
                {item.requires.map(req => (
                  <span key={req.key} className="tb-need">
                    <Icon name="arrow-right" size={12} />
                    {req.what}
                    {plan.items.find(i => i.key === req.key)?.status === 'ready' && <em className="tb-faint">— in this file</em>}
                  </span>
                ))}
              </div>
            )}
            {item.status === 'already' && item.matchedId && (
              <div className="tb-needs">
                <div className="tb-label">Already on the register</div>
                <Link className="tb-need" href={isDoc
                  ? (item.target === 'invoice' ? `/invoices/${item.matchedId}` : `/bills?q=${encodeURIComponent(String(fields.bill_number || ''))}`)
                  : `/${item.target === 'journal_draft' ? 'journal' : item.target === 'challan_draft' ? 'challans' : item.target}?q=${encodeURIComponent(String(fields.name || fields.narration || fields.party_name || ''))}`}>
                  <Icon name="arrow-right" size={12} /> Open the row this file matches
                </Link>
              </div>
            )}
          </div>

          {isDoc ? (
            <div className="tb-money">
              <div className="tb-tally">
                <StatRow label={item.target === 'invoice' ? 'Invoice date' : 'Bill date'}
                  value={formatDateIN(String(item.target === 'invoice' ? fields.invoice_date : fields.bill_date || ''))} />
                <StatRow label="Taxable" value={inr.format(Number(fields.taxable_amount) || 0)} />
                {!!Number(fields.cgst_amount) && <StatRow label="CGST" value={inr.format(Number(fields.cgst_amount))} tone="blue" />}
                {!!Number(fields.sgst_amount) && <StatRow label="SGST" value={inr.format(Number(fields.sgst_amount))} tone="blue" />}
                {!!Number(fields.igst_amount) && <StatRow label="IGST" value={inr.format(Number(fields.igst_amount))} tone="violet" />}
                {!!Number(fields.cess_amount) && <StatRow label="Cess" value={inr.format(Number(fields.cess_amount))} tone="amber" />}
                {!!Number(fields.round_off) && <StatRow label="Round off" value={inr.format(Number(fields.round_off))} />}
                <StatRow label="Grand total" value={inr.format(Number(fields.grand_total) || 0)} strong />
                <StatRow label="Place of supply" value={`${fields.place_of_supply || '—'}${fields.place_of_supply_name ? ` · ${fields.place_of_supply_name}` : ''}`} />
              </div>
              {!!item.lines.length && (
                <div className="tb-lines">
                  <div className="tb-lines-head">
                    <span>Line</span><span className="tb-right">HSN/SAC</span><span className="tb-right">Qty</span>
                    <span className="tb-right">Rate</span><span className="tb-right">Taxable</span><span className="tb-right">Total</span>
                  </div>
                  {item.lines.map((line, i) => (
                    <div key={`l${i}`} className="tb-lines-row">
                      <span>{String(line.item_name || '')}</span>
                      <span className="tb-right tb-faint">{String(line.hsn_sac || '—')}</span>
                      <span className="tb-right">{inr.format(Number(line.quantity) || 0)}</span>
                      <span className="tb-right">{inr.format(Number(line.rate) || 0)}</span>
                      <span className="tb-right">{inr.format(Number(line.taxable_value) || 0)}</span>
                      <span className="tb-right">{inr.format(Number(line.total_amount) || 0)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="tb-fields">
                <span className="tb-field-chip"><strong>{String(fields.supply_type || 'bill')}</strong> supply</span>
                {!!fields.is_reverse_charge && <span className="tb-field-chip"><strong>reverse</strong> charge</span>}
                {item.target === 'purchase_bill' && !!fields.itc_eligible && <span className="tb-field-chip"><strong>ITC</strong> eligible</span>}
                <span className="tb-field-chip">unpaid — <strong>/payments</strong> writes money</span>
              </div>
            </div>
          ) : item.target === 'journal_draft' || item.target === 'challan_draft' ? (
            <div className="tb-money">
              {!!item.lines.length && (
                <div className="tb-lines tb-lines-draft">
                  <div className="tb-lines-head">
                    <span>{item.target === 'journal_draft' ? 'Head' : 'Line'}</span>
                    <span className="tb-right">{item.target === 'journal_draft' ? 'Side' : 'Qty × Rate'}</span>
                    <span className="tb-right">{item.target === 'journal_draft' ? 'Rupees' : 'Value'}</span>
                  </div>
                  {item.lines.map((line, i) => (
                    <div key={`l${i}`} className="tb-lines-row">
                      <span>{String(line.note || line.item_name || '')}</span>
                      <span className="tb-right tb-faint">{item.target === 'journal_draft'
                        ? String(line.side || '')
                        : `${inr.format(Number(line.quantity) || 0)} × ${inr.format(Number(line.rate) || 0)}`}</span>
                      <span className="tb-right">{inr.format(item.target === 'journal_draft'
                        ? Number(line.amount) || 0
                        : (Number(line.quantity) || 0) * (Number(line.rate) || 0))}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="tb-fields">
                {Object.entries(item.fields)
                  .filter(([, v]) => v !== '' && v !== null && v !== undefined)
                  .slice(0, 6)
                  .map(([k, v]) => (
                    <span key={k} className="tb-field-chip"><strong>{k.replace(/_/g, ' ')}:</strong> {String(v)}</span>
                  ))}
              </div>
              <div className="tb-fields">
                <span className="tb-field-chip">{item.target === 'journal_draft'
                  ? <>a <strong>draft</strong> — posting takes its number and asks the seal</>
                  : <>a <strong>draft</strong> — the challan series numbers it now; confirming stays the shop’s move</>}</span>
              </div>
            </div>
          ) : item.target !== 'other' ? (
            <div className="tb-fields tb-fields-masters">
              {Object.entries(item.fields)
                .filter(([, v]) => v !== '' && v !== 0 && v !== null && v !== undefined && !(Array.isArray(v) && !v.length))
                .slice(0, 12)
                .map(([k, v]) => (
                  <span key={k} className="tb-field-chip"><strong>{k.replace(/_/g, ' ')}:</strong> {String(v)}</span>
                ))}
            </div>
          ) : (
            <div className="tb-faint tb-help" style={{ marginBottom: 0 }}>
              Nothing is written from this row — it is here so the count of what the file held adds up.
            </div>
          )}
        </div>
      )}
    </>
  )
}

function Note({ kind, text }: { kind: 'bad' | 'warn' | 'plain'; text: string }) {
  const icon = kind === 'bad' ? 'x' : kind === 'warn' ? 'alert' : 'check'
  const cls = kind === 'bad' ? 'tb-bad' : kind === 'warn' ? 'tb-warn' : 'tb-plain'
  return (
    <div className={`tb-note ${cls}`}>
      <Icon name={icon} size={12} />
      <span>{text}</span>
    </div>
  )
}

/** One document offered for the trip to Tally. */
function ExportRow({
  checked, onToggle, number, date, party, rupees, lines, note,
}: {
  checked: boolean
  onToggle: () => void
  number: string
  date: string
  party: string
  rupees: number
  lines: number | null
  note: string
}) {
  return (
    <div className={`table-row tb-xrow ${checked ? 'tb-on' : ''}`}>
      <span data-label="Write"><input type="checkbox" checked={checked} onChange={onToggle} aria-label={`Send ${number} to Tally`} /></span>
      <span data-label="Document" className="tb-xnum">
        {number}
        <span className="tb-xdate">{formatDateIN(date)}{note ? ` · Tally ${note}` : ''}</span>
      </span>
      <span data-label="Party" className="tb-xparty tb-party-cell">{party}</span>
      <span data-label="Money" className="tb-right tb-num tb-rupees">{inr.format(rupees)}</span>
      <span data-label="Lines" className="tb-right tb-xlines tb-xlines-cell">{lines === null ? '…' : lines}</span>
    </div>
  )
}

export default function TallyPage() {
  return (
    <Suspense fallback={<div className="page-container"><p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p></div>}>
      <TallyPageInner />
    </Suspense>
  )
}
