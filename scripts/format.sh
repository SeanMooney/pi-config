#!/usr/bin/env bash
# Format only explicitly named, handwritten Oxfmt-supported files.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OXFMT="$ROOT/npm/node_modules/.bin/oxfmt"

if (($# == 0)); then
  echo "format.sh: no files supplied; pass explicit files to format" >&2
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

format_oxfmt_file() {
  local file="$1" directory filename
  directory="$(cd -- "$(dirname -- "$file")" && pwd)"
  filename="$(basename -- "$file")"
  (
    cd "$directory"
    "$OXFMT" --config "$ROOT/.oxfmtrc.json" --disable-nested-config \
      --write "$(escape_oxfmt_path "$filename")"
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

files=()
for file in "$@"; do
  [[ -f "$file" ]] || continue # Deleted paths are normal in future hooks.
  if is_exempt "$file"; then
    continue
  fi
  case "$file" in
    *.ts|*.tsx|*.js|*.mjs|*.cjs|*.json|*.md|*.markdown)
      files+=("$file")
      ;;
    *) echo "format.sh: skipping unsupported file: $file" >&2 ;;
  esac
done

if ((${#files[@]} == 0)); then
  echo "format.sh: no eligible files to format" >&2
  exit 0
fi
if [[ ! -x "$OXFMT" ]]; then
  echo "format.sh: Oxfmt is unavailable; run: (cd \"$ROOT/npm\" && npm ci --include=dev)" >&2
  exit 127
fi
for file in "${files[@]}"; do
  format_oxfmt_file "$file"
done
