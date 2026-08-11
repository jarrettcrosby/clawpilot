'use client'

import { useEffect, useRef, useState } from 'react'
import Alert from '@mui/material/Alert'
import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Chip from '@mui/material/Chip'
import CircularProgress from '@mui/material/CircularProgress'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'
import LinkRounded from '@mui/icons-material/LinkRounded'
import SecurityRounded from '@mui/icons-material/SecurityRounded'

type GoogleCredentialResponse = { credential?: string }
type GoogleIdentityServices = {
  accounts: {
    id: {
      initialize: (input: {
        client_id: string
        callback: (response: GoogleCredentialResponse) => void
        auto_select?: boolean
        cancel_on_tap_outside?: boolean
      }) => void
      renderButton: (
        element: HTMLElement,
        options: Record<string, string | number | boolean>,
      ) => void
      cancel: () => void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentityServices
  }
}

type GooglePolicy = {
  organizationId: string
  organizationName: string
  linkingAvailable: boolean
  enabled: boolean
  rowVersion: number
  canManage: boolean
  platformConfigured: boolean
  webClientId: string | null
  impersonating: boolean
  identity: {
    linked: boolean
    email: string
    linkedAt: string | null
  }
}

type PolicyPayload = {
  ok?: boolean
  code?: string
  error?: string
  policy?: GooglePolicy
}

type LinkPayload = {
  ok?: boolean
  code?: string
  error?: string
  identity?: GooglePolicy['identity'] & { alreadyLinked?: boolean }
}

let googleIdentityScript: Promise<void> | null = null

function loadGoogleIdentityServices(): Promise<void> {
  if (window.google?.accounts.id) return Promise.resolve()
  if (googleIdentityScript) return googleIdentityScript
  googleIdentityScript = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    )
    // A failed dynamic script element never fires load/error again when a user
    // revisits Security or taps retry. Replace it so iOS standalone/Safari can
    // recover from a transient GIS or network load failure without a reload.
    existing?.remove()
    const script = document.createElement('script')
    let settled = false
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      callback()
    }
    const loaded = () => finish(() => window.google?.accounts.id
      ? resolve()
      : reject(new Error('Google account linking did not initialize')))
    const failed = () => finish(() => reject(new Error('Google account linking could not be loaded')))
    const timeout = window.setTimeout(failed, 12_000)
    script.addEventListener('load', loaded, { once: true })
    script.addEventListener('error', failed, { once: true })
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    document.head.appendChild(script)
  }).catch((error) => {
    googleIdentityScript = null
    throw error
  })
  return googleIdentityScript!
}

async function jsonRequest<T extends { ok?: boolean; error?: string }>(
  url: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const payload = await response.json().catch(() => ({})) as T
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || 'Google sign-in request failed')
  }
  return payload
}

function mutationKey(prefix: string) {
  return `${prefix}:${crypto.randomUUID()}`
}

