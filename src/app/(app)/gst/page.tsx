'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  Badge, Button, Card, PageHeader, SectionTitle, StatCard, StatRow, StackedBar,
} from '@/components/ui'
import type { Tone } from '@/components/ui'
import Icon from '@/components/Icons'

interface InvoiceTotals {
  grand_total: number | string | null
  taxable_amount: number | string | null
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  igst_amount: number | string | null
}

interface BillTotals {
  grand_total: number | string | null
  cgst_amount: number | string | null
  sgst_amount: number | string | null
  igst_amount: number | string | null
}

interface ReturnPeriodRow {
  id: string
  return_type: string
  status: string
}

interface ReturnStatus {
  type: string
  label: string
  desc: string
  href: string
  dueDay: number
  status: string
  id: string | null
}

interface Summary {
  invoiceCount: number
  billCount: number
  totalSales: number
  taxableSales: number
  cgstCollected: number
  sgstCollected: number
  igstCollected: number
  totalOutputTax: number
  totalPurchases: number
  itcCGST: number
  itcSGST: number
  itcIGST: number
  totalITC: number
  netPayable: number
}

const EMPTY_SUMMARY: Summary = {
  invoiceCount: 0, billCount: 0,
  totalSales: 0, taxableSales: 0,
  cgstCollected: 0, sgstCollected: 0, igstCollected: 0, totalOutputTax: 0,
  totalPurchases: 0, itcCGST: 0, itcSGST: 0, itcIGST: 0,
  totalITC: 0, netPayable: 0,
}

// GSTR-1 on the 11th and GSTR-3B on the 20th of the month *after* the supply period.
const RETURN_KINDS = [
  { type: 'GSTR1', label: 'GSTR-1', desc: 'Outward supplies', href: '/gst/gstr1', dueDay: 11 },
  { type: 'GSTR3B', label: 'GSTR-3B', desc: 'Summary return', href: '/gst/gstr3b', dueDay: 20 },
]

const STATUS_META: Record<string, { label: string; tone: Tone }> = {
  not_started: { label: 'Not Started', tone: 'grey' },
  draft: { label: 'Draft', tone: 'amber' },
  ready: { label: 'Ready to File', tone: 'blue' },
  filed: { label: 'Filed', tone: 'green' },
}

const STATUS_OPTIONS = ['not_started', 'draft', 'ready', 'filed']

const HEAD_COLORS = { cgst: 'var(--violet)', sgst: 'var(--brand)', igst: 'var(--cyan)' }

const inr = (value: number) => `₹${formatINR(value)}`

function sum<Row extends object, K extends keyof Row>(rows: Row[], key: K): number {
  return rows.reduce((total, row) => total + Number(row[key] || 0), 0)
}

function periodDate(period: string) {
  const [year, month] = period.split('-').map(Number)
  return new Date(year, month - 1, 1)
}

function periodLabel(period: string) {
  return periodDate(period).toLocaleDateString('en-IN', { month: 'short', year: 'numeric' })
}

/** Financial year of the period being viewed, not of today. */
function fyLabel(period: string) {
  const date = periodDate(period)
  const year = date.getFullYear()
  return date.getMonth() >= 3
    ? `${year}-${String(year + 1).slice(2)}`
    : `${year - 1}-${String(year).slice(2)}`
}

function dueDate(period: string, day: number) {
  const date = periodDate(period)
  return new Date(date.getFullYear(), date.getMonth() + 1, day)
}

function daysUntil(date: Date) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(date)
  target.setHours(0, 0, 0, 0)
  return Math.round((target.getTime() - today.getTime()) / 86_400_000)
}

/** Last n calendar months as YYYY-MM periods, newest first. */
function getLastNMonths(n: number) {
  const months: { period: string; label: string }[] = []
  const now = new Date()
  for (let i = 0; i < n; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    months.push({ period, label: periodLabel(period) })
  }
  return months
}

