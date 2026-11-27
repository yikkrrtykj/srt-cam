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

	mu            sync.Mutex
	prevRestarts  map[string]int
	cursors       map[string]ParseCursors
	lastSrcPeerIP map[string]string
	lastDstPeerIP map[string]string
	demoStopped   map[string]bool
	demoStart     time.Time
}

// New creates a Collector for the local VPS node.
func New(cfg config.NodeConfig) *Collector {
	return &Collector{
		cfg:           cfg,
		docker:        NewDockerClient(cfg.DockerSocket),
		host:          NewHostCollector(cfg.NodeID),
		httpClient:    &http.Client{Timeout: 2 * time.Second},
		prevRestarts:  make(map[string]int),
		cursors:       make(map[string]ParseCursors),
		lastSrcPeerIP: make(map[string]string),
		lastDstPeerIP: make(map[string]string),
		demoStopped:   make(map[string]bool),
		demoStart:     time.Now(),
	}
}

// UpdateThresholds hot-reloads diagnostic thresholds safely from the web alert settings page.
func (c *Collector) UpdateThresholds(th config.ThresholdConfig) {
	c.mu.Lock()
	c.cfg.Thresholds = th
	c.mu.Unlock()
}

// UpdateLocalMeta hot-reloads display_name, region, and public_ip safely from the web UI.
func (c *Collector) UpdateLocalMeta(displayName, region, publicIP string) {
	c.mu.Lock()
	c.cfg.DisplayName = displayName
	c.cfg.Region = region
	c.cfg.PublicIP = publicIP
	c.mu.Unlock()
}

func (c *Collector) localMeta() (displayName, region, publicIP string) {
	c.mu.Lock()
	displayName = c.cfg.DisplayName
	region = c.cfg.Region
	publicIP = c.cfg.PublicIP
	c.mu.Unlock()
	return
}

func (c *Collector) currentThresholds() config.ThresholdConfig {
	c.mu.Lock()
	th := c.cfg.Thresholds
	c.mu.Unlock()
	return th
}

// RestartLocalChannel safely restarts a single local container by channel ID.
func (c *Collector) RestartLocalChannel(ctx context.Context, channelID string) error {
	if c.cfg.DemoMode {
		return nil
	}
	return c.docker.Restart(ctx, channelID, 5)
}

// SetLocalChannelPower starts or stops a single local channel container.
func (c *Collector) SetLocalChannelPower(ctx context.Context, channelID string, start bool) error {
	if c.cfg.DemoMode {
		c.mu.Lock()
		if start {
			delete(c.demoStopped, channelID)
		} else {
			c.demoStopped[channelID] = true
		}
		c.mu.Unlock()
		return nil
	}
	if start {
		return c.docker.Start(ctx, channelID)
	}
	return c.docker.Stop(ctx, channelID, 5)
}

// ChannelLogs fetches recent timestamped container stdout/stderr logs for one local channel.
func (c *Collector) ChannelLogs(ctx context.Context, channelID string, sinceSec, tail int) (string, error) {
	if sinceSec <= 0 {
		sinceSec = 1800
	}
	if tail <= 0 {
		tail = 300
	}
	if tail > 1000 {
		tail = 1000
	}
	if c.cfg.DemoMode {
		return demoLogsText(c.cfg.NodeID, channelID, time.Now()), nil
	}
	return c.docker.RecentLogs(ctx, channelID, sinceSec, tail)
}

