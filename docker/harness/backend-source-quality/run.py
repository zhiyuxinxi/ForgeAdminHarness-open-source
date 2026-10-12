"""Host-only adapter for the pinned scanner; never imports business tooling."""
import argparse
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

BUNDLE = Path(__file__).resolve().parent
MAX_BYTES = 1024 * 1024


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--bundle-sha256', required=True)
    parser.add_argument('--base')
    parser.add_argument('--file', action='append')
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {'schemaVersion': 1, 'mode': 'fast', 'status': 'error',
              'bundleSha256': args.bundle_sha256, 'files': [], 'findings': [], 'errors': []}
    code = 2
    try:
        manifest = BUNDLE / 'manifest.json'
        if digest(manifest) != args.bundle_sha256:
            raise ValueError('Pinned scanner manifest mismatch')
        release = json.loads(manifest.read_text())
        for name, expected in release['files'].items():
            if (BUNDLE / name).resolve().parent != BUNDLE or digest(BUNDLE / name) != expected:
                raise ValueError('Pinned scanner file mismatch')
        runtime = output / 'runtime'
        runtime_manifest = BUNDLE / 'runtime-manifest.json'
        dependencies = json.loads(runtime_manifest.read_text())
        archive = BUNDLE / 'runtime.zip'
        if digest(archive) != dependencies['archiveSha256']:
            raise ValueError('Prepared scanner archive mismatch')
        jars = []
        with zipfile.ZipFile(archive) as prepared:
            if sorted(prepared.namelist()) != sorted(item['path'] for item in dependencies['jars']):
                raise ValueError('Prepared scanner archive inventory mismatch')
            if sum(item.file_size for item in prepared.infolist()) > 256 * 1024 * 1024:
                raise ValueError('Prepared scanner archive exceeds size limit')
            for item in dependencies['jars']:
                jar = (runtime / item['path']).resolve()
                if not jar.is_relative_to(runtime) or jar.suffix != '.jar':
                    raise ValueError('Prepared scanner dependency path mismatch')
                jar.parent.mkdir(parents=True, exist_ok=True)
                jar.write_bytes(prepared.read(item['path']))
                if digest(jar) != item['sha256']:
                    raise ValueError('Prepared scanner dependency mismatch')
                jars.append(str(jar))
        if not jars:
            raise ValueError('Prepared scanner dependencies are empty')
        tools = output / 'tools'
        (tools / 'target/runtime').mkdir(parents=True)
        for name in ('pmd.xml', 'checkstyle.xml'):
            shutil.copyfile(BUNDLE / name, tools / name)
        (tools / 'target/runtime/classpath.txt').write_text(os.pathsep.join(jars), encoding='utf-8')
        spec = importlib.util.spec_from_file_location('trusted_backend_quality', BUNDLE / 'backend-quality.py')
        scanner = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(scanner)
        scanner.ROOT = Path(args.root).resolve()
        scanner.TOOLS = tools
        selected = scanner.selected_files(args)
        if len(selected) > 32 or any(not path.relative_to(scanner.ROOT).as_posix().startswith('forge-server/') for path in selected):
            raise ValueError('Select up to 32 forge-server Java files; narrow the explicit scope')
        sys.argv = [str(BUNDLE / 'backend-quality.py'), 'fast']
        if args.base:
            sys.argv += ['--base', args.base]
        for file in args.file or []:
            sys.argv += ['--file', file]
        with contextlib.redirect_stdout(io.StringIO()):
            code = scanner.main()
        result_file, = (tools / 'target/reports').glob('*/result.json')
        report = json.loads(result_file.read_text(encoding='utf-8'))
        report['bundleSha256'] = args.bundle_sha256
        report['runtimeSha256'] = digest(runtime_manifest)
        report['pythonVersion'] = sys.version.split()[0]
        # Keep native JSON/XML and tool logs with the structured evidence, bounded
        # to the same receipt limit. No host-only path is required to read them.
        report['nativeReports'] = []
        for file in sorted(result_file.parent.iterdir()):
            if file.name == 'result.json' or file.suffix not in ('.json', '.xml', '.log'):
                continue
            report['nativeReports'].append({'name': file.name, 'sha256': digest(file),
                                           'text': file.read_text(encoding='utf-8', errors='replace')})
        if len(json.dumps(report).encode()) > MAX_BYTES:
            raise ValueError('Scanner report exceeds receipt limit; narrow the explicit file selection')
    except (OSError, ValueError, KeyError, ImportError, subprocess.SubprocessError, zipfile.BadZipFile) as error:
        report = {'schemaVersion': 1, 'mode': 'fast', 'status': 'error',
                  'bundleSha256': args.bundle_sha256, 'files': [], 'findings': [], 'errors': [str(error)]}
        code = 2
    (output / 'result.json').write_text(json.dumps(report, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'status': report['status'], 'findings': len(report['findings']),
                      'errors': len(report['errors'])}))
    return code


if __name__ == '__main__':
    sys.exit(main())
