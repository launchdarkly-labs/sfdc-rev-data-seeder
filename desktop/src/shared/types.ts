/**
 * Shared domain types + the IPC contract between main and renderer.
 * Keep this file dependency-free — it is imported by main, preload, and renderer.
 */
import type { WizardStep, WizardConfig } from './wizard'

export type { WizardStep, WizardConfig }

/**
 * Org roles mirror the Apex app's Org_Connection__c.Org_Role__c semantics
 * with one hard rule carried over from the standing project rules:
 * a `source` connection is READ-ONLY — the transport layer refuses any
 * write to a connection unless its role is exactly 'target'.
 */
export type OrgRole = 'source' | 'target' | 'unassigned'

/** LaunchDarkly production — permanently read-only, can never be a target. */
export const PROD_ORG_ID_PREFIX = '00D41000000UvVn'

export type AuthKind = 'cli' | 'oauth'

/** Connection health surfaced in the Connections UI (A7). */
export type ConnectionStatus = 'Active' | 'Expired' | 'Error' | 'Unauthenticated'

/** Which kind of OAuth app a connection authenticates through (client-config, not a code path). */
export type OAuthClientKind = 'connectedApp' | 'externalClientApp'

export interface OrgConnection {
  /** Stable local identity. CLI-auth rows use the sf alias; OAuth rows use a UUID. */
  id: string
  /** Human label (defaults to the CLI alias / username). */
  label: string
  /** The sf CLI alias for cli-auth orgs; null for OAuth-only connections. */
  cliAlias: string | null
  /** OAuth login host (My Domain / login|test.salesforce.com); null for CLI. */
  loginUrl: string | null
  username: string
  orgId: string
  instanceUrl: string
  role: OrgRole
  authKind: AuthKind
  status: ConnectionStatus
  /** CLI-reported connected status at last enumeration (e.g. 'Connected'). */
  cliStatus: string
  isSandbox: boolean | null
  /** Epoch ms of the last successful live verification (identity call). */
  lastVerifiedAt: number | null
  /** True when the hard prod guard pins this connection read-only. */
  prodPinned: boolean
  /**
   * S52 F3: set when the sf CLI no longer lists this alias but DOES list another
   * alias for the same username — the org lives on under the new name (an alias
   * rename or a sandbox refresh). Superseded rows are hidden from pickers but keep
   * working for the deployments that reference them.
   */
  supersededBy: string | null
}

/** Which sides a deployment create / "Assign roles" actually wrote (S52 F1). */
export interface RoleAssignment {
  source: boolean
  target: boolean
}

export interface DraftCreateResult {
  id: number
  assigned: RoleAssignment
}

export interface VerifyResult {
  ok: boolean
  orgId?: string
  username?: string
  apiVersion?: string
  error?: string
}

/** Slim field describe — the same shape the Apex app caches (SchemaService.FieldInfo). */
export interface FieldInfo {
  apiName: string
  label: string
  type: string
  isReference: boolean
  referenceTo: string[]
  isCreateable: boolean
  isUpdateable: boolean
  isNillable: boolean
  isExternalId: boolean
  isAutoNumber: boolean
  isCalculated: boolean
  isRestrictedPicklist: boolean
  picklistValues: string[]
  length: number | null
}

export interface ObjectInfo {
  apiName: string
  label: string
  custom: boolean
  queryable: boolean
  createable: boolean
  /** S54 (F1): the object's 3-char record-Id key prefix from the global describe.
   *  Optional — global-describe caches written before S54 lack it. */
  keyPrefix?: string | null
}

/** An object viewed through the source∩target lens (wizard Step 1 / ObjectPicker). */
export interface DeployableObject {
  apiName: string
  label: string
  custom: boolean
  /** Managed-package namespace (e.g. 'SBQQ') or null for standard/plain-custom. */
  namespace: string | null
  inSource: boolean
  inTarget: boolean
}

export interface ObjectIntersectionResult {
  /** Union of both orgs' objects, sorted by apiName, with presence flags. */
  objects: DeployableObject[]
  /** In both orgs (deployable). */
  common: number
  /** In source only (excluded — can't write to a target that lacks them). */
  sourceOnly: number
  /** In target only. */
  targetOnly: number
}

