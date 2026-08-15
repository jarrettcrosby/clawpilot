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
        case "pick-management", "pick-intervention":
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
                .frame(minHeight: 44)
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
                currentAssignments
                completedPickHistory
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
        .sheet(item: $model.managerSelectedPickAssignment) { assignment in
            ManagerPickInterventionView(model: model, assignment: assignment)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
    }

    private var currentAssignments: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Current assignments")
                        .font(.headline)
                        .foregroundStyle(AppShellTheme.text)
                    Text("Released work")
                        .font(.caption)
                        .foregroundStyle(AppShellTheme.muted)
                }
                Spacer()
                Text("\(model.managerPickManagement?.current.count ?? 0)")
                    .font(.headline)
                    .foregroundStyle(AppShellTheme.mint)
            }

            if let assignments = model.managerPickManagement?.current,
               assignments.isEmpty == false {
                ForEach(assignments) { assignment in
                    Button {
                        model.managerSelectedPickAssignment = assignment
                    } label: {
                        currentAssignmentCard(assignment)
                    }
                    .buttonStyle(.plain)
                    .disabled(!assignment.canManageAssignment)
                    .accessibilityHint(assignment.canManageAssignment
                        ? "Opens exact picker assignment controls"
                        : "Picker assignment is locked because work has started")
                }
            } else {
                Text("No active pick assignments.")
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
            }
        }
        .padding(16)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }

    private func currentAssignmentCard(
        _ assignment: ManagerCurrentPickAssignment
    ) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Order \(assignment.orderNumber)")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text(assignment.pickerLabel)
                        .font(.caption)
                        .foregroundStyle(assignment.assignedTo == nil
                            ? Color.orange
                            : AppShellTheme.mint)
                }
                Spacer()
                Image(systemName: assignment.canManageAssignment
                    ? "slider.horizontal.3"
                    : "lock.fill")
                    .foregroundStyle(assignment.canManageAssignment
                        ? AppShellTheme.primary
                        : AppShellTheme.muted)
            }
            HStack(spacing: 14) {
                evidenceMetric("TASKS", "\(assignment.readyTaskCount)/\(assignment.taskCount)")
                evidenceMetric("UNITS", "\(assignment.pickedUnits.formatted())/\(assignment.requiredUnits.formatted())")
                evidenceMetric("SCANS", "\(assignment.scanEvidenceTaskCount)/\(assignment.taskCount)")
                evidenceMetric("COUNTS", "\(assignment.countEvidenceTaskCount)/\(assignment.taskCount)")
            }
            if assignment.handoffExceptionGlobalId != nil
                || assignment.interventionExceptionGlobalId != nil {
                Label("Manager exception remains open", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(Color.orange)
            }
            if let blocked = assignment.managementBlockedReason {
                Text(blocked)
                    .font(.caption2)
                    .foregroundStyle(AppShellTheme.muted)
            }
        }
        .padding(.vertical, 11)
        .overlay(alignment: .bottom) {
            Divider().overlay(AppShellTheme.outline)
        }
    }

    private var completedPickHistory: some View {
        VStack(alignment: .leading, spacing: 11) {
            Text("Completed picks")
                .font(.headline)
                .foregroundStyle(AppShellTheme.text)
            if let history = model.managerPickManagement?.history,
               history.isEmpty == false {
                ForEach(history) { item in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Order \(item.orderNumber)")
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(AppShellTheme.text)
                            Text(item.pickerDisplayName ?? item.pickerEmail)
                                .font(.caption)
                                .foregroundStyle(AppShellTheme.muted)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 2) {
                            Text("\(item.taskCount) tasks")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(AppShellTheme.mint)
                            Text("\(item.unitCount.formatted()) units")
                                .font(.caption2)
                                .foregroundStyle(AppShellTheme.muted)
                        }
                    }
                }
            } else {
                Text("No completed picks yet.")
                    .font(.subheadline)
                    .foregroundStyle(AppShellTheme.muted)
            }
        }
        .padding(16)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }

    private func evidenceMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(AppShellTheme.muted)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(AppShellTheme.text)
        }
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
    @State private var showReplanningConfirmation = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    orderSummary
                    pickerSection
                    consequenceNotice
                    if let correction = order.replanningCorrectionAvailability {
                        replanningCorrectionSection(correction)
                    }

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
            .sheet(isPresented: $showReplanningConfirmation) {
                if let correction = order.replanningCorrectionAction {
                    ManagerOrderReplanningConfirmationView(
                        model: model,
                        order: order,
                        correction: correction
                    )
                }
            }
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

    private func replanningCorrectionSection(
        _ correction: ManagerOrderActionAvailability
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Order correction")
                .font(.headline)
                .foregroundStyle(AppShellTheme.text)
            Text(
                correction.isExactReplanningCorrectionProjection
                    ? (correction.consequenceSummary ?? "")
                    : (correction.blockedReason
                        ?? "Refresh this order before reviewing a correction.")
            )
                .font(.footnote)
                .foregroundStyle(AppShellTheme.muted)
            if !correction.isExactReplanningCorrectionProjection,
               let blockedCode = correction.blockedCode {
                Text(blockedCode)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Color.orange)
            }
            Button {
                showReplanningConfirmation = true
            } label: {
                Label(correction.label, systemImage: "arrow.uturn.backward.circle")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ShellSecondaryButtonStyle())
            .disabled(
                model.isManagerBusy
                    || model.isReplayingManagerOrderReplanning
                    || model.hasPendingManagerOrderReplanning
                    || !correction.isExactReplanningCorrectionProjection
            )
        }
        .padding(16)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 15))
        .overlay {
            RoundedRectangle(cornerRadius: 15)
                .stroke(Color.orange.opacity(0.28), lineWidth: 1)
        }
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

