import SwiftUI
import WebKit
import ClawPilotPickingApple
import GoogleSignInSwift

private enum AppShellTheme {
    static let canvas = Color(red: 15 / 255, green: 15 / 255, blue: 19 / 255)
    static let surface = Color(red: 26 / 255, green: 26 / 255, blue: 35 / 255)
    static let raised = Color(red: 35 / 255, green: 35 / 255, blue: 48 / 255)
    static let outline = Color.white.opacity(0.08)
    static let primary = Color(red: 168 / 255, green: 199 / 255, blue: 250 / 255)
    static let primaryText = Color(red: 0 / 255, green: 29 / 255, blue: 54 / 255)
    static let mint = Color(red: 79 / 255, green: 209 / 255, blue: 184 / 255)
    static let text = Color(red: 228 / 255, green: 225 / 255, blue: 236 / 255)
    static let muted = Color(red: 202 / 255, green: 196 / 255, blue: 208 / 255)
}

private enum AppWorkflow: Hashable {
    case picker
    case manager
}

private enum LoginField: Hashable {
    case email
    case code
}

struct ClawPilotAppShellView: View {
    @ObservedObject var model: PickingPhoneModel

    var body: some View {
        Group {
            if let walkthrough = model.walkthroughScreen {
                walkthroughView(walkthrough)
            } else if model.isRestoringSession {
                launchView
            } else if !model.isAuthenticated {
                LoginGateView(model: model)
            } else {
                authenticatedApp
            }
        }
        .background(AppShellTheme.canvas.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .tint(AppShellTheme.primary)
    }

    @ViewBuilder
    private func walkthroughView(_ screen: String) -> some View {
        switch screen {
        case "login":
            LoginGateView(model: model)
        case "manager":
            NavigationStack { ManagerModuleView(model: model) }
        case "picker":
            NavigationStack { PickingDashboardView(model: model) }
        case "orders":
            NavigationStack { ManagerPickingOperationsView(model: model) }
        case "assignment":
            if let order = model.managerSelectedOrder {
                ManagerOrderAssignmentView(model: model, order: order)
            }
        default:
            authenticatedApp
        }
    }

    private var launchView: some View {
        VStack(spacing: 18) {
            Image("ClawPilotMark")
                .resizable()
                .scaledToFit()
                .frame(width: 86, height: 86)
            Text("ClawPilot")
                .font(.system(size: 32, weight: .bold, design: .rounded))
                .foregroundStyle(AppShellTheme.text)
            ProgressView()
                .tint(AppShellTheme.primary)
            Text("Restoring your secure session")
                .font(.subheadline)
                .foregroundStyle(AppShellTheme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var authenticatedApp: some View {
        NavigationStack {
            ModuleHomeView(model: model)
                .navigationDestination(for: AppWorkflow.self) { workflow in
                    switch workflow {
                    case .picker:
                        PickingDashboardView(model: model)
                            .navigationTitle("Picker")
                            .navigationBarTitleDisplayMode(.inline)
                            .task { await model.preparePickerWorkflow() }
                    case .manager:
                        ManagerModuleView(model: model)
                    }
                }
        }
        .id(model.sessionProfile?.user)
    }
}

private struct LoginGateView: View {
    @ObservedObject var model: PickingPhoneModel
    @FocusState private var field: LoginField?

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                Spacer(minLength: 32)
                brand
                loginCard
                Text("Secure access to your assigned ClawPilot workspace")
                    .font(.footnote)
                    .foregroundStyle(AppShellTheme.muted)
                    .multilineTextAlignment(.center)
                Spacer(minLength: 24)
            }
            .padding(.horizontal, 22)
        }
        .scrollDismissesKeyboard(.interactively)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { field = nil }
                    .fontWeight(.semibold)
            }
        }
        .onChange(of: model.code) { _, code in
            let sanitized = String(code.filter(\.isNumber).prefix(6))
            if sanitized != code { model.code = sanitized }
        }
    }

    private var brand: some View {
        VStack(spacing: 12) {
            Image("ClawPilotMark")
                .resizable()
                .scaledToFit()
                .frame(width: 76, height: 76)
            Text("Welcome to ClawPilot")
                .font(.system(size: 29, weight: .bold, design: .rounded))
                .foregroundStyle(AppShellTheme.text)
            Text("Sign in before choosing your workflow.")
                .font(.subheadline)
                .foregroundStyle(AppShellTheme.muted)
        }
    }

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 17) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.codeRequested ? "Check your email" : "Sign in")
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text(model.codeRequested
                        ? "Enter the six-digit code we sent you."
                        : "Use the same account as the ClawPilot web app.")
                        .font(.subheadline)
                        .foregroundStyle(AppShellTheme.muted)
                }
                Spacer()
                if let environmentLabel = model.environmentLabel {
                    Text(environmentLabel)
                        .font(.caption2.weight(.bold))
                        .tracking(0.8)
                        .foregroundStyle(AppShellTheme.primary)
                        .padding(.horizontal, 9)
                        .padding(.vertical, 5)
                        .background(AppShellTheme.primary.opacity(0.12), in: Capsule())
                }
            }

            if model.isLocallyLocked {
                Button {
                    Task { await model.unlockWithBiometrics() }
                } label: {
                    Label("Unlock with \(model.biometricUnlockTitle)", systemImage: "faceid")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ShellPrimaryButtonStyle())
                .disabled(model.isAuthBusy)

                HStack {
                    Rectangle().fill(AppShellTheme.outline).frame(height: 1)
                    Text("OR SIGN IN AGAIN")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppShellTheme.muted)
                    Rectangle().fill(AppShellTheme.outline).frame(height: 1)
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                Text("Email")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(AppShellTheme.muted)
                TextField("worker@company.com", text: $model.email)
                    .textContentType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.emailAddress)
                    .submitLabel(.next)
                    .focused($field, equals: .email)
                    .onSubmit { requestCode() }
                    .shellInputSurface()
                    .disabled(model.codeRequested)
            }

            if model.codeRequested {
                VStack(alignment: .leading, spacing: 7) {
                    Text("Verification code")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppShellTheme.muted)
                    TextField("000000", text: $model.code)
                        .textContentType(.oneTimeCode)
                        .keyboardType(.numberPad)
                        .font(.system(size: 26, weight: .semibold, design: .monospaced))
                        .tracking(8)
                        .focused($field, equals: .code)
                        .shellInputSurface()
                }
            }

            Button {
                model.codeRequested ? verify() : requestCode()
            } label: {
                HStack(spacing: 9) {
                    if model.isAuthBusy { ProgressView().tint(AppShellTheme.primaryText) }
                    Text(model.codeRequested ? "Verify and continue" : "Send sign-in code")
                    Image(systemName: model.codeRequested ? "arrow.right" : "paperplane.fill")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(ShellPrimaryButtonStyle())
            .disabled(model.codeRequested ? !model.canVerifyCode : !model.canSendCode)

            if model.googleSSOAvailable && !model.codeRequested {
                HStack {
                    Rectangle().fill(AppShellTheme.outline).frame(height: 1)
                    Text("OR")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(AppShellTheme.muted)
                    Rectangle().fill(AppShellTheme.outline).frame(height: 1)
                }

                GoogleSignInButton {
                    field = nil
                    Task { await model.signInWithGoogle() }
                }
                .frame(minHeight: 50)
                .disabled(model.isAuthBusy)
            }

            if model.codeRequested {
                Button("Use a different email") {
                    model.codeRequested = false
                    model.code = ""
                    field = .email
                }
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity)
            }

            if !model.status.isEmpty {
                Label(model.status, systemImage: "info.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(AppShellTheme.muted)
            }
        }
        .padding(20)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(AppShellTheme.outline, lineWidth: 1)
        }
    }

    private func requestCode() {
        guard model.canSendCode else { return }
        Task {
            await model.requestCode()
            if model.codeRequested { field = .code }
        }
    }

    private func verify() {
        guard model.canVerifyCode else { return }
        field = nil
        Task { await model.verifyCode() }
    }
}

