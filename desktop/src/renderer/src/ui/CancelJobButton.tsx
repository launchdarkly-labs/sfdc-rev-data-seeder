import { useState } from 'react'

export const CANCEL_JOB_HELPER = 'Stops at the next batch; records already written stay.'

/**
 * The one Cancel for a running job (ux F-5): three pages had three Cancel
 * buttons with three behaviours and the reason only in `title`. This one calls
 * `window.rds.jobCancel(jobId)`, says what cancelling does in visible text, and
 * flips to "Cancelling…" once requested so a second click cannot double-send.
 */
export function CancelJobButton({
  jobId,
  label = 'Cancel',
  helper = CANCEL_JOB_HELPER,
  disabled = false
}: {
  jobId: string
  label?: string
  helper?: string
  disabled?: boolean
}): React.JSX.Element {
  const [requested, setRequested] = useState(false)
  const cancel = (): void => {
    setRequested(true)
    void window.rds.jobCancel(jobId)
  }
  return (
    <span className="cancel-job">
      <button type="button" className="btn" onClick={cancel} disabled={disabled || requested}>
        {requested ? 'Cancelling…' : label}
      </button>
      <span className="cancel-job-helper">{helper}</span>
    </span>
  )
}
