# TaxFlow India — Project Tasks

**Version:** 2.0  
**Date:** October 2026  
**Last Updated:** 2026-10-07  

Phases 0–12 are the original MVP build. Version 1 and the Round 1 / Round 2
competitive features are recorded further down — read those sections for what
exists now, and the Backlog for what comes next.

---

## How to use this document

- ✅ = Completed and tested
- 🔄 = In progress
- ⏳ = Planned, not started
- ❌ = Blocked or cancelled

Update this file after completing each task.

---

## PHASE 0 — Blueprint ✅

- ✅ Define product vision and target customers
- ✅ Define MVP vs Version 1 vs Version 2
- ✅ Choose technology stack (Next.js + Supabase + Vercel)
- ✅ Design database architecture
- ✅ Plan development phases
- ✅ Create 6 project documents

---

## PHASE 1 — Project Skeleton ✅

- ✅ Install Homebrew on Mac
- ✅ Install Node.js 20+ (dev machine now runs v24)
- ✅ Install Git
- ✅ Install the code editor (Cursor, now Qoder)
- ✅ Create GitHub account
- ✅ Create Supabase account and project
- ✅ Create Next.js app (taxflow-india)
- ✅ Install Supabase libraries
- ✅ Create .env.local with credentials
- ✅ Create login page
- ✅ Create signup page
- ✅ Create dashboard shell
- ✅ Test auth flow (signup → confirm → login → logout)
- ✅ Deploy to Vercel
- ✅ Test live at taxflow-india.vercel.app

---

## PHASE 2 — Business Setup ✅

### Database
- ✅ Create profiles table
- ✅ Create organizations table
- ✅ Create org_members table
- ✅ Create gst_registrations table
- ✅ Enable Row Level Security (RLS)
- ✅ Fix RLS recursion issue (disabled for now)
- ✅ Add auto-create profile trigger on signup

### Business Setup Wizard
- ✅ Step 1 — Company details form
- ✅ Step 2 — GST registration form
- ✅ GSTIN format validation
- ✅ Auto-detect state from GSTIN
- ✅ Save organization to database
- ✅ Save GST registration to database
- ✅ Redirect new users to /setup automatically
- ✅ Dashboard shows company name + GSTIN

---

## PHASE 3 — Masters ✅

### Database
- ✅ Create customers table
- ✅ Create vendors table
- ✅ Create products table

### Constants
- ✅ All 37 Indian states with GST state codes
- ✅ Business types list
- ✅ GST registration types list
- ✅ validateGSTIN() function
- ✅ getStateFromGSTIN() function

### Customers
- ✅ Customer list page
- ✅ Add customer form (modal)
- ✅ Edit customer
- ✅ GSTIN validation on form
- ✅ State dropdown
- ✅ Search by name, GSTIN, phone, email
- ✅ Customer type badge (B2B, B2C, Export, SEZ)
- ✅ Active/inactive status

### Vendors
- ✅ Vendor list page
- ✅ Add vendor form (modal)
- ✅ Edit vendor
- ✅ Search functionality

### Products
- ✅ Product list page
- ✅ Add product form (modal)
- ✅ Edit product
- ✅ Goods vs Service toggle
- ✅ HSN/SAC field
- ✅ GST rate selector (0, 5, 12, 18, 28%)
- ✅ Inventory tracking toggle
- ✅ Opening stock and minimum stock
- ✅ Filter by type (goods/services)

### Navigation
- ✅ Sidebar with all sections
- ✅ Active page highlighting
- ✅ Organization name and GSTIN in sidebar

---

## PHASE 4 — Invoicing ✅

### Database
- ✅ Create invoices table
- ✅ Create invoice_items table
- ✅ Create invoice_sequences table

### GST Engine
- ✅ determineGSTType() — same state vs interstate
- ✅ calculateLineItem() — per line tax calculation
- ✅ calculateInvoiceTotals() — invoice summary
- ✅ getFinancialYear() — India FY (April-March)
- ✅ formatINR() — Indian number format
- ✅ numberToWords() — amount in words (crores, lakhs)
- ✅ round2() — 2 decimal rounding

### Invoice Creation
- ✅ Invoice number auto-generation (INV-2026-27-0001)
- ✅ Seller details from org profile
- ✅ Customer selection with auto-fill (GSTIN, state)
- ✅ Place of supply with auto-detect
- ✅ Supply type (B2B, B2C, Export, SEZ)
- ✅ GST type indicator (CGST+SGST vs IGST)
- ✅ Reverse charge flag
- ✅ Line items with product selector
- ✅ Live GST calculation as user types
- ✅ Tax breakdown under each line item
- ✅ Discount per line item
- ✅ Invoice summary (right panel)
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Save as draft
- ✅ Save as sent
- ✅ Stock auto-reduces on invoice save