/**
 * Long-running work (analysis, deploy, ExtId populate, orphan scan, …) is
 * modeled as a Job. One multiplexed event channel (`rds:job.events`) carries
 * progress for every job; the renderer filters by jobId.
 *
 * X.1 (event-bus unification): the Epic-4 deploy engine's `DeployEvent` is a
 * SUBSET of `JobEvent` — same shape, `data` carries deploy-specific payloads —
 * and the deploy engine's `emit` is implemented BY the main-process JobManager.
 * There is exactly one bus.
 */
export type JobKind =
  'analysis' | 'deploy' | 'coverage' | 'extid-populate' | 'extid-rollback' | 'orphan-scan' | 'demo'

export type JobStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface JobProgress {
  value: number
  max: number
  label?: string
}

export interface JobSummary {
  id: string
  kind: JobKind
  title: string
  deploymentId?: string
  status: JobStatus
  startedAt: number
  progress?: JobProgress
  /** Latest `phase` event name (S46 D3 — lets a re-attached renderer show
   *  where a running job is without replaying events). */
  phase?: string
  /** Present on terminal error. */
  error?: string
}

export type JobEventKind = 'progress' | 'log' | 'phase' | 'done' | 'error' | 'cancelled'

export interface JobEvent {
  jobId: string
  kind: JobEventKind
  ts: number
  data: Record<string, unknown>
}

/**
 * A deployment/draft row summary for lists (Home drafts, History). The wizard
 * draft config lives in `draft_config` and is fetched separately via draft.load.
 */
export interface DeploymentSummary {
  id: number
  name: string
  sourceConnectionId: string
  targetConnectionId: string
  /** Connection labels (JOINed) for display without a second fetch. */
  sourceLabel: string
  targetLabel: string
  status: string
  /** Full text of the last failure (pre-run gate/freeze refusal or the run's
   *  terminal error); null when the last attempt did not fail (S46 D1). */
  errorMessage: string | null
  wizardStep: WizardStep | null
  totalObjects: number | null
  totalRecords: number | null
  /** deploy_runs rows for this deployment — 0 means nothing ever touched the target (S52 F4). */
  runCount: number
  createdAt: number
  updatedAt: number
}

// ── Deploy run state mirror (S46 D2 — rds:deploy.runState) ─────────────────
// These are RENDERER-SAFE mirrors of engine/deploy/types.ts. The renderer
// tsconfig (tsconfig.web.json) cannot import engine types (TS6307), so the
// vocabulary is duplicated here on purpose; services/deployRunState.ts is the
// single place that maps engine rows onto these shapes.

/** Mirror of engine RunPhase (deployDesign §1.3). */
export type DeployRunPhaseView =
  | 'Frozen'
  | 'DisablingAutomation'
  | 'Deploying'
  | 'Retrying'
  | 'SecondPass'
  | 'Finalizing'
  | 'RestoringAutomation'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'
  | 'Stalled'

/** The deployments row header the monitor needs (reads error_message). */
export interface DeploymentHeader {
  id: number
  name: string
  status: string
  errorMessage: string | null
  sourceLabel: string
  targetLabel: string
  createdAt: number
  updatedAt: number
}

/** The latest deploy_runs row for a deployment, as the renderer sees it. */
export interface DeployRunView {
  id: number
  phase: DeployRunPhaseView
  currentObject: string | null
  currentPass: string | null
  cancelRequested: boolean
  teardownOutcome: string | null
  startedAt: number | null
  finishedAt: number | null
}

/** Run-level counters (v_run_counters — Apex recomputeDeploymentCounters SUM). */
export interface DeployCountersView {
  recordsQueried: number
  recordsDeployed: number
  recordsFailed: number
  recordsSkipped: number
}

/** One plan object with its counters (zeros before/without a run). */
export interface DeployObjectStateView extends DeployCountersView {
  objectName: string
  sortOrder: number
  isJunction: boolean
  /** Planned record count (analysis / frozen plan). */
  recordCount: number
}

/**
 * S53 (item 1) — one audit finding for a run, renderer-safe mirror of
 * engine/deploy/automationAudit.AuditFinding.
 *   automation_born  rows the TARGET's own automation created during the run
 *                    (created in the run window by the deploying user, no RDS key)
 *   pre_run_unkeyed  rows that already sat under RDS-keyed parents without a
 *                    key BEFORE the run (residue of an earlier run / hand-made)
 */
