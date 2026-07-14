// Offline auto-precache service worker (spec-web offline support). Hand-rolled — no
// vite-plugin-pwa/workbox dependency: the app JS/CSS bundle's filenames are content-hashed by
// Vite at build time, so there is no static list to precache ahead of a build without adding a
// manifest-generation plugin. Instead: cache-first for every same-origin GET, populated
// opportunistically as the app actually requests things. A normal boot plus one scanned-mode run
// pulls the app shell, OpenCV wasm, ONNX models, pdf.js worker/cmaps/fonts and icons through the
// fetch handler below at least once, which is what "works offline after one online load" needs —
// this repo doesn't lazy-load anything a real session wouldn't already touch. No COOP/COEP
// requirement, no SharedArrayBuffer — this file uses neither.
//
// Plain JS, not TypeScript: files under public/ are copied verbatim by Vite, not compiled, and a
// service worker needs a stable, un-hashed root-scoped URL (this file, registered as `sw.js`) to
// control the whole origin — bundling it through the app's normal TS build would both hash its
// filename and pull in the wrong module graph for a worker with no window/DOM.

const CACHE_VERSION = 'v1'
const CACHE_NAME = `smartcrop-${CACHE_VERSION}`

// Minimal app-shell paths worth eagerly warming on install, relative to this SW's own scope (the
// deploy root, or a GitHub Pages project-page subpath — self.registration.scope, never a
// hardcoded '/'). Everything else (the hashed JS/CSS bundle, wasm, ONNX models, cmaps, fonts)
// populates the cache the first time the running app actually requests it.
const SHELL_PATHS = ['', 'index.html', 'favicon.svg', 'site.webmanifest']

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

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  if (new URL(req.url).origin !== self.location.origin) return   // never cache cross-origin requests

  event.respondWith((async () => {
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
  })())
})
