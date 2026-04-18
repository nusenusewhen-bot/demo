const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const path = require('path');
const fs = require('fs');
const MemoryStore = require('memorystore')(session);
const axios = require('axios');
const crypto = require('crypto');

// LTC Wallet imports
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const { ECPairFactory } = require('ecpair');
const tinysecp = require('tiny-secp256k1');

const bip32 = BIP32Factory(tinysecp);
const ECPair = ECPairFactory(tinysecp);

// ============ CONFIG ============
const OWNER_ID = process.env.OWNER_ID || '1473055478714990705';
const CO_OWNER_ID = '883976984420556820';
const ADMIN_IDS = [OWNER_ID, CO_OWNER_ID];

// LTC Owner address to sweep payments to
const LTC_OWNER_ADDRESS = process.env.LTC_OWNER_ADDRESS || '';
// Wallet mnemonic - generate one and set in env
const LTC_WALLET_MNEMONIC = process.env.LTC_WALLET_MNEMONIC || '';
// BlockCypher API token (optional but recommended)
const BLOCKCYPHER_TOKEN = process.env.BLOCKCYPHER_TOKEN || '';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// ============ LTC NETWORK ============
const LTC_NETWORK = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

// LTC testnet (for testing)
const LTC_TESTNET = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'tltc',
    bip32: { public: 0x0436f6e1, private: 0x0436ef7d },
    pubKeyHash: 0x6f,
    scriptHash: 0xc4,
    wif: 0xef
};

const USE_TESTNET = process.env.LTC_TESTNET === 'true';
const activeNetwork = USE_TESTNET ? LTC_TESTNET : LTC_NETWORK;

// ============ LTC WALLET ============
class LTCWallet {
    constructor() {
        this.usedIndices = new Set();
        this.loadUsedIndices();
        
        if (LTC_WALLET_MNEMONIC && bip39.validateMnemonic(LTC_WALLET_MNEMONIC)) {
            const seed = bip39.mnemonicToSeedSync(LTC_WALLET_MNEMONIC);
            this.root = bip32.fromSeed(seed, activeNetwork);
            console.log('[LTC] Wallet initialized from mnemonic');
        } else {
            // Generate a random mnemonic if none provided
            console.log('[LTC] WARNING: No valid mnemonic provided. Set LTC_WALLET_MNEMONIC env var.');
            this.root = null;
        }
    }
    
    loadUsedIndices() {
        try {
            const file = path.join(dataDir, 'ltc_used_indices.json');
            if (fs.existsSync(file)) {
                const data = JSON.parse(fs.readFileSync(file, 'utf8'));
                this.usedIndices = new Set(data);
            }
        } catch(e) {}
    }
    
    saveUsedIndices() {
        try {
            const file = path.join(dataDir, 'ltc_used_indices.json');
            fs.writeFileSync(file, JSON.stringify([...this.usedIndices]));
        } catch(e) {}
    }
    
    getNewAddress() {
        if (!this.root) return null;
        
        // Find next unused index
        let index = 0;
        while (this.usedIndices.has(index)) {
            index++;
        }
        
        const child = this.root.derivePath(`m/44'/2'/0'/0/${index}`);
        const { address } = bitcoin.payments.p2pkh({ 
            pubkey: child.publicKey,
            network: activeNetwork 
        });
        
        const privateKeyWIF = child.toWIF();
        
        this.usedIndices.add(index);
        this.saveUsedIndices();
        
        return {
            address,
            index,
            privateKeyWIF,
            createdAt: Date.now()
        };
    }
    
    getAddressPrivateKey(index) {
        if (!this.root) return null;
        const child = this.root.derivePath(`m/44'/2'/0'/0/${index}`);
        return child.toWIF();
    }
}

const ltcWallet = new LTCWallet();

