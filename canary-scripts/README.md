# Canary scripts

The code the canaries run. Terraform decides which endpoints are watched, how
often, and with what permissions; these scripts decide what *healthy* means for
them. That split is the reason they live in their own directory with their own
build: the assertions change when the service changes, at a different pace from
the infrastructure around them.

## Layout

```
canary-scripts/
├── api-canary.js            HTTP contract check for a single endpoint
├── heartbeat-canary.js      Minimal availability check at the fastest cadence
├── broken-link-checker.js   Follows the links on a page and reports the dead ones
├── visual-monitoring.js     Screenshot comparison against a stored baseline
├── build.sh                 Packages everything into dist/canaries.zip
└── lib/
    ├── config.js            Environment parsing, with a named error per variable
    ├── assertions.js        Status, body, latency and certificate assertions
    ├── links.js             Link resolution, scoping and result summarising
    └── probe.js             An HTTP request with a hard timeout, no runtime deps
```

Nothing in `lib/` imports the Synthetics runtime. That is deliberate: the logic
that decides whether an endpoint is healthy can then be exercised in a pipeline
with no AWS account, no browser and no network, which is where it gets tested.
The four top-level scripts are the thin layer that reads the environment, drives
the runtime, and calls into `lib/`.

There are no runtime dependencies. Everything used at run time is either in the
Node standard library or provided by the Synthetics runtime, so the bundle needs
no `npm install` and carries no third-party code into the account.

## Packaging

The service does not accept a flat directory of scripts. A Node.js canary is a
zip whose contents sit under `nodejs/node_modules/`, and a handler of
`api-canary.handler` means the service loads `nodejs/node_modules/api-canary.js`
and calls its exported `handler`. `build.sh` assembles that layout, syntax-checks
every file on the way in, and writes the archive:

```bash
./canary-scripts/build.sh
# → canary-scripts/dist/canaries.zip
```

Then point the configuration at it:

```hcl
canary_code = {
  zip_path = "canary-scripts/dist/canaries.zip"
}
```

An archive over 10 MB cannot be uploaded inline; `build.sh` fails with that
message rather than letting the apply discover it. Upload it to S3 and use
`canary_code.s3_bucket` and `canary_code.s3_key` instead.

`dist/` is not tracked. The bundle is a build artifact, and a committed zip is a
second copy of the scripts that drifts from the first.

## The scripts

### `api-canary.js` — handler `api-canary.handler`

Calls one endpoint and asserts the whole contract, not just reachability: the
status code, optionally a set of JSON fields, the absence of an error signature
in an otherwise successful body, the response time against a budget, and the
remaining certificate lifetime.

The body check is the one a status monitor cannot make. A service that answers
`200` with a rendered error page is down, and an availability figure built on
status codes alone records those minutes as healthy.

| Variable | Default | Effect |
|---|---|---|
| `TARGET_URL` | required | Absolute URL to call. |
| `EXPECTED_STATUS` | `200` | `204`, `200,201`, `2xx`, `200-299`, or `any`. |
| `REQUEST_METHOD` | `GET` | Verb to use. |
| `REQUEST_HEADERS` | `{}` | JSON object. A `User-Agent` is added when absent. |
| `REQUEST_BODY` | unset | Raw body, for a `POST` or `PUT` check. |
| `LATENCY_BUDGET_MS` | `0` | Fails the run when exceeded. `0` disables it. |
| `BODY_MUST_CONTAIN` | unset | Text that must appear in the response. |
| `BODY_ERROR_PATTERNS` | four common signatures | Comma-separated text that must *not* appear. |
| `EXPECT_JSON_FIELDS` | `{}` | JSON object of dotted path to expected value, e.g. `{"status":"ok","data.count":0}`. |
| `CERT_EXPIRY_WARNING_DAYS` | `14` | Fails when less lifetime remains. `0` disables it. |
| `TAKE_SCREENSHOT` | `false` | This check opens no page, so a capture would be blank. |

Authorization, cookie and API-key headers are listed as restricted, so they are
redacted in the run report rather than written into the artifacts bucket.
Response bodies are not recorded at all, for the same reason: a response can
carry personal data, and the bucket is not the place to accumulate it one run at
a time.

### `heartbeat-canary.js` — handler `heartbeat-canary.handler`

Loads one page as fast as the service allows and answers a single question: is
it up. Everything optional is off, because this is what an availability
objective is measured against and the canary's own latency becomes part of the
measurement.

It waits for `domcontentloaded` rather than for the network to fall quiet. A
page holding an analytics socket open never reaches `networkidle0`, and waiting
for it turns a healthy page into a timeout.

| Variable | Default | Effect |
|---|---|---|
| `TARGET_URL` | required | Page to load. |
| `EXPECTED_STATUS` | `2xx` | Same grammar as above. |
| `PAGE_LOAD_TIMEOUT_MS` | `10000` | Navigation timeout. |
| `LATENCY_BUDGET_MS` | `0` | Fails the run when exceeded. |
| `BODY_MUST_CONTAIN` | unset | Checked against rendered text, not source. |
| `WAIT_UNTIL` | `domcontentloaded` | `load`, `networkidle0` and `networkidle2` also accepted. |
| `TAKE_SCREENSHOT` | `false` | Successes only; a failure is always captured. |

### `broken-link-checker.js` — handler `broken-link-checker.handler`

Loads a page, collects the links a visitor could follow, and checks each one.
This catches the slow rot nothing else here sees: a renamed docs page, a retired
pricing anchor, a partner whose domain lapsed.

