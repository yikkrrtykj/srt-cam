package preview

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// VideoMeta holds lightweight audio/video format details parsed from ffmpeg's probe header during
// keyframe thumbnail capture (zero extra decoding or network bandwidth).
type VideoMeta struct {
	FPS              float64
	Resolution       string
	Codec            string
	AudioCodec       string
	AudioSampleRate  int
	AudioBitrateKbps int
	AudioChannels    string
	AudioTracks      int
	AudioDetail      string
	UpdatedAt        time.Time
}

// Snapshot holds one captured thumbnail image in memory.
type Snapshot struct {
	Data        []byte
	ContentType string
	UpdatedAt   time.Time
}

// Manager runs optional, viewer-driven 5-second keyframe snapshot grabbers with a strict
// concurrency cap so thumbnail previews consume 0% CPU when idle and never compete with
// live broadcast SRT forwarding.
type Manager struct {
	explicit    map[string]config.PreviewTarget
	httpClient  *http.Client
	probeClient *http.Client
	ffmpegPath  string
	sem         chan struct{} // bounds concurrent ffmpeg processes (default 2)

	mu         sync.RWMutex
	targets    map[string]config.PreviewTarget
	cache      map[string]Snapshot
	metaCache  map[string]VideoMeta
	lastViewed map[string]time.Time
	inFlight   map[string]bool
	rootCtx    context.Context
}

// NewManager initializes a preview thumbnail manager for the configured PreviewTargets.
func NewManager(targets []config.PreviewTarget) *Manager {
	ffPath, _ := exec.LookPath("ffmpeg")
	exp := make(map[string]config.PreviewTarget, len(targets))
	all := make(map[string]config.PreviewTarget, len(targets))
	for _, t := range targets {
		cid := strings.TrimSpace(t.ChannelID)
		if cid == "" || strings.TrimSpace(t.InputURL) == "" {
			continue
		}
		if t.IntervalSec < 3 {
			t.IntervalSec = 5
		}
		exp[cid] = t
		all[cid] = t
	}
	return &Manager{
		explicit:    exp,
		httpClient:  &http.Client{Timeout: 3 * time.Second},
		probeClient: &http.Client{Timeout: 350 * time.Millisecond},
		ffmpegPath:  ffPath,
		sem:         make(chan struct{}, 2),
		targets:     all,
		cache:       make(map[string]Snapshot),
		metaCache:   make(map[string]VideoMeta),
		lastViewed:  make(map[string]time.Time),
		inFlight:    make(map[string]bool),
		rootCtx:     context.Background(),
	}
}

// SyncEventSheet registers zero-config local preview tap URLs (http://127.0.0.1:<inPort+8000>/ts)
// for local Mode A srt-relay legs whenever not overridden by explicit config.Previews.
func (m *Manager) SyncEventSheet(localNodeID string, sheet config.EventSheet) {
	next := make(map[string]config.PreviewTarget, len(m.explicit)+10)
	for cid, t := range m.explicit {
		next[cid] = t
	}
	for _, grp := range sheet.SignalGroups {
		for _, leg := range grp.Legs {
			if leg.NodeID != localNodeID || leg.Mode != model.ModeSRTRelay {
				continue
			}
			if _, ok := next[leg.ChannelID]; ok {
				continue
			}
			if (leg.InPort >= 20001 && leg.InPort <= 20100) || (leg.InPort >= 21111 && leg.InPort <= 21200) {
				next[leg.ChannelID] = config.PreviewTarget{
					ChannelID:   leg.ChannelID,
					InputURL:    fmt.Sprintf("http://127.0.0.1:%d/ts", leg.InPort+8000),
					IntervalSec: 5,
				}
			}
		}
	}
	m.mu.Lock()
	m.targets = next
	m.mu.Unlock()
}

// Start runs a single lightweight scheduler tick that refreshes only channels actively
// viewed within the last 30 seconds. When no dashboard is open, ffmpeg is never invoked.
func (m *Manager) Start(ctx context.Context) {
	m.mu.Lock()
	m.rootCtx = ctx
	m.mu.Unlock()

	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case now := <-ticker.C:
				m.scheduleDue(ctx, now)
			}
		}
	}()
}

