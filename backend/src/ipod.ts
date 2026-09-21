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

/**
 * Runs ipodctl; if libgpod can't find the database, the WSL mount is most likely dead (iPod
 * re-plugged), so remount once and retry. Safe for every command: they all parse the database
 * first, before copying or deleting anything.
 */
async function execWithMountRepair(args: string[], onProgress?: ProgressCallback): Promise<any> {
  try {
    return await execIpodctl(args, onProgress)
  } catch (err) {
    const letter = /^\/mnt\/([a-z])(?:\/|$)/.exec(args[1] ?? '')?.[1]
    if (!ejecting && letter && err instanceof IpodError && /Couldn't find an iPod database/.test(err.message)) {
      await ensureWslMount(letter.toUpperCase(), true)
      return execIpodctl(args, onProgress)
    }
    throw err
  }
}

function runIpodctl(args: string[], onProgress?: ProgressCallback): Promise<any> {
  const result = ipodctlQueue.then(() => execWithMountRepair(args, onProgress))
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
async function ensureWslMount(driveLetter: string, force = false): Promise<void> {
  // Starting wsl.exe costs a noticeable fraction of a second and this runs on every API call
  // (the UI polls the status every few seconds), so trust a successful check for a while.
  // runIpodctl clears this on any failure.
  if (ejecting) return // the drive is being released - don't mount it again
  const lastOk = mountVerifiedAt.get(driveLetter)
  if (!force && lastOk !== undefined && Date.now() - lastOk < MOUNT_CHECK_TTL_MS) return
  const lower = driveLetter.toLowerCase()
  const remount = `umount -l /mnt/${lower} 2>/dev/null; mkdir -p /mnt/${lower} && mount -t drvfs ${driveLetter.toUpperCase()}: /mnt/${lower}`
  // `mountpoint` alone isn't enough: after the iPod is re-plugged (or drops off mid-operation) WSL
  // keeps a dead 9p mount at /mnt/<letter> that still "is a mountpoint" but fails every access
  // ("Couldn't find an iPod database"). Probing with `test -d` isn't enough either - WSL caches
  // directory entries, so it can say yes for a dead mount. Listing the directory forces real I/O
  // to the device. If that fails, drop the stale mount and mount the drive again.
  const script = force ? remount : `ls -a /mnt/${lower}/iPod_Control >/dev/null 2>&1 || (${remount})`
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
  /** The file had a cover but it could not be stored on the iPod. */
  coverSkipped?: boolean
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
  /** Also put each file's embedded cover into the iPod's artwork database (off unless asked for). */
  artwork = false,
): Promise<AddTrackResult[]> {
  if (windowsFilePaths.length === 0) return []
  await backupItunesDb(ipod) // once per job, so ".previous" undoes the whole job
  const results: AddTrackResult[] = []
  for (let i = 0; i < windowsFilePaths.length; i += WRITE_CHUNK_SIZE) {
    const chunk = windowsFilePaths.slice(i, i + WRITE_CHUNK_SIZE)
    results.push(...(await addChunk(ipod, chunk, (done) => onProgress?.(i + done), artwork)))
    onProgress?.(i + chunk.length)
  }
  return results
}

async function addChunk(
  ipod: IpodLocation,
  windowsFilePaths: string[],
  onProgress: ProgressCallback,
  artwork: boolean,
): Promise<AddTrackResult[]> {
  return withTempDir(async (dir) => {
    const lines: string[] = []
    const hadCover: boolean[] = [] // per file: a cover was handed to ipodctl
    for (const [i, filePath] of windowsFilePaths.entries()) {
      const tags = await parseFile(filePath).catch(() => null)
      const common = tags?.common
      const format = tags?.format

      // libgpod builds the iPod's thumbnails from an image file, so hand it the embedded cover as a temp file.
      const picture = !artwork ? undefined : common?.picture?.find((p) => p.format === 'image/jpeg' || p.format === 'image/png')
      let coverFile = ''
      if (picture) {
        coverFile = path.join(dir, `cover-${i}.${picture.format === 'image/png' ? 'png' : 'jpg'}`)
        await fs.writeFile(coverFile, picture.data)
      }
      hadCover.push(!!coverFile)

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

    const { results } = (await runIpodctl(['add-batch', ipod.wslMountpoint, windowsToWsl(batchFile)], onProgress)) as {
      results: AddTrackResult[]
    }
    // ipodctl can't store a cover on an iPod whose model it doesn't know (empty SysInfo); say so.
    return results.map((r, i) => (hadCover[i] && !r.error && r.artwork !== 1 ? { ...r, coverSkipped: true } : r))
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

/** Number of files under iPod_Control/Music - the progress total for {@link resetLibrary}. */
export async function countMusicFiles(ipod: IpodLocation): Promise<number> {
  const music = path.join(ipod.windowsRoot, 'iPod_Control', 'Music')
  let count = 0
  for (const sub of await fs.readdir(music).catch(() => [] as string[])) {
    const entries = await fs.readdir(path.join(music, sub), { withFileTypes: true }).catch(() => [])
    count += entries.filter((e) => e.isFile()).length
  }
  return count
}

/**
 * Empties the iPod's library: removes every track from the database and deletes every file in
 * iPod_Control/Music. Firmware, settings and other folders stay. iTunesDB is backed up first, but
 * the deleted audio files can't be restored.
 */
export async function resetLibrary(
  ipod: IpodLocation,
  onProgress?: ProgressCallback,
): Promise<{ removedTracks: number; deletedFiles: number }> {
  await backupItunesDb(ipod)
  return runIpodctl(['reset', ipod.wslMountpoint], onProgress)
}

export interface IpodSysInfo {
  /** Product code as printed in the iPod's Settings > About, e.g. "MB565". */
  modelNumber: string | null
  serialNumber: string | null
  firmwareVersion: string | null
  /** 16 hex digits; an iPod Classic's database must be signed with it. */
  firewireGuid: string | null
}

/**
 * Reads iPod_Control/Device/SysInfo ("Key: value" lines written by iTunes). The file is empty on an
 * iPod that never synced with iTunes, in which case libgpod can't identify the model either.
 */
export async function readSysInfo(ipod: IpodLocation): Promise<IpodSysInfo> {
  const text = await fs.readFile(path.join(ipod.windowsRoot, 'iPod_Control', 'Device', 'SysInfo'), 'utf8').catch(() => '')
  const values = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon > 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
  }
  // ModelNumStr is stored with a leading "x" standing in for the "M" of the product code (xA623 = MA623).
  const model = values.get('ModelNumStr')?.replace(/^x/i, 'M') || null
  return {
    modelNumber: model,
    serialNumber: values.get('pszSerialNumber') || null,
    firewireGuid: values.get('FirewireGuid')?.replace(/^0x/i, '') || null,
    // "0x02008000 (2.0.0)": the parenthesised part is the version shown to users.
    firmwareVersion: /\(([^)]+)\)/.exec(values.get('visibleBuildID') ?? '')?.[1] ?? (values.get('visibleBuildID') || null),
  }
}

// ── Repair: SysInfo + signed database ─────────────────────────────────────────
// An iPod Classic only accepts an iTunesDB that carries a checksum computed from the device's
// FireWire GUID; without one it shows "No Music". libgpod signs the database only if it knows the
// GUID and the model - both normally come from iPod_Control/Device/SysInfo, which iTunes writes on
// the first sync and which is empty on an iPod that never met iTunes (or was just restored).

export interface ClassicModel {
  modelNumber: string
  name: string
  capacityGB: number
}

/** iPod Classic models known to libgpod (used to pick the model when SysInfo is empty). */
export async function listClassicModels(): Promise<ClassicModel[]> {
  return (await runIpodctl(['models', '-'])).models
}

/** The iPod's FireWire GUID = the serial number in its USB device path (Windows). */
export async function getFirewireGuid(ipod: IpodLocation): Promise<string | null> {
  if (!/^[A-Z]$/.test(ipod.driveLetter)) return null
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `(Get-Partition -DriveLetter ${ipod.driveLetter} | Get-Disk).Path`,
    ])
    return /#([0-9a-f]{16})&\d+#/i.exec(stdout)?.[1].toUpperCase() ?? null
  } catch {
    return null
  }
}

