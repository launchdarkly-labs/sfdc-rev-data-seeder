/**
 * objectPolicy — TypeScript port of ObjectPolicyService.cls (N6 Object Gating
 * Playbook resolver) for the RDS Desktop engine.
 *
 * Decides throughput/safety PER OBJECT instead of with one global REST/Bulk
 * threshold. The rule of thumb (Jack's principle): an object with no managed
 * package around it and no playbook entry saying it's gated is FREE — power
 * through at max page/batch and skip needless automation-disable. Otherwise
 * consult the playbook for the prescribed handling (strategy, batch size,
 * trigger-bypass), because CPQ Contracts/Subscriptions/QuoteLines carry
 * managed-package triggers, activation locks, and calc-on-insert that must be
 * suppressed and loaded carefully.
 *
 * Resolution order (first match wins):
 *   1. explicit entry in objects{} keyed by API name
 *   2. namespace rule matched from the object's API-name prefix (e.g. SBQQ__*)
 *   3. runtime-detected customer/managed automation → conservative gated-detected
 *   4. defaultPolicy (free)
 *
 * ── Deliberate deviations from the Apex original ─────────────────────────────
 * 1. STATIC RESOURCE → EMBEDDED CONSTANT. The Apex SOQL-loads StaticResource
 *    RDS_ObjectGatingPlaybook; the desktop app has no org, so the resource's
 *    exact JSON (force-app/main/default/staticresources/RDS_ObjectGatingPlaybook.json,
 *    version 1) is embedded verbatim as the typed constant SHIPPED_PLAYBOOK.
 *    The default load path round-trips it through JSON.stringify/JSON.parse so
 *    the single parse/validate/fail-open code path is preserved (and the cache
 *    gets a fresh deep copy, matching Apex deserializing a fresh instance).
 *    Consequence: the Apex "resource missing" branch is unreachable on the
 *    default path — the built-in fail-open playbook (version 0) remains
 *    reachable exactly as in Apex via a malformed/incomplete JSON override.
 * 2. @TestVisible hooks → exported functions. playbookJsonOverride is set via
 *    setPlaybookJsonOverride(); clearCache() and namespaceOf() are exported.
 *    REST_COMPOSITE_MAX / REST_PAGE_MAX (private in Apex) are exported too.
 * 3. JSON STRICTNESS. Apex JSON.deserialize is type-strict (a wrong-typed field
 *    like "version":"abc" throws → fail-open); JSON.parse is not, so such JSON
 *    is accepted here as long as it parses and carries a non-null defaultPolicy.
 *    Syntactically invalid JSON and a missing defaultPolicy fail open identically.
 * 4. null/undefined. Apex has only null; JSON.parse yields undefined for absent
 *    keys. All checks use `== null` so undefined is treated exactly like Apex null.
 * 5. detected-set lookup requires a non-null objectName (Apex Set<String> could
 *    technically contain null and match a null objectName; TS Set<string> cannot).
 * 6. No System.debug logging on parse/load failure — failures fall open silently.
 */

export const STRATEGY_REST = 'REST'
export const STRATEGY_BULK = 'Bulk'
export const STRATEGY_AUTO = 'auto'

/** composite/sobjects hard cap (private in Apex; exported for tests/engine). */
export const REST_COMPOSITE_MAX = 200
/** Sforce-Query-Options ceiling (private in Apex; exported for tests/engine). */
export const REST_PAGE_MAX = 2000

// ───────────────────────── DTOs (mirror the JSON schema) ─────────────────────

export interface NamespaceRule {
  namespace?: string | null
  tier?: string | null
  apiStrategy?: string | null
  restPageSize?: number | null
  restMaxRecords?: number | null
  bulkBatchSize?: number | null
  requiresTriggerBypass?: boolean | null
  requiresAutomationDisable?: boolean | null
  note?: string | null
}

export interface PolicyEntry {
  tier?: string | null
  apiStrategy?: string | null
  restPageSize?: number | null
  restMaxRecords?: number | null
  bulkBatchSize?: number | null
  bulkMode?: string | null
  requiresTriggerBypass?: boolean | null
  requiresAutomationDisable?: boolean | null
  secondPass?: string | null
  gatedBy?: string[] | null
  specialHandling?: string[] | null
  note?: string | null
  source?: string | null
}

