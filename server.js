const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ==================== DATABASE ====================
class SimpleDB {
    constructor() {
        this.file = path.join(dataDir, 'db.json');
        this.data = {
            users: {},
            configs: {},
            trialClaims: {},
            activeBots: {},
            generatedKeys: {},
            whitelist: [],
            usedKeys: {},
            customKeys: [],
            globalIndex: 0
        };
        this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.file)) {
                this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
                // Ensure all fields exist
                this.data.trialClaims = this.data.trialClaims || {};
                this.data.activeBots = this.data.activeBots || {};
                this.data.generatedKeys = this.data.generatedKeys || {};
                this.data.whitelist = this.data.whitelist || [];
                this.data.usedKeys = this.data.usedKeys || {};
                this.data.customKeys = this.data.customKeys || [];
                this.data.globalIndex = this.data.globalIndex || 0;
            }
        } catch (e) { console.error('[DB] Load error:', e.message); }
    }

    save() {
        try {
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
        } catch (e) { console.error('[DB] Save error:', e.message); }
    }

    getUser(id) {
        return this.data.users[id] || { purchased: false, trial_active: false, trial_expires: 0 };
    }

    setUser(id, updates) {
        this.data.users[id] = { ...this.getUser(id), ...updates };
        this.save();
    }

    getConfigs(userId) {
        return this.data.configs[userId] || [];
    }

    setConfig(userId, config, configId = 'default') {
        if (!this.data.configs[userId]) this.data.configs[userId] = [];
        const existingIndex = this.data.configs[userId].findIndex(c => c.id === configId);
        const configData = { ...config, id: configId, updated_at: Date.now() };
        if (existingIndex >= 0) {
            this.data.configs[userId][existingIndex] = configData;
        } else {
            this.data.configs[userId].push(configData);
        }
        this.save();
    }

    deleteConfig(userId, configId) {
        if (this.data.configs[userId]) {
            this.data.configs[userId] = this.data.configs[userId].filter(c => c.id !== configId);
            this.save();
        }
    }

    hasClaimedTrial(userId) {
        return !!this.data.trialClaims[userId];
    }

    hasIPClaimedTrial(ip) {
        return Object.values(this.data.trialClaims).some(t => t.ip === ip);
    }

    claimTrial(userId, ip) {
        const now = Date.now();
        const expiresAt = now + (10 * 60 * 1000); // 10 minute trial
        this.data.trialClaims[userId] = { userId, ip, claimedAt: now, expiresAt };
        this.setUser(userId, { trial_active: true, trial_expires: expiresAt });
        this.save();
        return { claimedAt: now, expiresAt };
    }

    isTrialActive(userId) {
        const user = this.getUser(userId);
        if (user.trial_active && user.trial_expires > Date.now()) return true;
        if (user.trial_active && user.trial_expires <= Date.now()) {
            this.setUser(userId, { trial_active: false });
            this.deactivateAllUserBots(userId);
            return false;
        }
        return false;
    }

    getTrialTimeLeft(userId) {
        const user = this.getUser(userId);
        if (user.trial_active && user.trial_expires > Date.now()) {
            return Math.ceil((user.trial_expires - Date.now()) / 1000);
        }
        return 0;
    }

    registerActiveBot(userId, configId, token) {
        if (!this.data.activeBots[userId]) this.data.activeBots[userId] = {};
        this.data.activeBots[userId][configId] = { token, startedAt: Date.now(), configId };
        this.save();
    }

    unregisterActiveBot(userId, configId) {
        if (this.data.activeBots[userId]) {
            delete this.data.activeBots[userId][configId];
            this.save();
        }
    }

    deactivateAllUserBots(userId) {
        if (this.data.activeBots[userId]) {
            delete this.data.activeBots[userId];
            this.save();
        }
    }

    getUserActiveBots(userId) {
        return this.data.activeBots[userId] || {};
    }

    generateKey(duration) {
        const key = 'RK-' + Math.random().toString(36).substring(2, 8).toUpperCase() + '-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const now = Date.now();
        let expiresAt = null;
        if (duration !== 'lifetime') {
            const hours = parseInt(duration);
            expiresAt = now + (hours * 60 * 60 * 1000);
        }
        this.data.generatedKeys[key] = { key, duration, createdAt: now, expiresAt, usedBy: [], active: true };
        this.save();
        return this.data.generatedKeys[key];
    }

    revokeKey(key) {
        if (this.data.generatedKeys[key]) {
            this.data.generatedKeys[key].active = false;
            const usedBy = this.data.generatedKeys[key].usedBy || [];
            for (const userId of usedBy) {
                this.deactivateAllUserBots(userId);
                this.setUser(userId, { purchased: false, key_revoked: true });
            }
            this.save();
            return true;
        }
        return false;
    }

    isKeyValid(key) {
        const keyData = this.data.generatedKeys[key];
        if (!keyData || !keyData.active) return false;
        if (keyData.duration === 'lifetime') return true;
        if (keyData.expiresAt && Date.now() > keyData.expiresAt) return false;
        return true;
    }

    useGeneratedKey(key, userId) {
        if (!this.isKeyValid(key)) return false;
        if (!this.data.generatedKeys[key].usedBy.includes(userId)) {
            this.data.generatedKeys[key].usedBy.push(userId);
        }
        this.setUser(userId, { purchased: true, purchased_at: Date.now(), generated_key: key });
        this.save();
        return true;
    }

    getGeneratedKeys() {
        return Object.values(this.data.generatedKeys);
    }

    addToWhitelist(userId) {
        if (!this.data.whitelist.includes(userId)) {
            this.data.whitelist.push(userId);
            this.save();
        }
    }

    removeFromWhitelist(userId) {
        this.data.whitelist = this.data.whitelist.filter(id => id !== userId);
        this.save();
    }

    isWhitelisted(userId) {
        return this.data.whitelist.includes(userId);
    }

    getWhitelist() {
        return this.data.whitelist;
    }

    useKey(key, userId) {
        const normalized = key.toString().toUpperCase().trim();
        this.data.usedKeys[normalized] = { user_id: userId, used_at: Date.now() };
        this.save();
    }

    isKeyUsed(key) {
        return !!this.data.usedKeys[key.toString().toUpperCase().trim()];
    }

    addCustomKey(key) {
        const normalized = key.toString().toUpperCase().trim();
        if (!this.data.customKeys.includes(normalized)) {
            this.data.customKeys.push(normalized);
            this.save();
        }
        return normalized;
    }
}

