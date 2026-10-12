"""Focused file-safety and failure-preservation tests for the two-service upgrade."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "scripts/upgrade-taskspace-conversation-archive.py"
SPEC = importlib.util.spec_from_file_location("taskspace_archive_upgrade", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ArchiveUpgradeTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="forge-taskspace-archive-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.env = self.root / "task.env"
        self.original = b"# unchanged\r\nHARNESS_IMAGE=old-image\r\nOTHER=retained\nFINAL=no-newline"
        self.env.write_bytes(self.original)

    def posix_metadata(self):
        # Windows cannot apply POSIX owner/mode; real file writes/replace remain exercised.
        return mock.patch.multiple(os, fchmod=getattr(os, "fchmod", lambda *args: None),
                                   fchown=getattr(os, "fchown", lambda *args: None),
                                   chown=getattr(os, "chown", lambda *args: None), create=True)

    def test_real_env_change_is_one_atomic_replace_with_other_bytes_preserved(self):
        changed = MODULE.environment_delta(self.original, "old-image", MODULE.TARGET_IMAGE)
        with self.posix_metadata(), mock.patch.object(os, "replace", wraps=os.replace) as replace:
            MODULE.atomic_replace(self.env, changed, self.original)
        self.assertEqual(replace.call_count, 1)
        self.assertEqual(self.env.read_bytes(), self.original.replace(b"old-image", MODULE.TARGET_IMAGE.encode()))

    def test_duplicate_key_and_source_drift_leave_original_file_untouched(self):
        for data, source, message in ((self.original + b"\nHARNESS_IMAGE=old-image", "old-image", "exactly once"),
                                      (self.original, "wrong-source", "source changed")):
            with self.assertRaisesRegex(RuntimeError, message):
                MODULE.environment_delta(data, source, MODULE.TARGET_IMAGE)
        self.env.write_bytes(self.original + b"\nNEW=value")
        with self.assertRaisesRegex(RuntimeError, "preimage changed"):
            MODULE.atomic_replace(self.env, b"wrong", self.original)
        self.assertEqual(self.env.read_bytes(), self.original + b"\nNEW=value")

    def test_failed_atomic_replace_preserves_original_and_candidate_evidence(self):
        changed = MODULE.environment_delta(self.original, "old-image", MODULE.TARGET_IMAGE)
        with self.posix_metadata(), mock.patch.object(os, "replace", side_effect=OSError("injected replace failure")):
            with self.assertRaisesRegex(OSError, "injected"):
                MODULE.atomic_replace(self.env, changed, self.original)
        self.assertEqual(self.env.read_bytes(), self.original)
        candidates = list(self.root.glob(".archive-upgrade-*"))
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].read_bytes(), changed)

    def test_container_identity_rejects_stopped_wrong_project_and_missing_fence(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.task_root = Path("/srv/forge-delivery/projects/demo/taskspaces/task-1")
        upgrade.manifest = {"projectSlug": "demo", "taskId": "task-1"}
        container = {"Image": "sha256:" + "1" * 64, "Name": "/harness", "State": {"Status": "running"},
                     "Config": {"Env": ["PROJECT_SLUG=demo", "FORGE_TASKSPACE_ID=task-1"]}, "Mounts": []}
        for change, error in (({"State": {"Status": "exited"}}, "running state"),
                              ({"Config": {"Env": ["PROJECT_SLUG=other", "FORGE_TASKSPACE_ID=task-1"]}}, "project/TaskSpace"),
                              ({}, "maintenance fence")):
            altered = copy.deepcopy(container)
            altered.update(change)
            with self.assertRaisesRegex(RuntimeError, error):
                upgrade.container_identity("harness", altered, container["Image"], "harness")

    def test_partial_upgrade_keeps_backups_failure_stage_and_refuses_rerun(self):
        fence = self.root / "proxy-fence.json"
        fence.write_bytes(b'{"schemaVersion":1,"state":"committed","epoch":"before"}')
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.manifest = {"taskEnv": {"path": str(self.env), "sha256": MODULE.digest(self.original)},
                            "fence": {"path": str(fence), "sha256": MODULE.digest(fence.read_bytes())},
                            "containers": {"harness": {"originalId": "1" * 64}}}
        upgrade.legacy = None
        upgrade.manifest_sha = "1" * 64
        upgrade.operation = "test-archive-operation"
        upgrade.backup = self.root / "backup"
        upgrade.records = upgrade.backup / "cutover"
        with mock.patch.object(upgrade, "preflight"), mock.patch.object(MODULE, "atomic_replace", side_effect=RuntimeError("injected fence failure")):
            with self.assertRaisesRegex(RuntimeError, "injected"):
                upgrade.upgrade()
        self.assertEqual((upgrade.backup / "task.env.before").read_bytes(), self.original)
        self.assertEqual((upgrade.backup / "fence.before").read_bytes(), fence.read_bytes())
        self.assertEqual(json.loads((upgrade.backup / "failure.json").read_bytes())["stage"], "maintenance")
        self.assertFalse((upgrade.backup / "receipt.json").exists())
        with mock.patch.object(upgrade, "preflight") as preflight:
            with self.assertRaisesRegex(RuntimeError, "operator review required"):
                upgrade.upgrade()
            preflight.assert_not_called()

    def test_legacy_observation_without_a_bound_fence_is_explicitly_refused(self):
        with self.assertRaisesRegex(RuntimeError, "maintenance fence is absent"):
            MODULE.validate_manifest({"proxyMaintenanceFence": {"configuredFenceAvailable": False}})

    def test_legacy_template_is_never_started_and_only_expected_contract_delta_is_allowed(self):
        original = {"Id": "1" * 64, "Config": {"Env": ["PROJECT_SLUG=demo"], "Hostname": "1" * 12,
                    "Domainname": "", "Image": "old", "Labels": {"image-version": "old", "owner": "kept"}},
                    "HostConfig": {"NetworkMode": "project-network", "Mounts": [], "ReadonlyRootfs": True,
                                   "AutoRemove": False, "ContainerIDFile": "", "Links": None},
                    "Mounts": [{"Type": "bind", "Source": "/task/workspace", "Destination": "/workspace", "RW": True}]}
        unchanged = copy.deepcopy(original)
        request = MODULE.runtime_template_request(original, {"image-version": "old"},
                                                  {"image-version": "new"}, "/task/maintenance",
                                                  ["PROJECT_SLUG=must-not-override", "NODE_PATH=/image/modules"])
        self.assertEqual(original, unchanged)
        self.assertEqual(request["Env"], ["PROJECT_SLUG=demo", "NODE_PATH=/image/modules",
                                         "HARNESS_MAINTENANCE_FENCE_FILE=/run/forge-taskspace-maintenance/proxy-fence.json"])
        self.assertEqual(request["Labels"], {"image-version": "new", "owner": "kept"})
        template = {"Id": "2" * 64, "Image": MODULE.TARGET_IMAGE, "State": {"Status": "created"},
                    "Config": {key: copy.deepcopy(value) for key, value in request.items() if key not in ("HostConfig", "NetworkingConfig")},
                    "HostConfig": copy.deepcopy(request["HostConfig"]), "Mounts": [*original["Mounts"],
                    {"Type": "bind", "Source": "/task/maintenance", "Destination": MODULE.FENCE_DESTINATION, "RW": False}]}
        template["Config"]["Hostname"] = "2" * 12
        MODULE.verify_runtime_template(original, template, request)
        for section, key, value in (("State", "Status", "running"), ("HostConfig", "ReadonlyRootfs", False)):
            altered = copy.deepcopy(template)
            altered[section][key] = value
            with self.assertRaises(RuntimeError):
                MODULE.verify_runtime_template(original, altered, request)
        upload_request = MODULE.runtime_template_request(original, {"image-version": "old"},
                                                          {"image-version": "new"}, None,
                                                          ["PROJECT_SLUG=must-not-override", "NODE_PATH=/image/modules"])
        self.assertEqual(upload_request["Env"], ["PROJECT_SLUG=demo", "NODE_PATH=/image/modules"])
        self.assertEqual(upload_request["HostConfig"]["Mounts"], original["HostConfig"]["Mounts"])
        upload_template = copy.deepcopy(template)
        upload_template["Config"] = {key: copy.deepcopy(value) for key, value in upload_request.items()
                                      if key not in ("HostConfig", "NetworkingConfig")}
        upload_template["Config"]["Hostname"] = "2" * 12
        upload_template["HostConfig"] = copy.deepcopy(upload_request["HostConfig"])
        upload_template["Mounts"] = copy.deepcopy(original["Mounts"])
        MODULE.verify_runtime_template(original, upload_template, upload_request)
        upload_template["Mounts"][0]["RW"] = False
        with self.assertRaisesRegex(RuntimeError, "upload runtime template changed"):
            MODULE.verify_runtime_template(original, upload_template, upload_request)

    def maintenance_template(self, existing):
        fence = {"Type": "bind", "Source": "/task/maintenance", "Destination": MODULE.FENCE_DESTINATION,
                 "RW": False, "Mode": "ro", "Propagation": "rprivate"}
        host_fence = {"Type": "bind", "Source": fence["Source"], "Target": MODULE.FENCE_DESTINATION,
                      "ReadOnly": True, "BindOptions": {"Propagation": "rprivate"}}
        workspace = {"Type": "bind", "Source": "/task/workspace", "Destination": "/workspace",
                     "RW": True, "Mode": "rw", "Propagation": "rprivate"}
        original = {"Id": "1" * 64, "Config": {"Env": ["PROJECT_SLUG=demo"], "Hostname": "1" * 12,
                    "Domainname": "", "Image": "old", "Labels": {}},
                    "HostConfig": {"NetworkMode": "project-network", "ReadonlyRootfs": True,
                    "Mounts": [{"Type": "bind", "Source": workspace["Source"], "Target": "/workspace",
                                "ReadOnly": False, "BindOptions": {"Propagation": "rprivate"}}]},
                    "Mounts": [workspace]}
        if existing:
            original["HostConfig"]["Mounts"].append(host_fence)
            original["Mounts"].append(fence)
            original["Config"]["Env"].append("HARNESS_MAINTENANCE_FENCE_FILE=" + MODULE.FENCE_DESTINATION + "/proxy-fence.json")
        request = MODULE.runtime_template_request(original, {}, {}, None if existing else "/task/maintenance")
        template = {"Id": "2" * 64, "Image": MODULE.TARGET_IMAGE, "State": {"Status": "created"},
                    "Config": {key: copy.deepcopy(value) for key, value in request.items()
                               if key not in ("HostConfig", "NetworkingConfig")},
                    "HostConfig": copy.deepcopy(request["HostConfig"]), "Mounts": [fence, workspace]}
        template["Config"]["Hostname"] = "2" * 12
        return original, template, request

    def test_existing_maintenance_mount_is_preserved_with_all_fields_despite_order(self):
        original, template, request = self.maintenance_template(existing=True)
        template["HostConfig"]["Mounts"].reverse()
        MODULE.verify_runtime_template(original, template, request)
        for key, value in (("Source", "/other/maintenance"), ("RW", True), ("Propagation", "shared"),
                           ("Mode", "rw"), ("Type", "volume"), ("Destination", "/other/target")):
            with self.subTest(key=key):
                changed = copy.deepcopy(template)
                changed["Mounts"][0][key] = value
                with self.assertRaisesRegex(RuntimeError, "changed the original mounts"):
                    MODULE.verify_runtime_template(original, changed, request)

    def test_new_maintenance_mount_uses_destination_instead_of_last_request_entry(self):
        original, template, request = self.maintenance_template(existing=False)
        request["HostConfig"]["Mounts"].reverse()
        self.assertEqual(request["HostConfig"]["Mounts"][-1]["Target"], "/workspace")
        MODULE.verify_runtime_template(original, template, request)
        for key, value in (("Source", "/task/workspace"), ("RW", True), ("Type", "volume")):
            with self.subTest(key=key):
                changed = copy.deepcopy(template)
                changed["Mounts"][0][key] = value
                with self.assertRaisesRegex(RuntimeError, "changed the source/session mounts"):
                    MODULE.verify_runtime_template(original, changed, request)
        changed = copy.deepcopy(template)
        changed["Mounts"].append(copy.deepcopy(changed["Mounts"][0]))
        with self.assertRaisesRegex(RuntimeError, "changed the source/session mounts"):
            MODULE.verify_runtime_template(original, changed, request)

    def test_maintenance_mount_verification_keeps_config_and_other_mount_guards(self):
        for existing in (False, True):
            original, template, request = self.maintenance_template(existing)
            for section, key, value in (("Config", "Env", ["UNREVIEWED=1"]),
                                         ("HostConfig", "ReadonlyRootfs", False), ("State", "Status", "running")):
                with self.subTest(existing=existing, section=section):
                    changed = copy.deepcopy(template)
                    changed[section][key] = value
                    with self.assertRaises(RuntimeError):
                        MODULE.verify_runtime_template(original, changed, request)
            changed = copy.deepcopy(template)
            changed["Mounts"][1]["Source"] = "/other/workspace"
            with self.assertRaises(RuntimeError):
                MODULE.verify_runtime_template(original, changed, request)

    def test_legacy_template_failure_preserves_real_baseline_without_closing_gateway(self):
        gateway = self.root / "gateway-fence.json"
        gateway.write_bytes(b'{"schemaVersion":1,"state":"committed","epoch":"gateway-before"}')
        fence = self.root / "maintenance" / "proxy-fence.json"
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.manifest = {"taskEnv": {"path": str(self.env), "sha256": MODULE.digest(self.original), "uid": 0, "gid": 0},
                            "fence": {"path": str(fence), "exists": False, "sha256": None},
                            "containers": {"harness": {"originalId": "1" * 64}}}
        upgrade.legacy = {"gatewayFence": {"path": str(gateway), "sha256": MODULE.digest(gateway.read_bytes())}}
        upgrade.manifest_sha = "1" * 64
        upgrade.operation = "test-archive-operation"
        upgrade.backup = self.root / "backup"
        upgrade.records = upgrade.backup / "cutover"
        with self.posix_metadata(), mock.patch.object(upgrade, "preflight"), \
                mock.patch.object(upgrade, "create_runtime_template", side_effect=RuntimeError("template contract drift")):
            with self.assertRaisesRegex(RuntimeError, "template contract drift"):
                upgrade.upgrade()
        self.assertEqual(json.loads(gateway.read_bytes())["epoch"], "gateway-before")
        self.assertEqual(json.loads(fence.read_bytes())["state"], "committed")
        self.assertEqual((upgrade.backup / "fence.before").read_bytes(), fence.read_bytes())
        self.assertEqual(json.loads((upgrade.backup / "failure.json").read_bytes())["stage"], "runtime-template")

    def test_existing_unbound_fence_is_reused_without_rewriting_original(self):
        fence = self.root / "proxy-fence.json"
        original = b'{"schemaVersion":1, "state":"committed", "epoch":"legacy-original"}\n'
        fence.write_bytes(original)
        before = fence.stat()
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.manifest = {"fence": {"path": str(fence), "exists": True, "sha256": MODULE.digest(original),
                                      "mode": before.st_mode & 0o7777, "uid": before.st_uid, "gid": before.st_gid}}
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        self.assertEqual(upgrade.prepare_legacy_fence(), original)
        self.assertEqual(fence.read_bytes(), original)
        self.assertEqual(fence.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual((upgrade.backup / "fence.before").read_bytes(), original)
        self.assertEqual(json.loads((upgrade.backup / "local-fence-baseline.json").read_bytes())["sha256"], MODULE.digest(original))

    def test_native_readiness_wait_does_not_retry_session_content_drift(self):
        upgrade = object.__new__(MODULE.Upgrade)
        expected = [{"sessionId": "session-a", "cwd": "/workspace", "blank": False, "running": False, "updatedAt": 1}]
        upgrade.manifest = {"sessions": expected}
        with mock.patch.object(upgrade, "node", side_effect=[RuntimeError("native not listening"), expected]) as node, \
                mock.patch.object(MODULE.time, "sleep"):
            upgrade.sessions("candidate", wait_ready=True)
            self.assertEqual(node.call_count, 2)
        drift = [{**expected[0], "updatedAt": 2}]
        with mock.patch.object(upgrade, "node", side_effect=[drift, expected]) as node:
            with self.assertRaisesRegex(RuntimeError, "metadata changed"):
                upgrade.sessions("candidate", wait_ready=True)
            self.assertEqual(node.call_count, 1)

    def test_restored_fence_endpoint_can_become_open_within_existing_health_wait(self):
        upgrade = object.__new__(MODULE.Upgrade)
        with mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "candidate"}}}), \
                mock.patch.object(upgrade, "inspect", return_value={"State": {"Status": "running", "Health": {"Status": "healthy"}}}), \
                mock.patch.object(upgrade, "node", side_effect=[{"status": 503, "body": {"status": "maintenance"}},
                                                               {"status": 200, "body": {"status": "open"}}]) as node, \
                mock.patch.object(MODULE.time, "sleep"):
            upgrade.wait_for("open endpoints", lambda: upgrade.healthy(require_open=True), 120)
            self.assertEqual(node.call_count, 2)

    def test_prepared_completion_rejects_other_failure_stages_before_container_access(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.legacy = {"gateway": {}}
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        upgrade.manifest_sha = "a" * 64
        failure = {"status": "failed", "stage": "prepare-harness", "manifestSha256": upgrade.manifest_sha,
                   "automaticRollback": False}
        (upgrade.backup / "failure.json").write_text(json.dumps(failure))
        with mock.patch.object(upgrade, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "outside the reviewed"):
                upgrade.preflight_prepared()
            docker.assert_not_called()

    def test_prepared_completion_only_promotes_existing_candidates_and_preserves_failure(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        upgrade.operation = "test-prepared-completion"
        upgrade.manifest_sha = "a" * 64
        fence = self.root / "proxy-fence.json"
        original_fence = b'{"schemaVersion":1,"state":"committed","epoch":"original"}'
        fence.write_bytes(b'{"schemaVersion":1,"state":"maintenance","epoch":"test-prepared-completion"}')
        failure = b'{"status":"failed","stage":"legacy-source-reconciliation"}'
        restoration = b'{"status":"gateway-restored"}'
        for name, data in (("failure.json", failure), ("reviewed-gateway-restoration.json", restoration),
                           ("task.env.before", self.original), ("fence.before", original_fence),
                           ("local-fence-baseline.json", b'{}')):
            (upgrade.backup / name).write_bytes(data)
        upgrade.manifest = {"taskEnv": {"path": str(self.env), "harnessImage": "old-image"},
                            "fence": {"path": str(fence), "exists": True}, "projectSlug": "demo", "taskId": "task-1"}
        upgrade.legacy = {"gateway": {}}
        evidence = {"originalFailureSha256": MODULE.digest(failure), "gatewayRestorationSha256": MODULE.digest(restoration)}
        with self.posix_metadata(), mock.patch.object(upgrade, "preflight_prepared", return_value=evidence), \
                mock.patch.object(upgrade, "healthy"), mock.patch.object(upgrade, "archived"), \
                mock.patch.object(upgrade, "source_preserved"), mock.patch.object(upgrade, "sessions"), \
                mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "existing"}}}), \
                mock.patch.object(upgrade, "cutover") as cutover, mock.patch.object(upgrade, "verify_state", return_value=[]):
            receipt = upgrade.complete_prepared()
        self.assertEqual(cutover.call_args_list, [mock.call("promote", "upload"), mock.call("promote", "harness")])
        self.assertEqual((upgrade.backup / "failure.json").read_bytes(), failure)
        self.assertEqual((upgrade.backup / "reviewed-gateway-restoration.json").read_bytes(), restoration)
        self.assertEqual(fence.read_bytes(), original_fence)
        self.assertEqual(self.env.read_bytes(), self.original.replace(b"old-image", MODULE.TARGET_IMAGE.encode()))
        self.assertEqual(receipt["completionMode"], "complete-prepared")
        self.assertTrue((upgrade.backup / "focused-completion.json").exists())
        self.assertFalse((upgrade.backup / "receipt.json").exists())

    def test_fixed_reader_job_uses_stdin_for_token_and_only_readonly_explicit_mounts(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.archive_reader_image = "sha256:" + "a" * 64
        upgrade.operation = "prepared-test"
        token = "fixture-upload-capability-" + "b" * 40
        payload = {"uploadTarget": {"token": token}, "sessionId": "session-one"}
        success = subprocess.CompletedProcess([], 0, stdout=b'{"ok":true}', stderr=b"")
        with mock.patch.object(MODULE.subprocess, "run", return_value=success) as run:
            upgrade.archive_job("backfill", "process.stdout.write('{}')", payload, network_harness="c" * 64,
                                mounts=[("/owned/secret", "/run/secrets/fixture")], user="1000:983")
        args = run.call_args.args[0]
        self.assertNotIn(token, " ".join(args))
        self.assertIn(token.encode(), run.call_args.kwargs["input"])
        self.assertIn("container:" + "c" * 64, args)
        self.assertIn("type=bind,src=/owned/secret,dst=/run/secrets/fixture,readonly", args)
        self.assertIn("--rm", args)
        self.assertEqual(args[args.index("--pull") + 1], "never")
        self.assertEqual(args[args.index("--log-driver") + 1], "none")
        leaked = subprocess.CompletedProcess([], 0, stdout=token.encode(), stderr=b"")
        with mock.patch.object(MODULE.subprocess, "run", return_value=leaked):
            with self.assertRaisesRegex(RuntimeError, "credential material"):
                upgrade.archive_job("backfill", "", payload)

    def test_backfill_job_consumes_real_service_and_upload_http_response(self):
        harness = SOURCE.parent.parent / "docker/harness"
        fixture = r'''
import http from 'node:http';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const {createUploadServer}=await import(input.uploadModule);
const sessionId='session-backfill-response';const methods=[];let saves=0;
const events=[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'测试归档'}]}},
 {seq:2,type:'assistant/message',data:{message:{content:[{type:'text',text:'测试回复'}]}}},
 {seq:3,type:'turn/end',data:{reason:{kind:'completed'}}}];
const native=http.createServer(async(req,res)=>{
 const chunks=[];for await(const chunk of req)chunks.push(chunk);
 const body=JSON.parse(Buffer.concat(chunks));methods.push(body.method);
 let value;if(body.method==='session.list')value={items:[{sessionId,cwd:'/workspace',blank:false,running:false,updatedAt:1}]};
 else if(body.method==='session.history')value={events:events.map(event=>({event})),hasMore:false};
 else {res.writeHead(400);res.end();return;}
 res.setHeader('content-type','application/json');
 res.end(JSON.stringify({type:'server-response',rpcId:body.rpcId,result:{ok:true,value}}));
});
const upload=await createUploadServer({uploadRoot:path.join(input.root,'uploads'),token:'u'.repeat(64),
 auditScope:{scopeType:'taskspace-private',projectSlug:'archive-test',taskspaceId:'task-test',actorId:'owner-test',conversationId:'conversation-test'}});
upload.on('request',req=>{if(req.method==='POST'&&req.url==='/outputs')saves++;});
async function listen(server){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return server.address().port;}
try{
 const nativePort=await listen(native);const uploadPort=await listen(upload);
 const job=input.job.replace("'/usr/local/lib/conversation-output-service.mjs'",JSON.stringify(input.serviceModule))
  .replace('port:3080,','port:'+nativePort+',');
 const child=spawn(process.execPath,['--input-type=module','-e',job],{stdio:['pipe','pipe','pipe']});
 const out=[];const errors=[];child.stdout.on('data',chunk=>out.push(chunk));child.stderr.on('data',chunk=>errors.push(chunk));
 child.stdin.end(JSON.stringify({sessionId,secretPaths:[],uploadTarget:{host:'127.0.0.1',port:uploadPort,token:'u'.repeat(64)}}));
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 const result=JSON.parse(Buffer.concat(out).toString('utf8'));
 const manifest=result.snapshotId?JSON.parse(await readFile(path.join(input.root,'uploads','outputs',sessionId,result.snapshotId,'manifest.json'),'utf8')):null;
 console.log(JSON.stringify({code,result,manifest:manifest&&{sessionId:manifest.sessionId,snapshotId:manifest.snapshotId,
  eventDigest:manifest.eventDigest,eventCount:manifest.eventCount},methods,saves,stderrBytes:Buffer.concat(errors).length}));
}finally{for(const server of [native,upload]){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
'''
        result = subprocess.run(["node", "--input-type=module", "-e", fixture],
                                input=json.dumps({"root": str(self.root), "job": MODULE.ARCHIVE_BACKFILL_JS,
                                                  "uploadModule": (harness / "upload-server.mjs").as_uri(),
                                                  "serviceModule": (harness / "conversation-output-service.mjs").as_uri()}),
                                text=True, capture_output=True, encoding="utf-8", timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        evidence = json.loads(result.stdout)
        self.assertEqual(evidence["code"], 0, evidence["result"])
        self.assertEqual(evidence["saves"], 1)
        self.assertEqual(evidence["stderrBytes"], 0)
        self.assertEqual(set(evidence["methods"]), {"session.list", "session.history"})
        self.assertEqual(evidence["result"], {**evidence["manifest"],
                         "provenance": "explicit-platform-archive-backfill", "modelRequests": 0})
        self.assertEqual(evidence["result"]["eventCount"], 3)
        self.assertNotIn("idempotent", evidence["result"])

    def test_fixed_reader_requires_other_archive_modules_to_remain_identical(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.archive_reader_image = "sha256:" + "a" * 64
        current = {"forge-recover-headless-execution.mjs": "old", "conversation-output-store.mjs": "unchanged"}
        fixed = {**current, "forge-recover-headless-execution.mjs": MODULE.ARCHIVE_READER_SHA256}
        with mock.patch.object(upgrade, "docker", return_value=upgrade.archive_reader_image.encode()), \
                mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "candidate"}}}), \
                mock.patch.object(upgrade, "node", return_value=current), \
                mock.patch.object(upgrade, "archive_job", return_value=fixed) as job:
            self.assertEqual(upgrade.verify_archive_reader_image(), fixed)
            job.return_value = {**fixed, "conversation-output-store.mjs": "changed"}
            with self.assertRaisesRegex(RuntimeError, "unchanged archive modules"):
                upgrade.verify_archive_reader_image()

    def test_backfill_refuses_any_second_missing_or_nonfrozen_session(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.backfill_session = "session-one"
        upgrade.manifest = {"sessions": [{"sessionId": "session-one"}]}
        missing = {"missing": [{"sessionId": "session-one", "code": "ARCHIVE_PENDING"}]}
        with mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "candidate"}}}), \
                mock.patch.object(upgrade, "node", return_value=missing) as node:
            upgrade.verify_single_missing_archive()
            node.return_value = {"missing": [*missing["missing"], {"sessionId": "session-two", "code": "ARCHIVE_PENDING"}]}
            with self.assertRaisesRegex(RuntimeError, "single missing"):
                upgrade.verify_single_missing_archive()

    def test_stored_archive_review_checks_original_failed_attempt_and_sealed_bytes(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        upgrade.task_root = self.root
        upgrade.manifest_sha = "a" * 64
        upgrade.archive_reader_image = "sha256:" + "b" * 64
        upgrade.backfill_session = "session-saved"
        archive = {"sessionId": upgrade.backfill_session, "snapshotId": "c" * 64,
                   "eventDigest": "d" * 64, "eventCount": 3}
        directory = self.root / "uploads/outputs" / upgrade.backfill_session / archive["snapshotId"]
        directory.mkdir(parents=True)
        sealed = json.dumps(archive).encode()
        (directory / "manifest.json").write_bytes(sealed)
        attempt = json.dumps({"manifestSha256": upgrade.manifest_sha, "archiveReaderImage": upgrade.archive_reader_image,
                              "backfillSession": upgrade.backfill_session,
                              "archiveReaderModules": {"forge-recover-headless-execution.mjs": MODULE.ARCHIVE_READER_SHA256}}).encode()
        failure = json.dumps({"status": "failed", "stage": "explicit-archive-backfill", "manifestSha256": upgrade.manifest_sha,
                              "automaticRollback": False, "originalFailurePreserved": True}).encode()
        for name, content in (("focused-completion-attempt.json", attempt), ("focused-completion-failure.json", failure)):
            (upgrade.backup / name).write_bytes(content)
        upgrade.stored_review = {"previousAttemptSha256": MODULE.digest(attempt), "previousFailureSha256": MODULE.digest(failure),
                                "storedArchive": {key: archive[key] for key in ("snapshotId", "eventDigest", "eventCount")}}
        upgrade.stored_review["storedArchive"]["manifestSha256"] = MODULE.digest(sealed)
        upgrade.verify_stored_backfill()
        (directory / "manifest.json").write_bytes(sealed + b"\n")
        with self.assertRaisesRegex(RuntimeError, "sealed backfill archive changed"):
            upgrade.verify_stored_backfill()
        (directory / "manifest.json").write_bytes(sealed)
        (upgrade.backup / "focused-completion-failure.json").write_bytes(failure + b"\n")
        with self.assertRaisesRegex(RuntimeError, "attempt or failure changed"):
            upgrade.verify_stored_backfill()

    def test_stored_completion_verifies_source_before_promote_never_saves_and_retains_failures(self):
        for source_matches, repair in ((True, False), (False, False), (True, True), (False, True)):
            with self.subTest(source_matches=source_matches, repair=repair):
                upgrade = object.__new__(MODULE.Upgrade)
                upgrade.backup = self.root / (str(source_matches) + "-" + str(repair))
                upgrade.backup.mkdir()
                upgrade.operation, upgrade.manifest_sha = "reviewed-stored-completion", "a" * 64
                sealed = {"snapshotId": "d" * 64, "eventDigest": "e" * 64, "eventCount": 3}
                upgrade.stored_review = {"storedArchive": sealed}
                upgrade.stored_review_bytes, upgrade.stored_review_sha = b'{"review":"frozen"}', "b" * 64
                upgrade.archive_reader_image = "sha256:" + "c" * 64
                upgrade.backfill_session = "session-saved"
                upgrade.stored_source_failure_sha = "f" * 64 if repair else None
                self.env.write_bytes(self.original)
                fence = upgrade.backup / "proxy-fence.json"
                fence_before = b'{"schemaVersion":1,"state":"committed","epoch":"before"}'
                maintenance = b'{"schemaVersion":1,"state":"maintenance","epoch":"reviewed-stored-completion"}'
                fence.write_bytes(maintenance)
                history = {"failure.json": b'{"status":"failed","stage":"legacy-source-reconciliation"}',
                           "reviewed-gateway-restoration.json": b'{"status":"gateway-restored"}',
                           "focused-completion-attempt.json": b'{"original":"attempt"}',
                           "focused-completion-failure.json": b'{"original":"failure"}'}
                if repair:
                    history.update({"stored-archive-review.json": upgrade.stored_review_bytes,
                                    "stored-archive-attempt.json": b'{"previous":"attempt"}',
                                    "stored-archive-failure.json": b'{"previous":"source-failure"}'})
                for name, content in {**history, "task.env.before": self.original,
                                      "fence.before": fence_before, "local-fence-baseline.json": b'{}'}.items():
                    (upgrade.backup / name).write_bytes(content)
                upgrade.manifest = {"taskEnv": {"path": str(self.env), "harnessImage": "old-image"},
                                    "fence": {"path": str(fence), "exists": True}, "projectSlug": "demo", "taskId": "task-1",
                                    "sessions": [{"sessionId": "session-saved", "blank": False}]}
                upgrade.legacy = {"gateway": {}}
                evidence = {"originalFailureSha256": MODULE.digest(history["failure.json"]),
                            "gatewayRestorationSha256": MODULE.digest(history["reviewed-gateway-restoration.json"]),
                            "storedBackfillReviewSha256": upgrade.stored_review_sha}
                calls = []

                def archives(index_only=False):
                    calls.append("index" if index_only else "source")
                    if not source_matches:
                        raise RuntimeError("source archive mismatch")
                    return [{"sessionId": "session-saved", **sealed}]

                with self.posix_metadata(), mock.patch.object(upgrade, "preflight_prepared", return_value=evidence), \
                        mock.patch.object(upgrade, "healthy"), mock.patch.object(upgrade, "archived", side_effect=archives), \
                        mock.patch.object(upgrade, "source_preserved"), mock.patch.object(upgrade, "sessions"), \
                        mock.patch.object(upgrade, "verify_stored_backfill"), mock.patch.object(upgrade, "backfill_archive") as save, \
                        mock.patch.object(upgrade, "verify_stored_source_failure"), \
                        mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "existing"}}}), \
                        mock.patch.object(upgrade, "cutover", side_effect=lambda action, service: calls.append(action + "-" + service)), \
                        mock.patch.object(upgrade, "verify_state", return_value=[]):
                    if source_matches:
                        receipt = upgrade.complete_prepared()
                        self.assertEqual(receipt["completionMode"], "complete-prepared-stored-archive")
                        self.assertFalse(receipt["archiveSaveInvoked"])
                        self.assertEqual(calls, ["source", "index", "promote-upload", "promote-harness"])
                        self.assertEqual(fence.read_bytes(), fence_before)
                        self.assertTrue((upgrade.backup / "stored-archive-completion.json").exists())
                    else:
                        with self.assertRaisesRegex(RuntimeError, "source archive mismatch"):
                            upgrade.complete_prepared()
                        self.assertEqual(calls, ["source"])
                        self.assertEqual(self.env.read_bytes(), self.original)
                        self.assertEqual(fence.read_bytes(), maintenance)
                        failed_name = "stored-source-repair-failure.json" if repair else "stored-archive-failure.json"
                        self.assertEqual(json.loads((upgrade.backup / failed_name).read_bytes())["stage"],
                                         "stored-archive-source-verification")
                    save.assert_not_called()
                for name, content in history.items():
                    self.assertEqual((upgrade.backup / name).read_bytes(), content)
                self.assertFalse((upgrade.backup / "focused-completion.json").exists())

    def test_source_digest_matches_array_json_bytes_and_releases_history_before_archive_reads(self):
        script = "import assert from 'node:assert/strict'; import {createHash} from 'node:crypto';\n" + MODULE.ARCHIVE_SOURCE_DIGEST_JS + r'''
const cases=[[],[{seq:0,type:'中文😀',data:{quote:'"\\\n\t',nested:[null,true,1.5,{汉字:'𠮷'}]}}],
 [{seq:1,type:'a',data:{z:2,a:1}},{seq:2,type:'b',data:{value:-0,text:'\u0000\u2028'}}]];
for(const events of cases)assert.equal(sourceEventDigest(events),createHash('sha256').update(JSON.stringify(events)).digest('hex'));
let historyRef,eventsRef;
async function readPinnedDshConversationHistory(){
 const history={session:{running:false,updatedAt:1},events:structuredClone(cases[1])};
 historyRef=new WeakRef(history);eventsRef=new WeakRef(history.events);return history;
}
const result=await readSourceDigest({sessionId:'session-test',updatedAt:1});
assert.deepEqual(Object.keys(result).sort(),['eventCount','eventDigest']);
assert.equal(result.eventCount,1);
await new Promise(setImmediate);global.gc();
assert.equal(historyRef.deref(),undefined,'history must be collectible before store.read');
assert.equal(eventsRef.deref(),undefined,'raw events must be collectible before store.read');
console.log(JSON.stringify({equivalentCases:cases.length,historyCollectible:true}));
'''
        result = subprocess.run(["node", "--expose-gc", "--input-type=module", "-e", script],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"equivalentCases": 3, "historyCollectible": True})

    def test_failed_archive_job_reports_actual_exit_without_stderr_content(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.archive_reader_image, upgrade.operation = "sha256:" + "a" * 64, "test"
        result = subprocess.CompletedProcess([], 137, stdout=b"", stderr=b"private source body")
        with mock.patch.object(MODULE.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "exit=137") as raised:
                upgrade.archive_job("source-verify", "")
        self.assertNotIn("private source body", str(raised.exception))

    def test_source_repair_rejects_changed_failure_review_and_a_second_attempt(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        upgrade.manifest_sha, upgrade.legacy = "a" * 64, {"gateway": {}}
        upgrade.stored_review, upgrade.stored_review_bytes = {"review": True}, b'{"review":true}'
        failure = {"status": "failed", "stage": "stored-archive-source-verification", "manifestSha256": upgrade.manifest_sha,
                   "automaticRollback": False, "originalFailurePreserved": True}
        failed_bytes = json.dumps(failure).encode()
        upgrade.stored_source_failure_sha = MODULE.digest(failed_bytes)
        (upgrade.backup / "stored-archive-failure.json").write_bytes(failed_bytes)
        (upgrade.backup / "stored-archive-review.json").write_bytes(upgrade.stored_review_bytes)
        (upgrade.backup / "stored-archive-attempt.json").write_bytes(b'{}')
        self.assertEqual(upgrade.verify_stored_source_failure(), {})
        (upgrade.backup / "stored-archive-review.json").write_bytes(upgrade.stored_review_bytes + b"\n")
        with self.assertRaisesRegex(RuntimeError, "original review changed"):
            upgrade.verify_stored_source_failure()
        (upgrade.backup / "stored-archive-review.json").write_bytes(upgrade.stored_review_bytes)
        (upgrade.backup / "stored-archive-failure.json").write_bytes(failed_bytes + b"\n")
        with self.assertRaisesRegex(RuntimeError, "source failure"):
            upgrade.verify_stored_source_failure()
        (upgrade.backup / "stored-source-repair-attempt.json").write_bytes(b'{}')
        with mock.patch.object(upgrade, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "separate review"):
                upgrade.preflight_prepared()
            docker.assert_not_called()

    def test_completed_repair_does_not_ignore_a_conflicting_explicit_failure_digest(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.manifest = {"targetImageId": MODULE.TARGET_IMAGE, "targetImageRef": MODULE.TARGET_REF}
        upgrade.backup = self.root / "backup"
        upgrade.backup.mkdir()
        upgrade.operation, upgrade.manifest_sha, upgrade.legacy = "test", "a" * 64, {"gateway": {}}
        upgrade.stored_source_failure_sha = "b" * 64
        receipt = {"status": "success", "manifestSha256": upgrade.manifest_sha, "targetImageId": MODULE.TARGET_IMAGE,
                   "operation": upgrade.operation, "storedSourceFailureSha256": "c" * 64}
        (upgrade.backup / "stored-archive-completion.json").write_text(json.dumps(receipt))
        with mock.patch.object(upgrade, "docker") as docker:
            with self.assertRaisesRegex(RuntimeError, "source failure differs"):
                upgrade.preflight_prepared()
            docker.assert_not_called()

    def test_every_stored_source_verification_requires_the_reviewed_snapshot(self):
        upgrade = object.__new__(MODULE.Upgrade)
        upgrade.task_root, upgrade.manifest = self.root, {"sessions": []}
        upgrade.archive_reader_image, upgrade.backfill_session = "sha256:" + "a" * 64, "session-saved"
        sealed = {"snapshotId": "b" * 64, "eventDigest": "c" * 64, "eventCount": 3}
        upgrade.stored_review = {"storedArchive": sealed}
        env = ["PROJECT_SLUG=demo", "FORGE_TASKSPACE_ID=task-1", "FORGE_TASKSPACE_ACTOR_ID=owner",
               "FORGE_TASKSPACE_CONVERSATION_ID=conversation-1"]
        expected = {"sessionId": upgrade.backfill_session, **sealed}
        with mock.patch.object(upgrade, "candidates", return_value={"harness": {"candidate": {"id": "candidate"}}}), \
                mock.patch.object(upgrade, "inspect", return_value={"Config": {"Env": env}}), \
                mock.patch.object(upgrade, "archive_job", return_value={"items": [expected], "missing": []}) as job:
            self.assertEqual(upgrade.archived(), [expected])
            job.return_value = {"items": [{**expected, "snapshotId": "d" * 64}], "missing": []}
            with self.assertRaisesRegex(RuntimeError, "reviewed sealed archive"):
                upgrade.archived()


class UpgradedSharedTaskspaceTests(unittest.TestCase):
    posix_metadata = ArchiveUpgradeTests.posix_metadata

    def setUp(self):
        ArchiveUpgradeTests.setUp(self)
        task = "/srv/forge-delivery/projects/forge-base/taskspaces/legacy-history-20260827"
        binding = lambda path: {"path": path, "exists": True, "sha256": "a" * 64, "mode": 0o600, "uid": 1000, "gid": 983}
        sessions = [{"sessionId": MODULE.UPGRADED_READER_SESSION if i == 0 else f"session-{i}",
                     "cwd": "/workspace", "blank": i == 40, "running": False, "updatedAt": i + 1} for i in range(41)]
        self.manifest = {
            "schemaVersion": MODULE.SCHEMA, "projectSlug": "forge-base", "taskId": "legacy-history-20260827",
            "targetImageId": MODULE.UPGRADED_TARGET_IMAGE, "targetImageRef": MODULE.UPGRADED_TARGET_REF,
            "containers": {service: {"originalId": str(i) * 64, "sourceImageId": MODULE.TARGET_IMAGE, "name": service}
                           for i, service in enumerate(MODULE.SERVICES, 1)},
            "taskEnv": {**binding(task + "/task.env"), "harnessImage": MODULE.TARGET_IMAGE},
            "cutoverHelper": binding(MODULE.CUTOVER_HELPER), "fence": binding(task + "/maintenance/proxy-fence.json"),
            "protectedFiles": [binding(task + "/metadata.json"), binding(task + "/compose.network.override.yaml")],
            "workspaceHead": "a" * 40, "workspaceStatusSha256": "b" * 64, "sessions": sessions,
        }
        previous = copy.deepcopy(self.manifest)
        previous.update(targetImageId=MODULE.TARGET_IMAGE, targetImageRef=MODULE.TARGET_REF)
        self.archives = [{"sessionId": item["sessionId"], "snapshotId": f"{i+1:064x}", "eventDigest": f"{i+101:064x}",
                          "eventCount": 785584 if i == 0 else 2} for i, item in enumerate(sessions[:40])]
        receipt = {"status": "success", "operation": MODULE.PRIOR_OPERATION, "manifestSha256": MODULE.PRIOR_MANIFEST_SHA256,
                   "projectSlug": "forge-base", "taskId": "legacy-history-20260827", "targetImageId": MODULE.TARGET_IMAGE,
                   "sourceArchivesVerifiedBeforeCompletion": 40, "completionMode": "complete-prepared-stored-archive",
                   "preparedCandidates": {service: {"candidateId": item["originalId"]} for service, item in self.manifest["containers"].items()},
                   "archives": self.archives}
        self.external = {}
        prior = {}
        for key, name, value in (("manifest", "manifest.json", previous), ("receipt", "stored-archive-completion.json", receipt)):
            path = f"/srv/forge-delivery/platform-backups/{MODULE.PRIOR_OPERATION}/{name}"
            data = json.dumps(value, sort_keys=True).encode()
            self.external[path] = data
            prior[key] = {"path": path, "sha256": MODULE.digest(data)}
        self.manifest["priorArchiveVerification"] = prior
        receipt_pin = mock.patch.object(MODULE, "PRIOR_RECEIPT_SHA256", prior["receipt"]["sha256"])
        receipt_pin.start()
        self.addCleanup(receipt_pin.stop)
        original_read = MODULE.regular_bytes
        reader = mock.patch.object(MODULE, "regular_bytes", side_effect=lambda path:
                                   self.external[str(path)] if str(path) in self.external else original_read(path))
        reader.start()
        self.addCleanup(reader.stop)
        self.upgrade = MODULE.Upgrade(self.manifest, "e" * 64)
        self.upgrade.task_root = self.root
        self.upgrade.backup = self.root / "backup"
        self.upgrade.records = self.upgrade.backup / "cutover"
        for item in self.archives:
            path = self.root / "uploads/outputs" / item["sessionId"] / item["snapshotId"] / "manifest.json"
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({**item, "schemaVersion": "forge-conversation-output-manifest/v1",
                                        "scope": {"projectSlug": "forge-base", "taskspaceId": "legacy-history-20260827"}}))

    def test_upgraded_target_is_fixed_and_original_target_and_operation_semantics_remain(self):
        self.assertEqual(self.upgrade.target_image, MODULE.UPGRADED_TARGET_IMAGE)
        self.assertIsNone(self.upgrade.legacy)
        self.assertEqual(self.upgrade.operation, "taskspace-archive-" + "e" * 20)
        old = copy.deepcopy(self.manifest)
        old.pop("priorArchiveVerification")
        old.update(targetImageId=MODULE.TARGET_IMAGE, targetImageRef=MODULE.TARGET_REF)
        original = MODULE.Upgrade(old, MODULE.PRIOR_MANIFEST_SHA256)
        self.assertEqual(original.target_image, MODULE.TARGET_IMAGE)
        self.assertEqual(original.target_ref, MODULE.TARGET_REF)
        self.assertEqual(original.operation, MODULE.PRIOR_OPERATION)
        for changes in ({"targetImageRef": MODULE.TARGET_REF}, {"legacyMaintenance": {}},
                        {"taskId": "another-task"}, {"fence": {**self.manifest["fence"], "exists": False}}):
            with self.subTest(changes=changes), self.assertRaises(RuntimeError):
                MODULE.validate_manifest({**self.manifest, **changes})
        with self.assertRaisesRegex(RuntimeError, "prior archive verification"):
            MODULE.validate_manifest({**old, "priorArchiveVerification": self.manifest["priorArchiveVerification"]})

    def test_prior_source_rejects_changed_bytes_sessions_and_exact_snapshot_metadata(self):
        self.assertEqual(self.upgrade.prior_archives(), self.archives)
        receipt_path = self.manifest["priorArchiveVerification"]["receipt"]["path"]
        self.external[receipt_path] += b"\n"
        with self.assertRaisesRegex(RuntimeError, "evidence bytes changed"):
            self.upgrade.prior_archives()
        self.external[receipt_path] = self.external[receipt_path][:-1]
        self.manifest["sessions"][0]["updatedAt"] += 1
        with self.assertRaisesRegex(RuntimeError, "session metadata differs"):
            self.upgrade.prior_archives()
        self.manifest["sessions"][0]["updatedAt"] -= 1
        item = self.archives[0]
        path = self.root / "uploads/outputs" / item["sessionId"] / item["snapshotId"] / "manifest.json"
        value = json.loads(path.read_bytes())
        value["eventDigest"] = "f" * 64
        path.write_text(json.dumps(value))
        with self.assertRaisesRegex(RuntimeError, "archive snapshot changed"):
            self.upgrade.prior_archives()

    def test_actual_reader_reads_one_source_then_verification_only_checks_identity_and_metadata(self):
        self.upgrade.backup.mkdir()
        candidate = "c" * 64
        modes = []

        def node(container, script, session, mode, reader_sha):
            self.assertEqual(container, candidate)
            self.assertEqual(script, MODULE.UPGRADED_READER_JS)
            self.assertEqual(reader_sha, MODULE.ARCHIVE_READER_SHA256)
            modes.append(mode)
            result = {"readerSha256": MODULE.ARCHIVE_READER_SHA256}
            if mode == "source":
                self.assertEqual(json.loads(session), self.manifest["sessions"][0])
                result.update({key: self.archives[0][key] for key in ("eventDigest", "eventCount")})
            return result

        with mock.patch.object(self.upgrade, "candidates", return_value={"harness": {"candidate": {"id": candidate}}}), \
                mock.patch.object(self.upgrade, "inspect", return_value={"Id": candidate, "Image": MODULE.UPGRADED_TARGET_IMAGE}), \
                mock.patch.object(self.upgrade, "node", side_effect=node), mock.patch.object(self.upgrade, "backfill_archive") as save:
            self.upgrade.upgraded_reader_verification(self.archives, read_once=True)
            self.assertEqual(self.upgrade.archived(), self.archives)
            self.assertEqual(self.upgrade.archived(), self.archives)
            self.assertEqual(self.upgrade.archived(index_only=True), self.archives)
            with self.assertRaisesRegex(RuntimeError, "do not repeat history reads"):
                self.upgrade.upgraded_reader_verification(self.archives, read_once=True)
            save.assert_not_called()
        self.assertEqual(modes, ["source", "identity", "identity"])
        evidence = json.loads((self.upgrade.backup / "upgraded-reader-verification.json").read_bytes())
        self.assertEqual((evidence["sourceArchivesReused"], evidence["actualReaderHistoriesVerified"]), (40, 1))

    def test_actual_reader_failure_keeps_prepared_state_and_does_not_retry_or_update_env(self):
        fence = self.root / "proxy-fence.json"
        original_fence = b'{"schemaVersion":1,"state":"committed","epoch":"before"}'
        fence.write_bytes(original_fence)
        self.manifest["taskEnv"].update(path=str(self.env), sha256=MODULE.digest(self.original), harnessImage="old-image")
        self.manifest["fence"].update(path=str(fence), sha256=MODULE.digest(original_fence))
        with self.posix_metadata(), mock.patch.object(self.upgrade, "preflight"), \
                mock.patch.object(self.upgrade, "drained"), mock.patch.object(self.upgrade, "sessions"), \
                mock.patch.object(self.upgrade, "source_preserved"), mock.patch.object(self.upgrade, "healthy"), \
                mock.patch.object(self.upgrade, "cutover") as cutover, \
                mock.patch.object(self.upgrade, "inspect", return_value={"Id": "retained", "State": {"Status": "exited"}}), \
                mock.patch.object(self.upgrade, "candidates", return_value={"harness": {"candidate": {"id": "candidate"}}}), \
                mock.patch.object(self.upgrade, "archived", return_value=self.archives), \
                mock.patch.object(self.upgrade, "upgraded_reader_verification", side_effect=RuntimeError("actual reader failed")) as reader:
            with self.assertRaisesRegex(RuntimeError, "actual reader failed"):
                self.upgrade.upgrade()
            self.assertEqual(reader.call_count, 1)
            self.assertTrue(all(call.args[0] != "promote" for call in cutover.call_args_list))
            self.assertEqual(self.env.read_bytes(), self.original)
            self.assertEqual(json.loads(fence.read_bytes())["state"], "maintenance")
            failure = json.loads((self.upgrade.backup / "failure.json").read_bytes())
            self.assertEqual(failure["stage"], "actual-upgraded-reader-verification")
            self.assertFalse((self.upgrade.backup / "receipt.json").exists())
            with self.assertRaisesRegex(RuntimeError, "operator review required"):
                self.upgrade.upgrade()
            self.assertEqual(reader.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
