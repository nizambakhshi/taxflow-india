// GST e-invoice (IRN) + e-way bill payload generation for the NIC e-invoice system.
// Generates the standard PT_AUD JSON (Ctx "1.10") that can be signed/uploaded on the
// e-invoice GSP portal, plus a structured e-way bill details payload for portal entry.

import { INDIAN_STATES } from './constants'

export interface EiSeller {
  gstin: string
  legalName: string
  tradeName?: string
  address1?: string
  city?: string
  stateCode: string
  pincode?: string
}

export interface EiBuyer {
  gstin?: string
  name: string
  address1?: string
  address2?: string
  city?: string
  stateCode?: string
  pincode?: string
  country?: string
}

export interface EiLineItem {
  description: string
  hsnSac: string
  qty: number
  unit: string
  unitPrice: number
  discountAmount: number
  taxableValue: number
  gstRate: number // combined effective rate (e.g. 18 for 9+9 or 18 IGST)
  igst: number
  cgst: number
  sgst: number
  cess: number
}

export interface EiTotals {
  taxable: number
  discount: number
  igst: number
  cgst: number
  sgst: number
  cess: number
  roundOff: number
  grandTotal: number
}

export interface EiInvoiceInput {
  invoiceNumber: string
  invoiceDate: string // yyyy-mm-dd
  dueDate?: string | null
  referenceNumber?: string | null
  referenceDate?: string | null
  documentType?: 'INV' | 'CRN' | 'DBN'
  reverseCharge?: boolean
  isExport?: boolean
  placeOfSupply: string
  buyer: EiBuyer
  items: EiLineItem[]
  totals: EiTotals
}

export const E_INVOICE_CTX_VERSION = '1.10'
const AMOUNT_TOLERANCE = 1
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// yyyy-mm-dd -> dd-MMM-yyyy (NIC date format)
export function toNicDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return `${m[3]}-${MONTHS[Number(m[2]) - 1]}-${m[1]}`
}

export function stateNameFor(code: string | undefined | null): string {
  if (!code) return ''
  return INDIAN_STATES.find(s => s.value === code)?.label || ''
}

// NIC requires a standard unit code (KGS, NOS, MTR, ...). Common aliases we store.
const UNIT_ALIASES: Record<string, string> = {
  KG: 'KGS', KGK: 'KGS', PC: 'PCS', NOS: 'NOS', NO: 'NOS',
  M: 'MTR', L: 'LTR', HR: 'HRS', DAY: 'DAY', MTH: 'MONTH',
}
export function mapUnit(unit: string | null | undefined): string {
  const u = (unit || '').trim().toUpperCase()
  return UNIT_ALIASES[u] || u || ''
}

export function deriveInvoiceType(input: EiInvoiceInput): string {
  if (input.isExport) return 'EXP'
  if (input.reverseCharge) return 'PPT'
  if (!normalize(input.buyer.gstin)) return 'UGSP'
  return 'RGC'
}

export const INVOICE_TYPE_LABELS: Record<string, string> = {
  RGC: 'Regular',
  UGSP: 'Unregistered buyer',
  PPT: 'Reverse charge',
  EXP: 'Export',
}

function normalize(v: string | null | undefined): string {
  return (v || '').trim().toUpperCase().replace(/\s+/g, '')
}

// ── Validation ───────────────────────────────────────────────────────────

