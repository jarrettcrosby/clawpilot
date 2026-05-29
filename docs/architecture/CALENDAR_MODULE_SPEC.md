# ClawApp Calendar Module Specification (v1)

Status: Draft for implementation
Owner: ClawApp docs
Last Updated: 2026-03-05

## 1) Purpose
Deliver an integrated calendar experience for planning, conflict detection, and agent-assisted scheduling inside ClawApp.

## 2) Product Goals
- Unified calendar view for user commitments + pipeline milestones + internal tasks
- Fast event creation/editing from within app context
- Calendar Agent assistance for conflict checks and reschedule drafts
- Reliable sync behavior with clear error visibility

## 3) User Stories
1. As an operator, I can see day/week/month views with filters.
2. As an operator, I can create/edit events with title, time, location, participants, and linked records.
3. As an operator, I can detect overlaps and receive reschedule suggestions.
4. As an operator, I can link events to pipeline opportunities and tasks.
5. As an operator, I can recover from failed sync without losing local edits.

## 4) Functional Specification
### 4.1 Views
- Day view (hourly grid)
- Week view (default)
- Month overview (read-heavy)
- Agenda list (mobile-first fallback)

### 4.2 Event model
Required fields:
- `event_id`
- `title`
- `start_at`, `end_at`, `timezone`
- `status` (`confirmed`, `tentative`, `cancelled`)
- `attendees[]`
- `location`
- `notes`

Optional ClawApp linkage:
- `linked_type` (`task`, `opportunity`, `project`)
- `linked_id`
- `source` (`local`, `google-calendar`)
- `version`, `updated_at`, `last_synced_at`

### 4.3 API endpoints (proposed)
- `GET /api/calendar/events?start=&end=&view=`
- `POST /api/calendar/events`
- `PATCH /api/calendar/events/:id`
- `DELETE /api/calendar/events/:id`
- `POST /api/calendar/conflicts/check`
- `POST /api/calendar/reschedule/suggest`

### 4.4 Conflict detection rules
- Hard conflict: any overlap where attendee/resource is shared
- Soft conflict: focus block violation or travel-time compression threshold
- Results include severity and recommended alternatives

### 4.5 Calendar Agent workflow (v1)
1. User initiates create/edit event.
2. Module validates times and attendee/resource availability.
3. Conflict engine evaluates overlap windows.
4. Agent generates 1-3 reschedule options with rationale.
5. User accepts one option or overrides manually.
6. Final write emits activity event + sync attempt.

## 5) Non-Functional Requirements
- Mobile usable (agenda fallback when dense)
- P95 event fetch < 800ms for typical 14-day window
- No permanent spinner states on slow sync
- Deterministic merge strategy for concurrent edits

## 6) Sync and Data Integrity
- Local-first pending writes queue
- Per-event `version` increment on update
- Conflict resolution precedence:
  1. Explicit user decision
  2. Newer version if unambiguous
  3. Flag manual review if ambiguous

## 7) Acceptance Criteria
1. Calendar renders day/week/month/agenda views without blocking UI failures.
2. Event CRUD works locally and records activity events.
3. Conflict check endpoint returns actionable severity + alternatives.
4. Calendar Agent suggestions are generated and selectable before commit.
5. Failed sync leaves local pending state visible and retryable.
6. Linked records (task/opportunity/project) round-trip correctly in API responses.

## 8) Rollback Notes
If calendar module causes user-facing instability:
1. Disable Calendar Agent suggestions endpoint first (`/reschedule/suggest`).
2. Switch calendar UI to read-only mode (hide create/edit/delete actions).
3. Pause external sync writes while preserving local read cache.
4. Restore prior stable calendar build and verify with smoke tests.
5. Publish known limitation: "calendar view-only while write path stabilizes".

## 9) Open Questions
- Preferred default timezone behavior for travel scenarios?
- Required attendee auto-notification rules for updates/cancellations?
- Which linked record type should appear first in event detail UI?
