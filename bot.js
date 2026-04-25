const { Client, GatewayIntentBits, Events, AttachmentBuilder, EmbedBuilder, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Groq } = require('groq-sdk');
const express = require('express');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.DISCORD_TOKEN;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

if (!process.env.DASHBOARD_SECRET) {
    console.error("Missing DASHBOARD_SECRET environment variable");
    process.exit(1);
}
const DASHBOARD_SECRET = process.env.DASHBOARD_SECRET;
const JWT_SECRET = process.env.JWT_SECRET || DASHBOARD_SECRET + '_jwt';
const PORT = process.env.PORT || 3000;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

const groq = new Groq({ apiKey: GROQ_API_KEY });

const conversationHistory = new Map();
const auditLogs = [];
const securityConfig = new Map();
const activeTimers = new Map();
const userOffenses = new Map();

const MAX_LOGS = 500;
const MAX_BACKUP_MESSAGES = 5000;
const BACKUP_RETENTION = 10;

const BACKUP_DIR = './backups';
const MESSAGES_DIR = './message_store';
const MODERATION_FILE = './moderation_actions.json';

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(MESSAGES_DIR)) fs.mkdirSync(MESSAGES_DIR, { recursive: true });
if (!fs.existsSync('./generated_scripts')) fs.mkdirSync('./generated_scripts', { recursive: true });
if (!fs.existsSync('./public')) fs.mkdirSync('./public', { recursive: true });

let logChannel = null;

function loadModerationActions() {
    if (!fs.existsSync(MODERATION_FILE)) return [];
    try { return JSON.parse(fs.readFileSync(MODERATION_FILE, 'utf8')); } catch(e) { return []; }
}

function saveModerationAction(action) {
    const actions = loadModerationActions();
    actions.unshift({ id: Date.now(), ...action, timestamp: new Date().toISOString() });
    if (actions.length > 1000) actions.pop();
    fs.writeFileSync(MODERATION_FILE, JSON.stringify(actions, null, 2));
}

function getOffenseKey(guildId, userId) { return `${guildId}_${userId}`; }

function getUserOffenseCount(guildId, userId) {
    const key = getOffenseKey(guildId, userId);
    return userOffenses.get(key)?.count || 0;
}

function incrementOffense(guildId, userId) {
    const key = getOffenseKey(guildId, userId);
    const current = userOffenses.get(key) || { count: 0, lastAction: null };
    current.count++;
    current.lastAction = Date.now();
    userOffenses.set(key, current);
    setTimeout(() => {
        const entry = userOffenses.get(key);
        if (entry && Date.now() - entry.lastAction > 30 * 24 * 60 * 60 * 1000) {
            userOffenses.delete(key);
        }
    }, 30 * 24 * 60 * 60 * 1000);
    return current.count;
}

function getPunishmentForOffense(offenseCount) {
    if (offenseCount === 1) return { type: 'timeout', duration: 3600, label: '1 hour' };
    if (offenseCount === 2) return { type: 'timeout', duration: 86400, label: '1 day' };
    if (offenseCount === 3) return { type: 'timeout', duration: 604800, label: '1 week' };
    return { type: 'ban', duration: null, label: 'permanent ban' };
}

function getMessageFilePath(guildId, channelId) {
    const guildDir = path.join(MESSAGES_DIR, guildId);
    if (!fs.existsSync(guildDir)) fs.mkdirSync(guildDir, { recursive: true });
    return path.join(guildDir, `${channelId}.json`);
}

