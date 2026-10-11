# TaxFlow India — Product Requirements Document (PRD)

**Version:** 2.0  
**Date:** October 2026  
**Status:** MVP + Version 1 complete — Version 2 shipping in feature rounds (Round 1 closed, Round 2 closed at R2-37, Round 3 through R3-5)  

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

Round 2, R2-1 … R2-37:
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
- Every page migrated onto the kit — 55 pages on the shared primitives, the three auth surfaces on one `AuthShell`, the public portal page counted the same way
- Order flow: delivery challans under rule 55, sales orders, purchase orders, and conversion into a real invoice or bill (`/challans`, `/sales-orders`, `/purchase-orders`)
- Batch/expiry register with FEFO drawdown, serial-number register (one row per physical unit), godown register with transfers as lot splits (`/inventory/batches`, `/inventory/serials`, `/inventory/godowns`)
- Customer portal: a statement of account that travels inside its own share link, read from the URL fragment with nothing stored server-side (`/portal`)
- GSTR-4 / CMP-08 composition workpaper (`/gst/gstr4`)
- Recurring invoices as a schedule that accrues, with catch-up back into the FY it belonged to (`/recurring`)
- Foreign-currency deals over a dated, source-stamped rate ledger (`/fx`)
- Job work / rule 45 outbound with the section 143 return clock and the ITC-04 workpaper (`/gst/job-work`)
- Cost centres: an allocation stores a share, the rupees re-read from the documents (`/cost-centres`)
- Tally bridge: import a Tally export into a plan with reasons, and export vouchers back (`/tally`)
- Projects & time: hours measured, whole documents attached by id, labour priced at the billable rate and — since R2-36 — costed wherever a row names its payroll person, and — since R2-37 — a timesheet that can *draw* hours from the kept day book (present days proposed at the register's own hours a day, half for a half mark, every other mark refused with the register's own sentence, only the tick writes), rule 47 window cited (`/projects`)
- Manufacturing: recipes and builds, the answer to *what the shelf cannot run today*, the vendor-grouped purchase-order drafts that shortage turns into (R2-30), and — since R2-35 — a draw that can name the actual numbered units it took from the serial register (`/inventory/recipes`)
- Exports: the undertaking clock and the FEMA realisation window on every consignment, with the refund limitation beside them (`/gst/exports`)
- The books vault: every device-side register — batches, serials, godowns, LUTs, workpapers, settings — backed up into one portable file and restored through the pages that own the data, each proved by reading back through its own loader (`/vault`)
- Payroll: the salary register — six components per person, the month run, section 192 walked over the year, the dues a month owes, the shop's attendance sheet read for one figure, and the rupee an hour costs (`/payroll`)
- Payslip: that register as A4 paper — one person's month or the whole month, every rupee laid out from the engine's own reading, dashes where a letterhead code was never typed (`/payroll/payslip`)
- Day book: the month ruled with dates beside the register — one attendance mark per person per day, tapped or pasted and **kept**, holding no money until the shop pulls it into the month through the month form's own validation (`/payroll`, *Day book* tab)

