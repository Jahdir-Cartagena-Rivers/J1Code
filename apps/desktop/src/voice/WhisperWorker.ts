// The worker is embedded so packaged Electron builds do not depend on source paths.
export const whisperWorker = String.raw`
import base64
import os
import queue
import sys
import threading
import time

def emit(kind, text):
    print(kind + "\t" + base64.b64encode(str(text).encode("utf-8")).decode("ascii"), flush=True)

def run():
    import numpy as np
    from faster_whisper import WhisperModel

    model = WhisperModel(sys.argv[1], device="cpu", compute_type="int8", cpu_threads=4,
                         local_files_only=True)
    def decode(audio):
        segments, _ = model.transcribe(audio, language="en", beam_size=5,
                                       vad_filter=True, condition_on_previous_text=False)
        return list(segments)

    # File mode exercises exactly the same decoder without opening a microphone.
    if len(sys.argv) > 2:
        emit("F", " ".join(s.text.strip() for s in decode(sys.argv[2])))
        return

    import sounddevice as sd
    stopped = threading.Event()
    threading.Thread(target=lambda: (sys.stdin.readline(), stopped.set()), daemon=True).start()
    chunks = queue.Queue(maxsize=600)
    overflow = threading.Event()
    def capture(data, frames, timing, status):
        if status:
            overflow.set()
        try:
            chunks.put_nowait(data[:, 0].copy())
        except queue.Full:
            overflow.set()
    pending = np.empty(0, dtype=np.float32)
    committed = []
    started = time.monotonic()
    last_decode = started
    with sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                        blocksize=1600, callback=capture):
        while True:
            finishing = stopped.is_set() or time.monotonic() - started >= 120
            if not finishing:
                try:
                    block = chunks.get(timeout=0.1)
                    pending = np.concatenate((pending, block))
                    emit("L", min(100, int(np.sqrt(np.mean(block ** 2)) * 300)))
                except queue.Empty:
                    continue
            if finishing or time.monotonic() - last_decode >= 3:
                while not chunks.empty():
                    pending = np.concatenate((pending, chunks.get_nowait()))
                if overflow.is_set():
                    raise RuntimeError("Microphone audio was dropped. Please retry with fewer running tasks.")
                duration = len(pending) / 16000
                segments = decode(pending) if duration >= 0.2 else []
                emit("P", " ".join(committed + [s.text.strip() for s in segments]))
                accepted = [s for s in segments if finishing or s.end <= duration - 1]
                committed.extend(s.text.strip() for s in accepted)
                emit("F", " ".join(committed))
                if finishing:
                    break
                if accepted:
                    pending = pending[int(accepted[-1].end * 16000):]
                elif duration > 30:
                    # Bound silence/unrecognized audio without retaining minutes of samples.
                    pending = pending[-16000 * 3:]
                last_decode = time.monotonic()

try:
    run()
except Exception as error:
    print(str(error), file=sys.stderr, flush=True)
    sys.exit(1)
`;
