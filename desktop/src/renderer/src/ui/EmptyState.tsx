import type { ReactNode } from 'react'

/**
 * One look for every empty list (ux C-12). Nine pages used to print their own
 * ad-hoc muted string; this gives them a title, an optional one-line hint and
 * an optional action (a button or link) in a consistent block.
 */
export function EmptyState({
  title,
  hint,
  action
}: {
  title: ReactNode
  hint?: ReactNode
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="empty-state">
      <p className="empty-state-title">{title}</p>
      {hint && <p className="empty-state-hint">{hint}</p>}
      {action && <div className="empty-state-action">{action}</div>}
    </div>
  )
}
