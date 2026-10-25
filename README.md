# Wolfie Butler

Stony Brook dining-hall meal planner: Nutrislice menus, nutrition estimates, meal planner with a full-day plan, favourites, recipes with Medal clip links, and the Wolfie Butler chat.

Problem: The “Freshman 15” is a popular term referring to the belief that students gain 15 pounds during their first year of college. Although this figure is not representative of every student, the transition to college life can bring changes in routines, food choices, and eating habits.


Solution: By integrating Nutrislice's publicly available menu with personalized algorithms and meal-planning tools, we help students estimate their calorie intake and build meals around their goals and needs.


# Getting Started

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run 
```

To type check:

```bash
bun check
```

Run `bun fmt` to format the code.

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Recipes: ownership and database rules
- `recipes` — curated recipes, shared and read-only for ordinary users.
- `userRecipes/<uid>` — one document per person holding their own recipes (`items: [...]`). The recipe page reads the whole collection to fill Discover Recipes and only ever writes to the signed-in person's own document.
- When publishing as a claude.ai artifact, declare `capabilities: { db: { rules: [ { path: "recipes", read: "view", write: "admin" }, { path: "userRecipes", read: "view", write: "owner" }, { path: "userRecipes/{self}", write: "interact" } ] }, user: { scopes: ["profile"] }, assets: { upload: "interact" } }`. The `{self}` rule is what stops one person editing or deleting another person's recipes; hiding the delete button alone does not. Without a cloud database (local server) recipes are saved in the browser and nothing is enforced server-side.
- Curated recipes live in `data/recipes.json` (stable `r-…` ids). On load, `seedRecipes` adds any id that is missing, only for the local device store or a signed-in person with edit access to the cloud database, and never overwrites or duplicates. Recipes with a `videoId` use `thumbUrl` (`https://img.youtube.com/vi/<id>/hqdefault.jpg`) as the card image and `sourceUrl` for the "Original video on YouTube" link. There is no video player.

## Voice (ElevenLabs)
The chat can read replies aloud (speaker button under each reply) and take a spoken message (microphone beside the input). Both go through the agent in `photon/`, so the ElevenLabs key never reaches the browser.
1. Put `ELEVENLABS_API_KEY=...` in `photon/.env` (git-ignored) and restart the agent. Optional: `ELEVENLABS_VOICE_ID`, `ELEVENLABS_TTS_MODEL`, `ELEVENLABS_STT_MODEL` (see `photon/.env.example`).
2. The page asks `GET /voice/status` once; with no key set, no voice controls appear and text chat is unchanged.
3. Routes (same account key and `WEB_CHAT_ORIGINS` rules as chat): `POST /voice/tts` (`{text}` → MP3), `POST /voice/stt` (audio bytes → `{text}`). Limits: 2,000 spoken characters, 8 MB of audio (the page records at most 60 s), 40 voice requests per minute across all visitors.
4. A transcript only fills the chat box. Pressing Send uses the normal `AgentService.send`, so history, profile sync and context are unchanged. "Read new replies aloud automatically" (the speaker button by the input) is off by default; the microphone is never started automatically.
5. The microphone needs https (or localhost). The page calls the agent at `AgentService.agentUrl`, which is currently `http://localhost:8787`; for a deployed site set it to the public (tunnel) address of the agent and add the site to `WEB_CHAT_ORIGINS`.
