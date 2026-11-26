package passthrough

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/srtparse"
)

// Config controls a single isolated Mode B L4 UDP passthrough forwarder.
type Config struct {
	ID         string
	ListenAddr string
	TargetAddr string
	BufBytes   int
	SessionTTL time.Duration
}

// Snapshot is the 1-second telemetry view exposed by srt-passd over local HTTP /stats.
type Snapshot struct {
	ID                 string  `json:"id"`
	Mode               string  `json:"mode"`
	ListenAddr         string  `json:"listen_addr"`
	TargetAddr         string  `json:"target_addr"`
	Timestamp          int64   `json:"timestamp"`
	UptimeSec          int64   `json:"uptime_sec"`
	State              string  `json:"state"` // FLOW, IDLE, DOWN
	PeerIP             string  `json:"peer_ip"`
	PathMedium         string  `json:"path_medium"` // LO, WAN, -
	UpstreamMbps       float64 `json:"upstream_mbps"`
	DownstreamMbps     float64 `json:"downstream_mbps"`
	UpstreamPackets    uint64  `json:"upstream_packets"`
	DownstreamPackets  uint64  `json:"downstream_packets"`
	RetransPackets     uint64  `json:"retrans_packets"`
	NAKReports         uint64  `json:"nak_reports"`
	NAKLostPackets     uint64  `json:"nak_lost_packets"`
	DropReqPackets     uint64  `json:"drop_req_packets"`
	Handshakes         uint64  `json:"handshakes"`
	Shutdowns          uint64  `json:"shutdowns"`
	Encrypted          bool    `json:"encrypted"`
	ActiveSessions     int     `json:"active_sessions"`
	LastUpstreamUnix   int64   `json:"last_upstream_unix"`
	LastDownstreamUnix int64   `json:"last_downstream_unix"`
}

type session struct {
	clientAddr *net.UDPAddr
	targetConn *net.UDPConn
	lastSeen   atomic.Int64
	cancel     context.CancelFunc
}

// Forwarder relays raw UDP packets byte-for-byte while passively inspecting the
// unencrypted 16-byte SRT header for telemetry.
type Forwarder struct {
	cfg       Config
	startedAt time.Time

	listenConn *net.UDPConn
	targetAddr *net.UDPAddr

	mu       sync.Mutex
	sessions map[string]*session

	// Cumulative atomic counters (sampled every 1s for interval Snapshot)
	upBytes   atomic.Uint64
	downBytes atomic.Uint64
	upPkts    atomic.Uint64
	downPkts  atomic.Uint64
	retrans   atomic.Uint64
	nakCount  atomic.Uint64
	nakLost   atomic.Uint64
	dropReq   atomic.Uint64
	handshake atomic.Uint64
	shutdown  atomic.Uint64
	encrypted atomic.Bool

	lastUpUnix   atomic.Int64
	lastDownUnix atomic.Int64

	peerMu     sync.RWMutex
	peerIP     string
	pathMedium string

	snapMu   sync.RWMutex
	snapshot Snapshot
}

// New creates a new Forwarder. Call Run to bind sockets and begin forwarding.
func New(cfg Config) (*Forwarder, error) {
	if cfg.ID == "" {
		cfg.ID = "srt-pass"
	}
	if cfg.ListenAddr == "" || cfg.TargetAddr == "" {
		return nil, errors.New("listen_addr and target_addr are required")
	}
	if cfg.BufBytes <= 0 {
		cfg.BufBytes = 32 * 1024 * 1024
	}
	if cfg.SessionTTL <= 0 {
		cfg.SessionTTL = 30 * time.Second
	}
	targetAddr, err := net.ResolveUDPAddr("udp", cfg.TargetAddr)
	if err != nil {
		return nil, fmt.Errorf("resolve target_addr %q: %w", cfg.TargetAddr, err)
	}
	return &Forwarder{
		cfg:        cfg,
		targetAddr: targetAddr,
		sessions:   make(map[string]*session),
		pathMedium: "-",
	}, nil
}

// ListenAddr returns the actual bound local address after Start/Run binds.
func (f *Forwarder) BoundAddr() string {
	if f.listenConn == nil {
		return f.cfg.ListenAddr
	}
	return f.listenConn.LocalAddr().String()
}

// Snapshot returns the most recent 1-second telemetry snapshot.
func (f *Forwarder) Snapshot() Snapshot {
	f.snapMu.RLock()
	defer f.snapMu.RUnlock()
	return f.snapshot
}

// StatsHandler exposes GET /stats and GET /healthz for srt-camd polling.
func (f *Forwarder) StatsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /stats", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(f.Snapshot())
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	return mux
}

