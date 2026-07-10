#!/usr/bin/env bash
set -Eeuo pipefail

PI_BIN="${PI_BIN:-pi}"
EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vertex-claude-validation.XXXXXX")"
trap 'rm -rf "$WORK_DIR"' EXIT
VALIDATION_EXT_DIR="$WORK_DIR/extension"
VALIDATION_CONFIG_DIR="$WORK_DIR/config"
VALIDATION_SESSION_DIR="$WORK_DIR/sessions"

mkdir -p "$VALIDATION_EXT_DIR"
for file in index.ts validate-harness.ts package.json package-lock.json; do
	cp "$EXT_DIR/$file" "$VALIDATION_EXT_DIR/$file"
done
EXT_ENTRY="$VALIDATION_EXT_DIR/index.ts"

run_pi() {
	PI_CODING_AGENT_DIR="$VALIDATION_CONFIG_DIR" \
		PI_CODING_AGENT_SESSION_DIR="$VALIDATION_SESSION_DIR" \
		"$PI_BIN" "$@"
}

list_models() {
	(
		unset VERTEX_CLAUDE_MODELS
		run_pi --no-extensions -e "$EXT_ENTRY" --list-models vertex-claude
	)
}

list_models_with_override() {
	VERTEX_CLAUDE_MODELS="$1" \
		run_pi --no-extensions -e "$EXT_ENTRY" --list-models vertex-claude
}

assert_model() {
	if ! grep -qE "^vertex-claude[[:space:]]+$2[[:space:]]" "$1"; then
		echo "missing model: $2" >&2
		exit 1
	fi
}

assert_no_model() {
	if grep -qE "^vertex-claude[[:space:]]+$2[[:space:]]" "$1"; then
		echo "unexpected model: $2" >&2
		exit 1
	fi
}

assert_exact_model_set() {
	local output="$1"
	shift
	awk '/^vertex-claude[[:space:]]/ { print $2 }' "$output" |
		sort >"$WORK_DIR/actual-models.txt"
	printf '%s\n' "$@" | sort >"$WORK_DIR/expected-models.txt"
	diff -u "$WORK_DIR/expected-models.txt" "$WORK_DIR/actual-models.txt"
}

manifest_models=(
	claude-opus-4-8
	claude-opus-4-7
	claude-opus-4-6
	'claude-opus-4-5@20251101'
	'claude-opus-4-1@20250805'
	'claude-opus-4@20250514'
	claude-sonnet-5
	claude-sonnet-4-6
	'claude-sonnet-4-5@20250929'
	'claude-sonnet-4@20250514'
	'claude-haiku-4-5@20251001'
	'claude-3-5-haiku@20241022'
	claude-fable-5
	opus
	claude-opus
	sonnet
	claude-sonnet
	haiku
	claude-haiku
	fable
	claude-fable
)

expected_manifest_models=(
	'claude-3-5-haiku@20241022'
	claude-fable
	claude-fable-5
	claude-haiku
	'claude-haiku-4-5@20251001'
	claude-opus
	'claude-opus-4-1@20250805'
	'claude-opus-4-5@20251101'
	claude-opus-4-6
	claude-opus-4-7
	claude-opus-4-8
	'claude-opus-4@20250514'
	claude-sonnet
	'claude-sonnet-4-5@20250929'
	claude-sonnet-4-6
	'claude-sonnet-4@20250514'
	claude-sonnet-5
	fable
	haiku
	opus
	sonnet
)

retired_models=(
	'claude-3-7-sonnet@20250219'
	'claude-3-5-sonnet-v2@20241022'
	'claude-3-5-sonnet@20240620'
	'claude-3-haiku@20240307'
)

override_models=(
	claude-opus-4-6
	'claude-haiku-4-5@20251001'
	claude-fable-5
	opus
	claude-opus
	haiku
	claude-haiku
	fable
	claude-fable
)

