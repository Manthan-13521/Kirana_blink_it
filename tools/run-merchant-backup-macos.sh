#!/bin/sh
set -eu
umask 077

runner_dir=$1
node_path=$2
cd "$runner_dir"

# launchd starts independently of Terminal and has a minimal environment.
PATH="$(dirname "$node_path"):/usr/bin:/bin"
export PATH
export WRANGLER_SEND_METRICS=false

if [ -L backup.key ] || [ ! -f backup.key ] ||
   [ "$(/usr/bin/stat -f '%u:%Lp' backup.key)" != "$(/usr/bin/id -u):600" ]; then
  printf '%s\n' 'The merchant backup key must be a private, owner-readable regular file.' >&2
  exit 1
fi

exec "$node_path" tools/maintenance.mjs store.json worker.json backups --backup-only < backup.key