const db = new SimpleDB();

// ==================== EXPRESS SETUP ====================
const app = express();

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(session({
    secret: process.env.SESSION_SECRET || 'relaykit-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },
    rolling: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ==================== CONFIG ====================
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL;
const OWNER_ID = process.env.OWNER_ID || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'admin-secret-change-me';

if (CLIENT_ID && CLIENT_SECRET) {
    passport.use(new DiscordStrategy({
        clientID: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        scope: ['identify']
    }, (accessToken, refreshToken, profile, done) => {
        process.nextTick(() => done(null, profile));
    }));
}

// ==================== MIDDLEWARE ====================
function ensureAuthAPI(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensurePurchasedAPI(req, res, next) {
    const user = db.getUser(req.user.id);
    const hasPurchase = user.purchased === true;
    const hasActiveTrial = db.isTrialActive(req.user.id);
    if (!hasPurchase && !hasActiveTrial) {
        return res.status(403).json({ success: false, error: 'Purchase or active trial required' });
    }
    next();
}

function ensureOwner(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
    if (req.user.id !== OWNER_ID) return res.status(403).json({ success: false, error: 'Owner only' });
    next();
}

function ensureCanGenerate(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
    if (req.user.id !== OWNER_ID && !db.isWhitelisted(req.user.id)) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    next();
}

// ==================== AUTH ROUTES ====================
app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback',
    passport.authenticate('discord', { failureRedirect: '/' }),
    (req, res) => res.redirect('/dashboard')
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

app.get('/api/user', ensureAuthAPI, (req, res) => {
    const user = db.getUser(req.user.id);
    const trialActive = db.isTrialActive(req.user.id);
    const trialTimeLeft = trialActive ? db.getTrialTimeLeft(req.user.id) : 0;
    res.json({
        id: req.user.id,
        username: req.user.username,
        global_name: req.user.global_name,
        avatar: req.user.avatar,
        purchased: user.purchased === true,
        trialActive: trialActive,
        trialTimeLeft: trialTimeLeft,
        trialExpires: user.trial_expires || 0,
        isOwner: req.user.id === OWNER_ID,
        isWhitelisted: db.isWhitelisted(req.user.id),
        canGenerate: req.user.id === OWNER_ID || db.isWhitelisted(req.user.id)
    });
});

// ==================== TRIAL ROUTES ====================
app.post('/api/trial/claim', ensureAuthAPI, (req, res) => {
    const userId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    if (db.hasClaimedTrial(userId)) {
        return res.json({ success: false, error: 'You already claimed your trial' });
    }
    if (db.hasIPClaimedTrial(ip)) {
        return res.json({ success: false, error: 'Trial already claimed from this IP' });
    }

    const trial = db.claimTrial(userId, ip);
    res.json({ success: true, message: 'Trial activated for 10 minutes', expiresAt: trial.expiresAt, timeLeft: 600 });
});

app.get('/api/trial/status', ensureAuthAPI, (req, res) => {
    const userId = req.user.id;
    res.json({
        success: true,
        hasClaimed: db.hasClaimedTrial(userId),
        isActive: db.isTrialActive(userId),
        timeLeft: db.isTrialActive(userId) ? db.getTrialTimeLeft(userId) : 0
    });
});

// ==================== KEY REDEMPTION ====================
app.post('/api/redeem', ensureAuthAPI, (req, res) => {
    const { key } = req.body;
    const userId = req.user.id;
    if (!key) return res.json({ success: false, error: 'Enter a key' });

    const normalized = key.toString().toUpperCase().trim();

    // Check generated keys
    if (db.isKeyValid(normalized)) {
        const success = db.useGeneratedKey(normalized, userId);
        if (!success) return res.json({ success: false, error: 'Key expired or revoked' });
        return res.json({ success: true, message: 'Access granted via generated key!' });
    }

    // Check custom keys
    if (db.data.customKeys.includes(normalized)) {
        if (db.isKeyUsed(normalized)) return res.json({ success: false, error: 'Key already used' });
        const user = db.getUser(userId);
        if (user.purchased) return res.json({ success: false, error: 'You already have access' });
        db.setUser(userId, { purchased: true, purchased_at: Date.now(), redeem_key_used: normalized });
        db.useKey(normalized, userId);
        return res.json({ success: true, message: 'Access granted!' });
    }

    res.json({ success: false, error: 'Invalid key' });
});

// ==================== BOT CONFIGURATION ====================
app.get('/api/bot/configs', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
    res.json({ success: true, configs: db.getConfigs(req.user.id) });
});

app.post('/api/bot/start', ensureAuthAPI, ensurePurchasedAPI, async (req, res) => {
    try {
        const { token, channels, message, delay, autoReplyEnabled, autoReplyText, configId = 'default', imageUrl, sendAllAtOnce } = req.body;

        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        const channelList = channels.split(',').map(c => c.trim()).filter(c => /^\d+$/.test(c));
        if (channelList.length === 0) {
            return res.json({ success: false, error: 'Invalid channel IDs' });
        }

        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch (e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not available' });
        }

        const validation = await selfbotModule.validateToken(token);
        if (!validation.valid) return res.json({ success: false, error: 'Invalid Discord token' });

        // Save config
        db.setConfig(req.user.id, {
            token: token.substring(0, 10) + '...',
            channels, message, delay: parseInt(delay) || 30,
            auto_reply_enabled: autoReplyEnabled || false,
            auto_reply_text: autoReplyText || '',
            send_all_at_once: sendAllAtOnce !== false,
            image_url: imageUrl || null,
            active: true
        }, configId);

        // Start the bot
        const delaySeconds = parseInt(delay) || 30;
        const result = await selfbotModule.startSelfBot(
            req.user.id, token, channelList, message,
            delaySeconds * 1000,
            autoReplyEnabled || false,
            autoReplyText || '',
            configId,
            imageUrl || null,
            req.ip,
            sendAllAtOnce !== false,
            db
        );

        db.registerActiveBot(req.user.id, configId, token.substring(0, 10) + '...');

        res.json({ success: true, username: result.username, configId });
    } catch (err) {
        console.error('[BOT START ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuthAPI, ensurePurchasedAPI, (req, res) => {
    const { configId = 'default' } = req.body;
    try {
        const selfbotModule = require('./selfbot');
        selfbotModule.stopSelfBot(req.user.id, configId);
        db.unregisterActiveBot(req.user.id, configId);
        res.json({ success: true, message: 'Bot stopped' });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get('/api/bot/status', ensureAuthAPI, (req, res) => {
    const activeBots = db.getUserActiveBots(req.user.id);
    res.json({ success: true, activeBots });
});

// ==================== ADMIN ROUTES ====================
app.post('/api/admin/generate-key', ensureCanGenerate, (req, res) => {
    const { duration } = req.body;
    const keyData = db.generateKey(duration || 'lifetime');
    res.json({ success: true, key: keyData });
});

app.get('/api/admin/keys', ensureCanGenerate, (req, res) => {
    res.json({ success: true, keys: db.getGeneratedKeys() });
});

app.post('/api/admin/revoke-key', ensureOwner, (req, res) => {
    const { key } = req.body;
    const success = db.revokeKey(key);
    res.json({ success });
});

app.post('/api/admin/whitelist', ensureOwner, (req, res) => {
    const { userId } = req.body;
    db.addToWhitelist(userId);
    res.json({ success: true });
});

app.delete('/api/admin/whitelist/:userId', ensureOwner, (req, res) => {
    db.removeFromWhitelist(req.params.userId);
    res.json({ success: true });
});

app.get('/api/admin/whitelist', ensureOwner, (req, res) => {
    res.json({ success: true, whitelist: db.getWhitelist() });
});

app.get('/api/admin/users', ensureOwner, (req, res) => {
    res.json({ success: true, users: db.data.users });
});

// ==================== HEALTH CHECK ====================
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// ==================== SERVE PAGES ====================
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[RelayKit] Server running on port ${PORT}`);
    console.log(`[RelayKit] Discord OAuth: ${CLIENT_ID ? 'Configured' : 'Not configured'}`);
});
