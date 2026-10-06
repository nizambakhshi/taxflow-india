// =============================================
// PDF WORKER ASSET
// TaxFlow India — Roadmap #7 (Smart Capture)
// =============================================
//
// pdf.js insists on running inside a Web Worker and needs a URL for it. Serving
// the worker that ships inside the installed pdfjs-dist package keeps the two
// versions locked together (a CDN copy drifts) and keeps bill PDFs readable
// without a third-party host.
//
// The path is fixed — nothing here is derived from the request.
// =============================================

import { readFileSync } from 'fs'
import path from 'path'

let cached: { body: Buffer; mtime: number } | null = null

const WORKER_FILE = path.join(process.cwd(), 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs')

export async function GET() {
  try {
    if (!cached || cached.mtime < Date.now() - 60_000) {
      cached = { body: readFileSync(WORKER_FILE), mtime: Date.now() }
    }
  } catch {
    return Response.json({ error: 'PDF worker asset is not installed.' }, { status: 500 })
  }

  return new Response(new Uint8Array(cached.body), {
    headers: {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=300, must-revalidate',
    },
  })
}
