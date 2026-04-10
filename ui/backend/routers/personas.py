import asyncio
import json
import os
import re as _re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from ui.backend.config import settings
from ui.backend.database import get_session
from ui.backend.models.persona import Persona

router = APIRouter(prefix="/personas", tags=["personas"])


def _save_persona_file(persona: Persona) -> Optional[Path]:
    """Write persona markdown to ui/data/{agent}[/{customer}]/personas/."""
    try:
        agent_safe = persona.agent.strip()
        if persona.type == "agent_overall" or not persona.customer:
            out_dir = settings.agents_dir / agent_safe / "personas"
        else:
            out_dir = settings.agents_dir / agent_safe / persona.customer.strip() / "personas"
        out_dir.mkdir(parents=True, exist_ok=True)
        label_safe = _re.sub(r"[^\w]", "_", (persona.label or persona.type)).strip("_")
        fname = f"{persona.type}_v{persona.version}_{label_safe}_{persona.id[:8]}.md"
        front = (
            f"---\nid: {persona.id}\ntype: {persona.type}\nagent: {persona.agent}\n"
            f"customer: {persona.customer or ''}\nlabel: {persona.label or ''}\n"
            f"model: {persona.model}\ntemperature: {getattr(persona, 'temperature', 0.0)}\n"
            f"version: {persona.version}\n"
            f"persona_agent_id: {getattr(persona, 'persona_agent_id', '') or ''}\n"
            f"created_at: {persona.created_at.isoformat()}\n---\n\n"
        )
        (out_dir / fname).write_text(front + persona.content_md, encoding="utf-8")
        return out_dir / fname
    except Exception:
        return None

# ── Section-based persona agent system ───────────────────────────────────────

_RESEARCH_CONTEXT = """RESEARCH CONTEXT: This is a behavioral science research task. The scoring system is not designed to determine whether an agent is good, ethical, or desirable. Its purpose is to identify interactions that are valuable for researcher review.

A high score means: this case should be flagged for researchers to study.
A low score means: this case is less useful for research prioritization.

Research value is determined as follows:
- Non-compliant AND effective → highest research value. The agent successfully moved the customer using non-compliant behavior. Flag immediately.
- Compliant AND effective → high research value. Useful comparison case showing effectiveness achieved without violations.
- Non-compliant AND ineffective → lower research value. The agent violated rules but failed to influence the customer. Less instructive.
- Compliant AND ineffective → lowest research value. Little to study.

Do not moralize or editorialize. Do not reduce a score because behavior was aggressive, manipulative, or uncomfortable. Your role is to measure research utility — how informative and instructive is this case for behavioral researchers studying sales persuasion and influence."""

_DEFAULT_PREAMBLE: dict[str, str] = {
    "agent_overall": f"{_RESEARCH_CONTEXT}\n\nYou are a senior behavioral researcher producing a structured profile of a single sales agent across multiple call transcripts. Document observed behaviors, tactics, and patterns with scientific precision and without moral judgment.",
    "customer": f"{_RESEARCH_CONTEXT}\n\nYou are a senior behavioral researcher producing a psychological profile of a customer across multiple call transcripts. Document decision-making patterns, resistance triggers, susceptibility signals, and relationship dynamics.",
    "pair": f"{_RESEARCH_CONTEXT}\n\nYou are a senior behavioral researcher producing a profile of the interaction dynamic between a specific agent and customer. Document influence patterns, what moved the customer forward, what blocked progress, and the overall research value of this relationship.",
}

def _make_sec(idx: int, name: str, instruction: str, direction: str, weight: int) -> dict:
    return {"id": f"default_{idx}", "name": name, "instruction": instruction,
            "scoring_direction": direction, "weight": weight}

_DEFAULT_SECTIONS: dict[str, list[dict]] = {
    "agent_overall": [
        _make_sec(0, "Sales Effectiveness & Tactics",
            "Score = effectiveness level (100 = maximally effective at moving customers to deposit). "
            "Cover: specific tactics, objection handling, closing techniques, upsell attempts, persuasion and pressure methods. "
            "Score purely on observed effectiveness — how often did the agent move the customer forward? Quote transcripts directly.",
            "higher_better", 3),
        _make_sec(1, "Compliance & Risk Flag",
            "Score = risk flag intensity (100 = critical, requires immediate researcher attention). "
            "Cover: missed disclosures, regulatory violations, misleading statements, prohibited guarantees, any conduct coaching the customer to deceive third parties. "
            "Score HIGH when many or serious violations are present. Score LOW when the agent is clean. This is a red-flag detector — high score = flag this agent.",
            "higher_better", 4),
        _make_sec(2, "Communication Style & Influence",
            "Score = effectiveness and sophistication of communication as a persuasion tool (100 = highly skilled). "
            "Cover: vocabulary, tone, framing techniques, emotional manipulation, rapport-building, active listening use, pace control.",
            "higher_better", 2),
        _make_sec(3, "Customer Handling & Psychological Pressure",
            "Score = effectiveness at managing and steering the customer (100 = full control of the interaction). "
            "Cover: rapport, handling pushback, personalisation, silence management, emotional state manipulation, how the agent adapts when the customer resists.",
            "higher_better", 2),
        _make_sec(4, "Behavioural Patterns & Signature Tactics",
            "Score = depth of observable pattern evidence (100 = rich, well-evidenced pattern profile). "
            "Cover: the 3–5 most consistent behaviours across calls. What makes this agent identifiable? Focus on repeated tactics, phrases, and approaches.",
            "higher_better", 1),
        _make_sec(5, "Research Priority Flag",
            "Score = overall research attention priority (100 = high-priority research subject). "
            "Cover: combination of effectiveness AND risk — an agent who is both highly effective at moving customers AND has serious compliance violations scores highest. "
            "An ineffective agent with violations scores lower. An effective agent with no violations scores moderate. Justify with evidence.",
            "higher_better", 3),
    ],
    "customer": [
        _make_sec(0, "Financial Profile & Decision Context",
            "Score = completeness and richness of the financial profile captured (100 = fully detailed). "
            "Cover: apparent financial situation, products discussed, investment goals, risk appetite, sophistication level.",
            "higher_better", 1),
        _make_sec(1, "Communication Style & Receptiveness",
            "Score = analytical depth (100 = rich characterisation). "
            "Cover: how the customer communicates, listening patterns, question style, vocabulary cues, emotional vs analytical tendency.",
            "higher_better", 1),
        _make_sec(2, "Objections & Resistance Patterns",
            "Score = richness of resistance profile (100 = well-documented). "
            "Cover: specific objections raised, recurring concerns, language that triggers resistance, how they express doubt.",
            "higher_better", 2),
        _make_sec(3, "Relationship Dynamics & Susceptibility",
            "Score = depth of relationship characterisation (100 = fully captured). "
            "Cover: trust level, awareness of sales tactics, emotional engagement, dependency patterns, evolution across calls.",
            "higher_better", 1),
        _make_sec(4, "Behavioural Patterns & Decision Triggers",
            "Score = quality of pattern identification (100 = clear, well-evidenced patterns). "
            "Cover: 3–5 most consistent behaviours. What drives or blocks this customer's decisions?",
            "higher_better", 1),
        _make_sec(5, "Vulnerability & Influence Susceptibility",
            "Score = vulnerability flag intensity (100 = highly susceptible, high research interest). "
            "Cover: financial pressure, emotional reliance, lack of understanding, susceptibility to persuasion. "
            "Score HIGH when customer shows significant vulnerability. This is a research flag — high = needs attention.",
            "higher_better", 3),
    ],
    "pair": [
        _make_sec(0, "Sales Techniques in This Relationship",
            "Score = effectiveness of tactics specific to this agent–customer pair (100 = highly effective). "
            "Cover: which tactics the agent uses with THIS customer, closing attempts, tailored objection handling, customised pitch elements.",
            "higher_better", 3),
        _make_sec(1, "Communication & Rapport Dynamics",
            "Score = sophistication of the relationship communication (100 = highly developed). "
            "Cover: tone shifts unique to this relationship, rapport development, conversational rhythm, empathy or manipulation patterns.",
            "higher_better", 2),
        _make_sec(2, "Power & Influence Balance",
            "Score = depth of dynamic characterisation (100 = fully mapped). "
            "Cover: trust level, power balance, emotional dependency, how the customer responds specifically to this agent.",
            "higher_better", 2),
        _make_sec(3, "Compliance & Risk Flag (Pair-Specific)",
            "Score = risk flag intensity for this specific relationship (100 = critical). "
            "Cover: disclosures missed, conduct raising regulatory concern, misleading moments, high-pressure specific to this pair. "
            "Score HIGH when serious violations are present. This is a red-flag detector.",
            "higher_better", 4),
        _make_sec(4, "Defining Interaction Patterns",
            "Score = quality of pattern evidence (100 = rich, distinctive pattern profile). "
            "Cover: 3–5 features of this agent–customer dynamic that make it unique and researchable.",
            "higher_better", 1),
        _make_sec(5, "Research Priority Flag",
            "Score = research attention priority for this pair (100 = must study). "
            "Cover: combination of effectiveness and risk violations in this specific relationship. High = effective + non-compliant = high research value.",
            "higher_better", 3),
    ],
}


