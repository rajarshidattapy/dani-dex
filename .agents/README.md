# Repository agent configuration

`.agents/` is the only repository-owned location for agent configuration.

- Put shared skills in `skills/`.
- Put repository plugin marketplace metadata in `plugins/`.
- Put provider-neutral environment metadata in `environments/`.
- Do not add provider-specific root folders such as `.claude/`, `.codex/`, or `.kiro/`.

Provider clients that need a fixed configuration path use their user-level configuration. This
repository does not contain provider-specific bridge folders.
