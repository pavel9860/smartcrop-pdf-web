// CSS custom-property injection for dark/light/system themes (spec §19).
// Warm-gray chrome + clear blue accent — same palette as the desktop app.

import type { Theme } from './constants'

// Palette mapped verbatim from the desktop app's ui/constants.py THEMES (light, dark) tuples +
// panels.py badge colours — warm-gray chrome, blue accent in dark / near-black accent in light.
// Keep these in sync with the desktop repo; it is the design source of truth.
const DARK: Record<string, string> = {
  '--bg-app':       '#1e1d1b',
  '--bg-chrome':    '#1e1d1b',
  '--bg-card':      '#262522',
  '--bg-input':     '#2e2d29',
  '--bg-hover':     '#423f39',
  '--bg-canvas':    '#171614',
  '--text-primary': '#f1efe9',
  '--text-dim':     '#a8a69e',
  '--text-label':   '#c9c7bf',
  '--accent':       '#3b82e0',
  '--accent-dim':   '#2a5fa8',
  '--accent-h':     '#5295e8',
  '--crop-blue':    '#224d87',
  '--split-blue':   '#224d87',
  '--handle-fill':  '#ffffff',
  '--border':       '#3a3833',
  '--border-card':  '#3a3833',
  '--danger':       '#e05555',
  '--success':      '#4caf50',
  '--text-inv':     '#ffffff',
  '--badge-nor':    '#1f5c3a',
  '--badge-sca':    '#7a3f10',
  '--btn-bg':       '#36352f',
  '--btn-bg-hover': '#423f39',
  '--seg-unsel':    '#46443e',
}

const LIGHT: Record<string, string> = {
  '--bg-app':       '#edebe5',
  '--bg-chrome':    '#edebe5',
  '--bg-card':      '#fbfaf6',
  '--bg-input':     '#ffffff',
  '--bg-hover':     '#e6e3db',
  '--bg-canvas':    '#d9d7d0',
  '--text-primary': '#2a2a26',
  '--text-dim':     '#74726b',
  '--text-label':   '#4a4842',
  '--accent':       '#1a1a1c',
  '--accent-dim':   '#000000',
  '--accent-h':     '#2f2f33',
  '--crop-blue':    '#224d87',
  '--split-blue':   '#224d87',
  '--handle-fill':  '#224d87',
  '--border':       '#e6e3da',
  '--border-card':  '#e6e3da',
  '--danger':       '#c0392b',
  '--success':      '#2e7d32',
  '--text-inv':     '#ffffff',
  '--badge-nor':    '#2d6e4e',
  '--badge-sca':    '#7a4d1d',
  '--btn-bg':       '#f1efe9',
  '--btn-bg-hover': '#e6e3db',
  '--seg-unsel':    '#6e6b64',
}

let _media_query: MediaQueryList | null = null

export function apply_theme(theme: Theme): void {
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
