import json
import logging
from typing import Any, Optional

from pydantic_ai.agent import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings
from opentelemetry.sdk.trace import ReadableSpan
from respan_sdk.respan_types._internal_types import Function, FunctionTool, TextModelResponseFormat
from respan_tracing.core.tracer import RespanTracer

logger = logging.getLogger(__name__)

PYDANTIC_AI_REQUEST_PARAMETERS_ATTR = "model_request_parameters"
PYDANTIC_AI_TOOL_DEFINITIONS_ATTR = "gen_ai.tool.definitions"
_PYDANTIC_AI_ENRICHMENT_MARKER = "_respan_pydantic_ai_enrichment_installed"
_PYDANTIC_AI_ADD_PROCESSOR_PATCH_MARKER = (
    "_respan_pydantic_ai_add_span_processor_patched"
)

# Pydantic AI v2 OTel semantic convention keys for structured messages
_GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages"
_GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages"
_GEN_AI_OPERATION_NAME = "gen_ai.operation.name"
_GEN_AI_REQUEST_MODEL = "gen_ai.request.model"

# Backend-recognized attribute names (already in ALL_PROMOTED_KEYS — no
# metadata duplication).  The enrichment remaps Pydantic AI's proprietary
# keys to these so the backend promotes them to CHLogV2 columns.
_TRACELOOP_ENTITY_INPUT = "traceloop.entity.input"
_TRACELOOP_ENTITY_OUTPUT = "traceloop.entity.output"

# OTel semantic convention keys for usage metrics that Pydantic AI emits
# but the backend doesn't yet promote — remap to column names.
_GEN_AI_CACHE_READ_INPUT_TOKENS = "gen_ai.usage.cache_read_input_tokens"
_LLM_USAGE_REASONING_TOKENS = "llm.usage.reasoning_tokens"
_LLM_REQUEST_REASONING_EFFORT = "llm.request.reasoning_effort"

# Backend column names (overridable-keys path via METRIC_COLUMNS / METADATA_COLUMNS)
_BACKEND_PROMPT_CACHE_HIT_TOKENS = "prompt_cache_hit_tokens"
_BACKEND_REASONING_TOKENS = "reasoning_tokens"
_BACKEND_REASONING_EFFORT = "reasoning_effort"

# Mapping from OTel attribute names → backend column names for token metrics
_USAGE_ATTRIBUTE_REMAP = {
    _GEN_AI_CACHE_READ_INPUT_TOKENS: _BACKEND_PROMPT_CACHE_HIT_TOKENS,
    _LLM_USAGE_REASONING_TOKENS: _BACKEND_REASONING_TOKENS,
    _LLM_REQUEST_REASONING_EFFORT: _BACKEND_REASONING_EFFORT,
}

# Pydantic AI agent run span attributes
_PYDANTIC_AI_FINAL_RESULT = "final_result"
_PYDANTIC_AI_MODEL_NAME = "model_name"
_PYDANTIC_AI_AGENT_NAME = "agent_name"
_LOGFIRE_MSG = "logfire.msg"

# Attributes consumed during Pydantic AI chat span enrichment
_PYDANTIC_AI_CONSUMED_ATTRIBUTES = frozenset({
    PYDANTIC_AI_REQUEST_PARAMETERS_ATTR,
    PYDANTIC_AI_TOOL_DEFINITIONS_ATTR,
    _GEN_AI_INPUT_MESSAGES,
    _GEN_AI_OUTPUT_MESSAGES,
})

# Attributes consumed during agent run span enrichment
_AGENT_RUN_CONSUMED_ATTRIBUTES = frozenset({
    _PYDANTIC_AI_FINAL_RESULT,
    _PYDANTIC_AI_MODEL_NAME,
    _PYDANTIC_AI_AGENT_NAME,
    _LOGFIRE_MSG,
})

# OTel usage attributes consumed during universal enrichment
_USAGE_CONSUMED_ATTRIBUTES = frozenset({
    _GEN_AI_CACHE_READ_INPUT_TOKENS,
    _LLM_USAGE_REASONING_TOKENS,
    _LLM_REQUEST_REASONING_EFFORT,
})


