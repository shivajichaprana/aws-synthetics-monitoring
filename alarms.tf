# ---------------------------------------------------------------------------
# Alerting on the objectives
#
# The shape of this file is the multi-window, multi-burn-rate pattern: for each
# canary and each burn-rate tier, two metric alarms over windows of different
# length, and one composite alarm that notifies only while both are breaching.
# The long window decides whether the objective is genuinely in trouble; the
# short one decides when to stop saying so, which is what keeps an alert from
# outliving the outage by an hour.
#
# One caveat governs the whole file and is easier to state here than to discover
# from a graph. Burn-rate alerting was designed for request-based availability,
# where a window holds thousands of events. A canary contributes one sample per
# run, so a one-hour window over a five-minute canary holds twelve, and the
# finest error rate it can express is one failure in twelve. Thresholds below
# that granularity are reached by any single failed run. That is not a defect to
# be hidden behind a smaller number: the outputs name every window it applies
# to, and the guard at the foot of this file refuses a configuration where it
# applies to every tier at once, because then the tiers all fire together and
# the severities they encode mean nothing.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Encryption for the alerts topic
#
# A separate key from the artifacts key, and not an optional refinement. An
# encrypted SNS topic is only usable by CloudWatch if the key's policy grants
# the CloudWatch service principal kms:GenerateDataKey* and kms:Decrypt. An
# AWS-managed key — alias/aws/sns — has a policy that cannot be edited, so a
# topic encrypted with one accepts nothing from an alarm: the alarm changes
# state, the publish is rejected by KMS, and neither the alarm's history nor its
# state gives any sign that the notification went nowhere. That is the single
# most common way a correctly configured alarm reaches nobody, so the key policy
# below grants exactly that, and the guard refuses an AWS-managed alias outright.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "alerts_key" {
  count = local.alerts_create_key ? 1 : 0

  statement {
    sid    = "EnableAccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  statement {
    sid    = "AllowCloudWatchToPublishEncryptedNotifications"
    effect = "Allow"

    principals {
      type = "Service"

      # Both principals are needed and for different reasons. CloudWatch
      # publishes the alarm notification. SNS uses the key again when it fans
      # that notification out to each subscription, and a grant to CloudWatch
      # alone leaves delivery failing one step later than where it was fixed.
      identifiers = [
        "cloudwatch.amazonaws.com",
        "sns.amazonaws.com",
      ]
    }

    # GenerateDataKey* rather than GenerateDataKey: SNS calls the WithoutPlaintext
    # variant, and a grant naming only the plaintext form is rejected in a way
    # that reads as an unrelated permission problem.
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey*",
    ]

    resources = ["*"]

    # Confines the grant to this account. Without it the service principal is
    # every account's CloudWatch, which is the confused-deputy shape that key
    # policies granting a service principal so often have.
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "alerts" {
  count = local.alerts_create_key ? 1 : 0

  description             = "Encrypts synthetic monitoring alert notifications for ${local.name_prefix}"
  deletion_window_in_days = var.kms_key_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.alerts_key[0].json

  tags = { Name = "${local.name_prefix}-alerts" }
}

resource "aws_kms_alias" "alerts" {
  count = local.alerts_create_key ? 1 : 0

  name          = "alias/${local.name_prefix}-alerts"
  target_key_id = aws_kms_key.alerts[0].key_id
}

# ---------------------------------------------------------------------------
# Alerts topic
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alerts" {
  count = var.create_alerts_topic ? 1 : 0

  name              = "${local.name_prefix}-alerts"
  display_name      = "Synthetic monitoring alerts"
  kms_master_key_id = local.alerts_kms_key_arn

  tags = { Name = "${local.name_prefix}-alerts" }
}

