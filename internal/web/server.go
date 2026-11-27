package web

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/auth"
	"github.com/yikkrrtykj/srt-cam/internal/cluster"
	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/diagnosis"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/notify"
	"github.com/yikkrrtykj/srt-cam/internal/preview"
	"github.com/yikkrrtykj/srt-cam/internal/storage"
)

// RestartFunc restarts a single local channel container.
type RestartFunc func(ctx context.Context, channelID string) error

// PowerFunc starts (start=true) or stops (start=false) a single local channel container.
type PowerFunc func(ctx context.Context, channelID string, start bool) error

// OverviewResponse is the unified multi-node bidirectional payload served to the dashboard.
type OverviewResponse struct {
	EventName string                      `json:"event_name"`
	Sites     config.SitesConfig          `json:"sites"`
	NodeID    string                      `json:"node_id"`
	DemoMode  bool                        `json:"demo_mode"`
	UpdatedAt int64                       `json:"updated_at"`
	Nodes     []model.NodeLiveStatus      `json:"nodes"`
	Groups    []model.SignalGroupLiveView `json:"groups"`
}

// LegTimeline bundles synchronized Layer 1/2/3/4 history for one physical leg in a signal group.
type LegTimeline struct {
	Leg     config.LegConfig      `json:"leg"`
	Node    string                `json:"node_name"`
	Samples []model.ChannelSample `json:"samples"`
	Host    []model.HostSample    `json:"host"`
	Error   string                `json:"error,omitempty"`
}

// GroupTimelineResponse powers the 4-layer synchronized timeline and primary/backup overlay view.
type GroupTimelineResponse struct {
	EventName      string                   `json:"event_name"`
	FromTS         int64                    `json:"from_ts"`
	ToTS           int64                    `json:"to_ts"`
	Group          config.SignalGroupConfig `json:"group"`
	DirectionLabel string                   `json:"direction_label"`
	LiveGroup      model.SignalGroupLiveView `json:"live_group"`
	Legs           []LegTimeline            `json:"legs"`
	Events         []model.FaultEvent       `json:"events"`
}

// LogsFunc fetches recent raw logs for a single local channel container.
type LogsFunc func(ctx context.Context, channelID string, sinceSec, tail int) (string, error)

// ThumbnailFunc returns a recent thumbnail image (bytes, content-type, ok) for a local channel.
type ThumbnailFunc func(channelID string) ([]byte, string, bool)

// LogLine is one parsed log entry returned to the route detail Logs tab.
type LogLine struct {
	TS      string `json:"ts,omitempty"`
	Level   string `json:"level"` // error, warn, connect, stats, info
	IsStats bool   `json:"is_stats"`
	Text    string `json:"text"`
}

// ChannelLogsResponse is the payload for GET /api/v1/channels/{nodeID}/{channelID}/logs.
type ChannelLogsResponse struct {
	NodeID     string    `json:"node_id"`
	ChannelID  string    `json:"channel_id"`
	FetchedAt  int64     `json:"fetched_at"`
	TotalLines int       `json:"total_lines"`
	Lines      []LogLine `json:"lines"`
}

// FeishuConfigView returns sanitized Feishu alert settings (never exposes raw webhook token or secret).
type FeishuConfigView struct {
	Enabled           bool   `json:"enabled"`
	WebhookMasked     string `json:"webhook_masked"`
	WebhookConfigured bool   `json:"webhook_configured"`
	SecretConfigured  bool   `json:"secret_configured"`
	DebounceSec       int    `json:"debounce_sec"`
	CooldownSec       int    `json:"cooldown_sec"`
	WatchdogSec       int    `json:"watchdog_sec"`
	DashboardBaseURL  string `json:"dashboard_base_url"`
}

// AlertConfigView is returned by GET /api/v1/alerts/config.
type AlertConfigView struct {
	Feishu     FeishuConfigView       `json:"feishu"`
	Thresholds config.ThresholdConfig `json:"thresholds"`
	Persistent bool                   `json:"persistent"`
}

// AlertConfigUpdate is the payload accepted by PUT /api/v1/alerts/config.
type AlertConfigUpdate struct {
	Feishu struct {
		Enabled          bool   `json:"enabled"`
		WebhookURL       string `json:"webhook_url"`
		ClearWebhook     bool   `json:"clear_webhook,omitempty"`
		Secret           string `json:"secret"`
		ClearSecret      bool   `json:"clear_secret,omitempty"`
		DebounceSec      int    `json:"debounce_sec"`
		CooldownSec      int    `json:"cooldown_sec"`
		WatchdogSec      int    `json:"watchdog_sec"`
		DashboardBaseURL string `json:"dashboard_base_url"`
	} `json:"feishu"`
	Thresholds config.ThresholdConfig `json:"thresholds"`
}

// AlertConfigUpdateFunc persists and hot-reloads updated Feishu & threshold settings.
type AlertConfigUpdateFunc func(feishu config.FeishuConfig, thresholds config.ThresholdConfig) error

// LocalNodeView describes editable metadata for the local node.
type LocalNodeView struct {
	NodeID       string `json:"node_id"`
	DisplayName  string `json:"display_name"`
	Region       string `json:"region"`
	PublicIP     string `json:"public_ip"`
	ClusterToken string `json:"cluster_token"`
}

// PeerNodeView describes a configured peer relay server (never returns raw API token).
type PeerNodeView struct {
	NodeID          string `json:"node_id"`
	DisplayName     string `json:"display_name"`
	Region          string `json:"region"`
	PublicIP        string `json:"public_ip"`
	APIURL          string `json:"api_url"`
	TokenConfigured bool   `json:"token_configured"`
}

// NodesConfigView is returned by GET /api/v1/nodes/config.
type NodesConfigView struct {
	Local LocalNodeView  `json:"local"`
	Peers []PeerNodeView `json:"peers"`
}

// LocalNodeUpdate is accepted by PUT /api/v1/nodes/local.
type LocalNodeUpdate struct {
	DisplayName string `json:"display_name"`
	Region      string `json:"region"`
	PublicIP    string `json:"public_ip"`
}

// PeerNodeUpsert is accepted by POST /api/v1/nodes/peers.
type PeerNodeUpsert struct {
	NodeID      string `json:"node_id"`
	DisplayName string `json:"display_name"`
	Region      string `json:"region"`
	PublicIP    string `json:"public_ip"`
	APIURL      string `json:"api_url"`
	APIToken    string `json:"api_token"`
}

