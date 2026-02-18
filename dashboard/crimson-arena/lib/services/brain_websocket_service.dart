import 'dart:async';
import 'dart:convert';

import 'package:get/get.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

import '../core/constants/api_constants.dart';

/// WebSocket service that maintains a persistent connection to the
/// dashboard server's `/ws` endpoint with auto-reconnect.
///
/// Incoming messages are parsed and routed to reactive streams that
/// ViewModels can observe via GetX's `Rx` observables.
class BrainWebSocketService extends GetxService {
  WebSocketChannel? _channel;
  StreamSubscription? _subscription;
  Timer? _reconnectTimer;
  Timer? _pingTimer;

  /// Connection status observable.
  final RxBool isConnected = false.obs;

  // ---------------------------------------------------------------------------
  // Reactive streams per message type
  // ---------------------------------------------------------------------------

  /// Full dashboard state (agents, budget, events, totals, etc.)
  final Rx<Map<String, dynamic>?> state = Rx<Map<String, dynamic>?>(null);

  /// Brain state composite (health, instances, projects, etc.)
  final Rx<Map<String, dynamic>?> brainState =
      Rx<Map<String, dynamic>?>(null);

  /// Brain health data.
  final Rx<Map<String, dynamic>?> brainHealth =
      Rx<Map<String, dynamic>?>(null);

  /// Brain instances list.
  final Rx<Map<String, dynamic>?> brainInstances =
      Rx<Map<String, dynamic>?>(null);

  /// Brain projects data.
  final Rx<Map<String, dynamic>?> brainProjects =
      Rx<Map<String, dynamic>?>(null);

  /// Brain briefs data.
  final Rx<Map<String, dynamic>?> brainBriefs =
      Rx<Map<String, dynamic>?>(null);

  /// Brain sessions data.
  final Rx<Map<String, dynamic>?> brainSessions =
      Rx<Map<String, dynamic>?>(null);

  /// Incoming events (battle log entries) - append-only stream.
  final RxList<Map<String, dynamic>> eventStream =
      <Map<String, dynamic>>[].obs;

  /// Sync pipeline status.
  final Rx<Map<String, dynamic>?> syncStatus =
      Rx<Map<String, dynamic>?>(null);

  /// Team mode status.
  final Rx<Map<String, dynamic>?> teamStatus =
      Rx<Map<String, dynamic>?>(null);

  /// Knowledge base state.
  final Rx<Map<String, dynamic>?> knowledgeState =
      Rx<Map<String, dynamic>?>(null);

  /// Per-instance agent execution event (for live instance view).
  final Rx<Map<String, dynamic>?> instanceAgentEvent =
      Rx<Map<String, dynamic>?>(null);

  /// Skill invocation events.
  final Rx<Map<String, dynamic>?> skillEvent =
      Rx<Map<String, dynamic>?>(null);

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onInit() {
    super.onInit();
    connect();
  }

  @override
  void onClose() {
    _subscription?.cancel();
    _channel?.sink.close();
    _reconnectTimer?.cancel();
    _pingTimer?.cancel();
    super.onClose();
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /// Establish the WebSocket connection.
  void connect() {
    _reconnectTimer?.cancel();

    try {
      final scheme = Uri.base.scheme == 'https' ? 'wss' : 'ws';
      final wsUrl = Uri(
        scheme: scheme,
        host: Uri.base.host,
        port: Uri.base.port,
        path: ApiConstants.wsPath,
      );

      _channel = WebSocketChannel.connect(wsUrl);

      // Wait for the connection handshake before marking as connected.
      // On failure the .ready future throws — catch it to avoid grey screen.
      _channel!.ready.then((_) {
        isConnected.value = true;

        _subscription = _channel!.stream.listen(
          _onMessage,
          onDone: _onDisconnect,
          onError: (_) => _onDisconnect(),
        );

        // Keepalive ping every 30s.
        _pingTimer?.cancel();
        _pingTimer = Timer.periodic(
          const Duration(milliseconds: ApiConstants.wsPingInterval),
          (_) => _sendPing(),
        );
      }).catchError((_) {
        // Connection handshake failed — schedule reconnect silently.
        _scheduleReconnect();
      });
    } catch (_) {
      _scheduleReconnect();
    }
  }

  void _onMessage(dynamic raw) {
    try {
      final msg = jsonDecode(raw as String) as Map<String, dynamic>;
      final type = msg['type'] as String?;
      final data = msg['data'] as Map<String, dynamic>?;

      switch (type) {
        case 'state':
          state.value = data ?? msg;
        case 'brain_state':
          brainState.value = data ?? {};
        case 'brain_health':
          brainHealth.value = data;
        case 'brain_instances':
          brainInstances.value = data;
        case 'brain_projects':
          brainProjects.value = data;
        case 'brain_briefs':
          brainBriefs.value = data;
        case 'brain_sessions':
          brainSessions.value = data;
        case 'event':
          if (data != null) eventStream.add(data);
        case 'sync_status':
          syncStatus.value = data;
        case 'team_status':
          teamStatus.value = data;
        case 'knowledge_state' || 'brain_knowledge':
          knowledgeState.value = data;
        case 'instance_agent_event':
          instanceAgentEvent.value = data;
        case 'skill_event':
          skillEvent.value = data;
        case 'pong':
          break; // keepalive response
      }
    } catch (_) {
      // Silently ignore malformed messages.
    }
  }

  void _onDisconnect() {
    isConnected.value = false;
    _subscription?.cancel();
    _subscription = null;
    _pingTimer?.cancel();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(
      const Duration(milliseconds: ApiConstants.wsReconnectDelay),
      connect,
    );
  }

  void _sendPing() {
    if (isConnected.value && _channel != null) {
      try {
        _channel!.sink.add(jsonEncode({'type': 'ping'}));
      } catch (_) {
        _onDisconnect();
      }
    }
  }
}
