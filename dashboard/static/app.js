/* ==========================================================================
   CRIMSON ARENA - Igris AI Agent Dashboard
   Client-side application: WebSocket + REST state management
   ========================================================================== */

'use strict';

/* --------------------------------------------------------------------------
   Constants
   -------------------------------------------------------------------------- */

/** Display names for the 7 agents, in pipeline order. */
var AGENT_NAMES = {
    architect: 'ARCHITECT',
    forger:    'FORGER',
    sentinel:  'SENTINEL',
    warden:    'WARDEN',
    mender:    'MENDER',
    seeker:    'SEEKER',
    sage:      'SAGE'
};

/** Pipeline order (for rendering). */
var AGENT_ORDER = ['architect', 'forger', 'sentinel', 'warden', 'mender', 'seeker', 'sage'];

/** Maximum battle log entries to keep in DOM. */
var MAX_BATTLE_LOG = 50;

/** Duration (ms) for the green flash after agent completes. */
var COMPLETE_FLASH_DURATION = 10000;

/* --------------------------------------------------------------------------
   Utility Functions
   -------------------------------------------------------------------------- */

/**
 * Escape a string for safe insertion into innerHTML.
 * Prevents XSS by converting special characters to HTML entities.
 * @param {*} str - value to escape (coerced to string)
 * @returns {string}
 */
function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

/**
 * Format a number with locale separators.
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
    if (n == null) return '0';
    return n.toLocaleString();
}

/**
 * Format token counts with K/M suffixes for compact display.
 * @param {number} n
 * @returns {string}
 */
function formatTokens(n) {
    if (n == null || n === 0) return '0';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toString();
}

/**
 * Relative time ago string from ISO timestamp.
 * @param {string} isoString
 * @returns {string}
 */
function timeAgo(isoString) {
    if (!isoString) return '--';
    var diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'just now';
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    return Math.floor(hours / 24) + 'd ago';
}

/**
 * Format ISO timestamp to HH:MM:SS for battle log.
 * @param {string} isoString
 * @returns {string}
 */
function formatTime(isoString) {
    if (!isoString) return '--:--:--';
    return new Date(isoString).toLocaleTimeString('en-US', { hour12: false });
}

/**
 * Format seconds to a human readable duration string.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    if (seconds == null || seconds === 0) return '0s';
    if (seconds < 60) return Math.round(seconds) + 's';
    var m = Math.floor(seconds / 60);
    var s = Math.round(seconds % 60);
    return m + 'm ' + s + 's';
}

/**
 * Compute percentage, clamped 0-100.
 * @param {number} part
 * @param {number} total
 * @returns {number}
 */
function pct(part, total) {
    if (!total || total === 0) return 0;
    return Math.max(0, Math.min(100, (part / total) * 100));
}

/**
 * Safely get a nested property, returning a default if missing.
 * @param {object} obj
 * @param {string[]} path
 * @param {*} defaultValue
 * @returns {*}
 */
function get(obj, path, defaultValue) {
    var current = obj;
    for (var i = 0; i < path.length; i++) {
        if (current == null) return defaultValue;
        current = current[path[i]];
    }
    return current != null ? current : defaultValue;
}

/* --------------------------------------------------------------------------
   ArenaClient Class
   -------------------------------------------------------------------------- */

/**
 * Main application class managing WebSocket connection, state, and rendering.
 * @constructor
 */
function ArenaClient() {
    this.ws = null;
    this.state = null;
    this.reconnectInterval = 3000;
    this.activeTimers = {};
    this.battleLogCount = 0;
    this.partyOpen = false;
    this._wsConnected = false;
}

/**
 * Initialize the client: fetch state, render, connect WebSocket.
 */
ArenaClient.prototype.init = async function () {
    this._bindPartyToggle();
    await this.fetchState();
    this.render();
    this.connectWebSocket();
};

/* --------------------------------------------------------------------------
   Data Fetching
   -------------------------------------------------------------------------- */

/**
 * Fetch initial state via REST /api/state.
 */
ArenaClient.prototype.fetchState = async function () {
    try {
        var resp = await fetch('/api/state');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        this.state = await resp.json();
    } catch (e) {
        console.error('Failed to fetch state:', e);
    }
};

/* --------------------------------------------------------------------------
   WebSocket Management
   -------------------------------------------------------------------------- */

