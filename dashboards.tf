# ---------------------------------------------------------------------------
# SLO dashboard
#
# One page that answers, in order: is the objective being met, what is the
# signal behind that answer, and which alarms currently disagree with it.
#
# The dashboard is built from the same locals the alarms are, which is the point
# of it living in this repository rather than being drawn in the console. A
# threshold line typed onto a graph by hand is a threshold line that stops
# matching its alarm the first time the objective changes, and there is nothing
# on the graph to say so.
#
# Three mechanical notes shape everything below.
#
# The grid is 24 columns wide. A row whose widths sum to more than 24 does not
# error; it wraps, and the layout silently rearranges itself, which is why the
# positions here are arithmetic rather than hand-placed.
#
# Widget properties must be ABSENT where they do not apply, not null. The API
# rejects a null where it would accept a missing key, and `jsonencode` writes
# nulls out faithfully, so no optional property below is ever set to a
# conditional that might evaluate to null.
#
# Each widget is therefore encoded on its own and the body is assembled from the
# resulting strings. That is not a stylistic preference. Widgets legitimately
# have different shapes — a text widget has markdown and no metrics, an alarm
# widget has neither — and Terraform has no type that a list of them all fits:
# two object values whose attribute sets differ have no common object type, so
# `concat` over a mixed collection of widgets fails to unify its arguments, and a
# conditional between an empty list and a one-widget list quietly converts both
# to a homogeneous list type first. Encoding each widget separately sidesteps the
# whole question, because a list of strings unifies with anything.
# ---------------------------------------------------------------------------

locals {
  # Row heights and the y coordinate each band starts at, named so that inserting
  # a band is one edit rather than a re-count of every widget.
  dashboard_header_height = 5
  dashboard_row_height    = 6

  dashboard_has_alarms    = length(local.slo_burn_windows) + length(local.slo_latency_alarms) > 0
  dashboard_canary_band_y = local.dashboard_header_height
  dashboard_alarm_band_y  = local.dashboard_header_height + length(local.dashboard_canary_keys) * local.dashboard_row_height
  dashboard_rum_band_y    = local.dashboard_alarm_band_y + (local.dashboard_has_alarms ? local.dashboard_row_height : 0)
}

# Threshold lines, one per tier, drawn on every canary's success-rate graph.
# Reading them off the same map the alarms are built from is what keeps the
# picture and the alerting from drifting apart.
locals {
  dashboard_tier_annotations = {
    for canary_key in local.dashboard_canary_keys :
    canary_key => concat(
      [
        {
          label = format("objective %.3f%%", local.slo_canaries[canary_key].objective * 100)
          value = local.slo_canaries[canary_key].objective * 100
        },
      ],
      [
        for tier_key in sort(keys(var.slo_burn_rate_tiers)) : {
          label = "${tier_key} burn ${var.slo_burn_rate_tiers[tier_key].burn_rate}x"
          value = local.slo_burn_windows["${canary_key}-${tier_key}"].success_threshold_percent
        }
      ],
    )
  }
}

# The header.
#
# A table rather than prose, because the figures that matter here are a
# comparison — each tier's threshold against the finest error rate its own
# window can represent — and a sentence hides the comparison that a column
# makes unavoidable.
locals {
  dashboard_header_markdown = join("\n", concat(
    [
      "## Availability and latency objectives",
      "",
      "Objective **${local.dashboard_slo_percent}%** over **${var.slo_window_days} days**, allowing **${format("%.1f", local.slo_budget_minutes)} minutes** of unsuccessful probing per period.",
      "",
      "A canary contributes one sample per run, so the finest error rate a window can express is one failure divided by the number of runs it holds. Where a threshold sits below that floor, a single failed run reaches it: the alarm is correct, but it cannot tell a sustained burn from one blip.",
      "",
      "| canary | objective | runs/hour | tier | breaches below | one failed run reads as |",
      "|---|---|---|---|---|---|",
    ],
    length(local.slo_burn_windows) == 0 ? ["| _no objectives configured_ | | | | | |"] : [
      for key in sort(keys(local.slo_burn_windows)) :
      format(
        "| %s | %.3f%% | %s | %s | %.3f%% success | %s |",
        local.slo_burn_windows[key].canary_name,
        (1 - local.slo_burn_windows[key].error_budget) * 100,
        local.slo_burn_windows[key].interval_minutes == null ? "cron" : format("%.1f", 60 / local.slo_burn_windows[key].interval_minutes),
        local.slo_burn_windows[key].tier_key,
        local.slo_burn_windows[key].success_threshold_percent,
        local.slo_long_window_min_error_percent[key] == null ? "unknown (cron schedule)" : format("%.2f%% error over %d min", local.slo_long_window_min_error_percent[key], local.slo_burn_windows[key].long_window_minutes),
      )
    ],
  ))
}

