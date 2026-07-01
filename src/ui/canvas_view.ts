// canvas_view.ts — page canvas: paint from ViewSnapshot + pointer events → model gestures.
// Spec §5, §9.3, §9.6, §19. Status text drawn on the page image (spec §3.3, TODO §4).

import type { AppModel, ViewSnapshot, OverlayBox } from '@core/model'
import type { Box } from '@core/geometry'
import { CANVAS_MARGIN, HANDLE_R, HANDLE_SLACK, SYNTH_W, SYNTH_H } from '@core/constants'
import {
  OVERLAY_DASH, OVERLAY_LINE_WIDTH_SPLIT, OVERLAY_LINE_WIDTH_CROP, HANDLE_LINE_WIDTH,
  SPLIT_BADGE_FONT_SCALE, SPLIT_BADGE_RADIUS_SCALE, RUBBER_BAND_DASH, RUBBER_BAND_LINE_WIDTH,
  STATUS_FONT_SIZE, STATUS_SHADOW_BLUR, STATUS_TEXT_OFFSET_X, STATUS_TEXT_OFFSET_Y,
  LOADING_FONT_SIZE,
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
  private _page_w = SYNTH_W
  private _page_h = SYNTH_H
  private _ro: ResizeObserver
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

    // Pointer events → page-unit coordinates → model gestures
    this.el.addEventListener('pointerdown', this._on_down)
    this.el.addEventListener('pointermove', this._on_move)
    this.el.addEventListener('pointerup',   this._on_up)
    this.el.addEventListener('contextmenu', e => { e.preventDefault(); this._cancel() })
    this.el.addEventListener('wheel', this._on_wheel, { passive: true })
    window.addEventListener('keydown', this._on_key)

    this._ro = new ResizeObserver(() => { this._resize() })
    this._ro.observe(this.el)
  }

  paint(snap: ViewSnapshot): void {
    const { el, _ctx: ctx } = this
    const cw = el.clientWidth, ch = el.clientHeight
    if (el.width !== cw || el.height !== ch) { el.width = cw; el.height = ch }
    this._read_theme()

    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = this._theme.bg
    ctx.fillRect(0, 0, cw, ch)

    if (!snap.image) {
      if (snap.is_loading) this._draw_loading(ctx, cw, ch)
      return
    }

    this._page_w = snap.page_w
    this._page_h = snap.page_h

    // Fit page to canvas
    const scale = Math.min(
      (cw - CANVAS_MARGIN * 2) / snap.page_w,
      (ch - CANVAS_MARGIN * 2) / snap.page_h,
    )
    this._scale = scale
    this._img_x = (cw - snap.page_w * scale) / 2
    this._img_y = (ch - snap.page_h * scale) / 2

    // Draw page image
    ctx.drawImage(snap.image,
      this._img_x, this._img_y,
      snap.page_w * scale, snap.page_h * scale)

    // Overlay crop frames
    for (const box of snap.overlay) this._draw_overlay_box(ctx, box, scale)
    if (snap.draw_rect) this._draw_rubber_band(ctx, snap.draw_rect, scale)

    // Status text on the page image (spec §3.3 / TODO item 4)
    this._draw_status(ctx, snap.status)
  }

  private _draw_overlay_box(
    ctx: CanvasRenderingContext2D,
    item: OverlayBox,
    scale: number,
  ): void {
    const x0 = this._img_x + item.box.x0 * scale
    const y0 = this._img_y + item.box.y0 * scale
    const x1 = this._img_x + item.box.x1 * scale
    const y1 = this._img_y + item.box.y1 * scale
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
    ctx.fillStyle = this._theme.handle
    ctx.strokeStyle = color
    ctx.lineWidth = HANDLE_LINE_WIDTH
    for (const [hx, hy] of handles) {
      const r = HANDLE_R
      ctx.beginPath()
      ctx.moveTo(hx, hy - r); ctx.lineTo(hx + r, hy)
      ctx.lineTo(hx, hy + r); ctx.lineTo(hx - r, hy)
      ctx.closePath()
      ctx.fill(); ctx.stroke()
    }

    // Split badge: number in circle, 30% larger than base font (spec §6 / TODO §6)
    if (item.kind === 'split' && item.idx !== undefined) {
      const font_size = Math.round(HANDLE_R * SPLIT_BADGE_FONT_SCALE * 2)
      ctx.font        = `bold ${font_size}px ${this._theme.font}`
      ctx.fillStyle   = color
      ctx.textAlign   = 'center'
      ctx.textBaseline = 'middle'
      const bx = x0 + font_size, by = y0 + font_size
      ctx.beginPath()
      ctx.arc(bx, by, font_size * SPLIT_BADGE_RADIUS_SCALE, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.fillStyle = '#fff'
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
      this._img_x + rect.x0 * scale,
      this._img_y + rect.y0 * scale,
      (rect.x1 - rect.x0) * scale,
      (rect.y1 - rect.y0) * scale,
    )
    ctx.restore()
  }

  private _draw_status(ctx: CanvasRenderingContext2D, text: string): void {
    if (!text) return
    const tx = this._img_x + STATUS_TEXT_OFFSET_X
    const ty = this._img_y + STATUS_TEXT_OFFSET_Y
    ctx.save()
    ctx.font         = `${STATUS_FONT_SIZE}px ${this._theme.font}`
    ctx.fillStyle    = 'rgba(0,0,0,0.55)'
    ctx.shadowColor  = 'rgba(0,0,0,0.8)'
    ctx.shadowBlur   = STATUS_SHADOW_BLUR
    ctx.fillText(text, tx, ty)
    ctx.shadowBlur   = 0
    ctx.fillStyle    = '#ffffff'
    ctx.fillText(text, tx, ty)
    ctx.restore()
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
      (cx - this._img_x) / this._scale,
      (cy - this._img_y) / this._scale,
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
    if (!this._dragging) return
    const [px, py] = this._canvas_to_page(ev)
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
    if (this._dragging) {
      this._dragging = false
      this._model.cancel_drag()
      this._notify()
    }
  }

  private _on_wheel = (ev: WheelEvent): void => {
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
    this._notify()
  }

  destroy(): void {
    this._ro.disconnect()
    window.removeEventListener('keydown', this._on_key)
  }
}
