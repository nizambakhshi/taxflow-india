'use client'

/* Bank statement import and receipt matching — R2-10.
 *
 * The statement is read in the tab and matched against open documents and
 * payments already recorded. Confirming a line is a decision on this workpaper;
 * the money itself is still recorded on the Payments page, which stays the only
 * write path into the ledger. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatDateIN } from '@/lib/format'
import { toCsv } from '@/lib/registers'
import { download } from '@/lib/party-ledger'
import {
  MATCH_CSV_HEADERS, SAMPLE_STATEMENT, addStatement, advisory, allTxns, buildRows, clearDecisions,
  dropStatement, emptyBank, loadBank, matchCsvRows, parseStatement, saveBank, setDecision, summarise,
  type BankState, type Books, type Candidate, type MatchRow, type Statement,
} from '@/lib/bank-statement'
import {
  Badge, Button, Card, EmptyState, PageHeader, ProgressBar, SearchInput,
  SectionTitle, Segmented, StatCard,
} from '@/components/ui'
import Icon from '@/components/Icons'

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const money = (n: number) => `₹${inr.format(Number(n) || 0)}`

type View = 'review' | 'import' | 'history'

const FILTERS = [
  { value: 'review', label: 'Needs review' },
  { value: 'suggested', label: 'Suggested' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'books', label: 'Already in books' },
  { value: 'ignored', label: 'Ignored' },
  { value: 'credit', label: 'Money in' },
  { value: 'debit', label: 'Money out' },
  { value: 'all', label: 'All lines' },
]

const TIER_TONE = { exact: 'green', likely: 'blue', possible: 'amber' } as const
const TIER_BAR = { exact: 'var(--green)', likely: 'var(--brand)', possible: 'var(--amber)' } as const

interface InvoiceRow { id: string; invoice_number: string; customer_name: string; invoice_date: string; grand_total: number; balance_due: number }
interface BillRow { id: string; bill_number: string; vendor_name: string; bill_date: string; grand_total: number; balance_due: number }
interface PaymentRow {
  id: string; payment_date: string; payment_type: string; amount: number
  reference_number: string | null; party_name: string | null; invoice_id: string | null; bill_id: string | null
}

export default function BankMatchingPage() {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const fileRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')

  const [books, setBooks] = useState<Books>({ docs: [], payments: [] })
  const [bank, setBank] = useState<BankState>(emptyBank())
  const [savedAt, setSavedAt] = useState('')
  const [tolerance, setTolerance] = useState(1)

  const [view, setView] = useState<View>('review')
  const [filter, setFilter] = useState('review')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [importError, setImportError] = useState('')

  useEffect(() => {
    async function boot() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      const { data: membership } = await supabase
        .from('org_members').select('organization_id')
        .eq('user_id', user.id).eq('is_active', true).single()
      if (!membership) { router.push('/setup'); return }

      const oid = membership.organization_id
      setOrgId(oid)
      setBank(loadBank(oid))
      await loadBooks(oid)
      setLoading(false)
    }
    boot()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** What a bank line can be matched to: what is still owed, and what has already
   *  been recorded. Recorded payments are pulled for the last four months only. */
  async function loadBooks(oid: string) {
    const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10)
    const [invRes, billRes, payRes] = await Promise.all([
      supabase.from('invoices')
        .select('id, invoice_number, customer_name, invoice_date, grand_total, balance_due')
        .eq('organization_id', oid).in('payment_status', ['unpaid', 'partial']).neq('status', 'cancelled')
        .order('invoice_date', { ascending: false }).limit(3000),
      supabase.from('purchase_bills')
        .select('id, bill_number, vendor_name, bill_date, grand_total, balance_due')
        .eq('organization_id', oid).in('payment_status', ['unpaid', 'partial']).neq('status', 'cancelled')
        .order('bill_date', { ascending: false }).limit(3000),
      supabase.from('payments')
        .select('id, payment_date, payment_type, amount, reference_number, party_name, invoice_id, bill_id')
        .eq('organization_id', oid).gte('payment_date', from)
        .order('payment_date', { ascending: false }).limit(2000),
    ])

    setError(invRes.error || billRes.error ? 'Could not read the open documents.' : '')

    const docs = [
      ...((invRes.data || []) as InvoiceRow[]).map(r => ({
        id: r.id, kind: 'invoice' as const, number: r.invoice_number, party: r.customer_name || '',
        date: r.invoice_date, total: Number(r.grand_total) || 0, due: Number(r.balance_due) || 0,
      })),
      ...((billRes.data || []) as BillRow[]).map(r => ({
        id: r.id, kind: 'bill' as const, number: r.bill_number, party: r.vendor_name || '',
        date: r.bill_date, total: Number(r.grand_total) || 0, due: Number(r.balance_due) || 0,
      })),
    ]
    const numberById = new Map(docs.map(d => [d.id, d.number]))

    const payments = ((payRes.data || []) as PaymentRow[]).map(p => ({
      id: p.id,
      ref: p.reference_number || '',
      party: p.party_name || '',
      date: p.payment_date,
      amount: Number(p.amount) || 0,
      type: p.payment_type === 'made' ? ('made' as const) : ('received' as const),
      docNumber: numberById.get(p.invoice_id || '') || numberById.get(p.bill_id || '') || '',
      docId: p.invoice_id || p.bill_id || null,
    }))

    setBooks({ docs, payments })
  }

  const commit = useCallback((next: BankState) => {
    setBank(next)
    if (orgId) {
      const stamped = saveBank(orgId, next)
      setSavedAt(new Date(stamped.updatedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))
    }
  }, [orgId])

  const txns = useMemo(() => allTxns(bank), [bank])
  const rows = useMemo(() => buildRows(txns, books, bank.decisions, { tolerance }), [txns, books, bank.decisions, tolerance])
  const summary = useMemo(() => summarise(rows), [rows])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows
      .filter(r => {
        if (filter === 'credit' && r.txn.direction !== 'credit') return false
        if (filter === 'debit' && r.txn.direction !== 'debit') return false
        if (filter === 'books' && r.chosen?.kind !== 'payment') return false
        if (['review', 'suggested', 'confirmed', 'ignored'].includes(filter) && r.status !== filter) return false
        if (q) {
          const hay = `${r.txn.date} ${r.txn.narration} ${r.txn.reference} ${r.chosen?.number || ''} ${r.chosen?.party || ''}`.toLowerCase()
          if (!hay.includes(q)) return false
        }
        return true
      })
      .sort((a, b) => b.txn.date.localeCompare(a.txn.date))
  }, [rows, filter, query])

  /* ── actions ── */

  function importText(text: string, source: 'paste' | 'file', fileName = '') {
    setImportError('')
    setFlash('')
    let parsed
    try {
      parsed = parseStatement(text)
    } catch (e) {
      setImportError((e as Error).message)
      return
    }
    const statement: Statement = {
      id: crypto.randomUUID(),
      name: fileName || `Statement ${parsed.from.slice(0, 7)}`,
      fileName,
      source,
      importedAt: new Date().toISOString(),
      from: parsed.from,
      to: parsed.to,
      delimiter: parsed.delimiter,
      columns: parsed.columns,
      closingBalance: parsed.closingBalance,
      txns: parsed.txns,
    }
    commit(addStatement(bank, statement))
    setDraft('')
    setView('review')
    setFilter('review')
    setFlash(
      `${parsed.txns.length} line(s) read from ${formatDateIN(parsed.from)} to ${formatDateIN(parsed.to)}`
      + (parsed.issues.length ? ` · ${parsed.issues.length} note(s) from the parser` : '.'),
    )
  }

  async function handleFile(file: File | undefined) {
    if (!file) return
    importText(await file.text(), 'file', file.name)
    if (fileRef.current) fileRef.current.value = ''
  }

  function confirm(row: MatchRow, candidate?: Candidate) {
    const chosen = candidate || row.candidates[0]
    if (!chosen) return
    commit(setDecision(bank, row.txn.id, { status: 'confirmed', at: new Date().toISOString(), candidate: chosen }))
  }

  function ignore(row: MatchRow) {
    commit(setDecision(bank, row.txn.id, { status: 'ignored', at: new Date().toISOString() }))
  }

  function undo(row: MatchRow) {
    commit(setDecision(bank, row.txn.id, null))
  }

  function exportMatches() {
    download(`bank-matching-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(MATCH_CSV_HEADERS, matchCsvRows(rows)))
  }

  function documentLink(c: Candidate): string | null {
    if (c.kind === 'invoice') return `/invoices/${c.docId}`
    if (c.kind === 'bill') return `/bills?q=${encodeURIComponent(c.number)}`
    return c.docId ? `/invoices/${c.docId}` : '/payments'
  }

  if (loading) {
    return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading your bank workbench…</div>
  }

  return (
    <div className="page-container bm">
      <PageHeader
        eyebrow="Money in, money out"
        title="Bank statement matching"
        subtitle={
          <>
            Read a statement, and every line is pointed at the invoice, bill or recorded payment it
            looks like. Nothing is posted here — you confirm, then record on the Payments page.
          </>
        }
        actions={
          <>
            <Button variant="subtle" size="sm" icon="download" onClick={exportMatches} disabled={!rows.length}>
              Export matches
            </Button>
            <Button variant={view === 'import' ? 'primary' : 'ghost'} size="sm" icon="upload"
              onClick={() => setView(view === 'import' ? 'review' : 'import')}>
              {view === 'import' ? 'Close import' : 'Import statement'}
            </Button>
          </>
        }
      />

      {error && <div className="bm-alert bm-alert-red"><Icon name="alert" size={14} />{error}</div>}
      {flash && <div className="bm-alert bm-alert-green"><Icon name="check" size={14} />{flash}</div>}

      <div className="bm-stats">
        <StatCard label="Lines read" value={String(summary.rows)} sub={`${bank.statements.length} statement(s) loaded`} icon="book" tone="blue" />
        <StatCard label="Explained" value={money(summary.matchedValue)} sub={`${summary.confirmed + summary.suggested} of ${summary.rows} line(s)`} icon="check" tone="green" />
        <StatCard label="Needs your eye" value={money(summary.reviewValue)} sub={`${summary.review} line(s) unexplained`} icon="alert" tone="amber" />
        <StatCard label="Already in books" value={String(summary.inBooks)} sub="receipts you had already recorded" icon="compare" tone="cyan" />
      </div>

      <div className="bm-scope">
        <span className="tf-num">{books.docs.length}</span> open documents and{' '}
        <span className="tf-num">{books.payments.length}</span> recorded payments from the last four months are in scope.
        <button type="button" className="bm-refresh" onClick={() => loadBooks(orgId)}>
          <Icon name="swap" size={12} /> Re-read the books
        </button>
      </div>

      {view === 'import' && (
        <Card className="bm-import">
          <SectionTitle icon="upload">Load a statement</SectionTitle>
          <div className="bm-import-grid">
            <div>
              <p className="bm-help">
                Paste the rows from a bank CSV, an Excel export saved as text, or a downloaded statement
                file. The parser looks for a header row itself, so a preamble of account details above it
                is fine. Delimiters tried: comma, tab, semicolon, pipe.
              </p>
              <textarea
                className="bm-textarea"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                spellCheck={false}
                placeholder={'Date,Narration,Ref No.,Withdrawal Amt.,Deposit Amt.,Balance\n01-04-2026,"NEFT SHREYA TRADERS",123,,145600,945600'}
                aria-label="Statement text"
              />
              <div className="bm-import-actions">
                <Button size="sm" icon="file-check" onClick={() => importText(draft, 'paste')} disabled={!draft.trim()}>
                  Read {draft.trim() ? `${draft.trim().split(/\r?\n/).length - 1}+ lines` : 'the statement'}
                </Button>
                <Button size="sm" variant="subtle" icon="upload" onClick={() => fileRef.current?.click()}>
                  Choose a file
                </Button>
                <Button size="sm" variant="ghost" icon="zap" onClick={() => setDraft(SAMPLE_STATEMENT)}>
                  Fill with a sample
                </Button>
                <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" hidden aria-hidden
                  onChange={e => handleFile(e.target.files?.[0])} />
              </div>
              {importError && <div className="bm-alert bm-alert-red"><Icon name="alert" size={14} />{importError}</div>}
            </div>

            <div className="bm-shape">
              <div className="bm-shape-title">What the parser reads</div>
              <ul className="bm-points">
                <li><strong>Header row</strong> found by column names, not position — Date, Narration, Particulars, Chq/Ref No., UTR, Withdrawal, Deposit, Amount, Balance.</li>
                <li><strong>Split Dr./Cr. columns</strong>, one signed amount column, an amount with a trailing <em>Dr</em>/<em>Cr</em>, or an unsigned amount whose direction is read off the running balance.</li>
                <li><strong>Indian money</strong> — <em>₹1,20,000.50</em>, <em>Rs. 4,500/-</em>, <em>(1,200.00)</em>, and the trailing dash a bank uses for negative.</li>
                <li><strong>Indian dates</strong> — <em>01-04-2026</em>, <em>1-Jan-26</em>, <em>2026-04-01 11:23</em>, and spreadsheet day numbers.</li>
                <li><strong>Descriptions with commas</strong> stay one line instead of shifting every column after them.</li>
                <li><strong>Same UTR twice</strong> is one receipt, not two. Two identical bare lines are two receipts.</li>
              </ul>
              <div className="bm-shape-title">What it will not do</div>
              <p className="bm-help">
                It will not post anything, and it will not guess silently. A line with nothing to say for
                itself is left for you with the advice it does have — GST challan, bank charge, salary,
                interest, a transfer.
              </p>
            </div>
          </div>
        </Card>
      )}

      {view !== 'import' && (
        <>
          <div className="bm-toolbar">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={FILTERS.map(f => ({
                value: f.value,
                label: f.value === 'all' ? `All ${summary.rows}`
                  : f.value === 'credit' ? `In ${summary.credits}`
                    : f.value === 'debit' ? `Out ${summary.debits}`
                      : f.value === 'books' ? `In books ${summary.inBooks}`
                        : `${f.label.split(' ')[0]} ${f.value === 'review' ? summary.review : f.value === 'suggested' ? summary.suggested : f.value === 'confirmed' ? summary.confirmed : summary.ignored}`,
              }))}
            />
            <SearchInput value={query} onChange={setQuery} ariaLabel="Search statement lines"
              placeholder="Narration, UTR, document…" style={{ minWidth: 180, flex: 1, maxWidth: 320 }} />
            <label className="bm-tol">
              <span>Amount tolerance</span>
              <input
                type="number" min={0} max={100} step={1} value={tolerance}
                onChange={e => setTolerance(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                aria-label="Amount tolerance in rupees"
              />
              <span>₹</span>
            </label>
          </div>

          {!txns.length ? (
            <Card>
              <EmptyState
                icon="landmark"
                title="No statement loaded"
                message="Paste rows from a bank statement or drop in the CSV your bank exported. Matching runs the moment it is read."
                action={<Button size="sm" icon="upload" onClick={() => setView('import')}>Load a statement</Button>}
              />
            </Card>
          ) : !visible.length ? (
            <Card><EmptyState icon="search" title="Nothing in this slice" message="No line matches this filter and search together." /></Card>
          ) : (
            <div className="table-frame">
              <div className="responsive-table">
                <div className="table-header bm-row bm-head">
                  <span data-label="Date">Date</span>
                  <span data-label="Line">Statement line</span>
                  <span data-label="Money in" className="bm-right">Money in</span>
                  <span data-label="Money out" className="bm-right">Money out</span>
                  <span data-label="Match">Matched against</span>
                  <span data-label="Action" className="bm-right">Action</span>
                </div>
                {visible.map(row => {
                  const c = row.chosen
                  const href = c ? documentLink(c) : null
                  return (
                    <div key={row.txn.id} className={`table-row bm-row ${row.status === 'ignored' ? 'bm-dim' : ''}`}>
                      <span data-label="Date" className="bm-date">
                        {row.txn.date ? formatDateIN(row.txn.date) : '—'}
                        {row.txn.balance !== null && <em className="bm-bal">bal {money(row.txn.balance)}</em>}
                      </span>

                      <span data-label="Line" className="bm-line">
                        <span className="bm-narr">{row.txn.narration || <em className="bm-faint">no narration</em>}</span>
                        {row.txn.reference && <span className="bm-ref">{row.txn.reference}</span>}
                      </span>

                      <span data-label="Money in" className="bm-right tf-num bm-in">
                        {row.txn.direction === 'credit' ? money(row.txn.amount) : ''}
                      </span>
                      <span data-label="Money out" className="bm-right tf-num bm-out">
                        {row.txn.direction === 'debit' ? money(row.txn.amount) : ''}
                      </span>

                      <span data-label="Match" className="bm-match">
                        {c ? (
                          <>
                            <span className="bm-match-row">
                              <Badge tone={c.kind === 'payment' ? 'cyan' : TIER_TONE[c.tier]} dot={false}>
                                {c.kind === 'payment' ? 'in your books' : c.tier}
                              </Badge>
                              <span className="bm-doc">{c.number || (c.kind === 'payment' ? 'recorded payment' : 'unnamed')}</span>
                              <span className="bm-party">{c.party}</span>
                            </span>
                            <ProgressBar value={c.score} color={TIER_BAR[c.tier]} height={5} />
                            <span className="bm-why">{c.reasons.join(' · ') || `scored ${c.score} of 100`}</span>
                            {row.candidates.length > 1 && row.status !== 'confirmed' && (
                              <span className="bm-alts">
                                <span className="bm-alts-label">or</span>
                                {row.candidates.slice(1).map(alt => (
                                  <button key={`${alt.docId}-${alt.score}`} type="button" className="bm-alt"
                                    onClick={() => confirm(row, alt)} title={alt.reasons.join(' · ')}>
                                    {alt.number} · {alt.score}
                                  </button>
                                ))}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="bm-advice">
                            <Icon name="alert" size={12} />
                            {row.status === 'ignored' ? 'Set aside' : advisory(row.txn)}
                          </span>
                        )}
                      </span>

                      <span data-label="Action" className="bm-actions">
                        {row.status === 'confirmed' ? (
                          <>
                            <Badge tone="green" dot={false}>confirmed</Badge>
                            <button type="button" className="bm-link" onClick={() => undo(row)}>Undo</button>
                          </>
                        ) : row.status === 'ignored' ? (
                          <button type="button" className="bm-link" onClick={() => undo(row)}>Restore</button>
                        ) : (
                          <>
                            {c && <Button size="sm" icon="check" onClick={() => confirm(row)}>Confirm</Button>}
                            <button type="button" className="bm-link" onClick={() => ignore(row)}>Set aside</button>
                          </>
                        )}
                        {href && c && <Link className="bm-link" href={href}>Open</Link>}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {!!rows.length && (
            <div className="bm-foot">
              <span>
                {summary.confirmed} confirmed · {summary.suggested} suggested · {summary.review} for review ·{' '}
                {summary.ignored} set aside
              </span>
              <span>{savedAt ? `saved ${savedAt}` : 'decisions live in this browser'}</span>
            </div>
          )}
        </>
      )}

      {view === 'history' && (
        <Card>
          <SectionTitle icon="clock" action={
            bank.statements.length ? (
              <Button size="sm" variant="ghost" icon="x" onClick={() => commit(clearDecisions(bank))}>Clear all decisions</Button>
            ) : undefined
          }>
            Loaded statements
          </SectionTitle>
          {!bank.statements.length ? (
            <EmptyState icon="book" title="Nothing loaded yet" message="Statements you read stay in this browser, keyed to your organisation." />
          ) : (
            <div className="bm-history">
              {bank.statements.map(s => (
                <div key={s.id} className="bm-hist">
                  <div className="bm-hist-main">
                    <span className="bm-hist-name">{s.name}</span>
                    <span className="bm-hist-sub">
                      {formatDateIN(s.from)} – {formatDateIN(s.to)} · {s.txns.length} line(s) ·{' '}
                      {s.source === 'file' ? 'file' : 'pasted'} · delimiter <code className="bm-code">{s.delimiter === '\t' ? 'tab' : s.delimiter}</code>
                    </span>
                    <span className="bm-cols">
                      {s.columns.map((col, i) => <span key={`${col}-${i}`} className="bm-chip">{col || '—'}</span>)}
                    </span>
                  </div>
                  <div className="bm-hist-side">
                    {s.closingBalance !== null && <span className="bm-hist-bal">{money(s.closingBalance)}</span>}
                    <button type="button" className="bm-link bm-danger" onClick={() => commit(dropStatement(bank, s.id))}>Remove</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {view === 'review' && !!txns.length && (
        <Card className="bm-how">
          <SectionTitle icon="scale">How a line is scored</SectionTitle>
          <div className="bm-how-grid">
            <div>
              <p className="bm-help">
                Every line gets up to 100 points: <strong>amount 40</strong> against the balance due or the
                document total, <strong>document number 30</strong> when the narration carries it,{' '}
                <strong>party 18</strong> when the narration names the customer or vendor,{' '}
                <strong>date 12</strong> for how close it sits to the document. A reference that matches a
                payment you already recorded is reported as <em>in your books</em> instead.
              </p>
              <p className="bm-help">
                80 and above is <Badge tone="green" dot={false}>exact</Badge>, 58 and above is{' '}
                <Badge tone="blue" dot={false}>likely</Badge>, below that the line waits for you.
              </p>
            </div>
            <div className="bm-how-side">
              <div className="bm-note">
                <Icon name="alert" size={13} />
                <span>
                  Matching is advice, not a posting. Confirm what you agree with, then{' '}
                  <Link href="/payments">record it on the Payments page</Link> — that is where the ledger is written.
                </span>
              </div>
              <Button size="sm" variant="subtle" icon="clock" onClick={() => setView('history')}>
                Statement history
              </Button>
            </div>
          </div>
        </Card>
      )}

      <style>{`
        .bm-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 0.85rem; }
        .bm-scope { font-size: 12px; color: var(--muted); margin-bottom: 1rem; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .bm-refresh { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 11.5px; color: var(--brand);
          background: none; border: none; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
        .bm-refresh:hover { background: var(--brand-soft); }

        .bm-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px; border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
        .bm-alert-red { background: var(--red-soft); color: var(--red); border-left: 3px solid var(--red); }
        .bm-alert-green { background: var(--green-soft); color: var(--green); border-left: 3px solid var(--green); }

        .bm-import { margin-bottom: 1rem; }
        .bm-import-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 22px; }
        .bm-textarea { width: 100%; min-height: 168px; margin-top: 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11.5px; line-height: 1.5; color: var(--ink); background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius-sm); padding: 10px 11px; outline: none; resize: vertical; }
        .bm-textarea:focus { border-color: var(--brand); box-shadow: 0 0 0 3px var(--brand-ring); background: var(--surface); }
        .bm-import-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
        .bm-shape-title { font-size: 11px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--faint); margin: 0 0 8px; }
        .bm-points { margin: 0 0 14px; padding-left: 16px; display: flex; flex-direction: column; gap: 7px; }
        .bm-points li { font-size: 12px; color: var(--muted); line-height: 1.55; }
        .bm-points strong { color: var(--ink-2); font-weight: 650; }
        .bm-help { font-size: 12px; color: var(--muted); line-height: 1.6; margin: 0 0 10px; }

        .bm-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
        .bm-tol { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--muted); }
        .bm-tol input { width: 54px; font: inherit; font-size: 12px; text-align: right; color: var(--ink); background: var(--surface);
          border: 1px solid var(--line); border-radius: 7px; padding: 5px 7px; }

        .bm-row { display: grid; grid-template-columns: 92px minmax(0, 1.5fr) 88px 88px minmax(0, 1.35fr) 132px; gap: 12px;
          align-items: center; padding: 11px 14px; font-size: 12.5px; }
        .bm-head { background: var(--surface-2); border-bottom: 1px solid var(--line-soft); font-size: 11px; font-weight: 650;
          color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .bm-right { text-align: right; }
        .bm-date { color: var(--ink-2); font-weight: 600; display: flex; flex-direction: column; gap: 2px; }
        .bm-bal { font-style: normal; font-size: 10.5px; color: var(--faint); font-weight: 500; }
        .bm-line { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
        .bm-narr { color: var(--ink); overflow-wrap: anywhere; }
        .bm-ref { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--faint); }
        .bm-faint { color: var(--faint); }
        .bm-in { color: var(--green); font-weight: 650; }
        .bm-out { color: var(--red); font-weight: 650; }
        .bm-match { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .bm-match-row { display: flex; align-items: center; gap: 7px; min-width: 0; flex-wrap: wrap; }
        .bm-doc { font-weight: 650; color: var(--ink); }
        .bm-party { font-size: 11.5px; color: var(--muted); overflow-wrap: anywhere; }
        .bm-why { font-size: 11px; color: var(--faint); line-height: 1.45; }
        .bm-advice { display: inline-flex; align-items: flex-start; gap: 6px; font-size: 11.5px; color: var(--amber); line-height: 1.45; }
        .bm-alts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .bm-alts-label { font-size: 10.5px; color: var(--faint); text-transform: uppercase; letter-spacing: 0.05em; }
        .bm-alt { font: inherit; font-size: 11px; color: var(--brand); background: var(--brand-soft); border: 1px solid transparent;
          border-radius: 99px; padding: 2px 9px; cursor: pointer; }
        .bm-alt:hover { border-color: var(--brand); }
        .bm-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .bm-link { font: inherit; font-size: 11.5px; color: var(--brand); background: none; border: none; cursor: pointer;
          text-decoration: none; padding: 0; }
        .bm-link:hover { text-decoration: underline; }
        .bm-danger { color: var(--red); }
        .bm-dim { opacity: 0.55; }

        .bm-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; font-size: 11.5px;
          color: var(--faint); margin-top: 10px; }

        .bm-history { display: flex; flex-direction: column; gap: 10px; }
        .bm-hist { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; align-items: center;
          border: 1px solid var(--line-soft); border-radius: 10px; padding: 11px 13px; background: var(--surface-2); }
        .bm-hist-main { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
        .bm-hist-name { font-size: 13px; font-weight: 650; color: var(--ink); }
        .bm-hist-sub { font-size: 11.5px; color: var(--muted); }
        .bm-hist-bal { font-size: 12.5px; font-weight: 650; color: var(--ink-2); }
        .bm-hist-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        .bm-cols { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
        .bm-chip { font-size: 10.5px; color: var(--muted); background: var(--surface); border: 1px solid var(--line);
          border-radius: 99px; padding: 1px 8px; }
        .bm-code { font-family: ui-monospace, Menlo, monospace; background: var(--slate-soft); border-radius: 4px; padding: 0 4px; }

        .bm-how { margin-top: 1rem; }
        .bm-how-grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 20px; align-items: start; }
        .bm-how-side { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
        .bm-note { display: flex; gap: 9px; font-size: 12px; color: var(--ink-2); line-height: 1.55;
          background: var(--amber-soft); border-left: 3px solid var(--amber); border-radius: 10px; padding: 11px 13px; }
        .bm-note a { color: var(--brand); }

        @media (max-width: 1100px) {
          .bm-stats { grid-template-columns: 1fr 1fr; }
          .bm-import-grid, .bm-how-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 768px) {
          .bm-row { grid-template-columns: 1fr; gap: 8px; }
          .bm-head { display: none; }
          .bm-right { text-align: left; }
          .bm-actions { flex-direction: row; align-items: center; justify-content: space-between; width: 100%; }
          .bm-hist { grid-template-columns: 1fr; }
          .bm-hist-side { flex-direction: row; align-items: center; justify-content: space-between; width: 100%; }
          .bm-textarea { min-height: 140px; }
        }
      `}</style>
    </div>
  )
}
