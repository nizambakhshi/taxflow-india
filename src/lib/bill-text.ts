// =============================================
// PURCHASE BILL TEXT EXTRACTION
// TaxFlow India — Roadmap #7 (Smart Capture)
// =============================================
//
// Turns the raw text of a supplier's GST tax invoice (OCR output or a digital
// PDF's text layer) into a draft purchase bill.
//
// Deliberately not an LLM call: nothing a supplier sends us leaves the browser,
// and every figure the engine reports traces back to the line it came from.
// Extraction is label-anchored (GST law fixes how a tax invoice is worded) and
// cross-checked against GST arithmetic, which is what makes it usable as a
// pre-fill instead of a guess.
// =============================================

// Detection list, not a picker list — see src/lib/gst-rates.ts for why this one
// omits the 0.25% rough-diamond rate (it is inside our rounding tolerance).
export const GST_RATES = [0, 3, 5, 12, 18, 28, 40]

const INDIAN_STATES: Record<string, string> = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur',
  '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '25': 'Dadra & Nagar Haveli and Daman & Diu', '26': 'Maharashtra',
  '27': 'Maharashtra', '28': 'Andhra Pradesh', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Telangana',
  '35': 'Andaman & Nicobar Islands', '36': 'Puducherry', '37': 'Ladakh',
}

export type ParsedLineItem = {
  item_name: string
  hsn_sac: string
  quantity: number
  unit: string
  rate: number
  discount_percent: number
  gst_rate: number
  taxable_value: number
  source: 'table' | 'single'
  line_text: string
}

export type DeclaredTotals = {
  taxable_amount: number | null
  cgst_amount: number | null
  sgst_amount: number | null
  igst_amount: number | null
  cess_amount: number | null
  total_tax: number | null
  round_off: number | null
  grand_total: number | null
}

export type ParsedBill = {
  source_type: 'image-ocr' | 'pdf-text' | 'pasted-text'
  vendor_name: string
  vendor_gstin: string
  vendor_state_code: string
  bill_number: string
  bill_date: string // yyyy-mm-dd
  due_date: string
  place_of_supply_code: string
  place_of_supply_name: string
  line_items: ParsedLineItem[]
  declared: DeclaredTotals
  is_gst_doc: boolean
  is_reverse_charge: boolean
  confidences: Record<string, number>
  gstins_found: string[]
  warnings: string[]
  raw_text: string
}

