import type { AutomationItem, AutomationSnapshot } from '../../../../shared/types'
import { automationItemKey } from '../../../../shared/types'
import { effectiveDisable, masterFor } from '../../../../shared/wizard'
import type { RdsError } from '../../../../shared/types'
import { Badge } from '../../ui/Badge'
import { useWizard } from './WizardShell'

/**
 * Target-org automation panel + CPQ "Triggers Disabled" attestation (5B.8) —
 * port of the Apex wizard's Step-6 automation section (deploymentWizard.html
 * :546-660, deploymentWizard.js getters :2052-2126). The notice text, the
 * 4-step Setup instruction list, and the attestation checkbox label are
 * VERBATIM — they are a user-level procedure documented in the gate design
 * (Session 28) and must not drift.
 *
 * Toggle semantics: every discovered item DEFAULTS to "disable for deployment";
 * `config.automationToggles` stores only the user's opt-OUTs (key → false),
 * so a fresh discovery never inherits stale approvals. Trigger rows are not
 * toggleable (body-comment bypass is all-or-nothing, mirroring the LWC's
 * `isToggleable: automationType !== 'ApexTrigger'`).
 */

const TYPE_LABELS: Record<AutomationItem['automationType'], string> = {
  ValidationRule: 'Validation Rule',
  Flow: 'Flow',
  ApexTrigger: 'Apex Trigger',
  DuplicateRule: 'Duplicate Rule',
  CPQTriggerSetting: 'CPQ Triggers'
}

const BADGE_TONES: Record<
  AutomationItem['automationType'],
  'neutral' | 'accent' | 'warn' | 'danger'
> = {
  ValidationRule: 'neutral',
  Flow: 'accent',
  ApexTrigger: 'warn',
  DuplicateRule: 'neutral',
  CPQTriggerSetting: 'danger'
}

/** Is this item's category enabled by its master toggle? */
// Moved to shared/wizard.ts (5B.9): the MAIN-side deploy kickoff applies the
// same selection predicate — re-exported so existing imports keep working.
export { effectiveDisable }

function summaryLine(s: AutomationSnapshot): string {
  const parts: string[] = []
  if (s.validationRuleCount > 0) parts.push(`${s.validationRuleCount} validation rules`)
  if (s.flowCount > 0) parts.push(`${s.flowCount} flows`)
  if (s.triggerCount > 0) parts.push(`${s.triggerCount} triggers`)
  if (s.duplicateRuleCount > 0) parts.push(`${s.duplicateRuleCount} duplicate rules`)
  if (s.hasCpqTriggerSetting) parts.push('CPQ trigger setting')
  return parts.join(', ')
}

/** ≤8 objects joined; beyond that "…and N more" (LWC cpqManualTriggerObjectSummary). */
export function cpqObjectSummary(objs: readonly string[]): string {
  if (objs.length <= 8) return objs.join(', ')
  return `${objs.slice(0, 8).join(', ')} and ${objs.length - 8} more`
}

