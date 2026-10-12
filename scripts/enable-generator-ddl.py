#!/usr/bin/env python3
"""Enable CREATE-only generator accounts/config for two fixed projects. Never starts services."""
import argparse
import base64
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import sys
import tempfile
import urllib.parse

PROJECT_ROOT = Path('/srv/forge-delivery/projects')
DATABASE_HOST = '192.0.2.209'
APPLICATION_HOST = '192.0.2.12'
TEMPLATE_SHA = '2b753892a4977382d91147fa4d9a1e83d6ddec5d8ffbffac0e0ed0b5a9d64bba'
LOCATION = 'optional:file:/run/forge/generator-ddl.yml'
TARGETS = {'forge-base': ('forge_forge_base', 'forge_base_ddl'),
           'demoteam-phase2': ('forge_guanghui_phase2', 'guanghui_phase2_ddl')}
PASSWORD = re.compile(r'[A-Za-z0-9_-]{48,128}')


class Refused(RuntimeError):
    pass


def need(condition, code):
    if not condition:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def validate_plan(plan):
    need(plan.get('schemaVersion') == 1 and plan.get('databaseHost') == DATABASE_HOST
         and plan.get('databasePort') == 3306 and plan.get('accountHost') == APPLICATION_HOST
         and plan.get('expectedPartialRevokes') is False and plan.get('privileges') == ['CREATE']
         and plan.get('templateSha256') == TEMPLATE_SHA, 'PLAN_IDENTITY_MISMATCH')
    need(len(plan.get('targets', [])) == 2, 'PLAN_TARGET_COUNT')
    seen = set()
    for target in plan['targets']:
        slug = target.get('project')
        need(slug in TARGETS and slug not in seen, 'PLAN_PROJECT_MISMATCH')
        seen.add(slug)
        schema, user = TARGETS[slug]
        ops = PROJECT_ROOT / slug / 'ops'
        need(target.get('schema') == schema and target.get('dedicatedUser') == user
             and target.get('grantSchemaPattern') == schema.replace('_', r'\_')
             and target.get('composeFile') == (ops / 'compose.yaml').as_posix()
             and target.get('externalConfigFile') == (ops / 'generator-ddl.yml').as_posix()
             and target.get('privateEnvironmentFile') == (ops / 'generator-ddl.env').as_posix(), 'PLAN_TARGET_MISMATCH')
    need(seen == set(TARGETS), 'PLAN_TARGET_SET')
    return plan


def merged_csv(value, addition, default=''):
    current = str(value or default).strip()
    return current if addition in [item.strip() for item in current.split(',')] else ','.join(filter(None, (current, addition)))


def patch_compose(text, environment, mount_present=False):
    """Edit only the fixed service's three ordinary YAML blocks; preserve all other bytes."""
    lines = text.splitlines(keepends=True)
    starts = [i for i, line in enumerate(lines) if re.fullmatch(r'  forge-admin:\s*\n?', line)]
    need(len(starts) == 1, 'COMPOSE_ADMIN_SECTION_UNSUPPORTED')
    start = starts[0]
    end = next((i for i in range(start + 1, len(lines))
                if re.match(r'^(?:  [A-Za-z0-9_-]+:|[^ #\r\n])', lines[i])), len(lines))
    block = lines[start:end]
    wanted = {'SPRING_PROFILES_ACTIVE': merged_csv(environment.get('SPRING_PROFILES_ACTIVE'), 'generator-ddl', 'prod'),
              'SPRING_CONFIG_ADDITIONAL_LOCATION': merged_csv(environment.get('SPRING_CONFIG_ADDITIONAL_LOCATION'), LOCATION)}

    def section(name):
        found = [i for i, line in enumerate(block) if re.match(r'^    ' + name + r':', line)]
        need(len(found) <= 1, 'COMPOSE_DUPLICATE_SECTION')
        if not found:
            block.extend(['    ' + name + ':\n'])
            return len(block) - 1, len(block)
        first = found[0]
        need(re.fullmatch(r'    ' + name + r':\s*(?:#.*)?\n?', block[first]) is not None, 'COMPOSE_INLINE_SECTION_UNSUPPORTED')
        last = next((i for i in range(first + 1, len(block)) if re.match(r'^    [A-Za-z0-9_-]+:', block[i])), len(block))
        return first, last

    first, last = section('env_file')
    owned_env = './generator-ddl.env'
    if not any(re.fullmatch(r"\s+-\s+['\"]?(?:\./)?generator-ddl\.env['\"]?\s*\n?", line) for line in block[first + 1:last]):
        block.insert(last, '      - ' + owned_env + '\n')
    first, last = section('environment')
    actual = [line for line in block[first + 1:last] if line.strip() and not line.lstrip().startswith('#')]
    list_style = bool(actual and actual[0].lstrip().startswith('- '))
    for key, value in wanted.items():
        pattern = r'^      -\s*' + key + r'(?:=|\s*$)' if list_style else r'^      ' + key + ':'
        found = [i for i in range(first + 1, last) if re.match(pattern, block[i])]
        need(len(found) <= 1, 'COMPOSE_DUPLICATE_ENVIRONMENT_KEY')
        replacement = ('      - ' + key + '=' + value + '\n') if list_style else ('      ' + key + ': ' + json.dumps(value) + '\n')
        if found:
            block[found[0]] = replacement
        else:
            block.insert(last, replacement)
            last += 1
    first, last = section('volumes')
    if not mount_present:
        block.insert(last, '      - ./generator-ddl.yml:/run/forge/generator-ddl.yml:ro\n')
    return ''.join(lines[:start] + block + lines[end:]), wanted


