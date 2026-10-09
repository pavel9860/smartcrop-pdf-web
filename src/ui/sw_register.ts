import { ensure_cv } from '@pdf/cv'
import { ensure_dbnet } from '@pdf/dbnet'

// Offline auto-precache registration (T7) — registers public/sw.js. Guarded: does nothing when
// serviceWorker is unsupported, and does nothing outside a production build (a dev-server SW
// would intercept fetches and serve stale bundles instead of Vite's HMR updates). env/sw are
// injectable so this is testable without stubbing import.meta.env or the navigator global.
export function register_service_worker(
  env: { prod: boolean; base_url: string } = { prod: import.meta.env.PROD, base_url: import.meta.env.BASE_URL },
  // The DOM lib types navigator.serviceWorker as always-present (unmodeled feature detection) —
  // the explicit 'serviceWorker' in navigator check is what actually makes this nullable, for
  // browsers/contexts genuinely lacking the API.
  sw: Pick<ServiceWorkerContainer, 'register'> | null =
    ('serviceWorker' in navigator) ? navigator.serviceWorker : null,
): void {
  if (!env.prod || !sw) return
  void sw.register(`${env.base_url}sw.js`).catch(() => {
    // Offline support is a progressive enhancement — a failed registration must never break boot.
  })
}

// A SCANNED document is open (spec-web §4.3): load the image engine, the ONNX runtime and the
// text-line model in the background so the first scan action doesn't wait for them. Idempotent;
// resolves false on failure, which is left for the real call to report.
export function prefetch_scan_tools(): Promise<boolean> {
  return ensure_cv().then(ensure_dbnet).then(() => true, () => false)
}

// Settings → "Enable offline mode" (spec-web §15), owned by public/sw.js: turning it on caches every
// built file, then the app makes no network requests until it's turned off. Resolves with the
// worker's resulting state; `ok: false` when no service worker is active (dev, unsupported) or the
// download failed.
export interface OfflineState { readonly ok: boolean; readonly on: boolean; readonly error?: string }

type SwContainer = Pick<ServiceWorkerContainer, 'getRegistration'> | null
const sw_container = (): SwContainer => ('serviceWorker' in navigator) ? navigator.serviceWorker : null

async function ask(message: { type: 'set-offline' | 'get-offline'; on?: boolean }, sw: SwContainer): Promise<OfflineState> {
  const worker = (await sw?.getRegistration())?.active
  if (!worker) return { ok: false, on: false, error: 'Offline mode needs the installed app (no service worker is running).' }
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (e: MessageEvent<OfflineState>): void => { resolve(e.data) }
    worker.postMessage(message, [channel.port2])
  })
}

export const set_offline_mode = (on: boolean, sw = sw_container()): Promise<OfflineState> => ask({ type: 'set-offline', on }, sw)
export const get_offline_mode = (sw = sw_container()): Promise<OfflineState> => ask({ type: 'get-offline' }, sw)
