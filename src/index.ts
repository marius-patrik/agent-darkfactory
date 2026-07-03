export interface CliOptions {
  name: string;
  shout: boolean;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const helpText = `Usage: template-cli [options]

Options:
  --name <name>  Name to greet. Defaults to "world".
  --shout        Print the greeting in uppercase.
  -h, --help     Show this help message.`;

export function parseArgs(args: string[]): CliOptions | "help" {
  const options: CliOptions = {
    name: "world",
    shout: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      return "help";
    }

    if (arg === "--shout") {
      options.shout = true;
      continue;
    }

    if (arg === "--name") {
      const value = args[index + 1];

      if (!value || value.startsWith("-")) {
        throw new Error("--name requires a value");
      }

      options.name = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg ?? ""}`);
  }

  return options;
}

export function createGreeting(options: CliOptions): string {
  const name = options.name.trim() || "world";
  const greeting = `Hello, ${name}.`;

  return options.shout ? greeting.toUpperCase() : greeting;
}

export function runCli(args: string[]): CliResult {
  try {
    const options = parseArgs(args);

    if (options === "help") {
      return {
        exitCode: 0,
        stdout: helpText,
        stderr: ""
      };
    }

    return {
      exitCode: 0,
      stdout: createGreeting(options),
      stderr: ""
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";

    return {
      exitCode: 1,
      stdout: "",
      stderr: message
    };
  }
}

if (import.meta.main) {
  const result = runCli(Bun.argv.slice(2));

  if (result.stdout) {
    console.log(result.stdout);
  }

  if (result.stderr) {
    console.error(result.stderr);
  }

  process.exitCode = result.exitCode;
}