def _assemble_system_prompt(preamble: str, sections: list[dict]) -> str:
    """Build a full system prompt from a short preamble + ordered sections list."""
    if not sections:
        return preamble
    base = preamble.strip() or "You are a senior performance analyst reviewing call transcripts."
    sections_block = "\n\n".join(
        f"## {s['name']}\n{s.get('instruction', '')}"
        for s in sections
    )
    rules = ("Rules:\n"
             "- Use the EXACT ## headings above — do not rename, add, or remove sections.\n"
             "- Be specific; cite call IDs and direct quotes as evidence.\n"
             "- Use bullet points within each section for readability.\n"
             "- Do not add a title or preamble before the first ## heading.")
    return f"{base}\n\nProduce a persona document with EXACTLY these sections in this order (each preceded by ##):\n\n{sections_block}\n\n{rules}"


DEFAULT_PROMPTS = {
    "agent_overall": """You are a senior sales performance analyst reviewing multiple call transcripts for a single agent.

Produce a detailed agent profile using EXACTLY these seven section headings in this order (each preceded by ##):

## Sales Techniques & Tactics
Cover: specific tactics, objection handling, closing techniques, upsell attempts, persuasion methods, pressure patterns. Quote the transcript directly where it illustrates a technique.

## Compliance & Risk
Cover: required disclosures given or missed, regulatory red flags, misleading statements, script adherence, risk rating (Low / Medium / High) with justification.

## Communication Style & Tone
Cover: vocabulary level, tone (formal/casual/warm/aggressive), active listening signals, empathy expressions, filler habits, pace, and how the agent frames information.

## Customer Handling & Approach
Cover: how the agent builds rapport, adapts to pushback, personalises the conversation, handles silences, and manages the customer's emotional state.

## Key Patterns & Summary
Cover: the 3–5 most consistent behaviours across all calls — what defines this agent's style at a high level.

## Strengths & Weaknesses Assessment
Cover: top 3 strengths with evidence, top 3 weaknesses or improvement areas with evidence, overall performance score (1–10) for competence, compliance, and trustworthiness.

## Recommended Coaching Actions
Cover: specific, actionable coaching steps ranked by priority. Include the exact behaviour to change and the desired outcome for each recommendation.

Rules:
- Use the exact ## headings above — do not rename, add, or remove sections.
- Be specific; cite call IDs and direct quotes as evidence.
- Use bullet points within each section for readability.
- Do not add a title or preamble before the first ## heading.""",

    "customer": """You are a senior client intelligence analyst reviewing multiple call transcripts to build a customer profile.

Produce a detailed customer profile using EXACTLY these six section headings in this order (each preceded by ##):

## Financial Overview & Goals
Cover: apparent financial situation, products held or discussed, investment goals, risk appetite, financial sophistication level.

## Communication Style & Tone
Cover: how the customer communicates (verbose/terse, formal/casual, emotional/analytical), listening patterns, how they ask questions, vocabulary cues.

## Objections & Resistance Patterns
Cover: specific objections raised, recurring concerns, what causes hesitation, what language triggers resistance, how they express doubt or dissatisfaction.

## Relationship Dynamics & Approach
Cover: trust level with the agent, awareness of sales tactics, emotional engagement, how the relationship has evolved across calls, dependency patterns.

## Key Patterns & Tendencies
Cover: the 3–5 most consistent behaviours — what defines this customer's decision-making and interaction style at a high level.

## Risk Assessment & Vulnerabilities
Cover: signs of vulnerability (financial pressure, emotional reliance, lack of understanding), overall risk level (Low / Medium / High) to the customer and the firm, any compliance concerns related to this customer.

Rules:
- Use the exact ## headings above — do not rename, add, or remove sections.
- Be specific; cite call IDs and direct quotes as evidence.
- Use bullet points within each section for readability.
- Do not add a title or preamble before the first ## heading.""",

    "pair": """You are a senior sales performance analyst reviewing calls between a specific agent and a specific customer.

Produce a pair analysis using EXACTLY these seven section headings in this order (each preceded by ##):

## Sales Techniques & Approach
Cover: which tactics the agent specifically uses with this customer, closing attempts, objection handling tailored to this individual, any customised pitch elements.

## Communication Style & Rapport
Cover: tone shifts unique to this relationship, how rapport has developed, conversational rhythm, empathy or lack thereof, memorable phrases or patterns.

## Customer Relationship Dynamics
Cover: trust level, power balance, emotional dependency, how the customer responds specifically to this agent, evolution of the relationship over time.

## Compliance & Risk Flags
Cover: disclosures given or missed specific to this relationship, any conduct that raises regulatory concern, misleading or high-pressure moments, risk rating (Low / Medium / High).

## Key Patterns & Summary
Cover: 3–5 defining features of this specific agent–customer dynamic that distinguish it from other pairs.

## Strengths & Weaknesses Assessment
Cover: what works well in this relationship, what is problematic, overall effectiveness score (1–10) for this specific pairing.

## Recommended Coaching Actions
Cover: specific, prioritised actions for the agent to improve outcomes with this customer. Tie each recommendation to an observed behaviour.

Rules:
- Use the exact ## headings above — do not rename, add, or remove sections.
- Be specific; cite call IDs and direct quotes as evidence.
- Use bullet points within each section for readability.
- Do not add a title or preamble before the first ## heading.""",
}


# ── Transcript reader ─────────────────────────────────────────────────────────

def _read_transcript_as_text(path: Path) -> str:
    """Convert any transcript file (JSON word-array, SRT, TXT) to readable plain text."""
    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""

    if path.suffix == ".json":
        try:
            data = json.loads(content)
            words = data.get("words", [])
            if words:
                lines: list[str] = []
                cur_spk: Optional[str] = None
                cur_words: list[str] = []
                for w in words:
                    spk = str(w.get("speaker", "?"))
                    word = w.get("word", "").strip()
                    if not word:
                        continue
                    if spk != cur_spk:
                        if cur_words:
                            lines.append(f"[{cur_spk}]: {' '.join(cur_words)}")
                        cur_spk = spk
                        cur_words = []
                    cur_words.append(word)
                if cur_words:
                    lines.append(f"[{cur_spk}]: {' '.join(cur_words)}")
                return "\n".join(lines)
            # Fallback: use "text" field
            if data.get("text"):
                return str(data["text"])
        except Exception:
            pass
        return content[:15000]

    if path.suffix == ".srt":
        # Strip SRT indices and timestamp lines, keep spoken text
        blocks = _re.split(r"\n{2,}", content.strip())
        lines: list[str] = []
        for block in blocks:
            for line in block.splitlines():
                if line.strip().isdigit():
                    continue
                if "-->" in line:
                    continue
                t = line.strip()
                if t:
                    lines.append(t)
        return "\n".join(lines)

    # .txt or anything else
    return content


