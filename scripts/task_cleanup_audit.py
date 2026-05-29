#!/usr/bin/env python3
import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple
from urllib import request, error

ROOT = Path('/Users/agentsuburbiasandwich/Desktop/clawd-app-dev')
TASKS_PATH = ROOT / 'data-dev' / 'tasks.json'

UNSAFE_START_DEFAULT = '2026-03-17T00:00:00Z'
UNSAFE_END_DEFAULT = '2026-03-18T04:30:00Z'


@dataclass
class Candidate:
  task_id: str
  title: str
  reasons: List[str]


def parse_iso(value: str) -> datetime:
  return datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(timezone.utc)


def has_execution_evidence(task: Dict[str, Any]) -> bool:
  execution = task.get('execution') or {}
  if not isinstance(execution, dict):
    return False
  keys = ['startedAt', 'lastResult', 'latestSummary', 'lastUpdatedAt', 'executionStatus']
  return any(bool(execution.get(k)) for k in keys)


def has_meaningful_activity(task: Dict[str, Any]) -> bool:
  comments = task.get('comments') or []
  if comments:
    meaningful_comments = [
      c for c in comments
      if isinstance(c, dict) and 'governance: missing fields' not in str(c.get('text', '')).lower()
    ]
    if meaningful_comments:
      return True

  for entry in (task.get('activity') or []):
    if not isinstance(entry, dict):
      continue
    msg = str(entry.get('message') or '').lower()
    typ = str(entry.get('type') or '').lower()
    if typ in {'moved', 'checklist'}:
      return True
    if typ == 'comment' and msg and 'governance: missing fields' not in msg:
      return True
  return False


def unsafe_path_signal(task: Dict[str, Any]) -> bool:
  hay = ' '.join([
    str(task.get('title') or ''),
    str(task.get('desc') or ''),
    ' '.join(str(c.get('text') or '') for c in (task.get('comments') or []) if isinstance(c, dict)),
    ' '.join(str(a.get('message') or '') for a in (task.get('activity') or []) if isinstance(a, dict)),
  ]).lower()

  clues = [
    'containment test',
    'automation blocked',
    'suggestion',
    'test panel',
    'unsafe',
  ]
  return any(clue in hay for clue in clues)


def load_tasks() -> List[Dict[str, Any]]:
  return json.loads(TASKS_PATH.read_text())


def identify_candidates(tasks: List[Dict[str, Any]], unsafe_start: datetime, unsafe_end: datetime) -> List[Candidate]:
  candidates: List[Candidate] = []
  for task in tasks:
    task_id = str(task.get('id') or '')
    title = str(task.get('title') or '').strip() or '<blank>'
    created_at_raw = str(task.get('createdAt') or '')
    if not created_at_raw:
      continue
    try:
      created_at = parse_iso(created_at_raw)
    except Exception:
      continue

    in_window = unsafe_start <= created_at <= unsafe_end
    exec_evidence = has_execution_evidence(task)
    meaningful = has_meaningful_activity(task)
    blocked_path = unsafe_path_signal(task)

    reasons: List[str] = []
    if in_window:
      reasons.append('created during unsafe window')
    if blocked_path:
      reasons.append('blocked/test-path signal detected')

    # Source metadata was not persisted previously; treat as unknown for the unsafe-window cohort
    if in_window:
      reasons.append('source metadata not persisted for legacy task')

    if not meaningful:
      reasons.append('no meaningful activity beyond creation/governance noise')
    if not exec_evidence:
      reasons.append('no execution evidence')

    keep = exec_evidence or meaningful
    if reasons and in_window and not keep:
      candidates.append(Candidate(task_id=task_id, title=title, reasons=reasons))
  return candidates


def api_patch(base_url: str, payload: Dict[str, Any]) -> Tuple[int, Any]:
  body = json.dumps(payload).encode('utf-8')
  req = request.Request(
    url=f'{base_url}/api/tasks',
    data=body,
    method='PATCH',
    headers={'Content-Type': 'application/json'},
  )
  try:
    with request.urlopen(req, timeout=20) as resp:
      data = resp.read().decode('utf-8')
      return resp.status, json.loads(data) if data else None
  except error.HTTPError as e:
    data = e.read().decode('utf-8')
    try:
      parsed = json.loads(data) if data else None
    except Exception:
      parsed = {'raw': data}
    return e.code, parsed


def apply_cleanup(base_url: str, candidates: List[Candidate], actor: str) -> List[Dict[str, Any]]:
  results = []
  for c in candidates:
    archive_status, archive_out = api_patch(base_url, {
      'id': c.task_id,
      '_archive': True,
      '_actor': actor,
    })
    reason = '; '.join(c.reasons)
    delete_status, delete_out = api_patch(base_url, {
      'id': c.task_id,
      '_deletePermanent': True,
      '_deleteReason': reason,
      '_actor': actor,
    })
    results.append({
      'id': c.task_id,
      'title': c.title,
      'archive_status': archive_status,
      'delete_status': delete_status,
      'archive_ok': 200 <= archive_status < 300,
      'delete_ok': 200 <= delete_status < 300,
      'reason': reason,
      'archive_response': archive_out,
      'delete_response': delete_out,
    })
  return results


def main() -> int:
  parser = argparse.ArgumentParser(description='Audit and safely remove unintended tasks from unsafe window.')
  parser.add_argument('--apply', action='store_true', help='Apply cleanup (archive + permanent delete via API)')
  parser.add_argument('--base-url', default='http://127.0.0.1:4002', help='App base URL')
  parser.add_argument('--actor', default='ClawPilot', help='Actor name for audit trail')
  parser.add_argument('--unsafe-start', default=UNSAFE_START_DEFAULT)
  parser.add_argument('--unsafe-end', default=UNSAFE_END_DEFAULT)
  args = parser.parse_args()

  unsafe_start = parse_iso(args.unsafe_start)
  unsafe_end = parse_iso(args.unsafe_end)
  tasks = load_tasks()
  candidates = identify_candidates(tasks, unsafe_start, unsafe_end)

  print('CANDIDATES:')
  for c in candidates:
    print(json.dumps({'id': c.task_id, 'title': c.title, 'reason': '; '.join(c.reasons)}, ensure_ascii=False))
  print(f'TOTAL_CANDIDATES={len(candidates)}')

  if not args.apply:
    return 0

  if not candidates:
    print('APPLY_SKIPPED=no-candidates')
    return 0

  results = apply_cleanup(args.base_url, candidates, args.actor)
  print('APPLY_RESULTS:')
  for r in results:
    print(json.dumps(r, ensure_ascii=False))

  failures = [r for r in results if not (r['archive_ok'] and r['delete_ok'])]
  if failures:
    print(f'APPLY_FAILURES={len(failures)}')
    return 2

  print('APPLY_OK')
  return 0


if __name__ == '__main__':
  raise SystemExit(main())