// ============ DATABASE ============
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
            accountPurchases: {},
            payments: [],
            usedAddressIndices: []
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
            accounts_purchased: 0,
            plan: null,
            plan_expires: null
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

    // Payment tracking
    createPayment(userId, tier, amountUSD, ltcAmount, ltcAddress, addressIndex, privateKeyWIF) {
        const payment = {
            id: crypto.randomUUID(),
            userId,
            tier,
            amountUSD,
            ltcAmount,
            ltcAddress,
            addressIndex,
            privateKeyWIF,
            status: 'pending', // pending, paid, expired, swept
            createdAt: Date.now(),
            expiresAt: Date.now() + (30 * 60 * 1000), // 30 min expiry
            paidAt: null,
            txid: null,
            sweptAt: null,
            sweepTxid: null
        };
        this.data.payments = this.data.payments || [];
        this.data.payments.push(payment);
        this.save();
        return payment;
    }

    getPendingPayment(userId) {
        this.data.payments = this.data.payments || [];
        return this.data.payments.find(p => 
            p.userId === userId && 
            p.status === 'pending' && 
            p.expiresAt > Date.now()
        );
    }

    getPaymentById(paymentId) {
        this.data.payments = this.data.payments || [];
        return this.data.payments.find(p => p.id === paymentId);
    }

    updatePaymentStatus(paymentId, status, extra = {}) {
        this.data.payments = this.data.payments || [];
        const idx = this.data.payments.findIndex(p => p.id === paymentId);
        if (idx >= 0) {
            this.data.payments[idx] = { ...this.data.payments[idx], ...extra, status };
            this.save();
            return this.data.payments[idx];
        }
        return null;
    }

    getUserPayments(userId) {
        this.data.payments = this.data.payments || [];
        return this.data.payments
            .filter(p => p.userId === userId)
            .sort((a, b) => b.createdAt - a.createdAt);
    }
}

const db = new VeiledDB();

// ============ EXPRESS APP ============
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

// ============ MIDDLEWARE ============
function ensureAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    return res.status(401).json({ success: false, error: 'Not logged in' });
}

