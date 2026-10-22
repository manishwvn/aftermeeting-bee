"""A local, read-only Bee conversation review app."""

from __future__ import annotations

import hashlib
import json
import math
import re
import shutil
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit


APP_DIR = Path(__file__).resolve().parent
MAX_BODY_BYTES = 4_096
MAX_OUTPUT_BYTES = 1_500_000
MAX_CONVERSATIONS = 10
MAX_TRANSCRIPTIONS = 200
MAX_UTTERANCES = 3_000
MAX_UTTERANCE_CHARS = 10_000
CLI_TIMEOUT_SECONDS = 20


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _is_timestamp(value: Any, *, nullable: bool = False) -> bool:
    if nullable and value is None:
        return True
    return type(value) in (int, float) and math.isfinite(value)


def _positive_id(value: Any) -> int:
    if type(value) is not int or value <= 0:
        raise AppError(400, "invalid_conversation_id", "Choose a valid Bee conversation ID.")
    return value


def _decode_object(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        raise AppError(
            502,
            "bee_response_invalid",
            "Bee returned data the app could not read. Keep the response private and check the supported Bee CLI version.",
        ) from None
    if not isinstance(value, dict):
        raise AppError(
            502,
            "bee_response_invalid",
            "Bee returned data the app could not read. Keep the response private and check the supported Bee CLI version.",
        )
    return value


def normalize_conversation_list(payload: dict[str, Any]) -> dict[str, Any]:
    """Validate the official CLI list payload and keep only supported fields."""
    conversations = payload.get("conversations")
    if not isinstance(conversations, list) or len(conversations) > MAX_CONVERSATIONS:
        raise AppError(
            502,
            "bee_response_invalid",
            "Bee returned a conversation list the app could not safely display.",
        )

    normalized: list[dict[str, Any]] = []
    for item in conversations:
        if not isinstance(item, dict):
            raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation list.")
        conversation_id = item.get("id")
        start_time = item.get("start_time")
        end_time = item.get("end_time")
        created_at = item.get("created_at")
        state = item.get("state")
        summary = item.get("summary")
        if (
            type(conversation_id) is not int
            or conversation_id <= 0
            or not _is_timestamp(start_time)
            or not _is_timestamp(end_time, nullable=True)
            or not _is_timestamp(created_at)
            or not isinstance(state, str)
            or not state
            or (summary is not None and not isinstance(summary, str))
            or (isinstance(summary, str) and len(summary) > MAX_UTTERANCE_CHARS)
        ):
            raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation record.")
        normalized.append(
            {
                "id": conversation_id,
                "start_time": start_time,
                "end_time": end_time,
                "created_at": created_at,
                "summary": summary,
                "state": state,
            }
        )

    next_cursor = payload.get("next_cursor")
    timezone = payload.get("timezone")
    if next_cursor is not None and (not isinstance(next_cursor, str) or len(next_cursor) > 512):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation list.")
    if timezone is not None and (not isinstance(timezone, str) or len(timezone) > 128):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation list.")
    return {"conversations": normalized, "next_cursor": next_cursor, "timezone": timezone}


def normalize_conversation_detail(
    payload: dict[str, Any], requested_id: int, raw_response: str
) -> dict[str, Any]:
    """Validate one official `bee conversations get --json` response."""
    conversation = payload.get("conversation")
    if not isinstance(conversation, dict):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation record.")

    conversation_id = conversation.get("id")
    state = conversation.get("state")
    transcriptions = conversation.get("transcriptions")
    start_time = conversation.get("start_time")
    end_time = conversation.get("end_time")
    created_at = conversation.get("created_at")
    updated_at = conversation.get("updated_at")
    if (
        type(conversation_id) is not int
        or conversation_id != requested_id
        or not isinstance(state, str)
        or not _is_timestamp(start_time)
        or not _is_timestamp(end_time, nullable=True)
        or not _is_timestamp(created_at, nullable=True)
        or not _is_timestamp(updated_at, nullable=True)
        or not isinstance(transcriptions, list)
        or len(transcriptions) > MAX_TRANSCRIPTIONS
    ):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation record.")
    if state.casefold() not in {"completed", "processed"}:
        raise AppError(
            409,
            "bee_conversation_not_ready",
            "This Bee conversation is still processing. Wait for Bee to finish, then refresh the list.",
        )

    summary = conversation.get("summary")
    short_summary = conversation.get("short_summary")
    device_type = conversation.get("device_type")
    if (
        (summary is not None and not isinstance(summary, str))
        or (short_summary is not None and not isinstance(short_summary, str))
        or (device_type is not None and not isinstance(device_type, str))
        or (isinstance(summary, str) and len(summary) > MAX_UTTERANCE_CHARS)
        or (isinstance(short_summary, str) and len(short_summary) > MAX_UTTERANCE_CHARS)
        or (isinstance(device_type, str) and len(device_type) > 128)
    ):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation record.")

    utterances: list[dict[str, Any]] = []
    for transcription in transcriptions:
        if not isinstance(transcription, dict) or not isinstance(transcription.get("utterances"), list):
            raise AppError(502, "bee_response_invalid", "Bee returned an unsupported transcript.")
        for item in transcription["utterances"]:
            if len(utterances) >= MAX_UTTERANCES or not isinstance(item, dict):
                raise AppError(502, "bee_response_invalid", "Bee returned a transcript that is too large or malformed.")
            text = item.get("text")
            speaker = item.get("speaker")
            if (
                not isinstance(text, str)
                or not text.strip()
                or len(text) > MAX_UTTERANCE_CHARS
                or (speaker is not None and not isinstance(speaker, str))
                or (isinstance(speaker, str) and len(speaker) > 256)
                or any(
                    not _is_timestamp(item.get(name), nullable=True)
                    for name in ("spoken_at", "start", "end")
                )
            ):
                raise AppError(502, "bee_response_invalid", "Bee returned an unsupported transcript utterance.")
            utterances.append(
                {
                    "id": item.get("id") if type(item.get("id")) is int and item.get("id") > 0 else None,
                    "text": text,
                    "speaker": speaker,
                    "spoken_at": item.get("spoken_at"),
                    "start": item.get("start"),
                    "end": item.get("end"),
                }
            )

    timezone = payload.get("timezone")
    if timezone is not None and (not isinstance(timezone, str) or len(timezone) > 128):
        raise AppError(502, "bee_response_invalid", "Bee returned an unsupported conversation record.")
    return {
        "id": conversation_id,
        "start_time": start_time,
        "end_time": end_time,
        "created_at": created_at,
        "updated_at": updated_at,
        "state": state,
        "device_type": device_type,
        "summary": summary,
        "short_summary": short_summary,
        "timezone": timezone,
        "utterances": utterances,
        "source_response_sha256": hashlib.sha256(raw_response.encode("utf-8")).hexdigest(),
    }


_CANDIDATE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "commitment language",
        re.compile(r"\b(?:i(?:'ll|’ll|\s+will)|we(?:'ll|’ll|\s+will))\b", re.IGNORECASE),
    ),
    (
        "personal next step",
        re.compile(r"\b(?:i need to|we need to|remind me to)\b", re.IGNORECASE),
    ),
    ("proposal language", re.compile(r"\b(?:let(?:'s|’s)|we should|i can|we can)\b", re.IGNORECASE)),
)


