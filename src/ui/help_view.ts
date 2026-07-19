// Help content rendered inside the detail panel (spec-web §14). A Contents card lists one button
// per section; clicking scrolls the body to it.

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
      + 'or drag inside the rectangle (away from any handle) to move the whole thing. '
      + 'Right-click or press Esc to cancel a drag without changing anything.',
  },
  {
    id: 'anchors-offsets', title: '6. Fine-tune with anchors and offsets',
    body: "Anchor Left and Anchor Top (in the Detect card) pin that edge of the shared crop "
      + "to each page's own content rather than the union of all pages. "
      + 'Useful when margins differ across pages. At least one anchor must stay on.\n\n'
      + "When a window is hand-drawn (Draw, above), four fields (L T R B) appear in the Detect "
      + "card showing that window's edges as a percentage of the page size from each side — "
      + 'editing a field and dragging a handle always agree about the window\'s position.\n\n'
      + "If a few pages have unusually large content (e.g. a fold-out), Settings → "
      + '"Ignore N outlier pages" excludes that many of the largest pages when sizing the shared '
      + 'crop, so they stop inflating the crop on every other page. Defaults to 2.',
  },
  {
    id: 'split', title: '7. Split pages',
    body: 'Use Split (1 / 2 / 4) to turn each source page into that many output pages. '
      + 'Useful for scanning two book pages side by side. '
      + 'Choosing 2 or 4 draws an even grid of windows on the canvas. '
      + 'You can drag and resize each window just like a normal crop. '
      + 'Press Crop when all windows look right — the button requires exactly N windows per page.\n\n'
      + 'Same size keeps every window the same width and height: resizing one resizes the others '
      + 'to match, live as you drag. Moving a window (dragging its interior) never affects the '
      + 'others — only a resize propagates.',
  },
  {
    id: 'keep-ratio', title: '8. Keep ratio',
    body: 'When Keep ratio is on, the crop height is always locked to width / ratio, held live '
      + 'throughout the drag (not just snapped at the end). '
      + 'This applies to every way you can change the crop: dragging handles, '
      + 'editing offsets, drawing a new rectangle, and split windows. '
      + 'The ratio field is editable. It defaults to whatever crop shape is currently on screen.',
  },
  {
    id: 'apply-crop', title: '9. Crop',
    body: 'Press Crop (or Ctrl+Enter) to commit the crop to the selected pages. '
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
    id: 'compress-colour', title: '11. Output Quality',
    body: 'These settings affect the exported file only — never the on-screen preview, which '
      + 'always stays full-resolution and true-colour so editing is never misleading.\n\n'
      + 'Compress to resamples each output page to a target DPI. Original resolution keeps the '
      + 'native pixels; the DPI presets (or a Custom… value) size the output as DPI × the chosen '
      + 'Paper size (Settings → Output — A2 through A6, or a Custom height in inches).\n\n'
      + 'Colour: Grayscale desaturates every output page while keeping its tonal range — not a '
      + 'hard black-and-white. Original colors leaves the page untouched.\n\n'
      + 'For a Normal (digital) document exporting to PDF, this card is hidden: that combination '
      + 'exports losslessly as a real vector PDF with no resampling step, so none of these '
      + 'settings apply. It reappears if you switch the export format to an image.\n\n'
      + 'Output Quality settings are not part of crop history — Undo never touches them — and '
      + 'they persist across documents and browser sessions.',
  },
  {
    id: 'export', title: '12. Export',
    body: 'Press Export or Ctrl+S. '
      + 'Pages with a committed crop export exactly as shown on screen. '
      + 'Pages without one export as the full, uncropped page — press Crop first if you want a '
      + 'previewed crop to actually apply.\n\n'
      + 'PDF writes one file (a real vector PDF for a Normal document, §11 above). '
      + 'JPG, PNG and TIFF each write one .zip containing one file per output page. '
      + 'Use the arrow on the Export button to switch format.\n\n'
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
    id: 'settings', title: 'Settings',
    body: 'Appearance: colour scheme (Dark/Light/System), font size, and UI zoom (also Ctrl +/-, '
      + 'Ctrl 0 to reset).\n\n'
      + 'Output: postfix appended to the exported file name; Custom DPI and Paper size — shared '
      + 'with the sidebar Output Quality card, so either control always reflects the other.\n\n'
      + 'Behaviour: remember the last-used folder; Enable offline mode — off by default, turn it on '
      + 'to make every feature, including scanned-mode dewarp and filters, work offline right away '
      + 'instead of only after first use (downloads more up front); Undo/redo depth; '
      + 'Ignore N outlier pages (§6 above).\n\n'
      + 'Scan: Dewarp supersample — renders a scanned page larger before straightening it, '
      + 'trading time for a sharper result.',
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
      + 'Delete — Delete the selected pages\n'
      + 'Esc or right-click — Cancel drag, or drop the current crop window',
  },
  {
    id: 'about', title: 'About',
    body: 'SmartCrop PDF — Web Edition. All processing runs in your browser; no files are uploaded. '
      + 'No install needed — the app works offline after being loaded once, for whichever features '
      + 'you\'ve already used (see Settings, below, for making every feature available offline '
      + 'right away).',
  },
  {
    id: 'contacts', title: 'Contacts',
    body: 'Questions or feedback: hello@smartcroppdf.com\n'
      + 'Something not working? support@smartcroppdf.com',
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
      `<button class="help-toc__item" data-target="help-${s.id}" title="Scroll to this section">›  ${s.title}</button>`).join('')

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
