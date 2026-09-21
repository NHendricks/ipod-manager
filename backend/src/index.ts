import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ipod from './ipod.js'
import { collectAudioFiles, defaultLocalDir, listLocalDir } from './local-files.js'
import { readMetadata } from './metadata.js'
import { getJob, startJob } from './jobs.js'
import { clearCoverCache, previewTags, setTagsFromPath, tagsFromPath } from './id3-tags.js'
import { parseFile } from 'music-metadata'

export const app = new Hono()

const PORT = Number(process.env.PORT ?? 3001)

app.use('/*', cors({ origin: '*' }))

// ── iPod ──────────────────────────────────────────────────────────────────────

app.get('/api/ipod/status', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ connected: false })
  try {
    const [info, sysInfo] = await Promise.all([ipod.getInfo(location), ipod.readSysInfo(location)])
    return c.json({ connected: true, driveLetter: location.driveLetter, info, sysInfo })
  } catch (err: any) {
    return c.json({ connected: true, driveLetter: location.driveLetter, error: err.message })
  }
})

app.get('/api/ipod/tracks', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  try {
    return c.json({ tracks: await ipod.listTracks(location) })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/ipod/tracks', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { filePaths?: string[]; artwork?: boolean }
  if (!Array.isArray(body.filePaths) || body.filePaths.length === 0) {
    return c.json({ error: 'filePaths is required' }, 400)
  }
  // Folders in the selection stand for all the audio files below them.
  const filePaths = await collectAudioFiles(body.filePaths)
  if (filePaths.length === 0) return c.json({ error: 'No audio files found in the selection' }, 400)
  // Job result: { results } with one { id, ipodPath, artwork } or { error } per file, in order.
  return c.json(
    startJob(filePaths.length, async (advance) => ({
      results: await ipod.addTracks(location, filePaths, advance, body.artwork === true),
    })),
  )
})

// Empties the whole iPod library (all tracks and all audio files). Destructive, so the request has
// to carry an explicit confirmation token - a stray or replayed call without it does nothing.
// Job result: { removedTracks, deletedFiles }.
app.post('/api/ipod/reset', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { confirm?: string }
  if (body.confirm !== 'empty-library') return c.json({ error: 'Confirmation missing' }, 400)
  const total = await ipod.countMusicFiles(location)
  return c.json(startJob(Math.max(total, 1), (advance) => ipod.resetLibrary(location, advance)))
})

