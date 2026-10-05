'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase'
import { formatINR } from '@/lib/gst-engine'
import {
  BookRecord,
  Gstr2bRecord,
  ReconciliationResult,
  CSV_TEMPLATE_EXAMPLE,
  CSV_TEMPLATE_HEADERS,
  downloadCsv,
  normalizeGstin,
  parseGstr2bCsv,
  parseGstr2bJson,
  reconciliationExportRows,
  reconcile,
} from '@/lib/gstr2b'

const sectionStyle = {
  background: 'white', border: '1px solid #e2e8f0',
  borderRadius: '12px', padding: '1.5rem', marginBottom: '1rem',
}

const thStyle = {
  display: 'grid', gap: '8px', padding: '8px 0',
  fontSize: '12px', fontWeight: 600 as const, color: '#94a3b8',
  borderBottom: '1px solid #f1f5f9', marginBottom: '4px',
}
const tdRight = { textAlign: 'right' as const }

function sectionTitle(num: string, title: string, color = '#2563eb') {
  return (
    <div style={{
      fontSize: '13px', fontWeight: '700', color: '#374151',
      marginBottom: '1rem', paddingBottom: '8px',
      borderBottom: '1px solid #f1f5f9',
    }}>
      <span style={{
        background: color, color: 'white',
        padding: '2px 8px', borderRadius: '4px',
        marginRight: '8px', fontSize: '12px',
      }}>{num}</span>
      {title}
    </div>
  )
}

