"""Vercel serverless function: GET /api/boot"""
import json
from http.server import BaseHTTPRequestHandler

import kg_core


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps({"note_count": kg_core.note_count()}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
