# ---------------------------------------------------------------------------
# Deployment identity
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "Region the monitoring stack is deployed into. Canaries observe endpoints from this region, so pick the region whose vantage point you care about."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like an AWS region code, for example us-east-1 or eu-central-1."
  }
}

variable "allowed_account_ids" {
  description = "Optional guard rail. When non-empty the provider refuses to act against any account outside this list, which is the cheapest protection against a misdirected apply. Leave empty to disable the check."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for id in var.allowed_account_ids : can(regex("^[0-9]{12}$", id))])
    error_message = "Every entry in allowed_account_ids must be a 12-digit AWS account id."
  }
}

variable "name_prefix" {
  description = "Short prefix for every resource name. Keep it genuinely short: a Synthetics canary name may not exceed 21 characters in total, and the suffix for each canary is appended to the prefix plus the environment."
  type        = string
  default     = "synth"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,11}$", var.name_prefix))
    error_message = "name_prefix must be 2-12 characters of lowercase letters, digits or hyphens, and must start with a letter or digit."
  }
}

variable "environment" {
  description = "Environment this deployment represents. Used in resource names and in the Environment tag."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z0-9]{2,8}$", var.environment))
    error_message = "environment must be 2-8 characters of lowercase letters or digits so that canary names stay inside the 21-character limit."
  }
}

variable "tags" {
  description = "Extra tags merged into the provider default tags. Keys set here win over the built-in ones."
  type        = map(string)
  default     = {}
}

# ---------------------------------------------------------------------------
# Retention and encryption defaults shared by every feature in this repository
# ---------------------------------------------------------------------------

variable "artifact_retention_in_days" {
  description = "How long canary artifacts (logs, screenshots, HAR files) are kept in the artifacts bucket before the lifecycle rule expires them. Screenshots dominate the cost, so this is the main storage lever."
  type        = number
  default     = 30

  validation {
    condition     = var.artifact_retention_in_days >= 1 && var.artifact_retention_in_days <= 3650
    error_message = "artifact_retention_in_days must be between 1 and 3650."
  }
}

variable "create_kms_key" {
  description = "Create a customer-managed key for artifact and log encryption. Set to false and supply kms_key_arn to reuse an existing key, for example a shared observability key."
  type        = bool
  default     = true
}

variable "kms_key_arn" {
  description = "ARN of an existing customer-managed key to encrypt artifacts with. Required when create_kms_key is false; ignored otherwise. Leave null to fall back to SSE-S3 when no key is created."
  type        = string
  default     = null

  validation {
    condition     = var.kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:", var.kms_key_arn))
    error_message = "kms_key_arn must be a KMS key ARN when set."
  }
}

variable "kms_key_deletion_window_in_days" {
  description = "Waiting period before a scheduled deletion of the created key actually destroys it. Only read when create_kms_key is true."
  type        = number
  default     = 30

  validation {
    condition     = var.kms_key_deletion_window_in_days >= 7 && var.kms_key_deletion_window_in_days <= 30
    error_message = "kms_key_deletion_window_in_days must be between 7 and 30, which is the range KMS accepts."
  }
}

# ---------------------------------------------------------------------------
# Canaries
#
# Two canaries are first-class here because they answer different questions.
# The API canary asserts a contract: status, shape, latency. The heartbeat
# canary asserts reachability at a cadence fast enough to be useful for an
# availability objective. Supplying an endpoint is what brings each one into
# existence; with neither set, a plan creates only the shared artifacts bucket,
# its key, and the execution role.
# ---------------------------------------------------------------------------

variable "canary_runtime_version" {
  description = "Synthetics runtime every canary uses unless it overrides the value. Runtimes are region-scoped and are retired on a published schedule, so this is deliberately an input rather than a constant: check the currently offered list for your region before pinning it."
  type        = string
  default     = "syn-nodejs-puppeteer-9.1"

  validation {
    condition     = can(regex("^syn-(nodejs-puppeteer|nodejs-playwright|python-selenium)-[0-9]+\\.[0-9]+$", var.canary_runtime_version))
    error_message = "canary_runtime_version must look like syn-nodejs-puppeteer-N.N, syn-nodejs-playwright-N.N or syn-python-selenium-N.N."
  }
}

