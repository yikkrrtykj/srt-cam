package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/passthrough"
)

func main() {
	id := flag.String("id", "srt-pass1", "channel identifier")
	listenAddr := flag.String("listen", ":31111", "UDP listen address for incoming Makito Caller path")
	targetAddr := flag.String("target", "", "remote Makito Listener UDP address (host:port)")
	metricsAddr := flag.String("metrics", "127.0.0.1:19101", "local HTTP address for /stats telemetry")
	bufBytes := flag.Int("buf", 33554432, "UDP socket send/receive buffer size in bytes")
	sessionTTL := flag.Duration("session-ttl", 30*time.Second, "idle session eviction timeout")
	flag.Parse()

	if *targetAddr == "" {
		log.Fatal("STOP: --target host:port is required")
	}

	fwd, err := passthrough.New(passthrough.Config{
		ID:         *id,
		ListenAddr: *listenAddr,
		TargetAddr: *targetAddr,
		BufBytes:   *bufBytes,
		SessionTTL: *sessionTTL,
	})
	if err != nil {
		log.Fatalf("STOP: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := fwd.Start(ctx); err != nil {
		log.Fatalf("STOP: %v", err)
	}
	log.Printf("[srt-passd:%s] listening UDP %s -> %s (metrics http://%s/stats)",
		*id, fwd.BoundAddr(), *targetAddr, *metricsAddr)

	srv := &http.Server{
		Addr:              *metricsAddr,
		Handler:           fwd.StatsHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("[srt-passd:%s] metrics server error: %v", *id, err)
		}
	}()

	<-ctx.Done()
	shutCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutCtx)
	log.Printf("[srt-passd:%s] stopped cleanly", *id)
}
