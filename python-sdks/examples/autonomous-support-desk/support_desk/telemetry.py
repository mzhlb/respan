"""Respan init + the gateway-routed OpenAI client (plan §6, §10).

Both instrumentors compose (plan §3-item-2):
  - OpenAIAgentsInstrumentor traces the Agents SDK (Responses API).
  - OpenAIInstrumentor traces the direct embeddings call inside search_kb.

The single AsyncOpenAI client points at the Respan gateway, so every LLM call
and the embedding route through Respan.
"""

import os

from openai import AsyncOpenAI
from respan import Respan
from respan_instrumentation_openai import OpenAIInstrumentor
from respan_instrumentation_openai_agents import OpenAIAgentsInstrumentor
from agents import set_default_openai_client

_telemetry: Respan | None = None
_client: AsyncOpenAI | None = None


def _unpatch_openai_responses() -> None:
    """Remove OpenAIInstrumentor's Responses-API wrappers.

    We use OpenAIInstrumentor ONLY for the embedding span in search_kb; the Agents
    SDK's LLM calls (Responses API) are traced by OpenAIAgentsInstrumentor. The
    upstream opentelemetry-instrumentation-openai Responses wrapper also mis-handles
    the Agents SDK's raw-streaming path - its isinstance(Stream/AsyncStream) guard
    misses it and it then reads `.id` off an AsyncStream, crashing every streamed
    call ("'AsyncStream' object has no attribute 'id'"). Unwrapping the Responses
    targets removes that buggy path (and avoids double-tracing the LLM call) while
    leaving chat/completions/embeddings instrumentation intact.
    """
    try:
        from opentelemetry.instrumentation.utils import unwrap
    except Exception:
        return
    # unwrap(obj, attr): obj must be the dotted path to the CLASS, attr the method.
    for cls in ("Responses", "AsyncResponses"):
        for method in ("create", "retrieve", "parse", "cancel"):
            try:
                unwrap(f"openai.resources.responses.{cls}", method)
            except Exception:
                pass


def init_telemetry() -> tuple[Respan, AsyncOpenAI]:
    """Idempotently start tracing and wire the gateway client as the SDK default."""
    global _telemetry, _client
    if _telemetry is not None and _client is not None:
        return _telemetry, _client

    _telemetry = Respan(
        instrumentations=[OpenAIInstrumentor(), OpenAIAgentsInstrumentor()],
    )
    _unpatch_openai_responses()
    _client = AsyncOpenAI(
        api_key=os.getenv("RESPAN_API_KEY"),
        base_url=os.getenv("RESPAN_BASE_URL", "https://api.respan.ai/api"),
    )
    # Route the Agents SDK's model calls through the same gateway client.
    set_default_openai_client(_client)
    return _telemetry, _client


def get_gateway_client() -> AsyncOpenAI:
    """Return the gateway client (for the direct embeddings call in tools)."""
    if _client is None:
        raise RuntimeError("init_telemetry() must be called before get_gateway_client()")
    return _client


def flush() -> None:
    """Force-export buffered spans before the process exits."""
    if _telemetry is not None:
        _telemetry.flush()
