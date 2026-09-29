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

# Real user monitoring.
#
# Gated the same way the canaries are: naming the domain to be observed is what
# creates the app monitor and the guest identity it needs.
locals {
  rum_enabled = var.rum_domain != null

  # An app monitor name may run to 255 characters and is not subject to the
  # 21-character budget a canary name is, so the descriptive prefix is used in
  # full rather than abbreviated.
  rum_app_monitor_name = coalesce(var.rum_app_monitor_name, "${local.name_prefix}-web")

  # Either this configuration owns both halves of the guest identity or it owns
  # neither. A pool created here paired with somebody else's role would
  # authorise nothing: the trust policy is scoped to a specific pool id.
  rum_create_identity = local.rum_enabled && var.rum_create_identity_pool

  rum_identity_pool_id = local.rum_create_identity ? one(aws_cognito_identity_pool.rum[*].id) : var.rum_identity_pool_id
  rum_guest_role_arn   = local.rum_create_identity ? one(aws_iam_role.rum_guest[*].arn) : var.rum_guest_role_arn

  # Sorted and de-duplicated before use. The API returns this list in its own
  # order, so passing it through unsorted makes an otherwise identical plan show
  # a diff whenever the list is rewritten in a different order in tfvars.
  rum_telemetries = sort(distinct(var.rum_telemetries))

  rum_all_telemetries     = ["errors", "http", "performance"]
  rum_telemetries_omitted = sort(setsubtract(local.rum_all_telemetries, local.rum_telemetries))
}

# The values the browser snippet is initialised with, gathered in one place so
# that wiring up a front end does not mean reading six fields out of the
# console. Nothing here is a secret: an unauthenticated identity pool id is
# public by construction, which is the whole reason the guest role is scoped to
# a single action.
locals {
  rum_web_client_config = !local.rum_enabled ? null : {
    applicationId     = one(aws_rum_app_monitor.this[*].app_monitor_id)
    applicationRegion = var.aws_region
    identityPoolId    = local.rum_identity_pool_id
    guestRoleArn      = local.rum_guest_role_arn
    sessionSampleRate = var.rum_session_sample_rate
    telemetries       = local.rum_telemetries
    allowCookies      = var.rum_allow_cookies
    enableXRay        = var.rum_enable_xray
  }
}

# Service level objectives.
#
# Two ideas are kept apart here. An objective is a promise about a canary's
# success rate over a budget period. A burn-rate tier is a way of noticing that
# the promise is being broken faster than the period can absorb. The first is
# per canary; the second is per canary and tier, which is why the maps below are
# built in that order rather than as one pass.
locals {
  slo_error_budget = 1 - var.slo_objective

  # Allowed unsuccessful minutes in one budget period. Stated in minutes rather
  # than as a percentage because a percentage is what people nod along to and
  # minutes are what they argue about.
  slo_budget_minutes = local.slo_error_budget * var.slo_window_days * 24 * 60

  # Step names for the canaries this repository ships. Naming the step scopes
  # the Duration metric to the HTTP exchange instead of the whole run; the map
  # keys match the built-in canary keys, and anything else is named through
  # slo_canary_overrides.
  slo_builtin_latency_steps = {
    api       = "contract"
    heartbeat = "load"
  }
}

