#!/usr/bin/env python3
"""Provision only the Delivery Center database on the existing MySQL server.

The default action is a read-only plan. --apply saves dedicated credentials on
the application host before any database mutation, then creates the dedicated
schema/accounts. No business database, shared credential, Gateway or service is
modified. Secrets travel through stdin and are never included in receipts.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import secrets
import select
import shlex
import socketserver
import subprocess
import threading
import time

import paramiko


ROOT = Path(__file__).resolve().parents[1]
APPLICATION_HOST = "192.0.2.12"
DATABASE_HOST = "192.0.2.209"
DATABASE_NAME = "forge_delivery_center"
PRIVATE_ROOT = "/srv/forge-delivery/conversation-control-plane/delivery-center"
ACCOUNTS = {"reader": "forge_delivery_reader", "writer": "forge_delivery_writer"}
PRIVILEGES = {"reader": {"SELECT"}, "writer": {"SELECT", "INSERT", "UPDATE", "DELETE"}}
MYSQL = "/usr/local/mysql/bin/mysql"
SCHEMA = ROOT / "docker/harness/delivery-center-schema.sql"
EXPECTED_TABLES = {"delivery_center_projects", "delivery_center_batches", "delivery_center_menus",
                   "delivery_center_requirements", "delivery_center_requirement_versions",
                   "delivery_center_requirement_batches", "delivery_center_requirement_sources",
                   "delivery_center_stages", "delivery_center_releases",
                   "delivery_center_release_requirements", "delivery_center_artifacts"}
PASSWORD_PATTERN = re.compile(r"^[A-Za-z0-9_-]{48,128}$")

# This fixed program receives data only on stdin, after sudo consumes its own
# password. It does not execute supplied paths, shell expressions or SQL.
PRIVATE_CONFIG_PROGRAM = r'''
import json, os, pathlib, pwd, re, stat, sys
request=json.load(sys.stdin)
if set(request) not in ({'action'}, {'action','configs'}) or request['action'] not in ('inspect','save'):
    raise RuntimeError('PRIVATE_REQUEST_INVALID')
root=pathlib.Path('/srv/forge-delivery/conversation-control-plane/delivery-center')
owner=pwd.getpwnam('forge')
users={'reader':'forge_delivery_reader','writer':'forge_delivery_writer'}
def validate(value,kind):
    if (not isinstance(value,dict) or set(value)!={'host','port','user','password','database'}
        or value['host']!='192.0.2.209' or value['port']!=3306
        or value['user']!=users[kind] or value['database']!='forge_delivery_center'
        or not isinstance(value['password'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{48,128}',value['password'])):
        raise RuntimeError('PRIVATE_CONFIG_INVALID')
    return value
def read(kind):
    filename=root/(kind+'.json')
    try: info=filename.lstat()
    except FileNotFoundError: return None
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or stat.S_IMODE(info.st_mode)!=0o600 or info.st_uid!=owner.pw_uid or info.st_size>16384:
        raise RuntimeError('PRIVATE_CONFIG_IDENTITY_INVALID')
    return validate(json.loads(filename.read_text()),kind)
try:
    info=root.lstat()
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode)!=0o700 or info.st_uid!=owner.pw_uid:
        raise RuntimeError('PRIVATE_DIRECTORY_IDENTITY_INVALID')
except FileNotFoundError:
    if request['action']=='save':
        parent=root.parent
        if parent.resolve()!=parent or not parent.is_dir():raise RuntimeError('PRIVATE_PARENT_INVALID')
        root.mkdir(mode=0o700)
        os.chown(root,owner.pw_uid,owner.pw_gid)
if request['action']=='save':
    if set(request['configs'])!=set(users):raise RuntimeError('PRIVATE_CONFIG_SET_INVALID')
    for kind in users:
        proposed=validate(request['configs'][kind],kind)
        existing=read(kind)
        if existing is not None:
            if existing!=proposed:raise RuntimeError('PRIVATE_CONFIG_CHANGED')
            continue
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,'O_NOFOLLOW',0)
        descriptor=os.open(root/(kind+'.json'),flags,0o600)
        with os.fdopen(descriptor,'w') as output:
            os.fchown(output.fileno(),owner.pw_uid,owner.pw_gid)
            os.fchmod(output.fileno(),0o600)
            output.write(json.dumps(proposed,separators=(',',':'))+'\n')
            output.flush();os.fsync(output.fileno())
    descriptor=os.open(root,os.O_RDONLY|getattr(os,'O_DIRECTORY',0))
    try:os.fsync(descriptor)
    finally:os.close(descriptor)
print(json.dumps({'ownerUid':owner.pw_uid,'ownerGid':owner.pw_gid,'configs':{kind:read(kind) for kind in users}}))
'''

AUTH_PROGRAM = r'''
const mysql=require('mysql2/promise');let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',async()=>{
  let connection;
  try {
    const config=JSON.parse(input);
    connection=await mysql.createConnection({host:'127.0.0.1',port:config.tunnelPort,
      user:config.user,password:config.password,connectTimeout:10000,multipleStatements:false});
    const [[row]]=await connection.query('SELECT CURRENT_USER() AS account,VERSION() AS version');
    console.log(JSON.stringify({ok:true,account:row.account,version:row.version}));
  } catch(error) { console.log(JSON.stringify({ok:false,code:error.code||'AUTH_FAILED'}));process.exitCode=1; }
  finally {if(connection)await connection.end();}
});
'''


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def credential_loader():
    location = ROOT / "scripts/guanghui_phase2_database.py"
    spec = importlib.util.spec_from_file_location("delivery_database_credentials", location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.load_local_credential


def bounded_channel(channel, timeout=30, maximum=512 * 1024):
    outputs = [bytearray(), bytearray()]
    deadline = time.monotonic() + timeout
    while True:
        for index, ready, receive in [(0, channel.recv_ready, channel.recv),
                                       (1, channel.recv_stderr_ready, channel.recv_stderr)]:
            while ready():
                outputs[index].extend(receive(65536))
                need(len(outputs[index]) <= maximum, "REMOTE_OUTPUT_LIMIT")
        if channel.exit_status_ready() and not channel.recv_ready() and not channel.recv_stderr_ready():
            return bytes(outputs[0]), bytes(outputs[1]), channel.recv_exit_status()
        if time.monotonic() >= deadline:
            channel.close()
            raise RuntimeError("REMOTE_DEADLINE")
        time.sleep(0.02)


def connect(host, username, **authentication):
    client = paramiko.SSHClient()
    client.load_host_keys(str(Path.home() / ".ssh/known_hosts"))
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect(host, username=username, allow_agent=False, look_for_keys=False,
                       timeout=10, auth_timeout=15, **authentication)
        return client
    except Exception:
        client.close()
        raise RuntimeError("STRICT_SSH_AUTHENTICATION_FAILED") from None


def private_configs(client, sudo_password, action="inspect", configs=None):
    request = {"action": action}
    if configs is not None:
        request["configs"] = configs
    command = shlex.join(["sudo", "-S", "-p", "", "--", "python3", "-c", PRIVATE_CONFIG_PROGRAM])
    stdin, stdout, _ = client.exec_command(command, timeout=30)
    stdin.write(sudo_password + "\n" + json.dumps(request))
    stdin.flush()
    stdin.channel.shutdown_write()
    data, _, code = bounded_channel(stdout.channel)
    need(code == 0, "PRIVATE_CONFIGURATION_OPERATION_FAILED")
    try:
        return json.loads(data)
    except Exception:
        raise RuntimeError("PRIVATE_CONFIGURATION_RESPONSE_INVALID") from None


def mysql(client, password, sql):
    arguments = [MYSQL, "--no-defaults", "--protocol=SOCKET", "--socket=/tmp/mysql3306.sock",
                 "--user=root", "--default-character-set=utf8mb4", "--batch", "--raw", "--skip-column-names"]
    source = 'IFS= read -r mysql_password || exit 2; export MYSQL_PWD="$mysql_password"; exec ' + shlex.join(arguments)
    stdin, stdout, _ = client.exec_command(shlex.join(["sh", "-c", source]), timeout=45)
    stdin.write(password + "\n" + sql + "\n")
    stdin.flush()
    stdin.channel.shutdown_write()
    data, error, code = bounded_channel(stdout.channel, timeout=45)
    if code:
        match = re.search(rb"ERROR\s+(\d+)", data + error)
        raise RuntimeError("DATABASE_OPERATION_FAILED" + ("_" + match.group(1).decode() if match else ""))
    return data.decode("utf-8").strip()


@contextmanager
def database_tunnel(application_client):
    transport = application_client.get_transport()

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            channel = None
            try:
                channel = transport.open_channel("direct-tcpip", (DATABASE_HOST, 3306), self.client_address, timeout=10)
                while True:
                    readable, _, _ = select.select([self.request, channel], [], [], 15)
                    if not readable:
                        break
                    for source in readable:
                        value = source.recv(65536)
                        if not value:
                            return
                        (channel if source is self.request else self.request).sendall(value)
            except Exception:
                # Authentication reports a bounded error code; never print socket
                # exceptions or the credentials held by the caller.
                return
            finally:
                if channel is not None:
                    channel.close()

    class Server(socketserver.ThreadingTCPServer):
        daemon_threads = True
        allow_reuse_address = False

        def handle_error(self, request, client_address):
            return

    server = Server(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def authenticate_account(application_client, config):
    with database_tunnel(application_client) as port:
        try:
            result = subprocess.run(["node", "-e", AUTH_PROGRAM], cwd=ROOT,
                                    input=json.dumps({**config, "tunnelPort": port}), text=True,
                                    capture_output=True, timeout=20, check=False)
            response = json.loads(result.stdout)
            need(result.returncode == 0 and response.get("ok") is True, "DEDICATED_ACCOUNT_AUTHENTICATION_FAILED")
            need(response.get("account") == config["user"] + "@" + APPLICATION_HOST,
                 "DEDICATED_ACCOUNT_IDENTITY_MISMATCH")
        except Exception:
            raise RuntimeError("DEDICATED_ACCOUNT_AUTHENTICATION_FAILED") from None


def schema_source():
    raw = SCHEMA.read_bytes()
    source = raw.decode("utf-8-sig")
    statements = [part.strip() for part in re.sub(r"^--.*$", "", source, flags=re.MULTILINE).split(";") if part.strip()]
    names = []
    for statement in statements:
        match = re.match(r"^CREATE TABLE IF NOT EXISTS (delivery_center_[a-z_]+)\s*\(", statement)
        need(match is not None, "SCHEMA_STATEMENT_NOT_ALLOWED")
        names.append(match.group(1))
    need(len(names) == len(EXPECTED_TABLES) and set(names) == EXPECTED_TABLES, "SCHEMA_TABLE_SET_INVALID")
    return statements, set(names), hashlib.sha256(raw).hexdigest()


def grant_scope(partial_revokes):
    # MySQL treats '_' in database-level grants as a wildcard when partial
    # revokes is disabled. Escape it so privileges apply to this database only.
    return "`" + (DATABASE_NAME if partial_revokes else DATABASE_NAME.replace("_", r"\_")) + "`.*"


def inspect_grants(grants, kind, scope, exact=False):
    actual = set()
    for line in grants.splitlines():
        need("WITH GRANT OPTION" not in line, "DEDICATED_ACCOUNT_HAS_GRANT_OPTION")
        match = re.match(r"^GRANT (.+?) ON (.+?) TO ", line)
        need(match is not None, "DEDICATED_ACCOUNT_UNEXPECTED_GRANT")
        privileges = {item.strip() for item in match.group(1).split(",")}
        if match.group(2) == "*.*" and privileges == {"USAGE"}:
            continue
        need(match.group(2) == scope, "DEDICATED_ACCOUNT_SCOPE_MISMATCH")
        actual.update(privileges)
    need(actual <= PRIVILEGES[kind], "DEDICATED_ACCOUNT_PRIVILEGE_MISMATCH")
    if exact:
        need(actual == PRIVILEGES[kind], "DEDICATED_ACCOUNT_PRIVILEGES_INCOMPLETE")
    return sorted(actual)


def inspect_database(client, password, expected_tables):
    identity = json.loads(mysql(client, password,
        "SELECT JSON_OBJECT('version',VERSION(),'account',CURRENT_USER(),'partialRevokes',@@partial_revokes);"))
    need(identity["version"].startswith("8.0.") and identity["account"] == "root@localhost", "DATABASE_INSTANCE_MISMATCH")
    raw_schema = mysql(client, password,
        "SELECT DEFAULT_CHARACTER_SET_NAME,DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA "
        "WHERE SCHEMA_NAME='forge_delivery_center';")
    if raw_schema:
        need(raw_schema.split("\t") == ["utf8mb4", "utf8mb4_0900_bin"], "EXISTING_DATABASE_FORMAT_MISMATCH")
    raw_tables = mysql(client, password,
        "SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA='forge_delivery_center' ORDER BY TABLE_NAME;")
    tables = set()
    for line in raw_tables.splitlines():
        name, kind = line.split("\t")
        need(name in expected_tables and kind == "BASE TABLE", "EXISTING_DATABASE_OBJECT_MISMATCH")
        tables.add(name)
    raw_accounts = mysql(client, password,
        "SELECT User,Host FROM mysql.user WHERE User IN ('forge_delivery_reader','forge_delivery_writer') ORDER BY User,Host;")
    accounts = set()
    for line in raw_accounts.splitlines():
        username, host = line.split("\t")
        need(host == APPLICATION_HOST, "EXISTING_ACCOUNT_HOST_MISMATCH")
        accounts.add(username)
    return {"identity": identity, "databaseExists": bool(raw_schema), "tables": tables, "accounts": accounts}


def run(apply, receipt_path):
    statements, expected_tables, schema_digest = schema_source()
    load_credential = credential_loader()
    ssh_password = load_credential(ROOT / "数据库服务器账号密码.txt")
    mysql_password = load_credential(ROOT / "数据库账号密码.txt")
    sudo_password = load_credential(ROOT / "服务器账号密码.txt")
    application = database = None
    stage = "connect"
    receipt = {"schemaVersion": 1, "operation": "apply" if apply else "plan", "database": DATABASE_NAME,
               "databaseHost": DATABASE_HOST, "applicationHost": APPLICATION_HOST,
               "schemaSha256": schema_digest, "startedAt": datetime.now(timezone.utc).isoformat(),
               "remoteWritesStarted": False}
    secret_values = [ssh_password, mysql_password, sudo_password]
    try:
        application = connect(APPLICATION_HOST, "forge", key_filename=str(Path.home() / ".ssh/id_ed25519_forge_delivery"))
        database = connect(DATABASE_HOST, "root", password=ssh_password)
        stage = "read-only-preflight"
        private = private_configs(application, sudo_password)
        configs = private["configs"]
        existing = inspect_database(database, mysql_password, expected_tables)
        scope = grant_scope(bool(existing["identity"]["partialRevokes"]))
        for kind, username in ACCOUNTS.items():
            if configs[kind] is not None:
                secret_values.append(configs[kind]["password"])
            if username in existing["accounts"]:
                need(configs[kind] is not None, "EXISTING_ACCOUNT_WITHOUT_TASK_CREDENTIALS")
                authenticate_account(application, configs[kind])
                grants = mysql(database, mysql_password, f"SHOW GRANTS FOR '{username}'@'{APPLICATION_HOST}';")
                inspect_grants(grants, kind, scope)
        if existing["databaseExists"]:
            need(all(configs[kind] is not None for kind in ACCOUNTS), "EXISTING_DATABASE_WITHOUT_TASK_CREDENTIALS")
        receipt.update({"mysqlVersion": existing["identity"]["version"], "ownerUid": private["ownerUid"],
                        "databaseExisted": existing["databaseExists"], "existingTableCount": len(existing["tables"]),
                        "existingAccounts": sorted(existing["accounts"]), "accountHost": APPLICATION_HOST,
                        "credentialFiles": [PRIVATE_ROOT + "/" + kind + ".json" for kind in ACCOUNTS],
                        "requiredPrivileges": {kind: sorted(value) for kind, value in PRIVILEGES.items()}})
        if not apply:
            receipt["status"] = "plan-ready"
            return receipt
        # Check the local authentication dependency before the first mutation.
        dependency = subprocess.run(["node", "-e", "require('mysql2/promise')"], cwd=ROOT, capture_output=True, timeout=10)
        need(dependency.returncode == 0, "LOCAL_MYSQL_CLIENT_UNAVAILABLE")
        for kind, username in ACCOUNTS.items():
            if configs[kind] is None:
                configs[kind] = {"host": DATABASE_HOST, "port": 3306, "user": username,
                                 "password": secrets.token_urlsafe(48), "database": DATABASE_NAME}
                secret_values.append(configs[kind]["password"])
        stage = "save-private-credentials"
        receipt["remoteWritesStarted"] = True
        saved = private_configs(application, sudo_password, "save", configs)
        need(saved["configs"] == configs, "SAVED_CREDENTIALS_MISMATCH")
        # Recheck the metadata after saving credentials. Another operation must
        # not create or change this target between admission and DDL.
        latest = inspect_database(database, mysql_password, expected_tables)
        need(latest == existing, "DATABASE_PREFLIGHT_CHANGED")
        stage = "create-dedicated-database"
        mysql(database, mysql_password, "CREATE DATABASE IF NOT EXISTS `forge_delivery_center` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin;")
        stage = "initialize-dedicated-tables"
        for statement in statements:
            mysql(database, mysql_password, "USE `forge_delivery_center`;\n" + statement + ";")
        stage = "create-dedicated-accounts"
        for kind, username in ACCOUNTS.items():
            password = configs[kind]["password"]
            need(PASSWORD_PATTERN.fullmatch(password) is not None, "DEDICATED_PASSWORD_FORMAT_INVALID")
            if username not in existing["accounts"]:
                mysql(database, mysql_password, f"CREATE USER '{username}'@'{APPLICATION_HOST}' IDENTIFIED BY '{password}';")
            privileges = ", ".join(sorted(PRIVILEGES[kind]))
            mysql(database, mysql_password, f"GRANT {privileges} ON {scope} TO '{username}'@'{APPLICATION_HOST}';")
        stage = "verify-dedicated-database"
        result = inspect_database(database, mysql_password, expected_tables)
        need(result["tables"] == expected_tables and result["accounts"] == set(ACCOUNTS.values()), "DATABASE_RESULT_INCOMPLETE")
        verified = {}
        for kind, username in ACCOUNTS.items():
            authenticate_account(application, configs[kind])
            grants = mysql(database, mysql_password, f"SHOW GRANTS FOR '{username}'@'{APPLICATION_HOST}';")
            verified[kind] = inspect_grants(grants, kind, scope, exact=True)
        receipt.update({"status": "verified", "tableCount": len(result["tables"]),
                        "tables": sorted(result["tables"]), "verifiedPrivileges": verified,
                        "credentialMode": "0600", "directoryMode": "0700", "credentialsRotated": False,
                        "gatewayCredentialsMounted": False, "servicesStarted": False})
        return receipt
    except Exception as error:
        # Do not print exception messages from SSH, SQL or JSON decoders. Only
        # our bounded uppercase error codes are eligible for the receipt.
        code = str(error) if isinstance(error, RuntimeError) and re.fullmatch(r"[A-Z0-9_]+", str(error)) else type(error).__name__
        receipt.update({"status": "failed", "failedStage": stage, "errorCode": code})
        return receipt
    finally:
        if application is not None:
            application.close()
        if database is not None:
            database.close()
        receipt["finishedAt"] = datetime.now(timezone.utc).isoformat()
        encoded = json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
        need(not any(value and value in encoded for value in secret_values), "RECEIPT_SECRET_REJECTED")
        if receipt_path is not None:
            receipt_path.parent.mkdir(parents=True, exist_ok=True)
            # Preserve an existing run receipt rather than overwriting failure
            # evidence during an operator-authorized resume.
            with receipt_path.open("x", encoding="utf-8") as output:
                output.write(encoded)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Explicitly create the dedicated database/accounts after the read-only preflight.")
    parser.add_argument("--receipt", type=Path, help="New local JSON receipt path; required with --apply and never overwritten.")
    args = parser.parse_args()
    if args.apply and args.receipt is None:
        parser.error("--apply requires --receipt")
    if args.receipt is not None and args.receipt.exists():
        parser.error("receipt already exists; preserve it and choose a new path")
    result = run(args.apply, args.receipt)
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] in {"plan-ready", "verified"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