function saveMessageToFile(message) {
    if (!message.guildId) return;
    const filePath = getMessageFilePath(message.guildId, message.channelId);
    let messages = [];
    if (fs.existsSync(filePath)) {
        try { messages = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(e) { messages = []; }
    }
    messages.push({
        id: message.id, author_id: message.author.id, author_name: message.author.tag,
        author_avatar: message.author.displayAvatarURL(), content: message.content,
        attachments: Array.from(message.attachments.values()).map(a => ({ url: a.url, name: a.name })),
        timestamp: message.createdTimestamp, channel_id: message.channelId
    });
    if (messages.length > MAX_BACKUP_MESSAGES) messages.shift();
    fs.writeFileSync(filePath, JSON.stringify(messages, null, 2));
}

async function saveConversationToDiscord(user, assistant, channelId, guildId) {
    if (!logChannel) return;
    try {
        const embed = new EmbedBuilder().setColor(0x10b981).setTitle("Bot Conversation")
            .addFields(
                { name: "User", value: user.length > 1000 ? user.substring(0, 997) + "..." : user, inline: false },
                { name: "Bot Response", value: assistant.length > 1000 ? assistant.substring(0, 997) + "..." : assistant, inline: false },
                { name: "Channel", value: `<#${channelId}>`, inline: true },
                { name: "Server ID", value: guildId || "DM", inline: true }
            ).setTimestamp();
        await logChannel.send({ embeds: [embed] });
    } catch(e) {}
}

async function saveDeletedMessageToDiscord(message, deleter) {
    if (!logChannel) return;
    try {
        const embed = new EmbedBuilder().setColor(0xef4444).setTitle("Message Deleted")
            .setDescription(message.content || "*No content*")
            .addFields(
                { name: "Author", value: message.author?.tag || "Unknown", inline: true },
                { name: "Deleted by", value: deleter?.tag || "Unknown", inline: true },
                { name: "Channel", value: `<#${message.channelId}>`, inline: true }
            ).setFooter({ text: `Message ID: ${message.id}` }).setTimestamp();
        await logChannel.send({ embeds: [embed] });
    } catch(e) {}
}

function getAllMessagesForGuild(guildId) {
    const guildDir = path.join(MESSAGES_DIR, guildId);
    if (!fs.existsSync(guildDir)) return [];
    const files = fs.readdirSync(guildDir);
    let allMessages = [];
    for (const file of files) {
        try {
            const msgs = JSON.parse(fs.readFileSync(path.join(guildDir, file), 'utf8'));
            allMessages.push(...msgs);
        } catch(e) {}
    }
    return allMessages.sort((a,b) => a.timestamp - b.timestamp);
}

function getUserMessagesFromGuild(guildId, userId, limit = 50) {
    const guildDir = path.join(MESSAGES_DIR, guildId);
    if (!fs.existsSync(guildDir)) return [];
    const files = fs.readdirSync(guildDir);
    let userMessages = [];
    for (const file of files) {
        try {
            const msgs = JSON.parse(fs.readFileSync(path.join(guildDir, file), 'utf8'));
            const filtered = msgs.filter(m => m.author_id === userId);
            userMessages.push(...filtered);
        } catch(e) {}
    }
    return userMessages.sort((a,b) => b.timestamp - a.timestamp).slice(0, limit);
}

function searchGuildConversations(guildId, searchTerm, limit = 30) {
    const guildDir = path.join(MESSAGES_DIR, guildId);
    if (!fs.existsSync(guildDir)) return [];
    const files = fs.readdirSync(guildDir);
    let results = [];
    const term = searchTerm.toLowerCase();
    for (const file of files) {
        try {
            const msgs = JSON.parse(fs.readFileSync(path.join(guildDir, file), 'utf8'));
            const matched = msgs.filter(m => m.content && m.content.toLowerCase().includes(term));
            results.push(...matched);
        } catch(e) {}
    }
    return results.sort((a,b) => b.timestamp - a.timestamp).slice(0, limit);
}

function addLog(type, guildId, description, meta = {}) {
    const entry = { id: Date.now(), type, guildId, description, meta, ts: new Date().toISOString() };
    auditLogs.unshift(entry);
    if (auditLogs.length > MAX_LOGS) auditLogs.pop();
    fs.writeFileSync('./audit_logs.json', JSON.stringify(auditLogs, null, 2));
    return entry;
}

if (fs.existsSync('./audit_logs.json')) {
    try {
        const saved = JSON.parse(fs.readFileSync('./audit_logs.json', 'utf8'));
        auditLogs.push(...saved.slice(0, MAX_LOGS));
    } catch(e) {}
}

function cleanupOldBackups(guildId) {
    const backups = listBackups(guildId);
    if (backups.length > BACKUP_RETENTION) {
        const oldBackups = backups.slice(BACKUP_RETENTION);
        for (const backup of oldBackups) deleteBackup(backup.id);
    }
}

async function createFullBackup(guild) {
    const backupId = `backup_${guild.id}_${Date.now()}`;
    const messages = getAllMessagesForGuild(guild.id).slice(0, MAX_BACKUP_MESSAGES);
    const backup = {
        id: backupId, guildId: guild.id, guildName: guild.name, createdAt: new Date().toISOString(), version: 3,
        messages, roles: [], categories: [], channels: [],
        settings: {
            verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter,
            defaultMessageNotifications: guild.defaultMessageNotifications, afkChannelId: guild.afkChannelId,
            afkTimeout: guild.afkTimeout, systemChannelId: guild.systemChannelId, rulesChannelId: guild.rulesChannelId,
            publicUpdatesChannelId: guild.publicUpdatesChannelId, preferredLocale: guild.preferredLocale, features: guild.features || []
        },
        members: [], bans: []
    };
    for (const role of guild.roles.cache) {
        const [id, roleData] = role;
        if (id === guild.id) continue;
        backup.roles.push({
            id, name: roleData.name, color: roleData.color, hoist: roleData.hoist, position: roleData.position,
            permissions: roleData.permissions.bitfield.toString(), mentionable: roleData.mentionable,
            icon: roleData.icon, unicodeEmoji: roleData.unicodeEmoji
        });
    }
    backup.roles.sort((a,b) => b.position - a.position);
    for (const channel of guild.channels.cache) {
        const [id, channelData] = channel;
        const channelBackup = {
            id, name: channelData.name, type: channelData.type, position: channelData.position,
            parentId: channelData.parentId, nsfw: channelData.nsfw, topic: channelData.topic,
            rateLimitPerUser: channelData.rateLimitPerUser, bitrate: channelData.bitrate,
            userLimit: channelData.userLimit, rtcRegion: channelData.rtcRegion, permissionOverwrites: []
        };
        for (const overwrite of channelData.permissionOverwrites.cache) {
            const [_, od] = overwrite;
            channelBackup.permissionOverwrites.push({
                id: od.id, type: od.type, allow: od.allow.bitfield.toString(), deny: od.deny.bitfield.toString()
            });
        }
        if (channelData.type === ChannelType.GuildCategory) backup.categories.push(channelBackup);
        else backup.channels.push(channelBackup);
    }
    for (const member of guild.members.cache) {
        const [id, memberData] = member;
        backup.members.push({
            id, name: memberData.user.tag, joinedAt: memberData.joinedTimestamp,
            roles: [...memberData.roles.cache.keys()].filter(r => r !== guild.id), nickname: memberData.nickname
        });
    }
    try {
        const bans = await guild.bans.fetch();
        for (const ban of bans) {
            const [id, banData] = ban;
            backup.bans.push({ id, name: banData.user.tag, reason: banData.reason });
        }
    } catch(e) {}
    const backupPath = path.join(BACKUP_DIR, `${backupId}.json`);
    fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
    cleanupOldBackups(guild.id);
    addLog('ACTION', guild.id, `Backup created: ${backupId}`);
    return backup;
}

async function restoreFromBackup(guild, backupId) {
    const backupPath = path.join(BACKUP_DIR, `${backupId}.json`);
    if (!fs.existsSync(backupPath)) return { success: false, error: 'Backup not found' };
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    if (backup.guildId !== guild.id) return { success: false, error: 'Backup is for a different server' };
    addLog('ACTION', guild.id, `Starting restore from ${backupId}`);
    const results = { roles: { created: 0, updated: 0, failed: 0 }, channels: { created: 0, updated: 0, failed: 0 }, messages: { restored: 0, failed: 0 }, bans: { restored: 0, failed: 0 } };
    try {
        for (const roleBackup of backup.roles) {
            try {
                const existing = guild.roles.cache.get(roleBackup.id);
                if (existing && !existing.managed) {
                    await existing.edit({ name: roleBackup.name, color: roleBackup.color, hoist: roleBackup.hoist, mentionable: roleBackup.mentionable, permissions: BigInt(roleBackup.permissions) });
                    results.roles.updated++;
                } else if (!existing) {
                    await guild.roles.create({ name: roleBackup.name, color: roleBackup.color, hoist: roleBackup.hoist, mentionable: roleBackup.mentionable, permissions: BigInt(roleBackup.permissions), reason: 'Restore from backup' });
                    results.roles.created++;
                }
            } catch(e) { results.roles.failed++; }
        }
        for (const cat of backup.categories) {
            try {
                const existing = guild.channels.cache.get(cat.id);
                if (existing && existing.type === ChannelType.GuildCategory) {
                    await existing.edit({ name: cat.name, position: cat.position, nsfw: cat.nsfw });
                    results.channels.updated++;
                } else {
                    await guild.channels.create({ name: cat.name, type: ChannelType.GuildCategory, position: cat.position, nsfw: cat.nsfw, reason: 'Restore' });
                    results.channels.created++;
                }
            } catch(e) { results.channels.failed++; }
        }
        for (const ch of backup.channels) {
            try {
                const existing = guild.channels.cache.get(ch.id);
                const parentId = ch.parentId && guild.channels.cache.has(ch.parentId) ? ch.parentId : null;
                if (existing) {
                    await existing.edit({ name: ch.name, position: ch.position, topic: ch.topic, nsfw: ch.nsfw, rateLimitPerUser: ch.rateLimitPerUser, parent: parentId });
                    results.channels.updated++;
                } else {
                    const opts = { name: ch.name, type: ch.type, position: ch.position, topic: ch.topic, nsfw: ch.nsfw, rateLimitPerUser: ch.rateLimitPerUser, reason: 'Restore' };
                    if (parentId) opts.parent = parentId;
                    if (ch.bitrate) opts.bitrate = ch.bitrate;
                    if (ch.userLimit) opts.userLimit = ch.userLimit;
                    await guild.channels.create(opts);
                    results.channels.created++;
                }
            } catch(e) { results.channels.failed++; }
        }
        for (const ban of backup.bans) {
            try { await guild.bans.create(ban.id, { reason: ban.reason || 'Restored from backup' }); results.bans.restored++; } catch(e) { results.bans.failed++; }
        }
        addLog('ACTION', guild.id, `Restore complete`);
        return { success: true, results };
    } catch (error) {
        addLog('ALERT', guild.id, `Restore failed: ${error.message}`);
        return { success: false, error: error.message, results };
    }
}

function listBackups(guildId) {
    const backups = [];
    const files = fs.readdirSync(BACKUP_DIR);
    for (const file of files) {
        if (file.startsWith(`backup_${guildId}_`)) {
            const p = path.join(BACKUP_DIR, file);
            const stats = fs.statSync(p);
            try {
                const data = JSON.parse(fs.readFileSync(p, 'utf8'));
                backups.push({ id: data.id, createdAt: data.createdAt, size: (stats.size/1024/1024).toFixed(2), roles: data.roles.length, categories: data.categories.length, channels: data.channels.length, messages: data.messages?.length || 0, members: data.members?.length || 0, bans: data.bans?.length || 0 });
            } catch(e) {}
        }
    }
    return backups.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function deleteBackup(backupId) {
    const p = path.join(BACKUP_DIR, `${backupId}.json`);
    if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
    return false;
}

function getSecurityConfig(guildId) {
    const configPath = path.join('./security_configs', `${guildId}.json`);
    if (fs.existsSync(configPath)) {
        try {
            const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            securityConfig.set(guildId, saved);
        } catch(e) {}
    }
    if (!securityConfig.has(guildId)) {
        securityConfig.set(guildId, {
            antiRaid: true, antiNuke: true, raidThreshold: 10, nukeThreshold: 5,
            logChannel: null, muteOnRaid: true, dmOnAlert: false,
            autoBackup: true, backupInterval: 60, lastBackup: null,
            logMessages: true, saveDeletedMessages: true
        });
    }
    return securityConfig.get(guildId);
}

function updateSecurityConfig(guildId, newConfig) {
    const current = getSecurityConfig(guildId);
    const updated = { ...current, ...newConfig };
    securityConfig.set(guildId, updated);
    const configDir = './security_configs';
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir);
    fs.writeFileSync(path.join(configDir, `${guildId}.json`), JSON.stringify(updated, null, 2));
    addLog('ACTION', guildId, 'Security settings updated', newConfig);
    return updated;
}

function updateAllTimers() {
    for (const [timerId, timer] of activeTimers.entries()) {
        const remaining = timer.endTime - Date.now();
        if (remaining <= 0) {
            clearInterval(timer.interval);
            activeTimers.delete(timerId);
            const channel = client.channels.cache.get(timer.channelId);
            if (channel) {
                const embed = new EmbedBuilder().setTitle(timer.name).setDescription(timer.message || 'Timer completed!').setColor(0x18be77).setTimestamp();
                channel.send({ embeds: [embed] }).catch(()=>{});
            }
            continue;
        }
        const days = Math.floor(remaining / 86400000);
        const hours = Math.floor((remaining % 86400000) / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        let timeStr = '';
        if (days) timeStr += `${days}d `;
        if (hours || days) timeStr += `${hours}h `;
        if (mins || hours || days) timeStr += `${mins}m `;
        timeStr += `${secs}s`;
        const embed = new EmbedBuilder().setTitle(timer.name).setDescription(`Time Remaining:\n${timeStr}`).setColor(0x7c5cf6).setTimestamp();
        const channel = client.channels.cache.get(timer.channelId);
        if (channel) {
            if (timer.messageId) {
                channel.messages.fetch(timer.messageId).then(msg => msg.edit({ embeds: [embed] }).catch(()=>{})).catch(()=>{
                    channel.send({ embeds: [embed] }).then(sent => timer.messageId = sent.id);
                });
            } else {
                channel.send({ embeds: [embed] }).then(sent => timer.messageId = sent.id);
            }
        }
    }
}

function createTimer(timerId, channelId, durationSeconds, name, message) {
    if (activeTimers.has(timerId)) {
        const old = activeTimers.get(timerId);
        if (old.interval) clearInterval(old.interval);
        activeTimers.delete(timerId);
    }
    const timer = { name, durationSeconds, endTime: Date.now() + durationSeconds * 1000, channelId, messageId: null, message };
    activeTimers.set(timerId, timer);
    return timer;
}

function stopTimer(timerId) {
    const timer = activeTimers.get(timerId);
    if (timer) { activeTimers.delete(timerId); return true; }
    return false;
}

function getAllTimers() {
    return Array.from(activeTimers.entries()).map(([id, t]) => ({ id, name: t.name, remaining: Math.max(0, t.endTime - Date.now()), channelId: t.channelId }));
}

const SYSTEM_PROMPT = `You are XZX Bot, a helpful Discord assistant. Maintain conversation context. ONLY generate script files when explicitly asked with phrases like "make me a script". For general questions answer normally. NEVER provide XZXHub source code.`;

function isExplicitScriptRequest(content) {
    const triggers = ['make me a script','create a script','generate a script','write a script','make me a lua','create a lua','generate code','write code','script for','i need a script','send me a script'];
    return triggers.some(t => content.toLowerCase().includes(t));
}

function isInvestigationRequest(content) {
    const triggers = ['look at','check user','investigate','is this user','seems like a scammer','check if','look into','search for','find messages from'];
    return triggers.some(t => content.toLowerCase().includes(t));
}

function isXZXHubRequest(content) {
    return ['xzxhub source','xzx hub source','xzxhub code','xzx hub code','xzxhub script'].some(k => content.toLowerCase().includes(k));
}

function needsHelp(content) {
    if (content.toLowerCase().includes('?')) return true;
    return ['help','how to','what is','can you','could you','issue','problem','error','fix','troubleshoot'].some(w => content.toLowerCase().includes(w));
}

function getSessionKey(message) { return `${message.guildId || 'dm'}_${message.channelId}_${message.author.id}`; }

function extractFileContent(response) {
    const nameMatch = response.match(/\[FILE_NAME:\s*([^\]]+)\]/i);
    const extMatch = response.match(/\[FILE_EXTENSION:\s*([^\]]+)\]/i);
    const codeMatch = response.match(/\[FILE_CONTENT_START\]([\s\S]*?)\[FILE_CONTENT_END\]/i);
    if (codeMatch) {
        const fileName = nameMatch ? nameMatch[1].trim() : 'generated_script';
        const ext = extMatch ? extMatch[1].trim() : 'txt';
        return { fileName, extension: ext.startsWith('.') ? ext : '.'+ext, code: codeMatch[1].trim(), hasFile: true };
    }
    return { hasFile: false };
}

