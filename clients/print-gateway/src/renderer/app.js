const api = window.clawpilotGateway
let snapshot

const elements = {
  autoStart: document.querySelector('#auto-start'),
  autoStartStatus: document.querySelector('#auto-start-status'),
  baseUrl: document.querySelector('#base-url'),
  exportDiagnostics: document.querySelector('#export-diagnostics'),
  editDialog: document.querySelector('#edit-endpoint-dialog'),
  editForm: document.querySelector('#edit-endpoint-form'),
  editHost: document.querySelector('#edit-printer-host'),
  editInstanceName: document.querySelector('#edit-instance-name'),
  editPort: document.querySelector('#edit-printer-port'),
  editResult: document.querySelector('#edit-result'),
  form: document.querySelector('#pair-form'),
  formResult: document.querySelector('#form-result'),
  gatewayHealth: document.querySelector('#gateway-health'),
  instances: document.querySelector('#instances'),
  installLocationWarning: document.querySelector('#install-location-warning'),
  legacyWarning: document.querySelector('#legacy-agent-warning'),
  pairButton: document.querySelector('#pair-button'),
  pairingCode: document.querySelector('#pairing-code'),
  pairingContext: document.querySelector('#pairing-context'),
  printerHost: document.querySelector('#printer-host'),
  printerPort: document.querySelector('#printer-port'),
  probeButton: document.querySelector('#probe-button'),
}

function formInput() {
  return Object.fromEntries(new FormData(elements.form).entries())
}

function showResult(message, kind = '') {
  elements.formResult.textContent = message
  elements.formResult.className = `result ${kind}`
}

function setBusy(busy) {
  for (const button of elements.form.querySelectorAll('button')) {
    button.disabled = busy || (button === elements.pairButton && operationBlocked())
  }
}

function operationBlocked() {
  return snapshot?.installLocationStatus?.ready === false
    || Boolean(snapshot?.legacyMacInstances?.length)
}

function formatDate(value) {
  if (!value) return 'No activity yet'
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value)) }
  catch { return value }
}

function renderPairingContext(context) {
  if (!context) {
    elements.pairingContext.classList.add('hidden')
    return
  }
  const labels = [context.organization, context.warehouse, context.context].filter(Boolean)
  elements.pairingContext.textContent = labels.length
    ? `Unverified external setup context: ${labels.join(' · ')}. Select the trusted ClawPilot deployment yourself before entering a pairing code.`
    : 'Unverified external setup context. Select the trusted ClawPilot deployment yourself before entering a pairing code.'
  elements.pairingContext.classList.remove('hidden')
}