private struct ModuleHomeView: View {
    @ObservedObject var model: PickingPhoneModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                profileHeader
                WorkspaceSwitcherCard(model: model)
                sessionSecurityCard
                VStack(alignment: .leading, spacing: 5) {
                    Text("Choose a workflow")
                        .font(.title2.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text("Your permissions determine which workflows are available.")
                        .font(.subheadline)
                        .foregroundStyle(AppShellTheme.muted)
                }

                if model.canUsePicker {
                    NavigationLink(value: AppWorkflow.picker) {
                        workflowCard(
                            icon: "barcode.viewfinder",
                            color: AppShellTheme.mint,
                            title: "Picker",
                            subtitle: "Assigned picks, Meta glasses, voice and Watch",
                            badge: "WAREHOUSE"
                        )
                    }
                    .buttonStyle(.plain)
                }

                if model.canUseManager {
                    NavigationLink(value: AppWorkflow.manager) {
                        workflowCard(
                            icon: "square.grid.2x2.fill",
                            color: AppShellTheme.primary,
                            title: "Manager",
                            subtitle: "Dashboard, operations and business modules",
                            badge: "WORKSPACE"
                        )
                    }
                    .buttonStyle(.plain)
                }

                if !model.canUsePicker && !model.canUseManager {
                    Label(
                        "No mobile workflow is assigned to this account. Ask an administrator to review your workspace permissions.",
                        systemImage: "lock.shield.fill"
                    )
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
                    .padding(18)
                    .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
                }
            }
            .padding(20)
            .padding(.bottom, 30)
        }
        .background(AppShellTheme.canvas)
        .navigationTitle("ClawPilot")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("Sign out", role: .destructive) {
                        Task { await model.logout() }
                    }
                } label: {
                    Image(systemName: "person.crop.circle")
                }
            }
        }
    }

    private var profileHeader: some View {
        HStack(spacing: 13) {
            Image("ClawPilotMark")
                .resizable()
                .scaledToFit()
                .frame(width: 54, height: 54)
            VStack(alignment: .leading, spacing: 3) {
                Text("Welcome, \(model.sessionDisplayName)")
                    .font(.headline)
                    .foregroundStyle(AppShellTheme.text)
                Text(model.sessionOrganizationName)
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
            }
            Spacer()
            if let environmentLabel = model.environmentLabel {
                Text(environmentLabel)
                    .font(.caption2.weight(.bold))
                    .tracking(0.8)
                    .foregroundStyle(AppShellTheme.primary)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 5)
                    .background(AppShellTheme.primary.opacity(0.12), in: Capsule())
            }
        }
    }

    private var sessionSecurityCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Session security", systemImage: "faceid")
                    .font(.headline)
                    .foregroundStyle(AppShellTheme.text)
                Spacer()
                Toggle("", isOn: Binding(
                    get: { model.biometricUnlockEnabled },
                    set: { enabled in
                        Task { await model.setBiometricUnlockEnabled(enabled) }
                    }
                ))
                .labelsHidden()
                .disabled(!model.biometricUnlockAvailable)
            }
            Text(model.biometricUnlockAvailable
                 ? "Use \(model.biometricUnlockTitle) to unlock this signed-in session after a fresh app launch. Magic codes and Google remain available."
                 : "Set up Face ID or Touch ID in iPhone Settings to enable local unlock.")
                .font(.footnote)
                .foregroundStyle(AppShellTheme.muted)
            if !model.biometricStatus.isEmpty {
                Text(model.biometricStatus)
                    .font(.caption2)
                    .foregroundStyle(AppShellTheme.muted)
            }

            if model.googleSSOAvailable {
                Divider()
                    .overlay(AppShellTheme.outline)
                    .padding(.vertical, 3)

                HStack(spacing: 8) {
                    Label("Google sign-in", systemImage: "person.badge.key.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppShellTheme.text)
                    Spacer()
                    if let state = model.googleAuthState {
                        Text(state.identity.linked ? "LINKED" : "NOT LINKED")
                            .font(.caption2.weight(.bold))
                            .tracking(0.6)
                            .foregroundStyle(state.identity.linked ? AppShellTheme.mint : AppShellTheme.muted)
                    }
                }

                Text(model.googleLinkStatus)
                    .font(.caption2)
                    .foregroundStyle(AppShellTheme.muted)

                if let state = model.googleAuthState,
                   state.platformConfigured,
                   state.canLinkCurrentUser,
                   !state.identity.linked {
                    Button {
                        Task { await model.linkCurrentGoogleAccount() }
                    } label: {
                        HStack(spacing: 8) {
                            if model.isGoogleLinkBusy { ProgressView() }
                            Text("Link my Google account")
                            Image(systemName: "arrow.up.right.square")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ShellSecondaryButtonStyle())
                    .disabled(model.isGoogleLinkBusy)
                } else if model.googleAuthState == nil {
                    Button("Refresh Google status") {
                        Task { await model.refreshGoogleAuthState() }
                    }
                    .font(.caption.weight(.semibold))
                    .disabled(model.isGoogleLinkBusy)
                }
            }
        }
        .padding(16)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(AppShellTheme.outline, lineWidth: 1)
        }
    }

    private func workflowCard(
        icon: String,
        color: Color,
        title: String,
        subtitle: String,
        badge: String
    ) -> some View {
        HStack(spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .semibold))
                .foregroundStyle(color)
                .frame(width: 58, height: 58)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 17))
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(title)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text(badge)
                        .font(.system(size: 9, weight: .bold))
                        .tracking(0.7)
                        .foregroundStyle(color)
                }
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
                    .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right")
                .foregroundStyle(AppShellTheme.muted)
        }
        .padding(18)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 21, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 21, style: .continuous)
                .stroke(AppShellTheme.outline, lineWidth: 1)
        }
    }
}

