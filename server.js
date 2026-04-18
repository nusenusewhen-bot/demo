const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const MemoryStore = require('memorystore')(session);

const OWNER_ID = process.env.OWNER_ID || '1473055478714990705';
const CO_OWNER_ID = '883976984420556820';
const ADMIN_IDS = [OWNER_ID, CO_OWNER_ID];

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

class VeiledDB {
    constructor() {
        this.file = path.join(dataDir, 'veiled_db.json');
        this.data = { 
            users: {}, 
            pending: {}, 
            configs: {}, 
            usedKeys: {}, 
            globalIndex: 0, 
            trialClaims: {},
            activeBots: {},
            generatedKeys: {},
            whitelist: [],
            accountPurchases: {}
        };
        this.load();
    }
    
    load() {
        try {
            if (fs.existsSync(this.file)) {
                this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            }
        } catch(e) { console.error('[DB] Load error:', e.message); }
    }
    
    save() {
        try {
            fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
        } catch(e) { console.error('[DB] Save error:', e.message); }
    }
    
    getUser(id) {
        return this.data.users[id] || { 
            purchased: false, 
            trial_active: false, 
            trial_expires: 0,
            accounts_limit: 1,
            accounts_purchased: 0
        };
    }
    
    setUser(id, data) {
        this.data.users[id] = { ...this.getUser(id), ...data };
        this.save();
    }
    
    getNextGlobalIndex() {
        this.data.globalIndex = (this.data.globalIndex || 0) + 1;
        this.save();
        return this.data.globalIndex;
    }
    
    hasClaimedTrial(userId) {
        return !!this.data.trialClaims[userId];
    }

    hasIPClaimedTrial(ip) {
        return Object.values(this.data.trialClaims).some(t => t.ip === ip);
    }

    claimTrial(userId, ip) {
        const now = Date.now();
        const expiresAt = now + (10 * 60 * 1000);
        this.data.trialClaims[userId] = {
            userId, ip, claimedAt: now, expiresAt
        };
        this.setUser(userId, { 
            trial_active: true, 
            trial_expires: expiresAt, 
            trial_claimed_at: now 
        });
        this.save();
        return { claimedAt: now, expiresAt };
    }