// Touch marks channelID as actively viewed by a browser and triggers an immediate non-blocking
// capture if no fresh thumbnail is cached yet.
func (m *Manager) Touch(channelID string) {
	now := time.Now()
	m.mu.Lock()
	m.lastViewed[channelID] = now
	target, hasTarget := m.targets[channelID]
	snap, hasSnap := m.cache[channelID]
	busy := m.inFlight[channelID]
	ctx := m.rootCtx
	stale := !hasSnap || now.Sub(snap.UpdatedAt) >= time.Duration(target.IntervalSec)*time.Second
	if hasTarget && stale && !busy {
		m.inFlight[channelID] = true
		m.mu.Unlock()
		go m.captureAsync(ctx, target)
		return
	}
	m.mu.Unlock()
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

// VideoMeta returns the most recent parsed stream format metadata (video + audio)
// captured alongside keyframe thumbnails within maxAge.
func (m *Manager) VideoMeta(channelID string, maxAge time.Duration) (VideoMeta, bool) {
	if maxAge <= 0 {
		maxAge = 35 * time.Second
	}
	m.mu.RLock()
	meta, ok := m.metaCache[channelID]
	m.mu.RUnlock()
	if !ok || (meta.FPS <= 0 && meta.Resolution == "" && meta.AudioSampleRate == 0) || time.Since(meta.UpdatedAt) > maxAge {
		return VideoMeta{}, false
	}
	return meta, true
}

func (m *Manager) scheduleDue(ctx context.Context, now time.Time) {
	m.mu.Lock()
	var due []config.PreviewTarget
	for cid, target := range m.targets {
		viewedAt, viewed := m.lastViewed[cid]
		if !viewed || now.Sub(viewedAt) > 30*time.Second {
			continue
		}
		if m.inFlight[cid] {
			continue
		}
		interval := time.Duration(target.IntervalSec) * time.Second
		if interval < 3*time.Second {
			interval = 5 * time.Second
		}
		if snap, ok := m.cache[cid]; ok && now.Sub(snap.UpdatedAt) < interval {
			continue
		}
		m.inFlight[cid] = true
		due = append(due, target)
	}
	m.mu.Unlock()

	for _, t := range due {
		go m.captureAsync(ctx, t)
	}
}

func (m *Manager) captureAsync(ctx context.Context, t config.PreviewTarget) {
	defer func() {
		m.mu.Lock()
		delete(m.inFlight, t.ChannelID)
		m.mu.Unlock()
	}()
	m.captureOnce(ctx, t)
}

func (m *Manager) captureOnce(ctx context.Context, t config.PreviewTarget) {
	var data []byte
	var ct string
	var meta VideoMeta
	var err error

	rawURL := strings.TrimSpace(t.InputURL)
	lower := strings.ToLower(rawURL)

	switch {
	case isLocalTSTapURL(rawURL):
		// Fast 350ms pre-flight /healthz check: skip without spawning ffmpeg if container is
		// legacy v1 (no tee) or currently has no active video flow.
		if !m.isLocalTapFlowing(ctx, rawURL) {
			return
		}
		data, ct, meta, err = m.grabFFmpegKeyframe(ctx, rawURL, true)
	case strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://"):
		data, ct, meta, err = m.fetchHTTPSnapshot(ctx, rawURL)
	default:
		isTS := strings.HasPrefix(lower, "udp://") || strings.HasPrefix(lower, "srt://")
		data, ct, meta, err = m.grabFFmpegKeyframe(ctx, rawURL, isTS)
	}

	if err != nil || len(data) == 0 {
		return
	}
	now := time.Now()
	m.mu.Lock()
	m.cache[t.ChannelID] = Snapshot{
		Data:        data,
		ContentType: ct,
		UpdatedAt:   now,
	}
	if meta.FPS > 0 || meta.Resolution != "" || meta.Codec != "" || meta.AudioSampleRate > 0 {
		meta.UpdatedAt = now
		m.metaCache[t.ChannelID] = meta
	}
	m.mu.Unlock()
}

func isLocalTSTapURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	return (u.Scheme == "http" || u.Scheme == "https") && strings.HasSuffix(strings.ToLower(u.Path), "/ts")
}