export interface Playbook {
  version?: number | null
  defaultPolicy?: PolicyEntry | null
  namespaceRules?: NamespaceRule[] | null
  objects?: Record<string, PolicyEntry> | null
}

// ───────────────────── the never-null result the engine consumes ─────────────

/**
 * Fields are typed nullable to mirror the Apex DTO, but every policy returned
 * by resolve() has been through fillDefaults() and carries non-null values.
 */
export interface ResolvedPolicy {
  objectName: string | null
  tier: string | null
  /** REST | Bulk | auto */
  apiStrategy: string | null
  /** source-query Sforce-Query-Options batchSize */
  restPageSize: number | null
  restMaxRecords: number | null
  bulkBatchSize: number | null
  requiresTriggerBypass: boolean | null
  requiresAutomationDisable: boolean | null
  /** object | namespace:<ns> | detected | default */
  matchReason: string
}

// ───────────── the playbook the app ships (see deviation note 1) ─────────────

/**
 * Verbatim port of static resource RDS_ObjectGatingPlaybook.json (version 1).
 * Re-tuning the playbook is an edit to this constant, not to the resolver.
 */
export const SHIPPED_PLAYBOOK: Playbook = {
  version: 1,
  defaultPolicy: {
    tier: 'free',
    apiStrategy: 'auto',
    restPageSize: 2000,
    restMaxRecords: 10000,
    bulkBatchSize: 10000,
    bulkMode: 'parallel',
    requiresTriggerBypass: false,
    requiresAutomationDisable: true,
    secondPass: 'auto'
  },
  namespaceRules: [
    {
      namespace: 'SBQQ',
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      note:
        'Salesforce CPQ managed triggers (calc, contract/renewal/amendment). Suppress via the CPQ guard + ' +
        'SBQQ.TriggerControl; never Bulk (Bulk loses the dup-rule header, strip gates, and Contract idempotency guard).'
    },
    {
      namespace: 'blng',
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      note: 'Salesforce Billing managed package. Treat like CPQ.'
    },
    {
      namespace: 'SBQQSC',
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      note:
        'Service Cloud for CPQ. NOT covered by the CPQ Triggers-Disabled setting (known issue); needs its own ' +
        'handling if present.'
    }
  ],
  objects: {
    Contract: {
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      gatedBy: [
        'Standard platform: cannot INSERT with Status=Activated (FAILED_ACTIVATION)',
        "Activated Contract is edit-locked (and its master-detail children) for users without 'Activate Contracts'",
        'SBQQ ContractAfter / renewal / amendment triggers fire on activation and on the Contracted checkbox'
      ],
      specialHandling: [
        'Insert Status=Draft; activate in a post-deploy second pass (PostDeploymentQueueable)',
        'Idempotent re-run: skip already-Activated target Contracts (queryActivatedContractExtIds guard)',
        "Grant the integration user 'Activate Contracts'",
        'Load Subscriptions BEFORE activating the Contract',
        'Never toggle SBQQ__RenewalForecast__c / SBQQ__RenewalQuoted__c during load'
      ],
      source: 'cpq-research.md 4'
    },
    Order: {
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      gatedBy: ['Draft-then-activate; OrderItems cannot be added to an activated Order'],
      specialHandling: ['Insert Draft, activate in a second pass'],
      source: 'cpq-research.md 1.2 phase 10'
    },
    OrderItem: {
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      gatedBy: ['Requires PricebookEntry; parent Order must be Draft'],
      source: 'cpq-research.md'
    },
    OpportunityLineItem: {
      tier: 'gated',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      gatedBy: [
        'CPQ quote-opp twin/sync when a primary quote exists',
        'UnitPrice/TotalPrice mutually exclusive on insert'
      ],
      specialHandling: [
        'Drop TotalPrice (keep UnitPrice)',
        'PricebookEntry must exist and be active on target'
      ],
      source: 'cpq-research.md 1, transform map'
    },
    OpportunityContactRole: {
      tier: 'junction',
      apiStrategy: 'REST',
      restPageSize: 200,
      requiresTriggerBypass: true,
      gatedBy: ['Cannot hold an ExtId / unique custom field (FIELD_INTEGRITY_EXCEPTION)'],
      specialHandling: [
        'Insert-only + target-side dedupe (dedicated junction path); no ExtId upsert; single pass'
      ],
      source: 'cpq-research.md 1.1; history OCR notes'
    },
    Account: {
      tier: 'semi',
      apiStrategy: 'auto',
      restPageSize: 2000,
      requiresTriggerBypass: false,
      requiresAutomationDisable: true,
      gatedBy: ['Customer flows/VRs/triggers likely (detect at analysis)'],
      note: 'No managed gating; free throughput once customer automation on it is disabled.'
    },
    Contact: {
      tier: 'semi',
      apiStrategy: 'auto',
      restPageSize: 2000,
      requiresTriggerBypass: false,
      requiresAutomationDisable: true
    },
    Opportunity: {
      tier: 'semi',
      apiStrategy: 'auto',
      restPageSize: 2000,
      requiresTriggerBypass: true,
      requiresAutomationDisable: true,
      gatedBy: [
        'SBQQ__Contracted__c trip-wire generates Contract/Subscription/Asset when true + triggers on'
      ],
      specialHandling: ['Load with triggers off; Contracted flag is inert data during load'],
      source: 'cpq-research.md 2.3'
    }
  }
}

