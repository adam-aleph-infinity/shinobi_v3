"""Text normalization and comparison utilities."""
import re
from typing import List, Tuple, Set

FILLER_WORDS: Set[str] = {"uh", "um", "eh", "mm-hmm", "ah", "hmm", "mhm"}

NORMALIZATION_MAP = {
    "10": "ten", "0": "zero", "1": "one", "2": "two", "3": "three",
    "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight",
    "9": "nine", "usd": "us", "aud": "australian dollar", "ok": "okay",
    "alright": "all right", "yep": "yes", "yeah": "yes",
    "mm-hmm": "yes", "mmhmm": "yes", "percent": "%",
}


def clean_for_diff(text: str) -> str:
    """Normalize text for comparison (lowercase, no punctuation, no fillers, normalize numbers)."""
    if not text:
        return ""
    text = re.sub(r'\[.*?\]', '', text)
    text = text.lower()
    text = text.replace('\u2014', ' ').replace('-', ' ')
    text = re.sub(r'[^\w\s%]', '', text)

    words = text.split()
    filtered = []
    for w in words:
        if w in FILLER_WORDS:
            continue
        norm_w = NORMALIZATION_MAP.get(w, w)
        if norm_w == "%":
            norm_w = "percent"
        if "%" in norm_w and len(norm_w) > 1:
            filtered.append(norm_w.replace("%", ""))
            filtered.append("percent")
            continue
        filtered.append(norm_w)
    return " ".join(filtered)


def load_segments(file_path: str) -> List[str]:
    """Load transcript file, stripping headers/timestamps, returning text segments."""
    segments = []
    with open(file_path, 'r') as f:
        lines = f.readlines()
    current_segment: List[str] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.isdigit():
            continue
        is_header = ('-->' in line) and (line[0].isdigit() or line.startswith('['))
        if is_header:
            if current_segment:
                segments.append(" ".join(current_segment))
                current_segment = []
            continue
        current_segment.append(line)
    if current_segment:
        segments.append(" ".join(current_segment))
    return segments


def tokenize_segments(segments: List[str]) -> Tuple[List[str], List[int]]:
    """Tokenize segments into words with segment index mapping."""
    words = []
    mapping = []
    for idx, seg in enumerate(segments):
        seg_words = seg.split()
        for w in seg_words:
            words.append(w)
            mapping.append(idx)
    return words, mapping


def num_to_words(text: str) -> str:
    """Convert numbers in text to words."""
    units = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
    tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

    def small_num(n):
        if n == 0: return ""
        if n < 10: return units[n]
        if n < 20: return teens[n - 10]
        if n < 100: return tens[n // 10] + (" " + units[n % 10] if n % 10 != 0 else "")
        if n < 1000: return units[n // 100] + " hundred" + (" " + small_num(n % 100) if n % 100 != 0 else "")
        return ""

    def number_to_words(match):
        original = match.group(0)
        clean_num = original.replace(',', '')
        try:
            n = int(clean_num)
        except ValueError:
            return original
        if n == 0:
            return "zero"
        parts = []
        if n >= 1_000_000_000:
            parts.append(small_num(n // 1_000_000_000) + " billion")
            n %= 1_000_000_000
        if n >= 1_000_000:
            parts.append(small_num(n // 1_000_000) + " million")
            n %= 1_000_000
        if n >= 1000:
            parts.append(small_num(n // 1000) + " thousand")
            n %= 1000
        if n > 0:
            parts.append(small_num(n))
        return " ".join(parts)

    return re.sub(r'\b\d{1,3}(,\d{3})*(\.\d+)?\b|\b\d+\b', number_to_words, text)


def clean_text(text: str) -> str:
    """Deep text normalization: lowercase, no brackets, numbers->words, no punctuation, no fillers."""
    text = text.lower()
    text = re.sub(r'\[.*?\]', '', text)
    text = text.replace('-', ' ')
    text = text.replace("swftx", "swift x")
    text = re.sub(r'(\d+)k\b', r'\1 thousand', text)
    text = num_to_words(text)
    text = re.sub(r'[^\w\s]', '', text)
    fillers = ['ah', 'uh', 'um', 'eh', 'mm', 'mmm', 'hm', 'hmm', 'mhm']
    for filler in fillers:
        text = re.sub(r'\b' + filler + r'\b', '', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def parse_transcript(path: str) -> str:
    """Parse SRT/text transcript into plain text."""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    if '-->' in content:
        blocks = re.split(r'\n\s*\n', content.strip())
        full_text = []
        for block in blocks:
            lines = block.strip().split('\n')
            if len(lines) < 2:
                continue
            for i, line in enumerate(lines[:3]):
                if '-->' in line:
                    raw_text = " ".join(lines[i + 1:])
                    text = re.sub(r'^\[.*?\]:?\s*', '', raw_text)
                    full_text.append(text)
                    break
        if full_text:
            return " ".join(full_text)

    lines = content.splitlines()
    full_text = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if re.match(r'\[[\d\.]+ --> [\d\.]+\]', line):
            continue
        if '-->' in line:
            continue
        full_text.append(line)
    return " ".join(full_text)
