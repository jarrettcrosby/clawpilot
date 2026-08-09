import SwiftUI
import MediaPlayer
import ClawPilotPickingCore

private enum PickingTheme {
    static let canvas = Color(red: 15 / 255, green: 15 / 255, blue: 19 / 255)
    static let surface = Color(red: 26 / 255, green: 26 / 255, blue: 35 / 255)
    static let raised = Color(red: 35 / 255, green: 35 / 255, blue: 48 / 255)
    static let outline = Color.white.opacity(0.08)
    static let primary = Color(red: 168 / 255, green: 199 / 255, blue: 250 / 255)
    static let primaryText = Color(red: 0 / 255, green: 29 / 255, blue: 54 / 255)
    static let mint = Color(red: 79 / 255, green: 209 / 255, blue: 184 / 255)
    static let text = Color(red: 228 / 255, green: 225 / 255, blue: 236 / 255)
    static let muted = Color(red: 202 / 255, green: 196 / 255, blue: 208 / 255)
    static let danger = Color(red: 255 / 255, green: 180 / 255, blue: 171 / 255)
}

private enum AuthenticationField: Hashable {
    case email
    case code
}

struct PickingDashboardView: View {
    @ObservedObject var model: PickingPhoneModel
    @FocusState private var authenticationField: AuthenticationField?
    @State private var showMetaResetConfirmation = false
    @State private var showVoicePackRemovalConfirmation = false
    @State private var pronunciationWritten = ""
    @State private var pronunciationSpoken = ""

    var body: some View {
        ZStack {
            PickingTheme.canvas.ignoresSafeArea()

            ScrollView {
                LazyVStack(spacing: 18) {
                    header

                    if model.isRestoringSession {
                        sessionCheckCard
                    } else if !model.isAuthenticated {
                        signInCard
                    }

                    pickerGuideCard
                    pickerPerformanceCard
                    assignedPickCard
                    metaCard
                    audioCard
                    statusNotice
                }
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 36)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .tint(PickingTheme.primary)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { authenticationField = nil }
                    .fontWeight(.semibold)
            }
        }
        .onChange(of: model.isAuthenticated) { _, authenticated in
            if authenticated { authenticationField = nil }
        }
        .onChange(of: model.code) { _, code in
            let sanitized = String(code.filter(\.isNumber).prefix(6))
            if sanitized != code { model.code = sanitized }
        }
        .confirmationDialog(
            "Reset Meta connection?",
            isPresented: $showMetaResetConfirmation,
            titleVisibility: .visible
        ) {
            Button("Reset and open Meta AI", role: .destructive) {
                Task { await model.resetMetaConnection() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes ClawPilot’s Meta authorization. It does not unpair your glasses. You will register ClawPilot and grant camera access again.")
        }
        .confirmationDialog(
            "Remove enhanced voice pack?",
            isPresented: $showVoicePackRemovalConfirmation,
            titleVisibility: .visible
        ) {
            Button("Remove voice pack", role: .destructive) {
                Task { await model.removeEnhancedVoicePack() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("ClawPilot will immediately return to Apple speech. You can download the enhanced voice again later.")
        }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image("ClawPilotMark")
                .resizable()
                .scaledToFit()
                .frame(width: 48, height: 48)

            VStack(alignment: .leading, spacing: 2) {
                Text("ClawPilot")
                    .font(.system(size: 22, weight: .bold, design: .rounded))
                    .foregroundStyle(PickingTheme.text)
                Text("Warehouse picking")
                    .font(.subheadline)
                    .foregroundStyle(PickingTheme.muted)
            }

            Spacer()

            Text("DEV")
                .font(.caption2.weight(.bold))
                .tracking(0.8)
                .foregroundStyle(PickingTheme.primary)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(PickingTheme.primary.opacity(0.12), in: Capsule())
        }
        .accessibilityElement(children: .combine)
    }

    private var sessionCheckCard: some View {
        dashboardCard {
            HStack(spacing: 12) {
                ProgressView().tint(PickingTheme.primary)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Restoring your picking session")
                        .font(.headline)
                        .foregroundStyle(PickingTheme.text)
                    Text("Checking cached work and ClawPilot access.")
                        .font(.subheadline)
                        .foregroundStyle(PickingTheme.muted)
                }
                Spacer()
            }
        }
    }

    private var signInCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 16) {
                sectionHeading(
                    icon: "person.crop.circle.badge.checkmark",
                    title: "Sign in",
                    subtitle: model.codeRequested
                        ? "Enter the six-digit code sent to your email."
                        : "Use your ClawPilot worker account."
                )

                VStack(alignment: .leading, spacing: 8) {
                    Text("Email")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(PickingTheme.muted)
                    TextField("worker@company.com", text: $model.email)
                        .textContentType(.emailAddress)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.emailAddress)
                        .submitLabel(.next)
                        .focused($authenticationField, equals: .email)
                        .onSubmit { requestCodeAndFocus() }
                        .inputSurface()
                }

