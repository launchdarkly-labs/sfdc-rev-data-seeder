import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useJobsStore, useRunningJobCount } from '../store/jobs'

interface NavItem {
  to: string
  label: string
  end?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/deployments/new', label: 'New Deployment' },
  { to: '/connections', label: 'Org Connections' },
  { to: '/extids', label: 'External IDs' },
  { to: '/history', label: 'History' },
  { to: '/tools', label: 'Tools' },
  { to: '/howto', label: 'How To' },
  { to: '/settings', label: 'Settings' }
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
