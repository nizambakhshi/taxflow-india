// =============================================
// DOCUMENT TEXT ACQUISITION
// TaxFlow India — Roadmap #7 (Smart Capture)
// =============================================
//
// Two ways to get text out of a supplier's bill, both inside the browser:
//   • image (phone photo / screenshot) → tesseract.js WASM OCR
//   • PDF                              → pdf.js text layer, laid back out into
//                                        rows and columns by glyph position
//
// Both libraries are loaded with a dynamic import so they stay out of the
// initial bundle until somebody actually scans a bill. bill-text.ts does the
// understanding; this file only produces text.
// =============================================

export type OcrStage = 'loading-engine' | 'downloading-language' | 'recognising' | 'reading-pdf' | 'done'

export type OcrProgress = { stage: OcrStage; progress: number; message: string }

export class ScanOnlyPdfError extends Error {
  constructor() {
    super('This PDF has no text layer — it is a picture of a bill.')
    this.name = 'ScanOnlyPdfError'
  }
}

/**
 * OCR a bill photo. `langs` is a tesseract language string such as 'eng' or
 * 'eng+hin' for regional bills.
 */
export async function ocrImage(
  image: File | Blob | string,
  options: { langs?: string; onProgress?: (p: OcrProgress) => void } = {}
): Promise<string> {
  const { createWorker } = await import('tesseract.js')
  const onProgress = options.onProgress

  onProgress?.({ stage: 'loading-engine', progress: 0.05, message: 'Loading the OCR engine…' })

  const worker = await createWorker(options.langs || 'eng', 1, {
    logger: (m: { status?: string; progress?: number; error?: string }) => {
      if (!onProgress) return
      const status = String(m.status || '')
      const progress = typeof m.progress === 'number' ? m.progress : 0
      if (/initializ|load/i.test(status) && progress < 1) {
        onProgress({ stage: 'loading-engine', progress, message: 'Starting the OCR engine…' })
      } else if (/download|lang/i.test(status)) {
        onProgress({ stage: 'downloading-language', progress, message: 'Fetching the recognition model…' })
      } else {
        onProgress({ stage: 'recognising', progress, message: `Reading the bill — ${Math.round(progress * 100)}%` })
      }
    },
  })

  try {
    onProgress?.({ stage: 'recognising', progress: 0, message: 'Reading the bill…' })
    const { data } = await worker.recognize(image)
    onProgress?.({ stage: 'done', progress: 1, message: 'Done' })
    return data.text || ''
  } finally {
    await worker.terminate()
  }
}

type TextGlyph = { str: string; transform: number[]; width: number; height?: number; hasEOL?: boolean }

/**
 * pdf.js hands back positioned glyphs, not lines. Rebuild rows by baseline and
 * order them left to right, using the horizontal gap between glyphs to decide
 * whether a space belongs there — otherwise a figure split across two runs
 * arrives as "1,23, 456.00" and stops parsing as a number.
 */
export function glyphsToText(items: TextGlyph[]): string {
  type Row = { y: number; parts: { x: number; end: number; str: string }[] }
  const rows: Row[] = []

  for (const item of items) {
    const y = item.transform[5]
    const x = item.transform[4]
    let row = rows.find(r => Math.abs(r.y - y) <= 2.5)
    if (!row) {
      row = { y, parts: [] }
      rows.push(row)
    }
    if (item.str) row.parts.push({ x, end: x + (item.width || 0), str: item.str })
  }

  rows.sort((a, b) => b.y - a.y)

  return rows
    .map(row => {
      row.parts.sort((a, b) => a.x - b.x)
      let line = ''
      let prevEnd: number | null = null
      for (const part of row.parts) {
        const gap = prevEnd === null ? 0 : part.x - prevEnd
        const tight = /[\d,.$]/.test(part.str.slice(0, 1)) && /[\d,.]$/.test(line)
        line += prevEnd !== null && !(tight && gap < 1.6) ? ' ' : ''
        line += part.str
        prevEnd = part.end
      }
      return line.replace(/\s{2,}/g, ' ').trim()
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Text layer of a PDF, first page first. Scanned PDFs carry no text at all, so
 * callers get a typed error and can ask for the photo instead of silently
 * producing an empty draft.
 */
export async function extractPdfText(
  pdf: File | ArrayBuffer,
  options: { onProgress?: (p: OcrProgress) => void } = {}
): Promise<string> {
  const pdfjs = await import('pdfjs-dist')
  const onProgress = options.onProgress

  pdfjs.GlobalWorkerOptions.workerSrc = '/api/pdf-worker'

  const data = pdf instanceof File ? new Uint8Array(await pdf.arrayBuffer()) : new Uint8Array(pdf)
  const loadingTask = pdfjs.getDocument({ data })
  const doc = await loadingTask.promise

  const out: string[] = []
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
    const page = await doc.getPage(pageNo)
    const content = await page.getTextContent()
    out.push(glyphsToText(content.items as TextGlyph[]))
    onProgress?.({
      stage: 'reading-pdf',
      progress: pageNo / doc.numPages,
      message: `Reading page ${pageNo} of ${doc.numPages}…`,
    })
    if (pageNo >= 4) break // a bill is one page; the rest is usually a statement
  }
  await loadingTask.destroy()

  const text = out.join('\n').replace(/\n{2,}/g, '\n').trim()
  if (text.length < 40) throw new ScanOnlyPdfError()
  onProgress?.({ stage: 'done', progress: 1, message: 'Done' })
  return text
}

/** True when the file is a PDF rather than an image. */
export function isPdf(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name)
}

/**
 * Read the bill, whichever form it arrived in.
 */
export async function acquireBillText(
  file: File,
  options: { langs?: string; onProgress?: (p: OcrProgress) => void } = {}
): Promise<{ text: string; sourceType: 'image-ocr' | 'pdf-text' }> {
  if (isPdf(file)) {
    return { text: await extractPdfText(file, options), sourceType: 'pdf-text' }
  }
  return { text: await ocrImage(file, options), sourceType: 'image-ocr' }
}
