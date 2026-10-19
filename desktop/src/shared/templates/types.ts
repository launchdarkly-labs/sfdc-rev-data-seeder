/**
 * Post-refresh TEMPLATES — the two composable template types (S59 plan §3),
 * the automation catalog the builder reads, and the run / report shapes the
 * run page renders. Renderer-safe: dependency-free, imported by main, preload
 * and renderer alike.
 *
 * Two kinds ride in the existing `templates` table beside the wizard's
 * objects / mappings / fields templates:
 *
 *   seed         WHAT to copy from a source org into a sandbox, in which ORDER,
 *                and HOW (per-tier where / batch size / deferred fields /
 *                placeholders / prune / parent scope / handler). Id-remapping
 *                config data — NOT the deploy engine's External-Id upsert.
 *   postRefresh  which flows and triggers to deactivate / activate / comment
 *                out (desired state), optional setting patches, and which seed
 *                templates to run afterwards.
 *
 * Nothing in here names a real org's objects, flows, triggers or people; the
 * samples (samples.ts) are "Acme"-named and use only public managed-package
 * API names.
 */
import type { JobSummary, TemplateKind } from '../types'

export const TEMPLATE_SCHEMA_VERSION = 1 as const

/** The two template kinds this feature owns (the wizard kinds are the other three). */
export type RunnableTemplateKind = Extract<TemplateKind, 'seed' | 'postRefresh'>

export function isRunnableKind(kind: TemplateKind): kind is RunnableTemplateKind {
  return kind === 'seed' || kind === 'postRefresh'
}

/** Which org the template was BUILT against — a hint for the list, never a constraint. */
export interface OrgHint {
  orgId: string
  label: string
}

// ───────────────────────────── Data seed template ─────────────────────────────

export const SEED_HANDLERS = ['attachmentsViaJunction'] as const
export type SeedHandler = (typeof SEED_HANDLERS)[number]

export const BATCH_SIZE_MIN = 1
export const BATCH_SIZE_MAX = 200
export const BATCH_SIZE_DEFAULT = 200

export const DEFAULT_TIER_GROUP = 'default'

export interface SeedTier {
  object: string
  /** Tier group so part of a template can run alone. Default 'default'. */
  group?: string
  /** SOQL WHERE fragment (without the WHERE keyword) applied to the SOURCE query. */
  where?: string
  /** 1–200, default 200 (D4). The run report suggests 1 for objects that only save singly. */
  batchSize?: number
  handler?: SeedHandler
  /** attachmentsViaJunction: the field that carries the source file Id and the parent lookup. */
  handlerConfig?: { fileIdField: string; parentField: string }
  /** After the load, delete rows under the loaded parents that did not come from the source. */
  pruneUnloadedUnder?: { field: string; parent: string }
  /** Keep only rows whose lookup points at a parent kept in an EARLIER tier (advanced). */
  parentScope?: { anyOf: Array<{ field: string; object: string }> }
}

export interface SeedTemplate {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION
  builtFrom?: OrgHint
  /** 15/18-char org id the template expects as its source; checked by 15-char prefix at run. */
  source: { expectedOrgId: string | null }
  /** D3a: disable the target's own unmanaged automation on the seeded objects for the run. */
  runDefaults: { disableTargetAutomation: boolean }
  /** Objects whose Ids are the SAME in both orgs (sandbox copy) — lookups keep the source Id. */
  keepIdTargets: string[]
  /** Copied objects that must match the source before seeding (count tolerance below). */
  copiedObjectsMustMatchSource: string[]
  /** Default {5, 0.02}: refuse when more than max(absolute, fraction×source) source Ids are missing. */
  copiedMatchTolerance?: { absolute: number; fraction: number }
  /** Copied objects whose lookups to seeded objects are repointed after the seed. */
  relinkCopiedObjects: Array<{ object: string; optionalFields: string[] }>
  /** object → fields written in the second pass (booleans load false, others take a placeholder). */
  deferredFields: Record<string, string[]>
  /** field → first-pass placeholder value for a deferred non-boolean field. */
  deferredPlaceholders: Record<string, string | number | boolean>
  tiers: SeedTier[]
  /** Root subsets: only these source Ids of an object (children follow via parentScope). */
  subsets: Array<{ object: string; ids: string[] }>
  /** Known failures: matched by message substring (object null = any object). */
  expectedFailures: Array<{ object: string | null; contains: string; why: string }>
  verify: { counts: boolean; danglingLookups: boolean; secondPassParity: boolean }
}

// ───────────────────────────── Post-refresh template ─────────────────────────────

export const FLOW_ACTIONS = ['deactivate', 'activate'] as const
export type FlowAction = (typeof FLOW_ACTIONS)[number]

export const TRIGGER_ACTIONS = ['deactivate', 'commentOut', 'activate', 'uncomment'] as const
export type TriggerAction = (typeof TRIGGER_ACTIONS)[number]

