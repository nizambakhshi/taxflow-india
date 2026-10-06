/**
 * Statutory registers built from the rows already in the database.
 * Everything here is pure and deterministic so a register can be re-derived and
 * audited: no schema changes, no server round-trips.
 */

import { stateNameFor } from '@/lib/einvoice'

export interface RegInvoice {
  id: string
  invoice_number: string
  invoice_date: string
  invoice_type?: string | null
  customer_id?: string | null
  customer_name: string | null
  customer_gstin?: string | null
  place_of_supply?: string | null
  supply_type?: string | null
  taxable_amount: number | string
  discount_amount?: number | string | null
  cgst_amount: number | string
  sgst_amount: number | string
  igst_amount: number | string
  cess_amount?: number | string | null
  grand_total: number | string
  document_type?: 'invoice' | 'credit_note' | 'debit_note'
}

export interface RegItem {
  invoice_id: string
  item_name: string
  hsn_sac?: string | null
  quantity: number | string
  unit?: string | null
  taxable_value: number | string
  gst_rate?: number | string | null
  cgst_amount: number | string
  sgst_amount: number | string
  igst_amount: number | string
  cess_amount?: number | string | null
}

const num = (v: unknown) => Number(v ?? 0) || 0

/** Credit notes reduce outward turnover; debit notes added later belong to the invoice they reference. */
function signed(inv: RegInvoice) {
  return inv.document_type === 'credit_note' ? -1 : 1
}

export interface PartySalesRow {
  key: string
  party: string
  gstin: string
  isB2B: boolean
  invoiceCount: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
  interstate: number
  intrastate: number
}

/** Turnover per customer — the table every CA asks for before finalising GSTR-1. */
export function partyWiseSales(invoices: RegInvoice[]): PartySalesRow[] {
  const map = new Map<string, PartySalesRow>()
  for (const inv of invoices) {
    const sign = signed(inv)
    const gstin = (inv.customer_gstin || '').trim().toUpperCase()
    const key = gstin ? `G:${gstin}` : `N:${norm(inv.customer_name)}`
    const row = map.get(key) || emptyParty(key, inv, gstin)
    const taxable = num(inv.taxable_amount) * sign
    const cgst = num(inv.cgst_amount) * sign
    const sgst = num(inv.sgst_amount) * sign
    const igst = num(inv.igst_amount) * sign

    row.invoiceCount += sign > 0 ? 1 : 0
    row.taxable += taxable
    row.cgst += cgst
    row.sgst += sgst
    row.igst += igst
    row.cess += num(inv.cess_amount) * sign
    // Signed, so a credit note on a local sale lowers the local figure rather than adding to it.
    if (igst !== 0) row.interstate += taxable
    else row.intrastate += taxable
    map.set(key, row)
  }
  return [...map.values()]
    .map(r => ({
      ...r,
      taxable: round2(r.taxable), cgst: round2(r.cgst), sgst: round2(r.sgst),
      igst: round2(r.igst), cess: round2(r.cess),
      interstate: round2(r.interstate), intrastate: round2(r.intrastate),
      total: round2(r.taxable + r.cgst + r.sgst + r.igst + r.cess),
    }))
    .sort((a, b) => b.taxable - a.taxable)
}

function emptyParty(key: string, inv: RegInvoice, gstin: string): PartySalesRow {
  return {
    key, party: inv.customer_name || 'Unnamed', gstin,
    isB2B: !!gstin, invoiceCount: 0,
    taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0,
    interstate: 0, intrastate: 0,
  }
}

export interface HsnRow {
  hsn: string
  descriptions: string[]
  units: string[]
  rates: number[]
  quantity: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  tax: number
  exempt: boolean
}

/**
 * HSN/SAC summary in the shape GSTR-1 Table 12 wants: one row per code with the
 * tax rates actually charged against it. Zero-rated and nil-rated codes surface
 * as exempt so they are not silently dropped from the return.
 */
