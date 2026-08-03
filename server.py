#!/usr/bin/env python3
"""Knowledge Galaxy server.

Serves ONLY the viewer/ folder (static files) and exposes a single POST /chat
endpoint that answers questions grounded in the user's markdown notes.

  * GET  /<anything under viewer/>  -> static file from viewer/
  * POST /chat                       -> {question, session_id} -> {answer, nodes}

config.json (in THIS directory, never inside viewer/) holds the Anthropic API
key and model. It is read server-side only and is NEVER sent to the browser:
  - SimpleHTTPRequestHandler is rooted at viewer/, so the parent config.json is
    outside the served tree.
  - /chat responses contain only {answer, nodes}.
  - A defense-in-depth guard rejects any GET whose path mentions "config".

Run:    python3 server.py
Open:   http://localhost:4700/
"""

import datetime
import http.server
import json
import os
import re
import socketserver
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

PORT = 4700
HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(HERE, "viewer")
NOTES_DIR = os.path.join(HERE, "notes")
CONFIG_PATH = os.path.join(HERE, "config.json")
PLACEHOLDER_KEY = "PUT-YOUR-KEY-HERE"

# Default endpoints per provider. base_url in config.json overrides these.
PROVIDER_DEFAULTS = {
    "anthropic": "https://api.anthropic.com/v1/messages",
    "openai":    "https://api.openai.com/v1/chat/completions",
    "gemini":    "https://generativelanguage.googleapis.com/v1beta/models",
}

# Reuse build.py's note scanner so server-side note ids are IDENTICAL to the
# numeric ids in viewer/graph-data.js (id == position in the nodes array).
sys.path.insert(0, HERE)
import build as build_mod  # noqa: E402

# --------------------------------------------------------------------------
# Tokenizer + stopwords (defined before the note index uses them)
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


# Phrases/tokens that signal pure small talk — a greeting, a joke, a pleasantry
# — rather than a question about the notes. We match on whole-question shape
# (very short, no note-ish keywords) plus an explicit allowlist.
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
    # Very short pleasantry with no substance.
    if len(toks) <= 3 and any(t in SMALLTALK_HINTS for t in toks):
        return True
    # Greeting opener: "hello there", "hi jarvis", "hey mate", etc.
    if len(toks) <= 3 and toks and toks[0] in {"hi", "hello", "hey", "hiya", "yo", "howdy", "greetings"}:
        return True
    # Explicitly asks for a joke / funny line.
    if "joke" in q or "say something funny" in q or "make me laugh" in q:
        return True
    # "Who/what are you" style.
    if re.match(r"^(who|what) (are|is) (you|this|jarvis)\b", q):
        return True
    return False


# --------------------------------------------------------------------------
# Note index (built once at startup; ids match graph-data.js)
# --------------------------------------------------------------------------
NOTES = build_mod.scan_nodes()
for _n in NOTES:
    _raw = open(os.path.join(NOTES_DIR, _n["path"]), encoding="utf-8", errors="replace").read()
    _n["_prose_orig"] = build_mod.strip_markdown(_raw)  # original case, for the model
    _n["_tokens"] = Counter(_tokenize(_n["_prose"]))    # lowercased word counts for scoring
    _n["_title_tokens"] = set(_tokenize(_n["label"]))   # for the title-match bonus


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _has_real_key(config):
    k = (config.get("api_key") or "").strip()
    return bool(k) and k != PLACEHOLDER_KEY


def _provider(config):
    p = (config.get("provider") or "").strip().lower()
    if not p:
        # Auto-detect: Anthropic models start with "claude", Gemini with "gemini".
        m = (config.get("model") or "").lower()
        if m.startswith("claude"):
            p = "anthropic"
        elif m.startswith("gemini"):
            p = "gemini"
        else:
            p = "openai"  # OpenAI-compatible is the safe default
    return p


