package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	webassets "github.com/yikkrrtykj/srt-cam/web"

	"github.com/yikkrrtykj/srt-cam/internal/auth"
	"github.com/yikkrrtykj/srt-cam/internal/cluster"
	"github.com/yikkrrtykj/srt-cam/internal/collector"
	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/diagnosis"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/notify"
	"github.com/yikkrrtykj/srt-cam/internal/storage"
	"github.com/yikkrrtykj/srt-cam/internal/web"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "hash-password" {
		runHashPassword(os.Args[2:])
		return
	}

	cfgPath := flag.String("config", "", "path to node config.json")
	eventsPath := flag.String("events", "", "path to event-sheet.json")
	listenOverride := flag.String("listen", "", "override HTTP listen address (e.g. 127.0.0.1:8080)")
	demoMode := flag.Bool("demo", false, "run offline demo mode with simulated 3-VPS bidirectional failover")
	flag.Parse()

	cfg := config.DefaultNodeConfig()
	if *cfgPath != "" {
		loaded, err := config.LoadNodeConfig(*cfgPath)
		if err != nil {
			log.Fatalf("STOP: %v", err)
		}
		cfg = loaded
	}
	if *listenOverride != "" {
		cfg.ListenAddr = *listenOverride
	}
	if *demoMode {
		cfg.DemoMode = true
		if *cfgPath == "" {
			cfg.DBPath = ":memory:"
			cfg.DisplayName = "VPS-1 (主节点·电信优化)"
			cfg.Region = "Singapore"
			cfg.PublicIP = "198.51.100.11"
			cfg.Peers = []config.PeerNodeConfig{
				{NodeID: "vps-2", DisplayName: "VPS-2 (备节点·公网)", Region: "HongKong", PublicIP: "198.51.100.12"},
				{NodeID: "vps-3", DisplayName: "VPS-3 (备节点·联通优化)", Region: "Tokyo", PublicIP: "198.51.100.13"},
			}
		}
	}

	evStore, err := config.NewEventStore(*eventsPath, cfg.NodeID)
	if err != nil {
		log.Fatalf("STOP: %v", err)
	}

	store, err := storage.Open(cfg.DBPath)
	if err != nil {
		log.Fatalf("STOP: open storage: %v", err)
	}
	defer store.Close()

	if cfg.DemoMode {
		seedDemoHistory(context.Background(), store, cfg, evStore.Get())
	}

	col := collector.New(cfg)
	clusterMgr := cluster.NewManager(cfg)
	authMgr := auth.NewManager(cfg.Auth, cfg.ClusterToken)
	alertMgr := notify.NewAlertManager(cfg.NodeID, cfg.IsPrimaryMonitor, cfg.Feishu, store, nil)

	srv := web.NewServer(
		cfg,
		evStore,
		store,
		authMgr,
		clusterMgr,
		col.RestartLocalChannel,
		web.NewFeishuTestFunc(cfg),
		webassets.Dist,
	)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Run initial sample immediately so first page load has complete live data
	runCycle(ctx, cfg, evStore, col, clusterMgr, store, alertMgr, srv)

	// Background telemetry & alert loop
	go func() {
		ticker := time.NewTicker(time.Duration(cfg.SampleIntervalSec) * time.Second)
		defer ticker.Stop()
		pruneTicker := time.NewTicker(1 * time.Hour)
		defer pruneTicker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				runCycle(ctx, cfg, evStore, col, clusterMgr, store, alertMgr, srv)
			case <-pruneTicker.C:
				cutoff := time.Now().Add(-time.Duration(cfg.RetentionDays) * 24 * time.Hour).Unix()
				if n, err := store.PruneOlderThan(ctx, cutoff); err == nil && n > 0 {
					log.Printf("[srt-camd] pruned %d telemetry rows older than %d days", n, cfg.RetentionDays)
				}
			}
		}
	}()

	httpSrv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	log.Printf("[srt-camd] node=%s listen=http://%s demo=%v auth=%v feishu=%v peers=%d",
		cfg.NodeID, cfg.ListenAddr, cfg.DemoMode, authMgr.IsAuthEnabled(), cfg.Feishu.Enabled, len(cfg.Peers))

	go func() {
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("STOP: http server error: %v", err)
		}
	}()

	<-ctx.Done()
	log.Printf("[srt-camd] shutting down control plane (data-plane relay containers untouched)")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx)
}

func runCycle(
	ctx context.Context,
	cfg config.NodeConfig,
	evStore *config.EventStore,
	col *collector.Collector,
	clusterMgr *cluster.Manager,
	store *storage.Store,
	alertMgr *notify.AlertManager,
	srv *web.Server,
) {
	sheet := evStore.Get()
	localStatus, samples := col.CollectOnce(ctx, sheet)
	_ = store.InsertSamples(ctx, localStatus.Host, samples)

	clusterMgr.PollPeers(ctx, sheet)
	allNodes := clusterMgr.SnapshotAll(localStatus)
	ov := srv.UpdateSnapshot(localStatus, allNodes, sheet)

	primaryHealthy := clusterMgr.CheckPrimaryHealthy(ctx)
	alertMgr.Evaluate(ctx, time.Now(), sheet.EventName, ov.Groups, primaryHealthy)
}

