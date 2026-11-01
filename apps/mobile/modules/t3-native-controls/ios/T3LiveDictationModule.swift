import AVFoundation
import ExpoModulesCore
import Speech
import UIKit

/// Audio stays in memory. On-device recognition is required; no server fallback.
public final class T3LiveDictationModule: Module {
  private var session: Int?
  private var engine: AVAudioEngine?
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var timer: DispatchWorkItem?
  private var deadline: DispatchWorkItem?
  private var observers: [NSObjectProtocol] = []
  private var segment = 0
  private var committed = ""
  private var partial = ""
  private var finishing = false
  private var rotating = false
  private var audioActive = false
  private var audioHandoff: DictationAudioHandoff?

  public func definition() -> ModuleDefinition {
    Name("T3LiveDictation")
    Events("onDictation")
    AsyncFunction("startDictation") { (id: Int, promise: Promise) in
      DispatchQueue.main.async { self.start(id, promise: promise) }
    }
    Function("stopDictation") { (id: Int) in
      DispatchQueue.main.async {
        guard self.session == id, !self.finishing else { return }
        self.finishing = true
        self.drain()
      }
    }
    Function("cancelDictation") { (id: Int) in
      DispatchQueue.main.async {
        guard self.session == id else { return }
        self.end("cancelled")
      }
    }
    OnDestroy {
      DispatchQueue.main.async { self.end("cancelled") }
    }
  }

  private func emit(_ type: String, _ fields: [String: Any] = [:]) {
    guard let id = session else { return }
    var payload = fields
    payload["sessionId"] = id
    payload["type"] = type
    sendEvent("onDictation", payload)
  }

  private var text: String {
    [committed, partial].filter { !$0.isEmpty }.joined(separator: " ")
  }

  private func start(_ id: Int, promise: Promise) {
    guard session == nil else {
      promise.reject("ERR_DICTATION_BUSY", "A dictation session is already active")
      return
    }
    guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil,
          Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") != nil else {
      promise.reject("ERR_DICTATION_CONFIG", "Speech and microphone usage descriptions are required")
      return
    }
    session = id
    committed = ""
    partial = ""
    finishing = false
    SFSpeechRecognizer.requestAuthorization { status in
      DispatchQueue.main.async {
        guard self.session == id, !self.finishing else {
          promise.reject("ERR_DICTATION_CANCELLED", "Dictation start cancelled")
          return
        }
        guard status == .authorized else {
          self.end("permissionDenied")
          promise.reject("ERR_SPEECH_PERMISSION", "Speech recognition permission denied")
          return
        }
        AVAudioSession.sharedInstance().requestRecordPermission { allowed in
          DispatchQueue.main.async {
            guard self.session == id, !self.finishing else {
              promise.reject("ERR_DICTATION_CANCELLED", "Dictation start cancelled")
              return
            }
            guard allowed else {
              self.end("permissionDenied")
              promise.reject("ERR_MIC_PERMISSION", "Microphone permission denied")
              return
            }
            let speech = SFSpeechRecognizer(locale: Locale.current)
            guard let speech, speech.isAvailable, speech.supportsOnDeviceRecognition else {
              self.end("unavailable")
              promise.reject("ERR_SPEECH_UNAVAILABLE", "On-device speech recognition is unavailable for this locale")
              return
            }
            self.recognizer = speech
            do {
              let audio = AVAudioSession.sharedInstance()
              try audio.setCategory(.record, mode: .measurement, options: [.duckOthers])
              try audio.setActive(true)
              self.audioActive = true
              self.observeInterruptions()
              try self.beginSegment()
              self.emit("ready")
              promise.resolve(nil)
            } catch {
              self.fail()
              promise.reject("ERR_DICTATION_START", "Unable to start microphone recognition")
            }
          }
        }
      }
    }
  }

  private func observeInterruptions() {
    for name in [AVAudioSession.interruptionNotification, AVAudioSession.routeChangeNotification,
                 UIApplication.didEnterBackgroundNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
        self?.end("interrupted")
      })
    }
  }

  private func beginSegment() throws {
    guard let id = session else { return }
    segment += 1
    let generation = segment
    rotating = false
    partial = ""
    let nextRequest = SFSpeechAudioBufferRecognitionRequest()
    nextRequest.shouldReportPartialResults = true
    nextRequest.requiresOnDeviceRecognition = true
    nextRequest.taskHint = .dictation
    request = nextRequest
    let handoff = audioHandoff ?? DictationAudioHandoff()
    audioHandoff = handoff
    guard handoff.attach(nextRequest) else {
      throw NSError(domain: "T3LiveDictation", code: 2)
    }
    if engine == nil && !finishing {
      let nextEngine = AVAudioEngine()
      let input = nextEngine.inputNode
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        throw NSError(domain: "T3LiveDictation", code: 1)
      }
      var frames = 0
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        handoff.append(buffer)
        frames += Int(buffer.frameLength)
        guard frames >= Int(format.sampleRate / 10), let samples = buffer.floatChannelData?[0] else { return }
        frames = 0
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) { sum += samples[index] * samples[index] }
        let rms = sqrt(sum / Float(max(1, buffer.frameLength)))
        let level = Double(max(0, min(1, (20 * log10(max(rms, 0.00001)) + 60) / 60)))
        DispatchQueue.main.async {
          guard let self, self.session == id, self.audioHandoff === handoff, !self.finishing else { return }
          self.emit("level", ["level": level])
        }
      }
      engine = nextEngine
      nextEngine.prepare()
      try nextEngine.start()
    }
    task = recognizer?.recognitionTask(with: nextRequest) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self, self.session == id, self.segment == generation else { return }
        if let result {
          self.partial = result.bestTranscription.formattedString
          self.emit("partial", ["text": self.text])
        }
        if result?.isFinal == true {
          self.completeSegment()
        } else if error != nil {
          // A deliberate endAudio may finish with an error after delivering partial words.
          if self.finishing || self.rotating { self.completeSegment() } else { self.fail() }
        }
      }
    }
    if finishing {
      drain()
      return
    }
    let rotation = DispatchWorkItem { [weak self] in
      guard let self, self.session == id, self.segment == generation,
            !self.rotating, !self.finishing else { return }
      self.rotating = true
      self.drain()
    }
    timer = rotation
    DispatchQueue.main.asyncAfter(deadline: .now() + 50, execute: rotation)
  }

  private func stopAudio() {
    if let engine {
      engine.stop()
      engine.inputNode.removeTap(onBus: 0)
    }
    engine = nil
  }

  private func drain() {
    timer?.cancel()
    if finishing { stopAudio() }
    // Detach and end under the same lock used by the audio tap. Capture continues
    // into owned PCM copies while this segment delivers its last words.
    audioHandoff?.beginHandoff()
    deadline?.cancel()
    guard let id = session else { return }
    let generation = segment
    let timeout = DispatchWorkItem { [weak self] in
      guard let self, self.session == id, self.segment == generation else { return }
      self.completeSegment()
    }
    deadline = timeout
    DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: timeout)
  }

  private func completeSegment() {
    audioHandoff?.beginHandoff()
    committed = text
    partial = ""
    segment += 1 // Invalidate callbacks before cancelling the old task.
    timer?.cancel()
    deadline?.cancel()
    task?.cancel()
    task = nil
    request = nil
    guard audioHandoff?.failed != true else { fail(); return }
    if finishing && audioHandoff?.hasPendingAudio != true {
      emit("final", ["text": committed])
      end("finished")
    } else {
      emit("partial", ["text": committed])
      do { try beginSegment() } catch { fail() }
    }
  }

  private func fail() {
    emit("error", ["message": "Speech recognition stopped. Available words have been retained.", "text": text])
    end("error")
  }

  private func end(_ reason: String) {
    guard session != nil else { return }
    emit("end", ["reason": reason])
    session = nil
    segment += 1
    timer?.cancel()
    deadline?.cancel()
    timer = nil
    deadline = nil
    stopAudio()
    audioHandoff?.clear()
    audioHandoff = nil
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    recognizer = nil
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers.removeAll()
    if audioActive {
      try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
      audioActive = false
    }
    committed = ""
    partial = ""
  }
}

