@preconcurrency import AVFoundation
@preconcurrency import Speech
import Foundation

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

@MainActor
final class VoiceConfirmationController {
    private let synthesizer = AVSpeechSynthesizer()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var recognitionTimeoutTask: Task<Void, Never>?

    init() {
        UserDefaults.standard.register(defaults: [
            AudioPlaybackPreference.defaultsKey: AudioPlaybackPreference.automatic.rawValue,
        ])
    }

    var playbackPreference: AudioPlaybackPreference {
        AudioPlaybackPreference(
            rawValue: UserDefaults.standard.string(
                forKey: AudioPlaybackPreference.defaultsKey
            ) ?? ""
        ) ?? .automatic
    }

    func speak(_ text: String) {
        stopListening()
        synthesizer.stopSpeaking(at: .immediate)
        try? configurePlaybackSession()
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = selectedVoice()
        utterance.rate = 0.48
        utterance.pitchMultiplier = 1.0
        utterance.preUtteranceDelay = 0.05
        utterance.postUtteranceDelay = 0.08
        synthesizer.speak(utterance)
    }

    func speakAndWait(_ text: String) async {
        speak(text)
        while synthesizer.isSpeaking, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(50))
        }
    }

    func listen(
        preferBluetoothInput: Bool,
        timeout: Duration? = nil,
        onTimeout: (@MainActor () -> Void)? = nil,
        onFinal: @escaping @MainActor (String) -> Void
    ) async throws {
        let speechStatus = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speechStatus == .authorized else { throw VoiceError.permissionDenied }
        let granted = await AVAudioApplication.requestRecordPermission()
        guard granted else { throw VoiceError.permissionDenied }

        stopListening()
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = false
        self.request = request

        let session = AVAudioSession.sharedInstance()
        var options: AVAudioSession.CategoryOptions = [.allowBluetoothHFP, .allowBluetoothA2DP]
        if playbackPreference == .iPhoneSpeaker { options.insert(.defaultToSpeaker) }
        try session.setCategory(.playAndRecord, mode: .measurement, options: options)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
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
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, when in
            request.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let result, result.isFinal else {
                if error != nil { Task { @MainActor in self?.stopListening() } }
                return
            }
            let transcript = result.bestTranscription.formattedString
            Task { @MainActor in
                self?.stopListening()
                onFinal(transcript)
            }
        }
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
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
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

    private func configurePlaybackSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setActive(false, options: .notifyOthersOnDeactivation)
        switch playbackPreference {
        case .automatic:
            // Playback routes to Bluetooth A2DP automatically and to the loudspeaker
            // rather than the receiver when no accessory is active.
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
        try session.setActive(true, options: .notifyOthersOnDeactivation)
        if playbackPreference == .iPhoneSpeaker {
            try session.overrideOutputAudioPort(.speaker)
        }
    }

    private func selectedVoice() -> AVSpeechSynthesisVoice? {
        let systemVoice = AVSpeechSynthesisVoice(language: "en-US")
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-US" }
        let preferredNames = ["Ava", "Zoe", "Samantha", "Nicky", "Allison"]
        let highQualityVoices = voices.filter {
            $0.quality != .default && $0.identifier != systemVoice?.identifier
        }

        // Never replace the system voice with a compact alternate. Compact
        // voices are audibly robotic; an alternate is acceptable only when an
        // enhanced or premium asset is actually installed on the iPhone.
        for name in preferredNames {
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

    enum VoiceError: LocalizedError {
        case permissionDenied

        var errorDescription: String? {
            "Allow Speech Recognition and Microphone access to use pick commands."
        }
    }
}
