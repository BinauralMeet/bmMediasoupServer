#!/bin/bash
#  Copies (or, with --check, verifies) a handful of files from the sibling binaural-meet
#  repo that this server needs a copy of. binaural-meet is the canonical source -- always
#  edit there and re-run this script, never hand-edit the copies under DataServer/MediaServer.
set -euo pipefail

CHECK=0
if [ "${1:-}" = "--check" ]; then
  CHECK=1
fi

BM_SRC=../../binaural-meet/src

# path_in_bm|dest_path|sed_expr (sed_expr may be empty)
COPIES=(
  "models/MapObject.ts|./DataServer/MapObject.ts|s_'@models/utils/coordinates'_'./coordinates'_g"
  "models/ISharedContent.ts|./DataServer/ISharedContent.ts|s_'@models/utils/coordinates'_'./coordinates'_g"
  "models/conference/MediaMessages.ts|./MediaServer/MediaMessages.ts|s_'mediasoup-client'_'mediasoup'_g"
  "models/conference/DataMessage.ts|./DataServer/DataMessage.ts|"
  "models/conference/DataMessageType.ts|./DataServer/DataMessageType.ts|"
  "models/utils/coordinates.ts|./DataServer/coordinates.ts|"
)

header(){
  echo "//  GENERATED from binaural-meet/src/$1 by getSourceFromBM.sh -- do not hand-edit."
}

fail=0
for entry in "${COPIES[@]}"; do
  IFS='|' read -r src dest sed_expr <<< "$entry"
  src_path="$BM_SRC/$src"

  if [ -n "$sed_expr" ]; then
    body=$(sed -e "$sed_expr" "$src_path")
  else
    body=$(cat "$src_path")
  fi
  generated=$(printf '%s\n%s' "$(header "$src")" "$body")

  if [ "$CHECK" = "1" ]; then
    #  Ignore line-ending-only drift (client/server copies have historically differed on CRLF vs LF).
    existing=$(cat "$dest" 2>/dev/null | tr -d '\r')
    generated_normalized=$(printf '%s' "$generated" | tr -d '\r')
    if [ "$generated_normalized" != "$existing" ]; then
      echo "OUT OF SYNC: $dest (source: binaural-meet/src/$src)"
      fail=1
    fi
  else
    printf '%s\n' "$generated" > "$dest"
  fi
done

if [ "$CHECK" = "1" ]; then
  if [ "$fail" = "1" ]; then
    echo "Run ./src/getSourceFromBM.sh (without --check) to resync, then commit the result."
    exit 1
  fi
  echo "All copied files are in sync with binaural-meet."
fi
