/**
 * billingExpr — safe parser + evaluator for upstream "tiered_expr" billing expressions.
 *
 * Upstream new-api sites expose real per-M prices in `billing_expr` when
 * `billing_mode === "tiered_expr"`; `model_ratio` is then only a placeholder.
 * We must evaluate those expressions locally instead of eval()/new Function().
 *
 * Evidenced grammar (happycoding.xyz / zero.cat /api/pricing payloads):
 *   - arithmetic:  + - * /  ( )
 *   - ternary:     cond ? a : b
 *   - logic:       &&  ||
 *   - comparison:  <  >  <=  >=  ==  !=
 *   - variables:   p (input tokens/M), c (output tokens/M), cr (cache read tokens/M),
 *                  cc (cache creation tokens/M), cc1h (1h cache creation tokens/M),
 *                  len (context length, raw tokens)
 *   - functions:   tier("name", expr) -> expr  (name is a label for audit only)
 *                  hour("UTC")        -> current hour (0..23) in the given timezone
 *
 * Anything outside this grammar (unknown identifier, unknown function, malformed
 * source) must make the caller fall back to the ratio path — never throw into billing.
 */

export type BillingExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; name: string }
  | { kind: 'unary'; op: '-' | '!'; operand: BillingExprNode }
  | {
    kind: 'binary';
    op: '+' | '-' | '*' | '/' | '<' | '>' | '<=' | '>=' | '==' | '!=' | '&&' | '||';
    left: BillingExprNode;
    right: BillingExprNode;
  }
  | { kind: 'ternary'; condition: BillingExprNode; consequent: BillingExprNode; alternate: BillingExprNode }
  | { kind: 'call'; name: string; args: BillingExprNode[] };

export interface ParsedBillingExpr {
  node: BillingExprNode;
  source: string;
}

/**
 * Evaluation context. Token variables are expressed in millions (token count / 1e6)
 * so that the $/M coefficients multiply directly into dollars. `len` is raw tokens
 * (context length) used only for tier selection. `now` drives hour(); defaults to new Date().
 */
export interface BillingExprContext {
  p?: number;
  c?: number;
  cr?: number;
  cc?: number;
  cc1h?: number;
  len?: number;
  now?: Date;
}

type Token =
  | { type: 'num'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'end' };