def inspect_grants(raw, schema, complete=True):
    expected = '`' + schema.replace('_', r'\_') + '`.*'
    privileges = set()
    for line in raw.splitlines():
        match = re.fullmatch(r'GRANT (.+?) ON (.+?) TO .+', line)
        need(match is not None and 'WITH GRANT OPTION' not in line, 'ACCOUNT_UNEXPECTED_GRANT_OR_ROLE')
        rights = set(match[1].split(', '))
        if match[2] == '*.*' and rights == {'USAGE'}:
            continue
        need(match[2] == expected and rights <= {'CREATE'}, 'ACCOUNT_PRIVILEGE_SCOPE_MISMATCH')
        privileges.update(rights)
    need(not complete or privileges == {'CREATE'}, 'ACCOUNT_CREATE_GRANT_MISSING')
    return privileges


def ordinary(path, maximum=262144, mode=None):
    metadata = path.lstat()
    need(stat.S_ISREG(metadata.st_mode) and not path.is_symlink() and metadata.st_nlink == 1
         and metadata.st_size <= maximum and path.resolve() == path, 'PRIVATE_OR_CONFIG_FILE_INVALID')
    need(mode is None or stat.S_IMODE(metadata.st_mode) == mode, 'PRIVATE_FILE_MODE_INVALID')
    return metadata


def read_private(ops, user):
    filename = ops / 'generator-ddl.env'
    if not filename.exists():
        return None
    metadata = ordinary(filename, 8192, 0o600)
    owner = ordinary(ops / 'project.env')
    need(metadata.st_uid == owner.st_uid, 'PRIVATE_FILE_OWNER_MISMATCH')
    lines = filename.read_text().splitlines()
    need(len(lines) == 2 and all('=' in line for line in lines), 'PRIVATE_FILE_CONTENT_INVALID')
    values = dict(line.split('=', 1) for line in lines)
    need(set(values) == {'GENERATOR_DDL_DB_USER', 'GENERATOR_DDL_DB_PASSWORD'}
         and values['GENERATOR_DDL_DB_USER'] == user
         and PASSWORD.fullmatch(values['GENERATOR_DDL_DB_PASSWORD']) is not None, 'PRIVATE_FILE_CONTENT_INVALID')
    return {'user': user, 'password': values['GENERATOR_DDL_DB_PASSWORD']}


