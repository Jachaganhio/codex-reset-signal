#!/usr/bin/env python3
"""Run the fork's bundled Node collector as a disposable, limited container."""
import argparse
import datetime as dt
import fcntl
import json
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path
import subprocess
import urllib.request

BASE = Path(__file__).resolve().parent
NAME = 'tibo-reset-worker'
BARK = '/opt/mihoyo-bbs/config/router_bark.json'


def notify(title, body):
    cfg = json.loads(Path(BARK).read_text())
    payload = dict(device_key=cfg['device_key'], title=title, body=body,
                   group='Tibo 额度提醒', isArchive='1', level='active')
    req = urllib.request.Request(cfg['server'].rstrip('/')+'/push',
          data=json.dumps(payload, ensure_ascii=False).encode(), method='POST',
          headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        result = json.load(response)
    if result.get('code') != 200:
        raise RuntimeError('Bark rejected notification')


def save(value):
    tmp = BASE/'health.json.tmp'
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    os.replace(tmp, BASE/'health.json')


def run(test=False):
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s',
        handlers=[RotatingFileHandler(BASE/'runner.log', maxBytes=262144, backupCount=2)])
    with (BASE/'runner.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        health_file = BASE/'health.json'
        health = json.loads(health_file.read_text()) if health_file.exists() else {}
        now = dt.datetime.now(dt.timezone.utc)
        image = json.loads((BASE/'runtime.json').read_text())['image']
        # The host lock serializes invocations. Clean only this worker's leftover
        # container before clearing its exclusive-create application lock.
        subprocess.run(['docker','rm','-f',NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        (BASE/'state/state.json.lock').unlink(missing_ok=True)
        command = ['docker','run','--rm','--name',NAME,'--memory','192m','--cpus','0.5',
          '--pids-limit','64','--cap-drop','ALL','--security-opt','no-new-privileges',
          '--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=16m',
          '--mount',f'type=bind,src={BASE}/app,dst=/app,readonly',
          '--mount',f'type=bind,src={BASE}/state,dst=/state',
          '--mount',f'type=bind,src={BARK},dst=/run/bark.json,readonly',
          '-e','SOURCE_PROVIDER=fxembed','-e','X_USERNAME=thsottiaux',
          '-e','X_EXCLUDE_REPLIES=false','-e','INCLUDE_MENTIONS=true',
          '-e','TARGET_TIMEZONE=Asia/Shanghai','-e','STATE_PATH=/state/state.json',
          '-e','PUBLIC_STATUS_PATH=/state/status.json','-e','BARK_CONFIG_PATH=/run/bark.json',
          image,'node','--max-old-space-size=96','/app/dist/monitor.mjs']
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=240)
            logging.info('worker_exit=%s output=%s',result.returncode,
                         (result.stdout+result.stderr).strip()[-8000:])
            if result.returncode:
                raise RuntimeError('Collector or notification delivery failed')
            state = json.loads((BASE/'state/state.json').read_text())
            if not state.get('lastSuccessAt') or (now-dt.datetime.fromisoformat(
                    state['lastSuccessAt'].replace('Z','+00:00'))).total_seconds() > 600:
                raise RuntimeError('Collector did not persist a fresh success')
            recovery = health.get('alerted',False)
            health.update(last_check=now.isoformat(),last_success=state['lastSuccessAt'],
                          healthy=True,failures=0,last_error=None,
                          latest_post=(state.get('latestObservedPost') or {}).get('id'))
            save(health)
            if recovery:
                notify('Tibo 监控 · 已恢复','R5S 已恢复直接采集，后续新消息将继续通知。这不是重置公告。')
                health['alerted']=False
                save(health)
            if test:
                notify('Tibo 监控 · 新版上线测试',
                       'R5S 已切换为你的 fork 直接采集 FxEmbed，不再等待第三方 RSS 更新。'
                       '\n每 5 分钟检查，失败消息保留重试。\n这是上线测试，不表示发生了新的重置。')
                health['test_bark_accepted']=dt.datetime.now(dt.timezone.utc).isoformat()
                save(health)
                logging.info('setup_test_bark_accepted')
            return 0
        except Exception as exc:
            health.update(last_check=now.isoformat(),healthy=False,
                          failures=health.get('failures',0)+1,last_error=type(exc).__name__)
            logging.error('runner_failed type=%s failures=%s',type(exc).__name__,health['failures'])
            if health['failures'] >= 3 and now.timestamp()-health.get('last_alert',0) >= 21600:
                try:
                    notify('Tibo 监控 · 连续检查失败',
                           'R5S 连续三次检查或投递失败，可能漏报；恢复后会再通知。故障持续时最多每六小时提醒。')
                    health.update(last_alert=now.timestamp(),alerted=True)
                except Exception:
                    logging.error('health_bark_failed')
            save(health)
            return 1
        finally:
            subprocess.run(['docker','rm','-f',NAME],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--test-notification',action='store_true')
    raise SystemExit(run(parser.parse_args().test_notification))
