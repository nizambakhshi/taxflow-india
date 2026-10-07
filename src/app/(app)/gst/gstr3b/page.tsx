'use client'

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { csvFromRows } from '@/lib/gstr9'
import { download } from '@/lib/party-ledger'
import {
  Badge, Button, Card, PageHeader, StatCard,
} from '@/components/ui'
import Icon from '@/components/Icons'

interface InvoiceTotals {
  supply_type: string | null
  taxable_amount: number | string | null
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  igst_amount: number | string | null
  cess_amount: number | string | null
  total_tax: number | string | null
}

interface BillTotals {
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  igst_amount: number | string | null
}

interface ExpenseTotals {
  gst_amount: number | string | null
}

interface Head {
  taxable: number
  igst: number
  cgst: number
  sgst: number
}

const ZERO_HEAD: Head = { taxable: 0, igst: 0, cgst: 0, sgst: 0 }

interface Heads {
  igst: number
  cgst: number
  sgst: number
  total: number
}

interface Data {
  outward: { other: Head; zeroRated: Head; nilExempt: Head; total: Head }
  outwardCess: number
  billItc: Heads
  expenseItc: Heads
  itc: Heads
  payable: Heads
  utilised: Heads
  carried: Heads
  cash: Heads
  counts: { invoices: number; bills: number; expenses: number }
}

const EMPTY_DATA: Data = {
  outward: { other: ZERO_HEAD, zeroRated: ZERO_HEAD, nilExempt: ZERO_HEAD, total: ZERO_HEAD },
  outwardCess: 0,
  billItc: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  expenseItc: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  itc: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  payable: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  utilised: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  carried: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  cash: { igst: 0, cgst: 0, sgst: 0, total: 0 },
  counts: { invoices: 0, bills: 0, expenses: 0 },
}

const num = (v: number | string | null) => Number(v || 0)
const money = (v: number) => `₹${formatINR(v)}`

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

/** 3B reports each head separately, so credit can only be used against the same head. */
function settle(payable: number, credit: number) {
  const used = Math.min(payable, credit)
  return { used, cash: payable - used, carried: credit - used }
}

