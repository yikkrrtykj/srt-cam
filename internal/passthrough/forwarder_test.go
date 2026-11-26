package passthrough

import (
	"bytes"
	"context"
	"encoding/binary"
	"net"
	"testing"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/srtparse"
)

func TestForwarderBidirectionalAndTelemetry(t *testing.T) {
	// Mock Decoder Listener on loopback
	decoderAddr, err := net.ResolveUDPAddr("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	decoderConn, err := net.ListenUDP("udp", decoderAddr)
	if err != nil {
		t.Fatal(err)
	}
	defer decoderConn.Close()

	fwd, err := New(Config{
		ID:         "srt-pass-test",
		ListenAddr: "127.0.0.1:0",
		TargetAddr: decoderConn.LocalAddr().String(),
		BufBytes:   1 << 20,
		SessionTTL: 5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := fwd.Start(ctx); err != nil {
		t.Fatal(err)
	}

	// Mock Encoder Caller
	encConn, err := net.Dial("udp", fwd.BoundAddr())
	if err != nil {
		t.Fatal(err)
	}
	defer encConn.Close()

	// Build a retransmitted + encrypted SRT data packet (1332 bytes)
	dataPkt := make([]byte, 16+1316)
	binary.BigEndian.PutUint32(dataPkt[0:4], 777)
	binary.BigEndian.PutUint32(dataPkt[4:8], uint32(1<<27)|uint32(1<<26)|10)
	copy(dataPkt[16:], []byte("ENCRYPTED_PAYLOAD_EXACT_BYTES"))

	// Send 20 packets so upstream Mbps >= 0.05 Mbps
	for i := 0; i < 20; i++ {
		if _, err := encConn.Write(dataPkt); err != nil {
			t.Fatal(err)
		}
	}

	// Verify exact byte-for-byte delivery at mock decoder
	recvBuf := make([]byte, 2048)
	_ = decoderConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var relayPeer *net.UDPAddr
	for i := 0; i < 20; i++ {
		n, addr, err := decoderConn.ReadFromUDP(recvBuf)
		if err != nil {
			t.Fatalf("decoder read %d: %v", i, err)
		}
		relayPeer = addr
		if !bytes.Equal(recvBuf[:n], dataPkt) {
			t.Fatalf("payload mutated during L4 passthrough")
		}
	}

	// Decoder sends back an SRT NAK control packet reporting 3 lost packets
	nakPkt := make([]byte, 16+8)
	binary.BigEndian.PutUint32(nakPkt[0:4], uint32(1<<31)|(uint32(srtparse.ControlNAK)<<16))
	binary.BigEndian.PutUint32(nakPkt[16:20], 0x80000000|10)
	binary.BigEndian.PutUint32(nakPkt[20:24], 12)
	if _, err := decoderConn.WriteToUDP(nakPkt, relayPeer); err != nil {
		t.Fatal(err)
	}

	// Verify encoder receives exact NAK packet back
	_ = encConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	encRecv := make([]byte, 2048)
	n, err := encConn.Read(encRecv)
	if err != nil {
		t.Fatalf("encoder read NAK: %v", err)
	}
	if !bytes.Equal(encRecv[:n], nakPkt) {
		t.Fatalf("return NAK packet mutated")
	}

	// Encoder sends an SRT DropReq (0x0007) signaling 2 unrecovered dropped packets [500..501]
	dropReqPkt := make([]byte, 16+8)
	binary.BigEndian.PutUint32(dropReqPkt[0:4], uint32(1<<31)|(uint32(srtparse.ControlDropReq)<<16))
	binary.BigEndian.PutUint32(dropReqPkt[16:20], 500)
	binary.BigEndian.PutUint32(dropReqPkt[20:24], 501)
	if _, err := encConn.Write(dropReqPkt); err != nil {
		t.Fatal(err)
	}
	_ = decoderConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	dn, _, err := decoderConn.ReadFromUDP(recvBuf)
	if err != nil {
		t.Fatalf("decoder read DropReq: %v", err)
	}
	if !bytes.Equal(recvBuf[:dn], dropReqPkt) {
		t.Fatalf("DropReq packet mutated during passthrough")
	}

	// Wait for 1s sampler tick
	time.Sleep(1200 * time.Millisecond)
	snap := fwd.Snapshot()
	if snap.State != "FLOW" {
		t.Fatalf("State = %q, want FLOW (upMbps=%.4f)", snap.State, snap.UpstreamMbps)
	}
	if snap.PathMedium != "LO" {
		t.Fatalf("PathMedium = %q, want LO", snap.PathMedium)
	}
	if !snap.Encrypted {
		t.Fatalf("expected Encrypted=true")
	}
	if snap.RetransPackets != 20 {
		t.Fatalf("RetransPackets = %d, want 20", snap.RetransPackets)
	}
	if snap.NAKReports != 1 || snap.NAKLostPackets != 3 {
		t.Fatalf("NAK = (%d reports, %d lost), want (1, 3)", snap.NAKReports, snap.NAKLostPackets)
	}
	if snap.DropReqPackets != 2 {
		t.Fatalf("DropReqPackets = %d, want 2", snap.DropReqPackets)
	}
}

