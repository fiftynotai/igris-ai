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
    orchestrator: 'IGRIS',
    architect: 'ARCHITECT',
    forger:    'FORGER',
    sentinel:  'SENTINEL',
    warden:    'WARDEN',
    mender:    'MENDER',
    seeker:    'SEEKER',
    sage:      'SAGE'
};

/** Two-letter monograms for the nexus cores. */
var AGENT_MONOGRAMS = {
    orchestrator: 'IG',
    architect: 'AR',
    forger: 'FO',
    sentinel: 'SE',
    warden: 'WA',
    mender: 'ME',
    seeker: 'SK',
    sage: 'SA'
};

/** Crest watermark glyphs for hex-frame nodes. */
var AGENT_CRESTS = {
    orchestrator: '\u2B21',
    architect: '\u2316',
    forger: '\u2699',
    sentinel: '\u25C8',
    warden: '\u25C9',
    mender: '\u2726',
    seeker: '\u2295',
    sage: '\u262F'
};

/** Pipeline order (for rendering). */
var AGENT_ORDER = ['orchestrator', 'architect', 'forger', 'sentinel', 'warden', 'mender', 'seeker', 'sage'];

/** Agent tier mapping for roster row sizing. */
var AGENT_TIERS = {
    orchestrator: 1, architect: 1, forger: 1, sentinel: 1, warden: 1,
    mender: 3, seeker: 4, sage: 5
};

/** Agent color hex values for roster rows. */
var AGENT_COLORS = {
    orchestrator: '#FF1744',
    architect:    '#448AFF',
    forger:       '#FF6D00',
    sentinel:     '#00E676',
    warden:       '#7C4DFF',
    mender:       '#00BFA5',
    seeker:       '#FFD600',
    sage:         '#E040FB'
};

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

/**
 * Format a per-token cost as per-MTok string.
 * @param {number} costPerToken
 * @returns {string}
 */
function formatRate(costPerToken) {
    if (costPerToken == null || costPerToken === 0) return '$0.00/M';
    var perMTok = costPerToken * 1000000;
    return '$' + perMTok.toFixed(2) + '/M';
}

/**
 * Format a dollar cost value.
 * @param {number} dollars
 * @returns {string}
 */
function formatCost(dollars) {
    if (dollars == null || dollars === 0) return '$0.00';
    if (dollars < 0.01) return '<$0.01';
    return '$' + dollars.toFixed(2);
}

/**
 * Calculate evolution stars from agent tier.
 * @param {number} tier
 * @returns {number}
 */
function evolutionStars(tier) {
    if (tier <= 1) return 0;
    if (tier === 2) return 1;
    if (tier === 3) return 2;
    if (tier === 4) return 3;
    return 4;
}

/**
 * Render star characters for rank display.
 * @param {number} count - number of filled stars (0-4)
 * @returns {string}
 */
function renderStars(count) {
    var filled = '\u2605';
    var empty = '\u2606';
    var result = '';
    for (var i = 0; i < 4; i++) {
        result += (i < count) ? filled : empty;
    }
    return result;
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
    this.currentRange = localStorage.getItem('arena-filter-range') || 'today';
    this.contextWindow = null;
    this._prevContextUsed = 0;
    this._compacting = false;
    this._digiviceInitialized = false;
    this._hpInitialized = false;
    this.pricing = null;
    this.brainState = null;
    this.brainAvailable = false;
}

/**
 * Initialize the client: fetch state, render, connect WebSocket.
 */
ArenaClient.prototype.init = async function () {
    this._bindPartyToggle();
    this._bindFilterToggle();
    this._updateFilterButtons();
    this._initDigiviceSegments();
    this._initHpSegments();
    await this._fetchPricing();
    await this.fetchState();
    this.render();
    this._initNexusLines();
    var self = this;
    window.addEventListener('resize', function () { self._initNexusLines(); });
    this.connectWebSocket();
    this.fetchBrainData();
    setInterval(function () { self.fetchBrainData(); }, 60000);
};

/* --------------------------------------------------------------------------
   Data Fetching
   -------------------------------------------------------------------------- */

/**
 * Fetch initial state via REST /api/state.
 */
ArenaClient.prototype.fetchState = async function () {
    try {
        var url = '/api/state?range=' + encodeURIComponent(this.currentRange);
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var newState = await resp.json();
        // Override server active flags with local timer truth
        if (newState && newState.agents) {
            var agentKeys = Object.keys(newState.agents);
            for (var i = 0; i < agentKeys.length; i++) {
                newState.agents[agentKeys[i]].active = !!this.activeTimers[agentKeys[i]];
            }
        }
        this.state = newState;
        if (newState && newState.context_window) {
            this.contextWindow = newState.context_window;
        }
    } catch (e) {
        console.error('Failed to fetch state:', e);
    }
};

/**
 * Fetch pricing data from /api/pricing endpoint.
 */
ArenaClient.prototype._fetchPricing = async function () {
    try {
        var resp = await fetch('/api/pricing');
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        var data = await resp.json();
        this.pricing = data.pricing || null;
    } catch (e) {
        console.error('Failed to fetch pricing:', e);
        this.pricing = null;
    }
};

/**
 * Extract short model name (Opus/Sonnet/Haiku) from model_id.
 * @returns {string}
 */
ArenaClient.prototype._getModelShortName = function () {
    var modelId = this.contextWindow ? this.contextWindow.model_id : '';
    if (!modelId) return '';
    if (modelId.indexOf('opus') !== -1) return 'Opus';
    if (modelId.indexOf('sonnet') !== -1) return 'Sonnet';
    if (modelId.indexOf('haiku') !== -1) return 'Haiku';
    return modelId;
};

/**
 * Look up pricing rates for the current model_id.
 * @returns {object|null}
 */
ArenaClient.prototype._getModelPricing = function () {
    if (!this.pricing) return null;
    var modelId = this.contextWindow ? this.contextWindow.model_id : '';

    if (modelId && this.pricing[modelId]) {
        return this.pricing[modelId];
    }

    if (modelId) {
        var keys = Object.keys(this.pricing);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf(modelId) !== -1 || modelId.indexOf(keys[i]) !== -1) {
                return this.pricing[keys[i]];
            }
        }
    }

    var allKeys = Object.keys(this.pricing);
    for (var i = 0; i < allKeys.length; i++) {
        if (allKeys[i].indexOf('opus') !== -1) {
            return this.pricing[allKeys[i]];
        }
    }

    return allKeys.length > 0 ? this.pricing[allKeys[0]] : null;
};

/**
 * Calculate cost estimate for the 4 token buckets.
 * @param {number} input
 * @param {number} output
 * @param {number} cacheRead
 * @param {number} cacheCreate
 * @returns {object|null}
 */
