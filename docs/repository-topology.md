# Repository topology

## Canonical repositories and branches

`uniplanck/gpt-agent` is the private functional repository.

| Target | Canonical ref | Local clone |
| --- | --- | --- |
| Mac GAG | `uniplanck/gpt-agent:main` | `/Users/naomac/MyWorkspace2/GPT-Agent` |
| EC2 GAE | `uniplanck/gpt-agent:gae` | `/home/ubuntu/GPT-Agent` |
| Public DevSpace | `uniplanck/devspace:main` | Public derivative |
| GPT-Agent Tool | `uniplanck/gpt-agent-tool:main` | `/Users/naomac/MyWorkspace2/DevSpaceControl` |

The EC2 snapshot captured before the dedicated release channel was created is preserved at:

```text
uniplanck/gpt-agent:archive/gae-ec2-20260713
```

## Finder-first GAG development

The normal GAG development checkout is:

```text
/Users/naomac/MyWorkspace2/GPT-Agent
```

When this Finder checkout contains a newer implementation than GitHub, preserve its work on a branch, rebase or cherry-pick it onto the latest private `main`, run typecheck, tests, and build, and then update `uniplanck/gpt-agent:main`.

Do not replace a newer Finder implementation with an older GitHub copy merely to make the branch clean.

## Public DevSpace derivative

`uniplanck/devspace` is not an independent implementation source. It is generated from private GAG `main` by:

```text
scripts/export-public-core.sh
scripts/sanitize-public-core.mjs
```

The export keeps generic DevSpace functionality and removes private-only GEX blocks, GAE routing data, machine paths, credentials, and private runtime configuration. Public synchronization originates only from `uniplanck/gpt-agent:main`.

## GPT-Agent Tool flow

`uniplanck/gpt-agent-tool` is the private source for the branded macOS control application.

Its generic `Public/DevSpaceTool` output is first copied into the private GAG repository under:

```text
extensions/devspace-tool
```

The private GAG publisher then exports the generic version to `uniplanck/devspace`. The Tool repository must not push directly to the public fork or to GAE.

## Dedicated GAE release channel

`uniplanck/gpt-agent:gae` is the source of truth for GPT-Agent4EC2.

GAE starts from reviewed GAG `main` commits and adds EC2 release-channel policy. A push to `main` checks whether a promotion pull request already exists. PR creation uses the authenticated Mac checkout because this repository does not grant GitHub Actions permission to create pull requests:

```bash
zsh scripts/propose-gae-sync-local.sh
```

The resulting pull request uses:

```text
base: gae
head: main
```

That pull request is review-only. It is not auto-merged and does not update EC2.

Before merging GAG changes into `gae`, verify:

1. Typecheck, tests, and build pass.
2. GAE systemd, memory limits, Tailscale behavior, and Minecraft priority remain valid.
3. Private Mac-only behavior does not become an active EC2 dependency.

## Manual GAE update

The active EC2 clone must track the private `gae` branch. Updates are manual:

```bash
cd /home/ubuntu/GPT-Agent
bash scripts/gae-update-from-private.sh check
bash scripts/gae-update-from-private.sh apply
```

The updater validates a candidate in a temporary worktree, performs a fast-forward-only source update, installs dependencies, and builds. It does not restart `gpt-agent-ec2.service`.

Do not configure cron, systemd timers, GitHub webhooks, unattended pulls, or automatic service restarts for GAE.

## Required flow

```text
Finder GAG evolution
  -> verify against latest private main
  -> uniplanck/gpt-agent:main
  -> sanitized generic export to uniplanck/devspace:main
  -> review PR from main to gae when GAE should receive the change
  -> uniplanck/gpt-agent:gae
  -> manual EC2 update only

GPT-Agent Tool evolution
  -> uniplanck/gpt-agent-tool:main
  -> generic Tool copied into uniplanck/gpt-agent:main
  -> public export and optional reviewed GAE promotion
```