def _endpoint(config, provider):
    """Resolve the API endpoint URL for the given provider."""
    custom = (config.get("base_url") or "").strip()
    model = (config.get("model") or "").strip()
    if provider == "gemini":
        # Gemini embeds the model + method in the path.
        base = custom.rstrip("/") if custom else PROVIDER_DEFAULTS["gemini"]
        return base.rstrip("/") + "/" + model + ":generateContent"
    return custom.rstrip("/") if custom else PROVIDER_DEFAULTS[provider]


def _placeholder_msg():
    return ("Charmed, I'm sure. I'd respond with rather more wit, sir, but no "
            "API key is set \u2014 paste one into config.json and I'll be in full voice.")


# --------------------------------------------------------------------------
# Retrieval: keyword overlap scoring (title matches weigh extra)
# --------------------------------------------------------------------------
def _token_match(qt, nt):
    """True if question token qt matches note token nt.

    Exact match always counts. For tokens of length >= 4 we also accept a
    light prefix match (open<->opening, train<->training, supplier<->suppliers)
    so simple inflections still link up without a full stemmer.
    """
    if qt == nt:
        return True
    if len(qt) >= 4 and len(nt) >= 4 and (nt.startswith(qt) or qt.startswith(nt)):
        return True
    return False


def select_notes(question, k=6):
    """Return (top_k_notes, question_tokens) scored by keyword overlap.

    Each question keyword contributes its total frequency in a note's prose
    (summed over matching tokens, incl. prefix matches); if the keyword also
    matches a TITLE token, that contribution is tripled and a flat +8 bonus is
    added. Notes with a zero score are dropped.
    """
    qtoks = list(dict.fromkeys(_tokenize(question)))  # dedupe, keep order
    scored = []
    for n in NOTES:
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


SYSTEM_PROMPT = (
    "You are Jarvis, the in-house butler for a small coffee roastery called Maple "
    "Street Roasters. Your manner is that of a dry, impeccably polite British "
    "butler with a razor wit — think Jeeves by way of Stephen Fry. "
    "PERSONALITY: unflappable, quietly amused, never fawning. Address the user as "
    "\"sir\" occasionally (not every sentence). One genuinely funny line beats "
    "three bland ones. \n\n"
    "ANSWERING ABOUT THE NOTES: Answer ONLY from the note excerpts under NOTES. "
    "Respond in ONE witty sentence plus the facts — be concise. Never recite or "
    "paraphrase a note back; the user can already see it on screen, so add wit "
    "and synthesis, not repetition. If the notes do not cover it, say so plainly "
    "(with a touch of dry humor) and do not invent facts, names, numbers, "
    "procedures, or dates. For follow-ups, use prior context but stay grounded "
    "in the notes."
)

# Used when the user is clearly just chatting (greetings, jokes, small talk).
# No notes are attached and nodes=[] is returned so the viewer won't fly the
# camera around the graph for non-note questions.
SMALLTALK_PROMPT = (
    "You are Jarvis, the in-house butler for a small coffee roastery called Maple "
    "Street Roasters. Your manner is that of a dry, impeccably polite British "
    "butler with a razor wit. Address the user as \"sir\" occasionally (not every "
    "sentence). The user is making small talk, a joke, or a pleasantry — NOT asking "
    "about the notes. Respond in ONE or TWO sentences, in character, with quiet wit. "
    "Do not mention the notes, do not pretend to look anything up, and do not claim "
    "to have retrieved anything. Stay warm, brief, and funny."
)


# --------------------------------------------------------------------------
# Per-session conversation history (in-memory, thread-safe, capped)
# --------------------------------------------------------------------------
SESSIONS = {}
SESSION_LOCK = threading.Lock()
MAX_HISTORY = 12  # messages (~6 user/assistant turns)


