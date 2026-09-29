output "aws_region" {
  description = "Region the monitoring stack was deployed into."
  value       = var.aws_region
}

output "name_prefix" {
  description = "Resolved prefix every resource name in this deployment is built from."
  value       = local.name_prefix
}

output "account_guard_enabled" {
  description = "Whether the provider was constrained to an explicit account list. False means an apply against the wrong account is only prevented by your credentials."
  value       = length(var.allowed_account_ids) > 0
}

# ---------------------------------------------------------------------------
# Canaries
# ---------------------------------------------------------------------------

output "artifacts_bucket_name" {
  description = "Bucket canary run artifacts are written to, under the canary/<name>/ prefix."
  value       = aws_s3_bucket.artifacts.bucket
}

output "artifacts_bucket_arn" {
  description = "ARN of the canary artifacts bucket."
  value       = aws_s3_bucket.artifacts.arn
}

output "artifacts_kms_key_arn" {
  description = "Key encrypting canary artifacts. Null means artifacts are protected by SSE-S3 with an AWS-owned key instead of one you control."
  value       = local.artifacts_kms_key_arn
}

output "artifact_encryption_mode" {
  description = "Encryption mode the canaries were configured with, SSE_KMS or SSE_S3."
  value       = local.artifact_encryption_mode
}

output "canary_execution_role_arn" {
  description = "Role the Synthetics-managed Lambda functions assume."
  value       = aws_iam_role.canary.arn
}

output "canary_names" {
  description = "Canary key to the name the service knows it by."
  value       = { for key, created in aws_synthetics_canary.this : key => created.name }
}

output "canary_arns" {
  description = "Canary key to ARN."
  value       = { for key, created in aws_synthetics_canary.this : key => created.arn }
}

output "canary_schedules" {
  description = "Canary key to the schedule expression it runs on, so a review can see the cadence without opening the console."
  value       = { for key, canary in local.canaries : key => canary.schedule_expression }
}

# --- What is deliberately not the case -------------------------------------
# These outputs exist so that `terraform output` reads as a short audit rather
# than a list of identifiers. Each one names an assumption that does not hold.

output "canaries_not_started" {
  description = "Canaries created but left stopped. A stopped canary produces no metrics, so any alarm built on it reports insufficient data rather than a failure."
  value       = sort([for key, canary in local.canaries : key if !canary.start_canary])
}

output "canaries_without_tracing" {
  description = "Canaries running without X-Ray active tracing. For these, a failed run tells you the check failed but not which downstream call was slow."
  value       = sort([for key, canary in local.canaries : key if !canary.active_tracing])
}

output "canaries_on_cron_schedule" {
  description = "Canaries whose schedule is a cron expression. The run interval cannot be derived from those, so the timeout-versus-interval guard does not cover them."
  value       = sort([for key, interval in local.canary_interval_minutes : key if interval == null])
}

output "canaries_run_inside_vpc" {
  description = "True when canaries run inside your VPC. In that mode they no longer prove anything about the path an internet client takes to the endpoint."
  value       = local.canary_in_vpc
}

output "canary_count" {
  description = "Number of canaries this deployment manages. Zero means the artifacts bucket, key and role exist but nothing is being observed."
  value       = length(local.canaries)
}

# ---------------------------------------------------------------------------
# Real user monitoring
# ---------------------------------------------------------------------------

output "rum_enabled" {
  description = "Whether an app monitor exists. False means no real user telemetry is being collected and the canaries are the only signal this deployment produces."
  value       = local.rum_enabled
}

output "rum_app_monitor_name" {
  description = "Name of the CloudWatch RUM app monitor, or null when real user monitoring is disabled."
  value       = one(aws_rum_app_monitor.this[*].name)
}

output "rum_app_monitor_id" {
  description = "Application id the browser snippet is initialised with."
  value       = one(aws_rum_app_monitor.this[*].app_monitor_id)
}

output "rum_app_monitor_arn" {
  description = "ARN of the app monitor, for wiring dashboards and alarms to it."
  value       = one(aws_rum_app_monitor.this[*].arn)
}

output "rum_identity_pool_id" {
  description = "Identity pool the web client obtains guest credentials from, whether created here or supplied."
  value       = local.rum_identity_pool_id
}

output "rum_guest_role_arn" {
  description = "Role unauthenticated browser sessions assume in order to publish events."
  value       = local.rum_guest_role_arn
}

