'use client'

/**
 * Invoice document skins. The classic Tally-style ruled sheet lives in
 * /invoices/[id]; everything here is the design-kit look.
 */

import { formatINR } from '@/lib/gst-engine'
import { amountInWords } from '@/lib/words'
import { formatDateIN } from '@/lib/format'
import { stateNameFor } from '@/lib/einvoice'

export type InvoiceTemplate = 'classic' | 'modern' | 'minimal'

const TEMPLATE_KEY = 'taxflow:invoice-template:'

export const INVOICE_TEMPLATES: { id: InvoiceTemplate; name: string; blurb: string }[] = [
  { id: 'classic', name: 'Classic ledger', blurb: 'Ruled Tally-style sheet accountants recognise' },
  { id: 'modern', name: 'Modern band', blurb: 'Colour header, soft table, bold total block' },
  { id: 'minimal', name: 'Minimal', blurb: 'Quiet white document for services and consultants' },
]

export function loadInvoiceTemplate(oid: string): InvoiceTemplate {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(TEMPLATE_KEY + oid) : null
  return saved === 'modern' || saved === 'minimal' ? saved : 'classic'
}

export function saveInvoiceTemplate(oid: string, template: InvoiceTemplate) {
  try { localStorage.setItem(TEMPLATE_KEY + oid, template) } catch { /* branding preference */ }
}

interface Props {
  invoice: any
  items: any[]
  org: any
  gstReg: any
  template: Exclude<InvoiceTemplate, 'classic'>
}

const money = (v: unknown) => formatINR(Number(v) || 0)

function read(invoice: any, org: any, gstReg: any) {
  const sellerName = org?.trade_name || org?.name || ''
  const sellerAddress = [
    org?.address_line1, org?.address_line2, org?.city, org?.state, org?.pincode,
  ].filter(Boolean).join(', ')
  const buyerAddress = [
    invoice?.customer_address_line1, invoice?.customer_address_line2,
    invoice?.customer_city, invoice?.customer_state, invoice?.customer_pincode,
  ].filter(Boolean).join(', ') || invoice?.customer_address || ''

  return {
    sellerName,
    sellerAddress,
    sellerGstin: gstReg?.gstin || org?.gstin || '',
    logoUrl: org?.logo_url || '',
    phone: org?.phone || '',
    email: org?.email || '',
    buyerName: invoice?.customer_name || '',
    buyerAddress,
    buyerGstin: invoice?.customer_gstin || '',
    placeOfSupply: invoice?.place_of_supply || '',
  }
}

