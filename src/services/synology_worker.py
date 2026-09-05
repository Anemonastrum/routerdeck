#!/usr/bin/env python3
"""Persistent Synology DSM bridge using N4S4/synology-api.

The wrapper already handles DSM authentication/session negotiation. RouterDeck
uses documented SysInfo methods wherever possible and degrades individual
sections when a DSM model/version does not expose one of them.
"""
from __future__ import annotations
import json
import sys
import traceback
from typing import Any, Callable

clients: dict[str, Any] = {}


def jsonish(value: Any) -> Any:
    """Parse wrapper methods that return JSON as a string on some DSM builds."""
    if isinstance(value, str):
        text = value.strip()
        if text[:1] in ("{", "["):
            try:
                return json.loads(text)
            except Exception:
                return value
    return value


def make_client(cfg):
    try:
        from synology_api.core_sys_info import SysInfo
    except Exception as exc:
        raise RuntimeError(f"Unable to import synology-api: {exc.__class__.__name__}: {exc}") from exc
    host = str(cfg.get("host") or "").strip()
    port = str(cfg.get("port") or (5001 if cfg.get("secure") else 5000))
    username = str(cfg.get("username") or "").strip()
    password = str(cfg.get("password") or "")
    if not host or not username or not password:
        raise ValueError("Synology host, username and password are required")
    secure = bool(cfg.get("secure"))
    verify = not bool(cfg.get("insecureTls"))
    dsm = int(cfg.get("dsmVersion") or 7)
    otp = cfg.get("otpCode") or None
    key = f"{host}|{port}|{username}|{password}|{secure}|{verify}|{dsm}|{otp or ''}"
    if key not in clients:
        clients[key] = SysInfo(
            host,
            port,
            username,
            password,
            secure=secure,
            cert_verify=verify,
            dsm_version=dsm,
            debug=False,
            otp_code=otp,
        )
    return clients[key]


def safe(fn: Callable[[], Any]):
    try:
        return {"ok": True, "data": jsonish(fn())}
    except Exception as exc:
        return {"ok": False, "error": f"{exc.__class__.__name__}: {exc}"}


def first_method(client: Any, names: list[str]):
    for name in names:
        method = getattr(client, name, None)
        if callable(method):
            return safe(method)
    return {"ok": False, "error": f"Unsupported by installed synology-api: {', '.join(names)}"}


def collect(cfg):
    c = make_client(cfg)
    # These methods are documented on SysInfo in N4S4/synology-api. Keeping
    # each call isolated prevents a model-specific unsupported API from taking
    # down the whole RouterDeck service card.
    return {
        "system": first_method(c, ["get_system_info", "dsm_info"]),
        "status": first_method(c, ["sys_status", "get_system_health"]),
        "health": first_method(c, ["get_system_health", "sys_status"]),
        "utilization": first_method(c, ["get_all_system_utilization"]),
        "volumes": first_method(c, ["get_volume_info", "storage"]),
        "disks": first_method(c, ["storage", "get_volume_info"]),
        "packages": first_method(c, ["installed_package_list"]),
        "network": first_method(c, ["get_network_info", "network_status"]),
        "temperature": first_method(c, ["get_cpu_temp"]),
    }


def handle(payload):
    action = payload.get("action") or "collect"
    cfg = payload.get("config") or {}
    c = make_client(cfg)
    if action == "test":
        return {"system": first_method(c, ["get_system_info", "dsm_info"])}
    if action == "collect":
        return collect(cfg)
    if action == "storage":
        return {
            "volumes": first_method(c, ["get_volume_info", "storage"]),
            "disks": first_method(c, ["storage", "get_volume_info"]),
        }
    if action == "packages":
        return {"packages": first_method(c, ["installed_package_list"])}
    if action == "reboot":
        method = getattr(c, "reboot", None)
        if not callable(method):
            raise RuntimeError("Installed synology-api does not expose SysInfo.reboot()")
        return {"result": jsonish(method())}
    if action == "shutdown":
        method = getattr(c, "shutdown", None)
        if not callable(method):
            raise RuntimeError("Installed synology-api does not expose SysInfo.shutdown()")
        return {"result": jsonish(method())}
    raise ValueError(f"Unsupported Synology worker action: {action}")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    rid = None
    try:
        payload = json.loads(line)
        rid = payload.get("id")
        result = handle(payload)
        print(json.dumps({"id": rid, "ok": True, "result": result}, separators=(",", ":"), default=str), flush=True)
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        print(json.dumps({"id": rid, "ok": False, "error": f"{exc.__class__.__name__}: {exc}"}, separators=(",", ":")), flush=True)
