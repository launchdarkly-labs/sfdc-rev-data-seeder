/**
 * JobManager — the single home for long-running work in the main process.
 *
 * Every long op (analysis, deploy, ExtId populate, orphan scan) runs as a Job:
 * it emits `JobEvent`s on one multiplexed channel and its lifecycle/progress is
 * queryable via `list()` so a reloaded renderer can re-attach. The Epic-4 deploy
 * engine's `DeployIo.emit` is implemented by this class (X.1: one bus).
 *
 * Cancellation is cooperative — a job's work function checks
 * `ctx.cancel.throwIfCancelled()` at unit boundaries. There is no forced kill
 * (the racy hard-cancel of the Apex app is deliberately not reproduced).
 *
 * `emit` and `now` are injected so the class is testable with no Electron.
 */
import type { JobEvent, JobEventKind, JobKind, JobStatus, JobSummary } from '../shared/types'

export class JobCancelledError extends Error {
  constructor() {
    super('Job cancelled')
    this.name = 'JobCancelledError'
  }
}

export interface CancelToken {
  readonly cancelled: boolean
  throwIfCancelled(): void
}

export interface JobContext {
  /** This job's id — lets the work function register side tables (e.g. the
   *  deploy handler's jobId → runId map for the cancel bridge, S46 D3). */
  readonly jobId: string
  readonly cancel: CancelToken
  progress(value: number, max: number, label?: string): void
  log(message: string, level?: 'info' | 'warn' | 'error'): void
  phase(name: string): void
}

interface JobRecord {
  summary: JobSummary
  cancelled: boolean
}

export type JobWork<T> = (ctx: JobContext) => Promise<T>

export class JobManager {
  private jobs = new Map<string, JobRecord>()
  private seq = 0

  constructor(
    private readonly emit: (event: JobEvent) => void,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * Registers a job, starts its work function asynchronously, and returns the
   * job id immediately (the IPC handler returns `{ jobId }`). Terminal state is
   * signalled by a `done` / `error` / `cancelled` event.
   */
  start<T>(
    kind: JobKind,
    title: string,
    work: JobWork<T>,
    opts: { deploymentId?: string } = {}
  ): string {
    const id = `job-${++this.seq}`
    const rec: JobRecord = {
      cancelled: false,
      summary: {
        id,
        kind,
        title,
        deploymentId: opts.deploymentId,
        status: 'running',
        startedAt: this.now()
      }
    }
    this.jobs.set(id, rec)

    const cancel: CancelToken = {
      get cancelled() {
        return rec.cancelled
      },
      throwIfCancelled() {
        if (rec.cancelled) throw new JobCancelledError()
      }
    }
    const ctx: JobContext = {
      jobId: id,
      cancel,
      progress: (value, max, label) => {
        rec.summary.progress = { value, max, label }
        this.fire(id, 'progress', { value, max, label })
      },
      log: (message, level = 'info') => this.fire(id, 'log', { message, level }),
      phase: (name) => {
        // Kept on the summary so list()/get() re-attach with the current
        // phase (the renderer never replays events after a reload).
        rec.summary.phase = name
        this.fire(id, 'phase', { name })
      }
    }

    void this.run(rec, ctx, work)
    return id
  }

  private async run<T>(rec: JobRecord, ctx: JobContext, work: JobWork<T>): Promise<void> {
    const id = rec.summary.id
    try {
      const result = await work(ctx)
      rec.summary.status = 'done'
      this.fire(id, 'done', { result: result ?? null })
    } catch (err) {
      if (rec.cancelled || err instanceof JobCancelledError) {
        this.setStatus(rec, 'cancelled')
        this.fire(id, 'cancelled', {})
      } else {
        const message = err instanceof Error ? err.message : String(err)
        rec.summary.error = message
        this.setStatus(rec, 'error')
        this.fire(id, 'error', { message })
      }
    }
  }

  /** Cooperative cancel — no-op unless the job is still running. */
  cancel(jobId: string): void {
    const rec = this.jobs.get(jobId)
    if (rec && rec.summary.status === 'running') rec.cancelled = true
  }

  /** All jobs this session, oldest first (renderer filters by status). */
  list(): JobSummary[] {
    return [...this.jobs.values()].map((r) => ({ ...r.summary }))
  }

  get(jobId: string): JobSummary | undefined {
    const rec = this.jobs.get(jobId)
    return rec ? { ...rec.summary } : undefined
  }

  private setStatus(rec: JobRecord, status: JobStatus): void {
    rec.summary.status = status
  }

  private fire(jobId: string, kind: JobEventKind, data: Record<string, unknown>): void {
    this.emit({ jobId, kind, ts: this.now(), data })
  }
}