    isTrialActive(userId) {
        const user = this.getUser(userId);
        if (user.trial_active && user.trial_expires > Date.now()) {
            return true;
        }
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
    
    getConfigs(userId) {
        return this.data.configs[userId] || [];
    }
    
    getConfig(userId, configId = 'default') {
        const configs = this.getConfigs(userId);
        return configs.find(c => c.id === configId) || configs[0] || null;
    }
    
    setConfig(userId, config, configId = 'default') {
        if (!this.data.configs[userId]) {
            this.data.configs[userId] = [];
        }
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
    
    registerActiveBot(userId, configId, token) {
        if (!this.data.activeBots[userId]) {
            this.data.activeBots[userId] = {};
        }
        this.data.activeBots[userId][configId] = {
            token: token,
            startedAt: Date.now(),
            configId: configId
        };
        this.save();
    }

    unregisterActiveBot(userId, configId) {
        if (this.data.activeBots[userId]) {
            delete this.data.activeBots[userId][configId];
            this.save();
        }
    }

    getUserActiveBots(userId) {
        return this.data.activeBots[userId] || {};
    }

    deactivateAllUserBots(userId) {
        const bots = this.getUserActiveBots(userId);
        for (const configId in bots) {
            this.setConfig(userId, { active: false }, configId);
        }
        if (this.data.activeBots[userId]) {
            delete this.data.activeBots[userId];
            this.save();
        }
    }
    
    generateKey(duration) {
        const key = 'VEILED-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        const now = Date.now();
        let expiresAt = null;
        
        if (duration !== 'lifetime') {
            const hours = parseInt(duration);
            expiresAt = now + (hours * 60 * 60 * 1000);
        }
        
        this.data.generatedKeys[key] = {
            key, duration, createdAt: now, expiresAt,
            usedBy: [], active: true
        };
        this.save();
        return this.data.generatedKeys[key];
    }

    revokeKey(key) {
        if (this.data.generatedKeys[key]) {
            this.data.generatedKeys[key].active = false;
            this.data.generatedKeys[key].revokedAt = Date.now();
            this.save();
            
            const usedBy = this.data.generatedKeys[key].usedBy || [];
            for (const userId of usedBy) {
                this.deactivateAllUserBots(userId);
                this.setUser(userId, { purchased: false, key_revoked: true });
            }
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
        this.setUser(userId, { 
            purchased: true, 
            purchased_at: Date.now(), 
            generated_key: key,
            key_expires: this.data.generatedKeys[key].expiresAt 
        });
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
    
    purchaseAccounts(userId, amount) {
        const user = this.getUser(userId);
        const newLimit = (user.accounts_limit || 1) + amount;
        const newPurchased = (user.accounts_purchased || 0) + amount;
        this.setUser(userId, { 
            accounts_limit: newLimit, 
            accounts_purchased: newPurchased 
        });
        return newLimit;
    }
}

const db = new VeiledDB();

const app = express();

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
    store: new MemoryStore({ checkPeriod: 86400000 }),
    secret: process.env.SESSION_SECRET || 'veiled-secret-2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 30 * 24 * 60 * 60 * 1000 },
    rolling: true
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/auth/discord/callback';

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

function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensurePurchased(req, res, next) {
    const user = db.getUser(req.user.id);
    const hasPurchase = user.purchased === true;
    const hasActiveTrial = db.isTrialActive(req.user.id);
    
    if (!hasPurchase && !hasActiveTrial) {
        return res.status(403).json({ success: false, error: 'Purchase or active trial required' });
    }
    next();
}

function ensureAdmin(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
    if (!ADMIN_IDS.includes(req.user.id)) return res.status(403).json({ success: false, error: 'Admin only' });
    next();
}

function ensureCanGenerate(req, res, next) {
    if (!req.isAuthenticated()) return res.status(401).json({ success: false, error: 'Not logged in' });
    if (!ADMIN_IDS.includes(req.user.id) && !db.isWhitelisted(req.user.id)) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    next();
}

// Health check
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

// Auth routes
app.get('/login', passport.authenticate('discord'));

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }), 
    (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// API Routes
app.get('/api/user', ensureAuth, (req, res) => {
    const user = db.getUser(req.user.id);
    const trialActive = db.isTrialActive(req.user.id);
    const trialTimeLeft = trialActive ? db.getTrialTimeLeft(req.user.id) : 0;
    const isAdmin = ADMIN_IDS.includes(req.user.id);
    const isWhitelisted = db.isWhitelisted(req.user.id);
    
    res.json({ 
        id: req.user.id,
        username: req.user.username,
        global_name: req.user.global_name,
        avatar: req.user.avatar,
        purchased: user.purchased === true,
        trialActive: trialActive,
        trialTimeLeft: trialTimeLeft,
        trialExpires: user.trial_expires || 0,
        accountsLimit: user.accounts_limit || 1,
        accountsPurchased: user.accounts_purchased || 0,
        isAdmin: isAdmin,
        isWhitelisted: isWhitelisted,
        canGenerate: isAdmin || isWhitelisted
    });
});

app.post('/api/trial/claim', ensureAuth, (req, res) => {
    const userId = req.user.id;
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    
    if (db.hasClaimedTrial(userId)) {
        return res.json({ success: false, error: 'You already claimed your trial' });
    }
    
    if (db.hasIPClaimedTrial(ip)) {
        return res.json({ success: false, error: 'Trial already claimed from this IP' });
    }
    
    const trial = db.claimTrial(userId, ip);
    
    res.json({ 
        success: true, 
        message: 'Trial activated for 10 minutes',
        expiresAt: trial.expiresAt,
        timeLeft: 600
    });
});

app.get('/api/trial/status', ensureAuth, (req, res) => {
    const userId = req.user.id;
    const isActive = db.isTrialActive(userId);
    const timeLeft = isActive ? db.getTrialTimeLeft(userId) : 0;
    const hasClaimed = db.hasClaimedTrial(userId);
    
    res.json({
        success: true,
        hasClaimed: hasClaimed,
        isActive: isActive,
        timeLeft: timeLeft,
        canClaim: !hasClaimed && !db.hasIPClaimedTrial(req.ip || 'unknown')
    });
});

app.post('/api/redeem', ensureAuth, (req, res) => {
    try {
        const { key } = req.body;
        const userId = req.user.id;
        
        if (!key || typeof key !== 'string') {
            return res.json({ success: false, error: 'Invalid key' });
        }
        
        const trimmed = key.trim().toUpperCase();
        
        if (!db.isKeyValid(trimmed)) {
            return res.json({ success: false, error: 'Invalid or expired key' });
        }
        
        const user = db.getUser(userId);
        if (user.purchased === true) {
            return res.json({ success: false, error: 'You already have access' });
        }
        
        db.useGeneratedKey(trimmed, userId);
        
        res.json({ success: true, message: 'Access granted to Veiled Adv!' });
        
    } catch (err) {
        console.error('[REDEEM ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/bot/configs', ensureAuth, ensurePurchased, (req, res) => {
    const configs = db.getConfigs(req.user.id);
    const user = db.getUser(req.user.id);
    res.json({ 
        success: true, 
        configs,
        accountsLimit: user.accounts_limit || 1
    });
});

app.post('/api/bot/start', ensureAuth, ensurePurchased, async (req, res) => {
    try {
        const { 
            token, channels, message, delay, 
            autoReplyEnabled, autoReplyText, 
            configId = 'default', joinServer, serverInvite, 
            imageUrl, sendAllAtOnce 
        } = req.body;
        
        if (!token || !channels || !message) {
            return res.status(400).json({ success: false, error: 'Missing fields' });
        }
        
        const user = db.getUser(req.user.id);
        const currentConfigs = db.getConfigs(req.user.id);
        
        if (currentConfigs.length >= (user.accounts_limit || 1)) {
            return res.status(403).json({ 
                success: false, 
                error: 'Account limit reached. Purchase additional slots for $0.50 each.' 
            });
        }
        
        const channelList = channels.split(',').map(c => c.trim()).filter(c => /^\d+$/.test(c));
        if (channelList.length === 0) {
            return res.json({ success: false, error: 'Invalid channel IDs' });
        }
        
        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch(e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not loaded' });
        }
        
        const validation = await selfbotModule.validateToken(token);
        if (!validation.valid) return res.json({ success: false, error: 'Invalid token' });
        
        const delaySeconds = parseInt(delay) || 30;
        const autoReply = autoReplyEnabled ? true : false;
        
        let joinStatus = null;
        if (joinServer && serverInvite) {
            joinStatus = await selfbotModule.joinServer(token, serverInvite);
        }
        
        let savedImageUrl = null;
        if (imageUrl && imageUrl.startsWith('data:')) {
            try {
                const imageId = `img_${Date.now()}_${req.user.id}.png`;
                const imagePath = path.join(dataDir, 'uploads');
                if (!fs.existsSync(imagePath)) fs.mkdirSync(imagePath, { recursive: true });
                
                const base64Data = imageUrl.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                fs.writeFileSync(path.join(imagePath, imageId), buffer);
                savedImageUrl = `/uploads/${imageId}`;
            } catch (imgErr) {
                console.error('[IMAGE SAVE ERROR]', imgErr);
            }
        }
        
        db.setConfig(req.user.id, {
            token, channels, message, 
            delay_seconds: delaySeconds, 
            auto_reply_enabled: autoReply, 
            auto_reply_text: autoReplyText || '',
            active: true,
            username: validation.username,
            server_joined: joinStatus?.success || false,
            image_url: savedImageUrl || imageUrl || null,
            send_all_at_once: sendAllAtOnce ? true : false
        }, configId);
        
        db.registerActiveBot(req.user.id, configId, token);
        
        await selfbotModule.startSelfBot(
            req.user.id, token, channelList, message, 
            delaySeconds * 1000, autoReply, autoReplyText, 
            configId, savedImageUrl || imageUrl, req.ip, 
            sendAllAtOnce, db
        );
        
        res.json({ 
            success: true, 
            username: validation.username, 
            configId,
            serverJoined: joinStatus?.success || false,
            imageUrl: savedImageUrl
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/stop', ensureAuth, (req, res) => {
    try {
        const { configId = 'default' } = req.body;
        let selfbotModule;
        try {
            selfbotModule = require('./selfbot');
        } catch(e) {
            return res.status(500).json({ success: false, error: 'Selfbot module not loaded' });
        }
        
        selfbotModule.stopSelfBot(req.user.id, configId);
        db.unregisterActiveBot(req.user.id, configId);
        const config = db.getConfig(req.user.id, configId);
        if (config) {
            config.active = false;
            db.setConfig(req.user.id, config, configId);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/bot/delete', ensureAuth, (req, res) => {
    try {
        const { configId } = req.body;
        db.deleteConfig(req.user.id, configId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/upload/image', ensureAuth, ensurePurchased, async (req, res) => {
    try {
        const { imageBase64 } = req.body;
        if (!imageBase64) return res.json({ success: false, error: 'No image provided' });
        
        const imageId = `img_${Date.now()}.png`;
        const imagePath = path.join(dataDir, 'uploads');
        if (!fs.existsSync(imagePath)) fs.mkdirSync(imagePath, { recursive: true });
        
        const buffer = Buffer.from(imageBase64.split(',')[1], 'base64');
        fs.writeFileSync(path.join(imagePath, imageId), buffer);
        
        res.json({ 
            success: true, 
            imageUrl: `/uploads/${imageId}`,
            imageId: imageId
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.use('/uploads', express.static(path.join(dataDir, 'uploads')));

// Admin API Routes
app.get('/api/admin/keys', ensureCanGenerate, (req, res) => {
    const keys = db.getGeneratedKeys();
    res.json({ success: true, keys });
});

app.post('/api/admin/keys/generate', ensureCanGenerate, (req, res) => {
    const { duration } = req.body;
    if (!duration || !['lifetime', '1h', '24h', '7d', '30d'].includes(duration)) {
        return res.status(400).json({ success: false, error: 'Invalid duration' });
    }
    
    let dbDuration = duration;
    if (duration === '7d') dbDuration = '168';
    if (duration === '30d') dbDuration = '720';
    
    const keyData = db.generateKey(dbDuration);
    res.json({ success: true, key: keyData });
});

app.post('/api/admin/keys/revoke', ensureAdmin, (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'No key provided' });
    
    const success = db.revokeKey(key);
    res.json({ success });
});

app.get('/api/admin/whitelist', ensureAdmin, (req, res) => {
    res.json({ success: true, whitelist: db.getWhitelist() });
});

app.post('/api/admin/whitelist/add', ensureAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'No user ID provided' });
    
    db.addToWhitelist(userId);
    res.json({ success: true });
});

app.post('/api/admin/whitelist/remove', ensureAdmin, (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'No user ID provided' });
    
    db.removeFromWhitelist(userId);
    res.json({ success: true });
});

app.post('/api/admin/purchase-accounts', ensureAuth, (req, res) => {
    const { amount } = req.body;
    if (!amount || amount < 1) {
        return res.status(400).json({ success: false, error: 'Invalid amount' });
    }
    
    const newLimit = db.purchaseAccounts(req.user.id, parseInt(amount));
    res.json({ success: true, newLimit, cost: amount * 0.50 });
});

// Frontend Routes - Serve the single page app
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: err.message });
});

module.exports = { app, db };
