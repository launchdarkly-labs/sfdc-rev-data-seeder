/**
 * S54 (F5): measure the app's memory over a deploy run — MEASURE, don't guess
 * (rule 9). Session 53 ended with Jack's machine out of memory and no number to
 * say whether the app was the reason. This samples Electron's per-process
 * working set on a timer, keeps the peak per process type, and renders one
 * job-log line at the end of the run.
 *
 * Pure apart from the injected reader and timers, so it is unit-testable; the
 * live wiring (`app.getAppMetrics()`) lives in ipc.ts.
 */

export interface ProcessSample {
  /** Electron process type: 'Browser' (main), 'Tab' (renderer), 'GPU', 'Utility', … */
  type: string
  workingSetKB: number
}

export interface MemorySampler {
  /** Take a final sample, stop the timer, return the summary line (null if nothing was read). */
  stop(): string | null
  /**
   * S64 P5 (5.1): the same peaks as structured data, MB per label ('main',
   * 'renderer', 'gpu', …) — what `deploy_runs.peak_memory` persists. Null when
   * nothing was read. Call after `stop()` for the final sample to be included.
   */
  peaksMB(): Record<string, number> | null
}

const LABELS: Readonly<Record<string, string>> = { Browser: 'main', Tab: 'renderer' }

/** Process type → the label the summary line and the persisted JSON both use. */
export function processLabel(type: string): string {
  return LABELS[type] ?? type.toLowerCase()
}

/** Peaks in KB by process type → MB by label, in the summary line's order. */
export function peaksToMB(peaksKB: ReadonlyMap<string, number>): Record<string, number> | null {
  if (peaksKB.size === 0) return null
  const order = ['Browser', 'Tab', 'GPU']
  const keys = [...peaksKB.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  const out: Record<string, number> = {}
  for (const k of keys) out[processLabel(k)] = Math.round((peaksKB.get(k) ?? 0) / 1024)
  return out
}

export function summarizePeaks(peaksKB: ReadonlyMap<string, number>): string | null {
  if (peaksKB.size === 0) return null
  const order = ['Browser', 'Tab', 'GPU']
  const keys = [...peaksKB.keys()].sort((a, b) => {
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b)
  })
  const parts = keys.map(
    (k) => `${processLabel(k)} ${Math.round((peaksKB.get(k) ?? 0) / 1024)} MB`
  )
  return `Peak memory during the run: ${parts.join(', ')}.`
}

export function startMemorySampler(
  read: () => ProcessSample[],
  intervalMs = 30_000,
  timers: {
    set: (fn: () => void, ms: number) => unknown
    clear: (handle: unknown) => void
  } = { set: (fn, ms) => setInterval(fn, ms), clear: (h) => clearInterval(h as NodeJS.Timeout) }
): MemorySampler {
  const peaks = new Map<string, number>()
  const sample = (): void => {
    let samples: ProcessSample[]
    try {
      samples = read()
    } catch {
      return // a metrics failure must never touch the run
    }
    // Several processes can share a type (helpers): sum them per type first.
    const byType = new Map<string, number>()
    for (const s of samples) byType.set(s.type, (byType.get(s.type) ?? 0) + s.workingSetKB)
    for (const [t, kb] of byType) if (kb > (peaks.get(t) ?? 0)) peaks.set(t, kb)
  }
  sample()
  const handle = timers.set(sample, intervalMs)
  let stopped = false
  return {
    stop() {
      if (stopped) return summarizePeaks(peaks)
      stopped = true
      timers.clear(handle)
      sample()
      return summarizePeaks(peaks)
    },
    peaksMB() {
      return peaksToMB(peaks)
    }
  }
}
