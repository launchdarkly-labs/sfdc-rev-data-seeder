import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import './app.css'
import './styles/p3-components.css'
import './styles/p3-nav-home.css'
import './styles/p3-plan-copy.css'
import './styles/p5-monitor.css'

import { initTheme } from './theme'

// Apply the persisted theme before the first paint (falls back to dark).
void initTheme()
document.title = `Rev Data Seeder ${__APP_VERSION__}`

const container = document.getElementById('root')
if (!container) throw new Error('#root missing')
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
