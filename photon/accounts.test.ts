// Run with: bun test
// Everything here uses a throwaway data folder and a stand-in for the AI, so it needs no Gemini quota or real iMessage.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Content } from "@google/genai";

process.env.WOLFIE_DATA_DIR = mkdtempSync(join(tmpdir(), "wolfie-test-"));
const { confirmLink, linkStatus, normalizePhone, resolveUser, senderScope, setClock, startLink, unlink, userIdFromKey, withUser } = await import("./accounts");
const { handleImessage, imessageLine, noteLine, REPLIES } = await import("./channel");
const { demoConfig, demoProof, handleKey } = await import("./demo");
const { reconcile } = await import("./profile-sync");
const { runTool, systemPrompt } = await import("./meal-tools");
const { createApi } = await import("./web-api");

afterAll(() => rmSync(process.env.WOLFIE_DATA_DIR!, { recursive: true, force: true }));

const keyA = "A".repeat(20) + "a".repeat(20), keyB = "B".repeat(20) + "b".repeat(20), keyS = "Y".repeat(40);
const idA = userIdFromKey(keyA)!, idB = userIdFromKey(keyB)!, idS = userIdFromKey(keyS)!;
const phoneA = "+15551230001", phoneB = "+442071838750", phoneS = "+15551230002";
/** An ISO time this many minutes from now (negative = past). Fixed dates would drift into the future and be capped. */
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const full = { name: "Sam", age: 25, sex: "female", weight: 200, weightUnit: "lb", height: 72, heightUnit: "in", activity: "light", diet: ["Vegetarian"], allergies: ["Peanut"] };
const profileLine = async (userId: string) => withUser(userId, async () => (await systemPrompt()).split("\n").find((l) => l.startsWith("Student profile:")) ?? "");

/** Stand-in for Gemini: "weight N" changes the saved weight the way the real update_profile tool does, anything else reports the saved profile. */
const ask = async (_past: Content[], text: string) => {
  const m = /^weight (\d+)/.exec(text);
  if (m) { await runTool("update_profile", { weight: Number(m[1]), weight_unit: "lbs" }); return "ok, updated"; }
  return (await systemPrompt()).split("\n").find((l) => l.startsWith("Student profile:")) ?? "";
};
const dm = (sender: string, text: string, memory = new Map<string, Content[]>()) => handleImessage(sender, "dm", text, ask, memory);

/** Links `phone` to `userId` through the real flow. */
async function link(userId: string, phone: string) {
  const { code } = await startLink(userId, phone);
  const r = await confirmLink(phone, code);
  expect(r.status).toBe("linked");
}

describe("identities", () => {
  test("phone numbers are normalised and need a country code", () => {
    expect(normalizePhone("+1 (555) 123-0001")).toBe("+15551230001");
    expect(normalizePhone("+44 20 7183 8750")).toBe("+442071838750");
    for (const bad of ["5551230001", "555-123-0001", "+0123456789", "+1", "+1555", "abc", "", null, undefined, "+1555123000100000"]) expect(normalizePhone(bad)).toBeNull();
  });
  test("account keys: strict format, stable, distinct, and never equal to the key itself", () => {
    expect(userIdFromKey("short")).toBeNull();
    expect(userIdFromKey("../../etc/passwd" + "x".repeat(30))).toBeNull();
    expect(userIdFromKey(undefined)).toBeNull();
    expect(userIdFromKey(keyA)).toBe(idA);
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^u_[0-9a-f]{40}$/);
    expect(idA).not.toContain(keyA);
  });
});

