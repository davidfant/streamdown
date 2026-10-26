import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Streamdown } from "../index";

const allowedTags = {
  tabs: [],
  tab: ["label"],
  "message-input": [],
  mention: [],
};
const literalTagContent = ["message-input", "mention"];
function render(source: string, mode: "streaming" | "static" = "streaming") {
  const bodies: unknown[] = [];
  const html = renderToStaticMarkup(
    <Streamdown
      allowedTags={allowedTags}
      literalTagContent={literalTagContent}
      linkSafety={{ enabled: false }}
      mode={mode}
      components={{
        "message-input": ({ children }) => {
          bodies.push(children);
          return createElement("span", null, children as string);
        },
        mention: ({ children }) => {
          bodies.push(children);
          return createElement("span", null, children as string);
        },
      }}
    >
      {source}
    </Streamdown>
  );
  return { html, bodies };
}

describe("parser-owned literal source during streaming repair", () => {
  for (const mode of ["static", "streaming"] as const) {
    it.each([
      "20~25",
      "- > 25",
      "[unfinished](https://example.com",
      "unmatched **markers",
      "    four spaces\n\n\tTabbed",
      "a\r\nb",
      "&amp;",
      "$$math",
      "`unclosed",
      "```html\n</message-input>\n```\nactual body",
      "-",
      "trailing space ",
    ])(`preserves exact literal %j in ${mode} mode`, (literal) => {
      expect(
        render(`<message-input>${literal}</message-input>`, mode).bodies
      ).toEqual([literal]);
    });
  }
  it.each([
    "**Before <message-input>draft</message-input> after**",
    "*Before <mention>draft</mention> after*",
    "[Before <mention>draft</mention> after](https://example.com)",
    "**Before <message-input>draft</message-input> between <message-input>another</message-input> after**",
    "Before <message-input>draft</message-input> after",
  ])("retains whole-source formatting and whitespace across %s", (content) => {
    const source = `<tabs><tab label="Example">${content}</tab></tabs>`;
    expect(render(source).html).toBe(render(source, "static").html);
  });
  it("repairs outside formatting without counting literal delimiters", () => {
    const result = render("**Before <mention>**not parsed</mention> after");
    expect(result.bodies).toEqual(["**not parsed"]);
    expect(result.html).toContain('data-streamdown="strong"');
    expect(result.html).not.toContain("after**");
  });
  it("leaves ordinary indented code to CommonMark", () => {
    const result = render(
      "Example:\n\n    <message-input>not a widget\n\nVisible tail"
    );
    expect(result.bodies).toEqual([]);
    expect(result.html).toContain("Visible tail");
    expect(result.html).toContain("<code");
  });
  it("accepts every streaming prefix without exposing an unfinished literal", () => {
    const source =
      '<tabs><tab label="One">**Before <message-input>20~25\n[unfinished](url</message-input> after**</tab></tabs>';
    const closeEnd =
      source.indexOf("</message-input>") + "</message-input>".length;
    for (let i = 0; i <= source.length; i++) {
      let result: ReturnType<typeof render> | undefined;
      expect(() => {
        result = render(source.slice(0, i));
      }).not.toThrow();
      if (i < closeEnd) expect(result?.bodies).toEqual([]);
    }
  });
});