ArenaClient.prototype.estimateCost = function (input, output, cacheRead, cacheCreate) {
    var rates = this._getModelPricing();
    if (!rates) return null;

    var inputCost = input * (rates.input_cost_per_token || 0);
    var outputCost = output * (rates.output_cost_per_token || 0);
    var cacheReadCost = cacheRead * (rates.cache_read_input_token_cost || 0);
    var cacheCreateCost = cacheCreate * (rates.cache_creation_input_token_cost || 0);

    return {
        input: inputCost,
        output: outputCost,
        cache_read: cacheReadCost,
        cache_create: cacheCreateCost,
        total: inputCost + outputCost + cacheReadCost + cacheCreateCost,
        rates: rates
    };
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
                // Use WS state directly; override active flags with local timer truth
                self.state = msg.data || msg;
                if (self.state && self.state.agents) {
                    var agentKeys = Object.keys(self.state.agents);
                    for (var i = 0; i < agentKeys.length; i++) {
                        self.state.agents[agentKeys[i]].active = !!self.activeTimers[agentKeys[i]];
                    }
                }
                if (self.state && self.state.context_window) {
                    self.contextWindow = self.state.context_window;
                }
                self.render();
            } else if (msg.type === 'event') {
                var event = msg.data || msg;
                self.handleEvent(event);
            } else if (msg.type === 'brain_state') {
                self.brainState = msg.data || {};
                self.brainAvailable = true;
                self.renderBrainSection();
            } else if (msg.type === 'brain_health') {
                if (!self.brainState) self.brainState = {};
                self.brainState.health = msg.data;
                self.brainAvailable = true;
                self.renderBrainSection();
            } else if (msg.type === 'brain_instances') {
                if (!self.brainState) self.brainState = {};
                self.brainState.instances = msg.data;
                self.renderBrainSection();
            } else if (msg.type === 'brain_projects') {
                if (!self.brainState) self.brainState = {};
                self.brainState.projects = msg.data;
                self.renderBrainSection();
            } else if (msg.type === 'brain_briefs') {
                if (!self.brainState) self.brainState = {};
                self.brainState.briefs = msg.data;
                self.renderBrainSection();
            } else if (msg.type === 'brain_sessions') {
                if (!self.brainState) self.brainState = {};
                self.brainState.sessions = msg.data;
                self.renderBrainSection();
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

        // Update context window for orchestrator stop events with context data
        if (event.agent === 'orchestrator' && (event.context_max || 0) > 0) {
            this._checkCompaction(event);
            this.contextWindow = {
                context_used: event.context_used || 0,
                context_max: event.context_max || 200000,
                context_remaining: event.context_remaining || 0,
                model_id: event.model_id || ''
            };
        }
    }

    if (this._eventMatchesFilter(event)) {
        this.addBattleLogEntry(event);
        this.renderTokenBreakdown();
        this.renderCostCard();
    }

    this.renderAgentPods();
    this.renderBudget();
    this.renderDigivice();
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

    // Clear any existing timer first to prevent interval leaks
    if (this.activeTimers[agent]) {
        clearInterval(this.activeTimers[agent].interval);
        delete this.activeTimers[agent];
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

    // Always update budget (HP bar is always daily)
    if (this.state && this.state.budget) {
        var totalNew = (event.input_tokens || 0) + (event.output_tokens || 0) +
                       (event.cache_read || 0) + (event.cache_create || 0);
        this.state.budget.consumed = (this.state.budget.consumed || 0) + totalNew;
        var ceiling = this.state.budget.ceiling || 1;
        this.state.budget.ratio = this.state.budget.consumed / ceiling;
    }

    // Only update filtered state if event matches current filter
    if (this._eventMatchesFilter(event)) {
        if (this.state && this.state.agents && this.state.agents[agent]) {
            var a = this.state.agents[agent];
            a.total_input_tokens = (a.total_input_tokens || 0) + (event.input_tokens || 0);
            a.total_output_tokens = (a.total_output_tokens || 0) + (event.output_tokens || 0);
            a.total_cache_read_tokens = (a.total_cache_read_tokens || 0) + (event.cache_read || 0);
            a.total_cache_create_tokens = (a.total_cache_create_tokens || 0) + (event.cache_create || 0);
            a.invocations = (a.invocations || 0) + 1;
            a.last_used = event.ts || new Date().toISOString();
        }

        if (this.state && this.state.totals) {
            this.state.totals.total_invocations = (this.state.totals.total_invocations || 0) + 1;
            this.state.totals.total_input_tokens = (this.state.totals.total_input_tokens || 0) + (event.input_tokens || 0);
            this.state.totals.total_output_tokens = (this.state.totals.total_output_tokens || 0) + (event.output_tokens || 0);
            this.state.totals.total_cache_tokens = (this.state.totals.total_cache_tokens || 0) +
                (event.cache_read || 0) + (event.cache_create || 0);
        }
    }

    // Always mark agent as inactive
    if (this.state && this.state.agents && this.state.agents[agent]) {
        this.state.agents[agent].active = false;
    }

    // Clear duration timer
    if (this.activeTimers[agent]) {
        clearInterval(this.activeTimers[agent].interval);
        delete this.activeTimers[agent];
    }

    var timerEl = document.getElementById('timer-' + agent);
    if (timerEl) timerEl.textContent = '';

    var rosterTimerEl = document.getElementById('roster-timer-' + agent);
    if (rosterTimerEl) rosterTimerEl.textContent = '';

    this._updateRowActiveState(agent, false);

    var pod = document.getElementById('pod-' + agent);
    if (pod) {
        var orchClass = (agent === 'orchestrator') ? ' nexus__core--orchestrator' : '';
        var supportClass = (agent === 'mender' || agent === 'seeker' || agent === 'sage') ? ' nexus__core--support' : '';
        pod.className = 'nexus__core nexus__core--complete' + orchClass + supportClass;
        var hexOuterEl = pod.querySelector('.nexus__hex-outer');
        if (hexOuterEl) hexOuterEl.style.setProperty('--xp-deg', '360deg');
        setTimeout(function () {
            if (pod.classList.contains('nexus__core--complete')) {
                pod.className = 'nexus__core nexus__core--has-data' + orchClass + supportClass;
            }
        }, COMPLETE_FLASH_DURATION);
    }

    this._updateNexusLines();
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
    var rosterTimerEl = document.getElementById('roster-timer-' + agent);
    if (rosterTimerEl) rosterTimerEl.textContent = formatDuration(elapsed);
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
        var directTokens = (event.input_tokens || 0) + (event.output_tokens || 0);
        var cachedTokens = (event.cache_read || 0) + (event.cache_create || 0);
        var dur = escapeHtml(event.duration_s ? formatDuration(event.duration_s) : '--');
        var cacheStr = cachedTokens > 0
            ? ' <span class="entry-cache">(+ ' + escapeHtml(formatNumber(cachedTokens)) + ' cached)</span>'
            : '';
        entry.className = 'battle-log__entry battle-log__entry--stop';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-agent">' + agentName + '</span> completed &mdash; ' +
            '<span class="entry-tokens">' + escapeHtml(formatNumber(directTokens)) + ' tokens</span>' +
            cacheStr + ' ' +
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
    this.renderDigivice();
    this.renderAgentPods();
    this.renderTokenBreakdown();
    this.renderCostCard();
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

    this._initHpSegments();

    var consumed = budget.consumed || 0;
    var ceiling = budget.ceiling || 1;
    var ratio = consumed / ceiling;
    var percentage = Math.min(ratio * 100, 100);

    var warnThreshold = budget.warning_threshold || 0.75;
    var critThreshold = budget.critical_threshold || 0.90;

    // Update percentage text
    var pctEl = document.getElementById('hp-pct');
    if (pctEl) pctEl.textContent = percentage.toFixed(1) + '%';

    // Update count text
    var countEl = document.getElementById('hp-count');
    if (countEl) {
        countEl.textContent = formatNumber(consumed) + ' / ' + formatNumber(ceiling) + ' tokens';
    }

    // Update segments (20 total)
    var bar = document.getElementById('hp-bar');
    if (bar) {
        var segments = bar.children;
        var filledCount = Math.round((percentage / 100) * 20);
        for (var i = 0; i < segments.length; i++) {
            if (i < filledCount) {
                segments[i].className = 'digi-panel__segment digi-panel__segment--filled';
            } else {
                segments[i].className = 'digi-panel__segment';
            }
        }
    }

    // Update label text based on threshold
    var labelText = document.getElementById('hp-label-text');
    if (labelText) {
        labelText.textContent = ratio >= critThreshold ? 'HP CRITICAL' : 'SESSION HP';
    }

    // Update state classes on the hp-panel container
    var panel = document.getElementById('hp-panel');
    if (panel) {
        panel.classList.remove('digi-panel--warning', 'digi-panel--overflow');
        if (ratio >= critThreshold) {
            panel.classList.add('digi-panel--overflow');
        } else if (ratio >= warnThreshold) {
            panel.classList.add('digi-panel--warning');
        }
    }
};

/* --------------------------------------------------------------------------
   Rendering: Agent Pods
   -------------------------------------------------------------------------- */

/**
 * Update all 8 agent pods with current state data.
 */
ArenaClient.prototype.renderAgentPods = function () {
    var agents = get(this.state, ['agents'], {});
    for (var i = 0; i < AGENT_ORDER.length; i++) {
        var name = AGENT_ORDER[i];
        var data = agents[name];
        this._renderSinglePod(name, data);
    }
    this._updateNexusLines();
};

/**
 * Render a single agent pod (nexus core).
 * @param {string} name - agent key
 * @param {object|undefined} data - agent state data
 */
