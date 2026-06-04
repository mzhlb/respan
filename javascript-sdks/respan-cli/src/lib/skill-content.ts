// Skill content strings and assembly.
//
// These are the multi-kilobyte markdown payloads written into each coding
// agent's skill directory by installSkill(). They live here (rather than on a
// command class) so the setup command shells stay thin and BaseCommand stays
// free of setup-only concerns.
//
// The per-feature reference constants (TRACING_MD, GATEWAY_MD, …) are generated
// from skills/references/*.md by scripts/embed-skill-refs.mjs.

// ── Routing index (SKILL.md body) ──────────────────────────────────────

export const SKILL_MD = `# Respan

Use the Respan CLI and SDK for LLM observability — tracing, evals, prompts, datasets, and gateway routing.

## When To Use

- **Set up tracing** (instrument your app to capture LLM calls) → read [references/tracing-setup.md](references/tracing-setup.md)
- **Set up gateway** (route LLM calls through the Respan proxy) → read [references/gateway-setup.md](references/gateway-setup.md)
- **Advanced tracing** (decorators, propagation, processors) → read [references/tracing.md](references/tracing.md)
- **Gateway features** (model switching, fallbacks, caching) → read [references/gateway.md](references/gateway.md)
- **Prompt management** (create, version, deploy) → read [references/prompts.md](references/prompts.md)
- **Evals** (datasets, evaluators, experiments) → read [references/evals.md](references/evals.md)
- **Monitors & automation** (alerts, online evals, webhooks) → read [references/monitors.md](references/monitors.md)

## Core Principles

1. **Read the reference first.** Each reference file has the exact API patterns, MCP tools, and CLI commands.
2. **Use MCP tools** for platform operations (prompts, datasets, evaluators, experiments, traces, logs).
3. **Use CLI** when MCP is not available: \`respan traces list\`, \`respan prompts list\`, etc.
4. **Fetch docs** for integration-specific details not covered in references.

## Quick Reference

| Task | Reference / Command |
|------|--------------------|
| Set up tracing | [references/tracing-setup.md](references/tracing-setup.md) |
| Set up gateway | [references/gateway-setup.md](references/gateway-setup.md) |
| Decorators & propagation | [references/tracing.md](references/tracing.md) |
| Gateway features | [references/gateway.md](references/gateway.md) |
| Prompt management | [references/prompts.md](references/prompts.md) |
| Evals & experiments | [references/evals.md](references/evals.md) |
| Monitors & automation | [references/monitors.md](references/monitors.md) |
| List traces | \`respan traces list --limit 10\` |
| View a trace | \`respan traces get <id>\` |
| Check auth | \`respan auth status\` |

## Documentation Access

Any doc page can be fetched as markdown:
\`https://respan.ai/docs/integrations/openai-sdk.md\`
\`https://respan.ai/docs/sdks/typescript-sdk/overview.md\`

Full docs index: \`https://www.respan.ai/docs/llms.txt\`

Platform: \`https://platform.respan.ai\`
`;

// ── Tracing setup flow (written to references/tracing-setup.md) ─────────
// (Previously named SETUP_MD. Content is already tracing-only and unchanged.)

