import Foundation
import LocalAuthentication

@MainActor
final class BiometricUnlockController {
    private static let enabledKey = "clawpilot.biometric-unlock.enabled"
    private static let rememberedSessionKey = "clawpilot.biometric-unlock.remembered-session"

    var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.enabledKey)
    }

    var hasRememberedSession: Bool {
        UserDefaults.standard.bool(forKey: Self.rememberedSessionKey)
    }

    var isAvailable: Bool {
        let context = LAContext()
        var error: NSError?
        return context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }

    var title: String {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        else { return "Biometric unlock" }
        switch context.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        case .none: return "Biometric unlock"
        @unknown default: return "Biometric unlock"
        }
    }

    func rememberAuthenticatedSession() {
        UserDefaults.standard.set(true, forKey: Self.rememberedSessionKey)
    }

    func forgetAuthenticatedSession() {
        UserDefaults.standard.set(false, forKey: Self.rememberedSessionKey)
    }

    func setEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.enabledKey)
    }

    func authenticate() async throws -> Bool {
        let context = LAContext()
        context.localizedCancelTitle = "Use sign-in instead"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
        else { throw error ?? LAError(.biometryNotAvailable) }
        return try await context.evaluatePolicy(
            .deviceOwnerAuthenticationWithBiometrics,
            localizedReason: "Unlock your existing ClawPilot session."
        )
    }
}
