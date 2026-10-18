import { normalizeReference } from "./matching";
import type { BankTransaction, CategoryRule } from "./types";

export type CategoryProposal = {
  status: "matched" | "ambiguous" | "none";
  rule?: CategoryRule;
  ruleIds: string[];
  rationale: string[];
};

export function proposeCategory(
  transaction: BankTransaction,
  rules: CategoryRule[],
): CategoryProposal {
  const haystack = normalizeReference(
    `${transaction.description} ${transaction.reference} ${transaction.counterparty ?? ""}`,
  );
  const candidates = rules
    .filter((rule) => rule.active && (!rule.flow || rule.flow === transaction.flow))
    .filter((rule) =>
      rule.keywords.some((keyword) => haystack.includes(normalizeReference(keyword))),
    )
    .map((rule) => ({
      rule,
      specificity: rule.keywords.reduce(
        (total, keyword) =>
          total + (haystack.includes(normalizeReference(keyword)) ? keyword.length : 0),
        0,
      ),
    }))
    .sort(
      (a, b) =>
        b.rule.priority - a.rule.priority ||
        b.specificity - a.specificity ||
        a.rule.id.localeCompare(b.rule.id),
    );
  if (!candidates.length)
    return { status: "none", ruleIds: [], rationale: ["No categorization rule matched"] };
  const top = candidates[0];
  const tied = candidates.filter(
    (candidate) =>
      candidate.rule.priority === top.rule.priority && candidate.specificity === top.specificity,
  );
  const accountIds = new Set(tied.map((candidate) => candidate.rule.accountId));
  if (accountIds.size > 1)
    return {
      status: "ambiguous",
      ruleIds: tied.map((candidate) => candidate.rule.id),
      rationale: ["Rules with equal priority point to different accounts"],
    };
  return {
    status: "matched",
    rule: top.rule,
    ruleIds: [top.rule.id],
    rationale: [`Matched ${top.rule.name}`],
  };
}
