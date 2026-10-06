// Barcode helpers for counter billing. Codes are stored on the existing
// products.sku column, so no schema change is needed.

export type BarcodeFormat =
  | 'EAN-13' | 'EAN-8' | 'UPC-A' | 'ITF-14' | 'CODE-128' | 'OTHER' | 'EMPTY'

export interface BarcodeCheck {
  format: BarcodeFormat
  valid: boolean
  message: string
}

// GS1 modulo-10 check digit: weights alternate 3/1 starting at the rightmost
// digit of the body, so one function covers EAN-8, EAN-13, UPC-A and ITF-14.
function checkDigit(body: string): number {
  let sum = 0
  for (let i = 0; i < body.length; i++) {
    const fromRight = body.length - i
    sum += Number(body[i]) * (fromRight % 2 === 1 ? 3 : 1)
  }
  return (10 - (sum % 10)) % 10
}

export function normalizeBarcode(raw: string): string {
  return (raw || '').replace(/[\s\-\u00a0]/g, '').trim()
}

export function detectFormat(code: string): BarcodeFormat {
  const value = normalizeBarcode(code)
  if (!value) return 'EMPTY'
  if (!/^\d+$/.test(value)) return 'CODE-128'
  if (value.length === 13) return 'EAN-13'
  if (value.length === 8) return 'EAN-8'
  if (value.length === 12) return 'UPC-A'
  if (value.length === 14) return 'ITF-14'
  return 'OTHER'
}

// Validates structure and (for GS1 numeric symbologies) the check digit.
export function validateBarcode(code: string): BarcodeCheck {
  const value = normalizeBarcode(code)
  const format = detectFormat(value)

  if (format === 'EMPTY') {
    return { format, valid: false, message: 'Enter or scan a barcode' }
  }
  if (value.length < 3) {
    return { format, valid: false, message: 'Barcode is too short' }
  }
  if (format === 'CODE-128' || format === 'OTHER') {
    return { format, valid: true, message: 'Accepted as an internal code' }
  }

  const expected = checkDigit(value.slice(0, -1))
  if (expected !== Number(value.slice(-1))) {
    return {
      format,
      valid: false,
      message: `${format} check digit is wrong (expected ${expected})`,
    }
  }
  return { format, valid: true, message: `Valid ${format}` }
}

type SkuRow = { id: string; sku?: string | null }

// EAN-13 codes that begin with two zeros are the same article as the 12-digit
// UPC-A code, so compare with leading zeros ignored as well as verbatim.
function variants(value: string): string[] {
  const set = new Set([value, value.replace(/^0+/, '')])
  if (value.length === 12) set.add(`00${value}`)
  if (value.length === 13) set.add(value.replace(/^00/, '0'))
  return Array.from(set).filter(Boolean)
}

export function findProductByBarcode<T extends SkuRow>(products: T[], code: string): T | null {
  const value = normalizeBarcode(code)
  if (!value) return null
  const wanted = variants(value.toLowerCase())

  for (const product of products) {
    const sku = normalizeBarcode(String(product.sku || '')).toLowerCase()
    if (!sku) continue
    if (wanted.includes(sku) || variants(sku).includes(value.toLowerCase())) return product
  }
  return null
}

// Camera decoding needs the BarcodeDetector API, which is unavailable on
// iOS Safari — the UI must always keep manual entry working.
export function cameraScanSupported(): boolean {
  if (typeof window === 'undefined') return false
  return 'BarcodeDetector' in window && !!navigator.mediaDevices?.getUserMedia
}

export type DetectedBarcode = { value: string; format: string }

export interface BarcodeDetectorLike {
  detect: (source: unknown) => Promise<{ rawValue: string; format: string }[]>
}

// Decode one frame from a video element. Resolves with null when nothing was
// detected, and never rejects on a detection miss.
export async function detectFromVideo(
  video: HTMLVideoElement,
  detector: BarcodeDetectorLike
): Promise<DetectedBarcode | null> {
  try {
    const found = await detector.detect(video)
    if (!found.length) return null
    return { value: found[0].rawValue, format: found[0].format }
  } catch {
    return null
  }
}

export function createDetector(): BarcodeDetectorLike | null {
  if (typeof window === 'undefined') return null
  const Ctor = (window as any).BarcodeDetector
  if (!Ctor) return null
  try {
    return new Ctor({
      formats: ['ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'itf', 'qr_code'],
    })
  } catch {
    return new Ctor()
  }
}
