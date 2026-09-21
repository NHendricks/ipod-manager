// iPod Classic access via libgpod, which has no maintained Windows build. Instead we shell out
// to WSL (Ubuntu-24.04, see wsl/build.sh) and run wsl/ipodctl.c against the drive's WSL mount
// path (/mnt/<letter>/...) - see wsl/ipodctl.c for the protocol (one JSON line per command).
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseFile } from 'music-metadata'

const execFileAsync = promisify(execFile)

const WSL_DISTRO = 'Ubuntu-24.04'

// backend/dist/index.js (packaged) or backend/src/ipod.ts (dev) -> repo root is two levels up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const IPODCTL_WINDOWS_PATH = path.join(REPO_ROOT, 'wsl', 'build', 'ipodctl')

export class IpodError extends Error {}

function windowsToWsl(windowsPath: string): string {
  const normalized = windowsPath.replace(/\\/g, '/')
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized)
  if (!match) throw new IpodError(`Cannot map path onto a WSL mount: ${windowsPath}`)
  const [, drive, rest] = match
  return `/mnt/${drive.toLowerCase()}/${rest}`
}

// Every ipodctl call goes through this queue: libgpod isn't safe against two processes touching
// the same iTunesDB at once (a status poll parsing the database while a batch rewrites it would
// read a half-written file), so they run strictly one after another.
let ipodctlQueue: Promise<unknown> = Promise.resolve()

/** Called with the number of items a batch command has finished so far (see report_progress in ipodctl.c). */
type ProgressCallback = (done: number) => void

function runIpodctl(args: string[], onProgress?: ProgressCallback): Promise<any> {
  const result = ipodctlQueue.then(() => execIpodctl(args, onProgress))
  ipodctlQueue = result.catch(() => {})
  return result.catch((err) => {
    mountVerifiedAt.clear() // whatever went wrong, re-check the WSL mount on the next request
    throw err
  })
}

// Runs ipodctl and streams its stdout so progress lines can be reported while it is still running.
// Resolves with everything printed once the process exits (also on a non-zero exit: ipodctl
// still prints a JSON error line then); if it couldn't be started at all, stdout is empty and
// `failure` says why.
function spawnIpodctl(args: string[], onProgress?: ProgressCallback): Promise<{ stdout: string; failure?: string }> {
  return new Promise((resolve) => {
    const child = spawn('wsl.exe', ['-d', WSL_DISTRO, '--', windowsToWsl(IPODCTL_WINDOWS_PATH), ...args], {
      windowsHide: true,
    })
    const chunks: string[] = []
    let unparsed = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      chunks.push(text)
      if (!onProgress) return
      unparsed += text
      const lines = unparsed.split('\n')
      unparsed = lines.pop() ?? ''
      for (const line of lines) {
        const match = /^\{"progress":(\d+)\}$/.exec(line.trim())
        if (match) onProgress(Number(match[1]))
      }
    })
    child.on('error', (err) => resolve({ stdout: chunks.join(''), failure: err.message }))
    child.on('close', () => resolve({ stdout: chunks.join('') }))
  })
}

async function execIpodctl(args: string[], onProgress?: ProgressCallback): Promise<any> {
  const { stdout, failure } = await spawnIpodctl(args, onProgress)
  if (!stdout.trim()) {
    throw new IpodError(
      `Could not run the iPod helper via WSL (${WSL_DISTRO}). Is WSL installed and set up per README? ${failure ?? ''}`.trim(),
    )
  }
  const line = stdout.trim().split('\n').pop() ?? ''
  let parsed: any
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new IpodError(`Unexpected output from iPod helper: ${stdout}`)
  }
  if (parsed.error) throw new IpodError(parsed.error)
  return parsed
}

export interface IpodLocation {
  driveLetter: string
  windowsRoot: string
  wslMountpoint: string
}

/**
 * WSL2 only auto-mounts drives that were already attached when the WSL instance started -
 * a drive plugged in afterwards (like the iPod) can be invisible at /mnt/<letter> until this
 * runs. Cheap and idempotent, so it's fine to call before every operation.
 */
