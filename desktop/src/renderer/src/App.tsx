import { useEffect } from 'react'
import { HashRouter, Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { ConfirmProvider } from './ui/ConfirmDialog'
import { ToastProvider, useToast } from './ui/Toast'
import { setAuthExpiredHandler } from './ipc/client'
import { ConnectionsPage } from './pages/Connections'
import { DeploymentDetailPage } from './pages/DeploymentDetail'
import { HomePage } from './pages/Home'
import { HowToPage } from './pages/HowTo'
import { NewDeploymentPage } from './pages/NewDeployment'
import { WizardShell } from './pages/wizard/WizardShell'
import {
  ExtIdsPage,
  HistoryPage,
  NotFoundPage,
  SettingsPage,
  ToolsPage,
  WelcomePage
} from './pages/placeholders'

/** Routes IPC AUTH_EXPIRED errors to a toast (re-auth UX arrives with A7). */
function AuthExpiredBridge(): null {
  const toast = useToast()
  useEffect(() => {
    setAuthExpiredHandler((err) =>
      toast(
        `Session expired${err.connection ? ` for ${err.connection}` : ''} — re-authenticate in Connections.`,
        'error'
      )
    )
    return () => setAuthExpiredHandler(null)
  }, [toast])
  return null
}

export function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <AuthExpiredBridge />
      <ConfirmProvider>
        <HashRouter>
          <Routes>
            <Route element={<AppShell />}>
              <Route index element={<HomePage />} />
              <Route path="connections" element={<ConnectionsPage />} />
              <Route path="extids" element={<ExtIdsPage />} />
              <Route path="history" element={<HistoryPage />} />
              <Route path="tools" element={<ToolsPage />} />
              <Route path="howto" element={<HowToPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="welcome" element={<WelcomePage />} />
              <Route path="deployments/new" element={<NewDeploymentPage />} />
              <Route path="deployments/:id" element={<DeploymentDetailPage />} />
              <Route path="deployments/:id/wizard/:step" element={<WizardShell />} />
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </HashRouter>
      </ConfirmProvider>
    </ToastProvider>
  )
}