// NodesConfigUpdateFunc persists and hot-reloads local node metadata and remote peer list.
type NodesConfigUpdateFunc func(displayName, region, publicIP string, peers []config.PeerNodeConfig) error

// Server serves authenticated dashboard REST/SSE APIs, peer cluster APIs, and the embedded SPA.
type Server struct {
	cfg             config.NodeConfig
	events          *config.EventStore
	store           *storage.Store
	authMgr         *auth.Manager
	clusterMgr      *cluster.Manager
	restartFn       RestartFunc
	powerFn         PowerFunc
	refreshFn       func()
	logsFn          LogsFunc
	thumbnailFn     ThumbnailFunc
	testFeishu      func(ctx context.Context) error
	alertPersist    bool
	onAlertConfigFn AlertConfigUpdateFunc
	onNodesConfigFn NodesConfigUpdateFunc
	staticFS        fs.FS

	mu       sync.RWMutex
	local    model.NodeLiveStatus
	overview OverviewResponse

	sseMu   sync.Mutex
	sseSubs map[chan []byte]struct{}
}

// NewServer wires all HTTP handlers for srt-camd.
func NewServer(
	cfg config.NodeConfig,
	events *config.EventStore,
	store *storage.Store,
	authMgr *auth.Manager,
	clusterMgr *cluster.Manager,
	restartFn RestartFunc,
	testFeishu func(ctx context.Context) error,
	staticFS fs.FS,
) *Server {
	return &Server{
		cfg:        cfg,
		events:     events,
		store:      store,
		authMgr:    authMgr,
		clusterMgr: clusterMgr,
		restartFn:  restartFn,
		testFeishu: testFeishu,
		staticFS:   staticFS,
		sseSubs:    make(map[chan []byte]struct{}),
	}
}

// SetLogsFunc attaches the local container log fetcher used by the Logs tab and peer log proxy.
func (s *Server) SetLogsFunc(fn LogsFunc) {
	s.logsFn = fn
}

// SetPowerFunc attaches the local single-container start/stop handler for Haivision-style stream switches.
func (s *Server) SetPowerFunc(fn PowerFunc) {
	s.powerFn = fn
}

// SetRefreshFunc attaches a non-blocking wakeup callback to push an immediate SSE refresh after mutations.
func (s *Server) SetRefreshFunc(fn func()) {
	s.refreshFn = fn
}

func (s *Server) triggerRefresh() {
	if s.refreshFn != nil {
		s.refreshFn()
	}
}

// SetThumbnailFunc attaches the local keyframe thumbnail fetcher used by UI cards and peer proxy.
func (s *Server) SetThumbnailFunc(fn ThumbnailFunc) {
	s.thumbnailFn = fn
}

// SetAlertConfigCallback attaches a persistence and hot-reload hook for PUT /api/v1/alerts/config.
func (s *Server) SetAlertConfigCallback(persistent bool, fn AlertConfigUpdateFunc) {
	s.mu.Lock()
	s.alertPersist = persistent
	s.onAlertConfigFn = fn
	s.mu.Unlock()
}

// SetNodesConfigCallback attaches a persistence and hot-reload hook for node & peer management endpoints.
func (s *Server) SetNodesConfigCallback(fn NodesConfigUpdateFunc) {
	s.mu.Lock()
	s.onNodesConfigFn = fn
	s.mu.Unlock()
}

// UpdateSnapshot stores the latest aggregated snapshot and notifies connected SSE browsers.
func (s *Server) UpdateSnapshot(local model.NodeLiveStatus, allNodes map[string]model.NodeLiveStatus, sheet config.EventSheet) OverviewResponse {
	groups := BuildSignalGroupViews(sheet, allNodes)

	nodes := make([]model.NodeLiveStatus, 0, len(allNodes))
	for _, n := range allNodes {
		nodes = append(nodes, n)
	}
	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].NodeID == s.cfg.NodeID {
			return true
		}
		if nodes[j].NodeID == s.cfg.NodeID {
			return false
		}
		return nodes[i].NodeID < nodes[j].NodeID
	})

	ov := OverviewResponse{
		EventName: sheet.EventName,
		Sites:     sheet.Sites,
		NodeID:    s.cfg.NodeID,
		DemoMode:  s.cfg.DemoMode,
		UpdatedAt: time.Now().Unix(),
		Nodes:     nodes,
		Groups:    groups,
	}

	s.mu.Lock()
	s.local = local
	s.overview = ov
	s.mu.Unlock()

	if payload, err := json.Marshal(ov); err == nil {
		s.broadcastSSE(payload)
	}
	return ov
}

