/* ==========================================================================
   CRIMSON ARENA - Igris AI Agent Dashboard
   Client-side application: WebSocket + REST state management
   v14 - Two-page redesign (HOME + INSTANCES)
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

/** Pipeline phase order for instance expanded view. */
var PIPELINE_PHASES = ['plan', 'build', 'test', 'review', 'done'];

/** Phase name mapping from various brain formats. */
var PHASE_MAP = {
    'PLANNING': 'plan', 'PLAN': 'plan',
    'BUILDING': 'build', 'BUILD': 'build', 'IMPLEMENTING': 'build',
    'TESTING': 'test', 'TEST': 'test',
    'REVIEWING': 'review', 'REVIEW': 'review',
    'COMMITTING': 'done', 'COMPLETE': 'done', 'DONE': 'done'
};

/* --------------------------------------------------------------------------
   Utility Functions
   -------------------------------------------------------------------------- */

/**
 * Escape a string for safe insertion into innerHTML.
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
    var s = isoString.endsWith('Z') ? isoString : isoString.replace(' ', 'T') + 'Z';
    var diff = Date.now() - new Date(s).getTime();
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
    var s = isoString.endsWith('Z') ? isoString : isoString.replace(' ', 'T') + 'Z';
    var diff = Date.now() - new Date(s).getTime();
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
    this.syncStatus = null;
    this.teamStatus = null;
    this.knowledgeState = null;
    this.skillData = null;

    // Router state
    this.currentPage = 'home';
    this.expandedInstanceId = null;
    this._startTime = Date.now();
}

/* --------------------------------------------------------------------------
   Hash Router
   -------------------------------------------------------------------------- */

/**
 * Initialize the hash router, parse initial hash, listen for changes.
 */
ArenaClient.prototype._initRouter = function () {
    var self = this;
    window.addEventListener('hashchange', function () { self._onHashChange(); });
    this._onHashChange();
};

/**
 * Handle hash changes and switch pages.
 */
ArenaClient.prototype._onHashChange = function () {
    var hash = window.location.hash || '#home';
    var parts = hash.replace('#', '').split('/');
    var page = parts[0] || 'home';

    if (page === 'instances') {
        this.currentPage = 'instances';
        this.expandedInstanceId = parts[1] || null;
    } else {
        this.currentPage = 'home';
        this.expandedInstanceId = null;
    }

    this._showCurrentPage();
    this._updateNavTabs();
    this.renderCurrentPage();
};

/**
 * Show/hide page containers based on current page.
 */
ArenaClient.prototype._showCurrentPage = function () {
    var homePage = document.getElementById('page-home');
    var instancesPage = document.getElementById('page-instances');

    if (this.currentPage === 'instances') {
        if (homePage) homePage.style.display = 'none';
        if (instancesPage) instancesPage.style.display = '';
    } else {
        if (homePage) homePage.style.display = '';
        if (instancesPage) instancesPage.style.display = 'none';
    }
};

/**
 * Update nav tab active states.
 */
ArenaClient.prototype._updateNavTabs = function () {
    var tabs = document.querySelectorAll('.nav-tab');
    for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        if (tab.getAttribute('data-page') === this.currentPage) {
            tab.classList.add('nav-tab--active');
        } else {
            tab.classList.remove('nav-tab--active');
        }
    }
};

/**
 * Bind nav tab click handlers.
 */
ArenaClient.prototype._bindNavTabs = function () {
    var self = this;
    var navContainer = document.getElementById('nav-tabs');
    if (!navContainer) return;

    navContainer.addEventListener('click', function (e) {
        var tab = e.target.closest('.nav-tab');
        if (!tab) return;
        var page = tab.getAttribute('data-page');
        if (page === 'instances') {
            window.location.hash = '#instances';
        } else {
            window.location.hash = '#home';
        }
    });
};

/**
 * Bind keyboard shortcuts: Ctrl+1 = HOME, Ctrl+2 = INSTANCES.
 */
ArenaClient.prototype._bindKeyboardShortcuts = function () {
    document.addEventListener('keydown', function (e) {
        if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
            if (e.key === '1') {
                e.preventDefault();
                window.location.hash = '#home';
            } else if (e.key === '2') {
                e.preventDefault();
                window.location.hash = '#instances';
            }
        }
    });
};

/* --------------------------------------------------------------------------
   Initialization
   -------------------------------------------------------------------------- */

/**
 * Initialize the client: fetch state, render, connect WebSocket.
 */
ArenaClient.prototype.init = async function () {
    this._bindNavTabs();
    this._bindKeyboardShortcuts();
    this._bindFilterToggle();
    this._updateFilterButtons();
    this._initDigiviceSegments();
    this._initHpSegments();
    await this._fetchPricing();
    await this.fetchState();
    this._initRouter();
    var self = this;
    this.connectWebSocket();
    this.fetchBrainData();
    setInterval(function () { self.fetchBrainData(); }, 60000);

    // Fetch new section data
    fetch('/api/sync-status').then(function (r) { return r.json(); }).then(function (d) { self.syncStatus = d; self.renderSyncPanel(); self.renderCompactVitals(); }).catch(function () {});
    fetch('/api/team-status').then(function (r) { return r.json(); }).then(function (d) { self.teamStatus = d; }).catch(function () {});
    fetch('/api/brain/knowledge').then(function (r) { return r.json(); }).then(function (d) { self.knowledgeState = d; self.renderKnowledgePanel(); }).catch(function () {});
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
                self.renderCurrentPage();
            } else if (msg.type === 'event') {
                var event = msg.data || msg;
                self.handleEvent(event);
            } else if (msg.type === 'brain_state') {
                self.brainState = msg.data || {};
                self.brainAvailable = true;
                self.renderBrainSection();
                self._updateInstancesBadge();
                if (self.currentPage === 'instances') self.renderInstancesPage();
            } else if (msg.type === 'brain_health') {
                if (!self.brainState) self.brainState = {};
                self.brainState.health = msg.data;
                self.brainAvailable = true;
                self.renderBrainSection();
            } else if (msg.type === 'brain_instances') {
                if (!self.brainState) self.brainState = {};
                self.brainState.instances = msg.data;
                self._updateInstancesBadge();
                if (self.currentPage === 'instances') self.renderInstancesPage();
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
            } else if (msg.type === 'sync_status') {
                self.syncStatus = msg.data;
                self.renderSyncPanel();
                self.renderCompactVitals();
            } else if (msg.type === 'team_status') {
                self.teamStatus = msg.data;
                if (self.currentPage === 'instances') self.renderInstancesPage();
            } else if (msg.type === 'skill_event') {
                self.handleSkillEvent(msg.data);
            } else if (msg.type === 'brain_knowledge') {
                self.knowledgeState = msg.data;
                self.renderKnowledgePanel();
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

    this.renderBudget();
    this.renderDigivice();
    this.renderCompactVitals();
    this.renderAgentRoster();
    this.renderOverallStats();
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

    if (this.activeTimers[agent]) {
        clearInterval(this.activeTimers[agent].interval);
        delete this.activeTimers[agent];
    }

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
};

