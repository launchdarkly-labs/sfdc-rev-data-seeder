# OAuth runbook — your own External Client App for RDS Desktop

RDS Desktop signs in to Salesforce through the `sf` CLI by default and needs no OAuth setup. The
**Add an org via OAuth** path on the Connections page is optional: it authenticates in the browser
with a PKCE loopback flow and needs an OAuth client that **you** create and own. The public build
ships with none — the consumer key is a build-time value you supply.

## Why an External Client App (ECA), not a classic Connected App

- **Consumer keys cannot be deployed org-to-org.** A classic Connected App mints a new consumer key
  in every org it is deployed to, so one baked-in key cannot work everywhere.
- **An ECA keeps its OAuth consumer credentials as GLOBAL settings in its home org**, shared by every
  org the ECA is distributed to. One key, every org.
- The classic Connected App → ECA migration window has closed; ECAs are the supported forward path.
- **Public client, PKCE, NO consumer secret — ever.** The desktop app is a public client: the
  consumer key is a public identifier, and a secret is never created, stored, or committed.

## Part A — Create the ECA (one-time, about 20 minutes)

Pick a **home org** that will outlive your sandboxes (a Developer Edition org, your Dev Hub, or
production). The ECA and its global OAuth credentials live there permanently.

1. **Setup → External Client App Manager → New External Client App** (the Setup node is
   `ManageExternalClientApplication`).
2. Name it, e.g. **RDS Desktop**, with your contact email. Distribution State **Packageable** if you
   intend to distribute it to other orgs (Part B); **Local** otherwise.
3. **OAuth Settings → Enable OAuth.**
   - **Callback URLs** — add all three, newline-separated (Salesforce has no port-agnostic matching;
     the app tries the ports in order):
     - `http://localhost:53682/callback`
     - `http://localhost:53683/callback`
     - `http://localhost:53684/callback`
     - ⚠️ **Use `localhost`, not `127.0.0.1`.** `http://localhost` is the only plain-HTTP callback
       Salesforce accepts; `http://127.0.0.1` is rejected with "Cannot be an HTTP URL". The app's
       loopback server binds so that the browser's `localhost` request reaches it.
   - **OAuth Scopes:** `Manage user data via APIs (api)` and
     `Perform requests at any time (refresh_token, offline_access)`.
   - **Require secret for the Authorization Code and Credentials Flows: OFF** (public client).
     **Require Proof Key for Code Exchange (PKCE): ON.**
   - Leave **Require secret for Refresh Token Flow OFF**.
4. **Policies:** IP relaxation, refresh-token lifetime and permitted users per your org's standard —
   these are subscriber-adjustable later.
5. Save. The consumer credentials are generated once, in the home org.
6. **Copy the Consumer Key:** ECA → Settings → OAuth Settings → *Consumer Key* (a short verification
   step may be required). There is no secret to copy.

Verify (read-only):

```bash
sf data query --use-tooling-api -o <home-org-alias> -q "SELECT Id, DeveloperName, Label FROM ExternalClientApplication"
```

## Part B — Distribute the ECA to other orgs (optional)

Every org you will sign in to with OAuth needs the ECA. For a single org, create it there (Part A).
To reuse one ECA across many orgs, package it as an **unlocked 2GP** and install it:

1. Add a package directory and an unlocked package to `sfdx-project.json` (no namespace required).
2. Retrieve only the ECA metadata into it: `ExternalClientApplication` + `ExtlClntAppOauthSettings`
   (+ `ExtlClntAppGlobalOauthSettings` if your org emits it).
3. Create the package and a version against your Dev Hub:
   ```bash
   sf package create --name "RDS ECA Connector" --package-type Unlocked --path <dir> --target-dev-hub <devhub>
   sf package version create --package "RDS ECA Connector" --target-dev-hub <devhub> --installation-key-bypass --code-coverage --wait 30
   ```
4. **Install into each org.** When the installer asks about OAuth credentials, choose **share the
   existing consumer credentials** so the installed ECA answers to the same consumer key.
5. In RDS Desktop, **Connections → Add an org via OAuth → Sign in** against that org's My Domain.

Key stability comes from the ECA's global-credentials model, not from the package type, so unlocked
is fine. If an org refuses to share global credentials, create a local ECA there and use that key
for that one connection.

## Part C — Give the key to the build

The consumer key is read at build time from `desktop/.env.local` (gitignored; copy
`desktop/.env.example`):

```
MAIN_VITE_OAUTH_CLIENT_ID=<your consumer key>
```

electron-vite inlines `MAIN_VITE_*` variables into the main process, so the key bakes into the
packaged app. It is a public-client identifier, not a secret — but keep it out of tracked files all
the same; a build with no key disables the OAuth path with a clear error and leaves CLI sign-in
untouched.

## Where the desktop side consumes this

- `src/main/services/oauthFlow.ts` — PKCE loopback on `localhost:53682-4`, public-client token
  exchange (no secret), refresh grant.
- `src/main/services/tokenProvider.ts` behind the guarded org — the `oauth` kind uses the encrypted
  token vault and a refresh function; a 401 refreshes once and retries.
- The production pin and the role rules apply to OAuth connections exactly as to CLI ones.
