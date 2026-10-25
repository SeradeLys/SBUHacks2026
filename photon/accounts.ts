// Who is asking, and which saved profile belongs to them.
//
// There is no login on the website, so a browser proves who it is with an account key: a long random secret that
// only that browser (or the student's private cloud space) holds. The server keeps only a hash of it. An iMessage
// sender is a different kind of identity (a phone number), and a phone number alone never grants access to a
// website account. The two are joined by a one-time code: the website shows a code, and the student texts it from
// the phone number they saved. Only then is that number linked to the account.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomInt } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const dataDir = () => process.env.WOLFIE_DATA_DIR || "user-data"; // a function so tests can point it elsewhere
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export let now = () => Date.now();
export const setClock = (fn: () => number) => { now = fn; }; // tests only

export class AccountError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------- Which user a piece of work runs for ----------
const who = new AsyncLocalStorage<{ userId: string }>();
export const withUser = <T>(userId: string, job: () => Promise<T>) => who.run({ userId }, job);
export const currentUser = () => who.getStore()?.userId;

const ID = /^[us]_[0-9a-f]{40}$/;
export function userFile(userId: string): string {
  if (!ID.test(userId)) throw new Error("Invalid user id."); // ids are built by this file only, so a path can never be injected
  return join(dataDir(), "users", `${userId}.json`);
}

// ---------- Identities ----------
/** Website account key -> user id. Only the hash is ever stored. */
export function userIdFromKey(key: string | null | undefined): string | null {
  return key && /^[A-Za-z0-9_-]{32,128}$/.test(key) ? "u_" + sha("key:" + key).slice(0, 40) : null;
}

/** "+1 (555) 123-4567" -> "+15551234567". The country code is required, because the site is used internationally. */
export function normalizePhone(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s.startsWith("+")) return null;
  const digits = s.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(digits) ? digits : null;
}

const handleValue = (handle: string) => normalizePhone(handle) ?? handle.trim().toLowerCase();
/** An iMessage sender nobody has linked: they still get their own private profile, separate from everyone else. */
export const senderScope = (handle: string) => "s_" + sha("sender:" + handleValue(handle)).slice(0, 40);

// ---------- Saved links (phone number -> account), stored as hashes ----------
type Link = { userId: string; last4: string; linkedAt: string };
type Links = { phones: Record<string, Link> };
const linksFile = () => join(dataDir(), "links.json");

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return null; }
}
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, file);
}
let queue: Promise<unknown> = Promise.resolve();
function changeLinks<T>(fn: (l: Links) => T): Promise<T> {
  const run = queue.then(async () => {
    const links = (await readJson<Links>(linksFile())) ?? { phones: {} };
    const result = fn(links);
    await writeJson(linksFile(), links);
    return result;
  });
  queue = run.catch(() => undefined);
  return run;
}
const phoneKey = (phone: string) => sha("phone:" + phone);

// ---------- One-time link codes ----------
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no I, O, 0 or 1, so a code is easy to read and type
const CODE_MINUTES = 10, MAX_STARTS_PER_HOUR = 5, MAX_CODE_MISTAKES = 5, MAX_SENDER_FAILS = 8;
type Pending = { userId: string; phone: string; expiresAt: number; mistakes: number };
const pending = new Map<string, Pending>();
const starts = new Map<string, number[]>();
const fails = new Map<string, { count: number; resetAt: number }>();

function newCode(): string {
  for (;;) {
    const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    if (/\d/.test(code) && /[A-Z]/.test(code) && !pending.has(code)) return code; // a digit keeps ordinary words from matching
  }
}

export async function startLink(userId: string, phoneRaw: unknown): Promise<{ code: string; expiresAt: string; last4: string }> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) throw new AccountError(400, "Save your phone number with its country code first, like +1 555 123 4567.");
  const recent = (starts.get(userId) ?? []).filter((t) => now() - t < 3_600_000);
  if (recent.length >= MAX_STARTS_PER_HOUR) throw new AccountError(429, "Too many code requests. Try again in an hour.");
  starts.set(userId, [...recent, now()]);
  for (const [c, p] of pending) if (p.userId === userId) pending.delete(c); // one live code per account
  const code = newCode(), expiresAt = now() + CODE_MINUTES * 60_000;
  pending.set(code, { userId, phone, expiresAt, mistakes: 0 });
  return { code, expiresAt: new Date(expiresAt).toISOString(), last4: phone.slice(-4) };
}

