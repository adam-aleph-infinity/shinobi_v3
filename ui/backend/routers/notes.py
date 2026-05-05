"""Notes — per-call LLM analysis saved as notes against a specific transcript."""
import asyncio
import html
import json
import re
import uuid
from datetime import datetime
from typing import Optional
from urllib.parse import urlencode, urlparse
import requests as _requests

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.crm import CRMPair
from ui.backend.models.note import Note
from ui.backend.routers.full_persona_agent import _llm_call_temp, _llm_stream_thinking, _sse

router = APIRouter(prefix="/notes", tags=["notes"])

_CRM_LOG_TEXT_LIMIT = 1800
_CRM_DATA_PREVIEW_LIMIT = 1200
_CRM_RULE_LINE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"


def _clip_text(value: str, limit: int = _CRM_LOG_TEXT_LIMIT) -> str:
    text = str(value or "")
    if len(text) <= limit:
        return text
    return f"{text[:limit]} … [truncated {len(text) - limit} chars]"


def _mask_secret(value: str, keep: int = 3) -> str:
    text = str(value or "")
    if not text:
        return ""
    if len(text) <= keep * 2:
        return "*" * len(text)
    return f"{text[:keep]}***{text[-keep:]}"


def _summarize_json_payload(raw: str) -> dict:
    txt = str(raw or "").strip()
    if not txt:
        return {"is_json": False, "empty": True}
    try:
        obj = json.loads(txt)
    except Exception:
        return {"is_json": False, "preview": _clip_text(txt)}

    if isinstance(obj, dict):
        out: dict = {"is_json": True, "type": "object", "keys": list(obj.keys())[:20]}
        if "success" in obj:
            out["success"] = obj.get("success")
        if "error" in obj and isinstance(obj.get("error"), dict):
            out["error"] = {k: obj["error"].get(k) for k in ("message", "type", "code")}
        data = obj.get("data")
        if isinstance(data, list):
            out["data_items"] = len(data)
            if data and isinstance(data[0], dict):
                out["data_item_0_keys"] = list(data[0].keys())[:15]
        elif isinstance(data, dict):
            out["data_keys"] = list(data.keys())[:20]
        return out

    if isinstance(obj, list):
        out = {"is_json": True, "type": "array", "items": len(obj)}
        if obj and isinstance(obj[0], dict):
            out["item_0_keys"] = list(obj[0].keys())[:15]
        return out

    return {"is_json": True, "type": type(obj).__name__, "value_preview": _clip_text(str(obj))}


def _build_request_log(endpoint: str, body: dict, encoded_body: str) -> dict:
    form = dict(body)
    raw_data = str(form.get("data") or "")
    form["api_password"] = _mask_secret(str(form.get("api_password") or ""))
    form["api_key"] = _mask_secret(str(form.get("api_key") or ""))
    form["data_length"] = len(raw_data)
    form["data_preview"] = _clip_text(raw_data, _CRM_DATA_PREVIEW_LIMIT)
    form.pop("data", None)
    encoded_preview_safe = urlencode(
        {
            "api_username": form.get("api_username", ""),
            "api_password": form.get("api_password", ""),
            "api_key": form.get("api_key", ""),
            "account_id": form.get("account_id", ""),
            "data_length": form.get("data_length", ""),
        }
    )
    return {
        "endpoint": endpoint,
        "method": "POST",
        "headers": {"Content-Type": "application/x-www-form-urlencoded"},
        "body_form": form,
        "body_encoded_length": len(encoded_body),
        "body_encoded_preview": _clip_text(encoded_preview_safe, _CRM_DATA_PREVIEW_LIMIT),
    }


def _build_response_log(resp_status: int, resp_headers: dict, resp_text: str) -> dict:
    return {
        "status": int(resp_status),
        "headers": dict(resp_headers or {}),
        "body_length": len(str(resp_text or "")),
        "body_preview": _clip_text(resp_text, _CRM_DATA_PREVIEW_LIMIT),
        "body_summary": _summarize_json_payload(resp_text),
    }


def _crm_inline_format(text: str) -> str:
    """Convert a single inline markdown fragment into CRM-safe inline HTML.

    Allowed tags/styles are intentionally limited to what CRM HTMLPurifier keeps.
    """
    value = html.escape(str(text or ""), quote=False)
    if not value:
        return ""

    # Inline code first
    value = re.sub(
        r"`([^`\n]+)`",
        r'<u style="font-size:12px">\1</u>',
        value,
    )
    # Bold + italic + underline
    value = re.sub(
        r"\*\*_([^_\n]+)_\*\*",
        r"<strong><em><u>\1</u></em></strong>",
        value,
    )
    value = re.sub(
        r"__\*([^*\n]+)\*__",
        r"<strong><em><u>\1</u></em></strong>",
        value,
    )
    # Bold + italic
    value = re.sub(
        r"\*\*\*([^\*\n]+)\*\*\*",
        r"<strong><em>\1</em></strong>",
        value,
    )
    value = re.sub(
        r"___([^_\n]+)___",
        r"<strong><em>\1</em></strong>",
        value,
    )
    # Strikethrough
    value = re.sub(
        r"~~([^~\n]+)~~",
        r'<strong style="text-decoration:line-through">\1</strong>',
        value,
    )
    # Bold / underline / italic
    value = re.sub(r"\*\*([^\*\n]+)\*\*", r"<strong>\1</strong>", value)
    value = re.sub(r"__([^_\n]+)__", r"<u>\1</u>", value)
    value = re.sub(r"\*([^*\n]+)\*", r"<em>\1</em>", value)
    value = re.sub(r"_([^_\n]+)_", r"<em>\1</em>", value)
    return value


def _crm_strip_code_fence(raw: str) -> str:
    s = str(raw or "").strip()
    if not s.startswith("```"):
        return s
    lines = s.split("\n")
    if len(lines) < 3:
        return s
    if not lines[0].startswith("```"):
        return s
    if lines[-1].strip() != "```":
        return s
    return "\n".join(lines[1:-1]).strip()


