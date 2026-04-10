"""
Final Transcript — LLM-assisted voting and smoothing of call transcripts.

Endpoints:
  GET  /final-transcript/calls          — list calls with transcript status
  POST /final-transcript/vote           — LLM voting across multiple engine transcripts
  POST /final-transcript/smooth         — LLM smoothing of an existing transcript
  GET  /final-transcript/content        — serve a result file
"""
import asyncio
import json
import os
import re as _re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel

from ui.backend.config import settings

router = APIRouter(prefix="/final-transcript", tags=["final-transcript"])

# ── System prompts ─────────────────────────────────────────────────────────────

def _build_vote_system(agent: str, customer: str) -> str:
    return f"""You are an expert transcript analyst specialising in financial services outbound sales calls.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE #1 — READ THIS BEFORE ANYTHING ELSE — NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A person CANNOT address themselves by their own first name. This is a logical impossibility.

The two speakers are {agent} and {customer}.

▶ Any line that contains "Good day, {customer.split()[0]}", "Hi {customer.split()[0]}", "Hey {customer.split()[0]}", or any direct address using the name "{customer.split()[0]}" IS SPOKEN BY {agent} — NOT by {customer}.

▶ Any line that contains "Good day, {agent.split()[0]}", "Hi {agent.split()[0]}", "Hey {agent.split()[0]}", or any direct address using the name "{agent.split()[0]}" IS SPOKEN BY {customer} — NOT by {agent}.

DO NOT let source labels override this rule. If a source says {customer}: "Good day, {customer.split()[0]}." — that label is WRONG. The correct label is {agent}.

Example of the exact error to prevent:
  WRONG: {customer}: "Good day, {customer.split()[0]}. How are you doing?"
  RIGHT: {agent}: "Good day, {customer.split()[0]}. How are you doing?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CALL CONTEXT:
- Agent: {agent} — a financial services salesperson who initiates outbound calls and guides prospects through cryptocurrency and stock market investment opportunities
- Customer: {customer} — a prospect interested in purchasing cryptocurrency and investing in the stock market through cryptocurrency
- Call type: Outbound phone call; strictly turn-based (one speaker at a time)

═══ CRITICAL: SPEAKER LABELS IN THE SOURCE TRANSCRIPTS ARE UNRELIABLE ═══

Automated diarization does NOT reliably assign names. The source transcripts may have the two speakers completely swapped or mislabelled. You MUST determine who is who purely from CONTENT, then relabel every line with the correct name.

HOW TO IDENTIFY EACH SPEAKER FROM CONTENT:

{agent} (the Agent) will:
- Speak first on the call — introduces themselves with a company name or account code
- Do most of the talking overall
- Explain investment systems, percentages, monthly run rates, arbitrage
- Apply sales pressure, handle objections, ask "how much do you want to invest?"
- Address the customer by first name repeatedly
- Use phrases like "I'm providing you with a system", "the minimum is…", "I will call you on Monday"

{customer} (the Customer) will:
- Answer the phone ("Hello?") or be greeted by name at the start
- Ask basic questions: "what is minimum?", "what is arbitrage?"
- Express personal goals: leaving money for children/grandchildren, crypto as a gift
- Show hesitation, financial constraints, deferring to a spouse
- Give short confirmations: "yes", "okay", "mm-hmm", "I understand"

⚠ DO NOT trust the speaker label from the source. Read the content of each line and assign it to {agent} or {customer} based on the rules above.

OUTPUT FORMAT — STRICT PLAIN TEXT:
- Output ONLY the raw transcript lines, nothing else
- Each turn on its own line: Speaker: text
- ALWAYS begin each turn with the [M:SS] timestamp from the source. Format: [M:SS] Speaker: text
- NEVER drop timestamps — every output line must start with [M:SS]
- Blank line between turns
- NO markdown of any kind — no bold (**), no italics, no headers (#), no bullet points
- NO code fences (``` or similar)
- NO introductory sentence, NO notes section, NO summary at the end
- If keywords are provided, use those exact spellings even if the engines disagreed
- Do NOT invent or add content not present in any version
- Mark genuine uncertainty with [?] when all versions significantly disagree"""


