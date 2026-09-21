/**
 * Secret-scan runner (A10). Scans the repo's TRACKED files (or, with --staged,
 * only staged files) for high-confidence secret signatures and exits non-zero on
 * any hit. Wired into CI (desktop-ci.yml) and the repo-root pre-commit hook
 * (.githooks/pre-commit) so the Session-26 leak can't recur.
 *
 *   tsx scripts/scan-secrets.ts            # all tracked files
 *   tsx scripts/scan-secrets.ts --staged   # only git-staged files (pre-commit)
 *
 * Only TRACKED/STAGED files are read, so gitignored secrets (desktop/.env.local)
 * are never scanned — and never committable, which is the point.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { findSecrets } from './secretScan'

// Binary/vendored/lockfile paths where a "match" would be noise, not a secret.
const SKIP = /(?:^|\/)(?:node_modules|dist|out|build|\.git)\/|package-lock\.json$|\.(?:png|jpg|jpeg|gif|ico|icns|pdf|zip|asar|node|woff2?)$/

// Known-safe substrings (documented, non-secret). Keep this list tiny + audited.
const ALLOWLIST: string[] = []

function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
}

function fileList(root: string, stagedOnly: boolean): string[] {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files']
  return execFileSync('git', args, { cwd: root })
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => !SKIP.test(p))
}

function main(): void {
  const stagedOnly = process.argv.includes('--staged')
  const root = repoRoot()
  const files = fileList(root, stagedOnly)
  let total = 0

  for (const rel of files) {
    const abs = join(root, rel)
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue // unreadable/binary
    }
    const hits = findSecrets(text, ALLOWLIST)
    for (const h of hits) {
      total++
      console.error(`✗ ${rel}:${h.line}  [${h.rule}] ${h.hint} — ${h.preview}`)
    }
  }

  const scope = stagedOnly ? 'staged' : 'tracked'
  if (total > 0) {
    console.error(
      `\nSecret scan FAILED: ${total} potential secret(s) in ${scope} files. ` +
        `Remove them (secrets belong only in gitignored .env.local) before committing.`
    )
    process.exit(1)
  }
  console.log(`✓ Secret scan clean (${files.length} ${scope} files).`)
}

main()
