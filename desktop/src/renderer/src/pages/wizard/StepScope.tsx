import { useCallback, useMemo, useState } from 'react'
import { FilterEditor } from './FilterEditor'
import { SelectionPills } from '../../ui/SelectionPills'
import { useWizard } from './WizardShell'
import { useScopeDescribes } from './useScopeDescribes'
import { useTargetKeys } from './useTargetKeys'
import {
  buildParentSuggestions,
  filteredObjects,
  outOfScopeRefs,
  parentObjectsWithinScope,
  scopeEmptyMessage,
  scopeIsEmpty,
  suggestionBody,
  suggestionHeadline,
  type FilterProbe,
  type ParentSuggestion
} from '../../../../shared/scopeAdvisor'

/**
 * Wizard Step 3 — HOW MUCH of each object to take: scope mode plus optional
 * per-object WHERE clauses with live COUNT() validation. Object SELECTION moved
 * to the Objects step in S49 (UI-2a).
 *
 * UI-2d, the filters redesign: this used to render one row per selected object,
 * so 27 selected objects meant 27 rows, ~25 of them an empty input nobody would
 * ever fill. Filters are now an explicit LIST you add to — only objects that
 * actually have a clause take up space, and the copy states plainly what the
 * unfiltered ones will do, so nothing looks forgotten.
 *
 * S57 adds two things this step can now SAY instead of leaving to the run:
 *  - B3: when every filter validates to 0 records and nothing else is a root,
 *    nothing can deploy — an amber banner and "Next: readiness" disabled (V1 on
 *    sb3, 2026-09-18: the amber line showed, Next stayed enabled).
 *  - B2: a reference from an in-scope object to an object OUTSIDE the scope gets
 *    a card — required ⇒ every row fails; optional ⇒ a blank link — with an
 *    "add the parent" button and a ready-made semi-join filter when SOQL allows
 *    one. Run 24: CampaignMember → Campaign, 228/228 REQUIRED_FIELD_MISSING that
 *    the Mappings step already knew about and never mentioned.
 *
 * The analysis engine (5B.7) does the real structured scoping; this only
 * captures intent and validates clauses.
 */
