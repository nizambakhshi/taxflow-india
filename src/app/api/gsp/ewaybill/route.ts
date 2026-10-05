import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getProvider } from '@/lib/gsp'
import { GspError } from '@/lib/gsp/types'

async function authenticate(request: NextRequest): Promise<boolean> {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  if (!token) return false

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )
  const { data, error } = await supabase.auth.getUser(token)
  return !error && Boolean(data.user)
}

export async function POST(request: NextRequest) {
  if (!(await authenticate(request))) {
    return Response.json({ error: 'Sign in required.' }, { status: 401 })
  }

  let body: { providerId?: string; payload?: Record<string, unknown> }
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const provider = getProvider(body.providerId || 'mock')
  if (!provider) {
    return Response.json({ error: `Unknown GSP provider "${body.providerId}".` }, { status: 400 })
  }
  if (!body.payload) {
    return Response.json({ error: 'Missing e-way bill payload.' }, { status: 400 })
  }

  try {
    // Real providers will read their credentials from server env / a future
    // org-level secrets table — never from the browser request body.
    const result = await provider.generateEwayBill(
      { payload: body.payload },
      { apiKey: process.env.GSP_API_KEY, authCode: process.env.GSP_AUTH_CODE }
    )
    return Response.json({ result })
  } catch (err) {
    if (err instanceof GspError) {
      return Response.json({ error: err.message }, { status: err.status })
    }
    console.error('GSP submission failed', err)
    return Response.json({ error: 'GSP submission failed. Try again.' }, { status: 502 })
  }
}

export async function GET() {
  const { listProviders } = await import('@/lib/gsp')
  return Response.json({ providers: listProviders() })
}