export function validateEInvoice(seller: EiSeller, input: EiInvoiceInput): string[] {
  const issues: string[] = []

  const sellerGstin = normalize(seller.gstin)
  if (!sellerGstin) issues.push('Seller GSTIN is missing (add it in Settings / GST registration).')
  else if (!GSTIN_RE.test(sellerGstin)) issues.push(`Seller GSTIN "${sellerGstin}" is not a valid 15-character GSTIN.`)

  if (!input.invoiceNumber?.trim()) issues.push('Invoice number is missing.')
  if (!toNicDate(input.invoiceDate)) issues.push('Invoice date is missing or invalid.')
  if (!input.placeOfSupply) issues.push('Place of supply is missing.')

  if (!input.buyer.name?.trim()) issues.push('Buyer name is missing.')

  const buyerGstin = normalize(input.buyer.gstin)
  if (buyerGstin && !GSTIN_RE.test(buyerGstin)) {
    issues.push(`Buyer GSTIN "${buyerGstin}" is not valid — fix it on the customer master or clear it for unregistered sales.`)
  }

  const domestic = input.placeOfSupply !== '99' && input.placeOfSupply !== '01'
  const buyerState = buyerGstin ? buyerGstin.slice(0, 2) : normalize(input.buyer.stateCode)
  if (domestic && !buyerState) issues.push('Buyer state code is missing (needed for the address on the e-invoice).')
  if (domestic && !input.buyer.pincode?.trim()) issues.push('Buyer pincode is missing — add it on the customer master.')
  if (domestic && !input.buyer.address1?.trim()) issues.push('Buyer address line 1 is missing — add it on the customer master.')
  if (domestic && input.buyer.pincode && !/^\d{6}$/.test(input.buyer.pincode.trim())) {
    issues.push(`Buyer pincode "${input.buyer.pincode}" must be 6 digits.`)
  }

  if (input.documentType && input.documentType !== 'INV') {
    if (!input.referenceNumber?.trim()) issues.push('Credit/debit notes must carry a reference invoice number.')
    if (!toNicDate(input.referenceDate)) issues.push('Credit/debit notes must carry a reference invoice date.')
  }

  if (input.items.length === 0) issues.push('The invoice has no line items.')

  const seenHsn = new Set<string>()
  input.items.forEach((item, i) => {
    const n = i + 1
    if (!item.description?.trim()) issues.push(`Item ${n}: description is missing.`)
    const hsn = (item.hsnSac || '').replace(/\s/g, '')
    if (!hsn) issues.push(`Item ${n}: HSN/SAC code is missing.`)
    else if (!/^[0-9]{4,8}$/.test(hsn)) issues.push(`Item ${n}: HSN/SAC "${hsn}" must be 4, 6 or 8 digits.`)
    else {
      const cls = hsn.length > 6 ? hsn.slice(0, 6) : hsn
      if (seenHsn.size > 0) {
        const anyOther = [...seenHsn].find(h => h.startsWith(cls) || cls.startsWith(h))
        if (anyOther && anyOther !== cls && hsn.length < 8) {
          // NIC aggregates same HS-class items; flag for manual review
          issues.push(`Item ${n}: HSN ${hsn} shares a class with another item — NIC requires combining them on one line.`)
        }
      }
      seenHsn.add(cls)
    }
    if (!mapUnit(item.unit)) issues.push(`Item ${n}: unit is missing (NIC requires a standard unit like KGS, NOS, MTR).`)
    if (!(item.qty > 0)) issues.push(`Item ${n}: quantity must be greater than 0.`)
    if (item.taxableValue < 0) issues.push(`Item ${n}: taxable value cannot be negative.`)
  })

  const headSum = (get: (it: EiLineItem) => number) => input.items.reduce((a, it) => a + (get(it) || 0), 0)
  const crossChecks: [string, number, number][] = [
    ['taxable value', headSum(it => it.taxableValue), input.totals.taxable],
    ['IGST', headSum(it => it.igst), input.totals.igst],
    ['CGST', headSum(it => it.cgst), input.totals.cgst],
    ['SGST/UTGST', headSum(it => it.sgst), input.totals.sgst],
    ['cess', headSum(it => it.cess), input.totals.cess],
  ]
  for (const [head, itemsSum, invTotal] of crossChecks) {
    if (Math.abs(itemsSum - (invTotal || 0)) > AMOUNT_TOLERANCE) {
      issues.push(`Line-item ${head} total (₹${itemsSum.toFixed(0)}) does not match the invoice ${head} (₹${(invTotal || 0).toFixed(0)}).`)
    }
  }

  const computedGrand =
    input.totals.taxable - input.totals.discount +
    input.totals.igst + input.totals.cgst + input.totals.sgst + input.totals.cess +
    (input.totals.roundOff || 0)
  if (Math.abs(computedGrand - input.totals.grandTotal) > AMOUNT_TOLERANCE) {
    issues.push('Grand total does not equal taxable + tax heads − discount + rounding.')
  }
  if (!(input.totals.grandTotal > 0)) issues.push('Invoice value must be greater than zero.')

  return issues
}

