// meal-tools.ts — Stony Brook dining (Nutrislice) + personal nutrition tracking tools for the Gemini agent.
// All math lives in nutrition-service.ts; this file fetches menus, stores logs and talks to Gemini.
import { readFile, writeFile } from "node:fs/promises";
import { Type, type FunctionDeclaration } from "@google/genai";
import {
  ACTIVITY_LEVELS, DISCLAIMER, NUTRIENTS, WARNING, averageDays, calculateTargets, completeValue, describeTargets, fitScore, fmt,
  fmtTotals, healthResource, macroPriorities, macroStatus, macroStatusText, perNutrient, scaleNutrients, sumNutrients, toNumber,
  totalsFromValues, type BodyInput, type Nutrients, type Targets, type Totals,
} from "./nutrition-service";

// ---------- Settings ----------
const NUTRISLICE = "https://stonybrook.api.nutrislice.com/menu/api";
const TZ = "America/New_York";
const DATA_FILE = "nutrition-data.json";
const MAX_MENU_LINES = 70; // keeps Gemini fast

const HALLS = {
  east: { school: "east-side-dining", menu: "todays-dine-in-specials-esd", name: "East Side Dine-In" },
  west: { school: "west-side-dining", menu: "todays-dine-in-specials-wsd", name: "West Side Dine-In" },
} as const;
type Hall = keyof typeof HALLS;

// ---------- Types ----------
type Food = Nutrients & { name: string; station: string; serving: string; tags: string[] };
type LogEntry = Nutrients & { name: string; servings: number; meal: string; time: string; source: string };
type Profile = BodyInput & {
  name?: string; diet?: string; allergies?: string; dislikes?: string; preferred_hall?: string;
  setup_done?: boolean; // true once the agent has asked all its first-time questions
};
type Data = { profile: Profile; log: Record<string, LogEntry[]> };

const PROFILE_KEYS = [
  "name", "weight", "weight_unit", "height", "height_unit", "age", "sex", "activity_level",
  "target_weight", "timeframe_weeks", "diet", "allergies", "dislikes", "preferred_hall",
] as const;

// ---------- Small helpers ----------
/** YYYY-MM-DD in New York, optionally some days back. */
export const today = (daysAgo = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() - daysAgo * 86_400_000));
const nowTime = () => new Date().toLocaleTimeString("en-US", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const given = (v: unknown) => v !== undefined && v !== null && v !== "";
const dateArg = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : today());
const hallArg = (v: unknown): Hall[] => (str(v) === "east" || str(v) === "west" ? [str(v) as Hall] : ["east", "west"]);

async function loadData(): Promise<Data> {
  try {
    const d = JSON.parse(await readFile(DATA_FILE, "utf8")) as Partial<Data>;
    return { profile: d.profile ?? {}, log: d.log ?? {} };
  } catch {
    return { profile: {}, log: {} };
  }
}
const saveData = (d: Data) => writeFile(DATA_FILE, JSON.stringify(d, null, 2));

// ---------- Nutrislice ----------
const cache = new Map<string, { at: number; foods: Food[] }>();

