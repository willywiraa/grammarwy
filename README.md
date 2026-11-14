# Grammarwy

A small web app that corrects English grammar in everyday workplace writing, such as emails, chat messages, support tickets and status updates. Behind it is an AI model: Claude from Anthropic, or Gemini from Google.

Paste a text and click **Correct My Grammar**, or press Ctrl + Enter. You get back:

| Result | What it is |
|---|---|
| **Corrected version** | Your text with only the mistakes fixed |
| **Professional** | A polished version for workplace messages and emails |
| **Natural / Casual** | A friendly, conversational version |
| **Concise** | The same message in fewer words |
| **What was fixed and why** | Up to 6 short explanations, so you learn from your mistakes |

Each version has its own **Copy** button. If your text is already correct, the app says so and leaves it unchanged.

## Highlights

- **Keeps what matters:** your formatting, line breaks, names, numbers, dates, code, file paths, URLs and technical terms stay exactly as you wrote them.
- **American English:** British spellings are changed to American ones, with a short explanation.
- **Nothing is stored:** the app keeps no copy of your text, and the server logs never contain it.
- **Password-protected online:** the whole site sits behind a password, so strangers can't use it.
- **Usage limits:** at most 10 corrections a minute and 100 a day (you can change both), with today's count under the button.
- **Works on desktop and phone**, with a simple single-column layout.
- **Tested:** about 400 automatic tests, plus optional checks against the real AI.

## Built with

