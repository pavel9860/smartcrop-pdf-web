import { AppController } from './ui/app'
import type { AppModel } from './core/model'

const root = document.getElementById('app')
if (!root) throw new Error('#app not found')
const app = new AppController(root)

// DEV-only test hook: Playwright (running against `npm run dev`) reads model.view_snapshot() to
// assert canvas coordinate behavior it cannot observe through the DOM. Stripped from prod builds.
if (import.meta.env.DEV) {
  ;(window as unknown as { __model: AppModel }).__model = app.model
}

// Release event listeners/workers before Vite swaps in a fresh module on hot reload — otherwise
// each dev-server edit leaks the previous AppController's window keydown listener and export
// worker (L6).
if (import.meta.hot) {
  import.meta.hot.dispose(() => { app.destroy() })
}
