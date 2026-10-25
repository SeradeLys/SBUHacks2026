// Single-tester demo mode (hackathon). Delete this file and its few call sites to go back to self-service linking.
//
// One person, the tester, is set up by hand in the agent's .env. Their iMessage sender handle is tied to one existing website
// profile, so the website chat and the iMessage assistant can be shown sharing the same saved profile. Nothing is hardcoded and
// nothing about the tester ever reaches the website. In demo mode no other sender can reach the profile (or the AI), and
// the one-time-code linking is turned off. Without DEMO_MODE=on none of this runs.
//
//   DEMO_MODE=on
//   DEMO_TESTER_HANDLE   exactly what Spectrum calls message.sender.id: "+15551234567" (phone, with country code) or an Apple ID email
//   DEMO_TESTER_USER_ID  the tester's existing website profile id ("u_" + 40 hex), printed by the agent when that browser connects
import { normalizePhone } from "./accounts";

/** How a sender is compared: a phone in +E.164 form, otherwise a lower-cased address. An email is never read as a phone number. */
export const handleKey = (raw: unknown): string => normalizePhone(raw) ?? String(raw ?? "").trim().toLowerCase();
const looksLikeHandle = (key: string) => key.startsWith("+") || /^[^@\s]+@[^@\s]+$/.test(key);

export type Demo =
  | { on: false }
  | { on: true; ready: false; problem: string }
  | { on: true; ready: true; userId: string; handle: string };

/** Read from the environment on every call, so the answer is always what the agent is configured with right now. */
export function demoConfig(): Demo {
  if (!["on", "true", "1", "yes"].includes((process.env.DEMO_MODE ?? "").trim().toLowerCase())) return { on: false };
  const handle = handleKey(process.env.DEMO_TESTER_HANDLE), userId = (process.env.DEMO_TESTER_USER_ID ?? "").trim();
  if (!handle) return { on: true, ready: false, problem: "DEMO_TESTER_HANDLE is not set." };
  if (!looksLikeHandle(handle)) return { on: true, ready: false, problem: "DEMO_TESTER_HANDLE must be a phone number with its country code (+1…) or an email address." };
  if (!userId) return { on: true, ready: false, problem: "DEMO_TESTER_USER_ID is not set." };
  if (!/^u_[0-9a-f]{40}$/.test(userId)) return { on: true, ready: false, problem: "DEMO_TESTER_USER_ID isn't a website profile id (u_ followed by 40 characters)." };
  return { on: true, ready: true, userId, handle };
}

/** Does this iMessage sender match the configured tester exactly? */
export function isDemoTester(senderId: unknown, demo: Demo = demoConfig()): boolean {
  return demo.on && demo.ready && handleKey(senderId) !== "" && handleKey(senderId) === demo.handle;
}

/** Set only when a text from the configured tester has really arrived (resets when the agent restarts). */
export const demoProof = { lastTesterTextAt: null as string | null };

// A new browser account's id is shown once in the agent's console, so the person setting up the demo can copy it into .env.
const announced = new Set<string>();
export function announceWebAccount(userId: string): void {
  const demo = demoConfig();
  if (!demo.on || (demo.ready && demo.userId === userId) || announced.has(userId) || announced.size >= 20) return;
  announced.add(userId);
  console.log(`🧪 Demo: a website account (${userId}) just connected. To make it the demo tester's profile, set DEMO_TESTER_USER_ID=${userId} and restart.`);
}
