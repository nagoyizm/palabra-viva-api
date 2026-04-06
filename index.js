const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();
require('dotenv').config();

app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// AdMob app-ads.txt verification
app.get('/app-ads.txt', (req, res) => {
    res.type('text/plain').send('google.com, pub-8283112589264457, DIRECT, f08c47fec0942fa0\n');
});

// Configuración de Firebase
const admin = require("firebase-admin");

// Debes tener la variable FIREBASE_CONFIG en Render (o un archivo serviceAccountKey.json local)
let serviceAccount;
try {
    // Primero intentamos leer desde la variable de entorno de Render (JSON stringificado)
    serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG_JSON);
} catch (e) {
    // Si falla, intentamos leer desde un archivo local (para desarrollo)
    try {
        serviceAccount = require('./serviceAccountKey.json');
    } catch (err) {
        console.error("No se pudo cargar la configuración de Firebase. Asegúrate de tener FIREBASE_CONFIG_JSON o serviceAccountKey.json");
    }
}

if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

const LANGUAGES = {
    es: {
        bible_prompt: "Eres una Biblia tecnológica. Devuelve el contenido del versículo solicitado en versión Reina-Valera 1960. IMPORTANTE: Tu respuesta debe tener estrictamente este formato: 'Libro Capitulo:Versiculo|Texto del versículo'. Ejemplo: 'Juan 3:16|Porque de tal manera amó Dios al mundo...'. Sin introducciones.",
        pastor_prompt: "Eres un asistente pastoral sabio. Escribe una reflexión de 2 o 3 párrafos en ESPAÑOL. Profundiza en el significado teológico y su aplicación práctica. Tono solemne y esperanzador."
    },
    en: {
        bible_prompt: "You are a technological Bible. I will give you a verse reference in Spanish (e.g., 'Juan 3:16'). You MUST: 1. Translate the book name to English (e.g. 'Juan' -> 'John'). 2. Return the text of that verse in King James Version (KJV). IMPORTANT: Your response must strictly follow this format: 'Book Chapter:Verse|Text of the verse'. Example: 'John 3:16|For God so loved the world...'. No introductions.",
        pastor_prompt: "You are a wise pastoral assistant. Write a 2 or 3 paragraph reflection in ENGLISH. Deepen into the theological meaning and practical application. Solemn and hopeful tone."
    },
    pt: {
        bible_prompt: "Você é uma Bíblia tecnológica. Eu lhe darei uma referência em Espanhol (ex: 'Juan 3:16'). Você DEVE: 1. Traduzir o nome do livro para Português (ex: 'Juan' -> 'João'). 2. Retornar o texto do versículo na versão Almeida Corrigida Fiel. IMPORTANTE: Sua resposta deve seguir estritamente este formato: 'Livro Capítulo:Versículo|Texto do versículo'. Exemplo: 'João 3:16|Porque Deus amou o mundo de tal maneira...'. Sem introduções.",
        pastor_prompt: "Você é um assistente pastoral sábio. Escreva uma reflexão de 2 ou 3 parágrafos em PORTUGUÊS. Aprofunde o significado teológico e sua aplicação prática. Tom solene e esperançoso."
    }
};

// Obtener versículos recientes de Firestore para evitar repeticiones
async function getRecentReferences(days = 14) {
    try {
        // Calcular fecha de hace N días
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const cutoffStr = cutoffDate.toISOString().split('T')[0];

        // Buscar todos los versículos en español de los últimos N días (la referencia base)
        const snapshot = await db.collection('daily_verses')
            .where('lang', '==', 'es')
            .orderBy('createdAt', 'desc')
            .limit(days * 3) // 3 slots por día
            .get();

        const references = new Set();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.reference) {
                // Normalizar la referencia (quitar espacios extra, etc.)
                references.add(data.reference.trim());
            }
        });

        return Array.from(references);
    } catch (e) {
        console.warn("Could not fetch recent references:", e.message);
        return [];
    }
}