def _safe_json_loads(value: Any) -> Any:
    if not isinstance(value, str):
        return value

    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _extract_request_parameters(attributes: dict[str, Any]) -> Optional[dict[str, Any]]:
    request_parameters = _safe_json_loads(
        value=attributes.get(PYDANTIC_AI_REQUEST_PARAMETERS_ATTR)
    )
    if isinstance(request_parameters, dict):
        return request_parameters
    return None


def _normalize_tool_definition(
    tool_definition: dict[str, Any],
) -> Optional[FunctionTool]:
    function_payload = tool_definition.get("function")
    if isinstance(function_payload, dict):
        return FunctionTool.model_validate(tool_definition)

    tool_name = tool_definition.get("name")
    if not tool_name:
        return None

    parameters_schema = tool_definition.get("parameters") or tool_definition.get(
        "parameters_json_schema"
    )
    return FunctionTool(
        type=str(tool_definition.get("type", "function")),
        function=Function(
            name=tool_name,
            description=tool_definition.get("description"),
            parameters=parameters_schema if isinstance(parameters_schema, dict) else None,
            strict=tool_definition.get("strict"),
        ),
    )


def _extract_tools(attributes: dict[str, Any]) -> Optional[list[dict[str, Any]]]:
    tool_definitions = attributes.get("tools")
    if not isinstance(tool_definitions, list):
        tool_definitions = _safe_json_loads(value=tool_definitions)

    if not isinstance(tool_definitions, list):
        tool_definitions = _safe_json_loads(
            value=attributes.get(PYDANTIC_AI_TOOL_DEFINITIONS_ATTR)
        )

    if not isinstance(tool_definitions, list):
        request_parameters = _extract_request_parameters(attributes=attributes)
        if not request_parameters:
            return None

        tool_definitions = [
            *(request_parameters.get("function_tools") or []),
            *(request_parameters.get("output_tools") or []),
        ]

    normalized_tools = []
    for tool_definition in tool_definitions:
        if not isinstance(tool_definition, dict):
            continue

        normalized_tool = _normalize_tool_definition(tool_definition=tool_definition)
        if normalized_tool is not None:
            normalized_tools.append(normalized_tool.model_dump(exclude_none=True))

    if normalized_tools:
        return normalized_tools
    return None


def _build_json_schema_response_format(
    output_object: dict[str, Any],
) -> dict[str, Any]:
    response_format = TextModelResponseFormat(type="json_schema")

    output_schema = output_object.get("json_schema")
    if not isinstance(output_schema, dict):
        return response_format.model_dump()

    json_schema_payload = {"schema": output_schema}

    output_name = output_object.get("name")
    if output_name:
        json_schema_payload["name"] = output_name

    output_description = output_object.get("description")
    if output_description:
        json_schema_payload["description"] = output_description

    strict = output_object.get("strict")
    if strict is not None:
        json_schema_payload["strict"] = strict

    response_format.json_schema = json_schema_payload
    return response_format.model_dump()


def _extract_response_format(
    attributes: dict[str, Any],
) -> Optional[dict[str, Any]]:
    existing_response_format = attributes.get("response_format")
    if isinstance(existing_response_format, dict):
        return TextModelResponseFormat.model_validate(
            existing_response_format
        ).model_dump()

    parsed_existing_response_format = _safe_json_loads(value=existing_response_format)
    if isinstance(parsed_existing_response_format, dict):
        return TextModelResponseFormat.model_validate(
            parsed_existing_response_format
        ).model_dump()

    request_parameters = _extract_request_parameters(attributes=attributes)
    if not request_parameters:
        return None

    output_mode = request_parameters.get("output_mode")
    if not output_mode:
        return None

    if output_mode == "text":
        return TextModelResponseFormat(type="text").model_dump()

    if output_mode == "image":
        return TextModelResponseFormat(type="image").model_dump()

    if output_mode in {"native", "prompted"}:
        output_object = request_parameters.get("output_object") or {}
        if isinstance(output_object, dict):
            return _build_json_schema_response_format(output_object=output_object)
        return TextModelResponseFormat(type="json_schema").model_dump()

    return TextModelResponseFormat(type=str(output_mode)).model_dump()


