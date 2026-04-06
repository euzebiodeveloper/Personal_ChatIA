import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import { executeAction, captureScreen, executeSteps } from './automation';
import type { ScreenCapture } from './automation';
import { speak } from './tts';
import type { AutomationStep } from './types';
import { logger } from './logger';

let groqClient: OpenAI | null = null;
let geminiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

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

function getGeminiClient(): OpenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new OpenAI({
      baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
      apiKey,
    });
  }
  return geminiClient;
}

function getOpenRouterClient(): OpenAI | null {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  if (!openrouterClient) {
    openrouterClient = new OpenAI({
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey,
    });
  }
  return openrouterClient;
}

const SYSTEM_PROMPT = `Você é um assistente de IA chamado Bruno que vive no desktop do usuário como um personagem animado em anime.
Você é um assistente: calmo, tranquilo e educado. Fale sempre em português brasileiro.
Seu nome é Bruno. Você é do gênero masculino (ele). Nunca se refira a si mesmo como "ela" ou use termos femininos.

Quando o usuário pedir para executar uma ação no computador, responda SOMENTE com um JSON neste formato:
{
  "action": "open_url" | "open_app" | "press_key",
  "params": { ... },
  "speech": "O que você fala em voz alta"
}

Ações disponíveis:
- "open_url": params = { "url": "https://..." } — use APENAS para abrir sites/URLs no navegador
- "open_app": params = { "app": "<nome do executável do app>" } — use para abrir QUALQUER aplicativo instalado no PC (discord, word, excel, steam, obs, whatsapp, teams, vlc, notepad, calculator, explorer, spotify, chrome, firefox, vscode, etc.)
- "press_key": params = { "key": "enter" | "escape" | "tab" | "f5" }

REGRA IMPORTANTE: Se o usuário pedir para abrir um APLICATIVO ou PROGRAMA do computador, use SEMPRE "open_app". NUNCA use "open_url" para abrir aplicativos instalados. Use "open_url" apenas quando o usuário quer acessar um site.

Exemplos:
- "Abre o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Abrindo o YouTube." }
- "Pesquisa gatos no Google" → { "action": "open_url", "params": { "url": "https://www.google.com/search?q=gatos" }, "speech": "Pesquisando gatos no Google." }
- "Abre o Chrome" → { "action": "open_app", "params": { "app": "chrome" }, "speech": "Abrindo o Chrome." }
- "Abre o VS Code" → { "action": "open_app", "params": { "app": "vscode" }, "speech": "Abrindo o VS Code." }
- "Abre o Discord" → { "action": "open_app", "params": { "app": "discord" }, "speech": "Abrindo o Discord." }
- "Abre o Word" → { "action": "open_app", "params": { "app": "word" }, "speech": "Abrindo o Word." }
- "Abre o Steam" → { "action": "open_app", "params": { "app": "steam" }, "speech": "Abrindo o Steam." }
- "Abre o WhatsApp" → { "action": "open_app", "params": { "app": "whatsapp" }, "speech": "Abrindo o WhatsApp." }

Para conversa normal (sem ação), responda como texto normal. Seja breve, calmo e educado.`;

type Message = { role: 'user' | 'assistant'; content: string };
const history: Message[] = [];

