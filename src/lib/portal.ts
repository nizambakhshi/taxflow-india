// Customer portal — a statement of account that travels inside its own link.
//
// The share link IS the document. The payload is snapshotted from the same
// buildStatement() output the ledger screen shows, so the portal cannot
// disagree with the ledger by construction — same rows, same opening, same
// closing. It is deflated (deflate-raw) and base64url-encoded into the URL
// *fragment* (#d=…), which browsers never send to a server: there is no token
// table, nothing stored, nothing to revoke, and a leaked link exposes only the
// one statement it carries. That is the v1 of the customer portal the gap list
// asked for — share links first, auth'd portal later — and it fits the app's
// offline-first posture rather than fighting it.
//
// Two decisions worth keeping:
//  * The cap folds, it does not truncate. Past PORTAL_MAX_DOCS the oldest rows
//    are dropped but their net is added into the opening balance, so the
//    arithmetic stays closed and the closing figure never lies.
//  * The UPI handle rides along at share time. A sent link keeps paying to the
//    VPA it was born with — the same stance as "documents are signed": a bill
//    already in a customer's hands is history, not a live query.

import { buildUpiDeepLink } from '@/lib/payments'
import type { DocType, PartyKind, Statement } from '@/lib/party-ledger'

/** Bumping this orphans every link already sent — do it only on a format change. */
export const PORTAL_VERSION = 1
export const PORTAL_TOKEN_PREFIX = `${PORTAL_VERSION}.`

/** Rows kept in a link; older entries fold into the opening balance. */
export const PORTAL_MAX_DOCS = 120

export const PORTAL_ERROR_NOT_LINK = 'This is not a TaxFlow statement link.'
export const PORTAL_ERROR_DAMAGED = 'The statement link looks damaged — ask for a fresh one.'
export const PORTAL_ERROR_VERSION = 'This link was made with a different version of TaxFlow — ask for a fresh one.'

export interface PortalUpi {
  vpa: string
  payeeName: string
}

export interface PortalDoc {
  date: string
  type: DocType
  particulars: string
  docNumber: string
  debit: number
  credit: number
  /** Outstanding on the document today; the pay button reads this. */
  due: number
  dueDate: string | null
}

export interface PortalPayload {
  v: number
  /** The date the figures were taken. */
  asOf: string
  business: { name: string; gstin: string; upi: PortalUpi | null }
  party: { name: string; kind: PartyKind; gstin: string }
  period: { from: string; to: string }
  /** Balance brought into the shown rows — capped older entries folded in. */
  opening: number
  rows: PortalDoc[]
  totals: { debit: number; credit: number; closing: number }
  /** Entries too old to ride in the link; they are inside `opening`. */
  dropped: number
}

export interface PortalBuildInput {
  businessName: string
  businessGstin: string
  /** null when the owner has not configured a VPA — the link then carries no pay buttons. */
  upi: PortalUpi | null
  party: { name: string; kind: PartyKind; gstin?: string | null }
  statement: Statement
  from: string
  to: string
  asOf?: string
}

export type PortalDecodeResult = { ok: true; payload: PortalPayload } | { ok: false; error: string }

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Snapshots one party's statement into a shareable payload. The cap keeps the
 * newest rows and pushes the dropped rows' net into the opening, so
 * `opening + Σ(debit − credit)` still lands exactly on `closing`.
 */
export function buildPortalPayload(input: PortalBuildInput): PortalPayload {
  const { statement } = input
  const dropped = Math.max(0, statement.rows.length - PORTAL_MAX_DOCS)
  const droppedRows = dropped > 0 ? statement.rows.slice(0, dropped) : []
  const kept = dropped > 0 ? statement.rows.slice(dropped) : statement.rows
  const opening = round2(statement.opening + droppedRows.reduce((s, r) => s + r.debit - r.credit, 0))

  return {
    v: PORTAL_VERSION,
    asOf: input.asOf || todayISO(),
    business: {
      name: (input.businessName || '').trim(),
      gstin: (input.businessGstin || '').trim(),
      upi: input.upi
        ? { vpa: input.upi.vpa.trim(), payeeName: (input.upi.payeeName || '').trim() }
        : null,
    },
    party: {
      name: (input.party.name || '').trim(),
      kind: input.party.kind,
      gstin: (input.party.gstin || '').trim(),
    },
    period: { from: input.from || '', to: input.to || '' },
    opening,
    rows: kept.map(r => ({
      date: r.date,
      type: r.type,
      particulars: r.particulars,
      docNumber: r.docNumber,
      debit: round2(r.debit),
      credit: round2(r.credit),
      due: r.type === 'invoice' ? round2(r.balanceDue || 0) : 0,
      dueDate: r.dueDate || null,
    })),
    totals: {
      debit: round2(kept.reduce((s, r) => s + r.debit, 0)),
      credit: round2(kept.reduce((s, r) => s + r.credit, 0)),
      closing: round2(statement.closing),
    },
    dropped,
  }
}

