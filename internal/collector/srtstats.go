package collector

import (
	"encoding/binary"
	"encoding/json"
	"net"
	"regexp"
	"strings"
	"time"
)

// ParsedSRTLogs holds the latest SOURCE (ingest) and TARGET (egress) state parsed from
// srt-live-transmit Docker logs (both native JSON stats and text lifecycle/drop events).
type ParsedSRTLogs struct {
	HasNativeStats bool

	SrcConnected bool
	SrcMbps      float64
	SrcRTTMs     float64
	SrcLost      int64
	SrcRetrans   int64
	SrcDropped   int64
	SrcTSBPDMs   float64
	SrcLastTS    time.Time
	SrcPeerIP    string

	DstConnected bool
	DstMbps      float64
	DstRTTMs     float64
	DstLost      int64
	DstRetrans   int64
	DstDropped   int64
	DstLastTS    time.Time
	DstPeerIP    string

	PathMedium string // WAN, LO, WAN+LO, -
}

type rawSRTStats struct {
	SID  int64 `json:"sid"`
	Link struct {
		RTT float64 `json:"rtt"`
	} `json:"link"`
	Recv struct {
		Packets              float64 `json:"packets"`
		PacketsLost          int64   `json:"packetsLost"`
		PacketsRetransmitted int64   `json:"packetsRetransmitted"`
		PacketsDropped       int64   `json:"packetsDropped"`
		MsTsbPdDelay         float64 `json:"msTsbPdDelay"`
		MbitRate             float64 `json:"mbitRate"`
	} `json:"recv"`
	Send struct {
		Packets              float64 `json:"packets"`
		PacketsLost          int64   `json:"packetsLost"`
		PacketsRetransmitted int64   `json:"packetsRetransmitted"`
		PacketsDropped       int64   `json:"packetsDropped"`
		MbitRate             float64 `json:"mbitRate"`
	} `json:"send"`
}

var (
	rePeerIP     = regexp.MustCompile(`\b(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\b`)
	reRcvDropped = regexp.MustCompile(`(?i)\bRCV-DROPPED\b`)
	reSndDropped = regexp.MustCompile(`(?i)\bSND-DROPPED\b`)
)

// DemuxDockerStream strips Docker's 8-byte multiplexed stream headers if present,
// falling back cleanly to raw text when tty=true or already plain text.
func DemuxDockerStream(raw []byte) string {
	if len(raw) < 8 {
		return string(raw)
	}
	// Docker multiplexed frame header: [stream_type(1 or 2), 0, 0, 0, size(uint32 BE)]
	if (raw[0] == 1 || raw[0] == 2) && raw[1] == 0 && raw[2] == 0 && raw[3] == 0 {
		var sb strings.Builder
		pos := 0
		valid := false
		for pos+8 <= len(raw) {
			st := raw[pos]
			if (st != 1 && st != 2 && st != 0) || raw[pos+1] != 0 || raw[pos+2] != 0 || raw[pos+3] != 0 {
				break
			}
			sz := int(binary.BigEndian.Uint32(raw[pos+4 : pos+8]))
			pos += 8
			if sz < 0 || pos+sz > len(raw) {
				break
			}
			sb.Write(raw[pos : pos+sz])
			pos += sz
			valid = true
		}
		if valid {
			return sb.String()
		}
	}
	return string(raw)
}