/**
 * Establish WebSocket connection with auto-reconnect.
 */
ArenaClient.prototype.connectWebSocket = function () {
    var self = this;
    var protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = protocol + '//' + location.host + '/ws';

    try {
        this.ws = new WebSocket(url);
    } catch (e) {
        console.error('WebSocket creation failed:', e);
        setTimeout(function () { self.connectWebSocket(); }, self.reconnectInterval);
        return;
    }

    this.ws.onopen = function () {
        self._wsConnected = true;
        self._updateConnectionStatus(true);
    };

    this.ws.onmessage = function (evt) {
        try {
            var msg = JSON.parse(evt.data);
            if (msg.type === 'state') {
                // Server sends full state wrapped in data property
                self.state = msg.data || msg;
                self.render();
            } else if (msg.type === 'event') {
                var event = msg.data || msg;
                self.handleEvent(event);
            }
        } catch (e) {
            console.error('Failed to parse WebSocket message:', e);
        }
    };

    this.ws.onclose = function () {
        self._wsConnected = false;
        self._updateConnectionStatus(false);
        setTimeout(function () { self.connectWebSocket(); }, self.reconnectInterval);
    };

    this.ws.onerror = function () {
        if (self.ws) self.ws.close();
    };
};

/**
 * Update the connection status badge in the header.
 * @param {boolean} online
 */
ArenaClient.prototype._updateConnectionStatus = function (online) {
    var el = document.getElementById('connection-status');
    if (!el) return;
    if (online) {
        el.textContent = 'LIVE';
        el.className = 'connection-status connection-status--online';
    } else {
        el.textContent = 'OFFLINE';
        el.className = 'connection-status connection-status--offline';
    }
};

/* --------------------------------------------------------------------------
   Event Handling
   -------------------------------------------------------------------------- */

/**
 * Process an incoming event (start or stop) from WebSocket.
 * @param {object} event
 */
ArenaClient.prototype.handleEvent = function (event) {
    if (!event) return;

    if (event.event === 'start') {
        this.onAgentStart(event);
    } else if (event.event === 'stop') {
        this.onAgentStop(event);
    }

    this.addBattleLogEntry(event);
    this.renderAgentPods();
    this.renderBudget();
    this.renderTokenBreakdown();
};

/**
 * Handle agent start event: mark active, start duration timer.
 * @param {object} event
 */
ArenaClient.prototype.onAgentStart = function (event) {
    var agent = event.agent;
    if (!agent) return;

    if (this.state && this.state.agents && this.state.agents[agent]) {
        this.state.agents[agent].active = true;
    }

    // Start a live duration timer
    var self = this;
    var startTime = Date.now();
    this.activeTimers[agent] = {
        startTime: startTime,
        interval: setInterval(function () {
            self._updateActiveTimer(agent, startTime);
        }, 1000)
    };
};

/**
 * Handle agent stop event: update tokens, clear timer.
 * @param {object} event
 */
ArenaClient.prototype.onAgentStop = function (event) {
    var agent = event.agent;
    if (!agent) return;

    // Update agent data in local state
    if (this.state && this.state.agents && this.state.agents[agent]) {
        var a = this.state.agents[agent];
        a.active = false;
        a.total_input_tokens = (a.total_input_tokens || 0) + (event.input_tokens || 0);
        a.total_output_tokens = (a.total_output_tokens || 0) + (event.output_tokens || 0);
        a.total_cache_read_tokens = (a.total_cache_read_tokens || 0) + (event.cache_read || 0);
        a.total_cache_create_tokens = (a.total_cache_create_tokens || 0) + (event.cache_create || 0);
        a.invocations = (a.invocations || 0) + 1;
        a.last_used = event.ts || new Date().toISOString();
    }

    // Update budget consumed
    if (this.state && this.state.budget) {
        var totalNew = (event.input_tokens || 0) + (event.output_tokens || 0) +
                       (event.cache_read || 0) + (event.cache_create || 0);
        this.state.budget.consumed = (this.state.budget.consumed || 0) + totalNew;
        var ceiling = this.state.budget.ceiling || 1;
        this.state.budget.ratio = this.state.budget.consumed / ceiling;
    }

    // Update totals
    if (this.state && this.state.totals) {
        this.state.totals.total_invocations = (this.state.totals.total_invocations || 0) + 1;
        this.state.totals.total_input_tokens = (this.state.totals.total_input_tokens || 0) + (event.input_tokens || 0);
        this.state.totals.total_output_tokens = (this.state.totals.total_output_tokens || 0) + (event.output_tokens || 0);
        this.state.totals.total_cache_tokens = (this.state.totals.total_cache_tokens || 0) +
            (event.cache_read || 0) + (event.cache_create || 0);
    }

    // Clear duration timer
    if (this.activeTimers[agent]) {
        clearInterval(this.activeTimers[agent].interval);
        delete this.activeTimers[agent];
    }

    // Clear the timer display
    var timerEl = document.getElementById('timer-' + agent);
    if (timerEl) timerEl.textContent = '';

    // Add green flash state, then revert after timeout
    var pod = document.getElementById('pod-' + agent);
    if (pod) {
        pod.className = 'agent-pod agent-pod--complete';
        setTimeout(function () {
            // If still in complete state (not reactivated), revert
            if (pod.classList.contains('agent-pod--complete')) {
                pod.className = 'agent-pod agent-pod--has-data';
            }
        }, COMPLETE_FLASH_DURATION);
    }
};

