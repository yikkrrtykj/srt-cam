package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/relaytee"
)

const defaultTransmitBin = "/usr/local/bin/srt-live-transmit"

// ParseTransmitArgs splits srt-live-transmit CLI args into (options, inURI, outURI).
func ParseTransmitArgs(args []string) (flags []string, inURI, outURI string, ok bool) {
	var pos []string
	for _, a := range args {
		if strings.HasPrefix(a, "-") {
			flags = append(flags, a)
			continue
		}
		pos = append(pos, a)
	}
	if len(pos) < 2 {
		return flags, "", "", false
	}
	return flags, pos[0], pos[1], true
}

// DeriveEgressUDPPort picks the local loopback UDP port connecting the Go Tee to the
// egress srt-live-transmit process (defaults to previewPort - 2000, e.g. 29115 -> 27115).
func DeriveEgressUDPPort(previewAddr, override string) (int, error) {
	if strings.TrimSpace(override) != "" {
		p, err := strconv.Atoi(strings.TrimSpace(override))
		if err != nil || p <= 0 || p > 65535 {
			return 0, fmt.Errorf("invalid INTERNAL_EGRESS_UDP_PORT %q", override)
		}
		return p, nil
	}
	_, portStr, err := net.SplitHostPort(previewAddr)
	if err != nil {
		return 0, fmt.Errorf("parse PREVIEW_HTTP_ADDR %q: %w", previewAddr, err)
	}
	p, err := strconv.Atoi(portStr)
	if err != nil || p <= 0 || p > 65535 {
		return 0, fmt.Errorf("invalid preview port %q", portStr)
	}
	if p > 2000 {
		return p - 2000, nil
	}
	return p + 2000, nil
}

func main() {
	bin := os.Getenv("SRT_TRANSMIT_BIN")
	if bin == "" {
		bin = defaultTransmitBin
	}
	previewHTTP := strings.TrimSpace(os.Getenv("PREVIEW_HTTP_ADDR"))
	args := os.Args[1:]

	// Zero-overhead passthrough when PREVIEW_HTTP_ADDR is not enabled:
	// replaces PID 1 directly with srt-live-transmit.
	if previewHTTP == "" {
		execArgs := append([]string{bin}, args...)
		if err := syscall.Exec(bin, execArgs, os.Environ()); err != nil {
			log.Fatalf("exec %s: %v", bin, err)
		}
		return
	}

	flags, inURI, outURI, ok := ParseTransmitArgs(args)
	if !ok {
		// Fall back to direct exec (e.g. -version / -help)
		execArgs := append([]string{bin}, args...)
		if err := syscall.Exec(bin, execArgs, os.Environ()); err != nil {
			log.Fatalf("exec %s: %v", bin, err)
		}
		return
	}

	egressPort, err := DeriveEgressUDPPort(previewHTTP, os.Getenv("INTERNAL_EGRESS_UDP_PORT"))
	if err != nil {
		log.Fatalf("STOP: %v", err)
	}
	egressAddr := fmt.Sprintf("127.0.0.1:%d", egressPort)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	tee, err := relaytee.New(relaytee.Config{
		ListenAddr: "127.0.0.1:0",
		EgressAddr: egressAddr,
		HTTPAddr:   previewHTTP,
		BufBytes:   32 * 1024 * 1024,
	})
	if err != nil {
		log.Fatalf("STOP: init relaytee: %v", err)
	}
	if err := tee.Start(ctx); err != nil {
		log.Fatalf("STOP: start relaytee: %v", err)
	}

	var outMu sync.Mutex
	egressArgs := append(append([]string{}, flags...),
		fmt.Sprintf("udp://%s?rcvbuf=33554432", egressAddr),
		outURI,
	)
	ingestArgs := append(append([]string{}, flags...),
		inURI,
		fmt.Sprintf("udp://%s?sndbuf=33554432", tee.BoundUDPAddr()),
	)

	egressCmd, err := startChild(ctx, bin, egressArgs, &outMu)
	if err != nil {
		log.Fatalf("STOP: start egress srt-live-transmit: %v", err)
	}
	// Give egress UDP socket a brief moment to bind before ingest begins pushing
	time.Sleep(150 * time.Millisecond)

	ingestCmd, err := startChild(ctx, bin, ingestArgs, &outMu)
	if err != nil {
		_ = egressCmd.Process.Signal(syscall.SIGTERM)
		log.Fatalf("STOP: start ingest srt-live-transmit: %v", err)
	}

	log.Printf("[srt-relayd] preview tee active: %s -> udp://%s -> udp://%s -> %s (preview http://%s/ts)",
		inURI, tee.BoundUDPAddr(), egressAddr, outURI, tee.BoundHTTPAddr())

	errCh := make(chan error, 2)
	go func() { errCh <- fmt.Errorf("ingest exited: %w", ingestCmd.Wait()) }()
	go func() { errCh <- fmt.Errorf("egress exited: %w", egressCmd.Wait()) }()

	select {
	case <-ctx.Done():
		stopChild(ingestCmd)
		stopChild(egressCmd)
	case err := <-errCh:
		stopChild(ingestCmd)
		stopChild(egressCmd)
		log.Fatalf("[srt-relayd] %v", err)
	}
}

func startChild(ctx context.Context, bin string, args []string, mu *sync.Mutex) (*exec.Cmd, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go forwardLines(stdout, os.Stdout, mu)
	go forwardLines(stderr, os.Stderr, mu)
	return cmd, nil
}

func forwardLines(r io.Reader, w io.Writer, mu *sync.Mutex) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 512*1024)
	for sc.Scan() {
		mu.Lock()
		_, _ = fmt.Fprintln(w, sc.Text())
		mu.Unlock()
	}
}

func stopChild(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
}
