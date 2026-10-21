#!/usr/bin/env bash
# Safe one-shot bootstrap for a fresh Ubuntu/Debian SRT relay host.
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/opt/srt-relay"
MARKER="${INSTALL_DIR}/.managed-by-srt-cam"
SYSCTL_FILE="/etc/sysctl.d/98-srt-cam.conf"
MODE="deploy"

log() { printf '[srt-cam] %s\n' "$*"; }
fail() { printf '[srt-cam] STOP: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'HELP'
Usage: sudo bash install.sh [--status-only | --dry-run]
  (default)     Fresh VPS: install Docker/tools, build relay, deploy ten channels,
                and install read-only srt-status. Refuses existing relay ports.
  --status-only Install/update only srt-status and its optional config.
                Does not touch relay containers, firewall, or sysctl.
  --dry-run     Print intended actions without changing the host.
HELP
}

case "${1:-}" in
  '') ;;
  --status-only) MODE="status" ;;
  --dry-run) MODE="dry" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || fail 'Pass at most one option.'
[[ "$EUID" -eq 0 ]] || fail 'Run as root (sudo bash install.sh).'
[[ -f "$ROOT_DIR/docker-compose.yml" && -f "$ROOT_DIR/Dockerfile" && -f "$ROOT_DIR/srt-status" ]] || fail 'Repository files missing; run from a full checkout.'

if [[ "$MODE" == "dry" ]]; then
  log "DRY RUN: fresh-host setup to ${INSTALL_DIR}: apt packages, Docker image, 10 SRT containers, UDP firewall allowances if UFW is already active, kernel max buffers, srt-status."
  log 'Existing SRT processes/ports will cause STOP; no automatic overwrite.'
  exit 0
fi

if [[ "$MODE" == "deploy" ]]; then
  [[ -r /etc/os-release ]] || fail 'Unknown operating system.'
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "Only Ubuntu/Debian supported (found ${ID:-unknown})." ;;
  esac
  command -v apt-get >/dev/null || fail 'apt-get not found.'
  if [[ -f "$MARKER" ]]; then
    log "Managed installation already exists at $INSTALL_DIR; leaving containers unchanged."
    log 'Use --status-only to refresh the diagnostic tool.'
    exit 0
  fi
  if [[ -e "$INSTALL_DIR/docker-compose.yml" || -e "$SYSCTL_FILE" ]]; then
    fail 'Existing relay/config files detected. Refusing to overwrite. Use --status-only on existing servers.'
  fi
  if command -v docker >/dev/null 2>&1 && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Eq '^srt-cam([1-9]|10)$'; then
    fail 'Existing srt-cam container(s) found. Refusing automatic redeployment.'
  fi
  if command -v ss >/dev/null 2>&1; then
    if ss -H -lun | awk '{print $5}' | grep -Eq ':(1111[1-9]|11120|2111[1-9]|21120)$'; then
      fail 'An SRT UDP port is already bound. Refusing deployment.'
    fi
  fi
fi

install_status() {
  install -m 0755 "$ROOT_DIR/srt-status" /usr/local/bin/srt-status
  if [[ ! -e /etc/srt-status.json ]]; then
    install -m 0644 "$ROOT_DIR/srt-status.json" /etc/srt-status.json
  else
    log 'Preserving existing /etc/srt-status.json.'
  fi
  log 'srt-status installed: sudo srt-status -s 6'
}

log 'Checking diagnostic prerequisites.'
if ! command -v python3 >/dev/null 2>&1 || ! command -v tcpdump >/dev/null 2>&1; then
  command -v apt-get >/dev/null 2>&1 || fail 'Install Python3 and tcpdump manually.'
  apt-get update -y
  apt-get install -y python3 tcpdump
fi
if [[ "$MODE" == "status" ]]; then
  install_status
  log 'PASS: status-only installation; relay unchanged.'
  exit 0
fi

log 'Installing Docker if needed.'
if ! command -v docker >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y docker.io
fi
systemctl enable --now docker
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  log 'Installing Compose from available distro packages.'
  if apt-get install -y docker-compose-v2; then
    COMPOSE=(docker compose)
  elif apt-get install -y docker-compose-plugin; then
    COMPOSE=(docker compose)
  elif apt-get install -y docker-compose; then
    COMPOSE=(docker-compose)
  else
    fail 'Cannot install Docker Compose from distro packages.'
  fi
fi
"${COMPOSE[@]}" version >/dev/null 2>&1 || fail 'Docker Compose verification failed.'

log 'Applying maximum kernel socket buffers (existing defaults are left untouched).'
cat > "$SYSCTL_FILE" <<'SYSCTL'
# srt-cam: SRT receive/send buffer ceiling; do not globally reserve these sizes.
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
SYSCTL
sysctl -p "$SYSCTL_FILE"

log 'Copying relay configuration and building local image.'
mkdir -p "$INSTALL_DIR"
install -m 0644 "$ROOT_DIR/Dockerfile" "$INSTALL_DIR/Dockerfile"
install -m 0644 "$ROOT_DIR/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
install_status
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then
  log 'UFW already active; adding UDP 11111:11120 and 21111:21120 rules (not enabling UFW).'
  ufw allow 11111:11120/udp
  ufw allow 21111:21120/udp
fi
log 'Remember: cloud-provider firewall/security group must also allow required UDP ports.'

docker build -t local-srt-gateway "$INSTALL_DIR"
DEPLOY_SUCCESS=0
rollback_on_failure() {
  if [[ "$DEPLOY_SUCCESS" == 0 ]]; then
    log 'Deployment incomplete; stopping only newly created srt-cam services.'
    (cd "$INSTALL_DIR" && "${COMPOSE[@]}" down --remove-orphans) || true
  fi
}
trap rollback_on_failure EXIT
(cd "$INSTALL_DIR" && "${COMPOSE[@]}" up -d)

log 'Checking all 10 SRT containers are running.'
for i in $(seq 1 10); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "srt-cam$i" 2>/dev/null || true)" != "true" ]]; then
    fail "srt-cam$i is not running; check docker logs before retrying."
  fi
done
printf 'managed-by=srt-cam\n' > "$MARKER"
DEPLOY_SUCCESS=1
trap - EXIT
log 'PASS: 10/10 containers running. This does NOT yet prove end-to-end SRT connectivity.'
log 'Run sudo srt-status -s 6. Configure event-specific directions/expected_active in /etc/srt-status.json.'
