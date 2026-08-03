#!/usr/bin/env python3
"""Knowledge Galaxy local server (port 4700).

Serves viewer/ (static) and routes /api/chat, /api/boot, /api/remember to the
shared kg_core module. All logic lives in kg_core.py so local + Vercel behave
identically.

Run:    python3 server.py   (or ./start.sh)
Open:   http://localhost:4700/
"""

import http.server
import json
import os
import socketserver

import kg_core

PORT = 4700
HERE = os.path.dirname(os.path.abspath(__file__))
VIEWER_DIR = os.path.join(HERE, "viewer")


class Handler(http.server.SimpleHTTPRequestHandler):
    """Serve viewer/ for GET; route /api/* to kg_core."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=VIEWER_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path in ("/api/boot", "/api/boot/"):
            self._send_json(200, {"note_count": kg_core.note_count()})
            return
        if "config" in path.lower() or ".." in self.path:
            self.send_error(404, "Not Found")
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split("?")[0]
        if path in ("/api/chat", "/api/chat/", "/chat", "/chat/"):
            self._run(kg_core.handle_chat)
        elif path in ("/api/remember", "/api/remember/", "/remember", "/remember/"):
            self._run(kg_core.handle_remember)
        else:
            self.send_error(404, "Not Found")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def _run(self, fn):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception:
            self._send_json(400, {"error": "Invalid JSON body."})
            return
        try:
            result = fn(body)
        except Exception as e:
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
        import sys
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    if not os.path.isdir(VIEWER_DIR):
        raise SystemExit("viewer/ folder not found at %s" % VIEWER_DIR)
    cfg = kg_core.load_config()
    print("Knowledge Galaxy viewer served from: %s" % VIEWER_DIR)
    print("Notes indexed: %d" % kg_core.note_count())
    print("Config: provider=%s  models=%d  key=%s" % (
        kg_core._provider(cfg), len(kg_core._resolve_models(cfg)),
        "set" if kg_core._has_real_key(cfg) else "PLACEHOLDER"))
    print("Open in Chrome:  http://localhost:%d/" % PORT)
    with ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as httpd:
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down.")


if __name__ == "__main__":
    main()
