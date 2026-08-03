#!/usr/bin/env python3
"""Knowledge Galaxy core logic — shared by server.py (local) and api/*.py (Vercel).

Single source of truth for: config loading (env vars first, then config.json),
note indexing, keyword retrieval, butler prompts, per-session history, the
multi-provider LLM call WITH free-model rotation, and the /chat + /remember
handlers. No HTTP code lives here — callers wrap it.
"""

import datetime
import json
import os
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

BASE = os.path.dirname(os.path.abspath(__file__))
NOTES_DIR = os.path.join(BASE, "notes")
CONFIG_PATH = os.path.join(BASE, "config.json")
PLACEHOLDER_KEY = "PUT-YOUR-KEY-HERE"

PROVIDER_DEFAULTS = {
    "anthropic": "https://api.anthropic.com/v1/messages",
    "openai":    "https://api.openai.com/v1/chat/completions",
    "gemini":    "https://generativelanguage.googleapis.com/v1beta/models",
}


# --------------------------------------------------------------------------
# .env loader (stdlib only). Loads .env at import so the key works locally
# from a single gitignored file. Vercel injects env vars directly (no .env
# needed there), but this keeps both paths identical.
# --------------------------------------------------------------------------
ENV_PATH = os.path.join(BASE, ".env")


def _load_dotenv():
    """Populate os.environ from a .env file (KEY=value lines). Stdlib only.

    Does NOT overwrite vars already in the environment (real env wins, which
    is what Vercel needs). Skips blank/comment lines. Strips optional quotes.
    """
    if not os.path.isfile(ENV_PATH):
        return
    try:
        with open(ENV_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip()
                # Strip surrounding quotes if present.
                if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                    val = val[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = val
    except Exception:
        pass  # Never let a malformed .env break the app.


_load_dotenv()


# Reuse build.py's scanner so server-side note ids match viewer/graph-data.js.
sys.path.insert(0, BASE)
import build as build_mod  # noqa: E402

# --------------------------------------------------------------------------
# Tokenizer + stopwords
# --------------------------------------------------------------------------
STOPWORDS = set(
    "a an and are as at be by for from has have in is it its of on or that the to "
    "was were will with this these those i you he she we they me my your our their "
    "do does did not no yes can could should would may might must shall about into "
    "over under again more most some such only own same so than too very just what "
    "which who whom whose when where why how to if then there here up down out".split()
)


def _tokenize(text):
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 1 and w not in STOPWORDS]


SMALLTALK_EXACT = {
    "hi", "hello", "hey", "hiya", "yo", "howdy", "greetings",
    "good morning", "good afternoon", "good evening", "good night",
    "thanks", "thank you", "cheers", "ta", "bye", "goodbye",
    "how are you", "how are you?", "how do you do", "how's it going",
    "whats up", "what's up", "sup", "you ok", "you okay",
    "tell me a joke", "say something funny", "make me laugh",
    "who are you", "who are you?", "what are you", "what can you do",
    "what can you do?", "help",
}
SMALLTALK_HINTS = (
    "joke", "funny", "laugh", "thank", "thanks", "cheers", "goodbye", "bye",
    "morning", "evening", "afternoon", "weekend",
)


def is_smalltalk(question):
    """Heuristic: is this chit-chat rather than a question about the notes?"""
    q = re.sub(r"[^a-z0-9 '?]+", " ", question.lower()).strip()
    q = re.sub(r"\s+", " ", q)
    if not q:
        return True
    if q in SMALLTALK_EXACT:
        return True
    toks = [w for w in re.findall(r"[a-z0-9']+", q) if w]
    if len(toks) <= 3 and any(t in SMALLTALK_HINTS for t in toks):
        return True
    if len(toks) <= 3 and toks and toks[0] in {"hi", "hello", "hey", "hiya", "yo", "howdy", "greetings"}:
        return True
    if "joke" in q or "say something funny" in q or "make me laugh" in q:
        return True
    if re.match(r"^(who|what) (are|is) (you|this|jarvis)\b", q):
        return True
    return False


# --------------------------------------------------------------------------
# Note index (ids match graph-data.js). Built at import; refreshable.
# --------------------------------------------------------------------------
NOTES = []
NOTES_LOCK = threading.Lock()


def _index_notes():
    """(Re)scan notes/ and populate the in-memory index with scoring fields."""
    global NOTES
    nodes = build_mod.scan_nodes()
    for n in nodes:
        raw = open(os.path.join(NOTES_DIR, n["path"]), encoding="utf-8", errors="replace").read()
        n["_prose_orig"] = build_mod.strip_markdown(raw)
        n["_tokens"] = Counter(_tokenize(n["_prose"]))
        n["_title_tokens"] = set(_tokenize(n["label"]))
    with NOTES_LOCK:
        NOTES = nodes


_index_notes()


def note_count():
    with NOTES_LOCK:
        return len(NOTES)


# --------------------------------------------------------------------------
# Retrieval: keyword overlap (title matches weigh extra, light prefix match)
# --------------------------------------------------------------------------
def _token_match(qt, nt):
    if qt == nt:
        return True
    if len(qt) >= 4 and len(nt) >= 4 and (nt.startswith(qt) or qt.startswith(nt)):
        return True
    return False


def select_notes(question, k=6):
    qtoks = list(dict.fromkeys(_tokenize(question)))
    with NOTES_LOCK:
        snapshot = list(NOTES)
    scored = []
    for n in snapshot:
        ntokens = n["_tokens"]
        title_toks = n["_title_tokens"]
        score = 0
        for qt in qtoks:
            c = 0
            for nt, cnt in ntokens.items():
                if cnt and _token_match(qt, nt):
                    c += cnt
            if c > 0:
                in_title = any(_token_match(qt, tt) for tt in title_toks)
                score += c * 3 + 8 if in_title else c
        if score > 0:
            scored.append((score, n))
    scored.sort(key=lambda x: -x[0])
    return [n for _, n in scored[:k]], qtoks


def build_context(notes):
    parts = []
    for n in notes:
        text = n["_prose_orig"]
        if len(text) > 1800:
            cut = text[:1800]
            space = cut.rfind(" ")
            if space > 1200:
                cut = cut[:space]
            text = cut.rstrip() + "\u2026"
        parts.append("[%d] %s (%s)\n%s" % (n["id"], n["label"], n["group"], text))
    return "\n\n".join(parts)


# --------------------------------------------------------------------------
# Prompts (butler persona)
# --------------------------------------------------------------------------
SYSTEM_PROMPT = (
    "You are Jarvis, the in-house butler for a small coffee roastery called Maple "
    "Street Roasters. Your manner is that of a dry, impeccably polite British "
    "butler with a razor wit \u2014 think Jeeves by way of Stephen Fry. "
    "PERSONALITY: unflappable, quietly amused, never fawning. Address the user as "
    "\"sir\" occasionally (not every sentence). One genuinely funny line beats "
    "three bland ones. \n\n"
    "ANSWERING ABOUT THE NOTES: Answer ONLY from the note excerpts under NOTES. "
    "Respond in ONE witty sentence plus the facts \u2014 be concise. Never recite or "
    "paraphrase a note back; the user can already see it on screen, so add wit "
    "and synthesis, not repetition. If the notes do not cover it, say so plainly "
    "(with a touch of dry humor) and do not invent facts, names, numbers, "
    "procedures, or dates. For follow-ups, use prior context but stay grounded "
    "in the notes."
)

SMALLTALK_PROMPT = (
    "You are Jarvis, the in-house butler for a small coffee roastery called Maple "
    "Street Roasters. Your manner is that of a dry, impeccably polite British "
    "butler with a razor wit. Address the user as \"sir\" occasionally (not every "
    "sentence). The user is making small talk, a joke, or a pleasantry \u2014 NOT asking "
    "about the notes. Respond in ONE or TWO sentences, in character, with quiet wit. "
    "Do not mention the notes, do not pretend to look anything up, and do not claim "
    "to have retrieved anything. Stay warm, brief, and funny."
)


# --------------------------------------------------------------------------
# Per-session conversation history (in-memory, best-effort on serverless)
# --------------------------------------------------------------------------
SESSIONS = {}
SESSION_LOCK = threading.Lock()
MAX_HISTORY = 12


def _record_turn(session_id, question, answer):
    with SESSION_LOCK:
        hist = SESSIONS.setdefault(session_id, [])
        hist.append({"role": "user", "content": question})
        if answer is not None:
            hist.append({"role": "assistant", "content": answer})
        del hist[:-MAX_HISTORY]


# --------------------------------------------------------------------------
# Config: env vars first (Vercel), then config.json (local)
# --------------------------------------------------------------------------
def load_config():
    """Build a config dict from env vars (Vercel) with config.json fallback."""
    cfg = {}
    # Try config.json first as the base (local dev).
    if os.path.isfile(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, encoding="utf-8") as f:
                cfg = json.load(f)
        except Exception:
            cfg = {}
    # Env vars override (Vercel sets these in the dashboard).
    env_key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("API_KEY")
    if env_key:
        cfg["api_key"] = env_key
        # If an OpenRouter key is set via env, assume OpenRouter defaults.
        cfg.setdefault("provider", "openai")
        cfg.setdefault("base_url", "https://openrouter.ai/api/v1/chat/completions")
    env_models = os.environ.get("OPENROUTER_MODELS") or os.environ.get("MODELS")
    if env_models:
        cfg["models"] = [m.strip() for m in env_models.split(",") if m.strip()]
    env_provider = os.environ.get("LLM_PROVIDER")
    if env_provider:
        cfg["provider"] = env_provider.lower()
    env_base = os.environ.get("LLM_BASE_URL")
    if env_base:
        cfg["base_url"] = env_base
    env_model = os.environ.get("LLM_MODEL")
    if env_model:
        cfg["model"] = env_model
    return cfg


def _has_real_key(config):
    k = (config.get("api_key") or "").strip()
    return bool(k) and k != PLACEHOLDER_KEY


def _provider(config):
    p = (config.get("provider") or "").strip().lower()
    if not p:
        models = _resolve_models(config)
        m = (models[0] if models else (config.get("model") or "")).lower()
        if m.startswith("claude"):
            p = "anthropic"
        elif m.startswith("gemini"):
            p = "gemini"
        else:
            p = "openai"
    return p


def _resolve_models(config):
    """Ordered list of models to try (rotation). Falls back to single model."""
    models = config.get("models")
    if isinstance(models, list) and models:
        return [m for m in models if m]
    m = (config.get("model") or "").strip()
    return [m] if m else []


def _endpoint(config, provider, model=""):
    custom = (config.get("base_url") or "").strip()
    if provider == "gemini":
        base = custom.rstrip("/") if custom else PROVIDER_DEFAULTS["gemini"]
        return base.rstrip("/") + "/" + (model or config.get("model", "")) + ":generateContent"
    return custom.rstrip("/") if custom else PROVIDER_DEFAULTS[provider]


def _placeholder_msg():
    return ("Charmed, I'm sure. I'd respond with rather more wit, sir, but no "
            "API key is set \u2014 paste one into config.json (or set OPENROUTER_API_KEY) "
            "and I'll be in full voice.")


# --------------------------------------------------------------------------
# Multi-provider LLM call WITH free-model rotation
# --------------------------------------------------------------------------
def _http_json(url, data, headers, timeout=60, label="LLM"):
    body = json.dumps(data).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError("%s HTTP %d: %s" % (label, e.code, detail))
    except urllib.error.URLError as e:
        raise RuntimeError("Network error reaching %s: %s" % (label, e.reason))
    except Exception as e:
        raise RuntimeError("%s request failed: %s" % (label, e))


def _is_retryable(err):
    """Should we rotate to the next model on this error?"""
    s = str(err)
    # 401 = bad auth — no point rotating, the key is wrong.
    if "HTTP 401" in s:
        return False
    # 400 is ambiguous on free models (content policy, bad params) — retry.
    # 404 = model unavailable (common on free tier) — retry.
    # 429 = rate limit — retry.
    # 5xx = provider down — retry.
    return True


def call_llm(config, system, messages):
    """Call the configured provider, rotating through `models` on failure.

    Tries each model in order; on a retryable error (429/5xx/provider error/
    model-unavailable) it moves to the next. Stops immediately on auth errors.
    Returns the first successful text answer, or raises the last error.
    """
    provider = _provider(config)
    api_key = (config.get("api_key") or "").strip()
    models = _resolve_models(config)
    max_tokens = int(config.get("max_tokens") or 400)
    if not models:
        raise RuntimeError("No model configured (set 'model' or 'models' in config.json, or LLM_MODEL env).")

    last_err = None
    for m in models:
        endpoint = _endpoint(config, provider, m)
        try:
            if provider == "anthropic":
                return _call_anthropic(endpoint, api_key, m, max_tokens, system, messages)
            if provider == "openai":
                return _call_openai(endpoint, api_key, m, max_tokens, system, messages)
            if provider == "gemini":
                return _call_gemini(endpoint, api_key, m, max_tokens, system, messages)
            raise RuntimeError("Unknown provider: %r" % provider)
        except Exception as e:
            last_err = e
            if not _is_retryable(e):
                raise
            # try next model
    raise last_err


def _call_anthropic(url, api_key, model, max_tokens, system, messages):
    payload = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01", "content-type": "application/json"}
    out = _http_json(url, payload, headers, label="Anthropic")
    parts = [b.get("text", "") for b in out.get("content", []) if b.get("type") == "text"]
    return "".join(parts).strip() or "(the model returned no answer)"


def _call_openai(url, api_key, model, max_tokens, system, messages):
    full = [{"role": "system", "content": system}] + messages
    payload = {"model": model, "max_tokens": max_tokens, "messages": full}
    headers = {"Authorization": "Bearer " + api_key, "content-type": "application/json"}
    out = _http_json(url, payload, headers, label="OpenAI")
    choices = out.get("choices") or []
    if not choices:
        return "(the model returned no answer)"
    return (choices[0].get("message", {}).get("content") or "").strip() or "(the model returned no answer)"


def _call_gemini(url, api_key, model, max_tokens, system, messages):
    contents = []
    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})
    payload = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": contents,
        "generationConfig": {"maxOutputTokens": max_tokens},
    }
    headers = {"content-type": "application/json"}
    full_url = url + ("&" if "?" in url else "?") + "key=" + urllib.parse.quote(api_key)
    out = _http_json(full_url, payload, headers, label="Gemini")
    cands = out.get("candidates") or []
    if not cands:
        return "(the model returned no answer)"
    parts = cands[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts).strip() or "(the model returned no answer)"


