import { parseEntities } from "parse-entities";
import { parse, postprocess, preprocess } from "micromark";
import {
  blankLine,
  codeFenced,
  codeText,
  content,
} from "micromark-core-commonmark";
import { factorySpace } from "micromark-factory-space";
import type { Processor } from "unified";
import type {
  Code,
  Effects,
  Extension,
  State,
  Token,
  TokenizeContext,
  Tokenizer,
} from "micromark-util-types";
import type {
  CompileContext,
  Extension as FromMarkdownExtension,
} from "mdast-util-from-markdown";
import type { Root, Node, Nodes } from "mdast";

interface Tag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  properties: Record<string, string | boolean>;
  bodyStart?: number;
  bodyEnd?: number;
}
interface RegisteredBoundary extends Node, Tag {
  type: "registeredTag";
}
interface RegisteredContainer extends Node {
  type: "registeredContainer";
  name: string;
  value?: string;
  closed?: boolean;
  children?: Nodes[];
}
declare module "mdast" {
  interface RootContentMap {
    registeredTag: RegisteredBoundary;
    registeredContainer: RegisteredContainer;
  }
}
declare module "unified" {
  interface Data {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: FromMarkdownExtension[];
  }
}
interface ContainerNode {
  type: string;
  name?: string;
  closed?: boolean;
  closing?: boolean;
  selfClosing?: boolean;
  properties?: Tag["properties"];
  children?: ContainerNode[];
  position?: Root["position"];
  data?: { hName?: string; hProperties?: Tag["properties"] };
}

declare module "micromark-util-types" {
  interface Token {
    registeredTag?: Tag;
  }
  interface TokenTypeMap {
    registeredTag: "registeredTag";
    registeredTagMarker: "registeredTagMarker";
    registeredLiteral: "registeredLiteral";
    registeredLiteralData: "registeredLiteralData";
    registeredLiteralClose: "registeredLiteralClose";
  }
}

/**
 * Registered tags are Markdown container boundaries, not raw HTML blocks.
 *
 * Tokenize only the tags. CommonMark still owns the body (including code,
 * links, lists and headings). The mdast extension emits boundary nodes rather
 * than JSX elements: streaming input need not be a balanced XML document.
 * Folding the boundaries afterwards also lets a close tag end a list item
 * without incorrectly making the next widget a child of that item.
 */
export function remarkRegisteredContainers(
  this: Processor,
  options: {
    names: string[];
    literal?: string[];
  }
) {
  const data = this.data();
  (data.micromarkExtensions ??= []).push(registeredContainers(options));
  (data.fromMarkdownExtensions ??= []).push({
    enter: {
      registeredTag(this: CompileContext, token: Token) {
        this.enter(
          {
            type: "registeredTag",
            ...token.registeredTag!,
          },
          token
        );
      },
      registeredLiteral(this: CompileContext, token: Token) {
        const tag = token.registeredTag!;
        const raw = this.sliceSerialize(token);
        const value = raw.slice(
          tag.bodyStart! - token.start.offset,
          (tag.bodyEnd ?? token.end.offset) - token.start.offset
        );
        this.enter(
          {
            type: "registeredContainer",
            name: tag.name,
            closed: tag.bodyEnd !== undefined,
            value,
            data: {
              hName: tag.name,
              hProperties: tag.properties,
              // Keep literal data outside phrasing syntax transformations
              // (notably GFM's post-parse bare-URL autolink transform).
              hChildren: [{ type: "text", value }],
            },
          },
          token
        );
      },
    },
    exit: {
      registeredTag(this: CompileContext, token: Token) {
        this.exit(token);
      },
      registeredLiteral(this: CompileContext, token: Token) {
        this.exit(token);
      },
    },
  });
  return foldContainers;
}

