import { useRef, useState, type FormEvent } from "react";
import { ApiError, AuthError, login, signup, type AuthStatus } from "../api";
import { Reveal } from "../motion";
import { LocalePicker, useI18n, type MessageKey } from "../i18n";

interface Props {
  ownerExists: boolean;
  onLogin: (status: AuthStatus) => void;
}

export default function Login({ ownerExists, onLogin }: Props) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [pw, setPw] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [err, setErr] = useState<MessageKey | { text: string } | "">("");
  const [loading, setLoading] = useState(false);
  const [wantsSignup, setWantsSignup] = useState(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const autoFocusInput = typeof window.matchMedia !== "function" || window.matchMedia("(pointer: fine)").matches;
  const signupMode = !ownerExists && wantsSignup;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username || !pw || loading) return;
    if (signupMode && pw !== confirmation) {
      setErr("shell.login.passwordMismatch");
      passwordRef.current?.focus();
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const status = signupMode
        ? await signup(username, pw)
        : await login(username, pw);
      onLogin(status);
    } catch (error) {
      setErr(
        error instanceof ApiError
          ? { text: error.message }
          : error instanceof AuthError
            ? "shell.login.invalidCredentials"
            : "shell.login.connectionError"
      );
      passwordRef.current?.focus();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="login-inner">
        <Reveal delay={0.12} as="h1" className="login-display">
          <span translate="no">Re<em>map</em></span>
        </Reveal>
        <Reveal delay={0.2} className="login-sub">
          {signupMode
            ? t("shell.login.signupIntro")
            : t("shell.login.loginIntro")}
        </Reveal>

        <form className="login-form" onSubmit={submit}>
          <div className="login-fields">
            <LocalePicker className="solution-book-picker" />
            <div className="field">
              <label className="field-index" htmlFor="login-username">{t("shell.login.username")}</label>
              <input
                ref={usernameRef}
                id="login-username"
                name="username"
                type="text"
                value={username}
                onChange={event => setUsername(event.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={64}
                required
                autoCapitalize="none"
                spellCheck={false}
                aria-invalid={Boolean(err)}
                aria-describedby={err ? "login-error" : undefined}
                autoFocus={autoFocusInput}
              />
            </div>
            <div className="field">
              <label className="field-index" htmlFor="login-password">
                {signupMode ? t("shell.login.newPassword") : t("shell.login.password")}
              </label>
              <input
                ref={passwordRef}
                id="login-password"
                name="password"
                type="password"
                value={pw}
                onChange={event => setPw(event.target.value)}
                autoComplete={signupMode ? "new-password" : "current-password"}
                minLength={signupMode ? 10 : undefined}
                maxLength={128}
                required
                aria-invalid={Boolean(err)}
                aria-describedby={err ? "login-error" : undefined}
              />
            </div>
            {signupMode && (
              <div className="field">
                <label className="field-index" htmlFor="signup-password-confirm">{t("shell.login.confirmPassword")}</label>
                <input
                  id="signup-password-confirm"
                  name="password-confirm"
                  type="password"
                  value={confirmation}
                  onChange={event => setConfirmation(event.target.value)}
                  autoComplete="new-password"
                  minLength={10}
                  maxLength={128}
                  required
                  aria-invalid={Boolean(err)}
                  aria-describedby={err ? "login-error" : undefined}
                />
              </div>
            )}
          </div>
          {err && (
            <p className="err" id="login-error" role="alert">
              {typeof err === "string" ? t(err) : err.text}
            </p>
          )}
          <div className="login-actions">
            <button
              type="submit"
              className="btn primary login-btn"
              disabled={loading}
            >
              {loading
                ? (signupMode ? t("shell.login.creating") : t("shell.login.opening"))
                : (signupMode ? t("shell.login.createAccount") : t("shell.login.signIn"))}
              <span className="btn-arrow" aria-hidden="true">↗</span>
            </button>
            {!ownerExists && (
              <button
                type="button"
                className="btn login-btn"
                disabled={loading}
                onClick={() => {
                  setWantsSignup(value => !value);
                  setPw("");
                  setConfirmation("");
                  setErr("");
                  passwordRef.current?.focus();
                }}
              >
                {signupMode ? t("shell.login.signIn") : t("shell.login.signUp")}
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}
