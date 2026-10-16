#!/bin/sh
set -eu
plugin_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
runtime=${PI_IN_CODEX_NODE_PATH:-}
if [ -z "$runtime" ] && [ -f "$plugin_root/node-path" ]; then IFS= read -r runtime < "$plugin_root/node-path"; fi
if [ -z "$runtime" ]; then runtime=$(command -v node || true); fi
if [ -z "$runtime" ] || [ ! -x "$runtime" ]; then
  printf '%s\n' 'pi_in_codex requires Node.js >=22.19. Re-run its installer or set PI_IN_CODEX_NODE_PATH.' >&2
  exit 1
fi
PATH="$(dirname -- "$runtime"):${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
export PATH
exec "$runtime" "$plugin_root/dist/cli.mjs" "$@"
