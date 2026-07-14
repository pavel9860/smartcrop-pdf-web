// UI-only tunables — presentation layer only; no domain computation reads these.
// Sidebar/detail-panel widths and the canvas' minimum width are pure CSS layout concerns and
// live in app.css (--sidebar-w, --detail-w, .canvas-area min-width) — not duplicated here, since
// nothing in TS ever reads them (M7: PANEL_WIDTH/DETAIL_PANEL_WIDTH/CANVAS_MIN_WIDTH were unused
// and PANEL_WIDTH had drifted from the real CSS value).

export const SCALE_THROTTLE_MS  = 80     // ms — canvas resize debounce (canvas_view.ts._resize)
export const FONT_SIZE_MIN      = 8
export const FONT_SIZE_MAX      = 25
export const FONT_SIZE_DEFAULT  = 15
// Discrete font-size choices offered in Settings
export const FONT_SIZE_PRESETS: readonly number[] = [8, 10, 12, 15, 18, 22, 25]
export const UI_SCALE_MIN       = 0.7
export const UI_SCALE_MAX       = 2.0
// UI-scale dropdown presets
export const ZOOM_PRESETS: readonly number[] = [0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 2.0]

// Canvas overlay drawing (canvas_view.ts) — spec §6, §19
export const OVERLAY_DASH: readonly [number, number] = [6, 4]
export const OVERLAY_LINE_WIDTH_SPLIT = 1.75  // crop/split frame ~30% thinner (bug 28)
export const OVERLAY_LINE_WIDTH_CROP  = 1.05
export const HANDLE_LINE_WIDTH        = 1.5
export const SPLIT_BADGE_FONT_SCALE   = 0.9   // split index ~30% smaller (bug 13)
export const SPLIT_BADGE_RADIUS_SCALE = 0.8   // contour circle ~30% smaller around the number
export const RUBBER_BAND_DASH: readonly [number, number] = [4, 3]
export const RUBBER_BAND_LINE_WIDTH   = 1
export const STATUS_FONT_SIZE         = 13
export const STATUS_SHADOW_BLUR       = 4
export const STATUS_TEXT_OFFSET_X     = 8
export const STATUS_TEXT_OFFSET_Y     = 18
export const LOADING_FONT_SIZE        = 16

// Detail panel content types
export type DetailPanel = 'settings' | 'help' | null

// Theme names
export const THEMES = ['dark', 'light', 'system'] as const
export type Theme = typeof THEMES[number]
