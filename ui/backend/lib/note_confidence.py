import json
from typing import Optional


def note_requires_review(score_json_str: Optional[str], threshold: int = 70) -> bool:
    """Return True if a note should be held for human review before CRM push.

    Flags when:
    - score_json is missing or unparseable (conservative default)
    - _overall score is below threshold
    - _risk_level is "High" regardless of overall score
    """
    if not score_json_str:
        return True
    try:
        data = json.loads(score_json_str)
    except (json.JSONDecodeError, ValueError):
        return True

    if str(data.get("_risk_level") or "").strip() == "High":
        return True

    overall = data.get("_overall")
    if overall is None:
        return True

    return int(overall) < threshold