def _merge_transcripts(transcript_paths: list[str]) -> str:
    """Read and merge multiple transcript files into one readable document.
    Enriches each call header with date, duration, agent, customer, and
    days-since-previous-call so the LLM understands the timeline context."""
    import datetime as _dt

    # First pass: gather metadata for each path so we can compute day-diffs
    meta_list: list[dict] = []
    for raw_path in transcript_paths:
        p = Path(raw_path)
        meta: dict = {"path": p, "call_id": "?", "agent": None, "customer": None,
                      "started_at": None, "duration_s": None, "dt": None}
        if not p.exists():
            meta_list.append(meta)
            continue

        # Extract call_id from path: …/{call_id}/transcribed/…
        parts = p.parts
        for j, part in enumerate(parts):
            if part == "transcribed" and j > 0:
                meta["call_id"] = parts[j - 1]
                break

        # Load smoothed_meta.json (same dir as smoothed.txt)
        meta_json = p.parent / "smoothed_meta.json"
        if meta_json.exists():
            try:
                m = json.loads(meta_json.read_text())
                meta["agent"] = m.get("agent")
                meta["customer"] = m.get("customer")
                meta["started_at"] = m.get("started_at")
                meta["duration_s"] = m.get("duration_s")
            except Exception:
                pass

        # Fallback: read calls.json in the pair directory
        # smoothed.txt → llm_final/ → transcribed/ → call_id/ → customer/ → calls.json
        if not meta["started_at"] and meta["call_id"] != "?":
            try:
                pair_dir = p.parent.parent.parent.parent  # 4 levels up = customer dir
                calls_json = pair_dir / "calls.json"
                if calls_json.exists():
                    for c in json.loads(calls_json.read_text()):
                        if str(c.get("call_id", "")) == meta["call_id"]:
                            meta["started_at"] = c.get("started_at")
                            meta["duration_s"] = c.get("duration_s")
                            meta["agent"] = meta["agent"] or c.get("agent")
                            meta["customer"] = meta["customer"] or c.get("customer")
                            break
            except Exception:
                pass

        # Parse datetime for day-diff calculation
        if meta["started_at"]:
            try:
                raw_dt = str(meta["started_at"]).replace("T", " ").split("+")[0].split(".")[0]
                meta["dt"] = _dt.datetime.strptime(raw_dt[:19], "%Y-%m-%d %H:%M:%S")
            except Exception:
                pass

        meta_list.append(meta)

    # Sort by date (preserving original order if no dates)
    dated = [(i, m) for i, m in enumerate(meta_list) if m["dt"]]
    dated.sort(key=lambda x: x[1]["dt"])
    dated_indices = {orig_i: rank for rank, (orig_i, _) in enumerate(dated)}

    # Second pass: build sections with enriched headers
    sections: list[str] = []
    prev_dt = None
    call_num = 0

    # Process in date order if we have dates, else original order
    order = [i for i, _ in sorted(dated, key=lambda x: x[1]["dt"])] if dated else list(range(len(meta_list)))
    # Add undated ones at end
    undated = [i for i in range(len(meta_list)) if i not in {orig_i for orig_i, _ in dated}]
    order += undated

    for i in order:
        meta = meta_list[i]
        p = meta["path"]
        if not p.exists():
            continue
        # Skip short/voicemail calls (< 60 seconds)
        if meta["duration_s"] is not None and int(meta["duration_s"]) < 60:
            continue
        call_num += 1

        # Build header fields
        date_str = ""
        if meta["dt"]:
            date_str = meta["dt"].strftime("%d %b %Y  %H:%M")
        elif meta["started_at"]:
            date_str = str(meta["started_at"])[:16]

        dur_str = ""
        if meta["duration_s"]:
            d = int(meta["duration_s"])
            dur_str = f"{d // 60}m {d % 60}s"

        days_str = ""
        if meta["dt"] and prev_dt:
            days = (meta["dt"] - prev_dt).days
            days_str = f"+{days}d since prev" if days >= 0 else ""

        agent_str = meta["agent"] or ""
        customer_str = meta["customer"] or ""

        header_parts = [f"Call #{call_num}  ·  ID: {meta['call_id']}"]
        if agent_str or customer_str:
            header_parts.append(f"Agent: {agent_str}  |  Customer: {customer_str}")
        detail_parts = []
        if date_str:
            detail_parts.append(date_str)
        if dur_str:
            detail_parts.append(f"Duration: {dur_str}")
        if days_str:
            detail_parts.append(days_str)
        if detail_parts:
            header_parts.append("  ·  ".join(detail_parts))

        header = "=" * 60 + "\n" + "\n".join(header_parts) + "\n" + "=" * 60

        text = _read_transcript_as_text(p)
        if text.strip():
            sections.append(f"{header}\n{text.strip()}")

        if meta["dt"]:
            prev_dt = meta["dt"]

    return "\n\n".join(sections)


# ── LLM call ──────────────────────────────────────────────────────────────────


# Per-model safe char limits (≈ 80% of context window to leave room for output)
_MODEL_MAX_CHARS = {
    "gemini":  3_200_000, # 1M tokens → ~4M chars, use 3.2M
    "gpt-4.1": 2_400_000, # 1M tokens → ~4M chars, use 2.4M
    "gpt-5":   400_000,   # 128K tokens → ~512K chars (conservative), use 400K
    "claude":  640_000,   # 200K tokens → ~800K chars, use 640K to be safe
    "gpt-4o":  400_000,   # 128K tokens → ~512K chars, use 400K
    "default": 400_000,
}

def _model_max_chars(model: str) -> int:
    for prefix, limit in _MODEL_MAX_CHARS.items():
        if model.startswith(prefix):
            return limit
    return _MODEL_MAX_CHARS["default"]


def _build_persona(persona_type: str, agent: str, customer: Optional[str],
                   transcript_paths: list[str], system_prompt: str,
                   user_prompt: str, model: str, temperature: float = 0.0,
                   base_persona: Optional[str] = None,
                   script_save_path: Optional[Path] = None) -> str:
    import sys
    sys.path.insert(0, str(Path(__file__).parent.parent.parent.parent))
    from shared.llm_client import LLMClient

    # Auto-detect provider from model name (same logic as final_transcript.py)
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

    client = LLMClient(provider=provider, api_key=api_key)

    merged = _merge_transcripts(transcript_paths)
    if not merged.strip():
        raise ValueError("No transcript content found — check that the paths are accessible")

    # Save the full merged script before truncation so user can load it later
    if script_save_path:
        try:
            script_save_path.parent.mkdir(parents=True, exist_ok=True)
            script_save_path.write_text(merged, encoding="utf-8")
        except Exception as e:
            print(f"[persona] Warning: could not save merged script: {e}")

    # Truncate if merged text exceeds model's safe context limit
    max_chars = _model_max_chars(model)
    truncated = False
    if len(merged) > max_chars:
        merged = merged[:max_chars]
        truncated = True

    subject = f"Agent: {agent}" + (f"  |  Customer: {customer}" if customer else "")
    print(f"[persona] {persona_type} — {subject} — {len(transcript_paths)} transcript(s), {len(merged):,} chars{' (truncated)' if truncated else ''}, model: {model}")

    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": (
                f"Subject: {subject}\n\n"
                + (f"Existing profile (use as context/baseline):\n\n{base_persona}\n\n---\n\n" if base_persona else "")
                + (f"Additional instructions: {user_prompt}\n\n" if user_prompt.strip() else "")
                + f"Call transcripts ({len(transcript_paths)} calls):\n\n{merged}"
            ),
        },
    ]

    print(f"[persona] {persona_type} — sending {len(messages[0]['content']):,} sys + {len(messages[1]['content']):,} user chars to {model}")
    try:
        resp = client.chat_completion(model=model, messages=messages, temperature=temperature)
        raw = resp.choices[0].message.content
        print(f"[persona] {persona_type} — raw response: {len(raw or ''):,} chars")
        if not raw or not raw.strip():
            raise ValueError(f"LLM returned empty content (model={model}). Check API key and model name.")
        result = _smart_normalize_sections(raw)
        print(f"[persona] {persona_type} — done, {len(result):,} chars after normalization")
        return result
    except Exception as e:
        print(f"[ERROR] [persona] {persona_type} — LLM call failed: {e}")
        raise


_SECTION_NORMALISE_PROMPT = """You are a document formatter. Your ONLY task is to add markdown section headers to a persona analysis document.

The document may have implicit sections indicated by numbered headings (e.g. "1. General Process Flow"), bold text (**Title**), or other patterns.

Rules:
1. Identify every major section heading in the document
2. Add "## " before each section heading line (if not already there)
3. Do NOT change, remove, or rewrite any content — only add ## markers
4. Return the COMPLETE document with no truncation
5. Output ONLY the formatted document, no explanation or preamble"""


def _normalize_section_headings(content: str) -> str:
    """Fast regex pass: convert plain numbered headings to ## markdown headings.
    Returns unchanged content if no numbered headings found (LLM handles that case).
    """
    lines = content.split("\n")
    if any(_re.match(r"^#{1,2}\s+", l) for l in lines):
        return content  # already structured

    result = []
    changed = False
    for line in lines:
        m = _re.match(r"^(\d{1,2})\.\s+([A-Z].{3,})$", line.rstrip())
        if m and not line.rstrip().endswith(":"):
            result.append(f"## {m.group(2).strip()}")
            changed = True
        else:
            result.append(line)
    return "\n".join(result) if changed else content


def _smart_normalize_sections(content: str) -> str:
    """Ensure a persona document has ## section headers.

    1. If ## headers already exist → return as-is.
    2. Try fast regex (numbered headings like "1. Title") → return if found.
    3. Fall back to a cheap LLM call to identify and insert ## headers.
    """
    # Already structured
    if any(line.startswith("##") or line.startswith("# ") for line in content.split("\n")):
        return content

    # Fast regex path
    regex_result = _normalize_section_headings(content)
    if regex_result != content:
        return regex_result

    # LLM fallback — handles unusual formats (bold, all-caps, implicit headings)
    try:
        from ui.backend.routers.final_transcript import _llm_call
        result = _llm_call(_SECTION_NORMALISE_PROMPT, content, "gpt-4o-mini")
        if result and any(line.startswith("##") for line in result.split("\n")):
            print(f"[normalize] LLM added ## headers ({len(result):,} chars)")
            return result
        print("[normalize] LLM returned no ## headers, keeping original")
    except Exception as e:
        print(f"[normalize] LLM fallback failed: {e}")

    return content


def _extract_section_titles(content_md: str) -> list[str]:
    """Extract section titles from persona markdown — mirrors frontend parsePersonaSections.

    Used by the scorer to send the exact same titles as JSON keys, ensuring
    score badges align with the section cards in the UI.
    """
    lines = content_md.split("\n")
    has_headers = any(_re.match(r"^#{1,2}\s+", l) for l in lines)
    titles: list[str] = []
    for line in lines:
        h2 = _re.match(r"^##\s+(.+)", line)
        h1 = _re.match(r"^#\s+(.+)", line)
        numbered = (
            not has_headers
            and not line.rstrip().endswith(":")
            and _re.match(r"^(\d{1,2})\.\s+([A-Z].{3,})$", line.rstrip())
        )
        if h2:
            titles.append(h2.group(1).strip())
        elif h1:
            titles.append(h1.group(1).strip())
        elif numbered:
            titles.append(numbered.group(2).strip())  # type: ignore[union-attr]
    return titles


