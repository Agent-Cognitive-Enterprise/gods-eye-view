# -*- coding: utf-8 -*-
# Mirror the CI copy's results onto a commit of the fork as GitHub commit
# statuses, so a reviewer sees CI on the commit itself.
#
#   python mirror_status.py <fork commit> [--dry-run]
#
# The fork's own Actions cannot run (GitHub refuses them), so CI runs in the
# copy repo Agent-Cognitive-Enterprise/gods-eye-view-ci: "Fork Autopilot CI"
# on the commit itself, and "CI" on a copy-only commit (the commit plus one
# line in ci.yml adding workflow_dispatch), whose parent must be the commit.
# For each workflow the newest completed run is read with all its jobs, and
# one status is posted:
#   context      "ci-copy / <workflow>"
#   state        success only if every job concluded success; failure if
#                any job failed or was cancelled; nothing is posted for a
#                workflow with no completed run (or one still running)
#   description  "<n>/<n> jobs passed in the CI copy (gods-eye-view-ci)"
#   target_url   the run in the copy repo
# Nothing is guessed: a missing or unfinished run is reported and skipped.
import io, json, subprocess, sys, urllib.error, urllib.request

FORK = 'Agent-Cognitive-Enterprise/gods-eye-view'
COPY = 'Agent-Cognitive-Enterprise/gods-eye-view-ci'
COPY_URL = f'https://github.com/{COPY}.git'
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

args = [a for a in sys.argv[1:] if not a.startswith('--')]
dry = '--dry-run' in sys.argv
if len(args) != 1:
    sys.exit('usage: mirror_status.py <fork commit> [--dry-run]')
sha = subprocess.run(['git', '-C', r'C:\Users\user\gev-autopilot', 'rev-parse', '--verify', args[0] + '^{commit}'],
                     capture_output=True, text=True).stdout.strip()
if len(sha) != 40:
    sys.exit(f'not a commit: {args[0]}')

cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                      capture_output=True, text=True).stdout
token = dict(l.split('=', 1) for l in cred.splitlines() if '=' in l).get('password')
if not token:
    sys.exit('no GitHub credential')
H = {'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'}


def api(method, url, body=None):
    req = urllib.request.Request(url, method=method, headers=H,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:300]


def runs_for(head_sha, workflow_file, event=None):
    st, body = api('GET', f'https://api.github.com/repos/{COPY}/actions/workflows/{workflow_file}/runs'
                          f'?head_sha={head_sha}&per_page=20')
    if st != 200:
        sys.exit(f'listing runs failed: {st} {body}')
    done = [r for r in body['workflow_runs'] if r['status'] == 'completed' and r['conclusion'] != 'cancelled'
            and (event is None or r['event'] == event)]
    return sorted(done, key=lambda r: r['created_at'], reverse=True)


def copy_only(candidate):
    """Whether a copy commit is this commit plus the ci.yml line, nothing else."""
    st, c = api('GET', f'https://api.github.com/repos/{COPY}/compare/{sha}...{candidate}')
    if st != 200:
        sys.exit(f'comparing {sha[:8]}...{candidate[:8]} failed: {st} {c}')
    if not (c['ahead_by'] == 1 and c['behind_by'] == 0
            and [f['filename'] for f in c['files']] == ['.github/workflows/ci.yml']):
        return False
    # The change itself: one added "workflow_dispatch:" line, nothing removed.
    lines = c['files'][0].get('patch', '').splitlines()
    added = [l[1:].strip() for l in lines if l.startswith('+') and not l.startswith('+++')]
    removed = [l for l in lines if l.startswith('-') and not l.startswith('---')]
    return added == ['workflow_dispatch:'] and not removed


# The copy-only commits on the copy's ci/dispatch branch whose parent is this
# commit: the "CI" workflow ran on one of them.
st, commits = api('GET', f'https://api.github.com/repos/{COPY}/commits?sha=ci/dispatch&per_page=30')
if st != 200:
    sys.exit(f'listing ci/dispatch failed: {st} {commits}')
dispatch = [c['sha'] for c in commits
            if [p['sha'] for p in c['parents']] == [sha] and copy_only(c['sha'])]
# Older copy-only commits are no longer on the branch (it is force-pushed):
# then search the CI runs and keep those whose head commit's only parent is
# this commit. Only a verified parent counts.
ci_runs = []
for d in dispatch:
    ci_runs += runs_for(d, 'ci.yml', event='workflow_dispatch')
if not ci_runs:
    st, body = api('GET', f'https://api.github.com/repos/{COPY}/actions/workflows/ci.yml/runs'
                          '?event=workflow_dispatch&per_page=100')
    if st != 200:
        sys.exit(f'listing CI runs failed: {st} {body}')
    for r in body['workflow_runs']:
        if r['status'] != 'completed' or r['conclusion'] == 'cancelled':
            continue
        st2, c = api('GET', f"https://api.github.com/repos/{COPY}/commits/{r['head_sha']}")
        if st2 != 200:
            sys.exit(f"reading copy commit {r['head_sha'][:8]} failed: {st2} {c}")
        if [p['sha'] for p in c['parents']] == [sha] and copy_only(r['head_sha']):
            ci_runs.append(r)
    ci_runs.sort(key=lambda r: r['created_at'], reverse=True)

plan = [('Fork Autopilot CI', runs_for(sha, 'fork-autopilot.yml')), ('CI', ci_runs)]
ok = True
for name, runs in plan:
    if not runs:
        print(f'{name}: no completed run for {sha[:8]} in the copy; nothing posted')
        ok = False
        continue
    run = runs[0]
    st, body = api('GET', run['jobs_url'] + '?per_page=50')
    if st != 200:
        sys.exit(f'listing jobs failed: {st} {body}')
    jobs = body['jobs']
    passed = [j for j in jobs if j['conclusion'] == 'success']
    state = 'success' if jobs and len(passed) == len(jobs) else 'failure'
    status = {
        'state': state,
        'context': f'ci-copy / {name}',
        'description': f'{len(passed)}/{len(jobs)} jobs passed in the CI copy (gods-eye-view-ci)'[:140],
        'target_url': run['html_url'],
    }
    print(f"{name}: run {run['id']} on {run['head_sha'][:8]} -> {state} ({len(passed)}/{len(jobs)})")
    for j in jobs:
        print(f"   {j['name']}: {j['conclusion']}")
    if dry:
        print('   dry run, would post:', json.dumps(status))
        continue
    st, body = api('POST', f'https://api.github.com/repos/{FORK}/statuses/{sha}', status)
    print('   posted' if st == 201 else f'   POST FAILED {st} {body}')
    ok &= st == 201
sys.exit(0 if ok else 1)
