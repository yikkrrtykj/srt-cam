import { FormEvent, useState } from "react";
import { Radio } from "lucide-react";
import { api } from "@/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
    <main className="min-h-screen flex items-center justify-center bg-[#0A0B0D] p-4">
      <div className="w-full max-w-[360px] rounded-lg border border-[#232730] bg-[#111316] p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[#2A2F3A] bg-[#181B22] text-[#F1F3F6]">
            <Radio className="h-4.5 w-4.5" />
          </div>
          <div>
            <h1 className="text-[15px] font-semibold tracking-tight text-[#F1F3F6]">SRT-CAM</h1>
            <div className="text-[12px] text-[#7C8596]">{nodeName || "广电信号播控台"}</div>
          </div>
        </div>

        {error && (
          <div className="mb-4 rounded-md border border-[#542228] bg-[#251316] px-3 py-2 text-[12px] text-[#F87171]">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3.5">
          <div className="space-y-1.5">
            <label htmlFor="login-user" className="block text-[12px] text-[#98A1B0]">
              用户名
            </label>
            <Input
              id="login-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="login-pass" className="block text-[12px] text-[#98A1B0]">
              密码
            </label>
            <Input
              id="login-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </div>
          <Button type="submit" variant="primary" size="default" className="w-full mt-1" disabled={busy}>
            {busy ? "登录中..." : "进入播控台"}
          </Button>
        </form>
      </div>
    </main>
  );
}