private struct WorkspaceSwitcherCard: View {
    @ObservedObject var model: PickingPhoneModel
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 9 : 12) {
            HStack(spacing: 10) {
                Image(systemName: "building.2.fill")
                    .foregroundStyle(AppShellTheme.primary)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Organization")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(AppShellTheme.muted)
                    Text(model.sessionOrganizationName)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppShellTheme.text)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                        .layoutPriority(1)
                }
                Spacer()
                if model.isWorkspaceBusy {
                    ProgressView()
                        .tint(AppShellTheme.primary)
                } else if model.availableWorkspaces.count > 1 {
                    workspaceMenu
                } else {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(AppShellTheme.mint)
                }
            }

            if !compact {
                Text(model.workspaceStatus)
                    .font(.footnote)
                    .foregroundStyle(AppShellTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(compact ? 14 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(AppShellTheme.outline, lineWidth: 1)
        }
    }

    private var workspaceMenu: some View {
        Menu {
            ForEach(model.availableWorkspaces) { workspace in
                Button {
                    Task { await model.switchWorkspace(to: workspace.organizationId) }
                } label: {
                    if workspace.organizationId == model.activeWorkspace?.organizationId {
                        Label(workspaceLabel(workspace), systemImage: "checkmark")
                    } else {
                        Text(workspaceLabel(workspace))
                    }
                }
            }
        } label: {
            Label("Change", systemImage: "chevron.up.chevron.down")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 12)
                .frame(minHeight: 38)
                .background(AppShellTheme.raised, in: Capsule())
        }
        .disabled(!model.canSwitchWorkspace)
    }

    private func workspaceLabel(_ workspace: ClawPilotSessionProfile.Workspace) -> String {
        workspace.name ?? workspace.referenceCode ?? "ClawPilot organization"
    }
}