ArenaClient.prototype._renderSinglePod = function (name, data) {
    var pod = document.getElementById('pod-' + name);
    if (!pod) return;

    var isOrchestrator = (name === 'orchestrator');
    var isSupport = (name === 'mender' || name === 'seeker' || name === 'sage');

    if (!data) {
        var idleCls = 'nexus__core nexus__core--idle';
        if (isOrchestrator) idleCls += ' nexus__core--orchestrator';
        if (isSupport) idleCls += ' nexus__core--support';
        pod.className = idleCls;
        return;
    }

    var isActive = !!this.activeTimers[name];

    // Update state class (skip if in complete flash)
    if (!pod.classList.contains('nexus__core--complete')) {
        var cls = 'nexus__core';
        if (isOrchestrator) cls += ' nexus__core--orchestrator';
        if (isSupport) cls += ' nexus__core--support';

        if (isActive) {
            cls += ' nexus__core--active';
        } else if ((data.invocations || 0) > 0) {
            cls += ' nexus__core--has-data';
        } else {
            cls += ' nexus__core--idle';
        }
        pod.className = cls;
    }

    // Evolution badge
    var evoEl = document.getElementById('evo-' + name);
    if (evoEl) evoEl.textContent = get(data, ['level', 'evolution'], 'In-Training');

    // Level (hidden)
    var levelEl = document.getElementById('level-' + name);
    if (levelEl) levelEl.textContent = get(data, ['level', 'name'], 'Trainee');

    // XP hex-outer edge segments (conic-gradient via CSS custom property)
    var hexOuter = pod.querySelector('.nexus__hex-outer');
    if (hexOuter) {
        var progress = get(data, ['level', 'progress'], 0);
        var degrees = Math.round(progress * 360);
        hexOuter.style.setProperty('--xp-deg', degrees + 'deg');
    }

    // Legacy XP bar (hidden, for compat)
    var xpEl = document.getElementById('xp-' + name);
    if (xpEl) xpEl.style.width = (get(data, ['level', 'progress'], 0) * 100) + '%';

    // Invocations
    var invEl = document.getElementById('inv-' + name);
    if (invEl) {
        var label = isOrchestrator ? ' turns' : ' runs';
        invEl.textContent = (data.invocations || 0) + label;
    }

    // Last used (hidden)
    var lastEl = document.getElementById('last-' + name);
    if (lastEl) lastEl.textContent = data.last_used ? timeAgo(data.last_used) : '--';

    // Timer (clear when not active)
    var timerEl = document.getElementById('timer-' + name);
    if (timerEl && !isActive) timerEl.textContent = '';

    // Hover stat orbit
    this._renderNexusOrbit(pod, name, data);
};

/**
 * Render the hover stat orbit for a nexus core.
 * @param {Element} pod - the core DOM element
 * @param {string} name - agent key
 * @param {object} data - agent state data
 */
ArenaClient.prototype._renderNexusOrbit = function (pod, name, data) {
    var stats = get(data, ['rpg_stats'], null);
    if (!stats) return;

    var orbit = pod.querySelector('.nexus__orbit');
    if (!orbit) {
        orbit = document.createElement('div');
        orbit.className = 'nexus__orbit';
        var hexFrame = pod.querySelector('.nexus__hex-frame');
        if (hexFrame && hexFrame.parentNode) {
            hexFrame.parentNode.insertBefore(orbit, hexFrame.nextSibling);
        } else {
            pod.appendChild(orbit);
        }
    }

    var statTypes = ['str', 'int', 'spd', 'vit'];
    var statLabels = { str: 'STR', int: 'INT', spd: 'SPD', vit: 'VIT' };

    orbit.innerHTML = '';
    for (var i = 0; i < statTypes.length; i++) {
        var key = statTypes[i];
        var val = stats[key.toUpperCase()] || stats[key] || 0;
        var statDiv = document.createElement('div');
        statDiv.className = 'nexus__orbit-stat nexus__orbit-stat--' + key;
        statDiv.innerHTML =
            '<span>' + escapeHtml(String(statLabels[key])) + '</span>' +
            '<span style="font-weight:700">' + escapeHtml(String(val)) + '</span>' +
            '<div class="nexus__orbit-bar">' +
            '<div class="nexus__orbit-bar-fill nexus__orbit-bar-fill--' + key +
            '" style="width:' + Math.min(val, 100) + '%"></div>' +
            '</div>';
        orbit.appendChild(statDiv);
    }
};

/**
 * Update nexus connection line classes based on agent active/complete state.
 */
ArenaClient.prototype._updateNexusLines = function () {
    var agentKeys = ['architect', 'forger', 'sentinel', 'warden', 'mender', 'seeker', 'sage'];

    for (var i = 0; i < agentKeys.length; i++) {
        var name = agentKeys[i];
        var lineEl = document.getElementById('line-' + name);
        if (!lineEl) continue;

        var isActive = !!this.activeTimers[name];
        var pod = document.getElementById('pod-' + name);
        var isComplete = pod && pod.classList.contains('nexus__core--complete');

        lineEl.classList.remove('nexus__line--active', 'nexus__line--complete');
        if (isActive) {
            lineEl.classList.add('nexus__line--active');
        } else if (isComplete) {
            lineEl.classList.add('nexus__line--complete');
        }
    }
};

/**
 * Compute and apply line geometry from percentage positions for nexus connections.
 */