data "aws_iam_policy_document" "alerts_topic" {
  count = var.create_alerts_topic ? 1 : 0

  statement {
    sid    = "AllowCloudWatchAlarmsToPublish"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.alerts[0].arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    # Narrowed to alarms named for this deployment. The consequence is worth
    # knowing before someone renames an alarm: an alarm outside this prefix
    # publishing to this topic is denied, and the denial appears nowhere on the
    # alarm.
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:cloudwatch:${var.aws_region}:${local.account_id}:alarm:${local.name_prefix}-*"]
    }
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["SNS:Publish", "SNS:Subscribe"]
    resources = [aws_sns_topic.alerts[0].arn]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_sns_topic_policy" "alerts" {
  count = var.create_alerts_topic ? 1 : 0

  arn    = aws_sns_topic.alerts[0].arn
  policy = data.aws_iam_policy_document.alerts_topic[0].json
}

# Email subscriptions are created unconfirmed and stay that way until the
# address holder clicks the link AWS sends them. Terraform reports the
# subscription as created either way, so a clean apply is not evidence that
# anyone is reachable — which is what the subscription-pending output is for.
resource "aws_sns_topic_subscription" "alerts_email" {
  for_each = var.create_alerts_topic ? toset(var.alerts_email_addresses) : toset([])

  topic_arn = aws_sns_topic.alerts[0].arn
  protocol  = "email"
  endpoint  = each.value
}

# ---------------------------------------------------------------------------
# Availability: burn-rate windows
#
# These alarms carry no actions. `actions_enabled = false` is set rather than
# merely leaving the action lists empty, so that the intent survives someone
# adding a default action later: the composite alarm below is the only thing in
# this file that notifies anybody, and a tier that paged from both its window
# alarms and its composite would page three times for one event.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "burn_long" {
  for_each = local.slo_burn_windows

  alarm_name          = "${local.name_prefix}-${each.value.canary_key}-burn-${each.value.tier_key}-long"
  alarm_description   = "Success rate for canary ${each.value.canary_name} over ${each.value.long_window_minutes} minutes is consuming its error budget at more than ${each.value.burn_rate} times the sustainable rate. Part of a pair; the composite alarm is what notifies."
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  dimensions          = { CanaryName = each.value.canary_name }
  statistic           = "Average"
  period              = each.value.long_window_minutes * 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "LessThanThreshold"
  threshold           = each.value.success_threshold_percent

  # SuccessPercent is 100 or 0 for each run, so an average over the period is
  # the success rate across the runs it contains. The period is the window
  # itself rather than a shorter bucket evaluated several times: three
  # consecutive ten-minute buckets all breaching is a different claim from the
  # thirty-minute average breaching, and the burn-rate arithmetic is about the
  # latter.
  treat_missing_data = var.slo_treat_missing_data_as_breaching ? "breaching" : "missing"

  actions_enabled = false

  tags = { Name = "${local.name_prefix}-${each.value.canary_key}-burn-${each.value.tier_key}-long" }
}

resource "aws_cloudwatch_metric_alarm" "burn_short" {
  for_each = local.slo_burn_windows

  alarm_name          = "${local.name_prefix}-${each.value.canary_key}-burn-${each.value.tier_key}-short"
  alarm_description   = "Short confirmation window for the ${each.value.tier_key} burn-rate tier on canary ${each.value.canary_name}. Its purpose is to clear quickly once the endpoint recovers, not to be precise."
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"
  dimensions          = { CanaryName = each.value.canary_name }
  statistic           = "Average"
  period              = each.value.short_window_minutes * 60
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  comparison_operator = "LessThanThreshold"
  threshold           = each.value.success_threshold_percent

  treat_missing_data = var.slo_treat_missing_data_as_breaching ? "breaching" : "missing"

  actions_enabled = false

  tags = { Name = "${local.name_prefix}-${each.value.canary_key}-burn-${each.value.tier_key}-short" }
}

