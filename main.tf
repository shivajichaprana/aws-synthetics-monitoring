# Account context. These are read once and reused through `locals.tf` so that
# no resource has to repeat a data-source reference.
data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}
