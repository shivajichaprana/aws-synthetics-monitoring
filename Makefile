# Every gate the pipeline runs has a target here, with the same flags, so that
# "it passed locally" and "it passed in CI" are the same claim.
#
# Two conventions are worth knowing before reading further.
#
# The Terraform directory list is DISCOVERED from the tree rather than written
# down. A list maintained by hand drifts from the pipeline's the first time a
# directory is added, and the symptom is a configuration nobody validates.
#
# `deploy` applies a plan that was saved earlier; it never re-plans. Applying a
# fresh plan means approving something nobody read, and the gap between the plan
# that was reviewed and the one that is applied is where a surprise lives.

SHELL := /usr/bin/env bash
.SHELLFLAGS := -euo pipefail -c
.DEFAULT_GOAL := help

TF ?= terraform
AWS ?= aws
NODE ?= node
TFLINT ?= tflint

PLAN_FILE ?= terraform.tfplan
BUNDLE ?= canary-scripts/dist/canaries.zip
TEST_GLOB ?= tests/**/*.test.js
# Several tests hold a socket open deliberately to prove a per-request timeout
# fires. Without a per-test bound, a regression in that timeout makes the suite
# hang rather than fail -- and a run that hangs reports nothing at all.
TEST_TIMEOUT_MS ?= 30000

# Every directory holding at least one tracked .tf file. Today that is the
# repository root; a module directory added later is picked up with no edit here.
TF_DIRS := $(patsubst %/,%,$(sort $(dir $(shell git ls-files '*.tf' 2>/dev/null))))

.PHONY: help tools tf-dirs init fmt fmt-check validate tflint conventions \
        shell-lint lint bundle test ci plan deploy apply destroy outputs \
        audit canary-list canary-runs run-canary clean

help: ## Show this help
	@awk 'BEGIN { FS = ":.*## " } \
		/^[a-zA-Z0-9_%-]+:.*## / { printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2 } \
		/^## / { printf "\n%s\n", substr($$0, 4) }' $(MAKEFILE_LIST)

tools: ## Report which required tools are present
	@for tool in $(TF) $(TFLINT) $(NODE) $(AWS) zip shellcheck; do \
		if command -v "$$tool" >/dev/null 2>&1; then \
			printf '  %-12s %s\n' "$$tool" "$$(command -v "$$tool")"; \
		else \
			printf '  %-12s MISSING\n' "$$tool"; \
		fi; \
	done

tf-dirs: ## Print the Terraform directories discovered from the tree
	@printf '%s\n' $(TF_DIRS)

## Offline gates -- no AWS account, no credentials

init: ## terraform init with no backend, which is all the offline gates need
	$(TF) init -backend=false -input=false

fmt: ## Rewrite Terraform files into canonical form
	$(TF) fmt -recursive

fmt-check: ## Fail if any Terraform file is not canonically formatted
	$(TF) fmt -check -diff -recursive

validate: ## Validate every discovered Terraform directory
	@for dir in $(TF_DIRS); do \
		echo "==> validate $$dir"; \
		( cd "$$dir" && $(TF) init -backend=false -input=false >/dev/null && $(TF) validate ); \
	done

tflint: ## Lint Terraform, failing on errors but not on preferences
	$(TFLINT) --init
	$(TFLINT) --recursive --minimum-failure-severity=error

conventions: ## Check bundle properties: no dependencies, no runtime coupling, no hardcoded target
	$(NODE) tests/lint/canary-conventions.js

shell-lint: ## Syntax-check and lint the bundler
	bash -n canary-scripts/build.sh
	shellcheck canary-scripts/build.sh

lint: tflint conventions shell-lint ## Every linter

test: ## Run the offline suite over the canary scripts and their contract
	@# The quoted glob, not the directory: `node --test tests` tries to load
	@# `tests` as a module and reports one failure that names a module rather
	@# than a test.
	$(NODE) --test --test-timeout=$(TEST_TIMEOUT_MS) "$(TEST_GLOB)"

bundle: ## Package the canary scripts into the zip the service expects
	./canary-scripts/build.sh

ci: fmt-check validate tflint conventions shell-lint bundle test ## Every gate the pipeline runs
	@echo "All offline gates passed."

## Deployment -- needs credentials

plan: ## Write a reviewable plan without applying it
	$(TF) init -input=false
	$(TF) plan -input=false -out=$(PLAN_FILE)