func (m *Manager) isLocalTapFlowing(ctx context.Context, tsURL string) bool {
	u, err := url.Parse(tsURL)
	if err != nil {
		return false
	}
	u.Path = strings.TrimSuffix(u.Path, "/ts") + "/healthz"
	u.RawQuery = ""
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return false
	}
	resp, err := m.probeClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	var payload struct {
		Flowing bool `json:"flowing"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&payload); err != nil {
		return false
	}
	return payload.Flowing
}

func (m *Manager) fetchHTTPSnapshot(ctx context.Context, urlStr string) ([]byte, string, VideoMeta, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, urlStr, nil)
	if err != nil {
		return nil, "", VideoMeta{}, err
	}
	resp, err := m.httpClient.Do(req)
	if err != nil {
		return nil, "", VideoMeta{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, "", VideoMeta{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	ct := resp.Header.Get("Content-Type")
	if strings.HasPrefix(strings.ToLower(ct), "video/") {
		// Stream endpoint mistakenly configured without /ts suffix -> hand off to ffmpeg
		_ = resp.Body.Close()
		return m.grabFFmpegKeyframe(ctx, urlStr, strings.Contains(strings.ToLower(ct), "mp2t"))
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return nil, "", VideoMeta{}, err
	}
	if ct == "" {
		ct = http.DetectContentType(data)
	}
	if !strings.HasPrefix(ct, "image/") {
		return nil, "", VideoMeta{}, fmt.Errorf("unexpected content-type %q", ct)
	}
	return data, ct, VideoMeta{}, nil
}

func (m *Manager) grabFFmpegKeyframe(ctx context.Context, inputURL string, forceMPEGTS bool) ([]byte, string, VideoMeta, error) {
	if m.ffmpegPath == "" {
		return nil, "", VideoMeta{}, fmt.Errorf("ffmpeg not installed")
	}

	// Acquire concurrency slot (max 2 simultaneous ffmpeg grabs) so small VPS CPUs stay safe.
	select {
	case m.sem <- struct{}{}:
		defer func() { <-m.sem }()
	case <-ctx.Done():
		return nil, "", VideoMeta{}, ctx.Err()
	}

	cctx, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()

	// Strictly grab 1 keyframe (-skip_frame nokey -frames:v 1), no audio/subtitle decode,
	// bounded probe size and scaled to 960x540 (half-1080p qHD) JPEG for crisp 1080p TV walls.
	// -loglevel info prints the probed video/audio headers on stderr at zero extra cost.
	args := []string{
		"-nostdin",
		"-loglevel", "info",
		"-fflags", "nobuffer+discardcorrupt",
		"-flags", "low_delay",
		"-probesize", "2000000",
		"-analyzeduration", "2500000",
	}
	if forceMPEGTS {
		args = append(args, "-f", "mpegts")
	}
	args = append(args,
		"-skip_frame", "nokey",
		"-an", "-sn", "-dn",
		"-i", inputURL,
		"-frames:v", "1",
		"-vf", "scale=960:540:force_original_aspect_ratio=decrease,pad=960:540:(ow-iw)/2:(oh-ih)/2",
		"-q:v", "4",
		"-f", "image2pipe",
		"-vcodec", "mjpeg",
		"pipe:1",
	)

	cmd := exec.CommandContext(cctx, m.ffmpegPath, args...)
	var out bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return nil, "", VideoMeta{}, err
	}
	meta := ParseFFmpegVideoMeta(stderr.String())
	return out.Bytes(), "image/jpeg", meta, nil
}

var (
	reVideoCodec  = regexp.MustCompile(`(?i)Stream\s+#\d+:\d+[^:]*:\s*Video:\s*([a-z0-9_]+)`)
	reVideoRes    = regexp.MustCompile(`\b(\d{3,4}x\d{3,4})\b`)
	reVideoFPS    = regexp.MustCompile(`\b(\d+(?:\.\d+)?)\s+fps\b`)
	reVideoTBR    = regexp.MustCompile(`\b(\d+(?:\.\d+)?)\s+tbr\b`)
	reAudioCodec  = regexp.MustCompile(`(?i)Stream\s+#\d+:\d+[^:]*:\s*Audio:\s*([a-z0-9_]+)`)
	reAudioRate   = regexp.MustCompile(`\b(\d{4,6})\s+Hz\b`)
	reAudioKbps   = regexp.MustCompile(`\b(\d+)\s+kb/s\b`)
	reAudioLayout = regexp.MustCompile(`\b(mono|stereo|quad|hexagonal|octagonal|\d+\.\d+(?:\([a-z]+\))?|\d+\s+channels)\b`)
)

func normalizeAudioCodec(raw string) string {
	low := strings.ToLower(strings.TrimSpace(raw))
	switch {
	case low == "aac":
		return "AAC"
	case low == "aac_latm":
		return "AAC-LATM"
	case low == "mp2":
		return "MP2"
	case low == "mp3":
		return "MP3"
	case low == "ac3":
		return "AC-3"
	case low == "eac3":
		return "E-AC-3"
	case low == "opus":
		return "Opus"
	case low == "s302m":
		return "PCM (S302M)"
	case strings.HasPrefix(low, "pcm_"):
		return "PCM"
	default:
		return strings.ToUpper(low)
	}
}

func formatSampleRateShort(hz int) string {
	if hz <= 0 {
		return "-"
	}
	if hz%1000 == 0 {
		return fmt.Sprintf("%d kHz", hz/1000)
	}
	return fmt.Sprintf("%.1f kHz", float64(hz)/1000.0)
}