export default function Gstr2bReconciliationPage() {
  const supabase = createClient()
  const router = useRouter()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [loading, setLoading] = useState(true)
  const [orgId, setOrgId] = useState('')
  const [selectedPeriod, setSelectedPeriod] = useState(() => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  })

  const [books, setBooks] = useState<BookRecord[]>([])
  const [expenseItc, setExpenseItc] = useState(0)
  const [portalRecords, setPortalRecords] = useState<Gstr2bRecord[] | null>(null)
  const [fileName, setFileName] = useState('')
  const [importError, setImportError] = useState('')

  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(new Date().getFullYear(), new Date().getMonth() - i, 1)
    return {
      period: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' }),
    }
  })

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }

      const { data: membership } = await supabase
        .from('org_members')
        .select('organization_id')
        .eq('user_id', user.id)
        .eq('is_active', true)
        .single()

      if (!membership) { router.push('/setup'); return }
      setOrgId(membership.organization_id)
      await loadBooks(membership.organization_id, selectedPeriod)
      setLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    if (orgId) {
      loadBooks(orgId, selectedPeriod)
      setPortalRecords(null)
      setFileName('')
      setImportError('')
    }
  }, [selectedPeriod, orgId])

  async function loadBooks(oid: string, period: string) {
    const [year, month] = period.split('-')
    const startDate = `${year}-${month}-01`
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate()
    const endDate = `${year}-${month}-${lastDay}`

    const { data: bills } = await supabase
      .from('purchase_bills')
      .select('*')
      .eq('organization_id', oid)
      .eq('itc_eligible', true)
      .neq('status', 'cancelled')
      .gte('bill_date', startDate)
      .lte('bill_date', endDate)

    const bookRecords: BookRecord[] = (bills || []).map(b => ({
      id: b.id,
      supplierGstin: normalizeGstin(b.vendor_gstin),
      invoiceNo: b.bill_number || '',
      invoiceDate: b.bill_date || null,
      label: b.bill_number || 'Bill',
      taxable: Number(b.taxable_amount) || 0,
      igst: Number(b.igst_amount) || 0,
      cgst: Number(b.cgst_amount) || 0,
      sgst: Number(b.sgst_amount) || 0,
    }))
    setBooks(bookRecords)

    // Expense ITC is shown separately — most expense suppliers don't report to GSTR-2B
    // against a bill number we can match, so it stays out of the match engine.
    const { data: expenses } = await supabase
      .from('expenses')
      .select('gst_amount')
      .eq('organization_id', oid)
      .eq('itc_eligible', true)
      .gte('expense_date', startDate)
      .lte('expense_date', endDate)
    setExpenseItc((expenses || []).reduce((s, e) => s + Number(e.gst_amount || 0), 0))
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setImportError('')

    try {
      const text = await file.text()
      let records: Gstr2bRecord[]
      if (file.name.toLowerCase().endsWith('.json')) {
        records = parseGstr2bJson(text).records
      } else if (file.name.toLowerCase().endsWith('.csv')) {
        records = parseGstr2bCsv(text)
      } else {
        throw new Error('Please upload the GSTR-2B .json file or a .csv with the same columns.')
      }
      setPortalRecords(records)
      setFileName(file.name)
    } catch (err: any) {
      setImportError(err.message || 'Could not read this file.')
      setPortalRecords(null)
      setFileName('')
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const result: ReconciliationResult | null = useMemo(
    () => (portalRecords ? reconcile(books, portalRecords) : null),
    [books, portalRecords],
  )

  function downloadTemplate() {
    downloadCsv('GSTR-2B-import-template.csv', [
      CSV_TEMPLATE_HEADERS.split(','),
      CSV_TEMPLATE_EXAMPLE.split(','),
    ])
  }

  function exportRecon() {
    if (!result) return
    downloadCsv(`GSTR2B-Reconciliation-${selectedPeriod}.csv`, reconciliationExportRows(result))
  }

  const metric = (label: string, value: number, color: string) => (
    <div key={label} style={{
      background: 'white', border: '1px solid #e2e8f0',
      borderRadius: '12px', padding: '1rem 1.25rem',
    }}>
      <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontSize: '18px', fontWeight: '700', color }}>₹{formatINR(value)}</div>
    </div>
  )

  if (loading) return (
    <div style={{ padding: '2rem', color: '#64748b', fontSize: '14px' }}>Loading...</div>
  )

  const t = result?.totals

  return (
    <div className="page-container" style={{ padding: '2rem', maxWidth: '960px' }}>
      {/* Header */}
      <div className="page-header" style={{
        display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap',
        gap: '12px', alignItems: 'center', marginBottom: '1.5rem',
      }}>
        <div>
          <h1 style={{ fontSize: '22px', fontWeight: '600', color: '#1e293b', marginBottom: '4px' }}>
            GSTR-2B Reconciliation
          </h1>
          <p style={{ fontSize: '14px', color: '#64748b' }}>
            Match your purchase books against the ITC statement in GSTR-2B
          </p>
        </div>
        <select
          style={{
            padding: '8px 14px', border: '1px solid #e2e8f0',
            borderRadius: '8px', fontSize: '14px', cursor: 'pointer',
            background: 'white', color: '#1e293b', outline: 'none',
          }}
          value={selectedPeriod}
          onChange={e => setSelectedPeriod(e.target.value)}
        >
          {months.map(m => (
            <option key={m.period} value={m.period}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Upload panel */}
      <div style={sectionStyle}>
        {sectionTitle('1', 'Import GSTR-2B data')}
        <div style={{
          border: '2px dashed #cbd5e1', borderRadius: '12px',
          padding: '1.5rem', textAlign: 'center' as const,
          cursor: 'pointer', background: '#f8fafc',
        }} onClick={() => fileInputRef.current?.click()}>
          {fileName ? (
            <div>
              <div style={{ fontWeight: '600', color: '#059669', fontSize: '14px', marginBottom: '4px' }}>
                ✓ {fileName}
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                {portalRecords?.length} supplier invoices loaded from 2B — click to replace
              </div>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: '32px', marginBottom: '8px' }}>📥</div>
              <div style={{ fontWeight: '600', color: '#374151', fontSize: '14px', marginBottom: '4px' }}>
                Upload your GSTR-2B file
              </div>
              <div style={{ fontSize: '12px', color: '#64748b' }}>
                The .json file from the GSTR-2B zip on the GST portal, or a CSV (see template below)
              </div>
            </div>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          onChange={handleFile}
          style={{ display: 'none' }}
        />

        {importError && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626',
            padding: '10px 12px', borderRadius: '8px', fontSize: '13px', marginTop: '12px',
          }}>
            {importError}
          </div>
        )}

        <div style={{
          display: 'flex', gap: '8px', flexWrap: 'wrap' as const, marginTop: '12px',
        }} className="btn-group">
          <button onClick={downloadTemplate} style={{
            padding: '8px 16px', background: '#f1f5f9', color: '#374151',
            border: '1px solid #e2e8f0', borderRadius: '8px',
            fontSize: '13px', cursor: 'pointer',
          }}>
            ↓ CSV Template
          </button>
          {result && (
            <button onClick={exportRecon} style={{
              padding: '8px 16px', background: '#2563eb', color: 'white',
              border: 'none', borderRadius: '8px', fontSize: '13px', cursor: 'pointer',
            }}>
              ↓ Export Reconciliation
            </button>
          )}
        </div>

        <p style={{ fontSize: '12px', color: '#94a3b8', marginTop: '10px' }}>
          On the GST portal: Returns Dashboard → GSTR-2B → Download → open the zip
          (password is your GSTIN&apos;s last 4 characters + captcha) and upload the .json inside.
        </p>
      </div>

      {/* Summary */}
      {result && t && (
        <>
          <div className="metric-grid" style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
            gap: '12px', marginBottom: '1rem',
          }}>
            {metric('ITC in your books', t.booksITC, '#1e293b')}
            {metric('ITC in GSTR-2B', t.portalITC, '#1e293b')}
            {metric('ITC fully matched', t.matchedITC, '#059669')}
            {metric('ITC at risk (not in 2B)', t.atRiskITC, '#dc2626')}
            {metric('Extra ITC available', t.excessITC, '#2563eb')}
          </div>

          {expenseItc > 0 && (
            <div style={{
              padding: '10px 14px', background: '#f0f9ff', border: '1px solid #bae6fd',
              borderRadius: '8px', fontSize: '12px', color: '#0369a1', marginBottom: '1rem',
            }}>
              ℹ️ Expense ITC of ₹{formatINR(expenseItc)} this period is excluded from matching —
              supplier invoices for expenses often aren&apos;t captureable by bill number in GSTR-2B.
              Verify those claims separately.
            </div>
          )}

          {/* In books, not in 2B */}
          <div className="responsive-table" style={sectionStyle}>
            {sectionTitle('⚠️', `In your books, NOT in GSTR-2B — ${result.booksOnly.length} invoice(s)`, '#dc2626')}
            {result.booksOnly.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#059669' }}>✓ Every purchase bill appears in 2B.</p>
            ) : (
              <>
                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '10px' }}>
                  ITC on these bills is <strong>blocked under Section 16(2)(aa)</strong> until your
                  supplier reports them. Follow up (Form IIF may apply).
                </p>
                <div className="table-header" style={{ ...thStyle, gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr' }}>
                  <span>Supplier / Invoice</span>
                  <span style={tdRight}>Taxable</span>
                  <span style={tdRight}>IGST</span>
                  <span style={tdRight}>CGST</span>
                  <span style={tdRight}>SGST</span>
                </div>
                {result.booksOnly.map(r => (
                  <div key={r.book!.id} className="table-row" style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
                    gap: '8px', padding: '8px 0', fontSize: '12px',
                    borderBottom: '1px solid #f8fafc',
                  }}>
                    <span data-label="Supplier / Invoice">
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{r.book!.invoiceNo}</span>
                      <span style={{ display: 'block', color: '#94a3b8', fontFamily: 'monospace', fontSize: '11px' }}>
                        {r.book!.supplierGstin || 'no GSTIN on bill'}
                      </span>
                    </span>
                    <span data-label="Taxable" style={tdRight}>₹{formatINR(r.book!.taxable)}</span>
                    <span data-label="IGST" style={tdRight}>₹{formatINR(r.book!.igst)}</span>
                    <span data-label="CGST" style={tdRight}>₹{formatINR(r.book!.cgst)}</span>
                    <span data-label="SGST" style={tdRight}>₹{formatINR(r.book!.sgst)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Amount mismatches */}
          <div className="responsive-table" style={sectionStyle}>
            {sectionTitle('≈', `Matched with amount differences — ${result.mismatched.length} invoice(s)`, '#d97706')}
            {result.mismatched.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#059669' }}>✓ No amount differences on matched invoices.</p>
            ) : (
              <>
                <div className="table-header" style={{ ...thStyle, gridTemplateColumns: '2fr 1fr 1fr 1fr' }}>
                  <span>Supplier / Invoice</span>
                  <span style={tdRight}>Tax (Books)</span>
                  <span style={tdRight}>Tax (2B)</span>
                  <span style={tdRight}>Difference</span>
                </div>
                {result.mismatched.map(r => {
                  const bookTax = r.book!.igst + r.book!.cgst + r.book!.sgst
                  const portalTax = r.portal!.igst + r.portal!.cgst + r.portal!.sgst
                  const diff = bookTax - portalTax
                  return (
                    <div key={r.book!.id} className="table-row" style={{
                      display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr',
                      gap: '8px', padding: '8px 0', fontSize: '12px',
                      borderBottom: '1px solid #f8fafc',
                    }}>
                      <span data-label="Supplier / Invoice">
                        <span style={{ fontWeight: 600, color: '#1e293b' }}>{r.book!.invoiceNo}</span>
                        <span style={{ display: 'block', color: '#94a3b8', fontSize: '11px' }}>
                          {r.book!.supplierGstin} · differs on {r.mismatchHeads.join(', ')}
                        </span>
                      </span>
                      <span data-label="Tax (Books)" style={tdRight}>₹{formatINR(bookTax)}</span>
                      <span data-label="Tax (2B)" style={tdRight}>₹{formatINR(portalTax)}</span>
                      <span data-label="Difference" style={{ ...tdRight, fontWeight: 700, color: diff > 0 ? '#dc2626' : '#2563eb' }}>
                        {diff > 0 ? '+' : ''}₹{formatINR(diff)}
                      </span>
                    </div>
                  )
                })}
              </>
            )}
          </div>

          {/* In 2B, not in books */}
          <div className="responsive-table" style={sectionStyle}>
            {sectionTitle('＋', `In GSTR-2B, NOT in your books — ${result.portalOnly.length} invoice(s)`, '#2563eb')}
            {result.portalOnly.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#64748b' }}>Nothing in 2B is missing from your books.</p>
            ) : (
              <>
                <p style={{ fontSize: '12px', color: '#64748b', marginBottom: '10px' }}>
                  Your supplier has reported these but you haven&apos;t booked them.
                  Add the purchase bills to claim this ITC.
                </p>
                <div className="table-header" style={{ ...thStyle, gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr' }}>
                  <span>Supplier / Invoice</span>
                  <span style={tdRight}>Taxable</span>
                  <span style={tdRight}>IGST</span>
                  <span style={tdRight}>CGST</span>
                  <span style={tdRight}>SGST</span>
                </div>
                {result.portalOnly.map((r, i) => (
                  <div key={`${r.portal!.supplierGstin}-${i}`} className="table-row" style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
                    gap: '8px', padding: '8px 0', fontSize: '12px',
                    borderBottom: '1px solid #f8fafc',
                  }}>
                    <span data-label="Supplier / Invoice">
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>
                        {r.portal!.invoiceNo || '(no invoice reference)'}
                      </span>
                      <span style={{ display: 'block', color: '#94a3b8', fontFamily: 'monospace', fontSize: '11px' }}>
                        {r.portal!.supplierGstin} · {r.portal!.section}
                      </span>
                    </span>
                    <span data-label="Taxable" style={tdRight}>₹{formatINR(r.portal!.taxable)}</span>
                    <span data-label="IGST" style={tdRight}>₹{formatINR(r.portal!.igst)}</span>
                    <span data-label="CGST" style={tdRight}>₹{formatINR(r.portal!.cgst)}</span>
                    <span data-label="SGST" style={tdRight}>₹{formatINR(r.portal!.sgst)}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          {/* Matched */}
          <div className="responsive-table" style={sectionStyle}>
            {sectionTitle('✓', `Fully matched — ${result.matched.length} invoice(s)`, '#059669')}
            {result.matched.length === 0 ? (
              <p style={{ fontSize: '13px', color: '#64748b' }}>No fully matched invoices yet.</p>
            ) : (
              <>
                <div className="table-header" style={{ ...thStyle, gridTemplateColumns: '2fr 1fr 1fr' }}>
                  <span>Supplier / Invoice</span>
                  <span style={tdRight}>Taxable</span>
                  <span style={tdRight}>Total Tax</span>
                </div>
                {result.matched.map(r => (
                  <div key={r.book!.id} className="table-row" style={{
                    display: 'grid', gridTemplateColumns: '2fr 1fr 1fr',
                    gap: '8px', padding: '8px 0', fontSize: '12px',
                    borderBottom: '1px solid #f8fafc',
                  }}>
                    <span data-label="Supplier / Invoice">
                      <span style={{ fontWeight: 600, color: '#1e293b' }}>{r.book!.invoiceNo}</span>
                      <span style={{ display: 'block', color: '#94a3b8', fontFamily: 'monospace', fontSize: '11px' }}>
                        {r.book!.supplierGstin}
                      </span>
                    </span>
                    <span data-label="Taxable" style={tdRight}>₹{formatINR(r.book!.taxable)}</span>
                    <span data-label="Total Tax" style={tdRight}>
                      ₹{formatINR(r.book!.igst + r.book!.cgst + r.book!.sgst)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}

      {!result && (
        <div style={{
          background: 'white', border: '1px solid #e2e8f0', borderRadius: '12px',
          padding: '1.5rem', fontSize: '13px', color: '#64748b',
        }}>
          <div style={{ fontWeight: '600', color: '#374151', marginBottom: '8px' }}>
            {books.length} purchase bill(s) in your books for {selectedPeriod}
          </div>
          Upload your GSTR-2B file above to reconcile. You&apos;ll get:
          <ul style={{ margin: '8px 0 0 20px', lineHeight: 1.8 }}>
            <li>ITC at risk — bills the supplier hasn&apos;t reported to the portal</li>
            <li>Amount mismatches where 2B differs from your books</li>
            <li>Unclaimed ITC available in 2B but missing from your books</li>
            <li>A reconciliation CSV you can hand to your CA</li>
          </ul>
        </div>
      )}

      {/* Warning */}
      <div style={{
        padding: '12px 16px', background: '#fef9c3', border: '1px solid #fde68a',
        borderRadius: '8px', fontSize: '12px', color: '#854d0e',
      }}>
        ⚠️ <strong>Important:</strong> GSTR-2B is auto-drafted by the GST system from your
        suppliers&apos; filings. Final ITC eligibility is governed by Section 16 of the CGST Act —
        reconcile these differences with your CA before filing GSTR-3B.
      </div>
    </div>
  )
}
