import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Knowledge Panel.
///
/// Displays brain knowledge base statistics: learnings count,
/// errors count, patterns count, and a list of recent knowledge entries.
class KnowledgePanel extends StatelessWidget {
  const KnowledgePanel({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final learnings = vm.knowledgeLearnings.value;
      final errors = vm.knowledgeErrors.value;
      final patterns = vm.knowledgePatterns.value;
      final recent = vm.knowledgeRecent;

      return ArenaCard(
        title: 'KNOWLEDGE BASE',
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Stats row
            Row(
              children: [
                _KnowledgeStat(
                  label: 'LEARNINGS',
                  count: learnings,
                  color: FiftyColors.hunterGreen,
                ),
                const SizedBox(width: FiftySpacing.lg),
                _KnowledgeStat(
                  label: 'ERRORS',
                  count: errors,
                  color: FiftyColors.burgundy,
                ),
                const SizedBox(width: FiftySpacing.lg),
                _KnowledgeStat(
                  label: 'PATTERNS',
                  count: patterns,
                  color: FiftyColors.slateGrey,
                ),
              ],
            ),

            if (recent.isNotEmpty) ...[
              const SizedBox(height: FiftySpacing.sm),
              Divider(height: 1, color: FiftyColors.borderDark),
              const SizedBox(height: FiftySpacing.sm),

              // Recent entries
              ...recent.take(5).map((item) => _KnowledgeEntry(data: item)),
            ],

            if (recent.isEmpty && learnings == 0)
              Padding(
                padding: const EdgeInsets.only(top: FiftySpacing.sm),
                child: Text(
                  '> No learnings recorded',
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.bodySmall,
                    color: FiftyColors.slateGrey,
                  ),
                ),
              ),
          ],
        ),
      );
    });
  }
}

/// A single knowledge stat (label + count).
class _KnowledgeStat extends StatelessWidget {
  final String label;
  final int count;
  final Color color;

  const _KnowledgeStat({
    required this.label,
    required this.count,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.semiBold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          FormatUtils.formatNumber(count),
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.titleSmall,
            fontWeight: FiftyTypography.extraBold,
            color: color,
          ),
        ),
      ],
    );
  }
}

/// A recent knowledge entry row.
class _KnowledgeEntry extends StatelessWidget {
  final Map<String, dynamic> data;

  const _KnowledgeEntry({required this.data});

  @override
  Widget build(BuildContext context) {
    final title = data['title'] as String? ?? '--';
    final category = data['category'] as String? ?? 'general';
    final createdAt = data['created_at'] as String?;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Title
          Expanded(
            child: Text(
              title,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.7),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Category badge
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: FiftySpacing.xs,
              vertical: 1,
            ),
            decoration: BoxDecoration(
              color: FiftyColors.slateGrey.withValues(alpha: 0.15),
              borderRadius: FiftyRadii.smRadius,
            ),
            child: Text(
              category,
              style: GoogleFonts.manrope(
                fontSize: 8,
                fontWeight: FiftyTypography.semiBold,
                color: FiftyColors.slateGrey,
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Time
          Text(
            FormatUtils.timeAgo(createdAt),
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.3),
            ),
          ),
        ],
      ),
    );
  }
}
