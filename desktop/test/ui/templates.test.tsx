// @vitest-environment jsdom
/**
 * S59 — the Templates list (/templates): every kind listed, type filter,
 * wizard kinds read-only (Rename / Delete only), runnable kinds with Edit /
 * Run / Duplicate / Export, import + sample buttons wired.
 */
import '@testing-library/jest-dom/vitest'
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { TemplatesPage } from '../../src/renderer/src/pages/templates/TemplatesPage'
import { ToastProvider } from '../../src/renderer/src/ui/Toast'
import { ConfirmProvider } from '../../src/renderer/src/ui/ConfirmDialog'
import type { TemplateSummary } from '../../src/shared/templates/types'

function summary(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    id: 1,
    kind: 'seed',
    name: 'Seed A',
    description: null,
    builtFrom: null,
    detail: '3 objects',
    seedGroups: ['default'],
    cpqGatedObjects: [],
    createdAt: 1,
    updatedAt: 2,
    lastRun: null,
    ...over
  }
}

const ROWS: TemplateSummary[] = [
  summary({ id: 1, kind: 'seed', name: 'Acme CPQ configuration', description: 'the config seed', builtFrom: { orgId: '00D1', label: 'src' } }),
  summary({
    id: 2,
    kind: 'postRefresh',
    name: 'Acme dev sandbox',
    detail: '3 flows, 2 triggers, 1 seed template',
    lastRun: { runId: 9, mode: 'dry-run', state: 'clean', targetLabel: 'sb3', startedAt: 5 }
  }),
  summary({ id: 3, kind: 'objects', name: 'Core objects', detail: '11 objects (wizard)' })
]

let imported: TemplateSummary[] | null
let exported: number[]
let sampled: string[]

beforeEach(() => {
  imported = [summary({ id: 7, name: 'Imported' })]
  exported = []
  sampled = []
  ;(window as unknown as { rds: unknown }).rds = {
    templateListAll: vi.fn(async () => ROWS),
    templateImport: vi.fn(async () => imported),
    templateExport: vi.fn(async (id: number) => {
      exported.push(id)
      return '/tmp/x.json'
    }),
    templateSample: vi.fn(async (kind: string) => {
      sampled.push(kind)
      return summary({ id: 8, name: 'Sample' })
    }),
    templateRename: vi.fn(async () => undefined),
    templateDelete: vi.fn(async () => undefined),
    templateGet: vi.fn(async () => ({ ...ROWS[0], payload: {} })),
    templateSaveRunnable: vi.fn(async () => summary({ id: 9, name: 'Acme CPQ configuration (copy)' }))
  }
})
afterEach(cleanup)

function renderPage(): void {
  render(
    <ToastProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/templates']}>
          <Routes>
            <Route path="/templates" element={<TemplatesPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </ToastProvider>
  )
}

describe('TemplatesPage', () => {
  it('lists every kind with type badges, contents, built-from and the last run', async () => {
    renderPage()
    const table = await screen.findByRole('table', { name: 'Templates' })
    expect(within(table).getAllByRole('row')).toHaveLength(4) // header + 3
    expect(within(table).getByText('Data seed')).toBeInTheDocument()
    expect(within(table).getByText('Post-refresh')).toBeInTheDocument()
    expect(within(table).getByText('Objects')).toBeInTheDocument()
    expect(within(table).getByText('the config seed')).toBeInTheDocument()
    expect(within(table).getByText('src')).toBeInTheDocument()
    expect(within(table).getByText('clean')).toBeInTheDocument()
    expect(within(table).getByText(/dry-run · sb3/)).toBeInTheDocument()
  })

  it('wizard kinds get Rename + Delete only; runnable kinds get Edit / Run / Duplicate / Export too', async () => {
    renderPage()
    await screen.findByRole('table', { name: 'Templates' })
    const wizardRow = screen.getByTestId('template-3')
    expect(within(wizardRow).queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(within(wizardRow).queryByRole('button', { name: 'Run' })).toBeNull()
    expect(within(wizardRow).getByRole('button', { name: 'Rename' })).toBeInTheDocument()
    expect(within(wizardRow).getByRole('button', { name: 'Delete' })).toBeInTheDocument()
    const seedRow = screen.getByTestId('template-1')
    expect(within(seedRow).getByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(within(seedRow).getByRole('button', { name: 'Run' })).toBeInTheDocument()
    expect(within(seedRow).getByRole('button', { name: 'Duplicate' })).toBeInTheDocument()
    expect(within(seedRow).getByRole('button', { name: 'Export…' })).toBeInTheDocument()
  })

  it('filters by type', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('table', { name: 'Templates' })
    await user.selectOptions(screen.getByLabelText('Type filter'), 'postRefresh')
    const table = screen.getByRole('table', { name: 'Templates' })
    expect(within(table).getAllByRole('row')).toHaveLength(2)
    expect(within(table).getByText('Acme dev sandbox')).toBeInTheDocument()
  })

  it('Import, Export and the sample buttons call main and report', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('table', { name: 'Templates' })
    await user.click(screen.getByRole('button', { name: 'Import…' }))
    expect(await screen.findByText(/Imported 1 template: Imported/)).toBeInTheDocument()
    await user.click(within(screen.getByTestId('template-1')).getByRole('button', { name: 'Export…' }))
    expect(exported).toEqual([1])
    expect(await screen.findByText(/Exported "Acme CPQ configuration" to \/tmp\/x.json/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'New from sample: Post-refresh' }))
    expect(sampled).toEqual(['postRefresh'])
  })

  it('Delete asks first and says nothing in any org changes', async () => {
    const user = userEvent.setup()
    renderPage()
    await screen.findByRole('table', { name: 'Templates' })
    await user.click(within(screen.getByTestId('template-3')).getByRole('button', { name: 'Delete' }))
    expect(screen.getByRole('dialog')).toHaveTextContent(/Nothing in any org changes/)
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    expect((window as unknown as { rds: { templateDelete: ReturnType<typeof vi.fn> } }).rds.templateDelete).toHaveBeenCalledWith(3)
  })
})
