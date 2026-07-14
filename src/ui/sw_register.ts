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
