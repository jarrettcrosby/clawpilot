'use client'

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import MenuRounded from '@mui/icons-material/MenuRounded';
import CloseRounded from '@mui/icons-material/CloseRounded';
import DocSidebar from './DocSidebar';
import DocViewer from './DocViewer';

type Doc = {
  id: string;
  title: string;
  date: string;
  tags: string[];
  category: string;
  slug: string;
  content: string;
  excerpt?: string;
};

type RuntimeSummary = { lane?: string; port?: string | number; commit?: string; repoPath?: string }

type PromotionReports = {
  status?: string
  promotionCheck?: {
    status?: string
    timestamp?: string | null
    timestampIso?: string | null
    runtime?: RuntimeSummary
    blockers?: string[]
  }
  promotionDryRun?: {
    status?: string
    timestamp?: string | null
    timestampIso?: string | null
    runtime?: RuntimeSummary
    blockers?: string[]
    alignmentReport?: string | null
    promotionCheckReport?: string | null
    verifyStatus?: string | null
  }
  alignmentDryRun?: {
    status?: string
    timestamp?: string | null
    timestampIso?: string | null
    diffs?: string[]
    missing?: string[]
    purge?: string[]
  }
}

function formatRuntime(runtime?: RuntimeSummary) {
  if (!runtime) return 'Runtime: unknown'
  const lane = runtime.lane || 'unknown'
  const port = runtime.port || 'unknown'
  const commit = runtime.commit ? runtime.commit.slice(0, 7) : 'unknown'
  const repo = runtime.repoPath || 'unknown'
  return `Runtime: ${lane}:${port} • ${commit} • ${repo}`
}

function renderBlockers(blockers?: string[]) {
  if (!blockers || blockers.length === 0) return '- None'
  return blockers.map(b => `- ${b}`).join('\n')
}

function buildPromotionReportDoc(payload: PromotionReports | null) {
  if (!payload || payload.status === 'disabled' || payload.status === 'error') {
    return {
      id: 'promotion-reports',
      title: 'Promotion & Alignment Reports',
      date: '',
      tags: ['read-only'],
      category: 'governance',
      slug: 'promotion-reports',
      content: `# Promotion & Alignment Reports\n\nNo report data available.`,
    }
  }

  const promo = payload.promotionCheck
  const promoDry = payload.promotionDryRun
  const align = payload.alignmentDryRun

  const promoStatus = promo?.status || 'unknown'
  const promoTime = promo?.timestampIso || promo?.timestamp || 'unknown'
  const promoRuntime = formatRuntime(promo?.runtime)
  const promoBlockers = renderBlockers(promo?.blockers)

  const dryStatus = promoDry?.status || 'missing'
  const dryTime = promoDry?.timestampIso || promoDry?.timestamp || 'unknown'
  const dryRuntime = formatRuntime(promoDry?.runtime)
  const dryBlockers = renderBlockers(promoDry?.blockers)
  const dryVerify = promoDry?.verifyStatus || 'unknown'

  const alignStatus = align?.status || 'missing'
  const alignTime = align?.timestampIso || align?.timestamp || 'unknown'
  const diffs = align?.diffs?.length ?? 0
  const missing = align?.missing?.length ?? 0
  const purge = align?.purge?.length ?? 0

  const content = `# Promotion & Alignment Reports\n\n**Read-only report view.**\n\n## Promotion Readiness Check\n- Status: **${promoStatus}**\n- Timestamp: ${promoTime}\n- ${promoRuntime}\n- Blockers:\n${promoBlockers}\n\n## Promotion Dry-Run\n- Status: **${dryStatus}**\n- Timestamp: ${dryTime}\n- ${dryRuntime}\n- Verification: ${dryVerify}\n- Blockers:\n${dryBlockers}\n\n## Alignment Dry-Run\n- Status: **${alignStatus}**\n- Timestamp: ${alignTime}\n- Diffs: ${diffs}\n- Missing: ${missing}\n- Purge: ${purge}\n\n_This view is read-only. Use scripts/promotion-dry-run.sh or scripts/dev-promotion-check.sh to generate new reports._`

  return {
    id: 'promotion-reports',
    title: 'Promotion & Alignment Reports',
    date: '',
    tags: ['read-only'],
    category: 'governance',
    slug: 'promotion-reports',
    content,
  }
}

export default function DocsSection() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/docs').then(r => r.json()).catch(() => []),
      fetch('/api/governance').then(r => r.json()).catch(() => []),
      fetch('/api/promotion-reports').then(r => r.json()).catch(() => null),
    ]).then(([docsData, govData, promoData]) => {
      const docsList = Array.isArray(docsData) ? docsData : []
      const govList = Array.isArray(govData) ? govData : []
      const reportDoc = buildPromotionReportDoc(promoData)
      const merged = [reportDoc, ...govList, ...docsList].filter(Boolean).map(doc => ({
        ...doc,
        excerpt: doc.excerpt ?? '',
      })) as Doc[]
      setDocs(merged)
      const docParam = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('doc')
        : null
      const preferred = docParam
        ? merged.find(d => d.slug === docParam || d.id === docParam) || null
        : null
      if (preferred) setSelectedDoc(preferred)
      else if (merged[0]) setSelectedDoc(merged[0])
      setLoading(false)
    })
  }, [])

  const selectDoc = (id: string) => {
    const doc = docs.find(d => d.id === id) || null;
    setSelectedDoc(doc);
    setDrawerOpen(false);
  };

  return (
    <Box
      sx={{
        display: 'flex',
        height: '100%',
        overflow: 'hidden',
        backgroundColor: '#0F0F13',
      }}
    >
      {/* Mobile Drawer Button */}
      <Box
        sx={{
          display: { xs: 'block', md: 'none' },
        }}
      >
        <IconButton
          aria-label="Open docs menu"
          onClick={() => setDrawerOpen(true)}
          sx={{
            position: 'fixed',
            top: 8,
            left: 8,
            zIndex: 1200,
            backgroundColor: '#1A1A23',
            color: '#A8C7FA',
            width: 48,
            height: 48,
            boxShadow: 2,
            '&:hover': { backgroundColor: '#232330' },
          }}
          size="large"
        >
          <MenuRounded />
        </IconButton>
        <Drawer
          anchor="left"
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          PaperProps={{
            sx: {
              width: 280,
              backgroundColor: '#1A1A23',
              borderRight: '1px solid #232330',
            },
          }}
          ModalProps={{ keepMounted: true }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1.5, py: 1.25, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <Typography variant="subtitle2" fontWeight={700} color="text.primary">Docs</Typography>
            <IconButton aria-label="Close docs menu" onClick={() => setDrawerOpen(false)} sx={{ color: 'text.secondary' }}>
              <CloseRounded />
            </IconButton>
          </Box>
          <DocSidebar
            docs={docs}
            selectedId={selectedDoc?.id ?? null}
            onSelect={selectDoc}
          />
        </Drawer>
      </Box>
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
        }}
      >
        <DocViewer doc={selectedDoc} loading={loading} />
      </Box>
    </Box>
  );
}