import { FormEvent, useState } from "react";
import { api } from "../api";

interface Props {
  nodeName: string;
  onLoggedIn: (username: string) => void;
}

export function LoginPage({ nodeName, onLoggedIn }: Props) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await api.login(username.trim(), password);
      onLoggedIn(res.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <div className="login-box">
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
          <span className="rail-logo">SRT</span>
          <div>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>SRT 信号网关</h1>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{nodeName || "播控管理端"}</div>
          </div>
        </div>

        {error && <div className="notice notice-err">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="field">
            <label htmlFor="login-user">用户名</label>
            <input
              id="login-user"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="field">
            <label htmlFor="login-pass">密码</label>
            <input
              id="login-pass"
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 4, padding: "8px 12px" }}
            disabled={busy}
          >
            {busy ? "登录中..." : "登录"}
          </button>
        </form>
      </div>
    </main>
  );
}
