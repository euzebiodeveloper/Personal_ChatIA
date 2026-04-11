import OpenAI from 'openai';
import type { BrowserWindow } from 'electron';
import { executeAction, captureScreen, executeSteps, pressKeyCombo, focusBrowserWindow, openNewBrowserTab } from './automation';
import type { ScreenCapture } from './automation';
import { getActiveWindow, executeFileSystemAction } from './context';
import { isBrowserExtensionConnected, waitForExtension, queryDom, findDomByText, executeDomAction, findDomAndExecute, requestBrowserAction } from './bridge';
import type { DomElement, DomAction } from './bridge';
import { speak } from './tts';
import type { AutomationStep } from './types';
import { logger } from './logger';

let groqClient: OpenAI | null = null;
let geminiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;
let togetherClient: OpenAI | null = null;

// Simple in-process debounce/deduplication for pipeline tasks.
const recentTaskTimestamps = new Map<string, number>();
const activeTaskKeys = new Set<string>();
const DUPLICATE_WINDOW_MS = 3000; // ms — ignore repeated identical tasks within this window
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

function getTogetherClient(): OpenAI | null {
  const apiKey = process.env.TOGETHER_API_KEY;
  if (!apiKey) return null;
  if (!togetherClient) {
    togetherClient = new OpenAI({
      baseURL: 'https://api.together.ai/v1',
      apiKey,
    });
  }
  return togetherClient;
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
- "open_url": params = { "url": "https://...", "browser": "<chrome|firefox|edge>" (opcional) } — use para abrir sites/URLs no navegador; inclua "browser" se o usuário especificar qual navegador usar
- "open_app": params = { "app": "<nome do executável do app>" } — use para abrir QUALQUER aplicativo instalado no PC (discord, word, excel, steam, obs, whatsapp, teams, vlc, notepad, calculator, explorer, spotify, chrome, firefox, vscode, etc.)
- "press_key": params = { "key": "enter" | "escape" | "tab" | "f5" }

REGRA IMPORTANTE: Se o usuário pedir para abrir um APLICATIVO ou PROGRAMA do computador, use SEMPRE "open_app". NUNCA use "open_url" para abrir aplicativos instalados. Use "open_url" apenas quando o usuário quer acessar um site.

Exemplos:
- "Abre o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Abrindo o YouTube." }
- "Abre o YouTube no Chrome" → { "action": "open_url", "params": { "url": "https://youtube.com", "browser": "chrome" }, "speech": "Abrindo o YouTube no Chrome." }
- "Abra o site da Amazon no navegador Google Chrome" → { "action": "open_url", "params": { "url": "https://amazon.com", "browser": "chrome" }, "speech": "Abrindo a Amazon no Chrome." }
- "Pesquisa gatos no Google" → { "action": "open_url", "params": { "url": "https://www.google.com/search?q=gatos" }, "speech": "Pesquisando gatos no Google." }
- "Pesquisa gatos no Google Chrome" → { "action": "open_url", "params": { "url": "https://www.google.com/search?q=gatos", "browser": "chrome" }, "speech": "Pesquisando gatos no Google Chrome." }
- "Abre o Chrome" → { "action": "open_app", "params": { "app": "chrome" }, "speech": "Abrindo o Chrome." }
- "Abre o VS Code" → { "action": "open_app", "params": { "app": "vscode" }, "speech": "Abrindo o VS Code." }
- "Abre o Discord" → { "action": "open_app", "params": { "app": "discord" }, "speech": "Abrindo o Discord." }
- "Abre o Word" → { "action": "open_app", "params": { "app": "word" }, "speech": "Abrindo o Word." }
- "Abre o Steam" → { "action": "open_app", "params": { "app": "steam" }, "speech": "Abrindo o Steam." }
- "Abre o WhatsApp" → { "action": "open_app", "params": { "app": "whatsapp" }, "speech": "Abrindo o WhatsApp." }
- "Retorne para o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Voltando para o YouTube." }
- "Volte para o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Voltando para o YouTube." }
- "Vá para o YouTube" → { "action": "open_url", "params": { "url": "https://youtube.com" }, "speech": "Indo para o YouTube." }
- "Me leva para o Netflix" → { "action": "open_url", "params": { "url": "https://netflix.com" }, "speech": "Abrindo o Netflix." }

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

// ── Layer 0b: is the transcription a coherent command/question? ─────────────

async function checkIfTaskIsCoherent(task: string): Promise<boolean> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você é um classificador binário. Sua ÚNICA função é decidir se uma transcrição de voz é uma instrução ou pergunta coerente (PT-BR).
RESPONDA EXCLUSIVAMENTE com a palavra "sim" ou a palavra "não". NENHUMA outra palavra. NENHUMA explicação. NENHUMA pontuação.

Regra: responda "sim" se o texto for uma instrução, pedido ou pergunta que um assistente pode executar ou responder.
Responda "não" se for ruído, frase solta, comentário sem sentido como comando, ou resposta afirmativa genérica.

