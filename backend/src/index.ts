import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ipod from './ipod.js'
import { defaultLocalDir, listLocalDir } from './local-files.js'

export const app = new Hono()

const PORT = Number(process.env.PORT ?? 3001)

app.use('/*', cors({ origin: '*' }))

// ── iPod ──────────────────────────────────────────────────────────────────────

app.get('/api/ipod/status', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ connected: false })
  try {
    const info = await ipod.getInfo(location)
    return c.json({ connected: true, driveLetter: location.driveLetter, info })
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
  const body = (await c.req.json().catch(() => ({}))) as { filePath?: string }
  if (!body.filePath) return c.json({ error: 'filePath is required' }, 400)
  try {
    return c.json(await ipod.addTrack(location, body.filePath))
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.delete('/api/ipod/tracks/:id', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const id = Number(c.req.param('id'))
  try {
    await ipod.removeTrack(location, id)
    return c.json({ removed: true })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'track'
}

app.post('/api/ipod/tracks/:id/export', async (c) => {
  const location = await ipod.findIpod()
  if (!location) return c.json({ error: 'No iPod detected' }, 404)
  const id = Number(c.req.param('id'))
  const body = (await c.req.json().catch(() => ({}))) as { destDir?: string }
  if (!body.destDir) return c.json({ error: 'destDir is required' }, 400)
  try {
    const tracks = await ipod.listTracks(location)
    const track = tracks.find((t) => t.id === id)
    if (!track) return c.json({ error: 'Track not found' }, 404)
    const ext = path.extname(track.ipodPath.replace(/:/g, '/')) || '.mp3'
    const filename = sanitizeFilename(`${track.artist ?? ''} - ${track.title ?? 'track'}`.replace(/^ - /, '')) + ext
    const destPath = path.join(body.destDir, filename)
    await ipod.exportTrack(location, id, destPath)
    return c.json({ path: destPath })
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// ── Local filesystem ──────────────────────────────────────────────────────────

app.get('/api/local/home', (c) => c.json({ dir: defaultLocalDir() }))

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
