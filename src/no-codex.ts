export function isCodexAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GAG_ALLOW_CODEX === "1" || env.DEVSPACE_ALLOW_CODEX === "1";
}

export function isCodexProvider(provider: string | undefined): boolean {
  return Boolean(provider?.trim() && /(?:^|[-_])codex(?:$|[-_])/iu.test(provider.trim()));
}

export function assertNonCodexProvider(
  provider: string | undefined,
  context: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (isCodexAllowed(env)) return;
  if (!provider?.trim()) {
    throw new Error(
      `${context} requires an explicit non-Codex provider. `
      + "The implicit Hermes provider is blocked because it may resolve to OpenAI Codex. ",
    );
  }
  if (isCodexProvider(provider)) {
    throw new Error(
      `${context} blocked provider ${provider}: GAG No-Codex mode is active. `
      + "Use a non-Codex provider or the deterministic chatgpt-task preset.",
    );
  }
}

export function assertLocalAgentProviderAllowed(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (provider === "codex" && !isCodexAllowed(env)) {
    throw new Error(
      "Codex local agents are disabled by GAG No-Codex mode. "
      + "Set GAG_ALLOW_CODEX=1 only for an intentional temporary override.",
    );
  }
}
