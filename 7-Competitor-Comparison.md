# 7 — Competitor Comparison

**Built:** 2026-10-08 · **TaxFlow column:** read out of this codebase (40 routes, 29 libraries — not marketing copy) · **Competitor columns:** each vendor's own public pages, fetched 2026-10-08 over plain HTTP.

## Legend — read this before the table

| Mark | Means |
| --- | --- |
| ✔ | The vendor states it on the page fetched (source linked in §6). |
| ~ | Partial: only at a higher paid tier, as an add-on, or stated ambiguously. |
| · | **Not stated on the page fetched.** This is *not* a claim that the vendor lacks it — marketing home pages omit things all the time (Tally's home page never mentions payroll; Tally sells payroll from ₹750/month). |
| ? | Could not verify — page unreachable. |

CaptainBiz and Swipez were in the original competitor list but their sites did not respond to a direct fetch, so they are excluded rather than guessed at.

Everything below is "what the vendor advertises", which is exactly the thing TaxFlow's roadmap is competing against — not a feature-by-feature audit of the products.

## 1. Documents and order flow

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| GST tax invoice (B2B/B2C/export/SEZ) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Quotation → invoice | ✔ | · | ✔ | · | ✔ | · | · | · | · |
| Credit / debit notes | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Purchase bills + ITC | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Delivery challan | ✔ (R2-14) | · | ✔ | · | · | · | ✔ | · | ✔ |
| Purchase order / sales order | ✔ (R2-14) | · | ✔ | · | ✔ | · | ✔ | · | ✔ |
| Recurring invoices | · | · | ✔ | · | · | · | · | · | ✔ |
| Expense tracking | ✔ | · | ✔ | · | ✔ | · | · | · | · |
| Invoice templates / branding | ✔ (3 skins) | · | ✔ | ✔ (multi-rate, formats) | ✔ (themes) | · | · | · | · |

## 2. Inventory and counter

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Stock tracking + movements | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ | · | · |
| Multi-godown / branch | · | ✔ | · | ✔ | · | ✔ | ✔ | ✔ | · |
| Batch / expiry | · | · | ~ (Elite) | ✔ (pharmacy page) | · | · | ✔ | · | ~ |
| Serial numbers | · | · | ~ (Elite) | · | · | · | ✔ | · | ~ |
| Barcode | ✔ (camera + wedge) | · | · | ✔ | ✔ | · | ✔ | · | · |
| POS / counter billing | ✔ | · | · | · | ✔ | · | ✔ | · | · |
| Low-stock alerts / reorder planning | ✔ (s,S policy + supplier POs) | · | · | · | ✔ (low-stock) | · | · | · | · |
| Manufacturing / BOM | · | · | · | · | · | ✔ | · | ✔ | ✔ |

## 3. Money in and out

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Receivables / payables + ageing | ✔ | · | ✔ | ✔ | ✔ (outstanding) | ✔ | ✔ | · | ✔ |
| Payment reminders | ✔ (3 tones) | · | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| WhatsApp sending | ✔ (wa.me links) | ✔ | · | ✔ (bills + reminders) | · | ✔ | ✔ | ✔ | ✔ |
| UPI / payment links | ✔ (upi:// deep links) | · | ✔ (gateways) | · | · | · | ✔ | ✔ | · |
| Party ledger / statements | ✔ | · | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ |
| Bank statement import + auto-match | ✔ (no feed, in-browser) | ✔ | ✔ | · | · | ✔ | ✔ | ✔ | ✔ |
| TDS / 194Q withholding workpaper | ✔ | · | · | · | · | · | · | ✔ (TDS returns) | · |

## 4. Accounting depth

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Double-entry P&L / balance sheet | ✔ (derived, always balances) | · | ✔ | · | ✔ (bookkeeping) | ✔ | ✔ | · | · |
| Budgets / targets | ✔ (festival-weighted, prorated pace) | · | ✔ | · | · | · | ✔ | · | · |
| Cost centres / job work | · | · | · | · | · | · | · | ✔ | · |
| Payroll | · | ✔ (₹750 + 18% GST/mo) | ~ (Premium) | · | · | · | · | ✔ | · |
| Multi-currency | · | · | ~ (Professional) | · | · | · | · | · | · |
| Project / time tracking | · | · | ~ (Professional) | · | · | · | · | · | · |

## 5. GST and compliance

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| GSTR-1 / 3B preparation | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| GSTR-2B ↔ books ITC reconciliation | ✔ | ✔ | · | · | · | ✔ | ✔ | ✔ | ✔ |
| GSTR-9 / 9C annual workpaper | ✔ (books-vs-3B, Rule 42/43, 180-day watch) | · | · | · | · | · | · | ✔ | · |
| GSTR-4 / CMP-08 composition workpaper | ✔ | · | · | · | · | · | · | · | · |
| Statutory registers (HSN, party-wise, Rule 80(1)) | ✔ | · | · | · | ✔ (GSTR reports) | · | · | ✔ | · |
| Compliance calendar + late-fee estimate | ✔ (filing profile → FY events, .ics) | · | · | · | ✔ (late-fee calculator) | · | · | ✔ | · |
| E-invoice (IRN) | ~ (JSON build + download, no submission) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| E-way bill | ~ (JSON + e-way log, no submission) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Direct filing / GSP submission | · (workpapers only, by design) | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |

## 6. Platform, users, AI

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Cloud / web app | ✔ | ~ (connected services) | ✔ | ✔ (cloud + desktop) | ✔ | · | ✔ | ✔ | ✔ |
| Mobile app | ~ (installable PWA) | · | ✔ | ✔ (Android/iOS) | ✔ | · | · | · | · |
| Offline mode | ✔ (outbox replays real save path) | ✔ (desktop) | · | ✔ (offline-first) | · | ✔ | · | · | · |
| Multi-user roles / permissions | · (auth only, no roles) | · | ~ (Professional) | · | · | ✔ | ✔ | · | · |
| Customer portal | · | ✔ | ✔ (free tier) | · | · | ✔ | ✔ | ✔ | · |
| API access | · | ✔ | · | · | · | · | ✔ | ✔ | ✔ |
| Document attachments | · | · | · | · | · | · | ✔ | · | · |
| AI / OCR bill capture | ✔ (in-browser, nothing uploaded) | ✔ | ✔ (+ paid OCR addon) | · | · | · | · | ✔ | ✔ |
| Natural-language questions over your books | ✔ (17 intents, answers cite rows) | · | · | · | · | · | · | · | · |
| E-commerce integrations | · | · | · | · | · | · | ✔ | · | · |
| Tally data import/export | · | ✔ (n/a) | · | ✔ | ✔ | · | ✔ | ✔ | · |
| Free tier | ✔ (free to start, no card) | · | ✔ (1 user) | ✔ (free trial) | ✔ (free plan) | · | · | · | ✔ |

## 7. Where TaxFlow leads

1. **AI that never uploads the document.** Bill OCR and natural-language reporting both run in the browser. Zoho, ClearTax and Refrens have OCR, but as a server feature or a paid add-on; none of the pages fetched promise that the bill never leaves the device.
2. **GSTR-9 / 9C workpaper depth** — books-vs-filed-3B reconciliation, Rule 42/43 reversals, the 180-day credit watch, and an explicit "portal-only data" gap instead of invented numbers. This is CA-suite territory; the small-biz apps stop at GSTR-1/3B.
3. **GSTR-4 / CMP-08 composition workpaper** — line-level HSN/SAC slab split, the ten Notification 17/2020 states, the service provider's 10%-and-₹50L goods cap, the 2.5% deemed debit. No competitor page fetched advertises composition depth at all.
4. **TDS / 194Q workpaper read out of the purchase books** — section table, whole-vs-excess thresholds, deduction on the earlier of credit or payment, 26Q late fee. The billing apps don't do it; the ERP-class tools do it inside a module you pay several times more for.
5. **Bank matching without a paid bank feed** — any statement layout pasted or dropped in, each line scored against documents with the score explained. Zoho, Tally, Busy, Marg and ClearTax all do reconciliation; none advertise working from an arbitrary pasted statement with no feed.
6. **Craft-level things nobody advertises**: ⌘K palette over pages *and* live records, offline invoices that replay through the real save path with a real sequence number, party ageing, festival-weighted targets judged on a prorated pace, an (s, S) reorder planner.

## 8. The gap list, ranked

| # | Gap | Who has it | Cost to close |
| --- | --- | --- | --- |
| 1 | **Actual return filing / GSP submission** — we stop at workpaper + JSON | everyone | Blocked: needs a contracted GSP (see ADR-016) |
| 2 | **Delivery challan + purchase/sales orders + order-to-invoice flow** — **closed** (R2-14): `/challans` register and printable document (B1, `f982aed`), then sales and purchase orders on the same engine (B2, `b851818`) — confirm → close → convert to invoice, place → receive → convert to bill through the real write paths | Zoho, Marg, Refrens, myBillBook, Busy | Done — the PO-to-bill conversion asks for the vendor's own bill number (GSTR-2B matches it) instead of inventing one |
| 3 | **Batch/expiry + serial tracking, multi-godown** | Marg, Zoho (Elite), Vyapar, Refrens | Needs real schema work — the no-migration default has to be revisited for this one |
| 4 | **Customer portal** | Zoho (free), Busy, Marg, ClearTax | Medium — share links first, auth'd portal later |
| 5 | **Multi-user roles / permissions** | Zoho (Professional), Busy, Marg | Auth + schema; belongs with Phase 14 security |
| 6 | **Payroll** | Tally (₹750/mo), Zoho (Premium), ClearTax | Large; consider partnering rather than building |
| 7 | **E-commerce integrations (Amazon/Flipkart/Shopify)** | Marg | Medium per channel; high perceived value for retail |
| 8 | **Multi-currency** | Zoho (Professional) | Medium — touches every money path |
| 9 | **Recurring invoices** | Zoho, Refrens | Small — scheduler + template on the existing create path |
| 10 | **Manufacturing / BOM, cost centres** | Busy, ClearTax, Refrens | Large — different customer segment |
| 11 | **Native mobile app** | Vyapar, myBillBook, Zoho | The PWA covers install; a native shell is a distribution decision, not a feature |
| 12 | **Attachments on documents** | Marg | Small-medium — Supabase Storage + a viewer; makes RLS work first |

## 9. Rule drift found while researching — fixed 2026-10-08 (`5d92515`)

1. **GST 2.0 (56th Council meeting, 3 Sep 2025; effective 22 Sep 2025) removed the 12% and 28% slabs and introduced a 40% demerit slab.** The structure is now 0 / 5 / 18 / 40 (plus the special rates: 0.25% rough diamonds, 3% gold).
   **Fixed.** The list moved into `src/lib/gst-rates.ts` — 0 · 0.25 · 3 · 5 · 12 · 18 · 28 · 40 — and all eight pickers (`products`, `expenses`, `invoices/new`, `bills`, `credit-notes`, `debit-notes`, `quotations`, `ai/scan-bill`) import it instead of restating `[0,5,12,18,28]`. 12% and 28% stay in the list so a credit note against a pre-reform invoice can repeat its original rate. `bill-text.ts` keeps its own detection list deliberately — see the note in both files.
2. **E-invoicing threshold: ₹5 crore AATO** — our `einvoice` and `gstr9` pages already stated this correctly. No change.
3. **30-day IRN reporting for AATO above ₹10 crore** (effective 1 Apr 2025) — **fixed**: the e-invoice page now states the window and what missing it costs the buyer (they lose the input credit, because an invoice without a valid IRN is not a legal invoice).
4. **Composition limits for FY 2026-27: ₹1.5 crore goods / ₹75 lakh services in the special-category states, opt in via CMP-02 by 31 March** — `gstr4.ts` constants already matched. **Fixed** in the calendar: a non-composition filer now gets the 31 March CMP-02 opt-in as an event; a composition dealer gets the GSTR-4 annual instead, and nobody sees both.
5. **HSN reporting in GSTR-1 is 4 digits up to ₹5 crore turnover, 6 above, 8 for exports and imports** — **fixed**: the HSN register now carries that line under the table.

## 10. Sources

- Zoho Books India pricing (plans, users, tier mapping) — https://www.zoho.com/in/books/pricing/
- Zoho Books e-way bill — https://www.zoho.com/in/books/eway-bill/
- Vyapar home — https://vyaparapp.in/
- myBillBook home — https://mybillbook.in/
- Tally Solutions home — https://tallysolutions.com/
- Tally payroll — https://tallysolutions.com/payroll/
- Busy home — https://busy.in/
- Marg Books home — https://www.margbooks.com/
- ClearTax GST software — https://cleartax.in/s/gst-software
- Refrens home — https://www.refrens.com/
- GST 2.0 slab structure — https://www.bajajfinserv.in/gst-rates-in-india (summarising the 56th Council meeting, 3 Sep 2025, effective 22 Sep 2025)
- GST Council 56th meeting press release — https://gstcouncil.gov.in/sites/default/files/2025-09/press_release_press_information_bureau_0.pdf
- FY 2026-27 compliance checklist (composition limits, ISD, HSN, e-invoice thresholds) — https://taxguru.in/goods-and-service-tax/gst-fy-2026-27-compliance-checklist-10-key-actions-businesses.html
- E-invoicing in 2026, threshold and 30-day rule — https://ledgester.com/guides/gst-e-invoicing-2026/
