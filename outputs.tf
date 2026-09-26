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
