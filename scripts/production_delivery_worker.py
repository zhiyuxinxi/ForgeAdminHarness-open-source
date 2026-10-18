#!/usr/bin/env python3
"""Protected production delivery worker; input paths and recipes come only from the service."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import uuid

from production_delivery_deploy import LABEL, DeliveryError, extract_archive, fail, relative_file, sha256, write_json


NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$')
IMAGE = re.compile(r'^(?:sha256:[a-f0-9]{64}|[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64})$')


def absolute_path(value, label):
    if not isinstance(value, str) or not Path(value).is_absolute():
        fail('INVALID_PATH', label + ' must be absolute.')
    path = Path(value)
    if any(part.is_symlink() for part in [path, *path.parents] if part != part.parent):
        fail('UNSAFE_PATH', label + ' must not contain symlinks.')
    return path.resolve()


def run(args, output=None):
    result = subprocess.run(list(map(str, args)), stdout=output or subprocess.PIPE, stderr=subprocess.PIPE, timeout=3600)
    if result.returncode:
        error = DeliveryError('COMMAND_FAILED', 'A required fixed-source or Docker operation failed.')
        error.stderr = result.stderr
        raise error
    return result.stdout


def validate_recipe(value):
    if not isinstance(value, dict) or value.get('schemaVersion') != 1:
        fail('RECIPE_REQUIRED', 'A reviewed production recipe is required.')
    recipe = copy.deepcopy(value)
    for key in ('mysql', 'redis'):
        if not isinstance(recipe.get(key), dict) or not IMAGE.fullmatch(str(recipe[key].get('image', ''))):
            fail('UNPINNED_INFRASTRUCTURE_IMAGE', 'Database and Redis images must be fixed by SHA256.')
    if not IMAGE.fullmatch(str(recipe.get('validationProxyImage', ''))):
        fail('VALIDATION_PROXY_IMAGE_REQUIRED', 'The isolated validation entry proxy image must be fixed by SHA256.')
    if not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', recipe['mysql'].get('database', 'application')):
        fail('INVALID_DATABASE', 'The isolated database name is invalid.')
    database = recipe.get('database', {})
    if not isinstance(database.get('initialSql'), list) or not database['initialSql']:
        fail('INITIALIZATION_MATERIAL_MISSING', 'Reviewed empty-database initialization SQL is required.')
    if not isinstance(database.get('migrations'), list):
        fail('MIGRATION_MATERIAL_MISSING', 'An ordered versioned migration inventory is required; it may be empty.')
    ids = []
    for migration in database['migrations']:
        if not isinstance(migration, dict) or not NAME.fullmatch(str(migration.get('id', ''))) or not isinstance(migration.get('path'), str):
            fail('INVALID_MIGRATION_INVENTORY', 'Migration ids and repository-relative paths are required.')
        ids.append(migration['id'])
    if len(ids) != len(set(ids)):
        fail('INVALID_MIGRATION_INVENTORY', 'Migration ids must be unique and ordered.')
    materials = recipe.get('materials', {})
    if not isinstance(materials.get('operationGuide'), str) or not materials['operationGuide']:
        fail('OPERATION_GUIDE_MISSING', 'The actual project operation guide must exist at the selected commit.')
    resources = materials.get('resources', [])
    if not isinstance(resources, list) or any(not isinstance(r, dict) or not NAME.fullmatch(str(r.get('name', ''))) or not isinstance(r.get('path'), str) for r in resources):
        fail('INVALID_RESOURCE', 'Resource names and fixed-source paths are required.')
    if len({r['name'] for r in resources}) != len(resources) or any(r['name'] in ('files', 'secrets') for r in resources):
        fail('INVALID_RESOURCE', 'Resource names must be unique and must not use reserved runtime identities.')
    application = recipe.get('application', {})
    services = application.get('services')
    if not isinstance(services, list) or not services:
        fail('APPLICATION_RECIPE_MISSING', 'Application services and their deployment configuration are required.')
    names = set()
    resource_names = {r['name'] for r in resources} | {'files', 'secrets'}
    for service in services:
        if not isinstance(service, dict) or not re.fullmatch(r'[a-z][a-z0-9-]{0,30}', str(service.get('name', ''))) or service['name'] in names | {'mysql', 'redis'}:
            fail('INVALID_APPLICATION_SERVICE', 'Application service names must be unique and separate from infrastructure.')
        names.add(service['name'])
        if not NAME.fullmatch(str(service.get('imageService', ''))):
            fail('INVALID_APPLICATION_SERVICE', 'An immutable candidate image service is required.')
        for key, text in service.get('environment', {}).items():
            if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or not isinstance(text, str) or any(c in text for c in '\r\n\0'):
                fail('INVALID_APPLICATION_CONFIGURATION', 'Environment values must be single-line literal values or supported placeholders.')
            if re.search(r'PASSWORD|SECRET|TOKEN|API_KEY', key, re.I) and text and not re.fullmatch(r'\$\{[A-Z_]+\}', text):
                fail('SECRET_IN_RECIPE', 'Literal application secrets must not enter distributable production materials.')
        for field in ('command', 'entrypoint', 'aliases'):
            if field in service and (not isinstance(service[field], list) or any(not isinstance(item, str) or '\0' in item for item in service[field])):
                fail('INVALID_APPLICATION_CONFIGURATION', 'Application arguments and aliases must be literal string arrays.')
        if any(not re.fullmatch(r'[a-z][a-z0-9-]{0,62}', alias) or alias in {'mysql', 'redis'} for alias in service.get('aliases', [])):
            fail('INVALID_APPLICATION_CONFIGURATION', 'Service network aliases are invalid.')
        for mount in service.get('mounts', []):
            if mount.get('resource') not in resource_names or not str(mount.get('path', '')).startswith('/') or '..' in Path(mount['path']).parts or ',' in mount['path']:
                fail('INVALID_APPLICATION_MOUNT', 'Application mounts must target a declared package resource or isolated files directory.')
    entry, health = application.get('entry', {}), application.get('health', {})
    if entry.get('service') not in names or not isinstance(entry.get('containerPort'), int) or not 1 <= entry['containerPort'] <= 65535:
        fail('APPLICATION_ENTRY_MISSING', 'A concrete application HTTP entrypoint is required.')
    for section in (entry, health):
        if not isinstance(section.get('path'), str) or not section['path'].startswith('/') or any(c in section['path'] for c in '\r\n'):
            fail('HEALTH_CHECK_MISSING', 'Application entry and health paths must be explicit.')
    if not 1 <= int(health.get('timeoutSeconds', 180)) <= 900:
        fail('INVALID_HEALTH_CHECK', 'Health timeout must be between 1 and 900 seconds.')
    return recipe


def validate_application_sql(file):
    text = Path(file).read_text(encoding='utf-8-sig')
    # Provisioning is performed separately by operations. Do not rewrite business SQL.
    clean = re.sub(r'/\*(?!\!)[\s\S]*?\*/|(?m:^[ \t]*(?:--|#)[^\n]*$)', '', text)
    if re.search(r'(?im)(?:^|;)\s*(?:USE\s+|(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA|USER)\b|GRANT\b|REVOKE\b)', clean):
        fail('DATABASE_PROVISIONING_SQL_FORBIDDEN', 'Application SQL must target the pre-created database; database/user provisioning statements require a corrected reviewed source artifact.')


class Worker:
    def __init__(self, request, command=None):
        self.request, self.command = request, command or run
        if request.get('schemaVersion') != 1 or request.get('action') not in ('validate', 'stop'):
            fail('INVALID_REQUEST', 'A protected version 1 worker request is required.')
        for key in ('jobId', 'project', 'releaseId'):
            if not NAME.fullmatch(str(request.get(key, ''))):
                fail('INVALID_IDENTITY', 'Project, release, and job identities must be explicit.')
        if request['action'] == 'stop':
            request.setdefault('stopAttemptId', uuid.uuid4().hex)
            if not NAME.fullmatch(str(request['stopAttemptId'])):
                fail('INVALID_STOP_ATTEMPT', 'The stop attempt identity is invalid.')
        self.job = absolute_path(request['jobRoot'], 'jobRoot')
        self.archive = absolute_path(request['archiveRoot'], 'archiveRoot')
        self.backup_root = absolute_path(request['backupRoot'], 'backupRoot')
        self.environment_root = absolute_path(request['environmentRoot'], 'environmentRoot')
        if self.job == self.archive or not self.job.is_relative_to(self.archive) or self.job.name != request['jobId']:
            fail('INVALID_ARCHIVE_BOUNDARY', 'Job directory must be a named child of the permanent archive root.')
        roots = [self.archive, self.backup_root, self.environment_root]
        if any(a.is_relative_to(b) or b.is_relative_to(a) for i, a in enumerate(roots) for b in roots[i + 1:]):
            fail('INVALID_STORAGE_BOUNDARY', 'Archive, permanent backup and runtime roots must be disjoint.')
        self.runtime = self.environment_root / request['jobId']
        self.backup = self.backup_root / request['jobId']
        self.environment_id = 'pd-' + hashlib.sha256((request['project'] + ':' + request['jobId']).encode()).hexdigest()[:24]
        self.package = self.job / 'package'
        self.progress = {'status': 'preparing', 'stages': [], 'environment': {'id': self.environment_id, 'status': 'preparing'}}
        self.job.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.base_manifest = None
        self.base_package = None
        self.base_baseline = None

    def stage(self, stage, status=None, **details):
        if status:
            self.progress['status'] = status
        self.progress['stages'].append({'stage': stage, 'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **details})
        write_json(self.job / 'progress.json', self.progress)

    def source_material(self, path, destination, allow_directory=False):
        relative_file(self.job, path)  # lexical/path traversal validation; source bytes still come only from Git.
        tree = self.command(['git', '-C', self.material_workspace, 'ls-tree', '-r', '-z', self.material_commit, '--', path])
        entries = [row for row in tree.split(b'\0') if row]
        if not entries:
            fail('SOURCE_MATERIAL_MISSING', 'A required SQL, resource or operation guide is absent from the selected commit: ' + path)
        for entry in entries:
            metadata, raw_name = entry.split(b'\t', 1)
            mode, kind, _ = metadata.split(b' ', 2)
            name = raw_name.decode('utf-8')
            if kind != b'blob' or mode not in (b'100644', b'100755'):
                fail('UNSAFE_SOURCE_MATERIAL', 'Materials must be regular fixed Git files, not links or submodules.')
            if name == path:
                target = destination
            elif allow_directory and name.startswith(path.rstrip('/') + '/'):
                target = relative_file(destination, name[len(path.rstrip('/')) + 1:])
            else:
                fail('SOURCE_MATERIAL_MISSING', 'The requested material is not a regular source file.')
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open('xb') as handle:
                content = self.command(['git', '-C', self.material_workspace, 'show', self.material_commit + ':' + name])
                if not content and not allow_directory:
                    fail('EMPTY_SOURCE_MATERIAL', 'Required SQL and operation guides cannot be empty.')
                handle.write(content)
            os.chmod(target, 0o755 if mode == b'100755' else 0o644)

    def load_baseline(self):
        if self.request['mode'] == 'initial':
            if self.request.get('base'):
                fail('UNEXPECTED_BASELINE', 'Initial installation cannot select a historical baseline.')
            return
        base = self.request.get('base')
        if not isinstance(base, dict):
            fail('HISTORICAL_BASELINE_REQUIRED', 'Incremental validation requires an accepted historical package and private recovery baseline.')
        root = absolute_path(base['jobRoot'], 'base.jobRoot')
        if root == self.job or not root.is_relative_to(self.archive):
            fail('INVALID_BASELINE_BOUNDARY', 'Historical baseline must belong to another archived job.')
        result = json.loads((root / 'result.json').read_text(encoding='utf-8'))
        manifest_file = root / 'package' / 'manifest.json'
        if result.get('status') != 'success' or sha256(manifest_file) != base.get('manifestSha256') or result.get('manifestSha256') != base.get('manifestSha256'):
            fail('HISTORICAL_BASELINE_INVALID', 'Historical package manifest and successful worker result do not match.')
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        if manifest.get('project') != self.request['project'] or manifest.get('architecture') != self.request['architecture']:
            fail('HISTORICAL_BASELINE_INVALID', 'Historical project and architecture must match this validation path.')
        for artifact in result['artifacts']:
            if artifact['key'] == 'bundle':
                file = relative_file(root, artifact['relativePath'])
                if sha256(file) != artifact['sha256']:
                    fail('HISTORICAL_BASELINE_INVALID', 'Historical offline bundle is missing or changed.')
                break
        else:
            fail('HISTORICAL_BASELINE_INVALID', 'Historical offline bundle is missing.')
        baseline = root / 'private-baseline'
        for item in result.get('baseline', {}).get('files', []):
            file = relative_file(baseline, item['name'])
            if not file.is_file() or sha256(file) != item['sha256']:
                fail('HISTORICAL_BASELINE_INVALID', 'Historical recovery data is missing or changed.')
        if {item['name'] for item in result.get('baseline', {}).get('files', [])} != {'database.sql', 'redis.rdb', 'files.tar', 'secrets.tar'}:
            fail('HISTORICAL_BASELINE_INVALID', 'A complete database, Redis, file and private encryption-material recovery baseline is required.')
        self.base_manifest, self.base_package, self.base_baseline = manifest, root / 'package', baseline

    def build_package(self):
        request = self.request
        if request['mode'] not in ('initial', 'upgrade') or request['architecture'] not in ('amd64', 'arm64'):
            fail('INVALID_VALIDATION_MODE', 'Initial or upgrade mode and a supported target architecture are required.')
        self.recipe = validate_recipe(request.get('recipe'))
        source = request.get('source', {})
        if not re.fullmatch(r'[a-f0-9]{40}', str(source.get('commit', ''))):
            fail('FIXED_SOURCE_REQUIRED', 'A full frozen candidate Git commit is required.')
        project_root = absolute_path(source['projectRoot'], 'source.projectRoot')
        self.workspace = project_root / 'workspace'
        if not (self.workspace / '.git').exists():
            fail('FIXED_SOURCE_REQUIRED', 'The registered project Git workspace is unavailable.')
        self.command(['git', '-C', self.workspace, 'cat-file', '-e', source['commit'] + '^{commit}'])
        materials = source.get('materials') or {'projectRoot': source['projectRoot'], 'commit': source['commit']}
        if not re.fullmatch(r'[a-f0-9]{40}', str(materials.get('commit', ''))):
            fail('FIXED_MATERIAL_SOURCE_REQUIRED', 'Production materials require a full fixed Git commit.')
        self.material_workspace = absolute_path(materials['projectRoot'], 'source.materials.projectRoot') / 'workspace'
        self.material_commit = materials['commit']
        if not (self.material_workspace / '.git').exists():
            fail('FIXED_MATERIAL_SOURCE_REQUIRED', 'The registered material Git workspace is unavailable.')
        self.command(['git', '-C', self.material_workspace, 'cat-file', '-e', self.material_commit + '^{commit}'])
        self.command(['git', '-C', self.material_workspace, 'merge-base', '--is-ancestor', source['commit'], self.material_commit])
        self.load_baseline()
        if self.package.exists() or self.runtime.exists() or (self.job / 'result.json').exists() or self.backup.exists():
            fail('JOB_ALREADY_USED', 'New validation requires a new job; existing archives and environments are immutable.')
        self.package.mkdir(mode=0o700)
        self.stage('freeze-fixed-materials')
        migrations = []
        for i, entry in enumerate(self.recipe['database']['migrations']):
            name = f'sql/migrations/{i:04d}-{entry["id"]}.sql'
            self.source_material(entry['path'], self.package / name)
            validate_application_sql(self.package / name)
            migrations.append({'id': entry['id'], 'path': name, 'sha256': sha256(self.package / name)})
        if self.base_manifest:
            previous = self.base_manifest['database']['migrations']
            if len(previous) > len(migrations) or any(old['id'] != new['id'] or old['sha256'] != new['sha256'] for old, new in zip(previous, migrations)):
                fail('MIGRATION_HISTORY_CHANGED', 'Historical migrations must remain an unchanged prefix of the target inventory.')
            execute = [entry['path'] for entry in migrations[len(previous):]]
        else:
            execute = []
            for i, path in enumerate(self.recipe['database']['initialSql']):
                name = f'sql/initial/{i:04d}.sql'
                self.source_material(path, self.package / name)
                validate_application_sql(self.package / name)
                execute.append(name)
        operation_extension = Path(self.recipe['materials']['operationGuide']).suffix.lower() or '.md'
        operation_path = 'OPERATION' + operation_extension
        self.source_material(self.recipe['materials']['operationGuide'], self.package / operation_path)
        for resource in self.recipe['materials'].get('resources', []):
            self.source_material(resource['path'], self.package / 'resources' / resource['name'], allow_directory=True)
        (self.package / 'sql').mkdir(exist_ok=True)
        with (self.package / 'sql' / 'execute.sql').open('xb') as handle:
            for file in execute:
                handle.write(('-- Source: ' + file + '\n').encode())
                handle.write((self.package / file).read_bytes())
                handle.write(b'\n')
            if not execute:
                handle.write(b'-- This release has no additional database migrations.\n')
        shutil.copyfile(Path(__file__).with_name('production_delivery_deploy.py'), self.package / 'deploy.py')
        (self.package / 'env.example').write_text(
            '# Copy outside the package to a private file (chmod 600); existing database/accounts are provisioned by operations.\n'
            'MYSQL_HOST=\nMYSQL_PORT=3306\nMYSQL_DATABASE=\nMYSQL_USER=\nMYSQL_PASSWORD=\n'
            'REDIS_HOST=\nREDIS_PORT=6379\nREDIS_PASSWORD=\n', encoding='utf-8')
        guide = (
            '# 离线部署与升级\n\n本包材料固定，任何修改均需要重新生成并验证。请先阅读本包实际项目操作手册。\n\n'
            '1. 运维准备与验证环境一致版本的 MySQL、Redis，以及目标架构 Linux、Docker 和 Python 3.10+；先备份数据库及业务文件。\n'
            '2. 运维自行建立数据库与受限账号，将 env.example 复制到包外私有文件并填写连接信息（权限 0600）；首次安装要求空库。\n'
            '3. 解开归档后运行以下命令；runtime 必须保留，后续升级使用同一 runtime 和 environment-id：\n\n'
            '```sh\npython3 deploy.py --action ' + request['mode'] + ' --profile external --config /secure/production.env '
            '--runtime /srv/application-runtime --environment-id production-app --bind-host 0.0.0.0 --port 8080\n```\n\n'
            '升级必须从本包指定历史版本开始。部署执行器只连接已准备的外置 MySQL/Redis，不创建生产数据库或替换生产 Redis。'
            '可独立审阅 sql/execute.sql，但使用自动执行器时不要提前手工重复执行 SQL。\n\n'
            'SQL 与应用状态分别写入 runtime/attempt-*.json。SQL 失败可能部分生效，禁止直接重跑；保留日志并核对实际库状态形成修复方案。'
            'SQL 成功而应用失败时数据库已升级，不得将旧镜像回退当作数据库回退。修复运行条件后，可对同一包、同一 runtime 使用 --action resume-app 仅重启应用；该动作不重跑 SQL，旧失败记录保留。完成真实上线后，把实际数据库、应用结果登记回交付中心。\n\n'
            '若指定交付中心已登记的 --target-id，执行器会在 runtime 写出不含连接密码的 deployment-result-*.json，成功或失败均可回传。未提供 target-id 时，执行器不会猜测客户身份，请在交付中心人工表单登记实际结果。\n\n'
            '验证范围：所选架构、隔离数据库与 Redis、冻结 SQL、实际镜像启动和 HTTP 健康检查；业务正确性需研发经理/实施运维人工验收。'
            '客户网络、外置数据库账号权限及生产配置需要上线前核对。正式包下载与验证通过都不代表生产已上线。\n')
        (self.package / 'DEPLOYMENT.md').write_text(guide, encoding='utf-8')
        entry = self.recipe['application']['entry']
        proxy = ('events {}\nhttp { server { listen 8080; location / { proxy_pass http://' + entry['service'] + ':' + str(entry['containerPort']) + '; '
                 'proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; '
                 'proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_read_timeout 120s; } } }\n')
        (self.package / 'validation-proxy.conf').write_text(proxy, encoding='utf-8')
        images = list(source.get('images', [])) + [{'service': '_mysql', 'id': self.recipe['mysql']['image']}, {'service': '_redis', 'id': self.recipe['redis']['image']},
                                                 {'service': '_validation-proxy', 'id': self.recipe['validationProxyImage']}]
        if len({image.get('service') for image in images}) != len(images):
            fail('IMAGE_INVENTORY_INVALID', 'Candidate service images must be unique.')
        required = {service['imageService'] for service in self.recipe['application']['services']} | {'_mysql', '_redis', '_validation-proxy'}
        fixed = []
        for item in images:
            if item.get('service') not in required:
                continue
            if not IMAGE.fullmatch(str(item.get('id', ''))):
                fail('IMMUTABLE_IMAGE_REQUIRED', 'All application images must be fixed by SHA256.')
            value = json.loads(self.command(['docker', 'image', 'inspect', item['id']]))[0]
            if value.get('Architecture') != request['architecture'] or value.get('Os') != 'linux':
                fail('TARGET_ARCHITECTURE_UNAVAILABLE', 'A fixed image is unavailable for the requested architecture; no substitute or emulation result was manufactured.')
            fixed.append({'service': item['service'], 'id': value['Id'], 'architecture': value['Architecture']})
        if {image['service'] for image in fixed} != required:
            fail('CANDIDATE_IMAGE_MISSING', 'The selected successful version lacks an image for a required application service.')
        if self.base_manifest:
            previous_images = {image['service']: image['id'] for image in self.base_manifest['images']}
            if any(image['id'] != previous_images.get(image['service']) for image in fixed if image['service'] in ('_mysql', '_redis')) or self.base_manifest['recipe']['mysql'].get('database', 'application') != self.recipe['mysql'].get('database', 'application'):
                fail('INFRASTRUCTURE_UPGRADE_UNSUPPORTED', 'This application upgrade path cannot silently change database/Redis engine images or the database identity.')
        self.stage('archive-exact-images')
        reusable = request.get('reuseImageArchive')
        if reusable:
            previous = absolute_path(reusable['jobRoot'], 'reuseImageArchive.jobRoot')
            if not previous.is_relative_to(self.archive) or previous == self.job:
                fail('INVALID_ARCHIVE_REUSE', 'Image reuse must refer to another permanent job under the configured archive root.')
            previous_manifest = previous / 'package' / 'manifest.json'
            if sha256(previous_manifest) != reusable.get('manifestSha256'):
                fail('INVALID_ARCHIVE_REUSE', 'The retained image archive manifest does not match its fixed identity.')
            old = json.loads(previous_manifest.read_text(encoding='utf-8'))
            entries = [item for item in old['files'] if item['path'] == 'images.tar']
            if old.get('project') != request['project'] or old.get('architecture') != request['architecture'] or len(entries) != 1 or {image['id'] for image in old['images']} != {image['id'] for image in fixed} or sha256(previous / 'package' / 'images.tar') != entries[0]['sha256']:
                fail('INVALID_ARCHIVE_REUSE', 'Retained image bytes do not match this project, architecture and exact image set.')
            try:
                os.link(previous / 'package' / 'images.tar', self.package / 'images.tar')
            except OSError:
                shutil.copyfile(previous / 'package' / 'images.tar', self.package / 'images.tar')
            self.stage('retained-image-archive-reused', sourceManifestSha256=reusable['manifestSha256'])
        else:
            with (self.package / 'images.tar').open('xb') as handle:
                self.command(['docker', 'image', 'save', *dict.fromkeys(item['id'] for item in fixed)], output=handle)
        manifest = {'schemaVersion': 1, 'project': request['project'], 'releaseId': request['releaseId'], 'jobId': request['jobId'],
                    'commit': source['commit'], 'applicationCommit': source['commit'], 'materialCommit': self.material_commit,
                    'mode': request['mode'], 'architecture': request['architecture'],
                    'baseManifestSha256': (request.get('base') or {}).get('manifestSha256'), 'images': fixed,
                    'database': {'migrations': migrations, 'execute': execute}, 'recipe': self.recipe,
                    'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'retention': 'permanent', 'files': []}
        manifest['files'] = [{'path': path.relative_to(self.package).as_posix(), 'sha256': sha256(path), 'size': path.stat().st_size}
                             for path in sorted(self.package.rglob('*')) if path.is_file()]
        write_json(self.package / 'manifest.json', manifest)
        self.manifest = manifest
        self.progress['manifestSha256'] = sha256(self.package / 'manifest.json')
        self.stage('package-frozen')
        with tarfile.open(self.job / 'bundle.tar', 'x') as bundle:
            for file in sorted(self.package.rglob('*')):
                bundle.add(file, arcname=file.relative_to(self.package).as_posix(), recursive=False)
        self.operation_path = operation_path

    def execute(self, package, action, baseline=None):
        manifest_file = package / 'manifest.json'
        expected = (self.request.get('base') or {}).get('manifestSha256') if package == self.base_package else self.progress.get('manifestSha256')
        if not expected and (self.job / 'progress.json').is_file():
            expected = json.loads((self.job / 'progress.json').read_text(encoding='utf-8')).get('manifestSha256')
        if not expected or sha256(manifest_file) != expected:
            fail('PACKAGE_DIGEST_MISMATCH', 'The executable package manifest does not match the frozen job identity.')
        manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        for item in manifest['files']:
            file = relative_file(package, item['path'])
            if not file.is_file() or sha256(file) != item['sha256']:
                fail('PACKAGE_DIGEST_MISMATCH', 'A frozen deployment executor or material changed before execution.')
        args = [sys.executable, package / 'deploy.py', '--package', package, '--runtime', self.runtime,
                '--environment-id', self.environment_id, '--bind-host', self.request['bindHost'], '--port', str(self.request['port']),
                '--profile', 'isolated', '--action', action]
        if baseline:
            args += ['--baseline', baseline]
        log = self.job / ('execution-' + action + '-' + str(time.time_ns()) + '.log')
        with log.open('xb') as handle:
            try:
                self.command(args, output=handle)
            except Exception as error:
                if getattr(error, 'stderr', None):
                    handle.write(error.stderr)
                raise
        os.chmod(log, 0o600)

    def validate(self):
        self.build_package()
        if self.base_package:
            self.stage('restore-and-start-historical-package', 'restoring')
            self.execute(self.base_package, 'restore', self.base_baseline)
            self.stage('historical-application-healthy', 'upgrading')
            self.execute(self.package, 'upgrade')
        else:
            self.stage('empty-environment-installation', 'upgrading')
            self.execute(self.package, 'initial')
        self.stage('target-package-healthy', 'verifying')
        self.execute(self.package, 'snapshot', self.job / 'private-baseline')
        public_host = self.request.get('publicHost', self.request['bindHost'])
        if public_host in ('0.0.0.0', '::') or not re.fullmatch(r'[A-Za-z0-9.-]+', public_host):
            fail('PUBLIC_ENDPOINT_REQUIRED', 'A usable verification host is required, not a wildcard bind address.')
        environment = {'id': self.environment_id, 'url': f'http://{public_host}:{self.request["port"]}{self.recipe["application"]["entry"]["path"]}', 'status': 'running'}
        validation = {'status': 'passed', 'checks': ['frozen-material-digests', 'fixed-image-architecture',
                      'historical-start-and-real-upgrade' if self.base_package else 'empty-database-initial-installation',
                      'target-http-health', 'recoverable-database-redis-files-baseline'],
                      'limitations': ['Business acceptance requires a human decision.', 'External production database credentials, network and permissions are not exercised by isolated validation.']}
        write_json(self.job / 'verification.json', {'environment': environment, 'validation': validation, 'stages': self.progress['stages']})
        paths = {'bundle': 'bundle.tar', 'sql': 'package/sql/execute.sql', 'deployment-guide': 'package/DEPLOYMENT.md',
                 'operation-guide': 'package/' + self.operation_path, 'manifest': 'package/manifest.json', 'verification': 'verification.json'}
        artifacts = [{'key': key, 'name': Path(path).name, 'relativePath': path, 'size': (self.job / path).stat().st_size,
                      'sha256': sha256(self.job / path)} for key, path in paths.items()]
        baseline = {'manifestSha256': sha256(self.package / 'manifest.json'), 'jobRoot': str(self.job), 'path': 'private-baseline',
                    'files': [{'name': file.name, 'sha256': sha256(file), 'size': file.stat().st_size} for file in sorted((self.job / 'private-baseline').iterdir())]}
        result = {'status': 'success', 'manifestSha256': sha256(self.package / 'manifest.json'), 'artifacts': artifacts,
                  'environment': environment, 'validation': validation, 'baseline': baseline}
        # Copy immutable delivery and recovery bytes to the separately configured permanent backup root.
        self.backup.mkdir(parents=True, mode=0o700)
        for key in ('bundle.tar', 'verification.json'):
            shutil.copyfile(self.job / key, self.backup / key)
        shutil.copytree(self.job / 'private-baseline', self.backup / 'private-baseline')
        write_json(self.backup / 'manifest.json', self.manifest)
        checks = [{'path': file.relative_to(self.backup).as_posix(), 'sha256': sha256(file)} for file in sorted(self.backup.rglob('*')) if file.is_file()]
        write_json(self.backup / 'SHA256SUMS.json', checks)
        write_json(self.backup / 'result.json', result)
        write_json(self.job / 'result.json', result)
        self.progress['environment'] = environment
        self.stage('awaiting-human-acceptance', 'awaiting-acceptance')
        return result

    def stop(self):
        previous = self.job / ('stop-worker-result-' + self.request['stopAttemptId'] + '.json')
        if previous.exists():
            return json.loads(previous.read_text(encoding='utf-8'))
        if not self.package.is_dir() or not self.runtime.is_dir():
            # Missing local state is not evidence that Docker resources were never created.
            # Only an explicit stop may release the slot after all exact-label queries succeed.
            counts = {}
            try:
                for kind in ('container', 'network', 'volume'):
                    args = ['docker', kind, 'ls', '--quiet', '--filter', f'label={LABEL}={self.environment_id}']
                    if kind == 'container':
                        args.append('--all')
                    output = self.command(args)
                    if not isinstance(output, bytes):
                        raise ValueError('Docker resource query did not return bytes.')
                    counts[kind] = len(output.decode('utf-8').strip().splitlines())
            except Exception as error:
                unknown = DeliveryError('ENVIRONMENT_STATE_UNKNOWN', 'Cannot verify this job has no Docker resources; the environment slot remains occupied.')
                unknown.stderr = getattr(error, 'stderr', None)
                raise unknown from error
            if any(counts.values()):
                fail('ENVIRONMENT_RESOURCES_REMAIN', 'This job still has Docker resources but its package or runtime is missing; restore the recorded state before stopping it.')
            return {'status': 'success', 'environment': {'id': self.environment_id, 'status': 'stopped'},
                    'resourceCheck': {'label': f'{LABEL}={self.environment_id}', 'counts': counts, 'result': 'no-owned-resources'},
                    'archiveRetained': True, 'backupRetained': True}
        self.execute(self.package, 'stop')
        return {'status': 'success', 'environment': {'id': self.environment_id, 'status': 'stopped'}, 'archiveRetained': True, 'backupRetained': True}

    def record_stop(self, result):
        attempt = self.request.get('stopAttemptId') or uuid.uuid4().hex
        if not NAME.fullmatch(str(attempt)):
            fail('INVALID_STOP_ATTEMPT', 'The stop attempt identity is invalid.')
        result['stopAttemptId'] = attempt
        immutable = self.job / ('stop-worker-result-' + attempt + '.json')
        if immutable.exists():
            return json.loads(immutable.read_text(encoding='utf-8'))
        write_json(immutable, result)
        write_json(self.job / 'stop-result.json', result)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request', required=True)
    args = parser.parse_args()
    worker = None
    try:
        file = absolute_path(args.request, 'request')
        if os.name != 'nt' and file.stat().st_mode & 0o077:
            fail('UNPROTECTED_REQUEST', 'Worker request must be private to its service identity (0600).')
        request = json.loads(file.read_text(encoding='utf-8'))
        worker = Worker(request)
        result = worker.stop() if request['action'] == 'stop' else worker.validate()
        if request['action'] == 'stop':
            worker.record_stop(result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:
        result = {'status': 'failed', 'artifacts': [], 'validation': {'status': 'failed', 'checks': [], 'limitations': []},
                  'error': {'code': getattr(error, 'code', 'WORKER_FAILED'), 'message': str(error) if isinstance(error, DeliveryError) else 'Protected worker failed; inspect retained private execution evidence.'}}
        if worker:
            result['environment'] = {'id': worker.environment_id, 'status': 'failed'}
            private = worker.job / ('worker-error-' + str(time.time_ns()) + '.log')
            private.write_text(repr(error), encoding='utf-8')
            if getattr(error, 'stderr', None):
                with private.open('ab') as handle:
                    handle.write(error.stderr)
            os.chmod(private, 0o600)
            # Never overwrite any previous terminal result, including failures.
            if not (worker.job / 'result.json').exists() and request['action'] == 'validate':
                write_json(worker.job / 'result.json', result)
                worker.stage('failed', 'failed', error=result['error'])
            elif request['action'] == 'stop':
                worker.record_stop(result)
        print(json.dumps(result, ensure_ascii=False))
        return 1


if __name__ == '__main__':
    sys.exit(main())