const TWO_CHAR_OPS = ['<=', '>=', '&&', '||', '==', '!='];
const ONE_CHAR_OPS = ['?', ':', '<', '>', '+', '-', '*', '/', '(', ')', ',', '!'];
const KNOWN_VARIABLES = new Set(['p', 'c', 'cr', 'cc', 'cc1h', 'len']);
const KNOWN_FUNCTIONS = new Set(['tier', 'hour']);
const MAX_EXPR_LENGTH = 4096;
const MAX_TOKENS = 1024;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;

  while (i < n) {
    const ch = source[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < n && /[0-9.]/.test(source[j])) j += 1;
      const raw = source.slice(i, j);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`invalid number "${raw}"`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = '';
      while (j < n && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < n) {
          const esc = source[j + 1];
          if (esc === quote) out += quote;
          else if (esc === '\\') out += '\\';
          else if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= n) throw new Error('unterminated string');
      tokens.push({ type: 'string', value: out });
      i = j + 1;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push({ type: 'ident', value: source.slice(i, j) });
      i = j;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.includes(two)) {
      tokens.push({ type: 'op', value: two });
      i += 2;
      continue;
    }

    if (ONE_CHAR_OPS.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i += 1;
      continue;
    }

    throw new Error(`unexpected character "${ch}" at position ${i}`);
  }

  tokens.push({ type: 'end' });
  return tokens;
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.type === 'op' && t.value === value;
  }

  private isOpAny(values: string[]): boolean {
    const t = this.peek();
    return t.type === 'op' && values.includes(t.value);
  }

  private expectOp(value: string): void {
    if (!this.isOp(value)) throw new Error(`expected "${value}"`);
    this.pos += 1;
  }

  parse(): BillingExprNode {
    const node = this.parseTernary();
    if (this.peek().type !== 'end') throw new Error('unexpected trailing tokens');
    return node;
  }

  private parseTernary(): BillingExprNode {
    const condition = this.parseOr();
    if (this.isOp('?')) {
      this.pos += 1;
      const consequent = this.parseTernary();
      this.expectOp(':');
      const alternate = this.parseTernary();
      return { kind: 'ternary', condition, consequent, alternate };
    }
    return condition;
  }

  private parseOr(): BillingExprNode {
    let left = this.parseAnd();
    while (this.isOp('||')) {
      this.pos += 1;
      const right = this.parseAnd();
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  private parseAnd(): BillingExprNode {
    let left = this.parseEq();
    while (this.isOp('&&')) {
      this.pos += 1;
      const right = this.parseEq();
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  private parseEq(): BillingExprNode {
    let left = this.parseComparison();
    while (this.isOpAny(['==', '!='])) {
      const op = this.nextOp() as '==' | '!=';
      const right = this.parseComparison();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseComparison(): BillingExprNode {
    let left = this.parseAdditive();
    while (this.isOpAny(['<', '>', '<=', '>='])) {
      const op = this.nextOp() as '<' | '>' | '<=' | '>=';
      const right = this.parseAdditive();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseAdditive(): BillingExprNode {
    let left = this.parseMultiplicative();
    while (this.isOpAny(['+', '-'])) {
      const op = this.nextOp() as '+' | '-';
      const right = this.parseMultiplicative();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseMultiplicative(): BillingExprNode {
    let left = this.parseUnary();
    while (this.isOpAny(['*', '/'])) {
      const op = this.nextOp() as '*' | '/';
      const right = this.parseUnary();
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  private parseUnary(): BillingExprNode {
    if (this.isOpAny(['-', '!'])) {
      const op = this.nextOp() as '-' | '!';
      const operand = this.parseUnary();
      return { kind: 'unary', op, operand };
    }
    return this.parseCall();
  }

  private parseCall(): BillingExprNode {
    const primary = this.parsePrimary();
    if (primary.kind === 'ident' && this.isOp('(')) {
      this.pos += 1;
      const args: BillingExprNode[] = [];
      if (!this.isOp(')')) {
        args.push(this.parseTernary());
        while (this.isOp(',')) {
          this.pos += 1;
          args.push(this.parseTernary());
        }
      }
      this.expectOp(')');
      return { kind: 'call', name: primary.name, args };
    }
    return primary;
  }

  private nextOp(): string {
    const t = this.peek();
    if (t.type !== 'op') throw new Error('expected operator');
    this.pos += 1;
    return t.value;
  }

  private parsePrimary(): BillingExprNode {
    const t = this.peek();
    if (t.type === 'num') {
      this.pos += 1;
      return { kind: 'num', value: t.value };
    }
    if (t.type === 'string') {
      this.pos += 1;
      return { kind: 'string', value: t.value };
    }
    if (t.type === 'ident') {
      this.pos += 1;
      return { kind: 'ident', name: t.value };
    }
    if (this.isOp('(')) {
      this.pos += 1;
      const node = this.parseTernary();
      this.expectOp(')');
      return node;
    }
    throw new Error('unexpected token');
  }
}

/** Walk the AST and reject any identifier/function outside the covered set. */
function findUnsupportedSymbol(node: BillingExprNode): string | null {
  switch (node.kind) {
    case 'ident':
      return KNOWN_VARIABLES.has(node.name) ? null : `unknown identifier "${node.name}"`;
    case 'call': {
      if (!KNOWN_FUNCTIONS.has(node.name)) return `unknown function "${node.name}"`;
      for (const arg of node.args) {
        const err = findUnsupportedSymbol(arg);
        if (err) return err;
      }
      return null;
    }
    case 'binary': {
      return findUnsupportedSymbol(node.left) ?? findUnsupportedSymbol(node.right);
    }
    case 'ternary':
      return (
        findUnsupportedSymbol(node.condition)
        ?? findUnsupportedSymbol(node.consequent)
        ?? findUnsupportedSymbol(node.alternate)
      );
    case 'unary':
      return findUnsupportedSymbol(node.operand);
    default:
      return null;
  }
}

/**
 * Compile a billing expression into an AST. Returns null (never throws) when the
 * source is empty, too large, malformed, or uses syntax we do not cover — so the
 * caller can fall back to the ratio path.
 */
export function parseBillingExpr(source: string): ParsedBillingExpr | null {
  if (typeof source !== 'string') return null;
  const trimmed = source.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_EXPR_LENGTH) return null;

  let tokens: Token[];
  try {
    tokens = tokenize(trimmed);
  } catch {
    return null;
  }
  if (tokens.length > MAX_TOKENS) return null;

  let node: BillingExprNode;
  try {
    node = new Parser(tokens).parse();
  } catch {
    return null;
  }

  if (findUnsupportedSymbol(node)) return null;

  return { node, source: trimmed };
}

function numOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isTruthy(value: number): boolean {
  return value !== 0;
}

function hourInTimezone(timeZone: string, now: Date): number {
  // Case-insensitive UTC/GMT fast path (IANA timezones are case-insensitive in practice).
  const tz = timeZone.toUpperCase();
  if (tz === 'UTC' || tz === 'GMT') {
    return now.getUTCHours();
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hourPart = parts.find((part) => part.type === 'hour');
  const hour = Number(hourPart?.value);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid timezone "${timeZone}"`);
  }
  return hour;
}

function evalCall(name: string, args: BillingExprNode[], ctx: BillingExprContext): number {
  if (name === 'tier') {
    if (args.length !== 2) throw new Error('tier() expects exactly 2 arguments');
    if (args[0].kind !== 'string') throw new Error('tier() first argument must be a string name');
    return evalNode(args[1], ctx);
  }
  if (name === 'hour') {
    if (args.length !== 1) throw new Error('hour() expects exactly 1 argument');
    if (args[0].kind !== 'string') throw new Error('hour() argument must be a timezone string');
    return hourInTimezone(args[0].value, ctx.now ?? new Date());
  }
  throw new Error(`unknown function "${name}"`);
}

function evalNode(node: BillingExprNode, ctx: BillingExprContext): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'string':
      throw new Error('string value in numeric context');
    case 'ident':
      return evalIdent(node.name, ctx);
    case 'unary': {
      const value = evalNode(node.operand, ctx);
      if (node.op === '-') return -value;
      // '!' is logical negation: truthy -> 0, falsy -> 1.
      return isTruthy(value) ? 0 : 1;
    }
    case 'binary': {
      if (node.op === '&&') {
        return isTruthy(evalNode(node.left, ctx)) && isTruthy(evalNode(node.right, ctx)) ? 1 : 0;
      }
      if (node.op === '||') {
        return isTruthy(evalNode(node.left, ctx)) || isTruthy(evalNode(node.right, ctx)) ? 1 : 0;
      }
      const left = evalNode(node.left, ctx);
      const right = evalNode(node.right, ctx);
      switch (node.op) {
        case '+': return left + right;
        case '-': return left - right;
        case '*': return left * right;
        case '/': return left / right;
        case '<': return left < right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
        default:
          throw new Error(`unsupported operator "${node.op}"`);
      }
    }
    case 'ternary':
      return isTruthy(evalNode(node.condition, ctx))
        ? evalNode(node.consequent, ctx)
        : evalNode(node.alternate, ctx);
    case 'call':
      return evalCall(node.name, node.args, ctx);
    default:
      throw new Error('unknown expression node');
  }
}

function evalIdent(name: string, ctx: BillingExprContext): number {
  switch (name) {
    case 'p': return numOrZero(ctx.p);
    case 'c': return numOrZero(ctx.c);
    case 'cr': return numOrZero(ctx.cr);
    case 'cc': return numOrZero(ctx.cc);
    case 'cc1h': return numOrZero(ctx.cc1h);
    case 'len': return numOrZero(ctx.len);
    default:
      throw new Error(`unknown identifier "${name}"`);
  }
}

/**
 * Evaluate a compiled expression to a cost in dollars. Throws on any evaluation
 * failure (unknown runtime value, invalid timezone, etc.) so the caller can catch
 * and fall back to the ratio path.
 */
export function evaluateBillingExpr(parsed: ParsedBillingExpr, ctx: BillingExprContext): number {
  const result = evalNode(parsed.node, ctx);
  if (!Number.isFinite(result)) throw new Error('evaluation produced a non-finite value');
  return result;
}
