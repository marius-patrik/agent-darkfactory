/**
 * Internal memory-engine seam for the first-party Memory plugin.
 *
 * The public agent.package.json v2 contribution is intentionally added by the
 * plugin-platform lane. Keeping this export independent lets that lane wire the
 * engine without reviving a competing manifest or plugin loader.
 */
export * from "./understory";
