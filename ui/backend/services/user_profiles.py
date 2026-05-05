from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from typing import Any

from fastapi import HTTPException, Request
from sqlmodel import Session

from ui.backend.config import settings
from ui.backend.database import engine as _db_engine
from ui.backend.models.app_state_kv import AppStateKV

_LOCK = threading.Lock()
_AUTH_DIR = settings.ui_data_dir / "_auth"
_USERS_FILE = _AUTH_DIR / "users.json"
_USER_STATE_KEY = "auth.users"

ROLE_ADMIN = "admin"
ROLE_EDITOR = "editor"
ROLE_VIEWER = "viewer"

PERM_CREATE_PIPELINES = "create_pipelines"
PERM_EDIT_PIPELINES = "edit_pipelines"
PERM_RUN_PIPELINES = "run_pipelines"
PERM_MANAGE_JOBS = "manage_jobs"
PERM_MANAGE_LIVE = "manage_live"
PERM_MANAGE_USERS = "manage_users"
PERM_SYNC_PIPELINES = "sync_pipelines"

_PERM_KEYS = (
    PERM_CREATE_PIPELINES,
    PERM_EDIT_PIPELINES,
    PERM_RUN_PIPELINES,
    PERM_MANAGE_JOBS,
    PERM_MANAGE_LIVE,
    PERM_MANAGE_USERS,
    PERM_SYNC_PIPELINES,
)

_ROLE_DEFAULTS: dict[str, dict[str, bool]] = {
    ROLE_ADMIN: {
        PERM_CREATE_PIPELINES: True,
        PERM_EDIT_PIPELINES: True,
        PERM_RUN_PIPELINES: True,
        PERM_MANAGE_JOBS: True,
        PERM_MANAGE_LIVE: True,
        PERM_MANAGE_USERS: True,
        PERM_SYNC_PIPELINES: True,
    },
    ROLE_EDITOR: {
        PERM_CREATE_PIPELINES: True,
        PERM_EDIT_PIPELINES: True,
        PERM_RUN_PIPELINES: True,
        PERM_MANAGE_JOBS: True,
        PERM_MANAGE_LIVE: True,
        PERM_MANAGE_USERS: False,
        PERM_SYNC_PIPELINES: False,
    },
    ROLE_VIEWER: {
        PERM_CREATE_PIPELINES: False,
        PERM_EDIT_PIPELINES: False,
        PERM_RUN_PIPELINES: False,
        PERM_MANAGE_JOBS: False,
        PERM_MANAGE_LIVE: False,
        PERM_MANAGE_USERS: False,
        PERM_SYNC_PIPELINES: False,
    },
}