describe("account linking", () => {
  test("saving no phone number: a link code cannot be requested", async () => {
    await expect(startLink(idA, "")).rejects.toThrow(/country code/);
    await expect(startLink(idA, "5551230001")).rejects.toThrow(/country code/);
    expect((await linkStatus(idA)).linked).toBe(false);
  });
  test("the right code from the saved phone links it, once", async () => {
    const { code, last4 } = await startLink(idA, phoneA);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(code).toMatch(/\d/);
    expect(last4).toBe("0001");
    expect(await resolveUser(phoneA)).toBe(senderScope(phoneA)); // not linked yet
    expect((await confirmLink(phoneA, "link " + code.toLowerCase())).status).toBe("linked"); // case and a "link" prefix are fine
    expect(await resolveUser(phoneA)).toBe(idA);
    expect(await linkStatus(idA)).toMatchObject({ linked: true, last4: "0001" });
    expect((await confirmLink(phoneA, code)).status).toBe("invalid"); // a code works once
  });
  test("the code alone is not enough: a different phone is refused and stays unlinked", async () => {
    const { code } = await startLink(idB, phoneB);
    const thief = "+15559998888";
    expect((await confirmLink(thief, code)).status).toBe("mismatch");
    expect(await resolveUser(thief)).toBe(senderScope(thief));
    expect((await linkStatus(idB)).linked).toBe(false);
    expect((await confirmLink(phoneB, code)).status).toBe("linked"); // the real owner can still use it
  });
  test("an Apple ID email can't link, because no phone number can match it", async () => {
    const { code } = await startLink(idA, phoneA);
    expect((await confirmLink("someone@icloud.com", code)).status).toBe("mismatch");
  });
  test("five wrong-phone tries burn the code", async () => {
    const { code } = await startLink(idA, phoneA);
    for (let i = 0; i < 5; i++) await confirmLink("+15550001111", code);
    expect((await confirmLink(phoneA, code)).status).toBe("invalid");
  });
  test("wrong and expired codes fail; ordinary chat is ignored by the link check", async () => {
    expect((await confirmLink(phoneA, "ABCD2345")).status).toBe("invalid");
    const { code } = await startLink(idA, phoneA);
    const real = Date.now();
    setClock(() => real + 11 * 60_000);
    expect((await confirmLink(phoneA, code)).status).toBe("invalid");
    setClock(() => Date.now());
    for (const t of ["hello", "what's for lunch?", "I love sausages", "my weight is 150", "ABCDEFGH", "12345678"]) expect((await confirmLink(phoneA, t)).status).toBe("skip");
  });
  test("code requests and guessing are rate limited", async () => {
    const id = userIdFromKey("R".repeat(40))!;
    for (let i = 0; i < 5; i++) await startLink(id, phoneA);
    await expect(startLink(id, phoneA)).rejects.toThrow(/Too many/);
    const guesser = "+15557776666";
    let last = "";
    for (let i = 0; i < 9; i++) last = (await confirmLink(guesser, "ZZZZ2222")).status;
    expect(last).toBe("limited");
  });
  test("only a hash of the phone number is stored, never the number", () => {
    const text = readFileSync(join(process.env.WOLFIE_DATA_DIR!, "links.json"), "utf8");
    expect(text).not.toContain("5551230001");
    expect(text).not.toContain("2071838750");
    expect(text).toContain("last4");
  });
  test("unlinking returns the phone to its own private profile", async () => {
    await link(idA, phoneA);
    await unlink(idA);
    expect((await linkStatus(idA)).linked).toBe(false);
    expect(await resolveUser(phoneA)).toBe(senderScope(phoneA));
  });
});