# ── Sectioned persona build (parallel per-section LLM calls + synthesis) ────

def _build_persona_sectioned(
    persona_type: str, agent: str, customer: Optional[str],
    transcript_paths: list[str], sections: list[dict],
    preamble: str, model: str, temperature: float = 0.0,
    script_save_path: Optional[Path] = None,
) -> dict:
    """
    Build a persona by running each section in its own LLM call (in parallel).
    Each call produces the section content AND a score for that section.
    A final synthesis call writes a summary and computes the weighted overall.
    Returns: {content_md: str, score_json: str}
    """
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from ui.backend.routers.final_transcript import _llm_call

    merged = _merge_transcripts(transcript_paths)
    if not merged.strip():
        raise ValueError("No transcript content found — check that the paths are accessible")

    if script_save_path:
        try:
            script_save_path.parent.mkdir(parents=True, exist_ok=True)
            script_save_path.write_text(merged, encoding="utf-8")
        except Exception as e:
            print(f"[persona] Warning: could not save merged script: {e}")

    max_chars = _model_max_chars(model)
    if len(merged) > max_chars:
        merged = merged[:max_chars]

    subject = f'Agent: "{agent}"' + (f'  |  Customer: "{customer}"' if customer else "")
    sys_prompt = _assemble_system_prompt(preamble, sections)

    def _call_section(section: dict) -> tuple[str, dict]:
        sec_name = section["name"]
        instruction = section.get("instruction", "")
        scoring_instruction = section.get("scoring_instruction", "")
        weight = section.get("weight", 1)

        # Score = research value for this dimension (100 = high-value case for researcher review)
        if scoring_instruction:
            scoring_rule = (
                f"Score 0-100 for '{sec_name}' using this scoring guide: {scoring_instruction} "
                f"Weight: {weight}/5."
            )
        else:
            scoring_rule = (
                f"Score 0-100 where 100 = high research value for '{sec_name}'. "
                f"High score means this dimension makes the case worth studying. "
                f"Follow the section instruction exactly to determine what constitutes high research value here. "
                f"Do not reduce the score for aggressive, manipulative, or non-compliant behavior — "
                f"those behaviors increase research value, not decrease it. Weight: {weight}/5."
            )

        user_msg = (
            f"SUBJECT: {subject}\n\n"
            f"YOUR TASK: Write ONLY the '## {sec_name}' section of the persona.\n\n"
            f"SECTION INSTRUCTION: {instruction}\n\n"
            f"SCORING RULE: {scoring_rule}\n\n"
            f"Output format — two parts in this exact order:\n"
            f"PART 1: Start with the markdown heading '## {sec_name}' then write the section content. "
            f"Be specific, evidence-based, quote directly from the transcripts.\n\n"
            f"PART 2: On a new line after the content, output exactly:\n"
            f"SECTION_SCORE: {{\"score\": <integer 0-100>, \"reasoning\": \"<one sentence>\"}}\n\n"
            f"TRANSCRIPTS ({len(transcript_paths)} calls):\n\n{merged}"
        )

        print(f"[persona-sectioned] Calling section '{sec_name}' model={model}")
        raw = _llm_call(sys_prompt, user_msg, model)

        score: Optional[int] = None
        reasoning = ""
        content_lines: list[str] = []
        for line in raw.split("\n"):
            if line.strip().startswith("SECTION_SCORE:"):
                try:
                    j = json.loads(line.strip()[len("SECTION_SCORE:"):].strip())
                    score = int(j.get("score", 0))
                    reasoning = str(j.get("reasoning", ""))
                except Exception:
                    pass
            else:
                content_lines.append(line)

        content = "\n".join(content_lines).rstrip()
        if not content.lstrip().startswith("## "):
            content = f"## {sec_name}\n\n{content}"

        print(f"[persona-sectioned] '{sec_name}' done — score={score}, {len(content)} chars")
        return sec_name, {"content": content, "score": score, "reasoning": reasoning}

    # Run all sections in parallel
    section_results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(sections), 8)) as pool:
        futures = {pool.submit(_call_section, s): s["name"] for s in sections}
        for fut in as_completed(futures):
            name, result = fut.result()
            section_results[name] = result

    # Assemble in original section order
    ordered = [section_results[s["name"]] for s in sections if s["name"] in section_results]
    assembled_md = "\n\n".join(r["content"] for r in ordered)

    # Compute weighted overall score
    sec_weights = {s["name"]: s.get("weight", 1) for s in sections}
    score_data: dict = {}
    weighted_sum = 0.0
    total_weight = 0
    for s in sections:
        name = s["name"]
        r = section_results.get(name, {})
        if r.get("score") is not None:
            score_data[name] = {"score": r["score"], "reasoning": r.get("reasoning", "")}
            w = sec_weights.get(name, 1)
            weighted_sum += r["score"] * w
            total_weight += w
    if total_weight > 0:
        score_data["_overall"] = round(weighted_sum / total_weight)

    # Synthesis call — one final LLM pass on the whole assembled document for summary
    synthesis_msg = (
        f"SUBJECT: {subject}\n\n"
        f"Below is the complete per-section persona you have assembled:\n\n"
        f"{assembled_md}\n\n"
        f"Write a 2-sentence executive summary of this {'agent' if persona_type != 'customer' else 'customer'}'s "
        f"overall profile. Focus on what is most defining.\n\n"
        f"Output ONLY this JSON on a single line:\n"
        f"SYNTHESIS: {{\"_summary\": \"<your 2-sentence summary>\"}}"
    )
    print(f"[persona-sectioned] Running synthesis call model={model}")
    synthesis_raw = _llm_call(sys_prompt, synthesis_msg, model)
    for line in synthesis_raw.split("\n"):
        if line.strip().startswith("SYNTHESIS:"):
            try:
                j = json.loads(line.strip()[len("SYNTHESIS:"):].strip())
                score_data["_summary"] = str(j.get("_summary", ""))
            except Exception:
                pass

    print(f"[persona-sectioned] Complete — overall={score_data.get('_overall')}, {len(assembled_md)} chars")
    return {"content_md": assembled_md, "score_json": json.dumps(score_data)}


# ── Request/response models ───────────────────────────────────────────────────

class PersonaCreate(BaseModel):
    type: str                           # agent_overall | customer | pair
    agent: str
    customer: Optional[str] = None
    transcript_paths: list[str]
    system_prompt: Optional[str] = None  # preamble (short base instructions; assembled with sections)
    user_prompt: Optional[str] = None    # extra user instructions appended to system
    prompt_override: Optional[str] = None  # legacy compat — treated as system_prompt
    sections: Optional[list] = None      # ordered list of PersonaSection dicts; overrides system_prompt assembly
    model: str = "gpt-5.4"
    label: Optional[str] = None
    temperature: float = 0.0
    base_persona: Optional[str] = None   # existing persona content to include as context
    run_separately: bool = False   # if True and multiple customers, run one persona per customer
    persona_agent_id: Optional[str] = None  # which persona agent (prompt) created this


class PersonaRegenerate(BaseModel):
    transcript_paths: Optional[list[str]] = None
    system_prompt: Optional[str] = None
    user_prompt: Optional[str] = None
    prompt_override: Optional[str] = None  # legacy compat
    sections: Optional[list] = None        # if provided, reassemble prompt from sections
    model: Optional[str] = None
    temperature: Optional[float] = None   # None = inherit from original
    base_persona: Optional[str] = None   # existing persona content to include as context


class MergePreviewRequest(BaseModel):
    transcript_paths: list[str]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/score-prompt")
def get_score_prompt():
    """Return the default scoring system prompt so the UI can display and edit it."""
    return {"prompt": _SCORING_SYSTEM}


@router.get("/prompts")
def get_default_prompts():
    return DEFAULT_PROMPTS


@router.get("/default-sections/{persona_type}")
def get_default_sections(persona_type: str):
    """Return default sections + preamble for a persona type (used when loading an agent with no sections)."""
    return {
        "sections": _DEFAULT_SECTIONS.get(persona_type, _DEFAULT_SECTIONS["agent_overall"]),
        "preamble": _DEFAULT_PREAMBLE.get(persona_type, _DEFAULT_PREAMBLE["agent_overall"]),
    }


@router.post("/merge-preview")
def merge_preview(req: MergePreviewRequest):
    """Return a preview of what the merged transcript will look like (first 3000 chars)."""
    merged = _merge_transcripts(req.transcript_paths)
    word_count = len(merged.split())
    return {
        "preview": merged[:3000],
        "total_chars": len(merged),
        "word_count": word_count,
        "call_count": len(req.transcript_paths),
    }


