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

## Rebuilding the graph after editing notes

```bash
python3 build.py     # re-scans notes/ and regenerates viewer/graph-data.js
```

The server also runs this automatically when you use "remember that..." to add a note.
