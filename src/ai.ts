import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import { executeAction } from './automation';
import { speak } from './tts';

let groqClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!groqClient) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada. Adicione-a no arquivo .env');
    groqClient = new OpenAI({
      baseURL: 'https://api.groq.com/openai/v1',
      apiKey,
    });
  }
  return groqClient;
}

const SYSTEM_PROMPT = `Você é uma assistente de IA que vive no desktop do usuário como um personagem animado em anime.
Você é amigável, prestativa e fala em português brasileiro.

Quando o usuário pedir para executar uma ação no computador, responda SOMENTE com um JSON neste formato:
{
  "action": "open_url" | "open_app" | "press_key",
  "params": { ... },
  "speech": "O que você fala em voz alta"
}

Ações disponíveis:
- "open_url": params = { "url": "https://..." }
- "open_app": params = { "app": "chrome" | "firefox" | "edge" | "vscode" | "notepad" | "calculator" | "explorer" | "terminal" | "spotify" }
- "press_key": params = { "key": "enter" | "escape" | "tab" | "f5" }

Exemplos:
- "Abre o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Abrindo o YouTube!" }
- "Pesquisa gatos no Google" → { "action": "open_url", "params": { "url": "https://www.google.com/search?q=gatos" }, "speech": "Pesquisando gatos no Google!" }
- "Abre o Chrome" → { "action": "open_app", "params": { "app": "chrome" }, "speech": "Abrindo o Chrome!" }
- "Abre o VS Code" → { "action": "open_app", "params": { "app": "vscode" }, "speech": "Abrindo o VS Code!" }

Para conversa normal (sem ação), responda como texto normal. Seja breve e simpática.`;

type Message = { role: 'user' | 'assistant'; content: string };
const history: Message[] = [];

export async function transcribeAudio(buffer: Buffer): Promise<string> {
  const file = new File([new Uint8Array(buffer)], 'audio.webm', { type: 'audio/webm' });
  const result = await getClient().audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'pt',
    prompt: 'Assistente de IA pessoal em português brasileiro. Comandos de voz para computador.',
  });
  return result.text.trim();
}

export async function processTranscription(
  text: string,
  win: BrowserWindow,
): Promise<{ text: string; action?: string }> {
  try {
    const client = getClient();

    history.push({ role: 'user', content: text });
    // Keep last 10 exchanges
    const recent = history.slice(-10);

    const completion = await client.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...recent],
      max_tokens: 300,
      temperature: 0.7,
    });

    const raw = completion.choices[0]?.message?.content ?? '';
    history.push({ role: 'assistant', content: raw });

    let speechText = raw;
    let actionTaken: string | undefined;

    // Try to parse action JSON from response
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as {
          action: string;
          params: Record<string, string>;
          speech: string;
        };
        if (parsed.action && parsed.speech) {
          speechText = parsed.speech;
          actionTaken = parsed.action;

          await executeAction(parsed.action, parsed.params);
        }
      } catch {
        // Not valid JSON — treat full response as speech
      }
    }

    win.webContents.send('show-message', speechText);

    await speak(speechText, () => {
      win.webContents.send('character-state', 'talking');
    });

    win.webContents.send('character-state', 'idle');
    return { text: speechText, action: actionTaken };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Erro desconhecido';
    const errorSpeech = `Desculpe, ocorreu um erro: ${msg}`;
    win.webContents.send('show-message', errorSpeech);
    win.webContents.send('character-state', 'idle');
    return { text: errorSpeech };
  }
}
