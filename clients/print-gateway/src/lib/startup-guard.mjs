const SECRET_PATTERN = /(?:cppair|cpprint)\.v1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/gi

function startupErrorMessage(error) {
  return String(error instanceof Error ? error.message : error)
    .replaceAll(SECRET_PATTERN, '[secret redacted]')
    .slice(0, 1_000)
}

export async function runProtectedGatewayStartup({ initialize, showError, exit }) {
  try {
    await initialize()
    return true
  } catch (error) {
    showError(
      'ClawPilot Print Agent could not start safely',
      `Protected local print-agent state could not be verified, so background printing did not start. Do not delete or edit the state files because they may contain duplicate-print fences. Contact ClawPilot support for protected-state recovery. ${startupErrorMessage(error)}`,
    )
    exit(1)
    return false
  }
}
