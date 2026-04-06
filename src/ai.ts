import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import { executeAction, captureScreen, executeSteps } from './automation';
import type { ScreenCapture } from './automation';
import { speak } from './tts';
import type { AutomationStep } from './types';
import { logger } from './logger';

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

const SYSTEM_PROMPT = `Você é um assistente de IA chamado Lume que vive no desktop do usuário como um personagem animado em anime.
Você é um mordomo: calmo, tranquilo e educado. Fale sempre em português brasileiro.
Seu nome é Lume. Você é do gênero masculino (ele). Nunca se refira a si mesmo como "ela" ou use termos femininos.

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
- "Abre o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Abrindo o YouTube." }
- "Pesquisa gatos no Google" → { "action": "open_url", "params": { "url": "https://www.google.com/search?q=gatos" }, "speech": "Pesquisando gatos no Google." }
- "Abre o Chrome" → { "action": "open_app", "params": { "app": "chrome" }, "speech": "Abrindo o Chrome." }
- "Abre o VS Code" → { "action": "open_app", "params": { "app": "vscode" }, "speech": "Abrindo o VS Code." }

Para conversa normal (sem ação), responda como texto normal. Seja breve, calmo e educado.`;

type Message = { role: 'user' | 'assistant'; content: string };
const history: Message[] = [];

