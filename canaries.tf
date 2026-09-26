# ---------------------------------------------------------------------------
# Encryption key
#
# The key policy grants only the account root. Everything else is granted by
# IAM policy on the principal side, including the canary execution role. Naming
# the role in the key policy would be tighter on paper but would make the key
# depend on the role and the role depend on the key, which Terraform reports as
# a cycle rather than as the design mistake it is.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "artifacts_key" {
  count = var.create_kms_key ? 1 : 0

  statement {
    sid    = "EnableAccountAdministration"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

resource "aws_kms_key" "artifacts" {
  count = var.create_kms_key ? 1 : 0

  description             = "Encrypts synthetic monitoring artifacts for ${local.name_prefix}"
  deletion_window_in_days = var.kms_key_deletion_window_in_days
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.artifacts_key[0].json

  tags = { Name = "${local.name_prefix}-artifacts" }
}

resource "aws_kms_alias" "artifacts" {
  count = var.create_kms_key ? 1 : 0

  name          = "alias/${local.name_prefix}-artifacts"
  target_key_id = aws_kms_key.artifacts[0].key_id
}

# ---------------------------------------------------------------------------
# Artifacts bucket
#
# Canaries write a log file, screenshots and a HAR file per run. Screenshots are
# the bulk of it, which is why the lifecycle rule below is the cost lever named
# in the README rather than an afterthought.
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "artifacts" {
  bucket = "${local.name_prefix}-canary-artifacts-${local.account_id}"

  tags = { Name = "${local.name_prefix}-canary-artifacts" }
}

resource "aws_s3_bucket_ownership_controls" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    # ACLs are disabled outright. Synthetics does not need them, and with
    # BucketOwnerEnforced every object is owned by this account regardless of
    # which principal wrote it.
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = local.artifact_encryption_mode == "SSE_KMS" ? "aws:kms" : "AES256"
      kms_master_key_id = local.artifacts_kms_key_arn
    }

    # Without this, every object write is a separate KMS request. Canaries write
    # several objects per run, so the difference is measurable on the KMS bill.
    bucket_key_enabled = local.artifact_encryption_mode == "SSE_KMS"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id

  rule {
    id     = "expire-canary-artifacts"
    status = "Enabled"

    filter {
      prefix = "canary/"
    }

    expiration {
      days = var.artifact_retention_in_days
    }

    noncurrent_version_expiration {
      noncurrent_days = 7
    }
  }

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"

    # An empty filter applies the rule to the whole bucket. It is written out
    # rather than omitted because a rule with no filter at all is deprecated and
    # the provider warns on it.
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.artifacts]
}

data "aws_iam_policy_document" "artifacts_bucket" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.artifacts.arn,
      "${aws_s3_bucket.artifacts.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  # There is deliberately no "deny uploads without an encryption header"
  # statement. Bucket default encryption already applies the key to every
  # object, and Synthetics does not send x-amz-server-side-encryption on its
  # uploads — a statement denying requests that omit the header would encrypt
  # nothing extra and would break every canary run.
}

resource "aws_s3_bucket_policy" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  policy = data.aws_iam_policy_document.artifacts_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.artifacts]
}

# ---------------------------------------------------------------------------
# Execution role
#
# Canaries run as Lambda functions that the Synthetics service creates and
# manages, so the trust policy names the Lambda service, not Synthetics.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "canary_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    # No aws:SourceAccount or aws:SourceArn condition here. The Lambda service
    # does not reliably pass either on the AssumeRole call it makes for a
    # Synthetics-managed function, so a confused-deputy condition would not
    # tighten this trust so much as stop the canary from starting. The role is
    # constrained where it can be: its permissions reach one bucket prefix, one
    # log-group prefix and one metric namespace.
  }
}