function ensurePurchased(req, res, next) {
    const user = db.getUser(req.user.id);
    const hasPurchase = user.purchased === true;
    const hasActiveTrial = db.isTrialActive(req.user.id);
    const hasActivePlan = user.plan && (!user.plan_expires || user.plan_expires > Date.now());
    
    if (!hasPurchase && !hasActiveTrial && !hasActivePlan) {
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

// ============ LTC PRICE & CONVERSION ============
let ltcPriceUSD = 0;
let lastPriceFetch = 0;

async function getLTCPrice() {
    const now = Date.now();
    if (ltcPriceUSD && (now - lastPriceFetch) < 5 * 60 * 1000) {
        return ltcPriceUSD;
    }
    try {
        const res = await axios.get('https://api.coinbase.com/v2/exchange-rates?currency=LTC', { timeout: 10000 });
        ltcPriceUSD = parseFloat(res.data.data.rates.USD);
        lastPriceFetch = now;
        return ltcPriceUSD;
    } catch(e) {
        console.error('[LTC] Price fetch failed:', e.message);
        return ltcPriceUSD || 80; // fallback
    }
}

function usdToLTC(usdAmount, ltcPrice) {
    return (usdAmount / ltcPrice).toFixed(8);
}

// ============ BLOCK EXPLORER API ============
async function getAddressBalance(address) {
    try {
        // Try BlockCypher first
        const tokenParam = BLOCKCYPHER_TOKEN ? `?token=${BLOCKCYPHER_TOKEN}` : '';
        const chain = USE_TESTNET ? 'ltc-testnet' : 'ltc-main';
        const res = await axios.get(
            `https://api.blockcypher.com/v1/${chain}/addrs/${address}/balance${tokenParam}`,
            { timeout: 15000 }
        );
        // balance is in satoshis
        const confirmed = res.data.balance || 0;
        const unconfirmed = res.data.unconfirmed_balance || 0;
        return {
            confirmed: confirmed / 1e8,
            unconfirmed: unconfirmed / e8,
            total: (confirmed + unconfirmed) / 1e8
        };
    } catch(e) {
        // Fallback to SoChain
        try {
            const network = USE_TESTNET ? 'LTCTEST' : 'LTC';
            const res = await axios.get(
                `https://sochain.com/api/v2/get_address_balance/${network}/${address}`,
                { timeout: 15000 }
            );
            const confirmed = parseFloat(res.data.data.confirmed_balance) || 0;
            return { confirmed, unconfirmed: 0, total: confirmed };
        } catch(e2) {
            console.error('[LTC] Balance check failed for', address, e2.message);
            return null;
        }
    }
}

async function getAddressUTXOs(address) {
    try {
        const network = USE_TESTNET ? 'LTCTEST' : 'LTC';
        const res = await axios.get(
            `https://sochain.com/api/v2/get_tx_unspent/${network}/${address}`,
            { timeout: 15000 }
        );
        if (res.data.status === 'success' && res.data.data.txs) {
            return res.data.data.txs.map(tx => ({
                txid: tx.txid,
                vout: tx.output_no,
                value: Math.round(parseFloat(tx.value) * 1e8),
                scriptPubKey: tx.script_hex
            }));
        }
        return [];
    } catch(e) {
        console.error('[LTC] UTXO fetch failed:', e.message);
        return [];
    }
}

async function broadcastTx(txHex) {
    try {
        const network = USE_TESTNET ? 'LTCTEST' : 'LTC';
        const res = await axios.post(
            `https://sochain.com/api/v2/send_tx/${network}`,
            { tx_hex: txHex },
            { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
        );
        if (res.data.status === 'success') {
            return { success: true, txid: res.data.data.txid };
        }
        return { success: false, error: res.data.data?.error || 'Broadcast failed' };
    } catch(e) {
        return { success: false, error: e.message };
    }
}

// ============ SWEEP FUNCTION ============
async function sweepPayment(payment) {
    if (payment.status !== 'paid' || payment.sweptAt) return;
    if (!LTC_OWNER_ADDRESS || !payment.privateKeyWIF) return;
    
    try {
        const keyPair = ECPair.fromWIF(payment.privateKeyWIF, activeNetwork);
        const utxos = await getAddressUTXOs(payment.ltcAddress);
        
        if (!utxos || utxos.length === 0) return;
        
        const totalInput = utxos.reduce((sum, u) => sum + u.value, 0);
        const fee = 20000; // 0.0002 LTC fee
        const sweepAmount = totalInput - fee;
        
        if (sweepAmount <= 0) return;
        
        const psbt = new bitcoin.Psbt({ network: activeNetwork });
        
        for (const utxo of utxos) {
            psbt.addInput({
                hash: utxo.txid,
                index: utxo.vout,
                witnessUtxo: {
                    script: Buffer.from(utxo.scriptPubKey, 'hex'),
                    value: utxo.value
                }
            });
        }
        
        psbt.addOutput({
            address: LTC_OWNER_ADDRESS,
            value: sweepAmount
        });
        
        for (let i = 0; i < utxos.length; i++) {
            psbt.signInput(i, keyPair);
        }
        
        psbt.finalizeAllInputs();
        const txHex = psbt.extractTransaction().toHex();
        
        const result = await broadcastTx(txHex);
        if (result.success) {
            db.updatePaymentStatus(payment.id, 'swept', {
                sweptAt: Date.now(),
                sweepTxid: result.txid
            });
            console.log('[LTC] Swept', payment.ltcAmount, 'LTC from', payment.ltcAddress, 'txid:', result.txid);
        }
    } catch(e) {
        console.error('[LTC] Sweep failed for', payment.ltcAddress, e.message);
    }
}

// ============ PAYMENT MONITORING ============
async function checkPendingPayments() {
    const payments = db.data.payments || [];
    const pendingPayments = payments.filter(p => p.status === 'pending' && p.expiresAt > Date.now());
    
    for (const payment of pendingPayments) {
        const balance = await getAddressBalance(payment.ltcAddress);
        if (!balance) continue;
        
        const ltcPrice = await getLTCPrice();
        const receivedUSD = balance.confirmed * ltcPrice;
        const tolerance = 0.10; // $0.10 tolerance
        
        if (receivedUSD >= payment.amountUSD - tolerance) {
            // Payment received!
            const updates = {
                status: 'paid',
                paidAt: Date.now(),
                receivedLTC: balance.confirmed,
                receivedUSD: receivedUSD
            };
            
            // Grant access based on tier
            const tier = payment.tier;
            const userUpdates = { purchased: true };
            
            if (tier === 'v1') {
                userUpdates.plan = 'v1';
                userUpdates.accounts_limit = 1;
                userUpdates.plan_expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
            } else if (tier === 'v2') {
                userUpdates.plan = 'v2';
                userUpdates.accounts_limit = 3;
                userUpdates.plan_expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
            } else if (tier === 'v3') {
                userUpdates.plan = 'v3';
                userUpdates.accounts_limit = 999;
                userUpdates.plan_expires = Date.now() + (30 * 24 * 60 * 60 * 1000);
            } else if (tier === 'v3-lifetime') {
                userUpdates.plan = 'v3-lifetime';
                userUpdates.purchased = true;
                userUpdates.accounts_limit = 999;
                userUpdates.plan_expires = null; // never expires
            }
            
            db.setUser(payment.userId, userUpdates);
            db.updatePaymentStatus(payment.id, 'paid', updates);
            
            console.log('[LTC] Payment received! Tier:', tier, 'User:', payment.userId, 'Amount:', receivedUSD);
            
            // Auto-sweep
            if (LTC_OWNER_ADDRESS) {
                setTimeout(() => sweepPayment({ ...payment, status: 'paid' }), 5000);
            }
        }
    }
    
    // Mark expired payments
    for (const payment of payments.filter(p => p.status === 'pending' && p.expiresAt <= Date.now())) {
        db.updatePaymentStatus(payment.id, 'expired');
    }
}

// Run payment monitoring every 30 seconds
setInterval(checkPendingPayments, 30000);

// ============ ROUTES ============

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

// API: Get current user
app.get('/api/user', ensureAuth, (req, res) => {
    const user = db.getUser(req.user.id);
    const trialActive = db.isTrialActive(req.user.id);
    const trialTimeLeft = trialActive ? db.getTrialTimeLeft(req.user.id) : 0;
    const isAdmin = ADMIN_IDS.includes(req.user.id);
    const isWhitelisted = db.isWhitelisted(req.user.id);
    const hasActivePlan = user.plan && (!user.plan_expires || user.plan_expires > Date.now());
    
    res.json({ 
        id: req.user.id,
        username: req.user.username,
        global_name: req.user.global_name,
        avatar: req.user.avatar,
        purchased: user.purchased === true || hasActivePlan,
        trialActive: trialActive,
        trialTimeLeft: trialTimeLeft,
        trialExpires: user.trial_expires || 0,
        accountsLimit: user.accounts_limit || 1,
        accountsPurchased: user.accounts_purchased || 0,
        isAdmin: isAdmin,
        isWhitelisted: isWhitelisted,
        canGenerate: isAdmin || isWhitelisted,
        plan: user.plan || null,
        planExpires: user.plan_expires || null
    });
});

// API: Trial
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

// API: Redeem key
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

// ============ LTC PAYMENT API ============

const TIER_PRICES = {
    'v1': 1.00,
    'v2': 2.00,
    'v3': 2.50,
    'v3-lifetime': 35.00
};

// API: Create payment
app.post('/api/payment/create', ensureAuth, async (req, res) => {
    try {
        const { tier } = req.body;
        const userId = req.user.id;
        
        if (!tier || !TIER_PRICES[tier]) {
            return res.status(400).json({ success: false, error: 'Invalid tier' });
        }
        
        // Check if user already has a pending payment
        const existingPending = db.getPendingPayment(userId);
        if (existingPending) {
            const ltcPrice = await getLTCPrice();
            return res.json({
                success: true,
                payment: {
                    id: existingPending.id,
                    tier: existingPending.tier,
                    amountUSD: existingPending.amountUSD,
                    ltcAmount: existingPending.ltcAmount,
                    ltcAddress: existingPending.ltcAddress,
                    expiresAt: existingPending.expiresAt,
                    timeLeft: Math.ceil((existingPending.expiresAt - Date.now()) / 1000),
                    ltcPriceUSD: ltcPrice
                }
            });
        }
        
        // Generate new LTC address
        const addrData = ltcWallet.getNewAddress();
        if (!addrData) {
            return res.status(500).json({ success: false, error: 'Wallet not configured' });
        }
        
        const ltcPrice = await getLTCPrice();
        const usdAmount = TIER_PRICES[tier];
        const ltcAmount = usdToLTC(usdAmount, ltcPrice);
        
        const payment = db.createPayment(
            userId, tier, usdAmount, ltcAmount,
            addrData.address, addrData.index, addrData.privateKeyWIF
        );
        
        res.json({
            success: true,
            payment: {
                id: payment.id,
                tier: payment.tier,
                amountUSD: payment.amountUSD,
                ltcAmount: payment.ltcAmount,
                ltcAddress: payment.ltcAddress,
                expiresAt: payment.expiresAt,
                timeLeft: 30 * 60,
                ltcPriceUSD: ltcPrice
            }
        });
        
    } catch (err) {
        console.error('[PAYMENT CREATE ERROR]', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Check payment status
app.get('/api/payment/status/:paymentId', ensureAuth, async (req, res) => {
    try {
        const payment = db.getPaymentById(req.params.paymentId);
        if (!payment || payment.userId !== req.user.id) {
            return res.status(404).json({ success: false, error: 'Payment not found' });
        }
        
        const ltcPrice = await getLTCPrice();
        let balance = null;
        
        if (payment.status === 'pending') {
            const bal = await getAddressBalance(payment.ltcAddress);
            if (bal) {
                balance = bal.confirmed;
            }
        }
        
        res.json({
            success: true,
            payment: {
                id: payment.id,
                status: payment.status,
                tier: payment.tier,
                amountUSD: payment.amountUSD,
                ltcAmount: payment.ltcAmount,
                ltcAddress: payment.ltcAddress,
                receivedLTC: payment.receivedLTC || balance || 0,
                receivedUSD: payment.receivedUSD || ((balance || 0) * ltcPrice),
                expiresAt: payment.expiresAt,
                timeLeft: payment.status === 'pending' 
                    ? Math.max(0, Math.ceil((payment.expiresAt - Date.now()) / 1000))
                    : 0,
                ltcPriceUSD: ltcPrice
            }
        });
        
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// API: Get user payment history
app.get('/api/payments', ensureAuth, (req, res) => {
    const payments = db.getUserPayments(req.user.id);
    res.json({
        success: true,
        payments: payments.map(p => ({
            id: p.id,
            tier: p.tier,
            amountUSD: p.amountUSD,
            ltcAmount: p.ltcAmount,
            status: p.status,
            createdAt: p.createdAt,
            paidAt: p.paidAt,
            ltcAddress: p.ltcAddress
        }))
    });
});

// ============ BOT API ============

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
                error: 'Account limit reached. Purchase additional slots.' 
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

// ============ ADMIN API ============

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

// Frontend
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'overall.html'));
});

app.use((err, req, res, next) => {
    console.error('[SERVER ERROR]', err);
    res.status(500).json({ error: err.message });
});

// ============ START ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Veiled Adv] Server running on port ${PORT}`);
    console.log(`[LTC] Wallet ${ltcWallet.root ? 'initialized' : 'NOT CONFIGURED - set LTC_WALLET_MNEMONIC'}`);
    console.log(`[LTC] Sweep address: ${LTC_OWNER_ADDRESS || 'NOT SET'}`);
});

module.exports = { app, db };