variable "canary_name_prefix" {
  description = "Overrides the prefix used for canary names only. The service caps a canary name at 21 characters, and the default prefix already carries both name_prefix and environment, so a descriptive deployment name can leave no room for the suffix. Set this to something short when the plan-time budget guard refuses a name."
  type        = string
  default     = null

  validation {
    condition     = var.canary_name_prefix == null || can(regex("^[a-z0-9][a-z0-9_-]{0,16}$", coalesce(var.canary_name_prefix, "x")))
    error_message = "canary_name_prefix must be 1-17 characters of lowercase letters, digits, hyphens or underscores, and must start with a letter or digit."
  }
}

variable "api_endpoint" {
  description = "Full URL the API canary calls, for example https://api.example.com/v1/health. Leave null and no API canary is created."
  type        = string
  default     = null

  validation {
    condition     = var.api_endpoint == null || can(regex("^https?://", var.api_endpoint))
    error_message = "api_endpoint must be an absolute http or https URL."
  }
}

variable "api_expected_status" {
  description = "Status code the API canary treats as healthy. Exposed as an environment variable to the canary script so the assertion lives with the check rather than in the infrastructure."
  type        = number
  default     = 200

  validation {
    condition     = var.api_expected_status >= 100 && var.api_expected_status <= 599
    error_message = "api_expected_status must be a valid HTTP status code."
  }
}

variable "api_canary_schedule_expression" {
  description = "Cadence for the API canary. Five minutes is the usual compromise: frequent enough to catch a deploy going wrong, cheap enough to leave on everywhere."
  type        = string
  default     = "rate(5 minutes)"

  validation {
    condition     = can(regex("^(rate\\([0-9]+ (minute|minutes|hour|hours|day|days)\\)|cron\\(.+\\))$", var.api_canary_schedule_expression))
    error_message = "api_canary_schedule_expression must be a rate(...) or cron(...) expression."
  }
}

variable "heartbeat_endpoint" {
  description = "URL the heartbeat canary loads. Point it at the thinnest endpoint that still proves the stack is serving. Leave null and no heartbeat canary is created."
  type        = string
  default     = null

  validation {
    condition     = var.heartbeat_endpoint == null || can(regex("^https?://", var.heartbeat_endpoint))
    error_message = "heartbeat_endpoint must be an absolute http or https URL."
  }
}

variable "heartbeat_canary_schedule_expression" {
  description = "Cadence for the heartbeat canary. One minute is the floor Synthetics accepts and the cadence an availability objective usually needs."
  type        = string
  default     = "rate(1 minute)"

  validation {
    condition     = can(regex("^(rate\\([0-9]+ (minute|minutes|hour|hours|day|days)\\)|cron\\(.+\\))$", var.heartbeat_canary_schedule_expression))
    error_message = "heartbeat_canary_schedule_expression must be a rate(...) or cron(...) expression."
  }
}