// ─────────────────────────── module state (Apex statics) ─────────────────────

let playbookJsonOverride: string | null = null
let cachedPlaybook: Playbook | null = null

/**
 * Tests inject JSON here so resolution is deterministic and independent of the
 * shipped playbook (mirrors the Apex @TestVisible playbookJsonOverride).
 * Pass null to restore the shipped playbook. Call clearCache() after changing.
 */
export function setPlaybookJsonOverride(json: string | null): void {
  playbookJsonOverride = json
}

/** Mirrors the Apex @TestVisible clearCache(). */
export function clearCache(): void {
  cachedPlaybook = null
}

// ─────────────────────────────── public API ──────────────────────────────────

/**
 * @param objectName API name of the object being planned.
 * @param objectsWithDetectedAutomation objects that analysis found to carry
 *        active managed triggers or customer flows/VRs (may be null/empty).
 */
export function resolve(
  objectName: string | null,
  objectsWithDetectedAutomation?: ReadonlySet<string> | null
): ResolvedPolicy {
  const pb = getPlaybook()
  const def = pb.defaultPolicy ?? null

  const rp: ResolvedPolicy = {
    objectName,
    tier: null,
    apiStrategy: null,
    restPageSize: null,
    restMaxRecords: null,
    bulkBatchSize: null,
    requiresTriggerBypass: null,
    requiresAutomationDisable: null,
    matchReason: 'default'
  }

  // 1. explicit object entry (own-key lookup only — Apex Map.get never walks
  //    the prototype chain, so e.g. 'toString'/'constructor' must not match)
  const entry =
    pb.objects != null &&
    objectName != null &&
    Object.prototype.hasOwnProperty.call(pb.objects, objectName)
      ? (pb.objects[objectName] ?? null)
      : null
  if (entry != null) {
    applyEntry(rp, entry)
    rp.matchReason = 'object'
    return fillDefaults(rp, def)
  }

  // 2. namespace-prefix rule (SBQQ__*, blng__*, ...)
  const ns = namespaceOf(objectName)
  if (ns != null && pb.namespaceRules != null) {
    for (const nr of pb.namespaceRules) {
      if (nr.namespace != null && equalsIgnoreCase(nr.namespace, ns)) {
        applyNamespace(rp, nr)
        rp.matchReason = 'namespace:' + nr.namespace
        return fillDefaults(rp, def)
      }
    }
  }

  // 3. runtime-detected automation → conservative gated-detected
  if (
    objectsWithDetectedAutomation != null &&
    objectName != null &&
    objectsWithDetectedAutomation.has(objectName)
  ) {
    rp.tier = 'gated-detected'
    rp.apiStrategy = STRATEGY_REST
    rp.restPageSize = REST_COMPOSITE_MAX
    rp.requiresAutomationDisable = true
    // leave requiresTriggerBypass unset → false unless a managed ns matched
    rp.matchReason = 'detected'
    return fillDefaults(rp, def)
  }

  // 4. free default
  return fillDefaults(rp, def)
}

