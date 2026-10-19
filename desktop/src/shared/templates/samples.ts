/**
 * Neutral sample templates (S59 plan appendices A + B). "Acme"-named; the only
 * real API names are standard objects and public managed-package objects
 * (SBQQ = Salesforce CPQ, sbaa = Advanced Approvals). They are the validator's
 * golden fixtures, the builder's "CPQ configuration preset", and what
 * `rds:template.sample` saves on request.
 *
 * Never put a customer's, an employee's or a specific org's names, Ids or
 * values here — this file ships in the public repo.
 */
import type { PostRefreshTemplate, SeedTemplate } from './types'

export const SAMPLE_SEED_NAME = 'Acme CPQ configuration'
export const SAMPLE_POST_REFRESH_NAME = 'Acme dev sandbox'

export const SAMPLE_SEED_TEMPLATE: SeedTemplate = {
  schemaVersion: 1,
  source: { expectedOrgId: null },
  runDefaults: { disableTargetAutomation: true },
  keepIdTargets: ['User', 'Group', 'RecordType', 'Profile', 'UserRole', 'Product2', 'Pricebook2', 'PricebookEntry'],
  copiedObjectsMustMatchSource: ['Product2', 'Pricebook2'],
  relinkCopiedObjects: [{ object: 'Product2', optionalFields: ['Acme_Phase_Category__c'] }],
  deferredFields: {
    ConsumptionSchedule: ['IsActive'],
    SBQQ__PriceRule__c: ['SBQQ__Active__c', 'SBQQ__ConditionsMet__c', 'SBQQ__AdvancedCondition__c'],
    SBQQ__ProductRule__c: ['SBQQ__Active__c', 'SBQQ__ConditionsMet__c', 'SBQQ__AdvancedCondition__c'],
    sbaa__ApprovalRule__c: ['sbaa__Active__c', 'sbaa__ConditionsMet__c', 'sbaa__AdvancedCondition__c'],
    SBQQ__QuoteTerm__c: ['SBQQ__ConditionsMet__c', 'SBQQ__AdvancedCondition__c']
  },
  deferredPlaceholders: { SBQQ__ConditionsMet__c: 'All', sbaa__ConditionsMet__c: 'All' },
  tiers: [
    { object: 'SBQQ__DiscountSchedule__c' },
    { object: 'SBQQ__DiscountTier__c' },
    { object: 'SBQQ__BlockPrice__c' },
    { object: 'SBQQ__Dimension__c' },
    { object: 'SBQQ__ProductFeature__c' },
    { object: 'SBQQ__ProductOption__c' },
    { object: 'SBQQ__ConfigurationAttribute__c' },
    { object: 'ConsumptionSchedule' },
    { object: 'ConsumptionRate' },
    { object: 'SBQQ__SummaryVariable__c' },
    { object: 'SBQQ__PriceRule__c' },
    { object: 'SBQQ__PriceCondition__c' },
    { object: 'SBQQ__PriceAction__c' },
    { object: 'SBQQ__ProductRule__c' },
    { object: 'SBQQ__ErrorCondition__c' },
    { object: 'SBQQ__ProductAction__c' },
    { object: 'SBQQ__ConfigurationRule__c' },
    { object: 'SBQQ__CustomAction__c' },
    { object: 'SBQQ__CustomActionCondition__c' },
    { object: 'SBQQ__SearchFilter__c' },
    { object: 'SBQQ__TemplateContent__c' },
    { object: 'SBQQ__QuoteTemplate__c' },
    { object: 'SBQQ__TemplateSection__c' },
    {
      object: 'SBQQ__LineColumn__c',
      pruneUnloadedUnder: { field: 'SBQQ__Template__c', parent: 'SBQQ__QuoteTemplate__c' }
    },
    { object: 'SBQQ__QuoteTerm__c', where: 'SBQQ__Quote__c = null' },
    {
      object: 'SBQQ__TermCondition__c',
      where: 'SBQQ__QuoteTerm__c IN (SELECT Id FROM SBQQ__QuoteTerm__c WHERE SBQQ__Quote__c = null)'
    },
    {
      object: 'SBQQ__RelatedContent__c',
      where: 'SBQQ__TemplateSection__c != null',
      handler: 'attachmentsViaJunction',
      handlerConfig: { fileIdField: 'SBQQ__ExternalId__c', parentField: 'SBQQ__TemplateSection__c' }
    },
    { object: 'sbaa__ApprovalChain__c' },
    { object: 'sbaa__Approver__c' },
    { object: 'sbaa__ApprovalVariable__c' },
    { object: 'sbaa__ApprovalRule__c' },
    { object: 'sbaa__ApprovalCondition__c' },
    { object: 'Acme_Form__c', group: 'forms' },
    {
      object: 'Acme_Form_Step__c',
      group: 'forms',
      parentScope: { anyOf: [{ field: 'Acme_Form__c', object: 'Acme_Form__c' }] }
    },
    {
      object: 'Acme_Form_Field__c',
      group: 'forms',
      parentScope: { anyOf: [{ field: 'Acme_Form_Step__c', object: 'Acme_Form_Step__c' }] }
    },
    {
      object: 'Acme_Form_Rule__c',
      group: 'forms',
      parentScope: {
        anyOf: [
          { field: 'Acme_Form__c', object: 'Acme_Form__c' },
          { field: 'Acme_Form_Step__c', object: 'Acme_Form_Step__c' },
          { field: 'Acme_Form_Field__c', object: 'Acme_Form_Field__c' }
        ]
      }
    }
  ],
  subsets: [{ object: 'Acme_Form__c', ids: ['aB3000000000001AAA'] }],
  expectedFailures: [
    {
      object: 'Product2',
      contains: 'Phase Category is required',
      why: 'a package validation rule the same rows fail in the source org'
    },
    {
      object: 'SBQQ__RelatedContent__c',
      contains: 'attachment missing in source',
      why: 'orphan junction row in the source org'
    }
  ],
  verify: { counts: true, danglingLookups: true, secondPassParity: true }
}

