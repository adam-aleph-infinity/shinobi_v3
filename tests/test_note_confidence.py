"""Tests for note confidence / review-required logic.

TDD: these tests are written BEFORE the implementation exists.
Run: pytest tests/test_note_confidence.py
"""
import json
import pytest

from ui.backend.lib.note_confidence import note_requires_review


def test_requires_review_when_overall_below_threshold():
    score_json = json.dumps({"_overall": 60, "_risk_level": "Medium", "_violations": []})
    assert note_requires_review(score_json, threshold=70) is True


def test_no_review_when_overall_at_or_above_threshold():
    score_json = json.dumps({"_overall": 70, "_risk_level": "Low", "_violations": []})
    assert note_requires_review(score_json, threshold=70) is False


def test_no_review_when_overall_well_above_threshold():
    score_json = json.dumps({"_overall": 90, "_risk_level": "Low", "_violations": []})
    assert note_requires_review(score_json, threshold=70) is False


def test_requires_review_when_risk_level_high_regardless_of_score():
    score_json = json.dumps({"_overall": 80, "_risk_level": "High", "_violations": []})
    assert note_requires_review(score_json, threshold=70) is True


def test_requires_review_when_score_json_is_none():
    # No compliance data → conservative default: flag for review
    assert note_requires_review(None, threshold=70) is True


def test_requires_review_when_score_json_is_empty_string():
    assert note_requires_review("", threshold=70) is True


def test_requires_review_when_score_json_is_malformed():
    assert note_requires_review("not-valid-json", threshold=70) is True


def test_no_review_when_medium_risk_and_score_above_threshold():
    score_json = json.dumps({"_overall": 75, "_risk_level": "Medium", "_violations": []})
    assert note_requires_review(score_json, threshold=70) is False


def test_custom_threshold_respected():
    score_json = json.dumps({"_overall": 55, "_risk_level": "Low", "_violations": []})
    assert note_requires_review(score_json, threshold=50) is False
    assert note_requires_review(score_json, threshold=60) is True