// Data for the "repair" dialog: the GUID Windows reports for the connected iPod and the models to choose from.
app.get('/api/ipod/repair-info', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  try {
    const [firewireGuid, models] = await Promise.all([ipod.getFirewireGuid(location), ipod.listClassicModels()])
    return c.json({ firewireGuid, models })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Writes model + FireWire GUID into SysInfo and re-saves the database signed (see repairSysInfo).
app.post('/api/ipod/repair', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { modelNumber?: string }
  if (!body.modelNumber) return c.json({ error: 'modelNumber is required' }, 400)
  try {
    return c.json(await ipod.repairSysInfo(location, body.modelNumber))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.get('/api/jobs/:id', (c) => {
  const job = getJob(c.req.param('id'))
  return job ? c.json(job) : c.json({ error: 'Unknown job' }, 404)
})

app.post('/api/ipod/tracks/delete', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[] }
  if (!Array.isArray(body.ids) || body.ids.length === 0) return c.json({ error: 'ids is required' }, 400)
  const ids = body.ids.map(Number)
  // Job result: { removed, missing }.
  return c.json(startJob(ids.length, (advance) => ipod.removeTracks(location, ids, advance)))
})

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

// Windows rejects folder names ending in a dot or space.
function sanitizeFolderName(name: string | null, fallback: string): string {
  return (name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/[. ]+$/, '') || fallback
}

type CoverResult = 'saved' | 'exists' | 'none'

// Saves the embedded cover of an audio file as Folder.jpg (Folder.png for PNG art) in targetDir.
// Never overwrites an existing cover, and never throws - covers are best-effort.
async function saveFolderCover(audioPath: string, targetDir: string): Promise<CoverResult> {
  try {
    const picture = (await parseFile(audioPath)).common.picture?.[0]
    if (!picture) return 'none'
    const ext = picture.format === 'image/png' ? 'png' : picture.format === 'image/jpeg' ? 'jpg' : null
    if (!ext) return 'none'
    await fs.writeFile(path.join(targetDir, `Folder.${ext}`), picture.data, { flag: 'wx' })
    return 'saved'
  } catch (err: any) {
    return err?.code === 'EEXIST' ? 'exists' : 'none'
  }
}

// Copies tracks off the iPod as a background job (see jobs.ts). Job result: { results } with one
// { path } or { error } per id, in order.
async function exportTracksJob(
  location: ipod.IpodLocation,
  ids: number[],
  destDir: string,
  organize: boolean,
  advance: (done: number) => void,
) {
  const tracks = new Map((await ipod.listTracks(location)).map((t) => [t.id, t]))
  const destPaths: (string | null)[] = []
  const items: ipod.ExportItem[] = []
  for (const id of ids) {
    const track = tracks.get(id)
    if (!track) {
      destPaths.push(null)
      continue
    }
    const ext = path.extname(track.ipodPath.replace(/:/g, '/')) || '.mp3'
    const filename = sanitizeFilename(`${track.artist ?? ''} - ${track.title ?? 'track'}`.replace(/^ - /, '')) + ext
    // "organize": <destDir>/<artist>/<album>/<file>
    const targetDir = organize
      ? path.join(
          destDir,
          sanitizeFolderName(track.artist, 'Unknown Artist'),
          sanitizeFolderName(track.album, 'Unknown Album'),
        )
      : destDir
    await fs.mkdir(targetDir, { recursive: true })
    const destPath = path.join(targetDir, filename)
    destPaths.push(destPath)
    items.push({ trackId: id, destWindowsFilePath: destPath })
  }

  const exported = await ipod.exportTracks(location, items, advance)
  const results: { path?: string; error?: string }[] = []
  const coverTried = new Set<string>() // folders whose Folder.jpg is settled
  let next = 0
  for (const destPath of destPaths) {
    if (destPath === null) {
      results.push({ error: 'Track not found' })
      continue
    }
    const outcome = exported[next++]
    if (outcome?.error || !outcome) {
      results.push({ error: outcome?.error ?? 'Export failed' })
      continue
    }
    results.push({ path: destPath })
    // Once per folder is enough; keep trying with later tracks only while they have no cover.
    const dir = path.dirname(destPath)
    if (!coverTried.has(dir) && (await saveFolderCover(destPath, dir)) !== 'none') coverTried.add(dir)
  }
  return { results }
}

app.post('/api/ipod/export', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const body = (await c.req.json().catch(() => ({}))) as { ids?: number[]; destDir?: string; organize?: boolean }
  if (!Array.isArray(body.ids) || body.ids.length === 0) return c.json({ error: 'ids is required' }, 400)
  if (!body.destDir) return c.json({ error: 'destDir is required' }, 400)
  const ids = body.ids.map(Number)
  const { destDir, organize } = body
  return c.json(startJob(ids.length, (advance) => exportTracksJob(location, ids, destDir, !!organize, advance)))
})

app.get('/api/ipod/tracks/:id/metadata', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const id = Number(c.req.param('id'))
  try {
    const track = (await ipod.listTracks(location)).find((t) => t.id === id)
    if (!track) return c.json({ error: 'Track not found' }, 404)
    return c.json(await readMetadata(ipod.trackWindowsPath(location, track)))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Local filesystem ──────────────────────────────────────────────────────────

app.get('/api/local/home', (c) => c.json({ dir: defaultLocalDir() }))

app.get('/api/local/metadata', async (c) => {
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path is required' }, 400)
  try {
    return c.json(await readMetadata(filePath))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Embedded cover art of a local audio file, for thumbnails in the file list (404 if it has none).
app.get('/api/local/cover', async (c) => {
  const filePath = c.req.query('path')
  if (!filePath) return c.json({ error: 'path is required' }, 400)
  try {
    const picture = (await parseFile(filePath)).common.picture?.[0]
    if (!picture) return c.notFound()
    return c.body(picture.data as Uint8Array<ArrayBuffer>, 200, {
      'Content-Type': picture.format,
      'Cache-Control': 'private, max-age=60',
    })
  } catch {
    return c.notFound()
  }
})

// Extracts the embedded cover of each given audio file into Folder.jpg in the file's own folder.
app.post('/api/local/extract-covers', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { paths?: string[] }
  if (!Array.isArray(body.paths) || body.paths.length === 0) return c.json({ error: 'paths is required' }, 400)
  const counts = { saved: 0, exists: 0, none: 0 }
  for (const filePath of await collectAudioFiles(body.paths)) counts[await saveFolderCover(filePath, path.dirname(filePath))]++
  return c.json(counts)
})

// Rewrites the ID3 tags of the selected mp3s in place from their <artist>/<album>/<title>.mp3 path
// (see id3-tags.ts) as a background job. Job result: { tagged, skipped, failed: [{ path, error }] }.
interface SetTagsBody {
  paths?: string[]
  albumDelimiter?: string
  artistDelimiter?: string
}

/** The mp3 files a set-tags request applies to (the selection, with folders expanded). */
async function mp3sOf(body: SetTagsBody): Promise<string[]> {
  if (!Array.isArray(body.paths)) return []
  return (await collectAudioFiles(body.paths)).filter((p) => /\.mp3$/i.test(p))
}

// What set-tags would do, for the confirmation dialog: how many files it touches, how many it
// would skip, and before/after tags of the first few. Doesn't modify anything.
app.post('/api/local/set-tags/preview', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SetTagsBody
  const options = { albumDelimiter: body.albumDelimiter, artistDelimiter: body.artistDelimiter }
  const mp3s = await mp3sOf(body)
  const applicable = mp3s.filter((p) => tagsFromPath(p, options))
  const examples = await Promise.all(applicable.slice(0, PREVIEW_EXAMPLES).map((p) => previewTags(p, options)))
  return c.json({ total: mp3s.length, skipped: mp3s.length - applicable.length, examples })
})

const PREVIEW_EXAMPLES = 5

app.post('/api/local/set-tags', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as SetTagsBody
  if (!Array.isArray(body.paths) || body.paths.length === 0) return c.json({ error: 'paths is required' }, 400)
  const mp3s = await mp3sOf(body)
  if (mp3s.length === 0) return c.json({ error: 'No mp3 files found in the selection' }, 400)
  const options = { albumDelimiter: body.albumDelimiter, artistDelimiter: body.artistDelimiter }
  return c.json(
    startJob(mp3s.length, async (advance) => {
      clearCoverCache()
      const result = { tagged: 0, skipped: 0, failed: [] as { path: string; error: string }[] }
      for (const [i, filePath] of mp3s.entries()) {
        try {
          if ((await setTagsFromPath(filePath, options)) === 'tagged') result.tagged++
          else result.skipped++
        } catch (err: any) {
          result.failed.push({ path: filePath, error: err.message })
        }
        advance(i + 1)
      }
      return result
    }),
  )
})

app.get('/api/local/list', async (c) => {
  const dir = c.req.query('dir') ?? defaultLocalDir()
  try {
    return c.json(await listLocalDir(dir))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Frontend (statisch) ──────────────────────────────────────────────────────
// Wird von "npm run build" im electron/-Ordner nach dist/public kopiert (siehe build.mjs).
// Pfad relativ zu dieser Datei (nicht zu process.cwd()), da der Electron-Hauptprozess das
// Backend über protocol.handle() mit unbekanntem cwd importiert.

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public')

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

app.get('*', async (c) => {
  const requested = decodeURIComponent(c.req.path)
  const relative = requested === '/' ? 'index.html' : requested.replace(/^\/+/, '')
  const resolved = path.normalize(path.join(PUBLIC_DIR, relative))
  if (!resolved.startsWith(PUBLIC_DIR)) return c.notFound()

  const hasExtension = path.extname(resolved) !== ''
  const filePath = hasExtension ? resolved : path.join(PUBLIC_DIR, 'index.html')

  const data = await fs.readFile(filePath).catch(() => null)
  if (!data) return c.notFound()

  const mime = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream'
  return c.body(data, 200, { 'Content-Type': mime })
})

// ── Server ────────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Backend läuft auf http://localhost:${PORT}`)
})