variable "canaries" {
  description = "Additional canaries, keyed by short name. A key that collides with a built-in one (api, heartbeat) replaces it wholesale, which is the escape hatch when the opinionated defaults do not fit."
  type = map(object({
    handler                      = string
    name_suffix                  = optional(string)
    runtime_version              = optional(string)
    schedule_expression          = optional(string, "rate(5 minutes)")
    schedule_duration_in_seconds = optional(number, 0)
    timeout_in_seconds           = optional(number, 60)
    memory_in_mb                 = optional(number, 1024)
    active_tracing               = optional(bool, true)
    start_canary                 = optional(bool, true)
    success_retention_in_days    = optional(number, 31)
    failure_retention_in_days    = optional(number, 31)
    environment_variables        = optional(map(string), {})
  }))
  default = {}

  validation {
    condition     = alltrue([for key in keys(var.canaries) : can(regex("^[a-z0-9][a-z0-9_-]*$", key))])
    error_message = "Canary keys must be lowercase letters, digits, hyphens or underscores, and must start with a letter or digit, because the key names the canary's artifact prefix."
  }

  validation {
    condition     = alltrue([for c in values(var.canaries) : c.name_suffix == null || can(regex("^[a-z0-9][a-z0-9_-]*$", coalesce(c.name_suffix, "x")))])
    error_message = "name_suffix must be lowercase letters, digits, hyphens or underscores, and must start with a letter or digit. Leave it unset to use the map key."
  }

  validation {
    condition     = alltrue([for c in values(var.canaries) : can(regex("^[A-Za-z0-9_.-]+\\.handler$", c.handler))])
    error_message = "Each handler must be <scriptFileName>.handler, which is the only form the Synthetics runtimes load."
  }

  validation {
    condition     = alltrue([for c in values(var.canaries) : c.memory_in_mb >= 960 && c.memory_in_mb <= 3008 && c.memory_in_mb % 64 == 0])
    error_message = "memory_in_mb must be between 960 and 3008 and a multiple of 64."
  }

  validation {
    condition     = alltrue([for c in values(var.canaries) : c.timeout_in_seconds >= 3 && c.timeout_in_seconds <= 840])
    error_message = "timeout_in_seconds must be between 3 and 840. It must also be no longer than the run frequency, which the plan-time guard checks."
  }

  validation {
    condition = alltrue([
      for c in values(var.canaries) :
      c.success_retention_in_days >= 1 && c.success_retention_in_days <= 1024 &&
      c.failure_retention_in_days >= 1 && c.failure_retention_in_days <= 1024
    ])
    error_message = "Canary retention periods must be between 1 and 1024 days."
  }
}

variable "canary_code" {
  description = "Where the packaged canary bundle comes from. Set zip_path for a locally built archive, or s3_bucket with s3_key for one already uploaded. Required as soon as at least one canary exists; the plan-time guard refuses an ambiguous or missing source."
  type = object({
    zip_path          = optional(string)
    s3_bucket         = optional(string)
    s3_key            = optional(string)
    s3_object_version = optional(string)
  })
  default = null
}

variable "canary_vpc_config" {
  description = "Run every canary inside a VPC instead of from the Synthetics-managed network. Only do this for endpoints that are not reachable from the internet: a canary inside your VPC no longer proves anything about the path a real client takes."
  type = object({
    subnet_ids         = list(string)
    security_group_ids = list(string)
  })
  default = null
}

# ---------------------------------------------------------------------------
# Real user monitoring
#
# Setting rum_domain is what brings the app monitor and its guest identity into
# existence, in the same way that setting an endpoint brings a canary into
# existence. Left null, none of the inputs below are read and nothing in rum.tf
# is created.
# ---------------------------------------------------------------------------

variable "rum_domain" {
  description = "Host the web client is served from, for example www.example.com. A single leading wildcard label is accepted to cover subdomains. Host only: no scheme, no port, no path. Leave null and no real user monitoring resources are created."
  type        = string
  default     = null

  validation {
    condition     = var.rum_domain == null || can(regex("^(\\*\\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,}$", coalesce(var.rum_domain, "x.example")))
    error_message = "rum_domain must be a bare lowercase host such as www.example.com or *.example.com, with no scheme, port or path."
  }
}

variable "rum_app_monitor_name" {
  description = "Overrides the app monitor name, which otherwise derives from the shared prefix with a -web suffix. Unlike a canary name this one is not budget-constrained, so something descriptive is fine here."
  type        = string
  default     = null

  validation {
    condition     = var.rum_app_monitor_name == null || can(regex("^[A-Za-z0-9._/#-]{1,255}$", coalesce(var.rum_app_monitor_name, "x")))
    error_message = "rum_app_monitor_name must be 1-255 characters of letters, digits, dot, underscore, slash, hash or hyphen."
  }
}