// BuildSignalGroupViews joins the configured EventSheet with live N-node telemetry and evaluates redundancy.
func BuildSignalGroupViews(sheet config.EventSheet, allNodes map[string]model.NodeLiveStatus) []model.SignalGroupLiveView {
	out := make([]model.SignalGroupLiveView, 0, len(sheet.SignalGroups))
	for _, grp := range sheet.SignalGroups {
		enabled := grp.IsEnabled()
		legs := make([]model.LegLiveView, 0, len(grp.Legs))
		for _, leg := range grp.Legs {
			node, ok := allNodes[leg.NodeID]
			nodeName := leg.NodeID
			online := false
			var hostSample model.HostSample
			sample := model.ChannelSample{
				NodeID:       leg.NodeID,
				ChannelID:    leg.ChannelID,
				Mode:         leg.Mode,
				ProcessState: "node_unreachable",
				PathMedium:   "-",
				FaultCode:    model.FaultNodeUnreachable,
				FaultLayer:   "cloud",
				FaultSummary: fmt.Sprintf("云端节点 %s 失联或未配置", leg.NodeID),
			}
			if ok {
				if node.DisplayName != "" {
					nodeName = node.DisplayName
				}
				online = node.Online
				hostSample = node.Host
				if online {
					if cs, found := node.Channels[leg.ChannelID]; found {
						sample = cs
					} else {
						sample.ProcessState = "not_found"
						sample.FaultCode = model.FaultCloudProcessDown
						sample.FaultSummary = fmt.Sprintf("节点 %s 上未找到通道 %s", leg.NodeID, leg.ChannelID)
					}
				} else if node.Error != "" {
					sample.FaultSummary = fmt.Sprintf("云端节点 %s 失联（%s）", leg.NodeID, node.Error)
				}
			}
			if !enabled {
				sample.FaultCode = model.FaultStreamStopped
				sample.FaultLayer = "none"
				sample.FaultSummary = "已停止"
				sample.VideoFPS = 0
				sample.VideoResolution = ""
				sample.VideoCodec = ""
				sample.AudioCodec = ""
				sample.AudioSampleRate = 0
				sample.AudioBitrateKbps = 0
				sample.AudioChannels = ""
				sample.AudioTracks = 0
				sample.AudioDetail = ""
			}

			legs = append(legs, model.LegLiveView{
				Role:       leg.Role,
				NodeID:     leg.NodeID,
				NodeName:   nodeName,
				ChannelID:  leg.ChannelID,
				Mode:       leg.Mode,
				Carrier:    leg.Carrier,
				SrcDevice:  leg.SrcDevice,
				DstDevice:  leg.DstDevice,
				InPort:     leg.InPort,
				OutPort:    leg.OutPort,
				TargetAddr: leg.TargetAddr,
				NodeOnline: online,
				Sample:     sample,
				Host:       hostSample,
			})
		}

		sev, summary, protector := diagnosis.EvaluateSignalGroup(grp, legs)
		out = append(out, model.SignalGroupLiveView{
			ID:             grp.ID,
			Name:           grp.Name,
			Direction:      grp.Direction,
			DirectionLabel: sheet.DirectionLabel(grp.Direction),
			RedundancyType: grp.RedundancyType,
			Enabled:        enabled,
			ExpectedActive: grp.ExpectedActive,
			Notes:          grp.Notes,
			Severity:       sev,
			Summary:        summary,
			ProtectedBy:    protector,
			Legs:           legs,
		})
	}
	return out
}

// Handler returns the complete HTTP mux with security headers, auth, peer endpoints, and embedded SPA.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health & Auth
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "node_id": s.cfg.NodeID})
	})
	mux.HandleFunc("GET /api/v1/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/v1/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/v1/auth/logout", s.handleLogout)

	// Authenticated UI APIs
	mux.HandleFunc("GET /api/v1/overview", s.withAuth(s.handleOverview))
	mux.HandleFunc("GET /api/v1/stream", s.withAuth(s.handleSSE))
	mux.HandleFunc("GET /api/v1/timeline/{groupID}", s.withAuth(s.handleTimeline))
	mux.HandleFunc("GET /api/v1/events", s.withAuth(s.handleEvents))
	mux.HandleFunc("GET /api/v1/event-sheet", s.withAuth(s.handleGetEventSheet))
	mux.HandleFunc("PUT /api/v1/event-sheet", s.withAuth(s.handlePutEventSheet))
	mux.HandleFunc("PATCH /api/v1/signal-groups/{groupID}/expected-active", s.withAuth(s.handleToggleExpectedActive))
	mux.HandleFunc("PATCH /api/v1/signal-groups/{groupID}/enabled", s.withAuth(s.handleSetGroupEnabled))
	mux.HandleFunc("POST /api/v1/channels/{nodeID}/{channelID}/restart", s.withAuth(s.handleRestartChannel))
	mux.HandleFunc("GET /api/v1/channels/{nodeID}/{channelID}/logs", s.withAuth(s.handleChannelLogs))
	mux.HandleFunc("GET /api/v1/channels/{nodeID}/{channelID}/thumbnail", s.withAuth(s.handleChannelThumbnail))
	mux.HandleFunc("GET /api/v1/audit", s.withAuth(s.handleAudit))
	mux.HandleFunc("GET /api/v1/alerts/config", s.withAuth(s.handleGetAlertConfig))
	mux.HandleFunc("PUT /api/v1/alerts/config", s.withAuth(s.handlePutAlertConfig))
	mux.HandleFunc("POST /api/v1/alerts/test", s.withAuth(s.handleTestAlert))
	mux.HandleFunc("GET /api/v1/nodes/config", s.withAuth(s.handleGetNodesConfig))
	mux.HandleFunc("PUT /api/v1/nodes/local", s.withAuth(s.handlePutLocalNode))
	mux.HandleFunc("POST /api/v1/nodes/peers", s.withAuth(s.handleUpsertPeer))
	mux.HandleFunc("DELETE /api/v1/nodes/peers/{nodeID}", s.withAuth(s.handleDeletePeer))

	// Peer VPS Cluster APIs (Bearer cluster_token)
	mux.HandleFunc("GET /api/peer/healthz", s.withClusterAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "node_id": s.cfg.NodeID})
	}))
	mux.HandleFunc("GET /api/peer/live", s.withClusterAuth(s.handlePeerLive))
	mux.HandleFunc("GET /api/peer/timeline", s.withClusterAuth(s.handlePeerTimeline))
	mux.HandleFunc("GET /api/peer/logs", s.withClusterAuth(s.handlePeerLogs))
	mux.HandleFunc("GET /api/peer/thumbnail", s.withClusterAuth(s.handlePeerThumbnail))
	mux.HandleFunc("POST /api/peer/restart", s.withClusterAuth(s.handlePeerRestart))
	mux.HandleFunc("POST /api/peer/channel-power", s.withClusterAuth(s.handlePeerChannelPower))

	// Embedded SPA static frontend
	if s.staticFS != nil {
		mux.Handle("/", s.spaHandler(s.staticFS))
	}

	return securityHeaders(mux)
}

func (s *Server) withAuth(next func(http.ResponseWriter, *http.Request, string)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, ok := s.authMgr.AuthenticatedUser(r)
		if !ok {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "请先登录"})
			return
		}
		next(w, r, user)
	}
}

