<!-- SPDX-License-Identifier: MIT -->

# Licensing

> **This is not legal advice.** It records the project's intent and the
> automated checks that exist. Maintainers should obtain a formal licence review
> from a qualified lawyer before any commercial launch, before distributing
> Toran as part of a product, and before relicensing anything.

## Toran's licence

Toran is licensed under the **MIT License**. The full text is in
[LICENSE](../LICENSE).

### Why MIT

MIT is short, permissive, and universally understood. It imposes one obligation:
keep the copyright notice and the permission notice with the software. Beyond
that, anyone may use, copy, modify, merge, publish, distribute, sublicense and
sell copies, including inside closed-source and commercial products.

Toran has been MIT-licensed since its first public release. The project favours
the widest possible adoption - including in commercial products and internal
deployments that could not accept a copyleft obligation - over compelled
contribution.

### What this means for you

**Self-hosting Toran unmodified.** Nothing to do. Run it.

**Modifying Toran and running it for others.** Nothing to do. You are not
required to publish your changes. Contributions back are welcome, not required.

**Modifying Toran for internal use only.** Nothing to do.

**Building a product on Toran, including a commercial one.** Permitted. Keep the
copyright and permission notice with the copies you distribute. The notice
obligation attaches to the Toran code you ship, not to your own code.

**Contributing.** Your contribution is licensed under the MIT License. There is
no CLA; you keep your copyright.

## SPDX identifiers

Every source file carries a header:

```typescript
// SPDX-License-Identifier: MIT
```

Please include it in new files. It makes automated licence tooling work and
removes ambiguity about which files the licence covers.

## Dependency compatibility

**Toran's dependency policy rejects GPL and AGPL dependencies so that the
distributed application can remain compatible with the project's intended
permissive licensing model.**

That is a deliberate project decision about what Toran ships, and about keeping
distribution simple for the people who self-host it and for anyone who builds on
it commercially. It is not a claim about what any particular combination of code
would legally require in your jurisdiction, and it is not legal advice. How
strong copyleft interacts with a given piece of software depends on how the code
is combined, how it is distributed, and who is doing the distributing - which is
exactly why the project avoids the question rather than litigating it per
dependency.

The lists below record the policy CI enforces.

### Compatible

MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0,
BlueOak-1.0.0, Python-2.0.

Apache-2.0 carries a patent grant and a notice requirement; keep any `NOTICE`
file an Apache-2.0 dependency ships.

### Weak copyleft - permitted, with obligations

**LGPL-3.0** and similar. The LGPL is designed to be used _from_ a differently
licensed work, so it does not push Toran onto copyleft terms. It does carry
obligations if you redistribute binaries: preserve its notices, state that the
library is used and under which licence, and allow a recipient to replace the
library with a modified version.

Toran depends on LGPL-3.0-or-later code today. `sharp`, pulled in through
Next.js image optimisation, ships prebuilt `libvips` binaries under
LGPL-3.0-or-later (`@img/sharp-libvips-*`, plus several `@img/sharp-win32-*` and
`@img/sharp-wasm32` packages under `Apache-2.0 AND LGPL-3.0-or-later`). These
are separate, dynamically loaded native modules installed from npm, not code
compiled into Toran.

Distributing a Toran container image, or any other binary artefact, redistributes
those libraries and their obligations travel with it. The published Docker images
satisfy this by shipping the packages intact, with their own licence files, inside
`node_modules`.

### Incompatible - never add these

| Licence                                   | Why the policy refuses it                                          |
| ----------------------------------------- | ------------------------------------------------------------------ |
| GPL-2.0, GPL-3.0                          | Strong copyleft; incompatible with how Toran intends to distribute |
| AGPL-1.0, AGPL-3.0                        | Strong copyleft, plus a network-use obligation                     |
| SSPL-1.0                                  | Not an open-source licence; copyleft scope Toran will not take on  |
| BUSL-1.1                                  | Source-available with usage restrictions                           |
| Elastic-2.0                               | Usage restrictions                                                 |
| CC-BY-NC-\*                               | Non-commercial restriction                                         |
| JSON ("shall be used for Good, not Evil") | Not an open-source licence; unenforceably vague                    |
| Anything proprietary or unlicensed        |                                                                    |

CI enforces this list via `actions/dependency-review-action` in
`.github/workflows/supply-chain.yml`. That check is an automated first pass, not
a legal review. LGPL is deliberately **not** on the deny list, for the reason
given above.

### Adding a dependency

1. Check the licence. `npm view <package> license` is a starting point, but read
   the actual LICENSE file - package metadata is sometimes wrong.
2. Check its transitive dependencies too.
3. Confirm it is maintained and that the code is worth the supply-chain risk.
4. Note the licence in your pull request description.

Prefer writing a small amount of code you own over adding a dependency. Toran
implements its own clamd client and cookie parsing for exactly this reason.

### Inventory

```bash
npx license-checker-rseidelsohn --production --summary --excludePrivatePackages
```

CI runs this on every push, so the inventory is visible in the workflow log.

## Third-party assets

Toran contains no third-party design assets. The logo in
`packages/ui/src/Logo.tsx` is drawn from SVG primitives and is covered by
Toran's own licence.

Fonts are system fonts referenced by name - nothing is bundled or served.

If you add an asset, verify its licence and record it here.

## Before a commercial launch

Have a lawyer confirm at minimum:

1. That the MIT choice fits your intent.
2. That every dependency licence is compatible in your jurisdiction, and that
   the LGPL obligations above are met by however you distribute Toran.
3. That your intended use does not trigger obligations you cannot meet.
4. Whether you need a trademark position on the name.
5. Whether you need a CLA or DCO for contributions.
6. How the licence interacts with your terms of service.

## Trademark

"Toran" is not currently a registered trademark. The MIT License covers
copyright, not trademarks. If you fork and run a public instance, consider using
a different name to avoid confusing users about who operates the service - and
to avoid implying an endorsement that does not exist.
