/**
 * IPC surface — thin adapters from renderer calls to the service layer.
 * All heavy lifting lives in services/ and engine/ so it stays testable
 * outside Electron.
 */
import { app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NO_TARGET_KEYS } from '../shared/mappingPolicy'
import { randomUUID } from 'node:crypto'
import { SETTING_KEYS, IPC } from '../shared/types'
import type { SettingKey } from '../shared/types'
import { normalizeSettingValue } from '../shared/settings'
import type { OrgConnection, OrgRole, OAuthBeginInput, TemplateKind } from '../shared/types'
import type { WizardConfig, WizardStep } from '../shared/wizard'
import { listCliOrgs, getCliToken } from './services/sfcli'
import { connect, verifyIdentity, type GuardedOrg } from './services/salesforce'
import { createTokenProvider } from './services/tokenProvider'
import { authorize, revokeToken } from './services/oauthFlow'
import { describeGlobal, describeObject } from './services/describe'
import type { Store } from './services/store'
import type { TokenVault } from './services/tokenVault'
import type { JobManager } from './jobs'
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
import { discoverAutomation, makeAutomationIo } from './services/automationDiscovery'
import { canEditPlan, isDeployBusy, isKeyless } from '../shared/wizard'
import { bridgeCancel } from './services/deployAttempt'
import { currentAttemptRun, buildDeployRunState } from './services/deployRunState'
import { invalidateTargetKeysCache, probeTargetKeys } from './services/targetKeys'
import { outOfScopeRefs, requiredReferenceWarnings } from '../shared/scopeAdvisor'
import type { FieldInfo } from '../shared/types'
import { registerTemplateIpc } from './ipc/templates'
import { startDeployRun } from './ipc/deployRuns'

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
    // S64 P6 (D6): the write gate re-checks the minted org id against the RUNTIME pin.
    return connect(roleOverride ? { ...row, role: roleOverride } : row, tokens, {
      prodOrgIdPrefix: store.getProdOrgIdPrefix()
    })
  }

  // S46 D3 — cancel bridge: jobId → deploy_runs.id for RUNNING deploy jobs.
  // Populated right after createRun, pruned when the job ends. `rds:job.cancel`
  // flips the job's cooperative token AND the run's persisted cancel flag so
  // the orchestrator's batch-boundary checks (firstPass/retry/secondPass read
  // isCancelRequested) actually fire — before this the flag had no writer.
  const deployRunByJob = new Map<string, number>()

  // S59 — the templates surface (definitions, catalog, runs) lives in ipc/templates.ts.
  registerTemplateIpc({ store, jobs, connectById })

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
      (_e, input: { name: string; sourceConnectionId: string; targetConnectionId: string; useExternalIds?: boolean }) =>
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
            // S61 (U-5): a keyless run never resolves an out-of-scope parent by key — the
            // warning must judge by the same (no-keys) view the freeze will use.
            const keys = isKeyless(cfg)
              ? NO_TARGET_KEYS
              : await probeTargetKeys(
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
  // background job. S62: lifted to ipc/deployRuns.ts (startDeployRun) so a
  // composed run (templates as stages, U-2) drives the same gates and work.
  ipcMain.handle(
    IPC.deployStart,
    wrapHandler((_e, deploymentId: number) =>
      startDeployRun(
        {
          store,
          jobs,
          connectById,
          deployRunByJob,
          appMetrics: () => app.getAppMetrics().map((m) => ({ type: m.type, memory: { workingSetSize: m.memory.workingSetSize } }))
        },
        deploymentId
      )
    )
  )

  // rds:deploy.runState — S46 D2: the deployment detail page's single read.
  ipcMain.handle(
    IPC.deployRunState,
    wrapHandler((_e, deploymentId: number) => buildDeployRunState(store, jobs, deploymentId))
  )

  // rds:settings.get / set — S64 (P4): renderer preferences (theme); P6 adds the
  // production pin (`prodOrgIdPrefix`, validated to an Org Id). Allow-listed keys only.
  ipcMain.handle(
    IPC.settingsGet,
    wrapHandler((_e, key: string) => {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new RdsHandlerError('INVALID_STATE', `Unknown setting ${key}`)
      return store.getSetting(`pref.${key}`)
    })
  )
  ipcMain.handle(
    IPC.settingsSet,
    wrapHandler((_e, key: string, value: string) => {
      if (!(SETTING_KEYS as readonly string[]).includes(key)) throw new RdsHandlerError('INVALID_STATE', `Unknown setting ${key}`)
      let normalized: string
      try {
        normalized = normalizeSettingValue(key as SettingKey, value)
      } catch (e) {
        throw new RdsHandlerError('INVALID_STATE', e instanceof Error ? e.message : String(e))
      }
      store.putSetting(`pref.${key}`, normalized)
    })
  )

  // rds:deploy.exportFailures — S64 (P2): the latest run's failed rows with their reasons, as a
  // JSON file the operator picks a location for. Replaces the "look in failed_records" copy.
  ipcMain.handle(
    IPC.deployExportFailures,
    wrapHandler(async (_e, deploymentId: number) => {
      const header = store.getDeploymentHeader(deploymentId)
      if (!header) throw new RdsHandlerError('NOT_FOUND', `Deployment ${deploymentId} not found`)
      const run = currentAttemptRun(store, deploymentId, header.status)
      if (!run) throw new RdsHandlerError('INVALID_STATE', 'This deployment has no run to export failures from.')
      const failures = store.deploy.failureExport(run.id)
      const safe = header.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'deployment'
      const res = await dialog.showSaveDialog({
        title: 'Export failure list',
        defaultPath: join(app.getPath('documents'), `${safe}-run${run.id}-failures.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      })
      if (res.canceled || !res.filePath) return null
      const file = {
        deploymentId,
        deploymentName: header.name,
        runId: run.id,
        exportedAt: new Date().toISOString(),
        failureCount: failures.length,
        failures
      }
      await writeFile(res.filePath, JSON.stringify(file, null, 2) + '\n', 'utf8')
      return res.filePath
    })
  )
}
