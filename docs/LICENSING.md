<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Licensing

> **This is not legal advice.** It records the project's intent and the
> automated checks that exist. Maintainers should obtain a formal licence review
> from a qualified lawyer before any commercial launch, before distributing
> Toran as part of a product, and before relicensing anything.

## Toran's licence

Toran is licensed under **AGPL-3.0-only**. The full text is in
[LICENSE](../LICENSE).

### Why AGPL

The AGPL's distinguishing feature is section 13: if you run a modified version
as a network service, you must offer its users the corresponding source. An
ordinary GPL would let someone take Toran, improve it, run it as a hosted
service, and never share the improvements.

For a self-hostable service, that is exactly the case worth covering.

### What this means for you

**Self-hosting Toran unmodified.** Nothing to do. Run it.

**Modifying Toran and running it for others.** You must make your modified
source available to your users. Publishing your fork satisfies this.

**Modifying Toran for internal use only, no external users.** The network clause
is not triggered.

**Building a product on Toran.** The AGPL is likely to apply to your product.
Get legal advice.

**Contributing.** Your contribution is licensed under AGPL-3.0-only. There is no
CLA; you keep your copyright.

## SPDX identifiers

Every source file carries a header:

```typescript
// SPDX-License-Identifier: AGPL-3.0-only
```

Please include it in new files. It makes automated licence tooling work and
removes ambiguity about which files the licence covers.

## Dependency compatibility

Toran can only depend on packages whose licences permit inclusion in an
AGPL-3.0-only work.

### Compatible

MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, Unlicense, CC0-1.0,
Python-2.0, and GPL-3.0 / LGPL / AGPL-3.0 family licences.

Apache-2.0 is compatible with GPLv3 and AGPLv3 in one direction only: Apache
code may be included in an AGPL work, not the reverse.

### Incompatible — never add these

| Licence                                   | Problem                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| SSPL-1.0                                  | Not an open-source licence; incompatible copyleft scope |
| BUSL-1.1                                  | Source-available with usage restrictions                |
| Elastic-2.0                               | Usage restrictions                                      |
| CC-BY-NC-*                                | Non-commercial restriction                              |
| AGPL-1.0                                  | Incompatible with v3                                    |
| JSON ("shall be used for Good, not Evil") | Not an open-source licence; unenforceably vague         |
| Anything proprietary or unlicensed        |                                                         |

CI enforces this list via `actions/dependency-review-action` in
`.github/workflows/supply-chain.yml`. That check is an automated first pass, not
a legal review.

### Adding a dependency

1. Check the licence. `npm view <package> license` is a starting point, but read
   the actual LICENSE file — package metadata is sometimes wrong.
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

Fonts are system fonts referenced by name — nothing is bundled or served.

If you add an asset, verify its licence and record it here.

## Before a commercial launch

Have a lawyer confirm at minimum:

1. That the AGPL-3.0-only choice fits your intent.
2. That every dependency licence is compatible in your jurisdiction.
3. That your intended use does not trigger obligations you cannot meet.
4. Whether you need a trademark position on the name.
5. Whether you need a CLA or DCO for contributions.
6. How the licence interacts with your terms of service.

## Trademark

"Toran" is not currently a registered trademark. The AGPL covers copyright, not
trademarks. If you fork and run a public instance, consider using a different
name to avoid confusing users about who operates the service — and to avoid
implying an endorsement that does not exist.
