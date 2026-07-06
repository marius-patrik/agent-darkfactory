# Dialogue Log

## 2026-07-02

The user asked to make `template-repo` a Bun project with CI. The repo was scaffolded with Bun 1.3.14, strict TypeScript, sample source, sample tests, and GitHub Actions validation.

The user then asked to add a `.agents` folder based on existing repositories and explicitly requested subagents. Two explorer subagents inspected existing `.agents` folders and `AGENTS.md` files across the workspace.

The user clarified that most `.agents` content should be reusable across all repositories, with project-specific data separated. The user then specified `.agents/.global/` for reusable content and `.agents/.project/` for project-specific data.

This repo now follows that split. Runtime-generated `.agents` metadata is intentionally excluded from the template.
