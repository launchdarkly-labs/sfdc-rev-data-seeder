/// <reference types="vite/client" />
import type { RdsApi } from '../../shared/types'

declare global {
  interface Window {
    rds: RdsApi
  }
  /** Injected by electron-vite / vitest `define` from package.json (S64 P4). */
  const __APP_VERSION__: string
}

export {}