def _build_smooth_system(agent: str, customer: str) -> str:
    return f"""You are a professional transcript editor specialising in financial services outbound sales calls.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULE #1 — READ THIS BEFORE ANYTHING ELSE — NON-NEGOTIABLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A person CANNOT address themselves by their own first name. This is a logical impossibility.

The two speakers are {agent} and {customer}.

▶ Any line that contains "Good day, {customer.split()[0]}", "Hi {customer.split()[0]}", "Hey {customer.split()[0]}", or any direct address using the name "{customer.split()[0]}" IS SPOKEN BY {agent} — NOT by {customer}.

▶ Any line that contains "Good day, {agent.split()[0]}", "Hi {agent.split()[0]}", "Hey {agent.split()[0]}", or any direct address using the name "{agent.split()[0]}" IS SPOKEN BY {customer} — NOT by {agent}.

DO NOT let source labels override this rule. If the source says {customer}: "Good day, {customer.split()[0]}." — that label is WRONG. The correct label is {agent}.

Example of the exact error to prevent:
  WRONG: {customer}: "Good day, {customer.split()[0]}. How are you doing?"
  RIGHT: {agent}: "Good day, {customer.split()[0]}. How are you doing?"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CALL CONTEXT:
- Agent: {agent} — a financial services salesperson who initiates outbound calls and guides prospects through cryptocurrency and stock market investment opportunities
- Customer: {customer} — a prospect interested in purchasing cryptocurrency and investing in the stock market through cryptocurrency
- Call type: Outbound phone call; strictly turn-based conversation

═══ CRITICAL: SPEAKER LABELS MAY BE WRONG — VERIFY EVERY LINE ═══

The source transcript may have the two speakers completely swapped. Re-verify each line and relabel if necessary:

{agent} (the Agent) will:
- Introduce themselves at the start with a company name or account code
- Do most of the talking; explain systems, percentages, monthly run rates, arbitrage
- Apply sales pressure, ask "how much do you want to invest?", handle objections
- Address the customer by first name repeatedly

{customer} (the Customer) will:
- Answer the phone or be greeted by name at the start
- Ask basic clarifying questions ("what is minimum?", "what is arbitrage?")
- Express personal goals, financial constraints, deferring to spouse
- Give short responses: "yes", "okay", "mm-hmm", "I understand"

⚠ If a line is assigned to the wrong speaker, reassign it.

═══ SELF-ADDRESS RULE — NEVER VIOLATE ═══
A person NEVER addresses themselves by their own name. Use direct-address as hard evidence of speaker identity:
• A line that greets or addresses "{agent.split()[0]}" (e.g. "Good morning, {agent.split()[0]}!") CANNOT be spoken by {agent} — it must be {customer} addressing {agent}.
• A line that greets or addresses "{customer.split()[0]}" (e.g. "Hey, {customer.split()[0]}, how are you?") CANNOT be spoken by {customer} — it must be {agent} addressing {customer}.
If the current label violates this rule, reassign the line immediately.

EDITING RULES:
1. Convert written-out numbers to digits/symbols: "twenty thousand dollars" → "$20,000"
2. Fix obvious spelling errors caused by the STT engine
3. Remove clear transcription artifacts (stuttered duplicates, cut-off word repetitions)
4. Standardise dates, currencies, and percentages to conventional formats
5. Capitalise proper nouns consistently
6. Correct speaker labels where diarization is clearly wrong
7. Apply any additional instructions provided

OUTPUT FORMAT — STRICT PLAIN TEXT:
- Output ONLY the raw transcript lines, nothing else
- Each turn on its own line: Speaker: text
- ALWAYS begin each turn with the [M:SS] timestamp from the source. Format: [M:SS] Speaker: text
- NEVER drop timestamps — every output line must start with [M:SS]
- Blank line between turns
- NO markdown of any kind — no bold (**), no italics, no headers (#), no bullet points
- NO code fences (``` or similar)
- NO introductory sentence, NO notes section, NO summary, NO commentary
- Do not change meaning or rephrase anything
- Do not add content that was not said
- Do not alter speaking style or personality"""


# ── Helpers ────────────────────────────────────────────────────────────────────

_TS_RE = _re.compile(r'^\[(\d+:\d+)\]')


