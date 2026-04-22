"""Pipelines — ordered chains of universal agents."""
import asyncio
import hashlib
import json
import queue as _queue
import threading
import time
import uuid
from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy import text as _sql_text
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session, engine as _db_engine
from ui.backend.services import log_buffer

router = APIRouter(prefix="/pipelines", tags=["pipelines"])

_DIR = settings.ui_data_dir / "_pipelines"
_STATE_DIR = settings.ui_data_dir / "_pipeline_states"


def _pair_key(pipeline_id: str, sales_agent: str, customer: str) -> str:
    """Deterministic filename key for a pipeline+pair state file.
    Uses an MD5 hash of the raw pair strings so the filename is stable and
    never affected by URL-encoding, case, or whitespace differences."""
    pair_hash = hashlib.md5(f"{sales_agent}::{customer}".encode("utf-8")).hexdigest()[:10]
    return f"{pipeline_id}_{pair_hash}"


def _save_state(pipeline_id: str, run_id: str, sales_agent: str, customer: str,
                status: str, steps: list, force: bool = False,
                start_datetime: str = "") -> None:
    """Write live run state to a JSON file keyed by pipeline+pair hash.
    Called from save_steps() (status='running') and on normal completion/error.
    NOT called from finally — so interrupted runs stay 'running' and the
    frontend shows orange rather than red on refresh.

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
        path.write_text(
            json.dumps({
                "pipeline_id":    pipeline_id,
                "run_id":         run_id,
                "sales_agent":    sales_agent,
                "customer":       customer,
                "status":         status,
                "start_datetime": start_datetime,
                "updated_at":     datetime.utcnow().isoformat(),
                "steps":          steps,
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

def _load_all() -> list[dict]:
    _DIR.mkdir(parents=True, exist_ok=True)
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            out.append(json.loads(f.read_text(encoding="utf-8")))
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


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
def list_pipelines():
    return _load_all()


@router.post("")
def create_pipeline(req: PipelineIn):
    _validate_pipeline_payload(req)
    _DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.utcnow().isoformat()
    record = {"id": str(uuid.uuid4()), "created_at": now, "updated_at": now, **req.model_dump()}
    (_DIR / f"{record['id']}.json").write_text(
        json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return record


@router.get("/{pipeline_id}")
def get_pipeline(pipeline_id: str):
    _, data = _find_file(pipeline_id)
    return data


@router.put("/{pipeline_id}")
def update_pipeline(pipeline_id: str, req: PipelineIn):
    _validate_pipeline_payload(req)
    f, data = _find_file(pipeline_id)
    data.update({**req.model_dump(), "updated_at": datetime.utcnow().isoformat()})
    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    return data


@router.delete("/{pipeline_id}")
def delete_pipeline(pipeline_id: str):
    f, _ = _find_file(pipeline_id)
    f.unlink()
    return {"ok": True}


class PipelineRunRequest(BaseModel):
    sales_agent: str = ""
    customer: str = ""
    call_id: str = ""
    force: bool = False
    force_step_indices: list[int] = []  # bypass cache for specific steps even when force=False


@router.get("/{pipeline_id}/results")
def get_pipeline_results(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_id: Optional[str] = Query(None),
    db: Session = Depends(get_session),
):
    """Return the latest cached AgentResult for each pipeline step."""
    from ui.backend.models.agent_result import AgentResult as AR

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])

    out = []
    for idx, step in enumerate(steps):
        agent_id = step.get("agent_id", "")
        stmt = select(AR).where(
            AR.agent_id == agent_id,
            AR.sales_agent == sales_agent,
            AR.customer == customer,
            AR.pipeline_id == pipeline_id,
            AR.pipeline_step_index == idx,
        )
        if call_id is not None:
            stmt = stmt.where(AR.call_id == call_id)
        stmt = stmt.order_by(AR.created_at.desc())
        cached = db.exec(stmt).first()
        if not cached:
            # Legacy fallback for pre-v4 records without pipeline dimensions
            stmt2 = select(AR).where(
                AR.agent_id == agent_id,
                AR.sales_agent == sales_agent,
                AR.customer == customer,
            )
            if call_id is not None:
                stmt2 = stmt2.where(AR.call_id == call_id)
            stmt2 = stmt2.order_by(AR.created_at.desc())
            cached = db.exec(stmt2).first()
        out.append({
            "agent_id": agent_id,
            "result": {
                "id": cached.id,
                "content": cached.content,
                "agent_name": cached.agent_name,
                "created_at": cached.created_at.isoformat() if cached.created_at else None,
            } if cached else None,
        })
    return out


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
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


@router.post("/{pipeline_id}/run")
async def run_pipeline(
    pipeline_id: str, req: PipelineRunRequest, db: Session = Depends(get_session)
):
    """Execute a pipeline step-by-step, streaming SSE events."""
    from ui.backend.models.agent_result import AgentResult as AR
    from ui.backend.models.pipeline_run import PipelineRun as PR
    from ui.backend.routers.universal_agents import (
        _sse, _FILE_SOURCES, _resolve_input,
        _llm_call_with_files, _llm_call_anthropic_files_streaming,
        _load_all as _load_agents,
    )

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])
    agent_map: dict[str, dict] = {a["id"]: a for a in _load_agents()}

    async def stream():
        pipeline_name = pipeline_def.get("name", "pipeline")
        cid_short = f"…{req.call_id[-8:]}" if req.call_id else "pair"

        # ── Create history run record ────────────────────────────────────────
        recent = log_buffer.get_recent(1)
        start_seq = recent[-1].seq if recent else 0

        run_id = str(uuid.uuid4())
        run_start_dt = datetime.utcnow().isoformat()
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
        db.add(run_record)
        db.commit()
        # Write initial state file (all steps waiting) so frontend can find it immediately.
        # force=True so a new run always claims the file even if an old run still owns it.
        _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                    force=True, start_datetime=run_start_dt)

        run_final_status = "error"
        loop = asyncio.get_event_loop()
        prev_content = ""
        LLM_TIMEOUT_S = 180.0

        def save_steps():
            """Persist current step states — writes both the DB and the live state file.
            Always written with status='running'; the state file is only promoted to
            'done'/'error' after the main loop finishes (never in the finally block,
            so interrupted runs stay 'running' for clean frontend restore)."""
            try:
                with Session(_db_engine) as _s:
                    _s.execute(
                        _sql_text("UPDATE pipeline_run SET steps_json = :steps_json WHERE id = :id"),
                        {"steps_json": json.dumps(run_steps), "id": run_id},
                    )
                    _s.commit()
            except Exception:
                pass
            _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "running", run_steps,
                        start_datetime=run_start_dt)

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

        try:
            log_buffer.emit(f"[PIPELINE] ▶ {pipeline_name} ({len(steps)} steps) · {cid_short}")
            yield _sse("pipeline_start", {"total": len(steps), "name": pipeline_name, "run_id": run_id})

            fatal_error = False

            for _canvas_stage, step_indices in _ordered_stages:
                if fatal_error:
                    break

                # ── Single-step stage (streaming ok) ─────────────────────────
                if len(step_indices) == 1:
                    step_idx  = step_indices[0]
                    step      = steps[step_idx]
                    agent_id  = step.get("agent_id", "")
                    overrides = step.get("input_overrides", {})
                    agent_def = agent_map.get(agent_id)

                    if not agent_def:
                        run_steps[step_idx]["state"]    = "failed"
                        run_steps[step_idx]["end_time"] = datetime.utcnow().isoformat()
                        run_steps[step_idx]["error_msg"] = f"Agent '{agent_id}' not found"
                        yield _sse("error", {"msg": f"Step {step_idx + 1}: agent '{agent_id}' not found", "step": step_idx})
                        save_steps()
                        fatal_error = True
                        break

                    agent_name = agent_def.get("name", agent_id)
                    model      = agent_def.get("model", "gpt-5.4")

                    run_steps[step_idx]["agent_name"] = agent_name
                    run_steps[step_idx]["model"]      = model
                    run_steps[step_idx]["state"]      = "running"
                    run_steps[step_idx]["start_time"] = datetime.utcnow().isoformat()
                    save_steps()  # persist "running" so mid-run refresh shows orange

                    log_buffer.emit(f"[PIPELINE] ▶ Step {step_idx + 1}/{len(steps)}: {agent_name} [{model}] · {cid_short}")
                    yield _sse("step_start", {
                        "step": step_idx, "total": len(steps),
                        "agent_id": agent_id, "agent_name": agent_name, "model": model,
                    })

                    # ── Capture input source declarations ────────────────────
                    run_steps[step_idx]["input_sources"] = [
                        {"key": inp.get("key", ""), "source": overrides.get(inp.get("key", ""), inp.get("source", "manual"))}
                        for inp in agent_def.get("inputs", [])
                    ]

                    # ── Resolve inputs ───────────────────────────────────────
                    temperature   = float(agent_def.get("temperature", 0.0))
                    system_prompt = agent_def.get("system_prompt", "")
                    user_template = agent_def.get("user_prompt", "")
                    manual_inputs = {"_chain_previous": prev_content}
                    source_for_key = {
                        inp.get("key", ""): overrides.get(inp.get("key", ""), inp.get("source", ""))
                        for inp in agent_def.get("inputs", [])
                    }

                    resolved: dict[str, str] = {}
                    resolve_err = False
                    def _resolve_input_worker(_source: str, _ref_id: Optional[str], _manual_inputs: dict[str, str]) -> str:
                        with Session(_db_engine) as _ldb:
                            return _resolve_input(
                                _source, _ref_id, req.sales_agent, req.customer, req.call_id,
                                _manual_inputs, _ldb,
                            )
                    for inp in agent_def.get("inputs", []):
                        key    = inp.get("key", "input")
                        source = overrides.get(key, inp.get("source", "manual"))
                        ref_id = inp.get("agent_id")
                        try:
                            text = await loop.run_in_executor(
                                None,
                                lambda s=source, a=ref_id, m=manual_inputs: _resolve_input_worker(s, a, m),
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

                    file_keys = {
                        inp.get("key", "")
                        for inp in agent_def.get("inputs", [])
                        if overrides.get(inp.get("key", ""), inp.get("source", "manual")) in _FILE_SOURCES
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
                        stmt = select(AR).where(
                            AR.agent_id == agent_id,
                            AR.sales_agent == req.sales_agent,
                            AR.customer == req.customer,
                            AR.pipeline_id == pipeline_id,
                            AR.pipeline_step_index == step_idx,
                            AR.input_fingerprint == input_fingerprint,
                        )
                        if req.call_id:
                            stmt = stmt.where(AR.call_id == req.call_id)
                        else:
                            stmt = stmt.where(AR.call_id == "")
                        stmt = stmt.order_by(AR.created_at.desc())
                        cached = db.exec(stmt).first()

                        if cached:
                            prev_content = cached.content
                            run_steps[step_idx].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          cached.content,
                                "cached_locations": [{"type": "agent_result", "id": cached.id, "created_at": cached.created_at.isoformat() if cached.created_at else None}],
                            })
                            save_steps()  # write state BEFORE yield so file is correct if client disconnects
                            log_buffer.emit(f"[PIPELINE] ↩ Step {step_idx + 1}/{len(steps)}: {agent_name} → cached · {cid_short}")
                            yield _sse("step_cached", {
                                "step": step_idx, "agent_name": agent_name,
                                "result_id": cached.id, "content": cached.content,
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
                            _deadline = time.monotonic() + LLM_TIMEOUT_S
                            _next_heartbeat = time.monotonic() + 10.0
                            while True:
                                _remaining = _deadline - time.monotonic()
                                if _remaining <= 0:
                                    raise asyncio.TimeoutError
                                done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                                if done_set:
                                    content, thinking = _future.result()
                                    break
                                if time.monotonic() >= _next_heartbeat:
                                    waited_s = int(LLM_TIMEOUT_S - _remaining)
                                    _next_heartbeat = time.monotonic() + 10.0
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
                    result_id = str(uuid.uuid4())
                    db.add(AR(
                        id=result_id,
                        agent_id=agent_id,
                        agent_name=agent_name,
                        sales_agent=req.sales_agent,
                        customer=req.customer,
                        call_id=req.call_id,
                        pipeline_id=pipeline_id,
                        pipeline_step_index=step_idx,
                        input_fingerprint=input_fingerprint,
                        content=content,
                        model=model,
                    ))
                    db.commit()

                    prev_content = content
                    run_steps[step_idx].update({
                        "state":            "completed",
                        "end_time":         datetime.utcnow().isoformat(),
                        "content":          content,
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
                        _ov = _s.get("input_overrides", {})
                        _adef = agent_map[_aid]
                        _aname = _adef.get("name", _aid)
                        _model = _adef.get("model", "gpt-5.4")
                        run_steps[_sidx]["agent_name"] = _aname
                        run_steps[_sidx]["model"]      = _model
                        run_steps[_sidx]["input_sources"] = [
                            {"key": inp.get("key", ""), "source": _ov.get(inp.get("key", ""), inp.get("source", "manual"))}
                            for inp in _adef.get("inputs", [])
                        ]
                        run_steps[_sidx]["state"]      = "running"
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
                        try:
                            with Session(_db_engine) as _par_db:
                                _source_for_key = {
                                    inp.get("key", ""): _par_ov.get(inp.get("key", ""), inp.get("source", ""))
                                    for inp in _par_adef.get("inputs", [])
                                }
                                _par_db._agent_run_ctx = {
                                    "sales_agent": req.sales_agent,
                                    "customer": req.customer,
                                    "call_id": req.call_id,
                                    "source_for_key": _source_for_key,
                                }

                                _par_resolved: dict[str, str] = {}
                                for _inp in _par_adef.get("inputs", []):
                                    _k   = _inp.get("key", "input")
                                    _src = _par_ov.get(_k, _inp.get("source", "manual"))
                                    _rid = _inp.get("agent_id")
                                    _par_resolved[_k] = _resolve_input(
                                        _src, _rid, req.sales_agent, req.customer, req.call_id, _par_mi, _par_db,
                                    )

                                _par_fkeys = {
                                    _inp.get("key", "")
                                    for _inp in _par_adef.get("inputs", [])
                                    if _par_ov.get(_inp.get("key", ""), _inp.get("source", "manual")) in _FILE_SOURCES
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
                                    _cs = select(AR).where(
                                        AR.agent_id == _par_aid,
                                        AR.sales_agent == req.sales_agent,
                                        AR.customer == req.customer,
                                        AR.pipeline_id == pipeline_id,
                                        AR.pipeline_step_index == par_idx,
                                        AR.input_fingerprint == _par_fp,
                                    )
                                    if req.call_id:
                                        _cs = _cs.where(AR.call_id == req.call_id)
                                    else:
                                        _cs = _cs.where(AR.call_id == "")
                                    _cs = _cs.order_by(AR.created_at.desc())
                                    _cached = _par_db.exec(_cs).first()
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

                                _par_rid = str(uuid.uuid4())
                                _par_db.add(AR(
                                    id=_par_rid,
                                    agent_id=_par_aid,
                                    agent_name=_par_aname,
                                    sales_agent=req.sales_agent,
                                    customer=req.customer,
                                    call_id=req.call_id,
                                    pipeline_id=pipeline_id,
                                    pipeline_step_index=par_idx,
                                    input_fingerprint=_par_fp,
                                    content=_par_content,
                                    model=_par_model,
                                ))
                                _par_db.commit()

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
                                }
                        except Exception as exc:
                            return {
                                "step_idx": par_idx,
                                "status": "error",
                                "error_msg": str(exc),
                                "agent_name": _par_aname,
                                "model": _par_model,
                                "input_fingerprint": _par_fp,
                            }

                    async def _run_parallel_step(par_idx: int, _sp: str = _stage_prev) -> dict:
                        _par_step = steps[par_idx]
                        _par_aid = _par_step.get("agent_id", "")
                        _par_adef = agent_map[_par_aid]
                        _par_aname = _par_adef.get("name", _par_aid)
                        _par_model = _par_adef.get("model", "gpt-5.4")
                        _future = loop.run_in_executor(None, lambda: _run_parallel_step_sync(par_idx, _sp))
                        _deadline = time.monotonic() + LLM_TIMEOUT_S
                        _next_heartbeat = time.monotonic() + 10.0
                        while True:
                            _remaining = _deadline - time.monotonic()
                            if _remaining <= 0:
                                return {
                                    "step_idx": par_idx,
                                    "status": "error",
                                    "error_msg": f"LLM call timed out after {int(LLM_TIMEOUT_S)}s (model: {_par_model})",
                                    "agent_name": _par_aname,
                                    "model": _par_model,
                                }
                            done_set, _ = await asyncio.wait({_future}, timeout=min(2.0, _remaining))
                            if done_set:
                                return _future.result()
                            if time.monotonic() >= _next_heartbeat:
                                waited_s = int(LLM_TIMEOUT_S - _remaining)
                                _next_heartbeat = time.monotonic() + 10.0
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
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _res["content"],
                                "cached_locations": [{
                                    "type": "agent_result",
                                    "id": _res.get("result_id", ""),
                                    "created_at": _res.get("cached_created_at"),
                                }],
                                "input_fingerprint": _res.get("input_fingerprint", ""),
                            })
                            save_steps()  # write BEFORE yield so file is correct if client disconnects
                            log_buffer.emit(f"[PIPELINE] ↩ Step {_ri + 1}/{len(steps)}: {_rn} → cached · {cid_short}")
                            yield _sse("step_cached", {"step": _ri, "agent_name": _rn,
                                                        "result_id": _res.get("result_id", ""), "content": _res["content"]})
                        elif _rst == "done":
                            _rc  = _res["content"]
                            _ret = _res["exec_time_s"]
                            run_steps[_ri].update({
                                "state":            "completed",
                                "end_time":         datetime.utcnow().isoformat(),
                                "content":          _rc,
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
                            start_datetime=run_start_dt)
                log_buffer.emit(f"[PIPELINE] ✅ Done: {pipeline_name} · {cid_short}")
                yield _sse("pipeline_done", {})
            else:
                # Explicit error (agent failure, resolve error, etc.) — mark file as failed.
                # Note: if the generator is killed mid-stream (client disconnect), this
                # branch is never reached; the file stays "running" from the last save_steps().
                _save_state(pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                            start_datetime=run_start_dt)

        except asyncio.CancelledError:
            cancel_msg = "run cancelled (client disconnected or server interrupted)"
            now_iso = datetime.utcnow().isoformat()
            for s in run_steps:
                if s.get("state") == "running":
                    s["state"] = "failed"
                    s["end_time"] = now_iso
                    s["error_msg"] = cancel_msg
            run_final_status = "error"
            _save_state(
                pipeline_id, run_id, req.sales_agent, req.customer, "failed", run_steps,
                start_datetime=run_start_dt,
            )
            log_buffer.emit(f"[PIPELINE] ✗ Aborted: {pipeline_name} · {cid_short}")
            raise

        finally:
            # On force rerun: delete stale cached results for errored steps so that
            # a page refresh won't show old successful data instead of the error state.
            if req.force:
                try:
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
                            stale_rows = db.exec(stale_stmt).all()
                            for stale in stale_rows:
                                db.delete(stale)
                    db.commit()
                except Exception:
                    pass
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

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
