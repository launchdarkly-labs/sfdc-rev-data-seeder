/**
 * The result line for a bulk action — "Applied suggestions — 54 to Direct ID,
 * 11 to Name Match", "Suggest failed: …", "Saved template …".
 *
 * UI-6. Two defects made this worth extracting rather than repeating:
 *
 * 1. Each step kept its own `note: string | undefined` shared by BOTH the
 *    success and the failure paths, so a success affordance (a tick, a green
 *    accent) would have decorated error messages too. The tone is therefore
 *    part of the value, not a styling afterthought — `ok()` / `err()` are the
 *    only ways to set one.
 * 2. The markup used `.footprint`, which had NO CSS rules, so a genuinely
 *    informative summary rendered as unnoticed body text. `.footprint` also
 *    means "the deploy's record-count footprint" elsewhere, so the outcome note
 *    owns `.outcome` instead of restyling an unrelated concept.
 *
 * Errors get role="alert" so a failure is announced; successes deliberately do
 * not, because interrupting a screen reader to say "that worked" is noise.
 */

export interface Note {
  text: string
  tone: 'ok' | 'error'
}

export const okNote = (text: string): Note => ({ text, tone: 'ok' })
export const errNote = (text: string): Note => ({ text, tone: 'error' })

export function OutcomeNote({ note }: { note: Note | undefined }): React.JSX.Element | null {
  if (!note) return null
  return (
    <p
      className={`outcome outcome-${note.tone}`}
      role={note.tone === 'error' ? 'alert' : undefined}
    >
      <span className="outcome-icon" aria-hidden="true">
        {note.tone === 'ok' ? '✓' : '⚠'}
      </span>
      {note.text}
    </p>
  )
}
