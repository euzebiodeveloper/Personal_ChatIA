import type { AutomaticSpeechRecognitionOutput } from '@huggingface/transformers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipeline: any = null;
let loadPromise: Promise<void> | null = null;

export type LoadCallback = (status: string) => void;

async function ensurePipeline(onStatus?: LoadCallback): Promise<void> {
  if (pipeline) return;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    onStatus?.('Carregando modelo de fala (primeira vez ~74MB)...');
    const { pipeline: buildPipeline, env } = await import('@huggingface/transformers');

    // Disable local model lookup — always fetch from HuggingFace Hub
    env.allowLocalModels = false;

    pipeline = await buildPipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-tiny',  // ~75MB multilingual — compatível com fp32
      {
        dtype: 'fp32',
        progress_callback: (prog: { status: string; progress?: number }) => {
          if (prog.status === 'downloading' && prog.progress !== undefined) {
            onStatus?.(`Baixando modelo: ${Math.round(prog.progress)}%`);
          }
        },
      },
    );
    onStatus?.('Modelo pronto!');
  })();

  return loadPromise;
}

// Kick off loading in the background as soon as this module is imported
ensurePipeline().catch(console.error);

export async function transcribe(audioBlob: Blob, onStatus?: LoadCallback): Promise<string> {
  await ensurePipeline(onStatus);

  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioCtx = new AudioContext({ sampleRate: 16000 });
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const float32 = audioBuffer.getChannelData(0);

  const result = (await pipeline(float32, {
    language: 'portuguese',
    task: 'transcribe',
    chunk_length_s: 30,
  })) as AutomaticSpeechRecognitionOutput;

  const chunk = Array.isArray(result) ? result[0] : result;
  return ((chunk as { text?: string }).text ?? '').trim();
}