private struct ManagerModule: Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String
    let icon: String
}

private struct ManagerModuleView: View {
    @ObservedObject var model: PickingPhoneModel

    private let modules = [
        ManagerModule(id: "dashboard", title: "Dashboard", detail: "Workspace overview", icon: "rectangle.3.group.fill"),
        ManagerModule(id: "operations", title: "Operations", detail: "Orders and warehouse control", icon: "shippingbox.fill"),
        ManagerModule(id: "people", title: "People", detail: "Invite workers and grant picker access", icon: "person.2.badge.gearshape.fill"),
        ManagerModule(id: "projects", title: "Projects", detail: "Boards and active work", icon: "checklist"),
        ManagerModule(id: "pipeline", title: "Pipeline", detail: "Commercial pipeline", icon: "chart.bar.xaxis"),
        ManagerModule(id: "crm", title: "CRM", detail: "Customers and contacts", icon: "person.2.fill"),
        ManagerModule(id: "accounting", title: "Accounting", detail: "Financial workflows", icon: "building.columns.fill"),
        ManagerModule(id: "pos", title: "POS", detail: "Point-of-sale workspace", icon: "creditcard.fill"),
        ManagerModule(id: "agents", title: "Agents", detail: "Agent work and status", icon: "sparkles"),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                managerQuickStart
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 14) {
                    ForEach(modules) { module in
                        NavigationLink(value: module) {
                            VStack(alignment: .leading, spacing: 12) {
                                Image(systemName: module.icon)
                                    .font(.system(size: 23, weight: .semibold))
                                    .foregroundStyle(AppShellTheme.primary)
                                    .frame(width: 44, height: 44)
                                    .background(AppShellTheme.primary.opacity(0.1), in: RoundedRectangle(cornerRadius: 13))
                                Text(module.title)
                                    .font(.headline)
                                    .foregroundStyle(AppShellTheme.text)
                                Text(module.detail)
                                    .font(.caption)
                                    .foregroundStyle(AppShellTheme.muted)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(16)
                            .frame(maxWidth: .infinity, minHeight: 160, alignment: .topLeading)
                            .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 19))
                            .overlay {
                                RoundedRectangle(cornerRadius: 19).stroke(AppShellTheme.outline, lineWidth: 1)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(18)
        }
        .background(AppShellTheme.canvas)
        .navigationTitle("Manager")
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: ManagerModule.self) { module in
            if module.id == "operations" {
                ManagerPickingOperationsView(model: model)
            } else {
                ManagerWebModuleView(module: module, origin: model.webOrigin)
            }
        }
    }

