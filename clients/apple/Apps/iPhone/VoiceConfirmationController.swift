@preconcurrency import AVFoundation
@preconcurrency import Speech
import CoreML
import Foundation
import SupertonicTTS
import UIKit

struct EnhancedVoicePlaybackResult: Equatable, Sendable {
    let outputName: String
    let startedWhilePhoneBackgrounded: Bool
    let startedAt: Date
}

@MainActor
private final class PhoneAudioBackgroundLease {
    private var identifier: UIBackgroundTaskIdentifier = .invalid
    private(set) var expired = false

    init(name: String) {
        identifier = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            guard let self else { return }
            self.expired = true
            self.end()
        }
        if identifier == .invalid { expired = true }
    }

    func end() {
        guard identifier != .invalid else { return }
        let current = identifier
        identifier = .invalid
        UIApplication.shared.endBackgroundTask(current)
    }
}

enum AudioPlaybackPreference: String, CaseIterable {
    case automatic
    case iPhoneSpeaker = "iphone_speaker"

    static let defaultsKey = "clawpilot_audio_playback"

    var title: String {
        switch self {
        case .automatic: "Automatic"
        case .iPhoneSpeaker: "iPhone speaker"
        }
    }
}

enum InstructionVoiceLanguage: String, CaseIterable, Identifiable {
    case english
    case spanish

    static let defaultsKey = "clawpilot_instruction_language"

    var id: String { rawValue }
    var title: String { self == .english ? "English" : "Spanish" }
    var languageCode: String { self == .english ? "en" : "es" }
    var recognitionLocaleIdentifier: String { self == .english ? "en-US" : "es-US" }
}

struct PronunciationCorrection: Codable, Equatable, Identifiable {
    let id: UUID
    let written: String
    let spoken: String

    static let clawPilot = PronunciationCorrection(
        id: UUID(uuidString: "C1A0B110-7000-4000-8000-000000000001")!,
        written: "ClawPilot",
        spoken: "Claw Pilot"
    )
}

enum OfflineVoicePackState: Equatable {
    case unavailable
    case checking
    case notInstalled
    case downloading(progress: Double, status: String)
    case preparing
    case ready
    case loadFailed(String)
    case installFailed(String)

    var title: String {
        switch self {
        case .unavailable: "Enhanced voice requires a physical iPhone"
        case .checking: "Checking enhanced voice"
        case .notInstalled: "Enhanced voice pack not installed"
        case .downloading(let progress, _): "Installing enhanced voice · \(Int(progress * 100))%"
        case .preparing: "Preparing enhanced voice"
        case .ready: "Enhanced voice is ready offline"
        case .loadFailed: "Enhanced voice needs retry"
        case .installFailed: "Voice install needs retry"
        }
    }

    var detail: String {
        switch self {
        case .unavailable:
            "Simulator builds use Apple speech. Install the enhanced voice on a physical iPhone."
        case .checking:
            "Checking the installed voice pack."
        case .notInstalled:
            "Download the approximately 332 MB English and Spanish pack once."
        case .downloading(_, let status):
            status.isEmpty ? "Downloading the on-device voice model." : status
        case .preparing:
            "Loading the on-device CoreML model."
        case .ready:
            "Instructions are generated on this iPhone. Apple speech remains the fallback."
        case .loadFailed(let message), .installFailed(let message):
            message
        }
    }

    var progress: Double? {
        guard case .downloading(let progress, _) = self else { return nil }
        return progress
    }

    var canInstall: Bool {
        switch self {
        case .notInstalled, .installFailed: true
        default: false
        }
    }

    var canRetryLoad: Bool {
        if case .loadFailed = self { return true }
        return false
    }
}

private actor OfflineSpeechRuntime {
    private var model: SupertonicTTSModel?
    private var loadTask: Task<SupertonicTTSModel, Error>?
    private var loadGeneration: UInt64 = 0

    func load(
        cacheDirectory: URL,
        offlineMode: Bool,
        progress: @escaping @Sendable (Double, String) -> Void
    ) async throws {
        guard model == nil else { return }
        let generation = loadGeneration
        let task: Task<SupertonicTTSModel, Error>
        if let loadTask {
            task = loadTask
        } else {
            task = Task.detached(priority: .userInitiated) {
                try await SupertonicTTSModel.fromPretrained(
                    modelId: "aufklarer/Supertonic-3-CoreML-FP16",
                    cacheDir: cacheDirectory,
                    offlineMode: offlineMode,
                    // Locked-phone Watch commands run while iOS denies new GPU
                    // work. One CPU-only model is slower but valid in both app
                    // states and avoids a second 350 MB in-memory model graph.
                    computeUnits: .cpuOnly,
                    progressHandler: progress
                )
            }
            loadTask = task
        }

        do {
            let loaded = try await task.value
            try Task.checkCancellation()
            guard generation == loadGeneration else { throw CancellationError() }
            model = loaded
            loadTask = nil
        } catch {
            if generation == loadGeneration { loadTask = nil }
            throw error
        }
    }

    func synthesize(text: String, language: InstructionVoiceLanguage) throws -> [Float] {
        guard let model else { throw OfflineRuntimeError.notLoaded }
        return try model.synthesize(
            text: text,
            voice: language == .spanish ? "F2" : "F1",
            language: language.languageCode,
            options: SupertonicOptions(totalStep: 8, speed: 1.05, seed: 42)
        )
    }

    func unload() {
        loadGeneration &+= 1
        loadTask?.cancel()
        loadTask = nil
        model = nil
    }

    private enum OfflineRuntimeError: LocalizedError {
        case notLoaded

        var errorDescription: String? { "The enhanced voice pack is not loaded." }
    }
}

