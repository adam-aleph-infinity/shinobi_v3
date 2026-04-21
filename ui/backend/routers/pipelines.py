"""Pipelines — ordered chains of universal agents."""
import asyncio
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
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.services import log_buffer

router = APIRouter(prefix="/pipelines", tags=["pipelines"])

_DIR = settings.ui_data_dir / "_pipelines"


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


@router.get("/{pipeline_id}/results")
def get_pipeline_results(
    pipeline_id: str,
    sales_agent: str = "",
    customer: str = "",
    call_id: str = "",
    db: Session = Depends(get_session),
):
    """Return the latest cached AgentResult for each pipeline step."""
    from ui.backend.models.agent_result import AgentResult as AR

    _, pipeline_def = _find_file(pipeline_id)
    steps = pipeline_def.get("steps", [])

    out = []
    for step in steps:
        agent_id = step.get("agent_id", "")
        stmt = select(AR).where(
            AR.agent_id == agent_id,
            AR.sales_agent == sales_agent,
            AR.customer == customer,
        )
        if call_id:
            stmt = stmt.where(AR.call_id == call_id)
        stmt = stmt.order_by(AR.created_at.desc())
        cached = db.exec(stmt).first()
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
        run_steps = [
            {
                "agent_id": s.get("agent_id", ""),
                "agent_name": "",
                "model": "",
                "status": "pending",
                "content": "",
                "error_msg": "",
                "execution_time_s": None,
                "input_token_est": 0,
                "output_token_est": 0,
                "thinking": "",
                "input_sources": [],
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

        run_final_status = "error"
        loop = asyncio.get_event_loop()
        prev_content = ""

        def save_steps():
            """Persist current step states to DB so the frontend can restore live state on refresh."""
            try:
                run_record.steps_json = json.dumps(run_steps)
                db.add(run_record)
                db.commit()
            except Exception:
                pass

        try:
            log_buffer.emit(f"[PIPELINE] ▶ {pipeline_name} ({len(steps)} steps) · {cid_short}")
            yield _sse("pipeline_start", {"total": len(steps), "name": pipeline_name, "run_id": run_id})

            for step_idx, step in enumerate(steps):
                agent_id  = step.get("agent_id", "")
                overrides = step.get("input_overrides", {})
                agent_def = agent_map.get(agent_id)

                if not agent_def:
                    run_steps[step_idx]["status"] = "error"
                    run_steps[step_idx]["error_msg"] = f"Agent '{agent_id}' not found"
                    yield _sse("error", {"msg": f"Step {step_idx + 1}: agent '{agent_id}' not found", "step": step_idx})
                    save_steps()
                    return

                agent_name = agent_def.get("name", agent_id)
                model      = agent_def.get("model", "gpt-5.4")

                run_steps[step_idx]["agent_name"] = agent_name
                run_steps[step_idx]["model"]      = model

                log_buffer.emit(f"[PIPELINE] Step {step_idx + 1}/{len(steps)}: {agent_name} · {cid_short}")
                yield _sse("step_start", {
                    "step": step_idx, "total": len(steps),
                    "agent_id": agent_id, "agent_name": agent_name, "model": model,
                })

                # ── Capture input source declarations ────────────────────────
                input_sources = [
                    {"key": inp.get("key", ""), "source": overrides.get(inp.get("key", ""), inp.get("source", "manual"))}
                    for inp in agent_def.get("inputs", [])
                ]
                run_steps[step_idx]["input_sources"] = input_sources

                # ── Check cache ──────────────────────────────────────────────
                if not req.force:
                    stmt = select(AR).where(
                        AR.agent_id == agent_id,
                        AR.sales_agent == req.sales_agent,
                        AR.customer == req.customer,
                    )
                    if req.call_id:
                        stmt = stmt.where(AR.call_id == req.call_id)
                    stmt = stmt.order_by(AR.created_at.desc())
                    cached = db.exec(stmt).first()

                    if cached:
                        prev_content = cached.content
                        run_steps[step_idx].update({
                            "status": "cached",
                            "content": cached.content,
                        })
                        yield _sse("step_cached", {
                            "step": step_idx, "agent_name": agent_name,
                            "result_id": cached.id, "content": cached.content,
                        })
                        save_steps()
                        continue

                # ── Resolve inputs ───────────────────────────────────────────
                temperature   = float(agent_def.get("temperature", 0.0))
                system_prompt = agent_def.get("system_prompt", "")
                user_template = agent_def.get("user_prompt", "")
                manual_inputs = {"_chain_previous": prev_content}

                db._agent_run_ctx = {
                    "sales_agent": req.sales_agent,
                    "customer":    req.customer,
                    "call_id":     req.call_id,
                    "source_for_key": {
                        inp.get("key", ""): overrides.get(inp.get("key", ""), inp.get("source", ""))
                        for inp in agent_def.get("inputs", [])
                    },
                }

                resolved: dict[str, str] = {}
                for inp in agent_def.get("inputs", []):
                    key    = inp.get("key", "input")
                    source = overrides.get(key, inp.get("source", "manual"))
                    ref_id = inp.get("agent_id")
                    try:
                        text = await loop.run_in_executor(
                            None,
                            lambda s=source, a=ref_id: _resolve_input(
                                s, a, req.sales_agent, req.customer, req.call_id,
                                manual_inputs, db,
                            ),
                        )
                        resolved[key] = text
                    except Exception as exc:
                        run_steps[step_idx].update({"status": "error", "error_msg": str(exc)})
                        yield _sse("error", {"msg": str(exc), "step": step_idx})
                        save_steps()
                        return

                file_keys = {
                    inp.get("key", "")
                    for inp in agent_def.get("inputs", [])
                    if overrides.get(inp.get("key", ""), inp.get("source", "manual")) in _FILE_SOURCES
                }
                file_inputs   = {k: v for k, v in resolved.items() if k in file_keys}
                inline_inputs = {k: v for k, v in resolved.items() if k not in file_keys}

                # ── Call LLM ─────────────────────────────────────────────────
                # Grok pastes files inline; all other providers use file references
                total_chars = sum(len(v) for v in inline_inputs.values())
                if model.startswith("grok"):
                    total_chars += sum(len(v) for v in file_inputs.values())
                input_tok_est  = (total_chars + len(system_prompt)) // 4
                log_buffer.emit(f"[LLM] {model} — {total_chars:,} chars input · {cid_short}")

                step_start_t = time.time()

                if model.startswith("claude-"):
                    q: _queue.Queue = _queue.Queue()
                    result_holder: list = []
                    error_holder:  list = []

                    def _do(fi=file_inputs, ii=inline_inputs, m=model, sp=system_prompt, ut=user_template):
                        try:
                            c, t = _llm_call_anthropic_files_streaming(
                                sp, ut, fi, ii, m, db,
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
                        run_steps[step_idx].update({"status": "error", "error_msg": error_holder[0]})
                        yield _sse("error", {"msg": error_holder[0], "step": step_idx})
                        save_steps()
                        return

                    content, thinking = result_holder[0]
                else:
                    try:
                        content, thinking = await loop.run_in_executor(
                            None,
                            lambda: _llm_call_with_files(
                                system_prompt, user_template,
                                file_inputs, inline_inputs,
                                model, temperature, db,
                            ),
                        )
                    except Exception as exc:
                        run_steps[step_idx].update({"status": "error", "error_msg": str(exc)})
                        yield _sse("error", {"msg": str(exc), "step": step_idx})
                        save_steps()
                        return

                exec_time_s    = round(time.time() - step_start_t, 1)
                output_tok_est = len(content) // 4

                # ── Persist AgentResult ───────────────────────────────────────
                result_id = str(uuid.uuid4())
                record = AR(
                    id=result_id,
                    agent_id=agent_id,
                    agent_name=agent_name,
                    sales_agent=req.sales_agent,
                    customer=req.customer,
                    call_id=req.call_id,
                    content=content,
                    model=model,
                )
                db.add(record)
                db.commit()

                prev_content = content
                run_steps[step_idx].update({
                    "status":           "done",
                    "content":          content,
                    "execution_time_s": exec_time_s,
                    "input_token_est":  input_tok_est,
                    "output_token_est": output_tok_est,
                    "thinking":         (thinking or "")[:8000],
                })

                log_buffer.emit(f"[LLM] {model} — done ({len(content):,} chars, {exec_time_s}s) · {cid_short}")

                if thinking:
                    yield _sse("thinking", {"content": thinking[:5000], "step": step_idx})

                log_buffer.emit(f"[PIPELINE] ✓ Step {step_idx + 1}: {agent_name} · {cid_short}")
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
                save_steps()

            run_final_status = "done"
            log_buffer.emit(f"[PIPELINE] ✅ Done: {pipeline_name} · {cid_short}")
            yield _sse("pipeline_done", {})

        finally:
            # On force rerun: delete stale cached results for errored steps so that
            # a page refresh won't show old successful data instead of the error state.
            if req.force:
                try:
                    for s in run_steps:
                        if s.get("status") == "error" and s.get("agent_id"):
                            aid = s["agent_id"]
                            stale_stmt = select(AR).where(
                                AR.agent_id == aid,
                                AR.sales_agent == req.sales_agent,
                                AR.customer == req.customer,
                            )
                            if req.call_id:
                                stale_stmt = stale_stmt.where(AR.call_id == req.call_id)
                            stale = db.exec(stale_stmt).first()
                            if stale:
                                db.delete(stale)
                    db.commit()
                except Exception:
                    pass
            try:
                try:
                    db.rollback()  # clear any dirty session state from earlier save_steps() commits
                except Exception:
                    pass
                log_lines = [
                    {"ts": l.ts, "text": l.text, "level": l.level}
                    for l in log_buffer.get_after(start_seq)
                ]
                run_record.finished_at = datetime.utcnow()
                run_record.status      = run_final_status
                run_record.steps_json  = json.dumps(run_steps)
                run_record.log_json    = json.dumps(log_lines[-200:])
                db.add(run_record)
                db.commit()
            except Exception:
                pass

    return StreamingResponse(stream(), media_type="text/event-stream")
