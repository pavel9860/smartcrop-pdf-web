// Settings — live output/behaviour values consumed by domain commands (ARCHITECTURE §5.2).
// These are NOT undoable: they survive Undo (spec-web §12/§13).

import {
  DEFAULT_COMPRESS_PRESET,
  DEFAULT_OUTPUT_COLOURS,
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_OUTPUT_POSTFIX,
  DEFAULT_UNDO_DEPTH,
  DEFAULT_DEWARP_SUPERSAMPLE,
  DEFAULT_CUSTOM_DPI,
  DEFAULT_PAPER,
  DEFAULT_CUSTOM_PAPER_IN,
  DEFAULT_DETECT_OUTLIER,
  type ExportFormat,
} from './constants'

export interface Settings {
  compress_preset:     string          // DPI preset name → DPI_PRESETS lookup (or 'Custom')
  custom_dpi:          number          // resolved DPI when compress_preset === 'Custom'
  paper_size:          string          // PAPER_SIZES key — export sizing base (spec-web §10.4)
  custom_paper_in:     number          // paper height (inches) when paper_size === 'Custom'
  output_colours:      string          // 'Original colors' | 'Grayscale'
  export_format:       ExportFormat
  output_postfix:      string          // appended before extension
  undo_depth:          number          // bounds History stack
  dewarp_supersample:  number          // quality lever for dewarp (§10.1)
  detect_outlier_pages: number         // ignore this many largest pages when sizing auto-crop (§5)
}

export function default_settings(): Settings {
  return {
    compress_preset:    DEFAULT_COMPRESS_PRESET,
    custom_dpi:         DEFAULT_CUSTOM_DPI,
    paper_size:         DEFAULT_PAPER,
    custom_paper_in:    DEFAULT_CUSTOM_PAPER_IN,
    output_colours:     DEFAULT_OUTPUT_COLOURS,
    export_format:      DEFAULT_EXPORT_FORMAT,
    output_postfix:     DEFAULT_OUTPUT_POSTFIX,
    undo_depth:         DEFAULT_UNDO_DEPTH,
    dewarp_supersample: DEFAULT_DEWARP_SUPERSAMPLE,
    detect_outlier_pages: DEFAULT_DETECT_OUTLIER,
  }
}