                if model.codeRequested {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Verification code")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(PickingTheme.muted)
                            Spacer()
                            Text("One-time code")
                                .font(.caption2)
                                .foregroundStyle(PickingTheme.muted.opacity(0.8))
                        }
                        TextField("000000", text: $model.code)
                            .textContentType(.oneTimeCode)
                            .keyboardType(.numberPad)
                            .font(.system(size: 26, weight: .semibold, design: .monospaced))
                            .tracking(8)
                            .submitLabel(.done)
                            .focused($authenticationField, equals: .code)
                            .onSubmit { verifyAndDismiss() }
                            .inputSurface()
                    }
                }

                Button {
                    model.codeRequested ? verifyAndDismiss() : requestCodeAndFocus()
                } label: {
                    HStack(spacing: 8) {
                        if model.isAuthBusy { ProgressView().tint(PickingTheme.primaryText) }
                        Text(model.codeRequested ? "Verify and continue" : "Send sign-in code")
                        Image(systemName: model.codeRequested ? "arrow.right" : "paperplane.fill")
                    }
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryDashboardButtonStyle())
                .disabled(model.codeRequested ? !model.canVerifyCode : !model.canSendCode)

                if model.codeRequested {
                    Button("Use a different email") {
                        authenticationField = .email
                        model.codeRequested = false
                        model.code = ""
                    }
                    .font(.subheadline.weight(.semibold))
                    .frame(maxWidth: .infinity)
                }
            }
        }
    }

    private var assignedPickCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    sectionHeading(
                        icon: "shippingbox.fill",
                        title: "Assigned pick",
                        subtitle: model.isAuthenticated ? "ClawPilot-authorized work" : "Available after sign-in"
                    )
                    Spacer(minLength: 8)
                    if model.isAuthenticated {
                        Button {
                            Task { await model.loadQueue(readAloud: false) }
                        } label: {
                            Image(systemName: "arrow.clockwise")
                                .frame(width: 34, height: 34)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(PickingTheme.primary)
                        .background(PickingTheme.primary.opacity(0.1), in: Circle())
                        .disabled(model.isQueueBusy)
                        .accessibilityLabel("Refresh assigned picks")
                    }
                }

                if model.hasPendingConfirmation {
                    statePanel(
                        icon: "exclamationmark.shield.fill",
                        color: PickingTheme.danger,
                        title: "Confirmation needs attention",
                        detail: "New work is blocked until the exact prior command is reconciled."
                    )
                    Button("Retry exact confirmation") {
                        Task { await model.retryPendingConfirmation() }
                    }
                    .buttonStyle(PrimaryDashboardButtonStyle())
                } else if let task = model.currentTask {
                    currentTaskView(task)
                } else if model.readyToConfirm {
                    statePanel(
                        icon: "checkmark.seal.fill",
                        color: PickingTheme.mint,
                        title: "Every product is scanned",
                        detail: "Review once, then submit the audited confirmation to ClawPilot."
                    )
                    HStack(spacing: 10) {
                        Button("Voice confirm") { Task { await model.listenForConfirmation() } }
                            .buttonStyle(SecondaryDashboardButtonStyle())
                        Button("Confirm picks") { Task { await model.confirmOrder() } }
                            .buttonStyle(PrimaryDashboardButtonStyle())
                    }
                } else {
                    statePanel(
                        icon: model.isAuthenticated ? "tray" : "lock.fill",
                        color: model.isAuthenticated ? PickingTheme.muted : PickingTheme.primary,
                        title: model.isAuthenticated ? "You’re caught up" : "Sign in to begin",
                        detail: model.isAuthenticated
                            ? "No ready, released picks are assigned to this worker."
                            : "Assigned warehouse work appears here after authentication."
                    )
                }
            }
        }
    }

    private var pickerGuideCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionHeading(
                    icon: "list.number",
                    title: "How picking works",
                    subtitle: "The iPhone controls the workflow; the glasses supply the camera."
                )
                guideStep(1, "Receive work", "A manager waves an order and assigns it to you.")
                guideStep(2, "Scan the product", "Tap Start Meta scan, then look at the barcode. ClawPilot reads the live glasses camera; it does not take or save a photo.")
                guideStep(3, "Confirm the order", "After every product matches, confirm once to write the audited result to ClawPilot.")
            }
        }
    }

    private var pickerPerformanceCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 13) {
                sectionHeading(
                    icon: "gauge.with.dots.needle.67percent",
                    title: "My picking pace",
                    subtitle: "Assignment-to-confirmation performance"
                )
                if let performance = model.ownPickerPerformance {
                    HStack(spacing: 10) {
                        performanceMetric("Today UPH", value: formattedUPH(performance.uphToday))
                        performanceMetric("7-day UPH", value: formattedUPH(performance.uphSevenDays))
                        performanceMetric("Today units", value: performance.unitsToday.formatted(.number.precision(.fractionLength(0...1))))
                    }
                    Text("UPH uses completed units divided by the time from assignment to audited order confirmation. Idle time while an order is assigned is included.")
                        .font(.caption2)
                        .foregroundStyle(PickingTheme.muted)
                } else {
                    Text("Your UPH will appear after your first assigned order is confirmed.")
                        .font(.subheadline)
                        .foregroundStyle(PickingTheme.muted)
                }
            }
        }
    }

    private func currentTaskView(_ task: PickTask) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text("GO TO")
                    .font(.caption2.weight(.bold))
                    .tracking(1.2)
                    .foregroundStyle(PickingTheme.mint)
                Text(task.locationCode)
                    .font(.system(size: 42, weight: .bold, design: .rounded))
                    .foregroundStyle(PickingTheme.text)
            }

            Divider().overlay(PickingTheme.outline)

            VStack(alignment: .leading, spacing: 5) {
                Text(task.productName)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(PickingTheme.text)
                Text("SKU \(task.channelSku)  ·  Quantity \(task.quantity.formatted())")
                    .font(.subheadline)
                    .foregroundStyle(PickingTheme.muted)
            }

            if model.isMetaScanning {
                Button {
                    Task { await model.cancelMetaScan() }
                } label: {
                    Label("Stop Meta scan", systemImage: "stop.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryDashboardButtonStyle())
            } else {
                Button {
                    Task { await model.scanWithMeta() }
                } label: {
                    Label("Start Meta scan", systemImage: "eyeglasses")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(PrimaryDashboardButtonStyle())
                .disabled(!model.metaScanReady)
            }

            Button {
                if model.isListeningForPickCommand {
                    model.stopListeningForPickCommand()
                } else {
                    Task { await model.listenForPickCommand() }
                }
            } label: {
                Label(
                    model.isListeningForPickCommand ? "Stop voice command" : "Listen for voice command",
                    systemImage: model.isListeningForPickCommand ? "waveform.slash" : "waveform.and.mic"
                )
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryDashboardButtonStyle())

            Text("Hands-free: say “Hey Siri, scan with ClawPilot.” In-app voice control also accepts “Start glasses scan.” ClawPilot analyzes one in-memory glasses photo first, then briefly checks live frames; nothing is saved.")
                .font(.caption)
                .foregroundStyle(PickingTheme.muted)

            Button {
                model.showPhoneScanner = true
            } label: {
                Label("Use iPhone camera instead", systemImage: "iphone.gen3")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(SecondaryDashboardButtonStyle())

            Button {
                model.readInstruction()
            } label: {
                Label("Read instruction aloud", systemImage: "speaker.wave.2.fill")
            }
            .font(.subheadline.weight(.semibold))
        }
    }

    private var metaCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    ZStack {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(model.metaScanReady ? PickingTheme.mint.opacity(0.12) : PickingTheme.raised)
                            .frame(width: 44, height: 44)
                        Image(systemName: "eyeglasses")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(model.metaScanReady ? PickingTheme.mint : PickingTheme.muted)
                    }

                    VStack(alignment: .leading, spacing: 3) {
                        Text("Meta glasses")
                            .font(.headline)
                            .foregroundStyle(PickingTheme.text)
                        Text(model.metaScanReady
                            ? "Connected · Camera ready"
                            : model.metaCameraGranted ? "Registered · Reconnecting" : "Setup required")
                            .font(.subheadline)
                            .foregroundStyle(model.metaScanReady ? PickingTheme.mint : PickingTheme.muted)
                    }

                    Spacer()

                    if model.isMetaSyncing {
                        ProgressView().tint(PickingTheme.primary)
                    } else {
                        Circle()
                            .fill(model.metaScanReady ? PickingTheme.mint : PickingTheme.muted.opacity(0.4))
                            .frame(width: 9, height: 9)
                            .shadow(color: model.metaScanReady ? PickingTheme.mint.opacity(0.6) : .clear, radius: 5)
                    }
                }

                Text(model.metaStatus)
                    .font(.caption)
                    .foregroundStyle(PickingTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)

                if model.canRegisterMeta {
                    Button("Register with Meta") { Task { await model.registerMeta() } }
                        .buttonStyle(PrimaryDashboardButtonStyle())
                } else if model.canRequestMetaCamera {
                    Button("Allow camera access") { Task { await model.requestMetaCamera() } }
                        .buttonStyle(PrimaryDashboardButtonStyle())
                } else if model.metaCameraGranted && !model.metaScanReady {
                    Button("Reconnect glasses") { model.syncMetaConnection() }
                        .buttonStyle(SecondaryDashboardButtonStyle())
                }

                if model.canManageMetaConnection {
                    HStack(spacing: 10) {
                        Button("Glasses update") {
                            Task { await model.checkMetaFirmwareUpdate() }
                        }
                        .buttonStyle(SecondaryDashboardButtonStyle())

                        Button("Meta AI update") {
                            Task { await model.checkMetaAppUpdate() }
                        }
                        .buttonStyle(SecondaryDashboardButtonStyle())
                    }

                    Button(role: .destructive) {
                        showMetaResetConfirmation = true
                    } label: {
                        Label("Reset Meta connection", systemImage: "arrow.counterclockwise")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(SecondaryDashboardButtonStyle())
                }

                Text("To scan: say “Hey Siri, scan with ClawPilot,” or tap Start Meta scan. Look steadily at one item barcode. ClawPilot checks a high-resolution photo first and live frames second; use the iPhone camera only as a fallback.")
                    .font(.caption2)
                    .foregroundStyle(PickingTheme.muted)
            }
        }
    }

    private var audioCard: some View {
        dashboardCard {
            VStack(alignment: .leading, spacing: 14) {
                sectionHeading(
                    icon: "speaker.wave.2.fill",
                    title: "Audio playback",
                    subtitle: model.playbackPreferenceTitle
                )

                Text(model.audioRouteStatus)
                    .font(.subheadline)
                    .foregroundStyle(PickingTheme.text)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Automatic uses connected Bluetooth audio, including Meta glasses, and otherwise uses the iPhone loudspeaker. iOS controls the final accessory route.")
                    .font(.caption)
                    .foregroundStyle(PickingTheme.muted)

                VStack(alignment: .leading, spacing: 10) {
                    Text("INSTRUCTION LANGUAGE")
                        .font(.caption2.weight(.bold))
                        .tracking(0.6)
                        .foregroundStyle(PickingTheme.muted)

                    Picker(
                        "Instruction language",
                        selection: Binding(
                            get: { model.instructionLanguage },
                            set: { model.selectInstructionLanguage($0) }
                        )
                    ) {
                        ForEach(InstructionVoiceLanguage.allCases) { language in
                            Text(language.title).tag(language)
                        }
                    }
                    .pickerStyle(.segmented)

                    Text(model.voicePackState.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(PickingTheme.text)

                    Text(model.voicePackState.detail)
                        .font(.caption)
                        .foregroundStyle(PickingTheme.muted)
                        .fixedSize(horizontal: false, vertical: true)

                    if let progress = model.voicePackState.progress {
                        ProgressView(value: progress)
                            .tint(PickingTheme.primary)
                    }

                    if model.voicePackState.canInstall {
                        Button {
                            Task { await model.installEnhancedVoicePack() }
                        } label: {
                            Label("Install enhanced voice pack", systemImage: "arrow.down.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(PrimaryDashboardButtonStyle())
                    } else if model.voicePackState == .ready {
                        Button(role: .destructive) {
                            showVoicePackRemovalConfirmation = true
                        } label: {
                            Label("Remove enhanced voice pack", systemImage: "trash")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(SecondaryDashboardButtonStyle())
                    }

                    Divider().overlay(PickingTheme.outline)
                    pronunciationDictionary
                }
                .padding(12)
                .background(PickingTheme.raised, in: RoundedRectangle(cornerRadius: 14))

                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Choose current output")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(PickingTheme.text)
                        Text("Opens the iOS audio-route picker.")
                            .font(.caption)
                            .foregroundStyle(PickingTheme.muted)
                    }
                    Spacer()
                    SystemAudioRoutePicker()
                        .frame(width: 44, height: 44)
                        .accessibilityLabel("Choose audio output")
                }
                .padding(12)
                .background(PickingTheme.raised, in: RoundedRectangle(cornerRadius: 14))

                Button {
                    model.previewVoice()
                } label: {
                    Label("Preview instruction voice", systemImage: "waveform")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryDashboardButtonStyle())

                Button {
                    model.openAppSettings()
                } label: {
                    Label("Open ClawPilot App Settings", systemImage: "gearshape.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryDashboardButtonStyle())
            }
        }
    }

    private var pronunciationDictionary: some View {
        DisclosureGroup {
            VStack(alignment: .leading, spacing: 10) {
                Text("Add a term exactly as it appears, then enter how it should sound. Corrections stay on this iPhone and apply to all instruction voices.")
                    .font(.caption)
                    .foregroundStyle(PickingTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)

                TextField("Written term, e.g. ClawPilot", text: $pronunciationWritten)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(11)
                    .background(PickingTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(PickingTheme.text)

                TextField("Speak as, e.g. Claw Pilot", text: $pronunciationSpoken)
                    .padding(11)
                    .background(PickingTheme.surface, in: RoundedRectangle(cornerRadius: 10))
                    .foregroundStyle(PickingTheme.text)

                Button {
                    if model.addPronunciationCorrection(
                        written: pronunciationWritten,
                        spoken: pronunciationSpoken
                    ) {
                        pronunciationWritten = ""
                        pronunciationSpoken = ""
                    }
                } label: {
                    Label("Save and preview", systemImage: "waveform.badge.plus")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(SecondaryDashboardButtonStyle())
                .disabled(
                    pronunciationWritten.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || pronunciationSpoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )

                ForEach(model.pronunciationCorrections) { correction in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(correction.written)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(PickingTheme.text)
                            Text("Sounds like \(correction.spoken)")
                                .font(.caption)
                                .foregroundStyle(PickingTheme.muted)
                        }
                        Spacer()
                        Button {
                            model.previewPronunciation(correction)
                        } label: {
                            Image(systemName: "speaker.wave.2")
                        }
                        .accessibilityLabel("Preview \(correction.written)")
                        Button(role: .destructive) {
                            model.removePronunciationCorrection(id: correction.id)
                        } label: {
                            Image(systemName: "trash")
                                .foregroundStyle(PickingTheme.danger)
                        }
                        .accessibilityLabel("Remove \(correction.written) pronunciation")
                    }
                    .padding(.vertical, 4)
                }
            }
            .padding(.top, 8)
        } label: {
            Label("Pronunciation corrections", systemImage: "text.bubble")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(PickingTheme.text)
        }
    }

    private func guideStep(_ number: Int, _ title: String, _ detail: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text("\(number)")
                .font(.caption.weight(.bold))
                .foregroundStyle(PickingTheme.primaryText)
                .frame(width: 24, height: 24)
                .background(PickingTheme.primary, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PickingTheme.text)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(PickingTheme.muted)
            }
        }
    }

    private func performanceMetric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title.uppercased())
                .font(.system(size: 8, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(PickingTheme.muted)
            Text(value)
                .font(.headline)
                .foregroundStyle(PickingTheme.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(PickingTheme.raised, in: RoundedRectangle(cornerRadius: 12))
    }

    private func formattedUPH(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.number.precision(.fractionLength(1)))
    }

    private var statusNotice: some View {
        let presentation = statusPresentation
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: presentation.icon)
                .foregroundStyle(presentation.color)
                .padding(.top, 1)
            Text(model.status)
                .font(.footnote)
                .foregroundStyle(PickingTheme.muted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    private var statusPresentation: (icon: String, color: Color) {
        let value = model.status.lowercased()
        if value.contains("failed") || value.contains("wrong") || value.contains("rejected") {
            return ("exclamationmark.triangle.fill", PickingTheme.danger)
        }
        if value.contains("confirmed") || value.contains("cached") || value.contains("no released") {
            return ("checkmark.circle.fill", PickingTheme.mint)
        }
        return ("info.circle.fill", PickingTheme.primary)
    }

    private func sectionHeading(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 11) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(PickingTheme.primary)
                .frame(width: 34, height: 34)
                .background(PickingTheme.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(PickingTheme.text)
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(PickingTheme.muted)
            }
        }
    }

    private func statePanel(icon: String, color: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 22, weight: .medium))
                .foregroundStyle(color)
                .frame(width: 34)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(PickingTheme.text)
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(PickingTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .background(PickingTheme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func dashboardCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(PickingTheme.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .stroke(PickingTheme.outline, lineWidth: 1)
            }
    }

    private func requestCodeAndFocus() {
        guard model.canSendCode else { return }
        Task {
            await model.requestCode()
            if model.codeRequested { authenticationField = .code }
        }
    }

    private func verifyAndDismiss() {
        guard model.canVerifyCode else { return }
        authenticationField = nil
        Task { await model.verifyCode() }
    }
}

