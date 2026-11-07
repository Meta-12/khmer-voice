"""Khmer Dubber – Edge voice helper (hosted version for Hugging Face Spaces)."""
import asyncio, json, os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import edge_tts

PORT = int(os.environ.get("PORT", 7860))
VOICES = ["km-KH-SreymomNeural", "km-KH-PisethNeural"]


async def synth(text, voice, rate):
    buf = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate).stream():
        if chunk["type"] == "audio":
            buf += chunk["data"]
    return bytes(buf)


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
                audio = asyncio.run(synth("សួស្តី នេះគឺជាការសាកល្បងសំឡេង", VOICES[1], "+0%"))
                self._reply(200, audio, "audio/mpeg")
            except Exception as e:
                self._reply(500, ("TEST FAILED: " + repr(e)).encode()[:400])
        else:
            self._reply(200, b"Khmer Edge voice helper is running. Use /ping or /test.")

    def do_POST(self):
        if not self.path.startswith("/tts"):
            return self._reply(404, b"not found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            text = str(data.get("text", "")).strip()[:1500]
            voice = str(data.get("voice", VOICES[0]))
            rate = str(data.get("rate", "+0%"))
            if not text:
                return self._reply(400, b"empty text")
            if voice not in VOICES:
                return self._reply(400, b"unsupported voice")
            audio = asyncio.run(synth(text, voice, rate))
            if not audio:
                return self._reply(502, b"Edge returned no audio")
            self._reply(200, audio, "audio/mpeg")
        except Exception as e:
            self._reply(500, repr(e).encode()[:300])

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
