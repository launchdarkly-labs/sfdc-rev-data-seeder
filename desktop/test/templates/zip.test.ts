import { describe, it, expect } from 'vitest'
import { buildZip, crc32, readStoredZip } from '../../src/main/engine/templates/zip'
import { buildTriggerStatusZip, packageXml, triggerMetaXml } from '../../src/main/engine/templates/triggerStatus'

describe('zip writer', () => {
  it('crc32 matches the known vector', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926')
    expect(crc32(new Uint8Array())).toBe(0)
  })

  it('writes stored entries that read back byte-exact, with the right signatures', () => {
    const zip = buildZip([
      { path: 'a.txt', data: 'hello' },
      { path: 'dir/b.bin', data: new Uint8Array([0, 1, 2, 255]) }
    ])
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
    expect(view.getUint32(0, true)).toBe(0x04034b50)
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50)
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2) // total entries
    const back = readStoredZip(zip)
    expect(new TextDecoder().decode(back.get('a.txt'))).toBe('hello')
    expect([...back.get('dir/b.bin')!]).toEqual([0, 1, 2, 255])
  })
})

describe('trigger status metadata zip', () => {
  it('builds the trigger, its meta xml with the status, and a package.xml', () => {
    const zip = buildTriggerStatusZip(
      [{ id: '01q1', name: 'AcmeOrderSync', body: 'trigger AcmeOrderSync on Order (after insert) {}', apiVersion: 62, status: 'Active' }],
      'Inactive'
    )
    const files = readStoredZip(zip)
    const dec = new TextDecoder()
    expect([...files.keys()].sort()).toEqual([
      'package.xml',
      'triggers/AcmeOrderSync.trigger',
      'triggers/AcmeOrderSync.trigger-meta.xml'
    ])
    expect(dec.decode(files.get('triggers/AcmeOrderSync.trigger-meta.xml'))).toBe(triggerMetaXml(62, 'Inactive'))
    expect(dec.decode(files.get('triggers/AcmeOrderSync.trigger-meta.xml'))).toContain('<status>Inactive</status>')
    expect(dec.decode(files.get('triggers/AcmeOrderSync.trigger-meta.xml'))).toContain('<apiVersion>62.0</apiVersion>')
    expect(dec.decode(files.get('package.xml'))).toBe(packageXml(['AcmeOrderSync'], 66))
    expect(dec.decode(files.get('package.xml'))).toContain('<name>ApexTrigger</name>')
  })
})