def extract_candidates(conversation: dict[str, Any]) -> list[dict[str, Any]]:
    """Surface candidate utterances without adding owners or deadlines."""
    candidates: list[dict[str, Any]] = []
    for index, utterance in enumerate(conversation["utterances"]):
        text = utterance["text"]
        category = next((label for label, pattern in _CANDIDATE_PATTERNS if pattern.search(text)), None)
        if category is not None:
            candidates.append(
                {
                    "key": f"utterance-{index + 1}",
                    "category": category,
                    "action": text,
                    "quote": text,
                    "speaker": utterance["speaker"],
                    "spoken_at": utterance["spoken_at"],
                    "utterance_id": utterance["id"],
                }
            )
    return candidates


def resolve_bee_cli() -> str | None:
    local_cli = APP_DIR / ".local" / "bee-cli" / "node_modules" / ".bin" / "bee"
    if local_cli.is_file():
        return str(local_cli)
    return shutil.which("bee")


class BeeCLI:
    """Read only through the official Bee CLI's fixed JSON commands."""

    def __init__(
        self,
        *,
        executable: str | None = None,
        runner: Callable[..., subprocess.CompletedProcess[str]] | None = None,
    ) -> None:
        # Production resolves the project-local CLI first, then the documented `bee` executable from PATH.
        # Tests inject a runner and fixture executable; HTTP input cannot set either.
        if runner is not None:
            self._executable = executable
        else:
            self._executable = resolve_bee_cli()
        self._runner = runner or subprocess.run

    def _read(self, args: list[str]) -> tuple[dict[str, Any], str]:
        if not self._executable:
            raise AppError(
                503,
                "bee_cli_missing",
                "The official Bee CLI was not found on PATH. Install it and restart AfterMeeting.",
            )
        try:
            result = self._runner(
                [self._executable, *args],
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                timeout=CLI_TIMEOUT_SECONDS,
                cwd=str(APP_DIR),
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise AppError(504, "bee_cli_timeout", "Bee took too long to return this conversation. Try again.") from None
        except OSError:
            raise AppError(503, "bee_cli_unavailable", "AfterMeeting could not start the official Bee CLI.") from None

        raw = result.stdout or ""
        if len(raw.encode("utf-8")) > MAX_OUTPUT_BYTES:
            raise AppError(413, "bee_response_too_large", "This Bee response is too large to review here.")
        if result.returncode != 0:
            detail = (result.stderr or "").casefold()
            if "not logged in" in detail or "unauthorized" in detail or "401" in detail:
                raise AppError(
                    401,
                    "bee_login_required",
                    "Bee did not authorize the request. Complete bee login in Terminal, then try again.",
                )
            raise AppError(502, "bee_cli_failed", "Bee could not return that data. Check Bee access and try again.")
        return _decode_object(raw), raw

    def list_conversations(self) -> dict[str, Any]:
        payload, _raw = self._read(["conversations", "list", "--limit", str(MAX_CONVERSATIONS), "--json"])
        return normalize_conversation_list(payload)

    def get_conversation(self, conversation_id: Any) -> dict[str, Any]:
        selected_id = _positive_id(conversation_id)
        payload, raw = self._read(["conversations", "get", str(selected_id), "--json"])
        conversation = normalize_conversation_detail(payload, selected_id, raw)
        conversation["candidates"] = extract_candidates(conversation)
        return conversation


def _static_response(name: str) -> tuple[str, bytes]:
    static_files = {
        "/": ("text/html; charset=utf-8", "index.html"),
        "/app.js": ("text/javascript; charset=utf-8", "app.js"),
        "/styles.css": ("text/css; charset=utf-8", "styles.css"),
    }
    content_type, filename = static_files[name]
    return content_type, (APP_DIR / filename).read_bytes()


def create_server(bee: Any | None = None, *, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    adapter = bee or BeeCLI()

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, _format: str, *_args: Any) -> None:
            # Request paths and response bodies never enter routine logs.
            return

        @property
        def local_origin(self) -> str:
            return f"http://127.0.0.1:{self.server.server_port}"

        def _host_is_local(self) -> bool:
            return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

        def _send(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                "connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
            )
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            self._send(status, body, "application/json; charset=utf-8")

        def _error(self, error: AppError) -> None:
            self._json(error.status, {"error": {"code": error.code, "message": error.message}})

        def _read_json(self) -> dict[str, Any]:
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise AppError(415, "json_required", "Send a JSON request from this AfterMeeting page.")
            try:
                size = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                raise AppError(400, "invalid_request", "The request could not be read.") from None
            if size < 0 or size > MAX_BODY_BYTES:
                raise AppError(413, "request_too_large", "The request is too large.")
            try:
                payload = json.loads(self.rfile.read(size).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise AppError(400, "invalid_request", "The request could not be read.") from None
            if not isinstance(payload, dict):
                raise AppError(400, "invalid_request", "The request could not be read.")
            return payload

        def do_GET(self) -> None:
            if not self._host_is_local():
                self._json(421, {"error": {"code": "local_host_required", "message": "Open AfterMeeting at its local address."}})
                return
            path = urlsplit(self.path).path
            if path == "/api/health":
                self._json(200, {"app": "ready", "bee_cli_available": bool(resolve_bee_cli())})
                return
            try:
                content_type, body = _static_response(path)
            except (KeyError, OSError):
                self._json(404, {"error": {"code": "not_found", "message": "That page was not found."}})
                return
            self._send(200, body, content_type)

        def do_POST(self) -> None:
            if not self._host_is_local():
                self._json(421, {"error": {"code": "local_host_required", "message": "Open AfterMeeting at its local address."}})
                return
            if self.headers.get("Origin") != self.local_origin or self.headers.get("Sec-Fetch-Site", "same-origin") not in {"same-origin", "none"}:
                self._json(403, {"error": {"code": "same_origin_required", "message": "Use the local AfterMeeting page to request Bee data."}})
                return
            try:
                payload = self._read_json()
                path = urlsplit(self.path).path
                if path == "/api/conversations":
                    data = adapter.list_conversations()
                elif path == "/api/conversation":
                    data = adapter.get_conversation(_positive_id(payload.get("id")))
                else:
                    raise AppError(404, "not_found", "That AfterMeeting action was not found.")
            except AppError as error:
                self._error(error)
                return
            except Exception:
                self._error(AppError(500, "internal_error", "AfterMeeting could not complete that request."))
                return
            self._json(200, {"data": data})

        def do_HEAD(self) -> None:
            if not self._host_is_local():
                self._json(421, {"error": {"code": "local_host_required", "message": "Open AfterMeeting at its local address."}})
                return
            try:
                content_type, body = _static_response(urlsplit(self.path).path)
            except (KeyError, OSError):
                self._send(404, b"", "text/plain; charset=utf-8")
                return
            self._send(200, body, content_type)

        def _method_not_allowed(self) -> None:
            if not self._host_is_local():
                self._json(421, {"error": {"code": "local_host_required", "message": "Open AfterMeeting at its local address."}})
                return
            self._json(405, {"error": {"code": "method_not_allowed", "message": "That AfterMeeting action is not available."}})

        do_PUT = _method_not_allowed
        do_PATCH = _method_not_allowed
        do_DELETE = _method_not_allowed
        do_OPTIONS = _method_not_allowed

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


if __name__ == "__main__":
    server = create_server()
    print(f"AfterMeeting is ready at http://127.0.0.1:{server.server_port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