func runHashPassword(args []string) {
	fs := flag.NewFlagSet("hash-password", flag.ExitOnError)
	pw := fs.String("password", "", "plaintext password to hash with bcrypt")
	_ = fs.Parse(args)
	if *pw == "" {
		log.Fatal("Usage: srt-camd hash-password --password 'YourStrongPassword'")
	}
	hash, err := auth.HashPassword(*pw)
	if err != nil {
		log.Fatalf("STOP: %v", err)
	}
	fmt.Println(hash)
}

// seedDemoHistory populates 20 minutes of realistic historical samples + a primary failover event
// in --demo mode so the 4-layer synchronized timeline & evidence screenshot mode are immediately rich.
func seedDemoHistory(ctx context.Context, store *storage.Store, cfg config.NodeConfig, sheet config.EventSheet) {
	now := time.Now().Unix()
	start := now - 20*60
	incidentStart := now - 8*60
	incidentEnd := now - 6*60

	for ts := start; ts <= now; ts += 5 {
		t := float64(ts)
		host := model.HostSample{
			Timestamp:       ts,
			NodeID:          cfg.NodeID,
			CPUPercent:      14.5 + 3.5*math.Sin(t/40.0),
			MemPercent:      31.5,
			NetRxMbps:       48.0 + 2.0*math.Cos(t/30.0),
			NetTxMbps:       48.0 + 2.0*math.Cos(t/30.0),
			UDPRcvbufErrors: 0,
			Load1:           0.40,
		}
		var batch []model.ChannelSample
		for idx, grp := range sheet.SignalGroups {
			for _, leg := range grp.Legs {
				if leg.NodeID != cfg.NodeID {
					continue
				}
				baseRate := 12.0 + float64(idx%4)*1.6
				s := model.ChannelSample{
					Timestamp:      ts,
					NodeID:         cfg.NodeID,
					ChannelID:      leg.ChannelID,
					Mode:           leg.Mode,
					ProcessState:   "running",
					RestartCount:   0,
					UptimeSec:      86400 * 4,
					HasNativeStats: true,
					Encrypted:      leg.Mode == model.ModeUDPPassthrough,
					PathMedium:     "WAN",
				}
				if grp.ExpectedActive {
					s.SrcConnected = true
					s.DstConnected = true
					s.SrcMbps = baseRate + 0.3*math.Sin(t/15.0+float64(idx))
					s.DstMbps = s.SrcMbps
					s.SrcRTTMs = 45.0 + 5.0*math.Sin(t/25.0+float64(idx))
					s.DstRTTMs = 53.0 + 6.0*math.Cos(t/28.0+float64(idx))
					s.SrcTSBPDMs = 250

					if ts >= incidentStart && ts <= incidentEnd && leg.Role == "primary" {
						if grp.ID == "en-pgm" {
							s.SrcConnected = false
							s.SrcMbps = 0
							s.DstMbps = 0
						} else if grp.ID == "ob-pgm" {
							s.DstRTTMs = 365.0 + 28.0*math.Sin(t/5.0)
							s.DstLost = 44
							s.DstRetrans = 48
							s.DstDropped = 7
						}
					}
					if grp.ID == "map" && leg.Role == "primary" {
						s.PathMedium = "LO"
					}
				}
				code, layer, summary := diagnosis.DiagnoseChannel(s, host, diagnosis.ChannelContext{
					SignalName:     grp.Name,
					DirectionLabel: sheet.DirectionLabel(grp.Direction),
					Carrier:        leg.Carrier,
					SrcDevice:      leg.SrcDevice,
					DstDevice:      leg.DstDevice,
					ExpectedActive: grp.ExpectedActive,
					PrevRestarts:   0,
				}, cfg.Thresholds)
				s.FaultCode = code
				s.FaultLayer = layer
				s.FaultSummary = summary
				batch = append(batch, s)
			}
		}
		_ = store.InsertSamples(ctx, host, batch)
	}

	_, _ = store.OpenFaultEvent(ctx, model.FaultEvent{
		StartTS:       incidentStart,
		EndTS:         incidentEnd,
		NodeID:        cfg.NodeID,
		SignalGroupID: "en-pgm",
		SignalName:    "EN-PGM",
		ChannelID:     "srt-pass1",
		Role:          "primary",
		Severity:      model.SeverityDegradedProtected,
		FaultCode:     model.FaultUpstreamOffline,
		FaultLayer:    "upstream",
		Summary:       "[电信] 云端透传运行正常（0 重启），主路上行中断 2 分钟；由备路[vps-3/联通] Makito 硬件无缝兜底，画面零中断",
		ProtectedBy:   "备路[vps-3/联通]",
	})
	_, _ = store.OpenFaultEvent(ctx, model.FaultEvent{
		StartTS:       incidentStart,
		EndTS:         incidentEnd,
		NodeID:        cfg.NodeID,
		SignalGroupID: "ob-pgm",
		SignalName:    "OB-PGM",
		ChannelID:     "srt-cam5",
		Role:          "primary",
		Severity:      model.SeverityDegradedProtected,
		FaultCode:     model.FaultDownstreamDegraded,
		FaultLayer:    "downstream",
		Summary:       "[电信] 上游与云端正常（0 重启），下游 RTT 飙升至 380ms 并触发丢弃；由备路[vps-2/备用公网] 全程兜底",
		ProtectedBy:   "备路[vps-2/备用公网]",
	})
}
