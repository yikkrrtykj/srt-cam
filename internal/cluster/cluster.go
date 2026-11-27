package cluster

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/diagnosis"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// PeerTimelinePayload is the response returned by a peer node's GET /api/peer/timeline endpoint.
type PeerTimelinePayload struct {
	NodeID   string                `json:"node_id"`
	Channel  []model.ChannelSample `json:"channel"`
	Host     []model.HostSample    `json:"host"`
}

// Manager polls arbitrary N peer VPS nodes and proxies timeline/restart calls cleanly.
type Manager struct {
	cfg        config.NodeConfig
	httpClient *http.Client
	startedAt  time.Time

	mu    sync.RWMutex
	peers map[string]model.NodeLiveStatus
}

// NewManager creates a multi-VPS cluster aggregator for all configured peers.
func NewManager(cfg config.NodeConfig) *Manager {
	m := &Manager{
		cfg:        cfg,
		httpClient: &http.Client{Timeout: 3 * time.Second},
		startedAt:  time.Now(),
		peers:      make(map[string]model.NodeLiveStatus),
	}
	for _, p := range cfg.Peers {
		m.peers[p.NodeID] = model.NodeLiveStatus{
			NodeID:      p.NodeID,
			DisplayName: p.DisplayName,
			Region:      p.Region,
			PublicIP:    p.PublicIP,
			Online:      false,
			Error:       "waiting for first poll",
			Channels:    map[string]model.ChannelSample{},
		}
	}
	return m
}

// PollPeers refreshes live status from all configured peers concurrently.
func (m *Manager) PollPeers(ctx context.Context, sheet config.EventSheet) {
	if len(m.cfg.Peers) == 0 {
		return
	}
	if m.cfg.DemoMode {
		m.simulateDemoPeers(sheet)
		return
	}
	var wg sync.WaitGroup
	for _, p := range m.cfg.Peers {
		wg.Add(1)
		go func(peer config.PeerNodeConfig) {
			defer wg.Done()
			st := m.fetchPeerLive(ctx, peer)
			m.mu.Lock()
			m.peers[peer.NodeID] = st
			m.mu.Unlock()
		}(p)
	}
	wg.Wait()
}

// SnapshotAll merges the local node status with all cached peer statuses.
func (m *Manager) SnapshotAll(local model.NodeLiveStatus) map[string]model.NodeLiveStatus {
	out := make(map[string]model.NodeLiveStatus, len(m.cfg.Peers)+1)
	out[local.NodeID] = local
	m.mu.RLock()
	for id, st := range m.peers {
		out[id] = st
	}
	m.mu.RUnlock()
	return out
}

// CheckPrimaryHealthy returns true if PrimaryMonitorURL responds 200 OK (used by backup watchdogs).
func (m *Manager) CheckPrimaryHealthy(ctx context.Context) bool {
	if m.cfg.IsPrimaryMonitor || strings.TrimSpace(m.cfg.PrimaryMonitorURL) == "" {
		return true
	}
	endpoint := strings.TrimRight(m.cfg.PrimaryMonitorURL, "/") + "/api/peer/healthz"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return false
	}
	if m.cfg.ClusterToken != "" {
		req.Header.Set("Authorization", "Bearer "+m.cfg.ClusterToken)
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// QueryPeerTimeline fetches historical channel + host samples from a remote peer VPS.
func (m *Manager) QueryPeerTimeline(ctx context.Context, nodeID, channelID string, fromTS, toTS int64) (PeerTimelinePayload, error) {
	if m.cfg.DemoMode {
		return m.simulateDemoPeerTimeline(nodeID, channelID, fromTS, toTS), nil
	}
	peer, ok := m.findPeer(nodeID)
	if !ok {
		return PeerTimelinePayload{}, fmt.Errorf("peer node %q not configured", nodeID)
	}
	q := url.Values{}
	q.Set("channel_id", channelID)
	q.Set("from", fmt.Sprintf("%d", fromTS))
	q.Set("to", fmt.Sprintf("%d", toTS))
	endpoint := strings.TrimRight(peer.APIURL, "/") + "/api/peer/timeline?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return PeerTimelinePayload{}, err
	}
	req.Header.Set("Authorization", "Bearer "+peer.APIToken)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return PeerTimelinePayload{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return PeerTimelinePayload{}, fmt.Errorf("peer %s timeline HTTP %d", nodeID, resp.StatusCode)
	}
	var payload PeerTimelinePayload
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return PeerTimelinePayload{}, err
	}
	return payload, nil
}

