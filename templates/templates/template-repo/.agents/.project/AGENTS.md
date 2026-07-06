# Project Agent Rules

These rules are specific to `template-repo`.

## Scope

This repository is a generic Bun and TypeScript repository template. Keep it small, portable, and easy to replace after a new repository is created from the template.

## Template Boundary

- Do not add framework-specific web, CLI, database, deployment, or plugin assumptions unless the template scope changes explicitly.
- Keep sample code minimal and obvious.
- Keep `.agents/.global/` reusable across repositories.
- Put template-specific or generated-repo replacement guidance in `.agents/.project/`.

## Replacement Rule

When a new repository is created from this template, replace the project-specific files under `.agents/.project/` with facts for the new project. Keep `.agents/.global/` unless the user intentionally changes the shared agent operating system.