export const SAMPLE_POST_REFRESH_TEMPLATE: PostRefreshTemplate = {
  schemaVersion: 1,
  automation: {
    flows: [
      { apiName: 'Acme_Notify_Channel_On_Close', action: 'deactivate' },
      { apiName: 'Acme_Create_Project_On_Won', action: 'deactivate' },
      { apiName: 'Acme_Sandbox_Banner', action: 'activate' }
    ],
    triggers: [
      { name: 'AcmeOrderSync', action: 'deactivate' },
      { name: 'AcmeBillingPush', action: 'commentOut' }
    ],
    settingPatches: [
      {
        label: 'Disable the chat integration workspace',
        object: 'Acme_Integration_Settings__c',
        field: 'Workspace_Key__c',
        transform: { kind: 'prefix', value: 'SBOFF_' }
      },
      {
        label: 'Clear chat user ids so flows cannot message real people',
        object: 'User',
        field: 'Acme_Chat_User_Id__c',
        where: 'Acme_Chat_User_Id__c != null',
        transform: { kind: 'set', value: null },
        optIn: true
      }
    ]
  },
  seedTemplates: [{ name: SAMPLE_SEED_NAME, groups: ['default', 'forms'] }],
  verify: { safetyCheck: true }
}

/**
 * The builder's "CPQ configuration preset": the sample's CPQ + Advanced
 * Approvals tiers and settings WITHOUT the Acme-specific forms group, relink
 * fields, subsets or expected failures — a neutral starting point for a real
 * org's seed template.
 */
export function cpqConfigurationPreset(): SeedTemplate {
  const s = SAMPLE_SEED_TEMPLATE
  return {
    schemaVersion: 1,
    source: { expectedOrgId: null },
    runDefaults: { ...s.runDefaults },
    keepIdTargets: [...s.keepIdTargets],
    copiedObjectsMustMatchSource: [...s.copiedObjectsMustMatchSource],
    relinkCopiedObjects: [{ object: 'Product2', optionalFields: [] }],
    deferredFields: Object.fromEntries(Object.entries(s.deferredFields).map(([k, v]) => [k, [...v]])),
    deferredPlaceholders: { ...s.deferredPlaceholders },
    tiers: s.tiers.filter((t) => (t.group ?? 'default') === 'default').map((t) => structuredClone(t)),
    subsets: [],
    expectedFailures: [],
    verify: { ...s.verify }
  }
}
