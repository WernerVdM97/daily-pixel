// The one upstream the game's LLM layer talks to.
//
// DeepSeek's own API is no longer called directly. The same weights are reached through
// OpenRouter, pinned to the DeepSeek host, for two reasons.
//
// **The pin protects the prompt cache.** OpenRouter load-balances a model across every host that
// serves it, and a different host means a different prompt cache. One game turn re-reads the same
// system prompt and context prefix on every call, so a host switch mid-session pays full price on
// the whole prefix — far more than the headline spread between hosts. `order: ['deepseek']` with
// `allow_fallbacks: false` means exactly two things can happen: DeepSeek serves it, or the call
// fails. It will not silently re-route to a cold cache.
//
// **A failed call is visible; a cold cache is not.** `allow_fallbacks: false` makes a DeepSeek
// outage a hard error, which the caller already handles loudly (`FallbackLlmGateway` on the bot
// path, the harness's own error on the agent path). Re-routing would "work" and quietly double
// the bill, which is the worse failure.
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/** OpenRouter model ids are slugs (`<vendor>/<model>`), not DeepSeek's short names. */
export const DEFAULT_LLM_MODEL = 'deepseek/deepseek-v4.1-flash';

/** Attribution only: separates this bot's spend from `pi`'s on the OpenRouter dashboard. */
export const OPENROUTER_TITLE = "The Warden's Oak";

export const OPENROUTER_PROVIDER_ROUTING = {
  order: ['deepseek'],
  allow_fallbacks: false,
};
