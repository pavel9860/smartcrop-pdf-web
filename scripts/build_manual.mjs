// Builds public/manual.pdf — the 3-page picture manual opened when no file is open (spec-web §1).
// Run: npm run manual
import { writeFileSync } from 'node:fs'
import { PDFDocument, StandardFonts, rgb, LineCapStyle } from 'pdf-lib'

const W = 842, H = 595, S = 0.8
const hex = h => rgb(...[1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255))
const INK = hex('#2a2a26'), DIM = hex('#74726b'), BL = hex('#224d87'), WHITE = rgb(1, 1, 1)
const PALE = hex('#a8a69e'), GREY = hex('#e4e2dc'), MIDBG = hex('#f1f0ec'), SEL = hex('#dfe6f1')

const doc = await PDFDocument.create()
doc.setTitle('SmartCrop PDF - manual')
const font = await doc.embedFont(StandardFonts.Helvetica)
const bold = await doc.embedFont(StandardFonts.HelveticaBold)
const serif = await doc.embedFont(StandardFonts.TimesRoman)
let pg

// Drawing in y-down page coordinates; g(x, y, s) is a local frame (an SVG <g transform>).
const g = (x = 0, y = 0, s = 1) => ({
  path(d, { fill, stroke, sw = 2, dash, cap } = {}) {
    pg.drawSvgPath(d, {
      x, y: H - y, scale: s, color: fill, borderColor: stroke, borderWidth: stroke ? sw : 0,
      borderDashArray: dash, borderLineCap: cap ? LineCapStyle.Round : undefined,
    })
  },
  rect(rx, ry, w, h, o, r = 0) {
    this.path(r ? `M${rx + r} ${ry}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}Z`
      : `M${rx} ${ry}h${w}v${h}h${-w}Z`, o)
  },
  circle(cx, cy, r, o) { this.path(`M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`, o) },
  text(t, tx, ty, { size = 15, b = false, f, color = INK, align = 'start' } = {}) {
    const fnt = f ?? (b ? bold : font), sz = size * s, tw = fnt.widthOfTextAtSize(t, sz)
    const ax = align === 'middle' ? tw / 2 : align === 'end' ? tw : 0
    pg.drawText(t, { x: x + tx * s - ax, y: H - (y + ty * s), size: sz, font: fnt, color })
    return tw
  },
})
const top = g()
const textW = (t, size, b) => (b ? bold : font).widthOfTextAtSize(t, size)
const lines = (rows, x0, x1, last) => rows.map((y, i) => `M${x0} ${y}h${i === rows.length - 1 && last ? last : x1 - x0}`).join('')

// ── Pictograms: local 48×64 page unless noted ───────────────────────────────
const TEXT_ROWS = [14, 21, 28, 35, 42, 49]
const page = (l, { fill = WHITE, ink = INK, rows = TEXT_ROWS } = {}) => {
  l.rect(1, 1, 46, 62, { fill, stroke: INK })
  l.path(lines(rows, 9, 39, 18), { stroke: ink, sw: 2.6 })
}
const SPECKS = [[6, 6, 1.3], [14, 9, 1], [40, 8, 1.3], [33, 17, 1], [6, 25, 1.3], [19, 31, 1], [42, 32, 1.3], [12, 38, 1],
  [28, 45, 1.3], [41, 47, 1], [7, 55, 1.3], [22, 57, 1], [36, 58, 1.3], [25, 24, 1], [16, 46, 1.3], [44, 22, 1]]