# --------------------------------------------------------------------------
# Multi-provider LLM call (standard library only)
# --------------------------------------------------------------------------
# Supports:
#   provider: "anthropic"  -> Claude (Messages API)
#   provider: "openai"     -> GPT-4o, etc. AND any OpenAI-compatible endpoint
#                             (Groq, OpenRouter, Together, local Ollama, ...).
#                             Set base_url to the provider's /v1/chat/completions.
#   provider: "gemini"     -> Google Gemini
# If provider is omitted, it's auto-detected from the model name.
# --------------------------------------------------------------------------
def call_llm(config, system, messages):
    """Call the configured LLM provider and return the text answer."""
    provider = _provider(config)
    endpoint = _endpoint(config, provider)
    api_key = (config.get("api_key") or "").strip()
    model = (config.get("model") or "").strip()
    max_tokens = int(config.get("max_tokens") or 400)

    if provider == "anthropic":
        return _call_anthropic(endpoint, api_key, model, max_tokens, system, messages)
    if provider == "openai":
        return _call_openai(endpoint, api_key, model, max_tokens, system, messages)
    if provider == "gemini":
        return _call_gemini(endpoint, api_key, model, max_tokens, system, messages)
    raise RuntimeError("Unknown provider: %r" % provider)


def _http_json(url, data, headers, timeout=60, label="LLM"):
    """POST JSON and return the parsed response, with clean error messages."""
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


def _call_anthropic(url, api_key, model, max_tokens, system, messages):
    payload = {"model": model, "max_tokens": max_tokens, "system": system, "messages": messages}
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    out = _http_json(url, payload, headers, label="Anthropic")
    parts = [b.get("text", "") for b in out.get("content", []) if b.get("type") == "text"]
    return "".join(parts).strip() or "(the model returned no answer)"


def _call_openai(url, api_key, model, max_tokens, system, messages):
    # OpenAI puts the system prompt as the first message.
    full = [{"role": "system", "content": system}] + messages
    payload = {"model": model, "max_tokens": max_tokens, "messages": full}
    headers = {
        "Authorization": "Bearer " + api_key,
        "content-type": "application/json",
    }
    out = _http_json(url, payload, headers, label="OpenAI")
    choices = out.get("choices") or []
    if not choices:
        return "(the model returned no answer)"
    return (choices[0].get("message", {}).get("content") or "").strip() or "(the model returned no answer)"


def _call_gemini(url, api_key, model, max_tokens, system, messages):
    # Gemini uses "contents" with role user/model and a separate systemInstruction.
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
    # Gemini takes the key as a query param.
    full_url = url + ("&" if "?" in url else "?") + "key=" + urllib.parse.quote(api_key)
    out = _http_json(full_url, payload, headers, label="Gemini")
    cands = out.get("candidates") or []
    if not cands:
        return "(the model returned no answer)"
    parts = cands[0].get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts).strip() or "(the model returned no answer)"


# --------------------------------------------------------------------------
# Chat request handling
# --------------------------------------------------------------------------
def handle_chat(body):
    """Process a /chat request body -> {answer, nodes}.

    nodes is the list of note ids (== graph-data.js array indexes) used.
    Small talk returns nodes=[] so the viewer doesn't fly the camera.
    """
    question = (body.get("question") or "").strip()
    session_id = (body.get("session_id") or "").strip() or "default"

    if not question:
        return {"answer": "You'll need to ask me something first, sir.", "nodes": []}

    config = load_config()
    has_key = _has_real_key(config)

    # --- Small talk / jokes / greetings: persona reply, no notes, no camera. ---
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

    # --- Note question: retrieve, then answer grounded in the notes. ---
    notes, _ = select_notes(question)
    ids = [n["id"] for n in notes]

    # No relevant notes -> admit it in character (no API call needed).
    if not notes:
        msg = ("I've searched the notes, sir, and I'm afraid that one isn't "
               "covered. The archive runs to operations, finance, suppliers, "
               "products, marketing, staff, and strategy \u2014 shall we try one of those?")
        _record_turn(session_id, question, msg)
        return {"answer": msg, "nodes": []}

    # Placeholder / missing key -> don't call the API; still return retrieval.
    if not has_key:
        names = ", ".join(n["label"] for n in notes)
        msg = ("I found " + str(len(notes)) + " relevant note"
               + ("s" if len(notes) != 1 else "")
               + " (" + names + "), but no API key is set. "
               "Paste your key into knowledge-galaxy/config.json and ask again "
               "to get a generated answer.")
        _record_turn(session_id, question, msg)
        return {"answer": msg, "nodes": ids}

    system = SYSTEM_PROMPT + "\n\n--- NOTES ---\n" + build_context(notes)
    with SESSION_LOCK:
        history = list(SESSIONS.get(session_id, []))
    messages = history + [{"role": "user", "content": question}]

    try:
        answer = call_llm(config, system, messages)
    except Exception as e:
        # Don't record a failed turn: it would leave a user message without a
        # matching assistant reply and break the alternating role contract on
        # the next follow-up. The user can simply retry.
        return {"answer": "I couldn't reach the model: " + str(e), "nodes": ids}

    _record_turn(session_id, question, answer)
    return {"answer": answer, "nodes": ids}


