package diagnosis

import (
	"fmt"
	"strings"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// ChannelContext provides static identity so status messages cite exact devices and carriers.
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
// and terse broadcast-operations status line without falsely treating missing stats as zero loss.
func DiagnoseChannel(
	sample model.ChannelSample,
	host model.HostSample,
	cctx ChannelContext,
	th config.ThresholdConfig,
) (model.FaultCode, string, string) {
	srcName := cctx.SrcDevice
	if srcName == "" {
		srcName = "发端"
	}
	dstName := cctx.DstDevice
	if dstName == "" {
		dstName = "收端"
	}
	tag := ""
	if cctx.Carrier != "" {
		tag = cctx.Carrier + " · "
	}

	// 1. Layer 2: Cloud process / container health
	if sample.ProcessState != "running" {
		return model.FaultCloudProcessDown, "cloud",
			fmt.Sprintf("%s进程异常 (%s / 重启 %d) · %s/%s",
				tag, sample.ProcessState, sample.RestartCount, sample.NodeID, sample.ChannelID)
	}
	if cctx.PrevRestarts >= 0 && sample.RestartCount > cctx.PrevRestarts {
		return model.FaultCloudProcessDown, "cloud",
			fmt.Sprintf("%s容器重启 (%d→%d) · %s/%s",
				tag, cctx.PrevRestarts, sample.RestartCount, sample.NodeID, sample.ChannelID)
	}
	if th.UDPBufDropTrigger > 0 && host.UDPRcvbufErrors >= th.UDPBufDropTrigger {
		return model.FaultCloudUDPBufDrop, "cloud",
			fmt.Sprintf("%s宿主 UDP 缓冲丢包 (+%d) · %s",
				tag, host.UDPRcvbufErrors, sample.NodeID)
	}

	minFlow := th.MinFlowMbps
	if minFlow <= 0 {
		minFlow = 0.10
	}

	// 2. Mode B (UDP Passthrough)
	if sample.Mode == model.ModeUDPPassthrough {
		if sample.SrcMbps < minFlow {
			if !cctx.ExpectedActive {
				return model.FaultIdleExpectedOff, "none", "待机"
			}
			return model.FaultUpstreamOffline, "upstream",
				fmt.Sprintf("%s入站无流 (0.00 Mb/s) · 透传正常 (0 重启) · 查 %s", tag, srcName)
		}
		if sample.DstNAKCount >= th.HighNAKLost || sample.SrcRetrans >= th.HighRetrans {
			return model.FaultDownstreamDegraded, "downstream",
				fmt.Sprintf("%s链路抖动 · %.2f Mb/s · 重传 %d / NAK %d",
					tag, sample.SrcMbps, sample.SrcRetrans, sample.DstNAKCount)
		}
		if strings.Contains(sample.PathMedium, "LO") {
			return model.FaultTunnelLOWarning, "tunnel",
				fmt.Sprintf("%sLO 代理 · %.2f Mb/s（SRT 统计不反映底层 TCP 抖动）", tag, sample.SrcMbps)
		}
		return model.FaultHealthy, "none",
			fmt.Sprintf("%s正常 · %.2f Mb/s · 重传 %d / NAK %d",
				tag, sample.SrcMbps, sample.SrcRetrans, sample.DstNAKCount)
	}

	// 3. Mode A (Dual-Caller SRT Relay)
	if !sample.HasNativeStats {
		if !cctx.ExpectedActive {
			return model.FaultIdleExpectedOff, "none", "待机"
		}
		if !sample.SrcConnected && !sample.DstConnected {
			return model.FaultUpstreamOffline, "upstream",
				fmt.Sprintf("%s无连接 · 容器正常 (0 重启) · 查 %s", tag, srcName)
		}
		return model.FaultNoNativeStats, "none",
			fmt.Sprintf("%s容器在线 · 未启用原生 SRT 统计（不代表零丢包）", tag)
	}

	upFlow := sample.SrcMbps >= minFlow
	downFlow := sample.DstMbps >= minFlow

	if !upFlow && !downFlow {
		if !cctx.ExpectedActive {
			return model.FaultIdleExpectedOff, "none", "待机"
		}
		return model.FaultUpstreamOffline, "upstream",
			fmt.Sprintf("%s入站无流 (0.00 Mb/s) · 中转正常 (0 重启) · 查 %s", tag, srcName)
	}

	if upFlow && !downFlow {
		return model.FaultDownstreamOffline, "downstream",
			fmt.Sprintf("%s出站无流 · 入站 %.2f Mb/s (%.0fms) 正常 · 查 %s",
				tag, sample.SrcMbps, sample.SrcRTTMs, dstName)
	}

	if !upFlow && downFlow {
		return model.FaultUpstreamOffline, "upstream",
			fmt.Sprintf("%s入站中断 (%.2f Mb/s) · 中转正常 (0 重启) · 查 %s",
				tag, sample.SrcMbps, srcName)
	}

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
			fmt.Sprintf("%s上行抖动 · RTT %.0fms / 丢包 %d / 重传 %d / 丢弃 %d · 下游正常",
				tag, sample.SrcRTTMs, sample.SrcLost, sample.SrcRetrans, sample.SrcDropped)
	}
	if downDegraded && !upDegraded {
		return model.FaultDownstreamDegraded, "downstream",
			fmt.Sprintf("%s下行抖动 · RTT %.0fms / 丢包 %d / 重传 %d / 丢弃 %d · 上游正常",
				tag, sample.DstRTTMs, sample.DstLost, sample.DstRetrans, sample.DstDropped)
	}
	if upDegraded && downDegraded {
		return model.FaultUpstreamDegraded, "upstream",
			fmt.Sprintf("%s双段抖动 · 上 RTT %.0fms(弃%d) / 下 RTT %.0fms(弃%d)",
				tag, sample.SrcRTTMs, sample.SrcDropped, sample.DstRTTMs, sample.DstDropped)
	}

	if strings.Contains(sample.PathMedium, "LO") {
		return model.FaultTunnelLOWarning, "tunnel",
			fmt.Sprintf("%sLO 代理 · 入 %.2f / 出 %.2f Mb/s（底层 TCP 可能掩盖丢包）",
				tag, sample.SrcMbps, sample.DstMbps)
	}

	return model.FaultHealthy, "none",
		fmt.Sprintf("%s正常 · 入 %.2f / 出 %.2f Mb/s · RTT %.0f/%.0f ms",
			tag, sample.SrcMbps, sample.DstMbps, sample.SrcRTTMs, sample.DstRTTMs)
}

