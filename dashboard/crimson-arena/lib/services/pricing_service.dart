import 'package:get/get.dart';

/// Pricing model for a single Claude model variant.
class PricingModel {
  final double inputCostPerToken;
  final double outputCostPerToken;
  final double cacheReadInputTokenCost;
  final double cacheCreationInputTokenCost;

  const PricingModel({
    required this.inputCostPerToken,
    required this.outputCostPerToken,
    required this.cacheReadInputTokenCost,
    required this.cacheCreationInputTokenCost,
  });

  factory PricingModel.fromJson(Map<String, dynamic> json) => PricingModel(
        inputCostPerToken:
            (json['input_cost_per_token'] as num?)?.toDouble() ?? 0,
        outputCostPerToken:
            (json['output_cost_per_token'] as num?)?.toDouble() ?? 0,
        cacheReadInputTokenCost:
            (json['cache_read_input_token_cost'] as num?)?.toDouble() ?? 0,
        cacheCreationInputTokenCost:
            (json['cache_creation_input_token_cost'] as num?)?.toDouble() ?? 0,
      );
}

/// Cost breakdown result from a cost estimate.
class CostEstimate {
  final double inputCost;
  final double outputCost;
  final double cacheReadCost;
  final double cacheCreateCost;
  final double total;

  const CostEstimate({
    required this.inputCost,
    required this.outputCost,
    required this.cacheReadCost,
    required this.cacheCreateCost,
    required this.total,
  });
}

/// Service that manages Claude model pricing rates and cost calculations.
///
/// Pricing data is fetched from the `/api/pricing` endpoint and cached
/// for the session. Supports cost estimation for any combination of
/// token buckets.
class PricingService extends GetxService {
  final Map<String, PricingModel> _rates = {};

  /// Update pricing rates from the API response.
  ///
  /// Expected shape: `{ "pricing": { "model-id": { ...rates } } }`
  void updateRates(Map<String, dynamic> pricingData) {
    _rates.clear();
    final pricing =
        pricingData['pricing'] as Map<String, dynamic>? ?? pricingData;
    for (final entry in pricing.entries) {
      if (entry.value is Map<String, dynamic>) {
        _rates[entry.key] = PricingModel.fromJson(
          entry.value as Map<String, dynamic>,
        );
      }
    }
  }

  /// Look up pricing rates for a model ID.
  ///
  /// Falls back to partial match, then any Opus model, then first available.
  PricingModel? getRatesForModel(String modelId) {
    // Exact match.
    if (_rates.containsKey(modelId)) return _rates[modelId];

    // Partial match (model ID substring).
    for (final key in _rates.keys) {
      if (key.contains(modelId) || modelId.contains(key)) {
        return _rates[key];
      }
    }

    // Fallback to Opus.
    for (final key in _rates.keys) {
      if (key.contains('opus')) return _rates[key];
    }

    // Last resort: first available rate.
    return _rates.values.isNotEmpty ? _rates.values.first : null;
  }

  /// Calculate cost estimate for the 4 token buckets.
  CostEstimate? calculateCost({
    required int inputTokens,
    required int outputTokens,
    required int cacheRead,
    required int cacheCreate,
    required String modelId,
  }) {
    final rates = getRatesForModel(modelId);
    if (rates == null) return null;

    final inputCost = inputTokens * rates.inputCostPerToken;
    final outputCost = outputTokens * rates.outputCostPerToken;
    final cacheReadCost = cacheRead * rates.cacheReadInputTokenCost;
    final cacheCreateCost = cacheCreate * rates.cacheCreationInputTokenCost;

    return CostEstimate(
      inputCost: inputCost,
      outputCost: outputCost,
      cacheReadCost: cacheReadCost,
      cacheCreateCost: cacheCreateCost,
      total: inputCost + outputCost + cacheReadCost + cacheCreateCost,
    );
  }

  /// Format a dollar cost value as a string.
  static String formatCost(double cost) {
    if (cost == 0) return r'$0.00';
    if (cost < 0.01) return r'<$0.01';
    return '\$${cost.toStringAsFixed(2)}';
  }

  /// Format a per-token cost as per-MTok string.
  static String formatRate(double costPerToken) {
    if (costPerToken == 0) return r'$0.00/M';
    final perMTok = costPerToken * 1000000;
    return '\$${perMTok.toStringAsFixed(2)}/M';
  }

  /// Whether pricing data is loaded.
  bool get hasRates => _rates.isNotEmpty;
}
