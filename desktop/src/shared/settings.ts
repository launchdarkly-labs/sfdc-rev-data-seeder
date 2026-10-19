/**
 * Per-key validation for the allow-listed renderer settings (S64 P4 `theme`,
 * P6 `prodOrgIdPrefix`). The IPC handler calls this before writing; it returns
 * the value to store or throws an Error whose message is shown to the user.
 */
import type { SettingKey } from './types'
import { normalizeProdOrgIdPrefix, PROD_PIN_SETTING_KEY } from './prodPin'

/** Every setting is a short string — the ceiling the P4 handler already enforced. */
export const SETTING_VALUE_MAX = 64

export function normalizeSettingValue(key: SettingKey, value: unknown): string {
  if (typeof value !== 'string' || value.length > SETTING_VALUE_MAX) {
    throw new Error('Setting values are short strings')
  }
  if (key === PROD_PIN_SETTING_KEY) {
    const prefix = normalizeProdOrgIdPrefix(value)
    if (!prefix) {
      throw new Error(
        'A production pin must be a Salesforce Org Id: 00D followed by 12 letters or digits (15 characters), or the 18-character form.'
      )
    }
    return prefix
  }
  return value
}