### Invoice List
- ✅ List all invoices
- ✅ Invoice number, customer, date, amount, status
- ✅ Payment status badge
- ✅ Click to open detail

### Invoice Detail
- ✅ Full invoice view (print-ready)
- ✅ TAX INVOICE header
- ✅ Seller and buyer details
- ✅ Line items table with CGST/SGST/IGST columns
- ✅ Totals section
- ✅ Amount in words
- ✅ Notes and terms
- ✅ Authorised signatory section
- ✅ Mark as Paid button (sent invoices only)
- ✅ Cancel invoice
- ✅ Print / PDF button
- ✅ Print styles (hides navigation)

---

## PHASE 5 — Purchases ✅

### Database
- ✅ Create purchase_bills table
- ✅ Create purchase_bill_items table
- ✅ Create expenses table

### Purchase Bills
- ✅ Bill list with ITC summary cards
- ✅ Add bill form (modal)
- ✅ Vendor selection with auto-fill
- ✅ GST calculation (same engine as invoices)
- ✅ ITC eligible toggle
- ✅ ITC amount shown in list
- ✅ Mark bill as paid
- ✅ Stock auto-increases on bill save

### Expenses
- ✅ Expense list with summary cards
- ✅ Add expense form
- ✅ 16 expense categories
- ✅ GST calculation (tax-inclusive — backs out GST from total)
- ✅ ITC eligible flag
- ✅ Payment mode selection
- ✅ Vendor linking (optional)

---

## PHASE 6 — Payments ✅

### Database
- ✅ Create payments table

### Payments Page
- ✅ Summary cards (receivable, payable, overdue, this month)
- ✅ Receivables tab with ageing
- ✅ Payables tab with ageing
- ✅ Ageing buckets (current, 30d, 60d, 90d+)
- ✅ Record payment modal
- ✅ Full payment recording
- ✅ Partial payment recording
- ✅ Payment mode and reference number
- ✅ Invoice/bill updates to paid/partial automatically
- ✅ Paid invoices removed from receivables list
- ✅ Recent payments section
- ✅ Payments added to sidebar

---

## PHASE 7 — Inventory ✅

### Database
- ✅ Create stock_movements table
- ✅ Create warehouses table
- ✅ Add last_stock_update to products
- ✅ Create record_stock_movement() database function

### Inventory Page
- ✅ Summary cards (tracked products, stock value, low stock, out of stock)
- ✅ Stock levels tab
- ✅ Low stock filter
- ✅ Out of stock filter
- ✅ Search products
- ✅ Stock level per product with color coding
- ✅ Manual add stock
- ✅ Manual remove stock
- ✅ Stock preview before confirming
- ✅ Minimum stock alert
- ✅ Stock movements tab
- ✅ Filter movements by product
- ✅ Movement type badges
- ✅ Auto-reduce on invoice save
- ✅ Auto-increase on purchase bill save
- ✅ Inventory added to sidebar

---

## PHASE 8 — GST Reports ✅

### Database
- ✅ Create gst_return_periods table

### GST Dashboard
- ✅ Period selector (last 6 months)
- ✅ Output tax section (total sales, taxable, CGST, SGST, IGST)
- ✅ ITC section (purchases, CGST, SGST, IGST ITC)
- ✅ Net payable card (green if zero, red if payable)
- ✅ Return filing status tracker
- ✅ Update return status (dropdown)
- ✅ Links to GSTR-1 and GSTR-3B

### GSTR-1
- ✅ Period selector
- ✅ Summary cards (invoices, taxable, tax, total)
- ✅ B2B tab (with GSTIN column)
- ✅ B2C tab
- ✅ Export/SEZ tab
- ✅ HSN Summary tab (qty, value, tax by HSN code)
- ✅ Totals row in B2B
- ✅ Export to CSV
- ✅ GST compliance warning

### GSTR-3B
- ✅ Period selector
- ✅ Section 3.1 (outward supplies: B2B, B2C, export, nil)
- ✅ Section 4 (ITC available: IGST, CGST, SGST)
- ✅ Section 6.1 (net tax payable: tax − ITC)
- ✅ CGST/SGST/IGST columns
- ✅ Total row
- ✅ Export to CSV
- ✅ GST compliance warning

---

## PHASE 12 — Reports & Dashboard ✅

