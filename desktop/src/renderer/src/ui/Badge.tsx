import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger'

export function Badge({
  tone = 'neutral',
  children
}: {
  tone?: BadgeTone
  children: ReactNode
}): React.JSX.Element {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
