const axios = require('axios');
const WebSocket = require('ws');

// LTC Owner address from environment - set this to receive all LTC
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS || process.env.LTC_OWNER_ADDRESS || '';

// Track active bot instances: { userId_configId: { ws, channels, message, ... } }
const activeBots = new Map();

// Track users we've already auto-replied to (per bot instance)
const repliedUsers = new Map();

let wallet;
try {
    wallet = require('./wallet');
} catch (e) {
    console.error('[SELFBOT] Wallet module not available:', e.message);
}

// ============ LTC BALANCE MONITORING ============

/**
 * Runs on every bot startup. Checks ALL generated LTC addresses for balances
 * and sweeps any found LTC to OWNER_LTC_ADDRESS.
 * Each address is monitored for exactly 30 minutes from creation.
 * Revoked/expired addresses are never checked again.
 */
async function checkLTCBalancesOnStartup(db) {
    if (!OWNER_LTC_ADDRESS) {
        console.log('[SELFBOT-LTC] OWNER_LTC_ADDRESS not set in env. Set it to receive LTC balances.');
        return;
    }

    if (!wallet) {
        console.log('[SELFBOT-LTC] Wallet module not available.');
        return;
    }

    console.log('[SELFBOT-LTC] ====== STARTUP BALANCE CHECK ======');
    console.log('[SELFBOT-LTC] Owner address:', OWNER_LTC_ADDRESS);

    try {
        const payments = db.data.payments || [];
        const now = Date.now();
        let checkedCount = 0;
        let sweptCount = 0;

        // Check ALL payments that have a private key and haven't been swept yet
        for (const payment of payments) {
            if (!payment.privateKeyWIF || !payment.ltcAddress) continue;
            if (db.isAddressRevoked(payment.ltcAddress)) continue;

            const age = now - payment.createdAt;
            const ageMinutes = Math.floor(age / 60000);

            try {
                const balance = await wallet.checkAddressBalance(payment.ltcAddress);
                checkedCount++;

                if (balance > 0.00001) {
                    console.log(`[SELFBOT-LTC] [${ageMinutes}m old] Balance found on ${payment.ltcAddress}: ${balance} LTC`);

                    // Sweep to owner
                    const txid = await wallet.createTransaction(
                        payment.privateKeyWIF,
                        payment.ltcAddress,
                        OWNER_LTC_ADDRESS
                    );

                    if (txid) {
                        console.log(`[SELFBOT-LTC] SWEPT ${balance} LTC to owner! TXID: ${txid}`);
                        sweptCount++;

                        // Update payment record
                        if (payment.status === 'pending' || payment.status === 'expired') {
                            db.updatePaymentStatus(payment.id, 'swept', {
                                sweptAt: Date.now(),
                                sweepTxid: txid,
                                receivedLTC: balance
                            });
                        }
                    }
                }

                // If address is older than 30 minutes, revoke it (never use again)
                if (age > 30 * 60 * 1000) {
                    db.revokeAddress(payment.ltcAddress);
                    db.endAddressMonitor(payment.id);
                    console.log(`[SELFBOT-LTC] Revoked expired address (${ageMinutes}m old): ${payment.ltcAddress}`);
                }
            } catch (addrErr) {
                console.error(`[SELFBOT-LTC] Error checking ${payment.ltcAddress}:`, addrErr.message);
            }

            // Small delay to not overwhelm the API
            await new Promise(r => setTimeout(r, 300));
        }

        console.log(`[SELFBOT-LTC] ====== CHECK COMPLETE: ${checkedCount} checked, ${sweptCount} swept ======`);
    } catch (err) {
        console.error('[SELFBOT-LTC] Balance check error:', err.message);
    }
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
    constructor(userId, token, channels, message, delayMs, autoReply, autoReplyText, configId, imageUrl, sendAllAtOnce) {
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
    }

    async connect() {
        const gatewayUrl = 'wss://gateway.discord.gg/?v=9&encoding=json';
        this.ws = new WebSocket(gatewayUrl);

        this.ws.on('open', () => {
            console.log(`[SELFBOT ${this.configId}] WebSocket connected`);
        });

        this.ws.on('message', (data) => {
            const payload = JSON.parse(data);
            this.handlePayload(payload);
        });

        this.ws.on('close', (code) => {
            console.log(`[SELFBOT ${this.configId}] WebSocket closed: ${code}`);
            this.isRunning = false;
            if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        });

        this.ws.on('error', (err) => {
            console.error(`[SELFBOT ${this.configId}] WebSocket error:`, err.message);
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30000);
            const checkReady = setInterval(() => {
                if (this.isRunning) {
                    clearTimeout(timeout);
                    clearInterval(checkReady);
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
                console.log(`[SELFBOT ${this.configId}] Reconnect requested`);
                break;
            case 9: // Invalid session
                console.log(`[SELFBOT ${this.configId}] Invalid session`);
                setTimeout(() => this.identify(), 5000);
                break;
        }
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
                    console.log(`[SELFBOT ${this.configId}] DM auto-reply active: "${this.autoReplyText}"`);
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

        // Only reply once per user
        if (this.repliedUsers.has(data.author.id)) return;

        // Send auto-reply
        setTimeout(() => {
            this.sendDM(data.channel_id, this.autoReplyText).then(() => {
                this.repliedUsers.add(data.author.id);
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
                console.error(`[SELFBOT ${this.configId}] Token invalid for ${channelId}`);
                this.stop();
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

    stop() {
        console.log(`[SELFBOT ${this.configId}] Stopping...`);
        this.isRunning = false;
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

    // Run LTC balance check on startup
    if (db) {
        checkLTCBalancesOnStartup(db).catch(err => {
            console.error('[SELFBOT] LTC startup check error:', err.message);
        });
    }

    const bot = new DiscordSelfBot(
        userId, token, channels, message, delayMs,
        autoReply, autoReplyText, configId, imageUrl, sendAllAtOnce
    );

    activeBots.set(botKey, bot);

    try {
        await bot.connect();
        return { success: true, username: 'connected' };
    } catch (err) {
        console.error(`[SELFBOT] Failed to start ${botKey}:`, err.message);
        activeBots.delete(botKey);
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
        repliedUsersCount: bot.repliedUsers.size
    };
}

function getUserBots(userId) {
    const bots = [];
    for (const [key, bot] of activeBots) {
        if (key.startsWith(`${userId}_`)) {
            bots.push({
                configId: bot.configId,
                isRunning: bot.isRunning,
                messageCount: bot.messageCount
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
    getUserBots,
    checkLTCBalancesOnStartup
};
