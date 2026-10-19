/**
 * Template payload versioning (S59 plan §3.3). A `vN → vN+1` chain; v1 is the
 * only version today. Import validates AFTER migration; export always writes
 * the current version. An unknown (newer) version is refused with a message
 * that names the ceiling instead of guessing.
 */
import { TEMPLATE_SCHEMA_VERSION, type RunnableTemplateKind } from './types'

export class TemplateVersionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateVersionError'
  }
}

type Step = (kind: RunnableTemplateKind, raw: Record<string, unknown>) => Record<string, unknown>

/** index N holds the step that lifts schemaVersion N to N+1. Empty until v2 exists. */
const STEPS: Record<number, Step> = {}

/**
 * Lift a raw payload to the current schema version. A payload with no
 * `schemaVersion` is treated as v1 (the first shape ever written). Returns a
 * NEW object; the input is not mutated.
 */
export function migrateTemplate(kind: RunnableTemplateKind, raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TemplateVersionError('A template must be a JSON object')
  }
  let cur: Record<string, unknown> = { ...(raw as Record<string, unknown>) }
  // Absent = the first shape ever written (v1). Present but not a positive
  // integer = a corrupt file, refused rather than guessed.
  let version = cur.schemaVersion === undefined ? 1 : cur.schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new TemplateVersionError(`schemaVersion ${String(cur.schemaVersion)} is not a valid version`)
  }
  if (version > TEMPLATE_SCHEMA_VERSION) {
    throw new TemplateVersionError(
      `This template is schemaVersion ${version} — this app understands up to schemaVersion ${TEMPLATE_SCHEMA_VERSION}. ` +
        'Update the app to open it.'
    )
  }
  while (version < TEMPLATE_SCHEMA_VERSION) {
    const step = STEPS[version]
    if (!step) throw new TemplateVersionError(`No migration from schemaVersion ${version}`)
    cur = step(kind, cur)
    version += 1
  }
  cur.schemaVersion = TEMPLATE_SCHEMA_VERSION
  return cur
}
