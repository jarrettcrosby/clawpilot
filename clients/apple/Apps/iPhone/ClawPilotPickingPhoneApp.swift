import AVFoundation
import GoogleSignIn
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
                    if let scanContext = model.phoneCameraScanContext {
                        PhoneCameraScanner(
                            scanContext: scanContext,
                            onBarcode: { value in await model.acceptPhoneCameraBarcode(value) },
                            onMismatch: { stage in model.announcePhoneCameraMismatch(stage) },
                            onClose: { model.showPhoneScanner = false }
                        )
                        .ignoresSafeArea()
                        .interactiveDismissDisabled()
                    } else {
                        ContentUnavailableView {
                            Label("No barcode to scan", systemImage: "barcode.viewfinder")
                        } description: {
                            Text("Close the camera and load an assigned pick before scanning.")
                        } actions: {
                            Button("Close") { model.showPhoneScanner = false }
                        }
                    }
                }
                .sheet(isPresented: $model.showCountEntry) {
                    if let context = model.currentStageContext,
                       context.stage == .count {
                        PickedCountEntrySheet(model: model, context: context)
                    } else {
                        ContentUnavailableView(
                            "Count no longer needed",
                            systemImage: "checkmark.circle"
                        )
                    }
                }
                .onOpenURL { url in
                    Task {
                        if GIDSignIn.sharedInstance.handle(url) {
                            return
                        } else if ClawPilotSystemActionLink.requestsScan(url) {
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
    private enum MetaBarcodeWaitOutcome: Sendable {
        case value(String)
        case timedOut
        case sourceEnded
        case cancelled
    }

    private enum WorkspaceTransitionRecoveryOutcome: Equatable {
        case none
        case resolved
        case blocked
    }

    @Published var email = ""
    @Published var code = ""
    @Published var canRequestCode = true
    @Published var codeRequested = false
    @Published var isAuthenticated = false
    @Published var isRestoringSession = true
    @Published var isAuthBusy = false
    @Published var isQueueBusy = false
    @Published var isWorkspaceBusy = false
    @Published private(set) var hasPendingWorkspaceTransition = false
    @Published var workspaceStatus = "Orders, assigned picks, people, and UPH follow this organization."
    @Published var sessionProfile: ClawPilotSessionProfile?
    @Published var managerOrders: [ManagerOrderSummary] = []
    @Published var managerStoreSyncControls: [ManagerStoreSyncControl] = []
    @Published private(set) var canManageStoreSync = false
    @Published private(set) var isManagerStoreSyncBusy = false
    @Published private(set) var hasPendingManagerStoreSyncChange = false
    @Published private(set) var managerStoreSyncStatus: String?
    @Published var managerPickers: [ManagerPicker] = []
    @Published var pickerPerformance: [PickerPerformanceMetric] = []
    @Published var managerPickManagement: ManagerPickManagementWorkspace?
    @Published var managerSelectedPickAssignment: ManagerCurrentPickAssignment?
    @Published var managerSelectedOrder: ManagerOrderDetail?
    @Published var managerStatus = "Loading Operations orders."
    @Published var isManagerBusy = false
    @Published private(set) var hasPendingManagerOrderReplanning = false
    @Published private(set) var isReplayingManagerOrderReplanning = false
    @Published private(set) var managerOrderReplanningDetail: String?
    @Published private(set) var managerOrderReplanningRefreshRequired = false
    @Published private(set) var managerOrderReplanningRecoveryWorkspaceId: String?
    @Published var currentTask: PickTask?
    @Published var currentOrderNumber: String?
    @Published var currentScanStage: PickScanStage?
    @Published var currentWorkflowStage: PickWorkflowStage?
    @Published var currentStageContext: PickStageContext?
    @Published var showCountEntry = false
    @Published var readyToConfirm = false
    @Published private(set) var activePickHandoffEligible = false
    @Published var showPhoneScanner = false
    @Published var hasPendingConfirmation = false
    @Published private(set) var pendingConfirmationRequiresManagerAction = false
    @Published private(set) var pendingConfirmationIdentityMismatch = false
    @Published private(set) var pendingConfirmationRecoveryWorkspaceId: String?
    @Published private(set) var pendingConfirmationDetail: String?
    @Published private(set) var isRecheckingPendingConfirmation = false
    @Published private(set) var hasPendingPickHandoff = false
    @Published private(set) var isRequestingPickHandoff = false
    @Published private(set) var pendingPickHandoffDetail: String?
    @Published private(set) var pendingPickHandoffRecoveryWorkspaceId: String?
    @Published var showPickHandoffConfirmation = false
    @Published var pickHandoffReason = ""
    @Published var status = "Sign in to continue."
    @Published var metaStatus = "Meta setup not checked. iPhone camera remains available."
    @Published var canRegisterMeta = false
    @Published var canRequestMetaCamera = false
    @Published var metaCameraGranted = false
    @Published var metaConnectedDeviceCount = 0
    @Published var metaGlassesAppUpdateRequired = false
    @Published var isMetaSyncing = false
    @Published var isMetaScanning = false
    @Published var isListeningForPickCommand = false
    @Published private(set) var isConfirmingOrder = false
    @Published var audioRouteStatus = "Automatic audio uses the iPhone speaker when no accessory is connected."
    @Published var voicePackState: OfflineVoicePackState = .checking
    @Published var instructionLanguage: InstructionVoiceLanguage = .english
    @Published var pronunciationCorrections: [PronunciationCorrection] = []
    @Published var biometricUnlockEnabled = false
    @Published var isLocallyLocked = false
    @Published var biometricStatus = "Face ID can unlock an existing ClawPilot session on this iPhone."
    @Published var googleAuthState: GoogleAuthState?
    @Published var isGoogleLinkBusy = false
    @Published var googleLinkStatus = "Each user links their own Google account after signing in with a magic code."

    private let cache: DurablePickCache
    private let api: PickingAPIClient
    private let picking: PickingSession
    private let watch = PhoneWatchBridge()
    private let voice = VoiceConfirmationController()
    private let biometrics = BiometricUnlockController()
    private var metaSource: MetaWearablesBarcodeSource?
    private var activeMetaScanID: UUID?
    private var isMetaScanStopping = false
    private var mostRecentlyCancelledMetaScanID: UUID?
    private var cancelledMetaAcceptanceStage: PickScanStage?
    private var codeRequestCooldown: Task<Void, Never>?
    private var metaConnectionRefreshTask: Task<Void, Never>?
    private var isHandlingPendingSystemScan = false
    private var metaProductStartContinuation: CheckedContinuation<Bool, Never>?
    private var metaProductStartScanID: UUID?
    private var metaProductStartRequestedScanID: UUID?
    private var dismissedCountContextToken: String?
    private var authenticationGeneration: UInt64 = 0
    private var workspaceSwitchCompletionWaiters: [CheckedContinuation<Void, Never>] = []
    private var managerStoreSyncCompletionWaiters: [CheckedContinuation<Void, Never>] = []
    private var pendingManagerStoreSyncCommand: ManagerStoreSyncCommand?

    var canSendCode: Bool {
        canRequestCode && !isAuthBusy && email.contains("@") && email.count <= 254
    }

    var canVerifyCode: Bool {
        !isAuthBusy && code.count == 6 && code.allSatisfy(\.isNumber)
    }

    var phoneCameraScanContext: PhoneCameraScanContext? {
        guard let task = currentTask, let stage = currentScanStage else { return nil }
        if stage == .location {
            return PhoneCameraScanContext(
                taskGlobalID: task.pickTaskGlobalId,
                stage: stage,
                expectedBarcode: task.locationBarcode,
                headline: "Scan location label",
                detail: "\(task.locationCode) · \(task.locationBarcode ?? "No location barcode assigned")"
            )
        }
        return PhoneCameraScanContext(
            taskGlobalID: task.pickTaskGlobalId,
            stage: stage,
            expectedBarcode: task.barcode,
            headline: "Scan product barcode",
            detail: "\(task.productName) · SKU \(task.channelSku)"
        )
    }

    var googleSSOAvailable: Bool {
        guard let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              let serverClientID = Bundle.main.object(forInfoDictionaryKey: "GIDServerClientID") as? String
        else { return false }
        return clientID.hasSuffix(".apps.googleusercontent.com")
            && serverClientID.hasSuffix(".apps.googleusercontent.com")
            && !clientID.hasPrefix("google-not-configured")
            && !serverClientID.hasPrefix("google-not-configured")
    }

    var biometricUnlockAvailable: Bool { biometrics.isAvailable }
    var biometricUnlockTitle: String { biometrics.title }

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
        let idle = !isRestoringSession
            && !isRecheckingPendingConfirmation
            && !isConfirmingOrder
            && !isRequestingPickHandoff
            && !isWorkspaceBusy
            && !isManagerBusy
            && !isManagerStoreSyncBusy
            && !isQueueBusy
            && !hasPendingWorkspaceTransition
            && !hasPendingManagerStoreSyncChange
        guard idle else { return false }
        if hasPendingPickHandoff {
            guard let recoveryWorkspaceId = pendingPickHandoffRecoveryWorkspaceId else {
                return false
            }
            return activeWorkspace?.organizationId != recoveryWorkspaceId
        }
        if hasPendingConfirmation {
            guard let recoveryWorkspaceId = pendingConfirmationRecoveryWorkspaceId else {
                return false
            }
            return activeWorkspace?.organizationId != recoveryWorkspaceId
        }
        if hasPendingManagerOrderReplanning {
            guard let recoveryWorkspaceId = managerOrderReplanningRecoveryWorkspaceId else {
                return false
            }
            return activeWorkspace?.organizationId != recoveryWorkspaceId
        }
        return true
    }

    var canRequestActivePickHandoff: Bool {
        isAuthenticated
            && !hasPendingConfirmation
            && !hasPendingPickHandoff
            && !isRequestingPickHandoff
            && !hasPendingWorkspaceTransition
            && !isWorkspaceBusy
            && activePickHandoffEligible
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

    var environmentLabel: String? {
        let value = String(
            Bundle.main.object(forInfoDictionaryKey: "ClawPilotEnvironment") as? String ?? ""
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        return value.lowercased() == "development" ? "DEV" : nil
    }

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
        biometricUnlockEnabled = biometrics.isEnabled
        isLocallyLocked = biometricUnlockEnabled && biometrics.hasRememberedSession
        if isLocallyLocked {
            isRestoringSession = false
            status = "Unlock with \(biometrics.title), or use another sign-in method."
        }
        voice.onVoicePackStateChange = { [weak self] state in
            guard let self else { return }
            let phonePlaybackAvailabilityChanged = (self.voicePackState == .ready)
                != (state == .ready)
            self.voicePackState = state
            if phonePlaybackAvailabilityChanged,
               self.currentTask != nil || self.readyToConfirm {
                Task { await self.updateProjection() }
            }
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
            guard let self else {
                return .failure("ClawPilot is not available on the paired iPhone.")
            }
            return await self.handleWatchCommand(command)
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
        guard !isLocallyLocked else {
            isRestoringSession = false
            return
        }
        isRestoringSession = true
        defer { isRestoringSession = false }
        // A Watch can retain its last application context across a phone-app
        // crash. Clear it before reading any cached queue; only a freshly
        // authenticated profile is allowed to authorize a new projection.
        clearPublishedPickProjection()
        await refreshMetaStatus()
        let restoredProfile: ClawPilotSessionProfile
        do {
            restoredProfile = try await api.fetchSessionProfile()
            installReplacementAuthenticationProfile(restoredProfile)
        } catch {
            sessionProfile = nil
            isAuthenticated = false
            clearManagerStoreSyncState()
            status = "Sign in to continue."
            return
        }
        let transitionRecovery = await recoverWorkspaceTransitionIfNeeded(
            authenticatedProfile: restoredProfile
        )
        guard transitionRecovery != .blocked else { return }
        if transitionRecovery == .none {
            _ = try? await picking.restore()
        }
        await refreshGoogleAuthState()
        syncMetaConnection()
        let resumedPendingHandoff = await resumeDurablePickHandoffIfNeeded()
        let resumedPendingConfirmation = resumedPendingHandoff
            ? true
            : await resumeDurableConfirmationIfNeeded()
        let resumedManagerReplanning = await resumeDurableManagerOrderReplanningIfNeeded()
        if !resumedPendingHandoff
            && !resumedPendingConfirmation
            && !resumedManagerReplanning {
            resetPendingConfirmationBlocker()
            // Only an outbox-free queue reaches presentation here.
            // updateProjection independently checks it against the freshly
            // authenticated profile before publishing to iPhone or Watch.
            await updateProjection()
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
        } catch {
            isAuthenticated = false
            status = "Code could not be verified. Request a new code and try again."
            return
        }
        do {
            let restoredProfile = try await api.fetchSessionProfile()
            installReplacementAuthenticationProfile(restoredProfile)
            isRestoringSession = true
            defer { isRestoringSession = false }
            biometrics.rememberAuthenticatedSession()
            codeRequested = false
            code = ""
            let transitionRecovery = await recoverWorkspaceTransitionIfNeeded(
                authenticatedProfile: restoredProfile
            )
            guard transitionRecovery != .blocked else { return }
            if transitionRecovery == .none {
                _ = try? await picking.restore()
            }
            await refreshGoogleAuthState()
            let resumedPendingHandoff = await resumeDurablePickHandoffIfNeeded()
            let resumedPendingConfirmation = resumedPendingHandoff
                ? true
                : await resumeDurableConfirmationIfNeeded()
            let resumedManagerReplanning = await resumeDurableManagerOrderReplanningIfNeeded()
            if !resumedPendingHandoff
                && !resumedPendingConfirmation
                && !resumedManagerReplanning {
                status = "Signed in. Choose a workflow to begin."
            }
        } catch {
            isAuthenticated = false
            status = "Code accepted, but the secure session could not be restored. Request a new code and try again."
        }
    }

    func signInWithGoogle() async {
        guard googleSSOAvailable else {
            status = "Google sign-in needs the ClawPilot Google OAuth configuration. Magic codes remain available."
            return
        }
        guard let presentingViewController = Self.presentingViewController else {
            status = "Google sign-in could not open. Try again."
            return
        }
        guard let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              let serverClientID = Bundle.main.object(forInfoDictionaryKey: "GIDServerClientID") as? String
        else { return }

        isAuthBusy = true
        defer { isAuthBusy = false }
        do {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(
                clientID: clientID,
                serverClientID: serverClientID
            )
            let result = try await GIDSignIn.sharedInstance.signIn(
                withPresenting: presentingViewController
            )
            guard let idToken = result.user.idToken?.tokenString else {
                status = "Google did not return a verified identity token."
                return
            }
            do {
                try await api.verifyGoogleIdentityToken(idToken)
            } catch PickingAPIError.rejected(let code, _) where code == "GOOGLE_SSO_LINK_REQUIRED" {
                // A locally restored, recently authenticated magic-code session may
                // still be valid even when the shell is showing its signed-out
                // state. In that case the user's Google tap is an explicit link
                // request. Exact email/subject matching, recent authentication,
                // active membership, and idempotency remain authoritative. With no
                // valid session, preserve the first-time link-required response.
                do {
                    let state = try await api.fetchGoogleAuthState()
                    guard state.platformConfigured, state.canLinkCurrentUser else {
                        throw PickingAPIError.rejected(
                            code: "GOOGLE_SSO_NOT_CONFIGURED",
                            message: "Google sign-in is not configured for this ClawPilot environment."
                        )
                    }
                    if !state.identity.linked {
                        _ = try await api.linkGoogleIdentityToken(
                            idToken,
                            idempotencyKey: UUID().uuidString
                        )
                    }
                    try await api.verifyGoogleIdentityToken(idToken)
                } catch PickingAPIError.unauthorized {
                    throw PickingAPIError.rejected(
                        code: "GOOGLE_SSO_LINK_REQUIRED",
                        message: "First sign in with a magic code, then open Settings > Security and link your Google account."
                    )
                }
            }
            let restoredProfile = try await api.fetchSessionProfile()
            installReplacementAuthenticationProfile(restoredProfile)
            isRestoringSession = true
            defer { isRestoringSession = false }
            email = restoredProfile.effectiveUser.email
            isLocallyLocked = false
            biometrics.rememberAuthenticatedSession()
            let transitionRecovery = await recoverWorkspaceTransitionIfNeeded(
                authenticatedProfile: restoredProfile
            )
            guard transitionRecovery != .blocked else { return }
            if transitionRecovery == .none {
                _ = try? await picking.restore()
            }
            await refreshGoogleAuthState()
            let resumedPendingHandoff = await resumeDurablePickHandoffIfNeeded()
            let resumedPendingConfirmation = resumedPendingHandoff
                ? true
                : await resumeDurableConfirmationIfNeeded()
            let resumedManagerReplanning = await resumeDurableManagerOrderReplanningIfNeeded()
            if !resumedPendingHandoff
                && !resumedPendingConfirmation
                && !resumedManagerReplanning {
                status = "Signed in with Google. Choose a workflow to begin."
            }
        } catch PickingAPIError.rejected(let code, _) where code == "GOOGLE_SSO_LINK_REQUIRED" {
            isAuthenticated = false
            status = "Google is not linked yet. Sign in with a magic code, then open Settings > Security and tap Link my Google account."
        } catch {
            isAuthenticated = false
            status = "Google sign-in failed: \(error.localizedDescription)"
        }
    }

    func refreshGoogleAuthState() async {
        guard isAuthenticated, googleSSOAvailable else {
            googleAuthState = nil
            googleLinkStatus = googleSSOAvailable
                ? "Sign in to manage your Google account link."
                : "Google sign-in is not configured for this build. Magic codes remain available."
            return
        }
        do {
            let state = try await api.fetchGoogleAuthState()
            googleAuthState = state
            if state.identity.linked {
                googleLinkStatus = "Google is linked only to \(state.identity.email) across this user's direct organization memberships. Other users must link their own account."
            } else if !state.platformConfigured {
                googleLinkStatus = "Google sign-in is not configured for this ClawPilot environment."
            } else {
                googleLinkStatus = "Link exactly \(state.identity.email) for this user. A different Google account will be rejected."
            }
        } catch {
            googleAuthState = nil
            googleLinkStatus = "Google sign-in settings could not be loaded: \(error.localizedDescription)"
        }
    }

    func linkCurrentGoogleAccount() async {
        guard googleSSOAvailable else {
            googleLinkStatus = "Google sign-in is not configured for this build."
            return
        }
        guard let state = googleAuthState else {
            await refreshGoogleAuthState()
            return
        }
        guard state.platformConfigured, state.canLinkCurrentUser else {
            googleLinkStatus = "Google sign-in is not configured for this ClawPilot environment."
            return
        }
        guard !state.identity.linked else {
            googleLinkStatus = "Google is already linked only to \(state.identity.email) for this user."
            return
        }
        guard let presentingViewController = Self.presentingViewController else {
            googleLinkStatus = "Google account linking could not open. Try again."
            return
        }
        guard let clientID = Bundle.main.object(forInfoDictionaryKey: "GIDClientID") as? String,
              let serverClientID = Bundle.main.object(forInfoDictionaryKey: "GIDServerClientID") as? String
        else { return }

        isGoogleLinkBusy = true
        defer { isGoogleLinkBusy = false }
        do {
            GIDSignIn.sharedInstance.configuration = GIDConfiguration(
                clientID: clientID,
                serverClientID: serverClientID
            )
            GIDSignIn.sharedInstance.signOut()
            let result = try await GIDSignIn.sharedInstance.signIn(
                withPresenting: presentingViewController
            )
            guard let idToken = result.user.idToken?.tokenString else {
                googleLinkStatus = "Google did not return a verified identity token."
                return
            }
            let linked = try await api.linkGoogleIdentityToken(
                idToken,
                idempotencyKey: UUID().uuidString
            )
            await refreshGoogleAuthState()
            googleLinkStatus = "Google is linked only to \(linked.email) across this user's direct organization memberships. Other users must link their own account."
        } catch {
            googleLinkStatus = "Google account was not linked: \(error.localizedDescription)"
        }
    }

    func unlockWithBiometrics() async {
        guard biometricUnlockEnabled, biometricUnlockAvailable else {
            isLocallyLocked = false
            status = "Use a magic code or Google to sign in."
            return
        }
        isAuthBusy = true
        defer { isAuthBusy = false }
        do {
            guard try await biometrics.authenticate() else { return }
            isLocallyLocked = false
            await restoreAndRefresh()
        } catch {
            status = "\(biometricUnlockTitle) did not unlock ClawPilot. Use another sign-in method."
        }
    }

    func setBiometricUnlockEnabled(_ enabled: Bool) async {
        guard enabled else {
            biometrics.setEnabled(false)
            biometricUnlockEnabled = false
            biometricStatus = "Biometric unlock is off."
            return
        }
        guard biometricUnlockAvailable else {
            biometricStatus = "Set up Face ID or Touch ID in iPhone Settings first."
            return
        }
        do {
            guard try await biometrics.authenticate() else { return }
            biometrics.setEnabled(true)
            biometrics.rememberAuthenticatedSession()
            biometricUnlockEnabled = true
            biometricStatus = "\(biometricUnlockTitle) will unlock ClawPilot after a fresh launch."
        } catch {
            biometricStatus = "Biometric unlock was not enabled: \(error.localizedDescription)"
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
        let isPendingHandoffRecoverySwitch = hasPendingPickHandoff
            && organizationId == pendingPickHandoffRecoveryWorkspaceId
        let isPendingConfirmationRecoverySwitch = hasPendingConfirmation
            && organizationId == pendingConfirmationRecoveryWorkspaceId
        let isPendingManagerReplanningRecoverySwitch =
            hasPendingManagerOrderReplanning
            && organizationId == managerOrderReplanningRecoveryWorkspaceId
        let isPendingRecoverySwitch = isPendingHandoffRecoverySwitch
            || isPendingConfirmationRecoverySwitch
            || isPendingManagerReplanningRecoverySwitch
        guard canSwitchWorkspace else {
            workspaceStatus = hasPendingPickHandoff
                ? "Only the organization that owns the saved handoff can be selected until it finishes."
                : (hasPendingConfirmation
                    ? "Only the organization that owns the saved confirmation can be selected until it is resolved."
                    : (hasPendingManagerOrderReplanning
                        ? "Only the organization that owns the saved correction can be selected until it is resolved."
                        : (hasPendingManagerStoreSyncChange
                            ? "Retry or refresh the saved Store sync change before changing organizations."
                            : "Wait for the current operation to finish before changing organizations.")))
            return
        }
        guard (!hasPendingConfirmation
                && !hasPendingPickHandoff
                && !hasPendingManagerOrderReplanning)
                || isPendingRecoverySwitch else {
            workspaceStatus = "The saved command must be resolved in its original organization."
            return
        }
        guard availableWorkspaces.contains(where: { $0.organizationId == organizationId }) else {
            workspaceStatus = "That organization is not available to this account."
            return
        }
        guard let profile = sessionProfile else { return }
        let transition: WorkspaceTransition
        do {
            transition = try WorkspaceTransition(
                sourceOrganizationId: profile.activeWorkspace.organizationId,
                targetOrganizationId: organizationId,
                workerEmail: profile.effectiveUser.email,
                pickerCachePolicy: isPendingRecoverySwitch
                    ? .preserveProtectedCommand
                    : .clearScopedData
            )
        } catch {
            workspaceStatus = "Organization change could not be prepared safely."
            return
        }
        let operationGeneration = authenticationGeneration

        isWorkspaceBusy = true
        workspaceStatus = isPendingRecoverySwitch
            ? "Returning to the organization that owns the saved picker command…"
            : (isPendingManagerReplanningRecoverySwitch
                ? "Returning to the organization that owns the saved order correction…"
                : "Changing organization and clearing scoped mobile data…")
        defer { finishWorkspaceSwitch() }

        do {
            // Persist intent before transport and hide all picker presentation.
            // A relaunch can then reconcile source versus target without ever
            // exposing a queue under the wrong authenticated workspace.
            try await cache.saveWorkspaceTransition(transition)
            hasPendingWorkspaceTransition = true
            clearPublishedPickProjection()
            guard authenticationIsCurrent(operationGeneration) else { return }
            if isMetaScanning {
                await cancelMetaScan()
                guard authenticationIsCurrent(operationGeneration) else { return }
            }
            try await api.switchWorkspace(to: organizationId)
            guard authenticationIsCurrent(operationGeneration) else { return }

            managerOrders = []
            clearManagerStoreSyncState()
            managerPickers = []
            pickerPerformance = []
            managerPickManagement = nil
            managerSelectedPickAssignment = nil
            managerSelectedOrder = nil

            let refreshedProfile = try await api.fetchSessionProfile()
            guard authenticationIsCurrent(operationGeneration) else { return }
            guard refreshedProfile.effectiveUser.email.lowercased()
                    == transition.workerEmail,
                  refreshedProfile.activeWorkspace.organizationId
                    == transition.targetOrganizationId else {
                throw PickingContractError.contextMismatch
            }
            sessionProfile = refreshedProfile
            isAuthenticated = true
            guard await recoverWorkspaceTransitionIfNeeded(
                authenticatedProfile: refreshedProfile
            ) == .resolved else {
                throw PickingContractError.contextMismatch
            }
            guard authenticationIsCurrent(operationGeneration) else { return }
            await refreshGoogleAuthState()
            guard authenticationIsCurrent(operationGeneration) else { return }
            let resumedPendingHandoff = isPendingHandoffRecoverySwitch
                ? await resumeDurablePickHandoffIfNeeded()
                : false
            guard authenticationIsCurrent(operationGeneration) else { return }
            let resumedPendingConfirmation = isPendingConfirmationRecoverySwitch
                && !resumedPendingHandoff
                ? await resumeDurableConfirmationIfNeeded()
                : false
            guard authenticationIsCurrent(operationGeneration) else { return }
            let resumedManagerReplanning = await resumeDurableManagerOrderReplanningIfNeeded()
            guard authenticationIsCurrent(operationGeneration) else { return }

            if canUseManager {
                await loadManagerOperations()
                guard authenticationIsCurrent(operationGeneration) else { return }
            }
            if canUsePicker && !resumedPendingHandoff && !resumedPendingConfirmation {
                await loadQueue(readAloud: false)
                guard authenticationIsCurrent(operationGeneration) else { return }
                await loadPickerPerformance()
                guard authenticationIsCurrent(operationGeneration) else { return }
            }

            let name = sessionProfile?.activeWorkspace.name ?? "the selected organization"
            workspaceStatus = resumedPendingHandoff || resumedPendingConfirmation
                ? "Now using " + name + ". The saved picker command remains protected until its server status is resolved."
                : (resumedManagerReplanning
                    ? "Now using " + name + ". The saved order correction remains protected until it can be resolved."
                    : "Now using " + name + ". Organization-scoped data is refreshed.")
            if !resumedPendingHandoff
                && !resumedPendingConfirmation
                && !resumedManagerReplanning {
                status = "Organization changed to " + name + "."
            }
        } catch PickingAPIError.sessionSuperseded {
            // Logout or a replacement authentication flow owns presentation.
            return
        } catch PickingAPIError.unauthorized {
            guard authenticationIsCurrent(operationGeneration) else { return }
            sessionProfile = nil
            isAuthenticated = false
            clearManagerStoreSyncState()
            workspaceStatus = "Your session expired while changing organizations. Sign in again."
            status = "Sign in to continue."
        } catch {
            guard authenticationIsCurrent(operationGeneration) else { return }
            if let authoritativeProfile = try? await api.fetchSessionProfile(),
               authenticationIsCurrent(operationGeneration) {
                sessionProfile = authoritativeProfile
                _ = await recoverWorkspaceTransitionIfNeeded(
                    authenticatedProfile: authoritativeProfile
                )
            }
            workspaceStatus = hasPendingWorkspaceTransition
                ? "Organization change needs recovery. Relaunch or sign in again; cached picker evidence remains hidden and protected."
                : "Organization change failed: " + error.localizedDescription
        }
    }

    func loadManagerOperations() async {
        if walkthroughScreen != nil {
#if DEBUG
            installManagerPickManagementWalkthroughFixture()
#endif
            return
        }
        guard canUseManager else {
            managerStatus = "Manager access is not assigned to this account."
            return
        }
        let operationGeneration = authenticationGeneration
        guard let operationOrganizationId = sessionProfile?.activeWorkspace.organizationId,
              managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
              ) else { return }
        isManagerBusy = true
        defer {
            if managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) {
                isManagerBusy = false
            }
        }
        var failures: [String] = []
        do {
            let overview = try await api.fetchManagerOperations()
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            managerOrders = overview.orders
            managerStoreSyncControls = overview.storeSync
            canManageStoreSync = overview.capabilities.canActivate
            reconcilePendingManagerStoreSyncChange()
        } catch {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            managerStoreSyncControls = []
            canManageStoreSync = false
            failures.append("orders: \(error.localizedDescription)")
        }
        do {
            let pickers = try await api.fetchManagerPickers()
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            managerPickers = pickers
        } catch {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            failures.append("picker access: \(error.localizedDescription)")
        }
        do {
            let performance = try await api.fetchPickerPerformance()
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            pickerPerformance = performance
        } catch {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            failures.append("performance: \(error.localizedDescription)")
        }
        do {
            let pickManagement = try await api.fetchManagerPickManagement()
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            managerPickManagement = pickManagement
            let eligible = pickManagement.eligiblePickers
            if eligible.isEmpty == false {
                managerPickers = eligible
            }
        } catch {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return }
            managerPickManagement = nil
            failures.append("current assignments/history: \(error.localizedDescription)")
        }
        guard managerStoreSyncOperationIsCurrent(
            generation: operationGeneration,
            organizationId: operationOrganizationId
        ) else { return }
        if failures.isEmpty == false {
            managerStatus = "Some manager data is unavailable (\(failures.joined(separator: "; "))). Available orders remain usable."
        } else if managerPickManagement?.current.isEmpty == false {
            managerStatus = "Review current picker progress or open a planned order."
        } else {
            managerStatus = managerOrders.isEmpty
                ? "No Operations orders are available."
                : "Review an order to wave and assign its picks."
        }
    }

    func updateManagerStoreSync(
        control: ManagerStoreSyncControl,
        desiredState: ManagerStoreSyncDesiredState,
        reason: String
    ) async -> Bool {
        guard canUseManager, canManageStoreSync else {
            managerStoreSyncStatus = "Only an organization owner or authorized administrator may change Store sync."
            return false
        }
        let command: ManagerStoreSyncCommand
        do {
            if let pendingManagerStoreSyncCommand {
                guard pendingManagerStoreSyncCommand.accountGlobalId
                        == control.accountGlobalId,
                      pendingManagerStoreSyncCommand.desiredState
                        == desiredState,
                      pendingManagerStoreSyncCommand.reason
                        == reason.trimmingCharacters(in: .whitespacesAndNewlines)
                else {
                    managerStoreSyncStatus = "Retry or refresh the saved Store sync change before starting another one."
                    return false
                }
                command = pendingManagerStoreSyncCommand
            } else {
                command = try ManagerStoreSyncCommand(
                    control: control,
                    desiredState: desiredState,
                    reason: reason
                )
                pendingManagerStoreSyncCommand = command
                hasPendingManagerStoreSyncChange = true
            }
        } catch {
            managerStoreSyncStatus = error.localizedDescription
            return false
        }
        return await submitManagerStoreSync(command)
    }

    func retryPendingManagerStoreSyncChange() async -> Bool {
        guard let pendingManagerStoreSyncCommand else {
            managerStoreSyncStatus = "There is no saved Store sync change to retry."
            return false
        }
        return await submitManagerStoreSync(pendingManagerStoreSyncCommand)
    }

    private func submitManagerStoreSync(
        _ command: ManagerStoreSyncCommand
    ) async -> Bool {
        guard !isManagerStoreSyncBusy else { return false }
        let operationGeneration = authenticationGeneration
        guard let operationOrganizationId = sessionProfile?.activeWorkspace.organizationId,
              managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
              ) else { return false }
        isManagerStoreSyncBusy = true
        defer {
            finishManagerStoreSyncSubmission(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            )
        }
        do {
            let control = try await api.updateManagerStoreSync(command)
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            if let index = managerStoreSyncControls.firstIndex(where: {
                $0.accountGlobalId == control.accountGlobalId
            }) {
                managerStoreSyncControls[index] = control
            } else {
                managerStoreSyncControls.append(control)
            }
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = control.effectiveReasonLabel
            return true
        } catch PickingAPIError.conflict(let code, let message) {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = "\(message) (\(code))"
            await loadManagerOperations()
            return false
        } catch PickingAPIError.rejected(let code, let message) {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = "The Store sync change was rejected and was not retained: \(message) (\(code)). Review the refreshed control before trying again."
            await loadManagerOperations()
            return false
        } catch PickingAPIError.unauthorized {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = "Your session expired before Store sync could be changed. Sign in and review the current control."
            return false
        } catch PickingAPIError.invalidOrigin {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = "The configured ClawPilot server is invalid. The Store sync change was not sent or retained."
            return false
        } catch PickingAPIError.rateLimited(let seconds) {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            managerStoreSyncStatus = "The exact Store sync change remains saved for retry after \(seconds) seconds."
            return false
        } catch {
            guard managerStoreSyncOperationIsCurrent(
                generation: operationGeneration,
                organizationId: operationOrganizationId
            ) else { return false }
            managerStoreSyncStatus = "The exact Store sync change remains saved for retry: \(error.localizedDescription)"
            return false
        }
    }

    private func reconcilePendingManagerStoreSyncChange() {
        guard let command = pendingManagerStoreSyncCommand else { return }
        guard let control = managerStoreSyncControls.first(where: {
            $0.accountGlobalId == command.accountGlobalId
        }) else { return }
        if control.desiredState == command.desiredState,
           control.explicitChoice,
           control.revision == command.expectedRevision + 1,
           control.reason == command.reason {
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = control.effectiveReasonLabel
        } else if control.revision != command.expectedRevision {
            pendingManagerStoreSyncCommand = nil
            hasPendingManagerStoreSyncChange = false
            managerStoreSyncStatus = "Store sync changed after it was reviewed. Review the refreshed control before trying again."
        }
    }

    private func clearManagerStoreSyncState() {
        managerStoreSyncControls = []
        canManageStoreSync = false
        isManagerStoreSyncBusy = false
        hasPendingManagerStoreSyncChange = false
        managerStoreSyncStatus = nil
        pendingManagerStoreSyncCommand = nil
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

    func reopenManagerOrderForReplanning(reason: String) async -> Bool {
        if walkthroughScreen != nil {
            managerStatus = "Order correction is unavailable in walkthrough data."
            return false
        }
        guard !hasPendingManagerOrderReplanning,
              let order = managerSelectedOrder,
              let profile = sessionProfile,
              canUseManager else {
            managerStatus = hasPendingManagerOrderReplanning
                ? "Resolve the saved order correction before starting another one."
                : "Refresh this order before reopening it."
            return false
        }
        isManagerBusy = true
        defer { isManagerBusy = false }
        do {
            let command = try ManagerOrderReplanningCommand(
                order: order,
                organizationId: profile.activeWorkspace.organizationId,
                workerEmail: profile.effectiveUser.email,
                reason: reason
            )
            try await cache.saveManagerOrderReplanningOutbox(command)
            hasPendingManagerOrderReplanning = true
            managerOrderReplanningRefreshRequired = false
            managerOrderReplanningRecoveryWorkspaceId = nil
            managerOrderReplanningDetail = "The exact correction is saved until ClawPilot acknowledges it."
            let completed = await submitSavedManagerOrderReplanning(command)
            if completed { await loadManagerOperations() }
            return completed
        } catch {
            managerOrderReplanningDetail = error.localizedDescription
            managerStatus = "Order correction was not started: \(error.localizedDescription)"
            return false
        }
    }

    func retryPendingManagerOrderReplanning() async -> Bool {
        guard hasPendingManagerOrderReplanning,
              !isReplayingManagerOrderReplanning else { return false }
        let pendingRemains = await resumeDurableManagerOrderReplanningIfNeeded()
        if !pendingRemains && !managerOrderReplanningRefreshRequired {
            await loadManagerOperations()
            return true
        }
        return false
    }

    func refreshManagerAfterReplanningConflict() async {
        guard managerOrderReplanningRefreshRequired else { return }
        managerOrderReplanningRefreshRequired = false
        managerOrderReplanningDetail = nil
        managerSelectedOrder = nil
        await loadManagerOperations()
    }

    @discardableResult
    private func resumeDurableManagerOrderReplanningIfNeeded() async -> Bool {
        guard !isReplayingManagerOrderReplanning else {
            return hasPendingManagerOrderReplanning
        }
        let command: ManagerOrderReplanningCommand
        do {
            guard let loaded = try await cache.loadManagerOrderReplanningOutbox() else {
                hasPendingManagerOrderReplanning = false
                managerOrderReplanningRecoveryWorkspaceId = nil
                return false
            }
            command = loaded
        } catch {
            hasPendingManagerOrderReplanning = true
            managerOrderReplanningDetail = "The saved order correction could not be read safely."
            managerStatus = "Saved order correction is protected."
            return true
        }

        hasPendingManagerOrderReplanning = true
        guard let profile = sessionProfile else {
            managerOrderReplanningRecoveryWorkspaceId = nil
            managerOrderReplanningDetail = "Sign in with the manager account that created this correction."
            managerStatus = "Saved order correction is protected."
            return true
        }
        guard profile.effectiveUser.email.lowercased() == command.workerEmail else {
            managerOrderReplanningRecoveryWorkspaceId = nil
            managerOrderReplanningDetail = "This correction belongs to \(command.workerEmail) and was not sent under the current session."
            managerStatus = "Saved order correction is protected."
            return true
        }
        guard profile.activeWorkspace.organizationId.lowercased()
                == command.organizationId else {
            managerOrderReplanningRecoveryWorkspaceId = profile.availableWorkspaces.contains {
                $0.organizationId.lowercased() == command.organizationId
            } ? command.organizationId : nil
            managerOrderReplanningDetail = managerOrderReplanningRecoveryWorkspaceId == nil
                ? "This account no longer has access to the organization that owns the saved correction."
                : "Return to the organization that owns this saved correction before retrying it."
            managerStatus = "Saved order correction belongs to a different organization."
            return true
        }
        guard profile.mobileCapabilities.canUseManager else {
            managerOrderReplanningRecoveryWorkspaceId = nil
            managerOrderReplanningDetail = "Manager access is required to recover this saved correction."
            managerStatus = "Saved order correction is protected."
            return true
        }
        managerOrderReplanningRecoveryWorkspaceId = nil
        return !(await submitSavedManagerOrderReplanning(command))
    }

    private func submitSavedManagerOrderReplanning(
        _ command: ManagerOrderReplanningCommand
    ) async -> Bool {
        guard !isReplayingManagerOrderReplanning else { return false }
        isReplayingManagerOrderReplanning = true
        defer { isReplayingManagerOrderReplanning = false }
        do {
            try await cache.requireManagerOrderReplanningReplayIsUnblocked(command)
            let result = try await api.reopenManagerOrderForReplanning(command)
            try await cache.clearManagerOrderReplanningOutbox(command)
            hasPendingManagerOrderReplanning = false
            managerOrderReplanningDetail = nil
            managerOrderReplanningRefreshRequired = false
            managerOrderReplanningRecoveryWorkspaceId = nil
            managerSelectedOrder = nil
            managerStatus = result.replayed
                ? "Saved correction confirmed. Order \(result.orderGlobalId) is ready for a fresh plan."
                : "Order reopened for replanning with no carrier or storefront writes."
            return true
        } catch PickingAPIError.conflict(let code, let message) {
            guard ManagerOrderReplanningConflictDisposition.forServerCode(code)
                    == .quarantineStaleProjection else {
                hasPendingManagerOrderReplanning = true
                managerOrderReplanningDetail = code == "OPERATIONS_COMMAND_IN_PROGRESS"
                    ? "ClawPilot is still processing this exact saved correction. Retry later with the same request and idempotency key."
                    : "ClawPilot could not prove this conflict was a stale projection. The exact correction remains protected for manual retry."
                managerStatus = code == "OPERATIONS_COMMAND_IN_PROGRESS"
                    ? "Order correction is still processing."
                    : "Saved correction remains pending: \(message)"
                return false
            }
            do {
                try await cache.quarantineManagerOrderReplanningOutbox(
                    command,
                    code: code,
                    message: message
                )
                hasPendingManagerOrderReplanning = false
                managerOrderReplanningRefreshRequired = true
                managerOrderReplanningRecoveryWorkspaceId = nil
                managerOrderReplanningDetail = "\(message) Refresh the order before reviewing a new correction."
                managerStatus = "Order changed. Refresh required; the stale correction was quarantined and will not replay."
            } catch {
                hasPendingManagerOrderReplanning = true
                managerOrderReplanningDetail = "ClawPilot rejected the stale correction, but its quarantine could not be completed: \(error.localizedDescription)"
                managerStatus = "Saved correction remains blocked and requires recovery."
            }
            return false
        } catch ManagerOrderReplanningClientError.pickerCommandPending {
            hasPendingManagerOrderReplanning = true
            managerOrderReplanningDetail = "Finish the saved pick confirmation, handoff, or scanned progress for this order, then retry this exact correction."
            managerStatus = "Order correction is blocked by durable picker work."
            return false
        } catch {
            hasPendingManagerOrderReplanning = true
            managerOrderReplanningDetail = "The exact request and idempotency key remain saved for retry."
            managerStatus = "Order correction remains pending: \(error.localizedDescription)"
            return false
        }
    }

    func managePickerAssignment(
        _ assignment: ManagerCurrentPickAssignment,
        assignedTo: String?,
        reason: String,
        idempotencyKey: String
    ) async -> Bool {
        if walkthroughScreen != nil {
#if DEBUG
            managerStatus = assignedTo == nil
                ? "Walkthrough: unassign would create a high-priority manager exception."
                : "Walkthrough: exact ready picks would be assigned to \(assignedTo!)."
            managerSelectedPickAssignment = nil
            return true
#endif
        }
        isManagerBusy = true
        defer { isManagerBusy = false }
        do {
            let command = try ManagerPickAssignmentCommand(
                assignment: assignment,
                assignedTo: assignedTo,
                reason: reason,
                idempotencyKey: idempotencyKey
            )
            let result = try await api.managePickerAssignment(command)
            managerStatus = result.assignedTo.map {
                "Exact ready picks assigned to \($0). Existing exceptions remain open for review."
            } ?? "Exact ready picks unassigned. Manager exception \(result.interventionExceptionGlobalId ?? "retained") keeps the order visible."
            managerSelectedPickAssignment = nil
            await loadManagerOperations()
            return true
        } catch {
            managerStatus = "Picker intervention failed: \(error.localizedDescription)"
            return false
        }
    }

#if DEBUG
    private func installManagerPickManagementWalkthroughFixture() {
        let fingerprint = String(repeating: "a", count: 64)
        let assigned = ManagerCurrentPickAssignment(
            orderGlobalId: "gor0000001",
            orderNumber: "1001",
            rowVersion: 4,
            orderStatus: "released",
            planGlobalId: "gfp0000001",
            waveGlobalId: "gwv0000001",
            warehouseName: "Main warehouse",
            assignmentState: "assigned",
            assignedTo: "picker@example.com",
            assignedDisplayName: "Pat Picker",
            assignedPickers: [ManagerPickAssignmentPerson(
                email: "picker@example.com",
                displayName: "Pat Picker",
                taskCount: 3
            )],
            unassignedTaskCount: 0,
            assignmentFingerprint: fingerprint,
            taskCount: 3,
            readyTaskCount: 3,
            pickedTaskCount: 0,
            requiredUnits: 8,
            pickedUnits: 0,
            scanEvidenceTaskCount: 0,
            countEvidenceTaskCount: 0,
            assignedAt: "2026-08-12T14:15:00Z",
            latestActivityAt: "2026-08-12T14:18:00Z",
            handoffExceptionGlobalId: nil,
            interventionExceptionGlobalId: nil,
            managementBlockedReason: nil
        )
        let unassigned = ManagerCurrentPickAssignment(
            orderGlobalId: "gor0000002",
            orderNumber: "1002",
            rowVersion: 6,
            orderStatus: "released",
            planGlobalId: "gfp0000002",
            waveGlobalId: "gwv0000002",
            warehouseName: "Main warehouse",
            assignmentState: "unassigned",
            assignedTo: nil,
            assignedDisplayName: nil,
            assignedPickers: [],
            unassignedTaskCount: 2,
            assignmentFingerprint: String(repeating: "b", count: 64),
            taskCount: 2,
            readyTaskCount: 2,
            pickedTaskCount: 0,
            requiredUnits: 2,
            pickedUnits: 0,
            scanEvidenceTaskCount: 0,
            countEvidenceTaskCount: 0,
            assignedAt: nil,
            latestActivityAt: "2026-08-12T14:20:00Z",
            handoffExceptionGlobalId: "gex0000002",
            interventionExceptionGlobalId: "gex0000003",
            managementBlockedReason: nil
        )
        let history = ManagerCompletedPickHistory(
            orderGlobalId: "gor0000003",
            orderNumber: "0998",
            orderStatus: "picking",
            planGlobalId: "gfp0000003",
            waveGlobalId: "gwv0000003",
            pickerEmail: "picker@example.com",
            pickerDisplayName: "Pat Picker",
            taskCount: 4,
            unitCount: 12,
            assignedAt: "2026-08-12T12:00:00Z",
            completedAt: "2026-08-12T12:36:00Z"
        )
        let picker = ManagerPicker(email: "picker@example.com", displayName: "Pat Picker")
        managerPickManagement = ManagerPickManagementWorkspace(
            generatedAt: "2026-08-12T14:30:00Z",
            current: [assigned, unassigned],
            history: [history],
            eligiblePickers: [
                picker,
                ManagerPicker(email: "second@example.com", displayName: "Sam Second")
            ]
        )
        managerPickers = managerPickManagement?.eligiblePickers ?? []
        managerOrders = [
            ManagerOrderSummary(
                id: "order-fixture",
                globalId: "gor0000004",
                orderNumber: "1004",
                customerName: "Walkthrough customer",
                status: "planned",
                warehouseName: "Main warehouse",
                lineCount: 2
            )
        ]
        managerStatus = "Walkthrough data · no server write will be sent."
        if walkthroughScreen == "pick-intervention" {
            managerSelectedPickAssignment = assigned
        }
    }
#endif

    private func recoverWorkspaceTransitionIfNeeded(
        authenticatedProfile profile: ClawPilotSessionProfile
    ) async -> WorkspaceTransitionRecoveryOutcome {
        let transition: WorkspaceTransition
        do {
            guard let loaded = try await cache.loadWorkspaceTransition() else {
                hasPendingWorkspaceTransition = false
                return .none
            }
            transition = loaded
        } catch {
            hasPendingWorkspaceTransition = true
            clearPublishedPickProjection()
            workspaceStatus = "Saved organization-change state could not be read safely."
            status = "Picker data remains hidden until organization recovery is verified."
            return .blocked
        }

        hasPendingWorkspaceTransition = true
        let resolution = transition.resolution(
            activeOrganizationId: profile.activeWorkspace.organizationId,
            effectiveWorkerEmail: profile.effectiveUser.email
        )
        guard resolution != .blockedIdentity else {
            clearPublishedPickProjection()
            workspaceStatus = "The saved organization change does not match this signed-in workspace and user."
            status = "Picker data remains hidden. Sign in with the original account to recover it."
            return .blocked
        }

        do {
            switch resolution {
            case .sourceWorkspace:
                _ = try await picking.restore()
            case .targetWorkspaceClearScopedData:
                // A normal switch was admitted only with no protected command.
                // Recheck before destructive cleanup in case another callback
                // raced the journal write; never strand an outbox without queue
                // ownership context.
                guard try await cache.loadOutbox() == nil,
                      try await cache.loadHandoffOutbox() == nil,
                      try await cache.loadManagerOrderReplanningOutbox() == nil else {
                    throw PickingContractError.contextMismatch
                }
                try await picking.clearQueue()
            case .targetWorkspacePreserveProtectedCommand:
                let confirmation = try await cache.loadOutbox()
                let handoff = try await cache.loadHandoffOutbox()
                let managerReplanning = try await cache
                    .loadManagerOrderReplanningOutbox()
                guard confirmation != nil
                        || handoff != nil
                        || managerReplanning != nil else {
                    throw PickingContractError.contextMismatch
                }
                if confirmation != nil || handoff != nil {
                    _ = try await picking.restore()
                    guard await picking.queueIdentityMatches(
                        organizationId: transition.targetOrganizationId,
                        workerEmail: transition.workerEmail
                    ) else {
                        throw PickingContractError.contextMismatch
                    }
                } else if managerReplanning != nil {
                    // A manager correction does not depend on picker cache
                    // state. Clear any queue from the source workspace while
                    // the separate exact correction outbox remains durable.
                    try await picking.clearQueue()
                }
                if let managerReplanning {
                    guard managerReplanning.organizationId
                            == transition.targetOrganizationId,
                          managerReplanning.workerEmail
                            == transition.workerEmail else {
                        throw PickingContractError.contextMismatch
                    }
                }
            case .blockedIdentity:
                throw PickingContractError.contextMismatch
            }

            // Keep both phone and Watch nil while the transition is durable.
            // Retire the exact journal only after scoped cache recovery. A
            // crash before this point replays recovery; a crash after it leaves
            // a safe nil projection that startup can republish after profile
            // authorization.
            try await cache.clearWorkspaceTransition(transition)
            hasPendingWorkspaceTransition = false
            await updateProjection()
            return .resolved
        } catch {
            hasPendingWorkspaceTransition = true
            clearPublishedPickProjection()
            workspaceStatus = "Organization recovery could not safely finish."
            status = "Picker data and saved commands remain protected for retry."
            return .blocked
        }
    }

    func logout() async {
        // Logout wins presentation immediately, but an already-committed
        // workspace switch may have rotated the server session token. Wait for
        // that one authenticated mutation to finish installing its token, then
        // log out that exact session. The stale switch continuation is fenced
        // by this generation and cannot repopulate local UI.
        authenticationGeneration &+= 1
        isAuthBusy = true
        defer { isAuthBusy = false }
        isAuthenticated = false
        sessionProfile = nil
        clearPublishedPickProjection()
        await waitForWorkspaceSwitchToFinish()
        await waitForManagerStoreSyncSubmissionToFinish()
        var serverLogoutError: Error?
        do {
            try await api.logout()
        } catch {
            serverLogoutError = error
        }
        await WebSessionBridge.clearCookies()
        GIDSignIn.sharedInstance.signOut()
        biometrics.forgetAuthenticatedSession()
        isLocallyLocked = false
        codeRequested = false
        code = ""
        currentTask = nil
        currentScanStage = nil
        readyToConfirm = false
        hasPendingConfirmation = false
        hasPendingPickHandoff = false
        pendingPickHandoffDetail = nil
        pendingPickHandoffRecoveryWorkspaceId = nil
        showPickHandoffConfirmation = false
        pickHandoffReason = ""
        resetPendingConfirmationBlocker()
        status = serverLogoutError == nil
            ? "Signed out."
            : "Signed out on this device. The server sign-out response was unavailable."
        isManagerBusy = false
        managerOrders = []
        clearManagerStoreSyncState()
        managerPickers = []
        pickerPerformance = []
        managerPickManagement = nil
        managerSelectedPickAssignment = nil
        managerSelectedOrder = nil
        hasPendingManagerOrderReplanning = false
        isReplayingManagerOrderReplanning = false
        managerOrderReplanningDetail = nil
        managerOrderReplanningRefreshRequired = false
        managerOrderReplanningRecoveryWorkspaceId = nil
        googleAuthState = nil
        isGoogleLinkBusy = false
        googleLinkStatus = "Each user links their own Google account after signing in with a magic code."
    }

    private func authenticationIsCurrent(_ generation: UInt64) -> Bool {
        generation == authenticationGeneration && isAuthenticated
    }

    private func installReplacementAuthenticationProfile(
        _ profile: ClawPilotSessionProfile
    ) {
        authenticationGeneration &+= 1
        clearManagerStoreSyncState()
        sessionProfile = profile
        isAuthenticated = true
    }

    private func managerStoreSyncOperationIsCurrent(
        generation: UInt64,
        organizationId: String
    ) -> Bool {
        ManagerStoreSyncSubmissionFence(
            authenticationGeneration: generation,
            organizationId: organizationId
        ).permitsStateMutation(
            currentAuthenticationGeneration: authenticationGeneration,
            currentOrganizationId: sessionProfile?.activeWorkspace.organizationId,
            isAuthenticated: isAuthenticated
        )
    }

    private func waitForManagerStoreSyncSubmissionToFinish() async {
        guard isManagerStoreSyncBusy else { return }
        await withCheckedContinuation { continuation in
            managerStoreSyncCompletionWaiters.append(continuation)
        }
    }

    private func finishManagerStoreSyncSubmission(
        generation: UInt64,
        organizationId: String
    ) {
        if managerStoreSyncOperationIsCurrent(
            generation: generation,
            organizationId: organizationId
        ) {
            isManagerStoreSyncBusy = false
        }
        let waiters = managerStoreSyncCompletionWaiters
        managerStoreSyncCompletionWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func waitForWorkspaceSwitchToFinish() async {
        guard isWorkspaceBusy else { return }
        await withCheckedContinuation { continuation in
            workspaceSwitchCompletionWaiters.append(continuation)
        }
    }

    private func finishWorkspaceSwitch() {
        isWorkspaceBusy = false
        let waiters = workspaceSwitchCompletionWaiters
        workspaceSwitchCompletionWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private static var presentingViewController: UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        guard let root = scenes
            .flatMap(\.windows)
            .first(where: \.isKeyWindow)?
            .rootViewController else { return nil }
        var presented = root
        while let next = presented.presentedViewController { presented = next }
        return presented
    }

    func loadQueue(readAloud: Bool = true) async {
        guard !hasPendingConfirmation,
              !hasPendingPickHandoff,
              !isRequestingPickHandoff,
              !hasPendingWorkspaceTransition,
              !isRestoringSession else {
            status = "Resolve the saved confirmation, handoff, or organization change before loading new work."
            return
        }
        isQueueBusy = true
        defer { isQueueBusy = false }
        do {
            let queue = try await api.fetchQueue()
            // A refresh may have started just before a durable handoff was
            // persisted. Recheck after transport so its late response cannot
            // replace protected workflow state while the exact POST is active.
            guard !hasPendingConfirmation,
                  !hasPendingPickHandoff,
                  !isRequestingPickHandoff,
                  !hasPendingWorkspaceTransition,
                  !isRestoringSession else {
                status = "Resolve the saved confirmation, handoff, or organization change before loading new work."
                return
            }
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

    @discardableResult
    func accept(
        _ value: String,
        source: BarcodeSource,
        metaScanID: UUID? = nil
    ) async -> PickScanAcceptance? {
        guard !hasPendingConfirmation,
              !hasPendingPickHandoff,
              !isRequestingPickHandoff,
              !hasPendingWorkspaceTransition,
              !isWorkspaceBusy,
              !isRestoringSession else { return nil }
        guard shouldApplyMetaScanResult(metaScanID) else { return nil }
        do {
            let acceptance = try await picking.accept(BarcodeObservation(value: value, source: source))
            guard shouldApplyMetaScanResult(metaScanID) else {
                // The actor may have accepted the observation immediately before
                // the user stopped the camera. Reconcile the projection, but do
                // not speak completion feedback after cancellation. An observation
                // yielded before Stop remains committed warehouse evidence, so the
                // non-voice Meta status must say what actually happened.
                await updateProjection()
                if mostRecentlyCancelledMetaScanID == metaScanID {
                    cancelledMetaAcceptanceStage = acceptance.stage
                    if activeMetaScanID == nil {
                        metaStatus = acceptance.stage == .location
                            ? "Location matched just before the Meta scan stopped. Scan the product next."
                            : "Product matched just before the Meta scan stopped."
                    }
                }
                return nil
            }
            if source == .metaGlasses {
                ClawPilotScanDiagnostic.record("matched:stage=\(acceptance.stage.rawValue)")
            }
            await updateProjection()
            if acceptance.stage == .location {
                status = "Location matched. Confirm when you are ready to scan the product."
                voice.speak(
                    "Location matched. Tap scan product when you are ready.",
                    spanish: "Ubicación correcta. Toca escanear producto cuando estés listo."
                )
                refreshAudioRouteStatus()
            } else if currentWorkflowStage == .count {
                status = "Product matched. Enter the quantity you actually picked."
                showCountEntry = true
                voice.speak(
                    "Product matched. Enter the picked quantity.",
                    spanish: "Producto correcto. Ingresa la cantidad recogida."
                )
                refreshAudioRouteStatus()
            } else if source == .metaGlasses, readyToConfirm {
                status = "Product barcode matched."
                await beginHandsFreeConfirmation()
            } else {
                status = "Product barcode matched."
                readInstruction()
            }
            return acceptance
        } catch PickingContractError.locationBarcodeMismatch {
            guard shouldApplyMetaScanResult(metaScanID) else { return nil }
            status = "Barcode does not match the current assigned location."
            if source == .metaGlasses {
                ClawPilotScanDiagnostic.record("mismatch:stage=location")
            }
            voice.speak(
                "Wrong location. Scan the displayed location label.",
                spanish: "Ubicación incorrecta. Escanea la etiqueta de ubicación mostrada."
            )
            refreshAudioRouteStatus()
        } catch PickingContractError.productBarcodeMismatch,
                PickingContractError.barcodeMismatch {
            guard shouldApplyMetaScanResult(metaScanID) else { return nil }
            status = "Barcode does not match the current assigned product."
            if source == .metaGlasses {
                ClawPilotScanDiagnostic.record("mismatch:stage=product")
            }
            voice.speak(
                "Wrong product. Scan the displayed product.",
                spanish: "Producto incorrecto. Escanea el producto mostrado."
            )
            refreshAudioRouteStatus()
        } catch PickingContractError.staleProgress {
            guard shouldApplyMetaScanResult(metaScanID) else { return nil }
            await updateProjection()
            status = currentWorkflowStage == .location
                ? "That scan step expired. Scan the location again."
                : "That scan step expired. Scan the product again."
            voice.speak(
                currentWorkflowStage == .location
                    ? "Scan step expired. Scan the location again."
                    : "Scan step expired. Scan the product again.",
                spanish: currentWorkflowStage == .location
                    ? "El paso expiró. Escanea la ubicación otra vez."
                    : "El paso expiró. Escanea el producto otra vez."
            )
            refreshAudioRouteStatus()
        } catch {
            guard shouldApplyMetaScanResult(metaScanID) else { return nil }
            status = "Scan rejected: \(error.localizedDescription)"
        }
        return nil
    }

    func acceptPhoneCameraBarcode(_ value: String) async -> PhoneCameraScanOutcome {
        let taskID = currentTask?.pickTaskGlobalId
        let acceptance = await accept(value, source: .iPhoneCamera)
        if acceptance?.stage == .product {
            return .close(feedback: "Product barcode matched.")
        }
        if acceptance?.stage == .location {
            return .close(
                feedback: "Location matched. Continue deliberately when you are ready to scan the product.",
                tone: .success
            )
        }
        if taskID != nil,
           currentTask?.pickTaskGlobalId == taskID,
           let context = phoneCameraScanContext {
            return .continueScanning(context: context, feedback: status, tone: .warning)
        }
        return .close(
            feedback: "The assigned pick changed. Reopen the camera from the current item.",
            tone: .error
        )
    }

    private func shouldApplyMetaScanResult(_ scanID: UUID?) -> Bool {
        guard let scanID else { return true }
        return activeMetaScanID == scanID
    }

    @discardableResult
    func beginProductScanWithMeta(contextToken: String) async -> Bool {
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else { return false }
        guard isMetaScanning || metaScanReady else {
            status = "Keep one camera-ready Meta glasses connection before starting the product scan."
            return false
        }
        do {
            try await picking.beginProductScan(contextToken: contextToken)
            await updateProjection()
            status = "Product scan armed. Look directly at the displayed product barcode."
            if let activeMetaScanID,
               metaProductStartScanID == activeMetaScanID,
               let continuation = metaProductStartContinuation {
                metaProductStartContinuation = nil
                metaProductStartScanID = nil
                continuation.resume(returning: true)
            } else if let activeMetaScanID {
                // A very fast tap can arrive after location acceptance but
                // before the scan loop installs its continuation. Remember
                // that exact scan generation so it can arm in place.
                metaProductStartRequestedScanID = activeMetaScanID
            } else {
                Task { [weak self] in await self?.scanWithMeta() }
            }
            return true
        } catch PickingContractError.staleProgress {
            await updateProjection()
            status = "That location scan expired. Scan the location again before the product."
            return false
        } catch {
            status = "The pick changed before product scanning started. Refresh the current item."
            return false
        }
    }

    func beginProductScanWithPhone(contextToken: String) async {
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else { return }
        if isMetaScanning { await cancelMetaScan() }
        do {
            try await picking.beginProductScan(contextToken: contextToken)
            await updateProjection()
            status = "Product scan armed. Use the iPhone camera on the displayed product."
            showPhoneScanner = true
        } catch PickingContractError.staleProgress {
            await updateProjection()
            status = "That location scan expired. Scan the location again before the product."
        } catch {
            status = "The pick changed before product scanning started. Refresh the current item."
        }
    }

    @discardableResult
    func submitPickedCount(
        _ enteredCount: Int,
        source: PickCountSource = .iPhone,
        contextToken: String? = nil
    ) async -> Bool {
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else { return false }
        guard let context = currentStageContext,
              context.stage == .count,
              contextToken == nil || context.token == contextToken?.lowercased() else {
            status = "The item changed before that count was submitted."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
        do {
            _ = try await picking.verifyCount(
                enteredCount: enteredCount,
                source: source,
                contextToken: context.token
            )
            showCountEntry = false
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            status = "Count verified. The current pick advanced."
            voice.speak(
                "Count verified.",
                spanish: "Cantidad verificada."
            )
            refreshAudioRouteStatus()
            await updateProjection()
            if source == .iPhone { readInstruction() }
            return true
        } catch PickingContractError.countMismatch(let required, let entered) {
            let direction = entered < required ? "under" : "over"
            status = "Count is \(direction). Enter exactly \(required); \(entered) was entered."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            voice.speak(
                "Count is \(direction). Enter \(required).",
                spanish: entered < required
                    ? "La cantidad es menor. Ingresa \(required)."
                    : "La cantidad es mayor. Ingresa \(required)."
            )
            refreshAudioRouteStatus()
            return false
        } catch PickingContractError.staleProgress {
            await updateProjection()
            showCountEntry = false
            status = "That product scan expired. Scan the product again, then enter the count."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            voice.speak(
                "Product scan expired. Scan the product again.",
                spanish: "El escaneo del producto expiró. Escanea el producto otra vez."
            )
            refreshAudioRouteStatus()
            return false
        } catch {
            status = "Enter a positive whole-number count for the current item."
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            return false
        }
    }

    func cancelCountEntry() {
        dismissedCountContextToken = currentStageContext?.token
        showCountEntry = false
        status = "Product remains matched. Reopen Enter picked count to finish this item."
    }

    private func metaDecodeTarget(
        for task: PickTask,
        stage: PickScanStage
    ) -> MetaBarcodeDecodeTarget {
        stage == .location
            ? .location(expectedValue: task.locationBarcode)
            : .product(expectedValue: task.barcode)
    }

    @discardableResult
    func announcePhoneCameraMismatch(_ stage: PickScanStage) -> Bool {
        let english = stage == .location ? "Wrong location." : "Wrong product."
        let spanish = stage == .location ? "Ubicación incorrecta." : "Producto incorrecto."
        if UIAccessibility.isVoiceOverRunning {
            UIAccessibility.post(
                notification: .announcement,
                argument: instructionLanguage == .spanish ? spanish : english
            )
            return true
        }
        if voice.speakIfIdle(english, spanish: spanish) {
            refreshAudioRouteStatus()
            return true
        }
        return false
    }

    @discardableResult
    func scanWithMeta() async -> PickScanAcceptance? {
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else {
            ClawPilotScanDiagnostic.record("blocked:pick-handoff-active")
            return nil
        }
        guard !isMetaScanning else {
            ClawPilotScanDiagnostic.record("request-ignored:scan-already-active")
            return nil
        }
        guard let initialTask = currentTask,
              let initialStage = currentScanStage else {
            metaStatus = "Load an assigned pick before starting the glasses camera."
            ClawPilotScanDiagnostic.record("blocked:no-assigned-pick")
            return nil
        }
        guard metaScanReady else {
            metaStatus = "Waiting for one connected Meta glasses device. Open Meta AI once if it does not reconnect."
            ClawPilotScanDiagnostic.record("blocked:meta-not-ready")
            syncMetaConnection()
            return nil
        }
        let scanID = UUID()
        activeMetaScanID = scanID
        isMetaScanning = true
        defer {
            if metaProductStartRequestedScanID == scanID {
                metaProductStartRequestedScanID = nil
            }
            // A stopped scan may already have been replaced by a new one. Never
            // let the older task clear the newer scan's source or busy state.
            if activeMetaScanID == scanID {
                activeMetaScanID = nil
                metaSource = nil
                isMetaScanning = false
            }
        }

        var startedSource: MetaWearablesBarcodeSource?
        do {
            var startError: Error?
            for attempt in 1...3 {
                guard activeMetaScanID == scanID else { return nil }
                let candidate = MetaWearablesBarcodeSource(
                    target: metaDecodeTarget(for: initialTask, stage: initialStage)
                )
                metaSource = candidate
                metaStatus = "Starting the Meta glasses camera (attempt \(attempt)/3)…"
                ClawPilotScanDiagnostic.record("camera-starting:\(attempt)")
                do {
                    try await candidate.start()
                    guard activeMetaScanID == scanID else {
                        await candidate.stop()
                        return nil
                    }
                    startedSource = candidate
                    break
                } catch {
                    startError = error
                    await candidate.stop()
                    guard activeMetaScanID == scanID else { return nil }
                    metaSource = nil
                    ClawPilotScanDiagnostic.record("camera-start-failed:\(attempt):\(error.localizedDescription)")
                    if error as? MetaScanError == .glassesAppUpdateRequired { break }
                    if attempt < 3 {
                        try? await Task.sleep(for: .seconds(1))
                        guard activeMetaScanID == scanID else { return nil }
                    }
                }
            }
            guard let source = startedSource else {
                throw startError ?? MetaScanError.sessionFailed
            }
            guard activeMetaScanID == scanID else {
                await source.stop()
                return nil
            }
            metaGlassesAppUpdateRequired = false
            metaStatus = currentScanStage == .location
                ? "Meta camera is live. Look directly at the displayed location label; no photo is saved."
                : "Meta camera is live. Look directly at the product barcode; no photo is saved."
            ClawPilotScanDiagnostic.record("camera-live")
            var lastAcceptance: PickScanAcceptance?
            var acceptedLocationValue: String?
            var didTimeOut = false
            scanLoop: for observedIndex in 0..<8 {
                let outcome = await withTaskGroup(of: MetaBarcodeWaitOutcome.self) { group in
                    group.addTask {
                        for await value in source.barcodes {
                            if Task.isCancelled { return .cancelled }
                            return .value(value)
                        }
                        return Task.isCancelled ? .cancelled : .sourceEnded
                    }
                    group.addTask {
                        do {
                            try await Task.sleep(for: .seconds(15))
                            return .timedOut
                        } catch {
                            return .cancelled
                        }
                    }
                    let first = await group.next() ?? .cancelled
                    group.cancelAll()
                    return first
                }
                guard activeMetaScanID == scanID else { return nil }

                let value: String
                switch outcome {
                case .value(let observedValue):
                    value = observedValue
                case .timedOut:
                    didTimeOut = true
                    break scanLoop
                case .sourceEnded:
                    await source.stop()
                    guard activeMetaScanID == scanID else { return nil }
                    metaSource = nil
                    ClawPilotScanDiagnostic.record("source-ended:no-barcode")
                    if lastAcceptance?.stage == .location {
                        metaStatus = "Location matched, but the Meta camera ended before the product barcode was found. Start another scan at the product or use the iPhone camera."
                        return lastAcceptance
                    }
                    metaStatus = "The Meta camera ended before a barcode was found. Start another glasses scan or use the iPhone camera."
                    return nil
                case .cancelled:
                    await source.stop()
                    return nil
                }

                ClawPilotScanDiagnostic.record(
                    "decoded:stage=\(currentScanStage?.rawValue ?? "unknown")"
                )
                if currentScanStage == .product {
                    // End the camera stream before any product-match voice or
                    // confirmation prompt so playback cannot overlap the DAT
                    // session lifecycle.
                    await source.stop()
                    guard activeMetaScanID == scanID else { return nil }
                    metaSource = nil
                    let acceptance = await accept(
                        value,
                        source: .metaGlasses,
                        metaScanID: scanID
                    )
                    guard activeMetaScanID == scanID else { return nil }
                    if acceptance?.stage == .product {
                        metaStatus = "Meta product scan complete."
                        return acceptance
                    }
                    if lastAcceptance?.stage == .location {
                        metaStatus = "Location is verified, but the product did not match. Start another scan at the product."
                        return lastAcceptance
                    }
                    metaStatus = "The product did not match. Start another glasses scan at the displayed product."
                    return nil
                }
                let acceptance = await accept(
                    value,
                    source: .metaGlasses,
                    metaScanID: scanID
                )
                guard activeMetaScanID == scanID else { return nil }
                if let acceptance {
                    lastAcceptance = acceptance
                    acceptedLocationValue = value
                    guard acceptance.stage == .location else { continue }
                    let shouldContinue: Bool
                    if metaProductStartRequestedScanID == scanID,
                       currentWorkflowStage == .product {
                        metaProductStartRequestedScanID = nil
                        shouldContinue = true
                    } else {
                        guard let context = currentStageContext,
                              context.stage == .productReady else { return lastAcceptance }
                        metaStatus = "Location matched. The camera is paused on this step—tap Scan product when ready."
                        shouldContinue = await withCheckedContinuation { continuation in
                            metaProductStartScanID = scanID
                            metaProductStartContinuation = continuation
                        }
                    }
                    metaProductStartScanID = nil
                    metaProductStartContinuation = nil
                    guard shouldContinue, activeMetaScanID == scanID else { return lastAcceptance }
                } else if observedIndex == 7 {
                    break
                }
                guard let task = currentTask,
                      let stage = currentScanStage else { break }
                await source.prepareForNextBarcode(
                    target: metaDecodeTarget(for: task, stage: stage),
                    suppressedValue: acceptedLocationValue
                )
            }
            await source.stop()
            guard activeMetaScanID == scanID else { return nil }
            metaSource = nil
            if lastAcceptance?.stage == .location {
                metaStatus = "Location matched, but no product barcode was found. Start another scan at the product or use the iPhone camera."
                return lastAcceptance
            }
            if didTimeOut {
                metaStatus = "No barcode found. Move closer until the barcode fills at least one-third of your view, then try again or use the iPhone camera."
                ClawPilotScanDiagnostic.record("timeout:no-barcode")
                voice.speak(
                    "No barcode found. Move closer until the barcode fills at least one-third of your view, then try again or use the iPhone camera.",
                    spanish: "No se encontró un código de barras. Acércate hasta que el código ocupe al menos un tercio de tu campo de visión, luego intenta otra vez o usa la cámara del iPhone."
                )
                refreshAudioRouteStatus()
            } else {
                metaStatus = "No matching barcode was found after several scans. Try again or use the iPhone camera."
                ClawPilotScanDiagnostic.record("attempt-limit:no-match")
            }
        } catch {
            if let startedSource { await startedSource.stop() }
            guard activeMetaScanID == scanID else { return nil }
            if error as? MetaScanError == .glassesAppUpdateRequired {
                metaGlassesAppUpdateRequired = true
                metaStatus = "Camera software update required. Tap Update camera software, finish the update in Meta AI, then return to ClawPilot. Do not reset or re-pair the glasses."
            } else {
                metaStatus = "Meta scan unavailable. Use iPhone camera: \(error.localizedDescription)"
            }
            ClawPilotScanDiagnostic.record("error:\(error.localizedDescription)")
            metaSource = nil
        }
        return nil
    }

    func handlePendingSystemScan() async {
        guard PendingMobileAction.hasMetaScanRequest else { return }
        guard !isRestoringSession else { return }
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else {
            ClawPilotScanDiagnostic.record("blocked:pick-handoff-active")
            return
        }
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
        guard activeMetaScanID != nil || isMetaScanning || metaSource != nil else { return }
        guard !isMetaScanStopping else { return }
        isMetaScanStopping = true
        defer { isMetaScanStopping = false }
        let source = metaSource
        let cancelledScanID = activeMetaScanID
        // Invalidate the generation before the actor hop. Stopping the source
        // finishes its AsyncStream, so the waiting scan task can resume while
        // this method is suspended; it must already know that result is stale.
        mostRecentlyCancelledMetaScanID = cancelledScanID
        cancelledMetaAcceptanceStage = nil
        activeMetaScanID = nil
        metaSource = nil
        metaProductStartRequestedScanID = nil
        if let continuation = metaProductStartContinuation {
            metaProductStartContinuation = nil
            metaProductStartScanID = nil
            continuation.resume(returning: false)
        }
        metaStatus = "Stopping Meta scan…"
        ClawPilotScanDiagnostic.record("cancelled:user")
        if let source { await source.stop() }
        // Keep the scan busy until DAT has fully stopped so a quick second tap
        // cannot overlap a new camera start with the old session's teardown.
        isMetaScanning = false
        if mostRecentlyCancelledMetaScanID == cancelledScanID,
           let committedStage = cancelledMetaAcceptanceStage {
            metaStatus = committedStage == .location
                ? "Location matched just before the Meta scan stopped. Scan the product next."
                : "Product matched just before the Meta scan stopped."
        } else {
            metaStatus = "Meta scan stopped."
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
            metaStatus = "Opening Meta AI to update the camera software on the glasses."
            try await MetaWearablesAppBridge.openMetaAppUpdate()
        } catch {
            metaStatus = "Could not open the camera software update: \(error.localizedDescription)"
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
        let previousConnectedDeviceCount = metaConnectedDeviceCount
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
        if previousConnectedDeviceCount != metaConnectedDeviceCount,
           currentTask != nil || readyToConfirm {
            await updateProjection()
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

    func readInstruction(forceSystemVoice: Bool = false) {
        guard let instruction = currentInstructionCopy() else { return }
        voice.speak(
            instruction.english,
            spanish: instruction.spanish,
            forceSystemVoice: forceSystemVoice
        )
        refreshAudioRouteStatus()
    }

    private func currentInstructionCopy() -> (english: String, spanish: String)? {
        if let currentTask {
            return (
                PickVoice.instruction(
                    for: currentTask,
                    locationScanRequired: currentScanStage == .location,
                    languageCode: "en"
                ),
                PickVoice.instruction(
                    for: currentTask,
                    locationScanRequired: currentScanStage == .location,
                    languageCode: "es"
                )
            )
        }
        guard readyToConfirm else { return nil }
        return (
            "All products scanned. Say confirm pick to submit the order.",
            "Todos los productos están escaneados. Di confirmar pedido para enviarlo."
        )
    }

    func listenForPickCommand() async {
        guard !hasPendingPickHandoff, !isRequestingPickHandoff else { return }
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

    private func handleWatchCommand(_ command: WatchPickCommand) async -> PhoneWatchCommandOutcome {
        switch command.action {
        case .requestMetaScan:
            status = "Apple Watch requested a glasses scan."
            if let acceptance = await scanWithMeta() {
                return acceptance.stage == .location
                    ? .success("Location matched. Scan the displayed product next.")
                    : .success("Product matched. The current pick advanced.")
            }
            return .failure(metaStatus)
        case .readInstruction:
            status = "Apple Watch requested the current pick instruction."
            guard let instruction = currentInstructionCopy() else {
                return .failure("No current pick instruction is available.")
            }
            // The Watch snapshot may outlive a Bluetooth disconnect while the
            // phone is locked. Refresh Meta's current session authority before
            // attempting phone playback instead of trusting cached projection.
            await refreshMetaStatus()
            guard metaConnectedDeviceCount == 1 else {
                return .failure("Meta glasses are no longer connected.")
            }
            do {
                let playback = try await voice.speakEnhancedThroughBluetoothAndWait(
                    instruction.english,
                    spanish: instruction.spanish,
                    deadline: command.phonePlaybackStartDeadline
                )
                refreshAudioRouteStatus()
                status = playback.startedWhilePhoneBackgrounded
                    ? "Enhanced instruction started while iPhone was backgrounded through iOS audio output: \(playback.outputName)."
                    : "Enhanced instruction started through iOS audio output: \(playback.outputName)."
                return .phonePlaybackStarted(status, startedAt: playback.startedAt)
            } catch {
                refreshAudioRouteStatus()
                status = "Enhanced iPhone audio was unavailable: \(error.localizedDescription)"
                return .failure(status)
            }
        case .confirmPick:
            guard readyToConfirm else {
                status = "Scan every assigned product before confirming from Apple Watch."
                voice.speak(
                    "Scan every assigned product before confirming.",
                    spanish: "Escanea todos los productos asignados antes de confirmar."
                )
                return .failure("Scan every assigned product before confirming.")
            }
            await confirmOrder()
            return hasPendingConfirmation
                ? .failure(status)
                : .success("Picks confirmed and audited by ClawPilot.")
        case .refreshQueue:
            await loadQueue(readAloud: false)
            if !isAuthenticated {
                return .failure("Open ClawPilot on iPhone and sign in before refreshing.")
            }
            if status.hasPrefix("Pick queue refresh failed") {
                return .failure(status)
            }
            return .success(currentTask == nil
                ? status
                : "Picks refreshed. The current item is ready on Apple Watch.")
        case .beginProductScan:
            guard let token = command.stageContextToken else {
                return .failure("The product scan step expired. Refresh Apple Watch.")
            }
            guard currentStageContext?.stage == .productReady,
                  currentStageContext?.token == token.lowercased() else {
                return .failure("That product scan step is no longer current. Refresh Apple Watch.")
            }
            let started = await beginProductScanWithMeta(contextToken: token)
            return started
                ? .success("Product scan armed on the existing glasses camera.")
                : .failure(status)
        case .submitCount:
            guard let enteredCount = command.enteredCount,
                  let token = command.stageContextToken else {
                return .failure("Enter a whole-number count for the current item.")
            }
            let succeeded = await submitPickedCount(
                enteredCount,
                source: .watch,
                contextToken: token
            )
            return succeeded
                ? .success("Count verified. The current pick advanced.")
                : .failure(status)
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

    func retryEnhancedVoicePack() async {
        await voice.prepareInstalledVoicePack()
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
        guard readyToConfirm,
              !hasPendingConfirmation,
              !isConfirmingOrder,
              !hasPendingWorkspaceTransition,
              !isWorkspaceBusy,
              !isRestoringSession else { return }
        isConfirmingOrder = true
        hasPendingConfirmation = true
        defer { isConfirmingOrder = false }
        do {
            let command = try await picking.persistConfirmation()
            try await syncEvidenceAndConfirm(command)
            try await picking.finishConfirmedOrder(command)
            hasPendingConfirmation = false
            resetPendingConfirmationBlocker()
            status = "ClawPilot confirmed and audited the picks."
            voice.speak("Picks confirmed.", spanish: "Pedido confirmado.")
            refreshAudioRouteStatus()
            await loadPickerPerformance()
            await loadQueue(readAloud: false)
        } catch PickingContractError.staleProgress {
            hasPendingConfirmation = false
            showPhoneScanner = false
            showCountEntry = false
            await updateProjection()
            status = "Saved scan evidence expired before confirmation. Scan this order again."
            voice.speak(
                "Scan evidence expired. Scan the order again.",
                spanish: "La evidencia expiró. Escanea el pedido otra vez."
            )
            refreshAudioRouteStatus()
        } catch {
            let confirmationError = error
            do {
                let pending = try await cache.loadOutbox()
                applyConfirmationFailure(confirmationError, command: pending)
            } catch {
                protectUnreadablePendingConfirmation(error)
            }
        }
    }

    private func syncEvidenceAndConfirm(_ command: ConfirmPicksCommand) async throws {
        if command.scanEvidenceIdempotencyKey != nil {
            status = "Syncing location and product scan evidence with ClawPilot…"
            try await api.recordScanEvidence(command)
            status = "Scan evidence acknowledged. Confirming picks…"
        } else {
            status = "Confirming picks…"
        }
        try await api.confirm(command)
    }

    func presentActivePickHandoff() async {
        guard !hasPendingConfirmation,
              !hasPendingPickHandoff,
              await picking.canRequestActivePickHandoff() else {
            status = "Only a wholly unpicked current order can be handed to a manager."
            return
        }
        showPhoneScanner = false
        showCountEntry = false
        stopListeningForPickCommand()
        if isMetaScanning { await cancelMetaScan() }
        guard await picking.canRequestActivePickHandoff() else {
            status = "This order changed before handoff could be prepared."
            return
        }
        pickHandoffReason = ""
        showPickHandoffConfirmation = true
        status = "Enter a reason for the manager handoff."
    }

    func presentBlockedConfirmationHandoff() {
        guard hasPendingConfirmation,
              pendingConfirmationRequiresManagerAction,
              !hasPendingPickHandoff else { return }
        pickHandoffReason = ""
        showPickHandoffConfirmation = true
    }

    func submitPickHandoff() async {
        let reason = pickHandoffReason.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, !isRequestingPickHandoff else {
            status = "Enter a reason for the manager before requesting handoff."
            return
        }
        isRequestingPickHandoff = true
        defer { isRequestingPickHandoff = false }

        do {
            let blockedConfirmation: ConfirmPicksCommand?
            if hasPendingConfirmation {
                guard pendingConfirmationRequiresManagerAction,
                      let pending = try await cache.loadOutbox() else {
                    throw PickingContractError.contextMismatch
                }
                blockedConfirmation = pending
            } else {
                showPhoneScanner = false
                showCountEntry = false
                stopListeningForPickCommand()
                if isMetaScanning { await cancelMetaScan() }
                guard await picking.canRequestActivePickHandoff() else {
                    throw PickingContractError.contextMismatch
                }
                blockedConfirmation = nil
            }
            let command = try await picking.persistPickHandoff(
                reason: reason,
                blockedConfirmation: blockedConfirmation
            )
            hasPendingPickHandoff = true
            showPickHandoffConfirmation = false
            pickHandoffReason = ""
            try await executePendingPickHandoff(command)
        } catch {
            do {
                if let command = try await cache.loadHandoffOutbox() {
                    hasPendingPickHandoff = true
                    showPickHandoffConfirmation = false
                    pendingPickHandoffDetail = pendingPickHandoffDetail
                        ?? "The exact handoff request is saved. Retry will reuse the same command and idempotency key."
                    status = "Picker handoff remains protected: \(error.localizedDescription)"
                    _ = command
                } else {
                    hasPendingPickHandoff = false
                    status = "Picker handoff was not requested: \(error.localizedDescription)"
                }
            } catch {
                protectUnreadablePendingPickHandoff(error)
            }
        }
    }

    func retryPendingPickHandoff() async {
        guard hasPendingPickHandoff,
              !isRequestingPickHandoff,
              !hasPendingWorkspaceTransition else { return }
        isRequestingPickHandoff = true
        defer { isRequestingPickHandoff = false }
        do {
            guard let command = try await cache.loadHandoffOutbox() else {
                throw PickingContractError.contextMismatch
            }
            guard pickHandoffIdentityMatchesCurrentSession(command) else {
                pendingPickHandoffDetail = "Sign in as \(command.workerEmail) in the organization that owns this saved handoff."
                status = "Saved handoff identity does not match this session."
                return
            }
            try await executePendingPickHandoff(command)
        } catch {
            pendingPickHandoffDetail = pendingPickHandoffDetail
                ?? "The exact handoff remains saved and was not cleared."
            status = "Picker handoff remains pending: \(error.localizedDescription)"
        }
    }

    @discardableResult
    private func resumeDurablePickHandoffIfNeeded() async -> Bool {
        let command: PickHandoffCommand
        do {
            guard let loaded = try await cache.loadHandoffOutbox() else {
                hasPendingPickHandoff = false
                pendingPickHandoffDetail = nil
                pendingPickHandoffRecoveryWorkspaceId = nil
                return false
            }
            command = loaded
        } catch {
            protectUnreadablePendingPickHandoff(error)
            return true
        }
        hasPendingPickHandoff = true
        _ = try? await picking.restore()
        await updateProjection()
        guard let profile = sessionProfile else {
            pendingPickHandoffRecoveryWorkspaceId = nil
            pendingPickHandoffDetail = "Sign in with the picker account that created this saved handoff."
            status = "Saved picker handoff is protected."
            return true
        }
        guard profile.effectiveUser.email.lowercased() == command.workerEmail else {
            pendingPickHandoffRecoveryWorkspaceId = nil
            pendingPickHandoffDetail = "This saved handoff belongs to \(command.workerEmail) and its original organization. It was not sent under the current session."
            status = "Saved picker handoff is protected."
            return true
        }
        guard profile.activeWorkspace.organizationId == command.organizationId else {
            pendingPickHandoffRecoveryWorkspaceId = profile.availableWorkspaces.contains {
                $0.organizationId == command.organizationId
            } ? command.organizationId : nil
            pendingPickHandoffDetail = pendingPickHandoffRecoveryWorkspaceId == nil
                ? "This account no longer has access to the organization that owns the saved handoff. Ask an administrator to restore access."
                : "Return to the organization that owns this saved handoff. Its command and picking evidence remain untouched."
            status = "Saved picker handoff belongs to a different organization."
            return true
        }
        pendingPickHandoffRecoveryWorkspaceId = nil
        guard (try? await picking.pendingPickHandoffContext(for: command)) != nil else {
            pendingPickHandoffDetail = "The exact saved handoff context could not be verified and was not sent."
            status = "Saved picker handoff is protected."
            return true
        }
        // A handoff outbox takes precedence over confirmation recovery. Replaying
        // this exact idempotent command is safe after either a transport failure
        // or a crash after the server committed but before local retirement.
        do {
            try await executePendingPickHandoff(command)
            return hasPendingPickHandoff
        } catch {
            pendingPickHandoffDetail = "The exact handoff request is saved. Tap Retry handoff when ClawPilot is reachable."
            status = "Saved picker handoff remains pending: \(error.localizedDescription)"
        }
        return true
    }

    private func executePendingPickHandoff(
        _ command: PickHandoffCommand
    ) async throws {
        guard pickHandoffIdentityMatchesCurrentSession(command) else {
            throw PickingContractError.contextMismatch
        }
        status = "Requesting audited manager handoff…"
        let result: PickHandoffResult
        do {
            result = try await api.requestPickHandoff(command)
        } catch PickingAPIError.rejected(let code, let message) {
            if try await recoverFromRejectedPickHandoff(
                command,
                code: code,
                message: message
            ) {
                return
            }
            throw PickingAPIError.rejected(code: code, message: message)
        }
        let evidence = try result.evidence(for: command)
        let replacementQueue = try await api.fetchQueue()
        try await picking.retireHandedOffOrder(
            command,
            evidence: evidence,
            replacementQueue: replacementQueue
        )
        hasPendingPickHandoff = false
        hasPendingConfirmation = false
        pendingPickHandoffDetail = nil
        pendingPickHandoffRecoveryWorkspaceId = nil
        resetPendingConfirmationBlocker()
        await updateProjection()
        status = replacementQueue.orders.isEmpty
            ? "Manager handoff recorded. No other assigned picks are ready."
            : "Manager handoff recorded. The next assigned pick is ready."
        await loadPickerPerformance()
        if currentTask != nil { readInstruction() }
    }

    private func recoverFromRejectedPickHandoff(
        _ command: PickHandoffCommand,
        code: String,
        message: String
    ) async throws -> Bool {
        guard Self.isDeterministicPickHandoffRejection(code) else {
            return false
        }
        if command.blockedConfirmationIdempotencyKey != nil {
            // A manager may reconcile Shopify after the phone persisted its
            // handoff but before the POST arrived. Only the existing exact,
            // read-only confirmation proof may resolve that race.
            let recheck = try await api.recheckPendingConfirmation(for: command)
            guard recheck.pendingConfirmation.state == .reconciledExternalFulfillment else {
                guard let durableConfirmation = try await cache.loadOutbox() else {
                    throw PickingContractError.contextMismatch
                }
                try await picking.retireRejectedBlockedPickHandoff(
                    command,
                    confirmation: durableConfirmation
                )
                hasPendingPickHandoff = false
                pendingPickHandoffDetail = nil
                pendingPickHandoffRecoveryWorkspaceId = nil
                applyConfirmationFailure(
                    PickingAPIError.rejected(
                        code: "OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED",
                        message: "Handoff was rejected: \(message)"
                    ),
                    command: durableConfirmation
                )
                return true
            }
            let evidence = try recheck.pendingConfirmation.reconciliationEvidence()
            let durableConfirmation = try await cache.loadOutbox()
            try await picking.retireBlockedHandoffAfterExternalReconciliation(
                command,
                confirmation: durableConfirmation,
                evidence: evidence,
                replacementQueue: recheck.queue
            )
            hasPendingPickHandoff = false
            hasPendingConfirmation = false
            pendingPickHandoffDetail = nil
            pendingPickHandoffRecoveryWorkspaceId = nil
            resetPendingConfirmationBlocker()
            await updateProjection()
            status = recheck.queue.orders.isEmpty
                ? "Manager reconciliation verified. No other assigned picks are ready."
                : "Manager reconciliation verified. The next assigned pick is ready."
            await loadPickerPerformance()
            if currentTask != nil { readInstruction() }
            return true
        }

        // This structured response proves the active handoff did not commit.
        // Replace only with the signed worker's authoritative queue and retire
        // only the exact handoff outbox; confirmation state is never touched.
        let replacementQueue = try await api.fetchQueue()
        try await picking.retireRejectedActivePickHandoff(
            command,
            replacementQueue: replacementQueue
        )
        hasPendingPickHandoff = false
        pendingPickHandoffDetail = nil
        pendingPickHandoffRecoveryWorkspaceId = nil
        await updateProjection()
        status = "Handoff was not completed: \(message) Assigned work was refreshed."
        return true
    }

    private static func isDeterministicPickHandoffRejection(_ code: String) -> Bool {
        [
            "OPERATIONS_ORDER_NOT_FOUND",
            "OPERATIONS_ORDER_VERSION_CONFLICT",
            "OPERATIONS_PICK_HANDOFF_INVALID",
            "OPERATIONS_PICK_HANDOFF_ALREADY_STARTED",
            "OPERATIONS_PICK_HANDOFF_ACTOR_MISMATCH",
            "OPERATIONS_PICK_HANDOFF_CONFIRMATION_INVALID",
            "OPERATIONS_PICK_HANDOFF_TASKS_CHANGED",
            "OPERATIONS_PICK_HANDOFF_EXCEPTION_FAILED",
        ].contains(code)
    }

    private func pickHandoffIdentityMatchesCurrentSession(
        _ command: PickHandoffCommand
    ) -> Bool {
        guard let profile = sessionProfile else { return false }
        return profile.activeWorkspace.organizationId == command.organizationId
            && profile.effectiveUser.email.lowercased() == command.workerEmail
    }

    private func protectUnreadablePendingPickHandoff(_ error: Error) {
        hasPendingPickHandoff = true
        pendingPickHandoffRecoveryWorkspaceId = nil
        pendingPickHandoffDetail = "The saved handoff could not be read safely. New work and organization changes remain blocked."
        status = "Saved handoff storage needs attention: \(error.localizedDescription)"
    }

    @discardableResult
    private func resumeDurableConfirmationIfNeeded() async -> Bool {
        let pending: ConfirmPicksCommand
        do {
            guard let loaded = try await cache.loadOutbox() else {
                hasPendingConfirmation = false
                resetPendingConfirmationBlocker()
                return false
            }
            pending = loaded
        } catch {
            protectUnreadablePendingConfirmation(error)
            return true
        }
        hasPendingConfirmation = true
        _ = try? await picking.restore()
        await updateProjection()
        guard let context = try? await picking.pendingConfirmationContext(
            for: pending
        ), let profile = sessionProfile else {
            pendingConfirmationIdentityMismatch = true
            pendingConfirmationDetail = "The saved confirmation context could not be verified. Sign in with the original picker account and ask a manager to review the order."
            status = "Saved confirmation context is protected and was not replayed."
            return true
        }

        let signedInWorker = profile.effectiveUser.email.lowercased()
        guard signedInWorker == context.workerEmail else {
            pendingConfirmationIdentityMismatch = true
            pendingConfirmationRecoveryWorkspaceId = nil
            pendingConfirmationDetail = "This confirmation belongs to \(context.workerEmail). Sign in as that picker; ClawPilot will not replay it under \(signedInWorker)."
            status = "Different picker account required. The saved command was not sent."
            return true
        }
        guard profile.activeWorkspace.organizationId == context.organizationId else {
            pendingConfirmationIdentityMismatch = false
            pendingConfirmationRecoveryWorkspaceId = profile.availableWorkspaces.contains {
                $0.organizationId == context.organizationId
            } ? context.organizationId : nil
            pendingConfirmationDetail = pendingConfirmationRecoveryWorkspaceId == nil
                ? "The saved confirmation belongs to an organization this account cannot currently access. Ask an administrator to restore access."
                : "Return to the organization where this pick was assigned. The saved command will remain untouched until then."
            status = "Saved confirmation belongs to a different organization and was not sent."
            return true
        }

        pendingConfirmationIdentityMismatch = false
        pendingConfirmationRecoveryWorkspaceId = nil
        status = "Checking the exact prior confirmation with ClawPilot."
        do {
            let recheck = try await api.recheckPendingConfirmation(pending)
            if try await applyPendingConfirmationRecheck(
                recheck,
                command: pending
            ) {
                return true
            }
        } catch {
            // Restoration is read-only. A network failure or unrecognized
            // server state never silently replays a command that may already
            // have received a terminal response. The worker may explicitly
            // retry the exact durable command below only after seeing this UI.
        }
        guard context.containsExactOrder else {
            pendingConfirmationIdentityMismatch = true
            pendingConfirmationDetail = "ClawPilot could not verify the server resolution for this interrupted local retirement. The saved command remains protected for manager review."
            status = "Server resolution could not be verified; no confirmation was sent."
            return true
        }
        resetPendingConfirmationBlocker()
        hasPendingConfirmation = true
        pendingConfirmationDetail = "The saved command was not sent automatically. Retry explicitly to replay its exact bytes and idempotency key."
        status = "Prior confirmation remains pending. Review it, then tap Retry exact confirmation."
        return true
    }

    func retryPendingConfirmation() async {
        guard !isConfirmingOrder, !hasPendingWorkspaceTransition else { return }
        isConfirmingOrder = true
        defer { isConfirmingOrder = false }
        guard !pendingConfirmationRequiresManagerAction else {
            await recheckPendingConfirmationAfterManagerAction()
            return
        }
        let pending: ConfirmPicksCommand
        do {
            guard let loaded = try await cache.loadOutbox() else {
                hasPendingConfirmation = false
                resetPendingConfirmationBlocker()
                return
            }
            pending = loaded
        } catch {
            protectUnreadablePendingConfirmation(error)
            return
        }
        guard let profile = sessionProfile,
              let context = try? await picking.pendingConfirmationContext(for: pending),
              context.allowsExactReplay,
              profile.activeWorkspace.organizationId == context.organizationId,
              profile.effectiveUser.email.lowercased() == context.workerEmail else {
            _ = await resumeDurableConfirmationIfNeeded()
            return
        }
        do {
            try await syncEvidenceAndConfirm(pending)
            try await picking.finishConfirmedOrder(pending)
            hasPendingConfirmation = false
            resetPendingConfirmationBlocker()
            status = "Pending confirmation reconciled."
            await loadQueue()
        } catch {
            applyConfirmationFailure(error, command: pending)
        }
    }

    func recheckPendingConfirmationAfterManagerAction() async {
        guard hasPendingConfirmation, !isRecheckingPendingConfirmation else { return }
        let pending: ConfirmPicksCommand
        do {
            guard let loaded = try await cache.loadOutbox() else {
                hasPendingConfirmation = false
                resetPendingConfirmationBlocker()
                await updateProjection()
                return
            }
            pending = loaded
        } catch {
            protectUnreadablePendingConfirmation(error)
            return
        }
        isRecheckingPendingConfirmation = true
        defer { isRecheckingPendingConfirmation = false }
        status = "Checking whether a manager reconciled this order."
        do {
            let recheck = try await api.recheckPendingConfirmation(pending)
            _ = try await applyPendingConfirmationRecheck(
                recheck,
                command: pending,
                keepUnresolvedBlocked: true
            )
        } catch {
            pendingConfirmationRequiresManagerAction = true
            pendingConfirmationDetail = "ClawPilot could not verify manager reconciliation. The saved confirmation remains protected on this iPhone."
            status = "Manager reconciliation has not been verified: \(error.localizedDescription)"
        }
    }

    @discardableResult
    private func applyPendingConfirmationRecheck(
        _ result: PendingConfirmationRecheckResult,
        command: ConfirmPicksCommand,
        keepUnresolvedBlocked: Bool = false
    ) async throws -> Bool {
        let pending = result.pendingConfirmation
        switch pending.state {
        case .managerActionRequired:
            pendingConfirmationRequiresManagerAction = true
            pendingConfirmationDetail = pending.message
            status = "Manager action required before this pick can continue."
            return true
        case .reconciledExternalFulfillment:
            let evidence = try pending.reconciliationEvidence()
            try await picking.retireExternallyReconciledConfirmation(
                command,
                evidence: evidence,
                replacementQueue: result.queue
            )
            hasPendingConfirmation = false
            resetPendingConfirmationBlocker()
            await updateProjection()
            status = result.queue.orders.isEmpty
                ? "Manager reconciliation verified. No other assigned picks are ready."
                : "Manager reconciliation verified. The next assigned pick is ready."
            await loadPickerPerformance()
            if currentTask != nil { readInstruction() }
            return true
        case .unresolved:
            if keepUnresolvedBlocked {
                pendingConfirmationRequiresManagerAction = true
                pendingConfirmationDetail = pending.message
                status = "Manager reconciliation is not yet verified."
                return true
            }
            return false
        }
    }

    private func applyConfirmationFailure(
        _ error: Error,
        command: ConfirmPicksCommand?,
        restoring: Bool = false
    ) {
        if case PickingAPIError.rejected(let code, let message) = error,
           code == "OPERATIONS_SHOPIFY_EXTERNAL_FULFILLMENT_RECONCILIATION_REQUIRED" {
            hasPendingConfirmation = command != nil
            pendingConfirmationRequiresManagerAction = true
            pendingConfirmationDetail = "\(message) A manager must reconcile the order in Operations; this phone will only recheck the read-only server result."
            status = "Manager action required. Retrying this confirmation cannot resolve the Shopify conflict."
            return
        }
        resetPendingConfirmationBlocker()
        status = command?.scanEvidenceIdempotencyKey == nil
            ? "The exact confirmation remains unresolved: \(error.localizedDescription)"
            : (restoring
                ? "Prior scans remain saved on this iPhone but are not yet acknowledged by ClawPilot. Confirmation stays blocked; retry when online."
                : "Scans are saved on this iPhone but are not yet acknowledged by ClawPilot. Confirmation stays blocked; tap Retry exact confirmation when online.")
    }

    private func resetPendingConfirmationBlocker() {
        pendingConfirmationRequiresManagerAction = false
        pendingConfirmationIdentityMismatch = false
        pendingConfirmationRecoveryWorkspaceId = nil
        pendingConfirmationDetail = nil
    }

    private func protectUnreadablePendingConfirmation(_ error: Error) {
        hasPendingConfirmation = true
        pendingConfirmationIdentityMismatch = true
        pendingConfirmationRecoveryWorkspaceId = nil
        pendingConfirmationDetail = "The saved confirmation could not be read safely. New work and organization changes remain blocked so no picking evidence is lost."
        status = "Saved confirmation storage needs attention: \(error.localizedDescription)"
    }

    private func updateProjection() async {
        guard !hasPendingWorkspaceTransition,
              let profile = sessionProfile,
              await picking.queueIdentityMatches(
                  organizationId: profile.activeWorkspace.organizationId,
                  workerEmail: profile.effectiveUser.email
              ) else {
            clearPublishedPickProjection()
            return
        }
        let projectedTask = await picking.currentTask()
        let projectedScanStage = await picking.currentScanStage()
        let projectedWorkflowStage = await picking.currentWorkflowStage()
        let projectedStageContext = await picking.currentStageContext()
        let activeOrder = await picking.currentOrder()
        let projectedHandoffEligibility = await picking.canRequestActivePickHandoff()
        let watchSnapshot = await picking.makeWatchSnapshot(
            authorizedOrganizationId: profile.activeWorkspace.organizationId,
            authorizedWorkerEmail: profile.effectiveUser.email,
            instructionLanguageCode: instructionLanguage.languageCode,
            // Phone playback is advertised only when the enhanced pack is
            // actually ready and one current Meta session exists. The iPhone
            // revalidates both the session and Bluetooth output on every Watch
            // command; otherwise the Watch speaks locally.
            readInstructionOnPhone: WatchInstructionPhonePlaybackPolicy.isEligible(
                metaConnectedDeviceCount: metaConnectedDeviceCount,
                enhancedVoiceReady: voicePackState == .ready
            )
        )
        // Recheck after the actor awaits so a concurrent workspace transition
        // cannot publish fields gathered from a queue that is no longer owned
        // by the freshly authenticated profile.
        guard !hasPendingWorkspaceTransition,
              profile == sessionProfile,
              await picking.queueIdentityMatches(
                  organizationId: profile.activeWorkspace.organizationId,
                  workerEmail: profile.effectiveUser.email
              ) else {
            clearPublishedPickProjection()
            return
        }
        currentTask = projectedTask
        currentOrderNumber = activeOrder?.orderNumber
        currentScanStage = projectedScanStage
        currentWorkflowStage = projectedWorkflowStage
        currentStageContext = projectedStageContext
        if currentStageContext?.stage == .count {
            showCountEntry = currentStageContext?.token != dismissedCountContextToken
        } else {
            showCountEntry = false
            dismissedCountContextToken = nil
        }
        readyToConfirm = currentTask == nil && activeOrder != nil
        activePickHandoffEligible = projectedHandoffEligibility
        watch.publish(watchSnapshot)
    }

    private func clearPublishedPickProjection() {
        currentTask = nil
        currentOrderNumber = nil
        currentScanStage = nil
        currentWorkflowStage = nil
        currentStageContext = nil
        showCountEntry = false
        dismissedCountContextToken = nil
        readyToConfirm = false
        activePickHandoffEligible = false
        watch.publish(nil)
    }
}