// ParseFFmpegVideoMeta extracts video (codec, resolution, fps) and all audio tracks
// (codec, sample rate, bitrate, channel layout, track count) from ffmpeg's Input #0 stderr lines.
func ParseFFmpegVideoMeta(stderr string) VideoMeta {
	var meta VideoMeta
	var audioLines []string
	hasVideo := false

	for _, line := range strings.Split(stderr, "\n") {
		trimmed := strings.TrimSpace(line)
		// Stop once ffmpeg moves past Input #0 stream descriptions into Output #0 / mapping.
		if strings.HasPrefix(trimmed, "Output #") || strings.HasPrefix(trimmed, "Stream mapping:") {
			break
		}
		if !strings.Contains(line, "Stream #0:") {
			continue
		}

		if !hasVideo && strings.Contains(line, "Video:") {
			hasVideo = true
			if m := reVideoCodec.FindStringSubmatch(line); len(m) > 1 {
				switch strings.ToLower(m[1]) {
				case "h264":
					meta.Codec = "H.264"
				case "hevc", "h265":
					meta.Codec = "HEVC"
				case "mpeg2video":
					meta.Codec = "MPEG-2"
				default:
					meta.Codec = strings.ToUpper(m[1])
				}
			}
			if m := reVideoRes.FindStringSubmatch(line); len(m) > 1 {
				meta.Resolution = m[1]
			}
			fpsStr := ""
			if m := reVideoFPS.FindStringSubmatch(line); len(m) > 1 {
				fpsStr = m[1]
			} else if m := reVideoTBR.FindStringSubmatch(line); len(m) > 1 {
				fpsStr = m[1]
			}
			if fpsStr != "" {
				if v, err := strconv.ParseFloat(fpsStr, 64); err == nil && v >= 1 && v <= 240 {
					meta.FPS = v
				}
			}
			continue
		}

		if strings.Contains(line, "Audio:") {
			meta.AudioTracks++
			codec := ""
			if m := reAudioCodec.FindStringSubmatch(line); len(m) > 1 {
				codec = normalizeAudioCodec(m[1])
			}
			rate := 0
			if m := reAudioRate.FindStringSubmatch(line); len(m) > 1 {
				if v, err := strconv.Atoi(m[1]); err == nil && v >= 8000 && v <= 384000 {
					rate = v
				}
			}
			kbps := 0
			if m := reAudioKbps.FindStringSubmatch(line); len(m) > 1 {
				if v, err := strconv.Atoi(m[1]); err == nil && v > 0 && v <= 10000 {
					kbps = v
				}
			}
			channels := ""
			if m := reAudioLayout.FindStringSubmatch(line); len(m) > 1 {
				channels = m[1]
				if idx := strings.IndexByte(channels, '('); idx > 0 {
					channels = channels[:idx]
				}
			}

			if meta.AudioTracks == 1 {
				meta.AudioCodec = codec
				meta.AudioSampleRate = rate
				meta.AudioBitrateKbps = kbps
				meta.AudioChannels = channels
			}

			var parts []string
			if codec != "" {
				parts = append(parts, codec)
			}
			if rate > 0 {
				parts = append(parts, formatSampleRateShort(rate))
			}
			if channels != "" {
				parts = append(parts, channels)
			}
			if kbps > 0 {
				parts = append(parts, fmt.Sprintf("%d kb/s", kbps))
			}
			if len(parts) > 0 {
				audioLines = append(audioLines, fmt.Sprintf("音轨 #%d: %s", meta.AudioTracks, strings.Join(parts, " · ")))
			}
		}
	}

	if len(audioLines) > 0 {
		meta.AudioDetail = strings.Join(audioLines, "\n")
	}
	return meta
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

	// 1. Stopped / Offline / Standby -> SMPTE broadcast color bars + clear status badge
	if sample.FaultCode == model.FaultStreamStopped || !sample.SrcConnected || sample.SrcMbps < 0.1 {
		statusText := "NO SIGNAL"
		accent := "#f85149"
		if sample.FaultCode == model.FaultStreamStopped {
			statusText = "STOPPED"
			accent = "#525a69"
		} else if sample.FaultCode == model.FaultIdleExpectedOff {
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
		sceneSVG = `<g stroke="rgba(148,163,184,0.22)" stroke-width="1" fill="rgba(47,129,247,0.06)">
    <rect x="24" y="20" width="60" height="32" rx="2"/><rect x="88" y="20" width="60" height="32" rx="2"/>
    <rect x="152" y="20" width="60" height="32" rx="2"/><rect x="216" y="20" width="60" height="32" rx="2"/>
    <rect x="24" y="56" width="60" height="32" rx="2"/><rect x="88" y="56" width="60" height="32" rx="2"/>
    <rect x="152" y="56" width="60" height="32" rx="2"/><rect x="216" y="56" width="60" height="32" rx="2"/>
    <rect x="24" y="92" width="60" height="32" rx="2"/><rect x="88" y="92" width="60" height="32" rx="2"/>
    <rect x="152" y="92" width="60" height="32" rx="2"/><rect x="216" y="92" width="60" height="32" rx="2"/>
  </g>`
	} else {
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
