import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as Mp4Muxer from 'mp4-muxer';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

type TranscriptWord = {
    word: string;
    start: number;
    end: number;
    is_hook: boolean;
};

type Group = {
    words: TranscriptWord[];
    start: number;
    end: number;
    isHookGroup?: boolean;
};

export default function App() {
    const [file, setFile] = useState<File | null>(null);
    const [videoSrc, setVideoSrc] = useState<string>('');
    const [template, setTemplate] = useState<string>('tpl-default');
    const [highlightColor, setHighlightColor] = useState<string>('#FFFF00');
    const [wordCount, setWordCount] = useState<number>(3);
    const [transcriptData, setTranscriptData] = useState<TranscriptWord[]>([]);
    
    const [status, setStatus] = useState<{ text: string; type: 'info' | 'success' | 'error'; progress?: number } | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    
    const [currentTime, setCurrentTime] = useState(0);

    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            setFile(file);
            setVideoSrc(URL.createObjectURL(file));
            setTranscriptData([]);
            setStatus({ text: 'อัปโหลดไฟล์พร้อมแล้ว กดปุ่มประมวลผลได้เลย', type: 'success' });
        }
    };

    const currentGroups = useMemo(() => {
        if (!transcriptData || transcriptData.length === 0) return [];
        const groups: Group[] = [];
        let currentGroup: TranscriptWord[] = [];

        for (let i = 0; i < transcriptData.length; i++) {
            const item = transcriptData[i];
            if (item.is_hook) {
                if (currentGroup.length > 0) {
                    groups.push({ words: currentGroup, start: currentGroup[0].start, end: currentGroup[currentGroup.length - 1].end });
                    currentGroup = [];
                }
                groups.push({ words: [item], start: item.start, end: item.end, isHookGroup: true });
            } else {
                currentGroup.push(item);
                if (currentGroup.length >= wordCount) {
                    groups.push({ words: currentGroup, start: currentGroup[0].start, end: currentGroup[currentGroup.length - 1].end });
                    currentGroup = [];
                }
            }
        }
        if (currentGroup.length > 0) {
            groups.push({ words: currentGroup, start: currentGroup[0].start, end: currentGroup[currentGroup.length - 1].end });
        }
        return groups;
    }, [transcriptData, wordCount]);

    const activeGroup = useMemo(() => {
        const index = currentGroups.findIndex((g, i) => {
            const nextStart = currentGroups[i+1]?.start ?? g.end + 0.5;
            return currentTime >= g.start && currentTime < nextStart;
        });
        return index !== -1 ? currentGroups[index] : undefined;
    }, [currentGroups, currentTime]);

    const handleProcess = async () => {
        if (!file) {
            setStatus({ text: 'กรุณาเลือกไฟล์ก่อนค่ะ!', type: 'error' });
            return;
        }
        if (file.size > 50 * 1024 * 1024) {
            setStatus({ text: 'ขนาดไฟล์ใหญ่เกินไปสำหรับระบบทดสอบ (จำกัด 50MB)', type: 'error' });
            return;
        }

        setIsProcessing(true);
        setStatus({ text: 'ระบบกำลังถอดเสียง และวิเคราะห์คำดึงดูดสายตา... (อาจใช้เวลาสักครู่)', type: 'info' });

        try {
            const formData = new FormData();
            formData.append('file', file);

            const res = await fetch('/api/transcribe', {
                method: 'POST',
                body: formData,
            });

            if (!res.ok) {
                const errData = await res.json();
                throw new Error(errData.error || `Error ${res.status}`);
            }

            const data = await res.json();
            if (data.transcript) {
                setTranscriptData(data.transcript);
                setStatus({ text: '✨ ประมวลผลสำเร็จ! AI หาคำ Hook ให้แล้ว เช็คด้านล่างได้เลย', type: 'success' });
                if (videoRef.current) {
                    videoRef.current.play().catch(e => console.log("Autoplay blocked:", e));
                }
            } else {
                throw new Error("ไม่มีข้อมูลส่งกลับมาจาก AI");
            }
        } catch (err: any) {
            console.error(err);
            setStatus({ text: err.message || 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้งค่ะ', type: 'error' });
        } finally {
            setIsProcessing(false);
        }
    };

    const handleDownloadSrt = () => {
        if (currentGroups.length === 0) return;
        let srtContent = '';
        currentGroups.forEach((group, index) => {
            const date = new Date(group.start * 1000);
            const st = `${String(Math.floor(group.start/3600)).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}:${String(date.getUTCSeconds()).padStart(2,'0')},${String(date.getUTCMilliseconds()).padStart(3,'0')}`;
            const dateE = new Date(group.end * 1000);
            const et = `${String(Math.floor(group.end/3600)).padStart(2,'0')}:${String(dateE.getUTCMinutes()).padStart(2,'0')}:${String(dateE.getUTCSeconds()).padStart(2,'0')},${String(dateE.getUTCMilliseconds()).padStart(3,'0')}`;
            srtContent += `${index + 1}\n${st} --> ${et}\n${group.words.map(w => w.word).join('')}\n\n`;
        });
        const blob = new Blob([srtContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); 
        a.href = url; 
        a.download = `auto_caption.srt`;
        document.body.appendChild(a); 
        a.click(); 
        document.body.removeChild(a); 
        URL.revokeObjectURL(url);
    };

    const handleDownloadVideo = async () => {
        if (currentGroups.length === 0 || !file) return;
        if (!('VideoEncoder' in window)) {
            setStatus({ text: 'เบราว์เซอร์ไม่รองรับ WebCodecs', type: 'error' });
            return;
        }

        setIsExporting(true);
        setStatus({ text: '🚀 กำลังเปลี่ยนเฟรมและเรนเดอร์ภาพ...', type: 'info' });

        try {
            const muxer = new Mp4Muxer.Muxer({
                target: new Mp4Muxer.ArrayBufferTarget(),
                video: { codec: 'avc', width: videoRef.current?.videoWidth || 1080, height: videoRef.current?.videoHeight || 1920 },
                fastStart: 'in-memory',
                firstTimestampBehavior: 'offset'
            });

            const videoEncoder = new window.VideoEncoder({
                output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as any),
                error: (e: any) => console.error(e)
            });
            
            videoEncoder.configure({ 
                codec: 'avc1.4d002a', 
                width: videoRef.current?.videoWidth || 1080, 
                height: videoRef.current?.videoHeight || 1920, 
                bitrate: 15_000_000, // 15 Mbps for highest quality near original
                framerate: 30, 
                hardwareAcceleration: 'prefer-hardware' 
            });

            const canvas = document.createElement('canvas'); 
            canvas.width = videoRef.current?.videoWidth || 1080; 
            canvas.height = videoRef.current?.videoHeight || 1920;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error("Could not get 2d context for canvas");

            let fontFamily = template === 'tpl-hormozi' ? 'Prompt' : 'Kanit';
            let fontWeight = template === 'tpl-hormozi' || template === 'tpl-beast' ? '800' : '600';
            const isUppercase = template !== 'tpl-default';

            const renderVideo = document.createElement('video'); 
            renderVideo.src = URL.createObjectURL(file); 
            renderVideo.muted = true;
            renderVideo.playsInline = true;
            await new Promise<void>(r => { renderVideo.onloadedmetadata = () => r(); });

            const fps = 30; 
            const frameDuration = Math.round((1 / fps) * 1e6);

            const processFrames = () => {
                return new Promise<void>((resolve, reject) => {
                    let isResolved = false;
                    
                    const onFrame: VideoFrameRequestCallback = (now, metadata) => {
                        if (isResolved) return;
                        const time = metadata.mediaTime;
                        ctx.drawImage(renderVideo, 0, 0, canvas.width, canvas.height);

                        const groupIndex = currentGroups.findIndex((g, i) => {
                            const nextStart = currentGroups[i+1]?.start ?? g.end + 0.5;
                            return time >= g.start && time < nextStart;
                        });
                        const group = groupIndex !== -1 ? currentGroups[groupIndex] : undefined;

                        if (group) {
                            ctx.textAlign = "center"; 
                            ctx.textBaseline = "bottom";
                            let yPos = canvas.height * 0.85;

                            const baseFontSize = canvas.width * (template === 'tpl-hormozi' ? 0.065 : 0.06); 
                            
                            let totalWidth = 0;

                            const activeWordIndex = group.words.findIndex((w, i) => {
                                const nextStart = group.words[i+1]?.start ?? group.end + 0.5;
                                return time >= w.start && time < nextStart;
                            });

                            const wordsMeta = group.words.map((w, i) => {
                                const isActive = activeWordIndex !== -1 ? i === activeWordIndex : (time >= w.start && time <= w.end);
                                let scale = 1.0;
                                if(isActive) {
                                    if(w.is_hook) scale = 2.2;
                                    else if (template === 'tpl-hormozi') scale = 1.15;
                                    else scale = 1.1;
                                }
                                
                                const fontSize = baseFontSize * scale;
                                ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
                                
                                const text = isUppercase ? w.word.toUpperCase() : w.word;
                                const width = ctx.measureText(text).width;
                                const margin = baseFontSize * 0.2;
                                totalWidth += width + margin;
                                
                                return { text, width, isActive, isHook: w.is_hook, margin, fontSize };
                            });

                            const maxWidth = canvas.width * 0.85; // 85% for TikTok/Reels safe zone
                            let globalScale = 1;
                            if (totalWidth > maxWidth) {
                                globalScale = maxWidth / totalWidth;
                                totalWidth = maxWidth;
                            }

                            let currentX = (canvas.width / 2) - (totalWidth / 2);
                            
                            wordsMeta.forEach(meta => {
                                const finalFontSize = meta.fontSize * globalScale;
                                const finalWidth = meta.width * globalScale;
                                const finalMargin = meta.margin * globalScale;

                                ctx.font = `${fontWeight} ${finalFontSize}px "${fontFamily}", sans-serif`;
                                
                                ctx.save();
                                let drawYPos = yPos;
                                if(meta.isActive && meta.isHook) {
                                    drawYPos -= (canvas.height * 0.02);
                                }

                                ctx.translate(currentX + (finalWidth / 2), drawYPos);
                                
                                if (meta.isActive && template === 'tpl-hormozi') ctx.rotate(-2 * Math.PI / 180);
                                if (meta.isActive && meta.isHook && template === 'tpl-hormozi') ctx.rotate(-4 * Math.PI / 180);
                                
                                ctx.lineJoin = "round";

                                if (meta.isActive) {
                                    ctx.fillStyle = template === 'tpl-hormozi' && meta.isHook ? "#fff" : highlightColor;
                                    ctx.shadowColor = 'rgba(0,0,0,0.6)';
                                    ctx.shadowBlur = 8;
                                    ctx.shadowOffsetX = 2;
                                    ctx.shadowOffsetY = 2;
                                } else {
                                    ctx.fillStyle = "white"; 
                                    ctx.shadowColor = 'rgba(0,0,0,0.4)';
                                    ctx.shadowBlur = 4;
                                    ctx.shadowOffsetX = 1;
                                    ctx.shadowOffsetY = 1;
                                }
                                ctx.fillText(meta.text, 0, 0);
                                ctx.restore();
                                
                                currentX += finalWidth + finalMargin;
                            });
                        }

                        const frame = new window.VideoFrame(canvas, { 
                            timestamp: Math.round(time * 1e6),
                            duration: frameDuration
                        }); 
                        videoEncoder.encode(frame); 
                        frame.close();
                        
                        const progressPercentage = (time / renderVideo.duration) * 100;
                        setStatus({ 
                            text: `⏳ อัปเกรดความเร็ว เรนเดอร์ไปแล้ว ${progressPercentage.toFixed(0)}% ไม่ต้องรอสลับฉาก!`, 
                            type: 'info',
                            progress: progressPercentage
                        });

                        if (!renderVideo.ended && time < renderVideo.duration) {
                            renderVideo.requestVideoFrameCallback(onFrame);
                        } else {
                            if (!isResolved) {
                                isResolved = true;
                                resolve();
                            }
                        }
                    };

                    renderVideo.playbackRate = 1.0;
                    renderVideo.play().then(() => {
                        renderVideo.requestVideoFrameCallback(onFrame);
                    }).catch(reject);
                    
                    renderVideo.onended = () => {
                        if (!isResolved) {
                            isResolved = true;
                            resolve();
                        }
                    };
                });
            };

            await processFrames();

            renderVideo.remove();

            await videoEncoder.flush(); 
            muxer.finalize();
            const videoBuffer = muxer.target.buffer; 
            const videoBlob = new Blob([videoBuffer], { type: 'video/mp4' });

            setStatus({ text: '🎵 ภาพเสร็จแล้ว! กำลังรวมเสียงเข้าวิดีโอ (รอสักครู่)...', type: 'info' }); 
            
            const ffmpeg = new FFmpeg();
            
            ffmpeg.on('log', ({ message }) => {
                console.log('FFmpeg log:', message);
            });
            
            ffmpeg.on('progress', ({ progress, time }) => {
                const p = progress * 100;
                setStatus({ 
                    text: `🎵 กำลังรวมเสียงเข้าวิดีโอ... ${Math.round(Math.min(p, 100))}% เล็กน้อยอดใจรอครับ`, 
                    type: 'info',
                    progress: Math.min(p, 100)
                });
            });

            const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd';
            await ffmpeg.load({
                coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
                wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm')
            });

            await ffmpeg.writeFile('temp_video.mp4', await fetchFile(videoBlob));
            await ffmpeg.writeFile('source_media', await fetchFile(file));

            // Force robust audio extraction and conversion to avoid sticking
            const exitCode = await ffmpeg.exec([
                '-i', 'temp_video.mp4', 
                '-i', 'source_media', 
                '-c:v', 'copy', 
                '-c:a', 'aac', 
                '-b:a', '128k',
                '-map', '0:v:0', 
                '-map', '1:a:0?', 
                '-shortest', 
                'final_output.mp4'
            ]);
            
            if (exitCode !== 0) {
                throw new Error("FFmpeg failed to mix audio and video.");
            }

            const finalData = await ffmpeg.readFile('final_output.mp4');
            const finalBlob = new Blob([(finalData as Uint8Array).buffer], { type: 'video/mp4' });
            const url = URL.createObjectURL(finalBlob);
            const a = document.createElement('a'); 
            a.href = url; 
            a.download = `caption_pro_hook_${Date.now()}.mp4`;
            document.body.appendChild(a); 
            a.click(); 
            document.body.removeChild(a); 
            URL.revokeObjectURL(url);

            await ffmpeg.deleteFile('temp_video.mp4'); 
            await ffmpeg.deleteFile('source_media'); 
            await ffmpeg.deleteFile('final_output.mp4');
            
            setStatus({ text: '✨ บันทึกวิดีโอสำเร็จ!', type: 'success' });

        } catch (err: any) { 
            console.error(err); 
            setStatus({ text: 'Error: ' + err.message, type: 'error' }); 
        } finally { 
            setIsExporting(false); 
        }
    };

    return (
        <div className="min-h-screen p-4 md:p-8 flex flex-col lg:flex-row gap-8 justify-center items-start">
            {/* Control Panel */}
            <div className="w-full lg:w-1/2 max-w-lg bg-gray-900 p-6 rounded-2xl shadow-xl border border-gray-800">
                <h2 className="text-2xl font-bold mb-2 flex items-center gap-2">🎬 Auto Caption Pro</h2>
                <p className="text-gray-400 text-sm mb-6">สร้างซับอัตโนมัติ + AI ตรวจจับคำดึงสายตา (Hook)</p>

                <div className="mb-4 bg-gray-800 p-4 rounded-xl border border-gray-700">
                    <label className="block text-sm font-semibold mb-2">1. อัปโหลดวิดีโอ/เสียง</label>
                    <input 
                        type="file" 
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        accept="video/mp4,video/webm,audio/mp3,audio/wav" 
                        className="w-full text-sm text-gray-400 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 cursor-pointer"
                    />
                </div>

                <div className="mb-4 bg-gray-800 p-4 rounded-xl border border-gray-700">
                    <label className="block text-sm font-semibold mb-3">2. เลือกสไตล์และตั้งค่า</label>
                    <div className="grid grid-cols-3 gap-2 mb-4">
                        <button 
                            onClick={() => { setTemplate('tpl-default'); setHighlightColor('#FFFF00'); }}
                            className={`w-full text-white text-xs font-bold py-2 px-2 rounded-lg border-2 transition ${template === 'tpl-default' ? 'bg-blue-600 border-blue-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}
                        >
                            ⭐ Default
                        </button>
                        <button 
                            onClick={() => { setTemplate('tpl-hormozi'); setHighlightColor('#00FF00'); }}
                            className={`w-full text-white text-xs font-bold py-2 px-2 rounded-lg border-2 transition ${template === 'tpl-hormozi' ? 'bg-blue-600 border-blue-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}
                        >
                            🔥 Hormozi
                        </button>
                        <button 
                            onClick={() => { setTemplate('tpl-beast'); setHighlightColor('#00FFFF'); }}
                            className={`w-full text-white text-xs font-bold py-2 px-2 rounded-lg border-2 transition ${template === 'tpl-beast' ? 'bg-blue-600 border-blue-400' : 'bg-gray-700 border-transparent hover:bg-gray-600'}`}
                        >
                            ⚡ Beast
                        </button>
                    </div>
                    
                    <div className="flex items-center justify-between mb-3 border-t border-gray-700 pt-3">
                        <span className="text-sm">จัดกลุ่มคำปกติ:</span>
                        <select 
                            value={wordCount}
                            onChange={(e) => setWordCount(parseInt(e.target.value))}
                            className="bg-gray-700 text-white text-xs rounded focus:ring-blue-500 p-1 outline-none"
                        >
                            <option value="1">1 คำ</option>
                            <option value="2">2 คำ</option>
                            <option value="3">3 คำ</option>
                            <option value="4">4 คำ</option>
                        </select>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="text-sm">สีไฮไลท์ปกติ:</span>
                        <input 
                            type="color" 
                            value={highlightColor}
                            onChange={(e) => setHighlightColor(e.target.value)}
                            className="p-0.5 h-6 w-12 block bg-gray-700 border border-gray-600 cursor-pointer rounded"
                        />
                    </div>
                </div>

                <button 
                    onClick={handleProcess}
                    disabled={isProcessing}
                    className="w-full bg-gradient-to-r from-pink-500 to-orange-400 hover:from-pink-600 hover:to-orange-500 disabled:opacity-50 text-white font-bold py-3 px-4 rounded-xl shadow-lg transform transition active:scale-95 flex justify-center items-center gap-2 mb-4"
                >
                    {isProcessing ? '⏳ AI กำลังถอดเสียงและหาคำเด่น...' : '✨ ถอดเสียง + วิเคราะห์คำด้วย AI'}
                </button>

                {status && (
                    <div className={`mb-4 px-4 py-3 rounded-lg overflow-hidden relative ${ 
                        status.type === 'error' ? 'bg-red-900/50 text-red-100 border border-red-800' : 
                        status.type === 'success' ? 'bg-green-900/50 text-green-100 border border-green-800' : 
                        'bg-blue-900/40 text-blue-100 border border-blue-800/50 shadow-inner' 
                    }`}>
                        <div className="relative z-10 flex flex-col gap-2">
                            <span className="text-sm font-medium text-center">{status.text}</span>
                            {typeof status.progress === 'number' && (
                                <div className="w-full bg-gray-900/80 rounded-full h-2.5 mb-1 overflow-hidden shadow-inner">
                                    <div 
                                        className="bg-blue-500 h-2.5 rounded-full transition-all duration-300 ease-out" 
                                        style={{ width: `${status.progress}%` }}
                                    ></div>
                                </div>
                            )}
                        </div>
                        {typeof status.progress === 'number' && (
                            <div 
                                className="absolute left-0 top-0 bottom-0 bg-blue-600/10 transition-all duration-300 ease-out"
                                style={{ width: `${status.progress}%` }}
                            ></div>
                        )}
                    </div>
                )}

                {transcriptData.length > 0 && (
                    <div className="mb-4 bg-gray-800 p-4 rounded-xl border border-gray-700">
                        <label className="block text-sm font-semibold mb-2 flex justify-between items-center">
                            <span>3. ตรวจสอบและแก้ไขคำผิด</span>
                            <span className="text-xs font-normal text-yellow-400">🔥 = AI จับว่าเป็นคำ Hook</span>
                        </label>
                        <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto p-2 bg-gray-900 rounded-lg border border-gray-700">
                            {transcriptData.map((item, index) => (
                                <div key={index} className="relative inline-block">
                                    <input
                                        type="text"
                                        value={item.word}
                                        onChange={(e) => {
                                            const newData = [...transcriptData];
                                            newData[index].word = e.target.value;
                                            setTranscriptData(newData);
                                        }}
                                        onContextMenu={(e) => {
                                            e.preventDefault();
                                            const newData = [...transcriptData];
                                            newData[index].is_hook = !newData[index].is_hook;
                                            setTranscriptData(newData);
                                        }}
                                        style={{ width: `${Math.max(3, item.word.length + 1)}ch` }}
                                        className={`bg-gray-700 text-white text-sm px-2 py-1 rounded w-auto min-w-[3rem] text-center focus:ring-2 focus:ring-blue-500 outline-none border transition ${
                                            item.is_hook ? 'border-yellow-500 shadow-[0_0_8px_rgba(234,179,8,0.5)]' : 'border-gray-600'
                                        }`}
                                    />
                                    {item.is_hook && (
                                        <span className="absolute -top-2 -right-2 text-[10px] bg-gray-900 rounded-full">🔥</span>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {transcriptData.length > 0 && (
                    <div className="grid grid-cols-2 gap-2 mt-2">
                        <button 
                            onClick={handleDownloadSrt}
                            className="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold py-3 px-4 rounded-xl shadow-lg transform transition flex justify-center items-center gap-2 border border-gray-600 text-sm"
                        >
                            ⬇️ โหลด .srt
                        </button>
                        {file?.type.startsWith('video/') && (
                            <button 
                                onClick={handleDownloadVideo}
                                disabled={isExporting}
                                className="w-full bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white font-bold py-3 px-4 rounded-xl shadow-lg transform transition flex justify-center items-center gap-2 border border-green-600 text-sm"
                            >
                                {isExporting ? '🎥 กำลังเรนเดอร์...' : '🎥 โหลดวิดีโอฝังซับ'}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {/* Display Panel */}
            <div className="w-full lg:w-auto flex flex-col items-center">
                <div id="player-wrapper" className="shadow-2xl">
                    <video 
                        ref={videoRef}
                        src={videoSrc || undefined}
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                        playsInline 
                        controls 
                        crossOrigin="anonymous"
                    ></video>
                    
                    <div id="captions-overlay" className={template}>
                        {activeGroup && (() => {
                            const activeWordIndex = activeGroup.words.findIndex((w, i) => {
                                const nextStart = activeGroup.words[i+1]?.start ?? activeGroup.end + 0.5;
                                return currentTime >= w.start && currentTime < nextStart;
                            });

                            return activeGroup.words.map((w, i) => {
                                // Fallback: if no word is strictly active by time, activate the first or matching word, but here we strictly use the activeWordIndex.
                                const isActive = activeWordIndex !== -1 ? i === activeWordIndex : (currentTime >= w.start && currentTime <= w.end);
                                const isHormozi = template === 'tpl-hormozi';
                                const wordText = isHormozi ? w.word.toUpperCase() : w.word;
                                
                                if (isActive) {
                                if (w.is_hook) {
                                    return <span key={i} className="word active hook-word" style={{ 
                                        color: highlightColor,
                                        textShadow: '3px 3px 15px rgba(0,0,0,0.8)'
                                    }}>{wordText}</span>;
                                } else {
                                    return <span key={i} className="word active" style={{ 
                                        color: highlightColor,
                                        textShadow: `0px 0px 15px ${highlightColor}, 2px 2px 6px rgba(0,0,0,0.7)`
                                    }}>{wordText}</span>;
                                }
                            } else {
                                return <span key={i} className="word">{wordText}</span>;
                            }
                        })})()}
                    </div>
                </div>
            </div>
        </div>
    );
}
