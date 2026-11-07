package expo.modules.t3nativecontrols

import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class T3BotVoiceModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private var engine: TextToSpeech? = null
  private var ready = false
  private val pending = mutableListOf<(TextToSpeech?) -> Unit>()
  private var activeSession: String? = null
  private var generation = 0

  override fun definition() = ModuleDefinition {
    Name("T3BotVoice")
    Events("onBotVoice")
    AsyncFunction("voices") { promise: Promise ->
      main.post { withEngine { tts ->
        if (tts == null) promise.reject("ERR_VOICE_UNAVAILABLE", "Speech engine unavailable", null)
        else promise.resolve(tts.voices.orEmpty().map { mapOf("id" to it.name, "name" to it.name, "language" to it.locale.toLanguageTag()) })
      } }
    }
    AsyncFunction("speak") { text: String, voiceId: String?, sessionId: String, promise: Promise ->
      main.post {
        val requestedGeneration = ++generation
        withEngine { tts ->
        if (requestedGeneration != generation) { promise.reject("ERR_VOICE_CANCELLED", "Speech was cancelled", null); return@withEngine }
        if (tts == null) { promise.reject("ERR_VOICE_UNAVAILABLE", "Speech engine unavailable", null); return@withEngine }
        if (text.isBlank()) { promise.reject("ERR_VOICE_EMPTY", "Nothing to speak", null); return@withEngine }
        tts.stop()
        activeSession = sessionId
        val voice = tts.voices?.firstOrNull { it.name == voiceId } ?: tts.defaultVoice
        if (voice != null) tts.voice = voice
        val limit = (TextToSpeech.getMaxSpeechInputLength() - 10).coerceAtLeast(1)
        var start = 0
        var index = 0
        while (start < text.length) {
          var end = (start + limit).coerceAtMost(text.length)
          if (end < text.length && Character.isHighSurrogate(text[end - 1]) && Character.isLowSurrogate(text[end])) end--
          val last = end == text.length
          val code = tts.speak(text.substring(start, end), if (index == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, "$sessionId:${if (last) "last" else index}")
          if (code != TextToSpeech.SUCCESS) {
            tts.stop(); activeSession = null
            promise.reject("ERR_VOICE_SPEAK", "Speech playback could not start", null)
            return@withEngine
          }
          start = end; index++
        }
        promise.resolve(null)
      } }
    }
    Function("stop") { main.post { generation++; engine?.stop(); activeSession = null }; Unit }
    OnDestroy { main.post { generation++; engine?.stop(); engine?.shutdown(); engine = null; ready = false; pending.toList().forEach { it(null) }; pending.clear(); activeSession = null } }
  }

  private fun withEngine(callback: (TextToSpeech?) -> Unit) {
    val current = engine
    if (current != null && ready) { callback(current); return }
    pending.add(callback)
    if (current != null) return
    val context = appContext.reactContext
    if (context == null) { pending.toList().forEach { it(null) }; pending.clear(); return }
    engine = TextToSpeech(context) { status -> main.post {
      ready = status == TextToSpeech.SUCCESS
      val tts = engine
      if (ready && tts != null) {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
          override fun onStart(utteranceId: String) {}
          override fun onDone(utteranceId: String) { main.post { finish(utteranceId, "end") } }
          @Deprecated("Deprecated in Java") override fun onError(utteranceId: String) { main.post { finish(utteranceId, "error") } }
          override fun onError(utteranceId: String, errorCode: Int) { main.post { finish(utteranceId, "error") } }
        })
      }
      if (!ready) { tts?.shutdown(); engine = null }
      val callbacks = pending.toList(); pending.clear(); callbacks.forEach { it(if (ready) engine else null) }
    } }
  }

  private fun finish(utteranceId: String, type: String) {
    val session = activeSession ?: return
    if (!utteranceId.startsWith("$session:")) return
    if (type == "end" && utteranceId != "$session:last") return
    activeSession = null
    if (type == "error") engine?.stop()
    sendEvent("onBotVoice", mapOf("sessionId" to session, "type" to type))
  }
}
