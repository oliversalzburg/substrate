/* eslint-disable no-use-before-define */
import { isNil } from "@oliversalzburg/js-utils/data/nil.js";
import { Random, randomRange, seedFromString } from "@oliversalzburg/js-utils/data/random.js";
import { hashCyrb53 } from "@oliversalzburg/js-utils/data/string.js";
import { getDocumentElementTypeByIdStrict } from "@oliversalzburg/js-utils/dom/core.js";
import {
  CanvasSandboxHostApplication,
  CanvasWorker,
  CanvasWorkerInstance,
  CanvasWorkerMessageReconfigure,
} from "@oliversalzburg/js-utils/graphics/canvas-sandbox-mp.js";
import { CanvasSandbox } from "@oliversalzburg/js-utils/graphics/canvas-sandbox.js";
import { Canvas2DHeadless } from "@oliversalzburg/js-utils/graphics/canvas2d-headless.js";
import {
  Canvas2D,
  putPixel32,
  putPixel32Add,
  putPixel32Sub,
} from "@oliversalzburg/js-utils/graphics/canvas2d.js";
import { fromRGBA } from "@oliversalzburg/js-utils/graphics/core.js";
import { renderPaletteSample } from "@oliversalzburg/js-utils/graphics/palette-sampler.js";
import { Palette, palette, paletteName } from "@oliversalzburg/js-utils/graphics/palette.js";
import { MS_PER_FRAME_60FPS } from "@oliversalzburg/js-utils/graphics/render-loop.js";
import { clamp, cosDegrees, roundTo, sinDegrees } from "@oliversalzburg/js-utils/math/core.js";
import { Vector2 } from "@oliversalzburg/js-utils/math/vector2.js";

// ----------------------- Non-boilerplate code starts here -----------------------

// Touch this, if you dare.
const ABSOLUTE_MAX_WORKERS = 15;

let workerId = "<unknown>";
const IS_WORKER = typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope;

const applicationOptions = {
  // If you enable both blending modes, every SandPainter will randomly pick one mode.
  blendingAdditive: true,
  blendingSubtractive: false,
  canvasColorDark: fromRGBA(0, 0, 0, 5),
  canvasColorLight: fromRGBA(255, 255, 255, 5),
  //crackColor: fromRGBA(50, 50, 50, 255),
  cracksInitial: 10,
  // The maximum number of crack instances that can ever exist at a time
  cracksMax: 50,
  // How likely is it that a crack will move on a curve instead of a straight line?
  curveChance: 0.01,
  curveMin: 0.01,
  curveMax: 0.02,
  darkMode: true,
  // Instead of drawing a perfect line, offset each pixel slightly. Value between 0 and 1.
  fuzzyness: 0,
  iterationsPerUpdate: 4,
  // Modulate the cracks direction as it moves. Gives a very organic look.
  modulatePath: false,
  modulatePathAmount: 0.05,
  // The colors to use.
  paletteIndex: 0,
  padding: 20,
  // 90 degrees is the classic substrate look.
  // Lower values will result in more crystal like structure.
  // This effect is exagregated with preferSingleAngle.
  preferDirection: 90,
  // This is only relevant, when not using perpendicular spawns.
  // If preferSingleAngle is set to true, we can either spawn in -DEGREES or +DEGREES direction.
  // If it is set to false, we can also spawn in -DEGREES+90 and +DEGREES+90 direction.
  preferSingleAngle: false,
  seed: seedFromString("Substrate by Jared Tarbell"),
  // How far away from the parent crack, should a new crack spawn?
  // Values 15-30 generate that bizmuth crystal look. Higher values are weird.
  // TODO: Randomize distance by cracks and evaluate.
  spawnDistance: 0.61,
  spawnPerpendicular: 90,
  spawn45Degrees: 45,
  // This is currently broken. Don't use.
  subPixelDrawing: false,
  // Color between the cracks with the SandPainter effect.
  sandPainterActive: true,
  // If true, we color the crack with the same color its SandPainter uses. Otherwise we use crackColor.
  //sandPainterColorsCrack: true,
  sandPainterGrains: 64,

  world: {
    w: 512,
    h: 512,
  },
  viewport: {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  },

  devMode: false,

  workerCount: 1,
  calibrationRequired: false,
  calibrationEarlyExit: true,
  calibrationMaxWorkers: ABSOLUTE_MAX_WORKERS,
  calibrationData: [
    {
      workerCount: 1,
      started: new Date(),
      finished: new Date(),
      duration: Number.POSITIVE_INFINITY,
    },
  ],
};

type ApplicationOptions = typeof applicationOptions;

