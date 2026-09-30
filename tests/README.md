# Tests

Offline checks over the canary scripts, the helpers under `canary-scripts/lib/`,
and the agreements between those scripts and the Terraform that deploys them.

```bash
node --test --test-timeout=30000 "tests/**/*.test.js"   # the whole suite
node tests/lint/canary-conventions.js                   # the conventions lint alone
```

There is nothing to install. The suite runs on the standard library test runner,
and the bundle it exercises carries no third-party code either — the same
property in both places, for the same reason: this code is uploaded whole into an
account, and there is no install step anyone would audit.

## What is covered, and why it is worth covering

| Area | What the tests hold in place |
|---|---|
| `tests/unit/` | The helpers, in both directions. Every rule is shown accepting a good observation and refusing a bad one. |
| `tests/canaries/` | Each canary script, end to end, with the Synthetics runtime replaced. |
| `tests/contract/` | Facts written down twice — in Terraform and in a script — that nothing else compares. |
| `tests/lint/` | Properties of the bundle: no dependencies, no runtime coupling in `lib/`, no hardcoded target. |

The question these are built around is not whether a canary passes. It is
whether a canary that passes means anything. A check that cannot fail produces
exactly the same green square as an endpoint that never breaks, so most of the
cases here are about the ways a canary can quietly stop asserting: a status
expectation that fell back to *anything* after a typo, a link run with nothing in
scope, a baseline regenerated on every run and therefore compared against itself,
a body-signature list silently restored to its defaults by an operator trying to
empty it.

## The runtime doubles

A canary script requires `Synthetics` and `SyntheticsLogger`, two bare module
names the service provides and that exist nowhere else. `tests/support/runtime.js`
intercepts those two names and hands back doubles, so the code under test is the
committed script, unmodified, requiring its real helpers.

The doubles are strict rather than convenient. `executeHttpStep` performs a
genuine request against the options the script built and passes the real
`IncomingMessage` to the validator, so a script that fails to drain a response
body hangs here exactly as it would in the service. `getPage` returns a page
double that throws on anything unconfigured, so a test failure names the
assumption the script is making rather than quietly answering it.

The probe and link tests run against a local HTTP server on the loopback
interface (`tests/support/server.js`). A timeout, a redirect loop, and a body
larger than the probe will buffer cannot be produced by a mock that returns an
object, and a real socket produces all three without any network access.

## Two notes for whoever changes these

**The timeout on the command line matters.** Several tests hold a socket open on
purpose to prove a per-request timeout fires. If that timeout regresses, the
suite *hangs* instead of failing, and a job that hangs reports nothing about why.
`--test-timeout` is what turns that into a bounded red run.

**A check that catches nothing is worse than no check.** Every rule here has been
verified by injecting the defect it exists to catch and confirming the suite goes
red. Two deliberate exceptions are worth knowing about, because they look like
gaps and are not: removing the named list of non-HTTP link schemes changes no
behaviour, since the protocol test below it is what confines the checker to
fetchable addresses; and removing the early return that bounds a buffered
response body changes no output either, since the visible truncation is done when
the buffer is joined. Both exist for reasons a test cannot observe — speed and
memory — and are documented as such where they are written.