export interface RunAuditFindingView {
  kind: 'automation_born' | 'pre_run_unkeyed'
  objectApiName: string
  refObject: string | null
  refField: string | null
  count: number
  sampleIds: string[]
}

/** S53 (item 1) — the run's audit state. `completedAt` null = post-run audit did not run. */
export interface RunAuditView {
  completedAt: number | null
  /** Why the post-run audit was skipped / partial; null = clean, complete. */
  note: string | null
  findings: RunAuditFindingView[]
}

/**
 * Everything the deployment detail page renders in one read: header, latest
 * run (null before the first successful freeze — a pre-run gate/freeze
 * failure leaves the deployment Failed with NO run), counters, plan-ordered
 * objects, and the session's latest deploy job for the deployment. Per-object
 * Failed/Completed status is NOT derivable until E4E.6 — only counters are.
 */
export interface DeployRunStateView {
  deployment: DeploymentHeader
  run: DeployRunView | null
  counters: DeployCountersView | null
  /** Plan order — the frozen plan when a run exists, else the analysis plan. */
  objects: DeployObjectStateView[]
  totalRecords: number
  /** Show the post-run CPQ "uncheck Triggers Disabled" reminder: the run
   *  touched CPQ-gated objects and has finished (or parked). */
  cpqReminder: boolean
  /** Ledger rows for the latest run still awaiting a confirmed restore. */
  restoreUnconfirmed: number
  /** S53: the run's automation audit (null when there is no run). */
  audit: RunAuditView | null
  /** The latest 'deploy' job for this deployment in this app session, if any. */
  job: JobSummary | null
}

/** A loaded draft: the deployment's fixed orgs + name, plus the resumable
 * wizard step and config. */
export interface DraftDetail {
  name: string
  sourceConnectionId: string
  targetConnectionId: string
  sourceLabel: string
  targetLabel: string
  step: WizardStep
  config: WizardConfig
  status: string
}

/** Renderer-facing view of one planned object (the full PlannedObject with its
 * structured scope stays main-side for the deploy engine). */
export interface PlanObjectView {
  objectName: string
  sortOrder: number
  recordCount: number
  apiStrategy: string
  gatingTier: string | null
  isJunction: boolean
  hasCircularReference: boolean
  deferredFields: string[]
  scopedFilterDisplay: string | null
  junctionParents: string[] | null
  requiresTriggerBypass: boolean
  recommendedBatchSize: number
}

/** Persisted analysis plan as the renderer consumes it. */
export interface PlanView {
  deploymentId: number
  objects: PlanObjectView[]
  totalObjects: number
  totalRecords: number
  autoInjectedJunctions: string[]
  warnings: string[]
}

/** Automation discovered on the TARGET org (5B.8 panel; disable/restore = E4A). */
export type AutomationType =
  'ValidationRule' | 'Flow' | 'ApexTrigger' | 'DuplicateRule' | 'CPQTriggerSetting'

/**
 * One discovered automation item — port of the Apex
 * `AutomationManagementService.AutomationItem` polymorphic record.
 */
export interface AutomationItem {
  /** Target record id: VR Id / Flow ACTIVE-VERSION (301) Id / ApexTrigger Id /
   *  DuplicateRule Id; the synthetic 'CPQ_TRIGGER_SETTING' for the legacy setting. */
  id: string
  /** VR ValidationName / Flow ApiName / trigger Name / dup-rule `Object.DeveloperName` fullName. */
  name: string
  objectName: string
  automationType: AutomationType
  isActive: boolean
  /** Flows: TriggerType (scoped path) or ProcessType (org-wide fallback). */
  processType: string | null
  isManagedPackage: boolean
  /** Flow active version captured AT DISCOVERY so restore re-activates exactly it (E4A). */
  restoreVersionNumber: number | null
}