class SandPainter {
  readonly host: RenderKernel;
  readonly canvas: Canvas2D | Canvas2DHeadless;

  readonly color: number;
  grainDistance: number;
  readonly maxAlpha: number;
  readonly plotter: (
    canvas: Canvas2D | Canvas2DHeadless,
    x: number,
    y: number,
    color: number,
    alpha: number,
  ) => void;

  constructor(host: RenderKernel) {
    this.host = host;
    this.canvas = this.host.canvas;

    this.color = this.host.palette.someColor(this.host.random);
    this.grainDistance = this.host.random.nextRange(0.001, 0.01);

    if (this.host.options.blendingAdditive && this.host.options.blendingSubtractive) {
      // Both additive and subtractive blending (pick random)
      const r = this.host.random.nextFloat();
      if (r > 0.5) {
        this.plotter = putPixel32Add;
      } else {
        this.plotter = putPixel32Sub;
      }
      this.maxAlpha = 128;
    } else if (this.host.options.blendingAdditive) {
      // Only additive blending
      this.plotter = putPixel32Add;
      this.maxAlpha = 128;
    } else if (this.host.options.blendingSubtractive) {
      // Only subtractive blending
      this.plotter = putPixel32Sub;
      this.maxAlpha = 128;
    } else {
      // Alpha blending
      this.plotter = putPixel32;
      this.maxAlpha = 255;
    }
  }

  /**
   * Renders a line of grains.
   * @param x - The X coordinate to draw to.
   * @param y - The Y coordinate to draw to.
   * @param ox - The X coordinate of the origin.
   * @param oy - The Y coordinate of the origin.
   */
  renderSandpainter(x: number, y: number, ox: number, oy: number) {
    const worldStartW = this.host.options.viewport.x * this.host.options.world.w;
    const worldStartH = this.host.options.viewport.y * this.host.options.world.h;
    this.plotter(
      this.canvas,
      Math.round(ox - worldStartW),
      Math.round(oy - worldStartH),
      this.color,
      20,
    );

    // We intentionally don't use our PRNG, because we have to avoid desyncing the seed between
    // workers, where not all of them will draw the same sand painters.
    this.grainDistance += randomRange(-0.05, 0.05);
    const maxg = 1.0;
    if (this.grainDistance < 0) {
      this.grainDistance = 0;
    }
    if (this.grainDistance > maxg) {
      this.grainDistance = maxg;
    }

    // calculate grains by distance
    //const grains = Math.trunc( Math.sqrt( ( ox - x ) * ( ox - x ) + ( oy - y ) * ( oy - y ) ) );

    // lay down grains of sand (transparent pixels)
    const w = this.grainDistance / (this.host.options.sandPainterGrains - 1);

    let alpha = 0;
    let sine = 0;
    let xpos = 0;
    let ypos = 0;

    for (let i = 0; i < this.host.options.sandPainterGrains; ++i) {
      alpha = RenderKernel.ALPHA_LOOKUP[i];
      sine = RenderKernel.SINE_LOOKUP[Math.round(i * w * 999)];
      xpos = Math.round(ox + (x - ox) * sine - worldStartW);
      ypos = Math.round(oy + (y - oy) * sine - worldStartH);

      this.plotter(this.canvas, xpos, ypos, this.color, alpha * this.maxAlpha);
    }
  }
}

class Crack {
  readonly host: RenderKernel;
  readonly canvas: Canvas2D | Canvas2DHeadless;
  readonly crackGrid: Array<number>;
  readonly options: ApplicationOptions;

  position = new Vector2(0, 0);
  direction = 0;
  directionStep = 0;

  sandPainter: SandPainter | null = null;

  constructor(host: RenderKernel) {
    this.host = host;
    this.canvas = this.host.canvas;
    this.crackGrid = this.host.crackGrid;
    this.options = this.host.options;

    if (host.random.nextFloat() < this.options.curveChance) {
      this.directionStep =
        this.host.random.nextRange(this.options.curveMin, this.options.curveMax) *
        (this.host.random.nextBoolean() ? 1 : -1);
    }

    // find placement along existing crack
    this.findStart();

    if (this.options.sandPainterActive) {
      this.sandPainter = new SandPainter(this.host);
    }
  }

