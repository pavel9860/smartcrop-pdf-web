// canvas_view.ts — page canvas: paint from ViewSnapshot + pointer events → model gestures.
// Spec-web §2, §6.3, §6.6, §18. No status text on the canvas (spec-web §3); the only overlay
// text is the bottom-right cursor read-out.

import type { AppModel, ViewSnapshot, OverlayBox } from '@core/model'
import type { Box } from '@core/geometry'
import { CANVAS_MARGIN, HANDLE_R, HANDLE_SLACK, SYNTH_W, SYNTH_H } from '@core/constants'
import {
  OVERLAY_DASH, OVERLAY_LINE_WIDTH_SPLIT, OVERLAY_LINE_WIDTH_CROP, HANDLE_LINE_WIDTH,
  SPLIT_BADGE_FONT_SCALE, SPLIT_BADGE_RADIUS_SCALE, RUBBER_BAND_DASH, RUBBER_BAND_LINE_WIDTH,
  LOADING_FONT_SIZE, SCALE_THROTTLE_MS,
} from './constants'

// Canvas 2D fillStyle/strokeStyle/font do NOT resolve CSS var() — no cascade context.
// Resolved once per paint() via getComputedStyle and cached here.
interface ThemeColors {
  bg: string; crop: string; split: string; handle: string; text_dim: string; font: string
}

export class CanvasView {
  readonly el: HTMLCanvasElement
  private _ctx: CanvasRenderingContext2D
  private _model: AppModel
  private _dragging = false
  private _scale = 1
  private _img_x = 0
  private _img_y = 0
  // Full-page-unit origin of the shown image. {0,0} on a full page; the committed box's top-left on
  // a committed (cropped) page, so pointer input and painted overlays map into the zoomed cropped
  // view: canvas = _img + (page − crop_origin)·scale (spec-web §6.8).
  private _crop_origin = { x: 0, y: 0 }
  private _page_w = SYNTH_W
  private _page_h = SYNTH_H
  private readonly _coords_el: HTMLDivElement
  private readonly _arrow_prev: HTMLButtonElement
  private readonly _arrow_next: HTMLButtonElement
  private _ro: ResizeObserver
  private _resize_timer: ReturnType<typeof setTimeout> | null = null
  private _theme: ThemeColors = {
    bg: '#121212', crop: '#4a9eff', split: '#2a7edb',
    handle: '#ffffff', text_dim: '#888888', font: 'sans-serif',
  }

  constructor(model: AppModel) {
    this._model = model
    this.el = document.createElement('canvas')
    this.el.className = 'page-canvas'
    const ctx = this.el.getContext('2d')
    if (!ctx) throw new Error('2d context unavailable')
    this._ctx = ctx

    this._coords_el = document.createElement('div')
    this._coords_el.className = 'canvas-coords'

    // Hover ◀/▶ nav arrows on the canvas edge midpoints.
    this._arrow_prev = this._make_arrow('◀', 'canvas-nav--left',
      () => { this._model.prev_page(); this._notify() })
    this._arrow_next = this._make_arrow('▶', 'canvas-nav--right',
      () => { this._model.next_page(); this._notify() })

    // Pointer events → page-unit coordinates → model gestures
    this.el.addEventListener('pointerdown', this._on_down)
    this.el.addEventListener('pointermove', this._on_move)
    this.el.addEventListener('pointerup',   this._on_up)
    this.el.addEventListener('pointerleave', () => { this._coords_el.textContent = '' })
    this.el.addEventListener('contextmenu', e => { e.preventDefault(); this._cancel() })
    this.el.addEventListener('wheel', this._on_wheel, { passive: true })
    window.addEventListener('keydown', this._on_key)

    // Debounced: a live window/panel drag-resize can fire ResizeObserver many times a second,
    // and each firing may now trigger a display-DPI re-render (spec-web §2) — not just a repaint.
    this._ro = new ResizeObserver(() => {
      if (this._resize_timer !== null) clearTimeout(this._resize_timer)
      this._resize_timer = setTimeout(() => { this._resize_timer = null; this._resize() }, SCALE_THROTTLE_MS)
    })
    this._ro.observe(this.el)
  }