private struct ManagerOrderReplanningConfirmationView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: PickingPhoneModel
    let order: ManagerOrderDetail
    let correction: ManagerOrderActionAvailability
    @State private var reason = ""

    private var normalizedReason: String {
        reason.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var reasonIsValid: Bool {
        normalizedReason.utf16.count >= 8
            && normalizedReason.utf16.count <= 500
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Label("This changes local warehouse state", systemImage: "exclamationmark.triangle.fill")
                        .font(.headline)
                        .foregroundStyle(Color.orange)

                    Text(correction.consequenceSummary ?? "")
                        .font(.body)
                        .foregroundStyle(AppShellTheme.text)

                    Label(
                        "The provider order remains unchanged. This request makes zero carrier and storefront calls.",
                        systemImage: "network.slash"
                    )
                    .font(.footnote)
                    .foregroundStyle(AppShellTheme.muted)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Required audit reason")
                            .font(.headline)
                            .foregroundStyle(AppShellTheme.text)
                        TextField(
                            "Explain why this order must be replanned",
                            text: $reason,
                            axis: .vertical
                        )
                        .lineLimit(3...6)
                        .shellInputSurface()
                        .disabled(model.hasPendingManagerOrderReplanning)
                        Text("At least 8 characters · \(normalizedReason.utf16.count)/500")
                            .font(.caption)
                            .foregroundStyle(AppShellTheme.muted)
                    }

                    if let detail = model.managerOrderReplanningDetail {
                        Label(
                            detail,
                            systemImage: model.managerOrderReplanningRefreshRequired
                                ? "arrow.clockwise.circle"
                                : "externaldrive.badge.timemachine"
                        )
                        .font(.footnote)
                        .foregroundStyle(
                            model.managerOrderReplanningRefreshRequired
                                ? Color.orange
                                : AppShellTheme.muted
                        )
                        .padding(14)
                        .background(AppShellTheme.raised, in: RoundedRectangle(cornerRadius: 13))
                    }

                    if model.managerOrderReplanningRefreshRequired {
                        Button {
                            Task {
                                await model.refreshManagerAfterReplanningConflict()
                                dismiss()
                            }
                        } label: {
                            Label("Refresh order before another correction", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ShellPrimaryButtonStyle())
                        .disabled(model.isManagerBusy)
                    } else {
                        Button {
                            Task {
                                let completed = model.hasPendingManagerOrderReplanning
                                    ? await model.retryPendingManagerOrderReplanning()
                                    : await model.reopenManagerOrderForReplanning(
                                        reason: normalizedReason
                                    )
                                if completed { dismiss() }
                            }
                        } label: {
                            HStack {
                                if model.isReplayingManagerOrderReplanning {
                                    ProgressView().tint(AppShellTheme.primaryText)
                                }
                                Text(
                                    model.hasPendingManagerOrderReplanning
                                        ? "Retry saved correction"
                                        : "Confirm reopen for replanning"
                                )
                                Image(systemName: "arrow.uturn.backward")
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ShellPrimaryButtonStyle())
                        .disabled(
                            model.isManagerBusy
                                || model.isReplayingManagerOrderReplanning
                                || (!model.hasPendingManagerOrderReplanning && !reasonIsValid)
                        )
                    }

                    Button("Keep current warehouse work") { dismiss() }
                        .buttonStyle(ShellSecondaryButtonStyle())
                        .disabled(
                            model.isManagerBusy
                                || model.isReplayingManagerOrderReplanning
                        )
                }
                .padding(20)
            }
            .background(AppShellTheme.canvas)
            .navigationTitle("Reopen order \(order.orderNumber)?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                        .disabled(
                            model.isManagerBusy
                                || model.isReplayingManagerOrderReplanning
                        )
                }
            }
            .interactiveDismissDisabled(
                model.isManagerBusy || model.isReplayingManagerOrderReplanning
            )
        }
    }
}

