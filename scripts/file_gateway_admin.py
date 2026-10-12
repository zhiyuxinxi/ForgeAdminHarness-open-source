#!/usr/bin/env python3
"""Provision the bounded SFTPGo upload group and bootstrap users."""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


PROJECT_SLUG = re.compile(r"^[a-z][a-z0-9-]{2,31}$")
USERNAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$")
UPLOAD_PERMISSIONS = ["list", "upload", "create_dirs"]
READ_ONLY_ACCOUNT_FIELDS = {
    "created_at",
    "updated_at",
    "last_login",
    "last_password_change",
    "has_password",
}


class ApiError(RuntimeError):
    """Raised for an unexpected SFTPGo API response."""


def validate_projects(projects: list[str]) -> list[str]:
    result = sorted(set(projects))
    if not result:
        raise ValueError("at least one project slug is required")
    invalid = [slug for slug in result if not PROJECT_SLUG.fullmatch(slug)]
    if invalid:
        raise ValueError(f"invalid project slug(s): {', '.join(invalid)}")
    return result


def build_permissions(projects: list[str]) -> dict[str, list[str]]:
    permissions: dict[str, list[str]] = {"/": ["list"]}
    for slug in validate_projects(projects):
        permissions[f"/{slug}"] = list(UPLOAD_PERMISSIONS)
    return permissions


def build_group_payload(group_name: str, projects: list[str]) -> dict[str, Any]:
    return {
        "name": group_name,
        "description": "Managed upload access to all registered Forge delivery projects",
        "user_settings": {
            "home_dir": "/srv/sftpgo/data",
            "permissions": build_permissions(projects),
            "filesystem": {"provider": 0},
        },
        "virtual_folders": [],
    }


def build_user_payload(
    username: str, password: str, group_name: str, description: str
) -> dict[str, Any]:
    if not USERNAME.fullmatch(username):
        raise ValueError(
            "username must be 3-64 characters using letters, digits, dot, underscore or hyphen"
        )
    if len(password) < 20:
        raise ValueError("generated/user password must contain at least 20 characters")
    return {
        "status": 1,
        "username": username,
        "password": password,
        "description": description,
        "home_dir": "/srv/sftpgo/data",
        "permissions": {"/": ["list"]},
        "filesystem": {"provider": 0},
        "groups": [{"name": group_name, "type": 1}],
    }


def build_password_update_payload(
    current: dict[str, Any], password: str
) -> dict[str, Any]:
    if len(password) < 8:
        raise ValueError("replacement password must contain at least 8 characters")
    payload = dict(current)
    for field in READ_ONLY_ACCOUNT_FIELDS:
        payload.pop(field, None)
    payload["password"] = password
    return payload


