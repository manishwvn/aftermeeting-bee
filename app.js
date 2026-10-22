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
let viewRequestVersion = 0;
let pendingDetailButton = null;
const FALLBACK_TIME_ZONE = "America/Los_Angeles";

function setMessage(message, tone = "plain") {
  messageNode.textContent = message;
  messageNode.dataset.tone = tone;
}

function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
    return true;
  } catch {
    return false;
  }
}

function localTimeZone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(timeZone) ? timeZone : null;
  } catch {
    return null;
  }
}

function resolveTimeZone(reportedTimeZone) {
  if (isValidTimeZone(reportedTimeZone)) return reportedTimeZone;
  return localTimeZone() || FALLBACK_TIME_ZONE;
}

function timeZoneNotice(reportedTimeZone) {
  const displayTimeZone = resolveTimeZone(reportedTimeZone);
  const localZone = localTimeZone();
  const displayZoneSource = localZone
    ? `this computer’s local time zone: ${localZone}`
    : `fallback time zone: ${displayTimeZone}`;
  if (isValidTimeZone(reportedTimeZone)) {
    return `Bee-reported time zone: ${reportedTimeZone} (timestamps shown in this zone)`;
  }
  if (typeof reportedTimeZone === "string" && reportedTimeZone.trim()) {
    return `Bee-reported time zone “${reportedTimeZone}” is unrecognized; timestamps shown in ${displayZoneSource}`;
  }
  return `Bee did not report a time zone; timestamps shown in ${displayZoneSource}`;
}

function deviceTypeNotice(deviceType) {
  if (typeof deviceType === "string" && deviceType.trim()) {
    return `Bee-reported device type (unverified): ${deviceType}`;
  }
  return "Bee-reported device type: not supplied";
}

function formatDate(timestamp, timeZone) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "Time not provided";
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "Time not provided";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: resolveTimeZone(timeZone),
  }).format(date);
}

function formatClock(timestamp, timeZone) {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return "time not supplied";
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return "time not supplied";
  return new Intl.DateTimeFormat(undefined, {
    timeStyle: "short",
    timeZone: resolveTimeZone(timeZone),
  }).format(date);
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

function makeRecordButton(record, timeZone) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "record-row";
  const title = document.createElement("span");
  title.className = "record-title";
  title.textContent = record.summary || `Bee conversation ${record.id}`;
  const meta = document.createElement("span");
  meta.className = "record-date";
  meta.textContent = `Bee conversation ${record.id} · ${formatDate(record.start_time, timeZone)} · ${record.state}`;
  button.append(title, meta);
  button.disabled = !["completed", "processed"].includes(String(record.state).toLowerCase());
  button.setAttribute("aria-label", `${title.textContent}; ${meta.textContent}`);
  button.addEventListener("click", () => loadConversation(record.id, button));
  return button;
}