/**
 * Update the live duration timer display for an active agent.
 * @param {string} agent
 * @param {number} startTime
 */
ArenaClient.prototype._updateActiveTimer = function (agent, startTime) {
    var elapsed = Math.floor((Date.now() - startTime) / 1000);
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
    } else if (event.event === 'skill_invoke') {
        entry.className = 'battle-log__entry battle-log__entry--skill';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-skill">/' + escapeHtml(event.skill_name || 'unknown') + '</span> invoked';
    } else {
        entry.className = 'battle-log__entry';
        entry.innerHTML =
            '<span class="entry-time">[' + time + ']</span> ' +
            '<span class="entry-agent">' + agentName + '</span> ' +
            escapeHtml(event.event || 'event');
    }

    log.insertBefore(entry, log.firstChild);

    this.battleLogCount++;
    while (this.battleLogCount > MAX_BATTLE_LOG) {
        var last = log.lastElementChild;
        if (last) log.removeChild(last);
        this.battleLogCount--;
    }
};

/* --------------------------------------------------------------------------
   Rendering: Page Dispatcher
   -------------------------------------------------------------------------- */

/**
 * Render only the currently visible page's components.
 */
ArenaClient.prototype.renderCurrentPage = function () {
    if (!this.state) return;

    if (this.currentPage === 'home') {
        this.renderHome();
    } else if (this.currentPage === 'instances') {
        this.renderInstancesPage();
    }

    // These render on both pages
    this._updateInstancesBadge();
};

/**
 * Render all HOME page components.
 */