async function ensureWslMount(driveLetter: string): Promise<void> {
  // Starting wsl.exe costs a noticeable fraction of a second and this runs on every API call
  // (the UI polls the status every few seconds), so trust a successful check for a while.
  // runIpodctl clears this on any failure.
  const lastOk = mountVerifiedAt.get(driveLetter)
  if (lastOk !== undefined && Date.now() - lastOk < MOUNT_CHECK_TTL_MS) return
  const lower = driveLetter.toLowerCase()
  // `mountpoint` alone isn't enough: after the iPod is re-plugged (or drops off mid-operation) WSL
  // keeps a dead 9p mount at /mnt/<letter> that still "is a mountpoint" but fails every access
  // ("Couldn't find an iPod database"). So probe for the iPod folder, and if that fails, drop the
  // stale mount and mount the drive again.
  const script = `test -d /mnt/${lower}/iPod_Control || (umount -l /mnt/${lower} 2>/dev/null; mkdir -p /mnt/${lower} && mount -t drvfs ${driveLetter.toUpperCase()}: /mnt/${lower})`
  await execFileAsync('wsl.exe', ['-d', WSL_DISTRO, '-u', 'root', '--', 'bash', '-lc', script]).then(
    () => mountVerifiedAt.set(driveLetter, Date.now()),
    () => {
      // best-effort - if this fails, the ipodctl call below will surface a clear error anyway
    },
  )
}

const MOUNT_CHECK_TTL_MS = 30_000
const mountVerifiedAt = new Map<string, number>()

/** Scans drive letters for a mounted iPod (identified by its iPod_Control folder). */
export async function findIpod(): Promise<IpodLocation | null> {
  if (process.platform !== 'win32') return null
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const driveLetter = String.fromCharCode(code)
    const windowsRoot = `${driveLetter}:\\`
    try {
      await fs.access(path.join(windowsRoot, 'iPod_Control'))
      await ensureWslMount(driveLetter)
      return { driveLetter, windowsRoot, wslMountpoint: windowsToWsl(windowsRoot) }
    } catch {
      // not this drive
    }
  }
  return null
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

