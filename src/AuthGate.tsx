import { useState } from "react";
import { Eye, EyeOff, KeyRound, LockKeyhole, LogOut, ShieldCheck } from "lucide-react";
import { api, ApiError } from "./api";
import { BrandMark } from "./icons";
import type { AuthSession } from "./types";
import { Button, InlineError } from "./components/Primitives";

const MIN_PASSWORD_LENGTH = 8;

export default function AuthGate({
  configured,
  onAuthenticated,
}: {
  configured: boolean;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      if (configured) {
        const session = await api.login(String(form.get("email")), String(form.get("password")));
        onAuthenticated(session);
      } else {
        const session = await api.setup({
          setupKey: String(form.get("setupKey")),
          householdName: String(form.get("householdName")),
          displayName: String(form.get("displayName")),
          email: String(form.get("email")),
          password: String(form.get("password")),
          currency: String(form.get("currency")),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata",
        });
        onAuthenticated(session);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Unable to continue. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="auth-story__brand"><BrandMark size={46} /><span>PennyQuill</span></div>
        <div className="auth-story__copy">
          <p className="eyebrow">Private household finance</p>
          <h1>Every rupee,<br />in one calm place.</h1>
          <p>Track daily spending, every family income stream, budgets and explainable forecasts—with no financial data sold or used for ads.</p>
        </div>
        <div className="auth-proof">
          <span><ShieldCheck size={20} /> Your Cloudflare D1 database</span>
          <span><LockKeyhole size={20} /> Password and session protection</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <span className="auth-card__mobile-brand"><BrandMark /><strong>PennyQuill</strong></span>
          <p className="eyebrow">{configured ? "Welcome back" : "One-time setup"}</p>
          <h2>{configured ? "Sign in to your ledger" : "Create your private ledger"}</h2>
          <p className="muted">
            {configured
              ? "Use the owner account created during setup."
              : "The setup key is the Worker secret you configure before deployment."}
          </p>

          <form className="form-stack" onSubmit={submit}>
            {!configured && (
              <>
                <label>
                  Setup key
                  <input name="setupKey" type="password" autoComplete="one-time-code" required minLength={12} placeholder="Your Cloudflare secret" />
                </label>
                <div className="field-row">
                  <label>
                    Household name
                    <input name="householdName" required maxLength={100} placeholder="Rao family" />
                  </label>
                  <label>
                    Your name
                    <input name="displayName" required maxLength={100} autoComplete="name" placeholder="Ananya" />
                  </label>
                </div>
              </>
            )}
            <label>
              Email
              <input name="email" type="email" autoComplete="email" required placeholder="you@example.com" />
            </label>
            <label>
              Password
              <span className="password-field">
                <input
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete={configured ? "current-password" : "new-password"}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  placeholder={configured ? "Your password" : `At least ${MIN_PASSWORD_LENGTH} characters`}
                />
                <button type="button" onClick={() => setShowPassword((value) => !value)} aria-label={showPassword ? "Hide password" : "Show password"}>
                  {showPassword ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </span>
            </label>
            {!configured && (
              <label>
                Home currency
                <select name="currency" defaultValue="INR">
                  <option value="INR">INR · Indian rupee</option>
                  <option value="USD">USD · US dollar</option>
                  <option value="EUR">EUR · Euro</option>
                  <option value="GBP">GBP · British pound</option>
                  <option value="AUD">AUD · Australian dollar</option>
                  <option value="SGD">SGD · Singapore dollar</option>
                </select>
              </label>
            )}
            {error && <InlineError message={error} />}
            <Button type="submit" disabled={loading}>
              {loading ? "Please wait…" : configured ? "Sign in" : "Create ledger"}
            </Button>
          </form>
          <p className="fine-print">By continuing, you agree to keep financial data accurate and review every imported SMS draft before saving.</p>
        </div>
      </section>
    </main>
  );
}

export function PasswordChangeGate({
  session,
  onChanged,
  onLogout,
}: {
  session: AuthSession;
  onChanged: (session: AuthSession) => void;
  onLogout: () => void;
}) {
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmation = String(form.get("confirmation") ?? "");
    if (newPassword !== confirmation) {
      setError("The new passwords do not match.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setError(`Use at least ${MIN_PASSWORD_LENGTH} characters with at least one letter and one number.`);
      return;
    }

    setLoading(true);
    setError("");
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      formElement.reset();
      onChanged({ ...session, user: result.user });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not update your password. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-story">
        <div className="auth-story__brand"><BrandMark size={46} /><span>PennyQuill</span></div>
        <div className="auth-story__copy">
          <p className="eyebrow">One secure step</p>
          <h1>Make this<br />account yours.</h1>
          <p>Your temporary password opened the door. Replace it now before any household financial data is loaded.</p>
        </div>
        <div className="auth-proof">
          <span><ShieldCheck size={20} /> Financial data stays locked until completion</span>
          <span><KeyRound size={20} /> Other sessions are revoked automatically</span>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-card">
          <span className="auth-card__mobile-brand"><BrandMark /><strong>PennyQuill</strong></span>
          <p className="eyebrow">Password change required</p>
          <h2>Choose a private password</h2>
          <p className="muted">Signed in as {session.user.email}. Use at least {MIN_PASSWORD_LENGTH} characters with a letter and a number.</p>
          <form className="form-stack" onSubmit={submit}>
            <label>
              Temporary password
              <input name="currentPassword" type={showPasswords ? "text" : "password"} autoComplete="current-password" required minLength={8} autoFocus />
            </label>
            <label>
              New password
              <span className="password-field">
                <input name="newPassword" type={showPasswords ? "text" : "password"} autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={128} />
                <button type="button" onClick={() => setShowPasswords((value) => !value)} aria-label={showPasswords ? "Hide passwords" : "Show passwords"}>
                  {showPasswords ? <EyeOff size={19} /> : <Eye size={19} />}
                </button>
              </span>
            </label>
            <label>
              Confirm new password
              <input name="confirmation" type={showPasswords ? "text" : "password"} autoComplete="new-password" required minLength={MIN_PASSWORD_LENGTH} maxLength={128} />
            </label>
            {error && <InlineError message={error} />}
            <Button type="submit" disabled={loading}><KeyRound size={18} /> {loading ? "Updating…" : "Set new password"}</Button>
            <Button type="button" variant="ghost" onClick={onLogout} disabled={loading}><LogOut size={17} /> Sign out instead</Button>
          </form>
        </div>
      </section>
    </main>
  );
}
