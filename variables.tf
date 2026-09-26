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
