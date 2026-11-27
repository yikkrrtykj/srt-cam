package relaytee

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
)

// Config controls the local loopback UDP live forwarder and on-demand HTTP MPEG-TS preview tap.
type Config struct {
	ListenAddr    string        // default "127.0.0.1:0"
	EgressAddr    string        // required, e.g. "127.0.0.1:27115"
	HTTPAddr      string        // optional, e.g. "127.0.0.1:29115"
	BufBytes      int           // default 32 MiB
	MaxViewers    int           // default 4
	StreamTimeout time.Duration // default 8s per preview HTTP pull
}

// HealthSnapshot is returned by GET /healthz so srt-camd can check flow state before spawning ffmpeg.
type HealthSnapshot struct {
	OK      bool   `json:"ok"`
	Flowing bool   `json:"flowing"`
	Packets uint64 `json:"packets"`
	Bytes   uint64 `json:"bytes"`
	Viewers int32  `json:"viewers"`
}

// Tee forwards raw MPEG-TS UDP datagrams from ingest to egress with zero allocations when idle,
// and serves on-demand non-blocking HTTP /ts copies to preview thumbnail grabbers.
type Tee struct {
	cfg Config

	listenConn *net.UDPConn
	egressConn *net.UDPConn
	httpLn     net.Listener
	httpSrv    *http.Server

	packets        atomic.Uint64
	bytes          atomic.Uint64
	lastPacketUnix atomic.Int64
	viewerCount    atomic.Int32

	subMu sync.RWMutex
	subs  map[chan []byte]struct{}
}

// New constructs a Tee instance. Call Start to bind sockets and begin forwarding.
func New(cfg Config) (*Tee, error) {
	if cfg.EgressAddr == "" {
		return nil, errors.New("egress_addr is required")
	}
	if cfg.ListenAddr == "" {
		cfg.ListenAddr = "127.0.0.1:0"
	}
	if cfg.BufBytes <= 0 {
		cfg.BufBytes = 32 * 1024 * 1024
	}
	if cfg.MaxViewers <= 0 {
		cfg.MaxViewers = 4
	}
	if cfg.StreamTimeout <= 0 {
		cfg.StreamTimeout = 8 * time.Second
	}
	return &Tee{
		cfg:  cfg,
		subs: make(map[chan []byte]struct{}),
	}, nil
}

// BoundUDPAddr returns the actual local UDP address that ingest srt-live-transmit should send to.
func (t *Tee) BoundUDPAddr() string {
	if t.listenConn == nil {
		return t.cfg.ListenAddr
	}
	return t.listenConn.LocalAddr().String()
}

// BoundHTTPAddr returns the actual local HTTP address serving /healthz and /ts.
func (t *Tee) BoundHTTPAddr() string {
	if t.httpLn == nil {
		return t.cfg.HTTPAddr
	}
	return t.httpLn.Addr().String()
}

// IsFlowing returns true if media packets arrived within the last 3 seconds.
func (t *Tee) IsFlowing() bool {
	last := t.lastPacketUnix.Load()
	if last == 0 {
		return false
	}
	return (time.Now().Unix() - last) <= 3
}

// Health returns a lightweight atomic telemetry snapshot.
func (t *Tee) Health() HealthSnapshot {
	return HealthSnapshot{
		OK:      true,
		Flowing: t.IsFlowing(),
		Packets: t.packets.Load(),
		Bytes:   t.bytes.Load(),
		Viewers: t.viewerCount.Load(),
	}
}

// Start binds the UDP sockets and optional HTTP preview server, then runs until ctx is canceled.
func (t *Tee) Start(ctx context.Context) error {
	laddr, err := net.ResolveUDPAddr("udp", t.cfg.ListenAddr)
	if err != nil {
		return fmt.Errorf("resolve listen_addr %q: %w", t.cfg.ListenAddr, err)
	}
	eaddr, err := net.ResolveUDPAddr("udp", t.cfg.EgressAddr)
	if err != nil {
		return fmt.Errorf("resolve egress_addr %q: %w", t.cfg.EgressAddr, err)
	}

	lconn, err := net.ListenUDP("udp", laddr)
	if err != nil {
		return fmt.Errorf("listen udp %q: %w", t.cfg.ListenAddr, err)
	}
	_ = lconn.SetReadBuffer(t.cfg.BufBytes)

	econn, err := net.DialUDP("udp", nil, eaddr)
	if err != nil {
		_ = lconn.Close()
		return fmt.Errorf("dial egress udp %q: %w", t.cfg.EgressAddr, err)
	}
	_ = econn.SetWriteBuffer(t.cfg.BufBytes)

	t.listenConn = lconn
	t.egressConn = econn

	if t.cfg.HTTPAddr != "" {
		ln, err := net.Listen("tcp", t.cfg.HTTPAddr)
		if err != nil {
			_ = lconn.Close()
			_ = econn.Close()
			return fmt.Errorf("listen preview http %q: %w", t.cfg.HTTPAddr, err)
		}
		t.httpLn = ln
		t.httpSrv = &http.Server{
			Handler:           t.httpHandler(),
			ReadHeaderTimeout: 5 * time.Second,
		}
		go func() {
			_ = t.httpSrv.Serve(ln)
		}()
	}

	go t.forwardLoop(ctx)
	go func() {
		<-ctx.Done()
		_ = lconn.Close()
		_ = econn.Close()
		if t.httpSrv != nil {
			shutCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			_ = t.httpSrv.Shutdown(shutCtx)
		}
	}()
	return nil
}

func (t *Tee) forwardLoop(ctx context.Context) {
	buf := make([]byte, 65535)
	for {
		n, err := t.listenConn.Read(buf)
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

		// Primary live broadcast path: always write immediately, zero locking.
		_, _ = t.egressConn.Write(payload)

		t.packets.Add(1)
		t.bytes.Add(uint64(n))
		t.lastPacketUnix.Store(time.Now().Unix())

		// Zero-allocation fast path when no preview thumbnail grabber is connected.
		if t.viewerCount.Load() == 0 {
			continue
		}

		pktCopy := make([]byte, n)
		copy(pktCopy, payload)
		t.subMu.RLock()
		for ch := range t.subs {
			select {
			case ch <- pktCopy:
			default:
				// Slow preview consumer drops frames here; live broadcast never blocks.
			}
		}
		t.subMu.RUnlock()
	}
}

func (t *Tee) httpHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(t.Health())
	})
	mux.HandleFunc("GET /ts", t.handleStreamTS)
	return mux
}

func (t *Tee) handleStreamTS(w http.ResponseWriter, r *http.Request) {
	if !t.IsFlowing() {
		http.Error(w, "no active stream", http.StatusServiceUnavailable)
		return
	}
	if int(t.viewerCount.Load()) >= t.cfg.MaxViewers {
		http.Error(w, "too many preview viewers", http.StatusTooManyRequests)
		return
	}

	ch := make(chan []byte, 256)
	t.subMu.Lock()
	t.subs[ch] = struct{}{}
	t.viewerCount.Add(1)
	t.subMu.Unlock()

	defer func() {
		t.subMu.Lock()
		delete(t.subs, ch)
		t.viewerCount.Add(-1)
		t.subMu.Unlock()
	}()

	w.Header().Set("Content-Type", "video/mp2t")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	timer := time.NewTimer(t.cfg.StreamTimeout)
	defer timer.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			return
		case pkt := <-ch:
			if _, err := w.Write(pkt); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}
