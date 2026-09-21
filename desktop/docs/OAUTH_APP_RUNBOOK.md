# OAUTH_APP_RUNBOOK — RDS Desktop OAuth app (External Client App)

**Decision (S32, 2026-07-24):** RDS Desktop authenticates to Salesforce via a **new External Client App (ECA)**, not the existing classic "LD SFDC Data Deploy Anywhere" Connected App, and the ECA is distributed as an **unlocked 2GP** package. See `docs/session-31-desktop-full-plan/PLAN.md §9` + the ROADMAP decisions log (2026-07-24).

## Why an ECA and not the classic CA

- **Consumer keys can't be deployed org-to-org.** Once set, a Connected App's consumer key is not writable, so packaging the classic CA makes every installing org mint a *new* key. Our desktop build bakes in **one** default consumer key (a non-secret public-client id) — a per-org key would break it.
- **ECAs store OAuth consumer credentials as GLOBAL settings** in a home org (ldseed), *shared* across all deployments. Installing orgs share the global creds, so the same baked key works everywhere. Only `ExternalClientApplication` + `ExtlClntAppOauthSettings` are packaged.
- Classic CA → ECA migration deadline (2026-05-11) has passed; ECA is the supported forward path.
- **Public client, PKCE, NO consumer secret — ever** (Session-26 leak scar). The consumer key is not a secret for a public client; the secret is never created, stored, or committed.

## Part A — Create the ECA in ldseed (Jack, ~20 min) — task A6

Home org = **ldseed** (`jack@data-deploy.ld`). The ECA and its global OAuth credentials live here permanently (non-ephemeral home org).

1. **Setup → External Client App Manager → New External Client App.** (Setup path `ManageExternalClientApplication` — not `ExternalClientApps`/`ConnectedApplication`.)
2. Name it e.g. **RDS Desktop** (Contact Email = your LD email). Distribution State: **Packageable** (so it can go into a 2GP).
3. **OAuth Settings → Enable OAuth.**
   - **Callback URLs (add all three, newline-separated — Salesforce has no port-agnostic matching):**
     - `http://localhost:53682/callback`
     - `http://localhost:53683/callback`
     - `http://localhost:53684/callback`
     - ⚠️ **Use `localhost`, NOT `127.0.0.1`.** Salesforce allows `http://localhost` as its only HTTP (non-HTTPS) callback exception but rejects `http://127.0.0.1` with "Cannot be an HTTP URL" (confirmed live in ldseed, 2026-07-24). The desktop PKCE flow (A4) must therefore register + send `redirect_uri=http://localhost:PORT/callback` and bind its loopback server so `localhost` reaches it (listen on `127.0.0.1` for IPv4; ensure the browser's `localhost` request resolves to it — beware `localhost`→`::1` IPv6-only binds on macOS).
   - **OAuth Scopes:** `Manage user data via APIs (api)` and `Perform requests at any time (refresh_token, offline_access)`. (Just `api refresh_token`.)
   - **Require secret for the Authorization Code and Credentials Flows: OFF** (public client). If your org shows "Require Proof Key for Code Exchange (PKCE)", turn it **ON**.
   - Leave "Require secret for Refresh Token Flow" **OFF**.
4. **Security / policies:** IP relaxation as your org standard allows; refresh token policy "valid until revoked" (or your standard); permitted users per your org policy. These are subscriber-adjustable later.
5. Save. **Consumer credentials are GLOBAL** for a packageable ECA — they are shared, not packaged.
6. **Retrieve the consumer key:** ECA → Settings → OAuth Settings → **Consumer Key** (the "Consumer Details" view; may require a short verification step). Copy the **Consumer Key only** (there is no secret to copy for a public client).
7. **Report the consumer key** back so it can be baked into the desktop build config (`A6` follow-up). It is a public-client id, not a secret — but still do NOT paste it into a git-tracked file; it goes into build config the same way other non-secret defaults do, with a Settings override.

> **A6 DONE (2026-07-24):** ECA **RDS_Desktop** created in ldseed with the settings above (callbacks use `localhost` — SF rejected `http://127.0.0.1`). Consumer key stored in **gitignored `desktop/.env.local`** as `MAIN_VITE_OAUTH_CLIENT_ID`; `desktop/.env.example` is the tracked template. electron-vite inlines `MAIN_VITE_*` into the main process at build, so the key bakes into the packaged app; the A4 PKCE flow reads `import.meta.env.MAIN_VITE_OAUTH_CLIENT_ID`, with a per-connection Settings override layered on top. Verify: `sf org list metadata -m ExternalClientApplication -o ldseed` lists `RDS_Desktop`.

> Verify (read-only): `sf data query --use-tooling-api -o ldseed -q "SELECT Id, DeveloperName, Label FROM ExternalClientApplication"` should now list the new ECA.

## Part B — Package the ECA (unlocked 2GP) — task E7.8

Goal: a lightweight package an architect can install into any source/target org to enable OAuth there quickly. Only the ECA metadata is packaged; the consumer credentials stay global in ldseed and are shared on install.

1. Add a package directory + package to `sfdx-project.json` (separate from the `Rev Data Seeder` app package), e.g. package alias **RDS ECA Connector**, unlocked, no namespace required.
2. Retrieve the ECA metadata into that directory: `ExternalClientApplication` + `ExtlClntAppOauthSettings` (+ `ExtlClntAppGlobalOauthSettings` if your org emits it). Nothing else.
3. Create the package + a version against the ldseed Dev Hub:
   - `sf package create --name "RDS ECA Connector" --package-type Unlocked --path <dir> --target-dev-hub ldseed`
   - `sf package version create --package "RDS ECA Connector" --target-dev-hub ldseed --installation-key-bypass --code-coverage --wait 30`
4. **Install into a target/source org**, then in that org share the global OAuth creds with the ECA (subscriber orgs choose "share existing consumer credentials" vs "generate new" — choose **share** so the baked key matches).
5. Confirm OAuth: the desktop PKCE loopback flow (A4) against that org's My Domain should complete with the baked consumer key.

> **Double-check note (why unlocked is OK here):** key stability comes from the ECA global-credentials model, not from the package type — so unlocked 2GP is fine for this internal tool. If a future org refuses to share global creds, fall back to per-org key entry in desktop Settings for that one org.

## Where the desktop side consumes this

- **A4** `oauthFlow.ts` — PKCE loopback on `127.0.0.1:53682-4`, public-client token exchange (no secret), refresh grant.
- **A5** TokenProvider behind `GuardedOrg` — `oauth` kind uses the vault + refreshFn; 401→refresh→retry-once.
- Baked default consumer key → build config; **Settings override** per connection.
- Related memory: `project_eca_oauth_packaging`, `feedback_eca_consumer_key`, `feedback_eca_setup_path`, `project_ca_secret_leak_remediation`.