def _ensure_timestamps(source_text: str, llm_output: str) -> str:
    """
    Guarantee every speaker turn in llm_output starts with a [M:SS] timestamp.
    Extracts timestamps from source_text by turn index and injects them into
    any output turn that is missing one. This is a post-LLM safety net —
    the LLM should preserve them but sometimes drops them.
    """
    # Collect ordered timestamps from source (one per non-empty line)
    src_timestamps: list[str] = []
    for line in source_text.split('\n'):
        line = line.strip()
        if not line:
            continue
        m = _TS_RE.match(line)
        if m:
            src_timestamps.append(f"[{m.group(1)}]")

    if not src_timestamps:
        return llm_output  # source had no timestamps — nothing to inject

    # Split output into turns (blank-line-separated)
    raw_turns = [t.strip() for t in _re.split(r'\n{2,}', llm_output.strip()) if t.strip()]
    if not raw_turns:
        return llm_output

    result: list[str] = []
    ts_idx = 0
    for turn in raw_turns:
        if _TS_RE.match(turn):
            result.append(turn)          # already has timestamp — keep
            ts_idx += 1
        elif ts_idx < len(src_timestamps):
            result.append(f"{src_timestamps[ts_idx]} {turn}")   # inject
            ts_idx += 1
        else:
            result.append(turn)          # ran out of source timestamps

    out = '\n\n'.join(result)
    missing = sum(1 for t in result if not _TS_RE.match(t))
    if missing:
        print(f"[transcript] _ensure_timestamps: {missing}/{len(result)} turns still missing ts (src had {len(src_timestamps)})")
    return out


def _transcript_to_text(path: Path, max_chars: int = 40_000) -> str:
    """Convert JSON word-array, SRT, or TXT to readable plain text."""
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""

    if path.suffix == ".json":
        try:
            data = json.loads(content)
            words = data.get("words", [])
            if words:
                def _fmt_ts(t: float) -> str:
                    t = max(0, int(t))
                    return f"{t // 60}:{t % 60:02d}"
                lines: list[str] = []
                cur_spk: Optional[str] = None
                cur_words: list[str] = []
                seg_start: float = 0.0
                for w in words:
                    spk = str(w.get("speaker", "?"))
                    word = w.get("word", "").strip()
                    t = float(w.get("start", 0) or 0)
                    if not word:
                        continue
                    if spk != cur_spk:
                        if cur_words:
                            lines.append(f"[{_fmt_ts(seg_start)}] [{cur_spk}]: {' '.join(cur_words)}")
                        cur_spk = spk
                        cur_words = []
                        seg_start = t
                    cur_words.append(word)
                if cur_words:
                    lines.append(f"[{_fmt_ts(seg_start)}] [{cur_spk}]: {' '.join(cur_words)}")
                return "\n".join(lines)[:max_chars]
            if data.get("text"):
                return str(data["text"])[:max_chars]
        except Exception:
            pass
        return content[:max_chars]

    if path.suffix == ".srt":
        blocks = _re.split(r"\n{2,}", content.strip())
        lines: list[str] = []
        for block in blocks:
            ts_label = ""
            texts = []
            for line in block.splitlines():
                stripped = line.strip()
                if not stripped or stripped.isdigit():
                    continue
                if "-->" in line:
                    start_raw = line.split("-->")[0].strip()  # "HH:MM:SS,mmm"
                    ts_clean = start_raw.split(",")[0]
                    parts = ts_clean.split(":")
                    try:
                        if len(parts) == 3:
                            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
                            ts_label = f"[{h * 60 + m}:{s:02d}]"
                        elif len(parts) == 2:
                            m, s = int(parts[0]), int(parts[1])
                            ts_label = f"[{m}:{s:02d}]"
                    except (ValueError, IndexError):
                        pass
                    continue
                texts.append(stripped)
            if texts:
                line_text = " ".join(texts)
                lines.append(f"{ts_label} {line_text}" if ts_label else line_text)
        return "\n".join(lines)[:max_chars]

    return content[:max_chars]


def _strip_fences(text: str) -> str:
    """Remove any ``` code-fence wrappers the LLM may have added."""
    text = text.strip()
    # Remove opening fence (```plaintext, ```text, ``` etc.)
    text = _re.sub(r'^```[a-z]*\n?', '', text)
    # Remove closing fence
    text = _re.sub(r'\n?```$', '', text)
    # Also strip any stray ** bold markdown on speaker labels
    text = _re.sub(r'\*\*([^*]+):\*\*', r'\1:', text)
    return text.strip()


def _find_call_dir(pair_slug: str, call_id: str) -> Optional[Path]:
    parts = pair_slug.split("/", 1)
    if len(parts) != 2:
        return None
    agent, customer = parts
    d = settings.agents_dir / agent / customer / call_id
    return d if d.is_dir() else None