/**
 * Row-by-row running balance for the portal table. Display-only arithmetic,
 * but it lives here so the last value is guaranteed to land exactly on
 * `totals.closing` — the same fold the payload was built with.
 */
export function portalRunning(payload: PortalPayload): number[] {
  let run = payload.opening
  const out: number[] = []
  for (const r of payload.rows) {
    run = round2(run + r.debit - r.credit)
    out.push(run)
  }
  return out
}

/** Pay-one-invoice deep link; empty link + reason when there is nothing to pay. */
export function payLinkFor(payload: PortalPayload, doc: PortalDoc): { link: string; error: string | null } {
  const upi = payload.business.upi
  if (!upi) return { link: '', error: 'No UPI ID was set when this link was shared' }
  if (doc.type !== 'invoice') return { link: '', error: 'Only invoices can be paid' }
  if (!(doc.due > 0)) return { link: '', error: 'Nothing due on this document' }
  return buildUpiDeepLink({
    vpa: upi.vpa,
    payeeName: upi.payeeName || payload.business.name,
    amount: doc.due,
    transactionRef: doc.docNumber || undefined,
    note: doc.docNumber && doc.docNumber !== '—' ? `Payment for ${doc.docNumber}` : 'Payment',
  })
}

/** One link for the whole outstanding balance. */
export function payAllLink(payload: PortalPayload): { link: string; error: string | null } {
  const upi = payload.business.upi
  if (!upi) return { link: '', error: 'No UPI ID was set when this link was shared' }
  if (!(payload.totals.closing > 0)) return { link: '', error: 'Nothing outstanding' }
  return buildUpiDeepLink({
    vpa: upi.vpa,
    payeeName: upi.payeeName || payload.business.name,
    amount: payload.totals.closing,
    note: `Statement ${payload.party.name}`.slice(0, 80),
  })
}

// ── Token encode / decode ────────────────────────────────
// base64url in, deflate-raw inside, JSON at the core. btoa/atob are chunked so
// a full 120-row statement never blows the call stack through spread args.

function bytesToB64url(bytes: Uint8Array): string {
  let bin = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const padded = b64 + (b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '')
  const bin = atob(padded)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function deflate(json: string): Promise<Uint8Array> {
  const stream = new Blob([new TextEncoder().encode(json)])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function inflate(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new TextDecoder().decode(await new Response(stream).arrayBuffer())
}

/** Payload → share token (`1.…`). Async: deflate goes through the stream APIs. */
export async function encodePortal(payload: PortalPayload): Promise<string> {
  return PORTAL_TOKEN_PREFIX + bytesToB64url(await deflate(JSON.stringify(payload)))
}

function isPortalPayload(o: unknown): o is PortalPayload {
  if (!o || typeof o !== 'object') return false
  const p = o as PortalPayload
  if (p.v !== PORTAL_VERSION) return false
  if (!p.business || typeof p.business.name !== 'string') return false
  if (!p.party || typeof p.party.name !== 'string') return false
  if (!p.period || typeof p.period !== 'object') return false
  if (!p.totals || !Number.isFinite(p.totals.closing)) return false
  if (!Number.isFinite(p.opening)) return false
  if (!Array.isArray(p.rows) || p.rows.length > PORTAL_MAX_DOCS) return false
  for (const r of p.rows) {
    if (!r || typeof r.date !== 'string' || typeof r.particulars !== 'string') return false
    if (!Number.isFinite(r.debit) || !Number.isFinite(r.credit)) return false
  }
  return true
}

/** Share token or raw fragment token → payload, with a customer-friendly error. */
export async function decodePortal(token: string): Promise<PortalDecodeResult> {
  const t = (token || '').trim()
  if (!t) return { ok: false, error: PORTAL_ERROR_DAMAGED }

  const dot = t.indexOf('.')
  if (dot <= 0) return { ok: false, error: PORTAL_ERROR_NOT_LINK }
  const version = t.slice(0, dot)
  if (!/^\d+$/.test(version)) return { ok: false, error: PORTAL_ERROR_NOT_LINK }
  if (Number(version) !== PORTAL_VERSION) return { ok: false, error: PORTAL_ERROR_VERSION }

  const body = t.slice(dot + 1)
  if (!body) return { ok: false, error: PORTAL_ERROR_DAMAGED }

  try {
    const json = await inflate(b64urlToBytes(body))
    const parsed = JSON.parse(json)
    if (!isPortalPayload(parsed)) return { ok: false, error: PORTAL_ERROR_DAMAGED }
    return { ok: true, payload: parsed }
  } catch {
    return { ok: false, error: PORTAL_ERROR_DAMAGED }
  }
}

/** Token → full share URL. The fragment keeps the statement off every server. */
export function portalUrl(token: string, origin: string): string {
  return `${(origin || '').replace(/\/+$/, '')}/portal#d=${token}`
}

/** `#d=<token>` (or a bare fragment) → token; '' when the hash carries none. */
export function portalTokenFromHash(hash: string): string {
  const h = (hash || '').replace(/^#/, '')
  if (!h) return ''
  const token = new URLSearchParams(h).get('d')
  return token ? token.trim() : ''
}
