import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  SpanAttributes,
  TraceloopSpanKindValues,
} from "@traceloop/ai-semantic-conventions";
import {
  RespanLogType,
  RespanSpanAttributes,
  type RespanSpanNameStyle,
} from "@respan/respan-sdk";

type SpanAttrs = Record<string, unknown>;

const INTERNAL_KIND_ATTR = RespanSpanAttributes.RESPAN_INTERNAL_SPAN_NAME_KIND;
const INTERNAL_DETAIL_ATTR = RespanSpanAttributes.RESPAN_INTERNAL_SPAN_NAME_DETAIL;
const INTERNAL_DROP_ATTR = RespanSpanAttributes.RESPAN_INTERNAL_DROP_SPAN;
const INTERNAL_EXPORT_PARENT_ATTR = RespanSpanAttributes.RESPAN_INTERNAL_EXPORT_PARENT;

const INTERNAL_SPAN_NAME_ATTRS = [
  INTERNAL_KIND_ATTR,
  INTERNAL_DETAIL_ATTR,
  INTERNAL_DROP_ATTR,
  INTERNAL_EXPORT_PARENT_ATTR,
] as const;

const SUFFIXED_OPERATIONS = new Set(["agent", "tool", "handoff", "llm"]);

// Operation/structural tokens that must not survive as a semantic-name suffix
// (e.g. "handoff.task" or "llm.doGenerate" — the suffix carries no identity).
const GENERIC_DETAIL_TOKENS = new Set([
  "agent",
  "chat",
  "completion",
  "completions",
  "doembed",
  "dogenerate",
  "dostream",
  "embedding",
  "generate",
  "generation",
  "guardrail",
  "handoff",
  "llm",
  "response",
  "responses",
  "task",
  "text",
  "tool",
  "workflow",
]);

export function resolveSpanNameStyle(
  value?: RespanSpanNameStyle | string
): RespanSpanNameStyle {
  return value === "legacy" ? "legacy" : "semantic";
}

export function transformReadableSpanName(
  span: ReadableSpan,
  style: RespanSpanNameStyle | string | undefined
): ReadableSpan {
  const resolvedStyle = resolveSpanNameStyle(style);
  const attrs = span.attributes as SpanAttrs;
  const attributes = stripInternalSemanticNameAttrs(attrs);
  const name =
    resolvedStyle === "semantic" ? semanticSpanNameForSpan(span) : span.name;
  const parentSpanId =
    resolvedStyle === "semantic"
      ? stringAttr(attrs, INTERNAL_EXPORT_PARENT_ATTR)
      : undefined;

  if (
    name === span.name &&
    attributes === span.attributes &&
    parentSpanId === undefined
  ) {
    return span;
  }

  return cloneReadableSpan(span, name, attributes, parentSpanId);
}

export function semanticSpanNameForSpan(span: ReadableSpan): string {
  const attrs = span.attributes as SpanAttrs;
  const operation = resolveOperation(attrs, span.name);
  const detail = resolveDetail(attrs, span.name, operation);

  const hasInternalHint =
    attrs[INTERNAL_KIND_ATTR] !== undefined || attrs[INTERNAL_DETAIL_ATTR] !== undefined;

  if (!SUFFIXED_OPERATIONS.has(operation)) {
    return operation;
  }

  if (operation === "llm") {
    return detail ? `${operation}.${detail}` : operation;
  }

  if (!hasInternalHint && span.name.startsWith(`${operation}.`)) {
    const existingDetail = span.name.slice(operation.length + 1);
    if (existingDetail && !GENERIC_DETAIL_TOKENS.has(existingDetail.toLowerCase())) {
      return span.name;
    }
  }

  if (!detail || detail.toLowerCase() === operation) {
    return operation;
  }

  return `${operation}.${detail}`;
}

export function transformReadableSpanBatch(
  spans: ReadableSpan[],
  style: RespanSpanNameStyle | string | undefined
): ReadableSpan[] {
  const resolvedStyle = resolveSpanNameStyle(style);

  // Dropping and reparenting are per-span decisions driven entirely by
  // attributes the owning instrumentation stamped at span start
  // (respan.internal.drop_span on the wrapper, export_parent_span_id on its
  // children) — no cross-span state, so batch boundaries cannot break trees.
  // Legacy style preserves the emitted tree exactly.
  if (resolvedStyle === "legacy") {
    return spans.map((span) => transformReadableSpanName(span, resolvedStyle));
  }

  return spans.flatMap((span) => {
    const attrs = span.attributes as SpanAttrs;
    if (attrs[INTERNAL_DROP_ATTR] === true || attrs[INTERNAL_DROP_ATTR] === "true") {
      return [];
    }
    return [transformReadableSpanName(span, resolvedStyle)];
  });
}

export class SpanNameTransformingExporter implements SpanExporter {
  constructor(
    private readonly delegate: SpanExporter,
    private readonly style: RespanSpanNameStyle
  ) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    this.delegate.export(
      transformReadableSpanBatch(spans, this.style),
      resultCallback
    );
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    const maybeFlush = (this.delegate as { forceFlush?: () => Promise<void> })
      .forceFlush;
    return maybeFlush ? maybeFlush.call(this.delegate) : Promise.resolve();
  }
}

function stripInternalSemanticNameAttrs(attrs: SpanAttrs): SpanAttrs {
  let next: SpanAttrs | undefined;

  for (const key of INTERNAL_SPAN_NAME_ATTRS) {
    if (attrs[key] !== undefined) {
      next ??= { ...attrs };
      delete next[key];
    }
  }

  return next ?? attrs;
}

