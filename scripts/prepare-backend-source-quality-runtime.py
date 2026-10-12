"""Package an already prepared PMD/Checkstyle classpath; never downloads dependencies."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import zipfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--classpath', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
jars = [Path(value.strip()).resolve() for value in args.classpath.read_text(encoding='utf-8').strip().split(os.pathsep)]
names = [jar.name for jar in jars]
if not jars or len(set(names)) != len(names) or any(not jar.is_file() or jar.suffix != '.jar' for jar in jars):
    raise SystemExit('Existing classpath must contain unique, readable JAR files')
if 'pmd-java-7.17.0.jar' not in names or 'pmd-cli-7.17.0.jar' not in names or 'checkstyle-10.26.1.jar' not in names:
    raise SystemExit('The prepared classpath does not contain the pinned PMD/Checkstyle versions')
args.output.mkdir(parents=True, exist_ok=True)
archive = args.output / 'runtime.zip'
manifest = args.output / 'runtime-manifest.json'
if archive.exists() or manifest.exists():
    raise SystemExit('Preserve existing runtime artifacts; select a new output directory')
entries = []
with zipfile.ZipFile(archive, 'x', zipfile.ZIP_STORED) as result:
    for jar in sorted(jars, key=lambda value: value.name):
        raw = jar.read_bytes()
        result.writestr(jar.name, raw)
        entries.append({'path': jar.name, 'sha256': hashlib.sha256(raw).hexdigest()})
value = {'schemaVersion': 1, 'tools': {'pmd': '7.17.0', 'checkstyle': '10.26.1'},
         'archiveSha256': hashlib.sha256(archive.read_bytes()).hexdigest(), 'jars': entries}
manifest.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'status': 'prepared', 'jars': len(entries), 'archiveSha256': value['archiveSha256']}))
