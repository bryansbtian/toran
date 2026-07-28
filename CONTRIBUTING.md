<!-- SPDX-License-Identifier: MIT -->

# Contributing to Toran

Thanks for wanting to help. Toran is meant to be easy to run locally and easy to
contribute to; if either of those is not true for you, that itself is a bug
worth reporting.

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Getting set up

You need **Node.js 22+**, **npm 10+**, and **Docker** with Compose. Give Docker
at least **4 GB of memory**; ClamAV alone needs roughly 1.5 GB.

```bash
git clone https://github.com/toran-project/toran.git
cd toran
npm install
npm run dev:setup
npm run dev
```

`npm run dev` prints the address it settled on - open that one, not `localhost`.
Storage only accepts browser uploads from the origin the instance is configured
for, so reaching a LAN-addressed instance through `localhost` fails at the
upload step.

`npm run dev:setup` creates `.env` from `.env.example` if you do not have one,
starts PostgreSQL, MinIO and ClamAV, creates a private development bucket,
builds the workspace packages and applies migrations. It is idempotent - run it
whenever you want to be sure your environment matches the schema.

`npm run dev` starts the web app _and_ the background worker, so malware
scanning and the cleanup jobs run without a second terminal. It also addresses
the instance to this machine's LAN address, so a link you copy out of the UI is
one you can actually send someone; with no network to bind to it falls back to
localhost. `npm run dev:local` skips all of that and uses `.env` as it stands.

### If something does not work

- `npm run dev:infra:down`, then `npm run dev:setup`, resets the infrastructure.
- ClamAV takes several minutes on first boot while it downloads signatures.
  Until then uploads sit in `scanning`. `docker logs -f toran-dev-clamav`.