private struct SystemAudioRoutePicker: UIViewRepresentable {
    func makeUIView(context: Context) -> MPVolumeView {
        let view = MPVolumeView(frame: .zero)
        view.showsVolumeSlider = false
        view.tintColor = UIColor(
            red: 168 / 255,
            green: 199 / 255,
            blue: 250 / 255,
            alpha: 1
        )
        return view
    }

    func updateUIView(_ uiView: MPVolumeView, context: Context) {}
}

private extension View {
    func inputSurface() -> some View {
        self
            .padding(.horizontal, 14)
            .frame(minHeight: 52)
            .background(PickingTheme.raised, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(PickingTheme.outline, lineWidth: 1)
            }
            .foregroundStyle(PickingTheme.text)
    }
}

private struct PrimaryDashboardButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(PickingTheme.primaryText)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(
                PickingTheme.primary.opacity(configuration.isPressed ? 0.78 : 1),
                in: Capsule()
            )
            .opacity(isEnabled ? (configuration.isPressed ? 0.92 : 1) : 0.45)
    }
}

private struct SecondaryDashboardButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(PickingTheme.primary)
            .padding(.horizontal, 14)
            .frame(minHeight: 50)
            .background(
                PickingTheme.primary.opacity(configuration.isPressed ? 0.16 : 0.09),
                in: Capsule()
            )
            .overlay {
                Capsule().stroke(PickingTheme.primary.opacity(0.25), lineWidth: 1)
            }
            .opacity(isEnabled ? 1 : 0.45)
    }
}
