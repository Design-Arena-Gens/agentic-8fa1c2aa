import { useCallback, useEffect, useMemo, useRef, useState } from "react";

function useVoices() {
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    const refresh = () => {
      const list = synth.getVoices();
      setVoices(list);
    };
    refresh();
    if (synth.onvoiceschanged !== undefined) {
      synth.onvoiceschanged = refresh;
    } else {
      const id = setInterval(() => {
        if (synth.getVoices().length) {
          refresh();
          clearInterval(id);
        }
      }, 250);
      return () => clearInterval(id);
    }
  }, []);
  return voices;
}

function encodeWavFromBuffer(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const samples = audioBuffer.length;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      s = s < 0 ? s * 0x8000 : s * 0x7fff;
      output.setInt16(offset, s, true);
    }
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  // Interleave channels
  const channels = [];
  for (let c = 0; c < numChannels; c++) channels.push(audioBuffer.getChannelData(c));
  const interleaved = new Float32Array(samples * numChannels);
  for (let i = 0; i < samples; i++) {
    for (let c = 0; c < numChannels; c++) {
      interleaved[i * numChannels + c] = channels[c][i];
    }
  }
  floatTo16BitPCM(view, 44, interleaved);
  return new Blob([view], { type: "audio/wav" });
}

function trimSilenceFromAudioBuffer(audioBuffer, threshold = 0.01, minSilenceMs = 150) {
  const sampleRate = audioBuffer.sampleRate;
  const minSilenceSamples = Math.floor((minSilenceMs / 1000) * sampleRate);
  const channelData = audioBuffer.getChannelData(0);
  let start = 0;
  let end = channelData.length - 1;

  // find start
  let run = 0;
  for (let i = 0; i < channelData.length; i++) {
    if (Math.abs(channelData[i]) < threshold) {
      run++;
    } else {
      if (run > 0 && run < minSilenceSamples) run = 0;
      else if (run >= minSilenceSamples) {
        start = i;
        break;
      }
    }
  }
  // If we didn't find a long silence at beginning, then start from 0 if first non-silence
  if (start === 0) {
    for (let i = 0; i < channelData.length; i++) {
      if (Math.abs(channelData[i]) > threshold) { start = i; break; }
    }
  }

  // find end
  run = 0;
  for (let i = channelData.length - 1; i >= 0; i--) {
    if (Math.abs(channelData[i]) < threshold) {
      run++;
    } else {
      if (run > 0 && run < minSilenceSamples) run = 0;
      else if (run >= minSilenceSamples) {
        end = i;
        break;
      }
    }
  }
  if (end === channelData.length - 1) {
    for (let i = channelData.length - 1; i >= 0; i--) {
      if (Math.abs(channelData[i]) > threshold) { end = i; break; }
    }
  }

  if (end <= start) return audioBuffer;

  const length = end - start + 1;
  const trimmed = new AudioBuffer({ length, numberOfChannels: audioBuffer.numberOfChannels, sampleRate });
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    trimmed.copyToChannel(audioBuffer.getChannelData(c).slice(start, end + 1), c);
  }
  return trimmed;
}