Exemplos:
"Abre o Chrome." → sim
"Qual a capital do Brasil?" → sim
"O que está na tela?" → sim
"Pesquisa por tênis no Google." → sim
"Como você está?" → sim
"Clica no botão enviar." → sim
"Fecha a janela." → sim
"Preenche esse formulário com dados fictícios." → sim
"Consegue preencher esse formulário para mim?" → sim
"Você consegue preencher todo esse formulário com dados específicos?" → sim
"Clique no vídeo com o cavalo." → sim
"Retorne para o YouTube." → sim
"Continuo atendendo." → não
"É isso mesmo." → não
"Tá certo." → não
"Com certeza." → não
"Pode ser." → não
"Muito obrigado." → não
"Obrigado." → não
"Obrigada." → não
"E aí" → não
"Hum." → não`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 3,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  // Accept "sim" explicitly; treat anything that isn't clearly "não" as coherent
  // to avoid false negatives (e.g. model returning "sim, ..." or "claro")
  const isIncoherent = answer.startsWith('não') || answer.startsWith('nao');
  const isCoherent = !isIncoherent;
  logger.info(`[layer0b] coerência: "${answer}" → coherent=${isCoherent}`);
  return isCoherent;
}

// ── Layer 1a: is this a direct OS action that needs no screen capture? ────────

async function checkIfDirectOSAction(task: string): Promise<boolean> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você classifica tarefas de controle de computador por voz (PT-BR).
Responda APENAS "sim" se a tarefa pode ser executada DIRETAMENTE pelo sistema operacional SEM precisar capturar ou visualizar a tela. Responda "não" em todos os outros casos.

São ações diretas do SO — responda "sim":
- Abrir aplicativos instalados (calculadora, Excel, Word, Chrome, Discord, Steam, VS Code, Spotify, WhatsApp, Notepad, Paint, etc.)
- Abrir sites ou URLs (YouTube, Google, Amazon, GitHub, etc.) — com ou sem especificar o navegador
- Navegar para um site em um navegador específico (Chrome, Firefox, Edge, etc.)
- Pesquisar algo no Google ou na web
- Pressionar teclas do teclado (Enter, Escape, Tab, F5, etc.)
- Minimizar, maximizar ou fechar a janela ativa

Precisam ver a tela antes de agir — responda "não":
- Clicar em algum botão, link, ícone ou campo visível na tela agora
- Preencher ou digitar em campos específicos de formulário
- Selecionar opções visíveis na tela (dropdowns, checkboxes, radio buttons)
- Descrever, ler ou analisar o que está mostrando na tela agora
- Alterar um valor ou elemento que está visível na tela
- Qualquer ação que dependa do estado atual da tela

Exemplos:
"Abre a calculadora" → sim
"Abre o Chrome" → sim
"Abre o YouTube" → sim
"Abre o YouTube no Chrome" → sim
"Abre o site da Amazon" → sim
"Abra o site da Amazon no navegador Google Chrome" → sim
"Agora abra o site da Amazon no navegador Google Chrome" → sim
"Abre o Netflix no Firefox" → sim
"Pesquisa gatos no Google" → sim
"Pesquisa gatos no Google Chrome" → sim
"Abre o Discord" → sim
"Abre o Word" → sim
"Abre o Steam" → sim
"Abre o Spotify" → sim
"Abre o VS Code" → sim
"Clica no botão enviar" → não
"Seleciona o tamanho P" → não
"Seleciona a opção CSS3" → não
"Marque o checkbox HTML5" → não
"Preenche o campo de nome com João" → não
"O que está na minha tela?" → não
"Mude o select de 1 para 2" → não
"Digita olá no campo de texto" → não
"O que está aberto no meu computador?" → não`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 5,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  const isDirect = answer.includes('sim');
  logger.info(`[layer1a] ação direta no SO: "${answer}" → directOS=${isDirect}`);
  return isDirect;
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
            image_url: { url: `data:image/jpeg;base64,${capture.base64}` },
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

REGRA CRÍTICA sobre requery:
- requery=true SOMENTE quando o clique **abre um menu/dropdown** cujas opções precisam ser vistas numa próxima análise. EXEMPLOS: abrir um <select>, abrir um menu de contexto.
- requery=false para TODO o resto: botões de ação (voltar, avançar, enviar, fechar, confirmar, cadastrar), links de navegação, checkboxes, radio buttons, botão de busca, botão de voltar do browser, qualquer botão que apenas executa uma ação direta.
- NUNCA use requery=true em botões de navegação do browser (← voltar, → avançar, ↺ reload) — esses são ações terminais, executam e pronto.

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
    "requery": <true SOMENTE para selects/dropdowns que precisam ser abertos para ver as opções — false para qualquer botão de ação>
  }
]
Não adicione nenhum texto além do array JSON.`
    : `Descreva em português brasileiro o que você está vendo nessa tela em no máximo 2 frases curtas e objetivas, como se estivesse descrevendo para alguém que não pode ver a tela. Seja direto e conciso.`;

  // Vision model chain:
  //   1. Groq  meta-llama/llama-4-scout-17b-16e-instruct
  //   2. Gemini 2.5 Flash (last resort)
  const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
  const GEMINI_25_MODEL   = 'gemini-2.5-flash';

  let raw = '';

  const groq = getClient();
  const groqResult = await tryVisionProvider(groq, GROQ_VISION_MODEL, prompt, capture, needsInteraction, 'Groq (Llama 4 Scout)');
  if (groqResult !== null) raw = groqResult;

  if (!raw) {
    const gemini = getGeminiClient();
    if (gemini) {
      const result = await tryVisionProvider(gemini, GEMINI_25_MODEL, prompt, capture, needsInteraction, 'Gemini 2.5 Flash');
      if (result !== null) raw = result;
    } else {
      logger.info('[layer2] GEMINI_API_KEY não configurada — nenhum provider disponível');
    }
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

// ── DOM action resolver (browser path) ──────────────────────────────────────

// ── DOM action resolver ──────────────────────────────────────────────────────

/** Synonym map for common UI action keywords (PT ↔ EN and nicknames). */
const CLICK_SYNONYMS: Record<string, string[]> = {
  play:        ['play', 'reproduzir', 'iniciar', 'reprodução', 'assistir', 'tocar', 'resume'],
  pause:       ['pause', 'pausar', 'parar', 'stop'],
  like:        ['like', 'gostei', 'curtir', 'curtiu', 'gostar'],
  dislike:     ['dislike', 'não gostei', 'descurtir'],
  subscribe:   ['subscribe', 'inscrever', 'inscreva', 'inscrição'],
  sininho:     ['sininho', 'notificação', 'notification', 'bell', 'notify'],
  share:       ['share', 'compartilhar', 'compartilhe'],
  save:        ['save', 'salvar', 'salve'],
  fullscreen:  ['fullscreen', 'tela cheia', 'maximizar', 'expand'],
  mute:        ['mute', 'mutar', 'silenciar', 'silencioso'],
  unmute:      ['unmute', 'desmutar', 'ativar som', 'som'],
  next:        ['next', 'próximo', 'avançar'],
  previous:    ['previous', 'anterior', 'voltar'],
  close:       ['close', 'fechar', 'fecha', 'x'],
  send:        ['send', 'enviar', 'envie', 'submit'],
  login:       ['login', 'entrar', 'sign in', 'signin'],
  logout:      ['logout', 'sair', 'sign out'],
  confirm:     ['confirm', 'confirmar', 'ok', 'yes', 'sim'],
  cancel:      ['cancel', 'cancelar', 'não', 'no'],
  add:         ['add', 'adicionar', 'adicione'],
  remove:      ['remove', 'remover', 'excluir', 'deletar', 'delete'],
  menu:        ['menu', 'hamburguer', 'nav'],  // 'guia' removido — é sinônimo de 'aba/tab' no contexto PT-BR
  settings:    ['settings', 'configurações', 'config', 'opções'],
  download:    ['download', 'baixar', 'baixe'],
};

// Flat list of all synonyms for quick intent detection
const ALL_CLICK_TARGETS = Object.values(CLICK_SYNONYMS).flat();

/** Classify task intent to determine which element types are relevant. */
function classifyDomIntent(task: string): 'search' | 'type' | 'click' | 'select' | 'fill_form' | 'unknown' {
  // Form fill: must check before generic type/preenche so it gets priority
  if (/formulár|formulari|todos.*campos?|preenche.*(?:todo|formulár|form)|(?:todo|formulár|form).*preenche/i.test(task)) return 'fill_form';
  if (/pesquis|busca|procura|search/i.test(task)) return 'search';
  if (/digit|escrev|preenche|insere|coloca|type|fill/i.test(task)) return 'type';
  // "selecione/selecionar" no contexto web = clicar em produto/link, não <select> dropdown
  if (/cliq(?:ue|ui|a)|pressiona|aperta|click|press|enviar|submit|ativ[ae]|aciona|habilit|liga\b|selecione?r?|escolha\b/i.test(task)) return 'click';
  // <select> dropdown: precisa mencionar explicitamente opção/dropdown
  if (/seleciona\s+(?:a\s+)?op[çc][aã]o|dropdown|select.*option|choose.*option/i.test(task)) return 'select';

  // Intent by target noun — even without a verb, these imply click
  const words = task.toLowerCase().split(/[\s,./]+/);
  if (words.some(w => ALL_CLICK_TARGETS.includes(w))) return 'click';

  return 'unknown';
}

// ── Layer 1-DOM: AI-driven intent resolution (fallback when regex is ambiguous) ─
async function resolveAiDomIntent(task: string): Promise<'search' | 'click' | 'type' | 'select' | 'fill_form' | 'unknown'> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você analisa uma instrução de automação web e decide qual ação DOM executar.
Responda APENAS com uma dessas palavras: search | click | type | select | fill_form

- search: buscar/pesquisar algo (digitar no campo de busca e submeter)
- click: clicar em elemento específico, produto, link, botão, imagem ou item de lista
- type: digitar/preencher um campo sem submeter
- select: escolher opção de um menu dropdown HTML (<select>)
- fill_form: preencher todos os campos de um formulário inteiro

Exemplos:
"pesquise camisa branca" → search
"selecione a camisa amarela" → click
"clique no produto" → click
"escolha a cor azul no dropdown" → select
"preencha o nome com João" → type
"ative o filtro de preço" → click
"coloque o CEP no campo" → type
"preencha esse formulário com dados fictícios" → fill_form
"consegue preencher todo esse formulário?" → fill_form
"preencha todos os campos do formulário" → fill_form`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 10,
    temperature: 0,
  });
  const answer = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
  const INTENTS = ['search', 'click', 'type', 'select', 'fill_form'] as const;
  const found = INTENTS.find(i => answer.includes(i));
  logger.info(`[layer1dom] intenção DOM via IA: "${answer}" → intent=${found ?? 'unknown'}`);
  return found ?? 'unknown';
}

