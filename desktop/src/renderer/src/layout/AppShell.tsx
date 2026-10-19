import { useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom'
import { Icon, RdsMark, type IconName } from '../ui/Icon'
import { useJobsStore, useRunningJobs } from '../store/jobs'
import { phaseLabel } from '../../../shared/labels'

interface NavItem {
  to: string
  label: string
  icon: IconName
  end?: boolean
  /** Extra paths that keep this item lit (NavLink's own matching is prefix-only). */
  alsoActive?: (pathname: string) => boolean
}

/**
 * S61 U-3 / U-10: External IDs, History, Tools and Settings are still the M1 stubs
 * (placeholders.tsx) — their routes stay for deep links, but they are not offered in the
 * nav until they have content. Jack clicked each one on the first live pass expecting function.
 *
 * S64 P3 (ux IA-3 / IA-14 / IA-16): the nav lists PLACES only. "New deployment" is an
 * action and lives on the Deployments page; the Deployments item stays lit inside a
 * deployment (detail + wizard) and on /deployments/new, so the sidebar always says
 * where you are.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Deployments', icon: 'deployments', end: true, alsoActive: (p) => p.startsWith('/deployments') },
  { to: '/templates', label: 'Templates', icon: 'templates' },
  { to: '/connections', label: 'Connections', icon: 'connections' },
  { to: '/howto', label: 'How To', icon: 'help' },
  { to: '/settings', label: 'Settings', icon: 'settings' }
]

export function AppShell(): React.JSX.Element {
  const applyEvent = useJobsStore((s) => s.applyEvent)
  const refresh = useJobsStore((s) => s.refresh)
  const { pathname } = useLocation()

  // Single job-event subscription for the whole app; hydrate once so a reload
  // re-attaches to in-flight jobs.
  useEffect(() => {
    void refresh()
    return window.rds.onJobEvent(applyEvent)
  }, [applyEvent, refresh])

  return (
    <div className="shell">
      <nav className="sidebar" aria-label="Main">
        <Link to="/" className="brand" aria-label={`Rev Data Seeder ${__APP_VERSION__}`}>
          <RdsMark />
          <span className="brand-text">
            <span>Rev Data Seeder</span>
            <span className="brand-version">v{__APP_VERSION__}</span>
          </span>
        </Link>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `nav-item${isActive || item.alsoActive?.(pathname) ? ' active' : ''}`
            }
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
        <RunningJobsFooter />
        <div className="sidebar-by">by LaunchDarkly Labs · MIT</div>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}

/**
 * Sidebar footer (ux IA-14 / F-11). Idle is plain text — it used to be a NavLink to
 * Home, so it looked clickable and did nothing useful. With jobs running it is a
 * button that opens a small popover: each running job with its phase and a Cancel.
 */
function RunningJobsFooter(): React.JSX.Element {
  const running = useRunningJobs()
  const [open, setOpen] = useState(false)
  const count = running.length
  // Derived in render (no setState-in-effect): the popover closes itself when the last job ends.
  const showPopover = open && count > 0

  if (count === 0) {
    return (
      <div className="sidebar-footer">
        <div className="muted">Idle</div>
      </div>
    )
  }
  return (
    <div className="sidebar-footer">
      <button
        type="button"
        className="btn subtle jobs-toggle"
        aria-expanded={showPopover}
        aria-controls="running-jobs"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="jobs-dot" aria-hidden="true" />
        {count} job{count > 1 ? 's' : ''} running
      </button>
      {showPopover && (
        <div className="jobs-popover" id="running-jobs" role="dialog" aria-label="Running jobs">
          <ul className="jobs-popover-list">
            {running.map((job) => (
              <li key={job.id} className="jobs-popover-row">
                <div className="jobs-popover-text">
                  <div>{job.title}</div>
                  {job.phase && <div className="muted">{phaseLabel(job.phase)}</div>}
                </div>
                <button
                  type="button"
                  className="btn btn-small"
                  onClick={() => void window.rds.jobCancel(job.id)}
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
