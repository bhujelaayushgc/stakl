import http.server
import threading
import unittest
import urllib.request
from unittest.mock import patch

from integration import LoopbackHTTPServer


class LoopbackServerTest(unittest.TestCase):
    def test_serves_without_hostname_resolution(self):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(204)
                self.end_headers()

            def log_message(self, *args):
                pass

        with patch('socket.getfqdn', side_effect=AssertionError('unexpected DNS lookup')):
            with LoopbackHTTPServer(('127.0.0.1', 0), Handler) as server:
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{server.server_port}', timeout=2) as response:
                        self.assertEqual(response.status, 204)
                finally:
                    server.shutdown()
                    thread.join()
