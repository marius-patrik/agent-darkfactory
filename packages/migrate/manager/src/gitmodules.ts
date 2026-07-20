export interface GitmoduleEntry {
  name: string;
  path?: string;
  url?: string;
  branch?: string;
}

export function parseGitmodules(text: string): GitmoduleEntry[] {
  const modules: GitmoduleEntry[] = [];
  let current: GitmoduleEntry | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const section = line.match(/^\[submodule "(.+)"\]$/);
    if (section) {
      current = { name: section[1] };
      modules.push(current);
      continue;
    }

    if (!current) continue;
    const pair = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (pair) current[pair[1] as keyof GitmoduleEntry] = pair[2];
  }

  return modules;
}

export function serializeGitmodules(modules: GitmoduleEntry[]): string {
  return `${modules
    .map((mod) => {
      const lines = [`[submodule "${mod.name}"]`];
      for (const key of ["path", "url", "branch"] as const) {
        if (mod[key]) lines.push(`\t${key} = ${mod[key]}`);
      }
      return lines.join("\n");
    })
    .join("\n")}\n`;
}

export async function readGitmodules(file: string): Promise<GitmoduleEntry[]> {
  const source = Bun.file(file);
  if (!(await source.exists())) return [];
  return parseGitmodules(await source.text());
}

export async function writeGitmodules(file: string, modules: GitmoduleEntry[]): Promise<void> {
  await Bun.write(file, serializeGitmodules(modules));
}
