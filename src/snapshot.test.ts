/**
 * Tests for the snapshot YAML builder: shape (roles, quoted names, brackets),
 * the s1,s2,… ref sequence in DOM order, refMap correctness, no refs for
 * non-interactive elements, and per-snapshot ref isolation.
 *
 * Imports the extension's snapshot.js directly — it is the single source of
 * truth for the format, shared with background.js.
 */

import { describe, it, expect } from "vitest";
import { buildSnapshot, type SnapshotNode } from "../extension/snapshot.js";

/** The spec's example page, as a distilled DOM tree. */
function exampleTree(): SnapshotNode {
  return {
    nodeId: 1,
    nodeName: "#document",
    nodeType: 9,
    attrs: { name: "Example Domain" },
    children: [
      {
        nodeId: 2,
        nodeName: "DIV",
        nodeType: 1,
        attrs: {},
        children: [
          {
            nodeId: 3,
            nodeName: "H1",
            nodeType: 1,
            attrs: {},
            children: [
              { nodeId: 4, nodeName: "#text", nodeType: 3, attrs: { text: "Example Domain" }, children: [] },
            ],
          },
          {
            nodeId: 5,
            nodeName: "A",
            nodeType: 1,
            attrs: { href: "https://example.org" },
            children: [
              { nodeId: 6, nodeName: "#text", nodeType: 3, attrs: { text: "More information..." }, children: [] },
            ],
          },
          {
            nodeId: 7,
            nodeName: "INPUT",
            nodeType: 1,
            attrs: { type: "search", placeholder: "Search" },
            children: [],
          },
          {
            nodeId: 8,
            nodeName: "BUTTON",
            nodeType: 1,
            attrs: {},
            children: [
              { nodeId: 9, nodeName: "#text", nodeType: 3, attrs: { text: "Go" }, children: [] },
            ],
          },
        ],
      },
    ],
  };
}

describe("buildSnapshot", () => {
  it("renders the a11y-tree YAML: lowercase roles, quoted names, bracket attrs, 2-space depth", () => {
    const { yaml } = buildSnapshot(exampleTree());
    expect(yaml).toBe(
      [
        '- document "Example Domain":',
        '  - heading "Example Domain" [level=1]',
        '  - link "More information..." [ref=s1]',
        '  - textbox "Search" [ref=s2]',
        '  - button "Go" [ref=s3]',
      ].join("\n")
    );
  });

  it("assigns refs s1,s2,… in DOM order and maps every ref to its nodeId", () => {
    const { refMap } = buildSnapshot(exampleTree());
    expect(refMap).toEqual({ s1: 5, s2: 7, s3: 8 });
  });

  it("gives non-interactive elements no ref", () => {
    const { yaml, refMap } = buildSnapshot(exampleTree());
    expect(yaml).not.toMatch(/heading[^\n]*ref=/);
    expect(yaml).not.toMatch(/document[^\n]*ref=/);
    expect(Object.keys(refMap)).toEqual(["s1", "s2", "s3"]);
  });

  it("treats unlabeled generic containers as transparent (children move up)", () => {
    const { yaml } = buildSnapshot(exampleTree());
    expect(yaml).not.toMatch(/text ""/); // the wrapping DIV emits no line
    expect(yaml.split("\n")[1].startsWith("  - heading")).toBe(true); // depth 1, not 2
  });

  it("starts a fresh counter per snapshot (refs are not comparable across snapshots)", () => {
    const first = buildSnapshot(exampleTree());
    expect(first.refMap.s1).toBe(5); // the link

    // Remove the link: the textbox is now the first interactive element.
    const tree = exampleTree();
    tree.children![0].children!.splice(1, 1);
    const second = buildSnapshot(tree);
    expect(second.yaml).toContain('- textbox "Search" [ref=s1]');
    expect(second.refMap.s1).toBe(7); // same ref id, different node — per-snapshot scope
    expect(first.refMap.s1).toBe(5); // first snapshot untouched
  });

  it("honours aria-label over text content, and explicit role attributes", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        {
          nodeId: 2,
          nodeName: "DIV",
          nodeType: 1,
          attrs: { role: "tab", "aria-label": "Details" },
          children: [],
        },
      ],
    };
    const { yaml, refMap } = buildSnapshot(tree);
    expect(yaml).toContain('- tab "Details" [ref=s1]');
    expect(refMap).toEqual({ s1: 2 });
  });

  it("gives tabindex-carrying generic elements a ref", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        {
          nodeId: 4,
          nodeName: "SPAN",
          nodeType: 1,
          attrs: { tabindex: "0", "aria-label": "Open menu" },
          children: [],
        },
      ],
    };
    const { yaml, refMap } = buildSnapshot(tree);
    expect(yaml).toContain('- text "Open menu" [ref=s1]');
    expect(refMap).toEqual({ s1: 4 });
  });

  it("maps input types to checkbox/radio/slider and escapes quotes in names", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "Form" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "checkbox", "aria-label": 'Accept "terms"' }, children: [] },
        { nodeId: 3, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "choice" }, children: [] },
        { nodeId: 4, nodeName: "INPUT", nodeType: 1, attrs: { type: "range", "aria-label": "Volume" }, children: [] },
        { nodeId: 5, nodeName: "SELECT", nodeType: 1, attrs: { "aria-label": "Size" }, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    // checkbox/radio now always carry their live checked= state part;
    // radios additionally show their group name so same-named siblings differ
    expect(yaml).toContain('- checkbox "Accept \\"terms\\"" [ref=s1 checked=false]');
    expect(yaml).toContain('- radio "choice" [ref=s2 checked=false group=choice]');
    expect(yaml).toContain('- slider "Volume" [ref=s3]');
    expect(yaml).toContain('- combobox "Size" [ref=s4]');
  });

  it("renders a labeled generic as a text line, unlabeled empty generics are dropped", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        { nodeId: 2, nodeName: "P", nodeType: 1, attrs: {}, children: [
          { nodeId: 3, nodeName: "#text", nodeType: 3, attrs: { text: "Just a paragraph" }, children: [] },
        ] },
        { nodeId: 4, nodeName: "SPAN", nodeType: 1, attrs: {}, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toBe(['- document "T":', '  - text "Just a paragraph"'].join("\n"));
  });
});

