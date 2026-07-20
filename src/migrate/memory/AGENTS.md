# Memory repository guidance

Use issue/spec -> feature branch -> validation -> reviewed pull request -> `dev`. Release only through a reviewed `dev` -> `main` pull request.

Memory records and cursor authority remain manager-owned canonical events. Provider transcripts and corpus files are evidence only. Never write canonical event or projection files directly, and never admit secret-like content.
