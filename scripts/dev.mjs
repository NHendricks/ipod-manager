#!/usr/bin/env node
// Startet backend & frontend dev-server parallel, mit farbig geprefixter Ausgabe.
// Ersetzt "concurrently": stoppt beide Prozesse, sobald einer beendet wird oder fehlschlägt.
import { spawn } from 'node:child_process'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const tasks = [
  { name: 'backend', color: '\x1b[34m', prefix: '--prefix', dir: 'backend' },
  { name: 'frontend', color: '\x1b[32m', prefix: '--prefix', dir: 'frontend' },
]

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

for (const task of tasks) {
  const child = spawn(npmCmd, ['run', 'dev', task.prefix, task.dir], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  children.push(child)
  forward(child.stdout, task.name, task.color, process.stdout)
  forward(child.stderr, task.name, task.color, process.stderr)
  child.on('exit', (code) => {
    if (code && code !== 0) exitCode = code
    stopAll('SIGTERM')
  })
}

process.on('SIGINT', () => stopAll('SIGINT'))
process.on('SIGTERM', () => stopAll('SIGTERM'))

process.on('exit', () => process.exitCode = exitCode)

await new Promise((resolvePromise) => {
  let remaining = children.length
  for (const child of children) {
    child.on('exit', () => {
      remaining -= 1
      if (remaining === 0) resolvePromise()
    })
  }
})
