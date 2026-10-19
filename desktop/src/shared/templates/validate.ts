/**
 * Hand-written validation for the two runnable template kinds (S59 plan §3.2).
 * No runtime schema library in package.json — every rule is a plain check that
 * returns `{ path, message }` pairs the builder lists by field.
 *
 * Save-time rules only. Run-time facts (the referenced seed templates exist,
 * the picked source matches `expectedOrgId`) are the runner's preflight.
 */
import {
  BATCH_SIZE_MAX,
  BATCH_SIZE_MIN,
  DEFAULT_TIER_GROUP,
  FLOW_ACTIONS,
  SEED_HANDLERS,
  TEMPLATE_SCHEMA_VERSION,
  TRIGGER_ACTIONS,
  type PostRefreshTemplate,
  type SeedTemplate
} from './types'

export interface ValidationError {
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
}

/** Salesforce API name: `Name`, `My_Field__c`, `ns__Obj__c`, `Obj__mdt`, `Rel__r`; dots for namespaced flows. */
export const API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(__c|__r|__mdt|__x|__e|__b)?$/
/** Flow API names may carry a namespace dot (`ns.Flow_Name`) — one dot at most. */
export const FLOW_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/
/** Apex trigger names are plain identifiers. */
export const TRIGGER_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/
/** 15- or 18-character Salesforce Id. */
export const SF_ID_RE = /^[A-Za-z0-9]{15}([A-Za-z0-9]{3})?$/

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

class Collector {
  readonly errors: ValidationError[] = []
  add(path: string, message: string): void {
    this.errors.push({ path, message })
  }
  /** Returns the array when `v` is one; records an error and returns [] otherwise. */
  array(v: unknown, path: string, required = true): unknown[] {
    if (Array.isArray(v)) return v
    if (v === undefined && !required) return []
    this.add(path, v === undefined ? 'is required' : 'must be a list')
    return []
  }
  record(v: unknown, path: string, required = true): Record<string, unknown> | null {
    if (isRecord(v)) return v
    if (v === undefined && !required) return null
    this.add(path, v === undefined ? 'is required' : 'must be an object')
    return null
  }
  string(v: unknown, path: string, opts: { required?: boolean; nonEmpty?: boolean } = {}): string | null {
    const required = opts.required ?? true
    if (typeof v === 'string') {
      if (opts.nonEmpty !== false && v.trim() === '') {
        this.add(path, 'cannot be blank')
        return null
      }
      return v
    }
    if (v === undefined && !required) return null
    this.add(path, v === undefined ? 'is required' : 'must be text')
    return null
  }
  apiName(v: unknown, path: string, re: RegExp = API_NAME_RE): string | null {
    const s = this.string(v, path)
    if (s === null) return null
    if (!re.test(s)) {
      this.add(path, `"${s}" is not a valid API name`)
      return null
    }
    return s
  }
  boolean(v: unknown, path: string, required = true): boolean | null {
    if (typeof v === 'boolean') return v
    if (v === undefined && !required) return null
    this.add(path, v === undefined ? 'is required' : 'must be true or false')
    return null
  }
}

function checkSchemaVersion(c: Collector, raw: Record<string, unknown>): void {
  if (raw.schemaVersion !== TEMPLATE_SCHEMA_VERSION) {
    c.add(
      'schemaVersion',
      `must be ${TEMPLATE_SCHEMA_VERSION} (this app understands up to schemaVersion ${TEMPLATE_SCHEMA_VERSION})`
    )
  }
}

function checkBuiltFrom(c: Collector, raw: Record<string, unknown>): void {
  if (raw.builtFrom === undefined) return
  const b = c.record(raw.builtFrom, 'builtFrom')
  if (!b) return
  c.string(b.orgId, 'builtFrom.orgId')
  c.string(b.label, 'builtFrom.label')
}

// ───────────────────────────── seed ─────────────────────────────