def _record_turn(session_id, question, answer):
    """Append a user turn (and assistant turn if answer is not None), capped."""
    with SESSION_LOCK:
        hist = SESSIONS.setdefault(session_id, [])
        hist.append({"role": "user", "content": question})
        if answer is not None:
            hist.append({"role": "assistant", "content": answer})
        del hist[:-MAX_HISTORY]


# --------------------------------------------------------------------------
# /remember — grow the brain by writing a real markdown note
# --------------------------------------------------------------------------
CAPTURES_DIR = os.path.join(NOTES_DIR, "captures")


def refresh_notes_index():
    """Re-scan notes/ (picking up any new captures) and rebuild graph-data.js.

    Keeps server-side note ids aligned with viewer/graph-data.js (id == array
    index). New captures land in captures/ which sorts after every existing
    group folder, so they always append at the end -> ids stay stable.
    """
    global NOTES
    NOTES = build_mod.scan_nodes()
    for _n in NOTES:
        _raw = open(os.path.join(NOTES_DIR, _n["path"]), encoding="utf-8", errors="replace").read()
        _n["_prose_orig"] = build_mod.strip_markdown(_raw)
        _n["_tokens"] = Counter(_tokenize(_n["_prose"]))
        _n["_title_tokens"] = set(_tokenize(_n["label"]))
    # Regenerate graph-data.js so a page reload reflects the new note.
    try:
        build_mod.main()
    except Exception as e:  # pragma: no cover - defensive
        sys.stderr.write("graph-data.js rebuild failed: %s\n" % e)


def _strip_remember_prefix(text):
    """Remove a leading 'remember that' (or bare 'remember') from the text."""
    t = text.strip()
    m = re.match(r"^remember\s+that\b\s*", t, re.IGNORECASE)
    if m:
        return t[m.end():].strip()
    m = re.match(r"^remember\b\s*", t, re.IGNORECASE)
    if m:
        return t[m.end():].strip()
    return t