describe("one profile shared by the website and iMessage", () => {
  test("website -> iMessage: what the student saved on the website is what the iMessage agent sees", async () => {
    await link(idS, phoneS);
    const r = await reconcile(idS, full, at(-120));
    expect(r.source).toBe("web");
    expect(await dm(phoneS, "what do you know about me?")).toContain('"weight":200');
    expect(await dm(phoneS, "what do you know about me?")).toContain('"allergies":"Peanut"');
  });
  test("iMessage -> website: a profile change made over iMessage is what the website pulls next", async () => {
    expect(await dm(phoneS, "weight 150")).toBe("ok, updated");
    const pulled = await reconcile(idS, null, null);
    expect(pulled.profile.weight).toBe(150);
    expect(pulled.profile.allergies).toEqual(["Peanut"]); // untouched fields survive
    expect(Date.parse(pulled.updatedAt!)).toBeGreaterThan(Date.parse(at(-120)));
  });
  test("conflict: the older copy loses, the newer one wins", async () => {
    const saved = (await reconcile(idS, null, null)).updatedAt!;
    const older = new Date(Date.parse(saved) - 60_000).toISOString();
    const stale = await reconcile(idS, { ...full, weight: 999 }, older); // website edited before the iMessage change
    expect(stale.source).toBe("server");
    expect(stale.profile.weight).toBe(150);
    const newer = new Date(Date.parse(saved) + 60_000).toISOString();
    const fresh = await reconcile(idS, { ...full, weight: 180 }, newer);
    expect(fresh.source).toBe("web");
    expect(fresh.profile.weight).toBe(180);
    expect(await dm(phoneS, "profile?")).toContain('"weight":180');
  });
  test("a client with no timestamp can't overwrite saved data", async () => {
    const r = await reconcile(idS, { ...full, weight: 111 }, undefined);
    expect(r.source).toBe("server");
    expect(r.profile.weight).toBe(180);
  });
  test("a clock far in the future can't freeze the profile", async () => {
    const r = await reconcile(idS, { ...full, weight: 175 }, "2999-01-01T00:00:00.000Z");
    expect(r.source).toBe("web");
    expect(Date.parse(r.updatedAt!)).toBeLessThan(Date.now() + 6 * 60_000);
  });
  test("a new student with nothing saved on either side is simply empty", async () => {
    const r = await reconcile(userIdFromKey("N".repeat(40))!, null, null);
    expect(r.source).toBe("empty");
    expect(r.updatedAt).toBeNull();
  });
});

describe("data isolation", () => {
  test("two students never see each other's profile", async () => {
    await reconcile(idB, { ...full, name: "Bea", weight: 120, allergies: ["Egg"] }, at(-110));
    const a = await profileLine(idS), b = await profileLine(idB);
    expect(a).not.toContain("Bea"); expect(a).not.toContain('"weight":120');
    expect(b).toContain("Bea"); expect(b).not.toContain("Peanut");
  });
  test("an unlinked iMessage number gets its own profile, separate from every account", async () => {
    const stranger = "+15553334444", other = "+15555556666";
    expect(await dm(stranger, "weight 133")).toBe("ok, updated");
    expect(await dm(stranger, "profile?")).toContain('"weight":133');
    expect(await dm(other, "profile?")).not.toContain("133");
    expect(await dm(phoneS, "profile?")).not.toContain("133");
  });
  test("linking carries an iMessage-only profile over, but never replaces an existing account profile", async () => {
    const early = "+15557778888", fresh = userIdFromKey("F".repeat(40))!;
    await dm(early, "weight 142");
    await link(fresh, early);
    expect((await reconcile(fresh, null, null)).profile.weight).toBe(142); // adopted: the account had nothing
    const early2 = "+15559990000", haveProfile = userIdFromKey("H".repeat(40))!;
    await reconcile(haveProfile, { ...full, weight: 90, weightUnit: "kg" }, at(-100));
    await dm(early2, "weight 77");
    await link(haveProfile, early2);
    expect((await reconcile(haveProfile, null, null)).profile.weight).toBe(90); // kept
  });
  test("group chats get no personal data and never reach the agent", async () => {
    let called = false;
    const reply = await handleImessage(phoneS, "group", "what is my weight?", async () => { called = true; return "secret"; }, new Map());
    expect(reply).toBe(REPLIES.group);
    expect(called).toBe(false);
  });
  test("a message with no sender is ignored", async () => {
    expect(await handleImessage("", "dm", "hi", ask, new Map())).toBeUndefined();
  });
  test("iMessage conversation memory is kept per student", async () => {
    const seen: number[] = [];
    const counting = async (past: Content[]) => { seen.push(past.length); return "k"; };
    const memory = new Map<string, Content[]>();
    await handleImessage(phoneS, "dm", "one", counting, memory); await handleImessage(phoneS, "dm", "two", counting, memory);
    await handleImessage(phoneB, "dm", "one", counting, memory);
    expect(seen).toEqual([0, 2, 0]);
  });
  test("a student's files live under hashed ids, never under a key or a phone number", () => {
    const names = readdirSync(join(process.env.WOLFIE_DATA_DIR!, "users"));
    expect(names.length).toBeGreaterThan(3);
    for (const n of names) expect(n).toMatch(/^[us]_[0-9a-f]{40}\.json$/);
  });
});

