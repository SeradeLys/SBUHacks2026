// Run with: bun test
import { expect, test } from "bun:test";
import {
  WARNING, averageDays, calculateTargets, describeTargets, fitScore, fmt, macroPriorities, macroStatus, macroStatusText,
  remainingText, sumNutrients, toCm, toKg,
} from "./nutrition-service";

const male = { weight: 70, weight_unit: "kg", height: 175, height_unit: "cm", age: 20, sex: "male", activity_level: "moderate" };

test("converts lbs to kg by dividing by 2.20462", () => {
  expect(toKg(220.462, "lbs")).toBeCloseTo(100, 6);
});

test("converts inches to cm by multiplying by 2.54", () => {
  expect(toCm(70, "in")).toBeCloseTo(177.8, 6);
});

test("male BMR uses Mifflin-St Jeor with +5", () => {
  expect(calculateTargets(male).bmr).toBeCloseTo(1698.75, 6);
});

test("female BMR uses Mifflin-St Jeor with -161", () => {
  const t = calculateTargets({ ...male, weight: 60, height: 165, age: 22, sex: "female" });
  expect(t.bmr).toBeCloseTo(1360.25, 6);
});

test("moderately active TDEE is BMR x 1.55", () => {
  expect(calculateTargets(male).tdee).toBeCloseTo(2633.0625, 6);
});

test("sedentary TDEE is BMR x 1.2 and super active is BMR x 1.9", () => {
  expect(calculateTargets({ ...male, activity_level: "sedentary" }).tdee).toBeCloseTo(2038.5, 6);
  expect(calculateTargets({ ...male, activity_level: "super" }).tdee).toBeCloseTo(3227.625, 6);
});

test("protein is 1.4-2.2 g/kg when moderately active", () => {
  expect(calculateTargets(male).protein).toEqual({ min: expect.closeTo(98, 6), max: expect.closeTo(154, 6) });
});

test("protein is 1.0-1.2 g/kg when lightly active", () => {
  expect(calculateTargets({ ...male, activity_level: "light" }).protein).toEqual({ min: 70, max: expect.closeTo(84, 6) });
});

test("fat is 1.0 g per kg", () => {
  expect(calculateTargets(male).fat).toBe(70);
});

test("carbs are 45-65% of TDEE divided by 4", () => {
  const c = calculateTargets(male).carbs!;
  expect(c.min).toBeCloseTo(296.2195, 3);
  expect(c.max).toBeCloseTo(427.8727, 3);
});

test("fiber is 38 g for men 19-50 and 25 g for women 19-50", () => {
  expect(calculateTargets(male).fiber).toBe(38);
  expect(calculateTargets({ ...male, sex: "female" }).fiber).toBe(25);
});

test("missing sex gives N/A for BMR and TDEE, not zero", () => {
  const t = calculateTargets({ ...male, sex: undefined });
  expect(t.bmr).toBeNull();
  expect(t.tdee).toBeNull();
  expect(t.carbs).toBeNull();
  expect(t.fat).toBe(70); // still known from weight
  expect(describeTargets(t)).toContain("BMR: N/A");
});

test("weight without a unit is not guessed", () => {
  expect(calculateTargets({ ...male, weight_unit: undefined }).weightKg).toBeNull();
});

test("displayed values round to 2 decimal places", () => {
  expect(fmt(2633.0625)).toBe("2633.06");
  expect(fmt(null)).toBe("N/A");
});

test("losing 2.5 kg per week is withheld with the exact warning", () => {
  const t = calculateTargets({ ...male, target_weight: 60, timeframe_weeks: 4 });
  expect(t.goal.status).toBe("withheld");
  expect(describeTargets(t)).toContain(WARNING);
});

test("a target weight without a timeframe is withheld", () => {
  expect(calculateTargets({ ...male, target_weight: 68 }).goal.status).toBe("withheld");
});

test("losing 0.5 kg per week is allowed and lowers calories by 550 a day", () => {
  const g = calculateTargets({ ...male, weight: 80, target_weight: 76, timeframe_weeks: 8 }).goal;
  expect(g.status).toBe("ok");
  if (g.status === "ok") expect(g.calories).toBeCloseTo(calculateTargets({ ...male, weight: 80 }).tdee! - 550, 6);
});

