// Long-running iPod operations (copy, delete, export) run as background jobs: the request that
// starts one returns a job id right away and the UI polls GET /api/jobs/:id for progress.
import { randomUUID } from 'node:crypto'

export interface JobState {
  total: number
  done: number
  /** Cumulative bytes transferred so far, for a live "X MB/s" readout while the job still runs. */
  bytesDone: number
  finished: boolean
  /** ms since epoch; with `finishedAt`, lets the UI report an average transfer speed. */
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
}

const jobs = new Map<string, JobState>()
const KEEP_FINISHED_MS = 10 * 60_000

/**
 * Starts `run` in the background; it reports how many of `total` items are finished, and how many
 * bytes have been transferred so far, via `advance` (bytes is 0 for jobs that don't move file data).
 */
export function startJob(
  total: number,
  run: (advance: (done: number, bytesDone?: number) => void) => Promise<unknown>,
): { jobId: string; total: number } {
  const jobId = randomUUID()
  const job: JobState = { total, done: 0, bytesDone: 0, finished: false, startedAt: Date.now() }
  jobs.set(jobId, job)
  run((done, bytesDone) => {
    job.done = Math.min(total, done)
    if (bytesDone !== undefined) job.bytesDone = bytesDone
  })
    .then(
      (result) => {
        job.result = result
        job.done = total
      },
      (err: any) => {
        job.error = err?.message ?? String(err)
      },
    )
    .finally(() => {
      job.finished = true
      job.finishedAt = Date.now()
      setTimeout(() => jobs.delete(jobId), KEEP_FINISHED_MS).unref()
    })
  return { jobId, total }
}

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId)
}
