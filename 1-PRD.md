# TaxFlow India — Product Requirements Document (PRD)

**Version:** 2.0  
**Date:** October 2026  
**Status:** MVP + Version 1 complete — Version 2 shipping in feature rounds (Round 1 closed, Round 2 in progress)  

---

## 1. Product Overview

### Product Name
TaxFlow India

### Tagline
GST Billing, Invoicing & Compliance for Indian Businesses

### What is it?
TaxFlow India is a web-based SaaS application that helps Indian small and medium businesses manage their GST billing, invoicing, purchases, expenses, payments, inventory, and GST return preparation — all in one place.

### Who is it for?
| Customer Type | Example |
|---------------|---------|
| Small traders | Shop owners, wholesalers, distributors |
| Service businesses | Consultants, agencies, freelancers |
| Manufacturers | Small factories, workshops |
| Professionals | CAs, lawyers, doctors |
| Accountants | Managing multiple client businesses |

### Core Problem it Solves
Indian businesses struggle with:
- Creating GST-compliant invoices correctly
- Tracking CGST / SGST / IGST separately
- Preparing GSTR-1 and GSTR-3B data every month
- Tracking who owes them money and who they owe
- Managing purchases and claiming ITC correctly
- Keeping inventory in sync with sales and purchases

### Unique Selling Points
1. Built specifically for Indian GST — not adapted from foreign software
2. Auto-detects CGST+SGST vs IGST based on state
3. Generates GSTR-1, GSTR-3B and the GSTR-9/9C annual workpaper instantly, with a 2B-to-books reconciliation that says exactly which input credit to leave out
4. Compliance calendar that knows the filing profile (monthly / QRMP / composition) and prices the late fee before it happens
5. Works at the counter: camera barcode POS, UPI payment links, WhatsApp reminders, and an offline outbox that replays invoices the moment the network returns
6. Free to start — no credit card needed
7. Simple enough for a non-accountant to use, deep enough that a CA does not open Tally to check a number
8. The AI features run in the browser: a supplier's bill is never uploaded, and every answer traces back to the rows it came from
9. Bank reconciliation without a bank feed: any statement layout is read in the browser and each line is pointed at the document it matches, with the score explained — software that charges for this needs a paid feed
10. Withholding tax read straight out of the purchase books: which section each supplier falls under, what crosses the limit, when the deposit was due and what the delay costs — the depth that costs extra in the ERPs

---

## 2. Product Versions

### MVP (Built)
Everything a business needs to operate day-to-day:
- Business setup with GSTIN
- Customer, vendor, product management
- GST sales invoices (B2B, B2C, Export, SEZ)
- Purchase bills with ITC tracking
- Expense tracking
- Payment recording (receivables + payables)
- Inventory with stock movements
- GST Dashboard (output tax, ITC, net payable)
- GSTR-1 data preparation
- GSTR-3B data preparation
- Business reports (sales, purchase, GST, profit)
- PDF invoice printing

### Version 1 (Built)
- Quotations → convert to invoice
- Credit notes and debit notes, folded into GST reporting as signed rows
- Company logo on invoices, bank details on invoices
- Settings page (invoice prefix, FY settings)
- Better PDF invoice templates — three document skins, chosen per organisation
- Mobile-responsive shell, installable PWA

### Version 2 (in progress — shipped as feature rounds)
Round 1, closed:
- GSTR-2B ↔ books ITC reconciliation (`/gst/reconciliation`)
- E-invoice (IRN) + e-way bill payloads as download-and-paste JSON (`/gst/einvoice`)
- Payment links + WhatsApp reminders (`/payments/links`)
- Light double-entry: P&L and balance sheet derived from documents (`/accounting`)
- Offline PWA with an invoice outbox that replays through the normal save path (`/offline`)
- Camera barcode scan + counter sale POS (`/pos`)
- Bill OCR scanning and natural-language reporting (`/ai/scan-bill`, `/ai/ask`)

Round 2, R2-1 … R2-11:
- Design system v1 (tokens, UI kit, app shell)
- Party ledger accounts and statements of account (`/ledger`)
- Compliance calendar with late-fee estimation and `.ics` export (`/gst/calendar`)
- Statutory registers: party-wise, HSN/SAC, B2B, state-wise, e-way bill (`/reports/registers`)
- Invoice print/PDF templates (`classic`, `modern`, `minimal`)
- Targets & achievement analytics with festival-weighted pacing (`/reports/targets`)
- Reorder levels and supplier-grouped purchase suggestions (`/inventory/reorder`)
- ⌘K command palette over pages, actions and live records
- GSTR-9 / 9C annual workpaper (`/gst/gstr9`)
- Bank statement import with scored matching to invoices, bills and recorded payments (`/bank`)
- TDS & 194Q withholding workpaper with deposit calendar and interest (`/tds`)

