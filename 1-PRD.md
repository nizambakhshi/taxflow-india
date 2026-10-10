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
11. Knows the shop's own making as well as its buying: recipes that roll their cost up from the product master, a build log that prints the wastage instead of smoothing it and remembers *which lot* each draw came off, and a materials board that says *which run today's shelf cannot cover* — not merely which parts are short

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

Round 2, R2-1 … R2-30:
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
- Every page migrated onto the kit — 51 pages on the shared primitives, the three auth surfaces on one `AuthShell`, the public portal page counted the same way
- Order flow: delivery challans under rule 55, sales orders, purchase orders, and conversion into a real invoice or bill (`/challans`, `/sales-orders`, `/purchase-orders`)
- Batch/expiry register with FEFO drawdown, serial-number register (one row per physical unit), godown register with transfers as lot splits (`/inventory/batches`, `/inventory/serials`, `/inventory/godowns`)
- Customer portal: a statement of account that travels inside its own share link, read from the URL fragment with nothing stored server-side (`/portal`)
- GSTR-4 / CMP-08 composition workpaper (`/gst/gstr4`)
- Recurring invoices as a schedule that accrues, with catch-up back into the FY it belonged to (`/recurring`)
- Foreign-currency deals over a dated, source-stamped rate ledger (`/fx`)
- Job work / rule 45 outbound with the section 143 return clock and the ITC-04 workpaper (`/gst/job-work`)
- Cost centres: an allocation stores a share, the rupees re-read from the documents (`/cost-centres`)
- Tally bridge: import a Tally export into a plan with reasons, and export vouchers back (`/tally`)
- Projects & time: hours measured, whole documents attached by id, labour priced not costed, rule 47 window cited (`/projects`)
- Manufacturing: recipes and builds, the answer to *what the shelf cannot run today*, and — since R2-30 — the vendor-grouped purchase-order drafts that shortage turns into (`/inventory/recipes`)
- Exports: the undertaking clock and the FEMA realisation window on every consignment, with the refund limitation beside them (`/gst/exports`)
- The books vault: every device-side register — batches, serials, godowns, LUTs, workpapers, settings — backed up into one portable file and restored through the pages that own the data, each proved by reading back through its own loader (`/vault`)
- Payroll: the salary register — six components per person, the month run, section 192 walked over the year, the dues a month owes and the rupee an hour costs (`/payroll`)

Still to come:
- Real GSP submission for e-invoice / e-way bill (blocked on paid GSP provider — see `6-Project-Memory.md`)
- Email invoices directly from the app
- Multi-user with roles (invite accountant/staff)
- E-commerce channel integrations, document attachments, an API — the rest of `7-Competitor-Comparison.md` §8, each needing a contract, a schema change or a platform decision

### Enterprise / Future
- Multi-company management
- Accountant portal (manage multiple clients)
- API access
- Mobile app (iOS + Android)
- Server-side AI (expense categorisation, GST error detection)
- Payroll *as a payment system* — payslips delivered, salary actually paid, the old-regime opt-out computed and Form 16 Part A pulled from TRACES. `/payroll` (R2-31) computes the register; the money still leaves at `/expenses`
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
- Lot-level stock with FEFO and expiry watch, one row per physical unit, and named places stock stands in (see 3.34)
- What a finished good is made of, and what making it did to the stock (see 3.42)

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
- Generated FY of GST, TDS, income-tax and payroll due dates with countdowns — and since R2-31 the salary rows are *read from the payroll register* (`payrollEvents()`) rather than guessed from the filing profile, which retires the profile's monthly PF/PT tick-box for every month the books actually ran
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

### 3.32 GSTR-4 / CMP-08 Composition Workpaper (R2-13)
- Turnover split by the HSN/SAC each line carries and tested against the slab, with the ten Notification 17/2020 special-category states named rather than folded into one rate
- CMP-08 quarters judged against the deposits the owner declares; the 2.5% deemed debit is shown as a line the owner must confirm
- The documents that bar the scheme are listed as disqualifiers rather than priced
- Declared figures live in `taxflow:gstr4:<orgId>`; the calendar stopped generating GSTR-4 a year late and stopped linking CMP-08 to GSTR-3B

