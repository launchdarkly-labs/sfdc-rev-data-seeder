export function ProgressBar({
  value,
  max,
  tone = 'accent',
  label,
  indeterminate = false
}: {
  value: number
  max: number
  tone?: 'accent' | 'success' | 'danger'
  label?: string
  /** No known maximum yet (S64 P2) — an animated stripe instead of a fake 0 → 33 → 66 % jump. */
  indeterminate?: boolean
}): React.JSX.Element {
  const pct = !indeterminate && max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div
      className={`progress${indeterminate ? ' progress-indeterminate' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuenow={indeterminate ? undefined : value}
      aria-valuemax={indeterminate ? undefined : max}
      aria-busy={indeterminate || undefined}
    >
      <div className={`progress-fill progress-${tone}`} style={indeterminate ? undefined : { width: `${pct}%` }} />
      <span className="progress-label">{label ?? (indeterminate ? 'Working…' : `${pct}%`)}</span>
    </div>
  )
}