variable "rum_session_sample_rate" {
  description = "Fraction of browser sessions the web client reports on, from 0 to 1. This is the main cost lever for real user monitoring, because every ingested event is billed. A tenth is usually enough to see a regression in aggregate, and too little to characterise a rare error."
  type        = number
  default     = 0.1

  validation {
    condition     = var.rum_session_sample_rate >= 0 && var.rum_session_sample_rate <= 1
    error_message = "rum_session_sample_rate must be between 0 and 1 inclusive."
  }
}

variable "rum_telemetries" {
  description = "Signals the web client collects: errors for uncaught JavaScript exceptions, performance for load timings and web vitals, http for XHR and fetch outcomes. Order is not significant, because the list is sorted before use."
  type        = list(string)
  default     = ["errors", "performance", "http"]

  validation {
    condition     = alltrue([for signal in var.rum_telemetries : contains(["errors", "performance", "http"], signal)])
    error_message = "rum_telemetries may only contain errors, performance or http."
  }
}

variable "rum_allow_cookies" {
  description = "Let the web client set its own first-party cookie so it can recognise a returning session. Without it every page view arrives as a new session, which inflates session counts and makes any multi-page view meaningless."
  type        = bool
  default     = true
}

variable "rum_enable_xray" {
  description = "Trace XHR and fetch calls made by the page into X-Ray, so a slow render can be followed into the service behind it. Requires the http telemetry, which the plan-time guard checks."
  type        = bool
  default     = true
}

variable "rum_cw_log_enabled" {
  description = "Also write every ingested event into a CloudWatch Logs group. This is the only way to query an individual session after the fact, and it is the largest cost this configuration can incur, so it is off by default. The service creates and owns that log group, which is why its retention is not managed here."
  type        = bool
  default     = false
}

variable "rum_custom_events_enabled" {
  description = "Allow the page to record application-defined events. Off by default, because a custom event emitted from a loop in the page is ingested and billed exactly like a useful one."
  type        = bool
  default     = false
}

variable "rum_included_pages" {
  description = "Page URL patterns to monitor, to the exclusion of every page not named. Leave empty to monitor the whole site. Mutually exclusive with rum_excluded_pages."
  type        = list(string)
  default     = []
}

variable "rum_excluded_pages" {
  description = "Page URL patterns to leave unmonitored, typically authenticated or payment paths whose URLs carry identifiers better left uningested. Mutually exclusive with rum_included_pages."
  type        = list(string)
  default     = []
}

variable "rum_favorite_pages" {
  description = "Page URL patterns pinned to the top of the app monitor's page list in the console. Cosmetic: it changes what is easy to find, not what is collected."
  type        = list(string)
  default     = []
}

variable "rum_create_identity_pool" {
  description = "Create the unauthenticated Cognito identity pool and guest role the web client uses. Set to false to reuse an existing pair, for example one shared by several app monitors, and supply both rum_identity_pool_id and rum_guest_role_arn."
  type        = bool
  default     = true
}

variable "rum_identity_pool_id" {
  description = "Identity pool the web client obtains guest credentials from. Only read when rum_create_identity_pool is false."
  type        = string
  default     = null

  validation {
    condition     = var.rum_identity_pool_id == null || can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]:[0-9a-f-]{36}$", coalesce(var.rum_identity_pool_id, "us-east-1:00000000-0000-0000-0000-000000000000")))
    error_message = "rum_identity_pool_id must look like us-east-1:00000000-0000-0000-0000-000000000000."
  }
}

variable "rum_guest_role_arn" {
  description = "Role unauthenticated browser sessions assume. It must already permit rum:PutRumEvents on this app monitor, which nothing here can verify. Only read when rum_create_identity_pool is false."
  type        = string
  default     = null

  validation {
    condition     = var.rum_guest_role_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:role/", coalesce(var.rum_guest_role_arn, "arn:aws:iam::123456789012:role/x")))
    error_message = "rum_guest_role_arn must be an IAM role ARN when set."
  }
}