export function AutomationPanel({
  snapshot,
  discovering,
  error,
  onRescan
}: {
  snapshot: AutomationSnapshot | undefined
  discovering: boolean
  error: RdsError | undefined
  onRescan: () => void
}): React.JSX.Element {
  const { config, updateConfig } = useWizard()

  const showCpqNotice =
    !discovering &&
    !!snapshot &&
    !snapshot.hasCpqTriggerSetting &&
    snapshot.cpqTriggerGatedObjects.length > 0

  function setItemDisable(item: AutomationItem, disable: boolean): void {
    const key = automationItemKey(item)
    const next = { ...config.automationToggles }
    if (disable) {
      delete next[key] // default is "disable" — keep the overrides sparse
    } else {
      next[key] = false
    }
    updateConfig({ automationToggles: next })
  }

  const disableAutomations = config.disableAutomations ?? true
  const disableDuplicateRules = config.disableDuplicateRules ?? false

  const visibleItems = (snapshot?.items ?? []).filter((i) => masterFor(i, config))
  const toDisableCount = (snapshot?.items ?? []).filter((i) => effectiveDisable(i, config)).length

  return (
    <section className="automation-panel">
      <h3>
        Target Org Automation{' '}
        <button className="btn" onClick={onRescan} disabled={discovering}>
          Re-scan
        </button>
      </h3>

      {showCpqNotice && snapshot && (
        <div className="banner warn cpq-notice" role="alert">
          <p>
            <strong>
              Required — disable Salesforce CPQ triggers on the target org before deploying.
            </strong>
            <br />
            This deployment includes objects that Salesforce CPQ&rsquo;s managed triggers react to (
            {cpqObjectSummary(snapshot.cpqTriggerGatedObjects)}). The app cannot turn these off
            automatically, and deploying with them active lets CPQ automation recalculate and
            generate records against the data as it loads. In the <strong>target org</strong>:
          </p>
          <ol>
            <li>
              Setup &rarr; Installed Packages &rarr; <strong>Salesforce CPQ</strong> &rarr;
              Configure &rarr; Additional Settings tab
            </li>
            <li>
              Check <strong>Triggers Disabled</strong> and Save
            </li>
            <li>Come back here and confirm below</li>
            <li>
              When the deployment finishes, <strong>uncheck it</strong> to turn CPQ automation back
              on
            </li>
          </ol>
          <label className="cpq-attest">
            <input
              type="checkbox"
              checked={config.cpqAttestation}
              onChange={(e) => updateConfig({ cpqAttestation: e.target.checked })}
            />{' '}
            {"Confirmed — I checked 'Triggers Disabled' in the target org"}
          </label>
          <p className="muted">
            If CPQ triggers turn out to still be active, the deployment stops itself at the first
            CPQ trigger error instead of continuing.
          </p>
        </div>
      )}

      <label className="master-toggle">
        <input
          type="checkbox"
          checked={disableAutomations}
          onChange={(e) => updateConfig({ disableAutomations: e.target.checked })}
        />{' '}
        Disable automations while deploying
      </label>
      <label className="master-toggle">
        <input
          type="checkbox"
          checked={disableDuplicateRules}
          onChange={(e) => updateConfig({ disableDuplicateRules: e.target.checked })}
        />{' '}
        Disable duplicate rules while deploying
      </label>
      <label className="master-toggle">
        <input
          type="checkbox"
          checked={config.disableWorkflowRules ?? true}
          onChange={(e) => updateConfig({ disableWorkflowRules: e.target.checked })}
        />{' '}
        Disable in-scope classic workflow rules while deploying
      </label>

      {discovering && <p className="muted">Scanning target org for active automation...</p>}
      {error && (
        <div className="banner error">
          Automation discovery failed: {error.message}{' '}
          <button className="btn" onClick={onRescan}>
            Retry
          </button>
        </div>
      )}

      {snapshot && !discovering && (
        <>
          {snapshot.flowScopeFallback && (
            <div className="banner warn">
              The scoped flow query failed on the target — showing the org-wide flow sweep instead
              (over-disabling is safe; under-disabling is not).
              {snapshot.flowScopeFallbackReason && (
                <>
                  {' '}
                  Target said: <code>{snapshot.flowScopeFallbackReason}</code>
                </>
              )}
            </div>
          )}
          {snapshot.sectionErrors.map((e) => (
            <div key={e} className="banner warn">
              {e}
            </div>
          ))}

          {snapshot.items.length === 0 ? (
            <p className="muted">No active automation found on the target org.</p>
          ) : !disableAutomations && !disableDuplicateRules ? (
            <p className="muted">Automation will stay active during the deploy.</p>
          ) : (
            <>
              <p className="muted">
                Active automation on the target org will be temporarily disabled during deployment
                and automatically restored when complete (even on failure). Toggle off any items you
                want to keep active.
              </p>
              <p className="automation-summary">
                Found: {summaryLine(snapshot)}. <strong>{toDisableCount}</strong> item
                {toDisableCount === 1 ? '' : 's'} will be disabled.
              </p>
              <div className="automation-table-wrap">
                <table className="automation-table">
                  <thead>
                    <tr>
                      <th>Disable</th>
                      <th>Type</th>
                      <th>Name</th>
                      <th>Object</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => (
                      <tr key={automationItemKey(item)}>
                        <td>
                          {item.automationType === 'ApexTrigger' ? (
                            <span className="muted">N/A</span>
                          ) : (
                            <input
                              type="checkbox"
                              aria-label={`Disable ${TYPE_LABELS[item.automationType]} ${item.name}${item.objectName ? ` on ${item.objectName}` : ''}`}
                              checked={config.automationToggles[automationItemKey(item)] ?? true}
                              onChange={(e) => setItemDisable(item, e.target.checked)}
                            />
                          )}
                        </td>
                        <td>
                          <Badge tone={BADGE_TONES[item.automationType]}>
                            {TYPE_LABELS[item.automationType]}
                          </Badge>
                        </td>
                        <td>
                          {item.name}
                          {item.automationType === 'ApexTrigger' && (
                            <span className="muted"> (cannot toggle via API)</span>
                          )}{' '}
                          {item.isManagedPackage && <Badge tone="neutral">Managed</Badge>}
                        </td>
                        <td>{item.objectName || '—'}</td>
                      </tr>
                    ))}
                    {visibleItems.length === 0 && (
                      <tr>
                        <td colSpan={4} className="muted">
                          {snapshot.items.length} discovered item
                          {snapshot.items.length === 1 ? ' is' : 's are'} hidden by the master
                          toggles above.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
