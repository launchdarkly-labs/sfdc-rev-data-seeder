import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { JobEvent, JobKind, JobSummary } from '../../../shared/types'

/**
 * Renderer-side mirror of the main-process JobManager, fed by the single
 * `rds:job.events` stream (subscribed once at app mount) and hydrated via
 * `jobList()` so a reload re-attaches to in-flight jobs.
 */
interface JobsState {
  byId: Record<string, JobSummary>
  order: string[]
  hydrate: (summaries: JobSummary[]) => void
  applyEvent: (event: JobEvent) => void
  refresh: () => Promise<void>
}

export const useJobsStore = create<JobsState>((set) => ({
  byId: {},
  order: [],
  hydrate: (summaries) =>
    set(() => ({
      byId: Object.fromEntries(summaries.map((s) => [s.id, s])),
      order: summaries.map((s) => s.id)
    })),
  applyEvent: (event) =>
    set((state) => {
      const existing = state.byId[event.jobId]
      // S64 P5 (5.5a): a `log` line changes nothing on the summary, so the
      // state is returned UNCHANGED (same reference) — before this, every log
      // line built a new job object and a new `byId`, and every page
      // subscribed to a job (Home, the Deployment page, the run report, the
      // Plan/Summary steps) re-rendered once per line: several per 2,000-record
      // page, dozens during automation restore. The one exception is a log
      // for a job this store has never seen: the stub it creates is how a page
      // learns the job exists before `hydrate` catches up.
      if (event.kind === 'log' && existing) return state
      const base: JobSummary = existing ?? {
        id: event.jobId,
        kind: 'demo',
        title: event.jobId,
        status: 'running',
        startedAt: event.ts
      }
      const next: JobSummary = { ...base }
      switch (event.kind) {
        case 'progress':
          next.progress = event.data as unknown as JobSummary['progress']
          break
        case 'done':
          next.status = 'done'
          break
        case 'cancelled':
          next.status = 'cancelled'
          break
        case 'error':
          next.status = 'error'
          next.error = typeof event.data.message === 'string' ? event.data.message : 'Job failed'
          break
        case 'phase':
          // Mirrors JobManager: the summary carries the latest phase name so
          // Home / the detail page can show where a running job is (S46 D3).
          if (typeof event.data.name === 'string') next.phase = event.data.name
          break
        // 'log' doesn't change the summary; the monitor consumes it (D4).
      }
      return {
        byId: { ...state.byId, [event.jobId]: next },
        order: existing ? state.order : [...state.order, event.jobId]
      }
    }),
  refresh: async () => {
    const summaries = await window.rds.jobList()
    set(() => ({
      byId: Object.fromEntries(summaries.map((s) => [s.id, s])),
      order: summaries.map((s) => s.id)
    }))
  }
}))

/** Live summary for one job (undefined until an event or hydrate lands). */
export function useJob(jobId: string | undefined): JobSummary | undefined {
  return useJobsStore((s) => (jobId ? s.byId[jobId] : undefined))
}

/** Count of currently-running jobs (sidebar activity indicator). */
export function useRunningJobCount(): number {
  return useJobsStore((s) => s.order.filter((id) => s.byId[id]?.status === 'running').length)
}

/**
 * The running jobs themselves, in insertion order (S64 P3: the sidebar footer
 * lists them in a popover with a Cancel each). Array selector → useShallow,
 * or every store change re-renders the shell.
 */
export function useRunningJobs(): JobSummary[] {
  return useJobsStore(
    useShallow((s) =>
      s.order.map((id) => s.byId[id]).filter((j): j is JobSummary => j?.status === 'running')
    )
  )
}

/**
 * The most-recent job of `kind` for a deployment (by insertion order). Lets a
 * step re-attach to an analysis/deploy started earlier — surviving remounts and
 * renderer reloads — instead of tracking a local jobId that a remount drops.
 * Returns the stored summary reference (stable until that job changes).
 */
export function useLatestJobForDeployment(
  deploymentId: number,
  kind: JobKind
): JobSummary | undefined {
  const target = String(deploymentId)
  return useJobsStore((s) => {
    let latest: JobSummary | undefined
    for (const id of s.order) {
      const j = s.byId[id]
      if (j && j.kind === kind && j.deploymentId === target) latest = j
    }
    return latest
  })
}
