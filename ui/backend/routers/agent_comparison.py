"""Agent Comparison — quick-run pipeline, merge transcripts/landmarks, upload to xAI, query Grok."""
import json
import os
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests as _requests
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.comparison_file import ComparisonFile

router = APIRouter(prefix="/agent-comparison", tags=["agent-comparison"])

PRESETS_DIR: Path = settings.ui_data_dir / "_comparison_presets"
XAI_BASE = "https://api.x.ai/v1"

# ── In-memory run progress ─────────────────────────────────────────────────────

_quick_run_status: dict[str, dict] = {}


# ── xAI helpers ────────────────────────────────────────────────────────────────

def _get_xai_key() -> str:
    from shared.llm_client import resolve_grok_key
    key = resolve_grok_key()
    if not key:
        raise HTTPException(500, "GROK_API_KEY / XAI_API_KEY not set")
    return key


def _upload_file_to_xai(content: str, filename: str, api_key: str) -> str:
    import tempfile
    headers = {"Authorization": f"Bearer {api_key}"}
    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
        f.write(content)
        tmp_path = f.name
    try:
        with open(tmp_path, "rb") as fb:
            resp = _requests.post(
                f"{XAI_BASE}/files",
                headers=headers,
                files={"file": (filename, fb, "text/plain")},
                data={"purpose": "assistants"},
                timeout=120,
            )
        resp.raise_for_status()
        return resp.json()["id"]
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def _delete_xai_file(file_id: str, api_key: str) -> None:
    try:
        _requests.delete(
            f"{XAI_BASE}/files/{file_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=30,
        )
    except Exception as e:
        print(f"[agent_comparison] Warning: could not delete xAI file {file_id}: {e}")


def _query_grok(file_ids: list[str], system_prompt: str, user_prompt: str, model: str, api_key: str, temperature: float = 0.0) -> str:
    # xAI requires /v1/responses (not /v1/chat/completions) when sending files.
    # File items use "input_file"; text items use "input_text".
    content: list[dict] = [{"type": "input_file", "file_id": fid} for fid in file_ids]
    if user_prompt.strip():
        content.append({"type": "input_text", "text": user_prompt.strip()})

    payload: dict = {
        "model": model,
        "input": [{"role": "user", "content": content}],
        "temperature": temperature,
    }
    if system_prompt.strip():
        payload["instructions"] = system_prompt.strip()

    print("[agent_comparison] Grok /v1/responses request:")
    print(f"  model:       {model}")
    print(f"  file_ids:    {file_ids}")
    print(f"  instructions: {system_prompt.strip()[:200] if system_prompt.strip() else '(none)'}")
    print(f"  user_prompt: {user_prompt.strip()[:500]}")

    resp = _requests.post(
        f"{XAI_BASE}/responses",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=300,
    )
    print(f"[agent_comparison] Grok response status: {resp.status_code}")
    if not resp.ok:
        body = resp.text[:2000]
        print(f"[agent_comparison] Grok error body: {body}")
        try:
            err = resp.json()
            detail = (err.get("error") if isinstance(err.get("error"), str)
                      else err.get("error", {}).get("message") if isinstance(err.get("error"), dict)
                      else body)
        except Exception:
            detail = body
        raise HTTPException(resp.status_code, f"xAI error: {detail}")

    # /v1/responses returns output array of message objects
    data = resp.json()
    try:
        # Standard Responses API shape: output[0].content[0].text
        result = data["output"][0]["content"][0]["text"]
    except (KeyError, IndexError, TypeError):
        # Fallback: look for any output_text item
        for item in data.get("output", []):
            for part in item.get("content", []):
                if part.get("type") == "output_text" and part.get("text"):
                    result = part["text"]
                    break
            else:
                continue
            break
        else:
            raise HTTPException(500, f"Unexpected xAI response shape: {json.dumps(data)[:500]}")

    print(f"[agent_comparison] Grok response: {len(result):,} chars")
    return result


# ── Content builders ───────────────────────────────────────────────────────────