export function StepScope(): React.JSX.Element {
  const { sourceConnectionId, targetConnectionId, config, updateConfig, goToStep } = useWizard()
  const [adding, setAdding] = useState<string>('')

  const selected = config.selectedObjects
  const filtered = selected.filter((o) => config.filters[o] != null)
  const unfiltered = selected.filter((o) => config.filters[o] == null)

  // ── S57 (B3): live COUNT() verdicts, lifted from each FilterEditor ──
  const [probes, setProbes] = useState<Record<string, FilterProbe | undefined>>({})
  const onFilterResult = useCallback((objectName: string, probe: FilterProbe | null): void => {
    setProbes((prev) => {
      const cur = prev[objectName]
      const same =
        (cur == null && probe == null) ||
        (cur != null &&
          probe != null &&
          cur.kind === probe.kind &&
          (cur.kind !== 'count' || probe.kind !== 'count' || cur.count === probe.count))
      if (same) return prev
      const next = { ...prev }
      if (probe == null) delete next[objectName]
      else next[objectName] = probe
      return next
    })
  }, [])

  // ── S57 (B2/B3): describes on both orgs (cached), degrade open ──
  const describes = useScopeDescribes(sourceConnectionId, targetConnectionId, selected)
  const parentsByObject = useMemo(
    () => (describes.source ? parentObjectsWithinScope(selected, describes.source) : null),
    [describes.source, selected]
  )
  const withClause = filteredObjects(selected, config.filters)
  const empty = scopeIsEmpty({
    selectedObjects: selected,
    filters: config.filters,
    probes,
    parentsByObject
  })

  const refs = useMemo(
    () =>
      describes.source && describes.target
        ? outOfScopeRefs(selected, describes.source, describes.target)
        : [],
    [describes.source, describes.target, selected]
  )
  const refTargets = useMemo(() => [...new Set(refs.map((r) => r.refTo))], [refs])
  const { keys: targetKeys } = useTargetKeys(targetConnectionId, refTargets)
  const [dismissed, setDismissed] = useState<string[]>([])
  // Jack (2026-09-18): collapsed by default — the list can be long on a wide scope.
  const [advisorOpen, setAdvisorOpen] = useState(false)
  const suggestions = useMemo(
    () =>
      buildParentSuggestions({ refs, filters: config.filters, targetKeys }).filter(
        (s) => !dismissed.includes(s.refTo)
      ),
    [refs, config.filters, targetKeys, dismissed]
  )

  function setFilter(objectName: string, clause: string): void {
    const next = { ...config.filters }
    // An empty clause is a no-op filter; keep the ROW (the user is mid-edit)
    // but store '' so it still counts as added until they remove it.
    next[objectName] = clause
    updateConfig({ filters: next })
  }

  function removeFilter(objectName: string): void {
    const next = { ...config.filters }
    delete next[objectName]
    updateConfig({ filters: next })
  }

  /** B2: add the suggested parent to the scope, with the generated filter or an empty row to fill. */
  function addParent(s: ParentSuggestion, withFilter: boolean): void {
    if (selected.includes(s.refTo)) return
    const filters = { ...config.filters }
    if (withFilter && s.suggestedFilter != null) filters[s.refTo] = s.suggestedFilter
    else if (filters[s.refTo] == null) filters[s.refTo] = ''
    updateConfig({ selectedObjects: [...selected, s.refTo], filters })
  }

  // An old bookmark to …/scope, or a Draft created under the 7-step wizard,
  // can land here with nothing selected. There is nothing to scope, so say so
  // and point at the step that now owns selection rather than showing an
  // empty page with a dead Next button.
  if (selected.length === 0) {
    return (
      <>
        <h2>Scope</h2>
        <div className="banner">
          No objects are selected yet — scope and filters apply to the objects you pick first.{' '}
          <button className="btn" onClick={() => goToStep('objects')}>
            Choose objects
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <h2>Scope</h2>

      <SelectionPills selected={selected} readOnly />

      {/*
        S50 (A4): the "Scope mode" radio (Parent-scoped vs All records) was
        REMOVED. It wrote `config.filterMode`, which nothing in the main
        process ever read — picking "All records" silently gave you
        parent-scoped behaviour. Rather than wire it, this states the rule the
        engine actually follows, because the alternative it advertised is not a
        mode anyone wants: unscoping every child would pull ~2.4M records for
        this object set. Objects that genuinely cannot be scoped still fall
        through to "every record", and the analysis now WARNS per object when
        that happens.
      */}
      <section className="scope-mode">
        <h3>How scope is decided</h3>
        <ol className="scope-rules">
          <li>An object with a filter below uses that WHERE clause.</li>
          <li>
            Everything else is scoped by its parent — only records related to what the filtered
            objects returned.
          </li>
          <li>
            An object with neither takes <strong>every record in the source org</strong>. Analysis
            warns by name when that happens.
          </li>
        </ol>
      </section>

      <section className="filters">
        <div className="filters-head">
          <h3>Filters (optional)</h3>
          <span className="muted">
            {filtered.length === 0 ? 'None' : `${filtered.length} active`}
          </span>
        </div>

        {filtered.length > 0 && (
          <div className="filter-editor">
            {filtered.map((obj) => (
              <FilterEditor
                key={obj}
                connectionId={sourceConnectionId}
                targetConnectionId={targetConnectionId}
                objectName={obj}
                value={config.filters[obj] ?? ''}
                onChange={(clause) => setFilter(obj, clause)}
                onRemove={() => removeFilter(obj)}
                onResult={onFilterResult}
              />
            ))}
          </div>
        )}

        {unfiltered.length > 0 && (
          <div className="filter-add">
            <select
              aria-label="Add a filter for"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            >
              <option value="">Add a filter for…</option>
              {unfiltered.map((obj) => (
                <option key={obj} value={obj}>
                  {obj}
                </option>
              ))}
            </select>
            <button
              className="btn"
              disabled={adding === ''}
              onClick={() => {
                setFilter(adding, '')
                setAdding('')
              }}
            >
              Add filter
            </button>
          </div>
        )}

        <p className="muted">
          {unfiltered.length} of {selected.length} selected object
          {selected.length === 1 ? '' : 's'} {unfiltered.length === 1 ? 'has' : 'have'} no filter
          and will deploy all in-scope records. Counts are exact (COUNT() on the source org).
        </p>
      </section>

      {/* S57 (B3): nothing can deploy — say so and close Next (D3: Next only). */}
      {empty && (
        <div className="banner warn" role="status" data-testid="scope-empty">
          {scopeEmptyMessage(withClause)}
        </div>
      )}

      {/* S57 (B2): parents outside this deployment that in-scope objects point at. */}
      {suggestions.length > 0 && (
        <section className="advisor" aria-label="Parents outside this deployment">
          <div className="advisor-head">
            <h3>
              Parents outside this deployment{' '}
              <span className="muted">
                ({suggestions.length}
                {suggestions.some((s) => s.required) ? ', some required' : ''})
              </span>
            </h3>
            <button
              className="btn btn-small"
              aria-expanded={advisorOpen}
              onClick={() => setAdvisorOpen((o) => !o)}
            >
              {advisorOpen ? 'Hide' : 'Show'}
            </button>
          </div>
          {advisorOpen &&
            suggestions.map((s) => (
            <div
              key={s.refTo}
              className={`advisor-card${s.keyedOnTarget ? ' keyed' : s.required ? ' required' : ''}`}
              data-testid={`advisor-${s.refTo}`}
            >
              <p>
                <strong>{suggestionHeadline(s)}</strong>
              </p>
              {suggestionBody(s).map((line) => (
                <p key={line}>{line}</p>
              ))}
              {s.suggestedFilter != null ? (
                <p className="muted">
                  Filter it to exactly the referenced rows: <code>{s.suggestedFilter}</code>
                </p>
              ) : (
                s.filterNote && <p className="muted">{s.filterNote}</p>
              )}
              <div className="toolbar">
                {s.suggestedFilter != null && (
                  <button className="btn primary" onClick={() => addParent(s, true)}>
                    Add {s.refTo} with that filter
                  </button>
                )}
                <button className="btn" onClick={() => addParent(s, false)}>
                  {s.suggestedFilter != null ? `Add ${s.refTo}, I'll filter it` : `Add ${s.refTo}`}
                </button>
                <button
                  className="btn subtle"
                  onClick={() => setDismissed((d) => [...d, s.refTo])}
                >
                  Leave it out
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="toolbar">
        <button className="btn" onClick={() => goToStep('objects')}>
          Back
        </button>
        <button
          className="btn primary"
          onClick={() => goToStep('readiness')}
          disabled={empty}
          title={empty ? scopeEmptyMessage(withClause) : undefined}
        >
          Next: readiness
        </button>
      </div>
    </>
  )
}