@MainActor
final class VoiceConfirmationController {
    private static let pronunciationDefaultsKey = "clawpilot_pronunciation_corrections"
    private let synthesizer = AVSpeechSynthesizer()
    private let audioEngine = AVAudioEngine()
    private let offlineSpeech = OfflineSpeechRuntime()
    private var offlinePlayer: AVAudioPlayer?
    private var strictPlaybackTask: Task<Void, Never>?
    private var speechTask: Task<Void, Never>?
    private var activeSpeechID: UUID?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionTimeoutTask: Task<Void, Never>?
    private var recognitionFinalHandler: (@MainActor (String) -> Void)?
    private var inputTapInstalled = false
    private(set) var voicePackState: OfflineVoicePackState
    var onVoicePackStateChange: (@MainActor (OfflineVoicePackState) -> Void)?

    init() {
        UserDefaults.standard.register(defaults: [
            AudioPlaybackPreference.defaultsKey: AudioPlaybackPreference.automatic.rawValue,
            InstructionVoiceLanguage.defaultsKey: InstructionVoiceLanguage.english.rawValue,
        ])
#if targetEnvironment(simulator)
        voicePackState = .unavailable
#else
        voicePackState = .checking
#endif
        if UserDefaults.standard.data(forKey: Self.pronunciationDefaultsKey) == nil {
            savePronunciationCorrections([.clawPilot])
        }
    }

    var playbackPreference: AudioPlaybackPreference {
        AudioPlaybackPreference(
            rawValue: UserDefaults.standard.string(
                forKey: AudioPlaybackPreference.defaultsKey
            ) ?? ""
        ) ?? .automatic
    }

    var instructionLanguage: InstructionVoiceLanguage {
        InstructionVoiceLanguage(
            rawValue: UserDefaults.standard.string(
                forKey: InstructionVoiceLanguage.defaultsKey
            ) ?? ""
        ) ?? .english
    }

    var pronunciationCorrections: [PronunciationCorrection] {
        guard let data = UserDefaults.standard.data(forKey: Self.pronunciationDefaultsKey),
              let corrections = try? JSONDecoder().decode([PronunciationCorrection].self, from: data)
        else { return [.clawPilot] }
        return corrections
    }

    func setInstructionLanguage(_ language: InstructionVoiceLanguage) {
        UserDefaults.standard.set(language.rawValue, forKey: InstructionVoiceLanguage.defaultsKey)
    }

    func addPronunciationCorrection(written: String, spoken: String) -> Bool {
        let written = written.trimmingCharacters(in: .whitespacesAndNewlines)
        let spoken = spoken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !written.isEmpty, !spoken.isEmpty, written.count <= 80, spoken.count <= 120 else {
            return false
        }
        var corrections = pronunciationCorrections.filter {
            $0.written.caseInsensitiveCompare(written) != .orderedSame
        }
        corrections.append(PronunciationCorrection(id: UUID(), written: written, spoken: spoken))
        savePronunciationCorrections(corrections)
        return true
    }

    func removePronunciationCorrection(id: UUID) {
        savePronunciationCorrections(pronunciationCorrections.filter { $0.id != id })
    }

    func previewPronunciation(_ spoken: String) {
        speak(spoken, spanish: spoken)
    }

#if DEBUG
    func runSpeechAuthorizationSelfTest() async -> String {
        let status = await Self.requestSpeechAuthorization()
        return status == .authorized ? "PASS authorized" : "FAIL status=\(status.rawValue)"
    }

    func runListeningSelfTest() async -> String {
        do {
            try await listen(
                preferBluetoothInput: false,
                timeout: .seconds(2),
                onTimeout: {},
                onFinal: { _ in }
            )
            try await Task.sleep(for: .milliseconds(2_500))
            stopListening()
            return "PASS microphone-session"
        } catch {
            stopListening()
            return "FAIL error=\(error.localizedDescription)"
        }
    }

    func runOfflineVoiceSelfTest() async -> String {
        guard voicePackState == .ready else {
            return "FAIL state=\(voicePackState.title)"
        }
        let samples: [(String, String, InstructionVoiceLanguage)] = [
            ("en", "Claw Pilot is ready. Scan the product barcode.", .english),
            ("es", "Claw Pilot está listo. Escanea el código de barras del producto.", .spanish),
        ]
        do {
            var results: [String] = []
            for (code, text, language) in samples {
                let pcm = try await offlineSpeech.synthesize(text: text, language: language)
                let finite = pcm.allSatisfy(\.isFinite)
                let peak = pcm.lazy.map { abs($0) }.max() ?? 0
                guard pcm.count > 44_100, finite, peak > 0.01 else {
                    return "FAIL \(code)_samples=\(pcm.count) finite=\(finite) peak=\(peak)"
                }
                results.append("\(code)_samples=\(pcm.count) peak=\(String(format: "%.4f", peak))")
            }
            return "PASS \(results.joined(separator: " "))"
        } catch {
            return "FAIL error=\(error.localizedDescription)"
        }
    }
#endif

