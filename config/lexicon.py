"""Crypto lexicon prompt template for transcription engines."""
from typing import Dict


CRYPTO_LEXICON_PROMPT_TEMPLATE = """This is a phone conversation between two speakers about cryptocurrency trading.

SPEAKER NAMES:
- {speaker_a}: The advisor/salesperson making the call
- {speaker_b}: The customer receiving the call

CRYPTOCURRENCY & TRADING TERMS (use exact spelling):
- Binance (crypto exchange)
- SwiftX (also SwiftEx - trading platform)
- Ethereum (ETH)
- Bitcoin (BTC)
- Solana (SOL)
- XRP (Ripple)
- Trump coin (TRUMP)
- ETC (Ethereum Classic)
- Portfolio
- Triggers (automated trading orders)
- Dashboard
- Wallet

CURRENCY TERMS:
- USD (US Dollars)
- AUD (Australian Dollars)

COMMON PHRASES:
- "market is boiling" (hot/active market)
- "skyrocketed high"
- "double-check"
- "security code"
- "take over" (remote screen control)

Please transcribe accurately, preserving filler words (um, uh, ah) and natural speech patterns."""


def build_crypto_lexicon_prompt(speaker_a: str, speaker_b: str) -> str:
    """Return a speaker-aware lexicon prompt."""
    return CRYPTO_LEXICON_PROMPT_TEMPLATE.format(speaker_a=speaker_a, speaker_b=speaker_b)