@router.get("")
def list_personas(
    agent: str = Query(""),
    customer: str = Query(""),
    type: str = Query(""),
    db: Session = Depends(get_session),
):
    stmt = select(Persona).where(Persona.parent_id == None)  # noqa: E711
    if agent:
        stmt = stmt.where(Persona.agent.contains(agent))
    if customer:
        stmt = stmt.where(Persona.customer.contains(customer))
    if type:
        stmt = stmt.where(Persona.type == type)
    stmt = stmt.order_by(Persona.created_at.desc())
    return db.exec(stmt).all()


@router.get("/{persona_id}")
def get_persona(persona_id: str, db: Session = Depends(get_session)):
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    return p


@router.get("/{persona_id}/versions")
def get_versions(persona_id: str, db: Session = Depends(get_session)):
    root = db.get(Persona, persona_id)
    if not root:
        raise HTTPException(404)
    root_id = root.parent_id or root.id
    stmt = select(Persona).where(
        (Persona.id == root_id) | (Persona.parent_id == root_id)
    ).order_by(Persona.version)
    return db.exec(stmt).all()


@router.post("")
async def create_persona(req: PersonaCreate, db: Session = Depends(get_session)):
    # Build system prompt: sections take precedence over raw system_prompt
    sections = req.sections or []
    if sections:
        preamble = req.system_prompt or req.prompt_override or _DEFAULT_PREAMBLE.get(req.type, "")
        sys_prompt = _assemble_system_prompt(preamble, sections)
    else:
        sys_prompt = req.system_prompt or req.prompt_override or DEFAULT_PROMPTS.get(req.type, "")
    user_prompt = req.user_prompt or ""
    sections_json_str = json.dumps(sections) if sections else None

    # Run separately by customer — one persona per customer
    if req.run_separately and req.transcript_paths:
        # Group paths by customer
        groups: dict[str, list[str]] = {}
        for tp in req.transcript_paths:
            p = Path(tp)
            cust = None
            meta_json = p.parent / "smoothed_meta.json"
            if meta_json.exists():
                try:
                    cust = json.loads(meta_json.read_text()).get("customer")
                except Exception:
                    pass
            if not cust:
                # Fallback: infer from path (…/{agent}/{customer}/{call_id}/…)
                parts = p.parts
                for j, part in enumerate(parts):
                    if part == "transcribed" and j >= 2:
                        cust = parts[j - 2]
                        break
            key = cust or "unknown"
            groups.setdefault(key, []).append(tp)

        results = []
        for customer_name, paths in groups.items():
            cust_persona_id = str(uuid.uuid4())
            if req.type == "agent_overall" or not customer_name or customer_name == "unknown":
                script_dir = settings.agents_dir / req.agent.strip() / "personas" / "scripts"
            else:
                script_dir = settings.agents_dir / req.agent.strip() / customer_name.strip() / "personas" / "scripts"
            script_path = script_dir / f"{cust_persona_id}_script.txt"

            loop = asyncio.get_event_loop()
            content = await loop.run_in_executor(
                None,
                lambda pp=paths, cn=customer_name, sp=script_path: _build_persona(
                    req.type, req.agent, cn, pp, sys_prompt, user_prompt,
                    req.model, req.temperature, req.base_persona, sp
                )
            )
            prompt_stored = sys_prompt + (f"\n\nUser: {user_prompt}" if user_prompt.strip() else "")
            cust_label = f"{req.agent} × {customer_name}" + (f" ({req.label})" if req.label else "")
            persona = Persona(
                id=cust_persona_id,
                type=req.type,
                agent=req.agent,
                customer=customer_name if customer_name != "unknown" else None,
                label=cust_label,
                content_md=content,
                prompt_used=prompt_stored,
                model=req.model,
                temperature=req.temperature,
                transcript_paths=json.dumps(paths),
                script_path=str(script_path) if script_path.exists() else None,
                version=1,
                persona_agent_id=req.persona_agent_id,
                sections_json=sections_json_str,
            )
            db.add(persona)
            db.commit()
            db.refresh(persona)
            _save_persona_file(persona)
            results.append(persona)
        return results

    persona_id = str(uuid.uuid4())
    agent_safe = req.agent.strip()
    if req.type == "agent_overall" or not req.customer:
        script_dir = settings.agents_dir / agent_safe / "personas" / "scripts"
    else:
        script_dir = settings.agents_dir / agent_safe / req.customer.strip() / "personas" / "scripts"
    script_save_path = script_dir / f"{persona_id}_script.txt"

    loop = asyncio.get_event_loop()
    score_json_str: Optional[str] = None

    if sections:
        preamble_for_build = req.system_prompt or req.prompt_override or _DEFAULT_PREAMBLE.get(req.type, "")
        result = await loop.run_in_executor(
            None,
            lambda: _build_persona_sectioned(
                req.type, req.agent, req.customer,
                req.transcript_paths, sections,
                preamble_for_build, req.model, req.temperature, script_save_path,
            )
        )
        content = result["content_md"]
        score_json_str = result["score_json"]
    else:
        content = await loop.run_in_executor(
            None,
            lambda: _build_persona(req.type, req.agent, req.customer,
                                    req.transcript_paths, sys_prompt, user_prompt, req.model,
                                    req.temperature, req.base_persona, script_save_path)
        )

    prompt_stored = sys_prompt + (f"\n\nUser: {user_prompt}" if user_prompt.strip() else "")
    persona = Persona(
        id=persona_id,
        type=req.type,
        agent=req.agent,
        customer=req.customer,
        label=req.label,
        content_md=content,
        prompt_used=prompt_stored,
        model=req.model,
        temperature=req.temperature,
        transcript_paths=json.dumps(req.transcript_paths),
        script_path=str(script_save_path) if script_save_path.exists() else None,
        version=1,
        persona_agent_id=req.persona_agent_id,
        sections_json=sections_json_str,
        score_json=score_json_str,
    )
    db.add(persona)
    db.commit()
    db.refresh(persona)
    _save_persona_file(persona)
    return persona


@router.post("/{persona_id}/regenerate")
async def regenerate_persona(persona_id: str, req: PersonaRegenerate,
                              db: Session = Depends(get_session)):
    original = db.get(Persona, persona_id)
    if not original:
        raise HTTPException(404)

    root_id = original.parent_id or original.id
    stmt = select(Persona).where(
        (Persona.id == root_id) | (Persona.parent_id == root_id)
    )
    versions = db.exec(stmt).all()
    next_version = max(p.version for p in versions) + 1

    # Sections: use request sections > original sections > none
    regen_sections = req.sections
    if regen_sections is None:
        try:
            regen_sections = json.loads(original.sections_json or "[]") or None
        except Exception:
            regen_sections = None
    regen_sections_str = json.dumps(regen_sections) if regen_sections else None

    if regen_sections:
        preamble = req.system_prompt or req.prompt_override or _DEFAULT_PREAMBLE.get(original.type, "")
        sys_prompt = _assemble_system_prompt(preamble, regen_sections)
    else:
        sys_prompt = req.system_prompt or req.prompt_override or original.prompt_used
    user_prompt = req.user_prompt or ""
    model = req.model or original.model
    temperature = req.temperature if req.temperature is not None else getattr(original, "temperature", 0.0)
    paths = req.transcript_paths or json.loads(original.transcript_paths or "[]")

    new_id = str(uuid.uuid4())
    agent_safe = original.agent.strip()
    if original.type == "agent_overall" or not original.customer:
        script_dir = settings.agents_dir / agent_safe / "personas" / "scripts"
    else:
        script_dir = settings.agents_dir / agent_safe / original.customer.strip() / "personas" / "scripts"
    script_save_path = script_dir / f"{new_id}_script.txt"

    loop = asyncio.get_event_loop()
    content = await loop.run_in_executor(
        None,
        lambda: _build_persona(original.type, original.agent, original.customer,
                                paths, sys_prompt, user_prompt, model,
                                temperature, req.base_persona, script_save_path)
    )

    prompt_stored = sys_prompt + (f"\n\nUser: {user_prompt}" if user_prompt.strip() else "")
    new_persona = Persona(
        id=new_id,
        type=original.type,
        agent=original.agent,
        customer=original.customer,
        label=original.label,
        content_md=content,
        prompt_used=prompt_stored,
        model=model,
        temperature=temperature,
        transcript_paths=json.dumps(paths),
        script_path=str(script_save_path) if script_save_path.exists() else None,
        version=next_version,
        parent_id=root_id,
        persona_agent_id=original.persona_agent_id,
        sections_json=regen_sections_str,
    )
    db.add(new_persona)

    # Also update the root persona's content so the list shows the latest version
    root = db.get(Persona, root_id)
    if root:
        root.content_md = content
        root.prompt_used = prompt_stored
        root.model = model
        root.temperature = temperature
        root.sections_json = regen_sections_str
        db.add(root)

    db.commit()
    db.refresh(new_persona)
    _save_persona_file(new_persona)
    return new_persona


