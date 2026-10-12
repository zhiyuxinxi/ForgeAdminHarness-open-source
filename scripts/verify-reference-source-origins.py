import argparse
import datetime
import re
import sys
import hashlib
import json
import subprocess
from pathlib import Path

def require(condition, message):
    if not condition:
        raise ValueError(message)

parser = argparse.ArgumentParser(description='Verify selected reference bytes and bind adjacent license evidence; never grant copying rights.')
parser.add_argument('--manifest', type=Path, required=True)
parser.add_argument('--procode-root', type=Path, required=True)
parser.add_argument('--aiko-root', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
manifest_path = args.manifest.resolve()
manifest = json.loads(manifest_path.read_bytes())
require(manifest['schemaVersion'] == 1 and manifest['evidenceType'] == 'forge-reference-clean-room-source-audit', 'Unsupported source manifest.')
roots = {'PROCODE': args.procode_root.resolve(), 'AIKO': args.aiko_root.resolve()}
output = args.output.resolve()
require(not output.exists(), 'Keep the prior capture immutable.')
require(output.parent.is_dir(), 'Output directory must already exist.')
for source_root in roots.values():
    require(output != source_root and source_root not in output.parents, 'The source directories are read-only.')

def digest(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()

def checked(root, relative):
    require(isinstance(relative, str) and len(relative) <= 4096 and not any(c in relative for c in '\\:\0\r\n'), 'Invalid source path.')
    require(not Path(relative).is_absolute() and all(part not in ['', '.', '..'] for part in relative.split('/')), 'Source path must stay within its root.')
    require(relative.lower() != '.cursor/mcp.json', 'Never read the excluded secret.')
    path = root / relative
    current = path
    while current != root:
        require(not current.is_symlink(), 'Source symlinks are not permitted.')
        current = current.parent
    resolved = path.resolve()
    resolved.relative_to(root)
    return resolved

license_records = {}
entries = []
for alias, sources in [
    ('PROCODE', manifest['procode']['domainSkills'] + manifest['procode']['genericSkills']),
    ('AIKO', manifest['aiko']['files']),
]:
    root = roots[alias]
    require(root.is_dir(), 'Source directory unavailable: ' + alias)
    require(len({source['path'] for source in sources}) == len(sources), 'Duplicate selected source paths.')
    for source in sources:
        require(re.fullmatch(r'[0-9a-f]{64}', source['sha256']), 'Invalid expected source hash.')
        path = checked(root, source['path'])
        exists = path.is_file()
        actual = digest(path) if exists else None
        evidence = []
        packages = []
        parent = path.parent
        while parent == root or root in parent.parents:
            if not parent.is_dir():
                parent = parent.parent
                continue
            for child in sorted(parent.iterdir(), key=lambda item: item.name):
                if child.is_file() and not child.is_symlink() and child.name.lower().split('.')[0] in ['license', 'licence', 'notice', 'copying', 'copyright']:
                    relative = child.relative_to(root).as_posix()
                    key = alias + '/' + relative
                    if key not in license_records:
                        license_records[key] = {'source': alias, 'path': relative, 'bytes': child.stat().st_size, 'sha256': digest(checked(root, relative)), 'applicability': 'ancestor-or-source-directory; applicability and redistribution approval remain separate'}
                    evidence.append(key)
            package = parent / 'package.json'
            if package.is_file() and not package.is_symlink():
                value = json.loads(package.read_bytes())
                packages.append({'path': package.relative_to(root).as_posix(), 'sha256': digest(package), 'name': value.get('name'), 'version': value.get('version'), 'declaredLicense': value.get('license'), 'scope': 'package metadata only; not blanket archive permission'})
            if parent == root:
                break
            parent = parent.parent
        entries.append({'source': alias, 'path': source['path'], 'expectedSha256': source['sha256'], 'actualSha256': actual, 'bytes': path.stat().st_size if exists else None, 'status': 'matched' if actual == source['sha256'] else 'changed' if exists else 'missing', 'recordedDisposition': source['decision'], 'licenseEvidence': evidence, 'packageMetadata': packages, 'copyApproval': 'not-granted-by-this-audit'})

identities = {}
for alias, root in roots.items():
    git = subprocess.run(['git', '-C', str(root), 'rev-parse', '--show-toplevel'], capture_output=True, text=True, encoding='utf-8')
    if git.returncode == 0 and Path(git.stdout.strip()).resolve() == root:
        head = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, encoding='utf-8')
        status = subprocess.run(['git', '-C', str(root), 'status', '--porcelain'], capture_output=True)
        require(head.returncode == 0 and status.returncode == 0, 'Git source identity could not be read.')
        identities[alias] = {'kind': 'git-root', 'head': head.stdout.strip(), 'worktreeDirty': bool(status.stdout), 'statusBytesSha256': hashlib.sha256(status.stdout).hexdigest()}
    else:
        identities[alias] = {'kind': 'owner-provided-evidence-directory', 'gitCommit': None, 'upstreamIdentityProven': False}

domain_files = []
root = roots['PROCODE']
for entry in manifest['procode']['domainSkills']:
    directory = checked(root, entry['path']).parent
    if not directory.is_dir():
        continue
    for path in directory.rglob('*'):
        if path.is_file():
            relative = path.relative_to(root).as_posix()
            actual = checked(root, relative)
            domain_files.append({'path': relative, 'bytes': actual.stat().st_size, 'sha256': digest(actual)})
domain_files.sort(key=lambda item: item['path'])
require(len({item['path'] for item in domain_files}) == len(domain_files), 'Overlapping domain source directories.')
counts = {status: sum(item['status'] == status for item in entries) for status in ['matched', 'changed', 'missing']}
domain_bytes = sum(item['bytes'] for item in domain_files)
domain_shape_matches = len(domain_files) == manifest['procode']['domainTree']['fileCount'] and domain_bytes == manifest['procode']['domainTree']['byteCount']
result = {
    'schemaVersion': 1, 'evidenceType': 'selected-reference-source-and-license-file-verification',
    'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceManifest': {'path': args.manifest.as_posix(), 'sha256': digest(manifest_path)},
    'sourceRoots': {'PROCODE': 'owner-provided ProCode read-only evidence root', 'AIKO': 'owner-provided AIKO read-only evidence root'},
    'identities': identities, 'counts': counts, 'selectedFiles': entries,
    'sourceBytesVerified': counts['changed'] == 0 and counts['missing'] == 0,
    'formalCapabilityStatus': 'partial',
    'domainInventoryShapeMatches': domain_shape_matches,
    'licenseFiles': list(license_records.values()),
    'procodeDomainInventory': {'files': domain_files, 'fileCount': len(domain_files), 'byteCount': sum(item['bytes'] for item in domain_files), 'canonicalJsonSha256': hashlib.sha256(json.dumps(domain_files, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest(), 'canonicalization': 'UTF-8 JSON array sorted by path; object keys sorted; compact separators; no newline', 'oldCanonicalHashCompared': False, 'oldCanonicalHashLimitation': 'The original manifest does not specify its canonical serialization; do not guess or claim equality with that old aggregate digest.'},
    'excludedSecret': {'source': 'PROCODE', 'path': '.cursor/mcp.json', 'contentRead': False},
    'cannotClaim': ['No copying or redistribution approval is created.', 'Package metadata does not license the enclosing archive.', 'No task-owned delivery diff or dependency-license gate was executed.', 'No protected provenance-and-license receipt was issued.', 'This is not GOV-CLEANROOM-001 formal completion.'],
    'mutations': {'sourceFiles': 0, 'runtime': 0, 'business': 0},
}
with output.open('x', encoding='utf-8', newline='\n') as stream:
    stream.write(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'capture': args.output.as_posix(), 'sha256': digest(output), 'counts': counts, 'licenseFiles': len(license_records), 'domainFiles': len(domain_files), 'domainBytes': result['procodeDomainInventory']['byteCount'], 'identities': identities}, ensure_ascii=False))

if counts['changed'] or counts['missing'] or not domain_shape_matches:
    sys.exit(2)
