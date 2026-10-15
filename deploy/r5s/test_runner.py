import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('r5s_runner',Path(__file__).with_name('runner.py'))
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.base=Path(self.temp.name)
        (self.base/'state').mkdir()
        (self.base/'runtime.json').write_text(json.dumps({'image':'node@sha256:test'}))
        self.patch_base=patch.object(runner,'BASE',self.base);self.patch_base.start()
        self.patch_notify=patch.object(runner,'notify');self.notify=self.patch_notify.start()
        self.patch_handler=patch.object(runner,'RotatingFileHandler',return_value=runner.logging.NullHandler())
        self.patch_handler.start()
        self.returncode=0
        self.calls=[]
        self.patch_run=patch.object(runner.subprocess,'run',side_effect=self.process)
        self.patch_run.start()

    def tearDown(self):
        self.patch_run.stop();self.patch_notify.stop();self.patch_handler.stop();self.patch_base.stop();self.temp.cleanup()

    def process(self,args,**kwargs):
        self.calls.append(args)
        if args[1]=='run':
            if self.returncode==0:
                (self.base/'state/state.json').write_text(json.dumps({
                  'lastSuccessAt':dt.datetime.now(dt.timezone.utc).isoformat(),
                  'latestObservedPost':{'id':'123'}}))
            return subprocess.CompletedProcess(args,self.returncode,'Checked','')
        return subprocess.CompletedProcess(args,0,'','')

    def test_success_and_explicit_test_notification(self):
        self.assertEqual(runner.run(True),0)
        health=json.loads((self.base/'health.json').read_text())
        self.assertTrue(health['healthy']);self.assertEqual(health['failures'],0)
        self.assertIn('test_bark_accepted',health)
        self.assertEqual(self.notify.call_count,1)
        self.assertEqual(self.calls[-1],['docker','rm','-f',runner.NAME])

    def test_failures_are_throttled_and_recovery_notifies_once(self):
        self.returncode=1
        for _ in range(4):self.assertEqual(runner.run(),1)
        self.assertEqual(self.notify.call_count,1)
        self.returncode=0
        self.assertEqual(runner.run(),0)
        self.assertEqual(self.notify.call_count,2)
        self.assertEqual(runner.run(),0)
        self.assertEqual(self.notify.call_count,2)

    def test_timeout_cleans_up_container(self):
        def timeout(args,**kwargs):
            self.calls.append(args)
            if args[1]=='run':raise subprocess.TimeoutExpired(args,240)
            return subprocess.CompletedProcess(args,0)
        with patch.object(runner.subprocess,'run',side_effect=timeout):
            self.assertEqual(runner.run(),1)
        self.assertEqual(self.calls[-1],['docker','rm','-f',runner.NAME])


if __name__=='__main__':unittest.main()
