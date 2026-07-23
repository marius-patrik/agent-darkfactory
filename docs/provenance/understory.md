# Understory provenance and redistribution receipt

- Upstream: `https://github.com/thecodacus/understory`
- Andromeda code pin: `912cfa6d4f407ffdb768bcd667bd701ccfe9ecb2`
- Pinned tree: `0f5a6da9d630acc4348cb4a68c9606046690a65c`
- Upstream Apache-2.0 confirmation:
  `0548c04a8782685398df3040da066c61b48a4945`
- Upstream license blob:
  `5e7e943c81786a40d01eb66dc2be427714e0e8bd`
- Copyright: 2026 Anirban Kar

The owner supplied authorization for this consolidation records permission to
copy, modify, and publicly redistribute the Understory-derived implementation
inside Andromeda under Apache-2.0. Upstream subsequently added an Apache-2.0
license independently. Andromeda keeps implementation pinned at the reviewed
code commit; the later upstream commit is retained only as licensing provenance
unless its code changes pass a separate review.

The imported implementation must retain upstream copyright and attribution.
Andromeda modifications must be identified in source history, and the root
`LICENSE` and `NOTICE` must ship with source and binary releases.

## Memory-engine history import

The memory-engine import merges the pinned Understory commit as the explicit
second parent of an unrelated-history `ours` merge. The first parent is
`db5c7a6636dc7d910c285e3f12912eeabb01c9fa`; the second parent is the exact code
pin above. This makes all 26 commits reachable without placing an unmodified
standalone Understory tree in the Andromeda working tree.

The audited adaptation and exclusion map is recorded in
`understory-memory-import.json`. Current implementation is modified
Andromeda-owned source under `src/engine/memory/understory`; no Understory API,
state writer, provider state, web app, or orchestration loop is active. The
canonical state remains validated Markdown in `private-data`, while SQLite,
FTS, graph, validation, and digest artifacts are rebuildable derivatives.
