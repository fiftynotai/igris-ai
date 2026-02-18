/// Constants for the 7+1 Igris AI agents.
///
/// Defines display names, monograms, tier mapping, colors,
/// pipeline phases, and phase-to-agent associations.
class AgentConstants {
  AgentConstants._();

  /// Canonical pipeline rendering order (orchestrator first).
  static const List<String> agentOrder = [
    'orchestrator',
    'architect',
    'forger',
    'sentinel',
    'warden',
    'mender',
    'seeker',
    'sage',
  ];

  /// Human-readable display names.
  static const Map<String, String> agentNames = {
    'orchestrator': 'IGRIS',
    'architect': 'ARCHITECT',
    'forger': 'FORGER',
    'sentinel': 'SENTINEL',
    'warden': 'WARDEN',
    'mender': 'MENDER',
    'seeker': 'SEEKER',
    'sage': 'SAGE',
  };

  /// Two-letter monograms for avatar display in nexus cores.
  static const Map<String, String> agentMonograms = {
    'orchestrator': 'IG',
    'architect': 'AR',
    'forger': 'FO',
    'sentinel': 'SE',
    'warden': 'WA',
    'mender': 'ME',
    'seeker': 'SK',
    'sage': 'SA',
  };

  /// Unicode crest watermark glyphs for hex-frame nodes.
  static const Map<String, String> agentCrests = {
    'orchestrator': '\u2B21',
    'architect': '\u2316',
    'forger': '\u2699',
    'sentinel': '\u25C8',
    'warden': '\u25C9',
    'mender': '\u2726',
    'seeker': '\u2295',
    'sage': '\u262F',
  };

  /// Agent tier mapping for roster row sizing.
  static const Map<String, int> agentTiers = {
    'orchestrator': 1,
    'architect': 1,
    'forger': 1,
    'sentinel': 1,
    'warden': 1,
    'mender': 3,
    'seeker': 4,
    'sage': 5,
  };

  /// Agent accent color hex values for roster rows.
  static const Map<String, int> agentColors = {
    'orchestrator': 0xFFFF1744,
    'architect': 0xFF448AFF,
    'forger': 0xFFFF6D00,
    'sentinel': 0xFF00E676,
    'warden': 0xFF7C4DFF,
    'mender': 0xFF00BFA5,
    'seeker': 0xFFFFD600,
    'sage': 0xFFE040FB,
  };

  /// Hunt pipeline phases in execution order.
  static const List<String> huntPhases = [
    'plan',
    'build',
    'test',
    'review',
    'done',
  ];

  /// Maps various brain phase format strings to canonical phase names.
  static const Map<String, String> phaseMap = {
    'PLANNING': 'plan',
    'PLAN': 'plan',
    'BUILDING': 'build',
    'BUILD': 'build',
    'IMPLEMENTING': 'build',
    'TESTING': 'test',
    'TEST': 'test',
    'REVIEWING': 'review',
    'REVIEW': 'review',
    'COMMITTING': 'done',
    'COMPLETE': 'done',
    'DONE': 'done',
  };

  /// Maps agents to their primary pipeline phase.
  static const Map<String, String> agentPhaseMap = {
    'architect': 'plan',
    'forger': 'build',
    'sentinel': 'test',
    'warden': 'review',
  };

  /// Maximum battle log entries to keep in memory.
  static const int maxBattleLog = 50;

  /// Duration (ms) for the green flash after agent completes.
  static const int completeFlashDuration = 10000;
}
