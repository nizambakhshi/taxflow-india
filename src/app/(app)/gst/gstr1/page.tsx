'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { csvFromRows } from '@/lib/gstr9'
import { download } from '@/lib/party-ledger'
import { formatDateIN, plural } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

interface InvoiceLine {
  hsn_sac: string | null
  item_name: string | null
  unit: string | null
  quantity: number | string | null
  total_amount: number | string | null
  taxable_value: number | string | null
  igst_amount: number | string | null
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  cess_amount: number | string | null
}

interface InvoiceRow {
  id: string
  invoice_number: string
  invoice_date: string
  customer_name: string | null
  customer_gstin: string | null
  place_of_supply: string | null
  supply_type: string | null
  taxable_amount: number | string | null
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  igst_amount: number | string | null
  cess_amount: number | string | null
  total_tax: number | string | null
  grand_total: number | string | null
  invoice_items: InvoiceLine[] | null
}

interface HsnRow {
  hsn: string
  description: string
  uom: string
  totalQty: number
  totalValue: number
  taxableValue: number
  igst: number
  cgst: number
  sgst: number
  cess: number
}

type InvoiceTab = 'b2b' | 'b2c' | 'export'
type TabKey = InvoiceTab | 'hsn'

interface Totals {
  totalTaxable: number
  totalCGST: number
  totalSGST: number
  totalIGST: number
  totalCess: number
  totalTax: number
  grandTotal: number
}

const EMPTY_TOTALS: Totals = {
  totalTaxable: 0, totalCGST: 0, totalSGST: 0, totalIGST: 0,
  totalCess: 0, totalTax: 0, grandTotal: 0,
}

const TABS: { value: TabKey; label: string }[] = [
  { value: 'b2b', label: 'B2B' },
  { value: 'b2c', label: 'B2C' },
  { value: 'export', label: 'Exports / SEZ' },
  { value: 'hsn', label: 'HSN summary' },
]

const num = (v: number | string | null) => Number(v || 0)
const money = (v: number | string | null) => `₹${formatINR(num(v))}`
const qtyText = (v: number) => (v % 1 === 0 ? String(v) : v.toFixed(2))

interface Column<Row> {
  key: string
  label: string
  width?: string
  right?: boolean
  strong?: boolean
  render: (row: Row) => ReactNode
}

const text = (v: string | null) => v || '—'

const INVOICE_LEAD: Column<InvoiceRow>[] = [
  {
    key: 'invoice_number', label: 'Invoice no.', width: '1.05fr',
    render: r => <span className="r1-doc">{r.invoice_number}</span>,
  },
  {
    key: 'invoice_date', label: 'Date', width: '0.8fr',
    render: r => <span className="r1-dim">{formatDateIN(r.invoice_date)}</span>,
  },
  { key: 'customer_name', label: 'Customer', width: '1.3fr', render: r => text(r.customer_name) },
]

const INVOICE_TAX: Column<InvoiceRow>[] = [
  { key: 'taxable_amount', label: 'Taxable', width: '0.85fr', right: true, render: r => money(r.taxable_amount) },
  { key: 'total_tax', label: 'Tax', width: '0.85fr', right: true, render: r => money(r.total_tax) },
  { key: 'grand_total', label: 'Total', width: '0.85fr', right: true, strong: true, render: r => money(r.grand_total) },
]

const B2B_COLUMNS: Column<InvoiceRow>[] = [
  ...INVOICE_LEAD,
  {
    key: 'customer_gstin', label: 'GSTIN', width: '1.15fr',
    render: r => <span className="r1-mono">{text(r.customer_gstin)}</span>,
  },
  { key: 'place_of_supply', label: 'Place of supply', width: '0.9fr', render: r => text(r.place_of_supply) },
  ...INVOICE_TAX,
]

const B2C_COLUMNS: Column<InvoiceRow>[] = [
  ...INVOICE_LEAD,
  { key: 'place_of_supply', label: 'Place of supply', width: '0.9fr', render: r => text(r.place_of_supply) },
  ...INVOICE_TAX,
]

const EXPORT_COLUMNS: Column<InvoiceRow>[] = [
  ...INVOICE_LEAD,
  {
    key: 'supply_type', label: 'Type', width: '0.75fr',
    render: r => <Badge tone="cyan">{r.supply_type === 'sez' ? 'SEZ' : 'Export'}</Badge>,
  },
  { key: 'taxable_amount', label: 'Taxable', width: '0.85fr', right: true, render: r => money(r.taxable_amount) },
  { key: 'igst_amount', label: 'IGST', width: '0.85fr', right: true, render: r => money(r.igst_amount) },
  { key: 'grand_total', label: 'Total', width: '0.85fr', right: true, strong: true, render: r => money(r.grand_total) },
]