ArenaClient.prototype._initNexusLines = function () {
    var grid = document.querySelector('.nexus__grid');
    if (!grid) return;

    var positions = {
        orchestrator: { left: 50, top: 42 },
        architect:    { left: 50, top: 12 },
        forger:       { left: 80, top: 42 },
        sentinel:     { left: 50, top: 72 },
        warden:       { left: 20, top: 42 },
        mender:       { left: 25, top: 90 },
        seeker:       { left: 50, top: 90 },
        sage:         { left: 75, top: 90 }
    };

    var orch = positions.orchestrator;
    var w = grid.offsetWidth;
    var h = grid.offsetHeight;
    var ox = orch.left / 100 * w;
    var oy = orch.top / 100 * h;

    var agentKeys = ['architect', 'forger', 'sentinel', 'warden', 'mender', 'seeker', 'sage'];

    for (var i = 0; i < agentKeys.length; i++) {
        var name = agentKeys[i];
        var pos = positions[name];
        var lineEl = document.getElementById('line-' + name);
        if (!lineEl) continue;

        var ax = pos.left / 100 * w;
        var ay = pos.top / 100 * h;

        var dx = ax - ox;
        var dy = ay - oy;
        var length = Math.sqrt(dx * dx + dy * dy);
        var angle = Math.atan2(dy, dx) * (180 / Math.PI);

        lineEl.style.left = ox + 'px';
        lineEl.style.top = oy + 'px';
        lineEl.style.width = length + 'px';
        lineEl.style.transform = 'rotate(' + angle + 'deg)';
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

    var directTotal = inputTokens + outputTokens;
    var cacheTotal = cacheRead + cacheCreate;

    // Direct tokens headline
    var totalEl = document.getElementById('total-tokens');
    if (totalEl) totalEl.textContent = formatNumber(directTotal);

    // Cached tokens parenthetical
    var cachedEl = document.getElementById('total-cached');
    if (cachedEl) {
        if (cacheTotal > 0) {
            cachedEl.innerHTML = '(+ <span style="color: var(--token-cache-r)">' + escapeHtml(formatTokens(cacheTotal)) + '</span> cached)';
            cachedEl.style.display = '';
        } else {
            cachedEl.textContent = '';
            cachedEl.style.display = 'none';
        }
    }

    // Direct group: percentages relative to direct total
    this._renderTokenBar('input', inputTokens, directTotal);
    this._renderTokenBar('output', outputTokens, directTotal);

    // Cache group: percentages relative to cache total
    this._renderTokenBar('cache-read', cacheRead, cacheTotal);
    this._renderTokenBar('cache-create', cacheCreate, cacheTotal);

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

/**
 * Render the cost estimate card in the sidebar.
 */
ArenaClient.prototype.renderCostCard = function () {
    var container = document.getElementById('cost-card');
    if (!container) return;

    var agents = get(this.state, ['agents'], {});
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

    var cost = this.estimateCost(inputTokens, outputTokens, cacheRead, cacheCreate);

    if (!cost) {
        container.classList.add('cost-card--no-pricing');
        return;
    }
    container.classList.remove('cost-card--no-pricing');

    var modelName = escapeHtml(this._getModelShortName() || 'Unknown');
    var rangeLabels = { today: 'Today', week: 'This Week', all: 'All Time' };
    var rangeText = escapeHtml(rangeLabels[this.currentRange] || 'Today');

    var html = '<h2 class="section-title">Cost Estimate <span class="range-label">' +
        '\u2014 ' + rangeText + ' (' + modelName + ')</span></h2>';

    html += '<div class="cost-card__row">' +
        '<span class="cost-card__label">Input</span>' +
        '<span class="cost-card__rate mono">' + escapeHtml(formatTokens(inputTokens)) +
            ' \u00D7 ' + escapeHtml(formatRate(cost.rates.input_cost_per_token)) + '</span>' +
        '<span class="cost-card__amount cost-card__amount--input mono">' + escapeHtml(formatCost(cost.input)) + '</span>' +
    '</div>';

    html += '<div class="cost-card__row">' +
        '<span class="cost-card__label">Output</span>' +
        '<span class="cost-card__rate mono">' + escapeHtml(formatTokens(outputTokens)) +
            ' \u00D7 ' + escapeHtml(formatRate(cost.rates.output_cost_per_token)) + '</span>' +
        '<span class="cost-card__amount cost-card__amount--output mono">' + escapeHtml(formatCost(cost.output)) + '</span>' +
    '</div>';

    html += '<div class="cost-card__separator"></div>';

    html += '<div class="cost-card__row">' +
        '<span class="cost-card__label">Cache Rd</span>' +
        '<span class="cost-card__rate mono">' + escapeHtml(formatTokens(cacheRead)) +
            ' \u00D7 ' + escapeHtml(formatRate(cost.rates.cache_read_input_token_cost)) + '</span>' +
        '<span class="cost-card__amount cost-card__amount--cache-read mono">' + escapeHtml(formatCost(cost.cache_read)) + '</span>' +
    '</div>';

    html += '<div class="cost-card__row">' +
        '<span class="cost-card__label">Cache Wr</span>' +
        '<span class="cost-card__rate mono">' + escapeHtml(formatTokens(cacheCreate)) +
            ' \u00D7 ' + escapeHtml(formatRate(cost.rates.cache_creation_input_token_cost)) + '</span>' +
        '<span class="cost-card__amount cost-card__amount--cache-create mono">' + escapeHtml(formatCost(cost.cache_create)) + '</span>' +
    '</div>';

    html += '<div class="cost-card__total">' +
        '<span class="cost-card__total-label">Estimated Total</span>' +
        '<span class="cost-card__total-value mono">' + escapeHtml(formatCost(cost.total)) + '</span>' +
    '</div>';

    container.innerHTML = html;
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
            var directTokens = (event.input_tokens || 0) + (event.output_tokens || 0);
            var cachedTokens = (event.cache_read || 0) + (event.cache_create || 0);
            var dur = escapeHtml(event.duration_s ? formatDuration(event.duration_s) : '--');
            var cacheStr = cachedTokens > 0
                ? ' <span class="entry-cache">(+ ' + escapeHtml(formatNumber(cachedTokens)) + ' cached)</span>'
                : '';
            entry.className = 'battle-log__entry battle-log__entry--stop';
            entry.innerHTML =
                '<span class="entry-time">[' + time + ']</span> ' +
                '<span class="entry-agent">' + agentName + '</span> completed &mdash; ' +
                '<span class="entry-tokens">' + escapeHtml(formatNumber(directTokens)) + ' tokens</span>' +
                cacheStr + ' ' +
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
 * Render Digimon World-inspired roster rows for all agents in the footer.
 */
ArenaClient.prototype.renderPartyStats = function () {
    var el = document.getElementById('party-stats');
    if (!el) return;

    var agents = get(this.state, ['agents'], {});
    var activeAgent = null;
    var timerKeys = Object.keys(this.activeTimers);
    if (timerKeys.length > 0) activeAgent = timerKeys[timerKeys.length - 1];

    // Group agents by tier
    var tier1Names = AGENT_ORDER.filter(function (n) { return AGENT_TIERS[n] === 1; });
    var supportNames = AGENT_ORDER.filter(function (n) { return AGENT_TIERS[n] > 1; });

    // Calculate summary
    var totalRuns = 0, totalTokens = 0, activeCount = 0, totalXp = 0, agentCount = 0;
    for (var i = 0; i < AGENT_ORDER.length; i++) {
        var name = AGENT_ORDER[i];
        var d = agents[name] || {};
        totalRuns += d.invocations || 0;
        totalTokens += (d.total_input_tokens || 0) + (d.total_output_tokens || 0) +
                       (d.total_cache_read_tokens || 0) + (d.total_cache_create_tokens || 0);
        if (this.activeTimers[name]) activeCount++;
        var level = d.level || {};
        totalXp += Math.round((level.progress || 0) * 100);
        agentCount++;
    }
    var avgXp = agentCount ? Math.round(totalXp / agentCount) : 0;

    var html = '';

    // Tier 1 group
    html += '<div class="roster-tier-group" data-tier="1">';
    html += '<div class="roster-tier-header" tabindex="0" role="button" aria-expanded="true">';
    html += '<span>TIER 1: CORE AGENTS</span>';
    html += '<span class="roster-tier-header__toggle">&#9660;</span>';
    html += '</div>';
    html += '<div class="roster-tier-body">';
    for (var j = 0; j < tier1Names.length; j++) {
        var t1name = tier1Names[j];
        var t1data = agents[t1name] || {};
        var t1active = !!this.activeTimers[t1name];
        html += this._renderFullRow(t1name, t1data, t1active);
    }
    html += '</div></div>';

    // Support group
    html += '<div class="roster-tier-group" data-tier="support">';
    html += '<div class="roster-tier-header" tabindex="0" role="button" aria-expanded="true">';
    html += '<span>TIER 3\u20135: SUPPORT</span>';
    html += '<span class="roster-tier-header__toggle">&#9660;</span>';
    html += '</div>';
    html += '<div class="roster-tier-body">';
    for (var k = 0; k < supportNames.length; k++) {
        var sname = supportNames[k];
        var sdata = agents[sname] || {};
        var sactive = !!this.activeTimers[sname];
        html += this._renderCompactRow(sname, sdata, sactive);
    }
    html += '</div></div>';

    // Party summary footer
    html += this._renderPartySummary(totalRuns, totalTokens, activeCount, agentCount, avgXp);

    el.innerHTML = html;
    this._bindRowExpand();
    this._bindTierCollapse();
};

/**
 * Render a full roster row for a Tier 1 agent.
 * @param {string} name - agent key
 * @param {object} data - agent state data
 * @param {boolean} isActive
 * @returns {string}
 */
ArenaClient.prototype._renderFullRow = function (name, data, isActive) {
    var displayName = AGENT_NAMES[name] || name.toUpperCase();
    var monogram = AGENT_MONOGRAMS[name] || name.slice(0, 2).toUpperCase();
    var crest = AGENT_CRESTS[name] || '';
    var color = AGENT_COLORS[name] || '#888';
    var tier = AGENT_TIERS[name] || 1;
    var invocations = data.invocations || 0;
    var totalTokens = (data.total_input_tokens || 0) + (data.total_output_tokens || 0) +
                      (data.total_cache_read_tokens || 0) + (data.total_cache_create_tokens || 0);
    var lastUsed = data.last_used ? timeAgo(data.last_used) : 'never';
    var level = data.level || {};
    var xp = Math.round((level.progress || 0) * 100);
    var evolution = level.evolution || 'In-Training';
    var starCount = evolutionStars(tier);
    var stars = renderStars(starCount);
    var statusClass = isActive ? 'active' : 'idle';
    var activeClass = isActive ? ' roster-row--active' : '';

    // Compute stats from rpg_stats or derive
    var stats = data.rpg_stats || {};
    var str = stats.STR || stats.str || Math.min(100, Math.round((invocations / 200) * 100));
    var int = stats.INT || stats.int || Math.min(100, Math.round((totalTokens / 100000) * 100));
    var spd = stats.SPD || stats.spd || Math.min(100, Math.round(((data.avg_duration_seconds ? (60 / data.avg_duration_seconds) : 0.5)) * 100));
    var vit = stats.VIT || stats.vit || 80;

    // XP color
    var xpColor = xp <= 50 ? 'var(--tech-crimson)' : xp <= 90 ? 'var(--hp-warning)' : 'var(--success)';

    var html = '';
    html += '<div class="roster-row' + activeClass + '" data-agent="' + escapeHtml(name) + '"';
    html += ' style="--agent-color:' + color + ';--agent-color-dim:' + color + '18;--agent-color-mid:' + color + '66"';
    html += ' tabindex="0" role="button" aria-expanded="false" aria-label="' + escapeHtml(displayName) + ' agent row">';

    // Portrait
    html += '<div class="roster-row__portrait">';
    html += '<div class="roster-row__hex">';
    html += '<span class="roster-row__crest">' + crest + '</span>';
    html += '<span class="roster-row__monogram">' + escapeHtml(monogram) + '</span>';
    html += '</div></div>';

    // Body
    html += '<div class="roster-row__body">';
    // Header
    html += '<div class="roster-row__header">';
    html += '<span class="roster-row__name">' + escapeHtml(displayName) + '</span>';
    html += '<span class="roster-row__tier-badge">T' + tier + '</span>';
    html += '<span class="roster-row__evolution">' + escapeHtml(evolution) + '</span>';
    html += '<span class="roster-row__stars">' + stars + '</span>';
    html += '</div>';
    // XP bar
    html += '<div class="roster-row__xp-row">';
    html += this._renderXpBar(xp, xpColor);
    html += '<span class="roster-row__xp-pct">' + xp + '%</span>';
    html += '</div>';
    // Stat bars
    html += '<div class="roster-row__stats">';
    html += this._renderRosterStatBar('STR', str, 'str');
    html += this._renderRosterStatBar('INT', int, 'int');
    html += this._renderRosterStatBar('SPD', spd, 'spd');
    html += this._renderRosterStatBar('VIT', vit, 'vit');
    html += '</div>';
    // Telemetry
    html += '<div class="roster-row__telemetry">';
    html += '<span>' + invocations + ' runs</span>';
    html += '<span>' + formatTokens(totalTokens) + ' tkn</span>';
    html += '<span>last: ' + escapeHtml(lastUsed) + '</span>';
    html += '</div>';
    html += '</div>';

    // Meta (status + timer)
    html += '<div class="roster-row__meta">';
    html += '<span class="roster-row__status roster-row__status--' + statusClass + '"></span>';
    html += '<span class="roster-row__timer" id="roster-timer-' + escapeHtml(name) + '"></span>';
    html += '</div>';

    // Expanded detail section
    html += '<div class="roster-row__expanded">';
    html += '<div class="roster-row__detail-grid">';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Success Rate</span><span class="roster-row__detail-value">' + Math.round((data.success_rate || 0) * 100) + '%</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Avg Duration</span><span class="roster-row__detail-value">' + (data.avg_duration_seconds ? formatDuration(data.avg_duration_seconds) : '\u2014') + '</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Input Tokens</span><span class="roster-row__detail-value">' + formatTokens(data.total_input_tokens || 0) + '</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Output Tokens</span><span class="roster-row__detail-value">' + formatTokens(data.total_output_tokens || 0) + '</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Cache Read</span><span class="roster-row__detail-value">' + formatTokens(data.total_cache_read_tokens || 0) + '</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Cache Write</span><span class="roster-row__detail-value">' + formatTokens(data.total_cache_create_tokens || 0) + '</span></div>';
    html += '</div></div>';

    html += '</div>';
    return html;
};

/**
 * Render a compact roster row for a support agent (Tier 3-5).
 * @param {string} name - agent key
 * @param {object} data - agent state data
 * @param {boolean} isActive
 * @returns {string}
 */
ArenaClient.prototype._renderCompactRow = function (name, data, isActive) {
    var displayName = AGENT_NAMES[name] || name.toUpperCase();
    var monogram = AGENT_MONOGRAMS[name] || name.slice(0, 2).toUpperCase();
    var crest = AGENT_CRESTS[name] || '';
    var color = AGENT_COLORS[name] || '#888';
    var tier = AGENT_TIERS[name] || 3;
    var invocations = data.invocations || 0;
    var totalTokens = (data.total_input_tokens || 0) + (data.total_output_tokens || 0) +
                      (data.total_cache_read_tokens || 0) + (data.total_cache_create_tokens || 0);
    var level = data.level || {};
    var xp = Math.round((level.progress || 0) * 100);
    var evolution = level.evolution || 'In-Training';
    var statusClass = isActive ? 'active' : 'idle';
    var activeClass = isActive ? ' roster-row--active' : '';

    var html = '';
    html += '<div class="roster-row roster-row--compact' + activeClass + '" data-agent="' + escapeHtml(name) + '"';
    html += ' style="--agent-color:' + color + ';--agent-color-dim:' + color + '18;--agent-color-mid:' + color + '66"';
    html += ' tabindex="0" role="button" aria-expanded="false" aria-label="' + escapeHtml(displayName) + ' agent row">';

    // Portrait
    html += '<div class="roster-row__portrait">';
    html += '<div class="roster-row__hex">';
    html += '<span class="roster-row__crest">' + crest + '</span>';
    html += '<span class="roster-row__monogram">' + escapeHtml(monogram) + '</span>';
    html += '</div></div>';

    // Body (inline)
    html += '<div class="roster-row__body">';
    html += '<div class="roster-row__header">';
    html += '<span class="roster-row__name">' + escapeHtml(displayName) + '</span>';
    html += '<span class="roster-row__tier-badge">T' + tier + '</span>';
    html += '<span class="roster-row__evolution">' + escapeHtml(evolution) + '</span>';
    html += '<span class="roster-row__xp-inline">' + xp + '% XP</span>';
    html += '</div>';
    html += '<div class="roster-row__telemetry">';
    html += '<span>' + invocations + ' runs</span>';
    html += '<span>' + formatTokens(totalTokens) + ' tkn</span>';
    html += '</div>';
    html += '</div>';

    // Meta
    html += '<div class="roster-row__meta">';
    html += '<span class="roster-row__status roster-row__status--' + statusClass + '"></span>';
    html += '<span class="roster-row__timer" id="roster-timer-' + escapeHtml(name) + '"></span>';
    html += '</div>';

    // Expanded
    html += '<div class="roster-row__expanded">';
    html += '<div class="roster-row__detail-grid">';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Success Rate</span><span class="roster-row__detail-value">' + Math.round((data.success_rate || 0) * 100) + '%</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Avg Duration</span><span class="roster-row__detail-value">' + (data.avg_duration_seconds ? formatDuration(data.avg_duration_seconds) : '\u2014') + '</span></div>';
    html += '<div class="roster-row__detail-item"><span class="roster-row__detail-label">Total Tokens</span><span class="roster-row__detail-value">' + formatTokens(totalTokens) + '</span></div>';
    html += '</div></div>';

    html += '</div>';
    return html;
};

/**
 * Render a 10-segment XP bar with chevron shapes.
 * @param {number} progress - 0-100
 * @param {string} color - CSS color value
 * @returns {string}
 */
ArenaClient.prototype._renderXpBar = function (progress, color) {
    var totalSegments = 10;
    var filledCount = Math.round((progress / 100) * totalSegments);
    var html = '<div class="roster-row__xp-bar">';
    for (var i = 0; i < totalSegments; i++) {
        var filled = i < filledCount ? ' roster-row__xp-segment--filled' : '';
        html += '<div class="roster-row__xp-segment' + filled + '" style="--xp-color:' + color + '"></div>';
    }
    html += '</div>';
    return html;
};

/**
 * Generate HTML for a single inline stat bar on a roster row.
 * @param {string} label - stat label (STR/INT/SPD/VIT)
 * @param {number} value - 0-100
 * @param {string} cssKey - str|int|spd|vit
 * @returns {string}
 */
ArenaClient.prototype._renderRosterStatBar = function (label, value, cssKey) {
    var pctVal = Math.min(100, Math.max(0, value));
    return '<div class="roster-row__stat">' +
        '<span class="roster-row__stat-label">' + escapeHtml(label) + '</span>' +
        '<div class="roster-row__stat-track">' +
        '<div class="roster-row__stat-fill roster-row__stat-fill--' + cssKey + '" style="width:' + pctVal + '%"></div>' +
        '</div></div>';
};

/**
 * Render the party summary footer row.
 * @param {number} totalRuns
 * @param {number} totalTokens
 * @param {number} activeCount
 * @param {number} agentCount
 * @param {number} avgXp
 * @returns {string}
 */
ArenaClient.prototype._renderPartySummary = function (totalRuns, totalTokens, activeCount, agentCount, avgXp) {
    return '<div class="roster-summary">' +
        '<div class="roster-summary__item"><span class="roster-summary__label">Runs</span><span class="roster-summary__value">' + totalRuns + '</span></div>' +
        '<div class="roster-summary__item"><span class="roster-summary__label">Tokens</span><span class="roster-summary__value">' + formatTokens(totalTokens) + '</span></div>' +
        '<div class="roster-summary__item"><span class="roster-summary__label">Active</span><span class="roster-summary__value">' + activeCount + '/' + agentCount + '</span></div>' +
        '<div class="roster-summary__item"><span class="roster-summary__label">Avg XP</span><span class="roster-summary__value">' + avgXp + '%</span></div>' +
        '</div>';
};

/**
 * Bind click and keyboard handlers for expanding roster rows.
 * Uses event delegation on the container.
 */
ArenaClient.prototype._bindRowExpand = function () {
    var container = document.getElementById('party-stats');
    if (!container || this._rowExpandBound) return;
    this._rowExpandBound = true;

    container.addEventListener('click', function (e) {
        var row = e.target.closest('.roster-row');
        if (!row) return;
        if (e.target.closest('.roster-tier-header')) return;
        var isExpanded = row.classList.toggle('roster-row--expanded');
        row.setAttribute('aria-expanded', isExpanded);
    });

    container.addEventListener('keydown', function (e) {
        var row = e.target.closest('.roster-row');
        if (!row) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            var isExpanded = row.classList.toggle('roster-row--expanded');
            row.setAttribute('aria-expanded', isExpanded);
        } else if (e.key === 'Escape') {
            row.classList.remove('roster-row--expanded');
            row.setAttribute('aria-expanded', 'false');
        }
    });
};

/**
 * Bind click and keyboard handlers for collapsing tier groups.
 */
ArenaClient.prototype._bindTierCollapse = function () {
    var container = document.getElementById('party-stats');
    if (!container) return;
    container.querySelectorAll('.roster-tier-header').forEach(function (header) {
        header.addEventListener('click', function () {
            var group = header.closest('.roster-tier-group');
            if (!group) return;
            var isCollapsed = group.classList.toggle('roster-tier-group--collapsed');
            header.setAttribute('aria-expanded', !isCollapsed);
        });
        header.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                header.click();
            }
        });
    });
};

