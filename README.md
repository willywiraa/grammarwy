# Grammarwy

A small web app that corrects English grammar in everyday workplace writing, such as emails, chat messages, support tickets and status updates. Behind it is Claude, Anthropic's AI model.

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
- **Your text stays private:** nothing is stored, and the server logs never contain your text.
- **Password-protected online:** the whole site sits behind a password, so strangers can't use it.
- **Works on desktop and phone**, with a simple single-column layout.
- **Tested:** about 210 automatic tests, plus optional checks against the real AI.

## Built with

[Next.js 16](https://nextjs.org) (App Router) · React 19 · TypeScript · Tailwind CSS 4 · [Zod](https://zod.dev) · the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) · Vitest and React Testing Library · [Vercel](https://vercel.com) for hosting

## How it works

```
Browser ──► password check ──► POST /api/correct ──► Claude ──► checked answer ──► Browser
```

1. The page sends your text to the app's own server. The browser never talks to the AI directly, so no secret ever reaches it.
2. The server checks the text (not empty, at most 5,000 characters) and asks Claude for a reply in a fixed JSON format.
3. The server checks the reply again before the page shows it.

The server reaches Claude in one of two ways:

| Connection | Where it runs | What it costs |
|---|---|---|
| **Claude Code** | On your own computer | Nothing extra: it uses your Claude subscription (Pro or higher) |
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
- **With an API key:** create a key at [platform.claude.com](https://platform.claude.com) and set `ANTHROPIC_API_KEY` in `.env.local`.

A short text takes about 10 seconds. A long one, near the 5,000-character limit, can take up to a minute.

## Settings

Settings go in `.env.local` on your computer, or in the project settings on Vercel. `.env.local` is never committed to git.

| Variable | Needed? | What it does |
|---|---|---|
| `USE_MOCK_AI` | No | `true` shows sample answers instead of asking Claude |
| `ANTHROPIC_API_KEY` | Only for the API | Your Anthropic API key |
| `AI_PROVIDER` | No | Forces `claude-code` or `anthropic-api`. By default: the API when a key is set or on Vercel, otherwise Claude Code. |
| `CLAUDE_CODE_PATH` | No | Where Claude Code is, if the app doesn't find it |
| `ANTHROPIC_MODEL` | No | Another Claude model (default: `claude-opus-5-5`) |
| `ANTHROPIC_EFFORT` | No | How much Claude thinks: `low` (default), `medium`, `high`, `xhigh` or `max` |
| `BASIC_AUTH_USER`, `BASIC_AUTH_PASSWORD` | Online | The site's user name and password. Leave both empty for `npm run dev`. |

## Password protection

Online, every page and API request needs the site password. Your browser shows its own login prompt.

- If either password setting is missing in production, the site refuses every request. A forgotten setting never leaves it open.
- `npm run dev` skips the password when both settings are empty.
- Use a long random password, for example 20 or more characters from a password manager.
- To log out, close the browser.

## Deploy to Vercel

1. Fork or import this repository in [Vercel](https://vercel.com/new). The free Hobby plan is enough.
2. Under **Settings → Environment Variables**, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`, plus `ANTHROPIC_API_KEY` for real corrections. A hosted site can't use a Claude subscription, so it needs an API key.
3. Deploy. Every push to `main` deploys again.

No API key yet? Set `USE_MOCK_AI=true` instead, and the site shows sample answers. If you use a key, set a monthly spend limit on the Billing page at [platform.claude.com](https://platform.claude.com).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Starts the app at http://localhost:3000 |
| `npm run build` | Builds the production version and checks the types |
| `npm start` | Runs the production build |
| `npm run lint` | Checks the code for common mistakes |
| `npm test` | Runs all automatic tests. They never call the AI and cost nothing. |
| `npm run test:live` | Corrects 11 test texts with the real Claude and writes a report to `live-results/` |

## Privacy

Your text is sent to Anthropic to be corrected. The app itself stores nothing, and its logs hold only technical data such as length, timing and token counts. Avoid pasting passwords, credentials or other people's personal data.