describe("web API", () => {
  let server: Server, base = "";
  const origin = "http://localhost:3000";
  type Reply = { status: number; headers: Headers; json: () => Promise<any> }; // the tests read JSON replies loosely
  const call = (path: string, init: { method?: string; key?: string | null; body?: unknown; origin?: string } = {}): Promise<Reply> =>
    fetch(base + path, {
      method: init.method ?? "GET",
      headers: { ...(init.key === null ? {} : { authorization: `Bearer ${init.key ?? keyS}` }), "content-type": "application/json", origin: init.origin ?? origin },
      body: init.body === undefined || (init.method ?? "GET") === "GET" ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    const handler = createApi({ ask, allowed: (o) => o === origin, maxHistory: 20 });
    server = createServer((req, res) => { handler(req, res).catch(() => res.end()); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => { server.close(); });

  test("every route refuses a missing or malformed account key", async () => {
    for (const [method, path] of [["POST", "/chat"], ["GET", "/profile"], ["PUT", "/profile"], ["POST", "/link/start"], ["GET", "/link/status"], ["POST", "/link/remove"]] as const) {
      const none = await call(path, { method, key: null, body: {} });
      expect(none.status).toBe(401);
      const bad = await call(path, { method, key: "too-short", body: {} });
      expect(bad.status).toBe(401);
    }
  });
  test("a different key reaches a different, empty account, never someone else's data", async () => {
    await call("/profile", { method: "PUT", key: keyS, body: { profile: full, updatedAt: at(-90) } });
    const other = await (await call("/profile", { key: "Z".repeat(40) })).json();
    expect(other.source).toBe("empty");
    expect(JSON.stringify(other)).not.toContain("Sam");
    expect(JSON.stringify(other)).not.toContain("Peanut");
  });
  test("preflight allows the headers the site needs, only for allowed origins", async () => {
    const ok = await fetch(base + "/profile", { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT" } });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe(origin);
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-methods")).toContain("PUT");
    const blocked = await call("/profile", { origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("no code is handed out unless iMessage is connected and the line number is known", async () => {
    const key = "N".repeat(40), body = { phone: "+1 555 888 0000" };
    imessageLine.active = false; imessageLine.phone = "";
    expect((await call("/link/start", { method: "POST", key, body })).status).toBe(503);
    expect(await (await call("/link/status", { key })).json()).toMatchObject({ linked: false, available: false, line: null });
    imessageLine.active = true; // connected, but nobody has said which number to text
    const noLine = await call("/link/start", { method: "POST", key, body });
    expect(noLine.status).toBe(503);
    expect((await noLine.json()).error).toContain("number");
    imessageLine.phone = "+15550009999";
    expect(await (await call("/link/status", { key })).json()).toMatchObject({ available: true, line: "+15550009999" });
    expect((await call("/link/start", { method: "POST", key, body })).status).toBe(200);
  });
  test("the shared line's placeholder is never taken for a phone number", () => {
    imessageLine.phone = "";
    noteLine("shared"); noteLine(undefined); noteLine("not a number");
    expect(imessageLine.phone).toBe("");
    noteLine("+1 (555) 000-1234");
    expect(imessageLine.phone).toBe("+15550001234");
    noteLine("+15559998888"); // the first real number wins
    expect(imessageLine.phone).toBe("+15550001234");
  });
  test("link flow over HTTP: missing phone, code, wrong sender, right sender, status, unlink", async () => {
    imessageLine.active = true; imessageLine.phone = "+15550009999";
    const key = "L".repeat(40);
    expect((await call("/link/start", { method: "POST", key, body: {} })).status).toBe(400); // no phone saved
    const started = await (await call("/link/start", { method: "POST", key, body: { phone: "+1 555 777 0000" } })).json();
    expect(started.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(started.last4).toBe("0000");
    expect(started.line).toBe("+15550009999");
    expect((await (await call("/link/status", { key })).json()).linked).toBe(false);
    expect((await confirmLink("+15550000000", started.code)).status).toBe("mismatch");
    expect((await confirmLink("+15557770000", started.code)).status).toBe("linked");
    expect(await (await call("/link/status", { key })).json()).toMatchObject({ linked: true, last4: "0000" });
    expect((await (await call("/link/status", { key: "M".repeat(40) })).json()).linked).toBe(false); // someone else's key sees nothing
    expect(await (await call("/link/remove", { method: "POST", key })).json()).toEqual({ linked: false });
    expect((await (await call("/link/status", { key })).json()).linked).toBe(false);
  });
  test("chat: the website profile reaches the agent, and a change made over iMessage comes back to a stale page", async () => {
    const key = "C".repeat(40), id = userIdFromKey(key)!, phone = "+15551112222";
    const t1 = at(-80);
    const first = await (await call("/chat", { method: "POST", key, body: { text: "profile?", sessionId: "s1", profile: full, profileUpdatedAt: t1 } })).json();
    expect(first.reply).toContain('"weight":200');
    expect(first.profile).toBeUndefined();                    // the page is up to date, nothing to send back
    await link(id, phone);
    expect(await dm(phone, "weight 150")).toBe("ok, updated"); // changed over iMessage
    const second = await (await call("/chat", { method: "POST", key, body: { text: "profile?", sessionId: "s1", profile: full, profileUpdatedAt: t1 } })).json();
    expect(second.reply).toContain('"weight":150');           // the stale page didn't overwrite it
    expect(second.profile.weight).toBe(150);                  // and it learns the new value
    expect(Date.parse(second.profileUpdatedAt)).toBeGreaterThan(Date.parse(t1));
  });
  test("chat: two students using the same session id don't share a conversation", async () => {
    const seen: number[] = [];
    const h = createApi({ ask: async (past) => { seen.push(past.length); return "k"; }, allowed: () => true, maxHistory: 20 });
    const s2 = createServer((req, res) => { h(req, res).catch(() => res.end()); });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", () => r()));
    const b2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
    const say = (key: string) => fetch(b2 + "/chat", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ text: "hi", sessionId: "same" }) });
    await say("S".repeat(40)); await say("S".repeat(40)); await say("T".repeat(40));
    s2.close();
    expect(seen).toEqual([0, 2, 0]);
  });
  test("the phone number is never part of the profile the agent keeps", async () => {
    const r = await (await call("/profile", { method: "PUT", key: keyS, body: { profile: { ...full, phone: "+15551230001" }, updatedAt: at(-70) } })).json();
    expect(JSON.stringify(r)).not.toContain("5551230001");
    const files = readdirSync(join(process.env.WOLFIE_DATA_DIR!, "users")).map((f) => readFileSync(join(process.env.WOLFIE_DATA_DIR!, "users", f), "utf8")).join("\n");
    expect(files).not.toContain("5551230001");
  });
});

describe("single-tester demo mode", () => {
  const testerKey = "D".repeat(40), otherKey = "E".repeat(40), testerId = userIdFromKey(testerKey)!, otherId = userIdFromKey(otherKey)!;
  const testerPhone = "+15557770001", stranger = "+15557770002";
  const origin = "http://localhost:3000";
  let server: Server, base = "";
  type Reply = { status: number; json: () => Promise<any> }; // the tests read JSON replies loosely
  const web = (path: string, key = testerKey, init: { method?: string; body?: unknown } = {}): Promise<Reply> =>
    fetch(base + path, { method: init.method ?? "GET", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", origin }, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const setDemo = (env: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  const on = { DEMO_MODE: "on", DEMO_TESTER_HANDLE: testerPhone, DEMO_TESTER_USER_ID: testerId };

  beforeAll(async () => {
    const handler = createApi({ ask, allowed: (o) => o === origin, maxHistory: 20 });
    server = createServer((req, res) => { handler(req, res).catch(() => res.end()); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    imessageLine.active = true;
  });
  afterAll(() => { server.close(); setDemo({ DEMO_MODE: undefined, DEMO_TESTER_HANDLE: undefined, DEMO_TESTER_USER_ID: undefined }); });

  test("off by default: nothing changes unless DEMO_MODE=on", () => {
    setDemo({ DEMO_MODE: undefined });
    expect(demoConfig()).toEqual({ on: false });
  });
  test("handles: a phone is normalised, an email is compared as an email and never read as a phone number", () => {
    expect(handleKey("+1 (555) 777-0001")).toBe(testerPhone);
    expect(handleKey(" Tester@Example.COM ")).toBe("tester@example.com");
    expect(handleKey("tester@example.com").startsWith("+")).toBe(false);
  });
  test("incomplete settings fail closed: every sender is refused, the AI is never called, and the page is told why", async () => {
    for (const bad of [{ DEMO_TESTER_HANDLE: undefined }, { DEMO_TESTER_USER_ID: undefined }, { DEMO_TESTER_HANDLE: "15557770001" }, { DEMO_TESTER_USER_ID: "not-an-id" }]) {
      setDemo({ ...on, ...bad });
      let asked = 0;
      const r = await handleImessage(testerPhone, "dm", "hi", async () => { asked++; return "x"; }, new Map());
      expect(r).toBe(REPLIES.demoDenied);
      expect(asked).toBe(0);
      const st = (await (await web("/link/status")).json()).demo;
      expect(st.ready).toBe(false);
      expect(typeof st.problem).toBe("string");
    }
  });
  test("an unauthorised sender is refused: no profile data, no AI call, and the old link codes can't be used to get in", async () => {
    setDemo(on);
    await reconcile(testerId, full, at(-50));
    let asked = 0;
    const spy = async (...a: Parameters<typeof ask>) => { asked++; return ask(...a); };
    const refused = await handleImessage(stranger, "dm", "what do you know about me?", spy, new Map());
    expect(refused).toBe(REPLIES.demoDenied);
    expect(refused).not.toContain("Sam");
    for (const intruder of ["+15557770099", "tester@example.com", "shared", "+1555777000"]) {
      expect(await handleImessage(intruder, "dm", "hi", spy, new Map())).toBe(REPLIES.demoDenied);
    }
    const { code } = await startLink(otherId, "+15557770099");
    expect(await handleImessage("+15557770099", "dm", code, spy, new Map())).toBe(REPLIES.demoDenied); // a valid code from a stranger links nothing
    expect((await linkStatus(otherId)).linked).toBe(false);
    expect(asked).toBe(0);
    expect(demoProof.lastTesterTextAt).toBeNull(); // a refused text is never counted as the tester's
  });
  test("an email handle works when explicitly configured, and only that exact one", async () => {
    setDemo({ ...on, DEMO_TESTER_HANDLE: "Tester@Example.com" });
    expect(await handleImessage("tester@example.com", "dm", "what do you know about me?", ask, new Map())).toContain('"weight":200');
    expect(await handleImessage("other@example.com", "dm", "hi", ask, new Map())).toBe(REPLIES.demoDenied);
    expect(await handleImessage(testerPhone, "dm", "hi", ask, new Map())).toBe(REPLIES.demoDenied); // the phone is a different handle
    demoProof.lastTesterTextAt = null;
    setDemo(on);
  });
  test("a group chat never gets the tester's profile, even from the tester", async () => {
    expect(await handleImessage(testerPhone, "group", "hi", ask, new Map())).toBe(REPLIES.group);
  });
  test("website -> iMessage: a profile saved on the website is what the tester's next text sees", async () => {
    const saved = await (await web("/profile", testerKey, { method: "PUT", body: { profile: { ...full, weight: 188 }, updatedAt: at(-40) } })).json();
    expect(saved.source).toBe("web");
    expect(await handleImessage(testerPhone, "dm", "what do you know about me?", ask, new Map())).toContain('"weight":188');
  });
  test("iMessage -> website: a change made over iMessage is what the website pulls next", async () => {
    expect(await handleImessage(testerPhone, "dm", "weight 163", ask, new Map())).toBe("ok, updated");
    const pulled = await (await web("/profile")).json();
    expect(pulled.profile.weight).toBe(163);
    expect(pulled.profile.allergies).toEqual(["Peanut"]);
    expect(pulled.source).toBe("server");
  });
  test("one profile only: iMessage used the website account's own file, and no private per-sender profile was created", () => {
    const files = readdirSync(join(process.env.WOLFIE_DATA_DIR!, "users"));
    expect(files).toContain(`${testerId}.json`);
    expect(files.filter((f) => f.startsWith("s_") && f.includes(handleKey(testerPhone).slice(-4)))).toEqual([]);
  });
  test("status shows the backend's own state, and only the tester's account sees 'verified'", async () => {
    const mine = (await (await web("/link/status")).json()).demo;
    expect(mine).toMatchObject({ ready: true, tester: true, connected: true, verified: true });
    expect(Date.parse(mine.verifiedAt)).toBeGreaterThan(0);
    const theirs = (await (await web("/link/status", otherKey)).json()).demo;
    expect(theirs).toMatchObject({ ready: true, tester: false, verified: false, verifiedAt: null });
    expect(JSON.stringify(mine) + JSON.stringify(theirs)).not.toContain("5557770001"); // the tester's handle never reaches the page
  });
  test("before any text from the tester arrives, nothing claims delivery works", async () => {
    demoProof.lastTesterTextAt = null; // as after an agent restart
    expect((await (await web("/link/status")).json()).demo).toMatchObject({ ready: true, tester: true, verified: false });
  });
  test("Photon disconnected: the page is told iMessage isn't connected", async () => {
    imessageLine.active = false;
    expect((await (await web("/link/status")).json()).demo).toMatchObject({ tester: true, connected: false, verified: false });
    imessageLine.active = true;
  });
  test("self-service linking is switched off, and normal website authentication is unchanged", async () => {
    expect((await web("/link/start", testerKey, { method: "POST", body: { phone: testerPhone } })).status).toBe(403);
    expect((await fetch(base + "/link/status", { headers: { origin } })).status).toBe(401);
    expect((await fetch(base + "/profile", { headers: { origin, authorization: "Bearer short" } })).status).toBe(401);
    const strangerProfile = await (await web("/profile", otherKey)).json();
    expect(strangerProfile.source).toBe("empty"); // another website account never sees the tester's profile
    expect(JSON.stringify(strangerProfile)).not.toContain("Sam");
  });
  test("turning demo mode off restores the normal flow", async () => {
    setDemo({ DEMO_MODE: undefined });
    imessageLine.phone = "+15550009999";
    expect((await web("/link/start", otherKey, { method: "POST", body: { phone: "+15557770055" } })).status).toBe(200);
  });
});
