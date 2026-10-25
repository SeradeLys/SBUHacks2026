// One saved profile per student, shared by the website chat and iMessage. Whichever channel changed it last wins:
// every change carries a timestamp, and the older copy is replaced by the newer one.
import { withUser, now } from "./accounts";
import { loadData, syncProfile, toWebProfile } from "./meal-tools";

export type Source = "web" | "server" | "same" | "empty";
export type Synced = { profile: Record<string, unknown>; updatedAt: string | null; source: Source };

/** A usable timestamp, or null. A clock far in the future is capped, so one wrong device clock can't freeze the profile. */
export function cleanStamp(v: unknown): string | null {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return null;
  return new Date(Math.min(t, now() + 5 * 60_000)).toISOString();
}

/** Compares the website's copy with the saved one and keeps the newer. With no website copy it just reads. */
export function reconcile(userId: string, web: Record<string, unknown> | null, webStamp: unknown): Promise<Synced> {
  return withUser(userId, async () => {
    const stamp = cleanStamp(webStamp), hasWeb = !!web && Object.keys(web).length > 0;
    let source: Source = "same";
    const data = await loadData(), saved = data.updatedAt ?? null;
    if (hasWeb && (!saved || (stamp ? Date.parse(stamp) > Date.parse(saved) : false))) {
      await syncProfile(web!, stamp ?? undefined);          // the website is newer (or there is nothing saved yet)
      source = "web";
    } else if (hasWeb && !stamp && saved) source = "server"; // a client that sends no timestamp can't overwrite saved data
    else if (saved && (!stamp || Date.parse(stamp) < Date.parse(saved))) source = "server";
    const after = await loadData();
    if (!after.updatedAt && !Object.keys(after.profile).length) source = "empty";
    return { profile: toWebProfile(after.profile), updatedAt: after.updatedAt ?? null, source };
  });
}