export default function GSTR3BPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })
  const [data, setData] = useState<Data>(EMPTY_DATA)

  const months = periodOptions(6)
  const periodLabel = months.find(m => m.period === selectedPeriod)?.label || selectedPeriod

  async function loadPeriod(oid: string, period: string): Promise<Data> {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    const [invoicesRes, billsRes, expensesRes] = await Promise.all([
      supabase
        .from('invoices')
        .select('supply_type, taxable_amount, cgst_amount, sgst_amount, igst_amount, cess_amount, total_tax')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .gte('invoice_date', startDate)
        .lte('invoice_date', endDate),
      supabase
        .from('purchase_bills')
        .select('cgst_amount, sgst_amount, igst_amount')
        .eq('organization_id', oid)
        .eq('itc_eligible', true)
        .neq('status', 'cancelled')
        .gte('bill_date', startDate)
        .lte('bill_date', endDate),
      supabase
        .from('expenses')
        .select('gst_amount')
        .eq('organization_id', oid)
        .eq('itc_eligible', true)
        .gte('expense_date', startDate)
        .lte('expense_date', endDate),
    ])

    const invoices = (invoicesRes.data || []) as unknown as InvoiceTotals[]
    const bills = (billsRes.data || []) as unknown as BillTotals[]
    const expenses = (expensesRes.data || []) as unknown as ExpenseTotals[]

    const add = (head: Head, row: InvoiceTotals): Head => ({
      taxable: head.taxable + num(row.taxable_amount),
      igst: head.igst + num(row.igst_amount),
      cgst: head.cgst + num(row.cgst_amount),
      sgst: head.sgst + num(row.sgst_amount),
    })

    let other = ZERO_HEAD
    let zeroRated = ZERO_HEAD
    let nilExempt = ZERO_HEAD
    let outwardCess = 0

    for (const inv of invoices) {
      outwardCess += num(inv.cess_amount)
      const isZeroRated = inv.supply_type === 'export' || inv.supply_type === 'sez'
      if (isZeroRated) zeroRated = add(zeroRated, inv)
      else if (num(inv.total_tax) === 0) nilExempt = add(nilExempt, inv)
      else other = add(other, inv)
    }

    const total: Head = {
      taxable: other.taxable + zeroRated.taxable + nilExempt.taxable,
      igst: other.igst + zeroRated.igst + nilExempt.igst,
      cgst: other.cgst + zeroRated.cgst + nilExempt.cgst,
      sgst: other.sgst + zeroRated.sgst + nilExempt.sgst,
    }

    const billItc = {
      igst: bills.reduce((s, b) => s + num(b.igst_amount), 0),
      cgst: bills.reduce((s, b) => s + num(b.cgst_amount), 0),
      sgst: bills.reduce((s, b) => s + num(b.sgst_amount), 0),
      total: 0,
    }
    billItc.total = billItc.igst + billItc.cgst + billItc.sgst

    // Expense GST is recorded as one figure; an intra-state expense splits 50:50 between CGST and SGST.
    const expenseGst = expenses.reduce((s, e) => s + num(e.gst_amount), 0)
    const expenseItc = { igst: 0, cgst: expenseGst / 2, sgst: expenseGst / 2, total: expenseGst }

    const itc = {
      igst: billItc.igst + expenseItc.igst,
      cgst: billItc.cgst + expenseItc.cgst,
      sgst: billItc.sgst + expenseItc.sgst,
      total: billItc.total + expenseItc.total,
    }

    const igstSettle = settle(total.igst, itc.igst)
    const cgstSettle = settle(total.cgst, itc.cgst)
    const sgstSettle = settle(total.sgst, itc.sgst)

    return {
      outward: { other, zeroRated, nilExempt, total },
      outwardCess,
      billItc,
      expenseItc,
      itc,
      payable: { igst: total.igst, cgst: total.cgst, sgst: total.sgst, total: total.igst + total.cgst + total.sgst },
      utilised: {
        igst: igstSettle.used, cgst: cgstSettle.used, sgst: sgstSettle.used,
        total: igstSettle.used + cgstSettle.used + sgstSettle.used,
      },
      carried: {
        igst: igstSettle.carried, cgst: cgstSettle.carried, sgst: sgstSettle.carried,
        total: igstSettle.carried + cgstSettle.carried + sgstSettle.carried,
      },
      cash: {
        igst: igstSettle.cash, cgst: cgstSettle.cash, sgst: sgstSettle.cash,
        total: igstSettle.cash + cgstSettle.cash + sgstSettle.cash,
      },
      counts: { invoices: invoices.length, bills: bills.length, expenses: expenses.length },
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
      setData(period)
      setLoading(false)
    }
    run()

    return () => { stale = true }
  }, [selectedPeriod, orgId])

  function exportCSV() {
    const o = data.outward
    const rows: (string | number)[][] = [
      ['GSTR-3B Summary', selectedPeriod],
      [],
      ['3.1 OUTWARD SUPPLIES'],
      ['Nature of supplies', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST'],
      ['(a) Outward taxable supplies (other than zero rated, nil & exempted)', o.other.taxable, o.other.igst, o.other.cgst, o.other.sgst],
      ['(b) Outward taxable supplies (zero rated)', o.zeroRated.taxable, o.zeroRated.igst, o.zeroRated.cgst, o.zeroRated.sgst],
      ['(c) Other outward supplies (nil rated, exempted)', o.nilExempt.taxable, 0, 0, 0],
      ['Total', o.total.taxable, o.total.igst, o.total.cgst, o.total.sgst],
      ['Cess collected', data.outwardCess],
      [],
      ['4 ELIGIBLE ITC'],
      ['Details', 'IGST', 'CGST', 'SGST/UTGST', 'Total'],
      ['(A) Purchase bills — inputs', data.billItc.igst, data.billItc.cgst, data.billItc.sgst, data.billItc.total],
      ['(B) Expenses with GST — split 50:50 CGST/SGST', 0, data.expenseItc.cgst, data.expenseItc.sgst, data.expenseItc.total],
      ['Total ITC available', data.itc.igst, data.itc.cgst, data.itc.sgst, data.itc.total],
      [],
      ['6.1 PAYMENT OF TAX'],
      ['Description', 'IGST', 'CGST', 'SGST', 'Total'],
      ['Tax payable', data.payable.igst, data.payable.cgst, data.payable.sgst, data.payable.total],
      ['Less: ITC utilised', -data.utilised.igst, -data.utilised.cgst, -data.utilised.sgst, -data.utilised.total],
      ['Net tax payable (cash)', data.cash.igst, data.cash.cgst, data.cash.sgst, data.cash.total],
      ['ITC carried forward', data.carried.igst, data.carried.cgst, data.carried.sgst, data.carried.total],
    ]

    // Splitting expense GST between CGST and SGST can leave fractions of a paisa and the
    // portal only takes two decimals. Route through formatINR so the file and the screen
    // round the same way — Math.round disagrees on an exact half-paisa.
    const asFile = (v: number) => Number(formatINR(v).replace(/[^\d.-]/g, ''))
    download(`GSTR3B-${selectedPeriod}.csv`,
      csvFromRows(rows.map(r => r.map(cell => typeof cell === 'number' ? asFile(cell) : cell))))
  }

  if (loading) {
    return (
      <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
        Reading invoices, bills and expenses for this month…
      </div>
    )
  }

  const o = data.outward
  const hasCredit = data.carried.total > 0.005

  return (
    <div className="page-container r3b" style={{ maxWidth: 900 }}>
      <PageHeader
        eyebrow={`Summary return · ${periodLabel}`}
        title="GSTR-3B"
        subtitle={
          <>
            The monthly summary your CA reconciles against: outward tax by head, credit available,
            what can be used against what, and what remains in cash.{' '}
            {data.counts.invoices + data.counts.bills + data.counts.expenses === 0
              ? 'No documents fall in this period.'
              : `Built from ${data.counts.invoices} invoices, ${data.counts.bills} bills and ${data.counts.expenses} expenses.`}
          </>
        }
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
        right={
          <>
            <Button variant="ghost" href="/gst/reconciliation" icon="compare">Reconcile with 2B</Button>
            <Button variant="subtle" icon="download" onClick={exportCSV}>CSV</Button>
          </>
        }
      />

      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="Outward tax" value={data.payable.total} tone="violet" icon="percent"
          sub={`On ${money(o.total.taxable)} taxable value`} />
        <StatCard label="ITC available" value={data.itc.total} tone="green" icon="cart"
          sub="Bills plus GST on expenses" />
        <StatCard label="Net cash payable" value={data.cash.total} tone={data.cash.total > 0 ? 'red' : 'green'}
          icon="wallet" sub={data.cash.total > 0 ? 'Deposit by the 20th' : 'Credit covers the tax'} />
        <StatCard label="Credit carried forward" value={data.carried.total}
          tone={hasCredit ? 'amber' : 'grey'} icon="clock"
          sub={hasCredit ? 'Head-wise, stays in the ledger' : 'Nothing left unused'} />
      </div>

      {/* 3.1 outward supplies */}
      <Card>
        <SectionHead num="3.1" title="Outward supplies and inward supplies liable to reverse charge" />
        <StatTable
          head={['Nature of supplies', 'Taxable value', 'IGST', 'CGST', 'SGST/UTGST']}
          rows={[
            {
              cells: ['(a) Outward taxable supplies (other than zero rated, nil rated and exempted)',
                money(o.other.taxable), money(o.other.igst), money(o.other.cgst), money(o.other.sgst)],
            },
            {
              cells: ['(b) Outward taxable supplies (zero rated)',
                money(o.zeroRated.taxable), money(o.zeroRated.igst), money(o.zeroRated.cgst), money(o.zeroRated.sgst)],
            },
            {
              cells: ['(c) Other outward supplies (nil rated, exempted)',
                money(o.nilExempt.taxable), money(0), money(0), money(0)],
            },
          ]}
          foot={['Total', money(o.total.taxable), money(o.total.igst), money(o.total.cgst), money(o.total.sgst)]}
        />
        <div className="r3b-note">
          Row (c) counts invoices that carry a taxable value but no tax — a zero GST rate on the line is
          the only signal your books hold for nil-rated and exempt supplies.
          {data.outwardCess > 0
            ? ` Cess collected this period: ${money(data.outwardCess)}, reported in the same rows as the tax it sits on.`
            : ''}
        </div>
      </Card>

      {/* 4 eligible ITC */}
      <Card>
        <SectionHead num="4" title="Eligible input tax credit" />
        <StatTable
          head={['Details', 'IGST', 'CGST', 'SGST/UTGST', 'Total']}
          rows={[
            {
              cells: ['(A) Purchase bills marked ITC-eligible',
                money(data.billItc.igst), money(data.billItc.cgst), money(data.billItc.sgst), money(data.billItc.total)],
            },
            {
              cells: ['(B) Expenses with GST — split equally between CGST and SGST',
                money(data.expenseItc.igst), money(data.expenseItc.cgst), money(data.expenseItc.sgst), money(data.expenseItc.total)],
            },
          ]}
          foot={['Total ITC available', money(data.itc.igst), money(data.itc.cgst), money(data.itc.sgst), money(data.itc.total)]}
        />
        <div className="r3b-note">
          Credit against an inter-state bill is IGST and can only settle IGST payable. Rule 42/43 reversals
          and the 180-day payment rule are not applied here — the{' '}
          <a href="/gst/gstr9" className="r3b-link">annual workpaper</a> shows both.
        </div>
      </Card>

      {/* 6.1 payment of tax */}
      <Card>
        <SectionHead num="6.1" title="Payment of tax" />
        <StatTable
          head={['Description', 'IGST', 'CGST', 'SGST', 'Total']}
          rows={[
            {
              cells: ['Tax payable',
                money(data.payable.igst), money(data.payable.cgst), money(data.payable.sgst), money(data.payable.total)],
            },
            {
              cells: ['Less: ITC utilised',
                minus(data.utilised.igst), minus(data.utilised.cgst), minus(data.utilised.sgst), minus(data.utilised.total)],
            },
            {
              cells: ['Net tax payable (cash)',
                money(data.cash.igst), money(data.cash.cgst), money(data.cash.sgst), money(data.cash.total)],
              strong: true,
            },
          ]}
          foot={hasCredit
            ? ['ITC remaining — carried forward',
              money(data.carried.igst), money(data.carried.cgst), money(data.carried.sgst), money(data.carried.total)]
            : undefined}
          footTone="amber"
        />

        <div className="r3b-pay">
          <div className="tf-row-between tf-wrap" style={{ gap: 12 }}>
            <div>
              <div className="r3b-pay-label">Deposit against {periodLabel}</div>
              <div className="r3b-pay-sub">
                {data.cash.total > 0
                  ? `Challan heads: CGST ${money(data.cash.cgst)} · SGST ${money(data.cash.sgst)} · IGST ${money(data.cash.igst)}`
                  : 'No cash deposit needed — credit covers every head.'}
              </div>
            </div>
            <div className="tf-row" style={{ gap: 8 }}>
              <Badge tone={data.cash.total > 0 ? 'red' : 'green'}>
                {data.cash.total > 0 ? 'Payable' : 'Nil in cash'}
              </Badge>
              <div className={`r3b-pay-value ${data.cash.total > 0 ? 'is-due' : 'is-clear'}`}>
                {money(data.cash.total)}
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="r3b-note-box">
        <Icon name="alert" size={15} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
        <span>
          Summary prepared from your books — the return must be filed on the portal (gstn.gov.in) and every
          figure verified first. ITC eligibility depends on the conditions in Section 16 of the CGST Act,
          so confirm the final numbers with your CA.
          <a href="/gst/gstr1" className="r3b-link">See the invoice-wise outward supplies →</a>
        </span>
      </div>

      <style>{`
        .r3b .tf-pagehead { margin-bottom: 1.25rem; }
        .r3b .tf-card { margin-bottom: 1rem; }
        .r3b-sec-head { display: flex; align-items: center; gap: 9px; margin-bottom: 0.9rem; }
        .r3b-num {
          font-size: 11px; font-weight: 700; color: var(--brand); background: var(--brand-soft);
          border-radius: 6px; padding: 3px 8px; flex-shrink: 0;
        }
        .r3b-title { font-size: 13px; font-weight: 700; color: var(--ink-2); }

        .r3b-cols {
          display: grid; grid-template-columns: 2.4fr repeat(4, 1fr); gap: 10px;
          align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line-soft);
        }
        .r3b-th {
          font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase;
          color: var(--faint);
        }
        .r3b-th.is-right { text-align: right; }
        .r3b-td { font-size: 12.5px; color: var(--muted); }
        .r3b-td.is-lead { color: var(--ink-2); line-height: 1.45; }
        .r3b-td.is-right { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
        .r3b-row.is-strong .r3b-td { font-weight: 700; color: var(--ink); }
        .r3b-foot { background: var(--surface-2); border-bottom: none; margin-top: 4px; padding: 11px 10px;
          border-radius: var(--radius-sm); font-weight: 700; }
        .r3b-foot .r3b-td { color: var(--ink); font-weight: 700; }
        .r3b-foot.is-amber .r3b-td { color: var(--amber); }

        .r3b-note { font-size: 11.5px; color: var(--faint); line-height: 1.6; margin-top: 0.85rem; }
        .r3b-link { color: var(--brand); text-decoration: none; font-weight: 600; }

        .r3b-pay {
          margin-top: 1rem; padding: 0.95rem 1.1rem; border-radius: var(--radius-sm);
          background: ${data.cash.total > 0 ? 'var(--red-soft)' : 'var(--green-soft)'};
        }
        .r3b-pay-label { font-size: 13px; font-weight: 700; color: var(--ink); }
        .r3b-pay-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
        .r3b-pay-value { font-size: 22px; font-weight: 750; font-variant-numeric: tabular-nums; }
        .r3b-pay-value.is-due { color: var(--red); }
        .r3b-pay-value.is-clear { color: var(--green); }

        .r3b-note-box {
          display: flex; gap: 9px; padding: 12px 14px; background: var(--amber-soft);
          border: 1px solid var(--line); border-radius: var(--radius-sm);
          font-size: 12px; color: var(--ink-2); line-height: 1.6;
        }

        @media (max-width: 768px) {
          .r3b-cols { grid-template-columns: 1fr !important; gap: 4px; padding: 12px 0; }
          .r3b-row, .r3b-foot { border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; margin-bottom: 8px; }
          .r3b-foot { background: var(--surface-2); }
          .r3b-td {
            display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
            text-align: right; white-space: normal; overflow: visible;
          }
          /* .is-right sets nowrap on desktop; match its specificity or the amount still cannot wrap. */
          .r3b-td.is-right { white-space: normal; }
          .r3b-td.is-lead { justify-content: flex-start; font-weight: 700; color: var(--ink); }
          .r3b-td.is-lead::before { content: none; }
          .r3b-td::before {
            content: attr(data-label); font-size: 10.5px; font-weight: 700; color: var(--faint);
            text-transform: uppercase; letter-spacing: 0.05em; text-align: left;
          }
          .r3b-head { display: none !important; }
        }
      `}</style>
    </div>
  )
}

