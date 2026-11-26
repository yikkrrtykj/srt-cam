# Makito X4 双向无缝主备（Path Redundancy）配置与拔线验收手册

本手册面向**此前仅配过单路 SRT、首次搭双路无缝切换**的现场工程同学，配合本项目 Mode B（[`cmd/srt-passd`](../cmd/srt-passd/main.go)）与双 VPS 节点完成“**防现场宽带中断 + 防单台云服务器/国际出口中断**”的零丢帧传输。

---

## 一、 先记住两条铁律

1. **双向角色铁律：谁是解码器，谁就做 Listener；谁是编码器，谁就做 Caller。**
   - **现场 → 制作中心**：现场 Makito 编码器（Caller, Active-Active）→ VPS-A & VPS-B 纯四层透传 → 制作中心 Makito 解码器（Listener, 开 2 个映射端口）
   - **制作中心 → 现场**：制作中心 Makito 编码器（Caller, Active-Active）→ VPS-A & VPS-B 纯四层透传 → 现场 Makito 解码器（Listener, 开 2 个映射端口）
2. **来不及配防火墙映射时不要硬上 Mode B**：如果某场次现场实在来不及做路由器 UDP 端口映射，或者临时换成了 vMix，该通道直接切回 **Mode A（现有 `2111x / 1111x` 双端 Call 云端）** 即可，两套模式可在同一台 VPS 并存。

---

## 二、 拓扑与端口规划（以单方向 1 路信号为例）

```text
[Makito X4 编码器 (Caller, Path Redundancy = Active-Active / Broadcast)]
   ├── Path 1 (网卡1/电信宽带) ──► VPS-A:31111 (srt-passd) ──► 解码端公网IP:41111 ──┐
   └── Path 2 (网卡2/联通宽带) ──► VPS-B:31111 (srt-passd) ──► 解码端公网IP:41112 ──┴─► [Makito X4 解码器 (Listener)]
```

> 若解码端机房也有电信/联通两条公网 IP，则 Path 1 转发到 `解码端公网IP-1:41111`，Path 2 转发到 `解码端公网IP-2:41112`，连机房侧宽带也做到全物理隔离。

---

## 三、 四步配置清单（建议先在测试 VPS 跑通）

### 第 1 步：解码端路由器 / 防火墙放行 2 个 UDP 端口
- 将解码端公网 IP 的 **UDP `41111`** 与 **UDP `41112`** 映射到 Makito X4 解码器内网 IP 的 `41111` 与 `41112`。
- 强烈建议在防火墙上做源 IP 白名单，**仅允许 VPS-A 和 VPS-B 的公网 IP 访问**。

### 第 2 步：在 VPS-A 和 VPS-B 启动独立的 `srt-passd`（纯四层 UDP 透传）
两台云主机放行入站 UDP `31111`，分别启动（每路独立容器/进程，互不影响）：

```bash
# VPS-A（主路·电信优化节点）
srt-passd \
  --id=srt-pass1 \
  --listen=:31111 \
  --target=<解码端公网IP-1>:41111 \
  --metrics=127.0.0.1:19101

# VPS-B（备路·联通优化节点）
srt-passd \
  --id=srt-pass1 \
  --listen=:31111 \
  --target=<解码端公网IP-2或同IP>:41112 \
  --metrics=127.0.0.1:19101
```

在两台 VPS 的 `config.json` 中登记 `passthroughs` 指向 `http://127.0.0.1:19101/stats`，并在 `event-sheet.json` 中将两台节点的 `srt-pass1` 绑定到同一个逻辑信号组（`redundancy_type: "makito_bonding"`）。

### 第 3 步：配置 Makito X4 解码器（Listener + 路径冗余）
在 Makito X4 Decoder 网页后台 → **Streams** → 新建/编辑流：
1. **Protocol**：`TS over SRT`
2. **Mode**：`Listener`
3. **Port**：`41111`
4. **Path Redundancy（路径冗余）**：勾选开启
   - **Redundant Port**：`41112`（如有双网卡可分别绑定到不同网卡/子网）
5. **Latency**：设为 **`4 × 较慢那条路径的 RTT`** 再留出余量（例如电信 RTT 60ms、联通 RTT 110ms，则 Latency 至少设为 **`500ms`**，确保两条路到达时间差落在去重缓冲窗内！）
6. **Encryption / Passphrase**：与编码器保持一致（开启 AES-128/256 完全不影响 `srt-passd` 透传和监控统计）。

### 第 4 步：配置 Makito X4 编码器（Caller + Active-Active 广播双发）
在 Makito X4 Encoder 网页后台 → **Outputs** → 新建/编辑输出：
1. **Protocol**：`TS over SRT`
2. **Mode**：`Caller`
3. **Destination Address / Port（主路 Path 1）**：`<VPS-A 公网IP>` / `31111`
4. **Path Redundancy**：选择 **`Active-Active`（Broadcast 双发去重）**
   - **Redundant Address / Port（备路 Path 2）**：`<VPS-B 公网IP>` / `31111`
   - 若编码器有双网卡接不同宽带，**必须检查静态路由 / 网卡绑定**，确保去往 `VPS-A` 走宽带 1、去往 `VPS-B` 走宽带 2（否则两条流挤同一根网线等于没做宽带冗余！）。
5. **Latency & Passphrase**：与解码器完全一致。

---

## 四、 上线前必做的 4 项拔线验收清单

在正式开播前，务必在测试 VPS 上带 SDI 监看画面（推荐用带秒表/运动条的测试信号）依次做完以下 4 项测试：

| 序号 | 测试动作 | 预期画面表现 | 预期监控看板 & 飞书表现 |
| :---: | :--- | :--- | :--- |
| **1** | **正常双发运行 3 分钟** | 画面稳定，解码器后台显示两条 Path 均为 Connected | 看板 `EN-PGM` 显示绿色「正常」，VPS-A 与 VPS-B 入站码率均与编码码率一致 |
| **2** | **直接拔掉编码端宽带 1 网线** | **零黑屏、零花屏、音频无爆音** | 10 秒防抖后收到 **🟡 飞书降级卡片（单路异常，Makito 硬件无缝兜底）**；4 层时间轴可见主路跌至 0、备路全程平稳绿线、云端 0 重启 |
| **3** | **插回宽带 1，等恢复后再手动停掉 VPS-A 的 `srt-passd`** | **零黑屏、零花屏**（验证云主机宕机兜底） | 看板标红 VPS-A 通道进程异常，备路 VPS-B 继续正常兜底；点击「证据截图模式」确认可一屏导出清晰定责图 |
| **4** | **拉起 VPS-A 并重启控制面 `srt-camd`** | **全程直播零中断**（验证控制面与数据面彻底隔离） | 约 3 秒后网页自动重连 SSE，SQLite 历史曲线与事件记录完整保留 |
