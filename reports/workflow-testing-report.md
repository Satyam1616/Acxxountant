# LedgerFlow Workflow Testing Report

- **Test date:** 2026-10-20
- **Workspace:** `/home/saroj/Axxountant`
- **Feature under test:** public sign-up/request-access entry points and INR accounting workflows
- **Database migration state:** 7 migrations applied; `007_access_requests.sql` applied successfully

## Executive summary

The implementation is locally verified. The public home screen now has a **Sign up** button, and the sign-in screen has a **Sign up / request access** link. These buttons open a request-access workflow rather than silently creating credentials. A request stores only a name, normalized email, optional message, pending accountant role, and timestamp. It never accepts or stores a password and does not grant access automatically.

The complete offline suite passed: **209 tests across 9 test files**. Lint, strict TypeScript checking, formatting, production build, smoke invariants, and the production dependency audit also passed.

The new application code is not yet deployed to the production URL. The production database migration is ready, but the UI/API behavior below becomes live only after pushing and deploying the implementation commit.

## Workflow results

| Workflow                     | Verification                                                                                                                        | Result                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Public landing page          | Static-render test verifies branding, INR illustrative values, **Sign in**, and **Sign up**                                         | PASS                               |
| Home → request access        | `AccessRequestScreen` render test verifies invite language, request button, Back home, and Sign in paths                            | PASS                               |
| Sign-in → request access     | `LoginScreen` render test verifies **Sign up / request access**                                                                     | PASS                               |
| Valid access request         | API test returns `202`, stores normalized email and pending accountant role                                                         | PASS                               |
| Access-request privacy       | Test confirms no password is stored and duplicate pending email requests do not create a second record                              | PASS                               |
| Access-request validation    | Invalid name/email returns `400`                                                                                                    | PASS                               |
| Access-request abuse control | Public endpoint returns `429` after the configured request window limit                                                             | PASS                               |
| Existing login/session       | Session signing, tamper rejection, invalid credentials, and role parsing                                                            | PASS                               |
| Role authorization           | Viewer/accountant/admin boundaries remain enforced before mutations                                                                 | PASS                               |
| INR money                    | Exact paise parsing, ₹ formatting, lakh/crore grouping, signs, symbols, and decimal limits                                          | PASS                               |
| INR CSV import               | Day-first dates, ₹ amounts, explicit currency matching, duplicate safety, debit/credit validation                                   | PASS                               |
| INR invoice workflow         | Customer → INR invoice → paise amount → journal posting                                                                             | PASS                               |
| INR payment workflow         | Imported INR payment → invoice matching → approval → balanced journal                                                               | PASS                               |
| Partial payment display      | Customer card shows remaining INR balance rather than original invoice total                                                        | PASS                               |
| Currency-lock behavior       | Financial activity prevents base-currency changes; the API returns `400 currency_change_forbidden`, not `503`                       | PASS                               |
| Demo reset safety            | Real PostgreSQL-compatible offline tests verify RLS scope, stale-version protection, backup, rollback, and protected-record refusal | PASS                               |
| Durable production migration | Migration runner applied migration 007 successfully and reported 7 applied migrations                                               | PASS                               |
| Production health baseline   | Previous production readiness checks reported auth and PostgreSQL storage healthy                                                   | PASS before this UI/API deployment |

## Commands and evidence

Executed from the project root:

```bash
npm run ci
npm run smoke
npm audit --omit=dev --audit-level=high
git diff --check
```

Observed results:

- `npm run ci`: PASS
  - ESLint: PASS
  - TypeScript: PASS
  - Vitest: **209 passed, 0 failed**
  - Prettier: PASS
  - Next.js production build: PASS
- `npm run smoke`: PASS
  - Fresh workspace uses INR and `Asia/Kolkata`
  - Approval workflow creates a balanced ledger
  - Trial balance generated successfully
- `npm audit --omit=dev --audit-level=high`: **0 vulnerabilities**
- `git diff --check`: PASS
- `npm run db:migrate`: `Applied migration 007_access_requests.sql`; `Database migrations ready (7 applied)`

## Security and data behavior

- Request access is an invite request, not self-service authentication.
- No password field exists in the request form or request storage.
- The endpoint is rate-limited by client address.
- Email addresses are normalized to lowercase.
- Pending requests are deduplicated by email.
- Production requests use the durable PostgreSQL `access_requests` table.
- Local development/test requests use an ignored local JSON file when PostgreSQL is unavailable.
- The request route has no read endpoint, so public callers cannot enumerate submitted requests.
- Admins still provision actual login credentials through the existing environment-backed auth configuration.

## Production release checklist

The following steps are still required to expose the new buttons and endpoint at the production URL:

```bash
cd ~/Axxountant
git add README.md app/globals.css app/api/auth/access-request components/AccessRequestScreen.tsx components/LandingScreen.tsx components/Workspace.tsx db/migrations/007_access_requests.sql lib/auth/access-requests.ts lib/store/postgres.ts reports/workflow-testing-report.md tests/access-request.test.ts tests/presentation.test.ts
git commit -m "feat: add request access workflow"
git push origin main
npx vercel --prod
```

After deployment:

1. Open the public home page in an incognito window.
2. Confirm **Sign up** appears beside **Sign in**.
3. Submit a request with a non-sensitive test email.
4. Confirm the success message says the request was received and that no account was created automatically.
5. Open **Sign in** and confirm **Sign up / request access** appears below the login form.
6. Confirm the request is visible to the administrator through the configured database/admin process before provisioning credentials.
7. Verify `/api/health/ready` returns `200` after deployment.

Do not put real passwords, database URLs, provider tokens, or private customer data in screenshots, test fixtures, reports, or commits.

## Known limitation

There is currently no in-product admin screen for approving access requests or editing `APP_AUTH_USERS`. The request is durably captured for administrator review; provisioning remains an operator action through the existing environment-backed authentication configuration.
