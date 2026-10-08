// GSTR-2B import + reconciliation against purchase books.
// Supports the official GSTR-2B JSON (from the GST portal zip) and a simple CSV template.

export interface Gstr2bRecord {
  supplierGstin: string
  supplierName?: string
  invoiceNo: string
  invoiceDate: string | null // yyyy-mm-dd
  invoiceType?: string
  taxable: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  section: string // B2B, CD/DNR, etc.
}

export interface BookRecord {
  id: string
  supplierGstin: string
  invoiceNo: string
  invoiceDate: string | null
  label: string
  taxable: number
  igst: number
  cgst: number
  sgst: number
}

export type MatchStatus = 'matched' | 'mismatch' | 'books_only' | 'portal_only'

export interface ReconciledRow {
  status: MatchStatus
  book?: BookRecord
  portal?: Gstr2bRecord
  diffTaxable: number
  diffIgst: number
  diffCgst: number
  diffSgst: number
  mismatchHeads: string[]
}

export interface ReconciliationResult {
  rows: ReconciledRow[]
  matched: ReconciledRow[]
  mismatched: ReconciledRow[]
  booksOnly: ReconciledRow[]
  portalOnly: ReconciledRow[]
  totals: {
    booksTaxable: number
    booksITC: number
    portalTaxable: number
    portalITC: number
    matchedITC: number
    atRiskTaxable: number
    atRiskITC: number
    excessTaxable: number
    excessITC: number
    cessInPortal: number
  }
}

const AMOUNT_TOLERANCE = 1 // ₹1 rounding tolerance per head

export function normalizeGstin(gstin: string | null | undefined): string {
  return (gstin || '').trim().toUpperCase().replace(/\s+/g, '')
}

// GSTN invoice-number normalization: uppercase, strip non-alphanumerics,
// then drop leading zeros. Returns the set of candidate keys for a number.
export function invoiceNoCandidates(raw: string | null | undefined): string[] {
  const cleaned = (raw || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
  if (!cleaned) return []

  const candidates = new Set<string>([cleaned])
  // "INV00123" -> "INV123" (strip zeros right after leading letters)
  const noZeros = cleaned.replace(/^([A-Z]+)0+/, '$1').replace(/0+(\d)/g, '$1')
  candidates.add(noZeros)
  // pure numeric: strip leading zeros
  if (/^[0-9]+$/.test(cleaned)) {
    candidates.add(cleaned.replace(/^0+/, '') || '0')
  }
  return Array.from(candidates)
}

// Official portal date format in JSON is dd-mm-yyyy; CSV may use yyyy-mm-dd.
export function parsePortalDate(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const s = String(dateStr).trim()
  const dmy = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`
  const ymd = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`
  const dmySlash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmySlash) return `${dmySlash[3]}-${dmySlash[2].padStart(2, '0')}-${dmySlash[1].padStart(2, '0')}`
  return null
}

function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// ── GSTR-2B JSON parsing (official portal file) ──────────────────────────

/** A document object as it comes off the portal: keys are present or not, values are whatever it sent. */
type PortalRow = Record<string, unknown>

/** Walk a chain of optional keys through parsed JSON without asserting its shape. */
function jsonPath(value: unknown, ...keys: string[]): unknown {
  return keys.reduce<unknown>((cur, k) => {
    if (typeof cur !== 'object' || cur === null) return undefined
    return (cur as Record<string, unknown>)[k]
  }, value)
}

function field(source: PortalRow, key: string): string {
  const v = source[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : ''
}

/** Read the string/number identity of a top-level portal field, if it is there. */
function scalar(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const v = (source as Record<string, unknown>)[key]
  return typeof v === 'string' || typeof v === 'number' ? String(v) : undefined
}

function asRows(value: unknown): PortalRow[] {
  return Array.isArray(value)
    ? value.filter((r): r is PortalRow => typeof r === 'object' && r !== null)
    : []
}

export function parseGstr2bJson(text: string): { gstin?: string; period?: string; records: Gstr2bRecord[] } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error('Invalid JSON file. Upload the .json inside the GSTR-2B zip downloaded from the GST portal.')
  }

  const itcData = jsonPath(json, 'data', 'docdata', 'itc-01') ?? jsonPath(json, 'data', 'records', 'itc-01')
  if (typeof itcData !== 'object' || itcData === null) {
    throw new Error('Could not find itc-01 (Table B2B/CDNR) data in this file. Is this a GSTR-2B JSON?')
  }
  const itc = itcData as PortalRow
  const rowsIn = (key: string) => asRows(itc[key])

  const records: Gstr2bRecord[] = []

  const mapList = (list: PortalRow[], section: string) => {
    for (const r of list) {
      records.push({
        supplierGstin: normalizeGstin(field(r, 'sup_gstin') || field(r, 'gstin')),
        invoiceNo: field(r, 'num').trim(),
        invoiceDate: parsePortalDate(field(r, 'inv_dt') || field(r, 'dt')),
        invoiceType: field(r, 'inv_typ') || undefined,
        taxable: toNum(r.taxable),
        igst: toNum(r.igst),
        cgst: toNum(r.cgst),
        sgst: toNum(r.sgst),
        cess: toNum(r.cess),
        section,
      })
    }
  }

  mapList(rowsIn('B2B'), 'B2B')
  mapList(rowsIn('CD/DNR').length ? rowsIn('CD/DNR') : rowsIn('CDNR'), 'CD/DNR')
  mapList(rowsIn('B2CL'), 'B2CL')
  mapList(rowsIn('IMPG'), 'IMPG')
  mapList(rowsIn('IMPS'), 'IMPS')

  return {
    gstin: scalar(json, 'gstin'),
    period: scalar(json, 'rtaxperiod'),
    records,
  }
}