export default function GoogleAuthSettingsPanel() {
  const buttonRef = useRef<HTMLDivElement | null>(null)
  const [policy, setPolicy] = useState<GooglePolicy | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scriptFailed, setScriptFailed] = useState(false)
  const [scriptAttempt, setScriptAttempt] = useState(0)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const payload = await jsonRequest<PolicyPayload>('/api/auth/google/policy')
      if (!payload.policy) throw new Error('Google sign-in settings were not returned')
      setPolicy(payload.policy)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load Google sign-in settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  useEffect(() => {
    const button = buttonRef.current
    if (
      !button
      || !policy?.linkingAvailable
      || !policy.platformConfigured
      || !policy.webClientId
      || policy.identity.linked
      || policy.impersonating
    ) return

    let active = true
    setScriptFailed(false)
    button.replaceChildren()
    void loadGoogleIdentityServices()
      .then(() => {
        if (!active || !window.google?.accounts.id || !buttonRef.current) return
        window.google.accounts.id.initialize({
          client_id: policy.webClientId!,
          auto_select: false,
          cancel_on_tap_outside: true,
          callback: (response) => {
            const credential = String(response.credential || '').trim()
            if (!credential || !active) {
              setError('Google did not return a verified identity token.')
              return
            }
            setPending('link')
            setError('')
            setNotice('')
            void jsonRequest<LinkPayload>('/api/auth/google/link', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': mutationKey('google-link'),
              },
              body: JSON.stringify({
                idToken: credential,
              }),
            }).then((payload) => {
              if (!payload.identity) throw new Error('Google account link was not returned')
              setPolicy((current) => current ? {
                ...current,
                identity: {
                  linked: true,
                  email: payload.identity!.email,
                  linkedAt: payload.identity!.linkedAt,
                },
              } : current)
              setNotice(`Google account linked to ${payload.identity.email}.`)
            }).catch((linkError) => {
              setError(linkError instanceof Error ? linkError.message : 'Unable to link Google account')
            }).finally(() => setPending(''))
          },
        })
        window.google.accounts.id.renderButton(buttonRef.current, {
          type: 'standard',
          theme: 'filled_black',
          size: 'large',
          text: 'continue_with',
          shape: 'rectangular',
          logo_alignment: 'left',
          width: Math.min(360, Math.max(240, button.clientWidth || 320)),
        })
      })
      .catch((scriptError) => {
        if (active) {
          setScriptFailed(true)
          setError(scriptError instanceof Error ? scriptError.message : 'Unable to load Google account linking')
        }
      })
    return () => {
      active = false
      window.google?.accounts.id.cancel()
      button.replaceChildren()
    }
  }, [policy, scriptAttempt])

  if (loading) {
    return <Box display="grid" sx={{ minHeight: 150, placeItems: 'center' }}><CircularProgress size={24} /></Box>
  }

  return (
    <Box component="section" data-testid="google-auth-settings">
      <Stack direction="row" spacing={0.75} alignItems="center" mb={0.75}>
        <SecurityRounded sx={{ fontSize: 20, color: 'text.secondary' }} />
        <Typography variant="subtitle2" color="text.primary" fontWeight={700}>Google account</Typography>
        {policy?.identity.linked ? <Chip size="small" color="success" label="Linked" sx={{ height: 24 }} /> : null}
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Magic codes remain available. Link Google only after signing in to the existing ClawPilot account with the same email address.
      </Typography>

      {error ? <Alert severity="error" onClose={() => setError('')} sx={{ mt: 1.5, borderRadius: '8px' }}>{error}</Alert> : null}
      {notice ? <Alert severity="success" onClose={() => setNotice('')} sx={{ mt: 1.5, borderRadius: '8px' }}>{notice}</Alert> : null}

      {policy ? (
        <Box sx={{ mt: 1.5, p: 1.5, border: '1px solid rgba(255,255,255,0.08)', borderRadius: '8px' }}>
          <Typography variant="body2" color="text.primary" fontWeight={700}>Your ClawPilot account</Typography>
          <Typography variant="caption" color="text.disabled" display="block" sx={{ mt: 0.5 }}>
            Google linking belongs only to this user. Once linked, this exact user can sign in and switch among every direct active organization membership. It does not enable Google for any other user.
          </Typography>

          {!policy.platformConfigured ? (
            <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>
              The platform Google OAuth client is not configured. Magic-code sign-in is unaffected.
            </Alert>
          ) : null}
          {policy.impersonating ? (
            <Alert severity="warning" sx={{ mt: 1.5, borderRadius: '8px' }}>
              Exit user view before linking a Google account.
            </Alert>
          ) : null}

          <Box sx={{ mt: 1.5 }}>
            {policy.identity.linked ? (
              <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                <LinkRounded color="success" fontSize="small" />
                <Typography variant="body2" color="text.primary" sx={{ overflowWrap: 'anywhere' }}>
                  {policy.identity.email}
                </Typography>
                <Chip size="small" variant="outlined" label="This user only" />
              </Stack>
            ) : policy.linkingAvailable && !policy.impersonating ? (
              <Box>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                  Choose exactly {policy.identity.email}. A different Google email will be rejected and cannot create or merge another user.
                </Typography>
                <Box ref={buttonRef} sx={{ minHeight: 44, maxWidth: 360, opacity: pending === 'link' ? 0.55 : 1 }} />
                {scriptFailed ? (
                  <Stack spacing={0.75} alignItems="flex-start" sx={{ mt: 1 }}>
                    <Button
                      size="small"
                      variant="outlined"
                      onClick={() => {
                        setError('')
                        setScriptAttempt((attempt) => attempt + 1)
                      }}
                    >
                      Retry Google link
                    </Button>
                    <Typography variant="caption" color="text.secondary">
                      You can also sign in to the iPhone app with a magic code, then open Settings → Security and tap Link my Google account.
                    </Typography>
                  </Stack>
                ) : null}
                {pending === 'link' ? <CircularProgress size={18} sx={{ mt: 1 }} /> : null}
              </Box>
            ) : (
              <Typography variant="caption" color="text.disabled">
                Google account linking is unavailable until the platform OAuth client is configured.
              </Typography>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  )
}