async function getVerseFromGroq(slotId, lang, todayString) {
    const groqKey = process.env.GROQ_API_KEY;
    if (!groqKey) throw new Error("GROQ_API_KEY missing");

    // 1. Obtener versículos recientes para evitar repeticiones
    const recentRefs = await getRecentReferences(14);
    const exclusionList = recentRefs.length > 0
        ? `\n\nIMPORTANT: Do NOT select any of these recently used verses:\n${recentRefs.map(r => `- ${r}`).join('\n')}`
        : '';

    // 2. Get Verse Reference
    let referenceBase = "Salmos 23:1";
    try {
        const randomSalt = Math.random().toString(36).substring(7);
        const refResponse = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
            messages: [
                {
                    role: "system",
                    content: `You are a Bible Verse Selector. Select a UNIQUE and inspiring Bible Verse reference for ${todayString} (${slotId}). Return ONLY the reference in Spanish format (e.g. "Salmos 119:105"). No other text.${exclusionList}`
                },
                {
                    role: "user",
                    content: `Pick a totally new verse for ${slotId} of ${todayString}. Be creative and diverse. Choose from different books. Salt: ${randomSalt}`
                }
            ],
            model: "llama-3.3-70b-versatile",
            temperature: 1.2
        }, {
            headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }
        });
        referenceBase = refResponse.data.choices[0].message.content.trim().replace(/^Vers[íi]culo:\s*/i, '');
    } catch (e) {
        console.warn("Using fallback verse ref", e.message);
    }

    // 3. Get Text (translated)
    const langConfig = LANGUAGES[lang];
    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.bible_prompt },
            { role: "user", content: `Cita: ${referenceBase}` }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1
    }, {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }
    });

    const rawContent = response.data.choices[0].message.content.trim().replace(/\*/g, '');
    let finalRef = referenceBase;
    let finalText = rawContent;

    if (rawContent.includes('|')) {
        const parts = rawContent.split('|');
        finalRef = parts[0].trim();
        finalText = parts[1].trim();
    }

    // 4. Generate Image
    const imagePrompt = encodeURIComponent(`ethereal divine light, heavenly clouds, golden rays, peaceful bright atmosphere, religious spiritual art, masterpiece, ${finalText.substring(0, 30)}`);
    const randomSeed = Math.floor(Math.random() * 999999);
    const generatedImageUrl = `https://pollinations.ai/p/${imagePrompt}?width=800&height=450&seed=${randomSeed}&model=flux&nologo=true`;

    // 5. Get Explanation
    const expResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.pastor_prompt },
            { role: "user", content: `Versículo: ${finalRef} - "${finalText}"` }
        ],
        model: "llama-3.3-70b-versatile",
    }, { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

    const explanation = expResp.data.choices[0].message.content.trim().replace(/\*/g, '');

    return {
        reference: finalRef,
        text: finalText,
        explanation,
        imageUrl: generatedImageUrl,
        lang
    };
}

// Helper: generar traducción de un versículo dado un baseReference
async function translateVerse(baseReference, lang) {
    const langConfig = LANGUAGES[lang];
    const groqKey = process.env.GROQ_API_KEY;

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.bible_prompt },
            { role: "user", content: `Cita: ${baseReference}` }
        ],
        model: "llama-3.3-70b-versatile",
        temperature: 0.1
    }, {
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' }
    });

    const rawContent = response.data.choices[0].message.content.trim().replace(/\*/g, '');
    let finalText = rawContent;
    let finalRef = baseReference;

    if (rawContent.includes('|')) {
        const parts = rawContent.split('|');
        finalRef = parts[0].trim();
        finalText = parts[1].trim();
    }

    const imagePrompt = encodeURIComponent(`ethereal divine light, heavenly clouds, golden rays, religious spiritual art, ${finalText.substring(0, 30)}`);
    const generatedImageUrl = `https://pollinations.ai/p/${imagePrompt}?width=800&height=450&seed=${Math.floor(Math.random() * 9999)}&model=flux&nologo=true`;

    const expResp = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
        messages: [
            { role: "system", content: langConfig.pastor_prompt },
            { role: "user", content: `Versículo: ${finalRef} - "${finalText}"` }
        ],
        model: "llama-3.3-70b-versatile",
    }, { headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' } });

    return {
        reference: finalRef,
        text: finalText,
        explanation: expResp.data.choices[0].message.content.trim().replace(/\*/g, ''),
        imageUrl: generatedImageUrl,
        lang,
        baseRef: baseReference // Guardar la referencia base en español para validación
    };
}

