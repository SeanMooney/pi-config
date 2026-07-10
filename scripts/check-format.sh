#!/usr/bin/env bash
# Check only explicitly named files; designed for future pre-commit filename lists.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OXFMT="$ROOT/npm/node_modules/.bin/oxfmt"
MARKDOWNLINT="$ROOT/npm/node_modules/.bin/markdownlint-cli2"

if (($# == 0)); then
  echo "check-format.sh: no files supplied; pass explicit files to check" >&2
  exit 2
fi

escape_oxfmt_path() {
  local input="$1" escaped="" character
  while [[ -n "$input" ]]; do
    character="${input:0:1}"
    input="${input:1}"
    case "$character" in
      "\\") escaped+='[\\\\]' ;;
      "!") escaped+='[\!]' ;;
      "*") escaped+='[*]' ;;
      "?") escaped+='[?]' ;;
      "[") escaped+='[[]' ;;
      "]") escaped+='[]]' ;;
      "{") escaped+='[{]' ;;
      "}") escaped+='[}]' ;;
      "(") escaped+='[(]' ;;
      ")") escaped+='[)]' ;;
      "+") escaped+='[+]' ;;
      "@") escaped+='[@]' ;;
      "|") escaped+='[|]' ;;
      *) escaped+="$character" ;;
    esac
  done
  printf './%s' "$escaped"
}

check_oxfmt_file() {
  local file="$1" directory filename
  directory="$(cd -- "$(dirname -- "$file")" && pwd)"
  filename="$(basename -- "$file")"
  (
    cd "$directory"
    "$OXFMT" --config "$ROOT/.oxfmtrc.json" --disable-nested-config \
      --check "$(escape_oxfmt_path "$filename")"
  )
}

is_exempt() {
  local path="/${1#./}/"
  case "$path" in
    */node_modules/*|*/sessions/*|*/state/*|*/tmp/*|*/.tmp/*|*/.git/*) return 0 ;;
    */package-lock.json|*/auth.json|*/mcp-cache.json|*/mcp-npx-cache.json) return 0 ;;
    */settings.json|*/sandbox.json|*.jsonl/|*.log/) return 0 ;;
  esac
  return 1
}

format_files=()
markdown_files=()
for file in "$@"; do
  [[ -f "$file" ]] || continue # Deleted paths are normal in future hooks.
  if is_exempt "$file"; then
    continue
  fi
  case "$file" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.md|*.markdown)
      format_files+=("$file")
      case "$file" in
        *.md|*.markdown) markdown_files+=(":$file") ;;
      esac
      ;;
    *) echo "check-format.sh: skipping unsupported file: $file" >&2 ;;
  esac
done

if ((${#format_files[@]})); then
  if [[ ! -x "$OXFMT" ]]; then
    echo "check-format.sh: Oxfmt is unavailable; run:" >&2
    echo "  (cd \"$ROOT/npm\" && npm ci --include=dev)" >&2
    exit 127
  fi
  for file in "${format_files[@]}"; do
    check_oxfmt_file "$file"
  done
fi
if ((${#markdown_files[@]})); then
  if [[ ! -x "$MARKDOWNLINT" ]]; then
    echo "check-format.sh: markdownlint-cli2 is unavailable; run:" >&2
    echo "  (cd \"$ROOT/npm\" && npm ci --include=dev)" >&2
    exit 127
  fi
  "$MARKDOWNLINT" --config "$ROOT/.markdownlint.yaml" "${markdown_files[@]}"
fi
if ((${#format_files[@]} == 0)); then
  echo "check-format.sh: no eligible files to check" >&2
fi
