<!-- SPDX-License-Identifier: MIT -->

# Handling abuse

Running a file-sharing service means people will try to misuse it. This is the
operator's playbook.

## Reporting abusive content

**If you are reporting content on someone's Toran instance**, contact that
instance's operator - not this repository. Every instance shows an abuse
contact, and every instance has a `/report` form.

Use the form at `https://<that-instance>/report` with the link, a reason
category, and any detail you can give. Reports are rate limited. Your identity
is stored only as a rotating hash and is **never** shown to the uploader.

## For operators

### Where reports arrive

```bash
docker compose exec worker node apps/worker/dist/cli/main.js reports
```

Reports carry a timestamp, a reason category, optional detail, an optional
contact address, and the share-link id when the link resolved. If the reported
link no longer exists, the report is still recorded against the token hash so
you can see attempted reports.

### Triage

```bash
# 1. Identify what was reported. This never echoes the token back.
toran-admin link "https://toran.example.com/s/<token>"

#    -> share link id, password/expiry/revocation state, and every file the
#       link serves: file id, downloads spent against its own budget, status
#       and filename. A report names a link, which may carry several files.

# 2. Look at one file's record, including the scan verdict and every link that
#    serves it - which may include links carrying other people's files too.
toran-admin file <file-id>
```

Do not download reported content to inspect it unless you have a safe way to do
so. The scan result in `toran-admin file` already tells you whether ClamAV
flagged it.

### Acting

A link may serve several files, so the two commands differ in more than
severity: one acts on a link and everything behind it, the other on a file and
every link that carries it.

```bash
# Revoke one link. Every file behind that link stops being reachable through
# it; the files themselves, and any other link serving them, are untouched.
toran-admin revoke-link <share-id>

# Block the file: revokes EVERY link that serves it - including links that also
# serve other, clean files - and quarantines or deletes the object.
toran-admin block-file <file-id>

# Delete permanently: removes the record and the object.
toran-admin delete-file <file-id>

# Re-scan, if you suspect the original verdict was wrong.
toran-admin rescan <file-id>

# Close the report.
toran-admin report-status <report-id> actioned
```

Destructive commands prompt for confirmation. Pass `--yes` for automation.

### Blocking versus deleting

|                    | `block-file`                                           | `delete-file`                          |
| ------------------ | ------------------------------------------------------ | -------------------------------------- |
| Links              | Every link serving the file is revoked                 | Every link serving the file is revoked |
| Sibling files      | Unreachable, because their links are revoked too       | Unreachable, for the same reason       |
| Object             | Quarantined or deleted per `TORAN_BLOCKED_FILE_ACTION` | Deleted                                |
| Database record    | Retained, marked `blocked`                             | Removed, along with its link entries   |
| Evidence preserved | Yes, if quarantining                                   | No                                     |

Both are deliberately blunt about siblings: a batch that carried abusive
content is not one the uploader gets to keep distributing the rest of. If you
need a clean file to stay available, ask its uploader for a fresh link rather
than reaching for a narrower command - there is not one.

**Prefer `block-file` when you may need the evidence** - for a law-enforcement
request, or a copyright dispute where you might need to show what was there.
Quarantined objects move to the `quarantine/` prefix, which no share link can
ever address.

Set a lifecycle policy on `quarantine/` so it does not accumulate forever.

### Suspected illegal content

Do not investigate beyond what is necessary to confirm the report. Depending on
your jurisdiction and the category of content, you may have reporting
obligations and there may be material you are not permitted to retain.

1. Block the file immediately (`block-file`).
2. Preserve the record - do not `delete-file` yet.
3. Follow your jurisdiction's reporting requirements.
4. Take legal advice before deciding on retention or deletion.
5. Document what you did and when.

Have this process written down **before** you need it.

## Reducing abuse

**Configuration.** Shorter `TORAN_MAX_EXPIRY_SECONDS` limits how long any single
piece of content persists. Smaller `TORAN_MAX_FILE_SIZE_BYTES` makes bulk
distribution less attractive. Tighter per-client quotas raise the cost of
automated abuse.

**Keep scanning on.** It is the single most effective automated control, even
with its limits.

**Publish terms of service.** They give you a clear basis for removing content
and for banning repeat offenders.

**Watch the signals.**

```bash
# Uploads that were blocked by scanning.
docker compose logs worker | grep MALWARE_BLOCKED

# Clients hitting rate limits repeatedly.
docker compose logs web | grep RATE_LIMITED
```

**Consider requiring accounts** for a public instance. The MVP is anonymous by
design, which is right for a private or team deployment and increasingly
difficult at public scale.

## What Toran deliberately does not do

- **No proactive content matching.** No PhotoDNA, no hash-list checking. Adding
  one is on the roadmap as an optional integration.
- **No durable uploader identity.** Client identifiers rotate daily by design
  (see [PRIVACY.md](PRIVACY.md)), which limits how far you can trace an
  uploader. This is a privacy choice with a real abuse cost, and you should
  understand it before running a public instance.
- **No automated takedown.** Every removal is an operator decision.
