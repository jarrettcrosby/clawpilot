# ClawPilot App — Agent Memory
Read this at the start of every session. It is the single source of truth for this project.

---

## App Overview
- **What:** ClawPilot command center web app for Jarrett's businesses
- **Stack:** Next.js 16 (App Router), MUI v6, TypeScript, local file system
- **Repo:** `/Users/agentsuburbiasandwich/clawd-app/`
- **Next.js src:** `/Users/agentsuburbiasandwich/clawd-app/app_src/`
- **URL:** http://192.168.4.48:4001
- **Mode:** Production (`npm start --port 4001`) — must rebuild + restart after every change
- **Git:** Local only — no GitHub remote

## How to Deploy Changes
```bash
cd /Users/agentsuburbiasandwich/clawd-app/app_src
npm run build
kill $(pgrep -f "npm start --port 4001")
sleep 1
nohup npm start -- --port 4001 > /tmp/clawd-app.log 2>&1 &
```
Then commit: `cd /Users/agentsuburbiasandwich/clawd-app && git add -A && git commit -m "..."`

---

## Current State (as of 2026-03-01)

### What's Built
| Section | Status | Notes |
|---|---|---|
| Dashboard | ⚠️ Partial | Morning greeting only — no live data cards yet |
| Docs | ✅ Done | Reads from `~/.openclaw/workspace/second-brain/` |
| Projects | ✅ Done | Kanban board, card detail drawer, activity log |
| Pipeline | 🔲 Stub | Placeholder only |
| Agents | 🔲 Stub | Placeholder only |

### Components
- `AppHeader.tsx` — top bar with bell/notification icon, activity log drawer
- `Navigation.tsx` — sidebar (desktop) + bottom bar (mobile)
- `projects/KanbanBoard.tsx` — full kanban with columns
- `projects/KanbanCard.tsx` — individual task cards
- `projects/KanbanColumn.tsx` — column with drag support
- `projects/CardDetailDrawer.tsx` — task detail side drawer
- `projects/BoardActivityDrawer.tsx` — board-level activity feed
- `activity/ActivityLogPage.tsx` — notification bell drawer content
- `docs/DocsSection.tsx` — docs list + viewer shell
- `docs/DocSidebar.tsx` — sidebar nav for docs
- `docs/DocViewer.tsx` — markdown renderer
- `pipeline/PipelineSection.tsx` — stub

### Data
- `data/tasks.json` — task data for Kanban
- `~/.openclaw/workspace/second-brain/` — markdown docs source

### API Routes
- `GET/POST/PATCH /api/tasks` — task CRUD
- `GET /api/docs` — list/fetch docs
- `GET /api/pipeline` — pipeline data (stub)

---

## Recent Changes
| Date | Change | Commit |
|---|---|---|
| 2026-03-01 | Initial commit — full app v1.0 | a8ef5ad |
| 2026-03-01 | Bell icon opacity fix (35% → 60% when no unread) | a8ef5ad |

---

## Next Up (prioritized)
1. Dashboard live data cards (upcoming tasks, doc count, pipeline summary)
2. Pipeline section — EPI sales pipeline data + UI
3. Agents section — ClawPilot agent status display

---

## Design Rules (Non-Negotiable)
- Dark theme always (`#0F0F13` background)
- MUI sx prop only — NO Tailwind, NO custom CSS
- Must work on iPhone Safari (primary device)
- Min touch target 48px
- `npm run build` after every component — catch errors immediately
- Always `'use client'` on components using useState/useEffect

## Known Bugs / Gotchas
- `CATEGORIES.map()` fails — it's a Record, use `Object.entries()`
- `doc.body` doesn't exist — use `doc.content`
- `doc.createdAt` doesn't exist — use `doc.date`
- gray-matter returns Date objects for frontmatter dates — call `.toString()` then slice
- `code` component `inline` prop removed in newer react-markdown — detect newlines in children instead

## Roadmap Notes
- **Settings section** — gear icon in header is the future home. Will hold keyboard shortcuts + app config + user preferences. Add to nav when ready.
- **Pipeline** — stub, needs EPI sales data + UI
- **Agents** — stub, needs ClawPilot agent status display

---

## Overnight Builder Cadence Protocol (Dev Lane)
- Primary delivery lane: `/Users/agentsuburbiasandwich/Desktop/clawd-app-dev`
- Run exactly one small safe slice per overnight execution.
- Before implementation: run launch guard script once and require `CLAWPILOT_BUILDER_LAUNCH_GUARD_OK`.
- Memory contract sequence is mandatory for `main`: preflight → postflight → verify.
- Git discipline for cron slices:
  - Keep commits narrowly scoped (single slice intent)
  - Stage only files for the current slice
  - If no remote is configured, report `local-only` explicitly
- Safety boundaries:
  - No stable/prod mutations from overnight builder lane
  - No secrets changes
  - No deployment architecture changes
