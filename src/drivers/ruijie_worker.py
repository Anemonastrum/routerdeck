#!/usr/bin/env python3
"""Persistent pyruijie bridge for RouterDeck v1.10.

The Ruijie Cloud SDK has shipped several public/PyPI revisions with different
feature sets.  RouterDeck therefore keeps a very small compatibility layer:

* numeric Ruijie group/project IDs are normalized to strings;
* switch-port collection uses RuijieClient.get_switch_ports() when available;
* older SDKs fall back to the SDK's authenticated _get() helper against the
  same documented Cloud endpoints instead of crashing with AttributeError;
* connected-client collection has the same native-or-_get compatibility path.

Dependency/version errors are returned as structured JSON so RouterDeck shows
the useful cause rather than only "worker exited (1)".
"""
from __future__ import annotations

import hashlib
import inspect
import json
import os
import sys
import traceback
import time
from typing import Any

clients: dict[str, Any] = {}
_account_clients: dict[str, Any] = {}
_RuijieClient = None
_inventory_cache: dict[int, dict[str, Any]] = {}
_INVENTORY_CACHE_SECONDS = max(60, int(os.getenv("RUIJIE_INVENTORY_CACHE_SECONDS", "900")))
_COMPAT_INFO: dict[str, Any] = {
    "project_group_id": "unknown",
    "device_group_id": "unknown",
    "switch_ports": "unknown",
    "gateway_ports": "unknown",
    "clients": "unknown",
    "auth_region": "unknown",
}

_SWITCH_PORTS_PATH = "/service/api/conf/switch/device"
_GATEWAY_PORTS_PATH = "/service/api/gateway/intf/info"
_SWITCH_PORT_PAGE_SIZE = 100
_SWITCH_PORT_MAX_PAGES = 32
_CLIENTS_PATH = "/service/api/open/v1/dev/user/current-user"
_CLIENT_PAGE_SIZE = 200
_CLIENT_MAX_PAGES = 100


def _compat_model(base_cls, field_names: tuple[str, ...]):
    """Wrap a Pydantic model and normalize numeric Ruijie IDs."""

    class CompatModel(base_cls):
        @classmethod
        def model_validate(cls, obj, *args, **kwargs):
            if isinstance(obj, dict):
                obj = dict(obj)
                for name in field_names:
                    if obj.get(name) is not None:
                        obj[name] = str(obj[name])
            return super().model_validate(obj, *args, **kwargs)

    CompatModel.__name__ = f"RouterDeckCompat{base_cls.__name__}"
    return CompatModel


def install_pyruijie_compat() -> dict[str, Any]:
    """Install only compatibility shims required by the installed SDK."""
    import pyruijie.client as client_module
    import pyruijie.models as models_module

    try:
        models_module.Project.model_validate({"name": "RouterDeck probe", "groupId": 7702274})
        _COMPAT_INFO["project_group_id"] = "native"
    except Exception:
        CompatProject = _compat_model(models_module.Project, ("groupId", "group_id"))
        models_module.Project = CompatProject
        client_module.Project = CompatProject
        _COMPAT_INFO["project_group_id"] = "routerdeck-shim"

    try:
        models_module.Device.model_validate({"serialNumber": "RD-PROBE", "groupId": 7702274})
        _COMPAT_INFO["device_group_id"] = "native"
    except Exception:
        CompatDevice = _compat_model(
            models_module.Device,
            ("groupId", "group_id", "projectId", "project_id"),
        )
        models_module.Device = CompatDevice
        client_module.Device = CompatDevice
        _COMPAT_INFO["device_group_id"] = "routerdeck-shim"

    return dict(_COMPAT_INFO)


def load_client_class():
    global _RuijieClient
    if _RuijieClient is not None:
        return _RuijieClient
    try:
        from pyruijie import RuijieClient
        install_pyruijie_compat()
    except Exception as exc:
        raise RuntimeError(
            f"Unable to import/configure pyruijie: {exc.__class__.__name__}: {exc}"
        ) from exc
    _RuijieClient = RuijieClient
    return RuijieClient


def dump_model(value: Any) -> dict[str, Any]:
    if hasattr(value, "model_dump"):
        return value.model_dump()
    return dict(value) if isinstance(value, dict) else {}