# ---------------------------------------------------------------------------
# Service level objectives
#
# A canary is a probe, not a request log. That distinction governs every input
# below, and it is worth stating plainly before the first one: burn-rate
# alerting was designed for request-based availability, where a window contains
# tens of thousands of events and an error rate of 0.1% is a real number. A
# canary on a five-minute schedule contributes twelve samples an hour, so the
# finest error rate it can express over an hour is one failure in twelve, or
# 8.3%. Any threshold below that granularity is reached by a single failed run.
#
# Nothing here hides that. The objective is deliberately defaulted to something
# a canary can actually measure, the plan-time guards refuse the configurations
# where the arithmetic is nonsense, and the outputs name every window whose
# threshold is finer than its own sampling.
# ---------------------------------------------------------------------------

variable "slo_objective" {
  description = "Availability objective every canary is held to, as a fraction. The default is 0.995 rather than the more fashionable 0.999 because of sampling, not ambition: a five-minute canary cannot distinguish a 0.1% error rate from a single failed run over any window short enough to alert on. Raise it only alongside a faster canary schedule, and read slo_windows_undersampled afterwards."
  type        = number
  default     = 0.995

  validation {
    condition     = var.slo_objective > 0 && var.slo_objective < 1
    error_message = "slo_objective must be a fraction strictly between 0 and 1, for example 0.995 for 99.5%."
  }
}

variable "slo_window_days" {
  description = "Length of the error-budget period, in days. This does not size any alarm window; it is what the budget arithmetic and the dashboard header are expressed against, so that a burn rate has a period to burn through."
  type        = number
  default     = 30

  validation {
    condition     = var.slo_window_days >= 1 && var.slo_window_days <= 365
    error_message = "slo_window_days must be between 1 and 365."
  }
}

variable "slo_burn_rate_tiers" {
  description = "Burn-rate tiers, keyed by name. Each tier becomes two metric alarms — one over the long window, one over the short — and one composite alarm that fires only while BOTH are breaching. The long window is what makes the tier precise; the short one is what makes it stop alerting promptly once the endpoint recovers. The defaults are the widely used 14.4-over-an-hour and 6-over-six-hours pair, which consume 2% and 5% of a 30-day budget respectively."
  type = map(object({
    burn_rate           = number
    long_window_minutes = number
    # Kept short on purpose. Its job is recovery latency, not precision: over a
    # window this brief almost no canary produces enough runs for the threshold
    # to mean anything other than "at least one failure", which is why the
    # undersampling report below only considers long windows.
    short_window_minutes = number
    description          = optional(string)
  }))

  default = {
    fast = {
      burn_rate            = 14.4
      long_window_minutes  = 60
      short_window_minutes = 5
      description          = "Consumes 2% of a 30-day budget in an hour. Page on this."
    }
    slow = {
      burn_rate            = 6
      long_window_minutes  = 360
      short_window_minutes = 30
      description          = "Consumes 5% of a 30-day budget in six hours. A ticket, not a page."
    }
  }

  validation {
    condition     = alltrue([for key in keys(var.slo_burn_rate_tiers) : can(regex("^[a-z0-9][a-z0-9-]{0,23}$", key))])
    error_message = "Burn-rate tier keys must be 1-24 characters of lowercase letters, digits or hyphens, and must start with a letter or digit, because the key appears in every alarm name derived from the tier."
  }

  validation {
    condition     = alltrue([for tier in values(var.slo_burn_rate_tiers) : tier.burn_rate > 0])
    error_message = "Every burn_rate must be greater than zero. A burn rate of zero would set the alarm threshold at the objective itself, which alerts on the budget being touched at all rather than on it being spent too fast."
  }

  validation {
    condition = alltrue([
      for tier in values(var.slo_burn_rate_tiers) :
      tier.long_window_minutes >= 1 && tier.long_window_minutes <= 1440 &&
      tier.short_window_minutes >= 1 && tier.short_window_minutes <= 1440
    ])
    error_message = "Burn-rate windows must be between 1 and 1440 minutes. The ceiling is the 86400-second maximum CloudWatch accepts for an alarm period: a window longer than a day cannot be one alarm period, and splitting it across several periods asks a different question — every day breaching, rather than the multi-day average breaching."
  }

  validation {
    condition     = alltrue([for tier in values(var.slo_burn_rate_tiers) : tier.description == null || length(coalesce(tier.description, "")) <= 300])
    error_message = "A tier description is longer than 300 characters. It is appended to the composite alarm's own description, and CloudWatch caps an alarm description at 1024 characters in total."
  }

  validation {
    condition     = alltrue([for tier in values(var.slo_burn_rate_tiers) : tier.short_window_minutes < tier.long_window_minutes])
    error_message = "Each tier's short_window_minutes must be shorter than its long_window_minutes. The pair exists so that a long, precise window decides whether to alert and a short one decides when to stop; equal windows make the second alarm redundant."
  }
}

