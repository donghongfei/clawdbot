import type { MoltbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { initializeLlmTracing } from "./src/service.js";

const plugin = {
    id: "llm-tracing",
    name: "LLM Content Tracing",
    description: "Trace LLM calls with input/output content to Langfuse via OpenTelemetry",
    configSchema: emptyPluginConfigSchema(),
    register(api: MoltbotPluginApi) {
        // Initialize tracing in register phase to access api.on() for hooks
        initializeLlmTracing(api);
    },
};

export default plugin;
