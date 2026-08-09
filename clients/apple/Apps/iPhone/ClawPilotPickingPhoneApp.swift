import AVFoundation
import SwiftUI
import UIKit
import ClawPilotPickingApple
import ClawPilotPickingCore

@main
struct ClawPilotPickingPhoneApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = PickingPhoneModel()

    var body: some Scene {
        WindowGroup {
            ClawPilotAppShellView(model: model)
                .sheet(isPresented: $model.showPhoneScanner) {
                    PhoneCameraScanner(
                        onBarcode: { value in Task { await model.accept(value, source: .iPhoneCamera) } },
                        onClose: { model.showPhoneScanner = false }
                    )
                }
                .onOpenURL { url in
                    Task {
                        if ClawPilotSystemActionLink.requestsScan(url) {
                            PendingMobileAction.requestMetaScan()
                            ClawPilotScanDiagnostic.begin("action-link-received")
                            await model.handlePendingSystemScan()
                        } else {
                            await model.handleMetaURL(url)
                        }
                    }
                }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    model.syncMetaConnection()
                    model.refreshAudioRouteStatus()
                    Task { await model.handlePendingSystemScan() }
                }
                .task { await model.restoreAndRefresh() }
                .preferredColorScheme(.dark)
        }
    }
}

@MainActor
final class PickingPhoneModel: ObservableObject {
    @Published var email = ""
    @Published var code = ""
    @Published var canRequestCode = true
    @Published var codeRequested = false
    @Published var isAuthenticated = false
    @Published var isRestoringSession = true
    @Published var isAuthBusy = false
    @Published var isQueueBusy = false
    @Published var isWorkspaceBusy = false
    @Published var workspaceStatus = "Orders, assigned picks, people, and UPH follow this organization."
    @Published var sessionProfile: ClawPilotSessionProfile?
    @Published var managerOrders: [ManagerOrderSummary] = []
    @Published var managerPickers: [ManagerPicker] = []
    @Published var pickerPerformance: [PickerPerformanceMetric] = []
    @Published var managerSelectedOrder: ManagerOrderDetail?
    @Published var managerStatus = "Loading Operations orders."
    @Published var isManagerBusy = false
    @Published var currentTask: PickTask?
    @Published var readyToConfirm = false
    @Published var showPhoneScanner = false
    @Published var hasPendingConfirmation = false
    @Published var status = "Sign in to continue."
    @Published var metaStatus = "Meta setup not checked. iPhone camera remains available."
    @Published var canRegisterMeta = false
    @Published var canRequestMetaCamera = false
    @Published var metaCameraGranted = false
    @Published var metaConnectedDeviceCount = 0
    @Published var isMetaSyncing = false
    @Published var isMetaScanning = false
    @Published var isListeningForPickCommand = false
    @Published private(set) var isConfirmingOrder = false
    @Published var audioRouteStatus = "Automatic audio uses the iPhone speaker when no accessory is connected."
    @Published var voicePackState: OfflineVoicePackState = .notInstalled
    @Published var instructionLanguage: InstructionVoiceLanguage = .english
    @Published var pronunciationCorrections: [PronunciationCorrection] = []

    private let cache: DurablePickCache
    private let api: PickingAPIClient
    private let picking: PickingSession
    private let watch = PhoneWatchBridge()
    private let voice = VoiceConfirmationController()
    private var metaSource: MetaWearablesBarcodeSource?
    private var codeRequestCooldown: Task<Void, Never>?
    private var metaConnectionRefreshTask: Task<Void, Never>?
    private var isHandlingPendingSystemScan = false

    var canSendCode: Bool {
        canRequestCode && !isAuthBusy && email.contains("@") && email.count <= 254
    }

    var canVerifyCode: Bool {
        !isAuthBusy && code.count == 6 && code.allSatisfy(\.isNumber)
    }

    var canUsePicker: Bool {
        sessionProfile?.mobileCapabilities.canUsePicker == true
    }

    var canUseManager: Bool {
        sessionProfile?.mobileCapabilities.canUseManager == true
    }

    var activeWorkspace: ClawPilotSessionProfile.Workspace? {
        sessionProfile?.activeWorkspace
    }

    var availableWorkspaces: [ClawPilotSessionProfile.Workspace] {
        sessionProfile?.availableWorkspaces ?? []
    }

    var canSwitchWorkspace: Bool {
        !isWorkspaceBusy
            && !isManagerBusy
            && !isQueueBusy
            && !hasPendingConfirmation
    }

    var metaScanReady: Bool {
        metaCameraGranted && metaConnectedDeviceCount == 1 && !isMetaSyncing
    }

    var canManageMetaConnection: Bool {
        MetaWearablesAppBridge.isRegistered && !isMetaScanning
    }