def _is_pydantic_ai_chat_span(attributes: dict[str, Any]) -> bool:
    return bool(attributes.get("gen_ai.system")) and (
        PYDANTIC_AI_REQUEST_PARAMETERS_ATTR in attributes
        or PYDANTIC_AI_TOOL_DEFINITIONS_ATTR in attributes
    )


def _is_agent_run_span(attributes: dict[str, Any]) -> bool:
    return _PYDANTIC_AI_FINAL_RESULT in attributes


def _extract_input(attributes: dict[str, Any]) -> Optional[Any]:
    """Extract input messages from Pydantic AI v2 ``gen_ai.input.messages``."""
    raw = attributes.get(_GEN_AI_INPUT_MESSAGES)
    if raw is None:
        return None
    parsed = _safe_json_loads(value=raw) if isinstance(raw, str) else raw
    return parsed if parsed is not None else raw


def _extract_output(attributes: dict[str, Any]) -> Optional[Any]:
    """Extract output messages from Pydantic AI v2 ``gen_ai.output.messages``."""
    raw = attributes.get(_GEN_AI_OUTPUT_MESSAGES)
    if raw is None:
        return None
    parsed = _safe_json_loads(value=raw) if isinstance(raw, str) else raw
    return parsed if parsed is not None else raw


def _extract_model(attributes: dict[str, Any], span_name: str) -> Optional[str]:
    """Extract the model name from attributes or the span name.

    Pydantic AI names its chat spans ``chat <model>`` (e.g. ``chat gpt-4o``).
    """
    model = attributes.get(_GEN_AI_REQUEST_MODEL)
    if model:
        return str(model)
    # Fallback: parse from span name "chat <model>"
    if span_name.startswith("chat "):
        return span_name[5:]
    return None


def _enrich_span(span: ReadableSpan) -> None:
    """Enrich spans from the Pydantic AI instrumentation pipeline.

    Three enrichment layers, applied in order:

    1. **Universal** (all spans): remap OTel usage/config attribute names
       to backend column names (e.g. ``gen_ai.usage.cache_read_input_tokens``
       → ``prompt_cache_hit_tokens``).
    2. **Pydantic AI chat spans** (have ``model_request_parameters`` or
       ``gen_ai.tool.definitions``): extract input/output messages, tools,
       response_format, and model.
    3. **Agent run spans** (have ``final_result``): extract the agent's
       final result as output, and ``model_name`` as model.
    """
    try:
        attributes = dict(getattr(span, "attributes", {}) or {})
        enriched = dict(attributes)
        changed = False

        # --- Layer 1: universal usage/config remap (all spans) -----------
        for otel_key, backend_key in _USAGE_ATTRIBUTE_REMAP.items():
            if otel_key in enriched:
                enriched[backend_key] = enriched[otel_key]
                changed = True
        if changed:
            for key in _USAGE_CONSUMED_ATTRIBUTES:
                enriched.pop(key, None)

        # --- Layer 2: Pydantic AI chat span enrichment -------------------
        if _is_pydantic_ai_chat_span(attributes=attributes):
            tools = _extract_tools(attributes=attributes)
            response_format = _extract_response_format(attributes=attributes)
            input_value = _extract_input(attributes=attributes)
            output_value = _extract_output(attributes=attributes)
            model = _extract_model(attributes=attributes, span_name=span.name)

            if input_value is not None:
                serialized = json.dumps(input_value) if not isinstance(input_value, str) else input_value
                enriched[_TRACELOOP_ENTITY_INPUT] = serialized
            if output_value is not None:
                serialized = json.dumps(output_value) if not isinstance(output_value, str) else output_value
                enriched[_TRACELOOP_ENTITY_OUTPUT] = serialized
            if model is not None:
                enriched[_GEN_AI_REQUEST_MODEL] = model
            if tools is not None:
                enriched["tools"] = tools
            if response_format is not None:
                enriched["response_format"] = response_format

            for key in _PYDANTIC_AI_CONSUMED_ATTRIBUTES:
                enriched.pop(key, None)
            changed = True

        # --- Layer 3: agent run span enrichment --------------------------
        elif _is_agent_run_span(attributes=attributes):
            final_result = attributes.get(_PYDANTIC_AI_FINAL_RESULT)
            if final_result is not None:
                serialized = json.dumps(final_result) if not isinstance(final_result, str) else final_result
                enriched[_TRACELOOP_ENTITY_OUTPUT] = serialized

            model_name = attributes.get(_PYDANTIC_AI_MODEL_NAME)
            if model_name is not None:
                enriched[_GEN_AI_REQUEST_MODEL] = str(model_name)

            for key in _AGENT_RUN_CONSUMED_ATTRIBUTES:
                enriched.pop(key, None)
            changed = True

        if changed:
            span._attributes = enriched
    except Exception:
        logger.exception("Failed to enrich span attributes.")


