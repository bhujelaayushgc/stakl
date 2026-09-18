#!/usr/bin/env python3
"""Requires Docker. Creates and removes only a unique localdesk-test Compose project."""
import json, pathlib, signal, socket, subprocess, tempfile, time, urllib.request, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='localdesk-compose-') as temp:
 d=pathlib.Path(temp); project='localdesk-test-'+uuid.uuid4().hex[:10]
 with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
 compose=d/'compose.yml';compose.write_text('''services:
  ticker:
    image: busybox:1.37
    command: [sh, -c, 'while true; do echo compose-ready; sleep 1; done']
    healthcheck:
      test: [CMD, 'true']
      interval: 1s
      timeout: 1s
      retries: 2
''')
 cfg=d/'config.yml';cfg.write_text(f'''version: 1
server: {{port: {port}, open_browser: false}}
apps:
  stack:
    name: Compose integration
    type: docker-compose
    cwd: {d}
    docker:
      compose_file: compose.yml
      project_name: {project}
    health: {{type: docker, interval: 1s, failure_threshold: 1}}
    stop: {{timeout: 2s}}
''')
 proc=subprocess.Popen([str(ROOT/'bin/localdesk'),'--config',str(cfg),'--no-browser'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
 def wait(fn):
  end=time.time()+35
  while time.time()<end:
   try:
    if fn():return
   except OSError:pass
   time.sleep(.2)
  raise AssertionError('timed out')
 try:
  wait(lambda:(d/'instance.json').exists());token=json.loads((d/'instance.json').read_text())['token']
  def api(path,body=None):
   r=urllib.request.Request(f'http://127.0.0.1:{port}/api'+path,data=b'{}' if body is not None else None,headers={'Authorization':'Bearer '+token,'X-LocalDesk':'1'})
   with urllib.request.urlopen(r,timeout=120) as response:return json.load(response)
  assert api('/apps/stack/start',{})['stack']=='ok'
  wait(lambda:api('/apps/stack')['runtime']['state']=='healthy')
  assert api('/apps/stack')['containers'][0]['health']=='healthy'
  wait(lambda:any('compose-ready' in l['text'] for l in api('/apps/stack/logs')))
  assert api('/apps/stack/restart',{})['stack']=='ok'
  wait(lambda:api('/apps/stack')['runtime']['state']=='healthy')
  assert api('/apps/stack/stop',{})['stack']=='ok'
  assert api('/apps/stack')['runtime']['state']=='stopped'
  assert api('/apps/stack/start',{})['stack']=='ok'
  wait(lambda:api('/apps/stack')['runtime']['state']=='healthy')
  assert api('/apps/stack/kill',{})['stack']=='ok'
  assert api('/apps/stack')['runtime']['state']=='stopped'
  print('PASS: real Docker Compose start, container status, health, logs, restart, stop, and force kill')
 finally:
  try:api('/apps/stack/stop',{})
  except Exception:pass
  proc.send_signal(signal.SIGTERM)
  try:proc.wait(timeout=15)
  except subprocess.TimeoutExpired:proc.kill();proc.wait()
  subprocess.run(['docker','compose','-f',str(compose),'--project-name',project,'down','--remove-orphans'],check=True,stdout=subprocess.DEVNULL)
