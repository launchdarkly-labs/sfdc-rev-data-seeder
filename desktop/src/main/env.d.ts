/**
 * Main-process build-time env, inlined by electron-vite from `.env*`.
 * `MAIN_VITE_OAUTH_CLIENT_ID` is the PUBLIC PKCE client id of the RDS_Desktop
 * ECA (A6) — non-secret, but kept only in gitignored `.env.local`. It is
 * consumed once, in ipc.ts, and threaded into the OAuth TokenProvider (A5).
 */
interface ImportMetaEnv {
  readonly MAIN_VITE_OAUTH_CLIENT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
