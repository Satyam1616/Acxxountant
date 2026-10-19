"use client";

export type TourView =
  | "overview"
  | "reconcile"
  | "invoices"
  | "customers"
  | "ledger"
  | "reports"
  | "settings";

export type TourStep = {
  title: string;
  body: string;
  view: TourView;
};

export const tourSteps: TourStep[] = [
  {
    title: "Start with Overview",
    body: "Your quick read on outstanding invoices, overdue cash, and what needs attention today.",
    view: "overview",
  },
  {
    title: "Reconcile activity",
    body: "Import bank activity, review suggestions, and approve matches before anything posts.",
    view: "reconcile",
  },
  {
    title: "Manage invoices",
    body: "Issue invoices, see open balances, and follow payment status from one list.",
    view: "invoices",
  },
  {
    title: "Keep customers close",
    body: "Find customer details and connect them to the invoices and balances that matter.",
    view: "customers",
  },
  {
    title: "Trust the Ledger",
    body: "Every approved financial action is recorded as an immutable, balanced journal entry.",
    view: "ledger",
  },
  {
    title: "Use Reports",
    body: "Check aging, trial balance, profit and loss, and balance sheet views when you need the story.",
    view: "reports",
  },
  {
    title: "Tune Settings",
    body: "Adjust matching confidence, fee tolerance, and the suggestion provider for your workflow.",
    view: "settings",
  },
  {
    title: "Use the quick actions",
    body: "From Overview, create an invoice or import activity when you are ready to get work moving.",
    view: "overview",
  },
];

export default function ProductTour({
  step,
  onNext,
  onSkip,
}: {
  step: number;
  onNext: () => void;
  onSkip: () => void;
}) {
  const current = tourSteps[step] ?? tourSteps[0];
  const isLast = step === tourSteps.length - 1;
  return (
    <aside className="product-tour" aria-live="polite" aria-label="Workspace guide">
      <div className="tour-topline">
        <span className="tour-kicker">Quick guide</span>
        <span>
          {step + 1} / {tourSteps.length}
        </span>
      </div>
      <strong>{current.title}</strong>
      <p>{current.body}</p>
      <div className="tour-actions">
        <button className="button quiet small" onClick={onSkip}>
          Skip
        </button>
        <button className="button primary small" onClick={onNext}>
          {isLast ? "Done" : "Next"} <span aria-hidden="true">→</span>
        </button>
      </div>
      <div className="tour-progress" aria-hidden="true">
        {tourSteps.map((item, index) => (
          <i className={index <= step ? "active" : ""} key={item.title} />
        ))}
      </div>
    </aside>
  );
}
