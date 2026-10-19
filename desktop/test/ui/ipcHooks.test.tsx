// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, act, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useIpcQuery, useIpcMutation } from '../../src/renderer/src/ipc/hooks'
import { callIpc, setAuthExpiredHandler } from '../../src/renderer/src/ipc/client'
import { encodeRdsError } from '../../src/shared/types'
import type { RdsError } from '../../src/shared/types'

afterEach(() => {
  cleanup()
  setAuthExpiredHandler(null)
})

function QueryHarness({ fetcher }: { fetcher: () => Promise<string> }): React.JSX.Element {
  const { data, loading, error, refetch } = useIpcQuery(fetcher, [])
  return (
    <div>
      <div data-testid="state">
        {loading ? 'loading' : error ? `error:${error.code}` : `data:${data}`}
      </div>
      <button onClick={refetch}>refetch</button>
    </div>
  )
}

describe('useIpcQuery', () => {
  it('resolves loading → data', async () => {
    render(<QueryHarness fetcher={() => Promise.resolve('hello')} />)
    expect(screen.getByTestId('state')).toHaveTextContent('loading')
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('data:hello'))
  })

  it('surfaces a typed RdsError on rejection', async () => {
    const fetcher = (): Promise<string> =>
      Promise.reject(new Error(encodeRdsError({ code: 'SOQL_INVALID', message: 'bad soql' })))
    render(<QueryHarness fetcher={fetcher} />)
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error:SOQL_INVALID'))
  })
})

function MutationHarness(): React.JSX.Element {
  const { mutate, loading, error } = useIpcMutation((n: number) => Promise.resolve(n * 2))
  const [result, setResult] = useState<number | undefined>(undefined)
  return (
    <div>
      <div data-testid="mstate">{loading ? 'loading' : error ? `error:${error.code}` : 'idle'}</div>
      <button
        onClick={async () => {
          setResult(await mutate(21))
        }}
      >
        go
      </button>
      <div data-testid="mresult">{result}</div>
    </div>
  )
}

describe('useIpcMutation', () => {
  it('runs and returns the value', async () => {
    const user = userEvent.setup()
    render(<MutationHarness />)
    await user.click(screen.getByText('go'))
    await waitFor(() => expect(screen.getByTestId('mresult')).toHaveTextContent('42'))
  })
})

describe('callIpc AUTH_EXPIRED routing', () => {
  it('invokes the registered auth-expired handler before rejecting', async () => {
    const seen: RdsError[] = []
    setAuthExpiredHandler((e) => seen.push(e))
    const failing = (): Promise<never> =>
      Promise.reject(
        new Error(
          encodeRdsError({ code: 'AUTH_EXPIRED', message: 'expired', connection: 'sb1_714' })
        )
      )
    await act(async () => {
      await expect(callIpc(failing)).rejects.toMatchObject({ code: 'AUTH_EXPIRED' })
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.connection).toBe('sb1_714')
  })

  it('does not invoke the handler for other error codes', async () => {
    const seen: RdsError[] = []
    setAuthExpiredHandler((e) => seen.push(e))
    const failing = (): Promise<never> =>
      Promise.reject(new Error(encodeRdsError({ code: 'READ_ONLY_ORG', message: 'nope' })))
    await expect(callIpc(failing)).rejects.toMatchObject({ code: 'READ_ONLY_ORG' })
    expect(seen).toHaveLength(0)
  })
})
