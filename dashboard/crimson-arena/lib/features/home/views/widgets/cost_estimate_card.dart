import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Cost Estimate card.
///
/// Shows a breakdown of estimated cost by token type (input, output,
/// cache read, cache write) with per-MTok rates and totals.
class CostEstimateCard extends StatelessWidget {
  const CostEstimateCard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final cost = vm.costEstimate;
      final rates = vm.currentRates;
      final hasPricing = vm.hasPricing;

      if (!hasPricing || cost == null) {
        return ArenaCard(
          title: 'COST ESTIMATE',
          child: Text(
            'No pricing data available',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      final modelName = vm.modelShortName;
      final rangeLabel = vm.rangeLabel;

      return ArenaCard(
        title: 'COST ESTIMATE',
        trailing: Text(
          '$rangeLabel ($modelName)',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Input
            _CostRow(
              label: 'Input',
              tokens: vm.totalInputTokens.value,
              rate: rates?.inputCostPerToken ?? 0,
              amount: cost.inputCost,
              color: ext.accent,
            ),
            // Output
            _CostRow(
              label: 'Output',
              tokens: vm.totalOutputTokens.value,
              rate: rates?.outputCostPerToken ?? 0,
              amount: cost.outputCost,
              color: colorScheme.primary,
            ),

            // Separator
            Padding(
              padding: const EdgeInsets.symmetric(
                vertical: FiftySpacing.xs,
              ),
              child: Divider(
                height: 1,
                color: colorScheme.outline,
              ),
            ),

            // Cache Read
            _CostRow(
              label: 'Cache Rd',
              tokens: vm.totalCacheReadTokens.value,
              rate: rates?.cacheReadInputTokenCost ?? 0,
              amount: cost.cacheReadCost,
              color: ext.success,
            ),
            // Cache Write
            _CostRow(
              label: 'Cache Wr',
              tokens: vm.totalCacheCreateTokens.value,
              rate: rates?.cacheCreationInputTokenCost ?? 0,
              amount: cost.cacheCreateCost,
              color: colorScheme.onSurfaceVariant,
            ),

            // Total
            const SizedBox(height: FiftySpacing.sm),
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Text(
                  'Estimated Total',
                  style: textTheme.labelLarge!.copyWith(
                    color: colorScheme.onSurface,
                  ),
                ),
                Text(
                  FormatUtils.formatCost(cost.total),
                  style: textTheme.titleMedium!.copyWith(
                    fontWeight: FiftyTypography.extraBold,
                    color: colorScheme.onSurface,
                  ),
                ),
              ],
            ),
          ],
        ),
      );
    });
  }
}

/// A single cost breakdown row.
class _CostRow extends StatelessWidget {
  final String label;
  final int tokens;
  final double rate;
  final double amount;
  final Color color;

  const _CostRow({
    required this.label,
    required this.tokens,
    required this.rate,
    required this.amount,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Label with color dot
          Container(
            width: ArenaSizes.costDotSize,
            height: ArenaSizes.costDotSize,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          SizedBox(
            width: ArenaSizes.tokenBarLabelWidth,
            child: Text(
              label,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurface.withValues(alpha: 0.6),
              ),
            ),
          ),

          // Tokens x Rate
          Expanded(
            child: Text(
              '${FormatUtils.formatTokens(tokens)} x ${FormatUtils.formatRate(rate)}',
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurface.withValues(alpha: 0.3),
              ),
            ),
          ),

          // Amount
          Text(
            FormatUtils.formatCost(amount),
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.bold,
              color: color,
            ),
          ),
        ],
      ),
    );
  }
}
