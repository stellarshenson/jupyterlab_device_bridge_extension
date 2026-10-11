# Claude Code Journal

This journal tracks substantive work on documents, diagrams, and documentation content.

---

1. **Task - Project creation** (v0.1.0): Created `jupyterlab_device_bridge_extension` as new JupyterLab extension<br>
   **Result**: Scaffolded by `new-jupyterlab-extension.sh --headless --brief` from copier template `jupyterlab/extension-template` v4.6.5, `kind: frontend-and-server`, settings and tests enabled. Purpose: give container programs a serial port or USB device of the browser's computer through Web Serial and WebUSB; first user an AI agent that uploads firmware and reads serial output. Specification in `docs/brief.md`; code still the template placeholder. Repository initialised with `git init -b main` and initial import commit. Added `.claude/CLAUDE.md` overlay importing user and workspace layers without copying them: Makefile-only lifecycle, lockfile rule, Makefile version check (local 1.45 identical to canonical), pm-tools-only criteria and defects, three test tiers, CLI agent-skill rule, graphify scope control, Required Skills table. Added `.claude/settings.json` with `worktree.bgIsolation: none`: the background-session guard refuses in-place edits and the brief orders the import on `main`; same setting as HTML viewer sibling. `README.md` rewritten: seven badges, feature scope marked not implemented, sections below Uninstall dropped.