export async function transcribeAudio(buffer: Buffer): Promise<string> {
  const file = new File([new Uint8Array(buffer)], 'audio.webm', { type: 'audio/webm' });
  const result = await getClient().audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'pt',
    prompt: 'Bruno,',
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

// ── Layer 0: clean transcription (strip background audio, validate intent) ───

/**
 * Takes raw Whisper output and returns a cleaned command string, or null if
 * it is noise/incoherent. Handles two main problems:
 *   1. Background audio from speakers appended to the user's command
 *   2. Commands that are entirely noise / have no clear instruction
 */
async function normalizeTranscription(raw: string): Promise<string> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você processa transcrições de voz de um assistente chamado "Bruno" (controle de computador por voz, PT-BR).
A transcrição pode conter frases de ruído de fundo (áudio de vídeo/TV tocando ao fundo misturado com a voz do usuário).
IMPORTANTE: o reconhecedor de voz pode transcrever "Bruno" como "Bruna" ou "Buno". Trate essas palavras como equivalentes ao nome "Bruno".

Sua tarefa:
1. Extraia APENAS o comando que o usuário falou para Bruno. Remova apenas frases que sejam CLARAMENTE ruído de fundo de outra pessoa falando ao fundo.
2. PRESERVE INTEGRALMENTE todos os argumentos do comando: nomes, termos de busca, URLs, textos a digitar, números — NADA deve ser removido ou abreviado.
3. Retorne o comando completo substituindo qualquer variante do nome (Bruna, Buno) pelo texto "Bruno,".

Exemplos corretos:
- "Bruno, pesquisa Vinícius 13." → "Bruno, pesquisa Vinícius 13."
- "Bruno abre o YouTube." → "Bruno, abre o YouTube."
- "Bruno aqui no site da Amazon seleciona o tamanho P." → "Bruno, aqui no site da Amazon seleciona o tamanho P."
- "Bruna digita olá mundo no campo de texto." → "Bruno, digita olá mundo no campo de texto."

Retorne APENAS o comando limpo começando com "Bruno,". Sem explicações adicionais.`,
      },
      { role: 'user', content: raw },
    ],
    max_tokens: 150,
    temperature: 0,
  });
  const result = (completion.choices[0]?.message?.content ?? '').trim();
  logger.info(`[layer0] normalização: "${raw}" → "${result}"`);
  return result || raw;
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
- "Abre a calculadora" → não
- "Abre o Spotify" → não
- "Abre o VS Code" → não
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

  // Fast heuristic: if task mentions action verbs, skip LLM call
  const lower = task.toLowerCase();
  const descriptionOnlyPhrases = [
    'o que você está vendo', 'o que tem na tela', 'o que está na tela',
    'descreve a tela', 'descreva a tela', 'o que está escrito', 'o que aparece',
    'me diz o que', 'me fala o que', 'o que é isso', 'o que está aberto',
  ];
  if (descriptionOnlyPhrases.some(p => lower.includes(p))) {
    logger.info(`[layer1b] heurística de descrição → needsInteraction=false`);
    return false;
  }

  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `A tarefa do usuário precisa de AÇÃO na tela (clicar, selecionar, mudar, digitar, abrir algo)?
Responda APENAS "sim" ou "nao".
- Se há qualquer dúvida, responda "sim".
- Só responda "nao" se a tarefa for EXCLUSIVAMENTE pedir para descrever ou ler o que está na tela.

Exemplos:
"O que você está vendo?" → nao
"Descreve minha tela" → nao
"Muda a quantidade para 2" → sim
"Seleciona o tamanho P" → sim
"Mude o select de 1 para 2" → sim
"Clica no botão" → sim
"Abre o Chrome" → sim
"Pesquisa por tênis" → sim`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 5,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  // Default to true (interaction) when uncertain
  const needsInteraction = !answer.startsWith('nao') && !answer.startsWith('não');
  logger.info(`[layer1b] resposta: "${answer}" → needsInteraction=${needsInteraction}`);
  return needsInteraction;
}

// ── Layer 2: analyze the screen and return steps or description ──────────────

async function callVisionModel(
  client: OpenAI,
  model: string,
  prompt: string,
  capture: ScreenCapture,
  needsInteraction: boolean,
): Promise<string> {
  const completion = await client.chat.completions.create({
    model,
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
    max_tokens: 2048,
    temperature: needsInteraction ? 0.1 : 0.5,
  });
  return (completion.choices[0]?.message?.content ?? '').trim();
}

async function tryVisionProvider(
  client: OpenAI,
  model: string,
  prompt: string,
  capture: ScreenCapture,
  needsInteraction: boolean,
  providerName: string,
): Promise<string | null> {
  try {
    logger.info(`[layer2] usando ${providerName} (${model})`);
    const raw = await callVisionModel(client, model, prompt, capture, needsInteraction);
    logger.info(`[layer2] ${providerName} OK`);
    return raw;
  } catch (err: any) {
    const status = err?.status ?? err?.code;
    logger.warn(`[layer2] ${providerName} falhou (status=${status}) — pulando para próximo provider`);
    return null;
  }
}

async function analyzeScreenForTask(
  task: string,
  capture: ScreenCapture,
  needsInteraction: boolean,
  requeryContext?: string,
): Promise<string | AutomationStep[]> {
  logger.info(`[layer2] tarefa enviada: ${task}`);
  logger.info(`[layer2] imagem base64 tamanho: ${capture.base64.length} chars`);
  logger.info(`[layer2] resolução capturada: ${capture.width}x${capture.height}px`);
  logger.info(`[layer2] modo: ${needsInteraction ? 'automação (passos)' : 'descrição'}${requeryContext ? ' [requery]' : ''}`);

  const taskDescription = requeryContext
    ? `Tarefa original: "${task}"\nContexto: ${requeryContext}`
    : `"${task}"`;

  const prompt = needsInteraction
    ? `Você é um assistente de automação visual. Analise a imagem da tela e execute a tarefa: ${taskDescription}

Regras gerais:
- Se o elemento pedido NÃO está visível na tela, retorne [] imediatamente. NUNCA chute coordenadas.
- Inclua TODOS os passos necessários do início ao fim.
- Nunca omita o passo final de confirmar/enviar/pesquisar.

IDENTIFICAÇÃO VISUAL DE ELEMENTOS — para cada passo:
1. Observe a imagem e identifique visualmente o elemento alvo (campo de texto, botão, link, ícone, etc.).
2. Estime as 4 bordas do elemento em valores percentuais (x_left, x_right, y_top, y_bottom entre 0.0 e 1.0).
3. Calcule o centro: x_pct = (x_left + x_right) / 2, y_pct = (y_top + y_bottom) / 2.
4. Registre o raciocínio no campo "reasoning".
5. Se não conseguir localizar o elemento com clareza, retorne [].

Dicas de interface universais:
- Rótulos/labels (ex: "Tamanho:", "Cor:", "Quantidade:") são textos descritivos NÃO clicáveis. O elemento interativo (botão, campo, seletor) fica visualmente ABAIXO ou AO LADO do rótulo — clique no elemento, não no rótulo.
- A barra de endereços do navegador é o campo no topo da janela do browser (y muito baixo, próximo de 0.03–0.06). Use-a para navegar para URLs, não campos de busca dentro de sites.
- Campos de busca dentro de sites (ex: barra de pesquisa do YouTube, Amazon, Google) são visualmente identificáveis pela lupa ou placeholder como "Pesquisar...". Clique no centro do campo, não na lupa.
- SELECT/DROPDOWN (caixas com seta ▼ ao lado): são elementos de seleção, NÃO campos de texto. Se identificar um select/dropdown, defina element_type="select", need_exclude=false, need_text=false, requery=true — apenas clique para abrir o dropdown. Na próxima análise (após requery), a tela mostrará as opções abertas e você deverá clicar na opção desejada.
- INPUT de texto (campo sem seta, com cursor): use need_exclude=true se precisar limpar antes, need_text=true para digitar, element_type="input".

Responda APENAS com um array JSON:
[
  {
    "reasoning": "<descreva o elemento encontrado, seu tipo e como calculou o centro>",
    "element_type": "<input | select | button | link | other>",
    "x_pct": <centro horizontal, ex: 0.306>,
    "y_pct": <centro vertical, ex: 0.111>,
    "need_exclude": <true APENAS para inputs de texto que precisam ser limpos antes de digitar — NUNCA use em selects ou botões>,
    "need_text": <true APENAS para inputs de texto onde é preciso digitar algo — NUNCA use em selects ou botões>,
    "insert_text": "<texto a digitar, somente se need_text for true>",
    "press_enter": <true se deve pressionar Enter após digitar>,
    "requery": <true se após este clique a tela vai mudar e será necessária uma nova análise visual — obrigatório para selects/dropdowns>
  }
]
Não adicione nenhum texto além do array JSON.`
    : `Descreva em português brasileiro o que você está vendo nessa tela em no máximo 2 frases curtas e objetivas, como se estivesse descrevendo para alguém que não pode ver a tela. Seja direto e conciso.`;

  // Vision model chain: OpenRouter (primary) → Gemini (fallback) → Groq (last resort)
  const OPENROUTER_MODEL = 'qwen/qwen3.6-plus:free';
  const GEMINI_MODEL = 'gemini-2.5-flash';
  const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL ?? 'meta-llama/llama-4-scout-17b-16e-instruct';

  let raw = '';

  const openrouter = getOpenRouterClient();
  if (openrouter) {
    const result = await tryVisionProvider(openrouter, OPENROUTER_MODEL, prompt, capture, needsInteraction, 'OpenRouter');
    if (result !== null) raw = result;
  } else {
    logger.info('[layer2] OPENROUTER_API_KEY não configurada — pulando para Gemini');
  }

  if (!raw) {
    const gemini = getGeminiClient();
    if (gemini) {
      const result = await tryVisionProvider(gemini, GEMINI_MODEL, prompt, capture, needsInteraction, 'Gemini');
      if (result !== null) raw = result;
    } else {
      logger.info('[layer2] GEMINI_API_KEY não configurada — pulando para Groq');
    }
  }

  if (!raw) {
    logger.info(`[layer2] fallback final: Groq (${GROQ_VISION_MODEL})`);
    raw = await callVisionModel(getClient(), GROQ_VISION_MODEL, prompt, capture, needsInteraction);
  }

  logger.info(`[layer2] resposta bruta: ${raw}`);

  if (needsInteraction) {
    const arrayMatch = raw.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        try {
          const parsed = JSON.parse(arrayMatch[0]) as AutomationStep[];
          if (!Array.isArray(parsed) || parsed.length === 0) {
            logger.warn('[layer2] modelo retornou array vazio — elemento não encontrado na tela');
            return 'Não consegui localizar o elemento pedido na tela atual.';
          }
          // Reject "not found" fallbacks: (0.5,0.5) = center screen, (0,0) = top-left corner
          const isCenterFallback = parsed.length === 1 && parsed[0].x_pct === 0.5 && parsed[0].y_pct === 0.5;
          const isOriginFallback = parsed.length === 1 && parsed[0].x_pct === 0.0 && parsed[0].y_pct === 0.0;
          if (isCenterFallback || isOriginFallback) {
            logger.warn(`[layer2] modelo retornou coordenada de fallback (${parsed[0].x_pct},${parsed[0].y_pct}) — elemento não encontrado na tela`);
            return 'Não consegui localizar o elemento pedido na tela atual.';
          }
          logger.info(`[layer2] retornando ${parsed.length} passo(s) de automação`);
          return parsed;
        } catch {
          // fall through to return as text
        }
      }
    logger.warn('[layer2] JSON de automação inválido, retornando como texto');
    return 'Não foi possível interpretar a resposta da IA de visão.';
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

    // Wake word check — known Whisper pt-BR variants of "Bruno"
    const WAKE_VARIANTS = ['bruno', 'bruna', 'buno'];
    const lower = text.toLowerCase();
    if (!WAKE_VARIANTS.some(w => lower.startsWith(w) || lower.includes(` ${w}`) || lower.includes(`,${w}`))) {
      logger.info('[pipeline] wake word "Bruno" não encontrado, ignorando');
      return { text: '' };
    }

    // Layer 0: clean transcription — strip background audio, normalize Bruno variants
    const task = await normalizeTranscription(text);
    logger.info(`[pipeline] tarefa normalizada: "${task}"`);

    // Layer 1: does this task need screen interaction?
    const needsScreen = await checkIfTaskNeedsScreen(task);

    if (!needsScreen) {
      logger.info('[pipeline] caminho direto → IA de texto (sem tela)');
      return processTranscription(task, win);
    }

    // Notify user we are about to do screen work
    const waitMsg = 'Aguarde um momento enquanto executo a atividade...';
    win.webContents.send('show-message', waitMsg);
    speak(waitMsg, () => win.webContents.send('character-state', 'talking')).then(() => {
      win.webContents.send('character-state', 'idle');
    });

    // Layer 1b: description or interaction?
    const needsInteraction = await checkIfTaskNeedsInteraction(task);

    // Capture primary monitor
    logger.info('[pipeline] capturando tela do monitor primário...');
    const capture = await captureScreen();
    logger.info(`[pipeline] tela capturada ${capture.width}x${capture.height}, enviando para IA de visão...`);
    const result = await analyzeScreenForTask(task, capture, needsInteraction);

    if (typeof result === 'string') {
      // Description only — trim to TTS-safe length
      const capped = result.length > 400
        ? result.slice(0, 400).replace(/[^.!?]*$/, '').trim() || result.slice(0, 400)
        : result;
      logger.info(`[pipeline] descrição recebida (${result.length} chars → ${capped.length} para TTS), falando resposta`);
      await speakWithState(capped, win);
      return { text: result };
    }

    // Automation steps — with requery support for multi-stage interactions (e.g. dropdowns)
    const MAX_REQUERY = 3;
    let steps = result;
    let currentCapture = capture;
    let requeries = 0;

    while (steps.length > 0) {
      const reqIdx = steps.findIndex(s => s.requery);
      if (reqIdx !== -1) {
        // Execute up to and including the requery step (opens dropdown, etc.)
        logger.info(`[pipeline] executando ${reqIdx + 1} passo(s) antes de re-consulta (tela ${currentCapture.width}x${currentCapture.height})`);
        await executeSteps(steps.slice(0, reqIdx + 1), currentCapture.width, currentCapture.height);
        if (requeries >= MAX_REQUERY) {
          logger.warn('[pipeline] limite de re-consultas atingido');
          break;
        }
        requeries++;
        await new Promise(r => setTimeout(r, 800)); // wait for UI to update
        logger.info(`[pipeline] re-consulta ${requeries} — capturando tela após abertura de elemento`);
        currentCapture = await captureScreen();
        const reContext = `Um dropdown/select foi clicado e deve estar aberto agora na tela. Localize a opção desejada entre as opções ABERTAS/VISÍVEIS e clique nela diretamente. NÃO clique no select novamente para abri-lo — ele já está aberto. NÃO use requery:true nesta etapa.`;
        const reResult = await analyzeScreenForTask(task, currentCapture, true, reContext);
        if (typeof reResult === 'string' || reResult.length === 0) break;
        steps = reResult;
      } else {
        logger.info(`[pipeline] executando ${steps.length} passo(s) de automação (tela ${currentCapture.width}x${currentCapture.height})`);
        await executeSteps(steps, currentCapture.width, currentCapture.height);
        break;
      }
    }

    const doneMsg = 'Atividade concluída!';
    await speakWithState(doneMsg, win);
    return { text: doneMsg, action: 'screen_automation' };

  } catch (err: any) {
    console.error('[ai] processLayeredMessage error:', err);
    logger.error('[pipeline] erro na execução', err);
    let failMsg = 'Infelizmente não foi possível executar a atividade informada.';
    if (err?.status === 429 || err?.code === 'rate_limit_exceeded') {
      const retryAfter = err?.headers?.get?.('retry-after');
      const wait = retryAfter ? ` Tente novamente em ${Math.ceil(Number(retryAfter) / 60)} minutos.` : ' Os limites diários de uso foram atingidos. Tente novamente amanhã.';
      failMsg = `Atingi o limite de uso da IA de visão por hoje.${wait}`;
      logger.warn('[pipeline] rate limit 429 atingido na IA de visão');
    }
    await speakWithState(failMsg, win).catch(() => {});
    win.webContents.send('character-state', 'idle');
    return { text: failMsg };
  }
}