func (s *Server) withClusterAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.authMgr.VerifyClusterToken(r) {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid cluster token"})
			return
		}
		next(w, r)
	}
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	user, ok := s.authMgr.AuthenticatedUser(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"auth_enabled":  s.authMgr.IsAuthEnabled(),
		"authenticated": ok,
		"username":      user,
		"demo_mode":     s.cfg.DemoMode,
		"node_id":       s.cfg.NodeID,
		"display_name":  s.cfg.DisplayName,
	})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	code, err := s.authMgr.Login(w, r, body.Username, body.Password)
	if err != nil {
		writeJSON(w, code, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "username": body.Username})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	s.authMgr.Logout(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.RLock()
	ov := s.overview
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) handleSSE(w http.ResponseWriter, r *http.Request, _ string) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := make(chan []byte, 4)
	s.sseMu.Lock()
	s.sseSubs[ch] = struct{}{}
	s.sseMu.Unlock()
	defer func() {
		s.sseMu.Lock()
		delete(s.sseSubs, ch)
		s.sseMu.Unlock()
	}()

	// Send current snapshot immediately
	s.mu.RLock()
	initPayload, _ := json.Marshal(s.overview)
	s.mu.RUnlock()
	_, _ = fmt.Fprintf(w, "event: overview\ndata: %s\n\n", initPayload)
	flusher.Flush()

	keepalive := time.NewTicker(20 * time.Second)
	defer keepalive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case data := <-ch:
			_, _ = fmt.Fprintf(w, "event: overview\ndata: %s\n\n", data)
			flusher.Flush()
		case <-keepalive.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) broadcastSSE(payload []byte) {
	s.sseMu.Lock()
	defer s.sseMu.Unlock()
	for ch := range s.sseSubs {
		select {
		case ch <- payload:
		default:
		}
	}
}

func (s *Server) handleTimeline(w http.ResponseWriter, r *http.Request, _ string) {
	groupID := r.PathValue("groupID")
	now := time.Now().Unix()
	toTS := parseInt64Query(r, "to", now)
	fromTS := parseInt64Query(r, "from", toTS-1800) // default last 30 min
	if fromTS >= toTS {
		fromTS = toTS - 300
	}

	sheet := s.events.Get()
	var target *config.SignalGroupConfig
	for i := range sheet.SignalGroups {
		if sheet.SignalGroups[i].ID == groupID {
			target = &sheet.SignalGroups[i]
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "signal group not found"})
		return
	}

	// Find current live group summary
	var liveGrp model.SignalGroupLiveView
	s.mu.RLock()
	for _, g := range s.overview.Groups {
		if g.ID == groupID {
			liveGrp = g
			break
		}
	}
	s.mu.RUnlock()

	s.mu.RLock()
	localDisplayName := s.cfg.DisplayName
	peersCopy := make([]config.PeerNodeConfig, len(s.cfg.Peers))
	copy(peersCopy, s.cfg.Peers)
	s.mu.RUnlock()

	legsOut := make([]LegTimeline, len(target.Legs))
	var wg sync.WaitGroup
	for idx, leg := range target.Legs {
		wg.Add(1)
		go func(i int, l config.LegConfig) {
			defer wg.Done()
			lt := LegTimeline{Leg: l, Node: l.NodeID}
			if l.NodeID == s.cfg.NodeID {
				lt.Node = localDisplayName
				chs, err := s.store.QueryChannelTimeline(r.Context(), l.NodeID, l.ChannelID, fromTS, toTS, 900)
				if err != nil {
					lt.Error = err.Error()
				}
				hosts, _ := s.store.QueryHostTimeline(r.Context(), l.NodeID, fromTS, toTS, 900)
				lt.Samples = chs
				lt.Host = hosts
			} else {
				for _, p := range peersCopy {
					if p.NodeID == l.NodeID && p.DisplayName != "" {
						lt.Node = p.DisplayName
					}
				}
				peerData, err := s.clusterMgr.QueryPeerTimeline(r.Context(), l.NodeID, l.ChannelID, fromTS, toTS)
				if err != nil {
					lt.Error = err.Error()
				} else {
					lt.Samples = peerData.Channel
					lt.Host = peerData.Host
				}
			}
			if lt.Samples == nil {
				lt.Samples = []model.ChannelSample{}
			}
			if lt.Host == nil {
				lt.Host = []model.HostSample{}
			}
			legsOut[i] = lt
		}(idx, leg)
	}
	wg.Wait()

	evs, _ := s.store.QueryFaultEvents(r.Context(), groupID, fromTS, toTS, 100)
	if evs == nil {
		evs = []model.FaultEvent{}
	}

	writeJSON(w, http.StatusOK, GroupTimelineResponse{
		EventName:      sheet.EventName,
		FromTS:         fromTS,
		ToTS:           toTS,
		Group:          *target,
		DirectionLabel: sheet.DirectionLabel(target.Direction),
		LiveGroup:      liveGrp,
		Legs:           legsOut,
		Events:         evs,
	})
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request, _ string) {
	now := time.Now().Unix()
	toTS := parseInt64Query(r, "to", now)
	fromTS := parseInt64Query(r, "from", toTS-86400*7)
	groupID := r.URL.Query().Get("group_id")
	evs, err := s.store.QueryFaultEvents(r.Context(), groupID, fromTS, toTS, 200)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if evs == nil {
		evs = []model.FaultEvent{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"events": evs})
}

func (s *Server) handleGetEventSheet(w http.ResponseWriter, r *http.Request, _ string) {
	writeJSON(w, http.StatusOK, s.events.Get())
}

func (s *Server) handlePutEventSheet(w http.ResponseWriter, r *http.Request, user string) {
	var next config.EventSheet
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&next); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效 JSON 格式：" + err.Error()})
		return
	}
	if err := config.ValidateEventSheet(next); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	cur := s.events.Get()
	if err := config.ValidateEditLock(cur, next); err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err := s.events.Save(next); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "update_event_sheet",
		Target:   next.EventName,
		Detail:   fmt.Sprintf("更新场次信号表（共 %d 组逻辑信号）", len(next.SignalGroups)),
	})
	s.triggerRefresh()
	writeJSON(w, http.StatusOK, next)
}

