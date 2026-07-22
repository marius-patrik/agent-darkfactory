### State and secrets isolation

Keep shared identity, memory, sessions, route configuration, and credentials in
their canonical external authority. Product repositories contain only project
state and references. Never copy, print, commit, infer, or expose secret values;
only policy-authorized presence facts may appear as verified evidence. Private
data remains encrypted at rest and is admitted through its trusted boundary.