def create_file(path, raw, owner, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
        os.fchown(stream.fileno(), owner.st_uid, owner.st_gid)
        os.fchmod(stream.fileno(), mode)


def compose_config(ops, filename):
    result = subprocess.run(['docker', 'compose', '--env-file', str(ops / 'project.env'),
                             '--project-directory', str(ops), '-f', str(filename), 'config', '--format', 'json'],
                            capture_output=True, text=True, timeout=30)
    need(result.returncode == 0, 'COMPOSE_CONFIG_REJECTED')
    return json.loads(result.stdout)


def validate_master(config, schema):
    admin = config['services']['forge-admin']
    environment = admin.get('environment', {})
    mounts = [item for item in admin.get('volumes', []) if item['target'] == '/app/application-prod.yml']
    need(len(mounts) == 1, 'MASTER_CONFIG_MOUNT_MISMATCH')
    filename = Path(mounts[0]['source'])
    ordinary(filename)
    parents, master_url = [], None
    for line in filename.read_text().splitlines():
        match = re.match(r'^( *)([A-Za-z0-9_-]+):(?:\s+(.*))?\s*$', line)
        if not match:
            continue
        indent, key, value = len(match[1]), match[2], match[3]
        while parents and parents[-1][0] >= indent:
            parents.pop()
        dotted = '.'.join([item[1] for item in parents] + [key])
        if value is None:
            parents.append((indent, key))
        elif dotted == 'spring.datasource.dynamic.datasource.master.url':
            master_url = value.strip().strip('\"\'')
    need(master_url is not None, 'MASTER_URL_MISSING')
    def resolve(match):
        key, _, default = match[1].partition(':')
        return str(environment.get(key, default))
    resolved = re.sub(r'\$\{([^}]+)\}', resolve, master_url)
    parsed = urllib.parse.urlsplit(resolved.removeprefix('jdbc:'))
    need(parsed.scheme == 'mysql' and parsed.hostname == DATABASE_HOST and (parsed.port or 3306) == 3306
         and parsed.path == '/' + schema, 'MASTER_DATABASE_IDENTITY_MISMATCH')
    return admin


def verify_projection(before, after, credentials, wanted, config_path):
    left, right = json.loads(json.dumps(before)), json.loads(json.dumps(after))
    old = left['services'].pop('forge-admin')
    new = right['services'].pop('forge-admin')
    need(left == right, 'NON_ADMIN_CONFIGURATION_CHANGED')
    expected_environment = {**old.pop('environment', {}), **wanted,
                            'GENERATOR_DDL_DB_USER': credentials['user'], 'GENERATOR_DDL_DB_PASSWORD': credentials['password']}
    need(new.pop('environment', {}) == expected_environment, 'ADMIN_ENVIRONMENT_MERGE_MISMATCH')
    old_volumes, new_volumes = old.pop('volumes', []), new.pop('volumes', [])
    wanted_volumes = [item for item in new_volumes if item['target'] == '/run/forge/generator-ddl.yml']
    need(len(wanted_volumes) == 1 and wanted_volumes[0].get('source') == str(config_path)
         and wanted_volumes[0].get('read_only') is True and wanted_volumes[0].get('type') == 'bind', 'DDL_MOUNT_MISMATCH')
    need([item for item in new_volumes if item['target'] != '/run/forge/generator-ddl.yml']
         == [item for item in old_volumes if item['target'] != '/run/forge/generator-ddl.yml']
         and old == new, 'ADMIN_UNRELATED_CONFIGURATION_CHANGED')


def application_helper(request):
    slug = request.get('project')
    need(slug in TARGETS and request.get('action') in {'inspect', 'save', 'stage', 'commit', 'fence-acquire', 'fence-release'}, 'APPLICATION_REQUEST_INVALID')
    schema, user = TARGETS[slug]
    ops = PROJECT_ROOT / slug / 'ops'
    need(ops.resolve() == ops and ops.is_dir(), 'PROJECT_OPS_IDENTITY_MISMATCH')
    action = request['action']
    if action.startswith('fence-'):
        return release_fence(ops, action, request.get('operationId'))
    if action != 'inspect':
        require_fence(ops, request.get('operationId'))
    compose = ops / 'compose.yaml'
    owner = ordinary(ops / 'project.env')
    metadata = ordinary(compose)
    original = compose.read_bytes()
    private = read_private(ops, user)
    if action == 'inspect':
        validate_master(compose_config(ops, compose), schema)
        return {'composeSha256': sha(original), 'credentials': private}
    need(request.get('expectedComposeSha256') == sha(original), 'COMPOSE_CHANGED_SINCE_PREFLIGHT')
    if action == 'save':
        proposed = request.get('credentials', {})
        need(set(proposed) == {'user', 'password'} and proposed['user'] == user
             and PASSWORD.fullmatch(proposed['password']) is not None, 'DEDICATED_CREDENTIAL_INVALID')
        if private is not None:
            need(private == proposed, 'SAVED_CREDENTIAL_MISMATCH')
            return {'created': False}
        create_file(ops / 'generator-ddl.env', ('GENERATOR_DDL_DB_USER=' + user
                    + '\nGENERATOR_DDL_DB_PASSWORD=' + proposed['password'] + '\n').encode(), owner, 0o600)
        return {'created': True}
    need(private is not None, 'DEDICATED_CREDENTIAL_NOT_PERSISTED')
    template = base64.b64decode(request.get('templateBase64', ''), validate=True)
    need(sha(template) == TEMPLATE_SHA, 'DDL_TEMPLATE_DIGEST_MISMATCH')
    config_path = ops / 'generator-ddl.yml'
    if config_path.exists():
        ordinary(config_path)
        need(config_path.read_bytes() == template, 'EXISTING_DDL_CONFIG_MISMATCH')
    else:
        create_file(config_path, template, owner, 0o644)
    before = compose_config(ops, compose)
    admin = validate_master(before, schema)
    mounts = [item for item in admin.get('volumes', []) if item['target'] == '/run/forge/generator-ddl.yml']
    need(len(mounts) <= 1 and (not mounts or (mounts[0].get('source') == str(config_path)
         and mounts[0].get('read_only') is True)), 'EXISTING_DDL_MOUNT_MISMATCH')
    proposed, wanted = patch_compose(original.decode(), admin.get('environment', {}), bool(mounts))
    raw = proposed.encode()
    if action == 'commit':
        need(request.get('candidateSha256') == sha(raw), 'CONFIG_CANDIDATE_CHANGED')
    fd, temporary = tempfile.mkstemp(prefix='.generator-ddl-compose-', suffix='.yaml', dir=ops)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(raw); stream.flush(); os.fsync(stream.fileno())
        verify_projection(before, compose_config(ops, temporary), private, wanted, config_path)
        if action == 'commit' and raw != original:
            need(compose.read_bytes() == original, 'COMPOSE_CHANGED_BEFORE_REPLACE')
            backup = ops / ('compose.pre-generator-ddl-' + sha(original)[:16] + '.yaml')
            if backup.exists():
                ordinary(backup)
                need(backup.read_bytes() == original, 'COMPOSE_BACKUP_MISMATCH')
            else:
                create_file(backup, original, metadata, 0o600)
            os.chown(temporary, metadata.st_uid, metadata.st_gid)
            os.chmod(temporary, stat.S_IMODE(metadata.st_mode))
            os.replace(temporary, compose)
        return {'composeSha256': sha(original), 'candidateSha256': sha(raw),
                'changed': raw != original, 'committed': action == 'commit', 'servicesStarted': False}
    finally:
        temporary.unlink(missing_ok=True)


def require_fence(ops, operation):
    need(isinstance(operation, str) and re.fullmatch(r'generator-ddl-[0-9a-f]{24}', operation), 'FENCE_OPERATION_INVALID')
    broker = ops.parent / 'taskspaces/.broker'
    need(broker.resolve() == broker and broker.is_dir(), 'BROKER_PATH_MISMATCH')
    fence = broker / 'release.lock'
    need(fence.is_dir() and not fence.is_symlink(), 'OWNED_RELEASE_FENCE_REQUIRED')
    owner = fence / 'owner.json'
    ordinary(owner)
    need(json.loads(owner.read_text())['operationId'] == operation, 'RELEASE_FENCE_OWNER_MISMATCH')
    return fence, owner


def release_fence(ops, action, operation):
    need(isinstance(operation, str) and re.fullmatch(r'generator-ddl-[0-9a-f]{24}', operation), 'FENCE_OPERATION_INVALID')
    broker = ops.parent / 'taskspaces/.broker'
    need(broker.resolve() == broker and broker.is_dir(), 'BROKER_PATH_MISMATCH')
    if action == 'fence-release':
        fence, owner = require_fence(ops, operation)
        owner.unlink(); fence.rmdir()
        return {'released': True}
    need(not (broker / 'maintenance.json').exists(), 'PROJECT_MAINTENANCE_ACTIVE')
    fence = broker / 'release.lock'
    need(not fence.exists(), 'PROJECT_RELEASE_ACTIVE')
    metadata = ordinary(ops / 'project.env')
    fence.mkdir(mode=0o700)
    os.chown(fence, metadata.st_uid, metadata.st_gid)
    owner = {'schemaVersion': 1, 'instanceId': 'platform-maintenance', 'operationId': operation,
             'taskId': 'platform-maintenance', 'actorId': 'platform-operator',
             'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    create_file(fence / 'owner.json', json.dumps(owner).encode(), metadata, 0o600)
    return {'acquired': True}


def import_bridge(root):
    spec = importlib.util.spec_from_file_location('existing_ddl_database_bridge', root / 'scripts/provision-delivery-center-database.py')
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    return bridge


def remote_request(bridge, client, sudo, request, source):
    command = shlex.join(['sudo', '-S', '-p', '', '--', 'python3', '-c', source, '--application-helper'])
    stdin, stdout, _ = client.exec_command(command, timeout=60)
    stdin.write(sudo + '\n' + json.dumps(request)); stdin.flush(); stdin.channel.shutdown_write()
    raw, _, code = bridge.bounded_channel(stdout.channel, timeout=60)
    response = json.loads(raw)
    need(code == 0 and response.get('ok') is True, response.get('code', 'APPLICATION_HELPER_FAILED'))
    return response['result']


def inspect_database(bridge, connection, password, schema, user):
    mysql = lambda sql: bridge.mysql(connection, password, sql)
    identity = json.loads(mysql("SELECT JSON_OBJECT('version',VERSION(),'account',CURRENT_USER(),'partialRevokes',@@partial_revokes,'mandatoryRoles',LENGTH(@@mandatory_roles));"))
    need(identity['version'].startswith('8.0.') and identity['account'] == 'root@localhost'
         and identity['partialRevokes'] == 0 and identity['mandatoryRoles'] == 0, 'DATABASE_POLICY_CHANGED')
    need(mysql("SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='" + schema + "';") == '1', 'SCHEMA_NOT_FOUND')
    defaults = mysql('SELECT url FROM `' + schema + '`.gen_datasource WHERE is_default=1;')
    for url in defaults.splitlines():
        parsed = urllib.parse.urlsplit(url.removeprefix('jdbc:'))
        need(parsed.scheme == 'mysql' and parsed.hostname == DATABASE_HOST and (parsed.port or 3306) == 3306
             and parsed.path == '/' + schema, 'GENERATOR_DEFAULT_DATABASE_MISMATCH')
    accounts = mysql("SELECT Host,account_locked FROM mysql.user WHERE User='" + user + "';")
    if not accounts:
        return False, set()
    need(accounts == APPLICATION_HOST + '\tN', 'EXISTING_ACCOUNT_IDENTITY_MISMATCH')
    need(mysql("SELECT COUNT(*) FROM mysql.role_edges WHERE TO_USER='" + user + "';") == '0', 'EXISTING_ACCOUNT_HAS_ROLES')
    return True, inspect_grants(mysql("SHOW GRANTS FOR '" + user + "'@'" + APPLICATION_HOST + "';"), schema, complete=False)


def enable(credential_root, template, receipt):
    bridge = import_bridge(credential_root)
    load = bridge.credential_loader()
    app = bridge.connect(APPLICATION_HOST, 'forge', key_filename=str(Path.home() / '.ssh/id_ed25519_forge_delivery'))
    database = None
    acquired = []
    operation = 'generator-ddl-' + secrets.token_hex(12)
    try:
        sudo = load(credential_root / '服务器账号密码.txt')
        database = bridge.connect(DATABASE_HOST, 'root', password=load(credential_root / '数据库服务器账号密码.txt'))
        db_password = load(credential_root / '数据库账号密码.txt')
        source = Path(__file__).read_text(encoding='utf-8-sig')
        request = lambda payload: remote_request(bridge, app, sudo, payload, source)
        for slug in TARGETS:
            request({'action': 'fence-acquire', 'project': slug, 'operationId': operation})
            acquired.append(slug)
        # Detect target/config/account conflicts for both projects before mutation.
        pending = []
        for slug, (schema, user) in TARGETS.items():
            receipt['stage'] = 'preflight-' + slug
            inspected = request({'action': 'inspect', 'project': slug})
            exists, rights = inspect_database(bridge, database, db_password, schema, user)
            need(not exists or inspected['credentials'] is not None, 'ACCOUNT_EXISTS_WITHOUT_OWNED_CREDENTIALS')
            credentials = inspected['credentials'] or {'user': user, 'password': 'Aa0_' + secrets.token_urlsafe(48)}
            if exists:
                bridge.authenticate_account(app, credentials)
            pending.append((slug, schema, user, inspected, credentials, exists, rights))
        for slug, schema, user, inspected, credentials, exists, rights in pending:
            base = {'project': slug, 'expectedComposeSha256': inspected['composeSha256'], 'operationId': operation}
            public = {'project': slug, 'schema': schema, 'account': user + '@' + APPLICATION_HOST,
                      'servicesStarted': False, 'accountCreated': False, 'grantApplied': False}
            receipt['projects'].append(public)
            receipt['stage'] = 'save-private-config-' + slug
            public['credentialCreated'] = request({**base, 'action': 'save', 'credentials': credentials})['created']
            config = {**base, 'templateBase64': base64.b64encode(template).decode()}
            candidate = request({**config, 'action': 'stage'})
            receipt['stage'] = 'create-only-account-' + slug
            if not exists:
                # Do not hide a concurrent account creation with IF NOT EXISTS.
                bridge.mysql(database, db_password, "CREATE USER '" + user + "'@'" + APPLICATION_HOST
                             + "' IDENTIFIED BY '" + credentials['password'] + "';")
                public['accountCreated'] = True
            if rights != {'CREATE'}:
                bridge.mysql(database, db_password, "GRANT CREATE ON `" + schema.replace('_', r'\_')
                             + "`.* TO '" + user + "'@'" + APPLICATION_HOST + "';")
                public['grantApplied'] = True
            if public['accountCreated'] or public['grantApplied']:
                exists_after, rights_after = inspect_database(bridge, database, db_password, schema, user)
                need(exists_after and rights_after == {'CREATE'}, 'CREATE_ONLY_ACCOUNT_NOT_VERIFIED')
                bridge.authenticate_account(app, credentials)
            receipt['stage'] = 'commit-admin-config-' + slug
            public['configuration'] = request({**config, 'action': 'commit', 'candidateSha256': candidate['candidateSha256']})
            public['privileges'] = ['CREATE']
        receipt['status'] = 'configured-no-service-start'
    finally:
        release_errors = []
        for slug in reversed(acquired):
            try:
                request({'action': 'fence-release', 'project': slug, 'operationId': operation})
            except Exception as error:
                release_errors.append({'project': slug, 'code': public_error(error), 'operationId': operation})
        if release_errors:
            receipt['releaseFenceErrors'] = release_errors
            receipt['status'] = 'configured-fence-release-pending'
        app.close()
        if database is not None:
            database.close()
        need(not release_errors, 'RELEASE_FENCE_CLEANUP_PENDING')


def public_error(error):
    value = str(error)
    return value if re.fullmatch(r'[A-Z][A-Z0-9_]{2,100}', value) else 'FAILED_' + type(error).__name__.upper()


def main():
    if sys.argv[1:] == ['--application-helper']:
        try:
            print(json.dumps({'ok': True, 'result': application_helper(json.load(sys.stdin))}))
            return 0
        except Exception as error:
            print(json.dumps({'ok': False, 'code': public_error(error)}))
            return 1
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=root / 'docs/long-tasks/backend-audit-remediation-20261009/generator-ddl-activation-plan.json')
    parser.add_argument('--credential-root', type=Path, default=root)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--receipt', type=Path)
    args = parser.parse_args()
    plan = validate_plan(json.loads(args.plan.read_text(encoding='utf-8')))
    template = (root / 'templates/project/generator-ddl-datasource.yml.tpl').read_bytes().replace(b'\r\n', b'\n')
    need(sha(template) == TEMPLATE_SHA, 'LOCAL_TEMPLATE_DIGEST_MISMATCH')
    receipt = {'status': 'local-plan-ready', 'stage': 'validated-plan', 'projects': [],
               'planSha256': sha(args.plan.read_bytes()), 'scriptSha256': sha(Path(__file__).read_bytes()),
               'templateSha256': TEMPLATE_SHA, 'servicesStarted': False}
    if not args.apply:
        receipt['targets'] = [{'project': slug, 'schema': schema, 'user': user} for slug, (schema, user) in TARGETS.items()]
        print(json.dumps(receipt))
        return 0
    need(args.receipt is not None, 'APPLY_RECEIPT_REQUIRED')
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open('x', encoding='utf-8') as output:
        try:
            enable(args.credential_root.resolve(), template, receipt)
            code = 0
        except Exception as error:
            receipt.update(status='failed-preserve-state', code=public_error(error))
            code = 1
        json.dump(receipt, output, indent=2, ensure_ascii=False)
        print(json.dumps(receipt, ensure_ascii=False))
        return code


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'not-applied', 'code': public_error(error)}))
        sys.exit(1)
