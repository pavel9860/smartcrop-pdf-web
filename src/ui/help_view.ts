// Help content rendered inside the detail panel (spec §16). A Contents card lists one button
// per section; clicking scrolls the body to it. Section text ported verbatim from the desktop's
// ui/help_content.py (pure data, same as there) — this is the actual app copy, not a
// re-derivation from the spec prose.

const INTRO = 'Crop, straighten, and clean PDFs and scans for e-readers, phones and tablets.'

interface HelpSection { id: string; title: string; body: string }

const SECTIONS: readonly HelpSection[] = [
  {
    id: 'open-files', title: '1. Open files',
    body: 'Press Load Files or Ctrl+O. '
      + 'You can pick several PDFs and images at once — they are joined into one document '
      + 'in the order you selected them. '
      + 'Each PDF adds all its pages. Each image adds one page. '
      + 'Loading always clears the previous document, all crops, and all history.',
  },
  {
    id: 'document-type', title: '2. Document type',
    body: 'SmartCrop reads the document and shows a badge: Normal or Scanned. '
      + 'Normal means at least one page has real text or vector drawings (a typical PDF). '
      + 'Scanned means every page is a plain photo or scan with no text layer. '
      + 'You cannot change this — it is detected automatically. '
      + 'Scanned mode adds a Scan Processing section that is hidden in Normal mode.',
  },
  {
    id: 'pages', title: '3. Choose which pages to work on',
    body: 'The Pages selector at the top applies to every action below it. '
      + 'All, Odd, and Even are self-explanatory. '
      + 'Selected lets you type a pattern: page numbers (1, 3), ranges (2-8), '
      + 'or slices (1:10:2), mixed freely. '
      + 'Current sets the pattern to the page you are viewing right now.',
  },
  {
    id: 'scan-processing', title: '4. Scan processing (scanned documents only)',
    body: 'Run these before setting the crop. Each button reads from the original scan, '
      + 'so you can press it multiple times or try different settings without harm.\n\n'
      + 'Dewarp & Deskew straightens curved or tilted pages. Run this first if your scan '
      + 'has page curl or is slightly rotated.\n\n'
      + 'B/W converts the page to pure black and white. Best for text-only scans.\n\n'
      + 'Sharpen keeps gray tones but flattens uneven lighting and sharpens the image. '
      + 'Better for pages with photos or mixed content.\n\n'
      + 'B/W and Sharpen cannot both be on at the same time. '
      + 'Strength 1 is cautious, 2 is the normal default, 3 is aggressive.',
  },
  {
    id: 'set-crop', title: '5. Set the crop',
    body: 'The crop rectangle is shown on the canvas. You have three ways to set it.\n\n'
      + 'Auto-detect: press the button and SmartCrop finds the content on each selected page. '
      + 'It builds one shared crop frame that fits all pages the same way.\n\n'
      + 'Draw: click and drag on an empty area of the canvas to draw a new rectangle.\n\n'
      + 'Adjust manually: drag a corner to resize, a border to move one edge, '
      + 'or the marker at the top-right corner to move the whole rectangle. '
      + 'Right-click or press Esc to cancel a drag without changing anything.',
  },
  {
    id: 'anchors-offsets', title: '6. Fine-tune with anchors and offsets',
    body: "Anchor Left and Anchor Top (in the Detect card) pin that edge of the shared crop "
      + "to each page's own content rather than the union of all pages. "
      + 'Useful when margins differ across pages. At least one anchor must stay on.\n\n'
      + 'The Advanced card has four offset fields (L T R B). '
      + 'Each nudges one edge by a percentage of the page size. '
      + 'Positive values shrink the crop; negative values expand it. '
      + 'Out-of-range values snap to the page border automatically.',
  },
  {
    id: 'split', title: '7. Split pages',
    body: 'Use Split (1 / 2 / 4) to turn each source page into that many output pages. '
      + 'Useful for scanning two book pages side by side. '
      + 'Choosing 2 or 4 draws an even grid of windows on the canvas. '
      + 'You can drag and resize each window just like a normal crop. '
      + 'Press Apply when all windows look right — the button requires exactly N windows per page. '
      + 'Same size keeps all windows the same dimensions.',
  },
  {
    id: 'keep-ratio', title: '8. Keep ratio',
    body: 'When Keep ratio is on, the crop height is always locked to width / ratio. '
      + 'This applies to every way you can change the crop: dragging handles, '
      + 'editing offsets, drawing a new rectangle, and split windows. '
      + 'The ratio field is editable. It defaults to the detected content width/height.',
  },
  {
    id: 'apply-crop', title: '9. Apply the crop',
    body: 'Press Apply (or Ctrl+Enter) to commit the crop to the selected pages. '
      + 'The canvas immediately shows each page as it will be saved. '
      + 'A committed page stays cropped while you continue editing other pages. '
      + 'Only Undo or Reset returns it to the full page.',
  },
  {
    id: 'rotate-delete', title: '10. Rotate and delete',
    body: 'Rotate turns the selected pages 90° clockwise. Press it again for 180°, again for 270°. '
      + 'Delete removes the selected pages from the document. '
      + 'Both act on the Pages selector. Delete cannot be undone.',
  },
  {
    id: 'compress-colour', title: '11. Compress and colour',
    body: 'These apply at the very end — after the crop — in both the preview and the export.\n\n'
      + 'Output Quality resamples each page to a target resolution. '
      + 'Original resolution keeps the native pixels. '
      + 'High (300 dpi), Medium (150 dpi), and Low (75 dpi) reduce file size.\n\n'
      + 'Output colours: Grayscale desaturates every page while keeping its tonal range. '
      + 'It is not a hard black-and-white — gradients and photos are preserved in gray.\n\n'
      + 'These settings survive Undo — they are not part of the crop history.',
  },
  {
    id: 'export', title: '12. Export',
    body: 'Press Export or Ctrl+S. '
      + 'Pages with a committed crop export exactly as shown on screen. '
      + 'Pages without one export through the live auto-crop.\n\n'
      + 'PDF writes one file. JPG and PNG write one file per output page, numbered automatically '
      + '(TIFF is not available in the web version). Use the arrow on the Export button to switch format.\n\n'
      + 'A progress bar appears for multi-page jobs. Cancel stops cleanly — '
      + 'no partial file is written.',
  },
  {
    id: 'history', title: 'Undo, Redo, Reset',
    body: 'Undo and Redo step through crop, rotation, and scan-processing history. '
      + 'The depth (how many steps are kept) is set in Settings.\n\n'
      + 'Reset clears everything — crops, rotation, processing, and history — '
      + 'and reloads the document. It cannot be undone.',
  },
  {
    id: 'shortcuts', title: 'Keyboard shortcuts',
    body: 'Ctrl+O — Load files\n'
      + 'Ctrl+Enter — Apply crop\n'
      + 'Ctrl+S — Export\n'
      + 'Ctrl+Z — Undo\n'
      + 'Ctrl+Y — Redo\n'
      + 'Left / Right — Previous / next page\n'
      + 'PgUp / PgDn — Previous / next page\n'
      + 'Mouse wheel on canvas — Previous / next page\n'
      + 'Enter in page box — Jump to that page\n'
      + 'Ctrl + / − — Scale the UI\n'
      + 'Ctrl 0 — Reset UI scale\n'
      + 'Esc or right-click — Cancel drag',
  },
  {
    id: 'about', title: 'About',
    body: 'SmartCrop PDF — Web Edition. All processing runs in your browser; no files are uploaded.',
  },
]

