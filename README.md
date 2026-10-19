# LedgerFlow

LedgerFlow is a full-stack, local-first accounts-receivable workspace. It imports bank activity, proposes invoice matches with a deterministic rules engine, lets a finance user approve or reject the suggestion, and posts balanced double-entry journal entries. The application is intentionally designed so that an AI provider can suggest decisions without ever writing accounting lines.

## What is included

- **Overview** with receivables KPIs, aging visualization, attention queue, and recent activity.
- **Reconcile** queue with confidence scores, split-payment suggestions, category suggestions, CSV import, approval, exclusion, and undo/reversal.
- **Invoices** with an issue flow that writes an AR/revenue journal entry.
- **Customers** directory with customer creation and outstanding balances.
- **Ledger** with immutable journal entries and a visible balance invariant.
- **Reports** for A/R aging, trial balance, profit and loss, and balance sheet.
- **Settings** for auto-apply confidence and provider selection.
- **Audit events** for every financial mutation.
- **Deterministic domain engine** using `bigint` minor-unit money, exact matching, categorization rules, journal validation, and reversal entries.
- **Offline development storage** through an atomic JSON adapter in `data/ledgerflow.json`. The application boundary is ready for a PostgreSQL adapter when deployment needs multi-instance persistence.

## Requirements

- Node.js `22.23.3` (see `.nvmrc`)
- npm 10+

No database, API key, or network connection is required for the local demo. The default rules provider is free and deterministic.

## Setup

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The first request creates a seeded workspace with customers, invoices, bank transactions, proposed matches, and a balanced ledger in `data/ledgerflow.json`.

In development, sign in with `admin@ledgerflow.local` and password `demo` when no auth variables are configured. Never use those fallback credentials in a deployed environment.

## Checks

Run the same checks used by CI/build environments:

```bash
npm test                 # domain + application tests, offline
npm run lint             # ESLint with Next.js and TypeScript rules
npm run typecheck        # strict TypeScript check
npm run build            # production Next.js build
npm run smoke            # approve a payment and verify ledger/report invariants
npm run db:migrate       # apply the shared PostgreSQL table (requires DATABASE_URL)
npm run db:backfill      # copy the legacy JSON workspace into normalized tables (after migration)
npm run vercel:deploy    # deploy a production build after Vercel authentication
```

The required checks are intentionally local and do not need provider credentials or a running database.

## Vercel deployment

Authenticate the local CLI without placing a token in the repository:

```bash
npx vercel login
npm run vercel:deploy
```

For CI, provide `VERCEL_TOKEN` through the CI secret store and run `npx vercel --prod --token "$VERCEL_TOKEN"`. Configure any production secrets from `.env.example` in the Vercel project settings. The JSON adapter is suitable for a single persistent instance only; use a shared database adapter before scaling to multiple serverless instances.

## CSV import format

The importer accepts common bank exports with automatic header detection. The minimum required columns are `Date` and either `Amount` or separate `Debit`/`Credit` columns. It also understands `Description`, `Memo`, `Reference`, `Counterparty`, parentheses, `DR`/`CR`, BOMs, and common date formats.

Example:

```csv
Date,Amount,Description,Reference,Counterparty
2026-10-20,1250.00,Acme payment,INV-1048,Acme Industries
2026-10-21,-42.50,AWS cloud hosting,AWS-OCT,Amazon Web Services
```

Re-importing the same external reference is safe: duplicate rows are skipped.

## Accounting safety model

1. Money is parsed as integer minor units and represented by `bigint` in the domain. No floating-point arithmetic is used for decisions or postings.
2. A journal entry must have at least two positive lines and exact debit/credit equality.
3. Invoice payments cannot apply more than the invoice's open balance. Excess cash is posted to unapplied customer cash.
4. Split payments use a bounded deterministic subset search. Ambiguous combinations stay in the review queue.
5. Posted entries are never edited. Undo creates a reversing journal entry and updates the reconciliation status.
6. A transaction can only be posted once, and the local write adapter serializes updates to prevent lost writes.
7. Reports are calculated from journal lines and historical approved allocations, not from display-only status fields.

## Project structure