export async function getInfo(ipod: IpodLocation): Promise<IpodInfo> {
  return runIpodctl(['info', ipod.wslMountpoint])
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

export async function listTracks(ipod: IpodLocation): Promise<IpodTrack[]> {
  const result = await runIpodctl(['list', ipod.wslMountpoint])
  return result.tracks
}

function itunesDbPath(ipod: IpodLocation): string {
  return path.join(ipod.windowsRoot, 'iPod_Control', 'iTunes', 'iTunesDB')
}

/**
 * Backs up iTunesDB before every write: once-ever as ".pristine" (recovers from anything this
 * app ever did), and every time as ".previous" (undoes just the last write). The libgpod version
 * we shell out to is from 2013 and can be a bit lossy with newer iTunes' smart-playlist rule
 * types on write (visible as "Unknown action type" warnings) - these backups are the safety net.
 */
async function backupItunesDb(ipod: IpodLocation): Promise<void> {
  const dbPath = itunesDbPath(ipod)
  const pristine = `${dbPath}.pristine.bak`
  const previous = `${dbPath}.previous.bak`
  try {
    await fs.access(pristine)
  } catch {
    await fs.copyFile(dbPath, pristine)
  }
  await fs.copyFile(dbPath, previous)
}

export interface AddTrackResult {
  id?: number
  ipodPath?: string
  artwork?: number
  error?: string
}

/** Runs `fn` with a scratch directory (for batch files and cover images) that is removed afterwards. */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipod-batch-'))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

// Batch files are tab-separated lines, so tabs/newlines inside a tag must not survive.
const COLUMN_SEP = '\t'
const LINE_SEP = '\n'
const column = (value: unknown): string => String(value ?? '').replace(/[\t\r\n]+/g, ' ')

// Tracks per ipodctl invocation. Each invocation parses and writes the iTunesDB once, which is what
// makes batches fast; the cap bounds what an interruption can leave half-done (files copied whose
// database entries were never written) and how much is redone.
const WRITE_CHUNK_SIZE = 25

/**
 * Reads ID3/MP4 tags from local files and copies them onto the iPod in batches (one iTunesDB
 * parse and one write per batch - per-file invocations spent nearly all their time re-reading and
 * re-writing the database). Results are in the same order as `windowsFilePaths`; `onProgress`
 * gets the number of files finished so far.
 */
export async function addTracks(
  ipod: IpodLocation,
  windowsFilePaths: string[],
  onProgress?: ProgressCallback,
): Promise<AddTrackResult[]> {
  if (windowsFilePaths.length === 0) return []
  await backupItunesDb(ipod) // once per job, so ".previous" undoes the whole job
  const results: AddTrackResult[] = []
  for (let i = 0; i < windowsFilePaths.length; i += WRITE_CHUNK_SIZE) {
    const chunk = windowsFilePaths.slice(i, i + WRITE_CHUNK_SIZE)
    results.push(...(await addChunk(ipod, chunk, (done) => onProgress?.(i + done))))
    onProgress?.(i + chunk.length)
  }
  return results
}

async function addChunk(ipod: IpodLocation, windowsFilePaths: string[], onProgress: ProgressCallback): Promise<AddTrackResult[]> {
  return withTempDir(async (dir) => {
    const lines: string[] = []
    for (const [i, filePath] of windowsFilePaths.entries()) {
      const tags = await parseFile(filePath).catch(() => null)
      const common = tags?.common
      const format = tags?.format

      // libgpod builds the iPod's thumbnails from an image file, so hand it the embedded cover as a temp file.
      const picture = common?.picture?.find((p) => p.format === 'image/jpeg' || p.format === 'image/png')
      let coverFile = ''
      if (picture) {
        coverFile = path.join(dir, `cover-${i}.${picture.format === 'image/png' ? 'png' : 'jpg'}`)
        await fs.writeFile(coverFile, picture.data)
      }

      lines.push(
        [
          windowsToWsl(filePath),
          column(common?.title),
          column(common?.artist),
          column(common?.album),
          column(common?.genre?.[0]),
          String(common?.track?.no ?? 0),
          String(common?.year ?? 0),
          String(Math.round((format?.duration ?? 0) * 1000)),
          String(Math.round((format?.bitrate ?? 0) / 1000)),
          String(Math.round(format?.sampleRate ?? 0)),
          '', // filetype: let ipodctl guess it from the file extension
          coverFile ? windowsToWsl(coverFile) : '',
        ].join(COLUMN_SEP),
      )
    }
    const batchFile = path.join(dir, 'add.tsv')
    await fs.writeFile(batchFile, lines.join(LINE_SEP) + LINE_SEP)

    const { results } = await runIpodctl(['add-batch', ipod.wslMountpoint, windowsToWsl(batchFile)], onProgress)
    return results as AddTrackResult[]
  })
}

/** Removes tracks (database entries and audio files), one database write per batch. */
export async function removeTracks(
  ipod: IpodLocation,
  trackIds: number[],
  onProgress?: ProgressCallback,
): Promise<{ removed: number; missing: number }> {
  const total = { removed: 0, missing: 0 }
  if (trackIds.length === 0) return total
  await backupItunesDb(ipod) // once per job, so ".previous" undoes the whole job
  for (let i = 0; i < trackIds.length; i += WRITE_CHUNK_SIZE) {
    const chunk = trackIds.slice(i, i + WRITE_CHUNK_SIZE)
    const result = await runIpodctl(['remove', ipod.wslMountpoint, ...chunk.map(String)], (done) => onProgress?.(i + done))
    total.removed += result.removed
    total.missing += result.missing
    onProgress?.(i + chunk.length)
  }
  return total
}

/** Windows path of the audio file behind a track (ipodPath looks like ":iPod_Control:Music:F00:ABCD.mp3"). */
export function trackWindowsPath(ipod: IpodLocation, track: IpodTrack): string {
  return path.join(ipod.windowsRoot, ...track.ipodPath.split(':').filter(Boolean))
}

export interface ExportItem {
  trackId: number
  destWindowsFilePath: string
}

/** Copies tracks off the iPod to local destination files (not directories), parsing the database once. */
export async function exportTracks(
  ipod: IpodLocation,
  items: ExportItem[],
  onProgress?: ProgressCallback,
): Promise<{ destfile?: string; error?: string }[]> {
  if (items.length === 0) return []
  return withTempDir(async (dir) => {
    const batchFile = path.join(dir, 'extract.tsv')
    await fs.writeFile(
      batchFile,
      items.map((item) => [item.trackId, windowsToWsl(item.destWindowsFilePath)].join(COLUMN_SEP)).join(LINE_SEP) + LINE_SEP,
    )
    const { results } = await runIpodctl(['extract-batch', ipod.wslMountpoint, windowsToWsl(batchFile)], onProgress)
    return results
  })
}
