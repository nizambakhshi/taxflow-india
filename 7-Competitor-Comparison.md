# 7 — Competitor Comparison

**Built:** 2026-10-08 · **Updated:** 2026-10-09 (R2-20 job work / ITC-04, §4 and §8 #13; R2-21 cost centres, §4, §7 and §8 #10; R2-22 Tally bridge, §6, §7 and §8 #14) · **TaxFlow column:** read out of this codebase (57 routes, 41 libraries — not marketing copy) · **Competitor columns:** each vendor's own public pages, fetched 2026-10-08 over plain HTTP.

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
| Recurring invoices | ✔ (R2-18) | · | ✔ | · | · | · | · | · | ✔ |
| Expense tracking | ✔ | · | ✔ | · | ✔ | · | · | · | · |
| Invoice templates / branding | ✔ (3 skins) | · | ✔ | ✔ (multi-rate, formats) | ✔ (themes) | · | · | · | · |

## 2. Inventory and counter

| Feature | TaxFlow | Tally | Zoho Books | Vyapar | myBillBook | Busy | Marg | ClearTax | Refrens |
| --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| Stock tracking + movements | ✔ | ✔ | ✔ | ✔ | ✔ | · | ✔ | · | · |
| Multi-godown / branch | ✔ (R2-17 — batch lots placed by godown, transfer = lot split, per-place stock; registered lots only) | ✔ | · | ✔ | · | ✔ | ✔ | ✔ | · |
| Batch / expiry | ✔ (R2-15 — lots, FEFO, expiry watch) | · | ~ (Elite) | ✔ (pharmacy page) | · | · | ✔ | · | ~ |
| Serial numbers | ✔ (R2-15 — one row per unit, derived warranty) | · | ~ (Elite) | · | · | · | ✔ | · | ~ |
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
| Cost centres / job work | ✔ (R2-20 job work: send/return register, section 143 clock, ITC-04 workpaper. R2-21 cost centres: departments/branches/projects/depots, documents split by share, contribution per centre) | · | · | · | · | · | · | ✔ | · |
| Payroll | · | ✔ (₹750 + 18% GST/mo) | ~ (Premium) | · | · | · | · | ✔ | · |
| Multi-currency | ✔ (R2-19) | · | ~ (Professional) | · | · | · | · | · | · |
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
| Customer portal | ~ (v1 — statement share links, R2-16) | ✔ | ✔ (free tier) | · | · | ✔ | ✔ | ✔ | · |
| API access | · | ✔ | · | · | · | · | ✔ | ✔ | ✔ |
| Document attachments | · | · | · | · | · | · | ✔ | · | · |
| AI / OCR bill capture | ✔ (in-browser, nothing uploaded) | ✔ | ✔ (+ paid OCR addon) | · | · | · | · | ✔ | ✔ |
| Natural-language questions over your books | ✔ (17 intents, answers cite rows) | · | · | · | · | · | · | · | · |
| E-commerce integrations | · | · | · | · | · | · | ✔ | · | · |
| Tally data import/export | ✔ (R2-22 — both directions, plan-first, in the browser) | ✔ (n/a) | · | ✔ | ✔ | · | ✔ | ✔ | · |
| Free tier | ✔ (free to start, no card) | · | ✔ (1 user) | ✔ (free trial) | ✔ (free plan) | · | · | · | ✔ |

## 7. Where TaxFlow leads

1. **AI that never uploads the document.** Bill OCR and natural-language reporting both run in the browser. Zoho, ClearTax and Refrens have OCR, but as a server feature or a paid add-on; none of the pages fetched promise that the bill never leaves the device.
2. **GSTR-9 / 9C workpaper depth** — books-vs-filed-3B reconciliation, Rule 42/43 reversals, the 180-day credit watch, and an explicit "portal-only data" gap instead of invented numbers. This is CA-suite territory; the small-biz apps stop at GSTR-1/3B.
3. **GSTR-4 / CMP-08 composition workpaper** — line-level HSN/SAC slab split, the ten Notification 17/2020 states, the service provider's 10%-and-₹50L goods cap, the 2.5% deemed debit. No competitor page fetched advertises composition depth at all.
4. **TDS / 194Q workpaper read out of the purchase books** — section table, whole-vs-excess thresholds, deduction on the earlier of credit or payment, 26Q late fee. The billing apps don't do it; the ERP-class tools do it inside a module you pay several times more for.
5. **Bank matching without a paid bank feed** — any statement layout pasted or dropped in, each line scored against documents with the score explained. Zoho, Tally, Busy, Marg and ClearTax all do reconciliation; none advertise working from an arbitrary pasted statement with no feed.
6. **Craft-level things nobody advertises**: ⌘K palette over pages *and* live records — now including the local order book (challans, sales and purchase orders search synchronously, in the same groups as everything else) — offline invoices that replay through the real save path with a real sequence number, party ageing, festival-weighted targets judged on a prorated pace, an (s, S) reorder planner, a FEFO batch register whose allocator names the expired lot it would draw — before anything is written, a serial register whose warranty window is recomputed from the latest sale (a resale restarts it; a return never forks the unit's history), and a customer statement link that carries the entire statement inside the URL's fragment itself — nothing stored, nothing to revoke, and the numbers identical to the ledger's by construction. Recurring billing goes the other way from the cloud habit: instead of a server cron that silently posts invoices at midnight, the schedule *accrues* — nothing is stored about what is due, the calendar is recomputed from the rule each time you open the page, and a back-dated catch-up bill lands in the financial year it belonged to, which is the GST-correct thing a monthly auto-invoice usually is not. Multi-currency goes the same direction: rather than rewriting the statutory invoice, `/fx` keeps the rupee books untouched and shows the three rupee numbers a foreign bill actually has — the rate you used, the rate your own totals imply, and today's rate — with the gap between them called out as the finding, and a rule-45 date-and-source stamp on every rate rather than a single live conversion factor. Cost centres go the same direction a third time: the tag stores a *percentage* against a document's own id and re-reads the rupees from the books on every load, so a split cannot rot when the bill is amended; the unassigned remainder is computed by subtraction and printed, because a division of the business that loses rupees is worse than no division at all; and a centre is never treated as a legal person — the cross-state branch raises a rule 41A question with a link to the return, not a tax figure invented beside it.
7. **Job work with the clock attached, and a calendar that reads the register instead of asking.** Section 143 is a deadline, not a checkbox: goods sent to a job worker must come back within 12 months (inputs) or 36 (capital goods), and rule 45 treats the *original send date* as the day a supply happened if they do not — so the exposure reaches backwards across periods instead of starting from the day you notice. `/gst/job-work` models exactly that: a lot may stipulate its own period but the engine takes the **shorter** of stipulated and statutory; moulds/dies/tools/templates are a first-class category with **no return period** (`no_deadline`, rather than an invented deadline); a late return is counted *and* reported instead of folding into "settled"; an onward move to a second job worker keeps the original clock; and there is deliberately no "written off" disposition, because leaving units outstanding *is* that statement and a second way to say it only lets the two drift. ITC-04 grids A/B/C/D and the HSN-wise summary are built from the movements inside the chosen period, with the outstanding column as the position at period close across every earlier lot. The compliance calendar has no "sends job work" toggle — `jobWorkEvents()` emits ITC-04 rows only when the register has movements, and the half-yearly-vs-annual dates come from declared turnover, so the calendar and the workpaper cannot disagree. None of the nine vendors fetched states ITC-04 on its pages (per the legend that means *not advertised on the pages fetched*, not that the vendor lacks it); the row's only ✔ is ClearTax, whose page describes job work as a feature rather than as a deadline with a deemed-supply penalty.
8. **A Tally bridge that shows its work before it writes anything.** Seven of the nine vendors advertise moving Tally data, and for a shop with years of vouchers in TallyPrime that bridge *is* the purchase decision — but the bridge is usually a black box: the file is uploaded, a mapping runs on someone's server, and the ledger changes. `/tally` (`src/lib/tally.ts`, **ADR-029**) keeps the file in the browser and separates *reading* from *writing*: `readTally()` parses a tolerant XML dump — Tally's own writer, integration dumps and hand-edited requests differ in case, in whether a value sits in an attribute or a child tag, in whether the file ends where the last tag closes — decides what each object **is** here (a Sales voucher with a Sundry Debtor is an invoice; a ledger under `Sundry Creditor` is a vendor; a Tally group is not a customer, and the reason it is skipped is printed beside it), and `buildPlan()` returns one row per object with its status — `ready` / `blocked` / `skipped` / `already` — the rupees it would write, **why not** for anything it cannot write, and **how it was worked out** wherever a figure had to be derived ("₹tax ÷ ₹taxable", labelled as arithmetic). A file is evidence, not instruction: where it disagrees with itself — ledger lines that do not sum to the printed total, a voucher that does not balance to zero — the disagreement is reported and the file's own lines win, because the lines are what the shop billed. Where an input cannot be resolved the row **blocks rather than guesses**: no party invented, no product created implicitly by a line, no tax rate spread across lines the file cannot attribute it to. Two numbers stay the owner's, not the file's: `invoice_number` comes from `invoice_sequences` and the Tally voucher travels in `notes` (`Tally Sales #V-101 · ref PO-118`) so the two books can always be tied back, and a purchase bill's `bill_number` stays the vendor's own reference because that is what GSTR-2B matches. And **an import never writes money** — a receipt ledger inside a voucher is reported as ₹X already collected and left for `/payments`, the one writer of money. Ticking is the only instruction; `writeOrder()` puts masters before documents so an invoice can find its party, and every row goes through `createInvoice` / `createPurchaseBill` — real sequence number, stock movements, FEFO — never a direct insert. Run backwards the same discipline: our rows become the XML envelope TallyPrime imports with `Create`/`Alter` as the only actions, the tax ledgers a voucher names written beside it (`Output IGST @18%` into a company that has no such ledger is the classic failed import), and the rupees being handed over counted and printed before the file is downloaded.

## 8. The gap list, ranked

| # | Gap | Who has it | Cost to close |
| --- | --- | --- | --- |
| 1 | **Actual return filing / GSP submission** — we stop at workpaper + JSON | everyone | Blocked: needs a contracted GSP (see ADR-016) |
| 2 | **Delivery challan + purchase/sales orders + order-to-invoice flow** — **closed** (R2-14): `/challans` register and printable document (B1, `f982aed`), then sales and purchase orders on the same engine (B2, `b851818`) — confirm → close → convert to invoice, place → receive → convert to bill through the real write paths; then the book joins the discovery surfaces (B3, `94b3c1c`): an Order flow tab in `/reports/registers` and synchronous ⌘K search over the three stores | Zoho, Marg, Refrens, myBillBook, Busy | Done — the PO-to-bill conversion asks for the vendor's own bill number (GSTR-2B matches it) instead of inventing one |
| 3 | **Batch/expiry + serial tracking, multi-godown** | Marg, Zoho (Elite), Vyapar, Refrens | **Closed** (R2-15 + R2-17): the batch/expiry register with FEFO consumption wired into the invoice write path (B1, `9b7a4c6`), then the serial-number register — one row per unit, append-only event log, warranty derived from the latest sale, units attached to invoices through the Issue action (B2, `e2a94d4`). Both client-side under ADR-013, because a batch and a serial are owner bookkeeping and the statutory paper never carries either. Multi-godown closes the same way (R2-17 B1, `8188d46`): a client-side godown register places each batch lot in a named place, a transfer is a **split** — a new destination lot keeps the source identity plus one negative `kind:'transfer'` move on the source, so the `left = qty + back − out` invariant and FEFO sorting never move — and a virtual Main seed reads every unplaced lot ("unplaced is not nowhere"); `/inventory/godowns` on the kit. Honest v1 boundary: per-place figures cover **registered lots only**, because `products.current_stock` has no per-godown column yet — that one rollup waits for the Phase 14 schema window rather than being faked |
| 4 | **Customer portal** | Zoho (free), Busy, Marg, ClearTax | **v1 shipped** (R2-16 B1, `ccea4d5`): the statement travels inside its own link — JSON → deflate → base64url in the URL **fragment**, so nothing is stored server-side and there is nothing to revoke; each open invoice row carries a UPI deep link with its own due amount (VPA baked at share time), and the figures are the ledger's own by construction. Auth'd customer logins remain |
| 5 | **Multi-user roles / permissions** | Zoho (Professional), Busy, Marg | Auth + schema; belongs with Phase 14 security |
| 6 | **Payroll** | Tally (₹750/mo), Zoho (Premium), ClearTax | Large; consider partnering rather than building |
| 7 | **E-commerce integrations (Amazon/Flipkart/Shopify)** | Marg | Medium per channel; high perceived value for retail |
| 8 | **Multi-currency** | Zoho (Professional) | **Closed** (R2-19 B1, `a7fd1b1`): `/fx` + `src/lib/fx.ts` — the bill keeps its statutory rupee figures in Postgres and the currency lives beside it in `taxflow:fx:<orgId>`, joined to the books **by invoice number**, because `invoices` has no currency column and the 29 statutory columns are frozen (ADR-013 again). Rule 45 (CGST Rules) is what the shape follows: value in INR at the rate notified for that day, so a rate is a **dated record with a source stamp** (`manual` / `feed`) and `rateFor()` answers `null` rather than inventing a number when nothing is recorded. The page never averages the three rupee numbers it shows — the rate used, the rate the books *imply* (`grand_total ÷ foreign value`) and today's rate — and the disagreement between them is the finding, not an error to smooth away. Realised gain is Σ(`receipt INR − receipt foreign × booked rate`), unrealised is `outstanding foreign × (today − booked)`; a currency with no rate reports **no revalued figure rather than a zero one**. Rates pull one currency at a time from the ECB reference feed (Frankfurter, no key, CORS-open) and AED/SAR/KWD/QAR/OMR are reported `missing`, never guessed. Honest v1 boundary, printed on the page: recording a remittance here does **not** receipt the invoice — money still arrives through `/payments`, the one writer — so this is the FX register, not a second cash book |
| 9 | **Recurring invoices** | Zoho, Refrens | **Closed** (R2-18 B1, `3fbea60`): a schedule is a bill template + a cadence + an end rule, stored client-side under ADR-013. Due dates are never stored — the occurrence calendar is derived from the rule against today, so a missed March bill is still waiting in April and raising it dates the invoice on the day it belonged to, which files it in the financial year it belonged to. Month arithmetic is anchor-relative and clamped (Jan 31 → Feb 28 → Mar 31, no drift), computed in UTC so a timezone cannot move a bill into another FY. Catch-up runs raise every due period through the real `createInvoice` path — real sequence number, stock movements, FEFO — and the offline queue replays them. Honest v1 boundary: nothing bills while the app is closed (no server worker), which is why the schedule *accrues* and the register shows the worth still unbilled |
| 10 | **Manufacturing / BOM** — the other half of this row, **cost centres, is closed** (R2-21 B1): `/cost-centres` + `src/lib/costcentres.ts` in `taxflow:ccentres:<orgId>`. A split stores a **share, never a rupee** — the percentage is the record and the amount is re-read from the invoice or bill on every load, so an amended document changes each centre's contribution by itself and nothing can drift. A document is **split, not moved**: parts come from the formula, the unassigned remainder comes from *subtraction*, so `Σ parts + remainder = the document` to the paisa and a rupee never sits in nobody's pocket. **A cost centre is not a legal person** — nothing here reaches a return; a branch in another state with no GSTIN of its own is flagged as a rule 41A question with a link to the GSTR-9 workpaper (the flag's wording changes with the registered home state: cross-state names both states, same-state stays silent, unknown says "if"), and never an invented tax figure. A tag whose document was deleted survives as an **orphan** row that says so and contributes nothing. BOM/manufacturing remains | Busy, ClearTax, Refrens | Large — different customer segment |
| 11 | **Native mobile app** | Vyapar, myBillBook, Zoho | The PWA covers install; a native shell is a distribution decision, not a feature |
| 12 | **Attachments on documents** | Marg | Small-medium — Supabase Storage + a viewer; makes RLS work first |
| 13 | **Job work / ITC-04** — not a ranked gap; taken from the `·` row of §4 once every client-side gap above was closed, because ITC-04 is an obligation with a deadline that none of the pages fetched states (per the legend, `·` means not stated, not absent) | ClearTax ✔ (stated); Tally, Zoho, Vyapar, myBillBook, Busy, Marg, Refrens `·` | **Closed** (R2-20 B1, `c5daa63`): `/gst/job-work` + `src/lib/jobwork.ts`, recorded as **ADR-027** and stored client-side under ADR-013 in `taxflow:jobwork:<orgId>` — there is no job-work table, *and* the statutory paper that does exist (the rule 55 delivery challan) has no field for "must return by", so the deadline lives in a clock beside the challan rather than on the document. The model is the statute: **section 143** gives 12 months for inputs and 36 for capital goods while **moulds, dies, tools and templates have no return period** (a first-class `no_deadline` category, not a note); a lot may stipulate its own period but `periodMonths()` takes the **shorter** of stipulated and statutory; **rule 45** deems a supply on the day the goods *went out*, so the exposure reaches backwards across periods and a late return is counted as well as reported (`returned_within_qty` / `returned_after_qty`); an onward move to a second worker needs intimation and **does not restart the clock**; a delivery from the job worker's own place is a supply by the principal and is pointed at `/invoices`. **ITC-04** is generated from the movements — grids A (sent) / B (received back) / C (delivered direct) / D (sent onward) plus the HSN-wise summary, with outstanding stated as at period close — on the half-yearly cadence above ₹5 crore (Apr–Sep by 25 Oct, Oct–Mar by 25 Apr) or annual at or below it. The calendar derives rather than asks: `jobWorkEvents()` emits the statements only when the register has movements, using the same `itc04Periods()` maths the workpaper prints, so no profile tick-box can contradict the books. Honest boundary, printed on the page: this is a workpaper — `indicative_tax` is labelled indicative, nothing files or posts tax, and a movement with no HSN is reported as a gap instead of smoothed away. **Cost centres, the other half of that row, were taken next** — see #10 (R2-21 B1) |
| 14 | **Tally data import/export** — again not a ranked gap: every remaining ranked item is blocked or schema-bound (#1 needs a contracted GSP, #4's authenticated half and #5 belong to the Phase 14 security window, #6 payroll is a different customer segment), so this was taken from the `·` row of §6, where four of the nine vendors advertise a Tally bridge and Indian bookkeeping already lives in Tally. A business with five years of vouchers in TallyPrime will not retype them | Vyapar, myBillBook, Marg, ClearTax ✔; Tally `✔ (n/a)`, Zoho, Busy, Refrens `·` | **Closed** (R2-22 B1–B2, `f67f56f`): `/tally` + `src/lib/tally.ts`, recorded as **ADR-029**. Nothing about the schema changes — the file is read in the browser, the rows it produces travel through `createInvoice` / `createPurchaseBill`, and only the *log* of an import is stored (`taxflow:tally:<orgId>`, ADR-013). The page is three views: **Plan** (drop or paste a Tally export → per-row plan with statuses, rupees, reasons and derivations → tick the rows → write; `?sample=1` loads a hand-written dump that yields ready 7 / blocked 1 / skipped 2 / attention 1), **Export** (pick invoices and bills from the real books, per-document line items fetched lazily, company name and `Create`/`Alter` chosen, the rupee total counted before `tally-export.xml` downloads), and **Log** (what was imported, when, and how many of each kind). Honest v1 boundary, stated in the library header and on the page: credit/debit notes, receipts, payments, journals and delivery challans inside a file are **listed as skipped** because their write paths live on other pages; a service voucher with only ledger entries and no line blocks rather than inventing a line; the file's Tally company state is not read — the organisation's primary GSTIN supplies it; and an import reaches no return, because it writes books, not filings. 607 assertions in `/tmp/tally-test.mjs` |

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
