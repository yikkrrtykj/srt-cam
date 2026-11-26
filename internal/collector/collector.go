package collector

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/diagnosis"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/passthrough"
)

// Collector gathers local host metrics, Mode A Docker/SRT stats, and Mode B srt-passd stats.
type Collector struct {
	cfg        config.NodeConfig
	docker     *DockerClient
	host       *HostCollector
	httpClient *http.Client

	mu           sync.Mutex
	prevRestarts map[string]int
	demoStart    time.Time
}

// New creates a Collector for the local VPS node.
func New(cfg config.NodeConfig) *Collector {
	return &Collector{
		cfg:          cfg,
		docker:       NewDockerClient(cfg.DockerSocket),
		host:         NewHostCollector(cfg.NodeID),
		httpClient:   &http.Client{Timeout: 2 * time.Second},
		prevRestarts: make(map[string]int),
		demoStart:    time.Now(),
	}
}

// RestartLocalChannel safely restarts a single local container by channel ID.
func (c *Collector) RestartLocalChannel(ctx context.Context, channelID string) error {
	if c.cfg.DemoMode {
		return nil
	}
	return c.docker.Restart(ctx, channelID, 5)
}

// CollectOnce gathers one synchronized snapshot of the local host and all local channels
// referenced in the event sheet (plus default srt-cam1..10 if configured locally).
func (c *Collector) CollectOnce(ctx context.Context, sheet config.EventSheet) (model.NodeLiveStatus, []model.ChannelSample) {
	if c.cfg.DemoMode {
		return c.collectDemo(sheet)
	}

	now := time.Now()
	hostSample := c.host.Sample()
	hostSample.Timestamp = now.Unix()

	// Build local channel lookup from event sheet
	type localLeg struct {
		grp config.SignalGroupConfig
		leg config.LegConfig
	}
	localLegs := make(map[string]localLeg)
	portsToCheck := make(map[int]bool)

	for _, grp := range sheet.SignalGroups {
		for _, leg := range grp.Legs {
			if leg.NodeID != c.cfg.NodeID {
				continue
			}
			localLegs[leg.ChannelID] = localLeg{grp: grp, leg: leg}
			if leg.InPort > 0 {
				portsToCheck[leg.InPort] = true
			}
			if leg.OutPort > 0 {
				portsToCheck[leg.OutPort] = true
			}
		}
	}

	// Ensure default srt-cam1..10 are still observable even if omitted from custom event sheet
	for i := 1; i <= 10; i++ {
		cid := fmt.Sprintf("srt-cam%d", i)
		if _, exists := localLegs[cid]; !exists {
			portsToCheck[21110+i] = true
			portsToCheck[11110+i] = true
			localLegs[cid] = localLeg{
				grp: config.SignalGroupConfig{ID: cid, Name: fmt.Sprintf("CAM%d", i), ExpectedActive: false},
				leg: config.LegConfig{
					Role:      "single",
					NodeID:    c.cfg.NodeID,
					ChannelID: cid,
					Mode:      model.ModeSRTRelay,
					InPort:    21110 + i,
					OutPort:   11110 + i,
				},
			}
		}
	}

	// Index Mode B metrics URLs by channel ID
	passTargets := make(map[string]config.PassTarget)
	for _, pt := range c.cfg.Passthroughs {
		passTargets[pt.ChannelID] = pt
	}

	udpPeers := InspectLocalUDPPeers(portsToCheck)
	channelsMap := make(map[string]model.ChannelSample, len(localLegs))
	samples := make([]model.ChannelSample, 0, len(localLegs))

	for cid, entry := range localLegs {
		var sample model.ChannelSample
		if entry.leg.Mode == model.ModeUDPPassthrough {
			sample = c.collectPassthrough(ctx, now, cid, passTargets[cid])
		} else {
			sample = c.collectRelay(ctx, now, cid, entry.leg, udpPeers)
		}

		c.mu.Lock()
		prevR, seen := c.prevRestarts[cid]
		if !seen {
			prevR = sample.RestartCount
		}
		c.prevRestarts[cid] = sample.RestartCount
		c.mu.Unlock()

		cctx := diagnosis.ChannelContext{
			SignalName:     entry.grp.Name,
			DirectionLabel: sheet.DirectionLabel(entry.grp.Direction),
			Carrier:        entry.leg.Carrier,
			SrcDevice:      entry.leg.SrcDevice,
			DstDevice:      entry.leg.DstDevice,
			ExpectedActive: entry.grp.ExpectedActive,
			PrevRestarts:   prevR,
		}
		code, layer, summary := diagnosis.DiagnoseChannel(sample, hostSample, cctx, c.cfg.Thresholds)
		sample.FaultCode = code
		sample.FaultLayer = layer
		sample.FaultSummary = summary

		channelsMap[cid] = sample
		samples = append(samples, sample)
	}

	status := model.NodeLiveStatus{
		NodeID:      c.cfg.NodeID,
		DisplayName: c.cfg.DisplayName,
		Region:      c.cfg.Region,
		PublicIP:    c.cfg.PublicIP,
		Online:      true,
		UpdatedAt:   now.Unix(),
		Host:        hostSample,
		Channels:    channelsMap,
	}
	return status, samples
}

