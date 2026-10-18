#!/usr/bin/env python3
"""Offline package executor. The same bytes run in release validation and offline delivery."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid


LABEL = 'com.forge.production.environment'
IDENTIFIER = re.compile(r'^[a-z][a-z0-9-]{2,62}$')


class DeliveryError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise DeliveryError(code, message)


def sha256(file):
    digest = hashlib.sha256()
    with Path(file).open('rb') as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(file, value):
    file = Path(file)
    temporary = file.with_name(file.name + '.tmp-' + uuid.uuid4().hex)
    with temporary.open('x', encoding='utf-8') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write('\n')
    os.chmod(temporary, 0o600)
    temporary.replace(file)


def relative_file(root, name):
    if not isinstance(name, str) or not name or '\\' in name:
        fail('UNSAFE_PATH', 'Package paths must be relative POSIX paths.')
    path = Path(name)
    if path.is_absolute() or '..' in path.parts:
        fail('UNSAFE_PATH', 'Package path escapes its root.')
    result = Path(root).joinpath(path)
    if not result.resolve().is_relative_to(Path(root).resolve()) or any(p.is_symlink() for p in [result, *result.parents] if p != p.parent):
        fail('UNSAFE_PATH', 'Symlink or escaped package path is forbidden.')
    return result


def extract_archive(archive, target):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, 'r:*') as source:
        for member in source.getmembers():
            relative_file(target, member.name)
            if not (member.isfile() or member.isdir()):
                fail('UNSAFE_ARCHIVE', 'Links and special archive entries are forbidden.')
        for member in source.getmembers():
            destination = relative_file(target, member.name)
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source.extractfile(member) as src, destination.open('xb') as dst:
                    while block := src.read(1024 * 1024):
                        dst.write(block)
                os.chmod(destination, member.mode & 0o777)


class Executor:
    def __init__(self, package, runtime, environment_id, bind_host, port, command=None, profile='external', config=None, target_id=None):
        self.package, self.runtime = Path(package).resolve(), Path(runtime).resolve()
        self.environment_id = environment_id
        if not IDENTIFIER.fullmatch(environment_id):
            fail('INVALID_ENVIRONMENT', 'Environment identity is invalid.')
        if not re.fullmatch(r'[A-Za-z0-9.-]+', bind_host) or not 1024 <= int(port) <= 65535:
            fail('INVALID_ENDPOINT', 'A concrete bind host and unprivileged port are required.')
        self.bind_host, self.port = bind_host, int(port)
        self.command = command or self._command
        self.manifest = json.loads((self.package / 'manifest.json').read_text(encoding='utf-8'))
        self.manifest_hash = sha256(self.package / 'manifest.json')
        for item in self.manifest['files']:
            file = relative_file(self.package, item['path'])
            if not file.is_file() or sha256(file) != item['sha256']:
                fail('PACKAGE_DIGEST_MISMATCH', 'A frozen package file is missing or changed.')
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.runtime, 0o700)
        self.state_file = self.runtime / 'state.json'
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else None
        if self.state and self.state.get('environmentId') != environment_id:
            fail('ENVIRONMENT_IDENTITY_MISMATCH', 'Existing runtime belongs to another environment.')
        if profile not in ('external', 'isolated') or self.state and self.state.get('profile') != profile:
            fail('PROFILE_MISMATCH', 'Deployment profile differs from the existing environment.')
        self.profile, self.config = profile, Path(config).resolve() if config else None
        if target_id is not None and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', target_id):
            fail('INVALID_TARGET_IDENTITY', 'The production target identity is invalid.')
        self.target_id = target_id
        self.attempt = {'id': uuid.uuid4().hex, 'action': None, 'status': 'running', 'stages': [],
                        'databaseStatus': 'not-run', 'applicationStatus': 'not-run', 'manifestSha256': self.manifest_hash}
        self.secret_values = []

    @staticmethod
    def _command(args, *, input=None, output=None, check=True):
        result = subprocess.run(args, input=input, stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800)
        if check and result.returncode:
            # Docker stderr may contain configuration values; keep it out of public receipts.
            error = DeliveryError('COMMAND_FAILED', 'A Docker or database operation failed; inspect the private execution log.')
            error.stderr = result.stderr
            raise error
        return result

    def docker(self, *args, **kwargs):
        try:
            return self.command(['docker', *map(str, args)], **kwargs)
        except DeliveryError as error:
            if getattr(error, 'stderr', None):
                file = self.runtime / ('command-error-' + str(time.time_ns()) + '.log')
                file.write_bytes(error.stderr)
                os.chmod(file, 0o600)
            self.checkpoint('command-failed', command=str(args[0]) if args else 'unknown')
            raise error

    def checkpoint(self, stage, **details):
        self.attempt['stages'].append({'stage': stage, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **details})
        write_json(self.runtime / ('attempt-' + self.attempt['id'] + '.json'), self.attempt)

    def resource(self, kind, suffix=''):
        return self.environment_id + (('-' + suffix) if suffix else '')

    def owned(self, kind, name):
        result = self.docker(kind, 'inspect', name, check=False)
        if result.returncode:
            return False
        value = json.loads(result.stdout)[0]
        labels = value.get('Config', {}).get('Labels') if kind == 'container' else value.get('Labels')
        if not isinstance(labels, dict) or labels.get(LABEL) != self.environment_id:
            fail('RESOURCE_OWNERSHIP_MISMATCH', 'An existing Docker resource belongs to another environment.')
        return True

    def secrets(self):
        if self.profile == 'external':
            file = self.runtime / 'external.env'
            if not file.exists():
                if not self.config or not self.config.is_file():
                    fail('EXTERNAL_CONFIGURATION_REQUIRED', 'Provide the private external database and Redis connection file.')
                with file.open('xb') as target:
                    target.write(self.config.read_bytes())
                os.chmod(file, 0o600)
            result = dict(line.split('=', 1) for line in file.read_text(encoding='utf-8').splitlines() if line and not line.startswith('#'))
            required = ('MYSQL_HOST', 'MYSQL_PORT', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD', 'REDIS_HOST', 'REDIS_PORT', 'REDIS_PASSWORD')
            if any(key not in result for key in required) or any(not result[key] for key in required if key != 'REDIS_PASSWORD'):
                fail('EXTERNAL_CONFIGURATION_REQUIRED', 'External connection fields are missing.')
            for key in ('MYSQL_HOST', 'REDIS_HOST'):
                if not re.fullmatch(r'[A-Za-z0-9.-]+', result[key]):
                    fail('INVALID_EXTERNAL_CONFIGURATION', 'External service host is invalid.')
            for key in ('MYSQL_PORT', 'REDIS_PORT'):
                if not result[key].isdigit() or not 1 <= int(result[key]) <= 65535:
                    fail('INVALID_EXTERNAL_CONFIGURATION', 'External service port is invalid.')
            if not re.fullmatch(r'[A-Za-z0-9_]{1,64}', result['MYSQL_DATABASE']):
                fail('INVALID_EXTERNAL_CONFIGURATION', 'External database name is invalid.')
            self.secret_values = [result['MYSQL_PASSWORD'], result['REDIS_PASSWORD']]
            return result
        file = self.runtime / 'runtime.env'
        if not file.exists():
            value = {'MYSQL_ROOT_PASSWORD': secrets.token_hex(24), 'MYSQL_PASSWORD': secrets.token_hex(24),
                     'REDIS_PASSWORD': secrets.token_hex(24)}
            with file.open('x', encoding='utf-8') as handle:
                handle.write(''.join(f'{key}={text}\n' for key, text in value.items()))
            os.chmod(file, 0o600)
        result = dict(line.split('=', 1) for line in file.read_text().splitlines() if line)
        if any(not re.fullmatch(r'[a-f0-9]{48}', result.get(key, '')) for key in ('MYSQL_ROOT_PASSWORD', 'MYSQL_PASSWORD', 'REDIS_PASSWORD')):
            fail('INVALID_RUNTIME_SECRETS', 'Private runtime secrets are missing or invalid.')
        self.secret_values = list(result.values())
        return result

    def load_images(self):
        self.checkpoint('load-frozen-images')
        self.docker('image', 'load', '--input', self.package / 'images.tar')
        for item in self.manifest['images']:
            value = json.loads(self.docker('image', 'inspect', item['id']).stdout)[0]
            if value['Id'] != item['id'] or value.get('Architecture') != self.manifest['architecture'] or value.get('Os') != 'linux':
                fail('IMAGE_IDENTITY_MISMATCH', 'Loaded image identity or architecture differs from the frozen manifest.')

    def image(self, name):
        matches = [item['id'] for item in self.manifest['images'] if item['service'] == name]
        if len(matches) != 1:
            fail('IMAGE_MISSING', 'A required fixed service image is missing.')
        return matches[0]

    def create_infrastructure(self, baseline=None):
        if self.state:
            fail('ENVIRONMENT_ALREADY_EXISTS', 'Initial installation and historical restore require a new environment.')
        resources = [('network', [self.environment_id])]
        if self.profile == 'isolated':
            resources[0][1].append(self.resource('network', 'entry'))
            resources.append(('volume', [self.resource('volume', 'mysql'), self.resource('volume', 'redis')]))
        for kind, names in resources:
            for name in names:
                if self.owned(kind, name):
                    fail('ENVIRONMENT_ALREADY_EXISTS', 'This validation identity has already allocated Docker resources.')
        self.state = {'schemaVersion': 1, 'environmentId': self.environment_id, 'applicationContainers': [],
                      'profile': self.profile, 'port': self.port, 'bindHost': self.bind_host, 'databaseManifestSha256': None,
                      'applicationManifestSha256': None, 'databaseStatus': 'not-run', 'applicationStatus': 'not-run'}
        write_json(self.state_file, self.state)
        label = f'{LABEL}={self.environment_id}'
        self.docker('network', 'create', *(['--internal'] if self.profile == 'isolated' else []), '--label', label, self.environment_id)
        if self.profile == 'isolated':
            self.docker('network', 'create', '--label', label, self.resource('network', 'entry'))
        (self.runtime / 'files').mkdir(mode=0o700)
        (self.runtime / 'secrets').mkdir(mode=0o700)
        secret = self.secrets()
        if self.profile == 'external':
            if baseline:
                fail('EXTERNAL_RESTORE_FORBIDDEN', 'Historical snapshot restore is restricted to isolated validation environments.')
            # Production databases and accounts must already exist; this executor never provisions them.
            result = self.docker(*self.mysql_client(), '--batch', '--skip-column-names', '-e',
                                 'SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE()')
            if result.stdout.strip() != b'0':
                fail('INITIAL_DATABASE_NOT_EMPTY', 'Initial installation requires the explicitly configured empty database.')
            return
        for suffix in ('mysql', 'redis'):
            self.docker('volume', 'create', '--label', label, self.resource('volume', suffix))
        db = self.manifest['recipe']['mysql'].get('database', 'application')
        mysql = self.resource('container', 'mysql')
        self.docker('run', '-d', '--name', mysql, '--label', label, '--network', self.environment_id,
                    '--network-alias', 'mysql', '--mount', f'type=volume,source={mysql},target=/var/lib/mysql',
                    '--env-file', self.runtime / 'runtime.env', '--env', f'MYSQL_DATABASE={db}', '--env', 'MYSQL_USER=application', self.image('_mysql'))
        redis = self.resource('container', 'redis')
        self.docker('create', '--name', redis, '--label', label, '--network', self.environment_id,
                    '--network-alias', 'redis', '--mount', f'type=volume,source={redis},target=/data',
                    self.image('_redis'), 'redis-server', '--requirepass', secret['REDIS_PASSWORD'], '--appendonly', 'no')
        if baseline:
            baseline = Path(baseline)
            self.docker('cp', baseline / 'redis.rdb', f'{redis}:/data/dump.rdb')
            extract_archive(baseline / 'files.tar', self.runtime / 'files')
            extract_archive(baseline / 'secrets.tar', self.runtime / 'secrets')
        self.docker('start', redis)
        ready = False
        for _ in range(120):
            check = self.docker('exec', '--env', f'MYSQL_PWD={secret["MYSQL_ROOT_PASSWORD"]}', mysql,
                                'mysql', '-uroot', '--batch', '--skip-column-names', '-e', 'SELECT 1', check=False)
            if check.returncode == 0:
                ready = True
                break
            time.sleep(1)
        if not ready:
            fail('DATABASE_STARTUP_FAILED', 'The isolated database did not become ready.')
        if baseline:
            self.execute_sql(baseline / 'database.sql', 'restore-historical-database')
            self.state['databaseManifestSha256'] = self.manifest_hash
            self.state['databaseStatus'] = 'success'
            write_json(self.state_file, self.state)

    def mysql_client(self):
        secret = self.secrets()
        if self.profile == 'external':
            return ['run', '--rm', '-i', '--network', self.environment_id, '--env', f'MYSQL_PWD={secret["MYSQL_PASSWORD"]}',
                    '--entrypoint', 'mysql', self.image('_mysql'), '--protocol=TCP', '--host', secret['MYSQL_HOST'],
                    '--port', secret['MYSQL_PORT'], '--user', secret['MYSQL_USER'], '--default-character-set=utf8mb4', '--binary-mode=1', secret['MYSQL_DATABASE']]
        return ['exec', '-i', '--env', f'MYSQL_PWD={secret["MYSQL_ROOT_PASSWORD"]}', self.resource('container', 'mysql'),
                'mysql', '-uroot', '--default-character-set=utf8mb4', '--binary-mode=1', self.manifest['recipe']['mysql'].get('database', 'application')]

    def execute_sql(self, file, stage):
        self.checkpoint(stage, file=Path(file).name)
        # Stream via stdin: SQL is never interpolated into a shell command.
        with Path(file).open('rb') as source:
            result = subprocess.run(['docker', *self.mysql_client()],
                                    stdin=source, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=1800) if self.command == self._command else self.docker(
                                        *self.mysql_client(), input=source.read(), check=False)
        if result.returncode:
            self.attempt['databaseStatus'] = 'partial'
            private_log = self.runtime / ('sql-error-' + self.attempt['id'] + '.log')
            private_log.write_bytes(result.stderr or b'')
            os.chmod(private_log, 0o600)
            fail('SQL_EXECUTION_PARTIAL', 'SQL execution failed and may have partially changed the database. A fresh verified baseline is required.')

    def stop_applications(self, remove=False):
        for name in (self.state or {}).get('applicationContainers', []):
            if self.owned('container', name):
                self.docker('container', 'stop', '--time', '30', name)
                if remove:
                    self.docker('container', 'rm', name)

    def start_applications(self):
        recipe = self.manifest['recipe']
        secret = self.secrets()
        variables = {**secret, 'MYSQL_HOST': 'mysql', 'MYSQL_PORT': '3306', 'MYSQL_DATABASE': recipe['mysql'].get('database', 'application'),
                     'MYSQL_USER': 'application', 'REDIS_HOST': 'redis', 'REDIS_PORT': '6379'}
        if self.profile == 'external':
            variables.update(secret)
        self.state['applicationContainers'] = []
        write_json(self.state_file, self.state)
        for service in recipe['application']['services']:
            name = self.resource('container', service['name'])
            if self.owned('container', name):
                fail('ENVIRONMENT_ALREADY_EXISTS', 'An application container already exists for this identity.')
            args = ['run', '-d', '--name', name, '--label', f'{LABEL}={self.environment_id}', '--network', self.environment_id,
                    '--network-alias', service['name']]
            for alias in service.get('aliases', []):
                args += ['--network-alias', alias]
            if self.profile == 'external' and service['name'] == recipe['application']['entry']['service']:
                args += ['--publish', f'{self.bind_host}:{self.port}:{recipe["application"]["entry"]["containerPort"]}']
            values = {}
            for key, value in service.get('environment', {}).items():
                placeholders = re.findall(r'\$\{([^}]+)\}', value)
                if any(variable not in variables for variable in placeholders):
                    fail('UNRESOLVED_CONFIGURATION', 'An application environment placeholder is unresolved.')
                values[key] = re.sub(r'\$\{([^}]+)\}', lambda match: variables[match.group(1)], value)
            env_file = self.runtime / (service['name'] + '.env')
            env_file.write_text(''.join(f'{k}={v}\n' for k, v in values.items()), encoding='utf-8')
            os.chmod(env_file, 0o600)
            args += ['--env-file', str(env_file)]
            for mount in service.get('mounts', []):
                if mount['resource'] in ('files', 'secrets'):
                    source = self.runtime / mount['resource']
                else:
                    source = relative_file(self.package, 'resources/' + mount['resource'])
                option = f'type=bind,source={source},target={mount["path"]}'
                if mount.get('readOnly', mount['resource'] not in ('files', 'secrets')):
                    option += ',readonly'
                args += ['--mount', option]
            if service.get('entrypoint'):
                args += ['--entrypoint', service['entrypoint'][0]]
            args += [self.image(service['imageService'])]
            args += service.get('entrypoint', [])[1:] + service.get('command', [])
            # Save ownership before starting, so partial starts remain stoppable.
            self.state['applicationContainers'].append(name)
            write_json(self.state_file, self.state)
            self.docker(*args)

    def start_entry_proxy(self):
        if self.profile != 'isolated':
            return
        name = self.resource('container', 'entry')
        if self.owned('container', name):
            self.docker('container', 'stop', '--time', '10', name)
            self.docker('container', 'rm', name)
        self.state['entryProxyContainer'] = name
        write_json(self.state_file, self.state)
        self.docker('create', '--name', name, '--label', f'{LABEL}={self.environment_id}',
                    '--network', self.resource('network', 'entry'), '--publish', f'{self.bind_host}:{self.port}:8080',
                    '--mount', f'type=bind,source={self.package / "validation-proxy.conf"},target=/etc/nginx/nginx.conf,readonly',
                    '--entrypoint', 'nginx', self.image('_validation-proxy'), '-g', 'daemon off;')
        self.docker('network', 'connect', self.environment_id, name)
        self.docker('start', name)

    def health(self):
        health = self.manifest['recipe']['application']['health']
        host = '127.0.0.1' if self.bind_host == '0.0.0.0' else self.bind_host
        url = f'http://{host}:{self.port}{health["path"]}'
        deadline = time.monotonic() + int(health.get('timeoutSeconds', 180))
        while time.monotonic() < deadline:
            try:
                with urllib.request.urlopen(url, timeout=5) as response:
                    if response.status == int(health.get('expectedStatus', 200)):
                        self.checkpoint('application-http-health', status=response.status)
                        return
            except (OSError, ValueError):
                pass
            time.sleep(2)
        fail('APPLICATION_HEALTH_FAILED', 'The deployed application did not pass its configured HTTP health check.')

    def deploy(self, action, baseline=None):
        self.attempt['action'] = action
        try:
            self.load_images()
            if action in ('initial', 'restore'):
                self.create_infrastructure(baseline if action == 'restore' else None)
            elif action == 'upgrade':
                expected = self.manifest.get('baseManifestSha256')
                if not self.state or not expected or any(self.state.get(k) != expected for k in ('databaseManifestSha256', 'applicationManifestSha256')) or self.state.get('databaseStatus') not in ('success', 'not-required') or self.state.get('applicationStatus') != 'success':
                    fail('BASELINE_MISMATCH', 'Database and application must both match the selected successful historical package.')
                self.stop_applications(remove=True)
            elif action == 'resume-app':
                if not self.state or self.state.get('databaseManifestSha256') != self.manifest_hash or self.state.get('databaseStatus') not in ('success', 'not-required') or self.state.get('applicationStatus') != 'failed':
                    fail('APPLICATION_RESUME_STATE_INVALID', 'Application resume requires this exact package, a successfully applied database and a recorded application failure.')
                self.stop_applications(remove=True)
            else:
                fail('INVALID_ACTION', 'Unsupported deployment action.')
            if action not in ('restore', 'resume-app'):
                self.attempt['databaseStatus'] = 'not-required' if not self.manifest['database']['execute'] else 'running'
                self.state['databaseStatus'] = self.attempt['databaseStatus']
                write_json(self.state_file, self.state)
                for file in self.manifest['database']['execute']:
                    self.execute_sql(relative_file(self.package, file), 'execute-package-sql')
                if self.manifest['database']['execute']:
                    self.attempt['databaseStatus'] = 'success'
                self.state['databaseManifestSha256'] = self.manifest_hash
                self.state['databaseStatus'] = self.attempt['databaseStatus']
                write_json(self.state_file, self.state)
            else:
                self.attempt['databaseStatus'] = self.state.get('databaseStatus', 'success')
            self.attempt['applicationStatus'] = 'running'
            self.state['applicationStatus'] = 'running'
            write_json(self.state_file, self.state)
            self.start_applications()
            self.start_entry_proxy()
            self.health()
            self.state['applicationManifestSha256'] = self.manifest_hash
            self.state['applicationStatus'] = 'success'
            write_json(self.state_file, self.state)
            self.attempt.update(status='success', applicationStatus='success')
            self.checkpoint('complete')
            self.record_deployment_result()
            return self.attempt
        except Exception as error:
            self.attempt['status'] = 'failed'
            if self.attempt['applicationStatus'] == 'running':
                self.attempt['applicationStatus'] = 'failed'
            if self.state:
                if self.attempt['databaseStatus'] in ('running', 'partial'):
                    self.state['databaseStatus'] = 'partial'
                    self.attempt['databaseStatus'] = 'partial'
                if self.attempt['applicationStatus'] == 'failed':
                    self.state['applicationStatus'] = 'failed'
                write_json(self.state_file, self.state)
            self.attempt['error'] = {'code': getattr(error, 'code', 'EXECUTION_FAILED'), 'message': str(error) if isinstance(error, DeliveryError) else 'Execution failed; inspect private runtime evidence.'}
            self.checkpoint('failed')
            self.record_deployment_result()
            raise

    def record_deployment_result(self):
        if self.profile != 'external' or not self.target_id:
            return
        database = self.attempt['databaseStatus']
        if database in ('not-run', 'running'):
            database = 'failed' if database == 'not-run' else 'partial'
        application = self.attempt['applicationStatus']
        if application == 'running':
            application = 'failed'
        notes = 'Offline executor ' + self.attempt['action'] + '; attempt ' + self.attempt['id']
        if self.attempt['databaseStatus'] == 'not-run':
            notes += '; database stage was not executed because deployment prerequisites failed'
        if self.attempt.get('error'):
            notes += '; error ' + self.attempt['error']['code']
        result = {'project': self.manifest['project'], 'targetId': self.target_id, 'releaseId': self.manifest['releaseId'],
                  'jobId': self.manifest['jobId'], 'manifestSha256': self.manifest_hash,
                  'occurredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'databaseStatus': database,
                  'applicationStatus': application, 'notes': notes}
        write_json(self.runtime / ('deployment-result-' + self.attempt['id'] + '.json'), result)

    def snapshot(self, output):
        if self.profile != 'isolated':
            fail('EXTERNAL_SNAPSHOT_FORBIDDEN', 'This command snapshots only the isolated validation environment.')
        output = Path(output)
        if output.exists():
            fail('BASELINE_EXISTS', 'Historical baseline files are immutable and cannot be overwritten.')
        if not self.state or any(self.state.get(k) != self.manifest_hash for k in ('databaseManifestSha256', 'applicationManifestSha256')) or self.state.get('databaseStatus') not in ('success', 'not-required') or self.state.get('applicationStatus') != 'success':
            fail('BASELINE_NOT_HEALTHY', 'Only a fully successful package can produce a historical baseline.')
        output.mkdir(parents=True, mode=0o700)
        self.stop_applications()
        try:
            secret = self.secrets()
            db = self.manifest['recipe']['mysql'].get('database', 'application')
            with (output / 'database.sql').open('xb') as handle:
                self.docker('exec', '--env', f'MYSQL_PWD={secret["MYSQL_ROOT_PASSWORD"]}', self.resource('container', 'mysql'),
                            'mysqldump', '-uroot', '--default-character-set=utf8mb4', '--single-transaction', '--quick', '--routines', '--events', '--triggers',
                            '--hex-blob', '--set-gtid-purged=OFF', '--no-tablespaces', db, output=handle)
            self.docker('exec', '--env', f'REDISCLI_AUTH={secret["REDIS_PASSWORD"]}', self.resource('container', 'redis'), 'redis-cli', 'SAVE')
            self.docker('cp', self.resource('container', 'redis') + ':/data/dump.rdb', output / 'redis.rdb')
            for directory in ('files', 'secrets'):
                with tarfile.open(output / (directory + '.tar'), 'x') as archive:
                    for item in sorted((self.runtime / directory).rglob('*')):
                        if item.is_symlink() or not (item.is_file() or item.is_dir()):
                            fail('UNSAFE_RUNTIME_FILE', 'Runtime files contain an unsupported link or special file.')
                        archive.add(item, arcname=item.relative_to(self.runtime / directory).as_posix(), recursive=False)
            for file in output.iterdir():
                os.chmod(file, 0o600)
        finally:
            for name in self.state.get('applicationContainers', []):
                if self.owned('container', name):
                    self.docker('start', name)
        self.health()

    def stop(self):
        if not self.state:
            fail('ENVIRONMENT_MISSING', 'There is no recorded environment to stop.')
        self.stop_applications()
        proxy = self.state.get('entryProxyContainer')
        if proxy and self.owned('container', proxy):
            self.docker('container', 'stop', '--time', '10', proxy)
        for suffix in (('mysql', 'redis') if self.profile == 'isolated' else ()):
            name = self.resource('container', suffix)
            if self.owned('container', name):
                self.docker('stop', '--time', '30', name)
        self.state['status'] = 'stopped'
        write_json(self.state_file, self.state)
        # Volumes, files, package archives, and historical baselines are deliberately retained.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--package', default=str(Path(__file__).resolve().parent))
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--environment-id', required=True)
    parser.add_argument('--bind-host', default='127.0.0.1')
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--action', choices=['initial', 'upgrade', 'resume-app', 'restore', 'snapshot', 'stop', 'health'], required=True)
    parser.add_argument('--baseline')
    parser.add_argument('--profile', choices=['external', 'isolated'], default='external')
    parser.add_argument('--config', help='Private connection env file for an existing production database and Redis.')
    parser.add_argument('--target-id', help='Registered production target id; emits a sanitized deployment result for manual import.')
    args = parser.parse_args()
    try:
        executor = Executor(args.package, args.runtime, args.environment_id, args.bind_host, args.port, profile=args.profile, config=args.config, target_id=args.target_id)
        if args.action in ('initial', 'upgrade', 'resume-app', 'restore'):
            if args.action == 'restore' and not args.baseline:
                fail('BASELINE_REQUIRED', 'Historical restore requires a private frozen baseline.')
            executor.deploy(args.action, args.baseline)
        elif args.action == 'snapshot':
            if not args.baseline:
                fail('BASELINE_REQUIRED', 'Snapshot output is required.')
            executor.snapshot(args.baseline)
        elif args.action == 'stop':
            executor.stop()
        else:
            executor.health()
        return 0
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': {'code': getattr(error, 'code', 'EXECUTION_FAILED'),
              'message': str(error) if isinstance(error, DeliveryError) else 'Execution failed; inspect private runtime evidence.'}}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
