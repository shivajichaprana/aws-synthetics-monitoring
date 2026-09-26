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