/**
 * Update the live duration timer display for an active agent.
 * @param {string} agent
 * @param {number} startTime
 */
ArenaClient.prototype._updateActiveTimer = function (agent, startTime) {
    var elapsed = Math.floor((Date.now() - startTime) / 1000);
    var timerEl = document.getElementById('timer-' + agent);
    if (timerEl) {
        timerEl.textContent = formatDuration(elapsed);
    }
};

/* --------------------------------------------------------------------------
   Battle Log
   -------------------------------------------------------------------------- */

/**
 * Add a single event entry to the battle log DOM (newest at top).
 * @param {object} event
 */
ArenaClient.prototype.addBattleLogEntry = function (event) {
    var log = document.getElementById('battle-log');
    if (!log) return;

    // Remove the empty placeholder if present
    var empty = log.querySelector('.battle-log__empty');
    if (empty) empty.remove();

    var entry = document.createElement('div');
    var agentName = escapeHtml(AGENT_NAMES[event.agent] || (event.agent || 'UNKNOWN').toUpperCase());
    var time = escapeHtml(formatTime(event.ts));

    if (event.event === 'start') {
        entry.className = 'battle-log__entry battle-log__entry--start';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-agent">' + agentName + '</span> deployed to battle';
    } else if (event.event === 'stop') {
        var totalTokens = (event.input_tokens || 0) + (event.output_tokens || 0) +
                          (event.cache_read || 0) + (event.cache_create || 0);
        var dur = escapeHtml(event.duration_s ? formatDuration(event.duration_s) : '--');
        entry.className = 'battle-log__entry battle-log__entry--stop';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-agent">' + agentName + '</span> completed &mdash; ' +
            '<span class="entry-tokens">' + escapeHtml(formatNumber(totalTokens)) + ' tokens</span> ' +
            '(<span class="entry-duration">' + dur + '</span>)';
    } else {
        entry.className = 'battle-log__entry';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-agent">' + agentName + '</span> ' +
            escapeHtml(event.event || 'event');
    }

    // Insert at top (newest first)
    log.insertBefore(entry, log.firstChild);

    // Trim excess entries
    this.battleLogCount++;
    while (this.battleLogCount > MAX_BATTLE_LOG) {
        var last = log.lastElementChild;
        if (last) log.removeChild(last);
        this.battleLogCount--;
    }
};

/* --------------------------------------------------------------------------
   Rendering: Full State
   -------------------------------------------------------------------------- */

/**
 * Full render of all dashboard components from current state.
 */
ArenaClient.prototype.render = function () {
    if (!this.state) return;
    this.renderBudget();
    this.renderAgentPods();
    this.renderTokenBreakdown();
    this.renderBattleLog();
    this.renderPartyStats();
};

/* --------------------------------------------------------------------------
   Rendering: Budget HP Bar
   -------------------------------------------------------------------------- */

/**
 * Update the session HP bar based on budget state.
 */
