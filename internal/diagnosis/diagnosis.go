package diagnosis

import (
	"fmt"
	"strings"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// ChannelContext provides static identity so attribution messages cite exact devices and carriers.
type ChannelContext struct {
	SignalName     string
	DirectionLabel string
	Carrier        string
	SrcDevice      string
	DstDevice      string
	ExpectedActive bool
	PrevRestarts   int
}

// DiagnoseChannel classifies a single channel sample into a deterministic FaultCode, FaultLayer,
// and leadership-ready Chinese FaultSummary without falsely treating missing stats as zero loss.
func DiagnoseChannel(
	sample model.ChannelSample,
	host model.HostSample,
	cctx ChannelContext,
	th config.ThresholdConfig,
) (model.FaultCode, string, string) {
	srcName := cctx.SrcDevice
	if srcName == "" {
		srcName = "发送端"
	}
	dstName := cctx.DstDevice
	if dstName == "" {
		dstName = "接收端"
	}
	carrierTag := ""
	if cctx.Carrier != "" {
		carrierTag = "[" + cctx.Carrier + "] "
	}

	// 1. Layer 2: Cloud process / container health first
	if sample.ProcessState != "running" {
		return model.FaultCloudProcessDown, "cloud",
			fmt.Sprintf("%s云端转发进程异常（状态：%s，累计重启 %d 次），请优先排查云端节点 %s 容器 %s",
				carrierTag, sample.ProcessState, sample.RestartCount, sample.NodeID, sample.ChannelID)
	}
	if cctx.PrevRestarts >= 0 && sample.RestartCount > cctx.PrevRestarts {
		return model.FaultCloudProcessDown, "cloud",
			fmt.Sprintf("%s云端通道容器 %s 发生重启（重启次数 %d → %d），请检查云端日志与宿主机资源",
				carrierTag, sample.ChannelID, cctx.PrevRestarts, sample.RestartCount)
	}
	if th.UDPBufDropTrigger > 0 && host.UDPRcvbufErrors >= th.UDPBufDropTrigger {
		return model.FaultCloudUDPBufDrop, "cloud",
			fmt.Sprintf("%s云端宿主机 %s 出现内核 UDP 缓冲区丢包（+%d 包），疑似主机网络/CPU 过载",
				carrierTag, sample.NodeID, host.UDPRcvbufErrors)
	}

	minFlow := th.MinFlowMbps
	if minFlow <= 0 {
		minFlow = 0.10
	}

	// 2. Mode B (UDP Passthrough) branch
	if sample.Mode == model.ModeUDPPassthrough {
		upFlow := sample.SrcMbps >= minFlow
		if !upFlow {
			if !cctx.ExpectedActive {
				return model.FaultIdleExpectedOff, "none", "未勾选开播（待机/空闲）"
			}
			return model.FaultUpstreamOffline, "upstream",
				fmt.Sprintf("%s云端透传运行正常（0 重启），但未收到来自【%s】的上行流（0 Mbps）→ 判定为发端未推流或发端至云端上行中断",
					carrierTag, srcName)
		}
		if sample.DstNAKCount >= th.HighNAKLost || sample.SrcRetrans >= th.HighRetrans {
			return model.FaultDownstreamDegraded, "downstream",
				fmt.Sprintf("%s云端透传正常（%.2f Mbps），但检测到 SRT 重传/丢包激增（重传 %d 包，解码端 NAK 报丢 %d 包）→ 判定为跨网路径抖动/丢包",
					carrierTag, sample.SrcMbps, sample.SrcRetrans, sample.DstNAKCount)
		}
		if strings.Contains(sample.PathMedium, "LO") {
			return model.FaultTunnelLOWarning, "tunnel",
				fmt.Sprintf("%s透传流量正常（%.2f Mbps），但经由本机回环代理（LO），底层隧道可能掩盖真实网络抖动",
					carrierTag, sample.SrcMbps)
		}
		return model.FaultHealthy, "none",
			fmt.Sprintf("%s透传链路健康（%.2f Mbps，重传 %d，NAK %d，云端 0 重启）",
				carrierTag, sample.SrcMbps, sample.SrcRetrans, sample.DstNAKCount)
	}

	// 3. Mode A (Dual-Caller SRT Relay) branch
	if !sample.HasNativeStats {
		if !cctx.ExpectedActive {
			return model.FaultIdleExpectedOff, "none", "未勾选开播（旧容器未开启原生 SRT 统计）"
		}
		if !sample.SrcConnected && !sample.DstConnected {
			return model.FaultUpstreamOffline, "upstream",
				fmt.Sprintf("%s云端容器运行正常（0 重启），未检测到原生 SRT 统计且无活跃连接 → 请核查【%s】推流状态及容器是否已启用 -stats",
					carrierTag, srcName)
		}
		return model.FaultNoNativeStats, "none",
			fmt.Sprintf("%s容器运行正常（0 重启），但当前未收到原生 SRT JSON 统计（可能空闲或旧镜像未开启 -stats），不代表零丢包",
				carrierTag)
	}

	upFlow := sample.SrcMbps >= minFlow
	downFlow := sample.DstMbps >= minFlow

	// Neither side has media flow
	if !upFlow && !downFlow {
		if !cctx.ExpectedActive {
			return model.FaultIdleExpectedOff, "none", "未勾选开播（待机/空闲）"
		}
		return model.FaultUpstreamOffline, "upstream",
			fmt.Sprintf("%s云端中转正常（0 重启），但上游入站（%s）码率跌至 %.2f Mbps → 判定为【%s】未推流或发端至云端网络中断",
				carrierTag, sample.ChannelID, sample.SrcMbps, srcName)
	}

	// Upstream OK, downstream missing
	if upFlow && !downFlow {
		return model.FaultDownstreamOffline, "downstream",
			fmt.Sprintf("%s上游入站稳定（%.2f Mbps，RTT %.0fms）且云端 0 重启，但下游出站为 %.2f Mbps → 判定为【%s】未拉流或云端至收端链路中断",
				carrierTag, sample.SrcMbps, sample.SrcRTTMs, sample.DstMbps, dstName)
	}

	// Downstream flow reported without upstream (rare stale target stats while source just dropped)
	if !upFlow && downFlow {
		return model.FaultUpstreamOffline, "upstream",
			fmt.Sprintf("%s云端运行正常（0 重启）且下游仍在拉流，但上游入站跌至 %.2f Mbps → 判定为【%s】推流中断或上行链路断线",
				carrierTag, sample.SrcMbps, srcName)
	}

	// Both sides flowing: check congestion / drops per hop
	upDegraded := sample.SrcRTTMs >= th.HighRTTMs ||
		sample.SrcDropped > 0 ||
		sample.SrcLost >= th.HighLossPerSample ||
		sample.SrcRetrans >= th.HighRetrans

	downDegraded := sample.DstRTTMs >= th.HighRTTMs ||
		sample.DstDropped > 0 ||
		sample.DstLost >= th.HighLossPerSample ||
		sample.DstRetrans >= th.HighRetrans

	if upDegraded && !downDegraded {
		return model.FaultUpstreamDegraded, "upstream",
			fmt.Sprintf("%s发端→云端段网络恶化（上游 RTT %.0fms / 丢包 %d / 重传 %d / 丢弃 %d），云端 0 重启且下游正常 → 归因上游【%s】方向链路",
				carrierTag, sample.SrcRTTMs, sample.SrcLost, sample.SrcRetrans, sample.SrcDropped, srcName)
	}
	if downDegraded && !upDegraded {
		return model.FaultDownstreamDegraded, "downstream",
			fmt.Sprintf("%s上游与云端正常（上游 %.2f Mbps / RTT %.0fms），但云端→收端段恶化（下游 RTT %.0fms / 丢包 %d / 重传 %d / 丢弃 %d）→ 归因下游【%s】方向链路",
				carrierTag, sample.SrcMbps, sample.SrcRTTMs, sample.DstRTTMs, sample.DstLost, sample.DstRetrans, sample.DstDropped, dstName)
	}
	if upDegraded && downDegraded {
		return model.FaultUpstreamDegraded, "upstream",
			fmt.Sprintf("%s上下游均出现抖动（上游 RTT %.0fms 丢弃 %d；下游 RTT %.0fms 丢弃 %d），请同时核查双段公网与云端带宽",
				carrierTag, sample.SrcRTTMs, sample.SrcDropped, sample.DstRTTMs, sample.DstDropped)
	}

	// LO tunnel caution when flow is healthy on SRT layer
	if strings.Contains(sample.PathMedium, "LO") {
		return model.FaultTunnelLOWarning, "tunnel",
			fmt.Sprintf("%s收发流量正常（入 %.2f / 出 %.2f Mbps），但链路经由本机回环代理（LO），底层 TCP 隧道可能掩盖丢包并引入延迟抖动",
				carrierTag, sample.SrcMbps, sample.DstMbps)
	}

	return model.FaultHealthy, "none",
		fmt.Sprintf("%s链路健康（入 %.2f / 出 %.2f Mbps，上游 RTT %.0fms，下游 RTT %.0fms，云端 0 重启）",
			carrierTag, sample.SrcMbps, sample.DstMbps, sample.SrcRTTMs, sample.DstRTTMs)
}

// IsLegHealthy returns true if a leg is carrying healthy broadcast media (or LO-flowing without drops).
func IsLegHealthy(code model.FaultCode) bool {
	return code == model.FaultHealthy || code == model.FaultTunnelLOWarning
}

// IsLegHardOutage returns true if the leg has lost media delivery or process/node availability.
func IsLegHardOutage(code model.FaultCode) bool {
	switch code {
	case model.FaultCloudProcessDown,
		model.FaultUpstreamOffline,
		model.FaultDownstreamOffline,
		model.FaultNodeUnreachable:
		return true
	default:
		return false
	}
}

// EvaluateSignalGroup aggregates primary & backup legs across multiple VPS nodes into
// one executive severity, summary, and protection attribution.
func EvaluateSignalGroup(
	grp config.SignalGroupConfig,
	legs []model.LegLiveView,
) (model.GroupSeverity, string, string) {
	if !grp.ExpectedActive {
		// Still report healthy if someone is actively testing an unchecked channel
		allHealthy := len(legs) > 0
		for _, leg := range legs {
			if !leg.NodeOnline || !IsLegHealthy(leg.Sample.FaultCode) {
				allHealthy = false
				break
			}
		}
		if allHealthy {
			return model.SeverityHealthy, "测试/未勾选通道当前正常通流", ""
		}
		return model.SeverityIdle, "本场未勾选开播（待机不告警）", ""
	}

	var healthyLegs []model.LegLiveView
	var degradedLegs []model.LegLiveView
	var outageLegs []model.LegLiveView

	for _, leg := range legs {
		if !leg.NodeOnline {
			outageLegs = append(outageLegs, leg)
			continue
		}
		code := leg.Sample.FaultCode
		switch {
		case IsLegHealthy(code):
			healthyLegs = append(healthyLegs, leg)
		case IsLegHardOutage(code):
			outageLegs = append(outageLegs, leg)
		default:
			degradedLegs = append(degradedLegs, leg)
		}
	}

	// All legs healthy
	if len(healthyLegs) == len(legs) && len(legs) > 0 {
		if len(legs) >= 2 {
			return model.SeverityHealthy, "主备双路全部正常通流，冗余保护就绪", ""
		}
		return model.SeverityHealthy, healthyLegs[0].Sample.FaultSummary, ""
	}

	// Multi-leg group where at least one leg is still healthy -> PROTECTED FAILOVER!
	if len(legs) >= 2 && len(healthyLegs) >= 1 {
		protector := formatLegRef(healthyLegs[0])
		var badDesc []string
		for _, l := range append(outageLegs, degradedLegs...) {
			badDesc = append(badDesc, fmt.Sprintf("%s(%s)", formatLegRef(l), shortFault(l)))
		}
		modeNote := "备路正常兜底，未断播"
		if grp.RedundancyType == model.RedundancyMakitoBonding {
			modeNote = "Makito 硬件双路无缝兜底，画面零中断"
		}
		return model.SeverityDegradedProtected,
			fmt.Sprintf("单路异常：%s；由 %s 持续正常承载（%s）", strings.Join(badDesc, "、"), protector, modeNote),
			protector
	}

	// Single leg or ALL legs in trouble
	if len(outageLegs) > 0 {
		if len(legs) >= 2 && len(outageLegs) == len(legs) {
			return model.SeverityCriticalOutage,
				fmt.Sprintf("主备双路同时中断！主：%s；备：%s", legs[0].Sample.FaultSummary, legs[1].Sample.FaultSummary),
				""
		}
		if len(legs) == 1 {
			return model.SeverityCriticalOutage, outageLegs[0].Sample.FaultSummary, ""
		}
		// One outage + one degraded (no healthy backup)
		return model.SeverityCriticalOutage,
			fmt.Sprintf("主备均不健康且无完整健康备路（%s 断流，其余路抖动）", formatLegRef(outageLegs[0])),
			""
	}

	// Only degraded legs (still flowing, high RTT/loss)
	if len(degradedLegs) > 0 {
		return model.SeverityDegradedSingle, degradedLegs[0].Sample.FaultSummary, ""
	}

	return model.SeverityIdle, "暂无可用通道数据", ""
}

func formatLegRef(l model.LegLiveView) string {
	role := "主路"
	if l.Role == "backup" {
		role = "备路"
	} else if l.Role == "single" {
		role = "单路"
	}
	carrier := l.Carrier
	if carrier != "" {
		return fmt.Sprintf("%s[%s/%s]", role, l.NodeID, carrier)
	}
	return fmt.Sprintf("%s[%s/%s]", role, l.NodeID, l.ChannelID)
}

func shortFault(l model.LegLiveView) string {
	if !l.NodeOnline {
		return "节点失联"
	}
	switch l.Sample.FaultCode {
	case model.FaultCloudProcessDown:
		return "云端进程异常"
	case model.FaultCloudUDPBufDrop:
		return "宿主机UDP丢包"
	case model.FaultUpstreamOffline:
		return "上游中断"
	case model.FaultDownstreamOffline:
		return "下游未拉流"
	case model.FaultUpstreamDegraded:
		return "上游拥塞"
	case model.FaultDownstreamDegraded:
		return "下游拥塞"
	case model.FaultNoNativeStats:
		return "无原生统计"
	default:
		return string(l.Sample.FaultCode)
	}
}
