#!/bin/sh
set -eu
host_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
node_path="$host_dir/../runtime/node"
if [ ! -x "$node_path" ]; then
  echo 'Breezer AI bundled Node.js runtime is missing. Reinstall Breezer.' >&2
  exit 1
fi
PATH="$host_dir/../runtime:/usr/bin:/bin:/usr/sbin:/sbin"
export PATH
unset NODE_OPTIONS NODE_PATH
exec "$node_path" "$host_dir/main.mjs" "$@"