const EMPTY_TOTALS: DeclaredTotals = {
  taxable_amount: null, cgst_amount: null, sgst_amount: null, igst_amount: null,
  cess_amount: null, total_tax: null, round_off: null, grand_total: null,
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

const UNIT_RE = /\b(pcs?|nos?|kgs?|gm|ltrs?|litres?|liters?|box|boxes|packet|pack|set|dozen|mts?|mtr|sqft|feet|roll|bottle|units?|bag|carton|pair)\b/i

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// --- text normalisation -----------------------------------------------------

/**
 * OCR renders the same field several ways. Fix only what is unambiguous here —
 * separators between digits belong to parseAmount(), never to this function,
 * because collapsing whitespace merges two adjacent table columns into one
 * number.
 */
export function normalizeBillText(input: string): string {
  return String(input || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[‘’`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/[   ]/g, ' ')
    .replace(/₹\s*/g, 'Rs ')
    .replace(/\bRs\.?\s*/gi, 'Rs ')
    .replace(/[|¦]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/**
 * Amounts as printed on Indian bills: 1,23,456.78 | 18,570.00 | Rs 5000/-
 */
export function parseAmount(raw: string): number | null {
  let s = String(raw).trim().replace(/^(?:rs|inr)\s*/i, '').replace(/\/-\s*$/, '').replace(/~/g, '')
  const neg = /^-/.test(s)
  s = s.replace(/[^0-9.,]/g, '')
  if (!s || !/\d/.test(s)) return null

  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')

  let cleaned = s
  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point
    cleaned = lastComma > lastDot ? s.replace(/\./g, '').replace(/,/g, '.') : s.replace(/,/g, '')
  } else if (lastComma > -1) {
    const after = s.length - lastComma - 1
    cleaned = after === 3 ? s.replace(/,/g, '') : s.replace(/,/g, '.')
  } else if (lastDot > -1) {
    const dots = s.split('.').length - 1
    cleaned = dots > 1 ? s.replace(/\./g, '') : s
  }

  const parts = cleaned.split('.')
  if (parts.length > 2) cleaned = parts.slice(0, -1).join('') + '.' + parts[parts.length - 1]

  const value = parseFloat(cleaned)
  if (!isFinite(value)) return null
  return neg ? -value : value
}

// --- GSTIN ------------------------------------------------------------------

// 2-digit state code + 10-char PAN + 1 check char + entity code + Z + checksum
const GSTIN_RE = /\b([1-9][0-9][A-Z]{5}[0-9A-Z]{4}[A-Z][0-9A-Z]Z[0-9A-Z])\b/g
const GSTIN_SHAPE = /^[0-9A-Z]{15}$/

/**
 * OCR confuses 0/O, 1/I/L and 5/S inside the fixed-position parts of a GSTIN.
 * Substitute only where the character class demands a digit.
 */
function fixGstinShape(token: string): string {
  const c = token.toUpperCase().split('')
  c[0] = c[0].replace(/O/, '0')
  c[1] = c[1].replace(/[O]/, '0')
  for (let i = 9; i <= 12; i++) c[i] = (c[i] || '').replace(/[OIL]/g, ch => (ch === 'O' ? '0' : '1'))
  c[14] = (c[14] || '').replace(/O/, '0')
  return c.join('')
}

function isRealGstin(g: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9A-Z]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(g)
    && !!INDIAN_STATES[g.slice(0, 2)]
}

function collectGstins(text: string, sink: string[]): void {
  const upper = text.toUpperCase()
  const add = (candidate: string) => {
    const repaired = fixGstinShape(candidate)
    if (isRealGstin(repaired) && !sink.includes(repaired)) sink.push(repaired)
  }
  for (const m of upper.matchAll(GSTIN_RE)) add(m[1])
  for (const token of upper.split(/[^A-Z0-9]+/)) {
    if (GSTIN_SHAPE.test(token)) add(token)
  }
}

/**
 * The most common OCR failure is a GSTIN split across spaces ("07AABCf 1234K
 * 1Z9"). Anchor on the label, compact the value window, then re-try.
 */
function findGstinsByLabel(text: string, sink: string[]): void {
  const re = /\b(?:gstin(?:\/uin)?|gst\s*(?:no|number|tin)|uin)\s*[:\-]?\s*(.{12,30})/gi
  for (const m of text.matchAll(re)) {
    const compact = m[1].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15)
    for (let i = 0; i + 15 <= compact.length; i++) {
      const window = compact.slice(i, i + 15)
      const candidate = isRealGstin(window) ? window : fixGstinShape(window)
      if (isRealGstin(candidate) && !sink.includes(candidate)) sink.push(candidate)
    }
  }
}

export function findGstins(text: string): string[] {
  const found: string[] = []
  collectGstins(text, found)
  findGstinsByLabel(text, found)
  return found
}

export function stateNameFromCode(code: string): string {
  return INDIAN_STATES[code] || ''
}

// --- dates ------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function toIsoDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function buildDate(day: number, month: number, year: number): string | null {
  if (!isFinite(day) || !isFinite(month) || !isFinite(year)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const full = year < 100 ? (year > 30 ? 1900 + year : 2000 + year) : year
  if (full < 2015 || full > 2199) return null
  const d = new Date(Date.UTC(full, month - 1, day))
  if (d.getUTCDate() !== day || d.getUTCMonth() !== month - 1) return null
  return toIsoDate(d)
}

// Slashes are frequently spaced apart by OCR: "15 / 04 / 2026"
const NUM_DATE_RE = /\b(\d{1,2})\s*[\/\-.]\s*(\d{1,2})\s*[\/\-.]\s*(\d{2,4})\b/g
const TEXT_DATE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{2,4})\b/g
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g

/**
 * Indian bills print dd/mm/yyyy. When the month slot exceeds 12 the two slots
 * are swapped instead of dropped — a western-format reading is far more likely
 * than an invalid date.
 */
export function parseDateToken(a: string, b: string, y: string): string | null {
  const day = parseInt(a, 10)
  const month = parseInt(b, 10)
  const year = parseInt(y, 10)
  if (month > 12 && day <= 12) return buildDate(month, day, year)
  return buildDate(day, month, year)
}

function findDates(text: string): string[] {
  const dates: string[] = []
  const add = (d: string | null) => { if (d && !dates.includes(d)) dates.push(d) }

  for (const m of text.matchAll(NUM_DATE_RE)) add(parseDateToken(m[1], m[2], m[3]))
  for (const m of text.matchAll(TEXT_DATE_RE)) {
    const month = MONTHS[m[2].slice(0, 3).toLowerCase()]
    if (month) add(buildDate(parseInt(m[1], 10), month, parseInt(m[3], 10)))
  }
  for (const m of text.matchAll(ISO_DATE_RE)) add(buildDate(parseInt(m[3], 10), parseInt(m[2], 10), parseInt(m[1], 10)))
  return dates
}

// --- boilerplate / labels ---------------------------------------------------

/**
 * Letterhead that must never be mistaken for a supplier name or a line item.
 * Patterns tolerate the usual OCR substitutions (I for l, F for E).
 */
function looksLikeBoilerplate(line: string): boolean {
  const l = line.toUpperCase()
  return /TAX\s*INV|INV[0O]I?C[EF]|ORIG[IN][AAL]|RECEIPT|REC[I1]PT|E-?INVOICE|GST\s*(INVOICE|BILL)|\bGST\s*(NO|NO\.|NUMBER|TIN)\b|GSTIN|UIN\b|\bPAN\b|\bCIN\b|EMAIL|@[A-Z0-9.-]+\.[A-Z]{2,}|PHONE|MOBILE|TEL\s*[:.]|WWW\.|HTTP|PLACE\s*OF\s*SUPPLY|BANK|IFSC|A\/C\s*NO|DESCRIPTION|QUANTITY|RATE\b|DISCOUNT|PAGE\s*\d/.test(l)
}

function isTotalsLabel(line: string): boolean {
  return /^(total|grand\s*total|round\s*off|taxable|basic|cgst|sgst|igst|cess|amount\s*(payable|due)|invoice\s*total|no\.?\s*of)/i.test(line.trim())
    || (/(cgst|sgst|igst)/i.test(line) && /(total|taxable|round)/i.test(line))
}

// --- labelled lookups -------------------------------------------------------

type LabelHit = { value: number | null; line: string }

/**
 * Find a figure that a label announces. Rates are skipped: "IGST @ 18% :
 * 5643.00" declares the amount, not 18.
 */
function labelledNumber(text: string, label: RegExp, opts: { min?: number } = {}): LabelHit {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(label)
    if (!m) continue
    const after = lines[i].slice((m.index || 0) + m[0].length)
    const tokens = after.match(/(?:Rs\s*)?-?\d[\d,.]*\s*%?|-?\d[\d,.]*\s*%/g) || []
    for (const t of tokens) {
      if (/%/.test(t)) continue
      const value = parseAmount(t)
      if (value !== null && value >= (opts.min ?? 0)) return { value, line: lines[i] }
    }
    const next = (lines[i + 1] || '').trim()
    if (/^(?:Rs\s*)?\d[\d,.]*\s*\/?-$/.test(next)) {
      const value = parseAmount(next)
      if (value !== null && value >= (opts.min ?? 0)) return { value, line: next }
    }
  }
  return { value: null, line: '' }
}

function labelledText(text: string, label: RegExp): string {
  for (const line of text.split('\n')) {
    const m = line.match(label)
    if (!m) continue
    const after = line.slice((m.index || 0) + m[0].length).replace(/^[\s:.\-#]+/, '').trim()
    if (after) return after.split(/\s{2,}|\t/)[0].slice(0, 60)
  }
  return ''
}

// --- bill number ------------------------------------------------------------

const BILL_VALUE = '[A-Z0-9][A-Z0-9._\\-/]{2,24}'
// Tolerant of OCR letter swaps inside the label itself (BIII for BILL, INVOICF)
const BILL_NO_LABELS = new RegExp(
  String.raw`\b(?:tax\s*inv[a-z]{2,4}|inv[o0][a-z]{1,4}|b[i1l]{3,4}[a-z]{0,3}|cash\s*b[i1l]{2,4}[a-z]{0,3}|recap|challan|delivery\s*note|d[c]|memo|ref(?:erence)?)\s*(?:no|number|num|#)?\s*[.:#\-/]*\s*(?:no\.?\s*[.:#\-]\s*)?(${BILL_VALUE})`,
  'i'
)

function isDateLike(token: string): boolean {
  return /^\d{1,4}[\/\-.]\s*\d{1,2}([\/\-.]\s*\d{2,4})?$/.test(token.trim())
}

function extractBillNumber(text: string): { value: string; confidence: number } {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (looksLikeBoilerplate(line) && !/invoice\s*no|bill\s*no/i.test(line)) continue
    const m = line.match(BILL_NO_LABELS)
    if (!m) continue
    let candidate = m[1]
    if (isDateLike(candidate)) {
      // Label matched the date instead; take another token from the same line
      candidate = (line.split(/[\s,;|]+/).find(tok =>
        new RegExp(`^${BILL_VALUE}$`, 'i').test(tok) && /\d/.test(tok) && !isDateLike(tok) && tok !== m[1]
      )) || ''
    }
    if (candidate && /\d/.test(candidate) && !isDateLike(candidate)) {
      const value = candidate.replace(/[.,;]+$/, '').toUpperCase()
      const precise = /invoice\s*no|bill\s*no|recap|challan|ref/i.test(line)
      return { value, confidence: precise ? 0.9 : 0.7 }
    }
  }

  // Convention-shaped: INV-2026-27-0011, /2026-27/0045, 24771/A
  const shaped = text.toUpperCase().match(/\b((?:INV|BILL|BIL|SW|CW|REC|IV|RC)[A-Z\-/_.]?[0-9][A-Z0-9\-/_.]{3,20})\b/)
  if (shaped) return { value: shaped[1].replace(/[.,;]+$/, ''), confidence: 0.6 }

  const slashish = text.toUpperCase().match(/\b(\d{3,7}\/[A-Z]{1,3}\b(?!\d))/)
  if (slashish) return { value: slashish[1], confidence: 0.45 }

  return { value: '', confidence: 0 }
}

// --- line items -------------------------------------------------------------

type NumTok = { value: number; isHsn: boolean; isPercent: boolean; raw: string }

const PURE_NUM = /^[\/\-.,0-9]+$/

function tokenizeLine(line: string): { name: string; hsn: string; unit: string; nums: NumTok[] } {
  const tokens = line.split(/\s+/).filter(Boolean)
  const isNum = (t: string) => PURE_NUM.test(t) && /\d/.test(t)

  // Drop a leading Sr.No when the next token is text again
  if (tokens.length > 2 && isNum(tokens[0]) && /[A-Za-z]/.test(tokens[1]) && !isNum(tokens[1])) {
    tokens.shift()
  }

  const nameParts: string[] = []
  const nums: NumTok[] = []
  let hsn = ''
  let unit = ''
  let seenNumbers = false

  for (const t of tokens) {
    if (isNum(t) || /%$/.test(t) || /^%/.test(t)) {
      seenNumbers = true
      const isPercent = /%/.test(t)
      const bare = t.replace(/[^0-9.,]/g, '')
      const value = parseAmount(bare)
      if (value === null) continue
      const isHsn = !isPercent && /^\d{6,8}$/.test(bare) && !/[.,]/.test(bare)
      if (isHsn && !hsn) hsn = bare
      nums.push({ value, isHsn, isPercent, raw: t })
      continue
    }
    const unitMatch = t.match(UNIT_RE)
    if (unitMatch && seenNumbers) { unit = unitMatch[1].toUpperCase(); continue }
    // Text appearing after the figures is a trailing column (% / Nos), not a name
    if (!seenNumbers) nameParts.push(t)
  }

  return { name: nameParts.join(' ').trim(), hsn, unit, nums }
}

/**
 * A bill row is accepted only when its own arithmetic agrees:
 * qty x rate (less discount) = taxable, and taxable x (1 + gst%) = row total.
 * OCR reorders and drops columns freely; the arithmetic does not move. Rows
 * that fail every combination are left alone instead of invented.
 */
function parseLineItems(text: string, defaultGstRate: number | null, inferredGstRate: number | null): ParsedLineItem[] {
  const items: ParsedLineItem[] = []

  for (const line of text.split('\n')) {
    if (line.length < 10) continue
    if (isTotalsLabel(line) || looksLikeBoilerplate(line)) continue

    const { name, hsn, unit, nums } = tokenizeLine(line)
    if (name.replace(/[^A-Za-z]/g, '').length < 3) continue
    if (/(hsn|taxable|cgst|sgst|igst|qty|rate)/i.test(name)) continue

    // Amount column: excludes the HSN code and any percentage column
    const amts = nums.filter(n => !n.isHsn)
    if (amts.length < 2) continue
    const pcts = nums.filter(n => n.isPercent).map(n => n.value)

    let best: { score: number; item: ParsedLineItem } | null = null

    for (let ti = 0; ti < amts.length; ti++) {
      const taxable = amts[ti].value
      if (taxable <= 0) continue

      for (let ri = ti + 1; ri < amts.length; ri++) {
        const rowTotal = amts[ri].value
        if (rowTotal <= taxable) continue
        if (rowTotal > taxable * 1.45) continue // no legal GST rate above 28% + cess

        const implied = (rowTotal - taxable) / taxable * 100
        const gstRate = GST_RATES.find(r => r > 0 && Math.abs(r - implied) < 0.75) ?? defaultGstRate
        if (gstRate === null || gstRate === 0) continue
        if (Math.abs(taxable * (1 + gstRate / 100) - rowTotal) > Math.max(1.5, taxable * 0.01)) continue

        // qty x rate = taxable, optionally after a discount percentage
        let quantity = 1
        let rate = taxable
        let discountPercent = pcts.length ? pcts[0] : 0
        let qtyFound = false
        for (let qi = 0; qi < ti; qi++) {
          for (let rj = qi + 1; rj <= ti; rj++) {
            const q = amts[qi].value
            const r = amts[rj].value
            if (q <= 0 || r <= 0 || q > 1e6 || r > 1e8) continue
            const gross = q * r
            if (Math.abs(gross - taxable) <= Math.max(0.06, taxable * 0.001)) {
              quantity = q; rate = r; discountPercent = 0; qtyFound = true
              break
            }
            for (const d of [5, 10, 15, 20, 25, 30, 40, 50]) {
              if (Math.abs(gross * (1 - d / 100) - taxable) <= Math.max(0.06, taxable * 0.001)) {
                quantity = q; rate = r; discountPercent = d; qtyFound = true
                break
              }
            }
            if (qtyFound) break
          }
          if (qtyFound) break
        }

        let score = 1
        if (ri === amts.length - 1) score += 1.5            // row total is the last column
        if (ti === amts.length - 2) score += 0.8
        if (qtyFound) score += 1.2
        if (hsn) score += 0.4
        if (gstRate === defaultGstRate) score += 0.3

        const item: ParsedLineItem = {
          item_name: name.slice(0, 80),
          hsn_sac: hsn,
          quantity,
          unit: unit || 'PCS',
          rate: round2(rate),
          discount_percent: discountPercent,
          gst_rate: gstRate,
          taxable_value: round2(taxable),
          source: 'table',
          line_text: line.trim(),
        }
        if (!best || score > best.score) best = { score, item }
        if (qtyFound) break
      }
    }

    if (!best) {
      // Simplified invoices print Qty | Rate | Amount and put GST only in the
      // page totals. Here the last column is the taxable value, and the rate
      // has to come from the document as a whole.
      const rowRate = defaultGstRate ?? inferredGstRate
      if (rowRate !== null) {
        const last = amts[amts.length - 1]
        for (let qi = 0; qi < amts.length - 1 && !best; qi++) {
          for (let rj = qi + 1; rj < amts.length - 1; rj++) {
            const q = amts[qi].value
            const r = amts[rj].value
            if (q <= 0 || r <= 0 || last.value <= 0) continue
            if (Math.abs(q * r - last.value) > Math.max(0.06, last.value * 0.001)) continue
            best = {
              score: 0.9,
              item: {
                item_name: name.slice(0, 80),
                hsn_sac: hsn,
                quantity: q,
                unit: unit || 'PCS',
                rate: round2(r),
                discount_percent: 0,
                gst_rate: rowRate,
                taxable_value: round2(last.value),
                source: 'table',
                line_text: line.trim(),
              },
            }
            break
          }
        }
      }
    }

    if (best && !items.some(i => i.taxable_value === best!.item.taxable_value && i.item_name === best!.item.item_name)) {
      items.push(best.item)
    }
  }

  return items
}

// --- main -------------------------------------------------------------------

export type ExtractOptions = { sourceType?: ParsedBill['source_type'] }

export function extractBill(rawText: string, options: ExtractOptions = {}): ParsedBill {
  const text = normalizeBillText(rawText)
  const upper = text.toUpperCase()
  const warnings: string[] = []

  const gstins = findGstins(text)
  const billNo = extractBillNumber(text)
  const dates = findDates(text)

  const declared: DeclaredTotals = { ...EMPTY_TOTALS }
  declared.taxable_amount = labelledNumber(text, /\b(?:total\s*)?(?:taxable|assessable|basic|base)\s*(?:value|amount|total)?\b/i).value
  declared.cgst_amount = labelledNumber(text, /\bcgst\b/i).value
  declared.sgst_amount = labelledNumber(text, /\bsgst\b/i).value
  declared.igst_amount = labelledNumber(text, /\bigst\b/i).value
  declared.cess_amount = labelledNumber(text, /\bcess\b/i).value
  declared.total_tax = labelledNumber(text, /\b(?:total\s*tax|tax\s*amount|gst\s*total)\b/i).value
  declared.round_off = labelledNumber(text, /\bround\s*o(?:ff|f)?\b/i).value
  declared.grand_total = labelledNumber(
    text,
    /\b(?:grand\s*total|invoice\s*total|total\s*amount|amount\s*(?:payable|due|to\s*be\s*paid))\b/i
  ).value
  if (declared.grand_total === null) {
    // A bare "Total" is only trustworthy as the last figure in the document
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/\btotal\b/i.test(lines[i]) && !/taxable|discount|tax|qty|quantity/i.test(lines[i])) {
        const hit = labelledNumber(lines[i], /\btotal\b/i).value
        if (hit !== null) { declared.grand_total = hit; break }
      }
    }
  }

  if (declared.total_tax === null) {
    const parts = [declared.cgst_amount, declared.sgst_amount, declared.igst_amount, declared.cess_amount]
      .filter((n): n is number => n !== null)
    if (parts.length) declared.total_tax = round2(parts.reduce((s, n) => s + n, 0))
  }

  const defaultGstRate = GST_RATES.find(r => r > 0 && new RegExp(String.raw`\b${r}(?:\.0+)?\s*%`).test(upper)) ?? null

  // When no row and no label states the rate, the printed totals do: total tax
  // over taxable value.
  const inferredGstRate = declared.taxable_amount && declared.total_tax !== null && declared.taxable_amount > 0
    ? GST_RATES.find(r => r > 0 && Math.abs(r - (declared.total_tax as number) / declared.taxable_amount! * 100) < 0.75) ?? null
    : null

  let lineItems = parseLineItems(text, defaultGstRate, inferredGstRate)

  // Single-line fallback so the draft stays saveable when the table is
  // unreadable; the review screen flags it as low confidence.
  if (!lineItems.length && declared.taxable_amount && declared.taxable_amount > 0) {
    const descGuess = labelledText(text, /\b(?:description|items?|particulars)\b/i)
    const headerish = /hsn|sac|qty|quantity|rate|taxable|discount|cgst|sgst|igst|amount/i.test(descGuess)
    lineItems = [{
      item_name: headerish || !descGuess ? 'Bill value as per printed totals' : descGuess,
      hsn_sac: '',
      quantity: 1,
      unit: 'PCS',
      rate: declared.taxable_amount,
      discount_percent: 0,
      gst_rate: defaultGstRate ?? inferredGstRate ?? 18,
      taxable_value: declared.taxable_amount,
      source: 'single',
      line_text: '',
    }]
    warnings.push('Line items could not be read. One line was created from the printed totals — check it before saving.')
  }

  // On a purchase bill both the supplier's and our own GSTIN can appear; ours
  // is the one announced as buyer/receiver.
  let vendorGstin = gstins[0] || ''
  if (gstins.length > 1) {
    const lines = text.toUpperCase().split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (!/GSTIN|UIN|GST\s*(NO|NUMBER|TIN)/.test(lines[i])) continue
      const block = lines.slice(i, i + 3).join(' ')
      if (/BUYER|RECEIVER|INVOICEE|BILLED\s*TO|SHIP(?:PING)?\s*TO|DELIVERY\s*ADDRESS/.test(block)) {
        for (const g of gstins.filter(x => block.includes(x))) {
          if (vendorGstin === g) vendorGstin = gstins.find(x => x !== g) || ''
        }
      }
    }
  }

  const vendorName = (() => {
    const labelled = labelledText(text, /\b(?:from|supplier|vendor|billed\s*by|issuer|firm)\b\s*[:\-]?\s*$/i)
    if (labelled && /[A-Za-z]{3}/.test(labelled)) return labelled

    const lines = text.split('\n')
    const gstinLine = lines.findIndex(l => findGstins(l).length > 0)
    const scanTo = gstinLine > -1 ? gstinLine : Math.min(8, lines.length)
    for (let i = 0; i < scanTo; i++) {
      const l = lines[i].trim()
      if (l.length < 4 || !/[A-Za-z]{4}/.test(l)) continue
      if (looksLikeBoilerplate(l)) continue
      const stripped = l
        .replace(/(?:GSTIN\s*\/?\s*UIN|GSTIN|UIN|GST\s*(?:NO|NUMBER|TIN))\s*[:\-]?\s*[0-9A-Z\s\-/:.]{6,22}/gi, '')
        .replace(/[0-9]{2}[A-Z]{5}[0-9A-Z]{4}[A-Z][0-9A-Z]Z[0-9A-Z]/g, '')
        .trim()
      if (stripped.length >= 4 && /[A-Za-z]{4}/.test(stripped)) return stripped.slice(0, 60)
    }
    return ''
  })()

  const placeOfSupply = (() => {
    const m = text.match(/\bplace\s*of\s*supply\s*[:\-]?\s*(?:\([A-Za-z\s&.]*\)\s*)?(\d{2})\b/i)
    if (m) return { code: m[1], name: stateNameFromCode(m[1]) }
    const named = text.match(/\bplace\s*of\s*supply\s*[:\-]+([A-Za-z][A-Za-z\s&.]{2,28})/i)
    if (named) {
      const name = named[1].trim().split('\n')[0].slice(0, 40)
      const code = Object.entries(INDIAN_STATES).find(([, n]) => n.toLowerCase() === name.toLowerCase())?.[0] || ''
      return { code, name }
    }
    return { code: '', name: '' }
  })()

  const isGstDoc = /TAX\s*INV|CGST|SGST|IGST|GSTIN|HSN|SAC/i.test(upper) || gstins.length > 0
  const isReverseCharge = /REVERSE\s*CHARGE/i.test(upper) && !/NOT\s+ATTRACT|WITHOUT\s*GST|NON[-\s]?B2B/i.test(upper)

  // --- cross-validation: GST arithmetic is the cheapest accuracy check ---
  if (lineItems.length && declared.taxable_amount !== null && lineItems[0].source === 'table') {
    const computed = round2(lineItems.reduce((s, i) => s + i.taxable_value, 0))
    if (Math.abs(computed - declared.taxable_amount) > Math.max(1, declared.taxable_amount * 0.005)) {
      warnings.push(`Read line values (Rs ${computed.toFixed(2)}) do not add up to the printed taxable value (Rs ${declared.taxable_amount.toFixed(2)}). Verify the lines.`)
    }
  }
  if (declared.taxable_amount !== null && declared.grand_total !== null) {
    const tax = declared.total_tax ?? 0
    if (declared.taxable_amount + tax > 0 && Math.abs(declared.taxable_amount + tax - declared.grand_total) > 2.5) {
      warnings.push(`Taxable Rs ${declared.taxable_amount.toFixed(2)} + GST Rs ${tax.toFixed(2)} is not the printed total Rs ${declared.grand_total.toFixed(2)}. Check the tax figures.`)
    }
  }
  if (isGstDoc && !gstins.length) warnings.push('This looks like a GST invoice but no valid GSTIN was found.')
  if (!dates.length) warnings.push('No bill date could be read.')

  const billDate = (() => {
    const labelled = labelledText(text, /\b(?:invoice|bill|tax\s*invoice|delivery|supply)\s*date\b/i)
    const labelHit = labelled.match(/(\d{1,2}\s*[\/\-.]\s*\d{1,2}\s*[\/\-.]\s*\d{2,4})/)
    if (labelHit) {
      const p = labelHit[1].split(/\s*[\/\-.]\s*/)
      const d = parseDateToken(p[0], p[1], p[2])
      if (d) return d
    }
    // Latest plausible date is the supply date; the earliest is usually
    // delivery-terms or validity text.
    const sorted = [...dates].sort()
    return sorted[sorted.length - 1] || ''
  })()

  const confidences: Record<string, number> = {
    vendor_gstin: gstins.length ? (vendorGstin ? 0.95 : 0.4) : (isGstDoc ? 0.2 : 0.6),
    vendor_name: vendorName ? 0.7 : 0.2,
    bill_number: billNo.confidence,
    bill_date: billDate ? (/\binvoice\s*date|\bbill\s*date/i.test(upper) ? 0.85 : 0.6) : 0,
    line_items: lineItems.length ? (lineItems[0].source === 'table' ? 0.75 : 0.4) : 0,
    grand_total: declared.grand_total !== null ? 0.85 : 0.2,
  }

  return {
    source_type: options.sourceType || 'pasted-text',
    vendor_name: vendorName,
    vendor_gstin: vendorGstin,
    vendor_state_code: vendorGstin.slice(0, 2),
    bill_number: billNo.value,
    bill_date: billDate,
    due_date: '',
    place_of_supply_code: placeOfSupply.code,
    place_of_supply_name: placeOfSupply.name,
    line_items: lineItems,
    declared,
    is_gst_doc: isGstDoc,
    is_reverse_charge: isReverseCharge,
    confidences,
    gstins_found: gstins,
    warnings,
    raw_text: rawText || '',
  }
}

/**
 * GST split for the draft, derived the way the app derives it everywhere else:
 * same state = CGST+SGST, different state = IGST.
 */
export function deriveTaxSplit(bill: ParsedBill, myStateCode: string): { type: 'cgst_sgst' | 'igst'; reason: string } {
  const pos = bill.place_of_supply_code || bill.vendor_state_code
  if (!pos) return { type: 'cgst_sgst', reason: 'Place of supply was not read — assumed local (CGST + SGST). Confirm.' }
  if (pos === myStateCode) return { type: 'cgst_sgst', reason: `Place of supply ${stateNameFromCode(pos)} is your state — CGST + SGST.` }
  return { type: 'igst', reason: `Place of supply ${stateNameFromCode(pos)} differs from your state — IGST.` }
}

/** True when the document reads like a plain expense receipt, not a tax invoice. */
export function isExpenseReceipt(bill: ParsedBill): boolean {
  if (bill.is_gst_doc && bill.vendor_gstin) return false
  return /CASH|CARD|UPI|PAID|RECEIPT|BILL|TOKEN|INVOICE/i.test(bill.raw_text.toUpperCase())
    && bill.declared.grand_total !== null
}