### Live Dashboard
- ✅ Real sales, purchases, expenses for current month
- ✅ GST summary (collected, ITC, payable)
- ✅ Outstanding receivables and payables
- ✅ Overdue receivables
- ✅ 6-month sales bar chart
- ✅ GST return status widget
- ✅ Recent invoices (last 5, clickable)
- ✅ Empty state if no invoices

### Reports Page
- ✅ Period selector (month, last month, quarter, FY)
- ✅ Sales tab
  - ✅ Summary cards (total, taxable, tax, count)
  - ✅ Sales by customer (ranked)
  - ✅ Sales by product (ranked)
  - ✅ Sales by state
- ✅ Purchases tab
  - ✅ Summary cards
  - ✅ Purchases by vendor (with ITC)
- ✅ GST Summary tab
  - ✅ Output vs ITC vs Net payable grid
  - ✅ CGST/SGST/IGST breakdown
- ✅ Profit Overview tab
  - ✅ Revenue, purchases, expenses
  - ✅ Gross profit and net profit
  - ✅ Profit margin percentage
  - ✅ Disclaimer note
- ✅ CSV export on all tabs

---

## VERSION 1 — Shipped ✅

### Settings Page ✅
- ✅ Invoice number prefix (change INV to custom)
- ✅ Company logo upload (Supabase Storage, `logos` table)
- ✅ Bank account details (for invoice footer)
- ✅ Default payment terms
- ✅ Financial year selection
- ✅ Invoice template selection (three skins, per organisation)

### Quotations ✅
- ✅ Create quotation, list and detail view
- ✅ Convert quotation to invoice
- ✅ Own sequence per FY, PDF print

### Credit Notes ✅
- ✅ Create credit note against an invoice, list, own sequence
- ✅ Folded into GSTR-1 / GSTR-3B / registers / targets as signed rows (CDRN reflected in the annual workpaper)

### Debit Notes ✅
- ✅ Create debit note, list, own sequence, feeds the ledger and registers

### Mobile responsive shell ✅ (September–October 2026)
- ✅ Sidebar, bottom nav, sheet menu, card views at 375 / 768 / 1024 / 1440

### Email Invoices ⏳
- ⏳ Email invoice PDF to customer, templates, send log

### Multi-User ⏳
- ⏳ Invite user by email, role selection (owner / accountant / staff), RBAC, remove user

---

## ROUND 1 — Competitive Features (2026-10-05) ✅

Features ranked against Tally, Zoho, Vyapar, myBillBook, Marg, Busy, Refrens, Clear, CaptainBiz and Swipez. All shipped client-side, no schema change.

- ✅ **1. GSTR-2B ↔ books ITC reconciliation** — `/gst/reconciliation` + `src/lib/gstr2b.ts`
- ✅ **2. E-invoice (IRN) + e-way bill** — `/gst/einvoice` + `src/lib/einvoice.ts` (NIC v1.10 JSON, build → download → paste ACK), GSP adapter layer `src/lib/gsp/*` + `/api/gsp/ewaybill` (mock provider)
- ✅ **3. Payment links + WhatsApp reminders** — `/payments/links` + `src/lib/payments.ts` (`upi://pay` deep links, `wa.me` reminders, three tones)
- ✅ **4. Light double-entry** — `/accounting` + `src/lib/ledger.ts` (P&L excluding GST, always-balancing balance sheet, localStorage opening balances)
- ✅ **5. Offline PWA** — `/offline`, `app/manifest.ts`, `public/sw.js`, `public/offline.html`, `src/lib/outbox.ts` (temporary OFF- numbers replayed through the real save path)
- ✅ **6. Barcode scan + POS** — `/pos`, `src/lib/barcode.ts` (GS1 mod-10, EAN-13/EAN-8/UPC-A/ITF-14/CODE-128), `src/components/BarcodeScanner.tsx`, `src/lib/create-invoice.ts` extracted as the single invoice write path
- ✅ **7. AI features** — `/ai/scan-bill` (`bill-text.ts`, `ocr.ts`: tesseract.js + pdf.js via `/api/pdf-worker`, GST cross-validation with per-field confidence) and `/ai/ask` (`ask.ts`: 17 intents, FY-period parsing, party/product/HSN filters). Deterministic and in-browser; `src/lib/create-bill.ts` is the shared bill write path

---

## ROUND 2 — Depth and Craft (2026-10-06 → 2026-10-07) ✅

