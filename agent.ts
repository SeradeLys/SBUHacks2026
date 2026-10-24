import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { TOOLS, runTool, systemPrompt } from "./meal-tools";
import { ApiError, Photon } from "@photon-ai/api";
import { GoogleGenAI, Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";


// ---------- Settings ----------
type Config = {
  key: string; project: string; platform: "imessage" | "email";
  agent: string; sender: string; gemini: string; model: string;
};

function configuration(): Config {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const platform = required("PHOTON_PLATFORM");
  if (platform !== "imessage" && platform !== "email") throw new Error("PHOTON_PLATFORM must be imessage or email.");
  return {
    key: required("PHOTON_API_KEY"), project: required("PHOTON_PROJECT_ID"),
    platform, agent: required("PHOTON_AGENT_HANDLE"), sender: required("PHOTON_TEST_SENDER"),
    gemini: required("GEMINI_API_KEY"), model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
  };
}

// ---------- Which messages to answer ----------
type Page = Awaited<ReturnType<Photon["projects"]["listMessages"]>>;
type Item = Page["items"][number];
type Incoming = { id: string; spaceId: string; senderId: string; text: string };

function incoming(m: Item, c: Config): Incoming | undefined {
  if (m.platform !== c.platform || m.status !== "received") return undefined;
  if (m.sentBy.platform !== c.platform || m.receivedBy?.platform !== c.platform || m.space.platform !== c.platform) return undefined;
  if (m.sentBy.kind !== "human" || m.sentBy.handle !== c.sender) return undefined;
  if (m.receivedBy.kind !== "agent" || m.receivedBy.handle !== c.agent) return undefined;
  if (m.sentBy.id === m.receivedBy.id) return undefined; // never answer ourselves
  if (c.platform === "imessage" && m.space.kind !== "direct") return undefined;

  let text = "";
  const content = m.content;
  if (content.type === "text" && content.format === "plain") text = content.text;
  else if (content.type === "group") {
    text = content.parts.map((p) => (p.type === "text" && p.format === "plain" ? p.text : "")).join("\n");
  }
  text = text.trim();
  if (!text) return undefined;
  return { id: m.id, spaceId: m.space.id, senderId: m.receivedBy.id, text };
}



const MAX_STEPS = 8;     // max tool rounds per message
const MAX_HISTORY = 20;  // remembered messages per conversation

async function think(ai: GoogleGenAI, model: string, past: Content[], userText: string): Promise<string> {
  const system = await systemPrompt(); // fresh every message, so the time and targets are current
  const turn: Content[] = [...past, { role: "user", parts: [{ text: userText }] }];

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await ai.models.generateContent({
      model,
      contents: turn,
      config: { systemInstruction: system, tools: [{ functionDeclarations: TOOLS }] },
    });

    const calls = res.functionCalls ?? [];
    if (calls.length === 0) return res.text?.trim() || "Hmm, I'm not sure what to say to that.";

    // Keep Gemini's tool request in the conversation, then hand back the results.
    const modelContent = res.candidates?.[0]?.content;
    if (modelContent) turn.push(modelContent);

    const parts: Part[] = [];
    for (const call of calls) {
      const name = call.name ?? "";
      const args = (call.args ?? {}) as Record<string, unknown>;
      const result = await runTool(name, args);
      console.log(`   🔧 ${name}(${JSON.stringify(args)}) → ${result.slice(0, 80)}`);
      parts.push({ functionResponse: { id: call.id, name, response: { result } } });
    }
    turn.push({ role: "user", parts });
  }
  return "That one took me too many steps. Can you ask it a simpler way?";
}

const obj = (v: unknown) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");

// ---------- Text first on start (set GREET_ON_START=off in .env to disable) ----------
// What Gemini is told when it opens the conversation. The setup rules in meal-tools still apply,
// so a new student gets the first setup question and a returning student gets a short check-in.
const KICKOFF =
  "[The student hasn't texted yet. You are starting the conversation. Write your first text now. " +
  "If setup isn't finished, greet them in one line and ask the first setup question. " +
  "If setup is done, send a short, friendly check-in for this time of day, like asking what they plan to eat or offering a pick from today's menu.]";

// Photon has no "start a new chat" call: the agent can only text into a chat the student has used before.
// So we find the most recent message the student sent to the agent (up to 5 pages back) and reuse that chat.
async function findChat(photon: Photon, c: Config): Promise<{ spaceId: string; senderId: string } | undefined> {
  let pageToken: string | undefined;
  for (let page = 0; page < 5 && (page === 0 || pageToken); page++) {
    const res = await photon.projects.listMessages({
      path: { id: c.project },
      query: { direction: "received", order: "desc", pageSize: 100, platform: c.platform, ...(pageToken ? { pageToken } : {}) },
    });
    for (const item of res.items) {
      const m = obj(item), from = obj(m.sentBy), to = obj(m.receivedBy), space = obj(m.space);
      const mine = str(from.handle) === c.sender && str(to.kind) === "agent" && str(to.handle) === c.agent;
      if (mine && (c.platform !== "imessage" || str(space.kind) === "direct") && str(space.id) && str(to.id))
        return { spaceId: str(space.id), senderId: str(to.id) };
    }
    pageToken = res.nextPageToken;
  }
}

