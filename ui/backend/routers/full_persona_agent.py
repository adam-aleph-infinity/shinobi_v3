"""Full Persona Agent — generate + score a persona from a merged transcript in one flow."""
import asyncio
import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.persona import Persona
from ui.backend.routers.agent_comparison import _call_header, _load_calls_meta, _build_and_save_merged_transcript

router = APIRouter(prefix="/full-persona-agent", tags=["full-persona-agent"])

GENERATOR_PRESETS_DIR = settings.ui_data_dir / "_fpa_generator_presets"
SCORER_PRESETS_DIR    = settings.ui_data_dir / "_fpa_scorer_presets"

ALL_MODELS = [
    "gpt-5.4", "gpt-4.1", "gpt-4.1-mini",
    "claude-opus-4-6", "claude-sonnet-4-6",
    "gemini-2.5-pro", "gemini-2.5-flash",
    "grok-4.20-0309-reasoning", "grok-4.20-0309-non-reasoning",
]

DEFAULT_GENERATOR_SYSTEM = """You are a senior behavioral researcher producing a comprehensive persona profile of the interaction between a sales agent and a customer across all their calls.

Produce a persona document with EXACTLY these sections in this order (each preceded by ##):

## Sales Techniques & Tactics
Cover: specific tactics, objection handling, closing techniques, persuasion methods, pressure patterns. Quote transcripts directly.

## Compliance & Risk
Cover: required disclosures given or missed, regulatory red flags, misleading statements, risk rating (Low / Medium / High) with justification.

## Communication Style & Tone
Cover: vocabulary, tone, active listening, empathy, pace, framing, rapport-building.

## Customer Handling & Approach
Cover: how the agent adapts to this specific customer, handles pushback, personalises, manages emotional state.

## Key Patterns & Summary
Cover: the 3–5 most consistent behaviours across all calls — what defines this agent-customer dynamic.

## Strengths & Weaknesses
Cover: top strengths with evidence, improvement areas, overall performance score (1–10).

## Recommended Actions
Cover: specific, actionable next steps ranked by priority.

Rules:
- Use the exact ## headings above — do not rename, add, or remove sections.
- Be specific; cite call IDs and direct quotes.
- Use bullet points within each section.
- Do not add a title or preamble before the first ## heading."""

DEFAULT_GENERATOR_PROMPT = "Analyse all the calls in this transcript and produce a comprehensive persona document:"

DEFAULT_SCORER_SYSTEM = """You are a persona scoring agent. Given a persona document, score each section and return ONLY a valid JSON object — no markdown, no explanation, no code fences.

The JSON must have this exact structure:
{
  "Section Name": {"score": 75, "reasoning": "one sentence"},
  ...
  "_overall": 72,
  "_summary": "One sentence overall summary"
}

IMPORTANT: All scores — both per-section and _overall — are integers on a 0–100 scale. Do NOT use a 0–10 scale. Score every ## section in the persona document."""

DEFAULT_SCORER_PROMPT = "Score this persona document:"


# ── LLM call with configurable temperature ────────────────────────────────────

def _llm_call_temp(system: str, user: str, model: str, temperature: float) -> str:
    import sys
    sys.path.insert(0, str(settings.project_root))
    from shared.llm_client import LLMClient

    if model.startswith("claude-"):
        provider = "anthropic"
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    elif model.startswith("gemini"):
        provider = "gemini"
        api_key = os.environ.get("GEMINI_API_KEY", "")
    elif model.startswith("grok"):
        provider = "grok"
        from shared.llm_client import resolve_grok_key
        api_key = resolve_grok_key() or ""
    else:
        provider = "openai"
        api_key = os.environ.get("OPENAI_API_KEY", "")

    if not api_key:
        raise RuntimeError(f"API key not set for provider '{provider}'")

    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    print(f"[fpa] payload → model={model} temp={temperature} system_chars={len(system):,} user_chars={len(user):,}")
    print(f"[fpa] system: {system[:300]!r}")
    print(f"[fpa] user (first 500): {user[:500]!r}")
    client = LLMClient(provider=provider, api_key=api_key)
    resp = client.chat_completion(
        model=model,
        messages=messages,
        temperature=temperature,
    )
    result = resp.choices[0].message.content or ""
    # Strip markdown fences if present
    result = result.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    print(f"[fpa] {model} — done, {len(result):,} chars")
    return result


# ── File-upload LLM call ──────────────────────────────────────────────────────
# Each provider uploads the transcript as a file, builds a message referencing it,
# calls the model, then cleans up. File IDs are cached by content-hash in
# pair_dir/_transcript_file_ids.json so re-uploads are skipped when unchanged.

XAI_BASE = "https://api.x.ai/v1"


def _content_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()[:16]


def _load_file_id_cache(pair_dir: Path) -> dict:
    p = pair_dir / "_transcript_file_ids.json"
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


def _save_file_id_cache(pair_dir: Path, cache: dict):
    pair_dir.mkdir(parents=True, exist_ok=True)
    (pair_dir / "_transcript_file_ids.json").write_text(json.dumps(cache, indent=2))


