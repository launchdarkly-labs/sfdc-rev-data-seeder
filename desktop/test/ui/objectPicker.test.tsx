// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { ObjectPicker, filterObjects } from '../../src/renderer/src/ui/ObjectPicker'
import type { DeployableObject } from '../../src/shared/types'

afterEach(cleanup)

function o(apiName: string, opts: Partial<DeployableObject> = {}): DeployableObject {
  return {
    apiName,
    label: apiName,
    custom: apiName.endsWith('__c'),
    namespace: apiName.split('__').length >= 3 ? apiName.split('__')[0]! : null,
    inSource: true,
    inTarget: true,
    ...opts
  }
}

const OBJECTS: DeployableObject[] = [
  o('Account'),
  o('Contact'),
  o('Legacy__c'),
  o('SBQQ__Quote__c'),
  o('SBQQ__QuoteLine__c'),
  o('OnlySource__c', { inTarget: false }),
  o('OnlyTarget__c', { inSource: false })
]

describe('filterObjects (pure)', () => {
  const base = { search: '', type: 'all' as const, deployableOnly: true }

  it('shows only deployable objects by default', () => {
    const r = filterObjects(OBJECTS, base).map((x) => x.apiName)
    expect(r).not.toContain('OnlySource__c')
    expect(r).not.toContain('OnlyTarget__c')
    expect(r).toContain('Account')
  })

  it('deployableOnly=false includes one-sided objects', () => {
    const r = filterObjects(OBJECTS, { ...base, deployableOnly: false }).map((x) => x.apiName)
    expect(r).toContain('OnlySource__c')
  })

  it('standard filter = non-custom, non-namespaced', () => {
    expect(filterObjects(OBJECTS, { ...base, type: 'standard' }).map((x) => x.apiName)).toEqual([
      'Account',
      'Contact'
    ])
  })

  it('custom filter = custom, non-namespaced', () => {
    expect(filterObjects(OBJECTS, { ...base, type: 'custom' }).map((x) => x.apiName)).toEqual([
      'Legacy__c'
    ])
  })

  it('namespace filter = that namespace only', () => {
    expect(
      filterObjects(OBJECTS, { ...base, type: { namespace: 'SBQQ' } }).map((x) => x.apiName)
    ).toEqual(['SBQQ__Quote__c', 'SBQQ__QuoteLine__c'])
  })

  it('search matches api name or label, case-insensitive', () => {
    expect(filterObjects(OBJECTS, { ...base, search: 'quoteline' }).map((x) => x.apiName)).toEqual([
      'SBQQ__QuoteLine__c'
    ])
    expect(filterObjects(OBJECTS, { ...base, search: 'acc' }).map((x) => x.apiName)).toEqual([
      'Account'
    ])
  })

  it('combines search + type', () => {
    expect(
      filterObjects(OBJECTS, { ...base, type: { namespace: 'SBQQ' }, search: 'line' }).map(
        (x) => x.apiName
      )
    ).toEqual(['SBQQ__QuoteLine__c'])
  })

  it('empty result when nothing matches', () => {
    expect(filterObjects(OBJECTS, { ...base, search: 'zzz' })).toEqual([])
  })
})

function Harness(): React.JSX.Element {
  const [selected, setSelected] = useState<string[]>([])
  return (
    <>
      <div data-testid="selected">{selected.join(',')}</div>
      <ObjectPicker objects={OBJECTS} selected={selected} onChange={setSelected} />
    </>
  )
}

describe('ObjectPicker component', () => {
  it('toggles a single object', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Account'))
    expect(screen.getByTestId('selected')).toHaveTextContent('Account')
  })

  it('select-all-shown only affects the currently-visible (filtered) rows', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    // Filter to the SBQQ namespace, then select all shown. S49 (UI-2b): the
    // package filter is a right-hand panel row now, and its accessible name
    // carries the count alongside the label.
    await user.click(screen.getByRole('button', { name: 'SBQQ (2)' }))
    await user.click(screen.getByRole('button', { name: /Select all shown \(2\)/ }))
    const sel = screen.getByTestId('selected').textContent!.split(',')
    expect(sel).toHaveLength(2)
    expect(sel).toContain('SBQQ__Quote__c')
    expect(sel).toContain('SBQQ__QuoteLine__c')
    // Account was not visible under the filter, so it stayed unselected.
    expect(sel).not.toContain('Account')
  })

  it('clear removes all selections', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Account'))
    await user.click(screen.getByText('Contact'))
    await user.click(screen.getByRole('button', { name: /Clear \(2\)/ }))
    expect(screen.getByTestId('selected')).toHaveTextContent('')
  })

  it('never lists one-sided (non-deployable) objects', () => {
    render(<Harness />)
    // S49 (UI-2b): two lists now — the object list and the package panel.
    const list = screen.getByRole('list', { name: 'Objects' })
    expect(within(list).queryByText('OnlySource__c')).not.toBeInTheDocument()
    expect(within(list).queryByText('OnlyTarget__c')).not.toBeInTheDocument()
  })
})

// S57 (B4): warn at selection time about objects the seeder can never key.
describe('ObjectPicker — S57 B4 no-custom-fields badge', () => {
  it('badges CampaignMemberStatus and nothing else', () => {
    render(
      <ObjectPicker
        objects={[o('Account'), o('CampaignMemberStatus')]}
        selected={[]}
        onChange={() => undefined}
      />
    )
    const rows = screen.getAllByRole('listitem')
    const cms = rows.find((r) => within(r).queryByText('CampaignMemberStatus'))!
    expect(within(cms).getByText(/no custom fields — can't be keyed/)).toBeInTheDocument()
    const acct = rows.find((r) => within(r).queryByText('Account'))!
    expect(within(acct).queryByText(/can't be keyed/)).not.toBeInTheDocument()
  })
})
