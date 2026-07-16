'use client'

import { useState, useEffect, useRef } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import MenuRounded from '@mui/icons-material/MenuRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import AddRounded from '@mui/icons-material/AddRounded';
import Alert from '@mui/material/Alert';
import DocSidebar from './DocSidebar';
import DocViewer from './DocViewer';
import DocGeneratorDialog from './DocGeneratorDialog';

type Doc = {
  id: string;
  title: string;
  date: string;
  tags: string[];
  category: string;
  slug: string;
  content: string;
  excerpt?: string;
  kind?: string;
  status?: string;
  source?: string;
  sourcePath?: string | null;
};

export default function DocsSection() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const requestSequence = useRef(0)
  const requestController = useRef<AbortController | null>(null)
  const initialDeepLinkHandled = useRef(false)

  async function loadDocs(method: 'GET' | 'POST' = 'GET', query = search, preferredId?: string) {
    const sequence = requestSequence.current + 1
    requestSequence.current = sequence
    requestController.current?.abort()
    const controller = new AbortController()
    requestController.current = controller
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams()
      if (query.trim()) params.set('q', query.trim())
      const response = await fetch(`/api/docs${params.size ? `?${params.toString()}` : ''}`, {
        method,
        signal: controller.signal,
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || 'Unable to load documents')
      if (sequence !== requestSequence.current) return
      const nextDocs = (Array.isArray(payload) ? payload : []).map(doc => ({ ...doc, excerpt: doc.excerpt ?? '' })) as Doc[]
      setDocs(nextDocs)
      const docParam = !initialDeepLinkHandled.current && typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('doc')
        : null
      initialDeepLinkHandled.current = true
      const preferred = docParam
        ? nextDocs.find(d => d.slug === docParam || d.id === docParam) || null
        : null
      setSelectedDoc((current) => (preferredId ? nextDocs.find(doc => doc.id === preferredId) : null)
        || (current ? nextDocs.find(doc => doc.id === current.id) : null)
        || preferred
        || nextDocs[0]
        || null)
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      if (sequence !== requestSequence.current) return
      setError(requestError instanceof Error ? requestError.message : 'Unable to load documents')
    } finally {
      if (sequence === requestSequence.current) setLoading(false)
    }
  }

  useEffect(() => {
    requestController.current?.abort()
    requestSequence.current += 1
    const timer = window.setTimeout(() => void loadDocs('GET', search), search ? 250 : 0)
    return () => window.clearTimeout(timer)
    // Search is intentionally the only trigger; loadDocs owns request and selection state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  useEffect(() => () => requestController.current?.abort(), [])

  const selectDoc = (id: string) => {
    const doc = docs.find(d => d.id === id) || null;
    setSelectedDoc(doc);
    setDrawerOpen(false);
    if (doc && typeof window !== 'undefined') {
      const url = new URL(window.location.href)
      url.searchParams.set('doc', doc.slug)
      url.hash = 'docs'
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
  };

  async function handleGenerated(document: { id: string }) {
    setGeneratorOpen(false)
    setSearch('')
    await loadDocs('GET', '', document.id)
  }

  return (
    <Box
      sx={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#0F0F13',
      }}
    >
      <Drawer
        data-testid="docs-navigation"
        anchor="left"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={{ display: { xs: 'block', md: 'none' } }}
        PaperProps={{
          id: 'docs-navigation-drawer',
          'data-testid': 'docs-navigation-drawer',
          sx: {
            width: 'min(280px, 86vw)',
            maxWidth: '100vw',
            backgroundColor: '#1A1A23',
            borderRight: '1px solid #232330',
          },
        }}
        ModalProps={{ keepMounted: true }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <Typography variant="subtitle2" fontWeight={700} color="text.primary">Docs</Typography>
          <IconButton
            data-testid="docs-navigation-close"
            aria-label="Close docs menu"
            onClick={() => setDrawerOpen(false)}
            sx={{ color: 'text.secondary' }}
          >
            <CloseRounded />
          </IconButton>
        </Box>
        <DocSidebar
          docs={docs}
          selectedId={selectedDoc?.id ?? null}
          onSelect={selectDoc}
          onRefresh={() => void loadDocs('POST', search)}
          onCreate={() => setGeneratorOpen(true)}
          refreshing={loading}
          search={search}
          onSearch={setSearch}
        />
      </Drawer>
      {/* Desktop Sidebar */}
      <Box
        sx={{
          display: { xs: 'none', md: 'flex' },
          width: 280,
          flexShrink: 0,
          backgroundColor: '#1A1A23',
          borderRight: '1px solid #232330',
          height: '100%',
        }}
      >
        <DocSidebar
          docs={docs}
          selectedId={selectedDoc?.id ?? null}
          onSelect={selectDoc}
          onRefresh={() => void loadDocs('POST', search)}
          onCreate={() => setGeneratorOpen(true)}
          refreshing={loading}
          search={search}
          onSearch={setSearch}
        />
      </Box>
      {/* Main Content */}
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          height: '100%',
          backgroundColor: '#0F0F13',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        <Box
          data-testid="docs-mobile-toolbar"
          sx={{
            display: { xs: 'flex', md: 'none' },
            alignItems: 'center',
            gap: 1,
            minHeight: 56,
            px: 1.5,
            flexShrink: 0,
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
              minHeight: 44,
              px: 0.75,
              gap: 0.5,
            },
          }}
        >
          <IconButton
            data-testid="docs-navigation-toggle"
            aria-label="Open docs menu"
            aria-controls="docs-navigation-drawer"
            aria-expanded={drawerOpen}
            aria-haspopup="dialog"
            onClick={() => setDrawerOpen(true)}
            sx={{
              color: '#A8C7FA',
              width: 44,
              height: 44,
              '&:hover': { backgroundColor: 'rgba(168,199,250,0.08)' },
              '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
                width: 36,
                height: 36,
              },
            }}
          >
            <MenuRounded />
          </IconButton>
          <Typography
            variant="body2"
            fontWeight={600}
            color="text.primary"
            sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {selectedDoc?.title || 'Docs'}
          </Typography>
          <IconButton
            aria-label="New document"
            onClick={() => setGeneratorOpen(true)}
            disabled={loading}
            sx={{ color: 'text.secondary', ml: 'auto' }}
          >
            <AddRounded />
          </IconButton>
          <IconButton
            aria-label="Refresh document briefs"
            onClick={() => void loadDocs('POST', search)}
            disabled={loading}
            sx={{ color: 'text.secondary' }}
          >
            <RefreshRounded />
          </IconButton>
        </Box>
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <DocViewer doc={selectedDoc} loading={loading} />
        </Box>
      </Box>
      <DocGeneratorDialog
        open={generatorOpen}
        onClose={() => setGeneratorOpen(false)}
        onGenerated={handleGenerated}
      />
    </Box>
  );
}
