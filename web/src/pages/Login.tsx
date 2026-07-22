import { useRef, useState, type FormEvent } from "react";
import { AuthError, login } from "../api";
import { Reveal } from "../motion";

interface Props {
  onLogin: () => void;
}

export default function Login({ onLogin }: Props) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const autoFocusInput = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pw || loading) return;
    setLoading(true);
    setErr("");
    try {
      await login(pw);
      onLogin();
    } catch (error) {
      setErr(error instanceof AuthError
        ? "비밀번호가 맞지 않습니다. 다시 입력해 주세요."
        : "서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.");
      inputRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-inner">
        <Reveal delay={0.12} as="h1" className="login-display">
          <span translate="no">Study<em>Work</em></span>
        </Reveal>
        <Reveal delay={0.2} className="login-sub">
          비밀번호를 입력해 개인 학습 자료함을 엽니다.
        </Reveal>

        <form className="login-form" onSubmit={submit}>
          <div className="field">
            <label className="field-index" htmlFor="login-password">비밀번호</label>
            <input
              ref={inputRef}
              id="login-password"
              name="password"
              type="password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              autoComplete="current-password"
              required
              aria-invalid={Boolean(err)}
              aria-describedby={err ? "login-error" : undefined}
              autoFocus={autoFocusInput}
            />
          </div>
          {err && <p className="err" id="login-error" role="alert">{err}</p>}
          <button
            type="submit"
            className="btn primary login-btn"
            disabled={loading}
          >
            {loading ? "여는 중…" : "열기"}
            <span className="btn-arrow" aria-hidden="true">↗</span>
          </button>
        </form>
      </div>
    </div>
  );
}
