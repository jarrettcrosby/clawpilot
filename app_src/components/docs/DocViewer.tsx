'use client'

import Box from '@mui/material/Box'
import Typography from '@mui/material/Typography'
import Chip from '@mui/material/Chip'
import Divider from '@mui/material/Divider'
import CircularProgress from '@mui/material/CircularProgress'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import InsertDriveFileRounded from '@mui/icons-material/InsertDriveFileRounded'
import { Children, isValidElement, cloneElement, type ReactNode } from 'react'
import CheckCircleRounded from '@mui/icons-material/CheckCircleRounded'
import CancelRounded from '@mui/icons-material/CancelRounded'
import WarningAmberRounded from '@mui/icons-material/WarningAmberRounded'
import InfoRounded from '@mui/icons-material/InfoRounded'
import StarRounded from '@mui/icons-material/StarRounded'
import RadioButtonCheckedRounded from '@mui/icons-material/RadioButtonCheckedRounded'
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded'

type Doc = {
  id: string
  title: string
  date: string
  tags: string[]
  category: string
  content: string
  kind?: string
  status?: string
  source?: string
  sourcePath?: string | null
}
type Props = { doc: Doc | null; loading?: boolean }

function stripLeadingMarkdownTitle(content: string, title: string): string {
  const match = content.match(/^\s*#\s+([^\n]+)\n/)
  if (!match) return content

  const heading = match[1].trim().toLowerCase()
  const normalizedTitle = title.trim().toLowerCase()
  if (heading !== normalizedTitle) return content

  return content.slice(match[0].length)
}

function repositoryLink(doc: Doc, href: string | undefined): string | undefined {
  if (!href || !doc.sourcePath || /^(?:https?:|mailto:|#|\/)/i.test(href)) return href
  const [target] = href.split('#', 1)
  if (!target.toLowerCase().endsWith('.md')) return href
  const base = doc.sourcePath.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') base.pop()
    else base.push(part)
  }
  const slug = `repo-${base.join('-')}`
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180)
  return `/?doc=${encodeURIComponent(slug)}#docs`
}

const EMOJI_ICONS: Record<string, { icon: React.ElementType; color: string }> = {
  '✅': { icon: CheckCircleRounded, color: '#66BB6A' },
  '❌': { icon: CancelRounded, color: '#EF5350' },
  '⚠️': { icon: WarningAmberRounded, color: '#FFA726' },
  '⚠': { icon: WarningAmberRounded, color: '#FFA726' },
  'ℹ️': { icon: InfoRounded, color: '#42A5F5' },
  '🔴': { icon: RadioButtonCheckedRounded, color: '#EF5350' },
  '🟡': { icon: RadioButtonCheckedRounded, color: '#FFA726' },
  '🟢': { icon: RadioButtonCheckedRounded, color: '#66BB6A' },
  '⭐': { icon: StarRounded, color: '#FDD663' },
  '→': { icon: ArrowForwardRounded, color: '#A8C7FA' },
  '➡️': { icon: ArrowForwardRounded, color: '#A8C7FA' },
}

function renderTextWithIcons(text: string): ReactNode[] {
  const emojiKeys = Object.keys(EMOJI_ICONS)
  const parts: ReactNode[] = []
  let remaining = text
  let i = 0
  while (remaining.length > 0) {
    let found = false
    for (const emoji of emojiKeys) {
      if (remaining.startsWith(emoji)) {
        const { icon: Icon, color } = EMOJI_ICONS[emoji]
        parts.push(
          <Icon key={i++} sx={{ fontSize: 16, color, verticalAlign: 'middle', mr: 0.25, mb: 0.25 }} />
        )
        remaining = remaining.slice(emoji.length)
        found = true
        break
      }
    }
    if (!found) {
      let j = 0
      while (j < remaining.length && !emojiKeys.some(e => remaining.slice(j).startsWith(e))) j++
      parts.push(remaining.slice(0, j) as ReactNode)
      remaining = remaining.slice(j)
    }
  }
  return parts
}
// Walk React children recursively — replace emoji strings with MUI icons
// Required for react-markdown v10 which dropped the 'text' component override
function applyIcons(children: ReactNode): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === 'string') {
      const parts = renderTextWithIcons(child)
      if (parts.length === 1 && typeof parts[0] === 'string') return parts[0]
      return <>{parts}</>
    }
    if (isValidElement(child) && child.props && (child.props as {children?: ReactNode}).children) {
      return cloneElement(child as React.ReactElement<{children?: ReactNode}>, {
        children: applyIcons((child.props as {children?: ReactNode}).children),
      })
    }
    return child
  })
}


