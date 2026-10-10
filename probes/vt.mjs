// A 200-line terminal, on purpose: it understands only what `log-update` actually emits (print, \r, \n, cursor up and
// down, erase-to-EOL) and it ignores SGR entirely, because the question this answers is "did a line exceed 40 cells" —
// not "does it look right", which only eyes can decide. Counting graphemes as one cell is a choice, and the wrongness
// of that choice for Indic spacing marks is the whole reason D-055 exists, so `graphemes(row).length` is what this
// returns and a real phone screen remains the authority on how those clusters land.
const SEG = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(text) {
  return [...SEG.segment(text)].map((s) => s.segment);
}

export class VtScreen {
  constructor({ cols = 80, rows = 40 } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.buf = Array.from({ length: rows }, () => []);
    this.y = 0;
    this.x = 0;
    this.overflow = 0;
    this.sgrSeen = new Set();
  }

  write(chunk) {
    let i = 0;
    const put = (g) => {
      if (!this.buf[this.y]) this.buf[this.y] = [];
      const line = this.buf[this.y];
      line[this.x] = (line[this.x] ?? "") + g;
      this.x += 1;
      if (this.x > this.overflow) this.overflow = this.x;
    };
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === "\x1b") {
        const rest = chunk.slice(i);
        // biome-ignore lint/suspicious/noControlCharactersInRegex: a VT parser's inputs *are* control bytes
        const osc = /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)/.exec(rest);
        if (osc !== null) {
          i += osc[0].length;
          continue;
        }
        // biome-ignore lint/suspicious/noControlCharactersInRegex: a VT parser's inputs *are* control bytes
        const csi = /^\x1b\[([0-9;?]*)([@A-Za-z])/.exec(rest);
        if (csi) {
          i += csi[0].length;
          this.#csi(csi[1], csi[2]);
          continue;
        }
        // biome-ignore lint/suspicious/noControlCharactersInRegex: a VT parser's inputs *are* control bytes
        const other = /^\x1b([()][0-9A-Za-z]|[=>78McDEHFG])/.exec(rest);
        i += other ? other[0].length : 1;
        continue;
      }
      if (ch === "\r") {
        this.x = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        this.y = Math.min(this.y + 1, this.rows - 1);
        this.x = 0;
        i += 1;
        continue;
      }
      if (ch === "\x08") {
        this.x = Math.max(0, this.x - 1);
        i += 1;
        continue;
      }
      if (ch === "\x07" || ch === "\x0f" || ch === "\x0e") {
        i += 1;
        continue;
      }
      // one grapheme at a time, so a combining mark never claims a cell of its own in *our* accounting
      const [g] = graphemes(chunk.slice(i, i + 8));
      if (g === undefined) {
        i += 1;
        continue;
      }
      if (this.x >= this.cols) {
        // ink truncates to the width; if a terminal ever receives this it would wrap, so record the intent
        this.overflow = Math.max(this.overflow, this.x + 1);
        i += g.length;
        continue;
      }
      put(g);
      i += g.length;
    }
    return this;
  }

  #csi(params, final) {
    const n = (d) => {
      const v = Number.parseInt(params.split(";")[0] ?? "", 10);
      return Number.isFinite(v) ? v : d;
    };
    switch (final) {
      case "A":
        this.y = Math.max(0, this.y - (n(1) || 1));
        break;
      case "B":
        this.y = Math.min(this.rows - 1, this.y + n(1));
        break;
      case "C":
        this.x = Math.min(this.cols - 1, this.x + n(1));
        break;
      case "D":
        this.x = Math.max(0, this.x - n(1));
        break;
      case "G":
        this.x = Math.max(0, n(1) - 1);
        break;
      case "f":
      case "H": {
        const [row, col] = params.split(";").map((v) => Number.parseInt(v, 10) || 1);
        this.y = Math.min(this.rows - 1, row - 1);
        this.x = Math.max(0, (col ?? 1) - 1);
        break;
      }
      case "K": {
        const mode = params.split(";")[0] ?? "";
        const line = this.buf[this.y] ?? [];
        if (mode === "" || mode === "0") for (let c = this.x; c < line.length; c++) delete line[c];
        else if (mode === "2") this.buf[this.y] = [];
        break;
      }
      case "J": {
        const mode = params.split(";")[0] ?? "";
        if (mode === "2" || mode === "3") {
          this.buf = Array.from({ length: this.rows }, () => []);
          this.y = 0;
          this.x = 0;
        }
        break;
      }
      case "m":
        for (const code of params.split(";")) if (code) this.sgrSeen.add(code);
        break;
      default:
        break;
    }
  }

  lines() {
    return this.buf.map((line) => (line ?? []).map((cell) => cell ?? "").join(""));
  }

  visible() {
    return this.lines().filter((l) => l.trim() !== "");
  }

  /** Longest row in cells, counting one grapheme per cell. */
  maxWidth() {
    return Math.max(0, ...this.lines().map((l) => graphemes(l.replace(/\s+$/, "")).length));
  }

  text() {
    return this.visible().join("\n");
  }

  /** How many cells were written past the last column: a real terminal would wrap them onto the next row, which is
   *  the failure mode a 40-column layout has to avoid, so it is a separate number from the visual width. */
  edgeOverflow() {
    return Math.max(0, this.overflow - this.cols);
  }
}