export default function GSTDashboardPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [summary, setSummary] = useState<Summary>(EMPTY_SUMMARY)
  const [returnStatus, setReturnStatus] = useState<ReturnStatus[]>([])

  const months = getLastNMonths(6)

  async function fetchPeriod(oid: string, period: string) {
    const date = periodDate(period)
    const startDate = `${period}-01`
    const endDate = `${period}-${new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()}`

    const [invoicesRes, billsRes, returnsRes] = await Promise.all([
      supabase
        .from('invoices')
        .select('grand_total, taxable_amount, cgst_amount, sgst_amount, igst_amount')
        .eq('organization_id', oid)
        .neq('status', 'cancelled')
        .gte('invoice_date', startDate)
        .lte('invoice_date', endDate),
      supabase
        .from('purchase_bills')
        .select('grand_total, cgst_amount, sgst_amount, igst_amount')
        .eq('organization_id', oid)
        .eq('itc_eligible', true)
        .neq('status', 'cancelled')
        .gte('bill_date', startDate)
        .lte('bill_date', endDate),
      supabase
        .from('gst_return_periods')
        .select('id, return_type, status')
        .eq('organization_id', oid)
        .eq('period', period),
    ])

    const invoices = (invoicesRes.data || []) as unknown as InvoiceTotals[]
    const bills = (billsRes.data || []) as unknown as BillTotals[]
    const returns = (returnsRes.data || []) as unknown as ReturnPeriodRow[]

    const cgstCollected = sum(invoices, 'cgst_amount')
    const sgstCollected = sum(invoices, 'sgst_amount')
    const igstCollected = sum(invoices, 'igst_amount')
    const totalOutputTax = cgstCollected + sgstCollected + igstCollected

    const itcCGST = sum(bills, 'cgst_amount')
    const itcSGST = sum(bills, 'sgst_amount')
    const itcIGST = sum(bills, 'igst_amount')
    const totalITC = itcCGST + itcSGST + itcIGST

    return {
      summary: {
        invoiceCount: invoices.length,
        billCount: bills.length,
        totalSales: sum(invoices, 'grand_total'),
        taxableSales: sum(invoices, 'taxable_amount'),
        cgstCollected, sgstCollected, igstCollected, totalOutputTax,
        totalPurchases: sum(bills, 'grand_total'),
        itcCGST, itcSGST, itcIGST, totalITC,
        netPayable: Math.max(0, totalOutputTax - totalITC),
      },
      returns: RETURN_KINDS.map(kind => {
        const existing = returns.find(r => r.return_type === kind.type)
        return {
          ...kind,
          status: existing?.status || 'not_started',
          id: existing?.id || null,
        }
      }),
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

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', membership.organization_id)
        .eq('is_primary', true)
        .single()

      if (gstReg) setOrgStateCode(gstReg.state_code || '')
    }
    load()
  }, [])

  useEffect(() => {
    if (!orgId) return
    let stale = false

    async function run() {
      const period = await fetchPeriod(orgId, selectedPeriod)
      if (stale) return
      setSummary(period.summary)
      setReturnStatus(period.returns)
      setLoading(false)
    }
    run()

    return () => { stale = true }
  }, [selectedPeriod, orgId])

  async function updateReturnStatus(returnType: string, status: string) {
    if (!orgId) return
    const existing = returnStatus.find(r => r.type === returnType)

    if (existing?.id) {
      await supabase
        .from('gst_return_periods')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    } else {
      await supabase
        .from('gst_return_periods')
        .insert({
          organization_id: orgId,
          return_type: returnType,
          financial_year: fyLabel(selectedPeriod),
          period_type: 'monthly',
          period: selectedPeriod,
          status,
          tax_liability: summary.totalOutputTax,
          itc_claimed: summary.totalITC,
          net_payable: summary.netPayable,
        })
    }

    const period = await fetchPeriod(orgId, selectedPeriod)
    setSummary(period.summary)
    setReturnStatus(period.returns)
  }

  if (loading) {
    return (
      <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>
        Reading this month’s invoices and bills…
      </div>
    )
  }

  const dueSummary = summary.totalOutputTax - summary.totalITC
  const payable = summary.netPayable

  return (
    <div className="page-container gh" style={{ maxWidth: 1180 }}>
      <PageHeader
        eyebrow={`GST · FY ${fyLabel(selectedPeriod)}`}
        title="GST Dashboard"
        subtitle={`${periodLabel(selectedPeriod)} — tax collected on your invoices, credit available on your bills, and how far the returns for this period have moved.`}
        actions={
          <select
            className="tf-input"
            style={{ cursor: 'pointer', minWidth: 170 }}
            value={selectedPeriod}
            onChange={e => setSelectedPeriod(e.target.value)}
            aria-label="Tax period"
          >
            {months.map(m => (
              <option key={m.period} value={m.period}>{m.label}</option>
            ))}
          </select>
        }
        right={orgStateCode
          ? <Badge tone="grey">Supplying from {orgStateCode}</Badge>
          : <Badge tone="grey">No GSTIN registered</Badge>}
      />

      {/* Headline numbers */}
      <div className="tf-g-4" style={{ marginBottom: '1rem' }}>
        <StatCard label="Total sales" value={summary.totalSales} tone="blue" icon="invoice"
          sub={`${summary.invoiceCount} invoice${summary.invoiceCount === 1 ? '' : 's'}`} />
        <StatCard label="Output tax" value={summary.totalOutputTax} tone="violet" icon="percent"
          sub="Collected on supplies" />
        <StatCard label="ITC available" value={summary.totalITC} tone="green" icon="cart"
          sub={`${summary.billCount} eligible bill${summary.billCount === 1 ? '' : 's'}`} />
        <StatCard label="Net GST payable" value={payable} tone={payable > 0 ? 'red' : 'green'}
          icon="wallet" sub={payable > 0 ? 'Deposit by the 20th' : 'Credit covers the tax'} />
      </div>

      {/* Net payable */}
      <Card className={`gh-net ${payable > 0 ? 'is-due' : 'is-clear'}`}>
        <div className="tf-row gh-net-main">
          <Icon
            name={payable > 0 ? 'alert' : 'check'}
            size={20}
            style={{ color: payable > 0 ? 'var(--red)' : 'var(--green)', flexShrink: 0 }}
          />
          <div style={{ minWidth: 0 }}>
            <div className="gh-net-title">
              {payable > 0 ? `Net GST payable for ${periodLabel(selectedPeriod)}` : `Nothing to pay for ${periodLabel(selectedPeriod)}`}
            </div>
            <div className="gh-net-sub">
              Output tax {inr(summary.totalOutputTax)} − ITC {inr(summary.totalITC)}
              {dueSummary < 0 ? ` · ${inr(-dueSummary)} credit carried forward` : ''}
            </div>
          </div>
        </div>
        <div className="tf-num gh-net-value">{inr(payable)}</div>
      </Card>

      {/* Breakdown */}
      <div className="tf-g-2 gh-breakdown">
        <Card>
          <SectionTitle icon="invoice">Output tax (sales)</SectionTitle>
          <StackedBar
            height={8}
            segments={[
              { label: 'CGST', value: summary.cgstCollected, color: HEAD_COLORS.cgst },
              { label: 'SGST', value: summary.sgstCollected, color: HEAD_COLORS.sgst },
              { label: 'IGST', value: summary.igstCollected, color: HEAD_COLORS.igst },
            ]}
          />
          <div style={{ marginTop: '0.9rem' }}>
            <StatRow label={<Head label="Total sales" />} value={inr(summary.totalSales)} />
            <StatRow label={<Head label="Taxable value" />} value={inr(summary.taxableSales)} />
            <StatRow label={<Head label="CGST collected" color={HEAD_COLORS.cgst} />} value={inr(summary.cgstCollected)} />
            <StatRow label={<Head label="SGST collected" color={HEAD_COLORS.sgst} />} value={inr(summary.sgstCollected)} />
            <StatRow label={<Head label="IGST collected" color={HEAD_COLORS.igst} />} value={inr(summary.igstCollected)} />
            <StatRow label="Total output tax" value={inr(summary.totalOutputTax)} tone="violet" strong />
          </div>
        </Card>

        <Card>
          <SectionTitle icon="cart">Input tax credit (purchases)</SectionTitle>
          <StackedBar
            height={8}
            segments={[
              { label: 'CGST ITC', value: summary.itcCGST, color: HEAD_COLORS.cgst },
              { label: 'SGST ITC', value: summary.itcSGST, color: HEAD_COLORS.sgst },
              { label: 'IGST ITC', value: summary.itcIGST, color: HEAD_COLORS.igst },
            ]}
          />
          <div style={{ marginTop: '0.9rem' }}>
            <StatRow label={<Head label="Total purchases" />} value={inr(summary.totalPurchases)} />
            <StatRow label={<Head label="CGST ITC" color={HEAD_COLORS.cgst} />} value={inr(summary.itcCGST)} />
            <StatRow label={<Head label="SGST ITC" color={HEAD_COLORS.sgst} />} value={inr(summary.itcSGST)} />
            <StatRow label={<Head label="IGST ITC" color={HEAD_COLORS.igst} />} value={inr(summary.itcIGST)} />
            <StatRow label="Total ITC available" value={inr(summary.totalITC)} tone="green" strong />
          </div>
          <div className="gh-note">
            Only bills marked ITC-eligible are counted. Reversals under Rule 42/43 and
            credit blocked on unpaid suppliers are handled in the annual workpaper.
          </div>
        </Card>
      </div>

      {/* Return filing status */}
      <Card>
        <SectionTitle icon="file-check">Return filing status — {periodLabel(selectedPeriod)}</SectionTitle>
        <div className="gh-rets">
          {returnStatus.map(ret => {
            const meta = STATUS_META[ret.status] || STATUS_META.not_started
            const due = dueDate(selectedPeriod, ret.dueDay)
            const days = daysUntil(due)
            const late = days < 0 && ret.status !== 'filed'
            const soon = days >= 0 && days <= 3 && ret.status !== 'filed'
            return (
              <div key={ret.type} className="gh-ret">
                <div style={{ minWidth: 0 }}>
                  <div className="gh-ret-name">{ret.label}</div>
                  <div className="gh-ret-meta">
                    {ret.desc} · due {due.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
                    {late && <span className="gh-due is-late"> · overdue by {Math.abs(days)} day{Math.abs(days) === 1 ? '' : 's'}</span>}
                    {soon && <span className="gh-due is-soon"> · due in {days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`}</span>}
                  </div>
                </div>
                <div className="tf-row tf-wrap gh-ret-actions">
                  <Badge tone={meta.tone}>{meta.label}</Badge>
                  <select
                    className="tf-input"
                    style={{ cursor: 'pointer', fontSize: 12 }}
                    value={ret.status}
                    onChange={e => updateReturnStatus(ret.type, e.target.value)}
                    aria-label={`${ret.label} status`}
                  >
                    {STATUS_OPTIONS.map(option => (
                      <option key={option} value={option}>{STATUS_META[option].label}</option>
                    ))}
                  </select>
                  <Button size="sm" variant="subtle" href={ret.href} iconRight="arrow-right">
                    View report
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="gh-note" style={{ marginTop: '0.9rem' }}>
          Status is recorded per period so you can see what is still open. Filing itself happens on the GST portal —
          nothing here is transmitted.
        </div>
      </Card>

      {/* Reports */}
      <div className="tf-g-4 gh-links">
        <Link href="/gst/gstr1" className="gh-link">
          <Card hover>
            <div className="gh-link-head">
              <Icon name="upload" size={17} style={{ color: 'var(--brand)' }} />
              <span className="gh-link-title">GSTR-1 Report</span>
            </div>
            <div className="gh-link-sub">
              Outward supplies split into B2B, B2C, exports and the HSN summary.
            </div>
          </Card>
        </Link>
        <Link href="/gst/gstr3b" className="gh-link">
          <Card hover>
            <div className="gh-link-head">
              <Icon name="file-check" size={17} style={{ color: 'var(--violet)' }} />
              <span className="gh-link-title">GSTR-3B Report</span>
            </div>
            <div className="gh-link-sub">
              Summary return with tax liability, eligible ITC and the net amount payable.
            </div>
          </Card>
        </Link>
        <Link href="/gst/gstr9" className="gh-link">
          <Card hover>
            <div className="gh-link-head">
              <Icon name="book" size={17} style={{ color: 'var(--green)' }} />
              <span className="gh-link-title">GSTR-9 / 9C Workpaper</span>
            </div>
            <div className="gh-link-sub">
              Annual tables, the 180-day credit watchlist and books against filed 3B.
            </div>
          </Card>
        </Link>
        <Link href="/gst/gstr4" className="gh-link">
          <Card hover>
            <div className="gh-link-head">
              <Icon name="percent" size={17} style={{ color: 'var(--amber)' }} />
              <span className="gh-link-title">GSTR-4 / CMP-08 Workpaper</span>
            </div>
            <div className="gh-link-sub">
              Composition slab tax, the 2.5% deemed debit and the bills that end the scheme.
            </div>
          </Card>
        </Link>
      </div>

      <div className="tf-row tf-wrap" style={{ gap: 8, marginTop: '0.9rem' }}>
        <Button variant="ghost" size="sm" href="/gst/reconciliation" icon="compare">
          2B reconciliation
        </Button>
        <Button variant="ghost" size="sm" href="/gst/einvoice" icon="zap">
          e-Invoice &amp; e-Way bill
        </Button>
        <Button variant="ghost" size="sm" href="/gst/job-work" icon="factory">
          Job work &amp; ITC-04
        </Button>
        <Button variant="ghost" size="sm" href="/gst/calendar" icon="calendar">
          Compliance calendar
        </Button>
      </div>

      <style>{`
        .gh .tf-pagehead { margin-bottom: 1.25rem; }
        .gh-net { display: flex; align-items: center; justify-content: space-between; gap: 16px;
          flex-wrap: wrap; margin-bottom: 1rem; }
        .gh-net-main { min-width: 0; }
        .gh-net.is-due { background: var(--red-soft); border-color: transparent; }
        .gh-net.is-clear { background: var(--green-soft); border-color: transparent; }
        .gh-net-title { font-size: 14px; font-weight: 700; color: var(--ink); }
        .gh-net-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
        .gh-net-value { font-size: 26px; font-weight: 750; color: var(--ink); }

        .gh-breakdown { margin-bottom: 1rem; }
        .gh-head { display: flex; align-items: center; gap: 7px; }
        .gh-dot { width: 7px; height: 7px; border-radius: 99px; flex-shrink: 0; }
        .gh-dot.is-blank { background: var(--line); }

        .gh-rets { display: flex; flex-direction: column; gap: 10px; }
        .gh-ret { display: flex; align-items: center; justify-content: space-between; gap: 12px;
          flex-wrap: wrap; padding: 0.9rem 1rem; border: 1px solid var(--line);
          border-radius: var(--radius-sm); background: var(--surface-2); }
        .gh-ret-name { font-size: 14px; font-weight: 650; color: var(--ink); }
        .gh-ret-meta { font-size: 12px; color: var(--muted); margin-top: 3px; }
        .gh-ret-actions { margin-left: auto; }
        .gh-due { font-weight: 650; }
        .gh-due.is-late { color: var(--red); }
        .gh-due.is-soon { color: var(--amber); }

        .gh-note { font-size: 11.5px; color: var(--faint); line-height: 1.6; margin-top: 0.85rem; }
        .gh-links { margin-top: 1.5rem; }
        .gh-link { text-decoration: none; color: inherit; display: block; }
        .gh-link-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
        .gh-link-title { font-size: 15px; font-weight: 650; color: var(--ink); }
        .gh-link-sub { font-size: 12.5px; color: var(--muted); line-height: 1.55; }

        @media (max-width: 768px) {
          .gh-net-value { font-size: 22px; }
          .gh-ret-actions { margin-left: 0; width: 100%; }
        }
      `}</style>
    </div>
  )
}

function Head({ label, color }: { label: string; color?: string }) {
  return (
    <span className="gh-head">
      {color ? <i className="gh-dot" style={{ background: color }} /> : <i className="gh-dot is-blank" />}
      {label}
    </span>
  )
}
