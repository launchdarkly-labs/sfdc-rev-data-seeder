/**
 * Workflow Rules relevance-scoped disable guardrail (S32 desktop-only extension).
 *
 * Provenance: no Apex counterpart — the Apex engine never handled classic
 * WorkflowRules. These tests pin the S32 relevance contract directly. The
 * "realWorld" fixture is the actual sb1_714 target-org snapshot captured
 * 2026-07-24 (9 rules / 7 active), which must resolve to a NO-OP for a typical
 * CPQ/sales deploy — the whole point of Jack's caution rule.
 */
import { describe, it, expect } from 'vitest';
import {
  selectWorkflowRulesToDisable,
  isWorkflowRuleDisableNoop,
  summarizeWorkflowRuleSelection,
  type WorkflowRule,
} from '../src/main/engine/workflowRules';

// Real sb1_714 snapshot (2026-07-24): 9 rules, 7 active. Ids are illustrative.
const realWorld: WorkflowRule[] = [
  { id: '01', name: 'Enterprise Close Won', tableEnumOrId: 'Opportunity', active: false },
  { id: '02', name: 'Processing Complete', tableEnumOrId: 'Field_Trip__Object_Analysis__c', active: true },
  { id: '03', name: 'CSM Assignment - AE/CSM', tableEnumOrId: 'Opportunity', active: false },
  { id: '04', name: 'ZoomInfo Company Created', tableEnumOrId: 'DOZISF__ZoomInfo__c', active: true },
  { id: '05', name: 'ZoomInfo Contact Created', tableEnumOrId: 'DOZISF__ZoomInfo__c', active: true },
  { id: '06', name: 'Partner Contract Term External ID', tableEnumOrId: 'CHANNEL_ORDERS__Partner_Contract_Terms__c', active: true },
  { id: '07', name: 'Populate Pricing fields', tableEnumOrId: 'CHANNEL_ORDERS__Service_Order_Detail__c', active: true },
  { id: '08', name: 'New Service Order - Must be Draft Status', tableEnumOrId: 'CHANNEL_ORDERS__Service_Order__c', active: true },
  { id: '09', name: 'Service Order Date Received', tableEnumOrId: 'CHANNEL_ORDERS__Service_Order__c', active: true },
];

// Objects a typical CPQ/sales deploy touches (from ldseed deployment history).
const cpqPlanObjects = [
  'Account',
  'Contact',
  'Opportunity',
  'OpportunityLineItem',
  'OpportunityContactRole',
  'SBQQ__Quote__c',
  'SBQQ__QuoteLine__c',
  'SBQQ__Subscription__c',
  'Contract',
];

describe('selectWorkflowRulesToDisable — relevance scoping', () => {
  it('disables only rules that are active AND on a plan object', () => {
    const rules: WorkflowRule[] = [
      { id: 'a', name: 'active in scope', tableEnumOrId: 'Opportunity', active: true },
      { id: 'b', name: 'inactive in scope', tableEnumOrId: 'Opportunity', active: false },
      { id: 'c', name: 'active out of scope', tableEnumOrId: 'Lead', active: true },
      { id: 'd', name: 'inactive out of scope', tableEnumOrId: 'Case', active: false },
    ];
    const sel = selectWorkflowRulesToDisable(rules, ['Opportunity', 'Account']);
    expect(sel.toDisable.map((r) => r.id)).toEqual(['a']);
    expect(sel.skippedOutOfScope.map((r) => r.id)).toEqual(['c']);
    expect(sel.skippedInactive.map((r) => r.id).sort()).toEqual(['b', 'd']);
  });

  it('is CASE-INSENSITIVE on the object API name', () => {
    const rules: WorkflowRule[] = [
      { id: 'a', name: 'r', tableEnumOrId: 'sbqq__quote__c', active: true },
    ];
    const sel = selectWorkflowRulesToDisable(rules, ['SBQQ__Quote__c']);
    expect(sel.toDisable.map((r) => r.id)).toEqual(['a']);
  });

  it('the real sb1_714 snapshot is a NO-OP for a typical CPQ deploy (Jack’s caution)', () => {
    const sel = selectWorkflowRulesToDisable(realWorld, cpqPlanObjects);
    // Every ACTIVE rule is on a managed-pkg/non-deployment object; the two
    // Opportunity rules (the only in-scope objects) are inactive.
    expect(sel.toDisable).toEqual([]);
    expect(isWorkflowRuleDisableNoop(sel)).toBe(true);
    expect(sel.skippedOutOfScope).toHaveLength(7); // all 7 active rules are on out-of-scope objects
    expect(sel.skippedInactive).toHaveLength(2); // the 2 inactive Opportunity rules
    expect(sel.skippedOutOfScope.length + sel.skippedInactive.length + sel.toDisable.length).toBe(9);
  });

  it('would disable an in-scope Opportunity rule IF it were active (guardrail still works)', () => {
    const withActiveOppRule = realWorld.map((r) =>
      r.id === '01' ? { ...r, active: true } : r,
    );
    const sel = selectWorkflowRulesToDisable(withActiveOppRule, cpqPlanObjects);
    expect(sel.toDisable.map((r) => r.name)).toEqual(['Enterprise Close Won']);
  });

  it('handles empty inputs', () => {
    expect(selectWorkflowRulesToDisable([], cpqPlanObjects).toDisable).toEqual([]);
    expect(selectWorkflowRulesToDisable(realWorld, []).toDisable).toEqual([]);
    expect(isWorkflowRuleDisableNoop(selectWorkflowRulesToDisable([], []))).toBe(true);
  });
});

describe('summarizeWorkflowRuleSelection', () => {
  it('reports a no-op clearly', () => {
    const sel = selectWorkflowRulesToDisable(realWorld, cpqPlanObjects);
    expect(summarizeWorkflowRuleSelection(sel)).toContain('No workflow rules to disable');
  });

  it('reports what will be disabled, de-duped by object', () => {
    const rules: WorkflowRule[] = [
      { id: 'a', name: 'r1', tableEnumOrId: 'Opportunity', active: true },
      { id: 'b', name: 'r2', tableEnumOrId: 'Opportunity', active: true },
    ];
    const summary = summarizeWorkflowRuleSelection(
      selectWorkflowRulesToDisable(rules, ['Opportunity']),
    );
    expect(summary).toContain('Disabling 2 workflow rule(s) on Opportunity');
  });
});
