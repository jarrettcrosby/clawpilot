#!/usr/bin/env python3
"""Logging audit for clawd-app /api/tasks

Creates a temporary card, performs each supported mutation, and asserts that:
- an Activity entry is appended
- required fields exist: type/message/timestamp/actor/taskId/taskTitle

Usage:
  python3 scripts/logging_audit.py --base http://127.0.0.1:4001

NOTE: This writes to data/tasks.json.
"""

import argparse
import json
import sys
import time
import urllib.request


def req(method, url, body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(r) as resp:
        return resp.status, json.loads(resp.read().decode('utf-8'))


def assert_activity(task, since_len, expect_type=None, contains=None):
    act = task.get('activity') or []
    if len(act) <= since_len:
        raise AssertionError(f"Activity not appended (len={len(act)} <= {since_len})")
    entry = act[-1]
    for k in ['type', 'message', 'timestamp', 'actor', 'taskId', 'taskTitle']:
        if not entry.get(k):
            raise AssertionError(f"Activity entry missing {k}: {entry}")
    if expect_type and entry.get('type') != expect_type:
        raise AssertionError(f"Expected type={expect_type}, got {entry.get('type')}: {entry}")
    if contains and contains not in entry.get('message', ''):
        raise AssertionError(f"Expected message containing '{contains}', got: {entry.get('message')}")
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://127.0.0.1:4001')
    ap.add_argument('--actor', default='Jarrett')
    args = ap.parse_args()

    base = args.base.rstrip('/')
    tasks_url = base + '/api/tasks'

    # 1) Create temp card
    status, task = req('POST', tasks_url, {
        'title': f'LOG_AUDIT_TEMP_{int(time.time())}',
        'desc': 'temporary audit card',
        'status': 'todo',
        'priority': 'low',
        'category': 'clawpilot',
        'tags': ['audit'],
        'actor': args.actor,
    })
    assert status == 201
    tid = task['id']

    def patch(payload):
        return req('PATCH', tasks_url, payload)[1]

    # Ensure baseline activity exists
    act_len = len(task.get('activity') or [])
    if act_len < 1:
        raise AssertionError('Expected created activity entry')

    # 2) Move status
    t2 = patch({'id': tid, 'status': 'in-progress', '_actor': args.actor})
    assert_activity(t2, act_len, expect_type='moved')
    act_len = len(t2['activity'])

    # 3) Update title
    t3 = patch({'id': tid, 'title': 'LOG_AUDIT_TEMP_RENAMED', '_actor': args.actor})
    assert_activity(t3, act_len, expect_type='updated')
    act_len = len(t3['activity'])

    # 4) Update desc
    t4 = patch({'id': tid, 'desc': 'updated desc', '_actor': args.actor})
    assert_activity(t4, act_len, expect_type='updated')
    act_len = len(t4['activity'])

    # 5) Tags add/remove
    t5 = patch({'id': tid, 'tags': ['audit', 'test'], '_actor': args.actor})
    # may add multiple activity entries; check last
    assert_activity(t5, act_len)
    act_len = len(t5['activity'])
    t6 = patch({'id': tid, 'tags': ['audit'], '_actor': args.actor})
    assert_activity(t6, act_len)
    act_len = len(t6['activity'])

    # 6) Priority change
    t7 = patch({'id': tid, 'priority': 'high', '_actor': args.actor})
    assert_activity(t7, act_len, expect_type='updated')
    act_len = len(t7['activity'])

    # 7) Comment add/delete/restore
    t8 = patch({'id': tid, '_comment': 'audit comment', '_actor': args.actor})
    assert_activity(t8, act_len, expect_type='comment')
    act_len = len(t8['activity'])
    comment_id = (t8.get('comments') or [])[-1]['id']

    t9 = patch({'id': tid, '_deleteCommentId': comment_id, '_actor': args.actor})
    e = assert_activity(t9, act_len, expect_type='comment', contains='deleted')
    act_len = len(t9['activity'])

    # deletedComments should exist
    deleted = t9.get('deletedComments') or []
    if not any(c.get('id') == comment_id for c in deleted):
        raise AssertionError('deletedComments missing deleted comment')

    t10 = patch({'id': tid, '_restoreCommentId': comment_id, '_actor': args.actor})
    assert_activity(t10, act_len, expect_type='comment', contains='restored')
    act_len = len(t10['activity'])

    # 8) Archive/unarchive
    t11 = patch({'id': tid, '_archive': True, '_actor': args.actor})
    assert_activity(t11, act_len, expect_type='archived')
    act_len = len(t11['activity'])

    t12 = patch({'id': tid, '_unarchive': True, '_actor': args.actor})
    assert_activity(t12, act_len, expect_type='unarchived')

    print('LOGGING_AUDIT: PASS')
    print('tempTaskId:', tid)


if __name__ == '__main__':
    try:
        main()
    except Exception as e:
        print('LOGGING_AUDIT: FAIL')
        print(str(e))
        sys.exit(1)
