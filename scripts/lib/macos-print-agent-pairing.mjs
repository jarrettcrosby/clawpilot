import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

export const MAC_PRINT_PAIRING_MARKER = '.clawpilot-pairing-transaction.json'

function normalizedPath(value) {
  return path.resolve(String(value || ''))
}

function assertInsideRuntime(runtimeDirectory, candidate, description) {
  const relative = path.relative(runtimeDirectory, candidate)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${description} must be inside the print-agent runtime directory`)
  }
}

function markerOwned(transaction) {
  try {
    const marker = JSON.parse(readFileSync(transaction.markerPath, 'utf8'))
    return marker?.version === 1 && marker?.token === transaction.token
  } catch {
    return false
  }
}

function runtimeEntries(directory) {
  if (!existsSync(directory)) return []
  const entries = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name)
    entries.push(entryPath)
    if (entry.isDirectory()) entries.push(...runtimeEntries(entryPath))
  }
  return entries
}

function removeEmptyDirectory(directory) {
  try {
    rmdirSync(directory)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return false
    throw error
  }
}

export function beginMacPrintPairingTransaction({
  runtimeDirectory: runtimeDirectoryInput,
  plistPath: plistPathInput,
  managedRuntimePaths: managedRuntimePathsInput,
  managedRuntimeDirectories: managedRuntimeDirectoriesInput,
  durableStatePaths: durableStatePathsInput,
}) {
  const runtimeDirectory = normalizedPath(runtimeDirectoryInput)
  const plistPath = normalizedPath(plistPathInput)
  const managedRuntimePaths = managedRuntimePathsInput.map(normalizedPath)
  const managedRuntimeDirectories = managedRuntimeDirectoriesInput.map(normalizedPath)
  const durableStatePaths = durableStatePathsInput.map(normalizedPath)

  if (existsSync(runtimeDirectory)) {
    throw new Error(
      'Retained local print-agent state exists for that instance name; preserve it and choose a unique workspace instance name',
    )
  }
  if (existsSync(plistPath)) {
    throw new Error('That local instance name is already installed; choose a unique workspace instance name')
  }
  for (const candidate of [
    ...managedRuntimePaths,
    ...managedRuntimeDirectories,
    ...durableStatePaths,
  ]) {
    assertInsideRuntime(runtimeDirectory, candidate, 'A pairing transaction path')
  }

  mkdirSync(runtimeDirectory, { recursive: true, mode: 0o700 })
  const markerPath = path.join(runtimeDirectory, MAC_PRINT_PAIRING_MARKER)
  const token = randomUUID()
  try {
    writeFileSync(markerPath, `${JSON.stringify({ version: 1, token })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    })
  } catch (error) {
    removeEmptyDirectory(runtimeDirectory)
    throw error
  }

  return Object.freeze({
    runtimeDirectory,
    plistPath,
    markerPath,
    token,
    managedRuntimePaths,
    managedRuntimeDirectories,
    durableStatePaths,
  })
}

export function completeMacPrintPairingTransaction(transaction) {
  if (!markerOwned(transaction)) {
    throw new Error('The local pairing transaction marker changed; installed state was preserved')
  }
  rmSync(transaction.markerPath, { force: true })
}

export function rollbackMacPrintPairingTransaction(transaction) {
  if (!markerOwned(transaction)) {
    return { cleaned: false, reason: 'transaction_not_owned' }
  }

  if (transaction.durableStatePaths.some((candidate) => existsSync(candidate))) {
    rmSync(transaction.markerPath, { force: true })
    return { cleaned: false, reason: 'durable_print_state_present' }
  }

  const allowedEntries = new Set([
    transaction.markerPath,
    ...transaction.managedRuntimePaths,
    ...transaction.managedRuntimeDirectories,
  ])
  const unknownEntries = runtimeEntries(transaction.runtimeDirectory)
    .filter((candidate) => !allowedEntries.has(candidate))
  if (unknownEntries.length > 0) {
    rmSync(transaction.markerPath, { force: true })
    return { cleaned: false, reason: 'unrecognized_runtime_state_present' }
  }

  for (const candidate of transaction.managedRuntimePaths) {
    rmSync(candidate, { force: true })
  }
  rmSync(transaction.markerPath, { force: true })
  for (const directory of [...transaction.managedRuntimeDirectories]
    .sort((left, right) => right.length - left.length)) {
    removeEmptyDirectory(directory)
  }

  if (!removeEmptyDirectory(transaction.runtimeDirectory)) {
    return { cleaned: false, reason: 'runtime_state_appeared_during_cleanup' }
  }
  rmSync(transaction.plistPath, { force: true })
  return { cleaned: true, reason: 'attempt_owned_artifacts_removed' }
}
