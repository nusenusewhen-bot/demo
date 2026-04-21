const axios = require('axios');
const WebSocket = require('ws');

// Track active bot instances: { userId_configId: { ws, channels, message, ... } }
const activeBots = new Map();

let wallet;
try {
    wallet = require('./wallet');
} catch (e) {
    console.error('[SELFBOT] Wallet module not available:', e.message);
}

// ============ TOKEN VALIDATION ============

async function validateToken(token) {
    try {
        const res = await axios.get('https://discord.com/api/v9/users/@me', {
            headers: {
                'Authorization': token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Super-Properties': 'eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiQ2hyb21lIn0='
            },
            timeout: 10000
        });
        return {
            valid: true,
            username: res.data.username,
            userId: res.data.id,
            avatar: res.data.avatar
        };
    } catch (err) {
        console.error('[SELFBOT] Token validation failed:', err.response?.status, err.message);
        return { valid: false, error: 'Invalid token' };
    }
}

// ============ DISCORD GATEWAY WEBSOCKET ============

class DiscordSelfBot {
    constructor(userId, token, channels, message, delayMs, autoReply, autoReplyText, configId, imageUrl, sendAllAtOnce, dbInstance) {
        this.userId = userId;
        this.token = token;
        this.channels = channels;
        this.message = message;
        this.delayMs = delayMs;
        this.autoReply = autoReply;
        this.autoReplyText = autoReplyText || 'Hi! I am currently unavailable. I will get back to you soon.';
        this.configId = configId;
        this.imageUrl = imageUrl;
        this.sendAllAtOnce = sendAllAtOnce;
        this.db = dbInstance;
        this.ws = null;
        this.heartbeatInterval = null;
        this.sequence = null;
        this.sessionId = null;
        this.messageTimer = null;
        this.isRunning = false;
        this.repliedUsers = new Set();
        this.messageCount = 0;
        this.botUserId = null;
        this.guildChannels = new Map();
        this.botKey = `${userId}_${configId}`;

        // Reconnection state
        this.explicitStop = false;
        this.reconnectAttempts = 0;
        this.reconnectTimeout = null;
        this.maxReconnectAttempts = 50; // Very high - essentially never gives up
        this.baseReconnectDelay = 2000;
        this.maxReconnectDelay = 30000;

        // Load previously replied users from database
        this.loadRepliedUsers();
    }

    loadRepliedUsers() {
        if (!this.db) return;
        try {
            const previouslyReplied = this.db.getRepliedUsers(this.botKey);
            for (const userId of previouslyReplied) {
                this.repliedUsers.add(userId);
            }
            if (previouslyReplied.length > 0) {
                console.log(`[SELFBOT ${this.configId}] Loaded ${previouslyReplied.length} previously replied users`);
            }
        } catch (e) {
            console.error(`[SELFBOT ${this.configId}] Error loading replied users:`, e.message);
        }
    }

    persistRepliedUser(userId) {
        if (!this.db) return;
        try {
            this.db.markUserReplied(this.botKey, userId);
        } catch (e) {
            console.error(`[SELFBOT ${this.configId}] Error persisting replied user:`, e.message);
        }
    }

    getReconnectDelay() {
        const delay = Math.min(
            this.baseReconnectDelay * Math.pow(1.5, this.reconnectAttempts),
            this.maxReconnectDelay
        );
        return delay + Math.random() * 1000; // Add jitter
    }

    scheduleReconnect() {
        if (this.explicitStop) {
            console.log(`[SELFBOT ${this.configId}] Explicit stop - not reconnecting`);
            return;
        }

        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.log(`[SELFBOT ${this.configId}] Max reconnect attempts reached. Will keep trying anyway...`);
            this.reconnectAttempts = 0; // Reset and keep trying
        }

        const delay = this.getReconnectDelay();
        this.reconnectAttempts++;

