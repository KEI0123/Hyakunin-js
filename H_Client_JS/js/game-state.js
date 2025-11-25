(function (global) {
    "use strict";

    class GameState {
        constructor() {
            this.serverOffsetMs = 0;
            this.appliedEventIds = new Set();
            this.lastSeenEventId = 0;
            this.pendingLeaveResolver = null;
            this.resetRoomState();
        }

        resetRoomState() {
            this.roomId = '';
            this.myPlayerId = '';
            this.mySpectatorId = '';
            this.myRole = '';
            this.started = false;
            this.pendingSnapshot = null;
            this.currentPlayers = [];
            this.currentSpectators = [];
        }

        updateServerOffset(serverIsoTs) {
            if (!serverIsoTs) return;
            const srv = Date.parse(serverIsoTs);
            if (Number.isNaN(srv)) return;
            const measured = srv - Date.now();
            this.serverOffsetMs = Math.round((this.serverOffsetMs * 0.8) + (measured * 0.2));
        }

        getServerOffset() {
            return this.serverOffsetMs;
        }

        markEventProcessed(eventId) {
            if (eventId === undefined || eventId === null) return true;
            const mid = parseInt(eventId, 10);
            if (Number.isNaN(mid)) return true;
            if (this.appliedEventIds.has(mid)) return false;
            this.appliedEventIds.add(mid);
            if (mid > this.lastSeenEventId) this.lastSeenEventId = mid;
            return true;
        }

        resetEventHistory() {
            this.appliedEventIds.clear();
            this.lastSeenEventId = 0;
        }

        updateLastSeenFromSnapshot(nextEventId) {
            if (nextEventId === undefined || nextEventId === null) return;
            const nid = parseInt(nextEventId, 10);
            if (Number.isNaN(nid)) return;
            this.lastSeenEventId = Math.max(this.lastSeenEventId, nid - 1);
        }

        getLastSeenEventId() {
            return this.lastSeenEventId;
        }

        setRoomId(roomId) {
            this.roomId = roomId || '';
        }

        getRoomId() {
            return this.roomId;
        }

        applyIdentity(you = {}) {
            if (you.player_id) {
                this.myPlayerId = you.player_id;
                this.myRole = 'player';
            }
            if (you.spectator_id) {
                this.mySpectatorId = you.spectator_id;
                if (!you.player_id) this.myRole = 'spectator';
            }
            if (!you.player_id && !you.spectator_id) {
                this.myRole = '';
            }
        }

        setRole(role) {
            this.myRole = role || '';
        }

        getRole() {
            return this.myRole;
        }

        isPlayer() {
            return this.myRole === 'player';
        }

        isSpectator() {
            return this.myRole === 'spectator';
        }

        getPlayerId() {
            return this.myPlayerId;
        }

        getSpectatorId() {
            return this.mySpectatorId;
        }

        setPlayerId(pid) {
            this.myPlayerId = pid || '';
        }

        setSpectatorId(sid) {
            this.mySpectatorId = sid || '';
        }

        setStarted(flag) {
            this.started = !!flag;
        }

        hasStarted() {
            return this.started;
        }

        setPendingSnapshot(snapshot) {
            this.pendingSnapshot = snapshot || null;
        }

        getPendingSnapshot() {
            return this.pendingSnapshot;
        }

        setPlayers(rawPlayers) {
            this.currentPlayers = Array.isArray(rawPlayers) ? rawPlayers.map((p) => [p.player_id, p.name]) : [];
        }

        setSpectators(rawSpectators) {
            this.currentSpectators = Array.isArray(rawSpectators) ? rawSpectators.map((s) => [s.spectator_id, s.name]) : [];
        }

        addPlayer(playerId, name) {
            if (!playerId) return;
            const exists = this.currentPlayers.some((p) => p[0] === playerId);
            if (!exists) this.currentPlayers.push([playerId, name || '(unknown)']);
        }

        addSpectator(spectatorId, name) {
            if (!spectatorId) return;
            const exists = this.currentSpectators.some((s) => s[0] === spectatorId);
            if (!exists) this.currentSpectators.push([spectatorId, name || '(unknown)']);
        }

        removePlayer(playerId) {
            if (!playerId) return;
            this.currentPlayers = this.currentPlayers.filter((p) => p[0] !== playerId);
        }

        removeSpectator(spectatorId) {
            if (!spectatorId) return;
            this.currentSpectators = this.currentSpectators.filter((s) => s[0] !== spectatorId);
        }

        getPlayers() {
            return this.currentPlayers.slice();
        }

        getSpectators() {
            return this.currentSpectators.slice();
        }

        registerLeaveResolver(resolver) {
            this.pendingLeaveResolver = typeof resolver === 'function' ? resolver : null;
        }

        clearLeaveResolver() {
            this.pendingLeaveResolver = null;
        }

        tryResolveLeave(messageType, payload = {}) {
            if (!this.pendingLeaveResolver) return false;
            if (messageType === 'player_left' && payload.player_id && payload.player_id === this.myPlayerId) {
                this.pendingLeaveResolver();
                this.pendingLeaveResolver = null;
                return true;
            }
            if (messageType === 'spectator_left' && payload.spectator_id && payload.spectator_id === this.mySpectatorId) {
                this.pendingLeaveResolver();
                this.pendingLeaveResolver = null;
                return true;
            }
            return false;
        }
    }

    global.GameState = GameState;
})(window);
