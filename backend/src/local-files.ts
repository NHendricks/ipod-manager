// Local filesystem browsing for the "your computer" pane of the two-pane file manager.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export interface LocalEntry {
  name: string
  path: string
  isDir: boolean
  sizeBytes: number
  isAudio: boolean
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b', '.aac', '.wav'])

export function defaultLocalDir(): string {
  return path.join(os.homedir(), 'Music')
}

export async function listLocalDir(dir: string): Promise<{ dir: string; parent: string | null; entries: LocalEntry[] }> {
  const resolved = path.resolve(dir)
  const dirents = await fs.readdir(resolved, { withFileTypes: true })

  const entries: LocalEntry[] = await Promise.all(
    dirents
      .filter((d) => !d.name.startsWith('.'))
      .map(async (d) => {
        const fullPath = path.join(resolved, d.name)
        const isDir = d.isDirectory()
        let sizeBytes = 0
        if (!isDir) {
          try {
            sizeBytes = (await fs.stat(fullPath)).size
          } catch {
            // race with a file being deleted/moved - ignore, report 0
          }
        }
        const ext = path.extname(d.name).toLowerCase()
        return { name: d.name, path: fullPath, isDir, sizeBytes, isAudio: AUDIO_EXTENSIONS.has(ext) }
      }),
  )

  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))

  const parent = path.dirname(resolved)
  return { dir: resolved, parent: parent === resolved ? null : parent, entries }
}
