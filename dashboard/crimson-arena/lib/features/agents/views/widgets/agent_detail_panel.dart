import 'package:fifty_skill_tree/fifty_skill_tree.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../core/constants/agent_skill_trees.dart';
import '../../../../data/models/agent_model.dart';
import '../../controllers/agents_view_model.dart';

/// Interactive skill tree panel for the selected agent.
///
/// Uses the `fifty_skill_tree` package to render a vertical skill tree
/// with nodes colored by state:
/// - Unlocked: filled with agent accent color
/// - Locked: grey/outlined
/// - Available (next to unlock): bordered with accent color
///
/// Flow runs from bottom (Tier 0 - Trainee) to top (Tier 6 - Mythic).
class AgentDetailPanel extends StatelessWidget {
  const AgentDetailPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AgentsViewModel>();

    return Obx(() {
      final agentName = vm.selectedAgent.value;
      if (agentName == null) return const SizedBox.shrink();

      final agent = vm.agents[agentName];
      final color = Color(
        AgentConstants.agentColors[agentName] ?? 0xFF888888,
      );
      final displayName =
          AgentConstants.agentNames[agentName] ?? agentName.toUpperCase();
      final skillDefs = AgentSkillTrees.all[agentName] ?? [];
      final invocations = agent?.invocations ?? 0;
      final maxTier = AgentSkillTrees.maxUnlockedTier(invocations);

      return Container(
        decoration: BoxDecoration(
          color: FiftyColors.surfaceDark,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: color.withValues(alpha: 0.2),
            width: 1,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Header
            Padding(
              padding: const EdgeInsets.all(FiftySpacing.md),
              child: Row(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color.withValues(alpha: 0.15),
                      border: Border.all(
                        color: color.withValues(alpha: 0.4),
                        width: 1,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        AgentConstants.agentMonograms[agentName] ?? 'AG',
                        style: GoogleFonts.manrope(
                          fontSize: FiftyTypography.labelMedium,
                          fontWeight: FiftyTypography.extraBold,
                          color: color,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: FiftySpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '$displayName SKILL TREE',
                          style: GoogleFonts.manrope(
                            fontSize: FiftyTypography.labelMedium,
                            fontWeight: FiftyTypography.bold,
                            color: FiftyColors.cream,
                            letterSpacing:
                                FiftyTypography.letterSpacingLabelMedium,
                          ),
                        ),
                        Text(
                          'Tier $maxTier unlocked  |  $invocations invocations',
                          style: GoogleFonts.manrope(
                            fontSize: FiftyTypography.labelSmall,
                            fontWeight: FiftyTypography.medium,
                            color: FiftyColors.slateGrey,
                          ),
                        ),
                      ],
                    ),
                  ),
                  // Next tier progress
                  if (maxTier < 6) _NextTierBadge(
                    invocations: invocations,
                    currentTier: maxTier,
                    color: color,
                  ),
                ],
              ),
            ),

            // Divider
            Container(
              height: 1,
              color: FiftyColors.borderDark,
            ),

            // Skill tree
            Expanded(
              child: _SkillTreeContent(
                agentName: agentName,
                skillDefs: skillDefs,
                maxUnlockedTier: maxTier,
                agentColor: color,
                agent: agent,
              ),
            ),
          ],
        ),
      );
    });
  }
}

/// Badge showing progress to the next tier.
class _NextTierBadge extends StatelessWidget {
  final int invocations;
  final int currentTier;
  final Color color;

  const _NextTierBadge({
    required this.invocations,
    required this.currentTier,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final nextTier = currentTier + 1;
    final nextThreshold = AgentSkillTrees.tierThresholds[nextTier] ?? 999;
    final currentThreshold =
        AgentSkillTrees.tierThresholds[currentTier] ?? 0;
    final progress = (invocations - currentThreshold) /
        (nextThreshold - currentThreshold).clamp(1, 999);

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: FiftySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: color.withValues(alpha: 0.15),
          width: 1,
        ),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'NEXT T$nextTier',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.semiBold,
              color: color.withValues(alpha: 0.6),
              letterSpacing: FiftyTypography.letterSpacingLabel,
            ),
          ),
          const SizedBox(height: 2),
          SizedBox(
            width: 48,
            height: 3,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: progress.clamp(0, 1).toDouble(),
                backgroundColor: FiftyColors.cream.withValues(alpha: 0.05),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            '$invocations/$nextThreshold',
            style: GoogleFonts.manrope(
              fontSize: 8,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
    );
  }
}

/// Renders the skill tree using `fifty_skill_tree` SkillTreeView.
class _SkillTreeContent extends StatefulWidget {
  final String agentName;
  final List<SkillDef> skillDefs;
  final int maxUnlockedTier;
  final Color agentColor;
  final AgentModel? agent;

  const _SkillTreeContent({
    required this.agentName,
    required this.skillDefs,
    required this.maxUnlockedTier,
    required this.agentColor,
    this.agent,
  });

  @override
  State<_SkillTreeContent> createState() => _SkillTreeContentState();
}

class _SkillTreeContentState extends State<_SkillTreeContent> {
  late SkillTreeController<void> _controller;

  @override
  void initState() {
    super.initState();
    _buildTree();
  }