// Start binds the listening UDP socket and spawns forwarding + telemetry loops.
// It stops cleanly when ctx is canceled.
func (f *Forwarder) Start(ctx context.Context) error {
	laddr, err := net.ResolveUDPAddr("udp", f.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("resolve listen_addr %q: %w", f.cfg.ListenAddr, err)
	}
	conn, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return fmt.Errorf("listen udp %q: %w", f.cfg.ListenAddr, err)
	}
	_ = conn.SetReadBuffer(f.cfg.BufBytes)
	_ = conn.SetWriteBuffer(f.cfg.BufBytes)
	f.listenConn = conn
	f.startedAt = time.Now()
	f.updateSnapshot(time.Second, prevCounters{})

	go f.readUpstreamLoop(ctx)
	go f.samplerLoop(ctx)
	go func() {
		<-ctx.Done()
		_ = conn.Close()
		f.closeAllSessions()
	}()
	return nil
}

func (f *Forwarder) readUpstreamLoop(ctx context.Context) {
	buf := make([]byte, 65535)
	for {
		n, clientAddr, err := f.listenConn.ReadFromUDP(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if n == 0 {
			continue
		}
		payload := buf[:n]
		now := time.Now().Unix()
		f.upBytes.Add(uint64(n))
		f.upPkts.Add(1)
		f.lastUpUnix.Store(now)
		f.recordPeer(clientAddr.IP)
		f.inspectUpstreamPacket(payload)

		sess, err := f.getOrCreateSession(ctx, clientAddr)
		if err != nil {
			continue
		}
		sess.lastSeen.Store(now)
		_, _ = sess.targetConn.Write(payload)
	}
}

func (f *Forwarder) getOrCreateSession(parentCtx context.Context, clientAddr *net.UDPAddr) (*session, error) {
	key := clientAddr.String()
	f.mu.Lock()
	if s, ok := f.sessions[key]; ok {
		f.mu.Unlock()
		return s, nil
	}
	f.mu.Unlock()

	tconn, err := net.DialUDP("udp", nil, f.targetAddr)
	if err != nil {
		return nil, err
	}
	_ = tconn.SetReadBuffer(f.cfg.BufBytes)
	_ = tconn.SetWriteBuffer(f.cfg.BufBytes)

	sctx, cancel := context.WithCancel(parentCtx)
	s := &session{
		clientAddr: clientAddr,
		targetConn: tconn,
		cancel:     cancel,
	}
	s.lastSeen.Store(time.Now().Unix())

	f.mu.Lock()
	if existing, ok := f.sessions[key]; ok {
		f.mu.Unlock()
		cancel()
		_ = tconn.Close()
		return existing, nil
	}
	f.sessions[key] = s
	f.mu.Unlock()

	go f.readDownstreamLoop(sctx, key, s)
	return s, nil
}

func (f *Forwarder) readDownstreamLoop(ctx context.Context, key string, s *session) {
	defer func() {
		_ = s.targetConn.Close()
		f.mu.Lock()
		if cur, ok := f.sessions[key]; ok && cur == s {
			delete(f.sessions, key)
		}
		f.mu.Unlock()
	}()

	buf := make([]byte, 65535)
	for {
		n, err := s.targetConn.Read(buf)
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return
			}
			continue
		}
		if n == 0 {
			continue
		}
		payload := buf[:n]
		now := time.Now().Unix()
		s.lastSeen.Store(now)
		f.downBytes.Add(uint64(n))
		f.downPkts.Add(1)
		f.lastDownUnix.Store(now)
		f.inspectDownstreamPacket(payload)

		_, _ = f.listenConn.WriteToUDP(payload, s.clientAddr)
	}
}

func (f *Forwarder) inspectUpstreamPacket(payload []byte) {
	pkt, ok := srtparse.ParseHeader(payload)
	if !ok {
		return
	}
	if pkt.IsControl {
		switch pkt.ControlType {
		case srtparse.ControlHandshake:
			f.handshake.Add(1)
		case srtparse.ControlShutdown:
			f.shutdown.Add(1)
		case srtparse.ControlNAK:
			f.nakCount.Add(1)
			f.nakLost.Add(uint64(pkt.NAKLostPackets))
		case srtparse.ControlDropReq:
			n := pkt.DropReqPackets
			if n <= 0 {
				n = 1
			}
			f.dropReq.Add(uint64(n))
		}
		return
	}
	if pkt.Encrypted {
		f.encrypted.Store(true)
	}
	if pkt.Retransmitted {
		f.retrans.Add(1)
	}
}

func (f *Forwarder) inspectDownstreamPacket(payload []byte) {
	pkt, ok := srtparse.ParseHeader(payload)
	if !ok {
		return
	}
	if pkt.IsControl {
		switch pkt.ControlType {
		case srtparse.ControlNAK:
			f.nakCount.Add(1)
			f.nakLost.Add(uint64(pkt.NAKLostPackets))
		case srtparse.ControlDropReq:
			n := pkt.DropReqPackets
			if n <= 0 {
				n = 1
			}
			f.dropReq.Add(uint64(n))
		case srtparse.ControlShutdown:
			f.shutdown.Add(1)
		}
	}
}