export function validateSeedTemplate(input: unknown): ValidationResult {
  const c = new Collector()
  const raw = c.record(input, '')
  if (!raw) return { ok: false, errors: c.errors }
  checkSchemaVersion(c, raw)
  checkBuiltFrom(c, raw)

  const source = c.record(raw.source, 'source')
  if (source) {
    if (source.expectedOrgId !== null && source.expectedOrgId !== undefined) {
      const id = c.string(source.expectedOrgId, 'source.expectedOrgId')
      if (id !== null && !SF_ID_RE.test(id)) c.add('source.expectedOrgId', 'must be a 15- or 18-character org Id')
    }
  }
  const runDefaults = c.record(raw.runDefaults, 'runDefaults')
  if (runDefaults) c.boolean(runDefaults.disableTargetAutomation, 'runDefaults.disableTargetAutomation')

  const keepIds = new Set<string>()
  c.array(raw.keepIdTargets, 'keepIdTargets').forEach((v, i) => {
    const s = c.apiName(v, `keepIdTargets[${i}]`)
    if (s) keepIds.add(s)
  })
  c.array(raw.copiedObjectsMustMatchSource, 'copiedObjectsMustMatchSource').forEach((v, i) =>
    c.apiName(v, `copiedObjectsMustMatchSource[${i}]`)
  )
  if (raw.copiedMatchTolerance !== undefined) {
    const t = c.record(raw.copiedMatchTolerance, 'copiedMatchTolerance')
    if (t) {
      if (typeof t.absolute !== 'number' || t.absolute < 0 || !Number.isInteger(t.absolute))
        c.add('copiedMatchTolerance.absolute', 'must be a whole number ≥ 0')
      if (typeof t.fraction !== 'number' || t.fraction < 0 || t.fraction > 1)
        c.add('copiedMatchTolerance.fraction', 'must be a number between 0 and 1')
    }
  }

  // Tiers first: later rules refer back to the tier order.
  const tierIndex = new Map<string, number>()
  const tiers = c.array(raw.tiers, 'tiers')
  if (tiers.length === 0) c.add('tiers', 'add at least one object')
  tiers.forEach((v, i) => {
    const path = `tiers[${i}]`
    const t = c.record(v, path)
    if (!t) return
    const object = c.apiName(t.object, `${path}.object`)
    if (object) {
      if (tierIndex.has(object)) c.add(`${path}.object`, `${object} appears more than once`)
      else tierIndex.set(object, i)
    }
    if (t.group !== undefined) c.string(t.group, `${path}.group`)
    if (t.where !== undefined) {
      const w = c.string(t.where, `${path}.where`, { nonEmpty: false })
      if (w !== null && /^\s*WHERE\b/i.test(w)) c.add(`${path}.where`, 'leave out the WHERE keyword — just the condition')
    }
    if (t.batchSize !== undefined) {
      const b = t.batchSize
      if (typeof b !== 'number' || !Number.isInteger(b) || b < BATCH_SIZE_MIN || b > BATCH_SIZE_MAX)
        c.add(`${path}.batchSize`, `must be a whole number from ${BATCH_SIZE_MIN} to ${BATCH_SIZE_MAX}`)
    }
    if (t.handler !== undefined) {
      if (!(SEED_HANDLERS as readonly unknown[]).includes(t.handler))
        c.add(`${path}.handler`, `unknown handler "${String(t.handler)}"`)
      const hc = c.record(t.handlerConfig, `${path}.handlerConfig`)
      if (hc) {
        c.apiName(hc.fileIdField, `${path}.handlerConfig.fileIdField`)
        c.apiName(hc.parentField, `${path}.handlerConfig.parentField`)
      }
    } else if (t.handlerConfig !== undefined) {
      c.add(`${path}.handlerConfig`, 'only applies with a handler')
    }
    if (t.pruneUnloadedUnder !== undefined) {
      const p = c.record(t.pruneUnloadedUnder, `${path}.pruneUnloadedUnder`)
      if (p) {
        c.apiName(p.field, `${path}.pruneUnloadedUnder.field`)
        c.apiName(p.parent, `${path}.pruneUnloadedUnder.parent`)
      }
    }
    if (t.parentScope !== undefined) {
      const ps = c.record(t.parentScope, `${path}.parentScope`)
      if (ps) {
        const anyOf = c.array(ps.anyOf, `${path}.parentScope.anyOf`)
        if (anyOf.length === 0) c.add(`${path}.parentScope.anyOf`, 'needs at least one lookup')
        anyOf.forEach((e, j) => {
          const r = c.record(e, `${path}.parentScope.anyOf[${j}]`)
          if (!r) return
          c.apiName(r.field, `${path}.parentScope.anyOf[${j}].field`)
          c.apiName(r.object, `${path}.parentScope.anyOf[${j}].object`)
        })
      }
    }
  })

  // Cross-tier rules: pruned parents and scope parents must be EARLIER tiers.
  tiers.forEach((v, i) => {
    if (!isRecord(v) || typeof v.object !== 'string') return
    const path = `tiers[${i}]`
    const prune = isRecord(v.pruneUnloadedUnder) ? v.pruneUnloadedUnder : null
    if (prune && typeof prune.parent === 'string') {
      const pi = tierIndex.get(prune.parent)
      if (pi === undefined) c.add(`${path}.pruneUnloadedUnder.parent`, `${prune.parent} is not a tier`)
      else if (pi >= i) c.add(`${path}.pruneUnloadedUnder.parent`, `${prune.parent} must come before ${v.object}`)
    }
    const ps = isRecord(v.parentScope) ? v.parentScope : null
    if (ps && Array.isArray(ps.anyOf)) {
      ps.anyOf.forEach((e, j) => {
        if (!isRecord(e) || typeof e.object !== 'string') return
        const pi = tierIndex.get(e.object)
        if (pi === undefined) c.add(`${path}.parentScope.anyOf[${j}].object`, `${e.object} is not a tier`)
        else if (pi >= i) c.add(`${path}.parentScope.anyOf[${j}].object`, `${e.object} must come before ${v.object}`)
      })
    }
  })

  c.array(raw.relinkCopiedObjects, 'relinkCopiedObjects').forEach((v, i) => {
    const r = c.record(v, `relinkCopiedObjects[${i}]`)
    if (!r) return
    const object = c.apiName(r.object, `relinkCopiedObjects[${i}].object`)
    if (object && !keepIds.has(object))
      c.add(`relinkCopiedObjects[${i}].object`, `${object} must also be a keep-Id object`)
    c.array(r.optionalFields, `relinkCopiedObjects[${i}].optionalFields`).forEach((f, j) =>
      c.apiName(f, `relinkCopiedObjects[${i}].optionalFields[${j}]`)
    )
  })

  const deferred = c.record(raw.deferredFields, 'deferredFields')
  if (deferred) {
    for (const [obj, fields] of Object.entries(deferred)) {
      if (!API_NAME_RE.test(obj)) c.add(`deferredFields.${obj}`, `"${obj}" is not a valid API name`)
      else if (!tierIndex.has(obj)) c.add(`deferredFields.${obj}`, `${obj} is not a tier`)
      c.array(fields, `deferredFields.${obj}`).forEach((f, j) => c.apiName(f, `deferredFields.${obj}[${j}]`))
    }
  }
  const placeholders = c.record(raw.deferredPlaceholders, 'deferredPlaceholders')
  if (placeholders) {
    for (const [field, value] of Object.entries(placeholders)) {
      if (!API_NAME_RE.test(field)) c.add(`deferredPlaceholders.${field}`, `"${field}" is not a valid API name`)
      if (!['string', 'number', 'boolean'].includes(typeof value))
        c.add(`deferredPlaceholders.${field}`, 'must be text, a number or true/false')
    }
  }

  c.array(raw.subsets, 'subsets').forEach((v, i) => {
    const s = c.record(v, `subsets[${i}]`)
    if (!s) return
    const object = c.apiName(s.object, `subsets[${i}].object`)
    if (object && !tierIndex.has(object)) c.add(`subsets[${i}].object`, `${object} is not a tier`)
    const ids = c.array(s.ids, `subsets[${i}].ids`)
    if (ids.length === 0) c.add(`subsets[${i}].ids`, 'needs at least one record Id')
    ids.forEach((id, j) => {
      if (typeof id !== 'string' || !SF_ID_RE.test(id)) c.add(`subsets[${i}].ids[${j}]`, 'must be a 15- or 18-character record Id')
    })
  })

  c.array(raw.expectedFailures, 'expectedFailures').forEach((v, i) => {
    const e = c.record(v, `expectedFailures[${i}]`)
    if (!e) return
    if (e.object !== null && e.object !== undefined) c.apiName(e.object, `expectedFailures[${i}].object`)
    c.string(e.contains, `expectedFailures[${i}].contains`)
    c.string(e.why, `expectedFailures[${i}].why`)
  })

  const verify = c.record(raw.verify, 'verify')
  if (verify) {
    c.boolean(verify.counts, 'verify.counts')
    c.boolean(verify.danglingLookups, 'verify.danglingLookups')
    c.boolean(verify.secondPassParity, 'verify.secondPassParity')
  }

  return { ok: c.errors.length === 0, errors: c.errors }
}

