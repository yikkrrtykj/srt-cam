package preview

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/relaytee"
)

func TestHTTPSnapshotGrabberAndOnDemandTouch(t *testing.T) {
	fakeJPG := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write(fakeJPG)
	}))
	defer ts.Close()

	mgr := NewManager([]config.PreviewTarget{
		{ChannelID: "srt-cam5", InputURL: ts.URL, IntervalSec: 3},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	mgr.Start(ctx)

	// Touch wakes on-demand async capture immediately
	mgr.Touch("srt-cam5")
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if snap, ok := mgr.Snapshot("srt-cam5", 10*time.Second); ok {
			if snap.ContentType != "image/jpeg" || len(snap.Data) != len(fakeJPG) {
				t.Fatalf("unexpected snapshot ct=%q len=%d", snap.ContentType, len(snap.Data))
			}
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for on-demand HTTP snapshot")
}

func TestSyncEventSheetAutoPreviewAndHealthzPreflight(t *testing.T) {
	// Mock local srt-relayd preview tap reporting flowing=true on /healthz
	tap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true,"flowing":true,"packets":42}`))
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer tap.Close()

	mgr := NewManager(nil)
	mgr.SyncEventSheet("vps-1", config.EventSheet{
		SignalGroups: []config.SignalGroupConfig{
			{
				ID: "ob-pgm",
				Legs: []config.LegConfig{
					{NodeID: "vps-1", ChannelID: "srt-cam1", Mode: model.ModeSRTRelay, InPort: 20001},
					{NodeID: "vps-1", ChannelID: "srt-cam5", Mode: model.ModeSRTRelay, InPort: 21115},
					{NodeID: "vps-1", ChannelID: "srt-pass1", Mode: model.ModeUDPPassthrough, InPort: 31111},
				},
			},
		},
	})

	mgr.mu.RLock()
	newTarget, okNew := mgr.targets["srt-cam1"]
	autoTarget, okRelay := mgr.targets["srt-cam5"]
	_, okPass := mgr.targets["srt-pass1"]
	mgr.mu.RUnlock()

	if !okNew || newTarget.InputURL != "http://127.0.0.1:28001/ts" {
		t.Fatalf("new v2 preview target = (%v, %+v), want http://127.0.0.1:28001/ts", okNew, newTarget)
	}
	if !okRelay || autoTarget.InputURL != "http://127.0.0.1:29115/ts" {
		t.Fatalf("legacy preview target = (%v, %+v), want http://127.0.0.1:29115/ts", okRelay, autoTarget)
	}
	if okPass {
		t.Fatalf("Mode B passthrough must not auto-register /ts preview target")
	}
	if !mgr.isLocalTapFlowing(context.Background(), tap.URL+"/ts") {
		t.Fatalf("expected /healthz preflight flowing=true")
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

	stopped := string(RenderDemoMonitorSVG("CAM9", model.ChannelSample{
		ChannelID: "srt-cam9", SrcConnected: false, SrcMbps: 0, FaultCode: model.FaultStreamStopped,
	}, now))
	if !strings.Contains(stopped, "STOPPED") {
		t.Fatalf("expected STOPPED in stopped SVG")
	}

	live := string(RenderDemoMonitorSVG("OB-PGM", model.ChannelSample{
		ChannelID: "srt-cam5", Mode: model.ModeSRTRelay, SrcConnected: true, SrcMbps: 12.4,
	}, now))
	if !strings.Contains(live, "OB-PGM") || !strings.Contains(live, "PGM") {
		t.Fatalf("expected live PGM monitor SVG, got: %s", live[:120])
	}
}

func TestParseFFmpegVideoMeta(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		fps        float64
		res        string
		codec      string
		audioCodec string
		audioRate  int
		audioKbps  int
		audioCh    string
		tracks     int
	}{
		{
			name: "1080p59.94 h264 + aac 48k 179k stereo",
			input: "Input #0, mpegts, from 'http://127.0.0.1:28001/ts':\n" +
				"  Stream #0:0[0x100]: Video: h264 (High) ([27][0][0][0] / 0x001B), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 59.94 fps, 59.94 tbr, 90k tbn\n" +
				"  Stream #0:1[0x101]: Audio: aac (LC) ([15][0][0][0] / 0x000F), 48000 Hz, stereo, fltp, 179 kb/s\n" +
				"Output #0, image2pipe, to 'pipe:1':\n" +
				"  Stream #0:0: Video: mjpeg, yuvj420p, 320x180, q=2-31, 200 kb/s, 59.94 fps\n",
			fps: 59.94, res: "1920x1080", codec: "H.264",
			audioCodec: "AAC", audioRate: 48000, audioKbps: 179, audioCh: "stereo", tracks: 1,
		},
		{
			name: "multi-track aac + mp2",
			input: "Input #0, mpegts, from 'pipe:0':\n" +
				"  Stream #0:0[0x100]: Video: hevc (Main 10), yuv420p10le, 3840x2160, 50 tbr, 90k tbn\n" +
				"  Stream #0:1[0x101]: Audio: ac3 (AC-3 / 0x332D4341), 48000 Hz, 5.1(side), fltp, 384 kb/s\n" +
				"  Stream #0:2[0x102]: Audio: mp2 ([3][0][0][0] / 0x0003), 48000 Hz, stereo, fltp, 256 kb/s\n",
			fps: 50, res: "3840x2160", codec: "HEVC",
			audioCodec: "AC-3", audioRate: 48000, audioKbps: 384, audioCh: "5.1", tracks: 2,
		},
		{
			name: "audio only without video",
			input: "  Stream #0:0: Audio: aac, 44100 Hz, mono, fltp, 128 kb/s\n",
			fps: 0, res: "", codec: "",
			audioCodec: "AAC", audioRate: 44100, audioKbps: 128, audioCh: "mono", tracks: 1,
		},
		{
			name: "video only without audio",
			input: "  Stream #0:0[0x100]: Video: h264, yuv420p, 1920x1080, 25 fps\n",
			fps: 25, res: "1920x1080", codec: "H.264",
			audioCodec: "", audioRate: 0, audioKbps: 0, audioCh: "", tracks: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ParseFFmpegVideoMeta(tc.input)
			if got.FPS != tc.fps || got.Resolution != tc.res || got.Codec != tc.codec {
				t.Fatalf("video meta = %+v, want fps=%v res=%q codec=%q", got, tc.fps, tc.res, tc.codec)
			}
			if got.AudioCodec != tc.audioCodec || got.AudioSampleRate != tc.audioRate ||
				got.AudioBitrateKbps != tc.audioKbps || got.AudioChannels != tc.audioCh || got.AudioTracks != tc.tracks {
				t.Fatalf("audio meta = %+v, want codec=%q rate=%d kbps=%d ch=%q tracks=%d",
					got, tc.audioCodec, tc.audioRate, tc.audioKbps, tc.audioCh, tc.tracks)
			}
		})
	}
}

func TestEndToEndFFmpegKeyframeFromRelayTee(t *testing.T) {
	ffPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg not installed; skipping live MPEG-TS keyframe integration test")
	}

	// Sink UDP socket representing egress srt-live-transmit
	egressAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	egressConn, err := net.ListenUDP("udp", egressAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer egressConn.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()

	// Drain egress packets in background
	go func() {
		buf := make([]byte, 4096)
		for {
			if _, _, err := egressConn.ReadFromUDP(buf); err != nil {
				return
			}
		}
	}()

	tee, err := relaytee.New(relaytee.Config{
		ListenAddr:    "127.0.0.1:0",
		EgressAddr:    egressConn.LocalAddr().String(),
		HTTPAddr:      "127.0.0.1:0",
		StreamTimeout: 8 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := tee.Start(ctx); err != nil {
		t.Fatal(err)
	}

	// Generate a real live H.264 + AAC 48kHz MPEG-TS stream with 2-second GOP (60 frames @ 30fps)
	encCmd := exec.CommandContext(ctx, ffPath,
		"-nostdin", "-loglevel", "error",
		"-re", "-f", "lavfi", "-i", "smptebars=size=1280x720:rate=30",
		"-re", "-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=48000",
		"-pix_fmt", "yuv420p",
		"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
		"-b:v", "12000k", "-g", "60", "-keyint_min", "60",
		"-c:a", "aac", "-b:a", "192k", "-ac", "2", "-ar", "48000",
		"-f", "mpegts", "udp://"+tee.BoundUDPAddr()+"?pkt_size=1316",
	)
	if err := encCmd.Start(); err != nil {
		t.Fatalf("start ffmpeg test encoder: %v", err)
	}
	defer func() { _ = encCmd.Process.Kill(); _ = encCmd.Wait() }()

	// Join mid-GOP (~500ms after encoder starts) to verify real-world mid-stream keyframe grab
	time.Sleep(500 * time.Millisecond)

	mgr := NewManager([]config.PreviewTarget{
		{
			ChannelID:   "srt-cam5",
			InputURL:    "http://" + tee.BoundHTTPAddr() + "/ts",
			IntervalSec: 5,
		},
	})
	mgr.Start(ctx)
	mgr.Touch("srt-cam5")

	deadline := time.Now().Add(9 * time.Second)
	for time.Now().Before(deadline) {
		if snap, ok := mgr.Snapshot("srt-cam5", 15*time.Second); ok {
			if snap.ContentType != "image/jpeg" {
				t.Fatalf("content-type = %q, want image/jpeg", snap.ContentType)
			}
			if len(snap.Data) < 1000 || snap.Data[0] != 0xFF || snap.Data[1] != 0xD8 {
				t.Fatalf("invalid JPEG payload len=%d header=%x", len(snap.Data), snap.Data[:min(4, len(snap.Data))])
			}
			meta, okMeta := mgr.VideoMeta("srt-cam5", 15*time.Second)
			if !okMeta || meta.FPS != 30 || meta.Resolution != "1280x720" || meta.Codec != "H.264" {
				t.Fatalf("VideoMeta = (%v, %+v), want 30fps 1280x720 H.264", okMeta, meta)
			}
			if meta.AudioCodec != "AAC" || meta.AudioSampleRate != 48000 || meta.AudioTracks != 1 || meta.AudioBitrateKbps <= 0 {
				t.Fatalf("AudioMeta = %+v, want AAC 48000Hz bitrate>0 tracks=1", meta)
			}
			t.Logf("PASS: grabbed real 320x180 JPEG (%d bytes) + AV meta (%s %s %.0ffps | %s %dHz %dkbps)",
				len(snap.Data), meta.Resolution, meta.Codec, meta.FPS, meta.AudioCodec, meta.AudioSampleRate, meta.AudioBitrateKbps)
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for real JPEG keyframe from live MPEG-TS stream")
}

