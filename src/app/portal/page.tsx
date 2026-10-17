// Public customer portal — the receiving end of a statement share link.
//
// This page never talks to Supabase and never asks anyone to sign in: the
// whole statement rides in the URL *fragment* (#d=…), which browsers do not
// send to the server, so the page decodes it in the browser and renders it.
// It lives outside the (app) shell — a customer may not have an account —
// but it is written on the same design kit as everything else.

'use client'

import { useEffect, useState } from 'react'
import Icon from '@/components/Icons'
import { Button } from '@/components/ui'
import { plural, pluralNoun} from '@/lib/format'
import {
  decodePortal, payAllLink, payLinkFor, portalRunning, portalTokenFromHash,
  type PortalDoc, type PortalPayload,
} from '@/lib/portal'

type Phase =
  | { phase: 'decoding' }
  | { phase: 'empty' }
  | { phase: 'error'; error: string }
  | { phase: 'ok'; payload: PortalPayload }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** ISO date → "08 Oct 2026". Parsed by hand so no timezone can shift the day. */
function fmtDate(iso?: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-')
  const mi = Number(m) - 1
  if (!y || !d || !(mi >= 0 && mi < 12)) return iso
  return `${d} ${MONTHS[mi]} ${y}`
}

function money(n: number): string {
  return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const DOC_COLOR: Record<string, string> = {
  invoice: '#2563eb',
  credit_note: '#dc2626',
  debit_note: '#d97706',
  bill: '#7c3aed',
  payment: '#059669',
}

function periodText(p: { from: string; to: string }): string {
  if (p.from && p.to) return `${fmtDate(p.from)} – ${fmtDate(p.to)}`
  if (p.from) return `from ${fmtDate(p.from)}`
  if (p.to) return `up to ${fmtDate(p.to)}`
  return 'All entries on record'
}

export default function PortalPage() {
  const [state, setState] = useState<Phase>({ phase: 'decoding' })

  useEffect(() => {
    let alive = true
    async function open() {
      const token = portalTokenFromHash(window.location.hash)
      if (!token) {
        // One await either way, so state always lands after mount (and the
        // empty message never flashes over a link that does carry a token).
        await Promise.resolve()
        if (alive) setState({ phase: 'empty' })
        return
      }
      const res = await decodePortal(token)
      if (!alive) return
      setState(res.ok ? { phase: 'ok', payload: res.payload } : { phase: 'error', error: res.error })
    }
    open()
    // Pasting a different link into an open tab changes only the fragment —
    // no reload, so the new statement must be decoded on `hashchange`.
    const onHash = () => { open() }
    window.addEventListener('hashchange', onHash)
    return () => {
      alive = false
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  useEffect(() => {
    if (state.phase === 'ok' && state.payload.business.name) {
      document.title = `Statement — ${state.payload.business.name}`
    }
  }, [state])

  return (
    <div className="pt-wrap">
      <div className="pt-glow" aria-hidden="true" />
      <div className="pt-col">
        <header className="pt-brand">
          <span className="pt-mark"><Icon name="zap" size={15} strokeWidth={2.3} /></span>
          <span className="pt-word">TaxFlow <span>India</span></span>
        </header>

        {state.phase === 'decoding' && (
          <div className="tf-card pt-state" aria-busy="true">
            <div className="pt-sk" style={{ width: '38%', height: 18 }} />
            <div className="pt-sk" style={{ width: '62%' }} />
            <div className="pt-sk" style={{ width: '84%' }} />
            <div className="pt-sk" style={{ width: '52%' }} />
          </div>
        )}

        {state.phase === 'empty' && (
          <div className="tf-card pt-state">
            <span className="pt-state-mark"><Icon name="link" size={20} strokeWidth={2} /></span>
            <h1>This link carries no statement</h1>
            <p>
              A statement of account opens here when it is shared as a link by the
              business. Open the link exactly as you received it, or ask the sender
              to share a fresh one.
            </p>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="tf-card pt-state">
            <span className="pt-state-mark pt-state-bad"><Icon name="alert" size={20} strokeWidth={2} /></span>
            <h1>This link cannot be opened</h1>
            <p>{state.error}</p>
            <p className="pt-state-hint">
              Each statement travels inside its own link — if a few characters were
              lost or changed in a message, the safest fix is a fresh link from the sender.
            </p>
          </div>
        )}

        {state.phase === 'ok' && <StatementView payload={state.payload} />}

        <footer className="pt-foot">
          <Icon name="shield" size={13} strokeWidth={2} />
          <span>The statement travels inside this link itself — nothing is stored on a server.</span>
        </footer>
      </div>

      <style>{`
        .pt-wrap {
          min-height: 100vh; background: var(--bg);
          padding: 1.75rem 1rem 3rem; position: relative; overflow-x: hidden;
        }
        .pt-glow {
          position: absolute; inset: -8% -20% auto; height: 44%;
          pointer-events: none;
          background: radial-gradient(620px 300px at 50% 0%,
            color-mix(in srgb, var(--brand) 10%, transparent), transparent 70%);
        }
        .pt-col {
          position: relative; width: 100%; max-width: 880px; margin: 0 auto;
          display: flex; flex-direction: column; gap: 1.1rem;
        }

        .pt-brand { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 4px; }
        .pt-mark {
          width: 26px; height: 26px; border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          color: white; background: var(--brand-grad); box-shadow: var(--shadow-sm);
        }
        .pt-word { font-size: 14px; font-weight: 720; letter-spacing: -0.01em; color: var(--ink); }
        .pt-word span { color: var(--brand); }

        /* ── identity header ─ */
        .pt-head {
          display: flex; justify-content: space-between; align-items: flex-end;
          gap: 14px; flex-wrap: wrap; padding: 0 4px;
        }
        .pt-biz { font-size: 24px; font-weight: 750; letter-spacing: -0.025em; color: var(--ink); line-height: 1.15; }
        .pt-gstin { font-family: var(--mono); font-size: 12px; color: var(--muted); margin-top: 4px; letter-spacing: 0.03em; }
        .pt-head-for { text-align: right; }
        .pt-k {
          font-size: 10.5px; font-weight: 700; letter-spacing: 0.09em;
          text-transform: uppercase; color: var(--faint);
        }
        .pt-v { font-size: 15px; font-weight: 650; color: var(--ink); margin-top: 3px; }
        .pt-sub { font-family: var(--mono); font-size: 11.5px; color: var(--muted); margin-top: 2px; }

        /* ── outstanding hero ─ */
        .pt-hero {
          position: relative; overflow: hidden; border-radius: var(--radius-lg);
          padding: 1.5rem 1.75rem; background: var(--brand-grad); color: white;
          box-shadow: var(--shadow-lg);
          display: flex; justify-content: space-between; align-items: center;
          gap: 18px; flex-wrap: wrap;
        }
        .pt-hero-glow {
          position: absolute; right: -60px; bottom: -140px; width: 320px; height: 320px;
          border-radius: 99px; pointer-events: none;
          background: radial-gradient(circle, rgba(255,255,255,0.2), transparent 65%);
        }
        .pt-hero-copy { position: relative; min-width: 0; }
        .pt-hero-k {
          font-size: 11px; font-weight: 700; letter-spacing: 0.1em;
          text-transform: uppercase; color: rgba(255,255,255,0.82);
        }
        .pt-hero-amt {
          font-size: 34px; font-weight: 780; letter-spacing: -0.03em;
          margin-top: 5px; font-variant-numeric: tabular-nums;
        }
        .pt-hero-sub { font-size: 12.5px; color: rgba(255,255,255,0.86); margin-top: 7px; }
        .pt-paybig {
          position: relative; display: inline-flex; align-items: center; gap: 8px;
          background: white; color: var(--brand-dark); font-weight: 720; font-size: 14px;
          padding: 12px 18px; border-radius: 11px; text-decoration: none;
          box-shadow: var(--shadow-md); white-space: nowrap;
          transition: transform .12s ease, box-shadow .12s ease;
        }
        .pt-paybig:hover { transform: translateY(-1px); box-shadow: var(--shadow-lg); }
        .pt-hero-quiet {
          background: var(--green-soft); color: var(--ink); box-shadow: var(--shadow-xs);
          border: 1px solid color-mix(in srgb, var(--green) 22%, white);
        }
        .pt-hero-quiet .pt-hero-k { color: var(--green); }
        .pt-hero-quiet .pt-hero-amt { color: var(--ink); }
        .pt-hero-credit { background: var(--brand-soft); border-color: color-mix(in srgb, var(--brand) 20%, white); }
        .pt-hero-credit .pt-hero-k { color: var(--brand); }
        .pt-hero-sub-quiet { color: var(--muted); }

        /* ── statement frame ─ */
        .pt-frame { overflow: hidden; }
        .pt-toolbar {
          display: flex; justify-content: space-between; align-items: center;
          gap: 12px; padding: 1.05rem 1.25rem; flex-wrap: wrap;
          border-bottom: 1px solid var(--line);
        }
        .pt-tool-sub { font-size: 12px; color: var(--muted); margin-top: 3px; }
        .pt-cols {
          grid-template-columns: 96px minmax(150px, 1.5fr) minmax(96px, 0.9fr) 1fr 1fr 1.05fr 104px;
          gap: 12px; align-items: center;
        }
        .pt-dot { width: 6px; height: 6px; border-radius: 99px; display: inline-block; flex: none; }
        .pt-doc { font-family: var(--mono); font-size: 12.5px; color: var(--ink-2); }
        .pt-paycell { text-align: right; }
        .pt-pay {
          display: inline-block; font-size: 11.5px; font-weight: 700;
          color: var(--brand); background: var(--brand-soft);
          border: 1px solid color-mix(in srgb, var(--brand) 18%, white);
          padding: 4px 9px; border-radius: 99px; text-decoration: none; white-space: nowrap;
          transition: background .12s ease, color .12s ease;
        }
        .pt-pay:hover { background: var(--brand); color: white; }
        .pt-due { font-size: 11px; color: var(--faint); white-space: nowrap; }
        .pt-fold {
          display: flex; align-items: center; gap: 8px;
          padding: 9px 14px; font-size: 12px; color: var(--amber);
          background: var(--amber-soft); border-bottom: 1px solid var(--line);
        }
        .pt-fine { font-size: 12px; color: var(--muted); text-align: center; padding: 0 8px; line-height: 1.6; }
        .pt-foot {
          display: flex; align-items: center; justify-content: center; gap: 7px;
          font-size: 12px; color: var(--faint); text-align: center; padding-top: 6px;
        }
        .pt-foot svg { flex: none; }

        /* ── states ─ */
        .pt-state {
          padding: 2.5rem 1.9rem; display: flex; flex-direction: column;
          align-items: center; text-align: center; gap: 9px;
        }
        .pt-state-mark {
          width: 52px; height: 52px; border-radius: 99px;
          display: flex; align-items: center; justify-content: center;
          background: var(--brand-soft); color: var(--brand); margin-bottom: 5px;
        }
        .pt-state-bad { background: var(--red-soft); color: var(--red); }
        .pt-state h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.015em; color: var(--ink); }
        .pt-state p { font-size: 13.5px; color: var(--muted); max-width: 460px; line-height: 1.6; }
        .pt-state-hint { font-size: 12px; color: var(--faint); }
        .pt-sk {
          height: 14px; border-radius: 7px; width: 100%;
          background: linear-gradient(90deg, var(--bg-elevated), #f3f6fb, var(--bg-elevated));
          background-size: 200% 100%; animation: pt-shimmer 1.4s ease infinite;
        }
        @keyframes pt-shimmer {
          from { background-position: 200% 0; }
          to { background-position: -200% 0; }
        }

        @media (max-width: 768px) {
          .pt-wrap { padding: 1.25rem 0.75rem 2.5rem; }
          .pt-head { flex-direction: column; align-items: flex-start; }
          .pt-head-for { text-align: left; }
          .pt-hero { padding: 1.25rem 1.25rem; }
          .pt-hero-amt { font-size: 28px; }
          .pt-paybig { width: 100%; justify-content: center; }
          .pt-cols { grid-template-columns: 1fr; gap: 4px; }
          .pt-cols > span { display: flex; justify-content: space-between; padding: 2px 0; }
          .pt-cols > span::before {
            content: attr(data-label); font-size: 11px; font-weight: 600;
            color: var(--faint); text-transform: uppercase; letter-spacing: .05em;
          }
          .table-header.pt-cols { display: none !important; }
          .table-row.pt-cols {
            display: block !important; border-bottom: 1px solid var(--line);
            padding: 12px 14px; margin: 0 !important; background: transparent !important;
            border-radius: 0 !important; border-top: none !important;
            border-left: none !important; border-right: none !important;
          }
          .pt-cols > .pt-paycell { justify-content: flex-end; padding-top: 7px; }
        }
        @media print {
          .pt-wrap { background: white; padding: 0; }
          .pt-glow { display: none !important; }
          .no-print { display: none !important; }
          .pt-hero { box-shadow: none; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .pt-paybig { display: none !important; }
          .pt-foot { display: none !important; }
          .pt-frame { break-inside: auto; }
        }
      `}</style>
    </div>
  )
}

function StatementView({ payload }: { payload: PortalPayload }) {
  const all = payAllLink(payload)
  const running = portalRunning(payload)
  const closing = payload.totals.closing
  const openCount = payload.rows.filter(r => r.type === 'invoice' && r.due > 0).length

  return (
    <>
      <div className="pt-head">
        <div>
          <h1 className="pt-biz">{payload.business.name || 'Statement of account'}</h1>
          {payload.business.gstin && <div className="pt-gstin">GSTIN · {payload.business.gstin}</div>}
        </div>
        <div className="pt-head-for">
          <div className="pt-k">Prepared for</div>
          <div className="pt-v">{payload.party.name}</div>
          {payload.party.gstin && <div className="pt-sub">GSTIN · {payload.party.gstin}</div>}
        </div>
      </div>

      {closing > 0 ? (
        <section className="pt-hero">
          <div className="pt-hero-glow" aria-hidden="true" />
          <div className="pt-hero-copy">
            <div className="pt-hero-k">Amount outstanding</div>
            <div className="pt-hero-amt">₹{money(closing)}</div>
            <div className="pt-hero-sub">
              {openCount > 0
                ? `Across ${plural(openCount, 'open invoice')}`
                : 'As per the statement below'}
              {' · '}updated {fmtDate(payload.asOf)}
            </div>
          </div>
          {all.link ? (
            <a className="pt-paybig" href={all.link} title={`Pay ₹${money(closing)} to ${payload.business.upi?.vpa}`}>
              <Icon name="wallet" size={15} strokeWidth={2.1} />
              Pay ₹{money(closing)} via UPI
            </a>
          ) : null}
        </section>
      ) : (
        <section className={`pt-hero pt-hero-quiet ${closing < 0 ? 'pt-hero-credit' : ''}`}>
          <div className="pt-hero-copy">
            <div className="pt-hero-k">{closing < 0 ? 'In credit with us' : 'All settled'}</div>
            <div className="pt-hero-amt">{closing < 0 ? `₹${money(-closing)}` : '₹0.00'}</div>
            <div className="pt-hero-sub pt-hero-sub-quiet">
              {closing < 0
                ? 'This advance will be set off against future invoices.'
                : `No payment is due as of ${fmtDate(payload.asOf)}.`}
            </div>
          </div>
        </section>
      )}

      <section className="table-frame pt-frame">
        <div className="pt-toolbar">
          <div>
            <div className="pt-k">Statement of account</div>
            <div className="pt-tool-sub">{periodText(payload.period)} · as of {fmtDate(payload.asOf)}</div>
          </div>
          <Button variant="ghost" size="sm" icon="printer" onClick={() => window.print()}>
            Print / Save PDF
          </Button>
        </div>

        {payload.dropped > 0 && (
          <div className="pt-fold">
            <Icon name="clock" size={13} strokeWidth={2.2} />
            <span>
              {payload.dropped} earlier {payload.dropped === 1 ? 'entry is' : 'entries are'} included
              in the opening balance below.
            </span>
          </div>
        )}

        <div className="responsive-table">
          <div className="table-header pt-cols tf-th" style={{ display: 'grid' }}>
            <span>Date</span>
            <span>Particulars</span>
            <span>Document</span>
            <span style={{ textAlign: 'right' }}>Debit</span>
            <span style={{ textAlign: 'right' }}>Credit</span>
            <span style={{ textAlign: 'right' }}>Balance</span>
            <span className="no-print" />
          </div>

          <div className="table-row pt-cols tf-td" style={{ display: 'grid', background: 'var(--surface-2)' }}>
            <span data-label="Date">Opening</span>
            <span data-label="Particulars"><b>Opening balance</b></span>
            <span data-label="Document">—</span>
            <span data-label="Debit" style={{ textAlign: 'right' }}>{payload.opening > 0 ? `₹${money(payload.opening)}` : '—'}</span>
            <span data-label="Credit" style={{ textAlign: 'right' }}>{payload.opening < 0 ? `₹${money(-payload.opening)}` : '—'}</span>
            <span data-label="Balance" style={{ textAlign: 'right', fontWeight: 650 }}>₹{money(payload.opening)}</span>
            <span className="no-print" />
          </div>

          {payload.rows.map((doc, i) => (
            <PortalRow key={`${doc.docNumber}-${i}`} doc={doc} payload={payload} balance={running[i]} />
          ))}

          <div className="table-row pt-cols tf-td" style={{
            display: 'grid', background: 'var(--surface-2)', fontWeight: 700, color: 'var(--ink)',
          }}>
            <span data-label="Date">—</span>
            <span data-label="Particulars">Period total</span>
            <span data-label="Document">{payload.rows.length} {pluralNoun(payload.rows.length, 'entry')}</span>
            <span data-label="Debit" style={{ textAlign: 'right' }}>₹{money(payload.totals.debit)}</span>
            <span data-label="Credit" style={{ textAlign: 'right' }}>₹{money(payload.totals.credit)}</span>
            <span data-label="Balance" style={{ textAlign: 'right' }}>₹{money(payload.totals.closing)}</span>
            <span className="no-print" />
          </div>
        </div>
      </section>

      <p className="pt-fine">
        Figures as on {fmtDate(payload.asOf)}. A payment already on its way will appear
        in the next statement — no need to pay twice.
      </p>
    </>
  )
}

function PortalRow({ doc, payload, balance }: { doc: PortalDoc; payload: PortalPayload; balance: number }) {
  const pay = doc.due > 0 ? payLinkFor(payload, doc) : { link: '', error: null }

  return (
    <div className="table-row pt-cols tf-td tf-tr" style={{ display: 'grid' }}>
      <span data-label="Date">{fmtDate(doc.date)}</span>
      <span data-label="Particulars">
        <span className="tf-row" style={{ gap: 7 }}>
          <i className="pt-dot" style={{ background: DOC_COLOR[doc.type] || 'var(--faint)' }} />
          {doc.particulars}
        </span>
      </span>
      <span data-label="Document"><span className="pt-doc">{doc.docNumber || '—'}</span></span>
      <span data-label="Debit" style={{ textAlign: 'right' }}>{doc.debit ? `₹${money(doc.debit)}` : '—'}</span>
      <span data-label="Credit" style={{ textAlign: 'right' }}>{doc.credit ? `₹${money(doc.credit)}` : '—'}</span>
      <span data-label="Balance" style={{ textAlign: 'right', fontWeight: 600 }}>₹{money(balance)}</span>
      <span className="pt-paycell no-print">
        {pay.link ? (
          <a className="pt-pay" href={pay.link} title={doc.dueDate ? `Due ${fmtDate(doc.dueDate)}` : undefined}>
            Pay ₹{money(doc.due)}
          </a>
        ) : doc.due > 0 ? (
          <span className="pt-due">{doc.dueDate ? `due ${fmtDate(doc.dueDate)}` : 'unpaid'}</span>
        ) : null}
      </span>
    </div>
  )
}