const banded = (l, label, dark) => {
  l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK })
  l.path(lines([12, 18, 24, 30], 9, 39, 20), { stroke: INK, sw: 2.4 })
  l.rect(1, 42, 46, 21, dark ? { fill: INK, stroke: INK } : { fill: WHITE, stroke: INK })
  l.text(label, 24, 57, { size: 11, b: true, color: dark ? WHITE : INK, align: 'middle' })
}
const rotLines = () => {
  const a = -7.5 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
  const r = (px, py) => `${(24 + (px - 24) * c - (py - 32) * s).toFixed(2)} ${(32 + (px - 24) * s + (py - 32) * c).toFixed(2)}`
  return [14, 21, 28, 35, 42].map(y => `M${r(9, y)}Q${r(24, y - 5)} ${r(39, y)}`).join('') + `M${r(9, 49)}Q${r(18, 46)} ${r(27, 49)}`
}
const PICS = {
  P: l => page(l),
  FULL: l => { l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK }); l.path(lines([7, 13, 19, 25, 31, 37, 43, 49, 55], 5, 43, 24), { stroke: INK, sw: 2.6 }) },
  ROT: l => { l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK }); l.path(rotLines(), { stroke: INK, sw: 2.6 }) },
  DIRTY: l => { page(l, { fill: GREY, ink: PALE }); SPECKS.forEach(([cx, cy, r]) => l.circle(cx, cy, r, { fill: DIM })) },
  MID: l => { page(l, { fill: MIDBG, ink: DIM }); SPECKS.filter((_, i) => i % 4 === 1).forEach(([cx, cy]) => l.circle(cx, cy, 1, { fill: PALE })) },
  SPREAD: l => {
    l.rect(1, 1, 94, 62, { fill: WHITE, stroke: INK })
    l.path(lines(TEXT_ROWS, 8, 40, 20) + lines(TEXT_ROWS, 56, 88, 20), { stroke: INK, sw: 2.6 })
    l.path('M48 -3v70', { stroke: BL, dash: [4, 3] })
  },
  FOUR: l => {
    l.rect(1, 1, 94, 62, { fill: WHITE, stroke: INK })
    for (const [x0, y0] of [[8, 9], [56, 9], [8, 41], [56, 41]]) l.path(lines([y0, y0 + 6, y0 + 12], x0, x0 + 32, 20), { stroke: INK, sw: 2.6 })
    l.path('M48 -3v70M-3 32h102', { stroke: BL, dash: [4, 3] })
  },
  BOX: l => { page(l); l.rect(5, 9, 38, 45, { stroke: BL, sw: 2.4, dash: [5, 3] }) },
  LAND: l => { l.rect(1, 9, 62, 46, { fill: WHITE, stroke: INK }); l.path('M12 17v30M19 17v30M26 17v30M33 17v30M40 17v30M47 17v18', { stroke: INK, sw: 2.6 }) },
  DEL: l => { page(l); l.path('M6 6l36 52M42 6L6 58', { stroke: INK, sw: 4, cap: true }) },
  GONE: l => l.rect(1, 1, 46, 62, { stroke: PALE, dash: [4, 4] }),
  MB12: l => banded(l, '12 MB', true),
  MB2: l => banded(l, '2 MB', false),
  IMG: l => banded(l, 'JPG', true),
  DIG: l => { l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK }); l.text('Aa', 24, 42, { size: 24, f: serif, align: 'middle' }) },
  SCN: l => {
    l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK })
    for (const [px, py] of [[10, 18], [22, 18], [16, 24], [28, 24], [10, 30], [34, 30], [22, 36], [16, 42], [28, 42]]) l.rect(px, py, 6, 6, { fill: INK })
  },
  OPEN: l => { l.path('M2 14h18l5 6h37v36H2z', { fill: WHITE, stroke: INK, sw: 2.2 }); l.path('M32 50V28m-8 8 8-8 8 8', { stroke: BL, sw: 3, cap: true }) },
  SAVE: l => { l.path('M30 4v34m-10-10 10 10 10-10', { stroke: BL, sw: 3, cap: true }); l.path('M4 38v18h52V38', { stroke: INK, sw: 2.6, cap: true }) },
}
PICS.TWO = l => { PICS.P(l); PICS.P(g(l.ox + 52 * l.os, l.oy, l.os)) }
const pic = (id, x, y, s = S) => { const l = Object.assign(g(x, y, s), { ox: x, oy: y, os: s }); PICS[id](l) }
const pw = id => ({ SPREAD: 77, FOUR: 77, TWO: 80, LAND: 51 })[id] ?? 38
const arr = (x, y) => g(x, y).path('M0 0h18m-6-5 6 5-6 5', { stroke: BL, sw: 2.6, cap: true })
const pair = (x, y, b, a) => { pic(b, x, y); const ax = x + pw(b) + 8; arr(ax, y + 26); pic(a, ax + 28, y) }

