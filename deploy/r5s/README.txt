R5S production layout

The TypeScript collector is bundled into dist/monitor.mjs, then run by runner.py
inside a disposable official Node 22 Alpine container. It does not use the
maintainer's aggregate RSS feed. No inbound ports are published.

Limits: 192 MiB container memory, 96 MiB Node heap, 0.5 CPU, 64 PIDs, read-only
root filesystem, all capabilities dropped, no-new-privileges, 240-second timeout.
Containers exit after each run. The host flock serializes invocations. The
collector has its own application lock and persistent delivery outbox.

Production path: /opt/tibo-monitor-v2
  runner.py               Host Python 3 scheduler / health notifications
  runtime.json            {"image":"node@sha256:<verified image digest>"}
  app/dist/monitor.mjs    Bundled src/cli.ts
  app/dist/verify.mjs     Bundled scripts/verify-source.ts
  app/dist/migrate.mjs    Bundled deploy/r5s/migrate.ts
  state/state.json        Collector checkpoint, seen fingerprints, outbox
  state/status.json       Local non-secret status projection
  health.json             Runner status and health notification timestamps
  runner.log              Bounded host log, 256 KiB with two backups

All paths are protected by host root permissions. Bark credentials stay at
/opt/mihoyo-bbs/config/router_bark.json and are mounted read-only into the worker.
The credential file is never mounted for verify-source or migration. Do not
place credentials in the repository or in runtime.json.

Build each of the three TypeScript entry points with esbuild from the locked
development dependencies:
  --bundle --platform=node --target=node22 --format=esm
  --banner:js='import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'
The resulting bundles require no node_modules in production. Build and verify
artifacts before installing, and record the git commit and SHA256 checksums.

Migration takes legacy Python state and a new, nonexistent destination state.
It reads one public timeline page, retains legacy known IDs, skips historical
posts before today's Asia/Shanghai midnight, and permits catch-up of today's
undelivered posts. It never sends notifications. Inspect its catch-up preview
before the first production run. If today's history spans multiple pages, the
preview is partial and requires manual reconciliation before cutover.

After backup and successful validation, replace ONLY the old cron line marked
"# tibo-reset-monitor" with:
  */5 * * * * /usr/bin/python3 /opt/tibo-monitor-v2/runner.py >/dev/null 2>&1 # tibo-reset-monitor
Keep all unrelated cron lines. Old /opt/tibo-monitor is retained for rollback.

Test notification: python3 /opt/tibo-monitor-v2/runner.py --test-notification
This first performs a real collection run, so any pending real notifications
will also be delivered. The setup notification is clearly labelled as a test.

Health: notify after three failed runs, at most every six hours during an ongoing
failure; send recovery once healthy again. Bark errors retain the outbox; no
provider failure is treated as evidence that no new post exists. A hanging or
crashed worker is cleaned up on the next invocation after the host lock is held.

Rollback requires replacing the cron command with the original Python monitor;
restore its own legacy-format state if needed. Do not feed v2 state into it.

Verification: npm test, npm run typecheck, and python3 deploy/r5s/test_runner.py.
Also verify source access inside the exact pinned production image and limits,
then check accepted Bark deliveries and a second run with an empty outbox.
Third-party FxEmbed completeness/availability and actual iOS delivery are not
guaranteed by an HTTP success from the notification service.