// ── Simple CSV parsing (template below) ─────────────────────────────────

const CSV_HEADER_ALIASES: Record<string, string> = {
  supplier_gstin: 'supplierGstin',
  gstin: 'supplierGstin',
  vendor_gstin: 'supplierGstin',
  invoice_number: 'invoiceNo',
  invoice_no: 'invoiceNo',
  bill_number: 'invoiceNo',
  inv_no: 'invoiceNo',
  invoice_date: 'invoiceDate',
  bill_date: 'invoiceDate',
  inv_date: 'invoiceDate',
  taxable_value: 'taxable',
  taxable: 'taxable',
  igst: 'igst',
  cgst: 'cgst',
  sgst: 'sgst',
  utgst: 'sgst',
  cess: 'cess',
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { out.push(cur); cur = '' }
    else cur += ch
  }
  out.push(cur)
  return out.map(s => s.trim())
}

export function parseGstr2bCsv(text: string): Gstr2bRecord[] {
  const lines = text.split(/\r?\n/).filter(l => l.trim())
  if (lines.length < 2) throw new Error('CSV has no data rows.')

  const headers = splitCsvLine(lines[0]).map(h =>
    h.trim().toLowerCase().replace(/\s+/g, '_')
  )
  const keys = headers.map(h => CSV_HEADER_ALIASES[h] || h)

  const idx = (k: string) => keys.indexOf(k)
  const gIdx = idx('supplierGstin')
  const nIdx = idx('invoiceNo')
  if (gIdx === -1 || nIdx === -1) {
    throw new Error('CSV must have at least "supplier_gstin" and "invoice_number" columns. Use the template.')
  }

  const records: Gstr2bRecord[] = []
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i])
    if (!cells[gIdx] && !cells[nIdx]) continue
    records.push({
      supplierGstin: normalizeGstin(cells[gIdx]),
      invoiceNo: cells[nIdx] || '',
      invoiceDate: parsePortalDate(cells[idx('invoiceDate')] || ''),
      taxable: toNum(cells[idx('taxable')]),
      igst: toNum(cells[idx('igst')]),
      cgst: toNum(cells[idx('cgst')]),
      sgst: toNum(cells[idx('sgst')]),
      cess: toNum(cells[idx('cess')]),
      section: 'CSV',
    })
  }
  if (!records.length) throw new Error('No valid rows found in CSV.')
  return records
}

export const CSV_TEMPLATE_HEADERS =
  'supplier_gstin,invoice_number,invoice_date,taxable_value,igst,cgst,sgst,cess'
export const CSV_TEMPLATE_EXAMPLE =
  '27AABCS1234K1ZP,BILL-0045,12-08-2026,100000,0,9000,9000,0'

// ── Reconciliation engine ───────────────────────────────────────────────

