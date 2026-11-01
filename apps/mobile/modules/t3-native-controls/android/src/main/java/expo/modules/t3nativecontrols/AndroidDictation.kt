package expo.modules.t3nativecontrols

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer

/** Each utterance gets a new listener; callbacks from destroyed recognizers are ignored. */
class AndroidDictation(
  private val activity: Activity,
  val sessionId: Int,
  private val emit: (Map<String, Any>) -> Unit
) {
  private val handler = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var generation = 0
  private var ended = false
  private var stopping = false
  private var listening = false

  private fun event(type: String, vararg values: Pair<String, Any>) {
    emit(mapOf("sessionId" to sessionId, "type" to type, *values))
  }

  fun start() {
    check(activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
      "Microphone permission is required."
    }
    check(SpeechRecognizer.isRecognitionAvailable(activity)) { "Speech recognition is unavailable on this device." }
    listen()
  }

  private fun finish(error: String? = null) {
    if (ended) return
    ended = true
    generation++
    handler.removeCallbacksAndMessages(null)
    recognizer?.cancel()
    recognizer?.destroy()
    recognizer = null
    if (error != null) event("error", "message" to error)
    event("end")
  }

  fun cancel() = finish()

  fun stop() {
    if (ended || stopping) return
    stopping = true
    if (!listening) { finish(); return }
    recognizer?.stopListening()
    // Some services never deliver a terminal callback after stop.
    handler.postDelayed({ finish("Speech recognition did not finish. Please try again.") }, 5000)
  }

  private fun next() {
    listening = false
    if (stopping) { finish(); return }
    event("level", "level" to 0.0)
    handler.postDelayed({ if (!ended && !stopping) listen() }, 250)
  }

  private fun listen() {
    if (ended || stopping) return
    val token = ++generation
    recognizer?.destroy()
    try {
      val service = SpeechRecognizer.createSpeechRecognizer(activity)
      recognizer = service
      service.setRecognitionListener(object : RecognitionListener {
        private fun current() = !ended && token == generation
        override fun onReadyForSpeech(params: Bundle?) { if (current()) event("ready") }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) {
          if (current()) event("level", "level" to ((rmsdB + 2) / 12).coerceIn(0f, 1f).toDouble())
        }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() { if (current()) event("level", "level" to 0.0) }
        override fun onPartialResults(results: Bundle?) {
          if (current()) event("partial", "text" to text(results))
        }
        override fun onResults(results: Bundle?) {
          if (!current()) return
          generation++
          event("final", "text" to text(results))
          next()
        }
        override fun onError(error: Int) {
          if (!current()) return
          generation++
          if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
            event("partial", "text" to "")
            next()
          } else finish("Speech recognition failed (Android error $error). Check microphone permission, speech services and connection.")
        }
        override fun onEvent(eventType: Int, params: Bundle?) {}
      })
      listening = true
      service.startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      })
    } catch (error: Exception) {
      finish(error.message ?: "Speech recognition could not start.")
    }
  }

  private fun text(results: Bundle?) = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: ""
}
