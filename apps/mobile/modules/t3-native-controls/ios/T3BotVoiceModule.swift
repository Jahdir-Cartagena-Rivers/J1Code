import AVFoundation
import ExpoModulesCore

public final class T3BotVoiceModule: Module, AVSpeechSynthesizerDelegate {
  private let synthesizer = AVSpeechSynthesizer()
  private var utteranceSessions: [ObjectIdentifier: String] = [:]

  public func definition() -> ModuleDefinition {
    Name("T3BotVoice")
    Events("onBotVoice")
    OnCreate { self.synthesizer.delegate = self }
    AsyncFunction("voices") { (promise: Promise) in
      DispatchQueue.main.async {
        promise.resolve(AVSpeechSynthesisVoice.speechVoices().map {
          ["id": $0.identifier, "name": $0.name, "language": $0.language]
        })
      }
    }
    AsyncFunction("speak") { (text: String, voiceId: String?, sessionId: String, promise: Promise) in
      DispatchQueue.main.async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
          promise.reject("ERR_VOICE_EMPTY", "Nothing to speak")
          return
        }
        self.synthesizer.stopSpeaking(at: .immediate)
        let utterance = AVSpeechUtterance(string: text)
        if let voiceId, let selected = AVSpeechSynthesisVoice(identifier: voiceId) { utterance.voice = selected }
        self.utteranceSessions[ObjectIdentifier(utterance)] = sessionId
        self.synthesizer.speak(utterance)
        promise.resolve(nil)
      }
    }
    Function("stop") {
      DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate) }
    }
    OnDestroy {
      DispatchQueue.main.async { self.synthesizer.stopSpeaking(at: .immediate); self.utteranceSessions.removeAll() }
    }
  }

  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    emitEnd(utterance, type: "end")
  }
  public func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    emitEnd(utterance, type: "cancelled")
  }
  private func emitEnd(_ utterance: AVSpeechUtterance, type: String) {
    guard let session = utteranceSessions.removeValue(forKey: ObjectIdentifier(utterance)) else { return }
    sendEvent("onBotVoice", ["sessionId": session, "type": type])
  }
}
