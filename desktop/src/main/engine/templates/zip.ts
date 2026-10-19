/**
 * Minimal ZIP writer — STORED entries only (no compression), CRC-32, local
 * file headers + central directory + end record. ~80 lines, no dependency.
 * Exists for ONE caller: the file-based Metadata API deploy that sets an Apex
 * trigger's status (S59 plan §4.3 spike #2). A Metadata deploy zip is a
 * handful of small text files; compression would buy nothing.
 */

const CRC_TABLE = ((): Uint32Array => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** Forward-slash path inside the archive. */
  path: string
  data: Uint8Array | string
}

function u16(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff]
}
function u32(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]
}

/** DOS date/time pair for the header (a fixed, valid timestamp — content is what matters). */
const DOS_TIME = u16(0)
const DOS_DATE = u16(((2026 - 1980) << 9) | (1 << 5) | 1)

export function buildZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const enc = new TextEncoder()
  const locals: number[] = []
  const central: number[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.path)
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data
    const crc = crc32(data)
    const local = [
      ...u32(0x04034b50),
      ...u16(20), // version needed
      ...u16(0x0800), // flags: UTF-8 names
      ...u16(0), // method: stored
      ...DOS_TIME,
      ...DOS_DATE,
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0),
      ...name,
      ...data
    ]
    central.push(
      ...u32(0x02014b50),
      ...u16(20), // version made by
      ...u16(20),
      ...u16(0x0800),
      ...u16(0),
      ...DOS_TIME,
      ...DOS_DATE,
      ...u32(crc),
      ...u32(data.length),
      ...u32(data.length),
      ...u16(name.length),
      ...u16(0), // extra
      ...u16(0), // comment
      ...u16(0), // disk
      ...u16(0), // internal attrs
      ...u32(0), // external attrs
      ...u32(offset),
      ...name
    )
    locals.push(...local)
    offset += local.length
  }
  const end = [
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(central.length),
    ...u32(offset),
    ...u16(0)
  ]
  return Uint8Array.from([...locals, ...central, ...end])
}

/** Read back a STORED zip written by buildZip (tests only — proves the layout). */
export function readStoredZip(zip: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>()
  const dec = new TextDecoder()
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let p = 0
  while (p + 30 <= zip.length && view.getUint32(p, true) === 0x04034b50) {
    const size = view.getUint32(p + 18, true)
    const nameLen = view.getUint16(p + 26, true)
    const extraLen = view.getUint16(p + 28, true)
    const name = dec.decode(zip.subarray(p + 30, p + 30 + nameLen))
    const start = p + 30 + nameLen + extraLen
    out.set(name, zip.subarray(start, start + size))
    p = start + size
  }
  return out
}
