package preview

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

func TestHTTPSnapshotGrabber(t *testing.T) {
	fakeJPG := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(fakeJPG)
	}))
	defer ts.Close()

	mgr := NewManager([]config.PreviewTarget{
		{ChannelID: "srt-cam5", InputURL: ts.URL, IntervalSec: 3},
	})
	mgr.captureOnce(context.Background(), mgr.targets[0])

	snap, ok := mgr.Snapshot("srt-cam5", 10*time.Second)
	if !ok {
		t.Fatalf("expected cached HTTP snapshot")
	}
	if snap.ContentType != "image/jpeg" || len(snap.Data) != len(fakeJPG) {
		t.Fatalf("unexpected snapshot ct=%q len=%d", snap.ContentType, len(snap.Data))
	}
}

func TestRenderDemoMonitorSVGStates(t *testing.T) {
	now := time.Unix(1730000000, 0).UTC()

	offline := string(RenderDemoMonitorSVG("EN-PGM", model.ChannelSample{
		ChannelID: "srt-pass1", SrcConnected: false, SrcMbps: 0, FaultCode: model.FaultUpstreamOffline,
	}, now))
	if !strings.Contains(offline, "NO SIGNAL") {
		t.Fatalf("expected NO SIGNAL in offline SVG")
	}

	encrypted := string(RenderDemoMonitorSVG("EN-PGM", model.ChannelSample{
		ChannelID: "srt-pass1", Mode: model.ModeUDPPassthrough, Encrypted: true, SrcConnected: true, SrcMbps: 12.1,
	}, now))
	if !strings.Contains(encrypted, "AES PASSTHROUGH") {
		t.Fatalf("expected AES PASSTHROUGH in encrypted Mode B SVG")
	}

	live := string(RenderDemoMonitorSVG("OB-PGM", model.ChannelSample{
		ChannelID: "srt-cam5", Mode: model.ModeSRTRelay, SrcConnected: true, SrcMbps: 12.4,
	}, now))
	if !strings.Contains(live, "OB-PGM") || !strings.Contains(live, "PGM") {
		t.Fatalf("expected live PGM monitor SVG, got: %s", live[:120])
	}
}