- The [troubleshooting section](README.md#troubleshooting) covers the common
  cases.

---

## Good first issues

Issues labelled **good first issue** are deliberately scoped so you can finish
them in one sitting without needing the whole architecture in your head. They
have:

- a clear description of the desired behaviour,
- a pointer to the files involved,
- a note on which tests should cover it.

Good areas for a first contribution:

- **UI polish and accessibility** - `apps/web/src/components/`. Self-contained,
  visible results, and every fix helps real users.
- **Error messages** - `packages/shared/src/errors.ts`. Making a message clearer
  is a genuinely valuable change.
- **Documentation** - especially a provider-specific storage guide you have
  actually configured yourself.
- **Test coverage** - pick a function in `packages/` and cover an edge case that
  is not covered yet.
- **Filename handling** - `packages/shared/src/filenames.ts` is pure, heavily
  tested, and full of interesting edge cases.

Comment on the issue before you start so nobody duplicates your work. If nothing
fits, open an issue describing what you would like to do.

---

## Repository layout

```text
apps/web         Next.js app: UI, API routes, request handling
apps/worker      Job runner, ClamAV client, cleanup jobs, admin CLI
packages/config          Typed environment configuration + production guards
packages/database        Drizzle schema, migrations, repositories, job queue
packages/observability   Logging with redaction, OpenTelemetry hooks
packages/security        Tokens, Argon2id, rate limiting, grants, identity
packages/shared          Domain types, Zod contracts, filenames, branding
packages/storage         StorageProvider interface, S3 and in-memory impls
packages/ui              Accessible React primitives
```

Module boundaries are real. `@toran/shared` must stay browser-safe (no Node
built-ins); anything Node-only belongs in `security`, `storage`,
`observability`, or an app.

---

## Development workflow

1. Branch from `main`.
2. Make the change.
3. Add or update tests.
4. Run the checks below.
5. Open a pull request using the template.

### Checks

```bash
npm run format:check   # Prettier
npm run lint           # ESLint
npm run typecheck      # TypeScript
npm test               # Unit tests (no services needed)
npm run test:integration   # Needs PostgreSQL (npm run dev:setup)
npm run test:e2e           # Needs the full dev stack
npm run build          # Everything compiles
npm run secrets:scan   # No committed credentials
npm run audit:prod     # No unreviewed advisories in shipping dependencies
```

CI runs all of these. Running them locally first is faster than waiting.

`audit:prod` fails on any high or critical advisory in a production dependency
unless that advisory has been individually reviewed. If it fails, upgrade the
dependency. Add it to `ACCEPTED` in `scripts/audit-production.mjs` only when the
vulnerable code path genuinely cannot be reached from Toran, and say why in the
entry - "it is inconvenient to upgrade" is not a reason.

---

## Code standards

**TypeScript**

- Strict mode. No `any` without a comment justifying it.
- Explicit return types on exported functions.
- `import type` for type-only imports.
- Small, testable functions. Inject storage, scanning, time and randomness
  rather than reaching for globals - every one of those has a test seam already.

**Comments**

Comment the _why_, not the _what_. A comment that restates the code is noise; a
comment explaining why a check exists, or which attack a line prevents, is the
reason the next person does not delete it.

**Errors**

Throw `ToranError` with a stable code from `packages/shared/src/errors.ts`.
User-facing messages must never leak internals - no stack traces, driver errors,
object keys, hostnames, or credentials. Put diagnostic detail in the `internal`
field, which is logged and never serialised.

**Security-sensitive changes**

If you touch any of these, say so in the PR and expect closer review:

- token generation or hashing
- password hashing or verification
- the download reservation path
- job claiming
- rate limiting or quotas
- filename or content-type handling
- CSP and security headers
- the production start-up guards

Never log a raw share token, a password, a presigned URL, or a credential.
`@toran/observability` redacts these, but do not rely on it as your only defence.

---

## Testing expectations

| Kind        | Where                         | Needs          |
| ----------- | ----------------------------- | -------------- |
| Unit        | `*.test.ts` beside the source | nothing        |
| Integration | `*.integration.test.ts`       | PostgreSQL     |
| End-to-end  | `apps/web/e2e/*.spec.ts`      | full dev stack |

Integration and E2E suites skip themselves with a clear message when their
dependencies are missing, so `npm test` always works.

Write tests that would fail if the behaviour regressed. A test that asserts a
function was called is usually not one of those. For anything concurrent, test
the concurrency: `packages/database/src/repos/lifecycle.integration.test.ts` runs
twenty simultaneous download reservations against a limit of three and asserts
exactly three succeed.

Never add a test that requires a paid third-party service.

---

## Database changes

1. Edit `packages/database/src/schema.ts`.
2. `npm run db:generate` - this writes a SQL migration.
3. Review the generated SQL. Actually read it.
4. Commit the schema change **and** the migration together.
5. `npm run db:migrate` to apply it locally.

Migrations are forward-only. Never edit a migration that has been released. CI
fails if the schema and the committed migrations disagree.

---

## Commits and pull requests

Conventional commits are appreciated but not enforced:

```text
feat(web): add drag-and-drop upload
fix(database): reserve downloads atomically
docs(readme): clarify storage configuration
```

A good pull request:

- does one thing;
- explains why in the description;
- has tests for the behaviour it changes;
- keeps the documentation truthful;
- ticks only the checklist items you actually did.

Do not tick a verification box for a command you did not run.

---

## Licensing of contributions

By submitting a contribution to Toran, you agree that your contribution is licensed under the MIT License.

Every source file carries an `SPDX-License-Identifier: MIT` header. Keep it on
files you add. There is no CLA and no copyright assignment: you keep your
copyright, and it is licensed to the project on the same terms as the rest of
the codebase. See [docs/LICENSING.md](docs/LICENSING.md).

---

## Dependencies

Toran is MIT-licensed. Before adding a dependency, check its licence, that it is
maintained, and that it is genuinely worth the supply-chain risk.

Toran's dependency policy rejects GPL and AGPL dependencies so that the
distributed application can remain compatible with the project's intended
permissive licensing model. CI enforces that policy; it is a project decision
about what Toran ships, not legal advice about your situation. LGPL is
permitted. See [docs/LICENSING.md](docs/LICENSING.md).

Prefer a small amount of code you own over a package you do not.

Never introduce a dependency on a paid service.

---

## Releasing

Maintainers only:

1. Update `CHANGELOG.md`, moving `Unreleased` to the new version.
2. Tag `vX.Y.Z`.
3. Verify CI is green, including the Docker build.
4. Publish the release notes with any upgrade instructions.

---

## Questions

Open a [discussion](https://github.com/toran-project/toran/discussions). For
security issues, follow [SECURITY.md](SECURITY.md) instead.