/** Overwrites SysInfo via WSL, so the WSL side (libgpod) sees the new content right away. */
async function writeSysInfo(ipod: IpodLocation, content: string): Promise<void> {
  await withTempDir(async (dir) => {
    const source = path.join(dir, 'SysInfo')
    await fs.writeFile(source, content)
    const target = `${ipod.wslMountpoint}iPod_Control/Device/SysInfo`
    await execFileAsync('wsl.exe', ['-d', WSL_DISTRO, '--', 'cp', windowsToWsl(source), target])
  })
}

/** A database is signed if its header (offset 0x30) names a hashing scheme. */
async function isDatabaseSigned(ipod: IpodLocation): Promise<boolean> {
  const handle = await fs.open(itunesDbPath(ipod), 'r')
  try {
    const header = Buffer.alloc(0x32)
    await handle.read(header, 0, header.length, 0)
    return header.readUInt16LE(0x30) !== 0
  } finally {
    await handle.close()
  }
}

/**
 * Writes the model and FireWire GUID into SysInfo and re-saves the database so it gets signed.
 * Every step is undone (SysInfo restored) if libgpod doesn't accept the model or the result is
 * still unsigned. iTunesDB is backed up first; an existing non-empty SysInfo is kept as SysInfo.bak.
 */
export async function repairSysInfo(
  ipod: IpodLocation,
  modelNumber: string,
): Promise<{ modelNumber: string; firewireGuid: string; tracks: number }> {
  if (!(await listClassicModels()).some((m) => m.modelNumber === modelNumber)) {
    throw new IpodError(`Unknown iPod model: ${modelNumber}`)
  }
  const firewireGuid = await getFirewireGuid(ipod)
  if (!firewireGuid) throw new IpodError("Could not read the iPod's FireWire GUID from Windows (USB serial number).")

  const sysInfoPath = path.join(ipod.windowsRoot, 'iPod_Control', 'Device', 'SysInfo')
  const previous = await fs.readFile(sysInfoPath, 'utf8').catch(() => '')
  if (previous.trim()) await fs.copyFile(sysInfoPath, `${sysInfoPath}.bak`)
  const kept = previous.split(/\r?\n/).filter((line) => line.trim() && !/^(ModelNumStr|FirewireGuid):/i.test(line))
  // libgpod drops the first character of ModelNumStr ("MC293" -> model C293).
  const content = [...kept, `ModelNumStr: M${modelNumber}`, `FirewireGuid: 0x${firewireGuid}`].join('\n') + '\n'

  await writeSysInfo(ipod, content)
  try {
    const info = await getInfo(ipod)
    if (!info.modelName || info.modelName === 'Invalid' || info.modelName === 'Unknown') {
      throw new IpodError(`libgpod does not recognise model ${modelNumber}`)
    }
    await backupItunesDb(ipod)
    const { tracks } = await runIpodctl(['rewrite', ipod.wslMountpoint])
    if (!(await isDatabaseSigned(ipod))) throw new IpodError('The database was written but is still not signed.')
    return { modelNumber, firewireGuid, tracks }
  } catch (err) {
    await writeSysInfo(ipod, previous).catch(() => {}) // put the old (possibly empty) SysInfo back
    throw err
  }
}

