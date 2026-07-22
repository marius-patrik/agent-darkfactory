### Repository doctor workflow overlay

- Diagnosis is deterministic and read-only by default. Issue reconciliation is an
  explicit mode, and repair is a separate authorization with exact finding targets.
- Emit versioned human and JSON reports with stable finding identifiers, observed and
  expected state, evidence, visibility, severity, and repair guidance.
- Treat missing baselines, truncated trees, inaccessible settings, malformed remote
  data, or ambiguous identity as findings or hard failure, never healthy state.
- Upsert only doctor-owned issue markers, close them only after verified resolution,
  preserve parked and archived skips, and record zero model-token use for mechanics.