export function reconcile(
  books: BookRecord[],
  portal: Gstr2bRecord[],
): ReconciliationResult {
  // Index portal records: gstin -> candidateInvoiceKey -> list (FIFO consumption)
  const portalIndex = new Map<string, Map<string, Gstr2bRecord[]>>()
  const addToIndex = (gstin: string, invNo: string, rec: Gstr2bRecord) => {
    for (const cand of invoiceNoCandidates(invNo)) {
      if (!portalIndex.has(gstin)) portalIndex.set(gstin, new Map())
      const byInv = portalIndex.get(gstin)!
      if (!byInv.has(cand)) byInv.set(cand, [])
      byInv.get(cand)!.push(rec)
    }
  }
  const consumed = new Set<Gstr2bRecord>()
  for (const rec of portal) {
    if (rec.invoiceNo) addToIndex(rec.supplierGstin, rec.invoiceNo, rec)
  }

  const findPortal = (gstin: string, invNo: string): Gstr2bRecord | undefined => {
    const byInv = portalIndex.get(gstin)
    if (!byInv) return undefined
    for (const cand of invoiceNoCandidates(invNo)) {
      const list = byInv.get(cand)
      if (list) {
        const free = list.find(r => !consumed.has(r))
        if (free) {
          consumed.add(free)
          return free
        }
      }
    }
    return undefined
  }

  const rows: ReconciledRow[] = []

  for (const book of books) {
    const hit = findPortal(book.supplierGstin, book.invoiceNo)
    if (!hit) {
      rows.push({
        status: 'books_only',
        book,
        diffTaxable: book.taxable,
        diffIgst: book.igst,
        diffCgst: book.cgst,
        diffSgst: book.sgst,
        mismatchHeads: [],
      })
      continue
    }

    const diffs = {
      taxable: book.taxable - hit.taxable,
      igst: book.igst - hit.igst,
      cgst: book.cgst - hit.cgst,
      sgst: book.sgst - hit.sgst,
    }
    const heads: string[] = []
    if (Math.abs(diffs.taxable) > AMOUNT_TOLERANCE) heads.push('Taxable')
    if (Math.abs(diffs.igst) > AMOUNT_TOLERANCE) heads.push('IGST')
    if (Math.abs(diffs.cgst) > AMOUNT_TOLERANCE) heads.push('CGST')
    if (Math.abs(diffs.sgst) > AMOUNT_TOLERANCE) heads.push('SGST')

    rows.push({
      status: heads.length ? 'mismatch' : 'matched',
      book,
      portal: hit,
      diffTaxable: diffs.taxable,
      diffIgst: diffs.igst,
      diffCgst: diffs.cgst,
      diffSgst: diffs.sgst,
      mismatchHeads: heads,
    })
  }

  for (const rec of portal) {
    if (!consumed.has(rec)) {
      rows.push({
        status: 'portal_only',
        portal: rec,
        diffTaxable: -rec.taxable,
        diffIgst: -rec.igst,
        diffCgst: -rec.cgst,
        diffSgst: -rec.sgst,
        mismatchHeads: [],
      })
    }
  }

  const sum = (list: ReconciledRow[], pick: (r: ReconciledRow) => number) =>
    list.reduce((s, r) => s + pick(r), 0)

  const matched = rows.filter(r => r.status === 'matched')
  const mismatched = rows.filter(r => r.status === 'mismatch')
  const booksOnly = rows.filter(r => r.status === 'books_only')
  const portalOnly = rows.filter(r => r.status === 'portal_only')

  const bookITCof = (r: ReconciledRow) =>
    r.book ? r.book.igst + r.book.cgst + r.book.sgst : 0
  const portalITCof = (r: ReconciledRow) =>
    r.portal ? r.portal.igst + r.portal.cgst + r.portal.sgst : 0

  const booksAll = [...matched, ...mismatched, ...booksOnly]
  const portalAll = [...matched, ...mismatched, ...portalOnly]

  return {
    rows,
    matched,
    mismatched,
    booksOnly,
    portalOnly,
    totals: {
      booksTaxable: sum(booksAll, r => r.book?.taxable || 0),
      booksITC: sum(booksAll, bookITCof),
      portalTaxable: sum(portalAll, r => r.portal?.taxable || 0),
      portalITC: sum(portalAll, portalITCof),
      matchedITC: sum(matched, bookITCof),
      atRiskTaxable:
        sum(booksOnly, r => r.book?.taxable || 0) +
        sum(mismatched, r => Math.max(0, r.diffTaxable)),
      atRiskITC:
        sum(booksOnly, bookITCof) +
        sum(mismatched, r => Math.max(0, r.diffIgst) + Math.max(0, r.diffCgst) + Math.max(0, r.diffSgst)),
      excessTaxable:
        sum(portalOnly, r => r.portal?.taxable || 0) +
        sum(mismatched, r => Math.max(0, -r.diffTaxable)),
      excessITC:
        sum(portalOnly, portalITCof) +
        sum(mismatched, r => Math.max(0, -r.diffIgst) + Math.max(0, -r.diffCgst) + Math.max(0, -r.diffSgst)),
      cessInPortal: sum(portalAll, r => r.portal?.cess || 0),
    },
  }
}

// ── CSV export ──────────────────────────────────────────────────────────
// The file itself is written by csvFromRows() + download() in gstr9.ts / party-ledger.ts,
// which quote fields and prefix a single UTF-8 BOM.

export function reconciliationExportRows(result: ReconciliationResult): (string | number)[][] {
  const header = [
    'Status', 'Supplier GSTIN', 'Invoice No (Books)', 'Invoice No (2B)', 'Invoice Date',
    'Books Taxable', '2B Taxable', 'Diff Taxable',
    'Books IGST', '2B IGST', 'Books CGST', '2B CGST', 'Books SGST', '2B SGST',
    'Mismatch Heads',
  ]
  const statusLabel: Record<MatchStatus, string> = {
    matched: 'Matched',
    mismatch: 'Amount Mismatch',
    books_only: 'In Books - Not in 2B',
    portal_only: 'In 2B - Not in Books',
  }
  const body = result.rows.map(r => {
    const b = r.book
    const p = r.portal
    return [
      statusLabel[r.status],
      b?.supplierGstin || p?.supplierGstin || '',
      b?.invoiceNo || '',
      p?.invoiceNo || '',
      b?.invoiceDate || p?.invoiceDate || '',
      b?.taxable ?? '', p?.taxable ?? '', r.diffTaxable,
      b?.igst ?? '', p?.igst ?? '',
      b?.cgst ?? '', p?.cgst ?? '',
      b?.sgst ?? '', p?.sgst ?? '',
      r.mismatchHeads.join(' / '),
    ]
  })
  return [header, ...body]
}
