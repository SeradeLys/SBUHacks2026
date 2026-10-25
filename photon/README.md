# sbuhack2026

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

## Hackathon demo mode (one preconfigured tester)

Self-service linking needs Photon to deliver a student's text, and on the shared line Photon only delivers texts from people registered
as users of the project. For the demo, one tester is set up by hand instead. Everything is server-side, and it is off unless `DEMO_MODE=on`.
To go back to self-service linking, remove `DEMO_MODE` (or delete `demo.ts` and its few call sites).

1. **Register the tester in Photon.** Dashboard (app.photon.codes) → your project → **Users** → add the tester. First text
   `debug.photon.codes` from the tester's iPhone: it replies with the exact handle Apple sends from. Add that handle. If it is an email, either use
   the email below or switch the phone to its number (Settings → Messages → Send & Receive → "Start new conversations from").
2. **Put these in `photon/.env`:**

   | Variable | Value |
   |---|---|
   | `DEMO_MODE` | `on` |
   | `DEMO_TESTER_HANDLE` | The handle from step 1, exactly as Spectrum reports `message.sender.id`: `+15551234567` (country code needed) or an email. An email is matched as an email and never read as a phone number. |
   | `DEMO_TESTER_USER_ID` | The tester's website profile id (`u_` and 40 hex characters), from step 3. |

   Also needed as before: `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `GEMINI_API`. `IMESSAGE_LINE` is not used in demo mode.
3. **Find the profile id.** Start the agent with `DEMO_MODE=on` (leave `DEMO_TESTER_USER_ID` out), open the website on the tester's browser, and go to Profile. The
   agent prints `🧪 Demo: a website account (u_…) just connected… set DEMO_TESTER_USER_ID=u_…`. Copy that id into `.env` and restart. The id is a
   one-way hash of the browser's account key, so it grants nothing by itself. Use the same browser for the demo, because the profile lives with that browser's key.
4. **Start and look for:** `bun agent.ts` in `photon/`. You should see `📱 Spectrum connected`, `🧪 Demo mode: only the tester (…) is answered`, and both `📡 … stream is live` lines.
5. **Test:** on the website, save a profile (weight, allergies). From the tester's iPhone, text the project's iMessage number: "what do you know about me?" The reply should
   match the website. Then text "my weight is 150 lb" and reload the Profile page (or return to the tab) to see it there.
   The agent prints `🧪 demo: text from the configured tester accepted`, then `✉️ iMessage reply sent`.

How it behaves: only a sender matching `DEMO_TESTER_HANDLE` exactly reaches the AI or the profile. Everyone else gets one fixed refusal, with no AI call and no data.
Group chats never get personal data. Incomplete demo settings refuse everyone. The website uses the same authentication as before. The Profile page shows what the
backend knows: "Demo ready" only means the settings are valid and Spectrum is connected; it says "iMessage connected" only after a text from the tester has arrived
since the agent started.

## Shared profile, iMessage linking and privacy

One agent serves the website chat and iMessage, and both read and write the same saved profile.

- **Accounts.** The website has no login. Each browser creates a random account key (kept next to the profile in its private
  storage) and sends it as `Authorization: Bearer <key>`. The agent keeps only a hash of it, and stores each student's profile and
  food log in their own file under `user-data/users/` (git-ignored). Requests without a valid key get a 401.
- **Linking iMessage.** A phone number is never proof of identity on its own. On the Profile page the student taps "Link iMessage",
  gets a single-use code (10 minutes), and texts it from the number saved on their profile. Only then is that number tied to
  their account. The agent stores a hash of the number plus its last 4 digits, never the number. An iMessage sender who has not
  linked gets a private profile of their own, and group chats get no personal data.
- **Two-way sync.** Every profile change is timestamped and the newer copy wins (`profile-sync.ts`). The website pushes after
  saving and pulls on load and when the tab is focused; chat replies carry any change made over chat or iMessage.
- **Required for linking (`.env`).** `IMESSAGE_LINE` is the project's public iMessage number in +country-code form (like
  `+15551234567`), shown to students as the place to text their code. Spectrum's shared line doesn't report its number
  (`space.phone` is the word "shared"), so set it by hand; on a dedicated line it is also picked up from the first message. Linking also
  needs `SPECTRUM_PROJECT_ID` and `SPECTRUM_PROJECT_SECRET`, because a code is only confirmed by a text that arrives through Spectrum.
  Until both are in place the website says linking is unavailable and hands out no codes. The legacy `PHOTON_*` polling mode does not
  support linking.
- **Optional settings (`.env`).** `LOG_MESSAGES=on` prints message text and tool arguments to the console; it is off by default
  because they are personal. `WOLFIE_DATA_DIR` moves `user-data/`. `WEB_CHAT_ORIGINS` must include the website's address.
- **Tests.** `bun test` covers identities, linking, both sync directions, conflicts, isolation and the HTTP API, with no Gemini quota
  or real iMessage needed.

Limits to know about: there is no real sign-in, so the account key is a bearer secret (keep the agent behind HTTPS if it is
reachable from the internet); profile files are plain JSON on the agent's disk; only phone numbers can be linked, not Apple ID emails.
