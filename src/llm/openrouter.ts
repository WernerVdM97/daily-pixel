// The one upstream the game's LLM layer talks to.
//
// DeepSeek's own API is no longer called directly. Every call goes through OpenRouter, held to the
// DeepSeek first-party host. The move came with a version bump, and the reason is not visible from
// the code:
//
//  - **The pin needs a host to pin to.** `deepseek/deepseek-v4-flash` has no first-party endpoint
//    on OpenRouter (17 serve it, none of them DeepSeek), so the default moves to
//    `deepseek/deepseek-v4.1-flash`. That is a different model, not a re-route: prompt tokens go
//    from $0.084 to $0.15 per M and completion from $0.168 to $0.60, against a cache-read price
//    that falls from $0.0168 to $0.003 — which is what pays for it, given how much of a game turn
//    is a re-read prefix.
//
// **The pin protects the prompt cache.** OpenRouter load-balances a model across every host that
// serves it, and a different host means a different prompt cache. One game turn re-reads the same
// system prompt and context prefix on every call, so a host switch mid-session pays full price on
// the whole prefix — far more than the headline spread between hosts. `order: ['deepseek']` with
// `allow_fallbacks: false` means exactly two things can happen: DeepSeek serves it, or the call
// fails. It will not silently re-route to a cold cache. DeepSeek is also the only one of this
// model's 17 endpoints OpenRouter flags `supports_implicit_caching`, so a fallback host would not
// merely be cold at the switch — it would never cache the prefix at all.
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

/** The route, sent on every call whatever the model: `order` fixes the host, `allow_fallbacks:
 *  false` refuses to move off it. It follows that `LLM_MODEL` / `AGENT_MODEL` can only name a slug
 *  DeepSeek serves — any other model fails loudly on every call rather than quietly re-routing. */
export const OPENROUTER_PROVIDER_ROUTING = {
  order: ['deepseek'],
  allow_fallbacks: false,
};