export type LinkResult = { status: "skip" } | { status: "linked"; userId: string } | { status: "invalid" | "mismatch" | "limited" };

/** Looks at an incoming iMessage. Only a message that is just a link code is treated as one; anything else is "skip". */
export async function confirmLink(senderHandle: string, text: string): Promise<LinkResult> {
  const squashed = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = squashed.match(/^(?:LINK)?(?:CODE)?([A-HJ-NP-Z2-9]{8})$/);
  const code = m?.[1];
  if (!code || !/\d/.test(code)) return { status: "skip" };

  const sender = handleValue(senderHandle), f = fails.get(sender);
  if (f && f.resetAt > now() && f.count >= MAX_SENDER_FAILS) return { status: "limited" };
  const fail = () => { const cur = f && f.resetAt > now() ? f : { count: 0, resetAt: now() + 15 * 60_000 }; cur.count++; fails.set(sender, cur); };

  const p = pending.get(code);
  if (!p) { fail(); return { status: "invalid" }; }
  if (p.expiresAt < now()) { pending.delete(code); fail(); return { status: "invalid" }; }
  if (normalizePhone(senderHandle) !== p.phone) { // right code, wrong phone: the code alone proves nothing
    fail();
    if (++p.mistakes >= MAX_CODE_MISTAKES) pending.delete(code);
    return { status: "mismatch" };
  }
  pending.delete(code); // a code works once
  await changeLinks((l) => {
    for (const [k, v] of Object.entries(l.phones)) if (v.userId === p.userId) delete l.phones[k];
    l.phones[phoneKey(p.phone)] = { userId: p.userId, last4: p.phone.slice(-4), linkedAt: new Date(now()).toISOString() };
  });
  await adoptSenderProfile(senderScope(senderHandle), p.userId);
  return { status: "linked", userId: p.userId };
}

/** Anything the student told the agent over iMessage before linking carries over, unless the account already has a profile. */
async function adoptSenderProfile(fromId: string, toId: string): Promise<void> {
  const from = await readJson<{ profile?: Record<string, unknown> }>(userFile(fromId));
  if (!from?.profile || !Object.keys(from.profile).length) return;
  const to = await readJson<{ profile?: Record<string, unknown> }>(userFile(toId));
  if (to?.profile && Object.keys(to.profile).length) return;
  await writeJson(userFile(toId), from);
}

/** The account an iMessage sender belongs to: their linked website account, or a private profile of their own. */
export async function resolveUser(senderHandle: string): Promise<string> {
  const phone = normalizePhone(senderHandle);
  const link = phone ? (await readJson<Links>(linksFile()))?.phones[phoneKey(phone)] : undefined;
  return link?.userId ?? senderScope(senderHandle);
}

export async function linkStatus(userId: string): Promise<{ linked: boolean; last4?: string; linkedAt?: string }> {
  const l = (await readJson<Links>(linksFile()))?.phones ?? {};
  const mine = Object.values(l).find((v) => v.userId === userId);
  return mine ? { linked: true, last4: mine.last4, linkedAt: mine.linkedAt } : { linked: false };
}

/** Forgets everything the agent holds for this account: the phone link and the saved profile and food log. */
export async function deleteAccount(userId: string): Promise<void> {
  await unlink(userId);
  await rm(userFile(userId), { force: true });
}

export async function unlink(userId: string): Promise<void> {
  for (const [c, p] of pending) if (p.userId === userId) pending.delete(c);
  await changeLinks((l) => { for (const [k, v] of Object.entries(l.phones)) if (v.userId === userId) delete l.phones[k]; });
}
