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
- **Works on desktop and phone**, with a simple single-column layout.
- **Tested:** about 250 automatic tests, plus optional checks against the real AI.

## Built with

[Next.js 16](https://nextjs.org) (App Router) · React 19 · TypeScript · Tailwind CSS 4 · [Zod](https://zod.dev) · the [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) · the [Google Gen AI SDK](https://github.com/googleapis/js-genai) · Vitest and React Testing Library · [Vercel](https://vercel.com) for hosting

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

A short text takes a few seconds (about 10 with Claude Code). A long one, near the 5,000-character limit, can take up to a minute. When Google's free tier is busy, a Gemini answer can take a minute or two: the app sends a request again if it waits too long.

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

## Password protection

Online, every page and API request needs the site password. Your browser shows its own login prompt.

- If either password setting is missing in production, the site refuses every request. A forgotten setting never leaves it open.
- `npm run dev` skips the password when both settings are empty.
- Use a long random password, for example 20 or more characters from a password manager.
- To log out, close the browser.

## Deploy to Vercel

1. Fork or import this repository in [Vercel](https://vercel.com/new). The free Hobby plan is enough.
2. Under **Settings → Environment Variables**, set `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD`, plus one AI key for real corrections. A hosted site can't use a Claude subscription, so it needs an API key:
   - `GEMINI_API_KEY` for free corrections with Gemini, or
   - `ANTHROPIC_API_KEY` for Claude, billed per use.
3. Deploy. Every push to `main` deploys again. After you change a setting, redeploy so it takes effect.

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

Your text is sent to Anthropic or Google, depending on the connection, to be corrected. The app itself stores nothing, and its logs hold only technical data such as length, timing and token counts. Avoid pasting passwords, credentials or other people's personal data.

**Gemini's free tier:** Google may use the texts you send to improve its products, and human reviewers may read them. Don't send confidential or personal information there. On Google's paid tier, your texts aren't used this way.

