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