/** The same lexical grammar is shared by repair protection and Markdown. */
function registeredContainers(options: {
  names: string[];
  literal?: string[];
}): Extension {
  const names = new Set(options.names.map((name) => name.toLowerCase()));
  const literals = new Set(options.literal?.map((name) => name.toLowerCase()));
  const text = { name: "registeredTag", tokenize: tokenizeTag(false) };
  const flow = {
    name: "registeredTagFlow",
    concrete: true,
    tokenize: tokenizeTag(true),
  };
  return { flow: { 60: flow }, text: { 60: text } };

  function tokenizeTag(isFlow: boolean): Tokenizer {
    return function (
      this: TokenizeContext,
      effects: Effects,
      ok: State,
      nok: State
    ) {
      const self = this;
      let token: Token;
      let name = "";
      let closing = false;
      let selfClosing = false;
      const properties: Record<string, string | boolean> = Object.create(null);
      let attribute = "";
      let value = "";
      let quote: number;
      let literal = false;
      let bodyDataOpen = false;
      let literalLineStart = true;
      let protectedUntil = -1;
      return start;

      function consume(code: number | null) {
        if (lineEnding(code)) effects.enter("lineEnding");
        effects.consume(code);
        if (lineEnding(code)) effects.exit("lineEnding");
      }
      function start(code: number | null): ReturnType<State> {
        if (code !== 60) return nok(code);
        token = effects.enter("registeredTag");
        effects.enter("registeredTagMarker");
        consume(code);
        return beforeName;
      }
      function beforeName(code: number | null): ReturnType<State> {
        if (code === 47) {
          closing = true;
          consume(code);
        } else {
          return inName(code);
        }
        return inName;
      }
      function inName(code: number | null): ReturnType<State> {
        if (nameCharacter(code)) {
          name += String.fromCharCode(code as number).toLowerCase();
          consume(code);
          return inName;
        }
        if (!names.has(name)) return nok(code);
        return beforeAttribute(code);
      }
      function beforeAttribute(code: number | null): ReturnType<State> {
        if (space(code)) {
          consume(code);
          return beforeAttribute;
        }
        if (code === 62) return tagEnd(code);
        if (code === 47 && !closing) {
          selfClosing = true;
          consume(code);
          return slashEnd;
        }
        if (code === null || closing || !attributeCharacter(code)) {
          return nok(code);
        }
        attribute = "";
        value = "";
        return inAttribute(code);
      }
      function inAttribute(code: number | null): ReturnType<State> {
        if (attributeCharacter(code)) {
          attribute += String.fromCharCode(code as number).toLowerCase();
          consume(code);
          return inAttribute;
        }
        return afterAttribute(code);
      }
      function afterAttribute(code: number | null): ReturnType<State> {
        if (space(code)) {
          consume(code);
          return afterAttribute;
        }
        if (code === 61) {
          consume(code);
          return beforeValue;
        }
        properties[attribute] = true;
        return beforeAttribute(code);
      }
      function beforeValue(code: number | null): ReturnType<State> {
        if (space(code)) {
          consume(code);
          return beforeValue;
        }
        if (code === 34 || code === 39) {
          quote = code;
          consume(code);
          return quotedValue;
        }
        if (code === null || code === 62) return nok(code);
        return unquotedValue(code);
      }
      function quotedValue(code: number | null): ReturnType<State> {
        if (code === null) return nok(code);
        if (code === quote) {
          consume(code);
          properties[attribute] = parseEntities(value, { attribute: true });
          return beforeAttribute;
        }
        value += character(code);
        consume(code);
        return quotedValue;
      }
      function unquotedValue(code: number | null): ReturnType<State> {
        if (code === null || code === 62 || space(code)) {
          properties[attribute] = parseEntities(value, { attribute: true });
          return beforeAttribute(code);
        }
        if (
          code === 34 ||
          code === 39 ||
          code === 60 ||
          code === 61 ||
          code === 96
        ) {
          return nok(code);
        }
        value += character(code);
        consume(code);
        return unquotedValue;
      }
      function slashEnd(code: number | null): ReturnType<State> {
        return code === 62 ? tagEnd(code) : nok(code);
      }
      function tagEnd(code: number | null): ReturnType<State> {
        consume(code);
        effects.exit("registeredTagMarker");
        token.registeredTag = { name, closing, selfClosing, properties };
        if (self.interrupt) {
          effects.exit("registeredTag");
          return ok;
        }
        literal = !closing && !selfClosing && literals.has(name);
        if (literal) {
          token.type = "registeredLiteral";
          token.registeredTag!.bodyStart = self.now().offset;
          return literalBody;
        }
        effects.exit("registeredTag");
        return isFlow ? tail : ok;
      }
      function literalBody(code: number | null): ReturnType<State> {
        if (code === null) {
          if (bodyDataOpen) effects.exit("registeredLiteralData");
          effects.exit("registeredLiteral");
          return isFlow ? tail(code) : ok(code);
        }
        if (lineEnding(code)) {
          if (bodyDataOpen) {
            effects.exit("registeredLiteralData");
            bodyDataOpen = false;
          }
          consume(code);
          literalLineStart = true;
          return literalBody;
        }
        if (self.now().offset < protectedUntil) return consumeLiteral(code);
        const codeConstructs =
          literalLineStart && (code === 96 || code === 126)
            ? [codeFenced, ...(code === 96 ? [codeText] : [])]
            : code === 96
              ? [codeText]
              : [];
        if (codeConstructs.length > 0) {
          return effects.check(
            {
              tokenize(e: Effects, yes: State, no: State) {
                return e.attempt(
                  codeConstructs,
                  (next: number | null) => {
                    protectedUntil = self.now().offset;
                    return yes(next);
                  },
                  no
                );
              },
            },
            consumeLiteral,
            unprotectedLiteral
          )(code);
        }
        return unprotectedLiteral(code);
      }
      function unprotectedLiteral(code: number | null): ReturnType<State> {
        if (code === 60) {
          return effects.check(
            { tokenize: literalClose },
            beforeLiteralClose,
            consumeLiteral
          )(code);
        }
        return consumeLiteral(code);
      }
      function consumeLiteral(code: number | null): ReturnType<State> {
        if (!bodyDataOpen) {
          effects.enter("registeredLiteralData");
          bodyDataOpen = true;
        }
        consume(code);
        if (code !== 32 && code !== -2 && code !== -1) literalLineStart = false;
        return literalBody;
      }
      function beforeLiteralClose(code: number | null): ReturnType<State> {
        if (bodyDataOpen) {
          effects.exit("registeredLiteralData");
          bodyDataOpen = false;
        }
        token.registeredTag!.bodyEnd = self.now().offset;
        return effects.attempt(
          { tokenize: literalClose },
          afterLiteralClose
        )(code);
      }
      function literalClose(e: Effects, yes: State, no: State) {
        let index = 0;
        const expected = `</${name}`;
        return begin;
        function begin(code: Code): ReturnType<State> {
          e.enter("registeredLiteralClose");
          return match(code);
        }
        function match(code: number | null): ReturnType<State> {
          if (
            code !== null &&
            index < expected.length &&
            String.fromCharCode(code).toLowerCase() === expected[index]
          ) {
            index++;
            e.consume(code);
            return match;
          }
          if (index === expected.length) {
            if (space(code)) {
              e.consume(code);
              return match;
            }
            if (code === 62) {
              e.consume(code);
              e.exit("registeredLiteralClose");
              return yes;
            }
          }
          return no(code);
        }
      }
      function afterLiteralClose(code: number | null): ReturnType<State> {
        effects.exit("registeredLiteral");
        return isFlow ? tail(code) : ok(code);
      }
      // Continue the SAME flow tokenizer after a tag. This is the ordinary
      // CommonMark flow dispatch, not a second parse or a body substring.
      // It permits `<tab>### Title`, and preserves paragraphs/fences spanning
      // subsequent lines. Tag boundaries remain events in that single stream.
      function tail(code: number | null): ReturnType<State> {
        if (code === null) return ok(code);
        if (lineEnding(code)) return afterFlow(code);
        return nextFlow(code);
      }
      function nextFlow(code: number | null): ReturnType<State> {
        if (code === null) return ok(code);
        return effects.attempt(
          blankLine,
          afterBlank,
          effects.attempt(
            self.parser.constructs.flowInitial,
            afterFlow,
            factorySpace(
              effects,
              effects.attempt(
                self.parser.constructs.flow,
                afterFlow,
                effects.attempt(content, afterFlow)
              ),
              "linePrefix"
            )
          )
        )(code);
      }
      function afterBlank(code: number | null): ReturnType<State> {
        if (code === null) return ok(code);
        effects.enter("lineEndingBlank");
        effects.consume(code);
        effects.exit("lineEndingBlank");
        self.currentConstruct = undefined;
        return nextFlow;
      }
      function afterFlow(code: number | null): ReturnType<State> {
        if (code === null) return ok(code);
        effects.enter("lineEnding");
        effects.consume(code);
        effects.exit("lineEnding");
        self.currentConstruct = undefined;
        return nextFlow;
      }
    };
  }
}

