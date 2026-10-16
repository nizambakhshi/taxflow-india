'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN, plural } from '@/lib/format'
import { Button, Card, PageHeader, Segmented, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  computeProfitLoss, computeBalanceSheet,
  loadOpeningBalances, saveOpeningBalances, currentFY,
  type OpeningBalances, type ProfitLoss, type BalanceSheet,
  type JournalSlot,
  type LedgerInvoice, type LedgerBill, type LedgerExpense, type LedgerPayment, type LedgerProduct,
} from '@/lib/ledger'
import { journalRows, loadJournal, plugProof, type JournalRow } from '@/lib/journal'

const inr0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })
const money = (v: number) => inr0.format(Number(v) || 0)

const STATEMENTS = [
  { value: 'pl', label: 'Profit & Loss' },
  { value: 'bs', label: 'Balance Sheet' },
]

const PRESETS = [
  { value: 'this_month', label: 'This Month' },
  { value: 'this_quarter', label: 'Quarter' },
  { value: 'this_fy', label: 'This FY' },
  { value: 'prev_fy', label: 'Prev FY' },
  { value: 'all', label: 'All time' },
]

const OPENING_FIELDS: { key: keyof OpeningBalances; label: string; hint: string }[] = [
  { key: 'cash', label: 'Opening cash in hand', hint: 'Notes in the drawer when the books started' },
  { key: 'bank', label: 'Opening cash at bank', hint: 'Bank balance on the day the books opened — it stays put; payments move cash' },
  { key: 'receivables', label: 'Opening receivables', hint: 'Owed to you before TaxFlow counted a rupee — a settled debt is an invoice with a number, not an opening figure' },
  { key: 'payables', label: 'Opening payables', hint: 'You owed it before the books opened' },
  { key: 'fixedAssets', label: 'Opening fixed assets', hint: 'Equipment, vehicles, etc. at cost' },
  { key: 'loans', label: 'Opening loans', hint: 'Outstanding borrowings' },
  { key: 'capital', label: 'Opening capital', hint: 'Owner’s invested amount' },
]

/** One statement line: label left, amount right, optional sign colour. */
function Line({
  label, value, minus, bold, indent, tone, tag,
}: {
  label: string
  value: number
  minus?: boolean
  bold?: boolean
  indent?: boolean
  tone?: 'profit' | 'danger'
  /** Names where the figure came from, printed beside it — judgement and paper never look alike. */
  tag?: string
}) {
  const shownAsMinus = minus || value < 0
  const cls = [
    'ac-line',
    bold ? 'ac-line-bold' : '',
    indent ? 'ac-line-indent' : '',
    tone === 'profit' ? (value >= 0 ? 'ac-pos' : 'ac-neg') : '',
    tone === 'danger' && value < 0 ? 'ac-neg' : '',
  ].filter(Boolean).join(' ')

  return (
    <div className={cls}>
      <span>
        {label}
        {tag && <em className="ac-tag">{tag}</em>}
      </span>
      <span className="ac-amt">{shownAsMinus ? '− ' : ''}{money(Math.abs(value))}</span>
    </div>
  )
}

function GroupLabel({ children }: { children: string }) {
  return <div className="ac-group">{children}</div>
}

