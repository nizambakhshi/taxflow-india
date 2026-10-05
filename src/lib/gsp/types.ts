// GSP (GST Suvidha Provider) integration layer.
// Real providers (TSP, ClearTax/CSTIL, Vetrika, Cygnet...) each wrap the same
// NIC e-way bill / e-invoice backend with slightly different auth + JSON shapes.
// Add a new provider by implementing EwayBillProvider and registering it in ./index.ts.

export interface EwbSubmission {
  // Output of buildEwbJson() from @/lib/einvoice — the GSP request body.
  payload: Record<string, unknown>
}

export interface EwbResult {
  providerId: string
  mock: boolean
  ewbNo: string
  validityEndDate: string // yyyy-mm-dd
  qrCode?: string
  acknowledgedAt: string // ISO timestamp
  raw?: unknown
}

export interface GspProviderConfig {
  apiKey?: string
  apiSecret?: string
  authCode?: string // GST-portal authorisation code for the taxpayer's GSTIN
  gspUsername?: string
}

export interface EwayBillProvider {
  id: string
  name: string
  /** True for local simulators — surfaced in the UI so users never mistake mocks for real EWBs. */
  isMock: boolean
  generateEwayBill(submission: EwbSubmission, config: GspProviderConfig): Promise<EwbResult>
}

export class GspError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message)
    this.name = 'GspError'
  }
}
