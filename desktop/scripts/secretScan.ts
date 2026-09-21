/**
 * Secret-scan rules (A10) — institutionalizes the Session-26 leak scar: a real
 * Consumer Key/Secret once reached git. This is the pure, unit-tested core; the
 * `scan-secrets.ts` runner feeds it tracked/staged file contents.
 *
 * Design bias: HIGH-CONFIDENCE signatures only (real token/key shapes, or a
 * *-secret variable assigned a long literal). We deliberately do NOT flag the
 * public PKCE client id — it is non-secret and lives only in gitignored
 * .env.local — so the scanner has near-zero false positives on our own tree.
 */

export interface SecretRule {
  name: string
  /** Human hint shown with a hit. */
  hint: string
  re: RegExp
}

export interface SecretHit {
  rule: string
  hint: string
  line: number
  /** The matched text, truncated + partially masked so the log never re-leaks it. */
  preview: string
}

/**
 * Rules are matched per line. Each regex is authored WITHOUT the global flag —
 * the scanner adds line context — so state can't leak between `.test()` calls.
 */
export const SECRET_RULES: SecretRule[] = [
  {
    name: 'private-key',
    hint: 'PEM private key block',
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/
  },
  {
    name: 'sf-session-token',
    hint: 'Salesforce session/access token (orgId!… signature)',
    re: /\b00D[A-Za-z0-9]{12,18}![A-Za-z0-9._+=/-]{40,}/
  },
  {
    name: 'sf-refresh-token',
    hint: 'Salesforce refresh token literal',
    re: /\b5Aep[0-9][A-Za-z0-9._-]{40,}/
  },
  {
    name: 'oauth-client-secret',
    hint: 'consumer/client secret assigned a literal value',
    // A *secret* key assigned a 16+ char HIGH-ENTROPY literal (must contain a
    // digit — real SF consumer secrets/keys do). The value char class excludes
    // `.` / `(` so identifier & field references (`= rec.Consumer_Secret__c`,
    // `= getConsumerSecret()`) and prose / empty assignments never match.
    re: /(?:client|consumer)_?secret["'\s]*[:=]["'\s]*(?=[A-Za-z0-9+/=_%-]*[0-9])[A-Za-z0-9+/=_%-]{16,}/i
  },
  {
    name: 'aws-access-key',
    hint: 'AWS access key id',
    re: /\bAKIA[0-9A-Z]{16}\b/
  }
]

/**
 * Inline suppression marker. A line containing this token is skipped — for
 * intentional secret-SHAPED fixtures/examples (this detector's own tests, doc
 * snippets). Use sparingly and only on demonstrably-fake values.
 */
export const SECRET_SCAN_IGNORE = 'secret-scan:ignore'

/** Mask the middle of a matched secret so scanner output never re-leaks it. */
export function maskPreview(match: string): string {
  const trimmed = match.trim()
  if (trimmed.length <= 12) return `${trimmed.slice(0, 3)}…`
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)} (${trimmed.length} chars)`
}

/**
 * Scan one file's text. Returns a hit per (rule, line). `allowlist` lets a
 * caller suppress known-safe substrings (e.g. a documented scrubbed placeholder).
 */
export function findSecrets(text: string, allowlist: string[] = []): SecretHit[] {
  const hits: SecretHit[] = []
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    if (line.includes(SECRET_SCAN_IGNORE)) return
    if (allowlist.some((a) => a && line.includes(a))) return
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line)
      if (m) {
        hits.push({ rule: rule.name, hint: rule.hint, line: i + 1, preview: maskPreview(m[0]) })
      }
    }
  })
  return hits
}
