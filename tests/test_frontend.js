const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const test = require("node:test");

function loadFrontendForTest(fetchImpl = async () => ({ ok: true, json: async () => ({ bee_cli_available: false }) })) {
  let downloadedText = "";
  const anchors = [];
  const nodes = new Map();
  const makeElement = (tagName = "div") => ({
    tagName,
    dataset: {},
    children: [],
    listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
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
    fetch: fetchImpl,
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
      renderConversation,
      formatDate,
      formatClock,
      resolveTimeZone,
      timeZoneNotice,
      deviceTypeNotice,
      setData(conversation, choices) {
        selectedConversation = conversation;
        candidateChoices = new Map(choices);
      },
      loadConversation,
      loadConversations,
      updateCandidateChoice,
      getReviewState() {
        return JSON.stringify({
          conversationId: selectedConversation?.id ?? null,
          choices: [...candidateChoices.entries()],
          message: messageNode.textContent,
          libraryHidden: librarySection.hidden,
          reviewHidden: reviewSection.hidden,
        });
      },
      downloadBrief,
    };
  `;
  runInNewContext(`${source}\n${hooks}`, context);
  return { context, anchors, nodes, getDownloadedText: () => downloadedText };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(data) {
  return { ok: true, json: async () => ({ data }) };
}

const SYNTHETIC_SERVER_SCRIPT = String.raw`
import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path.cwd()))
import app

fixture = json.loads(Path("tests/fixtures/bee-conversation-fixture-only.json").read_text(encoding="utf-8"))
conversation = fixture["conversation"]
detail_raw = json.dumps(fixture, ensure_ascii=False, separators=(",", ":"))
listing = {
    "conversations": [{key: conversation.get(key) for key in (
        "id", "start_time", "end_time", "created_at", "summary", "state"
    )}],
    "next_cursor": None,
    "timezone": fixture.get("timezone"),
}

def launch_fixture_cli(args, **kwargs):
    command = args[1:]
    if command == ["conversations", "list", "--limit", "10", "--json"]:
        raw = json.dumps(listing, ensure_ascii=False, separators=(",", ":"))
    elif command == ["conversations", "get", str(conversation["id"]), "--json"]:
        raw = detail_raw
    else:
        raise AssertionError("unexpected fixture CLI arguments")
    child_script = f"import sys;sys.stdout.write({raw!r})"
    return subprocess.Popen([sys.executable, "-c", child_script], **kwargs)

client = app.BeeCLI(executable="fixture-only", popen_factory=launch_fixture_cli)
server = app.create_server(client, port=0)
print(json.dumps({
    "port": server.server_port,
    "sourceHash": hashlib.sha256(detail_raw.encode("utf-8")).hexdigest(),
}), flush=True)
server.serve_forever()
`;

async function startSyntheticBeeServer() {
  const child = spawn("python3", ["-u", "-c", SYNTHETIC_SERVER_SCRIPT], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONNOUSERSITE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4_096) stderr += chunk.toString("utf8");
  });

  const startup = await new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => finish(new Error("synthetic Bee server did not become ready")), 5_000);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline !== -1) {
        try {
          finish(null, JSON.parse(output.slice(0, newline)));
        } catch (error) {
          finish(error);
        }
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(`synthetic Bee server exited before ready (${code ?? signal}): ${stderr}`));
    const finish = (error, value) => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        reject(error);
      }
      else resolve(value);
    };
    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });

  return {
    origin: `http://127.0.0.1:${startup.port}`,
    sourceHash: startup.sourceHash,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("synthetic Bee server did not stop after SIGTERM")), 3_000);
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
        child.kill("SIGTERM");
      });
    },
  };
}

function loopbackFetch(origin) {
  const allowedPaths = new Set(["/api/health", "/api/conversations", "/api/conversation"]);
  return (pathName, options = {}) => {
    const url = new URL(pathName, origin);
    assert.equal(url.origin, origin, "the synthetic integration may contact only its own loopback app");
    assert.ok(allowedPaths.has(url.pathname), "the synthetic integration uses only the local app routes");
    const headers = { ...(options.headers || {}) };
    if (options.method === "POST") {
      headers.Origin = origin;
      headers["Sec-Fetch-Site"] = "same-origin";
    }
    if (options.body) headers["Content-Length"] = Buffer.byteLength(options.body);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const request = http.request(url, { method: options.method || "GET", headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", fail);
        response.on("aborted", () => fail(new Error("synthetic Bee response was aborted")));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            json: async () => JSON.parse(text),
          });
        });
      });
      const timeout = setTimeout(() => request.destroy(new Error("synthetic Bee request timed out")), 3_000);
      request.on("error", fail);
      if (options.body) request.write(options.body);
      request.end();
    });
  };
}

