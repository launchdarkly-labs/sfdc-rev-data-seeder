/**
 * S64 (P4): the app's small icon set — inline SVG, currentColor, 16px grid.
 * Decorative by default (`aria-hidden`); pass `label` for a standalone icon
 * that carries meaning. No icon font, no asset pipeline (CSP is 'self').
 */
export type IconName =
  | 'deployments'
  | 'templates'
  | 'connections'
  | 'help'
  | 'settings'
  | 'check'
  | 'warn'
  | 'cross'
  | 'square'
  | 'dots'
  | 'external'
  | 'play'
  | 'running'

const PATHS: Record<IconName, React.JSX.Element> = {
  deployments: (
    <>
      <path d="M3 4.5h10M3 8h10M3 11.5h6" />
      <path d="M12.5 10l1.5 1.5-1.5 1.5" />
    </>
  ),
  templates: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M2.5 6.5h11M6.5 6.5v7" />
    </>
  ),
  connections: (
    <>
      <circle cx="4" cy="8" r="2" />
      <circle cx="12" cy="4" r="2" />
      <circle cx="12" cy="12" r="2" />
      <path d="M6 7l4-2.2M6 9l4 2.2" />
    </>
  ),
  help: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.2 6.3a1.9 1.9 0 1 1 2.6 1.8c-.6.3-.8.6-.8 1.2M8 11.4v.1" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />
    </>
  ),
  check: <path d="M3 8.5l3.2 3L13 4.5" />,
  warn: (
    <>
      <path d="M8 2.2l6 10.6H2z" />
      <path d="M8 6.2v3.2M8 11.6v.1" />
    </>
  ),
  cross: <path d="M4 4l8 8M12 4l-8 8" />,
  square: <rect x="3" y="3" width="10" height="10" rx="2" />,
  dots: (
    <>
      <circle cx="3.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  external: (
    <>
      <path d="M7 3H3.5v9.5H13V9" />
      <path d="M9 3h4v4M13 3L7.5 8.5" />
    </>
  ),
  play: <path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />,
  running: (
    <>
      <circle cx="8" cy="8" r="5.5" strokeDasharray="26 9" />
    </>
  )
}

export function Icon({
  name,
  label,
  size = 16,
  className
}: {
  name: IconName
  /** Accessible name when the icon stands alone; omit when text next to it carries the meaning. */
  label?: string
  size?: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      className={`icon icon-${name}${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/** The RDS mark: an amber tile with a seed sprouting into an arrow — source → target. */
export function RdsMark({ size = 24 }: { size?: number }): React.JSX.Element {
  return (
    <svg className="rds-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path
        d="M9 22c0-5 3-9 8-10M17 12c3 0 5 1.5 6 4-3 .5-5-.5-6-4z"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="9" cy="23" r="2.2" fill="var(--on-accent)" />
      <path d="M20 23h4m0 0-1.6-1.6M24 23l-1.6 1.6" fill="none" stroke="var(--on-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