### 3.33 Order Flow — Challans, Sales Orders, Purchase Orders (R2-14)
- `/challans` keeps the rule 55 delivery challan register with a printable, token-drawn document; `DC-<FY>-NNNN` numbers are never reused, per kind and per financial year
- `/sales-orders` and `/purchase-orders` share one register and one document behind a per-kind copy table — confirm → close, place → receive
- Conversion writes through the real paths: an order becomes an invoice with a real `INV-<FY>-NNNN`, and a purchase order becomes a bill whose number is **the vendor's own**, because that is the figure GSTR-2B matches
- The three stores join the statutory registers (an Order flow tab in `/reports/registers`) and synchronous ⌘K search; the documents live in `taxflow:challan|sorder|porder:<orgId>`

### 3.34 Batch, Expiry, Serial and Godown Registers (R2-15, R2-17)
- Lots in `taxflow:batches:<orgId>` with signed movements; expiry is judged against the day printed on the pack and `daysLeft: 0` means "expires today"
- FEFO allocation previews a draw expired-first and warns without blocking, and `recordSale` is called from `create-invoice.ts` — the invoice form, the counter and the offline replay all consume lots
- A serial is an identity, not a quantity: one row per physical unit, an append-only event log, status read from the latest event, and the warranty window recomputed from the **latest** sale — a resale restarts the clock, a return restocks without forking the unit's history
- A godown is a named place: a virtual `Main` holds every unplaced lot, and a transfer is a **split** — a destination lot that keeps the source identity plus one negative move on the source — so `left = qty + back − out` and FEFO sorting never move
- Boundary printed on the page: per-place figures cover registered lots only; `products.current_stock` has no per-godown column

### 3.35 Customer Portal — the Statement Travels Inside Its Own Link (R2-16)
- `/portal` needs no server route: the statement is JSON → deflate → base64url in the URL **fragment**, which never reaches a server, so nothing is stored and nothing has to be revoked
- The payload is the ledger's own `buildStatement()` output, so a shared figure cannot disagree with the books; a 120-document cap folds the dropped rows' net into the opening balance instead of losing it
- Every open invoice carries a UPI deep link with its own due amount, the VPA baked at share time; a settled row or a missing VPA yields a note, never a dead pay chip
- `decodePortal()` answers with typed refusals (not a link / damaged / wrong version) rather than throwing

### 3.36 Recurring Invoices — a Schedule Accrues (R2-18)
- A schedule is a bill template + cadence + end rule, and **due dates are never stored**: the occurrence calendar is derived from the rule against today, so a missed March bill is still waiting in April
- Raising it dates the invoice on the day it belonged to — and because `createInvoice` reads the financial year off `invoice_date`, it lands in the return period it belonged to, with a warning if that period is already filed
- Month arithmetic is anchor-relative and clamped (Jan 31 → Feb 28 → Mar 31) and computed in UTC, so a timezone cannot move a bill into another year
- Catch-up runs go through the real write path (sequence number, stock movements, FEFO) and the offline queue; nothing bills itself while the app is closed, and the page says so

### 3.37 Foreign-Currency Deals (R2-19)
- `invoices` keeps its rupees; the currency, the booked rate and the remittances live in `taxflow:fx:<orgId>` and join **by invoice number** — the statutory record a return reads is never converted
- Rule 45 makes a rate a dated fact with a source stamp, so the storage is a rate ledger, and `rateFor()` returns null rather than inventing a number
- Three rupee numbers are kept apart and never averaged — the rate used, the rate the books imply, today's rate — and the disagreement between them is the finding
- Realised gain comes from remittances, unrealised exposure from the outstanding, and a currency with no recorded rate yields no revalued figure rather than a zero one; AED/SAR/KWD/QAR/OMR are reported missing, never guessed. Recording a remittance here does not receipt the invoice

### 3.38 Job Work and ITC-04 (R2-20)
- Goods sent for processing carry the section 143 clock — 12 months for inputs, 36 for capital goods, **none for moulds, dies, tools and templates**; a lot may stipulate a period but `periodMonths()` takes the **shorter** of stipulated and statutory
- Rule 45 deems a supply on the day the goods **went out**, so the exposure reaches backwards across periods and a late return is counted as well as reported; there is deliberately no "written off" state, because leaving units outstanding is that statement
- ITC-04 grids A/B/C/D and the HSN summary are drawn from the movements inside the chosen period, with outstanding as at period close — half-yearly above ₹5 crore, annual at or below
- The compliance calendar derives its ITC-04 rows from the register rather than a tick-box, and `indicative_tax` is labelled indicative wherever it renders

