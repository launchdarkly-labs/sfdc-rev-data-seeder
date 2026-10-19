/**
 * Resolve what a run will actually do: the template (seed or post-refresh),
 * the seed templates it names (looked up by name at run time — plan §3.1),
 * the groups selected per seed, and the opt-in patches. Pure; the store
 * lookups are injected as a map.
 */
import type {
  PostRefreshTemplate,
  RunnableTemplateKind,
  SeedTemplate,
  SeedTier,
  SettingPatch,
  TemplateRunSteps
} from '../../../shared/templates/types'
import { DEFAULT_TIER_GROUP } from '../../../shared/templates/types'
import { validateTemplate } from '../../../shared/templates/validate'

export interface ResolvedSeed {
  name: string
  template: SeedTemplate
  /** Groups to run (empty = all). */
  groups: string[]
  /** The tiers this run executes, in template order. */
  tiers: SeedTier[]
}

export interface ResolvedRun {
  kind: RunnableTemplateKind
  name: string
  postRefresh: PostRefreshTemplate | null
  /** Patches that will run: non-opt-in ones, plus the opt-ins the user ticked. */
  settingPatches: SettingPatch[]
  automation: boolean
  seeds: ResolvedSeed[]
  /** Problems that make the run impossible (missing seed templates, invalid payloads). */
  blockers: string[]
  /** The snapshot persisted with the run (post-refresh: with its seeds embedded). */
  snapshot: unknown
}

export function tiersForGroups(template: SeedTemplate, groups: ReadonlyArray<string>): SeedTier[] {
  if (groups.length === 0) return [...template.tiers]
  const set = new Set(groups)
  return template.tiers.filter((t) => set.has(t.group ?? DEFAULT_TIER_GROUP))
}

export function resolveRun(input: {
  kind: RunnableTemplateKind
  name: string
  payload: unknown
  steps: TemplateRunSteps
  seedTemplatesByName: ReadonlyMap<string, unknown>
}): ResolvedRun {
  const blockers: string[] = []
  const v = validateTemplate(input.kind, input.payload)
  if (!v.ok) blockers.push(`Template "${input.name}" is not valid: ${v.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)

  if (input.kind === 'seed') {
    const t = input.payload as SeedTemplate
    const wanted = input.steps.seeds.find((s) => s.name === input.name)
    const groups = wanted?.groups ?? []
    const tiers = v.ok ? tiersForGroups(t, groups) : []
    if (v.ok && tiers.length === 0) blockers.push(`No tiers selected for "${input.name}"`)
    return {
      kind: 'seed',
      name: input.name,
      postRefresh: null,
      settingPatches: [],
      automation: false,
      seeds: v.ok ? [{ name: input.name, template: t, groups, tiers }] : [],
      blockers,
      snapshot: input.payload
    }
  }

  const pr = input.payload as PostRefreshTemplate
  const seeds: ResolvedSeed[] = []
  const embedded: Array<{ name: string; payload: unknown }> = []
  if (v.ok) {
    for (const ref of pr.seedTemplates) {
      const chosen = input.steps.seeds.find((s) => s.name === ref.name)
      if (!chosen) continue // not selected for this run
      const payload = input.seedTemplatesByName.get(ref.name)
      if (payload === undefined) {
        blockers.push(`Seed template "${ref.name}" does not exist — create or import it, or remove it from "${input.name}"`)
        continue
      }
      const sv = validateTemplate('seed', payload)
      if (!sv.ok) {
        blockers.push(`Seed template "${ref.name}" is not valid: ${sv.errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`)
        continue
      }
      const st = payload as SeedTemplate
      const groups = chosen.groups.length > 0 ? chosen.groups : (ref.groups ?? [])
      const tiers = tiersForGroups(st, groups)
      if (tiers.length === 0) blockers.push(`No tiers selected for seed template "${ref.name}"`)
      seeds.push({ name: ref.name, template: st, groups, tiers })
      embedded.push({ name: ref.name, payload })
    }
  }
  const optIn = new Set(input.steps.optInPatches)
  const settingPatches = v.ok
    ? pr.automation.settingPatches.filter((p) => !p.optIn || optIn.has(p.label))
    : []
  return {
    kind: 'postRefresh',
    name: input.name,
    postRefresh: v.ok ? pr : null,
    settingPatches,
    automation: input.steps.automation,
    seeds,
    blockers,
    snapshot: { ...(input.payload as Record<string, unknown>), embeddedSeedTemplates: embedded }
  }
}
