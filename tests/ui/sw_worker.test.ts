// public/sw.js run against a fake ServiceWorkerGlobalScope: offline mode (spec-web §15) caches every
// precache.json entry, then answers everything without a single network request.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const SCOPE = 'https://app.test/'
const PRECACHE = ['', 'index.html', 'assets/app.js', 'models/uvdoc.onnx']

function boot(): {
  fetch_calls: string[]
  fire: (type: string, event: object) => void
  request: (url: string, init?: { method?: string; mode?: string }) => Promise<Response>
  message: (data: object) => Promise<{ ok: boolean; on: boolean }>
} {
  const store = new Map<string, Response>()
  const cache = {
    match: (r: Request | string) => Promise.resolve(store.get(typeof r === 'string' ? r : r.url)?.clone()),
    put: (r: Request | string, res: Response) => { store.set(typeof r === 'string' ? r : r.url, res); return Promise.resolve() },
    delete: (r: string) => Promise.resolve(store.delete(r)),
    addAll: async (urls: string[]) => { for (const u of urls) store.set(u, await fake_fetch(u)) },
  }
  const fetch_calls: string[] = []
  const fake_fetch = vi.fn((input: Request | string): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url
    fetch_calls.push(url)
    return Promise.resolve(url.endsWith('precache.json') ? new Response(JSON.stringify(PRECACHE)) : new Response(`body:${url}`))
  })
  const listeners = new Map<string, (e: object) => void>()
  const self = {
    addEventListener: (t: string, f: (e: object) => void) => { listeners.set(t, f) },
    registration: { scope: SCOPE }, location: { origin: 'https://app.test' },
    skipWaiting: () => undefined, clients: { claim: () => Promise.resolve() },
  }
  const caches = { open: () => Promise.resolve(cache), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) }
  new Function('self', 'caches', 'fetch', readFileSync('public/sw.js', 'utf8'))(self, caches, fake_fetch)

  const fire = (type: string, event: object): void => { listeners.get(type)!(event) }
  const request = (url: string, init: { method?: string; mode?: string } = {}): Promise<Response> => new Promise((resolve, reject) => {
    const req = { url, method: init.method ?? 'GET', mode: init.mode ?? 'cors' } as unknown as Request
    let responded = false
    fire('fetch', { request: req, respondWith: (p: Promise<Response>) => { responded = true; p.then(resolve, reject) } })
    if (!responded) resolve(fake_fetch(req))   // not intercepted: the browser goes to the network
  })
  const message = (data: object): Promise<{ ok: boolean; on: boolean }> => new Promise(resolve => {
    fire('message', { data, ports: [{ postMessage: resolve }] })
  })
  return { fetch_calls, fire, request, message }
}

describe('public/sw.js offline mode', () => {
  it('is off by default; turning it on caches every precache.json file and persists the flag', async () => {
    const sw = boot()
    await expect(sw.message({ type: 'get-offline' })).resolves.toEqual({ ok: true, on: false })
    await expect(sw.message({ type: 'set-offline', on: true })).resolves.toEqual({ ok: true, on: true })
    expect(sw.fetch_calls).toEqual([SCOPE + 'precache.json', ...PRECACHE.map(f => SCOPE + f)])
    await expect(sw.message({ type: 'get-offline' })).resolves.toEqual({ ok: true, on: true })
  })

  it('while on, makes no network request at all — cached files, empty answers for everything else', async () => {
    const sw = boot()
    await sw.message({ type: 'set-offline', on: true })
    sw.fetch_calls.length = 0
    expect(await (await sw.request(SCOPE + 'assets/app.js')).text()).toBe(`body:${SCOPE}assets/app.js`)
    expect((await sw.request(SCOPE + 'never-built.js')).status).toBe(204)
    expect((await sw.request('https://static.cloudflareinsights.com/beacon.min.js')).status).toBe(204)
    expect((await sw.request(SCOPE + 'cdn-cgi/rum', { method: 'POST' })).status).toBe(204)
    expect(await (await sw.request(SCOPE + 'some/route', { mode: 'navigate' })).text()).toBe(`body:${SCOPE}index.html`)
    expect(sw.fetch_calls).toEqual([])
  })

  it('turned off again, requests reach the network as before', async () => {
    const sw = boot()
    await sw.message({ type: 'set-offline', on: true })
    await expect(sw.message({ type: 'set-offline', on: false })).resolves.toEqual({ ok: true, on: false })
    sw.fetch_calls.length = 0
    await sw.request(SCOPE + 'never-built.js')
    await sw.request('https://static.cloudflareinsights.com/beacon.min.js')
    expect(sw.fetch_calls).toEqual([SCOPE + 'never-built.js', 'https://static.cloudflareinsights.com/beacon.min.js'])
  })
})
