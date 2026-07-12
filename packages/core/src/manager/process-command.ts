import path from "node:path";

export function commandInvocation(
  command: string,
  args: string[],
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const resolved = path.isAbsolute(command) ? command : Bun.which(command, { PATH: env.PATH }) ?? command;
  if (platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    throw new Error(`batch command wrappers are not safe for arbitrary arguments: ${resolved}`);
  }
  if (platform === "win32" && /\.ps1$/i.test(resolved)) {
    return ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args];
  }
  return [resolved, ...args];
}
