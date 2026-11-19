fix(config): disable built-in git instructions to prevent Co-Authored-By conflict

Set includeGitInstructions: false in .claude/settings.json so Igris
commit standards (03-igris-commits.md) are the sole authority on commit
format. Updated both installers to set this automatically for new
projects. Documented in coding_guidelines.md.

closes #BR-058
