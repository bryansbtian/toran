<!-- SPDX-License-Identifier: AGPL-3.0-only -->

## What does this change?

<!-- One paragraph. What behaviour is different after this PR? -->

## Why?

<!-- Link the issue, or explain the problem this solves. -->

Closes #

## How was it verified?

<!-- Tick what you actually ran. Do not tick something you did not run. -->

- [ ] `npm run format:check`
- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:integration`
- [ ] `npm run test:e2e`
- [ ] `npm run build`
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
- [ ] Any new dependency is compatible with AGPL-3.0-only.

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