/** Snapshot of target-org automation (port of `AutomationSnapshot`). */
export interface AutomationSnapshot {
  items: AutomationItem[]
  validationRuleCount: number
  flowCount: number
  triggerCount: number
  duplicateRuleCount: number
  /** Legacy `SBQQ__TriggerDisabled__c` custom setting exists (old CPQ versions). */
  hasCpqTriggerSetting: boolean
  /** Plan objects the gating playbook marks requiresTriggerBypass — drives the
   *  manual "Triggers Disabled" attestation when no API-writable setting exists. */
  cpqTriggerGatedObjects: string[]
  /** The scoped flow query failed and discovery fell back to the org-wide sweep
   *  (fail-OPEN: over-disabling is safe, under-disabling is not). */
  flowScopeFallback: boolean
  /** The scoped flow query's error text when `flowScopeFallback` is true (S54 L2 —
   *  the fallback must name its reason). Optional: snapshots persisted before S54 lack it. */
  flowScopeFallbackReason?: string | null
  /** Non-fatal per-section failures (e.g. DuplicateRule unqueryable on this edition). */
  sectionErrors: string[]
}

/**
 * Stable per-item key for `config.automationToggles` (mirrors the Apex
 * `restoreKey`: type + '|' + (id || name)). Item ids can churn between
 * discoveries (a flow's active-version id changes on activation), so unset
 * keys simply fall back to the default (disable).
 */
export function automationItemKey(
  item: Pick<AutomationItem, 'automationType' | 'id' | 'name'>
): string {
  return `${item.automationType}|${item.id || item.name}`
}

/**
 * Typed IPC error envelope. Electron only reliably preserves an Error's
 * `message` across the invoke boundary (custom props are dropped), so the
 * main-side `wrapHandler` encodes the envelope INTO the message with a tagged
 * prefix and the renderer's `callIpc` decodes it. `AUTH_EXPIRED` is routed to a
 * global re-auth prompt.
 */
export type RdsErrorCode =
  | 'AUTH_EXPIRED'
  | 'READ_ONLY_ORG'
  | 'SCOPE_OVERFLOW'
  | 'SOQL_INVALID'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'UNKNOWN'

export interface RdsError {
  code: RdsErrorCode
  message: string
  detail?: string
  /** For AUTH_EXPIRED: which connection needs re-auth. */
  connection?: string
}

export const RDS_ERR_PREFIX = 'RDS_ERR::'

export function encodeRdsError(err: RdsError): string {
  return RDS_ERR_PREFIX + JSON.stringify(err)
}

/**
 * Extract an RdsError from a thrown/serialized message. Uses indexOf (not
 * startsWith) because Electron wraps the message as
 * "Error invoking remote method '<ch>': Error: RDS_ERR::{…}".
 */
