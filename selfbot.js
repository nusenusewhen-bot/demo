const { Client, GatewayIntentBits } = require('discord.js');
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
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent
        ],
        checkUpdate: false
    });
    
    const channelList = channels;
    let currentIndex = 0;
    let intervalId = null;
    let trialCheckInterval = null;
    
    client.on('ready', async () => {
        console.log(`[VEILED ${configId}] Logged in as ${client.user.tag}`);
        
        trialCheckInterval = setInterval(() => {
            if (!dbInstance) return;
            
            const user = dbInstance.getUser(userId);
            const trialActive = dbInstance.isTrialActive(userId);
            const hasPurchase = user.purchased === true;
            
            if (!trialActive && !hasPurchase) {
                console.log(`[VEILED ${configId}] TRIAL EXPIRED - STOPPING BOT`);
                
                if (intervalId) clearInterval(intervalId);
                if (trialCheckInterval) clearInterval(trialCheckInterval);
                
                try { client.destroy(); } catch(e) {}
                
                activeBots.delete(`${userId}_${configId}`);
                
                dbInstance.unregisterActiveBot(userId, configId);
                const config = dbInstance.getConfig(userId, configId);
                if (config) {
                    config.active = false;
                    dbInstance.setConfig(userId, config, configId);
                }
            }
        }, 1000);
        
        intervalId = setInterval(async () => {
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.purchased === true;
                
                if (!trialActive && !hasPurchase) {
                    if (intervalId) clearInterval(intervalId);
                    if (trialCheckInterval) clearInterval(trialCheckInterval);
                    try { client.destroy(); } catch(e) {}
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
                            // Handle image sending
                            await channel.send({ content: message });
                        } else {
                            await channel.send(message);
                        }
                    } catch (e) {
                        console.error(`[VEILED ${configId}] Error sending to ${channelId}:`, e.message);
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
                    console.error(`[VEILED ${configId}] Error:`, e.message);
                }
            }
        }, delay);
    });
    
    if (autoReply && autoReplyText) {
        client.on('messageCreate', async (msg) => {
            if (dbInstance) {
                const user = dbInstance.getUser(userId);
                const trialActive = dbInstance.isTrialActive(userId);
                const hasPurchase = user.purchased === true;
                
                if (!trialActive && !hasPurchase) return;
            }
            
            if (msg.author.id === client.user.id) return;
            
            const isDM = msg.channel.type === 'DM' || msg.channel.type === 1;
            const isConfiguredChannel = channelList.includes(msg.channel.id);
            
            if (!isDM && !isConfiguredChannel) return;
            
            const content = msg.content.toLowerCase();
            const triggers = ['price', 'cost', 'how much', 'buy', 'purchase'];
            
            if (triggers.some(t => content.includes(t))) {
                try {
                    await msg.reply(autoReplyText);
                } catch(e) {
                    console.error(`[VEILED ${configId}] Auto-reply error:`, e.message);
                }
            }
        });
    }
    
    await client.login(token);
    activeBots.set(`${userId}_${configId}`, { client, intervalId, trialCheckInterval, token });
    
    return { client, username: client.user.username };
}

function stopSelfBot(userId, configId) {
    const key = `${userId}_${configId}`;
    const bot = activeBots.get(key);
    if (bot) {
        if (bot.intervalId) clearInterval(bot.intervalId);
        if (bot.trialCheckInterval) clearInterval(bot.trialCheckInterval);
        try { bot.client.destroy(); } catch(e) {}
        activeBots.delete(key);
        console.log(`[VEILED ${configId}] Stopped`);
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
