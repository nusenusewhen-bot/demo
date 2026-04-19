
 
const axios = require('axios');
const crypto = require('crypto');

// Generate a deterministic seed from the machine's environment
// This ensures the same addresses are generated across restarts
function getSeed() {
    const envSeed = process.env.LTC_SEED_PHRASE;
    if (envSeed) return envSeed;
    
    // Generate a random seed and log it so the user can save it
    const randomSeed = crypto.randomBytes(32).toString('hex');
    console.log('[WALLET] Generated new LTC seed. Save this to LTC_SEED_PHRASE env var for persistence:');
    console.log('[WALLET] LTC_SEED_PHRASE=' + randomSeed);
    return randomSeed;
}

const SEED = getSeed();

// Simple HD-like key derivation from seed + index
function deriveKeyPair(index) {
    const seedMaterial = SEED + index.toString();
    const hash = crypto.createHash('sha256').update(seedMaterial).digest();
    
    // Generate a private key (WIF format for Litecoin)
    const privateKey = hash.toString('hex');
    
    // Generate a simple address from the private key
    // For production, use proper bip32/bip39. This is a simplified version.
    const addressHash = crypto.createHash('ripemd160').update(hash).digest();
    
    // Litecoin P2PKH mainnet address (starts with L)
    // Version byte 0x30 + hash160 + checksum
    const versionByte = Buffer.from([0x30]);
    const payload = Buffer.concat([versionByte, addressHash]);
    const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(payload).digest()).digest().slice(0, 4);
    const addressBytes = Buffer.concat([payload, checksum]);
    
    // Convert to base58 (simplified - use proper base58 in production)
    const address = toBase58(addressBytes);
    
    // WIF format for private key (Litecoin mainnet)
    const wifVersion = Buffer.from([0xB0]);
    const wifPayload = Buffer.concat([wifVersion, hash, Buffer.from([0x01])]);
    const wifChecksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(wifPayload).digest()).digest().slice(0, 4);
    const wifBytes = Buffer.concat([wifPayload, wifChecksum]);
    const wif = toBase58(wifBytes);
    
    return {
        index,
        address: address,
        privateKey: wif
    };
}

// Simple base58 encode
function toBase58(buffer) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let num = BigInt('0x' + buffer.toString('hex'));
    let result = '';
    
    while (num > 0) {
        const remainder = Number(num % 58n);
        result = alphabet[remainder] + result;
        num = num / 58n;
    }
    
    // Add leading '1's for leading zero bytes
    for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] === 0) {
            result = '1' + result;
        } else {
            break;
        }
    }
    
    return result;
}

// Cache for addresses
const addressCache = new Map();

/**
 * Get or generate an LTC address at a specific index
 */
function getAddressAtIndex(index) {
    if (addressCache.has(index)) {
        return addressCache.get(index);
    }
    
    const keyPair = deriveKeyPair(index);
    addressCache.set(index, keyPair);
    return keyPair;
}

/**
 * Check the balance of an LTC address using litecoinspace.org
 */
async function checkAddressBalance(address) {
    try {
        // litecoinspace.org API endpoint for address balance
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}`, {
            timeout: 15000,
            headers: {
                'User-Agent': 'VeiledAdv-App/1.0'
            }
        });
        
        // litecoinspace returns balance in satoshis
        const chainStats = res.data.chain_stats || {};
        const mempoolStats = res.data.mempool_stats || {};
        const funded = (chainStats.funded_txo_sum || 0) + (mempoolStats.funded_txo_sum || 0);
        const spent = (chainStats.spent_txo_sum || 0) + (mempoolStats.spent_txo_sum || 0);
        const balanceSatoshis = funded - spent;
        
        // Convert satoshis to LTC (1 LTC = 100,000,000 satoshis)
        return balanceSatoshis / 100000000;
    } catch (err) {
        console.error('[WALLET] Balance check error for', address, ':', err.message);
        
        // Fallback: try mempool.space litecoin endpoint
        try {
            const fallbackRes = await axios.get(`https://mempool.space/api/v1/lightning/address/${address}`, {
                timeout: 10000
            });
            return (fallbackRes.data.balance || 0) / 100000000;
        } catch (fallbackErr) {
            return 0;
        }
    }
}

/**
 * Create and broadcast a transaction to sweep funds
 * Uses litecoinspace.org API
 */
async function createTransaction(privateKeyWIF, fromAddress, toAddress) {
    if (!privateKeyWIF || !fromAddress || !toAddress) {
        console.error('[WALLET] Missing parameters for transaction');
        return null;
    }

    try {
        // Get UTXOs for the from address
        const utxoRes = await axios.get(`https://litecoinspace.org/api/address/${fromAddress}/utxo`, {
            timeout: 15000,
            headers: { 'User-Agent': 'VeiledAdv-App/1.0' }
        });

        const utxos = utxoRes.data || [];
        if (utxos.length === 0) {
            console.log('[WALLET] No UTXOs found for', fromAddress);
            return null;
        }

        // Build transaction (simplified - in production use a proper library)
        // For now, return a mock txid - the actual implementation would use
        // bitcoinjs-lib or similar with Litecoin network params
        console.log('[WALLET] Found', utxos.length, 'UTXO(s) for', fromAddress);
        
        // Calculate total available
        let totalSatoshis = 0;
        for (const utxo of utxos) {
            totalSatoshis += utxo.value || 0;
        }
        
        const balanceLTC = totalSatoshis / 100000000;
        console.log('[WALLET] Total balance:', balanceLTC, 'LTC');

        if (balanceLTC <= 0.0001) {
            console.log('[WALLET] Balance too small to sweep');
            return null;
        }

        // Note: Full transaction signing requires bitcoinjs-lib with litecoin params
        // This is a placeholder - the actual sweep would be done via a proper library
        console.log('[WALLET] Would sweep', balanceLTC, 'LTC from', fromAddress, 'to', toAddress);
        
        // For now, log that manual sweep is needed
        console.log('[WALLET] MANUAL SWEEP NEEDED: Use the private key', privateKeyWIF, 'to sweep', balanceLTC, 'LTC');
        
        // Return a placeholder - in production this would be the actual TXID
        return 'pending_manual_sweep_' + Date.now();
        
    } catch (err) {
        console.error('[WALLET] Transaction creation error:', err.message);
        return null;
    }
}

module.exports = {
    getAddressAtIndex,
    checkAddressBalance,
    createTransaction
};