export function parseRdsError(message: string): RdsError | null {
  const at = message.indexOf(RDS_ERR_PREFIX)
  if (at < 0) return null
  try {
    const parsed = JSON.parse(message.slice(at + RDS_ERR_PREFIX.length)) as RdsError
    return parsed && typeof parsed.code === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** IPC channel names — single source of truth. */
export const IPC = {
  listOrgs: 'rds:listOrgs',
  refreshOrgs: 'rds:refreshOrgs',
  setOrgRole: 'rds:setOrgRole',
  verifyOrg: 'rds:verifyOrg',
  orgRemove: 'rds:org.remove',
  describeGlobal: 'rds:describeGlobal',
  describeObject: 'rds:describeObject',
  jobList: 'rds:job.list',
  jobCancel: 'rds:job.cancel',
  jobDemo: 'rds:job.demo',
  jobEvents: 'rds:job.events',
  draftCreate: 'rds:draft.create',
  draftSave: 'rds:draft.save',
  draftLoad: 'rds:draft.load',
  draftList: 'rds:draft.list',
  draftDelete: 'rds:draft.delete',
  deploymentAssignRoles: 'rds:deployment.assignRoles',
  planGet: 'rds:plan.get',
  planReorder: 'rds:plan.reorder',
  automationDiscover: 'rds:automation.discover',
  objectsIntersection: 'rds:objects.intersection',
  filterValidate: 'rds:filter.validate',
  sampleGet: 'rds:sample.get',
  fieldsPopulated: 'rds:fields.populated',
  mappingsSuggest: 'rds:mappings.suggest',
  templateList: 'rds:template.list',
  templateSave: 'rds:template.save',
  templateRename: 'rds:template.rename',
  templateDelete: 'rds:template.delete',
  analyze: 'rds:analyze',
  deployStart: 'rds:deploy.start',
  deployRunState: 'rds:deploy.runState',
  oauthBegin: 'rds:oauth.begin',
  oauthDisconnect: 'rds:oauth.disconnect',
  readinessCheck: 'rds:readiness.check',
  readinessCreateExtId: 'rds:readiness.createExtId',
  readinessProvisionExtIds: 'rds:readiness.provisionExtIds',
  targetKeyedObjects: 'rds:target.keyedObjects'
} as const

/** S57 (B1): the target's knowledge of out-of-scope objects (see RdsApi.targetKeyedObjects). */
export interface TargetKeyedObjectsResult {
  /** Requested objects that carry `Data_Deployment_External_Id__c` on the target. */
  hasField: string[]
  /** Requested objects with at least one RDS-keyed row on the target. */
  keyedRows: string[]
}

/** The permission set the app creates to grant itself FLS on the ExtId fields (S46). */
export const RDS_PERMISSION_SET = 'RDS_Deployment_Access'

/** Outcome of a bulk ExtId provision (S46) — per-object detail plus the fresh report. */
export interface ProvisionExtIdsSummary {
  created: string[]
  alreadyPresent: string[]
  granted: string[]
  skippedJunctions: string[]
  failures: { objectName: string; error: string }[]
  /** S57 (B4): objects whose entity refuses custom fields — never creatable; also in `failures`. */
  unprovisionable?: string[]
  permissionSetCreated: boolean
  assignmentCreated: boolean
  permissionSetName: string
  report: ReadinessReport
}

/** Per-object target-readiness (5B.4): can the seeder upsert-key this object? */
export interface ObjectReadiness {
  objectName: string
  /** Junctions are exempt from the ExtId requirement (matched by lookup pair). */
  isJunction: boolean
  hasExtIdField: boolean
  extIdIsExternalId: boolean
  /** A non-junction object whose ExtId field is absent/not-flagged needs a fix. */
  needsExtIdField: boolean
  /** Set when the target object could not be described (missing/no access); the
   *  rest of the report is still returned. Not treated as needing a field. */
  describeError?: string
  /**
   * S57 (B4): the entity does not support custom fields, so the key can NEVER be
   * provisioned — the row is permanently red until the object is deselected.
   * From the registry (shared/extIdCapability) or a Provision refusal.
   */
  cannotHostCustomField?: boolean
}

export interface ReadinessReport {
  objects: ObjectReadiness[]
  objectCount: number
  junctionCount: number
  missingExtIdCount: number
  ready: boolean
}

/** Well-known OAuth login hosts (My Domain can be entered as a custom host). */
export const LOGIN_HOSTS = {
  production: 'https://login.salesforce.com',
  sandbox: 'https://test.salesforce.com'
} as const

/** Input for starting an interactive OAuth sign-in (A7 → A4 authorize). */
export interface OAuthBeginInput {
  /** Full login host, e.g. https://login.salesforce.com or a My Domain URL. */
  loginUrl: string
  /** Optional human label; defaults to the authenticated username. */
  label?: string
  /** When set, re-authenticate this existing connection in place instead of creating one. */
  reauthConnectionId?: string
}

/** Result of validating a Step-2 filter clause via a COUNT() on the source org. */
export interface FilterValidateResult {
  ok: boolean
  /** Exact matching-record count (when ok). */
  count?: number
  /** SOQL error message (when !ok) — surfaced inline, not as a global error. */
  error?: string
  /** The COUNT() SOQL actually run (trailing ORDER BY/LIMIT/OFFSET stripped). */
  soql: string
  /** The top-level trailing clause (ORDER BY/LIMIT/OFFSET) stripped for the count, or null. */
  strippedClause: string | null
  /** S54 (F1): when the count is 0 and the clause holds a literal record Id that
   *  cannot match — a key prefix of another object, or a record that lives on the
   *  TARGET org — one sentence saying so. Null when there is nothing to add. */
  hint?: string | null
}

/**
 * Result of fetching one source sample record's field values (5B.5 Mappings).
 * A query/access error is surfaced inline in the sample column (pain 3.17 — typed
 * error instead of a silent blank), so it is a domain result, never a thrown error.
 */
export interface SampleGetResult {
  ok: boolean
  /** fieldApiName → source value (null when the sampled record has no value). */
  values?: Record<string, unknown>
  /** SOQL/access error (when !ok) — shown in the sample column, not as a toast. */
  error?: string
}

/** A Suggest verdict: copy the raw Id (shared-Id orgs) vs match by name. */
export type SuggestedStrategy = 'directId' | 'nameMatch'

/** Raw sampled/found counts for one Suggest probe object. */
export interface IdOverlap {
  sampled: number
  found: number
}

/**
 * Result of the mapping "Suggest" Id-overlap probe (5B.5). The renderer applies
 * `recommendationByObject[refTo] ?? recommendation` to each directId-default
 * reference field (unlocked) to flip divergent-Id orgs to nameMatch.
 */
export interface MappingSuggestions {
  idsMatch: boolean
  recommendation: SuggestedStrategy
  recommendationByObject: Record<string, SuggestedStrategy>
  checked: Record<string, IdOverlap>
}

/**
 * Result of the populated-fields probe (5B.6): which of the given source fields
 * are non-blank in a small sample. Read-only, never throws (domain result).
 */
export interface FieldsPopulatedResult {
  ok: boolean
  /** Field API names found non-blank in the sample (when ok). */
  populated?: string[]
  /** SOQL/access error (when !ok) — shown inline, populated-only degrades to "all". */
  error?: string
}

/** Kind of reusable wizard template (5B.5 builds 'mappings'; others are reserved). */
export type TemplateKind = 'objects' | 'mappings' | 'fields'

/** A saved wizard template. `payload` shape depends on `kind` (mappings → WizardConfig['mappings']). */
export interface Template {
  id: number
  kind: TemplateKind
  name: string
  payload: unknown
  createdAt: number
  updatedAt: number
}

/** The API surface preload exposes to the renderer as `window.rds`. */
export interface RdsApi {
  /** Connections known to the local store (merged with live sf CLI list on refresh). */
  listOrgs(): Promise<OrgConnection[]>
  /** Re-enumerate the sf CLI and merge into the store. */
  refreshOrgs(): Promise<OrgConnection[]>
  setOrgRole(connectionId: string, role: OrgRole): Promise<OrgConnection[]>
  /** Live identity check — mints a token and calls the org. */
  verifyOrg(connectionId: string): Promise<VerifyResult>
  /** Remove a connection row (CLI or OAuth; OAuth also revokes + wipes tokens). Refuses if a deployment references it. */
  orgRemove(connectionId: string): Promise<OrgConnection[]>
  /**
   * Start an interactive OAuth sign-in (system browser + PKCE loopback). Creates
   * a new connection (or re-authenticates `reauthConnectionId`) and returns the
   * updated connection list. Long-running: awaits the browser round-trip.
   */
  oauthBegin(input: OAuthBeginInput): Promise<OrgConnection[]>
  /** Revoke + wipe an OAuth connection's tokens and remove it. Returns the updated list. */
  oauthDisconnect(connectionId: string): Promise<OrgConnection[]>
  /** 5B.4: check the target has an ExtId upsert-key field on each in-scope object (read-only). */
  readinessCheck(deploymentId: number): Promise<ReadinessReport>
  /** 5B.4: create the ExtId field on one target object (write) → fresh per-object readiness. */
  readinessCreateExtId(deploymentId: number, objectName: string): Promise<ObjectReadiness>
  /** S46: create every missing ExtId field in scope AND grant the running user FLS
   *  on them via the app's permission set (write) → fresh whole-report readiness. */
  readinessProvisionExtIds(deploymentId: number): Promise<ProvisionExtIdsSummary>
  /**
   * S57 (B1): what the TARGET knows about objects OUTSIDE the deployment scope —
   * which carry the ExtId field (org-wide Tooling oracle, cached) and which hold at
   * least one RDS-keyed row (LIMIT 1 probe each). Read-only; per-object failures
   * fail OPEN (object reported as unknown ⇒ treated as not keyed).
   */
  targetKeyedObjects(input: {
    targetConnectionId: string
    objectNames: string[]
  }): Promise<TargetKeyedObjectsResult>
  describeGlobal(connectionId: string): Promise<ObjectInfo[]>
  describeObject(connectionId: string, objectApiName: string): Promise<FieldInfo[]>
  /** Snapshot of all jobs this session (running + terminal) — used to re-attach after a renderer reload. */
  jobList(): Promise<JobSummary[]>
  /** Cooperative cancel: sets the job's cancel token; the job stops at its next checkpoint. */
  jobCancel(jobId: string): Promise<void>
  /** Starts a trivial sleep-with-progress job (proves the event loop end-to-end). */
  jobDemo(): Promise<{ jobId: string }>
  /** Subscribe to the multiplexed job-event stream. Returns an unsubscribe fn. */
  onJobEvent(cb: (event: JobEvent) => void): () => void
  /**
   * Create a new draft deployment; returns its id plus which connection roles
   * the pick just assigned (S52 F1 — an unassigned org picked as source/target
   * becomes that role; rows that already have a role are never changed).
   */
  draftCreate(input: {
    name: string
    sourceConnectionId: string
    targetConnectionId: string
  }): Promise<DraftCreateResult>
  /** S52 F2: assign the deployment's pair their roles if (and only if) they are unassigned. */
  deploymentAssignRoles(deploymentId: number): Promise<RoleAssignment>
  /** Persist the wizard draft (step + config) for a deployment. */
  draftSave(input: { deploymentId: number; step: WizardStep; config: WizardConfig }): Promise<void>
  /** Load a draft's orgs + step + config + status (null if unknown). */
  draftLoad(deploymentId: number): Promise<DraftDetail | null>
  /** Drafts/plans in a resumable/deletable status (Home + History). */
  draftList(): Promise<DeploymentSummary[]>
  /** Delete a draft/plan (guarded: running or unconfirmed-restore blocked). */
  draftDelete(deploymentId: number): Promise<void>
  /** The persisted analysis plan for a deployment (null if not yet analyzed). */
  planGet(deploymentId: number): Promise<PlanView | null>
  /** Slot-refill reorder (5B.8): apply the user's object order, return the fresh plan. */
  planReorder(input: { deploymentId: number; objectOrder: string[] }): Promise<PlanView>
  /** Discover target-org automation scoped to the plan (5B.8 panel — read-only). */
  automationDiscover(deploymentId: number): Promise<AutomationSnapshot>
  /** Source∩target object intersection (Step 1); `force` busts the describe cache. */
  objectsIntersection(input: {
    sourceConnectionId: string
    targetConnectionId: string
    force?: boolean
  }): Promise<ObjectIntersectionResult>
  /** Validate a Step-2 filter clause with an exact COUNT() on the source org (never throws). */
  filterValidate(input: {
    connectionId: string
    objectName: string
    filterClause: string
    /** S54 (F1): lets a zero-match literal Id be probed on the target (read-only). */
    targetConnectionId?: string
  }): Promise<FilterValidateResult>
  /** Fetch one source sample record's values for the given fields (5B.5; read-only, never throws). */
  sampleGet(input: {
    connectionId: string
    objectName: string
    fieldNames: string[]
  }): Promise<SampleGetResult>
  /** Which of the given source fields are non-blank in a small sample (5B.6; read-only, never throws). */
  fieldsPopulated(input: {
    connectionId: string
    objectName: string
    fieldNames: string[]
  }): Promise<FieldsPopulatedResult>
  /** Id-overlap probes (5B.5) → suggested directId/nameMatch per stable/catalog object (read-only). */
  mappingsSuggest(input: {
    sourceConnectionId: string
    targetConnectionId: string
  }): Promise<MappingSuggestions>
  /** Saved wizard templates of a kind, newest first (5B.5). */
  templateList(kind: TemplateKind): Promise<Template[]>
  /** Create-or-overwrite a template by (kind, name); returns the saved row. */
  templateSave(input: { kind: TemplateKind; name: string; payload: unknown }): Promise<Template>
  /** Rename a template (fails if the new name is taken within its kind). */
  templateRename(input: { id: number; name: string }): Promise<void>
  /** Delete a template by id. */
  templateDelete(id: number): Promise<void>
  /** Run the analysis engine for a deployment as a background job; returns its jobId. */
  analyze(deploymentId: number): Promise<{ jobId: string }>
  /** 5B.9 — freeze the plan and start the deploy run (disable → deploy →
   *  finalize → restore) as a background job; returns its jobId. Refuses when
   *  the CPQ attestation is required but unticked or the target role is
   *  invalid. */
  deployStart(deploymentId: number): Promise<{ jobId: string }>
  /** S46 D2: one read for the deployment detail page — header (status +
   *  full error), latest run + counters, plan-ordered objects, CPQ reminder,
   *  unconfirmed-restore count, and this session's latest deploy job. */
  deployRunState(deploymentId: number): Promise<DeployRunStateView>
}
