Copilot runtime artifacts are stored in this folder.

Generated/updated at runtime:
- `app_map.json`
- `memory.json`
- `skills.json`
- `distillation_state.json`
- `sessions/*.json`
- `sub_agents/*.json`

Legacy data from `ui/data/_assistant_knowledge` and `ui/data/_assistant_sessions`
is migrated automatically when the backend loads.
