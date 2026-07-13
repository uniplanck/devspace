# Repository topology

## Source of truth

`uniplanck/gpt-agent` is the private functional source of truth for GPT-Agent.

The normal development checkout is:

```text
/Users/naomac/MyWorkspace2/GPT-Agent
```

Feature work is completed and verified in this checkout, committed to the private repository, and then exported to other targets.

## Public fork

`uniplanck/devspace` is a generic public derivative, not an independent implementation branch.

The private repository exports only the shareable DevSpace core through:

```text
scripts/export-public-core.sh
```

The export includes the generic macOS `DevSpace Tool` extension and excludes private runtime skills, machine paths, credentials, and environment-specific configuration. Public synchronization must originate from `uniplanck/gpt-agent`; the Tool repository must not update the public fork directly.

## GPT-Agent Tool

`uniplanck/gpt-agent-tool` is the private source of truth for the branded macOS control application.

Its generic `Public/DevSpaceTool` output is first copied into:

```text
/Users/naomac/MyWorkspace2/GPT-Agent/extensions/devspace-tool
```

That change is committed to `uniplanck/gpt-agent`. The GPT-Agent canonical publisher then updates both the private repository and the generic public fork. This keeps the Tool extension and the core on one commit lineage.

## Runtime clones

Mac and EC2 installations are deployment clones, not source repositories.

| Runtime | Clone | Source | Runtime profile |
| --- | --- | --- | --- |
| Mac GAG | `/Users/naomac/MyWorkspace2/GPT-Agent` | `uniplanck/gpt-agent` | Mac-local GPT-Agent |
| EC2 GAE | `/home/ubuntu/GPT-Agent` | `uniplanck/gpt-agent` | `DEVSPACE_NODE_ROLE=gae`, EC2 service configuration |
| Public users | Their DevSpace clone/package | `uniplanck/devspace` | Generic DevSpace |

Runtime-specific values belong in `~/.devspace`, systemd environment files, service units, or other deployment configuration. They must not be maintained as long-lived edits to shared tracked source files.

## GAE update procedure

GAE updates use the private canonical repository and validate a candidate commit in a temporary worktree before changing the active checkout.

```bash
cd /home/ubuntu/GPT-Agent
bash scripts/gae-update-from-private.sh check
bash scripts/gae-update-from-private.sh apply
```

`gae-update-from-private.sh apply` performs a fast-forward-only update, installs dependencies, runs typecheck, tests, and build, but does not restart `gpt-agent-ec2.service`. Service activation remains a separate explicit operation after verification.

The updater refuses to run when the GAE checkout is dirty, on a non-main branch, or contains commits absent from private `main`. Existing GAE-specific source changes must therefore be reconciled into the private canonical repository or moved into external runtime configuration before automated updates are enabled.

## Required flow

```text
GPT-Agent feature change
  -> private uniplanck/gpt-agent
  -> sanitized export to uniplanck/devspace
  -> Mac/GAE runtime clones pull the appropriate canonical version

GPT-Agent Tool change
  -> private uniplanck/gpt-agent-tool
  -> generic DevSpace Tool copied into private uniplanck/gpt-agent
  -> sanitized export to uniplanck/devspace
```

Direct Tool-to-public or Tool-to-GAE synchronization is prohibited because it bypasses the functional source of truth.
