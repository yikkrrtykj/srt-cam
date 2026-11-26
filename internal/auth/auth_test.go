package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yikkrrtykj/srt-cam/internal/config"
)

func TestLoginSessionAndBruteForceLockout(t *testing.T) {
	hash, err := HashPassword("StrongBroadcast#2026")
	if err != nil {
		t.Fatal(err)
	}
	mgr := NewManager(config.AuthConfig{
		Username:      "admin",
		PasswordHash:  hash,
		SessionSecret: "0123456789abcdef0123456789abcdef",
	}, "cluster-secret-token")

	// Valid login
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	req.RemoteAddr = "198.51.100.5:12345"
	rec := httptest.NewRecorder()
	code, err := mgr.Login(rec, req, "admin", "StrongBroadcast#2026")
	if err != nil || code != http.StatusOK {
		t.Fatalf("valid login failed: code=%d err=%v", code, err)
	}
	cookies := rec.Result().Cookies()
	if len(cookies) == 0 {
		t.Fatalf("expected session cookie")
	}

	// Verify session cookie on subsequent request
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/overview", nil)
	req2.AddCookie(cookies[0])
	user, ok := mgr.AuthenticatedUser(req2)
	if !ok || user != "admin" {
		t.Fatalf("expected authenticated admin, got user=%q ok=%v", user, ok)
	}

	// 5 failed logins from another IP trigger lockout
	for i := 0; i < 5; i++ {
		badReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
		badReq.RemoteAddr = "203.0.113.9:5555"
		badRec := httptest.NewRecorder()
		code, _ := mgr.Login(badRec, badReq, "admin", "wrong")
		if code != http.StatusUnauthorized {
			t.Fatalf("attempt %d: code=%d, want 401", i, code)
		}
	}
	lockedReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)
	lockedReq.RemoteAddr = "203.0.113.9:5556"
	lockedRec := httptest.NewRecorder()
	code, _ = mgr.Login(lockedRec, lockedReq, "admin", "StrongBroadcast#2026")
	if code != http.StatusTooManyRequests {
		t.Fatalf("expected 429 lockout, got %d", code)
	}

	// Cluster Bearer token
	peerReq := httptest.NewRequest(http.MethodGet, "/api/peer/live", nil)
	peerReq.Header.Set("Authorization", "Bearer cluster-secret-token")
	if !mgr.VerifyClusterToken(peerReq) {
		t.Fatalf("expected valid cluster token")
	}
}
