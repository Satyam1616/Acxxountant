import { approveTransaction, getDashboard, getReports } from "../lib/application";
import { journalBalance } from "../lib/domain/ledger";
import { getState, resetState } from "../lib/store";
import { snapshotFromStored } from "../lib/store/serialize";

async function main() {
  if (process.env.NODE_ENV === "production" || process.env.STORAGE_ADAPTER === "postgres") {
    throw new Error(
      "Smoke reset is disabled in production or PostgreSQL mode; use an isolated test database",
    );
  }
  await resetState();
  const before = await getDashboard();
  console.log(`workspace: ${before.entity.name}`);
  console.log(`review queue: ${before.metrics.needsReview}`);
  await approveTransaction("bank_2", { mode: "suggestion" });
  const state = await getState();
  const snapshot = snapshotFromStored(state);
  const entry = snapshot.journalEntries.find(
    (item) =>
      item.id === snapshot.transactions.find((item) => item.id === "bank_2")?.journalEntryId,
  );
  if (!entry || journalBalance(entry).minor !== 0n)
    throw new Error("Smoke check failed: posted entry is not balanced");
  const reports = await getReports("2026-10-18");
  if (reports.balanceSheet.difference.minor !== 0n)
    throw new Error("Smoke check failed: balance sheet does not balance");
  console.log(`approved: ${entry.description}`);
  console.log("ledger: BALANCED ✓");
  console.log(`trial balance rows: ${reports.trialBalance.length}`);
  await resetState();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
