#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const read = (path) => readFileSync(resolve(root, path), 'utf8')

const adapters = read(
  'clients/apple/Sources/ClawPilotPickingApple/AppleAdapters.swift',
)
for (const fragment of [
  'public struct ManagerPickManagementWorkspace',
  'public struct ManagerPickManagementPagination',
  'public struct ManagerPickAssignmentCommand',
  'expectedAssignmentFingerprint',
  'expectedPreviousAssignedTo',
  'public func fetchManagerPickManagement()',
  'fetchManagerPickManagementPage(',
  'nextPickManagementCursor(',
  'section: "current"',
  'section: "history"',
  'public func managePickerAssignment(',
  'action: "manage-pick-assignment"',
  'request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")',
  'previousAssignedTo?.lowercased()',
  'providerWrites == 0',
  'command.assignedTo != nil || interventionExceptionGlobalId != nil',
  'public struct ManagerStoreSyncControl',
  'public struct ManagerStoreSyncCommand',
  'public func fetchManagerOperations()',
  'public func updateManagerStoreSync(',
  'action = "update-commerce-store-sync"',
  'control.revision == command.expectedRevision + 1',
  'request.setValue(command.idempotencyKey, forHTTPHeaderField: "Idempotency-Key")',
]) {
  assert.ok(adapters.includes(fragment), `Apple adapter is missing ${fragment}`)
}

const model = read('clients/apple/Apps/iPhone/ClawPilotPickingPhoneApp.swift')
for (const fragment of [
  '@Published var managerPickManagement',
  '@Published var managerSelectedPickAssignment',
  'let overview = try await api.fetchManagerOperations()',
  'managerOrders = overview.orders',
  'managerStoreSyncControls = overview.storeSync',
  'canManageStoreSync = overview.capabilities.canActivate',
  'managerPickManagement = try await api.fetchManagerPickManagement()',
  'Some manager data is unavailable',
  'Available orders remain usable.',
  'func managePickerAssignment(',
  '#if DEBUG',
  'installManagerPickManagementWalkthroughFixture()',
  'walkthroughScreen == "pick-intervention"',
  '@Published var managerStoreSyncControls',
  '@Published private(set) var canManageStoreSync',
  '@Published private(set) var hasPendingManagerStoreSyncChange',
  'func updateManagerStoreSync(',
  'func retryPendingManagerStoreSyncChange()',
  'reconcilePendingManagerStoreSyncChange()',
  'Retry or refresh the saved Store sync change before changing organizations.',
]) {
  assert.ok(model.includes(fragment), `iPhone manager model is missing ${fragment}`)
}

const shell = read('clients/apple/Apps/iPhone/ClawPilotAppShellView.swift')
for (const fragment of [
  'case "pick-management", "pick-intervention"',
  'private var currentAssignments',
  'private var completedPickHistory',
  'ForEach(history) { item in',
  '.disabled(!assignment.canManageAssignment)',
  'ScrollView {',
  'LazyVStack(spacing: 13)',
  '.padding(.bottom, 30)',
  'ManagerPickInterventionView',
  'Unstarted work only',
  'Manager exception · evidence retained',
  'Text("Reason")',
  'TextField("Required", text: $reason)',
  '.accessibilityLabel("Manager reason")',
  'private var primaryAction',
  '.buttonStyle(.borderedProminent)',
  '.controlSize(.regular)',
  '.tint(pickerEmail.isEmpty ? Color.red : AppShellTheme.primary)',
  'return "Unassign"',
  '? "Assign"',
  ': "Reassign"',
  'Unassign exact ready tasks and flag for manager',
  'Uses the exact order version, ready-task count, and assignment fingerprint.',
  '.frame(minHeight: 44)',
  'never clears scan/count evidence or physical work',
  'Existing exceptions stay open for review.',
  'Text("Store sync")',
  'Automatic store catalog, order, image, and inventory mirroring',
  'value: control.desiredState == .running',
  'value: control.effectiveState == .running',
  'Confirm Running',
  'View only. An organization owner or authorized administrator can change Store sync.',
  'Retry exact saved change',
  'Disabled or Frozen can still pause execution and will show the exact reason.',
]) {
  assert.ok(shell.includes(fragment), `iPhone manager UI is missing ${fragment}`)
}

const route = read('app_src/app/api/operations/route.ts')
for (const fragment of [
  "if (action === 'update-commerce-store-sync')",
  "code: 'COMMERCE_STORE_SYNC_MANAGE_REQUIRED'",
  "'accountGlobalId'",
  "'desiredState'",
  "'expectedDesiredState'",
  "'expectedRevision'",
  "'reason'",
  'idempotencyKey: idempotencyKeyValue(req)',
]) {
  assert.ok(route.includes(fragment), `Operations Store sync API is missing ${fragment}`)
}

const storeSyncTests = read(
  'clients/apple/Tests/ClawPilotPickingCoreTests/ManagerStoreSyncTests.swift',
)
for (const fragment of [
  'manager Store sync decodes desired and effective state separately',
  'manager Store sync sends the exact revision fenced command',
  'manager Store sync retries a lost response byte identically',
  'every Store sync effective reason has one exact effective state',
  'captured[0].1 == captured[1].1',
]) {
  assert.ok(storeSyncTests.includes(fragment), `Native Store sync tests are missing ${fragment}`)
}
for (const paragraph of [
  'Exact unstarted-work fence',
  'The server rechecks this order version, exact task count and assignment fingerprint.',
  'The reason is retained in command, domain, and audit history.',
  'Back without changes',
  'Unassign and flag for manager',
]) {
  assert.ok(!shell.includes(paragraph), `iPhone manager UI still shows ${paragraph}`)
}

const tests = read(
  'clients/apple/Tests/ClawPilotPickingCoreTests/ManagerPickManagementTests.swift',
)
for (const fragment of [
  'manager assignment command retains exact optimistic fences',
  'native manager reads progress and sends exact unassign-and-flag command',
  'native manager rejects non-exact unassign success without an exception',
  'native manager preserves a structured assignment conflict',
  'native manager follows every assignment and history page',
  'OPERATIONS_PICK_ASSIGNMENT_SCAN_EVIDENCE_EXISTS',
]) {
  assert.ok(tests.includes(fragment), `Native manager tests are missing ${fragment}`)
}

console.log('Apple manager pick-management source acceptance passed')
