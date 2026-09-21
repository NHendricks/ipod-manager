// Long-running iPod operations (copy, delete, export) run as background jobs: the request that
// starts one returns a job id right away and the UI polls GET /api/jobs/:id for progress.
import { randomUUID } from 'node:crypto'

export interface JobState {
  total: number
  done: number
  finished: boolean
  result?: unknown
  error?: string
}

const jobs = new Map<string, JobState>()
const KEEP_FINISHED_MS = 10 * 60_000

/** Starts `run` in the background; it reports how many of `total` items are finished via `advance`. */
export function startJob(
  total: number,
  run: (advance: (done: number) => void) => Promise<unknown>,
): { jobId: string; total: number } {
  const jobId = randomUUID()
  const job: JobState = { total, done: 0, finished: false }
  jobs.set(jobId, job)
  run((done) => {
    job.done = Math.min(total, done)
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
      setTimeout(() => jobs.delete(jobId), KEEP_FINISHED_MS).unref()
    })
  return { jobId, total }
}

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId)
}
