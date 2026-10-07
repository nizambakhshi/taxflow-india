'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { Badge, Button, Card, EmptyState, PageHeader, SearchInput, StatCard } from '@/components/ui'
import Icon from '@/components/Icons'

interface Expense {
  id: string
  expense_date: string | null
  category: string | null
  description: string | null
  vendor_name: string | null
  bill_number: string | null
  amount: number | string | null
  gst_rate: number | string | null
  gst_amount: number | string | null
  taxable_amount: number | string | null
  itc_eligible: boolean | null
  payment_mode: string | null
  payment_status: string | null
  notes: string | null
}

const EXPENSE_CATEGORIES = [
  'Office Supplies', 'Travel & Transport', 'Meals & Entertainment',
  'Rent', 'Utilities', 'Telephone & Internet', 'Professional Fees',
  'Repairs & Maintenance', 'Advertising & Marketing', 'Software & Subscriptions',
  'Insurance', 'Bank Charges', 'Salaries', 'Printing & Stationery',
  'Courier & Postage', 'Miscellaneous'
]

const PAYMENT_MODES = ['Cash', 'Bank Transfer', 'UPI', 'Credit Card', 'Debit Card', 'Cheque']
const GST_RATES = [0, 5, 12, 18, 28]

const num = (v: number | string | null | undefined) => Number(v ?? 0) || 0
const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const paise = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const money = (v: number | string | null | undefined) => `₹${whole.format(num(v))}`
const moneyPaise = (v: number | string | null | undefined) => `₹${paise.format(num(v))}`

const emptyForm = () => ({
  expense_date: new Date().toISOString().split('T')[0],
  category: '',
  description: '',
  vendor_id: '',
  vendor_name: '',
  vendor_gstin: '',
  bill_number: '',
  amount: '',
  gst_rate: '0',
  itc_eligible: false,
  payment_mode: 'Bank Transfer',
  payment_status: 'paid',
  notes: '',
})