def _crm_extract_note_body(raw_text: str) -> str:
    """Unwrap common JSON envelopes and return the true note markdown/body text."""
    current = _crm_strip_code_fence(str(raw_text or ""))
    if not current:
        return ""

    def _pick_payload(obj: dict) -> Optional[object]:
        # Most-specific first.
        for k in ("note", "content_md", "content", "response", "result", "output", "data", "text"):
            if k in obj and obj.get(k) is not None:
                return obj.get(k)
        keys = list(obj.keys())
        if len(keys) == 1:
            return obj.get(keys[0])
        return None

    for _ in range(8):
        txt = str(current or "").strip()
        if not txt:
            break

        parsed: object
        try:
            parsed = json.loads(txt)
        except Exception:
            break

        if isinstance(parsed, str):
            current = _crm_strip_code_fence(parsed)
            continue

        if isinstance(parsed, dict):
            payload = _pick_payload(parsed)
            if payload is None:
                break
            if isinstance(payload, (dict, list)):
                current = json.dumps(payload, ensure_ascii=False)
            else:
                current = str(payload)
            current = _crm_strip_code_fence(current)
            continue

        if isinstance(parsed, list):
            if len(parsed) == 1 and isinstance(parsed[0], str):
                current = _crm_strip_code_fence(str(parsed[0]))
                continue
            break

        break

    return str(current or "").strip()


