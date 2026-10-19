# Salesforce Platform Knowledge Base — V2 (Spring '26 / API v66.0)

**Companion / successor to** `SFDC_Platform_Knowledge_Base.md`.
**Date:** 2026-05-11.
**Scope:** Spring '26 (API v66.0). Cross-org CPQ + Sales data migration app (Rev Data Seeder).

This file is structured as **deltas + additions to the V1 KB**, organized by V1 section number. Read this file alongside V1. Where this file says "supersedes V1 section X," prefer this file.

The platform numbers and patterns here come from:
- `api_rest.pdf` (REST API, v66.0)
- `api_tooling.pdf` (Tooling API, v66.0)
- `api_asynch.pdf` (Bulk API 2.0, v66.0)
- `api_meta.pdf` (Metadata API, v66.0)
- `object_reference.pdf` (Standard Objects)
- `salesforce_soql_sosl.pdf` (SOQL)
- `salesforce_apex_developer_guide.pdf` (Apex)
- `salesforce_app_limits_cheatsheet.pdf` (Updated 2026-04-03)

---

# TABLE OF CONTENTS

- [Critical platform-tightening regressions (read first)](#critical-platform-tightening-regressions-read-first)
- [Section 3 — Relationships (deltas)](#section-3--relationships-deltas)
- [Section 4 — SOQL (deltas)](#section-4--soql-deltas)
- [Section 6 — Async Apex (deltas + new patterns)](#section-6--async-apex-deltas--new-patterns)
- [Section 7 — Governor Limits (corrected + additions)](#section-7--governor-limits-corrected--additions)
- [Section 12 — REST API (deltas)](#section-12--rest-api-deltas)
- [Section 13 — Bulk API 2.0 (deltas)](#section-13--bulk-api-20-deltas)
- [Section 14 — Metadata API (deltas)](#section-14--metadata-api-deltas)
- [Section 15 — Tooling API (deltas)](#section-15--tooling-api-deltas)
- [Section 10 — Security (deltas)](#section-10--security-deltas)
- [Section 17 — CPQ / SBQQ (deltas)](#section-17--cpq--sbqq-deltas)
- [Section 19 — Packaging 2GP (deltas)](#section-19--packaging-2gp-deltas)
- [Section 20 — Standard Objects insert-order matrix](#section-20--standard-objects-insert-order-matrix)
- [Section 21 — Cross-Org Migration Patterns (deltas)](#section-21--cross-org-migration-patterns-deltas)
- [New Section — Apex Testing Patterns](#new-section--apex-testing-patterns)

---

## Critical platform-tightening regressions (read first)

These are real, recently-discovered behaviors that **silently break code written against older specs**. They affect this project today.

### 1. `Metadata` PATCH on `ValidationRule` (and any `XxxMetadata` shape) now rejects partial payloads

**Symptom:** `Required field is missing: errorConditionFormula` on a PATCH that sets only `Metadata.active`.

**Rule:** Always GET the full `Metadata` object first, mutate in-place, PATCH back the complete object.

```http
GET  /services/data/v66.0/tooling/sobjects/ValidationRule/{id}
PATCH /services/data/v66.0/tooling/sobjects/ValidationRule/{id}
{ "Metadata": { /* FULL prior object, with `active` flipped */ } }
```

Same pattern almost certainly applies to **FlowDefinition.Metadata**, **CustomField.Metadata**, **ApexTriggerMember.Metadata** — every `Metadata` field with `Properties: Create, Nillable, Update`. Use the GET-mutate-PATCH-full idiom universally.

### 2. Tooling REST PATCH/DELETE blocked on ApexClass/Trigger/Page/Component/CustomField/CustomObject in production-like sandboxes

**Symptom:** `INVALID_TYPE: This type of object is not available for this organization` on a direct PATCH/POST to `/tooling/sobjects/ApexTrigger/{id}`. Sysadmin perms + Modify Metadata + Customize Application don't help.

**Rule:** Use the **MetadataContainer + xxxMember + ContainerAsyncRequest** pattern (the canonical IDE workflow). See Section 15 below for the full sequence.

The 6 objects blocked in active orgs: `ApexClass`, `ApexComponent`, `ApexPage`, `ApexTrigger`, `CustomField`, `CustomObject`.

### 3. `DuplicateRule` is not a Tooling API object

`SELECT ... FROM DuplicateRule` works via REST, but PATCH on `/tooling/sobjects/DuplicateRule/{id}` returns `INVALID_TYPE`. The Tooling `DuplicateJobDefinition` / `DuplicateJobMatchingRuleDefinition` objects are about detection *jobs*, not the declarative rule.

**Canonical path to toggle DuplicateRule active state:** Metadata API SOAP `readMetadata` → string-edit `<isActive>` → `updateMetadata`. Batches of 10. The project's `DuplicateRuleService.cls` already implements this.

### 4. Custom Setting deletion via destructiveChanges.xml may throw `INSUFFICIENT_ACCESS: EntityObject can not be initialized with null EntityInfo`

**Workaround:** Delete Custom Settings through Setup → Object Manager → Delete. The Metadata API path is unreliable regardless of permissions.

### 5. OAuth session tokens cache permission state until refreshed

If you grant a permission set (FLS or otherwise) programmatically and immediately call REST/Bulk/Tooling, the token may still reflect the pre-grant permissions. Symptom: `INVALID_FIELD: No such column 'X'` even though the field exists and the user *now* has FLS.

**Rule:** Always call `OrgConnectionService.refreshSession(orgConnectionId)` after permission changes. Never rely on the existing token to see the new grant.

### 6. MetadataContainer + ApexTriggerMember pattern is idempotent — but reports `succeeded=0` when no change was needed

If you submit a trigger body identical to the current body, no deploy happens and the response looks like a failure. Distinguish "already in target state" from "actually failed" via a typed result (the project's `ApexTriggerBodyToggleService.ToggleResult`).

---

## Section 3 — Relationships (deltas)

### State-machine-conditional master-detail (new concept)

Several standard objects have lookups that are **required-on-create but locked-after-state-X**:

| Object | Field | Locked when |
|---|---|---|
| Order | AccountId, ContractId | StatusCode ≠ Draft |
| Contract | AccountId | After Activated |
| OrderItem | PricebookEntryId | Always (cannot change in update) |
| PricebookEntry | Pricebook2Id, Product2Id | Always |
| Opportunity | Pricebook2Id, CurrencyIsoCode | Once OLIs exist |

Treat these as "soft master-detail with a state gate" — the loader must insert them in the unlocked state, then transition state in a second pass.

### Auto-population side effects to flag in any idempotent loader

These platform behaviors will fight a second-pass upsert:

- **First OLI auto-sets `Opportunity.Pricebook2Id`** (and locks it + `CurrencyIsoCode`).
- **First `OpportunityContactRole` with `IsPrimary=true`** sets `Opportunity.ContactId` (and `Contact.AccountId` if blank).
- **Inserting a PersonAccount auto-creates a Contact** — inserting a Contact for that Account fails with `PERSON_ACCOUNT_CONTACT_EXISTS`.
- **`SBQQ__Quote__c.SBQQ__Account__c`** auto-derives from `SBQQ__Opportunity2__c` on insert if not set.
- **Activated transitions stamp `ActivatedById` / `ActivatedDate`** — these are read-only after.

### `OwnerId` polymorphism

`Order.OwnerId` and `Case.OwnerId` can be `User` OR `Group` (queue). Most other `OwnerId` fields are User-only. Inspect the source ID's key prefix before resolving.

### Self-reference field types

- `User.ManagerId`, `User.DelegatedApproverId` — **Hierarchical** relationship type (User-only quirk).
- Custom self-references — regular `Lookup` type.

### Cascade-on-parent-archive (not delete)

PricebookEntry is *archived* (not deleted) when its parent Pricebook2 or Product2 is archived. PricebookEntry **cannot be hard-deleted**, ever — only `IsActive=false`. Loaders must treat PBE as "insert-or-update-but-never-delete."

---

## Section 4 — SOQL (deltas)

### Prefer `WITH USER_MODE` over `WITH SECURITY_ENFORCED`

Salesforce now explicitly recommends `WITH USER_MODE` (and `WITH SYSTEM_MODE`) over the older `WITH SECURITY_ENFORCED`. Fewer restrictions on use within polymorphic and aggregate queries.

```apex
List<Account> accts = [SELECT Id, Name FROM Account WITH USER_MODE];
```

### Long-text custom field batch-size penalty

If your dynamic SOQL selects **2 or more custom long-text fields**, the SOAP API caps batch size at **200**, not 2,000. For a `queryLocator` over 50,000 records this means 250 round-trips instead of 25. Flag long-text fields before building a `getQueryLocator`.

### OFFSET is a dead-end at scale

- Max OFFSET is **2,000** rows (`NUMBER_OUTSIDE_VALID_RANGE` past that).
- OFFSET is **not supported in Bulk API or Streaming API SOQL** — REST/SOAP/Apex only.
- For >2,000 rows use keyset pagination:

```sql
SELECT Id FROM Account WHERE Id > :lastId ORDER BY Id LIMIT 2000
```

…or use `queryMore()` / Bulk Query locators.

### 4,000-char WHERE limit has an Apex+IN exception

```apex
// WORKS in Apex (IN binds large sets without hitting the 4000-char WHERE limit):
List<Account> a = [SELECT Id FROM Account WHERE Migration_Id__c IN :largeIdSet];

// FAILS at scale (4000-char WHERE limit applies when building SOQL string-side):
String q = 'SELECT Id FROM Account WHERE Migration_Id__c IN (' + commaList + ')';
Database.query(q);  // breaks around 150 IDs
```

### Cannot combine `ORDER BY` with `FOR UPDATE`

Throws `MALFORMED_QUERY`. If you need both, separate into a query for the locked set and a second pass for ordering.

### TYPEOF restrictions

TYPEOF on polymorphic fields **cannot** be combined with: `COUNT()`, `GROUP BY` (including `ROLLUP`/`CUBE`), `HAVING`, Bulk API, Streaming API PushTopics, semi-join inner queries, or `FORMAT()` in SELECT. TYPEOF cannot be nested.

### Multi-select picklist semantics

- `=` matches by **exact semicolon-joined value**: `WHERE Tags__c = 'AAA;BBB'`.
- `INCLUDES (val1, val2)` matches if any value is present.
- `EXCLUDES` is the inverse.

### `WHERE Field__c = null` for booleans = `WHERE Field__c = false`

Counterintuitive but documented. Useful when a Boolean was created from a Checkbox with no default.

### NULL parent in relationship-traversal WHERE

`WHERE Contact.LastName = null` returns Cases with **no Contact** (not just Cases whose Contact has a null LastName). Important when filtering across optional lookups.

### `FIELDS()` is forbidden in Apex and Bulk

`SELECT FIELDS(ALL) FROM Account` works in REST query and Workbench but **errors in Apex and Bulk API**. Use dynamic Schema describe to build field lists.

---

## Section 6 — Async Apex (deltas + new patterns)

### `System.AsyncInfo` is the canonical depth/stack inspection API

Replaces hand-rolled static flags. Methods:

```apex
System.AsyncInfo.hasMaxStackDepth();
System.AsyncInfo.getCurrentQueueableStackDepth();
System.AsyncInfo.getMaximumQueueableStackDepth();
System.AsyncInfo.getMinimumQueueableDelayInMinutes();
```

### `AsyncOptions` for typed queueable submission

```apex
AsyncOptions opts = new AsyncOptions();
opts.MaximumQueueableStackDepth = 5;
opts.MinimumQueueableDelayInMinutes = 1;  // 0..10
opts.DuplicateSignature = QueueableDuplicateSignature.Builder
    .addString('deploymentId').addId(deploymentId).build();
System.enqueueJob(new MyQueueable(), opts);
```

`DuplicateSignature` is the right fix for races where the same queueable could be enqueued twice — throws `DuplicateMessageException` instead of running twice.

### `System.enqueueJob(queueable, delay)` (delay in minutes 0-10)

Cleaner than `System.schedule` for delays of 1-10 minutes. Ignored in tests.

For sub-minute delays you still need `System.schedule(name, cron, batch)` or `System.scheduleBatch(batch, name, 1)`.

### Transaction Finalizers (the right answer to "silent errors")

```apex
public class MyQueueable implements Queueable {
    public void execute(QueueableContext ctx) {
        System.attachFinalizer(new MyFinalizer());
        // ...
    }
}

public class MyFinalizer implements Finalizer {
    public void execute(FinalizerContext fc) {
        if (fc.getResult() == ParentJobResult.UNHANDLED_EXCEPTION) {
            // fc.getException(), fc.getAsyncApexJobId(), fc.getRequestId()
            // — fire restore, mark deployment Failed, etc.
        }
    }
}
```

Finalizers **fire after the Queueable even on unhandled exception**. Can be chained up to 5 times. **Callouts allowed.** This is the canonical way to guarantee restore + log on Queueable failure.

### `Database.RaisesPlatformEvents` for batch failure surface

```apex
public class MyBatch implements Database.Batchable<SObject>, Database.RaisesPlatformEvents {
    // ...
}
```

When `execute()` throws an unhandled exception, Salesforce fires a `BatchApexErrorEvent` you can subscribe to in a trigger. Event includes `AsyncApexJobId`, `ExceptionType`, `Message`, `StackTrace`, `JobScope` (CSV of record Ids). Much better than scraping `AsyncApexJob.NumberOfErrors`.

### `System.scheduleBatch(batch, name, minutes)`

One-shot schedule of a batch N minutes from now. No `Schedulable` boilerplate. Returns the CronTrigger Id.

### Schedulable `execute()` runs under **synchronous** governor limits

Important: although Scheduled Apex is "async," the body of `Schedulable.execute(SchedulableContext)` is on **sync limits** (10s CPU, 6MB heap). To get async limits, the Schedulable must kick off a Queueable/Batch/Future and return.

### Iterable vs QueryLocator in Batch

`Database.QueryLocator` (no subquery, no relationship traversal) uses Salesforce's chunking implementation → fast. `Iterable<T>` forces the slow path. The project's `AutomationToggleBatch<AutomationItem>` is on the slow path — fine for small N (<10K).

### Queueable enqueue silently lost on transaction rollback

> "If an Apex transaction rolls back, any queueable jobs queued for execution by the transaction aren't processed."

This is the root cause of the project's "CPQ triggers cause silent enqueue failures" symptom. Trigger throws after `System.enqueueJob` → transaction rolls back → enqueue is discarded.

**Workaround:** Use `System.schedule(name, cron, ...)` — `CronTrigger` records commit immediately and survive the calling transaction's rollback.

### Future restrictions

- `@future` cannot be called from `Database.Batchable.execute()`.
- Cannot fan out multiple futures from a Queueable (Apex Dev Guide explicit recommendation).
- Same transaction-rollback discard applies.

### Sandbox refresh drops scheduled jobs

`System.schedule`'d jobs do NOT carry over a sandbox refresh. Reschedule on every fresh sandbox.

### Each batch transaction creates an AsyncApexJob

Plus every 10,000 of these the platform creates a `JobType='BatchApexWorker'` bookkeeping row. **Filter `JobType='BatchApex'`** in queries against AsyncApexJob.

### Flex queue cap

100 jobs can be in `Status='Holding'`. Use `System.FlexQueue.moveBeforeJob(idA, idB)` to reorder. States: `Holding → Queued → Preparing → Processing → Completed/Failed/Aborted`.

---

## Section 7 — Governor Limits (corrected + additions)

### Corrections to V1 KB

| Limit | V1 KB said | Actual (Spring '26 cheatsheet) |
|---|---|---|
| Single callout default timeout | 60s (configurable) | **10s default**, settable up to 120s via `HttpRequest.setTimeout` |
| Single callout max payload | not stated | **6 MB sync / 12 MB async** (counts toward heap) |
| Max SOQL runtime before cancel | not stated | **120 s** |
| Apex char limit org-wide | "1M chars" (incomplete) | 1 MB per class/trigger; **6 MB org-wide cap** (10 MB scratch; increasable by case) |
| Method bytecode | not stated | **65,535 instructions** |
| `Database.getQueryLocator` rows | "50M (batch)" only | **10,000 rows per call** in non-batch contexts; 50M is the batch-context exception |
| Scheduled Apex max | "100" | 100 in production; **5 in Developer Edition** |
| Batch concurrent jobs | "5" | 5 active + **100 Holding (flex queue)** |
| Apex stack depth (recursive DML) | missing | **16** sync and async |
| Max execution wall-clock time | missing | **10 minutes** sync + async |

### Additions to memorize

- **Concurrent long-running sync transactions** (>5 s each): 10 per org minimum, 1 per 100 licenses, max 50. Any sync UI callout >5s eats this bucket. The project's analyze/deploy buttons need to be short-running or async.
- **Concurrent inbound API requests** (≥20 s each): Production/Sandbox = 25, Dev/Trial = 5. Past the cap returns `REQUEST_LIMIT_EXCEEDED`.
- **`EventBus.publish` calls**: 150/transaction sync + async.
- **Push notification calls**: 10 method calls × 2,000 notifications each per transaction.
- **`System.enqueueJob` per `execute()` in Batch**: **1** (vs 50 in sync).
- **Bulk API daily allocations are shared between v1 and v2.0** (15,000 batches/24h).
- **Bulk 2.0 ingest jobs**: 10,000/24h rolling window, 150,000,000 records/day.
- **Bulk 2.0 query**: 10,000 jobs/24h, 1 TB result storage/24h.
- **Cross-namespace limits**: each namespace gets its own 100 SOQL / 150 DML / 100 callouts pool. Cumulative cross-namespace cap = **11× the per-namespace limit** (e.g. 1,100 SOQL / transaction across all namespaces). Heap, CPU, wall-clock, unique-namespace count are **not namespaced** — org-wide.

### Static Apex limits block (new section recommended)

- Default callout timeout: 10 s (settable max 120 s)
- Max callout request/response size: 6 MB sync / 12 MB async
- Max SOQL query runtime before server-side cancel: 120 s
- Apex trigger batch size: 200 (Platform Events / CDC: 2,000)
- Class+trigger code units in a single deploy: 7,500
- Method bytecode: 65,535 instructions

---

## Section 12 — REST API (deltas)

### Add a "Common Headers" reference

| Header | Direction | Use |
|---|---|---|
| `Sforce-Auto-Assign: FALSE` | request | Suppress assignment rules on Account/Case/Lead insert — critical for cross-org seed |
| `Sforce-Call-Options: defaultNamespace=SBQQ` | request | Resolve unqualified field names against a managed package namespace |
| `Sforce-Duplicate-Rule-Header: allowSave=true` | request | Bypass duplicate rules (or `includeRecordDetails=true` to inspect them) |
| `Sforce-Limit-Info` | response | `api-usage=X/Y` daily-API-call quota |
| `Sforce-Mru: updateMru=true` | request | Update Recent Items on create/update |
| `Accept-Encoding: gzip` | request | Compressed response (useful for large describe payloads) |
| `If-Modified-Since: <RFC1123 date>` | request | 304 Not Modified for sObject Describe / Describe Global / sObject Rows |
| `If-Match: <etag>` | request | Optimistic concurrency for **Account sObject Rows only** |
| `_HttpMethod=PATCH` | query param | For HTTP clients that can't issue PATCH (POST with `?_HttpMethod=PATCH`) |

`If-Modified-Since` on Describe + Describe Global is a real cache win for the project's describe-cache architecture.

### Composite vs Composite Batch vs Composite Graph

| Resource | Subreq cap | Inter-subreq refs? | All-or-none semantics | Best for |
|---|---|---|---|---|
| `/composite` | 25 (5 queries max) | Yes (`@{ref.id}`) | One outer flag | "POST then PATCH the result" chains |
| `/composite/batch` | 25 | **No** | `haltOnError` (different) | PATCH-then-GET-current-state, independent ops |
| `/composite/sobjects` | 200 records | N/A | One `allOrNone` flag | Bulk REST DML for a single object |
| `/composite/tree/{sobject}` | 200 records total, 5 types, 5 levels | Implicit (by reference) | Implicit all-or-none | Inserting nested hierarchy (Account → Contacts → Cases) |
| `/composite/graph` | 75 graphs × ≤500 nodes, ≤15 depth | Yes (`@{ref.id}`) | Each graph implicitly all-or-none | Many independent dependency chains; faster than one big graph |

### `referenceId` case-sensitivity gotcha

In a POST-then-PATCH chain, `@{refAccount.id}` (**lowercase**, from POST result) works. `@{refAccount.Id}` (mixed case, from a GET) does not, if the prior call was a POST. Always use `.id` for IDs returned in POST responses.

### Upsert by External ID — corrections + additions

```http
PATCH /services/data/v66.0/sobjects/Account/Migration_Id__c/abc123
```

- **201 Created** on insert (new record).
- **200 OK** on update (since v46).
- Response body includes `created: true|false` (since v46).
- **300 Multiple Choices** if the ExtId value matches >1 record on the target. Surfaces a list of matched IDs.
- `?updateOnly=true` prevents insert-on-no-match.
- Master-detail reparenting via upsert returns `INVALID_FIELD_FOR_INSERT_UPDATE`.

**Nested external-ID reference for parent lookup:**

```json
{
  "Name": "Line Item 1",
  "Account__r": { "Migration_Id__c": "abc123" }
}
```

This is the bedrock pattern for cross-org child-by-parent-ExtID inserts in REST. In Bulk CSV the equivalent is `Account__r.Migration_Id__c` as a column header.

### sObject Tree

- 200 records total across all trees per call.
- Max 5 record types.
- Max 5 levels deep.
- **Triggers/processes/workflows fire separately per level** — recursive trigger chains can blow up.

### sObject Collections POST/PATCH

```http
PATCH /services/data/v66.0/composite/sobjects/Account/Migration_Id__c
{
  "allOrNone": false,
  "records": [
    { "attributes": { "type": "Account" }, "Migration_Id__c": "abc123", "Name": "X" },
    { "attributes": { "type": "Account" }, "Migration_Id__c": "abc124", "Name": "Y" }
  ]
}
```

GET via URL caps at ~800 IDs (HTTP 414 past); GET via POST body raises to 2,000 of the same type.

### Composite Graph best practices

Salesforce recommends **many small graphs over one big graph**. The spec example: "50 graphs of 10 nodes" beats "1 graph of 500 nodes" — smaller graphs are faster to process and isolate failures. Each graph implicitly all-or-none. 14 graph failures triggers `PROCESSING_HALTED` on the rest.

---

## Section 13 — Bulk API 2.0 (deltas)

### Version bump

Use `v66.0` (Spring '26). KB references to `v59.0` are stale.

### Concurrency + 24-hour limits

| Limit | Value |
|---|---|
| Ingest jobs per 24-hour rolling window | 10,000 |
| Records ingested per day | 150,000,000 |
| Batches per 24-hour (Bulk v1 + v2 shared) | 15,000 |
| Bulk Query jobs per 24-hour | 10,000 |
| Bulk Query results retained / 24h | 1 TB |
| Auto-batch size | 10,000 records |
| Auto-retry per batch on failure | 20 attempts, 5 min each |
| Apex CPU governor (isolated for Bulk processing) | 60,000 ms |

The V1 KB number "100 concurrent ingest jobs" is incorrect — it echoes v1 batch semantics.

### CSV format constraints

- Header row max **32,000 characters** (the project's wide-CustomObject upserts hit this).
- UTF-8 only.
- Salesforce base64-encodes on receipt → raw CSV should cap at ~100 MB (150 MB base64 ceiling).
- Default delimiter COMMA. Supported: `BACKQUOTE`, `CARET`, `PIPE`, `SEMICOLON`, `TAB` via `columnDelimiter` job param.
- Default line ending LF. CRLF via `"lineEnding":"CRLF"`.
- **`#N/A` literal nulls a field on update.** Empty values are *ignored* on update.
- Wrap values containing the delimiter in double quotes; escape inner quotes by doubling them.

### Relationship field column-header syntax

```
RelationshipName.IndexedFieldName            # standard FK to ExtId
ReportsTo.Email                              # standard self-ref (idLookup field)
Account__r.Migration_Id__c                   # custom lookup with ExtId
Lead:Who.Email                               # polymorphic (Lead:Task.WhoId-as-Lead)
```

Indexed = `externalId=true` OR `idLookup=true` (standard fields like `Account.AccountNumber` if marked).

### Multipart create-job (small payloads only)

```http
POST /services/data/v66.0/jobs/ingest
Content-Type: multipart/form-data; boundary=BOUNDARY

--BOUNDARY
Content-Type: application/json
Content-Disposition: form-data; name="job"

{"object":"Contact","contentType":"CSV","operation":"insert"}
--BOUNDARY
Content-Type: text/csv
Content-Disposition: form-data; name="content"; filename="content"

FirstName,LastName
Mark,Brown
--BOUNDARY--
```

Skips the explicit `UploadComplete` PATCH for jobs under 100K characters.

### Query pagination via `Sforce-Locator`

```http
GET /services/data/v66.0/jobs/query/{id}/results?maxRecords=50000

Response headers:
  Sforce-NumberOfRecords: 50000
  Sforce-Locator: MTAwMDA=

GET .../results?locator=MTAwMDA=&maxRecords=50000
# Repeat until Sforce-Locator: null
```

For parallel download (API 58.0+):

```http
GET /services/data/v66.0/jobs/query/{id}/resultPages
# Returns up to 5 resultUrl URIs to GET in parallel
```

### Bulk 2.0 Query SOQL restrictions

- No `GROUP BY`, no `OFFSET`, no `TYPEOF`.
- No aggregate functions (`COUNT()`, `SUM()`, etc.).
- No compound address/geolocation fields.
- No parent-to-child subqueries (only child-to-parent dot-traversal).
- `LIMIT` / `ORDER BY` **disable PK chunking** and risk timeout — avoid for large datasets.

### Result endpoint distinctions

- `successfulResults` — row succeeded (CSV with `sf__Id`, `sf__Created` columns).
- `failedResults` — row was processed, validation/DML error (CSV with `sf__Error` column).
- `unprocessedrecords` — row never attempted (job Failed/Aborted mid-stream).

### `hardDelete` requires a profile permission

"Bulk API Hard Delete" — disabled by default. Granted to the running user, not the Connected App.

### `Accept-Encoding: gzip` on result GETs

Compressed download. Useful for the project's large query result reconciliation.

---

## Section 14 — Metadata API (deltas)

### Version bump

Use `v66.0`. Strip `v59.0` references.

### Corrected deploy/retrieve limits

| Limit | Correct value |
|---|---|
| Files per deploy/retrieve | 10,000 (1st-gen managed: 35,000; 2nd-gen: 10,000) |
| Compressed zip | 39 MB (SOAP); 50 MB base64-encoded payload |
| Uncompressed | 600 MB / 629,145,600 bytes |
| CustomField components per deploy | 45,000 |
| Daily individual metadata deploys | 100 |

The "5,000 component" cap mentioned in V1 KB is not in current spec. File count is the cap.

### `destructiveChanges.xml` is the workhorse for the seeder's delete operations

```xml
<!-- package.xml (empty add-list) -->
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <version>66.0</version>
</Package>

<!-- destructiveChanges.xml (the kill list) -->
<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>MyCustomObject__c</members>
        <name>CustomObject</name>
    </types>
</Package>
```

Gotchas:
- Wildcards (`*`) are NOT supported in `destructiveChanges.xml`.
- `purgeOnDelete: true` bypasses Recycle Bin — **sandbox/DE only**. No-op in production. Rollup-summary deletes always purge regardless.
- For deletes-before-adds vs adds-before-deletes use `destructiveChangesPre.xml` (run before) vs `destructiveChangesPost.xml` (run after).

### Known Custom-Setting deletion failure

Deleting a Custom Setting via `destructiveChanges.xml` throws `INSUFFICIENT_ACCESS: EntityObject can not be initialized with null EntityInfo` regardless of permissions. Use the Setup UI instead.

### `deployOptions` reference

```json
{
  "deployOptions": {
    "allowMissingFiles": false,
    "autoUpdatePackage": false,
    "checkOnly": false,
    "ignoreWarnings": false,
    "performRetrieve": false,
    "purgeOnDelete": false,
    "rollbackOnError": true,
    "runTests": null,
    "singlePackage": true,
    "testLevel": "RunLocalTests"
  }
}
```

### `testLevel` enumeration

- `NoTestRun` — default for non-prod (sandbox/DE/trial).
- `RunSpecifiedTests` — only the `runTests[]` classes; 75% per class/trigger.
- `RunRelevantTests` (beta) — Salesforce analyzes payload and runs relevant tests.
- `RunLocalTests` — all org tests except managed-package tests; **default for production with Apex**.
- `RunAllTestsInOrg` — every test including managed-package tests.

### `deployRecentValidation()` saves a re-run

After a successful `checkOnly: true` validation, promote to a real deploy within **10 days** without re-running tests via `deployRecentValidation(validationId)`. Standard production cutover pattern.

### Deploy-status enum

`Pending → InProgress → FinalizingDeploy → Succeeded | SucceededPartial | Failed | Canceling | Canceled`

Since API 65.0, `FinalizingDeploy` is **uncancellable**.

### CRUD via SOAP (synchronous, since API 30.0)

For single-component edits (DuplicateRule toggle, ValidationRule flip), prefer these over file-based deploy:

```
createMetadata(), readMetadata(), updateMetadata(),
upsertMetadata(), deleteMetadata(), renameMetadata()
```

Single round-trip. The project's `DuplicateRuleService.cls` already uses `readMetadata` + `updateMetadata` in batches of 10.

### Permissions

- **`Modify Metadata Through Metadata API Functions`** — metadata-only, least-privilege.
- **`Modify All Data`** — metadata + data.

Use the former for service accounts that only need metadata, not data.

### Wildcard `*` restrictions

- `<members>*</members>` does NOT work for standard objects (each must be named).
- `*` SKIPS managed-package components. Use `namespace__Component` to target managed metadata.

### Avoid deploys during Salesforce service-upgrade windows

Deploys spanning maintenance are re-run from scratch on restore. Don't schedule deploys during scheduled maintenance.

---

## Section 15 — Tooling API (deltas)

### Base URI

`https://{MyDomain}.my.salesforce.com/services/data/v66.0/tooling/`

Sub-resources: `/sobjects/`, `/sobjects/{name}/`, `/sobjects/{name}/{id}/`, `/query/?q=`, `/composite`, `/executeAnonymous/?anonymousBody=`, `/runTestsSynchronous/`, `/runTestsAsynchronous/`.

### Active-org CRUD restriction (the centerpiece)

These 6 objects return `INVALID_TYPE` / `Save or update not supported in active organizations` on direct PATCH/POST in a production-like org:

| Object | Workaround |
|---|---|
| ApexClass | MetadataContainer + ApexClassMember + ContainerAsyncRequest |
| ApexComponent | MetadataContainer + ApexComponentMember + ContainerAsyncRequest |
| ApexPage | MetadataContainer + ApexPageMember + ContainerAsyncRequest |
| ApexTrigger | MetadataContainer + ApexTriggerMember + ContainerAsyncRequest |
| CustomField | CustomFieldMember + MetadataContainer; OR Metadata API SOAP `deploy()` |
| CustomObject | Metadata API SOAP `deploy()` |

### MetadataContainer deployment pattern (the canonical workflow)

Single `/tooling/composite` call:

```http
POST /services/data/v66.0/tooling/composite
{
  "allOrNone": false,
  "compositeRequest": [
    { "method":"POST", "referenceId":"mc",
      "url":"/services/data/v66.0/tooling/sobjects/MetadataContainer/",
      "body":{ "Name":"DeploySession_2026_05_11_001" } },
    { "method":"POST", "referenceId":"member",
      "url":"/services/data/v66.0/tooling/sobjects/ApexTriggerMember/",
      "body":{
        "MetadataContainerId":"@{mc.id}",
        "ContentEntityId":"<existing-ApexTrigger-Id>",
        "Body":"trigger MyTrigger on Account (before insert) { /* new body */ }"
      }},
    { "method":"POST", "referenceId":"car",
      "url":"/services/data/v66.0/tooling/sobjects/ContainerAsyncRequest/",
      "body":{ "MetadataContainerId":"@{mc.id}", "IsCheckOnly": false } },
    { "method":"GET", "referenceId":"carCheck",
      "url":"/services/data/v66.0/tooling/sobjects/ContainerAsyncRequest/@{car.id}" }
  ]
}
```

Then poll `ContainerAsyncRequest.State` until it leaves `Queued`. Terminal states:
- `Completed` — success.
- `Failed` — see `ErrorMsg` / `DeployDetails`.
- `Invalidated` — surprising; Salesforce cancels mid-deploy when the member is modified or a newer compile request enters the queue.
- `Aborted` / `Error`.

Critical rules:
- `IsCheckOnly=true` compiles without saving; `false` compiles + saves.
- You can compile without saving, **but you can't save without compiling**.
- **A MetadataContainer is single-use:** once the ContainerAsyncRequest completes successfully, the members' `MetadataContainerId` is repointed to the CAR's ID. Build a fresh MetadataContainer for the next deploy.
- **Deleting a MetadataContainer cascades to all members.**
- The spec is explicit: "Apex triggers cannot be deactivated using Tooling API." For deactivation, must use Metadata API.

### `/tooling/composite` limits

- 25 subrequests max.
- Of which **at most 5 can be queries**.
- Subrequests inherit Accept/Authorization/Content-Type from the outer request — cannot override.

### ValidationRule writes — always send full Metadata

Required-ish fields in `Metadata`:

```json
{ "active": true,
  "description": "...",
  "errorConditionFormula": "ISBLANK(Name)",
  "errorDisplayField": "Name",
  "errorMessage": "Name is required." }
```

GET → mutate `active` → PATCH back the complete object. Partial PATCH returns `Required field is missing: errorConditionFormula`.

### FlowDefinition deactivation (post-API 44.0)

Preferred path: activate/deactivate via the `Flow` object's `Metadata`, not `FlowDefinition`.

```http
PATCH /tooling/sobjects/Flow/{flowVersionId}
{ "Metadata": { "status": "Obsolete" } }   # deactivates
{ "Metadata": { "status": "Active"   } }   # activates
```

If you only know the FlowDefinition's `DeveloperName`:

```http
PATCH /tooling/sobjects/FlowDefinition/{id}
{ "Metadata": { "activeVersionNumber": 0 } }   # deactivates
{ "Metadata": { "activeVersionNumber": N } }   # activates version N
```

FlowDefinition can **only be updated** (never created/deleted). Legacy Desktop Flow Designer flows **cannot be touched via the API** — recreate in Flow Builder first.

### DuplicateRule callout

**DuplicateRule is not a Tooling API write target.** Tooling `DuplicateJobDefinition` / `DuplicateJobMatchingRuleDefinition` are duplicate-detection *jobs*, not the declarative DuplicateRule. The DuplicateRule sObject is queryable via REST/Tooling but read-only there. Canonical write path: Metadata API SOAP `updateMetadata()`.

### API End-of-Life

Tooling REST 31.0–66.0 supported. 21.0–30.0 retired Summer '25 (return `410: GONE`). 7.0–20.0 retired Summer '22. Pin a known-supported version.

### Useful Tooling-specific headers

- `Sforce-Call-Options: defaultNamespace=…` — namespace resolution.
- `Sforce-Package-Version-Header` — multi-version conflicts.
- `Sforce-Query-Options` — batch sizing for `/tooling/query`.
- `ignoreSaveWarnings` — let warnings flow through as success.

---

## Section 10 — Security (deltas)

### Permission Sets > Profiles (Salesforce strategic direction)

The Spring '26 Security Guide is explicit: **"We recommend that you use permission sets and permission set groups to manage your users' permissions."** Salesforce is deprecating most profile-level permissions. For a packaged app, **ship permission sets, not profile edits**.

### `Modify Metadata Through Metadata API Functions` — critical for least-privilege

This permission lets a user perform metadata-only operations (Tooling PATCH on Validation Rules, Flows, etc.) **WITHOUT** granting `Modify All Data`. The connected user on the target org needs Metadata API write access but should NOT have Modify All Data. The V1 KB doesn't surface this distinction.

### "Set Audit Fields upon Record Creation"

Two-part toggle:
1. **Org preference** — Setup → User Interface → "Enable 'Set Audit Fields upon Record Creation'…" → check.
2. **User permission** — `Set Audit Fields` on a permset assigned to the integration user.

Once both are set, INSERT can write `CreatedDate`, `CreatedById`, `LastModifiedDate`, `LastModifiedById` to preserve source-org audit history. Without this, every migrated record gets today's date as CreatedDate. **Mandatory for any cross-org migration that wants real audit history.**

### View All vs View All Data — don't conflate

- `View All Data` / `Modify All Data` — org-wide, sees/modifies ALL apps and data. Admin-only.
- `View All` / `Modify All` (per-object) — overrides sharing rules only for that object. Useful for delegated admin patterns.
- **Both still respect FLS.** Quote from spec: *"View All Data, Modify All Data, and View All or Modify All for a given object don't override field-level security. Users must still have field permissions."*

### OAuth scope practical implications

| Scope | Implications |
|---|---|
| `api` | REST/SOAP/Bulk; does NOT include `chatter_api` or Anonymous Apex |
| `refresh_token`, `offline_access` | Required for refresh tokens; absence = re-auth every ~2 hours |
| `full` | User's full permission set; includes Setup metadata write but NOT a substitute for individual scopes |
| `web` | Required for OAuth authorization-code redirect flow |

For **JWT Bearer**, scopes are determined by the Connected App's pre-authorized profile + permsets, NOT by the JWT itself.

### `WITH USER_MODE` is now the preferred enforcement

`WITH USER_MODE` enforces **CRUD + FLS + sharing** in a single declaration. `WITH SECURITY_ENFORCED` only enforces FLS on referenced fields. Prefer `WITH USER_MODE`.

### OAuth token caches permission state

Already covered in "Critical platform-tightening regressions" §5. Re-stated here because it's a *security* mechanism: a token issued before a permset assignment continues to see the old permission set until refresh. Always `refreshSession` after granting.

### Permissions strategy for this project's data-seeder admin user

Bundle ALL permissions into a permission set, never profile edits. Required perms:
- System: `Modify Metadata Through Metadata API Functions`, `API Enabled`
- System: `View Setup and Configuration`
- Object: full CRUD on seeder objects (`Data_Deployment__c`, `Deployment_Object__c`, `Deployment_Log__c`, `Org_Connection__c`)
- Object: `Modify All` on Deployment_Object__c (queryable across users)
- **Optional / not recommended**: `Modify All Data` (lazy but overly broad). Prefer named system-context Apex (`without sharing`) at the service-layer for source reads.
- `Set Audit Fields` (with org preference enabled)

After permission set changes, **force-refresh** the OAuth token (Named Credential refresh button or 2-hour wait).

---

## Section 17 — CPQ / SBQQ (deltas)

### `SBQQ.TriggerControl.disable()` is transaction-scoped — restate clearly

The official Spring '26 CPQ Developer Guide:
- **Scope**: disables built-in CPQ triggers **within the current Apex transaction**. Automatically re-enabled at transaction end.
- **What it disables**: ONLY triggers in CPQ + Billing + Service Cloud for CPQ. Quote from spec: *"Other triggers or Salesforce logic, or your own triggers, validations, workflow rules, or processes, are unaffected."*
- **Does NOT disable the QCP calculator** — the calculator is invoked by `QuoteCalculator` API or by the QLE save flow, not by Apex triggers.

The implication for the data-seeder: `TriggerControl.disable()` covers SBQQ-namespaced triggers only. **Customer VRs, Flows, and custom-namespace triggers must be disabled separately** — which is exactly what the project's `AutomationDisableQueueable` does.

### `SBQQ__TriggerDisabled__c` custom setting — caveat emptor

The V1 KB lists `SBQQ__TriggerDisabled__c` as a CPQ org-level kill switch. **This is not in the official Spring '26 developer guide.** Some CPQ versions have a `SBQQ__TriggerControlSettings__c` hierarchy custom setting with a similar field, but the canonical/supported pattern per Salesforce docs is `TriggerControl.disable()` in Apex.

For cross-transaction disable (which spans queueable boundaries — the seeder's use case), callers must invoke `TriggerControl.disable()` at the top of every entry point (queueable `execute()`, batch `execute()`, scheduled `execute()`, REST endpoint, future). There is no persistent off-switch documented by Salesforce. The project's existing pattern of a custom setting + before-trigger guard remains the most reliable cross-transaction solution.

### CPQ migration insert order (refined for QuoteLine self-refs)

```
Phase 1 (config — no cycles):
  Product2 → Pricebook2 → PricebookEntry (Standard PBE first)
  → ProductFeature → ProductOption (ConfiguredSKU + OptionalSKU)
  → ConfigurationAttribute → DiscountSchedule → DiscountTier
  → Dimension → ProductRule → ErrorCondition → ConfigurationRule
  → SummaryVariable → PriceRule → PriceCondition → PriceAction
  → CustomAction → CustomScript → LookupQuery → ContractedPrice

Phase 2 (party):
  Account → Contact

Phase 3 (transactional — TWO passes for self-refs):
  Opportunity → Quote (pass 1: no self-refs)
  → QuoteLineGroup → QuoteLine (pass 1: RequiredBy/Source null)
  → QuoteLine (pass 2: populate RequiredBy + Source via ExtId)
  → Contract → Subscription (pass 1: self-refs null)
  → Subscription (pass 2: UpgradedSubscription, RenewedSubscription)
  → Quote (pass 3: MasterContract, Renewal references)
```

### CPQ-specific self-references to plan for

- `SBQQ__QuoteLine__c.SBQQ__RequiredBy__c` (QuoteLine → QuoteLine, bundle hierarchy)
- `SBQQ__QuoteLine__c.SBQQ__Source__c` (QuoteLine → QuoteLine, bundle component lineage)
- `SBQQ__QuoteLine__c.SBQQ__UpgradedSubscription__c` (QuoteLine → Subscription)
- `SBQQ__QuoteLine__c.SBQQ__RenewedSubscription__c` (QuoteLine → Subscription)
- `SBQQ__Subscription__c.SBQQ__RootSubscription__c` (Subscription → Subscription)
- `SBQQ__Subscription__c.SBQQ__RequiredById__c` (Subscription → Subscription)
- `SBQQ__Subscription__c.SBQQ__UpgradedSubscription__c` (Subscription → Subscription)
- `SBQQ__Quote__c.SBQQ__MasterContract__c` (Amendment/Renewal Quote → Contract that was created from a prior Quote)

All require 2 (or 3) passes.

### ProductOption.SBQQ__Type__c picklist values

Exact strings (matter for cross-org load):
- `Component`
- `Accessory`
- `Related Product`

### "Always run twice" pattern (project-derived)

For any field whose value depends on triggers/Flows/Price Rules firing during DML, run the load **twice**:
- 1st save populates rows and propagates rollups.
- 2nd save stabilizes derived `_PR` fields (Price-Rule-computed) and Init-to-Zero state.

Not in the official CPQ guide — but standard practice for CPQ data migrations.

### CPQ "auto-touch" post-deploy

After migrating Price Rules, **deactivate then reactivate** every Price Rule on the target. Forces CPQ's configuration-cache refresh. Without this, the target org doesn't pick up the new rules until the next quote save.

### Adding an External ID to a managed object

You **can't** add an External ID directly to a managed SBQQ field, but you CAN add an unmanaged custom field on the managed object: `SBQQ__Quote__c.Migration_Id__c` is a valid field path. Define it in `objects/SBQQ__Quote__c/fields/Migration_Id__c.field-meta.xml` in your project (Salesforce permits this — the field is owned by your namespace, attached to the SBQQ object).

### Server-side recalc pattern (post-load)

After data load, recalc each Quote:

```apex
String jsonContext = '{"context":"{\\"quote\\": ...}"}';
SBQQ.ServiceRouter.load('SBQQ.QuoteAPI.QuoteCalculator', null, jsonContext);
```

Inside a `Database.Batchable<SObject>` with scope=1 to stay under CPU limits. QCP does NOT execute for server-only Apex-driven calculations unless explicitly wired.

---

## Section 19 — Packaging 2GP (deltas)

### Full 2GP lifecycle (was missing)

```bash
# 1. Create the package (Dev Hub side)
sf package create --name rev-cpq-data-seeder \
    --package-type Unlocked \
    --path force-app

# 2. Create a new version (beta, mutable)
sf package version create --package rev-cpq-data-seeder \
    --installation-key-bypass --wait 10

# 3. Promote (immutable, production-installable)
sf package version promote --package 04t...

# 4. Install on subscriber
sf package install --package 04t... --target-org subscriber
```

Key rules:
- **Beta versions are NOT upgradeable.** Must uninstall before switching betas.
- Once **promoted**, a version is frozen forever. Immutable artifact.
- 75% Apex coverage required to promote.

### Dev Hub model

- 2GP requires a Dev Hub org. Recommended: Partner Business Org (PBO).
- **Cannot enable Dev Hub in a sandbox.**
- Dev Hub *owns* the package. If the Dev Hub expires or is deleted, the package can't be transferred and new versions can't be created.

### Namespace decision matrix

| Package type | Namespace required? | Upgradeable? | AppExchange? | When to use |
|---|---|---|---|---|
| Unmanaged | No | **No** — uninstall+reinstall to update | No | Code-share between own orgs, throwaway demos |
| **Unlocked, no namespace** | No | Yes | No | **Internal-only tools, this project's recommended path** |
| Unlocked, with namespace | Yes (DE org Namespace Registry) | Yes | Limited | Internal app that may share names with subscribers' custom fields |
| Managed 2GP | Yes, immutable | Yes | Yes | AppExchange-distributable, locked source |

For **this project**, the recommendation is **unlocked 2GP without a namespace**: not destined for AppExchange (internal LD tool), upgradeable (vs unmanaged), no DE-org Namespace Registry hassle, subscribers can read/modify source if needed for debugging.

### `sfdx-project.json` — full schema with dependencies + hooks

```json
{
  "packageDirectories": [{
    "path": "force-app",
    "default": true,
    "package": "rev-cpq-data-seeder",
    "versionName": "Spring 26",
    "versionNumber": "1.0.0.NEXT",
    "postInstallScript": "PostInstallHandler",
    "uninstallScript": "UninstallHandler",
    "postInstallUrl": "https://docs.../post-install.html",
    "releaseNotesUrl": "https://docs.../release-notes.html",
    "dependencies": [
      { "package": "SBQQ@224.0" }
    ]
  }],
  "namespace": "",
  "sourceApiVersion": "66.0",
  "packageAliases": {
    "rev-cpq-data-seeder": "0Ho...",
    "rev-cpq-data-seeder@1.0.0-1": "04t..."
  }
}
```

### `InstallHandler` (post-install Apex) — critical for this project

The V1 KB doesn't mention this. It's exactly what the project needs for ECA bootstrap and post-install setup.

```apex
public class PostInstallHandler implements InstallHandler {
    public void onInstall(InstallContext context) {
        if (context.previousVersion() == null) {
            // First install: insert default CMT/CustomSetting rows
            // Defer DML to Queueable if you need to do mixed-DML
        }
        if (context.isUpgrade()) {
            // Migrate any old data
            Version prev = context.previousVersion();
        }
        // Also available:
        //   context.organizationId() / installerId() / isPush()
    }
}
```

**Hard constraints (Spring '26 2GP guide):**
- Runs as a **special system user representing the package** — NOT as the installer.
- Subject to default governor limits.
- **Cannot access Session Id.**
- **Callouts only via `@future` or Queueable** (the callout fires AFTER install commits).
- Cannot call package Apex marked `with sharing` or `inherited sharing` (will break install).
- **If it throws, the install is ABORTED.** Errors emailed to "Notify on Apex Error" user.

**Testing** the InstallHandler:

```apex
@isTest
static void testInstall() {
    PostInstallHandler h = new PostInstallHandler();
    Test.testInstall(h, new Version(1, 0));     // first install
    Test.testInstall(h, new Version(1, 0), true); // push install
}
```

`Test.testInstall(handler, version, isPush)` is the only way to unit-test it.

### Test coverage threshold

- **75% Apex coverage** required to **promote** a 2GP package version.
- Individual triggers must have ≥1% coverage.
- Tests run during `sf package version create`; failures block version creation.
- `--skip-validation` defers test run to install time but **disables promote**.

### Anti-patterns for packaged code

- **Hardcoded org Ids** — won't match subscriber's. Use `UserInfo.getOrganizationId()`.
- **SOQL on subscriber data in InstallHandler** — they have none on first install.
- **Mixed-DML in InstallHandler** (Setup + non-Setup objects in same transaction) — split via `@future`.
- **Hardcoded references to optional managed-package fields** — use Dynamic Apex `Schema.getGlobalDescribe().containsKey('SBQQ__Quote__c')` guards.
- **Shipping secrets in CMT rows** — CMT values are queryable by anyone with Read on the CMT. Use a `Protected` Custom Setting OR a Named Credential / External Credential configured post-install.

### ECA / Connected App packaging caveats

- Connected Apps **CAN be packaged in 2GP** (Spring '26 guide, "Package Connected Apps in Second-Generation Managed Packaging," p. 332). Same for External Client Apps.
- **BUT**: Consumer Key + Consumer Secret are **regenerated per-install** in subscriber orgs. The subscriber admin must visit App Manager and copy them out. There is no way to ship a consumer secret in a CMT and have it survive packaging.
- Workaround: InstallHandler navigates the installer to a setup screen prompting them to paste Consumer Key + Secret into a Custom Setting (the "ECA bootstrap dropdown" you have queued).

### Distribution of secrets — antipattern

Never ship a secret in a CMT row — CMT values are queryable. For consumer secrets and tokens: use a `Protected` Custom Setting OR a Named Credential / External Credential configured post-install.

---

## Section 20 — Standard Objects insert-order matrix

The user's #1 stated weakness. Treat this as the canonical reference table.

### Per-object dependency + state-machine matrix

| Object | REQUIRED on insert | Hard parents | Soft parents (nullable) | Self-refs (2nd pass) | State machine | Immutable-after-create |
|---|---|---|---|---|---|---|
| **User** | (don't insert; map only) | — | — | — | — | — |
| **RecordType** | (don't insert; map by DeveloperName) | — | — | — | — | — |
| **Pricebook2** | `Name` | — | — | — | `IsStandard` (read-only) | — |
| **Product2** | `Name` | — | — | — | — | — |
| **PricebookEntry (Standard)** | `Pricebook2Id`, `Product2Id`, `UnitPrice` | Standard Pricebook2, Product2 | — | — | `UseStandardPrice=true` required | `Pricebook2Id`, `Product2Id` |
| **PricebookEntry (Custom)** | `Pricebook2Id`, `Product2Id`, `UnitPrice` | Custom Pricebook2, Product2, **Standard PBE for same Product2** | — | — | — | `Pricebook2Id`, `Product2Id` |
| **Account** | `Name` (Business) / `LastName` (Person) | RecordType (Person), Pricebook2 (Person+CPQ) | `ParentId` (self), `OwnerId` (User) | `ParentId` | — | `IsPersonAccount` |
| **Contact** | `LastName` | Account (if AccountId set) | `AccountId`, `ReportsToId` (self) | `ReportsToId` | — | — |
| **Lead** | `LastName`, `Company` | — | `OwnerId`, `ConvertedAccount/Contact/OpportunityId` (post-conv) | — | `IsConverted` one-way | post-conversion: read-only |
| **Opportunity** | `Name`, `StageName`, `CloseDate` | Account (if AccountId) | `Pricebook2Id`, `AccountId`, `CampaignId`, `ContractId`, `OwnerId` | — | `IsClosed` from StageName | Once OLIs exist: `Pricebook2Id`, `CurrencyIsoCode`. `Amount`/`ExpectedRevenue` read-only when OLIs exist |
| **OpportunityLineItem** | `OpportunityId`, `PricebookEntryId`, `Quantity`, `UnitPrice` OR `TotalPrice` | Opportunity, PricebookEntry | — | — | — | — |
| **Quote** | `Name`, `OpportunityId`, `Pricebook2Id` | Opportunity, Pricebook2 | `ContactId` | — | — | — |
| **Contract** | `AccountId` | Account | `Pricebook2Id`, `OwnerId`, `CompanySignedId`, `CustomerSignedId` | — | Status: Draft → InApproval → Activated; **locked after Activated** | After Activated: nearly everything |
| **Order** | `AccountId`, `EffectiveDate`, `Status`, `Pricebook2Id` | Account, Pricebook2 | `ContractId`, `OpportunityId`, `QuoteId`, `OriginalOrderId` | — | StatusCode: Draft → Activated → (Superseded). Only `Status` updateable during activation | `AccountId`, `ContractId` (locked when StatusCode≠Draft) |
| **OrderItem** | `OrderId`, `PricebookEntryId`, `Quantity`, `UnitPrice` | Order, PricebookEntry | `OriginalOrderItemId`, `OrderDeliveryGroupId` | — | Locked when parent Order is Activated unless reduction order workflow | `PricebookEntryId` |
| **Case** | `Status`, `Origin` | — | `AccountId`, `ContactId`, `ParentId` (self), `OwnerId` (User or Queue) | `ParentId` | `IsClosed` from Status | — |
| **Asset** | `Name`, `AccountId` OR `ContactId` | Account or Contact, Product2 | `PricebookEntryId`, `ParentId` (self), `RootAssetId` | `ParentId`, `RootAssetId` | `Status` | — |
| **Task/Event** | `Subject` | — | `WhoId` (Contact/Lead poly), `WhatId` (poly), `OwnerId` | — | — | **Recommend EXCLUDE from migration** |
| **SBQQ__Quote__c** | (depends on RT) | Opportunity (`SBQQ__Opportunity2__c`), Account (`SBQQ__Account__c`) | `SBQQ__MasterContract__c`, `SBQQ__PriceBook__c` | — | `SBQQ__Status__c` | — |
| **SBQQ__QuoteLineGroup__c** | `SBQQ__Quote__c` (M-D) | Quote | `SBQQ__Account__c` | — | — | Master-detail to Quote |
| **SBQQ__QuoteLine__c** | `SBQQ__Quote__c` (M-D), `SBQQ__Product__c` | Quote, Product2 | `SBQQ__Group__c`, `SBQQ__RequiredBy__c` (self), `SBQQ__Source__c` (self), `SBQQ__UpgradedSubscription__c` | `SBQQ__RequiredBy__c`, `SBQQ__Source__c` | — | Master-detail to Quote |
| **SBQQ__Subscription__c** | `SBQQ__Contract__c`, `SBQQ__Product__c`, `SBQQ__Account__c` | Contract, Product2, Account | `SBQQ__RootSubscription__c`, `SBQQ__RequiredById__c` (self) | self-refs | `SBQQ__Status__c` | — |
| **SBQQ__ProductOption__c** | `SBQQ__ConfiguredSKU__c`, `SBQQ__OptionalSKU__c` | Product2 (parent bundle + option) | `SBQQ__Feature__c` | — | — | — |
| **SBQQ__PriceRule__c** | `Name` | — | `SBQQ__LookupObject__c`, `SBQQ__ProductRule__c` | — | `SBQQ__Active__c` | — |
| **SBQQ__DiscountSchedule__c** | `Name` | — | `SBQQ__Product__c`, `SBQQ__OriginalSchedule__c` (self) | self-ref | — | — |

### Recommended insert-order topology for a sales + CPQ deployment

```
PHASE 0 — MAP-ONLY (NEVER INSERT)
  User, RecordType, Profile, PermissionSet, BusinessHours, Currency, OrgWideEmailAddress

PHASE 1 — CONFIG / NO PARENTS
   1.  Pricebook2 (custom only; Standard already exists)
   2.  Product2
   3.  PricebookEntry on STANDARD Pricebook2  (UseStandardPrice=true)
   4.  PricebookEntry on CUSTOM Pricebook2s   (must come AFTER Standard PBE for same Product2)
   5.  SBQQ__ProductFeature__c               (parent: Product2)
   6.  SBQQ__ProductOption__c                (parents: Product2 bundle + Product2 option)
   7.  SBQQ__ConfigurationAttribute__c
   8.  SBQQ__DiscountSchedule__c → SBQQ__DiscountTier__c
   9.  SBQQ__Dimension__c
  10.  SBQQ__ProductRule__c → SBQQ__ErrorCondition__c → SBQQ__ProductAction__c
  11.  SBQQ__SummaryVariable__c
  12.  SBQQ__PriceRule__c → SBQQ__PriceCondition__c → SBQQ__PriceAction__c
  13.  SBQQ__CustomAction__c, SBQQ__CustomScript__c, SBQQ__LookupQuery__c

PHASE 2 — ACCOUNT GRAPH (2 passes for self-refs)
  14.  Account (ParentId=null)
  15.  Account (2nd pass — populate ParentId)
  16.  AccountContactRelation (if used)
  17.  Contact (ReportsToId=null)
  18.  Contact (2nd pass — populate ReportsToId)
  19.  Lead (only non-converted)
  20.  SBQQ__ContractedPrice__c

PHASE 3 — DEAL CHAIN
  21.  Campaign → CampaignMember
  22.  Opportunity  (set Pricebook2Id EXPLICITLY — don't rely on auto-set)
  23.  OpportunityLineItem
  24.  OpportunityContactRole
  25.  SBQQ__Quote__c (initial — no MasterContract)
  26.  SBQQ__QuoteLineGroup__c
  27.  SBQQ__QuoteLine__c (1st pass — null self-refs)

PHASE 4 — CONTRACT + SUBSCRIPTIONS (closed-won deals)
  28.  Contract  (INSERT WITH Status='Draft' — never 'Activated')
  29.  Contract  (2nd pass — update Status='Activated' ONLY)
  30.  SBQQ__Subscription__c (1st pass — null self-refs)
  31.  SBQQ__Subscription__c (2nd pass — populate RootSubscription, RequiredById)
  32.  SBQQ__QuoteLine__c     (3rd pass — populate UpgradedSubscription, RequiredBy, Source)
  33.  ContractContactRole

PHASE 5 — AMENDMENT / RENEWAL QUOTES
  34.  SBQQ__Quote__c (Amendment/Renewal — references Contract from Phase 4)
  35.  SBQQ__QuoteLine__c on those quotes

PHASE 6 — ORDER FULFILLMENT
  36.  Order      (INSERT WITH StatusCode='Draft')
  37.  OrderItem
  38.  Order      (2nd pass — update Status to Activated value, only the Status field)
  39.  Asset      (1st pass — null ParentId/RootAssetId)
  40.  Asset      (2nd pass — populate self-refs)

PHASE 7 — POST
  41.  Case  (ParentId=null, then 2nd pass for ParentId)
  42.  Re-enable triggers, validation rules, flows, duplicate rules
  43.  CPQ "auto-touch": deactivate → reactivate Price Rules to refresh CPQ config cache
  44.  (Optional) Recalc batch on Quote cohort to populate calculated fields
```

### Non-obvious cycles called out

- `Account.ParentId → Account` (always 2-pass).
- `Contact.ReportsToId → Contact` (2-pass).
- `Case.ParentId → Case` (2-pass).
- `Asset.ParentId`, `Asset.RootAssetId` → Asset (2-pass).
- **Opportunity ↔ Contract**: Opp.ContractId → Contract; Contract.SBQQ__Opportunity__c → Opp. Insert Opp first, then Contract, then update Opp.ContractId in a back-fill pass.
- **Opportunity ↔ Campaign**: Opp.CampaignId → Campaign. Insert Campaign first.
- **OLI → Opportunity.Pricebook2Id auto-set side-effect**: if you don't explicitly set Pricebook2Id on the Opp first, the first OLI sets it implicitly, locking subsequent OLIs to that pricebook's currency.
- **SBQQ__QuoteLine__c** has 4 self/related-self refs — needs 2–3 passes.
- **Amendment/Renewal Quote → original Contract** cycle: original Quote → Opp → Contract → Subscriptions → Amendment Quote → those Subscriptions.

### Canonical EXCLUDE list

```
ALWAYS EXCLUDE:
  - User, Profile, PermissionSet, PermissionSetAssignment, Role
  - RecordType, BusinessProcess
  - Task, Event, ActivityHistory, OpenActivity, EmailMessage (polymorphic Who/What)
  - FieldHistory, *History, *Feed, *Share, *ChangeEvent
  - Approval/Process/ProcessInstance/ProcessInstanceStep
  - LoginHistory, LoginEvent, AuthSession
  - __mdt (deploy as metadata, not data)
  - Hierarchy / List Custom Settings (deploy as metadata)
  - OpportunityContactRole, AccountContactRole (auto-created)
```

---

## Section 21 — Cross-Org Migration Patterns (deltas)

### State-machine-aware loader is a hard requirement

Section 21 of V1 KB describes a single-pass extract → transform → load. Real cross-org loads are **multi-pass per state-machine object**:

- **Contract & Order**: Pass 1 inserts with Status=Draft. Pass 2 updates ONLY the Status field to the Activated value. **Filter Status out of every other UPDATE call** in the pipeline, otherwise records that should stay Draft will be accidentally activated.
- **OLI on Opportunity without Pricebook2**: Explicitly set Opp.Pricebook2Id BEFORE inserting OLIs. Don't rely on the platform's auto-set.

### Standard pricebook bootstrap on a fresh sandbox

A fresh sandbox has the Standard Pricebook2 record present but **inactive** and with zero PBEs. The loader must:
1. Activate the standard pricebook (`IsActive=true`).
2. Write Standard PBEs (one per Product2).
3. THEN write custom pricebook PBEs (which require Standard PBE for same Product2 to exist).

### PricebookEntry "auto-stub" trick (from prior iteration)

When migrating only custom prices to a target without source standard prices, the loader should auto-create stub Standard PBEs for products that have custom prices but no source standard price. Use the first custom price found as the stub's value. The prior `executePricebookEntryDeploy()` did this in lines 537-557.

### FLS pre-check before data load

The integration user must have FLS on the External ID field on **every** target object BEFORE upsert can match. If the permset deploy lags the data load, upsert will silently create duplicate records (the External ID field is invisible → match fails). Run a `findMissingFieldAccess` probe at every analysis/deploy boundary and refresh the OAuth session after granting.

### CPQ "auto-touch" post-deploy

Deactivate → reactivate every Price Rule at the end of a CPQ migration. Forces CPQ's configuration-cache refresh. Without this, the target org doesn't pick up the new rules until the next quote save.

### Always-run-twice convention

For any field whose value depends on triggers/Flows/Price Rules firing during DML, run the load **twice**. First pass populates rows; second pass settles propagation artifacts (first-save trigger races).

### `Sforce-Auto-Assign: FALSE` is the single most important REST header

Without it, every Account/Case/Lead insert into the target fires assignment rules — rarely what you want during a bulk seed. Set it on every REST request that touches these objects.

### Currency in multi-currency orgs

- `CurrencyIsoCode` on every child in an Opp/OLI/Contract/Order/OrderItem chain must match the parent.
- All `CurrencyIsoCode` values must be in `DatedConversionRate` on the target.
- Schema-compare should flag `CurrencyIsoCode` picklist deltas BEFORE data load.

### 20-field history-tracking cap

Standard objects like Opportunity have a 20-field cap on history tracking. If source has 20+ tracked fields and target migration tries to enable more, the deploy fails. Flag in schema compare.

### PersonAccount translation

- Do NOT migrate Contacts where `Contact.IsPersonAccount=true` — auto-created from Account migration.
- Source-has-PA vs target-doesn't-have-PA → migration plan needs an explicit translation step.

### Cached describe TTL

Salesforce's `Schema.getGlobalDescribe()` is ~24h fresh. The project's `Cached_Field_Describe__c` is a longer-lived cache — must be invalidated when fields are added/dropped on either org. The new `If-Modified-Since` REST pattern (Section 12) is the right primitive: ask the platform "did anything change since my last cache write?" and 304 = re-use; 200 = re-cache.

---

## New Section — Apex Testing Patterns

The V1 KB has no concentrated testing section. Add this.

### `Test.startTest()` / `Test.stopTest()`

- Resets all per-transaction governor limits at `startTest()`. Bracket the code-under-test to get a fresh budget independent of fixture setup.
- At `stopTest()`, all async jobs queued during the test (`@future`, `enqueueJob`, `executeBatch`, `System.schedule`) execute **synchronously and to completion** before `stopTest()` returns. This is how you assert async-job side effects.
- Async calls inside `startTest`/`stopTest` block don't count against the test's async limits.

### HTTP callout mocking

```apex
public class MyMock implements HttpCalloutMock {
    public HttpResponse respond(HttpRequest req) {
        HttpResponse r = new HttpResponse();
        r.setStatusCode(200);
        r.setBody('{"records":[]}');
        return r;
    }
}

@isTest
static void testWithMock() {
    Test.setMock(HttpCalloutMock.class, new MyMock());
    Test.startTest();
    MyService.doCallout();
    Test.stopTest();
}
```

**Unmocked callouts in tests throw** `MethodNotAllowed: Methods defined as TestMethod do not support Web service callouts`.

For per-endpoint mocks: `MultiStaticResourceCalloutMock` / `StaticResourceCalloutMock`.

### SOAP mocking

```apex
public class MySoapMock implements WebServiceMock { /* ... */ }
Test.setMock(WebServiceMock.class, new MySoapMock());
```

### `Test.isRunningTest()`

Bypass platform integrations you can't cleanly mock (managed-package internals, FeatureManagement asserts). **Anti-pattern:** skipping business logic. **Valid uses:** the project's `Test.isRunningTest()` bypass in `ExternalIdService.requireTargetRole` is OK.

### `@TestSetup`

Runs once per test class; data persists across test methods. Rolled back at class end. Good for shared fixtures (e.g., a Deployment_Object__c + Org_Connection__c pair).

### `System.runAs(user)`

The only place where **mixed-DML restrictions can be bypassed** outside `@future`. Required for testing FLS / sharing / profile-specific behavior.

### `Test.getEventBus().deliver()`

Platform events don't auto-deliver inside `stopTest()` the way Queueables do. Required to deliver events in tests.

### Async assertion pattern

```apex
@isTest
static void testQueueable() {
    Test.startTest();
    Id jobId = System.enqueueJob(new MyQueueable());
    Test.stopTest();  // queueable + its chained child both run here

    AsyncApexJob job = [SELECT Status, NumberOfErrors FROM AsyncApexJob WHERE Id=:jobId];
    Assert.areEqual('Completed', job.Status);
}
```

### Test queueable chain limits

Tests allow only **1 `enqueueJob` per test method** at the top level. Chained child jobs inside `execute()` DO run via `stopTest()`, but you can't enqueue two siblings from the test method itself.

### Test scheduled jobs

Wrap `System.schedule` in `startTest/stopTest`. Even a far-future CRON runs once at `stopTest()`.

---

## Appendix — Mapping from KB section to source PDFs

| KB Section | Primary PDF(s) | Last verified |
|---|---|---|
| 3 Relationships | object_reference.pdf | 2026-05-11 |
| 4 SOQL | salesforce_soql_sosl.pdf | 2026-05-11 |
| 5 Apex | salesforce_apex_developer_guide.pdf | 2026-05-11 |
| 6 Async + 7 Limits | salesforce_apex_developer_guide.pdf, salesforce_app_limits_cheatsheet.pdf (2026-04-03) | 2026-05-11 |
| 12 REST | api_rest.pdf | 2026-05-11 |
| 13 Bulk | api_asynch.pdf | 2026-05-11 |
| 14 Metadata | api_meta.pdf | 2026-05-11 |
| 15 Tooling | api_tooling.pdf | 2026-05-11 |
| 10 Security | salesforce_security_impl_guide.pdf | 2026-05-11 |
| 17 CPQ | cpq_developer_guide.pdf | 2026-05-11 |
| 19 Packaging | salesforce_packaging_guide.pdf, Second-Generation Managed Packaging Developer Guide.pdf | 2026-05-11 |
| 20 Standard Objects | object_reference.pdf | 2026-05-11 |
| 21 Cross-Org Patterns | (project-derived) | 2026-05-11 |

---

**Maintenance note:** This V2 should be re-verified each time Salesforce publishes a new platform release (typically 3×/year: Spring, Summer, Winter).