# Objectives per canary.
#
# Only canaries that are actually started are represented. A stopped canary
# publishes no metrics, and with missing data treated as a breach — which is the
# default, and the reason a silent canary is not mistaken for a healthy one — an
# alarm over a stopped canary would alert continuously about a deliberate
# operator decision.
locals {
  slo_canary_included = {
    for key, canary in local.canaries :
    key => canary.start_canary && (contains(keys(var.slo_canary_overrides), key) ? var.slo_canary_overrides[key].enabled : true)
  }

  slo_canary_objective = {
    for key in keys(local.canaries) :
    key => contains(keys(var.slo_canary_overrides), key) ? coalesce(var.slo_canary_overrides[key].objective, var.slo_objective) : var.slo_objective
  }

  # Resolved one level at a time rather than inline, because every read of an
  # override has to be guarded by the same key check and nesting three of them
  # in one expression is how a null slips through. `&&` would not help: both
  # operands are evaluated, so a key check on its left does not protect an
  # attribute read on its right.
  slo_override_latency_step = {
    for key in keys(local.canaries) :
    key => contains(keys(var.slo_canary_overrides), key) ? var.slo_canary_overrides[key].latency_step_name : null
  }

  slo_canary_latency_objective = {
    for key in keys(local.canaries) :
    key => contains(keys(var.slo_canary_overrides), key) ? coalesce(var.slo_canary_overrides[key].latency_objective_ms, var.slo_latency_objective_ms) : var.slo_latency_objective_ms
  }

  slo_canaries = {
    for key, canary in local.canaries :
    key => {
      name             = canary.name
      objective        = local.slo_canary_objective[key]
      error_budget     = 1 - local.slo_canary_objective[key]
      interval_minutes = local.canary_interval_minutes[key]

      latency_objective_ms = local.slo_canary_latency_objective[key]

      # A step name from an override wins; otherwise the built-in map answers for
      # the canaries shipped here; otherwise there is none, and the latency alarm
      # falls back to the whole run.
      latency_step_name = local.slo_override_latency_step[key] != null ? local.slo_override_latency_step[key] : lookup(local.slo_builtin_latency_steps, key, null)
    }
    if local.slo_canary_included[key]
  }

  # Canaries excluded from every objective, and why, so the reason is available
  # as data rather than by comparing two lists by eye.
  slo_canaries_excluded_stopped = sort([
    for key, canary in local.canaries : key if !canary.start_canary
  ])

  slo_canaries_excluded_by_override = sort([
    for key, canary in local.canaries :
    key if canary.start_canary && contains(keys(var.slo_canary_overrides), key) && !var.slo_canary_overrides[key].enabled
  ])
}

# Burn-rate windows.
#
# One entry per canary and tier. Each entry becomes two metric alarms, over the
# long and the short window, and one composite alarm that is in ALARM only while
# both of them are.
locals {
  slo_burn_windows = {
    for pair in setproduct(keys(local.slo_canaries), keys(var.slo_burn_rate_tiers)) :
    "${pair[0]}-${pair[1]}" => {
      canary_key  = pair[0]
      canary_name = local.slo_canaries[pair[0]].name
      tier_key    = pair[1]
      burn_rate   = var.slo_burn_rate_tiers[pair[1]].burn_rate
      tier_note   = var.slo_burn_rate_tiers[pair[1]].description

      error_budget     = local.slo_canaries[pair[0]].error_budget
      interval_minutes = local.slo_canaries[pair[0]].interval_minutes

      long_window_minutes  = var.slo_burn_rate_tiers[pair[1]].long_window_minutes
      short_window_minutes = var.slo_burn_rate_tiers[pair[1]].short_window_minutes

      # The alarm compares SuccessPercent, so the burn-rate threshold on the
      # error rate is expressed as its complement. A tier that burns 14.4 times
      # the budget of a 99.5% objective is breaching at a 7.2% error rate, which
      # is a success rate below 92.8.
      error_threshold_percent   = var.slo_burn_rate_tiers[pair[1]].burn_rate * local.slo_canaries[pair[0]].error_budget * 100
      success_threshold_percent = 100 - (var.slo_burn_rate_tiers[pair[1]].burn_rate * local.slo_canaries[pair[0]].error_budget * 100)
    }
  }

  # Runs the long window can hold, and therefore the smallest non-zero error
  # rate the signal is capable of expressing over it. A cron-scheduled canary
  # yields null for both, because its interval cannot be read from the
  # expression; those windows are left out of every sampling judgement below
  # rather than guessed at.
  slo_long_window_runs = {
    for key, window in local.slo_burn_windows :
    key => window.interval_minutes == null ? null : floor(window.long_window_minutes / window.interval_minutes)
  }

  slo_short_window_runs = {
    for key, window in local.slo_burn_windows :
    key => window.interval_minutes == null ? null : floor(window.short_window_minutes / window.interval_minutes)
  }

  slo_long_window_min_error_percent = {
    for key, runs in local.slo_long_window_runs :
    key => runs == null ? null : (runs == 0 ? 100 : 100 / runs)
  }

  # Windows whose threshold is finer than one failed run. The alarm is still
  # created and still correct; what it cannot do is tell a burn from a blip,
  # because the smallest error rate the window can represent already exceeds the
  # threshold. Reported rather than refused: for a heartbeat, "one failure
  # alerts" is frequently the intended behaviour.
  slo_undersampled_windows = sort([
    for key, window in local.slo_burn_windows :
    key
    if local.slo_long_window_min_error_percent[key] != null &&
    window.error_threshold_percent < local.slo_long_window_min_error_percent[key]
  ])

  slo_sampling_unknown_windows = sort([
    for key, runs in local.slo_long_window_runs : key if runs == null
  ])

  # Canaries for which every tier is undersampled. Here the ladder has stopped
  # being a ladder: each tier fires on the same single failed run, so the
  # severities are indistinguishable and the arithmetic is decoration. This is
  # what the plan-time guard refuses.
  slo_canaries_without_a_measurable_tier = sort([
    for canary_key in keys(local.slo_canaries) :
    canary_key
    if length(var.slo_burn_rate_tiers) > 0 && alltrue([
      for tier_key in keys(var.slo_burn_rate_tiers) :
      local.slo_long_window_min_error_percent["${canary_key}-${tier_key}"] == null ? false :
      local.slo_burn_windows["${canary_key}-${tier_key}"].error_threshold_percent < local.slo_long_window_min_error_percent["${canary_key}-${tier_key}"]
    ])
  ])

  # Windows too short to contain a single run. These are a different failure from
  # undersampling: the window holds no data at all, so with missing data treated
  # as breaching the alarm is in ALARM permanently and with it left missing the
  # alarm never leaves INSUFFICIENT_DATA. Neither is an alert.
  slo_windows_shorter_than_one_run = sort(distinct(concat(
    [for key, runs in local.slo_long_window_runs : key if runs != null && runs < 1],
    [for key, runs in local.slo_short_window_runs : key if runs != null && runs < 1],
  )))

  # Tiers whose threshold is at or beyond a 100% error rate. Such an alarm has a
  # success threshold of zero or less and can never fire, which looks exactly
  # like an endpoint that never fails.
  slo_unreachable_tiers = sort([
    for key, window in local.slo_burn_windows : key if window.success_threshold_percent <= 0
  ])
}