Three behaviours are worth knowing before configuring it.

**Every link is checked before anything fails.** The run reports the complete
list once, at the end, rather than aborting on the first bad link and finding
the next one on the following run.

**Requests are capped and bounded.** The target is usually a single origin, so
an uncapped crawl on a five-minute cadence is a load test that will be reported
as an outage. `MAX_LINKS` bounds the work, `CONCURRENCY` bounds the burst.

**Redirects are counted, not failed.** A link answering `301` works, but a
navigation whose links all redirect is one rename away from being broken, so
redirects get their own column in the summary.

| Variable | Default | Effect |
|---|---|---|
| `TARGET_URL` | required | Page whose links are checked. |
| `LINK_SELECTOR` | `a[href]` | Narrow it to skip a footer or a nav. |
| `MAX_LINKS` | `50` | `0` removes the cap. |
| `CONCURRENCY` | `4` | Requests in flight at once. |
| `LINK_TIMEOUT_MS` | `10000` | Per-link timeout. |
| `SAME_ORIGIN_ONLY` | `false` | Skip everything off the page's own origin. |
| `INCLUDE_PATTERNS` | unset | When set, only links containing one of these are checked. |
| `EXCLUDE_PATTERNS` | unset | Never checked. Exclusions win over inclusions. |
| `FAIL_ON_BROKEN` | `true` | Set `false` to report without alarming. |

Links are checked with `GET`, not `HEAD`. Enough origins answer `405` to a
`HEAD` they serve happily as a `GET` that the halved traffic is not worth the
false findings.

### `visual-monitoring.js` — handler `visual-monitoring.handler`

Walks a short journey and compares each screenshot against a stored baseline.
This is the check for the failure every other canary here is blind to: a page
that answers `200`, contains all its text, and renders as a blank column because
a stylesheet stopped being served.

Visual comparison is the check most likely to cry wolf, so three things are
built in rather than left to be discovered:

- **A variance tolerance.** Fonts hint differently and antialiasing is not
  deterministic across runtime upgrades. A strict pixel match fails on a page
  nobody touched.
- **Masking.** Clocks, session identifiers, carousels and advert slots differ on
  every load by design. `IGNORE_SELECTORS` hides them before the capture, using
  `visibility: hidden` so the layout does not reflow and turn a masked region
  into a whole-page difference.
- **An explicit baseline switch.** `GENERATE_BASELINE` is how a deliberate
  redesign is accepted. It is off by default, because a baseline that
  regenerates on every run compares the page to itself and always passes.

| Variable | Default | Effect |
|---|---|---|
| `TARGET_URL` | required | Where the journey starts. |
| `JOURNEY_STEPS` | landing page only | JSON array of `{"name","path","waitFor"}`. |
| `GENERATE_BASELINE` | `false` | Accepts the current rendering as the new baseline. |
| `VISUAL_VARIANCE_PCT` | `1` | Tolerated percentage of differing pixels. |
| `IGNORE_SELECTORS` | unset | Comma-separated CSS selectors hidden before capture. |
| `VIEWPORT_WIDTH` / `VIEWPORT_HEIGHT` | `1280` / `900` | Capture size. Changing either invalidates the baseline. |
| `FULL_PAGE_SCREENSHOT` | `false` | Affects the saved artifact, not the compared image. |
| `SETTLE_MS` | `500` | Pause before capture, for entry animations and lazy images. |

Step names become screenshot file names and therefore baseline identities, so a
duplicate name is rejected at startup rather than surfacing as a flapping alarm.

## Wiring a script to a canary

The two canaries the configuration creates by itself, `api` and `heartbeat`, are
already pointed at their handlers. The other two are added through the `canaries`
input, which takes the same shape:

```hcl
canaries = {
  links = {
    handler             = "broken-link-checker.handler"
    name_suffix         = "links"
    schedule_expression = "rate(1 hour)"
    timeout_in_seconds  = 300
    memory_in_mb        = 1024
    environment_variables = {
      TARGET_URL       = "https://<your-site>/"
      SAME_ORIGIN_ONLY = "true"
      MAX_LINKS        = "80"
    }
  }

  visual = {
    handler             = "visual-monitoring.handler"
    name_suffix         = "vis"
    schedule_expression = "rate(30 minutes)"
    timeout_in_seconds  = 180
    memory_in_mb        = 2048
    environment_variables = {
      TARGET_URL       = "https://<your-site>/"
      IGNORE_SELECTORS = ".clock,.promo-carousel"
      JOURNEY_STEPS    = "[{\"name\":\"landing\",\"path\":\"/\"},{\"name\":\"pricing\",\"path\":\"/pricing\",\"waitFor\":\"h1\"}]"
    }
  }
}
```

Two constraints the plan-time guards will otherwise remind you about: a canary
*name* may not exceed 21 characters in total, which is what `name_suffix` is
kept short for, and a timeout may not exceed the interval between runs, or runs
overlap.

The link and visual checks are heavier than the built-ins — they open a browser,
and the visual one holds two images in memory to compare them — so both are
given more memory and a slower cadence than the endpoint checks. A visual check
on a one-minute cadence mostly measures your own canary.

## Working on them locally

```bash
node --check canary-scripts/api-canary.js   # any single file
./canary-scripts/build.sh                   # checks every file, then packages
```

`build.sh` refuses to produce a bundle if any file fails its syntax check, so it
is the useful pre-review gate. The modules under `lib/` take plain values and
return plain values, which is what lets the pipeline exercise them directly.