class SftpGoClient:
    def __init__(self, endpoint: str, username: str, password: str) -> None:
        self.endpoint = endpoint.rstrip("/")
        if not self.endpoint.startswith(("http://", "https://")):
            raise ValueError("endpoint must use http or https")
        self.username = username
        self.password = password
        self.token = self._get_token()

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200,),
        allow_not_found: bool = False,
    ) -> tuple[int, dict[str, Any] | None]:
        data = None
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        if payload is not None:
            data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            f"{self.endpoint}{path}", data=data, headers=headers, method=method
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                body = response.read()
                parsed = json.loads(body) if body else None
                if response.status not in expected:
                    raise ApiError(f"unexpected HTTP {response.status} for {method} {path}")
                return response.status, parsed
        except urllib.error.HTTPError as exc:
            if allow_not_found and exc.code == 404:
                return exc.code, None
            message = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"HTTP {exc.code} for {method} {path}: {message}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"cannot reach SFTPGo at {self.endpoint}: {exc.reason}") from exc

    def _get_token(self) -> str:
        credentials = base64.b64encode(
            f"{self.username}:{self.password}".encode("utf-8")
        ).decode("ascii")
        request = urllib.request.Request(
            f"{self.endpoint}/api/v2/token",
            headers={"Authorization": f"Basic {credentials}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = json.loads(response.read())
        except (urllib.error.HTTPError, urllib.error.URLError) as exc:
            raise ApiError(f"cannot authenticate to SFTPGo: {exc}") from exc
        token = payload.get("access_token")
        if not token:
            raise ApiError("SFTPGo token response did not include access_token")
        return str(token)

    def get(self, path: str) -> dict[str, Any] | None:
        return self._request("GET", path, allow_not_found=True)[1]

    def post(self, path: str, payload: dict[str, Any]) -> None:
        self._request("POST", path, payload, expected=(200, 201))

    def put(self, path: str, payload: dict[str, Any]) -> None:
        self._request("PUT", path, payload, expected=(200, 204))


def client_from_environment() -> SftpGoClient:
    required = (
        "FILE_GATEWAY_ENDPOINT",
        "SFTPGO_DEFAULT_ADMIN_USERNAME",
        "SFTPGO_DEFAULT_ADMIN_PASSWORD",
    )
    missing = [name for name in required if not os.environ.get(name)]
    if missing:
        raise ValueError(f"missing environment variable(s): {', '.join(missing)}")
    return SftpGoClient(*(os.environ[name] for name in required))


def sync_group(args: argparse.Namespace) -> int:
    client = client_from_environment()
    payload = build_group_payload(args.group, args.projects)
    encoded = urllib.parse.quote(args.group, safe="")
    current = client.get(f"/api/v2/groups/{encoded}")
    if current is None:
        client.post("/api/v2/groups", payload)
        print("created")
    else:
        payload["virtual_folders"] = current.get("virtual_folders", [])
        client.put(f"/api/v2/groups/{encoded}", payload)
        print("updated")
    return 0


def ensure_user(args: argparse.Namespace) -> int:
    client = client_from_environment()
    encoded = urllib.parse.quote(args.username, safe="")
    if client.get(f"/api/v2/users/{encoded}") is not None:
        print("exists")
        return 0
    password = os.environ.get("FILE_GATEWAY_USER_PASSWORD", "")
    payload = build_user_payload(args.username, password, args.group, args.description)
    client.post("/api/v2/users", payload)
    print("created")
    return 0


def set_passwords(args: argparse.Namespace) -> int:
    client = client_from_environment()
    password = os.environ.get("FILE_GATEWAY_NEW_PASSWORD", "")
    if len(password) < 8:
        raise ValueError("FILE_GATEWAY_NEW_PASSWORD must contain at least 8 characters")

    for username in args.users:
        encoded = urllib.parse.quote(username, safe="")
        current = client.get(f"/api/v2/users/{encoded}")
        if current is None:
            raise ValueError(f"upload user does not exist: {username}")
        client.put(
            f"/api/v2/users/{encoded}?disconnect=1",
            build_password_update_payload(current, password),
        )

    admin_encoded = urllib.parse.quote(args.admin, safe="")
    current_admin = client.get(f"/api/v2/admins/{admin_encoded}")
    if current_admin is None:
        raise ValueError(f"admin does not exist: {args.admin}")
    # Change the authenticated administrator last because SFTPGo invalidates
    # previously issued tokens after an account update.
    client.put(
        f"/api/v2/admins/{admin_encoded}",
        build_password_update_payload(current_admin, password),
    )
    print(f"updated {len(args.users)} users and 1 admin")
    return 0


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    subparsers = result.add_subparsers(dest="command", required=True)

    group_parser = subparsers.add_parser("sync-group")
    group_parser.add_argument("--group", required=True)
    group_parser.add_argument("--projects", nargs="+", required=True)
    group_parser.set_defaults(handler=sync_group)

    user_parser = subparsers.add_parser("ensure-user")
    user_parser.add_argument("--username", required=True)
    user_parser.add_argument("--group", required=True)
    user_parser.add_argument("--description", default="Forge delivery file upload account")
    user_parser.set_defaults(handler=ensure_user)

    password_parser = subparsers.add_parser("set-passwords")
    password_parser.add_argument("--admin", required=True)
    password_parser.add_argument("--users", nargs="+", required=True)
    password_parser.set_defaults(handler=set_passwords)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        return int(args.handler(args))
    except (ApiError, ValueError) as exc:
        print(f"file-gateway-admin: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
