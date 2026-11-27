# SRT-CAM

部署在云服务器上的多路 SRT 直播信号中转与 Web 监看系统。支持将现场编码器（硬件编码器、vMix、OBS、Larix、Makito X4 等）推流至云端中转，并由接收端拉流，同时提供多画面监看墙、链路状态监测、多节点管理与飞书告警功能。

---

## 功能特性

- **通道容器隔离**：默认运行 10 个独立 Docker 转发容器（`srt-cam1` – `srt-cam10`），单通道重启或更新控制面 `srt-camd` 均不中断其他在播信号。
- **双转发模式**：
  - **模式 A（SRT 推拉中转）**：基于 Haivision `libsrt 1.5.x`，推流端与拉流端均使用 Caller 模式连接服务器，两端无需公网 IP 或端口映射。
  - **模式 B（UDP 透明转发，可选）**：面向 Makito X4 等支持双路无缝冗余（Path Redundancy）的设备，仅做四层 UDP 转发与明文包头统计，不解密载荷、不增加额外缓冲。
- **流开关与参数锁定**：单条信号可独立启停底层转发容器；开启状态下自动锁定通道、端口与模式等传输参数（名称与备注仍可编辑），关闭在播流需二次确认。
- **多画面监看墙**：支持无边框全屏上屏，1–16 路自动适配 `1×1` 至 `4×4` 网格，所有画面与底部指标栏在一屏内完整显示（悬停右上角或按 `ESC` 退出）。
- **按需画面预览与音视频解析**：仅在浏览器打开监控页面时，每 5 秒旁路抓取 1 帧 `960×540` 静帧并解析视频分辨率、编码、帧率及音频编码、采样率、码率、声道；主路转发无额外延迟，无人查看时无抓图 CPU 占用。
- **分层排障与飞书告警**：工作台提供 5 分钟至 24 小时历史曲线（码率、RTT、缓冲、重传与弃包），自动区分推流段、中转服务器与拉流段异常，并支持配置飞书群机器人告警及恢复通知。
- **多服务器聚合**：支持在控制台内接入多台 VPS 节点，统一展示各节点信号与主备状态。

---

## 快速部署（Docker）

适用于已安装 Docker 的 Ubuntu / Debian 服务器（宿主机无需安装 Go 或 Node.js）。

### 1. 放行防火墙端口

| 端口 | 协议 | 用途 |
|---|---|---|
| `8080`（可自定义） | TCP | Web 控制台访问 |
| `20001` – `20010` | UDP | 10 路模式 A 推流端口 |
| `21001` – `21010` | UDP | 10 路模式 A 拉流端口 |
| `31111`+（可选） | UDP | 仅启用模式 B 透明转发时需要 |

### 2. 编译镜像并初始化启动

```bash
git clone https://github.com/yikkrrtykj/srt-cam.git
cd srt-cam

docker build -f deploy/Dockerfile.camd -t srt-camd:v2 .
bash scripts/init-v2-node.sh --node-id vps-1 --port 8080 --up
```

执行脚本时按提示设置登录密码，完成后访问 `http://<服务器IP>:8080` 登录（默认用户名 `admin`）。

### 3. 更新控制台（不中断转发通道）

```bash
cd ~/srt-cam && git pull --ff-only && \
docker build -f deploy/Dockerfile.camd -t srt-camd:v2 . && \
docker rm -f srt-camd && \
docker run -d --name srt-camd --restart unless-stopped --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/deploy:/etc/srt-cam" \
  -v /var/lib/srt-cam:/var/lib/srt-cam \
  srt-camd:v2 --config /etc/srt-cam/config.json --events /etc/srt-cam/event-sheet.json
```

---

## 默认端口映射（模式 A）

推流端与拉流端均配置为 **Caller** 模式，在控制台「通道配置」或「工作台」页面可直接复制完整地址：

| 通道 | 推流地址（发端 → 服务器） | 拉流地址（服务器 → 收端） |
|---|---|---|
| `srt-cam1` | `srt://<服务器IP>:20001` | `srt://<服务器IP>:21001` |
| `srt-cam2` | `srt://<服务器IP>:20002` | `srt://<服务器IP>:21002` |
| `srt-cam3` | `srt://<服务器IP>:20003` | `srt://<服务器IP>:21003` |
| … | … | … |
| `srt-cam10` | `srt://<服务器IP>:20010` | `srt://<服务器IP>:21010` |

