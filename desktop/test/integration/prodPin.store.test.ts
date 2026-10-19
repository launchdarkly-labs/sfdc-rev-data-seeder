/**
 * S64 P6 (6.3, D6) — store side of the runtime production pin (sqlite lane:
 * `npm run rebuild:node` first). The pin is read from `settings.pref.prodOrgIdPrefix`
 * at every connection read, so changing it re-evaluates every row at once; the
 * compiled constant is only the default.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Store } from '../../src/main/services/store'
import { PROD_ORG_ID_PREFIX } from '../../src/shared/types'
import { PROD_PIN_SETTING_ROW } from '../../src/shared/prodPin'

let store: Store

const LD_PROD = `${PROD_ORG_ID_PREFIX}EAK`
const OTHER_PROD = '00D000000Fake99EAA'

const cli = (alias: string, username: string, orgId: string) => ({
  alias,
  username,
  orgId,
  instanceUrl: `https://${alias}.my.salesforce.com`,
  connectedStatus: 'Connected',
  isSandbox: false as boolean | null
})

beforeEach(() => {
  store = new Store(':memory:')
  store.upsertConnections([
    cli('prod_default', 'admin@default.prod', LD_PROD),
    cli('prod_other', 'admin@other.prod', OTHER_PROD),
    cli('tgt_a', 'admin@tgt_a', '00D000000Fake14EQA')
  ])
})
afterEach(() => store.close())

describe('default pin', () => {
  it('is the compiled constant when nothing is stored', () => {
    expect(store.getSetting(PROD_PIN_SETTING_ROW)).toBeNull()
    expect(store.getProdOrgIdPrefix()).toBe(PROD_ORG_ID_PREFIX)
    expect(store.getConnection('prod_default')!.prodPinned).toBe(true)
    expect(store.getConnection('prod_other')!.prodPinned).toBe(false)
  })

  it('refuses the target role on the default org only', () => {
    expect(() => store.setRole('prod_default', 'target')).toThrow(/pinned as production/)
    expect(() => store.setRole('prod_other', 'target')).not.toThrow()
    expect(store.getConnection('prod_other')!.role).toBe('target')
  })
})

describe('a stored pin', () => {
  beforeEach(() => store.putSetting(PROD_PIN_SETTING_ROW, OTHER_PROD))

  it('is normalised to 15 characters and wins over the constant', () => {
    expect(store.getProdOrgIdPrefix()).toBe(OTHER_PROD.slice(0, 15))
  })

  it('re-evaluates every connection at read time — the other org is pinned, the default released', () => {
    const byId = new Map(store.listConnections().map((c) => [c.id, c]))
    expect(byId.get('prod_other')?.prodPinned).toBe(true)
    expect(byId.get('prod_other')?.role).toBe('source') // forced in the view
    expect(byId.get('prod_default')?.prodPinned).toBe(false)
    expect(byId.get('tgt_a')?.prodPinned).toBe(false)
  })

  it('moves the setRole refusal with it', () => {
    expect(() => store.setRole('prod_other', 'target')).toThrow(/pinned as production/)
    expect(() => store.setRole('prod_default', 'target')).not.toThrow()
  })

  it('a stored role is preserved underneath the pin and reappears when the pin moves back', () => {
    store.putSetting(PROD_PIN_SETTING_ROW, PROD_ORG_ID_PREFIX)
    store.setRole('prod_other', 'target')
    store.putSetting(PROD_PIN_SETTING_ROW, OTHER_PROD)
    expect(store.getConnection('prod_other')!.role).toBe('source')
    store.putSetting(PROD_PIN_SETTING_ROW, PROD_ORG_ID_PREFIX)
    expect(store.getConnection('prod_other')!.role).toBe('target')
  })

  it('garbage in the setting falls back to the default instead of pinning nothing', () => {
    store.putSetting(PROD_PIN_SETTING_ROW, 'oops')
    expect(store.getProdOrgIdPrefix()).toBe(PROD_ORG_ID_PREFIX)
    expect(store.getConnection('prod_default')!.prodPinned).toBe(true)
  })

  it('supersession carries a role only when the live org is not the pinned one', () => {
    // tgt_a's alias is renamed; the live org id is the (now pinned) other prod org.
    store.setRole('tgt_a', 'target')
    store.upsertConnections([
      cli('prod_default', 'admin@default.prod', LD_PROD),
      cli('prod_other', 'admin@other.prod', OTHER_PROD),
      cli('tgt_a_renamed', 'admin@tgt_a', OTHER_PROD)
    ])
    expect(store.getConnection('tgt_a')!.supersededBy).toBe('tgt_a_renamed')
    // The pinned live org must not inherit 'target'.
    expect(store.getConnection('tgt_a_renamed')!.prodPinned).toBe(true)
    expect(store.getConnection('tgt_a_renamed')!.role).toBe('source')
    // Prove the stored row was never written: move the pin away and the row is still unassigned.
    store.putSetting(PROD_PIN_SETTING_ROW, PROD_ORG_ID_PREFIX)
    expect(store.getConnection('tgt_a_renamed')!.role).toBe('unassigned')
  })
})
