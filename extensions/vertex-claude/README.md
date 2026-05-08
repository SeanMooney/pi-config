# Vertex Claude Pi Extension

`vertex-claude` is a Pi custom provider extension that lets Pi use Anthropic Claude models served through Google Vertex AI.

It is intended for environments where Claude access is managed through Google Cloud / Vertex AI and Application Default Credentials (ADC), including setups that already work with Claude Code's Vertex mode.

## What it registers

Provider name:

```text
vertex-claude
```

Common model aliases:

```text
sonnet        -> latest discovered/fallback Sonnet
claude-sonnet -> latest discovered/fallback Sonnet
opus          -> latest discovered/fallback Opus
claude-opus   -> latest discovered/fallback Opus
haiku         -> latest discovered/fallback Haiku
claude-haiku  -> latest discovered/fallback Haiku
```

It also registers concrete Vertex model IDs such as:

```text
claude-opus-4-7
claude-sonnet-4-6
claude-haiku-4-5
```

The fallback model list is based on Google's Vertex AI Claude model documentation. Discovery is attempted at startup when credentials/project/region are available, and falls back safely if discovery fails.

## Requirements

- Pi 0.71.x-compatible extension runtime.
- Node runtime compatible with Pi and this extension's dependencies.
- Google Application Default Credentials that can access Vertex AI Anthropic publisher models.
- A Google Cloud project with access to the desired Claude models.

Install extension dependencies:

```bash
cd "$PI_CODING_AGENT_DIR/extensions/vertex-claude"
npm install
```

## Configuration

Recommended environment variables:

```bash
export CLOUD_ML_REGION=global
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
export GOOGLE_CLOUD_PROJECT="$ANTHROPIC_VERTEX_PROJECT_ID"
export GOOGLE_CLOUD_LOCATION="$CLOUD_ML_REGION"
export GOOGLE_APPLICATION_CREDENTIALS="$HOME/.config/gcloud/application_default_credentials.json"
```

Project ID resolution order:

1. `ANTHROPIC_VERTEX_PROJECT_ID`
2. `GOOGLE_CLOUD_PROJECT`
3. `GCLOUD_PROJECT`

Region/location resolution order:

1. `CLOUD_ML_REGION`
2. `GOOGLE_CLOUD_LOCATION`

Optional settings:

```bash
# Explicit model list. When set, this is authoritative and fallback/discovery models are not added.
export VERTEX_CLAUDE_MODELS="claude-sonnet-4-6,claude-opus-4-7,claude-haiku-4-5"

# Disable publisher-model discovery at Pi startup.
export VERTEX_CLAUDE_DISABLE_DISCOVERY=1

# Print discovery failures to stderr for debugging.
export VERTEX_CLAUDE_DEBUG=1

# Override the Vertex API base URL. Use with care; Google auth headers are sent to this URL during discovery.
export ANTHROPIC_VERTEX_BASE_URL="https://aiplatform.googleapis.com/v1"
```

## Usage

List registered models:

```bash
pi --no-extensions \
  -e "$PI_CODING_AGENT_DIR/extensions/vertex-claude/index.ts" \
  --list-models vertex-claude
```

Smoke test:

```bash
pi --no-extensions \
  -e "$PI_CODING_AGENT_DIR/extensions/vertex-claude/index.ts" \
  --provider vertex-claude \
  --model sonnet \
  --no-tools \
  -p "Reply with exactly: ok"
```

Use in normal Pi sessions by selecting a model such as:

```text
vertex-claude/sonnet
vertex-claude/opus
vertex-claude/haiku
vertex-claude/claude-sonnet-4-6
```

If the extension is in Pi's auto-discovered extension directory, it loads automatically. In this XDG-based config repo that directory is expected to be:

```text
$PI_CODING_AGENT_DIR/extensions/vertex-claude/
```

## Validation

Run the validation script from this repository:

```bash
extensions/vertex-claude/validate.sh
```

It checks:

- TypeScript syntax/types with `--strict`.
- Production dependency audit.
- Fallback model registration.
- Normal discovery-path model registration.
- `VERTEX_CLAUDE_MODELS` override behavior.
- Live no-thinking and low-thinking smoke tests.

Optional tool smoke test:

```bash
RUN_VERTEX_CLAUDE_TOOL_TEST=1 extensions/vertex-claude/validate.sh
```

## How it works

Pi requires providers with models to include a `baseUrl` and either `apiKey` or `oauth`. Vertex uses Google ADC instead of an Anthropic API key, so the extension registers a harmless marker API key:

```text
gcp-vertex-credentials
```

Actual requests are handled by a custom `streamSimple` implementation. It creates an official Anthropic Vertex SDK client:

```ts
new AnthropicVertex({ projectId, region, baseURL })
```

and delegates message conversion, tool conversion, streaming event handling, usage accounting, and thinking support to Pi's existing Anthropic implementation:

```ts
streamAnthropic(..., { client: anthropicVertexClient })
```

The Anthropic Vertex SDK rewrites Anthropic Messages API calls to Vertex `rawPredict` / `streamRawPredict` publisher-model endpoints and handles Google authentication.

## Discovery and fallback behavior

At startup, the extension attempts to list Anthropic publisher models from Vertex:

```text
GET {baseUrl}/projects/{project}/locations/{region}/publishers/anthropic/models
```

Discovery is best-effort:

- It has a bounded timeout.
- Failure never prevents Pi from starting.
- If discovery fails, the documented fallback model list is used.
- If `VERTEX_CLAUDE_MODELS` is set, that explicit list is used instead of discovery/fallback.

## Thinking support

The extension advertises reasoning support for current Claude 4 models. When Pi enables thinking, the extension passes both adaptive-effort and token-budget hints to Pi's Anthropic provider. Pi's Anthropic implementation decides which form applies to the concrete model ID.

Reasoning level mapping:

| Pi level | Budget tokens | Effort |
| --- | ---: | --- |
| `minimal` | 1,024 | `low` |
| `low` | 4,096 | `low` |
| `medium` | 8,192 | `medium` |
| `high` | 16,384 | `high` |
| `xhigh` | 32,768 | `xhigh` for Opus 4.7, `max` for Opus 4.6, otherwise `high` |

## Security notes

- No Google credentials or tokens are stored by this extension.
- No credentials are logged.
- Google authentication is delegated to `google-auth-library` and `@anthropic-ai/vertex-sdk`.
- `projectId` and `region` are URL-encoded for discovery requests.
- `ANTHROPIC_VERTEX_BASE_URL` is powerful: if set, Google auth headers may be sent to that URL during discovery. Only set it to trusted endpoints.

## Known limitations

- Costs are currently registered as zero, so Pi usage-cost display is not accurate for this provider.
- Model availability depends on project, region, allowlisting, and Vertex model access.
- Fallback IDs may appear even if your project cannot access them. Use `VERTEX_CLAUDE_MODELS` for a known-good local list.
- This is currently a local Pi extension, not a packaged Pi extension. If moved to its own repo/package later, include the same runtime dependencies and keep `node_modules/` out of version control.
