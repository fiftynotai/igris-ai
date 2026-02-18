/// Skill tree definitions for all 7 Igris AI agents.
///
/// Each agent has a unique skill tree reflecting their capabilities,
/// with nodes organized by tier (0-6) and prerequisite dependencies.
/// Skills auto-unlock based on invocation count thresholds.
class AgentSkillTrees {
  AgentSkillTrees._();

  /// Invocation thresholds per tier for auto-unlock.
  ///
  /// Tier 0: 0 invocations (always unlocked)
  /// Tier 1: 5 invocations
  /// Tier 2: 15 invocations
  /// Tier 3: 30 invocations
  /// Tier 4: 60 invocations
  /// Tier 5: 100 invocations
  /// Tier 6: 200 invocations
  static const Map<int, int> tierThresholds = {
    0: 0,
    1: 5,
    2: 15,
    3: 30,
    4: 60,
    5: 100,
    6: 200,
  };

  /// Compute the maximum unlocked tier given an invocation count.
  static int maxUnlockedTier(int invocations) {
    int maxTier = 0;
    for (final entry in tierThresholds.entries) {
      if (invocations >= entry.value) {
        maxTier = entry.key;
      }
    }
    return maxTier;
  }

  /// All skill trees indexed by agent name.
  static Map<String, List<SkillDef>> get all => {
        'architect': architect,
        'forger': forger,
        'sentinel': sentinel,
        'warden': warden,
        'mender': mender,
        'seeker': seeker,
        'sage': sage,
      };

  // ---------------------------------------------------------------------------
  // ARCHITECT - Strategic Planning
  // ---------------------------------------------------------------------------

  static const List<SkillDef> architect = [
    // Tier 0: Trainee
    SkillDef(
      id: 'basic_plan',
      name: 'Basic Planning',
      tier: 0,
      description: 'Create simple implementation plans from briefs',
    ),
    // Tier 1: Novice
    SkillDef(
      id: 'brief_analysis',
      name: 'Brief Analysis',
      tier: 1,
      prereqs: ['basic_plan'],
      description: 'Parse and validate brief requirements',
    ),
    SkillDef(
      id: 'risk_assess',
      name: 'Risk Assessment',
      tier: 1,
      prereqs: ['basic_plan'],
      description: 'Identify potential risks in implementation',
    ),
    // Tier 2: Adept
    SkillDef(
      id: 'dep_mapping',
      name: 'Dependency Mapping',
      tier: 2,
      prereqs: ['brief_analysis'],
      description: 'Map module dependencies and impact',
    ),
    SkillDef(
      id: 'multi_phase',
      name: 'Multi-Phase Plans',
      tier: 2,
      prereqs: ['brief_analysis', 'risk_assess'],
      description: 'Create phased implementation strategies',
    ),
    // Tier 3: Expert
    SkillDef(
      id: 'arch_review',
      name: 'Architecture Review',
      tier: 3,
      prereqs: ['dep_mapping'],
      description: 'Evaluate architectural decisions and trade-offs',
    ),
    // Tier 4: Master
    SkillDef(
      id: 'cross_proj',
      name: 'Cross-Project Planning',
      tier: 4,
      prereqs: ['arch_review', 'multi_phase'],
      description: 'Plan implementations spanning multiple projects',
    ),
    // Tier 5: Legend
    SkillDef(
      id: 'auto_plan',
      name: 'Autonomous Planning',
      tier: 5,
      prereqs: ['cross_proj'],
      description: 'Self-directed plan generation without prompting',
    ),
    // Tier 6: Mythic
    SkillDef(
      id: 'oracle',
      name: 'Oracle Vision',
      tier: 6,
      prereqs: ['auto_plan'],
      description: 'Predictive architecture evolution and future-proofing',
    ),
  ];

  // ---------------------------------------------------------------------------
  // FORGER - Code Implementation
  // ---------------------------------------------------------------------------

