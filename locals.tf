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

  # The service caps a canary name at 21 characters. The guard in canaries.tf
  # checks the assembled name against this so the failure is a readable message
  # rather than an API error part-way through an apply.
  canary_name_limit = 21
}

# Canary composition.
#
# The two built-in canaries are written out in full rather than derived from a
# defaults map, because `optional(...)` defaults only apply to a variable's type
# constraint — a locally constructed object gets no defaults filled in. Writing
# every attribute also keeps both sides of the `merge` below type-identical,
# which is what lets Terraform unify them into one map instead of failing with
# an inconsistent-object-type error.
locals {
  builtin_canaries = merge(
    var.api_endpoint == null ? {} : {
      api = {
        handler                      = "api-canary.handler"
        name_suffix                  = "api"
        runtime_version              = null
        schedule_expression          = var.api_canary_schedule_expression
        schedule_duration_in_seconds = 0
        timeout_in_seconds           = 60
        memory_in_mb                 = 1024
        active_tracing               = true
        start_canary                 = true
        success_retention_in_days    = 31
        failure_retention_in_days    = 31
        environment_variables = {
          TARGET_URL      = var.api_endpoint
          EXPECTED_STATUS = tostring(var.api_expected_status)
        }
      }
    },
    var.heartbeat_endpoint == null ? {} : {
      heartbeat = {
        handler = "heartbeat-canary.handler"
        # Abbreviated on purpose. The name budget is 21 characters in total, and
        # spending nine of them on the word "heartbeat" is what pushes an
        # otherwise ordinary prefix over the limit. The map key stays spelled out
        # because it names the artifact prefix, where there is no such cap.
        name_suffix                  = "hb"
        runtime_version              = null
        schedule_expression          = var.heartbeat_canary_schedule_expression
        schedule_duration_in_seconds = 0
        # A heartbeat that has not answered in 20 seconds is already a problem;
        # a longer timeout only delays the alarm.
        timeout_in_seconds        = 20
        memory_in_mb              = 960
        active_tracing            = true
        start_canary              = true
        success_retention_in_days = 31
        failure_retention_in_days = 31
        environment_variables = {
          TARGET_URL = var.heartbeat_endpoint
        }
      }
    },
  )

  # Canary names are built from their own prefix, which defaults to the shared
  # one. Keeping it separate is what lets a descriptive deployment name coexist
  # with the 21-character cap the service imposes on canary names alone.
  canary_name_prefix = coalesce(var.canary_name_prefix, local.name_prefix)

  # A key supplied in var.canaries replaces the built-in of the same name.
  canaries = {
    for key, canary in merge(local.builtin_canaries, var.canaries) :
    key => merge(canary, {
      name            = "${local.canary_name_prefix}-${coalesce(canary.name_suffix, key)}"
      runtime_version = coalesce(canary.runtime_version, var.canary_runtime_version)
    })
  }

  # Minutes between runs, parsed out of the schedule expression so the guard can
  # compare it against the timeout. Only rate(N minutes) can be read this way;
  # a cron expression yields null and is left to the operator.
  canary_interval_minutes = {
    for key, canary in local.canaries :
    key => can(regex("^rate\\(([0-9]+) minutes?\\)$", canary.schedule_expression)) ? tonumber(regex("^rate\\(([0-9]+) minutes?\\)$", canary.schedule_expression)[0]) : null
  }
}

# Encryption and code-source resolution.
#
# `var.canary_code` is a nullable object, so every attribute read goes through a
# conditional rather than `&&`. Terraform's `&&` evaluates both operands, so
# `var.canary_code != null && var.canary_code.zip_path != null` still faults on a
# null object. The conditional operator evaluates only the branch it takes, which
# is the property being relied on here.
locals {
  artifacts_kms_key_arn = var.create_kms_key ? aws_kms_key.artifacts[0].arn : var.kms_key_arn

  artifact_encryption_mode = var.create_kms_key || var.kms_key_arn != null ? "SSE_KMS" : "SSE_S3"

  canary_code_zip_path          = var.canary_code == null ? null : var.canary_code.zip_path
  canary_code_s3_bucket         = var.canary_code == null ? null : var.canary_code.s3_bucket
  canary_code_s3_key            = var.canary_code == null ? null : var.canary_code.s3_key
  canary_code_s3_object_version = var.canary_code == null ? null : var.canary_code.s3_object_version

  canary_code_from_zip = local.canary_code_zip_path != null
  canary_code_from_s3  = local.canary_code_s3_bucket != null && local.canary_code_s3_key != null

  # True when at least one canary asks for X-Ray, which is the only condition
  # under which the execution role needs the tracing permission.
  any_active_tracing = anytrue([for canary in values(local.canaries) : canary.active_tracing])

  canary_in_vpc = var.canary_vpc_config != null
}