export default function ExpensesPage() {
  const supabase = createClient()
  const router = useRouter()

  const [expenses, setExpenses] = useState<Expense[]>([])
  const [orgId, setOrgId] = useState('')
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [vendors, setVendors] = useState<{ id: string; name: string; gstin: string | null }[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('')

  const [form, setForm] = useState(emptyForm())

  // The amount is what was paid, so GST is carved out of it rather than added to it
  const totalAmount = parseFloat(form.amount) || 0
  const gstRate = parseFloat(form.gst_rate) || 0
  const gstAmount = gstRate > 0
    ? Math.round((totalAmount - totalAmount / (1 + gstRate / 100)) * 100) / 100
    : 0
  const taxableAmount = Math.round((totalAmount - gstAmount) * 100) / 100

  async function fetchExpenses(organizationId: string) {
    const { data, error } = await supabase
      .from('expenses')
      .select('id, expense_date, category, description, vendor_name, bill_number, amount, gst_rate, gst_amount, taxable_amount, itc_eligible, payment_mode, payment_status, notes')
      .eq('organization_id', organizationId)
      .order('expense_date', { ascending: false })
    if (error) setLoadError(error.message)
    setExpenses((data as Expense[]) || [])
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

      await fetchExpenses(membership.organization_id)

      const { data: vendorData } = await supabase
        .from('vendors')
        .select('id, name, gstin')
        .eq('organization_id', membership.organization_id)
        .eq('is_active', true)
        .order('name')

      setVendors((vendorData as { id: string; name: string; gstin: string | null }[]) || [])
      setLoading(false)
    }
    load()
  }, [])

  function resetForm() {
    setForm(emptyForm())
    setError('')
  }

  function handleVendorSelect(id: string) {
    const vendor = vendors.find(v => v.id === id)
    setForm(p => ({
      ...p,
      vendor_id: id,
      vendor_name: vendor?.name || '',
      vendor_gstin: vendor?.gstin || '',
    }))
  }

  async function handleSave() {
    if (!form.category) { setError('Please select a category'); return }
    if (!form.amount || parseFloat(form.amount) <= 0) {
      setError('Please enter a valid amount')
      return
    }

    setSaving(true)
    setError('')

    try {
      const { error: expError } = await supabase
        .from('expenses')
        .insert({
          organization_id: orgId,
          expense_date: form.expense_date,
          category: form.category,
          description: form.description,
          vendor_id: form.vendor_id || null,
          vendor_name: form.vendor_name,
          vendor_gstin: form.vendor_gstin,
          bill_number: form.bill_number,
          amount: totalAmount,
          gst_rate: gstRate,
          gst_amount: gstAmount,
          taxable_amount: taxableAmount,
          itc_eligible: form.itc_eligible,
          payment_mode: form.payment_mode,
          payment_status: form.payment_status,
          notes: form.notes,
        })

      if (expError) throw expError

      await fetchExpenses(orgId)
      setShowForm(false)
      resetForm()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save expense')
    } finally {
      setSaving(false)
    }
  }

  const categories = useMemo(() => {
    const spend: Record<string, number> = {}
    for (const e of expenses) spend[e.category || 'Uncategorised'] = (spend[e.category || 'Uncategorised'] || 0) + num(e.amount)
    return Object.entries(spend).sort((a, b) => b[1] - a[1]).map(([name, total]) => ({ name, total }))
  }, [expenses])

  const summary = useMemo(() => {
    const visible = expenses.filter(e => {
      if (category && (e.category || 'Uncategorised') !== category) return false
      const q = search.trim().toLowerCase()
      if (!q) return true
      return [e.description, e.category, e.vendor_name, e.bill_number, e.notes]
        .some(f => String(f ?? '').toLowerCase().includes(q))
    })
    return {
      visible,
      spend: visible.reduce((sum, e) => sum + num(e.amount), 0),
      gst: visible.reduce((sum, e) => sum + num(e.gst_amount), 0),
      itc: visible.filter(e => e.itc_eligible).reduce((sum, e) => sum + num(e.gst_amount), 0),
      unpaid: visible.filter(e => e.payment_status !== 'paid').reduce((sum, e) => sum + num(e.amount), 0),
      filtered: visible.length !== expenses.length,
    }
  }, [expenses, category, search])

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your expenses…</div>
  }

  return (
    <div className="page-container ex" style={{ maxWidth: 1100 }}>
      <PageHeader
        eyebrow="Purchases"
        title="Expenses"
        subtitle="Running costs with their GST split, so input credit is a decision you make per bill rather than a guess at year end."
        actions={<Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add expense</Button>}
      />

      {loadError && (
        <div className="ex-alert ex-alert-red"><Icon name="alert" size={14} />{loadError}</div>
      )}

      <div className="ex-stats">
        <StatCard label="Spend" value={money(summary.spend)}
          sub={summary.filtered ? `in ${summary.visible.length} of ${expenses.length} record(s)` : `${expenses.length} record(s)`}
          icon="wallet" tone="blue" />
        <StatCard label="GST paid" value={money(summary.gst)} sub="carved out of the amounts you entered" icon="percent" tone="violet" delay={40} />
        <StatCard label="ITC claimable" value={money(summary.itc)} sub={`${expenses.filter(e => e.itc_eligible).length} bill(s) tagged eligible`} icon="check" tone="green" delay={80} />
        <StatCard label="Not yet paid" value={money(summary.unpaid)} sub="settled from your own account" icon="clock" tone="amber" delay={120} />
      </div>

      <div className="ex-toolbar">
        <SearchInput value={search} onChange={setSearch} placeholder="Description, vendor or bill number…"
          ariaLabel="Search expenses" style={{ flex: '1 1 260px', maxWidth: 360 }} />
        <select className="tf-input ex-select" value={category} onChange={e => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="">All categories</option>
          {categories.map(c => <option key={c.name} value={c.name}>{c.name} · {money(c.total)}</option>)}
        </select>
        {(category || search) && (
          <button type="button" className="ex-reset" onClick={() => { setCategory(''); setSearch('') }}>
            <Icon name="x" size={13} /> Clear filters
          </button>
        )}
      </div>

      {summary.visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={expenses.length ? 'search' : 'wallet'}
            title={expenses.length ? (search ? `Nothing matches “${search}”` : `No ${category} expenses`) : 'No expenses yet'}
            message={expenses.length
              ? 'Clear the search or pick another category to see the rest.'
              : 'Record rent, software, travel and professional fees here — each one keeps its own GST split.'}
            action={!expenses.length ? (
              <Button size="sm" icon="plus" onClick={() => { resetForm(); setShowForm(true) }}>Add expense</Button>
            ) : undefined}
          />
        </Card>
      ) : (
        <div className="table-frame">
          <div className="responsive-table">
            <div className="table-header ex-row ex-head">
              <span data-label="Date">Date</span>
              <span data-label="Category">Category</span>
              <span data-label="Description">Description</span>
              <span className="ex-right" data-label="Amount">Amount</span>
              <span className="ex-right" data-label="GST">GST / ITC</span>
              <span data-label="Payment">Payment</span>
            </div>
            {summary.visible.map(exp => (
              <div key={exp.id} className="table-row ex-row">
                <span data-label="Date" className="ex-date">{exp.expense_date ? formatDateIN(exp.expense_date) : '—'}</span>

                <span data-label="Category"><Badge tone="grey" dot={false}>{exp.category || 'Uncategorised'}</Badge></span>

                <span data-label="Description" className="ex-desc">
                  <span className="ex-desc-main">{exp.description || exp.vendor_name || '—'}</span>
                  {(exp.vendor_name && exp.description) && (
                    <span className="ex-sub">{exp.vendor_name}{exp.bill_number ? ` · bill ${exp.bill_number}` : ''}</span>
                  )}
                </span>

                <span className="ex-right" data-label="Amount"><span className="tf-num ex-amount">{money(exp.amount)}</span></span>

                <span className="ex-right" data-label="GST">
                  {num(exp.gst_amount) > 0 ? (
                    <>
                      <span className="tf-num ex-gst">{money(exp.gst_amount)}</span>
                      <div>{exp.itc_eligible
                        ? <Badge tone="green" dot={false}>ITC</Badge>
                        : <Badge tone="grey" dot={false}>No ITC</Badge>}</div>
                    </>
                  ) : <span className="ex-sub">No GST</span>}
                </span>

                <span data-label="Payment" className="ex-pay">
                  <div>{exp.payment_status === 'paid'
                    ? <Badge tone="green" dot={false}>Paid</Badge>
                    : <Badge tone="amber" dot={false}>Unpaid</Badge>}</div>
                  <span className="ex-sub">{exp.payment_mode}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {expenses.length > 0 && (
        <div className="ex-foot">
          <span>Shown: {summary.visible.length} of {expenses.length} · {money(summary.spend)}</span>
          <span>Expenses reduce profit, not GST liability — only the ITC you tag here becomes credit.</span>
        </div>
      )}

      {showForm && (
        <div className="ex-scrim" role="dialog" aria-modal="true" aria-label="Add expense">
          <div className="ex-modal">
            <div className="ex-modal-head">
              <h2>Add expense</h2>
              <button type="button" className="ex-close" onClick={() => { setShowForm(false); resetForm() }} aria-label="Close">
                <Icon name="x" size={16} />
              </button>
            </div>

            <div className="ex-grid">
              <label className="ex-field">
                <span>Date *</span>
                <input className="tf-input" type="date" value={form.expense_date}
                  onChange={e => setForm(p => ({ ...p, expense_date: e.target.value }))} />
              </label>
              <label className="ex-field">
                <span>Category *</span>
                <select className="tf-input" value={form.category} onChange={e => setForm(p => ({ ...p, category: e.target.value }))}>
                  <option value="">Select category…</option>
                  {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            </div>

            <label className="ex-field">
              <span>Description</span>
              <input className="tf-input" value={form.description} placeholder="What was this expense for?"
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))} />
            </label>

            <div className="ex-grid">
              <label className="ex-field">
                <span>Vendor (optional)</span>
                <select className="tf-input" value={form.vendor_id} onChange={e => handleVendorSelect(e.target.value)}>
                  <option value="">Select vendor…</option>
                  {vendors.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
                </select>
              </label>
              <label className="ex-field">
                <span>Bill / invoice number</span>
                <input className="tf-input" value={form.bill_number} placeholder="Vendor bill number"
                  onChange={e => setForm(p => ({ ...p, bill_number: e.target.value }))} />
              </label>
            </div>

            <div className="ex-grid">
              <label className="ex-field">
                <span>Total amount (₹) *</span>
                <input className="tf-input" type="number" value={form.amount} placeholder="0.00" min="0" step="0.01"
                  onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} />
              </label>
              <label className="ex-field">
                <span>GST rate (if applicable)</span>
                <select className="tf-input" value={form.gst_rate} onChange={e => setForm(p => ({ ...p, gst_rate: e.target.value }))}>
                  {GST_RATES.map(r => <option key={r} value={r}>{r}% {r === 0 ? '(No GST)' : ''}</option>)}
                </select>
              </label>
            </div>

            {gstAmount > 0 && (
              <div className="ex-split">
                <div><span>Taxable amount</span><span className="tf-num">{moneyPaise(taxableAmount)}</span></div>
                <div><span>GST ({form.gst_rate}%)</span><span className="tf-num">{moneyPaise(gstAmount)}</span></div>
                <div className="ex-split-total"><span>Total</span><span className="tf-num">{moneyPaise(totalAmount)}</span></div>
              </div>
            )}

            <div className="ex-grid">
              <label className="ex-field">
                <span>Payment mode</span>
                <select className="tf-input" value={form.payment_mode} onChange={e => setForm(p => ({ ...p, payment_mode: e.target.value }))}>
                  {PAYMENT_MODES.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="ex-field">
                <span>Payment status</span>
                <select className="tf-input" value={form.payment_status} onChange={e => setForm(p => ({ ...p, payment_status: e.target.value }))}>
                  <option value="paid">Paid</option>
                  <option value="unpaid">Unpaid</option>
                </select>
              </label>
            </div>

            {gstAmount > 0 && (
              <label className="ex-check">
                <input type="checkbox" checked={form.itc_eligible}
                  onChange={e => setForm(p => ({ ...p, itc_eligible: e.target.checked }))} />
                <span>ITC eligible — {moneyPaise(gstAmount)} can be claimed as input tax credit</span>
              </label>
            )}

            <label className="ex-field">
              <span>Notes</span>
              <textarea className="tf-input ex-textarea" value={form.notes} placeholder="Any additional notes…"
                onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
            </label>

            {error && <div className="ex-alert ex-alert-red"><Icon name="alert" size={14} />{error}</div>}

            <div className="ex-actions">
              <Button variant="ghost" onClick={() => { setShowForm(false); resetForm() }}>Cancel</Button>
              <Button onClick={handleSave} disabled={saving} icon={saving ? undefined : 'check'}>
                {saving ? 'Saving…' : 'Save expense'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .ex-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 1rem; }
        .ex-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .ex-alert-red { background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }

        .ex-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .ex-select { flex: 0 1 260px; }
        .ex-reset { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; color: var(--brand);
          background: none; border: none; cursor: pointer; padding: 4px 8px; border-radius: 7px; }
        .ex-reset:hover { background: var(--brand-soft); }

        .ex-row { display: grid; grid-template-columns: 92px minmax(0, 1.05fr) minmax(0, 1.5fr) 110px 112px 108px;
          gap: 12px; align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .ex-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px; font-weight: 650;
          color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .ex-right { text-align: right; }
        .ex-date { color: var(--ink-2); font-weight: 600; }
        .ex-desc { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .ex-desc-main { color: var(--ink); overflow-wrap: anywhere; }
        .ex-sub { font-size: 11px; color: var(--faint); }
        .ex-amount { font-weight: 650; color: var(--ink); }
        .ex-gst { display: block; font-weight: 650; color: var(--violet); margin-bottom: 3px; }
        .ex-pay { display: flex; flex-direction: column; gap: 3px; }

        .ex-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .ex-scrim { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.45); display: flex;
          align-items: center; justify-content: center; padding: 1rem; z-index: 100; }
        .ex-modal { background: var(--surface); border-radius: var(--radius-lg); padding: 1.4rem 1.5rem;
          width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg);
          display: flex; flex-direction: column; gap: 12px; }
        .ex-modal-head { display: flex; align-items: center; justify-content: space-between; }
        .ex-modal-head h2 { font-size: 17px; font-weight: 650; color: var(--ink); }
        .ex-close { background: none; border: none; color: var(--faint); cursor: pointer; padding: 4px; border-radius: 6px; }
        .ex-close:hover { background: var(--slate-soft); color: var(--ink-2); }
        .ex-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        .ex-field { display: flex; flex-direction: column; gap: 4px; }
        .ex-field > span { font-size: 12px; font-weight: 550; color: var(--ink-2); }
        .ex-textarea { min-height: 60px; resize: vertical; }
        .ex-split { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          padding: 10px 12px; font-size: 12.5px; color: var(--muted); display: flex; flex-direction: column; gap: 5px; }
        .ex-split div { display: flex; justify-content: space-between; gap: 10px; }
        .ex-split-total { color: var(--ink); font-weight: 650; border-top: 1px solid var(--line); padding-top: 6px; }
        .ex-check { display: flex; align-items: flex-start; gap: 8px; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
        .ex-check input { accent-color: var(--brand); margin-top: 2px; }
        .ex-actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }

        @media (max-width: 1100px) { .ex-stats { grid-template-columns: 1fr 1fr; } }
        @media (max-width: 768px) {
          .ex-row { grid-template-columns: 1fr; gap: 6px; }
          .ex-head { display: none; }
          .ex-right { text-align: left; }
          .ex-stats { grid-template-columns: 1fr 1fr; }
          .ex-grid { grid-template-columns: 1fr; }
          .ex-modal { padding: 1.1rem 1.15rem; }
          .ex-scrim { align-items: flex-end; padding: 0; }
          .ex-modal { max-width: none; border-radius: 16px 16px 0 0; max-height: 92vh; }
          .ex-actions { flex-direction: column-reverse; }
        }
      `}</style>
    </div>
  )
}