/**
 * Decide REST vs Bulk for a resolved policy given the counts. Gated objects
 * (apiStrategy REST) always route REST regardless of record count — this is
 * the proper fix for the N5 backtrack (a large SBQQ__* object must never
 * fall to Bulk, which lacks the dup-rule header / strip gates / Contract
 * guard / trigger-bypass). Free/auto objects fall back to size-based routing.
 */
export function decideStrategy(
  rp: ResolvedPolicy,
  recordCount: number | null,
  totalObjectCount: number | null,
  recordThreshold: number | null,
  objectThreshold: number | null
): string {
  if (recordCount == null || recordCount === 0) return STRATEGY_REST
  const s = rp.apiStrategy
  if (s != null && equalsIgnoreCase(STRATEGY_REST, s)) return STRATEGY_REST
  if (s != null && equalsIgnoreCase(STRATEGY_BULK, s)) return STRATEGY_BULK
  // auto — size-based
  const maxRest = rp.restMaxRecords != null ? rp.restMaxRecords : recordThreshold
  const fitsRecords = maxRest == null || recordCount <= maxRest
  const fitsObjects =
    objectThreshold == null || totalObjectCount == null || totalObjectCount <= objectThreshold
  return fitsRecords && fitsObjects ? STRATEGY_REST : STRATEGY_BULK
}

/** The per-object write batch size for the chosen strategy (REST capped at 200). */
export function recommendedBatchSize(rp: ResolvedPolicy, chosenStrategy: string | null): number {
  if (chosenStrategy != null && equalsIgnoreCase(STRATEGY_BULK, chosenStrategy)) {
    return rp.bulkBatchSize != null ? rp.bulkBatchSize : 10000
  }
  const page = rp.restPageSize != null ? rp.restPageSize : REST_COMPOSITE_MAX
  return Math.min(page, REST_COMPOSITE_MAX)
}

// ─────────────────────────────── internals ───────────────────────────────────

function applyEntry(rp: ResolvedPolicy, e: PolicyEntry): void {
  rp.tier = e.tier ?? null
  rp.apiStrategy = e.apiStrategy ?? null
  rp.restPageSize = e.restPageSize ?? null
  rp.restMaxRecords = e.restMaxRecords ?? null
  rp.bulkBatchSize = e.bulkBatchSize ?? null
  rp.requiresTriggerBypass = e.requiresTriggerBypass ?? null
  rp.requiresAutomationDisable = e.requiresAutomationDisable ?? null
}

function applyNamespace(rp: ResolvedPolicy, n: NamespaceRule): void {
  rp.tier = n.tier ?? null
  rp.apiStrategy = n.apiStrategy ?? null
  rp.restPageSize = n.restPageSize ?? null
  rp.restMaxRecords = n.restMaxRecords ?? null
  rp.bulkBatchSize = n.bulkBatchSize ?? null
  rp.requiresTriggerBypass = n.requiresTriggerBypass ?? null
  rp.requiresAutomationDisable = n.requiresAutomationDisable ?? null
}

function fillDefaults(rp: ResolvedPolicy, defIn: PolicyEntry | null): ResolvedPolicy {
  const def = defIn ?? builtInDefaultEntry()
  if (rp.tier == null) rp.tier = coalesceString(def.tier, 'free')
  if (rp.apiStrategy == null) rp.apiStrategy = coalesceString(def.apiStrategy, STRATEGY_AUTO)
  if (rp.restMaxRecords == null) rp.restMaxRecords = def.restMaxRecords ?? 10000
  if (rp.bulkBatchSize == null) rp.bulkBatchSize = def.bulkBatchSize ?? 10000
  if (rp.requiresTriggerBypass == null)
    rp.requiresTriggerBypass = def.requiresTriggerBypass === true
  if (rp.requiresAutomationDisable == null) {
    rp.requiresAutomationDisable =
      def.requiresAutomationDisable == null ? true : def.requiresAutomationDisable
  }
  // clamp REST page size to the platform window
  let page = rp.restPageSize
  if (page == null) page = def.restPageSize ?? REST_PAGE_MAX
  if (page > REST_PAGE_MAX) page = REST_PAGE_MAX
  if (page < 1) page = REST_COMPOSITE_MAX
  rp.restPageSize = page
  return rp
}

