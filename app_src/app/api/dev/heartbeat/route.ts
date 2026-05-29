import { NextResponse } from 'next/server';
import { access } from 'node:fs/promises';
import path from 'node:path';

export const dynamic = 'force-dynamic';

const REQUIRED_PATHS = ['data-dev/tasks.json', 'data-dev/agents/assignments.json'];

async function pathExists(relativePath: string): Promise<boolean> {
  try {
    await access(path.resolve(process.cwd(), '..', relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function GET() {
  const checks = await Promise.all(
    REQUIRED_PATHS.map(async (requiredPath) => ({
      path: requiredPath,
      ok: await pathExists(requiredPath),
    })),
  );

  const allChecksOk = checks.every((check) => check.ok);

  return NextResponse.json(
    {
      lane: 'dev',
      ok: allChecksOk,
      checkedAt: new Date().toISOString(),
      checks,
    },
    { status: allChecksOk ? 200 : 503 },
  );
}
