/**
 * Small routed pages: the first-run Welcome checklist (S64 P2) and Not found
 * (Settings graduated to pages/Settings.tsx in P4).
 * The former M1 stubs (/extids, /history, /tools) redirect to Home — a stub
 * that leaks roadmap ids is a dead end for a public user.
 */
import { Link, Navigate } from 'react-router-dom'
import { useIpcQuery } from '../ipc/hooks'

export function RedirectHome(): React.JSX.Element {
  return <Navigate to="/" replace />
}

/**
 * Three steps, each with a live tick. Rendered inline on Home when the app has
 * no orgs and no deployments, and on its own at /welcome.
 */
export function WelcomeChecklist({
  orgCount,
  deploymentCount
}: {
  orgCount: number
  deploymentCount: number
}): React.JSX.Element {
  const steps = [
    {
      done: orgCount > 0,
      title: 'Connect your orgs',
      body: 'Sign in to each org with the Salesforce CLI (sf org login web -a <alias>), then refresh the list here. One org will be the read-only source, another the target.',
      to: '/connections',
      cta: 'Open Connections'
    },
    {
      done: deploymentCount > 0,
      title: 'Create a deployment',
      body: 'Pick the source and target, choose the accounts and objects to copy, review the plan, deploy. Nothing is written to the source org.',
      to: '/deployments/new',
      cta: 'New deployment'
    },
    {
      done: false,
      title: 'Read how it works',
      body: 'What the app writes to a target org, how keyed and keyless runs differ, and the one manual CPQ step.',
      to: '/howto',
      cta: 'How To'
    }
  ]
  return (
    <section className="welcome" aria-label="Getting started" data-testid="welcome">
      <h2>Getting started</h2>
      <ol className="welcome-steps">
        {steps.map((s) => (
          <li key={s.title} className={s.done ? 'done' : ''}>
            <span className="welcome-tick" aria-hidden="true">
              {s.done ? '✓' : ''}
            </span>
            <div>
              <strong>{s.title}</strong>
              <p className="muted">{s.body}</p>
              {!s.done && (
                <Link className="btn" to={s.to}>
                  {s.cta}
                </Link>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function WelcomePage(): React.JSX.Element {
  const { data: orgs } = useIpcQuery(() => window.rds.listOrgs(), [])
  const { data: deployments } = useIpcQuery(() => window.rds.draftList(), [])
  return (
    <>
      <h1>Welcome</h1>
      <p className="sub">Three steps to a seeded sandbox.</p>
      <WelcomeChecklist orgCount={orgs?.length ?? 0} deploymentCount={deployments?.length ?? 0} />
    </>
  )
}

export function NotFoundPage(): React.JSX.Element {
  return (
    <>
      <h1>Not found</h1>
      <p className="sub">
        No page matches this address. <Link to="/">Go to Home</Link>.
      </p>
    </>
  )
}
