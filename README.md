# aws-synthetics-monitoring

Terraform for proactive, outside-in monitoring of an HTTP service on AWS:
scripted CloudWatch Synthetics canaries that exercise real endpoints on a
schedule, real-user telemetry from the browser, and service-level dashboards and
alarms built on top of both.

The premise is that an endpoint nobody is calling is an endpoint whose outage you
learn about from a customer. A canary calls it for you, from outside your VPC,
on a fixed cadence, and fails loudly when the contract breaks — including the
cases a health check never sees, such as a 200 response carrying an error body,
a certificate 10 days from expiry, or a login page that renders but no longer
submits.

## What this repository is

A single root Terraform configuration, not a module library. It is meant to be
copied into an environment directory, pointed at a set of endpoints, and
applied. Every capability is opt-in: with no endpoints configured, a plan
produces only the shared artifacts bucket, its key, and the canary execution
role.

Everything ships as a template with placeholder values. Nothing in this
repository is wired to a live account, and no state, plan file, or tfvars file
with real values is tracked.

## Layout

```
.
├── versions.tf              Terraform and provider constraints
├── providers.tf             Provider wiring and the account guard rail
├── main.tf                  Account context data sources
├── variables.tf             Inputs, each with a validation block
├── locals.tf                Naming, tagging, and the canary-name budget
├── outputs.tf               What was created, and what was deliberately not
├── terraform.tfvars.example Template for a real tfvars file
└── .tflint.hcl              Lint configuration used by the pipeline
```

## Configuration

| Input | Default | What it decides |
|---|---|---|
| `aws_region` | `us-east-1` | The vantage point. Canaries observe your endpoints from this region, so it is a monitoring decision, not just a deployment one. |
| `name_prefix` | `synth` | Base of every resource name. Capped at 12 characters because a canary name may not exceed 21 in total. |
| `environment` | `dev` | Appended to the prefix and set as the `Environment` tag. Capped at 8 characters for the same reason. |
| `allowed_account_ids` | `[]` | When non-empty, the provider refuses to act outside this account list. Empty means your credentials are the only guard. |
| `tags` | `{}` | Merged into the provider default tags. Your keys win. |
| `artifact_retention_in_days` | `30` | Lifetime of canary artifacts in the bucket. The main storage cost lever. |
| `create_kms_key` | `true` | Whether this stack owns its encryption key or reuses one you supply. |
| `kms_key_arn` | `null` | Existing key to encrypt artifacts with. Required when `create_kms_key` is `false`. |
| `kms_key_deletion_window_in_days` | `30` | Waiting period before a scheduled key deletion takes effect. |

## Getting started

```bash
cp terraform.tfvars.example terraform.tfvars   # then edit it
terraform init
terraform validate
terraform plan -out=terraform.tfplan
terraform apply terraform.tfplan
```

`validate` and `fmt -check` need no credentials and are the useful pre-review
gate. `plan` does need credentials, because the account context data sources are
read before anything else can be resolved.

## Conventions this repository holds itself to

- **Every input is validated.** A bad value fails at plan time with a sentence
  explaining the constraint, not at apply time with an API error.
- **Preconditions over documentation.** Where a combination of inputs cannot
  work, a plan-time guard refuses it and says why, rather than a README asking
  you not to do it.
- **Least-privilege IAM, written out.** No managed policy stands in for a
  scoped inline policy, and every wildcard that survives carries a condition
  and a comment justifying it.
- **Outputs report what is *not* the case.** Alongside the ARNs, outputs name
  the guard rails that are switched off, so a `terraform output` is a short
  audit rather than a list of identifiers.

## Versioning

Tags are the stable interface. `main` moves; a release tag does not. Pin to a
tag when you copy this configuration into an environment.

## Security

Report anything sensitive through a private advisory rather than an issue:
<https://github.com/shivajichaprana/aws-synthetics-monitoring/security/advisories/new>

## License

MIT. See [LICENSE](LICENSE).
