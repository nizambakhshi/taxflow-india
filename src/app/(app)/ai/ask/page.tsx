'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  answerQuestion,
  SUGGESTED_QUESTIONS,
  type AskAnswer,
  type AskDataset,
} from '@/lib/ask'

const sectionStyle = {
  background: 'white', border: '1px solid #e2e8f0',
  borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem',
}
const labelStyle = {
  fontSize: '11px', fontWeight: 600 as const, color: '#64748b',
  textTransform: 'uppercase' as const, letterSpacing: '0.03em',
}

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

function Chip({ text }: { text: string }) {
  return (
    <span style={{
      display: 'inline-block', background: '#f1f5f9', color: '#334155',
      borderRadius: '999px', padding: '3px 10px', fontSize: '12px', marginRight: '6px', marginBottom: '6px',
    }}>
      {text}
    </span>
  )
}

function changeOf(cmp: { current: number; previous: number }): { text: string; color: string } | null {
  if (cmp.previous === 0) return cmp.current === 0 ? null : { text: 'new in this period', color: '#2563eb' }
  const pct = ((cmp.current - cmp.previous) / Math.abs(cmp.previous)) * 100
  return { text: `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs previous period`, color: pct >= 0 ? '#166534' : '#b91c1c' }
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
  const maxBar = answer?.series.length ? Math.max(...answer.series.map(p => Math.abs(p.value)), 1) : 1

  return (
    <div className="page-container" style={{ maxWidth: '900px' }}>
      <div style={{ marginBottom: '1rem' }}>
        <h1 style={{ fontSize: '20px', fontWeight: 700, color: '#0f172a', margin: 0 }}>Ask My Books</h1>
        <p style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>
          Ask in plain English. Answers are computed here in your browser from your own
          invoices, bills, expenses and payments — nothing is sent to a server or a language model.
        </p>
      </div>

      {error && (
        <div style={{ ...sectionStyle, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c' }}>
          {error}
        </div>
      )}

      <div style={sectionStyle}>
        <form onSubmit={e => { e.preventDefault(); ask(question) }} style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. What were my sales last month?"
            disabled={loading || docCount === 0}
            style={{
              flex: '1 1 260px', padding: '10px 12px', border: '1px solid #e2e8f0',
              borderRadius: '8px', fontSize: '14px', background: docCount === 0 ? '#f8fafc' : 'white',
            }}
          />
          <button
            type="submit"
            disabled={loading || docCount === 0 || !question.trim()}
            style={{
              padding: '10px 18px', background: '#2563eb', color: 'white', border: 'none',
              borderRadius: '8px', fontSize: '14px', fontWeight: 600,
              cursor: docCount === 0 ? 'not-allowed' : 'pointer', opacity: !question.trim() ? 0.6 : 1,
            }}
          >
            Ask
          </button>
        </form>

        <div className="tab-bar" style={{ marginTop: '12px' }}>
          {SUGGESTED_QUESTIONS.map(q => (
            <button
              key={q}
              type="button"
              onClick={() => ask(q)}
              disabled={loading || docCount === 0}
              style={{
                background: '#f8fafc', color: '#334155', border: '1px solid #e2e8f0',
                borderRadius: '999px', padding: '6px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {loading && <p style={{ fontSize: '13px', color: '#64748b', marginTop: '12px' }}>Loading your books…</p>}
        {!loading && docCount === 0 && !error && (
          <p style={{ fontSize: '13px', color: '#64748b', marginTop: '12px' }}>
            Nothing to read yet — create an invoice, bill or expense first, then ask.
          </p>
        )}
        {!loading && docCount > 0 && (
          <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '12px' }}>
            Reading {data.invoices.length} invoices, {data.bills.length} bills, {data.expenses.length} expenses
            and {data.payments.length} payments.
          </p>
        )}
      </div>

      {history.length > 1 && (
        <div style={{ marginBottom: '1rem' }}>
          <span style={labelStyle}>Recent</span>
          <div className="tab-bar" style={{ marginTop: '6px' }}>
            {history.map(q => (
              <button
                key={q}
                type="button"
                onClick={() => ask(q)}
                style={{
                  background: 'white', color: '#64748b', border: '1px solid #e2e8f0',
                  borderRadius: '999px', padding: '5px 11px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      {answer && (
        <>
          <div style={sectionStyle}>
            <div style={{ marginBottom: '10px' }}>
              <Chip text={`Heard: ${answer.intentLabel}`} />
              {answer.chips.map(c => <Chip key={c} text={c} />)}
            </div>

            {answer.matched ? (
              <>
                <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                  {answer.headline}
                </div>
                <div style={{ fontSize: '28px', fontWeight: 700, color: '#0f172a', marginTop: '2px' }}>
                  {answer.value}
                </div>
                {answer.note && <div style={{ fontSize: '13px', color: '#64748b', marginTop: '2px' }}>{answer.note}</div>}
                <p style={{ fontSize: '14px', color: '#334155', lineHeight: 1.6, marginTop: '14px', marginBottom: 0 }}>
                  {answer.sentence}
                </p>
                {answer.comparison && (() => {
                  const change = changeOf(answer.comparison!)
                  return (
                    <div style={{
                      display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '14px',
                      paddingTop: '14px', borderTop: '1px solid #f1f5f9', fontSize: '13px', color: '#64748b',
                    }}>
                      <span>This period <strong style={{ color: '#0f172a' }}>{money(answer.comparison!.current)}</strong></span>
                      <span>Previous <strong style={{ color: '#0f172a' }}>{money(answer.comparison!.previous)}</strong></span>
                      {change && <span style={{ color: change.color, fontWeight: 600 }}>{change.text}</span>}
                    </div>
                  )
                })()}
              </>
            ) : (
              <>
                <p style={{ fontSize: '14px', color: '#334155', marginTop: 0 }}>{answer.sentence}</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {answer.suggestions.map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => ask(s)}
                      style={{
                        textAlign: 'left', background: '#f8fafc', border: '1px solid #e2e8f0',
                        borderRadius: '8px', padding: '8px 12px', fontSize: '13px', color: '#2563eb', cursor: 'pointer',
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {answer.series.length > 1 && (
            <div style={sectionStyle}>
              <div style={{ ...labelStyle, marginBottom: '12px' }}>{answer.seriesCaption} over time</div>
              {answer.series.map(point => (
                <div key={point.label} style={{ display: 'grid', gridTemplateColumns: '70px 1fr 90px', gap: '8px', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', color: '#64748b' }}>{point.label}</span>
                  <div style={{ background: '#f1f5f9', borderRadius: '4px', height: '14px', overflow: 'hidden' }}>
                    <div style={{
                      background: point.value < 0 ? '#dc2626' : '#2563eb',
                      width: `${Math.min(100, (Math.abs(point.value) / maxBar) * 100)}%`,
                      height: '100%',
                    }} />
                  </div>
                  <span style={{ fontSize: '12px', color: '#0f172a', textAlign: 'right' }}>
                    {answer.unit === 'count' ? point.value : money(point.value)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {answer.rows.length > 0 && (
            <div className="table-frame">
              <div style={{ padding: '1.5rem' }}>
                <div style={{ ...labelStyle, marginBottom: '10px' }}>{answer.rowsCaption}</div>
                <div className="responsive-table">
                  <div className="table-header" style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px', gap: '8px' }}>
                    <span>Name</span>
                    <span style={{ textAlign: 'right' }}>{answer.unit === 'count' ? 'Count' : 'Amount'}</span>
                    <span style={{ textAlign: 'right' }}>Detail</span>
                  </div>
                  {answer.rows.map(row => (
                    <div key={row.label} className="table-row" style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px', gap: '8px', padding: '8px 0', borderBottom: '1px solid #f1f5f9', fontSize: '13px' }}>
                      <span data-label="Name" style={{ color: '#0f172a', fontWeight: 500 }}>{row.label}</span>
                      <span data-label={answer.unit === 'count' ? 'Count' : 'Amount'} style={{ textAlign: 'right', color: '#0f172a' }}>
                        {answer.unit === 'count' ? row.value : money(row.value)}
                      </span>
                      <span data-label="Detail" style={{ textAlign: 'right', color: '#64748b', fontSize: '12px' }}>{row.meta}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {answer.caveats.length > 0 && (
            <div style={{ ...sectionStyle, background: '#fffbeb', border: '1px solid #fde68a', marginTop: '1rem' }}>
              {answer.caveats.map(c => (
                <p key={c} style={{ fontSize: '13px', color: '#92400e', margin: '0 0 6px', lineHeight: 1.5 }}>{c}</p>
              ))}
            </div>
          )}

          {answer.links.length > 0 && (
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '1rem' }}>
              {answer.links.map(l => (
                <Link
                  key={l.href}
                  href={l.href}
                  style={{
                    padding: '8px 14px', border: '1px solid #e2e8f0', borderRadius: '8px',
                    fontSize: '13px', color: '#2563eb', background: 'white', textDecoration: 'none',
                  }}
                >
                  Open {l.label} →
                </Link>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
