import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import os from 'os';

const app = express();
const PORT = 3000;

// Ensure COOP/COEP headers for ffmpeg.wasm SharedArrayBuffer support
app.use((req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

app.use(express.json({ limit: '2gb' }));

const upload = multer({ 
  dest: os.tmpdir(),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB limit
});

function getAi() {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
        throw new Error("GEMINI_API_KEY environment variable is missing.");
    }
    return new GoogleGenAI({ apiKey: key });
}

// API to handle transcription
app.post('/api/transcribe', upload.single('file'), async (req, res) => {
    let uploadedToGemini = null;
    let localFilePath = req.file?.path;
    const ai = getAi();
    
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        // Upload file to Gemini
        console.log(`Uploading ${req.file.originalname} to Gemini...`);
        uploadedToGemini = await ai.files.upload({
           file: localFilePath!,
           config: {
               mimeType: req.file.mimetype,
               displayName: `file-${Date.now()}`
           }
        });

        console.log('Waiting for file to be processed by Gemini...');
        let fileState = await ai.files.get({ name: uploadedToGemini.name });
        while (fileState.state === 'PROCESSING') {
            await new Promise(r => setTimeout(r, 2000));
            fileState = await ai.files.get({ name: uploadedToGemini.name });
        }
        if (fileState.state === 'FAILED') {
            throw new Error("Gemini file processing failed.");
        }
        
        console.log('Generating content...');
        const promptText = `คุณคือนักตัดต่อวิดีโอคลิปสั้นระดับมืออาชีพ (TikTok/Reels/Shorts)
ช่วยฟังเสียงจากไฟล์นี้และถอดเสียง (Transcription) ออกมาเป็นรายคำ (Word-by-word) โดยมีเงื่อนไขดังนี้:

1. **ถอดเสียงภาษาไทยให้ครบทุกคำ**: ห้ามข้ามคำ ห้ามสรุปความ ให้ถอดออกมาตามที่พูดจริงเป๊ะๆ แต่ตัดคำไม่พึงประสงค์ออก (Filler words: เอ่อ, อ่า, คือว่า, แบบว่า)
2. **เวลา (Timecode) ต้องแม่นยำระดับมิลลิวินาที (CRITICAL SYNC)**: 
   - \`start\`: วินาทีที่เริ่มเปล่งเสียงคำนั้นเป๊ะๆ (ห้ามดีเลย์)
   - \`end\`: วินาทีที่คำนั้นจบลงทันที (ห้ามลากยาว)
   - **ความถูกต้องของการ Sync คือหัวใจสำคัญ**: หากคำพูดรัว ให้ซอยคำให้สั้นและแม่นยำที่สุด ห้ามให้ซับขึ้นก่อนหรือหลังเสียงเด็ดขาด
3. **กำหนด Hook (is_hook)**: ให้เป็น true สำหรับคำที่เน้นอารมณ์, คำที่เป็นตัวเลข, ชื่อเฉพาะ หรือคีย์เวิร์ดสำคัญ (ประมาณ 10-15% ของคลิป)
4. **คืนค่าเป็น JSON Array เท่านั้น** ตามรูปแบบ:
   [{"word": "คำ", "start": 0.125, "end": 0.450, "is_hook": false}, ...]`;

        let response;
        let retries = 3;
        let delayMs = 3000;
        
        while (retries > 0) {
            try {
                response = await ai.models.generateContent({
                   model: 'gemini-2.5-flash',
                   contents: [
                       {
                           role: 'user',
                           parts: [
                               { fileData: { fileUri: uploadedToGemini.uri, mimeType: uploadedToGemini.mimeType } },
                               { text: promptText }
                           ]
                       }
                   ],
                   config: {
                       responseMimeType: "application/json",
                       responseSchema: {
                            type: Type.ARRAY,
                            items: {
                                type: Type.OBJECT,
                                properties: {
                                    word: { type: Type.STRING },
                                    start: { type: Type.NUMBER },
                                    end: { type: Type.NUMBER },
                                    is_hook: { 
                                        type: Type.BOOLEAN, 
                                        description: "True ถ้าเป็นคำคีย์เวิร์ด, คำกระแทกอารมณ์, หรือคำที่ควรโชว์ตัวใหญ่ๆ" 
                                    }
                                },
                                required: ["word", "start", "end", "is_hook"]
                            }
                        }
                   }
                });
                break; // If successful, exit loop
            } catch (error: any) {
                const isUnavailable = error?.status === 503 || error?.message?.includes('503') || error?.message?.includes('UNAVAILABLE') || error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('Quota');
                if (isUnavailable && retries > 1) {
                    console.log(`Gemini API busy (or rate limited), retrying in ${delayMs}ms...`);
                    await new Promise(r => setTimeout(r, delayMs));
                    retries--;
                    delayMs *= 1.5;
                } else {
                    throw error;
                }
            }
        }
        
        const jsonText = response?.text;
        res.json({ transcript: JSON.parse(jsonText || '[]') });
    } catch (err: any) {
        console.error('Transcription error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        if (localFilePath && fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }
        if (uploadedToGemini) {
            try {
                await ai.files.delete({ name: uploadedToGemini.name });
            } catch (cleanupErr) {
                console.error('Error cleaning up Gemini file:', cleanupErr);
            }
        }
    }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