def _llm_call(system_prompt: str, user_message: str, model: str) -> str:
    import sys
    sys.path.insert(0, str(settings.project_root))
    from shared.llm_client import LLMClient

    # Auto-detect provider from model name
    if model.startswith("claude-"):
        provider = "anthropic"
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        if not api_key:
            raise RuntimeError("ANTHROPIC_API_KEY not set")
    elif model.startswith("gemini"):
        provider = "gemini"
        api_key = os.environ.get("GEMINI_API_KEY", "")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
    elif model.startswith("grok"):
        provider = "grok"
        from shared.llm_client import resolve_grok_key
        api_key = resolve_grok_key()
        if not api_key:
            raise RuntimeError("GROK_API_KEY / XAI_API_KEY not set")
    else:
        provider = "openai"
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY not set")

    print(f"[LLM] {model} — {len(user_message):,} chars input — calling API …")
    client = LLMClient(provider=provider, api_key=api_key)
    resp = client.chat_completion(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_message},
        ],
        temperature=0.0,
    )
    result = _strip_fences(resp.choices[0].message.content)
    print(f"[LLM] {model} — done, {len(result):,} chars output")
    return result


def _save_result(call_dir: Path, filename: str, content: str, meta: dict) -> Path:
    out_dir = call_dir / "transcribed" / "llm_final"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / filename).write_text(content, encoding="utf-8")
    (out_dir / filename.replace(".txt", "_meta.json")).write_text(
        json.dumps(meta, indent=2, default=str), encoding="utf-8"
    )
    return out_dir / filename


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("/tx-stats")
def tx_stats():
    """Return transcription counts per agent/customer pair.

    Response: {"Agent/Customer": {"transcribed": N, "total": M}, ...}
    A call counts as transcribed if it has smoothed.txt or voted.txt.
    """
    agents_dir = settings.agents_dir
    result: dict[str, dict] = {}
    if not agents_dir.exists():
        return result
    for agent_dir in agents_dir.iterdir():
        if not agent_dir.is_dir() or agent_dir.name.startswith(("_", ".")):
            continue
        for cust_dir in agent_dir.iterdir():
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            total = transcribed = 0
            for call_dir in cust_dir.iterdir():
                if not call_dir.is_dir() or call_dir.name.startswith("."):
                    continue
                total += 1
                llm = call_dir / "transcribed" / "llm_final"
                if (llm / "smoothed.txt").exists() or (llm / "voted.txt").exists():
                    transcribed += 1
            if total > 0:
                result[f"{agent_dir.name}/{cust_dir.name}"] = {
                    "transcribed": transcribed,
                    "total": total,
                }
    return result


@router.get("/pairs")
def list_pairs():
    """List all agent/customer pairs that have at least one call with transcribed data."""
    agents_dir = settings.agents_dir
    results = []
    if not agents_dir.exists():
        return results
    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith(("_", ".")):
            continue
        customers = []
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            has_transcripts = any(
                (call_dir / "transcribed").exists()
                for call_dir in cust_dir.iterdir()
                if call_dir.is_dir() and not call_dir.name.startswith(".")
            )
            if has_transcripts:
                customers.append(cust_dir.name)
        if customers:
            results.append({"agent": agent_dir.name, "customers": customers})
    return results