Still to come:
- GSTR-4 (Composition scheme) return workpaper
- Real GSP submission for e-invoice / e-way bill (blocked on paid GSP provider — see `6-Project-Memory.md`)
- Email invoices directly from the app
- Multi-user with roles (invite accountant/staff)

### Enterprise / Future
- Multi-company management
- Accountant portal (manage multiple clients)
- API access
- Mobile app (iOS + Android)
- Server-side AI (expense categorisation, GST error detection)
- Payroll
- Full accounting with a posted journal ledger

---

## 3. Feature Requirements

### 3.1 Authentication
- Email + password signup
- Email confirmation
- Secure login/logout
- Session management
- Password reset (future)

### 3.2 Business Setup
- Legal business name
- Trade name
- PAN
- Business type (Proprietorship, Pvt Ltd, etc.)
- Complete address with state and pincode
- GSTIN with format validation
- Auto-detect state from GSTIN
- GST registration type (Regular, Composition, SEZ, etc.)
- Registration date
- Multiple GSTIN support (future)

### 3.3 Customer Management
- Contact name + business name
- GSTIN with format validation
- PAN
- Customer type (B2B, B2C, Export, SEZ)
- Complete address with state
- Phone and email
- Payment terms (days)
- Notes
- Active/inactive toggle
- Search and filter

### 3.4 Vendor Management
- Same fields as customers
- Track outstanding payable
- Purchase history

### 3.5 Product & Service Master
- Name, description, SKU
- Type: Goods or Service
- HSN code (goods) / SAC code (services)
- Unit of measurement
- Purchase price and selling price
- GST rate (0%, 5%, 12%, 18%, 28%)
- Cess rate
- Inventory tracking toggle
- Opening stock, minimum stock

### 3.6 Sales Invoice
**Header:**
- Auto-generated sequential invoice number
- Invoice date and due date
- Seller details (auto from profile)
- Customer selection with auto-fill
- Place of supply with auto-detect from customer state
- Supply type (B2B, B2C, Export, SEZ)
- Reverse charge flag

**Line Items:**
- Product selection with auto-fill
- Item name, description, HSN/SAC
- Quantity, unit, rate
- Discount percentage
- Auto-calculated: taxable value, CGST, SGST, IGST, cess
- Multiple lines

**GST Engine:**
- Same state → CGST + SGST
- Different state → IGST
- Export/SEZ → IGST
- Live calculation as user types
- Round-off to nearest rupee

**Footer:**
- Subtotal, discount, taxable amount
- CGST, SGST, IGST breakdown
- Grand total
- Amount in words
- Notes and terms

**Actions:**
- Save as draft
- Save as sent
- Mark as paid (sent invoices only)
- Cancel invoice
- Print / PDF
- Document skin: `classic`, `modern`, `minimal`, remembered per organisation
- Created from three paths that share one write helper: the invoice form, the POS counter, and the offline outbox replay

### 3.7 Purchase Bills
- Vendor bill number (external)
- Vendor selection with auto-fill
- Place of supply
- ITC eligible toggle
- Line items with GST calculation
- ITC summary
- Mark as paid

### 3.8 Expenses
- Date, category, description
- Vendor (optional)
- Bill number
- Total amount with GST rate
- Auto-calculate GST from total (tax-inclusive)
- ITC eligible flag
- Payment mode and status

### 3.9 Payments
- Receivables tab: all unpaid/partial invoices
- Payables tab: all unpaid/partial bills
- Ageing buckets (current, 30d, 60d, 90d+)
- Record full or partial payment
- Payment mode, reference number
- Recent payment history

### 3.10 Inventory
- Stock level dashboard
- Low stock and out-of-stock alerts
- Stock value (at selling price)
- Manual adjustment (add/remove)
- Movement history per product
- Auto-update on invoice (reduce)
- Auto-update on purchase bill (increase)
- Editing a product must never rewrite stock from opening stock — `current_stock` is seeded on insert only
- Reorder levels, lead time and demand cover per product (see 3.24)

### 3.11 GST Dashboard
- Period selector (by month)
- Output tax (CGST, SGST, IGST collected)
- ITC available (from eligible purchases)
- Net GST payable
- Return filing status tracker
- Links to GSTR-1 and GSTR-3B

### 3.12 GSTR-1
- B2B invoices tab
- B2C invoices tab
- Export/SEZ invoices tab
- HSN/SAC summary tab
- Period and summary cards
- Export to CSV
- GST compliance warning

