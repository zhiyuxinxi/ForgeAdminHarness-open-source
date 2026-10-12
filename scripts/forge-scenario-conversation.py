#!/usr/bin/env python3
"""Drive an isolated scenario through the real Gateway and Harness HTTP APIs.

This driver submits user requirements and collects observations. It does not
implement business code, run business tests itself, or certify a scenario.
Credentials stay in memory; only the existing named Windows credential is read.
"""
import argparse
import hashlib
import http.cookiejar
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.parse
import urllib.request
import uuid


def write_new(path, value):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def safe_identity(value):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,95}', value):
        raise ValueError('Invalid scenario or round identity')
    return value


def load_credential(path):
    # The password is returned only to this process, never to the terminal,
    # command line, evidence, environment, or a copied credential file.
    literal = str(path.resolve()).replace("'", "''")
    code = ("$c=Import-Clixml -LiteralPath '" + literal + "'; "
            "@{username=$c.UserName;password=$c.GetNetworkCredential().Password}"
            "|ConvertTo-Json -Compress")
    result = subprocess.run(['powershell', '-NoProfile', '-Command', code],
                            capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


class Client:
    def __init__(self, gateway, credential_file):
        parsed = urllib.parse.urlsplit(gateway)
        if (parsed.scheme not in ('http', 'https') or not parsed.hostname
                or parsed.username or parsed.password or parsed.query
                or parsed.fragment or parsed.path not in ('', '/')):
            raise ValueError('Gateway must be an explicit credential-free origin')
        self.gateway = gateway.rstrip('/')
        self.hostname = parsed.hostname
        self.base = None
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        credentials = load_credential(credential_file)
        auth = self.http(self.gateway + '/forge-gateway/api/auth-context')
        self.http(self.gateway + '/forge-gateway/api/login', credentials,
                  {'x-forge-csrf-token': auth['csrfToken']})
        credentials.clear()
        session = self.http(self.gateway + '/forge-gateway/api/session')
        self.csrf = session['csrfToken']
        self.actor = session['user']['username']

    def http(self, url, body=None, headers=None):
        parsed = urllib.parse.urlsplit(url)
        origin = parsed.scheme + '://' + parsed.netloc
        if origin not in (self.gateway, self.base):
            raise ValueError('Request outside the bound Gateway or TaskSpace')
        request_headers = {'Origin': origin, **(headers or {})}
        if body is not None:
            request_headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(
            url, data=None if body is None else json.dumps(body).encode(),
            headers=request_headers)
        with self.opener.open(request, timeout=180) as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('Response exceeds the bounded observation size')
            return json.loads(data)

    def gateway_post(self, path, body, headers=None):
        return self.http(self.gateway + '/forge-gateway/api/' + path, body,
                         {'x-forge-csrf-token': self.csrf, **(headers or {})})

    def bind(self, record, project, title, *, existing_origin=None):
        conversation = record['conversation']
        if (record['actor'] != self.actor or conversation['title'] != title
                or conversation['projectSlug'] != project):
            raise ValueError('Conversation ownership or scenario binding changed')
        if existing_origin is not None:
            # Opening an already active TaskSpace still invokes start and writes
            # metadata. That can invalidate a concurrent Host source inventory.
            current = self.http(self.gateway + '/forge-gateway/api/conversations/'
                                + conversation['id'] + '/status')['conversation']
            if (any(current.get(key) != conversation.get(key)
                    for key in ('id', 'taskId', 'title', 'projectSlug'))
                    or current.get('status') != 'active'):
                raise ValueError('Owned scenario is not active or its binding changed')
            # The public status response intentionally omits port. Reuse the
            # origin captured during prepare; the native proxy still checks
            # the current authenticated owner, and session ID is checked below.
            parsed = urllib.parse.urlsplit(existing_origin)
        else:
            opened = self.gateway_post('conversations/' + conversation['id'] + '/open', {})
            parsed = urllib.parse.urlsplit(opened['url'])
        if (parsed.scheme not in ('http', 'https') or parsed.hostname != self.hostname
                or parsed.username or parsed.password or not 20000 <= parsed.port < 30000):
            raise ValueError('Unexpected TaskSpace origin')
        self.base = parsed.scheme + '://' + parsed.netloc

    def rpc(self, method, payload):
        if self.base is None:
            raise ValueError('TaskSpace is not bound')
        request = {'type': 'client-request', 'rpcId': str(uuid.uuid4()),
                   'method': method, 'payload': payload}
        result = self.http(self.base + '/api/' + method, request,
                           {'x-forge-csrf-token': self.csrf})
        if result.get('type') != 'server-response' or result.get('rpcId') != request['rpcId']:
            raise ValueError('RPC response identity mismatch')
        if result.get('result', {}).get('ok') is not True:
            error = result.get('result', {}).get('error', {})
            message = ' '.join(str(error.get('message') or '').split())
            if self.csrf:
                message = message.replace(self.csrf, '[REDACTED]')
            raise ValueError('RPC rejected: ' + method + ' / ' + str(error.get('code'))
                             + (' / ' + message[:2000] if message else ''))
        return result['result']['value']


def submit_once(client, directory, case, round_id, session, prompt):
    item = next(item for item in client.rpc('session.list', {})['items']
                if item['sessionId'] == session['sessionId'])
    if item.get('running'):
        raise ValueError('Session is running; observe its terminal state before binding the next source request')
    intent_path = directory / (case + '-' + round_id + '-intent.json')
    # Refuse replay even when a prior HTTP response was lost. The original
    # session must be observed before an explicit, separately named follow-up.
    intent = {'sessionId': session['sessionId'], 'submittedAt': time.time(),
              'promptSha256': hashlib.sha256(prompt.encode()).hexdigest()}
    write_new(intent_path, intent)
    result = client.rpc('session.prompt', {
        'sessionId': session['sessionId'], 'mode': 'queue',
        'clientTimeZone': 'Asia/Shanghai',
        'content': [{'type': 'text', 'text': prompt}]})
    value = {**intent, 'result': result}
    write_new(directory / (case + '-' + round_id + '-submission.json'), value)
    return value


def execute(args):
    case = safe_identity(args.case)
    round_id = safe_identity(args.round)
    directory = args.evidence_root.resolve()
    directory.mkdir(parents=True, exist_ok=True)
    title = args.title_prefix + ' / ' + case
    conversation_path = directory / (case + '-conversation.json')
    session_path = directory / (case + '-session.json')
    client = Client(args.gateway, args.credential_file)
    if args.action == 'create':
        if conversation_path.exists():
            raise ValueError('Creation evidence exists; use prepare or observe')
        key = hashlib.sha256((args.project + '\n' + title).encode()).hexdigest()
        result = client.gateway_post('conversations', {
            'projectSlug': args.project, 'title': title}, {'idempotency-key': key})
        value = {'actor': client.actor, 'conversation': result['conversation']}
        write_new(conversation_path, value)
        return value
    record = json.loads(conversation_path.read_text(encoding='utf-8'))
    session = None if args.action == 'prepare' else json.loads(session_path.read_text(encoding='utf-8'))
    client.bind(record, args.project, title, existing_origin=None if session is None else session['base'])
    if args.action == 'prepare':
        if session_path.exists():
            raise ValueError('Session binding exists; do not create another session')
        items = client.rpc('session.list', {}).get('items', [])
        if len(items) > 1 or any(item.get('running') for item in items):
            raise ValueError('Expected one idle or empty scenario session')
        sid = items[0]['sessionId'] if items else client.rpc(
            'session.create', {'cwd': '/workspace'})['sessionId']
        models = client.rpc('session.models', {'sessionId': sid})
        group = next(item for item in models['groups'] if item['id'] == 'openai-codex')
        if not any(item['id'] == args.model for item in group['models']):
            raise ValueError('The specified model is unavailable')
        client.rpc('session.selectModel', {
            'sessionId': sid, 'provider': 'openai-codex', 'model': args.model})
        current = client.rpc('session.models', {'sessionId': sid})['current']
        if current.get('provider') != 'openai-codex' or current.get('model') != args.model:
            raise ValueError('Model selection was not consumed')
        value = {'at': time.time(), 'sessionId': sid, 'base': client.base,
                 'conversationId': record['conversation']['id'],
                 'taskId': record['conversation']['taskId'], 'current': current}
        write_new(session_path, value)
        return value
    if (session['taskId'] != record['conversation']['taskId']
            or session['conversationId'] != record['conversation']['id']
            or session['base'] != client.base):
        raise ValueError('Session no longer matches its scenario TaskSpace')
    if args.action == 'send':
        if args.prompt is None:
            raise ValueError('--prompt is required')
        current = client.rpc('session.models', {'sessionId': session['sessionId']})['current']
        if (current.get('provider') != session['current']['provider']
                or current.get('model') != session['current']['model']):
            raise ValueError('Model drifted after preparation')
        return submit_once(client, directory, case, round_id, session,
                           args.prompt.read_text(encoding='utf-8'))
    items = client.rpc('session.list', {})['items']
    item = next(item for item in items if item['sessionId'] == session['sessionId'])
    history = client.rpc('session.history', {'sessionId': session['sessionId'], 'maxMessages': 12})
    path = directory / (case + '-history-' + str(time.time_ns()) + '.json')
    write_new(path, {'item': item, 'history': history})
    return {'sessionId': item['sessionId'], 'running': item.get('running'),
            'historyPath': str(path), 'certified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['create', 'prepare', 'send', 'observe'])
    parser.add_argument('--case', required=True)
    parser.add_argument('--title-prefix', required=True)
    parser.add_argument('--evidence-root', type=Path, required=True)
    parser.add_argument('--credential-file', type=Path, required=True)
    parser.add_argument('--gateway', default='http://192.0.2.12:13080')
    parser.add_argument('--project', default='forge-base')
    parser.add_argument('--model', default='gpt-5.6-luna',
                        choices=['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-6-sol'])
    parser.add_argument('--round', default='initial')
    parser.add_argument('--prompt', type=Path)
    args = parser.parse_args()
    print(json.dumps(execute(args), ensure_ascii=False))


if __name__ == '__main__':
    main()