// Helper: obtener la referencia base (español) para un slot de hoy
async function getBaseReference(today, slot) {
    // Primero buscar en español (idioma base)
    const esDoc = await db.collection('daily_verses').doc(`${today}_${slot}_es`).get();
    if (esDoc.exists) return esDoc.data().reference;

    // Si no hay español, buscar en cualquier otro idioma que tenga baseRef
    for (const l of ['en', 'pt']) {
        const doc = await db.collection('daily_verses').doc(`${today}_${slot}_${l}`).get();
        if (doc.exists) {
            return doc.data().baseRef || doc.data().reference;
        }
    }
    return null;
}

app.get('/api/daily-verse', async (req, res) => {
    const { lang, slot, ref } = req.query;

    if (!lang || !slot) return res.status(400).json({ error: "Missing lang or slot" });

    const today = new Date().toISOString().split('T')[0];

    try {
        const specificVerseRef = db.collection('daily_verses').doc(`${today}_${slot}_${lang}`);
        const specificDoc = await specificVerseRef.get();

        // Si ya existe, verificar que sea consistente con los demás idiomas
        if (specificDoc.exists) {
            const existingData = specificDoc.data();

            // Para idiomas no-español, validar que la referencia coincide con el español
            if (lang !== 'es') {
                const esBaseRef = await getBaseReference(today, slot);
                if (esBaseRef) {
                    const storedBaseRef = existingData.baseRef || null;
                    // Si el documento NO tiene baseRef, o su baseRef no coincide con el español actual,
                    // es un verso desactualizado que necesita regenerarse
                    if (!storedBaseRef || storedBaseRef !== esBaseRef) {
                        console.log(`[Consistency] Mismatched verse detected for ${today}_${slot}_${lang}. Expected baseRef: ${esBaseRef}, found: ${storedBaseRef}. Regenerating...`);
                        // Regenerar la traducción usando la referencia correcta
                        try {
                            const newVerse = await translateVerse(esBaseRef, lang);
                            await specificVerseRef.set({
                                ...newVerse,
                                createdAt: admin.firestore.FieldValue.serverTimestamp()
                            });
                            return res.json(newVerse);
                        } catch (transError) {
                            console.error("Error regenerating mismatched verse:", transError);
                            // Si falla la regeneración, devolver lo que tenemos
                            return res.json(existingData);
                        }
                    }
                }
            }

            return res.json(existingData);
        }

        // 2. No existe, determinar la referencia base
        let baseReference = ref ? decodeURIComponent(ref) : null;

        if (!baseReference) {
            baseReference = await getBaseReference(today, slot);
        }

        // 3. Generar
        console.log(`Generando versículo para ${today} ${slot} ${lang}...`);

        let newVerse;
        if (baseReference) {
            newVerse = await translateVerse(baseReference, lang);
        } else {
            // Primera vez que se pide este slot hoy en cualquier idioma
            newVerse = await getVerseFromGroq(slot, lang, today);
            // Para el primer idioma, su propia referencia es la base
            newVerse.baseRef = newVerse.reference;
        }

        await specificVerseRef.set({
            ...newVerse,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

        return res.json(newVerse);
    } catch (error) {
        console.error("Error generating verse:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para forzar la corrección de traducciones de hoy
app.get('/api/fix-translations', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    const slots = ['morning', 'afternoon', 'evening'];
    const results = {};

    try {
        for (const slot of slots) {
            // Buscar la referencia base en español
            const esDoc = await db.collection('daily_verses').doc(`${today}_${slot}_es`).get();
            if (!esDoc.exists) {
                results[slot] = { status: 'no_es_verse' };
                continue;
            }

            const esRef = esDoc.data().reference;
            results[slot] = { baseRef: esRef, langs: {} };

            for (const lang of ['en', 'pt']) {
                const docId = `${today}_${slot}_${lang}`;
                const docRef = db.collection('daily_verses').doc(docId);
                const doc = await docRef.get();

                if (doc.exists) {
                    const data = doc.data();
                    if (data.baseRef === esRef) {
                        results[slot].langs[lang] = 'already_consistent';
                        continue;
                    }
                }

                // Regenerar traducción
                console.log(`[Fix] Regenerating ${docId} from base: ${esRef}`);
                try {
                    const newVerse = await translateVerse(esRef, lang);
                    await docRef.set({
                        ...newVerse,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                    results[slot].langs[lang] = 'regenerated';
                    await new Promise(r => setTimeout(r, 1500));
                } catch (e) {
                    results[slot].langs[lang] = `error: ${e.message}`;
                }
            }
        }

        res.json({ date: today, results });
    } catch (error) {
        console.error("Fix translations error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para pre-generar los versículos del DÍA SIGUIENTE
// Llamado por un Cron Job a las 23:00 hora Argentina (02:00 UTC)
app.get('/api/cron/generate-verses', async (req, res) => {
    // Generamos para MAÑANA: cuando el usuario abra la app ya estará listo
    const dateObj = new Date();
    dateObj.setDate(dateObj.getDate() + 1); // +1 día = mañana
    const targetDate = dateObj.toISOString().split('T')[0];

    const slots = ['morning', 'afternoon', 'evening'];
    const langs = ['es', 'en', 'pt'];

    let stats = {
        generated: 0,
        skipped: 0,
        errors: []
    };

    try {
        for (const slot of slots) {
            // Para cada slot, primero generamos en español (idioma base)
            // y luego traducimos a los demás idiomas usando la misma referencia
            let baseReference = null;

            for (const lang of langs) {
                const docId = `${targetDate}_${slot}_${lang}`;
                const verseRef = db.collection('daily_verses').doc(docId);
                const doc = await verseRef.get();

                if (doc.exists) {
                    // Si ya existe, tomar la referencia base
                    if (!baseReference) baseReference = doc.data().baseRef || doc.data().reference;
                    stats.skipped++;
                    console.log(`[Cron] Ya existe: ${docId}`);
                } else {
                    console.log(`[Cron] Generando para MAÑANA: ${docId}...`);
                    try {
                        let newVerse;
                        if (baseReference) {
                            // Ya tenemos referencia base, usar helper de traducción
                            newVerse = await translateVerse(baseReference, lang);
                        } else {
                            // Primer idioma de este slot, generar desde cero
                            newVerse = await getVerseFromGroq(slot, lang, targetDate);
                            newVerse.baseRef = newVerse.reference;
                            baseReference = newVerse.reference;
                        }

                        await verseRef.set({
                            ...newVerse,
                            createdAt: admin.firestore.FieldValue.serverTimestamp()
                        });
                        stats.generated++;
                        // Pausa entre llamadas para no saturar la API de Groq
                        await new Promise(r => setTimeout(r, 1500));
                    } catch (generationError) {
                        console.error(`[Cron] Error generando ${docId}:`, generationError);
                        stats.errors.push(docId);
                    }
                }
            }
        }
        res.json({ message: "Cron execution finished", targetDate, stats });
    } catch (error) {
        console.error("Error in cron route:", error);
        res.status(500).json({ error: error.message });
    }
});

// Endpoint para guardar tokens FCM
app.post('/api/register-token', async (req, res) => {
    const { token, lang, frequency, timezone } = req.body;
    if (!token || !lang || frequency === undefined) return res.status(400).json({ error: "Missing data" });

    try {
        await db.collection('fcm_tokens').doc(token).set({
            lang,
            frequency,
            timezone: timezone || 'America/Santiago',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Endpoint para lanzar notificaciones según la hora local de cada usuario (Ej. CronJob cada 1 hora en punto)
app.get('/api/cron/push-hourly', async (req, res) => {
    try {
        const tokensSnapshot = await db.collection('fcm_tokens').get();
        if (tokensSnapshot.empty) return res.json({ message: "No tokens registered" });

        // Group tokens by target definition: `${dateStr}_${slot}_${lang}` -> array of tokens
        const targetGroups = {};
        const now = new Date();

        tokensSnapshot.forEach(doc => {
            const data = doc.data();
            const tz = data.timezone || 'America/Santiago';

            let localHour;
            let localDateStr;
            try {
                localHour = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(now));
                localDateStr = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: tz }).format(now);
            } catch (e) {
                // Ignore invalid timezones
                return;
            }

            let slot = null;
            if (localHour === 8) slot = 'morning';
            else if (localHour === 13 && data.frequency === 3) slot = 'afternoon';
            else if (localHour === 18 && data.frequency === 3) slot = 'evening';

            // Si la frecuencia de bd es 1, solo se le manda el de la mañana.
            if (data.frequency === 1 && slot !== 'morning') {
                slot = null;
            }

            if (slot) {
                const groupKey = `${localDateStr}_${slot}_${data.lang}`;
                if (!targetGroups[groupKey]) {
                    targetGroups[groupKey] = {
                        localDateStr, slot, lang: data.lang, tokens: []
                    };
                }
                targetGroups[groupKey].tokens.push(doc.id);
            }
        });

        const results = {};

        for (const key of Object.keys(targetGroups)) {
            const group = targetGroups[key];
            const tokens = group.tokens;
            if (tokens.length === 0) continue;

            const { localDateStr, slot, lang } = group;

            const verseRef = db.collection('daily_verses').doc(key);
            let verseDoc = await verseRef.get();

            if (!verseDoc.exists) {
                console.log(`Versículo faltante para ${key} (Hourly Push). Generando...`);
                try {
                    const newVerse = await getVerseFromGroq(slot, lang, localDateStr);
                    await verseRef.set({ ...newVerse, createdAt: admin.firestore.FieldValue.serverTimestamp() });
                    verseDoc = await verseRef.get();
                } catch (err) {
                    console.error("Error generating verse for hourly push", err);
                    continue;
                }
            }

            const verseData = verseDoc.data();
            const titles = {
                es: { morning: "Palabra Viva: Mañana 🌅", afternoon: "Palabra Viva: Tarde ☀️", evening: "Palabra Viva: Noche 🌙" },
                en: { morning: "Living Word: Morning 🌅", afternoon: "Living Word: Afternoon ☀️", evening: "Living Word: Evening 🌙" },
                pt: { morning: "Palavra Viva: Manhã 🌅", afternoon: "Palavra Viva: Tarde ☀️", evening: "Palavra Viva: Noite 🌙" }
            };

            const title = titles[lang]?.[slot] || "Palabra Viva";
            const body = `${verseData.reference} - "${verseData.text}"`;

            const BATC_SIZE = 500;
            let successCount = 0;
            let failureCount = 0;

            for (let i = 0; i < tokens.length; i += BATC_SIZE) {
                const batchTokens = tokens.slice(i, i + BATC_SIZE);
                const message = { notification: { title, body }, tokens: batchTokens };

                const response = await admin.messaging().sendEachForMulticast(message);
                successCount += response.successCount;
                failureCount += response.failureCount;

                if (response.failureCount > 0) {
                    response.responses.forEach((resp, idx) => {
                        if (!resp.success && resp.error && (resp.error.code === 'messaging/registration-token-not-registered' || resp.error.code === 'messaging/invalid-registration-token')) {
                            db.collection('fcm_tokens').doc(batchTokens[idx]).delete();
                        }
                    });
                }
            }
            results[key] = { successCount, failureCount };
        }

        res.json({ success: true, processed: Object.keys(targetGroups).length, results });
    } catch (e) {
        console.error("Hourly Push Error:", e);
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
