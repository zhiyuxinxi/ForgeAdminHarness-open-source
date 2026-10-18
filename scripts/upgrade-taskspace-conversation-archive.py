#!/usr/bin/env python3
"""Upgrade one running TaskSpace's Harness/upload using a frozen, reviewed preimage."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time

TARGET_IMAGE = "sha256:b6262ddb1be854b6559c520a35290a91b3d0f4f2133d28437e46c9cb9b02517a"
TARGET_REF = "forge-delivery/deepseek-harness:0.1.1-rc.2-vpn78-archive-20260915"
UPGRADED_TARGET_IMAGE = "sha256:bdfcb96a42cc3381711dd6d80e657cd84c16729dda0389490ece5dfe1775e6ed"
UPGRADED_TARGET_REF = "forge-delivery/deepseek-harness:0.1.1-rc.2-vpn78-output-download-20260915"
PRIOR_OPERATION = "taskspace-archive-49b5a256a209cdc12d63"
PRIOR_MANIFEST_SHA256 = "49b5a256a209cdc12d6366a9a7b931bd2bed3f21cb7ae977003bc74030d6e948"
PRIOR_RECEIPT_SHA256 = "3b7a1efe140065dffcaf469c5a84efc8cb8f3003d156dc4bfaee52ec1ae58239"
UPGRADED_READER_SESSION = "session-056418e4-0c3c-6efa-e1f2-2c4a5841ba25"
CUTOVER_HELPER = "/opt/forge-delivery-platform/scripts/lib/container-image-cutover.sh"
SCHEMA = "forge-taskspace-output-upgrade/v1"
SERVICES = ("harness", "upload")
FENCE_DESTINATION = "/run/forge-taskspace-maintenance"
ARCHIVE_READER_SHA256 = "41305454d669fab177aca1967d95b71cf51f796be5164ef7e10620084fa3ae09"
ARCHIVE_MODULE_HASHES_JS = r'''
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const modules=['forge-recover-headless-execution.mjs','conversation-output-service.mjs',
 'conversation-output-store.mjs','conversation-output-projection.mjs','conversation-output.js'];
const result={};
for(const name of modules)result[name]=createHash('sha256').update(await readFile('/usr/local/lib/'+name)).digest('hex');
process.stdout.write(JSON.stringify(result));
'''

ARCHIVE_JOB_INPUT_JS = r'''
process.on('uncaughtException',()=>{process.stderr.write('archive job failed\n');process.exit(1)});
process.on('unhandledRejection',()=>{process.stderr.write('archive job failed\n');process.exit(1)});
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
for(const [key,value] of Object.entries(input.environment??{}))process.env[key]=value;
'''

ARCHIVE_BACKFILL_JS = ARCHIVE_JOB_INPUT_JS + r'''
import {readFile} from 'node:fs/promises';
import {createConversationOutputService} from '/usr/local/lib/conversation-output-service.mjs';
const secrets=[];
for(const path of input.secretPaths)secrets.push((await readFile(path,'utf8')).trim());
const service=createConversationOutputService({port:3080,uploadTarget:input.uploadTarget,secrets});
try{
 const result=await service.save(input.sessionId);
 const archive=result?.archive;
 if(result?.ok!==true||archive?.sessionId!==input.sessionId
  ||!/^[a-f0-9]{64}$/.test(archive?.snapshotId??'')||!/^[a-f0-9]{64}$/.test(archive?.eventDigest??'')
  ||!Number.isSafeInteger(archive?.eventCount)||archive.eventCount<1)
  throw Object.assign(new Error('archive save response is invalid'),{code:'ARCHIVE_BACKFILL_RESPONSE_INVALID'});
 process.stdout.write(JSON.stringify({sessionId:archive.sessionId,snapshotId:archive.snapshotId,
  eventDigest:archive.eventDigest,eventCount:archive.eventCount,
  provenance:'explicit-platform-archive-backfill',modelRequests:0}));
}catch(error){
 process.stdout.write(JSON.stringify({sessionId:input.sessionId,failed:true,
  code:/^[A-Z_]+$/.test(error.code??'')?error.code:'ARCHIVE_BACKFILL_FAILED'}));process.exitCode=1;
}finally{service.stop();}
'''


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def validate_stored_backfill_review(value, manifest_sha):
    fields = {"schemaVersion", "manifestSha256", "previousAttemptSha256", "previousFailureSha256",
              "archiveReaderImage", "backfillSession", "storedArchive", "gateway"}
    require(isinstance(value, dict) and set(value) == fields
            and value["schemaVersion"] == "forge-stored-archive-completion/v1"
            and value["manifestSha256"] == manifest_sha, "stored archive review does not bind this manifest")
    archive, gateway = value["storedArchive"], value["gateway"]
    require(isinstance(archive, dict) and set(archive) == {"snapshotId", "manifestSha256", "eventDigest", "eventCount"}
            and type(archive["eventCount"]) is int and archive["eventCount"] > 0,
            "stored archive review requires the sealed source metadata")
    require(isinstance(gateway, dict) and set(gateway) == {"operation", "manifestSha256", "receiptSha256",
            "cutoverRecordSha256", "candidateId", "imageId", "name"}
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,47}", gateway["operation"] or "")
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", gateway["name"] or ""),
            "stored archive review requires the promoted Gateway evidence")
    hashes = [value["previousAttemptSha256"], value["previousFailureSha256"], archive["snapshotId"],
              archive["manifestSha256"], archive["eventDigest"], gateway["manifestSha256"],
              gateway["receiptSha256"], gateway["cutoverRecordSha256"], gateway["candidateId"]]
    require(all(isinstance(item, str) and re.fullmatch(r"[a-f0-9]{64}", item) for item in hashes)
            and all(isinstance(item, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", item)
                    for item in (value["archiveReaderImage"], gateway["imageId"])), "stored archive review digest is invalid")
    return value


def regular_bytes(path):
    path = Path(path)
    require(path.resolve() == path.absolute(), "input path traverses a symbolic link")
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and not path.is_symlink(),
            "input must be a regular unlinked file")
    data = path.read_bytes()
    after = path.lstat()
    require((before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns), "input changed while reading")
    return data


def validate_manifest(value):
    if isinstance(value, dict) and value.get("proxyMaintenanceFence", {}).get("configuredFenceAvailable") is False:
        raise RuntimeError("existing supported TaskSpace maintenance fence is absent; upgrade refused")
    required = {"schemaVersion", "projectSlug", "taskId", "targetImageRef", "targetImageId",
                "containers", "taskEnv", "cutoverHelper", "fence", "protectedFiles",
                "workspaceHead", "workspaceStatusSha256", "sessions"}
    require(isinstance(value, dict) and required <= set(value) <= required | {"legacyMaintenance", "priorArchiveVerification"},
            "unexpected upgrade manifest shape")
    upgraded = (value["targetImageId"], value["targetImageRef"]) == (UPGRADED_TARGET_IMAGE, UPGRADED_TARGET_REF)
    require(value["schemaVersion"] == SCHEMA and (upgraded or
            (value["targetImageId"], value["targetImageRef"]) == (TARGET_IMAGE, TARGET_REF)), "unreviewed schema or target image")
    require(upgraded == ("priorArchiveVerification" in value), "the upgraded target requires its prior archive verification")
    if upgraded:
        require(value["projectSlug"] == "forge-base" and value["taskId"] == "legacy-history-20260827"
                and "legacyMaintenance" not in value and value["fence"].get("exists") is True,
                "the upgraded target requires the existing shared TaskSpace fence without legacy maintenance")
        prior = value["priorArchiveVerification"]
        require(isinstance(prior, dict) and set(prior) == {"manifest", "receipt"}, "prior archive bindings are incomplete")
        for key, name in (("manifest", "manifest.json"), ("receipt", "stored-archive-completion.json")):
            item = prior[key]
            require(isinstance(item, dict) and set(item) == {"path", "sha256"}
                    and item["path"] == f"/srv/forge-delivery/platform-backups/{PRIOR_OPERATION}/{name}"
                    and isinstance(item["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]),
                    "prior archive binding is outside the completed operation")
        require(prior["receipt"]["sha256"] == PRIOR_RECEIPT_SHA256, "prior archive receipt is not the verified completion")
    for field in ("projectSlug", "taskId"):
        require(isinstance(value[field], str) and re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", value[field]),
                "invalid project or TaskSpace identity")
    root = f'/srv/forge-delivery/projects/{value["projectSlug"]}/taskspaces/{value["taskId"]}'
    require(set(value["containers"]) == set(SERVICES), "exactly Harness/upload must be frozen")
    for service in SERVICES:
        item = value["containers"][service]
        require(set(item) == {"originalId", "sourceImageId", "name"}, "incomplete container preimage")
        require(re.fullmatch(r"[a-f0-9]{64}", item["originalId"] or "")
                and re.fullmatch(r"sha256:[a-f0-9]{64}", item["sourceImageId"] or "")
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", item["name"] or ""),
                "invalid container preimage")
        require(not upgraded or item["sourceImageId"] == TARGET_IMAGE, "the upgraded target requires the current archive image")
    require(value["containers"]["harness"]["originalId"] != value["containers"]["upload"]["originalId"],
            "Harness/upload identities must be distinct")
    expected_files = {root + "/metadata.json", root + "/compose.network.override.yaml"}
    require(isinstance(value["protectedFiles"], list)
            and {item["path"] for item in value["protectedFiles"]} == expected_files
            and len(value["protectedFiles"]) == 2, "metadata and network override preimages are required")
    require(next(item for item in value["protectedFiles"] if item["path"] == root + "/metadata.json").get("exists") is True,
            "TaskSpace metadata must exist")
    for item in [value["taskEnv"], value["fence"], value["cutoverHelper"], *value["protectedFiles"]]:
        require(isinstance(item, dict) and item.get("exists") in (True, False), "file existence must be frozen")
        if item["exists"]:
            require(re.fullmatch(r"[a-f0-9]{64}", item.get("sha256") or "")
                    and all(type(item.get(k)) is int and item[k] >= 0 for k in ("mode", "uid", "gid")),
                    "file hash, mode and ownership must be frozen")
        else:
            require(item.get("sha256") is None, "missing file cannot have a digest")
    require(value["taskEnv"]["path"] == root + "/task.env" and value["taskEnv"]["exists"]
            and isinstance(value["taskEnv"].get("harnessImage"), str), "TaskSpace env binding is incomplete")
    require(value["fence"]["path"] == root + "/maintenance/proxy-fence.json", "unexpected fence path")
    require(value["cutoverHelper"]["path"] == CUTOVER_HELPER and value["cutoverHelper"]["exists"],
            "unexpected cutover helper")
    if "legacyMaintenance" in value:
        legacy = value["legacyMaintenance"]
        require(isinstance(legacy, dict) and set(legacy) == {"metadataSchemaVersion", "gateway", "gatewayFence"}
                and legacy["metadataSchemaVersion"] == 1,
                "legacy maintenance requires schema-v1 metadata and a frozen local fence preimage")
        gateway = legacy["gateway"]
        require(set(gateway) == {"originalId", "sourceImageId", "name"}
                and re.fullmatch(r"[a-f0-9]{64}", gateway["originalId"] or "")
                and re.fullmatch(r"sha256:[a-f0-9]{64}", gateway["sourceImageId"] or "")
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}", gateway["name"] or ""),
                "legacy Gateway identity is incomplete")
        fence = legacy["gatewayFence"]
        require(set(fence) == {"path", "exists", "sha256", "mode", "uid", "gid"}
                and fence["path"] == "/srv/forge-delivery/conversation-control-plane/maintenance/gateway-fence.json"
                and fence["exists"] is True and re.fullmatch(r"[a-f0-9]{64}", fence["sha256"] or "")
                and all(type(fence[k]) is int and fence[k] >= 0 for k in ("mode", "uid", "gid")),
                "legacy Gateway fence preimage is incomplete")
    require(re.fullmatch(r"[a-f0-9]{40}", value["workspaceHead"] or "")
            and re.fullmatch(r"[a-f0-9]{64}", value["workspaceStatusSha256"] or ""),
            "workspace identity is incomplete")
    require(isinstance(value["sessions"], list), "original session list is required")
    ids = []
    for session in value["sessions"]:
        require(set(session) == {"sessionId", "cwd", "blank", "running", "updatedAt"}
                and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", session["sessionId"] or "")
                and session["cwd"] == "/workspace" and type(session["blank"]) is bool
                and session["running"] is False and type(session["updatedAt"]) is int and session["updatedAt"] >= 0,
                "only frozen idle /workspace sessions are supported")
        ids.append(session["sessionId"])
    require(len(ids) == len(set(ids)), "duplicate session identity")
    return value


def file_binding(item):
    path = Path(item["path"])
    if not item["exists"]:
        require(not os.path.lexists(path), "an absent protected file appeared")
        return
    data = regular_bytes(path)
    info = path.lstat()
    require(digest(data) == item["sha256"]
            and (stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid) ==
            (item["mode"], item["uid"], item["gid"]), "frozen file bytes or ownership changed")


def environment_delta(data, source, target):
    lines = data.splitlines(keepends=True)
    hits = [i for i, line in enumerate(lines) if line.startswith(b"HARNESS_IMAGE=")]
    require(len(hits) == 1, "HARNESS_IMAGE must occur exactly once")
    index = hits[0]
    body = lines[index].rstrip(b"\r\n")
    require(body == ("HARNESS_IMAGE=" + source).encode(), "HARNESS_IMAGE source changed")
    lines[index] = ("HARNESS_IMAGE=" + target).encode() + lines[index][len(body):]
    return b"".join(lines)


def atomic_replace(path, data, before):
    """Preserve POSIX metadata; leave the temporary file as evidence on failure."""
    path = Path(path)
    require(regular_bytes(path) == before, "atomic update preimage changed")
    info = path.lstat()
    fd, temporary = tempfile.mkstemp(prefix=".archive-upgrade-", dir=path.parent)
    with os.fdopen(fd, "wb") as stream:
        os.fchmod(stream.fileno(), stat.S_IMODE(info.st_mode))
        os.fchown(stream.fileno(), info.st_uid, info.st_gid)
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    require(regular_bytes(path) == before, "atomic update preimage changed before replace")
    os.replace(temporary, path)
    if os.name != "nt":
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)


def normalize_host(value):
    value = copy.deepcopy(value)
    value["OomKillDisable"] = value.get("OomKillDisable") or False
    mounts = value.get("Mounts") or []
    for mount in mounts:
        if mount["Type"] == "bind":
            options = mount.setdefault("BindOptions", {})
            options["ReadOnlyNonRecursive"] = options.get("ReadOnlyNonRecursive") or False
    value["Mounts"] = sorted(mounts, key=lambda item: item["Target"])
    return value


def runtime_template_request(original, source_labels, target_labels, maintenance_root, target_environment=()):
    """A never-started template; the cutover helper restores the original networks."""
    config = copy.deepcopy(original["Config"])
    if maintenance_root is not None:
        require(not any(entry.startswith("HARNESS_MAINTENANCE_FENCE_FILE=") for entry in config["Env"]),
                "legacy source already configures a maintenance fence")
    original_keys = {entry.split("=", 1)[0] for entry in config["Env"]}
    defaults = [entry for entry in target_environment if entry.split("=", 1)[0] not in original_keys]
    require({entry.split("=", 1)[0] for entry in defaults} <= {"NODE_PATH"},
            "target image has unreviewed additional environment defaults")
    config["Env"].extend(defaults)
    if maintenance_root is not None:
        config["Env"].append("HARNESS_MAINTENANCE_FENCE_FILE=" + FENCE_DESTINATION + "/proxy-fence.json")
    config["Image"] = TARGET_IMAGE
    if config.get("Hostname") == original["Id"][:12]:
        config["Hostname"] = ""
    config["Domainname"] = config.get("Domainname") or ""
    overrides = {key: value for key, value in (config.get("Labels") or {}).items()
                 if key not in source_labels or source_labels[key] != value}
    config["Labels"] = {**target_labels, **overrides}
    host = copy.deepcopy(original["HostConfig"])
    require(not host.get("AutoRemove") and not host.get("ContainerIDFile") and not host.get("Links"),
            "legacy template cannot preserve auto-removal, container-ID file or legacy links")
    host["NetworkMode"] = "none"
    if maintenance_root is not None:
        mount = {"Type": "bind", "Source": str(maintenance_root), "Target": FENCE_DESTINATION,
                 "ReadOnly": True, "BindOptions": {"Propagation": "rprivate"}}
        require(not any(item.get("Target") == FENCE_DESTINATION for item in host.get("Mounts") or []),
                "legacy host mount already targets the maintenance directory")
        host["Mounts"] = [*(host.get("Mounts") or []), mount]
    return {**config, "HostConfig": host, "NetworkingConfig": {"EndpointsConfig": {}}}


def verify_runtime_template(original, template, request):
    expected_config = {key: value for key, value in request.items() if key not in ("HostConfig", "NetworkingConfig")}
    if expected_config["Hostname"] == "":
        expected_config["Hostname"] = template["Id"][:12]
    require(template["State"]["Status"] == "created" and template["Image"] == TARGET_IMAGE
            and template["Config"] == expected_config, "runtime template Config drifted or was started")
    require(normalize_host(template["HostConfig"]) == normalize_host(request["HostConfig"]),
            "runtime template HostConfig drifted beyond the maintenance bind and isolated network")
    original_mounts = sorted(original["Mounts"], key=lambda item: item["Destination"])
    maintenance = [item for item in request["HostConfig"].get("Mounts") or [] if item["Target"] == FENCE_DESTINATION]
    existing_maintenance = any(item["Destination"] == FENCE_DESTINATION for item in original_mounts)
    if existing_maintenance or not maintenance:
        require(sorted(template["Mounts"], key=lambda item: item["Destination"]) == original_mounts,
                "upload runtime template changed the original mounts")
        return
    retained_mounts = sorted([item for item in template["Mounts"] if item["Destination"] != FENCE_DESTINATION],
                            key=lambda item: item["Destination"])
    added = [item for item in template["Mounts"] if item["Destination"] == FENCE_DESTINATION]
    require(retained_mounts == original_mounts and len(maintenance) == 1 and len(added) == 1
            and maintenance[0]["Type"] == "bind" and maintenance[0].get("ReadOnly") is True
            and added[0]["RW"] is False and added[0]["Source"] == maintenance[0]["Source"]
            and added[0]["Type"] == "bind", "runtime template changed the source/session mounts")


SESSION_LIST_JS = r'''
const rpcId=crypto.randomUUID();
const response=await fetch('http://127.0.0.1:3080/api/session.list',{
 method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(10000),
 body:JSON.stringify({type:'client-request',rpcId,method:'session.list',payload:{}})});
const value=await response.json();
if(!response.ok||value.rpcId!==rpcId||!Array.isArray(value?.result?.value?.items))throw Error('session list unavailable');
process.stdout.write(JSON.stringify(value.result.value.items.map(({sessionId,cwd,blank,running,updatedAt})=>({sessionId,cwd,blank,running,updatedAt}))));
'''

HEALTH_JS = r'''
const p=process.argv[1]==='harness'?process.env.HARNESS_PORT:process.argv[1]==='upload'?3090:3080;
const pathname=process.argv[1]==='harness'?'/forge-maintenance/healthz':'/healthz';
const r=await fetch(`http://127.0.0.1:${p}${pathname}`,{signal:AbortSignal.timeout(10000)});
process.stdout.write(JSON.stringify({status:r.status,body:await r.json()}));
'''

ARCHIVE_SOURCE_DIGEST_JS = r'''
function sourceEventDigest(events){
 const digest=createHash('sha256');digest.update('[');
 for(let index=0;index<events.length;index++){
  if(index!==0)digest.update(',');
  digest.update(JSON.stringify(events[index]));
 }
 return digest.update(']').digest('hex');
}
async function readSourceDigest(session){
 const history=await readPinnedDshConversationHistory({port:3080,sessionId:session.sessionId});
 if(history.session.running||history.session.updatedAt!==session.updatedAt)throw Error('source session changed');
 return {eventDigest:sourceEventDigest(history.events),eventCount:history.events.length};
}
'''

ARCHIVES_JS = ARCHIVE_SOURCE_DIGEST_JS + r'''
import {readPinnedDshConversationHistory} from '/usr/local/lib/forge-recover-headless-execution.mjs';
import {createConversationOutputStore} from '/usr/local/lib/conversation-output-store.mjs';
import {createHash} from 'node:crypto';
const expected=JSON.parse(process.argv[1]);
const scope={scopeType:'taskspace-private',projectSlug:process.env.PROJECT_SLUG,
 taskspaceId:process.env.FORGE_TASKSPACE_ID,actorId:process.env.FORGE_TASKSPACE_ACTOR_ID,
 conversationId:process.env.FORGE_TASKSPACE_CONVERSATION_ID};
const store=createConversationOutputStore({root:'/project-inputs',scope});
const verified=[];
const missing=[];
for(const session of expected.filter(x=>!x.blank)){
 try{
 const page=await store.list({sessionId:session.sessionId,limit:100});
 if(process.argv[2]==='index'){
  if(page.items.length===0)missing.push({sessionId:session.sessionId,code:'ARCHIVE_PENDING'});
  continue;
 }
 const source=await readSourceDigest(session);
 let matched;
 for(const snapshot of page.items){
  const file=await store.read({sessionId:session.sessionId,snapshotId:snapshot.snapshotId,name:'manifest.json'});
  const manifest=JSON.parse(file.buffer);
  if(manifest.eventDigest===source.eventDigest&&manifest.eventCount===source.eventCount){matched=snapshot.snapshotId;break;}
 }
 if(!matched){missing.push({sessionId:session.sessionId,code:'SOURCE_ARCHIVE_MISMATCH'});continue;}
 verified.push({sessionId:session.sessionId,snapshotId:matched,...source});
 }catch(error){missing.push({sessionId:session.sessionId,code:/^[A-Z_]+$/.test(error.code??'')?error.code:'ARCHIVE_READ_FAILED'});}
}
process.stdout.write(JSON.stringify({items:verified,missing}));
'''

UPGRADED_READER_JS = ARCHIVE_SOURCE_DIGEST_JS + r'''
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {readPinnedDshConversationHistory} from '/usr/local/lib/forge-recover-headless-execution.mjs';
const readerSha256=createHash('sha256').update(await readFile('/usr/local/lib/forge-recover-headless-execution.mjs')).digest('hex');
if(readerSha256!==process.argv[3])throw Error('upgraded reader bytes differ');
const result={readerSha256};
if(process.argv[2]==='source')Object.assign(result,await readSourceDigest(JSON.parse(process.argv[1])));
process.stdout.write(JSON.stringify(result));
'''


class Upgrade:
    @property
    def target_image(self):
        return self.manifest.get("targetImageId", TARGET_IMAGE)

    @property
    def target_ref(self):
        return self.manifest.get("targetImageRef", TARGET_REF)

    def __init__(self, manifest, manifest_sha, archive_reader_image=None, backfill_session=None,
                 stored_backfill_review=None, stored_backfill_review_sha=None, stored_source_failure_sha=None):
        self.manifest = validate_manifest(manifest)
        self.manifest_sha = manifest_sha
        self.task_root = Path(manifest["taskEnv"]["path"]).parent
        self.operation = "taskspace-archive-" + manifest_sha[:20]
        self.backup = Path("/srv/forge-delivery/platform-backups") / self.operation
        self.records = self.backup / "cutover"
        self.legacy = manifest.get("legacyMaintenance")
        self.archive_reader_image = archive_reader_image
        self.backfill_session = backfill_session
        self.stored_review = None
        self.stored_review_bytes = None
        self.stored_review_sha = None
        self.stored_source_failure_sha = stored_source_failure_sha
        require(stored_source_failure_sha is None or (stored_backfill_review is not None
                and re.fullmatch(r"[a-f0-9]{64}", stored_source_failure_sha)),
                "stored source failure requires the frozen stored archive review and a digest")
        require((stored_backfill_review is None) == (stored_backfill_review_sha is None),
                "stored archive review and digest must be paired")
        if stored_backfill_review is not None:
            self.bind_stored_review(stored_backfill_review, stored_backfill_review_sha)
        require((archive_reader_image is None) == (backfill_session is None), "archive reader image and backfill session must be paired")
        if archive_reader_image is not None:
            require(self.legacy and re.fullmatch(r"sha256:[a-f0-9]{64}", archive_reader_image)
                    and any(item["sessionId"] == backfill_session and not item["blank"] for item in manifest["sessions"]),
                    "backfill requires an immutable image and one frozen nonblank session")

    def bind_stored_review(self, data, sha256):
        require(re.fullmatch(r"[a-f0-9]{64}", sha256 or "") and digest(data) == sha256,
                "frozen stored archive review digest changed")
        review = validate_stored_backfill_review(json.loads(data), self.manifest_sha)
        require(self.legacy and getattr(self, "archive_reader_image", None) in (None, review["archiveReaderImage"])
                and getattr(self, "backfill_session", None) in (None, review["backfillSession"])
                and any(item["sessionId"] == review["backfillSession"] and not item["blank"]
                        for item in self.manifest["sessions"]), "stored archive review reader or session differs")
        self.stored_review, self.stored_review_bytes, self.stored_review_sha = review, data, sha256
        self.archive_reader_image, self.backfill_session = review["archiveReaderImage"], review["backfillSession"]

    def verify_stored_backfill(self):
        review = self.stored_review
        attempt = regular_bytes(self.backup / "focused-completion-attempt.json")
        failure = regular_bytes(self.backup / "focused-completion-failure.json")
        require(digest(attempt) == review["previousAttemptSha256"] and digest(failure) == review["previousFailureSha256"],
                "reviewed backfill attempt or failure changed")
        previous, failed = json.loads(attempt), json.loads(failure)
        require(previous.get("manifestSha256") == self.manifest_sha
                and previous.get("archiveReaderImage") == self.archive_reader_image
                and previous.get("backfillSession") == self.backfill_session
                and previous.get("archiveReaderModules", {}).get("forge-recover-headless-execution.mjs") == ARCHIVE_READER_SHA256
                and failed.get("status") == "failed" and failed.get("stage") == "explicit-archive-backfill"
                and failed.get("manifestSha256") == self.manifest_sha
                and failed.get("automaticRollback") is False and failed.get("originalFailurePreserved") is True,
                "stored archive review is outside the failed backfill response point")
        require(not (self.backup / "explicit-archive-backfill.json").exists(), "backfill already has a different success receipt")
        expected = review["storedArchive"]
        sealed = regular_bytes(self.task_root / "uploads" / "outputs" / self.backfill_session / expected["snapshotId"] / "manifest.json")
        archive = json.loads(sealed)
        require(digest(sealed) == expected["manifestSha256"] and archive.get("sessionId") == self.backfill_session
                and all(archive.get(key) == expected[key] for key in ("snapshotId", "eventDigest", "eventCount")),
                "reviewed sealed backfill archive changed")
        return previous

    def verify_stored_source_failure(self):
        failure_bytes = regular_bytes(self.backup / "stored-archive-failure.json")
        require(digest(failure_bytes) == self.stored_source_failure_sha
                and regular_bytes(self.backup / "stored-archive-review.json") == self.stored_review_bytes,
                "reviewed stored source failure or original review changed")
        failure = json.loads(failure_bytes)
        require(failure.get("status") == "failed" and failure.get("stage") == "stored-archive-source-verification"
                and failure.get("manifestSha256") == self.manifest_sha
                and failure.get("automaticRollback") is False and failure.get("originalFailurePreserved") is True,
                "stored source failure is outside the reviewed repair point")
        return json.loads(regular_bytes(self.backup / "stored-archive-attempt.json"))

    def run(self, argv, timeout=60):
        result = subprocess.run(argv, capture_output=True, timeout=timeout)
        require(result.returncode == 0, f"{Path(argv[0]).name} command failed (exit {result.returncode})")
        return result.stdout

    def docker(self, *argv):
        return self.run(["docker", "--host", "unix:///var/run/docker.sock", *argv])

    def inspect(self, container):
        return json.loads(self.docker("inspect", "--type", "container", container))[0]

    def node(self, container, script, *args):
        return json.loads(self.docker("exec", container, "node", "--input-type=module", "-e", script, *args))

    def archive_job(self, suffix, script, payload=None, *, network_harness=None, mounts=(), user=None):
        require(self.archive_reader_image is not None, "fixed archive reader image is not bound")
        command = ["docker", "--host", "unix:///var/run/docker.sock", "run", "--rm", "--pull", "never",
                   "--name", "forge-archive-" + suffix + "-" + self.operation,
                   "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                   "--pids-limit", "128", "--memory", "1g", "--cpus", "1", "--log-driver", "none",
                   "--network", "none" if network_harness is None else "container:" + network_harness,
                   "--entrypoint", "node"]
        if user:
            command.extend(["--user", user])
        for source, destination in mounts:
            require("," not in source and "," not in destination, "archive job bind path contains unsupported delimiter")
            command.extend(["--mount", f"type=bind,src={source},dst={destination},readonly"])
        command.extend(["-i", self.archive_reader_image, "--input-type=module", "-e", script])
        encoded = json.dumps(payload or {}).encode()
        result = subprocess.run(command, input=encoded, capture_output=True, timeout=300)
        token = (payload or {}).get("uploadTarget", {}).get("token")
        require(not token or token.encode() not in result.stdout + result.stderr, "archive job returned credential material")
        if result.returncode != 0:
            try:
                failure = json.loads(result.stdout)
            except (ValueError, UnicodeDecodeError):
                failure = {}
            code = failure.get("code", "ARCHIVE_JOB_FAILED")
            code = code if isinstance(code, str) and re.fullmatch(r"[A-Z_]{1,80}", code) else "ARCHIVE_JOB_FAILED"
            raise RuntimeError(f"fixed-image archive {suffix} job failed: {code}; exit={result.returncode}; session={getattr(self, 'backfill_session', None)}")
        return json.loads(result.stdout)

    def verify_archive_reader_image(self):
        require(self.docker("image", "inspect", "-f", "{{.Id}}", self.archive_reader_image).decode().strip() == self.archive_reader_image,
                "fixed archive reader image is unavailable")
        candidate = self.candidates()["harness"]["candidate"]["id"]
        current = self.node(candidate, ARCHIVE_MODULE_HASHES_JS)
        fixed = self.archive_job("reader-inspect", ARCHIVE_MODULE_HASHES_JS)
        reader = "forge-recover-headless-execution.mjs"
        require(fixed.get(reader) == ARCHIVE_READER_SHA256 and set(fixed) == set(current)
                and all(fixed[name] == current[name] for name in fixed if name != reader),
                "fixed image does not contain the reviewed reader and unchanged archive modules")
        return fixed

    def verify_single_missing_archive(self):
        harness = self.candidates()["harness"]["candidate"]["id"]
        index = self.node(harness, ARCHIVES_JS, json.dumps(self.manifest["sessions"], separators=(",", ":")), "index")
        require(index["missing"] == [{"sessionId": self.backfill_session, "code": "ARCHIVE_PENDING"}],
                "prepared backfill must target the single missing original session")

    def backfill_archive(self):
        harness_id = self.candidates()["harness"]["candidate"]["id"]
        harness = self.inspect(harness_id)
        env = dict(entry.split("=", 1) for entry in harness["Config"]["Env"])
        secret_mounts = []
        access_file = env.get("HARNESS_ACCESS_TOKEN_FILE") if env.get("HARNESS_ACCESS_MODE") == "token" else None
        for mount in harness["Mounts"]:
            destination = mount["Destination"]
            if destination.startswith("/run/secrets/") or destination == access_file:
                require(mount.get("Type") == "bind" and mount.get("RW") is False,
                        "archive redaction secret must use the original readonly file bind")
                regular_bytes(mount["Source"])
                secret_mounts.append((mount["Source"], destination))
        require(secret_mounts and len(env.get("HARNESS_UPLOAD_TOKEN", "")) >= 32,
                "original archive upload capability or redaction secret bindings are incomplete")
        payload = {"sessionId": self.backfill_session, "secretPaths": [destination for _, destination in secret_mounts],
                   "uploadTarget": {"host": env["HARNESS_UPLOAD_HOST"], "port": int(env["HARNESS_UPLOAD_PORT"]),
                                    "token": env["HARNESS_UPLOAD_TOKEN"]}}
        result = self.archive_job("backfill", ARCHIVE_BACKFILL_JS, payload, network_harness=harness_id,
                                  mounts=secret_mounts, user=harness["Config"].get("User"))
        require(result.get("sessionId") == self.backfill_session and re.fullmatch(r"[a-f0-9]{64}", result.get("snapshotId", ""))
                and result.get("provenance") == "explicit-platform-archive-backfill", "archive save result is incomplete")
        self.write_evidence("explicit-archive-backfill.json", json.dumps({"readerImageId": self.archive_reader_image,
                            "readerSha256": ARCHIVE_READER_SHA256, "originalBusinessProvenancePreserved": True, **result}).encode())

    def sessions(self, container, wait_ready=False):
        actual = self.wait_for("native session.list readiness", lambda: self.node(container, SESSION_LIST_JS), 120) \
            if wait_ready else self.node(container, SESSION_LIST_JS)
        # Availability may lag the proxy. Once a list is returned, drift is final;
        # never wait for conflicting business/session contents to become equal.
        require(sorted(actual, key=lambda item: item["sessionId"]) ==
                sorted(self.manifest["sessions"], key=lambda item: item["sessionId"]),
                "original session IDs, idle state or metadata changed")

    def source_preserved(self):
        workspace = str(self.task_root / "workspace")
        require(self.run(["git", "-C", workspace, "rev-parse", "HEAD"]).decode().strip() == self.manifest["workspaceHead"],
                "workspace HEAD changed")
        require(digest(self.run(["git", "-C", workspace, "status", "--porcelain=v1", "-z", "--untracked-files=all"])) ==
                self.manifest["workspaceStatusSha256"], "workspace dirty-state changed")
        for item in self.manifest["protectedFiles"]:
            file_binding(item)

    def prior_archives(self):
        prior = self.manifest["priorArchiveVerification"]
        documents = {}
        for key in ("manifest", "receipt"):
            data = regular_bytes(prior[key]["path"])
            require(digest(data) == prior[key]["sha256"], "prior archive evidence bytes changed")
            documents[key] = json.loads(data)
        previous, receipt = documents["manifest"], documents["receipt"]
        validate_manifest(previous)
        require(previous["targetImageId"] == TARGET_IMAGE
                and all(previous[key] == self.manifest[key] == receipt.get(key) for key in ("projectSlug", "taskId"))
                and receipt.get("status") == "success" and receipt.get("operation") == PRIOR_OPERATION
                and receipt.get("manifestSha256") == PRIOR_MANIFEST_SHA256 and receipt.get("targetImageId") == TARGET_IMAGE
                and receipt.get("sourceArchivesVerifiedBeforeCompletion") == 40
                and receipt.get("completionMode") == "complete-prepared-stored-archive"
                and all(receipt.get("preparedCandidates", {}).get(service, {}).get("candidateId") ==
                        self.manifest["containers"][service]["originalId"] for service in SERVICES),
                "prior archive completion does not bind the shared TaskSpace source")
        ordered = lambda items: sorted(items, key=lambda item: item["sessionId"])
        require(ordered(previous["sessions"]) == ordered(self.manifest["sessions"]),
                "prior verified session metadata differs from the current preimage")
        archives = receipt.get("archives")
        expected_ids = {item["sessionId"] for item in self.manifest["sessions"] if not item["blank"]}
        require(isinstance(archives, list) and len(archives) == len(expected_ids) == 40
                and {item.get("sessionId") for item in archives} == expected_ids,
                "prior archive completion does not contain exactly the original 40 sources")
        for item in archives:
            require(set(item) == {"sessionId", "snapshotId", "eventDigest", "eventCount"}
                    and all(isinstance(item[key], str) and re.fullmatch(r"[a-f0-9]{64}", item[key])
                            for key in ("snapshotId", "eventDigest"))
                    and type(item["eventCount"]) is int and item["eventCount"] > 0,
                    "prior archive identity is incomplete")
            sealed = json.loads(regular_bytes(self.task_root / "uploads" / "outputs" / item["sessionId"]
                                              / item["snapshotId"] / "manifest.json"))
            require(sealed.get("schemaVersion") == "forge-conversation-output-manifest/v1"
                    and all(sealed.get(key) == value for key, value in item.items())
                    and sealed.get("scope", {}).get("projectSlug") == self.manifest["projectSlug"]
                    and sealed.get("scope", {}).get("taskspaceId") == self.manifest["taskId"],
                    "a prior verified archive snapshot changed")
        return archives

    def upgraded_reader_verification(self, archives, read_once=False):
        harness = self.candidates()["harness"]["candidate"]["id"]
        actual = self.inspect(harness)
        require(actual["Id"] == harness and actual["Image"] == self.target_image,
                "reader verification is outside the upgraded Harness")
        session = next(item for item in self.manifest["sessions"] if item["sessionId"] == UPGRADED_READER_SESSION)
        archive = next(item for item in archives if item["sessionId"] == UPGRADED_READER_SESSION)
        expected = {"status": "success", "manifestSha256": self.manifest_sha, "containerId": harness,
                    "targetImageId": self.target_image, "readerSha256": ARCHIVE_READER_SHA256,
                    "session": session, "archive": archive, "priorArchiveVerification": self.manifest["priorArchiveVerification"],
                    "actualReaderHistoriesVerified": 1, "sourceArchivesReused": 40, "operatorModelRequests": 0,
                    "archiveSaveInvoked": False}
        path = self.backup / "upgraded-reader-verification.json"
        if read_once:
            require(not os.path.lexists(path), "an actual reader verification already exists; do not repeat history reads")
            result = self.node(harness, UPGRADED_READER_JS, json.dumps(session, separators=(",", ":")),
                               "source", ARCHIVE_READER_SHA256)
            require(result == {"readerSha256": ARCHIVE_READER_SHA256,
                               "eventDigest": archive["eventDigest"], "eventCount": archive["eventCount"]},
                    "the upgraded actual reader differs from the prior verified source")
            self.write_evidence(path.name, json.dumps(expected, sort_keys=True).encode())
        else:
            require(json.loads(regular_bytes(path)) == expected, "saved actual reader verification binding changed")
            result = self.node(harness, UPGRADED_READER_JS, "{}", "identity", ARCHIVE_READER_SHA256)
            require(result == {"readerSha256": ARCHIVE_READER_SHA256}, "upgraded actual reader bytes changed")
        return digest(regular_bytes(path))

    def gateway_preserved(self):
        gateway = self.legacy["gateway"]
        identity = gateway
        if getattr(self, "stored_review", None):
            current = self.stored_review["gateway"]
            backup = Path("/srv/forge-delivery/platform-backups") / current["operation"]
            receipt_bytes = regular_bytes(backup / "receipt.json")
            record_bytes = regular_bytes(backup / "cutover" / "archive-gateway.json")
            require(digest(receipt_bytes) == current["receiptSha256"]
                    and digest(record_bytes) == current["cutoverRecordSha256"], "reviewed Gateway promotion evidence changed")
            receipt, record = json.loads(receipt_bytes), json.loads(record_bytes)
            require(receipt.get("status") == "success" and receipt.get("operation") == current["operation"]
                    and receipt.get("manifestSha256") == current["manifestSha256"]
                    and receipt.get("targetImageId") == current["imageId"]
                    and receipt.get("originalContainersRetained") is True and receipt.get("originalFencesRestored") is True
                    and record.get("promotionState") == "promoted" and record.get("promoted") is True
                    and record.get("targetImageId") == current["imageId"]
                    and record.get("original", {}).get("fullId") == gateway["originalId"]
                    and record["original"].get("name") == gateway["name"]
                    and record.get("candidate", {}).get("id") == current["candidateId"]
                    and current["name"] == gateway["name"], "Gateway promotion does not descend from the original Gateway")
            retained = self.inspect(gateway["originalId"])
            require(retained["Id"] == gateway["originalId"] and retained["Image"] == gateway["sourceImageId"]
                    and retained["State"]["Status"] == "exited" and retained["Name"] == "/" + record["rollbackName"],
                    "original Gateway rollback container is not retained")
            identity = {"originalId": current["candidateId"], "sourceImageId": current["imageId"], "name": current["name"]}
        actual = self.inspect(identity["originalId"])
        require(actual["Id"] == identity["originalId"] and actual["Image"] == identity["sourceImageId"]
                and actual["Name"] == "/" + identity["name"] and actual["State"]["Status"] == "running",
                "legacy maintenance Gateway identity changed")
        env = dict(entry.split("=", 1) for entry in actual["Config"]["Env"])
        require(env.get("CONVERSATION_GATEWAY_MAINTENANCE_FENCE_FILE") == "/run/forge-maintenance/gateway-fence.json"
                and any(mount.get("Source") == str(Path(self.legacy["gatewayFence"]["path"]).parent)
                        and mount.get("Destination") == "/run/forge-maintenance" and mount.get("RW") is False
                        for mount in actual["Mounts"]), "Gateway maintenance fence is not bound")
        if getattr(self, "stored_review", None):
            file_binding(self.legacy["gatewayFence"])
            health = self.node(actual["Id"], HEALTH_JS, "gateway")
            require(health.get("status") == 200 and health.get("body", {}).get("status") == "open",
                    "reviewed promoted Gateway endpoint is not open")
        return actual["Id"]

    def legacy_preflight(self):
        metadata = json.loads(regular_bytes(self.task_root / "metadata.json"))
        require(metadata.get("schemaVersion") == 1 and metadata.get("projectSlug") == self.manifest["projectSlug"]
                and metadata.get("taskId") == self.manifest["taskId"], "legacy schema-v1 metadata binding changed")
        self.gateway_preserved()
        file_binding(self.legacy["gatewayFence"])
        fence = json.loads(regular_bytes(self.legacy["gatewayFence"]["path"]))
        require(fence.get("schemaVersion") == 1 and fence.get("state") == "committed", "Gateway fence is not committed")
        health = self.node(self.legacy["gateway"]["originalId"], HEALTH_JS, "gateway")
        require(health.get("status") == 200 and health.get("body", {}).get("status") == "open",
                "Gateway maintenance endpoint is unavailable")
        if self.manifest["fence"]["exists"]:
            local = json.loads(regular_bytes(self.manifest["fence"]["path"]))
            require(set(local) == {"schemaVersion", "state", "epoch"} and local["schemaVersion"] == 1
                    and local["state"] == "committed" and isinstance(local["epoch"], str)
                    and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", local["epoch"]),
                    "existing unbound legacy fence is not a valid committed preimage")

    def prepare_legacy_fence(self):
        fence = Path(self.manifest["fence"]["path"])
        if self.manifest["fence"]["exists"]:
            file_binding(self.manifest["fence"])
            data = regular_bytes(fence)
        else:
            require(not os.path.lexists(fence), "legacy fence appeared after preflight")
            parent = fence.parent
            require(parent.resolve() == parent.absolute() and not parent.is_symlink(), "legacy maintenance directory is unsafe")
            if not parent.exists():
                parent.mkdir(mode=0o750)
                os.chown(parent, self.manifest["taskEnv"]["uid"], self.manifest["taskEnv"]["gid"])
            require(parent.is_dir(), "legacy maintenance path is not a directory")
            data = json.dumps({"schemaVersion": 1, "state": "committed", "epoch": self.operation + "-initial"}).encode()
            with fence.open("xb") as stream:
                os.fchmod(stream.fileno(), 0o640)
                os.fchown(stream.fileno(), self.manifest["taskEnv"]["uid"], self.manifest["taskEnv"]["gid"])
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
        info = fence.lstat()
        binding = {"path": str(fence), "exists": True, "sha256": digest(regular_bytes(fence)),
                   "mode": stat.S_IMODE(info.st_mode), "uid": info.st_uid, "gid": info.st_gid}
        self.write_evidence("fence.before", data)
        self.write_evidence("local-fence-baseline.json", json.dumps(binding, sort_keys=True).encode())
        return data

    def create_runtime_template(self, service):
        original_id = self.manifest["containers"][service]["originalId"]
        original = self.inspect(original_id)
        source_labels = json.loads(self.docker("image", "inspect", "-f", "{{json .Config.Labels}}", original["Image"])) or {}
        target_config = json.loads(self.docker("image", "inspect", TARGET_IMAGE))[0]["Config"]
        request = runtime_template_request(original, source_labels, target_config.get("Labels") or {},
                                           self.task_root / "maintenance" if service == "harness" else None,
                                           target_config.get("Env") or [])
        original_keys = {entry.split("=", 1)[0] for entry in original["Config"]["Env"]}
        added_default_keys = sorted({entry.split("=", 1)[0] for entry in target_config.get("Env") or []} - original_keys)
        version = json.loads(self.run(["curl", "--fail", "--silent", "--show-error", "--unix-socket", "/var/run/docker.sock",
                                       "http://localhost/version"]))["ApiVersion"]
        require(re.fullmatch(r"1\.[0-9]+", version) and int(version.split(".")[1]) >= 41, "unsupported Docker API version")
        name = "forge-template-" + self.operation + "-" + service
        self.write_evidence(f"runtime-template-{service}-intent.json", json.dumps({"name": name, "targetImageId": TARGET_IMAGE,
                                                                                "neverStart": True}).encode())
        result = subprocess.run(["curl", "--fail-with-body", "--silent", "--show-error", "--unix-socket", "/var/run/docker.sock",
                                 "--header", "Content-Type: application/json", "--request", "POST", "--data-binary", "@-",
                                 f"http://localhost/v{version}/containers/create?name={name}"],
                                input=json.dumps(request).encode(), capture_output=True, timeout=60)
        require(result.returncode == 0, "Docker runtime-template creation failed; no automatic cleanup or retry")
        template_id = json.loads(result.stdout)["Id"]
        require(re.fullmatch(r"[a-f0-9]{64}", template_id), "invalid runtime-template identity")
        self.write_evidence(f"runtime-template-{service}.json", json.dumps({"id": template_id, "name": name, "neverStarted": True}).encode())
        template = self.inspect(template_id)
        verify_runtime_template(original, template, request)
        current = self.inspect(original_id)
        require(current["Config"] == original["Config"] and normalize_host(current["HostConfig"]) == normalize_host(original["HostConfig"])
                and current["State"]["Status"] == "running", "original runtime changed during template preparation")
        self.write_evidence(f"runtime-template-{service}-verification.json", json.dumps({"status": "verified", "id": template_id,
                            "configSha256": digest(json.dumps(template["Config"], sort_keys=True).encode()),
                            "hostConfigSha256": digest(json.dumps(template["HostConfig"], sort_keys=True).encode()),
                            "maintenanceBindAdded": service == "harness", "imageDefaultEnvironmentAdded": added_default_keys,
                            "templateNetworkMode": "none", "neverStarted": True}).encode())

    def container_identity(self, service, actual, image, name, legacy_source=False):
        require(actual["Image"] == image and actual["Name"] == "/" + name
                and actual["State"]["Status"] == "running", "container identity, image or running state changed")
        env = dict(entry.split("=", 1) for entry in actual["Config"]["Env"])
        prefix = "HARNESS_UPLOAD_" if service == "upload" else ""
        task_key = "HARNESS_UPLOAD_TASKSPACE_ID" if service == "upload" else "FORGE_TASKSPACE_ID"
        require(env.get(prefix + "PROJECT_SLUG") == self.manifest["projectSlug"]
                and env.get(task_key) == self.manifest["taskId"], "container project/TaskSpace binding changed")
        if service == "upload":
            require(not actual["HostConfig"].get("PortBindings"), "upload must not expose host ingress")
            return
        if legacy_source:
            require("HARNESS_MAINTENANCE_FENCE_FILE" not in env
                    and not any(mount.get("Source") == str(self.task_root / "maintenance")
                                or mount.get("Destination") == FENCE_DESTINATION for mount in actual["Mounts"]),
                    "legacy source must have neither a fence environment setting nor a fence mount")
        else:
            require(env.get("HARNESS_MAINTENANCE_FENCE_FILE") == FENCE_DESTINATION + "/proxy-fence.json"
                    and any(mount.get("Source") == str(self.task_root / "maintenance")
                            and mount.get("Destination") == FENCE_DESTINATION
                            and mount.get("RW") is False for mount in actual["Mounts"]),
                    "existing supported TaskSpace maintenance fence is not bound; upgrade refused")
        for source, destination, writable in (("workspace", "/workspace", True),
                                              ("dsh-home", "/home/node/.dsh", True),
                                              ("uploads", "/project-inputs", False)):
            require(any(mount.get("Source") == str(self.task_root / source)
                        and mount.get("Destination") == destination and mount.get("RW") is writable
                        for mount in actual["Mounts"]), "TaskSpace source/session/upload mount binding changed")

    def preflight(self):
        require(self.manifest["fence"]["exists"] or self.legacy,
                "existing supported TaskSpace maintenance fence is absent; upgrade refused")
        for field in ("taskEnv", "cutoverHelper", "fence"):
            file_binding(self.manifest[field])
        if self.legacy:
            self.legacy_preflight()
        else:
            fence = json.loads(regular_bytes(self.manifest["fence"]["path"]))
            require(fence.get("schemaVersion") == 1 and fence.get("state") == "committed"
                    and isinstance(fence.get("epoch"), str), "existing maintenance fence is not committed")
        environment_delta(regular_bytes(self.manifest["taskEnv"]["path"]), self.manifest["taskEnv"]["harnessImage"], self.target_image)
        require(self.docker("image", "inspect", "-f", "{{.Id}}", self.manifest["taskEnv"]["harnessImage"]).decode().strip()
                == self.manifest["containers"]["harness"]["sourceImageId"], "task.env Harness image does not match the original container")
        for service in SERVICES:
            item = self.manifest["containers"][service]
            actual = self.inspect(item["originalId"])
            require(actual["Id"] == item["originalId"], "original container ID changed")
            self.container_identity(service, actual, item["sourceImageId"], item["name"], legacy_source=bool(self.legacy))
        require(self.docker("image", "inspect", "-f", "{{.Id}}", self.target_ref).decode().strip() == self.target_image,
                "reviewed target image/tag changed")
        self.source_preserved()
        harness = self.manifest["containers"]["harness"]["originalId"]
        self.sessions(harness)
        if not self.legacy:
            health = self.node(harness, HEALTH_JS, "harness")
            require(health["status"] == 200 and health["body"].get("status") == "open", "existing fence endpoint is unavailable")
        if "priorArchiveVerification" in self.manifest:
            self.prior_archives()

    def cutover(self, action, service):
        file_binding(self.manifest["cutoverHelper"])
        arguments = [f"archive-{service}", self.manifest["containers"][service]["originalId"], self.target_image] \
            if action == "prepare" else [str(self.records / f"archive-{service}.json")]
        if action == "prepare" and self.legacy:
            template = json.loads(regular_bytes(self.backup / f"runtime-template-{service}.json"))
            require(self.inspect(template["id"])["State"]["Status"] == "created", "runtime template was started or changed")
            arguments.extend(["", template["id"]])
        script = f"set -Eeuo pipefail\nsource {shlex.quote(CUTOVER_HELPER)}\n" \
            + f"export FORGE_CUTOVER_OPERATION={shlex.quote(self.operation)} FORGE_CUTOVER_RECORD_ROOT={shlex.quote(str(self.records))}\n" \
            + shlex.join(["forge_cutover_" + action, *arguments])
        result = subprocess.run(["bash", "-c", script], capture_output=True, timeout=180)
        self.write_evidence(f"{action}-{service}.log", result.stdout + result.stderr)
        require(result.returncode == 0, f"{service} {action} failed; cutover evidence retained")

    def write_evidence(self, name, data):
        with (self.backup / name).open("xb") as stream:
            os.chmod(stream.name, 0o600)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())

    def candidates(self):
        return {service: json.loads(regular_bytes(self.records / f"archive-{service}.json")) for service in SERVICES}

    def wait_for(self, description, check, seconds):
        deadline = time.monotonic() + seconds
        while True:
            try:
                return check()
            except (RuntimeError, subprocess.TimeoutExpired) as error:
                if time.monotonic() >= deadline:
                    raise RuntimeError(description + " did not complete before the fixed deadline; last observation: " + str(error)) from None
                time.sleep(2)

    def drained(self, harness, service="harness"):
        result = self.node(harness, HEALTH_JS, service)
        body = result.get("body", {})
        drain = body.get("drain", {})
        require(result.get("status") == 503 and body.get("status") == "maintenance"
                and body.get("epoch") == self.operation and drain.get("mode") == "connection-tracked"
                and drain.get("drained") is True
                and all(drain.get(key) == 0 for key in ("activeTcpConnections", "activeHttpRequests", "activeUpgradeConnections")),
                "Harness ingress has not drained")

    def healthy(self, require_open=False):
        for service, record in self.candidates().items():
            state = self.inspect(record["candidate"]["id"])["State"]
            require(state["Status"] == "running" and state.get("Health", {}).get("Status", "none") in ("healthy", "none"),
                    "candidate is not healthy")
            if require_open:
                health = self.node(record["candidate"]["id"], HEALTH_JS, service)
                require(health["status"] == 200 and (service == "upload" or health["body"].get("status") == "open"),
                        "upgraded service endpoint is unavailable")

    def archived(self, index_only=False):
        if "priorArchiveVerification" in self.manifest:
            archives = self.prior_archives()
            if not index_only:
                self.upgraded_reader_verification(archives)
            return archives
        harness = self.candidates()["harness"]["candidate"]["id"]
        if getattr(self, "archive_reader_image", None) and not index_only:
            inspected = self.inspect(harness)
            env = dict(entry.split("=", 1) for entry in inspected["Config"]["Env"])
            keys = ("PROJECT_SLUG", "FORGE_TASKSPACE_ID", "FORGE_TASKSPACE_ACTOR_ID", "FORGE_TASKSPACE_CONVERSATION_ID")
            payload = {"environment": {key: env[key] for key in keys}, "sessions": self.manifest["sessions"]}
            script = ARCHIVE_JOB_INPUT_JS + "\nprocess.argv[1]=JSON.stringify(input.sessions);process.argv[2]='source';\n" + ARCHIVES_JS
            result = self.archive_job("source-verify", script, payload, network_harness=harness,
                                      mounts=[(str(self.task_root / "uploads"), "/project-inputs")],
                                      user=inspected["Config"].get("User"))
        else:
            result = self.node(harness, ARCHIVES_JS, json.dumps(self.manifest["sessions"], separators=(",", ":")),
                               "index" if index_only else "source")
        require(not result["missing"], "unverified original archives count=" + str(len(result["missing"]))
                + " sessions=" + json.dumps(result["missing"], separators=(",", ":")))
        if getattr(self, "stored_review", None) and not index_only:
            expected = {"sessionId": self.backfill_session, **{
                key: self.stored_review["storedArchive"][key] for key in ("snapshotId", "eventDigest", "eventCount")}}
            require(expected in result["items"], "stored backfill source differs from the reviewed sealed archive")
        return result["items"]

    def verify_state(self):
        self.source_preserved()
        file_binding(self.manifest["cutoverHelper"])
        if self.legacy:
            file_binding(json.loads(regular_bytes(self.backup / "local-fence-baseline.json")))
            self.gateway_preserved()
            file_binding(self.legacy["gatewayFence"])
            for service in SERVICES:
                template = json.loads(regular_bytes(self.backup / f"runtime-template-{service}.json"))
                require(self.inspect(template["id"])["State"]["Status"] == "created", "retained runtime template was started")
        else:
            file_binding(self.manifest["fence"])
        before = regular_bytes(self.backup / "task.env.before")
        require(digest(before) == self.manifest["taskEnv"]["sha256"], "saved env preimage changed")
        require(regular_bytes(self.manifest["taskEnv"]["path"]) ==
                environment_delta(before, self.manifest["taskEnv"]["harnessImage"], self.target_image), "TaskSpace env delta changed")
        env = self.manifest["taskEnv"]
        info = Path(env["path"]).lstat()
        require((stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid) == (env["mode"], env["uid"], env["gid"]),
                "TaskSpace env mode or ownership changed")
        for service, record in self.candidates().items():
            original = self.manifest["containers"][service]
            require(record.get("promoted") is True and record.get("promotionState") == "promoted"
                    and record["original"]["fullId"] == original["originalId"]
                    and record["targetImageId"] == self.target_image, "cutover record binding changed")
            self.container_identity(service, self.inspect(record["candidate"]["id"]), self.target_image, original["name"])
            retained = self.inspect(original["originalId"])
            require(retained["Image"] == original["sourceImageId"] and retained["State"]["Status"] == "exited"
                    and retained["Name"] == "/" + record["rollbackName"], "original rollback container is not retained")
        self.wait_for("final candidate health and open endpoints", lambda: self.healthy(require_open=True), 120)
        self.sessions(self.candidates()["harness"]["candidate"]["id"])
        return self.archived()

    def verify(self):
        path = self.backup / "receipt.json"
        if not path.exists():
            path = self.backup / "stored-archive-completion.json"
        if not path.exists():
            path = self.backup / "focused-completion.json"
        require(not getattr(self, "archive_reader_image", None)
                or path.name in ("focused-completion.json", "stored-archive-completion.json"),
                "archive reader override cannot change ordinary upgrade verification")
        require(not getattr(self, "stored_review", None) or path.name == "stored-archive-completion.json",
                "stored archive review cannot change a different completion")
        receipt = json.loads(regular_bytes(path))
        require(receipt.get("status") == "success" and receipt.get("manifestSha256") == self.manifest_sha
                and receipt.get("targetImageId") == self.target_image and receipt.get("operation") == self.operation,
                "successful receipt does not bind this upgrade")
        if "priorArchiveVerification" in self.manifest:
            require(receipt.get("priorArchiveVerification") == self.manifest["priorArchiveVerification"]
                    and receipt.get("sourceArchivesReused") == 40 and receipt.get("actualReaderHistoriesVerified") == 1
                    and receipt.get("readerVerificationSha256") == digest(regular_bytes(self.backup / "upgraded-reader-verification.json")),
                    "successful upgrade no longer binds its prior sources and actual reader verification")
        require(getattr(self, "stored_source_failure_sha", None) in (None, receipt.get("storedSourceFailureSha256")),
                "verification source failure differs from the completed repair")
        if path.name in ("focused-completion.json", "stored-archive-completion.json"):
            stored = path.name == "stored-archive-completion.json"
            require(receipt.get("completionMode") == ("complete-prepared-stored-archive" if stored else "complete-prepared")
                    and digest(regular_bytes(self.backup / "failure.json")) == receipt.get("originalFailureSha256")
                    and digest(regular_bytes(self.backup / "reviewed-gateway-restoration.json")) == receipt.get("gatewayRestorationSha256"),
                    "focused completion no longer binds the original failure and restoration evidence")
            if stored:
                require(getattr(self, "stored_review_sha", None) in (None, receipt.get("storedBackfillReviewSha256")),
                        "verification review differs from the stored archive completion")
                self.bind_stored_review(regular_bytes(self.backup / "stored-archive-review.json"), receipt.get("storedBackfillReviewSha256"))
                self.verify_stored_backfill()
                if receipt.get("storedSourceFailureSha256") is not None:
                    require(re.fullmatch(r"[a-f0-9]{64}", receipt["storedSourceFailureSha256"]),
                            "completed repair source failure digest is invalid")
                    self.stored_source_failure_sha = receipt["storedSourceFailureSha256"]
                    previous = self.verify_stored_source_failure()
                    require(all(previous.get(key) == receipt.get(key) for key in
                            ("manifestSha256", "originalFailureSha256", "gatewayRestorationSha256", "preparedCandidates",
                             "archiveReaderModules", "archiveReaderImage", "backfillSession", "storedBackfillReviewSha256")),
                            "completed repair no longer binds the original stored archive attempt")
            if receipt.get("archiveReaderImage"):
                require(getattr(self, "archive_reader_image", None) in (None, receipt["archiveReaderImage"])
                        and getattr(self, "backfill_session", None) in (None, receipt["backfillSession"]),
                        "verification reader override differs from the completed archive evidence")
                self.archive_reader_image = receipt["archiveReaderImage"]
                self.backfill_session = receipt["backfillSession"]
                self.verify_archive_reader_image()
        self.verify_state()
        return receipt

    def preflight_prepared(self):
        require(self.legacy and self.backup.is_dir() and not self.backup.is_symlink(),
                "prepared completion requires the existing legacy operation directory")
        if (self.backup / "stored-archive-completion.json").exists() or (self.backup / "focused-completion.json").exists():
            self.verify()
            return {"alreadyCompleted": True}
        stored = getattr(self, "stored_review", None) is not None
        require(not (self.backup / "receipt.json").exists(), "an attempted completion requires separate review")
        if stored:
            repair = getattr(self, "stored_source_failure_sha", None) is not None
            files = ("stored-source-repair-attempt.json", "stored-source-repair-failure.json") if repair else (
                "stored-archive-review.json", "stored-archive-attempt.json", "stored-archive-failure.json")
            require(not any((self.backup / name).exists() for name in files),
                    "an attempted stored archive completion requires separate review")
            if repair:
                previous_source_attempt = self.verify_stored_source_failure()
            previous_attempt = self.verify_stored_backfill()
        else:
            require(not (self.backup / "focused-completion-attempt.json").exists(),
                    "an attempted completion requires separate review")
        failure_bytes = regular_bytes(self.backup / "failure.json")
        failure = json.loads(failure_bytes)
        require(failure.get("status") == "failed" and failure.get("stage") == "legacy-source-reconciliation"
                and failure.get("manifestSha256") == self.manifest_sha and failure.get("automaticRollback") is False,
                "failure is outside the reviewed prepared-candidate completion point")
        require(json.loads(regular_bytes(self.backup / "manifest.json")) == self.manifest,
                "original operation manifest differs from the reviewed manifest")
        restoration_bytes = regular_bytes(self.backup / "reviewed-gateway-restoration.json")
        restoration = json.loads(restoration_bytes)
        require(restoration.get("status") == "gateway-restored" and restoration.get("operation") == self.operation
                and restoration.get("sourceSessionsMatched") == len(self.manifest["sessions"])
                and all(restoration.get(key) is True for key in ("workspacePreserved", "originalContainersRetained",
                        "candidateLocalMaintenanceRetained", "globalFenceOriginalBytesRestored", "deploymentFailureReceiptUnchanged"))
                and restoration.get("promoted") is False and isinstance(restoration.get("authorizationRef"), str)
                and restoration["authorizationRef"], "reviewed Gateway restoration evidence is incomplete")
        file_binding(self.manifest["cutoverHelper"])
        file_binding(self.manifest["taskEnv"])
        self.source_preserved()
        gateway_id = self.gateway_preserved()
        file_binding(self.legacy["gatewayFence"])
        gateway_health = self.node(gateway_id, HEALTH_JS, "gateway")
        require(gateway_health.get("status") == 200 and gateway_health.get("body", {}).get("status") == "open",
                "restored Gateway endpoint is not open")
        before = regular_bytes(self.backup / "task.env.before")
        require(digest(before) == self.manifest["taskEnv"]["sha256"], "saved TaskSpace environment preimage changed")
        baseline = json.loads(regular_bytes(self.backup / "local-fence-baseline.json"))
        require(baseline["path"] == self.manifest["fence"]["path"]
                and digest(regular_bytes(self.backup / "fence.before")) == baseline["sha256"], "saved local fence baseline changed")
        expected_maintenance = json.dumps({"schemaVersion": 1, "state": "maintenance", "epoch": self.operation}).encode()
        current_fence = regular_bytes(baseline["path"])
        require(current_fence == expected_maintenance, "candidate local fence is outside this operation's maintenance")
        maintenance_binding = {**baseline, "sha256": digest(expected_maintenance)}
        file_binding(maintenance_binding)
        bindings = {}
        for service, record in self.candidates().items():
            original = self.manifest["containers"][service]
            require(record.get("promotionState") == "prepared" and record.get("promoted") is False
                    and record["original"]["fullId"] == original["originalId"]
                    and record["original"]["name"] == original["name"] and record["targetImageId"] == TARGET_IMAGE
                    and all(re.fullmatch(r"[a-f0-9]{64}", record.get("contracts", {}).get(key, ""))
                            for key in ("originalSha256", "candidateSha256")), "prepared cutover record identity changed")
            source = self.inspect(original["originalId"])
            require(source["State"]["Status"] == "exited" and source["Name"] == "/" + original["name"]
                    and source["Image"] == original["sourceImageId"], "original prepared container is not retained unchanged")
            candidate = self.inspect(record["candidate"]["id"])
            require(candidate["Id"] == record["candidate"]["id"], "prepared candidate ID changed")
            self.container_identity(service, candidate, TARGET_IMAGE, record["candidate"]["name"])
            self.verify_prepared_contract(service, source, candidate)
            bindings[service] = {"candidateId": candidate["Id"], "originalId": source["Id"],
                                 "cutoverRecordSha256": digest(regular_bytes(self.records / f"archive-{service}.json"))}
        harness = bindings["harness"]["candidateId"]
        self.drained(harness)
        self.sessions(harness, wait_ready=True)
        evidence = {"originalFailureSha256": digest(failure_bytes), "gatewayRestorationSha256": digest(restoration_bytes),
                    "preparedCandidates": bindings}
        if getattr(self, "archive_reader_image", None):
            evidence["archiveReaderModules"] = self.verify_archive_reader_image()
            if stored:
                require(previous_attempt.get("originalFailureSha256") == evidence["originalFailureSha256"]
                        and previous_attempt.get("gatewayRestorationSha256") == evidence["gatewayRestorationSha256"]
                        and previous_attempt.get("preparedCandidates") == bindings
                        and previous_attempt.get("archiveReaderModules") == evidence["archiveReaderModules"],
                        "stored archive attempt no longer binds these prepared candidates and reader")
                self.archived(index_only=True)
                evidence["storedBackfillReviewSha256"] = self.stored_review_sha
            else:
                self.verify_single_missing_archive()
            evidence.update({"archiveReaderImage": self.archive_reader_image, "backfillSession": self.backfill_session})
        if stored and getattr(self, "stored_source_failure_sha", None):
            require(previous_source_attempt == {"manifestSha256": self.manifest_sha, **evidence},
                    "reviewed stored archive attempt differs from the current prepared bindings")
            evidence["storedSourceFailureSha256"] = self.stored_source_failure_sha
        return evidence

    def verify_prepared_contract(self, service, source, candidate):
        template_record = json.loads(regular_bytes(self.backup / f"runtime-template-{service}.json"))
        template = self.inspect(template_record["id"])
        proof = json.loads(regular_bytes(self.backup / f"runtime-template-{service}-verification.json"))
        require(proof.get("status") == "verified" and proof.get("id") == template["Id"]
                and template["State"]["Status"] == "created"
                and digest(json.dumps(template["Config"], sort_keys=True).encode()) == proof["configSha256"]
                and digest(json.dumps(template["HostConfig"], sort_keys=True).encode()) == proof["hostConfigSha256"],
                "retained runtime template no longer matches its verified contract")
        expected_config = copy.deepcopy(template["Config"])
        if expected_config.get("Hostname") == template["Id"][:12]:
            expected_config["Hostname"] = candidate["Id"][:12]
        expected_host = copy.deepcopy(template["HostConfig"])
        expected_host["NetworkMode"] = source["HostConfig"]["NetworkMode"]
        require(candidate["Config"] == expected_config
                and normalize_host(candidate["HostConfig"]) == normalize_host(expected_host)
                and sorted(candidate["Mounts"], key=lambda item: item["Destination"]) ==
                    sorted(template["Mounts"], key=lambda item: item["Destination"]),
                "prepared candidate Config, HostConfig or mounts changed")
        source_networks = source["NetworkSettings"]["Networks"]
        candidate_networks = candidate["NetworkSettings"]["Networks"]
        require(set(source_networks) == set(candidate_networks), "prepared candidate network names changed")
        for name, network in candidate_networks.items():
            current_id = self.docker("network", "inspect", "-f", "{{.Id}}", name).decode().strip()
            require(network["NetworkID"] == current_id, "prepared candidate network identity changed")

    def complete_prepared(self):
        evidence = self.preflight_prepared()
        if evidence.get("alreadyCompleted"):
            return self.verify()
        stored = getattr(self, "stored_review", None) is not None
        repair = stored and getattr(self, "stored_source_failure_sha", None) is not None
        prefix = "stored-source-repair" if repair else "stored-archive" if stored else "focused-completion"
        if stored and not repair:
            self.write_evidence("stored-archive-review.json", self.stored_review_bytes)
        self.write_evidence(prefix + "-attempt.json", json.dumps({"manifestSha256": self.manifest_sha, **evidence}).encode())
        try:
            if stored:
                self.finish_stage = "stored-archive-source-verification"
                archives = self.archived()
                require(len(archives) == sum(not item["blank"] for item in self.manifest["sessions"]),
                        "stored completion did not verify every original nonblank source")
                self.verify_stored_backfill()
                if repair:
                    self.verify_stored_source_failure()
                evidence["sourceArchivesVerifiedBeforeCompletion"] = len(archives)
                evidence["archiveSaveInvoked"] = False
            elif getattr(self, "archive_reader_image", None):
                self.finish_stage = "explicit-archive-backfill"
                self.backfill_archive()
            original_env = regular_bytes(self.backup / "task.env.before")
            original_fence = regular_bytes(self.backup / "fence.before")
            fence_bytes = regular_bytes(self.manifest["fence"]["path"])
            receipt = self.finish_candidates(original_env, original_fence, fence_bytes)
            require(digest(regular_bytes(self.backup / "failure.json")) == evidence["originalFailureSha256"]
                    and digest(regular_bytes(self.backup / "reviewed-gateway-restoration.json")) == evidence["gatewayRestorationSha256"],
                    "original failure or reviewed restoration evidence changed during completion")
            if stored:
                self.verify_stored_backfill()
                if repair:
                    self.verify_stored_source_failure()
            receipt.update({"completionMode": "complete-prepared-stored-archive" if stored else "complete-prepared", **evidence})
            self.write_evidence("stored-archive-completion.json" if stored else "focused-completion.json", json.dumps(receipt, sort_keys=True).encode())
            return receipt
        except Exception as error:
            self.write_evidence(prefix + "-failure.json", json.dumps({"status": "failed",
                                "stage": getattr(self, "finish_stage", "prepared-completion"), "reason": str(error),
                                "manifestSha256": self.manifest_sha, "originalFailurePreserved": True,
                                "automaticRollback": False, "retryRequiresReview": True}).encode())
            raise

    def finish_candidates(self, original_env, original_fence, fence_bytes):
        """Finish already-active candidates; never prepare, activate or stop containers."""
        self.finish_stage = "archive-verification"
        self.wait_for("candidate health", self.healthy, 120)
        if "priorArchiveVerification" in self.manifest:
            archives = self.archived(index_only=True)
        else:
            self.wait_for("original nonblank session archives", lambda: self.archived(index_only=True), 180)
        self.source_preserved()
        self.sessions(self.candidates()["harness"]["candidate"]["id"], wait_ready=True)
        if "priorArchiveVerification" in self.manifest:
            self.finish_stage = "actual-upgraded-reader-verification"
            reader_sha = self.upgraded_reader_verification(archives, read_once=True)
        self.finish_stage = "env-update"
        atomic_replace(self.manifest["taskEnv"]["path"],
                       environment_delta(original_env, self.manifest["taskEnv"]["harnessImage"], self.target_image), original_env)
        for service in ("upload", "harness"):
            self.finish_stage = "promote-" + service
            self.cutover("promote", service)
        self.finish_stage = "restore-fence"
        atomic_replace(self.manifest["fence"]["path"], original_fence, fence_bytes)
        self.finish_stage = "final-verification"
        archives = self.verify_state()
        receipt = {"schemaVersion": SCHEMA, "status": "success", "operation": self.operation,
                    "manifestSha256": self.manifest_sha, "targetImageId": self.target_image,
                   "projectSlug": self.manifest["projectSlug"], "taskId": self.manifest["taskId"],
                   "services": list(SERVICES), "archives": archives, "originalContainersRetained": True,
                   "workspaceHeadAndStatusPreserved": True, "sessionBindingsPreserved": True,
                    "automaticRollback": False, "operatorModelRequests": 0}
        if "priorArchiveVerification" in self.manifest:
            receipt.update({"priorArchiveVerification": self.manifest["priorArchiveVerification"],
                            "readerVerificationSha256": reader_sha, "sourceArchivesReused": 40,
                            "actualReaderHistoriesVerified": 1, "archiveSaveInvoked": False})
        if self.legacy:
            receipt["legacyMaintenance"] = {"sourceProxyPreDrainUnsupported": True,
                                            "stopMode": "synchronous-docker-stop-then-start",
                                            "originalExitObservedAfterActivation": True,
                                            "originalSessionMetadataReconciled": True,
                                            "gatewayFenceRestored": True,
                                            "localFenceCreated": not self.manifest["fence"]["exists"],
                                            "localFenceBaseline": json.loads(regular_bytes(self.backup / "local-fence-baseline.json"))}
        return receipt

    def upgrade(self):
        if os.path.lexists(self.backup):
            require(self.backup.is_dir() and not self.backup.is_symlink()
                    and (self.backup / "receipt.json").is_file(),
                    "incomplete upgrade evidence exists; operator review required before any further mutation")
            return self.verify()
        self.preflight()
        self.backup.mkdir(mode=0o700)
        self.records.mkdir(mode=0o700)
        stage = "backup"
        try:
            self.write_evidence("manifest.json", json.dumps(self.manifest, sort_keys=True).encode())
            original_env = regular_bytes(self.manifest["taskEnv"]["path"])
            require(digest(original_env) == self.manifest["taskEnv"]["sha256"], "environment changed after preflight")
            self.write_evidence("task.env.before", original_env)
            stage = "maintenance"
            fence_bytes = json.dumps({"schemaVersion": 1, "state": "maintenance", "epoch": self.operation}).encode()
            harness = self.manifest["containers"]["harness"]["originalId"]
            if self.legacy:
                original_gateway_fence = regular_bytes(self.legacy["gatewayFence"]["path"])
                require(digest(original_gateway_fence) == self.legacy["gatewayFence"]["sha256"], "Gateway fence changed after preflight")
                self.write_evidence("gateway-fence.before", original_gateway_fence)
                stage = "prepare-legacy-fence"
                original_fence = self.prepare_legacy_fence()
                stage = "runtime-template"
                for service in SERVICES:
                    self.create_runtime_template(service)
                stage = "maintenance"
                atomic_replace(self.legacy["gatewayFence"]["path"], fence_bytes, original_gateway_fence)
                self.wait_for("Gateway authorization ingress drain",
                              lambda: self.drained(self.legacy["gateway"]["originalId"], "gateway"), 120)
                self.sessions(harness)
                atomic_replace(self.manifest["fence"]["path"], fence_bytes, original_fence)
            else:
                original_fence = regular_bytes(self.manifest["fence"]["path"])
                require(digest(original_fence) == self.manifest["fence"]["sha256"], "fence changed after preflight")
                self.write_evidence("fence.before", original_fence)
                atomic_replace(self.manifest["fence"]["path"], fence_bytes, original_fence)
                self.wait_for("Harness ingress drain", lambda: self.drained(harness), 120)
            self.sessions(harness)
            self.source_preserved()
            for action in ("prepare", "activate"):
                for service in ("upload", "harness"):
                    stage = f"{action}-{service}"
                    self.cutover(action, service)
                    if action == "activate":
                        retained = self.inspect(self.manifest["containers"][service]["originalId"])
                        require(retained["State"]["Status"] == "exited", "original container is not stopped after activation")
                        self.write_evidence(f"original-{service}-stopped.json", json.dumps({"id": retained["Id"],
                                            "status": retained["State"]["Status"], "observedAfterActivateReturned": True}).encode())
            if self.legacy:
                stage = "legacy-source-reconciliation"
                candidate = self.candidates()["harness"]["candidate"]["id"]
                self.wait_for("candidate local maintenance ingress", lambda: self.drained(candidate), 120)
                self.sessions(candidate, wait_ready=True)
                self.source_preserved()
                self.write_evidence("legacy-source-reconciliation.json", json.dumps({"sessionMetadataUnchanged": True,
                                    "sessionCount": len(self.manifest["sessions"]), "sourceProxyPreDrainUnsupported": True,
                                    "legacyStopMode": "synchronous-docker-stop-then-start", "postActivateOriginalExitsObserved": True,
                                    "candidateMaintenanceDrained": True}).encode())
                atomic_replace(self.legacy["gatewayFence"]["path"], original_gateway_fence, fence_bytes)
            receipt = self.finish_candidates(original_env, original_fence, fence_bytes)
            self.write_evidence("receipt.json", json.dumps(receipt, sort_keys=True).encode())
            return receipt
        except Exception as error:
            self.write_evidence("failure.json", json.dumps({"status": "failed", "stage": getattr(self, "finish_stage", stage),
                                "manifestSha256": self.manifest_sha, "automaticRollback": False,
                                "evidenceRetained": True, "retryRequiresReview": True, "reason": str(error)}).encode())
            raise


def remote(action, manifest, manifest_sha, archive_reader_image=None, backfill_session=None,
           stored_backfill_review=None, stored_backfill_review_sha=None, stored_source_failure_sha=None):
    import fcntl
    from contextlib import ExitStack
    upgrade = Upgrade(manifest, manifest_sha, archive_reader_image, backfill_session,
                      stored_backfill_review, stored_backfill_review_sha, stored_source_failure_sha)
    with ExitStack() as stack:
        if action in ("upgrade", "complete-prepared"):
            for name in ("projects", "taskspaces"):
                lock = Path(f"/srv/forge-delivery/registry/{name}.lock")
                regular_bytes(lock)
                stream = stack.enter_context(lock.open("r+b"))
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if action == "preflight":
            upgrade.preflight()
            return {"status": "passed", "manifestSha256": manifest_sha, "mutated": False}
        if action == "preflight-prepared":
            return {"status": "passed", "manifestSha256": manifest_sha, "mutated": False, **upgrade.preflight_prepared()}
        if action == "complete-prepared":
            return upgrade.complete_prepared()
        return upgrade.upgrade() if action == "upgrade" else upgrade.verify()


def invoke(action, data, manifest_sha, archive_reader_image=None, backfill_session=None,
           stored_backfill_review=None, stored_backfill_review_sha=None, stored_source_failure_sha=None):
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location("reviewed_archive_activation", root / "scripts/activate-conversation-archive.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    helper = module.load_helper(root)
    secret = helper.load_secret()
    client = helper.paramiko.SSHClient()
    client.load_host_keys(str(helper.KNOWN_HOSTS))
    client.set_missing_host_key_policy(helper.paramiko.RejectPolicy())
    client.connect(helper.HOST, username=helper.USER, key_filename=str(helper.SSH_KEY), timeout=15,
                   allow_agent=False, look_for_keys=False)
    try:
        args = ["/usr/bin/sudo", "-S", "-p", "", "--", "python3", "-", action, "--remote",
                "--manifest-base64", base64.b64encode(data).decode("ascii"), "--manifest-sha256", manifest_sha]
        if archive_reader_image is not None:
            args.extend(["--archive-reader-image", archive_reader_image, "--backfill-session", backfill_session])
        if stored_backfill_review is not None:
            args.extend(["--stored-backfill-review-base64", base64.b64encode(stored_backfill_review).decode("ascii"),
                         "--stored-backfill-review-sha256", stored_backfill_review_sha])
        if stored_source_failure_sha is not None:
            args.extend(["--stored-source-failure-sha256", stored_source_failure_sha])
        stdin, stdout, _ = client.exec_command(shlex.join(args), timeout=1800, get_pty=False)
        stdin.write(secret + "\n")
        stdin.write(regular_bytes(Path(__file__)).decode().replace("\r\n", "\n"))
        stdin.flush()
        stdin.channel.shutdown_write()
        out, err = helper.read_bounded_channel(stdout.channel, timeout_seconds=1800)
        code = stdout.channel.recv_exit_status()
    finally:
        client.close()
    require(not secret.encode() or secret.encode() not in out + err, "remote output contained credential material")
    sys.stdout.write(out.decode(errors="replace"))
    sys.stderr.write(err.decode(errors="replace"))
    return code


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "upgrade", "verify", "preflight-prepared", "complete-prepared"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--archive-reader-image")
    parser.add_argument("--backfill-session")
    parser.add_argument("--stored-backfill-review", type=Path)
    parser.add_argument("--stored-backfill-review-sha256")
    parser.add_argument("--stored-source-failure-sha256")
    parser.add_argument("--remote", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--manifest-base64", help=argparse.SUPPRESS)
    parser.add_argument("--stored-backfill-review-base64", help=argparse.SUPPRESS)
    args = parser.parse_args()
    require((args.archive_reader_image is None) == (args.backfill_session is None), "archive reader image and backfill session must be paired")
    require(args.archive_reader_image is None or args.action in ("preflight-prepared", "complete-prepared", "verify"),
            "archive reader override is restricted to the prepared completion and its verification")
    review_input = args.stored_backfill_review_base64 if args.remote else args.stored_backfill_review
    require((review_input is None) == (args.stored_backfill_review_sha256 is None),
            "stored archive review and digest must be paired")
    require(review_input is None or args.action in ("preflight-prepared", "complete-prepared", "verify"),
            "stored archive review is restricted to the prepared completion and its verification")
    review = None if review_input is None else (base64.b64decode(review_input, validate=True)
                                               if args.remote else regular_bytes(review_input))
    data = base64.b64decode(args.manifest_base64, validate=True) if args.remote else regular_bytes(args.manifest)
    require(re.fullmatch(r"[a-f0-9]{64}", args.manifest_sha256) and digest(data) == args.manifest_sha256,
            "frozen upgrade manifest digest changed")
    manifest = validate_manifest(json.loads(data))
    Upgrade(manifest, args.manifest_sha256, args.archive_reader_image, args.backfill_session,
            review, args.stored_backfill_review_sha256, args.stored_source_failure_sha256)
    if args.remote:
        print(json.dumps(remote(args.action, manifest, args.manifest_sha256, args.archive_reader_image, args.backfill_session,
                                review, args.stored_backfill_review_sha256, args.stored_source_failure_sha256), sort_keys=True))
        return 0
    return invoke(args.action, data, args.manifest_sha256, args.archive_reader_image, args.backfill_session,
                  review, args.stored_backfill_review_sha256, args.stored_source_failure_sha256)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"TaskSpace archive upgrade refused: {error}\n")
        raise SystemExit(1)
