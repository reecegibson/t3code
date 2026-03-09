const CLAUDE_VERSION_PATTERN = /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?)\b/;

export const MINIMUM_CLAUDE_CODE_CLI_VERSION = "1.0.0";

export function parseClaudeCodeCliVersion(output: string): string | null {
  const match = CLAUDE_VERSION_PATTERN.exec(output);
  if (!match?.[1]) {
    return null;
  }

  const segments = match[1].split("-")[0]?.split(".") ?? [];
  if (segments.length === 2) {
    segments.push("0");
  }

  if (segments.length !== 3 || !segments.every((segment) => /^\d+$/.test(segment))) {
    return null;
  }

  return segments.join(".");
}

export function isClaudeCodeCliVersionSupported(version: string): boolean {
  const parts = version.split(".").map(Number);
  const minParts = MINIMUM_CLAUDE_CODE_CLI_VERSION.split(".").map(Number);

  for (let i = 0; i < 3; i++) {
    const current = parts[i] ?? 0;
    const minimum = minParts[i] ?? 0;
    if (current > minimum) return true;
    if (current < minimum) return false;
  }
  return true;
}

export function formatClaudeCodeCliUpgradeMessage(version: string | null): string {
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Code CLI ${versionLabel} is too old for T3 Code. Upgrade to v${MINIMUM_CLAUDE_CODE_CLI_VERSION} or newer and restart T3 Code.`;
}
