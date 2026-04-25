const fs = require('fs');
const path = require('path');

const joinTracker = new Map();
const actionTracker = new Map();
const logs = [];
const backups = new Map();
const securityConfig = new Map();
const countdowns = new Map();

function getConfig(guildId) {
    return securityConfig.get(guildId) || {
        antiRaid: true, antiNuke: true, raidThreshold: 10, nukeThreshold: 5,
        logChannelId: null, alertChannelId: null, verifyOnJoin: false, verifyRoleId: null,
    };
}

function setConfig(guildId, partial) {
    const current = getConfig(guildId);
    securityConfig.set(guildId, { ...current, ...partial });
}

function addLog(type, guildId, description, meta = {}) {
    const entry = { id: Date.now() + Math.random().toString(36).slice(2, 6), type, guildId, description, meta, ts: new Date().toISOString() };
    logs.unshift(entry);
    if (logs.length > 500) logs.length = 500;
    return entry;
}

function getLogs(guildId = null, limit = 100) {
    const filtered = guildId ? logs.filter(l => l.guildId === guildId) : logs;
    return filtered.slice(0, limit);
}

async function handleMemberJoin(member, client) {
    const cfg = getConfig(member.guild.id);
    if (!cfg.antiRaid) return;
    const gid = member.guild.id;
    const now = Date.now();
    const list = (joinTracker.get(gid) || []).filter(t => now - t < 10000);
    list.push(now);
    joinTracker.set(gid, list);
    if (list.length >= cfg.raidThreshold) {
        addLog('ALERT', gid, `Anti-raid triggered — ${list.length} joins in 10s`);
        try {
            await member.guild.setVerificationLevel(4);
            const alertCh = cfg.alertChannelId ? member.guild.channels.cache.get(cfg.alertChannelId) : member.guild.systemChannel;
            if (alertCh) await alertCh.send({ embeds: [{ title: '🚨 Raid Detected', description: `**${list.length}** users joined in the last 10 seconds.\nVerification level raised to VERY HIGH.`, color: 0xff0000, timestamp: new Date().toISOString() }] });
        } catch (e) { addLog('WARN', gid, `Anti-raid action failed: ${e.message}`); }
    }
    addLog('INFO', gid, `Member joined: ${member.user.tag}`);
}

function recordDestructiveAction(guildId, userId, actionType) {
    const cfg = getConfig(guildId);
    if (!cfg.antiNuke) return false;
    const now = Date.now();
    if (!actionTracker.has(guildId)) actionTracker.set(guildId, new Map());
    const byUser = actionTracker.get(guildId);
    const recent = (byUser.get(userId) || []).filter(t => now - t < 10000);
    recent.push(now);
    byUser.set(userId, recent);
    if (recent.length >= cfg.nukeThreshold) {
        addLog('ALERT', guildId, `Anti-nuke: ${actionType} by ${userId} — ${recent.length} actions in 10s`);
        return true;
    }
    addLog('INFO', guildId, `${actionType} by ${userId}`);
    return false;
}

async function handleChannelDelete(channel, client) {
    if (!channel.guild) return;
    const gid = channel.guild.id;
    const audit = await channel.guild.fetchAuditLogs({ type: 12, limit: 1 }).catch(() => null);
    const exec = audit?.entries.first()?.executor;
    if (!exec || exec.id === client.user.id) return;
    const nuke = recordDestructiveAction(gid, exec.id, 'CHANNEL_DELETE');
    if (nuke) {
        try {
            const member = await channel.guild.members.fetch(exec.id);
            await member.roles.set([], 'Anti-nuke: mass channel delete');
            addLog('ACTION', gid, `Stripped roles from ${exec.tag} (anti-nuke)`);
        } catch (e) { addLog('WARN', gid, `Anti-nuke strip failed: ${e.message}`); }
    }
}

async function handleRoleDelete(role) {
    if (!role.guild) return;
    const audit = await role.guild.fetchAuditLogs({ type: 32, limit: 1 }).catch(() => null);
    const exec = audit?.entries.first()?.executor;
    if (!exec) return;
    recordDestructiveAction(role.guild.id, exec.id, 'ROLE_DELETE');
}

async function handleMemberBan(ban) {
    if (!ban.guild) return;
    const audit = await ban.guild.fetchAuditLogs({ type: 22, limit: 1 }).catch(() => null);
    const exec = audit?.entries.first()?.executor;
    if (!exec) return;
    recordDestructiveAction(ban.guild.id, exec.id, 'MEMBER_BAN');
}