function conversation(id, candidateKey = `candidate-${id}`) {
  return {
    id,
    start_time: 1_771_000_000_000 + id,
    state: "completed",
    summary: `Conversation ${id}`,
    source_response_sha256: String(id).repeat(64),
    candidates: [{ key: candidateKey, action: `Original action ${id}`, category: "Task", quote: `Quote ${id}`, speaker: "SPEAKER_1", spoken_at: null }],
    utterances: [{ text: `Quote ${id}`, speaker: "SPEAKER_1", spoken_at: null }],
  };
}

test("invalid and missing Bee timezone or device metadata remain explicit and safe", () => {
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";
  for (const metadata of [
    { timezone: "Invalid/Zone\n# forged heading", device_type: "Fixture\n# <script>alert(1)</script>" },
    { timezone: null, device_type: null },
  ]) {
    const { context, nodes, getDownloadedText } = loadFrontendForTest();
    const detail = {
      ...conversation(31),
      ...metadata,
      candidates: [{
        key: "candidate-31",
        action: "Original action",
        category: "commitment language",
        quote: "I will send the notes.",
        speaker: "SPEAKER_1",
        spoken_at: null,
        utterance_id: null,
        transcript_line: 1,
      }],
    };
    context.__testHooks.renderConversation(detail);
    const meta = nodes.get("#record-meta").children.map((item) => item.textContent).join(" | ");
    assert.ok(meta.includes(`timestamps shown in this computer’s local time zone: ${localTimeZone}`));
    assert.ok(meta.includes(metadata.device_type ? "Bee-reported device type (unverified): Fixture" : "Bee-reported device type: not supplied"));
    assert.doesNotThrow(() => context.__testHooks.formatDate(detail.start_time, detail.timezone));
    assert.equal(
      context.__testHooks.formatDate(detail.start_time, detail.timezone),
      new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: localTimeZone,
      }).format(new Date(detail.start_time)),
    );

    const card = nodes.get("#candidate-list").children[0];
    const actionInput = card.children[1].children[0];
    const acceptedCheckbox = card.children[4].children[0];
    actionInput.value = "Send the notes (reviewed)";
    actionInput.listeners.input();
    acceptedCheckbox.checked = true;
    acceptedCheckbox.listeners.change();
    context.__testHooks.downloadBrief();
    const markdown = getDownloadedText();
    assert.match(markdown, /^Time zone: /m);
    assert.doesNotMatch(markdown, /^# forged heading/m);
    assert.doesNotMatch(markdown, /<script>/);
    assert.ok(markdown.includes("Capture origin is not attested by the Bee CLI."));
  }
});

test("synthetic CLI JSON flows through normalization, loopback HTTP, and frontend review/export", async () => {
  const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "fixtures/bee-conversation-fixture-only.json"), "utf8"));
  const server = await startSyntheticBeeServer();
  try {
    const { context, nodes, getDownloadedText } = loadFrontendForTest(loopbackFetch(server.origin));
    await context.__testHooks.loadConversations();
    const rows = nodes.get("#record-list").children;
    assert.equal(rows.length, 1, nodes.get("#screen-message").textContent);
    await rows[0].listeners.click();

    const conversationMeta = nodes.get("#record-meta").children.map((item) => item.textContent);
    assert.ok(conversationMeta.includes(`Bee-reported time zone: ${fixture.timezone} (timestamps shown in this zone)`));
    assert.ok(conversationMeta.includes(`Bee-reported device type (unverified): ${fixture.conversation.device_type}`));
    assert.ok(conversationMeta.includes(`Recorded: ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: fixture.timezone,
    }).format(new Date(fixture.conversation.start_time))}`));

    const source = fixture.conversation.transcriptions[0].utterances[0];
    const candidateCard = nodes.get("#candidate-list").children[0];
    assert.equal(candidateCard.children[1].children[0].value, source.text);
    assert.equal(candidateCard.children[2].textContent, `“${source.text}”`);
    assert.ok(candidateCard.children[3].textContent.includes(`Utterance ${source.id}`));
    assert.equal(candidateCard.children[0].children[1].textContent, source.speaker);
    assert.equal(nodes.get("#source-hash").textContent, server.sourceHash);

    const actionInput = candidateCard.children[1].children[0];
    const acceptedCheckbox = candidateCard.children[4].children[0];
    const reviewedAction = "Send the revised agenda after the meeting";
    actionInput.value = reviewedAction;
    actionInput.listeners.input();
    acceptedCheckbox.checked = true;
    acceptedCheckbox.listeners.change();
    context.__testHooks.downloadBrief();

    const markdown = getDownloadedText();
    assert.ok(markdown.includes(`Source response SHA-256: ${server.sourceHash}`));
    const timeZoneLine = markdown.match(/^Time zone.*$/m)?.[0] || "";
    assert.ok(timeZoneLine.includes("Bee\\-reported time zone"), timeZoneLine);
    assert.ok(timeZoneLine.includes(fixture.timezone.replace("/", String.fromCharCode(92) + "/")));
    assert.ok(timeZoneLine.includes("timestamps shown in this zone"));
    assert.ok(markdown.includes(`Bee-reported device type (unverified): ${fixture.conversation.device_type.replace(/-/g, "\\-")}`));
    assert.ok(markdown.includes(`Utterance ${source.id}`));
    assert.ok(markdown.includes("I\\'ll send the revised agenda by Friday\\."));
    assert.ok(markdown.includes(reviewedAction));
    assert.ok(markdown.includes("Capture origin is not attested by the Bee CLI."));
  } finally {
    await server.close();
  }
});