  static const List<SkillDef> forger = [
    // Tier 0
    SkillDef(
      id: 'basic_patch',
      name: 'Basic Patching',
      tier: 0,
      description: 'Apply simple code changes to existing files',
    ),
    // Tier 1
    SkillDef(
      id: 'file_creation',
      name: 'File Creation',
      tier: 1,
      prereqs: ['basic_patch'],
      description: 'Generate new source files from scratch',
    ),
    SkillDef(
      id: 'pattern_match',
      name: 'Pattern Matching',
      tier: 1,
      prereqs: ['basic_patch'],
      description: 'Follow existing codebase patterns and conventions',
    ),
    // Tier 2
    SkillDef(
      id: 'multi_file',
      name: 'Multi-File Edits',
      tier: 2,
      prereqs: ['file_creation'],
      description: 'Coordinate changes across multiple files',
    ),
    SkillDef(
      id: 'refactor_safe',
      name: 'Safe Refactoring',
      tier: 2,
      prereqs: ['pattern_match', 'file_creation'],
      description: 'Restructure code while preserving behavior',
    ),
    // Tier 3
    SkillDef(
      id: 'module_forge',
      name: 'Module Forging',
      tier: 3,
      prereqs: ['multi_file'],
      description: 'Create complete feature modules with all layers',
    ),
    // Tier 4
    SkillDef(
      id: 'arch_impl',
      name: 'Architecture Impl',
      tier: 4,
      prereqs: ['module_forge', 'refactor_safe'],
      description: 'Implement complex architectural patterns',
    ),
    // Tier 5
    SkillDef(
      id: 'zero_defect',
      name: 'Zero-Defect Forge',
      tier: 5,
      prereqs: ['arch_impl'],
      description: 'Production-ready code with zero regressions',
    ),
    // Tier 6
    SkillDef(
      id: 'genesis',
      name: 'Genesis Forge',
      tier: 6,
      prereqs: ['zero_defect'],
      description: 'Create entire systems from a single brief',
    ),
  ];

  // ---------------------------------------------------------------------------
  // SENTINEL - Test Execution
  // ---------------------------------------------------------------------------

  static const List<SkillDef> sentinel = [
    // Tier 0
    SkillDef(
      id: 'run_tests',
      name: 'Test Runner',
      tier: 0,
      description: 'Execute existing test suites',
    ),
    // Tier 1
    SkillDef(
      id: 'unit_write',
      name: 'Unit Tests',
      tier: 1,
      prereqs: ['run_tests'],
      description: 'Write unit tests for business logic',
    ),
    SkillDef(
      id: 'error_parse',
      name: 'Error Parsing',
      tier: 1,
      prereqs: ['run_tests'],
      description: 'Parse and categorize test failures',
    ),
    // Tier 2
    SkillDef(
      id: 'integration',
      name: 'Integration Tests',
      tier: 2,
      prereqs: ['unit_write'],
      description: 'Write tests spanning multiple modules',
    ),
    SkillDef(
      id: 'coverage',
      name: 'Coverage Analysis',
      tier: 2,
      prereqs: ['unit_write', 'error_parse'],
      description: 'Track and enforce coverage thresholds',
    ),
    // Tier 3
    SkillDef(
      id: 'edge_cases',
      name: 'Edge Case Hunter',
      tier: 3,
      prereqs: ['integration'],
      description: 'Identify and test boundary conditions',
    ),
    // Tier 4
    SkillDef(
      id: 'regression',
      name: 'Regression Shield',
      tier: 4,
      prereqs: ['edge_cases', 'coverage'],
      description: 'Prevent regression through targeted tests',
    ),
    // Tier 5
    SkillDef(
      id: 'auto_heal',
      name: 'Auto-Heal Tests',
      tier: 5,
      prereqs: ['regression'],
      description: 'Self-repair broken tests after refactors',
    ),
    // Tier 6
    SkillDef(
      id: 'omniscient',
      name: 'Omniscient Guard',
      tier: 6,
      prereqs: ['auto_heal'],
      description: 'Predict failures before code is written',
    ),
  ];

  // ---------------------------------------------------------------------------
  // WARDEN - Code Review & Audit
  // ---------------------------------------------------------------------------

