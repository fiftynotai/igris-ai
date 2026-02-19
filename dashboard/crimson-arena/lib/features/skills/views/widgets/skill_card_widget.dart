import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../core/constants/arena_colors.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../core/constants/skill_constants.dart';
import '../../../../core/theme/arena_text_styles.dart';
import '../../../../data/models/skill_card_model.dart';
import '../../../../shared/utils/format_utils.dart';

/// RPG game-style skill card widget.
///
/// Displays a single skill as an ornate collectible card with:
/// - Category badge (top-left) with category color + icon
/// - Rarity badge (top-right) with rarity-colored label
/// - Skill name in monospace
/// - Description (2 lines max)
/// - Divider
/// - Invocation count + usage progress bar
/// - Agent monograms (tiny circles with 2-letter codes)
///
/// Hover effect: border glows with rarity color, subtle elevation.
class SkillCardWidget extends StatefulWidget {
  /// The skill card model containing metadata and live data.
  final SkillCardModel model;

  /// Maximum invocations across all skills (for usage bar normalization).
  final int maxInvocations;

  const SkillCardWidget({
    super.key,
    required this.model,
    required this.maxInvocations,
  });

  @override
  State<SkillCardWidget> createState() => _SkillCardWidgetState();
}

class _SkillCardWidgetState extends State<SkillCardWidget> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final model = widget.model;

    final categoryColor =
        SkillConstants.categoryColorMap[model.category] ??
            ArenaColors.categorySystem;
    final rarityColor = _rarityColor(model.rarity);
    final borderColor =
        _hovered ? rarityColor.withValues(alpha: 0.6) : rarityColor.withValues(alpha: 0.3);

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      cursor: SystemMouseCursors.click,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
        padding: const EdgeInsets.all(FiftySpacing.md),
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainerHighest,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: borderColor,
            width: ArenaSizes.skillCardBorderWidth,
          ),
          boxShadow: _hovered
              ? [
                  BoxShadow(
                    color: rarityColor.withValues(alpha: 0.2),
                    blurRadius: 16,
                    spreadRadius: 2,
                  ),
                ]
              : null,
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Top row: category badge + rarity badge
            _buildTopRow(context, model, categoryColor, rarityColor),

            const SizedBox(height: FiftySpacing.sm),

            // Skill name
            Text(
              '/${model.name}'.toUpperCase(),
              style: ArenaTextStyles.mono(
                context,
                fontSize: 14,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.2,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),

            const SizedBox(height: FiftySpacing.xs),

            // Description
            Expanded(
              child: Text(
                model.description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.regular,
                  color: colorScheme.onSurfaceVariant.withValues(alpha: 0.8),
                  height: 1.3,
                ),
              ),
            ),

            // Divider
            Container(
              height: 1,
              color: colorScheme.outline.withValues(alpha: 0.3),
            ),

            const SizedBox(height: FiftySpacing.sm),

            // Stats: INVOCATIONS label + count
            _buildStatsRow(context, model),

            const SizedBox(height: FiftySpacing.xs),

            // Usage bar
            _buildUsageBar(context, model, categoryColor),

            // Agent monograms (only if skill invokes agents)
            if (model.agents.isNotEmpty) ...[
              const SizedBox(height: FiftySpacing.sm),
              _buildAgentMonograms(context, model),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildTopRow(
    BuildContext context,
    SkillCardModel model,
    Color categoryColor,
    Color rarityColor,
  ) {
    final theme = Theme.of(context);
    final textTheme = theme.textTheme;

    return Row(
      children: [
        // Category badge
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: FiftySpacing.xs,
            vertical: 2,
          ),
          decoration: BoxDecoration(
            color: categoryColor.withValues(alpha: 0.15),
            borderRadius: FiftyRadii.smRadius,
            border: Border.all(
              color: categoryColor.withValues(alpha: 0.3),
              width: 1,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                SkillConstants.categoryIcons[model.category] ?? Icons.category,
                size: 12,
                color: categoryColor,
              ),
              const SizedBox(width: 4),
              Text(
                model.category.name.toUpperCase(),
                style: textTheme.labelSmall!.copyWith(
                  fontSize: 10,
                  fontWeight: FiftyTypography.bold,
                  color: categoryColor,
                  letterSpacing: FiftyTypography.letterSpacingLabel,
                ),
              ),
            ],
          ),
        ),

        const Spacer(),

        // Rarity badge
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: FiftySpacing.xs,
            vertical: 2,
          ),
          decoration: BoxDecoration(
            color: rarityColor.withValues(alpha: 0.15),
            borderRadius: FiftyRadii.smRadius,
            border: Border.all(
              color: rarityColor.withValues(alpha: 0.3),
              width: 1,
            ),
          ),
          child: Text(
            model.rarity.displayName.toUpperCase(),
            style: textTheme.labelSmall!.copyWith(
              fontSize: 10,
              fontWeight: FiftyTypography.bold,
              color: rarityColor,
              letterSpacing: FiftyTypography.letterSpacingLabel,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildStatsRow(BuildContext context, SkillCardModel model) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          'INVOCATIONS',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.3),
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          FormatUtils.formatNumber(model.invocations),
          style: ArenaTextStyles.mono(
            context,
            fontSize: 13,
            fontWeight: FontWeight.w700,
            color: colorScheme.onSurface.withValues(alpha: 0.8),
          ),
        ),
      ],
    );
  }

  Widget _buildUsageBar(
    BuildContext context,
    SkillCardModel model,
    Color categoryColor,
  ) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final maxInvocations = widget.maxInvocations;
    final progress =
        maxInvocations > 0 ? (model.invocations / maxInvocations).clamp(0.0, 1.0) : 0.0;

    return SizedBox(
      height: ArenaSizes.skillCardUsageBarHeight,
      child: ClipRRect(
        borderRadius: FiftyRadii.smRadius,
        child: LinearProgressIndicator(
          value: progress,
          backgroundColor: colorScheme.onSurface.withValues(alpha: 0.05),
          valueColor: AlwaysStoppedAnimation<Color>(categoryColor),
        ),
      ),
    );
  }

  Widget _buildAgentMonograms(BuildContext context, SkillCardModel model) {
    final theme = Theme.of(context);
    final textTheme = theme.textTheme;
    final colorScheme = theme.colorScheme;

    return Row(
      children: [
        Text(
          'AGENTS',
          style: textTheme.labelSmall!.copyWith(
            fontSize: 10,
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.3),
            letterSpacing: FiftyTypography.letterSpacingLabel,
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),
        ...model.agents.map((agentName) {
          final color = Color(
            AgentConstants.agentColors[agentName] ?? 0xFF888888,
          );
          final monogram =
              AgentConstants.agentMonograms[agentName] ??
                  agentName.substring(0, 2).toUpperCase();

          return Padding(
            padding: const EdgeInsets.only(right: 4),
            child: Container(
              width: ArenaSizes.skillCardMonogramSize,
              height: ArenaSizes.skillCardMonogramSize,
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
                  monogram,
                  style: textTheme.labelSmall!.copyWith(
                    fontSize: 9,
                    fontWeight: FiftyTypography.extraBold,
                    color: color,
                  ),
                ),
              ),
            ),
          );
        }),
      ],
    );
  }

  /// Map [SkillRarity] to a glow/border color matching the rarity theme.
  Color _rarityColor(SkillRarity rarity) {
    switch (rarity) {
      case SkillRarity.common:
        return FiftyColors.slateGrey;
      case SkillRarity.uncommon:
        return FiftyColors.hunterGreen;
      case SkillRarity.rare:
        return FiftyColors.powderBlush;
      case SkillRarity.epic:
        return FiftyColors.burgundy;
      case SkillRarity.legendary:
        return ArenaColors.legendaryGold;
    }
  }
}