export type SettingPatchTransform =
  | { kind: 'prefix'; value: string }
  | { kind: 'set'; value: string | number | boolean | null }

export interface SettingPatch {
  label: string
  object: string
  field: string
  /** Optional SOQL WHERE fragment selecting the rows to patch. */
  where?: string
  transform: SettingPatchTransform
  /** Opt-in patches are unchecked on the run form by default. */
  optIn?: boolean
}

export interface PostRefreshTemplate {
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION
  builtFrom?: OrgHint
  automation: {
    flows: Array<{ apiName: string; action: FlowAction }>
    triggers: Array<{ name: string; action: TriggerAction }>
    settingPatches: SettingPatch[]
  }
  /** Seed templates (kind 'seed') by name, resolved at run time; optional group subset. */
  seedTemplates: Array<{ name: string; groups?: string[] }>
  verify: { safetyCheck: true }
}

export type RunnableTemplate = SeedTemplate | PostRefreshTemplate

/** The export file envelope — a post-refresh file embeds the seed templates it names. */
export interface TemplateExportFile {
  rdsTemplate: typeof TEMPLATE_SCHEMA_VERSION
  kind: RunnableTemplateKind
  name: string
  description?: string
  payload: RunnableTemplate
  embeddedSeedTemplates?: Array<{ name: string; payload: SeedTemplate }>
}

// ───────────────────────────── Automation catalog ─────────────────────────────

export interface CatalogFlow {
  apiName: string
  label: string
  processType: string | null
  triggerType: string | null
  object: string | null
  isActive: boolean
  activeVersionNumber: number | null
  latestVersionNumber: number | null
  managed: boolean
  namespace: string | null
}

export type TriggerBodyState = 'live' | 'templateStub' | 'deployWrapped'

export interface CatalogTrigger {
  id: string
  name: string
  object: string
  status: string
  bodyState: TriggerBodyState
  managed: boolean
  namespace: string | null
}

export interface AutomationCatalog {
  orgId: string
  flows: CatalogFlow[]
  triggers: CatalogTrigger[]
  /** Non-fatal section failures (one list could not be read). */
  errors: string[]
}

// ───────────────────────────── Templates list ─────────────────────────────

export interface TemplateLastRun {
  runId: number
  mode: TemplateRunMode
  state: TemplateRunState
  targetLabel: string
  startedAt: number
}

export interface TemplateSummary {
  id: number
  kind: TemplateKind
  name: string
  description: string | null
  builtFrom: OrgHint | null
  /** One line describing the content ("31 objects in 2 groups", "3 flows, 2 triggers, 1 seed template"). */
  detail: string
  /** Seed templates: the tier groups (first-appearance order) — the run form and post-refresh builder pick from them. */
  seedGroups: string[]
  /** Seed templates: seeded objects the gating playbook marks as needing the CPQ "Triggers Disabled" bypass
   *  (resolved in main with the runner's own policy, so the run form shows the attestation the preflight will demand). */
  cpqGatedObjects: string[]
  createdAt: number
  updatedAt: number
  lastRun: TemplateLastRun | null
}

export interface TemplateDetail extends TemplateSummary {
  payload: unknown
}

// ───────────────────────────── Runs ─────────────────────────────

export type TemplateRunMode = 'dry-run' | 'apply' | 'restore'
/**
 * running → one of: clean (no unexpected problems) · partial (every step ran to the end, but some
 * rows or items had unexpected problems — S61 U-8) · failed (the run did not finish: it threw, or
 * the app died inside it) · blocked (preflight refused it) · cancelled (the user stopped it).
 */
export type TemplateRunState = 'running' | 'clean' | 'partial' | 'failed' | 'blocked' | 'cancelled'

export interface TemplateRunSteps {
  /** Post-refresh: run the automation + setting-patch step. */
  automation: boolean
  /** Seed templates to run, by name, each with the groups to include (empty = all). */
  seeds: Array<{ name: string; groups: string[] }>
  /** Labels of opt-in setting patches the user ticked. */
  optInPatches: string[]
}

export interface TemplateRunOptions {
  /** D3a — default on. */
  disableTargetAutomation: boolean
  /** D3b — the CPQ "Triggers Disabled" attestation when a seeded object needs it. */
  cpqAttestation: boolean
  /** Delete the seed objects' existing rows first (apply only; confirmed by typing the alias). */
  purge: boolean
  /** Continue from the last apply's id map on this target. */
  resume: boolean
}

export interface TemplateRunInput {
  templateId: number
  mode: Exclude<TemplateRunMode, 'restore'>
  targetConnectionId: string
  sourceConnectionId?: string
  steps: TemplateRunSteps
  options: TemplateRunOptions
}

