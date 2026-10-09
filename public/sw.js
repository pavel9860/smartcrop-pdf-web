// Service worker (spec-web §15). Hand-rolled, no workbox. Online: cache-first for every same-origin
// GET, populated opportunistically as the app requests things. Offline mode (Settings): the build's
// precache.json — every built file — is cached up front and the app then makes no network
// requests at all (below).
//
// Plain JS, not TypeScript: files under public/ are copied verbatim by Vite, not compiled, and a
// service worker needs a stable, un-hashed root-scoped URL (this file, registered as `sw.js`) to
// control the whole origin.

const CACHE_VERSION = 'v1'
const CACHE_NAME = `smartcrop-${CACHE_VERSION}`

// Minimal app-shell paths worth eagerly warming on install, relative to this SW's own scope (the
// deploy root, or a GitHub Pages project-page subpath — self.registration.scope, never a
// hardcoded '/'). Everything else (the hashed JS/CSS bundle, wasm, ONNX models, cmaps, fonts)
// populates the cache the first time the running app actually requests it.
const SHELL_PATHS = ['', 'index.html', 'favicon.svg', 'site.webmanifest', 'manual.pdf']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    const scope = self.registration.scope
    await Promise.all(SHELL_PATHS.map(async (path) => {
      try {
        const res = await fetch(scope + path)
        if (res.ok) await cache.put(scope + path, res)
      } catch {
        // Best-effort — offline-first install (e.g. a flaky connection on first visit) must not
        // block registration; the fetch handler below will retry and cache these on next use.
      }
    }))
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    await self.clients.claim()
  })())
})

// Offline mode (spec-web §15, Settings → "Enable offline mode"): every built file (precache.json,
// written by the build) is cached up front, then the app makes NO network requests — same-origin
// requests are answered from the cache only, everything else (cross-origin, non-GET, analytics
// beacons) gets an empty response. The flag lives in the cache so it survives reloads.
const FLAG = 'offline-mode-flag'
let offline = null   // loaded lazily from the cache

async function is_offline() {
  if (offline === null) offline = !!(await (await caches.open(CACHE_NAME)).match(self.registration.scope + FLAG))
  return offline
}

async function set_offline(on) {
  const cache = await caches.open(CACHE_NAME)
  const scope = self.registration.scope
  if (on) {
    const files = await (await fetch(scope + 'precache.json', { cache: 'no-store' })).json()
    await cache.addAll(files.map((f) => scope + f))
    await cache.put(scope + FLAG, new Response('1'))
  } else {
    await cache.delete(scope + FLAG)
  }
  offline = on
}

self.addEventListener('message', (event) => {
  const port = event.ports[0]
  const { type, on } = event.data ?? {}
  const done = type === 'set-offline' ? set_offline(!!on).then(() => on) : is_offline()
  done.then((state) => port?.postMessage({ ok: true, on: state }), (e) => port?.postMessage({ ok: false, error: String(e) }))
})

const EMPTY = () => new Response(null, { status: 204 })

async function cache_only(req) {
  const cache = await caches.open(CACHE_NAME)
  // ignoreVary: precached entries were fetched without the Origin header module scripts send.
  return (await cache.match(req, { ignoreVary: true })) ??
    (req.mode === 'navigate' ? await cache.match(self.registration.scope + 'index.html') : undefined) ??
    EMPTY()
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  const same_origin = new URL(req.url).origin === self.location.origin
  if (offline === false && (req.method !== 'GET' || !same_origin)) return   // fast path, online
  event.respondWith((async () => {
    if (await is_offline()) return req.method === 'GET' && same_origin ? cache_only(req) : EMPTY()
    if (req.method !== 'GET' || !same_origin) return fetch(req)
    return online(req)
  })())
})

// Online: cache-first for same-origin GETs, populated as the app requests things.
async function online(req) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(req)
  if (cached) return cached
  try {
    const res = await fetch(req)
    // Only cache real, successful, same-origin (non-opaque) responses.
    if (res.ok && res.type === 'basic') cache.put(req, res.clone())
    return res
  } catch (err) {
    // Offline and never cached: for a navigation, fall back to the cached shell so the app
    // still boots to its synthetic-document state; any other asset failure propagates as-is.
    if (req.mode === 'navigate') {
      const shell = await cache.match(self.registration.scope + 'index.html')
      if (shell) return shell
    }
    throw err
  }
}
