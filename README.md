# Wolfie Butler (NutriPlan) — code export

Stony Brook dining-hall meal planner: Nutrislice menus, nutrition estimates, meal planner with a full-day plan, favourites, recipes with Medal clip links, and the Wolfie Butler chat.

## Files
- `index.html` — standalone page. Open it in any browser or host it on any static host (GitHub Pages, Netlify, Vercel).
- `wolfie-butler-artifact.html` — the exact source published as the claude.ai artifact (no doctype/head; claude.ai adds those).
- `data/west--2026-10-23.json`, `data/east--2026-10-23.json` — Oct 23, 2026 menus parsed from the Nutrislice API, in the app's menu format.
- `data/recipes.json` — the six starter recipes.

## Running outside claude.ai
Everything runs in one file, with no build step. Outside claude.ai, the claude.ai-only features fall back automatically:
- **Cloud database** (shared menus/recipes, private profile/plan/favourites) → saved in the browser's localStorage instead. Use **Import menu** to load Nutrislice JSON.
- **Wolfie Butler chat** runs on the viewer's Claude account through the claude.ai runtime, so it's unavailable outside claude.ai. That's the slot to connect your own backend (Gemini, Photon) — see `AgentService.send` in the script.
- **Photo/icon uploads** need the claude.ai assets store. Set image paths directly in `CONFIG` instead.

## Where to change things
At the top of the `<script>`, in `CONFIG`:
- `hallImages` — West/East dining hall image paths.
- `chatIcon` — chatbot icon path.
- `activity`, `carbPct`, `fatPerKg`, `fiberRef`, `safety`, `dayShares`, `calTolerance` — nutrition and planning settings.
- `healthResources` — health links.

Code layout inside the script: `NutritionService` (BMR/TDEE/targets, meal totals, goal safety) · `MenuProvider` (Nutrislice parser) · `MealPlanService` · `DayPlanService` (±50 kcal day plan) · `RecommendationService` · `MedalProvider` · `Store` (persistence) · views and event handlers.

## Nutrislice API
`https://stonybrook.api.nutrislice.com/menu/api/weeks/school/{west-side-dining|east-side-dining}/menu-type/{todays-dine-in-specials-wsd|todays-dine-in-specials-esd}/YYYY/MM/DD/?format=json`
A browser page can't fetch this directly (cross-origin), so either paste the JSON into **Import menu** or fetch it from a small server.

Nutrition values are estimates, not medical advice.
