/// Context window category breakdown for estimating token allocation.
///
/// Provides per-category token estimates so the dashboard can render
/// a stacked bar showing how the context budget is distributed across
/// system prompt, tools, rules, messages, etc.
class ContextBreakdownModel {
  final int systemPrompt;
  final int systemTools;
  final int mcpTools;
  final int customAgents;
  final int rules;
  final int claudeMd;
  final int memory;
  final int skills;
  final int messages;
  final int autocompactBuffer;
  final int freeSpace;

  const ContextBreakdownModel({
    this.systemPrompt = 0,
    this.systemTools = 0,
    this.mcpTools = 0,
    this.customAgents = 0,
    this.rules = 0,
    this.claudeMd = 0,
    this.memory = 0,
    this.skills = 0,
    this.messages = 0,
    this.autocompactBuffer = 0,
    this.freeSpace = 0,
  });

  factory ContextBreakdownModel.fromJson(Map<String, dynamic> json) =>
      ContextBreakdownModel(
        systemPrompt: (json['system_prompt'] as num?)?.toInt() ?? 0,
        systemTools: (json['system_tools'] as num?)?.toInt() ?? 0,
        mcpTools: (json['mcp_tools'] as num?)?.toInt() ?? 0,
        customAgents: (json['custom_agents'] as num?)?.toInt() ?? 0,
        rules: (json['rules'] as num?)?.toInt() ?? 0,
        claudeMd: (json['claude_md'] as num?)?.toInt() ?? 0,
        memory: (json['memory'] as num?)?.toInt() ?? 0,
        skills: (json['skills'] as num?)?.toInt() ?? 0,
        messages: (json['messages'] as num?)?.toInt() ?? 0,
        autocompactBuffer: (json['autocompact_buffer'] as num?)?.toInt() ?? 0,
        freeSpace: (json['free_space'] as num?)?.toInt() ?? 0,
      );

  /// Sum of all static overhead categories (excludes messages, buffer, free).
  int get totalOverhead =>
      systemPrompt +
      systemTools +
      mcpTools +
      customAgents +
      rules +
      claudeMd +
      memory +
      skills;

  /// Total estimated tokens across all categories.
  int get totalEstimated =>
      totalOverhead + messages + autocompactBuffer + freeSpace;

  Map<String, dynamic> toJson() => {
        'system_prompt': systemPrompt,
        'system_tools': systemTools,
        'mcp_tools': mcpTools,
        'custom_agents': customAgents,
        'rules': rules,
        'claude_md': claudeMd,
        'memory': memory,
        'skills': skills,
        'messages': messages,
        'autocompact_buffer': autocompactBuffer,
        'free_space': freeSpace,
      };

  /// Returns non-zero segments for rendering.
  List<BreakdownSegment> get segments => [
        BreakdownSegment('System Prompt', systemPrompt, 'system_prompt'),
        BreakdownSegment('System Tools', systemTools, 'system_tools'),
        BreakdownSegment('MCP Tools', mcpTools, 'mcp_tools'),
        BreakdownSegment('Agents', customAgents, 'custom_agents'),
        BreakdownSegment('Rules', rules, 'rules'),
        BreakdownSegment('CLAUDE.md', claudeMd, 'claude_md'),
        BreakdownSegment('Memory', memory, 'memory'),
        BreakdownSegment('Skills', skills, 'skills'),
        BreakdownSegment('Messages', messages, 'messages'),
        BreakdownSegment('Buffer', autocompactBuffer, 'autocompact_buffer'),
        BreakdownSegment('Free', freeSpace, 'free_space'),
      ].where((s) => s.tokens > 0).toList();
}

/// A single segment in the context breakdown stacked bar.
class BreakdownSegment {
  final String label;
  final int tokens;
  final String key;

  const BreakdownSegment(this.label, this.tokens, this.key);
}