variable "slo_latency_objective_ms" {
  description = "Latency budget for a canary run, in milliseconds. Compared against the Synthetics Duration metric, which is scoped to a single step where a step name is known and to the whole run otherwise — and a whole-run duration on a browser runtime is dominated by browser startup, so read slo_latency_measures_harness before trusting the number."
  type        = number
  default     = 2000

  validation {
    condition     = var.slo_latency_objective_ms >= 1 && var.slo_latency_objective_ms <= 840000
    error_message = "slo_latency_objective_ms must be between 1 and 840000, the latter being the longest run the Synthetics service permits."
  }
}

variable "slo_latency_statistic" {
  description = "Statistic the latency alarm evaluates. A percentile is the useful choice and is also the one that interacts with sampling: over a window holding twelve runs, p99 is simply the slowest of the twelve. Named statistics (Average, Maximum, Minimum, Sum) are accepted too."
  type        = string
  default     = "p90"

  validation {
    condition     = can(regex("^(Average|Maximum|Minimum|Sum|p(100|[0-9]{1,2}(\\.[0-9]{1,2})?))$", var.slo_latency_statistic))
    error_message = "slo_latency_statistic must be Average, Maximum, Minimum, Sum, or a percentile such as p90 or p99.9."
  }
}

variable "slo_latency_window_minutes" {
  description = "Length of each latency evaluation period, in minutes."
  type        = number
  default     = 15

  validation {
    condition     = var.slo_latency_window_minutes >= 1 && var.slo_latency_window_minutes <= 1440
    error_message = "slo_latency_window_minutes must be between 1 and 1440, the latter being the 86400-second alarm-period ceiling."
  }
}

variable "slo_latency_evaluation_periods" {
  description = "How many consecutive latency periods are considered. Latency deliberately uses consecutive periods rather than a burn rate: there is no error budget being spent, only a distribution drifting, and a single slow window is usually a deploy rather than a regression."
  type        = number
  default     = 2

  validation {
    condition     = var.slo_latency_evaluation_periods >= 1 && var.slo_latency_evaluation_periods <= 24
    error_message = "slo_latency_evaluation_periods must be between 1 and 24."
  }
}

variable "slo_latency_datapoints_to_alarm" {
  description = "How many of the evaluated latency periods must breach. Leave null to require all of them. Setting it below slo_latency_evaluation_periods gives the M-of-N behaviour that tolerates one slow window without ignoring a pattern of them."
  type        = number
  default     = null

  validation {
    condition     = var.slo_latency_datapoints_to_alarm == null || (coalesce(var.slo_latency_datapoints_to_alarm, 1) >= 1 && coalesce(var.slo_latency_datapoints_to_alarm, 1) <= 24)
    error_message = "slo_latency_datapoints_to_alarm must be between 1 and 24 when set."
  }
}

