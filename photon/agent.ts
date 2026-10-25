import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { TOOLS, runTool, systemPrompt } from "./meal-tools";
import { handleImessage, imessageLine, noteLine } from "./channel";
import { normalizePhone } from "./accounts";
import { demoConfig } from "./demo";
import { oneAtATime } from "./queue";
import { createApi } from "./web-api";
import { ApiError, Photon } from "@photon-ai/api";
import { GoogleGenAI, Type, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";


// Messages and tool arguments are personal (weight, allergies...), so they are only printed when LOG_MESSAGES=on.
const logText = ["on", "true", "1", "yes"].includes((process.env.LOG_MESSAGES ?? "").trim().toLowerCase()) ? (l: string) => console.log(l) : undefined;

// ---------- Settings ----------
type Config = {
  key: string; project: string; platform: "imessage" | "email";
  agent: string; sender: string; gemini: string; model: string;
  webOnly: boolean; // true when the Photon settings are incomplete: only the website chat runs
};

const PHOTON_VARS = ["PHOTON_API", "PHOTON_PROJECT_ID", "PHOTON_PLATFORM", "PHOTON_AGENT_HANDLE", "PHOTON_TEST_SENDER"];

function configuration(): Config {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing ${name}.`);
    return value;
  };
  const gemini = required("GEMINI_API"), model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const missing = PHOTON_VARS.filter((name) => !process.env[name]);
  if (missing.length) {
    if (!spectrumReady()) console.log(`ℹ️ Photon is not set up (missing ${missing.join(", ")}), so only the website chat will run.`);
    return { key: "", project: "", platform: "imessage", agent: "", sender: "", gemini, model, webOnly: true };
  }
  const platform = required("PHOTON_PLATFORM");
  if (platform !== "imessage" && platform !== "email") throw new Error("PHOTON_PLATFORM must be imessage or email.");
  return {
    key: required("PHOTON_API"), project: required("PHOTON_PROJECT_ID"),
    platform, agent: required("PHOTON_AGENT_HANDLE"), sender: required("PHOTON_TEST_SENDER"),
    gemini, model, webOnly: false,
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
      console.log(`   🔧 ${name}`);
      logText?.(`      ${JSON.stringify(args)} → ${result.slice(0, 80)}`);
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
function startWebChat(ask: (past: Content[], text: string) => Promise<string>) {
  if (["off", "false", "0", "no"].includes((process.env.WEB_CHAT ?? "").trim().toLowerCase())) return;
  const port = Number(process.env.WEB_CHAT_PORT) || 8787;
  const origins = (process.env.WEB_CHAT_ORIGINS || "https://sbuhacks26.vercel.app")
    .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  const allowed = (o: string) => origins.includes(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
  const api = createApi({ ask, allowed, maxHistory: MAX_HISTORY, logText });
  const server = createServer((req, res) => { api(req, res).catch((e) => { console.error("Web API error:", e instanceof Error ? e.message : e); if (!res.headersSent) res.writeHead(500); res.end(); }); });
  server.on("error", (e) => console.error(`🌐 Web chat couldn't start on port ${port}:`, e.message));
  server.listen(port, () => console.log(`🌐 Web chat for Wolfie Butler: http://localhost:${port}/chat (allowed: ${origins.join(", ")})`));
}

// ---------- iMessage through Spectrum (needs only SPECTRUM_PROJECT_ID and SPECTRUM_PROJECT_SECRET) ----------
const spectrumReady = () => Boolean(process.env.SPECTRUM_PROJECT_ID && process.env.SPECTRUM_PROJECT_SECRET);

// Stage 1 of the inbound path: Spectrum reports a heartbeat each time a live subscription is open, so this proves the agent is
// really listening for texts (not only that it logged in). Printed once per stream; the line is "shared" or the last 4 digits.
const liveStreams = new Set<string>();
function logStreamLive(h: { stream: string; phone: string; lineId: string }) {
  const key = `${h.stream}:${h.lineId}`;
  if (liveStreams.has(key)) return;
  liveStreams.add(key);
  console.log(`📡 iMessage "${h.stream}" stream is live on ${h.phone === "shared" ? "the SHARED line pool" : `a dedicated line ending ${h.phone.slice(-4)}`}.`);
}

async function startSpectrum(ask: (past: Content[], text: string) => Promise<string>) {
  const app = await Spectrum({
    projectId: process.env.SPECTRUM_PROJECT_ID!,
    projectSecret: process.env.SPECTRUM_PROJECT_SECRET!,
    providers: [imessage.config({ onHeartbeat: logStreamLive })],
  });
  imessageLine.active = true; // from here on the website may hand out link codes: a text with the code can reach handleImessage
  console.log(`📱 Spectrum connected to "${app.config?.name ?? "your project"}". Text the project's iMessage line to chat.`);
  const demo = demoConfig();
  if (demo.on) console.log(demo.ready ? `🧪 Demo mode: only the tester (${demo.handle.includes("@") ? "an email handle" : "number ending " + demo.handle.slice(-4)}) is answered, using website profile ${demo.userId}. Self-service linking is off.` : `🧪 Demo mode is ON but not set up: ${demo.problem} Every iMessage will be refused until it is fixed.`);
  else if (!imessageLine.phone) console.log("ℹ️ Set IMESSAGE_LINE in .env to the project's iMessage number (like +15551234567). Until then the website can't tell students where to text their link code.");
  const memory = new Map<string, Content[]>(); // one history per student
  console.log(`ℹ️ iMessage setup: IMESSAGE_LINE ${imessageLine.phone ? "is set" : "is NOT set"}. If no "📡 … stream is live" line appears within a few seconds, Spectrum isn't delivering texts to this agent.`);

  try { await listen(app, ask, memory); }
  catch (e) { console.error("📱 The iMessage stream stopped:", e instanceof Error ? e.message : e); }
  console.error("📱 iMessage is no longer being listened to. Restart the agent.");
}

async function listen(app: Awaited<ReturnType<typeof Spectrum>>, ask: (past: Content[], text: string) => Promise<string>, memory: Map<string, Content[]>) {
  for await (const [space, message] of app.messages) {
    if (message.content.type !== "text") { console.log(`📱 iMessage ignored: content type is "${message.content.type}", not plain text.`); continue; }
    const text = message.content.text.trim();
    if (!text) continue;
    noteLine((space as { phone?: string }).phone);
    console.log(`📱 iMessage received [pid ${process.pid}, id ${String(message.id ?? "unknown")}] (${text.length} chars, ${(space as { type?: string }).type ?? "unknown"} chat, sender is ${normalizePhone(message.sender?.id) ? "a phone number" : (message.sender?.id ?? "").includes("@") ? "an email address" : "an unrecognised handle"})`);
    logText?.(`💬 ${text}`);
    logText?.(`📱 sender handle (copy this into the Photon Users list and DEMO_TESTER_HANDLE): ${message.sender?.id ?? ""}`);

    let reply: string | undefined;
    try {
      reply = await handleImessage(message.sender?.id ?? "", (space as { type?: string }).type, text, ask, memory, MAX_HISTORY);
    } catch (e) {
      console.error("Gemini error:", e instanceof Error ? e.message : e);
      reply = "Sorry, my brain glitched for a second. Try again in a moment?";
    }
    if (!reply) { console.log("📱 No reply to send (nothing to answer)."); continue; }
    const out = reply;
    try {
      await space.responding(async () => { await message.reply(out); });
      console.log(`✉️ iMessage reply sent [pid ${process.pid}, to id ${String(message.id ?? "unknown")}] (${out.length} chars)`);
    } catch (e) { // a failed send must not stop the agent from hearing the next text
      console.error("✉️ Couldn't send the iMessage reply:", e instanceof Error ? `${e.name}: ${e.message}` : e);
    }
    logText?.(`🤖 ${out}`);
  }
}

// ---------- Main loop: keeps running until Ctrl+C ----------
async function run(c: Config, pollMs = 2_000) {
  const photon = new Photon({ headers: { Authorization: `Bearer ${c.key}` } });
  const ai = new GoogleGenAI({ apiKey: c.gemini });
  const startedAt = Date.now();
  let createdSince = new Date(startedAt - 5_000).toISOString();
  const seen = new Set<string>();
  const memory = new Map<string, Content[]>(); // one history per conversation

  console.log(spectrumReady() ? `Ready. Website chat and iMessage (Spectrum), with ${c.model}. Ctrl+C to stop.` : c.webOnly ? `Ready. Website chat only, with ${c.model}. Ctrl+C to stop.` : `Ready. Agent is live with ${c.model}. Text ${c.agent} from ${c.sender}. Ctrl+C to stop.`);
  startWebChat((past, text) => think(ai, c.model, past, text));
  if (spectrumReady()) return startSpectrum((past, text) => think(ai, c.model, past, text));
  if (c.webOnly) return; // the web chat server keeps the process running
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
          logText?.(`💬 ${msg.text}`);

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
          logText?.(`🤖 ${reply}`);
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