  paint(snap: ViewSnapshot): void {
    const { el, _ctx: ctx } = this
    // Size the backing store in PHYSICAL pixels (× devicePixelRatio) so the page raster and the
    // crop overlay are sharp on HiDPI/scaled displays — the canvas was rendering at CSS resolution
    // (half-res on a 2× screen), which made text look blurry. All drawing
    // below stays in CSS-pixel units; the transform maps them to the physical backing store.
    const dpr = window.devicePixelRatio || 1
    const cw = el.clientWidth, ch = el.clientHeight
    const bw = Math.max(1, Math.round(cw * dpr)), bh = Math.max(1, Math.round(ch * dpr))
    if (el.width !== bw || el.height !== bh) { el.width = bw; el.height = bh }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    this._read_theme()

    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = this._theme.bg
    ctx.fillRect(0, 0, cw, ch)

    // Attach DOM overlays (coords/nav arrows) once the canvas is in the tree. There is no
    // page/size status element (spec-web §3).
    const parent = this.el.parentElement
    if (parent && this._coords_el.parentElement === null) {
      parent.appendChild(this._coords_el)
      parent.appendChild(this._arrow_prev)
      parent.appendChild(this._arrow_next)
    }

    if (!snap.image) {
      if (snap.is_loading) this._draw_loading(ctx, cw, ch)
      return
    }

    this._page_w = snap.page_w
    this._page_h = snap.page_h

    // Fit page to canvas
    const scale = this._fit_scale(cw, ch, snap.page_w, snap.page_h)
    this._scale = scale
    this._crop_origin = snap.crop_origin
    this._img_x = (cw - snap.page_w * scale) / 2
    this._img_y = (ch - snap.page_h * scale) / 2

    // Draw page image
    ctx.drawImage(snap.image,
      this._img_x, this._img_y,
      snap.page_w * scale, snap.page_h * scale)

    // Overlay crop frames
    for (const box of snap.overlay) this._draw_overlay_box(ctx, box, scale)
    if (snap.draw_rect) this._draw_rubber_band(ctx, snap.draw_rect, scale)

    // Nothing is painted on the page image; cursor coordinates show in the
    // bottom-right DOM overlay. No page/size status element (spec-web §3).
    this._arrow_prev.disabled = snap.position <= 1
    this._arrow_next.disabled = snap.position >= snap.total
  }

  private _fit_scale(cw: number, ch: number, page_w: number, page_h: number): number {
    return Math.min(
      (cw - CANVAS_MARGIN * 2) / page_w,
      (ch - CANVAS_MARGIN * 2) / page_h,
    )
  }

  private _make_arrow(label: string, side: string, on_click: () => void): HTMLButtonElement {
    const b = document.createElement('button')
    b.className = `canvas-nav ${side}`
    b.textContent = label
    b.setAttribute('aria-label', label === '◀' ? 'Previous page' : 'Next page')
    b.addEventListener('click', on_click)
    return b
  }

