import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../dist/config.js";

function withEnv(vars, fn) {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    try { return fn(); } finally {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
}

test("an empty BHIVED_API_KEY is treated as unset", () => {
    withEnv({ BHIVED_API_KEY: "", CLAUDE_PLUGIN_OPTION_API_KEY: "plugin-option-key" }, () => {
        assert.equal(loadConfig().apiKey, "plugin-option-key");
    });
});

test("an unexpanded plugin placeholder is treated as unset", () => {
    withEnv({ BHIVED_API_KEY: "${user_config.api_key}", CLAUDE_PLUGIN_OPTION_API_KEY: "plugin-option-key" }, () => {
        assert.equal(loadConfig().apiKey, "plugin-option-key");
    });
});

test("BHIVED_API_KEY still wins over the plugin option", () => {
    withEnv({ BHIVED_API_KEY: "env-key", CLAUDE_PLUGIN_OPTION_API_KEY: "plugin-option-key" }, () => {
        assert.equal(loadConfig().apiKey, "env-key");
    });
});
