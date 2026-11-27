#!/usr/bin/env bash
# Generate a ready-to-run SRT-CAM v2 node config.json for direct IP:port + password access.
# Safe by default: refuses to overwrite an existing config.json unless --force is passed.
set -euo pipefail

NODE_ID="vps-1"
DISPLAY_NAME=""
LISTEN_PORT="8080"
USERNAME="admin"
PASSWORD=""
CLUSTER_TOKEN=""
OUT_DIR="deploy"
FORCE=0

usage() {
  cat <<'EOF'
Usage: bash scripts/init-v2-node.sh [options]
  --node-id <id>          Node ID (default: vps-1)
  --name <label>          Display name (default: <node-id>)
  --port <port>           HTTP listen port on 0.0.0.0 (default: 8080)
  --user <username>       Login username (default: admin)
  --password <password>   Login password (prompted if omitted)
  --cluster-token <tok>   Shared cluster token across VPS nodes (random if omitted)
  --out-dir <dir>         Output directory (default: deploy)
  --force                 Overwrite existing config.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-id) NODE_ID="$2"; shift 2 ;;
    --name) DISPLAY_NAME="$2"; shift 2 ;;
    --port) LISTEN_PORT="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --cluster-token) CLUSTER_TOKEN="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

if [[ -z "$DISPLAY_NAME" ]]; then
  DISPLAY_NAME="$NODE_ID"
fi

CONFIG_FILE="${OUT_DIR}/config.json"
EVENTS_FILE="${OUT_DIR}/event-sheet.json"

if [[ -f "$CONFIG_FILE" && "$FORCE" -ne 1 ]]; then
  echo "Refusing to overwrite existing ${CONFIG_FILE} (pass --force to replace)." >&2
  exit 1
fi

if [[ -z "$PASSWORD" ]]; then
  read -r -s -p "设置监控登录密码 (${USERNAME}): " PASSWORD
  echo
  if [[ -z "$PASSWORD" ]]; then
    echo "错误：密码不能为空。" >&2
    exit 1
  fi
fi

gen_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(24))'
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

SESSION_SECRET="$(gen_hex)"
if [[ -z "$CLUSTER_TOKEN" ]]; then
  CLUSTER_TOKEN="$(gen_hex)"
fi

HASH=""
if [[ -x "./bin/srt-camd" ]]; then
  HASH="$(./bin/srt-camd hash-password --password "$PASSWORD")"
elif command -v docker >/dev/null 2>&1 && docker image inspect srt-camd:v2 >/dev/null 2>&1; then
  HASH="$(docker run --rm srt-camd:v2 hash-password --password "$PASSWORD")"
else
  echo "错误：未找到 ./bin/srt-camd 或本地镜像 srt-camd:v2，请先执行：" >&2
  echo "  docker build -f deploy/Dockerfile.camd -t srt-camd:v2 ." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

python3 - "$CONFIG_FILE" "$NODE_ID" "$DISPLAY_NAME" "$LISTEN_PORT" "$USERNAME" "$HASH" "$SESSION_SECRET" "$CLUSTER_TOKEN" <<'PY'
import json, sys

out_path, node_id, display_name, port, username, pw_hash, sess_secret, cluster_tok = sys.argv[1:]
cfg = {
    "node_id": node_id,
    "display_name": display_name,
    "region": "",
    "public_ip": "",
    "listen_addr": f"0.0.0.0:{port}",
    "docker_socket": "/var/run/docker.sock",
    "db_path": "/var/lib/srt-cam/telemetry.db",
    "retention_days": 7,
    "sample_interval_sec": 2,
    "cluster_token": cluster_tok,
    "is_primary_monitor": node_id == "vps-1",
    "auth": {
        "username": username,
        "password_hash": pw_hash,
        "session_secret": sess_secret,
        "cookie_secure": False,
    },
    "feishu": {
        "enabled": False,
        "webhook_url": "",
        "secret": "",
        "debounce_sec": 10,
        "cooldown_sec": 180,
        "watchdog_sec": 20,
        "dashboard_base_url": "",
    },
    "thresholds": {
        "min_flow_mbps": 0.1,
        "high_rtt_ms": 250,
        "high_loss_per_sample": 20,
        "high_retrans": 30,
        "high_nak_lost": 20,
        "udp_buf_drop_trigger": 10,
    },
    "peers": [],
    "passthroughs": [],
    "previews": [],
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY

chmod 600 "$CONFIG_FILE"

if [[ ! -f "$EVENTS_FILE" && -f "deploy/event-sheet.example.json" ]]; then
  cp deploy/event-sheet.example.json "$EVENTS_FILE"
fi

if [[ "$OUT_DIR" == /* ]]; then
  MOUNT_SRC="$OUT_DIR"
else
  MOUNT_SRC="\$PWD/${OUT_DIR}"
fi

cat <<EOF
已生成配置文件：${CONFIG_FILE} (权限 600)
  - 节点 ID      : ${NODE_ID}
  - 访问方式     : http://<VPS_PUBLIC_IP>:${LISTEN_PORT}
  - 登录账号     : ${USERNAME}
  - Cluster Token: ${CLUSTER_TOKEN}  (多台 VPS 互通时填相同 Token)

下一步启动命令（使用 --network host 以便读取本地 Mode A 缩略图与 Mode B 指标）：
  mkdir -p /var/lib/srt-cam
  docker run -d --name srt-camd --restart unless-stopped --network host \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v "${MOUNT_SRC}:/etc/srt-cam" \\
    -v /var/lib/srt-cam:/var/lib/srt-cam \\
    srt-camd:v2 --config /etc/srt-cam/config.json --events /etc/srt-cam/event-sheet.json
EOF