func demoLogsText(nodeID, channelID string, now time.Time) string {
	t := func(offsetSec int) string {
		return now.Add(-time.Duration(offsetSec) * time.Second).UTC().Format(time.RFC3339)
	}
	if len(channelID) >= 8 && channelID[:8] == "srt-pass" {
		return fmt.Sprintf(`%s [srt-passd:%s] listening UDP :31111 -> 203.0.113.10:41111 (metrics http://127.0.0.1:19101/stats)
%s [srt-passd:%s] SRT handshake observed from 198.51.100.41:52104 (AES encrypted payload passthrough)
%s [srt-passd:%s] FLOW up=12.14Mb/s retrans=2 nak=2 drop_req=0 peer=198.51.100.41 medium=WAN
%s [srt-passd:%s] WARN DropReq observed drop_req=2 retrans=24 nak=16 node=%s peer=198.51.100.41
%s [srt-passd:%s] WARN upstream silent (>5s) node=%s peer=198.51.100.41
%s [srt-passd:%s] SRT handshake observed from 198.51.100.41:52988 (reconnected)
%s [srt-passd:%s] FLOW up=12.18Mb/s retrans=1 nak=0 drop_req=0 peer=198.51.100.41 medium=WAN`,
			t(1200), channelID,
			t(1195), channelID,
			t(600), channelID,
			t(495), channelID, nodeID,
			t(480), channelID, nodeID,
			t(358), channelID,
			t(10), channelID,
		)
	}
	return fmt.Sprintf(`%s Media path: 'srt://:21115?rcvbuf=33554432' --> 'srt://:11115?rcvbuf=33554432'
%s Accepted SRT source connection from 198.51.100.21:54312
%s Accepted SRT target connection from 203.0.113.45:61204
%s {"sid":101,"link":{"rtt":46.2},"recv":{"packets":1500,"packetsLost":0,"packetsRetransmitted":0,"packetsDropped":0,"msTsbPdDelay":250,"mbitRate":12.1},"send":{"packets":0}}
%s {"sid":202,"link":{"rtt":53.8},"recv":{"packets":0},"send":{"packets":1500,"packetsLost":0,"packetsRetransmitted":0,"packetsDropped":0,"mbitRate":12.1}}
%s SND-DROPPED: 7 packets dropped on target socket (rtt=380ms, node=%s)
%s {"sid":202,"link":{"rtt":381.4},"recv":{"packets":0},"send":{"packets":1500,"packetsLost":44,"packetsRetransmitted":48,"packetsDropped":7,"mbitRate":11.8}}
%s {"sid":101,"link":{"rtt":45.1},"recv":{"packets":1500,"packetsLost":0,"packetsRetransmitted":0,"packetsDropped":0,"msTsbPdDelay":250,"mbitRate":12.2},"send":{"packets":0}}
%s {"sid":202,"link":{"rtt":52.9},"recv":{"packets":0},"send":{"packets":1500,"packetsLost":0,"packetsRetransmitted":1,"packetsDropped":0,"mbitRate":12.2}}`,
		t(1400),
		t(1395),
		t(1394),
		t(600),
		t(599),
		t(460), nodeID,
		t(458),
		t(12),
		t(10),
	)
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
			portsToCheck[20000+i] = true
			portsToCheck[21000+i] = true
			localLegs[cid] = localLeg{
				grp: config.SignalGroupConfig{ID: cid, Name: fmt.Sprintf("CAM%d", i), ExpectedActive: false},
				leg: config.LegConfig{
					Role:      "single",
					NodeID:    c.cfg.NodeID,
					ChannelID: cid,
					Mode:      model.ModeSRTRelay,
					InPort:    20000 + i,
					OutPort:   21000 + i,
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
			StreamDisabled: !entry.grp.IsEnabled(),
			ExpectedActive: entry.grp.ExpectedActive,
			PrevRestarts:   prevR,
		}
		code, layer, summary := diagnosis.DiagnoseChannel(sample, hostSample, cctx, c.currentThresholds())
		sample.FaultCode = code
		sample.FaultLayer = layer
		sample.FaultSummary = summary

		channelsMap[cid] = sample
		samples = append(samples, sample)
	}

	displayName, region, publicIP := c.localMeta()
	status := model.NodeLiveStatus{
		NodeID:      c.cfg.NodeID,
		DisplayName: displayName,
		Region:      region,
		PublicIP:    publicIP,
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
			c.mu.Lock()
			prevCur := c.cursors[cid]
			cachedSrcIP := c.lastSrcPeerIP[cid]
			cachedDstIP := c.lastDstPeerIP[cid]
			c.mu.Unlock()

			parsed := ParseSRTLogsWithCursors(logText, now, 30*time.Second, prevCur)

			c.mu.Lock()
			nextCur := prevCur
			if !parsed.SrcLastTS.IsZero() && parsed.SrcLastTS.After(nextCur.SrcStatsTS) {
				nextCur.SrcStatsTS = parsed.SrcLastTS
			}
			if !parsed.DstLastTS.IsZero() && parsed.DstLastTS.After(nextCur.DstStatsTS) {
				nextCur.DstStatsTS = parsed.DstLastTS
			}
			if !parsed.SrcConnLastTS.IsZero() && parsed.SrcConnLastTS.After(nextCur.SrcConnTS) {
				nextCur.SrcConnTS = parsed.SrcConnLastTS
			}
			if !parsed.DstConnLastTS.IsZero() && parsed.DstConnLastTS.After(nextCur.DstConnTS) {
				nextCur.DstConnTS = parsed.DstConnLastTS
			}
			c.cursors[cid] = nextCur

			if !parsed.SrcConnected {
				delete(c.lastSrcPeerIP, cid)
				cachedSrcIP = ""
			} else if parsed.SrcPeerIP != "" {
				c.lastSrcPeerIP[cid] = parsed.SrcPeerIP
				cachedSrcIP = parsed.SrcPeerIP
			}
			if !parsed.DstConnected {
				delete(c.lastDstPeerIP, cid)
				cachedDstIP = ""
			} else if parsed.DstPeerIP != "" {
				c.lastDstPeerIP[cid] = parsed.DstPeerIP
				cachedDstIP = parsed.DstPeerIP
			}
			c.mu.Unlock()

			sample.HasNativeStats = parsed.HasNativeStats
			sample.SrcConnected = parsed.SrcConnected
			sample.SrcMbps = parsed.SrcMbps
			sample.SrcRTTMs = parsed.SrcRTTMs
			sample.SrcPackets = parsed.SrcPackets
			sample.SrcLost = parsed.SrcLost
			sample.SrcRetrans = parsed.SrcRetrans
			sample.SrcDropped = parsed.SrcDropped
			sample.SrcBelated = parsed.SrcBelated
			sample.SrcBytes = parsed.SrcBytes
			sample.SrcBufMs = parsed.SrcBufMs
			sample.SrcTSBPDMs = parsed.SrcTSBPDMs
			sample.SrcLinkBWMbps = parsed.SrcLinkBWMbps
			sample.SrcMaxBWMbps = parsed.SrcMaxBWMbps
			sample.SrcReconnects = parsed.SrcReconnects
			sample.SrcPeerIP = parsed.SrcPeerIP
			if sample.SrcPeerIP == "" && parsed.SrcConnected {
				sample.SrcPeerIP = cachedSrcIP
			}
			sample.DstConnected = parsed.DstConnected
			sample.DstMbps = parsed.DstMbps
			sample.DstRTTMs = parsed.DstRTTMs
			sample.DstPackets = parsed.DstPackets
			sample.DstLost = parsed.DstLost
			sample.DstRetrans = parsed.DstRetrans
			sample.DstDropped = parsed.DstDropped
			sample.DstBytes = parsed.DstBytes
			sample.DstBufMs = parsed.DstBufMs
			sample.DstLinkBWMbps = parsed.DstLinkBWMbps
			sample.DstMaxBWMbps = parsed.DstMaxBWMbps
			sample.DstReconnects = parsed.DstReconnects
			sample.DstPeerIP = parsed.DstPeerIP
			if sample.DstPeerIP == "" && parsed.DstConnected {
				sample.DstPeerIP = cachedDstIP
			}
			sample.PathMedium = parsed.PathMedium
		}
	} else {
		c.mu.Lock()
		delete(c.lastSrcPeerIP, cid)
		delete(c.lastDstPeerIP, cid)
		c.mu.Unlock()
	}

	// Enhance LO/WAN detection from cached peer IPs and /proc/net/udp if available
	hasLO := sample.PathMedium == "LO" || sample.PathMedium == "WAN+LO"
	hasWAN := sample.PathMedium == "WAN" || sample.PathMedium == "WAN+LO"
	if sample.SrcPeerIP != "" {
		classifyIPMedium(sample.SrcPeerIP, &hasLO, &hasWAN)
	}
	if sample.DstPeerIP != "" {
		classifyIPMedium(sample.DstPeerIP, &hasLO, &hasWAN)
	}
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
	sample.SrcPackets = int64(snap.UpstreamPackets)
	sample.DstPackets = int64(snap.DownstreamPackets)
	sample.SrcBytes = int64(snap.UpstreamMbps * 125000 * float64(maxInt(c.cfg.SampleIntervalSec, 1)))
	sample.DstBytes = sample.SrcBytes
	sample.SrcRetrans = int64(snap.RetransPackets)
	sample.SrcDropped = int64(snap.DropReqPackets)
	sample.DstNAKCount = int64(snap.NAKLostPackets)
	sample.SrcReconnects = int64(snap.Handshakes)
	return sample
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
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
			srcPeerIP := fmt.Sprintf("198.51.100.%d", 41+idx)
			dstPeerIP := leg.TargetAddr
			if dstPeerIP == "" {
				dstPeerIP = fmt.Sprintf("203.0.113.%d", 21+idx)
			}
			if grp.Direction == model.DirectionHubToVenue {
				srcPeerIP = fmt.Sprintf("203.0.113.%d", 21+idx)
				dstPeerIP = fmt.Sprintf("198.51.100.%d", 51+idx)
			}

			c.mu.Lock()
			stopped := !grp.IsEnabled() || c.demoStopped[leg.ChannelID]
			c.mu.Unlock()

			procState := "running"
			uptime := 86400*4 + int64(elapsed)
			if stopped {
				procState = "exited"
				uptime = 0
			}

			s := model.ChannelSample{
				Timestamp:      now.Unix(),
				NodeID:         c.cfg.NodeID,
				ChannelID:      leg.ChannelID,
				Mode:           leg.Mode,
				ProcessState:   procState,
				RestartCount:   0,
				UptimeSec:      uptime,
				HasNativeStats: !stopped,
				Encrypted:      leg.Mode == model.ModeUDPPassthrough,
				PathMedium:     "WAN",
			}

			if !stopped && grp.ExpectedActive {
				s.SrcPeerIP = srcPeerIP
				s.DstPeerIP = dstPeerIP
				s.SrcConnected = true
				s.DstConnected = true
				s.SrcMbps = baseRate + jitter
				s.DstMbps = baseRate + jitter
				s.SrcPackets = int64(s.SrcMbps * 180)
				s.DstPackets = int64(s.DstMbps * 180)
				s.SrcBytes = int64(s.SrcMbps * 250000)
				s.DstBytes = int64(s.DstMbps * 250000)
				if leg.Mode != model.ModeUDPPassthrough {
					s.SrcRTTMs = 38.0 + 4.0*math.Sin(elapsed/7.0+float64(idx))
					s.DstRTTMs = 46.0 + 5.0*math.Cos(elapsed/9.0+float64(idx))
					s.SrcBufMs = 44.0 + 6.0*math.Sin(elapsed/8.0+float64(idx))
					s.DstBufMs = 15.0 + 3.0*math.Cos(elapsed/9.0+float64(idx))
					s.SrcTSBPDMs = 250
					s.SrcLinkBWMbps = 45.0 + 4.5*math.Sin(elapsed/18.0+float64(idx))
					s.DstLinkBWMbps = 42.0 + 3.5*math.Cos(elapsed/20.0+float64(idx))
					s.SrcMaxBWMbps = 1000
					s.DstMaxBWMbps = 1000
					if idx%2 == 0 {
						s.VideoFPS = 59.94
					} else {
						s.VideoFPS = 50
					}
					s.VideoResolution = "1920x1080"
					s.VideoCodec = "H.264"
				}

				// Show ARQ recovery with 0 unrecovered drops on healthy routes so Recovered vs Dropped is clear
				if grp.ID == "id-pgm" {
					s.SrcLost = 3
					s.SrcRetrans = 3
					s.SrcDropped = 0
					s.DstLost = 2
					s.DstRetrans = 2
					s.DstDropped = 0
				}
				// Show amber TSBPD headroom (~84% of 250ms) without triggering outage on cam2
				if grp.ID == "cam2" {
					s.SrcRTTMs = 52.0 + 2.0*math.Sin(elapsed/6.0)
				}
				// Healthy baseline retrans/NAK on Mode B passthrough
				if leg.Mode == model.ModeUDPPassthrough {
					s.SrcRetrans = 2
					s.DstNAKCount = 2
					s.SrcDropped = 0
				}

				// Simulate Mode B DropReq degradation right before hard outage, and 20s failover window
				if grp.ID == "en-pgm" && leg.Role == "primary" {
					if cycle >= 25 && cycle < 40 {
						s.SrcRetrans = 24
						s.DstNAKCount = 16
						s.SrcDropped = 2
					} else if cycle >= 40 && cycle <= 62 {
						s.SrcMbps = 0
						s.DstMbps = 0
						s.SrcPackets = 0
						s.DstPackets = 0
						s.SrcBytes = 0
						s.DstBytes = 0
						s.SrcRetrans = 0
						s.DstNAKCount = 0
						s.SrcDropped = 0
						s.SrcConnected = false
					}
				}
				if grp.ID == "ob-pgm" && leg.Role == "primary" && cycle >= 40 && cycle <= 62 {
					s.DstRTTMs = 340.0 + 35.0*math.Sin(elapsed)
					s.DstBufMs = 195.0 + 18.0*math.Sin(elapsed)
					s.DstLost = 38
					s.DstRetrans = 42
					s.DstDropped = 6
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
				StreamDisabled: !grp.IsEnabled(),
				ExpectedActive: grp.ExpectedActive,
				PrevRestarts:   0,
			}
			code, layer, summary := diagnosis.DiagnoseChannel(s, hostSample, cctx, c.currentThresholds())
			s.FaultCode = code
			s.FaultLayer = layer
			s.FaultSummary = summary

			channelsMap[leg.ChannelID] = s
			samples = append(samples, s)
		}
	}

	displayName, region, publicIP := c.localMeta()
	return model.NodeLiveStatus{
		NodeID:      c.cfg.NodeID,
		DisplayName: displayName,
		Region:      region,
		PublicIP:    publicIP,
		Online:      true,
		UpdatedAt:   now.Unix(),
		Host:        hostSample,
		Channels:    channelsMap,
	}, samples
}