/**
 * Sends the opening text. Never stops the agent: if anything fails it explains why and the agent keeps waiting as usual.
 * `ask` turns an instruction into Gemini's reply, e.g. (prompt) => think(ai, c.model, [], prompt).
 */
async function greetFirst(photon: Photon, c: Config, memory: Map<string, Content[]>, ask: (prompt: string) => Promise<string>) {
  if (["off", "false", "0", "no"].includes((process.env.GREET_ON_START ?? "").trim().toLowerCase())) return;
  try {
    const chat = await findChat(photon, c);
    if (!chat) return console.log(`👋 Can't text first yet: ${c.sender} has never messaged ${c.agent}. Send it any message once, and from then on it can start.`);
    const opener = await ask(KICKOFF);
    await photon.projects.sendMessage({
      path: { id: c.project },
      headers: { "idempotency-key": `agent-greeting:${chat.spaceId}:${Date.now()}` },
      body: { spaceId: chat.spaceId, senderId: chat.senderId, content: { type: "text", format: "plain", text: opener } },
    });
    // Remember the opener so the student's reply is understood in context.
    memory.set(chat.spaceId, [{ role: "user", parts: [{ text: KICKOFF }] }, { role: "model", parts: [{ text: opener }] }]);
    console.log(`👋 Sent first message: ${opener}`);
  } catch (error) {
    if (error instanceof ApiError && (error.body as { code?: string } | undefined)?.code === "SHARED_LINE_INBOUND_REQUIRED")
      console.log(`👋 Photon wants ${c.sender} to text ${c.agent} first before the agent can start a chat. Send any message once.`);
    else console.error("👋 Couldn't send the first message:", error instanceof Error ? error.message : error);
  }
}

// ---------- Web chat for Wolfie Butler (set WEB_CHAT=off in .env to disable) ----------
// Wolfie Butler's chat box sends { text, sessionId, page } to http://localhost:8787/chat and shows { reply }.
// It is the same brain, tools and nutrition-data.json as iMessage. A tunnel gives it a public https address.
const WEB_MAX_PER_MINUTE = 20; // all web visitors together, protects your Gemini quota
const WEB_MAX_SESSIONS = 200;  // remembered web conversations

// iMessage and the website share one data file, so the agent answers one message at a time.
let line: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(job: () => Promise<T>): Promise<T> {
  const next = line.then(job, job);
  line = next.catch(() => undefined);
  return next;
}

function startWebChat(ask: (past: Content[], text: string) => Promise<string>) {
  if (["off", "false", "0", "no"].includes((process.env.WEB_CHAT ?? "").trim().toLowerCase())) return;
  const port = Number(process.env.WEB_CHAT_PORT) || 8787;
  const origins = (process.env.WEB_CHAT_ORIGINS || "https://sbuhacks26.vercel.app")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const allowed = (o: string) => origins.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const sessions = new Map<string, Content[]>();
  let recent: number[] = [];

  const server = createServer(async (req, res) => {
    const origin = String(req.headers.origin ?? "");
    const send = (status: number, body?: object) => {
      const cors = allowed(origin)
        ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" }
        : {};
      res.writeHead(status, { "content-type": "application/json", vary: "Origin", ...cors });
      res.end(body ? JSON.stringify(body) : undefined);
    };
    if (req.url !== "/chat") return send(404, { error: "Not found." });
    // Opening the link in a browser tab sends no website address: show a status note instead of an error.
    if (!origin && req.method === "GET") return send(200, { ok: true, note: "The agent is running. Chat with it from the Wolfie Butler site." });
    // No website address means it isn't a browser page (a server, an app or a test tool). Those can fake
    // any address anyway, so only browser pages are checked; the per-minute cap still applies to everyone.
    if (origin && !allowed(origin)) {
      console.log(`🚫 Blocked web chat from ${origin}. To allow it, add it to WEB_CHAT_ORIGINS in .env.`);
      return send(403, { error: `This website (${origin}) isn't allowed to use the agent. Add ${origin} to WEB_CHAT_ORIGINS in the agent's .env, then restart the agent.` });
    }
    if (req.method === "OPTIONS") return send(204);
    if (req.method !== "POST") return send(405, { error: "Use POST." });

    const now = Date.now();
    recent = recent.filter((t) => now - t < 60_000);
    if (recent.length >= WEB_MAX_PER_MINUTE) return send(429, { error: "Too many messages right now. Wait a minute and try again." });
    recent.push(now);

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 20_000) return send(413, { error: "That message is too long." });
    }
    let body: Record<string, unknown> = {};
    try { body = obj(JSON.parse(raw)); } catch { /* handled below */ }
    const text = str(body.text).trim().slice(0, 2_000);
    const sessionId = str(body.sessionId).slice(0, 64) || "web";
    const page = str(body.page).slice(0, 6_000);
    if (!text) return send(400, { error: "The message is empty." });

    console.log(`\n🌐 ${text}`);
    const past = sessions.get(sessionId) ?? [];
    // What the student sees on the page (profile, plan) goes with this message only, not into memory.
    const prompt = page ? `${text}\n\n[What the student sees on the Wolfie Butler website right now: ${page}]` : text;
    let reply: string;
    try {
      reply = await ask(past, prompt);
    } catch (e) {
      console.error("Gemini error:", e instanceof Error ? e.message : e);
      return send(502, { error: "Sorry, my brain glitched for a second. Try again in a moment?" });
    }
    past.push({ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: reply }] });
    sessions.delete(sessionId);
    sessions.set(sessionId, past.slice(-MAX_HISTORY));
    if (sessions.size > WEB_MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    console.log(`🤖 ${reply}`);
    send(200, { reply });
  });
  server.on("error", (e) => console.error(`🌐 Web chat couldn't start on port ${port}:`, e.message));
  server.listen(port, () => console.log(`🌐 Web chat for Wolfie Butler: http://localhost:${port}/chat (allowed: ${origins.join(", ")})`));
}

