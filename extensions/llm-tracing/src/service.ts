import { trace, SpanStatusCode, context } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import {
    BasicTracerProvider,
    BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { MoltbotPluginApi, MoltbotConfig } from "clawdbot/plugin-sdk";

import { normalizeEndpoint, resolveOtelTracesUrl, type LlmTracingConfig } from "./config.js";

const DEFAULT_SERVICE_NAME = "moltbot";

// GenAI Semantic Convention attribute keys
// See: https://opentelemetry.io/docs/specs/semconv/attributes-registry/gen-ai/
const GEN_AI_SYSTEM = "gen_ai.system";
const GEN_AI_REQUEST_MODEL = "gen_ai.request.model";
const GEN_AI_USAGE_INPUT_TOKENS = "gen_ai.usage.input_tokens";
const GEN_AI_USAGE_OUTPUT_TOKENS = "gen_ai.usage.output_tokens";

// Langfuse-specific attribute keys
// See: https://langfuse.com/integrations/native/opentelemetry
const LANGFUSE_OBSERVATION_INPUT = "langfuse.observation.input";
const LANGFUSE_OBSERVATION_OUTPUT = "langfuse.observation.output";
const LANGFUSE_OBSERVATION_NAME = "langfuse.observation.name";
const LANGFUSE_SPAN_KIND = "langfuse.span.kind";

type AgentMessage = {
    role?: string;
    content?: unknown;
    model?: string;
    usage?: {
        input?: number;
        output?: number;
        total?: number;
    };
};

function extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (!part || typeof part !== "object") return "";
                const asRecord = part as Record<string, unknown>;
                if (asRecord.type === "text" && typeof asRecord.text === "string") {
                    return asRecord.text;
                }
                return "";
            })
            .filter(Boolean)
            .join("\n");
    }
    if (content && typeof content === "object") {
        try {
            return JSON.stringify(content);
        } catch {
            return "";
        }
    }
    return "";
}

function parseMessages(messages: unknown[]): AgentMessage[] {
    return messages
        .filter((msg): msg is Record<string, unknown> => msg != null && typeof msg === "object")
        .map((msg) => ({
            role: typeof msg.role === "string" ? msg.role : undefined,
            content: msg.content,
            model: typeof msg.model === "string" ? msg.model : undefined,
            usage:
                msg.usage && typeof msg.usage === "object"
                    ? (msg.usage as AgentMessage["usage"])
                    : undefined,
        }));
}

function findLastAssistant(messages: AgentMessage[]): AgentMessage | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.role === "assistant") {
            return messages[i];
        }
    }
    return undefined;
}

function buildInputFromMessages(messages: AgentMessage[]): string {
    // Find the index of the last assistant message
    const lastAssistantIndex = messages.findLastIndex((m) => m.role === "assistant");

    // Get all messages before the last assistant (these are the input)
    const inputMessages = lastAssistantIndex > 0 ? messages.slice(0, lastAssistantIndex) : messages;

    return inputMessages
        .map((msg) => {
            const role = msg.role ?? "unknown";
            const content = extractTextContent(msg.content);
            return `[${role}]: ${content}`;
        })
        .join("\n\n");
}

function getLlmTracingConfig(config: MoltbotConfig): LlmTracingConfig {
    const diagnostics = config.diagnostics as Record<string, unknown> | undefined;
    return (diagnostics?.llmTracing ?? {}) as LlmTracingConfig;
}

export function initializeLlmTracing(api: MoltbotPluginApi): void {
    const cfg = getLlmTracingConfig(api.config);

    if (!cfg.enabled) {
        api.logger.info("llm-tracing: disabled (set diagnostics.llmTracing.enabled = true)");
        return;
    }

    const endpoint = normalizeEndpoint(cfg.endpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
    const tracesUrl = resolveOtelTracesUrl(endpoint);

    if (!tracesUrl) {
        api.logger.warn("llm-tracing: no endpoint configured, skipping initialization");
        return;
    }

    const serviceName = cfg.serviceName?.trim() || DEFAULT_SERVICE_NAME;
    const headers = cfg.headers ?? {};

    // Initialize OTEL Tracer Provider
    const resource = new Resource({
        [ATTR_SERVICE_NAME]: serviceName,
    });

    const exporter = new OTLPTraceExporter({
        url: tracesUrl,
        headers,
    });

    const provider = new BasicTracerProvider({ resource });
    provider.addSpanProcessor(new BatchSpanProcessor(exporter));
    provider.register();

    const tracer = trace.getTracer("llm-tracing", "1.0.0");

    api.logger.info(`llm-tracing: initialized, endpoint=${tracesUrl}`);

    // Register agent_end hook to capture LLM content
    api.on("agent_end", async (event, ctx) => {
        if (!event.messages || event.messages.length === 0) {
            return;
        }

        try {
            const messages = parseMessages(event.messages);
            const lastAssistant = findLastAssistant(messages);

            if (!lastAssistant) {
                api.logger.warn("llm-tracing: no assistant message found, skipping trace");
                return;
            }

            // Extract input and output
            const input = buildInputFromMessages(messages);
            const output = extractTextContent(lastAssistant.content);
            const model = lastAssistant.model ?? "unknown";
            const usage = lastAssistant.usage;

            // Create span with proper timing
            const startTime = event.durationMs
                ? Date.now() - Math.max(0, event.durationMs)
                : undefined;

            const span = tracer.startSpan("llm.generation", {
                startTime,
            });

            // Set GenAI Semantic Convention attributes
            span.setAttribute(GEN_AI_SYSTEM, "openai"); // TODO: extract from model name
            span.setAttribute(GEN_AI_REQUEST_MODEL, model);

            if (usage?.input) {
                span.setAttribute(GEN_AI_USAGE_INPUT_TOKENS, usage.input);
            }
            if (usage?.output) {
                span.setAttribute(GEN_AI_USAGE_OUTPUT_TOKENS, usage.output);
            }

            // Set Langfuse-specific attributes for content
            span.setAttribute(LANGFUSE_SPAN_KIND, "generation");
            span.setAttribute(LANGFUSE_OBSERVATION_NAME, `llm-${model}`);
            span.setAttribute(LANGFUSE_OBSERVATION_INPUT, input);
            span.setAttribute(LANGFUSE_OBSERVATION_OUTPUT, output);

            // Set session context
            if (ctx?.sessionKey) {
                span.setAttribute("moltbot.session_key", ctx.sessionKey);
            }
            if (ctx?.agentId) {
                span.setAttribute("moltbot.agent_id", ctx.agentId);
            }

            // Set status based on success
            if (!event.success) {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: event.error ?? "Agent execution failed",
                });
            } else {
                span.setStatus({ code: SpanStatusCode.OK });
            }

            span.end();

            api.logger.info?.(`llm-tracing: traced generation for model=${model}`);
        } catch (err) {
            api.logger.warn(`llm-tracing: failed to trace agent_end: ${String(err)}`);
        }
    });
}
