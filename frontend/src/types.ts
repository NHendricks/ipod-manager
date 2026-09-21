export interface LocalEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  isAudio: boolean
}

export interface IpodInfo {
  modelNumber: string | null
  generation: string | null
  modelName: string | null
  capacityGB: number
  trackCount: number
  freeBytes: number
  totalBytes: number
}

export interface IpodTrack {
  id: number
  title: string | null
  artist: string | null
  album: string | null
  genre: string | null
  trackNr: number
  year: number
  durationMs: number
  sizeBytes: number
  bitrate: number
  ipodPath: string
}

export interface FileMetadata {
  fileName: string
  path: string
  tags: [string, string][]
  technical: [string, string][]
  cover: string | null
}

// The active pane's selection, announced via a bubbling "selection-change" event. F3 shows
// metadata for `focus` (the keyboard cursor, if selectable) or else the first item; F5 copies all items.
export type Selection =
  | { kind: 'local'; paths: string[]; focus: string | null }
  | { kind: 'ipod'; ids: number[]; focus: number | null }

export interface IpodStatus {
  connected: boolean
  driveLetter?: string
  info?: IpodInfo
  error?: string
}

// application/x-* custom drag payload types shared between local-pane and ipod-pane.
// Payloads are JSON arrays (string[] of paths / number[] of track ids) so several items can be dragged at once.
export const DRAG_LOCAL_FILE = 'application/x-local-file-path'
export const DRAG_IPOD_TRACK = 'application/x-ipod-track-id'

declare global {
  interface Window {
    ipodBridge?: {
      getPathForFile(file: File): string
    }
  }
}

// Response of POST /api/local/set-tags/preview (see backend/src/id3-tags.ts, previewTags).
export interface TagsPreview {
  total: number // mp3 files in the selection
  skipped: number // of those, files not inside artist/album folders
  examples: {
    fileName: string
    folder: string | null
    before: { title: string | null; album: string | null; artist: string | null; hasCover: boolean }
    after: { title: string; album: string; artist: string } | null
    cover: string | null
  }[]
}