async function createBackup(guild) {
    const snapshot = {
        guildId: guild.id, guildName: guild.name, createdAt: new Date().toISOString(),
        roles: guild.roles.cache.filter(r => !r.managed && r.id !== guild.id).map(r => ({
            id: r.id, name: r.name, color: r.color, hoist: r.hoist, position: r.position,
            permissions: r.permissions.bitfield.toString(), mentionable: r.mentionable,
        })).sort((a, b) => b.position - a.position),
        channels: guild.channels.cache.map(ch => ({
            id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId, position: ch.position,
            topic: ch.topic || null, nsfw: ch.nsfw || false, rateLimitPerUser: ch.rateLimitPerUser || 0,
            permissionOverwrites: ch.permissionOverwrites?.cache.map(o => ({
                id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString(),
            })) || [],
        })),
        verificationLevel: guild.verificationLevel,
    };
    backups.set(guild.id, snapshot);
    const dir = path.join(__dirname, 'data');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `backup_${guild.id}.json`), JSON.stringify(snapshot, null, 2));
    addLog('INFO', guild.id, `Backup created — ${snapshot.channels.length} channels, ${snapshot.roles.length} roles`);
    return snapshot;
}

function loadBackup(guildId) {
    if (backups.has(guildId)) return backups.get(guildId);
    const file = path.join(__dirname, 'data', `backup_${guildId}.json`);
    if (fs.existsSync(file)) {
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        backups.set(guildId, snap);
        return snap;
    }
    return null;
}

async function restoreBackup(guild, client) {
    const snap = loadBackup(guild.id);
    if (!snap) return { ok: false, reason: 'No backup found for this server.' };
    addLog('ACTION', guild.id, 'Restore started');
    const results = { roles: 0, channels: 0, errors: [] };
    for (const r of snap.roles) {
        try {
            const existing = guild.roles.cache.get(r.id) || guild.roles.cache.find(x => x.name === r.name);
            if (existing) await existing.edit({ name: r.name, color: r.color, permissions: BigInt(r.permissions) });
            else await guild.roles.create({ name: r.name, color: r.color, permissions: BigInt(r.permissions) });
            results.roles++;
        } catch (e) { results.errors.push(`Role ${r.name}: ${e.message}`); }
    }
    for (const ch of snap.channels.sort((a, b) => a.position - b.position)) {
        try {
            const existing = guild.channels.cache.get(ch.id) || guild.channels.cache.find(x => x.name === ch.name);
            if (!existing) {
                await guild.channels.create({ name: ch.name, type: ch.type, parent: ch.parentId, topic: ch.topic, nsfw: ch.nsfw, rateLimitPerUser: ch.rateLimitPerUser });
                results.channels++;
            }
        } catch (e) { results.errors.push(`Channel #${ch.name}: ${e.message}`); }
    }
    addLog('ACTION', guild.id, `Restore done — ${results.roles} roles, ${results.channels} channels`);
    return { ok: true, results };
}

function createCountdown({ id, label, targetTs, channelId, guildId, client }) {
    if (countdowns.has(id)) return;
    async function tick() {
        const ch = client.channels.cache.get(channelId);
        if (!ch) return;
        const diff = targetTs - Date.now();
        if (diff <= 0) {
            try { await ch.send({ embeds: [{ title: `🎉 ${label}`, description: '**The countdown has ended!**', color: 0x00ff99, timestamp: new Date().toISOString() }] }); } catch (_) {}
            clearInterval(cd.intervalRef);
            countdowns.delete(id);
            return;
        }
        const d = Math.floor(diff / 86400000), h = Math.floor((diff % 86400000) / 3600000),
              m = Math.floor((diff % 3600000) / 60000), s = Math.floor((diff % 60000) / 1000);
        const embed = { title: `⏳ ${label}`, description: `\`\`\`\n${d}d ${h}h ${m}m ${s}s\n\`\`\``, color: 0x5865f2, footer: { text: 'Updates every 60 seconds' }, timestamp: new Date().toISOString() };
        const cd = countdowns.get(id);
        try {
            if (cd?.msgId) {
                const msg = await ch.messages.fetch(cd.msgId).catch(() => null);
                if (msg) { await msg.edit({ embeds: [embed] }); return; }
            }
            const sent = await ch.send({ embeds: [embed] });
            cd.msgId = sent.id;
        } catch (_) {}
    }
    const cd = { label, targetTs, channelId, guildId, msgId: null, intervalRef: null };
    countdowns.set(id, cd);
    tick();
    cd.intervalRef = setInterval(tick, 60000);
}

function deleteCountdown(id) {
    const cd = countdowns.get(id);
    if (cd) { clearInterval(cd.intervalRef); countdowns.delete(id); }
}

function listCountdowns() {
    return [...countdowns.entries()].map(([id, cd]) => ({ id, label: cd.label, targetTs: cd.targetTs, channelId: cd.channelId, guildId: cd.guildId, remaining: Math.max(0, cd.targetTs - Date.now()) }));
}

function loadPersistedData() {
    const dir = path.join(__dirname, 'data');
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).filter(f => f.startsWith('backup_')).forEach(f => {
        try { const snap = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); backups.set(snap.guildId, snap); } catch (_) {}
    });
}

loadPersistedData();

module.exports = { getConfig, setConfig, addLog, getLogs, handleMemberJoin, handleChannelDelete, handleRoleDelete, handleMemberBan, createBackup, loadBackup, restoreBackup, createCountdown, deleteCountdown, listCountdowns, recordDestructiveAction };