# --------------------------------------------------------------------------
# /chat handler
# --------------------------------------------------------------------------
def handle_chat(body):
    question = (body.get("question") or "").strip()
    session_id = (body.get("session_id") or "").strip() or "default"
    if not question:
        return {"answer": "You'll need to ask me something first, sir.", "nodes": []}

    config = load_config()
    has_key = _has_real_key(config)

    if is_smalltalk(question):
        if not has_key:
            msg = _placeholder_msg()
            _record_turn(session_id, question, msg)
            return {"answer": msg, "nodes": []}
        with SESSION_LOCK:
            history = list(SESSIONS.get(session_id, []))
        messages = history + [{"role": "user", "content": question}]
        try:
            answer = call_llm(config, SMALLTALK_PROMPT, messages)
        except Exception as e:
            return {"answer": "I couldn't reach the model: " + str(e), "nodes": []}
        _record_turn(session_id, question, answer)
        return {"answer": answer, "nodes": []}

    notes, _ = select_notes(question)
    ids = [n["id"] for n in notes]

    if not notes:
        msg = ("I've searched the notes, sir, and I'm afraid that one isn't "
               "covered. The archive runs to operations, finance, suppliers, "
               "products, marketing, staff, and strategy \u2014 shall we try one of those?")
        _record_turn(session_id, question, msg)
        return {"answer": msg, "nodes": []}

    if not has_key:
        names = ", ".join(n["label"] for n in notes)
        msg = ("I found " + str(len(notes)) + " relevant note"
               + ("s" if len(notes) != 1 else "")
               + " (" + names + "), but no API key is set. "
               "Set OPENROUTER_API_KEY (Vercel) or paste a key into config.json.")
        _record_turn(session_id, question, msg)
        return {"answer": msg, "nodes": ids}

    system = SYSTEM_PROMPT + "\n\n--- NOTES ---\n" + build_context(notes)
    with SESSION_LOCK:
        history = list(SESSIONS.get(session_id, []))
    messages = history + [{"role": "user", "content": question}]

    try:
        answer = call_llm(config, system, messages)
    except Exception as e:
        return {"answer": "I couldn't reach the model: " + str(e), "nodes": ids}

    _record_turn(session_id, question, answer)
    return {"answer": answer, "nodes": ids}


