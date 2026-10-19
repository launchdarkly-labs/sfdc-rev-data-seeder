import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Overlay modal. Esc and backdrop click invoke onClose; clicks inside the
 * panel are contained. Content-agnostic — callers supply the body + footer.
 *
 * Focus management (ux A-6): on open, focus goes to the first footer button
 * (else the first focusable, else the panel) unless the caller already placed
 * it inside (an `autoFocus` input); Tab is trapped inside the panel; on close,
 * focus returns to whatever opened the modal. The dialog is labelled by its
 * visible <h2> header, not a duplicate aria-label.
 */
export function Modal({
  title,
  onClose,
  children,
  footer
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // Mount-only: initial focus, the Tab trap, and focus return. Deliberately
  // separate from the Escape handler so an inline `onClose` (a new function
  // every render) cannot re-run the focus logic mid-dialog.
  useEffect(() => {
    const panel = panelRef.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (panel && !panel.contains(document.activeElement)) {
      const footerButton = panel.querySelector<HTMLElement>('.modal-footer button:not([disabled])')
      const first = footerButton ?? panel.querySelector<HTMLElement>(FOCUSABLE) ?? panel
      first.focus()
    }
    const trap = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || !panel) return
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      if (items.length === 0) {
        e.preventDefault()
        panel.focus()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', trap)
    return () => {
      window.removeEventListener('keydown', trap)
      if (opener && opener.isConnected) opener.focus()
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={panelRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={titleId} className="modal-header">
          {title}
        </h2>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}
