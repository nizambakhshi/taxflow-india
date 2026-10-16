'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { csvFromRows } from '@/lib/gstr9'
import { download } from '@/lib/party-ledger'
import { Badge, Button, Card, EmptyState, PageHeader, StatCard } from '@/components/ui'
import type { Tone } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  BookRecord,
  CSV_TEMPLATE_EXAMPLE,
  CSV_TEMPLATE_HEADERS,
  Gstr2bRecord,
  ReconciledRow,
  ReconciliationResult,
  normalizeGstin,
  parseGstr2bCsv,
  parseGstr2bJson,
  reconciliationExportRows,
  reconcile,
} from '@/lib/gstr2b'

interface BooksData {
  books: BookRecord[]
  expenseItc: number
}

const money = (value: number) => `₹${formatINR(value)}`

const periodLabel = (period: string) => {
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month - 1, 1).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

/** One row, whichever bucket the engine put it in. */
interface Side {
  key: string
  invoice: string
  gstin: string
  section: string
  taxable: number
  igst: number
  cgst: number
  sgst: number
  bookTax: number
  portalTax: number
  diff: number
  heads: string[]
}

function sideOf(row: ReconciledRow, fromPortal: boolean): Side {
  const src = (fromPortal ? row.portal : row.book) as BookRecord | Gstr2bRecord
  return {
    key: fromPortal ? `${src.supplierGstin}-${src.invoiceNo}` : row.book!.id,
    invoice: src.invoiceNo || '',
    gstin: src.supplierGstin || '',
    section: fromPortal ? (src as Gstr2bRecord).section : '',
    taxable: src.taxable,
    igst: src.igst,
    cgst: src.cgst,
    sgst: src.sgst,
    bookTax: row.book ? row.book.igst + row.book.cgst + row.book.sgst : 0,
    portalTax: row.portal ? row.portal.igst + row.portal.cgst + row.portal.sgst : 0,
    diff: row.diffIgst + row.diffCgst + row.diffSgst,
    heads: row.mismatchHeads,
  }
}

function Lead({ side, sub }: { side: Side; sub?: string }) {
  return (
    <span className="rc-lead">
      <strong>{side.invoice || '(no invoice reference)'}</strong>
      <em>{sub ?? (side.gstin || 'no GSTIN on this bill')}{side.section ? ` · ${side.section}` : ''}</em>
    </span>
  )
}

interface Column {
  label: string
  width?: string
  amount?: boolean
  render: (side: Side) => ReactNode
}

const HEAD_COLUMNS: Column[] = [
  { label: 'Supplier / invoice', width: '1.8fr', render: s => <Lead side={s} /> },
  { label: 'Taxable', width: '1fr', amount: true, render: s => money(s.taxable) },
  { label: 'IGST', width: '1fr', amount: true, render: s => money(s.igst) },
  { label: 'CGST', width: '1fr', amount: true, render: s => money(s.cgst) },
  { label: 'SGST/UTGST', width: '1fr', amount: true, render: s => money(s.sgst) },
]

const MISMATCH_COLUMNS: Column[] = [
  {
    label: 'Supplier / invoice', width: '2fr',
    render: s => <Lead side={s} sub={s.heads.length ? `differs on ${s.heads.join(', ')}` : undefined} />,
  },
  { label: 'Tax in books', width: '1fr', amount: true, render: s => money(s.bookTax) },
  { label: 'Tax in 2B', width: '1fr', amount: true, render: s => money(s.portalTax) },
  {
    label: 'Difference', width: '1fr', amount: true,
    render: s => (
      <span className={s.diff > 0 ? 'rc-diff is-short' : 'rc-diff is-extra'}>
        {s.diff > 0 ? '+' : ''}{money(s.diff)}
      </span>
    ),
  },
]

const MATCHED_COLUMNS: Column[] = [
  { label: 'Supplier / invoice', width: '2fr', render: s => <Lead side={s} /> },
  { label: 'Taxable', width: '1fr', amount: true, render: s => money(s.taxable) },
  { label: 'Total tax', width: '1fr', amount: true, render: s => money(s.igst + s.cgst + s.sgst) },
]