def _truthy(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value or "").strip().lower() in {"1", "true", "yes", "up", "on", "enable", "enabled"}


def _parse_vlan_list(value: Any) -> list[int]:
    """Parse Ruijie's `1-4,100,200` representation without SDK models."""
    if isinstance(value, (list, tuple, set)):
        out: set[int] = set()
        for item in value:
            try:
                out.add(int(item))
            except (TypeError, ValueError):
                pass
        return sorted(out)

    out: set[int] = set()
    for part in str(value or "").split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            try:
                start, end = [int(x.strip()) for x in part.split("-", 1)]
                if 0 <= end - start <= 4096:
                    out.update(range(start, end + 1))
            except (TypeError, ValueError):
                pass
        else:
            try:
                out.add(int(part))
            except (TypeError, ValueError):
                pass
    return sorted(out)


def _normalize_raw_switch_port(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize the vendor/API alias names into the shape RouterDeck expects."""
    raw = dict(row or {})
    vlan_list = raw.get("vlan_list", raw.get("vlanList", ""))
    status = raw.get("status", raw.get("linkStatus", raw.get("lineStatus", "")))
    enable = raw.get("enable", raw.get("enabled", ""))
    uplink = raw.get("is_uplink", raw.get("isUplink", False))
    return {
        **raw,
        "name": raw.get("name", raw.get("portName", raw.get("alias", ""))),
        "port_type": raw.get("port_type", raw.get("type", "")),
        "vlan": raw.get("vlan"),
        "vlan_list": vlan_list,
        "status": status,
        "speed": raw.get("speed", ""),
        "is_uplink": _truthy(uplink),
        "poe_status": raw.get("poe_status", raw.get("poeStatus", "")),
        "power_used": raw.get("power_used", raw.get("powerUsed", "")),
        "loop_state": raw.get("loop_state", raw.get("loopState", "")),
        "enable": enable,
        "is_up": str(status or "").strip().lower() in {"up", "1", "online"},
        "allowed_vlans": _parse_vlan_list(vlan_list),
    }


def _sdk_switch_ports(client: Any, serial_number: str) -> tuple[list[Any], str]:
    """Return switch ports across old and new pyruijie releases.

    pyruijie >= 0.2 exposes get_switch_ports().  Older public releases still
    have the authenticated `_get()` transport used by get_projects/devices;
    use that transport with the same Ruijie Cloud API 2.6.7 endpoint.
    """
    native = getattr(client, "get_switch_ports", None)
    if callable(native):
        _COMPAT_INFO["switch_ports"] = "native"
        return list(native(serial_number)), "native"

    raw_get = getattr(client, "_get", None)
    if not callable(raw_get):
        _COMPAT_INFO["switch_ports"] = "unavailable"
        return [], "unavailable"

    all_ports: list[dict[str, Any]] = []
    path = f"{_SWITCH_PORTS_PATH}/{serial_number}/ports"
    for page_index in range(_SWITCH_PORT_MAX_PAGES):
        params = {"page_size": _SWITCH_PORT_PAGE_SIZE, "page_index": page_index}
        try:
            data = raw_get(path, params)
        except TypeError:
            # A small number of revisions made params keyword-only.
            data = raw_get(path, params=params)
        if not isinstance(data, dict):
            raise RuntimeError("Malformed Ruijie switch-port response: expected an object")
        raw_ports = data.get("portList", [])
        if raw_ports is None:
            raw_ports = []
        if not isinstance(raw_ports, list):
            raise RuntimeError("Malformed Ruijie switch-port response: portList is not an array")
        if not raw_ports:
            _COMPAT_INFO["switch_ports"] = "routerdeck-sdk-http-fallback"
            return all_ports, "routerdeck-sdk-http-fallback"
        all_ports.extend(_normalize_raw_switch_port(p) for p in raw_ports if isinstance(p, dict))
        if len(raw_ports) < _SWITCH_PORT_PAGE_SIZE:
            _COMPAT_INFO["switch_ports"] = "routerdeck-sdk-http-fallback"
            return all_ports, "routerdeck-sdk-http-fallback"

    raise RuntimeError("Ruijie switch-port pagination exceeded RouterDeck's safety limit")




def _normalize_raw_gateway_port(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize Ruijie gateway WAN/LAN port records for RouterDeck."""
    raw = dict(row or {})
    alias = raw.get("alias", raw.get("name", raw.get("portName", "")))
    ptype = raw.get("port_type", raw.get("type", ""))
    line = raw.get("line_status", raw.get("linestatus", raw.get("lineStatus", raw.get("status", ""))))
    ip_addr = raw.get("ip_address", raw.get("ipAddr", ""))
    ip_mask = raw.get("ip_mask", raw.get("ipMask", ""))
    return {
        **raw,
        "name": alias,
        "alias": alias,
        "port_type": ptype,
        "status": line,
        "line_status": line,
        "speed": raw.get("speed", ""),
        "ip_address": ip_addr,
        "ip_mask": ip_mask,
        "next_hop": raw.get("next_hop", raw.get("nextHop", "")),
        "pppoe": raw.get("pppoe", ""),
        "is_up": str(line or "").strip().lower() in {"up", "1", "online", "on"},
        "is_lan": str(ptype or "").strip().upper() == "LAN",
        "is_wan": str(ptype or "").strip().upper() == "WAN",
        "role": str(ptype or "").strip().lower(),
    }


def _sdk_gateway_ports(client: Any, serial_number: str) -> tuple[list[Any], str]:
    """Return gateway/router WAN/LAN ports across pyruijie releases."""
    native = getattr(client, "get_gateway_ports", None)
    if callable(native):
        _COMPAT_INFO["gateway_ports"] = "native"
        return list(native(serial_number)), "native"

    raw_get = getattr(client, "_get", None)
    if not callable(raw_get):
        _COMPAT_INFO["gateway_ports"] = "unavailable"
        return [], "unavailable"

    path = f"{_GATEWAY_PORTS_PATH}/{serial_number}"
    try:
        data = raw_get(path)
    except TypeError:
        data = raw_get(path, params={})
    if not isinstance(data, dict):
        raise RuntimeError("Malformed Ruijie gateway-port response: expected an object")
    rows = data.get("data", data.get("list", data.get("portList", [])))
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise RuntimeError("Malformed Ruijie gateway-port response: port list is not an array")
    _COMPAT_INFO["gateway_ports"] = "routerdeck-sdk-http-fallback"
    return [_normalize_raw_gateway_port(r) for r in rows if isinstance(r, dict)], "routerdeck-sdk-http-fallback"

def _normalize_raw_client(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize current-user API aliases without requiring ClientDevice."""
    raw = dict(row or {})
    source = raw.get("client_source", raw.get("clientSource", ""))
    device_name = raw.get("device_name", raw.get("deviceName", ""))
    linked = raw.get("linked_device", raw.get("linkedDevice", ""))
    return {
        **raw,
        "mac": raw.get("mac", ""),
        "ip": raw.get("ip"),
        "user_name": raw.get("user_name", raw.get("userName")),
        "connect_type": raw.get("connect_type", raw.get("connectType")),
        "ssid": raw.get("ssid"),
        "linked_device": linked,
        "device_name": device_name,
        "client_source": source,
        "manufacturer": raw.get("manufacturer"),
        "sta_os": raw.get("sta_os", raw.get("staOs")),
        "online_time": raw.get("online_time", raw.get("onlineTime")),
        "flow_up": raw.get("flow_up", raw.get("flowUp")),
        "flow_down": raw.get("flow_down", raw.get("flowDown")),
        "band": raw.get("band"),
        "rssi": raw.get("rssi"),
        "channel": raw.get("channel"),
        "switch_name": device_name if str(source).strip().lower() == "switch" else None,
        "is_online": True,
    }


def _sdk_clients(client: Any, project_id: str) -> tuple[list[Any], str]:
    """Return connected clients across old and new pyruijie releases.

    Current upstream exposes ``get_clients(project_id)``. Older published
    builds may lack it but still expose the authenticated ``_get`` transport.
    In that case mirror upstream's current-user endpoint and pagination.
    """
    native = getattr(client, "get_clients", None)
    if callable(native):
        _COMPAT_INFO["clients"] = "native"
        return list(native(str(project_id))), "native"

    raw_get = getattr(client, "_get", None)
    if not callable(raw_get):
        _COMPAT_INFO["clients"] = "unavailable"
        return [], "unavailable"

    all_clients: list[dict[str, Any]] = []
    seen_macs: set[str] = set()
    for page_index in range(1, _CLIENT_MAX_PAGES + 1):
        params = {
            "group_id": str(project_id),
            "page_index": page_index,
            "page_size": _CLIENT_PAGE_SIZE,
        }
        try:
            data = raw_get(_CLIENTS_PATH, params)
        except TypeError:
            data = raw_get(_CLIENTS_PATH, params=params)
        if not isinstance(data, dict):
            raise RuntimeError("Malformed Ruijie client response: expected an object")
        rows = data.get("list", [])
        if rows is None:
            rows = []
        if not isinstance(rows, list):
            raise RuntimeError("Malformed Ruijie client response: list is not an array")
        if not rows:
            _COMPAT_INFO["clients"] = "routerdeck-sdk-http-fallback"
            return all_clients, "routerdeck-sdk-http-fallback"

        for item in rows:
            if not isinstance(item, dict):
                continue
            row = _normalize_raw_client(item)
            mac = str(row.get("mac") or "").strip().lower()
            if mac and mac in seen_macs:
                continue
            if mac:
                seen_macs.add(mac)
            all_clients.append(row)

        total = data.get("totalCount", data.get("total", 0))
        try:
            if int(total or 0) and len(all_clients) >= int(total):
                _COMPAT_INFO["clients"] = "routerdeck-sdk-http-fallback"
                return all_clients, "routerdeck-sdk-http-fallback"
        except (TypeError, ValueError):
            pass
        if len(rows) < _CLIENT_PAGE_SIZE:
            _COMPAT_INFO["clients"] = "routerdeck-sdk-http-fallback"
            return all_clients, "routerdeck-sdk-http-fallback"

    raise RuntimeError("Ruijie client pagination exceeded RouterDeck's safety limit")

def _account_key(app_id: str, secret: str, api_token: str) -> str:
    digest = hashlib.sha256(secret.encode("utf-8")).hexdigest()
    return f"{app_id}|{api_token}|{digest}"


def _region_candidates(configured: str) -> list[str]:
    asia = "https://cloud-as.ruijienetworks.com"
    us = "https://cloud-us.ruijienetworks.com"
    configured = str(configured or "auto").strip().rstrip("/")
    if configured in {"", "auto"}:
        return [asia, us]
    out = [configured]
    if configured == asia:
        out.append(us)
    elif configured == us:
        out.append(asia)
    return out


def get_client(cfg: dict[str, Any]):
    RuijieClient = load_client_class()
    app_id = str(cfg.get("appId") or "").strip()
    secret = str(cfg.get("appSecret") or "")
    configured_base = str(cfg.get("baseUrl") or "auto")
    api_token = str(cfg.get("apiToken") or os.getenv("RUIJIE_API_TOKEN") or "").strip()
    if not app_id or not secret:
        raise ValueError("Ruijie Cloud App ID and App Secret are required")

    account_key = _account_key(app_id, secret, api_token)
    # Reuse an already-authenticated Cloud account across multiple RouterDeck
    # Ruijie devices. This also prevents a second device added with the wrong
    # region dropdown from needlessly failing when the same account is live.
    cached_account = _account_clients.get(account_key)
    if cached_account is not None:
        _COMPAT_INFO["auth_region"] = getattr(cached_account, "base_url", getattr(cached_account, "_base_url", "cached"))
        return cached_account

    errors: list[str] = []
    for base_url in _region_candidates(configured_base):
        key = f"{account_key}|{base_url}"
        client = clients.get(key)
        if client is not None:
            _account_clients[account_key] = client
            _COMPAT_INFO["auth_region"] = base_url
            return client

        kwargs = dict(app_id=app_id, app_secret=secret, base_url=base_url, timeout=30)
        try:
            if api_token and "api_token" in inspect.signature(RuijieClient).parameters:
                kwargs["api_token"] = api_token
        except (TypeError, ValueError):
            pass
        try:
            candidate = RuijieClient(**kwargs)
            candidate.authenticate()
            clients[key] = candidate
            _account_clients[account_key] = candidate
            _COMPAT_INFO["auth_region"] = base_url
            return candidate
        except TypeError as exc:
            raise RuntimeError(f"Installed pyruijie API is incompatible with RouterDeck: {exc}") from exc
        except Exception as exc:
            # Authentication happens before a serial number is ever queried.
            # Try the other official Ruijie Cloud region before declaring the
            # credentials invalid; this is especially useful when adding a
            # second device and the UI region does not match the first one.
            errors.append(f"{base_url}: {exc.__class__.__name__}: {exc}")
            try:
                close = getattr(candidate, "close", None)
                if callable(close):
                    close()
            except Exception:
                pass

    detail = " | ".join(errors)
    raise RuntimeError(
        "Ruijie Cloud authentication failed in every configured region. "
        "Authentication occurs before the device serial is checked, so verify the Cloud App ID/App Secret "
        f"(and API token if your account requires one). {detail}"
    )


def find_device(client, serial: str):
    """Find a device while aggressively caching Cloud inventory.

    Ruijie Cloud rate-limits project/device discovery. The device inventory is
    effectively static for RouterDeck polling purposes, so cache the flattened
    serial->(project, device) mapping for 15 minutes by default.
    """
    wanted = serial.strip().lower()
    cache_key = id(client)
    now = time.monotonic()
    cached = _inventory_cache.get(cache_key)
    if cached and now - float(cached.get("ts", 0)) < _INVENTORY_CACHE_SECONDS:
        match = cached.get("devices", {}).get(wanted)
        if match:
            _COMPAT_INFO["inventory_cache"] = "hit"
            return match

    projects = client.get_projects()
    inventory: dict[str, Any] = {}
    for project in projects:
        devices = client.get_devices(str(project.group_id))
        for device in devices:
            sn = str(getattr(device, "serial_number", "")).strip().lower()
            if sn:
                inventory[sn] = (project, device)
    _inventory_cache[cache_key] = {"ts": now, "devices": inventory}
    _COMPAT_INFO["inventory_cache"] = "refresh"
    match = inventory.get(wanted)
    if match:
        return match
    raise ValueError(f"Ruijie/Reyee device with serial {serial} was not found in this Cloud account")

def _device_kind(device: Any) -> str:
    dtype = str(getattr(device, "product_type", "") or "").strip().lower()
    dclass = str(getattr(device, "product_class", "") or "").strip().lower()
    name = str(getattr(device, "name", "") or "").strip().lower()
    modelish = " ".join((dtype, dclass, name))
    if dtype in {"switch", "esw"} or "switch" in dclass:
        return "switch"
    if dtype in {"egw", "gateway", "router", "ewr"} or any(x in modelish for x in ("gateway", "router", "ew3000", "ew3200", "ew6000", "ew7200")):
        return "gateway"
    if dtype in {"ap", "eap"} or "access point" in modelish:
        return "ap"
    return dtype or "device"


def build_snapshot(cfg: dict[str, Any], include_clients: bool = True) -> dict[str, Any]:
    client = get_client(cfg)
    serial = str(cfg.get("serialNumber") or "").strip()
    if not serial:
        raise ValueError("Ruijie/Reyee device serial number is required")

    project, device = find_device(client, serial)
    kind = _device_kind(device)
    device_serial = str(getattr(device, "serial_number", serial) or serial)

    raw_ports: list[Any] = []
    port_source = "not-applicable"
    if kind == "switch":
        raw_ports, port_source = _sdk_switch_ports(client, device_serial)
    elif kind == "gateway":
        raw_ports, port_source = _sdk_gateway_ports(client, device_serial)

    ports: list[dict[str, Any]] = []
    for port in raw_ports:
        row = dump_model(port)
        if kind == "gateway":
            if isinstance(port, dict):
                row = _normalize_raw_gateway_port(row)
            else:
                row.update({
                    "name": getattr(port, "alias", row.get("alias", row.get("name", ""))),
                    "alias": getattr(port, "alias", row.get("alias", "")),
                    "port_type": getattr(port, "port_type", row.get("port_type", "")),
                    "is_up": bool(getattr(port, "is_up", row.get("is_up", False))),
                    "is_lan": bool(getattr(port, "is_lan", row.get("is_lan", False))),
                    "is_wan": bool(getattr(port, "is_wan", row.get("is_wan", False))),
                })
        else:
            if isinstance(port, dict):
                row = _normalize_raw_switch_port(row)
            else:
                row["is_up"] = bool(getattr(port, "is_up", row.get("is_up", False)))
                allowed = getattr(port, "allowed_vlans", row.get("allowed_vlans"))
                if allowed is not None:
                    row["allowed_vlans"] = sorted(allowed) if isinstance(allowed, set) else allowed
        ports.append(row)

    attached: list[dict[str, Any]] = []
    client_source = "skipped"
    if include_clients:
        all_clients, client_source = _sdk_clients(client, str(project.group_id))
        target_names = {
            str(getattr(device, "name", "") or "").strip().lower(),
            device_serial.strip().lower(),
            str(getattr(device, "mac", "") or "").strip().lower(),
        }
        target_names.discard("")
        for c in all_clients:
            row = dump_model(c)
            if isinstance(c, dict):
                row = _normalize_raw_client(row)
            references = {
                str(getattr(c, "switch_name", None) or "").strip().lower(),
                str(getattr(c, "ap_name", None) or "").strip().lower(),
                str(row.get("switch_name") or "").strip().lower(),
                str(row.get("device_name") or row.get("deviceName") or "").strip().lower(),
                str(row.get("linked_device") or row.get("linkedDevice") or "").strip().lower(),
            }
            references.discard("")
            if references & target_names:
                attached.append(row)

    device_row = dump_model(device)
    device_row["is_online"] = bool(getattr(device, "is_online", device_row.get("is_online", False)))
    device_row["routerdeck_kind"] = kind
    return {
        "project": {
            "name": getattr(project, "name", ""),
            "group_id": str(getattr(project, "group_id", "") or ""),
        },
        "device": device_row,
        "ports": ports,
        "clients": attached,
        "compat": {
            **dict(_COMPAT_INFO),
            "device_kind": kind,
            "port_source": port_source,
            "switch_ports": port_source if kind == "switch" else _COMPAT_INFO.get("switch_ports", "not-applicable"),
            "gateway_ports": port_source if kind == "gateway" else _COMPAT_INFO.get("gateway_ports", "not-applicable"),
            "clients": client_source,
        },
    }

def handle(payload: dict[str, Any]) -> Any:
    action = payload.get("action") or "collect"
    cfg = payload.get("config") or {}
    if action == "diagnostic":
        klass = load_client_class()
        import pyruijie

        return {
            "module": getattr(pyruijie, "__file__", ""),
            "version": getattr(pyruijie, "__version__", ""),
            "client": getattr(klass, "__name__", "RuijieClient"),
            "has_get_switch_ports": callable(getattr(klass, "get_switch_ports", None)),
            "has_get_gateway_ports": callable(getattr(klass, "get_gateway_ports", None)),
            "has_get_clients": callable(getattr(klass, "get_clients", None)),
            "has_private_get": callable(getattr(klass, "_get", None)),
            "compat": dict(_COMPAT_INFO),
        }
    if action == "test":
        snap = build_snapshot(cfg, include_clients=False)
        return {
            "ok": True,
            "device": snap["device"],
            "project": snap["project"],
            "compat": snap.get("compat", {}),
        }
    if action in {"collect", "ports", "clients"}:
        return build_snapshot(cfg, include_clients=action != "ports")
    raise ValueError(f"Unsupported Ruijie worker action: {action}")


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    request_id = None
    try:
        payload = json.loads(line)
        request_id = payload.get("id")
        result = handle(payload)
        print(
            json.dumps(
                {"id": request_id, "ok": True, "result": result},
                separators=(",", ":"),
                default=str,
            ),
            flush=True,
        )
    except Exception as exc:
        # Authentication/validation failures are expected user-facing errors;
        # avoid flooding Docker logs with the same full traceback every poll.
        msg_lower = str(exc).lower()
        if (
            exc.__class__.__name__ in {"AuthenticationError", "ValueError", "APIError"}
            or "authentication failed" in msg_lower
            or "too many requests" in msg_lower
        ):
            print(f"[RouterDeck Ruijie] {exc.__class__.__name__}: {exc}", file=sys.stderr, flush=True)
        else:
            traceback.print_exc(file=sys.stderr)
        message = f"{exc.__class__.__name__}: {exc}"
        print(
            json.dumps(
                {"id": request_id, "ok": False, "error": message},
                separators=(",", ":"),
            ),
            flush=True,
        )