ArenaClient.prototype.renderHome = function () {
    if (!this.state) return;
    this.renderBudget();
    this.renderDigivice();
    this.renderTokenBreakdown();
    this.renderCostCard();
    this.renderBattleLog();
    this.renderSyncPanel();
    this.renderAgentRoster();
    this.renderSkillHeatmap();
    this.renderKnowledgePanel();
    this.renderOverallStats();
    this.renderBrainSection();
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

    var pctEl = document.getElementById('hp-pct');
    if (pctEl) pctEl.textContent = percentage.toFixed(1) + '%';

    var countEl = document.getElementById('hp-count');
    if (countEl) {
        countEl.textContent = formatNumber(consumed) + ' / ' + formatNumber(ceiling) + ' tokens';
    }

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

    var labelText = document.getElementById('hp-label-text');
    if (labelText) {
        labelText.textContent = ratio >= critThreshold ? 'HP CRITICAL' : 'SESSION HP';
    }

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
   Rendering: Token Breakdown
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderTokenBreakdown = function () {
    var agents = get(this.state, ['agents'], {});
    var totals = get(this.state, ['totals'], {});

    var inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
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

    var totalEl = document.getElementById('total-tokens');
    if (totalEl) totalEl.textContent = formatNumber(directTotal);

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

    this._renderTokenBar('input', inputTokens, directTotal);
    this._renderTokenBar('output', outputTokens, directTotal);
    this._renderTokenBar('cache-read', cacheRead, cacheTotal);
    this._renderTokenBar('cache-create', cacheCreate, cacheTotal);

    var invEl = document.getElementById('total-invocations');
    if (invEl) invEl.textContent = formatNumber(totals.total_invocations || 0);
};

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
   Rendering: Cost Card
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderCostCard = function () {
    var container = document.getElementById('cost-card');
    if (!container) return;

    var agents = get(this.state, ['agents'], {});
    var inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
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

    html += '<div class="cost-card__row"><span class="cost-card__label">Input</span><span class="cost-card__rate mono">' + escapeHtml(formatTokens(inputTokens)) + ' \u00D7 ' + escapeHtml(formatRate(cost.rates.input_cost_per_token)) + '</span><span class="cost-card__amount cost-card__amount--input mono">' + escapeHtml(formatCost(cost.input)) + '</span></div>';
    html += '<div class="cost-card__row"><span class="cost-card__label">Output</span><span class="cost-card__rate mono">' + escapeHtml(formatTokens(outputTokens)) + ' \u00D7 ' + escapeHtml(formatRate(cost.rates.output_cost_per_token)) + '</span><span class="cost-card__amount cost-card__amount--output mono">' + escapeHtml(formatCost(cost.output)) + '</span></div>';
    html += '<div class="cost-card__separator"></div>';
    html += '<div class="cost-card__row"><span class="cost-card__label">Cache Rd</span><span class="cost-card__rate mono">' + escapeHtml(formatTokens(cacheRead)) + ' \u00D7 ' + escapeHtml(formatRate(cost.rates.cache_read_input_token_cost)) + '</span><span class="cost-card__amount cost-card__amount--cache-read mono">' + escapeHtml(formatCost(cost.cache_read)) + '</span></div>';
    html += '<div class="cost-card__row"><span class="cost-card__label">Cache Wr</span><span class="cost-card__rate mono">' + escapeHtml(formatTokens(cacheCreate)) + ' \u00D7 ' + escapeHtml(formatRate(cost.rates.cache_creation_input_token_cost)) + '</span><span class="cost-card__amount cost-card__amount--cache-create mono">' + escapeHtml(formatCost(cost.cache_create)) + '</span></div>';
    html += '<div class="cost-card__total"><span class="cost-card__total-label">Estimated Total</span><span class="cost-card__total-value mono">' + escapeHtml(formatCost(cost.total)) + '</span></div>';

    container.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Rendering: Battle Log (initial load)
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderBattleLog = function () {
    var events = get(this.state, ['recent_events'], []);
    if (events.length === 0) return;

    var log = document.getElementById('battle-log');
    if (!log) return;

    log.innerHTML = '';
    this.battleLogCount = 0;

    for (var i = 0; i < events.length && i < MAX_BATTLE_LOG; i++) {
        var event = events[i];
        var entry = document.createElement('div');
        var agentName = escapeHtml(AGENT_NAMES[event.agent] || (event.agent || 'UNKNOWN').toUpperCase());
        var time = escapeHtml(formatTime(event.ts));

        if (event.event === 'start') {
            entry.className = 'battle-log__entry battle-log__entry--start';
            entry.innerHTML = '<span class="entry-time">[' + time + ']</span> <span class="entry-agent">' + agentName + '</span> deployed to battle';
        } else if (event.event === 'stop') {
            var directTokens = (event.input_tokens || 0) + (event.output_tokens || 0);
            var cachedTokens = (event.cache_read || 0) + (event.cache_create || 0);
            var dur = escapeHtml(event.duration_s ? formatDuration(event.duration_s) : '--');
            var cacheStr = cachedTokens > 0 ? ' <span class="entry-cache">(+ ' + escapeHtml(formatNumber(cachedTokens)) + ' cached)</span>' : '';
            entry.className = 'battle-log__entry battle-log__entry--stop';
            entry.innerHTML = '<span class="entry-time">[' + time + ']</span> <span class="entry-agent">' + agentName + '</span> completed &mdash; <span class="entry-tokens">' + escapeHtml(formatNumber(directTokens)) + ' tokens</span>' + cacheStr + ' (<span class="entry-duration">' + dur + '</span>)';
        } else if (event.event === 'skill_invoke') {
            entry.className = 'battle-log__entry battle-log__entry--skill';
            entry.innerHTML = '<span class="entry-time">[' + time + ']</span> <span class="entry-skill">/' + escapeHtml(event.skill_name || 'unknown') + '</span> invoked';
        } else {
            entry.className = 'battle-log__entry';
            entry.innerHTML = '<span class="entry-time">[' + time + ']</span> <span class="entry-agent">' + agentName + '</span> ' + escapeHtml(event.event || 'event');
        }

        entry.style.animation = 'none';
        log.appendChild(entry);
        this.battleLogCount++;
    }

    if (this.battleLogCount === 0) {
        log.innerHTML = '<div class="battle-log__empty">Awaiting agent activity...</div>';
    }
};

/* --------------------------------------------------------------------------
   Rendering: Agent Roster (compact horizontal strip)
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderAgentRoster = function () {
    var container = document.getElementById('agent-roster');
    if (!container) return;

    var agents = get(this.state, ['agents'], {});
    var html = '';

    for (var i = 0; i < AGENT_ORDER.length; i++) {
        var name = AGENT_ORDER[i];
        var data = agents[name] || {};
        var color = AGENT_COLORS[name] || '#888';
        var monogram = AGENT_MONOGRAMS[name] || name.slice(0, 2).toUpperCase();
        var displayName = AGENT_NAMES[name] || name.toUpperCase();
        var level = data.level || {};
        var levelTier = level.tier || 0;
        var invocations = data.invocations || 0;
        var isActive = !!this.activeTimers[name];
        var label = name === 'orchestrator' ? ' turns' : ' runs';

        var activeCls = isActive ? ' agent-card--active' : '';
        var statusCls = isActive ? 'agent-card__dot--active' : (invocations > 0 ? 'agent-card__dot--has-data' : 'agent-card__dot--idle');

        html += '<div class="agent-card' + activeCls + '" style="--agent-color:' + color + '">';
        html += '<div class="agent-card__dot ' + statusCls + '"></div>';
        html += '<div class="agent-card__mono">' + escapeHtml(monogram) + '</div>';
        html += '<div class="agent-card__name">' + escapeHtml(displayName) + '</div>';
        html += '<div class="agent-card__level mono">Lv.' + levelTier + '</div>';
        html += '<div class="agent-card__runs mono">' + invocations + label + '</div>';
        html += '<div class="agent-card__timer mono" id="roster-timer-' + escapeHtml(name) + '"></div>';
        html += '</div>';
    }

    container.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Rendering: Overall Stats Bar
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderOverallStats = function () {
    var totals = get(this.state, ['totals'], {});
    var agents = get(this.state, ['agents'], {});

    // Total invocations
    var invEl = document.getElementById('overall-invocations');
    if (invEl) invEl.textContent = formatNumber(totals.total_invocations || 0);

    // Total tokens
    var totalTokens = (totals.total_input_tokens || 0) + (totals.total_output_tokens || 0) + (totals.total_cache_tokens || 0);
    var tokEl = document.getElementById('overall-tokens');
    if (tokEl) tokEl.textContent = formatTokens(totalTokens);

    // Total cost
    var inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreate = 0;
    var agentKeys = Object.keys(agents);
    for (var i = 0; i < agentKeys.length; i++) {
        var a = agents[agentKeys[i]];
        inputTokens += a.total_input_tokens || 0;
        outputTokens += a.total_output_tokens || 0;
        cacheRead += a.total_cache_read_tokens || 0;
        cacheCreate += a.total_cache_create_tokens || 0;
    }
    var cost = this.estimateCost(inputTokens, outputTokens, cacheRead, cacheCreate);
    var costEl = document.getElementById('overall-cost');
    if (costEl) costEl.textContent = cost ? formatCost(cost.total) : '$0.00';

    // Uptime
    var uptimeEl = document.getElementById('overall-uptime');
    if (uptimeEl) {
        var uptimeSec = Math.floor((Date.now() - this._startTime) / 1000);
        // Use brain uptime if available
        if (this.brainState && this.brainState.health && this.brainState.health.uptime_seconds) {
            uptimeSec = this.brainState.health.uptime_seconds;
        }
        uptimeEl.textContent = formatUptime(uptimeSec);
    }
};

/* --------------------------------------------------------------------------
   Rendering: Digivice Context Window
   -------------------------------------------------------------------------- */

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

ArenaClient.prototype.renderDigivice = function () {
    var ctx = this.contextWindow;
    if (!ctx) return;

    var used = ctx.context_used || 0;
    var max = ctx.context_max || 200000;
    var ratio = max > 0 ? used / max : 0;
    var percentage = Math.min(ratio * 100, 100);

    var pctEl = document.getElementById('digivice-pct');
    if (pctEl) pctEl.textContent = percentage.toFixed(1) + '%';

    var countEl = document.getElementById('digivice-count');
    if (countEl) countEl.textContent = formatNumber(used) + ' / ' + formatNumber(max) + ' ctx';

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

    var labelText = document.getElementById('digivice-label-text');
    if (labelText) {
        labelText.textContent = percentage >= 90 ? 'DATA OVERFLOW' : 'DATA LOAD';
    }

    var digivice = document.getElementById('digivice');
    if (digivice && !this._compacting) {
        digivice.classList.remove('digi-panel--transition', 'digi-panel--warning', 'digi-panel--overflow');
        if (percentage >= 90) {
            digivice.classList.add('digi-panel--overflow');
        } else if (percentage >= 80) {
            digivice.classList.add('digi-panel--warning');
        } else if (percentage >= 60) {
            digivice.classList.add('digi-panel--transition');
        }
    }

    this._renderDigiviceTags();
};

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

ArenaClient.prototype._checkCompaction = function (event) {
    var newUsed = event.context_used || 0;
    var prevUsed = this._prevContextUsed || 0;
    this._prevContextUsed = newUsed;
    if (prevUsed > 0 && newUsed > 0 && newUsed < prevUsed * 0.7) {
        this._triggerCompactionAnimation();
    }
};

ArenaClient.prototype._triggerCompactionAnimation = function () {
    var self = this;
    var digivice = document.getElementById('digivice');
    var screen = digivice ? digivice.querySelector('.digi-panel__screen') : null;
    if (!digivice) return;
    this._compacting = true;
    digivice.classList.add('digi-panel--compacting');
    var overlay = document.createElement('div');
    overlay.className = 'digi-panel__compaction-text';
    overlay.textContent = '> REFORMATTING DATA...';
    if (screen) screen.appendChild(overlay);
    setTimeout(function () {
        digivice.classList.remove('digi-panel--compacting');
        digivice.classList.add('digi-panel--draining');
        setTimeout(function () {
            digivice.classList.remove('digi-panel--draining');
            digivice.classList.add('digi-panel--flash');
            setTimeout(function () {
                digivice.classList.remove('digi-panel--flash');
                overlay.textContent = '> DATA REFORMATTED';
                self._compacting = false;
                self.renderDigivice();
                setTimeout(function () {
                    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
                }, 3000);
            }, 300);
        }, 600);
    }, 300);
};

/* --------------------------------------------------------------------------
   Rendering: Sync Panel
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderSyncPanel = function () {
    var data = this.syncStatus;
    if (!data) return;

    var statusEl = document.getElementById('sync-status-text');
    if (statusEl) {
        var status = data.status || 'offline';
        statusEl.textContent = status.toUpperCase();
        statusEl.style.color = status === 'online' ? 'var(--success)' : 'var(--text-muted)';
    }

    var pushEl = document.getElementById('sync-last-push');
    if (pushEl) pushEl.textContent = data.last_push ? timeAgo(data.last_push) : '--';

    var pullEl = document.getElementById('sync-last-pull');
    if (pullEl) pullEl.textContent = data.last_pull ? timeAgo(data.last_pull) : '--';

    var queueEl = document.getElementById('sync-queue-depth');
    if (queueEl) {
        var depth = data.queue_depth || 0;
        queueEl.textContent = depth;
        queueEl.style.color = depth === 0 ? 'var(--success)' : (depth > 10 ? 'var(--hp-critical)' : 'var(--hp-warning)');
    }
};

/* --------------------------------------------------------------------------
   Rendering: Compact Vitals Strip (INSTANCES page)
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderCompactVitals = function () {
    // HP
    var hpEl = document.getElementById('compact-hp');
    if (hpEl) {
        var budget = get(this.state, ['budget'], null);
        if (budget) {
            var ratio = (budget.consumed || 0) / (budget.ceiling || 1);
            var pctVal = Math.min(ratio * 100, 100).toFixed(0) + '%';
            hpEl.textContent = pctVal;
            hpEl.className = 'compact-vitals__value' + (ratio >= 0.9 ? ' compact-vitals__value--critical' : (ratio >= 0.75 ? ' compact-vitals__value--warning' : ' compact-vitals__value--ok'));
        } else {
            hpEl.textContent = '--';
        }
    }

    // CTX
    var ctxEl = document.getElementById('compact-ctx');
    if (ctxEl) {
        var ctx = this.contextWindow;
        if (ctx && ctx.context_max > 0) {
            var ctxPct = Math.min((ctx.context_used / ctx.context_max) * 100, 100).toFixed(0) + '%';
            ctxEl.textContent = ctxPct;
            var ctxRatio = ctx.context_used / ctx.context_max;
            ctxEl.className = 'compact-vitals__value' + (ctxRatio >= 0.9 ? ' compact-vitals__value--critical' : (ctxRatio >= 0.8 ? ' compact-vitals__value--warning' : ' compact-vitals__value--ok'));
        } else {
            ctxEl.textContent = '--';
        }
    }

    // Sync
    var syncEl = document.getElementById('compact-sync');
    if (syncEl) {
        var syncData = this.syncStatus;
        if (syncData) {
            var syncStatus = (syncData.status || 'offline').toUpperCase();
            syncEl.textContent = syncStatus;
            syncEl.className = 'compact-vitals__value' + (syncStatus === 'ONLINE' ? ' compact-vitals__value--ok' : ' compact-vitals__value--critical');
        } else {
            syncEl.textContent = '--';
        }
    }
};

/* --------------------------------------------------------------------------
   Rendering: Instances Page
   -------------------------------------------------------------------------- */

ArenaClient.prototype._getInstances = function () {
    if (!this.brainState) return [];
    var data = this.brainState.instances;
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data.instances && Array.isArray(data.instances)) return data.instances;
    return [];
};

ArenaClient.prototype._updateInstancesBadge = function () {
    var badge = document.getElementById('instances-badge');
    if (!badge) return;
    var instances = this._getInstances();
    var liveCount = 0;
    for (var i = 0; i < instances.length; i++) {
        var st = instances[i].status || '';
        if (st === 'active' || st === 'idle') liveCount++;
    }
    badge.textContent = liveCount;
    if (liveCount > 0) {
        badge.classList.add('nav-tab__badge--pulse');
    } else {
        badge.classList.remove('nav-tab__badge--pulse');
    }
};

ArenaClient.prototype.renderInstancesPage = function () {
    this.renderCompactVitals();

    var instances = this._getInstances();
    var listEl = document.getElementById('instances-list');
    var emptyEl = document.getElementById('instances-empty');
    var countEl = document.getElementById('instances-count-summary');
    if (!listEl) return;

    var activeCount = 0, idleCount = 0;
    for (var c = 0; c < instances.length; c++) {
        var st = instances[c].status || '';
        if (st === 'active') activeCount++;
        else if (st === 'idle') idleCount++;
    }

    if (countEl) countEl.textContent = activeCount + ' active / ' + idleCount + ' idle';

    if (instances.length === 0) {
        if (emptyEl) emptyEl.style.display = '';
        // Remove any existing instance cards
        var existingCards = listEl.querySelectorAll('.instance-card');
        for (var r = 0; r < existingCards.length; r++) existingCards[r].remove();
        return;
    }

    if (emptyEl) emptyEl.style.display = 'none';

    var html = '';
    for (var i = 0; i < instances.length; i++) {
        var inst = instances[i];
        html += this._renderInstanceCard(inst, i);
    }

    // Preserve empty element, replace cards
    var fragment = document.createElement('div');
    fragment.innerHTML = html;
    var existingCards2 = listEl.querySelectorAll('.instance-card');
    for (var x = 0; x < existingCards2.length; x++) existingCards2[x].remove();
    while (fragment.firstChild) {
        listEl.appendChild(fragment.firstChild);
    }

    // Bind expand/collapse
    this._bindInstanceExpand();

    // Auto-expand deep-linked instance
    if (this.expandedInstanceId) {
        var target = listEl.querySelector('[data-instance-id="' + this.expandedInstanceId + '"]');
        if (target && !target.classList.contains('instance-card--expanded')) {
            this._expandInstance(target);
        }
    }
};

ArenaClient.prototype._renderInstanceCard = function (inst, idx) {
    var heartbeat = inst.last_heartbeat_at || inst.last_heartbeat || inst.updated_at || '';
    var staleMs = heartbeat ? (Date.now() - new Date(heartbeat).getTime()) : Infinity;
    var isActive = inst.status === 'active' || (!inst.status && staleMs < 60000);
    var statusKey = isActive ? 'active' : 'idle';
    var hostname = inst.machine_hostname || inst.machine_name || '--';
    var project = inst.project || inst.project_slug || '--';
    var brief = inst.brief || inst.current_brief || '--';
    var phase = inst.phase || inst.current_phase || '--';
    var instanceId = inst.instance_id || inst.id || ('inst-' + idx);
    var isTeamLead = inst.is_team_lead || (inst.teammates && inst.teammates.length > 0);
    var elapsedStr = heartbeat ? formatRelativeTime(heartbeat) : '--';

    var html = '<div class="instance-card instance-card--' + escapeHtml(statusKey) + '" data-instance-id="' + escapeHtml(instanceId) + '">';

    // Collapsed header
    html += '<div class="instance-card__header">';
    html += '<span class="instance-card__dot instance-card__dot--' + escapeHtml(statusKey) + '"></span>';
    html += '<span class="instance-card__hostname">' + escapeHtml(hostname) + '</span>';
    html += '<span class="instance-card__sep">/</span>';
    html += '<span class="instance-card__project">' + escapeHtml(project) + '</span>';
    html += '<span class="instance-card__sep">/</span>';
    html += '<span class="instance-card__brief">' + escapeHtml(brief) + '</span>';
    html += '<span class="instance-card__sep">/</span>';
    html += '<span class="instance-card__phase">' + escapeHtml(phase.toUpperCase()) + '</span>';
    if (isTeamLead) {
        html += '<span class="instance-card__team-badge">TEAM LEAD</span>';
    }
    html += '<span class="instance-card__elapsed mono">' + escapeHtml(elapsedStr) + '</span>';
    html += '<button class="instance-card__expand-btn" aria-label="Expand instance">[+]</button>';
    html += '</div>';

    // Expanded content
    html += '<div class="instance-card__body">';

    if (isTeamLead) {
        html += this._renderTeamLeadExpanded(inst);
    } else {
        html += this._renderSoloExpanded(inst);
    }

    html += '</div>';
    html += '</div>';
    return html;
};

ArenaClient.prototype._renderSoloExpanded = function (inst) {
    var brief = inst.brief || inst.current_brief || '--';
    var phase = inst.phase || inst.current_phase || '';
    var phaseKey = PHASE_MAP[phase.toUpperCase()] || null;
    var html = '';

    // Hunt Pipeline
    html += '<div class="instance-pipeline">';
    html += '<div class="instance-pipeline__title">HUNT PIPELINE: ' + escapeHtml(brief) + '</div>';
    html += '<div class="instance-pipeline__phases">';
    for (var i = 0; i < PIPELINE_PHASES.length; i++) {
        var p = PIPELINE_PHASES[i];
        var currentIdx = phaseKey ? PIPELINE_PHASES.indexOf(phaseKey) : -1;
        var cls = 'inst-phase';
        if (currentIdx >= 0) {
            if (i < currentIdx) cls += ' inst-phase--done';
            else if (i === currentIdx) cls += ' inst-phase--active';
        }
        html += '<div class="' + cls + '"><span class="inst-phase__label">' + p.toUpperCase() + '</span></div>';
        if (i < PIPELINE_PHASES.length - 1) html += '<span class="inst-phase__arrow">&rarr;</span>';
    }
    html += '</div></div>';

    // Agent table
    html += '<div class="instance-agents">';
    html += '<div class="instance-agents__title">AGENTS IN THIS INSTANCE</div>';
    html += '<div class="instance-agents__row instance-agents__row--header">';
    var agentList = ['orchestrator', 'architect', 'forger', 'sentinel', 'warden', 'mender', 'seeker'];
    for (var j = 0; j < agentList.length; j++) {
        html += '<span class="instance-agents__cell">' + (AGENT_MONOGRAMS[agentList[j]] || '--') + '</span>';
    }
    html += '</div>';
    html += '<div class="instance-agents__row"><span class="instance-agents__label">Status</span>';
    for (var k = 0; k < agentList.length; k++) html += '<span class="instance-agents__cell mono">--</span>';
    html += '</div>';
    html += '<div class="instance-agents__row"><span class="instance-agents__label">Time</span>';
    for (var l = 0; l < agentList.length; l++) html += '<span class="instance-agents__cell mono">--</span>';
    html += '</div>';
    html += '<div class="instance-agents__row"><span class="instance-agents__label">Tokens</span>';
    for (var m = 0; m < agentList.length; m++) html += '<span class="instance-agents__cell mono">--</span>';
    html += '</div>';
    html += '</div>';

    // Execution log
    html += '<div class="instance-log">';
    html += '<div class="instance-log__title">EXECUTION LOG</div>';
    html += '<div class="instance-log__entries"><div class="brain-panel__empty">No execution data available</div></div>';
    html += '<div class="instance-log__retries mono">Retries: 0/3</div>';
    html += '</div>';

    return html;
};

ArenaClient.prototype._renderTeamLeadExpanded = function (inst) {
    var teammates = inst.teammates || [];
    var teamName = inst.team_name || 'parallel-hunt';
    var briefCount = teammates.length;
    var html = '';

    // Team header
    html += '<div class="team-overview">';
    html += '<div class="team-overview__header">TEAM: "' + escapeHtml(teamName) + '"  ' + briefCount + ' briefs</div>';
    html += '</div>';

    // Teammate cards
    for (var i = 0; i < teammates.length; i++) {
        var tm = teammates[i];
        var tmName = tm.name || ('Teammate ' + (i + 1));
        var tmBrief = tm.brief || '--';
        var tmPhase = tm.phase || '--';
        var tmPhaseKey = PHASE_MAP[(tmPhase).toUpperCase()] || null;
        var tmElapsed = tm.elapsed || '--';

        html += '<div class="teammate-card">';
        html += '<div class="teammate-card__header">';
        html += '<span class="teammate-card__name">' + escapeHtml(tmName) + '</span>';
        html += '<span class="teammate-card__sep">/</span>';
        html += '<span class="teammate-card__brief">' + escapeHtml(tmBrief) + '</span>';
        html += '<span class="teammate-card__sep">/</span>';
        html += '<span class="teammate-card__phase">' + escapeHtml(tmPhase.toUpperCase()) + '</span>';
        html += '<span class="teammate-card__elapsed mono">' + escapeHtml(tmElapsed) + '</span>';
        html += '</div>';

        // Mini pipeline
        html += '<div class="teammate-card__pipeline">';
        for (var j = 0; j < PIPELINE_PHASES.length; j++) {
            var p = PIPELINE_PHASES[j];
            var cidx = tmPhaseKey ? PIPELINE_PHASES.indexOf(tmPhaseKey) : -1;
            var cls = 'inst-phase inst-phase--sm';
            if (cidx >= 0) {
                if (j < cidx) cls += ' inst-phase--done';
                else if (j === cidx) cls += ' inst-phase--active';
            }
            html += '<div class="' + cls + '"><span class="inst-phase__label">' + p.toUpperCase() + '</span></div>';
            if (j < PIPELINE_PHASES.length - 1) html += '<span class="inst-phase__arrow">&rarr;</span>';
        }
        html += '</div>';
        html += '</div>';
    }

    // Coordination log
    html += '<div class="instance-log">';
    html += '<div class="instance-log__title">COORDINATION LOG</div>';
    html += '<div class="instance-log__entries"><div class="brain-panel__empty">No coordination data available</div></div>';
    html += '</div>';

    // Team action buttons (display only)
    html += '<div class="team-actions">';
    html += '<button class="team-action-btn" disabled>Broadcast</button>';
    html += '<button class="team-action-btn" disabled>Team Status</button>';
    html += '<button class="team-action-btn" disabled>Shutdown Team</button>';
    html += '</div>';

    return html;
};

ArenaClient.prototype._bindInstanceExpand = function () {
    var listEl = document.getElementById('instances-list');
    if (!listEl || this._instanceExpandBound) return;
    this._instanceExpandBound = true;
    var self = this;

    listEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.instance-card__expand-btn');
        var header = e.target.closest('.instance-card__header');
        if (!btn && !header) return;
        var card = e.target.closest('.instance-card');
        if (!card) return;

        if (card.classList.contains('instance-card--expanded')) {
            self._collapseInstance(card);
        } else {
            // Collapse any other expanded card (accordion)
            var expanded = listEl.querySelectorAll('.instance-card--expanded');
            for (var i = 0; i < expanded.length; i++) {
                self._collapseInstance(expanded[i]);
            }
            self._expandInstance(card);
        }
    });
};

