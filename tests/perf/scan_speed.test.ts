// Scan-processing speed budgets (spec-web §16), on demand via `npm run test:perf`: the real
// imaging.ts filter and binarization code on the real SIMD OpenCV.js build, over a deterministic
// synthetic page sized like a real scan (cost scales with pixel count, not content). Prints the
// ratio to a desktop reference captured once with the desktop app's own stack (opencv-python on
// ml_interview_warped page 1, 1240×1755, mean of 5 after 2 warm-ups).
import { describe, it, expect, beforeAll } from 'vitest'
import { FilterMode } from '@core/enums'
import { BW_STRENGTH, DETECT_MAX_PX, SAUVOLA_WINDOW, BG_KERNEL_SIZE } from '@core/constants'
import { ensure_cv, cv, type Mat } from '@pdf/cv'
import { apply_filter_mat, clean_document_bilevel } from '@pdf/imaging'
import { bench, PAGE_W, PAGE_H } from './bench'

const DESKTOP_REF_MS = 190

function page_rgba(w: number, h: number): Mat {
  const data = new Uint8Array(w * h * 4)
  let s = 42
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    const v = Math.floor((s / 0xffffffff) * 255) > 30 ? 255 : 0
    data.set([v, v, v, 255], i * 4)
  }
  return cv.matFromArray(h, w, cv.CV_8UC4, Array.from(data))
}

describe('scan processing speed (spec-web §16)', () => {
  let page: Mat
  beforeAll(async () => { await ensure_cv(); page = page_rgba(PAGE_W, PAGE_H) })

  for (const [name, mode] of [['B/W', FilterMode.BW], ['Sharpen', FilterMode.SHARPEN]] as const) {
    it(`${name} filter < 500 ms/page`, () => {
      const ms = bench(() => { apply_filter_mat(page.clone(), mode, 2).delete() }, 10)
      console.log(`[perf] ${name}: ${ms.toFixed(1)} ms/page @ ${PAGE_W}×${PAGE_H} (desktop ${DESKTOP_REF_MS} ms → ${(ms / DESKTOP_REF_MS).toFixed(2)}×)`)
      expect(ms).toBeLessThan(500)
    })
  }

  it('Auto-detect binarization < 100 ms/page at the detect resolution', () => {
    const scale = DETECT_MAX_PX / Math.max(PAGE_W, PAGE_H)
    const gray = new cv.Mat(), small = new cv.Mat()
    cv.cvtColor(page, gray, cv.COLOR_RGBA2GRAY)
    cv.resize(gray, small, new cv.Size(Math.round(PAGE_W * scale), Math.round(PAGE_H * scale)), 0, 0, cv.INTER_AREA)
    gray.delete()
    const ms = bench(() => { clean_document_bilevel(small, BW_STRENGTH[2].k, BW_STRENGTH[2].minArea, SAUVOLA_WINDOW, BG_KERNEL_SIZE).delete() }, 10)
    console.log(`[perf] Auto-detect: ${ms.toFixed(1)} ms/page @ ${small.cols}×${small.rows}`)
    small.delete()
    expect(ms).toBeLessThan(100)
  })
})
