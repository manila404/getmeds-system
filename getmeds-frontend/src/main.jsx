import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import App from './App.jsx'
import { AuthProvider } from './context/AuthContext.jsx'
import { DebugProvider } from './context/DebugContext.jsx'
// Sep 2, 2026: mounted ABOVE the router on purpose. A Quick Sync / Full
// Resync has to keep being watched when you click to another tab — while the
// job id lived in the page's own useState, navigating away unmounted it and
// the pull only looked like it had stopped. See context/SyncJobsContext.jsx.
import { SyncJobsProvider } from './context/SyncJobsContext.jsx'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <DebugProvider>
          <SyncJobsProvider>
            <App />
            <Toaster
              position="top-right"
              containerStyle={{ zIndex: 999999 }}
              toastOptions={{
                duration: 4000,
                style: {
                  background: '#1E293B',
                  color: '#fff',
                  fontSize: '14px',
                  fontWeight: '500',
                  padding: '12px 16px',
                  borderRadius: '8px'
                }
              }}
            />
          </SyncJobsProvider>
        </DebugProvider>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>,
)
