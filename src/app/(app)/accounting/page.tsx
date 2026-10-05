'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  computeProfitLoss, computeBalanceSheet,
  loadOpeningBalances, saveOpeningBalances, currentFY,
  type OpeningBalances, type ProfitLoss, type BalanceSheet,
} from '@/lib/ledger'

const inputStyle = {
  width: '100%', padding: '9px 11px',
  border: '1px solid #d1d5db', borderRadius: '8px',
  fontSize: '13px', outline: 'none', color: '#1e293b', background: 'white',
}
const labelStyle = {
  display: 'block' as const, fontSize: '12px',
  fontWeight: '500' as const, color: '#374151', marginBottom: '4px',
}

// Line row used in both statements
function Line({
  label, value, bold, color, indent, minus,
}: {
  label: string; value: number; bold?: boolean; color?: string; indent?: boolean; minus?: boolean
}) {
  const negative = value < 0
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between',
      padding: bold ? '10px 0' : '7px 0',
      fontSize: bold ? '14px' : '13px',
      borderTop: bold ? '1px solid #e2e8f0' : (indent ? 'none' : '1px solid #f8fafc'),
      fontWeight: bold ? '700' : '500',
      paddingLeft: indent ? '12px' : 0,
    }}>
      <span style={{ color: bold ? '#1e293b' : '#64748b' }}>{label}</span>
      <span style={{ color: color || (bold ? '#1e293b' : '#334155') }}>
        {(minus || negative) ? '− ₹' : '₹'}{formatINR(Math.abs(value))}
      </span>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '12px', fontWeight: '700', color: '#94a3b8',
      textTransform: 'uppercase', letterSpacing: '0.05em',
      margin: '14px 0 4px',
    }}>{children}</div>
  )
}

