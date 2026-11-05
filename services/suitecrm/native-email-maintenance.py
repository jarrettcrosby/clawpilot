#!/usr/bin/env python3
"""Restrictive container liveness only; never loads SuiteCRM or reads its DB.

This process intentionally is not PHP, Apache or supervisor: the separate
offline installer must still be able to attest absence of every native worker.
An HTTP 200 here proves liveness, not application readiness or startup release.
"""
import json
import os
import re
import signal
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


LIVENESS_PATH = "/_clawpilot/liveness"
BODY = json.dumps({"service": "suitecrm", "mode": "maintenance", "live": True,
                   "ready": False}, separators=(",", ":")).encode("utf-8") + b"\n"
DENIED = json.dumps({"service": "suitecrm", "mode": "maintenance", "ready": False,
                     "error": "method_not_allowed"}, separators=(",", ":")).encode("utf-8") + b"\n"


class MaintenanceHandler(BaseHTTPRequestHandler):
    # No SuiteCRM files, secrets, request bodies or arbitrary paths are read.
    server_version = "ClawPilotMaintenance"
    sys_version = ""
    protocol_version = "HTTP/1.0"
    timeout = 2

    def log_message(self, _format, *_args):
        # Do not retain query strings, client addresses or attacker input.
        return

    def parse_request(self):
        if not super().parse_request():
            return False
        if self.command not in ("GET", "HEAD"):
            self.respond(405, DENIED)
            return False
        return True

    def respond(self, status, body, head=False):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        if status == 503:
            self.send_header("Retry-After", "60")
        if status == 405:
            self.send_header("Allow", "GET, HEAD")
        self.end_headers()
        if not head:
            self.wfile.write(body)
        self.close_connection = True

    def do_GET(self):
        self.respond(200 if self.path.split("?", 1)[0] == LIVENESS_PATH else 503, BODY)

    def do_HEAD(self):
        self.respond(200 if self.path.split("?", 1)[0] == LIVENESS_PATH else 503, BODY, True)

    def denied(self):
        self.respond(405, DENIED)

    do_POST = denied
    do_PUT = denied
    do_PATCH = denied
    do_DELETE = denied
    do_OPTIONS = denied
    do_TRACE = denied
    do_CONNECT = denied


class MaintenanceServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 8

    def __init__(self, address):
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, MaintenanceHandler)

    def process_request(self, request, address):
        if not self.slots.acquire(False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, _request, _address):
        # Disconnects and malformed clients must not log addresses/tracebacks.
        return


def main():
    if len(sys.argv) != 1:
        raise SystemExit("Maintenance responder takes no startup-release arguments")
    port = os.environ.get("PORT", "8080")
    if re.fullmatch(r"[1-9][0-9]{0,4}", port) is None or int(port) > 65535:
        raise SystemExit("PORT must be an integer from 1 to 65535")
    try:
        server = MaintenanceServer(("0.0.0.0", int(port)))
    except OSError:
        raise SystemExit("Maintenance listener could not start")

    def stop(_signal, _frame):
        # shutdown() from serve_forever's own thread would deadlock. Exiting
        # this main thread instead closes the listener in the finally block.
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print(json.dumps({"service": "suitecrm", "mode": "maintenance", "ready": False,
                      "port": int(port)}, separators=(",", ":")), file=sys.stderr, flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