function cloneReadableSpan(
  span: ReadableSpan,
  name: string,
  attributes: SpanAttrs,
  parentSpanId?: string
): ReadableSpan {
  const clone = Object.create(Object.getPrototypeOf(span));
  Object.assign(clone, span);
  Object.defineProperty(clone, "name", {
    value: name,
    enumerable: true,
    configurable: true,
  });
  Object.defineProperty(clone, "attributes", {
    value: attributes,
    enumerable: true,
    configurable: true,
  });
  if (parentSpanId !== undefined && parentSpanId !== (span as any).parentSpanId) {
    // OTel SDK 1.x exposes parentSpanId on ReadableSpan; revisit for SDK 2.x
    // (parentSpanContext) when the workspace upgrades.
    Object.defineProperty(clone, "parentSpanId", {
      value: parentSpanId,
      enumerable: true,
      configurable: true,
    });
  }
  return clone as ReadableSpan;
}

function resolveOperation(attrs: SpanAttrs, spanName: string): string {
  const hintedKind = stringAttr(attrs, INTERNAL_KIND_ATTR);
  if (hintedKind) {
    return sanitizeNamePart(mapOperation(hintedKind), "span");
  }

  const tlKind = stringAttr(attrs, SpanAttributes.TRACELOOP_SPAN_KIND);
  if (tlKind) {
    return sanitizeNamePart(mapOperation(tlKind), "span");
  }

  const logType = stringAttr(attrs, RespanSpanAttributes.RESPAN_LOG_TYPE);
  if (logType) {
    return sanitizeNamePart(mapOperation(logType), "span");
  }

  return sanitizeNamePart(inferOperationFromName(spanName), "span");
}

function resolveDetail(
  attrs: SpanAttrs,
  spanName: string,
  operation: string
): string {
  if (operation === "llm") {
    const model = resolveLlmModel(attrs);
    return model ? sanitizeNamePart(model, "") : "";
  }

  const hintedDetail = stringAttr(attrs, INTERNAL_DETAIL_ATTR);
  if (hintedDetail) {
    return sanitizeNamePart(hintedDetail, "");
  }

  const entityName = stringAttr(attrs, SpanAttributes.TRACELOOP_ENTITY_NAME);
  if (entityName) {
    return sanitizeNamePart(entityName, "");
  }

  const rawDetail = detailFromRawName(spanName, operation);
  if (rawDetail && GENERIC_DETAIL_TOKENS.has(rawDetail.toLowerCase())) {
    return "";
  }
  return sanitizeNamePart(rawDetail, "");
}

function resolveLlmModel(attrs: SpanAttrs): string | undefined {
  return firstStringAttr(attrs, [
    RespanSpanAttributes.GEN_AI_REQUEST_MODEL,
    RespanSpanAttributes.OPENINFERENCE_LLM_MODEL_NAME,
    "llm.model_name",
    "model",
    SpanAttributes.LLM_REQUEST_MODEL,
  ]);
}

function firstStringAttr(attrs: SpanAttrs, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringAttr(attrs, key);
    if (value) return value;
  }
  return undefined;
}

function stringAttr(attrs: SpanAttrs, key: string): string | undefined {
  const value = attrs[key];
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function mapOperation(value: string): string {
  const normalized = value.toLowerCase();

  switch (normalized) {
    case TraceloopSpanKindValues.WORKFLOW:
    case RespanLogType.WORKFLOW:
      return "workflow";
    case TraceloopSpanKindValues.AGENT:
    case RespanLogType.AGENT:
      return "agent";
    case TraceloopSpanKindValues.TASK:
    case RespanLogType.TASK:
      return "task";
    case TraceloopSpanKindValues.TOOL:
    case RespanLogType.TOOL:
      return "tool";
    case RespanLogType.FUNCTION:
      return "tool";
    case RespanLogType.HANDOFF:
      return "handoff";
    case RespanLogType.GUARDRAIL:
      return "guardrail";
    case RespanLogType.EMBEDDING:
    case "embedding":
    case "embed":
      return "embedding";
    case RespanLogType.TRANSCRIPTION:
      return "transcribe";
    case RespanLogType.SPEECH:
      return "speech";
    case RespanLogType.CHAT:
    case RespanLogType.TEXT:
    case RespanLogType.RESPONSE:
    case RespanLogType.GENERATION:
    case "generate":
    case "llm":
      return "llm";
    case RespanLogType.CUSTOM:
    case RespanLogType.UNKNOWN:
      return "span";
    default:
      return normalized;
  }
}

function inferOperationFromName(spanName: string): string {
  const suffix = spanName.split(".").at(-1);
  if (suffix) {
    const mapped = mapOperation(suffix);
    if (GENERIC_DETAIL_TOKENS.has(suffix.toLowerCase())) {
      return mapped;
    }
  }

  return "span";
}

function detailFromRawName(spanName: string, operation: string): string {
  if (spanName.endsWith(`.${operation}`)) {
    return spanName.slice(0, -(operation.length + 1));
  }

  if (spanName.startsWith(`${operation}.`)) {
    return spanName.slice(operation.length + 1);
  }

  if (operation === "handoff") {
    return spanName.replace(/^handoff\s*[:.-]?\s*/i, "");
  }

  return spanName;
}

function sanitizeNamePart(value: string, fallback: string): string {
  const sanitized = value
    .trim()
    .replace(/\s*(?:→|->)\s*/g, "_")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[_\-.]+|[_\-.]+$/g, "");

  return sanitized || fallback;
}