export default function Home() {
  const [text, setText] = useState("??????! ???? ???? ????????? ????? ?? ??????? ?????");
  const [isSynthSpeaking, setIsSynthSpeaking] = useState(false);
  const voices = useVoices();
  const hindiVoices = useMemo(() => voices.filter(v => v.lang?.toLowerCase().startsWith("hi")), [voices]);
  const [voiceName, setVoiceName] = useState("");

  const mediaRecorderRef = useRef(null);
  const [recordingState, setRecordingState] = useState("idle"); // idle | recording | paused
  const chunksRef = useRef([]);
  const [recordedUrl, setRecordedUrl] = useState("");
  const [durationMs, setDurationMs] = useState(0);
  const startTimeRef = useRef(0);
  const pauseAccumRef = useRef(0);
  const pauseStartRef = useRef(0);

  const canvasRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const dataArrayRef = useRef(null);
  const animationRef = useRef(null);
  const sourceNodeRef = useRef(null);

  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (hindiVoices.length && !voiceName) setVoiceName(hindiVoices[0].name);
  }, [hindiVoices, voiceName]);

  const drawWave = useCallback(() => {
    if (!canvasRef.current || !analyserRef.current || !dataArrayRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    const analyser = analyserRef.current;
    const dataArray = dataArrayRef.current;

    const draw = () => {
      analyser.getByteTimeDomainData(dataArray);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#0e1318";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#10b981";
      ctx.beginPath();
      const sliceWidth = (canvas.width * 1.0) / dataArray.length;
      let x = 0;
      let peak = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        peak = Math.max(peak, Math.abs(v - 1));
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        x += sliceWidth;
      }
      setLevel(peak);
      ctx.stroke();
      animationRef.current = requestAnimationFrame(draw);
    };
    animationRef.current = requestAnimationFrame(draw);
  }, []);

  const stopVisual = useCallback(() => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    animationRef.current = null;
    if (sourceNodeRef.current) try { sourceNodeRef.current.disconnect(); } catch {}
    sourceNodeRef.current = null;
    if (analyserRef.current) try { analyserRef.current.disconnect(); } catch {}
    analyserRef.current = null;
  }, []);

  const setupAudioGraph = useCallback(async (stream) => {
    if (!audioContextRef.current) audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioContextRef.current;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const bufferLength = analyser.fftSize;
    const dataArray = new Uint8Array(bufferLength);
    source.connect(analyser);

    analyserRef.current = analyser;
    dataArrayRef.current = dataArray;
    sourceNodeRef.current = source;

    drawWave();
  }, [drawWave]);

  const startRecording = useCallback(async () => {
    if (recordingState !== "idle") return;
    setRecordedUrl("");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const mr = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : undefined });
    chunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
    mr.onstop = () => { stream.getTracks().forEach(t => t.stop()); };

    await setupAudioGraph(stream);
    mr.start(100);
    startTimeRef.current = performance.now();
    pauseAccumRef.current = 0;
    pauseStartRef.current = 0;
    setRecordingState("recording");
  }, [recordingState, setupAudioGraph]);

  const pauseRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr || recordingState !== "recording") return;
    mr.pause();
    pauseStartRef.current = performance.now();
    setRecordingState("paused");
  }, [recordingState]);

  const resumeRecording = useCallback(() => {
    const mr = mediaRecorderRef.current;
    if (!mr || recordingState !== "paused") return;
    mr.resume();
    pauseAccumRef.current += performance.now() - pauseStartRef.current;
    pauseStartRef.current = 0;
    setRecordingState("recording");
  }, [recordingState]);

  const stopRecording = useCallback(async () => {
    const mr = mediaRecorderRef.current;
    if (!mr) return;
    mr.stop();
    stopVisual();
    setRecordingState("idle");
    const end = performance.now();
    setDurationMs(Math.max(0, Math.round(end - startTimeRef.current - pauseAccumRef.current)));

    // Build blob
    const webmBlob = new Blob(chunksRef.current, { type: chunksRef.current[0]?.type || "audio/webm" });

    // Decode -> trim -> WAV
    const arrayBuffer = await webmBlob.arrayBuffer();
    const ctx = audioContextRef.current || new (window.AudioContext || window.webkitAudioContext)();
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const trimmed = trimSilenceFromAudioBuffer(decoded, 0.01, 150);
    const wavBlob = encodeWavFromBuffer(trimmed);

    const url = URL.createObjectURL(wavBlob);
    setRecordedUrl(url);
  }, [stopVisual]);

  useEffect(() => {
    return () => stopVisual();
  }, [stopVisual]);

  useEffect(() => {
    // Keep mediaRecorderRef in sync with active recorder
    if (recordingState === "recording" || recordingState === "paused") return;
  }, [recordingState]);

  const bindMediaRecorder = useCallback(async () => {
    // Bind reference right after start
    if (!mediaRecorderRef.current) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());
    }
  }, []);

  useEffect(() => {
    // Wire the actual MediaRecorder instance after permission
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mr = new MediaRecorder(stream);
        mediaRecorderRef.current = mr;
        mr.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      } catch {}
    })();
  }, []);

  const speak = useCallback(() => {
    if (!text?.trim()) return;
    if (typeof window === "undefined") return;
    const synth = window.speechSynthesis;
    if (synth.speaking) synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voice = voices.find(v => v.name === voiceName) || voices.find(v => v.lang?.toLowerCase().startsWith("hi"));
    if (voice) u.voice = voice;
    u.lang = voice?.lang || "hi-IN";
    u.onstart = () => setIsSynthSpeaking(true);
    u.onend = () => setIsSynthSpeaking(false);
    u.onerror = () => setIsSynthSpeaking(false);
    synth.speak(u);
  }, [text, voiceName, voices]);

  const stopSpeak = useCallback(() => {
    if (typeof window === "undefined") return;
    window.speechSynthesis.cancel();
    setIsSynthSpeaking(false);
  }, []);

  return (
    <div className="container">
      <div className="header">
        <div className="brand">??? Voiceover Studio</div>
        <div className="badge">????? ???????</div>
      </div>

      <div className="grid">
        <div className="panel">
          <div className="sectionTitle">?????????</div>
          <div className="label">???? ??????? ???? ?????</div>
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder="???? ?????..." />
          <div className="row" style={{justifyContent:'space-between',marginTop:8}}>
            <div className="small">???: ?????? ???? ???????? ??????? ?? ?????? ???? ??</div>
            <div className="badge">?????????? ????: {(level*100).toFixed(0)}%</div>
          </div>
        </div>

        <div className="panel">
          <div className="sectionTitle">???????-??-????? ????????</div>
          <div className="label">???? ?????</div>
          <div className="controls" style={{marginBottom:12}}>
            <select value={voiceName} onChange={(e)=>setVoiceName(e.target.value)}>
              {(hindiVoices.length ? hindiVoices : voices).map(v => (
                <option key={v.name} value={v.name}>{v.name} ({v.lang})</option>
              ))}
            </select>
            <button className={`button primary`} onClick={speak} disabled={!text.trim() || isSynthSpeaking}>????</button>
            <button className="button" onClick={stopSpeak} disabled={!isSynthSpeaking}>?????</button>
          </div>
          <div className="small">?? ???? ???????? ??; ????? ????? ?????????? ?? ??????? ?????</div>
        </div>
      </div>

      <div className="panel" style={{marginTop:16}}>
        <div className="sectionTitle">??????????</div>
        <canvas ref={canvasRef} className="wave" width={960} height={120} />
        <div className="controls" style={{marginTop:12}}>
          <button className="button primary" onClick={startRecording} disabled={recordingState!=="idle"}>??????? ???? ????</button>
          <button className="button warn" onClick={pauseRecording} disabled={recordingState!=="recording"}>????</button>
          <button className="button" onClick={resumeRecording} disabled={recordingState!=="paused"}>??? ????</button>
          <button className="button danger" onClick={stopRecording} disabled={recordingState==="idle"}>?????</button>
        </div>
        <div className="row" style={{marginTop:8, justifyContent:'space-between'}}>
          <div className="small">????: {durationMs? `${(durationMs/1000).toFixed(2)}s` : "-"}</div>
          {recordedUrl ? (
            <a className="button" href={recordedUrl} download="voiceover.wav">??????? WAV</a>
          ) : (
            <span className="badge">?????????? ????? ????</span>
          )}
        </div>
      </div>

      <div className="footer">
        ????? ??? Next.js + Web Audio API ?? ???. ????? ??????? ?? ????? ??? ???? ??.
      </div>
    </div>
  );
}
