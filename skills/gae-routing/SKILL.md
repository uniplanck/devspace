---
name: gae-routing
description: Route work explicitly requested for gae or GPT-Agent4EC2 to the Minecraft EC2 host over Tailscale SSH, while keeping Mac-local GAG work separate.
---

# GAE routing

Use this skill whenever the user says `gae`, `GPT-Agent4EC2`, or asks to perform work on the integrated EC2 runtime.

## Identity

- GAG: Mac-local GPT-Agent runtime.
- GAE: GPT-Agent4EC2 on `ubuntu@minecraft-ec2` over Tailscale.
- Do not treat GAG and GAE as interchangeable hosts.

## Routing

- Execute EC2 inspection and operations through `ssh ubuntu@minecraft-ec2`.
- Prefer GAE project roots:
  - `/home/ubuntu/GPT-Agent`
  - `/home/ubuntu/AI-Agent-Core`
  - `/home/ubuntu/minecraft`
- For repository edits, inspect branch and dirty state before changing files.
- Keep Minecraft, Tailscale, and `gae.service` state visible in completion checks.

## Safety

- Do not stop or restart Minecraft unless the task requires it.
- Do not expose Tailscale Serve through Funnel.
- Do not display owner tokens, auth files, environment secrets, cookies, or private keys.
- Do not confuse `systemctl status gae` with the Mac-local GAG service.
- When both GAG and GAE are involved, state which host owns each step.

## User-facing shorthand

Interpret phrases such as `gaeで実行`, `gaeに送って`, and `@gae` as a request to route the work to GPT-Agent4EC2 through the Mac GAG connection.