ArenaClient.prototype._expandInstance = function (card) {
    card.classList.add('instance-card--expanded');
    var btn = card.querySelector('.instance-card__expand-btn');
    if (btn) btn.textContent = '[-]';
};

ArenaClient.prototype._collapseInstance = function (card) {
    card.classList.remove('instance-card--expanded');
    var btn = card.querySelector('.instance-card__expand-btn');
    if (btn) btn.textContent = '[+]';
};

/* --------------------------------------------------------------------------
   Filter Toggle
   -------------------------------------------------------------------------- */

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
            self.renderCurrentPage();
        });
    });
};

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
   Brain Command Center
   -------------------------------------------------------------------------- */

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
    self._updateInstancesBadge();
    if (self.currentPage === 'instances') self.renderInstancesPage();
};

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
    this.renderBrainProjects(bs.projects);
    this.renderBrainBriefs(bs.briefs);
    this.renderBrainSessions(bs.sessions);
};

ArenaClient.prototype.renderBrainHealth = function (data) {
    var badge = document.getElementById('brain-health-badge');
    if (!data) {
        if (badge) {
            badge.querySelector('.brain-health-badge__dot').className = 'brain-health-badge__dot brain-health-badge__dot--offline';
            badge.querySelector('.brain-health-badge__text').textContent = 'OFFLINE';
        }
        return;
    }
    if (badge) {
        badge.querySelector('.brain-health-badge__dot').className = 'brain-health-badge__dot brain-health-badge__dot--online';
        badge.querySelector('.brain-health-badge__text').textContent = 'ONLINE';
    }
    var statusEl = document.getElementById('brain-stat-status');
    if (statusEl) { statusEl.textContent = 'ONLINE'; statusEl.className = 'brain-stat__value brain-stat__value--online'; }
    var versionEl = document.getElementById('brain-stat-version');
    if (versionEl) versionEl.textContent = data.version || data.brain_version || '--';
    var latencyEl = document.getElementById('brain-stat-latency');
    if (latencyEl) { var lat = (this.brainState && this.brainState._latencyMs) ? this.brainState._latencyMs : null; latencyEl.textContent = lat != null ? lat + 'ms' : 'N/A'; }
    var dbsizeEl = document.getElementById('brain-stat-dbsize');
    if (dbsizeEl) dbsizeEl.textContent = data.db_size_bytes ? formatBytes(data.db_size_bytes) : (data.db_size || '--');
    var uptimeEl = document.getElementById('brain-stat-uptime');
    if (uptimeEl) uptimeEl.textContent = data.uptime_seconds ? formatUptime(data.uptime_seconds) : (data.uptime || '--');
    var recordsEl = document.getElementById('brain-stat-records');
    if (recordsEl) {
        var totalRecords = 0;
        if (data.counts) { var ck = Object.keys(data.counts); for (var i = 0; i < ck.length; i++) totalRecords += data.counts[ck[i]] || 0; }
        else if (data.total_records != null) totalRecords = data.total_records;
        recordsEl.textContent = formatNumber(totalRecords);
    }
};

