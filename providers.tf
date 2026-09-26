# Provider wiring.
#
# `default_tags` is deliberately fed from `local.common_tags`, which is built
# from input variables ONLY. A provider configuration cannot depend on a data
# source, because the data source needs a configured provider to be read in the
# first place; referencing `data.aws_caller_identity` here would create a cycle
# that Terraform reports as an unhelpful "Cycle" error at plan time. Locals that
# do read data sources live in `locals.tf` under a separate block and are only
# ever consumed by resources.
provider "aws" {
  region = var.aws_region

  # Empty list means "no restriction". Normalising it to null keeps the
  # behaviour explicit instead of relying on how the provider treats [].
  allowed_account_ids = length(var.allowed_account_ids) > 0 ? var.allowed_account_ids : null

  default_tags {
    tags = local.common_tags
  }
}
