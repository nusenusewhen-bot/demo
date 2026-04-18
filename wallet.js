const bip39 = require('bip39');
const bitcoin = require('bitcoinjs-lib');
const { BIP32Factory } = require('bip32');
const crypto = require('crypto');
const ECPairFactory = require('ecpair').default;
const tinysecp = require('tiny-secp256k1');
const axios = require('axios');

const ECPair = ECPairFactory(tinysecp);
const bip32 = BIP32Factory(tinysecp);

const litecoin = {
    messagePrefix: '\x19Litecoin Signed Message:\n',
    bech32: 'ltc',
    bip32: { public: 0x019da462, private: 0x019d9cfe },
    pubKeyHash: 0x30,
    scriptHash: 0x32,
    wif: 0xb0
};

const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS || 'LQJLnY1XcUzXRvaHatLDU4EKKgY4yWTLuo';

function getScriptPubKeyFromAddress(address) {
    try {
        const decoded = bitcoin.address.fromBase58Check(address);
        const pubKeyHash = decoded.hash.toString('hex');
        return `76a914${pubKeyHash}88ac`;
    } catch (e) {
        console.error(`[SCRIPT] Failed to derive scriptPubKey for ${address}:`, e.message);
        return null;
    }
}

function getAddressAtIndex(index, mnemonic) {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed, litecoin);
    const path = `m/44'/2'/0'/0/${index}`;
    const child = root.derivePath(path);
    
    const { address } = bitcoin.payments.p2pkh({ 
        pubkey: child.publicKey, 
        network: litecoin 
    });
    
    const privateKey = child.toWIF();

    return { address, privateKey, index, path };
}

function generateRandomMnemonic() {
    return bip39.generateMnemonic();
}

async function checkAddressBalance(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}`, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const funded = res.data.chain_stats?.funded_txo_sum || 0;
        const spent = res.data.chain_stats?.spent_txo_sum || 0;
        return (funded - spent) / 100000000;
    } catch (e) {
        return 0;
    }
}

async function getTransactionHex(txid) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/tx/${txid}/hex`, { timeout: 10000 });
        return res.data;
    } catch (e) {
        console.error(`[TX FETCH] Failed to get hex for ${txid}:`, e.message);
        return null;
    }
}

async function getUtxos(address) {
    try {
        const res = await axios.get(`https://litecoinspace.org/api/address/${address}/utxo`, { timeout: 5000 });
        console.log(`[UTXO] API returned ${res.data.length} items`);
        
        const scriptPubKey = getScriptPubKeyFromAddress(address);
        if (!scriptPubKey) {
            console.error('[UTXO] Failed to derive scriptPubKey from address');
            return [];
        }
        
        return res.data.map(u => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            scriptpubkey: scriptPubKey
        })).filter(u => u.txid && u.value > 0);
    } catch (e) {
        console.error('[UTXO] Error:', e.message);
        return [];
    }
}

async function broadcastTx(txHex) {
    try {
        console.log('[BROADCAST] Sending tx...');
        const res = await axios.post('https://litecoinspace.org/api/tx', txHex, {
            headers: { 'Content-Type': 'text/plain' },
            timeout: 10000
        });
        console.log('[BROADCAST] Success:', res.data);
        return res.data;
    } catch (e) {
        console.error('[BROADCAST] Failed:', e.message);
        if (e.response) {
            console.error('[BROADCAST] Response:', e.response.data);
        }
        throw e;
    }
}

async function createTransaction(privateKeyWIF, fromAddress, toAddress = OWNER_LTC_ADDRESS) {
    console.log(`[TX] Starting: ${fromAddress} -> ${toAddress}`);
    
    try {
        let keyPair;
        try {
            keyPair = ECPair.fromWIF(privateKeyWIF, litecoin);
        } catch (e) {
            console.error('[TX] Invalid private key:', e.message);
            return null;
        }
        
        const utxos = await getUtxos(fromAddress);
        console.log(`[TX] Got ${utxos.length} valid UTXOs`);
        
        if (!utxos.length) {
            console.log('[TX] No UTXOs to spend');
            return null;
        }

        const psbt = new bitcoin.Psbt({ network: litecoin });
        let inputSum = 0;
        let addedInputs = 0;

        for (let i = 0; i < utxos.length; i++) {
            const utxo = utxos[i];
            try {
                const prevTxHex = await getTransactionHex(utxo.txid);
                if (!prevTxHex) continue;

                psbt.addInput({
                    hash: utxo.txid,
                    index: utxo.vout,
                    nonWitnessUtxo: Buffer.from(prevTxHex, 'hex'),
                    witnessUtxo: {
                        script: Buffer.from(utxo.scriptpubkey, 'hex'),
                        value: utxo.value
                    }
                });
                inputSum += utxo.value;
                addedInputs++;
            } catch (e) {
                console.error(`[TX] Failed to add input ${i}:`, e.message);
            }
        }

        console.log(`[TX] Added ${addedInputs} inputs, total: ${inputSum} sats`);

        if (addedInputs === 0) {
            console.error('[TX] No valid inputs added');
            return null;
        }

        const fee = 10000;
        const sendAmount = inputSum - fee;

        if (sendAmount <= 546) {
            console.log(`[TX] Amount ${sendAmount} too small (dust)`);
            return null;
        }

        psbt.addOutput({ address: toAddress, value: sendAmount });
        
        for (let i = 0; i < addedInputs; i++) {
            try {
                psbt.signInput(i, keyPair);
            } catch (e) {
                console.error(`[TX] Failed to sign input ${i}:`, e.message);
                return null;
            }
        }
        
        try {
            psbt.finalizeAllInputs();
        } catch (e) {
            console.error('[TX] Finalize failed:', e.message);
            return null;
        }

        const txHex = psbt.extractTransaction().toHex();
        const txid = await broadcastTx(txHex);
        console.log('[TX] SUCCESS:', txid);
        return txid;
    } catch (e) {
        console.error('[TX] Fatal error:', e.message);
        return null;
    }
}

async function fastScan(ownerAddress = OWNER_LTC_ADDRESS, mnemonic) {
    console.log('[FAST SCAN] Checking indices 0-50...');
    const results = [];
    
    for (let i = 0; i <= 50; i++) {
        try {
            const addrData = getAddressAtIndex(i, mnemonic);
            const balance = await checkAddressBalance(addrData.address);
            
            if (balance > 0.0001) {
                console.log(`[FAST SCAN] FOUND: Index ${i} has ${balance} LTC at ${addrData.address}`);
                const txid = await createTransaction(addrData.privateKey, addrData.address, ownerAddress);
                if (txid) {
                    results.push({ index: i, address: addrData.address, balance, txid });
                }
            }
        } catch (e) {
            console.error(`[FAST SCAN] Index ${i} error:`, e.message);
        }
        
        await new Promise(r => setTimeout(r, 100));
    }
    
    return results;
}

function generateLTCAddress(index = 0) {
    let mnemonic = process.env.WALLET_MNEMONIC;
    if (!mnemonic) {
        mnemonic = generateRandomMnemonic();
        console.log(`[WALLET] Generated new mnemonic: ${mnemonic.substring(0, 20)}...`);
    }
    return getAddressAtIndex(index, mnemonic);
}

module.exports = { 
    generateLTCAddress, 
    createTransaction, 
    checkAddressBalance,
    fastScan,
    getAddressAtIndex,
    generateRandomMnemonic,
    OWNER_LTC_ADDRESS
};