describe("buildSnapshot live state rendering", () => {
  /** A form page distilled with the live checked/selected/value attrs. */
  function formTree(): SnapshotNode {
    return {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "Form" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "checkbox", "aria-label": "Subscribe", checked: "true" }, children: [] },
        { nodeId: 3, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "size", checked: "false" }, children: [] },
        { nodeId: 4, nodeName: "SELECT", nodeType: 1, attrs: { "aria-label": "Size" }, children: [
          { nodeId: 5, nodeName: "OPTION", nodeType: 1, attrs: { value: "1", selected: "false" }, children: [
            { nodeId: 7, nodeName: "#text", nodeType: 3, attrs: { text: "Option 1" }, children: [] },
          ] },
          { nodeId: 6, nodeName: "OPTION", nodeType: 1, attrs: { value: "2", selected: "true" }, children: [
            { nodeId: 8, nodeName: "#text", nodeType: 3, attrs: { text: "Option 2" }, children: [] },
          ] },
        ] },
      ],
    };
  }

  it("always renders checked= for checkbox/radio, selected= (+ value=) for options", () => {
    const { yaml } = buildSnapshot(formTree());
    expect(yaml).toContain('- checkbox "Subscribe" [ref=s1 checked=true]');
    expect(yaml).toContain('- radio "size" [ref=s2 checked=false group=size]');
    expect(yaml).toContain('- combobox "Size" [ref=s3]');
    expect(yaml).toContain('- option "Option 1" [ref=s4 value=1 selected=false]');
    expect(yaml).toContain('- option "Option 2" [ref=s5 value=2 selected=true]');
  });

  it("renders every radio of a group with checked= and group=, each with its own ref", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "Pick a color" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "color", checked: "false" }, children: [] },
        { nodeId: 3, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "color", checked: "true" }, children: [] },
        { nodeId: 4, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", name: "color", checked: "false" }, children: [] },
        { nodeId: 5, nodeName: "INPUT", nodeType: 1, attrs: { type: "radio", "aria-label": "Standalone" }, children: [] },
      ],
    };
    const { yaml, refMap } = buildSnapshot(tree);
    expect(yaml.split("\n")).toEqual([
      '- document "Pick a color":',
      '  - radio "color" [ref=s1 checked=false group=color]',
      '  - radio "color" [ref=s2 checked=true group=color]',
      '  - radio "color" [ref=s3 checked=false group=color]',
      '  - radio "Standalone" [ref=s4 checked=false]', // no name attr → no group part
    ]);
    expect(Object.keys(refMap)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("renders value= for textboxes carrying a live value, omits it when empty", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "Inputs" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "text", value: "42" }, children: [] },
        { nodeId: 3, nodeName: "INPUT", nodeType: 1, attrs: { type: "text", placeholder: "empty field" }, children: [] },
        { nodeId: 4, nodeName: "TEXTAREA", nodeType: 1, attrs: { value: "a note" }, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toContain('- textbox "42" [ref=s1 value=42]');
    expect(yaml).toContain('- textbox "empty field" [ref=s2]'); // no value= part when empty
    expect(yaml).toContain('- textbox "a note" [ref=s3 value=a note]');
  });

  it("renders checked=false when no state is known yet", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        { nodeId: 2, nodeName: "INPUT", nodeType: 1, attrs: { type: "checkbox", "aria-label": "Newsletter" }, children: [] },
        { nodeId: 3, nodeName: "SELECT", nodeType: 1, attrs: { "aria-label": "Pick" }, children: [
          { nodeId: 4, nodeName: "OPTION", nodeType: 1, attrs: {}, children: [
            { nodeId: 5, nodeName: "#text", nodeType: 3, attrs: { text: "Only" }, children: [] },
          ] },
        ] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toContain('- checkbox "Newsletter" [ref=s1 checked=false]');
    expect(yaml).toContain('- option "Only" [ref=s3 selected=false]'); // no value attr → no value= part
  });

  it("honours aria-checked for switch-style widgets when the property is absent", () => {
    const tree: SnapshotNode = {
      nodeId: 1,
      nodeName: "#document",
      nodeType: 9,
      attrs: { name: "T" },
      children: [
        { nodeId: 2, nodeName: "DIV", nodeType: 1, attrs: { role: "switch", "aria-label": "Dark mode", "aria-checked": "true" }, children: [] },
        { nodeId: 3, nodeName: "DIV", nodeType: 1, attrs: { role: "switch", "aria-label": "Beta" }, children: [] },
      ],
    };
    const { yaml } = buildSnapshot(tree);
    expect(yaml).toContain('- switch "Dark mode" [ref=s1 checked=true]');
    expect(yaml).toContain('- switch "Beta" [ref=s2 checked=false]');
  });
});