### 3.39 Cost Centres (R2-21)
- Which part of the business a bill or an invoice belongs to — depot, department, project, branch — answered in contribution, never in tax
- An allocation stores a **share**, not a rupee, and the money is re-read from the books on every load, so amending a bill re-splits itself
- Σ parts + the unassigned remainder = the document to the paisa; the remainder is computed by subtraction and printed, because a division that loses rupees is worse than none at all
- A centre is not a legal person: a branch in another state with no GSTIN of its own becomes a rule 41A question with a link to the GSTR-9 workpaper, worded from the registered home state, and a tag whose document was deleted survives as an orphan that says so

### 3.40 Tally Bridge (R2-22)
- `/tally` reads a Tally export **in the browser** and returns a plan before it writes anything: one row per ledger, stock item and voucher saying what it becomes here, the rupees it would write, its status (`ready / blocked / skipped / already`), and for anything it cannot do, the reason
- A file is evidence, not instruction — a figure that had to be computed is labelled as arithmetic, and where the file disagrees with itself the disagreement is reported and the file's own lines win, because the lines are what the shop billed
- Our numbering survives the trip: `invoice_number` comes from `invoice_sequences` and the Tally voucher travels in `notes`, while a bill keeps the vendor's own reference. An import never writes money (`/payments` is the only writer) and never reaches a return
- A document whose party or product cannot be resolved is **blocked rather than guessed** — no customer invented, no product created implicitly by a line
- The bridge runs backwards as well: chosen invoices and bills become the XML TallyPrime imports, with the tax ledgers a voucher names written beside it and the rupees counted and printed before the file downloads
- v1 read sales and purchase vouchers only; since R2-27 a **credit or debit note voucher becomes a note row against the document it reverses** — the original is never invented: it must sit on the register (matched by number, or by the `#<Tally ref>` an imported document carries in its notes) or be a ready invoice/bill planned from the same file, in which case the two are written in one pass. The note rides the same side its page writes — a credit note the customer side of an invoice, a debit note the vendor side of a bill — through `createCreditNote` / `createDebitNote`, so every route produces identical rows. A debit note the file charged cess on blocks (the note row has no cess column), quantities arrive positive because the reversal is what the note *is*, and the note is numbered by the app's own sequence — the Tally voucher number travels in `notes`
- Receipts, payments, journals and challans inside a file are still listed as skipped, because their write paths live on other pages

