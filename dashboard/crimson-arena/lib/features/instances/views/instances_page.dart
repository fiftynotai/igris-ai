import 'package:crimson_arena/core/constants/arena_breakpoints.dart';
import 'package:crimson_arena/core/theme/arena_text_styles.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../shared/widgets/arena_scaffold.dart';
import '../controllers/instances_view_model.dart';
import 'widgets/agent_nexus_table.dart';
import 'widgets/compact_vitals_strip.dart';
import 'widgets/execution_log_widget.dart';
import 'widgets/hunt_pipeline_widget.dart';
import 'widgets/instance_card.dart';
import 'widgets/team_mode_widget.dart';

/// Instances page -- the operations floor showing real-time instance tracking.
///
/// Displays a compact vitals strip at the top, an instances header with
/// count badges, and a scrollable list of instance cards. Each card can
/// be expanded to show the hunt pipeline, agent nexus table, execution
/// log, and team mode widget (if applicable).
class InstancesPage extends StatefulWidget {
  const InstancesPage({super.key});

  @override
  State<InstancesPage> createState() => _InstancesPageState();
}

class _InstancesPageState extends State<InstancesPage> {
  @override
  void initState() {
    super.initState();
    // Handle deep linking: check if an instance ID was passed as a parameter.
    _handleDeepLink();
  }

