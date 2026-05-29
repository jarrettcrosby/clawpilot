import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const SECOND_BRAIN = process.env.SECOND_BRAIN_PATH || '/Users/agentsuburbiasandwich/.openclaw/workspace/second-brain'

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

function ensureFile(p: string, content: string) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf-8')
}

function looksLikeEmptyScaffold(text: string) {
  const t = String(text || '')
  return t.includes('## Wins\n-') && t.includes('## In Progress\n-') && t.includes('## Blockers\n-')
}

function ensureFileOrRefreshScaffold(p: string, content: string) {
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, content, 'utf-8')
    return
  }
  const existing = fs.readFileSync(p, 'utf-8')
  if (looksLikeEmptyScaffold(existing)) {
    fs.writeFileSync(p, content, 'utf-8')
  }
}

export async function POST() {
  try {
    const now = new Date()
    const yyyy = now.getFullYear()
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const date = `${yyyy}-${mm}-${dd}`

    const dailyDir = path.join(SECOND_BRAIN, 'daily')
    const clawpilotDir = path.join(SECOND_BRAIN, 'clawpilot')
    const businessesDir = path.join(SECOND_BRAIN, 'businesses')

    ensureDir(dailyDir)
    ensureDir(clawpilotDir)
    ensureDir(businessesDir)

    const dailyFile = path.join(dailyDir, `${date}.md`)
    const dailyTemplate = `# ${date} — ClawPilot Daily Journal

## Daily Snapshot
- Top focus:
- Biggest risk:
- Most important outcome by EOD:

## ClawPilot Journal
### Wins
- 

### In Progress
- 

### Blockers / Decisions Needed
- 

### Next Actions (Top 3)
- [ ]
- [ ]
- [ ]

## Business Updates
### EPISCS
- Pipeline movement:
- Sales actions:
- Follow-ups:

### Suburbia Sandwich Co
- Ops:
- Marketing:
- Follow-ups:

### P9INE
- League ops:
- Content/community:
- Follow-ups:
`
    ensureFileOrRefreshScaffold(dailyFile, dailyTemplate)

    const businessDocs = [
      ['episcs.md', '# EPISCS\n\n## Purpose\nWorking source of truth for EPISCS priorities and execution.\n\n## Weekly Priorities\n- \n\n## Active Deals / Opportunities\n- \n\n## Open Tasks\n- \n\n## Notes\n- \n'],
      ['suburbia-sandwich-co.md', '# Suburbia Sandwich Co\n\n## Purpose\nOperational and growth tracker for Suburbia Sandwich Co.\n\n## Weekly Priorities\n- \n\n## Active Work\n- \n\n## Open Tasks\n- \n\n## Notes\n- \n'],
      ['p9ine.md', '# P9INE\n\n## Purpose\nCommunity + competition operating tracker for P9INE.\n\n## Weekly Priorities\n- \n\n## Active Work\n- \n\n## Open Tasks\n- \n\n## Notes\n- \n'],
    ] as const

    for (const [name, content] of businessDocs) {
      ensureFile(path.join(businessesDir, name), content)
    }

    return NextResponse.json({
      ok: true,
      secondBrain: SECOND_BRAIN,
      createdDaily: fs.existsSync(dailyFile),
      dailyFile,
      businesses: businessDocs.map(([n]) => n),
    })
  } catch (e: unknown) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 })
  }
}