    private var managerQuickStart: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Manager quick start", systemImage: "checklist.checked")
                .font(.headline)
                .foregroundStyle(AppShellTheme.text)
            Text("1. Open People to invite a worker and enable Picker access.\n2. Open Operations and select a planned order.\n3. Choose the picker, then wave and assign the order.")
                .font(.subheadline)
                .foregroundStyle(AppShellTheme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppShellTheme.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
    }
}

private struct ManagerPickingOperationsView: View {
    @ObservedObject var model: PickingPhoneModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 13) {
                WorkspaceSwitcherCard(model: model, compact: true)
                workflowExplanation
                pickerPerformance

                if model.isManagerBusy && model.managerOrders.isEmpty {
                    ProgressView("Loading orders")
                        .tint(AppShellTheme.primary)
                        .foregroundStyle(AppShellTheme.muted)
                        .padding(30)
                } else if model.managerOrders.isEmpty {
                    Label(model.managerStatus, systemImage: "shippingbox")
                        .font(.subheadline)
                        .foregroundStyle(AppShellTheme.muted)
                        .padding(22)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
                } else {
                    ForEach(model.managerOrders) { order in
                        Button {
                            Task { await model.loadManagerOrder(order) }
                        } label: {
                            orderCard(order)
                        }
                        .buttonStyle(.plain)
                    }
                }

                Label(model.managerStatus, systemImage: "info.circle.fill")
                    .font(.footnote)
                    .foregroundStyle(AppShellTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            }
            .padding(18)
            .padding(.bottom, 30)
        }
        .background(AppShellTheme.canvas)
        .navigationTitle("Picking operations")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.loadManagerOperations() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .disabled(model.isManagerBusy)
            }
        }
        .task { await model.loadManagerOperations() }
        .sheet(item: $model.managerSelectedOrder) { order in
            ManagerOrderAssignmentView(model: model, order: order)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private var workflowExplanation: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "person.2.badge.gearshape.fill")
                .foregroundStyle(AppShellTheme.mint)
                .font(.title2)
            VStack(alignment: .leading, spacing: 4) {
                Text("Manager handoff")
                    .font(.headline)
                    .foregroundStyle(AppShellTheme.text)
                Text("Review planned orders, release a warehouse wave, and assign every ready pick to one eligible worker.")
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
            }
        }
        .padding(16)
        .background(AppShellTheme.mint.opacity(0.08), in: RoundedRectangle(cornerRadius: 18))
    }

    private var pickerPerformance: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Picker performance")
                        .font(.headline)
                        .foregroundStyle(AppShellTheme.text)
                    Text("Last 7 days · assignment to audited confirmation")
                        .font(.caption)
                        .foregroundStyle(AppShellTheme.muted)
                }
                Spacer()
                Image(systemName: "gauge.with.dots.needle.67percent")
                    .foregroundStyle(AppShellTheme.mint)
            }
            if model.pickerPerformance.isEmpty {
                Text("UPH appears after assigned orders are confirmed.")
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
            } else {
                ForEach(model.pickerPerformance.prefix(5)) { metric in
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(metric.displayName ?? metric.email)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppShellTheme.text)
                            Text("\(metric.ordersSevenDays) orders · \(metric.unitsSevenDays.formatted(.number.precision(.fractionLength(0...1)))) units")
                                .font(.caption2)
                                .foregroundStyle(AppShellTheme.muted)
                        }
                        Spacer()
                        Text(metric.uphSevenDays?.formatted(.number.precision(.fractionLength(1))) ?? "—")
                            .font(.headline)
                            .foregroundStyle(AppShellTheme.mint)
                        Text("UPH")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(AppShellTheme.muted)
                    }
                }
            }
        }
        .padding(16)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }

    private func orderCard(_ order: ManagerOrderSummary) -> some View {
        HStack(spacing: 13) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Order \(order.orderNumber)")
                        .font(.headline)
                        .foregroundStyle(AppShellTheme.text)
                    statusBadge(order.status)
                }
                Text(order.customerName)
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
                Text("\(order.lineCount) lines · \(order.warehouseName ?? "Warehouse pending")")
                    .font(.caption)
                    .foregroundStyle(AppShellTheme.muted)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(AppShellTheme.muted)
        }
        .padding(17)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18).stroke(AppShellTheme.outline, lineWidth: 1)
        }
    }

    private func statusBadge(_ status: String) -> some View {
        Text(status.replacingOccurrences(of: "_", with: " ").uppercased())
            .font(.system(size: 9, weight: .bold))
            .tracking(0.5)
            .foregroundStyle(status == "planned" ? AppShellTheme.primary : AppShellTheme.mint)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(
                (status == "planned" ? AppShellTheme.primary : AppShellTheme.mint).opacity(0.1),
                in: Capsule()
            )
    }
}

