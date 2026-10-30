#!/usr/bin/env bash
# Run Inkwell as a Podman pod (rootless or root): PostgreSQL (with pgvector) + Inkwell, optionally Ollama.
# Containers in a pod share localhost: Inkwell reaches Postgres at 127.0.0.1:5432 and Ollama at 127.0.0.1:11434
# (which counts as "local AI" for spaces restricted to local AI). Only Inkwell's port is published.
#
#   ./deploy/podman-pod.sh up        [--port 8080] [--bind 127.0.0.1] [--with-ollama] [--gpu] [--models "qwen2.5:7b-instruct qwen2.5vl:7b nomic-embed-text"]
#   ./deploy/podman-pod.sh build     rebuild the image from this checkout
#   ./deploy/podman-pod.sh update    git pull, rebuild, recreate the pod with the options of the last 'up' (data is kept)
#   ./deploy/podman-pod.sh down      stop and remove the pod (volumes are kept)
#   ./deploy/podman-pod.sh logs      follow Inkwell's log
#   ./deploy/podman-pod.sh status    pod, containers and health
#   ./deploy/podman-pod.sh backup    pg_dump + assets into ./backups/<date>/
#   ./deploy/podman-pod.sh systemd   user systemd unit so the pod starts at boot (rootless: loginctl enable-linger $USER)
#
# Configuration: deploy/inkwell.env (created on first run, mode 600) holds INKWELL_SECRET (encrypts stored AI keys and
# integration tokens) and the database password. Back it up with the volumes.
set -euo pipefail

POD=inkwell
IMAGE=localhost/inkwell:latest
PG_IMAGE=docker.io/pgvector/pgvector:pg17
OLLAMA_IMAGE=docker.io/ollama/ollama:latest
PORT=8080 ; BIND=127.0.0.1 ; WITH_OLLAMA=0 ; GPU=0 ; MODELS="qwen2.5:7b-instruct qwen2.5vl:7b nomic-embed-text"
SRC="$(cd "$(dirname "$0")/.." && pwd)"
ENVFILE="$SRC/deploy/inkwell.env"
OPTFILE="$SRC/deploy/pod.options"
PULL=1

cmd="${1:-help}"; shift || true
ARGS=("$@")
# shellcheck disable=SC1090
[[ "$cmd" == update && -f "$OPTFILE" ]] && source "$OPTFILE"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --bind) BIND="$2"; shift 2 ;;
    --with-ollama) WITH_OLLAMA=1; shift ;;
    --gpu) GPU=1; shift ;;
    --models) MODELS="$2"; shift 2 ;;
    --no-pull) PULL=0; shift ;;
    *) echo "Unknown option $1"; exit 1 ;;
  esac
done

command -v podman >/dev/null || { echo "podman is not installed (sudo apt install podman)"; exit 1; }

ensure_env() {
  [[ -f "$ENVFILE" ]] && return
  umask 077
  local pw; pw=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
  cat > "$ENVFILE" <<EOF
# Inkwell pod configuration (all options: server/src/config.js).
INKWELL_SECRET=$(head -c 32 /dev/urandom | base64)
POSTGRES_PASSWORD=$pw
INKWELL_DATABASE_URL=postgres://inkwell:$pw@127.0.0.1:5432/inkwell
# Public https URL when behind a reverse proxy, and secure cookies with TLS:
INKWELL_PUBLIC_URL=
INKWELL_SECURE_COOKIES=0
# Address of a reverse proxy in another container that sets X-Forwarded-For (default: loopback only).
INKWELL_TRUST_PROXY=
# Anyone may create an account (the first account is always allowed and becomes admin).
INKWELL_ALLOW_SIGNUP=1
# Optional server-wide AI (users can also add their own providers in Settings → AI):
INKWELL_AI_TYPE=
INKWELL_AI_URL=
INKWELL_AI_KEY=
INKWELL_AI_CHAT_MODEL=
INKWELL_AI_VISION_MODEL=
INKWELL_AI_EMBED_MODEL=
# Sign in with Halcyon (same secret as HALCYON_SSO_SECRET; INKWELL_PUBLIC_URL must be set); see docs/HANDOFF.md
INKWELL_HALCYON_URL=
INKWELL_HALCYON_SECRET=
# A PEM file inside the container when Halcyon has a private certificate authority
INKWELL_HALCYON_CA=
EOF
  echo "==> Created $ENVFILE (back it up: it holds the encryption key and the database password)"
}

envval() { grep -E "^$1=" "$ENVFILE" | head -1 | cut -d= -f2-; }

build() {
  echo "==> Building $IMAGE"
  podman build -t "$IMAGE" -f "$SRC/Dockerfile" "$SRC"
}

health() { podman exec "$POD-app" node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; }