    var playbackPreferenceTitle: String { voice.playbackPreference.title }
    var ownPickerPerformance: PickerPerformanceMetric? {
        guard let email = sessionProfile?.effectiveUser.email.lowercased() else { return nil }
        return pickerPerformance.first { $0.email.lowercased() == email }
    }

    var sessionDisplayName: String {
        let displayName = sessionProfile?.effectiveUser.displayName?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let displayName, !displayName.isEmpty { return displayName }
        return sessionProfile?.effectiveUser.email ?? "ClawPilot user"
    }

    var sessionOrganizationName: String {
        sessionProfile?.activeWorkspace.name
            ?? sessionProfile?.effectiveUser.organizationName
            ?? "ClawPilot workspace"
    }

    var webOrigin: URL { api.webOrigin }

    var walkthroughScreen: String? {
#if DEBUG
        ProcessInfo.processInfo.arguments
            .first { $0.hasPrefix("--walkthrough=") }?
            .replacingOccurrences(of: "--walkthrough=", with: "")
#else
        nil
#endif
    }

    init() {
        let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        )[0].appendingPathComponent("ClawPilotPicking", isDirectory: true)
        cache = try! DurablePickCache(directory: support)
        let configured = Bundle.main.object(
            forInfoDictionaryKey: "ClawPilotServerOrigin"
        ) as? String ?? "https://build.invalid"
        api = try! PickingAPIClient(origin: URL(string: configured)!)
        picking = PickingSession(cache: cache)
        voicePackState = voice.voicePackState
        instructionLanguage = voice.instructionLanguage
        pronunciationCorrections = voice.pronunciationCorrections
        voice.onVoicePackStateChange = { [weak self] state in
            self?.voicePackState = state
        }
        Task { [weak self] in
            guard let self else { return }
            await self.voice.prepareInstalledVoicePack()
#if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--voice-self-test") {
                print("CLAWPILOT_VOICE_SELF_TEST \(await self.voice.runOfflineVoiceSelfTest())")
            }
            if ProcessInfo.processInfo.arguments.contains("--speech-auth-self-test") {
                print("CLAWPILOT_SPEECH_AUTH_SELF_TEST \(await self.voice.runSpeechAuthorizationSelfTest())")
            }
            if ProcessInfo.processInfo.arguments.contains("--listening-self-test") {
                print("CLAWPILOT_LISTENING_SELF_TEST \(await self.voice.runListeningSelfTest())")
            }
#endif
        }
        watch.onCommand = { [weak self] command in
            Task { await self?.handleWatchCommand(command) }
        }
        do {
            try MetaWearablesAppBridge.configure()
            metaStatus = "Meta SDK ready for registration."
        } catch {
            metaStatus = "Meta SDK unavailable. Use iPhone camera."
        }
