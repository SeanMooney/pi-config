# Vertex Claude Pi Extension

`vertex-claude` is a Pi custom provider for Anthropic Claude models served by
Google Vertex AI. It uses Google Application Default Credentials (ADC) through
the official `@anthropic-ai/vertex-sdk` transport.

## Registration policy

The extension registers a maintained, local manifest at startup. It **does not
list or probe Vertex models at startup**, so `--list-models` is local,
deterministic, and does not require credentials.

The manifest follows the [Google Vertex AI Claude documentation][vertex-docs]
and Anthropic model lifecycle documentation. Vertex-specific API IDs take
precedence over native Anthropic retirement dates:

[vertex-docs]:
  https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude

- active models and deprecated-but-not-retired models are registered;
- retired models are excluded;
- older IDs keep their required Vertex `@YYYYMMDD` revision suffixes;
- lifecycle and alias eligibility are explicit manifest fields, not guessed from
  version numbers.

Current manifest entries include:

```text
claude-opus-4-8
claude-opus-4-7
claude-opus-4-6
claude-opus-4-5@20251101
claude-opus-4-1@20250805
claude-opus-4@20250514
claude-sonnet-5
claude-sonnet-4-6
claude-sonnet-4-5@20250929
claude-sonnet-4@20250514
claude-haiku-4-5@20251001
claude-3-5-haiku@20241022
claude-fable-5
```

Aliases are computed independently per family and point to the newest active,
non-deprecated manifest entry:

```text
opus, claude-opus       -> claude-opus-4-8
sonnet, claude-sonnet   -> claude-sonnet-5
haiku, claude-haiku     -> claude-haiku-4-5@20251001
fable, claude-fable     -> claude-fable-5
```

A major-5 Sonnet or Fable never suppresses registered major-4 Opus or Haiku
models.

## Requirements and installation

Pi loads this extension from the XDG-oriented config directory, for example:

```bash
cd "$PI_CODING_AGENT_DIR/extensions/vertex-claude"
npm ci
```

The development dependencies are pinned to Pi 0.80.6. The extension imports
legacy streaming helpers from Pi's supported `@earendil-works/pi-ai/compat`
entrypoint, which Pi's loader resolves to the host runtime.

`@anthropic-ai/vertex-sdk` is intentionally pinned to exactly 0.16.1. Version
0.16.1 retains the `prepareOptions`/`buildRequest` Vertex request adaptation.
Starting with 0.17.1+, the SDK requires a `backendMiddleware` hook that is
absent from the currently resolved Anthropic SDK transport, producing
`/v1/v1/messages`.

The narrowly scoped `gaxios@6.7.1` UUID override is a production-security
exception, not a deprecation cleanup. `npm audit --omit=dev` identifies the
legacy Google-auth path pulled by Vertex SDK 0.16.1 as affected by
GHSA-w5hq-g745-h8pq (`uuid <11.1.1`). It applies only below that exact gaxios
version. Remove it when the pinned Vertex SDK can move to a transport-compatible
dependency path that no longer brings gaxios 6.7.1.

Configure a project, region, and ADC:

```bash
export ANTHROPIC_VERTEX_PROJECT_ID=your-gcp-project-id
export CLOUD_ML_REGION=global
export GOOGLE_APPLICATION_CREDENTIALS=\
"$HOME/.config/gcloud/application_default_credentials.json"
```

Project ID resolution order:

1. `ANTHROPIC_VERTEX_PROJECT_ID`
2. `GOOGLE_CLOUD_PROJECT`
3. `GCLOUD_PROJECT`

Region resolution order:

1. `CLOUD_ML_REGION`
2. `GOOGLE_CLOUD_LOCATION`

`ANTHROPIC_VERTEX_BASE_URL` optionally overrides the constructed Vertex
endpoint. Only set it to a trusted endpoint.

## Explicit model override

`VERTEX_CLAUDE_MODELS` remains authoritative. When set, the manifest is not
added and aliases are derived only from the supplied comma-separated list:

