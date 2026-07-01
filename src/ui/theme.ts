// CSS custom-property injection for dark/light/system themes (spec §19).
// Warm-gray chrome + clear blue accent — same palette as the desktop app.

import type { Theme } from './constants'

const DARK: Record<string, string> = {
  '--bg-app':       '#161616',
  '--bg-chrome':    '#1e1e1e',
  '--bg-card':      '#272727',
  '--bg-input':     '#2e2e2e',
  '--bg-hover':     '#333333',
  '--bg-canvas':    '#121212',
  '--text-primary': '#e2e2e2',
  '--text-dim':     '#888888',
  '--text-label':   '#bbbbbb',
  '--accent':       '#3a8ef5',
  '--accent-dim':   '#1a5fbb',
  '--crop-blue':    '#4a9eff',
  '--split-blue':   '#2a7edb',
  '--handle-fill':  '#ffffff',
  '--border':       '#383838',
  '--border-card':  '#303030',
  '--danger':       '#e05555',
  '--success':      '#4caf50',
}

const LIGHT: Record<string, string> = {
  '--bg-app':       '#e8e8e8',
  '--bg-chrome':    '#f0efed',
  '--bg-card':      '#ffffff',
  '--bg-input':     '#f5f5f5',
  '--bg-hover':     '#ebebeb',
  '--bg-canvas':    '#d8d8d8',
  '--text-primary': '#1a1a1a',
  '--text-dim':     '#666666',
  '--text-label':   '#444444',
  '--accent':       '#1a6fd4',
  '--accent-dim':   '#0f4fa0',
  '--crop-blue':    '#1a6fd4',
  '--split-blue':   '#0f4fa0',
  '--handle-fill':  '#1a6fd4',
  '--border':       '#d0d0d0',
  '--border-card':  '#e0e0e0',
  '--danger':       '#c0392b',
  '--success':      '#2e7d32',
}

let _current_theme: Theme = 'dark'
let _media_query: MediaQueryList | null = null

export function apply_theme(theme: Theme): void {
  _current_theme = theme
  if (_media_query) {
    _media_query.removeEventListener('change', _on_system_change)
    _media_query = null
  }

  if (theme === 'system') {
    _media_query = window.matchMedia('(prefers-color-scheme: dark)')
    _media_query.addEventListener('change', _on_system_change)
    _apply_tokens(_media_query.matches ? DARK : LIGHT)
    document.documentElement.dataset['theme'] = _media_query.matches ? 'dark' : 'light'
  } else {
    _apply_tokens(theme === 'dark' ? DARK : LIGHT)
    document.documentElement.dataset['theme'] = theme
  }
}

function _on_system_change(ev: MediaQueryListEvent): void {
  _apply_tokens(ev.matches ? DARK : LIGHT)
  document.documentElement.dataset['theme'] = ev.matches ? 'dark' : 'light'
}

function _apply_tokens(tokens: Record<string, string>): void {
  const root = document.documentElement
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v)
}

export function current_theme(): Theme { return _current_theme }
