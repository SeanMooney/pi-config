#!/usr/bin/env bash
set -Eeuo pipefail

PI_BIN="${PI_BIN:-pi}"
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_ENTRY="$EXT_DIR/index.ts"

last_nonempty_line() {
	awk 'NF { line = $0 } END { print line }'
}

run_smoke() {
	local label="$1"
	shift
	local output
	echo
	echo "==> $label"
	set +e
	output="$("$PI_BIN" --no-extensions -e "$EXT_ENTRY" --provider vertex-claude --model sonnet --no-tools --no-session -p "$@" 2>&1)"
	local status=$?
	set -e
	printf '%s\n' "$output"
	if [[ $status -ne 0 ]]; then
		echo "ERROR: smoke command failed with exit code $status" >&2
		exit "$status"
	fi
	local last_line
	last_line="$(printf '%s\n' "$output" | tr -d '\r' | last_nonempty_line)"
	if [[ "$last_line" != "ok" ]]; then
		echo "ERROR: expected final non-empty output line to be exactly 'ok', got '$last_line'" >&2
		exit 1
	fi
}

cd "$EXT_DIR"

echo "Vertex Claude extension validation"
echo "Extension: $EXT_ENTRY"
echo "PI_BIN: $PI_BIN"
echo "PI_CODING_AGENT_DIR: ${PI_CODING_AGENT_DIR:-<unset>}"
echo "ANTHROPIC_VERTEX_PROJECT_ID: ${ANTHROPIC_VERTEX_PROJECT_ID:-<unset>}"
echo "GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-<unset>}"
echo "CLOUD_ML_REGION: ${CLOUD_ML_REGION:-<unset>}"
echo "GOOGLE_CLOUD_LOCATION: ${GOOGLE_CLOUD_LOCATION:-<unset>}"
echo "GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS:-<unset>}"

if [[ ! -d node_modules ]]; then
	echo
	echo "==> Installing dependencies with npm ci"
	npm ci
fi

echo

echo "==> TypeScript check"
npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext --target ES2022 --types node --skipLibCheck index.ts

echo

echo "==> Production dependency audit"
npm audit --omit=dev

echo

echo "==> Model listing with discovery disabled (fallback list)"
VERTEX_CLAUDE_DISABLE_DISCOVERY=1 "$PI_BIN" --no-extensions -e "$EXT_ENTRY" --list-models vertex-claude | tee /tmp/vertex-claude-models-fallback.txt
grep -qE '^vertex-claude[[:space:]]+sonnet[[:space:]]' /tmp/vertex-claude-models-fallback.txt
grep -qE '^vertex-claude[[:space:]]+claude-sonnet-4-6[[:space:]]' /tmp/vertex-claude-models-fallback.txt

echo

echo "==> Model listing with normal discovery path"
"$PI_BIN" --no-extensions -e "$EXT_ENTRY" --list-models vertex-claude | tee /tmp/vertex-claude-models-discovery.txt
grep -qE '^vertex-claude[[:space:]]+sonnet[[:space:]]' /tmp/vertex-claude-models-discovery.txt

echo

echo "==> Explicit VERTEX_CLAUDE_MODELS override is authoritative"
VERTEX_CLAUDE_MODELS="claude-sonnet-4-6" VERTEX_CLAUDE_DISABLE_DISCOVERY=1 \
	"$PI_BIN" --no-extensions -e "$EXT_ENTRY" --list-models vertex-claude | tee /tmp/vertex-claude-models-override.txt
grep -qE '^vertex-claude[[:space:]]+claude-sonnet-4-6[[:space:]]' /tmp/vertex-claude-models-override.txt
grep -qE '^vertex-claude[[:space:]]+sonnet[[:space:]]' /tmp/vertex-claude-models-override.txt
if grep -qE '^vertex-claude[[:space:]]+claude-opus' /tmp/vertex-claude-models-override.txt; then
	echo "ERROR: explicit sonnet-only override unexpectedly listed opus models" >&2
	exit 1
fi
if grep -qE '^vertex-claude[[:space:]]+claude-haiku' /tmp/vertex-claude-models-override.txt; then
	echo "ERROR: explicit sonnet-only override unexpectedly listed haiku models" >&2
	exit 1
fi

run_smoke "Smoke test: no tools, no thinking" "Reply with exactly: ok"

echo

echo "==> Smoke test: no tools, low thinking"
set +e
thinking_output="$("$PI_BIN" --no-extensions -e "$EXT_ENTRY" --provider vertex-claude --model sonnet --thinking low --no-tools --no-session -p "Think briefly, then reply with exactly: ok" 2>&1)"
thinking_status=$?
set -e
printf '%s\n' "$thinking_output"
if [[ $thinking_status -ne 0 ]]; then
	echo "ERROR: thinking smoke command failed with exit code $thinking_status" >&2
	exit "$thinking_status"
fi
thinking_last_line="$(printf '%s\n' "$thinking_output" | tr -d '\r' | last_nonempty_line)"
if [[ "$thinking_last_line" != "ok" ]]; then
	echo "ERROR: expected final non-empty thinking output line to be exactly 'ok', got '$thinking_last_line'" >&2
	exit 1
fi

if [[ "${RUN_VERTEX_CLAUDE_TOOL_TEST:-0}" == "1" ]]; then
	echo
	echo "==> Optional tool smoke test"
	"$PI_BIN" --no-extensions -e "$EXT_ENTRY" --provider vertex-claude --model sonnet --no-session \
		-p "Use a tool to list the current directory, then summarize in one sentence."
fi

echo

echo "All vertex-claude validation checks passed."