- ✅ **R2-1 Design system v1** (`63faa25`) — tokens + `.tf-*` in `globals.css`, `Icons.tsx`, `ui.tsx`, `format.ts`, `reports.ts`; app shell and dashboard rebuilt
- ✅ **R2-2 Party ledger** (`16257ef`) — `/ledger` + `party-ledger.ts`; document-first payment linking
- ✅ **R2-3 Compliance calendar** (`36b3240`) — `/gst/calendar` + `compliance.ts`; filing-profile FY generator, late-fee estimates, `.ics`
- ✅ **R2-4 Statutory registers** (`158c44b`) — `/reports/registers` + `registers.ts`; party-wise, HSN/SAC, B2B, Rule 80(1) state-wise, e-way bill log
- ✅ **R2-5 Invoice document templates** (`a928653`) — `InvoiceDocument.tsx` (`modern`, `minimal` over the classic sheet), `words.ts`
- ✅ **R2-6 Targets and achievement** (`bd176c4`) — `/reports/targets` + `targets.ts`; festival-weighted split, prorated pace, product goals
- ✅ **R2-7 Reorder planner** (`83d369a`) — `/inventory/reorder` + `reorder.ts`; (s, S) policy, supplier-grouped POs; fixed the `current_stock` data-loss bug
- ✅ **R2-8 ⌘K command palette** (`f3b3d49`) — `commands.ts`, `CommandPalette.tsx`, `nav.ts`, `deep-link-search.ts`; `?q=` search added to bills, credit notes, debit notes, quotations
- ✅ **Hotfix pass** (`0aba36f`) — register line-item fetch 400, mobile toolbar overflow, 36 MB invoice PDFs
- ✅ **R2-9 GSTR-9 / 9C annual workpaper** (`95e1ee8`) — `/gst/gstr9` + `gstr9.ts`; outward and ITC tables, 180-day credit watch, 9C books-vs-3B reconciliation, CSV export
- ✅ **R2-10 Bank statement import + auto-match** (`7560987`) — `/bank` + `bank-statement.ts`; delimiter/header/date/amount detection for pasted or uploaded statements, direction resolved from split Dr./Cr. columns, cell sign, Dr/Cr indicator or running-balance delta, UTR de-duplication, weighted scoring (amount 40 · document number 30 · party 18 · date 12, recorded-payment reference 45) with exact/likely/possible tiers, confirm / set aside / undo, advisory text for unexplained lines, CSV export, storage in `taxflow:bank:<orgId>`
- ✅ **R2-11 TDS / 194Q withholding workpaper** (`cafc86b`) — `/tds` + `tds.ts`; section table (194A, 194C, 194H, 194I land/plant, 194J professional/technical, 194M, 194Q, 194R) with whole-vs-excess threshold modes, base read out of purchase bills with GST excluded when itemised, deduction month on the earlier of credit or payment, deposit calendar (7th of the next month, March → 30 April), 1.5%/1% monthly interest and 26Q late-fee ₹100/day capped at the tax and ₹5,00,000, PAN from the vendor or its GSTIN else the no-PAN rate, untagged spend surfaced instead of guessed, quarterly 26Q statements, two CSV sheets, storage in `taxflow:tds:<orgId>`

---

## ROUND 2 — Backlog ⏳

- 🔄 **R2-12 Design-system migration pass** (in progress) — counted from the code: **28** pages fully on the kit, **4** import only `SearchInput`, **4** still pre-kit (+3 auth pages). `4-Design-System.md` §16 is the ledger and the order. Done so far: `invoices` (list), `expenses`, the whole masters tier — `vendors`, `customers`, `products` — the whole money tier: `payments`, `payments/links`, `accounting`, `offline`, the whole GST tier: `gst` hub, `gstr1`, `gstr3b`, `gstr9`, `gstr4`, `calendar`, `reconciliation`, `einvoice`, and the counter and AI block: `pos`, `inventory`, `ai/ask`, `ai/scan-bill`. Next: reports and settings, then auth pages, documents last
- ✅ **R2-13 GSTR-4 / CMP-08 composition workpaper** — `/gst/gstr4` + `src/lib/gstr4.ts` (53 assertions). Turnover split by the HSN/SAC on each line, the slab test with the ten Notification 17/2020 states, CMP-08 quarters against declared deposits, the 2.5% deemed debit, and the documents that bar the scheme. Also fixes the calendar: GSTR-4 was generated a year late and CMP-08 linked to GSTR-3B.
- ✅ **GST 2.0 rule-drift pass** (`5d92515`) — from `7-Competitor-Comparison.md` §9: `src/lib/gst-rates.ts` became the single rate table (0 · 0.25 · 3 · 5 · 12 · 18 · 28 · 40) imported by all eight pickers, the e-invoice page now states the 30-day IRN window above ₹10 crore, the HSN register carries the Table 12 digit rule, and the calendar offers the 31 March CMP-02 opt-in to non-composition filers.
- ⏳ TDS/TCS return filing (26Q/24Q upload, 206C collection)
- ⏳ Real GSP submission for e-invoice / e-way bill (blocked: no free government API; needs a contracted provider)