variable "slo_canary_overrides" {
  description = "Per-canary overrides, keyed by the same key the canary is declared under. latency_step_name is the one worth knowing about: naming the step scopes the Duration metric to that step instead of the whole run, which is the difference between measuring the endpoint and measuring the canary's browser starting up. The shipped API and heartbeat canaries have their step names filled in already."
  type = map(object({
    enabled              = optional(bool, true)
    objective            = optional(number)
    latency_objective_ms = optional(number)
    latency_step_name    = optional(string)
  }))
  default = {}

  validation {
    condition = alltrue([
      for override in values(var.slo_canary_overrides) :
      override.objective == null || (coalesce(override.objective, 0.5) > 0 && coalesce(override.objective, 0.5) < 1)
    ])
    error_message = "Every objective override must be a fraction strictly between 0 and 1."
  }

  validation {
    condition = alltrue([
      for override in values(var.slo_canary_overrides) :
      override.latency_objective_ms == null || (coalesce(override.latency_objective_ms, 1) >= 1 && coalesce(override.latency_objective_ms, 1) <= 840000)
    ])
    error_message = "Every latency_objective_ms override must be between 1 and 840000."
  }

  validation {
    condition = alltrue([
      for override in values(var.slo_canary_overrides) :
      override.latency_step_name == null || can(regex("^[A-Za-z0-9_.-]{1,255}$", coalesce(override.latency_step_name, "x")))
    ])
    error_message = "latency_step_name must be 1-255 characters of letters, digits, dot, underscore or hyphen, and must match the step name the canary script passes to executeStep or executeHttpStep exactly — the dimension is not created if it does not."
  }
}

variable "slo_treat_missing_data_as_breaching" {
  description = "Treat an availability window with no canary runs in it as a breach. This is on by default, and it is the single most consequential setting here: with it off, a canary that has stopped reporting — deleted, throttled, or failing before it can publish a metric — leaves its alarm in INSUFFICIENT_DATA, which pages nobody and looks calm on a dashboard. The cost of leaving it on is that a canary you deliberately stop starts alerting, which is why alarms are only built for canaries that are actually started."
  type        = bool
  default     = true
}

variable "slo_suppressor_alarm_name" {
  description = "Name of an existing alarm that suppresses SLO notifications while it is itself in ALARM — the supported way to hold pages during a planned change window without deleting the alarms that would otherwise fire. Nothing here can verify the alarm exists, and a suppressor naming an alarm that does not exist suppresses nothing. Suppression stops actions only: the composite alarm still shows ALARM, so the dashboard keeps telling the truth."
  type        = string
  default     = null

  validation {
    condition     = var.slo_suppressor_alarm_name == null || can(regex("^[^\\s].{0,254}$", coalesce(var.slo_suppressor_alarm_name, "x")))
    error_message = "slo_suppressor_alarm_name must be a non-empty alarm name of at most 255 characters when set."
  }
}

variable "slo_suppressor_wait_period_seconds" {
  description = "How long a composite alarm waits for the suppressor to report before deciding it is not suppressed. Too short and a suppressor that has not yet evaluated fails to hold the first notification of a change window."
  type        = number
  default     = 120

  validation {
    condition     = var.slo_suppressor_wait_period_seconds >= 0 && var.slo_suppressor_wait_period_seconds <= 3600
    error_message = "slo_suppressor_wait_period_seconds must be between 0 and 3600."
  }
}

variable "slo_suppressor_extension_period_seconds" {
  description = "How long suppression persists after the suppressor leaves ALARM. This covers the gap where a change window has closed but the endpoint has not yet recovered enough for the canary to succeed, which would otherwise page on the way out of every deployment."
  type        = number
  default     = 120

  validation {
    condition     = var.slo_suppressor_extension_period_seconds >= 0 && var.slo_suppressor_extension_period_seconds <= 3600
    error_message = "slo_suppressor_extension_period_seconds must be between 0 and 3600."
  }
}