def _call_header(call_id: str, meta: dict) -> str:
    h = f"CALL {call_id}"
    if meta.get("started_at"):
        h += f"  |  {meta['started_at']}"
    if meta.get("duration_s"):
        d = int(meta["duration_s"])
        h += f"  |  {d // 60}m{d % 60:02d}s"
    return h


def _get_net_deposits(agent: str, customer: str) -> Optional[float]:
    """Look up net deposits for an agent/customer pair from the DB."""
    try:
        from sqlalchemy import text as _text
        from ui.backend.database import engine
        from sqlmodel import Session as _S
        with _S(engine) as db:
            rows = db.execute(
                _text("SELECT net_deposits FROM crm_pair WHERE agent=:a AND customer=:c LIMIT 1"),
                {"a": agent, "c": customer},
            ).fetchall()
            if rows and rows[0][0] is not None:
                return float(rows[0][0])
    except Exception as e:
        print(f"[merge] net_deposits lookup: {e}")
    return None


def _build_and_save_merged_transcript(
    agent: str, customer: str, force: bool = True,
) -> Optional[str]:
    """Merge all smoothed.txt files for the pair; save to merged_transcript.txt in the customer folder.

    Includes dates, times and net deposits in the header. Shared by FPA and agent comparison.
    Uses the cached file when force=False and the file already exists.
    """
    pair_dir = settings.agents_dir / agent / customer
    if not pair_dir.exists():
        return None

    merged_path = pair_dir / "merged_transcript.txt"

    # Return cached version unless forced
    if not force and merged_path.exists():
        try:
            content = merged_path.read_text(encoding="utf-8")
            if content.strip():
                return content
        except Exception:
            pass

    calls_meta = _load_calls_meta(pair_dir)
    call_dirs = sorted([d for d in pair_dir.iterdir() if d.is_dir() and not d.name.startswith("_")])

    blocks: list[str] = []
    for call_dir in call_dirs:
        smoothed = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
        if not smoothed.exists():
            continue
        try:
            text = smoothed.read_text(encoding="utf-8").strip()
            header = _call_header(call_dir.name, calls_meta.get(call_dir.name, {}))
            blocks.append(f"{'─' * 60}\n{header}\n{'─' * 60}\n{text}")
        except Exception:
            pass

    if not blocks:
        return None

    net_deposits = _get_net_deposits(agent, customer)
    nd_line = f"Net Deposits: ${net_deposits:,.2f}\n" if net_deposits is not None else ""

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    doc_header = (
        f"{'═' * 60}\n"
        f"MERGED TRANSCRIPTS\n"
        f"Agent:    {agent}\n"
        f"Customer: {customer}\n"
        f"{nd_line}"
        f"Calls:    {len(blocks)}\n"
        f"Generated: {now}\n"
        f"{'═' * 60}\n\n"
    )
    content = doc_header + "\n\n".join(blocks)

    # Always save to the customer folder on disk
    try:
        merged_path.write_text(content, encoding="utf-8")
        print(f"[merge] Saved merged_transcript.txt — {agent}/{customer} ({len(blocks)} calls)")
    except Exception as e:
        print(f"[merge] Save warning: {e}")

    return content


def _build_landmarks_content(agent: str, customer: str) -> Optional[str]:
    """Merge all landmarks.json files for the pair into one formatted text block."""
    pair_dir = settings.agents_dir / agent / customer
    if not pair_dir.exists():
        return None

    calls_meta = _load_calls_meta(pair_dir)
    call_dirs = sorted([d for d in pair_dir.iterdir() if d.is_dir() and not d.name.startswith("_")])

    blocks: list[str] = []
    for call_dir in call_dirs:
        landmarks_path = call_dir / "transcribed" / "llm_final" / "landmarks.json"
        if not landmarks_path.exists():
            continue
        try:
            markers = json.loads(landmarks_path.read_text(encoding="utf-8"))
            if not markers:
                continue
            header = _call_header(call_dir.name, calls_meta.get(call_dir.name, {}))
            lines = [f"{'─' * 60}", header, f"{'─' * 60}"]
            for m in markers:
                ts = m.get("timestamp_label", "")
                emoji = m.get("emoji", "")
                label = m.get("label", "")
                desc = m.get("description", "")
                mtype = m.get("marker_type", "")
                lines.append(f"  [{ts}]  {emoji} [{mtype.upper()}]  {label}  —  {desc}")
            blocks.append("\n".join(lines))
        except Exception:
            pass

    if not blocks:
        return None

    now = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")
    header = (
        f"{'═' * 60}\n"
        f"MERGED LANDMARKS / JOURNEY MARKERS\n"
        f"Agent:    {agent}\n"
        f"Customer: {customer}\n"
        f"Calls:    {len(blocks)}\n"
        f"Generated: {now}\n"
        f"{'═' * 60}\n\n"
    )
    return header + "\n\n".join(blocks)


