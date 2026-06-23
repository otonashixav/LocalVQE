#!/usr/bin/env python3
"""Static file server for the LocalVQE web demo.

    python3 web/serve.py [port]      # default 8000

Serves the web/ directory at http://localhost:<port>. localhost is a secure
context, so the Cache API (used to persist downloaded weights) works. The demo
is single-threaded WASM, so no COOP/COEP cross-origin-isolation headers are
needed — any static host will do.
"""
import http.server
import os
import socketserver
import sys

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".wasm": "application/wasm",
        ".js": "text/javascript",
    }

    def end_headers(self):
        # Discourage stale caching of the dev assets while iterating.
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()


with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
    print(f"LocalVQE demo → http://localhost:{PORT}  (Ctrl-C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
