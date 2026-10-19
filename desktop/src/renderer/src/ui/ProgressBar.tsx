export function ProgressBar({
  value,
  max,
  tone = 'accent',
  label
}: {
  value: number
  max: number
  tone?: 'accent' | 'success' | 'danger'
  label?: string
}): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className={`progress-fill progress-${tone}`} style={{ width: `${pct}%` }} />
      <span className="progress-label">{label ?? `${pct}%`}</span>
    </div>
  )
}