/**
 * Update active state on a roster row without full re-render.
 * @param {string} name - agent key
 * @param {boolean} isActive
 */
ArenaClient.prototype._updateRowActiveState = function (name, isActive) {
    var row = document.querySelector('.roster-row[data-agent="' + name + '"]');
    if (!row) return;
    if (isActive) {
        row.classList.add('roster-row--active');
        var dot = row.querySelector('.roster-row__status');
        if (dot) { dot.className = 'roster-row__status roster-row__status--active'; }
    } else {
        row.classList.remove('roster-row--active');
        var dot = row.querySelector('.roster-row__status');
        if (dot) { dot.className = 'roster-row__status roster-row__status--idle'; }
    }
};

/* --------------------------------------------------------------------------
   Rendering: Digivice Context Window
   -------------------------------------------------------------------------- */

/**
 * Create 20 segment divs inside the #digivice-bar element.
 */
ArenaClient.prototype._initDigiviceSegments = function () {
    var bar = document.getElementById('digivice-bar');
    if (!bar || this._digiviceInitialized) return;
    bar.innerHTML = '';
    for (var i = 0; i < 20; i++) {
        var seg = document.createElement('div');
        seg.className = 'digi-panel__segment';
        bar.appendChild(seg);
    }
    this._digiviceInitialized = true;
};

