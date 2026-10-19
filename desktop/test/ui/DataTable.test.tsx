// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, within, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DataTable, type Column } from '../../src/renderer/src/ui/DataTable'

interface Row {
  id: string
  name: string
  count: number
}

const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', sortValue: (r) => r.name },
  { key: 'count', header: 'Count', sortValue: (r) => r.count, align: 'right' }
]

afterEach(cleanup)

function bodyNames(): string[] {
  const rows = screen.getAllByRole('row').slice(1) // drop header
  return rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent ?? '')
}

describe('DataTable', () => {
  it('renders rows and an empty state', () => {
    const { unmount } = render(
      <DataTable rows={[]} columns={cols} rowKey={(r) => r.id} empty="Nothing here" />
    )
    expect(screen.getByText('Nothing here')).toBeInTheDocument()
    unmount()
  })

  it('sorts ascending then descending on header click', async () => {
    const user = userEvent.setup()
    const rows: Row[] = [
      { id: 'a', name: 'Charlie', count: 3 },
      { id: 'b', name: 'Alpha', count: 1 },
      { id: 'c', name: 'Bravo', count: 2 }
    ]
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} />)
    // unsorted = insertion order
    expect(bodyNames()).toEqual(['Charlie', 'Alpha', 'Bravo'])
    await user.click(screen.getByText('Name'))
    expect(bodyNames()).toEqual(['Alpha', 'Bravo', 'Charlie'])
    await user.click(screen.getByText('Name'))
    expect(bodyNames()).toEqual(['Charlie', 'Bravo', 'Alpha'])
  })

  it('sorts numerically by a numeric sortValue (not lexically)', async () => {
    const user = userEvent.setup()
    const rows: Row[] = [
      { id: 'a', name: 'A', count: 10 },
      { id: 'b', name: 'B', count: 2 },
      { id: 'c', name: 'C', count: 1 }
    ]
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} />)
    await user.click(screen.getByText('Count'))
    expect(bodyNames()).toEqual(['C', 'B', 'A']) // 1,2,10 — numeric, not "1,10,2"
  })

  it('paginates when rows exceed pageSize', async () => {
    const user = userEvent.setup()
    const rows: Row[] = Array.from({ length: 30 }, (_, i) => ({
      id: `r${i}`,
      name: `Row ${String(i).padStart(2, '0')}`,
      count: i
    }))
    render(<DataTable rows={rows} columns={cols} rowKey={(r) => r.id} pageSize={10} />)
    expect(bodyNames()).toHaveLength(10)
    expect(screen.getByText(/Page 1 of 3/)).toBeInTheDocument()
    expect(bodyNames()[0]).toBe('Row 00')
    await user.click(screen.getByText('Next'))
    expect(screen.getByText(/Page 2 of 3/)).toBeInTheDocument()
    expect(bodyNames()[0]).toBe('Row 10')
  })
})