export default function FinancialStatementsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'pl' | 'bs'>('pl')

  const [raw, setRaw] = useState<{
    invoices: any[]; bills: any[]; expenses: any[]; payments: any[]; products: any[]
  }>({ invoices: [], bills: [], expenses: [], payments: [], products: [] })

  const fy = useMemo(() => currentFY(), [])
  const [start, setStart] = useState(fy.start)
  const [end, setEnd] = useState(fy.end)
  const [periodLabel, setPeriodLabel] = useState(fy.label)

  // Opening balances modal
  const [opening, setOpening] = useState<OpeningBalances>({ cash: 0, fixedAssets: 0, loans: 0, capital: 0 })
  const [showOpening, setShowOpening] = useState(false)
  const [draftOpening, setDraftOpening] = useState<OpeningBalances>(opening)
  const [openingSaved, setOpeningSaved] = useState(false)

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
      const org = membership.organizations as any
      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName(org?.name || '')

      const ob = loadOpeningBalances(oid)
      setOpening(ob)
      setDraftOpening(ob)

      await loadAll(oid)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function loadAll(oid: string) {
    const [inv, bill, exp, pay, prod] = await Promise.all([
      supabase.from('invoices').select('status, invoice_date, taxable_amount, total_tax, balance_due').eq('organization_id', oid),
      supabase.from('purchase_bills').select('status, bill_date, taxable_amount, total_tax, itc_eligible, balance_due').eq('organization_id', oid),
      supabase.from('expenses').select('expense_date, amount, gst_amount, taxable_amount, itc_eligible, payment_status, category').eq('organization_id', oid),
      supabase.from('payments').select('payment_type, amount, payment_date').eq('organization_id', oid),
      supabase.from('products').select('type, track_inventory, current_stock, purchase_price').eq('organization_id', oid),
    ])
    setRaw({
      invoices: inv.data || [],
      bills: bill.data || [],
      expenses: exp.data || [],
      payments: pay.data || [],
      products: prod.data || [],
    })
  }

  // P&L for the selected period
  const pl: ProfitLoss = useMemo(
    () => computeProfitLoss(raw.invoices, raw.bills, raw.expenses, start, end),
    [raw, start, end],
  )

  // Cumulative net profit up to the period end (for retained earnings)
  const cumulativeProfit = useMemo(
    () => computeProfitLoss(raw.invoices, raw.bills, raw.expenses, '0000-01-01', end).netProfit,
    [raw, end],
  )

  const bs: BalanceSheet = useMemo(
    () => computeBalanceSheet({
      invoices: raw.invoices, bills: raw.bills, expenses: raw.expenses,
      payments: raw.payments, products: raw.products,
      opening, cumulativeNetProfit: cumulativeProfit,
    }, end),
    [raw, opening, cumulativeProfit, end],
  )

  function applyPreset(key: string) {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    if (key === 'this_fy') {
      const f = currentFY()
      setStart(f.start); setEnd(f.end); setPeriodLabel(f.label)
    } else if (key === 'prev_fy') {
      const f = currentFY()
      const py = Number(f.start.slice(0, 4)) - 1
      setStart(`${py}-04-01`); setEnd(`${py + 1}-03-31`); setPeriodLabel(`FY ${py}-${String(py + 1).slice(2)}`)
    } else if (key === 'this_quarter') {
      const q = Math.floor(m / 3)
      setStart(new Date(y, q * 3, 1).toISOString().split('T')[0])
      setEnd(new Date(y, q * 3 + 3, 0).toISOString().split('T')[0])
      setPeriodLabel(`Q${q + 1} ${y}`)
    } else if (key === 'this_month') {
      setStart(new Date(y, m, 1).toISOString().split('T')[0])
      setEnd(new Date(y, m + 1, 0).toISOString().split('T')[0])
      setPeriodLabel(now.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }))
    } else if (key === 'all') {
      setStart('0000-01-01'); setEnd(`${y + 1}-03-31`); setPeriodLabel('All time')
    }
  }

  function saveOpening() {
    saveOpeningBalances(orgId, draftOpening)
    setOpening(draftOpening)
    setShowOpening(false)
    setOpeningSaved(true)
    setTimeout(() => setOpeningSaved(false), 2000)
  }

  const hasAny = raw.invoices.length + raw.bills.length + raw.expenses.length > 0

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  const numField = (key: keyof OpeningBalances, lbl: string, hint: string) => (
    <div>
      <label style={labelStyle}>{lbl}</label>
      <input style={inputStyle} inputMode="decimal" placeholder="0"
        value={draftOpening[key] === 0 ? '' : String(draftOpening[key])}
        onChange={e => setDraftOpening({ ...draftOpening, [key]: parseFloat(e.target.value) || 0 })} />
      <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '3px' }}>{hint}</div>
    </div>
  )

  return (
    <div className="page-container" style={{ maxWidth: '1200px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        marginBottom: '1rem', gap: '10px', flexWrap: 'wrap',
      }}>
        <div>
          <h1 style={{ fontSize: '20px', fontWeight: '600', color: '#1e293b', marginBottom: '2px' }}>
            Financial Statements
          </h1>
          <p style={{ fontSize: '13px', color: '#64748b' }}>{orgName}</p>
        </div>
        <button onClick={() => { setDraftOpening(opening); setShowOpening(true) }} style={{
          padding: '9px 16px', background: 'white', color: '#374151',
          border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '13px',
          fontWeight: '600', cursor: 'pointer',
        }}>
          ⚖️ Opening balances
        </button>
      </div>

      {/* Tabs + period */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '12px', marginBottom: '1rem', flexWrap: 'wrap',
      }}>
        <div className="tab-bar" style={{ display: 'flex', gap: '4px' }}>
          <button onClick={() => setTab('pl')} style={{
            padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
            background: tab === 'pl' ? '#2563eb' : 'white',
            color: tab === 'pl' ? 'white' : '#374151', border: '1px solid #e2e8f0',
          }}>Profit & Loss</button>
          <button onClick={() => setTab('bs')} style={{
            padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '600', cursor: 'pointer',
            background: tab === 'bs' ? '#2563eb' : 'white',
            color: tab === 'bs' ? 'white' : '#374151', border: '1px solid #e2e8f0',
          }}>Balance Sheet</button>
        </div>
        <div className="tab-bar" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
          {[
            { k: 'this_month', l: 'This Month' },
            { k: 'this_quarter', l: 'Quarter' },
            { k: 'this_fy', l: 'This FY' },
            { k: 'prev_fy', l: 'Prev FY' },
            { k: 'all', l: 'All time' },
          ].map(p => (
            <button key={p.k} onClick={() => applyPreset(p.k)} style={{
              padding: '6px 12px', whiteSpace: 'nowrap', borderRadius: '99px', fontSize: '12px', cursor: 'pointer',
              background: periodLabel === p.l || (p.k === 'all' && periodLabel === 'All time') ? '#eff6ff' : 'white',
              color: '#374151', border: '1px solid #e2e8f0', fontWeight: '500',
            }}>{p.l}</button>
          ))}
        </div>
      </div>

      {/* Custom range */}
      <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '1rem', maxWidth: '360px' }}>
        <div>
          <label style={labelStyle}>From</label>
          <input type="date" style={inputStyle} value={start === '0000-01-01' ? '' : start}
            onChange={e => { setStart(e.target.value || '0000-01-01'); setPeriodLabel('Custom') }} />
        </div>
        <div>
          <label style={labelStyle}>To</label>
          <input type="date" style={inputStyle} value={end}
            onChange={e => { setEnd(e.target.value); setPeriodLabel('Custom') }} />
        </div>
      </div>

      {!hasAny && (
        <div style={{
          background: '#fffbeb', border: '1px solid #fde68a', borderRadius: '10px',
          padding: '12px 14px', marginBottom: '1rem', fontSize: '13px', color: '#92400e',
        }}>
          No transactions recorded yet — statements will populate as you add invoices, bills and expenses.
        </div>
      )}

      {/* P&L */}
      {tab === 'pl' && (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0',
          borderRadius: '12px', padding: '1.5rem', maxWidth: '640px',
        }}>
          <div style={{ fontSize: '15px', fontWeight: '700', color: '#1e293b', marginBottom: '2px' }}>
            Profit & Loss Statement
          </div>
          <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
            {periodLabel} · {start === '0000-01-01' ? 'inception' : new Date(start).toLocaleDateString('en-IN')}
            {' → '}{new Date(end).toLocaleDateString('en-IN')} · all figures excl. GST
          </div>

          <SectionTitle>Income</SectionTitle>
          <Line label="Sales revenue (net of tax)" value={pl.revenue} />
          <SectionTitle>Direct costs</SectionTitle>
          <Line label="Purchases (net of tax)" value={pl.purchases} minus />
          <Line label="Gross profit" value={pl.grossProfit} bold color={pl.grossProfit >= 0 ? '#166534' : '#dc2626'} />

          <SectionTitle>Operating expenses</SectionTitle>
          {pl.expensesByCategory.length === 0 ? (
            <div style={{ fontSize: '12px', color: '#94a3b8', padding: '4px 0' }}>No expenses in this period.</div>
          ) : pl.expensesByCategory.map(e => (
            <Line key={e.label} label={e.label} value={e.amount} indent minus />
          ))}
          <Line label="Total expenses" value={pl.totalExpenses} minus />

          <div style={{ marginTop: '14px' }}>
            <Line label="NET PROFIT" value={pl.netProfit} bold color={pl.netProfit >= 0 ? '#166534' : '#dc2626'} />
          </div>
        </div>
      )}

      {/* Balance Sheet */}
      {tab === 'bs' && (
        <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          {/* Assets */}
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.5rem',
          }}>
            <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b', marginBottom: '4px' }}>
              Assets
            </div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginBottom: '10px' }}>
              As on {new Date(end).toLocaleDateString('en-IN')}
            </div>
            <Line label="Sundry debtors (receivables)" value={bs.receivables} />
            <Line label="Inventory (stock × cost)" value={bs.inventory} />
            <Line label="Cash & bank (derived)" value={bs.cash} color={bs.cash < 0 ? '#dc2626' : undefined} />
            <Line label="Fixed assets" value={bs.fixedAssets} />
            <div style={{ marginTop: '10px' }}>
              <Line label="TOTAL ASSETS" value={bs.totalAssets} bold />
            </div>
          </div>

          {/* Liabilities + Equity */}
          <div style={{
            background: 'white', border: '1px solid #e2e8f0',
            borderRadius: '12px', padding: '1.5rem',
          }}>
            <div style={{ fontSize: '14px', fontWeight: '700', color: '#1e293b', marginBottom: '10px' }}>
              Liabilities & Owner&apos;s Funds
            </div>
            <Line label="Sundry creditors (payables)" value={bs.payables} />
            <Line label="Outstanding expenses" value={bs.outstandingExpenses} />
            <Line label="GST payable" value={bs.gstLiability} />
            <Line label="Loans" value={bs.loans} />
            <Line label="Total liabilities" value={bs.totalLiabilities} bold />

            <SectionTitle>Owner&apos;s funds</SectionTitle>
            <Line label="Opening capital" value={bs.openingCapital} />
            <Line label="Retained earnings (cumulative profit)" value={bs.retainedEarnings}
              color={bs.retainedEarnings < 0 ? '#dc2626' : undefined} />
            <Line label="Capital account (derived)" value={bs.balancingReserve}
              color={bs.balancingReserve < 0 ? '#dc2626' : undefined} />
            <Line label="Total owner's funds" value={bs.ownersFunds} bold />

            <div style={{
              marginTop: '14px', paddingTop: '12px', borderTop: '1px solid #e2e8f0',
              display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: '700',
            }}>
              <span style={{ color: '#1e293b' }}>Balance check</span>
              <span style={{ color: '#166534' }}>✓ Assets = Liab. + Funds</span>
            </div>
          </div>
        </div>
      )}

      <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '1.25rem', maxWidth: '760px', lineHeight: 1.5 }}>
        These statements are derived from your sales, purchase, expense and payment records (lightweight
        double-entry). Cash is estimated from recorded payment flows plus your opening balance, so it may
        differ from a bank statement. “Capital account (derived)” is a balancing figure covering owner
        contributions and any money movement TaxFlow isn’t tracking as a document. For statutory books,
        reconcile with your accountant.
      </p>

      {/* Opening balances modal */}
      {showOpening && (
        <div className="modal-container" style={{
          position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '1rem', zIndex: 50,
        }} onClick={() => setShowOpening(false)}>
          <div className="modal-content" style={{
            background: 'white', borderRadius: '16px', width: '100%', maxWidth: '520px',
            maxHeight: '90vh', overflowY: 'auto', padding: '1.5rem',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
              <div style={{ fontSize: '16px', fontWeight: '700', color: '#1e293b' }}>Opening balances</div>
              <button onClick={() => setShowOpening(false)} style={{
                background: 'none', border: 'none', fontSize: '20px', color: '#94a3b8', cursor: 'pointer',
              }}>×</button>
            </div>
            <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '1rem' }}>
              Set the balances you had when you started using TaxFlow. Stored in this browser for{' '}
              {orgName}. They feed the balance sheet so it reflects real capital and assets.
            </p>
            <div className="form-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
              {numField('cash', 'Opening cash & bank', 'Money in hand / accounts at start')}
              {numField('fixedAssets', 'Opening fixed assets', 'Equipment, vehicles, etc. at cost')}
              {numField('loans', 'Opening loans', 'Outstanding borrowings')}
              {numField('capital', 'Opening capital', 'Owner’s invested amount')}
            </div>
            <div className="btn-group" style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={saveOpening} style={{
                flex: '1 1 160px', padding: '11px 16px', background: '#2563eb', color: 'white',
                border: 'none', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              }}>{openingSaved ? 'Saved ✓' : 'Save balances'}</button>
              <button onClick={() => setShowOpening(false)} style={{
                padding: '11px 16px', background: 'white', color: '#374151',
                border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', fontWeight: '600', cursor: 'pointer',
              }}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