[Next.js 16](https://nextjs.org) (App Router) · React 19 · TypeScript · Tailwind CSS 4 · [Zod](https://zod.dev) · the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) · the [Google Gen AI SDK](https://github.com/googleapis/js-genai) · [Upstash Redis](https://upstash.com/docs/redis) for the usage limits · Vitest and React Testing Library · [Vercel](https://vercel.com) for hosting

## How it works

```
Browser ──► password check ──► POST /api/correct ──► AI ──► checked answer ──► Browser
```

1. The page sends your text to the app's own server. The browser never talks to the AI directly, so no secret ever reaches it.
2. The server checks the text (not empty, at most 5,000 characters) and asks the AI for a reply in a fixed JSON format.
3. The server checks the reply again before the page shows it.

The server reaches the AI in one of three ways:

| Connection | Where it runs | What it costs |
|---|---|---|
| **Claude Code** | On your own computer | Nothing extra: it uses your Claude subscription (Pro or higher) |
| **Gemini API** | Anywhere, including Vercel | Free on Google's free tier, which has usage limits |
| **Anthropic API** | Anywhere, including Vercel | Billed per use, about 2 cents per correction |

## Try it on your computer

You need [Node.js 24](https://nodejs.org) and [Git](https://git-scm.com).

1. Download the code and install the packages:

   ```bash
   git clone https://github.com/willywiraa/grammarwy.git
   ```

   ```bash
   cd grammarwy
   ```

   ```bash
   npm install
   ```

2. Create your settings file from the example:

   ```bash
   cp .env.example .env.local
   ```

3. Start the app:

   ```bash
   npm run dev
   ```

4. Open http://localhost:3000.

The example settings start in **mock mode** (`USE_MOCK_AI=true`): the app shows built-in sample answers, so you can try the whole page for free, without any AI account.

### Real corrections

In `.env.local`, set `USE_MOCK_AI=false`, then pick one:

- **With a Claude subscription:** install the [Claude desktop app](https://claude.ai/download) and log in. The app finds the Claude Code that comes with it. No API key needed.
- **With a free Gemini key:** create a key in [Google AI Studio](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY` in `.env.local`.
- **With an Anthropic API key:** create a key at [platform.claude.com](https://platform.claude.com) and set `ANTHROPIC_API_KEY` in `.env.local`.

If you set up more than one, `AI_PROVIDER` picks which one the app uses.

With Gemini, the corrected text starts to appear after 1–3 seconds, and a short text is complete after 2–5 seconds. A long one, near the 5,000-character limit, takes longer to finish. If the main model writes nothing within 10 seconds, or its answer fails the app's checks, the backup model starts again, which adds a few seconds. Claude Code and the Anthropic API show the whole answer at once: with Claude Code, about 10 seconds for a short text and up to a minute for a long one.

## Settings

Settings go in `.env.local` on your computer, or in the project settings on Vercel. `.env.local` is never committed to git.

| Variable | Needed? | What it does |
|---|---|---|
| `USE_MOCK_AI` | No | `true` shows sample answers instead of asking the AI |
| `AI_PROVIDER` | No | Forces `claude-code`, `gemini` or `anthropic-api`. By default: the Anthropic API when its key is set, otherwise Gemini when its key is set or on Vercel, otherwise Claude Code. |
| `GEMINI_API_KEY` | Only for Gemini | Your Gemini API key |
| `GEMINI_MODEL` | No | Another Gemini model (default: `gemini-3.1-flash-lite`) |
| `GEMINI_FALLBACK_MODEL` | No | The backup Gemini model, asked when the main one fails or gives an unreliable answer (default: `gemini-3.5-flash-lite`; `none` turns it off) |
| `ANTHROPIC_API_KEY` | Only for the Anthropic API | Your Anthropic API key |
| `CLAUDE_CODE_PATH` | No | Where Claude Code is, if the app doesn't find it |
| `ANTHROPIC_MODEL` | No | Another Claude model (default: `claude-opus-5-5`) |
| `ANTHROPIC_EFFORT` | No | How much Claude thinks: `low` (default), `medium`, `high`, `xhigh` or `max` |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | Online | The site's user name and password. Leave both empty for `npm run dev`. |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | For the usage limits | Your Upstash database. Vercel's Upstash integration may name them `KV_REST_API_URL` and `KV_REST_API_TOKEN`; both names work. Without them, corrections aren't counted or limited. |
| `LIMIT_PER_MINUTE` | No | Corrections allowed per minute, for the whole site (default: `10`) |
| `LIMIT_PER_DAY` | No | Corrections allowed per day, for the whole site (default: `100`). The day starts at 00:00 UTC. |

## Password protection

Online, every page and API request needs the site password. Your browser shows its own login prompt.

- If either password setting is missing in production, the site refuses every request. A forgotten setting never leaves it open.
- `npm run dev` skips the password when both settings are empty.
- Use a long random password, for example 20 or more characters from a password manager.
- To log out, close the browser.

## Usage limits

The site counts corrections in a small [Upstash Redis](https://upstash.com) database, whose free plan is enough. The limits are for the whole site, not per person: they stop runaway use, for example if the password leaks, and keep the AI within its free allowance.

- **Per minute:** 10 corrections by default (`LIMIT_PER_MINUTE`).
- **Per day:** 100 corrections by default (`LIMIT_PER_DAY`). The day starts at 00:00 UTC, and the page shows that time in your own time zone.
- **Today's count** shows under the button, for example "87 of 100 corrections left today".
- **Over a limit,** the page says how long to wait, for example "Too many corrections in one minute. Please wait 20 seconds." Corrections that are turned away aren't counted.
- **The limits never stop corrections by mistake.** If no database is set up, or it doesn't answer within 1 second, the correction goes ahead uncounted and the server log says why.
- Counters are kept apart for production, preview and development, so trying things on your computer doesn't use up the live site's count.
- Sample answers (`USE_MOCK_AI=true`) aren't counted.

When Gemini's own free daily allowance runs out on both models, the page says so and tells you when it comes back, instead of saying the AI is busy.

## Deploy to Vercel

1. Fork or import this repository in [Vercel](https://vercel.com/new). The free Hobby plan is enough.
2. Under **Settings → Environment Variables**, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`, plus one AI key for real corrections. A hosted site can't use a Claude subscription, so it needs an API key:
   - `GEMINI_API_KEY` for free corrections with Gemini, or
   - `ANTHROPIC_API_KEY` for Claude, billed per use.
3. For the usage limits, open **Storage** in your Vercel project, add **Upstash for Redis** on the free plan (in the region closest to your server), and connect it to the project. It adds the database settings by itself.
4. Deploy. Every push to `main` deploys again. After you change a setting, redeploy so it takes effect.

The server code runs in Vercel's Singapore region (`sin1`), set in `vercel.json`. The Hobby plan runs it in one region, so if you're far from Singapore, change it to the [region](https://vercel.com/docs/regions) closest to you.

No API key yet? Set `USE_MOCK_AI=true` instead, and the site shows sample answers. With an Anthropic key, set a monthly spend limit on the Billing page at [platform.claude.com](https://platform.claude.com).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app at http://localhost:3000 |
| `npm run build` | Builds the production version and checks the types |
| `npm start` | Runs the production build |
| `npm run lint` | Checks the code for common mistakes |
| `npm test` | Runs all automatic tests. They never call the AI and cost nothing. |
| `npm run test:live` | Corrects 11 test texts with the real AI (the connection the app uses) and writes a report to `live-results/` |

## Privacy

Your text is sent to Anthropic or Google, depending on the connection, to be corrected. The app itself stores nothing, and its logs hold only technical data such as length, timing and token counts. The usage-limit database holds only how many corrections were made in the current minute and day. Avoid pasting passwords, credentials or other people's personal data.

**Gemini's free tier:** Google may use the texts you send to improve its products, and human reviewers may read them. Don't send confidential or personal information there. On Google's paid tier, your texts aren't used this way.