@router.get("/calls")
def list_calls(
    agent: str = Query(""),
    customer: str = Query(""),
):
    """List all calls (optionally filtered by agent/customer) with transcript status."""
    agents_dir = settings.agents_dir
    results = []
    agent_lower = agent.lower()

    if not agents_dir.exists():
        return results

    for agent_dir in sorted(agents_dir.iterdir()):
        if not agent_dir.is_dir() or agent_dir.name.startswith(("_", ".")):
            continue
        if agent_lower and agent_lower not in agent_dir.name.lower():
            continue
        for cust_dir in sorted(agent_dir.iterdir()):
            if not cust_dir.is_dir() or cust_dir.name.startswith("."):
                continue
            if customer and customer.lower() not in cust_dir.name.lower():
                continue
            # Load call metadata (duration_s, started_at) once per pair
            calls_meta: dict[str, dict] = {}
            calls_path = cust_dir / "calls.json"
            if calls_path.exists():
                try:
                    for c in json.loads(calls_path.read_text()):
                        cid = str(c.get("call_id", ""))
                        if cid:
                            calls_meta[cid] = c
                except Exception:
                    pass
            for call_dir in sorted(cust_dir.iterdir()):
                if not call_dir.is_dir() or call_dir.name.startswith("."):
                    continue
                call_id = call_dir.name
                pair_slug = f"{agent_dir.name}/{cust_dir.name}"
                t_dir = call_dir / "transcribed"
                if not t_dir.exists():
                    continue

                # Pipeline final
                final_dir = t_dir / "final"
                has_pipeline_final = final_dir.exists() and any(final_dir.iterdir())
                pipeline_final_files = []
                if has_pipeline_final:
                    for f in sorted(final_dir.iterdir()):
                        if f.is_file():
                            pipeline_final_files.append({
                                "name": f.name,
                                "path": str(f),
                                "size_bytes": f.stat().st_size,
                            })

                # LLM final
                llm_dir = t_dir / "llm_final"
                has_voted   = (llm_dir / "voted.txt").exists()
                has_smoothed = (llm_dir / "smoothed.txt").exists()
                voted_at = None
                smoothed_at = None
                voted_sources: list[str] = []
                smoothed_source: Optional[str] = None

                if has_voted:
                    meta_p = llm_dir / "voted_meta.json"
                    if meta_p.exists():
                        try:
                            m = json.loads(meta_p.read_text())
                            voted_at = m.get("created_at")
                            voted_sources = m.get("source_labels", [])
                        except Exception:
                            pass

                if has_smoothed:
                    meta_p = llm_dir / "smoothed_meta.json"
                    if meta_p.exists():
                        try:
                            m = json.loads(meta_p.read_text())
                            smoothed_at = m.get("created_at")
                            smoothed_source = m.get("source_label")
                        except Exception:
                            pass

                # Count engine transcripts (old layout: full/speaker_N/merged; new layout: source_N/)
                source_count = 0
                if t_dir.exists():
                    source_count += sum(
                        1 for src in ("full", "speaker_0", "speaker_1", "merged")
                        for engine_dir in (t_dir / src).glob("*") if engine_dir.is_dir()
                    )
                    # New layout: source_1/, source_2/, etc.
                    source_count += sum(1 for d in t_dir.iterdir() if d.is_dir() and d.name.startswith("source_"))

                # Final transcript (explicitly marked)
                has_final = (llm_dir / "final_transcript.txt").exists()
                final_at = None
                final_type: Optional[str] = None
                final_source_count = 0
                final_source_labels: list[str] = []
                final_model: Optional[str] = None
                if has_final:
                    final_meta_p = llm_dir / "final_meta.json"
                    if final_meta_p.exists():
                        try:
                            fm = json.loads(final_meta_p.read_text())
                            final_at = fm.get("finalized_at")
                            final_type = fm.get("source_type")
                            final_source_count = fm.get("source_count", 0)
                            final_source_labels = fm.get("source_labels", [])
                            final_model = fm.get("model")
                        except Exception:
                            pass

                call_meta = calls_meta.get(call_id, {})
                results.append({
                    "call_id": call_id,
                    "pair_slug": pair_slug,
                    "has_pipeline_final": has_pipeline_final,
                    "pipeline_final_files": pipeline_final_files,
                    "has_llm_voted": has_voted,
                    "has_llm_smoothed": has_smoothed,
                    "voted_at": voted_at,
                    "smoothed_at": smoothed_at,
                    "voted_sources": voted_sources,
                    "smoothed_source": smoothed_source,
                    "voted_path": str(llm_dir / "voted.txt") if has_voted else None,
                    "smoothed_path": str(llm_dir / "smoothed.txt") if has_smoothed else None,
                    "has_final": has_final,
                    "final_at": final_at,
                    "final_type": final_type,
                    "final_source_count": final_source_count,
                    "final_source_labels": final_source_labels,
                    "final_model": final_model,
                    "final_path": str(llm_dir / "final_transcript.txt") if has_final else None,
                    "source_count": source_count,
                    "duration_s": call_meta.get("duration_s"),
                    "started_at": call_meta.get("started_at"),
                })

    return results


class VoteRequest(BaseModel):
    call_id: str
    pair_slug: str
    transcript_paths: list[str]
    keywords: list[str] = []
    user_prompt: str = ""
    model: str = "gpt-5.4"
    speaker_a: str = "Speaker A"
    speaker_b: str = "Speaker B"


class SmoothRequest(BaseModel):
    call_id: str
    pair_slug: str
    source_path: str           # which transcript to smooth
    source_label: str = ""
    keywords: list[str] = []
    instructions: str = ""
    model: str = "gpt-5.4"
    speaker_a: str = "Agent"
    speaker_b: str = "Customer"


