"use strict";

const statusNode = document.querySelector("#connection-status");
const messageNode = document.querySelector("#screen-message");
const loadButton = document.querySelector("#load-conversations");
const refreshButton = document.querySelector("#refresh-conversations");
const librarySection = document.querySelector("#library-section");
const reviewSection = document.querySelector("#review-section");
const recordList = document.querySelector("#record-list");
const candidateList = document.querySelector("#candidate-list");
const transcriptList = document.querySelector("#transcript-list");
const downloadButton = document.querySelector("#download-brief");
let selectedConversation = null;
let candidateChoices = new Map();

function setMessage(message, tone = "plain") {
  messageNode.textContent = message;
  messageNode.dataset.tone = tone;
}

function formatDate(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "Time not provided";
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "Time not provided";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatClock(timestamp) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "time not supplied";
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "time not supplied";
  return new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify(body),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("AfterMeeting received an unreadable response. Refresh the page and try again.");
  }
  if (!response.ok) {
    const error = result?.error;
    throw new Error(typeof error?.message === "string" ? error.message : "AfterMeeting could not complete that request.");
  }
  return result.data;
}

async function checkLocalApp() {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error("local app unavailable");
    const data = await response.json();
    statusNode.textContent = data.bee_cli_available ? "Bee CLI found on this computer" : "Bee CLI not found yet";
    statusNode.dataset.state = data.bee_cli_available ? "ready" : "waiting";
    if (!data.bee_cli_available) {
      document.querySelector("#setup-note").textContent = "Install the official Bee CLI and restart AfterMeeting. Sign in from Terminal only when you choose.";
    }
  } catch {
    statusNode.textContent = "Local app connection lost";
    statusNode.dataset.state = "waiting";
  }
}

function makeRecordButton(record) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record-row";
  const title = document.createElement("span");
  title.className = "record-title";
  title.textContent = record.summary || `Bee conversation ${record.id}`;
  const meta = document.createElement("span");
  meta.className = "record-date";
  meta.textContent = `Bee conversation ${record.id} · ${formatDate(record.start_time)} · ${record.state}`;
  button.append(title, meta);
  button.disabled = !["completed", "processed"].includes(String(record.state).toLowerCase());
  button.setAttribute("aria-label", `${title.textContent}; ${meta.textContent}`);
  button.addEventListener("click", () => loadConversation(record.id, button));
  return button;
}

async function loadConversations() {
  loadButton.disabled = true;
  refreshButton.disabled = true;
  setMessage("Reading a short list of Bee conversations…");
  try {
    const data = await postJson("/api/conversations", {});
    const records = [...data.conversations].sort((left, right) => right.start_time - left.start_time);
    recordList.replaceChildren();
    for (const record of records) recordList.append(makeRecordButton(record));
    librarySection.hidden = false;
    reviewSection.hidden = true;
    const count = records.length;
    setMessage(count ? `${count} Bee conversation${count === 1 ? "" : "s"} ready to choose.` : "Bee returned no recent conversations.");
    if (count === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-candidates";
      empty.textContent = "When Bee has a completed recording, it will appear here. After a Watch capture, wait for Bee to finish processing before refreshing.";
      recordList.append(empty);
    }
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    loadButton.disabled = false;
    refreshButton.disabled = false;
  }
}

function createCandidateCard(candidate, index) {
  const article = document.createElement("article");
  article.className = "candidate-row";
  const top = document.createElement("div");
  top.className = "candidate-topline";
  const tag = document.createElement("span");
  tag.className = "candidate-kind";
  tag.textContent = candidate.category;
  const source = document.createElement("span");
  source.className = "candidate-source";
  source.textContent = candidate.speaker || "Speaker not supplied";
  top.append(tag, source);

  const label = document.createElement("label");
  label.className = "action-label";
  label.textContent = "Next step, in your words";
  const input = document.createElement("textarea");
  input.rows = 2;
  input.maxLength = 500;
  input.value = candidate.action;
  input.dataset.candidateKey = candidate.key;
  label.append(input);

  const quote = document.createElement("blockquote");
  quote.className = "source-quote";
  quote.textContent = `“${candidate.quote}”`;

  const evidence = document.createElement("p");
  evidence.className = "evidence-meta";
  const utterance = candidateEvidenceLabel(candidate, index);
  evidence.textContent = `${utterance} · ${formatClock(candidate.spoken_at)} · original Bee wording`;

  const keepLabel = document.createElement("label");
  keepLabel.className = "keep-choice";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.candidateKey = candidate.key;
  const keepText = document.createElement("span");
  keepText.textContent = "I want to carry this into my handoff";
  keepLabel.append(checkbox, keepText);

  input.addEventListener("input", () => updateCandidateChoice(candidate.key, { action: input.value }));
  checkbox.addEventListener("change", () => updateCandidateChoice(candidate.key, { accepted: checkbox.checked }));
  article.append(top, label, quote, evidence, keepLabel);
  return article;
}

function updateCandidateChoice(key, patch) {
  candidateChoices.set(key, { ...candidateChoices.get(key), ...patch });
}

function candidateEvidenceLabel(candidate, fallbackIndex) {
  if (candidate.utterance_id) return `Utterance ${candidate.utterance_id}`;
  const transcriptLine = Number.isInteger(candidate.transcript_line) ? candidate.transcript_line : fallbackIndex + 1;
  return `Transcript line ${transcriptLine}`;
}

