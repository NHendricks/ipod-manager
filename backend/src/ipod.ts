// iPod Classic access via libgpod, which has no maintained Windows build. Instead we shell out
// to WSL (Ubuntu-24.04, see wsl/build.sh) and run wsl/ipodctl.c against the drive's WSL mount
// path (/mnt/<letter>/...) - see wsl/ipodctl.c for the protocol (one JSON line per command).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
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

async function runIpodctl(args: string[]): Promise<any> {
  const ipodctl = windowsToWsl(IPODCTL_WINDOWS_PATH)
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync('wsl.exe', ['-d', WSL_DISTRO, '--', ipodctl, ...args], {
      maxBuffer: 256 * 1024 * 1024, // a large library's "list" JSON can run into the tens of MB
    }))
  } catch (err: any) {
    // execFile rejects on non-zero exit, but ipodctl still prints a JSON error line on stdout.
    stdout = err.stdout ?? ''
    if (!stdout.trim()) {
      throw new IpodError(
        `Could not run the iPod helper via WSL (${WSL_DISTRO}). Is WSL installed and set up per README? ${err.message}`,
      )
    }
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
  const lower = driveLetter.toLowerCase()
  const script = `mountpoint -q /mnt/${lower} || (mkdir -p /mnt/${lower} && mount -t drvfs ${driveLetter.toUpperCase()}: /mnt/${lower})`
  await execFileAsync('wsl.exe', ['-d', WSL_DISTRO, '-u', 'root', '--', 'bash', '-lc', script]).catch(() => {
    // best-effort - if this fails, the ipodctl call below will surface a clear error anyway
  })
}

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

/** Reads ID3/MP4 tags from a local file and copies it onto the iPod, updating iTunesDB. */
export async function addTrack(
  ipod: IpodLocation,
  windowsFilePath: string,
): Promise<{ id: number; ipodPath: string }> {
  await backupItunesDb(ipod)
  const tags = await parseFile(windowsFilePath).catch(() => null)
  const common = tags?.common
  const format = tags?.format

  const args = [
    'add',
    ipod.wslMountpoint,
    windowsToWsl(windowsFilePath),
    common?.title ?? '',
    common?.artist ?? '',
    common?.album ?? '',
    common?.genre?.[0] ?? '',
    String(common?.track?.no ?? 0),
    String(common?.year ?? 0),
    String(Math.round((format?.duration ?? 0) * 1000)),
    String(Math.round((format?.bitrate ?? 0) / 1000)),
    String(Math.round(format?.sampleRate ?? 0)),
    '', // filetype: let ipodctl guess it from the file extension
  ]
  return runIpodctl(args)
}

export async function removeTrack(ipod: IpodLocation, trackId: number): Promise<void> {
  await backupItunesDb(ipod)
  await runIpodctl(['remove', ipod.wslMountpoint, String(trackId)])
}

/** Windows path of the audio file behind a track (ipodPath looks like ":iPod_Control:Music:F00:ABCD.mp3"). */
export function trackWindowsPath(ipod: IpodLocation, track: IpodTrack): string {
  return path.join(ipod.windowsRoot, ...track.ipodPath.split(':').filter(Boolean))
}

/** Copies a track off the iPod to a local destination file (not a directory). */
export async function exportTrack(
  ipod: IpodLocation,
  trackId: number,
  destWindowsFilePath: string,
): Promise<void> {
  await runIpodctl(['extract', ipod.wslMountpoint, String(trackId), windowsToWsl(destWindowsFilePath)])
}