data "aws_iam_policy_document" "canary" {
  statement {
    sid       = "WriteRunArtifacts"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.artifacts.arn}/canary/*"]
  }

  statement {
    sid       = "ResolveBucketRegion"
    effect    = "Allow"
    actions   = ["s3:GetBucketLocation"]
    resources = [aws_s3_bucket.artifacts.arn]
  }

  statement {
    sid    = "WriteRunLogs"
    effect = "Allow"

    actions = [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]

    # Synthetics creates its own log group per canary, named
    # /aws/lambda/cwsyn-<canary name>-<generated id>. The generated suffix is
    # why the group cannot be declared here and why CreateLogGroup has to be
    # granted; the prefix keeps the grant scoped to this deployment's canaries.
    resources = [
      "arn:${local.partition}:logs:${var.aws_region}:${local.account_id}:log-group:/aws/lambda/cwsyn-${local.name_prefix}-*",
      "arn:${local.partition}:logs:${var.aws_region}:${local.account_id}:log-group:/aws/lambda/cwsyn-${local.name_prefix}-*:*",
    ]
  }

  statement {
    sid    = "PublishCanaryMetrics"
    effect = "Allow"

    # PutMetricData takes no resource, so the namespace condition is the only
    # thing standing between this role and every metric in the account.
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = ["CloudWatchSynthetics"]
    }
  }

  dynamic "statement" {
    for_each = local.artifacts_kms_key_arn == null ? [] : [local.artifacts_kms_key_arn]

    content {
      sid    = "UseArtifactsKey"
      effect = "Allow"

      actions = [
        "kms:Decrypt",
        "kms:GenerateDataKey",
      ]

      resources = [statement.value]

      # Restricts the grant to key use that reaches KMS through S3, so the role
      # cannot decrypt anything else this key happens to protect.
      condition {
        test     = "StringEquals"
        variable = "kms:ViaService"
        values   = ["s3.${var.aws_region}.amazonaws.com"]
      }
    }
  }

  dynamic "statement" {
    for_each = local.any_active_tracing ? [1] : []

    content {
      sid    = "EmitTraceSegments"
      effect = "Allow"

      # X-Ray segment submission is not resource-scoped by the service; there is
      # no ARN to narrow this to.
      actions   = ["xray:PutTraceSegments"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = local.canary_in_vpc ? [1] : []

    content {
      sid    = "ManageCanaryNetworkInterfaces"
      effect = "Allow"

      # The service attaches and detaches an ENI per run. These three calls take
      # no resource condition that the service reliably honours here, which is
      # why they are granted only when VPC mode is actually switched on.
      actions = [
        "ec2:CreateNetworkInterface",
        "ec2:DescribeNetworkInterfaces",
        "ec2:DeleteNetworkInterface",
      ]

      resources = ["*"]
    }
  }
}

resource "aws_iam_role" "canary" {
  name                 = "${local.name_prefix}-canary-execution"
  description          = "Execution role assumed by the Lambda functions backing the synthetic canaries"
  assume_role_policy   = data.aws_iam_policy_document.canary_assume_role.json
  max_session_duration = 3600

  tags = { Name = "${local.name_prefix}-canary-execution" }
}

resource "aws_iam_role_policy" "canary" {
  name   = "canary-runtime"
  role   = aws_iam_role.canary.id
  policy = data.aws_iam_policy_document.canary.json
}

# ---------------------------------------------------------------------------
# Plan-time guards
#
# `input` is set to the values being guarded rather than left empty. A
# terraform_data resource with static arguments is planned once and then never
# again, and preconditions are only evaluated when Terraform plans an action for
# the resource — so an empty guard silently stops checking after the first
# apply. Feeding it the guarded values means any change to them re-plans the
# resource and re-runs every condition below.
# ---------------------------------------------------------------------------

resource "terraform_data" "canary_guards" {
  input = jsonencode({
    canary_names     = { for key, canary in local.canaries : key => canary.name }
    intervals        = local.canary_interval_minutes
    timeouts         = { for key, canary in local.canaries : key => canary.timeout_in_seconds }
    code_from_zip    = local.canary_code_from_zip
    code_from_s3     = local.canary_code_from_s3
    encryption_mode  = local.artifact_encryption_mode
    vpc_subnet_count = var.canary_vpc_config == null ? 0 : length(var.canary_vpc_config.subnet_ids)
  })

  lifecycle {
    precondition {
      condition     = length(local.canaries) == 0 || local.canary_code_from_zip || local.canary_code_from_s3
      error_message = "At least one canary is configured but canary_code has no source. Set canary_code.zip_path to a packaged bundle, or canary_code.s3_bucket together with canary_code.s3_key."
    }

    precondition {
      condition     = !(local.canary_code_from_zip && local.canary_code_from_s3)
      error_message = "canary_code names both a local zip and an S3 object. Synthetics accepts exactly one code source, so set either zip_path or s3_bucket plus s3_key, not both."
    }

    precondition {
      condition     = !(var.create_kms_key && var.kms_key_arn != null)
      error_message = "create_kms_key is true and kms_key_arn is also set. Set create_kms_key to false to use the supplied key, or leave kms_key_arn null to use the key this stack creates."
    }

    precondition {
      condition     = var.create_kms_key || var.kms_key_arn != null || var.artifact_retention_in_days <= 90
      error_message = "Artifacts would be kept for more than 90 days under SSE-S3 only. Either shorten artifact_retention_in_days or supply a customer-managed key, so that long-lived screenshots and HAR files are covered by a key you control."
    }

    precondition {
      condition     = var.canary_vpc_config == null ? true : length(var.canary_vpc_config.subnet_ids) > 0 && length(var.canary_vpc_config.security_group_ids) > 0
      error_message = "canary_vpc_config is set but one of its lists is empty. VPC mode needs at least one subnet and one security group."
    }

    precondition {
      condition = alltrue([
        for key, canary in local.canaries : length(canary.name) <= local.canary_name_limit
      ])
      error_message = "A canary name exceeds the 21-character limit the Synthetics service enforces. Set canary_name_prefix to something shorter, or give the canary a shorter name_suffix; name_prefix and environment can stay as they are."
    }

    precondition {
      condition = alltrue([
        for key, canary in local.canaries :
        local.canary_interval_minutes[key] == null ? true : canary.timeout_in_seconds <= local.canary_interval_minutes[key] * 60
      ])
      error_message = "A canary timeout is longer than the interval between its runs, so runs would overlap. Shorten timeout_in_seconds or slow the schedule."
    }

    precondition {
      condition = alltrue([
        for canary in values(local.canaries) :
        canary.active_tracing ? can(regex("^syn-nodejs-", canary.runtime_version)) : true
      ])
      error_message = "active_tracing is only supported on the Node.js Synthetics runtimes. Either switch the runtime or set active_tracing to false for that canary."
    }
  }
}

# ---------------------------------------------------------------------------
# Canaries
# ---------------------------------------------------------------------------

resource "aws_synthetics_canary" "this" {
  for_each = local.canaries

  name                 = each.value.name
  artifact_s3_location = "s3://${aws_s3_bucket.artifacts.bucket}/canary/${each.key}"
  execution_role_arn   = aws_iam_role.canary.arn
  handler              = each.value.handler
  runtime_version      = each.value.runtime_version
  start_canary         = each.value.start_canary

  # Without this, destroying a canary leaves its backing Lambda function behind
  # and the next apply with the same name collides with the orphan.
  delete_lambda = true

  success_retention_period = each.value.success_retention_in_days
  failure_retention_period = each.value.failure_retention_in_days

  # Exactly one of these pairs is non-null; the guard above rejects any other
  # combination before the service gets a chance to.
  zip_file   = local.canary_code_zip_path
  s3_bucket  = local.canary_code_s3_bucket
  s3_key     = local.canary_code_s3_key
  s3_version = local.canary_code_s3_object_version

  schedule {
    expression = each.value.schedule_expression

    # Zero means "keep running until stopped", which the API expresses by the
    # field being absent rather than by a literal 0.
    duration_in_seconds = each.value.schedule_duration_in_seconds == 0 ? null : each.value.schedule_duration_in_seconds
  }

  run_config {
    timeout_in_seconds    = each.value.timeout_in_seconds
    memory_in_mb          = each.value.memory_in_mb
    active_tracing        = each.value.active_tracing
    environment_variables = each.value.environment_variables
  }

  dynamic "vpc_config" {
    for_each = var.canary_vpc_config == null ? [] : [var.canary_vpc_config]

    content {
      subnet_ids         = vpc_config.value.subnet_ids
      security_group_ids = vpc_config.value.security_group_ids
    }
  }

  artifact_config {
    s3_encryption {
      encryption_mode = local.artifact_encryption_mode
      kms_key_arn     = local.artifacts_kms_key_arn
    }
  }

  tags = { Name = each.value.name }

  # The role policy and the bucket policy must both be in place before the first
  # run, otherwise the canary's opening run fails on a permission error and
  # reports a false outage.
  depends_on = [
    aws_iam_role_policy.canary,
    aws_s3_bucket_policy.artifacts,
    terraform_data.canary_guards,
  ]
}