def _load_calls_meta(pair_dir: Path) -> dict[str, dict]:
    calls_meta: dict[str, dict] = {}
    calls_json = pair_dir / "calls.json"
    if calls_json.exists():
        try:
            for c in json.loads(calls_json.read_text()):
                calls_meta[str(c.get("call_id", ""))] = c
        except Exception:
            pass
    return calls_meta


def _safe_slug(name: str) -> str:
    return re.sub(r"[^\w]", "_", name)


# ── Agents / customers / status ────────────────────────────────────────────────

@router.get("/agents")
def list_agents():
    agents_dir = settings.agents_dir
    if not agents_dir.exists():
        return []
    return sorted([d.name for d in agents_dir.iterdir() if d.is_dir() and not d.name.startswith("_")])


@router.get("/agent-stats")
def agent_stats():
    """Return aggregate transcript/landmark counts for every agent."""
    agents_dir = settings.agents_dir
    if not agents_dir.exists():
        return []

    results = []
    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("_"):
            continue
        agent = agent_dir.name
        customer_dirs = [d for d in agent_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
        total_calls = 0
        total_transcripts = 0
        total_landmarks = 0
        customers_with_data = 0
        for cust_dir in customer_dirs:
            call_dirs = [d for d in cust_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
            for call_dir in call_dirs:
                total_calls += 1
                if (call_dir / "transcribed" / "llm_final" / "smoothed.txt").exists():
                    total_transcripts += 1
                if (call_dir / "transcribed" / "llm_final" / "landmarks.json").exists():
                    total_landmarks += 1
            if any((d / "transcribed" / "llm_final" / "smoothed.txt").exists()
                   for d in call_dirs):
                customers_with_data += 1

        results.append({
            "agent": agent,
            "customers": len(customer_dirs),
            "customers_with_data": customers_with_data,
            "total_calls": total_calls,
            "total_transcripts": total_transcripts,
            "total_landmarks": total_landmarks,
        })
    return results


@router.get("/customer-stats")
def customer_stats(agent: str = Query(...)):
    """Return per-customer transcript/landmark counts for a given agent."""
    agent_dir = settings.agents_dir / agent
    if not agent_dir.exists():
        return []
    results = []
    for cust_dir in sorted(agent_dir.iterdir()):
        if not cust_dir.is_dir() or cust_dir.name.startswith("_"):
            continue
        call_dirs = [d for d in cust_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
        total = len(call_dirs)
        transcripts = sum(1 for d in call_dirs if (d / "transcribed" / "llm_final" / "smoothed.txt").exists())
        landmarks = sum(1 for d in call_dirs if (d / "transcribed" / "llm_final" / "landmarks.json").exists())
        results.append({
            "customer": cust_dir.name,
            "total_calls": total,
            "transcripts": transcripts,
            "landmarks": landmarks,
        })
    return results


@router.get("/customers")
def list_customers(agent: str = Query(...)):
    agent_dir = settings.agents_dir / agent
    if not agent_dir.exists():
        return []
    return sorted([d.name for d in agent_dir.iterdir() if d.is_dir() and not d.name.startswith("_")])


@router.get("/status")
def get_status(agent: str = Query(...), customer: str = Query(...)):
    pair_dir = settings.agents_dir / agent / customer
    if not pair_dir.exists():
        return {"total": 0, "transcripts": 0, "landmarks": 0, "calls": []}

    calls_meta = _load_calls_meta(pair_dir)
    call_dirs = sorted([d for d in pair_dir.iterdir() if d.is_dir() and not d.name.startswith("_")])

    calls_info, transcript_count, landmark_count = [], 0, 0
    for call_dir in call_dirs:
        has_t = (call_dir / "transcribed" / "llm_final" / "smoothed.txt").exists()
        has_l = (call_dir / "transcribed" / "llm_final" / "landmarks.json").exists()
        if has_t:
            transcript_count += 1
        if has_l:
            landmark_count += 1
        meta = calls_meta.get(call_dir.name, {})
        calls_info.append({
            "call_id": call_dir.name,
            "has_transcript": has_t,
            "has_landmarks": has_l,
            "started_at": meta.get("started_at", ""),
            "duration_s": meta.get("duration_s", 0),
        })

    return {"total": len(calls_info), "transcripts": transcript_count, "landmarks": landmark_count, "calls": calls_info}


# ── Prepare (landmark annotation only) ────────────────────────────────────────

class PrepareRequest(BaseModel):
    agent: str
    customer: str
    model: str = "grok-4.20-0309-non-reasoning"
    extra_prompt: str = ""
    force: bool = False


@router.post("/prepare")
def prepare_pair(req: PrepareRequest, background_tasks: BackgroundTasks):
    pair_dir = settings.agents_dir / req.agent / req.customer
    if not pair_dir.exists():
        raise HTTPException(404, "Agent/customer pair not found")

    call_dirs = [d for d in sorted(pair_dir.iterdir()) if d.is_dir() and not d.name.startswith("_")]
    targets = []
    for call_dir in call_dirs:
        smoothed = call_dir / "transcribed" / "llm_final" / "smoothed.txt"
        landmarks = call_dir / "transcribed" / "llm_final" / "landmarks.json"
        if smoothed.exists() and (not landmarks.exists() or req.force):
            targets.append((call_dir.name, smoothed))

    if not targets:
        return {"ok": True, "queued": 0, "msg": "No calls need landmark annotation"}

    run_id = str(uuid.uuid4())[:8]

    def _run_bg():
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from ui.backend.database import engine
        from ui.backend.routers.deep_dive import _annotate_call
        from sqlmodel import Session as _Session

        def _one(item):
            call_id, smoothed = item
            with _Session(engine) as db:
                return _annotate_call(smoothed, req.agent, req.customer, call_id, req.model, run_id, db, req.extra_prompt or None)

        total = 0
        with ThreadPoolExecutor(max_workers=4) as pool:
            for fut in as_completed({pool.submit(_one, t): t for t in targets}):
                try:
                    total += fut.result()
                except Exception as e:
                    print(f"[agent_comparison] prepare worker: {e}")
        print(f"[agent_comparison] prepare {run_id}: {total} markers for {len(targets)} calls")

    background_tasks.add_task(_run_bg)
    return {"ok": True, "run_id": run_id, "queued": len(targets)}


# ── Quick Run (full EL → smooth → landmarks for all selected pairs) ────────────

class QuickRunRequest(BaseModel):
    pairs: list[dict]               # [{agent, customer}]
    smooth_model: str = "gpt-5.4"
    run_landmarks: bool = True
    landmarks_model: str = "grok-4.20-0309-non-reasoning"
    landmarks_prompt: str = ""
    force: bool = False             # re-run EL transcription + smooth
    force_landmarks: bool = False   # re-run landmark annotation


@router.post("/quick-run")
def quick_run_pairs(req: QuickRunRequest, background_tasks: BackgroundTasks):
    run_id = str(uuid.uuid4())[:8]
    _quick_run_status[run_id] = {
        "done": 0,
        "total": len(req.pairs),
        "current": "",
        "errors": [],
        "complete": False,
    }

    def _run():
        from ui.backend.routers.quick import _transcribe_call, _smooth_call, _s3_presigned_url
        from ui.backend.routers.deep_dive import _annotate_call
        from ui.backend.database import engine
        from sqlmodel import Session as _Session

        for pair in req.pairs:
            agent = pair.get("agent", "")
            customer = pair.get("customer", "")
            label = f"{agent} / {customer}"
            _quick_run_status[run_id]["current"] = label

            pair_dir = settings.agents_dir / agent / customer
            if not pair_dir.exists():
                _quick_run_status[run_id]["errors"].append(f"Not found: {label}")
                _quick_run_status[run_id]["done"] += 1
                continue

            manifest_path = pair_dir / "manifest.json"
            crm_url = ""
            if manifest_path.exists():
                try:
                    m = json.loads(manifest_path.read_text())
                    crm_url = m.get("crm", "")
                except Exception:
                    pass

            calls_json_path = pair_dir / "calls.json"
            if not calls_json_path.exists():
                _quick_run_status[run_id]["errors"].append(f"No calls.json: {label}")
                _quick_run_status[run_id]["done"] += 1
                continue

            try:
                calls = json.loads(calls_json_path.read_text())
            except Exception:
                _quick_run_status[run_id]["errors"].append(f"Bad calls.json: {label}")
                _quick_run_status[run_id]["done"] += 1
                continue

            dd_run_id = str(uuid.uuid4())[:8]

            for call in calls:
                call_id = str(call.get("call_id", ""))
                record_path = call.get("record_path", "")
                if not call_id:
                    continue

                call_dir    = pair_dir / call_id
                source_dir  = call_dir / "transcribed" / "source_1"
                el_json     = source_dir / "elevenlabs" / "original.json"
                llm_dir     = call_dir / "transcribed" / "llm_final"
                smoothed    = llm_dir / "smoothed.txt"
                landmarks   = llm_dir / "landmarks.json"

                # Step 1 — EL transcription
                if not el_json.exists() or req.force:
                    if record_path and crm_url:
                        audio_url, err = _s3_presigned_url(crm_url, record_path)
                        if audio_url:
                            try:
                                _transcribe_call(None, source_dir, audio_url=audio_url)
                            except Exception as e:
                                print(f"[quick_run] transcribe {call_id}: {e}")
                                continue
                        else:
                            print(f"[quick_run] presign failed {call_id}: {err}")

                # Step 2 — Smooth
                if el_json.exists() and (not smoothed.exists() or req.force):
                    try:
                        _smooth_call(el_json, agent, customer, call_id, llm_dir, req.smooth_model, call)
                    except Exception as e:
                        print(f"[quick_run] smooth {call_id}: {e}")

                # Step 3 — Landmarks
                if req.run_landmarks and smoothed.exists() and (not landmarks.exists() or req.force_landmarks):
                    try:
                        with _Session(engine) as db:
                            _annotate_call(
                                smoothed, agent, customer, call_id,
                                req.landmarks_model, dd_run_id, db,
                                req.landmarks_prompt or None,
                            )
                    except Exception as e:
                        print(f"[quick_run] landmarks {call_id}: {e}")

            _quick_run_status[run_id]["done"] += 1

        _quick_run_status[run_id]["current"] = ""
        _quick_run_status[run_id]["complete"] = True
        print(f"[quick_run] {run_id} complete — {len(req.pairs)} pairs processed")

    background_tasks.add_task(_run)
    return {"ok": True, "run_id": run_id, "total": len(req.pairs)}


@router.get("/quick-run/status")
def quick_run_status(run_id: str = Query(...)):
    status = _quick_run_status.get(run_id)
    if not status:
        raise HTTPException(404, "Run ID not found")
    return status


# ── Upload (two files per pair: transcript + landmarks) ────────────────────────

class UploadRequest(BaseModel):
    agent: str
    customer: str
    force: bool = False


@router.post("/upload")
def upload_pair(req: UploadRequest, db: Session = Depends(get_session)):
    try:
        api_key = _get_xai_key()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))
    safe_a = _safe_slug(req.agent)
    safe_c = _safe_slug(req.customer)

    # Delete existing records for this pair (and their xAI files) if force
    existing = db.exec(
        select(ComparisonFile).where(
            ComparisonFile.agent == req.agent,
            ComparisonFile.customer == req.customer,
        )
    ).all()

    if existing and not req.force:
        # Return what we have
        result = {"ok": True, "cached": True}
        for r in existing:
            result[r.file_type] = {"xai_file_id": r.xai_file_id, "filename": r.filename}
        return result

    if existing:
        for r in existing:
            _delete_xai_file(r.xai_file_id, api_key)
            db.delete(r)
        db.commit()

    now = datetime.utcnow().isoformat()
    result: dict = {"ok": True, "cached": False}

    # Upload transcript file (rebuild when force, else use cached merged_transcript.txt)
    transcript_content = _build_and_save_merged_transcript(req.agent, req.customer, force=req.force)
    if transcript_content:
        filename_t = f"{safe_a}__{safe_c}__transcripts.txt"
        xai_id_t = _upload_file_to_xai(transcript_content, filename_t, api_key)
        db.add(ComparisonFile(
            id=str(uuid.uuid4()),
            agent=req.agent,
            customer=req.customer,
            file_type="transcript",
            xai_file_id=xai_id_t,
            filename=filename_t,
            uploaded_at=now,
        ))
        result["transcript"] = {"xai_file_id": xai_id_t, "filename": filename_t}

    # Upload landmarks file
    landmarks_content = _build_landmarks_content(req.agent, req.customer)
    if landmarks_content:
        filename_l = f"{safe_a}__{safe_c}__landmarks.txt"
        xai_id_l = _upload_file_to_xai(landmarks_content, filename_l, api_key)
        db.add(ComparisonFile(
            id=str(uuid.uuid4()),
            agent=req.agent,
            customer=req.customer,
            file_type="landmarks",
            xai_file_id=xai_id_l,
            filename=filename_l,
            uploaded_at=now,
        ))
        result["landmarks"] = {"xai_file_id": xai_id_l, "filename": filename_l}

    if not transcript_content and not landmarks_content:
        raise HTTPException(400, "No transcript or landmark data found for this pair")

    db.commit()
    return result


# ── Files (stored IDs) ─────────────────────────────────────────────────────────

@router.get("/files")
def list_files(db: Session = Depends(get_session)):
    rows = db.exec(select(ComparisonFile)).all()
    # Group by (agent, customer)
    grouped: dict[str, dict] = {}
    for r in rows:
        key = f"{r.agent}||{r.customer}"
        if key not in grouped:
            grouped[key] = {"agent": r.agent, "customer": r.customer}
        grouped[key][r.file_type] = {
            "xai_file_id": r.xai_file_id,
            "filename": r.filename,
            "uploaded_at": r.uploaded_at,
        }
    return list(grouped.values())


@router.delete("/files")
def delete_file(
    agent: str = Query(...),
    customer: str = Query(...),
    db: Session = Depends(get_session),
):
    rows = db.exec(
        select(ComparisonFile).where(
            ComparisonFile.agent == agent,
            ComparisonFile.customer == customer,
        )
    ).all()
    if not rows:
        raise HTTPException(404, "No uploaded files for this pair")
    try:
        api_key = _get_xai_key()
        for r in rows:
            _delete_xai_file(r.xai_file_id, api_key)
    except Exception:
        pass
    for r in rows:
        db.delete(r)
    db.commit()
    return {"ok": True, "deleted": len(rows)}


# ── Query ──────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    pairs: list[dict]       # [{agent, customer}]
    system_prompt: str = ""
    user_prompt: str
    model: str = "grok-4.20-0309-reasoning"
    temperature: float = 0.0


@router.post("/query")
def query_comparison(req: QueryRequest, db: Session = Depends(get_session)):
    if not req.user_prompt.strip():
        raise HTTPException(400, "user_prompt is required")

    api_key = _get_xai_key()
    file_ids: list[str] = []
    missing: list[str] = []

    for pair in req.pairs:
        agent = pair.get("agent", "")
        customer = pair.get("customer", "")
        rows = db.exec(
            select(ComparisonFile).where(
                ComparisonFile.agent == agent,
                ComparisonFile.customer == customer,
            )
        ).all()
        if rows:
            # Add both transcript and landmarks files, transcripts first
            for ft in ("transcript", "landmarks"):
                for r in rows:
                    if r.file_type == ft:
                        file_ids.append(r.xai_file_id)
        else:
            missing.append(f"{agent} / {customer}")

    if missing:
        raise HTTPException(400, f"Files not uploaded for: {', '.join(missing)}")
    if not file_ids:
        raise HTTPException(400, "No files found for selected pairs")

    response = _query_grok(file_ids, req.system_prompt, req.user_prompt, req.model, api_key, req.temperature)
    return {"ok": True, "response": response}


# ── Reformat ──────────────────────────────────────────────────────────────────

REFORMAT_SYSTEM = """You are a markdown formatting specialist.
The user will give you a text response from an AI. Your job is to reformat it into clean, well-structured GitHub-flavored Markdown that renders beautifully.

Rules:
- Preserve ALL information — do not summarise, cut, or change any facts or wording.
- Use ## for main sections, ### for sub-sections.
- Convert any comparison data into proper markdown tables with aligned columns.
- Use **bold** for key terms, metrics, and agent names.
- Use bullet lists (- ) for items, numbered lists only for sequential steps.
- Add a horizontal rule (---) between major sections.
- For tables: always include a header row and separator row (| --- |).
- Keep tables compact — split very wide tables into multiple smaller ones if needed.
- Do not add any commentary, preamble, or explanation — output ONLY the reformatted markdown."""


class ReformatRequest(BaseModel):
    text: str
    model: str = "gpt-4.1"


@router.post("/reformat")
def reformat_response(req: ReformatRequest):
    if not req.text.strip():
        raise HTTPException(400, "text is required")
    try:
        from ui.backend.routers.final_transcript import _llm_call
        result = _llm_call(REFORMAT_SYSTEM, req.text.strip(), req.model)
        return {"ok": True, "result": result}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Reformat failed: {e}")


# ── Presets ────────────────────────────────────────────────────────────────────

class ComparisonPresetIn(BaseModel):
    name: str
    model: str = "grok-4.20-0309-reasoning"
    system_prompt: str = ""
    user_prompt: str = ""
    temperature: float = 0.0
    is_default: bool = False


def _slug(name: str) -> str:
    slug = re.sub(r"[^\w\s\-.]", "_", name.strip())
    slug = re.sub(r"\s+", "_", slug).strip("_")
    return slug or "preset"


def _all_presets() -> list[dict]:
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    for f in sorted(PRESETS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            results.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    results.sort(key=lambda x: (0 if x.get("is_default") else 1))
    return results


@router.get("/presets")
def list_presets():
    return _all_presets()


@router.post("/presets")
def save_preset(req: ComparisonPresetIn):
    if not req.name.strip():
        raise HTTPException(400, "Name is required")
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)

    for existing in PRESETS_DIR.glob("*.json"):
        try:
            data = json.loads(existing.read_text(encoding="utf-8"))
            if data.get("name") == req.name.strip():
                existing.unlink()
                break
        except Exception:
            pass

    path = PRESETS_DIR / (_slug(req.name.strip()) + ".json")
    if path.exists():
        path = PRESETS_DIR / f"{_slug(req.name.strip())}_{uuid.uuid4().hex[:6]}.json"

    if req.is_default:
        for f in PRESETS_DIR.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if data.get("is_default") and data.get("name") != req.name.strip():
                    data["is_default"] = False
                    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    payload = {
        "name": req.name.strip(),
        "model": req.model,
        "system_prompt": req.system_prompt,
        "user_prompt": req.user_prompt,
        "temperature": req.temperature,
        "is_default": req.is_default,
        "created_at": datetime.utcnow().isoformat(),
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


@router.patch("/presets/{preset_name:path}/default")
def set_default_preset(preset_name: str):
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    found = False
    for f in PRESETS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            is_target = data.get("name") == preset_name
            if data.get("is_default") != is_target:
                data["is_default"] = is_target
                f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            if is_target:
                found = True
        except Exception:
            pass
    if not found:
        raise HTTPException(404, "Preset not found")
    return {"ok": True}


@router.delete("/presets/{preset_name:path}")
def delete_preset(preset_name: str):
    PRESETS_DIR.mkdir(parents=True, exist_ok=True)
    for f in PRESETS_DIR.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            if data.get("name") == preset_name:
                f.unlink()
                return {"ok": True}
        except Exception:
            pass
    raise HTTPException(404, "Preset not found")
