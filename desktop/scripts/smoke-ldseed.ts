/**
 * Live smoke: proves the CLI-auth → jsforce → describe/query service layer
 * against ldseed (the dev org), plus the read-only guardrail, plus the
 * SQLite store round-trip. Run: npm run smoke
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listCliOrgs, getCliToken } from '../src/main/services/sfcli'
import { connectCli, verifyIdentity, ReadOnlyOrgError } from '../src/main/services/salesforce'
import { describeGlobal, describeObject } from '../src/main/services/describe'
import { Store } from '../src/main/services/store'

const ALIAS = process.env.RDS_SMOKE_ALIAS ?? 'ldseed'

function ok(label: string, detail = ''): void {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  console.log(`RDS Desktop smoke against '${ALIAS}'\n`)

  // 1. CLI enumeration
  const orgs = await listCliOrgs()
  const target = orgs.find((o) => o.alias === ALIAS)
  if (!target) throw new Error(`alias '${ALIAS}' not in sf org list`)
  ok('sf CLI enumeration', `${orgs.length} orgs, found ${ALIAS} (${target.username})`)

  // 2. Token mint
  const token = await getCliToken(ALIAS)
  ok('CLI token mint', `orgId ${token.orgId}, instance ${token.instanceUrl}`)

  // 3. Store round-trip (temp db)
  const dir = mkdtempSync(join(tmpdir(), 'rds-smoke-'))
  const store = new Store(join(dir, 'smoke.db'))
  store.upsertConnections(
    orgs.map((o) => ({
      alias: o.alias,
      username: o.username,
      orgId: o.orgId,
      instanceUrl: o.instanceUrl,
      connectedStatus: o.connectedStatus,
      isSandbox: o.isSandbox
    }))
  )
  const listed = store.listConnections()
  if (!listed.find((c) => c.cliAlias === ALIAS)) throw new Error('store round-trip lost the org')
  ok('SQLite store round-trip', `${listed.length} connections persisted`)

  // 4. Guardrail: a 'source' org must refuse writes; prod can never be target
  const readOnly = await connectCli(ALIAS, 'source')
  let guardFired = false
  try {
    readOnly.assertWritable('smoke-test insert')
  } catch (e) {
    guardFired = e instanceof ReadOnlyOrgError
  }
  if (!guardFired) throw new Error('GUARDRAIL FAILURE: source org accepted a write')
  ok('read-only guardrail', 'source role refused a write')
  try {
    store.setRole(ALIAS, 'target') // ldseed is not prod → allowed
    ok('role assignment', 'ldseed can be target (not prod-pinned)')
  } finally {
    store.setRole(ALIAS, 'source')
  }

  // 5. Live identity
  const org = await connectCli(ALIAS, 'source')
  const identity = await verifyIdentity(org)
  ok('live identity', `${identity.username} @ ${identity.orgId}`)

  // 6. Describe global (+ cache)
  const t0 = Date.now()
  const objects = await describeGlobal(org, store)
  const cold = Date.now() - t0
  const t1 = Date.now()
  await describeGlobal(org, store)
  const warm = Date.now() - t1
  ok('describeGlobal', `${objects.length} queryable objects (cold ${cold}ms, cached ${warm}ms)`)

  // 7. Describe Account fields
  const fields = await describeObject(org, store, 'Account')
  const nameField = fields.find((f) => f.apiName === 'Name')
  if (!nameField) throw new Error('Account.Name missing from describe')
  ok(
    'describeObject(Account)',
    `${fields.length} fields, ${fields.filter((f) => f.isReference).length} references`
  )

  // 8. Live query
  const res = await org.conn.query('SELECT COUNT() FROM Account')
  ok('live SOQL', `Account count on ${ALIAS}: ${res.totalSize}`)

  store.close()
  rmSync(dir, { recursive: true, force: true })
  console.log('\nSMOKE PASSED')
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err)
  process.exit(1)
})
