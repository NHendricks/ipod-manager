// Shared by the panes: running a backend job (copy / delete / export) with progress, and the bar
// that shows it. The backend answers the starting POST with { jobId, total } and then reports
// { done, total, finished, result | error } on GET /api/jobs/:id.
import { html, css } from 'lit'

export interface Progress {
  label: string
  done: number
  total: number
  /** Cumulative bytes transferred so far and ms elapsed so far - for a live "X MB/s" readout. */
  bytesDone?: number
  elapsedMs?: number
}

const POLL_INTERVAL_MS = 250

export interface JobOutcome<T> {
  result: T
  /** Wall-clock time the job ran, in ms (server-measured; falls back to the client's own timing). */
  elapsedMs: number
}

/** POSTs `body` to `url` to start a job, and resolves with its result once it finished. */
export async function runJob<T>(
  url: string,
  body: unknown,
  onProgress: (done: number, total: number, bytesDone: number, elapsedMs: number) => void,
): Promise<JobOutcome<T>> {
  const clientStart = performance.now()
  const post = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const started = await post.json()
  if (started.error) throw new Error(started.error)
  onProgress(0, started.total, 0, 0)

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const job = await (await fetch(`/api/jobs/${started.jobId}`)).json()
    if (job.error && job.finished === undefined) throw new Error(job.error) // unknown job
    // While running, `Date.now() - startedAt` is a live "so far" elapsed time (both clocks are the
    // same machine's, backend and UI); once finished, the server's own start/end is authoritative.
    const elapsedMs =
      job.startedAt && job.finishedAt
        ? job.finishedAt - job.startedAt
        : job.startedAt
          ? Date.now() - job.startedAt
          : performance.now() - clientStart
    onProgress(job.done, job.total, job.bytesDone ?? 0, elapsedMs)
    if (!job.finished) continue
    if (job.error) throw new Error(job.error)
    return { result: job.result as T, elapsedMs }
  }
}

/** "12.3 MB in 4.5 s (2.7 MB/s)", for a report after a copy job finishes. Uses MiB, like the rest of the UI's sizes. */
export function formatTransferReport(bytes: number, elapsedMs: number): string {
  const mb = bytes / (1024 * 1024)
  const seconds = elapsedMs / 1000
  const mbPerSec = seconds > 0.05 ? mb / seconds : mb // avoid a wild ratio for a near-zero duration
  return `${mb.toFixed(1)} MB in ${seconds.toFixed(1)} s (${mbPerSec.toFixed(1)} MB/s)`
}

/** "2.7 MB/s", for a live readout while a copy job is still running. Null while there isn't enough
 * data yet (avoids a wild ratio right after starting). */
export function formatSpeed(bytes: number, elapsedMs: number): string | null {
  if (bytes <= 0 || elapsedMs < 500) return null
  const mbPerSec = bytes / (1024 * 1024) / (elapsedMs / 1000)
  return `${mbPerSec.toFixed(1)} MB/s`
}

export const progressStyles = css`
  .progress { padding: 6px 12px; font-size: .75rem; color: #a78bfa; flex-shrink: 0; }
  .progress progress {
    display: block; width: 100%; height: 6px; margin-top: 4px; border: none; border-radius: 3px;
    background: #26262e; overflow: hidden;
  }
  .progress progress::-webkit-progress-bar { background: #26262e; }
  .progress progress::-webkit-progress-value { background: #7c3aed; transition: width .2s; }
`

export function renderProgress(progress: Progress | null) {
  if (!progress) return ''
  const speed =
    progress.bytesDone !== undefined && progress.elapsedMs !== undefined
      ? formatSpeed(progress.bytesDone, progress.elapsedMs)
      : null
  return html`
    <div class="progress">
      ${progress.label} ${progress.done}/${progress.total}${speed ? ` (${speed})` : ''}
      <progress max=${progress.total} value=${progress.done}></progress>
    </div>
  `
}
