// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { FilterEditor } from '../../src/renderer/src/pages/wizard/FilterEditor'
import type { FilterValidateResult } from '../../src/shared/types'

type Validate = (input: {
  alias: string
  objectName: string
  filterClause: string
}) => Promise<FilterValidateResult>

function installRds(validate: Validate, fields: string[] = []): void {
  ;(window as unknown as { rds: unknown }).rds = {
    filterValidate: validate,
    describeObject: async () => fields.map((n) => ({ apiName: n }))
  }
}

afterEach(cleanup)

describe('FilterEditor', () => {
  it('validates the clause and shows the exact count', async () => {
    installRds(async () => ({ ok: true, count: 415, soql: 'x', strippedClause: null }))
    render(
      <FilterEditor
        connectionId="darkb"
        objectName="Contact"
        value="AccountId != null"
        onChange={vi.fn()}
      />
    )
    expect(await screen.findByText(/415 records/)).toBeInTheDocument()
  })

  it('shows the SOQL error inline when the clause is invalid', async () => {
    installRds(async () => ({
      ok: false,
      error: "MALFORMED_QUERY: unexpected token 'foo'",
      soql: 'x',
      strippedClause: null
    }))
    render(
      <FilterEditor connectionId="darkb" objectName="Contact" value="foo bar" onChange={vi.fn()} />
    )
    expect(await screen.findByText(/MALFORMED_QUERY/)).toBeInTheDocument()
  })

  it('surfaces a stripped ORDER BY (never silent)', async () => {
    installRds(async () => ({
      ok: true,
      count: 10,
      soql: 'x',
      strippedClause: 'ORDER BY CreatedDate DESC'
    }))
    render(
      <FilterEditor
        connectionId="darkb"
        objectName="Contact"
        value="Name != null ORDER BY CreatedDate DESC"
        onChange={vi.fn()}
      />
    )
    expect(await screen.findByText(/trailing clause ignored for the count/)).toBeInTheDocument()
    expect(screen.getByText('ORDER BY CreatedDate DESC')).toBeInTheDocument()
  })

  it('does not validate an empty clause (idle, no IPC call)', async () => {
    const spy = vi.fn(async () => ({ ok: true, count: 0, soql: '', strippedClause: null }))
    installRds(spy)
    render(<FilterEditor connectionId="darkb" objectName="Contact" value="" onChange={vi.fn()} />)
    // Give the debounce + query a beat; nothing should fire.
    await new Promise((r) => setTimeout(r, 50))
    expect(spy).not.toHaveBeenCalled()
    expect(screen.queryByText(/records/)).not.toBeInTheDocument()
  })

  it('emits keystrokes to onChange', () => {
    installRds(async () => ({ ok: true, count: 1, soql: 'x', strippedClause: null }))
    const onChange = vi.fn()
    render(<FilterEditor connectionId="darkb" objectName="Contact" value="" onChange={onChange} />)
    fireEvent.change(screen.getByLabelText('Filter for Contact'), {
      target: { value: 'Name != null' }
    })
    expect(onChange).toHaveBeenCalledWith('Name != null')
  })

  it('loads field-name autocomplete on focus', async () => {
    installRds(
      async () => ({ ok: true, count: 1, soql: 'x', strippedClause: null }),
      ['AccountId', 'Name']
    )
    render(<FilterEditor connectionId="darkb" objectName="Contact" value="" onChange={vi.fn()} />)
    fireEvent.focus(screen.getByLabelText('Filter for Contact'))
    await waitFor(() =>
      expect(document.querySelector('option[value="AccountId"]')).toBeInTheDocument()
    )
  })
})

// ── S54 F1 (L4): a valid clause that matches nothing is a WARNING, with the why ──
describe('FilterEditor — zero matches (S54 F1)', () => {
  it('renders 0 records as amber with the "nothing will deploy" wording, never as a green check', async () => {
    installRds(async () => ({ ok: true, count: 0, soql: 'x', strippedClause: null, hint: null }))
    render(
      <FilterEditor
        connectionId="darkb"
        objectName="Account"
        value="Id = '006TR00000gALnoYAG'"
        onChange={vi.fn()}
      />
    )
    const warn = await screen.findByRole('status')
    expect(warn).toHaveTextContent(
      '0 records — nothing will deploy for Account, or for anything scoped under it.'
    )
    expect(warn).toHaveClass('warn')
    expect(screen.queryByText(/✓/)).not.toBeInTheDocument()
  })

  it('shows the diagnosis hint under the amber line', async () => {
    installRds(async () => ({
      ok: true,
      count: 0,
      soql: 'x',
      strippedClause: null,
      hint: '006TR00000gALnoYAG is an Opportunity Id — this filter is on Account, so it can never match.'
    }))
    render(
      <FilterEditor
        connectionId="darkb"
        objectName="Account"
        value="Id = '006TR00000gALnoYAG'"
        onChange={vi.fn()}
      />
    )
    expect(await screen.findByText(/is an Opportunity Id — this filter is on Account/)).toHaveClass(
      'hint'
    )
  })

  it('forwards the target connection id so the main side can probe the target', async () => {
    const spy = vi.fn(async () => ({
      ok: true,
      count: 0,
      soql: 'x',
      strippedClause: null,
      hint: null
    }))
    installRds(spy as unknown as Validate)
    render(
      <FilterEditor
        connectionId="darkb"
        targetConnectionId="sb3"
        objectName="Account"
        value="Id = '001iY000000oCEBQA2'"
        onChange={vi.fn()}
      />
    )
    await screen.findByRole('status')
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: 'darkb',
        targetConnectionId: 'sb3',
        objectName: 'Account'
      })
    )
  })

  it('a positive count is still the green check', async () => {
    installRds(async () => ({ ok: true, count: 1, soql: 'x', strippedClause: null, hint: null }))
    render(
      <FilterEditor
        connectionId="darkb"
        objectName="Account"
        value="Id != null"
        onChange={vi.fn()}
      />
    )
    expect(await screen.findByText(/✓ 1 record$/)).toHaveClass('ok')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// S57 (B3): the verdict is lifted to the Scope step so it can close Next.
describe('FilterEditor — onResult (S57 B3)', () => {
  it('reports busy, then the exact count; null for an empty clause; error for bad SOQL', async () => {
    const seen: Array<[string, unknown]> = []
    const onResult = (obj: string, probe: unknown): void => {
      seen.push([obj, probe])
    }
    installRds(async () => ({ ok: true, count: 0, soql: 'x', strippedClause: null }))
    const { rerender } = render(
      <FilterEditor connectionId="darkb" objectName="Account" value="" onChange={vi.fn()} onResult={onResult} />
    )
    await waitFor(() => expect(seen).toContainEqual(['Account', null]))
    rerender(
      <FilterEditor
        connectionId="darkb"
        objectName="Account"
        value="WHERE Id = '006TR00000gALnoYAG'"
        onChange={vi.fn()}
        onResult={onResult}
      />
    )
    await waitFor(() => expect(seen).toContainEqual(['Account', { kind: 'count', count: 0 }]))
    // (`busy` is transient — with an instantly-resolving mock React batches the
    // loading render away, so it is asserted by the Scope-step gate tests instead.)

    seen.length = 0
    installRds(async () => ({ ok: false, error: 'MALFORMED_QUERY', soql: 'x', strippedClause: null }))
    rerender(
      <FilterEditor connectionId="darkb" objectName="Account" value="WHERE zz" onChange={vi.fn()} onResult={onResult} />
    )
    await waitFor(() => expect(seen).toContainEqual(['Account', { kind: 'error' }]))
  })
})