// ── Vision-assisted click target identification ──────────────────────────────
/**
 * Sends a screenshot to Groq's vision model (llama-4-scout) and asks it to
 * identify the visible text / label of the element that should be clicked.
 * Returns { phrase: raw text, keywords: filtered meaningful words }.
 */
async function identifyClickTargetViaVision(
  task: string,
  capture: ScreenCapture,
): Promise<{ phrase: string; keywords: string[] }> {
  const client = getClient(); // Groq
  try {
    const completion = await client.chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${capture.base64}` },
            },
            {
              type: 'text',
              text: `Task: "${task}"

Look at this screenshot. What is the EXACT visible text, title or identifier of the element that should be clicked to complete this task?
Reply with ONLY that text (max 20 words). No explanation, no punctuation beyond the text itself.`,
            },
          ],
        },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const phrase = (completion.choices[0]?.message?.content ?? '').toLowerCase().trim();
    logger.info(`[vision-click] Groq Scout identificou: "${phrase}"`);
    // PT-BR + EN stop words — words that are too common to be useful as identifiers
    const STOP = /^(?:no|na|em|o|a|os|as|um|uma|the|in|on|at|de|do|da|dos|das|para|pra|por|com|and|or|e|ou|click|clique|button|botão|link|produto|element|elemento|is|are|that|this|which|would|should|que|essa|esse|este|esta|isso|isto|aqui|ali|tinha|sido|estar|estava|ter|foi|ser|pelo|pela|pelos|pelas|num|numa|neste|nesta|nessa|nesse|todo|toda|todos|todas|muito|muita|muitos|muitas|mais|menos|bem|mal|ainda|também|mesmo|quando|onde|como|porque|pois|mas|nem|se|seu|sua|seus|suas|meu|minha|tudo|algo|cada|eles|elas|ele|ela|foi|vai|tem|vem|bem|nao|nao|sim|nós)$/i;
    const keywords = phrase
      .split(/[\s,.\-–/]+/)
      .map(w => w.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase())
      .filter(w => w.length > 1 && !STOP.test(w));
    logger.info(`[vision-click] keywords filtrados: [${keywords.join(', ')}]`);
    return { phrase, keywords };
  } catch (err: any) {
    logger.warn(`[vision-click] Groq Scout falhou: ${err.message}`);
    return { phrase: '', keywords: [] };
  }
}

/** Expand keywords with synonyms (both directions). */
function expandWithSynonyms(keywords: string[]): string[] {
  const expanded = new Set(keywords);
  for (const kw of keywords) {
    // Check if kw is in any synonym group
    for (const [, synonyms] of Object.entries(CLICK_SYNONYMS)) {
      if (synonyms.includes(kw)) {
        synonyms.forEach(s => expanded.add(s));
        break;
      }
    }
  }
  return Array.from(expanded);
}

/** Extract target keywords from a click task (what the user wants to click on). */
function extractClickKeywords(task: string): string[] {
  // Strip verb phrases to get the target noun/label
  const stripped = task
    .replace(/^(?:por favor[,\s]+)?(?:cliq(?:ue|ui|a)|pressiona|aperta|click|press|ativ[ae]|aciona|habilit|liga)\s+(?:no|na|em|o|a|the)?\s*/i, '')
    .replace(/(?:\s+(?:aqui|agora|por favor|please))+$/i, '')
    .trim();

  // Split into tokens, remove stop words
  const STOP = /^(?:no|na|em|o|a|os|as|um|uma|the|in|on|at|de|do|da|dos|das|para|pra|por|com|vídeo|video|youtube|página|page|site|botão|button|ícone|icon)$/i;
  const keywords = stripped
    .split(/[\s,./]+/)
    .map(w => w.replace(/[^a-zA-ZÀ-ú0-9]/g, '').toLowerCase())
    .filter(w => w.length > 1 && !STOP.test(w));

  return keywords;
}

/** Score a clickable element against target keywords. */
function scoreClickCandidate(el: DomElement, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const haystack = [el.text, el.ariaLabel, el.id, el.name, el.selector, el.href]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Score keywords against individual label fields to distinguish exact from substring
  // e.g. "play" should score "Play" (exact) higher than "Playlist" (substring)
  const normText  = (el.text     ?? '').toLowerCase().trim();
  const normAria  = (el.ariaLabel ?? '').toLowerCase().trim();

  const kwScore = (src: string, kw: string): number => {
    if (!src) return 0;
    if (src === kw) return 30;
    const idx = src.indexOf(kw);
    if (idx === -1) return 0;
    const before = idx === 0 || src[idx - 1] === ' ';
    const after  = idx + kw.length === src.length || src[idx + kw.length] === ' ';
    if (before && after) return 20;
    return 5;
  };

  let score = 0;
  for (const kw of keywords) {
    const labelScore = Math.max(kwScore(normText, kw), kwScore(normAria, kw));
    if (labelScore > 0) {
      score += labelScore;
    } else if (haystack.includes(kw)) {
      // Fallback: match anywhere (selector, id, href) — lower weight
      score += 3;
    } else if (kw.length >= 4 && haystack.split(/\s+/).some(w => w.startsWith(kw) || kw.startsWith(w))) {
      score += 2;
    }
  }
  return score;
}


function scoreSearchInput(el: DomElement): number {
  if (el.tag !== 'input' && el.tag !== 'textarea') return -1;
  const isTextType = !el.type || ['text', 'search', ''].includes(el.type ?? '');
  if (!isTextType) return -1;

  let score = 0;
  const SEMANTIC = /search|busca|pesquis|query|keyword|consulta|procura/i;
  const STRUCTURAL = /search|query|keyword|busca|pesquis/i;

  // Layer 1: semantic — placeholder and aria-label (highest confidence signals)
  if (SEMANTIC.test(el.placeholder ?? '')) score += 10;
  if (SEMANTIC.test(el.ariaLabel ?? '')) score += 10;
  if (SEMANTIC.test(el.name ?? '')) score += 8;
  // Layer 2: structural — id, role, type
  if (STRUCTURAL.test(el.id ?? '')) score += 8;
  if (el.type === 'search') score += 15;
  if (el.role === 'searchbox') score += 12;
  // Bonus: data attributes hinting at search (agent patched fields)
  if (STRUCTURAL.test(el.selector)) score += 3;

  return score;
}

/** Score an element for search-submit relevance. */
function scoreSearchSubmit(el: DomElement): number {
  const isSubmittable =
    (el.tag === 'input' && (el.type === 'submit' || el.type === 'button')) ||
    el.tag === 'button';
  if (!isSubmittable) return -1;

  let score = 0;
  const SEMANTIC = /search|go|buscar|pesquisar|submit|procurar|lupa|magnif/i;
  const STRUCTURAL = /search|submit|query|busca|pesquis/i;

  // Layer 1: semantic
  if (SEMANTIC.test(el.text ?? '')) score += 10;
  if (SEMANTIC.test(el.ariaLabel ?? '')) score += 10;
  // Layer 2: structural
  if (STRUCTURAL.test(el.id ?? '')) score += 10;
  if (el.type === 'submit') score += 6;
  if (STRUCTURAL.test(el.selector)) score += 3;

  return score;
}

/** Smart element filter using semantic + structural scoring.
 *  Returns the top candidates and whether the result is high-confidence (can skip AI). */
function smartFilterElements(
  elements: DomElement[],
  intent: string,
  task: string,
  visionKeywords?: string[],
): { filtered: DomElement[]; offsetMap: number[]; highConfidence: boolean } {
  // Noise filter: media controls that are irrelevant for non-click tasks
  const NOISE_LABEL = /replay|unmute|mute|fullscreen|volume|seek|captions|subtitles|picture.in.picture|rewind|fast.forward/i;
  const NOISE_SELECTOR = /carousel|slider/i;

  const denoised = intent === 'click'
    ? elements  // for explicit click tasks, keep everything — user said to click something specific
    : elements.filter(el =>
        !NOISE_LABEL.test(el.text ?? '') &&
        !NOISE_LABEL.test(el.ariaLabel ?? '') &&
        !NOISE_SELECTOR.test(el.selector),
      );
  if (intent === 'search') {
    // Score every input for search relevance
    const inputScores = denoised.map((el, i) => ({ el, i: elements.indexOf(el), score: scoreSearchInput(el) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const submitScores = denoised.map((el, i) => ({ el, i: elements.indexOf(el), score: scoreSearchSubmit(el) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    const bestInput = inputScores[0];
    const bestSubmit = submitScores[0];

    // High confidence: clear search input + submit button found
    if (bestInput && bestInput.score >= 8 && bestSubmit && bestSubmit.score >= 6) {
      logger.info(`[dom-filter] high-confidence search: input=[${bestInput.i}] score=${bestInput.score} "${bestInput.el.placeholder ?? bestInput.el.ariaLabel ?? bestInput.el.id}" | submit=[${bestSubmit.i}] score=${bestSubmit.score} "${bestSubmit.el.text ?? bestSubmit.el.ariaLabel ?? bestSubmit.el.id}"`);
      return {
        filtered: [bestInput.el, bestSubmit.el],
        offsetMap: [bestInput.i, bestSubmit.i],
        highConfidence: true,
      };
    }

    // Medium confidence: at least a search input found — add all submit buttons
    if (bestInput && bestInput.score >= 5) {
      const allSubmits = denoised.map((el) => ({ el, i: elements.indexOf(el) }))
        .filter(({ el }) => (el.tag === 'input' && ['submit', 'button'].includes(el.type ?? '')) || el.tag === 'button');
      const combined = [{ el: bestInput.el, i: bestInput.i }, ...allSubmits.slice(0, 10)];
      return { filtered: combined.map(x => x.el), offsetMap: combined.map(x => x.i), highConfidence: false };
    }

    // Fallback: all text inputs + buttons from denoised
    const fallback = denoised.map((el) => ({ el, i: elements.indexOf(el) })).filter(({ el }) =>
      (el.tag === 'input' && (!el.type || ['text', 'search', 'submit', 'button'].includes(el.type ?? ''))) ||
      el.tag === 'button' || el.tag === 'textarea',
    );
    return { filtered: fallback.map(x => x.el), offsetMap: fallback.map(x => x.i), highConfidence: false };
  }

  if (intent === 'fill_form') {
    // Return ALL form-fillable elements: text/email/date/number inputs, textarea,
    // select, radio, checkbox, and the submit button.
    const formEls = denoised.map((el) => ({ el, i: elements.indexOf(el) })).filter(({ el }) => {
      if (el.tag === 'textarea') return true;
      if (el.tag === 'select') return true;
      if (el.tag === 'button' && (el.type === 'submit' || !el.type)) return true;
      if (el.tag === 'input') {
        const t = el.type ?? '';
        return ['text', 'email', 'password', 'tel', 'url', 'date', 'number', 'radio', 'checkbox', 'search', ''].includes(t);
      }
      return false;
    });
    if (formEls.length === 0) return { filtered: denoised.slice(0, 40), offsetMap: denoised.slice(0, 40).map(el => elements.indexOf(el)), highConfidence: false };
    return { filtered: formEls.map(x => x.el), offsetMap: formEls.map(x => x.i), highConfidence: false };
  }

  if (intent === 'type') {
    const inputs = denoised.map((el) => ({ el, i: elements.indexOf(el) })).filter(({ el }) =>
      (el.tag === 'input' && (!el.type || ['text', 'search', 'email', 'password', 'tel', 'url', 'date', 'number', ''].includes(el.type ?? ''))) ||
      el.tag === 'textarea',
    );
    if (inputs.length === 0) return { filtered: denoised.slice(0, 30), offsetMap: denoised.slice(0, 30).map(el => elements.indexOf(el)), highConfidence: false };
    return { filtered: inputs.map(x => x.el), offsetMap: inputs.map(x => x.i), highConfidence: false };
  }

  if (intent === 'click') {
    // keep all elements (denoised === elements for click intent), filter to clickables
    // Include role="button" elements (Amazon size swatches, custom UI components, etc.)
    const btns = elements.map((el, i) => ({ el, i })).filter(({ el }) =>
      el.tag === 'button' || el.tag === 'a' ||
      (el.tag === 'input' && ['submit', 'button'].includes(el.type ?? '')) ||
      el.role === 'button' || el.role === 'option' || el.role === 'radio',
    );
    if (btns.length === 0) return { filtered: elements.slice(0, 30), offsetMap: elements.slice(0, 30).map((_, i) => i), highConfidence: false };

    // Score buttons by keyword match — merge vision keywords (precise) with task keywords (fallback)
    const taskKeywords = extractClickKeywords(task ?? '');
    const mergedRaw = (visionKeywords && visionKeywords.length > 0)
      ? [...new Set([...visionKeywords, ...taskKeywords])]
      : taskKeywords;
    const keywords = expandWithSynonyms(mergedRaw);
    logger.info(`[dom-filter] click keywords (vision=${visionKeywords?.length ?? 0} task=${taskKeywords.length}): [${keywords.join(', ')}]`);
    const scored = btns.map(({ el, i }) => ({ el, i, score: scoreClickCandidate(el, keywords) }));
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0];
    // High confidence: top candidate has a clear keyword match
    if (best && best.score >= 10) {
      logger.info(`[dom-filter] high-confidence click: [${best.i}] score=${best.score} text="${best.el.text}" aria="${best.el.ariaLabel ?? ''}"`);
      return { filtered: [best.el], offsetMap: [best.i], highConfidence: true };
    }

    // Send top 15 candidates to AI (already sorted by relevance)
    const top = scored.slice(0, 15);
    return { filtered: top.map(x => x.el), offsetMap: top.map(x => x.i), highConfidence: false };
  }

  if (intent === 'select') {
    const selects = denoised.map((el) => ({ el, i: elements.indexOf(el) })).filter(({ el }) => el.tag === 'select');
    if (selects.length === 0) return { filtered: denoised.slice(0, 30), offsetMap: denoised.slice(0, 30).map(el => elements.indexOf(el)), highConfidence: false };
    return { filtered: selects.map(x => x.el), offsetMap: selects.map(x => x.i), highConfidence: false };
  }

  // unknown: denoised, capped at 40
  return { filtered: denoised.slice(0, 40), offsetMap: denoised.slice(0, 40).map(el => elements.indexOf(el)), highConfidence: false };
}

/** Extract the search/type value from the task string via regex. */
function extractTypingValue(task: string): string | null {
  // "pesquise camisa" → "camisa"; "busca camisas vermelhas" → "camisas vermelhas"
  // pesquis[ae]r? covers pesquisa / pesquise / pesquisar
  const m = task.match(/(?:pesquis[ae]r?|busca[r]?|procura[r]?|search|digit[ae]|escrev[ae]|preenche[r]?|insir[ae]|coloca[r]?|type|fill)\s+(.+?)(?:\s+(?:no|na|em|in|no\s+site|na\s+barra|no\s+campo|no\s+input).*)?$/i);
  if (!m) return null;
  const raw = m[1].trim();
  // Reject if the extraction is noisy (starts with discourse tokens or is very long)
  const NOISE_START = /^(?:e\s|a\s|o\s|não|para|que|só|apenas|já|aí|isso|aqui|também)/i;
  if (NOISE_START.test(raw) || raw.split(' ').length > 6) return null;
  return raw;
}

/** Ask LLM to extract only the search term from a conversational command. */
async function extractSearchTermViaAI(task: string): Promise<string> {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Extraia APENAS o termo de busca da frase do usuário. Responda somente o termo, sem pontuação, sem explicação.

Exemplos:
"pesquise camisa branca" → camisa branca
"agora pesquisa e calça" → calça
"Não, é para pesquisar calça apenas." → calça
"busca tênis Nike" → tênis Nike
"procura por notebook gamer" → notebook gamer
"quero buscar camiseta polo masculina" → camiseta polo masculina`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 20,
    temperature: 0,
  });
  const result = (completion.choices[0]?.message?.content ?? '').trim();
  logger.info(`[extract-search] IA extraiu: "${result}"`);
  return result || task;
}

