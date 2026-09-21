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

// What F3 shows metadata for; panes announce it via a bubbling "selection-change" event.
export type Selection = { kind: 'local'; path: string } | { kind: 'ipod'; id: number }

export interface IpodStatus {
  connected: boolean
  driveLetter?: string
  info?: IpodInfo
  error?: string
}

// application/x-* custom drag payload types shared between local-pane and ipod-pane.
export const DRAG_LOCAL_FILE = 'application/x-local-file-path'
export const DRAG_IPOD_TRACK = 'application/x-ipod-track-id'

declare global {
  interface Window {
    ipodBridge?: {
      getPathForFile(file: File): string
    }
  }
}
