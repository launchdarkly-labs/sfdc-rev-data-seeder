/**
 * The production pin as a RUNTIME setting (S64 P6, decision D6).
 *
 * A connection whose Org Id starts with the pinned prefix is read-only in every
 * layer: the store reports its role as `source` and refuses `target`, the
 * transport's write gate refuses every write from it, and the templates
 * pre-flight lists it as a blocker. Until 0.4.0 the prefix was the compiled
 * constant `PROD_ORG_ID_PREFIX` alone — another team's production org was
 * unprotected until they rebuilt the app. Now the constant is the DEFAULT and the
 * Connections page can set a different Org Id, stored under
 * `settings.pref.prodOrgIdPrefix`.
 *
 * Dependency-free: imported by the store, the transport, the IPC layer and the
 * renderer.
 */
import { PROD_ORG_ID_PREFIX } from './types'

/** The `SettingKey` the renderer reads / writes; the store row is `pref.<key>`. */
export const PROD_PIN_SETTING_KEY = 'prodOrgIdPrefix' as const
export const PROD_PIN_SETTING_ROW = `pref.${PROD_PIN_SETTING_KEY}`

/** The compiled default — the org this tool was first built for. */
export const DEFAULT_PROD_ORG_ID_PREFIX = PROD_ORG_ID_PREFIX

/** A Salesforce Org Id: `00D` + 12 alphanumerics, optionally the 3-character checksum suffix. */
const ORG_ID = /^00D[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/

/**
 * Normalise what the user typed to the 15-character prefix the pin compares on,
 * or `null` when it is not an Org Id. Whitespace is trimmed; an 18-character id
 * loses its checksum suffix so `startsWith` matches both forms of the same org.
 */
export function normalizeProdOrgIdPrefix(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim()
  if (!ORG_ID.test(v)) return null
  return v.slice(0, 15)
}

/** The effective prefix: a valid stored value, else the compiled default. */
export function resolveProdOrgIdPrefix(stored: string | null | undefined): string {
  return normalizeProdOrgIdPrefix(stored) ?? DEFAULT_PROD_ORG_ID_PREFIX
}

/** True when `orgId` belongs to the pinned production org. */
export function isPinnedProdOrgId(orgId: string | null | undefined, prefix: string = DEFAULT_PROD_ORG_ID_PREFIX): boolean {
  return !!orgId && prefix.length > 0 && orgId.startsWith(prefix)
}

/** The user-facing explanation, shared by the Connections page and the How To. */
export const PROD_PIN_HELP =
  'Connections whose Org Id starts with this prefix are pinned read-only: they can be a source but never a target, ' +
  'and the write gate refuses every write to them. Paste the 15- or 18-character Org Id of your own production org ' +
  '(Setup → Company Information).'