/** Infer the DOM action from an element's tag/type/role, without needing AI. */
function inferActionFromElement(el: DomElement): DomAction {
  if (el.tag === 'select') return { kind: 'select', value: el.text ?? '' };
  // Typeable inputs (text-like + date/number)
  if (el.tag === 'input' && (!el.type || ['text', 'search', 'email', 'password', 'tel', 'url', 'date', 'number'].includes(el.type))) {
    return { kind: 'type', value: '', clearFirst: true };
  }
  // textarea
  if (el.tag === 'textarea') return { kind: 'type', value: '', clearFirst: true };
  // Everything else (button, a, input[submit/radio/checkbox], role=button/option/radio): click
  return { kind: 'click' };
}

/**
 * Try to find the target element by direct text/label match against vision keywords.
 * Returns the first element whose text contains ALL vision keywords (case-insensitive).
 * Prefers exact matches over partial, and shorter text over longer (more specific).
 */
function resolveByLabelMatch(
  elements: DomElement[],
  visionKeywords: string[],
): { selector: string; action: DomAction } | null {
  if (visionKeywords.length === 0) return null;

  const lower = visionKeywords.map(k => k.toLowerCase());

  const candidates = elements
    .map((el, i) => ({ el, i }))
    .filter(({ el }) => {
      const hay = `${(el.text ?? '').toLowerCase()} ${(el.ariaLabel ?? '').toLowerCase()}`.trim();
      if (!hay) return false;
      return lower.every(kw => hay.includes(kw));
    });

  if (candidates.length === 0) return null;

  // Prefer exact full-text match, then shortest text (most specific label)
  const exact = candidates.find(({ el }) => {
    const t = (el.text ?? '').toLowerCase().trim();
    return lower.join(' ') === t || (lower.length === 1 && lower[0] === t);
  });
  const { el } = exact ?? candidates.sort((a, b) => (a.el.text?.length ?? 0) - (b.el.text?.length ?? 0))[0];

  const action = inferActionFromElement(el);
  logger.info(`[label-match] tag=${el.tag} type=${el.type ?? ''} role=${el.role ?? ''} text="${el.text}" id="${el.id ?? ''}" → action=${action.kind}`);
  return { selector: el.selector, action };
}