def _crm_clean_note_text(markdown_text: str) -> str:
    """Strip non-note scaffolding before CRM rendering."""
    text = _crm_extract_note_body(str(markdown_text or ""))
    if not text:
        return ""

    # Remove structured call anchors if present.
    text = re.sub(
        r"\[CALL_ANCHOR_START\][\s\S]*?\[CALL_ANCHOR_END\]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    # Also handle already-mutated/no-underscore anchor variants just in case.
    text = re.sub(
        r"\[CALLANCHORSTART\][\s\S]*?\[CALLANCHOREND\]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )
    # Handle looser/variant anchor patterns.
    text = re.sub(
        r"\[\s*CALL[_\s-]*ANCHOR[_\s-]*START\s*\][\s\S]*?\[\s*CALL[_\s-]*ANCHOR[_\s-]*END\s*\]\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    # Remove generic title line like "System Note – Call 120634" or "System Note – Final Call".
    text = re.sub(
        r"^\s*System\s+Note\s*[–-]\s*[^\n]+\n+",
        "",
        text,
        flags=re.IGNORECASE,
    )

    cleaned_lines: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        s = line.strip()
        # Remove optional top-level section numbering prefix only.
        # e.g. "1. Company Procedures ..." -> "Company Procedures ..."
        m = re.match(r"^([0-9]+)\.\s+(.*)$", s)
        if m and m.group(1) in {"1", "2", "3"}:
            line = re.sub(r"^\s*[0-9]+\.\s+", "", line, count=1)
        cleaned_lines.append(line)

    return "\n".join(cleaned_lines).strip()


def _crm_render_section_heading(line_text: str) -> str:
    """Render known non-markdown section lines as styled headings."""
    s = str(line_text or "").strip()
    if not s:
        return ""

    # Normalize simple markdown wrappers for matching, e.g. "**A) ...**"
    plain = s
    m_bold = re.match(r"^\*\*(.+)\*\*$", plain)
    if m_bold:
        plain = m_bold.group(1).strip()
    m_italic = re.match(r"^\*(.+)\*$", plain)
    if m_italic:
        plain = m_italic.group(1).strip()

    def _h(size_px: int, color: str, body: str) -> str:
        return f'<strong style="font-size:{size_px}px;color:{color}">{_crm_inline_format(body)}</strong>'

    # Main sections
    if re.match(r"^(Company Procedures|Call Summary|Next Call Actions)\b", plain, flags=re.IGNORECASE):
        return _h(18, "#1d4ed8", plain)
    if re.match(r"^Total Violations\b", plain, flags=re.IGNORECASE):
        return _h(18, "#7c3aed", plain)

    # Secondary sections
    if re.match(r"^(Procedure assessment|Procedure evaluation)\b", plain, flags=re.IGNORECASE):
        return _h(15, "#0f766e", plain)
    if re.match(r"^[A-C]\)\s+", plain):
        return _h(15, "#334155", plain)

    return ""


def _crm_colorize_keywords(rendered_line: str) -> str:
    """Apply CRM-safe color emphasis to key compliance tokens."""
    out = str(rendered_line or "")
    if not out:
        return ""

    # Bracketed tags first
    out = re.sub(
        r"(?i)\[COMPLIANT\]",
        '<strong style="color:green">[COMPLIANT]</strong>',
        out,
    )
    out = re.sub(
        r"(?i)\[VIOLATION\]",
        '<strong style="color:red">[VIOLATION]</strong>',
        out,
    )
    # Frequent status phrases
    out = re.sub(
        r"(?i)\bnot performed\b",
        '<strong style="color:red">not performed</strong>',
        out,
    )
    out = re.sub(
        r"(?i)\bmissing\b",
        '<strong style="color:red">missing</strong>',
        out,
    )
    out = re.sub(
        r"(?i)\bviolation(s)?\b",
        lambda m: f'<strong style="color:red">{m.group(0)}</strong>',
        out,
    )
    out = re.sub(
        r"(?i)\bcompliant\b",
        '<strong style="color:green">compliant</strong>',
        out,
    )
    return out


def _markdown_to_crm_html(markdown_text: str) -> str:
    """Convert markdown-like notes into CRM-safe HTML-ish text.

    CRM strips most block tags and markdown syntax, so this intentionally maps
    headings/lists/quotes/tables to inline-safe primitives and newline layout.
    """
    text = _crm_clean_note_text(markdown_text)
    if not text:
        return ""

    out_lines: list[str] = []
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    for raw_line in lines:
        line = raw_line.rstrip("\n")
        stripped = line.strip()
        if stripped == "":
            out_lines.append("")
            continue

        # Horizontal rules
        if re.fullmatch(r"[-_*]{3,}", stripped):
            out_lines.append(_CRM_RULE_LINE)
            continue

        # Known non-markdown section headings
        h = _crm_render_section_heading(stripped)
        if h:
            out_lines.append(h)
            continue

        # Headings
        m = re.match(r"^(#{1,3})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            body = _crm_inline_format(m.group(2).strip())
            size = "22px" if level == 1 else "18px" if level == 2 else "15px"
            out_lines.append(f'<strong style="font-size:{size};color:#1d4ed8">{body}</strong>')
            continue

        # Blockquote
        m = re.match(r"^\s*>\s?(.*)$", line)
        if m:
            body = _crm_inline_format(m.group(1).strip())
            out_lines.append(f'<em style="color:gray">&nbsp;&nbsp;❝ {body}</em>')
            continue

        # Markdown tables -> "Key: Value" rows
        if stripped.startswith("|") and stripped.endswith("|"):
            cells = [c.strip() for c in stripped.strip("|").split("|")]
            if cells and all(re.fullmatch(r":?-{3,}:?", c or "") for c in cells):
                # Markdown table separator row (|---|---|) -> drop.
                continue
            if cells:
                key = _crm_inline_format(cells[0] if len(cells) > 0 else "")
                val = _crm_inline_format(" | ".join(cells[1:]) if len(cells) > 1 else "")
                if val:
                    out_lines.append(_crm_colorize_keywords(f"<strong>{key}:</strong> {val}"))
                else:
                    out_lines.append(_crm_colorize_keywords(f"<strong>{key}</strong>"))
                continue

        # Checklist bullets
        m = re.match(r"^(\s*)[-*+]\s+\[([ xX!])\]\s+(.*)$", line)
        if m:
            depth = max(0, len(m.group(1)) // 2)
            prefix = "&nbsp;&nbsp;" * depth
            chk = m.group(2)
            symbol = "✓" if chk in ("x", "X") else "★" if chk == "!" else "◻"
            out_lines.append(
                _crm_colorize_keywords(f"{prefix}{symbol} {_crm_inline_format(m.group(3).strip())}")
            )
            continue

        # Standard bullets
        m = re.match(r"^(\s*)[-*+]\s+(.*)$", line)
        if m:
            depth = max(0, len(m.group(1)) // 2)
            if depth > 0:
                out_lines.append(_crm_colorize_keywords(
                    f"{'&nbsp;&nbsp;' * depth}◦ {_crm_inline_format(m.group(2).strip())}"
                ))
            else:
                out_lines.append(_crm_colorize_keywords(f"● {_crm_inline_format(m.group(2).strip())}"))
            continue

        # Numbered items
        m = re.match(r"^(\s*)(\d+)\.\s+(.*)$", line)
        if m:
            depth = max(0, len(m.group(1)) // 2)
            prefix = "&nbsp;&nbsp;" * depth
            out_lines.append(
                _crm_colorize_keywords(f"{prefix}{m.group(2)}. {_crm_inline_format(m.group(3).strip())}")
            )
            continue

        # Preserve left indentation with &nbsp;
        lead_spaces = len(line) - len(line.lstrip(" "))
        prefix = "&nbsp;" * lead_spaces
        out_lines.append(_crm_colorize_keywords(f"{prefix}{_crm_inline_format(line.lstrip(' '))}"))

    return "\n".join(out_lines)

# ── Notes Agent preset storage ────────────────────────────────────────────────

NOTES_AGENTS_DIR = settings.ui_data_dir / "_notes_agents"
NOTE_ROLLUPS_DIR  = settings.ui_data_dir / "_note_rollups"

DEFAULT_COMPLIANCE_SYSTEM = """You are a regulatory compliance analyst reviewing a single sales call note.

Given the call note, return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "Compliance Risk":    {"score": 80, "reasoning": "brief justification"},
  "Disclosure Quality": {"score": 75, "reasoning": "brief justification"},
  "Regulatory Language":{"score": 85, "reasoning": "brief justification"},
  "Sales Ethics":       {"score": 90, "reasoning": "brief justification"},
  "_overall": 82,
  "_summary": "One sentence overall compliance assessment",
  "_risk_level": "Low",
  "_violations": ["list specific violations, or leave empty"]
}

Rules:
- All scores are integers 0–100; higher = better compliance.
- _risk_level is exactly one of: Low, Medium, High.
- _violations is a list; leave [] if none found.
- Score every section from the note content only."""

DEFAULT_COMPLIANCE_PROMPT = "Score the compliance of this call note:"

DEFAULT_ROLLUP_SYSTEM = """You are a senior compliance analyst reviewing a complete series of call notes for a single agent-customer relationship.

Return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "overall_risk": "Low",
  "summary": "One sentence overall assessment.",
  "compliance_aggregate": {
    "procedures": [{"name": "Procedure Name", "compliant": 3, "violations": 1}],
    "total_violations": 5,
    "total_checks": 18
  },
  "call_progression": [{"call_id": "call_001", "stage": "Introduction", "outcome": "Interested"}],
  "key_patterns": ["Pattern observed across calls"],
  "next_steps": ["Priority action 1"],
  "violated_procedures": ["Procedure name"]
}

Rules:
- overall_risk is exactly one of: Low, Medium, High
- summary is a single sentence
- procedures: one entry per distinct compliance procedure found across all notes; compliant/violations are exact integer counts
- call_progression: one entry per call in chronological order
- key_patterns: 3–6 most important recurring issues as short strings
- next_steps: 5–8 actions ranked by urgency as short strings
- violated_procedures: list of procedure names that had at least one violation
- Do not estimate — extract exact numbers from the notes"""

DEFAULT_ROLLUP_PROMPT = "Analyse and aggregate all notes for this agent-customer relationship and return the JSON object:"

DEFAULT_SYSTEM = """You are a senior call analyst reviewing a single sales call transcript.

Produce a concise call note with EXACTLY these sections (each preceded by ##):

## Summary
What was discussed, key outcomes, the customer's stance at the end.

## Sales Techniques Used
Specific tactics, objection handling, persuasion methods observed in this call.

## Compliance & Risk
Required disclosures given or missed, any red flags, risk rating (Low / Medium / High).

## Communication Quality
Tone, clarity, active listening, rapport, pacing.

## Next Steps
Agreed next actions, follow-ups, open items.

Rules:
- Use the exact ## headings — do not rename, add, or remove sections.
- Be specific; quote the transcript directly where relevant.
- Keep each section concise (3–6 bullet points).
- Do not add a title or preamble before the first ## heading."""

DEFAULT_PROMPT = "Analyse this call and produce a concise call note:"


def _na_load_all() -> list[dict]:
    NOTES_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(NOTES_AGENTS_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    return out


def _na_find(name: str):
    """Return (Path, data) for the agent with given name, or raise 404."""
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if d.get("name") == name:
                return f, d
        except Exception:
            pass
    raise HTTPException(404, "Notes agent not found")


# ── Notes Agent CRUD — defined BEFORE /{note_id} routes ──────────────────────

class NotesAgentIn(BaseModel):
    name: str
    model: str = "gpt-5.4"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_SYSTEM
    user_prompt: str = DEFAULT_PROMPT
    is_default: bool = False
    # Compliancy agent fields (optional — defaults applied if absent)
    run_compliance: bool = True
    compliance_model: str = "gpt-5.4"
    compliance_system_prompt: str = DEFAULT_COMPLIANCE_SYSTEM
    compliance_user_prompt: str = DEFAULT_COMPLIANCE_PROMPT


@router.get("/agents")
def list_notes_agents():
    return _na_load_all()


@router.post("/agents")
def save_notes_agent(req: NotesAgentIn):
    NOTES_AGENTS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    # Upsert by name
    existing_file = None
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            if d.get("name") == req.name:
                existing_file = f
                break
        except Exception:
            pass

    if req.is_default:
        for f in NOTES_AGENTS_DIR.glob("*.json"):
            try:
                d = json.loads(f.read_text(encoding="utf-8"))
                if d.get("is_default") and d.get("name") != req.name:
                    d["is_default"] = False
                    f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    record = {
        "name": req.name,
        "model": req.model,
        "temperature": req.temperature,
        "system_prompt": req.system_prompt,
        "user_prompt": req.user_prompt,
        "is_default": req.is_default,
        "run_compliance": req.run_compliance,
        "compliance_model": req.compliance_model,
        "compliance_system_prompt": req.compliance_system_prompt,
        "compliance_user_prompt": req.compliance_user_prompt,
        "created_at": now,
    }
    target = existing_file or (NOTES_AGENTS_DIR / f"{uuid.uuid4()}.json")
    target.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    return record


@router.patch("/agents/{name}/default")
def set_notes_agent_default(name: str):
    for f in NOTES_AGENTS_DIR.glob("*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            want = d.get("name") == name
            if d.get("is_default") != want:
                d["is_default"] = want
                f.write_text(json.dumps(d, indent=2, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass
    return {"ok": True}


@router.delete("/agents/{name}")
def delete_notes_agent(name: str):
    f, _ = _na_find(name)
    f.unlink()
    return {"ok": True}


# ── List notes ────────────────────────────────────────────────────────────────

def _agent_names_for(agent: str) -> list[str]:
    """Return [agent] plus any alias names that map to this primary agent.

    e.g. "Leo West" → ["Leo West", "Leo West-Re13"]
    """
    from ui.backend.services.crm_service import _load_aliases
    aliases = _load_aliases()
    extras = [a for a, p in aliases.items() if p == agent]
    return [agent] + extras


def _is_dev_host(request: Request) -> bool:
    hosts: list[str] = []
    for key in ("x-forwarded-host", "host"):
        raw = str(request.headers.get(key) or "")
        if raw:
            hosts.extend([h.strip() for h in raw.split(",") if h.strip()])
    if request.url and request.url.hostname:
        hosts.append(str(request.url.hostname))
    for host in hosts:
        norm = host.split(":")[0].strip().lower()
        if not norm:
            continue
        if norm in {"localhost", "127.0.0.1"}:
            return True
        if norm == "shinobi.aleph-infinity.com":
            return True
    return False


def _resolve_account_for_note(agent: str, customer: str, db: Session) -> tuple[str, str]:
    names = _agent_names_for(agent)
    stmt = select(CRMPair).where(CRMPair.customer == customer)
    if len(names) == 1:
        stmt = stmt.where(CRMPair.agent == names[0])
    else:
        from sqlalchemy import or_
        stmt = stmt.where(or_(*[CRMPair.agent == n for n in names]))
    pairs = db.exec(stmt).all()
    if not pairs:
        return "", ""
    pairs.sort(
        key=lambda p: (
            int(getattr(p, "call_count", 0) or 0),
            float(getattr(p, "net_deposits", 0.0) or 0.0),
        ),
        reverse=True,
    )
    best = pairs[0]
    return str(best.account_id or "").strip(), str(best.crm_url or "").strip()


def _crm_base_url(raw_url: str) -> str:
    raw = str(raw_url or "").strip()
    if not raw:
        return ""
    if "://" not in raw:
        raw = f"https://{raw}"
    p = urlparse(raw)
    if not p.netloc:
        return ""
    scheme = p.scheme or "https"
    return f"{scheme}://{p.netloc}"


def _candidate_crm_push_endpoints(config_endpoint: str, crm_url: str, api_username: str) -> list[str]:
    out: list[str] = []
    api_username = str(api_username or "").strip()
    cfg = str(config_endpoint or "").strip()
    base = _crm_base_url(crm_url)

    if cfg:
        endpoint = cfg
        endpoint = endpoint.replace("{api_username}", api_username)
        endpoint = endpoint.replace("{crm_base}", base)
        endpoint = endpoint.replace("{crm_host}", urlparse(base).netloc if base else "")
        # If misconfigured to /accounts/<user>, force incoming path.
        if "/api/v1/accounts/" in endpoint and "-incoming" not in endpoint:
            _prefix, _sep, _tail = endpoint.partition("/api/v1/accounts/")
            endpoint = f"{_prefix}/api/v1/accounts/{api_username}-incoming"
        # Normalize to canonical endpoint (no trailing slash) to avoid 405 on some CRMs.
        out.append(endpoint.rstrip("/"))

    if base and api_username:
        incoming = f"{base}/api/v1/accounts/{api_username}-incoming"
        out.append(incoming)

    deduped: list[str] = []
    seen: set[str] = set()
    for item in out:
        u = str(item or "").strip()
        if not u:
            continue
        if u not in seen:
            deduped.append(u)
            seen.add(u)
    return deduped


@router.get("")
def list_notes(
    agent: str = Query(""),
    customer: str = Query(""),
    call_id: str = Query(""),
    db: Session = Depends(get_session),
):
    stmt = select(Note)
    if agent:
        names = _agent_names_for(agent)
        if len(names) == 1:
            stmt = stmt.where(Note.agent == agent)
        else:
            from sqlalchemy import or_
            stmt = stmt.where(or_(*[Note.agent == n for n in names]))
    if customer:
        stmt = stmt.where(Note.customer == customer)
    if call_id:
        stmt = stmt.where(Note.call_id == call_id)
    stmt = stmt.order_by(Note.created_at.desc())
    notes = db.exec(stmt).all()
    return [
        {
            "id": n.id,
            "agent": n.agent,
            "customer": n.customer,
            "call_id": n.call_id,
            "notes_agent_id": n.persona_agent_id,   # reusing the column
            "content_md": n.content_md,
            "score_json": json.loads(n.score_json) if n.score_json else None,
            "model": n.model,
            "temperature": n.temperature,
            "created_at": n.created_at.isoformat() if n.created_at else "",
        }
        for n in notes
    ]


# ── Manager summary helpers ───────────────────────────────────────────────────

def _get_call_meta(agent: str, customer: str, call_id: str) -> dict:
    """Return {date, duration_s, net_deposits, crm_url} for a specific call."""
    import json as _json
    meta: dict = {"date": None, "duration_s": None, "net_deposits": None, "crm_url": None}

    # Call date + duration from calls.json (tries alias dirs too)
    for a in _agent_names_for(agent):
        calls_path = settings.agents_dir / a / customer / "calls.json"
        if calls_path.exists():
            try:
                for c in _json.loads(calls_path.read_text()):
                    if str(c.get("call_id", "")) == str(call_id):
                        meta["date"] = c.get("started_at") or c.get("date")
                        meta["duration_s"] = c.get("duration_s") or c.get("audio_duration_s")
                        meta["crm_url"] = c.get("crm_url", "")
                        break
            except Exception:
                pass
        if meta["date"]:
            break

    # Net deposits from crm_pair table
    try:
        from ui.backend.database import engine
        from sqlmodel import Session as _Sess
        from ui.backend.models.crm import CRMPair
        with _Sess(engine) as _db:
            pairs = _db.exec(
                select(CRMPair.net_deposits, CRMPair.crm_url)
                .where(CRMPair.agent == agent, CRMPair.customer == customer)
            ).all()
            if pairs:
                meta["net_deposits"] = sum(float(p[0] or 0) for p in pairs)
                if not meta["crm_url"] and pairs[0][1]:
                    meta["crm_url"] = pairs[0][1]
    except Exception:
        pass

    return meta


def _build_summary_header(agent: str, customer: str, call_id: str, meta: dict) -> str:
    """Build a manager summary block matching the merged-transcript style."""
    from datetime import datetime, timezone
    nd = meta.get("net_deposits")
    nd_line = f"Net Deposits: ${nd:,.2f}\n" if nd is not None else ""
    date_str = str(meta.get("date") or "")[:19]
    dur_str = ""
    if meta.get("duration_s") is not None:
        d = int(meta["duration_s"])
        dur_str = f"  |  {d // 60}m{d % 60:02d}s"
    call_line = f"CALL {call_id}"
    if date_str:
        call_line += f"  |  {date_str}"
    call_line += dur_str
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    return (
        f"{'═' * 60}\n"
        f"MANAGER SUMMARY\n"
        f"Agent:    {agent}\n"
        f"Customer: {customer}\n"
        f"{nd_line}"
        f"Generated: {now}\n"
        f"{'═' * 60}\n"
        f"{'─' * 60}\n"
        f"{call_line}\n"
        f"{'─' * 60}\n\n"
    )


# ── Fetch transcript for a call ──────────────────────────────────────────────

@router.get("/transcript")
def get_transcript(
    agent: str = Query(...),
    customer: str = Query(...),
    call_id: str = Query(...),
):
    """Return the transcript text for a specific call (tries alias agent dirs too)."""
    for a in _agent_names_for(agent):
        call_dir = settings.agents_dir / a / customer / call_id
        for path in [
            call_dir / "transcribed" / "llm_final" / "smoothed.txt",
            call_dir / "transcribed" / "llm_final" / "voted.txt",
            call_dir / "transcribed" / "final.txt",
        ]:
            if path.exists():
                return {"text": path.read_text(encoding="utf-8").strip(), "source": path.name, "call_id": call_id}
    raise HTTPException(404, "No transcript found for this call")


# ── Delete note ───────────────────────────────────────────────────────────────

@router.delete("/{note_id}")
def delete_note(note_id: str, db: Session = Depends(get_session)):
    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note not found")
    db.delete(note)
    db.commit()
    return {"ok": True}


class NoteSendToCRMRequest(BaseModel):
    account_id: str = ""
    run_id: str = ""


def _append_manual_note_push_history(
    *,
    db: Session,
    note: Note,
    note_id: str,
    crm_status: int,
    endpoint: str,
    run_id: str = "",
) -> list[str]:
    """
    Best-effort audit trail so manual note push is visible in run history.
    """
    from ui.backend.models.pipeline_run import PipelineRun

    now_iso = datetime.utcnow().isoformat()
    rid = str(run_id or "").strip()
    endpoint_text = str(endpoint or "").strip()
    base_text = f"[CRM-PUSH] ✓ Sent note {note_id} to CRM (manual"
    if int(crm_status or 0) > 0:
        base_text += f", status {int(crm_status)}"
    base_text += ")"
    endpoint_line = f"[CRM-PUSH] endpoint: {endpoint_text}" if endpoint_text else ""

    target_rows: list[PipelineRun] = []
    seen: set[str] = set()

    def _add_row(row: Optional[PipelineRun]) -> None:
        if row is None:
            return
        row_id = str(getattr(row, "id", "") or "").strip()
        if not row_id or row_id in seen:
            return
        seen.add(row_id)
        target_rows.append(row)

    if rid:
        _add_row(db.get(PipelineRun, rid))

    # Always scan siblings — the pipeline upserts notes (same note_id for re-runs of the
    # same call), so multiple runs can reference the same note_id.  If we only mark the
    # specified run_id, sibling runs stay note_sent=False and trigger duplicate CRM sends.
    try:
        sibling_rows = db.exec(
            select(PipelineRun)
            .where(PipelineRun.call_id == str(note.call_id or ""))
            .order_by(PipelineRun.started_at.desc())
            .limit(120)
        ).all()
    except Exception:
        sibling_rows = []
    wanted_agent = str(note.agent or "").strip().lower()
    wanted_customer = str(note.customer or "").strip().lower()
    fallback_done_row: Optional[PipelineRun] = None
    for row in sibling_rows or []:
        row_agent = str(getattr(row, "sales_agent", "") or "").strip().lower()
        row_customer = str(getattr(row, "customer", "") or "").strip().lower()
        if row_agent != wanted_agent or row_customer != wanted_customer:
            continue
        try:
            parsed_steps = json.loads(str(getattr(row, "steps_json", "") or "[]"))
        except Exception:
            parsed_steps = []
        has_note = False
        if isinstance(parsed_steps, list):
            for step in parsed_steps:
                if not isinstance(step, dict):
                    continue
                if str(step.get("note_id") or "").strip() == note_id:
                    has_note = True
                    break
        if has_note:
            _add_row(row)
        elif fallback_done_row is None and str(getattr(row, "status", "") or "").strip().lower() in {
            "done", "completed", "success", "ok", "finished", "cached"
        }:
            fallback_done_row = row
    # Last resort: no run has this note_id in steps_json — mark the first done run.
    if not target_rows and fallback_done_row is not None:
        _add_row(fallback_done_row)

    updated_run_ids: list[str] = []
    for row in target_rows:
        try:
            logs = []
            try:
                parsed_logs = json.loads(str(getattr(row, "log_json", "") or "[]"))
                if isinstance(parsed_logs, list):
                    logs = parsed_logs
            except Exception:
                logs = []
            logs.append({"ts": now_iso, "text": base_text, "level": "info"})
            if endpoint_line:
                logs.append({"ts": now_iso, "text": endpoint_line, "level": "info"})
            row.log_json = json.dumps(logs[-400:], ensure_ascii=False)

            try:
                parsed_steps = json.loads(str(getattr(row, "steps_json", "") or "[]"))
            except Exception:
                parsed_steps = []
            if isinstance(parsed_steps, list):
                changed_steps = False
                for step in parsed_steps:
                    if not isinstance(step, dict):
                        continue
                    if str(step.get("note_id") or "").strip() != note_id:
                        continue
                    step["note_sent"] = True
                    step["note_sent_at"] = now_iso
                    if int(crm_status or 0) > 0:
                        step["note_sent_status"] = str(int(crm_status))
                    if endpoint_text:
                        step["note_sent_endpoint"] = endpoint_text
                    changed_steps = True
                if changed_steps:
                    row.steps_json = json.dumps(parsed_steps, ensure_ascii=False)

            # Write note_sent state directly to DB column (shared across VMs).
            row.note_sent = True
            row.note_sent_at = datetime.utcnow()
            db.add(row)
            updated_run_ids.append(str(getattr(row, "id", "") or ""))
        except Exception:
            continue

    if updated_run_ids:
        try:
            db.commit()
        except Exception:
            try:
                db.rollback()
            except Exception:
                pass
            return []
    return updated_run_ids


def send_note_to_crm_internal(
    note_id: str,
    account_id: str,
    db: Session,
    run_id: str = "",
):
    # Safety guard: development mirror host must never push notes back to CRM.
    if bool(settings.live_mirror_enabled):
        raise HTTPException(403, "CRM push is disabled in development mirror mode.")

    if not settings.crm_push_enabled:
        raise HTTPException(403, "CRM push is disabled. Set CRM_PUSH_ENABLED=true.")

    note = db.get(Note, note_id)
    if not note:
        raise HTTPException(404, "Note not found")

    missing = []
    if not settings.crm_push_api_username:
        missing.append("CRM_PUSH_API_USERNAME")
    if not settings.crm_push_api_password:
        missing.append("CRM_PUSH_API_PASSWORD")
    if not settings.crm_push_api_key:
        missing.append("CRM_PUSH_API_KEY")
    if missing:
        raise HTTPException(500, f"Missing CRM push credentials: {', '.join(missing)}")

    account_id = str(account_id or "").strip()
    crm_url = ""
    if not account_id:
        account_id, crm_url = _resolve_account_for_note(note.agent, note.customer, db)
    if not account_id:
        raise HTTPException(
            400,
            f"Could not resolve CRM account_id for {note.agent} / {note.customer}. Provide account_id explicitly.",
        )

    crm_note_html = _markdown_to_crm_html(str(note.content_md or ""))
    body = {
        "api_username": settings.crm_push_api_username,
        "api_password": settings.crm_push_api_password,
        "api_key": settings.crm_push_api_key,
        "account_id": account_id,
        # CRM expects raw note body in `data`; do not wrap with metadata JSON.
        "data": crm_note_html,
    }
    encoded_body = urlencode(body)
    endpoints = _candidate_crm_push_endpoints(
        str(settings.crm_push_endpoint or "").strip(),
        crm_url,
        str(settings.crm_push_api_username or ""),
    )
    if not endpoints:
        raise HTTPException(500, "Missing CRM push endpoint configuration")

    attempts: list[dict] = []
    resp = None
    endpoint_used = ""
    text = ""
    for endpoint in endpoints:
        request_log = _build_request_log(endpoint, body, encoded_body)
        try:
            candidate = _requests.post(
                endpoint,
                data=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=max(5, int(settings.crm_push_timeout_s or 20)),
            )
        except Exception as exc:
            attempts.append({"request": request_log, "error": str(exc)})
            continue
        candidate_text = (candidate.text or "").strip()
        if candidate.status_code >= 400:
            attempts.append({
                "request": request_log,
                "status": candidate.status_code,
                "response": _build_response_log(candidate.status_code, dict(candidate.headers), candidate_text),
            })
            continue
        resp = candidate
        endpoint_used = endpoint
        text = candidate_text
        break

    if resp is None:
        raise HTTPException(
            502,
            {
                "message": "CRM push failed on all candidate endpoints",
                "attempts": attempts,
                "note_id": note.id,
                "account_id": account_id,
            },
        )

    response_log = _build_response_log(resp.status_code, dict(resp.headers), text)
    request_log = _build_request_log(endpoint_used, body, encoded_body)
    print(f"[crm-push] note={note.id} request={json.dumps(request_log, ensure_ascii=False)}")
    print(f"[crm-push] note={note.id} response={json.dumps(response_log, ensure_ascii=False)}")

    history_run_ids: list[str] = []
    try:
        history_run_ids = _append_manual_note_push_history(
            db=db,
            note=note,
            note_id=str(note.id),
            crm_status=int(resp.status_code or 0),
            endpoint=endpoint_used,
            run_id=str(run_id or "").strip(),
        )
    except Exception:
        history_run_ids = []

    return {
        "ok": True,
        "message": "Note sent to CRM",
        "crm_status": resp.status_code,
        "crm_response": _clip_text(text, _CRM_DATA_PREVIEW_LIMIT),
        "crm_response_length": len(text),
        "crm_response_summary": _summarize_json_payload(text),
        "endpoint": endpoint_used,
        "attempts": attempts,
        "crm_request": request_log,
        "crm_response_log": response_log,
        "account_id": account_id,
        "crm_url": crm_url,
        "note_id": note.id,
        "history_run_ids": history_run_ids,
    }


@router.post("/{note_id}/send-to-crm")
def send_note_to_crm(
    note_id: str,
    req: NoteSendToCRMRequest,
    request: Request,
    db: Session = Depends(get_session),
):
    return send_note_to_crm_internal(
        note_id=note_id,
        account_id=str(req.account_id or "").strip(),
        run_id=str(req.run_id or "").strip(),
        db=db,
    )


# ── Analyze a single call — SSE stream ───────────────────────────────────────

class NoteAnalyzeRequest(BaseModel):
    agent: str
    customer: str
    call_id: str
    notes_agent_id: str = ""      # name of the notes agent preset used
    model: str = "gpt-5.4"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_SYSTEM
    user_prompt: str = DEFAULT_PROMPT
    notes_thinking: bool = False
    # Compliancy agent
    run_compliance: bool = False
    compliance_model: str = "gpt-5.4"
    compliance_system_prompt: str = DEFAULT_COMPLIANCE_SYSTEM
    compliance_user_prompt: str = DEFAULT_COMPLIANCE_PROMPT
    compliance_thinking: bool = False


@router.post("/analyze")
async def analyze_note(req: NoteAnalyzeRequest):
    loop = asyncio.get_event_loop()
    _label = f"{req.agent}/{req.customer}/{req.call_id}"

    async def stream():
        # Locate the single call's transcript
        call_dir = settings.agents_dir / req.agent / req.customer / req.call_id
        tx_path = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
        if not tx_path.exists():
            tx_path = call_dir / "transcribed" / "llm_final" / "voted.txt"
        if not tx_path.exists():
            yield _sse("error", {"msg": "No transcript found. Transcribe this call first."})
            return

        yield _sse("progress", {"step": 1, "total": 3, "msg": "Loading transcript…"})
        try:
            transcript = tx_path.read_text(encoding="utf-8").strip()
        except Exception as e:
            yield _sse("error", {"msg": f"Failed to read transcript: {e}"})
            return

        if not transcript:
            yield _sse("error", {"msg": "Transcript is empty."})
            return

        yield _sse("progress", {"step": 1, "total": 3,
            "msg": f"Transcript ready — {len(transcript):,} chars"})

        # Step 2: run notes agent
        print(f"[notes] {_label}: running notes agent model={req.model}")
        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Running notes agent ({req.model})…"})
        try:
            user_msg = f"{req.user_prompt.strip()}\n\n{transcript}"
            _notes_q: asyncio.Queue = asyncio.Queue()
            def _on_notes_chunk(t: str, _q=_notes_q):
                asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
            async def _notes_coro(_q=_notes_q):
                try:
                    r = await loop.run_in_executor(
                        None, _llm_stream_thinking,
                        req.system_prompt, user_msg, req.model,
                        req.temperature, req.notes_thinking, _on_notes_chunk)
                    await _q.put(("done", r))
                except Exception as exc:
                    await _q.put(("error", str(exc)))
            asyncio.create_task(_notes_coro())
            content_md = ""
            while True:
                kind, val = await _notes_q.get()
                if kind == "t":
                    yield _sse("thinking", {"text": val, "phase": "notes"})
                elif kind == "done":
                    content_md = val
                    break
                elif kind == "error":
                    raise RuntimeError(val)
        except Exception as e:
            print(f"[notes] {_label}: notes agent error: {e}")
            yield _sse("error", {"msg": f"Notes agent failed: {e}"})
            return

        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Note generated — {len(content_md):,} chars"})

        # Step 3: save
        # Prepend manager summary header
        try:
            meta = _get_call_meta(req.agent, req.customer, req.call_id)
            summary_header = _build_summary_header(req.agent, req.customer, req.call_id, meta)
            content_md = summary_header + content_md
        except Exception as _hdr_err:
            print(f"[notes] {_label}: summary header error (non-fatal): {_hdr_err}")

        yield _sse("progress", {"step": 3, "total": 3, "msg": "Saving note…"})
        try:
            from ui.backend.database import engine
            from sqlmodel import Session as _Session
            note_id = str(uuid.uuid4())
            note = Note(
                id=note_id,
                agent=req.agent,
                customer=req.customer,
                call_id=req.call_id,
                persona_agent_id=req.notes_agent_id or None,
                content_md=content_md,
                score_json=None,
                model=req.model,
                temperature=req.temperature,
                created_at=datetime.utcnow(),
            )
            with _Session(engine) as db:
                db.add(note)
                db.commit()
        except Exception as e:
            print(f"[notes] {_label}: save error: {e}")
            yield _sse("error", {"msg": f"Save failed: {e}"})
            return

        # Step 4 (optional): compliancy scoring
        comp_json: dict | None = None
        if req.run_compliance:
            yield _sse("progress", {"step": 4, "total": 4,
                "msg": f"Running compliancy agent ({req.compliance_model})…"})
            try:
                import re as _re
                comp_msg = f"{req.compliance_user_prompt.strip()}\n\n{content_md}"
                _comp_q: asyncio.Queue = asyncio.Queue()
                def _on_comp_chunk(t: str, _q=_comp_q):
                    asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
                async def _comp_coro(_q=_comp_q):
                    try:
                        r = await loop.run_in_executor(
                            None, _llm_stream_thinking,
                            req.compliance_system_prompt, comp_msg, req.compliance_model,
                            0.0, req.compliance_thinking, _on_comp_chunk)
                        await _q.put(("done", r))
                    except Exception as exc:
                        await _q.put(("error", str(exc)))
                asyncio.create_task(_comp_coro())
                comp_raw = ""
                while True:
                    kind, val = await _comp_q.get()
                    if kind == "t":
                        yield _sse("thinking", {"text": val, "phase": "compliance"})
                    elif kind == "done":
                        comp_raw = val
                        break
                    elif kind == "error":
                        raise RuntimeError(val)
                try:
                    comp_json = json.loads(comp_raw)
                except Exception:
                    m = _re.search(r'\{[\s\S]+\}', comp_raw)
                    comp_json = json.loads(m.group()) if m else {"_raw_text": comp_raw}
                with _Session(engine) as db:
                    note_obj = db.get(Note, note_id)
                    if note_obj:
                        note_obj.score_json = json.dumps(comp_json)
                        db.add(note_obj)
                        db.commit()
                overall = comp_json.get("_overall", "?")
                risk    = comp_json.get("_risk_level", "?")
                yield _sse("progress", {"step": 4, "total": 4,
                    "msg": f"Compliance scored — overall {overall} | risk {risk}"})
            except Exception as e:
                print(f"[notes] {_label}: compliance error: {e}")
                yield _sse("progress", {"step": 4, "total": 4,
                    "msg": "Compliance scoring failed (note still saved)"})

        print(f"[notes] {_label}: done — note_id={note_id}")
        yield _sse("done", {
            "note_id": note_id,
            "call_id": req.call_id,
            "content_md": content_md,
            "score_json": comp_json,
        })

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


# ── Roll-up: aggregate all notes for an agent+customer ────────────────────────

class NoteRollupRequest(BaseModel):
    agent: str
    customer: str
    preset: str = ""          # notes_agent_id to filter by; empty = all presets
    max_notes: int = 10       # cap to N most recent unique calls to avoid LLM timeout
    model: str = "gemini-2.5-flash"
    temperature: float = 0.0
    system_prompt: str = DEFAULT_ROLLUP_SYSTEM
    user_prompt: str = DEFAULT_ROLLUP_PROMPT
    thinking: bool = False


@router.get("/rollup")
def get_rollup(agent: str = Query(...), customer: str = Query(...), preset: str = Query("")):
    """Return the persisted roll-up JSON for agent+customer (optionally scoped to preset), or 404."""
    slug = preset.replace(" ", "_") if preset else "_all"
    rollup_path = NOTE_ROLLUPS_DIR / agent / f"{customer}__{slug}.json"
    # Fallback: legacy path without preset slug
    if not rollup_path.exists():
        rollup_path = NOTE_ROLLUPS_DIR / agent / f"{customer}.json"
    if not rollup_path.exists():
        raise HTTPException(404, "No saved rollup found")
    try:
        return json.loads(rollup_path.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(500, f"Failed to read rollup: {e}")


@router.post("/rollup")
async def rollup_notes(req: NoteRollupRequest):
    loop = asyncio.get_event_loop()
    _label = f"{req.agent}/{req.customer}"

    # Padding to push through Next.js / nginx proxy buffers (must be > 4 KB to flush)
    _PAD = ": " + " " * 4096 + "\n\n"

    async def stream():
        yield _PAD  # flush proxy buffer immediately

        from ui.backend.database import engine
        from sqlmodel import Session as _Session
        with _Session(engine) as db:
            agent_names = _agent_names_for(req.agent)
            if len(agent_names) == 1:
                agent_filter = Note.agent == req.agent
            else:
                from sqlalchemy import or_
                agent_filter = or_(*[Note.agent == n for n in agent_names])
            stmt = select(Note).where(
                agent_filter,
                Note.customer == req.customer,
            )
            if req.preset:
                stmt = stmt.where(Note.persona_agent_id == req.preset)
            stmt = stmt.order_by(Note.created_at)
            all_notes = db.exec(stmt).all()

        # Deduplicate: keep only the latest note per call_id
        seen: dict[str, Note] = {}
        for n in all_notes:
            seen[n.call_id] = n   # later rows overwrite earlier ones (ordered by created_at)
        all_unique = list(seen.values())
        all_unique.sort(key=lambda n: n.created_at)

        if not all_unique:
            preset_hint = f" with preset '{req.preset}'" if req.preset else ""
            yield _sse("error", {"msg": f"No notes found for this agent-customer pair{preset_hint}. Run the notes agent first."})
            return

        # Cap to most recent N notes to avoid LLM timeout on huge inputs
        total_unique = len(all_unique)
        notes = all_unique[-req.max_notes:] if req.max_notes > 0 else all_unique

        # Concatenate notes with separators
        parts_list = [f"\n\n---\n### Note {i} (Call: {note.call_id})\n\n{note.content_md}"
                      for i, note in enumerate(notes, 1)]
        combined = "".join(parts_list).strip()

        print(f"[rollup] {_label}: preset={req.preset!r} total_unique={total_unique} using={len(notes)} chars={len(combined):,}")

        # Emit preview — send another pad to ensure it flushes through the proxy
        yield _sse("notes_preview", {
            "note_count": len(notes),
            "total_unique": total_unique,
            "total_chars": len(combined),
            "preset": req.preset or "(all)",
            "preview": combined[:4000],
        })
        yield _PAD  # flush after preview so UI updates before LLM starts

        yield _sse("progress", {"step": 2, "total": 3,
            "msg": f"Running LLM on {len(notes)} notes ({len(combined):,} chars)…"})

        try:
            user_msg = f"{req.user_prompt.strip()}\n\n{combined}"
            _q: asyncio.Queue = asyncio.Queue()
            def _on_chunk(t: str, _q=_q):
                asyncio.run_coroutine_threadsafe(_q.put(("t", t)), loop)
            async def _coro(_q=_q):
                try:
                    r = await loop.run_in_executor(
                        None, _llm_stream_thinking,
                        req.system_prompt, user_msg, req.model,
                        req.temperature, req.thinking, _on_chunk)
                    await _q.put(("done", r))
                except Exception as exc:
                    await _q.put(("error", str(exc)))
            asyncio.create_task(_coro())
            result_raw = ""
            while True:
                kind, val = await _q.get()
                if kind == "t":
                    yield _sse("thinking", {"text": val, "phase": "rollup"})
                elif kind == "done":
                    result_raw = val
                    break
                elif kind == "error":
                    raise RuntimeError(val)
        except Exception as e:
            print(f"[rollup] {_label}: error: {e}")
            yield _sse("error", {"msg": f"Roll-up failed: {e}"})
            return

        # Parse JSON output (strip accidental code fences)
        import re as _re
        try:
            result_json = json.loads(result_raw)
        except Exception:
            m = _re.search(r'\{[\s\S]+\}', result_raw)
            try:
                result_json = json.loads(m.group()) if m else {"_raw_text": result_raw}
            except Exception:
                result_json = {"_raw_text": result_raw}

        # Persist to disk
        result_json["_saved_at"] = datetime.utcnow().isoformat()
        result_json["_note_count"] = len(notes)
        result_json["_preset"] = req.preset or "(all)"
        slug = req.preset.replace(" ", "_") if req.preset else "_all"
        try:
            save_dir = NOTE_ROLLUPS_DIR / req.agent
            save_dir.mkdir(parents=True, exist_ok=True)
            save_path = save_dir / f"{req.customer}__{slug}.json"
            save_path.write_text(json.dumps(result_json, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[rollup] {_label}: saved to {save_path}")
        except Exception as e:
            print(f"[rollup] {_label}: save error (non-fatal): {e}")

        yield _sse("progress", {"step": 3, "total": 3, "msg": "Summary complete"})
        print(f"[rollup] {_label}: done — {len(result_raw):,} chars")
        yield _sse("done", {"result_json": result_json, "note_count": len(notes)})

    return StreamingResponse(stream(), media_type="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })
