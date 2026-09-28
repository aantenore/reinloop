/**
 * Frontmatter reader for agent files. Supports the YAML subset people actually write in
 * frontmatter: `key: value`, nested maps by indentation, `- item` lists, flow collections
 * (`[a, b]`, `{ maxTurns: 20 }`), quoted strings, `|` / `>` block scalars and `#` comments.
 */
export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const match = /^---\n([\s\S]*?)\n?---[ \t]*(?:\n|$)/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  return { data: parseYaml(match[1]!), body: normalized.slice(match[0].length) };
}

interface Line { indent: number; text: string; num: number }

export function parseYaml(src: string): Record<string, unknown> {
  const lines: Line[] = [];
  src.split('\n').forEach((raw, i) => {
    const text = stripComment(raw).trimEnd();
    if (text.trim()) lines.push({ indent: text.length - text.trimStart().length, text: text.trim(), num: i + 1 });
  });
  if (!lines.length) return {};
  const [value, next] = parseBlock(lines, 0, lines[0]!.indent, src);
  if (next < lines.length) throw new Error(`frontmatter line ${lines[next]!.num}: unexpected indentation`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('frontmatter must be a mapping');
  return value as Record<string, unknown>;
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

const isSeqItem = (l: Line) => l.text === '-' || l.text.startsWith('- ');

function parseBlock(lines: Line[], start: number, indent: number, src: string): [unknown, number] {
  return isSeqItem(lines[start]!) ? parseSeq(lines, start, indent, src) : parseMap(lines, start, indent, src);
}

function parseMap(lines: Line[], start: number, indent: number, src: string): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent && !isSeqItem(lines[i]!)) {
    const line = lines[i]!;
    const m = /^("[^"]*"|'[^']*'|[^:]+?)\s*:(?:\s+(.*))?$/.exec(line.text);
    if (!m) throw new Error(`frontmatter line ${line.num}: expected "key: value"`);
    const key = m[1]!.replace(/^["']|["']$/g, '');
    const rest = m[2]?.trim();
    i++;
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const block: string[] = [];
      const rawLines = src.split('\n');
      let j = line.num; // raw index of the next line (num is 1-based)
      while (j < rawLines.length && (rawLines[j]!.trim() === '' || rawLines[j]!.length - rawLines[j]!.trimStart().length > indent)) {
        block.push(rawLines[j]!);
        j++;
      }
      while (block.length && !block.at(-1)!.trim()) block.pop();
      const pad = Math.min(...block.filter((b) => b.trim()).map((b) => b.length - b.trimStart().length));
      const body = block.map((b) => b.slice(Number.isFinite(pad) ? pad : 0));
      out[key] = rest.startsWith('|') ? body.join('\n') : body.join(' ').replace(/\s+/g, ' ').trim();
      while (i < lines.length && lines[i]!.num <= j) i++;
    } else if (rest === undefined || rest === '') {
      if (i < lines.length && lines[i]!.indent > indent && !isSeqItem(lines[i]!) && !KEY.test(lines[i]!.text)) {
        [out[key], i] = plainContinuation(lines, i, indent, '');
      } else if (i < lines.length && lines[i]!.indent > indent) [out[key], i] = parseBlock(lines, i, lines[i]!.indent, src);
      else if (i < lines.length && lines[i]!.indent === indent && isSeqItem(lines[i]!)) [out[key], i] = parseSeq(lines, i, indent, src);
      else out[key] = null;
    } else if (!/^["'[{]/.test(rest) && i < lines.length && lines[i]!.indent > indent) {
      [out[key], i] = plainContinuation(lines, i, indent, rest); // plain scalar folded over several lines
    } else out[key] = parseInline(rest, line.num);
  }
  return [out, i];
}

const KEY = /^("[^"]*"|'[^']*'|[^:\s][^:]*?)\s*:(\s|$)/;

/** Multi-line plain scalar: deeper-indented lines are folded into one string with single spaces. */
function plainContinuation(lines: Line[], start: number, indent: number, first: string): [string, number] {
  const parts = first ? [first] : [];
  let i = start;
  while (i < lines.length && lines[i]!.indent > indent) parts.push(lines[i++]!.text);
  return [parts.join(' '), i];
}

function parseSeq(lines: Line[], start: number, indent: number, src: string): [unknown[], number] {
  const out: unknown[] = [];
  let i = start;
  while (i < lines.length && lines[i]!.indent === indent && isSeqItem(lines[i]!)) {
    const line = lines[i]!;
    const rest = line.text.slice(1).trim();
    if (!rest) {
      i++;
      if (i < lines.length && lines[i]!.indent > indent) [out[out.length], i] = parseBlock(lines, i, lines[i]!.indent, src);
      else out.push(null);
    } else if (/^[A-Za-z0-9_"'-][^:]*:(\s|$)/.test(rest) && !/^["'[{]/.test(rest)) {
      // "- key: value" starts an inline mapping; continuation keys sit two columns deeper.
      const virtual: Line[] = [{ indent: indent + 2, text: rest, num: line.num }, ...lines.slice(i + 1)];
      const [value, used] = parseMap(virtual, 0, indent + 2, src);
      out.push(value);
      i += used;
    } else {
      out.push(parseInline(rest, line.num));
      i++;
    }
  }
  return [out, i];
}

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~' || s === '') return null;
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return Number(s);
  return s;
}

function parseInline(text: string, num: number): unknown {
  if (!/^["'[{]/.test(text)) return scalar(text);
  const p = { s: text, i: 0, num };
  const value = flowValue(p);
  skipWs(p);
  if (p.i < p.s.length) throw new Error(`frontmatter line ${num}: unexpected "${p.s.slice(p.i)}"`);
  return value;
}

interface Cursor { s: string; i: number; num: number }

function skipWs(p: Cursor): void {
  while (p.i < p.s.length && /\s/.test(p.s[p.i]!)) p.i++;
}

function flowValue(p: Cursor): unknown {
  skipWs(p);
  const c = p.s[p.i];
  if (c === '[') {
    p.i++;
    const arr: unknown[] = [];
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === ']') return p.i++, arr;
      arr.push(flowValue(p));
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== ']') throw new Error(`frontmatter line ${p.num}: expected "," or "]"`);
    }
  }
  if (c === '{') {
    p.i++;
    const obj: Record<string, unknown> = {};
    for (;;) {
      skipWs(p);
      if (p.s[p.i] === '}') return p.i++, obj;
      const key = String(p.s[p.i] === '"' || p.s[p.i] === "'" ? quoted(p) : bare(p, ':'));
      skipWs(p);
      if (p.s[p.i] !== ':') throw new Error(`frontmatter line ${p.num}: expected ":" after "${key}"`);
      p.i++;
      obj[key] = flowValue(p);
      skipWs(p);
      if (p.s[p.i] === ',') p.i++;
      else if (p.s[p.i] !== '}') throw new Error(`frontmatter line ${p.num}: expected "," or "}"`);
    }
  }
  if (c === '"' || c === "'") return quoted(p);
  return scalar(bare(p, ',]}'));
}

function bare(p: Cursor, stops: string): string {
  const start = p.i;
  while (p.i < p.s.length && !stops.includes(p.s[p.i]!)) p.i++;
  return p.s.slice(start, p.i).trim();
}

function quoted(p: Cursor): string {
  const q = p.s[p.i]!;
  let out = '';
  p.i++;
  while (p.i < p.s.length) {
    const c = p.s[p.i]!;
    if (q === "'" && c === "'" && p.s[p.i + 1] === "'") {
      out += "'";
      p.i += 2;
      continue;
    }
    if (c === q) {
      p.i++;
      return q === '"' ? JSON.parse(`"${out}"`) : out;
    }
    if (q === '"' && c === '\\') {
      out += c + p.s[p.i + 1];
      p.i += 2;
      continue;
    }
    out += c;
    p.i++;
  }
  throw new Error(`frontmatter line ${p.num}: unterminated string`);
}