export const TRACING_SETUP_MD = `# Respan Setup

Use this skill when the user asks to set up Respan tracing in their project.

## Hard Rules

- **Interactive mode:** Ask the user questions when you need input. Do not assume.
- **Only add Respan code.** Do not refactor or modify unrelated code.
- **Pin exact versions.** Never use \`latest\` or unpinned ranges.
- **Do not guess APIs.** Use only the patterns from the integration docs linked below.
- **If Respan is already installed/configured, do not duplicate work.** Check for existing \`respan\` imports first.
- **Read the code before proposing changes.** Understand the actual workflow, not just the dependencies.

## Context

The API key is stored in \`.env\` as \`RESPAN_API_KEY\`.
Full docs index: \`https://www.respan.ai/docs/llms.txt\`

## Steps

### 1. Analyze the Project

**1a. Detect language and package manager:**
- Check \`package.json\` (JS/TS) or \`pyproject.toml\` / \`requirements.txt\` (Python)
- Detect package manager from lock files

**1b. Detect libraries in priority order:**

Check higher-priority categories first. If a match is found, use that instrumentation — do NOT also add lower-level SDK instrumentation.

**Priority 1 — Agent Frameworks & High-Level SDKs:**

| Library | Python package | JS/TS package | Respan instrumentation (Python) | Respan instrumentation (JS/TS) | Docs |
|---------|---------------|---------------|--------------------------------|-------------------------------|------|
| Vercel AI SDK | — | \`ai\` | — | \`@respan/instrumentation-vercel\` | [docs](https://respan.ai/docs/integrations/vercel-ai-sdk.md) |
| OpenAI Agents SDK | \`openai-agents\` | \`@openai/agents\` | \`respan-instrumentation-openai-agents\` | \`@respan/instrumentation-openai-agents\` | [docs](https://respan.ai/docs/integrations/openai-agents-sdk.md) |
| Claude Agent SDK | \`claude-agent-sdk\` | — | \`respan-instrumentation-claude-agent-sdk\` | — | [docs](https://respan.ai/docs/integrations/claude-agents-sdk.md) |
| Pydantic AI | \`pydantic-ai\` | — | \`respan-instrumentation-pydantic-ai\` | — | [docs](https://respan.ai/docs/integrations/pydantic-ai.md) |
| LangChain | \`langchain\` | \`langchain\` | via OpenInference | — | [docs](https://respan.ai/docs/integrations/langchain.md) |
| LangGraph | \`langgraph\` | — | via OpenInference | — | [docs](https://respan.ai/docs/integrations/langgraph.md) |
| CrewAI | \`crewai\` | — | \`respan-instrumentation-crewai\` | — | [docs](https://respan.ai/docs/integrations/crewai.md) |
| LlamaIndex | \`llama-index\` | — | via OpenInference | — | [docs](https://respan.ai/docs/integrations/llama-index.md) |
| Haystack | \`haystack-ai\` | — | \`respan-instrumentation-haystack\` | — | [docs](https://respan.ai/docs/integrations/haystack.md) |
| Mastra | — | \`mastra\` | — | via OTEL | [docs](https://respan.ai/docs/integrations/mastra.md) |
| Google ADK | \`google-adk\` | — | via OpenInference | — | [docs](https://respan.ai/docs/integrations/google-adk.md) |

If a Priority 1 framework is found, use its instrumentation. Do NOT also add Priority 2 instrumentation for the same provider.

**Priority 2 — Direct LLM SDKs** (only if no P1 framework covers this provider):

These are **auto-instrumented** — just \`Respan()\` / \`new Respan()\`, no extra packages needed:

| Library | Python package | JS/TS package | Docs |
|---------|---------------|---------------|------|
| OpenAI SDK | \`openai\` | \`openai\` | [docs](https://respan.ai/docs/integrations/openai-sdk.md) |
| Anthropic SDK | \`anthropic\` | \`@anthropic-ai/sdk\` | [docs](https://respan.ai/docs/integrations/anthropic.md) |
| Azure OpenAI | \`openai\` (azure config) | \`openai\` | [docs](https://respan.ai/docs/integrations/providers/azure.md) |
| Google Vertex AI | \`google-cloud-aiplatform\` | — | [docs](https://respan.ai/docs/integrations/vertex-ai.md) |
| AWS Bedrock | \`boto3\` | — | [docs](https://respan.ai/docs/integrations/aws-bedrock.md) |
| Cohere | \`cohere\` | — | [docs](https://respan.ai/docs/integrations/providers/cohere.md) |
| Together AI | \`together\` | — | [docs](https://respan.ai/docs/integrations/together-ai.md) |

**Note:** LiteLLM in JS uses the OpenAI-compatible API, so the OpenAI auto-instrument covers it. For Python LiteLLM, see [LiteLLM guide](https://respan.ai/docs/integrations/litellm.md). For Google GenAI (\`@google/genai\`), see [Google GenAI guide](https://respan.ai/docs/integrations/google-genai.md).

**1c. Read the actual code and understand the workflow:**

This is the most important step. Read the entrypoint and all files that make LLM calls. Map out:

- What is the **overall workflow**? (e.g. "user sends question → retrieve context → generate answer → format response")
- What are the **individual steps/tasks**? (e.g. "embed query", "search DB", "call GPT", "parse output")
- Are there **agent loops**? (e.g. a loop that calls tools until done)
- Are there **tool calls**? (e.g. functions the LLM invokes)

### 2. Propose an Implementation Plan

Present the user with a concrete plan before making any changes. The plan should include:

**a) Packages to install** — core SDK + instrumentation package (with exact versions)

**b) Initialization code** — where to add it (which file, which line)

**c) Workflow structure** — how to wrap the existing code:

For **agent frameworks** (Priority 1): The framework instrumentation auto-captures the workflow structure. Usually just need init code, no manual wrapping needed. Fetch and follow the integration doc.

For **direct LLM SDKs** (Priority 2): Individual LLM calls will be auto-traced as flat spans. Propose wrapping the logical workflow with Respan decorators/wrappers to get structured nested traces:

TypeScript example:
\`\`\`typescript
// Before: flat traces — each LLM call is an isolated span
const outline = await openai.chat.completions.create({...});
const draft = await openai.chat.completions.create({...});

// After: structured traces — nested spans showing the workflow
const result = await withWorkflow({ name: "write_article" }, async () => {
  const outline = await withTask({ name: "generate_outline" }, async () => {
    return await openai.chat.completions.create({...});
  });
  const draft = await withTask({ name: "write_draft" }, async () => {
    return await openai.chat.completions.create({...});
  });
  return draft;
});
\`\`\`

Python example:
\`\`\`python
# Before: flat traces
outline = client.chat.completions.create(...)
draft = client.chat.completions.create(...)

# After: structured traces
@workflow(name="write_article")
def write_article(topic):
    outline = generate_outline(topic)
    return write_draft(outline)

@task(name="generate_outline")
def generate_outline(topic):
    return client.chat.completions.create(...)

@task(name="write_draft")
def write_draft(outline):
    return client.chat.completions.create(...)
\`\`\`

**Ask the user which approach they prefer:**
1. **Auto-trace only** — just add init code, every LLM call is automatically captured as a flat span. Zero code changes beyond initialization. Good for quick setup or simple projects.
2. **Structured traces** — wrap existing code with workflow/task decorators for nested spans showing how the app flows. Better for complex projects with multiple LLM calls.

If the user picks option 1, skip the wrappers entirely — just install + init code.

If the user picks option 2:
- **If multiple independent workflows are detected** (e.g. \`writeArticle()\`, \`summarizeDoc()\`, \`classifyEmail()\`), list them and ask which ones to instrument. Don't assume all of them.
- **Show the user what the trace will look like** — describe the span hierarchy:
\`\`\`
workflow: write_article
  ├── task: generate_outline
  │     └── llm: openai.chat (auto-captured)
  └── task: write_draft
        └── llm: openai.chat (auto-captured)
\`\`\`

Wait for user confirmation before proceeding.

### 3. Implement

**a) Install packages:**

For direct LLM SDKs (Priority 2) — just the core SDK:
\`\`\`bash
# Python
pip install respan-ai

# TypeScript
npm install @respan/respan
\`\`\`

For agent frameworks (Priority 1) — also install the instrumentor. Check the docs link in the table above for the exact packages.

**b) Add initialization code** — at the top of the entrypoint, before any LLM client is created:

For **direct LLM SDKs** (auto-instrumented):
\`\`\`python
# Python
from respan import Respan
Respan()
\`\`\`
\`\`\`typescript
// TypeScript
import { Respan } from "@respan/respan";
const respan = new Respan();
await respan.initialize();
\`\`\`

For **agent frameworks** (explicit instrumentor — fetch the docs URL from the table for the exact pattern):
\`\`\`python
# Python example (OpenAI Agents)
from respan import Respan
from respan_instrumentation_openai_agents import OpenAIAgentsInstrumentor
Respan(instrumentations=[OpenAIAgentsInstrumentor()])
\`\`\`
\`\`\`typescript
// TypeScript example (OpenAI Agents)
import { Respan } from "@respan/respan";
import { OpenAIAgentsInstrumentor } from "@respan/instrumentation-openai-agents";
const respan = new Respan({ instrumentations: [new OpenAIAgentsInstrumentor()] });
await respan.initialize();
\`\`\`

**c) Add workflow wrappers** — if the user chose structured traces in the plan.

### 4. Verify

Run the application and confirm:
- The app runs without errors
- Traces appear at https://platform.respan.ai or via \`respan traces list --limit 5\`
- If wrappers were added, verify the trace shows the expected nested span hierarchy
`;

