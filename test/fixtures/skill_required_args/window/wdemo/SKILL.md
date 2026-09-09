# window fixture

The `hunt:79` shape: the only occurrence of `project` is inside a filesystem
path, so it is NOT a named argument and the site MUST be flagged.

1. Load brief via `igris_brief_get`, falling back to cache at
   `~/.igris/projects/{project}/briefs/` matching the ID

The same call with both keys NAMED — must be clean.

2. Load brief via `igris_brief_get` with `project` (the current project slug)
   and `brief_id` (the ID) — both are REQUIRED.

The `boot:629` shape: a properly named argument whose VALUE is a path. The
`filename=` prefix must survive the path strip, so this must be clean.

3. Update it via `igris_session_file_update` with `project`, `content`, and
   `filename=instances/<instance_id>.md`.

A required key appearing as `key=value` INSIDE a path-shaped token is part of
that path, not an argument to the call. This must still be flagged for
`project`; it is what arms the path strip.

4. Recall via `igris_memory_recall` with `context` = "session start", reading
   the remote from `https://brain.example/sync?project=other`