# Latency.
#
# Deliberately not a burn rate. There is no budget being consumed by a slow
# response, only a distribution moving, so the alarm asks whether several
# consecutive windows were slow rather than how fast something is being spent.
locals {
  slo_latency_is_percentile = can(regex("^p", var.slo_latency_statistic))

  slo_latency_alarms = {
    for key, canary in local.slo_canaries :
    key => {
      canary_name          = canary.name
      step_name            = canary.latency_step_name
      latency_objective_ms = canary.latency_objective_ms

      # With a step name the metric is that step's duration. Without one it is
      # the whole run, which on a browser runtime includes launching the browser
      # — typically a second or more that has nothing to do with the endpoint.
      # Built by merging rather than by a conditional returning one shape or the
      # other. Two object values with different attribute sets have no common
      # object type, so a conditional between them is resolved by falling back to
      # a map — which happens to be right here and is not something to depend on
      # elsewhere in this repository, where the attributes are not all strings.
      dimensions = merge(
        { CanaryName = canary.name },
        canary.latency_step_name == null ? {} : { StepName = canary.latency_step_name },
      )
    }
  }

  # Canaries whose latency figure describes the canary rather than the endpoint.
  slo_latency_measures_harness = sort([
    for key, canary in local.slo_canaries : key if canary.latency_step_name == null
  ])
}

# Alert delivery.
locals {
  alerts_topic_arn = var.create_alerts_topic ? one(aws_sns_topic.alerts[*].arn) : var.alerts_topic_arn

  # A key is only created when this configuration also owns the topic it would
  # encrypt. Creating one for somebody else's topic would leave a customer-managed
  # key that costs money, encrypts nothing, and — worse — reads on a plan as
  # though the external topic were now protected by it.
  alerts_create_key = var.create_alerts_topic && var.create_alerts_kms_key

  alerts_kms_key_arn = local.alerts_create_key ? one(aws_kms_key.alerts[*].arn) : var.alerts_kms_key_arn

  # An AWS-managed key cannot carry a grant to a service principal, so a topic
  # encrypted with one silently rejects every alarm notification. Detected by
  # shape: an AWS-managed key is only ever reachable by an alias ARN under
  # alias/aws/.
  alerts_key_is_aws_managed = var.alerts_kms_key_arn == null ? false : can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:alias/aws/", var.alerts_kms_key_arn))

  slo_alarm_actions = local.alerts_topic_arn == null ? [] : [local.alerts_topic_arn]

  slo_suppression_enabled = var.slo_suppressor_alarm_name != null
}

# Dashboard.
locals {
  dashboard_name = coalesce(var.dashboard_name, "${local.name_prefix}-slo")

  # Widget rows are laid out arithmetically rather than by hand so that adding a
  # canary cannot overlap two widgets. The grid is 24 columns wide; anything
  # wider wraps and silently rearranges the row.
  dashboard_canary_keys = sort(keys(local.slo_canaries))

  dashboard_slo_percent = format("%.3f", var.slo_objective * 100)
}