async function loadConversations() {
  const requestVersion = beginViewRequest();
  loadButton.disabled = true;
  refreshButton.disabled = true;
  setMessage("Reading a short list of Bee conversations…");
  try {
    const data = await postJson("/api/conversations", {});
    if (requestVersion !== viewRequestVersion) return;
    const records = [...data.conversations].sort((left, right) => right.start_time - left.start_time);
    recordList.replaceChildren();
    for (const record of records) recordList.append(makeRecordButton(record, data.timezone));
    librarySection.hidden = false;
    reviewSection.hidden = true;
    const count = records.length;
    setMessage(count
      ? `${count} Bee conversation${count === 1 ? "" : "s"} ready to choose. ${timeZoneNotice(data.timezone)}`
      : "Bee returned no recent conversations.");
    if (count === 0) {
      const empty = document.createElement("p");
      empty.className = "empty-candidates";
      empty.textContent = "When Bee has a completed recording, it will appear here. After a Watch capture, wait for Bee to finish processing before refreshing.";
      recordList.append(empty);
    }
  } catch (error) {
    if (requestVersion !== viewRequestVersion) return;
    setMessage(error.message, "error");
  } finally {
    if (requestVersion === viewRequestVersion) {
      loadButton.disabled = false;
      refreshButton.disabled = false;
    }
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
  evidence.textContent = `${utterance} · ${formatClock(candidate.spoken_at, selectedConversation?.timezone)} · original Bee wording`;

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

function escapeMetadataInline(value) {
  return escapeMarkdownInline(String(value).replace(/\r\n?/g, " ").replace(/\n/g, " "));
}

function renderConversation(conversation) {
  selectedConversation = conversation;
  candidateChoices = new Map(conversation.candidates.map((candidate) => [candidate.key, { action: candidate.action, accepted: false }]));
  const timeZone = resolveTimeZone(conversation.timezone);
  const meta = document.querySelector("#record-meta");
  meta.replaceChildren();
  for (const value of [
    `Bee conversation ${conversation.id}`,
    `Recorded: ${formatDate(conversation.start_time, timeZone)}`,
    `State: ${conversation.state}`,
    timeZoneNotice(conversation.timezone),
    deviceTypeNotice(conversation.device_type),
  ]) {
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
    speaker.textContent = `${utterance.speaker || "Speaker not supplied"} · ${formatClock(utterance.spoken_at, timeZone)}`;
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
  const requestVersion = beginViewRequest();
  pendingDetailButton = button || null;
  if (button) button.disabled = true;
  setMessage(`Reading Bee conversation ${id}…`);
  try {
    const conversation = await postJson("/api/conversation", { id });
    if (requestVersion !== viewRequestVersion) return;
    if (button) button.disabled = false;
    pendingDetailButton = null;
    renderConversation(conversation);
  } catch (error) {
    if (requestVersion !== viewRequestVersion) return;
    if (button) button.disabled = false;
    pendingDetailButton = null;
    setMessage(error.message, "error");
  }
}

function releasePendingDetailButton() {
  if (pendingDetailButton) pendingDetailButton.disabled = false;
  pendingDetailButton = null;
}

function beginViewRequest() {
  viewRequestVersion += 1;
  releasePendingDetailButton();
  loadButton.disabled = false;
  refreshButton.disabled = false;
  return viewRequestVersion;
}

function invalidateViewRequest() {
  viewRequestVersion += 1;
  releasePendingDetailButton();
  loadButton.disabled = false;
  refreshButton.disabled = false;
}

function downloadBrief() {
  if (!selectedConversation) return;
  const timeZone = resolveTimeZone(selectedConversation.timezone);
  const accepted = selectedConversation.candidates
    .map((candidate, index) => ({ candidate, choice: candidateChoices.get(candidate.key), index }))
    .filter(({ choice }) => choice?.accepted);
  const lines = [
    "# AfterMeeting handoff",
    "",
    `Bee conversation: ${selectedConversation.id}`,
    `Recorded: ${formatDate(selectedConversation.start_time, timeZone)}`,
    `Time zone: ${escapeMetadataInline(timeZoneNotice(selectedConversation.timezone))}`,
    `Bee-reported device type (unverified): ${escapeMetadataInline(typeof selectedConversation.device_type === "string" && selectedConversation.device_type.trim() ? selectedConversation.device_type : "not supplied")}`,
    `Bee-reported state: ${escapeMetadataInline(selectedConversation.state || "not supplied")}`,
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
    lines.push(`  - Evidence (${sourceAnchor}; ${speaker}; ${formatClock(candidate.spoken_at, timeZone)}):`);
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
  invalidateViewRequest();
  selectedConversation = null;
  candidateChoices = new Map();
  reviewSection.hidden = true;
  librarySection.hidden = false;
  setMessage("Choose a different Bee conversation.");
  document.querySelector("#library-title").focus({ preventScroll: true });
});
downloadButton.addEventListener("click", downloadBrief);
void checkLocalApp();
