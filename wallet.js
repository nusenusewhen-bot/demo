const axios = require('axios');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const { ECPairFactory } = require('ecpair');
const bip39 = require('bip39');

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

// Explicit Litecoin mainnet network definition
// This ensures addresses start with 'L' (legacy P2PKH) regardless of bitcoinjs-lib version
const network = {
  messagePrefix: '\x19Litecoin Signed Message:\n',
  bech32: 'ltc',
  bip32: {
    public: 0x019da462,
    private: 0x019d9cfe,
  },
  pubKeyHash: 0x30,  // Produces 'L' prefix for legacy addresses
  scriptHash: 0x32,  // Produces 'M' prefix for P2SH
  wif: 0xb0,
};

const skipLogged = new Set();

function looksLikeNonLitecoinAddress(address) {
  if (!address || typeof address !== 'string') return true;
  const a = address.trim();
  if (a.length === 0) return true;
  // Bitcoin addresses (start with 1, 3, bc1, tb1) are NOT Litecoin
  if (a.startsWith('1') || a.startsWith('bc1') || a.startsWith('tb1')) return true;
  // Valid Litecoin prefixes: L (legacy P2PKH), M (P2SH-SegWit), ltc1 (native SegWit), 3 (P2SH - rare but valid)
  const validPrefixes = ['L', 'M', 'ltc1', '3'];
  const isValid = validPrefixes.some((p) => a.startsWith(p));
  return !isValid;
}

function getMnemonic() {
  const m = process.env.WALLET_MNEMONIC || process.env.LTC_SEED_PHRASE;
  if (!m || typeof m !== 'string') {
    throw new Error('Set WALLET_MNEMONIC or LTC_SEED_PHRASE');
  }
  return m.trim();
}

function getRoot() {
  const mnemonic = getMnemonic();
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid BIP39 mnemonic');
  }
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return bip32.fromSeed(seed, network);
}

const addressCache = new Map();

function getAddressAtIndex(index) {
  if (addressCache.has(index)) return addressCache.get(index);
  const root = getRoot();
  const path = `m/44'/2'/0'/0/${index}`;
  const child = root.derivePath(path);
  const keyPair = ECPair.fromPrivateKey(child.privateKey, { network });
  const { address } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
  const out = { index, address, privateKey: keyPair.toWIF() };
  addressCache.set(index, out);
  return out;
}

