# ---------------------------------------------------------------------------
# CloudWatch RUM
#
# The canaries in this repository answer one question: is the endpoint
# responding, from a machine in this region, right now. Real user monitoring
# answers a different one: what did the last several thousand browsers actually
# experience. Those answers diverge routinely — a canary that passes from
# us-east-1 says nothing about a third-party tag blocking first paint on a phone
# three time zones away, and nothing at all about the error a browser threw
# after the document had already loaded.
#
# The whole feature is gated on var.rum_domain, following the convention the
# canaries use: naming the thing to be observed is what creates the resources
# that observe it. With it left null, nothing in this file is created.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Guest identity
#
# The web client runs in a browser nobody has signed into, so it needs a
# credential that is safe to hand to the public. An unauthenticated Cognito
# identity pool is the supported way to issue one: the page exchanges nothing
# for a short-lived credential scoped to a single action on a single app
# monitor.
#
# Two conditions on the trust policy carry all of the weight here. Without the
# `aud` condition, any Cognito identity pool in any AWS account could assume
# this role — the classic confused-deputy shape, and easy to miss because the
# role works perfectly well without it. Without the `amr` condition, an
# authenticated identity from this same pool could also assume the guest role,
# which quietly widens whatever the authenticated role was scoped to.
# ---------------------------------------------------------------------------

resource "aws_cognito_identity_pool" "rum" {
  count = local.rum_create_identity ? 1 : 0

  identity_pool_name               = "${local.name_prefix}-rum"
  allow_unauthenticated_identities = true

  # The classic flow lets a client call GetOpenIdToken and then perform its own
  # AssumeRoleWithWebIdentity, naming whichever role ARN it likes. The enhanced
  # flow returns credentials for the role this pool is mapped to and nothing
  # else, which is the property being relied on below.
  allow_classic_flow = false

  tags = { Name = "${local.name_prefix}-rum" }
}

