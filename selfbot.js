const { Client } = require('discord.js-selfbot-v13');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Track active bot instances: { [userId]: { [configId]: client } }
const activeBots = {};

// Track replied users per config: { [userId]: { [configId]: Set(userId) } }
const repliedUsers = {};

// Track DM reply cooldowns to prevent spam
const replyCooldowns = new Map();

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function getRepliedUsersFile(userId, configId) {
    return path.join(DATA_DIR, `replied_${userId}_${configId}.json`);
}

function loadRepliedUsers(userId, configId) {
    try {
        const file = getRepliedUsersFile(userId, configId);
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            return new Set(data);
        }
    } catch (e) {
        console.error('[Selfbot] Error loading replied users:', e.message);
    }
    return new Set();
}

function saveRepliedUsers(userId, configId, userSet) {
    try {
        const file = getRepliedUsersFile(userId, configId);
        fs.writeFileSync(file, JSON.stringify([...userSet]));
    } catch (e) {
        console.error('[Selfbot] Error saving replied users:', e.message);
    }
}

async function validateToken(token) {
    const client = new Client({ checkUpdate: false });
    try {
        await client.login(token);
        const username = client.user?.username || 'Unknown';
        const tag = client.user?.discriminator
            ? `${username}#${client.user.discriminator}`
            : `@${username}`;
        await client.destroy();
        return { valid: true, username: tag };
    } catch (err) {
        try { await client.destroy(); } catch (e) {}
        return { valid: false, username: null, error: err.message };
    }
}

async function downloadImage(imageUrl) {
    // If it's a data URI, convert to buffer
    if (imageUrl.startsWith('data:')) {
        const base64Data = imageUrl.split(',')[1];
        return Buffer.from(base64Data, 'base64');
    }
    // If it's a local file path
    if (imageUrl.startsWith('/')) {
        const filePath = path.join(__dirname, 'data', 'uploads', path.basename(imageUrl));
        if (fs.existsSync(filePath)) {
            return fs.readFileSync(filePath);
        }
    }
    // If it's a URL, download it
    if (imageUrl.startsWith('http')) {
        try {
            const response = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 10000 });
            return Buffer.from(response.data, 'binary');
        } catch (e) {
            console.error('[Selfbot] Failed to download image:', e.message);
            return null;
        }
    }
    return null;
}

