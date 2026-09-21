# Golden transform fixtures (E4X.2)

Byte-faithful captures of the **frozen Apex** deploy engine's per-record
transform, used to prove the TS transform port (E4X.3) is identical.

## What a fixture is

`test/golden/<object>/<sourceId>.json`:

```jsonc
{
  "object": "Account",
  "sourceId": "0011K00002GwMRVQA3",
  "captureId": "gc-<uuid>",              // provenance only; never compared
  "input":   { "Id": "...", "Name": "..." },   // raw source record (incl. attributes)
  "context": { ...TransformContext... },        // the EXACT ctx the queueable built
  "outcome": { "payload": {...}|null, "skipped": false,
               "skipReason": null, "droppedPicklistValues": {} }
}
```

Files are canonical (sorted keys + sorted Set-sourced lists via
`serializeFixture`), so re-capturing the same inputs yields byte-identical files.

## How they are produced

`npm run golden:capture` (see `scripts/golden-capture.ts`). It clones a template
deployment, runs the in-org analysis, then drives the engine's own
`transformRecordV3` against the exact `TransformContext` via the behavior-neutral
`GoldenCaptureService` hook — never a rebuilt context (that would risk
"false-green" goldens; deployDesign §3.2 G7). Capture is DRY — nothing is written
to the target org.

**Prerequisite (dev only):** set
`RDS_App_Setting__mdt.Default.Golden_Capture_Enabled__c = true` for the capture
session, then set it back to `false`. It is the hard production safety gate.

## How they are consumed

The E4X.3 replay suite calls `loadGoldenFixtures()` (`loader.ts`), feeds each
`input` + `context` through the TS `transformRecordV3`, and asserts
`compareOutcome(fixture.outcome, replayed)` is empty. Comparison is parsed-JSON
deep-equal, with Set-sourced lists compared as sorted multisets and
`skipReason` / picklist-drop keys byte-exact (§5 traps 3/20).

Until a live capture runs, this tree holds only `.gitkeep`; the replay suite
skips rather than false-passing.

## Scope

Captures the first-pass `transformRecordV3` — its **only** call site is
`DataDeploymentQueueable.executeNormalModeV2` (verified), covering both the REST
and Bulk branches (the hook sits before the API split). The second-pass
(`executeSecondPassV2`) and junction (`executeJunctionDeploy`) paths do **not**
call `transformRecordV3` and are separate port items (P21/P22) with their own
goldens later — they are intentionally out of scope here, not a gap.

