import React, { useState, useRef, useEffect, useMemo } from 'react';
import * as Mp4Muxer from 'mp4-muxer';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

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
    const [selectedFont, setSelectedFont] = useState<string>('Kanit');
    const [customFontConfig, setCustomFontConfig] = useState({ name: '', url: '' });
    const [wordCount, setWordCount] = useState<number>(3);
    const [fontSizeMultiplier, setFontSizeMultiplier] = useState<number>(1.0);
    const [transcriptData, setTranscriptData] = useState<TranscriptWord[]>([]);
    
    const [status, setStatus] = useState<{ text: string; type: 'info' | 'success' | 'error'; progress?: number } | null>(null);
    const [isProcessing, setIsProcessing] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    
    const [currentTime, setCurrentTime] = useState(0);
    const [dragging, setDragging] = useState<{ index: number; type: 'move' | 'resize-left' | 'resize-right'; initialX: number; initialStart: number; initialEnd: number } | null>(null);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);

    const videoRef = useRef<HTMLVideoElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const timelineTrackRef = useRef<HTMLDivElement>(null);

    const handleTimelineMouseMove = (e: React.MouseEvent) => {
        if (!dragging || !timelineTrackRef.current) return;
        
        const rect = timelineTrackRef.current.getBoundingClientRect();
        const mouseX = e.clientX - rect.left + timelineTrackRef.current.scrollLeft;
        const timeDiff = (mouseX - dragging.initialX) / 150;
        
        const newData = [...transcriptData];
        const item = newData[dragging.index];

        if (dragging.type === 'move') {
            const newStart = Math.max(0, dragging.initialStart + timeDiff);
            const duration = dragging.initialEnd - dragging.initialStart;
            item.start = newStart;
            item.end = newStart + duration;
        } else if (dragging.type === 'resize-left') {
            const newStart = Math.max(0, Math.min(dragging.initialEnd - 0.1, dragging.initialStart + timeDiff));
            item.start = newStart;
        } else if (dragging.type === 'resize-right') {
            const newEnd = Math.max(dragging.initialStart + 0.1, dragging.initialEnd + timeDiff);
            item.end = newEnd;
        }

        setTranscriptData(newData);
    };

    const handleTimelineMouseUp = () => {
        setDragging(null);
    };

    useEffect(() => {
        if (dragging) {
            window.addEventListener('mousemove', handleTimelineMouseMove as any);
            window.addEventListener('mouseup', handleTimelineMouseUp);
        } else {
            window.removeEventListener('mousemove', handleTimelineMouseMove as any);
            window.removeEventListener('mouseup', handleTimelineMouseUp);
        }
        return () => {
            window.removeEventListener('mousemove', handleTimelineMouseMove as any);
            window.removeEventListener('mouseup', handleTimelineMouseUp);
        };
    }, [dragging, transcriptData]);

    useEffect(() => {
        let rafId: number;
        const update = () => {
            if (videoRef.current && !videoRef.current.paused) {
                setCurrentTime(videoRef.current.currentTime);
            }
            rafId = requestAnimationFrame(update);
        };
        rafId = requestAnimationFrame(update);
        return () => cancelAnimationFrame(rafId);
    }, []);

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
        let currentWords: TranscriptWord[] = [];

        for (let i = 0; i < transcriptData.length; i++) {
            const item = transcriptData[i];
            const lastItem = currentWords[currentWords.length - 1];
            
            // Break group if:
            // 1. Reached word count limit
            // 2. OR there is a significant pause (> 0.5s) between words
            const isPause = lastItem && (item.start - lastItem.end > 0.5);
            
            if (currentWords.length > 0 && (currentWords.length >= wordCount || isPause)) {
                groups.push({
                    words: currentWords,
                    start: currentWords[0].start,
                    end: currentWords[currentWords.length - 1].end
                });
                currentWords = [];
            }
            
            currentWords.push(item);
        }
        
        if (currentWords.length > 0) {
            groups.push({
                words: currentWords,
                start: currentWords[0].start,
                end: currentWords[currentWords.length - 1].end
            });
        }
        
        return groups;
    }, [transcriptData, wordCount]);

    const activeGroup = useMemo(() => {
        if (currentGroups.length === 0) return undefined;
        // Group detection: find group where current time is within its bounds
        // We use a small look-ahead to avoid gaps
        const index = currentGroups.findIndex((g, i) => {
            const nextStart = currentGroups[i+1]?.start ?? g.end;
            return currentTime >= g.start && currentTime < nextStart;
        });
        return index !== -1 ? currentGroups[index] : undefined;
    }, [currentGroups, currentTime]);

    const handleProcess = async () => {
        if (!file) {
            setStatus({ text: 'กรุณาเลือกไฟล์ก่อนค่ะ!', type: 'error' });
            return;
        }
        if (file.size > 2 * 1024 * 1024 * 1024) {
            setStatus({ text: 'ขนาดไฟล์ใหญ่เกินไปสำหรับระบบทดสอบ (จำกัด 2GB)', type: 'error' });
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

            const resText = await res.text();
            let data: any;
            try {
                data = JSON.parse(resText);
            } catch (e) {
                if (!res.ok) {
                    if (res.status === 413) {
                        throw new Error('ขนาดวิดีโอใหญ่เกินไปสำหรับการอัปโหลด (Payload Too Large)');
                    }
                    throw new Error(`Server error: ${res.status}`);
                }
                throw new Error('Invalid JSON response from server');
            }

            if (!res.ok) {
                throw new Error(data?.error || `Error ${res.status}`);
            }

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

        let encoderError: any = null;

        try {
            const muxer = new Mp4Muxer.Muxer({
                target: new Mp4Muxer.ArrayBufferTarget(),
                video: { codec: 'avc', width: videoRef.current?.videoWidth || 1080, height: videoRef.current?.videoHeight || 1920 },
                fastStart: 'in-memory',
                firstTimestampBehavior: 'offset'
            });

            const videoEncoder = new window.VideoEncoder({
                output: (chunk, meta) => muxer.addVideoChunk(chunk, meta as any),
                error: (e: any) => {
                    console.error("Encoder Error:", e);
                    encoderError = e;
                }
            });
            
            videoEncoder.configure({ 
                codec: 'avc1.4d0034', // Level 5.2 for higher resolutions like 1440x2560
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

            let fontFamily = selectedFont === 'Custom' ? customFontConfig.name : selectedFont;
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
                        if (encoderError) {
                            isResolved = true;
                            reject(new Error("Video Encoding failed: " + encoderError.message));
                            return;
                        }
                        const time = metadata.mediaTime;
                        ctx.drawImage(renderVideo, 0, 0, canvas.width, canvas.height);

                        const groupIndex = currentGroups.findIndex((g, i) => {
                            const nextStart = currentGroups[i+1]?.start ?? g.end + 0.1; // Reduced buffer for tighter sync
                            return time >= g.start && time < nextStart;
                        });
                        const group = groupIndex !== -1 ? currentGroups[groupIndex] : undefined;

                        if (group) {
                            ctx.textAlign = "center"; 
                            ctx.textBaseline = "bottom";
                            // SAFE ZONE ADJUSTMENT: Center-bottom but avoiding the very bottom TikTok UI
                            let yPos = canvas.height * 0.82; 

                            const baseFontSize = canvas.width * (template === 'tpl-hormozi' ? 0.065 : 0.06); 
                            
                            let totalWidth = 0;

                            const activeWordIndex = group.words.findIndex((w, i) => {
                                const nextStart = group.words[i+1]?.start ?? group.end + 0.1;
                                return time >= (w.start - 0.02) && time < nextStart; // Slight leading edge for sync
                            });

                            const wordsMeta = group.words.map((w, i) => {
                                const isActive = activeWordIndex !== -1 ? i === activeWordIndex : (time >= w.start && time <= w.end);
                                let scale = 1.0;
                                let rotation = 0;
                                let yOffset = 0;

                                if (isActive) {
                                    if (template === 'tpl-default') {
                                        scale = w.is_hook ? 2.2 : 1.35;
                                        yOffset = w.is_hook ? canvas.height * 0.02 : canvas.height * 0.015;
                                        if (w.is_hook) rotation = 2;
                                    } else if (template === 'tpl-hormozi') {
                                        scale = w.is_hook ? 2.5 : 1.45;
                                        rotation = w.is_hook ? -5 : -3;
                                    } else if (template === 'tpl-beast') {
                                        scale = w.is_hook ? 2.8 : 1.6;
                                        yOffset = w.is_hook ? canvas.height * 0.03 : canvas.height * 0.02;
                                    }
                                }
                                
                                // Cap absolute font size to avoid taking up the whole screen
                                const maxAllowedFontSize = canvas.height * 0.15;
                                let fontSize = baseFontSize * scale;
                                if (fontSize > maxAllowedFontSize) {
                                    fontSize = maxAllowedFontSize;
                                }

                                ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
                                
                                const text = isUppercase ? w.word.toUpperCase() : w.word;
                                const width = ctx.measureText(text).width;
                                const margin = baseFontSize * 0.2;
                                totalWidth += width + margin;
                                
                                return { text, width, isActive, isHook: w.is_hook, margin, fontSize, rotation, yOffset };
                            });

                            // STRICT SAFE ZONE: Max width 85% of canvas
                            const maxWidth = canvas.width * 0.85; 
                            let globalScale = 1;
                            if (totalWidth > maxWidth) {
                                globalScale = maxWidth / totalWidth;
                            }
                            
                            // Recalculate totalWidth with globalScale
                            totalWidth = wordsMeta.reduce((acc, m) => acc + (m.width * globalScale * fontSizeMultiplier) + (m.margin * globalScale * fontSizeMultiplier), 0);

                            let currentX = (canvas.width / 2) - (totalWidth / 2);
                            
                            wordsMeta.forEach(meta => {
                                const finalFontSize = meta.fontSize * globalScale * fontSizeMultiplier;
                                const finalWidth = meta.width * globalScale * fontSizeMultiplier;
                                const finalMargin = meta.margin * globalScale * fontSizeMultiplier;

                                ctx.font = `${fontWeight} ${finalFontSize}px "${fontFamily}", sans-serif`;
                                
                                ctx.save();
                                // Boundary check for vertical pos
                                let drawYPos = yPos - (meta.yOffset * globalScale * fontSizeMultiplier);
                                // Ensure text doesn't go below the canvas or above too much
                                drawYPos = Math.min(canvas.height - 10, Math.max(finalFontSize + 10, drawYPos));

                                ctx.translate(currentX + (finalWidth / 2), drawYPos);
                                
                                if (meta.isActive && meta.rotation !== 0) {
                                    ctx.rotate(meta.rotation * Math.PI / 180);
                                }
                                
                                ctx.lineJoin = "round";

                                const shadowScale = globalScale * fontSizeMultiplier;
                                if (meta.isActive) {
                                    ctx.fillStyle = template === 'tpl-hormozi' && meta.isHook ? "#fff" : highlightColor;
                                    
                                    if (template === 'tpl-hormozi') {
                                        ctx.shadowColor = 'rgba(0,0,0,1)';
                                        ctx.shadowBlur = 0;
                                        ctx.shadowOffsetX = 4 * shadowScale;
                                        ctx.shadowOffsetY = 4 * shadowScale;
                                    } else if (template === 'tpl-beast') {
                                        ctx.shadowColor = meta.isHook ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.4)';
                                        ctx.shadowBlur = meta.isHook ? 30 * shadowScale : 15 * shadowScale;
                                        ctx.shadowOffsetX = 0;
                                        ctx.shadowOffsetY = 0;
                                    } else {
                                        ctx.shadowColor = 'rgba(0,0,0,0.8)';
                                        ctx.shadowBlur = meta.isHook ? 20 * shadowScale : 12 * shadowScale;
                                        ctx.shadowOffsetX = 2 * shadowScale;
                                        ctx.shadowOffsetY = 2 * shadowScale;
                                    }
                                } else {
                                    ctx.fillStyle = "white"; 
                                    ctx.shadowColor = 'rgba(0,0,0,0.6)';
                                    ctx.shadowBlur = 4 * shadowScale;
                                    ctx.shadowOffsetX = 1 * shadowScale;
                                    ctx.shadowOffsetY = 1 * shadowScale;
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
                            text: `⏳ กำลังรวมภาพ... ${progressPercentage.toFixed(0)}%`, 
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

            await ffmpeg.load({
                coreURL: await toBlobURL(coreURL, 'text/javascript'),
                wasmURL: await toBlobURL(wasmURL, 'application/wasm')
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
        <div className="main-container animate-in fade-in duration-700">
            {customFontConfig.url && (
                <style dangerouslySetInnerHTML={{ __html: `@import url('${customFontConfig.url}');` }} />
            )}

            {/* Branded Header */}
            <header className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 bg-black rounded-xl flex items-center justify-center text-white font-bold">P</div>
                    <span className="text-2xl font-serif font-black tracking-tight">Caption Pro</span>
                </div>
                <div className="flex items-center gap-6">
                    <div className="hidden md:flex items-center gap-6 text-sm font-bold text-gray-400">
                        <span className="cursor-pointer hover:text-black">Dashboard</span>
                        <span className="cursor-pointer hover:text-black">History</span>
                        <span className="cursor-pointer hover:text-black">Templates</span>
                    </div>
                    <button className="bg-amber-100 text-amber-900 border border-amber-200 px-5 py-2 rounded-xl text-xs font-black shadow-sm">Upgrade</button>
                </div>
            </header>
            
            <div className="flex flex-col lg:flex-row gap-8 items-stretch h-full">
                {/* Control Panel */}
                <div className="w-full lg:w-5/12 gradient-card-orange p-10 flex flex-col gap-8 shadow-xl">
                    <header>
                        <h2 className="text-4xl font-serif font-bold mb-2 tracking-tight">Auto Caption</h2>
                        <p className="text-amber-900/60 text-sm font-semibold tracking-wide uppercase">AI-POWERED SUBTITLES</p>
                    </header>

                    <div className="space-y-6">
                        <div className="space-y-3">
                            <label className="block text-xs font-bold text-amber-900/50 uppercase tracking-widest ml-1">1. อัปโหลดวิดีโอ/เสียง</label>
                            <div 
                                onClick={() => fileInputRef.current?.click()}
                                className="group relative cursor-pointer"
                            >
                                <input 
                                    type="file" 
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept="video/mp4,video/webm,audio/mp3,audio/wav" 
                                    className="hidden"
                                />
                                <div className="bg-white/40 border-2 border-dashed border-amber-900/20 p-8 rounded-3xl flex flex-col items-center justify-center gap-4 group-hover:border-amber-900/40 transition-all">
                                    <div className="w-16 h-16 rounded-full bg-amber-900/10 flex items-center justify-center text-amber-900 group-hover:scale-110 transition-transform">
                                        <svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                    </div>
                                    <div className="text-center">
                                        <span className="block text-base font-bold text-amber-950">{file ? file.name : 'เลือกไฟล์ของคุณ'}</span>
                                        <span className="text-xs text-amber-900/60 font-medium">MP4, WEBM, MP3 คมชัดระดับ 4K</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <label className="block text-xs font-bold text-amber-900/50 uppercase tracking-widest ml-1">2. ปรับแต่งสไตล์ (พาวเวอร์อัพ AI)</label>
                            
                            <div className="flex items-center justify-between px-1 mb-2">
                                <span className="text-[11px] font-bold text-amber-900/60 uppercase">ถอดเสียงขึ้นทีละ :</span>
                                <div className="flex gap-1.5 bg-amber-900/5 p-1 rounded-xl">
                                    {[1, 2, 3, 4].map(num => (
                                        <button
                                            key={num}
                                            onClick={() => setWordCount(num)}
                                            className={`w-10 h-8 rounded-lg text-xs font-black transition-all ${wordCount === num ? 'bg-amber-950 text-white shadow-md' : 'text-amber-900/40 hover:bg-white/40'}`}
                                        >
                                            {num}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex gap-2 p-1.5 bg-amber-900/5 rounded-2xl">
                                {['tpl-default', 'tpl-hormozi', 'tpl-beast'].map((t) => (
                                    <button 
                                        key={t}
                                        onClick={() => { setTemplate(t); if(t==='tpl-default') setHighlightColor('#FFFF00'); if(t==='tpl-hormozi') setHighlightColor('#00FF00'); if(t==='tpl-beast') setHighlightColor('#00FFFF'); }}
                                        className={`flex-1 py-3 px-2 rounded-xl text-xs font-bold transition-all ${template === t ? 'bg-white text-amber-950 shadow-sm' : 'text-amber-900/50 hover:bg-white/40'}`}
                                    >
                                        {t.replace('tpl-', '').toUpperCase()}
                                    </button>
                                ))}
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <span className="text-[11px] font-bold text-amber-900/50 uppercase ml-1">ขนาดอักษร</span>
                                    <div className="flex items-center gap-3 bg-white/60 border border-amber-900/10 rounded-2xl p-4">
                                        <input 
                                            type="range" 
                                            min="0.5" 
                                            max="1.5" 
                                            step="0.1" 
                                            value={fontSizeMultiplier}
                                            onChange={(e) => setFontSizeMultiplier(parseFloat(e.target.value))}
                                            className="flex-1 accent-amber-900"
                                        />
                                        <span className="text-xs font-bold text-amber-900 w-8">{Math.round(fontSizeMultiplier * 100)}%</span>
                                    </div>
                                </div>
                                <div className="space-y-2">
                                    <span className="text-[11px] font-bold text-amber-900/50 uppercase ml-1">ฟอนต์</span>
                                    <select 
                                        value={selectedFont}
                                        onChange={(e) => setSelectedFont(e.target.value)}
                                        className="w-full bg-white/60 border border-amber-900/10 rounded-2xl text-sm font-bold p-4 outline-none appearance-none"
                                    >
                                        <option value="Kanit">Kanit</option>
                                        <option value="Prompt">Prompt</option>
                                        <option value="Sarabun">Sarabun</option>
                                        <option value="Mitr">Mitr</option>
                                        <option value="Chakra Petch">Chakra Petch</option>
                                        <option value="Inter">Inter</option>
                                        <option value="Space Grotesk">Space Grotesk</option>
                                        <option value="Custom">Custom Font ➕</option>
                                    </select>
                                </div>
                                <div className="space-y-2">
                                    <span className="text-[11px] font-bold text-amber-900/50 uppercase ml-1">Highlight</span>
                                    <div className="flex gap-2">
                                        <input 
                                            type="color" 
                                            value={highlightColor}
                                            onChange={(e) => setHighlightColor(e.target.value)}
                                            className="w-14 h-14 bg-white/60 border border-amber-900/10 cursor-pointer rounded-2xl overflow-hidden p-1.5"
                                        />
                                        <div className="bg-white/60 border border-amber-900/10 rounded-2xl flex-1 flex items-center justify-center text-[10px] font-bold text-amber-900">
                                            {highlightColor.toUpperCase()}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {transcriptData.length > 0 && (
                                <div className="space-y-3 bg-amber-950/5 p-4 rounded-3xl border border-amber-900/5">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[11px] font-bold text-amber-900/50 uppercase">แก้ไขข้อความทั้งหมด</label>
                                        <span className="text-[10px] font-bold text-amber-900/30">{transcriptData.length} คำ</span>
                                    </div>
                                    <div className="max-h-[300px] overflow-y-auto scrollbar-thin pr-2 space-y-1.5">
                                        {transcriptData.map((item, idx) => (
                                            <div key={idx} className="flex items-center gap-2 group">
                                                <div 
                                                    onClick={() => { if(videoRef.current) videoRef.current.currentTime = item.start; }}
                                                    className="w-12 text-[10px] font-mono text-amber-900/40 cursor-pointer hover:text-black transition-colors"
                                                >
                                                    {item.start.toFixed(1)}s
                                                </div>
                                                <input 
                                                    type="text"
                                                    value={item.word}
                                                    onChange={(e) => {
                                                        const newData = [...transcriptData];
                                                        newData[idx].word = e.target.value;
                                                        setTranscriptData(newData);
                                                    }}
                                                    className="flex-1 bg-white/40 border-none rounded-xl px-3 py-2 text-xs font-bold text-amber-950 focus:ring-1 focus:ring-amber-500 outline-none"
                                                />
                                                <button 
                                                    onClick={() => {
                                                        const newData = [...transcriptData];
                                                        newData[idx].is_hook = !newData[idx].is_hook;
                                                        setTranscriptData(newData);
                                                    }}
                                                    className={`w-8 h-8 rounded-xl flex items-center justify-center transition-all ${item.is_hook ? 'bg-amber-400 shadow-sm' : 'bg-white/40 opacity-40 hover:opacity-100'}`}
                                                >
                                                    🔥
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <button 
                            onClick={handleProcess}
                            disabled={isProcessing}
                            className="pitch-button w-full mt-4 flex items-center justify-center gap-3 active:scale-95 disabled:opacity-50"
                        >
                            {isProcessing ? (
                                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                            ) : 'Generate Captions'}
                        </button>

                        {status && (
                            <div className={`p-5 rounded-3xl text-sm font-bold ${ 
                                status.type === 'error' ? 'bg-red-500/10 text-red-700' : 
                                status.type === 'success' ? 'bg-green-500/10 text-green-700' : 
                                'bg-white/30 text-amber-900' 
                            }`}>
                                <div className="flex items-center gap-3">
                                    <div className={`w-2.5 h-2.5 rounded-full ${
                                        status.type === 'error' ? 'bg-red-500' : status.type === 'success' ? 'bg-green-500' : 'bg-amber-600'
                                    }`}></div>
                                    <span>{status.text}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {/* Display Panel */}
                <div className="w-full lg:w-7/12 flex flex-col items-center justify-center gradient-card-blue p-8">
                    <div id="player-wrapper" className="border-[16px] border-white/40 shadow-2xl rounded-[60px]">
                        <video 
                            ref={videoRef}
                            src={videoSrc || undefined}
                            onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                            playsInline 
                            controls 
                            crossOrigin="anonymous"
                            className="pointer-events-auto"
                        ></video>
                        
                        <div id="captions-overlay" className={template} style={{ fontFamily: `'${selectedFont === 'Custom' ? customFontConfig.name : selectedFont}', sans-serif` }}>
                            {activeGroup && (() => {
                                const activeWordIndex = activeGroup.words.findIndex((w, i) => {
                                    const nextStart = activeGroup.words[i+1]?.start ?? activeGroup.end;
                                    return currentTime >= w.start && currentTime < nextStart;
                                });

                                return activeGroup.words.map((w, i) => {
                                    const isActive = activeWordIndex !== -1 ? i === activeWordIndex : (currentTime >= w.start && currentTime <= w.end);
                                    const wordText = template !== 'tpl-default' ? w.word.toUpperCase() : w.word;
                                    
                                    const classes = [
                                        'word',
                                        isActive ? 'active' : '',
                                        w.is_hook ? 'hook-word' : ''
                                    ].filter(Boolean).join(' ');

                                    const style: React.CSSProperties = {
                                        fontSize: `${100 * fontSizeMultiplier}%`
                                    };
                                    if (isActive) {
                                        if (template === 'tpl-hormozi' && w.is_hook) {
                                            style.color = '#fff';
                                        } else {
                                            style.color = highlightColor;
                                        }
                                    }

                                    return (
                                        <span key={i} className={classes} style={style}>
                                            {wordText}
                                        </span>
                                    );
                                });
                            })()}
                        </div>
                    </div>
                </div>
            </div>

            {/* Bottom Timeline */}
            {transcriptData.length > 0 && (
                <div className="timeline-container">
                    <div className="flex flex-col sm:flex-row items-center justify-between mb-8 px-2">
                        <div className="flex items-center gap-4">
                            <div className="w-12 h-12 rounded-2xl bg-black text-white flex items-center justify-center text-xl">⏳</div>
                            <div>
                                <h3 className="text-xl font-serif font-bold tracking-tight">Timeline Editor</h3>
                                <p className="text-xs text-gray-400 font-bold uppercase tracking-widest">FINE-TUNE YOUR HOOKS</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-4">
                            <button onClick={handleDownloadSrt} className="glass-button py-3 px-6 text-sm">Download .SRT</button>
                            <button 
                                onClick={handleDownloadVideo}
                                disabled={isExporting}
                                className="pitch-button py-3 px-6 text-sm"
                            >
                                {isExporting ? 'Rendering...' : 'Export Video'}
                            </button>
                        </div>
                    </div>

                    <div 
                        ref={timelineTrackRef}
                        onMouseDown={(e) => {
                            if (e.target === timelineTrackRef.current) {
                                setEditingIndex(null);
                            }
                        }}
                        className="timeline-track scrollbar-thin rounded-3xl bg-white/50 border border-white relative select-none"
                    >
                        {/* Ruler */}
                        <div className="timeline-ruler" style={{ width: `${(videoRef.current?.duration || 0) * 150}px` }}>
                            {Array.from({ length: Math.ceil(videoRef.current?.duration || 0) + 1 }).map((_, i) => (
                                <div key={i} className="ruler-mark" style={{ left: `${i * 150}px` }}>
                                    {i}s
                                </div>
                            ))}
                        </div>

                        {/* Word Clips */}
                        {transcriptData.map((item, index) => {
                            const isActive = currentTime >= item.start && currentTime < item.end;
                            return (
                                <div 
                                    key={index} 
                                    onMouseDown={(e) => {
                                        e.stopPropagation();
                                        const rect = timelineTrackRef.current?.getBoundingClientRect();
                                        if (!rect) return;
                                        const x = e.clientX - rect.left + (timelineTrackRef.current?.scrollLeft || 0);
                                        
                                        const clipLeft = item.start * 150;
                                        const clipWidth = (item.end - item.start) * 150;
                                        
                                        if (x < clipLeft + 12) {
                                            setDragging({ index, type: 'resize-left', initialX: x, initialStart: item.start, initialEnd: item.end });
                                        } else if (x > clipLeft + clipWidth - 12) {
                                            setDragging({ index, type: 'resize-right', initialX: x, initialStart: item.start, initialEnd: item.end });
                                        } else {
                                            setDragging({ index, type: 'move', initialX: x, initialStart: item.start, initialEnd: item.end });
                                        }
                                        
                                        setEditingIndex(index);
                                        if (videoRef.current) videoRef.current.currentTime = item.start;
                                    }}
                                    className={`timeline-word-clip group cursor-grab active:cursor-grabbing ${isActive || editingIndex === index ? 'active ring-2 ring-black/20 shadow-lg' : ''} ${item.is_hook ? 'hook' : ''} !rounded-xl !h-[54px] !top-[48px] border-2 transition-all`}
                                    style={{ 
                                        left: `${item.start * 150}px`, 
                                        width: `${(item.end - item.start) * 150}px`,
                                        zIndex: (isActive || editingIndex === index) ? 50 : 1
                                    } as React.CSSProperties}
                                >
                                    <div className="absolute left-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-black/10 rounded-l-lg"></div>
                                    <span className="truncate max-w-full px-2 z-10 font-black text-[11px] pointer-events-none select-none">{item.word}</span>
                                    <div className="absolute right-0 top-0 bottom-0 w-2.5 cursor-ew-resize hover:bg-black/10 rounded-r-lg"></div>
                                    
                                    {editingIndex === index && (
                                        <div 
                                            onMouseDown={(e) => e.stopPropagation()}
                                            className="absolute -top-14 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-amber-950 p-1.5 rounded-2xl shadow-2xl z-50 animate-in zoom-in-90 duration-150"
                                        >
                                            <input 
                                                type="text" 
                                                value={item.word}
                                                autoFocus
                                                onMouseDown={(e) => e.stopPropagation()}
                                                onClick={(e) => e.stopPropagation()}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') setEditingIndex(null);
                                                }}
                                                onChange={(e) => {
                                                    const newData = [...transcriptData];
                                                    newData[index].word = e.target.value;
                                                    setTranscriptData(newData);
                                                }}
                                                className="w-24 text-[11px] bg-white/10 border-none rounded-lg px-2 py-1.5 focus:ring-1 focus:ring-amber-400 font-bold text-white placeholder-white/30"
                                            />
                                            <button 
                                                onMouseDown={(e) => e.stopPropagation()}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    const newData = [...transcriptData];
                                                    newData[index].is_hook = !newData[index].is_hook;
                                                    setTranscriptData(newData);
                                                }}
                                                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${item.is_hook ? 'bg-amber-400 scale-110 active:scale-95 text-black' : 'bg-white/10 text-white hover:bg-white/20'}`}
                                            >
                                                🔥
                                            </button>
                                            <button 
                                                onMouseDown={(e) => e.stopPropagation()}
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    setEditingIndex(null);
                                                }}
                                                className="w-6 h-8 text-white/50 hover:text-white text-xs font-bold px-1"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {/* Playhead */}
                        <div 
                            className="timeline-playhead !bg-black after:!bg-black" 
                            style={{ left: `${currentTime * 150}px` }}
                        ></div>
                    </div>
                </div>
            )}
        </div>
    );
}
