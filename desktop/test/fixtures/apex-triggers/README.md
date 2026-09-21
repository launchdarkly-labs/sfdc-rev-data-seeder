# Apex trigger golden corpus (vendored)

The 5 `RDS_*_CpqGuard` triggers, copied verbatim from the frozen Salesforce 2GP
implementation (the in-org predecessor of this engine).

`triggerBodyToggle.test.ts` uses these as a byte-identity corpus: every real
trigger must survive `commentOutBody` → `uncommentBody` unchanged, and wrapping
must be idempotent. They are test INPUT only — nothing here is deployed, and the
app builds the guard triggers it needs at runtime.

Vendored 2026-09-07 when the desktop app moved to its own repo; previously the
test reached up into the Apex tree via `join(__dirname, '..', '..', 'force-app', ...)`.