// ── Eject ─────────────────────────────────────────────────────────────────────

// While ejecting, nothing may mount the drive into WSL again (the periodic status poll would).
let ejecting = false

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Safely removes the iPod like "Eject" in Explorer: waits for running iPod commands, releases the
 * drive from WSL (a mounted drive would make Windows refuse: "in use"), then asks Windows to eject
 * it and waits until the drive letter is gone. Afterwards it is safe to unplug.
 */
export function ejectIpod(ipod: IpodLocation): Promise<void> {
  if (!/^[A-Z]$/.test(ipod.driveLetter)) return Promise.reject(new IpodError('Invalid drive letter'))
  const letter = ipod.driveLetter
  const job = ipodctlQueue.then(async () => {
    ejecting = true
    try {
      const lower = letter.toLowerCase()
      await execFileAsync('wsl.exe', [
        '-d', WSL_DISTRO, '-u', 'root', '--', 'bash', '-lc',
        `sync; umount /mnt/${lower} 2>/dev/null || umount -l /mnt/${lower} 2>/dev/null; true`,
      ]).catch(() => {})
      mountVerifiedAt.delete(letter)

      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-Command',
          `$item = (New-Object -comObject Shell.Application).Namespace(17).ParseName('${letter}:'); ` +
            `if ($null -eq $item) { exit 3 }; $item.InvokeVerb('Eject')`,
        ])
      } catch (err: any) {
        if (err.code === 3) throw new IpodError(`Drive ${letter}: not found`)
        throw new IpodError(`Windows could not eject the iPod: ${err.message}`)
      }

      // The eject is asynchronous; wait for the drive to disappear.
      for (let i = 0; i < 20; i++) {
        await sleep(500)
        if (!(await fs.access(path.join(ipod.windowsRoot, 'iPod_Control')).then(() => true, () => false))) return
      }
      throw new IpodError(
        'Windows did not release the iPod - a program (e.g. Explorer) may still be using it. ' +
          'Close it, or use "Safely remove hardware" in the Windows taskbar.',
      )
    } finally {
      ejecting = false
    }
  })
  ipodctlQueue = job.catch(() => {})
  return job
}
