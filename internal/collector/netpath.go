package collector

import (
	"bufio"
	"net"
	"os"
	"strconv"
	"strings"
)

// PortPeerInfo describes an active connected peer seen in /proc/net/udp for a local port.
type PortPeerInfo struct {
	PeerIP     string
	PathMedium string // LO or WAN
}

// InspectLocalUDPPeers scans /proc/net/udp to detect whether traffic on SRT ports is local
// loopback (e.g., sing-box Reality proxy on 127.0.0.1) or direct WAN, without needing tcpdump/root.
func InspectLocalUDPPeers(ports map[int]bool) map[int]PortPeerInfo {
	out := make(map[int]PortPeerInfo)
	f, err := os.Open("/proc/net/udp")
	if err != nil {
		return out
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	first := true
	for sc.Scan() {
		if first {
			first = false
			continue
		}
		fields := strings.Fields(sc.Text())
		if len(fields) < 4 {
			continue
		}
		localPort := parseProcHexPort(fields[1])
		if !ports[localPort] {
			continue
		}
		remIP := parseProcHexIPv4(fields[2])
		if remIP == nil || remIP.IsUnspecified() {
			continue
		}
		med := "WAN"
		if remIP.IsLoopback() {
			med = "LO"
		}
		out[localPort] = PortPeerInfo{
			PeerIP:     remIP.String(),
			PathMedium: med,
		}
	}
	return out
}

func parseProcHexPort(addrPort string) int {
	colon := strings.IndexByte(addrPort, ':')
	if colon < 0 || colon+1 >= len(addrPort) {
		return 0
	}
	v, err := strconv.ParseInt(addrPort[colon+1:], 16, 32)
	if err != nil {
		return 0
	}
	return int(v)
}

func parseProcHexIPv4(addrPort string) net.IP {
	colon := strings.IndexByte(addrPort, ':')
	if colon <= 0 {
		return nil
	}
	hexIP := addrPort[:colon]
	if len(hexIP) != 8 {
		return nil
	}
	v, err := strconv.ParseUint(hexIP, 16, 32)
	if err != nil {
		return nil
	}
	// /proc/net/udp stores IPv4 in host little-endian byte order on x86_64/arm64 Linux.
	return net.IPv4(byte(v), byte(v>>8), byte(v>>16), byte(v>>24))
}