### 3.13 GSTR-3B
- Section 3.1: Outward supplies breakdown
- Section 4: ITC available
- Section 6.1: Net tax payable
- CGST/SGST/IGST columns
- Export to CSV
- Compliance warning

### 3.14 Reports
- Sales report (by customer, product, state)
- Purchase report (by vendor)
- GST summary (output vs ITC vs payable)
- Profit overview (revenue, costs, margin)
- Period selector (month, quarter, FY)
- CSV export

### 3.15 Dashboard
- Real-time metrics (sales, purchases, expenses)
- GST summary for current month
- Outstanding receivables and payables
- 6-month sales bar chart
- GST return status
- Recent invoices

### 3.16 GSTR-2B Reconciliation
- Paste or upload the 2B statement (JSON/CSV as downloaded from the portal)
- Match line by line against purchase bills in the books
- Classify: matched, credit in books but not 2B, credit in 2B but not booked, mismatched amount
- Show ITC at risk and the exact bills to chase with the supplier
- Nothing is filed — the output is a workpaper

### 3.17 E-Invoicing and E-Way Bill
- Build the NIC e-invoice JSON (DtSpec version 1.10) from a saved invoice, with IRN-side validation errors surfaced before download
- Build a GSP-shaped e-way bill payload for the consignee, transport and distance
- Download-and-paste flow: the user submits on the portal / GSP and pastes the IRN and ACKNo back
- Submitted bills logged into the e-way bill register
- Provider adapter layer (`src/lib/gsp`) with a mock simulator, ready for a real GSP when one is contracted

### 3.18 Payment Collection
- UPI deep links (`upi://pay`) built from the seller's VPA and the invoice amount
- WhatsApp reminder links (`wa.me`) with three tones, placeholders for customer, business, invoice, amount, due date and link
- Per-organisation payee settings stored locally; no payment gateway account required

### 3.19 Party Ledger
- Statement of account per customer/vendor: opening, invoices, credit and debit notes, receipts, running balance
- Payments linked through their document first and a normalised party-name key second
- Sign convention: positive = to receive, negative = to pay
- Downloadable/printable statement

### 3.20 Financial Statements
- P&L excluding GST, derived from invoices, bills, expenses and credit notes
- Balance sheet that always balances, with a transparent "Capital account (derived)" plug
- Opening balances per organisation in local storage
- Not a posting journal — documented as a derived view

### 3.21 Compliance Calendar
- Filing profile: monthly / QRMP / composition × TDS × employees × audit × professional tax
- Generated FY of GST, TDS, income-tax and payroll due dates with countdowns
- Late-fee estimator: ₹50/day capped ₹5,000 (₹20 nil), 234E ₹200/day, 18% GST interest
- `.ics` export and Google Calendar links; filing state per organisation in local storage

### 3.22 Statutory Registers
- Party-wise turnover, HSN/SAC summary (rate mix per code, nil-rate flagged exempt), invoice-level B2B, Rule 80(1) state-wise outward, e-way bill log
- Credit notes reduce the period they are dated in — signed rows, never absolute values
- CSV export per register

### 3.23 Targets and Achievement
- Annual sales/expense plan per month, product-level goals on amount or quantity
- Festival-weighted split (a plan must total exactly what was typed)
- Running month judged against prorated expected-to-date with pace bands, not percent-complete
- Measured on taxable value, GST excluded

### 3.24 Reorder Planning
- Demand from invoice lines minus credit-note lines over a trailing window
- Classic (s, S) policy: reorder point = lead-time demand + safety; order-up-to = demand over lead+cover + safety
- The owner's own `minimum_stock` is honoured and labelled as their opinion
- Suggestions grouped into supplier-wise purchase orders

### 3.25 Counter Sale (POS)
- Product grid, cart, GST split through the shared engine
- Camera barcode scanning with GS1 check-digit validation and EAN-13↔UPC-A variant matching; degrades to manual/USB keyboard-wedge input
- Walk-in sales billed to an auto-created cash customer; Cash/UPI/Card settle the invoice on the spot

### 3.26 Offline Operation
- Installable shell: network-first navigations, cache-first hashed statics, offline fallback page
- Invoices saved without a connection get a temporary number and are replayed through the exact online save path on reconnect — real sequence number, line items, stock movement
- No separate offline data model, so replay cannot diverge from the online path