/// Serializes tap delivery with endAudio/replay. Only the short segment handoff
/// retains audio, never files. Tap buffers must be copied: AVAudioEngine reuses them.
private final class DictationAudioHandoff {
  private let lock = NSLock()
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var pending: [AVAudioPCMBuffer] = []
  private var seconds: Double = 0
  private var bytes = 0
  private var overflow = false
  private var closed = false

  var failed: Bool {
    lock.lock()
    defer { lock.unlock() }
    return overflow
  }

  var hasPendingAudio: Bool {
    lock.lock()
    defer { lock.unlock() }
    return !pending.isEmpty
  }

  func append(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, !overflow else { return }
    if let request {
      request.append(buffer)
      return
    }
    let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
    let size = source.reduce(0) { $0 + Int($1.mDataByteSize) }
    let duration = Double(buffer.frameLength) / buffer.format.sampleRate
    guard seconds + duration <= 4, bytes + size <= 4 * 1024 * 1024,
          let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
      overflow = true
      return
    }
    copy.frameLength = buffer.frameLength
    let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    for index in 0..<source.count {
      guard let from = source[index].mData, let to = destination[index].mData else {
        overflow = true
        return
      }
      memcpy(to, from, Int(source[index].mDataByteSize))
    }
    pending.append(copy)
    seconds += duration
    bytes += size
  }

  func beginHandoff() {
    lock.lock()
    defer { lock.unlock() }
    request?.endAudio()
    request = nil
  }

  func attach(_ next: SFSpeechAudioBufferRecognitionRequest) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !closed, !overflow else { return false }
    // Replay before exposing the request to the tap, preserving audio order.
    for buffer in pending { next.append(buffer) }
    pending.removeAll(keepingCapacity: false)
    seconds = 0
    bytes = 0
    request = next
    return true
  }

  func clear() {
    lock.lock()
    defer { lock.unlock() }
    closed = true
    request = nil
    pending.removeAll(keepingCapacity: false)
    seconds = 0
    bytes = 0
  }
}
