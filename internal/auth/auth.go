package auth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/yikkrrtykj/srt-cam/internal/config"
)

const (
	sessionCookieName = "srt_cam_session"
	sessionTTL        = 24 * time.Hour
	maxFailedAttempts = 5
	lockoutDuration   = 5 * time.Minute
)

type attemptWindow struct {
	failures int
	lockedTo time.Time
}

// Manager provides browser session auth (bcrypt + HMAC cookies + brute-force lockout)
// and constant-time Bearer token auth for peer VPS cluster calls.
type Manager struct {
	cfg          config.AuthConfig
	clusterToken string
	secret       []byte

	mu       sync.Mutex
	attempts map[string]*attemptWindow
}

// NewManager initializes an Auth Manager. If SessionSecret is blank, a random secret is generated per boot.
func NewManager(cfg config.AuthConfig, clusterToken string) *Manager {
	sec := []byte(cfg.SessionSecret)
	if len(sec) < 16 {
		buf := make([]byte, 32)
		_, _ = rand.Read(buf)
		sec = buf
	}
	return &Manager{
		cfg:          cfg,
		clusterToken: clusterToken,
		secret:       sec,
		attempts:     make(map[string]*attemptWindow),
	}
}

// HashPassword produces a bcrypt hash for storing in config.json.
func HashPassword(plain string) (string, error) {
	if len(plain) < 6 {
		return "", errors.New("password must be at least 6 characters")
	}
	b, err := bcrypt.GenerateFromPassword([]byte(plain), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// IsAuthEnabled returns true when a password hash is configured.
func (m *Manager) IsAuthEnabled() bool {
	return strings.TrimSpace(m.cfg.PasswordHash) != ""
}

// Login validates credentials with per-IP brute-force protection and issues an HttpOnly cookie.
func (m *Manager) Login(w http.ResponseWriter, r *http.Request, username, password string) (int, error) {
	if !m.IsAuthEnabled() {
		return http.StatusOK, nil
	}
	ip := clientIP(r)
	if m.isLocked(ip) {
		return http.StatusTooManyRequests, errors.New("登录失败次数过多，请 5 分钟后再试")
	}

	userOK := subtle.ConstantTimeCompare([]byte(username), []byte(m.cfg.Username)) == 1
	passOK := bcrypt.CompareHashAndPassword([]byte(m.cfg.PasswordHash), []byte(password)) == nil
	if !userOK || !passOK {
		m.recordFailure(ip)
		return http.StatusUnauthorized, errors.New("用户名或密码错误")
	}

	m.clearFailures(ip)
	token := m.signToken(username, time.Now().Add(sessionTTL).Unix())
	isHTTPS := r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   m.cfg.CookieSecure && isHTTPS,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	return http.StatusOK, nil
}

// Logout clears the session cookie.
func (m *Manager) Logout(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   m.cfg.CookieSecure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// AuthenticatedUser verifies the session cookie and returns (username, true) if valid.
func (m *Manager) AuthenticatedUser(r *http.Request) (string, bool) {
	if !m.IsAuthEnabled() {
		return "local-admin", true
	}
	c, err := r.Cookie(sessionCookieName)
	if err != nil || c.Value == "" {
		return "", false
	}
	return m.verifyToken(c.Value)
}

// VerifyClusterToken validates the Bearer token used for VPS-to-VPS aggregation APIs.
func (m *Manager) VerifyClusterToken(r *http.Request) bool {
	if m.clusterToken == "" {
		return false
	}
	hdr := strings.TrimSpace(r.Header.Get("Authorization"))
	const prefix = "Bearer "
	if !strings.HasPrefix(hdr, prefix) {
		return false
	}
	given := strings.TrimPrefix(hdr, prefix)
	return subtle.ConstantTimeCompare([]byte(given), []byte(m.clusterToken)) == 1
}

func (m *Manager) signToken(username string, expUnix int64) string {
	payload := fmt.Sprintf("%s|%d", username, expUnix)
	enc := base64.RawURLEncoding.EncodeToString([]byte(payload))
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(enc))
	sig := hex.EncodeToString(mac.Sum(nil))
	return enc + "." + sig
}

func (m *Manager) verifyToken(tok string) (string, bool) {
	parts := strings.SplitN(tok, ".", 2)
	if len(parts) != 2 {
		return "", false
	}
	mac := hmac.New(sha256.New, m.secret)
	mac.Write([]byte(parts[0]))
	expectedSig := hex.EncodeToString(mac.Sum(nil))
	if subtle.ConstantTimeCompare([]byte(parts[1]), []byte(expectedSig)) != 1 {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	fields := strings.SplitN(string(raw), "|", 2)
	if len(fields) != 2 {
		return "", false
	}
	exp, err := strconv.ParseInt(fields[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return "", false
	}
	return fields[0], true
}

func (m *Manager) isLocked(ip string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, ok := m.attempts[ip]
	if !ok {
		return false
	}
	if time.Now().After(w.lockedTo) && !w.lockedTo.IsZero() {
		delete(m.attempts, ip)
		return false
	}
	return !w.lockedTo.IsZero() && time.Now().Before(w.lockedTo)
}

func (m *Manager) recordFailure(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w, ok := m.attempts[ip]
	if !ok {
		w = &attemptWindow{}
		m.attempts[ip] = w
	}
	w.failures++
	if w.failures >= maxFailedAttempts {
		w.lockedTo = time.Now().Add(lockoutDuration)
	}
}

func (m *Manager) clearFailures(ip string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.attempts, ip)
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if first != "" {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
