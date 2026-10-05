// Local simulator for the e-way bill flow. Returns realistic-looking EWB
// numbers and validity periods (1 day per 1,000 km, minimum 1 day) without
// contacting any government system. Used for development and demos.

import { EwbResult, EwbSubmission, EwayBillProvider, GspError, GspProviderConfig } from './types'

function randDigits(n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10)
  return s
}

function validatePayload(payload: Record<string, unknown>) {
  const rd = payload?.requestData as Record<string, unknown> | undefined
  if (!rd) throw new GspError('Payload is missing requestData.')

  const required: [string, string][] = [
    ['fromGstin', 'From GSTIN'],
    ['fromPno', 'From pincode'],
    ['toGstin', 'To GSTIN'],
    ['toPno', 'To pincode'],
    ['toSt', 'To state code'],
    ['dom', 'Transport mode'],
  ]
  for (const [key, label] of required) {
    if (rd[key] === undefined || rd[key] === null || rd[key] === '') {
      throw new GspError(`E-way bill payload is missing "${label}".`)
    }
  }
  const hasVehicle = Boolean(rd.vehNo) || Boolean(rd.trdNo) || Boolean(rd.traId)
  if (!hasVehicle) throw new GspError('Provide a vehicle number, transport document number or transporter ID.')
}

export const mockProvider: EwayBillProvider = {
  id: 'mock',
  name: 'Mock GSP (local simulator)',
  isMock: true,

  async generateEwayBill(submission: EwbSubmission, _config: GspProviderConfig): Promise<EwbResult> {
    validatePayload(submission.payload)
    const rd = submission.payload.requestData as Record<string, unknown>

    const distanceKm = Number(rd.toDst) || 0
    const validityDays = Math.max(1, Math.ceil(distanceKm / 1000))

    const start = new Date()
    const end = new Date(start.getTime() + validityDays * 24 * 60 * 60 * 1000)
    const yyyy = end.getFullYear()
    const mm = String(end.getMonth() + 1).padStart(2, '0')
    const dd = String(end.getDate()).padStart(2, '0')

    // Simulated network latency so the UI loading states behave like production.
    await new Promise(resolve => setTimeout(resolve, 400))

    return {
      providerId: 'mock',
      mock: true,
      ewbNo: randDigits(32),
      validityEndDate: `${yyyy}-${mm}-${dd}`,
      qrCode: `MOCK-EWB|${rd.fromGstin}|${rd.toGstin}|${randDigits(16)}`,
      acknowledgedAt: new Date().toISOString(),
      raw: { message: 'This is a simulated acknowledgement. No e-way bill exists on the government system.' },
    }
  },
}
