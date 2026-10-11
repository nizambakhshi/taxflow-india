'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import {
  determineGSTType,
  calculateLineItem,
  calculateInvoiceTotals,
  formatINR,
  type LineItemResult,
} from '@/lib/gst-engine'
import { INDIAN_STATES } from '@/lib/constants'
import { GST_RATES } from '@/lib/gst-rates'
import { createPurchaseBill } from '@/lib/create-bill'
import { askSeal } from '@/lib/audit'
import SealNotice from '@/components/SealNotice'
import {
  extractBill,
  deriveTaxSplit,
  isExpenseReceipt,
  stateNameFromCode,
  type ParsedBill,
} from '@/lib/bill-text'
import {
  acquireBillText,
  ScanOnlyPdfError,
  type OcrProgress,
} from '@/lib/ocr'
import { Badge, Button, Card, PageHeader, ProgressBar, SectionTitle, type Tone } from '@/components/ui'
import Icon from '@/components/Icons'

const EXPENSE_CATEGORIES = [
  'Office Supplies', 'Travel & Transport', 'Meals & Entertainment',
  'Rent', 'Utilities', 'Telephone & Internet', 'Professional Fees',
  'Repairs & Maintenance', 'Advertising & Marketing', 'Software & Subscriptions',
  'Insurance', 'Bank Charges', 'Salaries', 'Printing & Stationery',
  'Courier & Postage', 'Miscellaneous',
]

type DraftLine = {
  key: number
  product_id: string
  item_name: string
  hsn_sac: string
  quantity: string
  unit: string
  rate: string
  discount_percent: string
  gst_rate: string
  cess_rate: string
  itc_eligible: boolean
  calculated: LineItemResult | null
}

let lineKey = 0

function normalizeName(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !['pvt', 'ltd', 'llp', 'the', 'and', 'co', 'it', 'tp', 'trading'].includes(t))
}

/**
 * Suppliers print their name one way in the vendor master and another on the
 * bill ("Shree Ganesh Traders" vs "S G TRADERS"), so match on shared significant
 * words rather than on the string.
 */
function nameScore(a: string, b: string): number {
  const ta = normalizeName(a), tb = normalizeName(b)
  if (!ta.length || !tb.length) return 0
  const hits = ta.filter(t => tb.some(x => x.startsWith(t.slice(0, Math.max(3, Math.min(t.length, x.length)))))).length
  return hits / Math.max(ta.length, tb.length)
}

function confidenceBadge(value: number | undefined): { label: string; tone: Tone } {
  if (value === undefined || value <= 0) return { label: 'not read', tone: 'red' }
  if (value >= 0.8) return { label: 'high', tone: 'green' }
  if (value >= 0.55) return { label: 'medium', tone: 'amber' }
  return { label: 'low', tone: 'red' }
}