# --------------------------------------------------------------------------
# /remember handler — writes a real markdown note (local); graceful on Vercel
# --------------------------------------------------------------------------
CAPTURES_DIR = os.path.join(NOTES_DIR, "captures")


def refresh_notes_index():
    """Re-scan notes/ and rebuild graph-data.js (local only; no-op on Vercel)."""
    _index_notes()
    try:
        build_mod.main()
    except Exception as e:
        sys.stderr.write("graph-data.js rebuild skipped: %s\n" % e)


def _strip_remember_prefix(text):
    t = text.strip()
    m = re.match(r"^remember\s+that\b\s*", t, re.IGNORECASE)
    if m:
        return t[m.end():].strip()
    m = re.match(r"^remember\b\s*", t, re.IGNORECASE)
    if m:
        return t[m.end():].strip()
    return t


def _title_from_text(text, max_words=6):
    words = [w.strip(".,;:!?\"'()[]") for w in text.split() if w.strip(".,;:!?\"'()[]")]
    while words and words[0].lower() in STOPWORDS:
        words.pop(0)
    take = words[:max_words]
    while take and take[-1].lower() in STOPWORDS:
        take.pop()
    if not take:
        return "Captured Note"
    return " ".join(w.capitalize() for w in take) or "Captured Note"


def _slugify(title):
    s = title.replace(" ", "-")
    s = re.sub(r"[^A-Za-z0-9-]+", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "Captured-Note"


def handle_remember(body):
    text = (body.get("text") or "").strip()
    if not text:
        return {"error": "Nothing to remember, sir. Do say what I should file."}
    payload = _strip_remember_prefix(text)
    if not payload:
        return {"error": "Nothing to remember after 'remember that', sir."}

    title = _title_from_text(payload)
    stem = _slugify(title)
    related, _ = select_notes(payload, k=3)
    parent = related[0] if related else None
    parent_id = parent["id"] if parent else None

    body_md = payload.strip()
    if parent is not None:
        body_md += "\n\nRelated: [[" + parent["label"].replace(" ", "-") + "]]"

    today = datetime.date.today().isoformat()
    content = (
        "---\ntitle: " + title + "\ntags: [captures]\nupdated: " + today + "\n---\n\n"
        "# " + title + "\n\n" + body_md + "\n"
    )

    # Try to persist to disk (works locally; gracefully skips on read-only Vercel).
    persisted = False
    try:
        os.makedirs(CAPTURES_DIR, exist_ok=True)
        fpath = os.path.join(CAPTURES_DIR, stem + ".md")
        n = 2
        while os.path.exists(fpath):
            fpath = os.path.join(CAPTURES_DIR, stem + "-" + str(n) + ".md")
            n += 1
        rel_path = os.path.relpath(fpath, NOTES_DIR).replace(os.sep, "/")
        with open(fpath, "w", encoding="utf-8") as f:
            f.write(content)
        persisted = True
        refresh_notes_index()
    except Exception as e:
        # Read-only filesystem (Vercel serverless) — the note lives only in the
        # live graph for this session. Return it so the client can add it live.
        rel_path = "captures/" + stem + ".md"
        sys.stderr.write("capture not persisted to disk: %s\n" % e)

    # Build the node object (id = position after refresh; fall back to count).
    with NOTES_LOCK:
        new_node = next((x for x in NOTES if x["path"] == rel_path), None)
        if new_node is None:
            # Not on disk (Vercel) — synthesize a node with the next id.
            new_id = len(NOTES)
            new_node = {
                "id": new_id, "label": title, "group": "captures",
                "path": rel_path, "excerpt": payload,
            }

    all_links = build_mod.build_links(NOTES) if persisted else []
    new_links = [
        {"source": l["source"], "target": l["target"]}
        for l in all_links
        if l["source"] == new_node["id"] or l["target"] == new_node["id"]
    ]
    if not new_links and parent_id is not None:
        new_links = [{"source": parent_id, "target": new_node["id"]}]

    return {
        "node": {
            "id": new_node["id"], "label": new_node["label"],
            "group": new_node["group"], "path": new_node["path"],
            "excerpt": new_node["excerpt"],
        },
        "parent_id": parent_id,
        "links": new_links,
        "persisted": persisted,
    }