function SectionHead({ num: tableNum, title }: { num: string; title: string }) {
  return (
    <div className="r3b-sec-head">
      <span className="r3b-num">{tableNum}</span>
      <span className="r3b-title">{title}</span>
    </div>
  )
}

function minus(v: number) {
  return v > 0.005 ? `−${money(v)}` : money(0)
}

function StatTable({ head, rows, foot, footTone }: {
  head: string[]
  rows: { cells: ReactNode[]; strong?: boolean }[]
  foot?: ReactNode[]
  footTone?: 'amber'
}) {
  return (
    <div className="table-frame r3b-frame">
      <div className="r3b-cols r3b-head">
        {head.map((label, i) => (
          <span key={label} className={`r3b-th ${i > 0 ? 'is-right' : ''}`}>{label}</span>
        ))}
      </div>
      {rows.map((row, i) => (
        <div key={i} className={`r3b-cols r3b-row tf-tr ${row.strong ? 'is-strong' : ''}`}>
          {row.cells.map((cell, j) => (
            <span key={j} data-label={head[j]} className={`r3b-td ${j === 0 ? 'is-lead' : 'is-right'}`}>{cell}</span>
          ))}
        </div>
      ))}
      {foot && (
        <div className={`r3b-cols r3b-foot ${footTone === 'amber' ? 'is-amber' : ''}`}>
          {foot.map((cell, j) => (
            <span key={j} data-label={head[j]} className={`r3b-td ${j === 0 ? 'is-lead' : 'is-right'}`}>{cell}</span>
          ))}
        </div>
      )}
    </div>
  )
}