  @override
  void didUpdateWidget(_SkillTreeContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.agentName != widget.agentName ||
        oldWidget.maxUnlockedTier != widget.maxUnlockedTier) {
      _buildTree();
    }
  }

  void _buildTree() {
    final tree = SkillTree<void>(
      id: widget.agentName,
      name: '${widget.agentName} Skills',
    );

    // Add all nodes
    for (final def in widget.skillDefs) {
      final isUnlocked = def.tier <= widget.maxUnlockedTier;
      tree.addNode(SkillNode<void>(
        id: def.id,
        name: def.name,
        description: def.description,
        tier: def.tier,
        prerequisites: def.prereqs,
        currentLevel: isUnlocked ? 1 : 0,
        maxLevel: 1,
        costs: const [1],
      ));
    }

    // Add connections from prerequisites
    for (final def in widget.skillDefs) {
      for (final prereqId in def.prereqs) {
        tree.addConnection(SkillConnection(
          fromId: prereqId,
          toId: def.id,
        ));
      }
    }

    // Give enough points to unlock available nodes
    tree.setPoints(100);

    final theme = SkillTreeTheme.dark().copyWith(
      lockedNodeColor: const Color(0xFF1A1015),
      lockedNodeBorderColor: const Color(0xFF3A2A30),
      availableNodeColor: widget.agentColor.withValues(alpha: 0.15),
      availableNodeBorderColor: widget.agentColor.withValues(alpha: 0.6),
      unlockedNodeColor: widget.agentColor.withValues(alpha: 0.25),
      unlockedNodeBorderColor: widget.agentColor,
      maxedNodeColor: widget.agentColor.withValues(alpha: 0.25),
      maxedNodeBorderColor: widget.agentColor,
      connectionLockedColor: const Color(0xFF3A2A30),
      connectionUnlockedColor: widget.agentColor.withValues(alpha: 0.5),
      connectionHighlightColor: widget.agentColor,
      nodeRadius: 24.0,
      nodeBorderWidth: 2.0,
      connectionWidth: 1.5,
      nodeNameStyle: GoogleFonts.manrope(
        fontSize: 9,
        fontWeight: FiftyTypography.bold,
        color: FiftyColors.cream,
      ),
      nodeLevelStyle: GoogleFonts.manrope(
        fontSize: 8,
        fontWeight: FiftyTypography.semiBold,
        color: FiftyColors.cream.withValues(alpha: 0.6),
      ),
      tooltipTitleStyle: GoogleFonts.manrope(
        fontSize: FiftyTypography.bodyMedium,
        fontWeight: FiftyTypography.bold,
        color: FiftyColors.cream,
      ),
      tooltipDescriptionStyle: GoogleFonts.manrope(
        fontSize: FiftyTypography.bodySmall,
        color: FiftyColors.slateGrey,
      ),
      tooltipBackground: FiftyColors.surfaceDark,
      tooltipBorder: FiftyColors.borderDark,
    );

    _controller = SkillTreeController<void>(
      tree: tree,
      theme: theme,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(FiftySpacing.sm),
      child: Column(
        children: [
          // Tier legend
          _TierLegend(
            maxUnlockedTier: widget.maxUnlockedTier,
            color: widget.agentColor,
          ),
          const SizedBox(height: FiftySpacing.sm),
          // Skill tree view
          Expanded(
            child: SkillTreeView<void>(
              controller: _controller,
              layout: const VerticalTreeLayout(
                alignment: TreeAlignment.center,
                rootAtTop: false,
              ),
              nodeSize: const Size(48, 48),
              nodeSeparation: 32,
              levelSeparation: 60,
              connectionCurved: true,
              enablePan: true,
              enableZoom: true,
              minZoom: 0.6,
              maxZoom: 1.5,
              padding: const EdgeInsets.symmetric(
                horizontal: FiftySpacing.md,
                vertical: FiftySpacing.lg,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Tier legend strip showing tier names and unlock thresholds.
class _TierLegend extends StatelessWidget {
  final int maxUnlockedTier;
  final Color color;

  const _TierLegend({required this.maxUnlockedTier, required this.color});

  static const _tierNames = [
    'Trainee',
    'Novice',
    'Adept',
    'Expert',
    'Master',
    'Legend',
    'Mythic',
  ];

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 20,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: _tierNames.length,
        separatorBuilder: (_, __) => const SizedBox(width: FiftySpacing.xs),
        itemBuilder: (_, index) {
          final isUnlocked = index <= maxUnlockedTier;
          final threshold = AgentSkillTrees.tierThresholds[index] ?? 0;
          return Container(
            padding: const EdgeInsets.symmetric(
              horizontal: FiftySpacing.sm,
              vertical: 2,
            ),
            decoration: BoxDecoration(
              color: isUnlocked
                  ? color.withValues(alpha: 0.1)
                  : Colors.transparent,
              borderRadius: FiftyRadii.smRadius,
              border: Border.all(
                color: isUnlocked
                    ? color.withValues(alpha: 0.3)
                    : FiftyColors.borderDark,
                width: 1,
              ),
            ),
            child: Text(
              'T$index ${_tierNames[index]} ${threshold > 0 ? "($threshold)" : ""}',
              style: GoogleFonts.manrope(
                fontSize: 8,
                fontWeight:
                    isUnlocked ? FiftyTypography.bold : FiftyTypography.medium,
                color: isUnlocked
                    ? color
                    : FiftyColors.cream.withValues(alpha: 0.3),
              ),
            ),
          );
        },
      ),
    );
  }
}