export default function ScanBillPage() {
  const supabase = createClient()
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [orgStateCode, setOrgStateCode] = useState('')
  const [vendors, setVendors] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])

  const [stage, setStage] = useState<'intake' | 'reading' | 'review'>('intake')
  const [progress, setProgress] = useState<OcrProgress | null>(null)
  const [error, setError] = useState('')
  const [langs, setLangs] = useState('eng')
  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [dragOver, setDragOver] = useState(false)

  const [parsed, setParsed] = useState<ParsedBill | null>(null)
  const [sourceText, setSourceText] = useState('')

  const [vendorId, setVendorId] = useState('')
  const [vendorName, setVendorName] = useState('')
  const [vendorGstin, setVendorGstin] = useState('')
  const [vendorStateCode, setVendorStateCode] = useState('')
  const [billNumber, setBillNumber] = useState('')
  const [billDate, setBillDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [placeOfSupply, setPlaceOfSupply] = useState('')
  const [isReverseCharge, setIsReverseCharge] = useState(false)
  const [itcEligible, setItcEligible] = useState(true)
  const [notes, setNotes] = useState('')
  const [saveMode, setSaveMode] = useState<'bill' | 'expense'>('bill')
  const [expenseCategory, setExpenseCategory] = useState('Office Supplies')
  const [lines, setLines] = useState<DraftLine[]>([])
  const [totals, setTotals] = useState<ReturnType<typeof calculateInvoiceTotals> | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAs, setSavedAs] = useState<{ kind: 'bill' | 'expense'; label: string } | null>(null)

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
      setOrgId(oid)

      const { data: gstReg } = await supabase
        .from('gst_registrations')
        .select('state_code')
        .eq('organization_id', oid)
        .eq('is_primary', true)
        .single()
      if (gstReg?.state_code) setOrgStateCode(gstReg.state_code)

      const [{ data: vendorData }, { data: productData }] = await Promise.all([
        supabase.from('vendors').select('*')
          .eq('organization_id', oid).eq('is_active', true).order('name'),
        supabase.from('products').select('*')
          .eq('organization_id', oid).eq('is_active', true).order('name'),
      ])

      setVendors(vendorData || [])
      setProducts(productData || [])
      setLoading(false)
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-run the shared GST engine whenever the draft changes
  useEffect(() => {
    if (!orgStateCode || !placeOfSupply || !lines.length) return
    const gstType = determineGSTType(orgStateCode, placeOfSupply, 'b2b')

    const calculated = lines.map(line => {
      const qty = parseFloat(line.quantity) || 0
      const rate = parseFloat(line.rate) || 0
      if (!qty || !rate) return { ...line, calculated: null }
      return {
        ...line,
        calculated: calculateLineItem({
          quantity: qty,
          rate,
          discount_percent: parseFloat(line.discount_percent) || 0,
          gst_rate: parseFloat(line.gst_rate) || 0,
          cess_rate: parseFloat(line.cess_rate) || 0,
        }, gstType),
      }
    })

    setLines(calculated)
    const valid = calculated.map(l => l.calculated).filter(Boolean) as LineItemResult[]
    setTotals(valid.length ? calculateInvoiceTotals(valid) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgStateCode, placeOfSupply, JSON.stringify(lines.map(l => ({
    q: l.quantity, r: l.rate, d: l.discount_percent, g: l.gst_rate, c: l.cess_rate,
  })))])

  function matchProduct(itemName: string, hsn: string) {
    let best: { product: any; score: number } | null = null
    for (const product of products) {
      const byHsn = hsn && product.hsn_sac && String(product.hsn_sac) === hsn ? 0.5 : 0
      const score = Math.max(nameScore(itemName, product.name || ''), byHsn)
      if (score >= 0.4 && (!best || score > best.score)) best = { product, score }
    }
    return best?.product || null
  }

  function buildDraft(bill: ParsedBill) {
    const byGstin = bill.vendor_gstin
      ? vendors.find(v => (v.gstin || '').toUpperCase() === bill.vendor_gstin)
      : null
    let byName: any = null
    let bestScore = 0
    for (const v of vendors) {
      const score = Math.max(nameScore(bill.vendor_name, v.name || ''), nameScore(bill.vendor_name, v.business_name || ''))
      if (score > bestScore) { bestScore = score; byName = v }
    }
    const vendor = byGstin || (bestScore >= 0.5 ? byName : null)

    setVendorId(vendor?.id || '')
    setVendorName(bill.vendor_name || vendor?.name || '')
    setVendorGstin(bill.vendor_gstin || vendor?.gstin || '')
    setVendorStateCode(bill.vendor_state_code || vendor?.state_code || '')
    setBillNumber(bill.bill_number)
    if (bill.bill_date) setBillDate(bill.bill_date)
    setDueDate(bill.due_date || '')
    setPlaceOfSupply(bill.place_of_supply_code || vendor?.state_code || orgStateCode || '')
    setIsReverseCharge(bill.is_reverse_charge)
    setNotes('')
    setSaveMode(bill.is_gst_doc && bill.vendor_gstin ? 'bill' : (isExpenseReceipt(bill) ? 'expense' : 'bill'))
    setLines(bill.line_items.map(item => {
      const product = matchProduct(item.item_name, item.hsn_sac)
      return {
        key: ++lineKey,
        product_id: product?.id || '',
        item_name: product?.name || item.item_name,
        hsn_sac: item.hsn_sac || product?.hsn_sac || '',
        quantity: String(item.quantity),
        unit: item.unit || product?.unit || 'PCS',
        rate: String(item.rate),
        discount_percent: String(item.discount_percent || 0),
        gst_rate: String(item.gst_rate || product?.gst_rate || 18),
        cess_rate: String(product?.cess_rate || 0),
        itc_eligible: true,
        calculated: null,
      }
    }))
  }

  async function handleText(text: string, sourceType: 'image-ocr' | 'pdf-text' | 'pasted-text') {
    const bill = extractBill(text, { sourceType })
    setParsed(bill)
    setSourceText(text)
    buildDraft(bill)
    setStage('review')
    if (!bill.line_items.length && bill.declared.grand_total === null) {
      setError('Text was read but no bill details could be recognised. Check the photo is sharp and upright, or paste the bill text.')
    }
  }

  async function handleFile(file: File | undefined | null) {
    if (!file) return
    setError('')
    setSavedAs(null)
    setStage('reading')
    try {
      const { text, sourceType } = await acquireBillText(file, { langs, onProgress: setProgress })
      await handleText(text, sourceType)
    } catch (err: any) {
      setStage('intake')
      if (err instanceof ScanOnlyPdfError) {
        setError('This PDF is a scanned picture with no text layer. Upload the bill photo instead, or the PDF your supplier emails you.')
      } else {
        setError(`Could not read the document: ${err?.message || 'unknown error'}. The OCR engine needs a connection the first time it runs.`)
      }
    } finally {
      setProgress(null)
    }
  }

  function updateLine(key: number, field: keyof DraftLine, value: any) {
    setLines(prev => prev.map(l => (l.key === key ? { ...l, [field]: value } : l)))
  }

  function selectProduct(key: number, productId: string) {
    const product = products.find(p => p.id === productId)
    setLines(prev => prev.map(l => l.key === key ? {
      ...l,
      product_id: productId,
      item_name: product?.name || l.item_name,
      hsn_sac: product?.hsn_sac || l.hsn_sac,
      unit: product?.unit || l.unit,
      gst_rate: String(product?.gst_rate || l.gst_rate),
    } : l))
  }

  function addLine() {
    setLines(prev => [...prev, {
      key: ++lineKey, product_id: '', item_name: '', hsn_sac: '', quantity: '1',
      unit: 'PCS', rate: '', discount_percent: '0', gst_rate: '18', cess_rate: '0',
      itc_eligible: true, calculated: null,
    }])
  }

  async function ensureVendor(): Promise<string> {
    if (vendorId) return vendorId
    if (!vendorName.trim()) throw new Error('Enter the supplier name, or pick an existing vendor.')

    const { data: created, error: createError } = await supabase
      .from('vendors')
      .insert({
        organization_id: orgId,
        name: vendorName.trim(),
        gstin: vendorGstin.toUpperCase() || null,
        state_code: vendorStateCode || vendorGstin.slice(0, 2) || null,
      })
      .select()
      .single()
    if (createError) throw createError

    setVendors(prev => [...prev, created].sort((a, b) => (a.name || '').localeCompare(b.name || '')))
    setVendorId(created.id)
    return created.id
  }

  async function handleSave() {
    if (!orgId) { setError('Still loading your workspace — try again in a second.'); return }
    const valid = lines.filter(l => l.item_name && parseFloat(l.rate) > 0 && parseFloat(l.quantity) > 0)
    if (!valid.length) { setError('Add at least one line with an item, quantity and rate.'); return }
    if (!billDate) { setError('Bill date is required.'); return }

    // A scanned receipt that lands as an *expense* is typed straight into the expenses table — no
    // shared creator carries the seal for it, so this page is that door. The scanned *bill* half
    // needs no ask here: `createPurchaseBill` asks the seal itself, throws the sentence, and the
    // catch at the bottom of this function prints it.
    if (saveMode === 'expense') {
      const stop = askSeal(orgId, { date: billDate, target: 'expense', ref: billNumber || 'scanned receipt' })
      if (stop) { setError(stop.why); return }
    }

    setSaving(true)
    setError('')

    try {
      if (saveMode === 'expense') {
        const grand = totals?.grand_total ?? parsed?.declared.grand_total ?? 0
        const taxable = totals?.taxable_amount ?? parsed?.declared.taxable_amount ?? grand
        const gstRate = parseFloat(valid[0].gst_rate) || 0
        const { error: expError } = await supabase.from('expenses').insert({
          organization_id: orgId,
          expense_date: billDate,
          category: expenseCategory,
          description: valid.map(l => l.item_name).join(', ').slice(0, 120),
          vendor_id: (await ensureVendor()) || null,
          vendor_name: vendorName,
          vendor_gstin: vendorGstin || null,
          bill_number: billNumber || null,
          amount: grand,
          gst_rate: gstRate,
          gst_amount: round2(grand - taxable),
          taxable_amount: taxable,
          itc_eligible: itcEligible,
          payment_status: 'unpaid',
          notes: notes || `Captured from ${parsed?.source_type === 'pdf-text' ? 'PDF' : 'scan'}`,
        })
        if (expError) throw expError
        setSavedAs({ kind: 'expense', label: `${expenseCategory} — Rs ${formatINR(grand)}` })
      } else {
        const id = await ensureVendor()
        const vendor = vendors.find(v => v.id === id)
        if (!placeOfSupply) throw new Error('Place of supply is required for a GST bill.')

        await createPurchaseBill(supabase, orgId, {
          bill_number: billNumber || `SCAN-${Date.now().toString().slice(-6)}`,
          bill_date: billDate,
          due_date: dueDate || null,
          vendor_id: id,
          vendor_name: vendor?.name || vendorName,
          vendor_gstin: vendor?.gstin || vendorGstin || null,
          vendor_state_code: vendor?.state_code || vendorStateCode || null,
          place_of_supply: placeOfSupply,
          place_of_supply_name: stateNameFromCode(placeOfSupply),
          is_reverse_charge: isReverseCharge,
          subtotal: totals?.subtotal ?? 0,
          discount_amount: totals?.discount_amount ?? 0,
          taxable_amount: totals?.taxable_amount ?? 0,
          cgst_amount: totals?.cgst_amount ?? 0,
          sgst_amount: totals?.sgst_amount ?? 0,
          igst_amount: totals?.igst_amount ?? 0,
          cess_amount: totals?.cess_amount ?? 0,
          total_tax: totals?.total_tax ?? 0,
          round_off: totals?.round_off ?? 0,
          grand_total: totals?.grand_total ?? 0,
          itc_eligible: itcEligible,
          amount_paid: 0,
          balance_due: totals?.grand_total ?? 0,
          payment_status: 'unpaid',
          notes: notes || `Captured from ${parsed?.source_type === 'pdf-text' ? 'PDF' : 'scan'}`,
          status: 'active',
        }, valid.map(l => ({
          product_id: l.product_id || null,
          item_name: l.item_name,
          hsn_sac: l.hsn_sac,
          quantity: parseFloat(l.quantity),
          unit: l.unit,
          rate: parseFloat(l.rate),
          discount_percent: parseFloat(l.discount_percent) || 0,
          discount_amount: l.calculated?.discount_amount || 0,
          taxable_value: l.calculated?.taxable_value || 0,
          gst_rate: parseFloat(l.gst_rate) || 0,
          cgst_rate: l.calculated?.cgst_rate || 0,
          sgst_rate: l.calculated?.sgst_rate || 0,
          igst_rate: l.calculated?.igst_rate || 0,
          cgst_amount: l.calculated?.cgst_amount || 0,
          sgst_amount: l.calculated?.sgst_amount || 0,
          igst_amount: l.calculated?.igst_amount || 0,
          cess_rate: parseFloat(l.cess_rate) || 0,
          cess_amount: l.calculated?.cess_amount || 0,
          total_amount: l.calculated?.total_amount || 0,
          itc_eligible: l.itc_eligible,
        })))

        setSavedAs({ kind: 'bill', label: billNumber || 'Scanned bill' })
      }
    } catch (err: any) {
      setError(err?.message || 'Could not save the draft.')
    } finally {
      setSaving(false)
    }
  }

  function reset() {
    setParsed(null)
    setSourceText('')
    setStage('intake')
    setLines([])
    setTotals(null)
    setSavedAs(null)
    setError('')
    setVendorId('')
    setBillNumber('')
    setNotes('')
  }

  if (loading) return <div className="page-container" style={{ color: 'var(--muted)', fontSize: 13 }}>Loading the scanner…</div>

  // Follow the draft, not what was printed: the user may have corrected the
  // place of supply, and that is what actually gets saved.
  const split = parsed ? deriveTaxSplit({ ...parsed, place_of_supply_code: placeOfSupply }, orgStateCode) : null
  const mismatch = totals && parsed?.declared.grand_total !== null && parsed?.declared.grand_total !== undefined
    ? round2(totals.grand_total - parsed.declared.grand_total)
    : null
  // A bill that prints CGST+SGST is a local supply by definition, so a split
  // disagreement almost always means the place of supply was misread.
  function splitMismatchWarning(): string {
    if (!parsed || !split) return ''
    const printedLocal = (parsed.declared.cgst_amount || 0) > 0
    const printedInterstate = (parsed.declared.igst_amount || 0) > 0
    const posName = stateNameFromCode(placeOfSupply) || placeOfSupply
    if (printedLocal && split.type === 'igst') {
      return `The bill prints CGST + SGST, which only happens for a supply inside one state, yet place of supply is read as ${posName}. If the goods were delivered in your own state, correct it.`
    }
    if (printedInterstate && split.type === 'cgst_sgst') {
      return `The bill prints IGST, which means an inter-state supply, yet place of supply ${posName} is your own state. Check that figure.`
    }
    return ''
  }
  const splitHint = splitMismatchWarning()

  const problems = parsed
    ? [...parsed.warnings, ...(mismatch !== null && Math.abs(mismatch) > 0.5
      ? [`The draft totals differ from the printed bill total by Rs ${formatINR(Math.abs(mismatch))}.${mismatch < 0 ? ' Line values are lower than the bill says.' : ''}`]
      : []), ...(splitHint ? [splitHint] : [])]
    : []

  return (
    <div className="page-container sb" style={{ maxWidth: 1000 }}>
      <PageHeader
        eyebrow="AI"
        title="Scan a bill"
        subtitle="Photograph or drop a supplier's invoice and the figures become a draft bill. Reading happens in this browser — no copy of your supplier's bill is uploaded anywhere."
      />

      {error && (
        <div className="sb-alert is-error">
          <Icon name="alert" size={14} />
          {error}
        </div>
      )}

      {stage !== 'review' && (
        <Card style={{ marginBottom: '1rem' }}>
          <div
            className={`sb-drop ${dragOver ? 'is-over' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files?.[0]) }}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="sb-drop-chip"><Icon name="upload" size={22} /></span>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-2)' }}>
              {stage === 'reading' ? 'Reading the bill…' : 'Drop a bill photo or PDF here'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              JPG, PNG or PDF — a single page works best
            </div>

            {stage === 'reading' && (
              <div className="sb-progress">
                <ProgressBar value={Math.round((progress?.progress || 0.02) * 100)} height={6} />
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
                  {progress?.message || 'Starting…'} (first run downloads the recognition model, about 4 MB)
                </div>
              </div>
            )}
          </div>

          <div className="tf-row tf-wrap" style={{ gap: 8, marginTop: 12 }}>
            <Button icon="upload" disabled={stage === 'reading'} onClick={() => fileInputRef.current?.click()}>
              Choose file
            </Button>
            <Button variant="ghost" icon="scan" disabled={stage === 'reading'} onClick={() => cameraInputRef.current?.click()}>
              Take photo
            </Button>
            <select
              className="tf-input"
              aria-label="Languages to read"
              value={langs}
              onChange={e => setLangs(e.target.value)}
              disabled={stage === 'reading'}
              style={{ width: 'auto' }}
            >
              <option value="eng">English text</option>
              <option value="eng+hin">English + Hindi</option>
              <option value="eng+hin+tam">English + Hindi + Tamil</option>
              <option value="eng+hin+guj">English + Hindi + Gujarati</option>
            </select>
          </div>

          <input ref={fileInputRef} type="file" accept="image/*,application/pdf"
            onChange={e => handleFile(e.target.files?.[0])} style={{ display: 'none' }} />
          <input ref={cameraInputRef} type="file" accept="image/*" capture="environment"
            onChange={e => handleFile(e.target.files?.[0])} style={{ display: 'none' }} />

          <div style={{ marginTop: 16, borderTop: '1px solid var(--line-soft)', paddingTop: 12 }}>
            <button className="sb-textbtn" onClick={() => setShowPaste(v => !v)}>
              {showPaste ? '− Hide' : '+ Paste the bill text instead'}
            </button>
            {showPaste && (
              <div style={{ marginTop: 10 }}>
                <textarea
                  className="tf-input"
                  value={pasteText}
                  onChange={e => setPasteText(e.target.value)}
                  rows={8}
                  placeholder={'Paste what the bill says — description, HSN, qty, rate, GST and totals.'}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                />
                <Button
                  size="sm"
                  style={{ marginTop: 8 }}
                  onClick={() => pasteText.trim() && handleText(pasteText, 'pasted-text')}
                >
                  Extract bill details
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {stage === 'review' && parsed && (
        <>
          {problems.length > 0 && (
            <div className="sb-warn">
              <div className="sb-warn-title">Check these before saving</div>
              <ul className="sb-warn-list">
                {problems.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          <Card style={{ marginBottom: '1rem' }}>
            <SectionTitle>Supplier and document</SectionTitle>

            <div className="sb-grid">
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="sb-label">Vendor on file</label>
                <select
                  className="tf-input"
                  value={vendorId}
                  onChange={e => {
                    const v = vendors.find(x => x.id === e.target.value)
                    setVendorId(v?.id || '')
                    if (v) {
                      setVendorName(v.name); setVendorGstin(v.gstin || '')
                      setVendorStateCode(v.state_code || '')
                      if (v.state_code) setPlaceOfSupply(v.state_code)
                    }
                  }}
                >
                  <option value="">— not matched, will create “{vendorName || 'new supplier'}” —</option>
                  {vendors.map(v => (
                    <option key={v.id} value={v.id}>{v.name}{v.gstin ? ` · ${v.gstin}` : ''}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="sb-label">Supplier name <Chip bill={parsed} field="vendor_name" /></label>
                <input className="tf-input" value={vendorName} onChange={e => setVendorName(e.target.value)} />
              </div>
              <div>
                <label className="sb-label">GSTIN <Chip bill={parsed} field="vendor_gstin" /></label>
                <input className="tf-input" value={vendorGstin} onChange={e => setVendorGstin(e.target.value.toUpperCase())}
                  placeholder="27ABCDE1234F1Z5" />
              </div>
              <div>
                <label className="sb-label">Bill number <Chip bill={parsed} field="bill_number" /></label>
                <input className="tf-input" value={billNumber} onChange={e => setBillNumber(e.target.value)} />
              </div>
              <div>
                <label className="sb-label">Bill date <Chip bill={parsed} field="bill_date" /></label>
                <input className="tf-input" type="date" value={billDate} onChange={e => setBillDate(e.target.value)} />
                <SealNotice orgId={orgId} date={billDate} />
              </div>
              <div>
                <label className="sb-label">Place of supply</label>
                <select className="tf-input" value={placeOfSupply} onChange={e => setPlaceOfSupply(e.target.value)}>
                  <option value="">Select state</option>
                  {INDIAN_STATES.map(s => <option key={s.value} value={s.value}>{s.value} — {s.label}</option>)}
                </select>
              </div>
              <div>
                <label className="sb-label">Due date</label>
                <input className="tf-input" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
              </div>
            </div>

            {split && (
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 12 }}>
                Tax treatment: <strong style={{ color: 'var(--ink)' }}>{split.type === 'igst' ? 'IGST' : 'CGST + SGST'}</strong> — {split.reason}
              </div>
            )}
          </Card>

          <Card style={{ marginBottom: '1rem' }}>
            <SectionTitle>Line items <Chip bill={parsed} field="line_items" /></SectionTitle>

            <div className="responsive-table">
              <div className="table-header sb-th">
                <div>Description / product</div>
                <div>HSN / SAC</div>
                <div>Qty</div>
                <div>Rate</div>
                <div>Disc %</div>
                <div>GST %</div>
                <div>Taxable</div>
              </div>

              {lines.map(line => (
                <div key={line.key} className="table-row sb-row">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-label="Description">
                    <input className="tf-input" value={line.item_name} onChange={e => updateLine(line.key, 'item_name', e.target.value)}
                      style={{ fontSize: 12.5 }} />
                    {products.length > 0 && (
                      <select
                        className="tf-input"
                        value={line.product_id}
                        onChange={e => selectProduct(line.key, e.target.value)}
                        style={{ fontSize: 11, padding: '4px 6px' }}
                      >
                        <option value="">link to a product…</option>
                        {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </div>
                  <div data-label="HSN"><input className="tf-input" value={line.hsn_sac}
                    onChange={e => updateLine(line.key, 'hsn_sac', e.target.value)}
                    style={{ fontSize: 12 }} /></div>
                  <div data-label="Qty"><input className="tf-input" value={line.quantity}
                    onChange={e => updateLine(line.key, 'quantity', e.target.value)}
                    style={{ fontSize: 12 }} /></div>
                  <div data-label="Rate"><input className="tf-input" value={line.rate}
                    onChange={e => updateLine(line.key, 'rate', e.target.value)}
                    style={{ fontSize: 12 }} /></div>
                  <div data-label="Disc"><input className="tf-input" value={line.discount_percent}
                    onChange={e => updateLine(line.key, 'discount_percent', e.target.value)}
                    style={{ fontSize: 12 }} /></div>
                  <div data-label="GST">
                    <select className="tf-input" value={line.gst_rate} onChange={e => updateLine(line.key, 'gst_rate', e.target.value)}
                      style={{ fontSize: 12 }}>
                      {GST_RATES.map(r => <option key={r} value={String(r)}>{r}%</option>)}
                    </select>
                  </div>
                  <div data-label="Taxable" className="sb-right" style={{ fontSize: 12.5, color: 'var(--ink-2)' }}>
                    {line.calculated ? formatINR(line.calculated.taxable_value) : '—'}
                  </div>
                </div>
              ))}
            </div>

            <div className="tf-row" style={{ gap: 8, marginTop: 12 }}>
              <Button size="sm" variant="subtle" icon="plus" onClick={addLine}>Add line</Button>
              <Button size="sm" variant="danger" onClick={() => setLines(prev => prev.slice(0, -1))}>Remove last</Button>
            </div>
          </Card>

          <Card style={{ marginBottom: '1rem' }}>
            <SectionTitle>Printed on the bill vs read</SectionTitle>
            <div className="table-scroll">
              <div className="sb-cmp sb-cmp-head">
                <div>Figure</div><div className="sb-right">Bill says</div><div className="sb-right">Draft</div><div className="sb-right">Diff</div>
              </div>
              {[
                { label: 'Taxable value', printed: parsed.declared.taxable_amount, draft: totals?.taxable_amount ?? null },
                { label: 'CGST', printed: parsed.declared.cgst_amount, draft: totals?.cgst_amount ?? null },
                { label: 'SGST', printed: parsed.declared.sgst_amount, draft: totals?.sgst_amount ?? null },
                { label: 'IGST', printed: parsed.declared.igst_amount, draft: totals?.igst_amount ?? null },
                { label: 'Total tax', printed: parsed.declared.total_tax, draft: totals?.total_tax ?? null },
                { label: 'Grand total', printed: parsed.declared.grand_total, draft: totals?.grand_total ?? null },
              ].map(row => {
                const diff = row.printed !== null && row.draft !== null ? round2(row.draft - row.printed) : null
                return (
                  <div key={row.label} className="sb-cmp">
                    <div style={{ color: 'var(--ink-2)' }}>{row.label}</div>
                    <div className="sb-right" style={{ color: 'var(--muted)' }}>{row.printed !== null ? formatINR(row.printed) : '—'}</div>
                    <div className="sb-right" style={{ color: 'var(--ink)', fontWeight: 550 }}>{row.draft !== null ? formatINR(row.draft) : '—'}</div>
                    <div className="sb-right" style={{ color: diff === null || Math.abs(diff) < 0.5 ? 'var(--green)' : 'var(--red)' }}>
                      {diff === null ? '—' : Math.abs(diff) < 0.5
                        ? <Icon name="check" size={13} />
                        : (diff > 0 ? '+' : '') + formatINR(diff)}
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>

          <Card style={{ marginBottom: '1rem' }}>
            <SectionTitle>Save as</SectionTitle>

            <div className="tf-row tf-wrap" style={{ gap: 16, marginBottom: 12 }}>
              <label className="sb-check">
                <input type="radio" checked={saveMode === 'bill'} onChange={() => setSaveMode('bill')} /> Purchase bill (GST + ITC)
              </label>
              <label className="sb-check">
                <input type="radio" checked={saveMode === 'expense'} onChange={() => setSaveMode('expense')} /> Expense (no GST detail)
              </label>
            </div>

            <div className="sb-grid">
              {saveMode === 'expense' && (
                <div>
                  <label className="sb-label">Category</label>
                  <select className="tf-input" value={expenseCategory} onChange={e => setExpenseCategory(e.target.value)}>
                    {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="sb-label">Notes</label>
                <input className="tf-input" value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </div>

            <div className="tf-row tf-wrap" style={{ gap: 18, margin: '14px 0' }}>
              <label className="sb-check">
                <input type="checkbox" checked={itcEligible} onChange={e => setItcEligible(e.target.checked)} /> ITC eligible
              </label>
              <label className="sb-check">
                <input type="checkbox" checked={isReverseCharge} onChange={e => setIsReverseCharge(e.target.checked)} /> Reverse charge
              </label>
            </div>

            {savedAs ? (
              <div className="sb-saved">
                Saved {savedAs.kind === 'bill' ? 'purchase bill' : 'expense'} — {savedAs.label}.{' '}
                <button className="sb-textbtn is-underline" onClick={() => router.push(savedAs.kind === 'bill' ? '/bills' : '/expenses')}>
                  Open {savedAs.kind === 'bill' ? 'bills' : 'expenses'}
                </button>
              </div>
            ) : (
              <div className="tf-row tf-wrap" style={{ gap: 8 }}>
                <Button icon="check" onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : saveMode === 'bill' ? 'Save purchase bill' : 'Save expense'}
                </Button>
                <Button variant="ghost" onClick={reset}>Scan another</Button>
              </div>
            )}
          </Card>

          <details style={{ fontSize: 12, color: 'var(--muted)' }}>
            <summary style={{ cursor: 'pointer', padding: '6px 0' }}>What was read from the document</summary>
            <pre className="sb-raw">{sourceText || '(no text)'}</pre>
          </details>
        </>
      )}

      <style>{`
        .sb-drop { border: 2px dashed var(--line); border-radius: var(--radius); padding: 2.5rem 1rem;
          text-align: center; cursor: pointer; background: var(--surface-2);
          transition: border-color 0.15s ease, background 0.15s ease; }
        .sb-drop.is-over { border-color: var(--brand); background: var(--brand-soft); }
        .sb-drop-chip { display: inline-flex; align-items: center; justify-content: center; width: 46px;
          height: 46px; border-radius: 50%; background: var(--surface); color: var(--brand);
          margin-bottom: 10px; box-shadow: var(--shadow-xs); }
        .sb-progress { margin-top: 16px; }
        .sb-progress .tf-bar-track { max-width: 320px; margin: 0 auto; }

        .sb-label { display: block; font-size: 11px; font-weight: 650; color: var(--muted);
          text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
        .sb-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
        .sb-check { font-size: 13px; color: var(--ink-2); cursor: pointer; display: inline-flex;
          align-items: center; gap: 6px; }
        .sb-check input { accent-color: var(--brand); }

        .sb-th { grid-template-columns: 2.4fr 1fr 0.7fr 1fr 0.8fr 0.8fr 1.1fr; display: grid;
          gap: 8px; padding: 8px 0; font-size: 11px; font-weight: 650; color: var(--faint);
          text-transform: uppercase; letter-spacing: 0.05em;
          border-bottom: 1px solid var(--line-soft); margin-bottom: 4px; }
        .sb-row { grid-template-columns: 2.4fr 1fr 0.7fr 1fr 0.8fr 0.8fr 1.1fr; display: grid;
          gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
        .sb-right { text-align: right; }

        .sb-cmp { display: grid; grid-template-columns: 1.6fr 1fr 1fr 0.9fr; gap: 8px;
          font-size: 12.5px; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
        .sb-cmp:last-child { border-bottom: none; }
        .sb-cmp-head { font-size: 11px; color: var(--faint); font-weight: 650;
          text-transform: uppercase; letter-spacing: 0.05em; padding-bottom: 6px; }

        .sb-alert { display: flex; align-items: center; gap: 8px; font-size: 12.5px;
          border-radius: var(--radius-sm); padding: 10px 12px; margin-bottom: 1rem; }
        .sb-alert.is-error { background: var(--red-soft); color: #b91c1c; }

        .sb-warn { background: var(--amber-soft); border: 1px solid #fde68a; border-radius: var(--radius);
          padding: 14px 18px; margin-bottom: 1rem; }
        .sb-warn-title { font-size: 13px; font-weight: 700; color: #b45309; margin-bottom: 6px; }
        .sb-warn-list { margin: 0; padding-left: 18px; font-size: 12.5px; color: #b45309; line-height: 1.7; }

        .sb-saved { background: var(--green-soft); border: 1px solid #bbf7d0; border-radius: var(--radius-sm);
          padding: 12px 14px; font-size: 13px; color: #15803d; }
        .sb-textbtn { background: none; border: none; color: var(--brand); font-size: 13px;
          cursor: pointer; padding: 0; font-family: inherit; }
        .sb-textbtn.is-underline { text-decoration: underline; }

        .sb-raw { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-sm);
          padding: 12px; white-space: pre-wrap; font-size: 11.5px; line-height: 1.5; max-height: 260px;
          overflow: auto; margin: 0; color: var(--ink-2); }

        @media (max-width: 768px) {
          .sb-right { text-align: left; }
          .sb-drop { padding: 1.75rem 0.75rem; }
        }
      `}</style>
    </div>
  )
}

function Chip({ bill, field }: { bill: ParsedBill; field: string }) {
  const badge = confidenceBadge(bill.confidences[field])
  return (
    <span style={{ marginLeft: 6, verticalAlign: 'middle' }}>
      <Badge tone={badge.tone} dot={false}>{badge.label}</Badge>
    </span>
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
