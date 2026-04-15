"""
CRM API client — shared utilities for all CRM interactions.

Supports: brtcrm.io, mlbcrm.io, sfxcrm.io (and similar installs)
Auth: form-urlencoded  api_key + api_username + api_password
      Optional: per-CRM session cookie for caller-level data (callers param)

New API behaviour (after backend update):
  - Use `callers[N]` instead of `agents[N]` to filter by actual caller
  - Each call now includes a `user` field: {id, fname, lname} = the person
    who actually made/took the call (may differ from assigned account agent)
  - list_agent_customer_pairs() groups by actual caller, not account owner
"""

from __future__ import annotations

import http.client
import json
import os
import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Optional


def _today_end() -> str:
    """Return today's date as 'DD/MM/YYYY 23:59' for use as date_end."""
    return date.today().strftime("%d/%m/%Y") + " 23:59"

# ── Credentials ───────────────────────────────────────────────────────────────

ENV_FILE = Path(__file__).parent.parent / ".env.crm"


@dataclass
class CRMCredentials:
    api_username: str
    api_password: str
    api_key: str
    crm_urls: list[str] = field(default_factory=list)
    # Per-CRM session cookies: hostname -> full cookie string
    # e.g. {"mlbcrm.io": "melbournefx_crm_session=abc123"}
    session_cookies: dict[str, str] = field(default_factory=dict)
    # Per-CRM web login emails for auto session-cookie refresh on 403.
    # Falls back to api_username if not set.
    # e.g. {"brtcrm.io": "adam@example.com"}
    login_emails: dict[str, str] = field(default_factory=dict)


def load_credentials(env_file: Path = ENV_FILE) -> CRMCredentials:
    """Parse .env.crm and return credentials.

    Session cookies are stored as:
        SESSION_COOKIE_mlbcrm.io=melbournefx_crm_session=abc123
        SESSION_COOKIE_brtcrm.io=brtcrm_session=xyz456

    Per-CRM login emails (optional, for auto session refresh on 403):
        LOGIN_EMAIL_brtcrm.io=adam@example.com
    """
    values: dict[str, str] = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            k, _, v = line.partition("=")
            values[k.strip()] = v.strip()

    urls = [u.rstrip("/") for u in values.get("CRM_URLS", "").split(",") if u.strip()]

    session_cookies = {}
    for k, v in values.items():
        if k.startswith("SESSION_COOKIE_"):
            session_cookies[k[len("SESSION_COOKIE_"):]] = v

    # Global fallback: LOGIN_EMAIL applies to all CRMs unless overridden per-CRM
    global_email = values.get("LOGIN_EMAIL", "")
    login_emails = {}
    for k, v in values.items():
        if k.startswith("LOGIN_EMAIL_"):
            login_emails[k[len("LOGIN_EMAIL_"):]] = v
    # Fill in global fallback for any CRM not explicitly set
    for url in urls:
        h = url.replace("https://", "").replace("http://", "").split("/")[0]
        if h not in login_emails and global_email:
            login_emails[h] = global_email

    return CRMCredentials(
        api_username=values["api_username"],
        api_password=values["api_password"],
        api_key=values["api_key"],
        crm_urls=urls,
        session_cookies=session_cookies,
        login_emails=login_emails,
    )


def save_session_cookie(crm_url: str, cookie: str, env_file: Path = ENV_FILE) -> None:
    """Write or update SESSION_COOKIE_{host} in .env.crm."""
    host = _host(crm_url)
    key = f"SESSION_COOKIE_{host}"
    lines = env_file.read_text().splitlines() if env_file.exists() else []
    new_line = f"{key}={cookie}"
    for i, line in enumerate(lines):
        if line.startswith(f"{key}="):
            lines[i] = new_line
            env_file.write_text("\n".join(lines) + "\n")
            return
    lines.append(new_line)
    env_file.write_text("\n".join(lines) + "\n")


def _host(crm_url: str) -> str:
    """Strip scheme from URL to get hostname."""
    return crm_url.replace("https://", "").replace("http://", "").split("/")[0]


# ── API queries ───────────────────────────────────────────────────────────────

