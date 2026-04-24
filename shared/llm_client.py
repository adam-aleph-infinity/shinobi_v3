import os
import json
import uuid
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
        thinking: bool = False,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: Optional[Any] = None,
    ):
        if self.provider == "openai":
            # Reasoning models (o-series and gpt-5.x) reject temperature — omit it entirely.
            # Passing temperature=0 to these models causes a misleading 400 "invalid JSON body" error.
            _REASONING_PREFIXES = ("o1", "o2", "o3", "o4", "gpt-5")
            skip_temp = any(model.lower().startswith(p) for p in _REASONING_PREFIXES)
            kwargs = {"model": model, "messages": messages}
            if not skip_temp:
                kwargs["temperature"] = 0
                kwargs["seed"] = 12345
            if max_tokens is not None:
                kwargs["max_completion_tokens"] = max_tokens
            if tools:
                kwargs["tools"] = tools
            if tool_choice is not None:
                kwargs["tool_choice"] = tool_choice
            if thinking:
                # Enforce highest OpenAI reasoning setting for copilot quality.
                kwargs["reasoning_effort"] = "high"
            try:
                return self.client.chat.completions.create(**kwargs)
            except Exception as exc:
                # Backward-compat fallback if an endpoint/model rejects reasoning_effort.
                if "reasoning_effort" in kwargs:
                    fallback = dict(kwargs)
                    fallback.pop("reasoning_effort", None)
                    return self.client.chat.completions.create(**fallback)
                raise exc

        if self.provider == "anthropic":
            # Anthropic expects system prompt separate from messages, and uses
            # content blocks for tool_use/tool_result.
            system_content = ""
            anthropic_messages: List[Dict[str, Any]] = []

            def _append_user_tool_result(tool_use_id: str, content: str) -> None:
                block = {
                    "type": "tool_result",
                    "tool_use_id": tool_use_id,
                    "content": content,
                }
                if anthropic_messages and anthropic_messages[-1].get("role") == "user":
                    prev = anthropic_messages[-1].get("content")
                    if isinstance(prev, list):
                        prev.append(block)
                        return
                anthropic_messages.append({"role": "user", "content": [block]})

            for m in messages:
                role = str(m.get("role") or "")
                if role == "system":
                    text = str(m.get("content") or "").strip()
                    if text:
                        system_content = f"{system_content}\n\n{text}".strip() if system_content else text
                    continue

                if role == "tool":
                    tool_call_id = str(m.get("tool_call_id") or "").strip()
                    _append_user_tool_result(tool_call_id, str(m.get("content") or ""))
                    continue

                if role == "assistant":
                    blocks: List[Dict[str, Any]] = []
                    text = str(m.get("content") or "")
                    if text.strip():
                        blocks.append({"type": "text", "text": text})
                    raw_tool_calls = m.get("tool_calls") or []
                    if isinstance(raw_tool_calls, list):
                        for tc in raw_tool_calls:
                            if not isinstance(tc, dict):
                                continue
                            fn = tc.get("function") or {}
                            name = str(fn.get("name") or "").strip()
                            if not name:
                                continue
                            raw_args = str(fn.get("arguments") or "{}")
                            try:
                                parsed_args = json.loads(raw_args) if raw_args.strip() else {}
                            except Exception:
                                parsed_args = {}
                            blocks.append(
                                {
                                    "type": "tool_use",
                                    "id": str(tc.get("id") or str(uuid.uuid4())),
                                    "name": name,
                                    "input": parsed_args if isinstance(parsed_args, dict) else {},
                                }
                            )
                    if blocks:
                        anthropic_messages.append({"role": "assistant", "content": blocks})
                    continue

                # default user-like message
                anthropic_messages.append({"role": "user", "content": str(m.get("content") or "")})

            anthropic_tools: List[Dict[str, Any]] = []
            if tools:
                for t in tools:
                    if not isinstance(t, dict):
                        continue
                    fn = t.get("function") or {}
                    name = str(fn.get("name") or "").strip()
                    if not name:
                        continue
                    anthropic_tools.append(
                        {
                            "name": name,
                            "description": str(fn.get("description") or ""),
                            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
                        }
                    )

            kwargs = {
                "model": model,
                "max_tokens": max_tokens or (32000 if thinking else 8192),
                "messages": anthropic_messages,
            }
            if system_content:
                kwargs["system"] = system_content
            if thinking:
                # Extended thinking requires temperature=1 (Anthropic hard requirement)
                budget = int(os.environ.get("ASSISTANT_ANTHROPIC_THINKING_BUDGET", "32000"))
                budget = max(32000, budget)
                kwargs["thinking"] = {"type": "enabled", "budget_tokens": max(1024, min(32000, budget))}
                kwargs["temperature"] = 1
            elif temperature is not None:
                kwargs["temperature"] = temperature
            if anthropic_tools:
                kwargs["tools"] = anthropic_tools
                if tool_choice is not None:
                    if isinstance(tool_choice, str):
                        if tool_choice in {"auto", "none"}:
                            kwargs["tool_choice"] = {"type": tool_choice}
                    elif isinstance(tool_choice, dict):
                        # OpenAI-style {"type":"function","function":{"name":"..."}}
                        if (
                            tool_choice.get("type") == "function"
                            and isinstance(tool_choice.get("function"), dict)
                            and str(tool_choice["function"].get("name") or "").strip()
                        ):
                            kwargs["tool_choice"] = {
                                "type": "tool",
                                "name": str(tool_choice["function"]["name"]),
                            }
                        elif str(tool_choice.get("type") or "") in {"auto", "none", "tool"}:
                            kwargs["tool_choice"] = tool_choice

            response = self.client.messages.create(**kwargs)
            # Extract text + convert tool_use blocks into OpenAI-like tool_calls.
            text_parts: List[str] = []
            tool_calls: List[Dict[str, Any]] = []
            for block in getattr(response, "content", []) or []:
                btype = getattr(block, "type", None)
                if btype == "text":
                    text_parts.append(getattr(block, "text", "") or "")
                elif btype == "tool_use":
                    args = getattr(block, "input", {}) or {}
                    if not isinstance(args, dict):
                        args = {}
                    tool_calls.append(
                        {
                            "id": str(getattr(block, "id", "") or str(uuid.uuid4())),
                            "type": "function",
                            "function": {
                                "name": str(getattr(block, "name", "") or ""),
                                "arguments": json.dumps(args, ensure_ascii=False),
                            },
                        }
                    )
            content = "\n\n".join(p for p in text_parts if p).strip()
            return SimpleNamespace(
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(
                            content=content,
                            tool_calls=tool_calls,
                        )
                    )
                ]
            )

        if self.provider == "gemini":
            prompt_parts = []
            for m in messages:
                content = m.get("content", "")
                role = m.get("role", "user")
                prompt_parts.append(f"[{role}] {content}")
            full_prompt = "\n".join(prompt_parts)

            gen_model = genai.GenerativeModel(model)
            gen_cfg: dict = {"temperature": temperature}
            if max_tokens is not None:
                gen_cfg["max_output_tokens"] = max_tokens
            if thinking:
                # Gemini 2.5 thinking budget (0 = disabled, higher = more thinking)
                gen_cfg["thinking_config"] = {"thinking_budget": 8192}
            response = gen_model.generate_content(
                full_prompt,
                generation_config=gen_cfg,
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
