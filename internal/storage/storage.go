package storage

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/yikkrrtykj/srt-cam/internal/model"
)

// Store wraps a pure-Go SQLite database in WAL mode for 7-day telemetry and evidence retention.
type Store struct {
	db *sql.DB
}

// Open initializes (or opens) the SQLite database at path (":memory:" allowed for tests).
func Open(path string) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
	}
	dsn := path
	if path != ":memory:" {
		dsn = path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite works best with serialized writers and a small connection pool.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

// Close closes the underlying SQLite connection.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) migrate() error {
	const schema = `
CREATE TABLE IF NOT EXISTS channel_samples (
	ts INTEGER NOT NULL,
	node_id TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	mode TEXT NOT NULL,
	process_state TEXT NOT NULL,
	restart_count INTEGER NOT NULL,
	uptime_sec INTEGER NOT NULL,
	src_connected INTEGER NOT NULL,
	src_mbps REAL NOT NULL,
	src_rtt_ms REAL NOT NULL,
	src_lost INTEGER NOT NULL,
	src_retrans INTEGER NOT NULL,
	src_dropped INTEGER NOT NULL,
	src_tsbpd_ms REAL NOT NULL,
	src_peer_ip TEXT NOT NULL,
	dst_connected INTEGER NOT NULL,
	dst_mbps REAL NOT NULL,
	dst_rtt_ms REAL NOT NULL,
	dst_lost INTEGER NOT NULL,
	dst_retrans INTEGER NOT NULL,
	dst_dropped INTEGER NOT NULL,
	dst_nak_count INTEGER NOT NULL,
	dst_peer_ip TEXT NOT NULL,
	path_medium TEXT NOT NULL,
	has_native_stats INTEGER NOT NULL,
	encrypted INTEGER NOT NULL,
	fault_code TEXT NOT NULL,
	fault_layer TEXT NOT NULL,
	fault_summary TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_samples_lookup
	ON channel_samples(node_id, channel_id, ts);
CREATE INDEX IF NOT EXISTS idx_channel_samples_ts
	ON channel_samples(ts);

CREATE TABLE IF NOT EXISTS host_samples (
	ts INTEGER NOT NULL,
	node_id TEXT NOT NULL,
	cpu_percent REAL NOT NULL,
	mem_percent REAL NOT NULL,
	net_rx_mbps REAL NOT NULL,
	net_tx_mbps REAL NOT NULL,
	udp_rcvbuf_errors INTEGER NOT NULL,
	udp_in_errors INTEGER NOT NULL,
	udp_sndbuf_errors INTEGER NOT NULL,
	load1 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_host_samples_lookup
	ON host_samples(node_id, ts);
CREATE INDEX IF NOT EXISTS idx_host_samples_ts
	ON host_samples(ts);

CREATE TABLE IF NOT EXISTS fault_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	start_ts INTEGER NOT NULL,
	end_ts INTEGER NOT NULL DEFAULT 0,
	node_id TEXT NOT NULL,
	signal_group_id TEXT NOT NULL,
	signal_name TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	role TEXT NOT NULL,
	severity TEXT NOT NULL,
	fault_code TEXT NOT NULL,
	fault_layer TEXT NOT NULL,
	summary TEXT NOT NULL,
	protected_by TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_fault_events_time
	ON fault_events(start_ts, end_ts);
CREATE INDEX IF NOT EXISTS idx_fault_events_group
	ON fault_events(signal_group_id, start_ts);

CREATE TABLE IF NOT EXISTS audit_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	ts INTEGER NOT NULL,
	username TEXT NOT NULL,
	node_id TEXT NOT NULL,
	action TEXT NOT NULL,
	target TEXT NOT NULL,
	detail TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_ts
	ON audit_logs(ts);
`
	_, err := s.db.Exec(schema)
	if err != nil {
		return fmt.Errorf("migrate sqlite schema: %w", err)
	}
	return nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// InsertSamples atomically persists one HostSample and a batch of ChannelSamples.
func (s *Store) InsertSamples(ctx context.Context, host model.HostSample, channels []model.ChannelSample) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if host.NodeID != "" && host.Timestamp > 0 {
		_, err = tx.ExecContext(ctx, `
INSERT INTO host_samples (
	ts, node_id, cpu_percent, mem_percent, net_rx_mbps, net_tx_mbps,
	udp_rcvbuf_errors, udp_in_errors, udp_sndbuf_errors, load1
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			host.Timestamp, host.NodeID, host.CPUPercent, host.MemPercent,
			host.NetRxMbps, host.NetTxMbps, host.UDPRcvbufErrors,
			host.UDPInErrors, host.UDPSndbufErrors, host.Load1,
		)
		if err != nil {
			return err
		}
	}

	if len(channels) > 0 {
		stmt, err := tx.PrepareContext(ctx, `
INSERT INTO channel_samples (
	ts, node_id, channel_id, mode, process_state, restart_count, uptime_sec,
	src_connected, src_mbps, src_rtt_ms, src_lost, src_retrans, src_dropped, src_tsbpd_ms, src_peer_ip,
	dst_connected, dst_mbps, dst_rtt_ms, dst_lost, dst_retrans, dst_dropped, dst_nak_count, dst_peer_ip,
	path_medium, has_native_stats, encrypted, fault_code, fault_layer, fault_summary
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		if err != nil {
			return err
		}
		defer stmt.Close()

		for _, c := range channels {
			_, err = stmt.ExecContext(ctx,
				c.Timestamp, c.NodeID, c.ChannelID, string(c.Mode),
				c.ProcessState, c.RestartCount, c.UptimeSec,
				boolToInt(c.SrcConnected), c.SrcMbps, c.SrcRTTMs, c.SrcLost, c.SrcRetrans, c.SrcDropped, c.SrcTSBPDMs, c.SrcPeerIP,
				boolToInt(c.DstConnected), c.DstMbps, c.DstRTTMs, c.DstLost, c.DstRetrans, c.DstDropped, c.DstNAKCount, c.DstPeerIP,
				c.PathMedium, boolToInt(c.HasNativeStats), boolToInt(c.Encrypted),
				string(c.FaultCode), c.FaultLayer, c.FaultSummary,
			)
			if err != nil {
				return err
			}
		}
	}

	return tx.Commit()
}

// QueryChannelTimeline returns channel samples in [fromTS, toTS], automatically downsampling
// to at most maxPoints points so multi-day evidence lookups remain snappy.
func (s *Store) QueryChannelTimeline(ctx context.Context, nodeID, channelID string, fromTS, toTS int64, maxPoints int) ([]model.ChannelSample, error) {
	if maxPoints <= 0 {
		maxPoints = 900
	}
	span := toTS - fromTS
	if span < 1 {
		span = 1
	}
	bucket := int64(1)
	if span > int64(maxPoints)*2 {
		bucket = span / int64(maxPoints)
		if bucket < 1 {
			bucket = 1
		}
	}

	var rows *sql.Rows
	var err error
	if bucket == 1 {
		rows, err = s.db.QueryContext(ctx, `
SELECT ts, node_id, channel_id, mode, process_state, restart_count, uptime_sec,
	src_connected, src_mbps, src_rtt_ms, src_lost, src_retrans, src_dropped, src_tsbpd_ms, src_peer_ip,
	dst_connected, dst_mbps, dst_rtt_ms, dst_lost, dst_retrans, dst_dropped, dst_nak_count, dst_peer_ip,
	path_medium, has_native_stats, encrypted, fault_code, fault_layer, fault_summary
FROM channel_samples
WHERE node_id = ? AND channel_id = ? AND ts >= ? AND ts <= ?
ORDER BY ts ASC`, nodeID, channelID, fromTS, toTS)
	} else {
		rows, err = s.db.QueryContext(ctx, `
SELECT
	(ts / ?) * ? AS bucket_ts,
	node_id, channel_id, MAX(mode), MAX(process_state), MAX(restart_count), MAX(uptime_sec),
	MIN(src_connected), AVG(src_mbps), MAX(src_rtt_ms), SUM(src_lost), SUM(src_retrans), SUM(src_dropped), MAX(src_tsbpd_ms), MAX(src_peer_ip),
	MIN(dst_connected), AVG(dst_mbps), MAX(dst_rtt_ms), SUM(dst_lost), SUM(dst_retrans), SUM(dst_dropped), SUM(dst_nak_count), MAX(dst_peer_ip),
	MAX(path_medium), MAX(has_native_stats), MAX(encrypted),
	MAX(CASE WHEN fault_code != 'HEALTHY' AND fault_code != 'IDLE_EXPECTED_OFF' THEN fault_code ELSE '' END),
	MAX(CASE WHEN fault_layer != 'none' THEN fault_layer ELSE '' END),
	MAX(CASE WHEN fault_code != 'HEALTHY' AND fault_code != 'IDLE_EXPECTED_OFF' THEN fault_summary ELSE '' END)
FROM channel_samples
WHERE node_id = ? AND channel_id = ? AND ts >= ? AND ts <= ?
GROUP BY bucket_ts
ORDER BY bucket_ts ASC`, bucket, bucket, nodeID, channelID, fromTS, toTS)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.ChannelSample
	for rows.Next() {
		var c model.ChannelSample
		var modeStr, fcStr string
		var srcConn, dstConn, hasStats, enc int
		err := rows.Scan(
			&c.Timestamp, &c.NodeID, &c.ChannelID, &modeStr, &c.ProcessState, &c.RestartCount, &c.UptimeSec,
			&srcConn, &c.SrcMbps, &c.SrcRTTMs, &c.SrcLost, &c.SrcRetrans, &c.SrcDropped, &c.SrcTSBPDMs, &c.SrcPeerIP,
			&dstConn, &c.DstMbps, &c.DstRTTMs, &c.DstLost, &c.DstRetrans, &c.DstDropped, &c.DstNAKCount, &c.DstPeerIP,
			&c.PathMedium, &hasStats, &enc, &fcStr, &c.FaultLayer, &c.FaultSummary,
		)
		if err != nil {
			return nil, err
		}
		c.Mode = model.ChannelMode(modeStr)
		c.SrcConnected = srcConn != 0
		c.DstConnected = dstConn != 0
		c.HasNativeStats = hasStats != 0
		c.Encrypted = enc != 0
		if fcStr == "" {
			c.FaultCode = model.FaultHealthy
			c.FaultLayer = "none"
		} else {
			c.FaultCode = model.FaultCode(fcStr)
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// QueryHostTimeline returns Layer 2 host health samples in [fromTS, toTS].
func (s *Store) QueryHostTimeline(ctx context.Context, nodeID string, fromTS, toTS int64, maxPoints int) ([]model.HostSample, error) {
	if maxPoints <= 0 {
		maxPoints = 900
	}
	span := toTS - fromTS
	bucket := int64(1)
	if span > int64(maxPoints)*2 {
		bucket = span / int64(maxPoints)
		if bucket < 1 {
			bucket = 1
		}
	}

	var rows *sql.Rows
	var err error
	if bucket == 1 {
		rows, err = s.db.QueryContext(ctx, `
SELECT ts, node_id, cpu_percent, mem_percent, net_rx_mbps, net_tx_mbps,
	udp_rcvbuf_errors, udp_in_errors, udp_sndbuf_errors, load1
FROM host_samples
WHERE node_id = ? AND ts >= ? AND ts <= ?
ORDER BY ts ASC`, nodeID, fromTS, toTS)
	} else {
		rows, err = s.db.QueryContext(ctx, `
SELECT (ts / ?) * ? AS bucket_ts, node_id,
	MAX(cpu_percent), MAX(mem_percent), AVG(net_rx_mbps), AVG(net_tx_mbps),
	SUM(udp_rcvbuf_errors), SUM(udp_in_errors), SUM(udp_sndbuf_errors), MAX(load1)
FROM host_samples
WHERE node_id = ? AND ts >= ? AND ts <= ?
GROUP BY bucket_ts
ORDER BY bucket_ts ASC`, bucket, bucket, nodeID, fromTS, toTS)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.HostSample
	for rows.Next() {
		var h model.HostSample
		if err := rows.Scan(
			&h.Timestamp, &h.NodeID, &h.CPUPercent, &h.MemPercent,
			&h.NetRxMbps, &h.NetTxMbps, &h.UDPRcvbufErrors,
			&h.UDPInErrors, &h.UDPSndbufErrors, &h.Load1,
		); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// OpenFaultEvent inserts a new active incident record and returns its ID.
func (s *Store) OpenFaultEvent(ctx context.Context, ev model.FaultEvent) (int64, error) {
	res, err := s.db.ExecContext(ctx, `
INSERT INTO fault_events (
	start_ts, end_ts, node_id, signal_group_id, signal_name, channel_id, role,
	severity, fault_code, fault_layer, summary, protected_by
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ev.StartTS, ev.EndTS, ev.NodeID, ev.SignalGroupID, ev.SignalName,
		ev.ChannelID, ev.Role, string(ev.Severity), string(ev.FaultCode),
		ev.FaultLayer, ev.Summary, ev.ProtectedBy,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// CloseFaultEvent marks an incident closed at endTS.
func (s *Store) CloseFaultEvent(ctx context.Context, id, endTS int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE fault_events SET end_ts = ? WHERE id = ? AND end_ts = 0`, endTS, id)
	return err
}

// QueryFaultEvents lists fault events overlapping [fromTS, toTS], optionally filtered by signalGroupID.
func (s *Store) QueryFaultEvents(ctx context.Context, signalGroupID string, fromTS, toTS int64, limit int) ([]model.FaultEvent, error) {
	if limit <= 0 {
		limit = 200
	}
	var rows *sql.Rows
	var err error
	if signalGroupID != "" {
		rows, err = s.db.QueryContext(ctx, `
SELECT id, start_ts, end_ts, node_id, signal_group_id, signal_name, channel_id, role,
	severity, fault_code, fault_layer, summary, protected_by
FROM fault_events
WHERE signal_group_id = ? AND start_ts <= ? AND (end_ts = 0 OR end_ts >= ?)
ORDER BY start_ts DESC LIMIT ?`, signalGroupID, toTS, fromTS, limit)
	} else {
		rows, err = s.db.QueryContext(ctx, `
SELECT id, start_ts, end_ts, node_id, signal_group_id, signal_name, channel_id, role,
	severity, fault_code, fault_layer, summary, protected_by
FROM fault_events
WHERE start_ts <= ? AND (end_ts = 0 OR end_ts >= ?)
ORDER BY start_ts DESC LIMIT ?`, toTS, fromTS, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.FaultEvent
	for rows.Next() {
		var ev model.FaultEvent
		var sevStr, fcStr string
		if err := rows.Scan(
			&ev.ID, &ev.StartTS, &ev.EndTS, &ev.NodeID, &ev.SignalGroupID,
			&ev.SignalName, &ev.ChannelID, &ev.Role, &sevStr, &fcStr,
			&ev.FaultLayer, &ev.Summary, &ev.ProtectedBy,
		); err != nil {
			return nil, err
		}
		ev.Severity = model.GroupSeverity(sevStr)
		ev.FaultCode = model.FaultCode(fcStr)
		out = append(out, ev)
	}
	return out, rows.Err()
}

// InsertAudit records an operator action such as safe single-channel restart or config edit.
func (s *Store) InsertAudit(ctx context.Context, entry model.AuditEntry) error {
	if entry.Timestamp == 0 {
		entry.Timestamp = time.Now().Unix()
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO audit_logs (ts, username, node_id, action, target, detail)
VALUES (?, ?, ?, ?, ?, ?)`,
		entry.Timestamp, entry.Username, entry.NodeID, entry.Action, entry.Target, entry.Detail,
	)
	return err
}

// QueryAudit returns recent operator audit entries.
func (s *Store) QueryAudit(ctx context.Context, limit int) ([]model.AuditEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT id, ts, username, node_id, action, target, detail
FROM audit_logs ORDER BY ts DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []model.AuditEntry
	for rows.Next() {
		var e model.AuditEntry
		if err := rows.Scan(&e.ID, &e.Timestamp, &e.Username, &e.NodeID, &e.Action, &e.Target, &e.Detail); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneOlderThan deletes telemetry and closed events older than cutoffTS (e.g., 7 days ago).
func (s *Store) PruneOlderThan(ctx context.Context, cutoffTS int64) (int64, error) {
	var total int64
	queries := []string{
		`DELETE FROM channel_samples WHERE ts < ?`,
		`DELETE FROM host_samples WHERE ts < ?`,
		`DELETE FROM fault_events WHERE end_ts > 0 AND end_ts < ?`,
		`DELETE FROM audit_logs WHERE ts < ?`,
	}
	for _, q := range queries {
		res, err := s.db.ExecContext(ctx, q, cutoffTS)
		if err != nil {
			return total, err
		}
		if n, err := res.RowsAffected(); err == nil {
			total += n
		}
	}
	return total, nil
}