def fetch_accounts(
    crm_url: str,
    creds: CRMCredentials,
    callers: list[str] | None = None,
    date_start: str = "01/01/2025 00:00",
    date_end: str | None = None,
    timeout: int = 60,
) -> list[dict]:
    """
    Query /api/v1/accounts and return the raw data list.

    Uses `callers[N]` param (new API) to filter by actual caller.
    Passes session cookie if available for that CRM host, which enables
    the `user` field on each call (actual caller identity).

    Each account item: {id, fname, lname, accounts: [{id, fname, lname,
        ftd_at, calls: [{id, duration, record_path, call_started_at,
        user: {id, fname, lname}}]}]}
    """
    params: dict[str, str] = {
        "api_username": creds.api_username,
        "api_password": creds.api_password,
        "api_key":      creds.api_key,
        "date_start":   date_start,
        "date_end":     date_end or _today_end(),
    }
    if callers:
        for i, name in enumerate(callers):
            params[f"callers[{i}]"] = name

    payload = urllib.parse.urlencode(params)
    host = _host(crm_url)
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    # Attach session cookie if we have one for this CRM
    cookie = creds.session_cookies.get(host)
    if cookie:
        headers["Cookie"] = cookie

    def _do_request(hdrs: dict) -> tuple[int, str]:
        c = http.client.HTTPSConnection(host, timeout=timeout)
        c.request("POST", f"/api/v1/accounts/{creds.api_username}", payload, hdrs)
        r = c.getresponse()
        return r.status, r.read().decode("utf-8", errors="replace")

    status, raw = _do_request(headers)

    # Auto-retry: on 403, attempt web login to get a fresh session cookie
    if status == 403:
        login_email = creds.login_emails.get(host) or creds.api_username
        print(f"[crm_client] 403 from {host}, attempting auto-login as {login_email}…")
        new_cookie = get_session_cookie(crm_url, login_email, creds.api_password)
        if new_cookie:
            print(f"[crm_client] Got new session cookie for {host}, retrying…")
            save_session_cookie(crm_url, new_cookie)
            creds.session_cookies[host] = new_cookie
            headers["Cookie"] = new_cookie
            status, raw = _do_request(headers)
        else:
            print(f"[crm_client] Auto-login failed for {host}")
            raise RuntimeError(
                f"HTTP 403 from {host}: auto-login failed. "
                f"Add LOGIN_EMAIL_{host}=your@email.com to .env.crm, "
                f"or use /api/crm/authenticate to set a session cookie manually."
            )

    if status != 200:
        raise RuntimeError(f"HTTP {status} from {host}: {raw[:200]}")
    data = json.loads(raw)
    if not data.get("success"):
        raise RuntimeError(f"API error from {host}: {raw[:200]}")
    return data.get("data", [])


def list_agent_customer_pairs(
    crm_url: str,
    creds: CRMCredentials,
    agent_filter: str | None = None,
    customer_filter: str | None = None,
    min_calls: int = 1,
    date_start: str = "01/01/2025 00:00",
    date_end: str | None = None,
) -> list[dict]:
    """
    Return list of {crm, agent_id, agent, account_id, customer, ftd_at,
                    total_calls, recorded_calls, total_duration_s}

    Groups by ACTUAL caller (from call.user field) rather than assigned
    account agent. This reflects who actually talked to the customer.
    Falls back to assigned agent if user field is absent.
    """
    callers_param = [agent_filter] if agent_filter else None
    data = fetch_accounts(crm_url, creds, callers=callers_param,
                          date_start=date_start, date_end=date_end)

    # (caller_id, account_id) -> pair accumulator
    pair_map: dict[tuple, dict] = {}

    for agent in data:
        # Fallback agent name (assigned account owner)
        fallback_aname = f'{agent["fname"]} {agent["lname"]}'.strip()
        fallback_aid = agent["id"]

        for acc in agent.get("accounts", []):
            cname = f'{acc["fname"]} {acc.get("mname", "")} {acc["lname"]}'.strip()
            cname = " ".join(cname.split())
            if customer_filter and customer_filter.lower() not in cname.lower():
                continue

            for c in acc.get("calls", []):
                if not isinstance(c, dict):
                    continue

                # Resolve actual caller from user field
                user = c.get("user") or {}
                if user and user.get("fname"):
                    caller_name = f'{user["fname"]} {user["lname"]}'.strip()
                    caller_id = user["id"]
                else:
                    caller_name = fallback_aname
                    caller_id = fallback_aid

                if agent_filter and agent_filter.lower() not in caller_name.lower():
                    continue

                key = (caller_id, acc["id"])
                if key not in pair_map:
                    pair_map[key] = {
                        "crm":              crm_url,
                        "agent_id":         caller_id,
                        "agent":            caller_name,
                        "account_id":       acc["id"],
                        "customer":         cname,
                        "ftd_at":           acc.get("ftd_at"),
                        "total_calls":      0,
                        "recorded_calls":   0,
                        "total_duration_s": 0,
                    }

                pair_map[key]["total_calls"] += 1
                if c.get("record_path"):
                    pair_map[key]["recorded_calls"] += 1
                pair_map[key]["total_duration_s"] += c.get("duration") or 0

    pairs = [p for p in pair_map.values() if p["total_calls"] >= min_calls]
    return sorted(pairs, key=lambda p: (p["agent"], p["customer"]))