const HSN_COLUMNS: Column<HsnRow>[] = [
  { key: 'hsn', label: 'HSN / SAC', width: '0.95fr', render: r => <span className="r1-mono r1-doc">{r.hsn}</span> },
  { key: 'description', label: 'Description', width: '1.5fr', render: r => r.description },
  { key: 'uom', label: 'UOM', width: '0.55fr', render: r => <span className="r1-dim">{r.uom}</span> },
  { key: 'totalQty', label: 'Total qty', width: '0.6fr', right: true, render: r => qtyText(r.totalQty) },
  { key: 'taxableValue', label: 'Taxable value', width: '0.85fr', right: true, render: r => money(r.taxableValue) },
  { key: 'igst', label: 'IGST', width: '0.8fr', right: true, render: r => money(r.igst) },
  { key: 'cgst', label: 'CGST', width: '0.8fr', right: true, render: r => money(r.cgst) },
  { key: 'sgst', label: 'SGST', width: '0.8fr', right: true, render: r => money(r.sgst) },
  { key: 'cess', label: 'Cess', width: '0.7fr', right: true, render: r => money(r.cess) },
]

const INVOICE_COLUMNS: Record<InvoiceTab, Column<InvoiceRow>[]> = {
  b2b: B2B_COLUMNS,
  b2c: B2C_COLUMNS,
  export: EXPORT_COLUMNS,
}

const gridOf = (columns: { width?: string }[]) => columns.map(c => c.width ?? '1fr').join(' ')

function periodOptions(n = 6) {
  const now = new Date()
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    return {
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
    }
  })
}