test("the latest selected conversation wins when detail responses resolve out of order", async () => {
  const first = deferred();
  const second = deferred();
  const requests = new Map([[1, first], [2, second]]);
  const fetchImpl = (path, options) => {
    if (path === "/api/health") return Promise.resolve({ ok: true, json: async () => ({ bee_cli_available: false }) });
    const { id } = JSON.parse(options.body);
    return requests.get(id).promise;
  };
  const { context } = loadFrontendForTest(fetchImpl);
  const buttonA = context.document.createElement("button");
  const buttonB = context.document.createElement("button");
  const loadA = context.__testHooks.loadConversation(1, buttonA);
  const loadB = context.__testHooks.loadConversation(2, buttonB);

  assert.equal(buttonA.disabled, false, "starting a newer request releases the old row button");
  assert.equal(buttonB.disabled, true);
  second.resolve(jsonResponse(conversation(2)));
  await loadB;
  assert.equal(buttonB.disabled, false);

  const candidateCard = context.document.querySelector("#candidate-list").children[0];
  const actionInput = candidateCard.children[1].children[0];
  const acceptedCheckbox = candidateCard.children[4].children[0];
  actionInput.value = "Reviewed B action";
  actionInput.listeners.input();
  acceptedCheckbox.checked = true;
  acceptedCheckbox.listeners.change();
  const currentMessage = JSON.parse(context.__testHooks.getReviewState()).message;

  first.resolve(jsonResponse(conversation(1)));
  await loadA;

  const state = JSON.parse(context.__testHooks.getReviewState());
  assert.equal(state.conversationId, 2);
  assert.deepEqual(state.choices, [["candidate-2", { action: "Reviewed B action", accepted: true }]]);
  assert.equal(state.message, currentMessage, "a stale response cannot replace the current status message");
});

test("a stale detail failure cannot replace the current conversation or its review choices", async () => {
  const first = deferred();
  const second = deferred();
  const requests = new Map([[5, first], [6, second]]);
  const fetchImpl = (path, options) => {
    if (path === "/api/health") return Promise.resolve({ ok: true, json: async () => ({ bee_cli_available: false }) });
    const { id } = JSON.parse(options.body);
    return requests.get(id).promise;
  };
  const { context } = loadFrontendForTest(fetchImpl);
  const buttonA = context.document.createElement("button");
  const buttonB = context.document.createElement("button");
  const loadA = context.__testHooks.loadConversation(5, buttonA);
  const loadB = context.__testHooks.loadConversation(6, buttonB);
  second.resolve(jsonResponse(conversation(6)));
  await loadB;

  const candidateCard = context.document.querySelector("#candidate-list").children[0];
  const actionInput = candidateCard.children[1].children[0];
  const acceptedCheckbox = candidateCard.children[4].children[0];
  actionInput.value = "Reviewed current action";
  actionInput.listeners.input();
  acceptedCheckbox.checked = true;
  acceptedCheckbox.listeners.change();
  const currentMessage = JSON.parse(context.__testHooks.getReviewState()).message;

  first.reject(new Error("old request failed"));
  await loadA;

  const state = JSON.parse(context.__testHooks.getReviewState());
  assert.equal(state.conversationId, 6);
  assert.deepEqual(state.choices, [["candidate-6", { action: "Reviewed current action", accepted: true }]]);
  assert.equal(state.message, currentMessage, "a stale error cannot replace the current status message");
  assert.equal(buttonA.disabled, false);
  assert.equal(buttonB.disabled, false);
});