# Per canary: a headline tile, the success rate against every threshold, and the
# duration the latency alarm actually reads.
locals {
  dashboard_canary_widgets = flatten([
    for index, canary_key in local.dashboard_canary_keys : [
      jsonencode({
        type   = "metric"
        x      = 0
        y      = local.dashboard_canary_band_y + index * local.dashboard_row_height
        width  = 6
        height = local.dashboard_row_height

        properties = {
          view    = "singleValue"
          region  = var.aws_region
          title   = "${canary_key} success rate"
          metrics = [["CloudWatchSynthetics", "SuccessPercent", "CanaryName", local.slo_canaries[canary_key].name, { stat = "Average", label = canary_key }]]

          # This is what makes the tile mean "over the range on screen" rather
          # than "in the most recent bucket". Without it the number is whatever
          # the last period happened to be, and for a success rate that is
          # almost always either 100 or 0 — never the figure anyone opened the
          # page to read.
          setPeriodToTimeRange     = true
          singleValueFullPrecision = false
          sparkline                = true
        }
      }),
      jsonencode({
        type   = "metric"
        x      = 6
        y      = local.dashboard_canary_band_y + index * local.dashboard_row_height
        width  = 9
        height = local.dashboard_row_height

        properties = {
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          title   = "${canary_key} success rate against thresholds"
          period  = var.dashboard_period_seconds
          metrics = [["CloudWatchSynthetics", "SuccessPercent", "CanaryName", local.slo_canaries[canary_key].name, { stat = "Average", label = "success %" }]]

          # Pinned to 0-100 deliberately. Left to scale itself, a metric that has
          # been at 100 all week renders as a flat line with the axis spanning
          # 99.9 to 100, and then a dip to 98 looks like a collapse while a dip
          # to 0 looks the same as a dip to 98.
          yAxis = {
            left = {
              min   = 0
              max   = 100
              label = "percent"
            }
          }

          annotations = {
            horizontal = local.dashboard_tier_annotations[canary_key]
          }
        }
      }),
      jsonencode({
        type   = "metric"
        x      = 15
        y      = local.dashboard_canary_band_y + index * local.dashboard_row_height
        width  = 9
        height = local.dashboard_row_height

        properties = {
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          title   = local.slo_latency_alarms[canary_key].step_name == null ? "${canary_key} run duration (whole run, startup included)" : "${canary_key} step ${local.slo_latency_alarms[canary_key].step_name} duration"
          period  = var.dashboard_period_seconds

          # Exactly the dimensions the latency alarm evaluates, taken from the
          # same local. A graph of the whole run sitting beside an alarm on one
          # step would be two different numbers under one title, and the title
          # would not say which.
          metrics = [
            concat(
              ["CloudWatchSynthetics", "Duration"],
              flatten([for name in sort(keys(local.slo_latency_alarms[canary_key].dimensions)) : [name, local.slo_latency_alarms[canary_key].dimensions[name]]]),
              [{ stat = var.slo_latency_statistic, label = "${var.slo_latency_statistic} ms" }],
            )
          ]

          yAxis = {
            left = {
              min   = 0
              label = "milliseconds"
            }
          }

          annotations = {
            horizontal = [
              {
                label = "budget ${local.slo_latency_alarms[canary_key].latency_objective_ms} ms"
                value = local.slo_latency_alarms[canary_key].latency_objective_ms
              },
            ]
          }
        }
      }),
    ]
  ])
}

