#!/usr/bin/env python3
"""Signal Desk — universe gate patch kit. From a FRESH pull of the repo:

    cd ~/Desktop/Signal-Desk && git pull
    python3 /path/to/signal-desk-gate-patch/apply.py
    node signal-metrics-test.mjs && node worker-alert-test.mjs
    npx wrangler deploy            # worker: /universe route + gated alerts
    git add -A && git commit -m "Universe gate: hard floor for every stream, Filtered tab, 13D issuance/insider/token rules" && git push

Idempotent: each step refuses to run twice."""
import pathlib, runpy, shutil, sys
HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path.cwd()
for f in ('index.html', 'alpaca-proxy-worker.js', 'signal-metrics-test.mjs'):
    if not (ROOT / f).exists():
        sys.exit(f'run this from the repo root — {f} not found in {ROOT}')
(ROOT / 'test').mkdir(exist_ok=True)
shutil.copy(HERE / 'fixtures.mjs', ROOT / 'test' / 'fixtures.mjs')
shutil.copy(HERE / 'worker-alert-test.mjs', ROOT / 'worker-alert-test.mjs')
for step in ('patch_worker.py', 'patch_dashboard.py', 'patch_tests.py'):
    try:
        runpy.run_path(str(HERE / step), run_name='__main__')
    except SystemExit as e:
        if e.code not in (0, None): print(f'{step}: {e.code}')
print('done — now: node signal-metrics-test.mjs && node worker-alert-test.mjs, then npx wrangler deploy, then push')
