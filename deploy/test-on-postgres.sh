#!/usr/bin/env bash
# Runs the test suite against the pod's real PostgreSQL (a throwaway database `inkwell_test`, never the live one).
# Needs the pod from ./deploy/podman-pod.sh up. Each test file gets a fresh database.
#
#   ./deploy/test-on-postgres.sh                 # all test files
#   ./deploy/test-on-postgres.sh collab.test.js  # one file
set -euo pipefail

POD=inkwell
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$SRC/deploy/inkwell.env"
NODE_IMAGE=docker.io/library/node:24-bookworm-slim

podman pod exists "$POD" || { echo "Pod $POD is not running — ./deploy/podman-pod.sh up first"; exit 1; }
PW=$(grep -E '^POSTGRES_PASSWORD=' "$ENVFILE" | cut -d= -f2-)
URL="postgres://inkwell:$PW@127.0.0.1:5432/inkwell_test"
FILES=("$@")
[[ ${#FILES[@]} -eq 0 ]] && FILES=(unit.test.js api.test.js collab.test.js ai.test.js)

# Dependencies (incl. dev ones) go into a volume, so the checkout on the host stays untouched.
podman volume exists inkwell-test-modules || podman volume create inkwell-test-modules >/dev/null
echo "==> Installing dependencies in a throwaway container"
podman run --rm -v "$SRC":/src:ro,Z -v inkwell-test-modules:/work:Z -w /work "$NODE_IMAGE" sh -c \
  'cp /src/package.json /src/package-lock.json . && mkdir -p server web && cp /src/server/package.json server/ && cp /src/web/package.json web/ && npm ci --no-audit --no-fund -w server >/dev/null'

fail=0
for f in "${FILES[@]}"; do
  echo "==> $f"
  podman exec "$POD-db" dropdb -U inkwell --if-exists inkwell_test
  podman exec "$POD-db" createdb -U inkwell inkwell_test
  podman run --rm --pod "$POD" -v "$SRC":/src:ro,Z -v inkwell-test-modules:/work:Z -e INKWELL_DATABASE_URL="$URL" "$NODE_IMAGE" sh -c \
    "cp -r /src/server/src /src/server/test /work/server/ && cd /work/server && node --no-warnings --test test/$f" || fail=1
done
podman exec "$POD-db" dropdb -U inkwell --if-exists inkwell_test
[[ $fail -eq 0 ]] && echo "All passed on PostgreSQL." || { echo "Some tests failed (see above)."; exit 1; }
