package relaytee

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestTeeForwardsLosslessAndServesOnDemandTS(t *testing.T) {
	egressAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	egressRecv, err := net.ListenUDP("udp", egressAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer egressRecv.Close()

	tee, err := New(Config{
		ListenAddr:    "127.0.0.1:0",
		EgressAddr:    egressRecv.LocalAddr().String(),
		HTTPAddr:      "127.0.0.1:0",
		BufBytes:      1 << 20,
		StreamTimeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := tee.Start(ctx); err != nil {
		t.Fatal(err)
	}

	// Before any packets arrive, /healthz reports flowing=false and /ts returns 503
	respIdle, err := http.Get("http://" + tee.BoundHTTPAddr() + "/ts")
	if err != nil {
		t.Fatal(err)
	}
	respIdle.Body.Close()
	if respIdle.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("idle /ts status = %d, want 503", respIdle.StatusCode)
	}

	sender, err := net.Dial("udp", tee.BoundUDPAddr())
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()

	// Build a 1316-byte MPEG-TS-like packet (7 * 188 bytes starting with sync byte 0x47)
	tsPkt := make([]byte, 1316)
	for i := 0; i < 7; i++ {
		tsPkt[i*188] = 0x47
	}
	copy(tsPkt[4:], []byte("BROADCAST_LIVE_PAYLOAD"))

	// Prime flowing state
	if _, err := sender.Write(tsPkt); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 2048)
	_ = egressRecv.SetReadDeadline(time.Now().Add(2 * time.Second))
	n, _, err := egressRecv.ReadFromUDP(buf)
	if err != nil {
		t.Fatalf("egress read: %v", err)
	}
	if !bytes.Equal(buf[:n], tsPkt) {
		t.Fatalf("live egress payload mutated")
	}

	// Verify /healthz reports flowing=true
	respH, err := http.Get("http://" + tee.BoundHTTPAddr() + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	var health HealthSnapshot
	if err := json.NewDecoder(respH.Body).Decode(&health); err != nil {
		t.Fatal(err)
	}
	respH.Body.Close()
	if !health.Flowing || health.Packets < 1 {
		t.Fatalf("unexpected health: %+v", health)
	}

	// Open HTTP /ts viewer and stream 5 more packets; verify both live egress and HTTP /ts receive exact bytes
	tsReqCtx, tsCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer tsCancel()
	req, _ := http.NewRequestWithContext(tsReqCtx, http.MethodGet, "http://"+tee.BoundHTTPAddr()+"/ts", nil)
	tsResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer tsResp.Body.Close()
	if tsResp.StatusCode != http.StatusOK {
		t.Fatalf("active /ts status = %d, want 200", tsResp.StatusCode)
	}

	go func() {
		time.Sleep(50 * time.Millisecond)
		for i := 0; i < 5; i++ {
			_, _ = sender.Write(tsPkt)
			time.Sleep(15 * time.Millisecond)
		}
	}()

	// Verify live egress gets all 5 packets intact
	for i := 0; i < 5; i++ {
		_ = egressRecv.SetReadDeadline(time.Now().Add(2 * time.Second))
		rn, _, err := egressRecv.ReadFromUDP(buf)
		if err != nil {
			t.Fatalf("egress read %d: %v", i, err)
		}
		if !bytes.Equal(buf[:rn], tsPkt) {
			t.Fatalf("egress packet %d mismatch", i)
		}
	}

	// Verify HTTP /ts viewer receives exact TS bytes starting with 0x47
	gotTS := make([]byte, 1316)
	if _, err := io.ReadFull(tsResp.Body, gotTS); err != nil {
		t.Fatalf("read /ts body: %v", err)
	}
	if !bytes.Equal(gotTS, tsPkt) {
		t.Fatalf("HTTP /ts bytes mismatch")
	}
}