expected_override_models=(
	claude-fable
	claude-fable-5
	claude-haiku
	'claude-haiku-4-5@20251001'
	claude-opus
	claude-opus-4-6
	fable
	haiku
	opus
)

cd "$VALIDATION_EXT_DIR"
echo '==> Deterministic dependency install (isolated)'
npm ci --ignore-scripts
echo '==> Strict TypeScript and behavior harness'
npx tsc --noEmit --strict --module NodeNext --moduleResolution NodeNext \
	--target ES2022 --types node --skipLibCheck index.ts validate-harness.ts
npx tsc --strict --module NodeNext --moduleResolution NodeNext \
	--target ES2022 --types node --skipLibCheck \
	--outDir "$VALIDATION_EXT_DIR/.validation-harness" \
	index.ts validate-harness.ts
(
	unset VERTEX_CLAUDE_MODELS
	node "$VALIDATION_EXT_DIR/.validation-harness/validate-harness.js"
)
echo '==> Production dependency audit'
npm audit --omit=dev

echo '==> Default manifest listing (local only)'
list_models | tee "$WORK_DIR/manifest.txt"
# The harness asserts the concrete manifest and alias targets; listing also
# verifies Pi loader registration.
for id in "${manifest_models[@]}"; do
	assert_model "$WORK_DIR/manifest.txt" "$id"
done
assert_exact_model_set \
	"$WORK_DIR/manifest.txt" \
	"${expected_manifest_models[@]}"
for id in "${retired_models[@]}"; do
	assert_no_model "$WORK_DIR/manifest.txt" "$id"
done

echo '==> Exact explicit override set'
list_models_with_override \
	'claude-opus-4-6,claude-haiku-4-5@20251001,claude-fable-5' |
	tee "$WORK_DIR/override.txt"
for id in "${override_models[@]}"; do
	assert_model "$WORK_DIR/override.txt" "$id"
done
assert_exact_model_set \
	"$WORK_DIR/override.txt" \
	"${expected_override_models[@]}"
for id in claude-opus-4-8 sonnet claude-sonnet; do
	assert_no_model "$WORK_DIR/override.txt" "$id"
done

echo '==> Invalid and empty overrides yield no Pi-registered models'
# Pi may swallow extension-load exceptions; exact parser errors are asserted by
# validate-harness.ts rather than claimed as Pi CLI output.
list_models_with_override '' >"$WORK_DIR/empty.out" 2>"$WORK_DIR/empty.err" || true
if grep -q '^vertex-claude[[:space:]]' "$WORK_DIR/empty.out"; then
	echo 'empty override unexpectedly loaded the manifest' >&2
	exit 1
fi
list_models_with_override 'claude-nonsense,claude-' \
	>"$WORK_DIR/malformed.out" 2>"$WORK_DIR/malformed.err" || true
if grep -q '^vertex-claude[[:space:]]' "$WORK_DIR/malformed.out"; then
	echo 'malformed override unexpectedly loaded models' >&2
	exit 1
fi

echo 'Static/local validation passed. No Vertex inference was requested.'
if [[ -n "${RUN_VERTEX_CLAUDE_SMOKE_MODEL:-}" ]]; then
	echo "==> Opt-in Vertex inference smoke: ${RUN_VERTEX_CLAUDE_SMOKE_MODEL}"
	stdout="$WORK_DIR/smoke.stdout"
	stderr="$WORK_DIR/smoke.stderr"
	(
		unset VERTEX_CLAUDE_MODELS
		run_pi --no-extensions -e "$EXT_ENTRY" --provider vertex-claude \
			--model "$RUN_VERTEX_CLAUDE_SMOKE_MODEL" --no-tools --no-session \
			-p 'Reply with exactly: hi'
	) >"$stdout" 2>"$stderr"
	cat "$stderr" >&2
	[[ "$(tr -d '\r' <"$stdout")" == hi ]]
fi
