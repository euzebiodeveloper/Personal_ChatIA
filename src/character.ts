export type CharacterState = 'idle' | 'listening' | 'talking';

export class AnimatedCharacter {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private state: CharacterState = 'idle';
  private time = 0;
  private mouthOpen = 0;
  private blinkTimer = 0;
  private blinkAmount = 0; // 0 = fully open, 1 = fully closed
  private rafId: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D not supported');
    this.ctx = ctx;
    this.canvas.width = 280;
    this.canvas.height = 360;
    this.loop(0);
  }

  setState(s: CharacterState): void {
    this.state = s;
  }

  private loop = (ts: number) => {
    this.time = ts / 1000;
    this.updateLogic();
    this.render();
    this.rafId = requestAnimationFrame(this.loop);
  };

  private updateLogic(): void {
    // Blink: every ~3–5s, rapidly close and open
    this.blinkTimer++;
    if (this.blinkTimer > 180 + Math.floor(Math.random() * 120)) {
      this.blinkTimer = 0;
    }
    const blinkPhase = this.blinkTimer;
    if (blinkPhase < 4) {
      this.blinkAmount = blinkPhase / 4;
    } else if (blinkPhase < 8) {
      this.blinkAmount = 1 - (blinkPhase - 4) / 4;
    } else {
      this.blinkAmount = 0;
    }

    // Mouth moves during talking
    if (this.state === 'talking') {
      this.mouthOpen = 0.3 + 0.7 * Math.abs(Math.sin(this.time * 7));
    } else {
      this.mouthOpen = Math.max(0, this.mouthOpen - 0.06);
    }
  }

  private render(): void {
    const { ctx, canvas, state, time } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2;
    const baseY = h / 2 - 10;

    // Float / bounce
    const floatY = state === 'idle' ? Math.sin(time * 1.4) * 5 : 0;
    const pulse = state === 'listening' ? 1 + Math.sin(time * 5) * 0.03 : 1;

    ctx.save();
    ctx.translate(cx, baseY + floatY);
    ctx.scale(pulse, pulse);

    // Listening glow
    if (state === 'listening') {
      const g = ctx.createRadialGradient(0, 0, 55, 0, 0, 105);
      g.addColorStop(0, 'rgba(80, 180, 255, 0.25)');
      g.addColorStop(1, 'rgba(80, 180, 255, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 105, 0, Math.PI * 2);
      ctx.fill();
    }

    // Talking glow
    if (state === 'talking') {
      const g = ctx.createRadialGradient(0, 0, 55, 0, 0, 105);
      g.addColorStop(0, 'rgba(255, 180, 80, 0.2)');
      g.addColorStop(1, 'rgba(255, 180, 80, 0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 105, 0, Math.PI * 2);
      ctx.fill();
    }

    // Drop shadow
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;

    // --- HAIR (behind face) ---
    ctx.fillStyle = '#4A2C2A';
    // Top hair
    ctx.beginPath();
    ctx.ellipse(0, -58, 80, 42, 0, Math.PI, 0);
    ctx.fill();
    // Side hair left
    ctx.beginPath();
    ctx.ellipse(-70, -12, 20, 50, -0.25, 0, Math.PI * 2);
    ctx.fill();
    // Side hair right
    ctx.beginPath();
    ctx.ellipse(70, -12, 20, 50, 0.25, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // --- FACE ---
    const faceGrad = ctx.createRadialGradient(-12, -18, 0, 0, 0, 78);
    faceGrad.addColorStop(0, '#FFE8CE');
    faceGrad.addColorStop(1, '#FFBF96');
    ctx.fillStyle = faceGrad;
    ctx.beginPath();
    ctx.ellipse(0, 0, 74, 80, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- HAIR FRINGE (front) ---
    ctx.fillStyle = '#4A2C2A';
    ctx.beginPath();
    ctx.moveTo(-80, -35);
    ctx.bezierCurveTo(-60, -95, 60, -95, 80, -35);
    ctx.bezierCurveTo(55, -55, -55, -55, -80, -35);
    ctx.fill();
    // Fringe strands
    ctx.beginPath();
    ctx.moveTo(-20, -78);
    ctx.quadraticCurveTo(-15, -40, -8, -25);
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#4A2C2A';
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(20, -78);
    ctx.quadraticCurveTo(15, -40, 8, -25);
    ctx.stroke();
    ctx.lineWidth = 1;

    // --- EYES ---
    const eyeY = -8;
    const eyeHalfH = 14 * (1 - this.blinkAmount);

    // Eye whites
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.ellipse(-26, eyeY, 15, Math.max(0.5, eyeHalfH), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(26, eyeY, 15, Math.max(0.5, eyeHalfH), 0, 0, Math.PI * 2);
    ctx.fill();

    if (eyeHalfH > 3) {
      // Iris
      ctx.fillStyle = '#4A6FA5';
      ctx.beginPath();
      ctx.ellipse(-26, eyeY + 2, 9, Math.min(9, eyeHalfH - 2), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(26, eyeY + 2, 9, Math.min(9, eyeHalfH - 2), 0, 0, Math.PI * 2);
      ctx.fill();

      // Pupils
      ctx.fillStyle = '#1A1A2E';
      ctx.beginPath();
      ctx.ellipse(-26, eyeY + 3, 5, Math.min(6, eyeHalfH - 4), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(26, eyeY + 3, 5, Math.min(6, eyeHalfH - 4), 0, 0, Math.PI * 2);
      ctx.fill();

      // Shine
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.beginPath();
      ctx.arc(-22, eyeY - 2, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(30, eyeY - 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Eyelashes (top)
    ctx.strokeStyle = '#1A1A2E';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.ellipse(-26, eyeY - (eyeHalfH * 0.4), 15, eyeHalfH * 0.2, 0, Math.PI, 0);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(26, eyeY - (eyeHalfH * 0.4), 15, eyeHalfH * 0.2, 0, Math.PI, 0);
    ctx.stroke();
    ctx.lineWidth = 1;

    // --- BLUSH ---
    ctx.fillStyle = 'rgba(255, 102, 102, 0.25)';
    ctx.beginPath();
    ctx.ellipse(-46, 18, 16, 9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(46, 18, 16, 9, 0, 0, Math.PI * 2);
    ctx.fill();

    // --- NOSE ---
    ctx.strokeStyle = 'rgba(200, 120, 80, 0.45)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-4, 16);
    ctx.quadraticCurveTo(0, 24, 4, 16);
    ctx.stroke();
    ctx.lineWidth = 1;

    // --- MOUTH ---
    const mouthY = 36;
    if (this.mouthOpen > 0.06) {
      // Open mouth (talking)
      const ow = 20 * this.mouthOpen;
      const oh = 14 * this.mouthOpen;
      ctx.fillStyle = '#A83232';
      ctx.beginPath();
      ctx.ellipse(0, mouthY + oh * 0.3, ow, oh, 0, 0, Math.PI * 2);
      ctx.fill();
      // Teeth
      ctx.fillStyle = 'white';
      ctx.beginPath();
      ctx.ellipse(0, mouthY, ow * 0.9, oh * 0.45, 0, 0, Math.PI);
      ctx.fill();
    } else {
      // Smile
      ctx.strokeStyle = '#C44444';
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(-16, mouthY);
      ctx.quadraticCurveTo(0, mouthY + 12, 16, mouthY);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    ctx.restore();

    // --- Status text at bottom ---
    const label =
      state === 'listening' ? '🎤 Ouvindo...' :
      state === 'talking'   ? '💬 Falando...' : '';

    if (label) {
      const bx = w / 2;
      const by = h - 22;
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.beginPath();
      (ctx as CanvasRenderingContext2D & { roundRect?: (...a: unknown[]) => void }).roundRect?.(bx - 62, by - 16, 124, 26, 13);
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx, by - 3);
    }
  }

  destroy(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
  }
}