test("Back to list invalidates an in-flight detail response", async () => {
  const pending = deferred();
  const fetchImpl = (path) => {
    if (path === "/api/health") return Promise.resolve({ ok: true, json: async () => ({ bee_cli_available: false }) });
    return pending.promise;
  };
  const { context, nodes } = loadFrontendForTest(fetchImpl);
  const button = context.document.createElement("button");
  const load = context.__testHooks.loadConversation(3, button);

  nodes.get("#back-to-list").listeners.click();
  assert.equal(button.disabled, false, "navigation releases the pending row button");
  pending.resolve(jsonResponse(conversation(3)));
  await load;

  const state = JSON.parse(context.__testHooks.getReviewState());
  assert.equal(state.conversationId, null);
  assert.equal(state.message, "Choose a different Bee conversation.");
  assert.equal(state.libraryHidden, false);
  assert.equal(state.reviewHidden, true);
});

test("refreshing the conversation list invalidates an in-flight detail response", async () => {
  const detail = deferred();
  const list = deferred();
  const fetchImpl = (path) => {
    if (path === "/api/health") return Promise.resolve({ ok: true, json: async () => ({ bee_cli_available: false }) });
    return path === "/api/conversation" ? detail.promise : list.promise;
  };
  const { context } = loadFrontendForTest(fetchImpl);
  const button = context.document.createElement("button");
  const load = context.__testHooks.loadConversation(4, button);
  const refresh = context.__testHooks.loadConversations();
  list.resolve(jsonResponse({ conversations: [] }));
  await refresh;
  detail.resolve(jsonResponse(conversation(4)));
  await load;

  const state = JSON.parse(context.__testHooks.getReviewState());
  assert.equal(state.conversationId, null);
  assert.equal(state.message, "Bee returned no recent conversations.");
  assert.equal(state.libraryHidden, false);
  assert.equal(state.reviewHidden, true);
  assert.equal(button.disabled, false);
});

test("a late list success or failure cannot replace a newer selected conversation", async () => {
  for (const listOutcome of ["success", "failure"]) {
    const list = deferred();
    const detail = deferred();
    const fetchImpl = (path) => {
      if (path === "/api/health") return Promise.resolve({ ok: true, json: async () => ({ bee_cli_available: false }) });
      return path === "/api/conversations" ? list.promise : detail.promise;
    };
    const { context, nodes } = loadFrontendForTest(fetchImpl);
    const refresh = context.__testHooks.loadConversations();
    assert.equal(nodes.get("#load-conversations").disabled, true);
    assert.equal(nodes.get("#refresh-conversations").disabled, true);

    const button = context.document.createElement("button");
    const select = context.__testHooks.loadConversation(7, button);
    assert.equal(nodes.get("#load-conversations").disabled, false, "new navigation releases stale list controls");
    detail.resolve(jsonResponse(conversation(7)));
    await select;

    const candidateCard = context.document.querySelector("#candidate-list").children[0];
    const actionInput = candidateCard.children[1].children[0];
    const acceptedCheckbox = candidateCard.children[4].children[0];
    actionInput.value = "Reviewed while refreshing";
    actionInput.listeners.input();
    acceptedCheckbox.checked = true;
    acceptedCheckbox.listeners.change();
    const currentMessage = JSON.parse(context.__testHooks.getReviewState()).message;

    if (listOutcome === "success") list.resolve(jsonResponse({ conversations: [] }));
    else list.reject(new Error("older list request failed"));
    await refresh;

    const state = JSON.parse(context.__testHooks.getReviewState());
    assert.equal(state.conversationId, 7, `${listOutcome} response must leave the newer record selected`);
    assert.deepEqual(state.choices, [["candidate-7", { action: "Reviewed while refreshing", accepted: true }]]);
    assert.equal(state.message, currentMessage, `${listOutcome} response must not replace the current message`);
    assert.equal(state.libraryHidden, true);
    assert.equal(state.reviewHidden, false);
    assert.equal(nodes.get("#load-conversations").disabled, false);
    assert.equal(nodes.get("#refresh-conversations").disabled, false);
    assert.equal(button.disabled, false);
  }
});

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
