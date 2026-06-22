// Vercel AI Gateway model ids (`<provider>/<model>`, dot in the model segment). A bare string
// model routes through the gateway (uses AI_GATEWAY_API_KEY), giving access to every provider
// from one key. Keep ALLOWED_MODELS in sync with the frontend picker (MODELS in model-menu.tsx).
export const ALLOWED_MODELS = new Set([
  "google/gemini-3.1-pro-preview",
  "google/gemini-3-pro-preview",
  "anthropic/claude-opus-4.7",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.5",
  "xai/grok-4.3",
]);

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/** Allowlist a client-supplied model id; anything not allowed silently falls back to the default. */
export function resolveModel(model: unknown): string {
  return typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
}