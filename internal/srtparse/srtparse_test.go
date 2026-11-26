package srtparse

import (
	"encoding/binary"
	"testing"
)

func TestParseDataPacket(t *testing.T) {
	buf := make([]byte, 16+1316)
	// F=0, SeqNo=123456
	binary.BigEndian.PutUint32(buf[0:4], 123456)
	// PP=11, O=0, KK=01 (encrypted even key), R=1 (retransmitted), MsgNo=42
	w1 := uint32(3<<30) | uint32(1<<27) | uint32(1<<26) | 42
	binary.BigEndian.PutUint32(buf[4:8], w1)
	binary.BigEndian.PutUint32(buf[8:12], 987654)
	binary.BigEndian.PutUint32(buf[12:16], 0x11223344)

	pkt, ok := ParseHeader(buf)
	if !ok {
		t.Fatalf("expected valid packet")
	}
	if pkt.IsControl {
		t.Fatalf("expected data packet")
	}
	if pkt.SeqNo != 123456 {
		t.Fatalf("SeqNo = %d, want 123456", pkt.SeqNo)
	}
	if !pkt.Retransmitted {
		t.Fatalf("expected Retransmitted=true")
	}
	if !pkt.Encrypted {
		t.Fatalf("expected Encrypted=true")
	}
	if pkt.MessageNo != 42 {
		t.Fatalf("MessageNo = %d, want 42", pkt.MessageNo)
	}
	if pkt.PayloadBytes != 1316 {
		t.Fatalf("PayloadBytes = %d, want 1316", pkt.PayloadBytes)
	}
}

func TestParseNAKControlPacket(t *testing.T) {
	// 16 byte header + 1 single seq + 1 range [100..104] (5 packets) => 6 lost packets
	buf := make([]byte, 16+12)
	w0 := uint32(1<<31) | (uint32(ControlNAK) << 16)
	binary.BigEndian.PutUint32(buf[0:4], w0)
	binary.BigEndian.PutUint32(buf[16:20], 50)
	binary.BigEndian.PutUint32(buf[20:24], 0x80000000|100)
	binary.BigEndian.PutUint32(buf[24:28], 104)

	pkt, ok := ParseHeader(buf)
	if !ok {
		t.Fatalf("expected valid NAK packet")
	}
	if !pkt.IsControl || pkt.ControlType != ControlNAK {
		t.Fatalf("expected ControlNAK, got isControl=%v type=%d", pkt.IsControl, pkt.ControlType)
	}
	if pkt.NAKLostPackets != 6 {
		t.Fatalf("NAKLostPackets = %d, want 6", pkt.NAKLostPackets)
	}
}

func TestParseControlTypesAndShortBuffer(t *testing.T) {
	if _, ok := ParseHeader([]byte{1, 2, 3}); ok {
		t.Fatalf("expected short buffer to fail")
	}

	for _, ct := range []ControlType{ControlHandshake, ControlKeepalive, ControlACK, ControlShutdown, ControlDropReq} {
		buf := make([]byte, 16)
		binary.BigEndian.PutUint32(buf[0:4], uint32(1<<31)|(uint32(ct)<<16))
		pkt, ok := ParseHeader(buf)
		if !ok || !pkt.IsControl || pkt.ControlType != ct {
			t.Fatalf("failed to parse control type %d", ct)
		}
		if ct == ControlDropReq && pkt.DropReqPackets != 1 {
			t.Fatalf("header-only DropReqPackets = %d, want 1", pkt.DropReqPackets)
		}
	}
}

func TestParseDropReqControlPacket(t *testing.T) {
	// 16-byte header + [firstSeq=500, lastSeq=503] => 4 unrecovered dropped packets
	buf := make([]byte, 16+8)
	binary.BigEndian.PutUint32(buf[0:4], uint32(1<<31)|(uint32(ControlDropReq)<<16))
	binary.BigEndian.PutUint32(buf[16:20], 500)
	binary.BigEndian.PutUint32(buf[20:24], 503)

	pkt, ok := ParseHeader(buf)
	if !ok {
		t.Fatalf("expected valid DropReq packet")
	}
	if !pkt.IsControl || pkt.ControlType != ControlDropReq {
		t.Fatalf("expected ControlDropReq, got isControl=%v type=%d", pkt.IsControl, pkt.ControlType)
	}
	if pkt.DropReqPackets != 4 {
		t.Fatalf("DropReqPackets = %d, want 4", pkt.DropReqPackets)
	}
}

