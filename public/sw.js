/* TaxFlow India service worker.
 * Strategy:
 *  - Navigations: network-first, successful pages cached; offline falls back to
 *    the last cached copy of that page, then to /offline.html.
 *  - Hashed build assets & icons: cache-first (immutable).
 *  - Anything with a query string, /api/, auth routes, or cross-origin
 *    (Supabase) requests: never cached — data must always be live.
 * Self-update: bump CACHE_VERSION when shell behavior changes.
 */

const CACHE_VERSION = 'taxflow-v1'
const SHELL_URL = '/offline.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.add(SHELL_URL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function isStaticAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js'))
  )
}

function skipCache(url) {
  return (
    url.search !== '' || // dev/query-string resources must stay live
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname === '/login' ||
    url.pathname === '/signup'
  )
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Supabase etc. — passthrough

  // Hashed immutable build assets: cache-first.
  if (isStaticAsset(url) && !skipCache(url)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone()
              caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
            }
            return res
          })
      )
    )
    return
  }

  // Page navigations: network-first with offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() =>
          caches.match(req).then(
            (hit) => hit || caches.match(SHELL_URL).then((shell) => shell || Response.error())
          )
        )
    )
  }
})
