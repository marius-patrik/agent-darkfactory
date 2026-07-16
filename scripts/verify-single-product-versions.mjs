import fs from "node:fs";
import path from "node:path";

export function javascriptPackageVersionIssues(root, tracked, productVersion) {
  const issues = [];
  for (const relative of tracked.filter(
    (name) => name.endsWith("package.json") && !name.endsWith("agent.package.json"),
  )) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
    if (typeof manifest.version === "string" && manifest.version !== productVersion) {
      issues.push(`JavaScript package version drift in ${relative}: ${manifest.version} != ${productVersion}`);
    }
  }
  return issues;
}