        console.log(`[SELFBOT ${this.configId}] Reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts})`);

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
        }

        this.reconnectTimeout = setTimeout(() => {
            if (!this.explicitStop) {
                this.connect().catch(err => {
                    console.error(`[SELFBOT ${this.configId}] Reconnect failed:`, err.message);
                    this.scheduleReconnect();
                });
            }
        }, delay);
    }

    async connect() {
        // Check if access was revoked before connecting
        if (this.db) {
            const userData = this.db.getUser(this.userId);
            if (userData && userData.key_revoked) {
                console.log(`[SELFBOT ${this.configId}] Access revoked for user ${this.userId}, not reconnecting`);
                this.explicitStop = true;
                this.isRunning = false;
                return Promise.reject(new Error('Access revoked'));
            }
        }

        const gatewayUrl = 'wss://gateway.discord.gg/?v=9&encoding=json';

        // Close existing socket if any
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
            this.ws = null;
        }

        this.ws = new WebSocket(gatewayUrl);

        this.ws.on('open', () => {
            console.log(`[SELFBOT ${this.configId}] WebSocket connected`);
        });

        this.ws.on('message', (data) => {
            try {
                const payload = JSON.parse(data);
                this.handlePayload(payload);
            } catch (e) {
                console.error(`[SELFBOT ${this.configId}] Failed to parse message:`, e.message);
            }
        });

        this.ws.on('close', (code, reason) => {
            const reasonStr = reason ? reason.toString() : 'no reason';
            console.log(`[SELFBOT ${this.configId}] WebSocket closed: code=${code}, reason=${reasonStr}`);
            this.isRunning = false;
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            // Only stop permanently for specific reasons
            if (this.explicitStop) {
                console.log(`[SELFBOT ${this.configId}] Stopped by user, no reconnect`);
                return;
            }

            // 4004 = authentication failed (invalid token)
            if (code === 4004) {
                console.error(`[SELFBOT ${this.configId}] Authentication failed (invalid token), stopping permanently`);
                this.explicitStop = true;
                return;
            }

            // 4001 = unknown opcode, 4002 = decode error, 4008 = rate limited, 4009 = session timeout
            // All other codes should trigger reconnect
            this.scheduleReconnect();
        });

        this.ws.on('error', (err) => {
            console.error(`[SELFBOT ${this.configId}] WebSocket error:`, err.message);
            // Don't stop here - let on('close') handle reconnection
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                if (!this.isRunning) {
                    reject(new Error('Connection timeout'));
                }
            }, 30000);

            const checkReady = setInterval(() => {
                if (this.isRunning) {
                    clearTimeout(timeout);
                    clearInterval(checkReady);
                    this.reconnectAttempts = 0; // Reset on successful connection
                    resolve();
                }
            }, 500);
        });
    }

    handlePayload(payload) {
        const { op, d, s, t } = payload;
        this.sequence = s || this.sequence;

        switch (op) {
            case 10: // Hello
                this.startHeartbeat(d.heartbeat_interval);
                this.identify();
                break;
            case 11: // Heartbeat ACK
                break;
            case 0: // Dispatch
                this.handleDispatch(t, d);
                break;
            case 1: // Heartbeat
                this.sendHeartbeat();
                break;
            case 7: // Reconnect
                console.log(`[SELFBOT ${this.configId}] Reconnect requested by Discord`);
                if (this.ws) {
                    try { this.ws.close(); } catch (e) {}
                }
                this.scheduleReconnect();
                break;
            case 9: // Invalid session
                console.log(`[SELFBOT ${this.configId}] Invalid session, d=${d}`);
                // d=false means unresumable, d=true means resumable
                if (d === false) {
                    this.sessionId = null;
                    this.sequence = null;
                    setTimeout(() => this.identify(), 5000);
                } else {
                    // Try to resume
                    this.resume();
                }
                break;
        }
    }

    resume() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const payload = {
            op: 6,
            d: {
                token: this.token,
                session_id: this.sessionId,
                seq: this.sequence
            }
        };
        this.ws.send(JSON.stringify(payload));
    }

    handleDispatch(eventType, data) {
        switch (eventType) {
            case 'READY':
                this.sessionId = data.session_id;
                this.botUserId = data.user.id;
                this.isRunning = true;
                console.log(`[SELFBOT ${this.configId}] Ready as ${data.user.username}`);

                // Populate guild channels
                if (data.guilds) {
                    for (const guild of data.guilds) {
                        if (guild.channels) {
                            for (const ch of guild.channels) {
                                this.guildChannels.set(ch.id, { guildId: guild.id, name: ch.name, type: ch.type });
                            }
                        }
                    }
                }

                // Start messaging
                this.startMessaging();

                // Request guild members for DMs if auto-reply is on
                if (this.autoReply) {
                    console.log(`[SELFBOT ${this.configId}] DM auto-reply active: "${this.autoReplyText}" (${this.repliedUsers.size} users already replied to)`);
                }
                break;

            case 'GUILD_CREATE':
                if (data.channels) {
                    for (const ch of data.channels) {
                        this.guildChannels.set(ch.id, { guildId: data.id, name: ch.name, type: ch.type });
                    }
                }
                break;

            case 'MESSAGE_CREATE':
                // Handle DM auto-reply
                if (this.autoReply && data.author && data.author.id !== this.botUserId) {
                    this.handleDM(data);
                }
                break;
        }
    }

    handleDM(data) {
        // Only reply to DMs (guild_id is null/undefined for DMs)
        if (data.guild_id) return;

        // Don't reply to bot messages or system messages
        if (data.author.bot || data.author.system) return;

        // Don't reply to group DMs (channel type 3)
        if (data.channel_type === 3) return;

        // Only reply once per user - check memory AND persist to DB
        if (this.repliedUsers.has(data.author.id)) {
            return;
        }

        // Send auto-reply
        setTimeout(() => {
            this.sendDM(data.channel_id, this.autoReplyText).then(() => {
                this.repliedUsers.add(data.author.id);
                // Persist so we never reply to this user again, even after restart
                this.persistRepliedUser(data.author.id);
                console.log(`[SELFBOT ${this.configId}] Auto-replied to ${data.author.username}: "${this.autoReplyText.substring(0, 40)}..."`);
            }).catch(err => {
                console.error(`[SELFBOT ${this.configId}] Auto-reply failed:`, err.message);
            });
        }, 1000 + Math.random() * 2000); // Random 1-3s delay to seem human
    }

    async sendDM(channelId, content) {
        await axios.post(`https://discord.com/api/v9/channels/${channelId}/messages`, {
            content: content,
            flags: 0
        }, {
            headers: {
                'Authorization': this.token,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
    }

    identify() {
        const payload = {
            op: 2,
            d: {
                token: this.token,
                properties: {
                    $os: 'Windows',
                    $browser: 'Chrome',
                    $device: ''
                },
                presence: {
                    status: 'online',
                    since: 0,
                    activities: [],
                    afk: false
                },
                compress: false,
                intents: 512 // GUILD_MESSAGES (512) for message events
            }
        };
        this.ws.send(JSON.stringify(payload));
    }

    startHeartbeat(interval) {
        // Clear any existing heartbeat
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
        this.heartbeatInterval = setInterval(() => {
            this.sendHeartbeat();
        }, interval);
    }

    sendHeartbeat() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ op: 1, d: this.sequence }));
        }
    }

    // ============ CHANNEL MESSAGING ============

    startMessaging() {
        // Clear any existing message timer
        if (this.messageTimer) {
            clearTimeout(this.messageTimer);
            this.messageTimer = null;
        }

        console.log(`[SELFBOT ${this.configId}] Starting messaging loop: ${this.channels.length} channels, delay: ${this.delayMs}ms, all-at-once: ${this.sendAllAtOnce}`);

        if (this.sendAllAtOnce) {
            // Send to all channels simultaneously with delay between rounds
            const sendAll = async () => {
                if (!this.isRunning) return;
                await Promise.all(this.channels.map(ch => this.sendToChannel(ch).catch(() => {})));
                this.messageTimer = setTimeout(sendAll, this.delayMs);
            };
            sendAll();
        } else {
            // Send sequentially with delay between each
            let index = 0;
            const sendNext = async () => {
                if (!this.isRunning) return;
                const channelId = this.channels[index % this.channels.length];
                await this.sendToChannel(channelId).catch(() => {});
                index++;
                this.messageTimer = setTimeout(sendNext, this.delayMs);
            };
            sendNext();
        }
    }

    async sendToChannel(channelId) {
        try {
            const payload = { content: this.message, tts: false };

            // Handle image upload
            if (this.imageUrl) {
                await this.sendWithAttachment(channelId);
                return;
            }

            await axios.post(`https://discord.com/api/v9/channels/${channelId}/messages`, payload, {
                headers: {
                    'Authorization': this.token,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 15000
            });

            this.messageCount++;
        } catch (err) {
            if (err.response?.status === 429) {
                const retryAfter = err.response.data.retry_after || 5000;
                console.log(`[SELFBOT ${this.configId}] Rate limited on ${channelId}, waiting ${retryAfter}ms`);
                await new Promise(r => setTimeout(r, retryAfter));
            } else if (err.response?.status === 401) {
                console.error(`[SELFBOT ${this.configId}] Token invalid for ${channelId} - stopping permanently`);
                this.stopPermanently();
            } else {
                console.error(`[SELFBOT ${this.configId}] Send error to ${channelId}:`, err.response?.status, err.message);
            }
        }
    }

    async sendWithAttachment(channelId) {
        try {
            const FormData = require('form-data');
            const form = new FormData();
            form.append('content', this.message);

            let attachmentBuffer;
            let filename = 'image.png';

            if (this.imageUrl.startsWith('data:')) {
                const base64Data = this.imageUrl.split(',')[1];
                attachmentBuffer = Buffer.from(base64Data, 'base64');
                const mimeMatch = this.imageUrl.match(/data:([^;]+)/);
                if (mimeMatch) {
                    const ext = mimeMatch[1].split('/')[1];
                    filename = `image.${ext}`;
                }
            } else if (this.imageUrl.startsWith('http')) {
                const imgRes = await axios.get(this.imageUrl, { responseType: 'arraybuffer', timeout: 15000 });
                attachmentBuffer = Buffer.from(imgRes.data);
            } else {
                // Try reading as local file
                const fs = require('fs');
                const path = require('path');
                const localPath = path.join(__dirname, 'data', 'uploads', path.basename(this.imageUrl));
                if (fs.existsSync(localPath)) {
                    attachmentBuffer = fs.readFileSync(localPath);
                    filename = path.basename(this.imageUrl);
                } else {
                    throw new Error('Image not found');
                }
            }

            form.append('file', attachmentBuffer, filename);

            await axios.post(`https://discord.com/api/v9/channels/${channelId}/messages`, form, {
                headers: {
                    ...form.getHeaders(),
                    'Authorization': this.token,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 30000,
                maxBodyLength: 50 * 1024 * 1024
            });

            this.messageCount++;
        } catch (err) {
            console.error(`[SELFBOT ${this.configId}] Image send error to ${channelId}:`, err.message);
            // Fallback to text-only
            await axios.post(`https://discord.com/api/v9/channels/${channelId}/messages`, {
                content: this.message
            }, {
                headers: { 'Authorization': this.token, 'Content-Type': 'application/json' }
            });
        }
    }

    stopPermanently() {
        console.log(`[SELFBOT ${this.configId}] Stopping permanently`);
        this.explicitStop = true;
        this.isRunning = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.messageTimer) {
            clearTimeout(this.messageTimer);
            this.messageTimer = null;
        }
        if (this.ws) {
            try { this.ws.terminate(); } catch (e) {}
            this.ws = null;
        }
    }

    stop() {
        console.log(`[SELFBOT ${this.configId}] Stopping (user requested)...`);
        this.explicitStop = true;
        this.isRunning = false;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
        if (this.messageTimer) {
            clearTimeout(this.messageTimer);
            this.messageTimer = null;
        }
        if (this.ws) {
            try { this.ws.close(); } catch (e) {}
            this.ws = null;
        }
    }
}

