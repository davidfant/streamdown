import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Streamdown } from "../index";

function render(source: string, mode: "static" | "streaming", normalize = false) {
  const bodies: unknown[] = [];
  const html = renderToStaticMarkup(
    <Streamdown
      allowedTags={{ ref: [], "message-input": [] }}
      literalTagContent={["message-input"]}
      normalizeHtmlIndentation={normalize}
      mode={mode}
      components={{
        ref: ({ children }) => createElement("span", { "data-ref": true }, children),
        "message-input": ({ children }) => {
          bodies.push(children);
          return createElement("span", { "data-literal": true }, children);
        },
      }}
    >
      {source}
    </Streamdown>
  );
  return {
    document: new DOMParser().parseFromString(html, "text/html"),
    bodies,
  };
}

for (const mode of ["static", "streaming"] as const) {
  describe(`registered review regressions (${mode})`, () => {
    it.each([
      ["- before <ref>inside</ref> after", "li"],
      ["> before <ref>inside</ref> after", "blockquote"],
      ["**before <ref>inside</ref> after**", '[data-streamdown="strong"]'],
    ])("preserves surrounding Markdown for %s", (source, selector) => {
      const { document } = render(source, mode);
      const ancestor = document.querySelector(selector);
      expect(ancestor?.textContent?.trim()).toBe("before inside after");
      expect(ancestor?.querySelector("[data-ref]")).not.toBeNull();
    });

    it.each([
      ["> <message-input>first\n> second</message-input>", "first\nsecond"],
      ["- <message-input>first\n  second</message-input>", "first\nsecond"],
      ["> <message-input>first\n> second</message-input   >", "first\nsecond"],
      ["> <message-input\n> >first\n> second</message-input>", "first\nsecond"],
      ["> <message-input>20~25\n> [unfinished](raw</message-input>", "20~25\n[unfinished](raw"],
      ["> <message-input>first\n> ```html\n> </message-input>\n> ```\n> second</message-input>", "first\n```html\n</message-input>\n```\nsecond"],
    ])("slices literal markers in serialized-token coordinates for %s", (source, value) => {
      expect(render(source, mode).bodies).toEqual([value]);
    });

    it("accepts every streaming prefix through multiline markers and containers", () => {
      const source = "> <message-input\n> >first\n> 20~25[unfinished](raw</message-input>\n> **After**";
      for (let end = 0; end <= source.length; end++) {
        expect(() => render(source.slice(0, end), mode, true)).not.toThrow();
      }
    });

    it("honors explicit indentation normalization for unrelated HTML", () => {
      const { document } = render(
        '<div>\n    <div><h4>Title One</h4></div>\n\n    <div><h4>Title Two</h4></div>\n</div>',
        mode,
        true
      );
      expect(Array.from(document.querySelectorAll("h4"), (node) => node.textContent))
        .toEqual(["Title One", "Title Two"]);
      expect(document.querySelector("code")).toBeNull();
    });

    it("does not normalize indented registered-tag examples or ordinary code", () => {
      const source = '    <ref>example</ref>\n\n    ordinary code';
      const { document } = render(source, mode, true);
      const baseline = render(source, mode, false).document;
      expect(document.querySelector("[data-ref]")).toBeNull();
      expect(document.querySelector("code")?.textContent).toBe(
        baseline.querySelector("code")?.textContent
      );
    });

    it("does not rewrite indented HTML-looking literal data", () => {
      const value = "\n    <div>raw</div>\n\n    <div>more</div>\n";
      expect(render(`<message-input>${value}</message-input>`, mode, true).bodies)
        .toEqual([value]);
    });
  });
}