---

## PHASE 14 — Security ⏳

- ⏳ Fix Supabase RLS for @supabase/ssr 0.12.x
- ⏳ Re-enable / tighten RLS on all tables (policies are hand-managed in the dashboard)
- ⏳ Test organization isolation with multiple accounts
- ⏳ Add audit log table + viewer
- ⏳ Rate limiting if any server route is added beyond `/api/gsp` and `/api/pdf-worker`
- ⏳ Generated Supabase types to retire the `as any[]` baseline

---

## PHASE 13 — SaaS Subscriptions ⏳

- ⏳ Define plan tiers (Free, Starter, Professional)
- ⏳ Create plans and features table
- ⏳ Usage tracking (invoices per month)
- ⏳ Plan limits enforcement
- ⏳ Razorpay integration
- ⏳ Subscription management page
- ⏳ Upgrade/downgrade flow
- ⏳ Trial period
- ⏳ Invoice for subscription payment

---

## VERSION 2 — Future ⏳

Shipped: ✅ e-invoice IRN payload builder · ✅ e-way bill payload + register · ✅ GSTR-9/9C workpaper · ✅ GSTR-4 / CMP-08 composition workpaper · ✅ bank statement matching · ✅ TDS / 194Q withholding workpaper · ✅ WhatsApp reminders · ✅ payment links · ✅ OCR bill scanning · ✅ installable PWA (a web-first "mobile app")

Remaining: ⏳ TDS/TCS return filing (26Q/24Q upload, 206C collection) · ⏳ GSTR-4/3B actual submission (needs a contracted GSP) · ⏳ design-system migration pass (R2-12) · ⏳ native mobile app · ⏳ accountant portal · ⏳ API access · ⏳ payroll

---

## Known Issues / Bugs

| Issue | Status | Notes |
|-------|--------|-------|
| RLS disabled / partial | Pending Phase 14 | App-level `organization_id` isolation active |
| @supabase/ssr 0.12.x proxy/middleware | Pending | Fixed by disabling RLS temporarily |
| `as any[]` on every Supabase read | Baseline | No generated types; eslint `no-explicit-any` errors are pre-existing |
| 4 pages still pre-kit, 4 partly | Debt | R2-12 migration pass; the whole GST tier and the counter/AI block are now on the kit. `4-Design-System.md` §16 is the ledger |
| Font stack declares Inter, `next/font` loads Geist | Cosmetic | Nothing consumes `--font-geist-sans`; renders on the system stack |
| GSP submission is a mock | Blocked | No free government API; adapter ready for a real provider |
| Two amount-in-words implementations | Intentional | Legacy `numberToWords` still drives the classic print layout |

---

## Testing Checklist (run before each deploy)

- [ ] Can signup a new user
- [ ] Email confirmation works
- [ ] Can login and logout
- [ ] New user redirected to /setup
- [ ] Business setup saves correctly
- [ ] Can add customer, vendor, product
- [ ] Can create invoice with GST calculation
- [ ] CGST+SGST for same state, IGST for different state
- [ ] Invoice saves and shows in list; detail opens, prints and exports a sane-size PDF
- [ ] Quotation → invoice conversion keeps the numbers
- [ ] Credit note reduces the month it is dated in (registers, targets, GSTR-1)
- [ ] Can add purchase bill and expense; bill scan produces a valid draft
- [ ] Payment recording works; ledger balance sign is right
- [ ] Stock moves on invoice and on bill; a product edit does not reset `current_stock`
- [ ] GST dashboard, GSTR-1, GSTR-3B, GSTR-9 and registers reconcile to a hand-check
- [ ] 2B reconciliation classifies the seeded mismatches
- [ ] E-invoice JSON validates against the NIC shape
- [ ] Compliance calendar matches the filing profile; `.ics` imports
- [ ] Targets pace and reorder suggestions recompute after a new invoice
- [ ] POS: barcode scan, cash sale settles, stock moves
- [ ] Offline: airplane-mode invoice replays with a real INV number on reconnect
- [ ] ⌘K: pages, actions and live records; a hit never lands on an empty list
- [ ] Dashboard shows real metrics
- [ ] Every page above is checked at 375–455px **and** 1440px with zero horizontal overflow