private struct ManagerOrderAssignmentView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: PickingPhoneModel
    let order: ManagerOrderDetail
    @State private var pickerEmail = ""
    @State private var reason = "Release and assign warehouse picks from ClawPilot Mobile"

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    orderSummary
                    pickerSection
                    consequenceNotice

                    Button {
                        Task {
                            if await model.releaseOrAssignManagerOrder(
                                assignedTo: pickerEmail,
                                reason: reason
                            ) {
                                dismiss()
                            }
                        }
                    } label: {
                        HStack {
                            if model.isManagerBusy {
                                ProgressView().tint(AppShellTheme.primaryText)
                            }
                            Text(order.status == "planned" ? "Wave and assign order" : "Assign ready picks")
                            Image(systemName: "arrow.right")
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ShellPrimaryButtonStyle())
                    .disabled(
                        model.isManagerBusy
                        || pickerEmail.isEmpty
                        || reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || !["planned", "released"].contains(order.status)
                    )

                    Button {
                        dismiss()
                    } label: {
                        Label("Back to orders without changes", systemImage: "xmark.circle")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ShellSecondaryButtonStyle())
                    .disabled(model.isManagerBusy)
                }
                .padding(20)
            }
            .background(AppShellTheme.canvas)
            .navigationTitle("Order \(order.orderNumber)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark.circle.fill")
                    }
                    .accessibilityLabel("Close order without changes")
                    .disabled(model.isManagerBusy)
                }
            }
            .interactiveDismissDisabled(model.isManagerBusy)
            .onAppear {
                if pickerEmail.isEmpty { pickerEmail = model.managerPickers.first?.email ?? "" }
            }
        }
    }

    private var orderSummary: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(order.customerName)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text(order.warehouseName ?? "Warehouse pending")
                        .font(.subheadline)
                        .foregroundStyle(AppShellTheme.muted)
                }
                Spacer()
                Text(order.status.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(AppShellTheme.primary)
            }

            Divider().overlay(AppShellTheme.outline)

            HStack {
                metric("Plan", value: order.planStatus ?? "Not planned")
                metric("Wave", value: order.waveStatus ?? "Not released")
                metric("Ready picks", value: "\(order.readyPickTaskCount)/\(order.pickTaskCount)")
            }
        }
        .padding(18)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 19))
    }

    private var pickerSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Assign picker")
                .font(.headline)
                .foregroundStyle(AppShellTheme.text)
            Picker("Picker", selection: $pickerEmail) {
                Text("Choose a picker").tag("")
                ForEach(model.managerPickers) { picker in
                    Text(picker.displayName ?? picker.email).tag(picker.email)
                }
            }
            .pickerStyle(.menu)
            .padding(.horizontal, 13)
            .frame(minHeight: 52)
            .background(AppShellTheme.raised, in: RoundedRectangle(cornerRadius: 13))

            if model.managerPickers.isEmpty {
                Label(
                    "No eligible pickers. Close this order, open People, invite the worker, and enable View operations plus Picker access.",
                    systemImage: "person.crop.circle.badge.exclamationmark"
                )
                .font(.caption)
                .foregroundStyle(AppShellTheme.muted)
            }

            TextField("Audit reason", text: $reason, axis: .vertical)
                .lineLimit(2...4)
                .shellInputSurface()
        }
    }

    private var consequenceNotice: some View {
        Label(
            order.status == "planned"
                ? "This audited command releases the warehouse wave, creates ready pick tasks, and assigns them to the selected worker."
                : "This audited command reassigns every unstarted ready pick for this released order.",
            systemImage: "checkmark.shield.fill"
        )
        .font(.footnote)
        .foregroundStyle(AppShellTheme.muted)
        .padding(15)
        .background(AppShellTheme.primary.opacity(0.08), in: RoundedRectangle(cornerRadius: 15))
    }

    private func metric(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title.uppercased())
                .font(.system(size: 9, weight: .bold))
                .tracking(0.5)
                .foregroundStyle(AppShellTheme.muted)
            Text(value.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppShellTheme.text)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ManagerWebModuleView: View {
    let module: ManagerModule
    let origin: URL

    var body: some View {
        AuthenticatedWebView(url: moduleURL)
            .background(AppShellTheme.canvas)
            .navigationTitle(module.title)
            .navigationBarTitleDisplayMode(.inline)
    }

    private var moduleURL: URL {
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
        if module.id == "people" {
            components.queryItems = [URLQueryItem(name: "settings", value: "people")]
            components.fragment = "dashboard"
        } else {
            components.fragment = module.id
        }
        return components.url!
    }
}

