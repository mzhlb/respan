import test from "node:test";
import assert from "node:assert/strict";
import { VercelAITranslator } from "../dist/_translator.js";

// Run a v7 (@ai-sdk/otel) gen_ai-scope span through the translator.
function runV7(name, attributes) {
  const scope = { name: "gen_ai" };
  const span = { name, instrumentationScope: scope, instrumentationLibrary: scope, attributes: { ...attributes } };
  const writableSpan = { name, instrumentationScope: scope, instrumentationLibrary: scope,
    setAttribute(k, v) { span.attributes[k] = v; } };
  const t = new VercelAITranslator();
  t.onStart(writableSpan, undefined);
  // mirror onStart writes onto the readable span
  Object.assign(span.attributes, writableSpan.attributes ?? {});
  t.onEnd(span);
  return span.attributes;
}

const v7Chat = {
  "gen_ai.operation.name": "chat",
  "gen_ai.request.model": "gpt-4o-mini",
  "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: "what is 6x7?" }] }]),
  "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: "42" }] }]),
  "gen_ai.usage.input_tokens": 12,
  "gen_ai.usage.output_tokens": 7,
};

test("v7 chat span -> LLM chat with model, messages, tokens", () => {
  const a = runV7("chat gpt-4o-mini", v7Chat);
  assert.equal(a["respan.entity.log_type"], "chat");
  assert.equal(a["llm.request.type"], "chat");
  assert.equal(a["gen_ai.request.model"], "gpt-4o-mini");
  assert.equal(a["gen_ai.usage.prompt_tokens"], 12);
  assert.equal(a["gen_ai.usage.completion_tokens"], 7);
  assert.match(a["traceloop.entity.input"], /what is 6x7\?/);
  assert.match(a["traceloop.entity.output"], /42/);
});

test("v7 invoke_agent -> agent (structural, not an LLM call)", () => {
  const a = runV7("invoke_agent gpt-4o-mini", { ...v7Chat, "gen_ai.operation.name": "invoke_agent" });
  assert.equal(a["respan.entity.log_type"], "agent");
  assert.equal(a["llm.request.type"], undefined); // not double-counted as an LLM call
});

test("v7 agent_step -> task", () => {
  const a = runV7("step 1", { "gen_ai.operation.name": "agent_step" });
  assert.equal(a["respan.entity.log_type"], "task");
});
