import AVFoundation
import SwiftUI
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
                .onOpenURL { url in Task { await model.handleMetaURL(url) } }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    model.syncMetaConnection()
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

    private let cache: DurablePickCache
    private let api: PickingAPIClient
    private let picking: PickingSession
    private let watch = PhoneWatchBridge()
    private let voice = VoiceConfirmationController()
    private var metaSource: MetaWearablesBarcodeSource?
    private var codeRequestCooldown: Task<Void, Never>?
    private var metaConnectionRefreshTask: Task<Void, Never>?

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

    var metaScanReady: Bool {
        metaCameraGranted && metaConnectedDeviceCount == 1 && !isMetaSyncing
    }

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
        sessionProfile?.effectiveUser.organizationName ?? "ClawPilot workspace"
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
                    )
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
            await updateProjection()
            readInstruction()
        } catch PickingContractError.barcodeMismatch {
            status = "Barcode does not match the current assigned product."
            voice.speak("Wrong product. Scan the displayed product.")
        } catch { status = "Scan rejected: \(error.localizedDescription)" }
    }

    func scanWithMeta() async {
        guard currentTask != nil else {
            metaStatus = "Load an assigned pick before starting the glasses camera."
            return
        }
        guard metaScanReady else {
            metaStatus = "Waiting for one connected Meta glasses device. Open Meta AI once if it does not reconnect."
            syncMetaConnection()
            return
        }
        let source = MetaWearablesBarcodeSource()
        metaSource = source
        isMetaScanning = true
        defer { isMetaScanning = false }
        do {
            try await source.start()
            metaStatus = "Meta camera is live. Look directly at the product barcode; no photo is saved."
            for await value in source.barcodes {
                await accept(value, source: .metaGlasses)
                await source.stop()
                metaSource = nil
                metaStatus = "Meta scan complete."
                return
            }
            metaSource = nil
            metaStatus = "Meta scan stopped. Start it again when the barcode is in view."
        } catch {
            metaStatus = "Meta scan unavailable. Use iPhone camera: \(error.localizedDescription)"
            await source.stop()
            metaSource = nil
        }
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
        if let currentTask { voice.speak(PickVoice.instruction(for: currentTask)) }
        else if readyToConfirm { voice.speak("All products scanned. Say confirm pick to submit the order.") }
    }

    func listenForConfirmation() async {
        do {
            try await voice.listen { [weak self] transcript in
                guard let self else { return }
                if PickVoice.isConfirmation(transcript) {
                    Task { await self.confirmOrder() }
                } else {
                    self.status = "Confirmation phrase not recognized."
                }
            }
            status = "Listening for confirm pick."
        } catch { status = "Voice confirmation unavailable: \(error.localizedDescription)" }
    }

    func confirmOrder() async {
        do {
            let command = try await picking.persistConfirmation()
            hasPendingConfirmation = true
            try await api.confirm(command)
            try await picking.finishConfirmedOrder()
            hasPendingConfirmation = false
            status = "ClawPilot confirmed and audited the picks."
            voice.speak("Picks confirmed.")
            await loadPickerPerformance()
            await loadQueue()
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
        if let snapshot = await picking.makeWatchSnapshot() { watch.publish(snapshot) }
    }
}
