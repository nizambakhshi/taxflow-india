// Screenshot an on-screen document region into a paginated A4 PDF.
// Used by the invoice and challan detail pages; the capture element is the
// padded wrapper so its padding becomes the white margin in the PDF.
//
// `downloadElementsAsPdf` is the same machinery over several regions — a payslip pack, one sheet
// per person — where each region must start on a fresh page instead of running into the next.

type JsPdf = import('jspdf').default

/** The one place A4 geometry is stated: 210×297mm with a 15mm margin drawn from the element's own padding. */
const MARGIN_MM = 15

async function canvasOf(element: HTMLElement) {
  const { default: html2canvas } = await import('html2canvas')
  return html2canvas(element, {
    // 2x gives ~215 DPI at the printed width. Higher scales cost 16x the
    // bytes for no visible gain, and a 36 MB PDF cannot be emailed.
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  })
}

/**
 * Slice a canvas across A4 pages and draw it. `freshPage` says the region may not use whatever page
 * the document is sitting on — every region after the first one, and any region taller than a page.
 */
function drawCanvas(pdf: JsPdf, canvas: HTMLCanvasElement, freshPage: boolean): void {
  const pageWidth = pdf.internal.pageSize.getWidth()   // 210mm
  const pageHeight = pdf.internal.pageSize.getHeight() // 297mm
  const imgWidth = pageWidth - MARGIN_MM * 2           // 180mm usable
  const usableHeight = pageHeight - MARGIN_MM * 2
  const pxPerMm = canvas.width / imgWidth
  const slicePx = Math.floor(pxPerMm * usableHeight)

  // One canvas slice per page: embedding the whole image and clipping it
  // would repeat every byte once per page.
  let page = 0
  for (let drawn = 0; drawn < canvas.height; drawn += slicePx, page++) {
    const h = Math.min(slicePx, canvas.height - drawn)
    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = h
    const ctx = slice.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, slice.width, h)
    ctx.drawImage(canvas, 0, drawn, canvas.width, h, 0, 0, canvas.width, h)

    // jsPDF starts with one blank page; every later slice and every later region needs its own.
    if (page > 0 || freshPage) pdf.addPage()
    pdf.addImage(slice.toDataURL('image/jpeg', 0.94), 'JPEG', MARGIN_MM, MARGIN_MM, imgWidth, h / pxPerMm)
  }
}

export async function downloadElementAsPdf(elementId: string, filename: string): Promise<void> {
  const { default: jsPDF } = await import('jspdf')

  const element = document.getElementById(elementId)
  if (!element) return

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  drawCanvas(pdf, await canvasOf(element), false)
  pdf.save(filename)
}

/**
 * Several document regions into one PDF, each starting a new page. Missing elements are skipped
 * rather than failing the whole pack — a slip that has not rendered yet is a reason to press the
 * button again, not to lose the sheets that have.
 */
export async function downloadElementsAsPdf(elementIds: string[], filename: string): Promise<void> {
  const { default: jsPDF } = await import('jspdf')

  const found = elementIds
    .map(id => document.getElementById(id))
    .filter((el): el is HTMLElement => !!el)
  if (!found.length) return

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  for (let i = 0; i < found.length; i++) {
    // The first region takes the page jsPDF opens; the rest each force a new one.
    drawCanvas(pdf, await canvasOf(found[i]), i > 0)
  }
  pdf.save(filename)
}