ArenaClient.prototype.renderBrainProjects = function (data) {
    var container = document.getElementById('brain-projects-grid');
    var countEl = document.getElementById('brain-projects-count');
    if (!container) return;
    var projects = [];
    if (data && Array.isArray(data)) projects = data;
    else if (data && data.projects && Array.isArray(data.projects)) projects = data.projects;
    if (countEl) countEl.textContent = projects.length;
    if (projects.length === 0) { container.innerHTML = '<div class="brain-panel__empty">No projects registered</div>'; return; }
    var html = '<div class="brain-projects__cards">';
    for (var i = 0; i < projects.length; i++) {
        var proj = projects[i];
        var isActive = proj.status === 'active';
        var cardClass = isActive ? '' : ' brain-project-card--inactive';
        html += '<div class="brain-project-card' + cardClass + '">';
        html += '<div class="brain-project-card__header"><span class="brain-project-card__name">' + escapeHtml(proj.name || proj.slug || '--') + '</span><span class="brain-project-card__status brain-project-card__status--' + (isActive ? 'active' : 'inactive') + '">' + escapeHtml(isActive ? 'ACTIVE' : 'INACTIVE') + '</span></div>';
        if (proj.slug && proj.slug !== proj.name) html += '<div class="brain-project-card__slug">' + escapeHtml(proj.slug) + '</div>';
        if (proj.tech_stack || proj.technologies) {
            var techs = proj.tech_stack || proj.technologies || [];
            if (typeof techs === 'string') techs = techs.split(',');
            if (techs.length > 0) { html += '<div class="brain-project-card__tags">'; for (var t = 0; t < techs.length && t < 5; t++) html += '<span class="brain-tag">' + escapeHtml(techs[t].trim()) + '</span>'; html += '</div>'; }
        }
        if (proj.last_session || proj.updated_at) html += '<div class="brain-project-card__time">' + escapeHtml(formatRelativeTime(proj.last_session || proj.updated_at)) + '</div>';
        html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
};

ArenaClient.prototype.renderBrainBriefs = function (data) {
    var summaryEl = document.getElementById('brain-briefs-summary');
    var tableEl = document.getElementById('brain-briefs-table');
    var countEl = document.getElementById('brain-briefs-count');
    if (!tableEl) return;
    var briefs = [];
    if (data && Array.isArray(data)) briefs = data;
    else if (data && data.briefs && Array.isArray(data.briefs)) briefs = data.briefs;
    if (countEl) countEl.textContent = briefs.length;
    if (summaryEl) {
        var statusCounts = {};
        for (var s = 0; s < briefs.length; s++) { var st = briefs[s].status || 'Unknown'; statusCounts[st] = (statusCounts[st] || 0) + 1; }
        var pillOrder = ['Ready', 'In Progress', 'Done', 'Draft', 'Blocked'];
        var pillHtml = '';
        for (var p = 0; p < pillOrder.length; p++) { var pName = pillOrder[p]; if (statusCounts[pName]) { var pillClass = pName.toLowerCase().replace(/\s+/g, '-'); pillHtml += '<span class="brain-brief-pill brain-brief-pill--' + pillClass + '">' + escapeHtml(pName) + ': ' + statusCounts[pName] + '</span>'; } }
        var pk = Object.keys(statusCounts); for (var pi = 0; pi < pk.length; pi++) { if (pillOrder.indexOf(pk[pi]) === -1) pillHtml += '<span class="brain-brief-pill">' + escapeHtml(pk[pi]) + ': ' + statusCounts[pk[pi]] + '</span>'; }
        summaryEl.innerHTML = pillHtml;
    }
    if (briefs.length === 0) { tableEl.innerHTML = '<div class="brain-panel__empty">No briefs found</div>'; return; }
    var html = '<table class="brain-table"><thead><tr><th>Project</th><th>Brief</th><th>Type</th><th>Title</th><th>Status</th><th>Priority</th></tr></thead><tbody>';
    for (var b = 0; b < briefs.length; b++) {
        var brief = briefs[b]; var bStatus = brief.status || '--'; var bStatusClass = bStatus.toLowerCase().replace(/\s+/g, '-');
        html += '<tr class="brain-table__row"><td class="brain-table__cell brain-table__cell--project">' + escapeHtml(brief.project || brief.project_slug || '--') + '</td><td class="brain-table__cell brain-table__cell--id">' + escapeHtml(brief.brief_id || brief.id || '--') + '</td><td class="brain-table__cell">' + escapeHtml(brief.type || '--') + '</td><td class="brain-table__cell brain-table__cell--title">' + escapeHtml(brief.title || '--') + '</td><td class="brain-table__cell"><span class="brain-brief-status brain-brief-status--' + escapeHtml(bStatusClass) + '">' + escapeHtml(bStatus) + '</span></td><td class="brain-table__cell brain-table__cell--priority">' + escapeHtml(brief.priority || '--') + '</td></tr>';
    }
    html += '</tbody></table>';
    tableEl.innerHTML = html;
};

ArenaClient.prototype.renderBrainSessions = function (data) {
    var container = document.getElementById('brain-sessions-list');
    var countEl = document.getElementById('brain-sessions-count');
    if (!container) return;
    var sessions = [];
    if (data && Array.isArray(data)) sessions = data;
    else if (data && data.sessions && Array.isArray(data.sessions)) sessions = data.sessions;
    if (countEl) countEl.textContent = sessions.length;
    if (sessions.length === 0) { container.innerHTML = '<div class="brain-panel__empty">No recent sessions</div>'; return; }
    sessions.sort(function (a, b) { var ta = a.started_at || a.created_at || a.timestamp || ''; var tb = b.started_at || b.created_at || b.timestamp || ''; return tb.localeCompare(ta); });
    var groups = {}, groupOrder = [];
    for (var i = 0; i < sessions.length; i++) { var sess = sessions[i]; var ts = sess.started_at || sess.created_at || sess.timestamp || ''; var group = getDateGroup(ts); if (!groups[group]) { groups[group] = []; groupOrder.push(group); } groups[group].push(sess); }
    var html = '';
    for (var g = 0; g < groupOrder.length; g++) {
        var gName = groupOrder[g]; html += '<div class="brain-session-group"><div class="brain-session-group__header">' + escapeHtml(gName) + '</div>';
        var gSessions = groups[gName];
        for (var j = 0; j < gSessions.length; j++) {
            var se = gSessions[j]; var sTs = se.started_at || se.created_at || se.timestamp || '';
            html += '<div class="brain-session-entry"><span class="brain-session-entry__time">' + escapeHtml(formatRelativeTime(sTs)) + '</span><span class="brain-session-entry__project">' + escapeHtml(se.project || se.project_slug || '--') + '</span>';
            if (se.brief || se.brief_id) html += '<span class="brain-session-entry__brief">' + escapeHtml(se.brief || se.brief_id) + '</span>';
            if (se.mode) html += '<span class="brain-session-entry__mode">' + escapeHtml(se.mode) + '</span>';
            if (se.summary || se.goal) html += '<span class="brain-session-entry__summary">' + escapeHtml(se.summary || se.goal) + '</span>';
            html += '</div>';
        }
        html += '</div>';
    }
    container.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Rendering: Knowledge Panel
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderKnowledgePanel = function () {
    var data = this.knowledgeState;
    if (!data) return;
    var learningsEl = document.getElementById('knowledge-learnings-count');
    if (learningsEl) learningsEl.textContent = formatNumber(data.learnings_count || 0);
    var errorsEl = document.getElementById('knowledge-errors-count');
    if (errorsEl) errorsEl.textContent = formatNumber(data.errors_count || 0);
    var patternsEl = document.getElementById('knowledge-patterns-count');
    if (patternsEl) patternsEl.textContent = formatNumber(data.patterns_count || 0);
    var recentEl = document.getElementById('brain-knowledge-recent');
    if (!recentEl) return;
    var recent = data.recent || [];
    if (recent.length === 0) { recentEl.innerHTML = '<div class="brain-panel__empty">No learnings recorded</div>'; return; }
    var html = '';
    for (var i = 0; i < recent.length; i++) {
        var item = recent[i]; var category = item.category || 'general'; var catClass = category.toLowerCase().replace(/[^a-z0-9]/g, '-');
        html += '<div class="brain-knowledge-entry"><span class="brain-knowledge-entry__title">' + escapeHtml(item.title || '--') + '</span><span class="brain-knowledge-entry__badge brain-knowledge-badge--' + escapeHtml(catClass) + '">' + escapeHtml(category) + '</span><span class="brain-knowledge-entry__time">' + escapeHtml(timeAgo(item.created_at)) + '</span></div>';
    }
    recentEl.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Rendering: Skill Heatmap
   -------------------------------------------------------------------------- */

ArenaClient.prototype.renderSkillHeatmap = function () {
    var container = document.getElementById('skill-heatmap-bars');
    var totalEl = document.getElementById('skill-heatmap-total');
    if (!container) return;
    var heatmap = this.skillData || get(this.state, ['skill_heatmap'], null);
    if (!heatmap || !heatmap.skills || Object.keys(heatmap.skills).length === 0) { container.innerHTML = '<div class="brain-panel__empty">No skill data yet</div>'; if (totalEl) totalEl.textContent = '0 total'; return; }
    var skills = heatmap.skills;
    var total = heatmap.total || 0;
    if (totalEl) totalEl.textContent = formatNumber(total) + ' total';
    var skillNames = Object.keys(skills);
    skillNames.sort(function (a, b) { return skills[b] - skills[a]; });
    var maxCount = skills[skillNames[0]] || 1;
    var html = '';
    for (var i = 0; i < skillNames.length; i++) {
        var name = skillNames[i]; var count = skills[name]; var widthPct = Math.max(2, Math.round((count / maxCount) * 100));
        html += '<div class="skill-bar"><span class="skill-bar__label mono">/' + escapeHtml(name) + '</span><div class="skill-bar__track"><div class="skill-bar__fill" style="width:' + widthPct + '%"></div></div><span class="skill-bar__count mono">' + count + '</span></div>';
    }
    container.innerHTML = html;
};

/* --------------------------------------------------------------------------
   Skill Event Handler
   -------------------------------------------------------------------------- */

ArenaClient.prototype.handleSkillEvent = function (data) {
    if (!data || !data.skill_name) return;
    if (!this.state) return;
    if (!this.state.skill_heatmap) this.state.skill_heatmap = { skills: {}, total: 0 };
    var hm = this.state.skill_heatmap;
    hm.skills[data.skill_name] = (hm.skills[data.skill_name] || 0) + 1;
    hm.total = (hm.total || 0) + 1;
    this.addBattleLogEntry({ event: 'skill_invoke', skill_name: data.skill_name, ts: data.ts || new Date().toISOString(), agent: 'skill' });
    this.renderSkillHeatmap();
};

/* --------------------------------------------------------------------------
   Bootstrap
   -------------------------------------------------------------------------- */

document.addEventListener('DOMContentLoaded', function () {
    var arena = new ArenaClient();
    arena.init();
});
