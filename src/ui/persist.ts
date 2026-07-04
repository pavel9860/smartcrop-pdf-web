// localStorage persistence of output-quality settings (spec-web §W2 row 6 area / §W3): compress
// DPI (incl. Custom), colour, and export format survive both new-document loads and browser
// sessions. Lives in ui/ so core/ stays storage-free (ARCHITECTURE §10 — no window in core/).

const KEY = 'scw.output.v1'

export interface OutputPrefs {
  compress_preset: string
  custom_dpi:      number
  output_colours:  string
  export_format:   string
}

// Returns a partial so a schema change or a corrupt/absent entry degrades to defaults, never throws.
export function load_output_prefs(): Partial<OutputPrefs> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return (typeof parsed === 'object' && parsed !== null) ? parsed : {}
  } catch {
    return {}   // private-mode / disabled storage / malformed JSON — non-fatal
  }
}

export function save_output_prefs(prefs: OutputPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* storage denied or over quota — persistence is best-effort, never blocks the app */
  }
}