export async function transcribeAudio(buffer: Buffer): Promise<string> {
  const file = new File([new Uint8Array(buffer)], 'audio.webm', { type: 'audio/webm' });
  const result = await getClient().audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'pt',
    prompt: 'Lume, Lume, Lume.',
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

// ── Layer 1: does the task need screen interaction? ──────────────────────────

async function checkIfTaskNeedsScreen(task: string): Promise<boolean> {
  const client = getClient();
  const question = `Essa tarefa precisa visualizar, clicar em algo, digitar algo ou descrever o que está na tela do computador: "${task}"`;
  logger.info(`[layer1] pergunta: ${question}`);
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você decide se uma tarefa requer acesso à tela do computador (captura de imagem, ver o que está na tela, clicar ou digitar). Responda APENAS com "sim" ou "não".

Exemplos:
- "O que você está vendo na minha tela?" → sim
- "O que tem na minha tela agora?" → sim
- "Descreve minha tela" → sim
- "Clica no botão enviar" → sim
- "Digite olá no campo de texto" → sim
- "Que horas são?" → não
- "Qual a capital do Brasil?" → não
- "Abre o Chrome" → não
- "Como está o tempo hoje?" → não`,
      },
      { role: 'user', content: question },
    ],
    max_tokens: 10,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  logger.info(`[layer1] resposta: "${answer}" → needsScreen=${answer.includes('sim')}`);
  return answer.includes('sim');
}

// ── Layer 1b: does task need interaction (click/type) or just description? ───

async function checkIfTaskNeedsInteraction(task: string): Promise<boolean> {
  const client = getClient();
  logger.info(`[layer1b] verificando se precisa interagir ou apenas descrever: "${task}"`);
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você decide se uma tarefa requer AÇÃO na tela (clicar em algo ou digitar algo) ou apenas DESCRIÇÃO (descrever o que está na tela). Responda APENAS com "ação" ou "descrição".

Regra principal: se a tarefa menciona uma palavra ou texto específico para pesquisar, digitar ou clicar, é SEMPRE "ação", mesmo que seja uma pergunta.

Exemplos:
- "O que você está vendo na minha tela?" → descrição
- "O que tem na minha tela agora?" → descrição
- "Descreve minha tela" → descrição
- "O que está escrito ali?" → descrição
- "Clica no botão enviar" → ação
- "Digite olá no campo de texto" → ação
- "Abre o menu iniciar" → ação
- "Clica em fechar" → ação
- "Você consegue pesquisar pela palavra camisa?" → ação
- "Dá pra pesquisar por notebook?" → ação
- "Pesquisa por tênis aqui" → ação
- "Consegue digitar meu nome no campo?" → ação
- "Você consegue clicar no botão de login?" → ação`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 10,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  const needsInteraction = answer.includes('ação') || answer.includes('acao');
  logger.info(`[layer1b] resposta: "${answer}" → needsInteraction=${needsInteraction}`);
  return needsInteraction;
}

// ── Layer 2: analyze the screen and return steps or description ──────────────

async function analyzeScreenForTask(
  task: string,
  capture: ScreenCapture,
  needsInteraction: boolean,
): Promise<string | AutomationStep[]> {
  const client = getClient();
  const visionModel = process.env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct';
  logger.info(`[layer2] modelo de visão: ${visionModel}`);
  logger.info(`[layer2] tarefa enviada: ${task}`);
  logger.info(`[layer2] imagem base64 tamanho: ${capture.base64.length} chars`);
  logger.info(`[layer2] resolução capturada: ${capture.width}x${capture.height}px`);
  logger.info(`[layer2] modo: ${needsInteraction ? 'automação (passos)' : 'descrição'}`);

  const prompt = needsInteraction
    ? `Você é um assistente de automação. Analise a tela e execute a tarefa: "${task}"

Regras importantes:
- Inclua TODOS os passos necessários para completar a tarefa do início ao fim.
- Se a tarefa envolve pesquisar/buscar algo: inclua o passo de clicar no campo de busca, digitar o texto E clicar no botão de pesquisa/lupa/enter.
- Se a tarefa envolve preencher um formulário: inclua cada campo e o botão de enviar.
- Nunca omita o passo final de confirmar/enviar/pesquisar.

Responda APENAS com um array JSON. Use x_pct e y_pct como valores decimais entre 0.0 e 1.0 representando a posição relativa na imagem (0.0 = esquerda/topo, 1.0 = direita/base). Formato obrigatório:
[
  {
    "x_pct": <posição horizontal relativa, ex: 0.306>,
    "y_pct": <posição vertical relativa, ex: 0.111>,
    "need_exclude": <true se precisa limpar o campo antes de digitar, false caso contrário>,
    "need_text": <true se precisa digitar algo, false caso contrário>,
    "insert_text": "<texto a digitar, somente se need_text for true>"
  }
]
Não adicione nenhum texto além do array JSON.`
    : `Descreva em português brasileiro o que você está vendo nessa tela em no máximo 2 frases curtas e objetivas, como se estivesse descrevendo para alguém que não pode ver a tela. Seja direto e conciso.`;

  const completion = await client.chat.completions.create({
    model: visionModel,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${capture.base64}` },
          },
          { type: 'text', text: prompt },
        ],
      },
    ],
    max_tokens: 1024,
    temperature: needsInteraction ? 0.1 : 0.5,
  });

  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  logger.info(`[layer2] resposta bruta: ${raw}`);

  if (needsInteraction) {
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          const parsed = JSON.parse(arrayMatch[0]) as AutomationStep[];
          if (Array.isArray(parsed) && parsed.length > 0) {
            logger.info(`[layer2] retornando ${parsed.length} passo(s) de automação`);
            return parsed;
          }
        } catch {
          // fall through to return as text
        }
      }
    logger.warn('[layer2] JSON de automação inválido, retornando como texto');
    return raw;
  }

  logger.info('[layer2] retornando descrição de texto');
  return raw;
}

// ── Layered orchestrator ─────────────────────────────────────────────────────

async function speakWithState(text: string, win: BrowserWindow): Promise<void> {
  win.webContents.send('show-message', text);
  await speak(text, () => win.webContents.send('character-state', 'talking'));
  win.webContents.send('character-state', 'idle');
}

export async function processLayeredMessage(
  text: string,
  win: BrowserWindow,
): Promise<{ text: string; action?: string }> {
  try {
    logger.info(`[pipeline] tarefa recebida: "${text}"`);

    // Wake word check — accept "lume" and common Whisper mistranscriptions
    const WAKE_VARIANTS = ['lume', 'lumi', 'loome', 'loom'];
    const lower = text.toLowerCase();
    if (!WAKE_VARIANTS.some(w => lower.includes(w))) {
      logger.info('[pipeline] nome "Lume" não encontrado, ignorando');
      return { text: '' };
    }

    // Layer 1: does this task need screen interaction?
    const needsScreen = await checkIfTaskNeedsScreen(text);

    if (!needsScreen) {
      logger.info('[pipeline] caminho direto → IA de texto (sem tela)');
      return processTranscription(text, win);
    }

    // Notify user we are about to do screen work
    const waitMsg = 'Aguarde um momento enquanto executo a atividade...';
    win.webContents.send('show-message', waitMsg);
    speak(waitMsg, () => win.webContents.send('character-state', 'talking')).then(() => {
      win.webContents.send('character-state', 'idle');
    });

    // Layer 1b: description or interaction?
    const needsInteraction = await checkIfTaskNeedsInteraction(text);

    // Capture primary monitor
    logger.info('[pipeline] capturando tela do monitor primário...');
    const capture = await captureScreen();
    logger.info(`[pipeline] tela capturada ${capture.width}x${capture.height}, enviando para IA de visão...`);
    const result = await analyzeScreenForTask(text, capture, needsInteraction);

    if (typeof result === 'string') {
      // Description only — trim to TTS-safe length
      const capped = result.length > 400
        ? result.slice(0, 400).replace(/[^.!?]*$/, '').trim() || result.slice(0, 400)
        : result;
      logger.info(`[pipeline] descrição recebida (${result.length} chars → ${capped.length} para TTS), falando resposta`);
      await speakWithState(capped, win);
      return { text: result };
    }

    // Automation steps
    logger.info(`[pipeline] executando ${result.length} passo(s) de automação (tela ${capture.width}x${capture.height})`);
    await executeSteps(result, capture.width, capture.height);
    const doneMsg = 'Atividade concluída!';
    await speakWithState(doneMsg, win);
    return { text: doneMsg, action: 'screen_automation' };

  } catch (err) {
    console.error('[ai] processLayeredMessage error:', err);
    logger.error('[pipeline] erro na execução', err);
    const failMsg = 'Infelizmente não foi possível executar a atividade informada.';
    await speakWithState(failMsg, win).catch(() => {});
    win.webContents.send('character-state', 'idle');
    return { text: failMsg };
  }
}
