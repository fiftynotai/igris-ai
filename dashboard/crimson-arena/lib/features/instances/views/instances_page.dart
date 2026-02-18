import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

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
    final vm = Get.find<InstancesViewModel>();

    return ArenaScaffold(
      title: 'INSTANCES',
      activeTabIndex: 1,
      body: LayoutBuilder(
        builder: (context, constraints) {
          final isNarrow = constraints.maxWidth < 600;
          final hPad = isNarrow ? FiftySpacing.sm : FiftySpacing.lg;

          return Column(
            children: [
              // Compact vitals strip
              const CompactVitalsStrip(),

              // Instances header
              _buildInstancesHeader(vm, horizontalPad: hPad),

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
                    return _buildEmptyState();
                  }

                  return RefreshIndicator(
                    onRefresh: vm.refreshData,
                    color: FiftyColors.burgundy,
                    backgroundColor: FiftyColors.surfaceDark,
                    child: ListView.builder(
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
    InstancesViewModel vm, {
    double horizontalPad = FiftySpacing.lg,
  }) {
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
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.titleSmall,
                fontWeight: FiftyTypography.extraBold,
                color: FiftyColors.cream,
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
                color: FiftyColors.burgundy.withValues(alpha: 0.15),
                borderRadius: FiftyRadii.smRadius,
                border: Border.all(
                  color: FiftyColors.burgundy.withValues(alpha: 0.3),
                  width: 1,
                ),
              ),
              child: Text(
                '$active active, $idle idle',
                style: GoogleFonts.sourceCodePro(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.semiBold,
                  color: FiftyColors.cream.withValues(alpha: 0.8),
                ),
              ),
            ),

            const Spacer(),

            // Refresh button
            InkWell(
              onTap: vm.refreshData,
              borderRadius: FiftyRadii.smRadius,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: FiftySpacing.sm,
                  vertical: FiftySpacing.xs,
                ),
                child: Text(
                  'REFRESH',
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.bold,
                    color: FiftyColors.slateGrey,
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
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

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            'NO ACTIVE INSTANCES',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.titleLarge,
              fontWeight: FiftyTypography.extraBold,
              color: FiftyColors.slateGrey.withValues(alpha: 0.5),
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
          const SizedBox(height: FiftySpacing.sm),
          Text(
            '> Brain instances will appear here when Claude Code sessions are active.',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodyMedium,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.slateGrey.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
    );
  }
}