function render_body(text: string): string {
  return text.split('\n\n').map(para =>
    `<p>${para.split('\n').map(escape_html).join('<br>')}</p>`).join('')
}

function escape_html(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

export class HelpView {
  private readonly _el: HTMLElement

  constructor(container: HTMLElement) {
    this._el = document.createElement('div')
    this._el.className = 'help-view'

    const contents_items = SECTIONS.map(s =>
      `<button class="help-toc__item" data-target="help-${s.id}">›  ${s.title}</button>`).join('')

    const section_blocks = SECTIONS.map(s =>
      `<section class="help-section" id="help-${s.id}">
         <h3>${s.title}</h3>
         ${render_body(s.body)}
       </section>`).join('')

    this._el.innerHTML = `
      <p class="help-intro">${INTRO}</p>
      <div class="help-toc">
        <h3 class="help-toc__title">Contents</h3>
        ${contents_items}
      </div>
      ${section_blocks}`

    container.appendChild(this._el)

    for (const btn of Array.from(this._el.querySelectorAll<HTMLButtonElement>('.help-toc__item'))) {
      btn.addEventListener('click', () => {
        const target = this._el.querySelector(`#${btn.dataset['target'] ?? ''}`)
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
    }
  }

  get el(): HTMLElement { return this._el }
}
