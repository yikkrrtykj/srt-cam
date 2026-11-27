#!/usr/bin/env bash
# Generate a ready-to-run SRT-CAM v2 node config.json for direct IP:port + password access.
# Safe by default: refuses to overwrite an existing config.json unless --force is passed.
set -euo pipefail

NODE_ID="vps-1"
DISPLAY_NAME=""
REGION=""
PUBLIC_IP=""
LISTEN_PORT="8080"
USERNAME="admin"
PASSWORD=""
CLUSTER_TOKEN=""
OUT_DIR="deploy"
FORCE=0
BRING_UP=0

usage() {
  cat <<'EOF'
Usage: bash scripts/init-v2-node.sh [options]
  --node-id <id>          Node ID (default: vps-1)
  --name <label>          Display name (default: <node-id>)
  --region <label>        Server region label (e.g. Singapore, LosAngeles)
  --public-ip <ip>        Public IPv4 shown in console & SRT push/pull URLs
  --port <port>           HTTP listen port on 0.0.0.0 (default: 8080)
  --user <username>       Login username (default: admin)
  --password <password>   Login password (prompted if omitted)
  --cluster-token <tok>   Shared cluster token across VPS nodes (random if omitted)
  --out-dir <dir>         Output directory (default: deploy)
  --up                    Also start all 10 SRT relay channels (srt-cam1..10),
                          add UFW rules if UFW is active, and launch srt-camd
  --force                 Overwrite existing config.json
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-id) NODE_ID="$2"; shift 2 ;;
    --name) DISPLAY_NAME="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --port) LISTEN_PORT="$2"; shift 2 ;;
    --user) USERNAME="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --cluster-token) CLUSTER_TOKEN="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --up) BRING_UP=1; shift ;;
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

python3 - "$CONFIG_FILE" "$NODE_ID" "$DISPLAY_NAME" "$REGION" "$PUBLIC_IP" "$LISTEN_PORT" "$USERNAME" "$HASH" "$SESSION_SECRET" "$CLUSTER_TOKEN" <<'PY'
import json, sys

out_path, node_id, display_name, region, public_ip, port, username, pw_hash, sess_secret, cluster_tok = sys.argv[1:]
cfg = {
    "node_id": node_id,
    "display_name": display_name,
    "region": region,
    "public_ip": public_ip,
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
  MOUNT_SRC="$PWD/${OUT_DIR}"
fi

if [[ "$BRING_UP" -eq 1 ]]; then
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
    echo "[srt-cam] UFW 已启用，自动放行 10 路 SRT 端口 (UDP 20001:20010, 21001:21010) 及控制端口 (TCP ${LISTEN_PORT})"
    ufw allow 20001:20010/udp >/dev/null
    ufw allow 21001:21010/udp >/dev/null
    ufw allow "${LISTEN_PORT}/tcp" >/dev/null
  fi
  echo "[srt-cam] 启动全部 10 路 SRT 中转通道 (srt-cam1..10)..."
  docker compose -f deploy/docker-compose.v2.yml up -d --build
  mkdir -p /var/lib/srt-cam
  docker rm -f srt-camd >/dev/null 2>&1 || true
  docker run -d --name srt-camd --restart unless-stopped --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${MOUNT_SRC}:/etc/srt-cam" \
    -v /var/lib/srt-cam:/var/lib/srt-cam \
    srt-camd:v2 --config /etc/srt-cam/config.json --events /etc/srt-cam/event-sheet.json >/dev/null
  echo "[srt-cam] 完成！全部 10 路通道及控制面 srt-camd 均已运行。"
fi

cat <<EOF
已生成配置文件：${CONFIG_FILE} (权限 600)
  - 节点 ID      : ${NODE_ID}
  - 访问方式     : http://${PUBLIC_IP:-<VPS_PUBLIC_IP>}:${LISTEN_PORT}
  - 登录账号     : ${USERNAME}
  - Cluster Token: ${CLUSTER_TOKEN}  (多台 VPS 互通时填相同 Token)

如需手动启动 10 路中转通道与控制台（或直接加 --up 参数一键拉起）：
  # 1. 启动全部 10 路 SRT 中转容器 (推流 UDP 20001-20010 / 拉流 UDP 21001-21010)
  docker compose -f deploy/docker-compose.v2.yml up -d --build

  # 2. 如本机开启 UFW 防火墙，记得放行端口（云厂商安全组同样需要放行）
  ufw allow 20001:20010/udp && ufw allow 21001:21010/udp && ufw allow ${LISTEN_PORT}/tcp

  # 3. 启动控制面 srt-camd
  mkdir -p /var/lib/srt-cam
  docker run -d --name srt-camd --restart unless-stopped --network host \\
    -v /var/run/docker.sock:/var/run/docker.sock \\
    -v "${MOUNT_SRC}:/etc/srt-cam" \\
    -v /var/lib/srt-cam:/var/lib/srt-cam \\
    srt-camd:v2 --config /etc/srt-cam/config.json --events /etc/srt-cam/event-sheet.json
EOF