output "rum_cw_log_group" {
  description = "Log group the service writes raw events to. Null unless log mirroring is enabled, which it is not by default."
  value       = one(aws_rum_app_monitor.this[*].cw_log_group)
}

output "rum_web_client_config" {
  description = "Everything the browser snippet needs, gathered so that wiring up a front end is not a console exercise. Null when real user monitoring is disabled. Contains no secret: an unauthenticated identity pool id is public by construction."
  value       = local.rum_web_client_config
}

# --- What is deliberately not the case -------------------------------------

output "rum_sessions_not_sampled" {
  description = "Fraction of browser sessions never observed. Everything derived from real user monitoring is an estimate scaled up from the remainder, which matters most for errors that are already rare."
  value       = local.rum_enabled ? 1 - var.rum_session_sample_rate : 1
}

output "rum_telemetries_omitted" {
  description = "Signals the app monitor is not collecting. A signal missing from the console because it was never enabled looks identical to one that is healthy."
  value       = local.rum_telemetries_omitted
}

output "rum_events_not_retained_in_logs" {
  description = "True when raw events are not mirrored to CloudWatch Logs. In that mode the aggregates are all there is, and an individual session cannot be queried or reconstructed after the fact."
  value       = local.rum_enabled && !var.rum_cw_log_enabled
}

output "rum_log_group_retention_unmanaged" {
  description = "True when log mirroring is on. The service creates and owns that log group, so its retention is whatever the account default is — by default, never expiring — and nothing in this configuration changes it."
  value       = local.rum_enabled && var.rum_cw_log_enabled
}

output "rum_guest_credentials_are_public" {
  description = "True whenever real user monitoring is enabled. The identity pool admits unauthenticated identities by design, so anyone who can load the page can publish events to this app monitor. Treat the data as observation, never as an authority for billing or access decisions."
  value       = local.rum_enabled
}

output "rum_pages_filtered" {
  description = "True when an include or exclude list narrows what is monitored, in which case a page with no data may have been filtered out rather than never visited."
  value       = local.rum_enabled && (length(var.rum_included_pages) > 0 || length(var.rum_excluded_pages) > 0)
}

# ---------------------------------------------------------------------------
# Objectives
# ---------------------------------------------------------------------------

output "slo_objective" {
  description = "Availability objective every canary is held to, unless overridden for it individually."
  value       = var.slo_objective
}

output "slo_error_budget_minutes" {
  description = "Unsuccessful probing the objective permits in one budget period, in minutes. This is the figure a burn rate is a multiple of."
  value       = local.slo_budget_minutes
}

output "slo_canaries" {
  description = "Canary key to the objective and latency budget it is actually held to, after per-canary overrides."
  value = {
    for key, canary in local.slo_canaries :
    key => {
      objective            = canary.objective
      latency_objective_ms = canary.latency_objective_ms
      latency_step_name    = canary.latency_step_name
      interval_minutes     = canary.interval_minutes
    }
  }
}

output "slo_burn_rate_thresholds" {
  description = "Canary and tier to the success rate below which that tier breaches, so the alerting arithmetic can be reviewed without reading an alarm definition."
  value = {
    for key, window in local.slo_burn_windows :
    key => {
      burn_rate                 = window.burn_rate
      long_window_minutes       = window.long_window_minutes
      short_window_minutes      = window.short_window_minutes
      success_threshold_percent = window.success_threshold_percent
      runs_in_long_window       = local.slo_long_window_runs[key]
      smallest_error_percent    = local.slo_long_window_min_error_percent[key]
    }
  }
}

output "slo_alarm_names" {
  description = "Canary and tier to the composite alarm that notifies for it. These are the alarms to route; the metric alarms underneath them have actions disabled."
  value       = { for key, created in aws_cloudwatch_composite_alarm.burn : key => created.alarm_name }
}

output "slo_latency_alarm_names" {
  description = "Canary key to its latency alarm name."
  value       = { for key, created in aws_cloudwatch_metric_alarm.latency : key => created.alarm_name }
}

output "slo_rollup_alarm_name" {
  description = "Single alarm that is in ALARM whenever any objective is. Null when it was not created."
  value       = one(aws_cloudwatch_composite_alarm.slo_rollup[*].alarm_name)
}

output "alerts_topic_arn" {
  description = "Topic alarm notifications are published to, whether created here or supplied."
  value       = local.alerts_topic_arn
}