  private _draw_overlay_box(
    ctx: CanvasRenderingContext2D,
    item: OverlayBox,
    scale: number,
  ): void {
    const ox = this._crop_origin.x, oy = this._crop_origin.y
    const x0 = this._img_x + (item.box.x0 - ox) * scale
    const y0 = this._img_y + (item.box.y0 - oy) * scale
    const x1 = this._img_x + (item.box.x1 - ox) * scale
    const y1 = this._img_y + (item.box.y1 - oy) * scale
    const w  = x1 - x0, h = y1 - y0

    const color = item.kind === 'split' ? this._theme.split : this._theme.crop
    ctx.save()
    ctx.strokeStyle = color
    ctx.lineWidth   = item.kind === 'split' ? OVERLAY_LINE_WIDTH_SPLIT : OVERLAY_LINE_WIDTH_CROP
    ctx.setLineDash([...OVERLAY_DASH])
    ctx.strokeRect(x0, y0, w, h)
    ctx.setLineDash([])

    // Handles: diamonds at corners + midpoints
    const handles: [number, number][] = [
      [x0, y0], [x1, y0], [x0, y1], [x1, y1],
      [(x0 + x1) / 2, y0], [(x0 + x1) / 2, y1],
      [x0, (y0 + y1) / 2], [x1, (y0 + y1) / 2],
    ]
    // Solid-colour square handles at corners + side centres, ~20% smaller (bugs 1, 14).
    ctx.fillStyle = color
    for (const [hx, hy] of handles) {
      const r = HANDLE_R * 0.8
      ctx.fillRect(hx - r, hy - r, r * 2, r * 2)
    }

    // Split badge: index number inside a thin CONTOUR circle (not a solid disc), ~30% smaller
    // than before (bug 13). Number is drawn in the frame colour, matching the outline.
    if (item.kind === 'split' && item.idx !== undefined) {
      const font_size = Math.round(HANDLE_R * SPLIT_BADGE_FONT_SCALE * 2)
      ctx.font        = `bold ${font_size}px ${this._theme.font}`
      ctx.textAlign   = 'center'
      ctx.textBaseline = 'middle'
      const bx = x0 + font_size, by = y0 + font_size
      ctx.beginPath()
      ctx.arc(bx, by, font_size * SPLIT_BADGE_RADIUS_SCALE, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.lineWidth   = HANDLE_LINE_WIDTH
      ctx.stroke()
      ctx.fillStyle = color
      ctx.fillText(String(item.idx), bx, by)
    }

    ctx.restore()
  }

  private _draw_rubber_band(ctx: CanvasRenderingContext2D, rect: Box, scale: number): void {
    ctx.save()
    ctx.strokeStyle = this._theme.crop
    ctx.lineWidth   = RUBBER_BAND_LINE_WIDTH
    ctx.setLineDash([...RUBBER_BAND_DASH])
    ctx.strokeRect(
      this._img_x + (rect.x0 - this._crop_origin.x) * scale,
      this._img_y + (rect.y0 - this._crop_origin.y) * scale,
      (rect.x1 - rect.x0) * scale,
      (rect.y1 - rect.y0) * scale,
    )
    ctx.restore()
  }

  // Cursor read-out in the bottom-right label (relative to the canvas element, bottom-right corner
  // 1.0, "se"). Empty when the pointer is off the page. Same font/colour as the sidebar text.
  private _update_coords(px: number, py: number): void {
    // px/py are full-page units; the read-out is relative to the shown view (the crop on a
    // committed page), so shift by crop_origin before the 0–100% mapping.
    const rx = px - this._crop_origin.x, ry = py - this._crop_origin.y
    const inside = rx >= 0 && ry >= 0 && rx <= this._page_w && ry <= this._page_h
    const text = inside
      ? `x ${(rx / this._page_w * 100).toFixed(1)}%  y ${(ry / this._page_h * 100).toFixed(1)}%`
      : ''
    if (this._coords_el.textContent !== text) this._coords_el.textContent = text
  }

  private _draw_loading(ctx: CanvasRenderingContext2D, cw: number, ch: number): void {
    ctx.save()
    ctx.font      = `${LOADING_FONT_SIZE}px ${this._theme.font}`
    ctx.fillStyle = this._theme.text_dim
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('Loading…', cw / 2, ch / 2)
    ctx.restore()
  }

  private _read_theme(): void {
    const cs = getComputedStyle(this.el)
    const get = (name: string, fallback: string): string => {
      const v = cs.getPropertyValue(name).trim()
      return v.length > 0 ? v : fallback
    }
    this._theme = {
      bg:       get('--bg-canvas',   '#121212'),
      crop:     get('--crop-blue',   '#4a9eff'),
      split:    get('--split-blue',  '#2a7edb'),
      handle:   get('--handle-fill', '#ffffff'),
      text_dim: get('--text-dim',    '#888888'),
      font:     get('--font', 'sans-serif'),
    }
  }

  // Pointer event → page-unit coordinates
  private _canvas_to_page(ev: PointerEvent): [number, number] {
    const rect = this.el.getBoundingClientRect()
    const cx   = ev.clientX - rect.left
    const cy   = ev.clientY - rect.top
    return [
      this._crop_origin.x + (cx - this._img_x) / this._scale,
      this._crop_origin.y + (cy - this._img_y) / this._scale,
    ]
  }

  private _on_down = (ev: PointerEvent): void => {
    if (ev.button === 2) { this._cancel(); return }
    this.el.setPointerCapture(ev.pointerId)
    this._dragging = true
    const [px, py] = this._canvas_to_page(ev)
    this._model.begin_drag(px, py, (HANDLE_R + HANDLE_SLACK) / this._scale)
    this._notify()
  }

  private _on_move = (ev: PointerEvent): void => {
    const [px, py] = this._canvas_to_page(ev)
    this._update_coords(px, py)      // bottom-right read-out updates on every move (bug 10)
    if (!this._dragging) return
    this._model.update_drag(px, py)
    this._notify()
  }

  private _on_up = (ev: PointerEvent): void => {
    if (!this._dragging) return
    this._dragging = false
    this.el.releasePointerCapture(ev.pointerId)
    this._model.end_drag()
    this._notify()
  }

  private _cancel(): void {
    // Always cancel — Esc/right-click must also drop a completed drawn window (bug 5), not only
    // an in-progress drag. cancel_drag() is a no-op when there is nothing pending.
    this._dragging = false
    this._model.cancel_drag()
    this._notify()
  }

  private _on_wheel = (ev: WheelEvent): void => {
    if (ev.ctrlKey || ev.metaKey) return   // Ctrl/⌘+wheel is browser zoom — don't also page-navigate
    if (ev.deltaY > 0) this._model.next_page()
    else this._model.prev_page()
    this._notify()
  }

  private _on_key = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') this._cancel()
  }

  // Called when model state has changed and the UI needs a repaint.
  // AppController wires this up via set_on_change().
  private _on_change: (() => void) | null = null
  set_on_change(cb: () => void): void { this._on_change = cb }
  private _notify(): void { this._on_change?.() }

  private _resize(): void {
    // Report the canvas' new physical-px-per-page-unit ratio so NORMAL-mode preview can
    // re-render sharp instead of upscaling a fixed-DPI bitmap (spec-web §2). Uses the last-painted
    // page_w/page_h — close enough for this purpose, and avoids a chicken-and-egg dependency on a
    // view_snapshot() that itself depends on the DPI this call is about to resolve.
    const cw = this.el.clientWidth, ch = this.el.clientHeight
    if (cw > 0 && ch > 0) {
      const dpr = window.devicePixelRatio || 1
      const scale = this._fit_scale(cw, ch, this._page_w, this._page_h)
      this._model.set_display_scale(scale * dpr)
    }
    this._notify()
  }

  destroy(): void {
    this._ro.disconnect()
    if (this._resize_timer !== null) clearTimeout(this._resize_timer)
    window.removeEventListener('keydown', this._on_key)
  }
}