export default function GSTR1Page() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [invoicesByTab, setInvoicesByTab] = useState<Record<InvoiceTab, InvoiceRow[]>>({
    b2b: [], b2c: [], export: [],
  })
  const [hsnSummary, setHsnSummary] = useState<HsnRow[]>([])
  const [totals, setTotals] = useState<Totals>(EMPTY_TOTALS)
  const [activeTab, setActiveTab] = useState<TabKey>('b2b')

  const months = periodOptions(6)
  const periodLabel = months.find(m => m.period === selectedPeriod)?.label || selectedPeriod

  async function loadPeriod(oid: string, period: string) {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    const { data } = await supabase
      .from('invoices')
      .select('*, invoice_items(*)')
      .eq('organization_id', oid)
      .neq('status', 'cancelled')
      .gte('invoice_date', startDate)
      .lte('invoice_date', endDate)
      .order('invoice_date')

    const allInvoices = (data || []) as unknown as InvoiceRow[]

    const hsnMap: Record<string, HsnRow> = {}
    allInvoices.forEach(inv => {
      (inv.invoice_items || []).forEach(item => {
        const hsn = item.hsn_sac || 'UNSPECIFIED'
        if (!hsnMap[hsn]) {
          hsnMap[hsn] = {
            hsn, description: item.item_name || '—', uom: item.unit ? item.unit.toUpperCase() : 'NOS',
            totalQty: 0, totalValue: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0,
          }
        }
        const bucket = hsnMap[hsn]
        bucket.totalQty += num(item.quantity)
        bucket.totalValue += num(item.total_amount)
        bucket.taxableValue += num(item.taxable_value)
        bucket.igst += num(item.igst_amount)
        bucket.cgst += num(item.cgst_amount)
        bucket.sgst += num(item.sgst_amount)
        bucket.cess += num(item.cess_amount)
      })
    })

    return {
      invoices: {
        b2b: allInvoices.filter(i => i.supply_type === 'b2b'),
        b2c: allInvoices.filter(i => i.supply_type === 'b2c'),
        export: allInvoices.filter(i => i.supply_type === 'export' || i.supply_type === 'sez'),
      } as Record<InvoiceTab, InvoiceRow[]>,
      hsn: Object.values(hsnMap).sort((a, b) => b.taxableValue - a.taxableValue),
      totals: {
        totalTaxable: allInvoices.reduce((s, i) => s + num(i.taxable_amount), 0),
        totalCGST: allInvoices.reduce((s, i) => s + num(i.cgst_amount), 0),
        totalSGST: allInvoices.reduce((s, i) => s + num(i.sgst_amount), 0),
        totalIGST: allInvoices.reduce((s, i) => s + num(i.igst_amount), 0),
        totalCess: allInvoices.reduce((s, i) => s + num(i.cess_amount), 0),
        totalTax: allInvoices.reduce((s, i) => s + num(i.total_tax), 0),
        grandTotal: allInvoices.reduce((s, i) => s + num(i.grand_total), 0),
      },
    }
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

  useEffect(() => {
    if (!orgId) return
    let stale = false

    async function run() {
      const period = await loadPeriod(orgId, selectedPeriod)
      if (stale) return
      setInvoicesByTab(period.invoices)
      setHsnSummary(period.hsn)
      setTotals(period.totals)
      setLoading(false)
    }
    run()

    return () => { stale = true }
  }, [selectedPeriod, orgId])

  function exportCSV() {
    const invoiceSection = (tab: InvoiceTab) => {
      const columns = INVOICE_COLUMNS[tab]
      return [
        columns.map(c => c.label),
        ...invoicesByTab[tab].map(row => columns.map(c => csvCell(c.key, row))),
      ]
    }

    const rows: (string | number)[][] = [
      ['GSTR-1 Report', selectedPeriod],
      [],
      ['B2B INVOICES'],
      ...invoiceSection('b2b'),
      [],
      ['B2C INVOICES'],
      ...invoiceSection('b2c'),
      [],
      ['EXPORT / SEZ INVOICES'],
      ...invoiceSection('export'),
      [],
      ['HSN SUMMARY'],
      ['HSN/SAC', 'Description', 'UOM', 'Total Qty', 'Total Value', 'Taxable Value', 'IGST', 'CGST', 'SGST', 'CESS'],
      ...hsnSummary.map(h => [
        h.hsn, h.description, h.uom, h.totalQty, h.totalValue, h.taxableValue, h.igst, h.cgst, h.sgst, h.cess,
      ]),
      [],
      ['PERIOD TOTALS'],
      ['Invoices', invoicesByTab.b2b.length + invoicesByTab.b2c.length + invoicesByTab.export.length],
      ['Taxable value', totals.totalTaxable],
      ['CGST', totals.totalCGST],
      ['SGST', totals.totalSGST],
      ['IGST', totals.totalIGST],
      ['Cess', totals.totalCess],
      ['Invoice value', totals.grandTotal],
    ]

    download(`GSTR1-${selectedPeriod}.csv`, csvFromRows(rows))
  }

  if (loading) {
    return (
      <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
        Reading the invoices raised this month…
      </div>
    )
  }

  const invoiceCount = invoicesByTab.b2b.length + invoicesByTab.b2c.length + invoicesByTab.export.length
  const igstShare = totals.totalTax > 0 ? Math.round((totals.totalIGST / totals.totalTax) * 100) : 0

  const emptyCopy: Record<TabKey, { title: string; message: string }> = {
    b2b: {
      title: 'No B2B invoices',
      message: 'Sales to registered buyers raised in this period appear here — these are the rows that go into table 4 of GSTR-1.',
    },
    b2c: {
      title: 'No B2C invoices',
      message: 'Consumer and unregistered sales appear here. On the portal they are reported by rate and place of supply rather than invoice-wise.',
    },
    export: {
      title: 'No export or SEZ invoices',
      message: 'Zero-rated supplies — exported with a LUT, or with IGST paid and claimed as a refund — land in this tab.',
    },
    hsn: {
      title: 'No HSN data',
      message: 'Table 12 of GSTR-1 is built from the HSN or SAC code on every invoice line. Add the code on the product and this summary fills up.',
    },
  }

  const countFor = (tab: TabKey) => (tab === 'hsn' ? hsnSummary.length : invoicesByTab[tab].length)

  return (
    <div className="page-container r1" style={{ maxWidth: 1240 }}>
      <PageHeader
        eyebrow={`Outward supplies · ${periodLabel}`}
        title="GSTR-1"
        subtitle={`${invoiceCount} invoices read from your books, split the way the outward-supplies return expects them.`}
        actions={
          <select
            className="tf-input"
            style={{ cursor: 'pointer', minWidth: 160 }}
            value={selectedPeriod}
            onChange={e => setSelectedPeriod(e.target.value)}
            aria-label="Tax period"
          >
            {months.map(m => (
              <option key={m.period} value={m.period}>{m.label}</option>
            ))}
          </select>
        }
        right={<Button variant="subtle" icon="download" onClick={exportCSV} title="Every tab, not just the one on screen">CSV</Button>}
      />

      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="Invoices" value={String(invoiceCount)} tone="blue" icon="invoice"
          sub={`${invoicesByTab.b2b.length} B2B · ${invoicesByTab.b2c.length} B2C`} />
        <StatCard label="Taxable value" value={totals.totalTaxable} tone="cyan" icon="scale"
          sub="Before the tax you collected" />
        <StatCard label="Tax collected" value={totals.totalTax} tone="violet" icon="percent"
          sub={`${igstShare}% of it is IGST`} />
        <StatCard label="Invoice value" value={totals.grandTotal} tone="green" icon="wallet"
          sub="Taxable plus tax" />
      </div>

      <Card pad={false}>
        <div className="tab-bar r1-tabs">
          {TABS.map(t => (
            <button key={t.value} type="button" onClick={() => setActiveTab(t.value)}
              className={`r1-tab ${activeTab === t.value ? 'is-on' : ''}`}>
              {t.label}
              <span className="r1-tab-count">{countFor(t.value)}</span>
            </button>
          ))}
        </div>

        {countFor(activeTab) === 0 ? (
          <div style={{ padding: '1rem 0 1.5rem' }}>
            <EmptyState icon={activeTab === 'hsn' ? 'box' : 'invoice'}
              title={emptyCopy[activeTab].title} message={emptyCopy[activeTab].message} />
          </div>
        ) : activeTab === 'hsn' ? (
          <ReportTable rows={hsnSummary} columns={HSN_COLUMNS} foot={hsnFoot(hsnSummary)} />
        ) : (
          <ReportTable
            rows={invoicesByTab[activeTab]}
            columns={INVOICE_COLUMNS[activeTab]}
            foot={invoiceFoot(activeTab, invoicesByTab[activeTab])}
          />
        )}

        <div className="r1-hint">
          {activeTab === 'hsn'
            ? 'Aggregated across every invoice in the period, largest value first. Lines with no code collect under UNSPECIFIED.'
            : 'Cancelled invoices are excluded. Credit and debit notes are separate documents and reach tables 9C and 9B of the return.'}
        </div>
      </Card>

      <div className="r1-note">
        <Icon name="alert" size={15} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
        <span>
          Prepared from your books of accounts — verify every figure against the GST portal before filing, and
          confirm the current GSTR-1 schema at gstn.gov.in.
          <a href="/gst/reconciliation" className="r1-note-link">Reconcile the credit side with 2B →</a>
        </span>
      </div>

      <style>{`
        .r1-tabs {
          display: flex; gap: 2px; border-bottom: 1px solid var(--line);
          padding: 0.45rem 0.7rem 0; overflow-x: auto;
        }
        .r1-tab {
          display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; min-height: 0;
          font-family: inherit; font-size: 12.5px; font-weight: 600; color: var(--muted);
          background: transparent; border: none; border-bottom: 2px solid transparent;
          padding: 8px 10px; cursor: pointer;
        }
        .r1-tab.is-on { color: var(--brand); border-bottom-color: var(--brand); }
        .r1-tab-count {
          font-size: 10.5px; font-weight: 700; color: var(--faint);
          background: var(--slate-soft); border-radius: 99px; padding: 1px 7px;
        }
        .r1-tab.is-on .r1-tab-count { background: var(--brand-soft); color: var(--brand); }

        .r1-grid { min-width: 780px; }
        .r1-cols {
          display: grid; align-items: center; gap: 12px;
          padding: 10px 1rem; border-bottom: 1px solid var(--line-soft);
        }
        .r1-head { background: var(--surface-2); border-bottom: 1px solid var(--line); }
        .r1-th {
          font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; color: var(--faint);
        }
        .r1-th.is-right { text-align: right; }
        .r1-td {
          font-size: 13px; color: var(--ink-2); min-width: 0;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .r1-td.is-right { text-align: right; font-variant-numeric: tabular-nums; }
        .r1-td.is-strong { font-weight: 650; color: var(--ink); }
        .r1-doc { font-weight: 650; color: var(--brand); }
        .r1-mono { font-family: var(--mono); font-size: 12px; }
        .r1-dim { color: var(--muted); }
        .r1-foot { background: var(--surface-2); border-bottom: none; }
        .r1-foot .r1-td { color: var(--ink); font-weight: 700; }
        .r1-hint {
          padding: 0.7rem 1rem; font-size: 11.5px; color: var(--faint);
          border-top: 1px solid var(--line-soft);
        }

        .r1-note {
          display: flex; gap: 9px; margin-top: 1rem; padding: 12px 14px;
          background: var(--amber-soft); border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 12px; color: var(--ink-2); line-height: 1.6;
        }
        .r1-note-link { display: inline-block; margin-left: 6px; color: var(--brand); font-weight: 650; text-decoration: none; }

        @media (max-width: 768px) {
          .r1-grid { min-width: 0; }
          .r1-head { display: none !important; }
          .r1-cols { grid-template-columns: 1fr !important; gap: 5px; padding: 12px 14px; }
          .r1-row {
            border: 1px solid var(--line); border-radius: 12px;
            margin: 0 0.6rem 10px; background: var(--surface);
          }
          .r1-td {
            display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
            text-align: right; white-space: normal; overflow: visible;
          }
          .r1-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: 0.05em; text-align: left; flex-shrink: 0;
          }
          .r1-foot { border-radius: 12px; margin: 0 0.6rem 0.6rem; }
          /* Blanks keep the desktop grid aligned; on mobile they are dead lines. */
          .r1-foot .is-blank { display: none; }
        }
      `}</style>
    </div>
  )
}

