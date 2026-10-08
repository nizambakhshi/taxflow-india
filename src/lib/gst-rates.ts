// =============================================
// The GST rate table — one source for every rate picker in the app.
//
// GST 2.0 (56th Council meeting, 3 Sep 2025, effective 22 Sep 2025) removed the
// 12% and 28% slabs and introduced a 40% slab for demerit and luxury goods.
// The structure since then is 0 / 5 / 18 / 40, plus the two concessional rates
// that survived the rationalisation: 0.25% on rough diamonds and 3% on gold,
// silver, platinum and jewellery.
//
// 12 and 28 stay in the list on purpose. Documents raised before 22 Sep 2025
// carry them, a handful of notified lines remain there, and a credit note
// against an old invoice has to be able to repeat the original rate — dropping
// them would leave an old document impossible to correct.
//
// bill-text.ts keeps its own copy for a different job: it *detects* the rate
// printed on a supplier's bill inside a 0.75-point tolerance. 0.25% is
// deliberately absent there because near-zero implied rates are rounding noise
// on a no-tax row, not a diamond trader's invoice.
//
// Rates move by notification. Verify against cbic.gov.in before a filing season.
// =============================================

export const GST_RATES = [0, 0.25, 3, 5, 12, 18, 28, 40] as const

export type GstRate = (typeof GST_RATES)[number]

/** Shown under a rate picker so a shopkeeper knows why the list looks like this. */
export const GST_RATE_NOTE =
  '0 / 5 / 18 / 40 since 22 Sep 2025 · 0.25% rough diamonds · 3% gold, silver and jewellery · 12% and 28% kept for documents raised earlier'
