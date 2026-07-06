export function createGreeting(name = "world"): string {
  const normalizedName = name.trim() || "world";
  return `Hello, ${normalizedName}!`;
}

if (import.meta.main) {
  const [, , name] = Bun.argv;
  console.log(createGreeting(name));
}
