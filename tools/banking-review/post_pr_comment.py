# -*- coding: utf-8 -*-
# Post a markdown file as a comment on a PR of the fork. Usage: python post_pr_comment.py <pr> <file>
import json, subprocess, sys, urllib.request

REPO = 'Agent-Cognitive-Enterprise/gods-eye-view'
pr, path = sys.argv[1], sys.argv[2]
cred = subprocess.run(['git', 'credential', 'fill'], input='protocol=https\nhost=github.com\n\n',
                      capture_output=True, text=True, timeout=60).stdout
token = dict(l.split('=', 1) for l in cred.splitlines() if '=' in l).get('password')
if not token:
    print('no GitHub token from git credential fill'); sys.exit(2)
body = open(path, encoding='utf8').read()
req = urllib.request.Request(f'https://api.github.com/repos/{REPO}/issues/{pr}/comments', method='POST',
                             headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json'},
                             data=json.dumps({'body': body}).encode())
try:
    print(json.load(urllib.request.urlopen(req, timeout=60))['html_url'])
except urllib.error.HTTPError as e:
    print('HTTP', e.code, e.read().decode()[:300]); sys.exit(1)
