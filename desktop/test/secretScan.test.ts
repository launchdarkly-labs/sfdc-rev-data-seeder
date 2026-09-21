/**
 * Secret-scan detector (A10) — pure lane. Confirms the high-confidence rules
 * fire on real token/key shapes and, crucially, do NOT fire on our own idioms
 * (the public client id, prose mentioning "secret", empty assignments, variable
 * references) so the scanner has near-zero false positives on the tree.
 */
import { describe, it, expect } from 'vitest'
import { findSecrets, maskPreview, SECRET_SCAN_IGNORE } from '../scripts/secretScan'

describe('findSecrets — fires on real secrets', () => {
  it('flags a PEM private key block', () => {
    const hits = findSecrets('foo\n-----BEGIN RSA PRIVATE KEY-----\nMIIEv...\n') // secret-scan:ignore (fixture)
    expect(hits.map((h) => h.rule)).toContain('private-key')
    expect(hits[0]!.line).toBe(2)
  })

  it('flags a Salesforce session/access token signature', () => {
    const tok = '00D41000000UvVn!AQEAQK9' + 'a'.repeat(60)
    expect(findSecrets(`accessToken = "${tok}"`).map((h) => h.rule)).toContain('sf-session-token')
  })

  it('flags a Salesforce refresh token literal', () => {
    const rt = '5Aep861' + 'A1b2c3d4'.repeat(8)
    expect(findSecrets(`refresh=${rt}`).map((h) => h.rule)).toContain('sf-refresh-token')
  })

  it('flags a client/consumer secret assigned a long literal', () => {
    expect(findSecrets('client_secret=ABCDEF0123456789abcdef').map((h) => h.rule)).toContain( // secret-scan:ignore (fixture)
      'oauth-client-secret'
    )
    expect(
      findSecrets('consumerSecret: "9F8e7D6c5B4a3210ZZZ"').map((h) => h.rule) // secret-scan:ignore (fixture)
    ).toContain('oauth-client-secret')
  })

  it('flags an AWS access key id', () => {
    expect(findSecrets('key=AKIAIOSFODNN7EXAMPLE').map((h) => h.rule)).toContain('aws-access-key') // secret-scan:ignore (fixture)
  })
})

describe('findSecrets — does NOT fire on safe idioms', () => {
  it('ignores the PUBLIC PKCE client id (non-secret)', () => {
    const clientId = '3MVG9synthetic0000000000000000000000.example00000000000000000000000000000000000000000000'
    expect(findSecrets(`MAIN_VITE_OAUTH_CLIENT_ID=${clientId}`)).toEqual([])
  })

  it('ignores prose mentioning "consumer secret" and empty assignments', () => {
    expect(findSecrets('# public PKCE client — NO consumer secret is ever stored')).toEqual([])
    expect(findSecrets("client_secret: ''")).toEqual([])
    expect(findSecrets('MAIN_VITE_OAUTH_CLIENT_ID=')).toEqual([])
  })

  it('ignores variable references to refresh_token / access_token', () => {
    expect(findSecrets('refreshToken: p.refreshToken,')).toEqual([])
    expect(findSecrets("body: new URLSearchParams({ grant_type: 'refresh_token' })")).toEqual([])
  })

  it('ignores *Secret variables assigned to field/method references (real Apex idioms)', () => {
    expect(findSecrets('ac.consumerSecret = rec.Consumer_Secret__c;')).toEqual([])
    expect(findSecrets('String consumerSecret = getConsumerSecret();')).toEqual([])
    expect(findSecrets('this.clientSecret = config.clientSecret')).toEqual([])
  })

  it('honors the allowlist for a documented scrubbed placeholder', () => {
    const line = 'client_secret=REDACTED_PLACEHOLDER_VALUE_00' // secret-scan:ignore (fixture)
    expect(findSecrets(line)).not.toEqual([]) // has a digit → would flag
    expect(findSecrets(line, ['REDACTED_PLACEHOLDER_VALUE_00'])).toEqual([])
  })

  it('honors the inline secret-scan:ignore pragma on a line', () => {
    // A real secret shape whose line carries the ignore marker → skipped.
    const ignored = `client_secret=ABCDEF0123456789abcdef  // ${SECRET_SCAN_IGNORE}` // secret-scan:ignore (fixture)
    expect(findSecrets(ignored)).toEqual([])
  })
})

describe('maskPreview', () => {
  it('masks the middle so the log never re-leaks the secret', () => {
    const p = maskPreview('AKIAIOSFODNN7EXAMPLE') // secret-scan:ignore (fixture)
    expect(p).toBe('AKIAIO…MPLE (20 chars)')
    expect(p).not.toContain('SFODNN7EXA')
  })
})
