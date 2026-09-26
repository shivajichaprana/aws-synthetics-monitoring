# Two locals blocks, on purpose.
#
# `common_tags` is consumed by the provider's `default_tags`, so it may only
# depend on input variables. Everything that reads a data source is kept apart
# from it and is only ever referenced by resources. Merging the two would work
# until the first data-source reference crept into the tag map, at which point
# the whole configuration would fail with a dependency cycle that points at the
# provider rather than at the tag.
locals {
  common_tags = merge(
    {
      Environment = var.environment
      Component   = "synthetic-monitoring"
      ManagedBy   = "terraform"
    },
    var.tags,
  )
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition

  # Every resource name derives from this. It is also the base a canary name is
  # built on, and canary names are capped at 21 characters by the service, which
  # is why both inputs that feed it are length-validated.
  name_prefix = "${var.name_prefix}-${var.environment}"

  # Longest name this configuration can produce for a canary, used by the
  # plan-time guard so the failure is a readable message rather than an API
  # error part-way through an apply.
  canary_name_limit = 21
}