async function startSelfBot(
    userId, token, channelList, message,
    delayMs, autoReply, autoReplyText,
    configId = 'default', imageUrl = null,
    clientIp = null, sendAllAtOnce = false, db = null
) {
    // Stop existing bot for this config first
    stopSelfBot(userId, configId);

    const client = new Client({ checkUpdate: false });

    // Store replied users for this config
    if (!repliedUsers[userId]) repliedUsers[userId] = {};
    repliedUsers[userId][configId] = loadRepliedUsers(userId, configId);

    // Track the running bot
    if (!activeBots[userId]) activeBots[userId] = {};
    activeBots[userId][configId] = client;

    let messageInterval = null;
    let isRunning = true;

    client.on('ready', async () => {
        console.log(`[Selfbot] Logged in as ${client.user.tag} (config: ${configId})`);

        // Update config with active status in DB
        if (db) {
            db.setConfig(userId, {
                active: true,
                username: client.user.tag,
                lastStarted: Date.now()
            }, configId);
        }

        // Start channel messaging loop
        if (channelList && channelList.length > 0 && message) {
            const channels = [];
            for (const chId of channelList) {
                try {
                    const channel = await client.channels.fetch(chId);
                    if (channel && channel.isText()) {
                        channels.push(channel);
                    }
                } catch (e) {
                    console.error(`[Selfbot] Failed to fetch channel ${chId}:`, e.message);
                }
            }

            if (channels.length === 0) {
                console.error('[Selfbot] No valid channels found');
                return;
            }

            let channelIndex = 0;
            const imageBuffer = imageUrl ? await downloadImage(imageUrl) : null;

            async function sendToChannel(channel) {
                try {
                    const options = {};
                    if (imageBuffer) {
                        const attachment = new (require('discord.js-selfbot-v13').MessageAttachment)(
                            imageBuffer, 'image.png'
                        );
                        options.files = [attachment];
                    }
                    await channel.send({ content: message, ...options });
                    console.log(`[Selfbot] Sent message to #${channel.name} (${channel.id})`);
                } catch (err) {
                    console.error(`[Selfbot] Failed to send to ${channel.id}:`, err.message);
                }
            }

            if (sendAllAtOnce) {
                // Send to all channels immediately, then wait delay
                messageInterval = setInterval(async () => {
                    if (!isRunning) return;
                    for (const channel of channels) {
                        await sendToChannel(channel);
                        // Small stagger to avoid rate limits
                        await new Promise(r => setTimeout(r, 500));
                    }
                }, delayMs);
                // Initial send
                for (const channel of channels) {
                    await sendToChannel(channel);
                    await new Promise(r => setTimeout(r, 500));
                }
            } else {
                // Round-robin: one channel per delay period
                messageInterval = setInterval(async () => {
                    if (!isRunning) return;
                    const channel = channels[channelIndex % channels.length];
                    await sendToChannel(channel);
                    channelIndex++;
                }, delayMs);
                // Initial send
                await sendToChannel(channels[0]);
                channelIndex = 1;
            }
        }
    });

    // ==================== AUTO-REPLY TO DMs (TOUCHLESS) ====================
    if (autoReply && autoReplyText) {
        client.on('messageCreate', async (msg) => {
            if (!isRunning) return;
            if (msg.author.id === client.user.id) return; // Ignore own messages

            // Only reply to DMs (not guild messages) unless mentioned
            const isDM = msg.guild === null && msg.channel.type === 'DM';
            const isMention = msg.mentions?.has?.(client.user.id);

            if (!isDM && !isMention) return;

            // Check if we've already replied to this user
            const repliedSet = repliedUsers[userId]?.[configId];
            if (repliedSet && repliedSet.has(msg.author.id)) return;

            // Cooldown check (prevent double-replies within 10 seconds)
            const cooldownKey = `${msg.author.id}_${configId}`;
            const now = Date.now();
            if (replyCooldowns.has(cooldownKey)) {
                const lastReply = replyCooldowns.get(cooldownKey);
                if (now - lastReply < 10000) return; // 10 second cooldown
            }

            try {
                await msg.reply(autoReplyText);
                replyCooldowns.set(cooldownKey, now);

                // Track this user as replied
                if (repliedSet) {
                    repliedSet.add(msg.author.id);
                    saveRepliedUsers(userId, configId, repliedSet);
                }

                console.log(`[Selfbot] Auto-replied to ${msg.author.tag} (DM: ${isDM}, Mention: ${isMention})`);
            } catch (err) {
                console.error('[Selfbot] Auto-reply failed:', err.message);
            }
        });
    }

    client.on('error', (err) => {
        console.error(`[Selfbot] Client error (${configId}):`, err.message);
    });

    // Login
    try {
        await client.login(token);
    } catch (err) {
        console.error('[Selfbot] Login failed:', err.message);
        throw err;
    }

    // Return control object for external stop
    client._veiledStop = () => {
        isRunning = false;
        if (messageInterval) {
            clearInterval(messageInterval);
            messageInterval = null;
        }
        try {
            client.destroy();
        } catch (e) {}
        if (activeBots[userId]) {
            delete activeBots[userId][configId];
        }
        console.log(`[Selfbot] Stopped bot for config ${configId}`);
    };

    return client;
}

function stopSelfBot(userId, configId = 'default') {
    if (activeBots[userId] && activeBots[userId][configId]) {
        const client = activeBots[userId][configId];
        if (client._veiledStop) {
            client._veiledStop();
        } else {
            try {
                client.destroy();
            } catch (e) {}
            delete activeBots[userId][configId];
        }
        return true;
    }
    return false;
}

function stopAllUserBots(userId) {
    if (activeBots[userId]) {
        for (const configId of Object.keys(activeBots[userId])) {
            stopSelfBot(userId, configId);
        }
        delete activeBots[userId];
    }
}

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('[Selfbot] Graceful shutdown...');
    for (const userId of Object.keys(activeBots)) {
        stopAllUserBots(userId);
    }
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[Selfbot] Graceful shutdown...');
    for (const userId of Object.keys(activeBots)) {
        stopAllUserBots(userId);
    }
    process.exit(0);
});

module.exports = {
    validateToken,
    startSelfBot,
    stopSelfBot,
    stopAllUserBots,
    activeBots
};
