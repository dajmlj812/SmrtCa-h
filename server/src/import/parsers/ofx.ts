import { parseAmountToCents } from '../../domain/money.js';
import type { ParsedTransaction, RowError } from '../types.js';

/**
 * Parse an OFX or QFX file.
 *
 * Two on-wire shapes exist:
 *
 *   - **OFX 1.x** ships a `KEY:VALUE` header block (one of the lines
 *     reads `OFXHEADER:100`) followed by an SGML body where close
 *     tags are optional — text values terminate at the next `<`.
 *   - **OFX 2.x** ships a real XML declaration + processing
 *     instruction (`<?OFX OFXHEADER="200" ... ?>`) and a strict XML
 *     body.
 *
 * QFX is Intuit's branded variant; structurally identical, just
 * adds `INTU.BID` / `INTU.USERID` fields. We treat it as OFX.
 *
 * We do not validate the full schema — we walk `STMTTRN` (statement
 * transaction) nodes and pull the fields we care about. Anything we
 * don't understand is ignored.
 */
export interface OfxParseResult {
  formatId: string;
  formatName: string;
  transactions: ParsedTransaction[];
  errors: RowError[];
}

/**
 * Quick sniff used by parseImportFile to decide whether a buffer is
 * OFX/QFX. Looks for either the OFX 1.x header line or the OFX 2.x
 * processing instruction.
 */
export function looksLikeOfx(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 2048).toString('utf-8').toUpperCase();
  if (head.includes('OFXHEADER')) return true;
  if (head.includes('<OFX>')) return true;
  return false;
}

export function parseOfx(buffer: Buffer, filename: string): OfxParseResult {
  const text = stripBom(buffer.toString('utf-8'));
  const body = stripOfxHeader(text);
  const root = parseSgml(body);

  const isQfx = filename.toLowerCase().endsWith('.qfx');
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];
  let counter = 0;

  // STMTTRN nodes can appear under bank statements OR credit card
  // statements OR investment statements; walk the whole tree.
  for (const trn of findAll(root, 'STMTTRN')) {
    counter += 1;
    try {
      transactions.push(buildTxn(trn));
    } catch (err) {
      errors.push({
        rowNumber: counter,
        message: err instanceof Error ? err.message : String(err),
        raw: nodeToRecord(trn),
      });
    }
  }

  return {
    formatId: isQfx ? 'qfx' : 'ofx',
    formatName: isQfx ? 'Quicken QFX' : 'OFX',
    transactions,
    errors,
  };
}

// --- Header handling -------------------------------------------------------

function stripOfxHeader(text: string): string {
  // OFX 2.x: starts with <?xml ... ?> and optional <?OFX ... ?>.
  // Drop everything up to the first '<OFX>' tag.
  const ofxIdx = text.indexOf('<OFX>');
  if (ofxIdx < 0) {
    // Some lenient producers wrap content in <ofx> lowercase.
    const lowerIdx = text.toLowerCase().indexOf('<ofx>');
    if (lowerIdx < 0) throw new Error('OFX file has no <OFX> root tag');
    return text.slice(lowerIdx);
  }
  return text.slice(ofxIdx);
}

// --- Tolerant SGML parser --------------------------------------------------

interface SgmlNode {
  tag: string;
  children: SgmlNode[];
  text: string;
  parent: SgmlNode | null;
}

function makeNode(tag: string, parent: SgmlNode | null): SgmlNode {
  return { tag, children: [], text: '', parent };
}

/**
 * Walk the SGML/XML body and build a tree. Tolerates:
 *  - missing close tags (OFX 1.x: `<NAME>Starbucks` ends at the next `<`)
 *  - mixed close-tag styles
 *  - whitespace between tags
 */
