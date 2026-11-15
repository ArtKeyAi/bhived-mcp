import { z } from "zod/v4";

/**
 * Treat `null` as "not given" on an optional or defaulted tool argument.
 *
 * Some MCP clients and LLM tool-callers send `null` for every optional
 * argument they were not given (crewai-tools' MCPServerAdapter sends
 * `"scope": null`), and a plain `.optional()` / `.default()` rejects that
 * with "expected one of ..." or "expected string, received null". With this
 * wrapper a null becomes undefined before validation, so the field is
 * treated as omitted and its own default applies.
 *
 * Wrap each optional field, never the whole object: the MCP SDK advertises
 * a JSON Schema only for object schemas (a preprocessed object would list as
 * `{}`). For a preprocessed field, zod's input JSON Schema is the inner
 * schema, so tools/list stays exactly as before. Keep `.describe()` on the
 * inner schema. Required fields are not wrapped: null there still fails.
 *
 * The pipe takes over the inner schema's optionality (optin/optout). Newer
 * zod 4 releases do this on their own; 4.3.x does not, and every wrapped
 * field would then be listed as required in tools/list. Setting it here
 * keeps the advertised schema the same whichever zod 4 version is installed.
 */
export function nullAsOmitted<T extends z.ZodType>(schema: T) {
    const wrapped = z.preprocess((value) => (value === null ? undefined : value), schema);
    Object.defineProperty(wrapped._zod, "optin", { value: schema._zod.optin, configurable: true });
    Object.defineProperty(wrapped._zod, "optout", { value: schema._zod.optout, configurable: true });
    return wrapped;
}