async function createAndSendFile(code, fileName, extension, message) {
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,50);
    const fullName = `${safeName}_${timestamp}${extension}`;
    const filePath = path.join('./generated_scripts', fullName);
    const header = extension === '.lua' ? '-- Generated by XZX Bot\n\n' : '// Generated by XZX Bot\n\n';
    fs.writeFileSync(filePath, header + code, 'utf8');
    const attachment = new AttachmentBuilder(filePath, { name: fullName });
    await message.reply({ content: `Script Generated: ${fullName}`, files: [attachment] });
    setTimeout(() => { try { if(fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch(e){} }, 300000);
    return fullName;
}

function extractDiscordInviteCode(content) {
    const match = content.match(/(?:discord\.(?:gg|com\/invite|app\/invite)\/)([a-zA-Z0-9_-]+)/i);
    return match ? match[1] : null;
}

async function fetchInviteInfo(code) {
    try {
        const url = `https://discord.com/api/v10/invites/${code}?with_counts=true&with_expiration=true`;
        const res = await fetch(url, { headers: { Authorization: `Bot ${TOKEN}` } });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { return null; }
}

async function analyzeLinkWithAI(url, pageContent) {
    const prompt = `You are a security classifier. Analyze the following link and its page content. Determine if the destination is:
- A scam (phishing, fake giveaway, malware, fake Discord nitro, etc.)
- 18+ / adult content (pornography, NSFW, explicit material)
- Safe (normal website, game, social media, etc.)

URL: ${url}

Page title: ${pageContent.title || 'No title'}
Page description: ${pageContent.description || 'No description'}
First 500 chars of body: ${(pageContent.body || '').substring(0, 500)}

Respond with exactly one word: "SCAM", "ADULT", or "SAFE". Do not add any extra text.`;

    try {
        const completion = await groq.chat.completions.create({
            messages: [{ role: "system", content: "You are a strict content classifier." }, { role: "user", content: prompt }],
            model: "llama-3.3-70b-versatile",
            temperature: 0.1,
            max_tokens: 10,
        });
        const result = completion.choices[0]?.message?.content?.trim().toUpperCase();
        if (result === "SCAM" || result === "ADULT" || result === "SAFE") return result;
        return "SAFE";
    } catch (e) {
        console.error("AI link analysis failed:", e);
        return "SAFE";
    }
}

async function fetchPageMetadata(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timeout);
        if (!res.ok) return { title: null, description: null, body: null };
        const html = await res.text();
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const descMatch = html.match(/<meta name="description" content="([^"]+)"/i);
        const bodyText = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
                             .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
                             .replace(/<[^>]*>/g, ' ')
                             .replace(/\s+/g, ' ')
                             .trim();
        return {
            title: titleMatch ? titleMatch[1] : null,
            description: descMatch ? descMatch[1] : null,
            body: bodyText.substring(0, 1000)
        };
    } catch (e) {
        return { title: null, description: null, body: null };
    }
}

