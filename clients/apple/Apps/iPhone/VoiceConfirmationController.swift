@preconcurrency import AVFoundation
@preconcurrency import Speech
import Foundation

@MainActor
final class VoiceConfirmationController {
    private let synthesizer = AVSpeechSynthesizer()
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func speak(_ text: String) {
        stopListening()
        synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = 0.48
        synthesizer.speak(utterance)
    }

    func listen(onFinal: @escaping @MainActor (String) -> Void) async throws {
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
        try session.setCategory(.record, mode: .measurement, options: [.allowBluetoothHFP])
        try session.setActive(true, options: .notifyOthersOnDeactivation)
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
    }

    func stopListening() {
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

    enum VoiceError: Error { case permissionDenied }
}

