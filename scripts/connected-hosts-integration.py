#!/usr/bin/env python3
"""Real isolated hub/peer acceptance. Never operates an existing controller."""
import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'bin/stakl'


def wait(check, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = check()
            if result:
                return result
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(.1)
    raise AssertionError('Timed out waiting for fixture state')


class Instance:
    def __init__(self, root, name):
        self.dir = root / name
        self.dir.mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            self.port = sock.getsockname()[1]
        self.config = self.dir / 'config.yml'
        self.config.write_text(f'''version: 1
server: {{port: {self.port}, open_browser: false}}
groups:
  test: {{name: Test}}
apps:
  api:
    name: {name} API
    type: shell
    group: test
    cwd: {json.dumps(str(self.dir))}
    start:
      command: 'while true; do echo {name}-heartbeat; sleep 0.2; done'
    health: {{type: process, interval: 200ms}}
    stop: {{timeout: 1s}}
''')
        self.process = None
        self.output = (self.dir / 'controller.log').open('w+')
        self.tls = False
        self.context = None

    def start(self):
        self.process = subprocess.Popen([str(BIN), '--config', str(self.config), '--no-browser'], stdout=self.output, stderr=self.output)
        def ready():
            if self.process.poll() is not None:
                self.output.seek(0)
                raise AssertionError(self.output.read())
            try:
                value = json.loads((self.dir / 'instance.json').read_text())
                return value if value.get('pid') == self.process.pid else None
            except (FileNotFoundError, ValueError):
                return None
        self.info = wait(ready)
        wait(lambda: self.api('/apps') is not None)

    def stop_controller(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            self.process.wait(timeout=15)

    def api(self, path, body=None, token=None, raw=False):
        url = f'{"https" if self.tls else "http"}://127.0.0.1:{self.port}/api{path}'
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(), headers={'Authorization': 'Bearer ' + (token or self.info['token']), 'X-Stakl': '1', 'Content-Type': 'application/json'})
        response = urllib.request.urlopen(req, timeout=15, context=self.context)
        if raw:
            return response
        with response:
            return json.load(response)

    def enable_tls(self):
        self.stop_controller()
        subprocess.run([str(BIN), '--config', str(self.config), 'tls', 'init', '--host', '127.0.0.1'], check=True, capture_output=True)
        self.config.write_text(self.config.read_text().replace(f'port: {self.port}, open_browser: false', f'port: {self.port}, open_browser: false, tls_cert_file: tls-cert.pem, tls_key_file: tls-key.pem'))
        self.tls = True
        self.context = ssl.create_default_context(cafile=str(self.dir / 'tls-cert.pem'))
        self.start()

    def cleanup(self):
        try:
            if not self.process or self.process.poll() is not None:
                self.start()
            self.api('/apps/api/stop', {})
        finally:
            self.stop_controller()
            self.output.close()


def rejected(action, statuses):
    try:
        action()
    except urllib.error.HTTPError as error:
        assert error.code in statuses, (error.code, error.read())
        return json.load(error)
    raise AssertionError('Request unexpectedly accepted')


def main():
    with tempfile.TemporaryDirectory(prefix='stakl-connected-') as temp:
        hub = Instance(Path(temp), 'hub')
        peer = Instance(Path(temp), 'peer')
        try:
            hub.start()
            peer.start()
            assert hub.api('/apps/api/start', {}) == {'api': 'ok'}
            local_pid = wait(lambda: hub.api('/apps/api')['runtime']['pid'])
            grant = peer.api('/peer-tokens', {'name': 'Acceptance control', 'access': 'control'})
            read = peer.api('/peer-tokens', {'name': 'Acceptance read', 'access': 'read'})
            rejected(lambda: peer.api('/peer/v1/apps/api/start', {}, token=read['token']), {403})
            rejected(lambda: peer.api('/config', token=grant['token']), {401, 403})
            host = hub.api('/hosts', {'name': 'Peer', 'url': f'http://127.0.0.1:{peer.port}', 'token': grant['token']})
            host_id, controller_id = host['id'], host['controller_id']
            prefix = f'/hosts/{host_id}/apps/api'
            duplicate = rejected(lambda: hub.api('/hosts', {'name': 'Duplicate', 'url': f'http://127.0.0.1:{peer.port}', 'token': grant['token']}), {502})
            assert duplicate['error'] == 'Controller is already registered'
            assert len(hub.api('/hosts')) == 2
            def action(verb):
                value = hub.api(prefix + '/' + verb, {})
                assert value['host']['controller_id'] == controller_id
                assert value['data'] == {'api': 'ok'}, value
                assert hub.api('/apps/api')['runtime']['pid'] == local_pid, 'remote action touched local app'
            action('start')
            wait(lambda: hub.api(prefix)['data']['runtime']['state'] == 'healthy')
            remote_pid = peer.api('/apps/api')['runtime']['pid']
            assert remote_pid != local_pid
            assert hub.api(prefix + '/health')['data']
            wait(lambda: any('peer-heartbeat' in line['text'] for line in hub.api(prefix + '/logs')['data']))
            with hub.api(prefix + '/logs?follow=true', raw=True) as stream:
                observed = b''
                while b'peer-heartbeat' not in observed:
                    observed += stream.readline()
                assert b'data:' in observed
            action('restart')
            remote_pid = wait(lambda: (pid if (pid := peer.api('/apps/api')['runtime']['pid']) and pid != remote_pid else None))
            action('stop')
            assert peer.api('/apps/api')['runtime']['state'] == 'stopped'
            action('start')
            remote_pid = wait(lambda: peer.api('/apps/api')['runtime']['pid'])
            assert hub.api(prefix + '/history')['data']
            hub.stop_controller()
            os.kill(remote_pid, 0)
            hub.start()
            assert any(h['id'] == host_id and h['controller_id'] == controller_id for h in hub.api('/hosts'))
            wait(lambda: next(h for h in hub.api('/hosts') if h['id'] == host_id)['state'] == 'online')
            assert peer.api('/apps/api')['runtime']['pid'] == remote_pid
            peer.stop_controller()
            os.kill(remote_pid, 0)
            stale = wait(lambda: next((h for h in hub.api('/hosts') if h['id'] == host_id and h['stale']), None))
            assert stale['state'] == 'unavailable'
            snapshots = hub.api('/hosts/apps')
            assert next(e for e in snapshots if e['host']['id'] == host_id)['apps'], 'lost historical snapshot'
            rejected(lambda: hub.api(prefix + '/restart', {}), {409, 502, 503})
            os.kill(remote_pid, 0)
            peer.start()
            assert peer.api('/apps/api')['runtime']['pid'] == remote_pid
            assert any(g['id'] == grant['id'] for g in peer.api('/peer-tokens'))
            hub.api(f'/hosts/{host_id}/reconnect', {})
            peer.enable_tls()
            pem = (peer.dir / 'tls-cert.pem').read_text()
            rejected(lambda: hub.api(f'/hosts/{host_id}/update', {'url': f'https://127.0.0.1:{peer.port}'}), {400, 502, 503})
            updated = hub.api(f'/hosts/{host_id}/update', {'url': f'https://127.0.0.1:{peer.port}', 'ca_pem': pem})
            assert updated['controller_id'] == controller_id
            assert hub.api(prefix)['data']['runtime']['pid'] == remote_pid
            peer.api(f'/peer-tokens/{grant["id"]}/revoke', {})
            rejected(lambda: hub.api(prefix + '/restart', {}), {401, 403, 409, 502, 503})
            assert peer.api('/apps/api')['runtime']['pid'] == remote_pid
            peer.stop_controller()
            peer.start()
            rejected(lambda: peer.api('/peer/v1/info', token=grant['token']), {401, 403})
            hub.api(f'/hosts/{host_id}/remove', {})
            assert peer.api('/apps/api')['runtime']['pid'] == remote_pid
            print('PASS: isolated equal IDs, exact actions, read scope, logs/SSE/health/history, restart persistence, stale survival, HTTPS trust/rejection, grant revocation and removal')
        finally:
            try:
                hub.cleanup()
            finally:
                peer.cleanup()


if __name__ == '__main__':
    main()
