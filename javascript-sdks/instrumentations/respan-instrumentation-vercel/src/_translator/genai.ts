/**
 * Vercel AI SDK v7 telemetry (A12).
 *
 * v7 removed built-in OpenTelemetry from the `ai` package; spans now come from the
 * separate `@ai-sdk/otel` package and use the OTEL GenAI semantic conventions
 * (instrumentation scope "gen_ai", span names like "chat"/"invoke_agent"/"step N",
 * `gen_ai.*` attributes) instead of the v5/v6 Traceloop-style `ai.*` spans.
 *
 * This module detects those spans and maps them to the Respan format the backend
 * reads (respan.entity.log_type, traceloop.entity.input/output, gen_ai.usage.*).
 */
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { RespanLogType } from "@respan/respan-sdk";

import { enrichTokens } from "./span-enrichment.js";
import {
  LLM_REQUEST_TYPE,
  RESPAN_LOG_TYPE,
  RESPAN_METADATA_AGENT_NAME,
  TL_ENTITY_INPUT,
  TL_ENTITY_OUTPUT,
  TL_SPAN_KIND,
  safeJsonStr,
  setDefault,
} from "./shared.js";

export const GENAI_SCOPE = "gen_ai";
const GEN_AI_OPERATION_NAME = "gen_ai.operation.name";
const GEN_AI_INPUT_MESSAGES = "gen_ai.input.messages";
const GEN_AI_OUTPUT_MESSAGES = "gen_ai.output.messages";

type SpanAttributes = Record<string, any>;

function spanScopeName(span: ReadableSpan): string | undefined {
  return (
    (span as any).instrumentationScope?.name ??
    (span as any).instrumentationLibrary?.name
  );
}

/** True for `@ai-sdk/otel` (Vercel AI SDK v7) GenAI-convention spans. */
export function isGenAIConventionSpan(span: ReadableSpan): boolean {
  return (
    spanScopeName(span) === GENAI_SCOPE &&
    (span as any).attributes?.[GEN_AI_OPERATION_NAME] !== undefined
  );
}

/**
 * onStart helper. Attributes aren't populated yet at onStart, so map by span
 * name ("chat ..." / "invoke_agent ..." / "step N") just to set *some*
 * respan.entity.log_type — without it the composite processor filters the span
 * out before onEnd can enrich it. onEnd sets the authoritative value.
 */
export function genAILogTypeForName(name: string): string {
  if (name.startsWith("chat")) return RespanLogType.CHAT;
  if (name.startsWith("invoke_agent")) return RespanLogType.AGENT;
  return RespanLogType.TASK;
}

function logTypeForOperation(op: string): string {
  switch (op) {
    case "chat":
    case "text_completion":
      return RespanLogType.CHAT;
    case "embeddings":
      return RespanLogType.EMBEDDING;
    case "invoke_agent":
      return RespanLogType.AGENT;
    default:
      return RespanLogType.TASK;
  }
}

/**
 * v7 messages are parts-based: `[{role, parts:[{type:"text", content}]}]`.
 * Flatten to the `[{role, content}]` shape Respan reads; preserve non-text parts.
 */
function flattenGenAIMessages(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  if (!Array.isArray(parsed)) return raw;

  const messages = parsed.map((m: any) => {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    const content = parts
      .filter((p: any) => p?.type === "text" && typeof p.content === "string")
      .map((p: any) => p.content)
      .join("");
    const msg: Record<string, any> = { role: m?.role ?? "user", content };
    const nonText = parts.filter((p: any) => p?.type !== "text");
    if (nonText.length > 0) msg.parts = nonText;
    return msg;
  });
  return safeJsonStr(messages);
}

/** Map a v7 `gen_ai.*` span's attributes to the Respan format (in place). */
export function enrichGenAIConventionSpan(attrs: SpanAttributes): void {
  const op = String(attrs[GEN_AI_OPERATION_NAME] ?? "");
  const logType = logTypeForOperation(op);

  attrs[RESPAN_LOG_TYPE] = logType;
  delete attrs[TL_SPAN_KIND];

  const input = flattenGenAIMessages(attrs[GEN_AI_INPUT_MESSAGES]);
  if (input) setDefault(attrs, TL_ENTITY_INPUT, input);
  const output = flattenGenAIMessages(attrs[GEN_AI_OUTPUT_MESSAGES]);
  if (output) setDefault(attrs, TL_ENTITY_OUTPUT, output);

  if (logType === RespanLogType.CHAT) {
    setDefault(attrs, LLM_REQUEST_TYPE, RespanLogType.CHAT);
    // gen_ai.request.model is already the Respan model key; tokens come from
    // gen_ai.usage.input_tokens/output_tokens, which enrichTokens reads.
    enrichTokens(attrs);
  } else if (logType === RespanLogType.AGENT) {
    const agentName = attrs["gen_ai.agent.name"] ?? attrs["gen_ai.request.model"];
    if (agentName) setDefault(attrs, RESPAN_METADATA_AGENT_NAME, String(agentName));
  }
}
