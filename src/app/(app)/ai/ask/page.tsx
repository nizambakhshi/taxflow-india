'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import { Badge, Button, Card, PageHeader, ProgressBar } from '@/components/ui'
import Icon from '@/components/Icons'
import {
  answerQuestion,
  SUGGESTED_QUESTIONS,
  type AskAnswer,
  type AskDataset,
} from '@/lib/ask'
import { journalRows, loadJournal } from '@/lib/journal'

// Supabase returns at most 1000 rows per call, so walk pages up to a cap. The
// cap keeps the browser responsive on a busy book and the engine is told when
// figures may therefore be short.
const PAGE = 1000
const CAP = 4000

async function fetchAll(
  supabase: any,
  table: string,
  orgId: string,
  select: string,
  order: string,
  fallback?: string,
): Promise<{ rows: any[]; truncated: boolean }> {
  const rows: any[] = []
  for (let from = 0; from < CAP; from += PAGE) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq('organization_id', orgId)
      .order(order, { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      // An embed the schema does not expose should cost line-level detail, not the answer.
      if (fallback) return fetchAll(supabase, table, orgId, fallback, order)
      throw error
    }
    const page = data || []
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return { rows, truncated: rows.length >= CAP }
}

function changeOf(cmp: { current: number; previous: number }): { text: string; color: string } | null {
  if (cmp.previous === 0) return cmp.current === 0 ? null : { text: 'new in this period', color: 'var(--brand)' }
  const pct = ((cmp.current - cmp.previous) / Math.abs(cmp.previous)) * 100
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs previous period`, color: pct >= 0 ? 'var(--green)' : 'var(--red)' }
}

function money(n: number): string {
  return `₹${formatINR(Math.round(n * 100) / 100)}`
}

export default function AskMyBooksPage() {
  const supabase = createClient()
  const router = useRouter()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<AskDataset>({ invoices: [], bills: [], expenses: [], payments: [] })
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [history, setHistory] = useState<string[]>([])

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .maybeSingle()

      if (!membership?.organization_id) { router.push('/setup'); return }
      const oid = membership.organization_id

      try {
        const [inv, bills, exp, pay] = await Promise.all([
          fetchAll(supabase, 'invoices', oid, '*, invoice_items(*)', 'invoice_date', '*'),
          fetchAll(supabase, 'purchase_bills', oid, '*, purchase_bill_items(*)', 'bill_date', '*'),
          fetchAll(supabase, 'expenses', oid, '*', 'expense_date'),
          fetchAll(supabase, 'payments', oid, '*', 'payment_date'),
        ])
        setData({
          invoices: inv.rows,
          bills: bills.rows,
          expenses: exp.rows,
          payments: pay.rows,
          // The register this device keeps, read exactly the way /accounting reads it: one array of
          // posted legs, so a spoken answer and the printed sheet cannot diverge on a profit.
          journal: journalRows(loadJournal(oid)),
          truncated: inv.truncated || bills.truncated || exp.truncated || pay.truncated,
        })
      } catch (e: any) {
        setError(e?.message || 'Could not load your books.')
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  function ask(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    setQuestion(trimmed)
    setAnswer(answerQuestion(trimmed, data))
    setHistory(prev => [trimmed, ...prev.filter(q => q !== trimmed)].slice(0, 6))
  }

  const docCount = data.invoices.length + data.bills.length + data.expenses.length + data.payments.length
  const readJournal = data.journal?.length ?? 0
  const maxBar = answer?.series.length ? Math.max(...answer.series.map(p => Math.abs(p.value)), 1) : 1

  return (
    <div className="page-container ask" style={{ maxWidth: 900 }}>
      <PageHeader
        eyebrow="AI"
        title="Ask my books"
        subtitle={`Ask in plain English. Answers are computed here in your browser from your own invoices, bills, expenses and payments${readJournal > 0 ? ', and from the journal postings your financial statements read' : ''} — nothing is sent to a server or a language model.`}
      />

      {error && (
        <div className="ask-alert is-error">
          <Icon name="alert" size={14} />
          {error}
        </div>
      )}

      <Card style={{ marginBottom: '1rem' }}>
        <form onSubmit={e => { e.preventDefault(); ask(question) }} className="ask-form">
          <input
            className="tf-input"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. What were my sales last month?"
            disabled={loading || docCount === 0}
            aria-label="Ask a question about your books"
            style={{ flex: '1 1 260px', background: docCount === 0 ? 'var(--surface-2)' : 'var(--surface)' }}
          />
          <Button
            type="submit"
            icon="sparkles"
            disabled={loading || docCount === 0 || !question.trim()}
          >
            Ask
          </Button>
        </form>

        <div className="tab-bar" style={{ marginTop: 12 }}>
          {SUGGESTED_QUESTIONS.map(q => (
            <button
              key={q}
              type="button"
              className="ask-chip"
              onClick={() => ask(q)}
              disabled={loading || docCount === 0}
            >
              {q}
            </button>
          ))}
        </div>

        {loading && <p className="ask-note" style={{ marginTop: 12 }}>Loading your books…</p>}
        {!loading && docCount === 0 && !error && (
          <p className="ask-note" style={{ marginTop: 12 }}>
            Nothing to read yet — create an invoice, bill or expense first, then ask.
          </p>
        )}
        {!loading && docCount > 0 && (
          <p className="ask-note is-faint" style={{ marginTop: 12 }}>
            Reading {data.invoices.length} invoices, {data.bills.length} bills, {data.expenses.length} expenses
            and {data.payments.length} payments.
          </p>
        )}
      </Card>

      {history.length > 1 && (
        <div style={{ marginBottom: '1rem' }}>
          <span className="ask-eyebrow">Recent</span>
          <div className="tab-bar" style={{ marginTop: 6 }}>
            {history.map(q => (
              <button
                key={q}
                type="button"
                className="ask-chip is-recent"
                onClick={() => ask(q)}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {answer && (
        <>
          <Card style={{ marginBottom: '1rem' }}>
            <div className="tf-row tf-wrap" style={{ gap: 6, marginBottom: 10 }}>
              <Badge tone="blue" dot={false}>Heard: {answer.intentLabel}</Badge>
              {answer.chips.map(c => <Badge key={c} tone="grey" dot={false}>{c}</Badge>)}
            </div>

            {answer.matched ? (
              <>
                <div className="ask-eyebrow">{answer.headline}</div>
                <div className="ask-value tf-num">{answer.value}</div>
                {answer.note && <div className="ask-note" style={{ marginTop: 2 }}>{answer.note}</div>}
                <p className="ask-sentence">{answer.sentence}</p>
                {answer.comparison && (() => {
                  const change = changeOf(answer.comparison!)
                  return (
                    <div className="ask-compare">
                      <span>This period <strong>{money(answer.comparison!.current)}</strong></span>
                      <span>Previous <strong>{money(answer.comparison!.previous)}</strong></span>
                      {change && <span style={{ color: change.color, fontWeight: 600 }}>{change.text}</span>}
                    </div>
                  )
                })()}
              </>
            ) : (
              <>
                <p className="ask-sentence" style={{ marginTop: 0 }}>{answer.sentence}</p>
                <div className="ask-suggestions">
                  {answer.suggestions.map(s => (
                    <button
                      key={s}
                      type="button"
                      className="ask-suggestion"
                      onClick={() => ask(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </Card>

          {answer.series.length > 1 && (
            <Card style={{ marginBottom: '1rem' }}>
              <div className="ask-eyebrow" style={{ marginBottom: 12 }}>{answer.seriesCaption} over time</div>
              {answer.series.map(point => (
                <div key={point.label} className="ask-series-row">
                  <span className="ask-series-label">{point.label}</span>
                  <ProgressBar
                    value={Math.abs(point.value)}
                    max={maxBar}
                    color={point.value < 0 ? 'var(--red)' : 'var(--brand)'}
                    height={14}
                  />
                  <span className="ask-series-value tf-num">
                    {answer.unit === 'count' ? point.value : money(point.value)}
                  </span>
                </div>
              ))}
            </Card>
          )}

          {answer.rows.length > 0 && (
            <div className="table-frame" style={{ marginBottom: '1rem' }}>
              <div className="ask-rows">
                <div className="ask-eyebrow" style={{ marginBottom: 10 }}>{answer.rowsCaption}</div>
                <div className="responsive-table">
                  <div className="table-header ask-row-head">
                    <span>Name</span>
                    <span className="ask-right">{answer.unit === 'count' ? 'Count' : 'Amount'}</span>
                    <span className="ask-right">Detail</span>
                  </div>
                  {answer.rows.map(row => (
                    <div key={row.label} className="table-row ask-row">
                      <span data-label="Name" className="ask-row-name">{row.label}</span>
                      <span data-label={answer.unit === 'count' ? 'Count' : 'Amount'} className="ask-right ask-row-value tf-num">
                        {answer.unit === 'count' ? row.value : money(row.value)}
                      </span>
                      <span data-label="Detail" className="ask-row-meta">{row.meta}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {answer.caveats.length > 0 && (
            <div className="ask-caveat" style={{ marginBottom: '1rem' }}>
              {answer.caveats.map(c => (
                <p key={c}>{c}</p>
              ))}
            </div>
          )}

          {answer.links.length > 0 && (
            <div className="tf-row tf-wrap" style={{ gap: 8, marginBottom: '1rem' }}>
              {answer.links.map(l => (
                <Button key={l.href} variant="ghost" size="sm" href={l.href} iconRight="arrow-right">
                  Open {l.label}
                </Button>
              ))}
            </div>
          )}
        </>
      )}

      <style>{`
        .ask-form { display: flex; gap: 8px; flex-wrap: wrap; }
        .ask-eyebrow { font-size: 11px; font-weight: 650; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.05em; }
        .ask-note { font-size: 13px; color: var(--muted); }
        .ask-note.is-faint { font-size: 12px; color: var(--faint); }
        .ask-value { font-size: 28px; font-weight: 700; color: var(--ink); margin-top: 2px; }
        .ask-sentence { font-size: 14px; color: var(--ink-2); line-height: 1.6; margin-top: 14px; margin-bottom: 0; }
        .ask-compare { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 14px;
          padding-top: 14px; border-top: 1px solid var(--line-soft); font-size: 13px; color: var(--muted); }
        .ask-compare strong { color: var(--ink); }

        .ask-chip { background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line);
          border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer; white-space: nowrap;
          font-family: inherit; }
        .ask-chip:hover:not(:disabled) { border-color: var(--brand); color: var(--brand); }
        .ask-chip:disabled { opacity: 0.55; cursor: not-allowed; }
        .ask-chip.is-recent { background: var(--surface); color: var(--muted); }

        .ask-suggestions { display: flex; flex-direction: column; gap: 6px; }
        .ask-suggestion { text-align: left; background: var(--surface-2); border: 1px solid var(--line);
          border-radius: var(--radius-sm); padding: 8px 12px; font-size: 13px; color: var(--brand);
          cursor: pointer; font-family: inherit; }
        .ask-suggestion:hover { border-color: var(--brand); }

        .ask-series-row { display: grid; grid-template-columns: 70px 1fr 90px; gap: 8px;
          align-items: center; margin-bottom: 6px; }
        .ask-series-label { font-size: 12px; color: var(--muted); }
        .ask-series-value { font-size: 12px; color: var(--ink); text-align: right; }

        .ask-rows { padding: 1.5rem; }
        .ask-row-head { display: grid; grid-template-columns: 1fr 120px 130px; gap: 8px;
          font-size: 11px; font-weight: 650; color: var(--faint); text-transform: uppercase;
          letter-spacing: 0.05em; margin-bottom: 4px; }
        .ask-row { display: grid; grid-template-columns: 1fr 120px 130px; gap: 8px; padding: 8px 0;
          border-bottom: 1px solid var(--line-soft); font-size: 13px; }
        .ask-row:last-child { border-bottom: none; }
        .ask-right { text-align: right; }
        .ask-row-name { color: var(--ink); font-weight: 550; overflow-wrap: anywhere; }
        .ask-row-value { color: var(--ink); }
        .ask-row-meta { color: var(--muted); font-size: 12px; text-align: right; overflow-wrap: anywhere; }

        .ask-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px;
          border-radius: var(--radius-sm); padding: 10px 12px; margin-bottom: 1rem; }
        .ask-alert.is-error { background: var(--red-soft); color: #b91c1c; }

        .ask-caveat { background: var(--amber-soft); border: 1px solid #fde68a;
          border-radius: var(--radius); padding: 14px 16px; }
        .ask-caveat p { font-size: 13px; color: #b45309; margin: 0 0 6px; line-height: 1.5; }
        .ask-caveat p:last-child { margin-bottom: 0; }

        @media (max-width: 768px) {
          .ask-right { text-align: left; }
          .ask-rows { padding: 0.9rem; }
        }
      `}</style>
    </div>
  )
}