  static const List<SkillDef> warden = [
    // Tier 0
    SkillDef(
      id: 'basic_review',
      name: 'Basic Review',
      tier: 0,
      description: 'Check code for obvious issues and style violations',
    ),
    // Tier 1
    SkillDef(
      id: 'lint_enforce',
      name: 'Lint Enforcement',
      tier: 1,
      prereqs: ['basic_review'],
      description: 'Ensure all linter rules are satisfied',
    ),
    SkillDef(
      id: 'pattern_check',
      name: 'Pattern Check',
      tier: 1,
      prereqs: ['basic_review'],
      description: 'Verify adherence to coding guidelines',
    ),
    // Tier 2
    SkillDef(
      id: 'security_scan',
      name: 'Security Scan',
      tier: 2,
      prereqs: ['lint_enforce'],
      description: 'Detect potential security vulnerabilities',
    ),
    SkillDef(
      id: 'perf_audit',
      name: 'Performance Audit',
      tier: 2,
      prereqs: ['pattern_check', 'lint_enforce'],
      description: 'Identify performance bottlenecks',
    ),
    // Tier 3
    SkillDef(
      id: 'arch_enforce',
      name: 'Architecture Guard',
      tier: 3,
      prereqs: ['security_scan'],
      description: 'Enforce layer boundaries and architecture rules',
    ),
    // Tier 4
    SkillDef(
      id: 'deep_audit',
      name: 'Deep Audit',
      tier: 4,
      prereqs: ['arch_enforce', 'perf_audit'],
      description: 'Full codebase quality assessment',
    ),
    // Tier 5
    SkillDef(
      id: 'auto_fix',
      name: 'Auto-Fix Issues',
      tier: 5,
      prereqs: ['deep_audit'],
      description: 'Automatically resolve identified issues',
    ),
    // Tier 6
    SkillDef(
      id: 'iron_gate',
      name: 'Iron Gate',
      tier: 6,
      prereqs: ['auto_fix'],
      description: 'Impenetrable quality barrier -- zero issues pass',
    ),
  ];

  // ---------------------------------------------------------------------------
  // MENDER - Error Recovery
  // ---------------------------------------------------------------------------

  static const List<SkillDef> mender = [
    // Tier 0
    SkillDef(
      id: 'read_errors',
      name: 'Error Reading',
      tier: 0,
      description: 'Parse error messages and stack traces',
    ),
    // Tier 1
    SkillDef(
      id: 'quick_fix',
      name: 'Quick Fix',
      tier: 1,
      prereqs: ['read_errors'],
      description: 'Apply simple one-line fixes',
    ),
    SkillDef(
      id: 'root_cause',
      name: 'Root Cause',
      tier: 1,
      prereqs: ['read_errors'],
      description: 'Trace errors to their origin',
    ),
    // Tier 2
    SkillDef(
      id: 'multi_fix',
      name: 'Multi-Fix',
      tier: 2,
      prereqs: ['quick_fix'],
      description: 'Resolve cascading errors simultaneously',
    ),
    SkillDef(
      id: 'dep_resolve',
      name: 'Dep Resolution',
      tier: 2,
      prereqs: ['root_cause', 'quick_fix'],
      description: 'Fix dependency conflicts and version issues',
    ),
    // Tier 3
    SkillDef(
      id: 'regression_fix',
      name: 'Regression Mend',
      tier: 3,
      prereqs: ['multi_fix'],
      description: 'Fix issues without introducing new ones',
    ),
    // Tier 4
    SkillDef(
      id: 'self_heal',
      name: 'Self-Heal Loop',
      tier: 4,
      prereqs: ['regression_fix', 'dep_resolve'],
      description: 'Iterative fix-test-fix until green',
    ),
    // Tier 5
    SkillDef(
      id: 'prevention',
      name: 'Prevention Mode',
      tier: 5,
      prereqs: ['self_heal'],
      description: 'Predict and prevent errors before they occur',
    ),
    // Tier 6
    SkillDef(
      id: 'phoenix',
      name: 'Phoenix Protocol',
      tier: 6,
      prereqs: ['prevention'],
      description: 'Resurrect any codebase from any error state',
    ),
  ];

  // ---------------------------------------------------------------------------
  // SEEKER - Codebase Research
  // ---------------------------------------------------------------------------