func (c *Collector) collectRelay(
	ctx context.Context,
	now time.Time,
	cid string,
	leg config.LegConfig,
	udpPeers map[int]PortPeerInfo,
) model.ChannelSample {
	sample := model.ChannelSample{
		Timestamp:  now.Unix(),
		NodeID:     c.cfg.NodeID,
		ChannelID:  cid,
		Mode:       model.ModeSRTRelay,
		PathMedium: "-",
	}

	info, err := c.docker.Inspect(ctx, cid)
	if err != nil {
		sample.ProcessState = info.Status
		return sample
	}
	sample.ProcessState = info.Status
	sample.RestartCount = info.RestartCount
	if info.Running && !info.StartedAt.IsZero() {
		sample.UptimeSec = int64(now.Sub(info.StartedAt).Seconds())
	}

	if info.Running {
		logText, err := c.docker.RecentLogs(ctx, cid, 120, 400)
		if err == nil {
			parsed := ParseSRTLogs(logText, now, 20*time.Second)
			sample.HasNativeStats = parsed.HasNativeStats
			sample.SrcConnected = parsed.SrcConnected
			sample.SrcMbps = parsed.SrcMbps
			sample.SrcRTTMs = parsed.SrcRTTMs
			sample.SrcLost = parsed.SrcLost
			sample.SrcRetrans = parsed.SrcRetrans
			sample.SrcDropped = parsed.SrcDropped
			sample.SrcTSBPDMs = parsed.SrcTSBPDMs
			sample.SrcPeerIP = parsed.SrcPeerIP
			sample.DstConnected = parsed.DstConnected
			sample.DstMbps = parsed.DstMbps
			sample.DstRTTMs = parsed.DstRTTMs
			sample.DstLost = parsed.DstLost
			sample.DstRetrans = parsed.DstRetrans
			sample.DstDropped = parsed.DstDropped
			sample.DstPeerIP = parsed.DstPeerIP
			sample.PathMedium = parsed.PathMedium
		}
	}

	// Enhance LO/WAN detection from /proc/net/udp if available
	hasLO := sample.PathMedium == "LO" || sample.PathMedium == "WAN+LO"
	hasWAN := sample.PathMedium == "WAN" || sample.PathMedium == "WAN+LO"
	if p, ok := udpPeers[leg.InPort]; ok {
		if sample.SrcPeerIP == "" {
			sample.SrcPeerIP = p.PeerIP
		}
		if p.PathMedium == "LO" {
			hasLO = true
		} else {
			hasWAN = true
		}
	}
	if p, ok := udpPeers[leg.OutPort]; ok {
		if sample.DstPeerIP == "" {
			sample.DstPeerIP = p.PeerIP
		}
		if p.PathMedium == "LO" {
			hasLO = true
		} else {
			hasWAN = true
		}
	}
	switch {
	case hasWAN && hasLO:
		sample.PathMedium = "WAN+LO"
	case hasLO:
		sample.PathMedium = "LO"
	case hasWAN:
		sample.PathMedium = "WAN"
	}

	return sample
}

func (c *Collector) collectPassthrough(ctx context.Context, now time.Time, cid string, pt config.PassTarget) model.ChannelSample {
	sample := model.ChannelSample{
		Timestamp:  now.Unix(),
		NodeID:     c.cfg.NodeID,
		ChannelID:  cid,
		Mode:       model.ModeUDPPassthrough,
		PathMedium: "-",
	}

	// Optional container inspection if Mode B runs inside Docker
	if pt.Container != "" {
		if info, err := c.docker.Inspect(ctx, pt.Container); err == nil {
			sample.ProcessState = info.Status
			sample.RestartCount = info.RestartCount
			if info.Running && !info.StartedAt.IsZero() {
				sample.UptimeSec = int64(now.Sub(info.StartedAt).Seconds())
			}
		}
	}

	if pt.MetricsURL == "" {
		if sample.ProcessState == "" {
			sample.ProcessState = "not_configured"
		}
		return sample
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, pt.MetricsURL, nil)
	if err != nil {
		sample.ProcessState = "unreachable"
		return sample
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		if sample.ProcessState == "" || sample.ProcessState == "running" {
			sample.ProcessState = "metrics_unreachable"
		}
		return sample
	}
	defer resp.Body.Close()

	var snap passthrough.Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		sample.ProcessState = "invalid_metrics"
		return sample
	}

	sample.ProcessState = "running"
	sample.UptimeSec = snap.UptimeSec
	sample.HasNativeStats = true
	sample.Encrypted = snap.Encrypted
	sample.PathMedium = snap.PathMedium
	sample.SrcPeerIP = snap.PeerIP
	sample.DstPeerIP = snap.TargetAddr
	sample.SrcConnected = snap.State == "FLOW" || snap.State == "IDLE"
	sample.DstConnected = snap.State == "FLOW" || snap.LastDownstreamUnix > 0
	sample.SrcMbps = snap.UpstreamMbps
	sample.DstMbps = snap.UpstreamMbps // L4 passthrough forwards full media stream to decoder
	sample.SrcRetrans = int64(snap.RetransPackets)
	sample.DstNAKCount = int64(snap.NAKLostPackets)
	return sample
}