type DomActionResult = {
  steps: Array<{ selector: string; action: DomAction; verifyText?: string; verifyHref?: string }>;
  postMsg?: string; // optional message to speak after all steps are done
};

async function resolveDomAction(
  task: string,
  elements: DomElement[],
): Promise<DomActionResult | null> {
  const client = getClient();

  let intent = classifyDomIntent(task);
  // Quando o regex é ambíguo, pergunta à IA qual é o intent correto antes de filtrar
  if (intent === 'unknown') {
    intent = await resolveAiDomIntent(task);
  }

  // Para tarefas de click: usa visão para identificar o texto do elemento alvo,
  // depois compara diretamente contra o snapshot de elementos já coletados (sem nova
  // travessia do DOM, evitando reciclagem de nós no virtual scroll do YouTube/TikTok).
  let visionKeywords: string[] = [];
  if (intent === 'click') {
    try {
      const capture = await captureScreen();
      const vision = await identifyClickTargetViaVision(task, capture);
      visionKeywords = vision.keywords;

      if (vision.phrase && vision.keywords.length > 0) {
        // ── Fase 1: correspondência direta no snapshot de elements ─────────────
        // Pontua cada elemento por quantas palavras da frase aparecem no texto/ariaLabel.
        // Não faz nova travessia do DOM — usa o snapshot que já temos.
        const phraseWords = vision.keywords; // já filtrados de stop words
        logger.info(`[dom-find] buscando no snapshot por: [${phraseWords.join(', ')}]`);

        let bestSnap: { el: DomElement; score: number } | null = null;
        for (const el of elements) {
          const hay = [el.text, el.ariaLabel, el.id, el.name]
            .filter(Boolean).join(' ').toLowerCase();
          if (!hay) continue;
          const score = phraseWords.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0);
          if (!bestSnap || score > bestSnap.score) bestSnap = { el, score };
        }

        const minScore = Math.max(1, Math.ceil(phraseWords.length * 0.4));
        if (bestSnap && bestSnap.score >= minScore) {
          const el = bestSnap.el;
          logger.info(`[vision-match] score=${bestSnap.score}/${phraseWords.length} tag=${el.tag} text="${el.text}" href="${el.href ?? ''}"`);
          return { steps: [{ selector: el.selector, action: { kind: 'click' }, verifyText: el.text || el.ariaLabel, verifyHref: el.href }] };
        }

        // ── Fase 2: fallback — pede extensão para buscar com synonyms ──────────
        logger.info(`[dom-find] snapshot sem match suficiente (score=${bestSnap?.score ?? 0}/${phraseWords.length}) — tentando dom_find_and_execute`);
        try {
          const expandedKeywords = expandWithSynonyms(visionKeywords);
          const anyOf = visionKeywords.map(kw => expandWithSynonyms([kw]));
          const found = await findDomAndExecute(visionKeywords, { kind: 'click' }, 8000, anyOf);
          if (found.length > 0) {
            const best = found[0];
            logger.info(`[dom-find-execute] clicou: tag=${best.tag} text="${best.text}"`);
            return { steps: [] };
          }
          logger.info(`[dom-find] sem resultado — caindo para DOM completo`);
        } catch (err: any) {
          logger.warn(`[dom-find] falhou: ${err.message}`);
        }
      }
    } catch (err: any) {
      logger.warn(`[vision-click] captura de tela falhou: ${err.message}`);
    }
  }

  const { filtered, offsetMap, highConfidence } = smartFilterElements(elements, intent, task, visionKeywords);
  logger.info(`[dom-resolve] intent=${intent}, highConfidence=${highConfidence}, candidatos: ${filtered.length}/${elements.length}`);

  // High-confidence shortcut: skip AI entirely
  if (highConfidence) {
    if (intent === 'search' && filtered.length === 2) {
      const regexValue = extractTypingValue(task);
      const value = regexValue ?? await extractSearchTermViaAI(task);
      const inputEl = filtered[0];
      const submitEl = filtered[1];
      logger.info(`[dom-resolve] fast-path search: type "${value}" → [${offsetMap[0]}] "${inputEl.placeholder ?? inputEl.ariaLabel ?? inputEl.id}" | click → [${offsetMap[1]}] "${submitEl.text ?? submitEl.ariaLabel ?? submitEl.id}"`);
      return { steps: [
        { selector: inputEl.selector, action: { kind: 'type', value, clearFirst: true } },
        { selector: submitEl.selector, action: { kind: 'click' } },
      ] };
    }
    if (intent === 'click' && filtered.length === 1) {
      const el = filtered[0];
      logger.info(`[dom-resolve] fast-path click: [${offsetMap[0]}] text="${el.text}" aria="${el.ariaLabel ?? ''}"`);
      return { steps: [{ selector: el.selector, action: { kind: 'click' }, verifyText: el.text || el.ariaLabel, verifyHref: el.href }] };
    }
  }

  // Build element summary for AI (filtered candidates only)
  const elemSummary = filtered.map((el, i) =>
    `[${i}] tag=${el.tag}${el.type ? ` type=${el.type}` : ''}${el.role ? ` role=${el.role}` : ''} text="${el.text}" id="${el.id ?? ''}" name="${el.name ?? ''}" placeholder="${el.placeholder ?? ''}" aria="${el.ariaLabel ?? ''}"${el.href ? ` href="${el.href}"` : ''}${el.options ? ` options=[${el.options.slice(0, 8).join(', ')}]` : ''}`,
  ).join('\n');

  const isFillForm = intent === 'fill_form';
  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `OUTPUT RULE: respond with ONLY a raw JSON array or the word null. No explanations, no code, no markdown.

Given a web automation task and a list of interactive page elements, output a JSON array of steps.

Each step is one of:
- {"index": <number>, "action": {"kind": "click"}}
- {"index": <number>, "action": {"kind": "submit"}}
- {"index": <number>, "action": {"kind": "select", "value": "<option>"}}
- {"index": <number>, "action": {"kind": "type", "value": "<text>", "clearFirst": true}}

RULES:
- "type" targets: input[type=text/email/password/tel/url/date/number/search] or textarea. NEVER a button.
  - For input[type=date]: value MUST be in YYYY-MM-DD format (e.g. "1990-05-15").
- "click" targets: button, link (tag=a), role=button, role=radio, input[type=radio], input[type=checkbox]. NEVER a plain text input.
- "select" targets: tag=select. value = one of the options listed.
- For radio buttons (type=radio): pick EXACTLY ONE per name group and use "click". NEVER include two radio inputs that share the same name attribute — that would overwrite the first selection. Pick the first option if the task doesn't specify.
- For checkboxes (type=checkbox): use "click" for EVERY checkbox in the form. Check ALL of them.
- For search tasks: exactly TWO steps — (1) type into search input, (2) click search/submit button.
- For single click/select tasks: exactly ONE step.
- For form fill tasks: output ONE step per field — fill ALL visible form fields (including radio and checkbox) with realistic fictional data, then end with a submit/click button step.
- Output null if nothing matches.`,
      },
      {
        role: 'user',
        content: `Task: "${task}"\n\nElements:\n${elemSummary}\n\nJSON array only:`,
      },
    ],
    max_tokens: isFillForm ? 900 : 120,
    temperature: 0,
  });

  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  logger.info(`[dom-resolve] resposta IA: ${raw}`);

  if (!raw || raw === 'null') return null;

  const candidates = [raw, (raw.match(/\[[\s\S]*?\]/) ?? [])[0] ?? ''];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Array<{ index: number; action: DomAction }>;
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      const steps: Array<{ selector: string; action: DomAction; isSubmitButton: boolean }> = [];
      const seenSelectors = new Set<string>();
      const seenRadioNames = new Set<string>(); // deduplicate radio groups by name
      for (const step of parsed) {
        if (typeof step.index !== 'number' || !step.action) continue;
        const origIdx = offsetMap[step.index] ?? step.index;
        const el = elements[origIdx] ?? filtered[step.index];
        if (!el) continue;

        // Deduplicate: skip if same selector already queued
        if (seenSelectors.has(el.selector)) continue;
        seenSelectors.add(el.selector);

        // Deduplicate radio groups: only the first radio per name group is kept.
        // If the AI incorrectly sends both "masculino" and "feminino" (same name="sexo"),
        // the second one is dropped here so we don't overwrite the first selection.
        if (el.type === 'radio' && el.name) {
          if (seenRadioNames.has(el.name)) {
            logger.warn(`[dom-resolve] ignorando radio duplicado: name="${el.name}" id="${el.id ?? ''}" — já selecionado um desta grupo`);
            continue;
          }
          seenRadioNames.add(el.name);
        }

        // Reject type action on non-input elements
        const isInput = el.tag === 'input' || el.tag === 'textarea';
        if (step.action.kind === 'type' && !isInput) {
          logger.warn(`[dom-resolve] rejeitando: type em tag=${el.tag} text="${el.text}"`);
          continue;
        }

        // A step is a "submit button" only when it's a <button> or input[type=submit/button].
        // Radio and checkbox inputs also use kind='click' but must NOT be stripped.
        const isSubmitButton =
          el.tag === 'button' ||
          (el.tag === 'input' && (el.type === 'submit' || el.type === 'button'));

        logger.info(`[dom-resolve] passo: [${step.index}→${origIdx}] tag=${el.tag}${el.type ? ` type=${el.type}` : ''} text="${el.text}" id="${el.id ?? ''}" placeholder="${el.placeholder ?? ''}" action=${step.action.kind}`);
        steps.push({ selector: el.selector, action: step.action, isSubmitButton });
      }
      if (steps.length > 0) {
        // For fill_form: strip submit/button steps so user can confirm before sending.
        // Only strip actual submit buttons — radio/checkbox clicks must be kept.
        if (isFillForm) {
          const wantsSubmit = /enviar|submete|clique.*cadastrar|clique.*enviar|click.*submit/i.test(task);
          const skipSubmit = !wantsSubmit;
          const filtered2 = skipSubmit
            ? steps.filter(s => !(s.isSubmitButton && (s.action.kind === 'click' || s.action.kind === 'submit')))
            : steps;
          const postMsg = skipSubmit
            ? 'Formulário preenchido! Quando quiser enviar, diga \'enviar o formulário\' ou clique no botão.'
            : 'Feito!';
          return { steps: filtered2.length > 0 ? filtered2 : steps.filter(s => !s.isSubmitButton), postMsg };
        }
        return { steps };
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// ── File system action resolver ──────────────────────────────────────────────

import type { FileSystemAction } from './context';

async function resolveFileSystemAction(task: string): Promise<FileSystemAction | null> {
  const client = getClient();

  const completion = await client.chat.completions.create({
    model: 'llama-3.1-8b-instant',
    messages: [
      {
        role: 'system',
        content: `Você interpreta comandos de voz para operações no sistema de arquivos do Windows.
Retorne SOMENTE um JSON com:
- "kind": "create_file" | "create_folder" | "open_folder" | "list_folder" | "delete" | "rename"
- "path": caminho completo (use C:/Users/<usuario> como base se não especificado, desconhecido use C:/Users)
- "content": conteúdo do arquivo (apenas para create_file, opcional)
- "newName": novo nome (apenas para rename)

Se o comando não for uma operação de arquivo, retorne null.

Exemplos:
- "cria um arquivo chamado teste.txt na área de trabalho" → {"kind":"create_file","path":"C:/Users/euzebio/Desktop/teste.txt","content":""}
- "abre a pasta Downloads" → {"kind":"open_folder","path":"C:/Users/euzebio/Downloads"}
- "lista os arquivos da pasta documentos" → {"kind":"list_folder","path":"C:/Users/euzebio/Documents"}
- "cria uma pasta chamada projetos em documentos" → {"kind":"create_folder","path":"C:/Users/euzebio/Documents/projetos"}`,
      },
      { role: 'user', content: task },
    ],
    max_tokens: 150,
    temperature: 0,
  });

  const raw = (completion.choices[0]?.message?.content ?? '').trim();
  logger.info(`[fs-resolve] resposta: ${raw}`);
  if (raw === 'null' || !raw) return null;

  try {
    return JSON.parse(raw) as FileSystemAction;
  } catch {
    return null;
  }
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
  const now = Date.now();
  const taskKey = (text ?? '').toLowerCase().trim().replace(/\s+/g, ' ');
  const last = recentTaskTimestamps.get(taskKey) ?? 0;
  const taskId = `${now}-${Math.random().toString(36).slice(2)}`;

  logger.info(`[pipeline] taskId=${taskId} tarefa recebida: "${text}" taskKey="${taskKey}"`);

  if (activeTaskKeys.has(taskKey)) {
    logger.warn(`[pipeline] taskId=${taskId} — tarefa duplicada detectada: já em execução — ignorando.`);
    return { text: 'Tarefa já em execução, ignorando.' };
  }
  if (now - last < DUPLICATE_WINDOW_MS) {
    logger.warn(`[pipeline] taskId=${taskId} — debounce: mesma tarefa recebida há ${now - last}ms — ignorando.`);
    recentTaskTimestamps.set(taskKey, now);
    return { text: 'Tarefa repetida detectada — ignorando.' };
  }

  activeTaskKeys.add(taskKey);
  recentTaskTimestamps.set(taskKey, now);

  try {

    const lower = text.toLowerCase();

    // Browser navigation shortcuts — regex heuristic, no LLM needed, instant & precise
    type BrowserNavEntry = { pattern: RegExp; extAction?: 'new_tab' | 'close_tab' | 'reload' | 'go_back' | 'go_forward'; combo: string; speech: string };
    const BROWSER_NAV: BrowserNavEntry[] = [
      { pattern: /voltar|volta|anterior|p[aá]gina anterior|page back|go back/i,   extAction: 'go_back',    combo: 'alt+left',  speech: 'Voltando para a página anterior.' },
      { pattern: /avan[çc]ar?|pr[oó]xima p[aá]gina|p[aá]gina seguinte|go forward/i, extAction: 'go_forward', combo: 'alt+right', speech: 'Avançando para a próxima página.' },
      { pattern: /recarreg|atualiz|refresh|reload|f5/i,                            extAction: 'reload',     combo: 'f5',        speech: 'Recarregando a página.' },
      { pattern: /fechar\s*(a\s*)?(?:aba|guia)|close\s*tab/i,                    extAction: 'close_tab',  combo: 'ctrl+w',    speech: 'Fechando a aba.' },
      { pattern: /nov[ao]\s*(?:aba|guia)|abri[rr]?\s*(?:uma\s*)?(?:nov[ao]\s*)?(?:aba|guia)|new\s*tab/i, extAction: 'new_tab', combo: 'ctrl+t', speech: 'Abrindo nova aba.' },
    ];
    for (const nav of BROWSER_NAV) {
      if (nav.pattern.test(lower)) {
        logger.info(`[pipeline] atalho de navegação detectado: "${nav.extAction ?? nav.combo}"`);
        let usedExtension = false;
        if (nav.extAction && isBrowserExtensionConnected()) {
          // Use Chrome Tab API directly — no window focus required
          try {
            await requestBrowserAction(nav.extAction);
            usedExtension = true;
          } catch (err: any) {
            logger.warn(`[pipeline] browser_action falhou (${err.message}) — usando atalho de teclado`);
          }
        }
        if (!usedExtension) {
          if (nav.extAction === 'new_tab') {
            await openNewBrowserTab();
          } else {
            await focusBrowserWindow();
            await pressKeyCombo(nav.combo);
          }
        }
        await speakWithState(nav.speech, win);
        return { text: nav.speech };
      }
    }

    const task = text;

    // Layer 0b: coherence check — reject noise / nonsensical phrases
    const isCoherent = await checkIfTaskIsCoherent(task);
    if (!isCoherent) {
      logger.info(`[pipeline] tarefa incoerente descartada: "${task}"`);
      await speakWithState('Não entendi bem o que você disse. Pode repetir de outra forma?', win);
      return { text: '' };
    }

    // Layer 1a: direct OS action? (open app, open URL, press key — no screen capture needed)
    const isDirectOS = await checkIfDirectOSAction(task);
    if (isDirectOS) {
      logger.info('[pipeline] caminho direto → ação de SO (sem captura de tela)');
      return processTranscription(task, win);
    }

    // Layer 1b: is this only a description request (no action/click needed)?
    // Run early so we can skip the DOM path entirely for description-only tasks.
    const needsInteraction = await checkIfTaskNeedsInteraction(task);
    if (!needsInteraction) {
      logger.info('[pipeline] layer1b → tarefa de descrição apenas, pulando DOM');
    }

    // ── Detect active window context ─────────────────────────────────────────
    const activeWin = await getActiveWindow();
    logger.info(`[pipeline] janela ativa: ${activeWin?.processName ?? 'desconhecida'} — browser=${activeWin?.isBrowser} explorer=${activeWin?.isExplorer}`);

    // ── Path A: Browser + extension connected → DOM automation ───────────────
    // Wait up to 3 s for the extension to (re)connect — Chrome MV3 service workers
    // can be killed silently and need a moment to restart and reconnect.
    // Skip if this is a description-only task — no DOM interaction needed.
    const extConnected = needsInteraction && await waitForExtension(3000);
    if (extConnected) {
      logger.info('[pipeline] caminho DOM → extensão do navegador');
      const waitMsg = 'Aguarde um momento enquanto executo a atividade...';
      win.webContents.send('show-message', waitMsg);
      speak(waitMsg, () => win.webContents.send('character-state', 'talking')).then(() => win.webContents.send('character-state', 'idle'));

      try {
        const elements = await queryDom(task);
        logger.info(`[pipeline] taskId=${taskId} DOM retornou ${elements.length} elemento(s)`);

        if (elements.length === 0) {
          const msg = 'Não encontrei o elemento na página atual.';
          await speakWithState(msg, win);
          return { text: msg };
        }

        // Use Groq text model to decide which element to interact with and how
        const domResult = await resolveDomAction(task, elements);
        if (!domResult) {
          const msg = 'Não consegui determinar a ação a executar.';
          await speakWithState(msg, win);
          return { text: msg };
        }

        for (let i = 0; i < domResult.steps.length; i++) {
          const step = domResult.steps[i];
          logger.info(`[dom-execute-start] taskId=${taskId} passo ${i + 1}/${domResult.steps.length} selector="${step.selector}" action=${step.action.kind}`);
          await executeDomAction(step.selector, step.action, 8000, step.verifyText, step.verifyHref);
          logger.info(`[dom-execute-done] taskId=${taskId} passo ${i + 1}/${domResult.steps.length} OK`);
        }
        const doneMsg = domResult.postMsg ?? 'Feito!';
        await speakWithState(doneMsg, win);
        return { text: doneMsg, action: 'dom_automation' };
      } catch (err: any) {
        const isRestrictedPage = /chrome_restricted_url|cannot access a chrome:\/\//i.test(err.message);
        if (isRestrictedPage) {
          logger.info('[pipeline] extensão em página restrita (chrome://) — tratando como ação de SO');
          return processTranscription(task, win);
        }
        logger.warn(`[pipeline] extensão falhou (${err.message}) — caindo para visão por IA`);
        // Falls through to vision AI below
      }
    } else {
      logger.warn('[pipeline] extensão não conectada — verifique se a extensão está instalada e ativa no Chrome');
    }

    // ── Path B: File Explorer / file system commands ──────────────────────────
    if (activeWin?.isExplorer || /pasta|diret[oó]rio|arquivo|criar.*(?:arquivo|pasta)|abri[rr].*pasta/i.test(task)) {
      const fsAction = await resolveFileSystemAction(task);
      if (fsAction) {
        logger.info(`[pipeline] caminho sistema de arquivos → ${fsAction.kind}: ${fsAction.path}`);
        try {
          const result = await executeFileSystemAction(fsAction);
          await speakWithState(result, win);
          return { text: result, action: 'file_system' };
        } catch (err: any) {
          logger.warn(`[pipeline] ação de arquivo falhou: ${err.message}`);
          // Falls through to vision AI
        }
      }
    }

    // ── Path C: Vision AI fallback ────────────────────────────────────────────

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

    // needsInteraction already determined above (layer1b)

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
  } finally {
    try {
      activeTaskKeys.delete(taskKey);
    } catch (e) {
      // ignore
    }
  }
}
