#!/usr/bin/env python3
"""Serve the review mockup so it can be opened from another device, e.g. a phone on the LAN.

    python3 docs/review/mockups/serve.py            # http://0.0.0.0:8080/  -> web.html
    python3 docs/review/mockups/serve.py 8080

Loopback-only by intent for normal use: pass a bind address if you really want it reachable, and remember that
this serves the planning directory, not the Crabby Gateway. Nothing about this file is a design decision about
the product's own server (that is `docs/INTERFACES_AND_API.md`).
"""
from __future__ import annotations

import http.server
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(HERE), **kwargs)

    def do_GET(self):  # noqa: N802 - stdlib name
        if self.path in ("/", "/index.html"):
            self.path = "/web.html"
        return super().do_GET()


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    host = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("CRABBY_REVIEW_BIND", "127.0.0.1")
    with http.server.ThreadingHTTPServer((host, port), Handler) as httpd:
        print(f"review mockup: http://{host}:{port}/ (Ctrl-C to stop)")
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main())
