import { ensure_cv } from '@pdf/cv'
import { ensure_onnx } from '@pdf/dewarp'
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

// Settings → "Enable offline mode" (off by default, spec-web §16a). The SW above passively caches
// whatever a session actually uses; OpenCV wasm, the ONNX dewarp models, and the §7.1b text-line
// detection model otherwise only get cached the first time SCANNED-mode processing runs online.
// This runs those same real init paths once so every feature — not just whichever were already
// used — works offline after.
// A SCANNED document is open (spec-web §4.3): load the image engine, the ONNX runtime and the
// text-line model in the background so the first scan action doesn't wait for them. Idempotent;
// resolves false on failure, which is left for the real call to report.
export function prefetch_scan_tools(): Promise<boolean> {
  return ensure_cv().then(ensure_dbnet).then(() => true, () => false)
}

export async function warm_offline_cache(): Promise<void> {
  await Promise.all([ensure_cv(), ensure_onnx(), ensure_dbnet()])
}
