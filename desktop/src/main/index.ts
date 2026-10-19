import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { Store } from './services/store'
import { TokenVault } from './services/tokenVault'
import { JobManager } from './jobs'
import { IPC } from '../shared/types'

let store: Store | null = null

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'Rev Data Seeder',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // A1 hardening: the preload is fully bundled (only require('electron') at
      // runtime), so the OS-level renderer sandbox can stay on.
      sandbox: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Renderer origin lockdown (A1 hardening). The dev-server URL is honored ONLY
  // in an unpackaged run (electron-vite dev). In a packaged build we ALWAYS load
  // from disk and never from an env-var-supplied origin — otherwise a local
  // attacker could `ELECTRON_RENDERER_URL=https://evil open -a 'RDS Desktop'`
  // and get attacker JS in the privileged renderer with the full window.rds IPC
  // bridge (org enumeration, role mutation, live token mint). No fuse covers
  // this; it's an app-layer gate.
  const devUrl = process.env.ELECTRON_RENDERER_URL
  const allowedOrigin = !app.isPackaged && devUrl ? new URL(devUrl).origin : null
  if (allowedOrigin) {
    void win.loadURL(devUrl!)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Belt-and-suspenders: block any top-level navigation away from the loaded
  // origin (file:// in prod, the dev server in dev). SPA hash-routing does not
  // trigger will-navigate, so this only fires on a real navigation attempt.
  const isAllowedTarget = (url: string): boolean => {
    if (url.startsWith('file://')) return true
    if (allowedOrigin) {
      try {
        return new URL(url).origin === allowedOrigin
      } catch {
        return false
      }
    }
    return false
  }
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedTarget(url)) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })
}

app.whenReady().then(() => {
  // Startup must fail LOUD: an exception here (e.g. a wrong-ABI
  // better_sqlite3.node inside the packaged asar) previously became an
  // unhandled rejection — the app sat alive with no window and no error.
  try {
    store = new Store(join(app.getPath('userData'), 'rds-desktop.db'))
    // S47 startup reconciliation (the desktop's RDS_Watchdog): runs the app
    // died on park Stalled; attempts that died before createRun close Failed
    // with an honest note. No job can be running yet, so this is safe.
    const swept = store.reconcileOnStartup()
    if (swept.stalledRuns > 0 || swept.interruptedAttempts > 0) {
      console.warn(
        `[rds] startup reconciliation: ${swept.stalledRuns} run(s) parked Stalled, ` +
          `${swept.interruptedAttempts} interrupted attempt(s) closed Failed`
      )
    }
    // One bus: broadcast every job event to all renderer windows (they filter by jobId).
    const jobs = new JobManager((event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.jobEvents, event)
      }
    })
    // safeStorage is only usable after app-ready. The vault construction never
    // touches the cipher, so CLI-only sessions boot fine on a keychain-less machine.
    const vault = new TokenVault(store, safeStorage)
    registerIpc(store, jobs, vault)
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  } catch (e) {
    dialog.showErrorBox(
      'RDS Desktop failed to start',
      e instanceof Error ? (e.stack ?? e.message) : String(e)
    )
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  // macOS convention: app lives until Cmd+Q
  if (process.platform !== 'darwin') app.quit()
})

app.on('quit', () => {
  store?.close()
})