export function hsnSummary(items: RegItem[], invoices: RegInvoice[]): HsnRow[] {
  const signs = new Map(invoices.map(i => [i.id, signed(i)]))
  const map = new Map<string, HsnRow & { qtyByUnit: Map<string, number> }>()

  for (const it of items) {
    const sign = signs.get(it.invoice_id) ?? 1
    const hsn = (it.hsn_sac || '').trim().toUpperCase() || 'Not specified'
    const unit = (it.unit || 'Unit').trim() || 'Unit'
    const unitKey = unit.toUpperCase()
    const row = map.get(hsn) || {
      hsn, descriptions: [], units: [], rates: [],
      quantity: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, tax: 0, exempt: false,
      qtyByUnit: new Map<string, number>(),
    }
    if (row.descriptions.length < 3 && !row.descriptions.includes(it.item_name)) {
      row.descriptions.push(it.item_name)
    }
    row.qtyByUnit.set(unitKey, (row.qtyByUnit.get(unitKey) || 0) + num(it.quantity) * sign)

    const taxable = num(it.taxable_value) * sign
    const cgst = num(it.cgst_amount) * sign
    const sgst = num(it.sgst_amount) * sign
    const igst = num(it.igst_amount) * sign
    const cess = num(it.cess_amount) * sign
    const rate = num(it.gst_rate)
    if (rate > 0 && !row.rates.includes(rate)) row.rates.push(rate)

    row.taxable += taxable
    row.cgst += cgst
    row.sgst += sgst
    row.igst += igst
    row.cess += cess
    map.set(hsn, row)
  }

  return [...map.values()]
    .map(({ qtyByUnit, ...row }: HsnRow & { qtyByUnit: Map<string, number> }) => {
      const tax = row.cgst + row.sgst + row.igst + row.cess
      return {
        ...row,
        // A code can carry several units; quantity is only meaningful when one unit was used.
        quantity: qtyByUnit.size === 1 ? [...qtyByUnit.values()][0] : 0,
        units: [...qtyByUnit.keys()],
        rates: row.rates.sort((a, b) => a - b),
        taxable: round2(row.taxable),
        cgst: round2(row.cgst),
        sgst: round2(row.sgst),
        igst: round2(row.igst),
        cess: round2(row.cess),
        tax: round2(tax),
        exempt: Math.abs(tax) < 0.5 && Math.abs(row.taxable) > 0.5,
      }
    })
    .sort((a, b) => b.taxable - a.taxable)
}

export interface B2bRow {
  invoiceId: string
  invoiceNumber: string
  invoiceDate: string
  party: string
  gstin: string
  placeOfSupply: string
  stateName: string
  documentType: string
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
}

/** Invoice-level B2B register — the line-by-line detail behind the party summary. */
export function b2bRegister(invoices: RegInvoice[]): B2bRow[] {
  return invoices
    .filter(i => (i.customer_gstin || '').trim().length >= 15)
    .map(i => {
      const sign = signed(i)
      const taxable = round2(num(i.taxable_amount) * sign)
      const cgst = round2(num(i.cgst_amount) * sign)
      const sgst = round2(num(i.sgst_amount) * sign)
      const igst = round2(num(i.igst_amount) * sign)
      const cess = round2(num(i.cess_amount) * sign)
      return {
        invoiceId: i.id,
        invoiceNumber: i.invoice_number,
        invoiceDate: i.invoice_date,
        party: i.customer_name || 'Unnamed',
        gstin: (i.customer_gstin || '').toUpperCase(),
        placeOfSupply: i.place_of_supply || '',
        stateName: stateNameFor(i.place_of_supply),
        documentType: i.document_type || 'invoice',
        taxable, cgst, sgst, igst, cess,
        total: round2(taxable + cgst + sgst + igst + cess),
      }
    })
    .sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate) || a.invoiceNumber.localeCompare(b.invoiceNumber))
}