// ───────────────────────────── post-refresh ─────────────────────────────

export function validatePostRefreshTemplate(input: unknown): ValidationResult {
  const c = new Collector()
  const raw = c.record(input, '')
  if (!raw) return { ok: false, errors: c.errors }
  checkSchemaVersion(c, raw)
  checkBuiltFrom(c, raw)

  const automation = c.record(raw.automation, 'automation')
  if (automation) {
    const flowNames = new Set<string>()
    c.array(automation.flows, 'automation.flows').forEach((v, i) => {
      const f = c.record(v, `automation.flows[${i}]`)
      if (!f) return
      const name = c.apiName(f.apiName, `automation.flows[${i}].apiName`, FLOW_API_NAME_RE)
      if (name) {
        if (flowNames.has(name)) c.add(`automation.flows[${i}].apiName`, `${name} is listed twice`)
        flowNames.add(name)
      }
      if (!(FLOW_ACTIONS as readonly unknown[]).includes(f.action))
        c.add(`automation.flows[${i}].action`, `must be one of ${FLOW_ACTIONS.join(', ')}`)
    })
    const triggerNames = new Set<string>()
    c.array(automation.triggers, 'automation.triggers').forEach((v, i) => {
      const t = c.record(v, `automation.triggers[${i}]`)
      if (!t) return
      const name = c.apiName(t.name, `automation.triggers[${i}].name`, TRIGGER_NAME_RE)
      if (name) {
        if (triggerNames.has(name)) c.add(`automation.triggers[${i}].name`, `${name} is listed twice`)
        triggerNames.add(name)
      }
      if (!(TRIGGER_ACTIONS as readonly unknown[]).includes(t.action))
        c.add(`automation.triggers[${i}].action`, `must be one of ${TRIGGER_ACTIONS.join(', ')}`)
    })
    c.array(automation.settingPatches, 'automation.settingPatches').forEach((v, i) => {
      const path = `automation.settingPatches[${i}]`
      const p = c.record(v, path)
      if (!p) return
      c.string(p.label, `${path}.label`)
      c.apiName(p.object, `${path}.object`)
      c.apiName(p.field, `${path}.field`)
      if (p.where !== undefined) {
        const w = c.string(p.where, `${path}.where`, { nonEmpty: false })
        if (w !== null && /^\s*WHERE\b/i.test(w)) c.add(`${path}.where`, 'leave out the WHERE keyword — just the condition')
      }
      const tr = c.record(p.transform, `${path}.transform`)
      if (tr) {
        if (tr.kind === 'prefix') {
          c.string(tr.value, `${path}.transform.value`)
        } else if (tr.kind === 'set') {
          if (tr.value !== null && !['string', 'number', 'boolean'].includes(typeof tr.value))
            c.add(`${path}.transform.value`, 'must be text, a number, true/false or null')
        } else {
          c.add(`${path}.transform.kind`, 'must be prefix or set')
        }
      }
      if (p.optIn !== undefined) c.boolean(p.optIn, `${path}.optIn`)
    })
  }

  const seedNames = new Set<string>()
  c.array(raw.seedTemplates, 'seedTemplates').forEach((v, i) => {
    const s = c.record(v, `seedTemplates[${i}]`)
    if (!s) return
    const name = c.string(s.name, `seedTemplates[${i}].name`)
    if (name) {
      if (seedNames.has(name)) c.add(`seedTemplates[${i}].name`, `"${name}" is listed twice`)
      seedNames.add(name)
    }
    if (s.groups !== undefined) {
      c.array(s.groups, `seedTemplates[${i}].groups`).forEach((g, j) => c.string(g, `seedTemplates[${i}].groups[${j}]`))
    }
  })

  const verify = c.record(raw.verify, 'verify')
  if (verify && verify.safetyCheck !== true) c.add('verify.safetyCheck', 'must be true')

  return { ok: c.errors.length === 0, errors: c.errors }
}

/** Dispatch by kind. Unknown kinds fail with one error. */
export function validateTemplate(kind: string, input: unknown): ValidationResult {
  if (kind === 'seed') return validateSeedTemplate(input)
  if (kind === 'postRefresh') return validatePostRefreshTemplate(input)
  return { ok: false, errors: [{ path: 'kind', message: `"${kind}" is not a runnable template kind` }] }
}

/** Narrowing helpers for callers that already validated. */
export function asSeedTemplate(payload: unknown): SeedTemplate {
  return payload as SeedTemplate
}
export function asPostRefreshTemplate(payload: unknown): PostRefreshTemplate {
  return payload as PostRefreshTemplate
}

/** Tier group with the default applied. */
export function tierGroup(t: { group?: string }): string {
  return t.group ?? DEFAULT_TIER_GROUP
}