async function fetchJson(url) {
  const res = await axios.get(url, {
    timeout: 20000,
    headers: { 'User-Agent': 'VeiledAdv/1.0' },
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error('HTTP ' + res.status + ' ' + url);
  return res.data;
}

async function fetchTxHex(txid) {
  const data = await fetchJson(`https://litecoinspace.org/api/tx/${txid}`);
  if (data && data.hex) return data.hex;
  const hex = await fetchJson(`https://litecoinspace.org/api/tx/${txid}/hex`);
  if (typeof hex === 'string') return hex;
  throw new Error('Could not get tx hex for ' + txid);
}

/**
 * Check total balance including unconfirmed (mempool) transactions.
 * Used for displaying received amounts to users.
 */
async function checkAddressBalance(address) {
  if (looksLikeNonLitecoinAddress(address)) {
    if (!skipLogged.has(address)) {
      skipLogged.add(address);
      console.warn(
        '[WALLET] Skipping API for non-Litecoin address (fix/remove bad rows in data/veiled_db.json):',
        address
      );
    }
    return 0;
  }
  try {
    const data = await fetchJson(`https://litecoinspace.org/api/address/${address}`);
    const chain = data.chain_stats || {};
    const mempool = data.mempool_stats || {};
    const funded = (chain.funded_txo_sum || 0) + (mempool.funded_txo_sum || 0);
    const spent = (chain.spent_txo_sum || 0) + (mempool.spent_txo_sum || 0);
    return (funded - spent) / 1e8;
  } catch (e) {
    console.error('[WALLET] Balance error', address, e.message);
    return 0;
  }
}

/**
 * Check ONLY confirmed balance (excludes mempool/unconfirmed transactions).
 * Used for sweep decisions — we can only spend confirmed UTXOs.
 */
async function checkConfirmedBalance(address) {
  if (looksLikeNonLitecoinAddress(address)) {
    return 0;
  }
  try {
    const data = await fetchJson(`https://litecoinspace.org/api/address/${address}`);
    const chain = data.chain_stats || {};
    // Only count confirmed chain stats, ignore mempool
    const funded = chain.funded_txo_sum || 0;
    const spent = chain.spent_txo_sum || 0;
    return (funded - spent) / 1e8;
  } catch (e) {
    console.error('[WALLET] Confirmed balance error', address, e.message);
    return 0;
  }
}

async function broadcastTx(hex) {
  const res = await axios.post('https://litecoinspace.org/api/tx', hex, {
    timeout: 30000,
    headers: { 'Content-Type': 'text/plain', 'User-Agent': 'VeiledAdv/1.0' },
    validateStatus: () => true,
  });
  if (res.status >= 400) throw new Error('Broadcast failed: ' + res.status + ' ' + (res.data && String(res.data).slice(0, 200)));
  return typeof res.data === 'string' ? res.data : res.data && res.data.txid ? res.data.txid : String(res.data);
}

async function createTransaction(privateKeyWIF, fromAddress, toAddress) {
  if (!privateKeyWIF || !fromAddress || !toAddress) {
    console.error('[WALLET] Missing sweep params');
    return null;
  }

  const keyPair = ECPair.fromWIF(privateKeyWIF, network);
  const { address: derived } = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network });
  if (derived !== fromAddress) {
    console.error('[WALLET] WIF does not match fromAddress', derived, fromAddress);
    return null;
  }

  let utxos;
  try {
    utxos = await fetchJson(`https://litecoinspace.org/api/address/${fromAddress}/utxo`);
  } catch (e) {
    console.error('[WALLET] UTXO fetch failed', e.message);
    return null;
  }
  if (!Array.isArray(utxos) || utxos.length === 0) {
    console.log('[WALLET] No UTXOs for', fromAddress);
    return null;
  }

  const psbt = new bitcoin.Psbt({ network });
  let inputSum = 0;

  for (const u of utxos) {
    if (u.status && u.status.confirmed === false) continue;
    const txid = u.txid;
    const vout = u.vout;
    const value = u.value;
    if (!txid || value == null) continue;
    const nonWitnessUtxo = Buffer.from(await fetchTxHex(txid), 'hex');
    psbt.addInput({
      hash: txid,
      index: vout,
      nonWitnessUtxo,
    });
    inputSum += value;
  }

  if (inputSum === 0) {
    console.log('[WALLET] No confirmed UTXOs to spend');
    return null;
  }

  const feeRate = 10;
  const overhead = 10 + psbt.inputCount * 148 + 2 * 34;
  const fee = Math.max(1000, overhead * feeRate);
  const sendValue = inputSum - fee;
  if (sendValue <= 0) {
    console.log('[WALLET] Amount too small after fee');
    return null;
  }

  psbt.addOutput({ address: toAddress, value: sendValue });

  for (let i = 0; i < psbt.inputCount; i++) {
    psbt.signInput(i, keyPair);
  }
  psbt.finalizeAllInputs();
  const tx = psbt.extractTransaction();
  const hex = tx.toHex();
  const txid = await broadcastTx(hex);
  console.log('[WALLET] Broadcast ok', txid);
  return txid;
}

/**
 * Check a single address for balance and sweep to owner if funded.
 * Returns the txid if swept, null otherwise.
 */
async function sweepAddressIfFunded(addressIndex, privateKeyWIF, address, ownerAddress) {
  if (!ownerAddress) return null;
  try {
    const balance = await checkAddressBalance(address);
    if (balance > 0.0001) {
      console.log(`[WALLET] [Index ${addressIndex}] Balance found: ${balance} LTC on ${address}. Sweeping to owner...`);
      const txid = await createTransaction(privateKeyWIF, address, ownerAddress);
      if (txid) {
        console.log(`[WALLET] [Index ${addressIndex}] Swept ${balance} LTC to owner. TXID: ${txid}`);
      }
      return txid;
    }
  } catch (e) {
    console.error(`[WALLET] [Index ${addressIndex}] Sweep check error:`, e.message);
  }
  return null;
}

module.exports = {
  getAddressAtIndex,
  checkAddressBalance,
  checkConfirmedBalance,
  createTransaction,
  sweepAddressIfFunded,
};
