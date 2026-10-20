"use client";

import { useState } from "react";

export default function AccessRequestScreen({
  onBack,
  onSignIn,
}: {
  onBack: () => void;
  onSignIn: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [working, setWorking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      const response = await fetch("/api/auth/access-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, message }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Unable to send your request");
      setSubmitted(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to send your request");
    } finally {
      setWorking(false);
    }
  };

  return (
    <main className="auth-screen">
      <div className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark">LF</div>
          <div>
            <strong>ledgerflow</strong>
            <span>finance workspace</span>
          </div>
        </div>
        <div className="auth-heading">
          <span className="eyebrow">Workspace access</span>
          <h1>Request an invite</h1>
          <p>
            Tell the workspace administrator who you are. They will provision your role and send
            your access details.
          </p>
        </div>
        {submitted ? (
          <div className="access-request-success" role="status">
            <strong>Request received</strong>
            <p>
              Thanks, {name || "there"}. An administrator can review your request and provision your
              account.
            </p>
            <button className="button primary full" onClick={onSignIn}>
              Back to sign in
            </button>
          </div>
        ) : (
          <form className="modal-form" onSubmit={submit}>
            {error && <div className="form-error">{error}</div>}
            <label>
              Your name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <label>
              Work email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="email"
                required
              />
            </label>
            <label>
              Message (optional)
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={500}
                rows={3}
                placeholder="Tell us what you need access to."
              />
            </label>
            <button className="button primary full" disabled={working}>
              {working ? "Sending request…" : "Request access"}
            </button>
          </form>
        )}
        <div className="auth-switch">
          Already have access? <button onClick={onSignIn}>Sign in</button>
          <span aria-hidden="true">·</span>
          <button onClick={onBack}>Back home</button>
        </div>
        <div className="auth-foot">
          Requests are rate-limited and never create an account automatically.
        </div>
      </div>
    </main>
  );
}