async function getMenu(hall: Hall, date: string): Promise<Food[]> {
  const key = `${hall}:${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.foods; // reuse for 1 hour

  const { school, menu } = HALLS[hall];
  const res = await fetch(`${NUTRISLICE}/weeks/school/${school}/menu-type/${menu}/${date.replaceAll("-", "/")}/?format=json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Nutrislice returned ${res.status}`);
  const week = (await res.json()) as { days?: { date: string; menu_items?: any[] }[] };

  // The response covers a whole week, so cache every day in it.
  for (const day of week.days ?? []) {
    const foods: Food[] = [];
    let station = "";
    for (const it of day.menu_items ?? []) {
      if (it.is_section_title) { station = it.text || station; continue; }
      const f = it.food;
      if (!f?.name) continue;
      const n = f.rounded_nutrition_info ?? {};
      const s = f.serving_size_info;
      foods.push({
        name: f.name, station,
        serving: s?.serving_size_amount ? `${s.serving_size_amount} ${s.serving_size_unit ?? ""}`.trim() : "",
        // Missing values stay null (shown as N/A), never 0.
        calories: toNumber(n.calories), protein: toNumber(n.g_protein), carbs: toNumber(n.g_carbs), fat: toNumber(n.g_fat),
        fiber: toNumber(n.g_fiber), sugar: toNumber(n.g_sugar), sodium: toNumber(n.mg_sodium),
        tags: (f.icons?.food_icons ?? []).map((i: { name?: string }) => i.name).filter(Boolean),
      });
    }
    cache.set(`${hall}:${day.date}`, { at: Date.now(), foods });
  }
  return cache.get(key)?.foods ?? [];
}

const BREAKFAST_WORDS = ["breakfast", "omelet", "pancake", "waffle", "yogurt", "cereal", "bagel"];
function stationFitsMeal(station: string, meal: string): boolean {
  const s = station.toLowerCase();
  if (!meal || meal === "any") return true;
  if (meal === "breakfast") return BREAKFAST_WORDS.some((w) => s.includes(w));
  if (meal === "late night") return s.includes("late night");
  if (s.includes(meal)) return true; // "Chef's Table Lunch Specials"
  const otherMeal = ["breakfast", "lunch", "dinner", "late night"].some((w) => w !== meal && s.includes(w));
  return !otherMeal && !BREAKFAST_WORDS.some((w) => s.includes(w)); // all-day stations: pizza, salad, deli...
}

const macroLine = (n: Nutrients) =>
  `${fmt(n.calories)} cal, ${fmt(n.protein)}g protein, ${fmt(n.carbs)}g carbs, ${fmt(n.fat)}g fat, ${fmt(n.fiber)}g fiber`;

const foodLine = (f: Food, fit?: number | null) =>
  `${f.station}: ${f.name}${f.serving ? ` (${f.serving})` : ""} - ${macroLine(f)}${f.tags.length ? ` [${f.tags.join(", ")}]` : ""}${fit === undefined ? "" : ` | fit ${fmt(fit)}`}`;

// Gemini tends to shorten texts down to calories and protein, so this rule is repeated in the prompt and in tool results.
export const MACRO_REPLY_RULE =
  'MACRO FORMAT (required): every time you name a dish, put it on its own line as "Dish - X cal, Xg protein, Xg carbs, Xg fat, Xg fiber", copying the numbers from the tools. Never leave out carbs, fat or fiber, even in a short text. If a number is N/A, write N/A.';

/** One line with all five numbers, ready to copy into a text. */
export const dishText = (name: string, n: Nutrients) => `${name} - ${macroLine(n)}`;

/** Every macro vs its target, plus which ones to prioritize next. */
function balanceText(t: Totals, x: Targets, label = "eaten"): string {
  const list = macroStatus(t, x);
  return `${macroStatusText(list, label)}\n${macroPriorities(list).text}`;
}

/** "Today: X cal, Xg protein, ..." with N/A for incomplete totals, then every macro vs its target. */
const dayReport = (t: Totals, x: Targets) => `Today: ${macroLine(perNutrient((k) => completeValue(t[k])))}\n${balanceText(t, x)}`;

async function findFood(name: string, date: string, halls: Hall[]): Promise<Food | undefined> {
  const q = name.toLowerCase();
  let best: { f: Food; score: number } | undefined;
  for (const h of halls) {
    for (const f of await getMenu(h, date)) {
      const n = f.name.toLowerCase();
      const score = n === q ? 3 : n.startsWith(q) ? 2 : n.includes(q) || q.includes(n) ? 1 : 0;
      if (score && (!best || score > best.score)) best = { f, score };
    }
  }
  return best?.f;
}

// ---------- First-time setup: the agent asks before it does anything else ----------
const ACTIVITY_CHOICES = Object.values(ACTIVITY_LEVELS).map((v) => v.label).join(" / ");

function setupStatus(p: Profile): { done: boolean; missing: string[]; next: string } {
  const missing = calculateTargets(p).missing; // missing or invalid body stats
  const has = (...keys: string[]) => missing.some((m) => keys.some((k) => m.startsWith(k)));
  const next = p.setup_done ? ""
    : has("Weight", "Height") ? "their weight (kg or lbs) and height (cm, or feet and inches). If a value was out of range or unclear, explain and ask again."
    : has("Age", "Sex") ? "their age and sex (male or female, used by the calorie formula)."
    : has("Activity") ? `their activity level. Offer these choices: ${ACTIVITY_CHOICES}.`
    : !p.diet || !p.allergies ? "their diet (e.g. vegetarian, halal, none), any food allergies, and foods they dislike. Save \"none\" if they have none."
    : "whether they have an optional target weight and timeframe in weeks (they can skip). Then show their daily targets and call update_profile with setup_done=true.";
  return { done: !!p.setup_done, missing, next };
}

// ---------- System prompt (recalculated every message) ----------
export async function systemPrompt(): Promise<string> {
  const data = await loadData();
  const t = today();
  const weekday = new Date().toLocaleDateString("en-US", { timeZone: TZ, weekday: "long" });
  const targets = calculateTargets(data.profile);
  const help = healthResource();
  const setup = setupStatus(data.profile);
  const setupBlock = setup.done
    ? ""
    : `
SETUP MODE (first priority, overrides every other request):
Before recommending meals, logging food or giving summaries, you must ask the student for their details first.
- If this is the first message, greet them in one line, say you need a few quick details to personalize their plan, then ask the first question.
- Ask one step at a time, at most 2 questions per text. Next to ask: ${setup.next}
- Save every answer right away with update_profile, then ask the next thing it tells you.
- If they ask for food or anything else now, say you'll help as soon as setup is done, and ask the next question.
- If they don't want to share something, accept it, tell them that number will show as N/A, and move on.
`;
  return `You are a personal dining and nutrition coach for a Stony Brook University student, texting over iMessage.
Today is ${weekday} ${t}, ${nowTime()} New York time.
Student profile: ${Object.keys(data.profile).length ? JSON.stringify(data.profile) : "NOT SET UP YET"}
${setupBlock}
Daily targets (recalculated from the profile just now):
${describeTargets(targets)}
Today's balance across every macro:
${balanceText(sumNutrients(data.log[t] ?? []), targets)}

Rules:
- ${MACRO_REPLY_RULE}
- Recommend meals only from real menus fetched with get_menu (East Side and West Side Dine-In). Never invent dishes or nutrition numbers.
- Care about every macro, not just calories and protein: protein, carbs, fat and fiber all count equally. Use the balance above.
- To recommend food, call get_menu with sort_by "best_fit". It ranks dishes by how well they fill every macro still needed without pushing any over. Build a plate of 1-3 items that moves the most-behind macros toward target, and avoid foods heavy in a macro that is already over.
- Give each pick a short reason tied to a macro, e.g. "adds fiber you're short on" or "lower fat since you're near your fat target".
- Fit picks to diet and dislikes too. Strictly avoid listed allergies, and remind them Nutrislice allergen tags can be incomplete.
- Pick the meal from the time of day unless they say otherwise.
- When they say they ate something, call log_meal right away with exact menu names, then reply with each logged dish in the MACRO FORMAT, the "Today:" line from the tool, and which macro to focus on next.
- For progress questions, use get_nutrition_summary. For "what if" numbers without saving, use calculate_targets.
- Targets come only from the tools and the numbers above. Never do nutrition math yourself.
- Show numbers with 2 decimal places exactly as the tools give them. Anything shown as N/A is missing: say it is not available. Never treat missing as 0.
- Weight is in kg or lbs, height in cm or inches (convert feet and inches to inches). If anything is unclear, ask instead of guessing.
- A target weight and timeframe are optional. If a goal plan is WITHHELD, do not suggest any plan, calorie number or workaround for that goal. Send this exact text: "${WARNING}" and share ${help.name}: ${help.url}
- If they mention unexpected or rapid weight changes, recommend seeking medical advice and share ${help.url}. Never recommend aggressive weight changes.
- When giving targets, add once: "${DISCLAIMER}"
Style: friendly and to the point, plain text only, no markdown or asterisks. Suggest at most 3 options. Keeping a text short never means dropping macros: every dish always shows cal, protein, carbs, fat and fiber.
Example of the shape only (use real dishes and numbers from the tools):
<dish name> - 430.00 cal, 25.00g protein, 69.00g carbs, 11.00g fat, 14.00g fiber
Adds the fiber and carbs you're short on, and it's low in fat.`;
}

// ---------- Tools Gemini can use ----------
// Small builders for Gemini's parameter schemas.
const field = (type: Type, description?: string, values?: string[]) => ({ type, ...(values && { enum: values }), ...(description && { description }) });
const text = (description?: string, values?: string[]) => field(Type.STRING, description, values);
const num = (description?: string) => field(Type.NUMBER, description);
const flag = (description: string) => field(Type.BOOLEAN, description);
const params = (properties: Record<string, object>, required?: string[]) => ({ type: Type.OBJECT, properties, ...(required && { required }) });
const DATE = text("YYYY-MM-DD. Defaults to today.");

const BODY_FIELDS = {
  weight: num(),
  weight_unit: text(undefined, ["kg", "lbs"]),
  height: num(),
  height_unit: text("Convert feet+inches to inches, e.g. 5'10\" = 70 in", ["cm", "in"]),
  age: num(),
  sex: text("Used by the BMR equation", ["male", "female"]),
  activity_level: text(Object.entries(ACTIVITY_LEVELS).map(([k, v]) => `${k} = ${v.label}`).join("; "), Object.keys(ACTIVITY_LEVELS)),
  target_weight: num("Optional, in the same unit as weight"),
  timeframe_weeks: num("Optional, weeks to reach target_weight"),
};
const ITEM_NOTES: Partial<Record<string, string>> = { calories: "Only for food not on the menu", sodium: "mg" };

export const TOOLS: FunctionDeclaration[] = [
  {
    name: "get_menu",
    description: "Get the real Stony Brook dine-in menu with nutrition per serving from Nutrislice. N/A means Nutrislice has no value.",
    parameters: params({
      date: DATE,
      hall: text("Dining hall. Defaults to both.", ["east", "west", "both"]),
      meal: text(undefined, ["breakfast", "lunch", "dinner", "late night", "any"]),
      search: text("Optional word to match in name, station or tags, e.g. vegan, chicken, halal."),
      sort_by: text(
        "best_fit = ranks by how well a dish fills every macro still needed today without going over (use this for recommendations).",
        ["best_fit", "none", "protein", "carbs", "fiber", "low_calorie", "low_fat", "low_carb"],
      ),
    }),
  },
  {
    name: "log_meal",
    description: "Log foods the student ate. Nutrition is looked up from the menu; give numbers only for off-menu food, and leave out any you don't know.",
    parameters: params({
      meal: text("breakfast, lunch, dinner, or snack"),
      date: DATE,
      items: {
        type: Type.ARRAY,
        items: params({ name: text(), servings: num("Defaults to 1"), ...perNutrient((k) => num(ITEM_NOTES[k])) }, ["name"]),
      },
    }, ["items"]),
  },
  {
    name: "undo_last_log",
    description: "Remove the most recently logged food for a date (default today).",
    parameters: params({ date: text() }),
  },
  {
    name: "get_nutrition_summary",
    description: "Calories, protein, carbs, fat and fiber vs targets for a day, or daily averages over the last N days.",
    parameters: params({ date: DATE, days: num("Set to 7 for a weekly report. Defaults to 1.") }),
  },
  {
    name: "calculate_targets",
    description: "Calculate BMR, daily calories, protein, carbs, fat and fiber. Uses the saved profile, with any fields given here overriding it. Does not save.",
    parameters: params(BODY_FIELDS),
  },
  {
    name: "update_profile",
    description: "Save or change the student's body stats, optional goal and food preferences. Only send fields that changed. Targets are recalculated right away.",
    parameters: params({
      name: text(),
      ...BODY_FIELDS,
      clear_goal: flag("true to remove target_weight and timeframe_weeks"),
      setup_done: flag("true only after every first-time setup question has been asked"),
      diet: text("e.g. vegetarian, vegan, halal, none"),
      allergies: text(),
      dislikes: text(),
      preferred_hall: text(undefined, ["east", "west", "either"]),
    }),
  },
];

// Ways to sort a menu: higher comes first, and foods with no value go last instead of counting as 0.
const SORTS: Record<string, (f: Food) => number> = {
  protein: (f) => f.protein ?? -Infinity, carbs: (f) => f.carbs ?? -Infinity, fiber: (f) => f.fiber ?? -Infinity,
  low_calorie: (f) => -(f.calories ?? Infinity), low_fat: (f) => -(f.fat ?? Infinity), low_carb: (f) => -(f.carbs ?? Infinity),
};

// Tools that need the student's details. Until setup is finished they refuse and tell Gemini what to ask.
const NEEDS_SETUP = new Set(["get_menu", "log_meal", "get_nutrition_summary"]);

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  try {
    const data = await loadData();
    const targets = () => calculateTargets(data.profile);
    if (NEEDS_SETUP.has(name)) {
      const s = setupStatus(data.profile);
      if (!s.done) return `SETUP NOT FINISHED. Don't recommend or log anything yet. Tell the student you need a few details first, then ask: ${s.next}`;
    }
    switch (name) {
      case "get_menu": {
        const date = dateArg(args.date);
        const meal = str(args.meal) || "any";
        const search = str(args.search).toLowerCase();
        const sortBy = str(args.sort_by) || "best_fit";
        // For best_fit, compare each dish against what is still needed today.
        const eaten = sumNutrients(data.log[date] ?? []), x = targets();
        const fit = sortBy === "best_fit" ? (f: Food) => fitScore(f, eaten, x) : undefined;
        const rank = fit ? (f: Food) => fit(f) ?? -Infinity : SORTS[sortBy];
        const out: string[] = [];
        for (const h of hallArg(args.hall)) {
          const foods = (await getMenu(h, date)).filter((f) =>
            stationFitsMeal(f.station, meal) && `${f.name} ${f.station} ${f.tags.join(" ")}`.toLowerCase().includes(search));
          if (rank) foods.sort((a, b) => rank(b) - rank(a));
          const lines = foods.slice(0, MAX_MENU_LINES).map((f) => foodLine(f, fit?.(f)));
          out.push(`${HALLS[h].name} (${date}, ${meal}): ${lines.length ? "\n" + lines.join("\n") : "nothing listed."}`);
        }
        const note = fit ? "\nSorted by fit: higher means it fills more of today's missing macros without going over. fit N/A = missing nutrition data." : "";
        return `${out.join("\n\n")}${note}\n${MACRO_REPLY_RULE}`;
      }

      case "log_meal": {
        const date = dateArg(args.date);
        const meal = str(args.meal) || "snack";
        const items = Array.isArray(args.items) ? (args.items as Record<string, unknown>[]) : [];
        if (!items.length) return "No items given.";
        const day = (data.log[date] ??= []);
        const lines: string[] = [];
        for (const it of items) {
          const s = toNumber(it.servings);
          const servings = s !== null && s > 0 ? s : 1;
          const found = await findFood(str(it.name), date, ["east", "west"]);
          const base = found ?? perNutrient((k) => toNumber(it[k])); // off-menu: unknown values stay null
          const entry: LogEntry = {
            name: found?.name ?? str(it.name), servings, meal, time: nowTime(), source: found ? "nutrislice" : "estimate",
            ...scaleNutrients(base, servings),
          };
          day.push(entry);
          lines.push(`${dishText(`${entry.name} x${fmt(servings)}`, entry)} (${entry.source})`);
        }
        await saveData(data);
        return `Logged:\n${lines.join("\n")}\n${dayReport(sumNutrients(day), targets())}\n${MACRO_REPLY_RULE}`;
      }

      case "undo_last_log": {
        const date = dateArg(args.date);
        const removed = data.log[date]?.pop();
        if (!removed) return "Nothing logged for that day.";
        await saveData(data);
        return `Removed ${dishText(removed.name, removed)}.\n${dayReport(sumNutrients(data.log[date] ?? []), targets())}\n${MACRO_REPLY_RULE}`;
      }

      case "get_nutrition_summary": {
        const x = targets();
        const days = Math.min(Math.max(Math.round(toNumber(args.days) ?? 1), 1), 30);
        if (days === 1) {
          const date = dateArg(args.date);
          const entries = data.log[date] ?? [];
          const t = sumNutrients(entries);
          const list = entries.map((e) => `${e.time} ${e.meal}: ${e.name} x${fmt(e.servings)} (${macroLine(e)})`).join("\n");
          return `${date}: ${fmtTotals(t)}.\n${dayReport(t, x)}\n${list || "Nothing logged."}\nTargets:\n${describeTargets(x)}\n${MACRO_REPLY_RULE} In a summary, give all five totals vs their targets.`;
        }
        const lines: string[] = [];
        const loggedDays: Totals[] = [];
        for (let i = days - 1; i >= 0; i--) {
          const date = today(i);
          const entries = data.log[date] ?? [];
          if (!entries.length) { lines.push(`${date}: nothing logged (N/A)`); continue; }
          const t = sumNutrients(entries);
          loggedDays.push(t);
          lines.push(`${date}: ${fmtTotals(t, ["calories", "protein", "carbs", "fat", "fiber"])}`);
        }
        const avgBalance = loggedDays.length ? balanceText(totalsFromValues(averageDays(loggedDays)), x, "average a day") : "No logged days, so averages are N/A.";
        return `${lines.join("\n")}\nDaily average over ${loggedDays.length} logged day(s), counting only days with complete data:\n${avgBalance}\nTargets:\n${describeTargets(x)}`;
      }

      case "calculate_targets": {
        const merged: Record<string, unknown> = { ...data.profile };
        for (const [k, v] of Object.entries(args)) if (given(v)) merged[k] = v;
        return describeTargets(calculateTargets(merged));
      }

      case "update_profile": {
        const p = data.profile as Record<string, unknown>;
        if (args.clear_goal === true) { delete p.target_weight; delete p.timeframe_weeks; }
        for (const k of PROFILE_KEYS) if (given(args[k])) p[k] = args[k];
        if (args.setup_done === true) p.setup_done = true;
        await saveData(data);
        const s = setupStatus(data.profile);
        const next = !s.done ? `Setup not finished. Ask next: ${s.next}`
          : s.missing.length ? `Setup finished. These stay N/A until the student shares them: ${s.missing.join("; ")}.` : "Setup finished.";
        return `Profile saved: ${JSON.stringify(data.profile)}\n${next}\nNew targets:\n${describeTargets(targets())}`;
      }

      default:
        return `Unknown tool ${name}.`;
    }
  } catch (e) {
    return `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}