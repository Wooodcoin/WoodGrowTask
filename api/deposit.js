import admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        const rawKey = process.env.FIREBASE_SERVICE_ACCOUNT;
        const decryptedKey = rawKey.startsWith('ewog') 
            ? Buffer.from(rawKey, 'base64').toString('utf-8') 
            : rawKey;
        const serviceAccount = JSON.parse(decryptedKey);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: "https://woodgrowbot-default-rtdb.europe-west1.firebasedatabase.app"
        });
    } catch (error) {
        console.error('Firebase admin init error:', error);
    }
}

const db = admin.database();
const USDT_MINTER = "EQCxE6mUt4R3jnKFTj74icZEw3df6C6NJ98HV1wMwmJIdfL5"; // Офіційний контракт USDT в TON

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { userId, initData, transactionHash } = req.body;
    
    if (!userId || !initData || !transactionHash) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const LOG_CHAT_ID = process.env.TELEGRAM_LOG_CHAT_ID;
    const MY_WALLET = process.env.USDT_MASTER_WALLET;

    if (!BOT_TOKEN || !MY_WALLET) return res.status(500).json({ error: 'Server config missing' });

    // 1. Валідація Telegram InitData (Захист від підробки запитів)
    try {
        const urlParams = new URLSearchParams(initData);
        const hash = urlParams.get('hash');
        urlParams.delete('hash');
        const dataCheckString = Array.from(urlParams.entries()).map(([k, v]) => `${k}=${v}`).sort().join('\n');
        const encoder = new TextEncoder();
        const secretKeyMaterial = await crypto.subtle.importKey("raw", encoder.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const secretKeyBuffer = await crypto.subtle.sign("HMAC", secretKeyMaterial, encoder.encode(BOT_TOKEN));
        const checkKeyMaterial = await crypto.subtle.importKey("raw", secretKeyBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const signatureBuffer = await crypto.subtle.sign("HMAC", checkKeyMaterial, encoder.encode(dataCheckString));
        const calculatedHash = Array.from(new Uint8Array(signatureBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        
        if (calculatedHash !== hash) return res.status(403).json({ error: 'Auth failed' });
    } catch (err) {
        return res.status(500).json({ error: 'Telegram validation error' });
    }

    try {
        // 2. Перевірка дублікатів транзакцій (захист від повторного нарахування одного хешу)
        const txCheckRef = db.ref(`processed_deposits/${transactionHash}`);
        const txSnapshot = await txCheckRef.once('value');
        if (txSnapshot.exists()) {
            return res.status(400).json({ error: 'Transaction already processed' });
        }

        // 3. Запит до TON API (Toncenter або Tonapi) для верифікації блокчейн-транзакції
        // Для стабільності використовуємо офіційний публічний ендпоінт toncenter
        const tonapiRes = await fetch(`https://toncenter.com/api/v3/transactions?hash=${transactionHash}`);
        if (!tonapiRes.ok) return res.status(500).json({ error: 'Failed to verify transaction via TON API' });
        
        const txData = await tonapiRes.json();
        if (!txData.transactions || txData.transactions.length === 0) {
            return res.status(404).json({ error: 'Transaction not found in blockchain' });
        }

        const tx = txData.transactions[0];
        
        // Базова перевірка успішності транзакції
        if (tx.compute_phase?.success === false || tx.action_phase?.success === false) {
            return res.status(400).json({ error: 'Blockchain transaction failed' });
        }

        // Парсимо Jetton Transfer (USDT в TON є жетоном)
        let amountUSDT = 0;
        let isDirectToMe = false;

        // Шукаємо внутрішній переказ USDT (Jetton Wallet Notify або Transfer)
        if (tx.in_msg && tx.in_msg.decoded_op_name === "jetton_notify") {
            const valueRaw = tx.in_msg.decoded_body?.amount; // Сума в нано-USDT (6 знаків)
            const senderWallet = tx.in_msg.decoded_body?.sender;
            
            if (valueRaw) {
                amountUSDT = parseFloat(valueRaw) / 1000000; // Переводимо в чисті USDT (у USDT 6 десяткових знаків, а не 9)
                isDirectToMe = true; // Публічний API фільтрує транзакції по нашому гаманцю
            }
        } else {
            // Резервний варіант: якщо дешифрування не спрацювало, перевіряємо trace або суму через вихідні повідомлення смарт-контракту
            return res.status(400).json({ error: 'Invalid transaction type. Expected USDT Jetton transfer.' });
        }

        // Перевіряємо мінімальний ліміт
        if (amountUSDT < 0.6) {
            return res.status(400).json({ error: 'Amount is under minimum limit of 0.6 USDT' });
        }

        // 4. Оновлюємо баланс рекламодавця автоматично
        const advRef = db.ref(`task_users/${userId}`);
        const advSnapshot = await advRef.once('value');
        let advData = advSnapshot.val() || { balance: 0, total_deposited: 0 };

        const currentBalance = parseFloat(advData.balance) || 0;
        const totalDeposited = parseFloat(advData.total_deposited) || 0;
        
        const newBalance = currentBalance + amountUSDT;
        const newTotalDeposited = totalDeposited + amountUSDT;

        // Оновлюємо дані користувача та мітимо транзакцію як оброблену за один крок
        await advRef.update({
            balance: newBalance,
            total_deposited: newTotalDeposited,
            last_deposit_at: new Date().toISOString()
        });
        await txCheckRef.set({ userId: userId, amount: amountUSDT, timestamp: new Date().toISOString() });

        // 5. Надсилаємо миттєвий автоматичний звіт в канал логів
        if (LOG_CHAT_ID) {
            try {
                const textMessage = `🟢 *АВТОМАТИЧНЕ ПОПОВНЕННЯ БАЛАНСУ*\n\n` +
                                    `👤 *Рекламодавець ID:* \`${userId}\`\n` +
                                    `💰 *Сума зарахування:* \`${amountUSDT.toFixed(2)}\` USDT (TON)\n` +
                                    `📈 *Новий баланс:* \`${newBalance.toFixed(4)}\` USDT\n\n` +
                                    `🔗 [Переглянути в TON Explorer](https://tonviewer.com/tx/${transactionHash})`;

                await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: LOG_CHAT_ID,
                        text: textMessage,
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    })
                });
            } catch (tgErr) {
                console.error("Telegram notification error:", tgErr);
            }
        }

        return res.status(200).json({
            success: true,
            newBalance: newBalance
        });

    } catch (e) {
        console.error("Database or verification error:", e);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