### 3.27 Scanned Documents and Natural-Language Reporting
- Extract supplier, GSTIN, bill number, date, HSN and line items from raw OCR/PDF text
- Cross-validate each field against GST arithmetic (qty×rate−disc = taxable; taxable×(1+gst%) = row total) with per-field confidence
- Answers on 17 intents (sales, purchases, expenses, profit, GST collected/ITC/payable, receivables, payables, collections, cash, invoice count, average invoice, top customers/vendors/products, breakdown) with financial-period parsing and party/product/HSN/category filters from the user's own data
- Everything deterministic and in-browser; nothing leaves the device

### 3.28 Command Palette
- ⌘K / Ctrl-K over navigation, the two create actions, and live rows from eight tables
- AND-token matching with field weights and a GSTIN fast path
- Recent records, keyboard navigation, correct listbox semantics
- Deep links: an invoice opens the document, anything else opens its list page with `?q=` pre-filled

### 3.29 GSTR-9 / 9C Annual Workpaper
- Outward and ITC tables built from the year's documents, plus the 180-day credit watchlist
- 9C books-vs-filed-3B reconciliation using the owner's declared monthly 3B figures, Rule 42/43 reversals and Table 8/9 input
- Portal-only data is shown as a labelled gap rather than invented
- CSV export of every table

### 3.30 Bank Statement Matching
- Paste or upload a statement from any Indian bank — delimiter, header wording, date style and amount style are detected, not configured
- Direction read from split Dr./Cr. columns, a signed cell, a Dr/Cr indicator, or the running-balance delta
- Each line scored against open invoices, open bills and payments already recorded, with the reasons shown ("exact amount of ₹4,42,500.00 · carries the document number 1244432 · narration names Mohd Faizan")
- Exact / likely / possible tiers; unexplained lines get a plain guess at what they are (interest, GST challan, salary, EMI, bank charge) instead of a blank row
- Confirm, set aside and undo live in the browser; the ledger is still written on the Payments page, and the matched sheet exports to CSV

### 3.31 TDS & 194Q Withholding Workpaper
- Reads the financial year's purchase bills and the payments made against them; no bill is written to and nothing is filed
- A section table (194C, 194H, 194I land/plant, 194J professional/technical, 194Q, 194M, 194A, 194R) with each rate, no-PAN rate, limit and the position taken on whole-bill versus above-the-limit charging
- Because a purchase bill carries no expense category, the section is chosen once per supplier with a per-bill override; untagged value is reported as untagged, never guessed at
- Base excludes GST when the supplier itemised it, tax falls on the earlier of credit and payment, deposit is due the 7th of the next month (March until 30 April)
- Interest estimated the way the Act counts it — 1.5% a month on a late deposit, 1% a month where tax was never deducted, part-month counted — plus the ₹100-a-day 26Q statement fee capped at the tax
- PAN read from the vendor record, else from the GSTIN, else the no-PAN rate with the gap stated
- Deductee sheet and month-by-month deposit sheet export to CSV; tags, challans and payer type live in `taxflow:tds:<orgId>`

---

## 4. Non-Functional Requirements

### Performance
- Page load under 3 seconds
- Invoice calculation instant (client-side)
- Reports load under 5 seconds
- Register and workpaper pages fetch line items in bounded batches (500 ids at a time) so a full-FY report does not trip the gateway
- The service worker keeps the shell and statics available with no network; invoice PDFs are capped so a document does not become a 36 MB download

### Security
- All data isolated per organization
- No organization can see another's data
- Secure authentication via Supabase
- HTTPS only
- Input validation on all forms
- Per-organisation local-storage keys (`taxflow:<feature>:<orgId>`) so one browser signed in as two businesses never mixes settings, plans or outboxes
- OCR, bill scanning and natural-language reporting run in the browser; no document is uploaded to a third party

### GST Compliance
- All GST rules must be configurable, not hard-coded
- Rules stored in database with effective dates
- Historical invoices retain the tax rate at time of creation
- Compliance warnings on all GST reports
- Always verify against gstn.gov.in before actual filing

### Reliability
- 99%+ uptime via Vercel
- Database backups via Supabase
- Error handling on all API calls

---

## 5. Out of Scope (Current Version)
- Direct GST portal filing (requires GSP authorization) — the app prepares and exports workpapers only
- Live IRP/GSP submission (e-invoice and e-way bill ship as build → download → paste-back)
- Bank feeds / account aggregation (statement import is the next step, not a live connection)
- Payroll
- TDS / TCS return filing — `/tds` builds the withholding workpaper and deposit calendar, but no Form 26Q or 24Q is filed, and TCS under 206C is not covered
- Multi-currency
- Native mobile app (the web app is an installable PWA)
- Server-side LLM features — by design, so a business's bills never leave the device
- New database tables or migrations; feature work rides on the existing schema plus per-organisation local storage
