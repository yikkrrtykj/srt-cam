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
	"github.com/yikkrrtykj/srt-cam/internal/storage"
)

// RestartFunc restarts a single local channel container.
type RestartFunc func(ctx context.Context, channelID string) error

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

// Server serves authenticated dashboard REST/SSE APIs, peer cluster APIs, and the embedded SPA.
type Server struct {
	cfg        config.NodeConfig
	events     *config.EventStore
	store      *storage.Store
	authMgr    *auth.Manager
	clusterMgr *cluster.Manager
	restartFn  RestartFunc
	logsFn     LogsFunc
	testFeishu func(ctx context.Context) error
	staticFS   fs.FS

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
	mux.HandleFunc("POST /api/v1/channels/{nodeID}/{channelID}/restart", s.withAuth(s.handleRestartChannel))
	mux.HandleFunc("GET /api/v1/channels/{nodeID}/{channelID}/logs", s.withAuth(s.handleChannelLogs))
	mux.HandleFunc("GET /api/v1/audit", s.withAuth(s.handleAudit))
	mux.HandleFunc("POST /api/v1/alerts/test", s.withAuth(s.handleTestAlert))

	// Peer VPS Cluster APIs (Bearer cluster_token)
	mux.HandleFunc("GET /api/peer/healthz", s.withClusterAuth(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "node_id": s.cfg.NodeID})
	}))
	mux.HandleFunc("GET /api/peer/live", s.withClusterAuth(s.handlePeerLive))
	mux.HandleFunc("GET /api/peer/timeline", s.withClusterAuth(s.handlePeerTimeline))
	mux.HandleFunc("GET /api/peer/logs", s.withClusterAuth(s.handlePeerLogs))
	mux.HandleFunc("POST /api/peer/restart", s.withClusterAuth(s.handlePeerRestart))

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

	legsOut := make([]LegTimeline, len(target.Legs))
	var wg sync.WaitGroup
	for idx, leg := range target.Legs {
		wg.Add(1)
		go func(i int, l config.LegConfig) {
			defer wg.Done()
			lt := LegTimeline{Leg: l, Node: l.NodeID}
			if l.NodeID == s.cfg.NodeID {
				lt.Node = s.cfg.DisplayName
				chs, err := s.store.QueryChannelTimeline(r.Context(), l.NodeID, l.ChannelID, fromTS, toTS, 900)
				if err != nil {
					lt.Error = err.Error()
				}
				hosts, _ := s.store.QueryHostTimeline(r.Context(), l.NodeID, fromTS, toTS, 900)
				lt.Samples = chs
				lt.Host = hosts
			} else {
				for _, p := range s.cfg.Peers {
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
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "event_sheet": sheet})
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

func (s *Server) handleTestAlert(w http.ResponseWriter, r *http.Request, user string) {
	if s.testFeishu == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "飞书 Webhook 未启用，请在 config.json 中开启 feishu.enabled"})
		return
	}
	if err := s.testFeishu(r.Context()); err != nil {
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