// RestartPeerChannel proxies an authenticated single-channel restart request to a remote peer VPS.
func (m *Manager) RestartPeerChannel(ctx context.Context, nodeID, channelID, operator string) error {
	if m.cfg.DemoMode {
		return nil
	}
	peer, ok := m.findPeer(nodeID)
	if !ok {
		return fmt.Errorf("peer node %q not configured", nodeID)
	}
	body, _ := json.Marshal(map[string]string{
		"channel_id": channelID,
		"operator":   operator,
	})
	endpoint := strings.TrimRight(peer.APIURL, "/") + "/api/peer/restart"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+peer.APIToken)
	req.Header.Set("Content-Type", "application/json")
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("peer %s restart HTTP %d", nodeID, resp.StatusCode)
	}
	return nil
}

// QueryPeerLogs fetches raw container logs from a remote peer VPS via GET /api/peer/logs.
func (m *Manager) QueryPeerLogs(ctx context.Context, nodeID, channelID string, sinceSec, tail int) (string, error) {
	if m.cfg.DemoMode {
		now := time.Now().UTC()
		return fmt.Sprintf("%s [%s/%s] Accepted SRT source connection (backup path)\n%s [%s/%s] FLOW 12.2 Mb/s · 0 drops · 0 restarts",
			now.Add(-900*time.Second).Format(time.RFC3339), nodeID, channelID,
			now.Add(-5*time.Second).Format(time.RFC3339), nodeID, channelID), nil
	}
	peer, ok := m.findPeer(nodeID)
	if !ok {
		return "", fmt.Errorf("peer node %q not configured", nodeID)
	}
	q := url.Values{}
	q.Set("channel_id", channelID)
	q.Set("since", fmt.Sprintf("%d", sinceSec))
	q.Set("tail", fmt.Sprintf("%d", tail))
	endpoint := strings.TrimRight(peer.APIURL, "/") + "/api/peer/logs?" + q.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+peer.APIToken)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("peer %s logs HTTP %d", nodeID, resp.StatusCode)
	}
	var payload struct {
		Raw string `json:"raw"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}
	return payload.Raw, nil
}

// QueryPeerThumbnail fetches a recent keyframe JPEG/PNG thumbnail from a remote peer VPS.
// Returns (nil, "", nil) if the peer has no preview thumbnail available (HTTP 204).
func (m *Manager) QueryPeerThumbnail(ctx context.Context, nodeID, channelID string) ([]byte, string, error) {
	peer, ok := m.findPeer(nodeID)
	if !ok {
		return nil, "", fmt.Errorf("peer node %q not configured", nodeID)
	}
	q := url.Values{}
	q.Set("channel_id", channelID)
	endpoint := strings.TrimRight(peer.APIURL, "/") + "/api/peer/thumbnail?" + q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+peer.APIToken)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNoContent || resp.StatusCode == http.StatusNotFound {
		return nil, "", nil
	}
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("peer %s thumbnail HTTP %d", nodeID, resp.StatusCode)
	}
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(http.MaxBytesReader(nil, resp.Body, 2<<20)); err != nil {
		return nil, "", err
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = "image/jpeg"
	}
	return buf.Bytes(), ct, nil
}

func (m *Manager) findPeer(nodeID string) (config.PeerNodeConfig, bool) {
	for _, p := range m.cfg.Peers {
		if p.NodeID == nodeID {
			return p, true
		}
	}
	return config.PeerNodeConfig{}, false
}

func (m *Manager) fetchPeerLive(ctx context.Context, peer config.PeerNodeConfig) model.NodeLiveStatus {
	fallback := model.NodeLiveStatus{
		NodeID:      peer.NodeID,
		DisplayName: peer.DisplayName,
		Region:      peer.Region,
		PublicIP:    peer.PublicIP,
		Online:      false,
		UpdatedAt:   time.Now().Unix(),
		Channels:    map[string]model.ChannelSample{},
	}
	endpoint := strings.TrimRight(peer.APIURL, "/") + "/api/peer/live"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		fallback.Error = err.Error()
		return fallback
	}
	req.Header.Set("Authorization", "Bearer "+peer.APIToken)
	resp, err := m.httpClient.Do(req)
	if err != nil {
		fallback.Error = err.Error()
		return fallback
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		fallback.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
		return fallback
	}
	var st model.NodeLiveStatus
	if err := json.NewDecoder(resp.Body).Decode(&st); err != nil {
		fallback.Error = err.Error()
		return fallback
	}
	if st.DisplayName == "" {
		st.DisplayName = peer.DisplayName
	}
	if st.Region == "" {
		st.Region = peer.Region
	}
	if st.PublicIP == "" {
		st.PublicIP = peer.PublicIP
	}
	st.Online = true
	st.Error = ""
	if st.Channels == nil {
		st.Channels = map[string]model.ChannelSample{}
	}
	return st
}

func (m *Manager) simulateDemoPeers(sheet config.EventSheet) {
	now := time.Now()
	elapsed := now.Sub(m.startedAt).Seconds()

	for pIdx, peer := range m.cfg.Peers {
		host := model.HostSample{
			Timestamp:       now.Unix(),
			NodeID:          peer.NodeID,
			CPUPercent:      11.0 + 3.0*math.Cos(elapsed/14.0+float64(pIdx)),
			MemPercent:      27.0 + float64(pIdx)*3,
			NetRxMbps:       36.0 + 1.5*math.Sin(elapsed/8.0),
			NetTxMbps:       35.9 + 1.5*math.Sin(elapsed/8.0),
			UDPRcvbufErrors: 0,
			Load1:           0.28,
		}
		chans := make(map[string]model.ChannelSample)
		for idx, grp := range sheet.SignalGroups {
			for _, leg := range grp.Legs {
				if leg.NodeID != peer.NodeID {
					continue
				}
				baseRate := 12.1 + float64(idx%3)*1.4
				srcPeerIP := fmt.Sprintf("198.51.100.%d", 61+idx+pIdx)
				dstPeerIP := leg.TargetAddr
				if dstPeerIP == "" {
					dstPeerIP = fmt.Sprintf("203.0.113.%d", 31+idx+pIdx)
				}
				if grp.Direction == model.DirectionHubToVenue {
					srcPeerIP = fmt.Sprintf("203.0.113.%d", 31+idx+pIdx)
					dstPeerIP = fmt.Sprintf("198.51.100.%d", 71+idx+pIdx)
				}
				s := model.ChannelSample{
					Timestamp:      now.Unix(),
					NodeID:         peer.NodeID,
					ChannelID:      leg.ChannelID,
					Mode:           leg.Mode,
					ProcessState:   "running",
					RestartCount:   0,
					UptimeSec:      86400*6 + int64(elapsed),
					HasNativeStats: true,
					Encrypted:      leg.Mode == model.ModeUDPPassthrough,
					PathMedium:     "WAN",
				}
				if grp.ExpectedActive {
					s.SrcPeerIP = srcPeerIP
					s.DstPeerIP = dstPeerIP
					s.SrcConnected = true
					s.DstConnected = true
					s.SrcMbps = baseRate + 0.25*math.Cos(elapsed/6.0+float64(idx))
					s.DstMbps = s.SrcMbps
					s.SrcPackets = int64(s.SrcMbps * 180)
					s.DstPackets = int64(s.DstMbps * 180)
					if leg.Mode != model.ModeUDPPassthrough {
						s.SrcRTTMs = 37.0 + 3.5*math.Sin(elapsed/8.0+float64(pIdx))
						s.DstRTTMs = 43.0 + 4.0*math.Cos(elapsed/9.0+float64(pIdx))
						s.SrcTSBPDMs = 240
						s.SrcLinkBWMbps = 48.0 + 4.0*math.Sin(elapsed/20.0+float64(pIdx))
						s.DstLinkBWMbps = 44.0 + 3.5*math.Cos(elapsed/22.0+float64(pIdx))
					}
					if grp.ID == "16mv-1" && leg.Role == "primary" {
						s.SrcLost = 1
						s.SrcRetrans = 1
					}
				}
				code, layer, summary := diagnosis.DiagnoseChannel(s, host, diagnosis.ChannelContext{
					SignalName:     grp.Name,
					DirectionLabel: sheet.DirectionLabel(grp.Direction),
					Carrier:        leg.Carrier,
					SrcDevice:      leg.SrcDevice,
					DstDevice:      leg.DstDevice,
					ExpectedActive: grp.ExpectedActive,
					PrevRestarts:   0,
				}, m.cfg.Thresholds)
				s.FaultCode = code
				s.FaultLayer = layer
				s.FaultSummary = summary
				chans[leg.ChannelID] = s
			}
		}
		m.mu.Lock()
		m.peers[peer.NodeID] = model.NodeLiveStatus{
			NodeID:      peer.NodeID,
			DisplayName: peer.DisplayName,
			Region:      peer.Region,
			PublicIP:    peer.PublicIP,
			Online:      true,
			UpdatedAt:   now.Unix(),
			Host:        host,
			Channels:    chans,
		}
		m.mu.Unlock()
	}
}

func (m *Manager) simulateDemoPeerTimeline(nodeID, channelID string, fromTS, toTS int64) PeerTimelinePayload {
	step := int64(5)
	if toTS-fromTS > 3600 {
		step = (toTS - fromTS) / 360
	}
	if step < 2 {
		step = 2
	}
	var chs []model.ChannelSample
	var hosts []model.HostSample
	for ts := fromTS; ts <= toTS; ts += step {
		t := float64(ts)
		mode := model.ModeSRTRelay
		if strings.HasPrefix(channelID, "srt-pass") {
			mode = model.ModeUDPPassthrough
		}
		rate := 12.2 + 0.25*math.Cos(t/12.0)
		cs := model.ChannelSample{
			Timestamp:      ts,
			NodeID:         nodeID,
			ChannelID:      channelID,
			Mode:           mode,
			ProcessState:   "running",
			RestartCount:   0,
			SrcConnected:   true,
			DstConnected:   true,
			SrcMbps:        rate,
			DstMbps:        rate,
			SrcPackets:     int64(rate * 90 * float64(step)),
			DstPackets:     int64(rate * 90 * float64(step)),
			PathMedium:     "WAN",
			HasNativeStats: true,
			Encrypted:      mode == model.ModeUDPPassthrough,
			FaultCode:      model.FaultHealthy,
			FaultLayer:     "none",
			FaultSummary:   "备路正常 · 0 弃包 / 0 重启",
		}
		if mode != model.ModeUDPPassthrough {
			cs.SrcRTTMs = 41.0 + 3.0*math.Sin(t/18.0)
			cs.DstRTTMs = 46.0 + 3.5*math.Cos(t/22.0)
			cs.SrcTSBPDMs = 240
			cs.SrcLinkBWMbps = 48.0 + 3.5*math.Sin(t/40.0)
			cs.DstLinkBWMbps = 44.0 + 3.0*math.Cos(t/45.0)
		}
		chs = append(chs, cs)
		hosts = append(hosts, model.HostSample{
			Timestamp:  ts,
			NodeID:     nodeID,
			CPUPercent: 11.5 + 2.0*math.Sin(t/30.0),
			MemPercent: 28.0,
			NetRxMbps:  36.0,
			NetTxMbps:  36.0,
		})
	}
	return PeerTimelinePayload{NodeID: nodeID, Channel: chs, Host: hosts}
}