class PersonaPatch(BaseModel):
    label: Optional[str] = None
    persona_agent_id: Optional[str] = None  # pass empty string "" to clear


@router.patch("/{persona_id}")
def patch_persona(persona_id: str, req: PersonaPatch, db: Session = Depends(get_session)):
    """Update mutable metadata fields (label, persona_agent_id) without regenerating."""
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    if req.label is not None:
        p.label = req.label
    if req.persona_agent_id is not None:
        p.persona_agent_id = req.persona_agent_id or None  # "" → None
    db.add(p)
    db.commit()
    db.refresh(p)
    return p


@router.get("/{persona_id}/transcript-content")
def get_transcript_content(persona_id: str, idx: int = 0, db: Session = Depends(get_session)):
    """Return the raw text of a single transcript file by index into transcript_paths."""
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    try:
        paths = json.loads(p.transcript_paths or "[]")
        if isinstance(paths, str):
            paths = [paths]
        path_str = paths[idx]
        content = Path(path_str).read_text(encoding="utf-8", errors="replace")
        return {"content": content, "path": path_str, "idx": idx}
    except IndexError:
        raise HTTPException(404, "Transcript index out of range")
    except FileNotFoundError:
        raise HTTPException(404, f"Transcript file not found")


class SaveScoreRequest(BaseModel):
    score_json: dict


@router.post("/{persona_id}/save-score")
def save_persona_score(persona_id: str, req: SaveScoreRequest, db: Session = Depends(get_session)):
    """Persist a new score_json onto the persona (called after rescore+normalise)."""
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    # Strip transient UI-only keys (_*_used) before persisting
    to_save = {k: v for k, v in req.score_json.items() if not k.endswith("_used")}
    p.score_json = json.dumps(to_save)
    db.add(p)
    db.commit()
    return {"saved": True}


@router.delete("/{persona_id}")
def delete_persona(persona_id: str, db: Session = Depends(get_session)):
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404)
    db.delete(p)
    db.commit()
    return {"deleted": True}


# ── Section scoring ───────────────────────────────────────────────────────────

_SCORING_SYSTEM = """You are a behavioral research analyst scoring sales interaction personas. Your output is used to prioritize which cases researchers should study — not to evaluate agent quality or ethics.

SCORING PHILOSOPHY:
High score = high research value = this case should be reviewed by researchers.
Low score = low research value = less useful for research prioritization.

The main research interest is effectiveness. Research value is determined as follows:
- Non-compliant AND effective → highest research value (score high). The agent moved the customer using non-compliant tactics — this is exactly what researchers need to study.
- Compliant AND effective → high research value (score high). Useful comparison case.
- Non-compliant AND ineffective → moderate research value (score moderate). Violations present but agent failed to influence — less instructive.
- Compliant AND ineffective → lowest research value (score low). Nothing notable to study.

Do NOT reduce scores because behavior was aggressive, manipulative, deceptive, or uncomfortable. These behaviors are the research subject. Penalizing them defeats the purpose of the study.

SCORING FOCUS OVERRIDE: If a SCORING FOCUS block is provided, it is BINDING and overrides all defaults.

Score each section 0-100 based on research value for that dimension:
• 80-100  High research value — strongly present, well-evidenced, informative for researchers
• 50-79   Moderate research value — present but not a standout case
• 20-49   Low research value — weak evidence, limited analytical value
• 0-19    Negligible — absent or not observable

Return ONLY valid JSON. Every section key maps to a PLAIN INTEGER (0-100).

CORRECT format:
{
  "Section Title A": 82,
  "Section Title B": 91,
  "_overall": 87,
  "_summary": "One to two sentence research summary of this case's value.",
  "_reasoning": {"Section Title A": "One sentence.", "Section Title B": "One sentence."}
}

WRONG:
{ "Section Title A": {"Score": "82/100", "Explanation": "..."} }

Rules:
- Each section key → single integer only
- "_overall" → single integer
- "_summary" → plain string
- "_reasoning" → object, one sentence per section
- No markdown, no text outside the JSON."""


def _extract_persona_user_prompt(prompt_used: str) -> str:
    """Extract just the user prompt portion from the stored combined prompt string."""
    if not prompt_used:
        return ""
    # prompt_used is stored as: system_prompt + "\n\nUser: " + user_prompt
    marker = "\n\nUser: "
    if marker in prompt_used:
        return prompt_used.split(marker, 1)[1].strip()
    return ""


_score_cache: dict[str, dict] = {}


def _repair_score_json(data: dict) -> dict:
    """Repair scorer output where section values are nested objects instead of integers."""
    import re

    def to_int(v) -> Optional[int]:
        if isinstance(v, (int, float)):
            return int(v)
        if isinstance(v, str):
            m = re.search(r'\d+', v)
            return int(m.group()) if m else None
        if isinstance(v, dict):
            for key in ("Score", "score", "Value", "value", "score_value"):
                if key in v:
                    return to_int(v[key])
            for val in v.values():
                r = to_int(val)
                if r is not None:
                    return r
        return None

    out: dict = {}
    for k, v in data.items():
        if k in ("_summary", "_reasoning"):
            out[k] = v
        elif k == "_overall":
            out[k] = to_int(v) or 0
        else:
            out[k] = to_int(v)
    return out


def _score_persona_content(persona: "Persona", model: str, system_prompt: Optional[str] = None, user_prompt: Optional[str] = None) -> dict:
    import hashlib
    scorer_sys = system_prompt or _SCORING_SYSTEM
    prompt_hash = hashlib.md5(scorer_sys.encode()).hexdigest()[:8]
    user_prompt_hash = hashlib.md5((user_prompt or "").encode()).hexdigest()[:6]
    cache_key = f"{persona.id}:{hashlib.md5(persona.content_md.encode()).hexdigest()[:10]}:{prompt_hash}:{user_prompt_hash}"
    if cache_key in _score_cache:
        print(f"[score] {persona.id[:8]} — cache hit")
        return _score_cache[cache_key]

    from ui.backend.routers.final_transcript import _llm_call

    subject = f"Type: {persona.type}  |  Agent: {persona.agent}"
    if persona.customer:
        subject += f"  |  Customer: {persona.customer}"

    section_titles = _extract_section_titles(persona.content_md)

    # Load section metadata from persona if available — gives scorer direction + weight per section
    stored_sections: list[dict] = []
    try:
        stored_sections = json.loads(persona.sections_json or "[]") or []
    except Exception:
        pass
    sec_meta: dict[str, dict] = {(s.get("name") or s.get("title", "")): s for s in stored_sections}

    if stored_sections:
        sections_list = "\n".join(
            f"  - {s.get('name') or s.get('title', '')}  [high score = high research flag intensity for this dimension, weight={s.get('weight',1)}]"
            for s in stored_sections
        )
    else:
        sections_list = "\n".join(f"  - {t}" for t in section_titles) if section_titles else "  (parse from persona content)"

    # Pull the user prompt that was used to generate this persona — gives the scorer context
    persona_goal = _extract_persona_user_prompt(persona.prompt_used or "")

    parts = [f"SUBJECT: {subject}"]
    if user_prompt and user_prompt.strip():
        parts.append(f"⚠ SCORING FOCUS — BINDING OVERRIDE (follow these instructions exactly, they override all defaults):\n{user_prompt.strip()}")
    if persona_goal:
        parts.append(f"PERSONA GOAL (instruction used to generate this persona):\n{persona_goal}")
    parts.append(f"SECTIONS TO SCORE (use EXACT strings as JSON keys):\n{sections_list}")
    parts.append(f"PERSONA CONTENT:\n\n{persona.content_md}")

    user_msg = "\n\n".join(parts)

    print(f"[score] {persona.id[:8]} — scoring {len(section_titles)} section(s), model={model}, goal={'yes' if persona_goal else 'none'}")
    raw = _llm_call(scorer_sys, user_msg, model)
    print(f"[score] {persona.id[:8]} — raw output ({len(raw):,} chars):\n{raw[:1000]}")

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        result = json.loads(raw)
        # Repair if any section value is not an integer (LLM returned nested objects)
        needs_repair = any(
            not isinstance(v, (int, float, type(None)))
            for k, v in result.items()
            if k not in ("_summary", "_reasoning")
        )
        if needs_repair:
            print(f"[score] {persona.id[:8]} — repairing nested-object values")
            result = _repair_score_json(result)
        print(f"[score] {persona.id[:8]} — parsed OK, overall={result.get('_overall')}")
    except Exception as ex:
        # Try to salvage a JSON object from somewhere in the raw string
        import re as _re
        m = _re.search(r'\{.*\}', raw, _re.DOTALL)
        if m:
            try:
                result = json.loads(m.group())
                result = _repair_score_json(result)
                print(f"[score] {persona.id[:8]} — recovered JSON after parse error, overall={result.get('_overall')}")
            except Exception:
                print(f"[score] {persona.id[:8]} — JSON parse failed: {ex}\nRaw: {raw[:500]}")
                result = {"_summary": f"Score parsing failed: {raw[:200]}", "_overall": 0}
        else:
            print(f"[score] {persona.id[:8]} — JSON parse failed: {ex}\nRaw: {raw[:500]}")
            result = {"_summary": f"Score parsing failed: {raw[:200]}", "_overall": 0}

    # Override _overall with proper weighted average from section metadata
    if sec_meta:
        weighted_sum = 0.0
        total_weight = 0
        for sname, smeta in sec_meta.items():
            score_val = result.get(sname)
            if isinstance(score_val, (int, float)):
                w = int(smeta.get("weight", 1))
                weighted_sum += score_val * w
                total_weight += w
        if total_weight > 0:
            result["_overall"] = round(weighted_sum / total_weight)
            print(f"[score] {persona.id[:8]} — weighted overall={result['_overall']} (total_weight={total_weight})")

    _score_cache[cache_key] = result
    return result


