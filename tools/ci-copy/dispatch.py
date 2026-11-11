# -*- coding: utf-8 -*-
# Start the CI copy's workflows for a commit already pushed there by
# ci_copy_run.ps1 (the branch feature/global-early-warning-autopilot at
# <commit>, and ci/dispatch at the copy-only commit adding workflow_dispatch
# to ci.yml).
#   python dispatch.py <full commit sha> <push time, UTC ISO 8601>
# "CI" is always dispatched on ci/dispatch. "Fork Autopilot CI" is dispatched
# only when the push did not start a run for the commit: a second run on the
# same branch would cancel the first (concurrency group per ref). Only a run
# created after the push and not cancelled counts, never an older run of the
# same commit.
# Exits non-zero when a dispatch is refused, so a launcher cannot go silent.
import json, subprocess, sys, time, urllib.error, urllib.request

REPO = 'Agent-Cognitive-Enterprise/gods-eye-view-ci'
sha, since = sys.argv[1], sys.argv[2]
if len(sha) != 40:
    sys.exit('give the full 40-character sha')
cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                      capture_output=True, text=True).stdout
token = dict(l.split('=', 1) for l in cred.splitlines() if '=' in l).get('password')
H = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}

def call(method, path, body=None):
    req = urllib.request.Request(f'https://api.github.com/repos/{REPO}{path}', method=method, headers=H,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req) as r:
            data = r.read()
            return r.status, json.loads(data) if data else None
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]

ok = True
st, body = call('POST', '/actions/workflows/ci.yml/dispatches', {'ref': 'ci/dispatch'})
print('CI on ci/dispatch:', 'dispatched' if st == 204 else f'REFUSED {st} {body}')
ok &= st == 204

push_run = None
for _ in range(6):
    st, runs = call('GET', f'/actions/workflows/fork-autopilot.yml/runs?head_sha={sha}&per_page=5')
    fresh = [r for r in (runs['workflow_runs'] if st == 200 else [])
             if r['created_at'] >= since and r.get('conclusion') != 'cancelled']
    if fresh:
        push_run = fresh[0]
        break
    time.sleep(10)
if push_run:
    print('Fork Autopilot CI: already started by the push, run', push_run['id'], push_run['status'])
else:
    st, body = call('POST', '/actions/workflows/fork-autopilot.yml/dispatches',
                    {'ref': 'feature/global-early-warning-autopilot'})
    print('Fork Autopilot CI:', 'dispatched' if st == 204 else f'REFUSED {st} {body}')
    ok &= st == 204
sys.exit(0 if ok else 1)