data "aws_iam_policy_document" "rum_guest_assume" {
  count = local.rum_create_identity ? 1 : 0

  statement {
    sid     = "AssumeAsUnauthenticatedCognitoIdentity"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.rum[0].id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

resource "aws_iam_role" "rum_guest" {
  count = local.rum_create_identity ? 1 : 0

  name               = "${local.name_prefix}-rum-guest"
  description        = "Assumed by unauthenticated browser sessions to publish real user monitoring events"
  assume_role_policy = data.aws_iam_policy_document.rum_guest_assume[0].json

  tags = { Name = "${local.name_prefix}-rum-guest" }
}

# One action, one app monitor. PutRumEvents is the only call the web client
# makes, and every permission granted here is reachable by anyone who can open
# the page, so there is no such thing as a convenient extra action.
#
# This document reads the app monitor's ARN while the app monitor reads the
# role's ARN, which looks like a dependency cycle and is not one: the role
# resource itself depends on neither, so Terraform orders role, then app
# monitor, then this policy. The visible consequence is a brief window after the
# first apply during which the monitor exists and the guest role cannot yet
# write to it. Events from page loads in that window are rejected and lost,
# which is worth knowing before concluding that a fresh deployment is broken.
data "aws_iam_policy_document" "rum_guest" {
  count = local.rum_create_identity ? 1 : 0

  statement {
    sid       = "PublishRumEvents"
    effect    = "Allow"
    actions   = ["rum:PutRumEvents"]
    resources = [aws_rum_app_monitor.this[0].arn]
  }
}

resource "aws_iam_role_policy" "rum_guest" {
  count = local.rum_create_identity ? 1 : 0

  name   = "${local.name_prefix}-rum-put-events"
  role   = aws_iam_role.rum_guest[0].id
  policy = data.aws_iam_policy_document.rum_guest[0].json
}

resource "aws_cognito_identity_pool_roles_attachment" "rum" {
  count = local.rum_create_identity ? 1 : 0

  identity_pool_id = aws_cognito_identity_pool.rum[0].id

  # Only the unauthenticated role is mapped. Adding an authenticated mapping
  # here would mean this stack owns the sign-in story for the whole pool, which
  # belongs to the application, not to its monitoring.
  roles = {
    unauthenticated = aws_iam_role.rum_guest[0].arn
  }
}

# ---------------------------------------------------------------------------
# App monitor
# ---------------------------------------------------------------------------

resource "aws_rum_app_monitor" "this" {
  count = local.rum_enabled ? 1 : 0

  name   = local.rum_app_monitor_name
  domain = var.rum_domain

  # Off by default. Mirroring writes every ingested event into a CloudWatch Logs
  # group as well, which is the only way to query an individual session after
  # the fact — and, at a realistic sample rate on a busy site, the largest cost
  # this configuration can produce. The guard below refuses the combination of
  # heavy sampling and mirroring rather than letting it be discovered on a bill.
  cw_log_enabled = var.rum_cw_log_enabled

  app_monitor_configuration {
    # Without a first-party cookie the client cannot recognise its own session,
    # so every page view arrives as a new one. Session counts inflate, and any
    # view that spans more than a single page stops meaning anything. Turning
    # this off is a legitimate privacy decision; it is not a free one.
    allow_cookies = var.rum_allow_cookies

    # This instruments the page's own XHR and fetch calls, so a slow render can
    # be followed into the service that caused it. It only records anything
    # alongside the http telemetry, which the guard below enforces.
    enable_xray = var.rum_enable_xray

    session_sample_rate = var.rum_session_sample_rate
    telemetries         = local.rum_telemetries

    guest_role_arn   = local.rum_guest_role_arn
    identity_pool_id = local.rum_identity_pool_id

    # Page filters are matched against the page URL. An include list is
    # exhaustive — everything not named is dropped — which is why the guard
    # refuses to accept both lists at once.
    excluded_pages = var.rum_excluded_pages
    included_pages = var.rum_included_pages
    favorite_pages = var.rum_favorite_pages
  }

  dynamic "custom_events" {
    for_each = var.rum_custom_events_enabled ? [true] : []

    content {
      status = "ENABLED"
    }
  }

  tags = { Name = local.rum_app_monitor_name }

  depends_on = [
    terraform_data.rum_guards,
  ]
}

# ---------------------------------------------------------------------------
# Plan-time guards
#
# Same construction as the canary guards: the guarded values are fed into the
# resource's input so that any change to them re-plans it and re-runs every
# condition. A terraform_data resource with static arguments is planned once and
# then never again, and preconditions only run when Terraform plans an action
# for the resource, so an empty guard silently stops checking after the first
# apply.
# ---------------------------------------------------------------------------

resource "terraform_data" "rum_guards" {
  input = jsonencode({
    enabled          = local.rum_enabled
    domain           = var.rum_domain
    create_identity  = var.rum_create_identity_pool
    identity_pool_id = var.rum_identity_pool_id
    guest_role_arn   = var.rum_guest_role_arn
    telemetries      = local.rum_telemetries
    sample_rate      = var.rum_session_sample_rate
    cw_log_enabled   = var.rum_cw_log_enabled
    included_pages   = var.rum_included_pages
    excluded_pages   = var.rum_excluded_pages
    custom_events    = var.rum_custom_events_enabled
    enable_xray      = var.rum_enable_xray
  })

  lifecycle {
    precondition {
      condition     = !local.rum_enabled || var.rum_create_identity_pool || (var.rum_identity_pool_id != null && var.rum_guest_role_arn != null)
      error_message = "rum_create_identity_pool is false, so the app monitor needs an identity that already exists. Set both rum_identity_pool_id and rum_guest_role_arn, or set rum_create_identity_pool back to true and let this configuration own them."
    }

    precondition {
      condition     = !local.rum_enabled || !var.rum_create_identity_pool || (var.rum_identity_pool_id == null && var.rum_guest_role_arn == null)
      error_message = "rum_create_identity_pool is true, but rum_identity_pool_id or rum_guest_role_arn is also set. Those inputs are only read when this configuration does not create the pool, so leaving them set hides which identity is actually in use."
    }

    precondition {
      condition     = !local.rum_enabled || length(var.rum_included_pages) == 0 || length(var.rum_excluded_pages) == 0
      error_message = "rum_included_pages and rum_excluded_pages are both non-empty. An include list already excludes everything it does not name, so combining the two silently drops the exclusions instead of intersecting them."
    }

    precondition {
      condition     = !local.rum_enabled || !var.rum_enable_xray || contains(local.rum_telemetries, "http")
      error_message = "rum_enable_xray is true but the http telemetry is not enabled. Tracing in the web client instruments XHR and fetch calls, so without that telemetry it produces no segments at all."
    }

    precondition {
      condition     = !local.rum_enabled || !var.rum_cw_log_enabled || var.rum_session_sample_rate <= 0.25
      error_message = "rum_cw_log_enabled mirrors every ingested event into CloudWatch Logs and rum_session_sample_rate is above 0.25, which is the combination that turns real user monitoring into the largest line item in this stack. Lower the sample rate, or turn mirroring off and keep the aggregated metrics, which this setting does not reduce."
    }

    precondition {
      condition     = !local.rum_enabled || length(local.rum_telemetries) > 0
      error_message = "rum_domain is set but rum_telemetries is empty, so the app monitor would record session counts and nothing else. Enable at least one of errors, performance or http."
    }

    precondition {
      condition     = !var.rum_custom_events_enabled || local.rum_enabled
      error_message = "rum_custom_events_enabled is true but rum_domain is null, so there is no app monitor to record custom events against. Set rum_domain, or leave custom events off."
    }
  }
}