```bash
export VERTEX_CLAUDE_MODELS=\
"claude-opus-4-8,claude-sonnet-5,claude-haiku-4-5@20251001,claude-fable-5"
```

Known manifest IDs retain their documented metadata. A syntactically valid,
env-only recognized Claude family/version ID that Pi does not know is still
registered rather than silently discarded. It uses conservative Vertex defaults
(reasoning and text/image input, 200K context, 64K output, zero cost) until Pi
gains catalog metadata.

IDs must use a recognized family/version form such as `claude-opus-4-8` or
`claude-3-5-haiku@20241022`; malformed IDs are rejected. An empty or malformed
override throws a clear extension configuration error and never falls back to
the manifest. Pi's extension loader may swallow that load error. In that case,
`--list-models` simply shows no Vertex Claude models rather than displaying the
exact error.

## Metadata and thinking

For every registered model, the extension removes only a Vertex `@revision`
suffix for lookup in Pi's built-in Anthropic catalog, while retaining the exact
Vertex ID in requests. When a catalog match exists it inherits all relevant
metadata:

- `compat` (including adaptive thinking and `supportsTemperature: false`);
- `reasoning` and `thinkingLevelMap`;
- `input`, `cost`, `contextWindow`, and `maxTokens`.

Consequently Pi 0.80.6 metadata improvements, including 1M context, 128K output,
and adaptive effort maps, flow to matching Vertex models automatically.

The custom `streamSimple` retains the `AnthropicVertex` client injection.
Adaptive models use adaptive thinking with effort and no legacy token budget;
older models use budget-based thinking without adaptive effort. All branches
estimate context, reserve Pi's 4,096-token safety margin, clamp to at least one
token, and clamp legacy thinking again after budget expansion.

If that leaves insufficient room for both Anthropic's 1,024-token minimum
legacy-thinking budget and a 1,024-token output reserve, legacy thinking is
disabled for that request rather than sending a zero budget, which the Anthropic
builder converts back to 1,024. This preserves context clamping while retaining
inherited compatibility metadata on alias request targets.

## Usage

List models without startup discovery or network access:

```bash
PI_CODING_AGENT_DIR="$PI_CODING_AGENT_DIR" \
pi --no-extensions -e "$PI_CODING_AGENT_DIR/extensions/vertex-claude/index.ts" \
  --list-models vertex-claude
```

Use a concrete model or family alias:

```text
vertex-claude/sonnet
vertex-claude/opus
vertex-claude/haiku
vertex-claude/fable
vertex-claude/claude-opus-4-8
```

## Diagnostics

Use the interactive Pi command:

```text
/vertex-claude-diagnose
/vertex-claude-diagnose claude-opus-4-8
```

Without a model, the command validates project/region configuration, constructs
the endpoint, and acquires ADC credentials. It does not send a model request.
With a model, it makes an explicitly requested one-token inference/access probe,
which can incur a small charge.

Diagnostics classify missing configuration/auth, permission failures, quota/rate
limits, network failures, and ambiguous 404s. A 404 can indicate a model,
region, project, or model-access configuration problem; it is never presented as
unique proof of entitlement failure. UI notifications are guarded by `hasUI`, so
non-interactive modes remain safe.

## Validation

Run:

```bash
extensions/vertex-claude/validate.sh
```

The default checks use an isolated temporary-copy lockfile installation, strict
TypeScript, manifest model listing, independent aliases, authoritative override
behavior, inherited metadata wiring, a fake-auth/fake-fetch Vertex transport
request, and the absence of startup discovery.

`npm ci` and `npm audit` contact the npm registry. Extension startup and model
listing make no Vertex requests, require no Vertex credentials, and make no
inference calls.

To run an opt-in credentialed inference smoke test:

```bash
RUN_VERTEX_CLAUDE_SMOKE_MODEL=claude-sonnet-5 \
  extensions/vertex-claude/validate.sh
```

That smoke test can incur normal Vertex usage charges and requires the selected
model to be available to the configured project and region.