    func prepareInstalledVoicePack() async {
#if !targetEnvironment(simulator)
        do {
            try Self.preparePersistentVoicePackStorage()
            if FileManager.default.fileExists(atPath: Self.legacyKokoroDirectory.path) {
                try FileManager.default.removeItem(at: Self.legacyKokoroDirectory)
            }
        } catch {
            setVoicePackState(.loadFailed(
                "Voice storage is unavailable. \(error.localizedDescription)"
            ))
            return
        }
        guard Self.isVoicePackInstalled else {
            setVoicePackState(.notInstalled)
            return
        }
        setVoicePackState(.preparing)
        do {
            try await offlineSpeech.load(
                cacheDirectory: Self.voicePackDirectory,
                offlineMode: true,
                progress: { _, _ in }
            )
            try Self.applyLockedPlaybackProtection(to: Self.voicePackDirectory)
            setVoicePackState(.ready)
        } catch is CancellationError {
            return
        } catch {
            await offlineSpeech.unload()
            setVoicePackState(.loadFailed(
                "Could not load the installed voice. \(error.localizedDescription)"
            ))
        }
#endif
    }

    func installVoicePack() async {
#if !targetEnvironment(simulator)
        stopSpeech()
        await offlineSpeech.unload()
        setVoicePackState(.downloading(progress: 0, status: "Starting the one-time download."))
        do {
            try Self.preparePersistentVoicePackStorage()
            try await offlineSpeech.load(
                cacheDirectory: Self.voicePackDirectory,
                offlineMode: false,
                progress: { [weak self] progress, status in
                    Task { @MainActor in
                        self?.setVoicePackState(.downloading(progress: progress, status: status))
                    }
                }
            )
            guard Self.isVoicePackInstalled else {
                throw VoiceError.incompleteVoicePack
            }
            try Self.applyLockedPlaybackProtection(to: Self.voicePackDirectory)
            setVoicePackState(.ready)
        } catch is CancellationError {
            return
        } catch {
            await offlineSpeech.unload()
            setVoicePackState(.installFailed(
                "Install did not finish. Retry on a stable connection. \(error.localizedDescription)"
            ))
        }
#endif
    }

    func removeVoicePack() async {
#if !targetEnvironment(simulator)
        stopSpeech()
        await offlineSpeech.unload()
        do {
            if FileManager.default.fileExists(atPath: Self.voicePackDirectory.path) {
                try FileManager.default.removeItem(at: Self.voicePackDirectory)
            }
            if FileManager.default.fileExists(atPath: Self.purgeableVoicePackDirectory.path) {
                try FileManager.default.removeItem(at: Self.purgeableVoicePackDirectory)
            }
            setVoicePackState(.notInstalled)
        } catch {
            setVoicePackState(.loadFailed(
                "Could not remove the voice pack. \(error.localizedDescription)"
            ))
        }
#endif
    }

