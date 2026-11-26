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
}