// ── PT_AUD JSON builder ──────────────────────────────────────────────────

export function buildEInvoiceJson(seller: EiSeller, input: EiInvoiceInput): Record<string, unknown> {
  const docType = input.documentType || 'INV'
  const invoiceType = deriveInvoiceType(input)
  const buyerGstin = normalize(input.buyer.gstin)
  const buyerStateCode = buyerGstin ? buyerGstin.slice(0, 2) : normalize(input.buyer.stateCode) || input.placeOfSupply
  const foreign = input.placeOfSupply === '99' || input.placeOfSupply === '01'

  const itemDetails = input.items.map((item, i) => {
    const hsn = (item.hsnSac || '').replace(/\s/g, '')
    const hsClass = hsn.length > 6 ? hsn.slice(0, 6) : hsn
    const row: Record<string, unknown> = {
      SerialNo: String(i + 1),
      Description: item.description,
      HSClassCode: hsClass,
      HSN: hsn,
      TaxableValue: round2(item.taxableValue),
      UnitPrice: round2(item.unitPrice),
      Unit: mapUnit(item.unit),
      Quantity: item.qty,
      TaxRate: item.gstRate,
      IsNonGstAmount: 'N',
    }
    if (item.discountAmount > 0) row.DiscountAmount = round2(item.discountAmount)
    if (item.igst > 0) { row.IgstRate = item.gstRate; row.IgstAmount = round2(item.igst) }
    if (item.cgst > 0) { row.CgstRate = item.gstRate / 2; row.CgstAmount = round2(item.cgst) }
    if (item.sgst > 0) { row.SgstUtgstRate = item.gstRate / 2; row.SgstUtgstAmount = round2(item.sgst) }
    if (item.cess > 0) {
      row.CeassRate = item.taxableValue > 0 ? round2((item.cess / item.taxableValue) * 100) : 0
      row.CeassAmount = round2(item.cess)
    }
    return row
  })

  const totalValues: Record<string, unknown> = {
    TaxableAmount: round2(input.totals.taxable),
    IgstAmount: round2(input.totals.igst),
    CgstAmount: round2(input.totals.cgst),
    SgstUtgstAmount: round2(input.totals.sgst),
    CeassAmount: round2(input.totals.cess),
    RoundOff: round2(input.totals.roundOff),
    InvoiceValue: round2(input.totals.grandTotal),
  }
  if (input.totals.discount > 0) totalValues.DisAmtAllowance = round2(input.totals.discount)

  const buyerAddress: Record<string, unknown> = {
    Address1: input.buyer.address1 || input.buyer.name,
    Country: foreign ? (input.buyer.country || 'Other') : 'INDIA',
    Pincode: foreign ? 'NONE' : (input.buyer.pincode || '000000'),
    State: foreign ? (input.buyer.country || 'Other') : stateNameFor(buyerStateCode),
  }
  if (input.buyer.address2) buyerAddress.Address2 = input.buyer.address2
  if (!foreign && input.buyer.city) buyerAddress.Address2 = [input.buyer.city, buyerAddress.Address2].filter(Boolean).join(', ')

  const data: Record<string, unknown> = {
    InvoiceType: invoiceType,
    DocumentType: docType,
    InvoiceNumber: input.invoiceNumber,
    InvoiceDate: toNicDate(input.invoiceDate),
    BuyerGSTIN: buyerGstin || 'URP',
    BuyerName: input.buyer.name,
    BuyerAddress: buyerAddress,
    PlaceOfSupply: input.placeOfSupply,
    ItemDetails: itemDetails,
    TotalValues: totalValues,
  }
  if (input.referenceNumber) {
    data.ReferenceNumber = input.referenceNumber
    data.ReferenceDate = toNicDate(input.referenceDate)
  }
  if (input.dueDate) {
    data.PaymentDetails = { PaymentTerms: 'Other', PaymentDueDate: toNicDate(input.dueDate) }
  }

  return { Ctx: E_INVOICE_CTX_VERSION, Data: data }
}