function renderInstances() {
  const instances = snapshot?.instances || []
  if (!instances.length) {
    elements.instances.innerHTML = '<p class="empty">No workspaces are paired on this computer.</p>'
    return
  }
  elements.instances.replaceChildren(...instances.map((instance) => {
    const status = snapshot.statuses?.[instance.id] || { state: 'stopped' }
    const article = document.createElement('article')
    article.className = 'instance'
    const detail = document.createElement('div')
    const title = document.createElement('h3')
    title.textContent = instance.displayName
    const metadata = document.createElement('p')
    metadata.className = 'instance-meta'
    const state = document.createElement('span')
    state.className = `status ${status.state}`
    state.textContent = status.state
    const endpoint = document.createTextNode(
      ` · ${instance.warehouseName} · Agent ${instance.serverAgentGlobalId}${instance.localName ? ` · Local nickname: ${instance.localName}` : ''} · ${instance.printerHost}:${instance.printerPort} · ${instance.baseUrl}`,
    )
    const activity = document.createElement('span')
    activity.textContent = `Last local event: ${formatDate(status.lastEventAt)}${status.lastEvent ? ` (${status.lastEvent})` : ''}`
    metadata.append(state, endpoint, document.createElement('br'), activity)
    if (status.lastError) {
      const error = document.createElement('span')
      error.className = 'danger'
      error.textContent = ` · ${status.lastError}`
      metadata.append(error)
    }
    const feedback = document.createElement('p')
    feedback.className = 'instance-feedback'
    feedback.setAttribute('aria-live', 'polite')
    detail.append(title, metadata)
    detail.append(feedback)
    const controls = document.createElement('div')
    controls.className = 'instance-actions'
    const testButton = document.createElement('button')
    testButton.className = 'secondary'
    testButton.type = 'button'
    testButton.textContent = 'Test connection'
    testButton.addEventListener('click', async () => {
      testButton.disabled = true
      feedback.textContent = 'Testing TCP reachability without sending bytes…'
      const result = await api.testInstance(instance.id)
      feedback.textContent = result.ok
        ? `Reachable in ${result.elapsedMs} ms. No bytes were sent.`
        : result.error
      feedback.classList.toggle('danger', !result.ok)
      testButton.disabled = false
    })
    const editButton = document.createElement('button')
    editButton.className = 'secondary'
    editButton.type = 'button'
    editButton.textContent = 'Edit connection'
    editButton.addEventListener('click', () => {
      elements.editForm.dataset.instanceId = instance.id
      elements.editInstanceName.textContent = instance.displayName
      elements.editHost.value = instance.printerHost
      elements.editPort.value = String(instance.printerPort)
      elements.editResult.textContent = ''
      elements.editDialog.showModal()
    })
    const toggleButton = document.createElement('button')
    toggleButton.className = 'secondary'
    toggleButton.type = 'button'
    toggleButton.textContent = instance.enabled ? 'Stop' : 'Start'
    toggleButton.disabled = !instance.enabled && operationBlocked()
    toggleButton.addEventListener('click', async () => {
      toggleButton.disabled = true
      const result = await api.setEnabled(instance.id, !instance.enabled)
      if (result.ok) render(result.snapshot)
      else showResult(result.error, 'error')
      toggleButton.disabled = false
    })
    const removeButton = document.createElement('button')
    removeButton.className = 'secondary danger'
    removeButton.type = 'button'
    removeButton.textContent = 'Remove from this computer'
    removeButton.addEventListener('click', async () => {
      const confirmation = window.prompt(
        `Type “${instance.displayName}” to stop this local worker and delete its local credential and delivery history. This does not revoke server agent ${instance.serverAgentGlobalId}; revoke that exact agent separately in ClawPilot.`,
      )
      if (confirmation === null) return
      removeButton.disabled = true
      const result = await api.removeLocalInstance(instance.id, confirmation)
      if (result.ok) {
        render(result.snapshot)
        showResult(result.message, 'success')
      } else {
        if (result.snapshot) render(result.snapshot)
        feedback.textContent = result.error
        feedback.classList.add('danger')
      }
      removeButton.disabled = false
    })
    controls.append(testButton, editButton, toggleButton, removeButton)
    article.append(detail, controls)
    return article
  }))
}

