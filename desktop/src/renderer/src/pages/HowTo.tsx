import { Link } from 'react-router-dom'
import { EXT_ID_FIELD } from '../../../shared/mappingPolicy'
import { RDS_PERMISSION_SET } from '../../../shared/types'

/**
 * Static operator guide (no IPC, no state) — how to connect an org, how to run
 * a deployment, and an explicit inventory of everything the app writes to a
 * TARGET org. Kept in the app rather than a README so the metadata-footprint
 * disclosure travels with the build the operator is actually running.
 *
 * When the engine's write footprint changes, THIS PAGE is part of the change:
 * the "What it adds" table is the user-facing contract for that footprint.
 */
export function HowToPage(): React.JSX.Element {
  return (
    <>
      <h1>How To</h1>
      <p className="sub">
        Connecting orgs, running a deployment, and exactly what this app writes to a target org.
      </p>

      <h2>How it works, in short</h2>
      <p>
        The app copies a <strong>record graph</strong> from a source org into a target org. You pick
        one or more root records (typically Accounts); it walks the relationships outward to the
        objects you selected, resolves every lookup to the matching record in the target, and
        upserts the result.
      </p>
      <ul>
        <li>
          <strong>The source org is never written to.</strong> Reads only — enforced in code, not by
          convention. LaunchDarkly production is permanently pinned read-only and can never be
          selected as a target.
        </li>
        <li>
          <strong>Records are upserted, not blindly inserted</strong>, keyed on a dedicated External
          Id field. Re-running the same deployment updates the same target records instead of
          creating duplicates.
        </li>
        <li>
          <strong>Automation is disabled for the run, then restored.</strong> Every item disabled is
          written to a local ledger <em>before</em> the change is made, so an interrupted run still
          knows what to put back.
        </li>
        <li>
          <strong>Lookups are remapped, not copied verbatim.</strong> Depending on the object, a
          reference resolves by target Id, by name match, or is deferred to a second pass once the
          referenced record exists.
        </li>
      </ul>

      <h2>Adding an org</h2>
      <ol>
        <li>
          Go to <Link to="/connections">Org Connections</Link>.
        </li>
        <li>
          <strong>From the Salesforce CLI</strong> — click <em>Refresh from sf CLI</em>. Every org
          you have authorized with <code>sf org login</code> appears here. This is the quickest
          path, and it needs no Connected App.
        </li>
        <li>
          <strong>Or via OAuth</strong> — pick the login host, optionally set a label, and click{' '}
          <em>Sign in</em>. Your system browser opens for the Salesforce login. Use this for orgs
          that are not in your local CLI.
        </li>
        <li>
          Set the <strong>Role</strong> dropdown: <code>source (read-only)</code> or{' '}
          <code>target</code>. The change saves the moment you pick it — a <em>Saved</em> marker
          confirms it. Roles filter the pickers on the New Deployment page; the actual source and
          target for a run are the ones you choose there.
        </li>
        <li>
          Click <em>Verify</em> to confirm the credentials still work and to record the org Id.
        </li>
      </ol>
      <p className="muted">
        Stale CLI aliases are not pruned automatically. If you have re-created or refreshed a
        sandbox, both the old and new alias may be listed — check the Username column before you
        pick one.
      </p>

      <h2>Running a data deployment</h2>
      <ol>
        <li>
          <Link to="/deployments/new">New Deployment</Link> — name it, choose the source and target
          org. This creates a Draft and opens the wizard.
        </li>
        <li>
          <strong>Orgs</strong> — confirm the pair. Source and target are fixed once the draft
          exists.
        </li>
        <li>
          <strong>Scope</strong> — choose the objects to include and the root records to start from
          (a filter, or explicit record Ids). Only objects present in both orgs are offered.
        </li>
        <li>
          <strong>Readiness</strong> — checks the target for the External Id field on each in-scope
          object. One button creates every missing field and grants your user access to them in the
          same step. See the table below.
        </li>
        <li>
          <strong>Mappings</strong> — per-object reference strategy (target Id, name match, or
          defer). Defaults come from policy; locked ones cannot be overridden.
        </li>
        <li>
          <strong>Fields</strong> — which fields travel per object. Non-copyable fields (formulas,
          rollups, autonumbers, audit fields) are excluded automatically.
        </li>
        <li>
          <strong>Summary</strong> — the automation panel and, for CPQ objects, the{' '}
          <em>Triggers Disabled</em> attestation. The deploy will not start until you attest.
        </li>
        <li>
          <strong>Plan</strong> — the frozen, ordered object plan with record counts. Review it,
          then <em>Start Deploy</em>.
        </li>
      </ol>

      <h2>What it adds to the target org</h2>
      <p>
        Everything below happens on the <strong>target</strong> only. Nothing is written to the
        source org.
      </p>

      <h3>Permanent — metadata it creates</h3>
      <table className="orgs">
        <thead>
          <tr>
            <th>What</th>
            <th>Where</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>{EXT_ID_FIELD}</code>
            </td>
            <td>Each in-scope object</td>
            <td>
              Text(255), marked External Id, not unique, not required. Label &ldquo;Data Deployment
              External Id&rdquo;. This is the upsert key that makes re-runs idempotent. Created from
              the Readiness step, and it <strong>stays</strong> after the deployment. Junction
              objects are exempt — the platform does not allow custom fields on them.
            </td>
          </tr>
          <tr>
            <td>
              <code>{RDS_PERMISSION_SET}</code>
            </td>
            <td>Permission set + assignment to you</td>
            <td>
              A field created through the Metadata API carries <em>no</em> field-level security, and
              the API cannot see a field you have no FLS on — not even as a System Administrator,
              since Modify All Data does not bypass FLS. So the Readiness step also grants read/edit
              on the External Id fields through this permission set and assigns it to the deploying
              user. It grants <strong>nothing else</strong> — no object permissions, no other
              fields. It persists after the deployment; note that a permission set cannot be deleted
              while it is still assigned to a user.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Temporary — automation it disables, then restores</h3>
      <p>
        Each item is recorded in a local ledger before it is touched, and put back at the end of the
        run — including when the run fails.
      </p>
      <table className="orgs">
        <thead>
          <tr>
            <th>What</th>
            <th>How</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Apex triggers (unmanaged)</td>
            <td>
              Body wrapped in an <code>RDS_BYPASS</code> comment marker via a Metadata Container,
              then unwrapped. The trigger&rsquo;s Status stays Active throughout, so it is the{' '}
              <em>body</em> that identifies a leftover, not the status.
            </td>
          </tr>
          <tr>
            <td>Flows</td>
            <td>Active version deactivated, then reactivated to the exact recorded version.</td>
          </tr>
          <tr>
            <td>Validation rules</td>
            <td>Deactivated, then reactivated.</td>
          </tr>
          <tr>
            <td>Duplicate rules</td>
            <td>Deactivated, then reactivated. Off by default — opt in on the Summary step.</td>
          </tr>
          <tr>
            <td>Workflow rules</td>
            <td>Deactivated, then reactivated. Scoped to rules that apply to the objects in scope.</td>
          </tr>
          <tr>
            <td>
              <code>SBQQ__TriggerDisabled__c</code>
            </td>
            <td>
              Legacy CPQ hierarchy custom setting, on older CPQ versions only. Set to true{' '}
              <strong>only if it is currently false</strong>, so an org that deliberately has it on
              is left alone.
            </td>
          </tr>
          <tr>
            <td>
              <code>RDS_Deployment_Control__c</code>
            </td>
            <td>
              Connector-package custom setting. Armed with an 8-hour TTL at the start and disarmed
              at the end. <strong>Requires the connector package</strong> — if the object is not
              present in the target, the arm is skipped with a warning and the run continues.
            </td>
          </tr>
        </tbody>
      </table>

      <h3>Data it writes</h3>
      <ul>
        <li>The seeded records themselves, upserted on the External Id field.</li>
        <li>
          <code>SBQQ__Contracted__c</code> on draft Contracts that this run created, to activate
          them. Scoped to this run&rsquo;s records — contracts already in the target are untouched.
        </li>
      </ul>

      <h2>CPQ: the one thing the app cannot do for you</h2>
      <p>
        Salesforce CPQ&rsquo;s <strong>Triggers Disabled</strong> checkbox (Setup &rarr; Installed
        Packages &rarr; Salesforce CPQ &rarr; Configure &rarr; Additional Settings) is a protected
        setting with no API. No tool can read or set it — which is why the wizard asks you to attest
        that you have checked it rather than doing it itself.
      </p>
      <ul>
        <li>
          Check it <strong>before</strong> a deployment that includes CPQ objects, and{' '}
          <strong>uncheck it after</strong>. It is org-wide: while it is on, CPQ calculation is off
          for everyone in that org.
        </li>
        <li>
          After unchecking, use <em>Execute Scripts</em> on the same CPQ settings page if the org
          reports its post-install steps as incomplete.
        </li>
        <li>
          Quote line numbering, rollups, and subscription or asset generation from contract
          activation <strong>do not run</strong> while triggers are disabled. That is intended — the
          app copies the source&rsquo;s already-computed values instead of recomputing them.
        </li>
      </ul>
    </>
  )
}