variable "create_slo_rollup_alarm" {
  description = "Create one composite alarm that is in ALARM whenever any burn-rate tier or latency alarm is. It carries no actions by design — everything that pages already pages — and exists so that a dashboard and a console list can answer 'is any objective in trouble' with one light instead of a count."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Alert delivery
# ---------------------------------------------------------------------------

variable "create_alerts_topic" {
  description = "Create the SNS topic alarm notifications are published to. Set to false and supply alerts_topic_arn to route into an existing on-call pipeline instead."
  type        = bool
  default     = true
}

variable "alerts_topic_arn" {
  description = "Existing SNS topic to publish alarm notifications to. Required when create_alerts_topic is false. Nothing here can check that its access policy admits CloudWatch or that its encryption key does; both are the usual reasons an alarm changes state and nobody hears about it."
  type        = string
  default     = null

  validation {
    condition     = var.alerts_topic_arn == null || can(regex("^arn:aws[a-z-]*:sns:[a-z0-9-]+:[0-9]{12}:[A-Za-z0-9_-]+(\\.fifo)?$", coalesce(var.alerts_topic_arn, "arn:aws:sns:us-east-1:123456789012:x")))
    error_message = "alerts_topic_arn must be an SNS topic ARN when set. A FIFO ARN is accepted by this shape check and refused by the plan-time guard instead, which can say why."
  }
}

variable "create_alerts_kms_key" {
  description = "Create a customer-managed key for the alerts topic. This is separate from the artifacts key on purpose, because it needs a key policy the artifacts key must not have: a grant to the CloudWatch service principal. An AWS-managed key cannot be given that grant at all, which is why alias/aws/sns is the wrong answer here and the guard refuses it outright."
  type        = bool
  default     = true
}

variable "alerts_kms_key_arn" {
  description = "Existing customer-managed key to encrypt the alerts topic with. Its key policy must permit cloudwatch.amazonaws.com to call kms:GenerateDataKey* and kms:Decrypt, or every alarm notification is rejected by KMS after the alarm has already changed state — a failure with no trace on the alarm itself. Leave null with create_alerts_kms_key false for an unencrypted topic."
  type        = string
  default     = null

  validation {
    condition     = var.alerts_kms_key_arn == null || can(regex("^arn:aws[a-z-]*:kms:[a-z0-9-]+:[0-9]{12}:(key/[a-f0-9-]+|alias/.+)$", coalesce(var.alerts_kms_key_arn, "arn:aws:kms:us-east-1:123456789012:key/x")))
    error_message = "alerts_kms_key_arn must be a KMS key or alias ARN when set."
  }
}

variable "alerts_email_addresses" {
  description = "Addresses subscribed to the alerts topic. Every subscription starts unconfirmed: the address holder must click a link, and until they do the subscription exists, plans clean, and delivers nothing. Treat this as a convenience for a small team, not as the routing for an on-call rotation."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for address in var.alerts_email_addresses : can(regex("^[^@\\s]+@[^@\\s.]+(\\.[^@\\s.]+)+$", address))])
    error_message = "Every entry in alerts_email_addresses must look like an email address."
  }
}

# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

variable "create_dashboard" {
  description = "Create the CloudWatch dashboard summarising every objective, the canaries behind it, and the alarms derived from it."
  type        = bool
  default     = true
}

variable "dashboard_name" {
  description = "Overrides the dashboard name, which otherwise derives from the shared prefix. Dashboard names admit only letters, digits, hyphens and underscores — notably not dots, which is easy to trip over when a name is built from a hostname."
  type        = string
  default     = null

  validation {
    condition     = var.dashboard_name == null || can(regex("^[A-Za-z0-9_-]{1,255}$", coalesce(var.dashboard_name, "x")))
    error_message = "dashboard_name must be 1-255 characters of letters, digits, hyphens or underscores. Dots are not accepted by the service."
  }
}

variable "dashboard_period_seconds" {
  description = "Bucket width for the dashboard's time-series widgets, in seconds. The single-value tiles ignore this and aggregate across whatever range the dashboard is being viewed over, so that the headline success rate always describes the period on screen."
  type        = number
  default     = 300

  validation {
    condition     = var.dashboard_period_seconds >= 60 && var.dashboard_period_seconds <= 86400 && var.dashboard_period_seconds % 60 == 0
    error_message = "dashboard_period_seconds must be between 60 and 86400 and a multiple of 60."
  }
}