### 3.41 Projects & Time Tracking (R2-23)
- `/projects` keeps a job, the hours spent on it, and the whole invoices and bills that belong to it — attached **by id**, never retyped — in `taxflow:projects:<orgId>`
- **The register stores measurements, not money.** Revenue, spend, ITC, contribution and every unbilled month are re-read from the books on load, so amending or cancelling an invoice changes a project's figures by itself and nothing saved here can rot
- **Hours are priced, not costed.** An hour carries the rate you would bill it at, and contribution stays billed revenue less attached spend with the hour value beside that number rather than inside it — a margin that charged you your own billing rate would be double counting. Since R2-31 the app can compute what an hour *costs* (`costPerHour()` in `src/lib/payroll.ts`, printed on `/payroll`'s own Cost tab), but **this page has not taken the figure** — no import, no column: the hours logged on a job were not necessarily those people's, and a shop that wants them folded in says so when the attendance link exists
- **Marking hours billed is a reference stamp.** It records the invoice you raised at `/invoices/new` (the only path that allocates a number and moves stock); it neither creates that invoice nor receives the money, which still arrives only through `/payments`
- **The unbilled register is per project-month** and carries the invoice date rule 47 asks for — 30 days from the supply of a service, printed with its source and treated as *cited, not settled*. Internal work has no recipient, so no supply and no window to miss. A late row yields a date, a rule and a link to the GSTR-3B workpaper, never a tax figure
- Hours with no rate anywhere yield **no rupee figure rather than a ₹0 one**, a document deleted from the books leaves its tag as an orphan that says so and contributes nothing, and an invoice number the books do not have is accepted but reported as unmatched
- The cost-centre boundary is printed on both pages: **a centre splits one document by percentage; a project collects whole documents and adds the hours a centre cannot express**
- v1 has no timesheet approval, no expense claim, and no calendar sync; the scanned *paper* behind a document still needs Storage (gap #12), so a project attaches the document, not a file

### 3.42 Manufacturing — Recipes & Builds (R2-24)
- `/inventory/recipes` keeps **what a thing is made of** (a recipe: components, the quantity drawn per run, the waste a shop actually gets) and **what making it did to the stock** (a build: the units produced and what the drum actually said), in `taxflow:bom:<orgId>`
- **The headline answer is the one the incumbents do not give:** *what you cannot make today*. Every live recipe card states how many runs the shelf would cover and, when the answer is not enough, names the component that limits it — a bill of materials that only prints is half the feature
- **A recipe stores quantities and minutes, never a rupee.** Material value is rolled up on every load from `products.purchase_price` — the field `/accounting` already values stock at — so a price corrected on the master re-values every recipe that uses it, and nothing here can hold a stale amount. R2-28 adds the two time legs: a recipe carries `labour_minutes` and `overhead_minutes` per run, and what those minutes are *worth* comes from dated shop-rate rows, not from the recipe
- **A component with no cost yields no rupee figure, not a ₹0 one**, same rule as an unpriced hour at `/projects`: ₹0 reads as "this costs nothing", which is a different and wrong statement from "nobody has recorded what this costs". Margin against `selling_price` prints only when both sides are priced
- **A build records what was drawn, not what the recipe hoped**, and the difference is printed as a variance rather than smoothed away — that number is wastage, and wastage is what recipes lie about
- **Stock moves only through `record_stock_movement`**, components out and finished units in on the two adjustment types that already exist with the `JOB-<FY>-NNNN` reference in the note: no new movement type, no schema change (ADR-013). A run whose movements failed to land stays a *plan*, and whatever already applied is reversed rather than left half-written
- **A build is not a supply.** Making something inside your own registered place moves no GST; the tax happens when the finished good is sold at `/invoices/new`, at the HSN/SAC and rate of the *finished good*, not of its parts — so the page checks the output has an HSN/SAC and says so while there is still time to fix the master. Materials handed to somebody else are job work, and `/gst/job-work` is where that lives with its section 143 clock
- **Cost has three legs, and the legs have different clocks** (R2-28). Parts read at today's catalogue; labour and overhead read at the shop-rate row in force on *the run's own day* — a run recorded in September prices its minutes at September's wage even if October's row says the shop got a raise. The five-tab page's **Shop rates** tab keeps one row per start-day (a ₹/hour figure on either leg; a ₹0 rate is refused, because zero claims the work costs nothing while a blank only admits nobody recorded it), and every figure the page prints says which clock it read: the margin row is labelled *full cost* or *parts alone*, the build log column is *Cost today (full)*, and the stat card keeps the year's material figure apart from the year's labour and overhead — two bases never add
- **A missing rate prints a dash and the reason, never a parts-only total in full-cost clothing.** Minutes of zero are an honest zero (a grey note says the cost is parts alone); minutes above zero with no row in force kill the total and name the gap — *no shop rate in force on 2026-10-01*, or *no labour figure on the rate row in force (2026-04-01)* — on the recipe card, the run, the editor preview and the CSV's *Uncosted* column alike
- **A build draws from named lots** (R2-29). The editor offers FEFO per component — earliest expiry with stock left, inside the run's own godown if the run names one — and the shop is free to overrule the offer and pick a different lot, split one component across several, or name no lot at all. A draft that asks a lot for more than it holds is refused before the ledger is touched ("CH-2026-JUL: 5 NOS asked, 3 NOS in it"); a draft that names no lot is *allowed* with a warning, because a shop that keeps no lot register must still be able to record a run — the units then leave the shelf and the batch register honestly stays silent. Recording writes the device-side mirror beside the RPC: one `adjust` move per drawn lot carrying the job number in `doc_ref` ("Build JOB-… — Chocolate 1 issued from lot CH-2026-JUL"), and the finished units land as their own lot whose `batch_no` *is* the job number, with `bill_ref` carrying it too, so the lot trail reads as paper
- **The lot a build makes is a real lot, with its gaps printed.** It carries the stamped per-unit cost from the run when there is one; a run whose components or rates were missing lands a lot at *no cost recorded* with the reason in its note rather than a ₹0 that would value the shop's finished stock at nothing. A run that recorded no expiry date and no godown says so and stands unplaced (Main) until the shop edits it — the page does not invent an expiry for somebody else's good
- **Cancelling gives the units back to the lots they came from**, as one `adjust` move per lot ("Cancel JOB-… — Chocolate 1 went back to lot CH-2026-JUL"), and zeroes the finished lot — but only if that lot has given units to nothing else. A run whose finished lot has already been sold on **refuses to be cancelled**: *correct the sale or the lot at /inventory/batches; a run that has been sold on is history*. Both the run and its reversal stay on the log, and the drawn-and-returned pair sums to nothing
- **The shortage becomes paper** (R2-30). The materials board stops at *what is short* only when there is nobody to order it from. `mergedShortages()` folds every recipe plan into **one row per component** — the same fold the stat card reads, so the number on the board and the quantity on the order cannot be two different sums — and `shoppingPlan()` groups those rows under **the vendor each part last came in from** (`latestSupplier()`: newest bill line wins, ties to the row read last, unnamed vendors skipped — the rule the reorder planner already used), priced at that bill's own rate, or at `products.purchase_price` when no bill names one, each line labelled *last bill* / *product master* / *no price recorded* so the reader sees which basis the figure stands on. Three cases are **refused with their reason printed** rather than dropped: no bill ever named a supplier for the part, the supplier has since left the vendor master, and the vendor card carries no state — that last because the purchase-order register requires a place of supply and would reject the draft itself. **One unpriced line and the order has no value**: `—` on the card, "the draft carries 0 until you set it" in the note, and blank cells in the CSV, because a sum of just the priced lines would read as *the* value of an order with a hole in it. Raising goes through the register's own numbering — `raiseDrafts()` → `takeNumber()` — so a draft born here is `PO-<FY>-NNNN` by the same high-water mark as one typed at `/purchase-orders`, and `validateDoc` runs *before* the write so an order the register would refuse is skipped and named, not forced. Nothing is read until the shop asks (*Build the shopping list* fetches live vendors and non-cancelled bills, then items in 500-id batches narrowed to the short parts), and what comes out is a **draft**: this page never confirms an order, because that is a promise to a vendor
- Four tabs — **Recipe book** (cards: cost per unit, margin, "Can make now" and what limits it, variance history, findings), **Build log** (per-FY job numbers, planned → built → cancelled with the reversal kept on the log, a *Lots drawn* count that opens the panel to show which lot gave what, and the finished lot's own balance), **Materials board** (open sales orders demanded against recipes, shortages merged into one shopping list, a per-recipe plan that explodes sub-assemblies, and — since R2-30 — the vendor-grouped order drafts that shortage turns into), **Where used** (which recipes draw a component, what has been consumed against it, whether the shelf could still cover them) — plus **Shop rates** (R2-28), and six CSV exports
- v1 has no production scheduling, no work-in-progress account — the labour and overhead legs are priced *readings*, not postings, and no account is touched — no serial-number issuance into a build (a serial is one unit and a build is a quantity of them; the serial register stays the place that tracks which one went where), no scrap *sale*, **no back-flush**: nothing consumes materials automatically when an invoice is raised, because the build form, not the invoice, records what a run took — a finished unit may equally have come from opening stock or from a purchase, and an invoice is evidence of neither — and, since R2-30, **no automatic buying**: one vendor per part is derived from the last bill, the rate from that bill or the catalogue, every draft is seeded at the 18% slab, and there is no MOQ, lead time or price-list engine behind it, because a supply master that knows those things does not exist in this schema yet

### 3.43 Exports — LUT, Realisation & Refund Windows (R2-25)

- `/gst/exports` keeps, for every consignment that left India, the two things an invoice cannot hold: **the paper that made the supply zero-rated** and **the date the money had to arrive by**. Paperwork lives in `taxflow:exports:<orgId>`; every rupee is re-read on load from `invoices` and from the FX ledger
- **Two clocks, one page.** GST asks whether a letter of undertaking was in force on the day the invoice was raised; FEMA asks whether the proceeds landed inside the window that runs from the date of export. A file can be fully settled and still be non-compliant, and a file can be perfectly compliant while the money sits unpaid — so both clocks print on the same card rather than one being traded for the other
- **The route to zero-rating is recorded, never inferred**: `LUT` (section 16(1)(a) with Notification 44/2017, no tax paid), `IGST paid` (section 16(1)(b) with rule 96, refund against the shipping bill and the evidence of realisation), `SEZ` (rule 48) and `unknown` for a file nobody has claimed yet. Only the two that pay tax can be refunded, so the refund clock stays silent on a LUT export instead of inventing a claim
- **The realisation window is a band, and the band is dated**: nine months under the original master direction (FEMA.23(R)/(E)/2015-16/RB, regulation 9), fifteen — eighteen for a rupee-denominated contract — from 13-11-2025, back to nine from 05-06-2026, and fifteen again from 01-10-2026. Dispatch against an advance went from twelve months to thirty-six on 13-11-2025. Each file is measured against the band in force on *its* export date, and the instrument is printed beside the number
- **A source disagreement is kept, not smoothed.** The 13-11-2025 notification is dated that day and the readings split on whether it took effect the same day or the next, which moves a deadline by a whole band. The rule tab shows both readings for the affected files, `WindowInfo` carries `disputed` and `alternative_months`, and a per-file override is labelled *overridden on this file* — never quietly applied
- **The date of export is derived and says so**: the file's own date, else the shipping bill date, else the invoice date, with the source named on the card. A service export has no shipping bill at all, so `KIND_META` prints the different evidence rule 96 wants for it instead of leaving a blank port field
- **Realisation is read from `/fx`, not retyped.** Where the FX ledger holds a deal for that invoice number its receipts are the counted figure; a credit typed on this register then shows with its amount and the words *not counted*, so one remittance can never be two totals (reminder #14)
- **The refund clock is section 54(1)**: two years from the relevant date, turning amber inside the last ninety days. Nothing is charged for waiting on it — the window simply closes and the IGST stays where it is — which is why the row explains the loss instead of estimating a fee
- **The missing paper is the product.** Invoices the books mark as export or SEZ with no file on the register are named on the page (`unregisteredExports`), because a register that lists only what someone already remembered to enter is worth nothing. Each card then lists *paper this consignment has to produce* — the undertaking, the realisation evidence, the shipping bill — as gaps, not as notes
- **LUTs are per registration and per year**: valid 1 April to 31 March, filed in GST RFD-11, and `nextLutWindow` puts the renewal deadline on 31 March of the year before the cover starts, with its own countdown and its own row on the compliance calendar
- Four tabs — **register** (one card per consignment, six sorts, filters by attention), **undertakings** (the LUT table, renew, archive), **watch list** (every date a human has to act on), **the rule** (the dated bands with sources and disputes) — and five CSVs: export register, shipping bills, realisations, watch list and undertakings
- Wiring: sidebar, GST hub, a ⌘K action, an *Open on the export register* banner on export invoices, an *Export register* link in the FX footer, and a compliance calendar that calls `watchRows()` rather than keeping its own dates so the two screens cannot disagree (FEMA and refund rows carry a note instead of a ₹-per-day estimate, because a FEMA default is not priced by the GST late-fee rule)
- v1 fetches nothing from ICEGATE or the bank — a shipping bill and an e-BRC/FIRA are typed, not pulled; no condonation representation is drafted for a missed window; RFD-11 and RFD-1 are prepared as rows and CSV, never filed; and there is no multi-GSTIN workflow beyond a GSTIN field per undertaking, so a business exporting from several registrations manages them one at a time

### 3.44 The Books Vault — Backup & Restore (R2-26)

- `/vault` writes **every device-side register into one file the user owns** — `taxflow-vault-<org>-<date>.json` — because ADR-013's registers (batches, serials, godowns, LUTs, FX deals, job-work lots, cost centres, projects, recipes, exports, salaries, targets, splits, workpapers, the invoice template) live in one browser and nowhere else, and a cleared cache or a changed laptop loses them all. No cloud competitor offers the inverse: a portable file rather than an export inside someone's cloud
- **A backup walks a named list, never a sweep.** `REGISTERS` in `src/lib/vault.ts` is thirty-one `RegisterSpec`s — twenty-six restorable, five evidence-only — and sweeping localStorage instead would catch the Supabase auth keys (`sb-*`) beside the books. Credentials are never in the file; that is the reason the walk exists
- **Restore goes through the owner and proves it.** Each register is written back through its own save path (never a direct `setItem`, which would bypass every parser and version check), then read back through its own loader, and the plan prints `from → seen` per register — rows a parser dropped are counted, not lost
- **The plan comes before the write.** Nine states per register — new, replace, blank, same, foreign, damaged, absent, evidence, unknown — with `blank` selectable but never pre-ticked, because two empty registers and a wiped one look identical from outside and that is the user's call; the page demands explicit confirmation whenever the restore would replace or clear anything
- **Damage is named, not guessed.** Every block carries its own FNV-1a checksum, so a truncated or hand-edited block is refused by name even when it still parses; an unreadable file yields one of five fault sentences, and an unreadable block is kept as text with a note rather than discarded
- **Evidence is shown, never written.** The offline outbox, e-way bills, the Tally import log, palette recents and the compliance profile ride in the file for reference; putting a pending invoice back into the outbox would replay a sync and bill the same sale twice
- Restore is **not a transaction** — registers apply one by one and the run stops nowhere — which is why the plan is the page's main product and why the vault's own log (`taxflow:vault:<orgId>`) records refused runs too. That log is deliberately not in the vault itself: a backup that recorded its backups would grow every time it was restored
- Four tabs — **backup** (what would travel, days since the last one, the download), **restore** (drop/paste, the fault card, the plan table, the risk confirmation, the result flash), **registers** (the thirty-one specs as a reference), **not in this file** (the server-held documents, payments and evidence, and credentials) — plus a Settings card and a cross-note on `/offline`
- v1 keeps no server copy: the file is the backup, and a scheduled cloud copy would need a server route the schema rule forbids; future-version files are refused with the version named, never partially read

### 3.45 Payroll — the Salary Register (R2-31)

- `/payroll` keeps **what a person is paid** and **what a month took**, in `taxflow:payroll:<orgId>` (ADR-013 — no employee table, no salary table, and a salary is the most private record a business keeps). Six monthly components per person (basic, dearness, HRA, conveyance, medical, special) each carrying its PF-carrying and ESI-carrying flag, plus an age band, a state, joining and leaving dates, hours a day and a professional-tax figure; four numbers per month (lost days, arrears, bonus, recovery). **Every other rupee on the page is computed on load** — gross, employer cost, net pay, tax, dues — so correcting a component re-prices the whole year rather than leaving a stale row behind
- **Section 192 is a method, not a percentage.** `taxWalk()` runs April forward: elapsed months add their actual wages, later months are projected at the current month's rate, the estimate sheds the standard deduction (₹75,000, capped at the estimate) and the *year's* professional tax under section 16(iii), `taxBreakdown()` computes the year's tax on the residue (bands, the 87A rebate of up to ₹60,000 to ₹12,00,000 with its marginal relief, surcharge from ₹50 lakh measured at the foot of the band, 4% cess), and the balance divides over the on-roll months still to come. A June bonus therefore lifts July onward, and the March row absorbs whatever the estimate under-collected — twelve instalments that add up to the year's tax is a property of the walk, not of the data
- **The rates know their own dates.** `PF_WAGE_CEILINGS` moves ₹15,000 → ₹25,000 from **17-09-2026** (S.O. 5109(E)) and a run picks the ceiling in force on *its own* salary month — the month CSV carries *PF ceiling used* as a column so a CA can see which figure this is. The employer's 12% splits 8.33% to EPS and 3.67% to EPF, with EDLI and administrative charges at 0.5% each. `ESI_BANDS` stayed at ₹21,000 (₹25,000 for a person with disability) at 0.75% employee and 3.25% employer, so the two statutes disagree on the same slip and the page prints that as a finding rather than harmonising it away
- **Four refusals, each with its own sentence.** A financial year the tax tables do not hold returns no tax figure; an employee aged 60 or above is refused a figure rather than given the general schedule (the senior bands were in none of the sources fetched); a lost-day count above the month's own length is refused instead of clipped, because clipping produces a negative salary; and a person with months recorded is **not deletable** — they leave the rolls by date, since deleting them would leave their PF and challan computed against a structure that no longer exists
- **Absence is a dash, zero is a claim.** `pt: number | null` — unset prints *not recorded*, a real `0` prints zero. Professional tax is a state subject and the fetched state tables contradict one another, so there is **no national PT table**: the dues card prints *Due on the state's own date*, section 16(iii)'s ₹2,500 annual cap is the one national number that applies, and the calendar files that row in a *State dates* rail rather than inventing a 21st of the month
- **The dues are read, not typed.** `statutoryDues()` names the heads a month owes — PF by ECR, ESI to the ESIC, tax on salary under challan 281 with a link to `/tds` — against deposit dates the 15th (PF/ESI) and the 7th (salary TDS, March until 30 April), with Form 16 by 15 June; `missingHeads()` says which heads are absent and why. Nothing here pays anything: the money leaves at `/expenses`, the challans are paid on the EPFO, ESIC and income-tax portals
- **The compliance calendar reads these books.** `payrollEvents()` emits an ECR / ESIC / salary-TDS row for each month actually run, one ESI return per contribution period touched and one Form 16 row for the year, and `/gst/calendar` **drops its own monthly PF/PT guess** for any month the register files — matching on the row id, stepping back a month because a guessed row names the deposit month and the register names the salary month
- **An hour finally has a cost.** `costPerHour()` divides a month's *employer* cost by that person's paid days and their own *hours a day* (a per-employee field, default 8, which the card says is only used for this division); `blendedHourCost()` weights the month instead of averaging averages. The figure is printed on this register's own **Cost** tab, per person and blended. `/projects` has **not** taken it — no import, no column, and contribution stays billed revenue less attached spend, because the hours logged on a job were not necessarily these people's. ADR-030's *priced, not costed* sentence therefore still holds until a shop links attendance to a job
- **Unsettled questions stay questions.** Whether the *pensionable* salary for EPS moved with the September ceiling is settled by no document fetched, so `settings.eps_pension_ceiling` is the owner's call (₹15,000 by default) and every slip prints the figure it used; the four labour codes' 50% wage floor (in force 21-11-2025) is a flag with its citation, not an add-back to the PF base
- Five tabs — **People** (the structure, on the rolls, off the rolls), **Month** (one run, one slip per person, the year-walk unfolded per row, 27-column CSV), **Dues** (what the month owes, the absent heads, 7-column CSV), **Annual** (the sheet shaped like Form 16 Part B and labelled as not one, its own 19-column CSV), **Cost** (the rupee an hour costs, per person and blended) — three CSVs, four ⌘K actions, and the register is `/vault`'s thirty-first spec
- v1 computes the **default regime only** (section 115BAC: HRA not exempt, investments no shelter), and says so; no NPS, LTA, perquisite valuation or 80CCD(2), no overtime, no gratuity or leave-encashment provision, no attendance import, no per-day or contract labour, no accrual or work-in-progress posting, no Form 16 Part A (it comes out of TRACES), no challan numbers — which is why `/tds` cannot see salary TDS and the dues card links there instead of claiming the statement is complete

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
- Bank feeds / account aggregation — statement *import* shipped in R2-10 (`/bank` reads any pasted or uploaded layout), but there is still no live connection to a bank
- Payroll *as a payment system* — `/payroll` (R2-31) computes the salary register in the browser and files nothing: no money moves, no challan is numbered, no payslip is delivered, Form 16 Part A stays inside TRACES, and the old regime is not computed. The rupees still leave at `/expenses`
- Putting a costed hour inside a project's contribution — `/projects` (R2-23) prices labour at the rate you would bill it, and since R2-31 the salary register can compute what the hour actually cost (`costPerHour()`, printed on `/payroll`'s Cost tab and taken by no other page). The two are kept apart on purpose: the hours logged on a job were not necessarily the registered employees', and folding a reading into a margin would be a costing claim this app cannot prove
- TDS / TCS return filing — `/tds` builds the withholding workpaper and deposit calendar, but no Form 26Q or 24Q is filed, and TCS under 206C is not covered
- Revaluing a statutory invoice in a foreign currency — `/fx` (R2-19) keeps a dated rate ledger *beside* the rupee books; the invoice a return reads stays in rupees
- The customs and bank side of an export — `/gst/exports` (R2-25) tracks the shipping bill, the e-BRC/FIRA and the realisation window as typed evidence; nothing is fetched from ICEGATE or an AD bank, and no condonation representation is drafted for a window that has closed
- Authenticated customer logins — the portal (R2-16) is a share link that carries its own statement, not an account per party (Phase 14)
- Native mobile app (the web app is an installable PWA)
- Server-side LLM features — by design, so a business's bills never leave the device
- A server-held copy of the vault backup — `/vault` (R2-26) produces a file the user keeps somewhere the browser is not; scheduling a cloud upload would need a server route the schema rule forbids
- New database tables or migrations; feature work rides on the existing schema plus per-organisation local storage
