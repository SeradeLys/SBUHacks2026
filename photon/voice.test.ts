// Run with: bun test
// A throwaway stand-in plays the part of ElevenLabs, so these tests need no real key and spend no credits.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WOLFIE_DATA_DIR = mkdtempSync(join(tmpdir(), "wolfie-voice-test-"));
for (const k of ["DEMO_MODE", "DEMO_TESTER_HANDLE", "DEMO_TESTER_USER_ID"]) delete process.env[k];
const { createApi } = await import("./web-api");
const { speakable } = await import("./voice");

afterAll(() => rmSync(process.env.WOLFIE_DATA_DIR!, { recursive: true, force: true }));

const SECRET = "sk_test_THIS_MUST_NEVER_REACH_THE_BROWSER";
const key = "V".repeat(40), origin = "https://site.example";
type Seen = { url: string; apiKey: string | undefined; type: string | undefined; body: Buffer };
let eleven: Server, site: Server, base = "", seen: Seen[] = [];
let upstream: { status: number; body: unknown; raw?: Buffer } = { status: 200, body: {} };

beforeAll(async () => {
  eleven = createServer((req, res) => {
    const chunks: Buffer[] = []; req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", apiKey: req.headers["xi-api-key"] as string | undefined, type: req.headers["content-type"], body: Buffer.concat(chunks) });
      if (upstream.raw) { res.writeHead(upstream.status, { "content-type": "audio/mpeg" }); return void res.end(upstream.raw); }
      res.writeHead(upstream.status, { "content-type": "application/json" }); res.end(JSON.stringify(upstream.body));
    });
  });
  await new Promise<void>((r) => eleven.listen(0, "127.0.0.1", () => r()));
  process.env.ELEVENLABS_API_BASE = `http://127.0.0.1:${(eleven.address() as { port: number }).port}`;
  const handler = createApi({ ask: async () => "ok", allowed: (o) => o === origin, maxHistory: 20 });
  site = createServer((req, res) => { handler(req, res).catch(() => res.end()); });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(site.address() as { port: number }).port}`;
});
afterAll(() => { eleven.close(); site.close(); });
beforeEach(() => { seen = []; process.env.ELEVENLABS_API_KEY = SECRET; upstream = { status: 200, body: {} }; });

const call = (path: string, init: { method?: string; key?: string | null; json?: unknown; audio?: Uint8Array; mime?: string } = {}) =>
  fetch(base + path, {
    method: init.method ?? "POST",
    headers: { origin, ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? key}` }), ...(init.json !== undefined ? { "content-type": "application/json" } : init.audio ? { "content-type": init.mime ?? "audio/webm" } : {}) },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.audio,
  });
const speech = new Uint8Array(2_000).fill(7);

