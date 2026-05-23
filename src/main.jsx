import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.jsx'

const sentryDsn = import.meta.env.VITE_SENTRY_DSN
if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0.1,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0.1,
  })
}

registerSW({ immediate: true })

const AppShell = sentryDsn
  ? Sentry.withErrorBoundary(App, {
      fallback: ({ error, resetError }) => (
        <div style={{ padding: 24, fontFamily: 'system-ui', color: '#0f172a' }}>
          <h1 style={{ fontSize: 20, fontWeight: 800 }}>Something went wrong</h1>
          <p style={{ marginTop: 8 }}>
            We logged this and will look at it. You can try again or refresh the page.
          </p>
          <pre style={{ marginTop: 12, fontSize: 12, color: '#475569', whiteSpace: 'pre-wrap' }}>
            {String(error?.message || error)}
          </pre>
          <button
            type="button"
            onClick={resetError}
            style={{ marginTop: 16, padding: '10px 16px', borderRadius: 16, background: '#0f172a', color: 'white', border: 0, fontWeight: 700, cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      ),
    })
  : App

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
)