private struct AuthenticatedWebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = true
        WebSessionBridge.load(url: url, in: webView)
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard webView.url?.absoluteString != url.absoluteString else { return }
        WebSessionBridge.load(url: url, in: webView)
    }
}

enum WebSessionBridge {
    @MainActor
    static func load(url: URL, in webView: WKWebView) {
        let cookies = HTTPCookieStorage.shared.cookies(for: url) ?? []
        guard !cookies.isEmpty else {
            webView.load(URLRequest(url: url))
            return
        }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        let group = DispatchGroup()
        for cookie in cookies {
            group.enter()
            store.setCookie(cookie) { group.leave() }
        }
        group.notify(queue: .main) {
            webView.load(URLRequest(url: url))
        }
    }

    @MainActor
    static func clearCookies() async {
        HTTPCookieStorage.shared.cookies?.forEach(HTTPCookieStorage.shared.deleteCookie)
        let store = WKWebsiteDataStore.default()
        await withCheckedContinuation { continuation in
            store.removeData(
                ofTypes: [WKWebsiteDataTypeCookies],
                modifiedSince: .distantPast
            ) {
                continuation.resume()
            }
        }
    }
}

private extension View {
    func shellInputSurface() -> some View {
        self
            .padding(.horizontal, 14)
            .frame(minHeight: 54)
            .background(AppShellTheme.raised, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(AppShellTheme.outline, lineWidth: 1)
            }
            .foregroundStyle(AppShellTheme.text)
    }
}

private struct ShellPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AppShellTheme.primaryText)
            .padding(.horizontal, 16)
            .frame(minHeight: 52)
            .background(AppShellTheme.primary, in: Capsule())
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.45)
    }
}

private struct ShellSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(AppShellTheme.primary)
            .padding(.horizontal, 16)
            .frame(minHeight: 50)
            .background(AppShellTheme.raised, in: Capsule())
            .overlay { Capsule().stroke(AppShellTheme.outline, lineWidth: 1) }
            .opacity(isEnabled ? (configuration.isPressed ? 0.75 : 1) : 0.45)
    }
}