// ============ PUBLIC API ============

async function startSelfBot(userId, token, channels, message, delayMs, autoReply, autoReplyText, configId, imageUrl, clientIp, sendAllAtOnce, db) {
    const botKey = `${userId}_${configId}`;

    // Stop existing
    stopSelfBot(userId, configId);

    console.log(`[SELFBOT] Starting bot ${botKey}: channels=${channels.length}, delay=${delayMs}ms, autoReply=${autoReply}`);

    const bot = new DiscordSelfBot(
        userId, token, channels, message, delayMs,
        autoReply, autoReplyText, configId, imageUrl, sendAllAtOnce, db
    );

    activeBots.set(botKey, bot);

    try {
        await bot.connect();
        return { success: true, username: 'connected' };
    } catch (err) {
        console.error(`[SELFBOT] Failed to start ${botKey}:`, err.message);
        // If it's not an explicit stop, keep the bot in the map so it keeps reconnecting
        if (bot.explicitStop) {
            activeBots.delete(botKey);
        }
        throw err;
    }
}

function stopSelfBot(userId, configId) {
    const botKey = `${userId}_${configId}`;
    const bot = activeBots.get(botKey);
    if (bot) {
        bot.stop();
        activeBots.delete(botKey);
    }
}

function getBotStatus(userId, configId) {
    const botKey = `${userId}_${configId}`;
    const bot = activeBots.get(botKey);
    if (!bot) return null;
    return {
        isRunning: bot.isRunning,
        messageCount: bot.messageCount,
        autoReply: bot.autoReply,
        autoReplyText: bot.autoReplyText,
        repliedUsersCount: bot.repliedUsers.size,
        reconnectAttempts: bot.reconnectAttempts,
        explicitStop: bot.explicitStop
    };
}

function getUserBots(userId) {
    const bots = [];
    for (const [key, bot] of activeBots) {
        if (key.startsWith(`${userId}_`)) {
            bots.push({
                configId: bot.configId,
                isRunning: bot.isRunning,
                messageCount: bot.messageCount,
                reconnectAttempts: bot.reconnectAttempts
            });
        }
    }
    return bots;
}

module.exports = {
    startSelfBot,
    stopSelfBot,
    validateToken,
    getBotStatus,
    getUserBots
};