> 建议将推拉两端的 SRT Latency 设置为往返时延（RTT）的 4 倍以上，以保证丢包重传余量。

---

## 监控状态与参数说明

### 通道开关

- **流开关**：控制对应转发容器的运行状态。开启后锁定传输参数，关闭后停止容器并显示「已停止」。
- **断流告警**：控制无信号时是否按故障报红，以及是否发送飞书通知。关闭该开关时，无信号通道显示「待机」；只要通道处于通流状态，页面仍会如实显示「正常」「信号波动」「严重丢包」或「待拉流」。

### 状态标签

| 标签 | 含义 |
|---|---|
| `正常` | 推流与拉流稳定传输，无明显丢包或高延迟 |
| `待拉流` | 推流端已接入，尚未检测到拉流端连接 |
| `信号波动` | 链路存在重传丢包或 RTT 偏高，尚无未恢复弃包 |
| `严重丢包` | 存在超过缓冲窗口的未恢复弃包，接收端画面可能卡顿或花屏 |
| `备路接管` | 主备双路信号中一路异常，另一路正常在线 |
| `信号中断` | 已开启断流告警且当前无信号或通道异常 |
| `待机` | 容器运行中、未开启断流告警且当前无推流 |
| `已停止` | 流开关已关闭，转发容器处于停止状态 |

### 实时指标栏

- **码率**：当前实测 SRT 总传输码率（含音视频及协议封装开销）。
- **视频**：实时探测的视频分辨率、编码格式与帧率（如 `1920x1080 · H.264 · 50 fps`）。
- **音频**：实时探测的音频编码、采样率、音频码率与声道数（如 `AAC · 48k · 192k · 立体声`，多音轨显示 `×2`，仅视频无音频时提示 `无音轨`）。
- **丢包率**：正常显示 `0 (0.0%)`；可恢复丢包显示黄字数量与比例（如 `62 (3.8%)`）；未恢复弃包显示红字（如 `弃731 (36.3%)`）。
- **时延**：推流端至中转服务器的往返时延（RTT，单位 `ms`）。

---

## 常用运维命令

```bash
# 查看转发容器与控制面运行状态
docker ps --filter "name=srt-"

# 查看指定通道近期日志
docker logs --since 2m --tail 60 srt-cam1

# 查看控制面日志
docker logs --tail 60 srt-camd
```

---

## 本地离线预览

无需真实推流或远端服务器，可直接运行内置演示数据查看界面：

```bash
# 本地具备 Go 与 Node.js 环境
make demo

# 或使用 Docker 运行
docker build -f deploy/Dockerfile.camd -t srt-camd:v2 .
docker run --rm -p 8080:8080 -v "$PWD/deploy:/etc/srt-cam:ro" srt-camd:v2 \
  --demo --events /etc/srt-cam/event-sheet.example.json --listen 0.0.0.0:8080
```

启动后访问 `http://127.0.0.1:8080`。

---

## 补充文档与 v1 兼容

- **HTTPS 反向代理参考**：[`deploy/Caddyfile.example`](deploy/Caddyfile.example)
- **systemd 服务配置参考**：[`deploy/srt-camd.service`](deploy/srt-camd.service)
- **Makito X4 双节点无缝冗余部署指南**：[`docs/makito-redundancy-guide.md`](docs/makito-redundancy-guide.md)
- **配置文件示例**：[`deploy/config.example.json`](deploy/config.example.json)、[`deploy/event-sheet.example.json`](deploy/event-sheet.example.json)
- **v1 脚本兼容**：仓库保留原 v1 `install.sh`、`srt-status` 命令行诊断工具（旧端口 `21111–21120` / `11111–11120`）以及文档 [`docs/legacy-deployment.md`](docs/legacy-deployment.md)、[`docs/runbook.md`](docs/runbook.md)。已有 v1 节点可执行 `sudo bash install.sh --status-only` 单独安装诊断工具，不改动现有容器。
