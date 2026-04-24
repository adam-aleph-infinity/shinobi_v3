"""Pipelines — ordered chains of universal agents."""
import asyncio
import hashlib
import json
import os
import queue as _queue
import re as _re
import threading
import time
import uuid
from datetime import datetime, timedelta
from types import SimpleNamespace as _SimpleNamespace
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text as _sql_text, inspect as _sa_inspect, func as _sql_func
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session, engine as _db_engine
from ui.backend.services import log_buffer, execution_logs

router = APIRouter(prefix="/pipelines", tags=["pipelines"])

_DIR = settings.ui_data_dir / "_pipelines"
_STATE_DIR = settings.ui_data_dir / "_pipeline_states"
_RUBRIC_DIR = settings.ui_data_dir / "_analytics_rubrics"
_ARTIFACT_SCHEMA_DIR = settings.ui_data_dir / "_artifact_prompt_schemas"
_AI_REGISTRY_DIR = settings.ui_data_dir / "_ai_registry"
_AI_PIPELINES_FILE = _AI_REGISTRY_DIR / "pipelines_snapshot.json"
_AI_INTERNAL_PROMPTS_FILE = _AI_REGISTRY_DIR / "internal_prompt_templates.json"
_AI_README_FILE = _AI_REGISTRY_DIR / "README.md"
_FOLDERS_FILE = settings.ui_data_dir / "_pipelines_folders.json"
_ACTIVE_RUN_LOCK = threading.Lock()
_ACTIVE_RUN_TASKS: dict[str, asyncio.Task] = {}
_STOP_REQUESTED: dict[str, threading.Event] = {}
_RUN_SUBSCRIBERS: dict[str, list[tuple[str, asyncio.Queue]]] = {}


def _safe_template_format(template: str, values: dict[str, Any]) -> str:
    class _SafeDict(dict):
        def __missing__(self, key: str) -> str:
            return "{" + key + "}"
    try:
        return str(template or "").format_map(_SafeDict(values))
    except Exception:
        return str(template or "")


def _default_internal_prompt_templates() -> dict[str, Any]:
    return {
        "analytics_rubric": {
            "system_prompt": (
                "You extract metric label rubrics from prompt templates.\n"
                "Return STRICT JSON only: {\"labels\": [\"...\"]}\n"
                "No markdown fences, no explanation."
            ),
            "user_prompt_template": (
                "Kind: {kind}\n"
                "Agent Name: {agent_name}\n"
                "Agent Class: {agent_class}\n\n"
                "SYSTEM PROMPT:\n{system_prompt}\n\n"
                "USER PROMPT:\n{user_prompt}\n\n"
                "Rules:\n"
                "- Return concise canonical labels.\n"
                "- Merge equivalent labels into one taxonomy.\n"
                "- Keep output deterministic."
            ),
        },
        "artifact_template": {
            "system_prompt": (
                "You infer expected artifact output schema from agent prompts.\n"
                "Return STRICT JSON only with keys:\n"
                "schema_template (string markdown), taxonomy (string[]), fields (object[]).\n"
                "Each field object: name (string), type (string), required (boolean), description (string).\n"
                "No markdown fences. No commentary."
            ),
            "user_prompt_template": (
                "Agent Name: {agent_name}\n"
                "Agent Class: {agent_class}\n"
                "Artifact Sub Type: {artifact_sub_type}\n\n"
                "SYSTEM PROMPT:\n{system_prompt}\n\n"
                "USER PROMPT:\n{user_prompt}\n\n"
                "Task:\n"
                "1) Derive concise expected output template from prompts.\n"
                "2) Extract taxonomy labels/sections.\n"
                "3) Infer structured fields where possible.\n"
                "4) Keep taxonomy canonical and deduplicated."
            ),
        },
    }


def _ensure_ai_registry_layout() -> None:
    try:
        _AI_REGISTRY_DIR.mkdir(parents=True, exist_ok=True)
        if not _AI_README_FILE.exists():
            _AI_README_FILE.write_text(
                (
                    "# AI Registry\n\n"
                    "This folder exposes app AI configurations in one place.\n\n"
                    "- `universal_agents_snapshot.json`: user-defined universal agents\n"
                    "- `pipelines_snapshot.json`: pipeline definitions\n"
                    "- `internal_prompt_templates.json`: internal LLM prompt templates used by analytics/artifact schema helpers\n"
                ),
                encoding="utf-8",
            )
    except Exception:
        pass


