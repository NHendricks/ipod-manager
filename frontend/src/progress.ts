// Shared by the panes: running a backend job (copy / delete / export) with progress, and the bar
// that shows it. The backend answers the starting POST with { jobId, total } and then reports
// { done, total, finished, result | error } on GET /api/jobs/:id.
import { html, css } from 'lit'

export interface Progress {
  label: string
  done: number
  total: number
}

const POLL_INTERVAL_MS = 250

/** POSTs `body` to `url` to start a job, and resolves with its result once it finished. */
export async function runJob<T>(
  url: string,
  body: unknown,
  onProgress: (done: number, total: number) => void,
): Promise<T> {
  const post = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const started = await post.json()
  if (started.error) throw new Error(started.error)
  onProgress(0, started.total)

  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
    const job = await (await fetch(`/api/jobs/${started.jobId}`)).json()
    if (job.error && job.finished === undefined) throw new Error(job.error) // unknown job
    onProgress(job.done, job.total)
    if (!job.finished) continue
    if (job.error) throw new Error(job.error)
    return job.result as T
  }
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
  return html`
    <div class="progress">
      ${progress.label} ${progress.done}/${progress.total}
      <progress max=${progress.total} value=${progress.done}></progress>
    </div>
  `
}
