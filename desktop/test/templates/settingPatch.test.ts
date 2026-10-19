import { describe, it, expect } from 'vitest'
import { planSettingPatch, settingPatchSoql } from '../../src/main/engine/templates/settingPatch'
import type { SettingPatch } from '../../src/shared/templates/types'

const PREFIX: SettingPatch = {
  label: 'Disable the chat workspace',
  object: 'Acme_Integration_Settings__c',
  field: 'Workspace_Key__c',
  transform: { kind: 'prefix', value: 'SBOFF_' }
}
const SET: SettingPatch = {
  label: 'Clear chat ids',
  object: 'User',
  field: 'Acme_Chat_User_Id__c',
  where: 'Acme_Chat_User_Id__c != null',
  transform: { kind: 'set', value: null },
  optIn: true
}

describe('settingPatch', () => {
  it('builds the row query with and without a WHERE fragment', () => {
    expect(settingPatchSoql(PREFIX)).toBe('SELECT Id, Workspace_Key__c FROM Acme_Integration_Settings__c')
    expect(settingPatchSoql(SET)).toBe('SELECT Id, Acme_Chat_User_Id__c FROM User WHERE Acme_Chat_User_Id__c != null')
  })

  it('prefix: skips blank + already-prefixed rows, truncates to the field length, records undo', () => {
    const plan = planSettingPatch(
      [
        { Id: 'a', Workspace_Key__c: 'T123' },
        { Id: 'b', Workspace_Key__c: 'SBOFF_T456' },
        { Id: 'c', Workspace_Key__c: null },
        { Id: 'd', Workspace_Key__c: '' },
        { Id: 'e', Workspace_Key__c: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }
      ],
      PREFIX,
      25
    )
    expect(plan.updates).toEqual([
      { Id: 'a', Workspace_Key__c: 'SBOFF_T123' },
      { Id: 'e', Workspace_Key__c: 'SBOFF_ABCDEFGHIJKLMNOPQRS' }
    ])
    expect(plan.undo).toEqual([
      { id: 'a', original: 'T123' },
      { id: 'e', original: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' }
    ])
    expect(plan.alreadyPatched).toBe(1)
    expect(plan.blank).toBe(2)
  })

  it('set: skips rows already holding the value (null included)', () => {
    const plan = planSettingPatch(
      [
        { Id: 'a', Acme_Chat_User_Id__c: 'U1' },
        { Id: 'b', Acme_Chat_User_Id__c: null }
      ],
      SET,
      null
    )
    expect(plan.updates).toEqual([{ Id: 'a', Acme_Chat_User_Id__c: null }])
    expect(plan.undo).toEqual([{ id: 'a', original: 'U1' }])
    expect(plan.alreadyPatched).toBe(1)
    const bool = planSettingPatch(
      [{ Id: 'x', F__c: true }, { Id: 'y', F__c: false }],
      { label: 'l', object: 'O', field: 'F__c', transform: { kind: 'set', value: true } },
      null
    )
    expect(bool.updates).toEqual([{ Id: 'y', F__c: true }])
  })

  it('rows without an Id are ignored', () => {
    expect(planSettingPatch([{ Workspace_Key__c: 'x' }], PREFIX, null).updates).toEqual([])
  })
})
