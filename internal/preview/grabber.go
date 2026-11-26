package preview

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// Snapshot holds one captured thumbnail image in memory.
type Snapshot struct {
	Data        []byte
	ContentType string
	UpdatedAt   time.Time
}

// Manager runs optional, strictly bounded 5-second keyframe snapshot grabbers so
// thumbnail previews never compete with live broadcast SRT forwarding.
type Manager struct {
	targets    []config.PreviewTarget
	httpClient *http.Client
	ffmpegPath string

	mu    sync.RWMutex
	cache map[string]Snapshot
}

// NewManager initializes a preview thumbnail manager for the configured PreviewTargets.
func NewManager(targets []config.PreviewTarget) *Manager {
	ffPath, _ := exec.LookPath("ffmpeg")
	return &Manager{
		targets:    targets,
		httpClient: &http.Client{Timeout: 3 * time.Second},
		ffmpegPath: ffPath,
		cache:      make(map[string]Snapshot),
	}
}

// Start launches one low-priority background snapshot loop per configured PreviewTarget.
// It is a no-op when no preview targets are configured.
func (m *Manager) Start(ctx context.Context) {
	for _, t := range m.targets {
		if strings.TrimSpace(t.ChannelID) == "" || strings.TrimSpace(t.InputURL) == "" {
			continue
		}
		go m.runTarget(ctx, t)
	}
}

// Snapshot returns the most recent thumbnail for channelID if captured within maxAge.
func (m *Manager) Snapshot(channelID string, maxAge time.Duration) (Snapshot, bool) {
	if maxAge <= 0 {
		maxAge = 30 * time.Second
	}
	m.mu.RLock()
	snap, ok := m.cache[channelID]
	m.mu.RUnlock()
	if !ok || len(snap.Data) == 0 || time.Since(snap.UpdatedAt) > maxAge {
		return Snapshot{}, false
	}
	return snap, true
}

func (m *Manager) runTarget(ctx context.Context, t config.PreviewTarget) {
	interval := t.IntervalSec
	if interval < 3 {
		interval = 5
	}
	m.captureOnce(ctx, t)

	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.captureOnce(ctx, t)
		}
	}
}

func (m *Manager) captureOnce(ctx context.Context, t config.PreviewTarget) {
	var data []byte
	var ct string
	var err error

	lower := strings.ToLower(strings.TrimSpace(t.InputURL))
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		data, ct, err = m.fetchHTTPSnapshot(ctx, t.InputURL)
	} else {
		data, ct, err = m.grabFFmpegKeyframe(ctx, t.InputURL)
	}
	if err != nil || len(data) == 0 {
		return
	}
	m.mu.Lock()
	m.cache[t.ChannelID] = Snapshot{
		Data:        data,
		ContentType: ct,
		UpdatedAt:   time.Now(),
	}
	m.mu.Unlock()
}

func (m *Manager) fetchHTTPSnapshot(ctx context.Context, urlStr string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return nil, "", err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, "", err
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" {
		ct = http.DetectContentType(data)
	}
	if !strings.HasPrefix(ct, "image/") {
		return nil, "", fmt.Errorf("unexpected content-type %q", ct)
	}
	return data, ct, nil
}

func (m *Manager) grabFFmpegKeyframe(ctx context.Context, inputURL string) ([]byte, string, error) {
	if m.ffmpegPath == "" {
		return nil, "", fmt.Errorf("ffmpeg not installed")
	}
	cctx, cancel := context.WithTimeout(ctx, 4*time.Second)
	defer cancel()

	// Strictly grab 1 keyframe (-skip_frame nokey -frames:v 1), no audio/subtitle decode,
	// scaled to 320x180 JPEG so CPU usage stays negligible on relay hosts.
	cmd := exec.CommandContext(
		cctx,
		m.ffmpegPath,
		"-nostdin",
		"-loglevel", "error",
		"-flags", "low_delay",
		"-skip_frame", "nokey",
		"-an", "-sn", "-dn",
		"-i", inputURL,
		"-frames:v", "1",
		"-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2",
		"-q:v", "6",
		"-f", "image2pipe",
		"-vcodec", "mjpeg",
		"pipe:1",
	)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return nil, "", err
	}
	return out.Bytes(), "image/jpeg", nil
}

