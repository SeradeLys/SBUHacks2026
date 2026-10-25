// The website's door into the shared agent: chat, profile sync and iMessage linking.
// Every call except the plain status check must carry the student's account key (Authorization: Bearer <key>).
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Content } from "@google/genai";
import { AccountError, deleteAccount, linkStatus, startLink, unlink, userIdFromKey, withUser } from "./accounts";
import { imessageLine, type Ask } from "./channel";
import { announceWebAccount, demoConfig, demoProof } from "./demo";
import { cleanStamp, reconcile } from "./profile-sync";
import { oneAtATime } from "./queue";
import { MAX_AUDIO_BYTES, MAX_TTS_CHARS, VoiceError, synthesize, transcribe, voiceStatus } from "./voice";

const WEB_MAX_PER_MINUTE = 20; // all web visitors together, protects your Gemini quota
const WEB_MAX_SESSIONS = 200;  // remembered web conversations
const MAX_BODY = 20_000;
const VOICE_MAX_PER_MINUTE = 40; // all voice requests together (speech costs ElevenLabs credits, and anyone can make an account key)

const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

export type ApiOptions = {
  ask: Ask;
  allowed: (origin: string) => boolean;
  maxHistory: number;
  /** Message text is personal. It is only printed when this is set (LOG_MESSAGES=on). */
  logText?: (line: string) => void;
};

