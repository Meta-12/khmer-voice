"""Khmer Dubber – Edge voice helper (Render / Hugging Face Spaces). Hardened version."""
import asyncio, json, os, re, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import edge_tts

PORT = int(os.environ.get("PORT", 7860))
VOICES = ["km-KH-SreymomNeural", "km-KH-PisethNeural"]
SLOTS = threading.BoundedSemaphore(2)          # Microsoft throttles bursts: at most 2 live syntheses
RATE_RE = re.compile(r"^[+-]\d{1,3}%$")


def clean(t):
    """Remove characters the Khmer voice cannot read (Chinese/Korean/full-width) and fix the Chinese full stop."""
    t = t.replace("。", "។").replace("｡", "។")
    t = re.sub(r"[\u2E80-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF]", "", t)
    t = re.sub(r"[\x00-\x1f\x7f\u200b-\u200d\ufeff]", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def speakable(t):
    return bool(re.search(r"[\u1780-\u17B3\u17E0-\u17E90-9A-Za-z]", t))


async def synth(text, voice, rate):
    buf = bytearray()

    async def run():
        async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])

    await asyncio.wait_for(run(), 30)
    return bytes(buf)


def synth_retry(text, voice, rate, tries=3):
    last = "unknown error"
    for k in range(tries):
        try:
            with SLOTS:
                audio = asyncio.run(synth(text, voice, rate))
            if len(audio) > 200:
                return audio
            last = "Edge returned no audio"
        except Exception as e:
            last = repr(e)
        time.sleep(0.8 * (k + 1))
    raise RuntimeError(last)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _reply(self, code, body=b"", ctype="text/plain; charset=utf-8"):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self._reply(204)

    def do_GET(self):
        if self.path.startswith("/ping"):
            self._reply(200, json.dumps({"ok": True, "voices": VOICES}).encode(), "application/json")
        elif self.path.startswith("/test"):
            try:
                audio = synth_retry("សួស្តី នេះគឺជាការសាកល្បងសំឡេង", VOICES[1], "+0%")
                self._reply(200, audio, "audio/mpeg")
            except Exception as e:
                self._reply(500, ("TEST FAILED: " + str(e)).encode()[:400])
        else:
            self._reply(200, b"Khmer Edge voice helper is running. Use /ping or /test.")

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._reply(404, b"not found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            text = clean(str(data.get("text", "")))[:1500]
            voice = str(data.get("voice", VOICES[0]))
            rate = str(data.get("rate", "+0%"))
            if not speakable(text):
                return self._reply(400, b"no speakable text")
            if voice not in VOICES:
                return self._reply(400, b"unsupported voice")
            if not RATE_RE.match(rate):
                return self._reply(400, b"bad rate")
            self._reply(200, synth_retry(text, voice, rate), "audio/mpeg")
        except Exception as e:
            self._reply(500, str(e).encode()[:300])

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
