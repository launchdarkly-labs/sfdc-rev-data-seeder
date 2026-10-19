import { describe, it, expect } from 'vitest'
import { migrateTemplate, TemplateVersionError } from '../../src/shared/templates/migrate'
import { SAMPLE_SEED_TEMPLATE } from '../../src/shared/templates/samples'

describe('migrateTemplate', () => {
  it('returns a v1 payload unchanged (as a copy)', () => {
    const out = migrateTemplate('seed', SAMPLE_SEED_TEMPLATE)
    expect(out).toEqual(SAMPLE_SEED_TEMPLATE)
    expect(out).not.toBe(SAMPLE_SEED_TEMPLATE)
  })

  it('treats a missing schemaVersion as v1 and stamps it', () => {
    const { schemaVersion: _v, ...noVersion } = SAMPLE_SEED_TEMPLATE
    const out = migrateTemplate('seed', noVersion)
    expect(out.schemaVersion).toBe(1)
  })

  it('refuses a newer version with the ceiling named', () => {
    expect(() => migrateTemplate('seed', { ...SAMPLE_SEED_TEMPLATE, schemaVersion: 7 })).toThrow(
      /schemaVersion 7 .* up to schemaVersion 1/
    )
    expect(() => migrateTemplate('seed', { schemaVersion: 0 })).toThrow(TemplateVersionError)
    expect(() => migrateTemplate('seed', { schemaVersion: 'x' })).toThrow(TemplateVersionError)
  })

  it('refuses non-objects', () => {
    expect(() => migrateTemplate('seed', null)).toThrow(TemplateVersionError)
    expect(() => migrateTemplate('postRefresh', [1])).toThrow(TemplateVersionError)
    expect(() => migrateTemplate('postRefresh', 'str')).toThrow(TemplateVersionError)
  })
})