/** Locate literal tokens using the same grammar, without building another AST. */
export function registeredLiteralRanges(
  source: string,
  options: { names: string[]; literal?: string[] }
): Array<{ start: number; end: number }> {
  if (!options.literal?.length || !source.includes("<")) return [];
  const events = postprocess(
    parse({ extensions: [registeredContainers(options)] })
      .document()
      .write(preprocess()(source, undefined, true))
  );
  return events.flatMap(([kind, token]) =>
    kind === "enter" && token.type === "registeredLiteral"
      ? [{ start: token.start.offset, end: token.end.offset }]
      : []
  );
}

function lineEnding(code: number | null) {
  return code === -5 || code === -4 || code === -3;
}
function space(code: number | null) {
  return (
    code === 32 || code === -2 || code === -1 || code === 9 || lineEnding(code)
  );
}
function character(code: number) {
  return lineEnding(code) ? "\n" : code === -1 ? "" : code === -2 ? "\t" : String.fromCharCode(code);
}
function nameCharacter(code: number | null) {
  return (
    code !== null &&
    ((code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 45 ||
      code === 58 ||
      code === 95)
  );
}
function attributeCharacter(code: number | null) {
  return (
    code !== null &&
    !space(code) &&
    code !== 47 &&
    code !== 62 &&
    code !== 61 &&
    code !== 60 &&
    code !== 34 &&
    code !== 39
  );
}

function foldContainers(input: Root) {
  const tree = input as unknown as ContainerNode & {
    children: ContainerNode[];
  };
  const root: ContainerNode & { children: ContainerNode[] } = {
    ...tree,
    children: [],
  };
  const path: ContainerNode[] = [];
  const frames = [
    {
      node: root,
      excluded: new Set<ContainerNode>(),
      clones: new Map<
        ContainerNode,
        ContainerNode & { children: ContainerNode[] }
      >(),
    },
  ];
  function destination(skipParagraph = false) {
    const frame = frames[frames.length - 1];
    let destination = frame.node;
    for (const [index, ancestor] of path.entries()) {
      const child = path[index + 1];
      // A boundary can cut a list between items. Later items still require
      // their structural parent, but it belongs to the new container segment.
      const ownsNewChild =
        child &&
        !frame.excluded.has(child) &&
        ((ancestor.type === "list" && child.type === "listItem") ||
          (ancestor.type === "table" && child.type === "tableRow") ||
          (ancestor.type === "tableRow" && child.type === "tableCell"));
      if (
        (frame.excluded.has(ancestor) && !ownsNewChild) ||
        (skipParagraph && ancestor.type === "paragraph")
      ) {
        continue;
      }
      let clone = frame.clones.get(ancestor);
      if (!clone) {
        clone = { ...ancestor, children: [] };
        destination.children.push(clone);
        frame.clones.set(ancestor, clone);
      }
      destination = clone;
    }
    return destination;
  }
  function visit(node: ContainerNode) {
    if (node.type === "registeredContainer" && node.closed === false) return;
    if (node.type === "registeredTag") {
      if (node.closing) {
        let index = frames.length - 1;
        while (index > 0 && frames[index].node.name !== node.name) index--;
        if (index > 0) {
          for (const frame of frames.slice(index)) {
            if (frame.node.position && node.position) frame.node.position.end = node.position.end;
          }
          frames.length = index;
          const frame = frames[frames.length - 1];
          for (const ancestor of path) frame.excluded.add(ancestor);
        }
        return;
      }
      const container: ContainerNode & { children: ContainerNode[] } = {
        type: "registeredContainer",
        name: node.name,
        data: { hName: node.name, hProperties: node.properties },
        children: [],
        position: node.position,
      };
      destination(true).children.push(container);
      if (!node.selfClosing) {
        frames.push({
          node: container,
          excluded: new Set(path),
          clones: new Map(),
        });
      }
      return;
    }
    // Empty structural nodes (for example an unfinished list item) are leaves
    // worth preserving, not ancestor paths that can emit no descendants.
    if (node.children?.length && node.type !== "registeredContainer") {
      path.push(node);
      for (const child of node.children) visit(child);
      path.pop();
    } else {
      destination().children.push(node);
    }
  }
  for (const child of tree.children) visit(child);
  for (const frame of frames.slice(1)) {
    if (frame.node.position && tree.position) frame.node.position.end = tree.position.end;
  }
  tree.children = root.children;
}