# ---------------------------------------------------------------------------
# Availability: the alarm that actually notifies
#
# A composite alarm is the only way to express "both windows at once": a metric
# alarm evaluates one metric against one threshold, and two thresholds on one
# metric cannot be combined inside it.
#
# Its rule is a string naming other alarms, which has a consequence worth
# spelling out. Terraform cannot see a dependency inside a string, so the names
# below are interpolated from the alarm resources rather than rebuilt from the
# same expression. Written out by hand the composite would very likely be
# created before its children and rejected for naming an alarm that does not
# exist yet — and, worse, would keep working after a child was renamed until the
# next time it was evaluated.
#
# A composite alarm also has no treat_missing_data of its own. Everything about
# how silence is handled is decided on the two metric alarms above, which is why
# that setting sits there and is documented there.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "burn" {
  for_each = local.slo_burn_windows

  alarm_name        = "${local.name_prefix}-${each.value.canary_key}-slo-${each.value.tier_key}"
  alarm_description = trimspace("Availability objective for ${each.value.canary_name} is burning at more than ${each.value.burn_rate}x over both a ${each.value.long_window_minutes}-minute and a ${each.value.short_window_minutes}-minute window. Objective ${format("%.3f", local.slo_canaries[each.value.canary_key].objective * 100)}%, so this tier breaches at a success rate below ${format("%.3f", each.value.success_threshold_percent)}%. ${coalesce(each.value.tier_note, "")}")

  alarm_rule = "ALARM(${jsonencode(aws_cloudwatch_metric_alarm.burn_long[each.key].alarm_name)}) AND ALARM(${jsonencode(aws_cloudwatch_metric_alarm.burn_short[each.key].alarm_name)})"

  alarm_actions = local.slo_alarm_actions
  ok_actions    = local.slo_alarm_actions

  # Deliberately not wired to insufficient_data_actions. With missing data
  # treated as breaching on both children, this state means the alarms are too
  # new to have evaluated, which is not news.

  actions_enabled = true

  # Suppression, when an operator has named a suppressing alarm. It stops the
  # notification and not the state: this alarm still reads ALARM in the console
  # and on the dashboard while suppressed, so a change window hides the page
  # without hiding the outage.
  dynamic "actions_suppressor" {
    for_each = local.slo_suppression_enabled ? [var.slo_suppressor_alarm_name] : []

    content {
      alarm            = actions_suppressor.value
      wait_period      = var.slo_suppressor_wait_period_seconds
      extension_period = var.slo_suppressor_extension_period_seconds
    }
  }

  tags = { Name = "${local.name_prefix}-${each.value.canary_key}-slo-${each.value.tier_key}" }

  depends_on = [
    aws_sns_topic_policy.alerts,
    terraform_data.slo_guards,
  ]
}

# ---------------------------------------------------------------------------
# Latency
#
# Not a burn rate, on purpose. A slow response consumes no budget; a
# distribution is drifting, and the question is whether it has drifted for long
# enough to be a property of the service rather than of a deploy. So this asks
# for consecutive breaching periods instead.
#
# What the alarm measures depends entirely on whether a step name is known.
# Scoped to a step, Duration is that step's own elapsed time. Scoped to the
# canary, it is the whole run — and on a browser runtime the whole run begins by
# launching a browser, which routinely costs more than the endpoint being
# observed. The two numbers can differ by an order of magnitude, they are both
# called Duration, and nothing in the console distinguishes them, which is why
# there is an output naming every canary where the second one is in use.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "latency" {
  for_each = local.slo_latency_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-latency"
  alarm_description   = each.value.step_name == null ? "Run duration for canary ${each.value.canary_name} exceeded ${each.value.latency_objective_ms} ms. This is the whole run, browser startup included, so it is an upper bound on endpoint latency rather than a measure of it." : "Duration of step ${each.value.step_name} on canary ${each.value.canary_name} exceeded ${each.value.latency_objective_ms} ms."
  namespace           = "CloudWatchSynthetics"
  metric_name         = "Duration"
  dimensions          = each.value.dimensions
  period              = var.slo_latency_window_minutes * 60
  evaluation_periods  = var.slo_latency_evaluation_periods
  datapoints_to_alarm = coalesce(var.slo_latency_datapoints_to_alarm, var.slo_latency_evaluation_periods)
  comparison_operator = "GreaterThanThreshold"
  threshold           = each.value.latency_objective_ms

  # A percentile goes in extended_statistic and a named statistic in statistic;
  # the provider rejects both being set, so exactly one is non-null here.
  statistic          = local.slo_latency_is_percentile ? null : var.slo_latency_statistic
  extended_statistic = local.slo_latency_is_percentile ? var.slo_latency_statistic : null

  # Only meaningful, and only accepted by the API, alongside a percentile. It is
  # what stops a window holding a handful of runs from reporting its slowest one
  # as a p99: with too few samples the alarm is not evaluated at all, rather
  # than evaluated against a percentile the sample size cannot support.
  evaluate_low_sample_count_percentiles = local.slo_latency_is_percentile ? "ignore" : null

  # The opposite of the availability alarms, and the asymmetry is the point. No
  # runs means no latency to judge, and a canary that has gone silent is already
  # the availability alarm's business; treating silence as slowness here would
  # report the same outage twice under two different names.
  treat_missing_data = "notBreaching"

  alarm_actions = local.slo_alarm_actions
  ok_actions    = local.slo_alarm_actions

  tags = { Name = "${local.name_prefix}-${each.key}-latency" }

  depends_on = [
    aws_sns_topic_policy.alerts,
    terraform_data.slo_guards,
  ]
}

