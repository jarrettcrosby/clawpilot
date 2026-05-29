import { ReactNode } from 'react';
import type { Metadata } from 'next';
import ThemeRegistry from '@/components/ThemeRegistry';

function assertDevIsolationEnv() {
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  const cwd = process.cwd()
  const isDevWorktreeRuntime = cwd.includes('/clawd-app-dev/app_src')
  if (!isDevWorktreeRuntime) return

  const required = [
    'TASKS_PATH',
    'PIPELINE_NORMALIZED_PATH',
    'PIPELINE_LOG_PATH',
    'AGENT_THREADS_PATH',
    'AGENT_ASSIGNMENTS_PATH',
  ]

  const missing = required.filter((k) => !process.env[k])
  if (missing.length === 0) return

  throw new Error(
    `Dev runtime requires isolated data env vars. Missing: ${missing.join(', ')}. ` +
    `Start dev via scripts/dev-start.sh (from /Users/agentsuburbiasandwich/Desktop/clawd-app).`
  )
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export const metadata: Metadata = {
  title: '🛩️ ClawPilot',
  description: 'ClawPilot Command Center',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  assertDevIsolationEnv()

  return (
    <html lang="en" style={{ height: '100%' }}>
      <body
        style={{
          margin: 0,
          height: '100dvh',
          overflow: 'auto',
          backgroundColor: '#0F0F13',
        }}
        suppressHydrationWarning
      >
        <ThemeRegistry>{children}</ThemeRegistry>
      </body>
    </html>
  );
}