function render(nextSnapshot) {
  snapshot = nextSnapshot
  if (snapshot.installLocationStatus?.ready === false) {
    elements.installLocationWarning.textContent = snapshot.installLocationStatus.warning
    elements.installLocationWarning.classList.remove('hidden')
  } else {
    elements.installLocationWarning.classList.add('hidden')
  }
  if (snapshot.legacyMacInstances?.length) {
    elements.legacyWarning.textContent = `Legacy Mac print-agent service${snapshot.legacyMacInstances.length === 1 ? '' : 's'} detected (${snapshot.legacyMacInstances.join(', ')}). Its older runtime does not share this app’s duplicate-print fences, so Pair and Start are blocked. First verify in ClawPilot that there is no in-flight or pending work. Then reopen the older “ClawPilot Print Agent.command” manager and choose “3. Stop and uninstall an instance” for each listed service. That retains its Keychain credential, device key, and delivery ledger for rollback while removing the LaunchAgent property list this app detects. Reopen this app, pair the same Zebra private LAN IP and port, run the no-print connection test, and print exactly one controlled UPS sandbox label. Do not revoke the old server enrollment until this app acknowledges that label. Before any native claim, rollback remains available through the retained legacy state. This app will not stop, uninstall, or revoke legacy services automatically.`
    elements.legacyWarning.classList.remove('hidden')
  } else {
    elements.legacyWarning.classList.add('hidden')
  }
  if (snapshot.localDevelopmentAllowed && !elements.baseUrl.querySelector('[data-local-development]')) {
    const option = document.createElement('option')
    option.value = 'http://localhost:4002'
    option.textContent = 'Local development — localhost:4002'
    option.dataset.localDevelopment = 'true'
    elements.baseUrl.append(option)
  }
  elements.autoStart.checked = snapshot.autoStart === true
  elements.autoStart.disabled = operationBlocked()
  elements.pairButton.disabled = operationBlocked()
  elements.autoStartStatus.textContent = snapshot.autoStartStatus?.warning
    || (snapshot.autoStartStatus?.effective
      ? 'The operating system confirms this agent will start when you sign in.'
      : 'Automatic start is off.')
  elements.autoStartStatus.classList.toggle(
    'danger',
    Boolean(snapshot.autoStartStatus?.warning),
  )
  const statuses = Object.values(snapshot.statuses || {})
  const running = statuses.filter((status) => status.state === 'running').length
  elements.gatewayHealth.textContent = snapshot.secureStorageAvailable
    ? `${running} of ${snapshot.instances.length} instance${snapshot.instances.length === 1 ? '' : 's'} running`
    : 'Secure credential storage unavailable'
  renderPairingContext(snapshot.pairingContext)
  renderInstances()
}

elements.probeButton.addEventListener('click', async () => {
  setBusy(true)
  showResult('Testing local TCP reachability…')
  const input = formInput()
  const result = await api.probe({
    printerHost: input.printerHost,
    printerPort: input.printerPort,
  })
  showResult(
    result.ok
      ? `Printer is reachable in ${result.elapsedMs} ms. No bytes were sent.`
      : result.error,
    result.ok ? 'success' : 'error',
  )
  setBusy(false)
})

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault()
  setBusy(true)
  showResult('Testing the printer, then redeeming the pairing code…')
  const result = await api.pair(formInput())
  if (result.ok) {
    elements.pairingCode.value = ''
    elements.form.reset()
    elements.printerPort.value = '9100'
    showResult(
      result.message || 'Paired. The background gateway is running.',
      result.message ? 'error' : 'success',
    )
    render(result.snapshot)
  } else {
    showResult(result.error, 'error')
  }
  setBusy(false)
})

elements.autoStart.addEventListener('change', async () => {
  const result = await api.setAutoStart(elements.autoStart.checked)
  if (result.ok) render(result.snapshot)
  else showResult(result.error, 'error')
})

document.querySelector('#cancel-edit-endpoint').addEventListener('click', () => {
  elements.editDialog.close()
})

elements.editForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const saveButton = document.querySelector('#save-edit-endpoint')
  saveButton.disabled = true
  elements.editResult.textContent = 'Testing without printing, then saving locally…'
  elements.editResult.className = 'result'
  const result = await api.updateEndpoint(
    elements.editForm.dataset.instanceId,
    elements.editHost.value,
    elements.editPort.value,
  )
  if (result.ok) {
    render(result.snapshot)
    elements.editDialog.close()
    showResult('Printer connection updated locally. The workspace credential was retained.', 'success')
  } else {
    elements.editResult.textContent = result.error
    elements.editResult.className = 'result error'
  }
  saveButton.disabled = false
})

elements.exportDiagnostics.addEventListener('click', async () => {
  elements.exportDiagnostics.disabled = true
  const result = await api.exportDiagnostics()
  if (result.ok) showResult(`Diagnostics saved to ${result.filePath}`, 'success')
  elements.exportDiagnostics.disabled = false
})

api.onStatus((update) => {
  if (update.pairingContext) {
    snapshot.pairingContext = update.pairingContext
    renderPairingContext(update.pairingContext)
    return
  }
  if (update.id && update.status) {
    snapshot.statuses[update.id] = update.status
    render(snapshot)
  }
})

api.snapshot().then(render).catch((error) => showResult(error.message, 'error'))