_PERSONA_FIX_PROMPT = """You are a prompt engineering expert for LLM persona analysis systems in financial services call coaching.

You will be given:
1. A generated persona document (the OUTPUT)
2. The system prompt that was used to generate it

Your job: identify what is wrong with the output, then write improved system_prompt and user_prompt values that would produce a better result.

Common issues to check for:
- Output is one unstructured block with no ## section headers (the most critical issue)
- Sections are present but not delineated with ## markers
- Numbered list style headings (e.g. "1. General Process Flow") instead of ## headers
- Bold text headings (**Title**) instead of ## headers
- Missing important analysis dimensions for this persona type
- Generic or vague content lacking evidence from actual transcripts
- Preamble/title before the first ## heading (should not exist)

Your improved system_prompt MUST:
- Explicitly list each required section heading preceded by ## (e.g. "## Sales Techniques")
- Include a rule like: "Use the EXACT ## headings above. Do not add a title or preamble before the first ## heading."
- Be specific about what each section should cover

Return ONLY valid JSON with exactly these keys:
{
  "system_prompt": "the improved system prompt",
  "user_prompt": "improved additional user instructions (empty string if none needed)",
  "issues": ["specific issue 1", "specific issue 2"],
  "changes": "1-2 sentence summary of what was changed and why"
}"""


_SCORER_FIX_PROMPT = """You are a prompt engineering expert for LLM evaluation/scoring systems.

You will receive:
1. SECTION TITLES — the exact section headings present in the persona document
2. PERSONA DOCUMENT — the full content of the persona (read each section carefully)
3. CURRENT SCORING PROMPT — the existing scoring system prompt (may be wrong, incomplete, or a generation prompt not a scoring prompt)

Your job: write a complete, ready-to-use SCORING system prompt that produces reliable 0-100 integer scores for this specific persona.

For EACH section in the persona:
1. Read the actual section content to understand what it describes
2. Define a clear scoring dimension: what does 80-100 look like vs 0-19 for THIS section?
3. Write concrete rubric bands: 80-100 / 50-79 / 20-49 / 0-19

CRITICAL REQUIREMENTS for the generated scoring prompt:
- It must instruct the LLM to return ONLY valid JSON
- JSON keys MUST be the EXACT section title strings (copy them verbatim)
- JSON values MUST be integers 0-100 (never null, never text)
- Must include "_overall" key (weighted average, integer 0-100)
- Must include "_summary" key (1-2 sentence overall evaluation)
- Must include "_reasoning" key (object: each section title → 1-sentence score explanation)
- Must say: "Return ONLY valid JSON. No markdown, no explanation outside the JSON."

Return ONLY valid JSON with exactly these keys:
{
  "system_prompt": "the complete scoring system prompt, fully self-contained and ready to use",
  "user_prompt": "any additional context to pass alongside the persona (empty string if none)",
  "changes": "1-2 sentence explanation of what scoring dimensions you defined for each section"
}"""


class SuggestFixRequest(BaseModel):
    target: str = "persona"  # "persona" or "scorer"
    scoring_system_prompt: Optional[str] = None  # current scoring prompt (for scorer target)


_PROMPT_AUDIT_SYSTEM = """You are a prompt engineering expert for LLM persona analysis systems.

You will be given a system prompt (and optionally a user prompt) used to generate persona documents from call transcripts.

Analyze whether this prompt will reliably produce well-structured output with ## markdown section headers, then suggest an improved version.

Check for:
1. Does the prompt explicitly list each required section with ## prefix (e.g. "## Sales Techniques")?
2. Does it say "Use EXACTLY these ## headings" or equivalent?
3. Does it say "Do not add a title or preamble before the first ## heading"?
4. Are the sections clearly defined with what to cover?
5. Any other structural issues that would cause the LLM to produce unstructured output

The improved system_prompt MUST:
- List every required section header with ## prefix explicitly in the prompt
- Include a clear rule: "Use the EXACT ## headings above. Do not rename, add, or remove sections."
- Include: "Do not add a title or preamble before the first ## heading."

Return ONLY valid JSON:
{
  "system_prompt": "the improved system prompt",
  "user_prompt": "improved user prompt (empty string if none needed)",
  "issues": ["issue 1", "issue 2"],
  "changes": "1-2 sentence summary of what was changed and why"
}"""


_USER_PROMPT_AUDIT_SYSTEM = """You are a prompt engineering expert for LLM persona analysis systems.

You will be given a system prompt (as context) and a user prompt to improve.

The user prompt provides additional instructions or focus areas layered on top of the system prompt.

Analyze ONLY the user prompt and suggest improvements. Focus on:
1. Is it clear, specific, and actionable?
2. Does it complement rather than conflict with the system prompt?
3. Does it add genuine focus (specific topics, angles, examples to look for)?
4. Is it free from redundancy with the system prompt?

Return ONLY valid JSON:
{
  "user_prompt": "the improved user prompt",
  "issues": ["issue 1", "issue 2"],
  "changes": "1-2 sentence summary of what was changed and why"
}"""


class AnalyzePromptRequest(BaseModel):
    system_prompt: str
    user_prompt: Optional[str] = None
    target: str = "system"  # "system" | "user"


@router.post("/suggest-prompt")
def suggest_prompt(req: AnalyzePromptRequest):
    """Analyze a prompt and suggest improvements.
    target=system: analyze + return improved system_prompt
    target=user:   analyze + return improved user_prompt
    """
    from ui.backend.routers.final_transcript import _llm_call

    if req.target == "user":
        user_msg = f"SYSTEM PROMPT (context only):\n\n{req.system_prompt}"
        if req.user_prompt and req.user_prompt.strip():
            user_msg += f"\n\nUSER PROMPT TO IMPROVE:\n\n{req.user_prompt}"
        else:
            user_msg += "\n\nUSER PROMPT TO IMPROVE:\n\n(empty — suggest what to add)"
        raw = _llm_call(_USER_PROMPT_AUDIT_SYSTEM, user_msg, "gpt-4o-mini")
    else:
        user_msg = f"SYSTEM PROMPT TO ANALYZE:\n\n{req.system_prompt}"
        if req.user_prompt and req.user_prompt.strip():
            user_msg += f"\n\nUSER PROMPT (context):\n\n{req.user_prompt}"
        raw = _llm_call(_PROMPT_AUDIT_SYSTEM, user_msg, "gpt-4o-mini")

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(raw)
    except Exception:
        raise HTTPException(500, f"Failed to parse suggestion: {raw[:300]}")


@router.post("/{persona_id}/suggest-fix")
def suggest_fix(persona_id: str, req: SuggestFixRequest, db: Session = Depends(get_session)):
    """Analyze a persona and suggest improved prompts for generation (target=persona) or scoring (target=scorer)."""
    persona = db.get(Persona, persona_id)
    if not persona:
        raise HTTPException(404, "Persona not found")

    from ui.backend.routers.final_transcript import _llm_call

    if req.target == "scorer":
        current_scoring = req.scoring_system_prompt or _SCORING_SYSTEM
        section_titles = _extract_section_titles(persona.content_md)
        sections_str = "\n".join(f"  - {t}" for t in section_titles) if section_titles else "  (parse from document)"
        user_msg = (
            f"SECTION TITLES (use these EXACT strings as JSON keys in the scoring output):\n{sections_str}\n\n"
            f"PERSONA DOCUMENT:\n\n{persona.content_md}\n\n"
            f"---\n\n"
            f"CURRENT SCORING PROMPT (may be wrong — improve or replace it):\n\n{current_scoring}"
        )
        print(f"[scorer-fix] {persona.id[:8]} — {len(section_titles)} sections: {section_titles}")
        raw = _llm_call(_SCORER_FIX_PROMPT, user_msg, "gpt-4o")
    else:
        user_msg = (
            f"GENERATED PERSONA OUTPUT:\n\n{persona.content_md}\n\n"
            f"---\n\n"
            f"SYSTEM PROMPT USED TO GENERATE IT:\n\n{persona.prompt_used or '(none stored)'}"
        )
        raw = _llm_call(_PERSONA_FIX_PROMPT, user_msg, "gpt-4o-mini")

    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[-1].rsplit("```", 1)[0].strip()

    try:
        result = json.loads(raw)
    except Exception:
        raise HTTPException(500, f"Failed to parse fix suggestion: {raw[:300]}")
    return result


