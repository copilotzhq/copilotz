#!/usr/bin/env bash
set -euo pipefail

INCLUDE_DOCS=false
SPLIT=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-docs) INCLUDE_DOCS=true; shift ;;
    --split) SPLIT="$2"; shift 2 ;;
    *) echo "Usage: bundle.sh [--with-docs] [--split N]" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

EXCLUDE_DOCS=()
if [[ "$INCLUDE_DOCS" == false ]]; then
  EXCLUDE_DOCS=(-not -path "*/docs/*")
fi

# Build ordered file list: pinned first, then the rest sorted
TMPLIST="$(mktemp)"
trap 'rm -f "$TMPLIST"' EXIT

for pinned in README.md deno.json; do
  [[ -f "$ROOT_DIR/$pinned" ]] && echo "$ROOT_DIR/$pinned" >> "$TMPLIST"
done

find "$ROOT_DIR" -type f \
  \( -name "*.ts" -o -name "*.js" -o -name "*.json" -o -name "*.md" \
     -o -name "*.sql" -o -name "*.yml" -o -name "*.yaml" -o -name "*.toml" \
     -o -name "*.css" -o -name "*.html" -o -name "*.sh" -o -name "*.txt" \) \
  -not -path "*/.git/*" \
  -not -path "*/node_modules/*" \
  -not -path "*/experiments/*" \
  -not -path "*/scripts/*" \
  -not -path "*/.github/*" \
  -not -path "*/_old_docs/*" \
  -not -path "*/_docs/*" \
  -not -path "*/examples/*" \
  "${EXCLUDE_DOCS[@]}" \
  -not -name "*test*" \
  -not -name ".env*" \
  -not -name "*.lock" \
  -not -name "*.min.js" \
  -not -name "*.min.css" \
  -not -name "*.map" \
  -not -name "*.d.ts" \
  -not -name "bundle*.txt" \
  -not -name "REPO.md" \
  -not -name "ROADMAP.md" \
  | sort | while IFS= read -r filepath; do
    bn="$(basename "$filepath")"
    dn="$(dirname "$filepath")"
    # Skip pinned files already added above
    [[ "$dn" == "$ROOT_DIR" && ( "$bn" == "README.md" || "$bn" == "deno.json" ) ]] && continue
    echo "$filepath"
  done >> "$TMPLIST"

TOTAL=$(wc -l < "$TMPLIST")
PER_CHUNK=$(( (TOTAL + SPLIT - 1) / SPLIT ))

echo "  Total files: $TOTAL, split into $SPLIT parts (~$PER_CHUNK files each)" >&2

# Remove old bundle files
rm -f "$ROOT_DIR"/bundle*.txt

idx=0
chunk=1
outfile=""

while IFS= read -r filepath; do
  # Open a new chunk file when needed
  if (( idx % PER_CHUNK == 0 )); then
    chunk=$(( idx / PER_CHUNK + 1 ))
    if [[ "$SPLIT" -eq 1 ]]; then
      outfile="$ROOT_DIR/bundle.txt"
    else
      outfile="$(printf '%s/bundle_%02d.txt' "$ROOT_DIR" "$chunk")"
    fi
    : > "$outfile"
    echo "  Creating $outfile..." >&2
  fi

  relpath="${filepath#"$ROOT_DIR"/}"
  {
    echo "================================================"
    echo "FILE: $relpath"
    echo "================================================"
    cat "$filepath"
    echo ""
    echo ""
  } >> "$outfile"

  idx=$(( idx + 1 ))
  printf "\r  Bundled %d/%d files..." "$idx" "$TOTAL" >&2
done < "$TMPLIST"

echo "" >&2
echo "Done!" >&2
if [[ "$SPLIT" -eq 1 ]]; then
  echo "Output: $ROOT_DIR/bundle.txt ($(du -h "$ROOT_DIR/bundle.txt" | cut -f1))" >&2
else
  for f in "$ROOT_DIR"/bundle_*.txt; do
    echo "  $f ($(du -h "$f" | cut -f1))" >&2
  done
fi