  void _handleDeepLink() {
    final params = Get.parameters;
    final instanceId = params['id'];
    if (instanceId != null && instanceId.isNotEmpty) {
      final vm = Get.find<InstancesViewModel>();
      // Delay to allow instances to load first.
      Future.delayed(FiftyMotion.compiling, () {
        vm.expandInstance(instanceId);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final vm = Get.find<InstancesViewModel>();

    return ArenaScaffold(
      title: 'INSTANCES',
      activeTabIndex: 1,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final isNarrow = constraints.maxWidth < ArenaBreakpoints.narrow;
          final hPad = isNarrow ? FiftySpacing.sm : FiftySpacing.lg;

          return Column(
            children: [
              // Compact vitals strip
              const CompactVitalsStrip(),

              // Instances header
              Padding(
                padding: EdgeInsets.symmetric(
                  horizontal: hPad,
                ).copyWith(top: FiftySpacing.sm),
                child: const FiftySectionHeader(
                  title: 'Active Instances',
                  size: FiftySectionHeaderSize.small,
                  showDivider: false,
                ),
              ),
              _buildInstancesHeader(context, vm, horizontalPad: hPad),

              // Instance list
              Expanded(
                child: Obx(() {
                  if (vm.isLoading.value) {
                    return const Center(
                      child: FiftyLoadingIndicator(
                        style: FiftyLoadingStyle.sequence,
                        size: FiftyLoadingSize.large,
                        sequences: [
                          '> SCANNING INSTANCES...',
                          '> READING PIPELINES...',
                          '> MAPPING AGENTS...',
                          '> READY.',
                        ],
                      ),
                    );
                  }

                  final instances = vm.instances;

                  if (instances.isEmpty) {
                    return _buildEmptyState(context);
                  }

                  return RefreshIndicator(
                    onRefresh: vm.refreshData,
                    color: colorScheme.primary,
                    backgroundColor: colorScheme.surfaceContainerHighest,
                    child: ListView.builder(
                      physics: const ClampingScrollPhysics(),
                      padding: EdgeInsets.symmetric(
                        horizontal: hPad,
                        vertical: FiftySpacing.sm,
                      ),
                      itemCount: instances.length,
                      itemBuilder: (context, index) {
                        final instance = instances[index];
                        final isExpanded =
                            vm.expandedInstanceId.value == instance.id;

                        return InstanceCard(
                          instance: instance,
                          isExpanded: isExpanded,
                          onTap: () => vm.toggleInstance(instance.id),
                          expandedContent: isExpanded
                              ? _buildExpandedContent(vm, instance.id)
                              : null,
                        );
                      },
                    ),
                  );
                }),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _buildInstancesHeader(
    BuildContext context,
    InstancesViewModel vm, {
    double horizontalPad = FiftySpacing.lg,
  }) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      padding: EdgeInsets.symmetric(
        horizontal: horizontalPad,
        vertical: FiftySpacing.sm,
      ),
      child: Obx(() {
        final active = vm.activeCount;
        final idle = vm.idleCount;

        return Row(
          children: [
            Text(
              'INSTANCES',
              style: textTheme.titleSmall!.copyWith(
                fontWeight: FiftyTypography.extraBold,
                color: colorScheme.onSurface,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
            const SizedBox(width: FiftySpacing.sm),

            // Count badge
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: FiftySpacing.sm,
                vertical: FiftySpacing.xs,
              ),
              decoration: BoxDecoration(
                color: colorScheme.primary.withValues(alpha: 0.15),
                borderRadius: FiftyRadii.smRadius,
                border: Border.all(
                  color: colorScheme.primary.withValues(alpha: 0.3),
                  width: 1,
                ),
              ),
              child: Text(
                '$active active, $idle idle',
                style: ArenaTextStyles.mono(
                  context,
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.semiBold,
                  color: colorScheme.onSurface.withValues(alpha: 0.8),
                ),
              ),
            ),

            const Spacer(),

            // Refresh button
            _HoverButton(
              onTap: vm.refreshData,
              child: Text(
                'REFRESH',
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: colorScheme.onSurfaceVariant,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
            ),
          ],
        );
      }),
    );
  }

  Widget _buildExpandedContent(InstancesViewModel vm, String instanceId) {
    return Obx(() {
      final nexusData = vm.agentNexus[instanceId] ?? [];
      final logEntries = vm.executionLogs[instanceId] ?? [];
      final retries = vm.retryCounts[instanceId] ?? 0;
      final instance = vm.instances.firstWhere((i) => i.id == instanceId);
      final teamData = vm.teamStatus.value;
      final isTeamLead = teamData != null && teamData.active;

      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: FiftySpacing.sm),

          // Hunt pipeline
          HuntPipelineWidget(instance: instance),
          const SizedBox(height: FiftySpacing.sm),

          // Agent nexus table
          AgentNexusTable(
            instanceId: instanceId,
            nexusData: nexusData,
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Execution log
          ExecutionLogWidget(
            instanceId: instanceId,
            entries: logEntries,
            retryCount: retries,
          ),

          // Team mode (if team lead)
          if (isTeamLead) ...[
            const SizedBox(height: FiftySpacing.sm),
            TeamModeWidget(teamStatus: teamData),
          ],
        ],
      );
    });
  }

  Widget _buildEmptyState(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            'NO ACTIVE INSTANCES',
            style: textTheme.titleLarge!.copyWith(
              fontWeight: FiftyTypography.extraBold,
              color: colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
          const SizedBox(height: FiftySpacing.sm),
          Text(
            '> Brain instances will appear here when Claude Code sessions are active.',
            style: textTheme.bodyMedium!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurfaceVariant.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
    );
  }
}

/// A button with hover feedback: background tint appears on mouse hover.
class _HoverButton extends StatefulWidget {
  final VoidCallback? onTap;
  final Widget child;

  const _HoverButton({this.onTap, required this.child});

  @override
  State<_HoverButton> createState() => _HoverButtonState();
}

class _HoverButtonState extends State<_HoverButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: const EdgeInsets.symmetric(
            horizontal: FiftySpacing.sm,
            vertical: FiftySpacing.xs,
          ),
          decoration: BoxDecoration(
            color: _hovered
                ? colorScheme.onSurface.withValues(alpha: 0.08)
                : Colors.transparent,
            borderRadius: FiftyRadii.smRadius,
            border: Border.all(
              color: _hovered
                  ? colorScheme.outline
                  : Colors.transparent,
              width: 1,
            ),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}
