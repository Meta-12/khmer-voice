// Khmer Dubber – Edge voice for Deno Deploy (free). Paste this whole file into a Deno Deploy playground.
// Endpoints:  GET /ping  |  GET /test (plays a Khmer sample or shows the error)  |  POST /tts {text, voice, rate}

const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const VERSIONS = ["143.0.3650.75", "140.0.3485.14", "130.0.2849.68"];
const VOICES = ["km-KH-SreymomNeural", "km-KH-PisethNeural"];
const WSS = "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };
const reply = (code, body, type = "text/plain; charset=utf-8") => new Response(body, { status: code, headers: { ...CORS, "Content-Type": type } });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
const rid = () => hex(crypto.getRandomValues(new Uint8Array(16)));

async function gec() {
  let t = Math.floor(Date.now() / 1000) + 11644473600;
  t -= t % 300; t *= 1e7;
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${t}${TOKEN}`)));
}
const stamp = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.*) GMT$/, "$1 $3 $2 $4 $5 GMT+0000 (Coordinated Universal Time)");
const esc = (s) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

async function openSocket(version, h1) {
  const url = `${WSS}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${await gec()}&Sec-MS-GEC-Version=1-${version}&ConnectionId=${rid()}`;
  const major = version.split(".")[0];
  const headers = {
    Pragma: "no-cache", "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36 Edg/${major}.0.0.0`,
    "Accept-Language": "en-US,en;q=0.9", Cookie: `muid=${rid()};`,
  };
  return await new Promise((resolve, reject) => {
    let opts = { headers };
    // Force HTTP/1.1: Microsoft's server rejects WebSockets over HTTP/2
    if (h1) { try { opts.client = Deno.createHttpClient({ http1: true, http2: false }); } catch (_) { return reject(new Error("no HTTP/1.1 client available")); } }
    // @ts-ignore Deno allows custom headers on WebSocket
    const ws = new WebSocket(url, opts);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error(e.message || "connection refused"));
  });
}

async function synth(text, voice, rate) {
  let ws = null; const tried = [];
  for (const v of VERSIONS) {
    for (const h1 of [true, false]) {
      try { ws = await openSocket(v, h1); break; } catch (e) { tried.push(`v${v.split(".")[0]}${h1 ? "/h1" : "/default"}: ${e.message}`); }
    }
    if (ws) break;
  }
  if (!ws) throw new Error("Edge refused every attempt: " + tried.join(" | "));

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge timed out")), 25000);
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") { if (ev.data.includes("Path:turn.end")) { clearTimeout(timer); resolve(); } return; }
      const b = new Uint8Array(ev.data), n = (b[0] << 8) | b[1];
      if (new TextDecoder().decode(b.slice(2, 2 + n)).includes("Path:audio")) chunks.push(b.slice(2 + n));
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Edge connection error")); };
    ws.onclose = () => { clearTimeout(timer); resolve(); };
  });

  const t = stamp();
  ws.send(`X-Timestamp:${t}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n`);
  const [, region, name] = voice.match(/^(\w+-\w+)-(\w+Neural)$/);
  ws.send(`X-RequestId:${rid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${t}Z\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='Microsoft Server Speech Text to Speech Voice (${region}, ${name})'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>${esc(text)}</prosody></voice></speak>`);

  try { await done; } finally { try { ws.close(); } catch (_) {} }
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

Deno.serve(async (request) => {
  const { pathname } = new URL(request.url);
  if (request.method === "OPTIONS") return reply(204, null);
  if (request.method === "GET" && pathname.startsWith("/ping")) return reply(200, JSON.stringify({ ok: true, voices: VOICES }), "application/json");
  if (request.method === "GET" && pathname.startsWith("/test")) {
    try {
      const a = await synth("សួស្តី នេះគឺជាការសាកល្បងសំឡេង", VOICES[1], "+0%");
      return a.length ? reply(200, a, "audio/mpeg") : reply(502, "Edge connected but returned no audio");
    } catch (e) { return reply(500, "TEST FAILED: " + (e.message || e)); }
  }
  if (request.method === "POST" && pathname.startsWith("/tts")) {
    try {
      const d = await request.json();
      const text = String(d.text || "").trim().slice(0, 1500), voice = String(d.voice || VOICES[0]), rate = String(d.rate || "+0%");
      if (!text) return reply(400, "empty text");
      if (!VOICES.includes(voice)) return reply(400, "unsupported voice");
      if (!/^[+-]\d{1,3}%$/.test(rate)) return reply(400, "bad rate");
      const a = await synth(text, voice, rate);
      return a.length ? reply(200, a, "audio/mpeg") : reply(502, "Edge returned no audio");
    } catch (e) { return reply(500, String(e.message || e).slice(0, 300)); }
  }
  return reply(200, "Khmer Edge voice helper is running. Use /ping or /test.");
});