#if DEBUG
        if let walkthroughScreen {
            isRestoringSession = false
            if walkthroughScreen != "login" {
                sessionProfile = ClawPilotSessionProfile(
                    user: "manager@example.com",
                    effectiveUser: .init(
                        email: "manager@example.com",
                        displayName: "Alex Morgan",
                        role: "admin",
                        organizationName: "Suburbia Sandwich Co.",
                        organizationRole: "admin"
                    ),
                    mobileCapabilities: .init(
                        canUsePicker: true,
                        canUseManager: true
                    ),
                    activeWorkspace: .init(
                        organizationId: "11111111-1111-4111-8111-111111111111",
                        referenceCode: "SUBURBIA",
                        name: "Suburbia Sandwich Co.",
                        role: "admin",
                        isDefault: true
                    ),
                    availableWorkspaces: [
                        .init(
                            organizationId: "11111111-1111-4111-8111-111111111111",
                            referenceCode: "SUBURBIA",
                            name: "Suburbia Sandwich Co.",
                            role: "admin",
                            isDefault: true
                        ),
                        .init(
                            organizationId: "22222222-2222-4222-8222-222222222222",
                            referenceCode: "FAIRE",
                            name: "Faire Wholesale",
                            role: "manager"
                        ),
                    ]
                )
                isAuthenticated = true
            }
            managerOrders = [
                .init(
                    id: "1",
                    globalId: "gor0000001",
                    orderNumber: "10482",
                    customerName: "Faire Wholesale",
                    status: "planned",
                    warehouseName: "Main Warehouse",
                    lineCount: 6
                ),
                .init(
                    id: "2",
                    globalId: "gor0000002",
                    orderNumber: "10481",
                    customerName: "Shopify Direct",
                    status: "released",
                    warehouseName: "Main Warehouse",
                    lineCount: 3
                ),
                .init(
                    id: "3",
                    globalId: "gor0000003",
                    orderNumber: "10479",
                    customerName: "Westside Market",
                    status: "picking",
                    warehouseName: "Main Warehouse",
                    lineCount: 9
                ),
            ]
            managerPickers = [
                .init(email: "jamie@example.com", displayName: "Jamie Lee"),
                .init(email: "taylor@example.com", displayName: "Taylor Reed"),
            ]
            pickerPerformance = [
                .init(
                    email: "jamie@example.com",
                    displayName: "Jamie Lee",
                    unitsToday: 84,
                    unitsSevenDays: 462,
                    ordersSevenDays: 31,
                    uphToday: 118.4,
                    uphSevenDays: 111.7
                ),
                .init(
                    email: "taylor@example.com",
                    displayName: "Taylor Reed",
                    unitsToday: 61,
                    unitsSevenDays: 398,
                    ordersSevenDays: 27,
                    uphToday: 104.2,
                    uphSevenDays: 101.5
                ),
            ]
            managerStatus = "Review an order to wave and assign its picks."
            if walkthroughScreen == "assignment" {
                managerSelectedOrder = .init(
                    globalId: "gor0000001",
                    orderNumber: "10482",
                    customerName: "Faire Wholesale",
                    status: "planned",
                    warehouseName: "Main Warehouse",
                    rowVersion: 8,
                    planStatus: "planned",
                    waveStatus: nil,
                    pickTaskCount: 6,
                    readyPickTaskCount: 0,
                    pickedPickTaskCount: 0
                )
            }
            if walkthroughScreen == "picker" {
                currentTask = try? PickTask(
                    pickTaskGlobalId: "gpk0000001",
                    sequence: 1,
                    productGlobalId: "gp0000001",
                    productName: "Bacon Bits 20lb · Shopify",
                    channelSku: "AG-BITS-BA-BK",
                    barcode: "850019783162",
                    locationCode: "PICK-01",
                    quantity: 1
                )
                metaCameraGranted = true
                metaConnectedDeviceCount = 1
                metaStatus = "Registered with Meta · camera granted · 1 glasses connection."
                audioRouteStatus = "Automatic audio will prefer connected Bluetooth audio when playback starts."
                status = "Assigned picks cached."
            }
        }
