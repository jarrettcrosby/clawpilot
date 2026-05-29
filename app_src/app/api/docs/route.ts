import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import matter from 'gray-matter'

const SECOND_BRAIN = process.env.SECOND_BRAIN_PATH || '/Users/agentsuburbiasandwich/.openclaw/workspace/second-brain'

type Doc = {
  id: string
  title: string
  date: string
  tags: string[]
  category: string
  slug: string
  content: string
  excerpt: string
}

function walkDir(dir: string): string[] {
  let results: string[] = []
  const list = fs.readdirSync(dir)
  list.forEach((file) => {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat && stat.isDirectory()) {
      results = results.concat(walkDir(filePath))
    } else if (file.endsWith('.md')) {
      results.push(filePath)
    }
  })
  return results
}

function getDocs(): Doc[] {
  if (!fs.existsSync(SECOND_BRAIN)) return []
  const files = walkDir(SECOND_BRAIN)
  const docs: Doc[] = files.map((file) => {
    const relPath = path.relative(SECOND_BRAIN, file)
    const id = relPath.replace(/\.md$/, '').replace(/\\/g, '/')
    const slug = path.basename(file, '.md')
    const category = relPath.split(path.sep)[0]
    const raw = fs.readFileSync(file, 'utf-8')
    const { data, content } = matter(raw)

    let date = ''
    if (data.date instanceof Date) {
      date = data.date.toISOString().slice(0, 10)
    } else if (typeof data.date === 'string') {
      date = data.date.slice(0, 10)
    }

    const tags: string[] = Array.isArray(data.tags)
      ? data.tags.map(String)
      : typeof data.tags === 'string'
      ? [data.tags]
      : []

    const title =
      typeof data.title === 'string' && data.title.length
        ? data.title
        : slug

    // Excerpt: first 120 non-header characters
    const excerpt = content
      .replace(/^#+\s/gm, '')
      .replace(/\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 120)

    return {
      id,
      title,
      date,
      tags,
      category,
      slug,
      content,
      excerpt
    }
  })

  // Sort by date descending
  docs.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
  return docs
}

export async function GET(req: NextRequest) {
  try {
    const id = new URL(req.url).searchParams.get('id')
    const docs = getDocs()
    if (id) {
      const doc = docs.find((d) => d.id === id)
      if (!doc) return NextResponse.json({ error: 'Not Found' }, { status: 404 })
      return NextResponse.json(doc)
    }
    return NextResponse.json(docs)
  } catch (e) {
    return NextResponse.json({ error: 'Internal Server Error', details: e instanceof Error ? e.message : e }, { status: 500 })
  }
}