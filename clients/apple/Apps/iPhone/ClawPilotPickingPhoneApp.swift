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
            NavigationStack {
                Form {
                    Section("Sign in") {
                        TextField("Email", text: $model.email)
                            .textInputAutocapitalization(.never)
                            .keyboardType(.emailAddress)
                        HStack {
                            Button("Send code") { Task { await model.requestCode() } }
                                .disabled(!model.canRequestCode)
                            TextField("6-digit code", text: $model.code)
                                .keyboardType(.numberPad)
                            Button("Verify") { Task { await model.verifyCode() } }
                        }
                    }

                    Section("Assigned pick") {
                        if model.hasPendingConfirmation {
                            Text("A prior confirmation is unresolved. New work is blocked.")
                            Button("Retry exact confirmation") {
                                Task { await model.retryPendingConfirmation() }
                            }
                        } else if let task = model.currentTask {
                            Text(task.locationCode).font(.largeTitle).bold()
                            Text(task.productName).font(.title3)
                            Text("SKU \(task.channelSku) · Qty \(task.quantity.formatted())")
                            HStack {
                                Button("iPhone scan") { model.showPhoneScanner = true }
                                Button("Meta scan") { Task { await model.scanWithMeta() } }
                            }
                            Button("Read instruction") { model.readInstruction() }
                        } else if model.readyToConfirm {
                            Text("Every product is scanned.")
                            Button("Listen for confirmation") {
                                Task { await model.listenForConfirmation() }
                            }
                            Button("Confirm picks") { Task { await model.confirmOrder() } }
                        } else {
                            Text("No assigned pick is cached.")
                            Button("Load assigned picks") { Task { await model.loadQueue() } }
                        }
                    }

                    Section("Meta glasses") {
                        Text(model.metaStatus).font(.caption)
                        HStack {
                            Button("Register") { Task { await model.registerMeta() } }
                                .disabled(!model.canRegisterMeta)
                            Button(model.metaCameraGranted ? "Camera granted" : "Camera access") {
                                Task { await model.requestMetaCamera() }
                            }
                                .disabled(!model.canRequestMetaCamera)
                        }
                    }

                    Section("Status") { Text(model.status) }
                }
                .navigationTitle("ClawPilot Picking")
                .sheet(isPresented: $model.showPhoneScanner) {
                    PhoneCameraScanner(
                        onBarcode: { value in Task { await model.accept(value, source: .iPhoneCamera) } },
                        onClose: { model.showPhoneScanner = false }
                    )
                }
                .onOpenURL { url in Task { await model.handleMetaURL(url) } }
                .onChange(of: scenePhase) { _, phase in
                    guard phase == .active else { return }
                    Task { await model.refreshMetaStatus() }
                }
                .task { await model.restoreAndRefresh() }
            }
        }
    }
}

@MainActor
final class PickingPhoneModel: ObservableObject {
    @Published var email = ""
    @Published var code = ""
    @Published var canRequestCode = true
    @Published var currentTask: PickTask?
    @Published var readyToConfirm = false
    @Published var showPhoneScanner = false
    @Published var hasPendingConfirmation = false
    @Published var status = "Sign in, then load assigned picks."
    @Published var metaStatus = "Meta setup not checked. iPhone camera remains available."
    @Published var canRegisterMeta = false
    @Published var canRequestMetaCamera = false
    @Published var metaCameraGranted = false

    private let cache: DurablePickCache
    private let api: PickingAPIClient
    private let picking: PickingSession
    private let watch = PhoneWatchBridge()
    private let voice = VoiceConfirmationController()
    private var metaSource: MetaWearablesBarcodeSource?
    private var codeRequestCooldown: Task<Void, Never>?

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
    }

    func restoreAndRefresh() async {
        await refreshMetaStatus()
        _ = try? await picking.restore()
        await updateProjection()
        if let pending = try? await cache.loadOutbox() {
            hasPendingConfirmation = true
            status = "A prior confirmation is pending. Replaying the same command."
            do {
                try await api.confirm(pending)
                try await picking.finishConfirmedOrder()
                hasPendingConfirmation = false
                status = "Prior confirmation reconciled."
            } catch {
                status = "Prior confirmation remains pending; no new key was created."
            }
        } else {
            await loadQueue(readAloud: false)
        }
    }

    func requestCode() async {
        guard canRequestCode else { return }
        do {
            try await api.requestMagicCode(email: email)
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
        do {
            try await api.verifyMagicCode(email: email, code: code)
            status = "Signed in. Loading assigned picks."
            await loadQueue()
        } catch { status = "Sign-in failed: \(error.localizedDescription)" }
    }

    func loadQueue(readAloud: Bool = true) async {
        guard !hasPendingConfirmation else {
            status = "Resolve the pending confirmation before loading new work."
            return
        }
        do {
            let queue = try await api.fetchQueue()
            try await picking.replaceQueue(queue)
            status = queue.orders.isEmpty ? "No released picks are assigned to this worker." : "Assigned picks cached."
            await updateProjection()
            if readAloud { readInstruction() }
        } catch { status = "Pick queue refresh failed: \(error.localizedDescription)" }
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
        let source = MetaWearablesBarcodeSource()
        metaSource = source
        do {
            try await source.start()
            metaStatus = "Scanning with Meta glasses."
            for await value in source.barcodes {
                await accept(value, source: .metaGlasses)
                await source.stop()
                metaSource = nil
                metaStatus = "Meta scan complete."
                return
            }
        } catch {
            metaStatus = "Meta scan unavailable. Use iPhone camera: \(error.localizedDescription)"
            await source.stop()
            metaSource = nil
        }
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
