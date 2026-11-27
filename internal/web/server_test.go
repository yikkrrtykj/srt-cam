package web

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yikkrrtykj/srt-cam/internal/auth"
	"github.com/yikkrrtykj/srt-cam/internal/cluster"
	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/storage"
)

func TestAPIAuthOverviewRestartAndEventSheet(t *testing.T) {
	hash, err := auth.HashPassword("test-pass-123")
	if err != nil {
		t.Fatal(err)
	}
	cfg := config.DefaultNodeConfig()
	cfg.Auth.Username = "admin"
	cfg.Auth.PasswordHash = hash
	cfg.Auth.SessionSecret = "0123456789abcdef0123456789abcdef"
	cfg.ClusterToken = "peer-secret"

	st, err := storage.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	evStore, err := config.NewEventStore("", cfg.NodeID)
	if err != nil {
		t.Fatal(err)
	}
	authMgr := auth.NewManager(cfg.Auth, cfg.ClusterToken)
	clusterMgr := cluster.NewManager(cfg)

	restarted := ""
	srv := NewServer(cfg, evStore, st, authMgr, clusterMgr, func(_ context.Context, cid string) error {
		restarted = cid
		return nil
	}, nil, nil)

	local := model.NodeLiveStatus{
		NodeID: cfg.NodeID, DisplayName: cfg.DisplayName, Online: true,
		Channels: map[string]model.ChannelSample{
			"srt-cam1": {NodeID: cfg.NodeID, ChannelID: "srt-cam1", Mode: model.ModeSRTRelay, ProcessState: "running", FaultCode: model.FaultHealthy},
		},
	}
	srv.UpdateSnapshot(local, map[string]model.NodeLiveStatus{cfg.NodeID: local}, evStore.Get())
	handler := srv.Handler()

	// Unauthenticated overview must return 401
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated overview = %d, want 401", rec.Code)
	}

	// Login
	loginBody, _ := json.Marshal(map[string]string{"username": "admin", "password": "test-pass-123"})
	recLogin := httptest.NewRecorder()
	handler.ServeHTTP(recLogin, httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody)))
	if recLogin.Code != http.StatusOK {
		t.Fatalf("login failed: %d %s", recLogin.Code, recLogin.Body.String())
	}
	cookie := recLogin.Result().Cookies()[0]

	// Authenticated overview
	reqOv := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	reqOv.AddCookie(cookie)
	recOv := httptest.NewRecorder()
	handler.ServeHTTP(recOv, reqOv)
	if recOv.Code != http.StatusOK {
		t.Fatalf("overview failed: %d", recOv.Code)
	}

	// Safe restart rejects mismatched confirm_channel_id
	badRestart, _ := json.Marshal(map[string]string{"confirm_channel_id": "wrong"})
	reqBad := httptest.NewRequest(http.MethodPost, "/api/v1/channels/vps-1/srt-cam1/restart", bytes.NewReader(badRestart))
	reqBad.AddCookie(cookie)
	recBad := httptest.NewRecorder()
	handler.ServeHTTP(recBad, reqBad)
	if recBad.Code != http.StatusBadRequest || restarted != "" {
		t.Fatalf("expected 400 on mismatched confirm, got %d restarted=%q", recBad.Code, restarted)
	}

	// Safe restart succeeds with exact confirm_channel_id and writes audit log
	okRestart, _ := json.Marshal(map[string]string{"confirm_channel_id": "srt-cam1"})
	reqOK := httptest.NewRequest(http.MethodPost, "/api/v1/channels/vps-1/srt-cam1/restart", bytes.NewReader(okRestart))
	reqOK.AddCookie(cookie)
	recOK := httptest.NewRecorder()
	handler.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK || restarted != "srt-cam1" {
		t.Fatalf("expected restart srt-cam1, got code=%d restarted=%q", recOK.Code, restarted)
	}

	// Toggle expected_active
	toggleBody := bytes.NewBufferString(`{"expected_active":true}`)
	reqTog := httptest.NewRequest(http.MethodPatch, "/api/v1/signal-groups/cam1/expected-active", toggleBody)
	reqTog.AddCookie(cookie)
	recTog := httptest.NewRecorder()
	handler.ServeHTTP(recTog, reqTog)
	if recTog.Code != http.StatusOK {
		t.Fatalf("toggle expected_active failed: %d %s", recTog.Code, recTog.Body.String())
	}
	if !evStore.Get().SignalGroups[0].ExpectedActive {
		t.Fatalf("expected cam1 ExpectedActive=true")
	}

	// Channel logs endpoint with hide_stats=1 filtering
	srv.SetLogsFunc(func(_ context.Context, _ string, _, _ int) (string, error) {
		return "2026-11-26T20:00:01Z Accepted SRT source connection\n" +
			"2026-11-26T20:00:02Z {\"sid\":1,\"link\":{\"rtt\":45}}\n" +
			"2026-11-26T20:00:03Z RCV-DROPPED 2 packets\n", nil
	})
	reqLog := httptest.NewRequest(http.MethodGet, "/api/v1/channels/vps-1/srt-cam1/logs?hide_stats=1", nil)
	reqLog.AddCookie(cookie)
	recLog := httptest.NewRecorder()
	handler.ServeHTTP(recLog, reqLog)
	if recLog.Code != http.StatusOK {
		t.Fatalf("logs endpoint failed: %d %s", recLog.Code, recLog.Body.String())
	}
	var logResp ChannelLogsResponse
	if err := json.Unmarshal(recLog.Body.Bytes(), &logResp); err != nil {
		t.Fatal(err)
	}
	if logResp.TotalLines != 3 || len(logResp.Lines) != 2 || logResp.Lines[0].Level != "connect" || logResp.Lines[1].Level != "error" {
		t.Fatalf("unexpected logs response: %+v", logResp)
	}

	// Thumbnail returns 204 when not configured in production mode
	reqThumbEmpty := httptest.NewRequest(http.MethodGet, "/api/v1/channels/vps-1/srt-cam1/thumbnail", nil)
	reqThumbEmpty.AddCookie(cookie)
	recThumbEmpty := httptest.NewRecorder()
	handler.ServeHTTP(recThumbEmpty, reqThumbEmpty)
	if recThumbEmpty.Code != http.StatusNoContent {
		t.Fatalf("empty thumbnail = %d, want 204", recThumbEmpty.Code)
	}

	// Thumbnail returns 200 image/jpeg when ThumbnailFunc serves bytes
	srv.SetThumbnailFunc(func(_ string) ([]byte, string, bool) {
		return []byte{0xFF, 0xD8, 0xFF}, "image/jpeg", true
	})
	reqThumb := httptest.NewRequest(http.MethodGet, "/api/v1/channels/vps-1/srt-cam1/thumbnail", nil)
	reqThumb.AddCookie(cookie)
	recThumb := httptest.NewRecorder()
	handler.ServeHTTP(recThumb, reqThumb)
	if recThumb.Code != http.StatusOK || recThumb.Header().Get("Content-Type") != "image/jpeg" {
		t.Fatalf("thumbnail = (%d, %q), want (200, image/jpeg)", recThumb.Code, recThumb.Header().Get("Content-Type"))
	}

	// GET /api/v1/alerts/config returns sanitized initial defaults
	reqAC := httptest.NewRequest(http.MethodGet, "/api/v1/alerts/config", nil)
	reqAC.AddCookie(cookie)
	recAC := httptest.NewRecorder()
	handler.ServeHTTP(recAC, reqAC)
	if recAC.Code != http.StatusOK {
		t.Fatalf("GET alerts/config = %d %s", recAC.Code, recAC.Body.String())
	}
	var acView AlertConfigView
	if err := json.Unmarshal(recAC.Body.Bytes(), &acView); err != nil {
		t.Fatal(err)
	}
	if acView.Feishu.Enabled || acView.Feishu.WebhookConfigured {
		t.Fatalf("unexpected initial alert config: %+v", acView)
	}

	// PUT /api/v1/alerts/config rejects enabling without webhook
	badAC := bytes.NewBufferString(`{"feishu":{"enabled":true,"debounce_sec":10,"cooldown_sec":180,"watchdog_sec":20},"thresholds":{"min_flow_mbps":0.1,"high_rtt_ms":250}}`)
	reqBadAC := httptest.NewRequest(http.MethodPut, "/api/v1/alerts/config", badAC)
	reqBadAC.AddCookie(cookie)
	recBadAC := httptest.NewRecorder()
	handler.ServeHTTP(recBadAC, reqBadAC)
	if recBadAC.Code != http.StatusBadRequest {
		t.Fatalf("PUT alerts/config without webhook = %d, want 400", recBadAC.Code)
	}

	// Local mock Feishu webhook server verifies live hot-reload + secret masking
	feishuHits := 0
	mockFeishu := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		feishuHits++
		w.WriteHeader(http.StatusOK)
	}))
	defer mockFeishu.Close()

	var savedFeishu config.FeishuConfig
	var savedTh config.ThresholdConfig
	srv.SetAlertConfigCallback(true, func(f config.FeishuConfig, th config.ThresholdConfig) error {
		savedFeishu = f
		savedTh = th
		return nil
	})

	putPayload := map[string]any{
		"feishu": map[string]any{
			"enabled":            true,
			"webhook_url":        mockFeishu.URL + "/open-apis/bot/v2/hook/secret-token-123456",
			"secret":             "my-sign-secret",
			"debounce_sec":       12,
			"cooldown_sec":       120,
			"watchdog_sec":       25,
			"dashboard_base_url": "https://cam.example.com/",
		},
		"thresholds": map[string]any{
			"min_flow_mbps":        0.25,
			"high_rtt_ms":          180,
			"high_loss_per_sample": 15,
			"high_retrans":         25,
			"high_nak_lost":        15,
			"udp_buf_drop_trigger": 5,
		},
	}
	putBytes, _ := json.Marshal(putPayload)
	reqPutAC := httptest.NewRequest(http.MethodPut, "/api/v1/alerts/config", bytes.NewReader(putBytes))
	reqPutAC.AddCookie(cookie)
	recPutAC := httptest.NewRecorder()
	handler.ServeHTTP(recPutAC, reqPutAC)
	if recPutAC.Code != http.StatusOK {
		t.Fatalf("PUT alerts/config = %d %s", recPutAC.Code, recPutAC.Body.String())
	}
	var updatedView AlertConfigView
	if err := json.Unmarshal(recPutAC.Body.Bytes(), &updatedView); err != nil {
		t.Fatal(err)
	}
	if !updatedView.Feishu.Enabled || !updatedView.Feishu.WebhookConfigured || !updatedView.Feishu.SecretConfigured || !updatedView.Persistent {
		t.Fatalf("unexpected updated view: %+v", updatedView)
	}
	if updatedView.Feishu.WebhookMasked != mockFeishu.URL+"/open-apis/bot/v2/hook/****123456" {
		t.Fatalf("webhook masking mismatch: got %q", updatedView.Feishu.WebhookMasked)
	}
	if savedFeishu.DebounceSec != 12 || savedTh.HighRTTMs != 180 {
		t.Fatalf("callback did not receive updated values: %+v %+v", savedFeishu, savedTh)
	}

	// Partial update omitting webhook_url & secret keeps existing secrets intact
	partialBytes := bytes.NewBufferString(`{"feishu":{"enabled":true,"debounce_sec":15,"cooldown_sec":120,"watchdog_sec":25,"dashboard_base_url":"https://cam.example.com"},"thresholds":{"min_flow_mbps":0.25,"high_rtt_ms":200,"high_loss_per_sample":15,"high_retrans":25,"high_nak_lost":15,"udp_buf_drop_trigger":5}}`)
	reqPartial := httptest.NewRequest(http.MethodPut, "/api/v1/alerts/config", partialBytes)
	reqPartial.AddCookie(cookie)
	recPartial := httptest.NewRecorder()
	handler.ServeHTTP(recPartial, reqPartial)
	if recPartial.Code != http.StatusOK || savedFeishu.Secret != "my-sign-secret" || savedFeishu.DebounceSec != 15 {
		t.Fatalf("partial update broke secrets: code=%d feishu=%+v", recPartial.Code, savedFeishu)
	}

	// POST /api/v1/alerts/test now delivers to the newly saved webhook
	reqTest := httptest.NewRequest(http.MethodPost, "/api/v1/alerts/test", nil)
	reqTest.AddCookie(cookie)
	recTest := httptest.NewRecorder()
	handler.ServeHTTP(recTest, reqTest)
	if recTest.Code != http.StatusOK || feishuHits != 1 {
		t.Fatalf("POST alerts/test = %d (hits=%d) body=%s", recTest.Code, feishuHits, recTest.Body.String())
	}

	// Node & Peer management APIs
	var latestPeers []config.PeerNodeConfig
	srv.SetNodesConfigCallback(func(displayName, region, publicIP string, peers []config.PeerNodeConfig) error {
		latestPeers = peers
		return nil
	})

	reqLocal := httptest.NewRequest(http.MethodPut, "/api/v1/nodes/local", bytes.NewBufferString(`{"display_name":"新加坡主节点","region":"Singapore","public_ip":"198.51.100.11"}`))
	reqLocal.AddCookie(cookie)
	recLocal := httptest.NewRecorder()
	handler.ServeHTTP(recLocal, reqLocal)
	if recLocal.Code != http.StatusOK {
		t.Fatalf("PUT nodes/local = %d %s", recLocal.Code, recLocal.Body.String())
	}

	reqAddPeer := httptest.NewRequest(http.MethodPost, "/api/v1/nodes/peers", bytes.NewBufferString(`{"node_id":"vps-2","display_name":"香港备节点","region":"HongKong","public_ip":"198.51.100.12","api_url":"http://198.51.100.12:18080/"}`))
	reqAddPeer.AddCookie(cookie)
	recAddPeer := httptest.NewRecorder()
	handler.ServeHTTP(recAddPeer, reqAddPeer)
	if recAddPeer.Code != http.StatusOK || len(latestPeers) != 1 || latestPeers[0].APIToken != "peer-secret" {
		t.Fatalf("POST nodes/peers = %d peers=%+v body=%s", recAddPeer.Code, latestPeers, recAddPeer.Body.String())
	}

	reqDelPeer := httptest.NewRequest(http.MethodDelete, "/api/v1/nodes/peers/vps-2", nil)
	reqDelPeer.AddCookie(cookie)
	recDelPeer := httptest.NewRecorder()
	handler.ServeHTTP(recDelPeer, reqDelPeer)
	if recDelPeer.Code != http.StatusOK || len(latestPeers) != 0 {
		t.Fatalf("DELETE nodes/peers/vps-2 = %d peers=%+v", recDelPeer.Code, latestPeers)
	}

	// EventSheet rejects 2 primary legs or duplicate server+channel
	dupSheet := `{"event_name":"test","sites":{"venue":"A","hub":"B"},"signal_groups":[{"id":"g1","name":"CAM1","direction":"venue_to_hub","redundancy_type":"dual_hardware","expected_active":true,"legs":[{"role":"primary","node_id":"vps-1","channel_id":"srt-cam1","mode":"srt-relay","in_port":21111,"out_port":11111},{"role":"primary","node_id":"vps-1","channel_id":"srt-cam2","mode":"srt-relay","in_port":21112,"out_port":11112}]}]}`
	reqDup := httptest.NewRequest(http.MethodPut, "/api/v1/event-sheet", bytes.NewBufferString(dupSheet))
	reqDup.AddCookie(cookie)
	recDup := httptest.NewRecorder()
	handler.ServeHTTP(recDup, reqDup)
	if recDup.Code != http.StatusBadRequest {
		t.Fatalf("PUT duplicate primary roles = %d, want 400", recDup.Code)
	}

	// Stream power switch + live-stop safety guard + running edit lock
	var powerOps []string
	srv.SetPowerFunc(func(_ context.Context, cid string, start bool) error {
		if start {
			powerOps = append(powerOps, "start:"+cid)
		} else {
			powerOps = append(powerOps, "stop:"+cid)
		}
		return nil
	})

	// Make cam1 appear actively flowing (12.5 Mb/s) -> stopping without force must return 409
	localFlowing := model.NodeLiveStatus{
		NodeID: cfg.NodeID, DisplayName: cfg.DisplayName, Online: true,
		Channels: map[string]model.ChannelSample{
			"srt-cam1": {NodeID: cfg.NodeID, ChannelID: "srt-cam1", Mode: model.ModeSRTRelay, ProcessState: "running", SrcConnected: true, SrcMbps: 12.5, FaultCode: model.FaultHealthy},
		},
	}
	srv.UpdateSnapshot(localFlowing, map[string]model.NodeLiveStatus{cfg.NodeID: localFlowing}, evStore.Get())

	reqStopNoForce := httptest.NewRequest(http.MethodPatch, "/api/v1/signal-groups/cam1/enabled", bytes.NewBufferString(`{"enabled":false,"force":false}`))
	reqStopNoForce.AddCookie(cookie)
	recStopNoForce := httptest.NewRecorder()
	handler.ServeHTTP(recStopNoForce, reqStopNoForce)
	if recStopNoForce.Code != http.StatusConflict {
		t.Fatalf("stop flowing stream without force = %d, want 409 (%s)", recStopNoForce.Code, recStopNoForce.Body.String())
	}

	// While cam1 is running, renaming is allowed but changing channel/port returns 409
	curSheet := evStore.Get()
	curSheet.SignalGroups[0].Name = "主机位 PGM"
	renameBody, _ := json.Marshal(curSheet)
	reqRename := httptest.NewRequest(http.MethodPut, "/api/v1/event-sheet", bytes.NewReader(renameBody))
	reqRename.AddCookie(cookie)
	recRename := httptest.NewRecorder()
	handler.ServeHTTP(recRename, reqRename)
	if recRename.Code != http.StatusOK {
		t.Fatalf("rename running stream = %d, want 200 (%s)", recRename.Code, recRename.Body.String())
	}

	badLockSheet := evStore.Get()
	badLockSheet.SignalGroups[0].Legs[0].InPort = 20099
	badLockBody, _ := json.Marshal(badLockSheet)
	reqBadLock := httptest.NewRequest(http.MethodPut, "/api/v1/event-sheet", bytes.NewReader(badLockBody))
	reqBadLock.AddCookie(cookie)
	recBadLock := httptest.NewRecorder()
	handler.ServeHTTP(recBadLock, reqBadLock)
	if recBadLock.Code != http.StatusConflict {
		t.Fatalf("modify port on running stream = %d, want 409 (%s)", recBadLock.Code, recBadLock.Body.String())
	}

	// Stopping with force=true stops container and unlocks transport editing
	reqStopForce := httptest.NewRequest(http.MethodPatch, "/api/v1/signal-groups/cam1/enabled", bytes.NewBufferString(`{"enabled":false,"force":true}`))
	reqStopForce.AddCookie(cookie)
	recStopForce := httptest.NewRecorder()
	handler.ServeHTTP(recStopForce, reqStopForce)
	if recStopForce.Code != http.StatusOK {
		t.Fatalf("force stop stream = %d, want 200 (%s)", recStopForce.Code, recStopForce.Body.String())
	}

	unlockedSheet := evStore.Get()
	unlockedSheet.SignalGroups[0].Legs[0].InPort = 20099
	unlockedBody, _ := json.Marshal(unlockedSheet)
	reqUnlocked := httptest.NewRequest(http.MethodPut, "/api/v1/event-sheet", bytes.NewReader(unlockedBody))
	reqUnlocked.AddCookie(cookie)
	recUnlocked := httptest.NewRecorder()
	handler.ServeHTTP(recUnlocked, reqUnlocked)
	if recUnlocked.Code != http.StatusOK {
		t.Fatalf("modify port on stopped stream = %d, want 200 (%s)", recUnlocked.Code, recUnlocked.Body.String())
	}

	// Peer channel-power endpoint accepts Bearer cluster token
	reqPeerPow := httptest.NewRequest(http.MethodPost, "/api/peer/channel-power", bytes.NewBufferString(`{"channel_id":"srt-cam1","action":"start","operator":"admin"}`))
	reqPeerPow.Header.Set("Authorization", "Bearer peer-secret")
	recPeerPow := httptest.NewRecorder()
	handler.ServeHTTP(recPeerPow, reqPeerPow)
	if recPeerPow.Code != http.StatusOK {
		t.Fatalf("peer channel-power = %d, want 200 (%s)", recPeerPow.Code, recPeerPow.Body.String())
	}
	if len(powerOps) != 2 || powerOps[0] != "stop:srt-cam1" || powerOps[1] != "start:srt-cam1" {
		t.Fatalf("unexpected powerOps: %+v", powerOps)
	}
}