Round 3, R3-1 … R3-5 — the PDF review's buildable backlog, in the order the review sets:
- Audit trail & period lock — an **append-only** `seq`-numbered log `verifyChain()` walks by number so a hand-edit shows as a gap, a duplicate or a reorder, a GST month or whole financial year **sealed only after it has ended** (a period still running is refused as history-in-the-making), a release **stamped** with `released_at` and a required reason rather than deleted, and a `sealGuard()` door the invoice write path asks before saving — when the answer is yes the save is refused with the register's own sentence and the *attempt* lands on the trail as a `refused` event. It holds **no rupee** — a seal is a window and an event is a sentence, and the money stays in the documents the seal governs. Joined the vault in the same round it was created. Its coverage is printed as a counted list, never as prose: R3-1 shipped **one** door (`/invoices/new`) and said so; **R3-5 moved the door onto the writers**, so `/audit` now lists 21 paths, tags each with the hand that asks the seal, and names the two it leaves open (§3.52)
- Business setup — branches & document series: a **branch is a registration**, each with its own 15-character GSTIN whose leading state digits must agree with the branch's state code (a Tamil GSTIN cannot carry a Karnataka branch — the CGST/SGST split reads that pair), and one branch is the head the header signs with by default until the head is deliberately handed over. The **five document series are configurable** — prefix, digit width, and whether the financial year sits inside the number — for tax invoices, quotations, delivery challans, sales orders and purchase orders (R3-2b adds a sixth, `journal`, §3.50, so `SERIES_KINDS` is now six and `/business` offers six); the register only **dresses** a number, the **counter stays** where it was (Supabase `invoice_sequences` per org/FY, each order kind's own high-water mark), so a mid-year shape change re-issues nothing and every kind's high-water walk reads all the shapes it has worn. A document issued away from the head carries a `[branch CODE]` stamp that lives in the notes the schema already has (no new column), read back on the print page with a named fallback when the register can no longer answer. Opening balances grew the gated lines (bank, receivables, payables, `as_of`) so the balance sheet stands on a stated day and the honest limit — a later payment grows cash but cannot reduce an opening receivable — is printed beside it. **`/business` holds no rupee.** Joined the vault in the same round it was created. v1 boundary: the invoice-issue and its read-back are engine-tested; credit/debit notes and purchase bills stay numbered by hand because the portal and the supplier issue those (`/business`)
- Manual journal — `/journal` + `src/lib/journal.ts`: the one place a rupee that is real and has no paper behind it gets a name (depreciation, a loan that arrived, money the owner took out of the till, a demand a notice raised). A **head** declares which of the fifteen statement lines it moves — that declaration is the only place the debit/credit convention lives, so a fold cannot get an income leg backwards — an **entry** is two or more legs that must balance **to the paisa** (every sum runs in paise, so a float tail cannot decide whether an entry posts), and a posted entry is **reversed by a mirror, never edited or deleted**. It renumbers with `/business`'s sixth series, folds into `ledger.ts` beside the documents, provably cannot move the derived capital plug, and asks R3-1's seal before its legs are even read. No chart of accounts, no return reads it, nothing settles (§3.50)
- Filings register — `/gst/filings` + `src/lib/filings.ts`: the **filing-status history and amendment tracking** the review's GST half asked for. One row per `(form, period)` transcribes what the return *stated*, the due day **beside the rule that dated it** (snapshotted from the calendar, then re-derived and any disagreement printed as drift), the fee and interest recorded as paid; a late fee is the **slab that applies** (Notifications 19/20/21/2021 and 07/2023, ceiling by the preceding year's turnover) printed with the citation that decided it; an amendment is dated against the window that still allows it — proviso to rule 59(1), Table 9A, section 16(4) — so a correction nobody can file prints as **lapsed**; the rule 59(6)(a)/(b)/(d) bars are printed with a link to the row that has to go in first; and a third tab compares stated against books within ₹1. It files nothing, posts nothing, and **reads** the seal rather than guarding a door (§3.51)
- The seal on every writer — R3-5 moves R3-1's door off the pages and into the code that writes: `createInvoice`, `createPurchaseBill` and `createNote` ask `requireOpenSeal()` as their first statement, **before a sequence number is spent**, so the counter sale, the recurring catch-up, the offline replay, both order registers, a challan becoming an invoice, the Tally import and the scanner all inherit the refusal, and `/audit` prints which 21 paths consult the seal and which hand asks it (§3.52)

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
- Payroll *as a payment system* — payslips issued to employees (the sheet itself exists since R2-33 and is downloaded, never sent), salary actually paid, the old-regime opt-out computed and Form 16 Part A pulled from TRACES. `/payroll` (R2-31) computes the register and `/payroll/payslip` (R2-33) prints it; the money still leaves at `/expenses`
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
- **A build draw is one of those events** (R2-35): a unit a run took goes `issued` — *In a build*, with the job number as its paper — and the register grows a fifth stat card, an *In a build* view, an `In build JOB-…` where-line (*cancelling the run puts it back*) and a hand-take action whose confirm says the tidy way back is cancelling the run at `/inventory/recipes`. A unit that moved on since (already restocked by hand, sold, written off) refuses that run's cancel by name
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
- **Hours are priced by their rate, and costed when they name whose hours they were.** An hour always carries the rate you would bill it at, and contribution stays billed revenue less attached spend with the hour value beside that number rather than inside it — a margin that charged you your own billing rate would be double counting. Since R2-36 an entry may also carry an `employee_id` — a person picked from the payroll register — and `costHours()` joins it to that person's own employer-cost figure for the entry's own month: the page reads `/payroll`'s `costPerHourFor` and hands the rows across as data (`HourCostRow` is a structural subset of payroll's `HourCost`, and this library imports no payroll code). The job then prints *after named hours* (`contribution − labour_cost`) as a **reading beside** contribution — marked *partial* while linked or typed-only hours remain unpriced, and never folded into the register's own number, because where the same wages are also attached here as a bill the two readings overlap: read them together, do not add them. A linked person the register cannot price for that month is printed with the register's own reason — a refusal, not a zero. The link is additive under `PROJECTS_VERSION = 1`; a typed name is not a wage link
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
- **A draw can also name the numbered units it took** (R2-35). Where a lot answers *how many*, the serial register answers *which ones*, so a serialled component's line in the editor offers its actual shelf units: the oldest first, up to the drawn quantity, as a chip strip under *Which units*. The proposal is `allocateSerials()`'s own reading, the shop overrules it chip by chip — or names none — and every draft is re-validated live against the same `validateSerialIssues()` the write runs: a pick that is not on the register, one named twice, one belonging to another product, one no longer on the shelf, or a pick set that does not cover the drawn quantity **to the unit** turns the modal's hot note red and holds the save before anything is written. A fractional draw cannot name units and a draw the shelf cannot cover names none — both printed as soft notes, because an unnamed draw still moves the shelf exactly as any draw does. Recording writes the register its own events (*Build JOB-… — Chocolate TCB-001 issued into the run*) through the serial library's append path, the run log gains an *N units issued* trace beside *lots drawn*, the run detail prints `issued TCB-001, TCB-002` under the line, and the runs CSV gains a *Units drawn* column. Cancelling writes the reverse events (*Cancel JOB-… — … went back on the shelf*) — unless a unit has moved on since: then the cancel refuses and names the unit, because putting it back would write over history the shop has already made. The serials page meets it with the fifth *In a build* card, view and history line (§3.34)
- v1 has no production scheduling, no work-in-progress account — the labour and overhead legs are priced *readings*, not postings, and no account is touched — no serial numbering *of the finished units on this page* — since R2-35 a draw names the numbered units it took from the register, but the units a run *makes* are still numbered at the counter on `/inventory/serials`, because a build knows a quantity and the register knows an identity, no scrap *sale*, **no back-flush**: nothing consumes materials automatically when an invoice is raised, because the build form, not the invoice, records what a run took — a finished unit may equally have come from opening stock or from a purchase, and an invoice is evidence of neither — and, since R2-30, **no automatic buying**: one vendor per part is derived from the last bill, the rate from that bill or the catalogue, every draft is seeded at the 18% slab, and there is no MOQ, lead time or price-list engine behind it, because a supply master that knows those things does not exist in this schema yet

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
- **A backup walks a named list, never a sweep.** `REGISTERS` in `src/lib/vault.ts` is thirty-five `RegisterSpec`s — thirty restorable, five evidence-only — and sweeping localStorage instead would catch the Supabase auth keys (`sb-*`) beside the books. Credentials are never in the file; that is the reason the walk exists
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
- **The attendance sheet is pasted, read, and — since R2-34 — its days can be kept** (R2-32; the kept page is §3.47). The Month run takes the supervisor's own table — CSV, tab-separated paste, pipe or semicolon, with a bank-style preamble above the header — and reads **one figure out of it: lost days**. A column headed *Present* is subtracted from the month's basis; the basis is the calendar's own days, or 26 when the register is set to the convention, or the number the row states beside the count (`24/26` outranks the setting). A column headed *LOP / Loss / Absent / Short* is taken as it stands, and a row carrying **both** is read only when the two agree. A **day grid** — three or more date-headed columns — counts `A`, `LOP`, `UL` and a numeric half-day as loss, `P` as worked, and `H`, `PL`, `SL`, `W` as neither, refusing a mark outside that table rather than calling it an absence. Identity goes **code, then exact name, then one unique piece of a name**, the last labelled `approximate` on the preview and an ambiguous one refused. Nothing is guessed at sheet level either: a column that gives a number without saying which way it points, a day column the month does not have, a sheet with no identity column, and a month this screen cannot name each **block the whole write**. A person on the rolls the sheet never names becomes a **finding**, never a zeroing — silence is not attendance. What Apply changes is `lop_days` and one stamped sentence in that row's note (`[attendance 2026-10] 27 days present of 31 → 4 days lost`), replaced rather than stacked on the next run, with arrears, bonus, recovery and every other month untouched; it goes through `mutate`, re-runs `validateInput` inside the door, and **stores no sheet: no new key, no new register, no version bump** — the pasted text itself is still discarded, while the days a shop wants kept are kept as marks in the register's own day book (§3.47), in the same envelope. `attendanceTemplate()` prints the month's roster ruled with the register's own codes so a paper fill-in comes back matched by code, and the readers are `detectDelimiter`/`splitRow` borrowed from `src/lib/bank-statement.ts` rather than a third CSV splitter. 212 assertions in `/tmp/attendance-test.mjs`
- **The dues are read, not typed.** `statutoryDues()` names the heads a month owes — PF by ECR, ESI to the ESIC, tax on salary under challan 281 with a link to `/tds` — against deposit dates the 15th (PF/ESI) and the 7th (salary TDS, March until 30 April), with Form 16 by 15 June; `missingHeads()` says which heads are absent and why. Nothing here pays anything: the money leaves at `/expenses`, the challans are paid on the EPFO, ESIC and income-tax portals
- **The compliance calendar reads these books.** `payrollEvents()` emits an ECR / ESIC / salary-TDS row for each month actually run, one ESI return per contribution period touched and one Form 16 row for the year, and `/gst/calendar` **drops its own monthly PF/PT guess** for any month the register files — matching on the row id, stepping back a month because a guessed row names the deposit month and the register names the salary month
- **An hour finally has a cost — and since R2-36 a job can read it.** `costPerHour()` divides a month's *employer* cost by that person's paid days and their own *hours a day* (a per-employee field, default 8, which the card says is only used for this division); `blendedHourCost()` weights the month instead of averaging averages. The figure is printed on this register's own **Cost** tab, per person and blended, and `/projects` now reads it too — the page calls `costPerHourFor` per (person, entry-month) and hands the rows across as data (`HourCostRow` is a structural subset of this register's `HourCost`; the projects library imports no payroll code), so a timesheet entry that names its person is costed at that person's own employer cost for the entry's own month and the job prints *after named hours* beside contribution, marked *partial* and never folded in. And since R2-37 a job can also *draw* its hours from the kept day book: `/projects` reads a person-month's marks through this register's own reader and proposes a row for each present day at this register's own `hours_per_day` — half a mark proposes half, every other mark is refused with this register's own sentence — and only the shop's tick writes, through the projects page's own `validateEntry`; the drawn row carries the employee id, so it is costed the moment it lands. What remains is narrower still: an entry that names nobody — or only a typed name — stays priced only
- **Unsettled questions stay questions.** Whether the *pensionable* salary for EPS moved with the September ceiling is settled by no document fetched, so `settings.eps_pension_ceiling` is the owner's call (₹15,000 by default) and every slip prints the figure it used; the four labour codes' 50% wage floor (in force 21-11-2025) is a flag with its citation, not an add-back to the PF base
- Six tabs — **People** (the structure, on the rolls, off the rolls), **Month** (one run, one slip per person, the shop's sheet pasted beside it, the year-walk unfolded per row, 27-column CSV), **Day book** (the month ruled with dates — one attendance mark per person per day, tapped, pasted or erased, kept as evidence and pulled into the month by one deliberate click, §3.47), **Dues** (what the month owes, the absent heads, 7-column CSV), **Annual** (the sheet shaped like Form 16 Part B and labelled as not one, its own 19-column CSV), **Cost** (the rupee an hour costs, per person and blended) — five CSVs (the month, the dues, the annual sheet, the paper attendance template and the day book), five register ⌘K actions, and the register is `/vault`'s thirty-first spec. The Month tab and every open slip link out to `/payroll/payslip`, where the same figures become paper (§3.46)
- v1 computes the **default regime only** (section 115BAC: HRA not exempt, investments no shelter), and says so; no NPS, LTA, perquisite valuation or 80CCD(2), no overtime, no gratuity or leave-encashment provision, **no device feed and no per-day wage ledger** — the day book keeps one attendance mark per person per day, tapped or pasted, but that is evidence and not a payroll: no biometric or device integration, no shift timings or overtime priced off the marks, no per-day-wage or contract labour, no accrual or work-in-progress posting, no Form 16 Part A (it comes out of TRACES), no challan numbers — which is why `/tds` cannot see salary TDS and the dues card links there instead of claiming the statement is complete

### 3.46 Payslip — the Month as Paper (R2-33)

- `/payroll/payslip` + `src/lib/payslip.ts` (463 lines) is the salary register's **document**: one person's month, or the whole month, laid out as an A4 slip. Recorded as an amendment to **ADR-034**. **Every rupee on it is the engine's** — `buildPayslip(store, slip, …)` receives the `Payslip` that `payslipOf()` already computed and lays its lines out; it re-derives, re-prices and re-adds nothing, so a slip cannot disagree with the screen it came from. The block totals are printed as totals *of* the engine's figures (`earnings_total` = the monthly structure plus arrears and bonus, `deduction_total` = loss of pay plus the statutory legs, `statutory_total` kept separate because loss of pay is already taken off inside gross)
- **A slip is a statement, not a payment.** The line says *Net payable*, the amount is repeated in words (`amountInWords()` from the invoice's own `words.ts`), and four standing sentences print on every sheet whatever the month says (`PAYSLIP_BOUNDARIES`): payable is not paid, the statutory columns are computed rather than recorded, this is not Form 16, and nothing here is filed. A slip that said "paid" would be a claim this register cannot support — `/expenses` and `/payments` remain the only writers of money
- **Absence prints a dash, zero prints a claim** — the register's rule carried onto paper. `SlipLine.amount` is `number | null` with a `dash` sentence: an unrecorded professional tax is a dashed line with the reason beside it, a typed `0` prints zero and claims it. Loss of pay sits in the **deduction** block naming its divisor (`Loss of pay (4 days of 31)`), with the basis sentence the month was divided on, and R2-32's stamped `[attendance <month>]` sentence surfaces as *from the shop's sheet* rather than as a second figure
- **The letterhead is asked for, never invented.** Fifteen fields (`LETTERHEAD_FIELDS`), four of them statutory identifiers (`LETTERHEAD_IDENTIFIERS` — PF establishment code, ESIC code, employer's PAN, GSTIN): a blank one prints a dash with the sentence naming what it is needed *for*, and the gaps are listed beside the sheet. An employer name never typed falls back to the workspace name and says which it used (`name_from`). It lives **inside** `taxflow:payroll:<orgId>` because it is part of the salary register, so there is **no new key, no thirty-second vault spec and `PAYROLL_VERSION` stays 1**; `saveLetterhead()` is the page's only writer
- **A month the register cannot compute produces no figures at all.** `printable: false` carries the engine's own `why_not`: the earning and deduction blocks are not laid out, the header states the refusal instead of a ₹0.00 net, and Print/PDF stay disabled with the reason as their tooltip — there is nothing to sign
- **The exceptions stay on this side of the paper.** The register's flags, the letterhead gaps and a missing UAN / ESIC number / PAN print in a `.no-print` strip beside the sheet; the employee's copy carries its own facts and nothing else
- **Two modes, one document.** *One slip* (person and month, deep-linkable as `?e=&m=`) and *The whole month* (`monthPack()`: the computable slips in the register's own order — biggest employer cost first — with **every refused person kept beside the pack and its reason**, `partial` set when the set is not the whole month, and an off-roster person getting the same sentence the engine puts on a dash slip, plus a note when the month row typed for them is being left out of every total). A printed pack is therefore never silently mistaken for a complete one
- **Print and PDF are the same sheet.** `#payslip-capture` is padded so its own padding becomes the A4 margin (`@page { size: A4 portrait; margin: 15mm }`, everything else `.no-print`); one slip goes through `downloadElementAsPdf()`, and the month through the new `downloadElementsAsPdf()` — one PDF, a page per person, a missing region skipped rather than failing the pack. Names come out as `Payslip-<month>-<code>-<name>.pdf`, with the doubled hyphens a payroll number like `A/8` would otherwise produce stripped
- Wiring: **Payslip** in the sidebar under *Payroll & Salary* using the existing `printer` glyph (the registry stays at **69**), three ⌘K actions — one slip, the month's pack, and the letterhead through `?letterhead=1` — and cross-links from the Month run (*Payslips of the month*) and each open slip (*Payslip*). **394 assertions in `/tmp/payslip-test.mjs`** cover the tie between slip and register, the dash-versus-zero lines, the four refusals, the pack's kept refusals and totals, the file-name slug and the letterhead's fallbacks
- v1 signs nothing: no digital signature or stamp image, no email or portal delivery (the owner downloads the file), no employee acknowledgement flow, no gross-to-net audit trail beyond the basis lines the slip already prints, and no Form 16 — the boundary sentences are text on the sheet, not a workflow

### 3.47 Payroll — the Day Book (R2-34)

- The *Day book* tab on `/payroll` + `src/lib/attendance.ts` (557 lines) keep **the month ruled with dates**: every person on the rolls as a row, every day of the month as a cell, each cell the attendance mark the shop wrote or a blank it did not — held inside `taxflow:payroll:<orgId>` as the envelope's `attendance` marks, an amendment to **ADR-034**. The doctrine every count on the page rests on is printed on the page: **unwritten days are not absent days** — the book counts only what the shop wrote. A mark is **evidence that carries no rupee**: `DayMark` holds a person, a date, the mark, where it came from (`hand` or `sheet`) and a short note, while the month row's `lop_days` stays the only attendance figure a salary reads — the pull below is the one click on this tab that can move money
- **A tap is the write.** The grid cycles eight states (`DAY_MARK_CYCLE`: unwritten, P, A, H, W, PL, SL, 0.5), but the cycle is a convenience, not the cage: any mark the register's own lookup can read is kept as itself, so `LL` or `NLW` lands the way the shop spelled it. `markDay()` is the single door, and it refuses rather than guesses — a date outside a month the book can rule, a day that has not happened yet (*the book keeps days that were worked, not days that are planned*), a stranger, a day before joining or after leaving, an inactive person, a mark the register cannot read — each prints its own sentence beside the cell and leaves the store untouched. An empty mark is a **clear**, legal on any day inside or outside the rolls, because a mistake should be erasable
- **A pasted page can land as days — if it is ruled with dates.** `marksFromPlan()` bridges the month run's own `planAttendance()` reading: a day-grid sheet becomes marks per person-day, while a summary sheet with a Present or LOP column *counts days instead of naming them* and is politely returned to the month run. The refusals travel across by their machine-readable `kind`, never by their wording: a line the reader could not **place** — a stranger, a shared code, an unreadable mark — stops the whole page, because a book with a silent gap in it looks complete; a row that simply carries no marks (`blank`) is the sheet agreeing with the book's own doctrine, so it is noted and skipped, and the person is left exactly as they stand. The preview precedes the write (*Write N day(s) to the book*), the write re-checks, and a refused page writes nothing
- **The pull is the only click that can move money.** `pullMonthFromBook()` counts each person's lost days the way the grid shows them (only days on the rolls; a half-day counts half), pushes every candidate row through the **same `validateInput()` the month form runs** — the book cannot smuggle past the month's length, the joining window or the future-month rule — and stamps the register's own `[attendance <month>]` provenance, replaced rather than stacked. A person the book never wrote is **left untouched rather than zeroed**; a row already agreeing with the month is counted `unchanged`; a blocked row is refused by name. An empty book refuses to pull at all: *an empty book is not a month of absents — nothing is pulled, and nothing is deducted*
- **Nothing is dropped in silence.** A mark for a day the person was not on the rolls is kept, named in the findings and counted nowhere; a loss mark sitting on the shop's own weekly-off day is a finding (*the count reads what was written*); a book count that disagrees with the month row's `lop_days` is a finding pointing at the pull; a person with no day written is named as left exactly as they stand. The weekly off — the additive `settings.weekly_off` the register now holds — shades those columns and counts what is still blank on them, never turning an unwritten day into a lost day, and a shop that never recorded one gets a sentence and a link instead of a guess. Four stat cards ride above the grid: people on the page, days written of the days the book could hold, lost days counted, and days still unwritten — *counted nowhere, deducted from nobody*
- **The page leaves paper, and the eraser is honest.** *Rule a blank page for this month* fills the paste box with the roster ruled one column per date (`attendanceTemplate()`'s grid branch) — printed, marked, pasted back a year later; **Day-book CSV** downloads the ruled page itself (`dayBookCsv()`: `Code, Name, "1 Tue"…`, the findings line, and the closing doctrine sentence). Erasing is per person-month (`clearMonthMarks()`), and it touches no month row — the button's own tooltip says so
- Wiring: the register's sixth tab, one ⌘K action (`action:payroll-daybook`), the settings card gains the `weekly_off` select (additive fields ship under the unchanged `PAYROLL_VERSION = 1`), and the vault's payroll spec counts marks in its `detail`, `count` and `verify` — **no new key, no thirty-second vault spec, no version bump**. The day tracks run `minmax(20px, 28px)`: a 1440px laptop rules the whole month without dragging (measured 1130/1130 with no document overflow) and a phone keeps its day cells tappable by letting the ruled page scroll inside its own frame. **247 assertions in `/tmp/daybook-test.mjs`** cover the tap cycle and its refusals, the erase, the five `kind`s a pasted line can be dropped for, the blank-row skip, the pull's untouched-not-zeroed rule, the findings and the CSVs
- Known boundary: it is a **book, not a clock** — no device or biometric feed, no shift timings, no overtime priced from the marks, no per-day wage ledger, and nothing filed anywhere; the pull changes only `lop_days` and the provenance note, through the month form's own validation

### 3.48 Audit Trail & Period Lock (R3-1)

- `/audit` + `src/lib/audit.ts` (611 lines when R3-1 shipped it; 673 today, the extra being R3-5's two forms of the same question) answer the two questions a bookkeeping app cannot answer from its documents alone — **who changed what, and can a closed period still be edited** — as **evidence, not money**. A new key, `taxflow:audit:<orgId>` at `AUDIT_VERSION = 1` (ADR-013) that joins the vault in the round it was created (Rule 31). A seal is a date range, an event is a sentence, and the rupees the seal protects stay in the documents it only governs
- **The trail is append-only, and it proves itself.** `append()` is the only function that touches `events`, and every event gains a monotonic `seq` counting from 1 through it. `verifyChain()` walks the log by number rather than by order, so a run of `1,2,3,5` is a gap and `1,2,2,4` is a duplicate — the shape a hand-edit leaves behind — and the register names the broken numbers. **A checksum, not a signature**: it shows a row was touched, it cannot say who, and the page prints *"the trail is unbroken"* rather than a security claim it does not hold
- **A period is sealed only once it has ended, and releasing is stamping, not deleting.** `sealPeriod()` takes a month (`YYYY-MM`) or a whole financial year (April → March, `FY 2025-26` labelled) and refuses a window whose last day is today or later — a month you are still inside cannot be sealed and called history — refuses one that overlaps a seal already standing, and refuses a shape the register cannot read (`The period is not a shape this register can close`). `releaseSeal()` never removes a row: it stamps `released_at` and a required `release_reason`, so a silent unlock cannot exist — an empty reason is refused with the register's own sentence, *"Releasing a seal without a reason is a silent unlock — say why the period is being reopened."*, because a silent unlock is what an auditor looks for. A released seal stays visible forever as a released seal
- **The lock is a door a write path asks, not a wall around the store.** `sealGuard(orgId, date)` is the one question — read the register and answer sealed-or-not with the register's own full sentence (*"2026-09-15 falls inside a sealed period — September 2026, closed by <actor> on 2026-10-01. Release the seal at /audit before editing a document dated there."*) so the page never has to invent one. When the answer is yes the write is refused, a red inline banner with a *View seals* deep link appears beside the date that would break it, and the **attempt itself** lands on the trail as a `refused` event even though nothing changed — a save that quietly did nothing would leave no evidence the shop ever tried. R3-1 asked that question in one place and R3-5 put it in the writers, with three forms of it for three kinds of caller — see §3.52
- **Which paths consult the seal is printed, not implied.** R3-1 wired the guard into **one** door — `/invoices/new` — and the page said so on the seals tab rather than implying a lock that quietly covered some doors and not others; **R3-5 did the wiring task that boundary named** (a change to the shared writers, not to each page), so the door now stands on 19 of the 21 paths `/audit` lists and the two left open are printed as open. See §3.52 for where each one is asked and why the residue stays open.
- **Counts render as counts, never as rupees.** The four stat cards on `/audit` — *Standing seals*, *Released*, *Trail events*, *Writes refused* — wrap each value in `String()` so `StatCard`'s default `formatCompactINR` cannot turn a `0` into `₹0.00` on a register that keeps no money; the modal's preview rail names a seal as *"a locked window"* rather than as a rupee-shaped placeholder. `recordRefusal`'s note is built article-aware (`an invoice`, `a bill`) so the trail reads as prose, not a template with a hole
- Wiring: one nav item **Audit trail & period lock** in the shell, two ⌘K actions (`action:seal-period` → `/audit?new=1`, `action:audit-trail` → `/audit?tab=trail`), three new glyphs (`lock`, `unlock`, `chevron-left`) taking the registry from 69 → **72 real glyphs** (the counting regex finds 73 lines because the component's own `name: string` prop matches the same shape — the trap `4-Design-System.md` §16 documents; R3-2b's `journal` brings the registry to **73**), the vault's `REGISTERS` list grown from **31 → 32 specs** (27 restorable) under the *workpapers* group, and the two CSVs the page exports (an 8-column trail sheet, an 11-column seal sheet with its release reason on the row). **122 assertions in `/tmp/audit-test.mjs`** cover the empty / damaged / wrong-version read, every `sealPeriod` refusal and the month-ends/FY-ends windows that do land, `monthSealability`'s split, the release branch and its empty-reason refusal, the `sealGuard` sentence, the `refused` event that continues the seq, the `recordNote` trim, and every shape `verifyChain` catches — clean, gap, duplicate, reorder
- v1 files nothing with any authority and holds nothing stronger than this browser: the seal is the shop's own discipline, the trail lives in `localStorage` (ADR-013), and the file travels only inside the books vault (ADR-033). A release reason is prose, not a workflow — no approval chain, no notification, no signature image, and no second-factor before a save is stopped by the lock

### 3.49 Business Setup — Branches & Document Series (R3-2)

- `/business` + `src/lib/setup.ts` (547 lines) answer the two questions a single-office shop outgrows — **which of my registrations issued this paper, and can I give my documents my own number shape** — without ever holding a rupee. A new key, `taxflow:setup:<orgId>` at `SETUP_VERSION = 1` (ADR-013), joins the vault in the round it was created (Rule 31) under the *settings* group. Two tabs, branches and the five document series; the counters themselves never move here. (R3-2's record — the *five* became **six** in the next round when `journal` joined `SERIES_KINDS`, and `setup.ts` is 549 lines at this pass; see §3.50)
- **The register dresses a number; it does not count.** `composeNumber(fmt, n, fy)` only puts an already-counted integer into a shape — prefix, zero-pad 1–8, and whether the financial year sits inside it. The invoice counter stays the Supabase `invoice_sequences` row per org per FY, and the order kinds keep their own high-water marks, so changing the shape mid-year **re-issues nothing**: a live `TAX` override previewed `TAX-2026-27-0012` (count 12 carried from Supabase) while the invoice list still read the born `INV-…`, and after reverting the next paper wore `INV-2026-27-0012` without restarting. Because a kind can change its prefix, `seriesHistory()` hands the read walk every shape that kind has worn and `usedNumber()`/`usedNumberAnyYear()` parse each — so a running (year-less) series still inherits the largest count the year-shaped family reached
- **One prefix, one series.** `validateSeries()` refuses a prefix another kind already wears (*"… two series with one prefix would issue the same number twice"*) — the counters are per kind, so a shared prefix would quietly double-issue and only surface when a customer held both papers. A prefix is letters/digits/inner dashes, ≤ 8 characters, because it prints on every page
- **A branch is a registration, not a label.** Each carries its own 15-character GSTIN (the same shape rule the e-invoice library uses; the checksum digits stay honestly unverified without a GSP) and the two-digit state code it starts with, and the pair is refused when they disagree — *"a Tamil registration cannot carry a <state> branch. Place of supply and the CGST/SGST split read this pair."* Typing the GSTIN pre-fills the state; codes and GSTINs are unique; the first branch is the head by construction
- **The head is held, not owned, and history does not go out of business.** The head cannot be closed or deleted until it is handed over in one deliberate act (`setHead()` demotes every other row in the same write) — two heads would leave the header asking which office signed. A branch still stamped on any invoice can only be **deactivated**, never deleted (`deleteBranch(orgId, id, referenced)`), and `referenced` is read from the `invoices` rows themselves (an `ilike` probe on `[branch CODE]`) rather than trusted from the modal, so the refusal comes from the books. A closed branch stops being offered to new papers while its old papers still resolve to it
- **The stamp rides the notes, not the schema** (Rule 21 unbroken — no column was added). `[branch CODE]` is written at the front of the notes, replace-never-stack, so re-issuing a document on another branch never leaves two signatures; the invoice form's *Issuing branch* picker swaps the printed seller header, and the print page reads the stamp back with a **named fallback** under the primary registration when the register can no longer answer. The statutory pages (GSTR-1, e-invoicing) still sign with the primary registration — this is what the paper prints, not what the government holds
- **No rupee lives on `/business`.** The opening balances the balance sheet stands on are edited on *Financial statements*, and `ledger.ts`'s `OpeningBalances` grew additively (`bank`, `receivables`, `payables`, `as_of`; the four originals still stand unconditional). `openingStood = !as_of || as_of <= asOf` gates the three money lines to the day they were struck, so a balance sheet drawn before the books opened shows the documents it has, not an opening it was not yet standing on. The honest limit is printed beside the figure: a payment recorded later grows `cash` but cannot reduce an opening receivable — the engine will not guess which pre-books paper it settled; a settlement that moves both sides is an invoice with a number, not an opening figure
- Wiring: the dressed shape is threaded into `create-invoice.ts` (the Supabase row is now created with the configured prefix), `orderflow.ts` (`peekNumber`/`takeNumber`/`appendDraft`/`raiseDrafts` take an optional `SeriesFormat`), the challans page, the shared `OrderRegister`, the quotations page (its own numbers *and* the invoice number its convert path raises) and the recipes materials board (the dressed purchase-order format). One nav item **Business Setup** (`/business`, the existing `building` glyph — the registry stays at **72** real glyphs); the ⌘K page list derives from `nav.ts`, so shell and palette stay one source, and the page honours `?tab=branches|series` and `?new=1`. The vault's `REGISTERS` grew from **32 → 33 specs** (28 restorable) with `id: 'setup'` (`accepts:` refuses a file whose two lists are missing, `write:` → `saveSetup`, `verify:` counts branches + overrides). **131 assertions in `/tmp/setup-test.mjs`** cover the store/version guards, every `validateBranch` refusal, head handover, the close-vs-delete honesty, `validateSeries` including the collision, the `composeNumber` shapes, the worn-shape high-water reads and the CSV rows
- v1 changes nothing the schema forbids and moves no money: the branch stamp is prose in a column that already exists (the schema is hand-managed), the counters are unchanged in place, and the register lives in `localStorage` (ADR-013) travelling only inside the books vault (ADR-033). Honest boundary printed on the page: the **stamp → read-back → delete-refusal chain is engine-tested, not lived on a stamped invoice** — the UI offers no invoice delete, and no shop's books were dirtied with un-deletable probe paper; and credit/debit notes and purchase bills stay typed by hand, because the portal and the supplier number those

### 3.50 The Manual Journal — money the documents never raised (R3-2b)

- `/journal` + `src/lib/journal.ts` (**1,135 lines**) answers the *accounting depth* half of the review that opened Round 3 — "a proper double-entry journal, journal adjustments, opening balances" — with **named movements rather than a general ledger**. Everything else in the app is written backwards from paper; a journal entry is written forwards: depreciation on the machine, a bank charge pulled straight off a statement, money the owner took out of the till, a provision a GST notice has raised and a bill has not. Until now every one of those landed in **"Capital account (derived)"** on `/accounting` — the balancing figure the engine invents so the sheet ties, so the shop could see how big its ignorance was and never what it was made of. A **head** is the shop's own name and it declares which of the **fifteen** statement lines its rupee moves; an **entry** is at least two legs against those heads, and the derived statements read the postings. A new key, `taxflow:journal:<orgId>` at `JOURNAL_VERSION = 1` (ADR-013), joins the vault in the round it was created (Rule 31) as its **34th spec (29th restorable)**. Unlike `/audit` and `/business` this register **does hold rupees** — only as movements a human named, never as a posted ledger, which is why the four gates below exist
- **An entry balances, or it is not an entry.** `validateLegs` sums both sides through `paise()` — every total in the register is an integer count of paise, so a float tail cannot decide whether an entry balances — and a rupee of difference is refused at posting. A draft may be unbalanced (the debit typed tonight, the credit found tomorrow), but only a whole entry can reach a statement. Also refused: a leg naming a head the register does not hold, a **closed** head offered a new rupee at posting, a leg of ₹0 (*"A leg of ₹0 says nothing — put the rupee on it, or take the leg off."*), a leg under a paisa, a side that is neither, the same head debited and credited in one entry, a posting with no narration, and a future-dated posting — a future date is legal as a draft, which is what *draft* is for. **Two legs are asked for even of a draft**, and shortness is reported beside whatever else is wrong rather than instead of it, so a half-typed draft shows every hole the page has to fill
- **A balanced journal renames money; provably, it cannot explain it.** Write the plug out — `balancingReserve = (assets − liabilities) − capital − retained` — and substitute what an entry does to each piece: **Δplug = Σ all debits − Σ all credits.** A balanced entry therefore changes the derived line by *exactly nothing*, whatever it debits and whatever it credits. `plugProof()` reads that arithmetic off the rows the statements actually hold, and `/accounting` prints it instead of asserting it — the page's own words, filled from `proof`: *"The 3 journal entries this sheet read balanced to the paisa — ₹82,500 on each side — so the derived capital line did not move by a rupee. A journal renames money; it does not explain it."* Seen in the dev session on the shop's own org: a **₹40,000** depreciation posting against accumulated depreciation, its **mirror** reversing it with the engine's own reason line, and a third **₹2,500** posting — bank charges against a loan received — which moved the expense category *Bank charges* and the loans line on the balance sheet and left the derived capital figure where it stood. The three are still readable off `taxflow:journal:<orgId>` today: two folded pairs and one live expense, `seq journal:2026-27 = 3`, eight heads all open. The invariant itself is asserted, not eyeballed: the fold suite walks **every pair of the fifteen statement lines** and checks Δplug = 0 (250 assertions). The one exception is the honest one: a head named as **capital** does move the plug, deliberately — `journalCapital` is subtracted by name, so the journal gives room *back* to the derived figure rather than borrowing from it
- **A posted entry is reversed, never edited or deleted.** `writeEntry` refuses to change a posted row, `deleteEntry` refuses to remove one (*"it is history, not a draft. A delete would leave a number with no entry, so reverse it instead."*), and `reverseEntry` writes a **mirror**: every leg re-summoned from the original with its side flipped, head and rupee unchanged, its narration naming the entry it answers, and a required reason — an unexplained reversal is the same silent unlock a seal refuses. Both halves stay on the register, the fold nets them to nothing, and the correction is evidence instead of a vanished entry. Same doctrine as a run that has been sold (R2-29) and a seal that is released rather than deleted (R3-1)
- **The seal is the second door, and the door is not a disabled button.** `stopForSeal` asks the seal (`sealGuard` when R3-2b shipped it; `askSeal` since R3-5, which folded the logging of the attempt into the same call) for the entry's **own date** *before any leg is read* on all three write paths — draft save, posting and reversal — and `recordRefusal` appends the attempt as a `refused` event, because a closed period cannot be journalled into and an edit that never happened is still evidence. This was the second write path in the app to consult the seal, after `/invoices/new`; **R3-5 took the same door into the shared writers**, and `/audit` now names every path that asks (§3.52). its copy is built from the `GUARDED` list (`sealedDoors()`), so a sentence on that page can never claim a coverage the wiring has not earned, and a third door shows up in the prose by itself. The composer **keeps its buttons live** on a sealed date — held buttons would stop the click reaching the engine and no refusal could ever land, which is exactly what a seal is for. Seen live: September 2026 sealed, a draft dated 2026-09-15 refused with the register's own sentence, and the trail moving to *Trail events 2 · Writes refused 1*
- **The fold is a reading, not a second computation** (Rule 33). `journalRows()` hands `ledger.ts` plain rows — head name, line, **signed** rupees — and the same array feeds the P&L, the cumulative profit and the balance sheet, so the two statements cannot read different judgements. The P&L takes the rows inside its own window, the sheet those dated up to its as-of day, and a row with no date is read by neither. An expense head joins the category of that name (a journal does not raise a fifth kind of cost, it names a cost the paper never carried); a line the documents never carried gets its own name on the sheet (`otherAssets`, `otherLiabilities`) instead of being folded into a figure the shop cannot trace; a stated GST figure is added *after* the documents' own floor, because it is a stated number, not a credit to be netted away. Drafts never fold — only postings, and a reversed pair folds too because it nets to nothing **and stays visible**
- **A fold that answers itself says so** (Rule 27). `JournalFold.touched` counts the lines the fold *leaves changed* — a slot that netted to zero is absent rather than zero-printed — so four legs of a reversal earn *"fold into this period and answer each other — every line they name nets back to where it stood, so no figure here moved"* rather than the sentence that counted legs. Found by driving the live page, not by reading the diff
- **A head that has been used is closed, not deleted.** Heads are the shop's own words, not a statutory chart: while any leg references one, `deleteHead` refuses, because the entry carrying the rupee still has to read; `setHeadActive` closes it to new money while entries already carrying it keep folding. `addStarterHeads()` offers the six movements shops ask for most (Depreciation, Bank charges, Drawings, Loan received, a GST-demand provision, Stock shrinkage) **on a click** — nothing is seeded silently — and each carries the note saying what it is not (a drawing is not a salary; a provision moves the sheet and no return reads it)
- **The number is dressed here, never counted elsewhere** (Rule 39). `journal` is the **sixth** `SeriesKind` on `/business` (default `JR`, pad 4, FY inside → `JR-2026-27-0001`), and the count is this register's own `seq`, keyed by shape and by the financial year the entry's *own date* falls in, walking every shape the kind has worn so a mid-year change cannot re-issue a number. The count is taken **only when an entry becomes paper**: a draft has no number, so deleting one cannot punch a hole in a series an auditor reads
- Wiring: one nav item **Journal Entries** under *Reports & AI*, beside *Financial Statements*, and a **new `journal` glyph** (a T-account on a leaf — the shape no existing key meant) worn by that row, the palette action and `/accounting`'s *Journal register* button, taking the registry from 72 → **73** real glyphs; two ⌘K actions (`action:journal-entry` → `/journal?new=1`, `action:journal-heads` → `/journal?tab=heads`); `?q=` deep search, `?tab=heads`; two CSVs (an 11-column register with each leg on its row, a 7-column head list with its balance); boundary cards printed on the page (no return reads it, it invents no document, it lives in this browser, a posted entry is only ever reversed); a standing-seal bar when the shop holds one; and a finding, never a correction, for entries dated **before the day the books were picked up** (`beforeTheBooksOpened`, read against R3-2's `as_of`). `/accounting` gained the *Journal register* button, the *"of which the journal stated"* sub-lines tagged `from the journal`, the two fold footnotes and the plug proof; `/ai/ask` reads the same rows and keeps them **beside** its document figures — a journal expense head is answered as *"judgement rather than a bill, so they are not counted in the figures above"*, with a link to the register
- v1 is not a general ledger and the page says so: **no account code, no parent/child chart, no trial balance, no running balance beyond what `headBalance` reads on demand, nothing here posts to another journal**. It files nothing — a GST liability leg moves the balance sheet and never touches GSTR-1, 3B, 9 or the TDS workpaper. It settles nothing — a journal cannot pay a bill, reduce an invoice's `balance_due`, or stand in for a row in `/payments`. And it does not reach the bank: the review's *reconciliation controls* half stays where it already lives, on `/bank`. **393 assertions in `/tmp/journal-test.mjs`** cover the store guards, the head lifecycle, every leg and posting refusal, the number taken at posting, draft-only deletion, the reversal and its refusals, the seal door with its trail event, the fold's reads, the summaries, and the plug invariant across every pair of lines; **250 in `/tmp/fold-test.mjs`** cover the fold through `ledger.ts` itself — a statement with no journal reading exactly as it did, capital-naming money, the GST figure added after the floor, paisa arithmetic, what the fold will not read, and `touched`

### 3.51 The Filings Register — what each return stated, and the paper that missed its window (R3-4)

- `/gst/filings` + `src/lib/filings.ts` (**2,279 lines**, 118 exports) and a **2,079-line** page answer the GST half of the review that opened Round 3 — "live GSP workflows, **filing-status history, amendment tracking** and period locks" (`TaxFlow Feature_1.pdf`, p. 2). Period locks landed as R3-1; the other two had no home. `/gst/calendar` knows a return is *due* and carries a tick (a "done on" date and a free-text reference in `taxflow:compliance:<org>`); `/gst/gstr9` knows what a year's 3B *stated* for the 9C workpaper. Neither answers the question a department actually asks — *when did each period go in, was it late, what did it say, and what did you do about the invoice you forgot*. The register keeps **six forms** (`gstr1`, `gstr1a`, `gstr3b`, `cmp08`, `gstr4`, `gstr9`), **three cadences** (`monthly`, `qrmp`, `composition`), **three statuses** (`not_filed` / `filed` / `nil`), **five amendment kinds** and **nine row states**, on a new key `taxflow:filings:<orgId>` at `FILINGS_VERSION = 1` (ADR-013), joined the vault in the round it was created (Rule 31) as its **35th spec (30th restorable)**. **A row is a transcript, not a posting** — the figures are what the return *stated*, no rupee here is owned by the register, and nothing in `ledger.ts` reads it
- **The due date is snapshotted, then audited — and the audit is allowed to disagree.** Each row copies the calendar's date (`due`) and keeps `due_reason` for a date the shop replaced after a notification. On top of that `statutoryDue()` re-derives the date from the rule text where a rule states one — the 20th under rule 61(1)(i), the **22nd or 24th** under 61(1)(ii) by the state code of the principal place of business (row-1 states: Karnataka, CGST circle Hyderabad), the 18th under rule 62(1)(i), 30 June under the proviso to 62(1)(ii) from FY 2024-25, 31 December for CMP-08's preceding-quarter payment under rule 62(1), and 31 December under section 59 read with rule 64 for the annual return. `expectedRows()` prints *only* the places the two disagree: a cited rule that **agrees** with the calendar is silent, a cited rule with no derivable date says the calendar's date cannot be checked yet, and an uncited rule with a different date names both. That last branch was a bug found by this round's suite — every agreeing row was printing a "drift" sentence that said the opposite of what it meant
- **A QRMP filer's year is folded, and the fold is disclosed.** `compliance.ts` emits a *monthly* summary row even for a quarterly filer, so `eventPeriod()` folds twelve of them into the four quarters rule 61(1)(ii) actually speaks of, and `calendarObjections()` prints the fold ("… the calendar's twelve monthly rows…") instead of quietly presenting four rows as if the calendar had made them. Folding exposed a second bug: **Q4 of a financial year is January–March of the *following* calendar year**, so a quarter's statutory due date has to carry that year with it — the first draft lost the carry and dated a 2026-Q4 return in April 2026, a year early
- **Late fee is computed by the slab that applies, and prints the notification that decided it.** Section 47 gives ₹50 a day capped at ₹5,000; Notifications No. 19, 20 and 21/2021-Central Tax, dated 01.06.2021, cut the ceiling to **₹2,000 up to ₹1.5 crore** of the preceding year's aggregate turnover, **₹5,000 up to ₹5 crore**, **₹10,000 above it**, and **₹500 on a nil return** (₹20 a day); Notification No. 07/2023-Central Tax, dated 31.03.2023, gives GSTR-9 ₹50/₹100/₹200 a day capped at **0.04% / 0.04% / 0.50% of the turnover in that State or Union territory**. `estimateLateFee()` applies those and returns the `basis` sentence with the notification in it, so the calendar's ₹5,000 headline is shown *beside* the figure, never merged into it (Rule 33). Interest under section 50 is estimated at 18% a year on the tax, from the due date to the day it is printed (or the day the tax was paid, when the row knows it), with **paid-against-rule kept as two columns** on both fee and interest. The composition ceilings are labelled **"this register's reading"** — the ₹50/₹2,000 numbers could not be verified from a dated source this round, and the register says so rather than citing a notification it has not read
- **An amendment is dated against the window that still allows it.** Three mechanisms, each with its own clock: the option in the **proviso to rule 59(1)** to amend outward details in GSTR-1A *"after furnishing the details … in FORM GSTR-1 for a tax period but before filing of return in FORM GSTR-3B for the said tax period"* — so the door shuts the moment that period's 3B goes in, and the date printed on that door is the 3B's own because that is the return that shuts it; **Table 9A** of the annual return, open until GSTR-9 is actually filed (and reading the *stated* due date on the row when the shop replaced it after a notification); and the recipient's credit, which **section 16(4)** — reproduced verbatim in Circular No. 237/31/2024-GST, dated 15.10.2024 — closes on *"the thirtieth day of November following the end of financial year … or furnishing of the relevant annual return, whichever is earlier"*. `windowsFor()` computes all three per period; `amendmentBoard()` reads each item against its kind's clock and prints **lapsed** when every window has shut, because a correction nobody can file is not a to-do. Paper that names a document number no book holds is flagged `dangling` — a finding, never a correction (Rule 29)
- **The chain the rules already enforce is spelled out, and it fires on an empty register too.** Rule 59(6)(a) does not allow a GSTR-1 when the previous period's 3B has not been furnished, 59(6)(b) says the same for the **Invoice Furnishing Facility** of a quarterly filer, and 59(6)(d) stops the next GSTR-1 while an intimation under rule 88C(1) stands unpaid or unanswered against a return filed under rule 59(10). `consequencesFor()` reads exactly those bars off the rows — with a 2024 amendment to 59(6)(b) recorded on the row where the two readings differ — and points at the period that has to go in first. A row carrying a bar prints as **blocked** with its citation. The suite made one thing explicit that the first draft got wrong: an *empty* register is not a clean one — with no April 3B on it, the next May GSTR-1 is honestly barred
- **Stated against books, within ₹1.** `varianceFor()` compares the six heads a filed return states with what the outward documents of that period add up to (`taxable`, IGST, CGST, SGST, cess, total tax) and names only the heads whose gap exceeds `RECON_TOLERANCE` — the same ₹1 the 9C workpaper uses, so the two pages cannot disagree about what a rupee means. The difference is printed **books minus stated**, a **nil return is compared as nothing** (so the year's books become the gap rather than the row being skipped), a `not_filed` period is not compared at all, and an unfiled row that has never been recorded reads `unset` rather than zero
- **The seal is read for a badge and handed over for a decision — it is never asked.** Unlike `/journal`, a filing record moves no rupee on the statements, so R3-1's door does not stand here; instead every row looks its period up in the audit register (one path since R3-5 — `sealForPeriod()` standing on `audit.ts`'s `sealForDate()`, the register's duplicate spelling of the same question folded into it rather than left beside it) and wears the seal's own label, `sealFilingsPeriod()` **hands the work to `/audit`'s `sealPeriod()` and keeps its rules** (a running month is refused, an overlapping seal is refused, and a quarter is refused by naming the three months it would have to be), and every status change appends one line to that same append-only trail. Deleting a row that is filed is refused while an open amendment points at it, and when it is allowed the removal is journalled in the trail's own words
- Wiring: one nav item **Filings & Amendments** in the GST group (`nav.ts:80`), a **new `filing` glyph** (a filed return with the portal's tick on it — the shape no existing key meant) worn by that row and both palette actions, taking the registry from 73 → **74** real glyphs (**75** lines to the documented regex, one of them the component's own `name: string` prop); two ⌘K actions (`action:record-filing` → `/gst/filings?new=1`, `action:amendment-board` → `/gst/filings?tab=amendments`); `?q=` deep search and the three tabs (`returns` / `amendments` / `variance`) reachable by deep link; **three CSVs** — the grid at **27** columns, the board at **17**, the variance at **10**; a card on `/gst` and a cross-read line on `/gst/calendar`, `/gst/gstr9` (whose 9C table is the *same* two sides typed by hand) and `/audit`. `compliance.ts` gained the `UNTRACKED_CALENDAR_FORMS` table this register reads so a form the calendar names and this register does not keep is printed with its rule rather than dropped
- v1 is deliberately not the portal, and the page says so five times over in `NOT_TRACKED`: **no GSP feed, no ARN verification** (`reference` is stored exactly as written and the register never implies the portal agreed), **no filing and no payment** — a row here cannot discharge the liability on `/gst/gstr3b` or move the cash ledger; the **IFF**, the **PMT-06 deposit** a QRMP filer owes by the 25th under rule 61(3), **refunds, DRC notices and demands**, and **any effect on the statements** are named with their rule instead of being quietly left out. The calendar still emits monthly rows for a quarterly filer and no PMT-06 row at all — the fold lives in this register, the emitter does not; teaching `compliance.ts` to emit quarters is the deferred half. **446 assertions in `/tmp/filings-test.mjs`** cover the store guards, the slabs against their notifications, the snapshot-then-audit dates and the QRMP fold and its year carry, every refusal on the write and delete paths, the three clocks and their shutters, the 59(6) bars, the board's urgencies, the variance's tolerance and sign, the nine-state ladder read from different days, the seal badge and the handed-over seal, `loadContext`, the boundaries and all three exports; the round's four surviving suites re-ran green at **393 + 250 + 122 + 131**, so the register's two engine fixes broke nothing that was already keeping its own promises

---

### 3.52 The Seal on Every Writer — a door on the code, not on the form (R3-5)

- The review's "period locks" line was only half kept by R3-1: a shop could seal September and still raise a September bill, take a September payment, or replay a queued September invoice from the outbox without being asked. **The gap was not a missing page — it was a missing layer.** A banner on one form cannot close a window, because the same document arrives through the counter, the recurring run, the offline queue, an order conversion, a challan conversion, a Tally import, a scanned receipt, and a page can only guard the path it owns.
- **So the door moved into the writers.** `requireOpenSeal(orgId, { date, target, ref })` is the **first statement** of `createInvoice` (`create-invoice.ts`), `createPurchaseBill` (`create-bill.ts`) and `createNote` (`creditnote.ts`, both kinds), and it throws `SealedWriteError` whose `message` is the seal's own sentence. Two consequences were the point of putting it there: **it runs before any sequence number is spent**, so a refused save cannot leave a hole in a series an auditor reads, and **every caller inherits it** — `/pos`, `/recurring`, the `/offline` replay, `OrderDocument` (sales and purchase orders), `/challans/[id]`, `/tally`, `/ai/scan-bill`, `/bills`, `/credit-notes`, `/debit-notes`, `/invoices/new` — without a single one of those pages having to know what a seal is. Each was checked to surface the thrown sentence where it already prints a failure: the counter's form error, the catch-up run's error line, the order page's alert, the Tally plan's per-row "why" (that row's own document still writes; the sealed one is named), and the outbox entry's stored error.
- **The library offers three forms and the difference is deliberate.** `sealGuard()` only *reads* — a banner on screen must never write to the trail, because a banner appearing is not an attempt to change a period. `askSeal()` reads and, when sealed, appends the `refused` event and hands back the guard. `requireOpenSeal()` is `askSeal()` plus the throw, and belongs on a writer. A page that types straight into a table is its own door and calls `askSeal()`, then prints `stop.why` and returns before it burns a number.
- **One banner, drawn once.** `src/components/SealNotice.tsx` (47 lines) is the red lock notice under a date field: it calls `sealGuard()`, renders nothing while `orgId` or the date is empty (which is also what keeps the server render quiet), and links to `/audit?tab=seals`. Every page that has a typed date now grows the same sentence in the same red instead of spelling its own box.
- **Coverage is a counted list, not a claim.** `/audit`'s `GUARDED` array is the contract: **21 rows — 19 paths that consult the seal, tagged by the hand that asks** (`the writer` ×12, `its own engine` ×1 for `/journal`, whose door sits in `journal.ts` and asks before a leg is read, `this page` ×6: expenses, payments, the paid/cancel stamps on `/invoices` and `/bills`, a `/quotations` conversion, and the scanned-receipt half of `/ai/scan-bill`), and **2 rows printed as open** — *GSTR-1 filing status* and *Master records*. A dead href (`/bills/new`, which has never been a route) was replaced by this rewrite, and the audit suite now fails if a listed href stops being a route or a door marked guarded has no guard in its source. The page's own sentences come out of the same array, so a claim cannot outrun the wiring and a new door changes the copy by itself.
- **Two kinds left open on purpose, and named.** A master record — customer, vendor, product, settings — carries no date and moves no rupee on a statement, so a period seal has nothing to close it. A return's **filing status** is a transcript of paper already filed (R3-4's doctrine, ADR-038): it *reads* the seal for its badge and is never stopped by it. `SealNotice`, the `/audit` list, and this document all say so rather than implying a lock that covers them quietly.
- Boundary, printed where it is read: the seal is enforced by **this app's writers**. A row changed outside them — the Supabase table directly, another client — is not stopped, exactly as the trail is a checksum over `seq` and not a signature. Sealing also never rewrites or erases paper already issued; it is a statement about a window from the moment it stands, and releasing it keeps the row and demands a reason.
- Wiring: no new register, no new `localStorage` key (Rule 31 untriggered), no new glyph — the banner reuses `lock`, so the registry stays at 74 — and the vault stays at 35 specs. What changed is where the question is asked, which is a rule, not a route: **Rule 42 / ADR-039**.



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
- Payroll *as a payment system* — `/payroll` (R2-31) computes the salary register in the browser and `/payroll/payslip` (R2-33) prints it as A4 paper, but neither files nor delivers anything: no money moves, no challan is numbered, no slip is emailed or acknowledged (it is downloaded), Form 16 Part A stays inside TRACES, and the old regime is not computed. The rupees still leave at `/expenses`
- A general ledger behind the journal — `/journal` (R3-2b) keeps the shop's own named movements and folds them into the derived statements, but there is no account code, no parent/child chart, no trial balance and no posting to another journal; the statements stay a *derivation* from documents plus judgement, and the derived capital line is still the books' own unexplained remainder
- Putting a costed hour inside a project's contribution — `/projects` (R2-23) prices labour at the rate you would bill it, and since R2-31 the salary register can compute what the hour actually cost (`costPerHour()`, printed on `/payroll`'s Cost tab and taken by no other page). The two are kept apart on purpose: the hours logged on a job were not necessarily the registered employees', and folding a reading into a margin would be a costing claim this app cannot prove
- TDS / TCS return filing — `/tds` builds the withholding workpaper and deposit calendar, but no Form 26Q or 24Q is filed, and TCS under 206C is not covered
- Revaluing a statutory invoice in a foreign currency — `/fx` (R2-19) keeps a dated rate ledger *beside* the rupee books; the invoice a return reads stays in rupees
- The customs and bank side of an export — `/gst/exports` (R2-25) tracks the shipping bill, the e-BRC/FIRA and the realisation window as typed evidence; nothing is fetched from ICEGATE or an AD bank, and no condonation representation is drafted for a window that has closed
- Authenticated customer logins — the portal (R2-16) is a share link that carries its own statement, not an account per party (Phase 14)
- Native mobile app (the web app is an installable PWA)
- Server-side LLM features — by design, so a business's bills never leave the device
- A server-held copy of the vault backup — `/vault` (R2-26) produces a file the user keeps somewhere the browser is not; scheduling a cloud upload would need a server route the schema rule forbids
- New database tables or migrations; feature work rides on the existing schema plus per-organisation local storage