def _upload_and_call_xai(
    system: str, user_prompt: str, transcript: str, model: str, temperature: float,
    pair_dir: Optional[Path] = None,
) -> str:
    import requests as _req
    from shared.llm_client import resolve_grok_key
    api_key = resolve_grok_key() or os.environ.get("XAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GROK_API_KEY / XAI_API_KEY not set")

    # Check cache
    h = _content_hash(transcript)
    cache = _load_file_id_cache(pair_dir) if pair_dir else {}
    entry = cache.get("xai", {})
    if entry.get("content_hash") == h and entry.get("file_id"):
        file_id = entry["file_id"]
        print(f"[fpa/xai] reusing cached file_id {file_id}")
    else:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(transcript)
            tmp = f.name
        try:
            with open(tmp, "rb") as fb:
                resp = _req.post(
                    f"{XAI_BASE}/files",
                    headers={"Authorization": f"Bearer {api_key}"},
                    files={"file": ("merged_transcript.txt", fb, "text/plain")},
                    data={"purpose": "assistants"},
                    timeout=120,
                )
            resp.raise_for_status()
            file_id = resp.json()["id"]
        finally:
            Path(tmp).unlink(missing_ok=True)
        print(f"[fpa/xai] uploaded file_id {file_id}")
        if pair_dir:
            cache["xai"] = {"file_id": file_id, "content_hash": h, "uploaded_at": datetime.utcnow().isoformat()}
            _save_file_id_cache(pair_dir, cache)

    content: list[dict] = [{"type": "file", "file": {"file_id": file_id}}]
    if user_prompt.strip():
        content.append({"type": "text", "text": user_prompt.strip()})
    messages = []
    if system.strip():
        messages.append({"role": "system", "content": system.strip()})
    messages.append({"role": "user", "content": content})
    payload = {"model": model, "messages": messages, "temperature": temperature}
    print(f"[fpa/xai] payload → model={model} temp={temperature} file_id={file_id}")
    print(f"[fpa/xai] system: {system[:300]!r}")
    print(f"[fpa/xai] user_prompt: {user_prompt[:500]!r}")
    print(f"[fpa/xai] full payload (truncated): {json.dumps(payload, indent=2)[:1000]}")

    resp = _req.post(
        f"{XAI_BASE}/chat/completions",
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        json=payload,
        timeout=300,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _upload_and_call_openai(
    system: str, user_prompt: str, transcript: str, model: str, temperature: float,
    pair_dir: Optional[Path] = None,
) -> str:
    # Upload text file via purpose="user_data", then reference via Responses API
    # (Chat Completions rejects text/plain file_id — Responses API handles it correctly)
    from openai import OpenAI
    api_key = os.environ.get("OPENAI_API_KEY", "")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set")
    client = OpenAI(api_key=api_key)

    h = _content_hash(transcript)
    cache = _load_file_id_cache(pair_dir) if pair_dir else {}
    entry = cache.get("openai", {})
    if entry.get("content_hash") == h and entry.get("file_id"):
        file_id = entry["file_id"]
        print(f"[fpa/openai] reusing cached file_id {file_id}")
    else:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(transcript)
            tmp = f.name
        try:
            with open(tmp, "rb") as fb:
                file_obj = client.files.create(file=fb, purpose="user_data")
            file_id = file_obj.id
        finally:
            Path(tmp).unlink(missing_ok=True)
        print(f"[fpa/openai] uploaded file_id {file_id}")
        if pair_dir:
            cache["openai"] = {"file_id": file_id, "content_hash": h, "uploaded_at": datetime.utcnow().isoformat()}
            _save_file_id_cache(pair_dir, cache)

    print(f"[fpa/openai] payload → model={model} temp={temperature} file_id={file_id}")
    print(f"[fpa/openai] system (instructions): {system[:300]!r}")
    print(f"[fpa/openai] user_prompt: {user_prompt[:500]!r}")
    response = client.responses.create(
        model=model,
        instructions=system,
        input=[{
            "role": "user",
            "content": [
                {"type": "input_file", "file_id": file_id},
                {"type": "input_text", "text": user_prompt.strip()},
            ],
        }],
        temperature=temperature,
    )
    return response.output_text




def _upload_and_call_anthropic(
    system: str, user_prompt: str, transcript: str, model: str, temperature: float,
    pair_dir: Optional[Path] = None,
) -> str:
    import anthropic
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    client = anthropic.Anthropic(api_key=api_key)

    h = _content_hash(transcript)
    cache = _load_file_id_cache(pair_dir) if pair_dir else {}
    entry = cache.get("anthropic", {})
    if entry.get("content_hash") == h and entry.get("file_id"):
        file_id = entry["file_id"]
        print(f"[fpa/anthropic] reusing cached file_id {file_id}")
    else:
        with tempfile.NamedTemporaryFile(mode="wb", suffix=".txt", delete=False) as f:
            f.write(transcript.encode("utf-8"))
            tmp = f.name
        try:
            with open(tmp, "rb") as fb:
                file_obj = client.beta.files.upload(
                    file=("merged_transcript.txt", fb, "text/plain"),
                )
            file_id = file_obj.id
        finally:
            Path(tmp).unlink(missing_ok=True)
        print(f"[fpa/anthropic] uploaded file_id {file_id}")
        if pair_dir:
            cache["anthropic"] = {"file_id": file_id, "content_hash": h, "uploaded_at": datetime.utcnow().isoformat()}
            _save_file_id_cache(pair_dir, cache)

    msg_content = [
        {"type": "document", "source": {"type": "file", "file_id": file_id}},
        {"type": "text", "text": user_prompt.strip()},
    ]
    print(f"[fpa/anthropic] payload → model={model} temp={temperature} file_id={file_id}")
    print(f"[fpa/anthropic] system: {system[:300]!r}")
    print(f"[fpa/anthropic] user_prompt: {user_prompt[:500]!r}")
    print(f"[fpa/anthropic] full payload (truncated): {json.dumps({'model': model, 'system': system[:200], 'messages': [{'role': 'user', 'content': msg_content}]}, indent=2)[:1000]}")
    response = client.beta.messages.create(
        model=model,
        max_tokens=8192,
        system=system,
        messages=[{"role": "user", "content": msg_content}],
        temperature=temperature,
        betas=["files-api-2025-04-14"],
    )
    return response.content[0].text


def _upload_and_call_gemini(
    system: str, user_prompt: str, transcript: str, model: str, temperature: float,
    pair_dir: Optional[Path] = None,
) -> str:
    import time
    import google.generativeai as genai
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    genai.configure(api_key=api_key)

    h = _content_hash(transcript)
    cache = _load_file_id_cache(pair_dir) if pair_dir else {}
    entry = cache.get("gemini", {})
    file_obj = None
    if entry.get("content_hash") == h and entry.get("file_name"):
        try:
            file_obj = genai.get_file(entry["file_name"])
            print(f"[fpa/gemini] reusing cached file {entry['file_name']}")
        except Exception:
            file_obj = None

    if file_obj is None:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            f.write(transcript)
            tmp = f.name
        try:
            file_obj = genai.upload_file(path=tmp, mime_type="text/plain", display_name="merged_transcript.txt")
        finally:
            Path(tmp).unlink(missing_ok=True)
        # Wait for processing
        while file_obj.state.name == "PROCESSING":
            time.sleep(2)
            file_obj = genai.get_file(file_obj.name)
        print(f"[fpa/gemini] uploaded file {file_obj.name}")
        if pair_dir:
            cache["gemini"] = {"file_name": file_obj.name, "content_hash": h, "uploaded_at": datetime.utcnow().isoformat()}
            _save_file_id_cache(pair_dir, cache)

    print(f"[fpa/gemini] payload → model={model} temp={temperature} file={file_obj.name}")
    print(f"[fpa/gemini] system_instruction: {system[:300]!r}")
    print(f"[fpa/gemini] user_prompt: {user_prompt[:500]!r}")
    gen_model = genai.GenerativeModel(model, system_instruction=system)
    response = gen_model.generate_content(
        [file_obj, user_prompt.strip()],
        generation_config={"temperature": temperature},
    )
    return response.text


def _llm_call_with_file(
    system: str, user_prompt: str, transcript: str, model: str, temperature: float,
    pair_dir: Optional[Path] = None,
) -> str:
    """Call LLM with transcript uploaded as a file (not pasted in prompt)."""
    print(f"[fpa/file-upload] {model} — uploading {len(transcript):,} char transcript…")
    if model.startswith("claude-"):
        result = _upload_and_call_anthropic(system, user_prompt, transcript, model, temperature, pair_dir)
    elif model.startswith("gemini"):
        result = _upload_and_call_gemini(system, user_prompt, transcript, model, temperature, pair_dir)
    elif model.startswith("grok"):
        result = _upload_and_call_xai(system, user_prompt, transcript, model, temperature, pair_dir)
    else:
        result = _upload_and_call_openai(system, user_prompt, transcript, model, temperature, pair_dir)

    result = result.strip()
    if result.startswith("```"):
        result = result.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    print(f"[fpa/file-upload] {model} — done, {len(result):,} chars")
    return result


# ── Output normalizers ────────────────────────────────────────────────────────

_SCORE_NORMALISE_SYSTEM = """You are a data extractor. Convert raw LLM score output into a strict JSON object.

The input may be plain text ("Score: 8/10" or "82/100"), markdown tables, or already valid JSON.

Return ONLY a valid JSON object — no markdown fences, no explanation — with EXACTLY this structure:

SECTION SCORES — one key per evaluated section (the main evaluation results):
  "<Section Name>": {"score": <0-100 integer>, "reasoning": "<one concise sentence>"}

REQUIRED METADATA — underscore-prefixed, always present:
  "_overall": <0-100 integer — arithmetic mean of all section scores>
  "_summary": "<one sentence summarising overall quality>"

OPTIONAL METADATA — include only if the corresponding content exists in the input:
  "_strengths": ["<bullet text>", ...]   — array of strength bullet points from a Strengths section
  "_weaknesses": ["<bullet text>", ...]  — array of weakness bullet points from a Weaknesses section
  "_assessment": "<paragraph>"           — full Overall Assessment paragraph if present

Rules for SECTION SCORES:
- Use the exact section name strings from the input as JSON keys
- score must be a 0-100 integer (if input is 0-10 scale multiply by 10; if 0-1 scale multiply by 100)
- reasoning must be one concise sentence — no newlines, no bullet points
- Do NOT include non-scored items (Strengths, Weaknesses, Overall Assessment) as section score keys

Rules for REQUIRED METADATA:
- _overall = arithmetic mean of all section scores, rounded to nearest integer (0-100)
- _summary = one overall quality sentence; no newlines

Return ONLY valid JSON — no markdown fences, no explanation."""

_SECTIONS_NORMALISE_SYSTEM = """You are a document parser. Extract sections from a persona document into a JSON array.

Return ONLY a valid JSON array — no markdown fences, no explanation:
[
  {"title": "<Section heading>", "content": "<Full section content as markdown, preserve bullet points and sub-headers>"},
  ...
]

Rules:
- Use ## headings as section boundaries (or numbered headings if no ## present)
- title is the heading text without leading ## or numbers
- content includes everything under that heading until the next heading
- Preserve all markdown formatting in content
- Return ONLY JSON"""


def _normalise_score(score_raw: str, model: str = "gpt-5.4", system: Optional[str] = None, temperature: float = 0.0) -> dict:
    """Convert any scorer output format into the standard score_json schema."""
    print(f"[fpa/normalise] scoring — {len(score_raw):,} chars → structured JSON")
    try:
        raw = _llm_call_temp(system or _SCORE_NORMALISE_SYSTEM, score_raw, model, temperature)
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        result = json.loads(raw)
        print(f"[fpa/normalise] score keys: {list(result.keys())}")
        return result
    except Exception as e:
        print(f"[fpa/normalise] score normalisation failed: {e}")
        return {}


def _normalise_sections(content_md: str, model: str = "gpt-5.4") -> list:
    """Extract sections from persona markdown into [{title, content}] list."""
    print(f"[fpa/normalise] sections — {len(content_md):,} chars → structured list")
    try:
        raw = _llm_call_temp(_SECTIONS_NORMALISE_SYSTEM, content_md, model, 0.0)
        raw = raw.strip()
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        result = json.loads(raw)
        print(f"[fpa/normalise] sections: {[s.get('title','?') for s in result]}")
        return result
    except Exception as e:
        print(f"[fpa/normalise] sections normalisation failed: {e}")
        return []


# ── Score JSON parser ─────────────────────────────────────────────────────────

def _parse_score_json(raw: str) -> dict:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end != -1:
        raw = raw[start:end + 1]
    try:
        return json.loads(raw)
    except Exception:
        return {"_overall": 0, "_summary": "Score returned as text (not JSON)", "_raw_text": raw}


# ── Persona saver ─────────────────────────────────────────────────────────────

def _ensure_persona_agent_record(preset_name: str):
    """Auto-create a PersonaAgent JSON record for preset_name if one doesn't exist yet."""
    pa_dir = settings.ui_data_dir / "_persona_agents"
    pa_dir.mkdir(parents=True, exist_ok=True)
    # Check if a record with this name already exists
    for f in pa_dir.glob("*.json"):
        try:
            data = json.loads(f.read_text())
            if data.get("name") == preset_name:
                return  # already exists
        except Exception:
            continue
    # Create a minimal record so the Personas page left panel shows it
    now = datetime.utcnow().isoformat()
    record = {
        "id": str(uuid.uuid4()),
        "created_at": now,
        "updated_at": now,
        "name": preset_name,
        "description": "",
        "persona_type": "pair",
        "system_prompt": "",
        "user_prompt": "",
        "temperature": 0.0,
        "model": "",
        "is_default": False,
        "sections": [],
    }
    (pa_dir / f"{record['id']}.json").write_text(json.dumps(record, indent=2))


def _save_persona_to_db(
    agent: str, customer: str, label: str,
    content_md: str, score_json: dict,
    generator_model: str, generator_temperature: float,
    generator_system: str, generator_prompt: str,
    generator_preset_name: str,
    scorer_model: str, scorer_temperature: float,
    scorer_system: str, scorer_prompt: str,
    db: Session,
    sections_json: Optional[list] = None,
) -> str:
    from ui.backend.routers.personas import _save_persona_file

    # Auto-create a PersonaAgent record so the preset appears in the Personas left panel
    pa_name = generator_preset_name or "full_persona_agent"
    _ensure_persona_agent_record(pa_name)

    persona_id = str(uuid.uuid4())
    now = datetime.utcnow()

    # Collect smoothed transcript paths for this pair
    pair_dir = settings.agents_dir / agent / customer
    t_paths: list[str] = []
    if pair_dir.exists():
        t_paths = sorted(
            str(d / "transcribed" / "llm_final" / "smoothed.txt")
            for d in pair_dir.iterdir()
            if d.is_dir() and not d.name.startswith("_")
            and (d / "transcribed" / "llm_final" / "smoothed.txt").exists()
        )

    # Enrich score_json with scorer + normaliser metadata
    enriched_score = dict(score_json)
    enriched_score["_scorer_model"] = scorer_model
    enriched_score["_scorer_temperature"] = scorer_temperature
    enriched_score["_scorer_system"] = scorer_system
    enriched_score["_scorer_user"] = scorer_prompt
    enriched_score["_normaliser_system_used"] = _SCORE_NORMALISE_SYSTEM
    enriched_score["_normaliser_model_used"] = "gpt-5.4"
    enriched_score["_normaliser_temperature"] = 0.0

    persona = Persona(
        id=persona_id,
        type="pair",
        agent=agent,
        customer=customer,
        label=label or f"Full Persona — {now.strftime('%Y-%m-%d %H:%M')}",
        content_md=content_md,
        prompt_used=f"SYSTEM:\n{generator_system}\n\nUSER:\n{generator_prompt}",
        model=generator_model,
        temperature=generator_temperature,
        version=1,
        transcript_paths=json.dumps(t_paths),
        score_json=json.dumps(enriched_score),
        sections_json=json.dumps(sections_json) if sections_json else None,
        created_at=now,
        persona_agent_id=generator_preset_name or "full_persona_agent",
        # script_path points to the merged transcript (LLM input), not the persona output
        script_path=str(pair_dir / "merged_transcript.txt") if (pair_dir / "merged_transcript.txt").exists() else None,
    )
    _save_persona_file(persona)   # saves persona markdown to ui_data/personas/{id}.md
    db.add(persona)
    db.commit()
    return persona_id


# ── SSE helper ────────────────────────────────────────────────────────────────

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# _build_and_save_merged_transcript is imported from agent_comparison (canonical shared function)


# ── Agents / customers / stats / transcript ────────────────────────────────────

@router.get("/agents")
def list_agents():
    d = settings.agents_dir
    if not d.exists():
        return []
    return sorted([x.name for x in d.iterdir() if x.is_dir() and not x.name.startswith("_")])


@router.get("/agent-stats")
def agent_stats_fpa():
    from sqlalchemy import text as _text
    from ui.backend.database import engine
    from sqlmodel import Session as _S

    agents_dir = settings.agents_dir
    if not agents_dir.exists():
        return []

    # Fetch net deposits per agent from DB
    net_dep_by_agent: dict[str, float] = {}
    try:
        with _S(engine) as db:
            rows = db.execute(_text("SELECT agent, SUM(net_deposits) FROM crm_pair GROUP BY agent")).fetchall()
            for r in rows:
                if r[1] is not None:
                    net_dep_by_agent[r[0]] = float(r[1])
    except Exception as e:
        print(f"[fpa/agent-stats] net_deposits query: {e}")

    results = []
    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith("_"):
            continue
        customer_dirs = [d for d in agent_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
        total_calls = total_transcripts = total_landmarks = customers_with_data = 0
        for cust_dir in customer_dirs:
            call_dirs = [d for d in cust_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
            for call_dir in call_dirs:
                total_calls += 1
                if (call_dir / "transcribed" / "llm_final" / "smoothed.txt").exists():
                    total_transcripts += 1
                if (call_dir / "transcribed" / "llm_final" / "landmarks.json").exists():
                    total_landmarks += 1
            if any((d / "transcribed" / "llm_final" / "smoothed.txt").exists() for d in call_dirs):
                customers_with_data += 1
        results.append({
            "agent": agent_dir.name,
            "customers": len(customer_dirs),
            "customers_with_data": customers_with_data,
            "total_calls": total_calls,
            "total_transcripts": total_transcripts,
            "total_landmarks": total_landmarks,
            "net_deposits": net_dep_by_agent.get(agent_dir.name, 0.0),
        })
    # Sort: agents with workable data first, then by net deposits desc
    results.sort(key=lambda x: (-(x["customers_with_data"]), -(x["total_transcripts"]), -(x["net_deposits"])))
    return results


@router.get("/customers")
def list_customers(agent: str = Query(...)):
    d = settings.agents_dir / agent
    if not d.exists():
        return []
    return sorted([x.name for x in d.iterdir() if x.is_dir() and not x.name.startswith("_")])


@router.get("/customer-stats")
def customer_stats_fpa(agent: str = Query(...)):
    """Per-customer transcript/landmark counts + net deposits from CRM DB."""
    from sqlalchemy import text as _text
    from ui.backend.database import engine
    from sqlmodel import Session as _S

    agent_dir = settings.agents_dir / agent
    if not agent_dir.exists():
        return []

    # Pull net deposits from DB for this agent
    net_dep_map: dict[str, float] = {}
    try:
        with _S(engine) as db:
            rows = db.execute(
                _text("SELECT customer, net_deposits FROM crm_pair WHERE agent=:a"),
                {"a": agent},
            ).fetchall()
            for r in rows:
                net_dep_map[r[0]] = r[1] or 0.0
    except Exception as e:
        print(f"[fpa] net_deposits query: {e}")

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
            "net_deposits": net_dep_map.get(cust_dir.name, 0.0),
        })
    return results


@router.get("/file-ids")
def get_file_ids(agent: str = Query(...), customer: str = Query(...)):
    """Return cached file IDs for this pair (provider → {file_id, uploaded_at, content_hash})."""
    pair_dir = settings.agents_dir / agent / customer
    cache = _load_file_id_cache(pair_dir)
    return cache


@router.get("/transcript-info")
def transcript_info(agent: str = Query(...), customer: str = Query(...)):
    pair_dir = settings.agents_dir / agent / customer
    if not pair_dir.exists():
        return {"available": False, "calls": 0, "transcripts": 0, "chars": 0}
    call_dirs = [d for d in pair_dir.iterdir() if d.is_dir() and not d.name.startswith("_")]
    tx_dirs = [d for d in call_dirs if (d / "transcribed" / "llm_final" / "smoothed.txt").exists()]
    total_chars = sum(
        len((d / "transcribed" / "llm_final" / "smoothed.txt").read_text(encoding="utf-8"))
        for d in tx_dirs
    )
    return {
        "available": len(tx_dirs) > 0,
        "calls": len(call_dirs),
        "transcripts": len(tx_dirs),
        "chars": total_chars,
    }


@router.get("/transcript")
def get_transcript(agent: str = Query(...), customer: str = Query(...), force: bool = Query(False)):
    content = _build_and_save_merged_transcript(agent, customer, force=force)
    if not content:
        raise HTTPException(404, "No transcript data available")
    return PlainTextResponse(content)


# ── Quick Run (single pair) ────────────────────────────────────────────────────

class FPAQuickRunRequest(BaseModel):
    agent: str
    customer: str
    smooth_model: str = "gpt-5.4"
    run_landmarks: bool = False
    force: bool = False


@router.post("/quick-run")
def fpa_quick_run(req: FPAQuickRunRequest, background_tasks: BackgroundTasks):
    from ui.backend.routers.agent_comparison import quick_run_pairs, QuickRunRequest
    return quick_run_pairs(
        QuickRunRequest(
            pairs=[{"agent": req.agent, "customer": req.customer}],
            smooth_model=req.smooth_model,
            run_landmarks=req.run_landmarks,
            force=req.force,
        ),
        background_tasks,
    )


@router.get("/quick-run/status")
def fpa_quick_run_status(run_id: str = Query(...)):
    from ui.backend.routers.agent_comparison import quick_run_status
    return quick_run_status(run_id)


# ── Analyze (SSE stream) ───────────────────────────────────────────────────────

class AnalyzeRequest(BaseModel):
    agent: str
    customer: str
    label: str = ""
    generator_model: str = "gpt-5.4"
    generator_temperature: float = 0.0
    generator_system: str = DEFAULT_GENERATOR_SYSTEM
    generator_prompt: str = DEFAULT_GENERATOR_PROMPT
    generator_preset_name: str = ""   # preset name → becomes persona_agent_id
    scorer_model: str = "gpt-5.4"
    scorer_temperature: float = 0.0
    scorer_system: str = DEFAULT_SCORER_SYSTEM
    scorer_prompt: str = DEFAULT_SCORER_PROMPT
    force_merge: bool = True   # rebuild merged_transcript.txt even if cached
    use_file_upload: bool = False   # upload transcript as file instead of pasting in prompt


@router.post("/analyze")
async def analyze(req: AnalyzeRequest):
    loop = asyncio.get_event_loop()

    _pair = f"{req.agent}/{req.customer}"

    async def stream():
        content_raw = ""   # raw generator output (for Show Raw)
        score_raw = ""     # raw scorer output (for Show Raw)

        # Step 1: build transcript
        print(f"[FPA] {_pair}: building merged transcript")
        yield _sse("progress", {"step": 1, "total": 4, "msg": "Building merged transcript…"})
        transcript = await loop.run_in_executor(
            None, _build_and_save_merged_transcript, req.agent, req.customer, req.force_merge
        )
        if not transcript:
            print(f"[FPA] {_pair}: ERROR — no transcript data found")
            yield _sse("error", {"msg": "No transcript data found for this pair. Run the pipeline first.", "content_raw": content_raw, "score_raw": score_raw})
            return
        print(f"[FPA] {_pair}: transcript ready — {len(transcript):,} chars")
        yield _sse("progress", {"step": 1, "total": 4,
            "msg": f"Transcript ready — {len(transcript):,} chars across all calls"})

        # Step 2: persona generator
        pair_dir = settings.agents_dir / req.agent / req.customer
        upload_mode = req.use_file_upload
        print(f"[FPA] {_pair}: running generator model={req.generator_model} file_upload={upload_mode}")
        yield _sse("progress", {"step": 2, "total": 4,
            "msg": f"Running Persona Generator ({req.generator_model}){' [file-upload]' if upload_mode else ''}…"})
        try:
            if upload_mode:
                content_md = await loop.run_in_executor(
                    None, _llm_call_with_file,
                    req.generator_system, req.generator_prompt, transcript,
                    req.generator_model, req.generator_temperature, pair_dir,
                )
            else:
                user_msg = f"{req.generator_prompt.strip()}\n\n{transcript}"
                content_md = await loop.run_in_executor(
                    None, _llm_call_temp,
                    req.generator_system, user_msg, req.generator_model, req.generator_temperature,
                )
            content_raw = content_md
        except Exception as e:
            content_raw = str(e)
            print(f"[FPA] {_pair}: ERROR — generator failed: {e}")
            yield _sse("error", {"msg": f"Persona Generator failed: {e}", "content_raw": content_raw, "score_raw": score_raw})
            return
        print(f"[FPA] {_pair}: generator done — {len(content_md):,} chars")
        yield _sse("progress", {"step": 2, "total": 4,
            "msg": f"Persona generated — {len(content_md):,} chars"})

        # Step 3: persona scorer
        print(f"[FPA] {_pair}: running scorer model={req.scorer_model} file_upload={upload_mode}")
        yield _sse("progress", {"step": 3, "total": 4,
            "msg": f"Running Persona Scorer ({req.scorer_model})…"})
        try:
            # Scorer receives both the persona card AND the original transcript.
            # The transcript prompt tells the scorer it is the Stage 2 output source
            # and the raw conversation data it is allowed to reference directly.
            score_user_msg = (
                f"{req.scorer_prompt.strip()}\n\n"
                f"## STAGE 2 ANALYSIS OUTPUT (Persona Card)\n\n{content_md}\n\n"
                f"## ORIGINAL TRANSCRIPTS (for Secret Code verification and outcome confirmation)\n\n{transcript}"
            )
            print(f"[fpa/scorer] model={req.scorer_model} temp={req.scorer_temperature} "
                  f"persona_chars={len(content_md):,} transcript_chars={len(transcript):,}")
            print(f"[fpa/scorer] system (first 300): {req.scorer_system[:300]!r}")
            print(f"[fpa/scorer] user_prompt: {req.scorer_prompt[:300]!r}")
            if upload_mode:
                # Upload transcript as file; persona card goes inline in the user message
                score_inline = (
                    f"{req.scorer_prompt.strip()}\n\n"
                    f"## STAGE 2 ANALYSIS OUTPUT (Persona Card)\n\n{content_md}"
                )
                score_raw = await loop.run_in_executor(
                    None, _llm_call_with_file,
                    req.scorer_system, score_inline, transcript,
                    req.scorer_model, req.scorer_temperature, pair_dir,
                )
            else:
                score_raw = await loop.run_in_executor(
                    None, _llm_call_temp,
                    req.scorer_system, score_user_msg, req.scorer_model, req.scorer_temperature,
                )
            print(f"[fpa/scorer] raw output ({len(score_raw):,} chars):\n{score_raw[:1000]}")
            score_json = _parse_score_json(score_raw)
            print(f"[fpa/scorer] parsed score_json keys: {list(score_json.keys())}")
        except Exception as e:
            score_raw = str(e)
            print(f"[FPA] {_pair}: ERROR — scorer failed: {e}")
            yield _sse("error", {"msg": f"Persona Scorer failed: {e}", "content_raw": content_raw, "score_raw": score_raw})
            return
        overall = score_json.get("_overall", 0)
        print(f"[FPA] {_pair}: scorer done — overall {overall}/100")
        yield _sse("progress", {"step": 3, "total": 5,
            "msg": f"Score complete — overall {overall}/100"})

        # Step 4: normalise outputs → structured sections + score JSON
        yield _sse("progress", {"step": 4, "total": 5, "msg": "Normalising outputs…"})
        norm_sections: list = []
        norm_score: dict = {}
        try:
            norm_sections, norm_score = await asyncio.gather(
                loop.run_in_executor(None, _normalise_sections, content_md, "gpt-5.4"),
                loop.run_in_executor(None, _normalise_score, score_raw, "gpt-5.4"),
            )
            # If normalised score has useful sections, use it — else keep original parsed score
            if norm_score and any(not k.startswith("_") for k in norm_score):
                # Preserve scorer metadata from original score_json
                for k in ("_scorer_model", "_scorer_temperature", "_scorer_system", "_scorer_user"):
                    if k in score_json:
                        norm_score[k] = score_json[k]
                score_json = norm_score
                overall = score_json.get("_overall", overall)
        except Exception as e:
            print(f"[FPA] {_pair}: normalise error (non-fatal): {e}")
        # Always preserve the raw scorer text so the UI can display it
        score_json["_raw_score_text"] = score_raw
        scored_sections = sum(1 for k in score_json if not k.startswith("_"))
        print(f"[FPA] {_pair}: normalised — {len(norm_sections)} sections, {scored_sections} scored")
        yield _sse("progress", {"step": 4, "total": 5,
            "msg": f"Normalised — {len(norm_sections)} sections, {scored_sections} scored sections"})

        # Step 5: save to DB
        print(f"[FPA] {_pair}: saving persona to database")
        yield _sse("progress", {"step": 5, "total": 5, "msg": "Saving persona to database…"})
        try:
            from ui.backend.database import engine
            from sqlmodel import Session as _Session
            with _Session(engine) as db:
                persona_id = _save_persona_to_db(
                    req.agent, req.customer, req.label,
                    content_md, score_json,
                    req.generator_model, req.generator_temperature,
                    req.generator_system, req.generator_prompt,
                    req.generator_preset_name,
                    req.scorer_model, req.scorer_temperature,
                    req.scorer_system, req.scorer_prompt,
                    db,
                    sections_json=norm_sections or None,
                )
        except Exception as e:
            print(f"[FPA] {_pair}: ERROR — save failed: {e}")
            yield _sse("error", {"msg": f"Save failed: {e}", "content_raw": content_raw, "score_raw": score_raw})
            return

        print(f"[FPA] {_pair}: done — persona_id={persona_id} overall={overall}/100")
        yield _sse("done", {
            "persona_id": persona_id,
            "overall_score": overall,
            "content_md": content_md,
            "score_json": score_json,
            "content_raw": content_raw,
            "score_raw": score_raw,
            "sections": norm_sections,
        })

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Presets (shared for generator and scorer) ─────────────────────────────────

class AgentPresetIn(BaseModel):
    name: str
    model: str = "gpt-4.1"
    temperature: float = 0.0
    system_prompt: str = ""
    user_prompt: str = ""
    is_default: bool = False


def _slug(name: str) -> str:
    s = re.sub(r"[^\w\s\-.]", "_", name.strip())
    return re.sub(r"\s+", "_", s).strip("_") or "preset"


def _presets_dir(preset_type: str) -> Path:
    return GENERATOR_PRESETS_DIR if preset_type == "generator" else SCORER_PRESETS_DIR


def _all_presets(preset_type: str) -> list[dict]:
    d = _presets_dir(preset_type)
    d.mkdir(parents=True, exist_ok=True)
    results = []
    for f in sorted(d.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            results.append(json.loads(f.read_text(encoding="utf-8")))
        except Exception:
            pass
    results.sort(key=lambda x: (0 if x.get("is_default") else 1))
    return results


@router.get("/presets/{preset_type}")
def list_presets(preset_type: str):
    if preset_type not in ("generator", "scorer"):
        raise HTTPException(400, "preset_type must be 'generator' or 'scorer'")
    return _all_presets(preset_type)


@router.post("/presets/{preset_type}")
def save_preset(preset_type: str, req: AgentPresetIn):
    if preset_type not in ("generator", "scorer"):
        raise HTTPException(400, "preset_type must be 'generator' or 'scorer'")
    if not req.name.strip():
        raise HTTPException(400, "Name is required")

    d = _presets_dir(preset_type)
    d.mkdir(parents=True, exist_ok=True)

    # Remove existing with same name
    for f in d.glob("*.json"):
        try:
            if json.loads(f.read_text(encoding="utf-8")).get("name") == req.name.strip():
                f.unlink(); break
        except Exception:
            pass

    path = d / (_slug(req.name.strip()) + ".json")
    if path.exists():
        path = d / f"{_slug(req.name.strip())}_{uuid.uuid4().hex[:6]}.json"

    if req.is_default:
        for f in d.glob("*.json"):
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                if data.get("is_default") and data.get("name") != req.name.strip():
                    data["is_default"] = False
                    f.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
            except Exception:
                pass

    payload = {
        "name": req.name.strip(), "model": req.model, "temperature": req.temperature,
        "system_prompt": req.system_prompt, "user_prompt": req.user_prompt,
        "is_default": req.is_default, "created_at": datetime.utcnow().isoformat(),
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return payload


@router.patch("/presets/{preset_type}/{preset_name:path}/default")
def set_default(preset_type: str, preset_name: str):
    if preset_type not in ("generator", "scorer"):
        raise HTTPException(400, "Invalid preset_type")
    d = _presets_dir(preset_type)
    found = False
    for f in d.glob("*.json"):
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


@router.delete("/presets/{preset_type}/{preset_name:path}")
def delete_preset(preset_type: str, preset_name: str):
    if preset_type not in ("generator", "scorer"):
        raise HTTPException(400, "Invalid preset_type")
    d = _presets_dir(preset_type)
    for f in d.glob("*.json"):
        try:
            if json.loads(f.read_text(encoding="utf-8")).get("name") == preset_name:
                f.unlink()
                return {"ok": True}
        except Exception:
            pass
    raise HTTPException(404, "Preset not found")
