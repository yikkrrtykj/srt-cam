package diagnosis

import (
	"strings"
	"testing"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

func defaultThresholds() config.ThresholdConfig {
	return config.DefaultNodeConfig().Thresholds
}

func TestDiagnoseChannelAllScenarios(t *testing.T) {
	th := defaultThresholds()
	cctx := ChannelContext{
		SignalName:     "OB-PGM",
		DirectionLabel: "上海制作中心 → 海外现场",
		Carrier:        "电信",
		SrcDevice:      "上海Encoder#1(主)",
		DstDevice:      "现场Decoder#1(主)",
		ExpectedActive: true,
		PrevRestarts:   0,
	}

	healthyHost := model.HostSample{NodeID: "vps-1", CPUPercent: 15, UDPRcvbufErrors: 0}

	cases := []struct {
		name      string
		sample    model.ChannelSample
		host      model.HostSample
		cctx      ChannelContext
		wantCode  model.FaultCode
		wantLayer string
	}{
		{
			name: "healthy relay",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true, PathMedium: "WAN",
				SrcConnected: true, SrcMbps: 12.0, SrcRTTMs: 45,
				DstConnected: true, DstMbps: 12.0, DstRTTMs: 52,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultHealthy, wantLayer: "none",
		},
		{
			name: "cloud container exited",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "exited", RestartCount: 2,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultCloudProcessDown, wantLayer: "cloud",
		},
		{
			name: "host udp buffer drops",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true,
				SrcMbps: 12.0, DstMbps: 12.0,
			},
			host: model.HostSample{NodeID: "vps-1", UDPRcvbufErrors: 45},
			cctx: cctx,
			wantCode: model.FaultCloudUDPBufDrop, wantLayer: "cloud",
		},
		{
			name: "upstream offline when expected active",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true,
				SrcMbps: 0, DstMbps: 0,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultUpstreamOffline, wantLayer: "upstream",
		},
		{
			name: "downstream offline while upstream healthy",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true,
				SrcMbps: 12.0, SrcRTTMs: 40, DstMbps: 0,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultDownstreamOffline, wantLayer: "downstream",
		},
		{
			name: "upstream congestion only",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true, PathMedium: "WAN",
				SrcMbps: 11.5, SrcRTTMs: 380, SrcDropped: 4,
				DstMbps: 11.5, DstRTTMs: 50, DstDropped: 0,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultUpstreamDegraded, wantLayer: "upstream",
		},
		{
			name: "downstream congestion only",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true, PathMedium: "WAN",
				SrcMbps: 12.0, SrcRTTMs: 35, SrcDropped: 0,
				DstMbps: 11.8, DstRTTMs: 410, DstDropped: 7,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultDownstreamDegraded, wantLayer: "downstream",
		},
		{
			name: "LO tunnel caution",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: true, PathMedium: "LO",
				SrcMbps: 12.0, SrcRTTMs: 12, DstMbps: 12.0, DstRTTMs: 15,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultTunnelLOWarning, wantLayer: "tunnel",
		},
		{
			name: "legacy container missing native stats not claimed loss-free",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay,
				ProcessState: "running", HasNativeStats: false, SrcConnected: true,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultNoNativeStats, wantLayer: "none",
		},
		{
			name: "Mode B passthrough healthy",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-pass1", Mode: model.ModeUDPPassthrough,
				ProcessState: "running", HasNativeStats: true, PathMedium: "WAN",
				SrcMbps: 15.0, SrcRetrans: 2, DstNAKCount: 1,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultHealthy, wantLayer: "none",
		},
		{
			name: "Mode B passthrough NAK spike",
			sample: model.ChannelSample{
				NodeID: "vps-1", ChannelID: "srt-pass1", Mode: model.ModeUDPPassthrough,
				ProcessState: "running", HasNativeStats: true, PathMedium: "WAN",
				SrcMbps: 15.0, SrcRetrans: 45, DstNAKCount: 30,
			},
			host: healthyHost, cctx: cctx,
			wantCode: model.FaultDownstreamDegraded, wantLayer: "downstream",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			code, layer, summary := DiagnoseChannel(tc.sample, tc.host, tc.cctx, th)
			if code != tc.wantCode || layer != tc.wantLayer {
				t.Fatalf("got (%s, %s, %q), want (%s, %s)", code, layer, summary, tc.wantCode, tc.wantLayer)
			}
			if summary == "" {
				t.Fatalf("expected non-empty summary")
			}
		})
	}
}

func TestEvaluateSignalGroupRedundancy(t *testing.T) {
	grp := config.SignalGroupConfig{
		ID:             "en-pgm",
		Name:           "EN-PGM",
		Direction:      model.DirectionVenueToHub,
		RedundancyType: model.RedundancyMakitoBonding,
		ExpectedActive: true,
	}

	// Primary offline, backup healthy -> DEGRADED_PROTECTED
	sev, summary, protector := EvaluateSignalGroup(grp, []model.LegLiveView{
		{
			Role: "primary", NodeID: "vps-1", ChannelID: "srt-pass1", Carrier: "电信", NodeOnline: true,
			Sample: model.ChannelSample{FaultCode: model.FaultUpstreamOffline, FaultSummary: "电信上行中断"},
		},
		{
			Role: "backup", NodeID: "vps-3", ChannelID: "srt-pass1", Carrier: "联通", NodeOnline: true,
			Sample: model.ChannelSample{FaultCode: model.FaultHealthy, FaultSummary: "联通正常"},
		},
	})
	if sev != model.SeverityDegradedProtected {
		t.Fatalf("severity = %s, want DEGRADED_PROTECTED", sev)
	}
	if !strings.Contains(protector, "联通") || !strings.Contains(summary, "零中断") {
		t.Fatalf("unexpected protected summary=%q protector=%q", summary, protector)
	}

	// Both legs offline -> CRITICAL_OUTAGE
	sev2, _, _ := EvaluateSignalGroup(grp, []model.LegLiveView{
		{
			Role: "primary", NodeID: "vps-1", ChannelID: "srt-pass1", Carrier: "电信", NodeOnline: false,
			Sample: model.ChannelSample{FaultCode: model.FaultNodeUnreachable, FaultSummary: "VPS-1 失联"},
		},
		{
			Role: "backup", NodeID: "vps-3", ChannelID: "srt-pass1", Carrier: "联通", NodeOnline: true,
			Sample: model.ChannelSample{FaultCode: model.FaultUpstreamOffline, FaultSummary: "联通中断"},
		},
	})
	if sev2 != model.SeverityCriticalOutage {
		t.Fatalf("severity2 = %s, want CRITICAL_OUTAGE", sev2)
	}
}
