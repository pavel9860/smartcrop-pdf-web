// String-backed enums — named members prevent typos; string backing keeps parsers clean.

export enum Mode {
  NORMAL  = 'NORMAL',
  SCANNED = 'SCANNED',
}

export enum FilterMode {
  NONE    = 'NONE',
  BW      = 'BW',
  SHARPEN = 'SHARPEN',
}

export enum PagesMode {
  ALL    = 'ALL',
  ODD    = 'ODD',
  EVEN   = 'EVEN',
  SELECT = 'SELECT',
}