function ReconTable({ columns, sides }: { columns: Column[]; sides: Side[] }) {
  const grid = columns.map(c => c.width ?? '1fr').join(' ')
  return (
    <div className="table-scroll">
      <div className="responsive-table">
        <div className="rc-cols rc-head" style={{ gridTemplateColumns: grid }}>
          {columns.map(c => (
            <span key={c.label} className={c.amount ? 'is-right' : undefined}>{c.label}</span>
          ))}
        </div>
        {sides.map(s => (
          <div key={s.key} className="rc-cols rc-row tf-tr" style={{ gridTemplateColumns: grid }}>
            {columns.map(c => (
              <span key={c.label} data-label={c.label} className={c.amount ? 'rc-td is-right' : 'rc-td is-lead'}>
                {c.render(s)}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

const CHIP: Record<Tone, string> = {
  red: 'var(--red)', amber: 'var(--amber)', blue: 'var(--brand)',
  green: 'var(--green)', violet: 'var(--violet)', cyan: 'var(--cyan)', grey: 'var(--faint)',
}

function SectionHead({ title, count, tone }: { title: string; count: number; tone: Tone }) {
  return (
    <div className="rc-sect">
      <span className="rc-chip" style={{ background: CHIP[tone] }} />
      <h2>{title}</h2>
      <Badge tone={tone} dot={false}>{count}</Badge>
    </div>
  )
}

function Bucket({ title, tone, columns, sides, blurb, empty }: {
  title: string
  tone: Tone
  columns: Column[]
  sides: Side[]
  blurb: ReactNode
  empty: string
}) {
  return (
    <Card pad={false} className="rc-card">
      <div className="rc-card-head">
        <SectionHead title={title} count={sides.length} tone={tone} />
        <p>{blurb}</p>
      </div>
      {sides.length === 0
        ? <div className="rc-clear">{empty}</div>
        : <ReconTable columns={columns} sides={sides} />}
    </Card>
  )
}

export default function Gstr2bReconciliationPage() {
  const supabase = createClient()
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [books, setBooks] = useState<BookRecord[]>([])
  const [expenseItc, setExpenseItc] = useState(0)
  const [portalRecords, setPortalRecords] = useState<Gstr2bRecord[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [importError, setImportError] = useState('')

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1)
    return {
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
    }
  })

  async function loadBooks(oid: string, period: string): Promise<BooksData> {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    const [bills, expenses] = await Promise.all([
      supabase
        .from('purchase_bills')
        .select('id, bill_number, bill_date, vendor_gstin, taxable_amount, igst_amount, cgst_amount, sgst_amount')
        .eq('organization_id', oid)
        .eq('itc_eligible', true)
        .neq('status', 'cancelled')
        .gte('bill_date', startDate)
        .lte('bill_date', endDate)
        .order('bill_date'),
      supabase
        .from('expenses')
        .select('gst_amount')
        .eq('organization_id', oid)
        .eq('itc_eligible', true)
        .gte('expense_date', startDate)
        .lte('expense_date', endDate),
    ])

    const bookRecords: BookRecord[] = (bills.data || []).map(b => ({
      id: b.id,
      supplierGstin: normalizeGstin(b.vendor_gstin),
      invoiceNo: b.bill_number || '',
      invoiceDate: b.bill_date || null,
      label: b.bill_number || 'Bill',
      taxable: Number(b.taxable_amount) || 0,
      igst: Number(b.igst_amount) || 0,
      cgst: Number(b.cgst_amount) || 0,
      sgst: Number(b.sgst_amount) || 0,
    }))

    // Expense ITC stays out of the match engine — most expense suppliers have no
    // bill number for GSTR-2B to carry, so it is reported beside the result instead.
    const expenseTotal = (expenses.data || []).reduce((s, e) => s + Number(e.gst_amount || 0), 0)

    return { books: bookRecords, expenseItc: expenseTotal }
  }

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)
    }
    load()
  }, [])

  // A 2B statement belongs to one period, so changing the month clears the file with the books.
  useEffect(() => {
    if (!orgId) return
    let stale = false

    async function run() {
      const period = await loadBooks(orgId, selectedPeriod)
      if (stale) return
      setBooks(period.books)
      setExpenseItc(period.expenseItc)
      setPortalRecords(null)
      setFileName('')
      setImportError('')
      setLoading(false)
    }
    run()

    return () => { stale = true }
  }, [selectedPeriod, orgId])

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportError('')

    try {
      const text = await file.text()
      let records: Gstr2bRecord[]
      if (file.name.toLowerCase().endsWith('.json')) {
        records = parseGstr2bJson(text).records
      } else if (file.name.toLowerCase().endsWith('.csv')) {
        records = parseGstr2bCsv(text)
      } else {
        throw new Error('Please upload the GSTR-2B .json file, or a .csv with the template columns.')
      }
      setPortalRecords(records)
      setFileName(file.name)
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Could not read this file.')
      setPortalRecords(null)
      setFileName('')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const result: ReconciliationResult | null = useMemo(
    () => (portalRecords ? reconcile(books, portalRecords) : null),
    [books, portalRecords],
  )

  function downloadTemplate() {
    download('GSTR-2B-import-template.csv', csvFromRows([
      CSV_TEMPLATE_HEADERS.split(','),
      CSV_TEMPLATE_EXAMPLE.split(','),
    ]))
  }

  function exportRecon() {
    if (!result) return
    download(`GSTR2B-Reconciliation-${selectedPeriod}.csv`, csvFromRows(reconciliationExportRows(result)))
  }

  if (loading) {
    return (
      <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
        Reading your purchase bills for this month…
      </div>
    )
  }

  const t = result?.totals

  return (
    <div className="page-container rc" style={{ maxWidth: 1000 }}>
      <PageHeader
        eyebrow={`ITC reconciliation · ${periodLabel(selectedPeriod)}`}
        title="GSTR-2B reconciliation"
        subtitle={portalRecords
          ? `${books.length} bills in your books against ${portalRecords.length} records in 2B`
          : `Match the ${books.length} ITC-eligible purchase bill${books.length === 1 ? '' : 's'} in your books against GSTR-2B`}
        actions={
          <select
            className="tf-input"
            style={{ minWidth: 150 }}
            value={selectedPeriod}
            onChange={e => setSelectedPeriod(e.target.value)}
            aria-label="Tax period"
          >
            {months.map(m => (
              <option key={m.period} value={m.period}>{m.label}</option>
            ))}
          </select>
        }
        right={
          <>
            <Button variant="subtle" icon="download" onClick={downloadTemplate}
              title="The eight columns this page can read">CSV template</Button>
            {result && (
              <Button variant="primary" icon="download" onClick={exportRecon}>Export reconciliation</Button>
            )}
          </>
        }
      />

      <Card className="rc-card">
        <SectionHead
          title="Import your GSTR-2B file"
          count={portalRecords?.length ?? 0}
          tone={portalRecords ? 'green' : 'grey'}
        />

        <button type="button" className="rc-drop" onClick={() => fileInputRef.current?.click()}>
          <Icon name="upload" size={24} strokeWidth={1.8} style={{ color: 'var(--brand)' }} />
          <strong>{fileName || 'Upload the GSTR-2B file'}</strong>
          <span>{fileName
            ? 'Read in your browser — click to replace it with another period'
            : 'The .json inside the zip from the GST portal, or a CSV with the template columns'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        {fileName && (
          <div className="rc-drop-actions">
            <Button variant="subtle" size="sm" icon="x" onClick={() => {
              setPortalRecords(null); setFileName(''); setImportError('')
            }}>
              Remove file
            </Button>
          </div>
        )}

        {importError && (
          <div className="rc-alert is-error">
            <Icon name="alert" size={15} />
            <span>{importError}</span>
          </div>
        )}

        <div className="rc-alert is-info">
          <Icon name="book" size={15} />
          <span>
            On the portal: Returns Dashboard → GSTR-2B → Download. Unzip it with the password (last four
            characters of your GSTIN plus the captcha) and upload the <strong>.json</strong> inside. The file is
            parsed in this browser — nothing is uploaded anywhere.
          </span>
        </div>
      </Card>

      {!result && (
        <Card className="rc-card">
          <EmptyState
            icon="compare"
            title="No 2B statement loaded"
            message={`You have ${books.length} ITC-eligible bill${books.length === 1 ? '' : 's'} in ${periodLabel(selectedPeriod)}. Upload the 2B file and this page shows:`}
            action={
              <ul className="rc-checklist">
                <li>ITC at risk — bills your supplier has not reported to the portal</li>
                <li>Amount mismatches where 2B disagrees with your books</li>
                <li>Credit sitting in 2B that you have not booked yet</li>
                <li>A reconciliation CSV you can hand to your CA</li>
              </ul>
            }
          />
        </Card>
      )}

      {result && t && (
        <>
          <div className="rc-metrics">
            <StatCard label="ITC in your books" value={t.booksITC} tone="blue" icon="cart"
              sub={`${books.length} purchase bills`} />
            <StatCard label="ITC in GSTR-2B" value={t.portalITC} tone="violet" icon="cloud"
              sub={`${portalRecords?.length ?? 0} portal records`} />
            <StatCard label="Fully matched" value={t.matchedITC} tone="green" icon="check"
              sub={`${result.matched.length} of ${books.length} bills`} />
            <StatCard label="ITC at risk" value={t.atRiskITC} tone={t.atRiskITC > 0 ? 'red' : 'green'}
              icon="alert" sub={t.atRiskITC > 0 ? 'Supplier must report it first' : 'Nothing unreported'} />
            <StatCard label="Extra credit in 2B" value={t.excessITC} tone="amber" icon="plus"
              sub={`${result.portalOnly.length} bills not in your books`} />
          </div>

          {(expenseItc > 0 || t.cessInPortal > 0) && (
            <div className="rc-alert is-info">
              <Icon name="scale" size={15} />
              <span>
                {expenseItc > 0 && (
                  <>Expense ITC of <strong>{money(expenseItc)}</strong> is outside this match — expense
                    suppliers rarely have a bill number 2B can carry. Verify those claims separately.</>
                )}
                {t.cessInPortal > 0 && (
                  <> {expenseItc > 0 ? 'And ' : ''}2B carries <strong>{money(t.cessInPortal)}</strong> of cess
                    {' '}you have not claimed on any bill.</>
                )}
              </span>
            </div>
          )}

          <Bucket
            title="In your books, not in GSTR-2B"
            tone="red"
            columns={HEAD_COLUMNS}
            sides={result.booksOnly.map(r => sideOf(r, false))}
            blurb={<>ITC on these bills is <strong>blocked under Section 16(2)(aa)</strong> until your supplier
              reports them. Follow up with them — a Form IIF communication may already be raised.</>}
            empty="✓ Every purchase bill in this period appears in 2B."
          />

          <Bucket
            title="Matched, with amount differences"
            tone="amber"
            columns={MISMATCH_COLUMNS}
            sides={result.mismatched.map(r => sideOf(r, false))}
            blurb="Same bill number, different money. A positive difference means your books claim more tax than 2B supports — that gap is the ITC you would have to reverse. Negative means 2B offers credit you have not booked."
            empty="✓ No amount differences on the bills that matched."
          />

          <Bucket
            title="In GSTR-2B, not in your books"
            tone="blue"
            columns={HEAD_COLUMNS}
            sides={result.portalOnly.map(r => sideOf(r, true))}
            blurb="Your supplier has reported these and you have not booked them — that credit is unclaimed."
            empty="✓ Nothing in 2B is missing from your books."
          />

          <Bucket
            title="Fully matched"
            tone="green"
            columns={MATCHED_COLUMNS}
            sides={result.matched.map(r => sideOf(r, false))}
            blurb="Safe to claim this period: same bill, same tax on every head, within ₹1 tolerance."
            empty="No fully matched bills in this period."
          />
        </>
      )}

      <div className="rc-note-box">
        <Icon name="alert" size={15} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
        <span>
          <strong>Important:</strong> GSTR-2B is auto-drafted by the GST system from your suppliers&apos; filings.
          Final ITC eligibility is governed by Section 16 of the CGST Act — take these differences to your CA
          before filing GSTR-3B, not after.
          <a href="/gst/gstr3b" className="rc-link">This month&apos;s 3B →</a>
        </span>
      </div>

      <style>{`
        .rc-card { margin-bottom: 1rem; }
        .rc-card-head { padding: 0 0 0.15rem; }
        .rc-card-head p { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0 0 0.8rem; }
        .rc-sect {
          display: flex; align-items: center; gap: 9px;
          padding-bottom: 9px; margin-bottom: 0.8rem;
          border-bottom: 1px solid var(--line-soft);
        }
        .rc-sect h2 { font-size: 13.5px; font-weight: 700; color: var(--ink); margin: 0; flex: 1; }
        .rc-chip { width: 9px; height: 9px; border-radius: 3px; flex-shrink: 0; }

        .rc-drop {
          width: 100%; display: flex; flex-direction: column; align-items: center; gap: 5px;
          font-family: inherit; text-align: center; cursor: pointer;
          border: 2px dashed var(--line); border-radius: var(--radius-lg);
          background: var(--surface-2); padding: 1.4rem 1rem; transition: border-color .16s, background .16s;
        }
        .rc-drop:hover { border-color: var(--brand); background: var(--brand-soft); }
        .rc-drop strong { font-size: 14px; color: var(--ink); }
        .rc-drop span { font-size: 12px; color: var(--muted); max-width: 52ch; line-height: 1.55; }
        .rc-drop-actions { display: flex; justify-content: flex-end; margin-top: 10px; }

        .rc-alert {
          display: flex; gap: 8px; align-items: flex-start;
          font-size: 12px; line-height: 1.6; border-radius: var(--radius);
          padding: 10px 12px; margin-top: 12px; border: 1px solid var(--line);
        }
        .rc-alert.is-error { background: var(--red-soft); color: #b91c1c; }
        .rc-alert.is-info { background: var(--cyan-soft); color: #0369a1; }
        .rc-alert svg { flex-shrink: 0; margin-top: 2px; }

        .rc-metrics {
          display: grid; gap: 0.9rem; margin-bottom: 1rem;
          grid-template-columns: repeat(auto-fit, minmax(176px, 1fr));
        }

        .rc-cols {
          display: grid; gap: 10px; padding: 9px 1.3rem;
          align-items: center; font-size: 12px; color: var(--ink-2);
        }
        .rc-head {
          background: var(--surface-2);
          border-top: 1px solid var(--line-soft); border-bottom: 1px solid var(--line-soft);
          font-size: 10.5px; font-weight: 700; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .rc-head .is-right, .rc-td.is-right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .rc-row { border-bottom: 1px solid var(--line-soft); }
        .rc-row:hover { background: var(--surface-2); }
        .rc-lead strong { display: block; font-size: 12.5px; font-weight: 600; color: var(--ink); }
        .rc-lead em {
          display: block; font-style: normal; font-size: 11px; color: var(--faint);
          font-family: var(--mono);
        }
        .rc-diff { font-weight: 700; }
        .rc-diff.is-short { color: var(--red); }
        .rc-diff.is-extra { color: var(--brand); }
        .rc-clear { padding: 1rem 1.3rem 1.15rem; font-size: 12.5px; color: var(--green); font-weight: 600; }
        .rc-checklist {
          margin: 0.7rem auto 0; padding-left: 1.15rem; max-width: 44ch;
          font-size: 12px; color: var(--muted); line-height: 1.8; text-align: left;
        }

        .rc-note-box {
          display: flex; gap: 9px; align-items: flex-start; padding: 12px 14px;
          background: var(--amber-soft); border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 12px; color: var(--ink-2); line-height: 1.6;
        }
        .rc-link { color: var(--brand); font-weight: 600; text-decoration: none; margin-left: 6px; }

        @media (max-width: 768px) {
          .rc-metrics { grid-template-columns: 1fr 1fr; }
          .rc-cols { grid-template-columns: 1fr !important; gap: 4px; padding: 12px 1rem; }
          .rc-head { display: none !important; }
          .rc-td {
            display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
            text-align: left; white-space: normal; overflow: visible;
          }
          /* .is-right sets nowrap on desktop; match its specificity or the amount still cannot wrap. */
          .rc-td.is-right { white-space: normal; }
          .rc-td.is-lead { display: block; }
          .rc-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: 0.05em; flex-shrink: 0;
          }
          .rc-td.is-lead::before { content: none; }
        }
      `}</style>
    </div>
  )
}
