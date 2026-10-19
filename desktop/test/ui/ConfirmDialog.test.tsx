// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ConfirmProvider, useConfirm } from '../../src/renderer/src/ui/ConfirmDialog'

function Harness(): React.JSX.Element {
  const confirm = useConfirm()
  const [result, setResult] = useState<string>('pending')
  return (
    <>
      <button
        onClick={async () => {
          const ok = await confirm({ title: 'Delete?', message: 'Really delete this?' })
          setResult(ok ? 'confirmed' : 'cancelled')
        }}
      >
        trigger
      </button>
      <div data-testid="result">{result}</div>
    </>
  )
}

afterEach(cleanup)

function renderHarness(): void {
  render(
    <ConfirmProvider>
      <Harness />
    </ConfirmProvider>
  )
}

describe('ConfirmDialog', () => {
  it('resolves true when confirmed', async () => {
    const user = userEvent.setup()
    renderHarness()
    await user.click(screen.getByText('trigger'))
    expect(screen.getByText('Really delete this?')).toBeInTheDocument()
    await user.click(screen.getByText('Confirm'))
    expect(screen.getByTestId('result')).toHaveTextContent('confirmed')
  })

  it('resolves false when cancelled', async () => {
    const user = userEvent.setup()
    renderHarness()
    await user.click(screen.getByText('trigger'))
    await user.click(screen.getByText('Cancel'))
    expect(screen.getByTestId('result')).toHaveTextContent('cancelled')
  })

  it('resolves false when dismissed via Escape', async () => {
    const user = userEvent.setup()
    renderHarness()
    await user.click(screen.getByText('trigger'))
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('result')).toHaveTextContent('cancelled')
  })
})