# ---------------------------------------------------------------------------
# Roll-up
#
# One light for "is any objective in trouble". It carries no actions and that is
# not an oversight: everything underneath it already notifies, and an OR over
# every tier would page a second time for the same event while discarding the
# severity the tiers exist to encode.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "slo_rollup" {
  count = var.create_slo_rollup_alarm && (length(local.slo_burn_windows) > 0 || length(local.slo_latency_alarms) > 0) ? 1 : 0

  alarm_name        = "${local.name_prefix}-slo-rollup"
  alarm_description = "In ALARM whenever any burn-rate tier or latency objective in this deployment is. Notifies nobody by design; the tier alarms do that."

  alarm_rule = join(" OR ", concat(
    [for key in sort(keys(local.slo_burn_windows)) : "ALARM(${jsonencode(aws_cloudwatch_composite_alarm.burn[key].alarm_name)})"],
    [for key in sort(keys(local.slo_latency_alarms)) : "ALARM(${jsonencode(aws_cloudwatch_metric_alarm.latency[key].alarm_name)})"],
  ))

  actions_enabled = false

  tags = { Name = "${local.name_prefix}-slo-rollup" }
}

# ---------------------------------------------------------------------------
# Plan-time guards
#
# Same construction as the canary and app-monitor guards: the guarded values are
# fed into the resource's input so that any change to them re-plans it and
# re-runs every condition. A terraform_data resource with static arguments is
# planned once and never again, and preconditions only run when Terraform plans
# an action for the resource, so a guard with an empty input quietly stops
# checking after the first apply.
# ---------------------------------------------------------------------------

