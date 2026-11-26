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
    <main className="login-shell">
      <div className="login-card">
        <h1 style={{ margin: "0 0 4px", fontSize: 20 }}>SRT-CAM v2 控制台</h1>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-secondary)" }}>
          {nodeName || "广电双向 SRT 中转与故障定界平台"}
        </p>

        {error && <div className="notice-bar notice-err">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="form-field">
            <label htmlFor="login-user">管理员账号</label>
            <input
              id="login-user"
              className="input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="form-field">
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
            style={{ width: "100%", marginTop: 6, padding: "9px 14px" }}
            disabled={busy}
          >
            {busy ? "正在验证..." : "登录控制台"}
          </button>
        </form>
        <p style={{ margin: "14px 0 0", fontSize: 12, color: "var(--text-muted)" }}>
          公网访问建议配合 HTTPS 反代；连续 5 次密码错误将自动锁定 5 分钟。
        </p>
      </div>
    </main>
  );
}
