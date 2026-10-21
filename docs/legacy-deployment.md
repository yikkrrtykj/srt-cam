# 原始《SRT 中转网关》部署方案（文字转录）

来源：此前提供的 `srt中转网关.docx`。本文件保留原始命令和配置意图，**不代表这些旧命令适合直接在现有生产 VPS 上执行**。新装请使用仓库根目录的 `install.sh`，旧生产机器只用 `--status-only`。

## 第一阶段：操作系统内核调优

```sh
echo "net.core.rmem_max=33554432" | tee -a /etc/sysctl.conf
echo "net.core.wmem_max=33554432" | tee -a /etc/sysctl.conf
echo "net.core.rmem_default=16777216" | tee -a /etc/sysctl.conf
echo "net.core.wmem_default=16777216" | tee -a /etc/sysctl.conf
sudo sysctl -p
```

## 第二阶段：Docker 与基础镜像

```sh
sudo apt update
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo systemctl enable --now docker
mkdir -p /opt/srt-relay && cd /opt/srt-relay
cat << 'DOCKERFILE' > Dockerfile
FROM ubuntu:22.04
RUN apt-get update && apt-get install -y srt-tools && rm -rf /var/lib/apt/lists/*
ENTRYPOINT ["srt-live-transmit"]
DOCKERFILE
docker build -t local-srt-gateway .
```

## 第三阶段：核心中转配置

```sh
sudo ufw allow 11111:11120/udp
sudo ufw allow 21111:21120/udp
# 将本仓库 archive/docker-compose.original.yml 放在 /opt/srt-relay/docker-compose.yml
docker compose up -d
```

## 第四阶段：常用管理命令（原文件）

```sh
docker compose down --remove-orphans
docker logs -f srt-cam1
tcpdump -i eth0 udp port 21111 -n
ss -ulnp | grep 21111
# 原文还包含 kill -9 <PID>，生产排障不建议盲目执行。
```

原文还包含 VPS IP 解锁及回程路由测试命令，这些与 SRT 核心部署无关，故不纳入一键安装流程。新脚本在新机器默认**仅设置 rmem_max/wmem_max**，避免把原文的全局 default 缓冲区参数应用到其他服务；亦不默认启用 UFW。
