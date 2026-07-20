export function main(args: string[]): void {
  const name = args[0] ?? "world";
  console.log(`Hello, ${name}.`);
}

if (import.meta.main) {
  main(Bun.argv.slice(2));
}
