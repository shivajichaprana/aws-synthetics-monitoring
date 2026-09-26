# Toolchain and provider constraints for the whole configuration.
#
# The floor is 1.6.0 rather than something older for two reasons that matter
# here: `terraform_data` (used for the plan-time guards in this repository) was
# introduced in 1.4, and the native test framework that the pipeline runs
# arrived in 1.6. Anything below that floor would either fail to parse the
# guards or silently skip the tests.
terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # Floor, not a pin: the Synthetics artifact-encryption block and the RUM
      # resources used here are all present from 5.60 onward. The major bound
      # is closed because a 7.x provider is free to rename attributes.
      version = ">= 5.60.0, < 7.0.0"
    }
  }
}
