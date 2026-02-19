import 'package:flutter/material.dart';

import '../../core/constants/skill_constants.dart';

/// Immutable model merging static skill metadata with live usage data.
///
/// Created by combining a [SkillMeta] entry from [SkillConstants.registry]
/// with real-time invocation counts from the brain API / WebSocket.
@immutable
class SkillCardModel {
  /// The skill command name (e.g. 'hunt', 'scan').
  final String name;

  /// Short description of the skill's purpose.
  final String description;

  /// The category this skill belongs to.
  final SkillCategory category;

  /// Agents invoked by this skill (empty if orchestrator-only).
  final List<String> agents;

  /// Icon representing this skill in the UI.
  final IconData icon;

  /// Total invocation count (from heatmap data).
  final int invocations;

  /// ISO timestamp of the last invocation, or null if never used.
  final String? lastUsed;

  /// Rarity tier resolved from [invocations].
  final SkillRarity rarity;

  const SkillCardModel({
    required this.name,
    required this.description,
    required this.category,
    required this.agents,
    required this.icon,
    required this.invocations,
    this.lastUsed,
    required this.rarity,
  });

  /// Construct from a [SkillMeta] entry plus live usage data.
  factory SkillCardModel.fromMeta(
    SkillMeta meta, {
    int invocations = 0,
    String? lastUsed,
  }) {
    return SkillCardModel(
      name: meta.name,
      description: meta.description,
      category: meta.category,
      agents: meta.agents,
      icon: meta.icon,
      invocations: invocations,
      lastUsed: lastUsed,
      rarity: SkillConstants.resolveRarity(invocations),
    );
  }
}
