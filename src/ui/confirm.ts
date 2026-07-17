// Themed confirmation dialog — replaces window.confirm() (L1: a native dialog can't be themed
// and blocks in a way headless/e2e drivers handle awkwardly). Reuses the progress overlay's
// dimmed-backdrop + centred-card styling (overlay.ts/.overlay, .overlay__card) rather than a
// second visual language for "a small modal over the canvas".

import { requireEl } from './dom'

export function confirm_dialog(
  container: HTMLElement, message: string, confirm_label = 'Confirm',
): Promise<boolean> {
  return new Promise(resolve => {
    const el = document.createElement('div')
    el.className = 'overlay'
    el.innerHTML = `
      <div class="overlay__card">
        <div class="overlay__title"></div>
        <div class="confirm-actions">
          <button class="btn btn-secondary" data-act="cancel">Cancel</button>
          <button class="btn btn-danger" data-act="confirm"></button>
        </div>
      </div>`
    requireEl(el, '.overlay__title').textContent = message
    requireEl(el, '[data-act="confirm"]').textContent = confirm_label

    const finish = (result: boolean): void => { el.remove(); resolve(result) }
    requireEl<HTMLButtonElement>(el, '[data-act="cancel"]').addEventListener('click', () => { finish(false) })
    requireEl<HTMLButtonElement>(el, '[data-act="confirm"]').addEventListener('click', () => { finish(true) })

    container.appendChild(el)
  })
}

// Single-button variant for errors and plain notices — replaces the old bottom-center toast
// (every message now goes through a themed window, none silently time out unread). 'error' gets
// the same danger styling as confirm_dialog's destructive action; 'info' is neutral.
export function alert_dialog(
  container: HTMLElement, message: string, variant: 'error' | 'info' = 'error',
): Promise<void> {
  return new Promise(resolve => {
    const el = document.createElement('div')
    el.className = 'overlay'
    el.innerHTML = `
      <div class="overlay__card">
        <div class="overlay__title"></div>
        <div class="confirm-actions">
          <button class="btn ${variant === 'error' ? 'btn-danger' : 'btn-secondary'}" data-act="ok">OK</button>
        </div>
      </div>`
    requireEl(el, '.overlay__title').textContent = message
    requireEl<HTMLButtonElement>(el, '[data-act="ok"]').addEventListener('click', () => { el.remove(); resolve() })
    container.appendChild(el)
  })
}
