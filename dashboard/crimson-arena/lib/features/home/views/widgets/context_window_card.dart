import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../data/models/context_window_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../../../shared/widgets/segmented_bar.dart';
import '../../controllers/home_view_model.dart';

/// Context Window (Digivice) card.
///
/// Displays current context window usage as a segmented progress bar
/// with percentage, token count, and model identifier.
/// Color transitions: normal < 60%, transition 60-80%, warning 80-90%,
/// overflow > 90%.
class ContextWindowCard extends StatelessWidget {
  const ContextWindowCard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final ctx = vm.contextWindow.value;

      if (ctx == null) {
        return ArenaCard(
          title: 'DATA LOAD',
          child: Text(
            'No context data available',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      final percentage = ctx.usagePercent;
      final barColor = _barColor(context, percentage);
      final label = percentage >= 90 ? 'DATA OVERFLOW' : 'DATA LOAD';

      return ArenaCard(
        title: label,
        trailing: Text(
          '${percentage.toStringAsFixed(1)}%',
          style: textTheme.titleSmall!.copyWith(
            fontWeight: FiftyTypography.extraBold,
            color: barColor,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Segmented bar
            SegmentedBar(
              percentage: percentage,
              color: barColor,
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Token count
            Text(
              '${FormatUtils.formatNumber(ctx.contextUsed)} / '
              '${FormatUtils.formatNumber(ctx.contextMax)} ctx',
              style: textTheme.bodySmall!.copyWith(
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Model and orchestrator tags
            _DigiviceTags(vm: vm, model: ctx.modelShortName),
          ],
        ),
      );
    });
  }

  Color _barColor(BuildContext context, double percentage) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    if (percentage >= 90) return colorScheme.primary;
    if (percentage >= 80) return ext.warning;
    if (percentage >= 60) return colorScheme.onSurfaceVariant;
    return ext.success;
  }
}

/// Tags showing orchestrator cache/input/output token breakdown.
class _DigiviceTags extends StatelessWidget {
  final HomeViewModel vm;
  final String model;

  const _DigiviceTags({required this.vm, required this.model});

  @override
  Widget build(BuildContext context) {
    final orch = vm.agents['orchestrator'];

    return Wrap(
      spacing: FiftySpacing.sm,
      runSpacing: FiftySpacing.xs,
      children: [
        _Tag(text: model),
        if (orch != null) ...[
          _Tag(
            text: 'cache:${FormatUtils.formatTokens(orch.totalCacheReadTokens)}',
          ),
          _Tag(
            text: 'in:${FormatUtils.formatTokens(orch.totalInputTokens)}',
          ),
          _Tag(
            text: 'out:${FormatUtils.formatTokens(orch.totalOutputTokens)}',
          ),
        ],
      ],
    );
  }
}

/// A small info tag.
class _Tag extends StatelessWidget {
  final String text;

  const _Tag({required this.text});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.xs,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: colorScheme.onSurface.withValues(alpha: 0.05),
        borderRadius: FiftyRadii.smRadius,
      ),
      child: Text(
        '[$text]',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.medium,
          color: colorScheme.onSurface.withValues(alpha: 0.4),
        ),
      ),
    );
  }
}