/**
 * Managed object API names look like <ns>__<Object>__c (two "__" segments).
 * A plain custom object is <Object>__c (one). Return the namespace only for
 * the two-segment form so plain custom objects fall through to free.
 * (@TestVisible in Apex → exported here.)
 */
export function namespaceOf(objectName: string | null | undefined): string | null {
  if (objectName == null || objectName.trim() === '') return null
  const idx = objectName.indexOf('__')
  if (idx <= 0) return null
  const candidate = objectName.substring(0, idx)
  const rest = objectName.substring(idx + 2)
  if (!rest.includes('__')) return null // <Object>__c → not namespaced
  return candidate
}

function getPlaybook(): Playbook {
  if (cachedPlaybook != null) return cachedPlaybook
  const jsonStr = loadJson()
  if (jsonStr != null && jsonStr.trim() !== '') {
    try {
      const pb = JSON.parse(jsonStr) as Playbook | null
      if (pb != null && pb.defaultPolicy != null) {
        cachedPlaybook = pb
        return cachedPlaybook
      }
    } catch {
      // playbook JSON parse failed → fail open to the built-in default below
      // (Apex logs a System.debug line here; see deviation note 6)
    }
  }
  cachedPlaybook = builtInPlaybook()
  return cachedPlaybook
}

function loadJson(): string | null {
  if (playbookJsonOverride != null) return playbookJsonOverride
  // Deviation note 1: the Apex SOQL-loads the RDS_ObjectGatingPlaybook static
  // resource here; the desktop app ships it embedded. Round-tripping keeps the
  // one parse/validate path and hands the cache a fresh deep copy.
  return JSON.stringify(SHIPPED_PLAYBOOK)
}

// ───────────────── fail-open built-in default (no resource) ──────────────────

function builtInDefaultEntry(): PolicyEntry {
  return {
    tier: 'free',
    apiStrategy: STRATEGY_AUTO,
    restPageSize: REST_PAGE_MAX,
    restMaxRecords: 10000,
    bulkBatchSize: 10000,
    requiresTriggerBypass: false,
    requiresAutomationDisable: true
  }
}

function gatedNs(ns: string, note: string): NamespaceRule {
  return {
    namespace: ns,
    tier: 'gated',
    apiStrategy: STRATEGY_REST,
    restPageSize: REST_COMPOSITE_MAX,
    requiresTriggerBypass: true,
    note
  }
}

function gatedObj(): PolicyEntry {
  return {
    tier: 'gated',
    apiStrategy: STRATEGY_REST,
    restPageSize: REST_COMPOSITE_MAX,
    requiresTriggerBypass: true
  }
}

/**
 * The fail-safe playbook used when the injected JSON is missing/unparseable.
 * It still gates the known CPQ graph so correctness holds even without the
 * shipped playbook — only the richer notes/handling metadata are absent.
 */
function builtInPlaybook(): Playbook {
  const ocr = gatedObj()
  ocr.tier = 'junction'
  return {
    version: 0, // 0 → built-in fallback (shipped playbook carries version >= 1)
    defaultPolicy: builtInDefaultEntry(),
    namespaceRules: [
      gatedNs('SBQQ', 'Salesforce CPQ managed triggers.'),
      gatedNs('blng', 'Salesforce Billing managed package.'),
      gatedNs('SBQQSC', 'Service Cloud for CPQ.')
    ],
    objects: {
      Contract: gatedObj(),
      Order: gatedObj(),
      OrderItem: gatedObj(),
      OpportunityLineItem: gatedObj(),
      OpportunityContactRole: ocr
    }
  }
}

// ─────────────────────────────── helpers ─────────────────────────────────────

/** Apex String.equalsIgnoreCase (null-safe on neither side; callers guard). */
function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Apex coalesce(String, String): blank (null/empty/whitespace) → fallback. */
function coalesceString(v: string | null | undefined, fallback: string): string {
  return v != null && v.trim() !== '' ? v : fallback
}
