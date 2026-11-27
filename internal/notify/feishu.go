package notify

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/yikkrrtykj/srt-cam/internal/config"
	"github.com/yikkrrtykj/srt-cam/internal/model"
	"github.com/yikkrrtykj/srt-cam/internal/storage"
)

// Sender posts an interactive card payload to a Feishu custom bot webhook.
type Sender interface {
	Send(ctx context.Context, card FeishuCard) error
}

// FeishuCard describes the high-level content rendered into a Feishu Interactive Card.
type FeishuCard struct {
	Title    string
	Template string // red, orange, green, blue
	Lines    []string
	LinkURL  string
}

// WebhookSender implements Sender for real Feishu Open Platform bot webhooks.
type WebhookSender struct {
	webhookURL string
	secret     string
	client     *http.Client
}

// NewWebhookSender creates a Feishu webhook client with optional HMAC signature verification.
func NewWebhookSender(webhookURL, secret string) *WebhookSender {
	return &WebhookSender{
		webhookURL: webhookURL,
		secret:     secret,
		client:     &http.Client{Timeout: 5 * time.Second},
	}
}

// Send formats and POSTs a Feishu interactive message card.
func (w *WebhookSender) Send(ctx context.Context, card FeishuCard) error {
	if w.webhookURL == "" {
		return nil
	}
	md := ""
	for i, line := range card.Lines {
		if i > 0 {
			md += "\n"
		}
		md += line
	}
	elements := []any{
		map[string]any{
			"tag": "div",
			"text": map[string]any{
				"tag":     "lark_md",
				"content": md,
			},
		},
	}
	if card.LinkURL != "" {
		elements = append(elements, map[string]any{
			"tag": "action",
			"actions": []any{
				map[string]any{
					"tag":  "button",
					"type": "primary",
					"text": map[string]any{"tag": "plain_text", "content": "查看链路趋势"},
					"url":  card.LinkURL,
				},
			},
		})
	}

	payload := map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"header": map[string]any{
				"template": card.Template,
				"title": map[string]any{
					"tag":     "plain_text",
					"content": card.Title,
				},
			},
			"elements": elements,
		},
	}

	if w.secret != "" {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		payload["timestamp"] = ts
		payload["sign"] = FeishuSign(ts, w.secret)
	}

	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, w.webhookURL, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := w.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("feishu webhook HTTP %d", resp.StatusCode)
	}
	return nil
}

// FeishuSign computes the official Feishu bot HMAC-SHA256 signature for timestamp + "\n" + secret.
func FeishuSign(timestamp, secret string) string {
	stringToSign := timestamp + "\n" + secret
	h := hmac.New(sha256.New, []byte(stringToSign))
	return base64.StdEncoding.EncodeToString(h.Sum(nil))
}

type groupAlertState struct {
	firstBadAt    time.Time
	activeEventID int64
	activeSev     model.GroupSeverity
	lastAlertAt   time.Time
	incidentStart time.Time
	lastSummary   string
}

// AlertManager enforces debouncing, severity escalation, cooldowns, recovery notifications,
// SQLite fault_event persistence, and backup-node watchdog failover.
type AlertManager struct {
	cfg        config.FeishuConfig
	nodeID     string
	isPrimary  bool
	sender     Sender
	store      *storage.Store

	mu             sync.Mutex
	states         map[string]*groupAlertState
	primaryDownAt  time.Time
	watchdogActive bool
}

// NewAlertManager builds an AlertManager. Pass sender=nil to use WebhookSender from cfg.
func NewAlertManager(nodeID string, isPrimary bool, cfg config.FeishuConfig, store *storage.Store, sender Sender) *AlertManager {
	if sender == nil && cfg.Enabled && cfg.WebhookURL != "" {
		sender = NewWebhookSender(cfg.WebhookURL, cfg.Secret)
	}
	return &AlertManager{
		cfg:       cfg,
		nodeID:    nodeID,
		isPrimary: isPrimary,
		sender:    sender,
		store:     store,
		states:    make(map[string]*groupAlertState),
	}
}

// UpdateConfig hot-reloads Feishu settings and refreshes the webhook sender safely.
func (a *AlertManager) UpdateConfig(cfg config.FeishuConfig) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.cfg = cfg
	if cfg.Enabled && cfg.WebhookURL != "" {
		a.sender = NewWebhookSender(cfg.WebhookURL, cfg.Secret)
	} else {
		a.sender = nil
	}
}

