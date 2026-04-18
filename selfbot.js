const { Client } = require('discord.js-selfbot-v13');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const activeBots = new Map();

async function validateToken(token) {
    try {
        const res = await axios.get('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: token },
            timeout: 5000
        });
        return { valid: true, username: res.data.username, id: res.data.id };
    } catch (e) {
        return { valid: false, error: 'Invalid token' };
    }
}

async function joinServer(token, inviteCode) {
    try {
        inviteCode = inviteCode.replace(/https:\/\/discord\.gg\//, '').replace(/https:\/\/discord\.com\/invite\//, '');
        const res = await axios.post(`https://discord.com/api/v10/invites/${inviteCode}`, {}, {
            headers: { Authorization: token },
            timeout: 10000
        });
        return { success: true, guildId: res.data.guild?.id, guildName: res.data.guild?.name };
    } catch (e) {
        return { success: false, error: e.response?.data?.message || e.message };
    }
}

async function startSelfBot(userId, token, channels, message, delay, autoReply, autoReplyText, configId, imageUrl, ipAddress, sendAllAtOnce = true, dbInstance) {
    stopSelfBot(userId, configId);

    const client = new Client({
        checkUpdate: false,
        intents: ['GUILDS', 'GUILD_MESSAGES', 'DIRECT_MESSAGES', 'MESSAGE_CONTENT'],
        partials: ['CHANNEL']
    });

    const channelList = channels;
    let currentIndex = 0;
    let intervalId = null;
    let trialCheckInterval = null;

    client.on('ready', async () => {
        console.log(`[RelayKit ${configId}] Logged in as ${client.user.tag}`);
        console.log(`[RelayKit ${configId}] Mode: ${sendAllAtOnce ? 'ALL AT ONCE' : 'SEQUENTIAL'}`);
        console.log(`[RelayKit ${configId}] Channels: ${channelList.length}, Delay: ${delay}ms`);
        console.log(`[RelayKit ${configId}] Auto-reply: ${autoReply ? 'ENABLED' : 'DISABLED'}`);

        // Trial check interval
        trialCheckInterval = setInterval(() => {
            if (!dbInstance) return;
            const user = dbInstance.getUser(userId);
            const trialActive = dbInstance.isTrialActive(userId);
            const hasPurchase = user.purchased === true;

            if (!trialActive && !hasPurchase) {
                console.log(`[RelayKit ${configId}] Trial expired - stopping bot`);
                if (intervalId) clearInterval(intervalId);
                if (trialCheckInterval) clearInterval(trialCheckInterval);
                try { client.destroy(); } catch (e) { }
                activeBots.delete(`${userId}_${configId}`);
                dbInstance.unregisterActiveBot(userId, configId);
            }
        }, 1000);

        intervalId = setInterval(async () => {
            // Check trial before sending
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.purchased === true;
                if (!trialActive && !hasPurchase) {
                    if (intervalId) clearInterval(intervalId);
                    if (trialCheckInterval) clearInterval(trialCheckInterval);
                    try { client.destroy(); } catch (e) { }
                    activeBots.delete(`${userId}_${configId}`);
                    return;
                }
            }

            if (sendAllAtOnce) {
                const sendPromises = channelList.map(async (channelId) => {
                    try {
                        const channel = await client.channels.fetch(channelId);
                        if (!channel) return;

                        if (imageUrl) {
                            if (imageUrl.startsWith('data:')) {
                                const base64Data = imageUrl.split(',')[1];
                                const buffer = Buffer.from(base64Data, 'base64');
                                const tempDir = path.join(__dirname, 'temp');
                                const tempPath = path.join(tempDir, `img_${Date.now()}_${configId}_${channelId}.png`);
                                if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                                fs.writeFileSync(tempPath, buffer);

                                await channel.send({ content: message, files: [{ attachment: tempPath, name: 'image.png' }] });
                                setTimeout(() => { try { fs.unlinkSync(tempPath); } catch (e) { } }, 10000);
                            } else {
                                await channel.send(message);
                            }
                        } else {
                            await channel.send(message);
                        }
                    } catch (e) {
                        console.error(`[RelayKit ${configId}] Error sending to ${channelId}:`, e.message);
                    }
                });
                await Promise.all(sendPromises);
            } else {
                const channelId = channelList[currentIndex % channelList.length];
                currentIndex++;
                try {
                    const channel = await client.channels.fetch(channelId);
                    if (!channel) return;
                    await channel.send(message);
                } catch (e) {
                    console.error(`[RelayKit ${configId}] Error:`, e.message);
                }
            }
        }, delay);
    });

    // Auto-reply handler
    if (autoReply && autoReplyText) {
        client.on('messageCreate', async (msg) => {
            if (msg.author.id === client.user.id) return;

            const isDM = msg.channel.type === 'DM' || msg.channel.type === 1;
            const isConfiguredChannel = channelList.includes(msg.channel.id);
            if (!isDM && !isConfiguredChannel) return;

            const content = msg.content.toLowerCase();
            const triggers = ['price', 'cost', 'how much', 'howmuch', 'pricing', 'buy', 'purchase', 'sell', 'pay', 'fee', 'rate'];
            const shouldReply = triggers.some(t => content.includes(t));

            if (shouldReply) {
                try {
                    await msg.reply(autoReplyText);
                } catch (replyErr) {
                    await msg.channel.send(`${msg.author} ${autoReplyText}`);
                }
            }
        });
    }

    await client.login(token);
    activeBots.set(`${userId}_${configId}`, { client, intervalId, trialCheckInterval, token: token.substring(0, 10) + '...' });

    return { client, username: client.user.username };
}

function stopSelfBot(userId, configId) {
    const key = `${userId}_${configId}`;
    const bot = activeBots.get(key);
    if (bot) {
        if (bot.intervalId) clearInterval(bot.intervalId);
        if (bot.trialCheckInterval) clearInterval(bot.trialCheckInterval);
        try { bot.client.destroy(); } catch (e) { }
        activeBots.delete(key);
        console.log(`[RelayKit ${configId}] Stopped`);
        return true;
    }
    return false;
}

function getActiveBots(userId) {
    const bots = [];
    for (const [key, value] of activeBots.entries()) {
        if (key.startsWith(`${userId}_`)) {
            bots.push({ configId: key.replace(`${userId}_`, ''), token: value.token });
        }
    }
    return bots;
}

module.exports = { validateToken, joinServer, startSelfBot, stopSelfBot, getActiveBots };
