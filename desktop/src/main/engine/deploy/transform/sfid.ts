/**
 * P1 — Salesforce Id codec + reverse-ExtId formula (transformMap.md P1;
 * ExternalIdService.cls:285-298, FIELD_NAME/FIELD_LENGTH L7-9).
 *
 * **HIGH fidelity risk.** Every upsert key and every parent external-Id
 * reference in the deploy engine derives from `generateExternalId`, and the
 * classifier / retry / junction paths decode failed ExtIds back to source Ids
 * via `decodeExternalId`. The round-trip law and the 15→18 checksum must be
 * byte-exact with Apex or every cross-org link silently breaks.
 *
 * Pure: no jsforce, no better-sqlite3, no node built-ins. The one source of
 * non-determinism (the null-input random fallback, a KILLED dummy-seed path
 * ported only for shape) takes an injected RNG so tests stay deterministic.
 */

/** The seeder's hardcoded external-Id field (ExternalIdService.FIELD_NAME). */
export const EXTERNAL_ID_FIELD = 'Data_Deployment_External_Id__c'
/** ExternalIdService.FIELD_LENGTH — Text(18). */
export const EXTERNAL_ID_LENGTH = 18

/**
 * Salesforce's 18-char case-safe suffix alphabet: a base-32 mapping over the
 * 5-bit "is this char uppercase A-Z" bitmap of each 5-char chunk.
 */
const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'
/** Valid Salesforce Id characters: [0-9A-Za-z]. */
const ID_CHAR = /^[0-9A-Za-z]$/

/**
 * Apex `Id.valueOf(id15)` → 18-char, i.e. appends the 3-char checksum suffix.
 *
 * Each of the three 5-char chunks contributes one suffix char: bit `i`
 * (`i = 0` is the FIRST char of the chunk, the least-significant bit) is set
 * when that char is an uppercase A-Z letter; the resulting 0-31 value indexes
 * `SUFFIX_ALPHABET`. Verified against real ldseed Ids (e.g.
 * `005fn000003twuU`→`AAQ`, `00Dfn00000EOvEp`→`EAL`).
 *
 * Throws on any input that isn't exactly 15 valid Id chars — matches Apex
 * `Id.valueOf` throwing `System.StringException` on a malformed Id.
 */
export function to18(id15: string): string {
  if (id15.length !== 15) {
    throw new Error(`to18: expected a 15-char Salesforce Id, got length ${id15.length} ("${id15}")`)
  }
  let suffix = ''
  for (let chunk = 0; chunk < 3; chunk++) {
    let value = 0
    for (let bit = 0; bit < 5; bit++) {
      const ch = id15.charAt(chunk * 5 + bit)
      if (!ID_CHAR.test(ch)) {
        throw new Error(`to18: invalid Salesforce Id character "${ch}" in "${id15}"`)
      }
      if (ch >= 'A' && ch <= 'Z') value += 1 << bit
    }
    suffix += SUFFIX_ALPHABET.charAt(value)
  }
  return id15 + suffix
}

/**
 * Apex `id.substring(0, 15)` normalization to the 15-char case-unsafe form.
 * The 15/18 dual-form storage the engine uses everywhere (inactive users,
 * PBEs, classifier, directId strip — transformMap §5 trap 4) keys off this.
 * A shorter/15-char input is returned unchanged.
 */
export function to15(id: string): string {
  return id.length <= 15 ? id : id.substring(0, 15)
}

/**
 * Java `String.reverse()` — code-point-safe (Salesforce Ids are ASCII, but the
 * helper must round-trip losslessly regardless). This is literally the ExtId
 * formula's transform step AND its inverse, so `reverse(reverse(x)) === x`.
 */
export function reverse(s: string): string {
  return Array.from(s).reverse().join('')
}

/**
 * ExternalIdService.generateExternalId (L285-289):
 *  - `null`/`undefined` source Id → 18-char random hex fallback (the dummy-seed
 *    path, KILLED as a live cross-org path but ported for shape; the cross-org
 *    engine always passes a real record Id here).
 *  - 15-char Id → `reverse(to18(id))`.
 *  - already-18-char (or any other length) Id → `reverse(id)` verbatim, exactly
 *    as Apex reverses the id it was handed without re-normalizing.
 *
 * `rng` is injected so tests are deterministic; the default draws 18 lowercase
 * hex chars from Web Crypto (Apex uses `Crypto.generateAesKey(128)`).
 */
export function generateExternalId(
  recordId: string | null | undefined,
  rng: () => string = randomHex18
): string {
  if (recordId == null) return rng()
  const id18 = recordId.length === 15 ? to18(recordId) : recordId
  return reverse(id18)
}

/**
 * Decodes an ExtId back to its source Id — Apex `extId.reverse()`. Used to map
 * failed ExtIds back to source Ids for `classifyFailures`, retry Id lists, and
 * junction parent-scope reversal. Exact inverse of `generateExternalId`'s
 * reverse step, so `decodeExternalId(generateExternalId(id18)) === id18` for any
 * 18-char Id (for a 15-char input it returns the 18-char form; `to15` recovers
 * the 15-char one).
 */
export function decodeExternalId(extId: string): string {
  return reverse(extId)
}

/** Default RNG for the null-input fallback: 18 lowercase hex chars via Web Crypto. */
function randomHex18(): string {
  const cryptoObj = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } })
    .crypto
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      'generateExternalId: called with no source Id and no crypto available for the random fallback'
    )
  }
  const bytes = new Uint8Array(9) // 9 bytes → 18 hex chars
  cryptoObj.getRandomValues(bytes)
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}