output "alerts_kms_key_arn" {
  description = "Key encrypting the alerts topic. Null means the topic is unencrypted."
  value       = local.alerts_kms_key_arn
}

output "dashboard_name" {
  description = "Name of the objectives dashboard, or null when it was not created."
  value       = one(aws_cloudwatch_dashboard.slo[*].dashboard_name)
}

output "dashboard_url" {
  description = "Console address of the objectives dashboard, or null when it was not created."
  value       = length(aws_cloudwatch_dashboard.slo) == 0 ? null : "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${local.dashboard_name}"
}

# --- What is deliberately not the case -------------------------------------

output "slo_windows_undersampled" {
  description = "Canary and tier pairs whose threshold is finer than a single failed run. For each of these the alarm cannot distinguish a sustained burn from one bad run, so its severity tier means less than its name suggests. Read this before trusting a tiered escalation."
  value       = local.slo_undersampled_windows
}

output "slo_windows_sampling_unknown" {
  description = "Canary and tier pairs whose canary runs on a cron schedule. The run interval cannot be derived from a cron expression, so neither the sampling floor above nor the timeout-versus-interval guard covers them."
  value       = local.slo_sampling_unknown_windows
}

output "slo_latency_measures_harness" {
  description = "Canaries whose latency alarm reads the whole run rather than one step. On a browser runtime the whole run begins by launching a browser, so these figures are an upper bound on endpoint latency and not a measurement of it. Set latency_step_name in slo_canary_overrides to the step name the script uses."
  value       = local.slo_latency_measures_harness
}

output "slo_canaries_without_objectives" {
  description = "Canaries that exist but are held to no objective, with the reason. A canary listed here produces artifacts and metrics that nothing alerts on."
  value = {
    stopped              = local.slo_canaries_excluded_stopped
    disabled_by_override = local.slo_canaries_excluded_by_override
  }
}

output "slo_silence_not_treated_as_failure" {
  description = "True when a window with no canary runs in it is not treated as a breach. In that mode a canary that has stopped reporting leaves its alarm in INSUFFICIENT_DATA, which notifies nobody and looks calm on a dashboard."
  value       = !var.slo_treat_missing_data_as_breaching
}

output "slo_notifications_can_be_suppressed" {
  description = "True when a suppressor alarm is configured, in which case a page can be withheld while that alarm is in ALARM. Nothing here can verify the suppressor exists, and one naming an alarm that does not exist suppresses nothing. Suppression hides the notification, never the alarm state."
  value       = local.slo_suppression_enabled
}

output "slo_rollup_alarm_notifies_nobody" {
  description = "True whenever the roll-up alarm exists. It has actions disabled by design, so it is a light to look at and never a page: everything it summarises already notifies on its own."
  value       = length(aws_cloudwatch_composite_alarm.slo_rollup) > 0
}

output "alerts_topic_unencrypted" {
  description = "True when alarm notifications transit an unencrypted topic. Alarm bodies name the resource and the threshold breached, which is more than it looks like when the topic fans out beyond this account."
  value       = var.create_alerts_topic && local.alerts_kms_key_arn == null
}

output "alerts_subscriptions_pending_confirmation" {
  description = "Email addresses subscribed here. Every one of them starts unconfirmed and delivers nothing until its owner clicks the link AWS sends, and a successful apply is not evidence that anybody has. This does not shrink as subscriptions are confirmed; confirmation is not visible to Terraform."
  value       = var.create_alerts_topic ? sort(var.alerts_email_addresses) : []
}

output "slo_delivery_unverifiable" {
  description = "True when alarms publish to a topic this configuration did not create. Neither that topic's access policy nor its encryption key can be checked from here, and both are ordinary reasons an alarm changes state and nobody hears about it."
  value       = !var.create_alerts_topic && var.alerts_topic_arn != null
}

output "slo_scope_is_one_region" {
  description = "Always true. Alarms, dashboards and canary metrics are regional, so this deployment says nothing about how the same endpoint behaves from anywhere else. A single-region objective met in full is consistent with an endpoint unreachable from another continent."
  value       = true
}

output "slo_measures_probes_not_users" {
  description = "Always true. Every availability figure here is the success rate of a synthetic probe on a fixed schedule, not of real requests. It is unweighted by traffic, blind to any failure that needs a real session to reproduce, and equally blind to the difference between a timeout and a 500 — both are simply an unsuccessful run."
  value       = true
}
