import { useState, KeyboardEvent } from "react";
import { login } from "../api";
import { useMagnetic, Reveal } from "../motion";

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const btnRef = useMagnetic<HTMLButtonElement>();

  async function submit() {
    if (!pw || loading) return;
    setLoading(true);
    setErr("");
    try {
      await login(pw);
      onLogin();
    } catch {
      setErr("비밀번호가 틀렸습니다.");
    } finally {
      setLoading(false);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") submit();
  }

  return (
    <div className="login-wrap">
      <div className="login-inner">
        <Reveal delay={0.05} className="micro-label login-micro">OBSIDIAN ARCHIVE / 잠금</Reveal>
        <Reveal delay={0.12} as="h1" className="login-display">
          Study<em>Work</em>
        </Reveal>
        <Reveal delay={0.2} className="login-sub">
          비밀번호를 입력해 아카이브를 엽니다.
        </Reveal>

        <div className="login-form">
          <div className="field">
            <span className="field-index">01</span>
            <input
              type="password"
              placeholder="PASSWORD"
              value={pw}
              onChange={e => setPw(e.target.value)}
              onKeyDown={onKey}
              autoFocus
            />
          </div>
          {err && <p className="err">{err}</p>}
          <button
            ref={btnRef}
            className="btn primary magnetic login-btn"
            onClick={submit}
            disabled={loading}
          >
            {loading ? "여는 중…" : "열기"}
            <span className="btn-arrow">↗</span>
          </button>
        </div>
      </div>
    </div>
  );
}
