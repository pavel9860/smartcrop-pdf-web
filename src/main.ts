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