# Hard admin identities that must always stay admin in both environments.
# This guarantees recovery access even if env/config is missing or misconfigured.
_ALWAYS_ADMIN_EMAILS = (
    "adamleeperelman@gmail.com",
    "adam.p@shinobigrp.com",
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _normalize_email(value: Any) -> str:
    return str(value or "").strip().lower()


def _normalize_role(value: Any) -> str:
    v = str(value or "").strip().lower()
    if v in _ROLE_DEFAULTS:
        return v
    return ROLE_VIEWER


def _split_csv_emails(value: Any) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        email = _normalize_email(part)
        if not email or email in seen:
            continue
        seen.add(email)
        out.append(email)
    return out


def _normalize_envs(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw:
        env = str(item or "").strip().lower()
        if env not in {"dev", "prod"}:
            continue
        if env in seen:
            continue
        seen.add(env)
        out.append(env)
    return out


def _normalize_permission_overrides(raw: Any) -> dict[str, bool]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, bool] = {}
    for k, v in raw.items():
        key = str(k or "").strip().lower()
        if key.startswith("can_"):
            key = key.replace("can_", "", 1)
        if key not in _PERM_KEYS:
            continue
        out[key] = bool(v)
    return out


def _default_store() -> dict[str, Any]:
    return {
        "version": 1,
        "updated_at": "",
        "users": [],
    }


def _coerce_user_record(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    email = _normalize_email(raw.get("email"))
    if not email:
        return None
    role = _normalize_role(raw.get("role"))
    name = str(raw.get("name") or "").strip()
    enabled = bool(raw.get("enabled", True))
    envs = _normalize_envs(raw.get("environments"))
    perms = _normalize_permission_overrides(raw.get("permissions"))
    created_at = str(raw.get("created_at") or "").strip() or _now_iso()
    updated_at = str(raw.get("updated_at") or "").strip() or created_at
    return {
        "email": email,
        "name": name,
        "role": role,
        "enabled": enabled,
        "environments": envs or ["dev", "prod"],
        "permissions": perms,
        "created_at": created_at,
        "updated_at": updated_at,
    }


def _user_state_use_db() -> bool:
    return bool(getattr(settings, "user_state_use_db", True))


def _user_state_file_fallback() -> bool:
    return bool(getattr(settings, "user_state_file_fallback", False))


def _load_store_from_file_locked() -> dict[str, Any]:
    _AUTH_DIR.mkdir(parents=True, exist_ok=True)
    if not _USERS_FILE.exists():
        return _default_store()
    try:
        raw = json.loads(_USERS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return _default_store()
    out = _default_store()
    if isinstance(raw, dict):
        out["version"] = int(raw.get("version") or 1)
        out["updated_at"] = str(raw.get("updated_at") or "").strip()
        users_raw = raw.get("users")
        if isinstance(users_raw, list):
            users: list[dict[str, Any]] = []
            seen: set[str] = set()
            for item in users_raw:
                user = _coerce_user_record(item)
                if not user:
                    continue
                email = user["email"]
                if email in seen:
                    continue
                seen.add(email)
                users.append(user)
            out["users"] = users
    return out


def _save_store_to_file_locked(payload: dict[str, Any]) -> None:
    _AUTH_DIR.mkdir(parents=True, exist_ok=True)
    _USERS_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _load_store_from_db_locked() -> dict[str, Any] | None:
    try:
        with Session(_db_engine) as s:
            row = s.get(AppStateKV, _USER_STATE_KEY)
    except Exception:
        return None
    if row is None:
        return None
    raw = str(getattr(row, "value_json", "") or "").strip()
    if not raw:
        return _default_store()
    try:
        parsed = json.loads(raw)
    except Exception:
        return None
    if not isinstance(parsed, dict):
        return _default_store()
    return _normalize_store(parsed)


def _save_store_to_db_locked(payload: dict[str, Any]) -> bool:
    try:
        value_json = json.dumps(payload, ensure_ascii=False)
    except Exception:
        return False
    try:
        with Session(_db_engine) as s:
            row = s.get(AppStateKV, _USER_STATE_KEY)
            if row is None:
                row = AppStateKV(key=_USER_STATE_KEY)
            row.value_json = value_json
            row.updated_at = datetime.utcnow()
            s.add(row)
            s.commit()
        return True
    except Exception:
        return False


def _normalize_store(raw: Any) -> dict[str, Any]:
    out = _default_store()
    if isinstance(raw, dict):
        out["version"] = int(raw.get("version") or 1)
        out["updated_at"] = str(raw.get("updated_at") or "").strip()
        users_raw = raw.get("users")
        if isinstance(users_raw, list):
            users: list[dict[str, Any]] = []
            seen: set[str] = set()
            for item in users_raw:
                user = _coerce_user_record(item)
                if not user:
                    continue
                email = user["email"]
                if email in seen:
                    continue
                seen.add(email)
                users.append(user)
            out["users"] = users
    return out


def _load_store_locked() -> dict[str, Any]:
    if _user_state_use_db():
        db_store = _load_store_from_db_locked()
        if db_store is not None:
            db_users = db_store.get("users") if isinstance(db_store.get("users"), list) else []
            if db_users:
                return db_store
            # Table exists but empty — migrate from file if any users are there
            file_store = _load_store_from_file_locked()
            file_users = file_store.get("users") if isinstance(file_store.get("users"), list) else []
            if file_users:
                _save_store_to_db_locked(file_store)
                return file_store
            return db_store
        # Table missing (exception) — bootstrap from file
        file_store = _load_store_from_file_locked()
        users = file_store.get("users") if isinstance(file_store.get("users"), list) else []
        if users:
            _save_store_to_db_locked(file_store)
        return file_store
    return _load_store_from_file_locked()


def _save_store_locked(store: dict[str, Any]) -> None:
    payload = {
        "version": 1,
        "updated_at": _now_iso(),
        "users": store.get("users") if isinstance(store.get("users"), list) else [],
    }
    wrote_db = False
    if _user_state_use_db():
        wrote_db = _save_store_to_db_locked(payload)
    if wrote_db and not _user_state_file_fallback():
        return
    _save_store_to_file_locked(payload)


def _detect_environment(request: Request | None) -> str:
    host = ""
    if request is not None:
        host = str(
            request.headers.get("x-forwarded-host")
            or request.headers.get("host")
            or ""
        ).strip().lower()
        if "," in host:
            host = host.split(",", 1)[0].strip()
    if ":" in host:
        host = host.split(":", 1)[0].strip()
    if host in {"shinobi.aleph-infinity.com", "localhost", "127.0.0.1"}:
        return "dev"
    if host == "shinobi.prod.aleph-infinity.com":
        return "prod"
    # Safe default when host is unknown in local tooling/tests.
    return "dev"


def _extract_email_from_headers(request: Request | None) -> str:
    if request is None:
        fallback = _normalize_email(settings.user_default_email)
        if fallback:
            return fallback
        admins = _split_csv_emails(settings.user_admin_emails)
        return admins[0] if admins else ""
    headers = request.headers
    candidates = (
        headers.get("x-shinobi-user-email"),
        headers.get("x-goog-authenticated-user-email"),
        headers.get("x-auth-request-email"),
        headers.get("x-forwarded-email"),
        headers.get("x-user-email"),
    )
    for raw in candidates:
        val = str(raw or "").strip()
        if not val:
            continue
        if ":" in val and "@" in val:
            val = val.split(":", 1)[1].strip()
        email = _normalize_email(val)
        if email and "@" in email:
            return email
    qp = request.query_params.get("as_user")
    if qp:
        email = _normalize_email(qp)
        if email and "@" in email:
            return email
    fallback = _normalize_email(settings.user_default_email)
    if fallback:
        return fallback
    admins = _split_csv_emails(settings.user_admin_emails)
    return admins[0] if admins else ""


def _seed_defaults_locked(
    store: dict[str, Any],
    *,
    current_email: str,
    current_env: str,
) -> bool:
    changed = False
    users = store.get("users")
    if not isinstance(users, list):
        users = []
        store["users"] = users

    by_email: dict[str, dict[str, Any]] = {}
    for u in users:
        if isinstance(u, dict):
            e = _normalize_email(u.get("email"))
            if e:
                by_email[e] = u

    admin_emails = _split_csv_emails(settings.user_admin_emails)
    for forced_admin in _ALWAYS_ADMIN_EMAILS:
        email = _normalize_email(forced_admin)
        if not email:
            continue
        if email not in admin_emails:
            admin_emails.append(email)
    if not admin_emails and current_email:
        admin_emails = [current_email]
    for email in admin_emails:
        row = by_email.get(email)
        if not row:
            row = {
                "email": email,
                "name": email.split("@", 1)[0],
                "role": ROLE_ADMIN,
                "enabled": True,
                "environments": ["dev", "prod"],
                "permissions": {},
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
            users.append(row)
            by_email[email] = row
            changed = True
            continue
        if str(row.get("role") or "").strip().lower() != ROLE_ADMIN:
            row["role"] = ROLE_ADMIN
            changed = True
        if not bool(row.get("enabled", True)):
            row["enabled"] = True
            changed = True
        envs = set(_normalize_envs(row.get("environments")) or ["dev", "prod"])
        if "dev" not in envs or "prod" not in envs:
            row["environments"] = ["dev", "prod"]
            changed = True

    for email in _split_csv_emails(settings.user_seed_dev_viewer_emails):
        row = by_email.get(email)
        if not row:
            row = {
                "email": email,
                "name": email.split("@", 1)[0],
                "role": ROLE_VIEWER,
                "enabled": True,
                "environments": ["dev"],
                "permissions": {},
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
            users.append(row)
            by_email[email] = row
            changed = True
            continue
        if not bool(row.get("enabled", True)):
            row["enabled"] = True
            changed = True
        role = _normalize_role(row.get("role"))
        if role not in {ROLE_VIEWER, ROLE_EDITOR, ROLE_ADMIN}:
            row["role"] = ROLE_VIEWER
            changed = True
        envs = set(_normalize_envs(row.get("environments")) or ["dev", "prod"])
        if "dev" not in envs:
            envs.add("dev")
            row["environments"] = sorted(envs)
            changed = True

    auto_provision = bool(settings.user_auto_provision_unknown)
    if auto_provision and current_email and current_email not in by_email:
        users.append(
            {
                "email": current_email,
                "name": current_email.split("@", 1)[0],
                "role": ROLE_VIEWER,
                "enabled": True,
                "environments": [current_env] if current_env in {"dev", "prod"} else ["dev"],
                "permissions": {},
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
        )
        changed = True
    return changed


def _resolve_effective_permissions(record: dict[str, Any]) -> dict[str, bool]:
    role = _normalize_role(record.get("role"))
    base = dict(_ROLE_DEFAULTS.get(role, _ROLE_DEFAULTS[ROLE_VIEWER]))
    overrides = _normalize_permission_overrides(record.get("permissions"))
    for k, v in overrides.items():
        base[k] = bool(v)
    return base


def _profile_from_record(record: dict[str, Any], *, env: str) -> dict[str, Any]:
    email = _normalize_email(record.get("email"))
    role = _normalize_role(record.get("role"))
    enabled = bool(record.get("enabled", True))
    envs = _normalize_envs(record.get("environments")) or ["dev", "prod"]
    in_env = env in envs
    perms_raw = _resolve_effective_permissions(record)
    can_view = bool(enabled and in_env)
    perms = {
        "can_view": can_view,
        "can_create_pipelines": can_view and bool(perms_raw.get(PERM_CREATE_PIPELINES)),
        "can_edit_pipelines": can_view and bool(perms_raw.get(PERM_EDIT_PIPELINES)),
        "can_run_pipelines": can_view and bool(perms_raw.get(PERM_RUN_PIPELINES)),
        "can_manage_jobs": can_view and bool(perms_raw.get(PERM_MANAGE_JOBS)),
        "can_manage_live_jobs": can_view and bool(perms_raw.get(PERM_MANAGE_LIVE)),
        "can_manage_users": can_view and bool(perms_raw.get(PERM_MANAGE_USERS)),
        "can_sync_pipelines": can_view and bool(perms_raw.get(PERM_SYNC_PIPELINES)),
    }
    return {
        "email": email,
        "name": str(record.get("name") or "").strip() or email,
        "role": role,
        "enabled": enabled,
        "environment": env,
        "environments": envs,
        "permissions": perms,
        "is_admin": bool(role == ROLE_ADMIN and perms["can_manage_users"]),
        "created_at": str(record.get("created_at") or "").strip(),
        "updated_at": str(record.get("updated_at") or "").strip(),
    }


def get_current_user_profile(request: Request | None) -> dict[str, Any]:
    env = _detect_environment(request)
    email = _extract_email_from_headers(request)
    with _LOCK:
        store = _load_store_locked()
        changed = _seed_defaults_locked(store, current_email=email, current_env=env)
        users = store.get("users") if isinstance(store.get("users"), list) else []
        row = None
        for item in users:
            if _normalize_email((item or {}).get("email")) == email:
                row = item
                break
        if row is None:
            row = {
                "email": email,
                "name": email.split("@", 1)[0] if email else "anonymous",
                "role": ROLE_VIEWER,
                "enabled": bool(email),
                "environments": [env] if email else [],
                "permissions": {},
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            }
            users.append(row)
            changed = True
        if changed:
            _save_store_locked(store)
        profile = _profile_from_record(row, env=env)
    if not profile["permissions"]["can_view"]:
        profile["restricted_reason"] = (
            "User is disabled or not allowed in this environment."
        )
    return profile


def require_permission(request: Request, permission_flag: str) -> dict[str, Any]:
    profile = get_current_user_profile(request)
    perms = profile.get("permissions") if isinstance(profile.get("permissions"), dict) else {}
    if not bool(perms.get("can_view")):
        raise HTTPException(status_code=403, detail="User is not allowed to access this environment.")
    if not bool(perms.get(permission_flag)):
        raise HTTPException(status_code=403, detail="You do not have permission for this action.")
    return profile


def list_users_for_admin(request: Request) -> list[dict[str, Any]]:
    require_permission(request, "can_manage_users")
    env = _detect_environment(request)
    with _LOCK:
        store = _load_store_locked()
        changed = _seed_defaults_locked(
            store,
            current_email=_extract_email_from_headers(request),
            current_env=env,
        )
        users = store.get("users") if isinstance(store.get("users"), list) else []
        out = [_profile_from_record(u, env=env) for u in users if isinstance(u, dict)]
        out.sort(key=lambda x: (x.get("email") or ""))
        if changed:
            _save_store_locked(store)
    return out


def upsert_user_for_admin(
    request: Request,
    *,
    email: str,
    name: str = "",
    role: str = ROLE_VIEWER,
    enabled: bool = True,
    environments: list[str] | None = None,
    permissions: dict[str, bool] | None = None,
) -> dict[str, Any]:
    require_permission(request, "can_manage_users")
    env = _detect_environment(request)
    target = _normalize_email(email)
    if not target or "@" not in target:
        raise HTTPException(status_code=400, detail="Valid email is required.")
    clean_role = _normalize_role(role)
    clean_envs = _normalize_envs(environments or ["dev", "prod"])
    if not clean_envs:
        clean_envs = ["dev", "prod"]
    clean_perms = _normalize_permission_overrides(permissions or {})
    with _LOCK:
        store = _load_store_locked()
        changed = _seed_defaults_locked(
            store,
            current_email=_extract_email_from_headers(request),
            current_env=env,
        )
        users = store.get("users") if isinstance(store.get("users"), list) else []
        row = None
        for item in users:
            if _normalize_email((item or {}).get("email")) == target:
                row = item
                break
        if row is None:
            row = {
                "email": target,
                "created_at": _now_iso(),
            }
            users.append(row)
        row["name"] = str(name or "").strip() or target.split("@", 1)[0]
        row["role"] = clean_role
        row["enabled"] = bool(enabled)
        row["environments"] = clean_envs
        row["permissions"] = clean_perms
        row["updated_at"] = _now_iso()
        changed = True
        if changed:
            _save_store_locked(store)
        return _profile_from_record(row, env=env)


def delete_user_for_admin(request: Request, email: str) -> dict[str, Any]:
    require_permission(request, "can_manage_users")
    target = _normalize_email(email)
    if not target:
        raise HTTPException(status_code=400, detail="Email is required.")
    with _LOCK:
        store = _load_store_locked()
        users = store.get("users") if isinstance(store.get("users"), list) else []
        kept: list[dict[str, Any]] = []
        deleted = False
        for item in users:
            em = _normalize_email((item or {}).get("email"))
            if em == target:
                deleted = True
                continue
            kept.append(item)
        store["users"] = kept
        if deleted:
            _save_store_locked(store)
    return {"ok": True, "deleted": deleted}