/**
 * Create 20 segment divs inside the #hp-bar element.
 */
ArenaClient.prototype._initHpSegments = function () {
    var bar = document.getElementById('hp-bar');
    if (!bar || this._hpInitialized) return;
    bar.innerHTML = '';
    for (var i = 0; i < 20; i++) {
        var seg = document.createElement('div');
        seg.className = 'digi-panel__segment';
        bar.appendChild(seg);
    }
    this._hpInitialized = true;
};

/**
 * Update the Digivice display with current context window state.
 */
ArenaClient.prototype.renderDigivice = function () {
    var ctx = this.contextWindow;
    if (!ctx) return;

    var used = ctx.context_used || 0;
    var max = ctx.context_max || 200000;
    var remaining = ctx.context_remaining || 0;
    var ratio = max > 0 ? used / max : 0;
    var percentage = Math.min(ratio * 100, 100);

    // Update percentage text
    var pctEl = document.getElementById('digivice-pct');
    if (pctEl) pctEl.textContent = percentage.toFixed(1) + '%';

    // Update count text
    var countEl = document.getElementById('digivice-count');
    if (countEl) countEl.textContent = formatNumber(used) + ' / ' + formatNumber(max) + ' ctx';

    // Update segments (20 total)
    var bar = document.getElementById('digivice-bar');
    if (bar) {
        var segments = bar.children;
        var filledCount = Math.round((percentage / 100) * 20);
        for (var i = 0; i < segments.length; i++) {
            if (i < filledCount) {
                segments[i].className = 'digi-panel__segment digi-panel__segment--filled';
            } else {
                segments[i].className = 'digi-panel__segment';
            }
        }
    }

    // Update label text based on threshold
    var labelText = document.getElementById('digivice-label-text');
    if (labelText) {
        labelText.textContent = percentage >= 90 ? 'DATA OVERFLOW' : 'DATA LOAD';
    }

    // Update state classes on the digivice container
    var digivice = document.getElementById('digivice');
    if (digivice && !this._compacting) {
        // Clear all state classes
        digivice.classList.remove('digi-panel--transition', 'digi-panel--warning', 'digi-panel--overflow');

        if (percentage >= 90) {
            digivice.classList.add('digi-panel--overflow');
        } else if (percentage >= 80) {
            digivice.classList.add('digi-panel--warning');
        } else if (percentage >= 60) {
            digivice.classList.add('digi-panel--transition');
        }
    }

    // Update composition tags
    this._renderDigiviceTags();
};

/**
 * Update the composition tags below the bar from orchestrator data.
 */
ArenaClient.prototype._renderDigiviceTags = function () {
    var tagsEl = document.getElementById('digivice-tags');
    if (!tagsEl) return;

    var agents = get(this.state, ['agents'], {});
    var orch = agents.orchestrator;
    if (!orch) return;

    var cacheRead = orch.total_cache_read_tokens || 0;
    var inputTokens = orch.total_input_tokens || 0;
    var outputTokens = orch.total_output_tokens || 0;

    tagsEl.innerHTML =
        '<span class="digi-panel__tag">[cache:' + escapeHtml(formatTokens(cacheRead)) + ']</span>' +
        '<span class="digi-panel__tag">[in:' + escapeHtml(formatTokens(inputTokens)) + ']</span>' +
        '<span class="digi-panel__tag">[out:' + escapeHtml(formatTokens(outputTokens)) + ']</span>';
};

/**
 * Detect context compaction: a drop of >30% between consecutive turns.
 * @param {object} event - the incoming orchestrator stop event
 */
ArenaClient.prototype._checkCompaction = function (event) {
    var newUsed = event.context_used || 0;
    var prevUsed = this._prevContextUsed || 0;

    // Update previous for next comparison
    this._prevContextUsed = newUsed;

    // Detect compaction: previous was > 0 and dropped by more than 30%
    if (prevUsed > 0 && newUsed > 0 && newUsed < prevUsed * 0.7) {
        this._triggerCompactionAnimation();
    }
};

/**
 * 4-phase compaction animation: flicker -> drain -> flash -> settle.
 */
ArenaClient.prototype._triggerCompactionAnimation = function () {
    var self = this;
    var digivice = document.getElementById('digivice');
    var screen = digivice ? digivice.querySelector('.digi-panel__screen') : null;
    if (!digivice) return;

    this._compacting = true;

    // Phase 1: Flicker (300ms)
    digivice.classList.add('digi-panel--compacting');

    // Add compaction overlay text
    var overlay = document.createElement('div');
    overlay.className = 'digi-panel__compaction-text';
    overlay.textContent = '> REFORMATTING DATA...';
    if (screen) screen.appendChild(overlay);

    setTimeout(function () {
        // Phase 2: Drain (600ms)
        digivice.classList.remove('digi-panel--compacting');
        digivice.classList.add('digi-panel--draining');

        setTimeout(function () {
            // Phase 3: Flash (300ms)
            digivice.classList.remove('digi-panel--draining');
            digivice.classList.add('digi-panel--flash');

            setTimeout(function () {
                // Phase 4: Settle - remove animation classes, show confirmation
                digivice.classList.remove('digi-panel--flash');
                overlay.textContent = '> DATA REFORMATTED';
                self._compacting = false;
                // Re-render to apply correct state classes
                self.renderDigivice();

                // Remove confirmation text after 3 seconds
                setTimeout(function () {
                    if (overlay && overlay.parentNode) {
                        overlay.parentNode.removeChild(overlay);
                    }
                }, 3000);
            }, 300);
        }, 600);
    }, 300);
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
   Filter Toggle
   -------------------------------------------------------------------------- */

/**
 * Bind click handler for the time range filter toggle buttons.
 */
ArenaClient.prototype._bindFilterToggle = function () {
    var self = this;
    var toggle = document.getElementById('filter-toggle');
    if (!toggle) return;

    toggle.addEventListener('click', function (e) {
        var btn = e.target.closest('.filter-btn');
        if (!btn) return;

        var range = btn.getAttribute('data-range');
        if (!range || range === self.currentRange) return;

        self.currentRange = range;
        localStorage.setItem('arena-filter-range', range);
        self._updateFilterButtons();
        self.fetchState().then(function () {
            self.render();
        });
    });
};

/**
 * Update filter button active states and range label text.
 */
ArenaClient.prototype._updateFilterButtons = function () {
    var buttons = document.querySelectorAll('.filter-btn');
    for (var i = 0; i < buttons.length; i++) {
        var btn = buttons[i];
        if (btn.getAttribute('data-range') === this.currentRange) {
            btn.classList.add('filter-btn--active');
        } else {
            btn.classList.remove('filter-btn--active');
        }
    }

    var label = document.getElementById('range-label');
    if (label) {
        var labels = { today: 'Today', week: 'This Week', all: 'All Time' };
        label.textContent = '\u2014 ' + (labels[this.currentRange] || 'Today');
    }
};

/**
 * Check if an event matches the current time range filter.
 * @param {object} event
 * @returns {boolean}
 */
ArenaClient.prototype._eventMatchesFilter = function (event) {
    if (this.currentRange === 'all') return true;

    var eventDate = event.ts ? event.ts.substring(0, 10) : '';
    if (!eventDate) return true;

    if (this.currentRange === 'today') {
        var today = new Date().toISOString().substring(0, 10);
        return eventDate === today;
    }

    if (this.currentRange === 'week') {
        var now = new Date();
        var dayOfWeek = now.getDay();
        var diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
        var monday = new Date(now);
        monday.setDate(now.getDate() - diff);
        var mondayStr = monday.toISOString().substring(0, 10);
        return eventDate >= mondayStr;
    }

    return true;
};

/* --------------------------------------------------------------------------
   Brain Command Center: Helper Utilities
   -------------------------------------------------------------------------- */

/**
 * Format bytes to human-readable string (KB, MB, GB).
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
}

/**
 * Format seconds to human-readable uptime string.
 * @param {number} seconds
 * @returns {string}
 */
function formatUptime(seconds) {
    if (seconds == null || seconds === 0) return '0s';
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
}

/**
 * Format ISO timestamp to relative time string.
 * @param {string} isoString
 * @returns {string}
 */
function formatRelativeTime(isoString) {
    if (!isoString) return '--';
    var diff = Date.now() - new Date(isoString).getTime();
    if (diff < 0) return 'just now';
    var seconds = Math.floor(diff / 1000);
    if (seconds < 60) return seconds + 's ago';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.floor(minutes / 60);
    if (hours < 24) return hours + 'h ago';
    var days = Math.floor(hours / 24);
    if (days < 7) return days + 'd ago';
    return Math.floor(days / 7) + 'w ago';
}

/**
 * Get a date group label for session grouping.
 * @param {string} isoString
 * @returns {string}
 */
function getDateGroup(isoString) {
    if (!isoString) return 'Unknown';
    var date = new Date(isoString);
    var today = new Date();
    var yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);

    var dateStr = date.toISOString().substring(0, 10);
    var todayStr = today.toISOString().substring(0, 10);
    var yesterdayStr = yesterday.toISOString().substring(0, 10);

    if (dateStr === todayStr) return 'Today';
    if (dateStr === yesterdayStr) return 'Yesterday';
    return 'Earlier';
}

