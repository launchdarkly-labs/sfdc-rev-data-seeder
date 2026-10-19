import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

type Resolver = (ok: boolean) => void
type PendingConfirm = ConfirmOptions & { resolve: Resolver }

const ConfirmContext = createContext<(opts: ConfirmOptions) => Promise<boolean>>(() => {
  throw new Error('useConfirm must be used within <ConfirmProvider>')
})

/**
 * Promise-based confirm dialog, replacing window.confirm (which Electron
 * renderers should not use). `const confirm = useConfirm(); if (await
 * confirm({...})) { ... }`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ ...opts, resolve })
    })
  }, [])

  const settle = (ok: boolean): void => {
    if (pending) pending.resolve(ok)
    setPending(null)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending && (
        <Modal
          title={pending.title}
          onClose={() => settle(false)}
          footer={
            <>
              <button className="btn" onClick={() => settle(false)}>
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button
                className={`btn ${pending.danger ? 'danger' : 'primary'}`}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel ?? 'Confirm'}
              </button>
            </>
          }
        >
          {pending.message}
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  return useContext(ConfirmContext)
}
