# Knowledge Galaxy

An interactive 3D knowledge graph built from your markdown notes, with a voice-enabled AI butler (Jarvis) that answers questions from your notes, proves its answers by flying the camera to source notes, and grows its own brain by capturing new notes via voice.

---

## Quick start (3 steps)

### 1. Add your AI API key

Edit `config.json` (this file is NEVER served to the browser):

```json
{
  "provider": "anthropic",
  "api_key": "sk-ant-api03-your-key-here",
  "model": "claude-sonnet-4-20250514",
  "base_url": "",
  "max_tokens": 400
}
```

See `config.example.json` for ready-to-copy blocks for OpenAI, Groq, OpenRouter, Together, local Ollama, and Google Gemini.

### 2. Start the server

```bash
cd knowledge-galaxy
./start.sh            # foreground (Ctrl-C to stop)
# or
./start.sh --bg       # background
```

### 3. Open in Chrome

```
http://localhost:4700/
```

(Chrome is required for the speech-to-text mic button.)

> **Using 9Router?** 9Router is a self-hosted local gateway (runs on YOUR machine at `http://localhost:20128/v1`). Jarvis's `server.py` must run on the **same machine** as 9Router for them to connect. So: clone this repo to the machine running 9Router, then run `./start.sh` there. Your `config.json` should be:
> ```json
> {
>   "provider": "openai",
>   "api_key": "your-9router-api-key",
>   "model": "kr/claude-sonnet-4.5",
>   "base_url": "http://localhost:20128/v1/chat/completions"
> }
> ```
> Get the API key and model/combo name from your 9Router dashboard at `http://localhost:20128/dashboard`. If you run 9Router on a different host/port (e.g. a VPS), change `base_url` to match.

---

## Supported AI providers

You can use ANY of these by editing `config.json`. The `provider` field is optional — it's auto-detected from the model name (`claude*` → Anthropic, `gemini*` → Gemini, everything else → OpenAI-compatible).

| Provider | provider | model example | base_url | Where to get a key |
|---|---|---|---|---|
| **Anthropic** | `anthropic` | `claude-sonnet-4-20250514` | (default) | console.anthropic.com |
| **OpenAI** | `openai` | `gpt-4o` | (default) | platform.openai.com |
| **Groq** (fast, free tier) | `openai` | `llama-3.3-70b-versatile` | `https://api.groq.com/openai/v1/chat/completions` | console.groq.com |
| **OpenRouter** (100+ models) | `openai` | `anthropic/claude-3.5-sonnet` | `https://openrouter.ai/api/v1/chat/completions` | openrouter.ai |
| **Together AI** | `openai` | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | `https://api.together.xyz/v1/chat/completions` | api.together.ai |
| **Local Ollama** (free, offline) | `openai` | `llama3.1` | `http://localhost:11434/v1/chat/completions` | (no key needed, install ollama.com) |
| **9Router** (local gateway, routes to 40+ providers) | `openai` | `kr/claude-sonnet-4.5` | `http://localhost:20128/v1/chat/completions` | 9router.com dashboard (self-hosted) |
| **Google Gemini** | `gemini` | `gemini-1.5-flash` | (default) | aistudio.google.com |

**Why "openai" covers so many?** Groq, OpenRouter, Together, Ollama, and dozens of others all use the OpenAI-compatible Chat Completions API format. Just change the `base_url` and `model` — the code handles the rest.

### Switching providers

Just edit `config.json` and save. The server reads it on every request — **no restart needed.** Ask Jarvis a question and it'll use the new provider immediately.

---

## Troubleshooting: "I can't see the galaxy"

| Symptom | Cause | Fix |
|---|---|---|
| Blank page / 500 error | `server.py` not running | `./start.sh` |
| "I couldn't reach the model: HTTP 401" | Wrong API key | Check the key in `config.json` |
| "I couldn't reach the model: HTTP 404" | Wrong model name | Use a real model ID (see table above) |
| "I couldn't reach the model: HTTP 429" | Rate limit / no credit | Add billing credit at your provider's console |
| Mic button does nothing | Not Chrome, or mic blocked | Use Chrome, allow mic permission |
| No audio (Jarvis silent) | Browser autoplay block | Click anywhere on the page first |
| Galaxy blank but UI shows | CDN blocked (esm.sh) | Check your internet connection |
| "ECONNREFUSED localhost:4700" in Next.js logs | server.py crashed | `./start.sh` to restart |

---

## Architecture