#endif
    }

    func restoreAndRefresh() async {
        if walkthroughScreen != nil { return }
        isRestoringSession = true
        defer { isRestoringSession = false }
        await refreshMetaStatus()
        _ = try? await picking.restore()
        await updateProjection()
        do {
            sessionProfile = try await api.fetchSessionProfile()
            isAuthenticated = true
            syncMetaConnection()
        } catch {
            sessionProfile = nil
            isAuthenticated = false
            status = "Sign in to continue."
            return
        }
        if let pending = try? await cache.loadOutbox() {
            hasPendingConfirmation = true
            status = "A prior confirmation is pending. Replaying the same command."
            do {
                try await api.confirm(pending)
                isAuthenticated = true
                try await picking.finishConfirmedOrder()
                hasPendingConfirmation = false
                status = "Prior confirmation reconciled."
            } catch {
                status = "Prior confirmation remains pending; no new key was created."
            }
        } else {
            status = "Choose a workflow to begin."
        }
        isRestoringSession = false
        await handlePendingSystemScan()
    }

    func requestCode() async {
        guard canSendCode else { return }
        isAuthBusy = true
        defer { isAuthBusy = false }
        do {
            try await api.requestMagicCode(email: email)
            codeRequested = true
            status = "Code requested. Check your email before requesting another."
        } catch PickingAPIError.rateLimited(let seconds) {
            startCodeRequestCooldown(seconds: seconds)
        } catch {
            status = "Code request failed: \(error.localizedDescription)"
        }
    }

    private func startCodeRequestCooldown(seconds: Int) {
        codeRequestCooldown?.cancel()
        canRequestCode = false
        codeRequestCooldown = Task { [weak self] in
            guard let self else { return }
            for remaining in stride(from: max(1, seconds), through: 1, by: -1) {
                guard !Task.isCancelled else { return }
                status = "Too many code requests. Try again in \(remaining) seconds."
                try? await Task.sleep(for: .seconds(1))
            }
            guard !Task.isCancelled else { return }
            canRequestCode = true
            status = "You can request one new code now."
        }
    }

    func verifyCode() async {
        guard canVerifyCode else { return }
        isAuthBusy = true
        defer { isAuthBusy = false }
        do {
            try await api.verifyMagicCode(email: email, code: code)
            sessionProfile = try await api.fetchSessionProfile()
            isAuthenticated = true
            codeRequested = false
            code = ""
            status = "Signed in. Choose a workflow to begin."
        } catch {
            isAuthenticated = false
            status = "Sign-in failed: \(error.localizedDescription)"
        }
    }

    func preparePickerWorkflow() async {
        guard canUsePicker else {
            status = "Picker access is not assigned to this account."
            return
        }
        syncMetaConnection()
        await loadQueue(readAloud: false)
        await loadPickerPerformance()
    }

    func switchWorkspace(to organizationId: String) async {
        guard let activeWorkspace,
              organizationId != activeWorkspace.organizationId else { return }
        guard canSwitchWorkspace else {
            workspaceStatus = hasPendingConfirmation
                ? "Confirm or reconcile the current pick before changing organizations."
                : "Wait for the current operation to finish before changing organizations."
            return
        }
        guard availableWorkspaces.contains(where: { $0.organizationId == organizationId }) else {
            workspaceStatus = "That organization is not available to this account."
            return
        }

        isWorkspaceBusy = true
        workspaceStatus = "Changing organization and clearing scoped mobile data…"
        defer { isWorkspaceBusy = false }

        do {
            if isMetaScanning { await cancelMetaScan() }
            try await api.switchWorkspace(to: organizationId)

            managerOrders = []
            managerPickers = []
            pickerPerformance = []
            managerSelectedOrder = nil
            currentTask = nil
            readyToConfirm = false
            try await picking.clearQueue()
            await updateProjection()

            sessionProfile = try await api.fetchSessionProfile()
            isAuthenticated = true

            if canUseManager { await loadManagerOperations() }
            if canUsePicker {
                await loadQueue(readAloud: false)
                await loadPickerPerformance()
            }

            let name = sessionProfile?.activeWorkspace.name ?? "the selected organization"
            workspaceStatus = "Now using " + name + ". Organization-scoped data is refreshed."
            status = "Organization changed to " + name + "."
        } catch PickingAPIError.unauthorized {
            sessionProfile = nil
            isAuthenticated = false
            workspaceStatus = "Your session expired while changing organizations. Sign in again."
            status = "Sign in to continue."
        } catch {
            workspaceStatus = "Organization change failed: " + error.localizedDescription
        }
    }

    func loadManagerOperations() async {
        if walkthroughScreen != nil { return }
        guard canUseManager else {
            managerStatus = "Manager access is not assigned to this account."
            return
        }
        isManagerBusy = true
        defer { isManagerBusy = false }
        do {
            async let orders = api.fetchManagerOrders()
            async let pickers = api.fetchManagerPickers()
            async let performance = api.fetchPickerPerformance()
            managerOrders = try await orders
            managerPickers = try await pickers
            pickerPerformance = try await performance
            managerStatus = managerOrders.isEmpty
                ? "No Operations orders are available."
                : "Review an order to wave and assign its picks."
        } catch {
            managerStatus = "Manager orders could not be loaded: \(error.localizedDescription)"
        }
    }

    func loadManagerOrder(_ order: ManagerOrderSummary) async {
        if walkthroughScreen != nil {
            managerSelectedOrder = ManagerOrderDetail(
                globalId: order.globalId,
                orderNumber: order.orderNumber,
                customerName: order.customerName,
                status: order.status,
                warehouseName: order.warehouseName,
                rowVersion: 8,
                planStatus: order.status == "planned" ? "planned" : "released",
                waveStatus: order.status == "planned" ? nil : "released",
                pickTaskCount: order.lineCount,
                readyPickTaskCount: order.status == "planned" ? 0 : order.lineCount,
                pickedPickTaskCount: 0
            )
            return
        }
        isManagerBusy = true
        defer { isManagerBusy = false }
        do {
            managerSelectedOrder = try await api.fetchManagerOrderDetail(order.globalId)
            managerStatus = "Choose an eligible picker before sending warehouse work."
        } catch {
            managerSelectedOrder = nil
            managerStatus = "Order details could not be loaded: \(error.localizedDescription)"
        }
    }

    func releaseOrAssignManagerOrder(
        assignedTo: String,
        reason: String
    ) async -> Bool {
        guard let order = managerSelectedOrder else { return false }
        isManagerBusy = true
        defer { isManagerBusy = false }
        do {
            if order.status == "planned" {
                try await api.releaseManagerOrder(
                    order,
                    assignedTo: assignedTo,
                    reason: reason
                )
                managerStatus = "Order waved and assigned to \(assignedTo)."
            } else if order.status == "released" {
                try await api.assignManagerOrder(
                    order,
                    assignedTo: assignedTo,
                    reason: reason
                )
                managerStatus = "Ready picks assigned to \(assignedTo)."
            } else {
                managerStatus = "Only planned or released orders can be assigned here."
                return false
            }
            managerSelectedOrder = nil
            await loadManagerOperations()
            return true
        } catch {
            managerStatus = "Warehouse assignment failed: \(error.localizedDescription)"
            return false
        }
    }

    func logout() async {
        do {
            try await api.logout()
        } catch {
            status = "Sign out failed: \(error.localizedDescription)"
            return
        }
        await WebSessionBridge.clearCookies()
        sessionProfile = nil
        isAuthenticated = false
        codeRequested = false
        code = ""
        currentTask = nil
        readyToConfirm = false
        status = "Signed out."
        managerOrders = []
        managerPickers = []
        pickerPerformance = []
        managerSelectedOrder = nil
    }

    func loadQueue(readAloud: Bool = true) async {
        guard !hasPendingConfirmation else {
            status = "Resolve the pending confirmation before loading new work."
            return
        }
        isQueueBusy = true
        defer { isQueueBusy = false }
        do {
            let queue = try await api.fetchQueue()
            isAuthenticated = true
            try await picking.replaceQueue(queue)
            status = queue.orders.isEmpty ? "No released picks are assigned to this worker." : "Assigned picks cached."
            await updateProjection()
            if readAloud { readInstruction() }
        } catch PickingAPIError.unauthorized {
            isAuthenticated = false
            status = "Sign in to load assigned picks."
        } catch {
            status = "Pick queue refresh failed: \(error.localizedDescription)"
        }
    }

    func loadPickerPerformance() async {
        do {
            pickerPerformance = try await api.fetchPickerPerformance()
        } catch {
            // Performance is supporting context; never block assigned work on it.
        }
    }

    func accept(_ value: String, source: BarcodeSource) async {
        guard !hasPendingConfirmation else { return }
        do {
            _ = try await picking.accept(BarcodeObservation(value: value, source: source))
            status = "Barcode matched."
            if source == .metaGlasses {
                ClawPilotScanDiagnostic.record("matched:\(value)")
            }
            await updateProjection()
            if source == .metaGlasses, readyToConfirm {
                await beginHandsFreeConfirmation()
            } else {
                readInstruction()
            }
        } catch PickingContractError.barcodeMismatch {
            status = "Barcode does not match the current assigned product."
            if source == .metaGlasses {
                ClawPilotScanDiagnostic.record("mismatch:\(value)")
            }
            voice.speak(
                "Wrong product. Scan the displayed product.",
                spanish: "Producto incorrecto. Escanea el producto mostrado."
            )
            refreshAudioRouteStatus()
        } catch { status = "Scan rejected: \(error.localizedDescription)" }
    }

    func scanWithMeta() async {
        guard !isMetaScanning else {
            ClawPilotScanDiagnostic.record("request-ignored:scan-already-active")
            return
        }
        guard currentTask != nil else {
            metaStatus = "Load an assigned pick before starting the glasses camera."
            ClawPilotScanDiagnostic.record("blocked:no-assigned-pick")
            return
        }
        guard metaScanReady else {
            metaStatus = "Waiting for one connected Meta glasses device. Open Meta AI once if it does not reconnect."
            ClawPilotScanDiagnostic.record("blocked:meta-not-ready")
            syncMetaConnection()
            return
        }
        isMetaScanning = true
        defer { isMetaScanning = false }
        do {
            var startedSource: MetaWearablesBarcodeSource?
            var startError: Error?
            for attempt in 1...3 {
                let candidate = MetaWearablesBarcodeSource()
                metaSource = candidate
                metaStatus = "Starting the Meta glasses camera (attempt \(attempt)/3)…"
                ClawPilotScanDiagnostic.record("camera-starting:\(attempt)")
                do {
                    try await candidate.start()
                    startedSource = candidate
                    break
                } catch {
                    startError = error
                    ClawPilotScanDiagnostic.record("camera-start-failed:\(attempt):\(error.localizedDescription)")
                    await candidate.stop()
                    metaSource = nil
                    if attempt < 3 { try? await Task.sleep(for: .seconds(1)) }
                }
            }
            guard let source = startedSource else {
                throw startError ?? MetaScanError.sessionFailed
            }
            metaStatus = "Meta camera is live. Look directly at the product barcode; no photo is saved."
            ClawPilotScanDiagnostic.record("camera-live")
            let value = await withTaskGroup(of: String?.self) { group in
                group.addTask {
                    for await value in source.barcodes { return value }
                    return nil
                }
                group.addTask {
                    try? await Task.sleep(for: .seconds(15))
                    return nil
                }
                let first = await group.next() ?? nil
                group.cancelAll()
                return first
            }
            if let value {
                ClawPilotScanDiagnostic.record("decoded:\(value)")
                await source.stop()
                metaSource = nil
                metaStatus = "Meta scan complete."
                await accept(value, source: .metaGlasses)
                return
            }
            await source.stop()
            metaSource = nil
            metaStatus = "No barcode was found within 15 seconds. Start another glasses scan or use the iPhone camera."
            ClawPilotScanDiagnostic.record("timeout:no-barcode")
            voice.speak(
                "No barcode found. Try the glasses scan again or use the iPhone camera.",
                spanish: "No se encontró un código de barras. Intenta otra vez con las gafas o usa la cámara del iPhone."
            )
            refreshAudioRouteStatus()
        } catch {
            metaStatus = "Meta scan unavailable. Use iPhone camera: \(error.localizedDescription)"
            ClawPilotScanDiagnostic.record("error:\(error.localizedDescription)")
            if let metaSource { await metaSource.stop() }
            metaSource = nil
        }
    }

    func handlePendingSystemScan() async {
        guard PendingMobileAction.hasMetaScanRequest else { return }
        guard !isRestoringSession else { return }
        guard !isHandlingPendingSystemScan else {
            ClawPilotScanDiagnostic.record("request-ignored:handoff-already-active")
            return
        }
        isHandlingPendingSystemScan = true
        defer { isHandlingPendingSystemScan = false }
        ClawPilotScanDiagnostic.record("request-processing")
        status = "Siri scan received. Preparing the assigned item and Meta glasses."
        guard isAuthenticated, canUsePicker else {
            status = "Sign in with Picker access, then say “Hey Siri, scan with ClawPilot” again."
            PendingMobileAction.clearMetaScanRequest()
            ClawPilotScanDiagnostic.record("blocked:not-authenticated-picker")
            return
        }
        if currentTask == nil { await loadQueue(readAloud: false) }
        guard currentTask != nil else {
            status = "No released pick is assigned to scan."
            PendingMobileAction.clearMetaScanRequest()
            ClawPilotScanDiagnostic.record("blocked:no-released-pick")
            return
        }

        for attempt in 0..<8 {
            await refreshMetaStatus()
            if metaScanReady { break }
            status = "Siri scan received. Waiting for the Meta glasses camera (\(attempt + 1)/8)."
            if attempt < 7 { try? await Task.sleep(for: .seconds(1)) }
        }
        guard metaScanReady else {
            status = "Siri opened ClawPilot, but one camera-ready Meta glasses connection is required."
            PendingMobileAction.clearMetaScanRequest()
            ClawPilotScanDiagnostic.record("blocked:meta-not-camera-ready")
            return
        }

        PendingMobileAction.clearMetaScanRequest()
        await scanWithMeta()
    }

    func cancelMetaScan() async {
        guard let metaSource else { return }
        await metaSource.stop()
        self.metaSource = nil
        isMetaScanning = false
        metaStatus = "Meta scan stopped."
    }

    func registerMeta() async {
        guard canRegisterMeta else {
            await refreshMetaStatus()
            return
        }
        do {
            try await MetaWearablesAppBridge.startRegistration()
            metaStatus = "Meta registration started. Approve it in Meta AI."
            canRegisterMeta = false
        }
        catch { metaStatus = "Meta registration failed: \(error.localizedDescription)" }
    }

    func resetMetaConnection() async {
        guard canManageMetaConnection else {
            await refreshMetaStatus()
            return
        }
        await cancelMetaScan()
        do {
            metaStatus = "Opening Meta AI to remove ClawPilot authorization."
            try await MetaWearablesAppBridge.startUnregistration()
        } catch {
            metaStatus = "Meta connection reset failed: \(error.localizedDescription)"
        }
        await refreshMetaStatus()
    }

    func checkMetaFirmwareUpdate() async {
        do {
            metaStatus = "Opening the glasses firmware check in Meta AI."
            try await MetaWearablesAppBridge.openFirmwareUpdate()
        } catch {
            metaStatus = "Could not open the glasses firmware check: \(error.localizedDescription)"
        }
    }

    func checkMetaAppUpdate() async {
        do {
            metaStatus = "Opening the Meta AI app update check."
            try await MetaWearablesAppBridge.openMetaAppUpdate()
        } catch {
            metaStatus = "Could not open the Meta AI update check: \(error.localizedDescription)"
        }
    }

    func requestMetaCamera() async {
        guard MetaWearablesAppBridge.isRegistered else {
            metaStatus = "Register this app with Meta before requesting camera access."
            await refreshMetaStatus()
            return
        }
        do {
            metaStatus = try await MetaWearablesAppBridge.requestCameraPermission()
                ? "Meta camera access granted." : "Meta camera access denied."
        } catch { metaStatus = "Meta camera request failed: \(error.localizedDescription)" }
        await refreshMetaStatus()
    }

    func handleMetaURL(_ url: URL) async {
        do {
            let handled = try await MetaWearablesAppBridge.handleOpenURL(url)
            metaStatus = handled ? "Meta setup callback received." : "The callback was not recognized by Meta."
        } catch {
            metaStatus = "Meta setup callback failed: \(error.localizedDescription)"
        }
        await refreshMetaStatus()
    }

    func refreshMetaStatus() async {
        let snapshot = await MetaWearablesAppBridge.statusSnapshot()
        metaConnectedDeviceCount = snapshot.connectedDeviceCount
        let deviceLabel = snapshot.connectedDeviceCount == 1
            ? "1 glasses connection"
            : "\(snapshot.connectedDeviceCount) glasses connections"
        switch snapshot.registrationState {
        case .unavailable:
            canRegisterMeta = false
            canRequestMetaCamera = false
            metaCameraGranted = false
            metaStatus = "Meta registration is unavailable. Confirm Meta AI is installed."
        case .available:
            canRegisterMeta = true
            canRequestMetaCamera = false
            metaCameraGranted = false
            metaStatus = "Ready to register with Meta · \(deviceLabel)."
        case .registering:
            canRegisterMeta = false
            canRequestMetaCamera = false
            metaCameraGranted = false
            metaStatus = "Waiting for Meta AI registration approval · \(deviceLabel)."
        case .registered:
            canRegisterMeta = false
            metaCameraGranted = snapshot.cameraPermissionGranted == true
            canRequestMetaCamera = snapshot.connectedDeviceCount > 0 && !metaCameraGranted
            let permissionLabel: String
            switch snapshot.cameraPermissionGranted {
            case true: permissionLabel = "camera granted"
            case false: permissionLabel = "camera not granted"
            case nil: permissionLabel = "camera status unavailable"
            }
            metaStatus = "Registered with Meta · \(permissionLabel) · \(deviceLabel)."
        @unknown default:
            canRegisterMeta = false
            canRequestMetaCamera = false
            metaCameraGranted = false
            metaStatus = "Unknown Meta registration state. iPhone camera remains available."
        }
    }

    func syncMetaConnection() {
        if walkthroughScreen != nil { return }
        metaConnectionRefreshTask?.cancel()
        isMetaSyncing = true
        metaConnectionRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer { isMetaSyncing = false }
            for attempt in 0..<8 {
                guard !Task.isCancelled else { return }
                await refreshMetaStatus()
                if metaConnectedDeviceCount == 1 || canRegisterMeta { return }
                if attempt < 7 { try? await Task.sleep(for: .seconds(1)) }
            }
        }
    }

    func readInstruction() {
        if let currentTask {
            voice.speak(PickVoice.instruction(
                for: currentTask,
                languageCode: instructionLanguage.languageCode
            ))
        } else if readyToConfirm {
            voice.speak(
                "All products scanned. Say confirm pick to submit the order.",
                spanish: "Todos los productos están escaneados. Di confirmar pedido para enviarlo."
            )
        }
        refreshAudioRouteStatus()
    }

    func listenForPickCommand() async {
        guard currentTask != nil || readyToConfirm || isMetaScanning else {
            status = "Load an assigned pick before starting voice control."
            return
        }
        isListeningForPickCommand = true
        do {
            try await voice.listen(
                preferBluetoothInput: metaConnectedDeviceCount == 1
            ) { [weak self] transcript in
                guard let self else { return }
                self.isListeningForPickCommand = false
                Task { await self.handlePickVoiceAction(transcript) }
            }
            status = currentTask != nil
                ? "Listening. Say “Start glasses scan.”"
                : "Listening. Say “Confirm pick.”"
            refreshAudioRouteStatus()
        } catch {
            isListeningForPickCommand = false
            status = "Voice command unavailable: \(error.localizedDescription)"
        }
    }

    func stopListeningForPickCommand() {
        voice.stopListening()
        isListeningForPickCommand = false
        status = "Voice command stopped."
    }

    private func handleWatchCommand(_ command: WatchPickCommand) async {
        switch command.action {
        case .requestMetaScan:
            status = "Apple Watch requested a glasses scan."
            await scanWithMeta()
        case .readInstruction:
            readInstruction()
        case .confirmPick:
            guard readyToConfirm else {
                status = "Scan every assigned product before confirming from Apple Watch."
                voice.speak(
                    "Scan every assigned product before confirming.",
                    spanish: "Escanea todos los productos asignados antes de confirmar."
                )
                return
            }
            await confirmOrder()
        case .refreshQueue:
            await loadQueue(readAloud: false)
        }
    }

    private func handlePickVoiceAction(_ transcript: String) async {
        guard let action = PickVoice.action(for: transcript) else {
            status = "Command not recognized. Say “Start glasses scan,” “Read instruction,” or “Confirm pick.”"
            voice.speak(
                "Command not recognized.",
                spanish: "Comando no reconocido."
            )
            refreshAudioRouteStatus()
            return
        }
        switch action {
        case .startMetaScan:
            await scanWithMeta()
        case .stopMetaScan:
            await cancelMetaScan()
        case .readInstruction:
            readInstruction()
        case .confirmPick:
            guard readyToConfirm else {
                status = "Scan every assigned product before confirming the pick."
                voice.speak(
                    "Scan every assigned product before confirming.",
                    spanish: "Escanea todos los productos asignados antes de confirmar."
                )
                refreshAudioRouteStatus()
                return
            }
            await confirmOrder()
        }
    }

    private func beginHandsFreeConfirmation() async {
        guard readyToConfirm, !hasPendingConfirmation, !isConfirmingOrder else { return }
        status = "Barcode matched. Voice confirmation will listen after the prompt."
        await voice.speakAndWait(
            "Item matched. Say confirm pick to submit.",
            spanish: "Producto correcto. Di confirmar pedido para enviarlo."
        )
        guard readyToConfirm, !hasPendingConfirmation, !isConfirmingOrder else { return }
        await listenForConfirmation(automatic: true)
    }

    func listenForConfirmation(automatic: Bool = false) async {
        guard readyToConfirm, !hasPendingConfirmation, !isConfirmingOrder else {
            status = "Scan every assigned product before confirming the pick."
            return
        }
        do {
            try await voice.listen(
                preferBluetoothInput: metaConnectedDeviceCount == 1,
                timeout: automatic ? .seconds(8) : nil,
                onTimeout: { [weak self] in
                    guard let self else { return }
                    self.status = "Voice confirmation timed out. Say confirm pick after tapping Voice confirm, or use Confirm picks."
                    self.refreshAudioRouteStatus()
                }
            ) { [weak self] transcript in
                guard let self else { return }
                if PickVoice.isConfirmation(transcript) {
                    self.status = "Confirming the audited picks with ClawPilot."
                    Task { await self.confirmOrder() }
                } else {
                    self.status = "Confirmation phrase not recognized. Say confirm pick or use Confirm picks."
                }
            }
            status = automatic
                ? "Listening for confirm pick for 8 seconds."
                : "Listening for confirm pick."
            refreshAudioRouteStatus()
        } catch { status = "Voice confirmation unavailable: \(error.localizedDescription)" }
    }

    func refreshAudioRouteStatus() {
        audioRouteStatus = voice.routeDescription(metaConnected: metaConnectedDeviceCount == 1)
    }

    func previewVoice() {
        voice.speak(
            "ClawPilot voice check. Your next pick instruction will sound like this.",
            spanish: "Prueba de voz de ClawPilot. Tu próxima instrucción sonará así."
        )
        refreshAudioRouteStatus()
    }

    func installEnhancedVoicePack() async {
        await voice.installVoicePack()
    }

    func removeEnhancedVoicePack() async {
        await voice.removeVoicePack()
    }

    func selectInstructionLanguage(_ language: InstructionVoiceLanguage) {
        instructionLanguage = language
        voice.setInstructionLanguage(language)
    }

    @discardableResult
    func addPronunciationCorrection(written: String, spoken: String) -> Bool {
        guard voice.addPronunciationCorrection(written: written, spoken: spoken) else {
            return false
        }
        pronunciationCorrections = voice.pronunciationCorrections
        voice.previewPronunciation(spoken)
        return true
    }

    func removePronunciationCorrection(id: UUID) {
        voice.removePronunciationCorrection(id: id)
        pronunciationCorrections = voice.pronunciationCorrections
    }

    func previewPronunciation(_ correction: PronunciationCorrection) {
        voice.previewPronunciation(correction.spoken)
    }

    func openAppSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    func confirmOrder() async {
        guard readyToConfirm, !hasPendingConfirmation, !isConfirmingOrder else { return }
        isConfirmingOrder = true
        defer { isConfirmingOrder = false }
        do {
            let command = try await picking.persistConfirmation()
            hasPendingConfirmation = true
            try await api.confirm(command)
            try await picking.finishConfirmedOrder()
            hasPendingConfirmation = false
            status = "ClawPilot confirmed and audited the picks."
            voice.speak("Picks confirmed.", spanish: "Pedido confirmado.")
            refreshAudioRouteStatus()
            await loadPickerPerformance()
            await loadQueue(readAloud: false)
        } catch {
            status = "Confirmation is pending or rejected. Refresh before new work: \(error.localizedDescription)"
        }
    }

    func retryPendingConfirmation() async {
        guard let pending = try? await cache.loadOutbox() else {
            hasPendingConfirmation = false
            return
        }
        do {
            try await api.confirm(pending)
            try await picking.finishConfirmedOrder()
            hasPendingConfirmation = false
            status = "Pending confirmation reconciled."
            await loadQueue()
        } catch {
            status = "The exact confirmation remains unresolved."
        }
    }

    private func updateProjection() async {
        currentTask = await picking.currentTask()
        let activeOrder = await picking.currentOrder()
        readyToConfirm = currentTask == nil && activeOrder != nil
        watch.publish(await picking.makeWatchSnapshot())
    }
}
