/**
 * Route placeholders for M1 scaffolding (5A.1). Each is replaced by its real
 * page in later tasks — the ROADMAP task id is noted so the wiring is traceable.
 * (DeploymentDetailPage graduated to pages/DeploymentDetail.tsx in S46 — the
 * D5 minimal monitor slice.)
 */

function Stub({ title, note }: { title: string; note: string }): React.JSX.Element {
  return (
    <>
      <h1>{title}</h1>
      <p className="sub">{note}</p>
    </>
  )
}

export function ExtIdsPage(): React.JSX.Element {
  return <Stub title="External IDs" note="Create/populate ExtId fields on target orgs (5D.3)." />
}

export function HistoryPage(): React.JSX.Element {
  return <Stub title="History" note="Searchable deployment history (5D.2)." />
}

export function ToolsPage(): React.JSX.Element {
  return <Stub title="Tools" note="Orphan-trigger repair + manual automation restore (5D.4)." />
}

export function SettingsPage(): React.JSX.Element {
  return <Stub title="Settings" note="OAuth app config, engine thresholds, sf CLI status (5D.5)." />
}

export function WelcomePage(): React.JSX.Element {
  return <Stub title="Welcome" note="First-run onboarding (5D.5)." />
}

export function NotFoundPage(): React.JSX.Element {
  return <Stub title="Not found" note="No route matches this URL." />
}
