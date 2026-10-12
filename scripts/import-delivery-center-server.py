#!/usr/bin/env python3
"""Prepare, import once, or verify a private Delivery Center candidate.

Only `prepare` is local. `import` and `verify` require explicit action selection
and a previously prepared bundle. Nothing installs a daemon, updates Gateway,
initializes SQL tables, or changes any business file or existing service.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import stat
import subprocess
import tarfile


ROOT = Path(__file__).resolve().parents[1]
SOURCE_NAMES = ["delivery-center-config.mjs", "delivery-center-store.mjs", "delivery-center-projection.mjs",
                "delivery-center-assets.mjs", "delivery-center-asset-projection.mjs",
                "delivery-center-semantics.mjs", "delivery-center-views.mjs",
                "delivery-center-document-source.mjs",
                "delivery-center-checkpoint-source.mjs",
                "delivery-center-diagrams.mjs",
                "delivery-center-import.mjs", "delivery-center-http.mjs", "delivery-center-service.mjs",
                "project-directory.mjs", "delivery-center-schema.sql"]
PRIVATE_ROOT = "/srv/forge-delivery/conversation-control-plane/delivery-center"
REGISTRY = "/srv/forge-delivery/registry/projects.tsv"
PROJECTS_ROOT = "/srv/forge-delivery/projects"

DEPENDENCY_INVENTORY = r'''
const fs=require('fs'),path=require('path');const root=process.cwd();const seen=new Map();
function packageRoot(name,from){
  let filename;try{filename=require.resolve(name+'/package.json',{paths:[from]});}
  catch{filename=require.resolve(name,{paths:[from]});}
  let directory=path.dirname(filename);
  while(directory!==path.dirname(directory)){
    const file=path.join(directory,'package.json');
    if(fs.existsSync(file)){const pkg=JSON.parse(fs.readFileSync(file,'utf8'));if(pkg.name===name)return{directory,pkg};}
    directory=path.dirname(directory);
  }throw Error('DEPENDENCY_IDENTITY_INVALID');
}
function visit(name,from){const entry=packageRoot(name,from);if(seen.has(entry.directory))return;
  if(!entry.directory.startsWith(path.join(root,'node_modules')+path.sep))throw Error('DEPENDENCY_OUTSIDE_REPOSITORY');
  seen.set(entry.directory,{relative:path.relative(root,entry.directory).split(path.sep).join('/'),name:entry.pkg.name,version:entry.pkg.version});
  for(const child of Object.keys(entry.pkg.dependencies||{}).sort())visit(child,entry.directory);
}
visit('mysql2',root);console.log(JSON.stringify([...seen.values()].sort((a,b)=>a.relative.localeCompare(b.relative))));
'''

ONCE_PROGRAM = r'''
import crypto from 'node:crypto';
import {chmod, lstat, mkdtemp, readFile, rmdir, unlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {readRegistryDeliverySources} from './delivery-center-import.mjs';
import {readDeliveryDatabaseConfig} from './delivery-center-config.mjs';
import {createDeliveryCenterPool,DeliveryCenterStore} from './delivery-center-store.mjs';
import {createDeliveryReadServer,createDeliveryCenterClient} from './delivery-center-service.mjs';
const [action,configFile,manifestFile]=process.argv.slice(2);
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safe=error=>({code:typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'DELIVERY_VERIFICATION_FAILED',
  ...(Number.isInteger(error?.errno)?{errno:error.errno}:{})});
try{
  if(action==='manifest'){
    const projects=await readRegistryDeliverySources({registryPath:'/srv/forge-delivery/registry/projects.tsv',projectsRoot:'/srv/forge-delivery/projects'});
    if(projects.length===0)throw Object.assign(Error(),{code:'DELIVERY_REGISTRY_EMPTY'});
    const manifest={schemaVersion:1,projects};
    await writeFile(manifestFile,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({ok:true,projects:projects.map(p=>({projectSlug:p.projectSlug,phaseSource:p.phaseRoot!==null,releaseSource:p.releaseAuditPath!==null,brokerSource:p.brokerAuditPath!=null})),manifestDigest:hash(manifest)}));
  }else if(action==='verify'){
    const manifest=JSON.parse(await readFile(manifestFile,'utf8'));
    const expected=manifest.projects.map(p=>p.projectSlug).sort();
    if(expected.length===0)throw Object.assign(Error(),{code:'DELIVERY_REGISTRY_EMPTY'});
    const config=await readDeliveryDatabaseConfig(configFile);
    if(config.user!=='forge_delivery_reader'||config.database!=='forge_delivery_center')throw Object.assign(Error(),{code:'DELIVERY_READER_IDENTITY_INVALID'});
    const pool=createDeliveryCenterPool(config),store=new DeliveryCenterStore({pool});
    const directory=await mkdtemp(path.join(path.dirname(configFile),'verify-'));
    const socket=path.join(directory,'read.sock');
    const server=createDeliveryReadServer({store});
    let listening=false;
    const receipt={ok:false,transientUnixServer:true,projects:[],readerWriteDenied:null};
    try{
      const [[identity]]=await pool.execute('SELECT CURRENT_USER() AS account,DATABASE() AS databaseName');
      if(identity.account!=='forge_delivery_reader@192.0.2.12'||identity.databaseName!=='forge_delivery_center')throw Object.assign(Error(),{code:'DELIVERY_READER_IDENTITY_INVALID'});
      receipt.databaseIdentity=identity;
      const [[jsonPath]]=await pool.execute("SELECT JSON_EXTRACT(CAST(? AS JSON), '$.menuPath[0]') = CAST(? AS JSON) AS matched",
        [JSON.stringify({menuPath:['historical-parent','old-page']}),JSON.stringify('historical-parent')]);
      if(Number(jsonPath.matched)!==1)throw Object.assign(Error(),{code:'DELIVERY_HISTORICAL_PATH_QUERY_FAILED'});
      receipt.historicalPathSqlVerified=true;
      try{await pool.execute('UPDATE delivery_center_projects SET name = name WHERE 1 = 0');
        receipt.readerWriteDenied={denied:false};throw Object.assign(Error(),{code:'DELIVERY_READER_WRITE_ALLOWED'});
      }catch(error){
        if(error.code!=='ER_TABLEACCESS_DENIED_ERROR'||error.errno!==1142)throw error;
        receipt.readerWriteDenied={denied:true,...safe(error)};
      }
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});listening=true;await chmod(socket,0o600);
      const client=createDeliveryCenterClient({socketPath:socket,timeoutMs:30000});
      const projects=await client.listProjects();
      if(JSON.stringify(projects.map(p=>p.slug).sort())!==JSON.stringify(expected))throw Object.assign(Error(),{code:'DELIVERY_IMPORTED_PROJECT_SET_MISMATCH'});
      for(const project of projects){
        const overview=await client.overview(project.slug);
        const page=await client.listRequirements(project.slug,{page:1,pageSize:1});
        const menus=await client.listMenus(project.slug);
        let selectedMenu=null;
        if(menus.length){
          const menu=menus.find(item=>item.parentId===null)||menus[0];
          const filtered=await client.listRequirements(project.slug,{menuId:menu.id,page:1,pageSize:1});
          const exported=await client.exportRequirements(project.slug,{menuId:menu.id});
          if(exported.length!==filtered.total)throw Object.assign(Error(),{code:'DELIVERY_MENU_EXPORT_COUNT_MISMATCH'});
          selectedMenu={id:menu.id,rows:filtered.total};
        }
        const rows=await client.exportRequirements(project.slug,{});
        if(rows.length!==page.total)throw Object.assign(Error(),{code:'DELIVERY_EXPORT_COUNT_MISMATCH'});
        const releases=await client.listReleases(project.slug,{page:1,pageSize:1});
        let historic=null;
        if(releases.items.length){
          const releaseId=releases.items[0].id;
          const menus=await client.listMenus(project.slug,{releaseId});
          const historicRows=await client.exportRequirements(project.slug,{releaseId});
          const historicalPage=await client.listRequirements(project.slug,{releaseId,page:1,pageSize:1});
          if(historicRows.length!==historicalPage.total)throw Object.assign(Error(),{code:'DELIVERY_HISTORIC_EXPORT_COUNT_MISMATCH'});
          historic={releaseId,menuCount:menus.length,rows:historicRows.length,digest:hash(historicRows)};
        }
        receipt.projects.push({slug:project.slug,counts:overview.counts,coverage:overview.coverage,
          menuCount:menus.length,selectedMenu,exportedRows:rows.length,exportDigest:hash(rows),historic});
      }
      receipt.ok=true;
    }catch(error){receipt.error=safe(error);process.exitCode=1;}
    finally{
      if(listening)await new Promise(resolve=>server.close(resolve));
      await store.close();
      if((await lstat(socket).catch(()=>null))?.isSocket())await unlink(socket);
      await rmdir(directory);
    }
    console.log(JSON.stringify(receipt));
  }else throw Object.assign(Error(),{code:'DELIVERY_ONCE_ACTION_INVALID'});
}catch(error){console.log(JSON.stringify({ok:false,error:safe(error)}));process.exitCode=1;}
'''

REMOTE_PROGRAM = r'''
import hashlib,json,os,pathlib,pwd,re,stat,subprocess,sys,tarfile,time
request=json.load(sys.stdin)
root=pathlib.Path('/srv/forge-delivery/conversation-control-plane/delivery-center')
owner=pwd.getpwnam('forge')
def need(value,code):
    if not value:raise RuntimeError(code)
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
receipt={'ok':False,'action':request.get('action'),'servicesDeployed':False,'gatewayChanged':False,'businessFilesChanged':False}
stage='preflight'
try:
    need(set(request)=={'action','archive','archiveSha256','contentDigest','operationId'},'REQUEST_INVALID')
    need(request['action'] in ['import','verify'],'ACTION_INVALID')
    for key in ['archiveSha256','contentDigest']:need(re.fullmatch(r'[a-f0-9]{64}',request[key]) is not None,'DIGEST_INVALID')
    need(re.fullmatch(r'[a-f0-9]{16}',request['operationId']) is not None,'OPERATION_INVALID')
    info=root.lstat();need(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode)==0o700 and info.st_uid==owner.pw_uid,'PRIVATE_ROOT_INVALID')
    archive=root/request['archive'];need(archive.name=='incoming-'+request['archiveSha256']+'.tar.gz','ARCHIVE_NAME_INVALID')
    info=archive.lstat();need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==owner.pw_uid and info.st_size<=32*1024*1024,'ARCHIVE_IDENTITY_INVALID')
    need(digest(archive)==request['archiveSha256'],'ARCHIVE_DIGEST_MISMATCH')
    node_base=pathlib.Path('/srv/forge-delivery-a9-backend-bc1-vpn76-v29-7fa8cff649135742/node-v24.20.0-89af8424')
    candidates=[]
    for option in [node_base/'bin/node',node_base]:
        try:node_info=option.lstat()
        except (FileNotFoundError,NotADirectoryError):continue
        if stat.S_ISREG(node_info.st_mode) and os.access(option,os.X_OK):candidates.append(option)
    need(len(candidates)==1,'REVIEWED_NODE_PATH_INVALID');node=candidates[0]
    need(subprocess.run([str(node),'--version'],capture_output=True,text=True,timeout=10).stdout.strip()=='v24.20.0','REVIEWED_NODE_VERSION_INVALID')
    node_digest=digest(node)
    need(node_digest=='89af8424dd53e560b1933f87ba650d8bf57c83ca5a04600eefb31f416aabbae7','REVIEWED_NODE_DIGEST_CHANGED')
    receipt.update({'nodePath':str(node),'nodeSha256':node_digest,'contentDigest':request['contentDigest'],'archiveSha256':request['archiveSha256']})
    candidate=root/('candidate-'+request['contentDigest'])
    with tarfile.open(archive,'r:gz') as bundle:
        members=bundle.getmembers();names=[member.name for member in members]
        need(len(names)==len(set(names)) and len(names)<=5000,'BUNDLE_MEMBER_COUNT_INVALID')
        need(all(member.isfile() and not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(member.name).parts for member in members),'BUNDLE_MEMBER_UNSAFE')
        manifest=json.load(bundle.extractfile('bundle-manifest.json'))
        need(set(names)==set(manifest['files'])|{'bundle-manifest.json'},'BUNDLE_FILE_SET_INVALID')
        canonical=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()
        need(hashlib.sha256(canonical).hexdigest()==request['contentDigest'],'BUNDLE_CONTENT_DIGEST_MISMATCH')
        for name,expected in manifest['files'].items():need(hashlib.sha256(bundle.extractfile(name).read()).hexdigest()==expected['sha256'],'BUNDLE_FILE_DIGEST_MISMATCH')
        if not candidate.exists():
            stage='install-private-candidate';candidate.mkdir(mode=0o700)
            for member in members:
                destination=candidate/member.name;destination.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
                with destination.open('xb') as output:output.write(bundle.extractfile(member).read())
                os.chmod(destination,0o444)
            for directory,_,_ in os.walk(candidate):os.chmod(directory,0o555)
        candidate_info=candidate.lstat()
        need(stat.S_ISDIR(candidate_info.st_mode) and candidate_info.st_uid==0 and stat.S_IMODE(candidate_info.st_mode)==0o555,'CANDIDATE_DIRECTORY_INVALID')
        for name,expected in manifest['files'].items():
            p=candidate/name;info=p.lstat();need(stat.S_ISREG(info.st_mode) and info.st_nlink==1 and info.st_uid==0 and stat.S_IMODE(info.st_mode)==0o444 and digest(p)==expected['sha256'],'CANDIDATE_FILE_CHANGED')
    environment={'PATH':'/usr/bin:/bin','NODE_PATH':str(candidate/'node_modules'),'TZ':'Asia/Shanghai','LANG':'C.UTF-8'}
    def invoke(argv,as_owner=False):
        result=subprocess.run((['/usr/sbin/runuser','-u','forge','--'] if as_owner else [])+[str(node),*argv],cwd=candidate,env=environment,capture_output=True,text=True,timeout=300)
        try:body=json.loads(result.stdout.strip())
        except Exception:body={'ok':False,'code':'NODE_RESPONSE_INVALID'}
        return {'exitCode':result.returncode,'result':body,'stderrBytes':len(result.stderr.encode()),'stderrSha256':hashlib.sha256(result.stderr.encode()).hexdigest()}
    manifest_file=root/('sources-'+request['operationId']+'.json')
    stage='capture-registry-manifest'
    manifest_result=invoke([str(candidate/'server-delivery-center-once.mjs'),'manifest',str(root/'writer.json'),str(manifest_file)])
    receipt['manifest']=manifest_result
    need(manifest_result['exitCode']==0 and manifest_result['result'].get('ok') is True,'SOURCE_MANIFEST_FAILED')
    os.chown(manifest_file,owner.pw_uid,owner.pw_gid);os.chmod(manifest_file,0o600)
    receipt['sourceManifestPath']=str(manifest_file)
    if request['action']=='import':
        stage='single-import'
        # Root can read protected stage sources. The process receives only the
        # dedicated DML writer config; sudo/DBA credentials are absent from its
        # arguments and minimal environment. No --watch or --initialize.
        outcome=invoke([str(candidate/'delivery-center-import.mjs'),'--config',str(root/'writer.json'),'--sources',str(manifest_file)])
        receipt['import']=outcome;receipt['ok']=outcome['exitCode']==0 and outcome['result'].get('ok') is True
    else:
        stage='reader-and-unix-verification'
        outcome=invoke([str(candidate/'server-delivery-center-once.mjs'),'verify',str(root/'reader.json'),str(manifest_file)],as_owner=True)
        receipt['verification']=outcome;receipt['ok']=outcome['exitCode']==0 and outcome['result'].get('ok') is True
    receipt['candidatePath']=str(candidate)
except Exception as error:
    value=str(error)
    receipt.update({'ok':False,'failedStage':stage,'errorCode':value if isinstance(error,RuntimeError) and re.fullmatch(r'[A-Z0-9_]+',value) else type(error).__name__})
finally:
    receipt['finishedAt']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
    if re.fullmatch(r'[a-f0-9]{16}',str(request.get('operationId',''))):
        output=root/('operation-'+request['operationId']+'.json')
        with output.open('x') as file:json.dump(receipt,file);file.write('\n');file.flush();os.fsync(file.fileno())
        os.chmod(output,0o600);os.chown(output,owner.pw_uid,owner.pw_gid)
    print(json.dumps(receipt))
'''


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def helper():
    spec = importlib.util.spec_from_file_location("delivery_provision", ROOT / "scripts/provision-delivery-center-database.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bundle_files():
    result = subprocess.run(["node", "-e", DEPENDENCY_INVENTORY], cwd=ROOT, capture_output=True, text=True, timeout=20)
    need(result.returncode == 0, "DEPENDENCY_INVENTORY_FAILED")
    dependencies = json.loads(result.stdout)
    files = {name: (ROOT / "docker/harness" / name).read_bytes() for name in SOURCE_NAMES}
    files["server-delivery-center-once.mjs"] = ONCE_PROGRAM.encode("utf-8")
    for dependency in dependencies:
        package = ROOT / dependency["relative"]
        need(package.resolve().is_relative_to((ROOT / "node_modules").resolve()) and not package.is_symlink(), "DEPENDENCY_PATH_UNSAFE")
        for directory, directories, names in os.walk(package):
            directories[:] = sorted(name for name in directories if name != "node_modules")
            for name in sorted(names):
                file = Path(directory) / name
                need(file.is_file() and not file.is_symlink(), "DEPENDENCY_FILE_UNSAFE")
                relative = file.relative_to(ROOT).as_posix()
                need(relative not in files, "DUPLICATE_BUNDLE_FILE")
                files[relative] = file.read_bytes()
    need(len(files) <= 5000 and sum(map(len, files.values())) <= 64 * 1024 * 1024, "BUNDLE_LIMIT")
    manifest = {"schemaVersion": 1, "dependencies": dependencies,
                "files": {name: {"sha256": hashlib.sha256(value).hexdigest(), "bytes": len(value)} for name, value in sorted(files.items())}}
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return files, manifest, canonical


def prepare(cache):
    files, manifest, canonical = bundle_files()
    content_digest = hashlib.sha256(canonical).hexdigest()
    cache.mkdir(parents=True, exist_ok=True)
    filename = cache / ("delivery-center-" + content_digest + ".tar.gz")
    if not filename.exists():
        temporary = cache / (filename.name + ".partial-" + secrets.token_hex(4))
        with temporary.open("xb") as output, gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0) as compressed, tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, value in sorted({**files, "bundle-manifest.json": canonical}.items()):
                info = tarfile.TarInfo(name)
                info.size = len(value); info.mode = 0o444; info.uid = info.gid = 0; info.mtime = 0
                archive.addfile(info, io.BytesIO(value))
        os.replace(temporary, filename)
    return {"ok": True, "action": "prepare", "bundle": str(filename.resolve()), "contentDigest": content_digest,
            "archiveSha256": hashlib.sha256(filename.read_bytes()).hexdigest(), "archiveBytes": filename.stat().st_size,
            "fileCount": len(files), "uncompressedBytes": sum(map(len, files.values())), "dependencies": manifest["dependencies"]}


def remote(action, bundle):
    need(bundle.is_file() and not bundle.is_symlink(), "BUNDLE_FILE_INVALID")
    match = re.fullmatch(r"delivery-center-([a-f0-9]{64})\.tar\.gz", bundle.name)
    need(match is not None, "BUNDLE_NAME_INVALID")
    archive_digest = hashlib.sha256(bundle.read_bytes()).hexdigest()
    bridge = helper()
    sudo_password = bridge.credential_loader()(ROOT / "服务器账号密码.txt")
    client = bridge.connect(bridge.APPLICATION_HOST, "forge", key_filename=str(Path.home() / ".ssh/id_ed25519_forge_delivery"))
    try:
        archive_name = "incoming-" + archive_digest + ".tar.gz"
        destination = PRIVATE_ROOT + "/" + archive_name
        with client.open_sftp() as sftp:
            try:
                existing = sftp.lstat(destination)
                need(stat.S_ISREG(existing.st_mode) and existing.st_size == bundle.stat().st_size, "EXISTING_ARCHIVE_INVALID")
            except FileNotFoundError:
                with sftp.open(destination, "wx") as output, bundle.open("rb") as source:
                    while block := source.read(65536):
                        output.write(block)
                sftp.chmod(destination, 0o600)
        request = {"action": action, "archive": archive_name, "archiveSha256": archive_digest,
                   "contentDigest": match.group(1), "operationId": secrets.token_hex(8)}
        command = shlex.join(["sudo", "-S", "-p", "", "--", "python3", "-c", REMOTE_PROGRAM])
        stdin, stdout, _ = client.exec_command(command, timeout=650)
        stdin.write(sudo_password + "\n" + json.dumps(request)); stdin.flush(); stdin.channel.shutdown_write()
        data, error, code = bridge.bounded_channel(stdout.channel, timeout=650, maximum=4 * 1024 * 1024)
        need(sudo_password.encode() not in data + error, "SECRET_OUTPUT_REJECTED")
        need(code == 0, "REMOTE_OPERATION_PROCESS_FAILED")
        result = json.loads(data)
        result["remoteReceiptPath"] = PRIVATE_ROOT + "/operation-" + request["operationId"] + ".json"
        return result
    finally:
        client.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "import", "verify"])
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.receipt.exists():
        parser.error("Receipt exists; preserve the previous result and choose a new filename.")
    if args.action == "prepare" and (args.cache_dir is None or args.bundle is not None):
        parser.error("prepare requires --cache-dir and does not accept --bundle")
    if args.action != "prepare" and (args.bundle is None or args.cache_dir is not None):
        parser.error("import/verify require --bundle and do not accept --cache-dir")
    started = datetime.now(timezone.utc).isoformat()
    try:
        result = prepare(args.cache_dir) if args.action == "prepare" else remote(args.action, args.bundle)
    except Exception as error:
        value = str(error)
        result = {"ok": False, "action": args.action, "errorCode": value if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z0-9_]+", value) else type(error).__name__}
    result.update({"startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat()})
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    with args.receipt.open("x", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, indent=2); output.write("\n")
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
