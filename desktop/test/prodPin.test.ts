/**
 * S64 P6 (6.3, decision D6): the production pin as a runtime setting.
 * Pure lane — the resolver, the per-key setting validation, and the transport's
 * write gate honouring a pin other than the compiled default.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROD_ORG_ID_PREFIX,
  isPinnedProdOrgId,
  normalizeProdOrgIdPrefix,
  PROD_PIN_SETTING_KEY,
  PROD_PIN_SETTING_ROW,
  resolveProdOrgIdPrefix
} from '../src/shared/prodPin'
import { normalizeSettingValue } from '../src/shared/settings'
import { PROD_ORG_ID_PREFIX, SETTING_KEYS } from '../src/shared/types'
import { connect, isProdOrg, ReadOnlyOrgError } from '../src/main/services/salesforce'
import { deploymentRoleIssues } from '../src/shared/roles'
import type { TokenProvider, ConnectionInput, MintedToken } from '../src/main/services/tokenProvider'

const OTHER_PROD_15 = '00D000000Fake99'
const OTHER_PROD_18 = `${OTHER_PROD_15}EAA`

describe('normalizeProdOrgIdPrefix', () => {
  it('accepts a 15-character Org Id as-is and trims whitespace', () => {
    expect(normalizeProdOrgIdPrefix(OTHER_PROD_15)).toBe(OTHER_PROD_15)
    expect(normalizeProdOrgIdPrefix(`  ${OTHER_PROD_15}\n`)).toBe(OTHER_PROD_15)
  })
  it('reduces an 18-character Org Id to its 15-character prefix', () => {
    expect(normalizeProdOrgIdPrefix(OTHER_PROD_18)).toBe(OTHER_PROD_15)
  })
  it('rejects anything that is not an Org Id', () => {
    for (const bad of ['', '   ', '001000000Fake99', '00D000000Fake9', '00D000000Fake99EA', '00D-00000Fake99', 'prod'])
      expect(normalizeProdOrgIdPrefix(bad), bad).toBeNull()
    expect(normalizeProdOrgIdPrefix(null)).toBeNull()
    expect(normalizeProdOrgIdPrefix(undefined)).toBeNull()
  })
})

describe('resolveProdOrgIdPrefix', () => {
  it('falls back to the compiled constant when nothing (or garbage) is stored', () => {
    expect(DEFAULT_PROD_ORG_ID_PREFIX).toBe(PROD_ORG_ID_PREFIX)
    expect(resolveProdOrgIdPrefix(null)).toBe(PROD_ORG_ID_PREFIX)
    expect(resolveProdOrgIdPrefix('')).toBe(PROD_ORG_ID_PREFIX)
    expect(resolveProdOrgIdPrefix('not-an-id')).toBe(PROD_ORG_ID_PREFIX)
  })
  it('uses a valid stored value', () => {
    expect(resolveProdOrgIdPrefix(OTHER_PROD_18)).toBe(OTHER_PROD_15)
  })
})

describe('isPinnedProdOrgId', () => {
  it('matches both forms of the pinned org and nothing else', () => {
    expect(isPinnedProdOrgId(`${PROD_ORG_ID_PREFIX}EAK`)).toBe(true)
    expect(isPinnedProdOrgId(PROD_ORG_ID_PREFIX)).toBe(true)
    expect(isPinnedProdOrgId(OTHER_PROD_18)).toBe(false)
    expect(isPinnedProdOrgId(OTHER_PROD_18, OTHER_PROD_15)).toBe(true)
    expect(isPinnedProdOrgId(`${PROD_ORG_ID_PREFIX}EAK`, OTHER_PROD_15)).toBe(false)
    expect(isPinnedProdOrgId('', OTHER_PROD_15)).toBe(false)
    expect(isPinnedProdOrgId(null)).toBe(false)
  })
  it('an empty prefix pins nothing (never "everything starts with the empty string")', () => {
    expect(isPinnedProdOrgId(OTHER_PROD_18, '')).toBe(false)
  })
})

describe('settings allow-list + validation', () => {
  it('the pin key is allow-listed and its store row carries the pref. prefix', () => {
    expect(SETTING_KEYS).toContain(PROD_PIN_SETTING_KEY)
    expect(PROD_PIN_SETTING_ROW).toBe(`pref.${PROD_PIN_SETTING_KEY}`)
  })
  it('normalizes a pin value and rejects a non-Org-Id with a readable message', () => {
    expect(normalizeSettingValue('prodOrgIdPrefix', OTHER_PROD_18)).toBe(OTHER_PROD_15)
    expect(() => normalizeSettingValue('prodOrgIdPrefix', 'prod')).toThrow(/Org Id/)
    expect(() => normalizeSettingValue('prodOrgIdPrefix', 42)).toThrow(/short strings/)
  })
  it('leaves the theme value alone apart from the length ceiling', () => {
    expect(normalizeSettingValue('theme', 'light')).toBe('light')
    expect(() => normalizeSettingValue('theme', 'x'.repeat(65))).toThrow(/short strings/)
  })
})

// ── the transport honours a runtime pin ─────────────────────────────────────

const base: ConnectionInput = {
  id: 'c1',
  authKind: 'cli',
  role: 'target',
  cliAlias: 'tgt_a',
  loginUrl: null,
  username: 'admin@tgt',
  orgId: OTHER_PROD_18,
  instanceUrl: 'https://tgt.my.salesforce.com'
}
const minted: MintedToken = {
  accessToken: 'AT',
  instanceUrl: 'https://tgt.my.salesforce.com',
  orgId: OTHER_PROD_18,
  username: 'admin@tgt'
}
const tokens: TokenProvider = {
  mint: async () => minted,
  refresh: async () => ({ accessToken: 'R', instanceUrl: minted.instanceUrl })
}

describe('connect() with a runtime pin', () => {
  it('without the option the compiled default applies — the other org is writable', async () => {
    expect(isProdOrg(OTHER_PROD_18)).toBe(false)
    const org = await connect(base, tokens)
    expect(org.role).toBe('target')
    expect(() => org.assertWritable('insert')).not.toThrow()
  })
  it('with the option the other org is pinned: role forced to source, writes refused', async () => {
    expect(isProdOrg(OTHER_PROD_18, OTHER_PROD_15)).toBe(true)
    const org = await connect(base, tokens, { prodOrgIdPrefix: OTHER_PROD_15 })
    expect(org.role).toBe('source')
    expect(() => org.assertWritable('insert')).toThrow(ReadOnlyOrgError)
    expect(() => org.assertWritable('insert')).toThrow(/PRODUCTION/)
  })
  it('re-pinning releases the compiled default org', async () => {
    const ldMint: MintedToken = { ...minted, orgId: `${PROD_ORG_ID_PREFIX}EAK` }
    const ldTokens: TokenProvider = { ...tokens, mint: async () => ldMint }
    const org = await connect({ ...base, orgId: ldMint.orgId }, ldTokens, { prodOrgIdPrefix: OTHER_PROD_15 })
    expect(org.role).toBe('target')
    expect(() => org.assertWritable('insert')).not.toThrow()
  })
})

describe('role check wording no longer names a company', () => {
  it('reports a pinned target generically', () => {
    const issues = deploymentRoleIssues(
      { id: 's', label: 'srcbox', role: 'source', prodPinned: false },
      { id: 't', label: 'prodorg', role: 'source', prodPinned: true }
    )
    const reasons = issues.map((b) => b.reason).join(' ')
    expect(reasons).toMatch(/pinned production org/)
    expect(reasons).not.toMatch(/LaunchDarkly/)
  })
})
