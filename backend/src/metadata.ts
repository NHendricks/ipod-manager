// Reads ID3/MP4/etc. tags plus technical stream info from an audio file for the F3 metadata dialog.
import fs from 'node:fs/promises'
import path from 'node:path'
import { parseFile } from 'music-metadata'

export type MetadataRow = [label: string, value: string]

export interface FileMetadata {
  fileName: string
  path: string
  tags: MetadataRow[]
  technical: MetadataRow[]
  cover: string | null // data: URL of the first embedded picture
}

const MAX_COVER_BYTES = 4 * 1024 * 1024

function pushRow(rows: MetadataRow[], label: string, value: unknown): void {
  if (value === undefined || value === null || value === '') return
  const text = Array.isArray(value) ? value.join(', ') : String(value)
  if (text.trim()) rows.push([label, text])
}

function ofTotal(entry: { no: number | null; of: number | null } | undefined): string | undefined {
  if (!entry || entry.no === null) return undefined
  return entry.of ? `${entry.no} / ${entry.of}` : String(entry.no)
}

function formatDuration(seconds: number): string {
  const total = Math.round(seconds)
  const m = Math.floor(total / 60)
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export async function readMetadata(filePath: string): Promise<FileMetadata> {
  const [meta, stat] = await Promise.all([parseFile(filePath), fs.stat(filePath)])
  const { common, format } = meta

  const tags: MetadataRow[] = []
  pushRow(tags, 'Title', common.title)
  pushRow(tags, 'Artist', common.artists?.length ? common.artists : common.artist)
  pushRow(tags, 'Album', common.album)
  pushRow(tags, 'Album artist', common.albumartist)
  pushRow(tags, 'Year', common.year)
  pushRow(tags, 'Track', ofTotal(common.track))
  pushRow(tags, 'Disc', ofTotal(common.disk))
  pushRow(tags, 'Genre', common.genre)
  pushRow(tags, 'Composer', common.composer)
  pushRow(tags, 'BPM', common.bpm)
  pushRow(tags, 'Label', common.label)
  pushRow(tags, 'Comment', common.comment?.map((c) => (typeof c === 'string' ? c : c.text)))
  pushRow(tags, 'Copyright', common.copyright)

  const technical: MetadataRow[] = []
  pushRow(technical, 'Format', [format.container, format.codec].filter(Boolean).join(' / '))
  pushRow(technical, 'Duration', format.duration !== undefined ? formatDuration(format.duration) : undefined)
  pushRow(technical, 'Bitrate', format.bitrate ? `${Math.round(format.bitrate / 1000)} kbps` : undefined)
  pushRow(technical, 'Sample rate', format.sampleRate ? `${format.sampleRate} Hz` : undefined)
  pushRow(technical, 'Bits per sample', format.bitsPerSample)
  pushRow(technical, 'Channels', format.numberOfChannels)
  pushRow(technical, 'Lossless', format.lossless === undefined ? undefined : format.lossless ? 'yes' : 'no')
  pushRow(technical, 'Encoder', format.tool)
  pushRow(technical, 'Tag types', format.tagTypes)
  pushRow(technical, 'File size', formatSize(stat.size))

  const picture = common.picture?.[0]
  const cover =
    picture && picture.data.length <= MAX_COVER_BYTES
      ? `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`
      : null

  return { fileName: path.basename(filePath), path: filePath, tags, technical, cover }
}
