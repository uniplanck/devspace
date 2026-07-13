# GAE release channel

This branch is the GitHub source of truth for GPT-Agent4EC2 (GAE).

## Branch roles

- `main`: Mac-local GAG and shared private GPT-Agent development.
- `gae`: GAE release channel. It receives reviewed GAG improvements plus EC2-specific deployment metadata.
- `devspace/main`: sanitized public derivative.

## Promotion policy

Changes from `main` are proposed to `gae` through a pull request. They are not automatically merged and are never automatically applied to EC2.

Before merging a promotion PR:

1. Confirm that GAE-specific systemd, memory, Tailscale, and Minecraft-priority behavior remains intact.
2. Run typecheck, tests, and build on the candidate branch.
3. Review any conflicts in runtime configuration explicitly.

## EC2 update policy

The active clone is `/home/ubuntu/GPT-Agent`.

A GAE update is manual:

```bash
cd /home/ubuntu/GPT-Agent
bash scripts/gae-update-from-private.sh check
bash scripts/gae-update-from-private.sh apply
```

The updater targets the private `gae` branch, performs candidate validation, and does not restart `gpt-agent-ec2.service`. Service restart remains a separate explicit operation.

Do not enable cron, systemd timers, GitHub webhooks, or unattended pulls for this repository.