up() {
  ensure_env
  podman image exists "$IMAGE" || build
  if podman pod exists "$POD"; then echo "Pod $POD already exists — use '$0 update' or '$0 down' first."; exit 1; fi
  for v in inkwell-pg inkwell-data; do podman volume exists "$v" || podman volume create "$v" >/dev/null; done
  printf 'PORT=%q\nBIND=%q\nWITH_OLLAMA=%q\nGPU=%q\n' "$PORT" "$BIND" "$WITH_OLLAMA" "$GPU" > "$OPTFILE"
  echo "==> Creating pod $POD on $BIND:$PORT"
  podman pod create --name "$POD" -p "$BIND:$PORT:8080"
  podman run -d --pod "$POD" --name "$POD-db" --restart unless-stopped \
    -e POSTGRES_USER=inkwell -e POSTGRES_DB=inkwell -e POSTGRES_PASSWORD="$(envval POSTGRES_PASSWORD)" \
    -v inkwell-pg:/var/lib/postgresql/data:Z \
    --health-cmd "pg_isready -U inkwell -d inkwell" --health-interval 10s "$PG_IMAGE"
  echo "==> Waiting for PostgreSQL"
  for _ in {1..60}; do podman exec "$POD-db" pg_isready -U inkwell -d inkwell >/dev/null 2>&1 && break; sleep 1; done
  if [[ $WITH_OLLAMA -eq 1 ]]; then
    podman volume exists ollama-models || podman volume create ollama-models >/dev/null
    local gpu=()
    [[ $GPU -eq 1 ]] && gpu=(--device nvidia.com/gpu=all --security-opt=label=disable)
    podman run -d --pod "$POD" --name "$POD-ollama" --restart unless-stopped "${gpu[@]}" \
      -v ollama-models:/root/.ollama -e OLLAMA_KEEP_ALIVE=30m "$OLLAMA_IMAGE"
  fi
  local tz="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone 2>/dev/null || echo UTC)}"
  # :U chowns the volume to the container user (node, uid 1000) under rootless user namespaces.
  podman run -d --pod "$POD" --name "$POD-app" --restart unless-stopped \
    --env-file "$ENVFILE" -e TZ="$tz" -v inkwell-data:/data:U,Z \
    --health-cmd "node -e \"fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"" \
    --health-interval 30s "$IMAGE"
  if [[ $WITH_OLLAMA -eq 1 && -n "$MODELS" ]]; then
    echo "==> Pulling models: $MODELS (first time can take a while)"
    for _ in {1..30}; do podman exec "$POD-ollama" ollama list >/dev/null 2>&1 && break; sleep 1; done
    for m in $MODELS; do podman exec "$POD-ollama" ollama pull "$m"; done
  fi
  local ok=0
  for _ in {1..40}; do
    health && { ok=1; break; }
    podman container inspect -f '{{.State.Running}}' "$POD-app" 2>/dev/null | grep -q true || break
    sleep 1
  done
  if [[ $ok -ne 1 ]]; then echo "Inkwell did not start. Last log lines:"; podman logs --tail 40 "$POD-app"; exit 1; fi
  echo
  echo "Inkwell is running: http://$BIND:$PORT — the first account you create becomes the administrator."
  [[ "$BIND" == 127.* ]] && echo "Bound to $BIND: put nginx/Caddy with TLS in front (deploy/nginx.conf), or use --bind 0.0.0.0 on a trusted network."
  [[ $WITH_OLLAMA -eq 1 ]] && echo "In Settings → AI add provider 'Ollama' with address http://127.0.0.1:11434 (tick Server-wide as admin)."
  return 0
}

down() {
  podman pod exists "$POD" || { echo "Pod $POD does not exist"; return; }
  podman pod stop "$POD" >/dev/null && podman pod rm "$POD"
  echo "Pod removed; volumes inkwell-pg / inkwell-data / ollama-models are kept."
}

backup() {
  local dir; dir="$SRC/backups/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$dir"
  podman exec "$POD-db" pg_dump -U inkwell -Fc inkwell > "$dir/inkwell.pgdump"
  podman exec "$POD-app" tar -C /data -cf - assets secret.key 2>/dev/null > "$dir/data.tar" || true
  cp "$ENVFILE" "$dir/inkwell.env"
  echo "Backup written to $dir"
}

case "$cmd" in
  up) up ;;
  build) build ;;
  update)
    if [[ $PULL -eq 1 ]] && git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
      echo "==> git pull"
      git -C "$SRC" pull --ff-only || { echo "git pull failed — fix it, or run '$0 update --no-pull'."; exit 1; }
      exec "$SRC/deploy/podman-pod.sh" update --no-pull "${ARGS[@]}"
    fi
    podman container exists "$POD-ollama" && { WITH_OLLAMA=1; MODELS=""; }
    build; down; up ;;
  down) down ;;
  logs) podman logs -f "$POD-app" ;;
  backup) backup ;;
  status)
    podman pod ps --filter name="$POD"
    podman ps --pod --filter pod="$POD" --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
    if health; then echo "Health: ok"; else echo "Health: FAILED"; fi ;;
  systemd)
    mkdir -p ~/.config/systemd/user
    (cd ~/.config/systemd/user && podman generate systemd --new --files --name "$POD" >/dev/null)
    down
    systemctl --user daemon-reload
    systemctl --user enable --now "pod-$POD.service"
    echo "Installed ~/.config/systemd/user/pod-$POD.service (starts at boot with: loginctl enable-linger $USER)" ;;
  *) sed -n 2,17p "$0" ;;
esac
