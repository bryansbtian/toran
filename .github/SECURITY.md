# Security Policy

## Reporting a Vulnerability

If you believe you have found a security vulnerability in Toran, please report it
privately. Do not open a public issue, pull request, or discussion, since that could
expose users of a running instance before a fix is available.

Use GitHub private vulnerability reporting: open the **Security** tab of this repository
and choose **Report a vulnerability**. That channel is private to the maintainers.

Please include:

- A description of the issue and the potential impact.
- Steps to reproduce, or a proof of concept.
- The affected area (module, endpoint, command, dependency) if known.
- Any relevant logs or output, with secrets and personal data redacted.

## What to Expect

- We aim to acknowledge your report within 3 business days.
- We will investigate, keep you updated on progress, and let you know when a fix ships.
- Please give us a reasonable amount of time to address the issue before any public
  disclosure.

## Supported Versions

This project is under active development. Only the `main` branch receives security fixes.

## Scope

Toran's central property is that uploaded file contents never pass through the application
server. Browsers upload and download directly against object storage using short-lived
presigned URLs, and Toran only ever authorizes those operations. Anything that breaks that
property, or that grants access a capability link was never meant to carry, is in scope.

In scope:

- Share access control: reaching a file without the link, past an expiry, past a
  revocation, past a password, or past a download limit. Race conditions that let a
  download limit be exceeded count here.
- Token handling: predictable share tokens, token leakage through logs, error messages,
  referrers, or stored records.
- Presigned URL handling: a URL that grants wider access than the operation it was issued
  for, that outlives its intended lifetime, or that reaches a party who should not hold it.
- Credential handling: anything that causes storage credentials, the secret key, database
  credentials, or session cookies to reach the browser, logs, error messages, stored files,
  or stdout.
- Malware scanning bypass: making a file downloadable without an explicit clean verdict.
- Upload handling: filename handling, content type handling, quota and rate-limit bypass,
  and anything that lets one client consume another client's allowance.
- Web application vulnerabilities in the control plane: origin validation bypass, CSRF,
  XSS, cookie handling, and CSP bypass.
- Production startup guards that fail to reject an unsafe configuration.
- Dependency issues with a demonstrated, exploitable impact on Toran.

Out of scope:

- Reports from automated scanners without a demonstrated, exploitable impact.
- Vulnerabilities in third-party services or SDKs we integrate with, unless our use of
  them is what creates the vulnerability.
- Denial of service, volumetric, or rate-limit testing.
- Misconfiguration of a deployment that departs from the documented configuration, such as
  a storage bucket deliberately made public.
- Malware that ClamAV does not have a signature for. Scanning reduces exposure; it is not
  a guarantee, and Toran does not claim one.

## Handling Secrets

Never include real secrets, API keys, tokens, share links, or production credentials in a
report. If you discover an exposed secret, tell us what was exposed and where, but do not
paste the value.

The same rule governs this repository: `.env` is git-ignored, `.env.example` holds
placeholders only, `npm run secrets:scan` runs in CI, and any file committed by a tool in
this project must be reviewed for credentials and personal data before it lands.