resource "terraform_data" "slo_guards" {
  input = jsonencode({
    objective          = var.slo_objective
    budget_minutes     = local.slo_budget_minutes
    tiers              = var.slo_burn_rate_tiers
    canaries           = keys(local.slo_canaries)
    undersampled       = local.slo_undersampled_windows
    unmeasurable       = local.slo_canaries_without_a_measurable_tier
    empty_windows      = local.slo_windows_shorter_than_one_run
    unreachable        = local.slo_unreachable_tiers
    latency_statistic  = var.slo_latency_statistic
    latency_datapoints = var.slo_latency_datapoints_to_alarm
    create_topic       = var.create_alerts_topic
    topic_arn          = var.alerts_topic_arn
    create_key         = local.alerts_create_key
    supplied_key       = var.alerts_kms_key_arn
    key_is_aws_managed = local.alerts_key_is_aws_managed
    suppressor         = var.slo_suppressor_alarm_name
  })

  lifecycle {
    precondition {
      condition     = length(local.slo_unreachable_tiers) == 0
      error_message = "A burn-rate tier would need an error rate of 100% or more to fire, so its alarm can never leave OK no matter how badly the endpoint behaves — which is indistinguishable from an endpoint that never fails. Lower the tier's burn_rate, or raise slo_objective so the error budget it multiplies is smaller."
    }

    precondition {
      condition     = length(local.slo_windows_shorter_than_one_run) == 0
      error_message = "A burn-rate window is shorter than the interval between the canary's runs, so it can contain no data at all. Such an alarm sits in ALARM permanently when missing data is treated as breaching, and never leaves INSUFFICIENT_DATA when it is not; neither is an alert. Lengthen the window or speed up the canary's schedule."
    }

    precondition {
      condition     = length(local.slo_canaries_without_a_measurable_tier) == 0
      error_message = "Every burn-rate tier for a canary has a threshold finer than a single failed run can express, so all of them fire together on the first failure and the severities they encode are indistinguishable. A canary contributes one sample per run: a window holds window_minutes/interval_minutes of them, and the smallest error rate it can represent is the reciprocal of that. Either lower slo_objective so the thresholds are coarser, lengthen the long windows, or run the canary more often. Leaving one tier undersampled is fine and is reported in slo_windows_undersampled; leaving all of them undersampled makes the ladder decorative."
    }

    precondition {
      condition     = !local.alerts_key_is_aws_managed
      error_message = "alerts_kms_key_arn names an AWS-managed key (an alias under alias/aws/). The key policy of an AWS-managed key cannot be changed, so it can never grant CloudWatch permission to use it, and every alarm notification published to a topic encrypted with it is rejected by KMS after the alarm has already changed state — with no sign of the failure on the alarm. Use a customer-managed key, or leave create_alerts_kms_key true and let this configuration create one with the right policy."
    }

    precondition {
      condition     = var.create_alerts_topic || var.alerts_topic_arn != null
      error_message = "create_alerts_topic is false but alerts_topic_arn is null, so every alarm would be created with no action attached and no notification would reach anybody. Supply a topic, or let this configuration create one."
    }

    precondition {
      condition     = !var.create_alerts_topic || var.alerts_topic_arn == null
      error_message = "create_alerts_topic is true, but alerts_topic_arn is also set. That input is only read when this configuration does not create the topic, so leaving it set hides which topic alarms actually publish to."
    }

    precondition {
      condition     = !local.alerts_create_key || var.alerts_kms_key_arn == null
      error_message = "create_alerts_kms_key is true and alerts_kms_key_arn is also set. That input is only read when this configuration does not create the key, so leaving it set hides which key actually encrypts the alerts topic. Set create_alerts_kms_key to false to use the supplied key, or leave alerts_kms_key_arn null."
    }

    precondition {
      condition     = var.alerts_topic_arn == null || !endswith(coalesce(var.alerts_topic_arn, "x"), ".fifo")
      error_message = "alerts_topic_arn names a FIFO topic. CloudWatch cannot publish alarm notifications to a FIFO topic, so the alarms would be created successfully and deliver nothing."
    }

    precondition {
      condition     = var.slo_latency_datapoints_to_alarm == null || coalesce(var.slo_latency_datapoints_to_alarm, 1) <= var.slo_latency_evaluation_periods
      error_message = "slo_latency_datapoints_to_alarm is greater than slo_latency_evaluation_periods, so the alarm asks for more breaching periods than it evaluates and can never fire. Lower it, or evaluate more periods."
    }

    precondition {
      condition     = length(var.slo_burn_rate_tiers) > 0 || length(local.slo_canaries) == 0
      error_message = "Canaries exist but slo_burn_rate_tiers is empty, so no availability alarm would be created for any of them. Define at least one tier, or disable the canaries if they are not meant to be held to an objective."
    }

    precondition {
      condition     = length(local.canaries) == 0 || length(local.slo_canaries) > 0
      error_message = "Every canary is excluded from the objectives — each is either left stopped or disabled through slo_canary_overrides — so this deployment creates canaries that nothing alerts on. Start at least one canary, or re-enable one in slo_canary_overrides."
    }

    precondition {
      condition     = !local.slo_suppression_enabled || var.slo_suppressor_extension_period_seconds > 0
      error_message = "A suppressor alarm is configured with an extension period of zero, so suppression ends the instant the suppressor leaves ALARM. A change window almost always closes before the endpoint has recovered enough for the canary to succeed, so this pages on the way out of every deployment it was meant to cover."
    }
  }
}
