import { createContext, useCallback, useContext, useRef, useState } from 'react'
import type { ReactNode } from 'react'

export type ToastKind = 'info' | 'success' | 'error'
interface Toast {
  id: number
  kind: ToastKind
  message: string
}

const ToastContext = createContext<(message: string, kind?: ToastKind) => void>(() => {
  throw new Error('useToast must be used within <ToastProvider>')
})

const DEFAULT_TTL_MS = 6000
/** ux F-4: never more than this many on screen; the oldest is dropped first. */
export const MAX_VISIBLE_TOASTS = 3

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number): void => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])
  const dismissAll = useCallback((): void => setToasts([]), [])

  const push = useCallback(
    (message: string, kind: ToastKind = 'info'): void => {
      const id = nextId.current++
      setToasts((ts) => [...ts, { id, kind, message }].slice(-MAX_VISIBLE_TOASTS))
      // Errors linger until closed (ux F-4: closable, not permanent); info/success fade.
      if (kind !== 'error') setTimeout(() => dismiss(id), DEFAULT_TTL_MS)
    },
    [dismiss]
  )

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-host">
        {toasts.length >= 2 && (
          <button type="button" className="btn btn-small toast-dismiss-all" onClick={dismissAll}>
            Dismiss all
          </button>
        )}
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            // ux A-7: an error interrupts (alert); the rest wait their turn (status).
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-message">{t.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): (message: string, kind?: ToastKind) => void {
  return useContext(ToastContext)
}
