package collector

import (
	"bufio"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// HostCollector reads Linux /proc metrics (CPU, Memory, WAN NIC rate, and /proc/net/snmp UDP errors)
// with zero external dependencies and zero packet capture overhead.
type HostCollector struct {
	nodeID string

	mu          sync.Mutex
	initialized bool
	lastTime    time.Time
	lastCPUIdle uint64
	lastCPUTot  uint64
	lastNetRx   uint64
	lastNetTx   uint64
	lastRcvErr  int64
	lastInErr   int64
	lastSndErr  int64
}

// NewHostCollector creates a Linux host metrics sampler for nodeID.
func NewHostCollector(nodeID string) *HostCollector {
	return &HostCollector{nodeID: nodeID}
}

// Sample captures current host health and delta UDP socket buffer error counters.
func (h *HostCollector) Sample() model.HostSample {
	now := time.Now()
	idle, total := readCPUStat()
	memPct := readMemPercent()
	load1 := readLoad1()
	rxBytes, txBytes := readNetDevBytes()
	inErr, rcvErr, sndErr := readUDPSNMP()

	h.mu.Lock()
	defer h.mu.Unlock()

	sample := model.HostSample{
		Timestamp:  now.Unix(),
		NodeID:     h.nodeID,
		MemPercent: memPct,
		Load1:      load1,
	}

	if h.initialized {
		dt := now.Sub(h.lastTime).Seconds()
		if dt < 0.1 {
			dt = 1.0
		}
		if total > h.lastCPUTot {
			dTotal := float64(total - h.lastCPUTot)
			dIdle := float64(idle - h.lastCPUIdle)
			pct := (1.0 - dIdle/dTotal) * 100.0
			if pct < 0 {
				pct = 0
			}
			if pct > 100 {
				pct = 100
			}
			sample.CPUPercent = pct
		}
		if rxBytes >= h.lastNetRx {
			sample.NetRxMbps = float64(rxBytes-h.lastNetRx) * 8.0 / 1e6 / dt
		}
		if txBytes >= h.lastNetTx {
			sample.NetTxMbps = float64(txBytes-h.lastNetTx) * 8.0 / 1e6 / dt
		}
		if rcvErr >= h.lastRcvErr {
			sample.UDPRcvbufErrors = rcvErr - h.lastRcvErr
		}
		if inErr >= h.lastInErr {
			sample.UDPInErrors = inErr - h.lastInErr
		}
		if sndErr >= h.lastSndErr {
			sample.UDPSndbufErrors = sndErr - h.lastSndErr
		}
	}

	h.initialized = true
	h.lastTime = now
	h.lastCPUIdle = idle
	h.lastCPUTot = total
	h.lastNetRx = rxBytes
	h.lastNetTx = txBytes
	h.lastRcvErr = rcvErr
	h.lastInErr = inErr
	h.lastSndErr = sndErr
	return sample
}

func readCPUStat() (idle, total uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		return 0, 0
	}
	fields := strings.Fields(sc.Text())
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0
	}
	for i := 1; i < len(fields); i++ {
		v, err := strconv.ParseUint(fields[i], 10, 64)
		if err != nil {
			continue
		}
		total += v
		if i == 4 || i == 5 { // idle + iowait
			idle += v
		}
	}
	return idle, total
}

func readMemPercent() float64 {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()

	var total, avail uint64
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				total, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		} else if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				avail, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		}
	}
	if total == 0 {
		return 0
	}
	used := float64(total-avail) / float64(total) * 100.0
	if used < 0 {
		return 0
	}
	return used
}

func readLoad1() float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(b))
	if len(fields) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(fields[0], 64)
	return v
}

func readNetDevBytes() (rxTotal, txTotal uint64) {
	f, err := os.Open("/proc/net/dev")
	if err != nil {
		return 0, 0
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		colon := strings.IndexByte(line, ':')
		if colon <= 0 {
			continue
		}
		iface := strings.TrimSpace(line[:colon])
		if iface == "lo" || strings.HasPrefix(iface, "docker") || strings.HasPrefix(iface, "veth") || strings.HasPrefix(iface, "br-") {
			continue
		}
		fields := strings.Fields(line[colon+1:])
		if len(fields) < 9 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		rxTotal += rx
		txTotal += tx
	}
	return rxTotal, txTotal
}

// ParseUDPSNMP parses the two "Udp:" lines from /proc/net/snmp text.
func ParseUDPSNMP(content string) (inErrors, rcvbufErrors, sndbufErrors int64) {
	lines := strings.Split(content, "\n")
	var headers []string
	for _, line := range lines {
		if !strings.HasPrefix(line, "Udp:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if headers == nil {
			headers = fields[1:]
			continue
		}
		vals := fields[1:]
		for i := 0; i < len(headers) && i < len(vals); i++ {
			v, err := strconv.ParseInt(vals[i], 10, 64)
			if err != nil {
				continue
			}
			switch headers[i] {
			case "InErrors":
				inErrors = v
			case "RcvbufErrors":
				rcvbufErrors = v
			case "SndbufErrors":
				sndbufErrors = v
			}
		}
		break
	}
	return inErrors, rcvbufErrors, sndbufErrors
}

func readUDPSNMP() (inErrors, rcvbufErrors, sndbufErrors int64) {
	b, err := os.ReadFile("/proc/net/snmp")
	if err != nil {
		return 0, 0, 0
	}
	return ParseUDPSNMP(string(b))
}