const MARKDOWN_PUNCTUATION = new Set("!\"#$%'()*+,-./:;=?@[\\]^_`{|}~");

function escapeMarkdownInline(value) {
  let escaped = "";
  for (const character of String(value)) {
    if (character === "&") escaped += "&amp;";
    else if (character === "<") escaped += "&lt;";
    else if (character === ">") escaped += "&gt;";
    else if (MARKDOWN_PUNCTUATION.has(character)) escaped += `\\${character}`;
    else escaped += character;
  }
  return escaped;
}

function escapedMarkdownLines(value) {
  return String(value).replace(/\r\n?/g, "\n").split("\n").map(escapeMarkdownInline);
}

function renderConversation(conversation) {
  selectedConversation = conversation;
  candidateChoices = new Map(conversation.candidates.map((candidate) => [candidate.key, { action: candidate.action, accepted: false }]));
  const meta = document.querySelector("#record-meta");
  meta.replaceChildren();
  for (const value of [`Bee conversation ${conversation.id}`, formatDate(conversation.start_time), conversation.state]) {
    const item = document.createElement("span");
    item.textContent = value;
    meta.append(item);
  }
  document.querySelector("#summary-text").textContent = conversation.short_summary || conversation.summary || "Bee did not provide a summary for this recording.";
  document.querySelector("#source-hash").textContent = conversation.source_response_sha256;
  candidateList.replaceChildren();
  transcriptList.replaceChildren();
  conversation.candidates.forEach((candidate, index) => candidateList.append(createCandidateCard(candidate, index)));
  conversation.utterances.forEach((utterance, index) => {
    const item = document.createElement("li");
    const speaker = document.createElement("span");
    speaker.className = "transcript-speaker";
    speaker.textContent = `${utterance.speaker || "Speaker not supplied"} · ${formatClock(utterance.spoken_at)}`;
    const words = document.createElement("p");
    words.textContent = utterance.text;
    item.append(speaker, words);
    transcriptList.append(item);
  });
  document.querySelector("#candidate-count").textContent = `${conversation.candidates.length} found`;
  document.querySelector("#empty-candidates").hidden = conversation.candidates.length !== 0;
  librarySection.hidden = true;
  reviewSection.hidden = false;
  setMessage(`${conversation.candidates.length} possible next step${conversation.candidates.length === 1 ? "" : "s"} found. Review each one against its source quote.`);
  document.querySelector("#review-title").focus({ preventScroll: true });
  reviewSection.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}

async function loadConversation(id, button) {
  if (button) button.disabled = true;
  setMessage(`Reading Bee conversation ${id}…`);
  try {
    const conversation = await postJson("/api/conversation", { id });
    renderConversation(conversation);
  } catch (error) {
    setMessage(error.message, "error");
    if (button) button.disabled = false;
  }
}

function downloadBrief() {
  if (!selectedConversation) return;
  const accepted = selectedConversation.candidates
    .map((candidate, index) => ({ candidate, choice: candidateChoices.get(candidate.key), index }))
    .filter(({ choice }) => choice?.accepted);
  const lines = [
    "# AfterMeeting handoff",
    "",
    `Bee conversation: ${selectedConversation.id}`,
    `Recorded: ${formatDate(selectedConversation.start_time)}`,
    `Source response SHA-256: ${selectedConversation.source_response_sha256}`,
    "",
    "> Transcript wording is Bee's automatic speech recognition output. Check it against the recording before sharing.",
    "",
    "## Next steps I chose to carry forward",
    "",
  ];
  if (accepted.length === 0) lines.push("No suggested next steps were selected.", "");
  for (const { candidate, choice, index } of accepted) {
    const action = String(choice.action || "").trim();
    if (action) {
      const actionLines = escapedMarkdownLines(action);
      lines.push(`- ${actionLines[0]}`);
      for (const line of actionLines.slice(1)) lines.push(`  ${line}`);
    }
    const speaker = escapeMarkdownInline(String(candidate.speaker || "speaker not supplied").replace(/\r\n?/g, " ").replace(/\n/g, " "));
    const sourceAnchor = escapeMarkdownInline(candidateEvidenceLabel(candidate, index));
    lines.push(`  - Evidence (${sourceAnchor}; ${speaker}; ${formatClock(candidate.spoken_at)}):`);
    for (const line of escapedMarkdownLines(candidate.quote)) lines.push(`    > ${line}`);
  }
  lines.push("", "Capture origin is not attested by the Bee CLI. Confirm the source in the Bee app before using this as Watch-originated demo evidence.", "");
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `aftermeeting-conversation-${selectedConversation.id}.md`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  setMessage("Your reviewed handoff was downloaded. AfterMeeting kept no copy.");
}

loadButton.addEventListener("click", loadConversations);
refreshButton.addEventListener("click", loadConversations);
document.querySelector("#back-to-list").addEventListener("click", () => {
  selectedConversation = null;
  reviewSection.hidden = true;
  librarySection.hidden = false;
  setMessage("Choose a different Bee conversation.");
  document.querySelector("#library-title").focus({ preventScroll: true });
});
downloadButton.addEventListener("click", downloadBrief);
void checkLocalApp();