def _load_internal_prompt_templates() -> dict[str, Any]:
    defaults = _default_internal_prompt_templates()
    _ensure_ai_registry_layout()
    try:
        if _AI_INTERNAL_PROMPTS_FILE.exists():
            raw = json.loads(_AI_INTERNAL_PROMPTS_FILE.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                out = defaults.copy()
                for k, v in raw.items():
                    if isinstance(v, dict):
                        base = out.get(k, {}) if isinstance(out.get(k), dict) else {}
                        out[k] = {**base, **v}
                _AI_INTERNAL_PROMPTS_FILE.write_text(
                    json.dumps(out, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                return out
        _AI_INTERNAL_PROMPTS_FILE.write_text(
            json.dumps(defaults, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass
    return defaults


def _sync_ai_registry_pipelines() -> None:
    try:
        _ensure_ai_registry_layout()
        rows = _load_all()
        payload = []
        for p in rows:
            payload.append({
                "id": str(p.get("id") or ""),
                "name": str(p.get("name") or ""),
                "folder": str(p.get("folder") or ""),
                "scope": str(p.get("scope") or ""),
                "step_count": len(p.get("steps") or []),
                "updated_at": str(p.get("updated_at") or p.get("created_at") or ""),
                "path": f"_pipelines/{str(p.get('id') or '')}.json",
            })
        payload.sort(key=lambda x: (x["name"].lower(), x["id"]))
        _AI_PIPELINES_FILE.write_text(
            json.dumps(
                {
                    "generated_at": datetime.utcnow().isoformat(),
                    "count": len(payload),
                    "source_directories": {
                        "universal_agents": "_universal_agents/",
                        "pipelines": "_pipelines/",
                        "notes_agents": "_notes_agents/",
                        "persona_agents": "_persona_agents/",
                        "fpa_analyzer_presets": "_fpa_analyzer_presets/",
                        "fpa_generator_presets": "_fpa_generator_presets/",
                        "fpa_scorer_presets": "_fpa_scorer_presets/",
                        "analytics_rubrics": "_analytics_rubrics/",
                        "artifact_prompt_schemas": "_artifact_prompt_schemas/",
                    },
                    "pipelines": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _pair_key(pipeline_id: str, sales_agent: str, customer: str) -> str:
    """Deterministic filename key for a pipeline+pair state file.
    Uses an MD5 hash of the raw pair strings so the filename is stable and
    never affected by URL-encoding, case, or whitespace differences."""
    pair_hash = hashlib.md5(f"{sales_agent}::{customer}".encode("utf-8")).hexdigest()[:10]
    return f"{pipeline_id}_{pair_hash}"


def _run_slot_key(pipeline_id: str, sales_agent: str, customer: str, call_id: str) -> str:
    return f"{pipeline_id}::{sales_agent}::{customer}::{call_id or ''}"


def _save_state(
    pipeline_id: str,
    run_id: str,
    sales_agent: str,
    customer: str,
    status: str,
    steps: list,
    force: bool = False,
    start_datetime: str = "",
    node_states: Optional[dict] = None,
) -> None:
    """Write live run state to a JSON file keyed by pipeline+pair hash.
    Called from save_steps() (status='running') and on completion/error.
    For browser refresh/disconnect, keep the last snapshot as 'running'
    so the UI can restore without showing a false failure.

    force=True: always write (used for the initial claim by a new run).
    force=False: skip if a *different* run_id already owns the file (kill-and-restart guard —
                 prevents an orphaned old generator from overwriting the new run's state).

    State file schema:
      pipeline status: idle | running | pass | failed
      step state:      waiting | running | completed | failed
      step fields:     start_time, end_time, cached_locations"""
    try:
        _STATE_DIR.mkdir(parents=True, exist_ok=True)
        path = _STATE_DIR / f"{_pair_key(pipeline_id, sales_agent, customer)}.json"
        if not force:
            try:
                existing = json.loads(path.read_text(encoding="utf-8"))
                if existing.get("run_id") and existing.get("run_id") != run_id:
                    return  # a newer run has claimed this file — don't overwrite
            except Exception:
                pass
        sanitized_steps: list = []
        for step in (steps or []):
            if isinstance(step, dict):
                step_copy = dict(step)
                # State file is for execution status only; keep heavy model output out.
                step_copy["content"] = ""
                step_copy["thinking"] = ""
                sanitized_steps.append(step_copy)
            else:
                sanitized_steps.append(step)

        path.write_text(
            json.dumps({
                "pipeline_id":    pipeline_id,
                "run_id":         run_id,
                "sales_agent":    sales_agent,
                "customer":       customer,
                "status":         status,
                "start_datetime": start_datetime,
                "updated_at":     datetime.utcnow().isoformat(),
                "steps":          sanitized_steps,
                "node_states":    node_states or {"input": {}, "processing": {}, "output": {}},
            }, ensure_ascii=False),
            encoding="utf-8",
        )
    except Exception:
        pass


class PipelineStep(BaseModel):
    agent_id: str
    input_overrides: dict[str, str] = {}


class PipelineIn(BaseModel):
    name: str
    description: str = ""
    scope: str = "per_pair"
    steps: list[PipelineStep] = []
    canvas: dict = {}
    folder: str = ""


class FolderIn(BaseModel):
    name: str


class FolderMoveIn(BaseModel):
    folder: str = ""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash_text(value: str) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _build_input_fingerprint(
    pipeline_id: str,
    step_idx: int,
    agent_id: str,
    model: str,
    temperature: float,
    system_prompt: str,
    user_template: str,
    overrides: dict[str, str],
    resolved_inputs: dict[str, str],
) -> str:
    payload = {
        "pipeline_id": pipeline_id,
        "step_idx": step_idx,
        "agent_id": agent_id,
        "model": model,
        "temperature": temperature,
        "system_prompt_hash": _hash_text(system_prompt),
        "user_prompt_hash": _hash_text(user_template),
        "overrides": overrides,
        "resolved_hashes": {k: _hash_text(v) for k, v in sorted(resolved_inputs.items())},
    }
    return hashlib.sha256(
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _validate_pipeline_payload(req: PipelineIn) -> None:
    for i, step in enumerate(req.steps):
        if not (step.agent_id or "").strip():
            raise HTTPException(400, f"Pipeline step {i + 1} is missing agent_id")

    canvas_nodes = (req.canvas or {}).get("nodes", []) if isinstance(req.canvas, dict) else []
    if not canvas_nodes:
        return

    proc_nodes = [n for n in canvas_nodes if n.get("type") == "processing"]
    unassigned = [n for n in proc_nodes if not (n.get("data", {}) or {}).get("agentId")]
    if unassigned:
        raise HTTPException(
            400,
            f"Canvas has {len(unassigned)} processing node(s) without an assigned agent. "
            "Assign an agent or remove those nodes before saving.",
        )

    proc_with_agent = [n for n in proc_nodes if (n.get("data", {}) or {}).get("agentId")]
    if proc_with_agent and len(proc_with_agent) < len(req.steps):
        raise HTTPException(
            400,
            "Canvas/step mismatch: fewer assigned processing nodes than pipeline steps.",
        )


def _extract_agent_output_subtypes(canvas_json: str) -> dict[str, str]:
    """Map processing agent_id -> output subType from canvas snapshot."""
    try:
        canvas = json.loads(canvas_json or "{}")
        nodes = canvas.get("nodes") or []
        edges = canvas.get("edges") or []
        if not isinstance(nodes, list) or not isinstance(edges, list):
            return {}

        node_by_id: dict[str, dict] = {}
        for n in nodes:
            if isinstance(n, dict):
                node_by_id[str(n.get("id") or "")] = n

        out_edges: dict[str, list[str]] = {}
        for e in edges:
            if not isinstance(e, dict):
                continue
            src = str(e.get("source") or "")
            dst = str(e.get("target") or "")
            if not src or not dst:
                continue
            out_edges.setdefault(src, []).append(dst)

        out: dict[str, str] = {}
        for n in nodes:
            if not isinstance(n, dict):
                continue
            if str(n.get("type") or "") != "processing":
                continue
            data = n.get("data") or {}
            if not isinstance(data, dict):
                continue
            agent_id = str(data.get("agentId") or "").strip()
            if not agent_id:
                continue
            for dst in out_edges.get(str(n.get("id") or ""), []):
                out_node = node_by_id.get(dst) or {}
                if str(out_node.get("type") or "") != "output":
                    continue
                out_data = out_node.get("data") or {}
                if not isinstance(out_data, dict):
                    continue
                sub_type = str(out_data.get("subType") or "").strip().lower()
                if sub_type:
                    out[agent_id] = sub_type
                    break
        return out
    except Exception:
        return {}


def _normalise_metric_name(name: str) -> str:
    return " ".join(str(name or "").strip().split())


def _is_summary_violation_metric(name: str) -> bool:
    low = _normalise_metric_name(name).lower()
    if not low:
        return False
    # Summary lines should not be counted as a violation type.
    return low.startswith("total violations")


def _canonical_score_taxonomy_label(name: str) -> str:
    n = _normalise_metric_name(name)
    if not n:
        return n
    n = _re.sub(r"^\d+\s*[\).\:-]\s*", "", n).strip()
    n = _re.sub(r"\s*[\-–:]?\s*score\s*$", "", n, flags=_re.IGNORECASE).strip()
    n = _re.sub(r"\s*/\s*100\s*$", "", n).strip()
    return _normalise_metric_name(n)


def _canonical_violation_taxonomy_label(name: str) -> str:
    n = _normalise_metric_name(name)
    if not n:
        return n
    slug = _slug_metric_name(n)
    if not slug:
        return n

    if "secret" in slug and "code" in slug:
        return "Secret Code Violations"
    if (
        "simpletruthaboutyourmoney" in slug
        or ("requiredemail" in slug and "money" in slug)
        or ("emailviolations" in slug and "simpletruth" in slug)
    ):
        return "Simple Truth About Your Money Email Violations"
    if "emailverification" in slug and (
        "missing" in slug or "receipt" in slug or "view" in slug or "read" in slug
    ):
        return "Email Verification Missing"
    if ("multiplatform" in slug or "successfee" in slug) and (
        "followup" in slug or "followupverification" in slug or "verification" in slug
    ):
        return "Multi-Platform Follow-Up Missing"
    if ("multiplatform" in slug or "successfee" in slug) and (
        "offer" in slug or "introduction" in slug or "introduced" in slug
    ):
        return "Multi-Platform Offer Missing"
    return n


def _canonical_taxonomy_label(kind: str, name: str) -> str:
    k = str(kind or "").strip().lower()
    if k == "score":
        return _canonical_score_taxonomy_label(name)
    if k == "violation":
        return _canonical_violation_taxonomy_label(name)
    return _normalise_metric_name(name)


def _parse_scores_from_text(content: str) -> dict[str, float]:
    """Extract section scores from JSON or markdown/text score blocks."""
    txt = (content or "").strip()
    if not txt:
        return {}

    def _from_obj(obj: Any) -> dict[str, float]:
        out: dict[str, float] = {}
        if not isinstance(obj, dict):
            return out
        for raw_k, raw_v in obj.items():
            key = _normalise_metric_name(str(raw_k or ""))
            if not key or key.startswith("_"):
                continue
            score: Optional[float] = None
            if isinstance(raw_v, (int, float)):
                score = float(raw_v)
            elif isinstance(raw_v, dict):
                sv = raw_v.get("score")
                if isinstance(sv, (int, float)):
                    score = float(sv)
            if score is None:
                continue
            out[key] = max(0.0, min(100.0, score))
        return out

    # Direct JSON first.
    try:
        parsed = json.loads(txt)
        got = _from_obj(parsed)
        if got:
            return got
    except Exception:
        pass

    # JSON embedded in text/codefence.
    try:
        m = _re.search(r"\{[\s\S]+\}", txt)
        if m:
            parsed = json.loads(m.group(0))
            got = _from_obj(parsed)
            if got:
                return got
    except Exception:
        pass

    out: dict[str, float] = {}

    # Pattern: "Category Name" line followed by "Score: 88/100".
    for sec, score in _re.findall(
        r"(?im)^\s*([^\n:][^\n]{1,120})\s*\n\s*Score:\s*([0-9]{1,3})(?:\s*/\s*100)?\s*$",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if not k:
            continue
        out[k] = max(0.0, min(100.0, float(score)))

    # Pattern: "Category: 88/100".
    for sec, score in _re.findall(
        r"(?im)^\s*[•\-\*]?\s*([^:\n]{2,120})\s*:\s*([0-9]{1,3})\s*/\s*100\b",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if not k:
            continue
        out[k] = max(0.0, min(100.0, float(score)))

    return out


def _parse_violations_from_text(content: str) -> dict[str, int]:
    """Extract violation totals by procedure from notes/compliance text."""
    txt = (content or "").strip()
    if not txt:
        return {}

    summary_counts: dict[str, int] = {}
    line_counts: dict[str, int] = {}
    current_proc = ""
    in_summary = False

    for raw in txt.splitlines():
        line = str(raw or "").strip()
        if not line:
            continue
        low = line.lower()

        if "total violations by procedure" in low:
            in_summary = True
            continue

        if in_summary:
            m = _re.match(r"^[•\-\*]\s*(.+?)\s*:\s*(\d+)\s*$", line)
            if m:
                k = _normalise_metric_name(m.group(1))
                if k:
                    summary_counts[k] = int(m.group(2))
                continue
            # Allow plain "Total Violations (All Procedures): X"
            m2 = _re.match(r"^total violations.*?:\s*(\d+)\s*$", low)
            if m2:
                # This is a summary row, not a violation type metric.
                continue

        # Track the current procedure title preceding status lines.
        proc_match = _re.match(r"^[•\-\*]\s*(.+?)\s*$", line)
        if proc_match:
            current_proc = _normalise_metric_name(proc_match.group(1))

        if "[violation]" in low:
            key = current_proc
            if not key:
                m = _re.search(r"\[violation\]\s*[–-]\s*(.+)$", line, _re.IGNORECASE)
                key = _normalise_metric_name(m.group(1)) if m else "Violation"
            line_counts[key] = line_counts.get(key, 0) + 1

    if summary_counts:
        for k in list(summary_counts.keys()):
            if _is_summary_violation_metric(k):
                summary_counts.pop(k, None)
        for k, v in line_counts.items():
            if k not in summary_counts:
                summary_counts[k] = v
        return summary_counts

    return {k: v for k, v in line_counts.items() if not _is_summary_violation_metric(k)}


def _unique_metric_list(items: list[str], kind: str = "") -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for raw in items:
        key = _canonical_taxonomy_label(kind, raw)
        if not key:
            continue
        if str(kind).strip().lower() == "violation" and _is_summary_violation_metric(key):
            continue
        low = key.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(key)
    return out


def _slug_metric_name(name: str) -> str:
    return _re.sub(r"[^a-z0-9]+", "", str(name or "").lower())


def _build_catalog_lookup(items: list[str], kind: str = "") -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        canonical = _canonical_taxonomy_label(kind, item)
        slug = _slug_metric_name(canonical)
        if slug and slug not in out:
            out[slug] = canonical
    return out


def _canonical_metric_name(name: str, lookup: dict[str, str], kind: str = "") -> str:
    normalized = _canonical_taxonomy_label(kind, name)
    if not lookup:
        return normalized
    slug = _slug_metric_name(normalized)
    if slug in lookup:
        return lookup[slug]
    if slug:
        for k, v in lookup.items():
            if slug in k or k in slug:
                return v
    return normalized


def _extract_json_obj_from_text(content: str) -> dict[str, Any]:
    txt = str(content or "").strip()
    if not txt:
        return {}
    for candidate in (
        txt,
        *_re.findall(r"```(?:json)?\s*([\s\S]*?)```", txt, flags=_re.IGNORECASE),
        *_re.findall(r"(\{[\s\S]*\})", txt),
    ):
        s = str(candidate or "").strip()
        if not s:
            continue
        try:
            parsed = json.loads(s)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            continue
    return {}


def _heuristic_extract_score_sections_from_prompt(system_prompt: str, user_prompt: str) -> list[str]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    found: list[str] = []

    # JSON-style schemas: "Section Name": {"score": ...}
    for sec in _re.findall(
        r'["“]([^"\n]{2,120})["”]\s*:\s*\{[^{}]{0,200}["“]score["”]',
        txt,
        flags=_re.IGNORECASE,
    ):
        k = _normalise_metric_name(sec)
        if k and not k.startswith("_"):
            found.append(k)

    # Section heading followed by Score line.
    for sec in _re.findall(
        r"(?im)^\s*([A-Za-z][^\n:]{2,120})\s*\n\s*Score\s*[:\-]",
        txt,
    ):
        k = _normalise_metric_name(sec)
        if k:
            found.append(k)

    return _unique_metric_list(found, kind="score")


def _heuristic_extract_violation_types_from_prompt(system_prompt: str, user_prompt: str) -> list[str]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    found: list[str] = []

    # Preferred: explicit "Total Violations by Procedure" bullet list.
    if "total violations by procedure" in txt.lower():
        for name in _re.findall(r"(?im)^[•\-\*]\s*(.+?)\s*:\s*[x0-9]+\s*$", txt):
            k = _normalise_metric_name(name)
            if k and "total violations" not in k.lower():
                found.append(k)

    # Fallback: explicit violation labels.
    if not found:
        for name in _re.findall(r"(?im)^[•\-\*]\s*(.+?violations?)\s*$", txt):
            k = _normalise_metric_name(name)
            if k:
                found.append(k)

    return _unique_metric_list(found, kind="violation")


def _infer_prompt_rubric_with_llm(
    kind: str,
    agent_name: str,
    agent_class: str,
    system_prompt: str,
    user_prompt: str,
    db: Session,
) -> tuple[list[str], str]:
    """Use an LLM once to extract stable metric labels from an agent prompt pair."""
    from ui.backend.routers.universal_agents import _llm_call_with_files

    templates = _load_internal_prompt_templates().get("analytics_rubric", {})
    model = os.environ.get("ANALYTICS_RUBRIC_MODEL", "gpt-5.4")
    key = "score_sections" if kind == "score" else "violation_types"
    task = (
        "Extract ONLY the canonical score section names that are intended to be scored."
        if kind == "score"
        else "Extract ONLY the canonical company procedure / violation type labels used for compliance totals."
    )

    sys = str(templates.get("system_prompt") or "").strip() or (
        "You extract metric label rubrics from prompt templates.\n"
        "Return STRICT JSON only, no markdown, no commentary."
    )
    user_template = str(templates.get("user_prompt_template") or "").strip() or (
        "Kind: {kind}\n"
        "Agent Name: {agent_name}\n"
        "Agent Class: {agent_class}\n\n"
        "SYSTEM PROMPT:\n{system_prompt}\n\n"
        "USER PROMPT:\n{user_prompt}\n\n"
        "TASK: {task}\n\n"
        'Return exactly: {{"{key}": ["label 1", "label 2"]}}\n'
        "Rules:\n"
        "- Keep labels short, canonical, and human-readable.\n"
        "- Normalize equivalent labels into a consistent taxonomy across agents.\n"
        "- Remove duplicates.\n"
        "- Exclude helper/meta keys (for example keys that start with _).\n"
        "{violation_hint}"
    )
    violation_hint = (
        "- For violation taxonomy, prefer these canonical labels when equivalent:\n"
        "  Secret Code Violations\n"
        "  Simple Truth About Your Money Email Violations\n"
        "  Email Verification Missing\n"
        "  Multi-Platform Offer Missing\n"
        "  Multi-Platform Follow-Up Missing\n"
        if kind == "violation"
        else ""
    )
    user = _safe_template_format(
        user_template,
        {
            "kind": kind,
            "agent_name": agent_name,
            "agent_class": agent_class,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "task": task,
            "key": key,
            "violation_hint": violation_hint,
        },
    )

    raw, _ = _llm_call_with_files(sys, user, {}, {}, model, 0.0, db)
    parsed = _extract_json_obj_from_text(raw)
    vals = parsed.get(key, [])
    if not isinstance(vals, list):
        raise RuntimeError(f"invalid rubric payload key '{key}'")
    labels = _unique_metric_list([str(v or "") for v in vals], kind=kind)
    return labels, model


def _load_cached_prompt_rubric(agent_id: str, kind: str, prompt_hash: str) -> Optional[tuple[list[str], str]]:
    try:
        path = _RUBRIC_DIR / f"{kind}_{agent_id}.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("prompt_hash") != prompt_hash:
            return None
        labels = data.get("labels")
        if not isinstance(labels, list):
            return None
        return _unique_metric_list([str(x or "") for x in labels], kind=kind), str(data.get("model") or "")
    except Exception:
        return None


def _save_cached_prompt_rubric(
    agent_id: str,
    kind: str,
    prompt_hash: str,
    labels: list[str],
    method: str,
    model: str,
) -> None:
    try:
        _RUBRIC_DIR.mkdir(parents=True, exist_ok=True)
        path = _RUBRIC_DIR / f"{kind}_{agent_id}.json"
        payload = {
            "agent_id": agent_id,
            "kind": kind,
            "prompt_hash": prompt_hash,
            "labels": _unique_metric_list(labels, kind=kind),
            "method": method,
            "model": model,
            "updated_at": datetime.utcnow().isoformat(),
        }
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def _derive_agent_prompt_rubric(
    agent_def: dict,
    kind: str,
    db: Session,
) -> tuple[list[str], str, str]:
    """Return (labels, method, model). method: cache|llm|heuristic|none"""
    agent_id = str(agent_def.get("id") or "")
    agent_name = str(agent_def.get("name") or "")
    agent_class = str(agent_def.get("agent_class") or "")
    system_prompt = str(agent_def.get("system_prompt") or "")
    user_prompt = str(agent_def.get("user_prompt") or "")

    if not (system_prompt or user_prompt):
        return [], "none", ""

    prompt_hash = _hash_text(
        json.dumps(
            {
                "name": agent_name,
                "class": agent_class,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            },
            sort_keys=True,
            ensure_ascii=False,
        )
    )

    cached = _load_cached_prompt_rubric(agent_id, kind, prompt_hash)
    if cached is not None:
        return cached[0], "cache", cached[1]

    heuristic = (
        _heuristic_extract_score_sections_from_prompt(system_prompt, user_prompt)
        if kind == "score"
        else _heuristic_extract_violation_types_from_prompt(system_prompt, user_prompt)
    )
    labels = heuristic
    method = "heuristic" if heuristic else "none"
    model = ""

    try:
        llm_labels, llm_model = _infer_prompt_rubric_with_llm(
            kind=kind,
            agent_name=agent_name,
            agent_class=agent_class,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            db=db,
        )
        if llm_labels:
            labels = llm_labels
            method = "llm"
            model = llm_model
    except Exception:
        pass

    labels = _unique_metric_list(labels, kind=kind)

    _save_cached_prompt_rubric(
        agent_id=agent_id,
        kind=kind,
        prompt_hash=prompt_hash,
        labels=labels,
        method=method,
        model=model,
    )
    return labels, method, model


def _artifact_template_key(agent_id: str, artifact_sub_type: str) -> str:
    aid = str(agent_id or "").strip()
    sub = str(artifact_sub_type or "").strip().lower() or "output"
    safe_sub = _re.sub(r"[^a-z0-9_\-]+", "_", sub)
    return f"{aid}_{safe_sub}.json"


def _load_cached_artifact_template(
    agent_id: str,
    artifact_sub_type: str,
    prompt_hash: str,
) -> Optional[dict[str, Any]]:
    try:
        path = _ARTIFACT_SCHEMA_DIR / _artifact_template_key(agent_id, artifact_sub_type)
        data = json.loads(path.read_text(encoding="utf-8"))
        if str(data.get("prompt_hash") or "") != str(prompt_hash or ""):
            return None
        payload = data.get("payload")
        if not isinstance(payload, dict):
            return None
        return {
            **payload,
            "method": str(data.get("method") or payload.get("method") or "cache"),
            "model": str(data.get("model") or payload.get("model") or ""),
            "updated_at": str(data.get("updated_at") or payload.get("updated_at") or ""),
        }
    except Exception:
        return None


def _save_cached_artifact_template(
    agent_id: str,
    artifact_sub_type: str,
    prompt_hash: str,
    payload: dict[str, Any],
    method: str,
    model: str,
) -> None:
    try:
        _ARTIFACT_SCHEMA_DIR.mkdir(parents=True, exist_ok=True)
        path = _ARTIFACT_SCHEMA_DIR / _artifact_template_key(agent_id, artifact_sub_type)
        path.write_text(
            json.dumps(
                {
                    "agent_id": str(agent_id or ""),
                    "artifact_sub_type": str(artifact_sub_type or ""),
                    "prompt_hash": str(prompt_hash or ""),
                    "method": str(method or ""),
                    "model": str(model or ""),
                    "updated_at": datetime.utcnow().isoformat(),
                    "payload": payload,
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except Exception:
        pass


def _infer_artifact_template_with_llm(
    *,
    agent_name: str,
    agent_class: str,
    artifact_sub_type: str,
    system_prompt: str,
    user_prompt: str,
    db: Session,
) -> tuple[dict[str, Any], str]:
    from ui.backend.routers.universal_agents import _llm_call_with_files

    templates = _load_internal_prompt_templates().get("artifact_template", {})
    model = os.environ.get("ARTIFACT_TEMPLATE_MODEL", "gpt-5.4")
    sys = str(templates.get("system_prompt") or "").strip() or (
        "You infer expected artifact output schema from agent prompts.\n"
        "Return STRICT JSON only with keys:\n"
        "schema_template (string markdown), taxonomy (string[]), fields (object[]).\n"
        "Each field object: name (string), type (string), required (boolean), description (string).\n"
        "No markdown fences. No commentary."
    )
    user_template = str(templates.get("user_prompt_template") or "").strip() or (
        "Agent Name: {agent_name}\n"
        "Agent Class: {agent_class}\n"
        "Artifact Sub Type: {artifact_sub_type}\n\n"
        "SYSTEM PROMPT:\n{system_prompt}\n\n"
        "USER PROMPT:\n{user_prompt}\n\n"
        "Task:\n"
        "1) Derive a concise expected output template from these prompts.\n"
        "2) Extract taxonomy labels/sections the output should contain.\n"
        "3) Infer structured fields where possible.\n"
        "4) Keep taxonomy canonical and deduplicated.\n"
        "5) If uncertain, provide best-effort placeholders."
    )
    user = _safe_template_format(
        user_template,
        {
            "agent_name": agent_name,
            "agent_class": agent_class,
            "artifact_sub_type": artifact_sub_type,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
        },
    )
    raw, _ = _llm_call_with_files(sys, user, {}, {}, model, 0.0, db)
    parsed = _extract_json_obj_from_text(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("artifact template parse failed")
    schema_template = str(parsed.get("schema_template") or "").strip()
    if not schema_template:
        raise RuntimeError("artifact template missing schema_template")
    raw_tax = parsed.get("taxonomy")
    taxonomy = [str(x or "").strip() for x in raw_tax] if isinstance(raw_tax, list) else []
    taxonomy = [x for x in taxonomy if x]
    raw_fields = parsed.get("fields")
    fields: list[dict[str, Any]] = []
    if isinstance(raw_fields, list):
        for item in raw_fields:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "").strip()
            if not name:
                continue
            fields.append({
                "name": name,
                "type": str(item.get("type") or "string").strip() or "string",
                "required": bool(item.get("required", False)),
                "description": str(item.get("description") or "").strip(),
            })
    return {
        "schema_template": schema_template,
        "taxonomy": taxonomy,
        "fields": fields,
    }, model


def _heuristic_artifact_template(
    *,
    artifact_sub_type: str,
    system_prompt: str,
    user_prompt: str,
) -> dict[str, Any]:
    txt = f"{system_prompt or ''}\n\n{user_prompt or ''}"
    headers = [
        _normalise_metric_name(h)
        for h in _re.findall(r"(?im)^\s*##\s+(.+?)\s*$", txt)
    ]
    headers = [h for h in headers if h]

    taxonomy: list[str]
    sub = str(artifact_sub_type or "").strip().lower()
    if sub == "persona_score":
        taxonomy = _heuristic_extract_score_sections_from_prompt(system_prompt, user_prompt)
    elif sub == "notes_compliance":
        taxonomy = _heuristic_extract_violation_types_from_prompt(system_prompt, user_prompt)
    else:
        taxonomy = _unique_metric_list(headers, kind="")

    placeholders = [
        _normalise_metric_name(p)
        for p in _re.findall(r"\{([a-zA-Z0-9_]+)\}", txt)
    ]
    placeholders = [p for p in placeholders if p]

    fields = [
        {
            "name": p,
            "type": "string",
            "required": True,
            "description": f"Prompt placeholder: {p}",
        }
        for p in placeholders
    ]

    if taxonomy:
        lines = ["# Expected Artifact Output", ""]
        for label in taxonomy:
            lines.append(f"## {label}")
            lines.append("- <required content>")
            lines.append("")
        schema_template = "\n".join(lines).strip()
    else:
        schema_template = (
            "# Expected Artifact Output\n\n"
            "## Summary\n"
            "- <required content>\n\n"
            "## Details\n"
            "- <required content>"
        )

    return {
        "schema_template": schema_template,
        "taxonomy": taxonomy,
        "fields": fields,
    }


def _is_score_agent_def(agent_def: dict, sub_type: str) -> bool:
    st = str(sub_type or "").strip().lower()
    if st == "persona_score":
        return True
    cls = str(agent_def.get("agent_class") or "").lower()
    name = str(agent_def.get("name") or "").lower()
    tags = [str(t or "").lower() for t in (agent_def.get("tags") or [])]
    return (
        "scorer" in cls
        or "score" in cls
        or "scorer" in name
        or any(("scorer" in t or "score" in t) for t in tags)
    )


def _is_violation_agent_def(agent_def: dict, sub_type: str) -> bool:
    st = str(sub_type or "").strip().lower()
    if st == "notes_compliance":
        return True
    cls = str(agent_def.get("agent_class") or "").lower()
    name = str(agent_def.get("name") or "").lower()
    tags = [str(t or "").lower() for t in (agent_def.get("tags") or [])]
    return (
        "compliance" in cls
        or "notes" in cls
        or "compliance" in name
        or "notes" in name
        or any(("compliance" in t or "notes" in t or "violation" in t) for t in tags)
    )


def _collect_pipeline_rubric_catalog(
    pipeline_def: dict,
    agent_map: dict[str, dict],
    db: Session,
) -> dict[str, Any]:
    canvas_json = json.dumps(pipeline_def.get("canvas", {}), ensure_ascii=False)
    subtype_by_agent = _extract_agent_output_subtypes(canvas_json)

    score_sections: list[str] = []
    violation_types: list[str] = []
    score_sources: list[dict] = []
    violation_sources: list[dict] = []
    seen_score_agent: set[str] = set()
    seen_violation_agent: set[str] = set()

    for step in (pipeline_def.get("steps") or []):
        if not isinstance(step, dict):
            continue
        aid = str(step.get("agent_id") or "")
        if not aid:
            continue
        agent_def = agent_map.get(aid, {})
        sub_type = subtype_by_agent.get(aid, "")

        if _is_score_agent_def(agent_def, sub_type) and aid not in seen_score_agent:
            seen_score_agent.add(aid)
            labels, method, model = _derive_agent_prompt_rubric(agent_def, "score", db)
            score_sections.extend(labels)
            score_sources.append({
                "agent_id": aid,
                "agent_name": str(agent_def.get("name") or aid),
                "method": method,
                "model": model,
            })

        if _is_violation_agent_def(agent_def, sub_type) and aid not in seen_violation_agent:
            seen_violation_agent.add(aid)
            labels, method, model = _derive_agent_prompt_rubric(agent_def, "violation", db)
            violation_types.extend(labels)
            violation_sources.append({
                "agent_id": aid,
                "agent_name": str(agent_def.get("name") or aid),
                "method": method,
                "model": model,
            })

    return {
        "score_sections": _unique_metric_list(score_sections, kind="score"),
        "violation_types": _unique_metric_list(violation_types, kind="violation"),
        "score_sources": score_sources,
        "violation_sources": violation_sources,
    }


def _score_averages_from_values(score_values: dict[str, list[float]]) -> list[dict]:
    out = [
        {
            "section": section,
            "average": round(sum(vals) / len(vals), 2),
            "count": len(vals),
        }
        for section, vals in score_values.items()
        if vals
    ]
    out.sort(key=lambda x: str(x["section"]).lower())
    return out


def _violation_totals_to_rows(violation_totals: dict[str, int]) -> list[dict]:
    out = [{"type": k, "total": int(v or 0)} for k, v in violation_totals.items()]
    out.sort(key=lambda x: (-x["total"], str(x["type"]).lower()))
    return out


def _collect_metrics_for_runs(
    runs: list[Any],
    agent_map: dict[str, dict],
    score_catalog: list[str],
    violation_catalog: list[str],
) -> tuple[list[dict], dict[str, list[float]], dict[str, int], list[dict]]:
    parsed_rows: list[dict] = []
    score_values: dict[str, list[float]] = {}
    violation_totals: dict[str, int] = {}
    run_summaries: list[dict] = []

    score_lookup = _build_catalog_lookup(score_catalog, kind="score")
    violation_lookup = _build_catalog_lookup(violation_catalog, kind="violation")

    for run in runs:
        try:
            steps = json.loads(getattr(run, "steps_json", "") or "[]")
            if not isinstance(steps, list):
                steps = []
        except Exception:
            steps = []

        subtype_by_agent = _extract_agent_output_subtypes(getattr(run, "canvas_json", "") or "")
        run_started_at = run.started_at.isoformat() if getattr(run, "started_at", None) else ""
        run_finished_at = run.finished_at.isoformat() if getattr(run, "finished_at", None) else None

        per_run_scores: dict[str, list[float]] = {}
        per_run_violations: dict[str, int] = {}

        for idx, raw_step in enumerate(steps):
            step = raw_step if isinstance(raw_step, dict) else {}
            content = str(step.get("content") or "")
            if not content:
                continue

            agent_id = str(step.get("agent_id") or "")
            agent_def = agent_map.get(agent_id, {})
            agent_name = str(step.get("agent_name") or "") or str(agent_def.get("name") or "") or agent_id or f"Step {idx + 1}"
            model = str(step.get("model") or "")
            sub_type = str(subtype_by_agent.get(agent_id, "") or "").strip().lower()
            unknown_type = sub_type in {"", "unknown"}

            step_state = str(step.get("state") or step.get("status") or "").strip().lower()
            step_done = step_state in {"done", "completed", "pass", "success", "ok"}

            score_like = _is_score_agent_def(agent_def, sub_type)
            violation_like = _is_violation_agent_def(agent_def, sub_type)

            parse_scores = score_like or (unknown_type and not violation_like)
            parse_violations = violation_like or (unknown_type and not score_like)

            scores: dict[str, float] = {}
            if parse_scores:
                scores = _parse_scores_from_text(content)
                if not scores and unknown_type and "score" in content.lower() and "/100" in content:
                    scores = _parse_scores_from_text(content)

            for sec, val in scores.items():
                canonical_sec = _canonical_metric_name(sec, score_lookup, kind="score")
                score_values.setdefault(canonical_sec, []).append(float(val))
                per_run_scores.setdefault(canonical_sec, []).append(float(val))
                parsed_rows.append({
                    "metric_type": "score",
                    "metric_key": canonical_sec,
                    "metric_value": float(val),
                    "run_id": run.id,
                    "run_started_at": run_started_at,
                    "run_finished_at": run_finished_at,
                    "run_status": run.status,
                    "step_index": idx,
                    "step_done": step_done,
                    "step_state": step_state,
                    "step_agent_id": agent_id,
                    "step_agent_name": agent_name,
                    "step_model": model,
                    "step_sub_type": sub_type or "unknown",
                })

            violations: dict[str, int] = {}
            if parse_violations:
                violations = _parse_violations_from_text(content)
                if not violations and (
                    "[violation]" in content.lower()
                    or "total violations by procedure" in content.lower()
                ):
                    violations = _parse_violations_from_text(content)

            for proc, cnt in violations.items():
                if _is_summary_violation_metric(proc):
                    continue
                n = int(cnt or 0)
                canonical_proc = _canonical_metric_name(proc, violation_lookup, kind="violation")
                violation_totals[canonical_proc] = violation_totals.get(canonical_proc, 0) + n
                per_run_violations[canonical_proc] = per_run_violations.get(canonical_proc, 0) + n
                parsed_rows.append({
                    "metric_type": "violation",
                    "metric_key": canonical_proc,
                    "metric_value": n,
                    "run_id": run.id,
                    "run_started_at": run_started_at,
                    "run_finished_at": run_finished_at,
                    "run_status": run.status,
                    "step_index": idx,
                    "step_done": step_done,
                    "step_state": step_state,
                    "step_agent_id": agent_id,
                    "step_agent_name": agent_name,
                    "step_model": model,
                    "step_sub_type": sub_type or "unknown",
                })

        run_flat_scores = [v for vals in per_run_scores.values() for v in vals]
        run_summaries.append({
            "run_id": str(run.id or ""),
            "pipeline_id": str(getattr(run, "pipeline_id", "") or ""),
            "pipeline_name": str(getattr(run, "pipeline_name", "") or ""),
            "sales_agent": str(getattr(run, "sales_agent", "") or ""),
            "customer": str(getattr(run, "customer", "") or ""),
            "started_at": run_started_at,
            "finished_at": run_finished_at,
            "status": str(getattr(run, "status", "") or ""),
            "run_avg_score": (
                round(sum(run_flat_scores) / len(run_flat_scores), 2)
                if run_flat_scores else None
            ),
            "run_total_violations": int(sum(per_run_violations.values())),
            "score_by_section": {
                k: round(sum(vs) / len(vs), 2)
                for k, vs in per_run_scores.items()
                if vs
            },
            "violations_by_type": per_run_violations,
        })

    return parsed_rows, score_values, violation_totals, run_summaries


def _run_dedupe_source_key(run: Any) -> str:
    call_id = str(getattr(run, "call_id", "") or "").strip()
    low_call_id = call_id.lower()
    if call_id and low_call_id not in {"pair", "merged", "all", "none", "null"}:
        source = f"call:{low_call_id}"
    else:
        source = ""
        try:
            steps = json.loads(getattr(run, "steps_json", "") or "[]")
            if not isinstance(steps, list):
                steps = []
        except Exception:
            steps = []

        for step in steps:
            if not isinstance(step, dict):
                continue
            fp = str(step.get("input_fingerprint") or "").strip().lower()
            if fp:
                source = f"fingerprint:{fp}"
                break

        if not source:
            for step in steps:
                if not isinstance(step, dict):
                    continue
                srcs = step.get("input_sources")
                if not isinstance(srcs, list):
                    continue
                parts: list[str] = []
                for src in srcs:
                    if not isinstance(src, dict):
                        continue
                    k = str(src.get("key") or "").strip().lower()
                    v = str(src.get("source") or "").strip().lower()
                    if k or v:
                        parts.append(f"{k}={v}")
                if parts:
                    source = "sources:" + "|".join(sorted(parts))
                    break

    if not source:
        source = f"run:{str(getattr(run, 'id', '') or '').lower()}"

    sa = str(getattr(run, "sales_agent", "") or "").strip().lower()
    cu = str(getattr(run, "customer", "") or "").strip().lower()
    return f"{sa}::{cu}::{source}"


def _dedupe_runs_by_source(runs: list[Any]) -> list[Any]:
    """Keep the newest run per pair+call-source. Input runs are already newest-first."""
    out: list[Any] = []
    seen: set[str] = set()
    for run in runs:
        key = _run_dedupe_source_key(run)
        if key in seen:
            continue
        seen.add(key)
        out.append(run)
    return out


def _load_all() -> list[dict]:
    _DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("id"):
                out.append(data)
        except Exception:
            pass
    return out


def _find_file(pipeline_id: str) -> tuple[Any, dict]:
    for f in _DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("id") == pipeline_id:
                return f, data
        except Exception:
            pass
    raise HTTPException(404, f"Pipeline '{pipeline_id}' not found")


def _get_table_columns(db_or_bind: Any, table_name: str) -> set[str]:
    try:
        bind = db_or_bind.get_bind() if hasattr(db_or_bind, "get_bind") else db_or_bind
        return {c["name"] for c in _sa_inspect(bind).get_columns(table_name)}
    except Exception:
        return set()


def _agent_result_supports_pipeline_cache(db_or_bind: Any) -> bool:
    cols = _get_table_columns(db_or_bind, "agent_result")
    return {"pipeline_id", "pipeline_step_index", "input_fingerprint"}.issubset(cols)


def _normalise_folder(name: str) -> str:
    return " ".join(str(name or "").strip().split())


def _load_folders() -> list[str]:
    try:
        raw = json.loads(_FOLDERS_FILE.read_text(encoding="utf-8"))
        if isinstance(raw, list):
            out = []
            for x in raw:
                n = _normalise_folder(str(x or ""))
                if n:
                    out.append(n)
            return out
    except Exception:
        pass
    return []


def _save_folders(folders: list[str]) -> None:
    cleaned = []
    seen = set()
    for f in folders:
        n = _normalise_folder(f)
        if not n:
            continue
        k = n.lower()
        if k in seen:
            continue
        seen.add(k)
        cleaned.append(n)
    cleaned.sort(key=lambda x: x.lower())
    _FOLDERS_FILE.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2), encoding="utf-8")


def _ensure_folder_exists(folder: str) -> None:
    n = _normalise_folder(folder)
    if not n:
        return
    folders = _load_folders()
    if n.lower() in {f.lower() for f in folders}:
        return
    folders.append(n)
    _save_folders(folders)


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_pipelines():
    _load_internal_prompt_templates()
    _sync_ai_registry_pipelines()
    return _load_all()


@router.get("/folders")
def list_pipeline_folders():
    from_pipelines = [
        _normalise_folder(str(p.get("folder", "") or ""))
        for p in _load_all()
    ]
    merged = [*from_pipelines, *_load_folders()]
    deduped = []
    seen = set()
    for folder in merged:
        if not folder:
            continue
        key = folder.lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(folder)
    deduped.sort(key=lambda x: x.lower())
    return deduped


@router.post("/folders")
def create_pipeline_folder(req: FolderIn):
    name = _normalise_folder(req.name)
    if not name:
        raise HTTPException(400, "Folder name is required")
    _ensure_folder_exists(name)
    return {"ok": True, "folder": name}


@router.post("")
def create_pipeline(req: PipelineIn):
    _validate_pipeline_payload(req)
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    record["folder"] = _normalise_folder(record.get("folder", ""))
    if record["folder"]:
        _ensure_folder_exists(record["folder"])
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    _sync_ai_registry_pipelines()
    return record


@router.get("/artifact-template")
def get_artifact_template(
    agent_id: str = Query(...),
    artifact_sub_type: str = Query(...),
    db: Session = Depends(get_session),
):
    aid = str(agent_id or "").strip()
    sub_type = str(artifact_sub_type or "").strip().lower()
    if not aid:
        raise HTTPException(400, "agent_id is required")
    if not sub_type:
        raise HTTPException(400, "artifact_sub_type is required")

    from ui.backend.routers import universal_agents as _ua

    agent_def = next((a for a in _ua._load_all() if str(a.get("id") or "") == aid), None)
    if not agent_def:
        raise HTTPException(404, f"Agent '{aid}' not found")

    system_prompt = str(agent_def.get("system_prompt") or "")
    user_prompt = str(agent_def.get("user_prompt") or "")
    prompt_hash = _hash_text(
        json.dumps(
            {
                "agent_id": aid,
                "artifact_sub_type": sub_type,
                "system_prompt": system_prompt,
                "user_prompt": user_prompt,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    )

    cached = _load_cached_artifact_template(aid, sub_type, prompt_hash)
    if cached:
        return cached

    payload = _heuristic_artifact_template(
        artifact_sub_type=sub_type,
        system_prompt=system_prompt,
        user_prompt=user_prompt,
    )
    method = "heuristic"
    model = ""
    try:
        llm_payload, llm_model = _infer_artifact_template_with_llm(
            agent_name=str(agent_def.get("name") or aid),
            agent_class=str(agent_def.get("agent_class") or ""),
            artifact_sub_type=sub_type,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            db=db,
        )
        if isinstance(llm_payload, dict) and str(llm_payload.get("schema_template") or "").strip():
            payload = llm_payload
            method = "llm"
            model = llm_model
    except Exception:
        pass

    tax_kind = ""
    if sub_type == "persona_score":
        tax_kind = "score"
    elif sub_type == "notes_compliance":
        tax_kind = "violation"

    raw_taxonomy = payload.get("taxonomy")
    payload["taxonomy"] = _unique_metric_list(
        [str(x or "").strip() for x in raw_taxonomy] if isinstance(raw_taxonomy, list) else [],
        kind=tax_kind,
    )

    raw_fields = payload.get("fields")
    clean_fields: list[dict[str, Any]] = []
    if isinstance(raw_fields, list):
        for f in raw_fields:
            if not isinstance(f, dict):
                continue
            name = str(f.get("name") or "").strip()
            if not name:
                continue
            clean_fields.append({
                "name": name,
                "type": str(f.get("type") or "string").strip() or "string",
                "required": bool(f.get("required", False)),
                "description": str(f.get("description") or "").strip(),
            })
    payload["fields"] = clean_fields

    schema_template = str(payload.get("schema_template") or "").strip()
    if not schema_template:
        schema_template = "# Expected Artifact Output\n\n## Summary\n- <required content>"

    response_payload = {
        "agent_id": aid,
        "agent_name": str(agent_def.get("name") or aid),
        "artifact_sub_type": sub_type,
        "schema_template": schema_template,
        "taxonomy": payload.get("taxonomy") or [],
        "fields": payload.get("fields") or [],
    }

    _save_cached_artifact_template(
        agent_id=aid,
        artifact_sub_type=sub_type,
        prompt_hash=prompt_hash,
        payload=response_payload,
        method=method,
        model=model,
    )

    reloaded = _load_cached_artifact_template(aid, sub_type, prompt_hash)
    if reloaded:
        return reloaded

    return {
        **response_payload,
        "method": method,
        "model": model,
        "updated_at": datetime.utcnow().isoformat(),
    }


@router.get("/{pipeline_id}")
def get_pipeline(pipeline_id: str):
    _, data = _find_file(pipeline_id)
    return data


@router.put("/{pipeline_id}")
def update_pipeline(pipeline_id: str, req: PipelineIn):
    _validate_pipeline_payload(req)
    f, data = _find_file(pipeline_id)
    data.update({**req.model_dump(), "updated_at": datetime.utcnow().isoformat()})
    data["folder"] = _normalise_folder(data.get("folder", ""))
    if data["folder"]:
        _ensure_folder_exists(data["folder"])
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    _sync_ai_registry_pipelines()
    return data


@router.patch("/{pipeline_id}/folder")
def move_pipeline_to_folder(pipeline_id: str, req: FolderMoveIn):
    f, data = _find_file(pipeline_id)
    folder = _normalise_folder(req.folder)
    data["folder"] = folder
    data["updated_at"] = datetime.utcnow().isoformat()
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    if folder:
        _ensure_folder_exists(folder)
    _sync_ai_registry_pipelines()
    return data


@router.delete("/{pipeline_id}")
def delete_pipeline(pipeline_id: str):
    f, _ = _find_file(pipeline_id)
    f.unlink()
    _sync_ai_registry_pipelines()
    return {"ok": True}


class PipelineRunRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""
    force: bool = False
    force_step_indices: list[int] = []  # bypass cache for specific steps even when force=False
    resume_partial: bool = False  # allow per-step cache fallback when exact fingerprint miss


class PipelineStopRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""


@router.get("/{pipeline_id}/results")
def get_pipeline_results(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_id: Optional[str] = Query(None),
    db: Session = Depends(get_session),
):
    """Return the latest cached AgentResult for each pipeline step."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])
    filter_by_call_id = call_id is not None and call_id != ""
    has_pipeline_cols = _agent_result_supports_pipeline_cache(db)

    def _to_iso(v: Any) -> Optional[str]:
        if v is None:
            return None
        if hasattr(v, "isoformat"):
            return v.isoformat()
        return str(v)

    def _row_to_result(row: Any) -> Optional[dict]:
        if not row:
            return None
        m = getattr(row, "_mapping", row)
        if hasattr(m, "get"):
            _id = m.get("id")
            _content = m.get("content", "")
            _agent_name = m.get("agent_name", "")
            _created = m.get("created_at")
        else:
            _id = row[0] if len(row) > 0 else ""
            _content = row[1] if len(row) > 1 else ""
            _agent_name = row[2] if len(row) > 2 else ""
            _created = row[3] if len(row) > 3 else None
        created_iso = _to_iso(_created)
        return {
            "id": _id,
            "content": _content,
            "agent_name": _agent_name,
            "created_at": created_iso,
        }

    fallback_by_step: dict[int, dict] = {}
    try:
        run_stmt = select(PR).where(
            PR.pipeline_id == pipeline_id,
            _sql_func.lower(PR.sales_agent) == (sales_agent or "").lower(),
            _sql_func.lower(PR.customer) == (customer or "").lower(),
        )
        # For pipeline_run fallback, respect explicit call_id including empty string.
        if call_id is not None:
            run_stmt = run_stmt.where(PR.call_id == call_id)
        run_stmt = run_stmt.order_by(PR.started_at.desc()).limit(40)
        run_rows = db.exec(run_stmt).all()
        for run_row in run_rows:
            raw_steps = run_row.steps_json
            if not (isinstance(raw_steps, str) and raw_steps.strip()):
                continue
            parsed = json.loads(raw_steps)
            if not isinstance(parsed, list):
                continue
            run_id = str(run_row.id or "")
            created_at = _to_iso(run_row.finished_at) or _to_iso(run_row.started_at)
            for i, raw_step in enumerate(parsed):
                if i in fallback_by_step:
                    continue
                s = raw_step if isinstance(raw_step, dict) else {}
                content = (s.get("content") or "") if isinstance(s, dict) else ""
                if not content:
                    continue
                fallback_by_step[i] = {
                    "id": f"pipeline_run:{run_id}:{i}",
                    "content": content,
                    "agent_name": (s.get("agent_name") or "") if isinstance(s, dict) else "",
                    "created_at": created_at,
                }
    except Exception:
        fallback_by_step = {}

    out = []
    for idx, step in enumerate(steps):
        agent_id = step.get("agent_id", "")
        cached_row = None
        if has_pipeline_cols:
            sql = (
                "SELECT id, content, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
                "AND pipeline_id = :pipeline_id "
                "AND pipeline_step_index = :step_idx "
            )
            params = {
                "agent_id": agent_id,
                "sales_agent": sales_agent,
                "customer": customer,
                "pipeline_id": pipeline_id,
                "step_idx": idx,
            }
            if filter_by_call_id:
                sql += "AND call_id = :call_id "
                params["call_id"] = call_id or ""
            sql += "ORDER BY created_at DESC LIMIT 1"
            try:
                cached_row = db.exec(_sql_text(sql), params).first()
            except Exception:
                cached_row = None

        if not cached_row:
            sql2 = (
                "SELECT id, content, agent_name, created_at "
                "FROM agent_result "
                "WHERE agent_id = :agent_id "
                "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                "AND LOWER(customer) = LOWER(:customer) "
            )
            params2 = {
                "agent_id": agent_id,
                "sales_agent": sales_agent,
                "customer": customer,
            }
            if filter_by_call_id:
                sql2 += "AND call_id = :call_id "
                params2["call_id"] = call_id or ""
            sql2 += "ORDER BY created_at DESC LIMIT 1"
            try:
                cached_row = db.exec(_sql_text(sql2), params2).first()
            except Exception:
                cached_row = None

        cached = _row_to_result(cached_row)
        if not cached:
            fb = fallback_by_step.get(idx)
            if fb and fb.get("content"):
                cached = {
                    "id": fb.get("id"),
                    "content": fb.get("content"),
                    "agent_name": fb.get("agent_name") or agent_id,
                    "created_at": fb.get("created_at"),
                }
        out.append({
            "agent_id": agent_id,
            "result": cached,
        })
    return out


@router.post("/{pipeline_id}/stop")
async def stop_pipeline(
    pipeline_id: str,
    req: PipelineStopRequest,
    request: Request,
):
    """Request cancellation of an active pipeline run for this context."""
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")
    execution_session_id = execution_logs.start_session(
        action="pipeline_stop",
        source="backend",
        context={
            "pipeline_id": pipeline_id,
            "sales_agent": req.sales_agent,
            "customer": req.customer,
            "call_id": req.call_id,
        },
        client_local_time=client_local_time,
        client_timezone=client_timezone,
        status="running",
    )
    slot = _run_slot_key(pipeline_id, req.sales_agent, req.customer, req.call_id)
    task: Optional[asyncio.Task] = None
    with _ACTIVE_RUN_LOCK:
        ev = _STOP_REQUESTED.get(slot)
        if ev:
            ev.set()
        task = _ACTIVE_RUN_TASKS.get(slot)

    cancelled = False
    if task and not task.done():
        task.cancel()
        cancelled = True

    # Proactively mark state file as failed for per-pair UI so canvas unblocks quickly.
    # If the run coroutine is still alive, it will keep the same run_id and reconcile.
    try:
        path = _STATE_DIR / f"{_pair_key(pipeline_id, req.sales_agent, req.customer)}.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("status") == "running":
                now_iso = datetime.utcnow().isoformat()
                for s in data.get("steps", []):
                    if s.get("state") == "running" or s.get("status") == "loading":
                        s["state"] = "failed"
                        s["status"] = "error"  # legacy compatibility
                        s["end_time"] = now_iso
                        s["error_msg"] = "stopped by user"
                node_states = data.get("node_states")
                if isinstance(node_states, dict):
                    for bucket in ("input", "processing", "output"):
                        b = node_states.get(bucket)
                        if not isinstance(b, dict):
                            continue
                        for node_id, raw_st in list(b.items()):
                            st = str(raw_st or "").lower()
                            if st in ("running", "loading"):
                                b[node_id] = "error"
                data["status"] = "failed"
                data["updated_at"] = now_iso
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass

    execution_logs.append_event(
        execution_session_id,
        "Pipeline stop requested",
        level="stage",
        status="success" if cancelled else "running",
        data={"slot": slot, "cancelled": cancelled},
        client_local_time=client_local_time,
    )
    execution_logs.finish_session(
        execution_session_id,
        status="success" if cancelled else "completed_with_no_active_task",
        report={"slot": slot, "cancelled": cancelled},
    )
    return {"ok": True, "cancelled": cancelled, "slot": slot, "execution_session_id": execution_session_id}


@router.get("/{pipeline_id}/runs")
def list_pipeline_runs(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    limit: int = Query(30),
    db: Session = Depends(get_session),
):
    """Return recent runs for a specific pipeline."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:          stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:             stmt = stmt.where(PR.customer == customer)
    if call_id is not None:  stmt = stmt.where(PR.call_id == call_id)
    stmt = stmt.order_by(PR.started_at.desc()).limit(limit)
    rows = db.exec(stmt).all()
    return [
        {
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "pipeline_name": r.pipeline_name,
            "sales_agent": r.sales_agent,
            "customer": r.customer,
            "call_id": r.call_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": r.status,
            "canvas_json": r.canvas_json,
            "steps_json": r.steps_json,
            "log_json": r.log_json,
        }
        for r in rows
    ]


@router.get("/{pipeline_id}/analytics")
def get_pipeline_analytics(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    run_id: str = Query(""),
    limit: int = Query(50),
    db: Session = Depends(get_session),
):
    """Return parsed score + violation metrics from pipeline run outputs."""
    from ui.backend.models.pipeline_run import PipelineRun as PR
    try:
        from ui.backend.routers.universal_agents import _load_all as _load_agents
        agent_map = {str(a.get("id") or ""): a for a in _load_agents()}
    except Exception:
        agent_map = {}

    try:
        _, pipeline_def = _find_file(pipeline_id)
    except Exception:
        pipeline_def = {"id": pipeline_id, "steps": [], "canvas": {}}

    rubric = _collect_pipeline_rubric_catalog(pipeline_def, agent_map, db)
    score_catalog = rubric.get("score_sections") or []
    violation_catalog = rubric.get("violation_types") or []

    safe_limit = max(1, min(limit, 300))
    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:
        stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(PR.customer == customer)
    if call_id is not None:
        stmt = stmt.where(PR.call_id == call_id)
    stmt = stmt.order_by(PR.started_at.desc()).limit(safe_limit)
    rows = db.exec(stmt).all()

    scoped_rows = _dedupe_runs_by_source(rows) if not run_id else rows

    run_items: list[dict] = []
    for r in scoped_rows:
        run_items.append({
            "id": r.id,
            "pipeline_id": r.pipeline_id,
            "pipeline_name": r.pipeline_name,
            "sales_agent": r.sales_agent,
            "customer": r.customer,
            "call_id": r.call_id,
            "started_at": r.started_at.isoformat() if r.started_at else None,
            "finished_at": r.finished_at.isoformat() if r.finished_at else None,
            "status": r.status,
        })

    selected_runs = scoped_rows
    if run_id:
        selected_runs = [r for r in rows if str(r.id) == run_id]
        if not selected_runs:
            single = db.get(PR, run_id)
            if single and single.pipeline_id == pipeline_id:
                if (not sales_agent or single.sales_agent == sales_agent) and (not customer or single.customer == customer):
                    if call_id is None or single.call_id == call_id:
                        selected_runs = [single]
                        run_items = [ri for ri in run_items if ri["id"] == run_id] or [{
                            "id": single.id,
                            "pipeline_id": single.pipeline_id,
                            "pipeline_name": single.pipeline_name,
                            "sales_agent": single.sales_agent,
                            "customer": single.customer,
                            "call_id": single.call_id,
                            "started_at": single.started_at.isoformat() if single.started_at else None,
                            "finished_at": single.finished_at.isoformat() if single.finished_at else None,
                            "status": single.status,
                        }]

    parsed_rows, score_values, violation_totals, selected_run_summaries = _collect_metrics_for_runs(
        runs=selected_runs,
        agent_map=agent_map,
        score_catalog=score_catalog,
        violation_catalog=violation_catalog,
    )
    score_by_section = _score_averages_from_values(score_values)
    violation_by_type = _violation_totals_to_rows(violation_totals)

    # Ensure rubric-defined labels appear even when current rows are empty.
    existing_scores = {str(r["section"]).lower() for r in score_by_section}
    for sec in score_catalog:
        if str(sec).lower() in existing_scores:
            continue
        score_by_section.append({"section": sec, "average": 0.0, "count": 0})
    score_by_section.sort(key=lambda x: str(x["section"]).lower())

    existing_violations = {str(r["type"]).lower() for r in violation_by_type}
    for vtype in violation_catalog:
        if str(vtype).lower() in existing_violations:
            continue
        violation_by_type.append({"type": vtype, "total": 0})
    violation_by_type.sort(key=lambda x: (-int(x["total"]), str(x["type"]).lower()))

    pair_flat_scores = [v for vals in score_values.values() for v in vals]
    pair_total_violations = int(sum(violation_totals.values()))
    pair_run_count = len(selected_runs)
    pair_summary = {
        "run_count": pair_run_count,
        "avg_score_all_sections": (
            round(sum(pair_flat_scores) / len(pair_flat_scores), 2)
            if pair_flat_scores else None
        ),
        "total_violations": pair_total_violations,
        "avg_violations_per_run": (
            round(pair_total_violations / pair_run_count, 2)
            if pair_run_count else None
        ),
    }

    agent_aggregate: dict[str, Any] = {}
    if sales_agent:
        agent_limit = max(500, safe_limit * 8)
        stmt_agent = select(PR).where(PR.pipeline_id == pipeline_id, PR.sales_agent == sales_agent)
        if call_id is not None:
            stmt_agent = stmt_agent.where(PR.call_id == call_id)
        stmt_agent = stmt_agent.order_by(PR.started_at.desc()).limit(agent_limit)
        agent_runs = db.exec(stmt_agent).all()
        agent_runs = _dedupe_runs_by_source(agent_runs)

        (
            _agent_rows_unused,
            agent_score_values,
            agent_violation_totals,
            agent_run_summaries,
        ) = _collect_metrics_for_runs(
            runs=agent_runs,
            agent_map=agent_map,
            score_catalog=score_catalog,
            violation_catalog=violation_catalog,
        )
        agent_score_by_section = _score_averages_from_values(agent_score_values)
        agent_violation_by_type = _violation_totals_to_rows(agent_violation_totals)

        existing_agent_scores = {str(r["section"]).lower() for r in agent_score_by_section}
        for sec in score_catalog:
            if str(sec).lower() not in existing_agent_scores:
                agent_score_by_section.append({"section": sec, "average": 0.0, "count": 0})
        agent_score_by_section.sort(key=lambda x: str(x["section"]).lower())

        existing_agent_viol = {str(r["type"]).lower() for r in agent_violation_by_type}
        for vtype in violation_catalog:
            if str(vtype).lower() not in existing_agent_viol:
                agent_violation_by_type.append({"type": vtype, "total": 0})
        agent_violation_by_type.sort(key=lambda x: (-int(x["total"]), str(x["type"]).lower()))

        agent_flat_scores = [v for vals in agent_score_values.values() for v in vals]
        agent_total_violations = int(sum(agent_violation_totals.values()))
        agent_run_count = len(agent_runs)
        agent_customers = sorted({str(r.customer or "") for r in agent_runs if str(r.customer or "").strip()})

        agent_aggregate = {
            "sales_agent": sales_agent,
            "run_count": agent_run_count,
            "customer_count": len(agent_customers),
            "customers": agent_customers,
            "avg_score_all_sections": (
                round(sum(agent_flat_scores) / len(agent_flat_scores), 2)
                if agent_flat_scores else None
            ),
            "total_violations": agent_total_violations,
            "avg_violations_per_run": (
                round(agent_total_violations / agent_run_count, 2)
                if agent_run_count else None
            ),
            "avg_violations_per_customer": (
                round(agent_total_violations / len(agent_customers), 2)
                if agent_customers else None
            ),
            "score_by_section": agent_score_by_section,
            "violation_by_type": agent_violation_by_type,
            "run_summaries": agent_run_summaries,
        }

    return {
        "pipeline_id": pipeline_id,
        "pipeline_name": run_items[0]["pipeline_name"] if run_items else "",
        "sales_agent": sales_agent,
        "customer": customer,
        "call_id": call_id or "",
        "selected_run_id": run_id or "",
        "runs": run_items,
        "rows": parsed_rows,
        "score_by_section": score_by_section,
        "violation_by_type": violation_by_type,
        "rubric": rubric,
        "pair_summary": pair_summary,
        "run_summaries": selected_run_summaries,
        "agent_aggregate": agent_aggregate,
    }


@router.get("/{pipeline_id}/metrics-index")
def get_pipeline_metrics_index(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
    call_id: Optional[str] = Query(None),
    run_from: str = Query(""),
    run_to: str = Query(""),
    limit: int = Query(1200),
    db: Session = Depends(get_session),
):
    """Compact pair/agent artifact metrics for CRM filtering/sorting."""
    from ui.backend.models.pipeline_run import PipelineRun as PR

    try:
        from ui.backend.routers.universal_agents import _load_all as _load_agents
        agent_map = {str(a.get("id") or ""): a for a in _load_agents()}
    except Exception:
        agent_map = {}

    try:
        _, pipeline_def = _find_file(pipeline_id)
    except Exception:
        pipeline_def = {"id": pipeline_id, "steps": [], "canvas": {}}

    rubric = _collect_pipeline_rubric_catalog(pipeline_def, agent_map, db)
    score_catalog = rubric.get("score_sections") or []
    violation_catalog = rubric.get("violation_types") or []

    safe_limit = max(100, min(limit, 20000))
    from_dt = None
    to_dt_exclusive = None
    if run_from:
        try:
            from_dt = datetime.fromisoformat(str(run_from).strip()[:10] + "T00:00:00")
        except Exception:
            raise HTTPException(400, "Invalid run_from date. Use YYYY-MM-DD.")
    if run_to:
        try:
            to_dt_exclusive = datetime.fromisoformat(str(run_to).strip()[:10] + "T00:00:00") + timedelta(days=1)
        except Exception:
            raise HTTPException(400, "Invalid run_to date. Use YYYY-MM-DD.")

    stmt = select(PR).where(PR.pipeline_id == pipeline_id)
    if sales_agent:
        stmt = stmt.where(PR.sales_agent == sales_agent)
    if customer:
        stmt = stmt.where(PR.customer == customer)
    if call_id is not None:
        stmt = stmt.where(PR.call_id == call_id)
    if from_dt is not None:
        stmt = stmt.where(PR.started_at >= from_dt)
    if to_dt_exclusive is not None:
        stmt = stmt.where(PR.started_at < to_dt_exclusive)
    stmt = stmt.order_by(PR.started_at.desc()).limit(safe_limit)
    runs = db.exec(stmt).all()
    # Deep-dive metrics should aggregate across all matching runs in the date range.
    # Do not dedupe by source/call here.

    _rows_unused, _score_unused, _viol_unused, run_summaries = _collect_metrics_for_runs(
        runs=runs,
        agent_map=agent_map,
        score_catalog=score_catalog,
        violation_catalog=violation_catalog,
    )

    pair_buckets: dict[str, dict[str, Any]] = {}
    for rs in run_summaries:
        sa = str(rs.get("sales_agent") or "")
        cu = str(rs.get("customer") or "")
        if not (sa and cu):
            continue
        key = f"{sa}::{cu}"
        bucket = pair_buckets.setdefault(key, {
            "sales_agent": sa,
            "customer": cu,
            "run_count": 0,
            "run_avg_scores": [],
            "total_violations": 0,
            "score_by_section_values": {},
            "violation_by_type": {},
            "latest_run_at": "",
        })
        bucket["run_count"] += 1
        if isinstance(rs.get("run_avg_score"), (int, float)):
            bucket["run_avg_scores"].append(float(rs["run_avg_score"]))
        bucket["total_violations"] += int(rs.get("run_total_violations") or 0)
        started_at = str(rs.get("started_at") or "")
        if started_at > bucket["latest_run_at"]:
            bucket["latest_run_at"] = started_at

        score_map = rs.get("score_by_section") if isinstance(rs.get("score_by_section"), dict) else {}
        for sec, val in score_map.items():
            sec_key = _canonical_metric_name(
                str(sec),
                _build_catalog_lookup(score_catalog, kind="score"),
                kind="score",
            )
            bucket["score_by_section_values"].setdefault(sec_key, []).append(float(val))

        viol_map = rs.get("violations_by_type") if isinstance(rs.get("violations_by_type"), dict) else {}
        for vtype, cnt in viol_map.items():
            v_key = _canonical_metric_name(
                str(vtype),
                _build_catalog_lookup(violation_catalog, kind="violation"),
                kind="violation",
            )
            bucket["violation_by_type"][v_key] = bucket["violation_by_type"].get(v_key, 0) + int(cnt or 0)

    pairs_out: list[dict] = []
    for pb in pair_buckets.values():
        score_by_section = {
            sec: (round(sum(vals) / len(vals), 2) if vals else 0.0)
            for sec, vals in pb["score_by_section_values"].items()
        }
        for sec in score_catalog:
            score_by_section.setdefault(sec, 0.0)

        violations_by_type = {str(k): int(v or 0) for k, v in pb["violation_by_type"].items()}
        for vtype in violation_catalog:
            violations_by_type.setdefault(vtype, 0)

        run_count = int(pb["run_count"] or 0)
        total_violations = int(pb["total_violations"] or 0)
        avg_score_all_sections = (
            round(sum(pb["run_avg_scores"]) / len(pb["run_avg_scores"]), 2)
            if pb["run_avg_scores"] else None
        )
        pairs_out.append({
            "sales_agent": pb["sales_agent"],
            "customer": pb["customer"],
            "run_count": run_count,
            "avg_score_all_sections": avg_score_all_sections,
            "total_violations": total_violations,
            "avg_violations_per_run": (
                round(total_violations / run_count, 2)
                if run_count else None
            ),
            "score_by_section": score_by_section,
            "violations_by_type": violations_by_type,
            "latest_run_at": pb["latest_run_at"] or None,
        })
    pairs_out.sort(key=lambda x: (str(x["sales_agent"]).lower(), str(x["customer"]).lower()))

    agent_buckets: dict[str, dict[str, Any]] = {}
    for pair in pairs_out:
        sa = str(pair.get("sales_agent") or "")
        if not sa:
            continue
        ab = agent_buckets.setdefault(sa, {
            "sales_agent": sa,
            "customer_set": set(),
            "run_count": 0,
            "run_avg_scores": [],
            "total_violations": 0,
            "score_by_section_values": {},
            "violation_by_type": {},
        })
        ab["customer_set"].add(str(pair.get("customer") or ""))
        ab["run_count"] += int(pair.get("run_count") or 0)
        if isinstance(pair.get("avg_score_all_sections"), (int, float)):
            for _ in range(int(pair.get("run_count") or 0)):
                ab["run_avg_scores"].append(float(pair["avg_score_all_sections"]))
        ab["total_violations"] += int(pair.get("total_violations") or 0)

        score_map = pair.get("score_by_section") if isinstance(pair.get("score_by_section"), dict) else {}
        for sec, val in score_map.items():
            ab["score_by_section_values"].setdefault(str(sec), []).append(float(val))

        viol_map = pair.get("violations_by_type") if isinstance(pair.get("violations_by_type"), dict) else {}
        for vtype, cnt in viol_map.items():
            ab["violation_by_type"][str(vtype)] = ab["violation_by_type"].get(str(vtype), 0) + int(cnt or 0)

    agents_out: list[dict] = []
    for ab in agent_buckets.values():
        customers = sorted([c for c in ab["customer_set"] if c])
        score_by_section = {
            sec: (round(sum(vals) / len(vals), 2) if vals else 0.0)
            for sec, vals in ab["score_by_section_values"].items()
        }
        for sec in score_catalog:
            score_by_section.setdefault(sec, 0.0)

        violations_by_type = {str(k): int(v or 0) for k, v in ab["violation_by_type"].items()}
        for vtype in violation_catalog:
            violations_by_type.setdefault(vtype, 0)

        run_count = int(ab["run_count"] or 0)
        total_violations = int(ab["total_violations"] or 0)
        agents_out.append({
            "sales_agent": ab["sales_agent"],
            "customer_count": len(customers),
            "customers": customers,
            "run_count": run_count,
            "avg_score_all_sections": (
                round(sum(ab["run_avg_scores"]) / len(ab["run_avg_scores"]), 2)
                if ab["run_avg_scores"] else None
            ),
            "total_violations": total_violations,
            "avg_violations_per_run": (
                round(total_violations / run_count, 2)
                if run_count else None
            ),
            "avg_violations_per_customer": (
                round(total_violations / len(customers), 2)
                if customers else None
            ),
            "score_by_section": score_by_section,
            "violations_by_type": violations_by_type,
        })
    agents_out.sort(key=lambda x: str(x["sales_agent"]).lower())

    return {
        "pipeline_id": pipeline_id,
        "pipeline_name": runs[0].pipeline_name if runs else "",
        "run_count": len(runs),
        "run_from": run_from or "",
        "run_to": run_to or "",
        "score_sections": score_catalog,
        "violation_types": violation_catalog,
        "pairs": pairs_out,
        "agents": agents_out,
        "rubric": rubric,
    }


@router.get("/{pipeline_id}/state")
def get_pipeline_state(
    pipeline_id: str,
    sales_agent: str = Query(""),
    customer: str = Query(""),
):
    """Return the live run state for a pipeline+pair from the state file.
    The file is keyed by a hash of (pipeline_id, sales_agent, customer) so
    no string comparison filter is needed — the path IS the filter."""
    path = _STATE_DIR / f"{_pair_key(pipeline_id, sales_agent, customer)}.json"
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        steps = data.get("steps")
        if isinstance(steps, list):
            dirty = False
            for step in steps:
                if not isinstance(step, dict):
                    continue
                if step.get("content") or step.get("thinking"):
                    step["content"] = ""
                    step["thinking"] = ""
                    dirty = True
                sources = step.get("input_sources")
                if isinstance(sources, list):
                    for src in sources:
                        if isinstance(src, dict) and src.get("source") == "chain_previous":
                            src["source"] = "artifact_output"
                            dirty = True
            if dirty:
                path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return data
    except Exception:
        return None


@router.post("/{pipeline_id}/run")
async def run_pipeline(
    pipeline_id: str,
    req: PipelineRunRequest,
    request: Request,
    db: Session = Depends(get_session),
):
    """Execute a pipeline step-by-step, streaming SSE events."""
    from ui.backend.models.agent_result import AgentResult as AR
    from ui.backend.models.note import Note
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.models.persona import Persona
    from ui.backend.routers.universal_agents import (
        _sse, _is_file_source, _resolve_input,
        _llm_call_with_files, _llm_call_anthropic_files_streaming,
        _load_all as _load_agents,
    )

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])
    agent_map: dict[str, dict] = {a["id"]: a for a in _load_agents()}

    run_slot = _run_slot_key(pipeline_id, req.sales_agent, req.customer, req.call_id)
    client_local_time = request.headers.get("x-client-local-time", "")
    client_timezone = request.headers.get("x-client-timezone", "")

    async def stream():
        pipeline_name = pipeline_def.get("name", "pipeline")
        cid_short = f"…{req.call_id[-8:]}" if req.call_id else "pair"

        # ── Create history run record ────────────────────────────────────────
        recent = log_buffer.get_recent(1)
        start_seq = recent[-1].seq if recent else 0

        run_id = str(uuid.uuid4())
        run_start_dt = datetime.utcnow().isoformat()
        execution_session_id = execution_logs.start_session(
            action="pipeline_run",
            source="backend",
            context={
                "pipeline_id": pipeline_id,
                "pipeline_name": pipeline_name,
                "run_slot": run_slot,
                "sales_agent": req.sales_agent,
                "customer": req.customer,
                "call_id": req.call_id,
                "force": bool(req.force),
                "force_step_indices": [int(i) for i in (req.force_step_indices or [])],
                "resume_partial": bool(req.resume_partial),
            },
            client_local_time=client_local_time,
            client_timezone=client_timezone,
            status="running",
        )
        execution_logs.append_event(
            execution_session_id,
            f"Pipeline run started: {pipeline_name}",
            level="stage",
            status="running",
            data={"run_id": run_id, "steps_total": len(steps)},
            client_local_time=client_local_time,
        )
        run_steps = [
            {
                "agent_id":         s.get("agent_id", ""),
                "agent_name":       "",
                "model":            "",
                "state":            "waiting",
                "start_time":       None,
                "end_time":         None,
                "cached_locations": [],
                "content":          "",
                "error_msg":        "",
                "execution_time_s": None,
                "input_token_est":  0,
                "output_token_est": 0,
                "thinking":         "",
                "input_sources":    [],
                "input_fingerprint": "",
                "input_ready":      False,
                "cache_mode":       "",
            }
            for s in steps
        ]
        run_record = PR(
            id=run_id,
            pipeline_id=pipeline_id,
            pipeline_name=pipeline_name,
            sales_agent=req.sales_agent,
            customer=req.customer,
            call_id=req.call_id,
            status="running",
            canvas_json=json.dumps(pipeline_def.get("canvas", {})),
        )
        with Session(_db_engine) as _s:
            _s.add(run_record)
            _s.commit()

        yield _sse(
            "execution_session",
            {"execution_session_id": execution_session_id, "run_id": run_id},
        )

        _agent_result_has_pipeline_cache = _agent_result_supports_pipeline_cache(_db_engine)
        if not _agent_result_has_pipeline_cache:
            log_buffer.emit(
                "[PIPELINE] ⚠ agent_result schema is legacy (missing pipeline cache columns); "
                "using legacy cache mode"
            )
        # Write initial state file (all steps waiting) so frontend can find it immediately.
        # force=True so a new run always claims the file even if an old run still owns it.
        _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                    force=True, start_datetime=run_start_dt)

        run_final_status = "error"
        execution_error_msg = ""
        loop = asyncio.get_event_loop()
        prev_content = ""
        LLM_TIMEOUT_S = 600.0
        cancel_state = {"reason": "run cancelled (client disconnected or server interrupted)"}

        with _ACTIVE_RUN_LOCK:
            _STOP_REQUESTED[run_slot] = threading.Event()
            _ACTIVE_RUN_TASKS[run_slot] = asyncio.current_task()

        def _is_stop_requested() -> bool:
            with _ACTIVE_RUN_LOCK:
                ev = _STOP_REQUESTED.get(run_slot)
            return bool(ev and ev.is_set())

        def _raise_if_stop_requested() -> None:
            if _is_stop_requested():
                cancel_state["reason"] = "run stopped by user"
                raise asyncio.CancelledError()

        _proc_node_id_by_step_idx: dict[int, str] = {}
        _output_node_to_step_idx: dict[str, int] = {}
        _input_node_to_step_idxs: dict[str, list[int]] = {}
        _input_node_ids: list[str] = []
        _output_node_ids: list[str] = []
        _step_output_meta: dict[int, dict[str, str]] = {}
        _artifact_ctx: dict[str, Optional[str]] = {"latest_persona_id": None}

        def _step_status_to_ui(_s: dict) -> str:
            raw = (_s.get("state") or _s.get("status") or "waiting")
            if raw in ("failed", "error"):
                return "error"
            if raw in ("running", "loading"):
                return "loading"
            if raw in ("completed", "done"):
                return "cached" if (_s.get("cached_locations") or []) else "done"
            return "pending"

        def _step_input_status(_s: dict) -> str:
            raw = (_s.get("state") or _s.get("status") or "waiting")
            if raw in ("failed", "error"):
                return "error"
            if raw in ("running", "loading"):
                return "done" if _s.get("input_ready") else "loading"
            if raw in ("completed", "done"):
                return "cached" if (_s.get("cached_locations") or []) else "done"
            return "pending"

        def _build_node_states() -> dict:
            processing: dict[str, str] = {}
            output: dict[str, str] = {}
            input_nodes: dict[str, str] = {}

            for _step_idx, _node_id in _proc_node_id_by_step_idx.items():
                if _step_idx >= len(run_steps) or not _node_id:
                    continue
                processing[_node_id] = _step_status_to_ui(run_steps[_step_idx])

            for _node_id in _output_node_ids:
                _step_idx = _output_node_to_step_idx.get(_node_id)
                if _step_idx is None or _step_idx >= len(run_steps):
                    output[_node_id] = "pending"
                    continue
                _st = _step_status_to_ui(run_steps[_step_idx])
                output[_node_id] = "pending" if _st == "loading" else _st

            for _node_id in _input_node_ids:
                _step_idxs = _input_node_to_step_idxs.get(_node_id, [])
                if not _step_idxs:
                    input_nodes[_node_id] = "pending"
                    continue
                _statuses = [
                    _step_input_status(run_steps[_i])
                    for _i in _step_idxs
                    if 0 <= _i < len(run_steps)
                ]
                if any(_s == "error" for _s in _statuses):
                    input_nodes[_node_id] = "error"
                elif any(_s == "done" for _s in _statuses):
                    input_nodes[_node_id] = "done"
                elif any(_s == "cached" for _s in _statuses):
                    input_nodes[_node_id] = "cached"
                elif any(_s == "loading" for _s in _statuses):
                    input_nodes[_node_id] = "loading"
                else:
                    input_nodes[_node_id] = "pending"

            return {
                "input": input_nodes,
                "processing": processing,
                "output": output,
            }

        def save_steps():
            """Persist current step states — writes both the DB and the live state file.
            Always written with status='running'; the state file is only promoted to
            'pass'/'failed' on completion/error. On stream disconnect, it stays
            'running' with the last known step snapshot for UI restore."""
            try:
                with Session(_db_engine) as _s:
                    _s.execute(
                        _sql_text("UPDATE pipeline_run SET steps_json = :steps_json WHERE id = :id"),
                        {"steps_json": json.dumps(run_steps), "id": run_id},
                    )
                    _s.commit()
            except Exception:
                    pass
            _save_state(
                pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                start_datetime=run_start_dt, node_states=_build_node_states(),
            )

        def _normalize_overrides_for_step(
            _step_idx: int, _agent_def: dict, _overrides: dict
        ) -> dict:
            """Normalize overrides for artifact-like inputs based on canvas output wiring."""
            _norm = dict(_overrides or {})
            _artifact_src = _incoming_output_src_by_step_idx.get(_step_idx)
            if not _artifact_src:
                return _norm
            for _inp in (_agent_def.get("inputs", []) or []):
                _k = _inp.get("key", "")
                _default_src = str(_inp.get("source", ""))
                if _default_src in ("chain_previous", "artifact_output") or _default_src.startswith("artifact_"):
                    _norm[_k] = _artifact_src
            return _norm

        def _public_input_source(_source: str) -> str:
            # Keep legacy compatibility internally but avoid surfacing chain_previous.
            return "artifact_output" if _source == "chain_previous" else _source

        def _lookup_step_cache(
            _sess: Session,
            _agent_id: str,
            _step_idx: int,
            _input_fingerprint: str,
        ) -> tuple[Optional[Any], bool]:
            """Return (cached_row, used_resume_partial_fallback)."""
            def _legacy_lookup_latest() -> Optional[Any]:
                _sql = (
                    "SELECT id, content, created_at "
                    "FROM agent_result "
                    "WHERE agent_id = :agent_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                )
                _params = {
                    "agent_id": _agent_id,
                    "sales_agent": req.sales_agent or "",
                    "customer": req.customer or "",
                }
                if req.call_id:
                    _sql += "AND call_id = :call_id "
                    _params["call_id"] = req.call_id
                else:
                    _sql += "AND call_id = '' "
                _sql += "ORDER BY created_at DESC LIMIT 1"
                _row = _sess.execute(_sql_text(_sql), _params).first()
                if not _row:
                    return None
                _m = getattr(_row, "_mapping", _row)
                if hasattr(_m, "get"):
                    return _SimpleNamespace(
                        id=_m.get("id"),
                        content=_m.get("content", ""),
                        created_at=_m.get("created_at"),
                    )
                return None

            if not _agent_result_has_pipeline_cache:
                _legacy = _legacy_lookup_latest()
                if _legacy:
                    return _legacy, bool(req.resume_partial)
                return None, False

            _base = select(AR).where(
                AR.agent_id == _agent_id,
                _sql_func.lower(AR.sales_agent) == (req.sales_agent or "").lower(),
                _sql_func.lower(AR.customer) == (req.customer or "").lower(),
            )
            if _agent_result_has_pipeline_cache:
                _base = _base.where(
                    AR.pipeline_id == pipeline_id,
                    AR.pipeline_step_index == _step_idx,
                )
            if req.call_id:
                _base = _base.where(AR.call_id == req.call_id)
            else:
                _base = _base.where(AR.call_id == "")

            _exact = _base
            if _agent_result_has_pipeline_cache:
                _exact = _exact.where(AR.input_fingerprint == _input_fingerprint)
            _exact = _exact.order_by(AR.created_at.desc())
            _cached = _sess.exec(_exact).first()
            if _cached:
                return _cached, False

            # Resume-partial mode: if exact fingerprint misses, reuse the latest
            # cached artifact for this pipeline step in the current context.
            if req.resume_partial and _agent_result_has_pipeline_cache:
                _fallback = _sess.exec(_base.order_by(AR.created_at.desc())).first()
                if _fallback:
                    return _fallback, True
            return None, False

        def _lookup_step_cache_resume_only(
            _sess: Session,
            _agent_id: str,
            _step_idx: int,
        ) -> Optional[Any]:
            """Best-effort step cache lookup for resume mode before input-resolution."""
            if not _agent_result_has_pipeline_cache:
                _sql = (
                    "SELECT id, content, created_at "
                    "FROM agent_result "
                    "WHERE agent_id = :agent_id "
                    "AND LOWER(sales_agent) = LOWER(:sales_agent) "
                    "AND LOWER(customer) = LOWER(:customer) "
                )
                _params = {
                    "agent_id": _agent_id,
                    "sales_agent": req.sales_agent or "",
                    "customer": req.customer or "",
                }
                if req.call_id:
                    _sql += "AND call_id = :call_id "
                    _params["call_id"] = req.call_id
                else:
                    _sql += "AND call_id = '' "
                _sql += "ORDER BY created_at DESC LIMIT 1"
                _row = _sess.execute(_sql_text(_sql), _params).first()
                if not _row:
                    return None
                _m = getattr(_row, "_mapping", _row)
                if hasattr(_m, "get"):
                    return _SimpleNamespace(
                        id=_m.get("id"),
                        content=_m.get("content", ""),
                        created_at=_m.get("created_at"),
                    )
                return None

            _base = select(AR).where(
                AR.agent_id == _agent_id,
                _sql_func.lower(AR.sales_agent) == (req.sales_agent or "").lower(),
                _sql_func.lower(AR.customer) == (req.customer or "").lower(),
            )
            if _agent_result_has_pipeline_cache:
                _base = _base.where(
                    AR.pipeline_id == pipeline_id,
                    AR.pipeline_step_index == _step_idx,
                )
            if req.call_id:
                _base = _base.where(AR.call_id == req.call_id)
            else:
                _base = _base.where(AR.call_id == "")
            return _sess.exec(_base.order_by(AR.created_at.desc())).first()

        def _has_call_transcript(_call_id: str) -> bool:
            if not _call_id:
                return False
            _llm = settings.agents_dir / req.sales_agent / req.customer / _call_id / "transcribed" / "llm_final"
            return (_llm / "smoothed.txt").exists() or (_llm / "voted.txt").exists()

        def _pair_has_any_transcript() -> bool:
            _pair_dir = settings.agents_dir / req.sales_agent / req.customer
            if not _pair_dir.exists():
                return False
            for _call_dir in _pair_dir.iterdir():
                if not _call_dir.is_dir() or _call_dir.name.startswith("."):
                    continue
                _llm = _call_dir / "transcribed" / "llm_final"
                if (_llm / "smoothed.txt").exists() or (_llm / "voted.txt").exists():
                    return True
                _final = _call_dir / "transcribed" / "final"
                if _final.exists() and any(_final.iterdir()):
                    return True
            return False

        def _collect_missing_transcript_requirements() -> tuple[bool, set[str]]:
            _needs_merged = False
            _missing_call_ids: set[str] = set()
            for _step_idx, _step in enumerate(steps):
                _aid = _step.get("agent_id", "")
                _adef = agent_map.get(_aid)
                if not _adef:
                    continue
                _ov = _normalize_overrides_for_step(
                    _step_idx, _adef, _step.get("input_overrides", {})
                )
                for _inp in (_adef.get("inputs", []) or []):
                    _k = _inp.get("key", "")
                    _src = _public_input_source(
                        _ov.get(_k, _inp.get("source", "manual"))
                    )
                    if _src == "transcript":
                        if req.call_id:
                            if not _has_call_transcript(req.call_id):
                                _missing_call_ids.add(req.call_id)
                        elif not _pair_has_any_transcript():
                            _needs_merged = True
                    elif _src == "merged_transcript":
                        if not _pair_has_any_transcript():
                            _needs_merged = True
            return _needs_merged, _missing_call_ids

        async def _wait_for_jobs(
            _job_ids: list[str],
            _timeout_s: int = 5400,
        ) -> tuple[bool, int]:
            from ui.backend.models.job import Job, JobStatus

            _ids = list(dict.fromkeys([str(_j) for _j in _job_ids if str(_j)]))
            if not _ids:
                return True, 0

            _deadline = time.monotonic() + max(30, int(_timeout_s))
            _last_log = 0.0
            while True:
                _raise_if_stop_requested()
                with Session(_db_engine) as _s:
                    _rows = _s.exec(
                        select(Job).where(Job.id.in_(_ids))
                    ).all()
                _status_by_id = {str(_r.id): str(_r.status) for _r in _rows}
                _done = sum(
                    1 for _i in _ids
                    if _status_by_id.get(_i) in ("complete", "failed")
                )
                _failed = sum(
                    1 for _i in _ids
                    if _status_by_id.get(_i) == "failed"
                )
                if _done >= len(_ids):
                    return _failed == 0, _failed
                if time.monotonic() - _last_log >= 5.0:
                    _last_log = time.monotonic()
                    log_buffer.emit(
                        f"[PIPELINE] … auto-transcription running ({_done}/{len(_ids)} complete) · {cid_short}"
                    )
                if time.monotonic() >= _deadline:
                    return False, _failed
                await asyncio.sleep(2.0)

        async def _ensure_transcripts_ready_for_run() -> None:
            from ui.backend.models.crm import CRMPair
            from ui.backend.models.job import Job, JobStatus
            from ui.backend.routers.transcription_process import (
                BatchPairsRequest, PairSpec, batch_transcribe_pairs,
            )
            from ui.backend.services.crm_service import (
                _auto_detect_re_aliases as _crm_auto_detect_re_aliases,
                _load_aliases as _crm_load_aliases,
            )

            _needs_merged, _missing_call_ids = _collect_missing_transcript_requirements()
            if not _needs_merged and not _missing_call_ids:
                return

            if not req.sales_agent or not req.customer:
                raise RuntimeError(
                    "Pipeline requires transcript inputs but sales_agent/customer context is missing."
                )

            yield_msg = (
                f"Missing transcript inputs detected "
                f"({'call' if _missing_call_ids else 'merged'}). Starting auto-transcription…"
            )
            log_buffer.emit(f"[PIPELINE] ⏳ {yield_msg} · {cid_short}")
            execution_logs.append_event(
                execution_session_id,
                yield_msg,
                level="stage",
                status="running",
                data={
                    "missing_call_ids": sorted(_missing_call_ids),
                    "needs_merged_transcript": bool(_needs_merged),
                },
            )
            yield _sse("progress", {"msg": yield_msg})

            _file_aliases = _crm_load_aliases()
            _auto_aliases = _crm_auto_detect_re_aliases([req.sales_agent])
            _all_aliases = {**_auto_aliases, **_file_aliases}
            _alias_names = [a for a, p in _all_aliases.items() if p == req.sales_agent]
            _agent_names = list(dict.fromkeys([req.sales_agent] + _alias_names))

            with Session(_db_engine) as _s:
                _stmt = select(CRMPair).where(CRMPair.customer == req.customer)
                if len(_agent_names) == 1:
                    _stmt = _stmt.where(CRMPair.agent == _agent_names[0])
                else:
                    _stmt = _stmt.where(CRMPair.agent.in_(_agent_names))
                _stmt = _stmt.order_by(CRMPair.call_count.desc())
                _pair_row = _s.exec(_stmt).first()

            if not _pair_row:
                raise RuntimeError(
                    f"Auto-transcription failed: CRM pair not found for {req.sales_agent} / {req.customer}"
                )

            _call_ids = sorted(_missing_call_ids) if _missing_call_ids else []
            _batch_req = BatchPairsRequest(
                pairs=[PairSpec(
                    crm_url=str(_pair_row.crm_url or ""),
                    account_id=str(_pair_row.account_id or ""),
                    agent=req.sales_agent,
                    customer=req.customer,
                    call_ids=_call_ids,
                )]
            )
            _batch_res = await batch_transcribe_pairs(_batch_req)
            _submitted = int(_batch_res.get("submitted") or 0)
            _skipped = int(_batch_res.get("skipped") or 0)
            _job_ids = [str(_j) for _j in (_batch_res.get("job_ids") or []) if str(_j)]

            if _submitted == 0 and not _job_ids:
                # Jobs may already be running from another trigger; wait on inflight.
                with Session(_db_engine) as _s:
                    _j_stmt = select(Job).where(
                        Job.pair_slug == f"{req.sales_agent}/{req.customer}",
                        Job.status.in_([JobStatus.pending, JobStatus.running]),
                    )
                    if _call_ids:
                        _j_stmt = _j_stmt.where(Job.call_id.in_(_call_ids))
                    _inflight = _s.exec(_j_stmt).all()
                _job_ids = [str(_j.id) for _j in _inflight if _j.id]

            if _job_ids:
                _ok, _failed = await _wait_for_jobs(_job_ids)
                if not _ok:
                    raise RuntimeError(
                        f"Auto-transcription timed out/failed for {_failed} call(s)."
                    )

            # Re-check required inputs after auto-transcription finished.
            _needs_merged_after, _missing_call_ids_after = _collect_missing_transcript_requirements()
            if _needs_merged_after or _missing_call_ids_after:
                raise RuntimeError(
                    "Auto-transcription completed but required transcript inputs are still missing."
                )

            log_buffer.emit(
                f"[PIPELINE] ✓ Auto-transcription ready (submitted {_submitted}, skipped {_skipped}) · {cid_short}"
            )
            execution_logs.append_event(
                execution_session_id,
                "Auto-transcription ready",
                level="stage",
                status="running",
                data={
                    "submitted": _submitted,
                    "skipped": _skipped,
                    "job_count": len(_job_ids),
                },
            )
            yield _sse("progress", {
                "msg": f"Auto-transcription ready (submitted {_submitted}, skipped {_skipped})",
            })

        def _persist_agent_result(
            _agent_id: str,
            _agent_name: str,
            _content: str,
            _model: str,
            _pipeline_step_index: int,
            _input_fingerprint: str,
        ) -> str:
            """Persist an agent result in pipeline-aware or legacy schema mode."""
            _rid = str(uuid.uuid4())
            _created_at = datetime.utcnow()
            try:
                with Session(_db_engine) as _s:
                    if _agent_result_has_pipeline_cache:
                        _s.add(AR(
                            id=_rid,
                            agent_id=_agent_id,
                            agent_name=_agent_name,
                            sales_agent=req.sales_agent,
                            customer=req.customer,
                            call_id=req.call_id,
                            pipeline_id=pipeline_id,
                            pipeline_step_index=_pipeline_step_index,
                            input_fingerprint=_input_fingerprint,
                            content=_content,
                            model=_model,
                        ))
                    else:
                        _s.execute(
                            _sql_text(
                                "INSERT INTO agent_result ("
                                "id, agent_id, agent_name, sales_agent, customer, call_id, content, model, created_at"
                                ") VALUES ("
                                ":id, :agent_id, :agent_name, :sales_agent, :customer, :call_id, :content, :model, :created_at"
                                ")"
                            ),
                            {
                                "id": _rid,
                                "agent_id": _agent_id,
                                "agent_name": _agent_name,
                                "sales_agent": req.sales_agent,
                                "customer": req.customer,
                                "call_id": req.call_id,
                                "content": _content,
                                "model": _model,
                                "created_at": _created_at,
                            },
                        )
                    _s.commit()
                return _rid
            except Exception as exc:
                mode = "pipeline" if _agent_result_has_pipeline_cache else "legacy"
                raise RuntimeError(
                    f"Failed to persist AgentResult in {mode} schema mode: {exc}"
                ) from exc

        # ── Build stage groups from canvas ───────────────────────────────────
        # Processing nodes sorted by (stageIndex, x) give the pipeline step order.
        # Steps with the same stageIndex belong to the same parallel stage.
        _canvas_nodes = pipeline_def.get("canvas", {}).get("nodes", [])
        _proc_nodes_all = sorted(
            [n for n in _canvas_nodes if n.get("type") == "processing"],
            key=lambda n: (n.get("data", {}).get("stageIndex", 0), n.get("position", {}).get("x", 0)),
        )
        _proc_nodes_with_agent = [n for n in _proc_nodes_all if (n.get("data", {}) or {}).get("agentId")]
        _proc_nodes = _proc_nodes_with_agent if len(_proc_nodes_with_agent) >= len(steps) else _proc_nodes_all
        _proc_node_id_by_step_idx = {}
        for _i, _n in enumerate(_proc_nodes):
            if _i < len(steps):
                _nid = _n.get("id") or ""
                if _nid:
                    _proc_node_id_by_step_idx[_i] = _nid
        _proc_node_to_step_idx = {v: k for k, v in _proc_node_id_by_step_idx.items()}
        _input_node_ids = [n.get("id") for n in _canvas_nodes if n.get("type") == "input" and (n.get("id") or "")]
        _output_node_ids = [n.get("id") for n in _canvas_nodes if n.get("type") == "output" and (n.get("id") or "")]
        _output_node_data_by_id = {
            (n.get("id") or ""): (n.get("data", {}) or {})
            for n in _canvas_nodes
            if n.get("type") == "output" and (n.get("id") or "")
        }
        _output_node_to_step_idx = {}
        _input_node_to_step_idxs = {}
        _incoming_output_src_by_step_idx: dict[int, str] = {}
        for _e in (pipeline_def.get("canvas", {}) or {}).get("edges", []):
            _src = _e.get("source")
            _tgt = _e.get("target")
            if _src in _proc_node_to_step_idx and _tgt in _output_node_ids:
                _si = _proc_node_to_step_idx[_src]
                _output_node_to_step_idx[_tgt] = _si
                if _si not in _step_output_meta:
                    _od = _output_node_data_by_id.get(_tgt, {})
                    _step_output_meta[_si] = {
                        "sub_type": str(_od.get("subType") or "").strip(),
                        "label": str(_od.get("label") or "").strip(),
                    }
            # Output -> processing edges carry semantic artifact source for downstream inputs.
            if _src in _output_node_ids and _tgt in _proc_node_to_step_idx:
                _si = _proc_node_to_step_idx[_tgt]
                _od = _output_node_data_by_id.get(_src, {})
                _sub = str(_od.get("subType") or "").strip()
                if _sub and _si not in _incoming_output_src_by_step_idx:
                    _incoming_output_src_by_step_idx[_si] = f"artifact_{_sub}"
            if _src in _input_node_ids and _tgt in _proc_node_to_step_idx:
                _arr = _input_node_to_step_idxs.get(_src, [])
                _arr.append(_proc_node_to_step_idx[_tgt])
                _input_node_to_step_idxs[_src] = _arr
        # Keep deterministic order for stable JSON/state diffs.
        for _k, _arr in list(_input_node_to_step_idxs.items()):
            _input_node_to_step_idxs[_k] = sorted(set(_arr))

        _step_canvas_stage: dict[int, int] = {}
        for _i, _n in enumerate(_proc_nodes):
            if _i < len(steps):
                _step_canvas_stage[_i] = _n.get("data", {}).get("stageIndex", _i)
        if not _step_canvas_stage:  # no canvas → each step is its own sequential stage
            _step_canvas_stage = {_i: _i for _i in range(len(steps))}

        # Ordered list of (canvas_stage_key, [step_indices]) preserving first-occurrence order
        _seen_stages: list[int] = []
        _grp: dict[int, list[int]] = {}
        for _si in range(len(steps)):
            _cs = _step_canvas_stage.get(_si, _si)
            if _cs not in _grp:
                _grp[_cs] = []
                _seen_stages.append(_cs)
            _grp[_cs].append(_si)
        _ordered_stages = [(_cs, _grp[_cs]) for _cs in _seen_stages]
        # Rewrite once after canvas maps are available so JSON includes node_states.
        save_steps()

        def _jsonish_to_str(_raw: str) -> str:
            _text = (_raw or "").strip()
            if not _text:
                return "{}"
            # Strip optional fenced code blocks before JSON parsing.
            if _text.startswith("```"):
                _text = _re.sub(r"^```[a-zA-Z0-9_-]*\s*", "", _text)
                _text = _re.sub(r"\s*```$", "", _text).strip()
            try:
                return json.dumps(json.loads(_text), ensure_ascii=False)
            except Exception:
                pass
            _m = _re.search(r"\{[\s\S]+\}", _text)
            if _m:
                try:
                    return json.dumps(json.loads(_m.group(0)), ensure_ascii=False)
                except Exception:
                    pass
            return json.dumps({"_raw_text": _raw}, ensure_ascii=False)

        def _save_notes_rollup_from_pipeline(_step_idx: int, _sub_type: str, _content: str, _model: str) -> None:
            if not (req.sales_agent and req.customer):
                return
            try:
                _parsed = json.loads(_jsonish_to_str(_content))
                if not isinstance(_parsed, dict):
                    _parsed = {"_raw_text": _content}
            except Exception:
                _parsed = {"_raw_text": _content}
            _parsed["_saved_at"] = datetime.utcnow().isoformat()
            _parsed["_note_count"] = 1
            _parsed["_preset"] = "(all)"
            _parsed["_source"] = "pipeline"
            _parsed["_pipeline_id"] = pipeline_id
            _parsed["_run_id"] = run_id
            _parsed["_step_idx"] = _step_idx
            _parsed["_artifact_sub_type"] = _sub_type
            _parsed["_model"] = _model
            _save_dir = settings.ui_data_dir / "_note_rollups" / req.sales_agent
            _save_dir.mkdir(parents=True, exist_ok=True)
            (_save_dir / f"{req.customer}__all.json").write_text(
                json.dumps(_parsed, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            # Keep legacy filename path for compatibility.
            (_save_dir / f"{req.customer}.json").write_text(
                json.dumps(_parsed, indent=2, ensure_ascii=False), encoding="utf-8"
            )

        def _persist_structured_artifact(
            _step_idx: int,
            _content: str,
            _model: str,
            _agent_name: str,
            _input_fingerprint: str,
        ) -> None:
            _meta = _step_output_meta.get(_step_idx, {})
            _sub_type = str(_meta.get("sub_type") or "").strip().lower()
            if _sub_type not in {"persona", "persona_score", "notes", "notes_compliance"}:
                return

            _fp = _input_fingerprint or _hash_text(_content)[:24]
            _marker = f"pipeline:{pipeline_id}:{_step_idx}:{_fp}"
            _label = (_meta.get("label") or "").strip() or f"{pipeline_name} · {_agent_name}"
            _call_id = req.call_id or f"pipeline:{run_id}:{_step_idx}"

            try:
                if _sub_type == "persona":
                    with Session(_db_engine) as _s:
                        _existing = _s.exec(
                            select(Persona).where(Persona.persona_agent_id == _marker)
                        ).first()
                        if _existing:
                            if (_existing.content_md or "") != (_content or ""):
                                _existing.content_md = _content
                                _existing.model = _model
                                _s.add(_existing)
                                _s.commit()
                            _artifact_ctx["latest_persona_id"] = _existing.id
                            return
                        _ptype = "pair" if req.customer else "agent_overall"
                        _p = Persona(
                            id=str(uuid.uuid4()),
                            type=_ptype,
                            agent=req.sales_agent,
                            customer=req.customer or None,
                            label=_label,
                            content_md=_content,
                            prompt_used="",
                            model=_model,
                            temperature=0.0,
                            transcript_paths="",
                            script_path=None,
                            version=1,
                            parent_id=None,
                            persona_agent_id=_marker,
                            sections_json=None,
                            score_json=None,
                        )
                        _s.add(_p)
                        _s.commit()
                        _artifact_ctx["latest_persona_id"] = _p.id
                    return

                if _sub_type == "persona_score":
                    _score_json = _jsonish_to_str(_content)
                    with Session(_db_engine) as _s:
                        _target = None
                        _latest_id = _artifact_ctx.get("latest_persona_id")
                        if _latest_id:
                            _target = _s.get(Persona, _latest_id)
                        if not _target:
                            _q = select(Persona).where(
                                Persona.agent == req.sales_agent,
                                Persona.type.in_(["pair", "agent_overall"]),
                                Persona.persona_agent_id.contains(f"pipeline:{pipeline_id}:"),
                            )
                            if req.customer:
                                _q = _q.where(Persona.customer == req.customer)
                            else:
                                _q = _q.where(Persona.customer == None)  # noqa: E711
                            _q = _q.order_by(Persona.created_at.desc())
                            _target = _s.exec(_q).first()
                        if not _target:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ No matching persona row to attach persona_score for step {_step_idx + 1} · {cid_short}"
                            )
                            return
                        _target.score_json = _score_json
                        _target.model = _target.model or _model
                        _s.add(_target)
                        _s.commit()
                        _artifact_ctx["latest_persona_id"] = _target.id
                    return

                if _sub_type == "notes":
                    with Session(_db_engine) as _s:
                        _existing = _s.exec(
                            select(Note).where(
                                Note.agent == req.sales_agent,
                                Note.customer == req.customer,
                                Note.call_id == _call_id,
                                Note.persona_agent_id == _marker,
                            )
                        ).first()
                        if _existing:
                            if (_existing.content_md or "") != (_content or ""):
                                _existing.content_md = _content
                                _existing.model = _model
                                _s.add(_existing)
                                _s.commit()
                        else:
                            _n = Note(
                                id=str(uuid.uuid4()),
                                agent=req.sales_agent,
                                customer=req.customer,
                                call_id=_call_id,
                                persona_agent_id=_marker,
                                content_md=_content,
                                score_json=None,
                                model=_model,
                                temperature=0.0,
                            )
                            _s.add(_n)
                            _s.commit()
                    _save_notes_rollup_from_pipeline(_step_idx, _sub_type, _content, _model)
                    return

                if _sub_type == "notes_compliance":
                    _score_json = _jsonish_to_str(_content)
                    with Session(_db_engine) as _s:
                        _existing = _s.exec(
                            select(Note).where(
                                Note.agent == req.sales_agent,
                                Note.customer == req.customer,
                                Note.call_id == _call_id,
                                Note.persona_agent_id == _marker,
                            )
                        ).first()
                        if _existing:
                            _existing.content_md = _content
                            _existing.score_json = _score_json
                            _existing.model = _model
                            _s.add(_existing)
                            _s.commit()
                        else:
                            _n = Note(
                                id=str(uuid.uuid4()),
                                agent=req.sales_agent,
                                customer=req.customer,
                                call_id=_call_id,
                                persona_agent_id=_marker,
                                content_md=_content,
                                score_json=_score_json,
                                model=_model,
                                temperature=0.0,
                            )
                            _s.add(_n)
                            _s.commit()
                    return
            except Exception as _artifact_exc:
                log_buffer.emit(
                    f"[PIPELINE] ⚠ Artifact persist failed for step {_step_idx + 1} ({_sub_type}): {_artifact_exc}"
                )

        try:
            async for _evt in _ensure_transcripts_ready_for_run():
                yield _evt
            log_buffer.emit(f"[PIPELINE] ▶ {pipeline_name} ({len(steps)} steps) · {cid_short}")
            yield _sse("pipeline_start", {"total": len(steps), "name": pipeline_name, "run_id": run_id})

            fatal_error = False

            for _canvas_stage, step_indices in _ordered_stages:
                _raise_if_stop_requested()
                if fatal_error:
                    break

                # ── Single-step stage (streaming ok) ─────────────────────────
                if len(step_indices) == 1:
                    step_idx  = step_indices[0]
                    step      = steps[step_idx]
                    agent_id  = step.get("agent_id", "")
                    agent_def = agent_map.get(agent_id)

                    if not agent_def:
                        run_steps[step_idx]["state"]    = "failed"
                        run_steps[step_idx]["end_time"] = datetime.utcnow().isoformat()
                        run_steps[step_idx]["error_msg"] = f"Agent '{agent_id}' not found"
                        yield _sse("error", {"msg": f"Step {step_idx + 1}: agent '{agent_id}' not found", "step": step_idx})
                        save_steps()
                        fatal_error = True
                        break

                    overrides = _normalize_overrides_for_step(
                        step_idx, agent_def, step.get("input_overrides", {})
                    )

                    agent_name = agent_def.get("name", agent_id)
                    model      = agent_def.get("model", "gpt-5.4")

                    run_steps[step_idx]["agent_name"] = agent_name
                    run_steps[step_idx]["model"]      = model
                    run_steps[step_idx]["state"]      = "running"
                    run_steps[step_idx]["input_ready"] = False
                    run_steps[step_idx]["start_time"] = datetime.utcnow().isoformat()
                    save_steps()  # persist "running" so mid-run refresh shows orange

                    log_buffer.emit(f"[PIPELINE] ▶ Step {step_idx + 1}/{len(steps)}: {agent_name} [{model}] · {cid_short}")
                    yield _sse("step_start", {
                        "step": step_idx, "total": len(steps),
                        "agent_id": agent_id, "agent_name": agent_name, "model": model,
                    })

                    # ── Capture input source declarations ────────────────────
                    run_steps[step_idx]["input_sources"] = [
                        {
                            "key": inp.get("key", ""),
                            "source": _public_input_source(
                                overrides.get(inp.get("key", ""), inp.get("source", "manual"))
                            ),
                        }
                        for inp in agent_def.get("inputs", [])
                    ]

                    # Resume-partial fast path: reuse latest step cache immediately,
                    # before potentially expensive input resolution/fingerprint work.
                    if req.resume_partial and (not req.force) and step_idx not in req.force_step_indices:
                        _resume_cached = None
                        try:
                            with Session(_db_engine) as _s:
                                _resume_cached = _lookup_step_cache_resume_only(_s, agent_id, step_idx)
                        except Exception as _cache_exc:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ Resume cache lookup failed for step {step_idx + 1}: {_cache_exc}"
                            )
                        if _resume_cached:
                            prev_content = _resume_cached.content
                            _persist_structured_artifact(
                                _step_idx=step_idx,
                                _content=_resume_cached.content,
                                _model=model,
                                _agent_name=agent_name,
                                _input_fingerprint="",
                            )
                            run_steps[step_idx].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _resume_cached.content,
                                "input_ready":      True,
                                "cache_mode":       "resume_partial",
                                "cached_locations": [{
                                    "type": "agent_result",
                                    "id": _resume_cached.id,
                                    "created_at": _resume_cached.created_at.isoformat() if _resume_cached.created_at else None,
                                }],
                            })
                            save_steps()
                            log_buffer.emit(
                                f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached (resume fast-path) · {cid_short}"
                            )
                            yield _sse("step_cached", {
                                "step": step_idx,
                                "agent_name": agent_name,
                                "result_id": _resume_cached.id,
                                "content": _resume_cached.content,
                                "cache_mode": "resume_partial",
                            })
                            continue

                    # ── Resolve inputs ───────────────────────────────────────
                    temperature   = float(agent_def.get("temperature", 0.0))
                    system_prompt = agent_def.get("system_prompt", "")
                    user_template = agent_def.get("user_prompt", "")
                    manual_inputs = {"_chain_previous": prev_content}
                    source_for_key = {
                        inp.get("key", ""): _public_input_source(
                            overrides.get(inp.get("key", ""), inp.get("source", ""))
                        )
                        for inp in agent_def.get("inputs", [])
                    }

                    resolved: dict[str, str] = {}
                    resolve_err = False
                    def _resolve_input_worker(
                        _source: str,
                        _ref_id: Optional[str],
                        _manual_inputs: dict[str, str],
                        _input_key: str,
                    ) -> str:
                        with Session(_db_engine) as _ldb:
                            return _resolve_input(
                                _source, _ref_id, req.sales_agent, req.customer, req.call_id,
                                _manual_inputs, _ldb, input_key=_input_key,
                            )
                    for inp in agent_def.get("inputs", []):
                        key    = inp.get("key", "input")
                        source = _public_input_source(
                            overrides.get(key, inp.get("source", "manual"))
                        )
                        ref_id = inp.get("agent_id")
                        try:
                            text = await loop.run_in_executor(
                                None,
                                lambda s=source, a=ref_id, m=manual_inputs, k=key: _resolve_input_worker(s, a, m, k),
                            )
                            resolved[key] = text
                        except Exception as exc:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": str(exc)})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error (resolve input) · {cid_short}")
                            yield _sse("error", {"msg": str(exc), "step": step_idx})
                            save_steps()
                            fatal_error = True
                            resolve_err = True
                            break
                    if resolve_err:
                        break
                    run_steps[step_idx]["input_ready"] = True
                    save_steps()  # input files/text resolved — persist input-node readiness

                    file_keys = {
                        inp.get("key", "")
                        for inp in agent_def.get("inputs", [])
                        if _is_file_source(
                            _public_input_source(
                                overrides.get(inp.get("key", ""), inp.get("source", "manual"))
                            )
                        )
                    }
                    file_inputs   = {k: v for k, v in resolved.items() if k in file_keys}
                    inline_inputs = {k: v for k, v in resolved.items() if k not in file_keys}

                    input_fingerprint = _build_input_fingerprint(
                        pipeline_id=pipeline_id,
                        step_idx=step_idx,
                        agent_id=agent_id,
                        model=model,
                        temperature=temperature,
                        system_prompt=system_prompt,
                        user_template=user_template,
                        overrides=overrides,
                        resolved_inputs=resolved,
                    )
                    run_steps[step_idx]["input_fingerprint"] = input_fingerprint

                    # ── Check cache (pipeline+step+input fingerprint) ────────
                    if not req.force and step_idx not in req.force_step_indices:
                        cached = None
                        cached_via_resume_partial = False
                        try:
                            with Session(_db_engine) as _s:
                                cached, cached_via_resume_partial = _lookup_step_cache(
                                    _s, agent_id, step_idx, input_fingerprint
                                )
                        except Exception as _cache_exc:
                            log_buffer.emit(
                                f"[PIPELINE] ⚠ Cache lookup failed for step {step_idx + 1}: {_cache_exc}"
                            )
                            cached = None

                        if cached:
                            prev_content = cached.content
                            _persist_structured_artifact(
                                _step_idx=step_idx,
                                _content=cached.content,
                                _model=model,
                                _agent_name=agent_name,
                                _input_fingerprint=input_fingerprint,
                            )
                            run_steps[step_idx].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          cached.content,
                                "input_ready":      True,
                                "cache_mode":       "resume_partial" if cached_via_resume_partial else "exact",
                                "cached_locations": [{"type": "agent_result", "id": cached.id, "created_at": cached.created_at.isoformat() if cached.created_at else None}],
                            })
                            save_steps()  # write state BEFORE yield so file is correct if client disconnects
                            if cached_via_resume_partial:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached (resume fallback) · {cid_short}"
                                )
                            else:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached · {cid_short}"
                                )
                            yield _sse("step_cached", {
                                "step": step_idx, "agent_name": agent_name,
                                "result_id": cached.id, "content": cached.content,
                                "cache_mode": "resume_partial" if cached_via_resume_partial else "exact",
                            })
                            continue  # advance to next canvas stage

                    # Inputs resolved — notify frontend so input nodes can turn green
                    # before the LLM call starts (which may take many seconds).
                    yield _sse("input_ready", {"step": step_idx})

                    # ── Call LLM ─────────────────────────────────────────────
                    inline_chars = sum(len(v) for v in inline_inputs.values())
                    file_chars   = sum(len(v) for v in file_inputs.values())
                    total_chars  = inline_chars + (file_chars if model.startswith("grok") else 0)
                    input_tok_est = (total_chars + len(system_prompt)) // 4
                    # Show inline chars and file count separately so large file content
                    # doesn't obscure how much inline context is in the prompt.
                    if inline_chars and file_inputs:
                        _log_display = f"{inline_chars:,} chars + {len(file_inputs)} file(s)"
                    elif inline_chars:
                        _log_display = f"{inline_chars:,} chars"
                    else:
                        _log_display = f"{len(file_inputs)} file(s)"
                    log_buffer.emit(f"[LLM] {model} — {_log_display} input · {cid_short}")

                    step_start_t = time.time()
                    llm_err = False

                    if model.startswith("claude-"):
                        q: _queue.Queue = _queue.Queue()
                        result_holder: list = []
                        error_holder:  list = []

                        def _do(fi=file_inputs, ii=inline_inputs, m=model, sp=system_prompt, ut=user_template):
                            try:
                                with Session(_db_engine) as _ldb:
                                    _ldb._agent_run_ctx = {
                                        "sales_agent": req.sales_agent,
                                        "customer": req.customer,
                                        "call_id": req.call_id,
                                        "source_for_key": source_for_key,
                                    }
                                    c, t = _llm_call_anthropic_files_streaming(
                                        sp, ut, fi, ii, m, _ldb,
                                        on_text=lambda chunk: q.put(("stream", chunk)),
                                    )
                                result_holder.append((c, t))
                            except Exception as exc:
                                error_holder.append(str(exc))
                            finally:
                                q.put(None)

                        threading.Thread(target=_do, daemon=True).start()

                        while True:
                            item = await loop.run_in_executor(None, q.get)
                            if item is None:
                                break
                            _, data = item
                            yield _sse("stream", {"text": data, "step": step_idx})

                        if error_holder:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": error_holder[0]})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error · {cid_short}")
                            yield _sse("error", {"msg": error_holder[0], "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True

                        if not llm_err:
                            content, thinking = result_holder[0]
                    else:
                        try:
                            def _do_llm():
                                with Session(_db_engine) as _ldb:
                                    _ldb._agent_run_ctx = {
                                        "sales_agent": req.sales_agent,
                                        "customer": req.customer,
                                        "call_id": req.call_id,
                                        "source_for_key": source_for_key,
                                    }
                                    return _llm_call_with_files(
                                        system_prompt, user_template,
                                        file_inputs, inline_inputs,
                                        model, temperature, _ldb,
                                    )

                            _future = loop.run_in_executor(None, _do_llm)
                            yield _sse("progress", {"step": step_idx, "msg": f"Calling {model}…"})
                            _deadline = time.monotonic() + LLM_TIMEOUT_S
                            _next_heartbeat = time.monotonic() + 3.0
                            while True:
                                _raise_if_stop_requested()
                                _remaining = _deadline - time.monotonic()
                                if _remaining <= 0:
                                    raise asyncio.TimeoutError
                                done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                                if done_set:
                                    content, thinking = _future.result()
                                    break
                                if time.monotonic() >= _next_heartbeat:
                                    waited_s = int(LLM_TIMEOUT_S - _remaining)
                                    _next_heartbeat = time.monotonic() + 3.0
                                    log_buffer.emit(
                                        f"[PIPELINE] … Step {step_idx + 1}/{len(steps)} waiting on {model} ({waited_s}s) · {cid_short}"
                                    )
                                    yield _sse("progress", {
                                        "step": step_idx,
                                        "msg": f"Waiting for {model} response… {waited_s}s",
                                    })
                        except asyncio.TimeoutError:
                            err_msg = f"LLM call timed out after {int(LLM_TIMEOUT_S)}s (model: {model})"
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": err_msg})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → timeout · {cid_short}")
                            yield _sse("error", {"msg": err_msg, "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True
                        except Exception as exc:
                            run_steps[step_idx].update({"state": "failed", "end_time": datetime.utcnow().isoformat(), "error_msg": str(exc)})
                            log_buffer.emit(f"[PIPELINE] ✗ Step {step_idx + 1}/{len(steps)}: {agent_name} → error · {cid_short}")
                            yield _sse("error", {"msg": str(exc), "step": step_idx})
                            save_steps()
                            fatal_error = True
                            llm_err = True

                    if llm_err:
                        break

                    exec_time_s    = round(time.time() - step_start_t, 1)
                    output_tok_est = len(content) // 4

                    # ── Persist AgentResult ───────────────────────────────────
                    result_id = _persist_agent_result(
                        _agent_id=agent_id,
                        _agent_name=agent_name,
                        _content=content,
                        _model=model,
                        _pipeline_step_index=step_idx,
                        _input_fingerprint=input_fingerprint,
                    )
                    _persist_structured_artifact(
                        _step_idx=step_idx,
                        _content=content,
                        _model=model,
                        _agent_name=agent_name,
                        _input_fingerprint=input_fingerprint,
                    )

                    prev_content = content
                    run_steps[step_idx].update({
                        "state":            "completed",
                        "end_time":         datetime.utcnow().isoformat(),
                        "content":          content,
                        "input_ready":      True,
                        "execution_time_s": exec_time_s,
                        "input_token_est":  input_tok_est,
                        "output_token_est": output_tok_est,
                        "thinking":         (thinking or "")[:8000],
                    })
                    save_steps()  # write state BEFORE yields so file is correct if client disconnects

                    log_buffer.emit(f"[LLM] {model} — done ({len(content):,} chars, {exec_time_s}s) · {cid_short}")

                    if thinking:
                        yield _sse("thinking", {"content": thinking[:5000], "step": step_idx})

                    log_buffer.emit(f"[PIPELINE] ✓ Step {step_idx + 1}/{len(steps)}: {agent_name} → done ({exec_time_s}s) · {cid_short}")
                    yield _sse("step_done", {
                        "step":             step_idx,
                        "agent_name":       agent_name,
                        "result_id":        result_id,
                        "content":          content,
                        "model":            model,
                        "execution_time_s": exec_time_s,
                        "input_token_est":  input_tok_est,
                        "output_token_est": output_tok_est,
                    })

                # ── Parallel stage (multiple steps, non-streaming) ────────────
                else:
                    n_par = len(step_indices)
                    log_buffer.emit(f"[PIPELINE] ▶ Stage {_canvas_stage}: {n_par} parallel steps · {cid_short}")

                    # Validate all agents before starting
                    for _sidx in step_indices:
                        _aid = steps[_sidx].get("agent_id", "")
                        if not agent_map.get(_aid):
                            run_steps[_sidx]["state"]    = "failed"
                            run_steps[_sidx]["end_time"] = datetime.utcnow().isoformat()
                            run_steps[_sidx]["error_msg"] = f"Agent '{_aid}' not found"
                            yield _sse("error", {"msg": f"Step {_sidx + 1}: agent '{_aid}' not found", "step": _sidx})
                            fatal_error = True
                            break
                    if fatal_error:
                        break

                    # Set loading + emit step_start for all parallel steps simultaneously
                    for _sidx in step_indices:
                        _s = steps[_sidx]
                        _aid = _s.get("agent_id", "")
                        _adef = agent_map[_aid]
                        _ov = _normalize_overrides_for_step(
                            _sidx, _adef, _s.get("input_overrides", {})
                        )
                        _aname = _adef.get("name", _aid)
                        _model = _adef.get("model", "gpt-5.4")
                        run_steps[_sidx]["agent_name"] = _aname
                        run_steps[_sidx]["model"]      = _model
                        run_steps[_sidx]["input_sources"] = [
                            {
                                "key": inp.get("key", ""),
                                "source": _public_input_source(
                                    _ov.get(inp.get("key", ""), inp.get("source", "manual"))
                                ),
                            }
                            for inp in _adef.get("inputs", [])
                        ]
                        run_steps[_sidx]["state"]      = "running"
                        run_steps[_sidx]["input_ready"] = False
                        run_steps[_sidx]["start_time"] = datetime.utcnow().isoformat()
                        log_buffer.emit(f"[PIPELINE] ▶ Step {_sidx + 1}/{len(steps)}: {_aname} [{_model}] · {cid_short}")
                        yield _sse("step_start", {
                            "step": _sidx, "total": len(steps),
                            "agent_id": _aid, "agent_name": _aname, "model": _model,
                        })
                    save_steps()

                    _stage_prev = prev_content  # all parallel steps share the same prev stage output

                    def _run_parallel_step_sync(par_idx: int, _sp: str) -> dict:
                        """Execute one parallel step in a worker thread. Never raises."""
                        _par_step   = steps[par_idx]
                        _par_aid    = _par_step.get("agent_id", "")
                        _par_ov     = _par_step.get("input_overrides", {})
                        _par_adef   = agent_map[_par_aid]
                        _par_aname  = _par_adef.get("name", _par_aid)
                        _par_model  = _par_adef.get("model", "gpt-5.4")
                        _par_temp   = float(_par_adef.get("temperature", 0.0))
                        _par_sysp   = _par_adef.get("system_prompt", "")
                        _par_ut     = _par_adef.get("user_prompt", "")
                        _par_mi     = {"_chain_previous": _sp}
                        _par_fp     = ""
                        _par_input_ready = False
                        try:
                            with Session(_db_engine) as _par_db:
                                _source_for_key = {
                                    inp.get("key", ""): _public_input_source(
                                        _par_ov.get(inp.get("key", ""), inp.get("source", ""))
                                    )
                                    for inp in _par_adef.get("inputs", [])
                                }
                                _par_db._agent_run_ctx = {
                                    "sales_agent": req.sales_agent,
                                    "customer": req.customer,
                                    "call_id": req.call_id,
                                    "source_for_key": _source_for_key,
                                }

                                # Resume-partial fast path for parallel stages too.
                                if req.resume_partial and (not req.force) and par_idx not in req.force_step_indices:
                                    _resume_cached = None
                                    try:
                                        _resume_cached = _lookup_step_cache_resume_only(_par_db, _par_aid, par_idx)
                                    except Exception as _cache_exc:
                                        log_buffer.emit(
                                            f"[PIPELINE] ⚠ Parallel resume cache lookup failed for step {par_idx + 1}: {_cache_exc}"
                                        )
                                    if _resume_cached:
                                        return {
                                            "step_idx": par_idx,
                                            "status": "cached",
                                            "content": _resume_cached.content,
                                            "result_id": _resume_cached.id,
                                            "cached_created_at": _resume_cached.created_at.isoformat() if _resume_cached.created_at else None,
                                            "agent_name": _par_aname,
                                            "model": _par_model,
                                            "input_fingerprint": "",
                                            "input_ready": True,
                                            "cache_mode": "resume_partial",
                                        }

                                _par_resolved: dict[str, str] = {}
                                for _inp in _par_adef.get("inputs", []):
                                    _k   = _inp.get("key", "input")
                                    _src = _public_input_source(
                                        _par_ov.get(_k, _inp.get("source", "manual"))
                                    )
                                    _rid = _inp.get("agent_id")
                                    _par_resolved[_k] = _resolve_input(
                                        _src, _rid, req.sales_agent, req.customer, req.call_id, _par_mi, _par_db,
                                        input_key=_k,
                                    )
                                _par_input_ready = True

                                _par_fkeys = {
                                    _inp.get("key", "")
                                    for _inp in _par_adef.get("inputs", [])
                                    if _is_file_source(
                                        _public_input_source(
                                            _par_ov.get(_inp.get("key", ""), _inp.get("source", "manual"))
                                        )
                                    )
                                }
                                _par_fi = {k: v for k, v in _par_resolved.items() if k in _par_fkeys}
                                _par_ii = {k: v for k, v in _par_resolved.items() if k not in _par_fkeys}
                                _par_fp = _build_input_fingerprint(
                                    pipeline_id=pipeline_id,
                                    step_idx=par_idx,
                                    agent_id=_par_aid,
                                    model=_par_model,
                                    temperature=_par_temp,
                                    system_prompt=_par_sysp,
                                    user_template=_par_ut,
                                    overrides=_par_ov,
                                    resolved_inputs=_par_resolved,
                                )

                                if not req.force and par_idx not in req.force_step_indices:
                                    _cached = None
                                    _cached_via_resume_partial = False
                                    try:
                                        _cached, _cached_via_resume_partial = _lookup_step_cache(
                                            _par_db, _par_aid, par_idx, _par_fp
                                        )
                                    except Exception as _cache_exc:
                                        log_buffer.emit(
                                            f"[PIPELINE] ⚠ Parallel cache lookup failed for step {par_idx + 1}: {_cache_exc}"
                                        )
                                        _cached = None
                                    if _cached:
                                        return {
                                            "step_idx": par_idx,
                                            "status": "cached",
                                            "content": _cached.content,
                                            "result_id": _cached.id,
                                            "cached_created_at": _cached.created_at.isoformat() if _cached.created_at else None,
                                            "agent_name": _par_aname,
                                            "model": _par_model,
                                            "input_fingerprint": _par_fp,
                                            "input_ready": _par_input_ready,
                                            "cache_mode": "resume_partial" if _cached_via_resume_partial else "exact",
                                        }

                                _par_ic  = sum(len(v) for v in _par_ii.values())
                                _par_fc  = sum(len(v) for v in _par_fi.values())
                                _par_tc  = _par_ic + (_par_fc if _par_model.startswith("grok") else 0)
                                _par_tok = (_par_tc + len(_par_sysp)) // 4
                                if _par_ic and _par_fi:
                                    _par_log = f"{_par_ic:,} chars + {len(_par_fi)} file(s)"
                                elif _par_ic:
                                    _par_log = f"{_par_ic:,} chars"
                                else:
                                    _par_log = f"{len(_par_fi)} file(s)"
                                log_buffer.emit(f"[LLM] {_par_model} — {_par_log} input · {cid_short}")

                                _par_t0 = time.time()
                                _par_content, _par_thinking = _llm_call_with_files(
                                    _par_sysp, _par_ut, _par_fi, _par_ii, _par_model, _par_temp, _par_db,
                                )
                                _par_exec = round(time.time() - _par_t0, 1)

                                _par_rid = _persist_agent_result(
                                    _agent_id=_par_aid,
                                    _agent_name=_par_aname,
                                    _content=_par_content,
                                    _model=_par_model,
                                    _pipeline_step_index=par_idx,
                                    _input_fingerprint=_par_fp,
                                )

                                return {
                                    "step_idx": par_idx,
                                    "status": "done",
                                    "content": _par_content,
                                    "thinking": _par_thinking,
                                    "exec_time_s": _par_exec,
                                    "input_tok": _par_tok,
                                    "output_tok": len(_par_content) // 4,
                                    "result_id": _par_rid,
                                    "model": _par_model,
                                    "agent_name": _par_aname,
                                    "input_fingerprint": _par_fp,
                                    "input_ready": _par_input_ready,
                                }
                        except Exception as exc:
                            return {
                                "step_idx": par_idx,
                                "status": "error",
                                "error_msg": str(exc),
                                "agent_name": _par_aname,
                                "model": _par_model,
                                "input_fingerprint": _par_fp,
                                "input_ready": _par_input_ready,
                            }

                    async def _run_parallel_step(par_idx: int, _sp: str = _stage_prev) -> dict:
                        _par_step = steps[par_idx]
                        _par_aid = _par_step.get("agent_id", "")
                        _par_adef = agent_map[_par_aid]
                        _par_aname = _par_adef.get("name", _par_aid)
                        _par_model = _par_adef.get("model", "gpt-5.4")
                        _future = loop.run_in_executor(None, lambda: _run_parallel_step_sync(par_idx, _sp))
                        _deadline = time.monotonic() + LLM_TIMEOUT_S
                        _next_heartbeat = time.monotonic() + 3.0
                        while True:
                            _raise_if_stop_requested()
                            _remaining = _deadline - time.monotonic()
                            if _remaining <= 0:
                                return {
                                    "step_idx": par_idx,
                                    "status": "error",
                                    "error_msg": f"LLM call timed out after {int(LLM_TIMEOUT_S)}s (model: {_par_model})",
                                    "agent_name": _par_aname,
                                    "model": _par_model,
                                    "input_ready": False,
                                }
                            done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                            if done_set:
                                return _future.result()
                            if time.monotonic() >= _next_heartbeat:
                                waited_s = int(LLM_TIMEOUT_S - _remaining)
                                _next_heartbeat = time.monotonic() + 3.0
                                log_buffer.emit(
                                    f"[PIPELINE] … Step {par_idx + 1}/{len(steps)} waiting on {_par_model} ({waited_s}s) · {cid_short}"
                                )

                    par_results = list(await asyncio.gather(*[_run_parallel_step(idx) for idx in step_indices]))

                    stage_had_error = False
                    for _res in par_results:
                        _ri   = _res["step_idx"]
                        _rst  = _res["status"]
                        _rn   = _res.get("agent_name", "")
                        _rm   = _res.get("model", "")
                        if _rst == "cached":
                            _persist_structured_artifact(
                                _step_idx=_ri,
                                _content=_res["content"],
                                _model=_rm,
                                _agent_name=_rn,
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                            )
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _res["content"],
                                "input_ready":      _res.get("input_ready", True),
                                "cache_mode":       _res.get("cache_mode", "exact"),
                                "cached_locations": [{
                                    "type": "agent_result",
                                    "id": _res.get("result_id", ""),
                                    "created_at": _res.get("cached_created_at"),
                                }],
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()  # write BEFORE yield so file is correct if client disconnects
                            if _res.get("cache_mode") == "resume_partial":
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {_ri + 1}/{len(steps)}: {_rn} → cached (resume fallback) · {cid_short}"
                                )
                            else:
                                log_buffer.emit(
                                    f"[PIPELINE] ↩ Step {_ri + 1}/{len(steps)}: {_rn} → cached · {cid_short}"
                                )
                            yield _sse("step_cached", {"step": _ri, "agent_name": _rn,
                                                        "result_id": _res.get("result_id", ""), "content": _res["content"],
                                                        "cache_mode": _res.get("cache_mode", "exact")})
                        elif _rst == "done":
                            _rc  = _res["content"]
                            _ret = _res["exec_time_s"]
                            _persist_structured_artifact(
                                _step_idx=_ri,
                                _content=_rc,
                                _model=_rm,
                                _agent_name=_rn,
                                _input_fingerprint=_res.get("input_fingerprint", ""),
                            )
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _rc,
                                "input_ready":      _res.get("input_ready", True),
                                "execution_time_s": _ret,
                                "input_token_est":  _res["input_tok"],
                                "output_token_est": _res["output_tok"],
                                "thinking":         (_res.get("thinking") or "")[:8000],
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()  # write BEFORE yields so file is correct if client disconnects
                            log_buffer.emit(f"[LLM] {_rm} — done ({len(_rc):,} chars, {_ret}s) · {cid_short}")
                            log_buffer.emit(f"[PIPELINE] ✓ Step {_ri + 1}/{len(steps)}: {_rn} → done ({_ret}s) · {cid_short}")
                            if _res.get("thinking"):
                                yield _sse("thinking", {"content": _res["thinking"][:5000], "step": _ri})
                            yield _sse("step_done", {
                                "step":             _ri,
                                "agent_name":       _rn,
                                "result_id":        _res["result_id"],
                                "content":          _rc,
                                "model":            _rm,
                                "execution_time_s": _ret,
                                "input_token_est":  _res["input_tok"],
                                "output_token_est": _res["output_tok"],
                            })
                        else:  # error
                            _remsg = _res.get("error_msg", "Unknown error")
                            run_steps[_ri].update({
                                "state": "failed",
                                "end_time": datetime.utcnow().isoformat(),
                                "error_msg": _remsg,
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                                "input_ready": _res.get("input_ready", False),
                            })
                            save_steps()  # write BEFORE yield so file is correct if client disconnects
                            log_buffer.emit(f"[PIPELINE] ✗ Step {_ri + 1}/{len(steps)}: {_rn} → error · {cid_short}")
                            yield _sse("error", {"msg": _remsg, "step": _ri})
                            stage_had_error = True

                    if stage_had_error:
                        fatal_error = True
                        break

                    # prev_content for next stage: last parallel step's output (by index)
                    _last = max(
                        (_r for _r in par_results if _r["status"] in ("done", "cached")),
                        key=lambda _r: _r["step_idx"],
                        default=None,
                    )
                    if _last:
                        prev_content = _last["content"]

            if not fatal_error:
                run_final_status = "done"
                _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "pass", run_steps,
                            start_datetime=run_start_dt, node_states=_build_node_states())
                log_buffer.emit(f"[PIPELINE] ✅ Done: {pipeline_name} · {cid_short}")
                yield _sse("pipeline_done", {})
            else:
                # Explicit error (agent failure, resolve error, etc.) — mark file as failed.
                _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                            start_datetime=run_start_dt, node_states=_build_node_states())

        except asyncio.CancelledError:
            cancel_msg = cancel_state["reason"]
            execution_error_msg = cancel_msg
            if cancel_msg == "run stopped by user":
                now_iso = datetime.utcnow().isoformat()
                for s in run_steps:
                    if s.get("state") == "running":
                        s["state"] = "failed"
                        s["end_time"] = now_iso
                        s["error_msg"] = cancel_msg
                run_final_status = "error"
                log_buffer.emit(f"[PIPELINE] ✗ Aborted: {pipeline_name} · {cid_short}")
                _save_state(
                    pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                    start_datetime=run_start_dt, node_states=_build_node_states(),
                )
            else:
                run_final_status = "cancelled"
                _save_state(
                    pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                    start_datetime=run_start_dt, node_states=_build_node_states(),
                )
                log_buffer.emit(f"[PIPELINE] … Stream disconnected: {pipeline_name} · {cid_short}")
            raise
        except Exception as exc:
            err_msg = f"Pipeline execution failed: {exc}"
            execution_error_msg = err_msg
            now_iso = datetime.utcnow().isoformat()
            for s in run_steps:
                if s.get("state") == "running":
                    s["state"] = "failed"
                    s["end_time"] = now_iso
                    s["error_msg"] = err_msg
            run_final_status = "error"
            _save_state(
                pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                start_datetime=run_start_dt, node_states=_build_node_states(),
            )
            log_buffer.emit(f"[PIPELINE] ✗ Fatal: {pipeline_name} · {cid_short} · {exc}")
            try:
                yield _sse("error", {"msg": err_msg})
            except Exception:
                pass

        finally:
            with _ACTIVE_RUN_LOCK:
                _STOP_REQUESTED.pop(run_slot, None)
                cur = _ACTIVE_RUN_TASKS.get(run_slot)
                if cur is asyncio.current_task():
                    _ACTIVE_RUN_TASKS.pop(run_slot, None)

            # On force rerun: delete stale cached results for errored steps so that
            # a page refresh won't show old successful data instead of the error state.
            if req.force:
                try:
                    if _agent_result_has_pipeline_cache:
                        for idx, s in enumerate(run_steps):
                            if s.get("state") == "failed" and s.get("agent_id"):
                                aid = s["agent_id"]
                                stale_stmt = select(AR).where(
                                    AR.agent_id == aid,
                                    AR.sales_agent == req.sales_agent,
                                    AR.customer == req.customer,
                                    AR.pipeline_id == pipeline_id,
                                    AR.pipeline_step_index == idx,
                                )
                                if req.call_id:
                                    stale_stmt = stale_stmt.where(AR.call_id == req.call_id)
                                else:
                                    stale_stmt = stale_stmt.where(AR.call_id == "")
                                fp = s.get("input_fingerprint", "")
                                if fp:
                                    stale_stmt = stale_stmt.where(AR.input_fingerprint == fp)
                                with Session(_db_engine) as _s:
                                    stale_rows = _s.exec(stale_stmt).all()
                                    for stale in stale_rows:
                                        _s.delete(stale)
                                    _s.commit()
                except Exception:
                    pass
            log_lines: list[dict[str, Any]] = []
            try:
                log_lines = [
                    {"ts": l.ts, "text": l.text, "level": l.level}
                    for l in log_buffer.get_after(start_seq)
                ]
                with Session(_db_engine) as _s:
                    _s.execute(
                        _sql_text(
                            "UPDATE pipeline_run SET finished_at = :finished_at, status = :status,"
                            " steps_json = :steps_json, log_json = :log_json WHERE id = :id"
                        ),
                        {
                            "finished_at": datetime.utcnow().isoformat(),
                            "status": run_final_status,
                            "steps_json": json.dumps(run_steps),
                            "log_json": json.dumps(log_lines[-200:]),
                            "id": run_id,
                        },
                    )
                    _s.commit()
            except Exception:
                pass
            try:
                if not execution_error_msg:
                    _step_errors = [
                        str(s.get("error_msg") or "").strip()
                        for s in run_steps
                        if str(s.get("state") or "") == "failed" and str(s.get("error_msg") or "").strip()
                    ]
                    if _step_errors:
                        execution_error_msg = " | ".join(_step_errors[:5])

                _status_counts: dict[str, int] = {"waiting": 0, "running": 0, "completed": 0, "failed": 0}
                _step_summaries: list[dict[str, Any]] = []
                for _idx, _step in enumerate(run_steps):
                    _state = str(_step.get("state") or "waiting")
                    _status_counts[_state] = _status_counts.get(_state, 0) + 1
                    _step_summaries.append(
                        {
                            "step_index": _idx,
                            "agent_id": _step.get("agent_id", ""),
                            "agent_name": _step.get("agent_name", ""),
                            "model": _step.get("model", ""),
                            "state": _state,
                            "start_time": _step.get("start_time"),
                            "end_time": _step.get("end_time"),
                            "execution_time_s": _step.get("execution_time_s"),
                            "cached": bool(_step.get("cached_locations")),
                            "error_msg": _step.get("error_msg", ""),
                        }
                    )

                _exec_status = (
                    "success"
                    if run_final_status == "done"
                    else "cancelled"
                    if run_final_status == "cancelled"
                    else "failed"
                )
                execution_logs.finish_session(
                    execution_session_id,
                    status=_exec_status,
                    report={
                        "pipeline_id": pipeline_id,
                        "pipeline_name": pipeline_name,
                        "run_id": run_id,
                        "run_slot": run_slot,
                        "sales_agent": req.sales_agent,
                        "customer": req.customer,
                        "call_id": req.call_id,
                        "final_status": run_final_status,
                        "steps_total": len(run_steps),
                        "status_counts": _status_counts,
                        "step_summaries": _step_summaries,
                        "log_lines_tail": log_lines[-500:],
                    },
                    error=execution_error_msg,
                )
            except Exception as _elog_err:
                log_buffer.emit(f"[PIPELINE] ⚠ Execution log finalize failed: {_elog_err}")

    # Run the pipeline in a background task that broadcasts SSE payloads to subscribers.
    # This decouples execution from the client HTTP stream so page refresh/navigation
    # does not cancel the run.
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    sub_token = str(uuid.uuid4())

    with _ACTIVE_RUN_LOCK:
        old_ev = _STOP_REQUESTED.get(run_slot)
        old_task = _ACTIVE_RUN_TASKS.get(run_slot)
        if old_ev:
            old_ev.set()
        if old_task and not old_task.done():
            old_task.cancel()
        _RUN_SUBSCRIBERS.setdefault(run_slot, []).append((sub_token, q))

    async def _broadcast_worker():
        try:
            async for payload in stream():
                with _ACTIVE_RUN_LOCK:
                    subs = list(_RUN_SUBSCRIBERS.get(run_slot, []))
                for tok, sq in subs:
                    if tok != sub_token:
                        continue
                    try:
                        sq.put_nowait(payload)
                    except Exception:
                        pass
        finally:
            with _ACTIVE_RUN_LOCK:
                subs = list(_RUN_SUBSCRIBERS.get(run_slot, []))
                keep: list[tuple[str, asyncio.Queue]] = []
                mine: list[asyncio.Queue] = []
                for tok, sq in subs:
                    if tok == sub_token:
                        mine.append(sq)
                    else:
                        keep.append((tok, sq))
                if keep:
                    _RUN_SUBSCRIBERS[run_slot] = keep
                else:
                    _RUN_SUBSCRIBERS.pop(run_slot, None)
            for sq in mine:
                try:
                    sq.put_nowait(None)
                except Exception:
                    pass

    worker_task = asyncio.create_task(_broadcast_worker())
    with _ACTIVE_RUN_LOCK:
        _ACTIVE_RUN_TASKS[run_slot] = worker_task

    async def stream_subscriber():
        try:
            while True:
                item = await q.get()
                if item is None:
                    break
                yield item
        except asyncio.CancelledError:
            # Client disconnected; keep background worker running.
            return
        finally:
            with _ACTIVE_RUN_LOCK:
                subs = _RUN_SUBSCRIBERS.get(run_slot, [])
                pair = (sub_token, q)
                if pair in subs:
                    try:
                        subs.remove(pair)
                    except ValueError:
                        pass
                if not subs:
                    _RUN_SUBSCRIBERS.pop(run_slot, None)

    return StreamingResponse(
        stream_subscriber(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
