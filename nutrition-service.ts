// nutrition-service.ts — every nutrition calculation for the agent lives here, so the same rules apply everywhere.
// All results are estimates, not medical diagnoses or treatment.

// ---------- Fixed values ----------
export const LBS_PER_KG = 2.20462;
export const CM_PER_IN = 2.54;
const KCAL_PER_KG = 7700; // rough energy in 1 kg of body weight, used only to turn a goal into a daily number

export type Sex = "male" | "female";
export type Activity = "sedentary" | "light" | "moderate" | "very" | "super";

export const ACTIVITY_LEVELS: Record<Activity, { label: string; multiplier: number; proteinPerKg: [number, number] }> = {
  sedentary: { label: "Sedentary (little to no exercise)", multiplier: 1.2, proteinPerKg: [1.0, 1.2] },
  light: { label: "Lightly active (light exercise/sports 1-3 days/week)", multiplier: 1.375, proteinPerKg: [1.0, 1.2] },
  moderate: { label: "Moderately active (moderate exercise/sports 3-5 days/week)", multiplier: 1.55, proteinPerKg: [1.4, 2.2] },
  very: { label: "Very active (hard exercise/sports 6-7 days a week)", multiplier: 1.725, proteinPerKg: [1.4, 2.2] },
  // The protein rule covers "moderately to very active"; super active uses that same range.
  super: { label: "Super active (very hard exercise & physical job or 2x training)", multiplier: 1.9, proteinPerKg: [1.4, 2.2] },
};

// Accepted input ranges after converting to kg / cm. Outside these, the result is N/A instead of a guess.
const LIMITS = { weightKg: [30, 300], heightCm: [120, 230], age: [18, 100], weeks: [1, 104] } as const;

export const WARNING =
  "Your requested goal may not be appropriate for your individual needs. We cannot safely generate this plan automatically. Please consult a qualified healthcare professional or registered dietitian for personalized guidance.";
export const DISCLAIMER = "These numbers are estimates, not medical diagnoses or treatment.";
const FALLBACK_RESOURCE = { name: "Academy of Nutrition and Dietetics: Find a Nutrition Expert", url: "https://www.eatright.org/find-a-nutrition-expert" };

// ---------- Types ----------
export type BodyInput = {
  weight?: unknown; weight_unit?: unknown; // kg or lbs
  height?: unknown; height_unit?: unknown; // cm or in
  age?: unknown; sex?: unknown; activity_level?: unknown;
  target_weight?: unknown; timeframe_weeks?: unknown; // optional goal, target in the same unit as weight
};
export type Range = { min: number; max: number };
export type Goal =
  | { status: "none" }
  | { status: "ok"; targetKg: number; weeks: number; weeklyChangeKg: number; calories: number }
  | { status: "withheld"; reasons: string[] };
export type Targets = {
  weightKg: number | null; heightCm: number | null; age: number | null; sex: Sex | null; activity: Activity | null;
  bmr: number | null; tdee: number | null;
  protein: Range | null; carbs: Range | null; fat: number | null; fiber: number | null;
  missing: string[];
  goal: Goal;
};

// ---------- Input parsing (never turns missing into 0) ----------
export function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}
const word = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Converts with the first unit group whose names match; an unknown unit gives null instead of a guess. */
function convert(value: unknown, unit: unknown, groups: [string[], (n: number) => number][]): number | null {
  const n = toNumber(value);
  const group = groups.find(([names]) => names.includes(word(unit)));
  return n === null || !group ? null : group[1](n);
}
export const toKg = (value: unknown, unit: unknown) =>
  convert(value, unit, [[["kg", "kgs", "kilogram", "kilograms"], (n) => n], [["lb", "lbs", "pound", "pounds"], (n) => n / LBS_PER_KG]]);
export const toCm = (value: unknown, unit: unknown) =>
  convert(value, unit, [[["cm", "centimeter", "centimeters"], (n) => n], [["in", "inch", "inches"], (n) => n * CM_PER_IN]]);

function validate(label: string, raw: unknown, value: number | null, [lo, hi]: readonly [number, number], missing: string[], unit = "") {
  const problem = value === null ? (isBlank(raw) ? "missing" : "unreadable (check the number and unit)")
    : value < lo || value > hi ? `outside the supported range (${lo}-${hi}${unit})` : "";
  if (problem) missing.push(`${label} ${problem}`);
  return problem ? null : value;
}

// ---------- Core formulas ----------
export function mifflinStJeor(weightKg: number, heightCm: number, age: number, sex: Sex): number {
  return 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === "male" ? 5 : -161);
}

// Adequate Intake for fiber by age and sex (U.S. Dietary Reference Intakes).
export function fiberTarget(age: number | null, sex: Sex | null): number | null {
  if (age === null || sex === null) return null;
  if (sex === "male") return age <= 50 ? 38 : 30;
  return age <= 18 ? 26 : age <= 50 ? 25 : 21;
}

export function calculateTargets(input: BodyInput): Targets {
  const missing: string[] = [];
  const weightKg = validate("Weight", input.weight, toKg(input.weight, input.weight_unit), LIMITS.weightKg, missing, " kg");
  const heightCm = validate("Height", input.height, toCm(input.height, input.height_unit), LIMITS.heightCm, missing, " cm");
  const age = validate("Age", input.age, toNumber(input.age), LIMITS.age, missing);
  const s = word(input.sex);
  const sex: Sex | null = s === "male" || s === "female" ? s : null;
  if (!sex) missing.push("Sex (male or female, used by the BMR equation) missing");
  const a = word(input.activity_level);
  const activity: Activity | null = a in ACTIVITY_LEVELS ? (a as Activity) : null;
  if (!activity) missing.push("Activity level missing");

  const bmr = weightKg !== null && heightCm !== null && age !== null && sex ? mifflinStJeor(weightKg, heightCm, age, sex) : null;
  const tdee = bmr !== null && activity ? bmr * ACTIVITY_LEVELS[activity].multiplier : null;
  const perKg = activity ? ACTIVITY_LEVELS[activity].proteinPerKg : null;
  const protein = weightKg !== null && perKg ? { min: weightKg * perKg[0], max: weightKg * perKg[1] } : null;
  const fat = weightKg !== null ? weightKg * 1.0 : null;
  const carbs = tdee !== null ? { min: (tdee * 0.45) / 4, max: (tdee * 0.65) / 4 } : null;
  const goal = assessGoal(input, weightKg, heightCm, bmr, tdee);
  return { weightKg, heightCm, age, sex, activity, bmr, tdee, protein, carbs, fat, fiber: fiberTarget(age, sex), missing, goal };
}

// ---------- Safety check for an optional goal ----------
// Several independent signals, never BMI or one calorie number alone. Any concern withholds the plan.
export function assessGoal(input: BodyInput, weightKg: number | null, heightCm: number | null, bmr: number | null, tdee: number | null): Goal {
  if (isBlank(input.target_weight)) return { status: "none" };
  const withheld = (...reasons: string[]): Goal => ({ status: "withheld", reasons });
  const targetKg = toKg(input.target_weight, input.weight_unit);
  const weeks = toNumber(input.timeframe_weeks);
  if (targetKg === null) return withheld("target weight unreadable");
  if (weeks === null) return withheld("no timeframe given, so safety cannot be checked");
  if (weeks < LIMITS.weeks[0] || weeks > LIMITS.weeks[1]) return withheld("timeframe outside 1-104 weeks");
  if (weightKg === null || heightCm === null || bmr === null || tdee === null) return withheld("profile incomplete, so safety cannot be checked");

  const weeklyChangeKg = (targetKg - weightKg) / weeks;
  const calories = tdee + (weeklyChangeKg * KCAL_PER_KG) / 7;
  const reasons = [
    weeklyChangeKg < 0 && -weeklyChangeKg > Math.min(1, weightKg * 0.01) && "weight loss faster than about 1% of body weight (max 1 kg) per week",
    weeklyChangeKg > 0.5 && "weight gain faster than about 0.5 kg per week",
    calories < bmr && "daily calories would fall below the estimated BMR",
    targetKg / (heightCm / 100) ** 2 < 18.5 && "target weight is in the underweight range for this height",
  ].filter((r): r is string => !!r);
  return reasons.length ? withheld(...reasons) : { status: "ok", targetKg, weeks, weeklyChangeKg, calories };
}

// ---------- Food totals ----------
export const NUTRIENTS = ["calories", "protein", "carbs", "fat", "fiber", "sugar", "sodium"] as const;
export type NutrientKey = (typeof NUTRIENTS)[number];
export type Nutrients = Record<NutrientKey, number | null>;
export const UNITS: Record<NutrientKey, string> = {
  calories: "cal", protein: "g protein", carbs: "g carbs", fat: "g fat", fiber: "g fiber", sugar: "g sugar", sodium: "mg sodium",
};
export type Total = { value: number; missing: number }; // value = sum of known items, missing = items without data
export type Totals = Record<NutrientKey, Total>;

/** Builds a record with one value per nutrient. */
export const perNutrient = <T>(f: (k: NutrientKey) => T) => Object.fromEntries(NUTRIENTS.map((k) => [k, f(k)])) as Record<NutrientKey, T>;

export const scaleNutrients = (n: Nutrients, servings: number): Nutrients => perNutrient((k) => (n[k] === null ? null : n[k] * servings));

export const sumNutrients = (entries: Nutrients[]): Totals =>
  perNutrient((k) => {
    const known = entries.map((e) => e[k]).filter((v): v is number => v !== null && v !== undefined);
    return { value: known.reduce((a, b) => a + b, 0), missing: entries.length - known.length };
  });

/** A total is only a real number when every item had data; otherwise it's N/A. */
export const completeValue = (t: Total): number | null => (t.missing ? null : t.value);

// Daily averages, counting only days where that nutrient is complete.
export const averageDays = (days: Totals[]): Record<NutrientKey, number | null> =>
  perNutrient((k) => {
    const vals = days.map((d) => completeValue(d[k])).filter((v): v is number => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

/** Turn daily averages into Totals so they can be checked with macroStatus. */
export const totalsFromValues = (v: Record<NutrientKey, number | null>): Totals =>
  perNutrient((k) => (v[k] === null ? { value: 0, missing: 1 } : { value: v[k], missing: 0 }));

// ---------- Display (2 decimal places, N/A for missing) ----------
export const fmt = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) ? "N/A" : v.toFixed(2));
const fmtRange = (r: Range | null) => (r ? `${fmt(r.min)}-${fmt(r.max)}` : "N/A");

export const fmtTotal = (t: Total, unit: string): string =>
  t.missing ? `N/A ${unit} (incomplete: ${t.missing} item${t.missing > 1 ? "s" : ""} missing data, known part ${fmt(t.value)})` : `${fmt(t.value)} ${unit}`;
export const fmtTotals = (t: Totals, keys: readonly NutrientKey[] = NUTRIENTS): string => keys.map((k) => fmtTotal(t[k], UNITS[k])).join(", ");

export const calorieTarget = (x: Targets): number | null => (x.goal.status === "ok" ? x.goal.calories : x.tdee);

export function remainingText(t: Totals, x: Targets): string {
  const left = (target: number | null, eaten: Total) => {
    const e = completeValue(eaten);
    return target === null || e === null ? null : target - e;
  };
  const range = (r: Range | null, eaten: Total) => {
    const lo = r ? left(r.min, eaten) : null;
    return lo === null || !r ? "N/A" : `${fmt(lo)} to ${fmt(left(r.max, eaten))}`;
  };
  return `Left today (estimates): ${fmt(left(calorieTarget(x), t.calories))} cal, protein ${range(x.protein, t.protein)} g, carbs ${range(x.carbs, t.carbs)} g, fat ${fmt(left(x.fat, t.fat))} g, fiber ${fmt(left(x.fiber, t.fiber))} g.`;
}

// ---------- Balance across every macro (not just calories and protein) ----------
export const MACROS = ["protein", "carbs", "fat", "fiber"] as const;
export type MacroKey = (typeof MACROS)[number];
type Tracked = "calories" | MacroKey;
const TRACKED: readonly Tracked[] = ["calories", ...MACROS];
const label = (k: Tracked) => k.charAt(0).toUpperCase() + k.slice(1);
const unitOf = (k: Tracked) => (k === "calories" ? " cal" : " g");
/** Single-number targets (calories, fat) count as "on target" within this share of the target. */
export const SINGLE_TARGET_TOLERANCE = 0.05;
/** How much more going over a limit costs than filling the same amount of a need, when ranking foods. */
const OVERSHOOT_PENALTY = 2;

export type Band = { min: number | null; max: number | null; single: boolean };
/** Daily goal band: protein and carbs are ranges, calories and fat are one number, fiber is a minimum with no ceiling. */
export function macroBands(x: Targets): Record<Tracked, Band> {
  const one = (v: number | null): Band => ({ min: v, max: v, single: true });
  const range = (r: Range | null): Band => ({ min: r?.min ?? null, max: r?.max ?? null, single: false });
  return { calories: one(calorieTarget(x)), protein: range(x.protein), carbs: range(x.carbs), fat: one(x.fat), fiber: { min: x.fiber, max: null, single: false } };
}

export type MacroState = "under" | "on target" | "over" | "N/A";
export type MacroStatus = {
  key: Tracked; eaten: number | null; band: Band; state: MacroState;
  percent: number | null; // eaten as a % of the target (the minimum for ranges)
  toGo: Range | null; // amount still needed to reach the band (min = to its bottom, max = to its top)
  overBy: number | null;
};

export function macroStatus(t: Totals, x: Targets): MacroStatus[] {
  const bands = macroBands(x);
  return TRACKED.map((key) => {
    const band = bands[key];
    const eaten = completeValue(t[key]);
    const empty = { key, eaten, band, state: "N/A" as MacroState, percent: null, toGo: null, overBy: null };
    if (eaten === null || band.min === null) return empty;
    const tol = band.single && band.max !== null ? SINGLE_TARGET_TOLERANCE : 0;
    const lo = band.min * (1 - tol);
    const hi = band.max === null ? null : band.max * (1 + tol);
    const top = band.max ?? Infinity;
    return {
      ...empty,
      state: eaten < lo ? "under" : hi !== null && eaten > hi ? "over" : "on target",
      percent: band.min > 0 ? (eaten / band.min) * 100 : null,
      toGo: eaten < top ? { min: Math.max(0, band.min - eaten), max: top - eaten } : null,
      overBy: band.max !== null && eaten > band.max ? eaten - band.max : null,
    };
  });
}

function bandText(b: Band, unit: string): string {
  if (b.min === null) return "N/A";
  if (b.max === null) return `at least ${fmt(b.min)}${unit}`;
  return b.single || b.min === b.max ? `${fmt(b.min)}${unit}` : `${fmt(b.min)}-${fmt(b.max)}${unit}`;
}

/** One line per macro: eaten, target, state and what is left. */
export function macroStatusText(list: MacroStatus[], eatenLabel = "eaten"): string {
  return list.map((s) => {
    const u = unitOf(s.key);
    const head = `${label(s.key)}: ${fmt(s.eaten)}${s.eaten === null ? "" : u} ${eatenLabel} of ${bandText(s.band, u)}`;
    if (s.state === "N/A") return `${head} - N/A (${s.eaten === null ? "incomplete data" : "target unavailable"})`;
    const pct = s.percent === null ? "" : ` (${fmt(s.percent)}%)`;
    if (s.state === "over") return `${head}${pct} - OVER by ${fmt(s.overBy)}${u}`;
    const left = !s.toGo ? "" : s.toGo.max === Infinity
      ? s.toGo.min > 0 ? `, ${fmt(s.toGo.min)}${u} to go` : ""
      : s.toGo.min > 0 && s.toGo.min !== s.toGo.max ? `, ${fmt(s.toGo.min)}-${fmt(s.toGo.max)}${u} to go` : `, up to ${fmt(s.toGo.max)}${u} more`;
    return `${head}${pct} - ${s.state.toUpperCase()}${left}`;
  }).join("\n");
}

/** Macros still under target, most behind first, plus any that are already over. */
export function macroPriorities(list: MacroStatus[]): { behind: MacroKey[]; over: Tracked[]; text: string } {
  const macros = list.filter((s): s is MacroStatus & { key: MacroKey } => s.key !== "calories");
  const behind = macros.filter((s) => s.state === "under" && s.percent !== null).sort((a, b) => a.percent! - b.percent!);
  const over = list.filter((s) => s.state === "over").map((s) => s.key);
  const unknown = macros.filter((s) => s.state === "N/A").map((s) => s.key);
  const text = [
    behind.length ? `Most behind: ${behind.map((s) => `${s.key} (${fmt(s.percent)}% of target)`).join(", ")}.` : "No macro is under target.",
    over.length ? `Already over: ${over.join(", ")}. Steer away from foods heavy in these.` : "",
    unknown.length ? `Unknown (N/A): ${unknown.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
  return { behind: behind.map((s) => s.key), over, text };
}

/**
 * How well one serving fills what is still needed today across calories, protein, carbs, fat and fiber.
 * Each macro scores the share of its daily target this food fills (up to what is still needed),
 * minus a larger penalty for any amount that pushes it past its top. Higher is better.
 * Null when the food is missing a value we need to judge it (never counted as 0).
 * A macro whose target or eaten-so-far is unknown is skipped for every food alike.
 */
export function fitScore(food: Nutrients, t: Totals, x: Targets): number | null {
  const bands = macroBands(x);
  let score = 0;
  for (const key of TRACKED) {
    const { min, max } = bands[key];
    const eaten = completeValue(t[key]);
    if (min === null || eaten === null || min <= 0) continue;
    const f = food[key];
    if (f === null || f === undefined) return null;
    if (key !== "calories") score += Math.min(f, Math.max(0, min - eaten)) / min;
    if (max !== null && max > 0) score -= (OVERSHOOT_PENALTY * (Math.max(0, eaten + f - max) - Math.max(0, eaten - max))) / max;
  }
  return score;
}

export function healthResource(): { name: string; url: string } {
  const url = process.env.HEALTH_RESOURCE_URL?.trim();
  return url ? { name: process.env.HEALTH_RESOURCE_NAME?.trim() || "Your health service", url } : FALLBACK_RESOURCE;
}

export function describeTargets(x: Targets): string {
  const lines = [
    `BMR: ${fmt(x.bmr)} kcal/day`,
    `Estimated daily calories (TDEE): ${fmt(x.tdee)} kcal/day`,
    `Protein: ${fmtRange(x.protein)} g/day`,
    `Carbohydrates: ${fmtRange(x.carbs)} g/day`,
    `Fat: ${fmt(x.fat)} g/day`,
    `Fiber: ${fmt(x.fiber)} g/day`,
  ];
  const g = x.goal;
  if (x.missing.length) lines.push(`Incomplete: ${x.missing.join("; ")}.`);
  if (g.status === "ok")
    lines.push(`Goal: ${fmt(g.targetKg)} kg in ${fmt(g.weeks)} weeks (${fmt(g.weeklyChangeKg)} kg/week). Goal calories: ${fmt(g.calories)} kcal/day.`);
  if (g.status === "withheld") {
    const r = healthResource();
    lines.push(`GOAL PLAN WITHHELD (${g.reasons.join("; ")}). Say exactly: "${WARNING}" Then share: ${r.name} ${r.url}`);
  }
  return [...lines, DISCLAIMER].join("\n");
}