// RenderDemoMonitorSVG renders a clean 16:9 broadcast monitor thumbnail for --demo mode
// (including SMPTE color bars for NO SIGNAL, AES lock slate for encrypted Mode B passthrough,
// and live broadcast monitor framing with ticking timecode & VU bars for active Mode A feeds).
func RenderDemoMonitorSVG(label string, sample model.ChannelSample, now time.Time) []byte {
	safeLabel := html.EscapeString(strings.TrimSpace(label))
	if safeLabel == "" {
		safeLabel = html.EscapeString(sample.ChannelID)
	}
	tc := now.Format("15:04:05")
	sec := now.Second()

	// 1. Offline / Standby -> SMPTE broadcast color bars + NO SIGNAL badge
	if !sample.SrcConnected || sample.SrcMbps < 0.1 {
		statusText := "NO SIGNAL"
		accent := "#f85149"
		if sample.FaultCode == model.FaultIdleExpectedOff {
			statusText = "STANDBY"
			accent = "#8b949e"
		}
		svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <rect width="320" height="180" fill="#111318"/>
  <g opacity="0.42">
    <rect x="0" y="0" width="46" height="132" fill="#c0c0c0"/>
    <rect x="46" y="0" width="46" height="132" fill="#c0c000"/>
    <rect x="92" y="0" width="46" height="132" fill="#00c0c0"/>
    <rect x="138" y="0" width="46" height="132" fill="#00c000"/>
    <rect x="184" y="0" width="46" height="132" fill="#c000c0"/>
    <rect x="230" y="0" width="46" height="132" fill="#c00000"/>
    <rect x="276" y="0" width="44" height="132" fill="#0000c0"/>
    <rect x="0" y="132" width="320" height="48" fill="#141820"/>
  </g>
  <rect x="86" y="64" width="148" height="36" rx="4" fill="rgba(13,17,23,0.88)" stroke="%s" stroke-width="1.5"/>
  <text x="160" y="87" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="14" font-weight="700" text-anchor="middle">%s</text>
  <rect x="0" y="150" width="320" height="30" fill="rgba(10,12,16,0.86)"/>
  <text x="10" y="169" fill="#9aa7b8" font-family="ui-monospace,monospace" font-size="11" font-weight="600">%s</text>
  <text x="310" y="169" fill="#6e7c8e" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">%s</text>
</svg>`, accent, statusText, safeLabel, tc)
		return []byte(svg)
	}

	// 2. Mode B AES Encrypted Passthrough -> honest encrypted lock slate with live throughput
	if sample.Mode == model.ModeUDPPassthrough && sample.Encrypted {
		bar1 := 24 + (sec*7)%26
		bar2 := 18 + (sec*11)%30
		bar3 := 28 + (sec*5)%22
		bar4 := 20 + (sec*13)%28
		svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <defs>
    <linearGradient id="encbg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%%" stop-color="#161b24"/>
      <stop offset="100%%" stop-color="#0f131a"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="url(#encbg)"/>
  <rect x="14" y="14" width="292" height="122" rx="4" fill="none" stroke="#283244" stroke-width="1"/>
  <g transform="translate(144,36)" stroke="#3fb950" stroke-width="2" fill="none">
    <rect x="4" y="14" width="24" height="18" rx="3" fill="rgba(63,185,80,0.12)"/>
    <path d="M9 14V9a7 7 0 0 1 14 0v5"/>
    <circle cx="16" cy="23" r="2" fill="#3fb950"/>
  </g>
  <text x="160" y="88" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="12" font-weight="700" text-anchor="middle">AES PASSTHROUGH</text>
  <text x="160" y="106" fill="#8b949e" font-family="sans-serif" font-size="10" text-anchor="middle">加密透传 · 仅头部遥测</text>
  <g transform="translate(274,78)" fill="#3fb950" opacity="0.78">
    <rect x="0" y="%d" width="4" height="%d" rx="1"/>
    <rect x="6" y="%d" width="4" height="%d" rx="1"/>
    <rect x="12" y="%d" width="4" height="%d" rx="1"/>
    <rect x="18" y="%d" width="4" height="%d" rx="1"/>
  </g>
  <rect x="0" y="148" width="320" height="32" fill="rgba(10,12,16,0.9)"/>
  <circle cx="14" cy="164" r="4" fill="#3fb950"/>
  <text x="24" y="168" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="11" font-weight="700">%s</text>
  <text x="310" y="168" fill="#9aa7b8" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">%.1fM · %s</text>
</svg>`,
			50-bar1, bar1, 50-bar2, bar2, 50-bar3, bar3, 50-bar4, bar4,
			safeLabel, sample.SrcMbps, tc)
		return []byte(svg)
	}

	// 3. Active Mode A decoded broadcast monitor frame (realistic studio/arena multiview look)
	var c1, c2, badge, badgeColor string
	switch {
	case strings.Contains(strings.ToUpper(safeLabel), "PGM"):
		c1, c2, badge, badgeColor = "#1a283c", "#0f1724", "PGM", "#f85149"
	case strings.Contains(strings.ToUpper(safeLabel), "MAP"):
		c1, c2, badge, badgeColor = "#162c2b", "#0e191a", "GFX", "#38bdf8"
	case strings.Contains(strings.ToUpper(safeLabel), "16MV"):
		c1, c2, badge, badgeColor = "#1e2433", "#11151f", "MV", "#3fb950"
	default:
		c1, c2, badge, badgeColor = "#1c2536", "#10151f", "LIVE", "#3fb950"
	}

	vuL := 44 + (sec*9+len(safeLabel)*7)%46
	vuR := 40 + (sec*13+len(safeLabel)*5)%48
	waveOffset := (sec * 18) % 60
	isMV := strings.Contains(strings.ToUpper(safeLabel), "16MV")

	var sceneSVG string
	if isMV {
		// Subtle 4x4 multiview grid silhouette
		sceneSVG = `<g stroke="rgba(148,163,184,0.22)" stroke-width="1" fill="rgba(47,129,247,0.06)">
    <rect x="24" y="20" width="60" height="32" rx="2"/><rect x="88" y="20" width="60" height="32" rx="2"/>
    <rect x="152" y="20" width="60" height="32" rx="2"/><rect x="216" y="20" width="60" height="32" rx="2"/>
    <rect x="24" y="56" width="60" height="32" rx="2"/><rect x="88" y="56" width="60" height="32" rx="2"/>
    <rect x="152" y="56" width="60" height="32" rx="2"/><rect x="216" y="56" width="60" height="32" rx="2"/>
    <rect x="24" y="92" width="60" height="32" rx="2"/><rect x="88" y="92" width="60" height="32" rx="2"/>
    <rect x="152" y="92" width="60" height="32" rx="2"/><rect x="216" y="92" width="60" height="32" rx="2"/>
  </g>`
	} else {
		// Broadcast stage horizon + subtle camera framing & live signal sweep
		sceneSVG = fmt.Sprintf(`<ellipse cx="152" cy="116" rx="116" ry="34" fill="rgba(56,189,248,0.09)"/>
  <path d="M22 120 Q %d 64 156 92 T 282 80" fill="none" stroke="rgba(96,165,250,0.34)" stroke-width="2"/>
  <g stroke="rgba(230,237,243,0.22)" stroke-width="1.2" fill="none">
    <path d="M20 30V20H34"/><path d="M276 20H290V30"/>
    <path d="M20 124V134H34"/><path d="M276 134H290V124"/>
    <line x1="150" y1="77" x2="162" y2="77"/><line x1="156" y1="71" x2="156" y2="83"/>
  </g>`, 72+waveOffset)
	}

	svg := fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" width="320" height="180">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%%" stop-color="%s"/>
      <stop offset="100%%" stop-color="%s"/>
    </linearGradient>
    <linearGradient id="vu" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0%%" stop-color="#3fb950"/>
      <stop offset="72%%" stop-color="#e3b341"/>
      <stop offset="100%%" stop-color="#f85149"/>
    </linearGradient>
  </defs>
  <rect width="320" height="180" fill="url(#bg)"/>
  %s
  <rect x="10" y="10" width="44" height="18" rx="3" fill="%s"/>
  <text x="32" y="23" fill="#ffffff" font-family="ui-monospace,monospace" font-size="10" font-weight="700" text-anchor="middle">%s</text>
  <rect x="298" y="22" width="5" height="108" rx="1" fill="rgba(255,255,255,0.08)"/>
  <rect x="305" y="22" width="5" height="108" rx="1" fill="rgba(255,255,255,0.08)"/>
  <rect x="298" y="%d" width="5" height="%d" rx="1" fill="url(#vu)"/>
  <rect x="305" y="%d" width="5" height="%d" rx="1" fill="url(#vu)"/>
  <rect x="0" y="148" width="320" height="32" fill="rgba(10,12,16,0.88)"/>
  <text x="10" y="168" fill="#e6edf3" font-family="ui-monospace,monospace" font-size="11" font-weight="700">%s</text>
  <text x="310" y="168" fill="#9aa7b8" font-family="ui-monospace,monospace" font-size="11" text-anchor="end">%.1fM · %s</text>
</svg>`,
		c1, c2, sceneSVG, badgeColor, badge,
		130-vuL, vuL, 130-vuR, vuR,
		safeLabel, sample.SrcMbps, tc)
	return []byte(svg)
}