ArenaClient.prototype.renderBudget = function () {
    var budget = get(this.state, ['budget'], null);
    if (!budget) return;

    var consumed = budget.consumed || 0;
    var ceiling = budget.ceiling || 1;
    var ratio = consumed / ceiling;
    var percentage = Math.min(ratio * 100, 100);

    var warnThreshold = budget.warning_threshold || 0.75;
    var critThreshold = budget.critical_threshold || 0.90;

    // Update text
    var hpText = document.getElementById('hp-text');
    if (hpText) {
        hpText.textContent = formatNumber(consumed) + ' / ' + formatNumber(ceiling) +
            ' tokens (' + percentage.toFixed(1) + '%)';
    }

    // Update bar width
    var hpFill = document.getElementById('hp-fill');
    if (hpFill) {
        hpFill.style.width = percentage + '%';
        // Set color class based on thresholds
        hpFill.className = 'hp-fill';
        if (ratio >= critThreshold) {
            hpFill.classList.add('hp-fill--critical');
        } else if (ratio >= warnThreshold) {
            hpFill.classList.add('hp-fill--warning');
        } else {
            hpFill.classList.add('hp-fill--full');
        }
    }

    // Position threshold markers
    var warnMarker = document.getElementById('hp-warn-marker');
    if (warnMarker) warnMarker.style.left = (warnThreshold * 100) + '%';
    var critMarker = document.getElementById('hp-crit-marker');
    if (critMarker) critMarker.style.left = (critThreshold * 100) + '%';
};

/* --------------------------------------------------------------------------
   Rendering: Agent Pods
   -------------------------------------------------------------------------- */

/**
 * Update all 7 agent pods with current state data.
 */
ArenaClient.prototype.renderAgentPods = function () {
    var agents = get(this.state, ['agents'], {});

    for (var i = 0; i < AGENT_ORDER.length; i++) {
        var name = AGENT_ORDER[i];
        var data = agents[name];
        this._renderSinglePod(name, data);
    }
};

/**
 * Render a single agent pod.
 * @param {string} name - agent key
 * @param {object|undefined} data - agent state data
 */
ArenaClient.prototype._renderSinglePod = function (name, data) {
    var pod = document.getElementById('pod-' + name);
    if (!pod) return;

    if (!data) {
        pod.className = 'agent-pod agent-pod--idle';
        return;
    }

    // Determine pod state class (unless currently in complete flash)
    if (!pod.classList.contains('agent-pod--complete')) {
        if (data.active) {
            pod.className = 'agent-pod agent-pod--active';
        } else if ((data.invocations || 0) > 0) {
            pod.className = 'agent-pod agent-pod--has-data';
        } else {
            pod.className = 'agent-pod agent-pod--idle';
        }
    }

    // Evolution badge
    var evoEl = document.getElementById('evo-' + name);
    if (evoEl) {
        evoEl.textContent = get(data, ['level', 'evolution'], 'In-Training');
    }

    // Level name
    var levelEl = document.getElementById('level-' + name);
    if (levelEl) {
        levelEl.textContent = get(data, ['level', 'name'], 'Trainee');
    }

    // XP progress bar
    var xpEl = document.getElementById('xp-' + name);
    if (xpEl) {
        var progress = get(data, ['level', 'progress'], 0);
        xpEl.style.width = (progress * 100) + '%';
    }

    // Invocations
    var invEl = document.getElementById('inv-' + name);
    if (invEl) {
        invEl.textContent = data.invocations || 0;
    }

    // Last used
    var lastEl = document.getElementById('last-' + name);
    if (lastEl) {
        lastEl.textContent = data.last_used ? timeAgo(data.last_used) : '--';
    }

    // Timer: only show if active and we have a local timer running
    var timerEl = document.getElementById('timer-' + name);
    if (timerEl && !data.active) {
        // If not active and no timer running, clear it
        if (!this.activeTimers[name]) {
            timerEl.textContent = '';
        }
    }
};

/* --------------------------------------------------------------------------
   Rendering: Token Breakdown
   -------------------------------------------------------------------------- */

/**
 * Render the token breakdown panel in the sidebar.
 */