def _title_from_text(text, max_words=6):
    """Build a sensible Title Case label from the first few meaningful words."""
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
    """Title-Case-With-Dashes stem safe for a filename."""
    s = title.replace(" ", "-")
    s = re.sub(r"[^A-Za-z0-9-]+", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "Captured-Note"


def handle_remember(body):
    """Write a captured note to notes/captures/, re-index, return the new node.

    Returns {node, parent_id, links} where parent_id is the most-related
    existing note (by keyword overlap) — the galaxy births the new node there.
    """
    text = (body.get("text") or "").strip()
    if not text:
        return {"error": "Nothing to remember, sir. Do say what I should file."}
    payload = _strip_remember_prefix(text)
    if not payload:
        return {"error": "Nothing to remember after 'remember that', sir."}

    title = _title_from_text(payload)
    stem = _slugify(title)
    os.makedirs(CAPTURES_DIR, exist_ok=True)
    fpath = os.path.join(CAPTURES_DIR, stem + ".md")
    n = 2
    while os.path.exists(fpath):
        fpath = os.path.join(CAPTURES_DIR, stem + "-" + str(n) + ".md")
        n += 1
    rel_path = os.path.relpath(fpath, NOTES_DIR).replace(os.sep, "/")

    # Most-related existing note (by keyword overlap) — computed BEFORE the new
    # note exists. Used for the birth position and a [[wikilink]] so the new
    # node is genuinely connected in the graph, not orphaned.
    related, _ = select_notes(payload, k=3)
    parent = related[0] if related else None
    parent_id = parent["id"] if parent else None

    body_md = payload.strip()
    if parent is not None:
        parent_dashed = parent["label"].replace(" ", "-")
        body_md += "\n\nRelated: [[" + parent_dashed + "]]"

    today = datetime.date.today().isoformat()
    content = (
        "---\n"
        "title: " + title + "\n"
        "tags: [captures]\n"
        "updated: " + today + "\n"
        "---\n\n"
        "# " + title + "\n\n"
        + body_md + "\n"
    )
    with open(fpath, "w", encoding="utf-8") as f:
        f.write(content)

    # Pick up the new note server-side and persist it into graph-data.js.
    refresh_notes_index()

    new_node = next((x for x in NOTES if x["path"] == rel_path), None)
    if not new_node:
        return {"error": "Saved the note, sir, but couldn't locate it in the index."}

    # Recompute links so the response includes any the new node joined
    # (title-mention / wikilink / co-citation). The [[wikilink]] above ensures
    # at least the parent link is present.
    all_links = build_mod.build_links(NOTES)
    new_links = [
        {"source": l["source"], "target": l["target"]}
        for l in all_links
        if l["source"] == new_node["id"] or l["target"] == new_node["id"]
    ]

    return {
        "node": {
            "id": new_node["id"],
            "label": new_node["label"],
            "group": new_node["group"],
            "path": new_node["path"],
            "excerpt": new_node["excerpt"],
        },
        "parent_id": parent_id,
        "links": new_links,
    }


# --------------------------------------------------------------------------
# HTTP handler: static viewer/ + POST /chat
# --------------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve viewer/ for GET; handle POST /chat."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=VIEWER_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    # --- static serving with a hard guard against serving config ---
    def do_GET(self):
        path = self.path.split("?")[0].lower()
        if path in ("/boot", "/boot/"):
            self._send_json(200, {"note_count": len(NOTES)})
            return
        if "config" in path or ".." in self.path:
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    # --- chat endpoint ---
    def do_POST(self):
        path = self.path.split("?")[0]
        if path in ("/chat", "/chat/"):
            self._handle_chat()
        elif path in ("/remember", "/remember/"):
            self._handle_remember()
        else:
            self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _handle_chat(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send_json(400, {"answer": "Invalid JSON body.", "nodes": []})
            return
        try:
            result = handle_chat(body)
        except Exception as e:  # pragma: no cover - defensive
            result = {"answer": "Server error: %s" % e, "nodes": []}
        self._send_json(200, result)

    def _handle_remember(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send_json(400, {"error": "Invalid JSON body."})
            return
        try:
            result = handle_remember(body)
        except Exception as e:  # pragma: no cover - defensive
            result = {"error": "Server error: %s" % e}
        self._send_json(200, result)

    def _send_json(self, code, obj):
        data = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not os.path.isdir(VIEWER_DIR):
        raise SystemExit("viewer/ folder not found at %s" % VIEWER_DIR)
    if not os.path.isfile(CONFIG_PATH):
        raise SystemExit("config.json not found at %s" % CONFIG_PATH)
    print("Knowledge Galaxy viewer served from: %s" % VIEWER_DIR)
    print("Notes indexed: %d (ids match viewer/graph-data.js)" % len(NOTES))
    print("Config: %s" % CONFIG_PATH)
    cfg = load_config()
    key_state = "set" if _has_real_key(cfg) else "PLACEHOLDER (paste your key)"
    print("  provider: %s" % _provider(cfg))
    print("  model:    %s" % (cfg.get("model") or "(unset)"))
    print("  base_url: %s" % (_endpoint(cfg, _provider(cfg))))
    print("  api_key:  %s" % key_state)
    print("Open in Chrome:  http://localhost:%d/" % PORT)
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