export default function DocViewer({ doc, loading }: Props) {
  if (!doc && !loading) return (
    <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F0F13', gap: 2 }}>
      <InsertDriveFileRounded sx={{ fontSize: 56, color: 'rgba(255,255,255,0.1)' }} />
      <Typography variant="h6" color="text.secondary" fontWeight={500}>Select a document</Typography>
      <Typography variant="body2" color="text.disabled">Your document workspace is ready</Typography>
    </Box>
  )

  if (loading) return (
    <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0F0F13' }}>
      <CircularProgress size={32} sx={{ color: '#A8C7FA' }} />
    </Box>
  )

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: '#0F0F13', overflow: 'hidden' }}>

      <Box sx={{
        px: { xs: 2, sm: 3, md: 5 }, pt: { xs: 2.5, md: 4 }, pb: 3,
        backgroundColor: 'rgba(15,15,19,0.96)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
          px: 1.5,
          pt: 0.5,
          pb: 0.75,
        },
      }}>
        <Typography variant="overline" sx={{
          color: '#A8C7FA', fontSize: '0.65rem', letterSpacing: 2, fontWeight: 600,
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': { display: 'none' },
        }}>
          {doc!.category.toUpperCase()}
        </Typography>
        <Typography variant="h3" fontWeight={700} color="text.primary" sx={{
          mt: 0.5, mb: 2, lineHeight: 1.2, fontSize: { xs: '1.5rem', md: '2rem' }, overflowWrap: 'anywhere',
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
            mt: 0,
            mb: 0.5,
            fontSize: '1rem',
            lineHeight: 1.15,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          },
        }}>
          {doc!.title}
        </Typography>
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap',
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': {
            gap: 0.5,
            flexWrap: 'nowrap',
            overflowX: 'auto',
            WebkitOverflowScrolling: 'touch',
            '& > *': { flexShrink: 0 },
          },
        }}>
          <Typography variant="caption" sx={{ color: 'text.disabled', fontSize: '0.75rem' }}>{doc!.date}</Typography>
          {doc!.status && (
            <Chip label={doc!.status} size="small" variant="outlined"
              sx={{ height: 22, fontSize: '0.7rem', borderColor: 'rgba(255,255,255,0.12)', color: 'text.secondary', borderRadius: 1.5 }} />
          )}
          {doc!.source && (
            <Chip label={doc!.source === 'repository' ? 'ClawPilot knowledge' : doc!.source} size="small" variant="outlined"
              sx={{ height: 22, fontSize: '0.7rem', borderColor: 'rgba(255,255,255,0.12)', color: 'text.secondary', borderRadius: 1.5 }} />
          )}
          {doc!.tags.map(tag => (
            <Chip key={tag} label={tag} size="small" variant="outlined"
              sx={{ height: 22, fontSize: '0.7rem', borderColor: 'rgba(255,255,255,0.12)', color: 'text.secondary', borderRadius: 1.5 }} />
          ))}
        </Box>
      </Box>

      <Box
        data-testid="docs-reader"
        sx={{
          flex: 1, minHeight: 0, overflow: 'auto', px: { xs: 2, sm: 3, md: 5 }, py: { xs: 3, md: 4 },
          '@media (orientation: landscape) and (max-height: 500px) and (max-width: 899.95px)': { px: 1.5, py: 1 },
        }}
      >
        <Box sx={{ maxWidth: 740 }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              // applyIcons wraps every text-bearing component so emoji → MUI icons works in react-markdown v10
              h1: ({ children }) => <Typography variant="h4" fontWeight={700} sx={{ mt: 4, mb: 2, color: 'text.primary', lineHeight: 1.3 }}>{children}</Typography>,
              h2: ({ children }) => <Typography variant="h5" fontWeight={600} sx={{ mt: 3.5, mb: 1.5, color: 'text.primary' }}>{children}</Typography>,
              h3: ({ children }) => <Typography variant="h6" fontWeight={600} sx={{ mt: 3, mb: 1, color: 'text.primary' }}>{children}</Typography>,
              p: ({ children }) => <Typography variant="body1" sx={{ mb: 2, color: 'rgba(228,225,236,0.85)', lineHeight: 1.85 }}>{applyIcons(children as ReactNode)}</Typography>,
              ul: ({ children }) => <Box component="ul" sx={{ mb: 2, pl: 3, '& li': { mb: 0.75 } }}>{children}</Box>,
              ol: ({ children }) => <Box component="ol" sx={{ mb: 2, pl: 3, '& li': { mb: 0.75 } }}>{children}</Box>,
              li: ({ children }) => <Typography component="li" variant="body1" sx={{ color: 'rgba(228,225,236,0.85)', lineHeight: 1.75 }}>{applyIcons(children as ReactNode)}</Typography>,
              strong: ({ children }) => <Box component="strong" sx={{ color: 'text.primary', fontWeight: 700 }}>{children}</Box>,
              blockquote: ({ children }) => (
                <Box component="blockquote" sx={{ borderLeft: '3px solid #A8C7FA', pl: 2.5, ml: 0, my: 2.5, color: 'text.secondary', fontStyle: 'italic' }}>
                  {children}
                </Box>
              ),
              code: ({ children }) => {
                const isBlock = String(children).includes('\n')
                return isBlock
                  ? <Box component="pre" sx={{ backgroundColor: '#1A1A2E', borderRadius: 2, p: 2.5, mb: 2.5, overflow: 'auto', border: '1px solid rgba(255,255,255,0.08)' }}>
                      <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.85rem', color: '#A8C7FA', display: 'block' }}>{children}</Box>
                    </Box>
                  : <Box component="code" sx={{ backgroundColor: '#1E2030', borderRadius: 1, px: 0.75, py: 0.25, fontFamily: 'monospace', fontSize: '0.85rem', color: '#CFC6EA' }}>{children}</Box>
              },
              text: ({ children }) => <>{renderTextWithIcons(String(children))}</>,
              table: ({ children }) => (
                <Box sx={{ overflowX: 'auto', mb: 3 }}>
                  <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>{children}</Box>
                </Box>
              ),
              thead: ({ children }) => <Box component="thead" sx={{ '& th': { borderBottom: '2px solid rgba(255,255,255,0.1)', pb: 1, pr: 3, textAlign: 'left', color: 'text.secondary', fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.06em' } }}>{children}</Box>,
              td: ({ children }) => <Box component="td" sx={{ py: 1.5, pr: 3, borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'rgba(228,225,236,0.75)', verticalAlign: 'top' }}>{applyIcons(children as ReactNode)}</Box>,
              hr: () => <Divider sx={{ my: 3.5, borderColor: 'rgba(255,255,255,0.07)' }} />,
              a: ({ href, children }) => <Box component="a" href={repositoryLink(doc!, href)} sx={{ color: '#A8C7FA', textDecoration: 'none', borderBottom: '1px solid rgba(168,199,250,0.3)', '&:hover': { borderBottomColor: '#A8C7FA' } }}>{children}</Box>,
            }}
          >
            {stripLeadingMarkdownTitle(doc!.content, doc!.title).trimStart()}
          </ReactMarkdown>
        </Box>
      </Box>
    </Box>
  )
}