  /**
   * Find a starting location for this crack
   * @param initial - If true, pick a pre-generated seed instead of calling the PRNG
   */
  findStart(initial = false) {
    // shift until crack is found
    let found = false;
    let index = -1;
    const worldSize = this.options.world.w * this.options.world.h;
    if (initial) {
      index = this.host.seeds[Math.trunc(this.host.random.nextRange(0, this.host.seeds.length))];
      found = true;
    } else {
      while (!found) {
        index = Math.trunc(this.host.random.nextRange(0, worldSize));
        if (this.crackGrid[index] < 10000) {
          found = true;
        }
      }
    }

    let direction = this.crackGrid[index];
    if (this.options.preferDirection === this.options.spawnPerpendicular) {
      if (this.host.random.nextFloat() < 0.5) {
        direction -= 90 + Math.trunc(this.host.random.nextRange(-2, 2));
      } else {
        direction += 90 + Math.trunc(this.host.random.nextRange(-2, 2));
      }
    } else {
      const r = this.host.random.nextFloat();

      if (r < 0.25 && !this.options.preferSingleAngle) {
        direction -=
          this.options.preferDirection + 90 + Math.trunc(this.host.random.nextRange(-2, 2));
      } else if (r < 0.5) {
        direction -= this.options.preferDirection + Math.trunc(this.host.random.nextRange(-2, 2));
      } else if (r < 0.75 && !this.options.preferSingleAngle) {
        direction += this.options.preferDirection + Math.trunc(this.host.random.nextRange(-2, 2));
      } else {
        direction +=
          this.options.preferDirection + 90 + Math.trunc(this.host.random.nextRange(-2, 2));
      }
    }

    const px = Math.trunc(index % this.options.world.w);
    const py = Math.trunc(index / this.options.world.w);
    this.startCrack(px, py, direction);
    return;
  }

  startCrack(x: number, y: number, direction: number) {
    this.position = new Vector2(x, y);
    this.direction = direction;
    this.position.x += this.options.spawnDistance * Math.cos((direction * Math.PI) / 180);
    this.position.y += this.options.spawnDistance * Math.sin((direction * Math.PI) / 180);
  }

  move(_delta: number, _timestamp: number): boolean {
    if (this.position.x === 0 && this.position.y === 0) {
      this.findStart();
      return false;
    }

    // Otherwise workers desync.
    _delta = MS_PER_FRAME_60FPS;

    this.position.x += cosDegrees(this.direction) * ((_delta / MS_PER_FRAME_60FPS) * 0.1);
    this.position.y += sinDegrees(this.direction) * ((_delta / MS_PER_FRAME_60FPS) * 0.1);

    if (this.options.modulatePath) {
      this.direction +=
        this.directionStep +
        this.host.random.nextRange(
          -this.options.modulatePathAmount,
          this.options.modulatePathAmount,
        ) *
          10;
    } else {
      this.direction += this.directionStep;
    }

    let cx = this.position.x;
    let cy = this.position.y;
    if (this.options.fuzzyness > 0) {
      cx =
        this.position.x +
        this.host.random.nextRange(-this.options.fuzzyness, this.options.fuzzyness);
      cy =
        this.position.y +
        this.host.random.nextRange(-this.options.fuzzyness, this.options.fuzzyness);
    }

    cx = Math.round(cx);
    cy = Math.round(cy);
    if (cx < 0 || this.options.world.w < cx || cy < 0 || this.options.world.h < cy) {
      this.findStart();
      return true;
    }

    if (
      this.crackGrid[cy * this.options.world.w + cx] > 10000 ||
      Math.abs(this.crackGrid[Math.trunc(cy * this.options.world.w + cx)] - this.direction) < 5
    ) {
      this.crackGrid[Math.trunc(cy * this.options.world.w + cx)] = Math.round(this.direction);
      return false;
    }

    if (Math.abs(this.crackGrid[Math.trunc(cy * this.options.world.w + cx)] - this.direction) > 2) {
      this.findStart();
      return true;
    }

    return false;
  }

  /**
   * Apply sand-painting to the crack
   */
  draw() {
    // start checking one step away
    let rx = this.position.x;
    let ry = this.position.y;
    //let rx = Math.trunc(this.position.x-this.options.district.x*this.options.world.w);
    //let ry = Math.trunc(this.position.y-this.options.district.y*this.options.world.h);
    let openspace = true;

    // find extents of open space
    while (openspace) {
      // move perpendicular to crack
      const t = (this.direction * Math.PI) / 180;
      rx += 0.81 * Math.sin(t);
      ry -= 0.81 * Math.cos(t);
      const cx = Math.round(rx);
      const cy = Math.round(ry);
      if (0 <= cx && cx < this.options.world.w && 0 <= cy && cy < this.options.world.h) {
        // safe to check
        if (this.crackGrid[cy * this.options.world.w + cx] > 10000) {
          // space is open
        } else {
          openspace = false;
        }
      } else {
        openspace = false;
      }
    }
    // draw sand painter
    this.sandPainter?.renderSandpainter(rx, ry, this.position.x, this.position.y);
  }
}

