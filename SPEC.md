# ClawPilot App — Product Spec
Version: 1.0 | Started: 2026-03-01

## Vision
A single web application that serves as the command center for Jarrett's business empire.
- Jarrett browses it on his iPhone and Mac
- ClawPilot pushes live updates to it (new docs, task status, pipeline data)
- It feels like a real product: Linear + Obsidian + Material Design 3

## Tech Stack
- **Framework**: Next.js 14 (App Router)
- **UI Library**: MUI v6 with Material Design 3 theme
- **Language**: TypeScript
- **Styling**: MUI sx prop + emotion (NO Tailwind — caused inconsistency)
- **Backend**: Next.js API routes
- **Data**: File system (markdown) + JSON files for tasks/projects
- **Port**: 4000

## Design System
Material Design 3 — dark theme
- Background: #0F0F13 (near-black with slight warm tone)
- Surface: #1A1A23
- Surface variant: #232330  
- Primary: #A8C7FA (M3 primary blue)
- Secondary: #CFC6EA (M3 secondary purple)
- On-surface: #E4E1EC
- Outline: #46464F

Reference: https://m3.material.io/

## Navigation (bottom nav on mobile, sidebar on desktop)
5 sections:
1. **Dashboard** — Morning briefing card, quick stats, recent activity
2. **Docs** — Document viewer (Obsidian-style)
3. **Projects** — Kanban board (Linear-style)
4. **Pipeline** — EPI sales pipeline
5. **Agents** — ClawPilot agent status

## Document System
- Source folder: ~/.openclaw/workspace/second-brain/
- Categories: daily | epi | suburbia | clawpilot | p9ine | concepts
- API: GET /api/docs — list all, GET /api/docs?id=xxx — single doc
- ClawPilot writes new .md files here, app picks them up automatically

## Project/Task System  
- Data: ~/clawd-app/data/tasks.json
- Task fields: id, title, desc, status (backlog|todo|in-progress|review|done), priority, category, tags, createdAt, updatedAt
- API: GET/POST/PATCH /api/tasks
- ClawPilot can push new tasks via API

## ClawPilot Integration API
- POST /api/clawpilot/push — push updates (new doc, task update, pipeline refresh)
- GET /api/clawpilot/status — current agent statuses
- This is how I (ClawPilot) interact with the app programmatically

## Mobile-First Rules
- Bottom navigation bar on mobile (<md)
- Sidebar navigation on desktop (md+)
- Min touch target: 48px
- No hover-only interactions
- Test on iPhone Safari before declaring done

## Quality Bar
The app must feel like a real product a VC-backed startup would ship.
Reference apps: Linear (project management), Obsidian (docs), Raycast (clean dark UI)

## Deployment Model
- **Now**: Local only — runs on Mac mini, accessed via browser on iPhone + desktop
- **Future-ready**: All data access through API routes (no direct file imports in components)
  so the backend can be swapped to a server with zero frontend changes
- Environment config via .env.local (SECOND_BRAIN_PATH, DATA_PATH etc.)
- No hardcoded absolute paths in components — always via API or env vars

## Token Budget
- Coding agent: Claude Code CLI (Anthropic API — existing subscription)
- OpenAI $40 credit: RESERVED — do not spend on coding tasks
