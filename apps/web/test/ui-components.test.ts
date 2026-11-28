import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button,
  Card,
  Checkbox,
  Chip,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  ProgressBar,
  ResponsiveTable,
  SegmentedControl,
  Select,
  Sheet,
  Skeleton,
  StatTile,
  Tabs,
  Textarea,
  Toast,
  Toggle,
} from "../components/ui";

const css = readFileSync(join(import.meta.dirname, "..", "app", "ui.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Concatenated declarations of every rule whose selector list contains `selector`. */
function block(selector: string): string {
  const out: string[] = [];
  for (const m of css.matchAll(/([^{}]+){([^{}]*)}/g)) {
    const selectors = (m[1] ?? "").split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2] ?? "");
  }
  return out.join("\n");
}

const CONTROLS = [
  ".mw-button",
  ".mw-icon-button",
  ".mw-input",
  ".mw-select",
  ".mw-textarea",
  ".mw-toggle",
  ".mw-check",
  ".mw-segmented-item",
  ".mw-tab",
  ".mw-chip-button",
];

describe("every control is at least 44 px", () => {
  for (const selector of CONTROLS) {
    it(`${selector} sets min-height from the touch token`, () => {
      expect(block(selector)).toContain("min-height: var(--mw-touch-min)");
    });
  }
  it("square controls also set the min width", () => {
    for (const s of [".mw-icon-button", ".mw-toggle"]) {
      expect(block(s)).toContain("min-width: var(--mw-touch-min)");
    }
  });
  it("uses no fixed height below the touch size on controls", () => {
    for (const s of CONTROLS) {
      for (const m of block(s).matchAll(/(?:^|\s)(?:height|min-height):\s*(\d+)px/g)) {
        expect(Number(m[1])).toBeGreaterThanOrEqual(44);
      }
    }
  });
});

describe("focus ring", () => {
  it("is visible and uses the focus token", () => {
    const focus = block(":focus-visible");
    expect(focus).toContain("outline:");
    expect(focus).toContain("var(--mw-color-focus)");
    expect(focus).not.toMatch(/outline:\s*(none|0)/);
  });
  it("is never removed without a replacement", () => {
    expect(css).not.toMatch(/outline:\s*(none|0)\s*;/);
  });
  it("motion is dropped under reduced motion", () => {
    expect(css).toContain("prefers-reduced-motion: reduce");
  });
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

describe("components render accessible markup", () => {
  it("Button", () => {
    const out = html(h(Button, { variant: "primary" }, "Save"));
    expect(out).toContain('class="mw-button mw-button-primary"');
    expect(out).toContain('type="button"');
    expect(html(h(Button, { loading: true }, "x"))).toContain('aria-busy="true"');
  });
  it("IconButton requires a label", () => {
    expect(html(h(IconButton, { label: "Close", children: "x" }))).toContain('aria-label="Close"');
  });
  it("Input, Textarea and Select link label and error", () => {
    const input = html(h(Input, { id: "a", label: "Name", error: "Required" }));
    expect(input).toContain('for="a"');
    expect(input).toContain('aria-invalid="true"');
    expect(input).toContain('aria-describedby="a-error"');
    expect(input).toContain('id="a-error"');
    expect(html(h(Textarea, { id: "b", label: "Note" }))).toContain("mw-textarea");
    const select = html(
      h(Select, { id: "c", label: "Pick", options: [{ value: "1", label: "One" }] }),
    );
    expect(select).toContain('<option value="1">One</option>');
  });
  it("Toggle is a switch and Checkbox a checkbox", () => {
    expect(html(h(Toggle, { label: "On", checked: true, onChange: noop }))).toContain(
      'role="switch"',
    );
    expect(html(h(Checkbox, { label: "Ok" }))).toContain('type="checkbox"');
  });
  it("SegmentedControl marks the active item with aria-pressed", () => {
    const out = html(
      h(SegmentedControl, {
        label: "Language",
        value: "vi",
        onChange: noop,
        options: [
          { value: "vi", label: "VI" },
          { value: "en", label: "EN" },
        ],
      }),
    );
    expect(out).toContain('role="group"');
    expect(out).toContain('aria-label="Language"');
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain('aria-pressed="false"');
  });
  it("Card, StatTile, Chip, ProgressBar, Skeleton", () => {
    expect(html(h(Card, null, "x"))).toContain("mw-card");
    const tile = html(h(StatTile, { label: "Left", value: "1.000.000" }));
    expect(tile).toContain("mw-stat-value");
    expect(html(h(Chip, { tone: "success", children: "ok" }))).toContain("mw-chip-success");
    expect(html(h(Chip, { onClick: noop, children: "ok" }))).toContain("mw-chip-button");
    const bar = html(h(ProgressBar, { value: 40, label: "Budget" }));
    expect(bar).toContain('role="progressbar"');
    expect(bar).toContain('aria-valuenow="40"');
    expect(html(h(ProgressBar, { value: 400, label: "x" }))).toContain('aria-valuenow="100"');
    expect(html(h(Skeleton, { label: "Loading" }))).toContain('aria-busy="true"');
  });
  it("Tabs expose tablist, tab and tabpanel", () => {
    const out = html(
      h(Tabs, {
        label: "Views",
        value: "a",
        onChange: noop,
        tabs: [
          { id: "a", label: "A", content: "panel a" },
          { id: "b", label: "B", content: "panel b" },
        ],
      }),
    );
    expect(out).toContain('role="tablist"');
    expect(out).toContain('aria-selected="true"');
    expect(out).toContain('role="tabpanel"');
    expect(out).toContain("panel a");
    expect(out).not.toContain("panel b");
  });
  it("ResponsiveTable renders a labelled table", () => {
    const out = html(
      h(ResponsiveTable<{ n: string }>, {
        caption: "Items",
        columns: [{ key: "n", header: "Name", render: (r) => r.n }],
        rows: [{ n: "x" }],
        rowKey: (r) => r.n,
      }),
    );
    expect(out).toContain("<caption");
    expect(out).toContain('data-label="Name"');
  });
  it("Dialog and Sheet use a native dialog with an accessible name", () => {
    const d = html(
      h(Dialog, { open: false, title: "Hi", closeLabel: "Close", onClose: noop, children: "x" }),
    );
    expect(d).toContain("<dialog");
    expect(d).toContain("aria-labelledby");
    expect(d).toContain('aria-label="Close"');
    const s = html(
      h(Sheet, { open: false, title: "More", closeLabel: "Close", onClose: noop, children: "x" }),
    );
    expect(s).toContain("mw-sheet");
  });
  it("Toast is a status region with a dismiss control", () => {
    const out = html(
      h(Toast, { tone: "danger", dismissLabel: "Dismiss", onDismiss: noop, children: "Oops" }),
    );
    expect(out).toContain('role="alert"');
    expect(out).toContain('aria-label="Dismiss"');
    expect(html(h(Toast, { tone: "info", children: "x" }))).toContain('role="status"');
  });
  it("EmptyState and ErrorState take their text and action from props", () => {
    const empty = html(h(EmptyState, { title: "Nothing", description: "Add one" }));
    expect(empty).toContain("Nothing");
    const err = html(h(ErrorState, { title: "Failed", retryLabel: "Retry", onRetry: noop }));
    expect(err).toContain('role="alert"');
    expect(err).toContain("Retry");
  });
});