def _wrap_span_processor(span_processor: Any) -> None:
    if getattr(span_processor, _PYDANTIC_AI_ENRICHMENT_MARKER, False):
        return

    original_on_end = span_processor.on_end

    def _wrapped_on_end(span: ReadableSpan) -> None:
        _enrich_span(span=span)
        original_on_end(span)

    span_processor.on_end = _wrapped_on_end
    setattr(span_processor, _PYDANTIC_AI_ENRICHMENT_MARKER, True)


def _install_pydantic_ai_span_enrichment(tracer: RespanTracer) -> None:
    tracer_provider = getattr(tracer, "tracer_provider", None)
    if tracer_provider is None:
        return

    if not getattr(tracer_provider, _PYDANTIC_AI_ADD_PROCESSOR_PATCH_MARKER, False):
        original_add_span_processor = tracer_provider.add_span_processor

        def _wrapped_add_span_processor(span_processor: Any) -> None:
            _wrap_span_processor(span_processor=span_processor)
            original_add_span_processor(span_processor)

        tracer_provider.add_span_processor = _wrapped_add_span_processor
        setattr(tracer_provider, _PYDANTIC_AI_ADD_PROCESSOR_PATCH_MARKER, True)

    active_span_processor = getattr(tracer_provider, "_active_span_processor", None)
    span_processors = getattr(active_span_processor, "_span_processors", ())
    for buffering_processor in span_processors:
        _wrap_span_processor(span_processor=buffering_processor)


def instrument_pydantic_ai(
    agent: Optional[Agent] = None,
    include_content: bool = True,
    include_binary_content: bool = True,
) -> None:
    """
    Instruments Pydantic AI with Respan telemetry via OpenTelemetry.
    
    If an agent is provided, instruments only that agent.
    Otherwise, instruments all Pydantic AI agents globally.
    
    Args:
        agent: Optional Agent to instrument. If None, instruments globally.
        include_content: Whether to include message content in telemetry.
        include_binary_content: Whether to include binary content in telemetry.
    """
    if not RespanTracer.is_initialized():
        logger.warning(
            "Respan telemetry is not initialized. "
            "Please initialize RespanTelemetry before calling instrument_pydantic_ai()."
        )
        return
    
    tracer = RespanTracer()
    
    if not tracer.is_enabled:
        logger.warning("Respan telemetry is disabled.")
        return
    
    # tracer_provider is guaranteed to exist here: is_initialized() and is_enabled
    # guards above ensure _setup_tracer_provider() has run. Pydantic AI also accepts
    # None (falls back to global provider), but we always have the explicit one.
    _install_pydantic_ai_span_enrichment(tracer=tracer)

    settings = InstrumentationSettings(
        tracer_provider=tracer.tracer_provider,
        include_content=include_content,
        include_binary_content=include_binary_content,
        # We use version 2 by default to support standard OTel semantic conventions
        version=2,
    )
    
    if agent is not None:
        agent.instrument = settings
    else:
        Agent.instrument_all(instrument=settings)