// UpdateWatchdog records whether the primary monitor node is reachable (for backup nodes).
func (a *AlertManager) UpdateWatchdog(now time.Time, primaryHealthy bool) bool {
	if a.isPrimary {
		return true
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if primaryHealthy {
		a.primaryDownAt = time.Time{}
		a.watchdogActive = false
		return false
	}
	if a.primaryDownAt.IsZero() {
		a.primaryDownAt = now
	}
	if now.Sub(a.primaryDownAt) >= time.Duration(a.cfg.WatchdogSec)*time.Second {
		a.watchdogActive = true
	}
	return a.watchdogActive
}

// Evaluate processes live SignalGroup views, persists debounced fault_events, and sends tiered Feishu cards.
func (a *AlertManager) Evaluate(ctx context.Context, now time.Time, eventName string, groups []model.SignalGroupLiveView, primaryHealthy bool) {
	shouldNotify := a.UpdateWatchdog(now, primaryHealthy)
	a.mu.Lock()
	cfg := a.cfg
	sender := a.sender
	a.mu.Unlock()
	debounce := time.Duration(cfg.DebounceSec) * time.Second
	cooldown := time.Duration(cfg.CooldownSec) * time.Second

	for _, grp := range groups {
		isBad := grp.ExpectedActive && (grp.Severity == model.SeverityCriticalOutage ||
			grp.Severity == model.SeverityDegradedProtected ||
			grp.Severity == model.SeverityDegradedSingle)

		a.mu.Lock()
		st, ok := a.states[grp.ID]
		if !ok {
			st = &groupAlertState{}
			a.states[grp.ID] = st
		}

		if !isBad {
			// Recovery transition
			if st.activeSev != "" {
				eventID := st.activeEventID
				startTS := st.incidentStart
				prevSev := st.activeSev
				st.activeEventID = 0
				st.activeSev = ""
				st.firstBadAt = time.Time{}
				st.lastAlertAt = time.Time{}
				st.incidentStart = time.Time{}
				a.mu.Unlock()

				if a.store != nil && eventID > 0 {
					_ = a.store.CloseFaultEvent(ctx, eventID, now.Unix())
				}
				if shouldNotify && cfg.Enabled && sender != nil {
					dur := now.Sub(startTS).Round(time.Second)
					_ = sender.Send(ctx, FeishuCard{
						Title:    fmt.Sprintf("[恢复] %s · %s", grp.Name, grp.DirectionLabel),
						Template: "green",
						Lines: []string{
							fmt.Sprintf("**场次**：%s", eventName),
							fmt.Sprintf("**原状态**：%s", severityLabel(prevSev)),
							fmt.Sprintf("**持续**：%s（%s ~ %s）", dur, startTS.Format("15:04:05"), now.Format("15:04:05")),
							fmt.Sprintf("**当前**：%s", grp.Summary),
						},
						LinkURL: timelineLinkFor(cfg.DashboardBaseURL, grp.ID),
					})
				}
				continue
			}
			st.firstBadAt = time.Time{}
			a.mu.Unlock()
			continue
		}

		// Bad state observed: apply debounce
		if st.firstBadAt.IsZero() {
			st.firstBadAt = now
		}
		if now.Sub(st.firstBadAt) < debounce {
			a.mu.Unlock()
			continue
		}

		// Debounce passed -> trigger on initial opening, severity escalation, or cooldown repeat
		isNew := st.activeSev == ""
		escalated := severityRank(grp.Severity) > severityRank(st.activeSev)
		cooldownReady := !st.lastAlertAt.IsZero() && now.Sub(st.lastAlertAt) >= cooldown

		var needOpenEvent bool
		if isNew {
			st.incidentStart = st.firstBadAt
			needOpenEvent = true
		}
		shouldSendCard := isNew || escalated || cooldownReady
		if shouldSendCard {
			st.activeSev = grp.Severity
			st.lastAlertAt = now
			st.lastSummary = grp.Summary
		}
		incidentStart := st.incidentStart
		a.mu.Unlock()

		if needOpenEvent && a.store != nil {
			badLeg := firstBadLeg(grp)
			evID, err := a.store.OpenFaultEvent(ctx, model.FaultEvent{
				StartTS:       incidentStart.Unix(),
				NodeID:        badLeg.NodeID,
				SignalGroupID: grp.ID,
				SignalName:    grp.Name,
				ChannelID:     badLeg.ChannelID,
				Role:          badLeg.Role,
				Severity:      grp.Severity,
				FaultCode:     badLeg.Sample.FaultCode,
				FaultLayer:    badLeg.Sample.FaultLayer,
				Summary:       grp.Summary,
				ProtectedBy:   grp.ProtectedBy,
			})
			if err == nil {
				a.mu.Lock()
				st.activeEventID = evID
				a.mu.Unlock()
			}
		}

		if shouldSendCard && shouldNotify && cfg.Enabled && sender != nil {
			tpl := "orange"
			if grp.Severity == model.SeverityCriticalOutage {
				tpl = "red"
			}
			lines := []string{
				fmt.Sprintf("**场次**：%s", eventName),
				fmt.Sprintf("**方向**：%s", grp.DirectionLabel),
				fmt.Sprintf("**时间**：%s（节点 %s）", incidentStart.Format("2006-01-02 15:04:05"), a.nodeID),
				fmt.Sprintf("**详情**：%s", grp.Summary),
			}
			if grp.ProtectedBy != "" {
				lines = append(lines, fmt.Sprintf("**在播路径**：%s", grp.ProtectedBy))
			}
			_ = sender.Send(ctx, FeishuCard{
				Title:    fmt.Sprintf("[%s] %s", severityLabel(grp.Severity), grp.Name),
				Template: tpl,
				Lines:    lines,
				LinkURL:  timelineLinkFor(cfg.DashboardBaseURL, grp.ID),
			})
		}
	}
}

func timelineLinkFor(baseURL, groupID string) string {
	if baseURL == "" {
		return ""
	}
	return fmt.Sprintf("%s/#/timeline/%s", baseURL, groupID)
}

func firstBadLeg(grp model.SignalGroupLiveView) model.LegLiveView {
	for _, leg := range grp.Legs {
		if !leg.NodeOnline || (leg.Sample.FaultCode != model.FaultHealthy && leg.Sample.FaultCode != model.FaultTunnelLOWarning) {
			return leg
		}
	}
	if len(grp.Legs) > 0 {
		return grp.Legs[0]
	}
	return model.LegLiveView{}
}

func severityRank(s model.GroupSeverity) int {
	switch s {
	case model.SeverityDegradedProtected:
		return 1
	case model.SeverityDegradedSingle:
		return 2
	case model.SeverityCriticalOutage:
		return 3
	default:
		return 0
	}
}

func severityLabel(s model.GroupSeverity) string {
	switch s {
	case model.SeverityCriticalOutage:
		return "告警 · 链路中断"
	case model.SeverityDegradedProtected:
		return "降级 · 备路在播"
	case model.SeverityDegradedSingle:
		return "警告 · 链路抖动"
	default:
		return string(s)
	}
}
