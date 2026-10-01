# SLO runbook

What the objectives mean, what each alarm is claiming when it fires, and what to
do about it. Read [the sampling floor](#the-sampling-floor) before trusting the
severity ladder — on a slow canary the tiers can all mean the same thing.

## What is being measured

Every objective in this repository is built on one metric:
`CloudWatchSynthetics / SuccessPercent`, dimensioned by `CanaryName`. It is 100
or 0 for a single run, so an average over a period is the success rate across
the runs that period contains.

That is a probe success rate, not a request success rate. It is unweighted by
traffic, it cannot see a failure that needs a real session to reproduce, and it
does not distinguish a timeout from a 500 — both are simply an unsuccessful
run. Everything below is downstream of that.

## The arithmetic

| Quantity | Default | Comes from |
|---|---|---|
| Objective | 99.5% | `slo_objective` |
| Error budget | 0.5% | `1 - slo_objective` |
| Budget period | 30 days | `slo_window_days` |
| Budget | 216 minutes | `0.005 × 30 × 24 × 60`, reported as `slo_error_budget_minutes` |

A burn rate is a multiple of the rate at which the budget could be spent evenly
across the period. Burning at 1x exhausts it exactly at the end; burning at
14.4x exhausts 2% of it in an hour.

The alarms compare `SuccessPercent`, so each tier's threshold is the complement
of its error rate:

```
error threshold   = burn_rate × error_budget × 100
success threshold = 100 − error threshold
```

With the defaults:

| Tier | Burn | Long window | Short window | Breaches below | Budget consumed | Intent |
|---|---|---|---|---|---|---|
| `fast` | 14.4x | 60 min | 5 min | 92.8% success | 2% in an hour | Page |
| `slow` | 6x | 360 min | 30 min | 97.0% success | 5% in six hours | Ticket |

`terraform output slo_burn_rate_thresholds` prints this table for the
deployment as it actually is, including per-canary overrides, so there is no
need to redo the arithmetic by hand.

## The sampling floor

This is the one caveat that changes how the alarms should be read.

Burn-rate alerting was designed for request-based availability, where a window
holds thousands of events. A canary contributes **one sample per run**. So the
finest non-zero error rate a window can express is:

```
smallest observable error rate = 100 / floor(window_minutes / interval_minutes)
```

A 60-minute window over a `rate(5 minutes)` canary holds 12 runs, so the
smallest error it can show is 8.33%. The `fast` tier breaches at 7.2% — finer
than the instrument. Every single failed run therefore breaches that tier, and
it cannot distinguish a sustained burn from one bad run.

| Canary cadence | `fast` long window | Runs | Floor | `fast` threshold | Meaningful? |
|---|---|---|---|---|---|
| `rate(5 minutes)` | 60 min | 12 | 8.33% | 7.2% | No — one failure breaches |
| `rate(1 minute)` | 60 min | 60 | 1.67% | 7.2% | Yes — needs ~5 failures |

Two things follow.

- The default objective here is **0.995, not 0.999**, for this reason and not
  out of modesty. At 99.9% the `fast` tier breaches at 1.44%, two orders of
  magnitude finer than a five-minute canary can resolve.
- `terraform output slo_windows_undersampled` lists every canary-and-tier pair
  where the floor exceeds the threshold. A pair listed there still alarms
  correctly; what it cannot do is mean what its tier name implies. For a
  heartbeat, "one failure alerts" is frequently the intended behaviour — the
  output exists so that it is a choice rather than a surprise.

A plan-time guard refuses a configuration in which **every** tier for a canary
is undersampled, because then the ladder has stopped being a ladder: each tier
fires on the same failed run and the severities are decoration.

## The alarms

Names are built as `<name_prefix>-<canary key>-<kind>`:

| Alarm | Notifies | What it claims |
|---|---|---|
| `…-<canary>-slo-fast` | Yes | Composite. Both the 60-minute and the 5-minute window are below 92.8% success. |
| `…-<canary>-slo-slow` | Yes | Composite. Both the 6-hour and the 30-minute window are below 97% success. |
| `…-<canary>-burn-<tier>-long` | No | One half of a pair. Actions disabled by design. |
| `…-<canary>-burn-<tier>-short` | No | The other half; its job is to clear quickly, not to be precise. |
| `…-<canary>-latency` | Yes | `Duration` exceeded the budget for several consecutive windows. |
| `…-slo-rollup` | No | In ALARM whenever any objective is. A light to look at, never a page. |

Route the composites. The metric alarms underneath are deliberately silent, so
a tier pages once rather than three times.

## Triage

### `slo-fast` fired

Treat as an active outage of the probed path.

1. **Confirm it is the endpoint and not the probe.** Open the artifacts for the
   failing runs — `s3://<artifacts_bucket_name>/canary/<canary key>/` — and read
   the run log. A canary failure caused by the script (an expired certificate on
   a dependency, a changed selector, a body signature that now matches a
   legitimate response) looks identical on the metric to an endpoint that is
   down.
2. **Check the scope.** Is one canary failing or all of them? One endpoint
   failing while the heartbeat passes points at that route; everything failing
   at once points at the shared path — DNS, the load balancer, the certificate,
   or the region.
3. **Check whether the probe is even where you think it is.** If
   `canaries_run_inside_vpc` is true, the canary proves nothing about the path
   an internet client takes.
4. **Compare against real users.** If RUM is enabled, the dashboard's telemetry
   band answers whether browsers are seeing it too. If the probe is failing and
   real sessions are fine, suspect the probe's vantage point or its assertions.
5. **Spend the budget knowingly.** `slo_error_budget_minutes` is the whole
   period's allowance; at 14.4x it is 2% an hour.

### `slo-slow` fired

A ticket. The objective is being eroded faster than it can sustain, but not fast
enough to exhaust it today. The usual causes are a partial failure that a
retry hides — one unhealthy target behind a load balancer, a dependency
timing out for a fraction of requests — and the useful first move is the
artifacts for the failed runs rather than the dashboard, because the pattern of
*which* runs failed is the signal.

### `latency` fired

Not a budget being consumed; a distribution that has moved and stayed moved.

First establish **what the alarm is measuring**. Check
`terraform output slo_latency_measures_harness`: a canary listed there has no
`latency_step_name`, so its alarm reads the whole run. On a browser runtime the
whole run begins by launching a browser, which routinely costs more than the
endpoint being observed. Those two numbers differ by an order of magnitude, are
both called `Duration`, and nothing in the console distinguishes them. Set
`latency_step_name` in `slo_canary_overrides` to the step name the script uses
before concluding anything about endpoint latency.

If the alarm is step-scoped, correlate against the most recent deploy, then
against the dependency timings in the HAR file stored with the run artifacts.

### An alarm is in INSUFFICIENT_DATA

This is the state that notifies nobody and looks calm on a dashboard, so it is
worth checking deliberately rather than waiting to be told.

- **A stopped canary produces no metrics.** `terraform output
  canaries_not_started` lists canaries created but left stopped.
- **With `slo_treat_missing_data_as_breaching = false`** (the default is true), a
  canary that has stopped reporting leaves its alarms here indefinitely.
  `slo_silence_not_treated_as_failure` reports which mode is in force.
- **A window shorter than one run interval** holds no data at all, which is a
  different fault from undersampling and is refused at plan time.

## Before trusting the ladder

Three commands, worth running after every change to the objectives:

```bash
make outputs | grep -A4 slo_windows_undersampled   # tiers finer than the signal
make outputs | grep -A4 slo_latency_measures       # latency alarms reading the harness
make outputs | grep -A4 alerts_subscriptions       # subscriptions nobody has confirmed
```

## When an alarm fires and nobody hears

In rough order of how often each one is the answer:

1. **An unconfirmed email subscription.** Every address starts unconfirmed and
   delivers nothing until its owner clicks the link AWS sends. A successful
   apply is not evidence that anybody has, and confirmation is not visible to
   Terraform — `alerts_subscriptions_pending_confirmation` does not shrink as
   they are confirmed.
2. **An AWS-managed KMS key on the topic.** `alias/aws/sns` has a policy that
   cannot be edited, so it can never grant CloudWatch the key use it needs: the
   alarm changes state, KMS refuses the publish, and nothing on the alarm
   records it. Refused by shape at plan time, but a topic supplied through
   `alerts_topic_arn` is outside that check.
3. **A topic this configuration does not own.** When
   `slo_delivery_unverifiable` is true, neither that topic's access policy nor
   its key can be checked from here, and both are ordinary reasons a
   notification goes nowhere.
4. **Suppression left on.** If `slo_notifications_can_be_suppressed` is true, a
   page can be withheld while the suppressor alarm is in ALARM. Suppression
   hides the notification, never the state, so the alarm still reads ALARM in
   the console and on the dashboard. Nothing here can verify the suppressor
   exists, and one naming an alarm that does not exist suppresses nothing.

## Planned maintenance

Name a suppressor alarm rather than disabling the objectives:

```hcl
slo_suppressor_alarm_name               = "maintenance-window-active"
slo_suppressor_wait_period_seconds      = 120
slo_suppressor_extension_period_seconds = 120
```

The wait period is how long the composite waits for the suppressor to go into
ALARM before notifying anyway; the extension period is how long suppression
persists after the suppressor clears, which stops a page landing in the seconds
between the end of a change and the service settling.

Stopping a canary also works and is worse: it produces no metrics, so the
alarms move to INSUFFICIENT_DATA and the gap is invisible afterwards.

## Changing an objective

1. Edit `slo_objective`, or a per-canary entry in `slo_canary_overrides`.
2. `make plan` and read the diff. Thresholds, alarm descriptions and the
   dashboard's threshold lines all move together, because all three are derived
   from the same locals.
3. After applying, re-read `slo_windows_undersampled`. Raising an objective
   makes thresholds finer, which is exactly how a tier crosses below the
   sampling floor — and the result is a severity ladder in which every rung
   fires at once.
4. If a tighter objective is genuinely needed, shorten the canary's schedule
   first. The floor is a property of the sampling rate, so more runs per window
   is the only thing that makes a finer threshold mean anything.