// ── UI widgets ──────────────────────────────────────────────────────────────
const T = (t, x, y, o) => top.text(t, x, y, o)
const head = (x, y, t, w) => { T(t, x, y, { size: 18, b: true }); top.path(`M${x} ${y + 10}h${w}`, { stroke: INK, sw: 1.2 }) }
const caret = (x, y, color) => top.path(`M${x} ${y}l4 5 4 -5z`, { fill: color })
const seg = (x, y, labels, on = []) => {
  let cx = x
  labels.forEach((raw, i) => {
    const drop = raw.endsWith(' v'), l = drop ? raw.slice(0, -2) : raw, a = on.includes(i)
    const bw = textW(l, 12, true) + 18 + (drop ? 12 : 0), c = a ? WHITE : INK
    top.rect(cx, y, bw, 24, { fill: a ? INK : WHITE, stroke: INK, sw: 1.2 }, 5)
    T(l, cx + 9, y + 16, { size: 12, b: true, color: c })
    if (drop) caret(cx + bw - 17, y + 10, c)
    cx += bw + 3
  })
  return cx
}
const btn = (x, y, l, dark) => {
  const bw = textW(l, 12, true) + 22
  top.rect(x, y, bw, 26, { fill: dark ? INK : WHITE, stroke: INK, sw: 1.2 }, 6)
  T(l, x + bw / 2, y + 17, { size: 12, b: true, color: dark ? WHITE : INK, align: 'middle' })
  return x + bw
}
const cap = (x, y, ls, step = 18) => ls.forEach((l, i) => T(l, x, y + i * step, { size: 13, color: DIM }))
const num = (x, y, n) => { top.circle(x + 12, y + 26, 12, { fill: INK }); T(String(n), x + 12, y + 31, { size: 13, b: true, color: WHITE, align: 'middle' }) }
const ARROW_KEYS = { L: 'M14 0H2m4-4-4 4 4 4', R: 'M0 0h12m-4-4 4 4-4 4' }, KEY_TEXT = { Plus: '+' }
const keycap = (x, y, l) => {
  const kw = ARROW_KEYS[l] ? 26 : Math.max(24, textW(KEY_TEXT[l] ?? l, 11, true) + 12)
  top.rect(x, y, kw, 22, { fill: WHITE, stroke: INK, sw: 1.2 }, 4)
  top.path(`M${x + 2} ${y + 22}h${kw - 4}`, { stroke: INK, sw: 2.4 })
  if (ARROW_KEYS[l]) g(x + 6, y + 11).path(ARROW_KEYS[l], { stroke: INK, sw: 1.8, cap: true })
  else T(KEY_TEXT[l] ?? l, x + kw / 2, y + 15, { size: 11, b: true, align: 'middle' })
  return kw
}
const keys = (x, y, ks) => ks.reduce((cx, k) => {
  if (k === '+' || k === '/') { T(k, cx + 2, y + 15, { size: 12, color: DIM }); return cx + 12 }
  return cx + keycap(cx, y, k) + 3
}, x)
const approx = (x, y) => g(x, y).path('M0 -6q2.5 -3 5 0t5 0M0 -1q2.5 -3 5 0t5 0', { stroke: INK, sw: 1.4 })
const bar = (y, icon, t, sub) => {
  top.rect(30, y, 782, 40, { fill: WHITE, stroke: INK, sw: 1.2 }, 8)
  pic(icon, 48, y + 3, 0.58)
  T(t, 98, y + 27, { size: 17, b: true })
  T(sub, 158, y + 27, { size: 19.5, color: DIM })
}
const footer = n => T(`SmartCrop PDF  ·  ${n} / 3`, W / 2, 588, { size: 10, color: DIM, align: 'middle' })
const newPage = () => { pg = doc.addPage([W, H]) }