# Every alarm derived from the objectives, in one widget.
#
# The roll-up alarm is left out: it is an OR over the others, so including it
# would let one event colour two tiles while adding nothing.
locals {
  dashboard_alarm_widgets = !local.dashboard_has_alarms ? [] : [
    jsonencode({
      type   = "alarm"
      x      = 0
      y      = local.dashboard_alarm_band_y
      width  = 24
      height = local.dashboard_row_height

      properties = {
        title = "Objective alarms"
        alarms = concat(
          [for key in sort(keys(local.slo_burn_windows)) : aws_cloudwatch_composite_alarm.burn[key].arn],
          [for key in sort(keys(local.slo_latency_alarms)) : aws_cloudwatch_metric_alarm.latency[key].arn],
        )
      }
    }),
  ]
}

# Real user monitoring, where it is enabled.
#
# Only the widgets whose telemetry is actually switched on are drawn. A graph of
# a signal that was never enabled is a flat line at zero, which is exactly what
# a healthy service looks like — the most expensive kind of wrong on a page
# whose entire purpose is telling those two apart.
locals {
  dashboard_rum_widgets = !local.rum_enabled ? [] : concat(
    [
      jsonencode({
        type   = "metric"
        x      = 0
        y      = local.dashboard_rum_band_y
        width  = 8
        height = local.dashboard_row_height

        properties = {
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          title   = format("Browser sessions observed (%.0f%% sampled)", var.rum_session_sample_rate * 100)
          period  = var.dashboard_period_seconds
          metrics = [["AWS/RUM", "SessionCount", "application_name", local.rum_app_monitor_name, { stat = "Sum", label = "sessions" }]]
        }
      }),
    ],
    !contains(local.rum_telemetries, "performance") ? [] : [
      jsonencode({
        type   = "metric"
        x      = 8
        y      = local.dashboard_rum_band_y
        width  = 8
        height = local.dashboard_row_height

        properties = {
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          title   = "Navigation duration, real browsers"
          period  = var.dashboard_period_seconds
          metrics = [["AWS/RUM", "PerformanceNavigationDuration", "application_name", local.rum_app_monitor_name, { stat = "p75", label = "p75 ms" }]]

          yAxis = {
            left = {
              min   = 0
              label = "milliseconds"
            }
          }
        }
      }),
    ],
    length(setintersection(toset(local.rum_telemetries), toset(["errors", "http"]))) == 0 ? [] : [
      jsonencode({
        type   = "metric"
        x      = contains(local.rum_telemetries, "performance") ? 16 : 8
        y      = local.dashboard_rum_band_y
        width  = 8
        height = local.dashboard_row_height

        properties = {
          view    = "timeSeries"
          stacked = false
          region  = var.aws_region
          title   = "Errors reported by real browsers"
          period  = var.dashboard_period_seconds

          metrics = concat(
            !contains(local.rum_telemetries, "errors") ? [] : [["AWS/RUM", "JsErrorCount", "application_name", local.rum_app_monitor_name, { stat = "Sum", label = "JavaScript" }]],
            !contains(local.rum_telemetries, "http") ? [] : [["AWS/RUM", "HttpErrorCount", "application_name", local.rum_app_monitor_name, { stat = "Sum", label = "HTTP" }]],
          )

          yAxis = {
            left = {
              min   = 0
              label = "count"
            }
          }
        }
      }),
    ],
  )
}

locals {
  dashboard_widget_json = concat(
    [
      jsonencode({
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = local.dashboard_header_height

        properties = {
          markdown = local.dashboard_header_markdown
        }
      }),
    ],
    local.dashboard_canary_widgets,
    local.dashboard_alarm_widgets,
    local.dashboard_rum_widgets,
  )

  # Assembled from the encoded widgets. Each element is already valid JSON, so
  # the only structure added here is the wrapper the API expects.
  dashboard_body = format("{\"widgets\":[%s]}", join(",", local.dashboard_widget_json))
}

resource "aws_cloudwatch_dashboard" "slo" {
  count = var.create_dashboard ? 1 : 0

  dashboard_name = local.dashboard_name
  dashboard_body = local.dashboard_body

  lifecycle {
    precondition {
      # The service caps a dashboard body at 100,000 characters and rejects a
      # larger one outright, naming no widget in the error. The ceiling is
      # reachable by a deployment with many canaries, so it is worth catching
      # here, where the widget count is known.
      condition     = length(local.dashboard_body) <= 100000
      error_message = "The dashboard body exceeds the 100,000-character limit the service accepts. Reduce the number of canaries on one dashboard, or set create_dashboard to false and compose the widgets you need from the outputs this configuration exposes."
    }
  }
}