private struct ManagerPickInterventionView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: PickingPhoneModel
    let assignment: ManagerCurrentPickAssignment
    @State private var pickerEmail: String
    @State private var reason = ""
    @State private var idempotencyKey = UUID().uuidString

    init(model: PickingPhoneModel, assignment: ManagerCurrentPickAssignment) {
        self.model = model
        self.assignment = assignment
        _pickerEmail = State(initialValue: assignment.assignedTo ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    assignmentSummary
                    evidenceFence
                    pickerSelection
                    primaryAction
                }
                .padding(20)
            }
            .background(AppShellTheme.canvas)
            .navigationTitle("Manage order \(assignment.orderNumber)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                        .disabled(model.isManagerBusy)
                }
            }
            .interactiveDismissDisabled(model.isManagerBusy)
            .onChange(of: pickerEmail) { _, _ in rotateIdempotencyKey() }
            .onChange(of: reason) { _, _ in rotateIdempotencyKey() }
        }
    }

    private var assignmentSummary: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(assignment.pickerLabel)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(AppShellTheme.text)
                    Text(assignment.warehouseName)
                        .font(.subheadline)
                        .foregroundStyle(AppShellTheme.muted)
                }
                Spacer()
                Text("v\(assignment.rowVersion)")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(AppShellTheme.primary)
            }
            HStack {
                summaryMetric("TASKS", "\(assignment.readyTaskCount)/\(assignment.taskCount)")
                summaryMetric("UNITS", "\(assignment.pickedUnits.formatted())/\(assignment.requiredUnits.formatted())")
                summaryMetric("SCANNED", "\(assignment.scanEvidenceTaskCount)/\(assignment.taskCount)")
                summaryMetric("COUNTED", "\(assignment.countEvidenceTaskCount)/\(assignment.taskCount)")
            }
        }
        .padding(17)
        .background(AppShellTheme.surface, in: RoundedRectangle(cornerRadius: 18))
    }

    private var evidenceFence: some View {
        HStack(spacing: 8) {
            Label("Unstarted work only", systemImage: "checkmark.shield.fill")
                .foregroundStyle(AppShellTheme.mint)
            Spacer(minLength: 8)
            if assignment.managementBlockedReason != nil {
                Label("Blocked", systemImage: "lock.fill")
                    .foregroundStyle(Color.orange)
            } else if assignment.handoffExceptionGlobalId != nil
                || assignment.interventionExceptionGlobalId != nil {
                Label("Exception retained", systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(Color.orange)
            }
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 13)
        .frame(minHeight: 44)
        .background(AppShellTheme.mint.opacity(0.08), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Unstarted work only")
        .accessibilityValue(evidenceFenceAccessibilityValue)
    }

    private var evidenceFenceAccessibilityValue: String {
        var details = [
            "The server blocks this change after any scan, count, picked, packed, label, or shipment evidence."
        ]
        if assignment.handoffExceptionGlobalId != nil
            || assignment.interventionExceptionGlobalId != nil {
            details.append("Existing exceptions stay open for review.")
        }
        if let blocked = assignment.managementBlockedReason {
            details.append("Blocked: \(blocked)")
        }
        return details.joined(separator: " ")
    }

    private var pickerSelection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Picker intervention")
                .font(.headline)
                .foregroundStyle(AppShellTheme.text)

            HStack(spacing: 12) {
                Text("Picker")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(AppShellTheme.text)
                Spacer(minLength: 8)
                pickerMenu
            }
            .frame(minHeight: 44)

            if pickerEmail.isEmpty {
                Label("Manager exception · evidence retained", systemImage: "exclamationmark.triangle.fill")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.orange)
                .accessibilityValue("Unassign creates or retains a high-priority manager exception; it never clears scan/count evidence or physical work.")
            }

            Text("Reason")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(AppShellTheme.text)
            TextField("Required", text: $reason)
                .shellInputSurface()
                .accessibilityLabel("Manager reason")
                .accessibilityHint("Required for the audited assignment command.")
        }
    }

    private var pickerMenu: some View {
        Menu {
            Button(role: .destructive) {
                pickerEmail = ""
            } label: {
                Label("Unassign", systemImage: "person.crop.circle.badge.minus")
            }
            ForEach(model.managerPickManagement?.eligiblePickers
                ?? model.managerPickers) { picker in
                Button {
                    pickerEmail = picker.email
                } label: {
                    if picker.email == pickerEmail {
                        Label(picker.displayName ?? picker.email, systemImage: "checkmark")
                    } else {
                        Text(picker.displayName ?? picker.email)
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Text(selectedPickerLabel)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption.weight(.semibold))
            }
            .frame(minHeight: 44)
        }
        .buttonStyle(.bordered)
        .controlSize(.regular)
        .accessibilityLabel("Picker")
        .accessibilityValue(selectedPickerLabel)
    }

    private var selectedPickerLabel: String {
        guard !pickerEmail.isEmpty else { return "Unassigned" }
        return (model.managerPickManagement?.eligiblePickers ?? model.managerPickers)
            .first(where: { $0.email == pickerEmail })?
            .displayName ?? pickerEmail
    }

    private var primaryAction: some View {
        HStack {
            Spacer(minLength: 0)
            Button {
                let selected = pickerEmail.isEmpty ? nil : pickerEmail
                Task {
                    if await model.managePickerAssignment(
                        assignment,
                        assignedTo: selected,
                        reason: reason,
                        idempotencyKey: idempotencyKey
                    ) {
                        dismiss()
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    if model.isManagerBusy {
                        ProgressView()
                    }
                    Text(actionTitle)
                    Image(systemName: pickerEmail.isEmpty
                        ? "person.crop.circle.badge.minus"
                        : "person.crop.circle.badge.checkmark")
                }
                .frame(minHeight: 44)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.regular)
            .tint(pickerEmail.isEmpty ? Color.red : AppShellTheme.primary)
            .disabled(saveDisabled)
            .accessibilityLabel(actionAccessibilityLabel)
            .accessibilityHint("Uses the exact order version, ready-task count, and assignment fingerprint.")
        }
    }

    private var actionTitle: String {
        if pickerEmail.isEmpty { return "Unassign" }
        return assignment.assignedTo == nil
            ? "Assign"
            : "Reassign"
    }

    private var actionAccessibilityLabel: String {
        if pickerEmail.isEmpty {
            return "Unassign exact ready tasks and flag for manager"
        }
        return assignment.assignedTo == nil
            ? "Assign exact ready tasks"
            : "Reassign exact ready tasks"
    }

    private var saveDisabled: Bool {
        let normalizedReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let assignmentUnchanged = assignment.assignmentState != "mixed"
            && (assignment.assignedTo ?? "") == pickerEmail
        return model.isManagerBusy
            || assignment.canManageAssignment == false
            || normalizedReason.isEmpty
            || normalizedReason.count > 500
            || assignmentUnchanged
    }

    private func rotateIdempotencyKey() {
        idempotencyKey = UUID().uuidString
    }

    private func summaryMetric(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(AppShellTheme.muted)
            Text(value)
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
