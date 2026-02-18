/// Formatting utilities for the Crimson Arena dashboard.
///
/// Provides number, token, duration, and time formatting consistent
/// with the vanilla JS dashboard patterns.
class FormatUtils {
  FormatUtils._();

  /// Format a number with comma separators.
  ///
  /// Examples: 1234 -> "1,234", 1000000 -> "1,000,000"
  static String formatNumber(int value) {
    if (value < 0) return '-${formatNumber(-value)}';
    if (value < 1000) return value.toString();
    final str = value.toString();
    final buffer = StringBuffer();
    final len = str.length;
    for (int i = 0; i < len; i++) {
      if (i > 0 && (len - i) % 3 == 0) buffer.write(',');
      buffer.write(str[i]);
    }
    return buffer.toString();
  }

  /// Format token counts with K/M suffixes.
  ///
  /// Examples: 500 -> "500", 1500 -> "1.5K", 1500000 -> "1.5M"
  static String formatTokens(int tokens) {
    if (tokens >= 1000000) {
      final m = tokens / 1000000;
      return '${m.toStringAsFixed(m >= 10 ? 0 : 1)}M';
    }
    if (tokens >= 1000) {
      final k = tokens / 1000;
      return '${k.toStringAsFixed(k >= 10 ? 0 : 1)}K';
    }
    return tokens.toString();
  }

  /// Format a duration in seconds to human-readable string.
  ///
  /// Examples: 45 -> "45s", 125 -> "2m 5s", 3670 -> "1h 1m"
  static String formatDuration(double seconds) {
    if (seconds < 60) {
      return '${seconds.toStringAsFixed(0)}s';
    }
    if (seconds < 3600) {
      final m = (seconds / 60).floor();
      final s = (seconds % 60).round();
      return s > 0 ? '${m}m ${s}s' : '${m}m';
    }
    final h = (seconds / 3600).floor();
    final m = ((seconds % 3600) / 60).round();
    return m > 0 ? '${h}h ${m}m' : '${h}h';
  }

  /// Format uptime in seconds.
  ///
  /// Examples: 3600 -> "1h 0m", 90061 -> "1d 1h"
  static String formatUptime(int seconds) {
    if (seconds < 60) return '${seconds}s';
    if (seconds < 3600) {
      final m = (seconds / 60).floor();
      return '${m}m';
    }
    if (seconds < 86400) {
      final h = (seconds / 3600).floor();
      final m = ((seconds % 3600) / 60).floor();
      return '${h}h ${m}m';
    }
    final d = (seconds / 86400).floor();
    final h = ((seconds % 86400) / 3600).floor();
    return '${d}d ${h}h';
  }

  /// Format a dollar cost.
  ///
  /// Examples: 0 -> "\$0.00", 0.005 -> "<\$0.01", 1.50 -> "\$1.50"
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

  /// Format an ISO timestamp to HH:MM:SS.
  static String formatTime(String timestamp) {
    try {
      final dt = DateTime.parse(timestamp);
      return '${_pad(dt.hour)}:${_pad(dt.minute)}:${_pad(dt.second)}';
    } catch (_) {
      return '--:--:--';
    }
  }

  /// Format a relative time string from an ISO timestamp.
  ///
  /// Examples: "2 minutes ago", "1 hour ago", "3 days ago"
  static String timeAgo(String? timestamp) {
    if (timestamp == null || timestamp.isEmpty) return '--';
    try {
      final dt = DateTime.parse(timestamp).toUtc();
      final now = DateTime.now().toUtc();
      final diff = now.difference(dt);

      if (diff.isNegative) return 'just now';
      if (diff.inSeconds < 60) return '${diff.inSeconds}s ago';
      if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
      if (diff.inHours < 24) return '${diff.inHours}h ago';
      if (diff.inDays < 7) return '${diff.inDays}d ago';
      return '${(diff.inDays / 7).floor()}w ago';
    } catch (_) {
      return '--';
    }
  }

  /// Format bytes to human-readable size.
  static String formatBytes(int bytes) {
    if (bytes < 1024) return '$bytes B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
    if (bytes < 1024 * 1024 * 1024) {
      return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
    }
    return '${(bytes / (1024 * 1024 * 1024)).toStringAsFixed(1)} GB';
  }

  /// Compute percentage, clamped 0-100.
  static double percentage(num value, num total) {
    if (total <= 0) return 0;
    return ((value / total) * 100).clamp(0, 100).toDouble();
  }

  static String _pad(int n) => n.toString().padLeft(2, '0');
}
