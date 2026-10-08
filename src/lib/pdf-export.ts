// Screenshot an on-screen document region into a paginated A4 PDF.
// Used by the invoice and challan detail pages; the capture element is the
// padded wrapper so its padding becomes the white margin in the PDF.

export async function downloadElementAsPdf(elementId: string, filename: string): Promise<void> {
  const { default: jsPDF } = await import('jspdf')
  const { default: html2canvas } = await import('html2canvas')

  const element = document.getElementById(elementId)
  if (!element) return

  const canvas = await html2canvas(element, {
    // 2x gives ~215 DPI at the printed width. Higher scales cost 16x the
    // bytes for no visible gain, and a 36 MB PDF cannot be emailed.
    scale: 2,
    useCORS: true,
    backgroundColor: '#ffffff',
    windowWidth: element.scrollWidth,
    windowHeight: element.scrollHeight,
  })

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  const pageWidth = pdf.internal.pageSize.getWidth()   // 210mm
  const pageHeight = pdf.internal.pageSize.getHeight() // 297mm
  const margin = 15                                    // 15mm on all sides
  const imgWidth = pageWidth - margin * 2              // 180mm usable
  const usableHeight = pageHeight - margin * 2
  const pxPerMm = canvas.width / imgWidth
  const slicePx = Math.floor(pxPerMm * usableHeight)

  // One canvas slice per page: embedding the whole image and clipping it
  // would repeat every byte once per page.
  for (let drawn = 0, page = 0; drawn < canvas.height; drawn += slicePx, page++) {
    const h = Math.min(slicePx, canvas.height - drawn)
    const slice = document.createElement('canvas')
    slice.width = canvas.width
    slice.height = h
    const ctx = slice.getContext('2d')
    if (!ctx) throw new Error('canvas unavailable')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, slice.width, h)
    ctx.drawImage(canvas, 0, drawn, canvas.width, h, 0, 0, canvas.width, h)

    if (page > 0) pdf.addPage()
    pdf.addImage(slice.toDataURL('image/jpeg', 0.94), 'JPEG', margin, margin, imgWidth, h / pxPerMm)
  }

  pdf.save(filename)
}
