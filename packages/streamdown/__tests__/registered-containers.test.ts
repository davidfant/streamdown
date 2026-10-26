import { test, expect } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import { toHtml } from "hast-util-to-html";
import { remarkRegisteredContainers } from "../lib/remark/registered-containers";
const parser = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRegisteredContainers, {
    names: [
      "tabs",
      "tab",
      "conversation",
      "message",
      "message-input",
      "suggested-tasks",
      "select",
      "option",
      "file",
    ],
    literal: ["message-input", "suggested-tasks"],
  })
  .use(remarkRehype, { allowDangerousHtml: true });
function html(source: string) {
  return toHtml(parser.runSync(parser.parse(source)) as any, {
    allowDangerousHtml: true,
  });
}
test("nested compact and multiline containers", () => {
  const h = html(
    '<tabs><tab label="Outer">\n**Before**\n<tabs><tab label="Inner">\n### Inner\n</tab></tabs>\n**After**\n</tab><tab label="Last">Last panel</tab></tabs>'
  );
  expect(h.match(/<tab /g)).toHaveLength(3);
  expect(h).toContain("<h3>Inner</h3>");
  expect(h).toContain("<strong>After</strong>");
});
test("compact headings and continuous ordinary paragraphs", () => {
  const h = html(
    '<tabs><tab label="One">### Heading\n\nHello\nworld\n</tab></tabs>'
  );
  expect(h).toContain("<h3>Heading</h3>");
  expect(h).toContain("<p>Hello\nworld</p>");
});
test("close after list text gives sibling containers", () => {
  const h = html(
    '<tabs>\n<tab label="One">\n- One\n- Two</tab><tab label="Two">Second</tab>\n</tabs>'
  );
  expect(h).toContain('</li>\n</ul></tab><tab label="Two">');
});
test("Markdown owns fenced and inline code including apparent tags", () => {
  const h = html(
    '<tabs><tab label="Code">\n```text\n</tab></tabs>\n\n<tabs><tab>not real</tab></tabs>\n```\n\n`<tab>also not real</tab>`\n\n**After**\n</tab></tabs>'
  );
  expect(h).toContain("&#x3C;/tab>&#x3C;/tabs>\n\n");
  expect(h).not.toContain("!----");
  expect(h.match(/<tab /g)).toHaveLength(1);
  expect(h).toContain("<strong>After</strong>");
});
test("literal bodies retain Markdown and nested-looking tags exactly", () => {
  const value =
    'Use **literal** [link](https://example.com).\n\n<tab label="raw">raw</tab>';
  const h = html(
    `<tabs><tab label="Draft"><message-input>${value}</message-input></tab></tabs>`
  );
  expect(h).toContain(
    'Use **literal** [link](https://example.com).\n\n&#x3C;tab label="raw">raw&#x3C;/tab>'
  );
});
test("partial streams never throw", () => {
  const s =
    '<tabs><tab label="One">\n- First\n- Second</tab><tab label="Two"><message-input>**literal**\n\nMore</message-input></tab></tabs>';
  for (let i = 0; i <= s.length; i++)
    expect(() => html(s.slice(0, i))).not.toThrow();
});
test("attributes use literal HTML syntax and decode entities without evaluating expressions", () => {
  expect(html('<tab label="a &amp; b" selected>hello</tab>')).toContain(
    '<tab label="a &#x26; b" selected>'
  );
});
test("autolinks and code outside widgets retain CommonMark semantics", () => {
  const h = html("<https://example.com>\n\n`<tab>**literal**</tab>`");
  expect(h).toContain('<a href="https://example.com">');
  expect(h).toContain("<code>&#x3C;tab>**literal**&#x3C;/tab></code>");
});
test("a boundary inside a list divides its structural parent between panels", () => {
  const h = html(
    '<tabs>\n<tab label="First">\n- One\n- Two</tab><tab label="Second">Second panel\n- Three\n- Four</tab>\n</tabs>'
  );
  expect(h.match(/<ul>/g)).toHaveLength(2);
  expect(h.match(/<li>/g)).toHaveLength(4);
  expect(h).toContain('<tab label="Second">Second panel<ul>');
});
test("multiline literal starts and ends on separate lines without empty event slices", () => {
  expect(html('<message-input>\n{"value":"broad"}\n</message-input>')).toBe(
    '<message-input>\n{"value":"broad"}\n</message-input>'
  );
});
test("incomplete literal containers do not expose their data", () => {
  expect(html("Intro\n\n<message-input>private")).toBe("<p>Intro</p>");
});
test("code-looking terminators inside literal data are not real closures", () => {
  expect(
    html(
      "Intro\n\n<message-input>real\n\n```html\n</message-input>\n```\n\nVisible"
    )
  ).toBe("<p>Intro</p>");
  expect(
    html("<message-input>example `</message-input>`\n\nDone</message-input>")
  ).toContain("example `&#x3C;/message-input>`\n\nDone");
});

// Preserve upstream's newer fence regressions without the removed preprocessor.
test.each([
  ["<tab>\n```js\nconst a = 1;\n\nconst b = 2;\n```\n</tab>", "const a = 1;\n\nconst b = 2;\n"],
  ["<tab>\nA\n\n~~~\nx\n\ny\n~~~\n\nB\n</tab>", "x\n\ny\n"],
  ["<tab>\nhello\n\n```py\na = 1\n\nb = 2", "a = 1\n\nb = 2\n"],
  ["<tab>\n```md\n```js\n\nx\n```\n</tab>", "```js\n\nx\n"],
])("preserves fenced blank lines for %s", (source, contents) => {
  const rendered = html(source);
  expect(rendered).toContain(contents);
  expect(rendered).not.toContain("!----");
});