    func speak(
        _ english: String,
        spanish: String? = nil,
        forceSystemVoice: Bool = false
    ) {
        stopListening()
        stopSpeech()
        let language = instructionLanguage
        let sourceText = language == .spanish ? (spanish ?? english) : english
        let text = applyPronunciationCorrections(to: sourceText)
        let speechID = UUID()
        activeSpeechID = speechID
        speechTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.activeSpeechID == speechID {
                    self.activeSpeechID = nil
                    self.speechTask = nil
                }
            }
            if self.voicePackState == .ready && !forceSystemVoice {
                let samples: [Float]
                do {
                    samples = try await self.offlineSpeech.synthesize(text: text, language: language)
                    try Task.checkCancellation()
                } catch is CancellationError {
                    return
                } catch {
                    await self.offlineSpeech.unload()
                    self.setVoicePackState(.loadFailed(
                        "Enhanced voice failed. Tap Retry to reload it."
                    ))
                    self.speakWithApple(text, language: language)
                    while self.synthesizer.isSpeaking, !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(50))
                    }
                    return
                }
                do {
                    try self.playOffline(samples: samples)
                    while self.offlinePlayer?.isPlaying == true, !Task.isCancelled {
                        try? await Task.sleep(for: .milliseconds(50))
                    }
                    return
                } catch is CancellationError {
                    return
                } catch {
                    // Playback routing can fail without invalidating the model.
                }
            }
            self.speakWithApple(text, language: language)
            while self.synthesizer.isSpeaking, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    @discardableResult
    func speakIfIdle(_ english: String, spanish: String? = nil) -> Bool {
        guard activeSpeechID == nil,
              recognitionTask == nil,
              !audioEngine.isRunning,
              !synthesizer.isSpeaking,
              offlinePlayer?.isPlaying != true else { return false }
        speak(english, spanish: spanish)
        return true
    }

    func speakAndWait(_ english: String, spanish: String? = nil) async {
        speak(english, spanish: spanish)
        let speechID = activeSpeechID
        while activeSpeechID == speechID, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    /// Plays only the installed enhanced voice and only after iOS has selected
    /// a Bluetooth output. This is the strict path used by a Watch tap while
    /// exactly one Meta camera session is connected. The bounded background
    /// lease covers CoreML synthesis before the audio background mode becomes
    /// effective, which is essential when the paired iPhone is locked.
    func speakEnhancedThroughBluetoothAndWait(
        _ english: String,
        spanish: String? = nil,
        deadline: Date? = nil
    ) async throws -> EnhancedVoicePlaybackResult {
        try Self.checkDeadline(deadline)
        let startedWhilePhoneBackgrounded = UIApplication.shared.applicationState != .active
        let backgroundLease = PhoneAudioBackgroundLease(
            name: "ClawPilot Watch instruction audio"
        )
        var playbackOwnershipTransferred = false
        var ownedSpeechID: UUID?
        defer {
            if !playbackOwnershipTransferred {
                backgroundLease.end()
                if let ownedSpeechID, activeSpeechID == ownedSpeechID {
                    strictPlaybackTask?.cancel()
                    strictPlaybackTask = nil
                    activeSpeechID = nil
                    offlinePlayer?.stop()
                    offlinePlayer = nil
                    try? AVAudioSession.sharedInstance().setActive(
                        false,
                        options: .notifyOthersOnDeactivation
                    )
                }
            }
        }

        stopListening()
        stopSpeech()
        if voicePackState != .ready {
            await prepareInstalledVoicePack()
        }
        guard voicePackState == .ready else {
            throw VoiceError.enhancedVoiceUnavailable
        }

        let language = instructionLanguage
        let sourceText = language == .spanish ? (spanish ?? english) : english
        let text = applyPronunciationCorrections(to: sourceText)
        let speechID = UUID()
        ownedSpeechID = speechID
        activeSpeechID = speechID

        try ensureEnhancedPlaybackAuthority(
            speechID: speechID,
            backgroundLease: backgroundLease,
            deadline: deadline
        )
        let samples: [Float]
        do {
            samples = try await offlineSpeech.synthesize(text: text, language: language)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            await offlineSpeech.unload()
            setVoicePackState(.loadFailed(
                "Enhanced voice failed. Tap Retry to reload it."
            ))
            throw error
        }
        try Task.checkCancellation()
        try ensureEnhancedPlaybackAuthority(
            speechID: speechID,
            backgroundLease: backgroundLease,
            deadline: deadline
        )

        let startedPlayback = try await playOfflineThroughBluetooth(
            samples: samples,
            speechID: speechID,
            backgroundLease: backgroundLease,
            deadline: deadline
        )
        try validateStartedBluetoothPlayback(
            startedPlayback,
            speechID: speechID,
            backgroundLease: backgroundLease,
            deadline: deadline
        )
        playbackOwnershipTransferred = true
        return EnhancedVoicePlaybackResult(
            outputName: startedPlayback.outputName,
            startedWhilePhoneBackgrounded: startedWhilePhoneBackgrounded,
            startedAt: startedPlayback.startedAt
        )
    }

    func listen(
        preferBluetoothInput: Bool,
        timeout: Duration? = nil,
        onTimeout: (@MainActor () -> Void)? = nil,
        onFinal: @escaping @MainActor (String) -> Void
    ) async throws {
        let speechStatus = await Self.requestSpeechAuthorization()
        guard speechStatus == .authorized else { throw VoiceError.permissionDenied }
        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else { throw VoiceError.permissionDenied }

        stopListening()
        stopSpeech()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        self.request = request
        recognitionFinalHandler = onFinal

        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
        if playbackPreference == .iPhoneSpeaker { options.insert(.defaultToSpeaker) }
        try session.setCategory(.playAndRecord, mode: .measurement, options: options)
        try session.setActive(true)
        if playbackPreference == .iPhoneSpeaker {
            if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try session.setPreferredInput(builtInMic)
            }
            try session.overrideOutputAudioPort(.speaker)
        } else {
            try session.overrideOutputAudioPort(.none)
            if preferBluetoothInput,
               let bluetooth = session.availableInputs?.first(where: { $0.portType == .bluetoothHFP }) {
                try session.setPreferredInput(bluetooth)
            }
        }
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            stopListening()
            throw VoiceError.microphoneUnavailable
        }
        let audioTapHandler: @Sendable (AVAudioPCMBuffer, AVAudioTime) -> Void = {
            buffer, _ in
            request.append(buffer)
        }
        input.installTap(
            onBus: 0,
            bufferSize: 1024,
            format: nil,
            block: audioTapHandler
        )
        inputTapInstalled = true
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            stopListening()
            throw error
        }
        let recognizer = SFSpeechRecognizer(
            locale: Locale(identifier: instructionLanguage.recognitionLocaleIdentifier)
        )
        let recognitionHandler: @Sendable (SFSpeechRecognitionResult?, Error?) -> Void = {
            [weak self] result, error in
            let transcript = result?.isFinal == true
                ? result?.bestTranscription.formattedString
                : nil
            guard transcript != nil || error != nil else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard let transcript else {
                    self.stopListening()
                    return
                }
                let onFinal = self.recognitionFinalHandler
                self.stopListening()
                onFinal?(transcript)
            }
        }
        recognitionTask = recognizer?.recognitionTask(
            with: request,
            resultHandler: recognitionHandler
        )
        if let timeout {
            recognitionTimeoutTask = Task { [weak self] in
                do {
                    try await Task.sleep(for: timeout)
                } catch {
                    return
                }
                guard let self else { return }
                self.stopListening()
                onTimeout?()
            }
        }
    }

    func stopListening() {
        recognitionTimeoutTask?.cancel()
        recognitionTimeoutTask = nil
        if audioEngine.isRunning { audioEngine.stop() }
        if inputTapInstalled {
            audioEngine.inputNode.removeTap(onBus: 0)
            inputTapInstalled = false
        }
        audioEngine.reset()
        request?.endAudio()
        recognitionTask?.cancel()
        request = nil
        recognitionTask = nil
        recognitionFinalHandler = nil
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }

    func routeDescription(metaConnected: Bool) -> String {
        let session = AVAudioSession.sharedInstance()
        let output = session.currentRoute.outputs.first
        if playbackPreference == .iPhoneSpeaker {
            return "iPhone speaker selected in App Settings."
        }
        guard let output else {
            return metaConnected
                ? "Meta glasses connected. Audio route will be selected when playback starts."
                : "Automatic audio uses the iPhone speaker when no accessory is connected."
        }
        switch output.portType {
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            return "Automatic audio is using \(output.portName)."
        case .builtInSpeaker:
            return metaConnected
                ? "Meta glasses are connected, but iOS currently routes audio to the iPhone speaker."
                : "Automatic audio is using the iPhone speaker."
        case .builtInReceiver:
            return "Audio is on the iPhone receiver; the next instruction will switch to speaker playback."
        default:
            return "Automatic audio is using \(output.portName)."
        }
    }

    private func stopSpeech() {
        let stoppedStrictBluetoothPlayback = strictPlaybackTask != nil
        strictPlaybackTask?.cancel()
        strictPlaybackTask = nil
        speechTask?.cancel()
        speechTask = nil
        activeSpeechID = nil
        offlinePlayer?.stop()
        offlinePlayer = nil
        synthesizer.stopSpeaking(at: .immediate)
        if stoppedStrictBluetoothPlayback {
            try? AVAudioSession.sharedInstance().setActive(
                false,
                options: .notifyOthersOnDeactivation
            )
        }
    }

    private func playOffline(samples: [Float]) throws {
        guard !samples.isEmpty else { throw VoiceError.emptyAudio }
        try configurePlaybackSession()
        let player = try AVAudioPlayer(data: Self.wavData(samples: samples, sampleRate: 44_100))
        player.prepareToPlay()
        guard player.play() else { throw VoiceError.playbackFailed }
        offlinePlayer = player
    }

    private struct StartedBluetoothPlayback {
        let player: AVAudioPlayer
        let outputName: String
        let outputUID: String
        let outputPortType: AVAudioSession.Port
        let startedAt: Date
    }

    private func playOfflineThroughBluetooth(
        samples: [Float],
        speechID: UUID,
        backgroundLease: PhoneAudioBackgroundLease,
        deadline: Date?
    ) async throws -> StartedBluetoothPlayback {
        guard !samples.isEmpty else { throw VoiceError.emptyAudio }
        let session = AVAudioSession.sharedInstance()
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        try session.setCategory(
            .playback,
            mode: .spokenAudio,
            options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
        )
        try session.setActive(true)

        // AVAudioSession may not settle an A2DP route until playback has begun.
        // Looping zero PCM primes that decision without exposing instruction
        // audio to the iPhone speaker while route authority is still unknown.
        let primer = try AVAudioPlayer(data: Self.bluetoothRoutePrimerData)
        primer.numberOfLoops = -1
        primer.prepareToPlay()
        guard primer.play() else { throw VoiceError.playbackFailed }
        defer { primer.stop() }

        let routeDeadline = Date().addingTimeInterval(3)
        var bluetoothOutput: AVAudioSessionPortDescription?
        while Date() < routeDeadline {
            try Task.checkCancellation()
            try ensureEnhancedPlaybackAuthority(
                speechID: speechID,
                backgroundLease: backgroundLease,
                deadline: deadline
            )
            if let output = session.currentRoute.outputs.first(where: Self.isBluetoothOutput) {
                bluetoothOutput = output
                break
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        guard let bluetoothOutput else {
            let current = session.currentRoute.outputs.first?.portName ?? "no active output"
            throw VoiceError.bluetoothRouteUnavailable(current)
        }

        let player = try AVAudioPlayer(data: Self.wavData(samples: samples, sampleRate: 44_100))
        player.prepareToPlay()
        try ensureEnhancedPlaybackAuthority(
            speechID: speechID,
            backgroundLease: backgroundLease,
            deadline: deadline
        )
        guard Self.isBluetoothOutputStillCurrent(bluetoothOutput, session: session) else {
            let current = session.currentRoute.outputs.first?.portName ?? "no active output"
            throw VoiceError.bluetoothRouteUnavailable(current)
        }
        try Task.checkCancellation()
        guard player.play() else { throw VoiceError.playbackFailed }
        let startedAt = Date()
        guard deadline.map({ startedAt < $0 }) ?? true else {
            player.stop()
            throw VoiceError.commandExpired
        }
        guard let startedOutput = session.currentRoute.outputs.first(where: {
            Self.isBluetoothOutput($0)
                && $0.uid == bluetoothOutput.uid
                && $0.portType == bluetoothOutput.portType
        })
        else {
            player.stop()
            let current = session.currentRoute.outputs.first?.portName ?? "no active output"
            throw VoiceError.bluetoothRouteUnavailable(current)
        }
        offlinePlayer = player
        let startedPlayback = StartedBluetoothPlayback(
            player: player,
            outputName: startedOutput.portName,
            outputUID: startedOutput.uid,
            outputPortType: startedOutput.portType,
            startedAt: startedAt
        )
        startStrictPlaybackMonitor(
            startedPlayback,
            speechID: speechID,
            backgroundLease: backgroundLease
        )
        return startedPlayback
    }

    private func validateStartedBluetoothPlayback(
        _ playback: StartedBluetoothPlayback,
        speechID: UUID,
        backgroundLease: PhoneAudioBackgroundLease,
        deadline: Date?
    ) throws {
        guard !backgroundLease.expired,
              activeSpeechID == speechID,
              offlinePlayer === playback.player,
              playback.player.isPlaying,
              deadline.map({ playback.startedAt < $0 }) ?? true,
              Self.isBluetoothOutputStillCurrent(
                uid: playback.outputUID,
                portType: playback.outputPortType,
                session: AVAudioSession.sharedInstance()
              ) else {
            throw VoiceError.playbackInterrupted
        }
    }

    private func startStrictPlaybackMonitor(
        _ playback: StartedBluetoothPlayback,
        speechID: UUID,
        backgroundLease: PhoneAudioBackgroundLease
    ) {
        strictPlaybackTask?.cancel()
        strictPlaybackTask = Task { @MainActor [weak self, weak player = playback.player] in
            guard let self, let player else {
                backgroundLease.end()
                return
            }
            defer {
                let ownedAudioSession = self.offlinePlayer === player
                    || self.activeSpeechID == speechID
                player.stop()
                if self.offlinePlayer === player {
                    self.offlinePlayer = nil
                }
                if self.activeSpeechID == speechID {
                    self.activeSpeechID = nil
                    self.strictPlaybackTask = nil
                }
                backgroundLease.end()
                if ownedAudioSession {
                    try? AVAudioSession.sharedInstance().setActive(
                        false,
                        options: .notifyOthersOnDeactivation
                    )
                }
            }

            while player.isPlaying {
                guard !Task.isCancelled,
                      !backgroundLease.expired,
                      self.activeSpeechID == speechID,
                      self.offlinePlayer === player,
                      Self.isBluetoothOutputStillCurrent(
                        uid: playback.outputUID,
                        portType: playback.outputPortType,
                        session: AVAudioSession.sharedInstance()
                      ) else {
                    return
                }
                try? await Task.sleep(for: .milliseconds(50))
            }
        }
    }

    private func ensureEnhancedPlaybackAuthority(
        speechID: UUID,
        backgroundLease: PhoneAudioBackgroundLease,
        deadline: Date?
    ) throws {
        try Self.checkDeadline(deadline)
        guard !backgroundLease.expired else { throw VoiceError.backgroundTimeExpired }
        guard activeSpeechID == speechID else { throw VoiceError.playbackInterrupted }
    }

    private static func checkDeadline(_ deadline: Date?) throws {
        guard deadline.map({ Date() < $0 }) ?? true else { throw VoiceError.commandExpired }
    }

    private static func isBluetoothOutputStillCurrent(
        _ expected: AVAudioSessionPortDescription,
        session: AVAudioSession
    ) -> Bool {
        isBluetoothOutputStillCurrent(
            uid: expected.uid,
            portType: expected.portType,
            session: session
        )
    }

    private static func isBluetoothOutputStillCurrent(
        uid: String,
        portType: AVAudioSession.Port,
        session: AVAudioSession
    ) -> Bool {
        session.currentRoute.outputs.contains {
            isBluetoothOutput($0)
                && $0.uid == uid
                && $0.portType == portType
        }
    }

    private static func isBluetoothOutput(_ output: AVAudioSessionPortDescription) -> Bool {
        switch output.portType {
        case .bluetoothA2DP, .bluetoothHFP, .bluetoothLE:
            true
        default:
            false
        }
    }

    private static let bluetoothRoutePrimerData = wavData(
        samples: [Float](repeating: 0, count: 4_410),
        sampleRate: 44_100
    )

    private func speakWithApple(_ text: String, language: InstructionVoiceLanguage) {
        try? configurePlaybackSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = selectedAppleVoice(language: language)
        utterance.rate = 0.48
        utterance.pitchMultiplier = 1.0
        utterance.preUtteranceDelay = 0.05
        utterance.postUtteranceDelay = 0.08
        synthesizer.speak(utterance)
    }

    private func configurePlaybackSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        switch playbackPreference {
        case .automatic:
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.duckOthers, .interruptSpokenAudioAndMixWithOthers]
            )
        case .iPhoneSpeaker:
            try session.setCategory(
                .playAndRecord,
                mode: .default,
                options: [.defaultToSpeaker, .allowBluetoothHFP, .allowBluetoothA2DP]
            )
        }
        try session.setActive(true)
        if playbackPreference == .iPhoneSpeaker {
            try session.overrideOutputAudioPort(.speaker)
        }
    }

    private func selectedAppleVoice(language: InstructionVoiceLanguage) -> AVSpeechSynthesisVoice? {
        let locale = language.recognitionLocaleIdentifier
        let systemVoice = AVSpeechSynthesisVoice(language: locale)
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == locale }
        let preferredNames = ["Ava", "Zoe", "Samantha", "Nicky", "Allison"]
        let localizedPreferredNames = language == .english
            ? preferredNames
            : ["Paulina", "Mónica", "Monica"]
        let highQualityVoices = voices.filter {
            $0.quality != .default && $0.identifier != systemVoice?.identifier
        }
        for name in localizedPreferredNames {
            if let match = highQualityVoices
                .filter({ $0.name.caseInsensitiveCompare(name) == .orderedSame })
                .max(by: { $0.quality.rawValue < $1.quality.rawValue }) {
                return match
            }
        }
        return highQualityVoices
            .sorted {
                if $0.gender != $1.gender { return $0.gender == .female }
                return $0.quality.rawValue > $1.quality.rawValue
            }
            .first ?? systemVoice
    }

    private func applyPronunciationCorrections(to text: String) -> String {
        pronunciationCorrections.reduce(text) { result, correction in
            result.replacingOccurrences(
                of: correction.written,
                with: correction.spoken,
                options: [.caseInsensitive]
            )
        }
    }

    private func savePronunciationCorrections(_ corrections: [PronunciationCorrection]) {
        guard let data = try? JSONEncoder().encode(corrections) else { return }
        UserDefaults.standard.set(data, forKey: Self.pronunciationDefaultsKey)
    }

    private func setVoicePackState(_ state: OfflineVoicePackState) {
        voicePackState = state
        onVoicePackStateChange?(state)
    }

    nonisolated private static func requestSpeechAuthorization() async
        -> SFSpeechRecognizerAuthorizationStatus
    {
        await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
    }

    private static var voicePackDirectory: URL {
        // SpeechSwift's Hub downloader expects a <base>/models/<organization>/<model>
        // layout. Application Support is intentional: iOS may purge Library/Caches,
        // but this user-installed offline model must survive routine storage cleanup.
        voicePackStorageRoot
            .appendingPathComponent("ClawPilotPicking", isDirectory: true)
            .appendingPathComponent("models", isDirectory: true)
            .appendingPathComponent("aufklarer", isDirectory: true)
            .appendingPathComponent("Supertonic-3-CoreML-FP16", isDirectory: true)
    }

    private static var purgeableVoicePackDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClawPilotPicking", isDirectory: true)
            .appendingPathComponent("models", isDirectory: true)
            .appendingPathComponent("aufklarer", isDirectory: true)
            .appendingPathComponent("Supertonic-3-CoreML-FP16", isDirectory: true)
    }

    private static var voicePackStorageRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    }

    private static var legacyKokoroDirectory: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("ClawPilotPicking", isDirectory: true)
            .appendingPathComponent("models", isDirectory: true)
            .appendingPathComponent("aufklarer", isDirectory: true)
            .appendingPathComponent("Kokoro-82M-CoreML-INT8", isDirectory: true)
    }

    private static func preparePersistentVoicePackStorage() throws {
        let root = voicePackDirectory
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: lockedPlaybackAttributes
        )
        try FileManager.default.setAttributes(
            lockedPlaybackAttributes,
            ofItemAtPath: root.path
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var mutableRoot = root
        try mutableRoot.setResourceValues(values)

        if isVoicePackInstalled(at: purgeableVoicePackDirectory) {
            if isVoicePackInstalled(at: voicePackDirectory) {
                try? FileManager.default.removeItem(at: purgeableVoicePackDirectory)
            } else {
                if FileManager.default.fileExists(atPath: voicePackDirectory.path) {
                    try FileManager.default.removeItem(at: voicePackDirectory)
                }
                try FileManager.default.createDirectory(
                    at: voicePackDirectory.deletingLastPathComponent(),
                    withIntermediateDirectories: true,
                    attributes: lockedPlaybackAttributes
                )
                try FileManager.default.moveItem(
                    at: purgeableVoicePackDirectory,
                    to: voicePackDirectory
                )
            }
        }
        try applyLockedPlaybackProtection(to: voicePackDirectory)
    }

    private static let lockedPlaybackAttributes: [FileAttributeKey: Any] = [
        .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication,
    ]

    private static func applyLockedPlaybackProtection(to directory: URL) throws {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.setAttributes(
            lockedPlaybackAttributes,
            ofItemAtPath: directory.path
        )
        guard let contents = fileManager.enumerator(
            at: directory,
            includingPropertiesForKeys: nil,
            options: []
        ) else { throw VoiceError.voicePackProtectionUnavailable }
        for case let url as URL in contents {
            try fileManager.setAttributes(
                lockedPlaybackAttributes,
                ofItemAtPath: url.path
            )
        }
    }

    private static var isVoicePackInstalled: Bool {
        isVoicePackInstalled(at: voicePackDirectory)
    }

    private static func isVoicePackInstalled(at directory: URL) -> Bool {
        let requiredSizes: [String: UInt64] = [
            "DurationPredictor.mlpackage/Data/com.apple.CoreML/model.mlmodel": 93_496,
            "DurationPredictor.mlpackage/Data/com.apple.CoreML/weights/weight.bin": 1_797_952,
            "DurationPredictor.mlpackage/Manifest.json": 617,
            "TextEncoder.mlpackage/Data/com.apple.CoreML/model.mlmodel": 128_982,
            "TextEncoder.mlpackage/Data/com.apple.CoreML/weights/weight.bin": 36_035_200,
            "TextEncoder.mlpackage/Manifest.json": 617,
            "VectorEstimator.mlpackage/Data/com.apple.CoreML/model.mlmodel": 289_258,
            "VectorEstimator.mlpackage/Data/com.apple.CoreML/weights/weight.bin": 255_276_032,
            "VectorEstimator.mlpackage/Manifest.json": 617,
            "Vocoder.mlpackage/Data/com.apple.CoreML/model.mlmodel": 70_697,
            "Vocoder.mlpackage/Data/com.apple.CoreML/weights/weight.bin": 50_672_512,
            "Vocoder.mlpackage/Manifest.json": 617,
            "tts.json": 8_253,
            "unicode_indexer.json": 277_676,
            "voice_styles/F1.json": 292_046,
            "voice_styles/F2.json": 292_423,
        ]
        return requiredSizes.allSatisfy { relativePath, expectedSize in
            let url = directory.appendingPathComponent(relativePath)
            guard let attributes = try? FileManager.default.attributesOfItem(atPath: url.path),
                  let fileSize = attributes[.size] as? NSNumber
            else { return false }
            return fileSize.uint64Value == expectedSize
        }
    }

    private static func wavData(samples: [Float], sampleRate: UInt32) -> Data {
        let pcm = samples.map { sample -> Int16 in
            let clamped = min(max(sample, -1), 1)
            return Int16((clamped * Float(Int16.max)).rounded())
        }
        let dataSize = UInt32(pcm.count * MemoryLayout<Int16>.size)
        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        appendLittleEndian(36 + dataSize, to: &data)
        data.append(contentsOf: Array("WAVEfmt ".utf8))
        appendLittleEndian(UInt32(16), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(UInt16(1), to: &data)
        appendLittleEndian(sampleRate, to: &data)
        appendLittleEndian(sampleRate * 2, to: &data)
        appendLittleEndian(UInt16(2), to: &data)
        appendLittleEndian(UInt16(16), to: &data)
        data.append(contentsOf: Array("data".utf8))
        appendLittleEndian(dataSize, to: &data)
        pcm.withUnsafeBytes { data.append(contentsOf: $0) }
        return data
    }

    private static func appendLittleEndian<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    enum VoiceError: LocalizedError {
        case permissionDenied
        case emptyAudio
        case playbackFailed
        case incompleteVoicePack
        case voicePackProtectionUnavailable
        case microphoneUnavailable
        case enhancedVoiceUnavailable
        case bluetoothRouteUnavailable(String)
        case backgroundTimeExpired
        case playbackInterrupted
        case commandExpired

        var errorDescription: String? {
            switch self {
            case .permissionDenied:
                "Allow Speech Recognition and Microphone access to use pick commands."
            case .emptyAudio:
                "The enhanced voice returned no audio."
            case .playbackFailed:
                "The enhanced voice audio player could not start."
            case .incompleteVoicePack:
                "The downloaded voice pack is incomplete or failed validation."
            case .voicePackProtectionUnavailable:
                "The voice pack protection metadata could not be applied."
            case .microphoneUnavailable:
                "The microphone is not ready. Reconnect the audio device and try again."
            case .enhancedVoiceUnavailable:
                "The enhanced iPhone voice pack is not ready."
            case .bluetoothRouteUnavailable(let current):
                "iOS did not select Bluetooth audio; the current output is \(current)."
            case .backgroundTimeExpired:
                "The locked iPhone did not have enough background time to prepare the instruction."
            case .playbackInterrupted:
                "Instruction playback was interrupted before it completed."
            case .commandExpired:
                "The Watch audio request expired."
            }
        }
    }
}