async function applyPunishment(guild, member, offenseCount, reason) {
    const punishment = getPunishmentForOffense(offenseCount);
    let actionPerformed = false;
    let actionDetail = "";
    try {
        if (punishment.type === 'timeout') {
            if (member.moderatable) {
                await member.timeout(punishment.duration * 1000, reason);
                actionPerformed = true;
                actionDetail = `timed out for ${punishment.label}`;
            } else {
                actionDetail = `could not timeout (role hierarchy)`;
            }
        } else if (punishment.type === 'ban') {
            if (member.bannable) {
                await member.ban({ reason });
                actionPerformed = true;
                actionDetail = `banned permanently`;
            } else {
                actionDetail = `could not ban (role hierarchy)`;
            }
        }
    } catch (e) {
        actionDetail = `failed: ${e.message}`;
    }
    return { actionPerformed, actionDetail, punishment };
}

client.once(Events.ClientReady, async c => {
    console.log(`XZX Bot online as ${c.user.tag}`);
    if (LOG_CHANNEL_ID) {
        try { logChannel = await client.channels.fetch(LOG_CHANNEL_ID); } catch(e) { console.error(`Failed to fetch log channel:`, e.message); }
    }
    addLog('INFO', 'global', `Bot started as ${c.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;
    if (!message.content?.trim()) return;

    const config = message.guildId ? getSecurityConfig(message.guildId) : null;
    if (config?.logMessages && message.guildId) saveMessageToFile(message);

    const content = message.content;
    const urls = content.match(/(https?:\/\/[^\s]+)/g) || [];
    let shouldPunish = false;
    let verdict = null;
    let targetUrl = null;

    for (const url of urls) {
        if (url.includes('discord.gg/') || url.includes('discord.com/invite/')) {
            const code = extractDiscordInviteCode(url);
            if (code) {
                const inviteInfo = await fetchInviteInfo(code);
                if (inviteInfo && (inviteInfo.guild?.nsfw_level === 1 || inviteInfo.guild?.nsfw_level === 3)) {
                    shouldPunish = true;
                    verdict = "ADULT (Discord 18+ server)";
                    targetUrl = url;
                    break;
                }
            }
        } else {
            const metadata = await fetchPageMetadata(url);
            const analysis = await analyzeLinkWithAI(url, metadata);
            if (analysis === "SCAM" || analysis === "ADULT") {
                shouldPunish = true;
                verdict = analysis === "SCAM" ? "SCAM" : "ADULT (AI detected)";
                targetUrl = url;
                break;
            }
        }
    }

    if (shouldPunish && message.guild && message.member) {
        const offenseCount = getUserOffenseCount(message.guild.id, message.author.id);
        const newCount = incrementOffense(message.guild.id, message.author.id);
        const { actionPerformed, actionDetail, punishment } = await applyPunishment(message.guild, message.member, newCount, `Posted ${verdict} link: ${targetUrl}`);

        const embed = new EmbedBuilder()
            .setColor(actionPerformed ? 0xef4444 : 0xf59e0b)
            .setTitle('⚠️ Malicious Link Detected')
            .setDescription(`${message.author} posted a link classified as **${verdict}**.`)
            .addFields(
                { name: 'Link', value: targetUrl, inline: false },
                { name: 'Offense Count', value: `${newCount} / 4`, inline: true },
                { name: 'Action Taken', value: actionDetail || (punishment.type === 'timeout' ? `Timed out for ${punishment.label}` : punishment.type === 'ban' ? 'Banned' : 'None'), inline: true }
            )
            .setTimestamp();

        await message.reply({ embeds: [embed] });
        await message.delete().catch(() => {});
        addLog('ACTION', message.guild.id, `${verdict} link from ${message.author.tag} -> ${actionDetail}`);
        saveModerationAction({
            type: punishment.type,
            guildId: message.guild.id,
            userId: message.author.id,
            userName: message.author.tag,
            reason: `Posted ${verdict} link: ${targetUrl}`,
            duration: punishment.duration,
            moderator: 'AutoMod',
            offenseCount: newCount
        });
        if (logChannel) {
            const logEmbed = new EmbedBuilder().setColor(0xef4444).setTitle('Auto-Mod Action')
                .setDescription(`User: ${message.author.tag}\nServer: ${message.guild.name}\nChannel: #${message.channel.name}\nLink: ${targetUrl}\nVerdict: ${verdict}\nAction: ${actionDetail}\nOffense #${newCount}`)
                .setTimestamp();
            await logChannel.send({ embeds: [logEmbed] });
        }
        return;
    }

    const isDM = !message.guild;
    const mentioned = message.mentions.has(client.user);
    const isHelpRequest = needsHelp(message.content);
    if (!isDM && !mentioned && !isHelpRequest) return;

    if (isXZXHubRequest(message.content)) {
        await message.reply("I cannot provide the XZXHub source code, but I can help with other scripting questions.");
        return;
    }

    const msgContent = message.content.trim();
    const sessionKey = getSessionKey(message);
    let history = conversationHistory.get(sessionKey) || [];

    try {
        await message.channel.sendTyping();
        let contextMessages = [];
        for (const entry of history.slice(-15)) {
            contextMessages.push({ role: "user", content: entry.user });
            contextMessages.push({ role: "assistant", content: entry.bot });
        }
        let additionalContext = "";
        if (isInvestigationRequest(msgContent) && message.guildId) {
            const userIdMatch = msgContent.match(/<@!?(\d+)>/) || msgContent.match(/user (\S+)/i);
            if (userIdMatch) {
                let userId = userIdMatch[1];
                if (!userId.match(/^\d+$/)) {
                    const member = message.guild.members.cache.find(m => m.user.username.toLowerCase().includes(userId.toLowerCase()));
                    if (member) userId = member.id;
                }
                if (userId.match(/^\d+$/)) {
                    const userMessages = getUserMessagesFromGuild(message.guildId, userId, 30);
                    if (userMessages.length > 0) {
                        additionalContext = `\n\nRECENT MESSAGES FROM USER ${userId}:\n`;
                        for (const msg of userMessages.slice(0, 20)) {
                            additionalContext += `[${new Date(msg.timestamp).toLocaleString()}] ${msg.author_name}: ${msg.content}\n`;
                        }
                    }
                }
            }
        }
        const messages = [
            { role: "system", content: SYSTEM_PROMPT + additionalContext },
            ...contextMessages,
            { role: "user", content: msgContent }
        ];
        const completion = await groq.chat.completions.create({ messages, model: "llama-3.3-70b-versatile", temperature: 0.7, max_tokens: 2000 });
        const reply = completion.choices[0]?.message?.content;
        if (!reply) return;
        await saveConversationToDiscord(msgContent, reply, message.channelId, message.guildId);
        if (isExplicitScriptRequest(msgContent)) {
            const fileData = extractFileContent(reply);
            if (fileData.hasFile && fileData.code?.length > 50) {
                let clean = fileData.code.replace(/```\w*\n?/g,'').replace(/```\n?/g,'');
                await createAndSendFile(clean, fileData.fileName, fileData.extension, message);
            } else {
                const chunks = reply.length > 1900 ? reply.match(/[\s\S]{1,1900}/g) : [reply];
                for (const chunk of chunks) await message.reply(chunk);
            }
        } else {
            const chunks = reply.length > 1900 ? reply.match(/[\s\S]{1,1900}/g) : [reply];
            for (const chunk of chunks) await message.reply(chunk);
        }
        history.push({ user: msgContent, bot: reply, timestamp: Date.now() });
        if (history.length > 30) history = history.slice(-30);
        conversationHistory.set(sessionKey, history);
    } catch (err) {
        console.error('Error:', err.message);
        await message.reply("Something went wrong. Please try again.");
    }
});