deploy: ## Apply the plan saved by `make plan`, never a fresh one
	@if [[ ! -f "$(PLAN_FILE)" ]]; then \
		echo "error: $(PLAN_FILE) does not exist. Run 'make plan', read the diff, then deploy." >&2; \
		exit 2; \
	fi
	$(TF) apply -input=false $(PLAN_FILE)
	@rm -f -- $(PLAN_FILE)
	@$(MAKE) --no-print-directory audit

apply: deploy ## Alias for deploy

destroy: ## Destroy everything this configuration owns
	$(TF) destroy -input=false

outputs: ## Print every output, including the ones naming what is not the case
	$(TF) output

audit: ## Print only the outputs that report a gap in the monitoring
	@echo "Objectives whose tiers are finer than the signal can resolve:"
	@$(TF) output -json slo_windows_undersampled
	@echo "Latency alarms measuring the whole run rather than one step:"
	@$(TF) output -json slo_latency_measures_harness
	@echo "Canaries created but not started (they produce no metrics):"
	@$(TF) output -json canaries_not_started
	@echo "Alert subscriptions nobody has confirmed (these deliver nothing):"
	@$(TF) output -json alerts_subscriptions_pending_confirmation

## Operating the canaries

canary-list: ## List the canaries this deployment manages, with their schedules
	@$(TF) output -json canary_names
	@$(TF) output -json canary_schedules

canary-runs: ## Show the most recent runs of one canary (CANARY=<key>)
	@test -n "$(CANARY)" || { echo "error: set CANARY=<key>, e.g. 'make canary-runs CANARY=api'. 'make canary-list' shows the keys." >&2; exit 2; }
	@name="$$($(TF) output -json canary_names | jq -er '.["$(CANARY)"]')"; \
	region="$$($(TF) output -raw aws_region)"; \
	$(AWS) synthetics get-canary-runs --name "$$name" --region "$$region" \
		--max-results $(or $(RUNS),5) \
		--query 'CanaryRuns[].{Status:Status.State,Reason:Status.StateReason,Started:Timeline.Started}' \
		--output table

# There is no run-once API. StartCanary starts the SCHEDULE, and a canary that
# is already running cannot be told to run now -- so an on-demand run means
# starting a stopped canary, whose first run follows immediately. Forcing one on
# a running canary therefore requires stopping it first, which is a real gap in
# coverage and is why FORCE has to be asked for explicitly rather than assumed.
run-canary: ## Start a stopped canary, which runs it immediately (CANARY=<key>, FORCE=1 to restart a running one)
	@test -n "$(CANARY)" || { echo "error: set CANARY=<key>, e.g. 'make run-canary CANARY=api'. 'make canary-list' shows the keys." >&2; exit 2; }
	@name="$$($(TF) output -json canary_names | jq -er '.["$(CANARY)"]')"; \
	region="$$($(TF) output -raw aws_region)"; \
	state="$$($(AWS) synthetics get-canary --name "$$name" --region "$$region" --query 'Canary.Status.State' --output text)"; \
	echo "canary $$name is $$state"; \
	if [[ "$$state" == "RUNNING" ]]; then \
		if [[ -z "$(FORCE)" ]]; then \
			echo "It is already running on its schedule, and the service has no run-once call." >&2; \
			echo "Wait for the next scheduled run, or pass FORCE=1 to stop and restart it -- which leaves a gap in coverage until it starts." >&2; \
			exit 3; \
		fi; \
		echo "stopping $$name"; \
		$(AWS) synthetics stop-canary --name "$$name" --region "$$region"; \
		for _ in $$(seq 1 60); do \
			[[ "$$($(AWS) synthetics get-canary --name "$$name" --region "$$region" --query 'Canary.Status.State' --output text)" == "STOPPED" ]] && break; \
			sleep 5; \
		done; \
	fi; \
	echo "starting $$name; its first run begins immediately"; \
	$(AWS) synthetics start-canary --name "$$name" --region "$$region"; \
	echo "artifacts and the run log will appear under s3://$$($(TF) output -raw artifacts_bucket_name)/canary/$(CANARY)/"

clean: ## Remove local build output, saved plans and provider plugins
	@rm -rf -- canary-scripts/dist .terraform
	@rm -f -- $(PLAN_FILE) $(PLAN_FILE).json