// ── Page 1: main workflows ──────────────────────────────────────────────────
newPage()
bar(12, 'OPEN', 'Open', 'PDFs and images, any number and mix — button or drop here')
head(30, 84, 'Digital PDF', 376)
head(436, 84, 'Scan or photo', 376)
const STEPS = [['ROT', 'P', 'Dewarp & Deskew'], ['DIRTY', 'P', 'B/W or Sharpen'], ['SPREAD', 'TWO', 'Split'], ['P', 'BOX', 'Auto-detect'], ['BOX', 'FULL', 'Crop']]
const step = (x, y, n, [b, a, label]) => { num(x, y, n); pair(x + 34, y, b, a); T(label, x + 236, y + 31, { b: true }) }
STEPS.forEach((s, i) => step(436, 104 + i * 58, i + 1, s))
STEPS.slice(2).forEach((s, i) => step(30, 104 + i * 116, i + 1, s))
top.rect(30, 406, 782, 112, { stroke: INK, sw: 1.2 }, 8)
;[['P', 'LAND', 'Rotate'], ['DEL', 'GONE', 'Delete page'], ['MB12', 'MB2', 'Compress'], ['FULL', 'IMG', 'Convert', 'JPG PNG TIFF']]
  .forEach(([b, a, label, sub], i) => {
    const cx = 128 + i * 196, tw = pw(b) + 36 + pw(a)
    pair(cx - tw / 2, 420, b, a)
    const lw = textW(label, 15, true) + (sub ? 6 + textW(sub, 15) : 0), lx = cx - lw / 2
    T(label, lx, 492, { b: true })
    if (sub) T(sub, lx + textW(label, 15, true) + 6, 492)
  })
bar(530, 'SAVE', 'Save', 'PDF, or images in one .zip')
footer(1)