test("a day total with a missing value shows N/A instead of counting it as zero", () => {
  const n = { calories: 300, protein: 20, carbs: 30, fat: 10, fiber: null, sugar: 5, sodium: 400 };
  const t = sumNutrients([n, { ...n, fiber: 4 }]);
  expect(t.fiber.missing).toBe(1);
  expect(remainingText(t, calculateTargets(male))).toContain("fiber N/A");
});

test("weekly averages skip days with missing data", () => {
  const n = { calories: 2000, protein: 100, carbs: 250, fat: 70, fiber: 30, sugar: 40, sodium: 2000 };
  const avg = averageDays([sumNutrients([n]), sumNutrients([{ ...n, calories: null }])]);
  expect(avg.calories).toBe(2000);
  expect(avg.protein).toBe(100);
});

// ---------- Every macro counts, not just calories and protein ----------
// Targets for `male`: 2633.06 cal, protein 98-154 g, carbs 296.22-427.87 g, fat 70 g, fiber 38 g.
const day = (o: Partial<Record<string, number | null>>) =>
  sumNutrients([{ calories: 1500, protein: 120, carbs: 200, fat: 80, fiber: 10, sugar: 20, sodium: 1000, ...o }]);
const stateOf = (o: Partial<Record<string, number | null>>, key: string) =>
  macroStatus(day(o), calculateTargets(male)).find((s) => s.key === key)!.state;

test("protein inside 98-154 g is on target, below is under, above is over", () => {
  expect(stateOf({ protein: 120 }, "protein")).toBe("on target");
  expect(stateOf({ protein: 90 }, "protein")).toBe("under");
  expect(stateOf({ protein: 160 }, "protein")).toBe("over");
});

test("carbs below the 296.22 g minimum are under target", () => {
  expect(stateOf({ carbs: 200 }, "carbs")).toBe("under");
});

test("fat counts as on target within 5% of 70 g and over above 73.5 g", () => {
  expect(stateOf({ fat: 68 }, "fat")).toBe("on target");
  expect(stateOf({ fat: 80 }, "fat")).toBe("over");
  expect(stateOf({ fat: 60 }, "fat")).toBe("under");
});

test("fiber has no ceiling, so lots of fiber is never over", () => {
  expect(stateOf({ fiber: 60 }, "fiber")).toBe("on target");
});

test("a macro with missing data is N/A, not zero", () => {
  expect(stateOf({ fiber: null }, "fiber")).toBe("N/A");
});

test("the most-behind macro is listed first and over macros are flagged", () => {
  // fiber 10/38 = 26.32%, carbs 200/296.22 = 67.52%, fat 80 g is over 70 g
  const p = macroPriorities(macroStatus(day({}), calculateTargets(male)));
  expect(p.behind).toEqual(["fiber", "carbs"]);
  expect(p.over).toEqual(["fat"]);
});

test("status text shows the amount still needed for carbs", () => {
  // carbs: 296.22 - 200 = 96.22 to the bottom, 427.87 - 200 = 227.87 to the top
  expect(macroStatusText(macroStatus(day({}), calculateTargets(male)))).toContain("Carbs: 200.00 g eaten of 296.22-427.87 g (67.52%) - UNDER, 96.22-227.87 g to go");
});

const plate = { calories: 400, protein: 30, carbs: 50, fat: 5, fiber: 8, sugar: 5, sodium: 500 };

test("when fat is already over, a fatty dish ranks below a lean one with the same calories", () => {
  const t = day({});
  const x = calculateTargets(male);
  expect(fitScore(plate, t, x)!).toBeGreaterThan(fitScore({ ...plate, carbs: 20, fat: 18 }, t, x)!);
});

test("when fiber is behind, a high-fiber dish ranks above a low-fiber one", () => {
  const t = day({ fat: 40 });
  const x = calculateTargets(male);
  expect(fitScore({ ...plate, fiber: 10 }, t, x)!).toBeGreaterThan(fitScore({ ...plate, fiber: 0 }, t, x)!);
});

test("a dish missing a macro value gets no fit score instead of counting it as zero", () => {
  expect(fitScore({ ...plate, carbs: null }, day({}), calculateTargets(male))).toBeNull();
});