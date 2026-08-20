import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const app = new Hono()

const PORT = Number(process.env.PORT ?? 3001)

function sayHello(name: string): string {
  return `hello, ${name} from backend`
}

app.use('/*', cors({ origin: '*' }))

app.post('/api/hello', async (c) => {
  const body = await c.req.json().catch(() => ({})) as { name?: string }
  return c.json({ message: sayHello(body.name ?? '') })
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
