const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

class VeiledDB {
  constructor() {
    this.ready = false;
  }

  async init() {
    if (this.ready) return;
    const client = await pool.connect();
    client.release();
    await this._createTables();
    this.ready = true;
    console.log('[DB] PostgreSQL ready');
  }

  async _createTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(32) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS configs (
        user_id VARCHAR(32),
        config_id VARCHAR(50) DEFAULT 'default',
        data JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (user_id, config_id)
      );

      CREATE TABLE IF NOT EXISTS generated_keys (
        key VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS payments (
        id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS used_address_indices (
        idx INT PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS trial_claims (
        user_id VARCHAR(32) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS active_bots (
        user_id VARCHAR(32),
        config_id VARCHAR(50),
        data JSONB NOT NULL DEFAULT '{}',
        PRIMARY KEY (user_id, config_id)
      );

      CREATE TABLE IF NOT EXISTS whitelist (
        user_id VARCHAR(32) PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS revoked_users (
        user_id VARCHAR(32) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS replied_users (
        bot_key VARCHAR(100) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS revoked_addresses (
        address VARCHAR(100) PRIMARY KEY
      );

      CREATE TABLE IF NOT EXISTS active_address_monitors (
        payment_id VARCHAR(50) PRIMARY KEY,
        data JSONB NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS global_counters (
        name VARCHAR(50) PRIMARY KEY,
        value INT DEFAULT 0
      );
    `);

    await pool.query(`
      INSERT INTO global_counters (name, value) VALUES ('address_index', 0)
      ON CONFLICT (name) DO NOTHING;
    `);
  }

  // ---------- USERS ----------
  async getUser(id) {
    const res = await pool.query('SELECT data FROM users WHERE id = $1', [id]);
    const defaults = {
      purchased: false, trial_active: false, trial_expires: 0, accounts_limit: 1,
      accounts_configured: 0, purchased_slots: 0, plan: null, plan_expires: null,
      can_use_image: false, can_auto_reply: false, can_join_server: false,
      can_send_all: false, key_revoked: false
    };
    if (res.rows.length === 0) return defaults;
    return { ...defaults, ...res.rows[0].data };
  }

  async setUser(id, data) {
    const existing = await this.getUser(id);
    const merged = { ...existing, ...data };
    await pool.query(`
      INSERT INTO users (id, data) VALUES ($1, $2)
      ON CONFLICT (id) DO UPDATE SET data = $2
    `, [id, JSON.stringify(merged)]);
  }

  getUserTotalLimit(userId) {
    return this.getUser(userId).then(u => {
      const base = { v3: 5, 'v3-lifetime': 5, v2: 3, v1: 1 }[u.plan || ''] || 1;
      return Math.min(5, base + (u.purchased_slots || 0));
    });
  }

  getUserPurchasableSlots(userId) {
    return this.getUser(userId).then(u => {
      const base = { v3: 5, 'v3-lifetime': 5, v2: 3, v1: 1 }[u.plan || ''] || 1;
      return Math.max(0, 5 - base - (u.purchased_slots || 0));
    });
  }

  // ---------- TRIALS ----------
  async hasClaimedTrial(userId) {
    const res = await pool.query('SELECT 1 FROM trial_claims WHERE user_id = $1', [userId]);
    return res.rows.length > 0;
  }

  async hasIPClaimedTrial(ip) {
    const res = await pool.query('SELECT data FROM trial_claims');
    return res.rows.some(r => r.data.ip === ip);
  }

  async claimTrial(userId, ip) {
    const now = Date.now();
    const expiresAt = now + 10 * 60 * 1000;
    await pool.query(`
      INSERT INTO trial_claims (user_id, data) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET data = $2
    `, [userId, JSON.stringify({ userId, ip, claimedAt: now, expiresAt })]);
    await this.setUser(userId, {
      trial_active: true, trial_expires: expiresAt, trial_claimed_at: now,
      can_use_image: true, can_auto_reply: true, can_join_server: true,
      can_send_all: true, accounts_limit: 1, accounts_configured: 0, key_revoked: false
    });
    return { claimedAt: now, expiresAt };
  }

  async isTrialActive(userId) {
    const u = await this.getUser(userId);
    if (u.trial_active && u.trial_expires > Date.now()) return true;
    if (u.trial_active && u.trial_expires <= Date.now()) {
      await this.setUser(userId, { trial_active: false });
      await this.deactivateAllUserBots(userId);
      return false;
    }
    return false;
  }

  getTrialTimeLeft(userId) {
    return this.getUser(userId).then(u => {
      if (u.trial_active && u.trial_expires > Date.now()) return Math.ceil((u.trial_expires - Date.now()) / 1000);
      return 0;
    });
  }

  // ---------- CONFIGS ----------
  async getConfigs(userId) {
    const res = await pool.query('SELECT config_id, data FROM configs WHERE user_id = $1', [userId]);
    return res.rows.map(r => ({ id: r.config_id, ...r.data }));
  }

  async getConfig(userId, configId = 'default') {
    const configs = await this.getConfigs(userId);
    return configs.find(c => c.id === configId) || configs[0] || null;
  }

  async setConfig(userId, config, configId = 'default') {
    const data = { ...config, id: configId, updated_at: Date.now() };
    await pool.query(`
      INSERT INTO configs (user_id, config_id, data) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, config_id) DO UPDATE SET data = $3
    `, [userId, configId, JSON.stringify(data)]);
  }

  async deleteConfig(userId, configId) {
    await pool.query('DELETE FROM configs WHERE user_id = $1 AND config_id = $2', [userId, configId]);
  }

  // ---------- ACTIVE BOTS ----------
  async registerActiveBot(userId, configId, token) {
    await pool.query(`
      INSERT INTO active_bots (user_id, config_id, data) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, config_id) DO UPDATE SET data = $3
    `, [userId, configId, JSON.stringify({ token, startedAt: Date.now(), configId })]);
  }

  async unregisterActiveBot(userId, configId) {
    await pool.query('DELETE FROM active_bots WHERE user_id = $1 AND config_id = $2', [userId, configId]);
  }

  async getUserActiveBots(userId) {
    const res = await pool.query('SELECT config_id, data FROM active_bots WHERE user_id = $1', [userId]);
    const bots = {};
    res.rows.forEach(r => { bots[r.config_id] = r.data; });
    return bots;
  }

  async deactivateAllUserBots(userId) {
    if (global.selfbotModule) {
      const bots = await this.getUserActiveBots(userId);
      for (const cid in bots) {
        try { global.selfbotModule.stopSelfBot(userId, cid); } catch (e) {}
      }
    }
    const configs = await this.getConfigs(userId);
    for (const c of configs) {
      c.active = false;
      await this.setConfig(userId, c, c.id);
    }
    await pool.query('DELETE FROM active_bots WHERE user_id = $1', [userId]);
  }

  // ---------- REVOKE ----------
  async revokeUser(userId) {
    const u = await this.getUser(userId);
    await this.deactivateAllUserBots(userId);
    await pool.query(`
      INSERT INTO revoked_users (user_id, data) VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET data = $2
    `, [userId, JSON.stringify({ userId, revokedAt: Date.now(), previousPlan: u.plan, previousPurchased: u.purchased })]);
    await this.setUser(userId, {
      purchased: false, key_revoked: true, plan: null, plan_expires: null,
      accounts_limit: 1, purchased_slots: 0, accounts_configured: 0,
      can_use_image: false, can_auto_reply: false, can_join_server: false,
      can_send_all: false, trial_active: false, trial_expires: 0
    });
    return true;
  }

  async unrevokeUser(userId) {
    await pool.query('DELETE FROM revoked_users WHERE user_id = $1', [userId]);
    await this.setUser(userId, { key_revoked: false });
    return true;
  }

  async isUserRevoked(userId) {
    const res = await pool.query('SELECT 1 FROM revoked_users WHERE user_id = $1', [userId]);
    return res.rows.length > 0;
  }

  async getRevokedUsers() {
    const res = await pool.query('SELECT user_id, data FROM revoked_users');
    return res.rows.map(r => ({ userId: r.user_id, ...r.data }));
  }

  // ---------- KEYS ----------
  async generateKey(duration, tier = 'v1') {
    const key = 'VEILED-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    const now = Date.now();
    const expiresAt = duration === 'lifetime' ? null : now + parseInt(duration) * 60 * 60 * 1000;
    const data = { key, duration, tier, createdAt: now, expiresAt, usedBy: [], active: true };
    await pool.query('INSERT INTO generated_keys (key, data) VALUES ($1, $2)', [key, JSON.stringify(data)]);
    return data;
  }

  async revokeKey(key) {
    const res = await pool.query('SELECT data FROM generated_keys WHERE key = $1', [key]);
    if (res.rows.length === 0) return false;
    const data = res.rows[0].data;
    data.active = false;
    data.revokedAt = Date.now();
    await pool.query('UPDATE generated_keys SET data = $1 WHERE key = $2', [JSON.stringify(data), key]);
    for (const uid of data.usedBy || []) {
      await this.deactivateAllUserBots(uid);
      await this.setUser(uid, {
        purchased: false, key_revoked: true, plan: null, plan_expires: null,
        accounts_limit: 1, purchased_slots: 0, accounts_configured: 0,
        can_use_image: false, can_auto_reply: false, can_join_server: false,
        can_send_all: false, trial_active: false, trial_expires: 0
      });
    }
    return true;
  }

  async isKeyValid(key) {
    const res = await pool.query('SELECT data FROM generated_keys WHERE key = $1', [key]);
    if (res.rows.length === 0) return false;
    const d = res.rows[0].data;
    if (!d.active) return false;
    if (d.duration === 'lifetime') return true;
    if (d.expiresAt && Date.now() > d.expiresAt) return false;
    return true;
  }

  async useGeneratedKey(key, userId) {
    if (!(await this.isKeyValid(key))) return false;
    const res = await pool.query('SELECT data FROM generated_keys WHERE key = $1', [key]);
    const d = res.rows[0].data;
    if (!d.usedBy.includes(userId)) d.usedBy.push(userId);
    await pool.query('UPDATE generated_keys SET data = $1 WHERE key = $2', [JSON.stringify(d), key]);
    
    const tier = d.tier || 'v1';
    const base = { v3: 5, v2: 3, v1: 1 }[tier] || 1;
    const perms = {
      v1: { can_use_image: false, can_auto_reply: false, can_join_server: false, can_send_all: true },
      v2: { can_use_image: true, can_auto_reply: false, can_join_server: false, can_send_all: true },
      v3: { can_use_image: true, can_auto_reply: true, can_join_server: true, can_send_all: true }
    }[tier];

    if (await this.isUserRevoked(userId)) {
      await pool.query('DELETE FROM revoked_users WHERE user_id = $1', [userId]);
    }

    await this.setUser(userId, {
      purchased: true, key_revoked: false, purchased_at: now, generated_key: key,
      key_expires: d.expiresAt, plan: tier, accounts_configured: 0, purchased_slots: 0,
      accounts_limit: base, plan_expires: d.duration === 'lifetime' ? null : d.expiresAt,
      ...perms
    });
    return true;
  }

  async getGeneratedKeys() {
    const res = await pool.query('SELECT data FROM generated_keys ORDER BY (data->>\'createdAt\')::bigint DESC');
    return res.rows.map(r => r.data);
  }

  // ---------- WHITELIST ----------
  async addToWhitelist(userId) {
    await pool.query('INSERT INTO whitelist (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  }

  async removeFromWhitelist(userId) {
    await pool.query('DELETE FROM whitelist WHERE user_id = $1', [userId]);
  }

  async isWhitelisted(userId) {
    const res = await pool.query('SELECT 1 FROM whitelist WHERE user_id = $1', [userId]);
    return res.rows.length > 0;
  }

  async getWhitelist() {
    const res = await pool.query('SELECT user_id FROM whitelist');
    return res.rows.map(r => r.user_id);
  }

  // ---------- SLOTS ----------
  async addPurchasedSlots(userId, amount) {
    const u = await this.getUser(userId);
    const newSlots = (u.purchased_slots || 0) + amount;
    await this.setUser(userId, { purchased_slots: newSlots });
    return newSlots;
  }

  // ---------- PAYMENTS ----------
  async createPayment(userId, tier, amountUSD, ltcAmount, ltcAddress, addressIndex, privateKeyWIF, extra = {}) {
    const id = require('crypto').randomUUID();
    const data = {
      id, userId, tier, amountUSD, ltcAmount, ltcAddress, addressIndex,
      privateKeyWIF, status: 'pending', createdAt: Date.now(),
      expiresAt: Date.now() + 30 * 60 * 1000, ...extra
    };
    await pool.query('INSERT INTO payments (id, data) VALUES ($1, $2)', [id, JSON.stringify(data)]);
    await this.recordUsedAddressIndex(addressIndex, ltcAddress, privateKeyWIF);
    return data;
  }

  async getPendingPayment(userId) {
    const res = await pool.query('SELECT data FROM payments WHERE data->>\'userId\' = $1 AND data->>\'status\' = $2', [userId, 'pending']);
    const pending = res.rows.map(r => r.data).filter(p => p.expiresAt > Date.now());
    return pending.sort((a, b) => b.createdAt - a.createdAt)[0] || null;
  }

  async getPaymentById(paymentId) {
    const res = await pool.query('SELECT data FROM payments WHERE id = $1', [paymentId]);
    return res.rows[0]?.data || null;
  }

  async updatePaymentStatus(paymentId, status, extra = {}) {
    const p = await this.getPaymentById(paymentId);
    if (!p) return null;
    Object.assign(p, { status }, extra);
    await pool.query('UPDATE payments SET data = $1 WHERE id = $2', [JSON.stringify(p), paymentId]);
    return p;
  }

  async getUserPayments(userId) {
    const res = await pool.query('SELECT data FROM payments WHERE data->>\'userId\' = $1 ORDER BY (data->>\'createdAt\')::bigint DESC', [userId]);
    return res.rows.map(r => r.data);
  }

  // ---------- ADDRESSES ----------
  async getNextAddressIndex() {
    const res = await pool.query("UPDATE global_counters SET value = value + 1 WHERE name = 'address_index' RETURNING value");
    return res.rows[0].value - 1;
  }

  async recordUsedAddressIndex(index, address, privateKeyWIF) {
    await pool.query(`
      INSERT INTO used_address_indices (idx, data) VALUES ($1, $2) ON CONFLICT DO NOTHING
    `, [index, JSON.stringify({ index, address, privateKeyWIF, createdAt: Date.now() })]);
  }

  async getUsedAddressIndices() {
    const res = await pool.query('SELECT data FROM used_address_indices ORDER BY idx');
    return res.rows.map(r => r.data);
  }

  async markIndexSwept(index, txid) {
    const res = await pool.query('SELECT data FROM used_address_indices WHERE idx = $1', [index]);
    if (res.rows.length === 0) return;
    const d = res.rows[0].data;
    d.swept = true; d.sweepTxid = txid; d.sweptAt = Date.now();
    await pool.query('UPDATE used_address_indices SET data = $1 WHERE idx = $2', [JSON.stringify(d), index]);
  }

  async isIndexSwept(index) {
    const res = await pool.query('SELECT data FROM used_address_indices WHERE idx = $1', [index]);
    return res.rows.length > 0 && res.rows[0].data.swept === true;
  }

  async revokeAddress(address) {
    await pool.query('INSERT INTO revoked_addresses (address) VALUES ($1) ON CONFLICT DO NOTHING', [address]);
  }

  async isAddressRevoked(address) {
    const res = await pool.query('SELECT 1 FROM revoked_addresses WHERE address = $1', [address]);
    return res.rows.length > 0;
  }

  async startAddressMonitor(paymentId, address, privateKeyWIF) {
    await pool.query(`
      INSERT INTO active_address_monitors (payment_id, data) VALUES ($1, $2)
      ON CONFLICT (payment_id) DO UPDATE SET data = $2
    `, [paymentId, JSON.stringify({ address, privateKeyWIF, startedAt: Date.now(), expiresAt: Date.now() + 30 * 60 * 1000 })]);
  }

  async endAddressMonitor(paymentId) {
    const res = await pool.query('SELECT data FROM active_address_monitors WHERE payment_id = $1', [paymentId]);
    if (res.rows.length > 0) {
      await this.revokeAddress(res.rows[0].data.address);
    }
    await pool.query('DELETE FROM active_address_monitors WHERE payment_id = $1', [paymentId]);
  }

  async getActiveAddressMonitors() {
    const res = await pool.query('SELECT payment_id, data FROM active_address_monitors');
    const out = {};
    res.rows.forEach(r => { out[r.payment_id] = r.data; });
    return out;
  }

  // ---------- REPLIED USERS ----------
  async hasRepliedToUser(botKey, userId) {
    const res = await pool.query('SELECT data FROM replied_users WHERE bot_key = $1', [botKey]);
    if (res.rows.length === 0) return false;
    return (res.rows[0].data.userIds || []).includes(userId);
  }

  async markUserReplied(botKey, userId) {
    const res = await pool.query('SELECT data FROM replied_users WHERE bot_key = $1', [botKey]);
    let ids = [];
    if (res.rows.length > 0) ids = res.rows[0].data.userIds || [];
    if (!ids.includes(userId)) ids.push(userId);
    await pool.query(`
      INSERT INTO replied_users (bot_key, data) VALUES ($1, $2)
      ON CONFLICT (bot_key) DO UPDATE SET data = $2
    `, [botKey, JSON.stringify({ userIds: ids })]);
  }

  async getRepliedUsers(botKey) {
    const res = await pool.query('SELECT data FROM replied_users WHERE bot_key = $1', [botKey]);
    return res.rows[0]?.data?.userIds || [];
  }

  // ---------- MIGRATION ----------
  async migrateFromJSON(oldData) {
    console.log('[MIGRATE] Starting...');
    if (oldData.users) {
      for (const [id, u] of Object.entries(oldData.users)) await this.setUser(id, u);
    }
    if (oldData.configs) {
      for (const [uid, cfgs] of Object.entries(oldData.configs)) {
        for (const c of cfgs) await this.setConfig(uid, c, c.id || 'default');
      }
    }
    if (oldData.generatedKeys) {
      for (const [k, d] of Object.entries(oldData.generatedKeys)) {
        await pool.query('INSERT INTO generated_keys (key, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [k, JSON.stringify(d)]);
      }
    }
    if (oldData.payments) {
      for (const p of oldData.payments) {
        await pool.query('INSERT INTO payments (id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [p.id, JSON.stringify(p)]);
      }
    }
    if (oldData.usedAddressIndices) {
      for (const a of oldData.usedAddressIndices) {
        await this.recordUsedAddressIndex(a.index, a.address, a.privateKeyWIF);
        if (oldData.sweptIndices?.[String(a.index)]) {
          await this.markIndexSwept(a.index, oldData.sweptIndices[String(a.index)].txid);
        }
      }
    }
    if (oldData.trialClaims) {
      for (const [uid, t] of Object.entries(oldData.trialClaims)) {
        await pool.query('INSERT INTO trial_claims (user_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, JSON.stringify(t)]);
      }
    }
    if (oldData.whitelist) {
      for (const uid of oldData.whitelist) await this.addToWhitelist(uid);
    }
    if (oldData.revokedUsers) {
      for (const [uid, d] of Object.entries(oldData.revokedUsers)) {
        await pool.query('INSERT INTO revoked_users (user_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [uid, JSON.stringify(d)]);
      }
    }
    if (oldData.repliedUsers) {
      for (const [bk, ids] of Object.entries(oldData.repliedUsers)) {
        await pool.query('INSERT INTO replied_users (bot_key, data) VALUES ($1, $2) ON CONFLICT DO NOTHING', [bk, JSON.stringify({ userIds: ids })]);
      }
    }
    if (oldData.addressIndex) {
      await pool.query("UPDATE global_counters SET value = $1 WHERE name = 'address_index'", [oldData.addressIndex + 1]);
    }
    console.log('[MIGRATE] Done');
  }
}

const db = new VeiledDB();
module.exports = { db, pool };