ArenaClient.prototype.renderTokenBreakdown = function () {
    var agents = get(this.state, ['agents'], {});
    var totals = get(this.state, ['totals'], {});
    var budget = get(this.state, ['budget'], {});

    // Calculate totals from agent data for detailed breakdown
    var inputTokens = 0;
    var outputTokens = 0;
    var cacheRead = 0;
    var cacheCreate = 0;

    var agentKeys = Object.keys(agents);
    for (var i = 0; i < agentKeys.length; i++) {
        var a = agents[agentKeys[i]];
        inputTokens += a.total_input_tokens || 0;
        outputTokens += a.total_output_tokens || 0;
        cacheRead += a.total_cache_read_tokens || 0;
        cacheCreate += a.total_cache_create_tokens || 0;
    }

    var grandTotal = inputTokens + outputTokens + cacheRead + cacheCreate;

    // Total tokens display
    var totalEl = document.getElementById('total-tokens');
    if (totalEl) totalEl.textContent = formatNumber(grandTotal);

    // Individual bars
    this._renderTokenBar('input', inputTokens, grandTotal);
    this._renderTokenBar('output', outputTokens, grandTotal);
    this._renderTokenBar('cache-read', cacheRead, grandTotal);
    this._renderTokenBar('cache-create', cacheCreate, grandTotal);

    // Total invocations
    var invEl = document.getElementById('total-invocations');
    if (invEl) invEl.textContent = formatNumber(totals.total_invocations || 0);
};

/**
 * Update a single token bar row.
 * @param {string} type - bar type identifier
 * @param {number} count - token count
 * @param {number} total - total tokens for percentage
 */
ArenaClient.prototype._renderTokenBar = function (type, count, total) {
    var barEl = document.getElementById('bar-' + type);
    var countEl = document.getElementById('count-' + type);
    var pctEl = document.getElementById('pct-' + type);

    var percentage = pct(count, total);

    if (barEl) barEl.style.width = percentage + '%';
    if (countEl) countEl.textContent = formatTokens(count);
    if (pctEl) pctEl.textContent = Math.round(percentage) + '%';
};

/* --------------------------------------------------------------------------
   Rendering: Battle Log (initial load from recent_events)
   -------------------------------------------------------------------------- */

/**
 * Render battle log from recent_events in state (initial load only).
 */
ArenaClient.prototype.renderBattleLog = function () {
    var events = get(this.state, ['recent_events'], []);
    if (events.length === 0) return;

    var log = document.getElementById('battle-log');
    if (!log) return;

    // Clear existing entries
    log.innerHTML = '';
    this.battleLogCount = 0;

    // recent_events are newest-first from server, so render in order
    for (var i = 0; i < events.length && i < MAX_BATTLE_LOG; i++) {
        var event = events[i];
        var entry = document.createElement('div');
        var agentName = escapeHtml(AGENT_NAMES[event.agent] || (event.agent || 'UNKNOWN').toUpperCase());
        var time = escapeHtml(formatTime(event.ts));

        if (event.event === 'start') {
            entry.className = 'battle-log__entry battle-log__entry--start';
            entry.innerHTML =
                '<span class="entry-time">[' + time + ']</span> ' +
                '<span class="entry-agent">' + agentName + '</span> deployed to battle';
        } else if (event.event === 'stop') {
            var totalTokens = (event.input_tokens || 0) + (event.output_tokens || 0) +
                              (event.cache_read || 0) + (event.cache_create || 0);
            var dur = escapeHtml(event.duration_s ? formatDuration(event.duration_s) : '--');
            entry.className = 'battle-log__entry battle-log__entry--stop';
            entry.innerHTML =
                '<span class="entry-time">[' + time + ']</span> ' +
                '<span class="entry-agent">' + agentName + '</span> completed &mdash; ' +
                '<span class="entry-tokens">' + escapeHtml(formatNumber(totalTokens)) + ' tokens</span> ' +
                '(<span class="entry-duration">' + dur + '</span>)';
        } else {
            entry.className = 'battle-log__entry';
            entry.innerHTML =
                '<span class="entry-time">[' + time + ']</span> ' +
                '<span class="entry-agent">' + agentName + '</span> ' +
                escapeHtml(event.event || 'event');
        }

        // No animation for initial load
        entry.style.animation = 'none';
        log.appendChild(entry);
        this.battleLogCount++;
    }

    // Show placeholder if no events
    if (this.battleLogCount === 0) {
        log.innerHTML = '<div class="battle-log__empty">Awaiting agent activity...</div>';
    }
};

/* --------------------------------------------------------------------------
   Rendering: RPG Party Stats
   -------------------------------------------------------------------------- */

/**
 * Render character cards for all agents in the footer.
 */
