import type { RdsApi } from '../../shared/types'

declare global {
  interface Window {
    rds: RdsApi
  }
}

export {}
