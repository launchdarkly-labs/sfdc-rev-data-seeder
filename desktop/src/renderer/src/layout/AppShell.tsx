import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useJobsStore, useRunningJobCount } from '../store/jobs'

interface NavItem {
  to: string
  label: string
  end?: boolean
}

/**
 * S61 U-3 / U-10: External IDs, History, Tools and Settings are still the M1 stubs
 * (placeholders.tsx) — their routes stay for deep links, but they are not offered in the
 * nav until they have content. Jack clicked each one on the first live pass expecting function.
 */
const NAV: NavItem[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/deployments/new', label: 'New Deployment' },
  { to: '/templates', label: 'Templates' },
  { to: '/connections', label: 'Org Connections' },
  { to: '/howto', label: 'How To' }
]

export function AppShell(): React.JSX.Element {
  const applyEvent = useJobsStore((s) => s.applyEvent)
  const refresh = useJobsStore((s) => s.refresh)
  const running = useRunningJobCount()

  // Single job-event subscription for the whole app; hydrate once so a reload
  // re-attaches to in-flight jobs.
  useEffect(() => {
    void refresh()
    return window.rds.onJobEvent(applyEvent)
  }, [applyEvent, refresh])

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">Rev Data Seeder</div>
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'active' : '')}
          >
            {item.label}
          </NavLink>
        ))}
        <NavLink to="/" end className="sidebar-footer">
          {running > 0 ? `● ${running} job${running > 1 ? 's' : ''} running` : 'Idle'}
        </NavLink>
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  )
}