// ---------- Main loop: keeps running until Ctrl+C ----------
async function run(c: Config, pollMs = 2_000) {
  const photon = new Photon({ headers: { Authorization: `Bearer ${c.key}` } });
  const ai = new GoogleGenAI({ apiKey: c.gemini });
  const startedAt = Date.now();
  let createdSince = new Date(startedAt - 5_000).toISOString();
  const seen = new Set<string>();
  const memory = new Map<string, Content[]>(); // one history per conversation

  console.log(`Ready. Agent is live with ${c.model}. Text ${c.agent} from ${c.sender}. Ctrl+C to stop.`);
  startWebChat((past, text) => oneAtATime(() => think(ai, c.model, past, text)));
  await greetFirst(photon, c, memory, (prompt) => oneAtATime(() => think(ai, c.model, [], prompt)));

  while (true) {
    try {
      let pageToken: string | undefined;
      let newest = Date.parse(createdSince);
      do {
        const page = await photon.projects.listMessages({
          path: { id: c.project },
          query: { createdSince, direction: "received", order: "asc", pageSize: 100, platform: c.platform, ...(pageToken ? { pageToken } : {}) },
        });

        for (const m of page.items as Item[]) {
          const id = String(m.id);
          const created = Date.parse(String(m.createdAt));
          newest = Math.max(newest, created);
          if (seen.has(id)) continue;
          seen.add(id);
          if (created < startedAt) continue; // ignore old messages


          const msg = incoming(m, c);
          if (!msg) continue;
          console.log(`\n💬 ${msg.text}`);

          const past = memory.get(msg.spaceId) ?? [];
          let reply: string;
          try {
            reply = await oneAtATime(() => think(ai, c.model, past, msg.text));
          } catch (e) {
            console.error("Gemini error:", e instanceof Error ? e.message : e);
            reply = "Sorry, my brain glitched for a second. Try again in a moment?";
          }

          past.push({ role: "user", parts: [{ text: msg.text }] }, { role: "model", parts: [{ text: reply }] });
          memory.set(msg.spaceId, past.slice(-MAX_HISTORY));

          await photon.projects.sendMessage({
            path: { id: c.project },
            headers: { "idempotency-key": `agent-reply:${msg.id}` },
            body: {
              spaceId: msg.spaceId, senderId: msg.senderId, parentMessageId: msg.id,
              content: { type: "text", format: "plain", text: reply },
            },
          });
          console.log(`🤖 ${reply}`);
        }
        pageToken = page.nextPageToken;
      } while (pageToken);

      createdSince = new Date(newest - 5_000).toISOString();
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) throw error;
      const wait = error instanceof ApiError && error.status === 429 ? 30_000 : 10_000;
      console.error(`Check failed, trying again in ${wait / 1000}s:`, error instanceof Error ? error.message : error);
      await sleep(wait);
    }
    await sleep(pollMs);
  }
}

try {
  await run(configuration());
} catch (error) {
  if (error instanceof ApiError) console.error(`Photon API error ${error.status} (request ${error.requestId ?? "unknown"}):`, error.message);
  else console.error(error instanceof Error ? error.message : "Agent failed.");
  process.exitCode = 1;
}