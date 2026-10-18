#!/usr/bin/env python3
"""Offline, lossless layer reset for an immutable Harness image.

BuildKit copies the image filesystem without running its entrypoint. The Docker
archive then receives the original complete runtime Config; volumes, commands,
healthchecks and environment are not reconstructed from shell strings.
Original images and all intermediate artifacts remain available for rollback.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import time


TREE_PROBE = r'''
const fs=require('fs'),crypto=require('crypto');
const skip=new Set(['/proc','/sys','/dev','/.dockerenv','/etc/hosts','/etc/hostname','/etc/resolv.conf']);
const hash=crypto.createHash('sha256');let files=0,bytes=0,entries=0;
const buffer=Buffer.alloc(1024*1024);
function walk(p){if(skip.has(p))return;const s=fs.lstatSync(p);
 const row=[p,s.mode&4095,s.uid,s.gid];entries++;
 if(s.isSymbolicLink())row.push('link',fs.readlinkSync(p));
 else if(s.isDirectory())row.push('dir');
 else if(s.isFile()){const h=crypto.createHash('sha256'),fd=fs.openSync(p,'r');let n;
  try{while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,n));}finally{fs.closeSync(fd);}
  row.push('file',s.size,h.digest('hex'));files++;bytes+=s.size;
 }else throw Error('Unsupported image entry: '+p);
 hash.update(JSON.stringify(row)+'\n');
 if(s.isDirectory())for(const n of fs.readdirSync(p).sort())walk(p==='/'?'/'+n:p+'/'+n);
}
walk('/');console.log(JSON.stringify({digest:hash.digest('hex'),entries,files,bytes,excluded:[...skip]}));
'''


def run(args, timeout=600):
    return subprocess.check_output(args, text=True, timeout=timeout).strip()


def inspect(ref):
    return json.loads(run(['docker', 'image', 'inspect', ref], 30))[0]


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'))+'\n').encode()


def write_json(path, value):
    path.write_bytes(json_bytes(value))


def tree(image):
    return json.loads(run(['docker', 'run', '--rm', '--pull=never', '--network=none',
        '--read-only', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--security-opt=no-new-privileges:true',
        '--user=0:0', '--entrypoint=/usr/local/bin/node', image, '-e', TREE_PROBE]))


def compact(source, tag, resource):
    resource.mkdir(mode=0o700, parents=True, exist_ok=False)
    start=time.monotonic()
    original=inspect(source)
    assert original['Os']=='linux' and original['Architecture']=='amd64', 'Unsupported platform'
    source_id=original['Id']
    proof={'schemaVersion':'forge-image-compaction/v1','status':'building',
           'sourceImage':source_id,'sourceLayers':len(original['RootFS']['Layers']),
           'tag':tag,'preservedConfig':original['Config']}
    write_json(resource/'source-inspect.json', original)
    write_json(resource/'result.json',proof)
    try:
        # A local named ref is required: BuildKit can treat a bare sha256 as a repository.
        source_tag='forge-harness/compaction-source:'+source_id[7:19]
        run(['docker','tag',source_id,source_tag])
        raw_tag='forge-harness/compaction-filesystem:'+source_id[7:19]
        (resource/'Dockerfile').write_text('FROM '+source_tag+' AS verified_source\n'
            'FROM scratch\nCOPY --from=verified_source / /\n')
        with (resource/'build.log').open('x') as log:
            p=subprocess.run(['docker','build','--pull=false','--network=none','-t',raw_tag,str(resource)],
                             stdout=log,stderr=subprocess.STDOUT,timeout=600)
        assert p.returncode==0, 'Filesystem compaction build failed; inspect build.log'
        raw=inspect(raw_tag)
        assert len(raw['RootFS']['Layers'])==1,'Compaction did not produce one filesystem layer'
        archive=resource/'filesystem-image.tar'
        run(['docker','image','save','-o',str(archive),raw['Id']])
        with tarfile.open(archive) as src:
            manifest=json.load(src.extractfile('manifest.json'))
            assert len(manifest)==1
            entry=manifest[0]
            config=json.load(src.extractfile(entry['Config']))
            config['config']=original['Config']
            config['architecture']=original['Architecture'];config['os']=original['Os']
            cfg=json_bytes(config);cfg_name=hashlib.sha256(cfg).hexdigest()+'.json'
            new_manifest=[{'Config':cfg_name,'RepoTags':[tag],'Layers':entry['Layers']}]
            with tarfile.open(resource/'compacted-image.tar','w') as dst:
                for name,data in [(cfg_name,cfg),('manifest.json',json_bytes(new_manifest))]:
                    info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
                    dst.addfile(info,io.BytesIO(data))
                for name in entry['Layers']:
                    info=src.getmember(name);dst.addfile(info,src.extractfile(info))
        run(['docker','image','load','-i',str(resource/'compacted-image.tar')])
        final=inspect(tag)
        assert final['Config']==original['Config'],'Runtime Config changed'
        assert len(final['RootFS']['Layers'])==1,'Loaded image layers differ'
        before=tree(source_id);after=tree(final['Id'])
        assert before==after,'Filesystem content/ownership/mode/link comparison failed'
        # Actual unprivileged execution additionally checks search/execute permissions.
        runtime=run(['docker','run','--rm','--pull=never','--read-only','--network=none',
                     '--cap-drop=ALL','--security-opt=no-new-privileges:true',
                     '--entrypoint=/usr/local/bin/node',final['Id'],'-e',
                     'console.log(JSON.stringify({uid:process.getuid(),version:process.version}));'])
        proof.update(status='verified',imageId=final['Id'],layers=1,filesystem=after,
            configPreserved=True,runtime=json.loads(runtime),seconds=round(time.monotonic()-start,3))
        # Config itself can contain inherited environment; keep this receipt private.
        write_json(resource/'result.json',proof)
        return proof
    except Exception as exc:
        proof.update(status='failed',error=str(exc),seconds=round(time.monotonic()-start,3))
        write_json(resource/'result.json',proof)
        raise


def resume_verification(resource):
    """Resume only failed observation; never rebuild or replace its failed receipt."""
    proof=json.loads((resource/'result.json').read_text())
    original=json.loads((resource/'source-inspect.json').read_text())
    assert proof['status'] in ['failed','building']
    source=inspect(proof['sourceImage']);final=inspect(proof['tag'])
    assert source['Id']==original['Id'] and source['Config']==original['Config']
    assert final['Config']==original['Config'] and len(final['RootFS']['Layers'])==1
    before=tree(source['Id']);after=tree(final['Id'])
    assert before==after,'Filesystem content/ownership/mode/link comparison failed'
    runtime=json.loads(run(['docker','run','--rm','--pull=never','--read-only','--network=none',
        '--cap-drop=ALL','--security-opt=no-new-privileges:true','--entrypoint=/usr/local/bin/node',
        final['Id'],'-e','console.log(JSON.stringify({uid:process.getuid(),version:process.version}));']))
    recovered={**proof,'status':'verified','imageId':final['Id'],'layers':1,'configPreserved':True,
        'filesystem':after,'runtime':runtime,'recoveredFrom':'result.json'}
    recovered.pop('error',None)
    write_json(resource/'verification.json',recovered)
    return recovered


def register(proof, foundation_ref, receipt_root):
    assert proof['status']=='verified' and proof['configPreserved']
    source=inspect(proof['sourceImage']);target=inspect(proof['imageId']);foundation=inspect(foundation_ref)
    assert source['Config']==target['Config'] and len(target['RootFS']['Layers'])==1
    base_layers=foundation['RootFS']['Layers']
    assert base_layers and source['RootFS']['Layers'][:len(base_layers)]==base_layers
    config_sha=hashlib.sha256(json.dumps(target['Config'],sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
    receipt={'schemaVersion':'forge-image-compaction-registration/v1','status':'verified',
        'sourceImage':source['Id'],'imageId':target['Id'],'foundationImage':foundation['Id'],
        'sourceLayers':source['RootFS']['Layers'],'targetLayers':target['RootFS']['Layers'],
        'configSha256':config_sha,'filesystemBefore':proof['filesystem'],'filesystemAfter':proof['filesystem'],
        'runtime':proof['runtime'],'provenance':'runtime-equivalent-repack; original source labels preserved'}
    receipt_root.mkdir(mode=0o755,parents=True,exist_ok=True)
    assert receipt_root.stat().st_uid==0 and not receipt_root.is_symlink()
    file=receipt_root/(target['Id'][7:]+'.json')
    if file.exists():assert json.loads(file.read_text())==receipt
    else:
        with file.open('xb') as out:out.write(json_bytes(receipt))
        file.chmod(0o644)
    return file


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source-image')
    p.add_argument('--tag')
    p.add_argument('--resume-verification',action='store_true')
    p.add_argument('--register-only',action='store_true')
    p.add_argument('--foundation-image')
    p.add_argument('--receipt-root',type=Path)
    p.add_argument('--resource',type=Path,required=True)
    args=p.parse_args()
    if args.register_only:
        result=json.loads((args.resource/('verification.json' if (args.resource/'verification.json').exists() else 'result.json')).read_text())
        assert result['status']=='verified'
        if args.tag: run(['docker','tag',result['imageId'],args.tag])
    elif args.resume_verification: result=resume_verification(args.resource)
    else:
        assert args.source_image and args.tag
        result=compact(args.source_image,args.tag,args.resource)
    if args.receipt_root:
        assert args.foundation_image
        register(result,args.foundation_image,args.receipt_root)
    print(json.dumps({k:result[k] for k in ['status','sourceImage','imageId','sourceLayers','layers','configPreserved','filesystem','runtime','seconds']}))
