// UI-only tunables — presentation layer only; no domain computation reads these.

export const PANEL_WIDTH        = 320    // px — left sidebar
export const DETAIL_PANEL_WIDTH = 380    // px — settings/help panel
export const CANVAS_MIN_WIDTH   = 400    // px — canvas never shrinks below this
export const STATUS_IDLE_MS     = 2400   // ms — status text auto-clear delay
export const SCALE_THROTTLE_MS  = 80     // ms — canvas resize debounce
export const FONT_SIZE_MIN      = 10
export const FONT_SIZE_MAX      = 24
export const FONT_SIZE_DEFAULT  = 15
export const UI_SCALE_MIN       = 0.7
export const UI_SCALE_MAX       = 2.0

// Canvas overlay drawing (canvas_view.ts) — spec §6, §19
export const OVERLAY_DASH: readonly [number, number] = [6, 4]
export const OVERLAY_LINE_WIDTH_SPLIT = 1.75  // crop/split frame ~30% thinner (bug 28)
export const OVERLAY_LINE_WIDTH_CROP  = 1.05
export const HANDLE_LINE_WIDTH        = 1.5
export const SPLIT_BADGE_FONT_SCALE   = 0.9   // split index ~30% smaller (bug 13)
export const SPLIT_BADGE_RADIUS_SCALE = 1.1   // circle is a contour around the number
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