  static const List<SkillDef> seeker = [
    // Tier 0
    SkillDef(
      id: 'basic_search',
      name: 'Basic Search',
      tier: 0,
      description: 'Find files and patterns in the codebase',
    ),
    // Tier 1
    SkillDef(
      id: 'pattern_find',
      name: 'Pattern Finder',
      tier: 1,
      prereqs: ['basic_search'],
      description: 'Locate usage patterns and conventions',
    ),
    SkillDef(
      id: 'dep_trace',
      name: 'Dependency Trace',
      tier: 1,
      prereqs: ['basic_search'],
      description: 'Follow import chains and dependencies',
    ),
    // Tier 2
    SkillDef(
      id: 'impact_analysis',
      name: 'Impact Analysis',
      tier: 2,
      prereqs: ['pattern_find'],
      description: 'Determine blast radius of changes',
    ),
    SkillDef(
      id: 'api_map',
      name: 'API Mapping',
      tier: 2,
      prereqs: ['dep_trace', 'pattern_find'],
      description: 'Document API surfaces and contracts',
    ),
    // Tier 3
    SkillDef(
      id: 'cross_ref',
      name: 'Cross-Reference',
      tier: 3,
      prereqs: ['impact_analysis'],
      description: 'Build comprehensive reference graphs',
    ),
    // Tier 4
    SkillDef(
      id: 'deep_dive',
      name: 'Deep Dive',
      tier: 4,
      prereqs: ['cross_ref', 'api_map'],
      description: 'Exhaustive investigation of complex systems',
    ),
    // Tier 5
    SkillDef(
      id: 'knowledge_synth',
      name: 'Knowledge Synth',
      tier: 5,
      prereqs: ['deep_dive'],
      description: 'Synthesize findings into actionable insights',
    ),
    // Tier 6
    SkillDef(
      id: 'all_seeing',
      name: 'All-Seeing Eye',
      tier: 6,
      prereqs: ['knowledge_synth'],
      description: 'Instant awareness of entire codebase state',
    ),
  ];

  // ---------------------------------------------------------------------------
  // SAGE - Flutter MVVM + Actions
  // ---------------------------------------------------------------------------

  static const List<SkillDef> sage = [
    // Tier 0
    SkillDef(
      id: 'basic_widget',
      name: 'Basic Widgets',
      tier: 0,
      description: 'Create simple Flutter widgets',
    ),
    // Tier 1
    SkillDef(
      id: 'mvvm_pattern',
      name: 'MVVM Pattern',
      tier: 1,
      prereqs: ['basic_widget'],
      description: 'Implement ViewModel + View separation',
    ),
    SkillDef(
      id: 'actions_layer',
      name: 'Actions Layer',
      tier: 1,
      prereqs: ['basic_widget'],
      description: 'Create ActionPresenter for UX concerns',
    ),
    // Tier 2
    SkillDef(
      id: 'api_response',
      name: 'ApiResponse Flow',
      tier: 2,
      prereqs: ['mvvm_pattern'],
      description: 'Use ApiResponse pattern for async state',
    ),
    SkillDef(
      id: 'full_module',
      name: 'Full Module',
      tier: 2,
      prereqs: ['mvvm_pattern', 'actions_layer'],
      description: 'Create complete feature modules',
    ),
    // Tier 3
    SkillDef(
      id: 'complex_ui',
      name: 'Complex UI',
      tier: 3,
      prereqs: ['api_response'],
      description: 'Build sophisticated interactive interfaces',
    ),
    // Tier 4
    SkillDef(
      id: 'cross_module',
      name: 'Cross-Module',
      tier: 4,
      prereqs: ['complex_ui', 'full_module'],
      description: 'Coordinate state across feature modules',
    ),
    // Tier 5
    SkillDef(
      id: 'arch_mastery',
      name: 'Architecture Mastery',
      tier: 5,
      prereqs: ['cross_module'],
      description: 'Full command of MVVM + Actions architecture',
    ),
    // Tier 6
    SkillDef(
      id: 'enlightened',
      name: 'Enlightened Sage',
      tier: 6,
      prereqs: ['arch_mastery'],
      description: 'Transcendent Flutter mastery -- any UI, any pattern',
    ),
  ];
}

/// Definition of a single skill node for agent skill trees.
class SkillDef {
  /// Unique ID within the agent's skill tree.
  final String id;

  /// Human-readable skill name.
  final String name;

  /// Tier level (0 = Trainee, 6 = Mythic).
  final int tier;

  /// IDs of prerequisite skills that must be unlocked first.
  final List<String> prereqs;

  /// Description of what this skill represents.
  final String? description;

  const SkillDef({
    required this.id,
    required this.name,
    required this.tier,
    this.prereqs = const [],
    this.description,
  });
}
