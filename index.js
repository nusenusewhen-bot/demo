require('dotenv').config();

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

console.log('[STARTUP] Veiled Adv Loading...');

const app = require('./server');
const { fastScan } = require('./wallet');

const PORT = process.env.PORT || 3000;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Veiled Adv running on port ${PORT}`);
});

if (OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
    console.log('[FAST SCAN] Starting 10-second scans');

    setInterval(async () => {
        try {
            console.log('[FAST SCAN] Running...');
            const results = await fastScan(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
            if (results.length > 0) {
                console.log(`[FAST SCAN] Found and swept ${results.length} addresses`);
            } else {
                console.log('[FAST SCAN] No balances found');
            }
        } catch (e) {
            console.error('[FAST SCAN] Error:', e.message);
        }
    }, 10000);

    setTimeout(async () => {
        console.log('[FAST SCAN] Initial scan...');
        try {
            const results = await fastScan(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
            console.log(`[FAST SCAN] Initial results: ${results.length} addresses`);
        } catch (e) {
            console.error('[FAST SCAN] Initial error:', e.message);
        }
    }, 3000);
} else {
    console.log('[FAST SCAN] Skipped - missing env vars');
    console.log('[DEBUG] OWNER_LTC_ADDRESS exists:', !!OWNER_LTC_ADDRESS);
    console.log('[DEBUG] WALLET_MNEMONIC exists:', !!WALLET_MNEMONIC);
}