// ParseSRTLogs extracts latest SOURCE & TARGET metrics and connection lifecycle events
// from timestamped srt-live-transmit logs within the freshness window relative to now.
func ParseSRTLogs(logText string, now time.Time, staleAfter time.Duration) ParsedSRTLogs {
	if staleAfter <= 0 {
		staleAfter = 20 * time.Second
	}
	res := ParsedSRTLogs{PathMedium: "-"}
	hasLO := false
	hasWAN := false

	for _, rawLine := range strings.Split(logText, "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}
		var ts time.Time
		payload := line
		if sp := strings.IndexByte(line, ' '); sp > 0 {
			if parsedTS, err := time.Parse(time.RFC3339Nano, line[:sp]); err == nil {
				ts = parsedTS
				payload = strings.TrimSpace(line[sp+1:])
			}
		}

		// 1. Native SRT JSON stats line
		if strings.HasPrefix(payload, "{") {
			var s rawSRTStats
			if err := json.Unmarshal([]byte(payload), &s); err == nil {
				switch {
				case s.Recv.Packets > s.Send.Packets:
					res.HasNativeStats = true
					res.SrcMbps = s.Recv.MbitRate
					res.SrcRTTMs = s.Link.RTT
					res.SrcLost = s.Recv.PacketsLost
					res.SrcRetrans = s.Recv.PacketsRetransmitted
					res.SrcDropped = s.Recv.PacketsDropped
					res.SrcTSBPDMs = s.Recv.MsTsbPdDelay
					if !ts.IsZero() {
						res.SrcLastTS = ts
					} else {
						res.SrcLastTS = now
					}
					res.SrcConnected = true
				case s.Send.Packets > s.Recv.Packets:
					res.HasNativeStats = true
					res.DstMbps = s.Send.MbitRate
					res.DstRTTMs = s.Link.RTT
					res.DstLost = s.Send.PacketsLost
					res.DstRetrans = s.Send.PacketsRetransmitted
					res.DstDropped = s.Send.PacketsDropped
					if !ts.IsZero() {
						res.DstLastTS = ts
					} else {
						res.DstLastTS = now
					}
					res.DstConnected = true
				}
			}
			continue
		}

		// 2. Text lifecycle & peer IP extraction
		lower := strings.ToLower(payload)
		if strings.Contains(lower, "accepted srt source connection") || strings.Contains(lower, "srt source connected") {
			res.SrcConnected = true
			if ip := extractIP(payload); ip != "" {
				res.SrcPeerIP = ip
				classifyIPMedium(ip, &hasLO, &hasWAN)
			}
		} else if strings.Contains(lower, "srt source disconnected") {
			res.SrcConnected = false
			res.SrcMbps = 0
		} else if strings.Contains(lower, "accepted srt target connection") || strings.Contains(lower, "srt target connected") {
			res.DstConnected = true
			if ip := extractIP(payload); ip != "" {
				res.DstPeerIP = ip
				classifyIPMedium(ip, &hasLO, &hasWAN)
			}
		} else if strings.Contains(lower, "srt target disconnected") {
			res.DstConnected = false
			res.DstMbps = 0
		}

		if reRcvDropped.MatchString(payload) {
			if res.SrcDropped == 0 {
				res.SrcDropped = 1
			}
		}
		if reSndDropped.MatchString(payload) {
			if res.DstDropped == 0 {
				res.DstDropped = 1
			}
		}
	}

	// If native stats were emitted earlier but have gone silent beyond staleAfter,
	// decay Mbps to 0 so outages are immediately detected instead of showing stale numbers.
	if res.HasNativeStats {
		if !res.SrcLastTS.IsZero() && now.Sub(res.SrcLastTS) > staleAfter {
			res.SrcMbps = 0
		}
		if !res.DstLastTS.IsZero() && now.Sub(res.DstLastTS) > staleAfter {
			res.DstMbps = 0
		}
	}

	switch {
	case hasWAN && hasLO:
		res.PathMedium = "WAN+LO"
	case hasLO:
		res.PathMedium = "LO"
	case hasWAN:
		res.PathMedium = "WAN"
	}
	return res
}

func extractIP(s string) string {
	m := rePeerIP.FindStringSubmatch(s)
	if len(m) < 2 {
		return ""
	}
	ip := net.ParseIP(m[1])
	if ip == nil {
		return ""
	}
	return ip.String()
}

func classifyIPMedium(ipStr string, hasLO, hasWAN *bool) {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return
	}
	if ip.IsLoopback() {
		*hasLO = true
	} else {
		*hasWAN = true
	}
}
