refactor(v3.2): migrate to native subagents, cleanup deprecated code

BREAKING CHANGES:
- Removed LangChain/LangGraph plugin dependencies
- Replaced 9 AI hooks with 12 native Claude Code subagents

Deleted (scripts):
- igris_generate_brief.sh, igris_review_deep.sh, igris_plan_sprint.sh
- igris_implement_autonomous.sh, igris_heal.sh, igris_maintain.sh
- igris_refine_brief.sh (7 scripts total)

Deleted (prompts):
- bug_prompts.md, feature_prompts.md, generate_architecture_docs.md
- generate_coding_guidelines.md, migration_analysis.md, self_maintenance.md
- persona_loader.md (absorbed into subagents)

Deleted (docs):
- SYSTEM_ARCHITECTURE_v1.0.md, ARCHITECTURE_V3.md, PERSONA_PLUGIN_DESIGN.md
- API_TESTING_RESULTS.md, DOGFOODING_REPORT.md, BLOG_POST_DRAFT*.md
- RESUME_SESSION.md, ROADMAP.md, PERSONA_PLUGIN_BUILD_SUMMARY.md

Deleted (ai/):
- ai/checks/ directory (unused QA runbook)
- PERSONA_CONFIG.md, PERSONA_MASK_GUIDE.md, persona_greetings.md

Added:
- 12 native subagent definitions (.claude/agents/)
- Cyber-monkey persona (ai/personas/cyber-monkey/)
- MG-004 migration briefs (P1-P9)
- TD-014 prompts restructure brief

Archived:
- FR-001, FR-001-PHASE-1-PLAN, FR-002 (LangChain/LangGraph briefs)

Updated:
- HOOKS_SPEC.md, INTEGRATION_POINTS.md (simplified for v3.2)
- PLUGIN_ECOSYSTEM.md (native subagent architecture)
- MCP server (removed langchain.ts, langgraph.ts)
- igris_init.sh, igris_update.sh (removed ai/checks references)
- Moved CONTRIBUTING.md to root, igris_brand_book.md to docs/

🐒 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
