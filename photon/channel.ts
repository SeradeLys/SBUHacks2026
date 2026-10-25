// iMessage side of the shared agent. It uses the same brain, tools and per-student data as the website chat;
// the only difference is how it works out who is writing.
import type { Content } from "@google/genai";
import { confirmLink, normalizePhone, resolveUser, withUser } from "./accounts";
import { demoConfig, demoProof, isDemoTester } from "./demo";
import { oneAtATime } from "./queue";

export type Ask = (past: Content[], text: string) => Promise<string>;

/**
 * The agent's own iMessage line, shown to students when they link. It is the public line, not anyone's personal number.
 * `active` is true only while the Spectrum iMessage connection is up: a link code can only ever be confirmed by a text that
 * arrives through it, so without it the website must not hand out codes. `phone` is a normalised +E.164 number or "".
 */
export const imessageLine = { phone: normalizePhone(process.env.IMESSAGE_LINE) ?? "", active: false };

/** Spectrum reports the line as `space.phone`, which on the shared line is the word "shared". Only a real number is ever kept. */
export function noteLine(raw: unknown): void {
  const phone = normalizePhone(raw);
  if (phone && !imessageLine.phone) imessageLine.phone = phone;
}

export const REPLIES = {
  group: "For your privacy I only share personal nutrition details in one-on-one chats. Message me directly and I'll help.",
  linked: "You're linked! From now on this chat uses the same profile as your Wolfie Butler website, and changes you make in either place show up in both.",
  invalid: "That code isn't valid or has expired. Open your Profile page on the website and tap \"Link iMessage\" to get a new one.",
  mismatch: "That code was requested for a different phone number, so I couldn't link it. Text it from the number saved on your profile, or get a new code on the website.",
  limited: "Too many tries. Please wait a few minutes and try again.",
  demoDenied: "This assistant is a private demo and only answers its registered tester.",
} as const;

/** Handles one incoming iMessage. Returns the text to send back, or undefined to stay silent. */
export async function handleImessage(
  sender: string, spaceType: string | undefined, text: string, ask: Ask, memory: Map<string, Content[]>, maxHistory = 20,
): Promise<string | undefined> {
  if (!sender || !text.trim()) return undefined;
  if (spaceType !== "dm") return REPLIES.group; // a group chat would show one person's health details to everyone in it

  // Demo mode: only the one configured tester gets in, and they always get the one configured website profile. No link codes.
  const demo = demoConfig();
  let userId: string;
  if (demo.on) {
    if (!demo.ready || !isDemoTester(sender, demo)) {
      console.log(demo.ready ? "🧪 demo: ignored a text from a sender who isn't the configured tester." : `🧪 demo: ignored a text because the demo isn't set up (${demo.problem})`);
      return REPLIES.demoDenied;
    }
    demoProof.lastTesterTextAt = new Date().toISOString();
    console.log("🧪 demo: text from the configured tester accepted; using their website profile.");
    userId = demo.userId;
  } else {
    // A message that is just a link code ties this phone number to the website account that asked for the code.
    const link = await confirmLink(sender, text);
    if (link.status !== "skip") console.log(`🔗 link attempt: ${link.status}`);
    if (link.status === "linked") { memory.delete(link.userId); return REPLIES.linked; }
    if (link.status === "invalid" || link.status === "mismatch" || link.status === "limited") return REPLIES[link.status];
    userId = await resolveUser(sender); // the linked website account, or a private profile for this number alone
  }
  const past = memory.get(userId) ?? [];
  const reply = await oneAtATime(() => withUser(userId, () => ask(past, text)));
  past.push({ role: "user", parts: [{ text }] }, { role: "model", parts: [{ text: reply }] });
  memory.set(userId, past.slice(-maxHistory));
  return reply;
}