describe("voice routes", () => {
  test("every voice route refuses a missing or malformed account key", async () => {
    for (const [method, path] of [["GET", "/voice/status"], ["POST", "/voice/tts"], ["POST", "/voice/stt"]] as [string, string][]) {
      expect((await call(path, { method, key: null })).status).toBe(401);
      expect((await call(path, { method, key: "short" })).status).toBe(401);
    }
    expect(seen.length).toBe(0); // nothing was forwarded to ElevenLabs
  });

  test("status says voice is available only when the server has a key", async () => {
    expect(await (await call("/voice/status", { method: "GET" })).json()).toEqual({ tts: true, stt: true });
    process.env.ELEVENLABS_API_KEY = "";
    expect(await (await call("/voice/status", { method: "GET" })).json()).toEqual({ tts: false, stt: false });
    expect((await call("/voice/tts", { json: { text: "hi" } })).status).toBe(503);
    expect((await call("/voice/stt", { audio: speech })).status).toBe(503);
    expect(seen.length).toBe(0);
  });

  test("a disallowed website origin is refused", async () => {
    const r = await fetch(base + "/voice/tts", { method: "POST", headers: { origin: "https://evil.example", authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
    expect(r.status).toBe(403);
    expect(seen.length).toBe(0);
  });

  test("text to speech: returns audio, sends the server's key to ElevenLabs only, and cleans the text", async () => {
    upstream = { status: 200, body: {}, raw: Buffer.from([1, 2, 3, 4, 5]) };
    const r = await call("/voice/tts", { json: { text: "**Chicken bowl**\n- 420 cal, 30g protein\n# Heading" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("audio/mpeg");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([1, 2, 3, 4, 5]);
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toContain("/v1/text-to-speech/");
    expect(seen[0]!.apiKey).toBe(SECRET);
    const sent = JSON.parse(seen[0]!.body.toString());
    expect(sent.text).toBe("Chicken bowl\n420 cal, 30g protein\nHeading");
    expect(sent.model_id).toBeTruthy();
  });

  test("text to speech: empty and oversize requests are refused before ElevenLabs is called", async () => {
    expect((await call("/voice/tts", { json: { text: "   " } })).status).toBe(400);
    expect((await call("/voice/tts", { json: {} })).status).toBe(400);
    expect((await call("/voice/tts", { json: { text: "x".repeat(7_000) } })).status).toBe(413);
    expect(seen.length).toBe(0);
  });

  test("a long reply is trimmed to the character limit", () => {
    expect(speakable("a".repeat(5_000)).length).toBe(2_000);
  });

  test("speech to text: sends the audio, returns the transcript, and an empty transcript comes back empty", async () => {
    upstream = { status: 200, body: { text: "  what is for lunch  ", language_code: "eng" } };
    const r = await call("/voice/stt", { audio: speech, mime: "audio/webm;codecs=opus" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "what is for lunch" });
    expect(seen[0]!.url).toBe("/v1/speech-to-text");
    expect(seen[0]!.apiKey).toBe(SECRET);
    expect(seen[0]!.type).toContain("multipart/form-data");
    expect(seen[0]!.body.toString("latin1")).toContain('name="model_id"');
    upstream = { status: 200, body: { text: "" } };
    expect(await (await call("/voice/stt", { audio: speech })).json()).toEqual({ text: "" });
  });

  test("speech to text: too-short and too-large recordings are refused", async () => {
    expect((await call("/voice/stt", { audio: new Uint8Array(50) })).status).toBe(400);
    expect((await call("/voice/stt", { audio: new Uint8Array(8 * 1024 * 1024 + 1) })).status).toBe(413);
    expect(seen.length).toBe(0);
  });

  test("ElevenLabs failures become safe messages and never leak the key or the upstream body", async () => {
    const check = async (status: number, body: unknown, expected: number) => {
      upstream = { status, body };
      const r = await call("/voice/tts", { json: { text: "hello" } });
      const text = await r.text();
      expect(r.status).toBe(expected);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("secret-upstream-detail");
    };
    await check(401, { detail: { status: "quota_exceeded", message: "secret-upstream-detail" } }, 429);
    await check(429, { detail: "secret-upstream-detail" }, 429);
    await check(401, { detail: { status: "invalid_api_key", message: "secret-upstream-detail" } }, 503);
    await check(422, { detail: [{ msg: "secret-upstream-detail" }] }, 400);
    await check(500, { detail: "secret-upstream-detail" }, 502);
  });

  test("an unreachable voice service is a clean 502", async () => {
    const saved = process.env.ELEVENLABS_API_BASE!;
    process.env.ELEVENLABS_API_BASE = "http://127.0.0.1:1";
    try { const r = await call("/voice/tts", { json: { text: "hello" } }); expect(r.status).toBe(502); expect((await r.text())).not.toContain(SECRET); }
    finally { process.env.ELEVENLABS_API_BASE = saved; }
  });

  test("preflight allows the headers voice requests need", async () => {
    const r = await fetch(base + "/voice/stt", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  test("voice requests are rate limited across all visitors (runs last)", async () => {
    upstream = { status: 200, body: { text: "ok" } };
    let limited = 0;
    for (let i = 0; i < 45; i++) if ((await call("/voice/stt", { audio: speech })).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});
