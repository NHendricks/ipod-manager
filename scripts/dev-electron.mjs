#!/usr/bin/env node
// Wie dev.mjs, startet zusätzlich das Electron-Fenster, sobald der Vite-Devserver erreichbar
// ist. Schließen des Electron-Fensters (oder Abbruch eines der Dev-Server) beendet alle
// Prozesse.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const nodeCmd = process.execPath

const FRONTEND_URL = 'http://localhost:5173'

const reset = '\x1b[0m'
let exitCode = 0
let stopping = false
const children = []

function forward(stream, name, color, out) {
  let buf = ''
  stream.on('data', (chunk) => {
    buf += chunk.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) out.write(`${color}[${name}]${reset} ${line}\n`)
  })
}

function stopAll(signal) {
  if (stopping) return
  stopping = true
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
}

function runTask(name, color, cmd, args) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', cwd: rootDir })
  children.push(child)
  forward(child.stdout, name, color, process.stdout)
  forward(child.stderr, name, color, process.stderr)
  child.on('exit', (code) => {
    if (code && code !== 0) exitCode = code
    stopAll('SIGTERM')
  })
  return child
}

async function waitForFrontend(timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (stopping) return false
    try {
      await fetch(FRONTEND_URL)
      return true
    } catch {
      await new Promise((r) => setTimeout(r, 300))
    }
  }
  return false
}

runTask('backend', '\x1b[34m', npmCmd, ['run', 'dev', '--prefix', 'backend'])
runTask('frontend', '\x1b[32m', npmCmd, ['run', 'dev', '--prefix', 'frontend'])

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))
process.on('exit', () => (process.exitCode = exitCode))

const frontendReady = await waitForFrontend()
if (!stopping) {
  if (!frontendReady) {
    console.error(`Frontend unter ${FRONTEND_URL} nicht erreichbar - starte Electron trotzdem.`)
  }
  runTask('electron', '\x1b[35m', nodeCmd, [path.join('electron', 'scripts', 'start.mjs')])
}

await new Promise((resolvePromise) => {
  let remaining = children.length
  for (const child of children) {
    child.on('exit', () => {
      remaining -= 1
      if (remaining === 0) resolvePromise()
    })
  }
})