```
knowledge-galaxy/
├── config.json              ← YOUR API KEY + provider settings (never served)
├── config.example.json      ← Copy-paste blocks for every provider
├── server.py                ← Python server (port 4700): serves viewer/ + /chat + /remember + /boot
├── start.sh                 ← Launcher (starts/restarts server.py)
├── build.py                 ← Scans notes/*.md → viewer/graph-data.js
├── notes/                   ← Your markdown notes
│   ├── Operations/ Finance/ HR/ ...   ← Organized by folder (folder = group)
│   └── captures/            ← Notes created via "remember that..."
└── viewer/
    ├── index.html           ← Cinematic 3D viewer + voice + chat (CDN libs, no build tools)
    └── graph-data.js        ← Generated graph data (nodes + links)
```

**No build tools, no npm, no frameworks.** The viewer is a single HTML file using 3D libraries from CDNs. The server is pure Python standard library. Your API key never touches the browser.

---

## ☁️ Deploy to Vercel

This repo deploys to Vercel as-is: the `viewer/` folder is served as static files, and `api/*.py` are Vercel Python serverless functions (`/api/chat`, `/api/boot`, `/api/remember`). The build step runs `build.py` to generate `viewer/graph-data.js`.

### Deploy steps

1. Push this repo to GitHub (already done if you're reading this there).

2. Go to **https://vercel.com/new** → import your repo.

3. Vercel auto-detects the Python + static setup from `vercel.json`. **No build settings to change.**

4. **Add your API key as an environment variable** (this is how Vercel keeps secrets — never commit `config.json`):
   - In the Vercel deploy dialog → **"Environment Variables"**
   - Key: `OPENROUTER_API_KEY`  →  Value: `sk-or-v1-...your key...`
   - (Optional) Key: `OPENROUTER_MODELS`  →  Value: `model-a:free,model-b:free,...` (comma-separated free model list for rotation; if omitted, uses `config.json`'s `models`)

5. Click **Deploy**. Your galaxy is live at `https://your-project.vercel.app`.

### Why it works on Vercel
- `kg_core.py` is the single source of truth — both `server.py` (local) and `api/*.py` (Vercel) import it.
- Config is **env-var first** (Vercel) with `config.json` fallback (local).
- Free-model **rotation**: if a free OpenRouter model errors (rate limit, provider down, unavailable), Jarvis automatically rotates to the next model in the list.
- `/remember` writes a real markdown note locally; on Vercel's read-only filesystem it gracefully returns the node for the **live graph update** (the note lives in the session, not on disk).

### Vercel limitations to know
- **Captured notes don't persist on Vercel** (serverless filesystem is read-only at runtime). They live in the live graph for your session. To keep captures permanently, run Jarvis locally with `./start.sh` (where it can write to `notes/captures/`).
- **Conversation history** is per-warm-instance (best-effort). Follow-ups within a few minutes work; after a cold start the butler forgets.

---

## 🔄 Free-model rotation (OpenRouter)

Set a `models` array in `config.json` (or `OPENROUTER_MODELS` env var, comma-separated). Jarvis tries them **in order**; on a rate-limit / provider error / model-unavailable it moves to the next. On an auth error (bad key) it stops immediately.

```json
{
  "provider": "openai",
  "api_key": "sk-or-v1-...",
  "base_url": "https://openrouter.ai/api/v1/chat/completions",
  "models": [
    "nvidia/nemotron-3-super-120b-a12b:free",
    "google/gemma-4-31b-it:free",
    "openai/gpt-oss-20b:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free"
  ]
}
```

Browse the current free list at https://openrouter.ai/models?max_price=0 — just paste any `:free` slugs into the `models` array.

---

## Rebuilding the graph after editing notes

```bash
python3 build.py     # re-scans notes/ and regenerates viewer/graph-data.js
```

The server also runs this automatically when you use "remember that..." to add a note (local only).

---

## File map

```
knowledge-galaxy/
├── kg_core.py              ← Shared logic (config, retrieval, LLM+rotation, handlers)
├── server.py               ← Local server (port 4700) — thin wrapper around kg_core
├── api/                    ← Vercel serverless functions (also wrap kg_core)
│   ├── chat.py             ← POST /api/chat
│   ├── boot.py             ← GET /api/boot
│   └── remember.py         ← POST /api/remember
├── vercel.json             ← Vercel config (build + static + rewrites)
├── config.json             ← YOUR API KEY (gitignored, never committed)
├── config.example.json     ← Copy-paste blocks for every provider
├── start.sh                ← Local launcher
├── build.py                ← Scans notes/*.md → viewer/graph-data.js
├── notes/                  ← Your markdown notes
└── viewer/
    ├── index.html          ← Cinematic 3D viewer + voice + chat (CDN libs)
    └── graph-data.js       ← Generated graph data
```
