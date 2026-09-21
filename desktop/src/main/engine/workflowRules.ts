/**
 * Classic Workflow Rules — relevance-scoped disable guardrail (pure).
 *
 * Fidelity note: the Apex engine (AutomationManagementService) NEVER handled
 * classic `WorkflowRule` — it toggles Validation Rules, Flows, Apex Triggers and
 * the CPQ trigger setting only. Closing that gap is a **desktop-only extension**
 * decided with Jack on 2026-07-24 (S32). Jack's rule, verbatim intent: be
 * cautious — do NOT bullishly disable every active rule. An irrelevant workflow
 * rule that the deployed data would never trigger is an *unnecessary* disable and
 * therefore unnecessary performance degradation (and restore risk).
 *
 * So the guardrail is RELEVANCE-SCOPED, mirroring how `queryFlows` scopes
 * record-triggered flows to the deployment's objects: we only propose to disable
 * the intersection of (active workflow rules) and (objects in the deploy plan).
 * When that intersection is empty the whole step is a no-op. (Live proof, sb1_714
 * on 2026-07-24: 9 rules, 7 active, but every active one is on a managed-package /
 * non-deployment object — Field_Trip, DOZISF__ZoomInfo, CHANNEL_ORDERS__* — and the
 * two Opportunity rules are inactive, so the intersection is empty → disable none.)
 *
 * This module is PURE: discovery (Tooling `WorkflowRule.Metadata` query), the
 * actual `metadata.update` disable, and ledger-backed restore live in the Epic-4
 * automation subsystem (E4A.1 discovery / E4A.2 toggle / E4A.6 restore). Object
 * matching is case-insensitive on the API name — `TableEnumOrId` and the plan's
 * object names are both canonical API names, and CI matching removes a whole class
 * of casing bugs at zero cost.
 */

/** A classic Workflow Rule as surfaced by the Tooling API (`WorkflowRule` + Metadata.active). */
export interface WorkflowRule {
  /** Tooling `WorkflowRule.Id`. */
  id: string;
  /** `WorkflowRule.Name`. */
  name: string;
  /** `WorkflowRule.TableEnumOrId` — the object API name the rule is defined on. */
  tableEnumOrId: string;
  /** `Metadata.active` — true when the rule currently fires. */
  active: boolean;
}

/** The relevance-scoped classification of the target org's workflow rules for one deploy plan. */
export interface WorkflowRuleSelection {
  /** Active AND on an object in the plan → the ONLY rules we would disable. */
  toDisable: WorkflowRule[];
  /** Active but on an object the deploy never writes → left ON (Jack's caution). */
  skippedOutOfScope: WorkflowRule[];
  /** Already inactive → nothing to do. */
  skippedInactive: WorkflowRule[];
}

function normalize(objectApiName: string): string {
  return objectApiName.trim().toLowerCase();
}

/**
 * Select which of the target org's classic workflow rules to disable for a deploy.
 *
 * Relevance rule: disable a rule iff it is `active` AND its object is one of the
 * plan's objects. Everything else is deliberately left running.
 *
 * @param rules       all classic workflow rules on the target org (active + inactive)
 * @param planObjects the object API names in the deploy plan (any iterable)
 */
export function selectWorkflowRulesToDisable(
  rules: readonly WorkflowRule[],
  planObjects: Iterable<string>,
): WorkflowRuleSelection {
  const inScope = new Set<string>();
  for (const obj of planObjects) {
    if (obj) inScope.add(normalize(obj));
  }

  const selection: WorkflowRuleSelection = {
    toDisable: [],
    skippedOutOfScope: [],
    skippedInactive: [],
  };

  for (const rule of rules) {
    if (!rule.active) {
      selection.skippedInactive.push(rule);
    } else if (inScope.has(normalize(rule.tableEnumOrId))) {
      selection.toDisable.push(rule);
    } else {
      selection.skippedOutOfScope.push(rule);
    }
  }

  return selection;
}

/** True when the preflight is a no-op (nothing to disable) — the common case. */
export function isWorkflowRuleDisableNoop(selection: WorkflowRuleSelection): boolean {
  return selection.toDisable.length === 0;
}

/** One-line human summary for the automation panel / logs. */
export function summarizeWorkflowRuleSelection(selection: WorkflowRuleSelection): string {
  const { toDisable, skippedOutOfScope, skippedInactive } = selection;
  if (toDisable.length === 0) {
    return `No workflow rules to disable (${skippedOutOfScope.length} active out-of-scope, ${skippedInactive.length} inactive).`;
  }
  const objects = [...new Set(toDisable.map((r) => r.tableEnumOrId))].sort();
  return `Disabling ${toDisable.length} workflow rule(s) on ${objects.join(', ')} (leaving ${skippedOutOfScope.length} active out-of-scope rule(s) running).`;
}