export function createApi(opts: ApiOptions) {
  const sessions = new Map<string, Content[]>();
  let recent: number[] = [];
  let recentVoice: number[] = [];

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = String(req.headers.origin ?? "");
    const path = (req.url ?? "").split("?")[0] ?? "";
    const send = (status: number, body?: object) => {
      const cors = opts.allowed(origin)
        ? { "access-control-allow-origin": origin, "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "access-control-allow-headers": "content-type, authorization", "access-control-max-age": "86400" }
        : {};
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Origin", ...cors });
      res.end(body ? JSON.stringify(body) : undefined);
    };
    const routes = ["/chat", "/profile", "/link/start", "/link/status", "/link/remove", "/account/delete", "/voice/status", "/voice/tts", "/voice/stt"];
    if (!routes.includes(path)) return send(404, { error: "Not found." });
    // Opening the link in a browser tab sends no website address: show a status note instead of an error.
    if (path === "/chat" && !origin && req.method === "GET") return send(200, { ok: true, note: "The agent is running. Chat with it from the Wolfie Butler site." });
    // No website address means it isn't a browser page (a server, an app or a test tool). Those can fake
    // any address anyway, so only browser pages are checked; the account key is what protects the data.
    if (origin && !opts.allowed(origin)) {
      return send(403, { error: `This website (${origin}) isn't allowed to use the agent. Add ${origin} to WEB_CHAT_ORIGINS in the agent's .env, then restart the agent.` });
    }
    if (req.method === "OPTIONS") return send(204);

    // ---- who is this? ----
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""));
    const userId = userIdFromKey(bearer?.[1]);
    if (!userId) return send(401, { error: "Missing or invalid account key." });

    const readBody = async (): Promise<Record<string, unknown> | undefined> => {
      let raw = "";
      for await (const chunk of req) { raw += chunk; if (raw.length > MAX_BODY) { send(413, { error: "That request is too large." }); return undefined; } }
      try { return obj(JSON.parse(raw || "{}")); } catch { return {}; }
    };
    const fail = (e: unknown) => {
      if (e instanceof AccountError) return send(e.status, { error: e.message });
      console.error("API error:", e instanceof Error ? e.message : e);
      return send(500, { error: "Something went wrong. Try again in a moment." });
    };

    // ---- voice (ElevenLabs): same account key and origin rules as chat; the key to ElevenLabs never leaves this server ----
    if (path.startsWith("/voice/")) {
      try {
        if (path === "/voice/status") return req.method === "GET" ? send(200, voiceStatus()) : send(405, { error: "Use GET." });
        if (req.method !== "POST") return send(405, { error: "Use POST." });
        if (!voiceStatus().tts) return send(503, { error: "Voice isn't set up on the assistant yet." });
        const t = Date.now();
        recentVoice = recentVoice.filter((x) => t - x < 60_000);
        if (recentVoice.length >= VOICE_MAX_PER_MINUTE) return send(429, { error: "Too many voice requests right now. Wait a minute and try again." });
        recentVoice.push(t);
        if (path === "/voice/tts") {
          const body = await readBody(); if (!body) return;
          const text = str(body.text);
          if (!text.trim()) return send(400, { error: "There is nothing to read aloud." });
          if (text.length > MAX_TTS_CHARS * 3) return send(413, { error: "That text is too long to read aloud." });
          const audio = await synthesize(text);
          res.writeHead(200, { "content-type": "audio/mpeg", "content-length": audio.length, "cache-control": "no-store", vary: "Origin", ...(opts.allowed(origin) ? { "access-control-allow-origin": origin } : {}) });
          return void res.end(audio);
        }
        // /voice/stt: the body is the recorded audio itself
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) return send(413, { error: "That recording is too long." });
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_AUDIO_BYTES) return send(413, { error: "That recording is too long." }); chunks.push(chunk as Buffer); }
        const text = await transcribe(Buffer.concat(chunks), String(req.headers["content-type"] ?? ""));
        return send(200, { text });
      } catch (e) {
        if (e instanceof VoiceError) return send(e.status, { error: e.message });
        return fail(e);
      }
    }

    announceWebAccount(userId); // demo mode only: prints this account's id once so it can be set as the tester's profile
    const demo = demoConfig();

    try {
      // ---- profile sync ----
      if (path === "/profile") {
        if (req.method === "GET") return send(200, await oneAtATime(() => reconcile(userId, null, null)));
        if (req.method === "PUT") {
          const body = await readBody(); if (!body) return;
          return send(200, await oneAtATime(() => reconcile(userId, obj(body.profile), body.updatedAt)));
        }
        return send(405, { error: "Use GET or PUT." });
      }

      // ---- iMessage linking ----
      if (path === "/link/status") {
        if (req.method !== "GET") return send(405, { error: "Use GET." });
        if (demo.on) { // everything below is the backend's own view; the page shows exactly this and nothing more
          const tester = demo.ready && demo.userId === userId;
          return send(200, { linked: false, available: false, demo: {
            ready: demo.ready, ...(demo.ready ? {} : { problem: demo.problem }),
            tester, connected: imessageLine.active,
            verified: tester && demoProof.lastTesterTextAt !== null, verifiedAt: tester ? demoProof.lastTesterTextAt : null,
          } });
        }
        // `available` tells the page whether a code could be confirmed right now; "linked" always comes from the saved link.
        return send(200, { ...(await linkStatus(userId)), line: imessageLine.phone || null, available: Boolean(imessageLine.active && imessageLine.phone) });
      }
      if (path === "/link/start") {
        if (req.method !== "POST") return send(405, { error: "Use POST." });
        if (demo.on) throw new AccountError(403, "Self-service iMessage linking is turned off in demo mode.");
        const body = await readBody(); if (!body) return;
        // A code is confirmed only by a text that arrives through the iMessage connection, and the student needs the number to text.
        if (!imessageLine.active) throw new AccountError(503, "iMessage isn't connected to the assistant right now, so it can't be linked yet.");
        if (!imessageLine.phone) throw new AccountError(503, "The assistant's iMessage number isn't set up yet, so it can't tell you where to send a code.");
        const made = await startLink(userId, body.phone);
        console.log(`🔗 link code issued (expires in 10 minutes; waiting for a text from the saved number to ${imessageLine.phone})`);
        return send(200, { ...made, line: imessageLine.phone });
      }
      if (path === "/link/remove") {
        if (req.method !== "POST") return send(405, { error: "Use POST." });
        await unlink(userId);
        return send(200, { linked: false });
      }

      if (path === "/account/delete") {
        if (req.method !== "POST") return send(405, { error: "Use POST." });
        await oneAtATime(() => deleteAccount(userId));
        return send(200, { deleted: true });
      }

      // ---- chat ----
      if (req.method !== "POST") return send(405, { error: "Use POST." });
      const t = Date.now();
      recent = recent.filter((x) => t - x < 60_000);
      if (recent.length >= WEB_MAX_PER_MINUTE) return send(429, { error: "Too many messages right now. Wait a minute and try again." });
      recent.push(t);

      const body = await readBody(); if (!body) return;
      const text = str(body.text).trim().slice(0, 2_000);
      const sessionKey = `${userId}:${str(body.sessionId).slice(0, 64) || "web"}`; // a session id can never reach another student's history
      const page = str(body.page).slice(0, 6_000);
      if (!text) return send(400, { error: "The message is empty." });

      console.log(`🌐 web message (${text.length} chars)`);
      opts.logText?.(`🌐 ${text}`);
      const past = sessions.get(sessionKey) ?? [];
      // The newer copy of the profile wins, so the chat matches the dashboard (and anything changed over iMessage).
      const web = obj(body.profile);
      try { await oneAtATime(() => reconcile(userId, Object.keys(web).length ? web : null, body.profileUpdatedAt)); }
      catch (e) { console.error("Couldn't sync the profile:", e instanceof Error ? e.message : e); }
      // What the student sees on the page (profile, plan) goes with this message only, not into memory.
      const prompt = page ? `${text}\n\n[What the student sees on the Wolfie Butler website right now: ${page}]` : text;
      let reply: string;
      try { reply = await oneAtATime(() => withUser(userId, () => opts.ask(past, prompt))); }
      catch (e) {
        console.error("Gemini error:", e instanceof Error ? e.message : e);
        return send(502, { error: "Sorry, my brain glitched for a second. Try again in a moment?" });
      }
      past.push({ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: reply }] });
      sessions.delete(sessionKey);
      sessions.set(sessionKey, past.slice(-opts.maxHistory));
      if (sessions.size > WEB_MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
      opts.logText?.(`🤖 ${reply}`);

      // If the profile changed since the website last saw it (by this chat, or over iMessage), send the new copy back.
      const now = await oneAtATime(() => reconcile(userId, null, null));
      const stale = now.updatedAt !== null && now.updatedAt !== cleanStamp(body.profileUpdatedAt);
      return send(200, { reply, profileUpdatedAt: now.updatedAt, ...(stale ? { profile: now.profile } : {}) });
    } catch (e) {
      return fail(e);
    }
  };
}
