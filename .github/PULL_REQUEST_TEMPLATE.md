<!-- SPDX-License-Identifier: MIT -->

## What does this change?

<!-- One paragraph. What behaviour is different after this PR? -->

## Why?

<!-- Link the issue, or explain the problem this solves. -->

Closes #

## How was it verified?

<!--
  Tick what you actually ran. Do not tick something you did not run.
  Not every command is relevant to every change; leave the rest unticked.
-->

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration` (needs PostgreSQL)
- [ ] `npm run test:e2e` (needs the full dev stack)
- [ ] `npm run build`
- [ ] `npm run secrets:scan`
- [ ] `npm run audit:prod` (if dependencies changed)
- [ ] Manually exercised the change in a browser

## Security review

Toran handles untrusted uploads and hands out capability URLs, so every change
gets a security thought even when the answer is "none of this applies".

- [ ] No raw share token is logged, stored, or placed in a job payload.
- [ ] No presigned URL, password, or credential can reach a log line.
- [ ] Every new API input is validated with Zod on the server.
- [ ] New database writes that race are atomic, or explain why they cannot.
- [ ] No new default weakens security (scanning, rate limits, cookies, CSP).
- [ ] No uploaded content is rendered on the application origin.
- [ ] Any new dependency is compatible with Toran's dependency policy
      (see `docs/LICENSING.md`).

If the change touches links or files, also confirm:

- [ ] Link-level state (revoked, expired, password) still gates **every** file
      behind the link.
- [ ] Per-file state (scanning, blocked, deleted, download budget) still gates
      only that file, and never makes a sibling wrongly available or wrongly
      unavailable.
- [ ] A file still cannot be put behind a link without a manage grant for it.
- [ ] Download budgets are still claimed atomically, per file.

## Database changes

- [ ] No schema change.
- [ ] Schema changed, and `npm run db:generate` output is committed.
- [ ] The migration is forward-only and does not destroy production data.

## Documentation

- [ ] No documentation change needed.
- [ ] README, `.env.example` and `docs/` updated to match.
- [ ] `CHANGELOG.md` updated under "Unreleased".

## Notes for reviewers

<!-- Anything you want a reviewer to look at especially closely. -->