client.on(Events.MessageDelete, async (message) => {
    if (!message.guild || !message.id) return;
    const config = getSecurityConfig(message.guild.id);
    if (config.saveDeletedMessages && logChannel) {
        const auditLog = await message.guild.fetchAuditLogs({ type: 72, limit: 1 }).catch(() => null);
        const deleter = auditLog?.entries.first()?.executor;
        await saveDeletedMessageToDiscord(message, deleter);
    }
});

setInterval(() => {
    const now = Date.now();
    for (const [key, history] of conversationHistory.entries()) {
        const recent = history.filter(e => now - e.timestamp < 7200000);
        if (recent.length === 0) conversationHistory.delete(key);
        else if (recent.length !== history.length) conversationHistory.set(key, recent);
    }
}, 7200000);

setInterval(updateAllTimers, 1000);

setInterval(async () => {
    for (const [id, guild] of client.guilds.cache) {
        const config = getSecurityConfig(id);
        if (config.autoBackup) {
            const last = config.lastBackup;
            const now = Date.now();
            const intervalMs = (config.backupInterval || 60) * 60 * 1000;
            if (!last || now - last > intervalMs) {
                await createFullBackup(guild);
                config.lastBackup = now;
                updateSecurityConfig(id, config);
            }
        }
    }
}, 3600000);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/', rateLimit({ windowMs: 60*1000, max: 60, message: { error: 'Too many requests' } }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/health', (req, res) => res.json({ status: 'ok', bot: client.isReady() }));

