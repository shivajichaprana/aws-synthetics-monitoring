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