// ── Page 2: more control ────────────────────────────────────────────────────
const PX = [30, 296, 562], PW = 250
const panel = (x, y, t) => head(x, y + 20, t, PW)
const block = (x, y, [bx, by, bw, bh], box, solid) => {
  const l = g(x, y, S), rows = []
  for (let yy = by + 2; yy <= by + bh; yy += 6) rows.push(yy)
  l.rect(1, 1, 46, 62, { fill: WHITE, stroke: INK })
  l.path(lines(rows, bx, bx + bw), { stroke: INK, sw: 2.6 })
  if (box) l.rect(box[0] - 2, box[1] - 2, box[2] + 4, box[3] + 4, solid ? { stroke: BL, sw: 2.6 } : { stroke: BL, dash: [4, 3] })
}
newPage()
{
  const Y0 = 20, Y1 = 300
  panel(PX[0], Y0, 'Pages to process')
  for (let i = 0; i < 5; i++) {
    const x = PX[0] + i * 50, odd = i % 2 === 0, l = g(x, Y0 + 50, S)
    l.rect(1, 1, 46, 62, { fill: odd ? SEL : WHITE, stroke: odd ? BL : INK })
    l.path(lines([14, 21, 28, 35, 42], 9, 39, 18), { stroke: INK, sw: 2.6 })
    T(String(i + 1), x + 19, Y0 + 120, { size: 13, b: true, color: odd ? BL : DIM, align: 'middle' })
  }
  seg(PX[0], Y0 + 138, ['All', 'Odd', 'Even', 'Selected'], [1])
  cap(PX[0], Y0 + 192, ['Every button acts on these pages.', 'Selected: type 1-3, 7'])

  panel(PX[1], Y0, 'Split into 2 or 4')
  pair(PX[1], Y0 + 50, 'SPREAD', 'TWO')
  pic('FOUR', PX[1], Y0 + 118)
  seg(PX[1] + 100, Y0 + 130, ['1', '2', '4'], [2])
  cap(PX[1], Y0 + 192, ['Drag each window to adjust.', 'Same size keeps them equal.'])

  panel(PX[2], Y0, 'Draw a box by hand')
  const big = g(PX[2] + 20, Y0 + 46, 1.6)
  page(big)
  big.rect(7, 10, 34, 42, { stroke: BL, sw: 1.6 })
  for (const [hx, hy] of [[7, 10], [41, 10], [7, 52], [41, 52]]) big.rect(hx - 2.5, hy - 2.5, 5, 5, { fill: BL })
  big.path('M41 52l10 10m0 0v-6m0 6h-6', { stroke: INK, sw: 1.6 })
  seg(PX[2] + 120, Y0 + 60, ['L']); seg(PX[2] + 150, Y0 + 60, ['T'])
  seg(PX[2] + 120, Y0 + 90, ['R']); seg(PX[2] + 150, Y0 + 90, ['B'])
  cap(PX[2], Y0 + 192, ['Drag on the page instead of', 'Auto-detect. L T R B fine-tune edges.'])

  const A = [8, 8, 22, 26], B = [16, 22, 26, 30], own = b => [b[0], b[1], 26, 30], shared = [8, 8, 26, 30]
  panel(PX[0], Y1, 'How Auto-detect works')
  block(PX[0], Y1 + 50, A, A); block(PX[0] + 42, Y1 + 50, B, own(B))
  arr(PX[0] + 88, Y1 + 76)
  block(PX[0] + 116, Y1 + 50, A, own(A), true); block(PX[0] + 158, Y1 + 50, B, own(B), true)
  T('finds text', PX[0] + 40, Y1 + 124, { size: 12, color: DIM, align: 'middle' })
  T('one size for all', PX[0] + 156, Y1 + 124, { size: 12, color: DIM, align: 'middle' })
  cap(PX[0], Y1 + 192, ['Finds the text on every page, then', 'crops all to the largest text block.'])

  panel(PX[1], Y1, 'Anchor left / top')
  seg(PX[1], Y1 + 64, ['On'], [0])
  block(PX[1] + 60, Y1 + 46, A, own(A), true); block(PX[1] + 104, Y1 + 46, B, own(B), true)
  seg(PX[1], Y1 + 124, ['Off'])
  block(PX[1] + 60, Y1 + 106, A, shared, true); block(PX[1] + 104, Y1 + 106, B, shared, true)
  cap(PX[1], Y1 + 192, ['On: the box starts at each page’s text.', 'Off: same place on every page.'])

  panel(PX[2], Y1, 'Keep ratio')
  block(PX[2], Y1 + 56, [10, 14, 22, 30], [10, 14, 22, 30], true)
  arr(PX[2] + 46, Y1 + 82)
  block(PX[2] + 74, Y1 + 56, [6, 8, 32, 44], [6, 8, 32, 44], true)
  const lock = g(PX[2] + 140, Y1 + 50)
  lock.path('M9 22v-9a11 11 0 0 1 22 0v9', { stroke: INK, sw: 4 })
  lock.path('M6 22h28a4 4 0 0 1 4 4v20a4 4 0 0 1 -4 4h-28a4 4 0 0 1 -4 -4v-20a4 4 0 0 1 4 -4z', { fill: INK })
  lock.circle(20, 33, 4, { fill: WHITE })
  lock.path('M20 35v7', { stroke: WHITE, sw: 3 })
  seg(PX[2] + 186, Y1 + 70, ['0.75'])
  cap(PX[2], Y1 + 192, ['The crop keeps its shape —', 'e.g. your e-reader screen.'])
}
footer(2)

