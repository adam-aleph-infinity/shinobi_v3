import os
from types import SimpleNamespace
from typing import List, Dict, Any, Optional

import requests
from openai import OpenAI
import google.generativeai as genai


class LLMClient:
    """
    Lightweight wrapper to talk to OpenAI, Grok (xAI), Gemini, Anthropic, or Mistral
    with a common interface.
    """

    def __init__(
        self,
        provider: str = "openai",
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: int = 300,
    ) -> None:
        provider = (provider or "openai").lower()
        if provider not in {"openai", "grok", "gemini", "mistral", "anthropic"}:
            raise ValueError(f"Unsupported LLM provider: {provider}")

        if not api_key:
            raise ValueError(f"API key required for provider {provider}")

        self.provider = provider
        self.api_key = api_key
        self.timeout = timeout
        self.base_url = base_url or ("https://api.x.ai/v1" if provider == "grok" else None)

        self.client = None
        if self.provider == "openai":
            self.client = OpenAI(api_key=api_key, base_url=self.base_url)
        elif self.provider == "gemini":
            genai.configure(api_key=api_key)
        elif self.provider == "anthropic":
            import anthropic as _anthropic
            self.client = _anthropic.Anthropic(api_key=api_key)

    def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        temperature: float = 0.0,
        max_tokens: Optional[int] = None,
    ):
        if self.provider == "openai":
            kwargs = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
            }
            if max_tokens is not None:
                kwargs["max_completion_tokens"] = max_tokens
            return self.client.chat.completions.create(**kwargs)

        if self.provider == "anthropic":
            # Anthropic expects system prompt separate from messages
            system_content = ""
            user_msgs = []
            for m in messages:
                if m.get("role") == "system":
                    system_content = m.get("content", "")
                else:
                    user_msgs.append(m)
            kwargs = {
                "model": model,
                "max_tokens": max_tokens or 8192,
                "messages": user_msgs,
            }
            if system_content:
                kwargs["system"] = system_content
            if temperature is not None:
                kwargs["temperature"] = temperature
            response = self.client.messages.create(**kwargs)
            content = response.content[0].text
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

        if self.provider == "gemini":
            prompt_parts = []
            for m in messages:
                content = m.get("content", "")
                role = m.get("role", "user")
                prompt_parts.append(f"[{role}] {content}")
            full_prompt = "\n".join(prompt_parts)

            gen_model = genai.GenerativeModel(model)
            response = gen_model.generate_content(
                full_prompt,
                generation_config={
                    "temperature": temperature,
                    **({"max_output_tokens": max_tokens} if max_tokens is not None else {}),
                },
            )
            # response.text raises ValueError if content was blocked; let it propagate.
            # Access candidates directly to produce a clear error message instead of empty string.
            try:
                content = response.text
            except ValueError as e:
                finish = ""
                try:
                    finish = response.candidates[0].finish_reason.name if response.candidates else "NO_CANDIDATES"
                except Exception:
                    pass
                raise RuntimeError(f"Gemini blocked/empty response (finish_reason={finish}): {e}") from e
            if not content:
                finish = ""
                try:
                    finish = response.candidates[0].finish_reason.name if response.candidates else "NO_CANDIDATES"
                except Exception:
                    pass
                raise RuntimeError(f"Gemini returned empty content (finish_reason={finish})")
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

        if self.provider == "mistral":
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Content-Type": "application/json",
            }
            payload: Dict[str, Any] = {
                "model": model,
                "messages": messages,
                "temperature": temperature,
            }
            if max_tokens is not None:
                payload["max_tokens"] = max_tokens

            url = "https://api.mistral.ai/v1/chat/completions"
            resp = requests.post(
                url,
                json=payload,
                headers=headers,
                timeout=self.timeout,
            )
            try:
                resp.raise_for_status()
            except requests.HTTPError as exc:
                raise RuntimeError(f"Mistral API error {resp.status_code}: {resp.text}") from exc
            data = resp.json()

            if not data.get("choices"):
                raise RuntimeError("Mistral returned no choices")

            content = data["choices"][0]["message"].get("content", "")
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )

        # Grok (xAI)
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload: Dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        url = f"{self.base_url.rstrip('/')}/chat/completions"
        resp = requests.post(
            url,
            json=payload,
            headers=headers,
            timeout=self.timeout,
        )
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise RuntimeError(f"Grok API error {resp.status_code}: {resp.text}") from exc
        data = resp.json()

        if not data.get("choices"):
            raise RuntimeError("Grok returned no choices")

        content = data["choices"][0]["message"].get("content", "")
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
        )


def resolve_grok_key(env: Optional[dict] = None) -> Optional[str]:
    env = env or os.environ
    # Explicit GROK_API_KEY wins, then standard xAI envs
    return env.get("GROK_API_KEY") or env.get("XAI_API_KEY") or env.get("xAi_API") or env.get("XAI_API")
