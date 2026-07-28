import type { ElementHandle, Page } from "puppeteer";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randInt(min: number, max: number) {
  return Math.floor(rand(min, max + 1));
}

/** Cubic bezier point */
function bezier(
  t: number,
  p0: number,
  p1: number,
  p2: number,
  p3: number,
) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

type Point = { x: number; y: number };

function curvePoints(from: Point, to: Point, steps: number): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  // Control points lệch ngẫu nhiên tạo đường cong tự nhiên
  const offset = Math.min(120, dist * 0.35);
  const c1 = {
    x: from.x + dx * 0.25 + rand(-offset, offset),
    y: from.y + dy * 0.25 + rand(-offset, offset),
  };
  const c2 = {
    x: from.x + dx * 0.75 + rand(-offset, offset),
    y: from.y + dy * 0.75 + rand(-offset, offset),
  };
  const pts: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out nhẹ
    const te = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    pts.push({
      x: bezier(te, from.x, c1.x, c2.x, to.x) + rand(-0.6, 0.6),
      y: bezier(te, from.y, c1.y, c2.y, to.y) + rand(-0.6, 0.6),
    });
  }
  return pts;
}

export class HumanCursor {
  private x = rand(80, 240);
  private y = rand(80, 240);

  constructor(private readonly page: Page) {}

  async init() {
    await this.page.mouse.move(this.x, this.y);
  }

  async pause(minMs = 120, maxMs = 420) {
    await sleep(rand(minMs, maxMs));
  }

  async moveTo(x: number, y: number) {
    const dist = Math.hypot(x - this.x, y - this.y);
    const steps = Math.max(12, Math.min(45, Math.round(dist / 8)));
    const pts = curvePoints({ x: this.x, y: this.y }, { x, y }, steps);
    for (const p of pts) {
      await this.page.mouse.move(p.x, p.y);
      await sleep(rand(4, 14));
    }
    this.x = x;
    this.y = y;
  }

  async moveToElement(el: ElementHandle<Element>, jitter = 6) {
    const box = await el.boundingBox();
    if (!box) throw new Error("Element not visible for mouse move");
    const tx = box.x + box.width * rand(0.3, 0.7) + rand(-jitter, jitter);
    const ty = box.y + box.height * rand(0.35, 0.65) + rand(-jitter, jitter);
    await this.moveTo(tx, ty);
    return { x: tx, y: ty };
  }

  async clickElement(el: ElementHandle<Element>, clicks = 1) {
    await this.moveToElement(el);
    await this.pause(80, 220);
    await this.page.mouse.click(this.x, this.y, {
      delay: randInt(40, 120),
      clickCount: clicks,
    });
    await this.pause(100, 280);
  }

  async clickSelector(selector: string, clicks = 1) {
    const el = await this.page.waitForSelector(selector, {
      visible: true,
      timeout: 20_000,
    });
    if (!el) throw new Error(`Selector not found: ${selector}`);
    await this.clickElement(el, clicks);
  }

  /** Gõ từng ký tự vào element (iframe Maps review form). */
  async typeIntoElement(el: ElementHandle<Element>, text: string) {
    await this.clickElement(el, 1);
    await this.pause(120, 280);
    await this.page.keyboard.down("Control");
    await this.page.keyboard.press("KeyA");
    await this.page.keyboard.up("Control");
    await this.pause(120, 280);
    await this.page.keyboard.press("Backspace");
    await this.pause(150, 350);

    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      await this.page.keyboard.type(ch, { delay: 0 });
      let delay = rand(120, 280);
      if (" .,!?;:\n".includes(ch)) delay += rand(80, 220);
      if (".@_".includes(ch)) delay += rand(60, 160);
      if (i > 0 && i % randInt(5, 12) === 0) delay += rand(200, 550);
      if (text.length > 40 && i === Math.floor(text.length / 2)) {
        delay += rand(300, 700);
      }
      await sleep(delay);
    }
    await this.pause(280, 650);
  }

  /** Gõ từng ký tự — nhịp chậm, random (giống người thật, không spam nhanh). */
  async typeText(selector: string, text: string) {
    const el = await this.page.waitForSelector(selector, {
      visible: true,
      timeout: 20_000,
    });
    if (!el) throw new Error(`Selector not found: ${selector}`);
    await this.typeIntoElement(el, text);
  }

  /** Di chuyển / scroll / nghỉ nhẹ trước khi vào form (giảm tín hiệu bot). */
  async warmUp() {
    const w = await this.page.evaluate(() => ({
      x: window.innerWidth || 1200,
      y: window.innerHeight || 800,
    }));
    await this.moveTo(rand(120, Math.max(200, w.x * 0.7)), rand(100, Math.max(180, w.y * 0.5)));
    await this.pause(200, 500);
    await this.page.evaluate(() => {
      window.scrollBy(0, Math.floor(40 + Math.random() * 180));
    });
    await this.pause(300, 900);
    await this.moveTo(rand(150, Math.max(220, w.x * 0.55)), rand(140, Math.max(220, w.y * 0.45)));
    await this.pause(200, 600);
  }
}