func (f *Forwarder) recordPeer(ip net.IP) {
	if ip == nil {
		return
	}
	ipStr := ip.String()
	med := "WAN"
	if ip.IsLoopback() {
		med = "LO"
	}
	f.peerMu.Lock()
	f.peerIP = ipStr
	f.pathMedium = med
	f.peerMu.Unlock()
}

type prevCounters struct {
	upBytes   uint64
	downBytes uint64
	upPkts    uint64
	downPkts  uint64
	retrans   uint64
	nakCount  uint64
	nakLost   uint64
	dropReq   uint64
	handshake uint64
	shutdown  uint64
}

func (f *Forwarder) samplerLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()

	var prev prevCounters
	lastTick := time.Now()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			dt := now.Sub(lastTick)
			if dt <= 0 {
				dt = time.Second
			}
			lastTick = now
			f.evictIdleSessions(now)
			prev = f.updateSnapshot(dt, prev)
		}
	}
}

func (f *Forwarder) updateSnapshot(dt time.Duration, prev prevCounters) prevCounters {
	cur := prevCounters{
		upBytes:   f.upBytes.Load(),
		downBytes: f.downBytes.Load(),
		upPkts:    f.upPkts.Load(),
		downPkts:  f.downPkts.Load(),
		retrans:   f.retrans.Load(),
		nakCount:  f.nakCount.Load(),
		nakLost:   f.nakLost.Load(),
		dropReq:   f.dropReq.Load(),
		handshake: f.handshake.Load(),
		shutdown:  f.shutdown.Load(),
	}
	sec := dt.Seconds()
	if sec < 0.001 {
		sec = 1.0
	}
	dUpBytes := cur.upBytes - prev.upBytes
	dDownBytes := cur.downBytes - prev.downBytes
	upMbps := float64(dUpBytes) * 8.0 / 1e6 / sec
	downMbps := float64(dDownBytes) * 8.0 / 1e6 / sec

	nowUnix := time.Now().Unix()
	lastUp := f.lastUpUnix.Load()
	lastDown := f.lastDownUnix.Load()

	state := "DOWN"
	if upMbps >= 0.05 && (nowUnix-lastUp) <= 3 {
		state = "FLOW"
	} else if (nowUnix-lastUp) <= 10 || (nowUnix-lastDown) <= 10 {
		state = "IDLE"
	}

	f.peerMu.RLock()
	peerIP := f.peerIP
	med := f.pathMedium
	f.peerMu.RUnlock()

	f.mu.Lock()
	sessCount := len(f.sessions)
	f.mu.Unlock()

	snap := Snapshot{
		ID:                 f.cfg.ID,
		Mode:               "udp-passthrough",
		ListenAddr:         f.BoundAddr(),
		TargetAddr:         f.cfg.TargetAddr,
		Timestamp:          nowUnix,
		UptimeSec:          int64(time.Since(f.startedAt).Seconds()),
		State:              state,
		PeerIP:             peerIP,
		PathMedium:         med,
		UpstreamMbps:       upMbps,
		DownstreamMbps:     downMbps,
		UpstreamPackets:    cur.upPkts - prev.upPkts,
		DownstreamPackets:  cur.downPkts - prev.downPkts,
		RetransPackets:     cur.retrans - prev.retrans,
		NAKReports:         cur.nakCount - prev.nakCount,
		NAKLostPackets:     cur.nakLost - prev.nakLost,
		DropReqPackets:     cur.dropReq - prev.dropReq,
		Handshakes:         cur.handshake - prev.handshake,
		Shutdowns:          cur.shutdown - prev.shutdown,
		Encrypted:          f.encrypted.Load(),
		ActiveSessions:     sessCount,
		LastUpstreamUnix:   lastUp,
		LastDownstreamUnix: lastDown,
	}

	f.snapMu.Lock()
	f.snapshot = snap
	f.snapMu.Unlock()
	return cur
}

func (f *Forwarder) evictIdleSessions(now time.Time) {
	cutoff := now.Add(-f.cfg.SessionTTL).Unix()
	var expired []*session
	f.mu.Lock()
	for k, s := range f.sessions {
		if s.lastSeen.Load() < cutoff {
			expired = append(expired, s)
			delete(f.sessions, k)
		}
	}
	f.mu.Unlock()
	for _, s := range expired {
		s.cancel()
		_ = s.targetConn.Close()
	}
}

func (f *Forwarder) closeAllSessions() {
	f.mu.Lock()
	all := make([]*session, 0, len(f.sessions))
	for k, s := range f.sessions {
		all = append(all, s)
		delete(f.sessions, k)
	}
	f.mu.Unlock()
	for _, s := range all {
		s.cancel()
		_ = s.targetConn.Close()
	}
}
