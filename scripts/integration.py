#!/usr/bin/env python3
"""Disposable end-to-end checks against the real binary. No user services touched."""
import http.server, json, os, pathlib, signal, socket, subprocess, tempfile, threading, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
BIN = ROOT / 'bin/localdesk'
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0)); return s.getsockname()[1]

def main():
    with tempfile.TemporaryDirectory(prefix='localdesk-integration-') as temp:
        d=pathlib.Path(temp); port=free_port(); app_port=free_port()
        ext=http.server.ThreadingHTTPServer(('127.0.0.1',0),http.server.BaseHTTPRequestHandler)
        threading.Thread(target=ext.serve_forever,daemon=True).start()
        worker=d/'worker.py'
        worker.write_text('''import http.server, os, signal, subprocess, sys, time
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])
open('child.pid','w').write(str(child.pid))
print('stdout-ready',flush=True)
print('stderr-ready',file=sys.stderr,flush=True)
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(b'ok')
http.server.HTTPServer(('127.0.0.1',int(os.environ['PORT'])),Handler).serve_forever()
''')
        config=d/'config.yml'
        text=f'''version: 1
server:
  port: {port}
  open_browser: false
defaults:
  dependency_timeout: 8s
groups:
  test: {{name: Integration}}
profiles:
  stack:
    name: Integration stack
    apps: [worker, dependent]
apps:
  external:
    name: External listener
    cwd: {d}
    type: process
    start: {{command: 'sleep 120'}}
    detect: {{type: tcp, host: 127.0.0.1, port: {ext.server_port}, interval: 200ms}}
    autostart: true
  worker:
    name: Integration worker
    group: test
    cwd: {d}
    type: process
    start:
      command: {os.sys.executable}
      args: ['{worker}']
    env: {{PORT: '{app_port}'}}
    autostart: true
    ports: [{{name: HTTP, port: {app_port}}}]
    health: {{type: http, url: 'http://127.0.0.1:{app_port}', interval: 200ms, failure_threshold: 2}}
    stop: {{timeout: 1s}}
  exit-with-controller:
    name: Shutdown lifecycle test
    cwd: {d}
    start: {{command: 'sleep 120'}}
    lifecycle: {{stop_on_localdesk_exit: true}}
  crash-loop:
    name: Crash-loop test
    cwd: {d}
    type: shell
    start: {{command: 'sleep 0.2; exit 7'}}
    health: {{type: process, interval: 200ms}}
    restart: {{policy: on-failure, max_attempts: 2, delay: 200ms, backoff: exponential}}
  custom-tool:
    name: Custom command lifecycle
    cwd: {d}
    type: custom
    start: {{command: 'touch custom.running'}}
    stop: {{command: 'rm -f custom.running'}}
    status: {{command: 'test -f custom.running'}}
    restart_command: {{command: 'touch custom.restarted'}}
    logs: {{command: 'echo custom-log; sleep 120', shell: true}}
    health: {{type: command, command: 'test -f custom.healthy', interval: 200ms, failure_threshold: 2, success_threshold: 2}}
  dependent:
    name: Dependent
    cwd: {d}
    type: process
    start: {{command: 'sleep 120'}}
    depends_on:
      worker: {{condition: healthy}}
    stop: {{timeout: 1s}}
'''
        config.write_text(text)
        processes=[]; token=''
        def cli(*args):
            return subprocess.run([str(BIN),'--config',str(config),*args],capture_output=True,text=True,timeout=25,check=True).stdout
        def launch():
            p=subprocess.Popen([str(BIN),'--config',str(config),'--no-browser'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True);processes.append(p)
            wait(lambda:(d/'instance.json').exists() and json.loads((d/'instance.json').read_text()).get('pid')==p.pid,10)
            instance=json.loads((d/'instance.json').read_text())
            return p,instance['token']
        def api(path,body=None):
            req=urllib.request.Request(f'http://127.0.0.1:{port}/api'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+token,'X-LocalDesk':'1','Content-Type':'application/json'})
            with urllib.request.urlopen(req,timeout=25) as r:return json.load(r)
        def app(id):return api('/apps/'+id)
        def wait(fn,seconds=10):
            deadline=time.time()+seconds
            while time.time()<deadline:
                try:
                    if fn():return
                except (ConnectionError,OSError):pass
                time.sleep(.1)
            raise AssertionError('condition timed out')
        def alive(pid):
            try: os.kill(pid,0);return True
            except ProcessLookupError:return False
        try:
            assert 'valid' in cli('config','validate')
            p,token=launch()
            wait(lambda:app('external')['runtime']['state']=='external')
            assert json.loads((d/'instance.json').read_text())['pid']==p.pid
            assert f'127.0.0.1:{port}' in cli('--no-browser')
            assert json.loads((d/'instance.json').read_text())['pid']==p.pid
            assert api('/apps/exit-with-controller/start',{})['exit-with-controller']=='ok'
            shutdown_pid=app('exit-with-controller')['runtime']['pid']
            denied=api('/apps/external/stop',{})
            assert 'refusing' in denied['external'];assert ext.socket.fileno()>=0
            events=urllib.request.urlopen(urllib.request.Request(f'http://127.0.0.1:{port}/api/events',headers={'Authorization':'Bearer '+token}),timeout=10)
            assert b'event: ready' in events.readline(); events.close()
            result=api('/profiles/stack/start',{})
            assert all(v=='ok' for v in result.values()),result
            wait(lambda:app('worker')['runtime']['state']=='healthy')
            pid=app('worker')['runtime']['pid'];child=int((d/'child.pid').read_text())
            logs=api('/apps/worker/logs');assert any(l['text']=='stdout-ready' for l in logs);assert any(l['stream']=='stderr' and l['text']=='stderr-ready' for l in logs)
            assert 'worker' in cli('status');assert 'stdout-ready' in cli('logs','worker')
            assert len(api('/apps/worker/health'))>0
            assert api('/apps/custom-tool/start',{})['custom-tool']=='ok'
            wait(lambda:app('custom-tool')['runtime']['state']=='unhealthy')
            (d/'custom.healthy').touch()
            wait(lambda:app('custom-tool')['runtime']['state']=='healthy')
            assert not app('custom-tool')['runtime'].get('error'),'stale health failure retained'
            assert api('/apps/custom-tool/restart',{})['custom-tool']=='ok'
            assert (d/'custom.restarted').exists(),'custom restart command not used'
            wait(lambda:any(l['text']=='custom-log' for l in api('/apps/custom-tool/logs')))
            assert api('/apps/custom-tool/stop',{})['custom-tool']=='ok'
            api('/apps/crash-loop/start',{})
            wait(lambda:app('crash-loop')['runtime']['restart_count']==2 and 'Restart limit' in app('crash-loop')['runtime'].get('error',''),20)
            assert app('crash-loop')['runtime']['state']=='failed'
            api('/apps/crash-loop/stop',{})
            # Simulate the controller crash window after durable launch intent, before runtime commit.
            import sqlite3
            with sqlite3.connect(d/'state.db') as db:
                db.execute("DELETE FROM runtime WHERE app='worker'")

            p.send_signal(signal.SIGTERM);p.wait(timeout=12)
            assert alive(pid) and alive(child),'controller shutdown killed app'
            wait(lambda:not alive(shutdown_pid))
            p,token=launch()
            wait(lambda:app('worker')['runtime']['owned'] and app('worker')['runtime']['pid']==pid)
            assert api('/apps/worker/start',{})['worker']=='ok'
            assert app('worker')['runtime']['pid']==pid,'duplicate started'
            assert api('/apps/worker/restart',{})['worker']=='ok'
            wait(lambda:app('worker')['runtime']['pid']!=pid and app('worker')['runtime']['state']=='healthy')
            wait(lambda:not alive(child))
            config.write_text(text.replace('name: Integration worker','name: Renamed worker'))
            wait(lambda:app('worker')['config']['name']=='Renamed worker')
            config.write_text('version: 9\n')
            wait(lambda:bool(api('/config')['error']))
            assert app('worker')['runtime']['state']=='healthy'
            config.write_text(text)
            wait(lambda:not api('/config')['error'])
            crash_pid=app('worker')['runtime']['pid']
            p.kill();p.wait(timeout=10)
            assert alive(crash_pid),'controller crash killed workload'
            p,token=launch()
            wait(lambda:app('worker')['runtime']['pid']==crash_pid and app('worker')['runtime']['owned'])
            result=api('/profiles/stack/stop',{});assert all(v=='ok' for v in result.values()),result
            assert app('worker')['runtime']['state']=='stopped'
            assert len(api('/apps/worker/history'))>3
            assert len(api('/apps/worker/launches'))>=2
            assert 'backup-' in cli('backup')
            p.send_signal(signal.SIGTERM);p.wait(timeout=12)
            assert 'preserved' in cli('reset-state','--yes')
            print('PASS: CLI, API/SSE, process tree stop, restart, live logs, dependency health, profiles, external protection, config reload, SQLite recovery, crash-window recovery, controller crash, single instance, autostart, stop-on-exit, restart limits, custom commands, health recovery, backup/reset')
        finally:
            try:
                api('/profiles/stack/stop',{})
                api('/apps/custom-tool/stop',{})
                api('/apps/crash-loop/stop',{})
            except Exception:pass
            for p in processes:
                if p.poll() is None:
                    p.terminate()
                    try:p.wait(timeout=12)
                    except subprocess.TimeoutExpired:p.kill();p.wait()
            ext.shutdown()
if __name__=='__main__':main()