ArenaClient.prototype.renderPartyStats = function () {
    var container = document.getElementById('party-stats');
    if (!container) return;

    var agents = get(this.state, ['agents'], {});
    var html = '';

    for (var i = 0; i < AGENT_ORDER.length; i++) {
        var name = AGENT_ORDER[i];
        var data = agents[name];
        if (!data) continue;

        var displayName = escapeHtml(AGENT_NAMES[name] || name.toUpperCase());
        var level = data.level || {};
        var stats = data.rpg_stats || {};
        var evolution = escapeHtml(level.evolution || 'In-Training');
        var levelName = escapeHtml(level.name || 'Trainee');
        var progress = (level.progress || 0) * 100;
        var nextAt = level.next_at || 0;
        var invocations = data.invocations || 0;

        var totalTokens = (data.total_input_tokens || 0) + (data.total_output_tokens || 0) +
                          (data.total_cache_read_tokens || 0) + (data.total_cache_create_tokens || 0);

        html += '<div class="char-card">' +
            '<div class="char-card__header">' +
                '<span class="char-card__name">' + displayName + '</span>' +
                '<span class="char-card__tier">' + evolution + '</span>' +
            '</div>' +
            '<div class="char-card__level-row">' +
                '<span class="char-card__level-name">' + levelName + '</span>' +
                '<span class="char-card__level-progress mono">' +
                    escapeHtml(invocations) + ' / ' + escapeHtml(nextAt) + ' XP' +
                '</span>' +
            '</div>' +
            '<div class="xp-bar"><div class="xp-fill" style="width:' + progress + '%"></div></div>' +
            '<div class="char-card__stats">' +
                this._renderStatBadge('STR', stats.STR || 0, 'str') +
                this._renderStatBadge('INT', stats.INT || 0, 'int') +
                this._renderStatBadge('SPD', stats.SPD || 0, 'spd') +
                this._renderStatBadge('VIT', stats.VIT || 0, 'vit') +
            '</div>' +
            '<div class="char-card__totals">' +
                '<div class="char-card__total-item">' +
                    '<div class="char-card__total-label">Tokens</div>' +
                    '<div class="char-card__total-value">' + escapeHtml(formatTokens(totalTokens)) + '</div>' +
                '</div>' +
                '<div class="char-card__total-item">' +
                    '<div class="char-card__total-label">Runs</div>' +
                    '<div class="char-card__total-value">' + escapeHtml(invocations) + '</div>' +
                '</div>' +
                '<div class="char-card__total-item">' +
                    '<div class="char-card__total-label">Avg Time</div>' +
                    '<div class="char-card__total-value">' +
                        escapeHtml(formatDuration(data.avg_duration_seconds || 0)) +
                    '</div>' +
                '</div>' +
            '</div>' +
        '</div>';
    }

    container.innerHTML = html;
};

/**
 * Generate HTML for a single stat badge (STR/INT/SPD/VIT).
 * @param {string} label
 * @param {number} value - 0-100
 * @param {string} cssKey - str|int|spd|vit
 * @returns {string}
 */
ArenaClient.prototype._renderStatBadge = function (label, value, cssKey) {
    return '<div class="stat-badge stat-badge--' + escapeHtml(cssKey) + '">' +
        '<span class="stat-badge__label">' + escapeHtml(label) + '</span>' +
        '<span class="stat-badge__value">' + escapeHtml(value) + '</span>' +
        '<div class="stat-badge__bar">' +
            '<div class="stat-badge__bar-fill" style="width:' + escapeHtml(value) + '%"></div>' +
        '</div>' +
    '</div>';
};

/* --------------------------------------------------------------------------
   Party Stats Toggle
   -------------------------------------------------------------------------- */

/**
 * Bind click handler for expanding/collapsing party stats footer.
 */
ArenaClient.prototype._bindPartyToggle = function () {
    var self = this;
    var toggle = document.getElementById('party-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', function () {
        self.partyOpen = !self.partyOpen;
        var container = document.getElementById('party-stats');
        var icon = document.getElementById('party-expand-icon');

        if (container) {
            if (self.partyOpen) {
                container.classList.add('party-stats--open');
            } else {
                container.classList.remove('party-stats--open');
            }
        }

        if (icon) {
            if (self.partyOpen) {
                icon.classList.add('footer__expand-icon--open');
            } else {
                icon.classList.remove('footer__expand-icon--open');
            }
        }
    });
};

/* --------------------------------------------------------------------------
   Bootstrap
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', function () {
    var arena = new ArenaClient();
    arena.init();
});