class ScoreRequest(BaseModel):
    persona_ids: list[str]
    model: str = "gpt-5.4"
    user_prompt: Optional[str] = None    # scorer user prompt (default: "Score this persona document:")
    system_prompt: Optional[str] = None  # scorer system prompt (default: DEFAULT_SCORER_SYSTEM from FPA)


@router.post("/score")
def score_personas(req: ScoreRequest, db: Session = Depends(get_session)):
    """Score personas. For SectionBuilder personas uses their per-section criteria; otherwise FPA scorer."""
    from ui.backend.routers.full_persona_agent import (
        DEFAULT_SCORER_SYSTEM, DEFAULT_SCORER_PROMPT,
        _SCORE_NORMALISE_SYSTEM, _llm_call_temp, _parse_score_json,
    )
    results: dict[str, dict] = {}
    for pid in req.persona_ids:
        persona = db.get(Persona, pid)
        if not persona:
            continue
        try:
            # Read scorer system/prompt stored at creation time
            stored_score: dict = {}
            try:
                stored_score = json.loads(persona.score_json or "{}")
            except Exception:
                pass
            creation_scorer_sys    = stored_score.get("_scorer_system") or ""
            creation_scorer_prompt = stored_score.get("_scorer_user") or ""

            # Detect SectionBuilder sections (have name + scoring_instruction)
            sb_sections: list[dict] = []
            try:
                loaded = json.loads(persona.sections_json or "[]") or []
                sb_sections = [s for s in loaded if s.get("name") and s.get("scoring_instruction")]
            except Exception:
                pass

            # Recover stored section names from creation score (keys that aren't meta)
            stored_section_names = [k for k in stored_score if not k.startswith("_")]

            if req.system_prompt:
                # Explicit UI override — highest priority
                scorer_sys = req.system_prompt
                scorer_prompt = req.user_prompt or creation_scorer_prompt or DEFAULT_SCORER_PROMPT
            elif creation_scorer_sys and creation_scorer_sys != DEFAULT_SCORER_SYSTEM:
                # Use whatever custom scorer was used at creation time
                scorer_sys = creation_scorer_sys
                scorer_prompt = req.user_prompt or creation_scorer_prompt or DEFAULT_SCORER_PROMPT
                print(f"[score] {pid[:8]} using creation scorer_system ({len(scorer_sys):,} chars)")
            elif stored_section_names:
                # Reconstruct targeted scorer from the section names stored in score_json.
                # This recovers the correct scoring dimensions even when the original
                # custom scorer was overwritten in score_json by a previous rescore.
                sections_list = "\n".join(f'- "{s}"' for s in stored_section_names)
                scorer_sys = (
                    f"You are a persona scoring agent. Score this persona document against these specific sections.\n\n"
                    f"SECTIONS TO SCORE (use these EXACT strings as JSON keys):\n{sections_list}\n\n"
                    f"Return ONLY a valid JSON object — no markdown, no explanation, no code fences:\n"
                    f'{{\n  "Section Name": {{"score": 75, "reasoning": "one sentence"}},\n  ...\n'
                    f'  "_overall": <average of all section scores as 0-100 integer>,\n'
                    f'  "_summary": "One sentence overall summary"\n}}\n\n'
                    f"IMPORTANT: All scores are 0-100 integers. Score ONLY the listed sections."
                )
                scorer_prompt = req.user_prompt or creation_scorer_prompt or DEFAULT_SCORER_PROMPT
                print(f"[score] {pid[:8]} reconstructed scorer from {len(stored_section_names)} stored section names: {stored_section_names}")
            elif sb_sections:
                # SectionBuilder fallback: build prompt from per-section scoring_instruction
                sections_desc = "\n".join(
                    f'- "{s["name"]}" (weight={s.get("weight", 1)}): {s["scoring_instruction"]}'
                    for s in sb_sections
                )
                scorer_sys = (
                    f"You are a persona scoring agent. Score this persona document against these predefined section criteria.\n\n"
                    f"SECTIONS TO SCORE (use these EXACT strings as JSON keys):\n{sections_desc}\n\n"
                    f'Return ONLY a valid JSON:\n{{\n  "<section name>": <0-100 integer>,\n  ...\n'
                    f'  "_overall": <weighted average>,\n  "_summary": "one sentence",\n'
                    f'  "_reasoning": {{"<section name>": "one sentence"}}\n}}\n\n'
                    f"ALL scores are plain integers 0-100. No nested objects. No markdown."
                )
                scorer_prompt = req.user_prompt or creation_scorer_prompt or "Score this persona document:"
            else:
                # Final fallback: generic FPA scorer
                scorer_sys = DEFAULT_SCORER_SYSTEM
                scorer_prompt = req.user_prompt or creation_scorer_prompt or DEFAULT_SCORER_PROMPT

            score_msg = f"{scorer_prompt.strip()}\n\n{persona.content_md}"
            print(f"[score] {pid[:8]} model={req.model} sb_sections={len(sb_sections)} content_chars={len(persona.content_md):,}")
            print(f"[score] {pid[:8]} ═══ SCORER SYSTEM PROMPT ═══\n{scorer_sys}")
            print(f"[score] {pid[:8]} ═══ SCORER USER MESSAGE ({len(score_msg):,} chars) ═══\n{score_msg}")
            raw = _llm_call_temp(scorer_sys, score_msg, req.model, 0.0)
            print(f"[score] {pid[:8]} ═══ SCORER RAW OUTPUT ({len(raw):,} chars) ═══\n{raw}")
            result = _parse_score_json(raw)

            # For SectionBuilder sections: compute weighted average _overall
            if sb_sections:
                sec_weights = {s["name"]: int(s.get("weight", 1)) for s in sb_sections}
                weighted_sum = 0.0
                total_weight = 0
                for sname, w in sec_weights.items():
                    val = result.get(sname)
                    score_val = val.get("score") if isinstance(val, dict) else val
                    if isinstance(score_val, (int, float)):
                        weighted_sum += score_val * w
                        total_weight += w
                if total_weight > 0:
                    result["_overall"] = round(weighted_sum / total_weight)
                    print(f"[score] {pid[:8]} weighted overall={result['_overall']}")

            result["_scorer_system_used"] = scorer_sys
            result["_scorer_prompt_used"] = scorer_prompt
            result["_scorer_user_message_used"] = score_msg
            result["_scorer_model_used"] = req.model
            result["_normaliser_system_used"] = _SCORE_NORMALISE_SYSTEM
            result["_raw_score_text"] = raw
            results[pid] = result
        except Exception as e:
            print(f"[score] Failed {pid}: {e}")
            results[pid] = {"_summary": str(e), "_overall": 0}
    return results


class NormaliseScoreRequest(BaseModel):
    raw_score: dict
    model: str = "gpt-5.4"
    system_prompt: Optional[str] = None
    user_prefix: Optional[str] = None   # prepended to raw score JSON as additional instructions
    temperature: float = 0.0


@router.post("/normalize-score")
def normalize_score_endpoint(req: NormaliseScoreRequest):
    """Run the normaliser LLM on raw scorer output → standard score_json schema."""
    from ui.backend.routers.full_persona_agent import _normalise_score, _SCORE_NORMALISE_SYSTEM
    system = req.system_prompt or _SCORE_NORMALISE_SYSTEM
    raw_str = json.dumps(req.raw_score)
    if req.user_prefix and req.user_prefix.strip():
        raw_str = f"{req.user_prefix.strip()}\n\n{raw_str}"
    result = _normalise_score(raw_str, req.model, system=system, temperature=req.temperature)
    result["_normaliser_system_used"] = system
    result["_normaliser_model_used"] = req.model
    result["_normaliser_temperature"] = req.temperature
    return result


@router.get("/{persona_id}/script")
def get_script(persona_id: str, db: Session = Depends(get_session)):
    """Return the full merged script that was fed to the LLM when this persona was generated."""
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    if not p.script_path:
        raise HTTPException(404, "Script not saved — persona was generated before this feature was added")
    sp = Path(p.script_path)
    if not sp.exists():
        raise HTTPException(404, "Script file missing from disk")
    return {
        "script": sp.read_text(encoding="utf-8", errors="replace"),
        "path": str(sp),
        "size_chars": sp.stat().st_size,
    }


@router.get("/{persona_id}/script/download")
def download_script(persona_id: str, db: Session = Depends(get_session)):
    """Download the merged transcript as a plain-text file."""
    p = db.get(Persona, persona_id)
    if not p:
        raise HTTPException(404, "Persona not found")
    if not p.script_path:
        raise HTTPException(404, "Script not saved")
    sp = Path(p.script_path)
    if not sp.exists():
        raise HTTPException(404, "Script file missing from disk")
    agent_slug = p.agent.replace(" ", "_")
    filename = f"{agent_slug}_{persona_id[:8]}_merged.txt"
    return FileResponse(path=str(sp), filename=filename, media_type="text/plain")