function parseSgml(body: string): SgmlNode {
  const root = makeNode('__root__', null);
  let cursor: SgmlNode = root;
  let i = 0;
  const N = body.length;

  while (i < N) {
    const lt = body.indexOf('<', i);
    if (lt < 0) break;

    // Text between previous tag and this one — attach to current node.
    if (lt > i) {
      const text = body.slice(i, lt).trim();
      if (text) cursor.text += (cursor.text ? ' ' : '') + decodeEntities(text);
    }

    const gt = body.indexOf('>', lt + 1);
    if (gt < 0) break;
    const raw = body.slice(lt + 1, gt).trim();
    i = gt + 1;

    if (raw.startsWith('!') || raw.startsWith('?')) continue; // comment / PI
    if (raw === '') continue;

    if (raw.startsWith('/')) {
      // Close tag. Walk up to the matching ancestor; if no match (the
      // SGML producer omitted opens or closes), stay where we are.
      const closeTag = raw.slice(1).trim().toUpperCase();
      let walker: SgmlNode | null = cursor;
      while (walker && walker.tag !== closeTag) walker = walker.parent;
      if (walker && walker.parent) cursor = walker.parent;
      continue;
    }

    // Self-closing `<TAG/>` or `<TAG ... />`.
    const selfClose = raw.endsWith('/');
    const tagName = (selfClose ? raw.slice(0, -1) : raw)
      .split(/\s+/)[0]!
      .toUpperCase();

    // OFX 1.x SGML: leaf elements omit their closing tag — text
    // terminates at the next `<`. When the current cursor already has
    // accumulated text (it's a leaf), treat it as closed before adding
    // this new sibling. OFX 2.x has explicit close tags, so this path
    // never triggers there.
    if (cursor.text !== '' && cursor.parent) {
      cursor = cursor.parent;
    }

    const node = makeNode(tagName, cursor);
    cursor.children.push(node);
    if (!selfClose) cursor = node;
  }

  return root;
}

function findAll(root: SgmlNode, tag: string): SgmlNode[] {
  const out: SgmlNode[] = [];
  const upper = tag.toUpperCase();
  function visit(node: SgmlNode) {
    if (node.tag === upper) out.push(node);
    for (const child of node.children) visit(child);
  }
  visit(root);
  return out;
}

function findChild(node: SgmlNode, tag: string): SgmlNode | null {
  const upper = tag.toUpperCase();
  for (const child of node.children) {
    if (child.tag === upper) return child;
  }
  return null;
}

function textOf(node: SgmlNode | null): string {
  return node ? node.text.trim() : '';
}

function nodeToRecord(node: SgmlNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of node.children) {
    const t = child.text.trim();
    if (t) out[child.tag] = t;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

// --- STMTTRN -> ParsedTransaction -----------------------------------------

function buildTxn(node: SgmlNode): ParsedTransaction {
  const trnType = textOf(findChild(node, 'TRNTYPE'));
  const dtPosted = textOf(findChild(node, 'DTPOSTED'));
  const trnAmt = textOf(findChild(node, 'TRNAMT'));
  const fitId = textOf(findChild(node, 'FITID'));
  const name = textOf(findChild(node, 'NAME'));
  const memo = textOf(findChild(node, 'MEMO'));
  const checkNum = textOf(findChild(node, 'CHECKNUM'));

  if (!dtPosted) throw new Error('STMTTRN missing DTPOSTED');
  if (!trnAmt) throw new Error('STMTTRN missing TRNAMT');

  const txnDate = parseOfxDate(dtPosted);
  const amountCents = parseAmountToCents(trnAmt);
  const description = (name || memo || trnType || '(unspecified)').trim();
  const memoOut =
    [memo, checkNum && `chk ${checkNum}`, fitId && `fit ${fitId}`]
      .filter((s): s is string => Boolean(s && s.trim() !== ''))
      .join(' | ') || null;

  return {
    txnDate,
    postDate: txnDate,
    amountCents,
    rawDescription: description,
    sourceCategory: null,
    sourceType: trnType || null,
    memo: memoOut,
    balanceCents: null,
  };
}

/**
 * OFX dates are `YYYYMMDD[HHMMSS[.SSS]][TZ]`. We accept the leading 8
 * digits and ignore anything after. TZ offsets are not used because
 * txn_date is a calendar date — the bank already settled this in their
 * local calendar.
 */
export function parseOfxDate(input: string): string {
  const s = input.trim();
  const match = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!match) throw new Error(`Unrecognized OFX date: "${input}"`);
  const [, y, m, d] = match;
  const mm = Number(m);
  const dd = Number(d);
  if (mm < 1 || mm > 12) throw new Error(`OFX date has invalid month: "${input}"`);
  if (dd < 1 || dd > 31) throw new Error(`OFX date has invalid day: "${input}"`);
  return `${y}-${m}-${d}`;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
