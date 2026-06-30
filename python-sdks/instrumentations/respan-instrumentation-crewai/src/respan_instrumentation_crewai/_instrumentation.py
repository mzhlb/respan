"""CrewAI instrumentation plugin for Respan."""

import importlib
import logging
from typing import Any

from respan_instrumentation_openinference import OpenInferenceInstrumentor
from respan_tracing.core.tracer import RespanTracer

logger = logging.getLogger(__name__)

CREWAI_INSTRUMENTATION_NAME = "crewai"
OPENINFERENCE_CREWAI_MODULE = "openinference.instrumentation.crewai"
USE_EVENT_LISTENER_KWARG = "use_event_listener"
CREATE_LLM_SPANS_KWARG = "create_llm_spans"


def _load_openinference_crewai_class() -> type:
    crewai_module = importlib.import_module(OPENINFERENCE_CREWAI_MODULE)
    return crewai_module.CrewAIInstrumentor


class CrewAIInstrumentor:
    """Respan instrumentor for CrewAI.

    Activates the OpenInference CrewAI instrumentor and registers Respan's
    OpenInference translator so CrewAI spans reach the Respan OTLP pipeline
    with the expected ``traceloop.*``, ``gen_ai.*``, and ``respan.*`` fields.

    """

    name = CREWAI_INSTRUMENTATION_NAME

    def __init__(
        self,
        *,
        use_event_listener: bool = True,
        create_llm_spans: bool = False,
        capture_litellm: bool = True,
        **instrumentor_kwargs: Any,
    ) -> None:
        # OpenInference's own CrewAI LLM spans don't carry the model/tokens/cost
        # (A11). CrewAI runs model calls through LiteLLM, so by default we let the
        # LiteLLM layer emit the LLM spans (capture_litellm) and turn OpenInference's
        # LLM spans off to avoid duplicates. Pass create_llm_spans=True /
        # capture_litellm=False to revert to the OpenInference LLM spans.
        self._instrumentor_kwargs = {
            USE_EVENT_LISTENER_KWARG: use_event_listener,
            CREATE_LLM_SPANS_KWARG: create_llm_spans,
            **instrumentor_kwargs,
        }
        self._capture_litellm = capture_litellm
        self._delegate = None
        self._litellm = None
        self._is_instrumented = False

    @staticmethod
    def _is_respan_tracing_enabled() -> bool:
        tracer = getattr(RespanTracer, "_instance", None)
        if tracer is None:
            return True
        return bool(getattr(tracer, "is_enabled", True))

    def activate(self) -> None:
        """Instrument CrewAI via OpenInference and Respan's translator."""
        if self._is_instrumented:
            return

        if not self._is_respan_tracing_enabled():
            logger.info(
                "CrewAI instrumentation skipped because Respan tracing is disabled"
            )
            return

        try:
            crewai_instrumentor_class = _load_openinference_crewai_class()
        except ImportError as exc:
            logger.warning(
                "Failed to activate CrewAI instrumentation — missing dependency: %s",
                exc,
            )
            return

        try:
            self._delegate = OpenInferenceInstrumentor(
                crewai_instrumentor_class,
                **self._instrumentor_kwargs,
            )
            self._delegate.activate()
            if self._capture_litellm:
                self._activate_litellm_capture()
            self._is_instrumented = True
            logger.info("CrewAI instrumentation activated")
        except Exception:
            if self._delegate is not None:
                try:
                    self._delegate.deactivate()
                except Exception:
                    logger.exception("Failed to clean up CrewAI instrumentation")
            self._delegate = None
            self._is_instrumented = False
            logger.exception("Failed to activate CrewAI instrumentation")

    def _activate_litellm_capture(self) -> None:
        """Capture CrewAI's LiteLLM layer so LLM spans carry model/tokens/cost.

        CrewAI executes model calls through LiteLLM; the OpenInference CrewAI spans
        do not expose that usage (A11). Registering the LiteLLM callback emits LLM
        spans with usage/cost, nested under the active CrewAI agent span. Best-effort:
        skipped (DEBUG) when LiteLLM is already instrumented (avoid duplicate spans)
        or the LiteLLM instrumentor is unavailable.
        """
        try:
            from respan_instrumentation_litellm import LiteLLMInstrumentor
        except ImportError:
            logger.debug(
                "respan-instrumentation-litellm not installed; "
                "CrewAI LLM token/cost capture disabled"
            )
            return

        try:
            import litellm
            from respan_instrumentation_litellm._callback import RespanLiteLLMCallback

            existing = getattr(litellm, "callbacks", None) or []
            if any(isinstance(cb, RespanLiteLLMCallback) for cb in existing):
                logger.debug(
                    "LiteLLM already instrumented; skipping CrewAI's LiteLLM capture"
                )
                return
        except Exception:
            # Detection is best-effort; fall through and let activate() handle it.
            pass

        litellm_instrumentor = LiteLLMInstrumentor()
        litellm_instrumentor.activate()
        self._litellm = litellm_instrumentor

    def deactivate(self) -> None:
        """Deactivate the instrumentation."""
        if self._litellm is not None:
            try:
                self._litellm.deactivate()
            except Exception:
                logger.exception("Failed to deactivate CrewAI LiteLLM capture")
            self._litellm = None
        if self._is_instrumented and self._delegate is not None:
            try:
                self._delegate.deactivate()
            except Exception:
                logger.exception("Failed to deactivate CrewAI instrumentation")
        self._delegate = None
        self._is_instrumented = False
        logger.info("CrewAI instrumentation deactivated")