func (s *Server) handleToggleExpectedActive(w http.ResponseWriter, r *http.Request, user string) {
	groupID := r.PathValue("groupID")
	var body struct {
		ExpectedActive bool `json:"expected_active"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	sheet, err := s.events.SetExpectedActive(groupID, body.ExpectedActive)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "toggle_expected_active",
		Target:   groupID,
		Detail:   fmt.Sprintf("expected_active=%v", body.ExpectedActive),
	})
	s.triggerRefresh()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "event_sheet": sheet})
}

func (s *Server) handleSetGroupEnabled(w http.ResponseWriter, r *http.Request, user string) {
	groupID := r.PathValue("groupID")
	var body struct {
		Enabled bool `json:"enabled"`
		Force   bool `json:"force"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	cur := s.events.Get()
	var target *config.SignalGroupConfig
	for i := range cur.SignalGroups {
		if cur.SignalGroups[i].ID == groupID {
			target = &cur.SignalGroups[i]
			break
		}
	}
	if target == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "未找到该信号通道"})
		return
	}

	// Safety guard: require explicit confirmation before stopping an active broadcast stream.
	if !body.Enabled && !body.Force {
		maxMbps := 0.0
		s.mu.RLock()
		for _, g := range s.overview.Groups {
			if g.ID == groupID {
				for _, leg := range g.Legs {
					if leg.NodeOnline && leg.Sample.SrcMbps > maxMbps {
						maxMbps = leg.Sample.SrcMbps
					}
				}
				break
			}
		}
		s.mu.RUnlock()
		if maxMbps >= 0.1 {
			writeJSON(w, http.StatusConflict, map[string]any{
				"error":       fmt.Sprintf("信号「%s」当前正在传输 %.1f Mb/s，请二次确认后再停止", target.Name, maxMbps),
				"active_mbps": maxMbps,
			})
			return
		}
	}

	// Control every leg's data-plane container (local Docker or remote peer VPS).
	for _, leg := range target.Legs {
		var err error
		if leg.NodeID == s.cfg.NodeID {
			if s.powerFn != nil {
				err = s.powerFn(r.Context(), leg.ChannelID, body.Enabled)
			}
		} else {
			err = s.clusterMgr.SetPeerChannelPower(r.Context(), leg.NodeID, leg.ChannelID, body.Enabled, user)
		}
		if err != nil {
			opText := "停止"
			if body.Enabled {
				opText = "启动"
			}
			writeJSON(w, http.StatusBadGateway, map[string]string{
				"error": fmt.Sprintf("%s通道 %s/%s 失败：%v", opText, leg.NodeID, leg.ChannelID, err),
			})
			return
		}
	}

	sheet, err := s.events.SetEnabled(groupID, body.Enabled)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}

	action := "stop_signal_stream"
	detail := fmt.Sprintf("停止信号流「%s」（容器已停止，参数已解锁）", target.Name)
	if body.Enabled {
		action = "start_signal_stream"
		detail = fmt.Sprintf("启动信号流「%s」（容器已运行，传输参数已锁定）", target.Name)
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   action,
		Target:   target.Name,
		Detail:   detail,
	})
	s.triggerRefresh()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"enabled":     body.Enabled,
		"event_sheet": sheet,
	})
}

