/**
 * Loading line (ux C-13): the existing `.spinner` plus a label, so every wait
 * in the app looks the same and the page keeps its header while it loads.
 * `aria-live="polite"` announces label changes (e.g. "Describing 3 / 27…")
 * without the `status` role, so it never collides with the page's own status
 * regions in queries.
 */
export function Loading({ label }: { label: string }): React.JSX.Element {
  return (
    <p className="loading" aria-live="polite" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <span className="loading-label">{label}</span>
    </p>
  )
}
