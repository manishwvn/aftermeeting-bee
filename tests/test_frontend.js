const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

function loadFrontendForTest() {
  let downloadedText = "";
  const anchors = [];
  const nodes = new Map();
  const makeElement = (tagName = "div") => ({
    tagName,
    dataset: {},
    children: [],
    addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    focus() {},
    scrollIntoView() {},
    click() { this.clicked = true; },
  });

  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, makeElement());
      return nodes.get(selector);
    },
    createElement(tagName) {
      const element = makeElement(tagName);
      if (tagName === "a") anchors.push(element);
      return element;
    },
  };
  class TestBlob {
    constructor(parts, options) {
      this.parts = parts;
      this.type = options.type;
    }
  }
  const context = {
    document,
    window: { setTimeout() {}, matchMedia: () => ({ matches: false }) },
    fetch: async () => ({ ok: true, json: async () => ({ bee_cli_available: false }) }),
    Blob: TestBlob,
    URL: {
      createObjectURL(blob) {
        downloadedText = blob.parts.join("");
        return "blob:fixture";
      },
      revokeObjectURL() {},
    },
  };
  const source = readFileSync(new URL("../app.js", `file://${__dirname}/`), "utf8");
  const hooks = `
    globalThis.__testHooks = {
      createCandidateCard,
      candidateEvidenceLabel,
      setData(conversation, choices) {
        selectedConversation = conversation;
        candidateChoices = new Map(choices);
      },
      downloadBrief,
    };
  `;
  runInNewContext(`${source}\n${hooks}`, context);
  return { context, anchors, getDownloadedText: () => downloadedText };
}

test("missing utterance IDs use the original transcript line in review and export", () => {
  const { context, anchors, getDownloadedText } = loadFrontendForTest();
  const candidate = {
    key: "candidate-5",
    utterance_id: null,
    transcript_line: 5,
    action: "Send the notes",
    quote: "I will send the notes.",
    speaker: "SPEAKER_1",
    spoken_at: null,
  };
  context.__testHooks.setData(
    { id: 12, start_time: 1_771_000_000_000, source_response_sha256: "a".repeat(64), candidates: [candidate] },
    [[candidate.key, { accepted: true, action: candidate.action }]],
  );
  const card = context.__testHooks.createCandidateCard(candidate, 0);
  context.__testHooks.downloadBrief();
  assert.equal(context.__testHooks.candidateEvidenceLabel(candidate, 0), "Transcript line 5");
  assert.match(card.children[3].textContent, /Transcript line 5/);
  assert.ok(getDownloadedText().includes("Evidence (Transcript line 5;"));
  assert.equal(anchors[0].clicked, true);
});

test("download keeps malicious Bee text literal and preserves multiline source quotes", () => {
  const { context, getDownloadedText } = loadFrontendForTest();
  const quote = [
    "I will send the plan.",
    "# forged quote heading",
    '<img src="https://attacker.test/pixel" onerror="alert(1)">',
    "- forged list item",
    "",
    "`<script>alert(1)</script>`",
    "https://attacker.test/track",
  ].join("\n");
  const action = [
    "Send the plan",
    "# forged action heading",
    "![remote](https://attacker.test/pixel)",
    "<script>alert(1)</script>",
  ].join("\n");
  const speaker = 'SPEAKER_1\n<img src=x onerror="alert(1)">';
  const candidate = {
    key: "candidate-1",
    utterance_id: 3,
    transcript_line: 1,
    action,
    quote,
    speaker,
    spoken_at: null,
  };
  context.__testHooks.setData(
    { id: 12, start_time: 1_771_000_000_000, source_response_sha256: "b".repeat(64), candidates: [candidate] },
    [[candidate.key, { accepted: true, action }]],
  );
  context.__testHooks.downloadBrief();
  const markdown = getDownloadedText();
  assert.ok(markdown.includes("- Send the plan\n  \\# forged action heading"));
  assert.ok(markdown.includes("    > \\# forged quote heading\n    > &lt;img"));
  assert.ok(markdown.includes("&lt;script&gt;alert\\(1\\)&lt;\\/script&gt;"));
  assert.ok(markdown.includes("\\!\\[remote\\]\\(https\\:\\/\\/attacker\\.test"));
  assert.doesNotMatch(markdown, /<\/?(?:img|script)\b/i);
  assert.doesNotMatch(markdown, /https:\/\/attacker\.test/);
  assert.equal(candidate.quote, quote);
});
