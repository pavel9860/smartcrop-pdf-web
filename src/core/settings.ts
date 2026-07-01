// Settings — live output/behaviour values consumed by domain commands (ARCHITECTURE §5.2).
// These are NOT undoable: they survive Undo (spec §22 inv.4 / §15).

import {
  DEFAULT_COMPRESS_PRESET,
  DEFAULT_OUTPUT_COLOURS,
  DEFAULT_EXPORT_FORMAT,
  DEFAULT_OUTPUT_POSTFIX,
  DEFAULT_UNDO_DEPTH,
  DEFAULT_DEWARP_SUPERSAMPLE,
  type ExportFormat,
} from './constants'

export interface Settings {
  compress_preset:     string          // DPI preset name → DPI_PRESETS lookup
  output_colours:      string          // 'Original colors' | 'Grayscale'
  export_format:       ExportFormat
  output_folder:       string          // '' = same as source
  output_postfix:      string          // appended before extension
  undo_depth:          number          // bounds History stack
  dewarp_supersample:  number          // quality lever for dewarp (§10.1)
}

export function default_settings(): Settings {
  return {
    compress_preset:    DEFAULT_COMPRESS_PRESET,
    output_colours:     DEFAULT_OUTPUT_COLOURS,
    export_format:      DEFAULT_EXPORT_FORMAT,
    output_folder:      '',
    output_postfix:     DEFAULT_OUTPUT_POSTFIX,
    undo_depth:         DEFAULT_UNDO_DEPTH,
    dewarp_supersample: DEFAULT_DEWARP_SUPERSAMPLE,
  }
}
