// @vitest-environment jsdom
/**
 * S64 P3 — the shared components and the accessibility fixes from the UX review:
 *  - EmptyState / Loading / CancelJobButton (ux C-12, C-13, F-5)
 *  - Toast: × close, alert vs status roles, cap at 3, "Dismiss all", errors persist (F-4, A-7)
 *  - Modal: initial focus, Tab trap, focus return, labelled by its <h2> (A-6)
 *  - DataTable: sortable headers are real buttons (A-5)
 *  - FilterEditor: Remove is a sibling of the label, not inside it (A-10)
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { EmptyState } from '../../src/renderer/src/ui/EmptyState'
import { Loading } from '../../src/renderer/src/ui/Loading'
import { CancelJobButton, CANCEL_JOB_HELPER } from '../../src/renderer/src/ui/CancelJobButton'
import { ToastProvider, useToast, MAX_VISIBLE_TOASTS } from '../../src/renderer/src/ui/Toast'
import type { ToastKind } from '../../src/renderer/src/ui/Toast'
import { Modal } from '../../src/renderer/src/ui/Modal'
import { DataTable, type Column } from '../../src/renderer/src/ui/DataTable'
import { FilterEditor } from '../../src/renderer/src/pages/wizard/FilterEditor'

afterEach(cleanup)

describe('EmptyState', () => {
  it('renders title, hint and action in one block', () => {
    render(<EmptyState title="Nothing yet" hint="Add one to begin." action={<button>Add</button>} />)
    const block = screen.getByText('Nothing yet').closest('.empty-state')!
    expect(block).toHaveTextContent('Add one to begin.')
    expect(within(block as HTMLElement).getByRole('button', { name: 'Add' })).toBeInTheDocument()
  })
})

describe('Loading', () => {
  it('shows the spinner with a live label and no status role (does not collide with page status regions)', () => {
    render(<Loading label="Comparing schemas…" />)
    const p = screen.getByText('Comparing schemas…').closest('.loading')!
    expect(p.querySelector('.spinner')).not.toBeNull()
    expect(p).toHaveAttribute('aria-live', 'polite')
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('CancelJobButton', () => {
  it('cancels the job through IPC, shows the helper text and cannot double-send', async () => {
    const user = userEvent.setup()
    const jobCancel = vi.fn(async () => undefined)
    ;(window as unknown as { rds: unknown }).rds = { jobCancel }
    render(<CancelJobButton jobId="j1" />)
    expect(screen.getByText(CANCEL_JOB_HELPER)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(jobCancel).toHaveBeenCalledWith('j1')
    const btn = screen.getByRole('button', { name: 'Cancelling…' })
    expect(btn).toBeDisabled()
    await user.click(btn)
    expect(jobCancel).toHaveBeenCalledTimes(1)
  })
})

function ToastHarness(): React.JSX.Element {
  const toast = useToast()
  const fire = (kind: ToastKind, n: number): void => toast(`${kind} ${n}`, kind)
  return (
    <>
      <button onClick={() => fire('info', 1)}>info1</button>
      <button onClick={() => fire('info', 2)}>info2</button>
      <button onClick={() => fire('info', 3)}>info3</button>
      <button onClick={() => fire('info', 4)}>info4</button>
      <button onClick={() => fire('error', 1)}>error1</button>
    </>
  )
}

describe('Toast (ux F-4 / A-7)', () => {
  function renderToasts(): void {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>
    )
  }

  it('errors are alerts and stay until closed; info toasts are status', async () => {
    const user = userEvent.setup()
    renderToasts()
    await user.click(screen.getByText('error1'))
    await user.click(screen.getByText('info1'))
    expect(screen.getByRole('alert')).toHaveTextContent('error 1')
    expect(screen.getByRole('status')).toHaveTextContent('info 1')
    // closable from the keyboard: a real button with an accessible name
    const close = within(screen.getByRole('alert')).getByRole('button', { name: 'Dismiss' })
    await user.click(close)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('caps visible toasts at three, dropping the oldest, and offers Dismiss all from two', async () => {
    const user = userEvent.setup()
    renderToasts()
    await user.click(screen.getByText('info1'))
    expect(screen.queryByRole('button', { name: 'Dismiss all' })).toBeNull()
    await user.click(screen.getByText('info2'))
    expect(screen.getByRole('button', { name: 'Dismiss all' })).toBeInTheDocument()
    await user.click(screen.getByText('info3'))
    await user.click(screen.getByText('info4'))
    const shown = screen.getAllByRole('status')
    expect(shown).toHaveLength(MAX_VISIBLE_TOASTS)
    expect(shown.map((t) => t.textContent)).not.toContain(expect.stringContaining('info 1'))
    expect(screen.queryByText('info 1')).toBeNull()
    expect(screen.getByText('info 4')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss all' }))
    expect(screen.queryAllByRole('status')).toHaveLength(0)
  })

  describe('auto-dismiss', () => {
    // fireEvent (not userEvent) under fake timers: userEvent's own delays would
    // wait on the faked clock and hang the test.
    afterEach(() => vi.useRealTimers())

    it('info toasts auto-dismiss, error toasts do not', () => {
      vi.useFakeTimers()
      renderToasts()
      fireEvent.click(screen.getByText('info1'))
      fireEvent.click(screen.getByText('error1'))
      expect(screen.getByText('info 1')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(7000)
      })
      expect(screen.queryByText('info 1')).toBeNull()
      expect(screen.getByRole('alert')).toHaveTextContent('error 1')
    })
  })
})

function ModalHarness({ withInput = false }: { withInput?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      {open && (
        <Modal
          title="Delete this?"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button onClick={() => setOpen(false)}>Cancel</button>
              <button onClick={() => setOpen(false)}>Confirm</button>
            </>
          }
        >
          {withInput ? <input aria-label="Name" autoFocus /> : <p>Body text</p>}
        </Modal>
      )}
    </>
  )
}

describe('Modal focus management (ux A-6)', () => {
  it('is labelled by its visible h2, focuses the first footer button, traps Tab, and returns focus on close', async () => {
    const user = userEvent.setup()
    render(<ModalHarness />)
    const opener = screen.getByRole('button', { name: 'open' })
    await user.click(opener)
    const dialog = screen.getByRole('dialog', { name: 'Delete this?' })
    const heading = within(dialog).getByRole('heading', { level: 2, name: 'Delete this?' })
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id)
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' })
    expect(cancel).toHaveFocus()
    await user.tab()
    expect(confirm).toHaveFocus()
    await user.tab() // wraps back to the first focusable inside the panel
    expect(cancel).toHaveFocus()
    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(opener).toHaveFocus()
  })

  it('leaves focus where the caller put it (an autoFocus input) instead of stealing it', async () => {
    const user = userEvent.setup()
    render(<ModalHarness withInput />)
    await user.click(screen.getByRole('button', { name: 'open' }))
    expect(screen.getByLabelText('Name')).toHaveFocus()
  })
})

interface Row {
  id: string
  name: string
  n: number
}
const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', sortValue: (r) => r.name },
  { key: 'n', header: 'Count', render: (r) => String(r.n) }
]

describe('DataTable sortable headers (ux A-5)', () => {
  it('a sortable header is a button that sorts from the keyboard; a plain header is not', async () => {
    const user = userEvent.setup()
    const rows: Row[] = [
      { id: 'b', name: 'Bravo', n: 2 },
      { id: 'a', name: 'Alpha', n: 1 }
    ]
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} />)
    const sortBtn = screen.getByRole('button', { name: 'Name' })
    expect(screen.queryByRole('button', { name: 'Count' })).toBeNull()
    sortBtn.focus()
    await user.keyboard('{Enter}')
    const first = screen.getAllByRole('row')[1]!
    expect(within(first).getAllByRole('cell')[0]).toHaveTextContent('Alpha')
    expect(sortBtn.closest('th')).toHaveAttribute('aria-sort', 'ascending')
  })
})

describe('FilterEditor markup (ux A-10)', () => {
  it('the Remove button is not nested inside the label, and the label points at the input', () => {
    ;(window as unknown as { rds: unknown }).rds = {
      filterValidate: async () => ({ ok: true, count: 1, soql: '', strippedClause: null }),
      describeObject: async () => []
    }
    render(
      <FilterEditor connectionId="src" objectName="Account" value="" onChange={vi.fn()} onRemove={vi.fn()} />
    )
    const remove = screen.getByRole('button', { name: 'Remove filter for Account' })
    expect(remove.closest('label')).toBeNull()
    const input = screen.getByLabelText('Filter for Account')
    const label = screen.getByText('Account')
    expect(label.tagName).toBe('LABEL')
    expect(label).toHaveAttribute('for', input.id)
  })
})