function ReportTable<Row>({ rows, columns, foot }: {
  rows: Row[]
  columns: Column<Row>[]
  foot: ReactNode[]
}) {
  const grid = gridOf(columns)
  return (
    <div className="table-scroll">
      <div className="r1-grid">
        <div className="r1-cols r1-head" style={{ gridTemplateColumns: grid }}>
          {columns.map(c => (
            <span key={c.key} className={`r1-th ${c.right ? 'is-right' : ''}`}>{c.label}</span>
          ))}
        </div>
        {rows.map((row, i) => (
          <div key={i} className="r1-cols r1-row tf-tr" style={{ gridTemplateColumns: grid }}>
            {columns.map(c => (
              <span key={c.key} data-label={c.label}
                className={`r1-td ${c.right ? 'is-right' : ''} ${c.strong ? 'is-strong' : ''}`}>
                {c.render(row)}
              </span>
            ))}
          </div>
        ))}
        <div className="r1-cols r1-foot" style={{ gridTemplateColumns: grid }}>{foot}</div>
      </div>
    </div>
  )
}

/** Raw values for the CSV — the screen shows rupee-formatted cells, the file wants numbers. */
function csvCell(key: string, row: InvoiceRow): string | number {
  switch (key) {
    case 'invoice_number': return row.invoice_number
    case 'invoice_date': return row.invoice_date
    case 'customer_name': return row.customer_name || ''
    case 'customer_gstin': return row.customer_gstin || ''
    case 'supply_type': return row.supply_type || ''
    case 'place_of_supply': return row.place_of_supply || ''
    case 'taxable_amount': return num(row.taxable_amount)
    case 'total_tax': return num(row.total_tax)
    case 'igst_amount': return num(row.igst_amount)
    case 'grand_total': return num(row.grand_total)
    default: return ''
  }
}