// ── Gateway setup flow (written to references/gateway-setup.md) ─────────

export const GATEWAY_SETUP_MD = `# Respan Gateway Setup

Use this skill when the user asks to set up the Respan **gateway** — routing their
LLM calls through the Respan proxy for logging, caching, key management, fallbacks,
and model switching.

Gateway setup is **not** tracing setup. It does **not** install instrumentation
packages. It repoints the LLM client's base URL at the Respan proxy and applies the
framework's specific wiring.

## Hard Rules

- **Interactive mode:** Ask the user questions when you need input. Do not assume.
- **Only add Respan wiring.** Do not refactor or modify unrelated code.
- **Do NOT install instrumentation packages.** Gateway routing does not use them. (That is tracing setup — see \`tracing-setup.md\`.)
- **Do not guess APIs or doc slugs.** Use only the patterns from the live integration doc you fetch, and the exact slug from the map below.
- **Pin exact versions** if you install a framework SDK that is genuinely missing.
- **If the gateway is already wired up, do not duplicate work.** Check for an existing \`base_url\`/\`baseURL\` pointing at \`api.respan.ai\` first.
- **Read the code before proposing changes.** Find where the client is actually instantiated.

## Context

The API key is stored in \`.env\` as \`RESPAN_API_KEY\`.
Gateway base URL: \`https://api.respan.ai/api\` (the proxy completions path is \`https://api.respan.ai/api/chat/completions\`).
Full docs index: \`https://www.respan.ai/docs/llms.txt\`

## Steps

### 1. Detect

Identify:
- **Language & package manager** — \`package.json\` (JS/TS), \`pyproject.toml\` / \`requirements.txt\` (Python), \`Gemfile\` (Ruby). Detect the package manager from lock files.
- **LLM library / framework in use** — match the project's dependencies against the **Detection → slug map** below.

### 2. Map to slug

Match the detected package(s) against the map. **Use the slug from the map verbatim — never auto-derive a slug from a display name** (the kebab-casing is irregular).

Apply the **priority rule:** a high-level framework wins over the raw SDK beneath it.
For example, a project with both \`crewai\` and \`openai\` maps to \`crew-ai\` (not \`open-ai-sdk\`),
because their gateway wiring differs. **If two frameworks match, ask the user which to configure.**

#### Detection → slug map

URL pattern: \`https://respan.ai/docs/integrations/gateway/<slug>.md\`

| Detected package(s) | Slug |
|---|---|
| \`@openai/agents\` / \`openai-agents\` | \`open-ai-agents\` |
| \`claude-agent-sdk\` | \`claude-agent-sdk\` |
| \`ai\` (Vercel AI SDK) | \`vercel-ai-sdk\` |
| \`pydantic-ai\` | \`pydantic-ai\` |
| \`crewai\` | \`crew-ai\` |
| \`haystack-ai\` | \`haystack\` |
| \`langchain\` | \`lang-chain\` |
| \`llama-index\` | \`llama-index\` |
| \`autogen\` / \`autogen-agentchat\` | \`auto-gen\` |
| \`dspy\` / \`dspy-ai\` | \`ds-py\` |
| \`google-adk\` | \`google-adk\` |
| \`openai\` | \`open-ai-sdk\` |
| \`anthropic\` / \`@anthropic-ai/sdk\` | \`anthropic-sdk\` |
| \`google-genai\` / \`@google/genai\` | \`google-gen-ai\` |
| \`litellm\` | \`lite-llm\` |
| \`ruby_llm\` (gem) | \`ruby-llm\` |
| \`google-cloud-aiplatform\` | \`vertex-ai\` |

> Namespace note: OpenAI, Anthropic, and Vertex each have both an SDK-level gateway page (\`open-ai-sdk\`, \`anthropic-sdk\`, \`vertex-ai\`) and a \`model-providers/*\` page. The SDK-level slugs above are the correct targets for this map.

### 3. Confirm

Show the user what was detected and which doc will be used. Wait for confirmation.

> Detected:
> - Language: [TypeScript/Python/Ruby]
> - Framework / SDK: [e.g. OpenAI Agents]
> - Gateway doc: https://respan.ai/docs/integrations/gateway/open-ai-agents.md
>
> Set up the gateway for this? (yes/no)

### 4. Fetch the live doc

Fetch \`https://respan.ai/docs/integrations/gateway/<slug>.md\` for the chosen slug.
Use the slug from the map verbatim.

If a pinned URL fails to resolve, that signals the **map is stale** and the table should be
updated — it does **not** mean you should guess an alternative slug.

### 5. Read the project's client code

Find where the LLM client / \`base_url\` is instantiated. This is the step that determines
the correct wiring — do not skip it.

### 6. Apply the framework-specific wiring

Apply the exact pattern from the fetched doc:

- Ensure \`RESPAN_API_KEY\` is set (it is in \`.env\`).
- Repoint \`base_url\` / \`baseURL\` to the gateway (\`https://api.respan.ai/api\`).
- Apply the framework's exact wiring — e.g. OpenAI Agents requires \`set_default_openai_client(AsyncOpenAI(base_url=...))\`, **not** env vars.
- Install the framework SDK only if it is genuinely missing.
- **Do NOT install instrumentation packages.**

### 7. Verify

Make one real call through the gateway and confirm it appears in logs:

\`\`\`bash
respan logs list --limit 5
\`\`\`

If the CLI is not available, instruct the user to check the Respan platform at https://platform.respan.ai.

Confirm:
- The app runs without errors
- The request appears in the gateway logs
`;

// ── Assembly ────────────────────────────────────────────────────────────

export function getSkillMd(): string {
  return `---
name: respan
description: Use Respan for tracing, evals, prompts, gateway, and SDK setup. Covers CLI commands, SDK instrumentation, and platform features.
user-invocable: true
---

${SKILL_MD}`;
}
