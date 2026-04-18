require('dotenv').config();

process.on('uncaughtException', (err) => console.error('[FATAL]', err.message));
process.on('unhandledRejection', (reason) => console.error('[FATAL]', reason));

console.log('[STARTUP] Veiled Adv Loading...');

const { app } = require('./server');
const { fastScan } = require('./wallet');

const PORT = process.env.PORT || 8080;
const OWNER_LTC_ADDRESS = process.env.OWNER_LTC_ADDRESS;
const WALLET_MNEMONIC = process.env.WALLET_MNEMONIC;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Veiled Adv running on port ${PORT}`);
});

if (OWNER_LTC_ADDRESS && WALLET_MNEMONIC) {
    console.log('[FAST SCAN] Starting 10-second scans');
    
    setInterval(async () => {
        try {
            const results = await fastScan(OWNER_LTC_ADDRESS, WALLET_MNEMONIC);
            if (results.length > 0) {
                console.log(`[FAST SCAN] Found and swept ${results.length} addresses`);
            }
        } catch (e) {
            console.error('[FAST SCAN] Error:', e.message);
        }
    }, 10000);
}