def get_calls_for_pair(
    crm_url: str,
    creds: CRMCredentials,
    agent_name: str,
    account_id: int,
    date_start: str = "01/01/2025 00:00",
    date_end: str | None = None,
) -> list[dict]:
    """
    Return all calls for a specific (caller, account_id) pair.
    Filters by actual caller in call.user field (falls back to assigned agent).
    Each call: {call_id, account_id, customer, agent, duration_s,
                started_at, record_path}
    """
    data = fetch_accounts(crm_url, creds, callers=[agent_name],
                          date_start=date_start, date_end=date_end)
    calls = []
    for agent in data:
        fallback_aname = f'{agent["fname"]} {agent["lname"]}'.strip()
        for acc in agent.get("accounts", []):
            if acc["id"] != account_id:
                continue
            cname = f'{acc["fname"]} {acc.get("mname", "")} {acc["lname"]}'.strip()
            cname = " ".join(cname.split())
            for c in acc.get("calls", []):
                if not isinstance(c, dict):
                    continue
                # Resolve actual caller
                user = c.get("user") or {}
                if user and user.get("fname"):
                    caller_name = f'{user["fname"]} {user["lname"]}'.strip()
                else:
                    caller_name = fallback_aname
                # Only include calls by the requested agent
                if agent_name.lower() not in caller_name.lower():
                    continue
                calls.append({
                    "call_id":     c["id"],
                    "account_id":  acc["id"],
                    "customer":    cname,
                    "agent":       caller_name,
                    "duration_s":  c.get("duration"),
                    "started_at":  c.get("call_started_at"),
                    "record_path": c.get("record_path"),
                })
    return calls


# ── Session-based download ────────────────────────────────────────────────────

def get_session_cookie(
    crm_url: str,
    email: str,
    password: str,
    timeout: int = 15,
) -> str | None:
    """
    Login via web UI. Returns session cookie string or None on failure.
    """
    host = _host(crm_url)
    try:
        conn = http.client.HTTPSConnection(host, timeout=timeout)
        conn.request("GET", "/login", headers={"User-Agent": "Mozilla/5.0"})
        r = conn.getresponse()
        body = r.read().decode("utf-8", errors="replace")

        # Collect ALL Set-Cookie headers (getheader only returns the first one)
        get_cookies: dict[str, str] = {}
        for k, v in r.getheaders():
            if k.lower() == "set-cookie":
                part = v.split(";")[0]
                ck, _, cv = part.partition("=")
                get_cookies[ck.strip()] = cv.strip()

        m = re.search(r'name="_token" value="([^"]+)"', body)
        if not m:
            return None
        csrf = m.group(1)

        cookie_str = "; ".join(f"{k}={v}" for k, v in get_cookies.items())
        conn2 = http.client.HTTPSConnection(host, timeout=timeout)
        # CRM login forms use "username" field (not "email")
        payload = urllib.parse.urlencode({
            "_token": csrf, "username": email, "email": email, "password": password,
        })
        conn2.request("POST", "/login", payload, {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": cookie_str,
            "Referer": f"https://{host}/login",
            "User-Agent": "Mozilla/5.0",
        })
        r2 = conn2.getresponse()
        r2.read()
        if r2.status not in (200, 302):
            return None

        # Collect response cookies; prefer the CRM session cookie
        resp_cookies: dict[str, str] = {}
        for k, v in r2.getheaders():
            if k.lower() == "set-cookie":
                part = v.split(";")[0]
                ck, _, cv = part.partition("=")
                resp_cookies[ck.strip()] = cv.strip()

        # Return the CRM session cookie (contains "session" in name)
        for ck, cv in resp_cookies.items():
            if "session" in ck.lower():
                return f"{ck}={cv}"
        # Fallback: return all response cookies
        if resp_cookies:
            return "; ".join(f"{k}={v}" for k, v in resp_cookies.items())
        return "; ".join(f"{k}={v}" for k, v in get_cookies.items())
    except Exception:
        return None


def download_recording(
    crm_url: str,
    record_path: str,
    dest: Path,
    session_cookie: str,
    timeout: int = 60,
) -> bool:
    """
    Download a recording via authenticated session. Returns True on success.
    record_path: e.g. "callRecords/accounts/726214/55057.wav"
    """
    host = _host(crm_url)
    try:
        conn = http.client.HTTPSConnection(host, timeout=timeout)
        conn.request("GET", f"/{record_path}", headers={"Cookie": session_cookie})
        res = conn.getresponse()
        if res.status == 200 and "audio" in res.getheader("Content-Type", ""):
            dest.write_bytes(res.read())
            return True
        res.read()
        return False
    except Exception:
        return False