export interface StateRow {
  code: string
  state: string
  invoiceCount: number
  taxable: number
  cgst: number
  sgst: number
  igst: number
  cess: number
  total: number
}

/**
 * State-wise summary of outward taxable supplies — the annexure required under
 * Rule 80(1) for accounts audits, and the fastest way to see where sales sit.
 */
export function stateWiseSales(invoices: RegInvoice[]): StateRow[] {
  const map = new Map<string, StateRow>()
  for (const inv of invoices) {
    const sign = signed(inv)
    const code = (inv.place_of_supply || '').trim().slice(0, 2) || '—'
    const row = map.get(code) || {
      code, state: code === '—' ? 'Unspecified' : stateNameFor(code),
      invoiceCount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0,
    }
    row.invoiceCount += sign > 0 ? 1 : 0
    row.taxable += num(inv.taxable_amount) * sign
    row.cgst += num(inv.cgst_amount) * sign
    row.sgst += num(inv.sgst_amount) * sign
    row.igst += num(inv.igst_amount) * sign
    row.cess += num(inv.cess_amount) * sign
    map.set(code, row)
  }
  return [...map.values()]
    .map(r => ({
      ...r,
      taxable: round2(r.taxable), cgst: round2(r.cgst), sgst: round2(r.sgst),
      igst: round2(r.igst), cess: round2(r.cess),
      total: round2(r.taxable + r.cgst + r.sgst + r.igst + r.cess),
    }))
    .sort((a, b) => b.taxable - a.taxable)
}

/** Register totals shown above every table so a page can be tied back to the ledger. */
export function totalsOf(rows: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; total: number }[]) {
  return rows.reduce((acc, r) => ({
    taxable: round2(acc.taxable + r.taxable),
    cgst: round2(acc.cgst + r.cgst),
    sgst: round2(acc.sgst + r.sgst),
    igst: round2(acc.igst + r.igst),
    cess: round2(acc.cess + r.cess),
    total: round2(acc.total + r.total),
  }), { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, total: 0 })
}

export type CsvValue = string | number | null | undefined

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const esc = (v: CsvValue) => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  // No BOM here — download() is the only caller path and it adds one itself.
  return [headers, ...rows].map(r => r.map(esc).join(',')).join('\r\n')
}

/* ── e-way bill register ─────────────────────────────────────────────
   EWB numbers live on the GST portal, not in this database, so the register is
   kept locally against the invoice it was raised for. */

const EWB_KEY = 'taxflow:ewb:'

export interface EwbEntry {
  invoiceId: string
  invoiceNumber: string
  party: string
  ewbNo: string
  validityEnd: string
  vehicleNumber?: string
  transportMode?: string
  fromPlace?: string
  toPlace?: string
  distanceKm?: string
  goodsValue?: number
  source: 'generated' | 'manual'
  createdAt: string
}

export function loadEwbLog(oid: string): EwbEntry[] {
  try {
    const raw = localStorage.getItem(EWB_KEY + oid)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveEwbLog(oid: string, entries: EwbEntry[]) {
  try {
    localStorage.setItem(EWB_KEY + oid, JSON.stringify(entries.slice(0, 2000)))
  } catch { /* storage full or private mode — register stays in memory */ }
}

export function upsertEwbEntry(oid: string, entry: EwbEntry): EwbEntry[] {
  const entries = loadEwbLog(oid).filter(e => e.invoiceId !== entry.invoiceId)
  saveEwbLog(oid, [entry, ...entries])
  return loadEwbLog(oid)
}

export function removeEwbEntry(oid: string, invoiceId: string): EwbEntry[] {
  saveEwbLog(oid, loadEwbLog(oid).filter(e => e.invoiceId !== invoiceId))
  return loadEwbLog(oid)
}

export function daysUntil(iso: string): number {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return Math.ceil((t - Date.now()) / 86400000)
}

function norm(s: string | null | undefined) {
  return (s || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function round2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100
}
