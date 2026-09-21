/**
 * IPC surface — thin adapters from renderer calls to the service layer.
 * All heavy lifting lives in services/ and engine/ so it stays testable
 * outside Electron.
 */
import { app, ipcMain, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/types'
import type { OrgConnection, OrgRole, OAuthBeginInput, TemplateKind } from '../shared/types'
import type { WizardConfig, WizardStep } from '../shared/wizard'
import { listCliOrgs, getCliToken } from './services/sfcli'
import { connect, verifyIdentity, type GuardedOrg } from './services/salesforce'
import { createTokenProvider } from './services/tokenProvider'
import { authorize, revokeToken } from './services/oauthFlow'
import { describeGlobal, describeObject } from './services/describe'
import type { Store } from './services/store'
import type { TokenVault } from './services/tokenVault'
import type { JobContext, JobManager } from './jobs'
import { JobCancelledError } from './jobs'
import { wrapHandler } from './ipcError'
import { RdsHandlerError } from './errors'
import { computeIntersection } from './intersection'
import { buildCountQuery } from './engine/filterQuery'
import {
  buildPrefixIndex,
  extractLiteralIds,
  idsPlausibleFor,
  prefixMismatchHint,
  wrongOrgHint
} from './engine/filterDiagnosis'
import { suggestMappings } from './services/mappingSuggest'
import { assessObject, rollup, type ObjectReadiness } from './engine/readiness'
import { isKnownJunction } from './engine/junctionDetector'
import { createExtIdField } from './services/extIdField'
import { provisionExtIdFields, RDS_PERMISSION_SET } from './services/extIdProvision'
import { makeAnalysisIo } from './services/analysisIo'
import { analyzeDeployment, type AnalysisInput } from './engine/analysis'
import { slotRefillReorder } from './engine/planReorder'
import {
  discoverAutomation,
  discoverySummaryLines,
  makeAutomationIo,
  queryWorkflowRules
} from './services/automationDiscovery'
import { createHash } from 'node:crypto'
import { effectiveDisable, attestationBlocked, canEditPlan, isDeployBusy } from '../shared/wizard'
import { freezePlan } from './engine/deploy/planFreeze'
import {
  bridgeCancel,
  closeOutAttempt,
  runFailureMessage,
  stalledMessage
} from './services/deployAttempt'
import type { RunCounters, RunOutcome } from './engine/deploy/types'
import { TERMINAL_RUN_PHASES } from './engine/deploy/types'
import { runUuidFor } from './services/deployStore'
import { buildDeployRunState } from './services/deployRunState'
import { makeDeployIo, describeDeployFields } from './services/deployIo'
import { makePassExecutors } from './engine/deploy/passes'
import { runDeployment } from './engine/deploy/orchestrator'
import { makeAutomationHooks } from './engine/automation/hooks'
import {
  makeAutomationToggleIo,
  makeTriggerToggleIo,
  makeCpqGuardIo
} from './services/automationToggleIo'
import { makeMetadataToggleIo } from './services/metadataToggleIo'
import { targetHasExtIdOrgWide } from './services/targetSchemaProbe'
import { invalidateTargetKeysCache, probeKeyedRows, probeTargetKeys } from './services/targetKeys'
import { outOfScopeRefs, requiredReferenceWarnings, type RefFieldLike } from '../shared/scopeAdvisor'
import type { FieldInfo } from '../shared/types'
import { targetLockConflict, type TargetLockCandidate } from './services/runLock'
import { preRunAudit, postRunAudit } from './services/runAudit'
import { startMemorySampler } from './services/memorySampler'

// The app-ready TokenVault (A3), retained here so A5's TokenProvider can read it.
let injectedTokenVault: TokenVault | undefined
/** The OAuth token vault constructed at app-ready — consumed by A5's TokenProvider. */
export function tokenVault(): TokenVault | undefined {
  return injectedTokenVault
}

/**
 * Extract the org id from an OAuth identity URL
 * (`https://login.salesforce.com/id/<orgId>/<userId>`). Returns '' when absent
 * or unparseable — a live identity() re-derives the authoritative value.
 */
export function parseOrgIdFromIdUrl(idUrl: string | null): string {
  if (!idUrl) return ''
  const m = idUrl.match(/\/id\/([^/]+)\//)
  return m?.[1] ?? ''
}

/**
 * Non-blank sample probe for populated-only (the rds:fields.populated logic,
 * reused by the 5B.9 freeze loop). THROWS on a query failure — a deploy that
 * promised populated-only must never silently widen to every field.
 */
async function probePopulatedFields(
  org: GuardedOrg,
  objectName: string,
  fieldNames: string[]
): Promise<string[]> {
  const fields = Array.from(new Set(fieldNames.filter((f) => !!f)))
  if (fields.length === 0) return []
  const CHUNK = 100
  const SAMPLE = 20
  const populated = new Set<string>()
  try {
    for (let i = 0; i < fields.length; i += CHUNK) {
      const chunk = fields.slice(i, i + CHUNK)
      const res = await org.conn.query(
        `SELECT ${chunk.join(', ')} FROM ${objectName} LIMIT ${SAMPLE}`
      )
      for (const rec of (res.records ?? []) as Record<string, unknown>[]) {
        for (const f of chunk) {
          const v = rec[f]
          if (v !== null && v !== undefined && v !== '') populated.add(f)
        }
      }
    }
  } catch (err) {
    throw new RdsHandlerError(
      'INVALID_STATE',
      `Populated-fields probe failed for ${objectName} — retry, or turn off "populated only": ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return [...populated]
}

export function registerIpc(store: Store, jobs: JobManager, vault: TokenVault): void {
  injectedTokenVault = vault

  // One TokenProvider for the whole IPC surface: it dispatches cli↔oauth and
  // owns the single-flight refresh map (keyed by connection id), so concurrent
  // handlers touching the same org share one refresh. The public PKCE client id
  // is inlined by electron-vite from .env.local (A6); oauth handlers fail-loud
  // via the provider if it's missing.
  const oauthClientId = import.meta.env.MAIN_VITE_OAUTH_CLIENT_ID
  const tokens = createTokenProvider({ getCliToken, vault, oauthClientId })

  /**
   * Resolve a stored connection id → a live GuardedOrg. Throws NOT_FOUND when the
   * id is unknown (no more silent alias fallback). `roleOverride` lets analysis
   * pin source/target regardless of the stored role.
   */
  const connectById = (connectionId: string, roleOverride?: OrgRole): Promise<GuardedOrg> => {
    const row = store.getConnection(connectionId)
    if (!row) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${connectionId}`)
    return connect(roleOverride ? { ...row, role: roleOverride } : row, tokens)
  }

  // S46 D3 — cancel bridge: jobId → deploy_runs.id for RUNNING deploy jobs.
  // Populated right after createRun, pruned when the job ends. `rds:job.cancel`
  // flips the job's cooperative token AND the run's persisted cancel flag so
  // the orchestrator's batch-boundary checks (firstPass/retry/secondPass read
  // isCancelRequested) actually fire — before this the flag had no writer.
  const deployRunByJob = new Map<string, number>()

  ipcMain.handle(
    IPC.listOrgs,
    wrapHandler(() => store.listConnections())
  )

  ipcMain.handle(
    IPC.refreshOrgs,
    wrapHandler(async () => {
      const cliOrgs = await listCliOrgs()
      store.upsertConnections(cliOrgs)
      return store.listConnections()
    })
  )

  ipcMain.handle(
    IPC.setOrgRole,
    wrapHandler((_e, connectionId: string, role: OrgRole) => {
      store.setRole(connectionId, role)
      return store.listConnections()
    })
  )

  // verifyOrg returns a domain result ({ ok, ... }) rather than throwing, so a
  // failed identity check renders inline instead of as a global error.
  ipcMain.handle(
    IPC.verifyOrg,
    wrapHandler(async (_e, connectionId: string) => {
      try {
        const org = await connectById(connectionId)
        const identity = await verifyIdentity(org)
        store.markVerified(connectionId, identity.orgId)
        return { ok: true, ...identity }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    })
  )

  // ── OAuth sign-in (A7) ─────────────────────────────────────────────────
  // oauthBegin runs the A4 interactive PKCE flow (system browser + loopback),
  // persists the encrypted tokens, then does a live identity() so the stored
  // org id is authoritative (closes the A5 prod-pin gap for OAuth rows) before
  // returning the refreshed connection list.
  ipcMain.handle(
    IPC.oauthBegin,
    wrapHandler(async (_e, input: OAuthBeginInput) => {
      if (!oauthClientId) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'OAuth is not configured — MAIN_VITE_OAUTH_CLIENT_ID is missing from the build.'
        )
      }
      const loginUrl = input.loginUrl.trim().replace(/\/+$/, '')
      const tokenSet = await authorize(
        { loginUrl, clientId: oauthClientId },
        { openExternal: (url) => shell.openExternal(url), fetch, now: Date.now }
      )

      const orgIdFromIdUrl = parseOrgIdFromIdUrl(tokenSet.idUrl)
      const isSandbox = loginUrl.includes('test.salesforce.com')
        ? true
        : loginUrl.includes('login.salesforce.com')
          ? false
          : null

      // Resolve the target connection id: reuse for re-auth, else a fresh UUID.
      let connectionId: string
      if (input.reauthConnectionId) {
        const existing = store.getConnection(input.reauthConnectionId)
        if (!existing || existing.authKind !== 'oauth') {
          throw new RdsHandlerError('NOT_FOUND', 'No OAuth connection to re-authenticate.')
        }
        connectionId = existing.id
        vault.put(connectionId, {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          instanceUrl: tokenSet.instanceUrl
        })
        store.markConnectionActive(connectionId, {
          instanceUrl: tokenSet.instanceUrl,
          orgId: orgIdFromIdUrl || undefined
        })
      } else {
        connectionId = randomUUID()
        // Create the connection row FIRST: oauth_tokens.connection_id has a FK to
        // connections(id) (foreign_keys is ON at runtime), so a token-first insert
        // would fail SQLITE_CONSTRAINT_FOREIGNKEY. Row-first also means a create
        // failure never leaves an orphaned vault entry.
        store.createOAuthConnection({
          id: connectionId,
          label: input.label?.trim() || new URL(loginUrl).host,
          username: '(verifying…)',
          orgId: orgIdFromIdUrl,
          instanceUrl: tokenSet.instanceUrl,
          loginUrl,
          oauthClientId,
          isSandbox
        })
        vault.put(connectionId, {
          accessToken: tokenSet.accessToken,
          refreshToken: tokenSet.refreshToken,
          instanceUrl: tokenSet.instanceUrl
        })
      }

      // Live identity → authoritative org id + username. Best-effort: a network
      // hiccup here must not discard the tokens we just stored.
      try {
        const org = await connectById(connectionId)
        const identity = await verifyIdentity(org)
        store.markConnectionActive(connectionId, {
          orgId: identity.orgId,
          username: identity.username
        })
        store.markVerified(connectionId, identity.orgId)
      } catch {
        store.setConnectionStatus(connectionId, 'Error')
      }
      return store.listConnections()
    })
  )

  // Remove a connection row. OAuth: best-effort remote revoke, then wipe the
  // encrypted tokens. CLI (S52 F3 — stale / superseded rows): just the row; the
  // sf auth is the CLI's business. Refuses if a deployment still references it.
  const removeConnection = async (connectionId: string): Promise<OrgConnection[]> => {
    const row = store.getConnection(connectionId)
    if (!row) throw new RdsHandlerError('NOT_FOUND', `Unknown connection: ${connectionId}`)
    // Refuse BEFORE any destructive step. deleteConnection also guards this, but
    // running the guard first means a referenced connection is left fully intact
    // (tokens not revoked/wiped) rather than stranded — the whole point of "refuse".
    if (store.isConnectionReferenced(connectionId)) {
      throw new RdsHandlerError(
        'INVALID_STATE',
        `'${row.label}' is still used by a deployment — delete that deployment first, then remove the connection.`
      )
    }
    if (row.authKind === 'oauth') {
      // Revoke first (needs the plaintext token) — skip silently if the vault
      // can't decrypt (broken keychain); the wipe below still protects the disk.
      try {
        const ts = vault.get(connectionId)
        const token = ts?.refreshToken ?? ts?.accessToken
        if (token && row.loginUrl) {
          await revokeToken({ loginUrl: row.loginUrl, token }, { fetch })
        }
      } catch {
        /* revoke is best-effort */
      }
      vault.wipe(connectionId)
    }
    store.deleteConnection(connectionId)
    return store.listConnections()
  }
  ipcMain.handle(
    IPC.oauthDisconnect,
    wrapHandler((_e, connectionId: string) => removeConnection(connectionId))
  )
  ipcMain.handle(
    IPC.orgRemove,
    wrapHandler((_e, connectionId: string) => removeConnection(connectionId))
  )

  ipcMain.handle(
    IPC.describeGlobal,
    wrapHandler(async (_e, connectionId: string) => {
      const org = await connectById(connectionId)
      return describeGlobal(org, store)
    })
  )

  ipcMain.handle(
    IPC.describeObject,
    wrapHandler(async (_e, connectionId: string, objectApiName: string) => {
      const org = await connectById(connectionId)
      return describeObject(org, store, objectApiName)
    })
  )

  // ── Readiness (5B.4) ──────────────────────────────────────────────────
  // Read-only: describe each in-scope object on the TARGET and report whether
  // the ExtId upsert-key field is present (junctions are exempt).
  ipcMain.handle(
    IPC.readinessCheck,
    wrapHandler(async (_e, deploymentId: number) => {
      const draft = store.loadDraft(deploymentId)
      if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      const objects = draft.config.selectedObjects
      if (objects.length === 0) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'Select at least one object before checking readiness.'
        )
      }
      const target = await connectById(draft.targetConnectionId)
      const results: ObjectReadiness[] = []
      for (const objectName of objects) {
        const isJunction = isKnownJunction(objectName)
        try {
          // force=true: readiness must reflect the LIVE target schema, not a 24h
          // cache — otherwise a just-created (or externally-fixed) field still
          // reads as missing. A per-object catch keeps one bad object from
          // collapsing the whole report.
          const fields = await describeObject(target, store, objectName, /* force */ true)
          results.push(assessObject({ objectName, fields, isJunction }))
        } catch (err) {
          results.push({
            objectName,
            isJunction,
            hasExtIdField: false,
            extIdIsExternalId: false,
            needsExtIdField: false, // don't offer a fix for an object we can't read
            describeError: err instanceof Error ? err.message : String(err)
          })
        }
      }
      return rollup(results)
    })
  )

  // Write: create the ExtId field on one target object (force 'target' so the
  // D1 write gate allows it — prod stays refused). Returns fresh per-object state.
  ipcMain.handle(
    IPC.readinessCreateExtId,
    wrapHandler(async (_e, deploymentId: number, objectName: string) => {
      const draft = store.loadDraft(deploymentId)
      if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      if (!draft.config.selectedObjects.includes(objectName)) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          `${objectName} is not in this deployment's scope.`
        )
      }
      const target = await connectById(draft.targetConnectionId, 'target')
      return createExtIdField(target, store, objectName)
    })
  )

  // S46: one action for the whole scope — create every missing ExtId field AND
  // grant the running user FLS on them. A field created through the Metadata API
  // is invisible to describe without FLS, so create-then-poll (the per-object
  // handler above) could never converge; see services/extIdProvision.ts.
  ipcMain.handle(
    IPC.readinessProvisionExtIds,
    wrapHandler(async (_e, deploymentId: number) => {
      const draft = store.loadDraft(deploymentId)
      if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      const objectNames = draft.config.selectedObjects
      if (objectNames.length === 0) {
        throw new RdsHandlerError('INVALID_STATE', 'No objects are in scope yet.')
      }
      const target = await connectById(draft.targetConnectionId, 'target')
      const result = await provisionExtIdFields(target, store, objectNames)
      // S57 (B1): the org-wide "has the ExtId field" set just changed.
      invalidateTargetKeysCache(target.orgId)
      return { ...result, permissionSetName: RDS_PERMISSION_SET }
    })
  )

  // S57 (B1) — READ-ONLY: what the target knows about objects OUTSIDE the scope.
  // `hasField` from the org-wide Tooling oracle (cached per org), `keyedRows` from
  // one `LIMIT 1` probe per object. Drives the Mappings/Fields/Scope steps' view
  // of references to parents that are not in the plan (see mappingPolicy).
  ipcMain.handle(
    IPC.targetKeyedObjects,
    wrapHandler(async (_e, input: { targetConnectionId: string; objectNames: string[] }) => {
      const names = Array.from(
        new Set((input.objectNames ?? []).filter((o) => typeof o === 'string' && o !== ''))
      )
      if (names.length === 0) return { hasField: [], keyedRows: [] }
      const target = await connectById(input.targetConnectionId)
      const keys = await probeTargetKeys(target, names)
      return { hasField: [...keys.hasField].sort(), keyedRows: [...keys.keyedRows].sort() }
    })
  )

  // ── Jobs ──────────────────────────────────────────────────────────────
  ipcMain.handle(
    IPC.jobList,
    wrapHandler(() => jobs.list())
  )
  ipcMain.handle(
    IPC.jobCancel,
    // D3: a running DEPLOY job also gets its run's persisted cancel flag set
    // (services/deployAttempt.bridgeCancel — tested in the sqlite lane).
    wrapHandler((_e, jobId: string) => bridgeCancel(store, jobs, deployRunByJob, jobId))
  )
  ipcMain.handle(
    IPC.jobDemo,
    wrapHandler(() => {
      const jobId = jobs.start('demo', 'Demo job', async (ctx) => {
        const steps = 10
        for (let i = 1; i <= steps; i++) {
          ctx.cancel.throwIfCancelled()
          await new Promise((r) => setTimeout(r, 300))
          ctx.progress(i, steps, `Step ${i} of ${steps}`)
        }
        return { steps }
      })
      return { jobId }
    })
  )

  // ── Drafts + plan (5A.5 / 2.2) ────────────────────────────────────────
  // S52 F1: the pick IS the role assignment for never-assigned orgs (atomic
  // with the insert; rows that already carry a role are untouched).
  ipcMain.handle(
    IPC.draftCreate,
    wrapHandler(
      (_e, input: { name: string; sourceConnectionId: string; targetConnectionId: string }) =>
        store.createDeploymentAssigningRoles(input)
    )
  )
  // S52 F2: the same write for drafts created before F1 (or after a demotion).
  ipcMain.handle(
    IPC.deploymentAssignRoles,
    wrapHandler((_e, deploymentId: number) => store.assignDeploymentRoles(deploymentId))
  )
  ipcMain.handle(
    IPC.draftSave,
    wrapHandler((_e, input: { deploymentId: number; step: WizardStep; config: WizardConfig }) => {
      // D1: a live run owns the deployment — the wizard is read-only until it
      // ends (the shell refuses to open it; this is the main-side guard).
      const header = store.getDeploymentHeader(input.deploymentId)
      if (header && isDeployBusy(header.status)) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          `Deployment is ${header.status} — the wizard is read-only until the run finishes.`
        )
      }
      store.saveDraft(input.deploymentId, input.step, input.config)
    })
  )
  ipcMain.handle(
    IPC.draftLoad,
    wrapHandler((_e, deploymentId: number) => store.loadDraft(deploymentId))
  )
  ipcMain.handle(
    IPC.draftList,
    wrapHandler(() => store.listDrafts())
  )
  ipcMain.handle(
    IPC.draftDelete,
    wrapHandler((_e, deploymentId: number) => store.deleteDeployment(deploymentId))
  )
  ipcMain.handle(
    IPC.planGet,
    wrapHandler((_e, deploymentId: number) => store.getPlan(deploymentId))
  )

  // rds:plan.reorder — apply a user reorder with the slot-refill invariant (5B.8).
  // Local store only. Junction names are stripped from the desired order before
  // the refill (defense in depth — the UI renders them non-draggable), so a
  // junction can never move off its analysis slot.
  ipcMain.handle(
    IPC.planReorder,
    wrapHandler((_e, input: { deploymentId: number; objectOrder: string[] }) => {
      const draft = store.loadDraft(input.deploymentId)
      if (!draft)
        throw new RdsHandlerError('NOT_FOUND', `Deployment ${input.deploymentId} not found`)
      const plan = store.getPlan(input.deploymentId)
      if (!plan) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'No analyzed plan to reorder — run analysis first.'
        )
      }
      // D1: reorder is allowed wherever Deploy is — Planned, or a finished
      // (Completed / Failed / Cancelled) deployment being fixed up to re-run.
      // Busy statuses belong to the live run; Stalled needs a fresh analysis.
      if (!canEditPlan(draft.status)) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          `A ${draft.status} deployment's plan cannot be reordered.`
        )
      }
      // Analysis run-lock (mirror of rds:analyze): a running re-analysis will
      // DELETE + re-insert every deployment_objects row when it saves, silently
      // wiping this reorder — refuse instead of racing it.
      const analysisInFlight = jobs
        .list()
        .find(
          (j) =>
            j.kind === 'analysis' &&
            j.deploymentId === String(input.deploymentId) &&
            j.status === 'running'
        )
      if (analysisInFlight) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'Analysis is in progress — wait for it to finish before reordering the plan.'
        )
      }
      const junctions = new Set(plan.objects.filter((o) => o.isJunction).map((o) => o.objectName))
      const desired = (input.objectOrder ?? []).filter((n) => !junctions.has(n))
      const current = plan.objects.map((o) => o.objectName)
      store.reorderPlan(input.deploymentId, slotRefillReorder(current, desired))
      const fresh = store.getPlan(input.deploymentId)
      if (!fresh) throw new RdsHandlerError('UNKNOWN', 'Plan vanished during reorder')
      return fresh
    })
  )

  // rds:automation.discover — target-org automation scoped to the plan (5B.8).
  // READ-ONLY (query endpoints only; no assertWritable). Scope prefers the
  // analyzed plan's objects — junction-INCLUSIVE, a superset of the Apex
  // wizard's selectedObjects scope (over-discovery is the safe direction) —
  // and falls back to the current selection pre-analysis.
  ipcMain.handle(
    IPC.automationDiscover,
    wrapHandler(async (_e, deploymentId: number) => {
      const draft = store.loadDraft(deploymentId)
      if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      const plan = store.getPlan(deploymentId)
      const scope = plan ? plan.objects.map((o) => o.objectName) : draft.config.selectedObjects
      if (scope.length === 0) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'Select objects (or run analysis) before discovering automation.'
        )
      }
      const target = await connectById(draft.targetConnectionId)
      return discoverAutomation(makeAutomationIo(target), scope)
    })
  )

  // rds:template.* — reusable wizard templates (5B.5). Local store only, no org I/O.
  ipcMain.handle(
    IPC.templateList,
    wrapHandler((_e, kind: TemplateKind) => store.listTemplates(kind))
  )
  ipcMain.handle(
    IPC.templateSave,
    wrapHandler((_e, input: { kind: TemplateKind; name: string; payload: unknown }) =>
      store.saveTemplate(input.kind, input.name, input.payload)
    )
  )
  ipcMain.handle(
    IPC.templateRename,
    wrapHandler((_e, input: { id: number; name: string }) =>
      store.renameTemplate(input.id, input.name)
    )
  )
  ipcMain.handle(
    IPC.templateDelete,
    wrapHandler((_e, id: number) => store.deleteTemplate(id))
  )

  ipcMain.handle(
    IPC.objectsIntersection,
    wrapHandler(
      async (
        _e,
        input: { sourceConnectionId: string; targetConnectionId: string; force?: boolean }
      ) => {
        const source = await connectById(input.sourceConnectionId)
        const target = await connectById(input.targetConnectionId)
        const [sourceObjs, targetObjs] = await Promise.all([
          describeGlobal(source, store, input.force),
          describeGlobal(target, store, input.force)
        ])
        return computeIntersection(sourceObjs, targetObjs)
      }
    )
  )

  // rds:filter.validate — exact COUNT() on the SOURCE org (read-only). Returns a
  // domain result ({ ok, count } | { ok:false, error }) so an invalid clause shows
  // inline in the editor rather than as a global error toast. The ORDER BY strip is
  // surfaced (strippedClause) — never silent.
  async function diagnoseZeroMatch(
    source: GuardedOrg,
    input: { objectName: string; filterClause: string; targetConnectionId?: string }
  ): Promise<string | null> {
    const ids = extractLiteralIds(input.filterClause)
    if (ids.length === 0) return null
    // Key prefixes: fixed table + the source's global describe (cached 24 h; a
    // cache written before S54 has no keyPrefix — refresh it once).
    let objects = await describeGlobal(source, store)
    if (!objects.some((o) => o.keyPrefix !== undefined))
      objects = await describeGlobal(source, store, true)
    const index = buildPrefixIndex(objects)
    const mismatch = prefixMismatchHint(input.objectName, ids, index)
    if (mismatch) return mismatch
    if (!input.targetConnectionId) return null
    const plausible = idsPlausibleFor(input.objectName, ids, index)
    if (plausible.length === 0) return null
    const target = await connectById(input.targetConnectionId)
    const found = await target.conn.query(
      `SELECT Id FROM ${input.objectName} WHERE Id IN (${plausible.map((id) => `'${id}'`).join(', ')})`
    )
    if (found.totalSize === 0) return null
    const foundIds = ((found.records ?? []) as Array<{ Id?: string }>)
      .map((r) => r.Id ?? '')
      .filter((id) => id.length > 0)
    return wrongOrgHint(
      input.objectName,
      foundIds.length > 0 ? foundIds : plausible,
      source.alias,
      target.alias
    )
  }

  ipcMain.handle(
    IPC.filterValidate,
    wrapHandler(
      async (
        _e,
        input: {
          connectionId: string
          objectName: string
          filterClause: string
          targetConnectionId?: string
        }
      ) => {
        const q = buildCountQuery(input.objectName, input.filterClause)
        try {
          const org = await connectById(input.connectionId)
          const res = await org.conn.query(q.soql)
          // S54 F1 (L4): a valid clause that matches NOTHING is not success.
          // When it holds a literal record Id, say WHY it cannot match — a key
          // prefix of another object, or a record that lives on the target.
          // Best-effort and read-only: a diagnosis failure never hides the count.
          let hint: string | null = null
          if (res.totalSize === 0) {
            try {
              hint = await diagnoseZeroMatch(org, input)
            } catch {
              hint = null
            }
          }
          return {
            ok: true,
            count: res.totalSize,
            soql: q.soql,
            strippedClause: q.strippedClause,
            hint
          }
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            soql: q.soql,
            strippedClause: q.strippedClause
          }
        }
      }
    )
  )

  // rds:sample.get — one source sample record's field values (read-only, D1-safe).
  // Returns a domain result ({ ok, values } | { ok:false, error }) so a query/access
  // error shows inline in the mapping table's sample column (pain 3.17 — a typed
  // error, never a silent blank). Field names are the source∩target reference set
  // the renderer already computed from describe, so they are valid describe values.
  ipcMain.handle(
    IPC.sampleGet,
    wrapHandler(
      async (_e, input: { connectionId: string; objectName: string; fieldNames: string[] }) => {
        const fields = Array.from(new Set((input.fieldNames ?? []).filter((f) => !!f)))
        if (fields.length === 0) return { ok: true, values: {} }
        const soql = `SELECT Id, ${fields.join(', ')} FROM ${input.objectName} LIMIT 1`
        try {
          const org = await connectById(input.connectionId)
          const res = await org.conn.query(soql)
          const rec = (res.records?.[0] ?? {}) as Record<string, unknown>
          const values: Record<string, unknown> = {}
          for (const f of fields) values[f] = rec[f] ?? null
          return { ok: true, values }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    )
  )

  // rds:fields.populated — which of the given source fields are non-blank in a small
  // sample (5B.6 populated-only). Read-only (D1-safe); domain result (never throws).
  // Fields are queried in chunks to keep each GET URL under the query-string cap.
  ipcMain.handle(
    IPC.fieldsPopulated,
    wrapHandler(
      async (_e, input: { connectionId: string; objectName: string; fieldNames: string[] }) => {
        const fields = Array.from(new Set((input.fieldNames ?? []).filter((f) => !!f)))
        if (fields.length === 0) return { ok: true, populated: [] }
        const CHUNK = 100
        const SAMPLE = 20
        try {
          const org = await connectById(input.connectionId)
          const populated = new Set<string>()
          for (let i = 0; i < fields.length; i += CHUNK) {
            const chunk = fields.slice(i, i + CHUNK)
            const soql = `SELECT ${chunk.join(', ')} FROM ${input.objectName} LIMIT ${SAMPLE}`
            const res = await org.conn.query(soql)
            for (const rec of (res.records ?? []) as Record<string, unknown>[]) {
              for (const f of chunk) {
                const v = rec[f]
                if (v !== null && v !== undefined && v !== '') populated.add(f)
              }
            }
          }
          return { ok: true, populated: [...populated] }
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) }
        }
      }
    )
  )

  // rds:mappings.suggest — Id-overlap probes (5B.5). Samples up to 5 source Ids per
  // stable/catalog probe object and checks target existence to recommend directId vs
  // nameMatch. Read-only on BOTH orgs (D1-safe). A probe failure fails soft per the
  // service; only a connect failure surfaces (wrapHandler → typed error).
  ipcMain.handle(
    IPC.mappingsSuggest,
    wrapHandler(async (_e, input: { sourceConnectionId: string; targetConnectionId: string }) => {
      const source = await connectById(input.sourceConnectionId)
      const target = await connectById(input.targetConnectionId)
      const runOn = (org: typeof source) => async (soql: string) => {
        const r = await org.conn.query(soql)
        return { records: r.records as Array<{ Id?: string | null }>, totalSize: r.totalSize }
      }
      return suggestMappings(runOn(source), runOn(target))
    })
  )

  // rds:analyze — run the parity-proven analysis engine as a background job.
  // Returns { jobId } immediately; the plan is persisted (status → Planned) and
  // the renderer fetches it via rds:plan.get on the job's 'done' event. Reads
  // only (source scoping + a target dup-rule probe) — no writes, D1-safe.
  ipcMain.handle(
    IPC.analyze,
    wrapHandler((_e, deploymentId: number) => {
      // Run-lock: one analysis per deployment. A duplicate request (double-click,
      // re-mounted UI) adopts the in-flight job rather than racing a second
      // store.saveAnalysis for the same deployment.
      const inFlight = jobs
        .list()
        .find(
          (j) =>
            j.kind === 'analysis' &&
            j.deploymentId === String(deploymentId) &&
            j.status === 'running'
        )
      if (inFlight) return { jobId: inFlight.id }
      const jobId = jobs.start(
        'analysis',
        'Analyze deployment',
        async (ctx) => {
          const draft = store.loadDraft(deploymentId)
          if (!draft) {
            throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
          }
          const cfg = draft.config
          if (cfg.selectedObjects.length === 0) {
            throw new RdsHandlerError(
              'INVALID_STATE',
              'Select at least one object before analyzing.'
            )
          }

          ctx.phase('Connecting')
          ctx.progress(0, 3, 'Connecting to source + target')
          const source = await connectById(draft.sourceConnectionId, 'source')
          const target = await connectById(draft.targetConnectionId, 'target')
          ctx.cancel.throwIfCancelled()

          ctx.phase('Analyzing')
          ctx.progress(1, 3, 'Building the deploy plan')
          const io = makeAnalysisIo({
            source,
            target,
            store,
            log: (level, message) => ctx.log(message, level === 'Warning' ? 'warn' : 'info')
          })
          const input: AnalysisInput = {
            objects: cfg.selectedObjects.map((o) => ({
              objectName: o,
              userFilter: cfg.filters[o] ?? null
            }))
          }
          const result = await analyzeDeployment(input, io)
          ctx.cancel.throwIfCancelled()

          // S57 (FB-3): a REQUIRED reference whose parent is outside the plan and
          // not keyed on the target fails every row of that object — say so on the
          // Plan step, BEFORE Deploy, not after 228 API errors (run 24). Read-only,
          // fail-open: a describe/probe failure logs and changes nothing.
          try {
            const names = result.objects.filter((o) => !o.isJunction).map((o) => o.objectName)
            const src: Record<string, FieldInfo[]> = {}
            const tgt: Record<string, FieldInfo[]> = {}
            for (const n of names) {
              src[n] = await describeObject(source, store, n)
              tgt[n] = await describeObject(target, store, n)
            }
            const refs = outOfScopeRefs(cfg.selectedObjects, src, tgt)
            const keys = await probeTargetKeys(
              target,
              refs.map((r) => r.refTo)
            )
            for (const n of names) {
              const ws = requiredReferenceWarnings({
                objectName: n,
                sourceFields: src[n] ?? [],
                targetFields: tgt[n] ?? [],
                selectedObjects: cfg.selectedObjects,
                overrides: cfg.mappings[n],
                targetKeys: keys
              })
              for (const w of ws) {
                result.warnings.push(w)
                ctx.log(w, 'warn')
              }
            }
          } catch (e) {
            ctx.log(
              `Required-reference check skipped: ${e instanceof Error ? e.message : String(e)}`,
              'warn'
            )
          }

          ctx.phase('Saving')
          ctx.progress(2, 3, 'Persisting the plan')
          store.saveAnalysis(deploymentId, result)

          ctx.progress(3, 3, 'Done')
          return {
            totalObjects: result.totalObjects,
            totalRecords: result.totalRecords,
            autoInjectedJunctions: result.autoInjectedJunctions.length,
            warnings: result.warnings.length
          }
        },
        { deploymentId: String(deploymentId) }
      )
      return { jobId }
    })
  )

  // rds:deploy.start — 5B.9: freeze the plan and run the deployment as a
  // background job (disable → deploy → finalize → restore, orchestrator +
  // E4A hooks). Returns { jobId } immediately; refuses when the CPQ
  // attestation is required-but-false or the target connection's role is not
  // 'target' (a prod-pinned or source org can never be deployed into).
  ipcMain.handle(
    IPC.deployStart,
    wrapHandler(async (_e, deploymentId: number) => {
      // Run-lock: one deploy per deployment (same adopt-in-flight pattern as
      // rds:analyze) — a double-click must not race two runs at one target.
      const inFlight = jobs
        .list()
        .find(
          (j) =>
            j.kind === 'deploy' && j.deploymentId === String(deploymentId) && j.status === 'running'
        )
      if (inFlight) return { jobId: inFlight.id }

      const draft = store.loadDraft(deploymentId)
      if (!draft) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      const planned = store.getPlannedObjects(deploymentId)
      if (planned.length === 0) {
        throw new RdsHandlerError('INVALID_STATE', 'Run analysis before deploying.')
      }

      // D1 run-lock across app sessions: deploy_runs is the source of truth.
      // A NON-terminal run (incl. Stalled) means the target may still have
      // automation disabled — never deploy over it. (A busy STATUS with no
      // live run is a crash artifact; Store.reconcileOnStartup marks it Failed
      // at launch, so by the time a button can be pressed it is gone.)
      const runs = store.deploy.listRunsForDeployment(deploymentId)
      const liveRun = runs.find((r) => !TERMINAL_RUN_PHASES.has(r.phase))
      if (liveRun) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          liveRun.phase === 'Stalled'
            ? 'A previous run of this deployment stalled during teardown — its target-org automation ' +
                'may still be disabled. Restore it manually (steps on the deployment page), then create ' +
                'a NEW deployment for the next attempt; recovery/acknowledge arrives with the E2 slice.'
            : `A previous run of this deployment is still recorded as ${liveRun.phase} — its target-org ` +
                'automation may still be disabled. Restore it manually (steps on the deployment page) ' +
                'before deploying again.'
        )
      }
      // The other strand shape (PLAN RC-4b): a TERMINAL run whose per-item
      // restore did not fully confirm — restore never throws per item, so
      // this is how a stranded target normally looks. A new run cannot
      // re-discover items that are already disabled; refuse until they are
      // restored (the E2 slice adds acknowledge/recovery).
      const lastRun = runs.length > 0 ? runs[runs.length - 1]! : null
      if (lastRun && store.deploy.ledgerUnconfirmed(runUuidFor(lastRun.id)).length > 0) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'The previous run of this deployment ended with automation items NOT confirmed restored on ' +
            'the target. Restore them manually (steps on the deployment page), then create a NEW ' +
            'deployment for the next attempt; acknowledge/recovery arrives with the E2 slice.'
        )
      }

      // S53 (item 2) — the SAME three gates, per TARGET ORG. Every check above
      // is scoped to this deployment; two deployments aimed at one org passed
      // them all and could run at once, and a stranded run of ANOTHER
      // deployment (Stalled / restore unconfirmed) left the target's automation
      // disabled while this one deployed over it. Siblings = every other
      // deployment whose target connection resolves to the same org id
      // (superseded aliases included). Never adopt a sibling's job.
      const siblings = store.deploymentsSharingTarget(deploymentId)
      if (siblings.length > 0) {
        const runningDeploys = new Set(
          jobs
            .list()
            .filter((j) => j.kind === 'deploy' && j.status === 'running' && j.deploymentId != null)
            .map((j) => j.deploymentId as string)
        )
        const candidates: TargetLockCandidate[] = siblings.map((s) => {
          const sRuns = store.deploy.listRunsForDeployment(s.id)
          const sLive = sRuns.find((r) => !TERMINAL_RUN_PHASES.has(r.phase))
          const sLast = sRuns.length > 0 ? sRuns[sRuns.length - 1]! : null
          return {
            deploymentId: s.id,
            name: s.name,
            runningJob: runningDeploys.has(String(s.id)),
            liveRunPhase: sLive?.phase ?? null,
            unconfirmedRestore:
              sLast != null ? store.deploy.ledgerUnconfirmed(runUuidFor(sLast.id)).length : 0
          }
        })
        const conflict = targetLockConflict(candidates, draft.targetLabel)
        if (conflict != null) throw new RdsHandlerError('INVALID_STATE', conflict)
      }

      // Analysis run-lock (mirror of rds:plan.reorder): a completing analysis
      // rewrites every plan row — never freeze/deploy while one runs.
      const analysisInFlight = jobs
        .list()
        .find(
          (j) =>
            j.kind === 'analysis' &&
            j.deploymentId === String(deploymentId) &&
            j.status === 'running'
        )
      if (analysisInFlight) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'Analysis is in progress — wait for it to finish before deploying.'
        )
      }

      // Scope-drift gate (the StepPlan scopeChanged predicate, enforced
      // main-side): the analyzed plan's user objects must equal the draft's
      // current selection — freezing a stale plan resolves mappings against
      // objects the analysis never saw.
      const planView = store.getPlan(deploymentId)
      const planUserObjects = new Set(
        (planView?.objects ?? [])
          .map((o) => o.objectName)
          .filter((n) => !(planView?.autoInjectedJunctions ?? []).includes(n))
      )
      if (
        planUserObjects.size !== draft.config.selectedObjects.length ||
        draft.config.selectedObjects.some((o) => !planUserObjects.has(o))
      ) {
        throw new RdsHandlerError(
          'INVALID_STATE',
          'The object scope changed after analysis — re-run analysis before deploying.'
        )
      }

      // The attempt body. `onRun` fires once, right after createRun, so the
      // wrapper below knows whether a run row (and its status mirror) exists
      // when something throws.
      const work = async (
        ctx: JobContext,
        onRun: (runId: number) => void
      ): Promise<{ outcome: RunOutcome } & RunCounters> => {
        const cfg = draft.config

        ctx.phase('Connecting')
        const source = await connectById(draft.sourceConnectionId, 'source')
        // NO role override (REVIEW-FIX): overriding to 'target' would
        // silently re-promote a connection the user demoted on the
        // Connections page. The STORED role must be exactly 'target' (and
        // connect() may still downgrade it — prod pin / untrusted OAuth).
        const target = await connectById(draft.targetConnectionId)
        if (target.role !== 'target') {
          throw new RdsHandlerError(
            'READ_ONLY_ORG',
            `Org '${target.alias}' cannot be a deploy target (role '${target.role}') — ` +
              `set its role to Target on the Orgs step or the Connections page, then deploy again.`
          )
        }
        ctx.cancel.throwIfCancelled()

        // FRESH automation discovery — the attestation gate re-evaluates
        // against current target state, never a stale wizard snapshot.
        ctx.phase('Gates')
        const scope = planned.map((p) => p.objectName)
        const discoveryIo = makeAutomationIo(target)
        const snapshot = await discoverAutomation(discoveryIo, scope)
        // S54 F2: the counts and the flow-set actually in play go in the job
        // log, not just the wizard panel (the L2 lesson).
        for (const line of discoverySummaryLines(snapshot)) ctx.log(line.message, line.level)
        if (attestationBlocked(snapshot, false, cfg.cpqAttestation)) {
          throw new RdsHandlerError(
            'INVALID_STATE',
            'CPQ "Triggers Disabled" attestation is required before deploying — confirm it on the plan step.'
          )
        }
        // S32 per-run WFR toggle ANDed with the master switch — off means
        // the slice never even queries the rules.
        const workflowRulesEnabled =
          (cfg.disableAutomations ?? true) && (cfg.disableWorkflowRules ?? true)
        const workflowRules = workflowRulesEnabled ? await queryWorkflowRules(discoveryIo) : []
        const items = snapshot.items.filter((i) => effectiveDisable(i, cfg))
        ctx.cancel.throwIfCancelled()

        // Freeze: ORG-WIDE targetHasExtId (batchCheckRdsField oracle — a
        // scoped set over-downgrades A10), full describes per object.
        ctx.phase('Freezing plan')
        const targetHasExtId = await targetHasExtIdOrgWide(target)
        const objects = []
        for (const p of planned) {
          const sourceFields = await describeDeployFields(source, p.objectName)
          // populated-only (REVIEW-FIX): when the user chose it, the probe
          // MUST run — populatedFields:null excludes nothing, silently
          // deploying every field the wizard displayed as excluded. A probe
          // failure refuses the deploy rather than guessing.
          let populatedFields: string[] | null = null
          if (cfg.populatedOnly) {
            populatedFields = await probePopulatedFields(
              source,
              p.objectName,
              sourceFields.map((f) => f.apiName)
            )
          }
          objects.push({
            planned: p,
            sourceFields,
            targetFields: await describeDeployFields(target, p.objectName),
            populatedFields
          })
          ctx.cancel.throwIfCancelled()
        }
        // S57 (B1): parents OUTSIDE the plan that the target can key — probed once
        // here so the frozen plan resolves exactly what the Mappings step showed
        // (same policy call, same two sets). Read-only, one LIMIT 1 query per parent.
        const srcByObject: Record<string, readonly RefFieldLike[]> = {}
        const tgtByObject: Record<string, readonly RefFieldLike[]> = {}
        for (const o of objects) {
          srcByObject[o.planned.objectName] = o.sourceFields
          tgtByObject[o.planned.objectName] = o.targetFields
        }
        const outOfScope = outOfScopeRefs(cfg.selectedObjects, srcByObject, tgtByObject)
        const targetKeyedRows = await probeKeyedRows(
          target.conn,
          targetHasExtId,
          outOfScope.map((r) => r.refTo)
        )
        if (targetKeyedRows.size > 0) {
          ctx.log(
            'Parents outside the plan will resolve against RDS-keyed rows already on the target: ' +
              [...targetKeyedRows].sort().join(', ') +
              '.',
            'info'
          )
        }
        const plan = freezePlan({ objects, config: cfg, targetHasExtId, targetKeyedRows })
        // A2: freeze warnings (repairs A7/A9/A10/A12 + the S46 excluded-
        // deferred drops) were persisted only inside plan_json — surface
        // each as a job log line (Apex logged its repairs at Info,
        // DDQ:2017-2025; these are operator-actionable, so warn).
        for (const w of plan.warnings) ctx.log(w, 'warn')
        const planJson = JSON.stringify(plan)
        const planRow = store.deploy.savePlan(
          deploymentId,
          planJson,
          createHash('sha256').update(planJson).digest('hex')
        )
        const run = store.deploy.createRun(deploymentId, planRow.id)
        // Attempt linkage (S47): this attempt's run + the gate-time CPQ probe.
        store.setCurrentRun(deploymentId, run.id)
        store.deploy.setRunCpqTriggerSetting(run.id, snapshot.hasCpqTriggerSetting)
        onRun(run.id)

        // S53 (item 1) — pre-run audit, READ-ONLY, fail-open: does the target
        // already hold unkeyed rows under RDS-keyed parents (an earlier run's
        // automation residue, or hand-made records)? Said BEFORE the run so the
        // operator knows a re-run cannot remove or de-duplicate them.
        ctx.phase('Auditing target')
        try {
          await preRunAudit({
            target,
            store: store.deploy,
            runId: run.id,
            plan,
            targetFieldsByObject: new Map(
              objects.map((o) => [o.planned.objectName, o.targetFields])
            ),
            targetHasExtId,
            log: (level, message) => ctx.log(message, level)
          })
        } catch (e) {
          ctx.log(`Pre-run audit skipped: ${e instanceof Error ? e.message : String(e)}`, 'warn')
        }
        ctx.cancel.throwIfCancelled()

        ctx.phase('Deploying')
        const log = (level: 'warn' | 'error', message: string): void => ctx.log(message, level)
        // The last Error-level engine line (tripwire text, whole-object
        // exhaustion detail, teardown error) — persisted with the terminal
        // status so the REASON survives (review F2; Apex kept it in
        // Error_Message__c). The renderer has no log pane yet (5C.1).
        let lastErrorLine: string | null = null
        const io = makeDeployIo({
          source,
          target,
          store: store.deploy,
          emit: (event) => {
            if (event.kind === 'phase') ctx.phase(String(event.data.phase ?? ''))
            else if (event.kind === 'log') {
              const message = String(event.data.message ?? '')
              if (event.data.level === 'Error') lastErrorLine = message
              ctx.log(
                message,
                event.data.level === 'Error'
                  ? 'error'
                  : event.data.level === 'Warning'
                    ? 'warn'
                    : 'info'
              )
            } else if (event.kind === 'progress')
              ctx.progress(
                Number(event.data.value ?? 0),
                Number(event.data.max ?? 0),
                String(event.data.label ?? '')
              )
          }
        })
        const hooks = makeAutomationHooks({
          deploymentId,
          runUuid: runUuidFor(run.id),
          plan,
          items,
          workflowRules,
          workflowRulesEnabled,
          ledger: store.deploy,
          toggleIo: makeAutomationToggleIo(target, log),
          triggerIo: makeTriggerToggleIo(target, log),
          metadataIo: makeMetadataToggleIo(target, log),
          guardIo: makeCpqGuardIo(target, log)
        })
        const outcome = await runDeployment(
          run.id,
          io,
          { ...makePassExecutors(plan), ...hooks },
          {
            signal: {
              get aborted() {
                return ctx.cancel.cancelled
              }
            }
          }
        )
        // S53 (item 1) — post-run audit, READ-ONLY, fail-open, EVERY outcome:
        // rows created on the target during the run window by the deploying
        // user WITHOUT the RDS key are the fingerprint of target automation
        // that ran during the load (the "two of every product" class).
        // Runs after teardown so restore is already done; changes no outcome.
        ctx.phase('Auditing target')
        try {
          await postRunAudit({
            target,
            store: store.deploy,
            runId: run.id,
            plan,
            targetHasExtId,
            log: (level, message) => ctx.log(message, level)
          })
        } catch (e) {
          const why = e instanceof Error ? e.message : String(e)
          ctx.log(`Post-run audit failed: ${why}`, 'warn')
          try {
            store.deploy.markAuditComplete(run.id, `failed: ${why}`)
          } catch {
            /* the run row is gone — nothing to stamp */
          }
        }

        const counters = store.deploy.runCounters(run.id)
        // Terminal mapping (orchestrator.ts:34-36 contract): 'cancelled'
        // must surface as the job's cancelled event, not a normal 'done'.
        if (outcome === 'cancelled') throw new JobCancelledError()
        if (outcome === 'failed') {
          // A Stalled run means the RESTORE did not complete — the target's
          // automation may still be disabled. That message must never hide
          // behind a record-failure count (REVIEW-FIX).
          const finalPhase = store.deploy.getRun(run.id)?.phase
          if (finalPhase === 'Stalled') {
            // E2 (text slice): no recovery exists yet — say so, and point at
            // the manual Setup steps rendered on the deployment page.
            throw new RdsHandlerError('INVALID_STATE', stalledMessage(lastErrorLine))
          }
          throw new RdsHandlerError(
            'INVALID_STATE',
            runFailureMessage(counters.recordsFailed, lastErrorLine)
          )
        }
        return { outcome, ...counters }
      }

      const jobId = jobs.start(
        'deploy',
        'Deploy data',
        async (ctx) => {
          // D1: the attempt owns the row from its first instant (Apex DDS:70
          // flipped Status to 'Deploying' before the first hop); the previous
          // attempt's error is cleared with it.
          store.markDeployStarted(deploymentId)
          const attempt: { runId: number | null } = { runId: null }
          // S54 F5: peak working set per process over the run → one log line.
          const memory = startMemorySampler(() =>
            app
              .getAppMetrics()
              .map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize }))
          )
          try {
            return await work(ctx, (runId) => {
              attempt.runId = runId
              deployRunByJob.set(ctx.jobId, runId)
            })
          } catch (err) {
            // D1 close-out (services/deployAttempt.ts — tested in the sqlite
            // lane): pre-run → Failed + FULL text / Cancelled; run still Frozen
            // → close it through the state machine; otherwise the run mirrored
            // its own status and only the reason is recorded.
            closeOutAttempt(store, deploymentId, attempt.runId, err)
            throw err
          } finally {
            const peak = memory.stop()
            if (peak) ctx.log(peak, 'info')
            deployRunByJob.delete(ctx.jobId)
          }
        },
        { deploymentId: String(deploymentId) }
      )
      return { jobId }
    })
  )

  // rds:deploy.runState — S46 D2: the deployment detail page's single read.
  ipcMain.handle(
    IPC.deployRunState,
    wrapHandler((_e, deploymentId: number) => buildDeployRunState(store, jobs, deploymentId))
  )
}
