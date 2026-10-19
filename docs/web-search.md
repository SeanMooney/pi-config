# Web search

`pi-web-access` provides web search (`web_search`), page and media extraction
(`fetch_content`), stored-content retrieval (`get_search_content`), and evidence
gathering (`source_check`). `pi-smart-fetch` also provides `web_fetch` and
`batch_web_fetch` for browser-fingerprinted page reads.

## Configuration

Configure `web-search.json` under `$PI_CODING_AGENT_DIR`. Restart Pi after
changing it.

- `openaiSearchProviders: ["openai-codex"]` reuses the Codex subscription signed
  into Pi.
- `searchRouting.providers: ["openai", "brave"]` prefers Codex and falls back to
  Brave for errors listed in `searchRouting.fallbackOn`.
- `searchRouting.useCurrentModel: false` keeps search independent of the
  selected chat model.
- `webSearch.allowedProviders: ["openai", "brave"]` restricts search providers.
- `workflow: "none"` returns results without curator windows or extra summaries.

Set `BRAVE_API_KEY` in the environment that launches Pi. Leave
`"braveApiKey": "$BRAVE_API_KEY"` unchanged; never put credentials in tracked
files. Leave `OPENAI_API_KEY` unset for subscription-only OpenAI search.

Omit `provider` from search calls to use automatic fallback. Explicit provider
selection bypasses fallback. Do not set a top-level `provider` or
`searchProvider` in the sidecar, as these override the route.

The extension does not enforce a monthly Brave spending cap. Manage billing
limits in the Brave account.

Sandbox network access is configured in `sandbox.json`: allow `chatgpt.com` for
Codex, `api.openai.com` for the OpenAI API, and `brave.com` plus `*.brave.com`
for Brave. Reading search-result pages may require additional domain
permissions.

See the
[upstream documentation](https://github.com/nicobailon/pi-web-access#configuration)
for additional options.
