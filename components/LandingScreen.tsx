"use client";

import { moneyLabel } from "@/lib/presentation";

export default function LandingScreen({ onLogin }: { onLogin: () => void }) {
  return (
    <main className="landing-screen">
      <div className="landing-glow landing-glow-one" />
      <div className="landing-glow landing-glow-two" />
      <nav className="landing-nav" aria-label="Public navigation">
        <div className="landing-brand">
          <div className="brand-mark">LF</div>
          <div>
            <strong>ledgerflow</strong>
            <span>finance workspace</span>
          </div>
        </div>
        <button className="button secondary landing-login" onClick={onLogin}>
          Sign in
        </button>
      </nav>

      <section className="landing-hero">
        <div className="landing-copy">
          <span className="eyebrow landing-eyebrow">Accounts receivable, made calm</span>
          <h1>Know what came in. Know what needs attention.</h1>
          <p>
            LedgerFlow brings invoices, bank activity, matching, and reports into one focused
            workspace—so your team can close the loop without the busywork.
          </p>
          <div className="landing-actions">
            <button className="button primary" onClick={onLogin}>
              Open workspace <span aria-hidden="true">→</span>
            </button>
            <span className="landing-note">Balanced journals · review before posting</span>
          </div>
        </div>

        <div className="landing-preview" aria-label="Illustrative INR workspace demo">
          <div className="preview-window-bar">
            <span className="preview-dots">
              <i />
              <i />
              <i />
            </span>
            <span>Northstar Finance</span>
            <span className="preview-live">
              <i /> Illustrative demo
            </span>
          </div>
          <div className="preview-body">
            <div className="preview-sidebar">
              <b>LF</b>
              <span className="preview-sidebar-active" />
              <span />
              <span />
              <span />
              <span />
            </div>
            <div className="preview-content">
              <div className="preview-heading">
                <div>
                  <small>OVERVIEW</small>
                  <strong>Your books at a glance</strong>
                </div>
                <span className="preview-avatar">NF</span>
              </div>
              <div className="preview-metrics">
                <div>
                  <small>OUTSTANDING</small>
                  <strong>{moneyLabel({ currency: "INR", minor: "4286000" })}</strong>
                  <em>↑ 8.4%</em>
                </div>
                <div>
                  <small>NEEDS REVIEW</small>
                  <strong>5 items</strong>
                  <em className="preview-warn">today</em>
                </div>
              </div>
              <div className="preview-queue">
                <div className="preview-queue-head">
                  <b>Review queue</b>
                  <span>View all →</span>
                </div>
                <div className="preview-row">
                  <span className="preview-icon mint">↗</span>
                  <div>
                    <b>Brightside Health</b>
                    <small>NEFT · INV-1048</small>
                  </div>
                  <strong>+{moneyLabel({ currency: "INR", minor: "1245000" })}</strong>
                </div>
                <div className="preview-row">
                  <span className="preview-icon blue">↘</span>
                  <div>
                    <b>AWS cloud hosting</b>
                    <small>Bank activity · suggested</small>
                  </div>
                  <strong>{moneyLabel({ currency: "INR", minor: "-84200" })}</strong>
                </div>
                <div className="preview-row">
                  <span className="preview-icon amber">?</span>
                  <div>
                    <b>3 more items</b>
                    <small>Ready for your review</small>
                  </div>
                  <span className="preview-review">Review</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="landing-features" aria-label="LedgerFlow features">
        <article>
          <span>01</span>
          <div>
            <strong>Review, don’t guess</strong>
            <p>Suggestions stay explainable and require a human before posting.</p>
          </div>
        </article>
        <article>
          <span>02</span>
          <div>
            <strong>Keep the books balanced</strong>
            <p>Every approved action creates an auditable double-entry journal.</p>
          </div>
        </article>
        <article>
          <span>03</span>
          <div>
            <strong>See the whole picture</strong>
            <p>Move from cash activity to invoices, ledger, and reports in a few clicks.</p>
          </div>
        </article>
      </section>

      <footer className="landing-footer">
        <span>LedgerFlow</span>
        <span>Simple decisions for serious books.</span>
      </footer>
    </main>
  );
}