function round2(n: number | null | undefined): number {
  return Math.round((n || 0) * 100) / 100
}

// ── E-way bill payload ───────────────────────────────────────────────────

export interface EwbInput {
  sellerGstin: string
  sellerName: string
  fromPincode: string
  fromPlace: string
  buyerName: string
  buyerGstin?: string
  toPincode: string
  toPlace: string
  toStateCode: string
  invoiceNumber: string
  invoiceDate: string // yyyy-mm-dd
  transactionType: 'O' | 'C' | 'D' | 'E' // Outward / Inward / Both / Export (buyer supplies)
  transportMode: 'Road' | 'Rail' | 'Air' | 'Ship'
  vehicleType?: 'Regular' | 'Hired' | 'Consignor own' | 'Consignee own'
  vehicleNumber?: string
  transportDocumentNumber?: string
  transportDocumentDate?: string | null
  transporterId?: string
  transporterName?: string
  distanceKm: number
  itemSummary: { description: string; hsnSac: string; qty: number }[]
}

const TRANSPORT_MODE_CODES: Record<EwbInput['transportMode'], string> = {
  Road: '1', Rail: '2', Air: '3', Ship: '4',
}
const VEHICLE_TYPE_CODES: Record<NonNullable<EwbInput['vehicleType']>, string> = {
  Regular: '1', Hired: '2', 'Consignor own': '3', 'Consignee own': '4',
}

// Structured payload mirroring the GSP e-way bill API v1.1 request shape.
// Kept as a downloadable helper: verify codes against your GSP before API submission.
export function buildEwbJson(input: EwbInput): Record<string, unknown> {
  const buyerGstin = normalize(input.buyerGstin)
  const dmy = (iso: string | null) => {
    const m = (iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null
  }
  const dat = dmy(input.invoiceDate)
  const ewbType = normalize(input.sellerGstin).slice(0, 2) === input.toStateCode ? 'O' : 'I'
  return {
    version: '1.1.04',
    requestUser: 'C',
    requestData: {
      action: 'GEN',
      ewbType, // 'I' inter-state, 'O' intra-state
      dat: dat || input.invoiceDate,
      tst: dat ? `${dat} 12:00:00` : input.invoiceDate,
      transTyp: input.transactionType,
      fromGstin: input.sellerGstin,
      fromTrdnm: input.sellerName,
      fromPlc: input.fromPlace,
      fromPno: Number(input.fromPincode) || 0,
      toGstin: buyerGstin || 'ERS000000000001', // 'Everything' for unregistered receivers
      toTrdnm: input.buyerName,
      toPlc: input.toPlace,
      toPno: Number(input.toPincode) || 0,
      toSt: input.toStateCode,
      toDst: round2(input.distanceKm),
      dom: TRANSPORT_MODE_CODES[input.transportMode],
      conModel: '1', // by consignor
      vehTyp: input.vehicleType ? VEHICLE_TYPE_CODES[input.vehicleType] : undefined,
      vehNo: input.vehicleNumber || undefined,
      trdNo: input.transportDocumentNumber || undefined,
      trdDt: dmy(input.transportDocumentDate || input.invoiceDate) || undefined,
      traId: input.transporterId || undefined,
      traNm: input.transporterName || undefined,
      itemSummary: input.itemSummary.map((it, i) => ({
        itmdtl: i + 1,
       itmDesc: it.description,
        hsn: it.hsnSac,
        qty: it.qty,
      })),
    },
  }
}

export function downloadJson(filename: string, obj: unknown) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function safeFilePart(s: string): string {
  return (s || 'invoice').replace(/[^A-Za-z0-9_-]+/g, '_')
}