class RenderKernel {
  static ALPHA_LOOKUP: Array<number>;
  static SINE_LOOKUP: Array<number>;

  host: CanvasWorkerInstance<Canvas2DHeadless, ApplicationOptions, RenderKernel>;
  canvas: Canvas2DHeadless;
  options: ApplicationOptions;
  random: Random;

  crackGrid: Array<number>;
  cracks: Array<Crack>;
  currentCrackCount = 0;
  totalCracksSpawned = 0;
  /**
   * The total maximum of cracks that will ever be spawned
   */
  maxCracking = 0;

  paused = false;

  #fade = -1;
  seeds = new Array<number>();
  palette: Palette;

  constructor(
    host: CanvasWorkerInstance<Canvas2DHeadless, ApplicationOptions, RenderKernel>,
    canvas: Canvas2DHeadless,
    options: ApplicationOptions,
  ) {
    RenderKernel.ALPHA_LOOKUP = Array.from({ length: options.sandPainterGrains }).map(
      (_value, index) => (0.1 - index / options.sandPainterGrains) * 2,
    );
    RenderKernel.SINE_LOOKUP = Array.from({ length: 1000 }).map((_value, index) =>
      Math.sin(index / 1000),
    );

    this.host = host;
    this.options = options;
    this.canvas = canvas;
    this.random = new Random(options.seed);
    this.palette = palette;

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${this.host.id}] Seed after construction: ${
          this.random.seed
        }`,
      );
    }

    this.canvas = canvas;

    this.crackGrid = new Array<number>();
    this.cracks = new Array<Crack>();
  }

  reconfigure(canvas: Canvas2DHeadless, options: Partial<ApplicationOptions> = {}) {
    this.options = { ...this.options, ...options };
    this.canvas = canvas;
    this.random = new Random(this.options.seed);

    this.options.blendingAdditive = this.options.darkMode;
    this.options.blendingSubtractive = false;

    const worldSize = this.options.world.w * this.options.world.h;
    this.maxCracking = Math.trunc(Math.sqrt(worldSize) * 10);
    this.options.cracksInitial = Math.trunc(this.maxCracking / 1000);
    this.options.cracksMax = clamp(Math.trunc(worldSize / 5000), 150, 550);

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${this.host.id}] reconfigure()'d seed:${
          this.random.seed
        } cracksMax:${this.options.cracksMax} maxCracking:${
          this.maxCracking
        } viewport:${JSON.stringify(this.options.viewport)} world:${this.options.world.w}x${
          this.options.world.h
        }`,
      );
    }

    this.crackGrid = new Array<number>(worldSize);
  }

  onDraw(delta: number, timestamp: number) {
    if (0 < this.#fade) {
      this.canvas.fade(
        this.options.darkMode ? this.options.canvasColorDark : this.options.canvasColorLight,
      );
      return;
    }

    if (this.paused) {
      return;
    }

    const viewportPixels = {
      x:
        this.options.viewport.x * this.options.world.w +
        (this.options.viewport.x === 0 ? this.options.padding : 0),
      y:
        this.options.viewport.y * this.options.world.h +
        (this.options.viewport.y === 0 ? this.options.padding : 0),
      w:
        this.options.viewport.w * this.options.world.w +
        (this.options.viewport.w === 1 ? -this.options.padding : 0),
      h:
        this.options.viewport.h * this.options.world.h +
        (this.options.viewport.h === 1 ? -this.options.padding : 0),
    };
    const isWithinViewport = (crack: Crack): boolean =>
      viewportPixels.x < crack.position.x &&
      crack.position.x < viewportPixels.w &&
      viewportPixels.y < crack.position.y &&
      crack.position.y < viewportPixels.h;

    let toCrack = 0;
    for (let iter = 0; iter < this.options.iterationsPerUpdate; ++iter) {
      for (let n = 0; n < this.currentCrackCount; ++n) {
        const crack = this.cracks[n];
        if (crack.move(delta, timestamp)) {
          ++toCrack;
          continue;
        }
        if (isWithinViewport(crack)) {
          crack.draw();
        }
      }
    }

    while (toCrack--) {
      if (this.spawnCrack()) {
        break;
      }
    }
  }

  /**
   * Spawns a new crack
   * @returns If the application has concluded.
   */
  spawnCrack(): boolean {
    if (this.paused) {
      return true;
    }

    // Restart in case we've had enough cracking
    if (this.maxCracking < ++this.totalCracksSpawned) {
      this.paused = true;

      if (this.options.devMode) {
        console.log(
          `${new Date().toLocaleTimeString()} [${this.host.id}] Crack limit reached. Stopping.`,
        );
      }

      this.host.postMessage({ type: "sceneFinish", timestamp: new Date().valueOf() });
    }

    if (this.currentCrackCount < this.options.cracksMax) {
      // make a new crack instance
      const crack = new Crack(this);
      this.cracks[this.currentCrackCount] = crack;
      ++this.currentCrackCount;
    }
    return false;
  }

  fadeOut() {
    this.#fade = 1000;
  }

  start(options: Partial<ApplicationOptions> = {}) {
    this.reconfigure(this.canvas, options);
    //this.options = { ...this.options, ...options };

    this.palette = new Palette(this.options.paletteIndex);
    this.paused = false;
    this.#fade = -1;

    if (this.options.devMode) {
      console.log(`${new Date().toLocaleTimeString()} [${this.host.id}] start()ing...`);
    }

    this.canvas.clearWith(
      ((this.options.darkMode ? this.options.canvasColorDark : this.options.canvasColorLight) <<
        2) |
        0xff,
    );
    this.canvas.update();

    // erase crack grid
    this.totalCracksSpawned = 0;
    for (let index = 0; index < this.options.world.h * this.options.world.w; ++index) {
      this.crackGrid[index] = 10001;
    }
    // make random crack seeds
    this.seeds = [];
    for (let k = 0; k < 16; ++k) {
      const i = Math.trunc(this.random.nextRange(0, this.options.world.h * this.options.world.w));
      this.crackGrid[i] = Math.round(this.random.nextFloat() * 360);
      this.seeds.push(i);
    }

    // make initial cracks
    this.currentCrackCount = 0;
    this.cracks = new Array<Crack>(this.options.cracksMax);
    for (let crackIdx = 0; crackIdx < this.options.cracksInitial; ++crackIdx) {
      this.spawnCrack();
    }

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${this.host.id}] start()ed seed:${
          this.random.seed
        } cracksMax:${this.options.cracksMax} maxCracking:${
          this.maxCracking
        } viewport:${JSON.stringify(this.options.viewport)} world:${this.options.world.w}x${
          this.options.world.h
        }`,
      );
    }
  }

  pause(paused: boolean): void {
    this.paused = paused;
  }
}

class Application extends CanvasSandboxHostApplication<Canvas2D, ApplicationOptions> {
  #started = new Date();
  #finished = 0;
  calibrating: boolean;
  palette: Palette;

  constructor(canvas: Canvas2D, options: ApplicationOptions) {
    super(canvas, options);

    this.palette = palette;
    this.calibrating = this.options.calibrationRequired;
    if (this.calibrating) {
      this.options.iterationsPerUpdate = 200;
    }

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${workerId}] Seed after construction: ${
          this.random.seed
        }`,
      );
    }

    this.options.world.w = this.canvas.width;
    this.options.world.h = this.canvas.height;

    this.rebuildWorkers();
  }

  rebuildWorkers() {
    const canvasContainer = getDocumentElementTypeByIdStrict(document, "main", HTMLDivElement);

    for (const worker of this.workers) {
      if (!isNil(worker.canvas)) {
        canvasContainer.removeChild(worker.canvas);
        worker.canvas = undefined;
      }
      worker.workerInstance.terminate();
    }
    this.workers.splice(0);

    for (let workerIndex = 0; workerIndex < this.options.workerCount; ++workerIndex) {
      const step = 1 / this.options.workerCount;

      const canvasId = `worker${workerIndex}`;
      const canvasNode = document.createElement("canvas");
      canvasNode.id = canvasId;
      canvasContainer.appendChild(canvasNode);

      const worker = new CanvasWorker(canvasId, new URL(import.meta.url), canvasNode, {
        ...this.options,
        viewport: {
          x: roundTo(workerIndex * step, 3),
          y: 0,
          w: roundTo(workerIndex * step + step, 3),
          h: 1,
        },
      });
      this.workers.push(worker);
    }
    this.#configureWorkers();
  }

  reconfigure(canvas: Canvas2D, options: Partial<ApplicationOptions> = {}) {
    this.options = {
      ...this.options,
      ...options,
      seed:
        !isNil(options.seed) && options.seed !== this.options.seed
          ? options.seed
          : this.options.seed + 1,
    };
    this.canvas = canvas;
    this.random = new Random(this.options.seed);

    const canvasContainer = getDocumentElementTypeByIdStrict(document, "main", HTMLDivElement);
    let canvasContainerWidth = 0;
    let canvasContainerHeight = 0;
    let canvasContainerWidthStyle = 0;
    let canvasContainerHeightStyle = 0;

    if (document.fullscreenElement !== null) {
      if (this.options.devMode) {
        console.log(
          `${new Date().toLocaleTimeString()} [${workerId}] Resizing DOM canvas according to fullscreen size: ${
            window.innerWidth
          }x${window.innerHeight}x${window.devicePixelRatio}`,
        );
      }

      this.canvas.canvasElement.width = window.innerWidth * window.devicePixelRatio;
      this.canvas.canvasElement.height = window.innerHeight * window.devicePixelRatio;
      canvasContainerWidth = window.innerWidth * window.devicePixelRatio;
      canvasContainerHeight = window.innerHeight * window.devicePixelRatio;

      canvasContainer.style.width = `${window.innerWidth}px`;
      canvasContainer.style.height = `${window.innerHeight}px`;
      canvasContainerWidthStyle = window.innerWidth;
      canvasContainerHeightStyle = window.innerHeight;

      canvasContainer.style.cursor = "none";
    } else {
      this.canvas.canvasElement.width = (document.body.clientWidth / 2) * window.devicePixelRatio;
      this.canvas.canvasElement.height = (document.body.clientHeight / 2) * window.devicePixelRatio;
      canvasContainerWidth = this.canvas.canvasElement.width;
      canvasContainerHeight = this.canvas.canvasElement.height;

      canvasContainer.style.width = `${document.body.clientWidth / 2}px`;
      canvasContainer.style.height = `${document.body.clientHeight / 2}px`;
      canvasContainerWidthStyle = document.body.clientWidth / 2;
      canvasContainerHeightStyle = document.body.clientHeight / 2;

      canvasContainer.style.cursor = "default";

      if (this.options.devMode) {
        console.log(
          `${new Date().toLocaleTimeString()} [${workerId}] Resized DOM canvas according to document size: ${
            document.body.clientWidth
          }x${document.body.clientHeight}x${window.devicePixelRatio} canvas:${
            this.canvas.canvasElement.width
          }x${this.canvas.canvasElement.height}`,
        );
      }
    }

    // Create a new rendering context for our proxy canvas.
    // Otherwise it will remain at the previous dimensions.
    this.canvas.refreshCanvasNode();

    this.options.world.w = canvasContainerWidth;
    this.options.world.h = canvasContainerHeight;

    this.options.blendingAdditive = this.options.darkMode;
    this.options.blendingSubtractive = false;

    const worldSize = this.options.world.w * this.options.world.h;
    const maxCracking = Math.trunc(Math.sqrt(worldSize) * 10);

    this.options.cracksInitial = Math.trunc(maxCracking / 1000);
    this.options.cracksMax = clamp(Math.trunc(worldSize / 5000), 150, 550);

    // Reconfigure workers. Sandbox resized the canvas
    for (const worker of this.workers) {
      if (!isNil(worker.canvas)) {
        canvasContainer.removeChild(worker.canvas);
        worker.canvas = undefined;
      }

      const canvasNode = document.createElement("canvas");
      canvasNode.id = worker.id;
      canvasNode.style.width = `${canvasContainerWidthStyle / this.options.workerCount}px`;
      canvasNode.style.height = `${canvasContainerHeightStyle}px`;
      canvasContainer.appendChild(canvasNode);
      worker.canvas = canvasNode;

      canvasNode.width = canvasContainerWidth / this.options.workerCount;
      canvasNode.height = canvasContainerHeight;
      const canvasOffscreen = canvasNode.transferControlToOffscreen();

      if (this.options.devMode) {
        console.log(`Reconfiguring [${worker.id}] with seed:${this.random.seed}`);
      }

      worker.canvasOffscreen = canvasOffscreen;
      worker.postMessage(
        {
          type: "reconfigure",
          id: worker.id,
          canvas: canvasOffscreen,
          width: canvasNode.width,
          height: canvasNode.height,
          options: {
            ...this.options,
            seed: this.random.seed,
            viewport: worker.options.viewport,
          },
        } as CanvasWorkerMessageReconfigure<ApplicationOptions>,
        [canvasOffscreen],
      );
    }

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${workerId}] reconfigure()'d seed:${
          this.random.seed
        } cracksMax:${this.options.cracksMax} maxCracking:${maxCracking}`,
      );
    }
  }

  #finishCalibration(workerCount: number, duration: number) {
    this.options.workerCount = workerCount;
    this.calibrating = false;
    this.options.iterationsPerUpdate = 4;
    this.options.calibrationRequired = false;
    localStorage.setItem("benchmark", JSON.stringify(duration));
    localStorage.setItem("options.workerCount", JSON.stringify(this.options.workerCount));
  }

  #configureWorkers() {
    const canvasContainer = getDocumentElementTypeByIdStrict(document, "main", HTMLDivElement);

    // Reconfigure workers. Sandbox resized the canvas shortly after construction.
    for (const worker of this.workers) {
      worker.addEventListener("sceneFinish", () => {
        ++this.#finished;
        const finishedDate = new Date();
        const duration = finishedDate.valueOf() - this.#started.valueOf();
        if (this.options.devMode) {
          console.log(
            `${new Date().toLocaleTimeString()} [${workerId}] ${
              worker.id
            } finished after (${roundTo(duration / 1000, 3)}s) (${this.#finished}/${
              this.workers.length
            })`,
          );
        }

        if (this.#finished === this.workers.length) {
          if (this.options.devMode) {
            console.log(
              `${new Date().toLocaleTimeString()} [${workerId}] scene finished after (${roundTo(
                duration / 1000,
                3,
              )}s) (${this.#finished}/${this.workers.length})`,
            );
          }

          if (this.calibrating) {
            this.options.calibrationData.push({
              duration,
              finished: finishedDate,
              started: this.#started,
              workerCount: this.options.workerCount,
            });

            const calibrationPrevious =
              1 < this.options.calibrationData.length
                ? this.options.calibrationData[this.options.calibrationData.length - 2]
                : null;

            const calibrationLatest =
              this.options.calibrationData[this.options.calibrationData.length - 1];

            const calibrationBest = this.options.calibrationData.reduce(
              (previous, current) => (previous.duration < current.duration ? previous : current),
              calibrationLatest,
            );

            if (
              this.options.calibrationEarlyExit &&
              calibrationPrevious &&
              calibrationPrevious.duration < calibrationLatest.duration
            ) {
              if (this.options.devMode) {
                console.warn(
                  `${new Date().toLocaleTimeString()} [${workerId}] Stopping calibration after previous run performed worse than best run! Using ${
                    this.options.workerCount
                  } workers.`,
                );
              }

              this.#finishCalibration(calibrationBest.workerCount, calibrationBest.duration);
            } else {
              ++this.options.workerCount;
              if (this.options.calibrationMaxWorkers < this.options.workerCount) {
                if (this.options.devMode) {
                  console.warn(
                    `${new Date().toLocaleTimeString()} [${workerId}] Stopping calibration after reaching worker limit (${
                      this.options.calibrationMaxWorkers
                    })! Using ${this.options.workerCount} workers.`,
                  );
                }

                this.#finishCalibration(calibrationBest.workerCount, calibrationBest.duration);
              } else {
                if (this.options.devMode) {
                  console.warn(
                    `${new Date().toLocaleTimeString()} [${workerId}] Scaling up to ${
                      this.options.workerCount
                    } workers!`,
                  );
                }
              }
            }
            this.rebuildWorkers();
          }
          this.moveToNext();
        }
      });

      if (!isNil(worker.canvas)) {
        canvasContainer.removeChild(worker.canvas);
        worker.canvas = undefined;
      }

      const canvasNode = document.createElement("canvas");
      canvasNode.id = worker.id;
      canvasContainer.appendChild(canvasNode);
      worker.canvas = canvasNode;

      canvasNode.width = this.canvas.width / this.options.workerCount;
      canvasNode.height = this.canvas.height;

      canvasNode.style.width = `${document.body.clientWidth / 2 / this.options.workerCount}px`;
      canvasNode.style.height = `${document.body.clientHeight / 2}px`;

      console.warn(
        `${new Date().toLocaleTimeString()} [${workerId}] Created canvas with dimensions ${
          canvasNode.width
        }x${canvasNode.height}`,
      );

      const canvasWorker = canvasNode.transferControlToOffscreen();

      worker.canvasOffscreen = canvasWorker;
      worker.postMessage(
        {
          type: "reconfigure",
          id: worker.id,
          canvas: canvasWorker,
          width: canvasNode.width,
          height: canvasNode.height,
          options: {
            ...worker.options,
            world: {
              w: this.canvas.width,
              h: this.canvas.height,
            },
          },
        } as CanvasWorkerMessageReconfigure<ApplicationOptions>,
        [canvasWorker],
      );
    }
  }

  moveToNext(): void {
    if (!this.calibrating) {
      this.palette.nextPalette();
      // Heavily mutate seed. Tiny increments produce a lot of similarity in long runs.
      this.random = new Random(this.options.seed * 3);
      this.options.seed = this.random.seed;

      const modulateDecide = this.random.nextFloat();
      this.options.modulatePath = modulateDecide < 0.2;
    }

    if (this.options.devMode) {
      console.log(`${new Date().toLocaleTimeString()} [${workerId}] Moving to next scene...`);
    }

    this.options.paletteIndex = this.palette.paletteIndex;
    for (const worker of this.workers) {
      worker.postMessage({ type: "fade" });
    }

    setTimeout(() => {
      this.start();
    }, 4000);
  }

  start(): void {
    super.start();

    const pausedElement = getDocumentElementTypeByIdStrict(document, "paused", HTMLDivElement);
    pausedElement.style.display = "none";

    this.#finished = 0;
    this.#started = new Date();

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${workerId}] start()ing... seed:${
          this.random.seed
        } cracksMax:${this.options.cracksMax}`,
      );
    }

    const paletteNode = getDocumentElementTypeByIdStrict(document, "palette", HTMLCanvasElement);
    paletteNode.width = document.body.clientWidth;
    renderPaletteSample(this.palette, paletteNode);
    const name = paletteName(this.palette.paletteIndex);

    const hashNode = getDocumentElementTypeByIdStrict(document, "hash", HTMLSpanElement);
    hashNode.innerText = `${hashCyrb53(
      `${this.random.seed}@${this.canvas.width}x${this.canvas.height}`,
    )}@${name.toLocaleLowerCase()}`;

    const calibrationPrevious =
      1 < this.options.calibrationData.length
        ? this.options.calibrationData[this.options.calibrationData.length - 2]
        : null;
    const calibrationLatest = this.options.calibrationData[this.options.calibrationData.length - 1];
    const calibrationBest = this.options.calibrationData.reduce(
      (previous, current) => (previous.duration < current.duration ? previous : current),
      calibrationLatest,
    );
    const calibratingNode = getDocumentElementTypeByIdStrict(
      document,
      "calibrating",
      HTMLDivElement,
    );
    calibratingNode.style.display = this.calibrating ? "flex" : "none";
    calibratingNode.textContent = `CALIBRATING\nj${calibrationLatest.workerCount} ${
      !Number.isFinite(calibrationLatest.duration) ? "pending" : calibrationLatest.duration
    }${
      calibrationPrevious
        ? ` ${
            calibrationPrevious.duration < calibrationLatest.duration
              ? `↑ +${calibrationLatest.duration - calibrationPrevious.duration}`
              : `↓ -${calibrationPrevious.duration - calibrationLatest.duration}`
          }`
        : ""
    }${
      Number.isFinite(calibrationBest.duration)
        ? `\nbest: ${calibrationBest.duration}@j${calibrationBest.workerCount}`
        : ""
    }`;

    if (this.options.devMode) {
      console.log(
        `${new Date().toLocaleTimeString()} [${workerId}] start()ed seed:${
          this.random.seed
        } cracksMax:${this.options.cracksMax} palette:${this.palette.paletteIndex} (${name})`,
      );
    }
  }

  pause(): void {
    super.pause();
    const pausedElement = getDocumentElementTypeByIdStrict(document, "paused", HTMLDivElement);
    pausedElement.style.display = this.paused ? "block" : "none";
  }
}

if (IS_WORKER) {
  // Worker
  const worker = new CanvasWorkerInstance(self, RenderKernel);
  worker.addEventListener("fade", () => worker.renderKernel?.fadeOut());
} else {
  // Host
  workerId = "host";
  const urlParameters = new URLSearchParams(document.location.search);
  const devMode = urlParameters.get("devMode") !== null;
  const forceCalibration = urlParameters.get("calibrate");
  const canvasNode = getDocumentElementTypeByIdStrict(document, "proxy", HTMLCanvasElement);

  const workerCountStored = localStorage.getItem("options.workerCount");
  applicationOptions.workerCount =
    isNil(forceCalibration) && !isNil(workerCountStored) ? Number(workerCountStored) : 1;
  applicationOptions.calibrationRequired = isNil(workerCountStored) || !isNil(forceCalibration);

  if (forceCalibration === "all") {
    applicationOptions.calibrationEarlyExit = false;
  }

  if (devMode) {
    applicationOptions.devMode = true;
  }

  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  document.body.addEventListener("click", async (event: MouseEvent) => {
    if (event.target !== document.body) {
      return;
    }
    event.preventDefault();
    const canvasContainer = getDocumentElementTypeByIdStrict(document, "main", HTMLDivElement);
    await canvasContainer.requestFullscreen();

    window.dispatchEvent(new Event("resize"));
  });

  // Construct application through sandbox.
  const canvasSandbox = new CanvasSandbox(
    window,
    canvasNode,
    Canvas2D,
    Application,
    applicationOptions,
    {
      devMode: applicationOptions.devMode,
    },
  );

  canvasSandbox.run();
}