// ── Page 3: good to know ────────────────────────────────────────────────────
newPage()
{
  const PY = [20, 208, 396]
  panel(PX[0], PY[0], 'Keyboard and mouse')
  ;[[['Ctrl', '+', 'O'], 'open'], [['Ctrl', '+', 'Enter'], 'crop'], [['Ctrl', '+', 'S'], 'save'],
    [['Ctrl', '+', 'Z'], 'undo'], [['Ctrl', '+', 'Y'], 'redo'], [['L', '/', 'R'], 'previous / next page'],
    [['PgUp', '/', 'PgDn'], 'previous / next page'], [['wheel'], 'turn pages'],
    [['Del', '/', 'Backspace'], 'delete pages'], [['Ctrl', '+', 'Plus', '/', '-'], 'zoom in / out'], [['Ctrl', '+', '0'], 'reset zoom']]
    .forEach(([k, d], i) => { keys(PX[0], PY[0] + 40 + i * 29, k); T(d, PX[0] + PW, PY[0] + 55 + i * 29, { size: 13, color: DIM, align: 'end' }) })

  panel(PX[0], PY[2], 'Undo, Redo, Reset')
  btn(PX[0], PY[2] + 44, 'Undo'); btn(PX[0] + 70, PY[2] + 44, 'Redo'); btn(PX[0] + 140, PY[2] + 44, 'Reset')
  cap(PX[0], PY[2] + 100, ['Undo takes back any step.', 'Reset reloads your files', 'as they were opened.'], 17)

  panel(PX[1], PY[0], 'Digital or scan: automatic')
  pic('DIG', PX[1], PY[0] + 42); seg(PX[1] + 46, PY[0] + 56, ['NORMAL'], [0])
  pic('SCN', PX[1] + 128, PY[0] + 42); seg(PX[1] + 174, PY[0] + 56, ['SCANNED'], [0])
  cap(PX[1], PY[0] + 118, ['Set when you open, no choice needed.', 'Scan tools appear only for scans.'], 17)

  panel(PX[1], PY[1], 'Filter strength')
  pic('DIRTY', PX[1], PY[1] + 40); arr(PX[1] + 46, PY[1] + 66); pic('MID', PX[1] + 72, PY[1] + 40); pic('P', PX[1] + 116, PY[1] + 40)
  seg(PX[1] + 166, PY[1] + 54, ['1', '2', '3'], [1])
  cap(PX[1], PY[1] + 118, ['B/W or Sharpen: 1 is light,', '3 is strong.'], 17)

  panel(PX[1], PY[2], 'Output quality')
  seg(PX[1], PY[2] + 40, ['High — 300 dpi v'])
  seg(PX[1], PY[2] + 68, ['Original colors v'])
  btn(PX[1] + 150, PY[2] + 67, 'Save PDF', true)
  approx(PX[1] + 150, PY[2] + 54); T('12 MB', PX[1] + 164, PY[2] + 54, { size: 13, b: true })
  cap(PX[1], PY[2] + 118, ['For scans and image files. A digital', 'PDF saved as PDF stays vector:', 'sharp text, small file.'], 17)

  panel(PX[2], PY[0], 'Settings')
  ;[['Appearance', 'colour scheme, font size, zoom'], ['Output', 'file-name postfix, DPI, paper size'],
    ['Behaviour', 'offline mode, undo depth, last folder,'], [null, 'ignore N outlier pages']]
    .forEach(([grp, d], i) => {
      if (grp) T(grp, PX[2], PY[0] + 52 + i * 30, { size: 12, b: true })
      T(d, PX[2], PY[0] + (grp ? 66 : 52) + i * 30, { size: 12, color: DIM })
    })

  panel(PX[2], PY[1], 'Private, works offline')
  top.rect(PX[2], PY[1] + 40, 108, 72, { fill: WHITE, stroke: INK }, 4)
  top.path(`M${PX[2]} ${PY[1] + 52}h108`, { stroke: INK })
  pic('P', PX[2] + 18, PY[1] + 58, 0.5)
  top.rect(PX[2] + 60, PY[1] + 80, 26, 22, { fill: WHITE, stroke: INK })
  g(PX[2] + 65, PY[1] + 80).path('M0 0v-7a8 8 0 0 1 16 0v7', { stroke: INK })
  g(PX[2] + 168, PY[1] + 86).path('M0 0a18 12 0 0 1 34 -6a14 10 0 0 1 16 18h-46a10 8 0 0 1 -4 -12z', { stroke: DIM, sw: 1.8 })
  g(PX[2] + 132, PY[1] + 62).path('M0 0l36 36M36 0l-36 36', { stroke: INK, sw: 3, cap: true })
  cap(PX[2], PY[1] + 136, ['Files never leave your browser anyway.', 'Use “Offline mode” in Settings to avoid', 'any requests to the website.'], 17)

  panel(PX[2], PY[2], 'Help')
  top.circle(PX[2] + 22, PY[2] + 66, 18, { stroke: INK, sw: 2.4 })
  T('?', PX[2] + 22, PY[2] + 74, { size: 22, b: true, align: 'middle' })
  btn(PX[2] + 56, PY[2] + 53, 'Settings'); btn(PX[2] + 146, PY[2] + 53, 'Help')
  cap(PX[2], PY[2] + 114, ['Help explains every control.'], 17)
}
footer(3)

writeFileSync(new URL('../public/manual.pdf', import.meta.url), await doc.save())
console.log('public/manual.pdf written')
