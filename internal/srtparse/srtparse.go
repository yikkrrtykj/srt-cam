package srtparse

import "encoding/binary"

// ControlType represents the 15-bit SRT control packet type field.
type ControlType uint16

const (
	ControlHandshake  ControlType = 0x0000
	ControlKeepalive  ControlType = 0x0001
	ControlACK        ControlType = 0x0002
	ControlNAK        ControlType = 0x0003
	ControlCongestion ControlType = 0x0004
	ControlShutdown   ControlType = 0x0005
	ControlACKACK     ControlType = 0x0006
	ControlDropReq    ControlType = 0x0007
	ControlPeerError  ControlType = 0x0008
)

// Packet represents the unencrypted 16-byte SRT packet header (plus NAK loss count if applicable).
// SRT AES encryption only protects the media payload; the 16-byte header and control CIF remain readable.
type Packet struct {
	IsControl      bool
	ControlType    ControlType
	Subtype        uint16
	SeqNo          uint32
	Retransmitted  bool
	Encrypted      bool
	MessageNo      uint32
	TimestampUS    uint32
	DestSocketID   uint32
	PayloadBytes   int
	NAKLostPackets int
	DropReqPackets int
}

// ParseHeader inspects a raw UDP payload as an SRT packet without mutating it.
// Returns (pkt, true) if payload has at least the 16-byte SRT header.
func ParseHeader(b []byte) (Packet, bool) {
	if len(b) < 16 {
		return Packet{}, false
	}
	w0 := binary.BigEndian.Uint32(b[0:4])
	w1 := binary.BigEndian.Uint32(b[4:8])
	w2 := binary.BigEndian.Uint32(b[8:12])
	w3 := binary.BigEndian.Uint32(b[12:16])

	pkt := Packet{
		TimestampUS:  w2,
		DestSocketID: w3,
		PayloadBytes: len(b) - 16,
	}

	if (w0 & 0x80000000) != 0 {
		pkt.IsControl = true
		pkt.ControlType = ControlType((w0 >> 16) & 0x7FFF)
		pkt.Subtype = uint16(w0 & 0xFFFF)
		switch pkt.ControlType {
		case ControlNAK:
			pkt.NAKLostPackets = countNAKPackets(b[16:])
		case ControlDropReq:
			pkt.DropReqPackets = countDropReqPackets(b[16:])
		}
		return pkt, true
	}

	pkt.SeqNo = w0 & 0x7FFFFFFF
	kk := (w1 >> 27) & 0x03
	pkt.Encrypted = kk != 0
	pkt.Retransmitted = ((w1 >> 26) & 0x01) != 0
	pkt.MessageNo = w1 & 0x03FFFFFF
	return pkt, true
}

// countNAKPackets counts how many lost sequence numbers are encoded in an SRT NAK CIF.
// Per SRT spec: each 32-bit word with MSB=0 is a single lost seq; MSB=1 starts a [first, last] pair.
func countNAKPackets(cif []byte) int {
	total := 0
	i := 0
	for i+4 <= len(cif) {
		first := binary.BigEndian.Uint32(cif[i : i+4])
		i += 4
		if (first & 0x80000000) == 0 {
			total++
			continue
		}
		if i+4 > len(cif) {
			break
		}
		last := binary.BigEndian.Uint32(cif[i : i+4])
		i += 4
		start := first & 0x7FFFFFFF
		end := last & 0x7FFFFFFF
		var span uint32
		if end >= start {
			span = end - start + 1
		} else {
			// 31-bit sequence wraparound
			span = (0x7FFFFFFF - start) + end + 2
		}
		// Guard against malformed/bogus ranges
		if span > 100000 {
			span = 1
		}
		total += int(span)
	}
	return total
}

// countDropReqPackets counts how many dropped sequence numbers are encoded in an SRT
// Message Drop Request (0x0007) CIF: [firstSeq(32), lastSeq(32)]. Falls back to 1 if CIF is omitted.
func countDropReqPackets(cif []byte) int {
	if len(cif) < 8 {
		return 1
	}
	first := binary.BigEndian.Uint32(cif[0:4]) & 0x7FFFFFFF
	last := binary.BigEndian.Uint32(cif[4:8]) & 0x7FFFFFFF
	var span uint32
	if last >= first {
		span = last - first + 1
	} else {
		span = (0x7FFFFFFF - first) + last + 2
	}
	if span == 0 || span > 100000 {
		return 1
	}
	return int(span)
}