// collectDemo generates realistic bidirectional broadcast telemetry (including a periodic
// primary-path dip protected by a healthy backup path) for offline preview and UI testing.
func (c *Collector) collectDemo(sheet config.EventSheet) (model.NodeLiveStatus, []model.ChannelSample) {
	now := time.Now()
	elapsed := now.Sub(c.demoStart).Seconds()
	cycle := int(elapsed) % 120 // 2-minute demo loop

	hostSample := model.HostSample{
		Timestamp:       now.Unix(),
		NodeID:          c.cfg.NodeID,
		CPUPercent:      14.0 + 4.0*math.Sin(elapsed/15.0),
		MemPercent:      31.5,
		NetRxMbps:       48.2 + 2.1*math.Cos(elapsed/10.0),
		NetTxMbps:       48.0 + 2.0*math.Cos(elapsed/10.0),
		UDPRcvbufErrors: 0,
		Load1:           0.42,
	}

	channelsMap := make(map[string]model.ChannelSample)
	var samples []model.ChannelSample

	for idx, grp := range sheet.SignalGroups {
		for _, leg := range grp.Legs {
			if leg.NodeID != c.cfg.NodeID {
				continue
			}
			baseRate := 12.0 + float64(idx%4)*1.8
			jitter := 0.35 * math.Sin(elapsed/5.0+float64(idx))

			s := model.ChannelSample{
				Timestamp:      now.Unix(),
				NodeID:         c.cfg.NodeID,
				ChannelID:      leg.ChannelID,
				Mode:           leg.Mode,
				ProcessState:   "running",
				RestartCount:   0,
				UptimeSec:      86400*4 + int64(elapsed),
				HasNativeStats: true,
				Encrypted:      leg.Mode == model.ModeUDPPassthrough,
				PathMedium:     "WAN",
			}

			if grp.ExpectedActive {
				s.SrcConnected = true
				s.DstConnected = true
				s.SrcMbps = baseRate + jitter
				s.DstMbps = baseRate + jitter
				s.SrcRTTMs = 46.0 + 6.0*math.Sin(elapsed/7.0+float64(idx))
				s.DstRTTMs = 54.0 + 5.0*math.Cos(elapsed/9.0+float64(idx))
				s.SrcTSBPDMs = 250

				// Simulate a realistic 20s telecom primary dip on ob-pgm or en-pgm so user sees live failover!
				if (grp.ID == "en-pgm" || grp.ID == "ob-pgm") && leg.Role == "primary" && cycle >= 40 && cycle <= 62 {
					if grp.ID == "en-pgm" {
						s.SrcMbps = 0
						s.DstMbps = 0
						s.SrcConnected = false
					} else {
						s.DstRTTMs = 340.0 + 35.0*math.Sin(elapsed)
						s.DstLost = 38
						s.DstRetrans = 42
						s.DstDropped = 6
					}
				}
				if grp.ID == "map" && leg.Role == "primary" {
					s.PathMedium = "LO"
				}
			}

			cctx := diagnosis.ChannelContext{
				SignalName:     grp.Name,
				DirectionLabel: sheet.DirectionLabel(grp.Direction),
				Carrier:        leg.Carrier,
				SrcDevice:      leg.SrcDevice,
				DstDevice:      leg.DstDevice,
				ExpectedActive: grp.ExpectedActive,
				PrevRestarts:   0,
			}
			code, layer, summary := diagnosis.DiagnoseChannel(s, hostSample, cctx, c.cfg.Thresholds)
			s.FaultCode = code
			s.FaultLayer = layer
			s.FaultSummary = summary

			channelsMap[leg.ChannelID] = s
			samples = append(samples, s)
		}
	}

	return model.NodeLiveStatus{
		NodeID:      c.cfg.NodeID,
		DisplayName: c.cfg.DisplayName,
		Region:      c.cfg.Region,
		PublicIP:    c.cfg.PublicIP,
		Online:      true,
		UpdatedAt:   now.Unix(),
		Host:        hostSample,
		Channels:    channelsMap,
	}, samples
}