function invoiceFoot(tab: InvoiceTab, rows: InvoiceRow[]): ReactNode[] {
  const totalsByHead: Record<string, ReactNode> = {
    taxable_amount: money(rows.reduce((s, r) => s + num(r.taxable_amount), 0)),
    total_tax: money(rows.reduce((s, r) => s + num(r.total_tax), 0)),
    igst_amount: money(rows.reduce((s, r) => s + num(r.igst_amount), 0)),
    grand_total: money(rows.reduce((s, r) => s + num(r.grand_total), 0)),
  }
  return INVOICE_COLUMNS[tab].map((c, i) => {
    const value = i === 0
      ? `Total · ${plural(rows.length, 'invoice')}`
      : totalsByHead[c.key]
    return (
      <span key={c.key} data-label={i === 0 ? '' : c.label}
        className={`r1-td ${c.right ? 'is-right' : ''} ${value ? '' : 'is-blank'}`}>
        {value}
      </span>
    )
  })
}

function hsnFoot(rows: HsnRow[]): ReactNode[] {
  const sumOf = (key: 'taxableValue' | 'igst' | 'cgst' | 'sgst' | 'cess') =>
    money(rows.reduce((s, h) => s + h[key], 0))
  const totalsByHead: Record<string, ReactNode> = {
    taxableValue: sumOf('taxableValue'),
    igst: sumOf('igst'),
    cgst: sumOf('cgst'),
    sgst: sumOf('sgst'),
    cess: sumOf('cess'),
  }
  return HSN_COLUMNS.map((c, i) => {
    const value = i === 0 ? `Total · ${plural(rows.length, 'code')}` : totalsByHead[c.key]
    return (
      <span key={c.key} data-label={i === 0 ? '' : c.label}
        className={`r1-td ${c.right ? 'is-right' : ''} ${value ? '' : 'is-blank'}`}>
        {value}
      </span>
    )
  })
}