export function InvoiceDocument({ invoice, items, org, gstReg, template }: Props) {
  const d = read(invoice, org, gstReg)
  const modern = template === 'modern'

  const cgst = Number(invoice.cgst_amount) || 0
  const sgst = Number(invoice.sgst_amount) || 0
  const igst = Number(invoice.igst_amount) || 0
  const cess = Number(invoice.cess_amount) || 0
  const taxable = Number(invoice.taxable_amount) || 0
  const roundOff = Number(invoice.round_off) || 0
  const grand = Number(invoice.grand_total) || 0
  const splitState = cgst + sgst > 0
  const discount = Number(invoice.discount_amount) || 0
  const hasBank = org?.bank_name || org?.bank_account_number || org?.bank_ifsc_code || org?.bank_upi_id
  const footer = org?.invoice_footer || 'Thank you for your business.'

  const ink = modern ? '#0f172a' : '#111827'
  const muted = modern ? '#64748b' : '#6b7280'
  const line = modern ? '#e5eaf2' : '#eceef1'
  const accent = modern ? '#2563eb' : ink

  return (
    <div style={{
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      color: ink, background: 'white', fontSize: 11.5, lineHeight: 1.45,
      border: modern ? 'none' : `1px solid ${line}`,
      borderRadius: modern ? 14 : 6,
      overflow: 'hidden',
    }}>
      {/* Seller band */}
      {modern ? (
        <div style={{
          background: 'linear-gradient(115deg, #0f172a 0%, #1e3a8a 62%, #1d4ed8 100%)',
          color: 'white', padding: '20px 22px', position: 'relative', overflow: 'hidden',
        }}>
          <div style={{ position: 'absolute', top: -70, right: -40, width: 210, height: 210, borderRadius: '50%', background: 'radial-gradient(circle, rgba(96,165,250,.32), transparent 68%)' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18, position: 'relative' }}>
            <div style={{ display: 'flex', gap: 13, alignItems: 'center', minWidth: 0 }}>
              {d.logoUrl ? (
                <img src={d.logoUrl} alt="" crossOrigin="anonymous" style={{ width: 44, height: 44, borderRadius: 10, objectFit: 'cover', background: 'white', padding: 3 }} />
              ) : (
                <div style={{ width: 44, height: 44, borderRadius: 10, background: 'rgba(255,255,255,.16)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, fontWeight: 700 }}>
                  {(d.sellerName || 'T').slice(0, 1).toUpperCase()}
                </div>
              )}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.02em' }}>{d.sellerName}</div>
                <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.78)', marginTop: 3 }}>{d.sellerAddress}</div>
                <div style={{ display: 'flex', gap: 10, marginTop: 5, fontSize: 10.5, color: 'rgba(255,255,255,.86)', flexWrap: 'wrap' }}>
                  {d.sellerGstin && <span>GSTIN <b style={{ fontFamily: 'ui-monospace, monospace' }}>{d.sellerGstin}</b></span>}
                  {d.phone && <span>{d.phone}</span>}
                  {d.email && <span>{d.email}</span>}
                </div>
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 9.5, letterSpacing: '.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,.7)' }}>
                {invoice.status === 'cancelled' ? 'Cancelled' : invoice.invoice_type === 'bill_of_supply' ? 'Bill of Supply' : 'Tax Invoice'}
              </div>
              <div style={{ fontSize: 19, fontWeight: 750, letterSpacing: '-0.02em', marginTop: 4 }}>{invoice.invoice_number}</div>
              <div style={{ fontSize: 10.5, color: 'rgba(255,255,255,.78)', marginTop: 4 }}>
                Dated {formatDateIN(invoice.invoice_date)}
                {invoice.due_date ? ` · Due ${formatDateIN(invoice.due_date)}` : ''}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '22px 22px 14px', borderBottom: `2px solid ${ink}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 18 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
              {d.logoUrl && <img src={d.logoUrl} alt="" crossOrigin="anonymous" style={{ width: 38, height: 38, objectFit: 'contain' }} />}
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>{d.sellerName}</div>
                <div style={{ fontSize: 10.5, color: muted, marginTop: 2 }}>{d.sellerAddress}</div>
                {d.sellerGstin && <div style={{ fontSize: 10.5, color: muted, marginTop: 2 }}>GSTIN {d.sellerGstin}</div>}
              </div>
            </div>
            <div style={{ textAlign: 'right', flexShrink: 0 }}>
              <div style={{ fontSize: 10, letterSpacing: '.2em', textTransform: 'uppercase', color: muted }}>
                {invoice.status === 'cancelled' ? 'Cancelled' : invoice.invoice_type === 'bill_of_supply' ? 'Bill of Supply' : 'Tax Invoice'}
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, marginTop: 5 }}>{invoice.invoice_number}</div>
              <div style={{ fontSize: 10.5, color: muted, marginTop: 3 }}>{formatDateIN(invoice.invoice_date)}</div>
            </div>
          </div>
        </div>
      )}

      {/* Buyer */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16,
        padding: modern ? '16px 22px' : '14px 22px',
        background: modern ? '#f8fafc' : 'transparent',
        borderBottom: `1px solid ${line}`,
      }}>
        <div>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: modern ? accent : muted }}>
            Bill to
          </div>
          <div style={{ fontSize: 13, fontWeight: 650, marginTop: 4 }}>{d.buyerName}</div>
          {d.buyerAddress && <div style={{ fontSize: 10.5, color: muted, marginTop: 2 }}>{d.buyerAddress}</div>}
          <div style={{ display: 'flex', gap: 12, marginTop: 4, fontSize: 10.5, color: muted, flexWrap: 'wrap' }}>
            {d.buyerGstin && <span>GSTIN <b>{d.buyerGstin}</b></span>}
            {d.placeOfSupply && <span>Place of supply {d.placeOfSupply} · {stateNameFor(d.placeOfSupply.slice(0, 2))}</span>}
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: muted, lineHeight: 1.9 }}>
          <div><span style={{ color: modern ? accent : muted }}>Payment mode</span> <b style={{ color: ink }}>{invoice.payment_mode || '—'}</b></div>
          <div><span style={{ color: modern ? accent : muted }}>Reverse charge</span> <b style={{ color: ink }}>{invoice.is_reverse_charge ? 'Yes' : 'No'}</b></div>
          {invoice.buyer_order_number && <div><span style={{ color: modern ? accent : muted }}>Buyer order</span> <b style={{ color: ink }}>{invoice.buyer_order_number}</b></div>}
          {invoice.supplier_ref && <div><span style={{ color: modern ? accent : muted }}>Our ref</span> <b style={{ color: ink }}>{invoice.supplier_ref}</b></div>}
        </div>
      </div>

      {/* Line items */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <thead>
          <tr style={{ background: modern ? '#f1f5f9' : 'white', color: muted }}>
            {['#', 'Description', 'HSN / SAC', 'Qty', 'Rate', modern ? 'Taxable' : 'Amount', ...(splitState ? ['CGST', 'SGST'] : ['IGST']), 'Total'].map((h, i) => (
              <th key={h + i} style={{
                padding: '8px 10px', textAlign: i > 2 ? 'right' : 'left',
                fontSize: 9, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
                borderBottom: `1px solid ${line}`, whiteSpace: 'nowrap',
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((it: any, i: number) => {
            const rowTax = Number(it.cgst_amount) + Number(it.sgst_amount) + Number(it.igst_amount) + Number(it.cess_amount || 0)
            const total = Number(it.taxable_value) + rowTax
            return (
              <tr key={it.id || i} style={{ borderBottom: `1px solid ${modern ? line : '#f3f4f6'}` }}>
                <td style={{ padding: '8px 10px', color: muted }}>{i + 1}</td>
                <td style={{ padding: '8px 10px' }}>
                  <div style={{ fontWeight: 600 }}>{it.item_name}</div>
                  {Number(it.discount_amount) > 0 && <div style={{ fontSize: 9.5, color: muted }}>Discount ₹{money(it.discount_amount)}</div>}
                </td>
                <td style={{ padding: '8px 10px', fontFamily: 'ui-monospace, monospace', fontSize: 10.5, color: muted }}>{it.hsn_sac || '—'}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{Number(it.quantity)} {it.unit || ''}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(it.rate)}</td>
                <td style={{ padding: '8px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(it.taxable_value)}</td>
                {splitState ? (
                  <>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: muted, fontVariantNumeric: 'tabular-nums' }}>{money(it.cgst_amount)}</td>
                    <td style={{ padding: '8px 10px', textAlign: 'right', color: muted, fontVariantNumeric: 'tabular-nums' }}>{money(it.sgst_amount)}</td>
                  </>
                ) : (
                  <td style={{ padding: '8px 10px', textAlign: 'right', color: muted, fontVariantNumeric: 'tabular-nums' }}>{money(it.igst_amount)}</td>
                )}
                <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {/* Totals */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 20, padding: '14px 22px 18px', alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: modern ? accent : muted }}>
            Amount in words
          </div>
          <div style={{ fontSize: 10.5, color: ink, marginTop: 4, fontStyle: 'italic' }}>{amountInWords(grand)}</div>

          {hasBank && (
            <div style={{ marginTop: 12, padding: '9px 11px', border: `1px ${modern ? 'solid' : 'dashed'} ${line}`, borderRadius: modern ? 9 : 4, fontSize: 10, color: muted, lineHeight: 1.7 }}>
              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: ink }}>Payment details</div>
              {org?.bank_name && <div>Bank <b style={{ color: ink }}>{org.bank_name}</b></div>}
              {org?.bank_account_number && <div>A/C <b style={{ fontFamily: 'ui-monospace, monospace', color: ink }}>{org.bank_account_number}</b></div>}
              {org?.bank_ifsc_code && <div>IFSC <b style={{ color: ink }}>{org.bank_ifsc_code}</b></div>}
              {org?.bank_upi_id && <div>UPI <b style={{ color: ink }}>{org.bank_upi_id}</b></div>}
            </div>
          )}

          {invoice.notes && (
            <div style={{ marginTop: 10, fontSize: 10, color: muted }}>
              <b style={{ color: ink }}>Notes:</b> {invoice.notes}
            </div>
          )}
        </div>

        <div style={{ width: 260, flexShrink: 0 }}>
          {([
            ['Taxable value', taxable],
            ...(discount > 0 ? [['Discount', -discount] as [string, number]] : []),
            ...(splitState ? [['CGST', cgst] as [string, number], ['SGST', sgst] as [string, number]] : [['IGST', igst] as [string, number]]),
            ...(cess > 0 ? [['Cess', cess] as [string, number]] : []),
            ...(roundOff !== 0 ? [['Round off', roundOff] as [string, number]] : []),
          ] as [string, number][]).map(([label, value]) => (
            <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', fontSize: 11, color: muted, borderBottom: `1px solid ${modern ? '#f1f5f9' : '#f8fafc'}` }}>
              <span>{label}</span>
              <span style={{ color: ink, fontVariantNumeric: 'tabular-nums' }}>₹{money(value)}</span>
            </div>
          ))}
          <div style={{
            marginTop: 8, padding: modern ? '11px 13px' : '9px 11px',
            background: modern ? accent : ink, color: 'white',
            borderRadius: modern ? 10 : 3, display: 'flex',
            justifyContent: 'space-between', alignItems: 'baseline',
          }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase' }}>Total</span>
            <span style={{ fontSize: 17, fontWeight: 750, fontVariantNumeric: 'tabular-nums' }}>₹{money(grand)}</span>
          </div>
          {invoice.status === 'cancelled' && (
            <div style={{ marginTop: 7, fontSize: 10, color: '#dc2626', fontWeight: 650 }}>
              Cancelled — not a valid tax document
            </div>
          )}
        </div>
      </div>

      {/* Sign-off */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 20,
        padding: '12px 22px 18px', borderTop: `1px solid ${line}`,
      }}>
        <div style={{ fontSize: 9.5, color: muted, fontStyle: 'italic' }}>{footer}</div>
        <div style={{ textAlign: 'center', minWidth: 170 }}>
          <div style={{ fontSize: 10.5, fontWeight: 600 }}>{org?.trade_name || org?.name}</div>
          <div style={{ borderTop: `1px solid ${ink}`, margin: '30px 0 4px' }} />
          <div style={{ fontSize: 9.5, color: muted }}>Authorised signatory</div>
        </div>
      </div>
    </div>
  )
}
