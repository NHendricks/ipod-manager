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

/**
 * Expands a selection into the audio files to work on: files are kept as given, and a folder
 * stands for every audio file anywhere below it (in natural name order, so "2 - x" precedes
 * "10 - y"). Hidden entries and symlinks/junctions are skipped, which also rules out loops.
 */
export async function collectAudioFiles(paths: string[]): Promise<string[]> {
  const found = new Set<string>()

  async function walk(dir: string): Promise<void> {
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable folder - skip it rather than failing the whole selection
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    for (const d of dirents) {
      if (d.name.startsWith('.') || d.isSymbolicLink()) continue
      const fullPath = path.join(dir, d.name)
      if (d.isDirectory()) await walk(fullPath)
      else if (AUDIO_EXTENSIONS.has(path.extname(d.name).toLowerCase())) found.add(fullPath)
    }
  }

  for (const p of paths) {
    const stat = await fs.stat(p).catch(() => null)
    if (!stat) continue
    if (stat.isDirectory()) await walk(p)
    else found.add(p)
  }
  return [...found]
}