/* --------------------------------------------------------------------------
   Brain Command Center: Data Fetching
   -------------------------------------------------------------------------- */

/**
 * Fetch all brain data endpoints in parallel.
 */
ArenaClient.prototype.fetchBrainData = async function () {
    var self = this;
    var startTime = Date.now();

    var endpoints = [
        { key: 'health', url: '/api/brain/health' },
        { key: 'instances', url: '/api/brain/instances' },
        { key: 'projects', url: '/api/brain/projects' },
        { key: 'briefs', url: '/api/brain/briefs' },
        { key: 'sessions', url: '/api/brain/sessions' }
    ];

    var promises = endpoints.map(function (ep) {
        return fetch(ep.url).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    });

    var results = await Promise.allSettled(promises);
    var latencyMs = Date.now() - startTime;

    var state = {};
    var anySuccess = false;
    for (var i = 0; i < results.length; i++) {
        if (results[i].status === 'fulfilled') {
            state[endpoints[i].key] = results[i].value;
            anySuccess = true;
        } else {
            state[endpoints[i].key] = null;
        }
    }
    state._latencyMs = latencyMs;

    self.brainState = state;
    self.brainAvailable = anySuccess;
    self.renderBrainSection();
};

/* --------------------------------------------------------------------------
   Brain Command Center: Rendering
   -------------------------------------------------------------------------- */

/**
 * Master render for the brain section. Calls sub-renders or shows offline state.
 */
ArenaClient.prototype.renderBrainSection = function () {
    var section = document.getElementById('brain-section');
    if (!section) return;

    if (!this.brainAvailable) {
        section.classList.add('brain-section--offline');
        var badge = document.getElementById('brain-health-badge');
        if (badge) {
            badge.querySelector('.brain-health-badge__dot').className = 'brain-health-badge__dot brain-health-badge__dot--offline';
            badge.querySelector('.brain-health-badge__text').textContent = 'OFFLINE';
        }
        return;
    }

    section.classList.remove('brain-section--offline');

    var bs = this.brainState || {};
    this.renderBrainHealth(bs.health);
    this.renderBrainInstances(bs.instances);
    this.renderBrainProjects(bs.projects);
    this.renderBrainBriefs(bs.briefs);
    this.renderBrainSessions(bs.sessions);
};

/**
 * Render the brain health card.
 * @param {object|null} data
 */
ArenaClient.prototype.renderBrainHealth = function (data) {
    var badge = document.getElementById('brain-health-badge');

    if (!data) {
        if (badge) {
            badge.querySelector('.brain-health-badge__dot').className = 'brain-health-badge__dot brain-health-badge__dot--offline';
            badge.querySelector('.brain-health-badge__text').textContent = 'OFFLINE';
        }
        return;
    }

    // Badge
    if (badge) {
        badge.querySelector('.brain-health-badge__dot').className = 'brain-health-badge__dot brain-health-badge__dot--online';
        badge.querySelector('.brain-health-badge__text').textContent = 'ONLINE';
    }

    // Status
    var statusEl = document.getElementById('brain-stat-status');
    if (statusEl) {
        statusEl.textContent = 'ONLINE';
        statusEl.className = 'brain-stat__value brain-stat__value--online';
    }

    // Version
    var versionEl = document.getElementById('brain-stat-version');
    if (versionEl) versionEl.textContent = data.version || data.brain_version || '--';

    // Latency
    var latencyEl = document.getElementById('brain-stat-latency');
    if (latencyEl) {
        var lat = (this.brainState && this.brainState._latencyMs) ? this.brainState._latencyMs : null;
        latencyEl.textContent = lat != null ? lat + 'ms' : 'N/A';
    }

    // DB Size
    var dbsizeEl = document.getElementById('brain-stat-dbsize');
    if (dbsizeEl) dbsizeEl.textContent = data.db_size_bytes ? formatBytes(data.db_size_bytes) : (data.db_size || '--');

    // Uptime
    var uptimeEl = document.getElementById('brain-stat-uptime');
    if (uptimeEl) uptimeEl.textContent = data.uptime_seconds ? formatUptime(data.uptime_seconds) : (data.uptime || '--');

    // Records
    var recordsEl = document.getElementById('brain-stat-records');
    if (recordsEl) {
        var totalRecords = 0;
        if (data.counts) {
            var countKeys = Object.keys(data.counts);
            for (var i = 0; i < countKeys.length; i++) {
                totalRecords += data.counts[countKeys[i]] || 0;
            }
        } else if (data.total_records != null) {
            totalRecords = data.total_records;
        }
        recordsEl.textContent = formatNumber(totalRecords);
    }
};

/**
 * Render the live instances table.
 * @param {object|null} data
 */
