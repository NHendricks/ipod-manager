// Sets ID3 tags of mp3 files from where they live on disk: <artist>/<album>/<title>.mp3.
// A port of MyMp3File.java (d:\dev\tools.src) - the iPod sorts and groups by these tags in odd
// ways (no track numbers are set, so it orders an album by title), so the same tricks are kept:
// zero-padded titles, "Track 1" -> "Track 01", CD1 -> CD01, ID3v1 removed, 256x256 cover.
import fs from 'node:fs/promises'
import path from 'node:path'
import NodeID3 from 'node-id3'
import { Jimp } from 'jimp'
import { parseFile } from 'music-metadata'

export interface TagOptions {
  /** If set and found in the title, the text before it is appended to the album ("CD1-Track 01" -> album + " CD01"). */
  albumDelimiter?: string
  /** If set and found in the title, the text before it becomes the artist. */
  artistDelimiter?: string
}

export interface FolderTags {
  title: string
  album: string
  artist: string
}

/**
 * Title, album and artist for `<artistDir>/<albumDir>/<fileName>`, or null when the file is not
 * nested two folders deep (a drive root has no name).
 */
export function tagsFromPath(filePath: string, options: TagOptions = {}): FolderTags | null {
  const albumDir = path.dirname(filePath)
  const artistDir = path.dirname(albumDir)
  const albumName = path.basename(albumDir)
  const artistName = path.basename(artistDir)
  if (!albumName || !artistName || albumDir === artistDir) return null

  let title = path.basename(filePath, path.extname(filePath))
  // "1-hello" -> "01-hello", so it sorts right.
  if (title.length >= 2 && title[1] === '-') title = '0' + title
  // "... Track 1" -> "... Track 01" (the iPod evaluates the word Track and the digit; 2-digit
  // numbers are left alone). Sequences like CD1-Track1, CD2-Track1, CD1-Track2 sorted wrongly.
  title = title.replace(/.rack ([1-9])$/, 'Track 0$1')

  let album = albumName
  const albumDelimiter = options.albumDelimiter
  if (albumDelimiter) {
    const index = title.indexOf(albumDelimiter)
    if (index > 0) {
      // CD1 -> CD01 so that CD2 sorts before CD10.
      const cd = title.substring(0, index).replace(/^CD([1-9])$/, 'CD0$1')
      album = `${album} ${cd}`
    }
  }

  let artist = artistName
  const artistDelimiter = options.artistDelimiter
  if (artistDelimiter) {
    const index = title.indexOf(artistDelimiter)
    if (index > 0) artist = title.substring(0, index)
  }

  return { title, album, artist }
}

const COVER_SIZE = 256

/** Reads an image and scales it to 256x256 JPEG (stretched, like the Java tool); null if unreadable. */
async function scaledCover(imagePath: string): Promise<Buffer | null> {
  try {
    const image = await Jimp.read(imagePath)
    image.resize({ w: COVER_SIZE, h: COVER_SIZE })
    return await image.getBuffer('image/jpeg')
  } catch {
    return null
  }
}

// One cover per folder (all its mp3s get the same one).
const coverCache = new Map<string, Promise<Buffer | null>>()

/** Name of the folder's cover image: Folder.jpg, else its last .jpg/.jpeg by name; null if none. */
export async function findFolderCoverName(dir: string): Promise<string | null> {
  const names = (await fs.readdir(dir).catch(() => [] as string[])).sort((a, b) => a.localeCompare(b))
  const jpgs = names.filter((n) => /\.jpe?g$/i.test(n))
  return jpgs.find((n) => n.toLowerCase() === 'folder.jpg') ?? jpgs[jpgs.length - 1] ?? null
}

/** The folder's cover image (see findFolderCoverName), scaled down. */
function folderCover(dir: string): Promise<Buffer | null> {
  let cover = coverCache.get(dir)
  if (!cover) {
    cover = (async () => {
      const chosen = await findFolderCoverName(dir)
      return chosen ? scaledCover(path.join(dir, chosen)) : null
    })()
    coverCache.set(dir, cover)
  }
  return cover
}

/** Drops an ID3v1 tag (the last 128 bytes, starting with "TAG"); the iPod can trip over v1 + v2 together. */
function stripId3v1(data: Buffer): Buffer {
  const start = data.length - 128
  return start >= 0 && data.toString('latin1', start, start + 3) === 'TAG' ? data.subarray(0, start) : data
}

export type SetTagsResult = 'tagged' | 'skipped'

/**
 * Rewrites the ID3 tags of one mp3 in place: title/album/artist from its path, ID3v1 removed,
 * the folder's cover embedded (an existing embedded cover is kept when the folder has none).
 * The file is written next to the original and renamed over it, so a crash can't leave a
 * half-written mp3 behind.
 */
export async function setTagsFromPath(filePath: string, options: TagOptions = {}): Promise<SetTagsResult> {
  const folderTags = tagsFromPath(filePath, options)
  if (!folderTags) return 'skipped'

  const tags: NodeID3.Tags = { title: folderTags.title, album: folderTags.album, artist: folderTags.artist }
  const cover = await folderCover(path.dirname(filePath))
  if (cover) {
    tags.image = { mime: 'image/jpeg', type: { id: 3, name: 'front cover' }, description: '', imageBuffer: cover }
  }

  const original = await fs.readFile(filePath)
  const updated = stripId3v1(NodeID3.update(tags, original))
  const tempPath = `${filePath}.tagtmp`
  try {
    await fs.writeFile(tempPath, updated)
    await fs.rename(tempPath, filePath)
  } catch (err) {
    await fs.rm(tempPath, { force: true })
    throw err
  }
  return 'tagged'
}

export interface TagPreview {
  fileName: string
  /** "Artist/Album" as read from the path, or null if the file isn't nested two folders deep (it would be skipped). */
  folder: string | null
  before: { title: string | null; album: string | null; artist: string | null; hasCover: boolean }
  after: FolderTags | null
  /** File name of the folder image that would be embedded, if any. */
  cover: string | null
}

/** What setTagsFromPath would do to one file, without touching it. */
export async function previewTags(filePath: string, options: TagOptions = {}): Promise<TagPreview> {
  const after = tagsFromPath(filePath, options)
  const meta = await parseFile(filePath).catch(() => null)
  const albumDir = path.dirname(filePath)
  return {
    fileName: path.basename(filePath),
    folder: after ? `${path.basename(path.dirname(albumDir))}/${path.basename(albumDir)}` : null,
    before: {
      title: meta?.common.title ?? null,
      album: meta?.common.album ?? null,
      artist: meta?.common.artist ?? null,
      hasCover: !!meta?.common.picture?.length,
    },
    after,
    cover: after ? await findFolderCoverName(albumDir) : null,
  }
}

/** Forget cached covers, so a later run sees a Folder.jpg that changed in between. */
export function clearCoverCache(): void {
  coverCache.clear()
}