@router.post("/vote")
async def vote_transcript(req: VoteRequest):
    """LLM voting: merge multiple engine transcripts into one accurate final transcript."""
    if not req.transcript_paths:
        raise HTTPException(400, "transcript_paths is required")

    call_dir = _find_call_dir(req.pair_slug, req.call_id)
    if not call_dir:
        raise HTTPException(404, f"Call directory not found: {req.pair_slug}/{req.call_id}")

    # Build source sections
    sources_text = ""
    source_labels = []
    for i, raw_path in enumerate(req.transcript_paths, 1):
        p = Path(raw_path)
        if not p.exists():
            continue
        # Derive label from path: …/full/elevenlabs/original.json → "full/elevenlabs/original"
        try:
            rel = p.relative_to(call_dir / "transcribed")
            label = str(rel.with_suffix(""))
        except ValueError:
            label = p.stem
        source_labels.append(label)
        text = _transcript_to_text(p)
        sources_text += f"\n\n--- Source {i}: {label} ---\n{text}"

    if not sources_text.strip():
        raise HTTPException(422, "Could not read any of the specified transcript files")

    kw_line = ""
    if req.keywords:
        kw_line = f"\nDomain keywords (use these exact spellings): {', '.join(req.keywords)}\n"

    user_message = (
        f"Agent: {req.speaker_a} | Customer: {req.speaker_b}\n"
        f"{kw_line}"
        + (f"Additional instructions: {req.user_prompt}\n" if req.user_prompt.strip() else "")
        + f"\nTranscript sources ({len(source_labels)}):{sources_text}"
    )

    print(f"[vote] {req.call_id} — start · {len(source_labels)} source(s): {', '.join(source_labels[:3])}{'…' if len(source_labels) > 3 else ''}")
    loop = asyncio.get_event_loop()
    vote_system = _build_vote_system(req.speaker_a, req.speaker_b)
    raw_content = await loop.run_in_executor(
        None,
        lambda: _llm_call(vote_system, user_message, req.model),
    )
    # Use the first source text to inject timestamps if LLM dropped them
    first_source_text = _transcript_to_text(Path(req.transcript_paths[0])) if req.transcript_paths else ""
    content = _ensure_timestamps(first_source_text, raw_content)
    print(f"[vote] {req.call_id} — saving voted.txt …")

    meta = {
        "type": "voted",
        "call_id": req.call_id,
        "pair_slug": req.pair_slug,
        "source_paths": req.transcript_paths,
        "source_labels": source_labels,
        "keywords": req.keywords,
        "user_prompt": req.user_prompt,
        "model": req.model,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    out_path = _save_result(call_dir, "voted.txt", content, meta)

    return {
        "content": content,
        "path": str(out_path),
        "source_labels": source_labels,
        "model": req.model,
    }


@router.post("/smooth")
async def smooth_transcript(req: SmoothRequest):
    """LLM smoothing: clean up numbers, spelling, formatting in an existing transcript."""
    p = Path(req.source_path)
    if not p.exists():
        raise HTTPException(404, f"Source transcript not found: {req.source_path}")

    call_dir = _find_call_dir(req.pair_slug, req.call_id)
    if not call_dir:
        raise HTTPException(404, f"Call directory not found: {req.pair_slug}/{req.call_id}")

    source_text = _transcript_to_text(p)
    if not source_text.strip():
        raise HTTPException(422, "Source transcript appears to be empty")

    kw_line = ""
    if req.keywords:
        kw_line = f"Domain keywords (preserve these exact spellings): {', '.join(req.keywords)}\n"

    user_message = (
        f"{kw_line}"
        + (f"Additional instructions: {req.instructions}\n" if req.instructions.strip() else "")
        + f"\nTranscript to clean up:\n\n{source_text}"
    )

    src_label = req.source_label or Path(req.source_path).name
    print(f"[smooth] {req.call_id} — start · source: {src_label}, {len(source_text):,} chars, model: {req.model}")
    loop = asyncio.get_event_loop()
    smooth_system = _build_smooth_system(req.speaker_a, req.speaker_b)
    raw_content = await loop.run_in_executor(
        None,
        lambda: _llm_call(smooth_system, user_message, req.model),
    )
    content = _ensure_timestamps(source_text, raw_content)
    print(f"[smooth] {req.call_id} — saving smoothed.txt …")

    meta = {
        "type": "smoothed",
        "call_id": req.call_id,
        "pair_slug": req.pair_slug,
        "source_path": req.source_path,
        "source_label": req.source_label or Path(req.source_path).stem,
        "keywords": req.keywords,
        "instructions": req.instructions,
        "model": req.model,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    out_path = _save_result(call_dir, "smoothed.txt", content, meta)

    return {
        "content": content,
        "path": str(out_path),
        "source_label": meta["source_label"],
        "model": req.model,
    }


class SetFinalRequest(BaseModel):
    call_id: str
    pair_slug: str
    source: str  # "voted" | "smoothed"


@router.post("/set-final")
def set_final_transcript(req: SetFinalRequest):
    """Mark a voted or smoothed transcript as the definitive final transcript for this call."""
    if req.source not in ("voted", "smoothed"):
        raise HTTPException(400, "source must be 'voted' or 'smoothed'")

    call_dir = _find_call_dir(req.pair_slug, req.call_id)
    if not call_dir:
        raise HTTPException(404, f"Call directory not found: {req.pair_slug}/{req.call_id}")

    llm_dir = call_dir / "transcribed" / "llm_final"
    src_file = llm_dir / f"{req.source}.txt"
    src_meta_file = llm_dir / f"{req.source}_meta.json"

    if not src_file.exists():
        raise HTTPException(404, f"{req.source}.txt not found — run the {req.source} step first")

    content = src_file.read_text(encoding="utf-8")
    src_meta: dict = {}
    if src_meta_file.exists():
        try:
            src_meta = json.loads(src_meta_file.read_text())
        except Exception:
            pass

    # Build provenance metadata
    final_meta = {
        "type": "final",
        "source_type": req.source,
        "call_id": req.call_id,
        "pair_slug": req.pair_slug,
        "model": src_meta.get("model", ""),
        "finalized_at": datetime.now(timezone.utc).isoformat(),
        "source_created_at": src_meta.get("created_at"),
        # Voted: N sources; Smoothed: 1 source (the smooth source label)
        "source_count": len(src_meta.get("source_labels", [])) if req.source == "voted" else 1,
        "source_labels": src_meta.get("source_labels", []) if req.source == "voted"
                         else ([src_meta.get("source_label", "")] if src_meta.get("source_label") else []),
        "smooth_source_label": src_meta.get("source_label") if req.source == "smoothed" else None,
    }

    llm_dir.mkdir(parents=True, exist_ok=True)
    (llm_dir / "final_transcript.txt").write_text(content, encoding="utf-8")
    (llm_dir / "final_meta.json").write_text(json.dumps(final_meta, indent=2, default=str), encoding="utf-8")

    return {"ok": True, "path": str(llm_dir / "final_transcript.txt"), "meta": final_meta}


@router.get("/content")
def serve_content(path: str = Query(...)):
    """Serve an LLM-final transcript file (restricted to ui/data)."""
    p = Path(path).resolve()
    if not str(p).startswith(str(settings.ui_data_dir.resolve())):
        raise HTTPException(403, "Access denied")
    if not p.exists():
        raise HTTPException(404, "File not found")
    return PlainTextResponse(p.read_text(encoding="utf-8", errors="replace"))


# ── Batch endpoints ─────────────────────────────────────────────────────────────

class BatchCallSpec(BaseModel):
    call_id: str
    pair_slug: str


class BatchVoteRequest(BaseModel):
    calls: list[BatchCallSpec]
    keywords: list[str] = []
    user_prompt: str = ""
    model: str = "gpt-5.4"
    speaker_a: str = "Speaker A"
    speaker_b: str = "Speaker B"


class BatchSmoothRequest(BaseModel):
    calls: list[BatchCallSpec]
    keywords: list[str] = []
    instructions: str = ""
    model: str = "gpt-5.4"
    source_preference: str = "voted"  # "voted" | "pipeline_final"
    speaker_a: str = "Agent"
    speaker_b: str = "Customer"


async def _vote_one(spec: BatchCallSpec, req: BatchVoteRequest) -> dict:
    call_dir = _find_call_dir(spec.pair_slug, spec.call_id)
    if not call_dir:
        return {"call_id": spec.call_id, "success": False, "error": "Call directory not found"}

    t_dir = call_dir / "transcribed"
    final_dir = t_dir / "final"
    paths: list[str] = []
    if final_dir.exists():
        paths = [str(f) for f in sorted(final_dir.iterdir()) if f.is_file()]

    # Fall back to all engine transcripts
    if not paths:
        for src in ("full", "speaker_0", "speaker_1", "merged"):
            src_dir = t_dir / src
            if src_dir.exists():
                for engine_dir in src_dir.iterdir():
                    if engine_dir.is_dir():
                        for f in sorted(engine_dir.iterdir()):
                            if f.is_file():
                                paths.append(str(f))

    if not paths:
        print(f"[vote-batch] {spec.call_id} — skipped, no transcript sources found")
        return {"call_id": spec.call_id, "success": False, "error": "No transcript sources found"}

    print(f"[vote-batch] {spec.call_id} — starting ({len(paths)} source(s))")
    vote_req = VoteRequest(
        call_id=spec.call_id,
        pair_slug=spec.pair_slug,
        transcript_paths=paths,
        keywords=req.keywords,
        user_prompt=req.user_prompt,
        model=req.model,
        speaker_a=req.speaker_a,
        speaker_b=req.speaker_b,
    )
    try:
        result = await vote_transcript(vote_req)
        print(f"[vote-batch] {spec.call_id} — ✅ done")
        return {"call_id": spec.call_id, "success": True, **result}
    except Exception as e:
        print(f"[vote-batch] {spec.call_id} — ERROR: {e}")
        return {"call_id": spec.call_id, "success": False, "error": str(e)}


async def _smooth_one(spec: BatchCallSpec, req: BatchSmoothRequest) -> dict:
    call_dir = _find_call_dir(spec.pair_slug, spec.call_id)
    if not call_dir:
        return {"call_id": spec.call_id, "success": False, "error": "Call directory not found"}

    t_dir = call_dir / "transcribed"
    llm_dir = t_dir / "llm_final"

    source_path: Optional[str] = None
    source_label = ""

    if req.source_preference == "voted" and (llm_dir / "voted.txt").exists():
        source_path = str(llm_dir / "voted.txt")
        source_label = "LLM Voted"
    else:
        final_dir = t_dir / "final"
        if final_dir.exists():
            finals = sorted([f for f in final_dir.iterdir() if f.is_file()])
            if finals:
                source_path = str(finals[0])
                source_label = f"Pipeline Final: {finals[0].name}"

    # Fallback: use any available engine transcript (e.g. single ElevenLabs run, no voting needed)
    if not source_path:
        # Check full/ (old pipeline layout)
        full_dir = t_dir / "full"
        if full_dir.exists():
            jsons = sorted(full_dir.rglob("*.json"))
            if jsons:
                source_path = str(jsons[0])
                source_label = f"Engine: {jsons[0].parent.name}/{jsons[0].stem}"

    # Fallback: source_N/elevenlabs/original.json (new pipeline layout)
    if not source_path:
        el_jsons = sorted(t_dir.rglob("elevenlabs/original.json"))
        if el_jsons:
            source_path = str(el_jsons[0])
            source_label = f"ElevenLabs: {el_jsons[0].parents[1].name}"

    if not source_path:
        print(f"[smooth-batch] {spec.call_id} — skipped, no source transcript found")
        return {"call_id": spec.call_id, "success": False, "error": "No source transcript found for smoothing"}

    print(f"[smooth-batch] {spec.call_id} — starting, source: {source_label}")
    smooth_req = SmoothRequest(
        call_id=spec.call_id,
        pair_slug=spec.pair_slug,
        source_path=source_path,
        source_label=source_label,
        keywords=req.keywords,
        instructions=req.instructions,
        model=req.model,
        speaker_a=req.speaker_a,
        speaker_b=req.speaker_b,
    )
    try:
        result = await smooth_transcript(smooth_req)
        print(f"[smooth-batch] {spec.call_id} — ✅ done")
        return {"call_id": spec.call_id, "success": True, **result}
    except Exception as e:
        print(f"[smooth-batch] {spec.call_id} — ERROR: {e}")
        return {"call_id": spec.call_id, "success": False, "error": str(e)}


@router.post("/vote-batch")
async def vote_batch(req: BatchVoteRequest):
    """LLM voting on multiple calls in parallel (auto-selects pipeline final sources)."""
    if not req.calls:
        raise HTTPException(400, "calls list is empty")
    print(f"[vote-batch] starting {len(req.calls)} call(s), model: {req.model}")
    sem = asyncio.Semaphore(8)
    async def _limited(spec: BatchCallSpec):
        async with sem:
            await asyncio.sleep(0.5)
            return await _vote_one(spec, req)
    results = list(await asyncio.gather(*[_limited(spec) for spec in req.calls]))
    done = sum(1 for r in results if r.get("success"))
    print(f"[vote-batch] finished — {done}/{len(results)} succeeded")
    return {"results": results, "done": done, "failed": len(results) - done}


@router.post("/smooth-batch")
async def smooth_batch(req: BatchSmoothRequest):
    """LLM smoothing on multiple calls in parallel, max 8 concurrent LLM calls."""
    if not req.calls:
        raise HTTPException(400, "calls list is empty")
    print(f"[smooth-batch] starting {len(req.calls)} call(s), model: {req.model}")
    sem = asyncio.Semaphore(8)
    async def _limited(spec: BatchCallSpec):
        async with sem:
            await asyncio.sleep(0.5)
            return await _smooth_one(spec, req)
    results = list(await asyncio.gather(*[_limited(spec) for spec in req.calls]))
    done = sum(1 for r in results if r.get("success"))
    print(f"[smooth-batch] finished — {done}/{len(results)} succeeded")
    return {"results": results, "done": done, "failed": len(results) - done}
