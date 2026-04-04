import * as PIXI from 'pixi.js';
import { Live2DModel } from 'pixi-live2d-display/cubism4';

// pixi-live2d-display requires PIXI on the window object
(window as typeof window & { PIXI: typeof PIXI }).PIXI = PIXI;

export type CharacterState = 'idle' | 'listening' | 'talking';

const MODEL_PATH = 'live2d/natori_pro_en/runtime/natori_pro_t06.model3.json';
const MOTION_IDLE = 'Idle';
const MOTION_TAP  = 'Tap'; // group name from natori_pro_t06.model3.json

export class AnimatedCharacter {
  private app: PIXI.Application;
  private model: Live2DModel | null = null;
  private state: CharacterState = 'idle';
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    const parent = canvas.parentElement;
    this.app = new PIXI.Application({
      view: canvas,
      width:  parent?.clientWidth  ?? 320,
      height: parent?.clientHeight ?? 440,
      backgroundAlpha: 0,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    this.loadModel();
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    // window.electronAPI may not exist yet if called before DOMContentLoaded
    try {
      window.electronAPI?.writeLog(level, `[character] ${msg}`);
    } catch { /* ignore */ }
    console[level](`[character] ${msg}`);
  }

  private async loadModel(): Promise<void> {
    this.log('info', `Starting Live2D load. MODEL_PATH="${MODEL_PATH}"`);
    this.log('info', `PIXI version: ${PIXI.VERSION}`);
    this.log('info', `Canvas size: ${this.app.screen.width}x${this.app.screen.height}`);

    // Check if Live2DModel is available
    this.log('info', `Live2DModel type: ${typeof Live2DModel}`);

    try {
      this.log('info', 'Calling Live2DModel.from()...');
      const model = await Live2DModel.from(MODEL_PATH, {
        onError: (err: Error) => {
          this.log('error', `Live2DModel internal error: ${err?.message ?? String(err)}`);
        },
      } as Parameters<typeof Live2DModel.from>[1]);

      this.log('info', `Model loaded. Size: ${model.width}x${model.height}`);
      this.model = model;
      this.app.stage.addChild(model as unknown as PIXI.DisplayObject);
      this.log('info', 'Model added to stage');

      this.fitModel();
      this.log('info', `Model fitted. Scale: ${model.scale.x.toFixed(3)}, pos: (${model.x.toFixed(0)}, ${model.y.toFixed(0)})`);

      model.interactive = true;
      model.on('hit', (areas: string[]) => {
        this.log('info', `Hit areas: ${areas.join(', ')}`);
        if (areas.includes('Body')) model.motion(MOTION_TAP);
      });

      model.motion(MOTION_IDLE);
      this.log('info', 'Idle motion started — Live2D ready!');
    } catch (err) {
      const msg = err instanceof Error
        ? `${err.message}\nstack: ${err.stack ?? '(none)'}`
        : String(err);
      this.log('error', `Live2D load FAILED: ${msg}`);
      this.log('warn', 'Showing fallback circle instead');
      this.renderFallback();
    }
  }

  private fitModel(): void {
    if (!this.model) return;
    const { width: cw, height: ch } = this.app.screen;
    const { width: mw, height: mh } = this.model;

    // ZOOM > 1 = zoom in. At 2.4x the canvas only shows ~40% of the model height (chest-up).
    // Increase to zoom more in; decrease toward 0.9 to show more of the body.
    const ZOOM = 2.4;
    const scale = Math.min(cw / mw, ch / mh) * ZOOM;
    this.model.scale.set(scale);

    // Center horizontally (sides may overflow — that's fine)
    this.model.x = (cw - mw * scale) / 2;

    // Anchor near the top of the canvas so the upper body (chest up) is visible.
    // Increase TOP_PAD to add more space above the head; decrease to crop higher.
    const TOP_PAD = ch * 0.05;
    this.model.y = TOP_PAD;
  }

  private renderFallback(): void {
    this.log('warn', 'renderFallback() called — drawing blue circle placeholder');
    const g = new PIXI.Graphics();
    g.beginFill(0x4a6fa5);
    g.drawCircle(this.app.screen.width / 2, this.app.screen.height / 2, 60);
    g.endFill();
    this.app.stage.addChild(g);
  }

  setState(s: CharacterState): void {
    if (this.state === s) return;
    this.state = s;

    if (!this.model) return;

    switch (s) {
      case 'idle':
        // Reset to neutral — no special expression
        this.model.expression('Normal');
        break;
      case 'listening':
        // Show attentive expression while recording
        this.model.expression('Smile');
        break;
      case 'talking':
        // Show happy/engaged expression while responding
        this.model.expression('Smile');
        break;
    }
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.app?.destroy(false, { children: true });
  }
}