export interface TemplateRunSummary {
  id: number
  templateId: number | null
  templateKind: RunnableTemplateKind
  templateName: string
  mode: TemplateRunMode
  state: TemplateRunState
  sourceConnectionId: string | null
  sourceLabel: string | null
  targetConnectionId: string
  targetLabel: string
  targetOrgId: string
  jobId: string | null
  startedAt: number
  finishedAt: number | null
  /** S62: set when the run was a stage of a deployment ("via Deployment #N"). */
  deploymentId: number | null
}

export interface TemplateRunStateView {
  run: TemplateRunSummary
  /** The resolved template that ran (post-refresh: with its seed templates embedded). */
  snapshot: unknown
  steps: TemplateRunSteps
  options: TemplateRunOptions | null
  report: TemplateReport | null
  /** This session's job for the run, if any. */
  job: JobSummary | null
  /** Temporary automation rows of this run not yet confirmed restored. */
  unrestoredTemporary: number
}

// ───────────────────────────── Report ─────────────────────────────

export type AutomationResultKind =
  | 'planned'
  | 'changed'
  | 'alreadyThere'
  | 'notFound'
  | 'managed'
  | 'unsupported'
  | 'failed'

export interface AutomationItemReport {
  itemType: 'Flow' | 'ApexTrigger'
  name: string
  object: string | null
  wanted: FlowAction | TriggerAction
  /** What the target showed before the change ("active v3", "Inactive", "commented out"). */
  found: string
  result: AutomationResultKind
  detail: string | null
}

export interface SettingPatchReport {
  label: string
  object: string
  field: string
  rows: number
  alreadyPatched: number
  updated: number
  failed: number
  result: 'planned' | 'applied' | 'skipped' | 'failed' | 'objectMissing'
  detail: string | null
}

export interface RecordProblem {
  recordId: string | null
  message: string
}

export interface SeedTierReport {
  object: string
  group: string
  /** Rows the source query returned (after subsets / parent scope). */
  source: number
  loaded: number
  failed: number
  skipped: number
  nulled: number
  fields: number
  /** Rows an earlier apply had loaded (resume). */
  resumed: number
  failures: RecordProblem[]
  skips: RecordProblem[]
  nulledFields: Record<string, number>
  noAccess: string[]
  missingOnTarget: string[]
  /** Rows that saved only on the single-record retry (D4 evidence). */
  savedOnSingleRetry: number
  /** Rows that failed with the bulk-only error class and never saved. */
  bulkOnlyFailures: number
  skippedObject: string | null
  note: string | null
  pruned: number | null
  bytes: number | null
}

export interface SecondPassReport {
  object: string
  updates: number
  updated: number
  failed: number
  fields: string[]
  failures: RecordProblem[]
  savedOnSingleRetry: number
}

export interface RelinkReport {
  object: string
  records: number
  updated: number
  alreadyCorrect: number
  partial: number
  failed: number
  fields: string[]
  failures: RecordProblem[]
}

export interface TargetAutomationItemReport {
  itemType: string
  name: string
  object: string
  disabled: boolean
  restored: boolean
  detail: string | null
}

export interface TargetAutomationReport {
  planned: number
  disabled: number
  restored: number
  unconfirmed: number
  items: TargetAutomationItemReport[]
}

export interface VerifyCountRow {
  object: string
  source: number
  loaded: number
  target: number
  gap: boolean
}

export interface VerifyDanglingRow {
  object: string
  field: string
  count: number
  /** Of `count`, rows whose relink failed for a KNOWN (expected) reason — not a new problem (S61 U-6). */
  known?: number
}

export interface PurgeRow {
  object: string
  deleted: number
  failed: number
  /** Set when some direct deletes were refused by a trigger but a parent tier's master-detail cascade removed the rows anyway (S61 U-12). */
  via?: string | null
}

export interface VerifyParityRow {
  object: string
  checked: number
  mismatches: number
  fields: string[]
  samples: Array<{ sourceId: string; targetId: string; field: string; expected: unknown; actual: unknown }>
}

export interface VerifyReport {
  counts: VerifyCountRow[]
  dangling: VerifyDanglingRow[]
  parity: VerifyParityRow[]
}

export type TemplateStep =
  | 'preflight'
  | 'automation'
  | 'settingPatch'
  | 'safety'
  | 'targetAutomation'
  | 'purge'
  | 'seed'
  | 'secondPass'
  | 'relink'
  | 'verify'
  | 'resume'

export interface TemplateProblem {
  step: TemplateStep
  object: string | null
  recordId: string | null
  message: string
  expected: boolean
  why: string | null
}

export interface ProblemGroup {
  step: TemplateStep
  object: string | null
  count: number
  example: string
  why: string | null
}

export type NextAction = 'none' | 'resume' | 'rerunAutomation' | 'restoreTargetAutomation' | 'fixAndRerun'