// IsLegHealthy returns true if a leg is carrying healthy broadcast media.
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

// EvaluateSignalGroup aggregates primary & backup legs across VPS nodes into
// concise broadcast-operations severity, status text, and active backup identifier.
func EvaluateSignalGroup(
	grp config.SignalGroupConfig,
	legs []model.LegLiveView,
) (model.GroupSeverity, string, string) {
	if !grp.ExpectedActive {
		allHealthy := len(legs) > 0
		for _, leg := range legs {
			if !leg.NodeOnline || !IsLegHealthy(leg.Sample.FaultCode) {
				allHealthy = false
				break
			}
		}
		if allHealthy {
			return model.SeverityHealthy, "通流（未开启告警）", ""
		}
		return model.SeverityIdle, "待机", ""
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

	if len(healthyLegs) == len(legs) && len(legs) > 0 {
		if len(legs) >= 2 {
			return model.SeverityHealthy,
				fmt.Sprintf("主备在线 · %s %.1f / %s %.1f Mb/s",
					shortLegTag(legs[0]), legs[0].Sample.SrcMbps,
					shortLegTag(legs[1]), legs[1].Sample.SrcMbps),
				""
		}
		return model.SeverityHealthy, healthyLegs[0].Sample.FaultSummary, ""
	}

	if len(legs) >= 2 && len(healthyLegs) >= 1 {
		prot := healthyLegs[0]
		protector := shortLegTag(prot)
		var badParts []string
		for _, l := range append(outageLegs, degradedLegs...) {
			badParts = append(badParts, fmt.Sprintf("%s %s", shortLegTag(l), shortFault(l)))
		}
		return model.SeverityDegradedProtected,
			fmt.Sprintf("%s · %s 在线 (%.1f Mb/s)",
				strings.Join(badParts, "，"), protector, prot.Sample.SrcMbps),
			protector
	}

	if len(outageLegs) > 0 {
		if len(legs) >= 2 && len(outageLegs) == len(legs) {
			return model.SeverityCriticalOutage,
				fmt.Sprintf("主备中断 · %s %s / %s %s",
					shortLegTag(legs[0]), shortFault(legs[0]),
					shortLegTag(legs[1]), shortFault(legs[1])),
				""
		}
		if len(legs) == 1 {
			return model.SeverityCriticalOutage, outageLegs[0].Sample.FaultSummary, ""
		}
		return model.SeverityCriticalOutage,
			fmt.Sprintf("无健康备路 · %s %s，其余抖动",
				shortLegTag(outageLegs[0]), shortFault(outageLegs[0])),
			""
	}

	if len(degradedLegs) > 0 {
		return model.SeverityDegradedSingle, degradedLegs[0].Sample.FaultSummary, ""
	}

	return model.SeverityIdle, "无数据", ""
}

func shortLegTag(l model.LegLiveView) string {
	role := "主"
	if l.Role == "backup" {
		role = "备"
	} else if l.Role == "single" {
		role = "单"
	}
	if l.Carrier != "" {
		return fmt.Sprintf("%s(%s·%s)", role, l.NodeID, l.Carrier)
	}
	return fmt.Sprintf("%s(%s/%s)", role, l.NodeID, l.ChannelID)
}

func shortFault(l model.LegLiveView) string {
	if !l.NodeOnline {
		return "节点离线"
	}
	switch l.Sample.FaultCode {
	case model.FaultCloudProcessDown:
		return "进程异常"
	case model.FaultCloudUDPBufDrop:
		return "UDP丢包"
	case model.FaultUpstreamOffline:
		return "入站无流"
	case model.FaultDownstreamOffline:
		return "出站无流"
	case model.FaultUpstreamDegraded:
		return "上行抖动"
	case model.FaultDownstreamDegraded:
		return "下行抖动"
	case model.FaultNoNativeStats:
		return "无统计"
	default:
		return string(l.Sample.FaultCode)
	}
}