func (s *Server) handleRestartChannel(w http.ResponseWriter, r *http.Request, user string) {
	nodeID := r.PathValue("nodeID")
	channelID := r.PathValue("channelID")
	var body struct {
		ConfirmChannelID string `json:"confirm_channel_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if strings.TrimSpace(body.ConfirmChannelID) != channelID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "二次确认通道名不匹配，已拒绝重启"})
		return
	}

	var err error
	if nodeID == s.cfg.NodeID {
		if s.restartFn == nil {
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "restart not wired"})
			return
		}
		err = s.restartFn(r.Context(), channelID)
	} else {
		err = s.clusterMgr.RestartPeerChannel(r.Context(), nodeID, channelID, user)
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "单路重启失败：" + err.Error()})
		return
	}

	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   nodeID,
		Action:   "safe_single_restart",
		Target:   channelID,
		Detail:   fmt.Sprintf("已安全重启单路 %s/%s（不影响同节点其他通道）", nodeID, channelID),
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "node_id": nodeID, "channel_id": channelID})
}

func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request, _ string) {
	entries, err := s.store.QueryAudit(r.Context(), 100)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if entries == nil {
		entries = []model.AuditEntry{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": entries})
}

func maskWebhookURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	idx := strings.LastIndex(trimmed, "/")
	if idx < 0 || idx >= len(trimmed)-1 {
		if len(trimmed) <= 8 {
			return "****"
		}
		return trimmed[:4] + "****" + trimmed[len(trimmed)-4:]
	}
	prefix := trimmed[:idx+1]
	token := trimmed[idx+1:]
	if len(token) <= 6 {
		return prefix + "****"
	}
	return prefix + "****" + token[len(token)-6:]
}

func (s *Server) buildAlertConfigViewLocked() AlertConfigView {
	f := s.cfg.Feishu
	return AlertConfigView{
		Feishu: FeishuConfigView{
			Enabled:           f.Enabled,
			WebhookMasked:     maskWebhookURL(f.WebhookURL),
			WebhookConfigured: strings.TrimSpace(f.WebhookURL) != "",
			SecretConfigured:  strings.TrimSpace(f.Secret) != "",
			DebounceSec:       f.DebounceSec,
			CooldownSec:       f.CooldownSec,
			WatchdogSec:       f.WatchdogSec,
			DashboardBaseURL:  f.DashboardBaseURL,
		},
		Thresholds: s.cfg.Thresholds,
		Persistent: s.alertPersist,
	}
}

func (s *Server) handleGetAlertConfig(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.RLock()
	view := s.buildAlertConfigViewLocked()
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handlePutAlertConfig(w http.ResponseWriter, r *http.Request, user string) {
	var body AlertConfigUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效 JSON 格式：" + err.Error()})
		return
	}

	s.mu.RLock()
	nextFeishu := s.cfg.Feishu
	nextTh := s.cfg.Thresholds
	onUpdate := s.onAlertConfigFn
	s.mu.RUnlock()

	nextFeishu.Enabled = body.Feishu.Enabled
	if body.Feishu.ClearWebhook {
		nextFeishu.WebhookURL = ""
	} else if u := strings.TrimSpace(body.Feishu.WebhookURL); u != "" {
		if !strings.HasPrefix(u, "https://") && !strings.HasPrefix(u, "http://") {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "飞书 Webhook 地址必须以 https:// 或 http:// 开头"})
			return
		}
		nextFeishu.WebhookURL = u
	}
	if body.Feishu.ClearSecret {
		nextFeishu.Secret = ""
	} else if sec := strings.TrimSpace(body.Feishu.Secret); sec != "" {
		nextFeishu.Secret = sec
	}
	if body.Feishu.DebounceSec > 0 {
		if body.Feishu.DebounceSec > 600 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "持续防抖时长需在 1 ~ 600 秒之间"})
			return
		}
		nextFeishu.DebounceSec = body.Feishu.DebounceSec
	}
	if body.Feishu.CooldownSec > 0 {
		if body.Feishu.CooldownSec < 10 || body.Feishu.CooldownSec > 86400 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "重复提醒间隔需在 10 ~ 86400 秒之间"})
			return
		}
		nextFeishu.CooldownSec = body.Feishu.CooldownSec
	}
	if body.Feishu.WatchdogSec > 0 {
		if body.Feishu.WatchdogSec < 5 || body.Feishu.WatchdogSec > 600 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "备节点接管超时需在 5 ~ 600 秒之间"})
			return
		}
		nextFeishu.WatchdogSec = body.Feishu.WatchdogSec
	}
	nextFeishu.DashboardBaseURL = strings.TrimRight(strings.TrimSpace(body.Feishu.DashboardBaseURL), "/")

	if nextFeishu.Enabled && strings.TrimSpace(nextFeishu.WebhookURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "启用飞书告警前请先填写 Webhook 地址"})
		return
	}

	if body.Thresholds.MinFlowMbps > 0 {
		nextTh.MinFlowMbps = body.Thresholds.MinFlowMbps
	}
	if body.Thresholds.HighRTTMs > 0 {
		nextTh.HighRTTMs = body.Thresholds.HighRTTMs
	}
	if body.Thresholds.HighLossPerSample >= 0 {
		nextTh.HighLossPerSample = body.Thresholds.HighLossPerSample
	}
	if body.Thresholds.HighRetrans >= 0 {
		nextTh.HighRetrans = body.Thresholds.HighRetrans
	}
	if body.Thresholds.HighNAKLost >= 0 {
		nextTh.HighNAKLost = body.Thresholds.HighNAKLost
	}
	if body.Thresholds.UDPBufDropTrigger >= 0 {
		nextTh.UDPBufDropTrigger = body.Thresholds.UDPBufDropTrigger
	}

	if onUpdate != nil {
		if err := onUpdate(nextFeishu, nextTh); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存告警配置失败：" + err.Error()})
			return
		}
	}

	s.mu.Lock()
	s.cfg.Feishu = nextFeishu
	s.cfg.Thresholds = nextTh
	s.testFeishu = NewFeishuTestFunc(s.cfg)
	view := s.buildAlertConfigViewLocked()
	s.mu.Unlock()

	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "update_alert_config",
		Target:   "feishu",
		Detail:   fmt.Sprintf("更新告警配置（飞书=%v，防抖=%ds，冷却=%ds，高时延=%.0fms）", nextFeishu.Enabled, nextFeishu.DebounceSec, nextFeishu.CooldownSec, nextTh.HighRTTMs),
	})
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleTestAlert(w http.ResponseWriter, r *http.Request, user string) {
	s.mu.RLock()
	testFn := s.testFeishu
	s.mu.RUnlock()
	if testFn == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "飞书通知未开启或未配置 Webhook 地址，请先开启并保存配置"})
		return
	}
	if err := testFn(r.Context()); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "飞书推送失败：" + err.Error()})
		return
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "test_feishu_alert",
		Target:   "feishu",
		Detail:   "发送测试飞书告警卡片成功",
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) buildNodesConfigViewLocked() NodesConfigView {
	peers := make([]PeerNodeView, 0, len(s.cfg.Peers))
	for _, p := range s.cfg.Peers {
		peers = append(peers, PeerNodeView{
			NodeID:          p.NodeID,
			DisplayName:     p.DisplayName,
			Region:          p.Region,
			PublicIP:        p.PublicIP,
			APIURL:          p.APIURL,
			TokenConfigured: strings.TrimSpace(p.APIToken) != "",
		})
	}
	return NodesConfigView{
		Local: LocalNodeView{
			NodeID:       s.cfg.NodeID,
			DisplayName:  s.cfg.DisplayName,
			Region:       s.cfg.Region,
			PublicIP:     s.cfg.PublicIP,
			ClusterToken: s.cfg.ClusterToken,
		},
		Peers: peers,
	}
}

func (s *Server) handleGetNodesConfig(w http.ResponseWriter, r *http.Request, _ string) {
	s.mu.RLock()
	view := s.buildNodesConfigViewLocked()
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handlePutLocalNode(w http.ResponseWriter, r *http.Request, user string) {
	var body LocalNodeUpdate
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效 JSON 格式：" + err.Error()})
		return
	}
	displayName := strings.TrimSpace(body.DisplayName)
	if displayName == "" {
		displayName = s.cfg.NodeID
	}
	region := strings.TrimSpace(body.Region)
	publicIP := strings.TrimSpace(body.PublicIP)

	s.mu.RLock()
	peers := make([]config.PeerNodeConfig, len(s.cfg.Peers))
	copy(peers, s.cfg.Peers)
	onUpdate := s.onNodesConfigFn
	s.mu.RUnlock()

	if onUpdate != nil {
		if err := onUpdate(displayName, region, publicIP, peers); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存本机信息失败：" + err.Error()})
			return
		}
	}

	s.mu.Lock()
	s.cfg.DisplayName = displayName
	s.cfg.Region = region
	s.cfg.PublicIP = publicIP
	s.local.DisplayName = displayName
	s.local.Region = region
	s.local.PublicIP = publicIP
	for i := range s.overview.Nodes {
		if s.overview.Nodes[i].NodeID == s.cfg.NodeID {
			s.overview.Nodes[i].DisplayName = displayName
			s.overview.Nodes[i].Region = region
			s.overview.Nodes[i].PublicIP = publicIP
		}
	}
	view := s.buildNodesConfigViewLocked()
	s.mu.Unlock()

	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "update_local_node",
		Target:   s.cfg.NodeID,
		Detail:   fmt.Sprintf("更新本机信息（名称=%s，机房=%s，IP=%s）", displayName, region, publicIP),
	})
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleUpsertPeer(w http.ResponseWriter, r *http.Request, user string) {
	var body PeerNodeUpsert
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "无效 JSON 格式：" + err.Error()})
		return
	}
	nodeID := strings.TrimSpace(body.NodeID)
	apiURL := strings.TrimRight(strings.TrimSpace(body.APIURL), "/")
	if nodeID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "服务器标识（如 vps-2）不能为空"})
		return
	}
	if nodeID == s.cfg.NodeID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "服务器标识不能与本机相同"})
		return
	}
	if apiURL == "" || (!strings.HasPrefix(apiURL, "http://") && !strings.HasPrefix(apiURL, "https://")) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "管理地址必须以 http:// 或 https:// 开头"})
		return
	}

	s.mu.RLock()
	displayName := s.cfg.DisplayName
	region := s.cfg.Region
	publicIP := s.cfg.PublicIP
	clusterToken := s.cfg.ClusterToken
	peers := make([]config.PeerNodeConfig, len(s.cfg.Peers))
	copy(peers, s.cfg.Peers)
	onUpdate := s.onNodesConfigFn
	s.mu.RUnlock()

	peerName := strings.TrimSpace(body.DisplayName)
	if peerName == "" {
		peerName = nodeID
	}
	token := strings.TrimSpace(body.APIToken)

	foundIdx := -1
	for i := range peers {
		if peers[i].NodeID == nodeID {
			foundIdx = i
			break
		}
	}
	if token == "" {
		if foundIdx >= 0 && peers[foundIdx].APIToken != "" {
			token = peers[foundIdx].APIToken
		} else {
			token = clusterToken
		}
	}

	peerCfg := config.PeerNodeConfig{
		NodeID:      nodeID,
		DisplayName: peerName,
		Region:      strings.TrimSpace(body.Region),
		PublicIP:    strings.TrimSpace(body.PublicIP),
		APIURL:      apiURL,
		APIToken:    token,
	}
	if foundIdx >= 0 {
		peers[foundIdx] = peerCfg
	} else {
		peers = append(peers, peerCfg)
	}

	if onUpdate != nil {
		if err := onUpdate(displayName, region, publicIP, peers); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "保存服务器列表失败：" + err.Error()})
			return
		}
	}

	s.mu.Lock()
	s.cfg.Peers = peers
	view := s.buildNodesConfigViewLocked()
	s.mu.Unlock()

	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "upsert_peer_node",
		Target:   nodeID,
		Detail:   fmt.Sprintf("保存远端服务器 %s (%s)", nodeID, apiURL),
	})
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleDeletePeer(w http.ResponseWriter, r *http.Request, user string) {
	nodeID := strings.TrimSpace(r.PathValue("nodeID"))
	if nodeID == "" || nodeID == s.cfg.NodeID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "不能移除本机服务器"})
		return
	}

	s.mu.RLock()
	displayName := s.cfg.DisplayName
	region := s.cfg.Region
	publicIP := s.cfg.PublicIP
	var nextPeers []config.PeerNodeConfig
	removed := false
	for _, p := range s.cfg.Peers {
		if p.NodeID == nodeID {
			removed = true
			continue
		}
		nextPeers = append(nextPeers, p)
	}
	onUpdate := s.onNodesConfigFn
	s.mu.RUnlock()

	if !removed {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "未找到该远端服务器"})
		return
	}
	if nextPeers == nil {
		nextPeers = []config.PeerNodeConfig{}
	}

	if onUpdate != nil {
		if err := onUpdate(displayName, region, publicIP, nextPeers); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "移除服务器失败：" + err.Error()})
			return
		}
	}

	s.mu.Lock()
	s.cfg.Peers = nextPeers
	view := s.buildNodesConfigViewLocked()
	s.mu.Unlock()

	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: user,
		NodeID:   s.cfg.NodeID,
		Action:   "delete_peer_node",
		Target:   nodeID,
		Detail:   fmt.Sprintf("移除远端服务器 %s", nodeID),
	})
	writeJSON(w, http.StatusOK, view)
}

// Peer cluster handlers
func (s *Server) handlePeerLive(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	local := s.local
	s.mu.RUnlock()
	writeJSON(w, http.StatusOK, local)
}

func (s *Server) handlePeerTimeline(w http.ResponseWriter, r *http.Request) {
	channelID := r.URL.Query().Get("channel_id")
	now := time.Now().Unix()
	toTS := parseInt64Query(r, "to", now)
	fromTS := parseInt64Query(r, "from", toTS-1800)

	chs, err := s.store.QueryChannelTimeline(r.Context(), s.cfg.NodeID, channelID, fromTS, toTS, 900)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	hosts, _ := s.store.QueryHostTimeline(r.Context(), s.cfg.NodeID, fromTS, toTS, 900)
	writeJSON(w, http.StatusOK, cluster.PeerTimelinePayload{
		NodeID:  s.cfg.NodeID,
		Channel: chs,
		Host:    hosts,
	})
}

func (s *Server) handlePeerRestart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChannelID string `json:"channel_id"`
		Operator  string `json:"operator"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.ChannelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	if s.restartFn == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "restart not configured"})
		return
	}
	if err := s.restartFn(r.Context(), body.ChannelID); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: "peer:" + body.Operator,
		NodeID:   s.cfg.NodeID,
		Action:   "safe_single_restart",
		Target:   body.ChannelID,
		Detail:   "由集群控制台发起的单路安全重启",
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handlePeerChannelPower(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ChannelID string `json:"channel_id"`
		Action    string `json:"action"` // start | stop
		Operator  string `json:"operator"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&body); err != nil || body.ChannelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request"})
		return
	}
	if body.Action != "start" && body.Action != "stop" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "action must be start or stop"})
		return
	}
	if s.powerFn == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "power control not configured"})
		return
	}
	start := body.Action == "start"
	if err := s.powerFn(r.Context(), body.ChannelID, start); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	actionName := "stop_signal_stream"
	detail := "由集群控制台停止单路容器"
	if start {
		actionName = "start_signal_stream"
		detail = "由集群控制台启动单路容器"
	}
	_ = s.store.InsertAudit(r.Context(), model.AuditEntry{
		Username: "peer:" + body.Operator,
		NodeID:   s.cfg.NodeID,
		Action:   actionName,
		Target:   body.ChannelID,
		Detail:   detail,
	})
	s.triggerRefresh()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleChannelLogs(w http.ResponseWriter, r *http.Request, _ string) {
	nodeID := r.PathValue("nodeID")
	channelID := r.PathValue("channelID")
	sinceSec := int(parseInt64Query(r, "since", 1800))
	tail := int(parseInt64Query(r, "tail", 300))
	if tail < 20 {
		tail = 20
	}
	if tail > 1000 {
		tail = 1000
	}
	hideStats := r.URL.Query().Get("hide_stats") == "1" || r.URL.Query().Get("hide_stats") == "true"

	var raw string
	var err error
	if nodeID == s.cfg.NodeID {
		if s.logsFn == nil {
			writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "logs fetcher not configured"})
			return
		}
		raw, err = s.logsFn(r.Context(), channelID, sinceSec, tail)
	} else {
		raw, err = s.clusterMgr.QueryPeerLogs(r.Context(), nodeID, channelID, sinceSec, tail)
	}
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "日志读取失败：" + err.Error()})
		return
	}

	all := parseLogLines(raw)
	filtered := make([]LogLine, 0, len(all))
	for _, l := range all {
		if hideStats && l.IsStats {
			continue
		}
		filtered = append(filtered, l)
	}
	writeJSON(w, http.StatusOK, ChannelLogsResponse{
		NodeID:     nodeID,
		ChannelID:  channelID,
		FetchedAt:  time.Now().Unix(),
		TotalLines: len(all),
		Lines:      filtered,
	})
}

func (s *Server) handlePeerLogs(w http.ResponseWriter, r *http.Request) {
	channelID := r.URL.Query().Get("channel_id")
	if channelID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "channel_id required"})
		return
	}
	if s.logsFn == nil {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "logs fetcher not configured"})
		return
	}
	sinceSec := int(parseInt64Query(r, "since", 1800))
	tail := int(parseInt64Query(r, "tail", 300))
	raw, err := s.logsFn(r.Context(), channelID, sinceSec, tail)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"raw": raw})
}

func (s *Server) handleChannelThumbnail(w http.ResponseWriter, r *http.Request, _ string) {
	nodeID := r.PathValue("nodeID")
	channelID := r.PathValue("channelID")
	label := r.URL.Query().Get("label")

	if nodeID == s.cfg.NodeID {
		if s.thumbnailFn != nil {
			if data, ct, ok := s.thumbnailFn(channelID); ok && len(data) > 0 {
				w.Header().Set("Content-Type", ct)
				w.Header().Set("Cache-Control", "no-store")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(data)
				return
			}
		}
	} else if !s.cfg.DemoMode {
		data, ct, err := s.clusterMgr.QueryPeerThumbnail(r.Context(), nodeID, channelID)
		if err == nil && len(data) > 0 {
			w.Header().Set("Content-Type", ct)
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
	}

	if s.cfg.DemoMode {
		sample, foundLabel := s.lookupLiveSample(nodeID, channelID)
		if label == "" {
			label = foundLabel
		}
		svg := preview.RenderDemoMonitorSVG(label, sample, time.Now())
		w.Header().Set("Content-Type", "image/svg+xml; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(svg)
		return
	}

	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handlePeerThumbnail(w http.ResponseWriter, r *http.Request) {
	channelID := r.URL.Query().Get("channel_id")
	if channelID == "" || s.thumbnailFn == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	data, ct, ok := s.thumbnailFn(channelID)
	if !ok || len(data) == 0 {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *Server) lookupLiveSample(nodeID, channelID string) (model.ChannelSample, string) {
	s.mu.RLock()
	ov := s.overview
	s.mu.RUnlock()
	for _, g := range ov.Groups {
		for _, leg := range g.Legs {
			if leg.NodeID == nodeID && leg.ChannelID == channelID {
				return leg.Sample, g.Name
			}
		}
	}
	for _, n := range ov.Nodes {
		if n.NodeID == nodeID {
			if cs, ok := n.Channels[channelID]; ok {
				return cs, channelID
			}
		}
	}
	return model.ChannelSample{NodeID: nodeID, ChannelID: channelID}, channelID
}

func parseLogLines(raw string) []LogLine {
	var out []LogLine
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		tsStr := ""
		text := trimmed
		if sp := strings.IndexByte(trimmed, ' '); sp > 0 {
			if parsed, err := time.Parse(time.RFC3339Nano, trimmed[:sp]); err == nil {
				tsStr = parsed.Local().Format("15:04:05")
				text = strings.TrimSpace(trimmed[sp+1:])
			}
		}
		isStats := strings.HasPrefix(text, "{") && strings.Contains(text, `"link"`)
		level := "info"
		lower := strings.ToLower(text)
		switch {
		case isStats:
			level = "stats"
		case strings.Contains(lower, "dropped") || strings.Contains(lower, "error") || strings.Contains(lower, "disconnected") || strings.Contains(lower, "failed"):
			level = "error"
		case strings.Contains(lower, "warn") || strings.Contains(lower, "silent") || strings.Contains(lower, "lost"):
			level = "warn"
		case strings.Contains(lower, "accepted") || strings.Contains(lower, "connected") || strings.Contains(lower, "handshake"):
			level = "connect"
		}
		out = append(out, LogLine{
			TS:      tsStr,
			Level:   level,
			IsStats: isStats,
			Text:    text,
		})
	}
	return out
}

func (s *Server) spaHandler(assets fs.FS) http.Handler {
	sub, err := fs.Sub(assets, "dist")
	if err != nil {
		sub = assets
	}
	fileServer := http.FileServer(http.FS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		clean := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if clean == "" {
			clean = "index.html"
		}
		if _, err := fs.Stat(sub, clean); err == nil {
			fileServer.ServeHTTP(w, r)
			return
		}
		// Fallback to index.html for client-side SPA routes
		indexBytes, err := fs.ReadFile(sub, "index.html")
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(indexBytes)
	})
}

func parseInt64Query(r *http.Request, key string, fallback int64) int64 {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	v, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fallback
	}
	return v
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// NewFeishuTestFunc creates a helper callback to send a diagnostic test card.
func NewFeishuTestFunc(cfg config.NodeConfig) func(context.Context) error {
	if !cfg.Feishu.Enabled || cfg.Feishu.WebhookURL == "" {
		return nil
	}
	sender := notify.NewWebhookSender(cfg.Feishu.WebhookURL, cfg.Feishu.Secret)
	return func(ctx context.Context) error {
		return sender.Send(ctx, notify.FeishuCard{
			Title:    fmt.Sprintf("[测试] SRT-CAM 告警连通正常 · %s", cfg.DisplayName),
			Template: "blue",
			Lines: []string{
				fmt.Sprintf("**节点**：%s (%s)", cfg.DisplayName, cfg.NodeID),
				fmt.Sprintf("**时间**：%s", time.Now().Format("2006-01-02 15:04:05")),
				"**状态**：Webhook 连通正常",
			},
			LinkURL: cfg.Feishu.DashboardBaseURL,
		})
	}
}