```text
app/                         Next.js App Router pages and API routes
components/Workspace.tsx     Responsive finance workspace UI
lib/domain/                  Pure money, matching, categorization, ledger, import, report logic
lib/application.ts           Application use cases and audit mutations
lib/store/                   Seed data, JSON persistence, wire serialization
tests/                       Offline unit and workflow tests
scripts/smoke.ts             End-to-end local invariant check
Dockerfile                   Reproducible production container
```

## Deployment path

The included Dockerfile builds a standalone Next.js image:

```bash
docker run --rm -p 3000:3000 -v ledgerflow-data:/app/data ledgerflow
```

For a single-instance development deployment, persist `/app/data`. Production now supports a shared Neon/PostgreSQL state adapter. Set `STORAGE_ADAPTER=postgres`, `DATABASE_URL`, `AUTH_SECRET`, `APP_AUTH_EMAIL`, and a strong `APP_AUTH_PASSWORD`. The application fails closed in production when durable storage or authentication is not configured. `ALLOW_EPHEMERAL_STORAGE=true` is available only for an explicitly disposable demo and should never be used for financial records.

Before the first production request, export the production `DATABASE_URL` and run `npm run db:migrate` against the production database. The migration runner uses Neon's HTTPS transaction API, takes a transaction-scoped advisory lock before applying migration guards, verifies checksums, and commits the complete release atomically. This avoids requiring a WebSocket connection from restricted WSL or CI networks. The adapter also creates the legacy table defensively, but migrations should be applied explicitly as part of release automation.

After the migrations succeed, run `npm run db:backfill` once to copy the legacy `ledgerflow_state` demo into the normalized tenant, accounting, document, bank, match, and audit tables. The HTTPS transaction sets the tenant context, inserts journal entries before documents, is idempotent, and never deletes the legacy snapshot. Readiness remains `503` until both migration and backfill are complete.

Generate a strong application secret with `openssl rand -base64 32`, set it as `AUTH_SECRET`, and configure `APP_AUTH_PASSWORD` with at least 12 characters. In Vercel, add these values under **Project Settings → Environment Variables** for Production and redeploy. Do not commit `.env.local` or provider tokens.

### Integrations

The server now includes credential-free provider ports plus real HTTP flows for Plaid Link/token exchange and QuickBooks/Xero OAuth. Configure the provider variables from `.env.example`, then use these server endpoints from an authenticated admin UI:

```text
POST /api/integrations/plaid/link-token
POST /api/integrations/plaid/exchange
GET  /api/integrations/quickbooks/start
GET  /api/integrations/quickbooks/callback
POST /api/integrations/quickbooks/select
GET  /api/integrations/xero/start
GET  /api/integrations/xero/callback
POST /api/integrations/xero/select
```

Provider tokens are encrypted with `ENCRYPTION_KEY`; OAuth state is one-time, tenant-bound, user-bound, PKCE-protected, and expires after ten minutes. If an accounting provider returns multiple companies, the callback stores a short-lived encrypted pending token and the authenticated client completes selection with the provider's `/select` endpoint. Provider network calls are deliberately kept outside journal posting logic. Configure a durable worker to run `lib/jobs/repository.ts` jobs for initial/incremental syncs.

Health probes are separated into `/api/health/live` and `/api/health/ready`. The latter reports a non-sensitive stable error code when PostgreSQL or durable storage is unavailable.

### Production hardening roadmap

- Add Clerk/Auth.js session validation and enforce organization/entity scope in every application command.
- Replace the JSON adapter with PostgreSQL/Drizzle migrations, row-level tenant scoping, and transaction locks.
- Encrypt integration credentials using `ENCRYPTION_KEY`; never log provider tokens.
- Add Plaid, QuickBooks, and Xero adapters behind ports in `lib/integrations/`.
- Move imports and provider calls to a durable background job/outbox worker.
- Add rate limiting, structured logs, error tracking, backups, retention policies, and Playwright browser tests.
- Add fiscal periods, tax/VAT rules, credit notes, payable invoices, FX, and configurable account mappings before using the system as a statutory ledger.

## License

Private product workspace. Add the license appropriate for your organization before distribution.