ArenaClient.prototype.renderBrainInstances = function (data) {
    var container = document.getElementById('brain-instances-table');
    var countEl = document.getElementById('brain-instances-count');
    if (!container) return;

    var instances = [];
    if (data && Array.isArray(data)) {
        instances = data;
    } else if (data && data.instances && Array.isArray(data.instances)) {
        instances = data.instances;
    }

    if (countEl) countEl.textContent = instances.length;

    if (instances.length === 0) {
        container.innerHTML = '<div class="brain-panel__empty">No active instances</div>';
        return;
    }

    var html = '<table class="brain-table">';
    html += '<thead><tr>';
    html += '<th>Machine</th><th>OS</th><th>Project</th><th>Brief</th><th>Phase</th><th>Status</th><th>Heartbeat</th>';
    html += '</tr></thead><tbody>';

    var now = Date.now();
    for (var i = 0; i < instances.length; i++) {
        var inst = instances[i];
        var heartbeat = inst.last_heartbeat_at || inst.last_heartbeat || inst.updated_at || '';
        var staleMs = heartbeat ? (now - new Date(heartbeat).getTime()) : Infinity;
        var isStale = staleMs > 300000; // 5 minutes
        var isActive = inst.status === 'active' || (!inst.status && staleMs < 60000);
        var statusClass = isStale ? 'stale' : (isActive ? 'active' : 'idle');
        var rowClass = isStale ? ' brain-table__row--stale' : '';

        html += '<tr class="brain-table__row' + rowClass + '">';
        html += '<td class="brain-table__cell">' + escapeHtml(inst.machine_hostname || inst.machine_name || '--') + '</td>';
        html += '<td class="brain-table__cell">' + escapeHtml(inst.machine_os || inst.os || '--') + '</td>';
        html += '<td class="brain-table__cell brain-table__cell--project">' + escapeHtml(inst.project || inst.project_slug || '--') + '</td>';
        html += '<td class="brain-table__cell">' + escapeHtml(inst.brief || inst.current_brief || '--') + '</td>';
        html += '<td class="brain-table__cell">' + escapeHtml(inst.phase || inst.current_phase || '--') + '</td>';
        html += '<td class="brain-table__cell"><span class="brain-status brain-status--' + statusClass + '"><span class="brain-status__dot"></span>' + escapeHtml(statusClass.toUpperCase()) + '</span></td>';
        html += '<td class="brain-table__cell brain-table__cell--time">' + escapeHtml(formatRelativeTime(heartbeat)) + '</td>';
        html += '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
};

/**
 * Render the projects card grid.
 * @param {object|null} data
 */
ArenaClient.prototype.renderBrainProjects = function (data) {
    var container = document.getElementById('brain-projects-grid');
    var countEl = document.getElementById('brain-projects-count');
    if (!container) return;

    var projects = [];
    if (data && Array.isArray(data)) {
        projects = data;
    } else if (data && data.projects && Array.isArray(data.projects)) {
        projects = data.projects;
    }

    if (countEl) countEl.textContent = projects.length;

    if (projects.length === 0) {
        container.innerHTML = '<div class="brain-panel__empty">No projects registered</div>';
        return;
    }

    var html = '<div class="brain-projects__cards">';
    for (var i = 0; i < projects.length; i++) {
        var proj = projects[i];
        var isActive = proj.status === 'active';
        var cardClass = isActive ? '' : ' brain-project-card--inactive';

        html += '<div class="brain-project-card' + cardClass + '">';
        html += '<div class="brain-project-card__header">';
        html += '<span class="brain-project-card__name">' + escapeHtml(proj.name || proj.slug || '--') + '</span>';
        html += '<span class="brain-project-card__status brain-project-card__status--' + (isActive ? 'active' : 'inactive') + '">' + escapeHtml(isActive ? 'ACTIVE' : 'INACTIVE') + '</span>';
        html += '</div>';
        if (proj.slug && proj.slug !== proj.name) {
            html += '<div class="brain-project-card__slug">' + escapeHtml(proj.slug) + '</div>';
        }
        if (proj.tech_stack || proj.technologies) {
            var techs = proj.tech_stack || proj.technologies || [];
            if (typeof techs === 'string') techs = techs.split(',');
            if (techs.length > 0) {
                html += '<div class="brain-project-card__tags">';
                for (var t = 0; t < techs.length && t < 5; t++) {
                    html += '<span class="brain-tag">' + escapeHtml(techs[t].trim()) + '</span>';
                }
                html += '</div>';
            }
        }
        if (proj.last_session || proj.updated_at) {
            html += '<div class="brain-project-card__time">' + escapeHtml(formatRelativeTime(proj.last_session || proj.updated_at)) + '</div>';
        }
        html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
};

/**
 * Render the briefs panel with summary pills and table.
 * @param {object|null} data
 */
ArenaClient.prototype.renderBrainBriefs = function (data) {
    var summaryEl = document.getElementById('brain-briefs-summary');
    var tableEl = document.getElementById('brain-briefs-table');
    var countEl = document.getElementById('brain-briefs-count');
    if (!tableEl) return;

    var briefs = [];
    if (data && Array.isArray(data)) {
        briefs = data;
    } else if (data && data.briefs && Array.isArray(data.briefs)) {
        briefs = data.briefs;
    }

    if (countEl) countEl.textContent = briefs.length;

    // Summary pills
    if (summaryEl) {
        var statusCounts = {};
        for (var s = 0; s < briefs.length; s++) {
            var st = briefs[s].status || 'Unknown';
            statusCounts[st] = (statusCounts[st] || 0) + 1;
        }
        var pillOrder = ['Ready', 'In Progress', 'Done', 'Draft', 'Blocked'];
        var pillHtml = '';
        for (var p = 0; p < pillOrder.length; p++) {
            var pName = pillOrder[p];
            if (statusCounts[pName]) {
                var pillClass = pName.toLowerCase().replace(/\s+/g, '-');
                pillHtml += '<span class="brain-brief-pill brain-brief-pill--' + pillClass + '">' +
                    escapeHtml(pName) + ': ' + statusCounts[pName] + '</span>';
            }
        }
        // Any remaining statuses
        var pillKeys = Object.keys(statusCounts);
        for (var pk = 0; pk < pillKeys.length; pk++) {
            if (pillOrder.indexOf(pillKeys[pk]) === -1) {
                pillHtml += '<span class="brain-brief-pill">' + escapeHtml(pillKeys[pk]) + ': ' + statusCounts[pillKeys[pk]] + '</span>';
            }
        }
        summaryEl.innerHTML = pillHtml;
    }

    // Table
    if (briefs.length === 0) {
        tableEl.innerHTML = '<div class="brain-panel__empty">No briefs found</div>';
        return;
    }

    var html = '<table class="brain-table">';
    html += '<thead><tr>';
    html += '<th>Project</th><th>Brief</th><th>Type</th><th>Title</th><th>Status</th><th>Priority</th>';
    html += '</tr></thead><tbody>';

    for (var b = 0; b < briefs.length; b++) {
        var brief = briefs[b];
        var bStatus = brief.status || '--';
        var bStatusClass = bStatus.toLowerCase().replace(/\s+/g, '-');

        html += '<tr class="brain-table__row">';
        html += '<td class="brain-table__cell brain-table__cell--project">' + escapeHtml(brief.project || brief.project_slug || '--') + '</td>';
        html += '<td class="brain-table__cell brain-table__cell--id">' + escapeHtml(brief.brief_id || brief.id || '--') + '</td>';
        html += '<td class="brain-table__cell">' + escapeHtml(brief.type || '--') + '</td>';
        html += '<td class="brain-table__cell brain-table__cell--title">' + escapeHtml(brief.title || '--') + '</td>';
        html += '<td class="brain-table__cell"><span class="brain-brief-status brain-brief-status--' + escapeHtml(bStatusClass) + '">' + escapeHtml(bStatus) + '</span></td>';
        html += '<td class="brain-table__cell brain-table__cell--priority">' + escapeHtml(brief.priority || '--') + '</td>';
        html += '</tr>';
    }

    html += '</tbody></table>';
    tableEl.innerHTML = html;
};

/**
 * Render the sessions timeline, grouped by date.
 * @param {object|null} data
 */
ArenaClient.prototype.renderBrainSessions = function (data) {
    var container = document.getElementById('brain-sessions-list');
    var countEl = document.getElementById('brain-sessions-count');
    if (!container) return;

    var sessions = [];
    if (data && Array.isArray(data)) {
        sessions = data;
    } else if (data && data.sessions && Array.isArray(data.sessions)) {
        sessions = data.sessions;
    }

    if (countEl) countEl.textContent = sessions.length;

    if (sessions.length === 0) {
        container.innerHTML = '<div class="brain-panel__empty">No recent sessions</div>';
        return;
    }

    // Sort newest first
    sessions.sort(function (a, b) {
        var ta = a.started_at || a.created_at || a.timestamp || '';
        var tb = b.started_at || b.created_at || b.timestamp || '';
        return tb.localeCompare(ta);
    });

    // Group by date
    var groups = {};
    var groupOrder = [];
    for (var i = 0; i < sessions.length; i++) {
        var sess = sessions[i];
        var ts = sess.started_at || sess.created_at || sess.timestamp || '';
        var group = getDateGroup(ts);
        if (!groups[group]) {
            groups[group] = [];
            groupOrder.push(group);
        }
        groups[group].push(sess);
    }

    var html = '';
    for (var g = 0; g < groupOrder.length; g++) {
        var gName = groupOrder[g];
        html += '<div class="brain-session-group">';
        html += '<div class="brain-session-group__header">' + escapeHtml(gName) + '</div>';
        var gSessions = groups[gName];
        for (var j = 0; j < gSessions.length; j++) {
            var s = gSessions[j];
            var sTs = s.started_at || s.created_at || s.timestamp || '';
            html += '<div class="brain-session-entry">';
            html += '<span class="brain-session-entry__time">' + escapeHtml(formatRelativeTime(sTs)) + '</span>';
            html += '<span class="brain-session-entry__project">' + escapeHtml(s.project || s.project_slug || '--') + '</span>';
            if (s.brief || s.brief_id) {
                html += '<span class="brain-session-entry__brief">' + escapeHtml(s.brief || s.brief_id) + '</span>';
            }
            if (s.mode) {
                html += '<span class="brain-session-entry__mode">' + escapeHtml(s.mode) + '</span>';
            }
            if (s.summary || s.goal) {
                html += '<span class="brain-session-entry__summary">' + escapeHtml(s.summary || s.goal) + '</span>';
            }
            html += '</div>';
        }
        html += '</div>';
    }
    container.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Bootstrap
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', function () {
    var arena = new ArenaClient();
    arena.init();
});
