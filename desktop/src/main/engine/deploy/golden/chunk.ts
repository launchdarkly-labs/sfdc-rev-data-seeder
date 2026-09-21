/**
 * Golden-capture chunk codec (E4X.2, deployDesign §3.2 capture step 3).
 *
 * The capture driver (anonymous Apex) serializes each `{input, context, outcome}`
 * batch to one JSON string, then writes it across N throwaway
 * `Deployment_Log__c` rows because a single `Error_Details__c` LongTextArea caps
 * at 131,072 chars (verified in the field metadata). Each row is tagged in
 * `Message__c` with the capture id, the chunk sequence, and the total count so
 * this reassembler can re-order them, detect a dropped/duplicated/foreign row,
 * and concatenate losslessly.
 *
 * Reassembly is deliberately FAIL-LOUD: a short read here would silently corrupt
 * every downstream golden (the Session-29 silent-0/truncation bug class), so any
 * missing chunk, count disagreement, or gap throws rather than returning a
 * partial string.
 *
 * Pure: no jsforce, no fs. The orchestrator fetches the rows (I/O) and hands the
 * raw `{message, errorDetails}` pairs here.
 */

export const GOLDEN_TAG = 'RDS_GOLDEN'

/**
 * Conservative per-row ceiling under the 131,072-char `Error_Details__c` limit.
 * Salesforce LongTextArea length accounting can exceed JS `.length` for
 * multi-byte content, so leave headroom. The Apex driver MUST chunk with the
 * same cap; overridable for tests. (The manifest lives in the separate
 * `Message__c` field, so it does not eat into this budget.)
 */
export const DEFAULT_CHUNK_CHARS = 120_000

export interface CaptureRow {
  /** `Deployment_Log__c.Message__c` — carries the chunk tag (see `buildChunkTag`). */
  message: string | null
  /** `Deployment_Log__c.Error_Details__c` — the chunk payload (SF stores '' as null). */
  errorDetails: string | null
}

interface ChunkTag {
  captureId: string
  seq: number
  total: number
}

/**
 * Split a string into `<= cap`-char pieces, in order, with no data loss. An
 * empty string yields a single empty chunk so the `total >= 1` invariant holds
 * (an empty capture still round-trips to '').
 */
export function chunkString(s: string, cap: number = DEFAULT_CHUNK_CHARS): string[] {
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new Error(`chunkString: cap must be a positive integer, got ${cap}`)
  }
  if (s === '') return ['']
  const out: string[] = []
  for (let i = 0; i < s.length; i += cap) {
    out.push(s.slice(i, i + cap))
  }
  return out
}

/**
 * The single-source manifest format written into `Deployment_Log__c.Message__c`
 * by the Apex driver and parsed back by `parseChunkTag`. Pipe-delimited because
 * the fields (a tag, a UUID, two integers) never contain a pipe.
 */
export function buildChunkTag(captureId: string, seq: number, total: number): string {
  if (captureId.includes('|')) {
    throw new Error(`buildChunkTag: captureId must not contain '|': ${captureId}`)
  }
  return `${GOLDEN_TAG}|${captureId}|${seq}|${total}`
}

export function parseChunkTag(message: string | null): ChunkTag | null {
  if (message == null) return null
  const parts = message.split('|')
  if (parts.length !== 4 || parts[0] !== GOLDEN_TAG) return null
  const captureId = parts[1] ?? ''
  const seq = Number(parts[2])
  const total = Number(parts[3])
  if (captureId === '' || !Number.isInteger(seq) || !Number.isInteger(total)) return null
  if (seq < 0 || total <= 0 || seq >= total) return null
  return { captureId, seq, total }
}

/**
 * Filter the fetched rows to the given capture, order them by sequence, verify
 * completeness (exactly `0..total-1`, each once), and concatenate. Throws on any
 * integrity violation — never returns a partial string.
 */
export function reassembleChunks(rows: CaptureRow[], captureId: string): string {
  const mine: Array<{ tag: ChunkTag; body: string }> = []
  for (const row of rows) {
    const tag = parseChunkTag(row.message)
    if (tag == null || tag.captureId !== captureId) continue
    mine.push({ tag, body: row.errorDetails ?? '' })
  }
  if (mine.length === 0) {
    throw new Error(`reassembleChunks: no chunks found for capture '${captureId}'`)
  }
  const total = mine[0]!.tag.total
  const bySeq = new Map<number, string>()
  for (const { tag, body } of mine) {
    if (tag.total !== total) {
      throw new Error(
        `reassembleChunks: chunk total disagreement for '${captureId}' ` +
          `(${tag.total} vs ${total}) — mixed or corrupt capture rows`
      )
    }
    if (bySeq.has(tag.seq)) {
      throw new Error(`reassembleChunks: duplicate chunk seq ${tag.seq} for '${captureId}'`)
    }
    bySeq.set(tag.seq, body)
  }
  if (bySeq.size !== total) {
    const missing: number[] = []
    for (let i = 0; i < total; i++) if (!bySeq.has(i)) missing.push(i)
    throw new Error(
      `reassembleChunks: expected ${total} chunks for '${captureId}', got ${bySeq.size} ` +
        `(missing seq: ${missing.join(', ') || 'none — extra/dup rows'})`
    )
  }
  let out = ''
  for (let i = 0; i < total; i++) out += bySeq.get(i)!
  return out
}