app.post('/api/auth', (req, res) => {
    const { secret } = req.body;
    if (secret !== DASHBOARD_SECRET) return res.status(403).json({ error: 'Wrong secret' });
    const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token });
});

function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    try { jwt.verify(token, JWT_SECRET); next(); } catch { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/api/status', requireAuth, (req, res) => {
    res.json({ ready: client.isReady(), tag: client.user?.tag, guilds: client.guilds.cache.size, uptime: process.uptime(), memoryMB: (process.memoryUsage().rss/1024/1024).toFixed(1), timers: getAllTimers().length });
});
app.get('/api/guilds', requireAuth, (req, res) => {
    res.json(client.guilds.cache.map(g => ({ id: g.id, name: g.name, members: g.memberCount, icon: g.iconURL({ size: 64 }) })));
});
app.get('/api/guilds/:guildId/channels', requireAuth, (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    res.json(guild.channels.cache.filter(ch => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement).map(ch => ({ id: ch.id, name: ch.name, type: ch.type })));
});
app.post('/api/send', requireAuth, async (req, res) => {
    const { channelId, content } = req.body;
    const ch = client.channels.cache.get(channelId);
    if (!ch) return res.status(404).json({ error: 'Channel not found' });
    try { await ch.send(content); res.json({ ok: true }); } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/timer', requireAuth, (req, res) => {
    const { channelId, durationSeconds, name, message } = req.body;
    if (!channelId || !durationSeconds || !name) return res.status(400).json({ error: 'Missing fields' });
    const channel = client.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const timerId = `timer_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
    createTimer(timerId, channelId, durationSeconds, name, message || '');
    res.json({ ok: true, timerId });
});
app.get('/api/timers', requireAuth, (req, res) => res.json(getAllTimers()));
app.delete('/api/timer/:timerId', requireAuth, (req, res) => {
    if (stopTimer(req.params.timerId)) res.json({ ok: true });
    else res.status(404).json({ error: 'Timer not found' });
});
app.get('/api/logs', requireAuth, (req, res) => {
    const { guildId, limit=100 } = req.query;
    let filtered = auditLogs;
    if (guildId && guildId !== 'undefined') filtered = auditLogs.filter(l => l.guildId === guildId || l.guildId === 'global');
    res.json(filtered.slice(0, Number(limit)));
});
app.get('/api/security/:guildId', requireAuth, (req, res) => res.json(getSecurityConfig(req.params.guildId)));
app.post('/api/security/:guildId', requireAuth, (req, res) => res.json(updateSecurityConfig(req.params.guildId, req.body)));
app.post('/api/guilds/:guildId/backup', requireAuth, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const backup = await createFullBackup(guild);
    res.json({ ok: true, backupId: backup.id, channels: backup.channels.length+backup.categories.length, roles: backup.roles.length, messages: backup.messages.length, createdAt: backup.createdAt });
});
app.get('/api/guilds/:guildId/backups', requireAuth, (req, res) => res.json(listBackups(req.params.guildId)));
app.post('/api/guilds/:guildId/restore/:backupId', requireAuth, async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    res.json(await restoreFromBackup(guild, req.params.backupId));
});
app.delete('/api/backup/:backupId', requireAuth, (req, res) => {
    if (deleteBackup(req.params.backupId)) res.json({ ok: true });
    else res.status(404).json({ error: 'Backup not found' });
});
app.get('/api/moderation/actions', requireAuth, (req, res) => res.json(loadModerationActions()));
app.get('/api/moderation/stats', requireAuth, (req, res) => {
    const actions = loadModerationActions();
    const stats = { total: actions.length, kicks: 0, timeouts: actions.filter(a => a.type === 'timeout').length, bans: 0, byGuild: {} };
    for (const a of actions) { if (!stats.byGuild[a.guildId]) stats.byGuild[a.guildId] = 0; stats.byGuild[a.guildId]++; }
    res.json(stats);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

app.listen(PORT, () => console.log(`Dashboard on port ${PORT}`));
client.login(TOKEN);