export interface BatchSizeSuggestion {
  object: string
  reason: string
}

export interface TemplateReport {
  schemaVersion: 1
  mode: TemplateRunMode
  state: TemplateRunState
  startedAt: number
  finishedAt: number | null
  preflight: { blockers: string[]; notes: string[] }
  automation: AutomationItemReport[]
  settingPatches: SettingPatchReport[]
  safetyCheck: { ran: boolean; problems: string[] } | null
  targetAutomation: TargetAutomationReport | null
  purge: PurgeRow[] | null
  seed: SeedTierReport[]
  secondPass: SecondPassReport[]
  relink: RelinkReport[]
  verify: VerifyReport | null
  problems: TemplateProblem[]
  summary: {
    unexpected: number
    expected: number
    unexpectedGroups: ProblemGroup[]
    expectedGroups: ProblemGroup[]
    nextAction: NextAction
    batchSizeSuggestions: BatchSizeSuggestion[]
  }
}

/**
 * Fixed copy — on the run form and in every Apply confirm, VERBATIM (S59 plan
 * §2.3). A dry run reads and plans; the managed-package errors a config seed
 * meets only exist when writing.
 */
export const DRY_RUN_CAVEAT =
  'A dry run cannot detect managed-package validation or trigger errors — those only appear when writing. ' +
  'A clean dry run is not a promise.'

// ───────────────────────────── Builder helpers (renderer) ─────────────────────────────

/** Objects whose Ids a sandbox copy shares with its source — the prefilled keep-Id set. */
export const DEFAULT_KEEP_ID_TARGETS = [
  'User',
  'Group',
  'RecordType',
  'Profile',
  'UserRole',
  'Product2',
  'Pricebook2',
  'PricebookEntry'
] as const

export const DEFAULT_COPIED_MUST_MATCH = ['Product2', 'Pricebook2'] as const

export function emptySeedTemplate(): SeedTemplate {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    source: { expectedOrgId: null },
    runDefaults: { disableTargetAutomation: true },
    keepIdTargets: [...DEFAULT_KEEP_ID_TARGETS],
    copiedObjectsMustMatchSource: [...DEFAULT_COPIED_MUST_MATCH],
    relinkCopiedObjects: [],
    deferredFields: {},
    deferredPlaceholders: {},
    tiers: [],
    subsets: [],
    expectedFailures: [],
    verify: { counts: true, danglingLookups: true, secondPassParity: true }
  }
}

export function emptyPostRefreshTemplate(): PostRefreshTemplate {
  return {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    automation: { flows: [], triggers: [], settingPatches: [] },
    seedTemplates: [],
    verify: { safetyCheck: true }
  }
}

/** The groups a seed template declares, in first-appearance order ('default' when unset). */
export function seedGroups(t: Pick<SeedTemplate, 'tiers'>): string[] {
  const out: string[] = []
  for (const tier of t.tiers) {
    const g = tier.group ?? DEFAULT_TIER_GROUP
    if (!out.includes(g)) out.push(g)
  }
  return out
}

/** The one-line content description shown on the Templates list. */
export function templateDetailLine(kind: TemplateKind, payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>
  const n = (k: number, word: string, plural = `${word}s`): string => `${k} ${k === 1 ? word : plural}`
  switch (kind) {
    case 'seed': {
      const tiers = Array.isArray(p.tiers) ? (p.tiers as SeedTier[]) : []
      const groups = seedGroups({ tiers })
      return groups.length > 1
        ? `${n(tiers.length, 'object')} in ${n(groups.length, 'group')}`
        : n(tiers.length, 'object')
    }
    case 'postRefresh': {
      const a = (p.automation ?? {}) as Record<string, unknown>
      const flows = Array.isArray(a.flows) ? a.flows.length : 0
      const triggers = Array.isArray(a.triggers) ? a.triggers.length : 0
      const patches = Array.isArray(a.settingPatches) ? a.settingPatches.length : 0
      const seeds = Array.isArray(p.seedTemplates) ? p.seedTemplates.length : 0
      const parts = [n(flows, 'flow'), n(triggers, 'trigger')]
      if (patches > 0) parts.push(n(patches, 'setting patch', 'setting patches'))
      parts.push(n(seeds, 'seed template'))
      return parts.join(', ')
    }
    case 'objects': {
      const objects = Array.isArray(p.objects) ? p.objects.length : 0
      return `${n(objects, 'object')} (wizard)`
    }
    case 'mappings':
      return `${n(Object.keys(p).length, 'object')} with mapping overrides (wizard)`
    case 'fields':
      return `${n(Object.keys(p).length, 'object')} with field exclusions (wizard)`
    default:
      return ''
  }
}

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  seed: 'Data seed',
  postRefresh: 'Post-refresh',
  objects: 'Objects',
  mappings: 'Mappings',
  fields: 'Fields'
}