export default function FinancialStatementsPage() {
  const supabase = createClient()
  const router = useRouter()

  const [orgId, setOrgId] = useState('')
  const [orgName, setOrgName] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState('pl')

  const [raw, setRaw] = useState<{
    invoices: LedgerInvoice[]; bills: LedgerBill[]; expenses: LedgerExpense[]
    payments: LedgerPayment[]; products: LedgerProduct[]
  }>({ invoices: [], bills: [], expenses: [], payments: [], products: [] })

  const fy = useMemo(() => currentFY(), [])
  const [start, setStart] = useState(fy.start)
  const [end, setEnd] = useState(fy.end)
  const [periodLabel, setPeriodLabel] = useState(fy.label)
  const [preset, setPreset] = useState('this_fy')

  // Opening balances modal — R3-2 grew the set: bank, receivables and payables join
  // the four originals, and `as_of` (the day the books were picked up) decides when
  // the new lines start standing. The four originals keep flowing unconditionally.
  const [opening, setOpening] = useState<OpeningBalances>(
    { cash: 0, bank: 0, receivables: 0, payables: 0, fixedAssets: 0, loans: 0, capital: 0, as_of: '' }
  )
  const [showOpening, setShowOpening] = useState(false)
  const [draftOpening, setDraftOpening] = useState<OpeningBalances>(opening)
  const [openingSaved, setOpeningSaved] = useState(false)

  // The manual journal is judgement kept on this device, so it is read here the same way the
  // opening balances are — one synchronous read once the organisation is known, then folded into
  // both derivations below. Drafts never arrive: `journalRows` hands out posted entries only.
  const [journalLines, setJournalLines] = useState<JournalRow[]>([])

  async function loadAll(oid: string) {
    const [inv, bill, exp, pay, prod] = await Promise.all([
      supabase.from('invoices').select('status, invoice_date, taxable_amount, total_tax, balance_due').eq('organization_id', oid),
      supabase.from('purchase_bills').select('status, bill_date, taxable_amount, total_tax, itc_eligible, balance_due').eq('organization_id', oid),
      supabase.from('expenses').select('expense_date, amount, gst_amount, taxable_amount, itc_eligible, payment_status, category').eq('organization_id', oid),
      supabase.from('payments').select('payment_type, amount, payment_date').eq('organization_id', oid),
      supabase.from('products').select('type, track_inventory, current_stock, purchase_price').eq('organization_id', oid),
    ])
    setRaw({
      invoices: (inv.data || []) as LedgerInvoice[],
      bills: (bill.data || []) as LedgerBill[],
      expenses: (exp.data || []) as LedgerExpense[],
      payments: (pay.data || []) as LedgerPayment[],
      products: (prod.data || []) as LedgerProduct[],
    })
  }

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
      const org = membership.organizations as { name?: string } | null
      const oid = membership.organization_id
      setOrgId(oid)
      setOrgName(org?.name || '')

      const ob = loadOpeningBalances(oid)
      setOpening(ob)
      setDraftOpening(ob)

      // The manual journal is kept on this device, not in the document tables, so its rows are read
      // straight off the register and handed to both derivations — one array, two statements, so the
      // P&L and the balance sheet cannot read different judgements.
      setJournalLines(journalRows(loadJournal(oid)))

      await loadAll(oid)
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // P&L for the selected period
  const pl: ProfitLoss = useMemo(
    () => computeProfitLoss(raw.invoices, raw.bills, raw.expenses, start, end, journalLines),
    [raw, start, end, journalLines],
  )

  // Cumulative net profit up to the period end (for retained earnings)
  const cumulativeProfit = useMemo(
    () => computeProfitLoss(raw.invoices, raw.bills, raw.expenses, '0000-01-01', end, journalLines).netProfit,
    [raw, end, journalLines],
  )

  const bs: BalanceSheet = useMemo(
    () => computeBalanceSheet({
      invoices: raw.invoices, bills: raw.bills, expenses: raw.expenses,
      payments: raw.payments, products: raw.products,
      opening, cumulativeNetProfit: cumulativeProfit, journal: journalLines,
    }, end),
    [raw, opening, cumulativeProfit, end, journalLines],
  )

  const margin = pl.revenue > 0 ? Math.round((pl.netProfit / pl.revenue) * 100) : null
  const stockLines = raw.products.filter(p => p.track_inventory && p.type === 'goods').length
  const plug = Math.abs(bs.balancingReserve)
  // The register's own arithmetic, read over the rows the balance sheet was actually given — an entry
  // dated after `end` is on the register but not on this sheet, so it is not in this proof either.
  // The claim the statements rest on, printed instead of asserted.
  const proof = plugProof(journalLines.filter(r => r.date && r.date <= end))
  /** A line the journal moved, printed beside the figure it moved, never merged into its name. */
  const ofJournal = (label: string, amount?: number) =>
    amount ? <Line label={label} value={amount} indent tag="from the journal" /> : null

  // A fold keeps only the lines it leaves changed, so a slot that netted to zero is absent rather than
  // ₹0. The assets note is gated on the asset side actually showing a journal figure — a reversed pair
  // says nothing about money, so it gets no sentence.
  const ASSET_SLOTS: JournalSlot[] = ['receivables', 'inventory', 'cash', 'bank', 'fixedAssets', 'otherAsset']
  const sideMoved = (slots: JournalSlot[]) => slots.some(s => (bs.journal.bySlot[s] ?? 0) !== 0)

  function applyPreset(key: string) {
    const now = new Date()
    const y = now.getFullYear()
    const m = now.getMonth()
    setPreset(key)
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
  const periodFrom = start === '0000-01-01' ? 'inception' : formatDateIN(start)

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Deriving your statements…</div>
  }

  return (
    <div className="page-container ac" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Money"
        title="Financial Statements"
        subtitle={`${orgName} — a profit and loss account and a balance sheet derived from your invoices, bills, expenses and payments${journalLines.length > 0 ? ', and from the manual journal postings kept on this device' : ''}. Nothing here is posted to a ledger; it is read from the documents you already entered.`}
        actions={
          <>
            <Button variant="subtle" icon="scale" onClick={() => { setDraftOpening(opening); setShowOpening(true) }}>
              Opening balances
            </Button>
            <Button variant="ghost" icon="journal" href="/journal">Journal register</Button>
          </>
        }
        right={openingSaved ? <span className="ac-saved"><Icon name="check" size={13} />Saved to this browser</span> : undefined}
      />

      <div className="ac-stats">
        <StatCard label="Revenue" value={money(pl.revenue)} sub={`excl. GST · ${periodLabel}`} icon="invoice" tone="blue" delay={0} />
        <StatCard label="Net profit" value={money(pl.netProfit)}
          sub={margin === null ? 'no revenue in this period' : `${margin}% of revenue`}
          icon="trend" tone={pl.netProfit >= 0 ? 'green' : 'red'} delay={40} />
        <StatCard label="Total assets" value={money(bs.totalAssets)}
          sub={`debtors ${money(bs.receivables)} · stock ${money(bs.inventory)}`}
          icon="box" tone="violet" delay={80} />
        <StatCard label="Unmapped money movement" value={money(plug)}
          sub={plug ? 'carried by the derived capital line' : 'opening balances explain the whole position'}
          icon="scale" tone={plug ? 'amber' : 'grey'} delay={120} />
      </div>

      <div className="ac-toolbar">
        <Segmented options={STATEMENTS} value={tab} onChange={setTab} />
        <Segmented options={PRESETS} value={preset} onChange={applyPreset} />
      </div>

      <div className="ac-range">
        <label className="ac-field">
          <span>From</span>
          <input className="tf-input" type="date" value={start === '0000-01-01' ? '' : start}
            onChange={e => { setStart(e.target.value || '0000-01-01'); setPeriodLabel('Custom'); setPreset('') }} />
        </label>
        <label className="ac-field">
          <span>To</span>
          <input className="tf-input" type="date" value={end}
            onChange={e => { setEnd(e.target.value); setPeriodLabel('Custom'); setPreset('') }} />
        </label>
        <div className="ac-range-note">
          <span>{periodLabel}</span>
          <span>{periodFrom} → {formatDateIN(end)} · figures exclude GST</span>
        </div>
      </div>

      {!hasAny && (
        <div className="ac-note">
          <Icon name="alert" size={14} />
          <span>No transactions recorded yet — both statements stay at zero until you add invoices, bills or expenses.</span>
        </div>
      )}

      {tab === 'pl' && (
        <Card className="ac-panel">
          <div className="ac-panel-title">Profit &amp; Loss Statement</div>
          <div className="ac-panel-sub">{periodLabel} · {periodFrom} → {formatDateIN(end)} · all figures excl. GST</div>

          <GroupLabel>Income</GroupLabel>
          <Line label="Sales revenue (net of tax)" value={pl.revenue} />
          {ofJournal('of which the journal stated', pl.journal.bySlot.revenue)}
          <GroupLabel>Direct costs</GroupLabel>
          <Line label="Purchases (net of tax)" value={pl.purchases} minus />
          {ofJournal('of which the journal stated', pl.journal.bySlot.purchases)}
          <Line label="Gross profit" value={pl.grossProfit} bold tone="profit" />

          <GroupLabel>Operating expenses</GroupLabel>
          {pl.expensesByCategory.length === 0 ? (
            <div className="ac-empty-line">No expenses in this period.</div>
          ) : pl.expensesByCategory.map(e => {
            const fromJournal = pl.journal.expenseLines.find(x => x.label === e.label)?.amount
            return (
              <div key={e.label}>
                <Line label={e.label} value={e.amount} indent minus tag={fromJournal === undefined ? undefined : 'partly from the journal'} />
                {ofJournal('of which the journal stated', fromJournal)}
              </div>
            )
          })}
          <Line label="Total expenses" value={pl.totalExpenses} minus />

          <div className="ac-final">
            <Line label="NET PROFIT" value={pl.netProfit} bold tone="profit" />
          </div>

          {pl.journal.entries > 0 && (
            <div className="ac-foot">
              {pl.journal.touched === 0 ? (
                <>
                  {pl.journal.entries} journal entr{pl.journal.entries === 1 ? 'y' : 'ies'} ({pl.journal.legs} legs) fold into this
                  period and answer each other — every line they name nets back to where it stood, so no figure here moved.
                  Read or write them on the <Link href="/journal">journal register</Link>.
                </>
              ) : (
                <>
                  {pl.journal.entries} journal entr{pl.journal.entries === 1 ? 'y' : 'ies'} ({pl.journal.legs} legs) moved{' '}
                  {pl.journal.touched === 1 ? 'a line' : `${pl.journal.touched} lines`} in this
                  period — they are the shop&apos;s own words, not documents, and each one balanced on the way in.
                  Read or write them on the <Link href="/journal">journal register</Link>.
                </>
              )}
            </div>
          )}
        </Card>
      )}

      {tab === 'bs' && (
        <div className="ac-cols">
          <Card className="ac-panel">
            <div className="ac-panel-title">Assets</div>
            <div className="ac-panel-sub">As on {formatDateIN(end)}{opening.as_of ? ` · books opened ${formatDateIN(opening.as_of)}` : ''}</div>
            <Line label="Sundry debtors (receivables)" value={bs.receivables} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.receivables)}
            <Line label="Inventory (stock × cost)" value={bs.inventory} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.inventory)}
            <Line label="Cash & bank (derived)" value={bs.cash} tone="danger" />
            {ofJournal('of which the journal stated', bs.journal.bySlot.cash)}
            {bs.bank > 0 && <Line label="Cash at bank (opening)" value={bs.bank} />}
            {ofJournal('of which the journal stated', bs.journal.bySlot.bank)}
            <Line label="Fixed assets" value={bs.fixedAssets} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.fixedAssets)}
            {bs.otherAssets !== 0 && <Line label="Other assets" value={bs.otherAssets} tag="from the journal" />}
            <div className="ac-final">
              <Line label="TOTAL ASSETS" value={bs.totalAssets} bold />
            </div>
            <div className="ac-foot">
              {stockLines ? `${plural(stockLines, 'stock line')} valued at purchase price.` : 'No stock tracked, so inventory is nil.'}
              {bs.openingReceivables > 0 && ' A payment grows cash but cannot reduce the opening receivable — the engine will not guess which pre-books paper it settled; a debt you have settled belongs on an invoice, not in the opening.'}
              {sideMoved(ASSET_SLOTS) && (
                <>
                  {' '}{bs.journal.entries} journal {bs.journal.entries === 1 ? 'entry has' : 'entries have'} renamed money on this side — the{' '}
                  <Link href="/journal">journal register</Link>{' holds the words behind each figure.'}
                </>
              )}
            </div>
          </Card>

          <Card className="ac-panel">
            <div className="ac-panel-title">Liabilities &amp; Owner&apos;s Funds</div>
            <div className="ac-panel-sub">As on {formatDateIN(end)}{opening.as_of ? ` · books opened ${formatDateIN(opening.as_of)}` : ''}</div>
            <Line label="Sundry creditors (payables)" value={bs.payables} />
            {bs.openingPayables > 0 && (
              <Line label="of which opened with the books" value={bs.openingPayables} indent />
            )}
            {ofJournal('of which the journal stated', bs.journal.bySlot.payables)}
            <Line label="Outstanding expenses" value={bs.outstandingExpenses} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.outstandingExpenses)}
            <Line label="GST payable" value={bs.gstLiability} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.gstLiability)}
            <Line label="Loans" value={bs.loans} />
            {ofJournal('of which the journal stated', bs.journal.bySlot.loans)}
            {bs.otherLiabilities !== 0 && <Line label="Other liabilities" value={bs.otherLiabilities} tag="from the journal" />}
            <Line label="Total liabilities" value={bs.totalLiabilities} bold />

            <GroupLabel>Owner&apos;s funds</GroupLabel>
            <Line label="Opening capital" value={bs.openingCapital} />
            <Line label="Retained earnings (cumulative profit)" value={bs.retainedEarnings} tone="danger" />
            {bs.journalCapital !== 0 && <Line label="Capital the journal stated" value={bs.journalCapital} tag="from the journal" />}
            <Line label="Capital account (derived)" value={bs.balancingReserve} tone="danger" />
            <Line label="Total owner's funds" value={bs.ownersFunds} bold />

            <div className="ac-check">
              <span>Balance check</span>
              <span className={plug ? 'ac-amber' : 'ac-pos'}>
                <Icon name={plug ? 'alert' : 'check'} size={13} />
                {plug
                  ? `Assets = Liab. + Funds, with ${money(plug)} sitting in the derived capital`
                  : 'Assets = Liab. + Funds'}
              </span>
            </div>
            {bs.journal.entries > 0 && (
              <div className="ac-foot">
                {proof.ok ? (
                  <>The {proof.entries} journal {proof.entries === 1 ? 'entry' : 'entries'} this sheet read balanced to the paisa —{' '}
                    {money(proof.debits)} on each side — so the derived capital line did not move by a rupee. A journal renames money; it does not explain it.</>
                ) : (
                  <>The register handed rows whose debits ({money(proof.debits)}) and credits ({money(proof.credits)}) differ by{' '}
                    {money(Math.abs(proof.residual))}. That difference is exactly what the derived capital line has absorbed — check the{' '}
                    <Link href="/journal">journal register</Link>.</>
                )}
              </div>
            )}
          </Card>
        </div>
      )}

      <p className="ac-foot-note">
        These statements are derived from your sales, purchase, expense and payment records (lightweight
        double-entry). Cash is estimated from recorded payment flows plus your opening balance, so it may
        differ from a bank statement. “Capital account (derived)” is a balancing figure covering owner
        contributions and any money movement TaxFlow isn’t tracking as a document. For statutory books,
        reconcile with your accountant. The balances you opened the books on — and the day you opened
        them — are edited above and kept in this browser beside the{' '}
        <Link href="/business">business register</Link>.
      </p>

      <p className="ac-foot-note">
        The statements answer how much the business made.{' '}
        <Link href="/cost-centres">Cost centres</Link> answer which part of it made that much — the same invoices,
        bills and expenses split by depot, department, project or branch. Shares live in this browser too, and no
        centre changes a figure on this page.
      </p>

      <p className="ac-foot-note">
        If the same books also live in Tally, <Link href="/tally">the Tally bridge</Link> carries them across in
        either direction: a Tally export becomes a plan of rows you pick before anything is written, and chosen
        invoices and bills become the XML TallyPrime imports — with these numbers, not in place of them.
      </p>

      {showOpening && (
        <div className="ac-scrim" role="dialog" aria-modal="true" aria-label="Opening balances"
          onClick={() => setShowOpening(false)}>
          <div className="ac-modal" onClick={e => e.stopPropagation()}>
            <div className="ac-modal-head">
              <h2>Opening balances</h2>
              <button type="button" className="ac-close" onClick={() => setShowOpening(false)} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <p className="ac-modal-sub">
              Set the balances you had when you started using TaxFlow. Stored in this browser for{' '}
              {orgName || 'this organisation'}. They feed the balance sheet so it reflects real capital and assets.
            </p>

            <div className="ac-grid">
              {OPENING_FIELDS.map(f => (
                <label key={f.key} className="ac-field">
                  <span>{f.label}</span>
                  <input className="tf-input" inputMode="decimal" placeholder="0"
                    value={draftOpening[f.key] === 0 ? '' : String(draftOpening[f.key])}
                    onChange={e => setDraftOpening(prev => ({ ...prev, [f.key]: parseFloat(e.target.value) || 0 }))} />
                  <span className="ac-hint">{f.hint}</span>
                </label>
              ))}
            </div>

            <div className="ac-grid" style={{ gridTemplateColumns: '1fr', marginTop: 12 }}>
              <label className="ac-field">
                <span>Books opened on (optional)</span>
                <input className="tf-input" type="date" value={draftOpening.as_of}
                  onChange={e => setDraftOpening(prev => ({ ...prev, as_of: e.target.value }))} />
                <span className="ac-hint">
                  The day those figures were struck. Bank, opening receivables and opening payables stand only
                  on a balance sheet drawn on or after it; empty means they always stand. The four original
                  lines (cash in hand, fixed assets, loans, capital) keep flowing as they always did.
                </span>
              </label>
            </div>

            <div className="ac-modal-foot">
              <Button variant="ghost" onClick={() => setShowOpening(false)}>Close</Button>
              <Button icon="check" onClick={saveOpening}>Save balances</Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .ac { display: flex; flex-direction: column; }
        .ac-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ac-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .ac-saved { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600;
          color: var(--green); background: var(--green-soft); border-radius: 99px; padding: 5px 10px; }

        .ac-range { display: grid; grid-template-columns: 200px 200px minmax(0, 1fr); gap: 12px;
          align-items: end; margin-bottom: 1rem; }
        .ac-range-note { display: flex; flex-direction: column; gap: 2px; font-size: 11.5px; color: var(--faint);
          padding-bottom: 4px; }
        .ac-range-note > span:first-child { font-size: 12.5px; font-weight: 650; color: var(--ink-2); }
        .ac-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .ac-field > span:first-child { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ac-hint { font-size: 10.5px; color: var(--faint); }

        .ac-note { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--ink-2);
          background: var(--amber-soft); border-left: 3px solid var(--amber); border-radius: var(--radius-sm);
          padding: 10px 12px; margin-bottom: 1rem; }
        .ac-note svg { color: var(--amber); flex-shrink: 0; margin-top: 1px; }

        .ac-panel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius);
          padding: 1.25rem 1.35rem; max-width: 640px; }
        .ac-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        .ac-cols .ac-panel { max-width: none; }
        .ac-panel-title { font-size: 15px; font-weight: 700; color: var(--ink); }
        .ac-panel-sub { font-size: 11.5px; color: var(--muted); margin: 2px 0 12px; }

        .ac-line { display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
          padding: 7px 0; font-size: 13px; font-weight: 500; color: var(--muted);
          border-top: 1px solid var(--line-soft); }
        .ac-line:first-of-type { border-top: none; }
        .ac-line-bold { padding: 10px 0; font-size: 14px; font-weight: 700; color: var(--ink);
          border-top: 1px solid var(--line); }
        .ac-line-indent > span:first-child { padding-left: 12px; }
        /* Names the source of a figure — a journal line never reads like a document line. */
        .ac-tag { display: inline-block; margin-left: 7px; padding: 1px 6px; border: 1px solid var(--line);
          border-radius: 999px; background: var(--surface-2); font-style: normal; font-size: 10px;
          font-weight: 600; letter-spacing: 0.02em; color: var(--faint); white-space: nowrap;
          vertical-align: 1px; }
        .ac-amt { font-variant-numeric: tabular-nums; white-space: nowrap; }
        .ac-pos { color: var(--green); }
        .ac-neg { color: var(--red); }
        .ac-amber { color: var(--amber); }
        .ac-group { font-size: 11px; font-weight: 700; color: var(--faint); text-transform: uppercase;
          letter-spacing: 0.05em; margin: 14px 0 2px; }
        .ac-empty-line { font-size: 12px; color: var(--faint); padding: 4px 0; }
        .ac-final { margin-top: 14px; }
        .ac-foot { font-size: 11px; color: var(--faint); margin-top: 10px; }
        .ac-check { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px;
          margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 12.5px;
          font-weight: 650; color: var(--ink); }
        .ac-check span:last-child { display: inline-flex; align-items: center; gap: 5px; text-align: right;
          font-weight: 600; font-size: 11.5px; }
        .ac-foot-note { font-size: 11px; color: var(--faint); margin-top: 1.25rem; max-width: 760px; line-height: 1.6; }

        .ac-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .ac-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 520px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); }
        .ac-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .ac-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .ac-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .ac-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .ac-modal-sub { font-size: 12px; color: var(--muted); margin-bottom: 14px; }
        .ac-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .ac-modal-foot { display: flex; gap: 10px; justify-content: flex-end; margin-top: 16px; }

        @media (max-width: 1100px) { .ac-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .ac-stats { grid-template-columns: 1fr 1fr; }
          .ac-cols { grid-template-columns: 1fr; }
          .ac-range { grid-template-columns: 1fr 1fr; }
          .ac-range-note { grid-column: 1 / -1; }
          .ac-grid { grid-template-columns: 1fr; }
          .ac-modal { padding: 1.1rem 1.15rem; }
          .ac-scrim { align-items: flex-end; padding: 0; }
          .ac-modal { max-width: none; border-radius: var(--radius-lg) var(--radius-lg) 0 0; }
        }
      `}</style>
    </div>
  )
}
